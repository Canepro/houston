"""`houston.perf.timeline`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

def test_timeline_bucketing(tmp_path):
    import json as _json
    from houston.perf import timeline
    # Synthetic k6 point stream: 60s of requests, latency degrading, errors late.
    # k6 emits compact JSON (no spaces) — the parser's prefilter relies on that.
    compact = {"separators": (",", ":")}
    lines = []
    for sec in range(60):
        t = f"2026-07-19T10:00:{sec:02d}.123456789+00:00"
        lines.append(_json.dumps({"type": "Point", "metric": "http_req_duration",
                                  "data": {"time": t, "value": 50.0 + sec * 10}}, **compact))
        if sec >= 45:
            lines.append(_json.dumps({"type": "Point", "metric": "http_req_failed",
                                      "data": {"time": t, "value": 1}}, **compact))
    p = tmp_path / "points.json"
    p.write_text("\n".join(lines), encoding="utf-8")
    tl = timeline.parse(p)
    assert tl and len(tl["buckets"]) <= timeline.TARGET_BUCKETS + 1
    assert tl["buckets"][-1]["p95"] > tl["buckets"][0]["p95"]      # degradation visible
    assert tl["first_error_s"] is not None and tl["first_error_s"] >= 40
    art = timeline.render_ascii(tl)
    assert "p95 over time" in art[0] and "errors" in art[1]
    assert timeline.parse(tmp_path / "missing.json") is None


def test_spike_recovery_math():
    from houston.perf import timeline
    # 90s run, 1s buckets: calm first third, spiked middle, recovering tail.
    def bucket(t, p95):
        return {"t0": t, "reqs": 10, "p50": p95 * 0.6, "p95": p95, "max": p95 * 2, "errors": 0}
    buckets = ([bucket(t, 100.0) for t in range(0, 30)]
               + [bucket(t, 900.0) for t in range(30, 60)]
               + [bucket(t, 800.0) for t in range(60, 68)]      # still elevated
               + [bucket(t, 120.0) for t in range(68, 90)])     # back under 1.5x baseline
    tl = {"width_s": 1, "span_s": 89, "buckets": buckets, "first_error_s": None}
    rec = timeline.spike_recovery(tl)
    assert rec["baseline_p95"] == 100.0 and rec["spike_p95"] == 900.0
    assert rec["recovered_after_s"] == 8
    # never recovers -> None
    stuck = {"width_s": 1, "span_s": 89, "first_error_s": None,
             "buckets": buckets[:60] + [bucket(t, 900.0) for t in range(60, 90)]}
    assert timeline.spike_recovery(stuck)["recovered_after_s"] is None
