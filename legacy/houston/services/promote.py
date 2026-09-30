"""Promote an exclusively-owned home to `dual-v1`, or refuse and leave it alone.

`IMPLEMENTATION` says `python` or `typescript` and each build refuses a home the other
owns. That refusal is the Phase-0 safety mechanism and it is the reason a strangler
cannot mix commands: the two builds cannot both touch one home while it names an owner.

`dual-v1` is the third value, and it means something specific -- **every state format in
this home has been read by both builds and they agreed**. It is not a flag somebody sets
because the port looks finished. It is the recorded result of a check, and this module is
the check.

**Why it is a migration and not an assignment.** Between "the formats validate" and "the
marker says dual-v1" there is a window, and a kill inside it must not leave a home nobody
can classify. So the operation writes `IMPLEMENTATION.transition` FIRST and removes it
LAST, every command in both builds refuses while it exists (`lock.transition_reason`), and
the three reachable end states are all explainable:

    journal + exclusive marker  -> interrupted before the swap; recover() re-validates
    journal + dual-v1           -> the swap landed, the cleanup did not; recover() tidies
    no journal                  -> nothing in flight, whatever the marker says

**How quiescence is established**, in this order and for this reason:

  1. the journal appears, so no command that STARTS from now on will do anything;
  2. `serve` is asked for -- a live GUI process has work the locks do not represent,
     and its in-memory caches would outlive the marker it was started under;
  3. all five state locks are taken, in the fixed order `lock.LOCK_ORDER` names, so
     anything already in flight has finished.

(1) closes the future and (3) closes the past. Neither alone is quiescence.

**Both readers, really both.** `validate_home()` reads every format with THIS build's
real readers. The peer build's answer comes from a command named by
`HOUSTON_PEER_VALIDATOR`, which must print the same document; promotion requires both and
requires them to agree. With no peer configured there is no second reader, so there is
nothing to validate against and promotion REFUSES -- a marker that says two builds agreed
must never be written on the strength of one.
"""
from __future__ import annotations

import contextlib
import json
import os
import time
from pathlib import Path

from houston import lock
from houston.errors import ConflictError, ValidationError
from houston.services.events import Event, null_emit

#: The command that validates a home with the OTHER build. It receives the home as its
#: last argument and must print one JSON document, the same shape `validate_home` returns.
PEER_ENV = "HOUSTON_PEER_VALIDATOR"

#: Written by `serve` while it runs, so promotion can tell a live GUI from a stale file.
SERVE_PID_NAME = "serve.pid"

#: The document version. A peer that answers a different one has not been taught this
#: protocol, and disagreeing about the QUESTION is not the same as disagreeing about the
#: answer -- so it is reported as a refusal rather than as a format mismatch.
SUMMARY_SCHEMA = "houston.state.validation.v1"


def serve_pid_path(home: Path | str) -> Path:
    return Path(home) / SERVE_PID_NAME


def serve_is_running(home: Path | str) -> int | None:
    """The pid of a live `serve` against this home, or None.

    A STALE file is not a live server: `serve` removes it on a clean exit, and a kill -9
    leaves it behind. `os.kill(pid, 0)` asks the kernel instead of trusting the file, so a
    crashed GUI from last week does not block a promotion forever.
    """
    try:
        raw = serve_pid_path(home).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    try:
        pid = int(raw)
    except ValueError:
        return None
    if pid <= 0:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        # Alive and owned by somebody else, which is still alive.
        return pid
    except OSError:
        return None
    return pid


# ------------------------------------------------------------------ the five locks

def _workspace_lock_names(home: Path) -> list[str]:
    """Every per-workspace runner lock, in sorted name order.

    The runner's lock is per repro, so "all five" expands here. Sorted, because the
    ORDER is the deadlock-avoidance property and `sorted()` is the one ordering both
    builds can reach without sharing a data structure.
    """
    repros = home / "repros"
    try:
        names = sorted(entry.name for entry in repros.iterdir() if entry.is_dir())
    except OSError:
        return []
    return [f"locks/{name}.lock" for name in names]


def lock_paths(home: Path | str) -> list[str]:
    """The five state locks for this home, expanded and in the fixed order.

    Returned as paths relative to the home so the two builds can be compared as strings
    -- which `yarn test:state-handoff` does, because "the same order" is only checkable
    if both builds can say what their order IS.
    """
    root = Path(home)
    out: list[str] = []
    for entry in lock.LOCK_ORDER:
        if entry == "locks/<workspace>.lock":
            out.extend(_workspace_lock_names(root))
        else:
            out.append(entry)
    return out


@contextlib.contextmanager
def all_state_locks(home: Path | str, *, timeout: float = 30.0):
    """Hold all five state locks, taken in `lock.LOCK_ORDER`, released in reverse.

    NON-BLOCKING with a deadline rather than a blocking wait: a blocking acquire behind
    a hung `up` would leave the transition journal in place for as long as the hang
    lasts, and every command refusing meanwhile. Failing after the deadline lets the
    caller remove the journal and leave the home exactly as it found it.

    Partial acquisition is unwound by the ExitStack, in reverse order, including on the
    failure path -- a promotion that gave up holding two of five locks would be worse
    than one that never started.
    """
    try:
        import fcntl
    except ImportError:                                  # pragma: no cover - not POSIX
        yield []
        return
    root = Path(home)
    held: list[str] = []
    deadline = time.monotonic() + timeout
    with contextlib.ExitStack() as stack:
        for relative in lock_paths(root):
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            handle = stack.enter_context(open(target, "a", encoding="utf-8"))
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    # ADDITIVE, exactly as every other lock site: a flock holder does
                    # not exclude an OFD acquirer, so without this the other build
                    # would walk straight through the locks this promotion is holding
                    # in order to prove the home is quiet.
                    try:
                        lock.add_ofd_write_lock(handle.fileno(), blocking=False)
                    except OSError:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                        raise
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise ConflictError(
                            f"another houston process is still holding {relative} "
                            f"(waited {int(timeout)}s). Promotion needs this home "
                            "quiet: stop any running command or `houston serve`, "
                            "then retry.") from None
                    time.sleep(0.05)
            stack.callback(_release, fcntl, handle)
            held.append(relative)
        yield held


def _release(fcntl_module, handle) -> None:
    lock.release_ofd_lock(handle.fileno())
    try:
        fcntl_module.flock(handle.fileno(), fcntl_module.LOCK_UN)
    except OSError:                                      # pragma: no cover - closed
        pass


# --------------------------------------------------------------------- validation

def validate_home(home: Path | str) -> dict:
    """Read every state format in this home with THIS build's real readers.

    The result is the document the two builds compare. It is deliberately made of what
    each READER answers rather than of file bytes: two builds agreeing about bytes they
    both misread is not the property `dual-v1` claims.

    A format that is ABSENT is reported as absent, not as a default. That distinction is
    the one `repro.json` is built on -- an absent `extra.runtime` means docker -- and a
    validator that filled it in would be asserting the very thing it is meant to check.
    """
    root = Path(home)
    previous = os.environ.get("HOUSTON_HOME")
    os.environ["HOUSTON_HOME"] = str(root)
    try:
        return {"schema": SUMMARY_SCHEMA,
                # WHICH BUILD ANSWERED. Without it, a peer validator pointed at the SAME
                # build would compare a build with itself, agree every time, and write a
                # marker claiming two builds had checked the home. The agreement is only
                # worth anything if the two answers come from different implementations.
                "build": lock.THIS_IMPLEMENTATION,
                "formats": {
            "config": _config(root),
            "users": _users(),
            "sessions": _sessions(root),
            "audit": _audit(),
            "workspaces": _workspaces(root),
            "backups": _backups(),
            "journal": _journal(),
            "eventlog": _eventlog(root),
            # The rest of the table. Read as DIRECTORY CONTENTS and the few decoded
            # fields a reader branches on, rather than as bytes: a certificate and a CA
            # key are random by construction, and what the two builds have to agree about
            # is which files are there and what the JSON beside them says.
            "firstrun": _firstrun(),
            "edge": _edge(root),
            "acme": _acme(),
            "ca": _ca(),
            "clusters": _clusters(root),
            "presets": _presets(),
                }}
    finally:
        if previous is None:
            os.environ.pop("HOUSTON_HOME", None)
        else:
            os.environ["HOUSTON_HOME"] = previous


def _config(root: Path) -> dict:
    from houston import config
    cfg = config.load_config(with_env=False)
    return {
        "present": (root / "config.yaml").exists(),
        "keys": sorted(cfg.keys()),
        "values": {key: _canonical(value) for key, value in sorted(cfg.items())},
    }


def _users() -> dict:
    from houston.services import users
    accounts = users.list_users()
    return {
        "present": users.users_file().exists(),
        "names": sorted(row.name for row in accounts),
        # The role, NOT the hash. A validation document is written to a journal and
        # printed by a peer process; the question here is whether both builds read the
        # same accounts, and the scrypt round trip is the state referee's to answer.
        "roles": {row.name: row.role for row in accounts},
        "created": {row.name: row.created_at for row in accounts},
    }


def _sessions(root: Path) -> dict:
    from houston.services import sessions
    return {"present": sessions.sessions_file().exists(),
            "sids": sorted(_session_sids(root))}


def _audit() -> dict:
    from houston.services import audit
    page = audit.read(limit=100_000)
    return {
        "present": audit.audit_path().exists(),
        "records": [
            [row.get("actor"), row.get("kind"), row.get("label"),
             row.get("origin"), row.get("outcome")]
            for row in page["lines"]
        ],
    }


def _session_sids(root: Path) -> list[str]:
    """The sids in the file, read through the module's own line parser."""
    from houston.services import sessions
    try:
        text = sessions.sessions_file().read_text(encoding="utf-8")
    except OSError:
        return []
    out = []
    for line in text.splitlines():
        parsed = sessions._parse(line)          # the real parser, not a second one
        if parsed is not None:
            out.append(parsed.sid)
    return out


def _workspaces(root: Path) -> dict:
    from houston.runner import record
    out: dict = {}
    repros = root / "repros"
    try:
        names = sorted(entry.name for entry in repros.iterdir() if entry.is_dir())
    except OSError:
        return out
    for name in names:
        try:
            meta = record.read_meta(name)
        except Exception as exc:                # noqa: BLE001 - reported, not raised
            out[name] = {"error": type(exc).__name__}
            continue
        extra = meta.extra or {}
        out[name] = {
            # KEY PRESENCE, separately from the values: an absent `extra.runtime` means
            # docker and an absent `extra.last_upgrade_backup` means nothing to restore,
            # so a build that materialised either would differ HERE even though every
            # resolved value still matched.
            "extraKeys": sorted(extra.keys()),
            "adminPass": meta.admin_pass,
            "rcVersion": meta.rc_version,
            "hostPort": meta.host_port,
            "envKeys": sorted(extra["env"].keys()) if isinstance(extra.get("env"), dict) else None,
            "envNullKeys": (sorted(k for k, v in extra["env"].items() if v is None)
                            if isinstance(extra.get("env"), dict) else None),
        }
    return out


def _backups() -> dict:
    from houston.services import backup
    try:
        rows = backup.list_backups()
    except Exception as exc:                    # noqa: BLE001 - reported, not raised
        return {"error": type(exc).__name__}
    return {"bundles": sorted(
        [Path(str(row["path"])).name, row.get("repro", ""), row.get("error", "")]
        for row in rows)}


def _journal() -> dict:
    from houston.services import journal
    try:
        entries = journal.open_entries()
    except Exception as exc:                    # noqa: BLE001 - reported, not raised
        return {"error": type(exc).__name__}
    return {"entries": sorted([e.kind, e.workspace] for e in entries)}


def _eventlog(root: Path) -> dict:
    directory = root / "logs"
    try:
        names = sorted(p.name for p in directory.glob("houston.log*"))
    except OSError:
        return {"files": [], "records": 0}
    records = 0
    for name in names:
        try:
            for line in (directory / name).read_text(encoding="utf-8").splitlines():
                if line.strip():
                    records += 1
        except OSError:
            continue
    return {"files": names, "records": records}


def _firstrun() -> dict:
    """Presence and SHAPE only. The file holds a one-shot credential's digest, and a
    validation document is written to a journal and printed by a peer process."""
    from houston.services import firstrun
    target = firstrun.path()
    if not target.exists():
        return {"present": False}
    lines = target.read_text(encoding="utf-8").splitlines()
    return {"present": True, "headers": [ln for ln in lines if ln.startswith("#")],
            "rows": len([ln for ln in lines if ln and not ln.startswith("#")]),
            "mode": target.stat().st_mode & 0o777}


def _edge(root: Path) -> dict:
    from houston.services.edge import spec as edgespec
    current = edgespec.current()
    routes = root / "edge" / "routes"
    try:
        names = sorted(p.name for p in routes.iterdir())
    except OSError:
        names = []
    return {"domain": edgespec.served_domain(),
            "configured": current is not None,
            "routes": names}


def _acme() -> dict:
    from houston import tls
    issued = tls.acme_dir() / "issued.json"
    if not issued.exists():
        return {"present": False}
    try:
        data = json.loads(issued.read_text(encoding="utf-8"))
    except ValueError:
        return {"present": True, "malformed": True}
    return {"present": True, "hosts": sorted(data.keys()) if isinstance(data, dict) else None}


def _ca() -> dict:
    """File names and modes. The PEM BYTES are openssl's and random by construction --
    what another build reads is whether the CA is there and usable."""
    from houston import tls
    directory = tls.ca_dir()
    try:
        entries = sorted(directory.iterdir())
    except OSError:
        return {"present": False, "files": []}
    return {"present": True,
            "files": [[p.name, p.stat().st_mode & 0o777] for p in entries]}


def _clusters(root: Path) -> dict:
    try:
        names = sorted(p.name for p in (root / "clusters").iterdir())
    except OSError:
        return {"names": []}
    return {"names": names}


def _presets() -> dict:
    """USER-AUTHORED preset files. Neither build writes these; both read them, and a
    disagreement about which exist is a disagreement about what `up --preset` can do."""
    from houston import config
    try:
        names = sorted(p.name for p in config.preset_dir().iterdir())
    except OSError:
        return {"names": []}
    return {"names": names}


def _canonical(value):
    """The wire shape the two builds compare, matching the state referee's workers."""
    import datetime
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        if value != value:
            return {"$float": "nan"}
        if value in (float("inf"), float("-inf")):
            return {"$float": "inf" if value > 0 else "-inf"}
        return value
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, datetime.datetime):
        return {"$datetime": value.isoformat()}
    if isinstance(value, datetime.date):
        return {"$date": value.isoformat()}
    return str(value)


def peer_validate(home: Path | str) -> dict:
    """What the OTHER build makes of this home.

    Through `exec.py`, because that is the only module allowed to spawn anything -- the
    seam owns quoting, the timeout and the error typing, and a second subprocess site
    here would be a fourth place to get those subtly different.
    """
    command = os.environ.get(PEER_ENV, "").strip()
    if not command:
        raise ValidationError(
            f"{PEER_ENV} is not set, so there is no second reader and nothing to "
            f"validate against. A {lock.DUAL_IMPLEMENTATION!r} marker says both builds "
            "have read every format in this home and agreed; it must not be written on "
            "one build's word. Set it to the command that validates a home with the "
            "other build.")
    import shlex

    from houston import exec as execmod
    argv = shlex.split(command) + [str(home)]
    # CAPTURED, and text: the seam is `subprocess.run`'s own semantics, so stdout is
    # only retained if this call asks for it -- and without `capture_output` the peer's
    # document goes to this process's stdout, where it would break the `--json` contract
    # for any caller that wrapped a promotion.
    result = execmod.run(argv, timeout=300, check=False,
                         capture_output=True, text=True)
    if result.returncode != 0:
        raise ValidationError(
            f"the peer validator ({command}) exited {result.returncode} and this home "
            f"cannot be promoted until it succeeds: {(result.stderr or '').strip()[:400]}")
    try:
        loaded = json.loads(result.stdout)
    except ValueError as exc:
        raise ValidationError(
            f"the peer validator ({command}) did not print one JSON document: {exc}"
        ) from exc
    if isinstance(loaded, dict) and loaded.get("build") == lock.THIS_IMPLEMENTATION:
        raise ValidationError(
            f"the peer validator ({command}) is the {lock.THIS_IMPLEMENTATION!r} build, "
            f"which is this build. A {lock.DUAL_IMPLEMENTATION!r} marker says TWO "
            "implementations read this home and agreed; one build agreeing with itself "
            "is not that, and it would agree whatever either of them got wrong. Point "
            f"{PEER_ENV} at the other build.")
    if not isinstance(loaded, dict) or loaded.get("schema") != SUMMARY_SCHEMA:
        raise ValidationError(
            f"the peer validator answered schema {loaded.get('schema') if isinstance(loaded, dict) else None!r}, "
            f"this build speaks {SUMMARY_SCHEMA!r}. The two builds disagree about the "
            "QUESTION, which is not something a state comparison can resolve.")
    return loaded


#: "this key is not here", which is NOT the same as "this key is here and null".
#: `dict.get(key)` answers None for both, and `extra.env` records a removal as an
#: explicit null while an absent `extra.runtime` means docker -- so a comparator using
#: None for absence is blind to exactly the class of change this gate exists to catch.
_MISSING = object()


def differences(ours: dict, theirs: dict) -> list[str]:
    """Every path at which the two validation documents disagree.

    ABSENCE IS A VALUE HERE. A key one document has and the other does not is a
    difference even when the present one holds null, because the phase-6 state contract
    is built on keys whose absence carries meaning.
    """
    out: list[str] = []

    def walk(left, right, path: str) -> None:
        if left is _MISSING and right is _MISSING:
            return
        if left is not _MISSING and right is not _MISSING and left == right:
            return
        if isinstance(left, dict) and isinstance(right, dict):
            for key in sorted(set(left) | set(right)):
                walk(left.get(key, _MISSING), right.get(key, _MISSING), f"{path}.{key}")
            return
        out.append(path or "$")

    walk(ours.get("formats", _MISSING), theirs.get("formats", _MISSING), "")
    return out


# --------------------------------------------------------------------- the operation

def promote(home: Path | str, *, emit=null_emit, timeout: float = 30.0) -> dict:
    """Promote this home to `dual-v1`, or refuse and leave it exactly as it was.

    The order is the contract and every step is here in it. The journal is removed on
    EVERY failure path, because a refusal that left it behind would lock the operator
    out of their own home for a reason that no longer applies.
    """
    root = Path(home)
    found = lock.read_implementation(root)
    if found == lock.DUAL_IMPLEMENTATION:
        emit(Event(f"{root} is already {lock.DUAL_IMPLEMENTATION}", phase="preflight", pct=100))
        return {"marker": found, "promoted": False, "reason": "already-dual"}
    if found is None:
        raise ValidationError(
            f"{lock.marker_path(root)} names no owner, so there is nothing to promote. "
            "Run a command against this home first, or check HOUSTON_HOME.")
    if found not in (lock.THIS_IMPLEMENTATION, "typescript"):
        raise ValidationError(
            f"{lock.marker_path(root)} says {found!r}, which is not a marker this build "
            f"understands. Refusing rather than rewriting it: an unrecognised marker is "
            "evidence, and promotion is not a repair tool.")

    # 1. THE JOURNAL FIRST, and the exclusive marker untouched. From this instant every
    #    command in both builds refuses, so nothing new can start writing.
    record = {"schema": SUMMARY_SCHEMA, "from": found, "to": lock.DUAL_IMPLEMENTATION,
              "started_by": f"{lock.THIS_IMPLEMENTATION}:{os.getpid()}",
              "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if not lock.begin_transition(root, record):
        raise ConflictError(lock.transition_reason(root) or
                            f"{lock.transition_path(root)} already exists")
    emit(Event("transition journal written", phase="preflight", pct=10))

    try:
        return _run_promotion(root, found, emit, timeout)
    except BaseException:
        # EVERY failure path, including a KeyboardInterrupt: the journal is removed and
        # the original marker is still whatever it was. A refusal must leave the home
        # usable, and the marker is deliberately not touched before this point.
        lock.clear_transition(root)
        raise


def _run_promotion(root: Path, found: str, emit, timeout: float) -> dict:
    # 2. No live `serve`. Its jobs are work the locks do not represent, and its caches
    #    would outlive the marker it was started under.
    pid = serve_is_running(root)
    if pid is not None:
        raise ConflictError(
            f"`houston serve` is running against this home (pid {pid}). Promotion needs "
            "the home quiet, and a live GUI holds state in memory that would outlive the "
            "marker it started under. Stop it, then retry.")
    emit(Event("no serve running", phase="preflight", pct=20))

    with all_state_locks(root, timeout=timeout) as held:
        # 3. All five, in the fixed order. Anything already in flight has now finished.
        emit(Event(f"holding {len(held)} state locks", phase="preflight", pct=40))

        # 4. Both readers, under those locks, on a home nothing else can move.
        ours = validate_home(root)
        emit(Event("this build read every format", phase="plan", pct=60))
        theirs = peer_validate(root)
        emit(Event("the peer build read every format", phase="plan", pct=75))

        diverged = differences(ours, theirs)
        if diverged:
            raise ValidationError(
                f"the two builds do not agree about this home, so it cannot become "
                f"{lock.DUAL_IMPLEMENTATION!r}. They differ at: "
                f"{', '.join(diverged[:12])}"
                f"{'' if len(diverged) <= 12 else f' (and {len(diverged) - 12} more)'}.")
        emit(Event("both builds agree about every format", phase="plan", pct=85))

        # 5. Only now. Atomic replace, then fsync the DIRECTORY so the entry survives a
        #    power loss and not just the contents.
        lock.write_marker(root, lock.DUAL_IMPLEMENTATION)
        emit(Event(f"marker is now {lock.DUAL_IMPLEMENTATION}", phase="config", pct=95))

    # 6. The journal goes LAST, outside the locks: a kill between the swap and here
    #    leaves `dual-v1` plus a journal, which recovery recognises and tidies.
    lock.clear_transition(root)
    emit(Event(f"{root} is now {lock.DUAL_IMPLEMENTATION}", phase="done", pct=100,
               terminal=True))
    return {"marker": lock.DUAL_IMPLEMENTATION, "promoted": True, "from": found,
            "locks": lock_paths(root)}


def recover(home: Path | str, *, emit=null_emit, timeout: float = 30.0) -> dict:
    """Finish or abandon an interrupted promotion. Safe to run repeatedly.

    Which of the two it does is decided by the MARKER, because the marker is the thing
    the swap changes:

      * already `dual-v1` -- the swap landed and only the cleanup was lost. Remove the
        journal. Re-validating here would be asking permission for something already
        done, and would fail for the ordinary reason that the other build has since
        written to the home.
      * still exclusive -- the swap never happened. Re-run the WHOLE protocol under the
        same locks, because the state may have moved since the interrupted attempt read
        it, and completing on the strength of that stale read is exactly what the
        journal exists to prevent.
    """
    root = Path(home)
    record = lock.read_transition(root)
    if record is None:
        return {"recovered": False, "reason": "no-transition",
                "marker": lock.read_implementation(root)}

    # A DIRECTORY is no journal a promotion wrote -- `begin_transition` creates a file --
    # and it is one `clear_transition` cannot remove. Recovering on its strength would
    # promote the home because of a stray directory, then leave it in place and report
    # success while every command in both builds still refused.
    if lock.transition_path(root).is_dir():
        raise ConflictError(
            f"{lock.transition_path(root)} is a directory, which no promotion writes. "
            f"Recovery will not promote this home on the strength of it, and cannot remove "
            f"it: check that no promotion is running, then remove it by hand.")

    if lock.read_implementation(root) == lock.DUAL_IMPLEMENTATION:
        lock.clear_transition(root)
        emit(Event("promotion had already landed; journal cleared", phase="done",
                   pct=100, terminal=True))
        return {"recovered": True, "reason": "completed-cleanup",
                "marker": lock.DUAL_IMPLEMENTATION}

    emit(Event("re-validating an interrupted promotion", phase="preflight", pct=10))
    try:
        result = _run_promotion(root, record.get("from") or "", emit, timeout)
    except BaseException:
        lock.clear_transition(root)
        raise
    result["recovered"] = True
    result["reason"] = "revalidated"
    return result


def main(argv: list[str] | None = None) -> int:
    """`python -m houston.services.promote <home>` -- print this build's reading of a home.

    The PEER VALIDATOR entry point. The other build names this command in
    `HOUSTON_PEER_VALIDATOR` and compares what it prints with its own answer, which is
    what makes "validated by both builds" a thing that happened rather than a claim.

    stdout carries the JSON document and nothing else, for the same reason `jsonout`
    insists on it: the caller parses one line and a stray print breaks it.
    """
    import sys
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        sys.stderr.write("usage: python -m houston.services.promote <home>\n")
        return 2
    try:
        sys.stdout.write(json.dumps(validate_home(args[0]), sort_keys=True) + "\n")
    except Exception as exc:                # noqa: BLE001 - the process boundary
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":                  # pragma: no cover - a process entry point
    raise SystemExit(main())
