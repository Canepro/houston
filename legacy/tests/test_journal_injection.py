"""Journal recovery receives authentication instead of importing orchestration."""

from __future__ import annotations

import inspect


def test_journal_recovery_exposes_login_without_importing_lifecycle():
    from houston.services import journal

    assert "login" in inspect.signature(journal.recover).parameters
    assert "lifecycle" not in inspect.getsource(journal._repair)
