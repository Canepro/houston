"""`houston.web.routes.jobs`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient
from houston.services import lifecycle as lc
from houston.web.app import create_app
from webhelpers import (
    H, PASSWORD, _as, _auth, _fresh_auth_state, _workspace, anon_client as anon_client,
    basic_client as basic_client, client
)

def test_jobs_list_carries_label_and_survives_the_dialog(monkeypatch):
    """The activity list is the only way back to a job whose dialog was closed."""
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    from houston.services import data
    monkeypatch.setattr(data, "run_scale", lambda name, spec, emit=None: {"users": 5})
    c = client()
    job_id = c.post("/api/repros/rc8-5-1/scale", headers=H,
                    json={"scale": "users=5"}).json()["job_id"]

    r = c.get("/api/jobs", headers=H)
    assert r.status_code == 200
    rows = r.json()["jobs"]
    row = next(j for j in rows if j["id"] == job_id)
    # `kind` alone cannot tell two concurrent seeds apart -- the label names the target.
    assert row["kind"] == "scale" and row["label"] == "rc8-5-1"
    assert row["started_at"] > 0
    # The list must stay compact: a capacity search's `result` is a large nested document.
    assert "result" not in row and "events" not in row


def test_jobs_list_needs_a_session():
    assert client(sign_in=False).get("/api/jobs").status_code == 401


def test_one_members_job_output_is_not_readable_by_another(monkeypatch):
    """Job results and error text were not scoped to the submitter and sit at
    readonly+, so any signed-in account could read another user's output -- which for
    `logs`, `env`, `pat` and `api` is credentials."""
    import time as _time

    from houston.services import users as usersvc

    _fresh_auth_state()
    usersvc.add("alice", PASSWORD, role="admin")
    usersvc.add("bob", "bobs-good-password", role="member")
    usersvc.add("carol", "carols-good-password", role="member")

    # ONE app: the job registry is per-application (`app.state.jobs`), so separate
    # create_app() calls would not see each other's jobs and the test would pass
    # for the wrong reason.
    app = create_app()
    job = app.state.jobs.submit("logs",
                                lambda **_k: {"secret": "LDAP_BIND_PASSWORD"},
                                label="x", actor="bob")
    for _ in range(300):
        if job.status != "running":
            break
        _time.sleep(0.01)
    assert job.status == "done", job.status

    def as_(user, password):
        c = TestClient(app, base_url="http://localhost")
        assert c.post("/signin", data={"user": user, "password": password},
                      follow_redirects=False, headers=H).status_code == 303
        return c

    # The submitter sees it; an admin sees it; another member does not.
    assert as_("bob", "bobs-good-password").get(
        f"/api/jobs/{job.id}", headers=H).status_code == 200
    assert as_("alice", PASSWORD).get(
        f"/api/jobs/{job.id}", headers=H).status_code == 200
    other = as_("carol", "carols-good-password")
    assert other.get(f"/api/jobs/{job.id}", headers=H).status_code == 404
    # The live half of the same document is scoped too, or the above is decorative.
    assert other.get(f"/api/jobs/{job.id}/stream", headers=H).status_code == 404
    # And it is not merely hidden from the detail route: the listing drops it too.
    assert [j for j in other.get("/api/jobs", headers=H).json()["jobs"]
            if j["id"] == job.id] == []


def test_the_job_endpoint_says_when_a_result_was_released(monkeypatch):
    c = client()
    jm = c.app.state.jobs
    job = jm.submit("state", lambda emit=None: {"ok": True}, label="x")
    jm._threads[job.id].join(timeout=10)
    assert c.get(f"/api/jobs/{job.id}", headers=H).json()["result"] == {"ok": True}

    job.forget_result()
    body = c.get(f"/api/jobs/{job.id}", headers=H).json()
    assert body["result"] is None
    assert body["result_dropped"] is True, \
        "an empty panel and a discarded one are indistinguishable without this"


def test_a_refused_destructive_request_is_answered_not_queued(basic_client, tmp_path,
                                                              monkeypatch):
    """A refusal must reach the REQUEST, and must leave no job behind.

    Stop/start/restart, down and prune are jobs now, and a job answers 200 with an id.
    Validating inside one would turn "that is not an action", "no such workspace" and
    "that workspace belongs to alice" into a 200 followed by a job the caller has to go
    and read -- so the cheap checks run on the request thread, and only the work is
    queued. The same preflight shape v0.70.9 settled on for namespace ownership: a
    refusal leaves no record.
    """
    from houston.services import users as usersvc

    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    usersvc.add("bob", "bobs-good-password", role="member")
    _workspace("alices-box", "alice", tmp_path)
    _as(basic_client, "bob", "bobs-good-password")

    # Through the API, because the registry is per-app instance -- and this is the
    # list a person would open to look for the job that should not be there.
    before = len(basic_client.get("/api/jobs", headers=_auth()).json()["jobs"])
    r = basic_client.delete("/api/repros/alices-box?volumes=true&confirm=true",
                            headers=_auth())
    assert r.status_code == 409, r.text
    assert "belongs to alice" in r.json()["error"]
    assert "job_id" not in r.json(), "a refusal must not hand back a job to watch"
    after = len(basic_client.get("/api/jobs", headers=_auth()).json()["jobs"])
    assert after == before, (
        "a refused destroy queued a job - the ownership gate ran inside the work")
