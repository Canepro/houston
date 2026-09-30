"""`houston.services.lifecycle`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

from houston.services import lifecycle as lc
from conftest import source_of


def test_create_repro_does_not_seed_when_the_caller_will():
    """`seed_here` exists so the two front-ends cannot both seed.

    The manifest only ever ADDS, so a double pass makes the readback report rooms
    holding more than planned and the second attempt collide on names it just created.
    """

    import ast


    # DERIVED, not counted. This asserted `src.count(...) == 3` against one spelling of
    # the guard, so it broke the moment `_create_repro_locked` became a plan and steps
    # and the line read `plan.req.seed` instead -- and it would equally have MISSED a
    # fourth site written with the same words in a different order. The property is that
    # every call is inside a test of `seed_here`, which is a question about the tree.
    # THE WHOLE PACKAGE, so a seed site added in a module nobody listed here is still
    # covered -- which is the case a hand-written module list misses by construction.
    # Every seed site must be in a function that has ALREADY consulted `seed_here`. The
    # three create sites read it in the `if` around the call; the fourth -- the one that
    # finishes a seed an interrupted create asked for -- consults it earlier, by dropping
    # the journal note when the process that wrote it is still running. Requiring one
    # shape would have called that correct site a defect, and a list of module names
    # would have missed it entirely: it lives in `ready`, not in either create.
    unguarded = []
    for fn in ast.walk(ast.parse(source_of(lc))):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        consulted = min([n.attr for n in ast.walk(fn)
                         if isinstance(n, ast.Attribute) and n.attr == "seed_here"]
                        and [n.lineno for n in ast.walk(fn)
                             if isinstance(n, ast.Attribute) and n.attr == "seed_here"]
                        or [10 ** 9])
        consulted = min([consulted] + [n.lineno for n in ast.walk(fn)
                                       if isinstance(n, ast.Constant)
                                       and n.value == "seed_here"])
        for call in ast.walk(fn):
            if (isinstance(call, ast.Call)
                    and getattr(call.func, "attr", "") == "run_seed_inline"
                    and consulted > call.lineno):
                unguarded.append(f"{fn.name}:{call.lineno}")

    sites = [n for n in ast.walk(ast.parse(source_of(lc))) if isinstance(n, ast.Call)
             and getattr(n.func, "attr", "") == "run_seed_inline"]
    assert sites, "no in-service seed site found at all — this test proves nothing"
    assert not unguarded, (
        f"these in-service seed site(s) run without their function having consulted "
        f"`seed_here` first, so a caller that seeds would seed twice: {unguarded}")
