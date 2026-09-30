"""`houston.web.routes.perf`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from houston.services import lifecycle as lc
from webhelpers import H, client

def test_loadtest_endpoint_is_a_job(monkeypatch):
    from houston.services import perf
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    seen = {}
    monkeypatch.setattr(perf, "run_loadtest",
                        lambda req, emit=None: seen.update(sc=req.scenario, vus=req.vus) or {"passed": True})
    r = client().post("/api/repros/x/loadtest", headers=H,
                      json={"scenario": "journey", "vus": 20, "bogus": "drop"})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    # give the worker thread a moment, then assert only known fields reached the req
    import time as _t
    _t.sleep(0.2)
    assert seen == {"sc": "journey", "vus": 20}


def test_the_capacity_endpoint_submits_a_job(monkeypatch):
    """Was `test_capacity_and_benchmark_endpoints`; the benchmark half went with the
    command in step 0.12. Capacity keeps its coverage."""
    from houston.services import perf
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(perf, "run_capacity", lambda req, emit=None: {"capacity_vus": 40})
    r = client().post("/api/repros/x/capacity", headers=H, json={"scenario": "journey", "start": 10})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")


def test_monitor_endpoint_toggles(monkeypatch):
    from houston.services import monitor as monitorsvc
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    seen = []
    monkeypatch.setattr(monitorsvc, "attach", lambda n, emit=None: seen.append(("attach", n)) or {})
    monkeypatch.setattr(monitorsvc, "detach", lambda n, emit=None: seen.append(("detach", n)) or {})
    c = client()
    for off, want in ((False, "attach"), (True, "detach")):
        r = c.post(f"/api/repros/x/monitor?off={'true' if off else 'false'}", headers=H)
        assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    for _ in range(400):
        if len(seen) == 2:
            break
        __import__("time").sleep(0.01)
    assert sorted(k for k, _ in seen) == ["attach", "detach"]
