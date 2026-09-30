"""The service package has an initializer and no barrel in it.

Phase 1 DELETED `services/__init__.py` because it re-exported `events` at module scope,
which put `houston.services` inside the seventeen-module import cycle that phase was
cutting. This test asserted the deletion by checking `__file__ is None` — the mechanism
rather than the property.

Phase 2a had to put the file back, and the reason is packaging rather than design:
`find_packages` will not discover a directory without an `__init__.py`, so every module
under `houston/services/doctor/` was built into a wheel that did not contain them.
`tools/wheel_smoke.py` found it by importing the installed artifact from outside the
checkout, which is the only place that failure is visible.

So the invariant is stated directly now: the file exists, and there is NOTHING in it but
a docstring. An import at that scope is executed before any submodule can be handed back,
so it becomes an edge from every one of them to the initialiser, and the cycle returns
with it.
"""

from __future__ import annotations

import ast
import pathlib


def test_the_services_initializer_exists_so_the_package_can_be_packaged() -> None:
    import houston.services as services

    assert services.__file__ is not None, (
        "houston/services/__init__.py is gone again — find_packages cannot discover the "
        "package without it and the wheel ships without houston.services.doctor")
    assert pathlib.Path(services.__file__).name == "__init__.py"


def test_the_services_initializer_holds_nothing_but_its_docstring() -> None:
    """The emptiness IS the mechanism that keeps the cycle out."""
    import houston.services as services

    tree = ast.parse(pathlib.Path(services.__file__).read_text(encoding="utf-8"))
    body = list(tree.body)
    assert body, "expected at least a docstring explaining why this file is empty"
    first = body.pop(0)
    assert isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant), \
        "the first statement is not a docstring"
    assert not body, (
        "houston/services/__init__.py has grown a statement: "
        + ", ".join(type(n).__name__ for n in body)
        + ". Anything here runs before every submodule and re-creates the import cycle.")


def test_nothing_is_reachable_through_the_package_that_is_not_a_module() -> None:
    import houston.services as services
    from houston.services import lifecycle

    # `Event` is a CLASS from `services.events`; it can only be here if the initialiser
    # re-exported it, which is the barrel phase 1 removed.
    #
    # Deliberately NOT asserting that `services.events` is absent: Python binds a
    # submodule onto its parent package the moment anything imports it, so in a suite
    # that has imported `services.events` once, that attribute is there regardless of
    # what this file contains. The test above reads the initialiser instead, which is
    # the only thing that can actually be wrong.
    assert not hasattr(services, "Event")
    assert lifecycle.__name__ == "houston.services.lifecycle"
