"""`houston.web.routes.data`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from houston.services import lifecycle as lc
from webhelpers import H, client

def test_scale_and_clear_endpoints_are_jobs(monkeypatch):
    from houston.services import data
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(data, "run_scale", lambda name, spec, emit=None: {"users": 5})
    monkeypatch.setattr(data, "clear_scale", lambda name, emit=None: {"users": 0})
    c = client()
    r = c.post("/api/repros/x/scale", headers=H, json={"scale": "users=5"})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    r = c.delete("/api/repros/x/scale", headers=H)
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")


def test_config_import_plan_upload(monkeypatch, tmp_path):
    from houston.services import data
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.paths, "workspace", lambda n: tmp_path)
    monkeypatch.setattr(data, "import_plan",
                        lambda name, path, only=None: {"counts": {"apply": 2, "redacted": 0, "denied": 1},
                                                       "apply": [], "redacted": [], "denied": ["Site_Url"],
                                                       "oauth_services": []})
    c = client()
    r = c.post("/api/repros/x/config-import/plan", headers=H,
               files={"file": ("s.json", b"[]", "application/json")}, data={"only": ""})
    assert r.status_code == 200 and r.json()["counts"]["apply"] == 2
    # One file per upload rather than a shared settings.json: two tabs previewing
    # different dumps used to race, and the second silently won the first's apply.
    upload_id = r.json()["upload_id"]
    assert (tmp_path / "import" / f"{upload_id}.json").exists()


def test_config_import_uploads_do_not_collide(monkeypatch, tmp_path):
    from houston.services import data
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.paths, "workspace", lambda n: tmp_path)
    seen = []
    monkeypatch.setattr(data, "import_plan", lambda name, path, only=None: seen.append(path) or {
        "counts": {"apply": 0, "redacted": 0, "denied": 0},
        "apply": [], "redacted": [], "denied": [], "oauth_services": []})
    c = client()
    ids = [c.post("/api/repros/x/config-import/plan", headers=H,
                  files={"file": ("s.json", b"[]", "application/json")},
                  data={"only": ""}).json()["upload_id"] for _ in range(2)]
    assert ids[0] != ids[1] and len(set(seen)) == 2


def test_config_import_apply_rejects_a_forged_upload_id(monkeypatch, tmp_path):
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.paths, "workspace", lambda n: tmp_path)
    # The id becomes a filename, so it is pattern-checked before use.
    for bad in ("../../etc/passwd", "u../../x", "nope", "", "u0123456789ab/../x"):
        r = client().post("/api/repros/x/config-import", headers=H, json={"upload_id": bad})
        assert r.status_code == 400, bad


def test_config_import_apply_requires_prior_upload(monkeypatch, tmp_path):
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.paths, "workspace", lambda n: tmp_path)
    r = client().post("/api/repros/x/config-import", headers=H, json={})
    assert r.status_code == 400   # no uploaded settings.json yet


def test_config_import_apply_uses_the_previewed_filter(monkeypatch, tmp_path):
    from houston.services import data
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.paths, "workspace", lambda n: tmp_path)
    seen = {}
    monkeypatch.setattr(data, "import_plan", lambda name, path, only=None: {
        "counts": {"apply": 0, "redacted": 0, "denied": 0},
        "apply": [], "redacted": [], "denied": [], "oauth_services": []})
    monkeypatch.setattr(data, "import_apply",
                        lambda name, path, only=None, emit=None: seen.setdefault("only", only) or {"applied": 0})
    c = client()
    r = c.post("/api/repros/x/config-import/plan", headers=H,
               files={"file": ("s.json", b"[]", "application/json")},
               data={"only": "Livechat,LDAP"})
    upload_id = r.json()["upload_id"]
    # The client asks for a DIFFERENT filter at apply time. It must be ignored: the
    # whole point of the preview step is that what was reviewed is what runs.
    c.post("/api/repros/x/config-import", headers=H,
           json={"upload_id": upload_id, "only": "Accounts"})
    for _ in range(400):
        if "only" in seen:
            break
        __import__("time").sleep(0.01)
    assert seen["only"] == {"Livechat", "LDAP"}


def test_config_import_prunes_stale_uploads(monkeypatch, tmp_path):
    from houston.services import data
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.paths, "workspace", lambda n: tmp_path)
    monkeypatch.setattr(data, "import_plan", lambda name, path, only=None: {
        "counts": {"apply": 0, "redacted": 0, "denied": 0},
        "apply": [], "redacted": [], "denied": [], "oauth_services": []})
    c = client()
    for _ in range(8):
        c.post("/api/repros/x/config-import/plan", headers=H,
               files={"file": ("s.json", b"[]", "application/json")}, data={"only": ""})
    # A previewed-but-never-applied dump has nothing to delete it, and these are
    # customers' config files -- they must not accumulate without bound.
    assert len(list((tmp_path / "import").glob("u*.json"))) == 5
