"""Adopt a pre-rename state directory, once, without recreating anything.

This tool was called rc-repro and kept its state in `~/.rc-repro`. The rename moves
that to `~/.houston`. Everything here is about doing the move WITHOUT touching the
containers, namespaces, certificates or volumes the old name created: those are
adopted by `runner.project_name` and `k8s.namespace_for`, which read what a
workspace wrote down instead of deriving it from a prefix. A migration that
recreated a workspace would destroy the customer data the repro exists to hold, so
nothing here calls `up`, `down`, or anything that writes to Docker or Kubernetes.

Most of the state needs no rewriting at all, which is worth stating because it looks
too easy: `repro.json` has ALWAYS recorded `project`, and the Kubernetes path has
recorded `extra["namespace"]` since it existed. The records were never wrong -- only
the readers were, and that is fixed in `runner`/`k8s` rather than here. What is left
is the handful of places where the old name was written into a FILE and read back.

There is deliberately no journal entry and no lock. `os.replace` is atomic, so a
process killed during the move leaves either the old directory or the new one and
never half of each; everything after the move is idempotent and keyed on what it
finds rather than on having been told, so a killed run is simply finished by the
next one. A journal `kind` would have to be taught to `journal.recover` in order to
describe a side effect that cannot occur.

Deliberately NOT done here: anything root-owned. The systemd unit at
`/etc/systemd/system/rc-repro.service` and the CA certificate installed in the
system trust store both need sudo and an informed human, and the shared edge holds
:80 and :443 for every workspace on the box -- taking it down as a silent side
effect of somebody's first command after an upgrade is an outage nobody asked for.
`doctor` names all three, with the command to fix each.
"""

from __future__ import annotations

import json
import os
import shutil
from houston import exec as subprocess
from pathlib import Path

from houston import config, runner
from houston.errors import ConflictError, ValidationError
from houston.services import topology
from houston.services.events import Emit, info, null_emit, warn

#: Where state lived before the rename, and the names that were written INTO files
#: there and read back out again.
LEGACY_HOME_DIRNAME = ".rc-repro"
LEGACY_NAMESPACE_PREFIX = "rc-repro-"
LEGACY_EDGE_PROJECT = "rcrepro_edge"
LEGACY_LOG_NAME = "rc-repro.log"
LEGACY_SKILL_DIR = "rc-repro"

#: Files whose COMMENT lines carry the old name. Only lines beginning with "#" are
#: rewritten: `users` holds account names and password hashes on its other lines and
#: a blanket substitution there could rewrite somebody's username.
_COMMENTED_FILES = ("sessions", "users", "first-run")


def legacy_home() -> Path | None:
    """The pre-rename state directory on this box, or None.

    Only the DEFAULT location is ever migrated. If `HOUSTON_HOME` is set -- or its
    pre-rename alias, which `config.env` still honours -- then an operator has said
    where state lives, and moving a directory they named by hand is not a decision
    this function gets to make on their behalf. `doctor` reports that case instead.
    """
    if config.env("HOUSTON_HOME"):
        return None
    legacy = Path.home() / LEGACY_HOME_DIRNAME
    return legacy if legacy.is_dir() else None


def _is_effectively_empty(path: Path) -> bool:
    """Whether `path` holds nothing that would be lost by removing it.

    An early `config.home()` on a fresh box can mkdir the target before anything has
    been written into it, and refusing to migrate because of a directory this tool
    created itself one command ago would strand the state permanently.

    THE EVENT LOG COUNTS AS EMPTY, and that is the case this actually happens in.
    `logs/houston.log` is opened by the first command that runs at all -- so a box
    that ran a single `houston --version` before its state was adopted has a
    non-empty ~/.houston holding nothing but a record of that one command. Treating
    that as "state" refuses the migration forever, on the strength of a file whose
    entire content is the invocation that created it.
    """
    try:
        files = [p for p in path.rglob("*") if p.is_file()]
    except OSError:
        return False
    logs = path / "logs"
    return all(f.parent == logs and f.name.startswith("houston.log") for f in files)


def _stale_markers(home: Path) -> list[str]:
    """Files under `home` still carrying the old name on a comment line."""
    out = []
    for leaf in _COMMENTED_FILES:
        path = home / leaf
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if any(ln.startswith("#") and "rc-repro" in ln for ln in text.splitlines()):
            out.append(leaf)
    return out


def pending() -> bool:
    """Whether anything is left to adopt.

    True while the old directory is still there, and ALSO true when the move
    happened but the in-place fixes did not -- which is what makes an interrupted
    run finishable by the next one without a journal.
    """
    if legacy_home() is not None:
        return True
    home = config.home()
    return bool(_stale_markers(home)) or (home / "logs" / LEGACY_LOG_NAME).exists()


def _rewrite_markers(home: Path) -> list[str]:
    """Rewrite the old name out of comment lines. Idempotent.

    Reports rather than emits: see `migrate` on why nothing here may emit.
    """
    done = []
    for leaf in _stale_markers(home):
        path = home / leaf
        mode = path.stat().st_mode & 0o777
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        fixed = [ln.replace("rc-repro", "houston") if ln.startswith("#") else ln
                 for ln in lines]
        runner.atomic_write(path, "".join(fixed), mode=mode)
        done.append(leaf)
    # `# houston-state:` in `sessions` is the one name in this codebase that is
    # written AND parsed back -- doctor reads it to refuse a state file written by a
    # newer build. Left unrewritten the marker never matches and that refusal quietly
    # stops happening, which is the failure you cannot see.
    return done


def _rename_logs(home: Path) -> int:
    """Move `logs/rc-repro.log*` to `logs/houston.log*`. Idempotent.

    A file already at the destination means an earlier run got as far as opening the
    new log, so the old one is kept beside it under `.pre-rename` rather than skipped:
    skipping would leave `pending()` true forever and re-run this on every command.
    """
    logs = home / "logs"
    moved = 0
    if not logs.is_dir():
        return 0
    for src in sorted(logs.glob(f"{LEGACY_LOG_NAME}*")):
        dest = logs / src.name.replace(LEGACY_LOG_NAME, "houston.log", 1)
        if dest.exists():
            dest = logs / f"{src.name}.pre-rename"
            if dest.exists():
                continue
        src.rename(dest)
        moved += 1
    return moved


def _stamp_namespaces() -> list[str]:
    """Record the namespace a Kubernetes workspace is ALREADY in, where it is absent.

    `create_workspace` has written `extra["namespace"]` for as long as the Kubernetes
    runtime has existed, so this is empty for almost everybody. A workspace made
    before that field, though, has nothing recorded, and `namespace_for` would derive
    `houston-<name>` for objects that are sitting in `rc-repro-<name>` -- sending a
    later `down` at a namespace that was never created while the real one keeps its
    pods, its PVCs and its port-forward.
    """
    stamped = []
    for meta in runner.list_meta():
        name = meta.name
        if topology.of_meta(meta) != topology.KUBERNETES:
            continue
        extra = meta.extra if isinstance(meta.extra, dict) else {}
        if extra.get("namespace"):
            continue

        def _set(m, _n=name):
            m.extra = dict(m.extra or {})
            m.extra["namespace"] = f"{LEGACY_NAMESPACE_PREFIX}{_n}"

        runner.update_meta(name, _set)
        stamped.append(name)
    return stamped


def _adopt_skill_copies(emit: Emit) -> list[str]:
    """Replace agent-skill copies installed under the old directory name.

    `skill install` writes into ~/.claude/skills/<tool>/ and ~/.agents/skills/<tool>/,
    so the directory name IS the tool name and a rename strands the old copy. Nothing
    breaks loudly: the stale SKILL.md keeps teaching agents to run `rc-repro <cmd>`,
    a command that no longer exists, and an agent following it fails in a way that
    looks like the agent's fault.

    Safe to do unattended, unlike the other leftovers, because these are this tool's
    own files in a directory it created for itself -- no sudo, nothing shared, and
    nothing another program is entitled to. A locally EDITED skill is left alone:
    `install` refuses to discard somebody's changes, and that refusal is right here
    too, so the old copy is kept and reported rather than silently overwritten.
    """
    from houston.services import skill as skillsvc

    removed = []
    for host, rel in skillsvc.HOSTS.items():
        old = skillsvc._home() / rel / LEGACY_SKILL_DIR
        if not old.is_dir():
            continue
        try:
            skillsvc.install(host)
        except Exception as exc:  # noqa: BLE001 - a locally edited skill, most likely
            warn(emit, f"{old} is stale but the new skill could not be installed "
                       f"({exc}) — `houston skill install` after resolving it")
            continue
        shutil.rmtree(old, ignore_errors=True)
        removed.append(str(old))
    if removed:
        info(emit, f"replaced {len(removed)} pre-rename agent skill copy/copies")
    return removed


def _regenerate_edge_compose(emit: Emit) -> bool:
    """Rewrite the edge's compose file so its ABSOLUTE paths follow the move.

    Two of the edge's three mounts are relative (`./dynamic`, `./certs`) and travel
    with the directory. The ACME store is not: it is written as an absolute path,
    because it is shared with workspaces and lives beside the edge rather than inside
    it. After the move that path names ~/.rc-repro/acme, which no longer exists -- and
    Docker does not fail on a missing bind source, it CREATES it, empty and root-owned.
    The edge would then come up with an empty ACME store pointed at production Let's
    Encrypt and re-request every name it already held, spending a rate limit that
    allows five duplicates a week, to replace certificates that were never lost.

    `spec.json` records everything the compose file is generated from, so this is a
    regeneration rather than a rewrite: the same code path `edge start` uses.
    """
    from houston.services import edge as edgesvc

    spec_file = edgesvc.edge_dir() / edgesvc.SPEC_FILE
    if not spec_file.is_file():
        return False
    try:
        spec = json.loads(spec_file.read_text(encoding="utf-8"))
        edgesvc.write(edgesvc.Edge(**spec))
    except (OSError, ValueError, TypeError) as exc:
        warn(emit, f"could not regenerate the edge configuration ({exc}) — "
                   f"`houston edge start` rewrites it")
        return False
    info(emit, "regenerated the edge configuration for its new location")
    return True


def _hand_over_the_edge(emit: Emit) -> str:
    """Move the shared edge onto its new project instead of leaving both running.

    The instinct is to leave a running reverse proxy alone and ask first, because :80
    and :443 are visible to everything on the box. That instinct is WRONG here, and
    the reason is the move that just happened: the old container's bind mounts point
    into ~/.rc-repro, which no longer exists. It keeps serving only because Linux
    holds those directory inodes open for it -- and the first time anything restarts
    that container, Docker re-resolves the paths, creates empty directories in their
    place as root, and the edge comes back reporting `running` while serving no route
    and no certificate at all. It also restarts against an empty ACME store pointed at
    production Let's Encrypt, so it re-requests every name it used to hold.

    So there is no untouched-and-working state to protect. The migration committed the
    moment it moved the directory; stopping halfway leaves a proxy that is fine until
    it is not, with nothing on the box saying so. Finishing costs about two seconds of
    downtime and is the only outcome that is actually safe.

    Best-effort throughout: a box with no Docker and no edge has nothing to do here,
    and a failure must not take the command down with it -- it is reported with the
    two commands that finish the job by hand.
    """
    if not runner.docker_available():
        return ""
    try:
        res = subprocess.run(
            ["docker", "ps",
             "--filter", f"label=com.docker.compose.project={LEGACY_EDGE_PROJECT}",
             "--filter", "status=running", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    holder = (res.stdout or "").strip().splitlines()
    if not holder:
        return ""

    info(emit, f"handing the shared edge over from {holder[0]} — its mounts point at "
               f"a directory that no longer exists")
    try:
        stop = subprocess.run(["docker", "compose", "-p", LEGACY_EDGE_PROJECT, "down"],
                              capture_output=True, text=True, timeout=120, check=False)
    except (OSError, subprocess.SubprocessError):
        stop = None
    if stop is None or stop.returncode != 0:
        warn(emit, f"could not stop {holder[0]} — finish by hand: `docker compose -p "
                   f"{LEGACY_EDGE_PROJECT} down` then `houston edge start`")
        return holder[0]

    from houston.services import edge as edgesvc

    if not edgesvc.installed():
        info(emit, f"{holder[0]} is stopped; nothing on this box needs an edge yet")
        return holder[0]
    if edgesvc.up(pull=False).returncode == 0:
        info(emit, "the edge is serving again on :80 and :443, as houston_edge")
    else:
        warn(emit, f"{holder[0]} is stopped but the new edge did not start — "
                   f"`houston edge start` says why")
    return holder[0]


def _adopt_legacy_home(legacy, moved, target):
    """Move a pre-rename ~/.rc-repro into place, once."""
    if legacy is not None:
        if target.exists() and not _is_effectively_empty(target):
            raise ConflictError(
                f"both {legacy} and {target} hold state, so there is no safe move to "
                f"make — this tool will not merge two state directories. Keep the one "
                f"you want and remove or rename the other, then run this again")
        if target.exists():
            # `_is_effectively_empty` allows an event log through, so this is a tree
            # removal rather than an rmdir. Only ever reached for a directory that
            # holds nothing but this tool's own log of the command that made it.
            shutil.rmtree(target)
        try:
            os.replace(legacy, target)
        except OSError as exc:
            # Cross-device is the realistic cause, and a copy would stop being atomic
            # exactly where atomicity is the whole safety argument.
            raise ValidationError(
                f"could not move {legacy} to {target}: {exc}. Move it by hand "
                f"(`mv {legacy} {target}`) and run this again") from exc
        moved = True
    return moved


def migrate(emit: Emit = null_emit) -> dict:
    """Move the pre-rename state into place and finish any interrupted move.

    Safe to call on every invocation: it is a no-op once there is nothing left to do,
    and it never touches Docker or Kubernetes state.
    """
    legacy = legacy_home()
    target = config.home()
    moved = False

    moved = _adopt_legacy_home(legacy, moved, target)

    # EVERY filesystem change happens before ANY message, and the order is the whole
    # point. `events.info` tees each event into the event log, which opens
    # logs/houston.log -- so a single "moved ..." emitted here would create the
    # destination file and turn the log rename below into a permanent no-op, leaving
    # logs/rc-repro.log behind and `pending()` true on every subsequent command.
    logs_renamed = _rename_logs(target)
    markers = _rewrite_markers(target)
    namespaces = _stamp_namespaces()
    # BEFORE the handover below starts it: the edge must not come up pointed at the
    # directory it just moved out of.
    regenerated = _regenerate_edge_compose(emit) if moved else False

    if moved:
        info(emit, f"moved {legacy} to {target}")
    if logs_renamed:
        info(emit, f"renamed {logs_renamed} event-log file(s) to houston.log")
    if markers:
        info(emit, f"rewrote the old name out of {', '.join(markers)}")
    if namespaces:
        info(emit, f"recorded the existing namespace for {', '.join(namespaces)}")

    return {
        "moved": moved,
        "from": str(legacy) if legacy is not None else "",
        "to": str(target),
        "markers": markers,
        "logs_renamed": logs_renamed,
        "namespaces_recorded": namespaces,
        "skills_replaced": _adopt_skill_copies(emit),
        "edge_regenerated": regenerated,
        "legacy_edge": _hand_over_the_edge(emit),
    }
