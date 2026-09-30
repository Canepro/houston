"""`houston.perf.mongoprof`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

def test_mongoprof_last_json():
    from houston.perf import mongoprof
    out = "some banner\nWarning: x\n{\"was\": 0, \"slowms\": 100}\n"
    assert mongoprof._last_json(out) == {"was": 0, "slowms": 100}
    assert mongoprof._last_json("no json here") is None
