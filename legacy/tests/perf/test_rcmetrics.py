"""`houston.perf.rcmetrics`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

def test_rcmetrics_prom_parser():
    from houston.perf import rcmetrics
    text = (
        "# HELP nodejs_eventloop_lag_seconds Lag of event loop in seconds.\n"
        "# TYPE nodejs_eventloop_lag_seconds gauge\n"
        "nodejs_eventloop_lag_seconds 0.0123\n"
        "nodejs_heap_size_used_bytes 123456789\n"
        'rocketchat_rest_api_count{method="GET",path="/x"} 5\n'
        'rocketchat_rest_api_count{method="POST",path="/y"} 7\n'
        "not a metric line\n"
    )
    parsed = rcmetrics.parse_prom(text)
    assert parsed["nodejs_eventloop_lag_seconds"] == 0.0123
    assert parsed["nodejs_heap_size_used_bytes"] == 123456789
    assert parsed["rocketchat_rest_api_count"] == 12          # labeled series summed
    # series accumulate and summarize
    s = rcmetrics.ServiceSeries()
    s.add(parsed)
    s.add({"nodejs_eventloop_lag_seconds": 0.5})
    lag = s.summary()["eventloop_lag_s"]
    assert lag["max"] == 0.5 and lag["n"] == 2
