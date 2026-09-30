#!/usr/bin/env python
"""Capture every `--help` text as a fixture, deterministically.

    .venv/bin/python tools/capture_help.py            # rewrite the fixtures
    .venv/bin/python tools/capture_help.py --check    # diff without writing

`--help` output is **registration-ordered**: the sequence of commands in the root help
and of options within a command are the order they were registered, not alphabetical.
Phase 2a moves 40 command paths out of one 4,806-line `cli.py` into thirteen modules, and
the import order of those modules becomes the command order. Nothing in the suite reads
help text, so that reordering is silent -- a published surface changing with no test
saying so. Hence a fixture per command, plus one for the root, captured before the move.

Three things had to be pinned or the fixture is noise rather than signal:

* **Width.** Click wraps to the terminal width, so the same build produces different
  text in a 200-column terminal and in CI's 80. ``COLUMNS`` is forced to 100.
* **Colour.** CI enables colour and a local run usually does not, so the same text
  differs by escape sequences alone. ``NO_COLOR`` and ``TERM=dumb`` are set AND any
  escape that survives is stripped, because the two mechanisms have disagreed before.
* **Box rules.** Typer draws option tables inside `╭──╮` panels whose rules are padded
  to the full width. Even with the width pinned, that ties the fixture to a rich
  version rather than to houston. Rules are collapsed to a fixed length, keeping panel
  titles, and the `│` borders are stripped.
* **The LENGTH of `HOUSTON_HOME`.** `loadtest` and `capacity` interpolate
  `$HOUSTON_HOME/reports` into their `--report` help, so Click wraps that line according
  to how long the path happens to be. Collapsing the path afterwards cannot help: the
  wrap has already happened. The capture therefore allocates a unique temporary path
  padded to a fixed total length, then collapses it to `$HOUSTON_HOME`. This keeps
  wrapping deterministic without deleting or sharing a predictable `/tmp` directory.
  Found by capturing the fixtures and immediately failing to reproduce three of them.

The command list comes from `houston capabilities`, not from importing the app, because
the module the app lives in is exactly what Phase 2a moves. A subprocess asks the
installed console script the same question a caller would.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import json
import atexit
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = REPO_ROOT / "tests" / "fixtures"
HELP_DIR = FIXTURES / "help"
ROOT_HELP = FIXTURES / "help-root.txt"
# Both at the REPOSITORY root, one level above legacy/, where the TypeScript tree is.
DISPATCHER = REPO_ROOT.parent / "bin" / "houston"
ROUTING = REPO_ROOT.parent / "routing.conf"

# Preserve the 30-character path length used when the fixtures were frozen. Longer
# values are truncated by Rich before path normalisation can see the full string.
FIXTURE_HOME_LENGTH = 30

# Any escape sequence, not just SGR colour: a cursor move or a mode set would survive a
# colour-only pattern and pin the fixture to whatever emitted it.
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
RULE = re.compile(r"[─━]{2,}")
CORNERS = "╭╰┌└╔╚"
BORDERS = "│┃|"


def houston_bin() -> pathlib.Path:
    """The console script beside the interpreter running this file.

    Derived from `sys.executable` so that `.venv/bin/python tools/capture_help.py` uses
    `.venv/bin/houston` -- the repo's rule is never a bare `python`, and a fixture
    captured from a different interpreter's install is a fixture of a different build.

    `HOUSTON_CAPTURE_PYTHON` points it at ANOTHER interpreter, which is how
    `tools/wheel_smoke.py` holds the INSTALLED artifact to the same fixtures as the
    checkout. Without it the smoke test would render help from the source tree and
    report that the wheel's help is fine, which is the shape of mistake this whole file
    exists to stop.
    """
    interpreter = os.environ.get("HOUSTON_CAPTURE_PYTHON") or sys.executable
    # `houston-py`, the oracle's only console script since Phase 9.3 (`houston` is the
    # TypeScript build's, at the repository root). The fixtures were captured as `houston`,
    # and Click prints argv[0]'s basename in every Usage line, so the script is run through
    # a link of that name in a directory of its own, removed when this process exits.
    candidate = pathlib.Path(interpreter).with_name("houston-py")
    if not candidate.exists():
        raise SystemExit(f"{candidate} does not exist -- run this with .venv/bin/python "
                         f"and make sure `pip install -e legacy` has been done")
    global _NAMED_BIN
    if _NAMED_BIN is None:
        link_dir = pathlib.Path(tempfile.mkdtemp(prefix="houston-bin-"))
        atexit.register(shutil.rmtree, link_dir, True)
        _NAMED_BIN = link_dir / "houston"
        os.symlink(candidate, _NAMED_BIN)
    return _NAMED_BIN


_NAMED_BIN: pathlib.Path | None = None


def routed_to_typescript(binary: pathlib.Path) -> set[pathlib.Path]:
    """The fixtures whose text `binary` gets from the TypeScript build.

    None, unless `binary` is this checkout's dispatcher: then every path `routing.conf`
    sends to `ts`. Those texts are the TypeScript's, which the owner held to the frozen
    CONTENT rather than its bytes until the post-cutover redesign (STATE 8.9.0, decision
    3.1; `yarn parity:help --bin bin/houston` is that check). The Tier 1 flip was the
    first time the table had any `ts` line, and `--check` through `bin/houston` then
    compared eleven TypeScript help texts byte for byte against the Python's and failed
    -- a gate asking for what the owner had decided it should not.
    """
    try:
        if binary.resolve() != DISPATCHER.resolve():
            return set()
        lines = ROUTING.read_text(encoding="utf-8").splitlines()
    except OSError:
        return set()
    out: set[pathlib.Path] = set()
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.rpartition("=")
        if value.strip() == "ts":
            key = key.strip()
            out.add(ROOT_HELP if key == "__root__" else HELP_DIR / f"{slug(key)}.txt")
    return out


def child_env(home: str) -> dict:
    env = dict(os.environ)
    env.update(COLUMNS="100", NO_COLOR="1", TERM="dumb", HOUSTON_HOME=home)
    # Otherwise a developer's own settings leak into the fixture.
    env.pop("HOUSTON_BIND_HOST", None)
    return env


def collapse_paths(text: str, home: str) -> str:
    """Replace machine-specific prefixes with stable tokens. Longest prefix first.

    `loadtest` and `capacity` interpolate `$HOUSTON_HOME/reports` into the
    help string for `--report`, so their help text is different on every run and on
    every machine. That was found by capturing the fixtures and immediately failing to
    reproduce them: three of the pre-delete forty-one could never have matched. FINDINGS.md flagged
    this hazard for `capabilities` and not for `--help`, where it is the same hazard.
    """
    real_home = os.path.expanduser("~")
    pairs = ((home, "$HOUSTON_HOME"), (str(REPO_ROOT), "$REPO"), (real_home, "$HOME"))
    for prefix, token in sorted(pairs, key=lambda pair: len(pair[0]), reverse=True):
        if prefix and prefix != "/":
            text = text.replace(prefix, token)
    return text


def clean(text: str, home: str) -> str:
    """Strip escapes, collapse machine paths, make the panel decoration width-independent."""
    lines = []
    for line in ANSI.sub("", collapse_paths(text, home)).splitlines():
        if line[:1] in CORNERS:
            line = RULE.sub("──", line)
        elif line[:1] in BORDERS and line[-1:] in BORDERS:
            line = line[1:-1]
        lines.append(line.rstrip())
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines) + "\n"


def render(argv: list[str], home: str) -> str:
    proc = subprocess.run([str(houston_bin()), *argv, "--help"],
                          capture_output=True, text=True, env=child_env(home), timeout=120)
    if proc.returncode != 0:
        raise SystemExit(f"`houston {' '.join(argv)} --help` exited {proc.returncode}:\n"
                         f"{proc.stderr}")
    return clean(proc.stdout, home)


def command_names(home: str) -> list[str]:
    proc = subprocess.run([str(houston_bin()), "capabilities"],
                          capture_output=True, text=True, env=child_env(home), timeout=120)
    if proc.returncode != 0:
        raise SystemExit(f"`houston capabilities` exited {proc.returncode}:\n{proc.stderr}")
    return [c["name"] for c in json.loads(proc.stdout)["data"]["commands"]]


def slug(name: str) -> str:
    """`skill install` -> `skill-install`. Two commands are registered as sub-verbs."""
    return name.replace(" ", "-")


def _new_fixture_home() -> str:
    """Allocate an owned, unique path whose total length is deterministic."""
    # Keep the DISPLAYED prefix `/tmp` on POSIX. macOS resolves that symlink to
    # `/private/tmp`; resolving it here would change Click's wrapping even though both
    # names address the same directory. Non-POSIX uses its configured temp directory
    # and fails explicitly below if it cannot fit the frozen display width.
    parent = pathlib.Path("/tmp") if os.name == "posix" else pathlib.Path(
        tempfile.gettempdir())
    random_length = 8  # tempfile's _RandomNameSequence width on supported CPython.
    prefix_length = FIXTURE_HOME_LENGTH - len(str(parent)) - 1 - random_length
    if prefix_length < len("houston-help-"):
        raise RuntimeError(f"temporary directory path is too long for deterministic help: {parent}")
    path = tempfile.mkdtemp(prefix="houston-help-" + "x" * (prefix_length - len("houston-help-")),
                            dir=parent)
    if len(path) != FIXTURE_HOME_LENGTH:
        shutil.rmtree(path, ignore_errors=True)
        raise RuntimeError(f"temporary home length is {len(path)}, expected {FIXTURE_HOME_LENGTH}")
    return path


@contextlib.contextmanager
def fixture_home(home: str | None = None):
    """Guarantee an internally allocated home is gone afterwards.

    Both `--help` and `capabilities` CREATE `HOUSTON_HOME` while resolving the default
    for `--report`, and houston writes its event log into it. So any helper pointed at
    the fixed home has to clean up, not just the one that renders everything -- the
    first version put cleanup inside `capture()` only, and `command_names()` called
    directly left a stray event log on every test run. A home passed by a caller remains
    that caller's to remove.
    """
    owned = home is None
    where = _new_fixture_home() if owned else home
    try:
        yield where
    finally:
        if owned:
            shutil.rmtree(where, ignore_errors=True)


def capture(home: str | None = None) -> dict[pathlib.Path, str]:
    """Render every help text. Callers should NOT pass a temp home -- see the docstring."""
    with fixture_home(home) as where:
        return _capture(where)


def registered_commands() -> list[str]:
    """The command list, with the same cleanup guarantee `capture()` has."""
    with fixture_home() as where:
        return command_names(where)


def _capture(home: str) -> dict[pathlib.Path, str]:
    names = command_names(home)
    out: dict[pathlib.Path, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = {pool.submit(render, name.split(), home): name for name in names}
        jobs[pool.submit(render, [], home)] = None
        for job in concurrent.futures.as_completed(jobs):
            name = jobs[job]
            path = ROOT_HELP if name is None else HELP_DIR / f"{slug(name)}.txt"
            out[path] = job.result()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="report differences and exit non-zero; do not write")
    args = ap.parse_args()

    # The fixtures are the PYTHON build's. Through a dispatcher that routes a path to the
    # TypeScript, a capture would write the TypeScript's help over the frozen text.
    typescript = routed_to_typescript(houston_bin())
    if typescript and not args.check:
        raise SystemExit(f"refusing to capture through {houston_bin()}: routing.conf sends "
                         f"{len(typescript)} path(s) to the TypeScript build, and the "
                         "fixtures are the Python's. Capture with .venv/bin/python and no "
                         "HOUSTON_CAPTURE_PYTHON.")

    rendered = capture()

    HELP_DIR.mkdir(parents=True, exist_ok=True)
    if args.check:
        # Every text is still rendered, so a TypeScript --help that fails is still a failure.
        bad = [p for p, text in rendered.items() if p not in typescript
               and (not p.exists() or p.read_text(encoding="utf-8") != text)]
        stale = sorted(set(HELP_DIR.glob("*.txt")) - set(rendered))
        for p in sorted(bad):
            print(f"DIFFERS  {p.relative_to(REPO_ROOT)}")
        for p in stale:
            print(f"STALE    {p.relative_to(REPO_ROOT)} (no such command any more)")
        if bad or stale:
            print(f"\n{len(bad)} differ, {len(stale)} stale. If the change is intended, "
                  f"re-run without --check and READ THE DIFF -- this is a published surface.")
            return 1
        if typescript:
            print(f"{len(rendered) - len(typescript)} help texts match their fixtures through "
                  f"{houston_bin()}; {len(typescript)} answered by the TypeScript build are held "
                  "content-equal by `yarn parity:help --bin bin/houston` (STATE 8.9.0, 3.1)")
            return 0
        print(f"{len(rendered)} help texts match their fixtures")
        return 0

    for p, text in rendered.items():
        p.write_text(text, encoding="utf-8")
    for p in sorted(set(HELP_DIR.glob("*.txt")) - set(rendered)):
        p.unlink()
        print(f"removed stale {p.relative_to(REPO_ROOT)}")
    print(f"wrote {len(rendered) - 1} command fixtures to {HELP_DIR.relative_to(REPO_ROOT)} "
          f"and {ROOT_HELP.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
