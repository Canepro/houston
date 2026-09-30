"""`houston.services.lifecycle.ready`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

def test_a_step_that_is_not_the_end_does_not_announce_done_at_a_hundred_percent():
    """`wait_and_finalize` is the whole of `houston ready` and one step of `up`.

    MEASURED on a real EKS create: `done: ready` at 100% at 414s, then 46 more seconds
    of seeding, then a second `done`. In the GUI that is a progress bar that fills up
    and then keeps going; in a log it is a run that finishes twice.

    The invariant is not about the message but about who may claim the end: every
    caller that keeps working after this one passes `final=False`, and every caller
    that does not is the end and keeps the default.
    """
    import inspect

    from houston.services import lifecycle as lcmod

    said: list = []
    lcmod._say_ready(lambda e: said.append((e.phase, e.pct)), False)
    # NO PERCENTAGE. `wait_serving` has already emitted 100 by the time this runs, so
    # naming any number sends the bar BACKWARDS — observed on a real create as
    # `[100%] ... is serving at`, then `[85%] the workspace is up`, then `[100%]`.
    assert said == [("wait", None)], said
    said.clear()
    lcmod._say_ready(lambda e: said.append((e.phase, e.pct)), True)
    assert said == [("done", 100.0)], said

    # AND `final` DEFAULTS TO THE END, because the caller that forgets to think about
    # it is `houston ready`, for which the default is right.
    sig = inspect.signature(lcmod.wait_and_finalize)
    assert sig.parameters["final"].default is True
