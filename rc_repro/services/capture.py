"""Drive a scripted reproduction through a browser and record what it did.

Evidence answers "what was deployed"; capture answers "what happened when you did
the thing". A support escalation is almost always shaped like *do X, then Y goes
wrong*, and a JSON record of the deployment proves Y exists at best. The artifacts
here (a screenshot per checkpoint, a video, a Playwright trace) are what a reader
who was not in the session can actually look at.

Three properties are load-bearing, and none of them is incidental:

* **Failure is loud.** rc-repro exists to run *version-matched* repros, and
  Rocket.Chat's selectors move between versions. A workload authored against 8.5.1
  and pointed at 7.10.11 will find nothing, and a blank screenshot is worse than no
  screenshot because it still looks like evidence. A step that cannot run aborts
  the capture, names itself in the manifest, and exits non-zero.
* **The manifest records the workload as authored, never as resolved.** A step
  filling `{{admin_pass}}` is recorded with the placeholder intact. Evidence's
  contract is that no password appears anywhere in an attachable bundle, and
  keeping substitution out of the record makes that structural rather than a
  filter someone has to remember to run.
* **The browser is injected.** The workload runner holds the ordering, redaction,
  and failure logic worth testing; a real browser in that path would only make it
  slow and flaky. `browser_driver()` builds the Playwright one, tests pass a fake.

Playwright is an optional extra (`pip install 'rc-repro[capture]'`) because most
people using this tool want a Rocket.Chat container, not a browser download.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path

import yaml

from rc_repro import config
from rc_repro.errors import (CaptureFailedError, ConflictError, ReproError,
                             ValidationError)

#: Actions a workload step may take. Deliberately small: every one of these maps to
#: a single Playwright call, so the DSL cannot drift into being a worse programming
#: language. `selector` is a raw Playwright selector on purpose — it is the escape
#: hatch that keeps an unusual reproduction from being blocked on this file growing
#: a new verb.
ACTIONS = ("goto", "click", "fill", "press", "wait_for", "shot")

#: Keys a step may carry alongside its action.
_MODIFIERS = ("value", "timeout_ms")

#: Selectors whose typed value must never reach the manifest. A workload author who
#: inlines a credential instead of using a `{{placeholder}}` should not be able to
#: put it in a bundle that goes to a support case.
_PASSWORDISH = re.compile(r"pass|pwd|secret|token|otp", re.I)

_DEFAULT_TIMEOUT_MS = 15000

#: Viewport pinned so two runs of the same workload produce comparable frames, and
#: so a screenshot filed against a ticket is not sized by whoever ran it.
VIEWPORT = {"width": 1280, "height": 800}


@dataclass(frozen=True)
class Step:
    action: str
    target: str
    value: str = ""
    timeout_ms: int = 0


@dataclass(frozen=True)
class Workload:
    name: str
    description: str = ""
    steps: tuple[Step, ...] = field(default_factory=tuple)


def _parse(text: str, source: str) -> Workload:
    try:
        raw = yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:
        raise ValidationError(f"workload {source} is not valid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValidationError(f"workload {source} must be a mapping")

    steps = []
    for i, item in enumerate(raw.get("steps") or []):
        if not isinstance(item, dict):
            raise ValidationError(f"workload {source} step {i} must be a mapping")
        actions = [k for k in item if k in ACTIONS]
        unknown = [k for k in item if k not in ACTIONS and k not in _MODIFIERS]
        if unknown:
            # Named rather than ignored: a typo'd action would otherwise skip the
            # one interaction the reproduction depends on while still producing
            # screenshots, which reads as proof.
            raise ValidationError(
                f"workload {source} step {i}: unknown key {unknown[0]!r} "
                f"(actions: {', '.join(ACTIONS)})")
        if len(actions) != 1:
            raise ValidationError(
                f"workload {source} step {i} must name exactly one action "
                f"({', '.join(ACTIONS)})")

        action = actions[0]
        target = str(item[action] or "").strip()
        if not target:
            raise ValidationError(f"workload {source} step {i}: {action} needs a target")
        value = item.get("value")
        if action == "fill" and value is None:
            raise ValidationError(f"workload {source} step {i}: fill needs a value")
        steps.append(Step(action=action, target=target, value=str(value or ""),
                          timeout_ms=int(item.get("timeout_ms") or 0)))

    return Workload(name=str(raw.get("name") or "").strip() or "unnamed",
                    description=str(raw.get("description") or "").strip(),
                    steps=tuple(steps))


def load_workload(name: str) -> Workload:
    """Return a workload by name.

    A user file (`~/.rc-repro/workloads/<name>.yaml`) wins over the built-in, the
    same precedence presets use: when a shipped workload drifts against a new
    Rocket.Chat release, it can be fixed locally without waiting for a release.
    """
    user = config.workload_dir() / f"{name}.yaml"
    if user.exists():
        return _parse(user.read_text(encoding="utf-8"), source=str(user))

    builtin = resources.files("rc_repro").joinpath("data", "workloads", f"{name}.yaml")
    if not builtin.is_file():
        raise ValidationError(
            f"unknown workload {name!r} (run `rc-repro workloads` to list)")
    return _parse(builtin.read_text(encoding="utf-8"), source="built-in")


def list_workloads() -> list[dict]:
    """Every workload available here, built-in and user, user winning on name."""
    found: dict[str, dict] = {}
    builtin_dir = resources.files("rc_repro").joinpath("data", "workloads")
    if builtin_dir.is_dir():
        for entry in builtin_dir.iterdir():
            if entry.name.endswith(".yaml"):
                stem = entry.name[: -len(".yaml")]
                found[stem] = {"name": stem, "source": "built-in",
                               "description": _parse(entry.read_text(encoding="utf-8"),
                                                     "built-in").description}
    d = config.workload_dir()
    if d.is_dir():
        for entry in sorted(d.glob("*.yaml")):
            found[entry.stem] = {"name": entry.stem, "source": str(entry),
                                 "description": _parse(entry.read_text(encoding="utf-8"),
                                                       str(entry)).description}
    return [found[k] for k in sorted(found)]


def _resolve(text: str, context: dict) -> str:
    """Substitute `{{key}}` placeholders. Used for the browser, never for the record."""
    out = text
    for key, val in context.items():
        out = out.replace("{{%s}}" % key, str(val))
    return out


#: A value made only of `{{placeholders}}` carries no secret by construction, so it
#: is recorded as authored even into a password field: "it typed {{admin_pass}}"
#: tells a reader what happened, where "REDACTED" only tells them something did.
_PLACEHOLDER = re.compile(r"\{\{[^}]*\}\}")


def _recorded_value(step: Step) -> str:
    if not _PLACEHOLDER.sub("", step.value).strip():
        return step.value
    return "REDACTED" if _PASSWORDISH.search(step.target) else step.value


def _apply(step: Step, driver, root: str, context: dict, dest: Path, shots: list) -> None:
    # `timeout_ms` is honoured by every action that waits on the page, not just
    # wait_for: a click during a slow Rocket.Chat boot needs the same allowance, and
    # a modifier that parses but is ignored fails as "your selectors moved" when the
    # real cause was the clock.
    timeout = step.timeout_ms or _DEFAULT_TIMEOUT_MS
    if step.action == "goto":
        driver.goto(root + _resolve(step.target, context))
    elif step.action == "click":
        driver.click(step.target, timeout)
    elif step.action == "fill":
        driver.fill(step.target, _resolve(step.value, context), timeout)
    elif step.action == "press":
        driver.press(step.target)
    elif step.action == "wait_for":
        driver.wait_for(step.target, timeout)
    elif step.action == "shot":
        name = f"{len(shots) + 1:02d}-{step.target}.png"
        driver.screenshot(dest / name)
        shots.append(name)


def run(workload: Workload, driver, dest: str | Path, context: dict | None = None) -> dict:
    """Execute a workload, write its artifacts and manifest into `dest`.

    Raises `CaptureFailedError` if any step could not run. The manifest is written
    either way, because a failed capture's partial artifacts are exactly what tells
    you *where* a workload drifted; what must not happen is a run that failed
    halfway reporting success.
    """
    dest = Path(dest).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    context = dict(context or {})
    root = str(context.get("root_url") or "").rstrip("/")

    steps_out: list[dict] = []
    shots: list[str] = []
    failed: dict | None = None
    secrets = secret_values(context)
    try:
        for i, step in enumerate(workload.steps):
            rec = {"index": i, "action": step.action, "target": step.target, "status": "ok"}
            if step.action == "fill":
                value = _recorded_value(step)
                # Belt as well as braces: a value that embeds a resolved secret is
                # redacted whatever the selector is named, so a field this module
                # does not recognise as credential-bearing cannot leak one.
                rec["value"] = "REDACTED" if any(s in value for s in secrets) else value
            try:
                _apply(step, driver, root, context, dest, shots)
            except Exception as exc:  # noqa: BLE001 - any driver failure ends the run
                rec["status"] = "failed"
                rec["error"] = str(exc)
                failed = rec
                break
            finally:
                steps_out.append(rec)
    finally:
        # Always close: Playwright only finalises the video on context close, so a
        # crash that skipped this would throw away the recording of the failure.
        artifacts = _finish(driver)

    manifest = {
        "workload": workload.name,
        "description": workload.description,
        "status": "failed" if failed else "ok",
        "steps": steps_out,
        "shots": shots,
        "video": artifacts.get("video"),
        "trace": artifacts.get("trace"),
        "failed_step": failed,
        "viewport": dict(VIEWPORT),
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True),
                                        encoding="utf-8")
    if failed:
        raise CaptureFailedError(
            f"capture stopped at step {failed['index']} ({failed['action']} "
            f"{failed['target']!r}): {failed.get('error', '')}. "
            f"If the workload was written for another Rocket.Chat version, its "
            f"selectors may have moved.",
            details={"manifest": str(dest / "manifest.json")})
    return manifest


#: Files whose presence means a directory already holds a bundle. Only these
#: block a write: an empty or incidentally-populated directory is not evidence,
#: so refusing there would be friction that protects nothing.
_BUNDLE_MARKERS = ("README.md", "manifest.json")


def _refuse_to_replace(dest: Path, force: bool) -> None:
    """Stop before overwriting a bundle that already exists.

    A bundle is evidence, and the drill has a human hand-write the observed
    behaviour into its README. A rerun cannot restore that, so replacing it has to
    be something the operator asks for rather than something a repeated command
    does quietly. Checked before the browser starts, so a refusal costs nothing and
    leaves no partial artifacts behind.
    """
    if force:
        return
    found = [m for m in _BUNDLE_MARKERS if (dest / m).exists()]
    if not found:
        return
    raise ConflictError(
        f"{dest} already holds a bundle ({', '.join(found)}). Writing here would "
        f"replace it, including anything written into its README by hand. Pass a "
        f"different --bundle, or --force to replace it.")


def capture_bundle(name: str, workload: str, dest: str | Path = "",
                   driver_factory=None, force: bool = False) -> dict:
    """Run a workload against a repro and write the complete attachable bundle.

    Here rather than in the CLI because both front-ends need the same sequence, and
    because the ordering is load-bearing in a way worth testing: the evidence bundle
    is written *before* a capture failure propagates, so a run that drifted still
    produces the README whose banner explains where it stopped. Losing the bundle on
    failure would throw away the artifacts that show what went wrong.
    """
    from rc_repro.services import evidence, lifecycle

    wl = load_workload(workload)
    info = lifecycle.describe(name)
    repro_name = info["name"]
    out = Path(dest).expanduser() if dest else \
        config.reports_dir() / f"{repro_name}-{workload}"
    _refuse_to_replace(out, force)
    context = {"root_url": info["root_url"],
               "admin_user": info["login"]["user"],
               "admin_pass": info["login"]["password"]}

    factory = driver_factory or browser_driver
    driver = factory(info["root_url"], out / "capture", secret_values(context))
    failure: CaptureFailedError | None = None
    try:
        run(wl, driver, out / "capture", context=context)
    except CaptureFailedError as exc:
        failure = exc

    payload = evidence.record(repro_name)
    payload["bundle"] = evidence.write_bundle(repro_name, out, payload)
    if failure is not None:
        failure.details["bundle"] = payload["bundle"]["path"]
        raise failure
    return payload


def render_section(manifest: dict) -> list[str]:
    """The capture's part of the bundle README, as Markdown lines.

    Lives here rather than in `evidence` because every field it reads belongs to
    the capture manifest; evidence would be reaching across a seam to format
    someone else's data.
    """
    lines: list[str] = []
    if manifest.get("status") == "failed":
        failed = manifest.get("failed_step") or {}
        lines += [f"> **This capture did not complete.** It stopped at step "
                  f"{failed.get('index')} (`{failed.get('action')} "
                  f"{failed.get('target')}`). Treat the artifacts below as partial, "
                  f"not as proof of the behaviour. A workload written for another "
                  f"Rocket.Chat version is the usual cause.", ""]

    lines += ["| # | Action | Target | Value | |", "|---|---|---|---|---|"]
    for step in manifest.get("steps", []):
        mark = "ok" if step.get("status") == "ok" else "**failed**"
        lines.append(f"| {step.get('index')} | `{step.get('action')}` | "
                     f"`{step.get('target')}` | {step.get('value', '')} | {mark} |")
    lines.append("")

    shots = manifest.get("shots") or []
    if shots:
        lines += ["## Screenshots", ""]
        for shot in shots:
            stem = shot.rsplit(".", 1)[0]
            lines += [f"![{stem}](capture/{shot})", f"*{stem.split('-', 1)[-1]}*", ""]

    media = []
    if manifest.get("video"):
        media.append(f"- Video: `capture/{manifest['video']}`")
    if manifest.get("trace"):
        media.append(f"- Trace: `capture/{manifest['trace']}` (open with "
                     f"`npx playwright show-trace capture/{manifest['trace']}`)")
    if not media:
        # Stated rather than omitted: a silently missing recording reads as a
        # workload that did not ask for one.
        media.append("- No video or trace was produced for this run.")
    lines += ["## Recording", ""] + media + [""]
    return lines


def _finish(driver) -> dict:
    try:
        return driver.finish() or {}
    except Exception:  # noqa: BLE001 - a close failure must not mask the step failure
        return {}


def _import_playwright():
    """Isolated so tests can simulate the extra being absent."""
    from playwright.sync_api import sync_playwright
    return sync_playwright


def secret_values(context: dict) -> tuple[str, ...]:
    """Resolved context values that must not survive into an artifact.

    Keyed off the placeholder name rather than the value's shape: `{{admin_pass}}`
    is a secret because of what it is, not because it looks like one.
    """
    return tuple(str(v) for k, v in (context or {}).items()
                 if v and _PASSWORDISH.search(k))


def redact_trace(path: Path, secrets: tuple[str, ...]) -> bool:
    """Rewrite a Playwright trace with `secrets` removed. True if anything changed.

    Playwright records every action's arguments verbatim, so a `fill` of the admin
    password puts it in `trace.trace` in clear text. The manifest avoids this
    structurally by never resolving placeholders, but the trace is Playwright's
    file, not ours. Without this pass the trace is the one artifact in the bundle
    that cannot be attached to a case, which would make it worthless.
    """
    import zipfile

    if not secrets or not path.exists():
        return False
    # Deliberately not caught: a trace that cannot be read cannot be certified
    # scrubbed, and shipping it anyway would break the promise the README makes
    # about the bundle. The caller drops the artifact instead.
    with zipfile.ZipFile(path) as zf:
        entries = [(i, zf.read(i.filename)) for i in zf.infolist()]

    changed = False
    out: list[tuple] = []
    for info, blob in entries:
        new = blob
        for secret in secrets:
            needle = secret.encode("utf-8")
            if needle and needle in new:
                new = new.replace(needle, b"REDACTED")
                changed = True
        out.append((info, new))
    if not changed:
        return False

    tmp = path.with_suffix(".redacting")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for info, blob in out:
            zf.writestr(info.filename, blob)
    tmp.replace(path)
    return True


def browser_driver(root_url: str, dest: str | Path, secrets: tuple[str, ...] = ()):
    """A Playwright-backed driver recording video and a trace into `dest`."""
    try:
        sync_playwright = _import_playwright()
    except ImportError as exc:
        raise ReproError(
            "browser capture needs the optional extra: "
            "pip install 'rc-repro[capture]' && playwright install chromium") from exc
    return _PlaywrightDriver(sync_playwright, root_url, Path(dest), secrets)


class _PlaywrightDriver:
    """The real browser. Thin on purpose: every method is one Playwright call.

    Kept free of workload logic so the part with branching stays testable without a
    browser. `reduced_motion` and a pinned viewport are set so repeated runs of the
    same workload produce comparable frames rather than diffs made of animation.
    """

    def __init__(self, sync_playwright, root_url: str, dest: Path,
                 secrets: tuple[str, ...] = ()):
        dest.mkdir(parents=True, exist_ok=True)
        self.dest = dest
        self.secrets = tuple(s for s in secrets if s)
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch()
        self._context = self._browser.new_context(
            viewport=dict(VIEWPORT), record_video_dir=str(dest / "_video"),
            record_video_size=dict(VIEWPORT), reduced_motion="reduce",
            base_url=root_url or None)
        self._context.tracing.start(screenshots=True, snapshots=True)
        self._page = self._context.new_page()

    def goto(self, url):
        self._page.goto(url, wait_until="domcontentloaded")

    def click(self, selector, timeout_ms):
        self._page.click(selector, timeout=timeout_ms)

    def fill(self, selector, value, timeout_ms):
        self._page.fill(selector, value, timeout=timeout_ms)

    def press(self, key):
        self._page.keyboard.press(key)

    def wait_for(self, selector, timeout_ms):
        self._page.wait_for_selector(selector, timeout=timeout_ms)

    def screenshot(self, path):
        self._page.screenshot(path=str(path), full_page=True)

    def finish(self) -> dict:
        out: dict = {"video": None, "trace": None}
        trace = self.dest / "trace.zip"
        try:
            self._context.tracing.stop(path=str(trace))
            redact_trace(trace, self.secrets)
            out["trace"] = "trace.zip"
        except Exception:  # noqa: BLE001 - a missing trace must not lose the video
            # An unscrubbed trace is worse than no trace: the bundle is meant to be
            # attachable, and a half-redacted one would still be offered as such.
            trace.unlink(missing_ok=True)
        video = getattr(self._page, "video", None)
        try:
            self._page.close()
            self._context.close()          # finalises the video file
            if video is not None:
                src = Path(video.path())
                if src.exists():
                    src.replace(self.dest / "video.webm")
                    out["video"] = "video.webm"
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                self._browser.close()
                self._pw.stop()
            except Exception:  # noqa: BLE001
                pass
            # Playwright's staging directory is empty once the video is moved out;
            # leaving it behind makes the bundle look like it has a stray folder.
            staging = self.dest / "_video"
            if staging.is_dir() and not any(staging.iterdir()):
                staging.rmdir()
        return out
