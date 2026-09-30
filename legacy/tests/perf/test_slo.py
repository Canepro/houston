"""`houston.perf.slo`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations


def test_slo_evaluate_pass_and_fail():
    from houston.perf import slo
    summary = {"p95": 250.0, "error_rate": 0.005, "rps": 120.0}
    rules = slo.parse("p95=300ms,error=1%,rps=100")
    res = {r["key"]: r for r in slo.evaluate(rules, summary)}
    assert res["p95"]["ok"] and res["error"]["ok"] and res["rps"]["ok"]
    # now breach each bound
    bad = {"p95": 400.0, "error_rate": 0.02, "rps": 50.0}
    res2 = {r["key"]: r for r in slo.evaluate(rules, summary=bad)}
    assert not res2["p95"]["ok"] and not res2["error"]["ok"] and not res2["rps"]["ok"]


def test_slo_absent_metric_fails_not_measured():
    # A metric missing from the summary must FAIL (not silently PASS at 0.0).
    from houston.perf import slo
    res = slo.evaluate(slo.parse("p99=300ms"), summary={"p95": 100.0})[0]
    assert res["measured"] is False and res["ok"] is False


# --- perf (Phase 2: load test + SLO gate) -------------------------------------


def test_slo_parse_units_and_ops():
    from houston.perf import slo
    rules = slo.parse("p95=300ms,error=1%,rps=100,avg=1.5s")
    by = {r[0]: r for r in rules}
    assert by["p95"] == ("p95", "<=", 300.0, "300ms")
    assert by["avg"][2] == 1500.0                 # 1.5s -> ms
    assert by["error"] == ("error", "<=", 1.0, "1%")
    assert by["rps"] == ("rps", ">=", 100.0, "100")


def test_slo_rejects_unknown_metric():
    from houston.perf import slo
    for bad in ("throughput=100", "p95"):         # unknown metric / missing '='
        try:
            slo.parse(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad!r}")


def test_loadtest_markdown_renders():
    from houston.perf import report
    ctx = {"name": "acme", "version": "8.5.1", "scenario": "messages", "vus": 50,
           "duration": "60s", "ramp": "", "target": "http://rocketchat:3000"}
    summary = {"count": 3000, "rps": 50.0, "p50": 40, "p90": 90, "p95": 120,
               "p99": 200, "avg": 55, "min": 10, "max": 400,
               "error_rate": 0.004, "checks_rate": 0.996}
    from houston.perf import slo
    slo_res = slo.evaluate(slo.parse("p95=300ms,error=1%"), summary)
    host = {"os": "test", "cpu": 8, "docker": "27.0", "compose": "2.30"}
    md = report.loadtest_markdown(ctx, summary, slo_res, None, host)
    assert "houston load-test report" in md and "messages" in md
    assert "SLO gate" in md and "throughput" in md and "50.0 req/s" in md
