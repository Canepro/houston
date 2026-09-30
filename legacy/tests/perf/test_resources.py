"""`houston.perf.resources`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

def test_resources_parsers():
    from houston.perf import resources as R
    assert R._parse_cpu("78.34%") == 78.34
    used, limit = R._parse_mem("540MiB / 2GiB")
    assert round(used) == 540 * 1024**2 and round(limit) == 2 * 1024**3
