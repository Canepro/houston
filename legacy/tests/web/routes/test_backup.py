"""`houston.web.routes.backup`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from houston.services import lifecycle as lc
from webhelpers import (
    H, _auth, anon_client as anon_client, basic_client as basic_client, client
)

# --- backup / restore / upgrade (#backup) ---------------------------------------
#
# The GUI gates its Upgrade action on the SERVER's answer, so these lock in that
# the gate is a real server decision and not something the browser decides alone.

def test_backup_is_a_job_and_passes_its_note_through(monkeypatch):
    """`label` is JobManager's own keyword, so the note travels as `note`."""
    from houston.services import backup as bk
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    seen = {}
    monkeypatch.setattr(bk, "create",
                        lambda name, out="", note="", live=False, emit=None:
                        seen.update(name=name, out=out, note=note, live=live)
                        or {"name": name, "path": "/x.rcbak", "bytes": 1,
                            "manifest": {}})
    r = client().post("/api/repros/rc8-5-1/backup", headers=H,
                      json={"label": "before upgrade", "live": True})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    # The endpoint answers with a job id and does the work on another thread, so
    # `seen` is filled in after the response, not before it. Reading it straight away
    # passed whenever that thread happened to win; this is the bounded poll every other
    # job test in this layer already does.
    for _ in range(400):
        if seen:
            break
        __import__("time").sleep(0.01)
    assert seen["note"] == "before upgrade" and seen["live"] is True


def test_backups_list_and_delete(monkeypatch):
    from houston.services import backup as bk
    monkeypatch.setattr(bk, "list_backups", lambda name="": [{"path": "/a.rcbak"}])
    r = client().get("/api/backups", headers=H)
    assert r.status_code == 200 and r.json()["backups"] == [{"path": "/a.rcbak"}]

    monkeypatch.setattr(bk, "delete", lambda p: {"deleted": str(p)})
    r = client().request("DELETE", "/api/backups?path=/a.rcbak", headers=H)
    assert r.status_code == 200 and r.json()["deleted"] == "/a.rcbak"


def test_compatibility_is_answerable_before_committing(monkeypatch):
    """The restore dialog enables its button from this, so a downgrade is refused
    while the user is still choosing rather than after a job has started."""
    from houston.services import backup as bk
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(bk, "read_manifest", lambda b: {"rc_version": "8.5.1"})
    monkeypatch.setattr(bk, "compatibility",
                        lambda m, meta: {"allowed": False,
                                         "blocked_reason": "downgrade"})
    # The service module itself: `web/app.py` no longer imports `runner`, and patching
    # an alias only ever worked because it resolved to this same module anyway.
    from houston import runner as runner_mod
    monkeypatch.setattr(runner_mod.record, "read_meta", lambda n: object())
    # A bundle NAME, resolved inside the managed directory -- which is what the GUI
    # sends. `/a.rcbak` used to work here and is now refused: the read side of the
    # backup API is confined the way the write side always was.
    inside = str(bk.backups_dir() / "a.rcbak")
    r = client().post("/api/backups/compatibility", headers=H,
                      json={"bundle": inside, "name": "old"})
    assert r.status_code == 200, r.text
    assert r.json()["compatibility"]["allowed"] is False

    # AN OUTSIDE PATH IS REFUSED. Unconfined, this was a filesystem oracle with three
    # distinguishable answers plus tarfile's error text for any readable .tar.gz.
    r = client().post("/api/backups/compatibility", headers=H,
                      json={"bundle": "/etc/passwd", "name": "old"})
    assert r.status_code == 400, r.text
    assert "must be inside" in r.json()["error"], r.text

    # No target named -> just the manifest, no verdict to give.
    r = client().post("/api/backups/compatibility", headers=H,
                      json={"bundle": inside})
    assert r.status_code == 200 and r.json()["compatibility"] is None


def test_the_rollback_route_confines_its_bundle_like_the_other_two(monkeypatch):
    """`_confined_backup_in` exists for exactly this and wrapped `/api/restore` and
    `/api/backups/compatibility` -- this third route was missed, so `bundle` went
    straight to `Path().expanduser()`. A member+ got the same filesystem oracle the
    helper's own docstring describes, readable back from `GET /api/jobs/{id}` at
    readonly+.
    """
    import houston.web.app as appmod

    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    r = client().post("/api/repros/x/upgrade/rollback", headers=H,
                      json={"bundle": "/etc/passwd"})
    assert r.status_code == 400, r.text
    assert "must be inside" in r.json()["error"], r.text

    # An EMPTY bundle still means "use the one recorded on the workspace", which is
    # the ordinary way to call this and must not start being refused.
    submitted: dict = {}

    def fake_submit(self, kind, fn, *a, **k):
        submitted.update(k)
        return type("J", (), {"id": "job_1"})()
    monkeypatch.setattr(appmod.JobManager, "submit", fake_submit)
    r = client().post("/api/repros/x/upgrade/rollback", headers=H, json={})
    assert r.status_code == 200, r.text
    assert submitted.get("bundle") == ""


def test_compatibility_and_restore_need_a_bundle():
    assert client().post("/api/backups/compatibility", headers=H,
                         json={}).status_code == 400
    assert client().post("/api/restore", headers=H, json={}).status_code == 400


def test_restore_is_a_job_carrying_its_flags(monkeypatch):
    from houston.services import backup as bk
    seen = {}
    monkeypatch.setattr(bk, "restore",
                        lambda bundle, name="", new=False, allow_upgrade=False,
                        force=False, emit=None:
                        seen.update(bundle=bundle, name=name, new=new,
                                    allow_upgrade=allow_upgrade, force=force) or {})
    inside = str(bk.backups_dir() / "a.rcbak")
    r = client().post("/api/restore", headers=H,
                      json={"bundle": inside, "new": True, "allow_upgrade": True})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    # The endpoint answers with a job id and does the work on another thread, so
    # `seen` is filled in after the response, not before it. Reading it straight away
    # passed whenever that thread happened to win; this is the bounded poll every other
    # job test in this layer already does.
    for _ in range(400):
        if seen:
            break
        __import__("time").sleep(0.01)
    assert seen["new"] is True and seen["allow_upgrade"] is True

    # And a path outside the managed directory is refused rather than read.
    r = client().post("/api/restore", headers=H,
                      json={"bundle": "/etc/hosts"})
    assert r.status_code == 400, r.text


def test_upgrade_gate_is_a_server_decision(monkeypatch):
    """A stopped workspace reports can_upgrade=false with the reason, so the GUI
    can hide the action instead of offering one that would fail."""
    from houston.services import upgrade as upsvc
    monkeypatch.setattr(upsvc, "can_upgrade",
                        lambda n: {"can_upgrade": False, "reason": "'x' is exited",
                                   "current": ""})
    r = client().get("/api/repros/x/upgrade", headers=H)
    assert r.status_code == 200
    assert r.json()["can_upgrade"] is False and "exited" in r.json()["reason"]
    assert "plan" not in r.json()


def test_upgrade_plan_is_only_resolved_for_a_running_repro(monkeypatch):
    from houston.services import upgrade as upsvc
    monkeypatch.setattr(upsvc, "can_upgrade",
                        lambda n: {"can_upgrade": True, "reason": "", "current": "8.5.1"})
    monkeypatch.setattr(upsvc, "plan",
                        lambda n, to, offline=False: {"to_version": to, "allowed": True})
    r = client().get("/api/repros/x/upgrade?to=8.6.1", headers=H)
    assert r.status_code == 200 and r.json()["plan"]["to_version"] == "8.6.1"


def test_upgrade_post_requires_a_target_version(monkeypatch):
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    assert client().post("/api/repros/x/upgrade", headers=H,
                         json={}).status_code == 400


def test_upgrade_and_rollback_are_jobs(monkeypatch):
    from houston.services import upgrade as upsvc
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    seen = {}
    monkeypatch.setattr(upsvc, "run",
                        lambda name, to, offline=False, force=False, no_backup=False,
                        rollback_on_failure=True, emit=None:
                        seen.update(to=to, no_backup=no_backup) or {})
    r = client().post("/api/repros/x/upgrade", headers=H, json={"to": "8.6.1"})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    # The endpoint answers with a job id and does the work on another thread, so
    # `seen` is filled in after the response, not before it. Reading it straight away
    # passed whenever that thread happened to win; this is the bounded poll every other
    # job test in this layer already does.
    for _ in range(400):
        if seen:
            break
        __import__("time").sleep(0.01)
    assert seen["to"] == "8.6.1" and seen["no_backup"] is False

    monkeypatch.setattr(upsvc, "rollback", lambda name, bundle="", emit=None: {})
    r = client().post("/api/repros/x/upgrade/rollback", headers=H, json={})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")


def test_backup_endpoints_need_a_session():
    assert client(sign_in=False).post("/api/repros/x/backup", json={}).status_code == 401
    assert client(sign_in=False).get("/api/backups").status_code == 401
    assert client(sign_in=False).post("/api/restore", json={"bundle": "/a"}).status_code == 401
    assert client(sign_in=False).get("/api/repros/x/upgrade").status_code == 401


# --- backup `out` is confined over HTTP (F9) ------------------------------------

def test_a_backup_cannot_be_written_outside_the_managed_directory(basic_client, monkeypatch):
    """`out` chose a path on the SERVER. Unconfined it wrote a tar.gz anywhere the
    server user could -- a systemd drop-in, a webroot -- and with a forged
    cross-site request the attacker chose the path too."""
    creds = _auth("alice", "correct-horse-battery")
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n, actor="": n)
    for bad in ("/etc/cron.d/pwn", "../../../../tmp/pwn.tar.gz", "~/../../tmp/x"):
        r = basic_client.post("/api/repros/x/backup",
                              headers={**creds, "Host": "localhost"},
                              json={"out": bad})
        assert r.status_code == 400, f"{bad} -> {r.status_code}"
        assert "must be inside" in r.json()["error"]


def test_a_backup_inside_the_managed_directory_is_allowed(basic_client, monkeypatch, tmp_path):
    from houston.services import backup as backupsvc

    creds = _auth("alice", "correct-horse-battery")
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n, actor="": n)
    seen = {}
    monkeypatch.setattr(backupsvc, "create",
                        lambda t, out="", note="", live=False, emit=None:
                        seen.update(out=out) or {"ok": True})
    dest = backupsvc.backups_dir() / "mine.tar.gz"
    r = basic_client.post("/api/repros/x/backup", headers={**creds, "Host": "localhost"},
                          json={"out": str(dest)})
    assert r.status_code == 200, r.text
    assert seen["out"] == str(dest.resolve())
