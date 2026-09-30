"""The Helm release: installing it, upgrading it, and undoing a failed one.

Tier k3. `helm_rollback_on_failure` picks the flag by the helm actually installed --
`--atomic` does not exist in helm 4, it is `--rollback-on-failure` -- because a flag helm
does not recognise turns a working install into a broken one.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.errors import DockerError
from houston import exec as subprocess
import threading

import json

from houston.services.events import Emit, info, null_emit, warn
from houston.services.k8s import ask
from houston.services.k8s import exec as kubeexec
from houston.services.k8s import manifests as kubedocs
from houston.services.k8s import names as vocab
from houston.services.k8s import tools
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, CHART, INSTALL_TIMEOUT, PROBE_TIMEOUT, RELEASE, tuning

def apply(manifest: str, *, namespace: str, context: str) -> None:
    """`kubectl apply` a manifest from stdin, so no temp file is left behind."""
    argv = ["kubectl", "--context", context, "-n", namespace, "apply", "-f", "-"]
    try:
        res = subprocess.run(argv, input=manifest, capture_output=True, text=True,
                             timeout=APPLY_TIMEOUT, check=False,
                             env=kubeexec.env_for(context))
    except (OSError, subprocess.SubprocessError) as exc:
        raise DockerError(f"kubectl apply failed: {exc}") from exc
    if res.returncode != 0:
        raise CreateFailedError("kubectl apply failed: "
                                + ask.why(res))

#: How long an install may stay silent before it starts saying what it is waiting
#: for, and how often after that. The first is generous on purpose: a warm cluster
#: installs in well under it and should not narrate a step that is already over.
def _pods_waiting(namespace: str, context: str) -> str:
    """One line naming what the pods in `namespace` are doing, or "" if it cannot ask.

    Deliberately best-effort and deliberately silent on failure: this runs beside an
    install that is going perfectly well, and a progress report that turned a slow
    create into a failed one would be worse than the silence it replaces.
    """
    res = kube.run(["kubectl", "--context", context, "-n", namespace, "get", "pods",
               "-o", "json"], timeout=PROBE_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        return ""
    try:
        items = (json.loads(res.stdout or "{}").get("items") or [])
    except ValueError:
        return ""
    if not items:
        return "no pods yet"
    tally: dict[str, int] = {}
    for pod in items:
        status = pod.get("status") or {}
        reason = ""
        for cs in (status.get("containerStatuses") or []):
            waiting = ((cs.get("state") or {}).get("waiting") or {}).get("reason")
            if waiting:
                reason = waiting
                break
        # ContainerCreating on a fresh cluster is almost always the image coming
        # down, and saying so is the difference between "it is stuck" and "it is
        # doing the 1.6 GB". Named as what it IS, not as what it is probably doing.
        label = {"ContainerCreating": "starting (usually pulling the image)",
                 "PodInitializing": "initialising",
                 "ImagePullBackOff": "cannot pull its image",
                 "ErrImagePull": "cannot pull its image",
                 "CrashLoopBackOff": "crashing on start"}.get(
                     reason, reason or (status.get("phase") or "unknown").lower())
        tally[label] = tally.get(label, 0) + 1
    return ", ".join(f"{n} {what}" for what, n in sorted(tally.items()))

def _report_install_progress(namespace: str, context: str, emit: Emit,
                             stop: threading.Event) -> None:
    """Say what the longest step of a create is waiting for, while it waits.

    THE SILENCE THIS REPLACES WAS MEASURED: 254 seconds between "installing
    rocketchat/rocketchat" and the next line, on a real EKS create. `--atomic` (helm
    3) and `--rollback-on-failure` (helm 4) both imply `--wait`, so helm blocks until
    the pods are Ready and prints nothing at all while it does -- and the comment at
    the call site claimed passing `emit` made "helm's own progress reach both front
    ends", which it never could: the output is captured and returns in one piece at
    the end.

    Four minutes of nothing is the single worst thing a create does to whoever is
    watching it, and on a cloud cluster it is also the most expensive: it is where
    somebody decides the tool has hung and kills it, leaving a half-installed release
    that the next `up` then has to clear.
    """
    waited = 0.0
    while not stop.wait(1.0):
        waited += 1.0
        if waited < tuning.INSTALL_QUIET_S:
            continue
        if (waited - tuning.INSTALL_QUIET_S) % tuning.INSTALL_REPORT_EVERY_S:
            continue
        try:
            doing = _pods_waiting(namespace, context)
        except Exception:  # noqa: BLE001 - never fail a good install to report on it
            return
        # CHECKED AGAIN AFTER THE PROBE, not only before it. `_pods_waiting` is a
        # kubectl call that can take PROBE_TIMEOUT, and the install can finish while it
        # is in flight -- `install` then sets the event and gives the thread two
        # seconds, which is not enough to interrupt a call already made. Without this
        # the reporter emits "still installing" AFTER the install has finished, into
        # the middle of the next phase's output: the exact kind of out-of-order log
        # line this reporter was added to remove.
        if stop.is_set() or not doing:
            continue
        mins, secs = divmod(int(waited), 60)
        info(emit, f"still installing ({mins}m{secs:02d}s) — {doing}", phase="boot")

def install(*, namespace: str, context: str, values: dict,
            chart_version: str = "", emit: Emit = null_emit) -> None:
    """`helm install` with values on stdin, so nothing is written to disk.

    The release is `rocketchat` -- the official docs' own name -- so every command
    in them works here by substituting the namespace.
    """
    # `upgrade --install`, not `install`. Bringing a workspace back up re-runs this
    # sequence, and plain `install` fails on a release that is already there --
    # which is every `up` over an existing workspace, and every retry after a
    # partial failure.
    # A RELEASE LEFT PENDING BY A KILLED OPERATION BLOCKS EVERY LATER ATTEMPT, and
    # helm's refusal says "another operation (install/upgrade/rollback) is in
    # progress" -- which is not true and sends the reader looking for a process that
    # does not exist. Freed here rather than reported, because the state is not
    # something the person asking for a workspace did or can be expected to fix, and
    # `up` retrying identically was the only thing houston offered.
    try:
        clear_pending_release(RELEASE, namespace, context, emit=emit)
    except DockerError:
        # Could not even list the releases. Let the install below fail on its own
        # terms; its message is about the thing actually being attempted.
        pass
    # THE SAME UNDO THE SHARED RELEASES GET. `helm_rollback_on_failure` was applied
    # to the operator and the monitoring stack and not to the workspace's own release
    # -- the one a workspace actually is -- so a partly-applied Rocket.Chat upgrade
    # stayed partly applied. `clear_pending_release` above recovers it on the next
    # `up`, so this closes a gap rather than a dead end.
    argv = ["helm", "upgrade", "--install", RELEASE, CHART,
            "--kube-context", context, "-n", namespace, "--values", "-",
            *helm_rollback_on_failure()]
    if chart_version:
        argv += ["--version", chart_version]
    # BESIDE the install, not instead of it. helm is left exactly as it was -- one
    # blocking call whose output comes back in one piece -- and a reporter runs
    # alongside to say what the pods are doing, because helm says nothing at all
    # while `--wait` waits. See `_report_install_progress` for the measurement.
    stop = threading.Event()
    watcher = threading.Thread(target=_report_install_progress,
                               args=(namespace, context, emit, stop), daemon=True)
    watcher.start()
    try:
        res = subprocess.run(argv, input=json.dumps(values), capture_output=True,
                             text=True, timeout=INSTALL_TIMEOUT, check=False,
                             env=kubeexec.helm_env(context))
    except (OSError, subprocess.SubprocessError) as exc:
        raise DockerError(f"helm install failed: {exc}") from exc
    finally:
        # In a `finally`, so a failed install does not leave a thread reporting on
        # a namespace nothing is installing into any more.
        stop.set()
        watcher.join(timeout=2.0)
    if res.returncode != 0:
        raise CreateFailedError("helm install failed: "
                                + ask.why(res))

def helm_rollback_on_failure() -> list[str]:
    """The flag that makes a failed install undo itself, named for the helm installed.

    **`--atomic` DOES NOT EXIST IN HELM 4** -- it is `--rollback-on-failure`, checked
    against the 4.2.3 on this box. So the usual advice for a wedged release ("just
    add --atomic") would itself fail here, and a flag helm does not recognise turns a
    working install into a broken one. `CORE_TOOLS` admits helm 3, which has
    `--atomic` and not the new name, so the flag is chosen rather than written down.

    Empty for a helm too old to be sure about: no flag is the behaviour we already
    had, and guessing wrong costs the install itself.
    """
    found = tools.tool("helm")
    if not found.present or not found.version:
        return []
    return ["--rollback-on-failure"] if found.version >= (4, 0) else ["--atomic"]

def release_values(release: str, namespace: str, context: str) -> dict:
    """The values a release was installed with -- its `values.yaml`, from helm itself.

    `helm get values` returns exactly the user-supplied values, which is what a values
    file IS: the chart's computed defaults are its own business and come back only
    with `--all`. So this is the guide's "your values.yaml", read from the live
    release rather than rebuilt from our own records -- it cannot drift from what is
    actually deployed, and it needs no assumption that the copy `record_rendered`
    wrote is still current.
    """
    res = kube.run(["helm", "get", "values", release, "--kube-context", context,
               "-n", namespace, "-o", "json"],
              timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        raise DockerError(
            f"could not read the values of release {release!r} in {namespace}: "
            + ask.why(res))
    try:
        doc = json.loads(res.stdout or "null")
    except (ValueError, TypeError):
        doc = None
    # `helm get values` answers `null` for a release installed with no values of its
    # own. That is an empty values file, not a failure.
    return doc if isinstance(doc, dict) else {}

def _run_image_upgrade(namespace: str, context: str, chart_version: str,
                       values: dict) -> None:
    """Give Helm the complete updated values file for an image upgrade."""
    argv = ["helm", "upgrade", RELEASE, CHART, "--kube-context", context,
            "-n", namespace, "--version", chart_version, "--values", "-"]
    try:
        res = subprocess.run(argv, input=json.dumps(values), capture_output=True,
                             text=True, timeout=INSTALL_TIMEOUT, check=False,
                             env=kubeexec.helm_env(context))
    except (OSError, subprocess.SubprocessError) as exc:
        raise DockerError(f"helm upgrade failed: {exc}") from exc
    if res.returncode != 0:
        raise DockerError("helm upgrade failed: " + ask.why(res))


def upgrade_image(*, namespace: str, context: str, chart_version: str,
                  image_repo: str, tag: str, oplog: bool) -> None:
    """Move a release to a new Rocket.Chat image, the way the official guide does.

    The guide says: change `image.tag` in your values and run `helm upgrade`. This is
    that, with two differences it explicitly warns about or implies.

    First, the chart version IS pinned. The guide's own note says its command "does
    not pin a chart version, so it installs the latest Rocket.Chat Helm chart" --
    which for a tool whose entire purpose is reproducing a customer's exact version
    would quietly deploy different software than the one asked for.

    Second, the release's own values are carried over rather than a values file being
    re-rendered: everything else about the workspace -- the admin env, microservices,
    replica count, whether MongoDB comes from a Secret or a URL, a preset's settings
    -- was decided at create time, and rebuilding that set from scratch risks
    silently dropping a piece of it. The one value that must NOT be carried over is
    the oplog URL: Rocket.Chat 8 dropped oplog tailing and chart 7.0.0 removed the
    key, so it is explicitly cleared when the target no longer wants it.

    THIS IS THE GUIDE'S PROCEDURE LITERALLY: read the release's values file, change
    the image tag in it, `helm upgrade` with it. It was `--reuse-values`, which is the
    one thing the guide does not do, and two separate failures came of that.

    First, `--reuse-values` never applies the NEW chart's defaults -- helm's own
    words: "reuse the last release's values and merge in any overrides". A chart that
    ADDS a templated value then renders against a map with no such key. RC 7.4.0 ->
    7.10.15 crosses chart 6.23.2 -> 6.26.0, which added `podMonitor`, and it died on
    `nil pointer evaluating interface {}.enabled`.

    Second, and worse, it carries values that were only ever correct for the chart
    they were computed against. `container_security_context` exists because chart
    6.26.0 renders a pod-level `fsGroup` onto a CONTAINER and needs it deleted, while
    7.0.0 fixed that upstream and BREAKS if handed the deletion -- the same undeclared
    field from the other direction, as that docstring records. Carrying `fsGroup:
    null` across that upgrade reintroduces the bug it was written to fix.

    Note that this defeats `--reset-then-reuse-values` as well: that flag still
    re-applies the last release's values on top of the new defaults, so the stale
    per-chart workaround still arrives. Only recomputing it against the TARGET chart
    is correct, and supplying a whole values file is what makes that possible. So no
    reuse flag is passed here at all -- the file is complete, which is the guide's
    whole model.
    """
    values = release_values(RELEASE, namespace, context)
    # RECOMPUTED FOR THE TARGET CHART, never carried -- see the second paragraph.
    values.pop("containerSecurityContext", None)
    values.update(kubedocs.container_security_context(chart_version))
    image = values.get("image")
    values["image"] = {**(image if isinstance(image, dict) else {}),
                       "repository": image_repo, "tag": tag}
    if not oplog:
        # Rocket.Chat 8 dropped oplog tailing and chart 7.0.0 removed the key. With a
        # whole values file supplied, DELETING the key is how you say "not this any
        # more"; `--set ...=null` was the way to say it through a flag.
        values.pop("externalMongodbOplogUrl", None)
    _run_image_upgrade(namespace, context, chart_version, values)

#: Helm release statuses that mean "an operation died part-way and the release is
#: LOCKED". Helm refuses the next install/upgrade with "another operation
#: (install/upgrade/rollback) is in progress" -- a sentence whose central claim is
#: false, because nothing is in progress; the process that was doing it is gone.
PENDING_STATES = ("pending-install", "pending-upgrade", "pending-rollback")

def release_state(release: str, namespace: str, context: str) -> tuple[str, int]:
    """A release's STATUS and revision: `("", 0)` when there is no such release.

    `helm list -q` was the whole answer here, and from helm's own `--help`: "By
    default, it lists all releases in any status." So a release wedged in
    `pending-install` was reported present exactly as a healthy one was, `up` went on
    to `helm upgrade --install`, and helm refused it -- for every subsequent attempt,
    including `--force`, with no path out that houston knew about.

    A release has a STATE, not a presence. Same correction as the kubectl reads in
    this module: an external tool's several answers must not be collapsed into two.
    """
    res = kube.run(["helm", "list", "--kube-context", context, "-n", namespace,
               "-o", "json"], timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        # Not "absent". The caller decides what to do about not knowing; guessing
        # "there is nothing there" here is what would delete a record for a release
        # that exists.
        raise DockerError(
            f"could not list helm releases in {namespace} on {context!r}: "
            + ask.why(res))
    try:
        items = json.loads(res.stdout or "[]") or []
    except (ValueError, TypeError):
        return "", 0
    for item in items if isinstance(items, list) else []:
        if (item or {}).get("name") == release:
            try:
                rev = int((item or {}).get("revision") or 0)
            except (TypeError, ValueError):
                rev = 0
            return str((item or {}).get("status") or ""), rev
    return "", 0

def clear_pending_release(release: str, namespace: str, context: str, *,
                          emit: Emit = null_emit) -> str:
    """Free a release stuck in a pending state. Returns what was done, or "".

    The remedy DEPENDS ON WHETHER THERE IS ANYTHING TO GO BACK TO, and getting that
    wrong is why "just run helm rollback" is not the whole answer: a
    `pending-install` at revision 1 never had a successful revision, so a rollback
    has no target and fails. That one is uninstalled instead -- nothing it created
    was ever serving.
    """
    state, revision = release_state(release, namespace, context)
    if state not in PENDING_STATES:
        return ""
    own = vocab.is_ours(context)
    if revision <= 1:
        warn(emit, f"the {release!r} release is stuck in {state} at revision "
                   f"{revision} — it never completed once, so it is being removed "
                   f"rather than rolled back", phase="provision")
        res = kube.run(["helm", "uninstall", release, "--kube-context", context,
                   "-n", namespace], timeout=APPLY_TIMEOUT, own=own)
        action = "uninstalled"
    else:
        warn(emit, f"the {release!r} release is stuck in {state} — rolling it back "
                   f"to revision {revision - 1} before continuing", phase="provision")
        res = kube.run(["helm", "rollback", release, str(revision - 1),
                   "--kube-context", context, "-n", namespace],
                  timeout=INSTALL_TIMEOUT, own=own)
        action = f"rolled back to revision {revision - 1}"
    if res.returncode != 0:
        raise CreateFailedError(
            f"the {release!r} release in {namespace} is stuck in {state} and could "
            f"not be freed: {ask.why(res)}. Nothing is actually in progress — the "
            f"operation that was holding it has gone. Free it by hand with "
            f"`helm uninstall {release} -n {namespace}` and try again")
    info(emit, f"{release!r} {action}", phase="provision")
    return action
