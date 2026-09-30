"""`houston.perf.report`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations


def test_loadtest_markdown_marks_unmeasured_metrics():
    from houston.perf import report
    zero = {"rps": 0, "count": 0, "error_rate": 0, "checks_rate": None}
    ctx = {"name": "r", "version": "8.5.1", "scenario": "messages", "vus": 10,
           "duration": "30s", "ramp": "", "target": "http://rocketchat:3000", "users": 0}
    md = report.loadtest_markdown(ctx, zero, [], None, {})
    assert "| latency p95 | - |" in md          # not "**0ms**"
    assert "| checks passed | - |" in md        # not "100.0%"
    # a measured run is formatted exactly as before
    real = {"rps": 50.0, "count": 100, "p50": 10.0, "p90": 20.0, "p95": 66.0,
            "p99": 88.0, "avg": 12.0, "min": 3.0, "max": 99.0,
            "error_rate": 0.0123, "checks_rate": 1.0}
    md2 = report.loadtest_markdown(ctx, real, [], None, {})
    assert "| latency p95 | **66ms** |" in md2
    assert "| throughput | **50.0 req/s** |" in md2
    assert "| error rate | 1.23% |" in md2 and "| checks passed | 100.0% |" in md2


def test_loadtest_report_renders_steps_snapshot_compare():
    from houston.perf import report
    ctx = {"name": "acme", "version": "8.5.1", "scenario": "journey", "vus": 20,
           "duration": "30s", "ramp": "", "target": "http://rocketchat:3000",
           "users": 5, "label": "journey"}
    summary = {"count": 900, "rps": 30.0, "p50": 40, "p90": 90, "p95": 120, "p99": 200,
               "avg": 55, "min": 10, "max": 400, "error_rate": 0.0, "checks_rate": 1.0,
               "steps": {"login": {"count": 180, "p50": 100, "p95": 180, "p99": 250},
                         "post": {"count": 180, "p50": 30, "p95": 60, "p99": 90}}}
    snapshot = {"rc_version": "8.5.1", "preset": "default", "instances": 1,
                "users": 6, "rooms": 5, "messages": 40}
    compare = {"label": "base", "saved_at": "2026-07-18T10:00:00",
               "rows": [{"metric": "p95", "before": 100.0, "after": 120.0,
                         "pct": 20.0, "worse": True, "flag": False}]}
    host = {"os": "test", "cpu": 8, "docker": "27.0", "compose": "2.30"}
    md = report.loadtest_markdown(ctx, summary, [], None, host,
                                  snapshot=snapshot, compare=compare)
    assert "5 seeded users" in md and "## Workspace" in md
    assert "## Per-step latency" in md and "| login |" in md
    assert "## vs baseline `base`" in md and "+20%" in md


def test_loadtest_markdown_labels_a_spike_run_as_a_spike():
    from houston.perf import report
    # ctx["vus"] is the value the CLI told the user it was IGNORING under --spike,
    # so reporting it described a load shape that never ran.
    ctx = {"name": "r", "version": "8.5.1", "scenario": "messages", "vus": 10,
           "duration": "60s", "ramp": "", "spike": "10:100",
           "target": "http://rocketchat:3000", "users": 0}
    md = report.loadtest_markdown(ctx, {"p95": 1.0}, [], None, {})
    assert "spike 10:100 VUs for 60s" in md and "10 VUs for 60s" not in md


def test_capacity_report_renders(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from pathlib import Path
    from houston.perf import report
    ctx = {"name": "acme", "version": "8.5.1", "scenario": "journey", "slo": "p95=500ms",
           "users": 5, "step_duration": "20s", "target": "http://rocketchat:3000",
           "constrained": "rocketchat=2cpu"}
    steps = [
        {"vus": 10, "rps": 140.0, "p95": 90.0, "error_rate": 0.0, "ok": True,
         "lag_max_s": 0.02, "breached": []},
        {"vus": 20, "rps": 150.0, "p95": 620.0, "error_rate": 0.01, "ok": False,
         "lag_max_s": 1.2, "breached": ["p95 <= 500ms (actual 620ms)"]},
    ]
    host = {"os": "t", "cpu": 8, "docker": "27", "compose": "2.30"}
    out = report.write_capacity(ctx, steps, "~10 concurrent VUs",
                                "at 20 VUs the RC event loop saturated", host, "TESTSTAMP")
    md_text = Path(out).read_text(encoding="utf-8")
    assert "capacity report" in md_text and "~10 concurrent VUs" in md_text
    assert "**FAIL** — p95 <= 500ms" in md_text and "Resource caps" in md_text
    assert "event loop saturated" in md_text
