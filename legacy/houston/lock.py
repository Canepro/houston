"""Two builds must exclude each other from one state directory. `flock` alone does not.

MEASURED ON THIS MACHINE, and it is the most consequential finding in the migration
analysis. Python's `fcntl.flock` and Linux OFD locks (`fcntl F_OFD_SETLK`, which is what
a Node native lock module takes) **do not exclude each other**:

    lock held by A          B takes flock     B takes OFD
    flock only              BLOCKED           ACQUIRED   <- walks straight through
    OFD only                ACQUIRED          BLOCKED    <- and so does this
    flock + additive OFD    BLOCKED           BLOCKED    <- the fix

Every dual-run and strangler strategy assumes the two implementations lock each other
out of a shared workspace. They do not. Two `up` runs on one workspace would race
`docker compose` against itself, silently, and the loser's containers and volumes would
be orphaned with no tool left able to see them.

**The marker is the compatibility gate; the lock is the concurrency mechanism.** A
single-implementation marker refuses the other build. The dispatcher may promote it to
`dual-v1` only after bidirectional state and real Python/Node lock tests pass. Both builds
then preserve that marker and rely on the shared lock protocol. This makes mixed-command
cutover explicit instead of impossible, while an accidental foreign build still fails
loudly.

**Why it cannot be bet on.** `F_OFD_SETLK` is Linux-only in CPython, so every call here
is `hasattr`-guarded and degrades to "flock only" elsewhere -- the same degradation the
existing lock sites already accept for Windows. On macOS a Node native lock module uses
BSD `flock`, so the two contend natively and no additive lock is needed. Windows is
thread-only today. Three platforms, three behaviours: do not bet safety on the matrix.

**This module imports nothing from `houston`.** It is pure mechanism -- stdlib only, no
error taxonomy, no policy. That is deliberate and it is a correction to the migration
plan's layer table, which lists `lock.py` beside `config.py` at L1. `config.py` is one of
the five lock sites, so it has to import this; two modules in one layer may not import
each other, and the resolution is that the mechanism sits BELOW the layer that needs it.
So the refusal message is returned as a string by `conflict_reason()` and raised as a
`ReproError` by the caller, which keeps the taxonomy where it belongs.
"""
from __future__ import annotations

import os
import struct
from pathlib import Path

#: The file that records which build last wrote a home, and what this build calls itself.
MARKER_NAME = "IMPLEMENTATION"
THIS_IMPLEMENTATION = "python"
DUAL_IMPLEMENTATION = "dual-v1"

#: Set by `bin/houston`, the Phase-8 dispatcher, to `mixed` when routing.conf sends
#: commands to BOTH builds, and to `single` when it sends them all to one. See
#: `require_this_implementation` for the one thing it changes.
DISPATCH_TABLE_ENV = "HOUSTON_DISPATCHED_TABLE"

#: Set by `bin/houston` to the route it exec'd, `py` or `ts`. A build that finds its OWN
#: route here was dispatched; the event log records that as `via` (STATE 8.9.0, 3.3).
DISPATCH_ROUTE_ENV = "HOUSTON_DISPATCHED_ROUTE"

#: What `bin/houston` calls this build in routing.conf.
THIS_ROUTE = "py"


def consume_dispatch() -> str:
    """How this process was started -- `dispatcher` or `direct` -- and forget the words.

    Both variables describe THIS exec and nothing after it: a subprocess this build starts
    was not dispatched, and must not claim a home for both builds on the strength of a
    table it never saw. So the entry point calls this once, after the home is claimed, and
    the variables are gone from the environment every child inherits.
    """
    route = os.environ.pop(DISPATCH_ROUTE_ENV, None)
    os.environ.pop(DISPATCH_TABLE_ENV, None)
    return "dispatcher" if route == THIS_ROUTE else "direct"

#: `struct flock` on Linux: short l_type, short l_whence, off_t l_start, off_t l_len,
#: pid_t l_pid. Packed native and padded, because the kernel reads a fixed-size struct
#: and CPython hands the bytes through `fcntl.fcntl` untouched.
_FLOCK_STRUCT = "@hhqqi"
_FLOCK_SIZE = 32


def _packed(lock_type: int) -> bytes:
    raw = struct.pack(_FLOCK_STRUCT, lock_type, os.SEEK_SET, 0, 0, 0)
    return raw + b"\0" * (_FLOCK_SIZE - len(raw))


def ofd_available() -> bool:
    """Whether this interpreter can take an OFD lock at all (Linux CPython only)."""
    try:
        import fcntl
    except ImportError:                              # pragma: no cover - not POSIX
        return False
    return hasattr(fcntl, "F_OFD_SETLK") and hasattr(fcntl, "F_OFD_SETLKW")


def add_ofd_write_lock(fd: int, *, blocking: bool = True) -> bool:
    """Take an exclusive OFD lock on the WHOLE file, in addition to any `flock` held.

    Returns True when the lock was taken, False when this platform has no OFD locks --
    in which case the caller keeps whatever `flock` it already holds and is no worse off
    than before this module existed.

    Raises `OSError` when `blocking` is False and another open file description holds a
    conflicting lock, which is the same shape `flock(LOCK_EX | LOCK_NB)` raises, so an
    existing retry loop needs no new except clause.

    An OFD lock self-blocks on a second descriptor in the same process exactly as
    `flock` does. That is why `runner.repro_lock`'s per-thread reentrancy depth counter
    stays load-bearing and is deliberately untouched: the outermost frame holds both
    locks, and an inner frame must not try to take either again.
    """
    try:
        import fcntl
    except ImportError:                              # pragma: no cover - not POSIX
        return False
    op = getattr(fcntl, "F_OFD_SETLKW" if blocking else "F_OFD_SETLK", None)
    if op is None:                                   # pragma: no cover - not Linux
        return False
    fcntl.fcntl(fd, op, _packed(fcntl.F_WRLCK))
    return True


def release_ofd_lock(fd: int) -> None:
    """Drop an OFD lock explicitly. Best effort.

    Closing the descriptor releases it anyway, so this exists only to keep the release
    symmetrical with the `flock(LOCK_UN)` beside it -- a reader who sees one unlocked and
    not the other reasonably wonders which of the two was the mistake.
    """
    try:
        import fcntl
    except ImportError:                              # pragma: no cover - not POSIX
        return
    op = getattr(fcntl, "F_OFD_SETLK", None)
    if op is None:                                   # pragma: no cover - not Linux
        return
    try:
        fcntl.fcntl(fd, op, _packed(fcntl.F_UNLCK))
    except OSError:                                  # pragma: no cover - already gone
        pass


def marker_path(home: Path | str) -> Path:
    return Path(home) / MARKER_NAME


def read_implementation(home: Path | str) -> str | None:
    """Which build last wrote this home, or None if it has never been claimed.

    Never raises. A missing, unreadable, empty, or unrecognisable marker returns None;
    `require_this_implementation()` distinguishes a genuinely absent path by attempting
    an exclusive claim. If a path exists but cannot be interpreted, that claim fails and
    the command refuses without overwriting evidence.
    """
    try:
        text = marker_path(home).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    name = text.strip().splitlines()[0].strip().lower() if text.strip() else ""
    return name or None


def home_is_empty(home: Path | str) -> bool:
    """Whether `home` holds nothing at all: it does not exist, or it is an empty directory.

    A path that cannot be listed, or that is not a directory, is NOT empty -- a guard that
    cannot tell says no, so the claim it guards falls back to this build's own name.
    """
    try:
        with os.scandir(home) as entries:
            return next(entries, None) is None
    except FileNotFoundError:
        return True
    except OSError:
        return False


def claim(home: Path | str, value: str = THIS_IMPLEMENTATION) -> str | None:
    """Atomically claim an unclaimed home and return the marker now present.

    `O_EXCL` closes the check-then-write race between two implementations starting
    against a fresh home. Existing markers are never overwritten, including `dual-v1`.
    None means the marker could not be created or read safely. `value` is this build's
    own name, or `dual-v1` for an empty home the dispatcher routes to both builds.
    """
    if value not in (THIS_IMPLEMENTATION, DUAL_IMPLEMENTATION):
        raise ValueError(f"a claim is {THIS_IMPLEMENTATION!r} or {DUAL_IMPLEMENTATION!r}, not {value!r}")
    path = marker_path(home)
    found = read_implementation(home)
    if found is not None:
        return found
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return read_implementation(home)
    except OSError:
        return None
    data = f"{value}\n".encode("utf-8")
    try:
        written = 0
        while written < len(data):
            count = os.write(fd, data[written:])
            if count <= 0:
                raise OSError("short write while claiming IMPLEMENTATION marker")
            written += count
        os.fsync(fd)
        os.close(fd)
    except OSError:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            path.unlink()
        except OSError:
            pass
        return None
    return value


def conflict_reason(home: Path | str) -> str | None:
    """A ready-to-raise explanation if this home belongs to another build, else None.

    The message is here rather than at the call site because it is the same message
    wherever it is raised, and because this module is the only place that knows what the
    marker means. The caller wraps it in the right `ReproError` subclass -- this module
    imports no taxonomy, by design.
    """
    found = read_implementation(home)
    if found is None or found in {THIS_IMPLEMENTATION, DUAL_IMPLEMENTATION}:
        return None
    return (
        f"{marker_path(home)} says this state directory was last written by the "
        f"{found!r} build of houston, and this is the {THIS_IMPLEMENTATION!r} build. "
        f"They do not share state safely: the two do not lock each other out of a "
        f"workspace, so running both against one home races docker compose against "
        f"itself and orphans containers no tool can then see. Use the {found!r} build "
        f"for this home, or give this build its own: export HOUSTON_HOME=<a new path>.")


def require_this_implementation(home: Path | str) -> None:
    """Refuse a home the other build owns; claim it otherwise. Raises `PreflightError`.

    The policy lives here, beside the mechanism, rather than at the call site: this
    module is the only thing that knows what the marker means, and a second caller
    (`serve` started another way, a future dispatcher) must not have to restate the
    reasoning to get the same refusal.

    `errors` is imported in the function body, not at module scope, so this module's
    module-level imports stay stdlib-only. That is what keeps `config.py` -- one of the
    five lock sites -- able to import this without an upward or sideways edge, and it is
    the idiom this package already uses in 259 places.
    """
    from houston.errors import PreflightError

    # FAIL CLOSED, and BEFORE the ownership question. A promotion in flight is holding
    # all five state locks and validating this home; a command that got past here would
    # write to it and invalidate the check the new marker is about to be based on. It is
    # checked first because it is true regardless of who owns the home -- including when
    # THIS build owns it, which is the case an ownership-first order would wave through.
    in_flight = transition_reason(home)
    if in_flight:
        raise PreflightError(in_flight)

    reason = conflict_reason(home)
    if reason:
        raise PreflightError(reason)
    found = read_implementation(home)
    if found == DUAL_IMPLEMENTATION:
        return
    # A FRESH HOME UNDER A MIXED TABLE IS CLAIMED FOR BOTH (STATE 8.9.0, the owner's
    # decision). Once routing.conf sends commands to both builds, a home claimed for
    # either one is a home the other then refuses -- so `export HOUSTON_HOME=$(mktemp -d);
    # houston ...` would refuse from the first tier flip on. `dual-v1` says every state
    # format in the home was read by both builds and they agreed, and an EMPTY home has no
    # format to disagree about, so nothing is claimed that has not been checked. Any home
    # with anything in it and no marker is still claimed for this build alone, and the
    # dispatcher refuses that case under a mixed table before either build runs.
    fresh_for_both = (os.environ.get(DISPATCH_TABLE_ENV) == "mixed" and found is None
                      and home_is_empty(home))
    claimed = claim(home, DUAL_IMPLEMENTATION if fresh_for_both else THIS_IMPLEMENTATION)
    if claimed == THIS_IMPLEMENTATION:
        return
    if claimed == DUAL_IMPLEMENTATION:
        return
    if claimed:
        raise PreflightError(conflict_reason(home) or
                             f"{marker_path(home)} was claimed by {claimed!r}")
    raise PreflightError(
        f"cannot safely claim {marker_path(home)} for this build. Check that "
        "HOUSTON_HOME is writable and that its IMPLEMENTATION marker is readable.")


# ---------------------------------------------------------------- the promotion journal
#
# `python` and `typescript` are EXCLUSIVE owners; `dual-v1` says the state formats in
# this home have been validated by both builds and either may use it. Getting from one
# to the other is a migration, and a migration that can be interrupted needs a record
# that says so -- otherwise a kill between "validated" and "marker replaced" leaves a
# home nobody can classify.
#
# So promotion writes a JOURNAL first and removes it last, and every normal command in
# both builds refuses while it exists. The three states a kill can leave are therefore:
#
#     journal + old marker   -> promotion was interrupted before the swap; recovery
#                               re-validates and either completes or abandons it
#     journal + dual-v1      -> the swap landed, the cleanup did not; recovery removes
#                               the journal
#     no journal             -> nothing is in flight, whatever the marker says
#
# What there is no way to reach is a home with a changed marker and no explanation.

#: The journal that says a promotion is in flight. A SIBLING of the marker, not a
#: rewrite of it: the marker keeps saying who owns the home until the swap actually
#: happens, so an interrupted promotion degrades to "still exclusive", not to "unknown".
TRANSITION_NAME = "IMPLEMENTATION.transition"

#: The order the five state locks are taken in, by the path each one names under
#: HOUSTON_HOME. It is FIXED and it is shared, because two builds taking the same five
#: locks in two different orders is a deadlock that only appears under contention --
#: the one kind of bug a test run on a quiet box does not find. The runner's lock is
#: per workspace and expands, in sorted name order, at the position shown.
LOCK_ORDER = (".config.lock", "locks/users.lock", "locks/sessions.lock",
              "logs/houston.log", "locks/<workspace>.lock")


def transition_path(home: Path | str) -> Path:
    return Path(home) / TRANSITION_NAME


def read_transition(home: Path | str) -> dict | None:
    """The in-flight promotion record, or None. Never raises.

    A journal that exists but cannot be parsed still counts as in flight and is
    returned as an empty record: the file's PRESENCE is the fail-closed signal, and a
    corrupt one must not read as "nothing is happening".

    So only a path that is NOT THERE is None -- and "there" means what `O_EXCL` in
    `begin_transition` means, a directory entry, which a dangling symlink is. Every
    other failure to read one counts as in flight. This used to return None for any
    `OSError` or `UnicodeDecodeError`, so a journal that was a directory, unreadable, or
    not UTF-8 let every command in this build through, while the TypeScript build
    refused the non-UTF-8 one: the one file both must read as "stop" read as "go" here.
    """
    import json
    path = transition_path(home)
    try:
        raw = path.read_bytes()
    except (FileNotFoundError, NotADirectoryError):
        return {} if os.path.lexists(path) else None
    except OSError:
        return {}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {}
    try:
        loaded = json.loads(text)
    except ValueError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def transition_reason(home: Path | str) -> str | None:
    """Why a normal command must refuse right now, or None.

    Both builds refuse while a promotion is in flight, and they refuse for the same
    reason: the home is momentarily being validated under all five locks, and a command
    that wrote to it during that window would invalidate the validation that is the
    whole basis for the marker about to be written.
    """
    record = read_transition(home)
    if record is None:
        return None
    started = record.get("started_by") or "another process"
    return (
        f"{transition_path(home)} says a promotion to {DUAL_IMPLEMENTATION!r} is in "
        f"flight, started by {started!r}. Every command refuses while it exists, "
        f"because the promotion validates this home under all five state locks and a "
        f"write now would invalidate the check the new marker is based on. If no "
        f"promotion is actually running, it was interrupted: run the recovery, which "
        f"re-validates under the same locks and then completes or abandons it.")


def begin_transition(home: Path | str, record: dict) -> bool:
    """Create the journal atomically, leaving the marker alone. False if one exists.

    `O_EXCL` is what makes two concurrent promotions impossible: the loser sees the
    file and stops, rather than both proceeding to validate and swap.
    """
    import json
    path = transition_path(home)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    try:
        os.write(fd, (json.dumps(record, sort_keys=True) + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    _fsync_dir(Path(home))
    return True


def clear_transition(home: Path | str) -> None:
    """Remove the journal and fsync the directory. The LAST step of a promotion."""
    try:
        transition_path(home).unlink()
    except OSError:
        return
    _fsync_dir(Path(home))


def _fsync_dir(directory: Path) -> None:
    """Durably record a rename or unlink in the CONTAINING directory.

    Without this the marker's new contents can be on disk while the directory entry
    pointing at them is not, which after a power loss is the half-promoted home the
    journal exists to make impossible.
    """
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:                                  # pragma: no cover - not POSIX
        return
    try:
        os.fsync(fd)
    except OSError:                                  # pragma: no cover - not supported
        pass
    finally:
        os.close(fd)


def write_marker(home: Path | str, value: str) -> None:
    """Replace the marker atomically with `value`, then fsync the directory.

    Temp-then-rename, because a truncate-and-write leaves a window in which the marker
    is empty -- and an empty marker reads as "never claimed", which is the one answer
    that lets the wrong build claim the home.
    """
    path = marker_path(home)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, f"{value}\n".encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    _fsync_dir(Path(home))
