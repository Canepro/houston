"""locks -- see the package docstring."""
from __future__ import annotations

import contextlib
import threading
import time
from houston import config, lock
from houston.errors import ConflictError


#: Per-repro reentrant thread locks. `serve` runs every job on its own thread, so
#: thread-level exclusion is needed as well as the cross-process file lock -- flock
#: is held per file DESCRIPTION, and two threads opening the lock file separately
#: would each be granted it.
_THREAD_LOCKS: dict[str, threading.RLock] = {}

_THREAD_LOCKS_GUARD = threading.Lock()

#: name -> reentrancy depth, per thread.
_HELD = threading.local()

def _held_names() -> dict[str, int]:
    names = getattr(_HELD, "names", None)
    if names is None:
        names = _HELD.names = {}
    return names

def _thread_lock_for(name: str) -> threading.RLock:
    with _THREAD_LOCKS_GUARD:
        lock = _THREAD_LOCKS.get(name)
        if lock is None:
            lock = _THREAD_LOCKS[name] = threading.RLock()
        return lock


def _acquire_thread_lock(name, timeout):
    """Acquire this repro's reentrant thread lock or raise the public conflict."""
    tlock = _thread_lock_for(name)
    if not tlock.acquire(timeout=timeout):
        raise ConflictError(
            f"another houston operation is still working on {name!r} "
            f"(waited {int(timeout)}s). Check `houston list` and the Activity "
            "list, then retry.")
    return tlock


def _acquire_process_locks(fh, fcntl, deadline, poll, name, timeout):
    """Take matching flock and OFD locks, polling them as one lock pair."""
    while True:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            # ADDITIVE, not a replacement. A flock holder does NOT block a
            # process taking an OFD lock on the same file, so a TypeScript
            # build would walk straight through this. Taken inside the retry
            # loop and non-blocking, so contention behaves exactly like flock
            # contention: release and keep polling until the deadline.
            try:
                lock.add_ofd_write_lock(fh.fileno(), blocking=False)
            except OSError:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                raise
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise ConflictError(
                    f"another houston process is still working on {name!r} "
                    f"(waited {int(timeout)}s). Check `houston list` and "
                    "the Activity list, then retry.") from None
            time.sleep(poll)


@contextlib.contextmanager
def repro_lock(name: str, *, timeout: float = 900.0, poll: float = 0.2):
    """Exclusive lock for mutating one repro, across threads AND processes.

    Every mutating operation does read-compose -> write-compose -> `docker compose
    up`. Two interleaving on one repro corrupts it: compose races itself and leaves
    an orphaned container behind, which is how a repro ends up with Rocket.Chat gone
    and a stray `<hash>_houston-...` container in its place.

    Two layers, because one is not enough:
      * threading.RLock  -- `serve` runs jobs on separate threads, and flock is per
        open file description, so two threads that each open the file would both be
        granted it. RLock is also what makes the lock REENTRANT, which
        `restore --new` needs: it holds the lock and then calls create_repro, which
        takes it again on the same thread.
      * flock            -- the CLI and `serve` are different processes acting on
        the same repros, and a thread lock says nothing about that.

    Degrades to thread-only where flock is unavailable (Windows): a hard dependency
    would be worse than the race it prevents.
    """
    tlock = _acquire_thread_lock(name, timeout)
    # Reentrancy depth is tracked per THREAD, in step with the RLock's own
    # semantics. It cannot live on the lock object: threading.RLock is a C type
    # with no __dict__, so assigning an attribute to it raises.
    held = _held_names()
    reentrant = held.get(name, 0)
    held[name] = reentrant + 1
    try:
        # The outermost frame on this thread already owns the file lock, and
        # re-flocking the same path from a second descriptor would deadlock
        # against ourselves -- which is what `restore --new` would do when it
        # calls create_repro from inside its own lock.
        if reentrant:
            yield
            return
        try:
            import fcntl
        except ImportError:                              # pragma: no cover - Windows
            yield
            return
        lock_dir = config.home() / "locks"
        lock_dir.mkdir(parents=True, exist_ok=True)
        path = lock_dir / f"{name}.lock"
        deadline = time.monotonic() + timeout
        with open(path, "w", encoding="utf-8") as fh:
            _acquire_process_locks(fh, fcntl, deadline, poll, name, timeout)
            try:
                yield
            finally:
                lock.release_ofd_lock(fh.fileno())
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    finally:
        if held.get(name, 0) <= 1:
            held.pop(name, None)
        else:
            held[name] -= 1
        tlock.release()
