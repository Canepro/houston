"""`houston.runner.locks`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

import pytest
from houston import runner


# --- the lock ------------------------------------------------------------------------------

def test_repro_lock_is_reentrant_on_one_thread():
    """`restore --new` holds the lock and then calls create_repro, which takes it
    again. Without reentrancy that is a deadlock against ourselves."""
    with runner.repro_lock("rc8-5-1"):
        with runner.repro_lock("rc8-5-1", timeout=1):
            pass
    with runner.repro_lock("rc8-5-1", timeout=1):
        pass          # fully released afterwards


def test_repro_lock_excludes_another_thread():
    """`serve` runs every job on its own thread, and flock alone would not stop
    two of them: it is held per open file description, so each thread's own open()
    would be granted it."""
    import threading
    started, blocked = threading.Event(), []

    from houston.errors import ConflictError, ReproError

    def contender():
        try:
            with runner.repro_lock("rc8-5-1", timeout=0.4):
                blocked.append(False)
        except ConflictError:
            blocked.append(True)

    with runner.repro_lock("rc8-5-1"):
        t = threading.Thread(target=contender)
        t.start()
        t.join(timeout=5)
    started.set()
    assert blocked == [True], "a second thread got the lock while it was held"
    # A builtin TimeoutError escaped both front ends: the CLI printed a traceback
    # and the API turned it into "internal error". ReproError is the contract they
    # both understand -- red line + exit 1, or a 409.
    assert issubclass(ConflictError, ReproError)
    assert ConflictError("x").http_status == 409


def test_repro_lock_is_released_after_an_exception():
    with pytest.raises(RuntimeError):
        with runner.repro_lock("rc8-5-1"):
            raise RuntimeError("boom")
    with runner.repro_lock("rc8-5-1", timeout=1):
        pass


def test_repro_lock_does_not_block_a_different_repro():
    with runner.repro_lock("a"), runner.repro_lock("b", timeout=0.3):
        pass
