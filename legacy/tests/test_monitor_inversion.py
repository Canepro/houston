"""The optional monitoring add-on owns its attachment dependency."""

from __future__ import annotations

import inspect

from houston.services import lifecycle


def test_lifecycle_receives_monitor_attachment_instead_of_importing_monitor() -> None:
    source = inspect.getsource(lifecycle)

    assert "from houston.services import monitor" not in source
    assert "monitor_attach" in inspect.signature(lifecycle.create_repro).parameters

