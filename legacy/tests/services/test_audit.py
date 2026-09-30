"""`houston.services.audit`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

def test_a_legacy_four_field_line_still_parses(tmp_path, monkeypatch):
    """The two new columns are APPENDED, so an old log stays readable rather than
    being silently skipped by the reader that was supposed to make it useful."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.services import audit as auditsvc
    auditsvc.audit_path().parent.mkdir(parents=True, exist_ok=True)
    auditsvc.audit_path().write_text(
        "2026-01-01T00:00:00+00:00\talice\tdown-volumes\tticket-1234\n", encoding="utf-8")
    (row,) = auditsvc.read()["lines"]
    assert row["actor"] == "alice" and row["kind"] == "down-volumes"
    assert row["origin"] == "" and row["outcome"] == "ok"
