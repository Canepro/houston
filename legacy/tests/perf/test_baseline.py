"""`houston.perf.baseline`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations


def test_baseline_label_and_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.perf import baseline
    assert baseline.sanitize_label("Before Fix!") == "before-fix"
    for bad in ("", "///", "!!!"):
        try:
            baseline.sanitize_label(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for label {bad!r}")
    payload = {"label": "base", "ctx": {"scenario": "journey"},
               "summary": {"rps": 50.0, "p95": 120.0}}
    baseline.save("base", payload)
    assert baseline.load("base")["summary"]["p95"] == 120.0
    try:
        baseline.load("missing")
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("expected FileNotFoundError")


def test_baseline_compare_flags_regressions():
    from houston.perf import baseline
    base = {"summary": {"rps": 100.0, "p50": 40.0, "p95": 100.0, "p99": 150.0,
                        "error_rate": 0.001,
                        "steps": {"login": {"p95": 100.0}, "post": {"p95": 50.0}}}}
    cur = {"summary": {"rps": 90.0, "p50": 41.0, "p95": 300.0, "p99": 160.0,
                       "error_rate": 0.001,
                       "steps": {"login": {"p95": 310.0}, "post": {"p95": 49.0}}}}
    rows = {r["metric"]: r for r in baseline.compare(cur, base)}
    assert rows["p95"]["flag"] and rows["p95"]["pct"] > 100        # +200% -> regression
    assert not rows["p50"]["flag"]                                 # +2.5% -> noise
    assert not rows["throughput (rps)"]["flag"]                    # -10% worse but under threshold
    assert rows["step login p95"]["flag"]                          # per-step regression caught
    assert not rows["step post p95"]["worse"]                      # improvement


def test_baseline_step_order_canonical():
    from houston.perf import baseline
    steps = {"post": {}, "zeta": {}, "login": {}, "open": {}}
    assert baseline.step_order(steps) == ["login", "open", "post", "zeta"]
