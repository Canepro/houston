"""Two builds sharing one `HOUSTON_HOME`, and why `flock` alone does not stop them.

The measurement this file exists for, taken on this machine:

    lock held by A          B takes flock     B takes OFD
    flock only              BLOCKED           ACQUIRED   <- what houston did
    OFD only                ACQUIRED          BLOCKED
    flock + additive OFD    BLOCKED           BLOCKED    <- what it does now

Every dual-run and strangler strategy in the migration assumed the two implementations
lock each other out of a workspace. They do not: a `flock` holder does not block a
process taking an OFD lock, which is what a Node native lock module takes. So two `up`
runs would race `docker compose` against itself on one workspace and orphan the loser's
containers and volume, with no tool left able to see them.

`tests/test_users.py` covers `services/users.py` and `test_services.py` the service
layer; this file is about the lock primitive and the `IMPLEMENTATION` marker, which
belong to neither.

**These tests spawn real subprocesses.** They have to: a lock is per open file
description and per process, so nothing about cross-process exclusion can be observed
from inside one interpreter. `tests/conftest.py`'s guard lets non-cloud argv through, so
this is a `sys.executable` running an inline script and nothing else.
"""
from __future__ import annotations

import os
import subprocess
import sys

import pytest

from houston import lock

# Ask a SEPARATE process whether it can take a lock on a path we already hold. Inline
# rather than a helper module, so the child depends on nothing this suite could shadow.
_CHILD = """
import fcntl, os, struct, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    if sys.argv[2] == "flock":
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    else:
        raw = struct.pack("@hhqqi", fcntl.F_WRLCK, os.SEEK_SET, 0, 0, 0)
        fcntl.fcntl(fd, fcntl.F_OFD_SETLK, raw + b"\\0" * (32 - len(raw)))
    print("ACQUIRED")
except OSError:
    print("BLOCKED")
"""


def _other_process_can_lock(path, mechanism: str) -> str:
    out = subprocess.run([sys.executable, "-c", _CHILD, str(path), mechanism],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, f"probe child failed: {out.stderr}"
    return out.stdout.strip()


@pytest.fixture()
def lockfile(tmp_path):
    path = tmp_path / "workspace.lock"
    path.write_text("", encoding="utf-8")
    return path


needs_ofd = pytest.mark.skipif(not lock.ofd_available(),
                               reason="F_OFD_SETLK is Linux-only in CPython")


@needs_ofd
def test_flock_alone_does_not_stop_the_other_implementation(lockfile):
    """The defect, asserted as a fact rather than described in a comment.

    This is what houston did at all five lock sites, and it is why the additive lock
    exists. If this test ever starts reporting BLOCKED, the kernel or CPython changed
    the rules and the whole marker/additive design should be re-examined -- so it is
    written to fail LOUDLY in that case rather than being deleted as redundant.
    """
    import fcntl

    fd = os.open(lockfile, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert _other_process_can_lock(lockfile, "flock") == "BLOCKED", (
            "two flock holders should exclude each other; if not, nothing here holds")
        assert _other_process_can_lock(lockfile, "ofd") == "ACQUIRED", (
            "flock is supposed NOT to exclude an OFD acquirer -- that is the whole "
            "finding this module addresses. If this now reports BLOCKED the platform "
            "changed and houston/lock.py's reasoning needs revisiting, not deleting.")
    finally:
        os.close(fd)


@needs_ofd
def test_the_additive_lock_blocks_both_a_flock_and_an_ofd_acquirer(lockfile):
    """The fix. Both mechanisms must be excluded, from another process.

    PROVEN AGAINST THE PRE-FIX CODE: with the `add_ofd_write_lock` call removed, the
    second assertion reports ACQUIRED. A test that passed either way would prove
    nothing, which is this repository's standing rule for a regression test.
    """
    import fcntl

    fd = os.open(lockfile, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert lock.add_ofd_write_lock(fd, blocking=False) is True

        assert _other_process_can_lock(lockfile, "flock") == "BLOCKED"
        assert _other_process_can_lock(lockfile, "ofd") == "BLOCKED", (
            "the additive OFD lock is what closes the hole; without it a TypeScript "
            "build takes this lock while this process holds it")
    finally:
        os.close(fd)


@needs_ofd
def test_an_ofd_lock_self_blocks_on_a_second_descriptor(lockfile):
    """Why `runner.repro_lock`'s per-thread reentrancy counter stays load-bearing.

    An OFD lock is per open file description, not per process, so opening the same path
    again in the SAME process and locking it conflicts -- exactly as `flock` does. That
    is precisely the deadlock the depth counter avoids when `restore --new` calls
    `create_repro` from inside its own lock, and it is why step 0.11 says not to touch
    it. Asserted so that a later "simplification" of the counter has something to fail.
    """
    first = os.open(lockfile, os.O_RDWR)
    second = os.open(lockfile, os.O_RDWR)
    try:
        assert lock.add_ofd_write_lock(first, blocking=False) is True
        with pytest.raises(OSError):
            lock.add_ofd_write_lock(second, blocking=False)
    finally:
        os.close(first)
        os.close(second)


@needs_ofd
def test_the_release_is_symmetrical_with_the_flock_beside_it(lockfile):
    """`release_ofd_lock` must actually release, not merely be tidy."""
    fd = os.open(lockfile, os.O_RDWR)
    try:
        lock.add_ofd_write_lock(fd, blocking=False)
        assert _other_process_can_lock(lockfile, "ofd") == "BLOCKED"
        lock.release_ofd_lock(fd)
        assert _other_process_can_lock(lockfile, "ofd") == "ACQUIRED", (
            "release_ofd_lock left the lock held, so every site that unlocks and keeps "
            "the descriptor open would hold a lock nobody can see")
    finally:
        os.close(fd)


# --- the IMPLEMENTATION compatibility marker --------------------------------------

def test_an_unclaimed_home_is_not_a_conflict(tmp_path):
    """A home no build has written is everybody's. Refusing it would break first run."""
    assert lock.read_implementation(tmp_path) is None
    assert lock.conflict_reason(tmp_path) is None


def test_claiming_is_idempotent_and_readable_back(tmp_path):
    lock.claim(tmp_path)
    assert lock.read_implementation(tmp_path) == lock.THIS_IMPLEMENTATION
    lock.claim(tmp_path)
    assert lock.read_implementation(tmp_path) == lock.THIS_IMPLEMENTATION
    assert lock.conflict_reason(tmp_path) is None


def test_a_home_the_other_build_wrote_is_refused_and_names_the_way_out(tmp_path):
    """The refusal has to be actionable, not merely correct.

    A message that says only "incompatible" leaves somebody with a directory full of
    workspaces and no next step, and the next step they will guess at is deleting it.
    """
    (tmp_path / lock.MARKER_NAME).write_text("typescript\n", encoding="utf-8")
    reason = lock.conflict_reason(tmp_path)
    assert reason, "a home written by the other build must be refused"
    assert "typescript" in reason
    assert lock.THIS_IMPLEMENTATION in reason
    assert "HOUSTON_HOME" in reason, (
        "the refusal must name what to do instead; without a way out the reader's next "
        "move is to delete the state directory")


def test_a_dual_compatible_home_is_accepted_without_rewriting_its_marker(tmp_path):
    """The dispatcher needs one explicit state in which both builds may coexist."""
    marker = tmp_path / lock.MARKER_NAME
    marker.write_text(f"{lock.DUAL_IMPLEMENTATION}\n", encoding="utf-8")

    assert lock.conflict_reason(tmp_path) is None
    lock.require_this_implementation(tmp_path)
    assert marker.read_text(encoding="utf-8") == f"{lock.DUAL_IMPLEMENTATION}\n"


def test_an_absent_or_empty_home_is_empty_and_nothing_else_is(tmp_path):
    """What "fresh" means for a claim made for both builds: nothing at all is there."""
    assert lock.home_is_empty(tmp_path / "absent")
    assert lock.home_is_empty(tmp_path)
    (tmp_path / "config.yaml").write_text("bind_host: 127.0.0.1\n", encoding="utf-8")
    assert not lock.home_is_empty(tmp_path)
    assert not lock.home_is_empty(tmp_path / "config.yaml"), "a file is not an empty home"


def test_a_fresh_home_under_a_mixed_table_is_claimed_for_both_builds(tmp_path, monkeypatch):
    """STATE 8.9.0: once routing.conf sends commands to both builds, a fresh home claimed
    for one of them is a home the other refuses, so `HOUSTON_HOME=$(mktemp -d) houston ...`
    would refuse from the first flip. An empty home has no format to disagree about."""
    monkeypatch.setenv(lock.DISPATCH_TABLE_ENV, "mixed")
    for home in (tmp_path / "absent", tmp_path / "empty"):
        if home.name == "empty":
            home.mkdir()
        lock.require_this_implementation(home)
        assert lock.read_implementation(home) == lock.DUAL_IMPLEMENTATION, home.name


def test_a_home_with_anything_in_it_is_claimed_for_this_build_even_under_a_mixed_table(
        tmp_path, monkeypatch):
    """Only an EMPTY home is claimed for both: anything else was written by someone, and
    promotion -- not a first command -- is what may say both builds agree about it."""
    monkeypatch.setenv(lock.DISPATCH_TABLE_ENV, "mixed")
    (tmp_path / "config.yaml").write_text("bind_host: 127.0.0.1\n", encoding="utf-8")
    lock.require_this_implementation(tmp_path)
    assert lock.read_implementation(tmp_path) == lock.THIS_IMPLEMENTATION


def test_without_a_mixed_table_a_fresh_home_is_claimed_for_this_build(tmp_path, monkeypatch):
    for word in ("single", None, "MIXED", ""):
        home = tmp_path / str(word)
        if word is None:
            monkeypatch.delenv(lock.DISPATCH_TABLE_ENV, raising=False)
        else:
            monkeypatch.setenv(lock.DISPATCH_TABLE_ENV, word)
        lock.require_this_implementation(home)
        assert lock.read_implementation(home) == lock.THIS_IMPLEMENTATION, word


def test_the_dispatchers_words_are_read_once_and_then_forgotten(monkeypatch):
    """`via` is `dispatcher` only when bin/houston exec'd THIS build; either way both
    variables leave the environment, so a child process does not inherit a route or a
    table it was never given (STATE 8.9.0, 3.3)."""
    import os
    for route, want in (("py", "dispatcher"), ("ts", "direct"), (None, "direct")):
        if route is None:
            monkeypatch.delenv(lock.DISPATCH_ROUTE_ENV, raising=False)
        else:
            monkeypatch.setenv(lock.DISPATCH_ROUTE_ENV, route)
        monkeypatch.setenv(lock.DISPATCH_TABLE_ENV, "mixed")
        assert lock.consume_dispatch() == want, route
        assert lock.DISPATCH_ROUTE_ENV not in os.environ
        assert lock.DISPATCH_TABLE_ENV not in os.environ


def test_a_claim_is_only_ever_this_build_or_both(tmp_path):
    with pytest.raises(ValueError):
        lock.claim(tmp_path, "typescript")
    assert lock.read_implementation(tmp_path) is None


def test_a_failed_atomic_claim_is_a_preflight_refusal_and_is_recoverable(
        tmp_path, monkeypatch):
    from houston.errors import PreflightError

    def no_space(_fd, _data):
        raise OSError("no space")

    monkeypatch.setattr(lock.os, "write", no_space)
    with pytest.raises(PreflightError, match="cannot safely claim"):
        lock.require_this_implementation(tmp_path)
    assert not (tmp_path / lock.MARKER_NAME).exists()


def test_a_marker_that_cannot_be_read_fails_closed_without_being_overwritten(tmp_path):
    """Unknown marker bytes cannot be treated as either safe ownership state."""
    from houston.errors import PreflightError

    marker = tmp_path / lock.MARKER_NAME
    marker.write_bytes(b"\xff\xfe not utf-8 at all")
    assert lock.read_implementation(tmp_path) is None
    assert lock.conflict_reason(tmp_path) is None
    with pytest.raises(PreflightError, match="cannot safely claim"):
        lock.require_this_implementation(tmp_path)
    assert marker.read_bytes() == b"\xff\xfe not utf-8 at all"

    marker.write_text("   \n\n", encoding="utf-8")
    assert lock.read_implementation(tmp_path) is None
    assert lock.conflict_reason(tmp_path) is None
    with pytest.raises(PreflightError, match="cannot safely claim"):
        lock.require_this_implementation(tmp_path)
    assert marker.read_text(encoding="utf-8") == "   \n\n"


def test_the_marker_is_matched_case_insensitively_and_ignores_trailing_content(tmp_path):
    """Another build writing `Python\\n<version>` must not read as a foreign home."""
    (tmp_path / lock.MARKER_NAME).write_text("PYTHON\nwritten-by 1.0.0\n", encoding="utf-8")
    assert lock.read_implementation(tmp_path) == "python"
    assert lock.conflict_reason(tmp_path) is None


def test_the_cli_refuses_a_foreign_home_before_it_writes_anything(tmp_path, monkeypatch):
    """The check runs at startup, and ORDER is the part that matters.

    It sits after the pre-rename adoption -- which moves `~/.rc-repro` onto this path,
    so judging the destination first would test a directory about to be replaced -- and
    before the event log, which is the first thing in the process to write under
    HOUSTON_HOME. A build that is about to be refused must not have written to the home
    on its way to being refused.
    """
    from houston import config, errors

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    (tmp_path / lock.MARKER_NAME).write_text("typescript\n", encoding="utf-8")

    with pytest.raises(errors.PreflightError) as caught:
        lock.require_this_implementation(config.home())
    assert "typescript" in str(caught.value)
    assert not (tmp_path / "logs").exists(), (
        "the refusal wrote an event log into a home it was refusing to use")


def test_the_cli_claims_an_unclaimed_home(tmp_path, monkeypatch):
    from houston import config

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    lock.require_this_implementation(config.home())
    assert lock.read_implementation(tmp_path) == lock.THIS_IMPLEMENTATION


def test_the_refusal_honours_the_json_contract_and_the_published_exit_code(tmp_path):
    """A startup refusal is still exactly one envelope, and it is the last line.

    THIS WAS BROKEN when the check was first wired in, and only a live run found it.
    Raising the error bare from `main()` -- before `app()`, so before anything converts
    it -- printed a Python traceback, exited 1 instead of the class's 3, and under
    `--json` wrote ZERO BYTES to stdout. That last part is the one that matters: "one
    envelope, and it is the last line" is the single promise a caller is told it may
    depend on, and it was broken precisely when the caller most needed it. `main()`'s
    own docstring lists four earlier instances of the same shape.

    `_exit_reporting` exists for this and activates JSON mode from argv when a failure
    happens before a command could. Subprocess, because that path only exists in a real
    process: the exit code and stdout ARE the assertion.
    """
    import json

    (tmp_path / lock.MARKER_NAME).write_text("typescript\n", encoding="utf-8")
    env = dict(os.environ, HOUSTON_HOME=str(tmp_path), NO_COLOR="1")
    binary = os.path.join(os.path.dirname(sys.executable), "houston-py")

    plain = subprocess.run([binary, "list"], capture_output=True, text=True,
                           env=env, timeout=120)
    assert plain.returncode == 3, (
        f"a refused home must exit 3 (PreflightError), got {plain.returncode}. "
        f"1 means it escaped the contract as an unhandled exception.")
    assert "Traceback" not in plain.stderr, "the refusal printed a traceback"

    asjson = subprocess.run([binary, "list", "--json"], capture_output=True, text=True,
                            env=env, timeout=120)
    assert asjson.returncode == 3
    lines = [line for line in asjson.stdout.splitlines() if line.strip()]
    assert len(lines) == 1, (
        f"stdout must carry exactly one envelope, got {len(lines)} line(s). Zero means "
        f"the failure bypassed jsonout entirely.")
    envelope = json.loads(lines[-1])
    assert envelope["ok"] is False
    assert envelope["error"]["code"] == "PREFLIGHT_FAILED"


def test_a_refused_home_is_not_written_to_on_the_way_out(tmp_path):
    """The refusal itself must not write under the home it refuses.

    `test_the_cli_refuses_a_foreign_home_before_it_writes_anything` proves the ORDER in
    `main()` -- the check runs before the event log is opened. It did not prove the exit
    path: `_exit_reporting` reported through `_fail`, and `_fail` records every failure
    in the durable log, so each refusal appended an `error` line to
    `<home>/logs/houston.log` -- a directory the refused build had just been told it may
    not touch. Through the real console script, because the path only exists in `main()`.
    """
    (tmp_path / lock.MARKER_NAME).write_text("typescript\n", encoding="utf-8")
    env = dict(os.environ, HOUSTON_HOME=str(tmp_path), NO_COLOR="1")
    binary = os.path.join(os.path.dirname(sys.executable), "houston-py")
    for argv in (["list"], ["list", "--json"]):
        done = subprocess.run([binary, *argv], capture_output=True, text=True,
                              env=env, timeout=120)
        assert done.returncode == 3, done.stderr
    written = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*"))
    assert written == [lock.MARKER_NAME], f"the refusal wrote into the home: {written}"
    assert (tmp_path / lock.MARKER_NAME).read_text(encoding="utf-8") == "typescript\n"
