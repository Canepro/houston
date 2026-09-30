"""`houston.services.lifecycle.payload`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston.services import lifecycle as lc


def test_env_rows_mark_which_keys_the_user_set():
    """The panel offers "remove" on every row, and it means different things.

    Removing an override restores the preset default; removing an inherited key
    deletes it from the workspace. The panel can only say which if detail() marks
    them.
    """
    from houston.services import lifecycle as lc
    doc = {"services": {"rocketchat": {"environment": {
        "MY_VAR": "v", "ADMIN_PASS": "secret", "PORT": "3000"}}}}
    rows = {r["key"]: r for r in lc._env_rows(doc, {"MY_VAR": "v"})}
    assert rows["MY_VAR"]["override"] is True
    assert rows["PORT"]["override"] is False
    assert rows["ADMIN_PASS"]["value"] == "********", "credentials still masked"
    # No overrides argument -> nothing marked, and the shape is unchanged.
    assert all(r["override"] is False for r in lc._env_rows(doc))
    # compose's list form is handled too.
    listform = {"services": {"rocketchat": {"environment": ["A=1", "B=2"]}}}
    assert [r["key"] for r in lc._env_rows(listform, {"A": "1"})] == ["A", "B"]
    assert lc._env_rows(listform, {"A": "1"})[0]["override"] is True


def test_list_and_detail_agree_on_a_crash_looping_repro(monkeypatch, tmp_path):
    """The same repro, through both code paths, must report the same state."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = lc.runner.Metadata(name="r", project="houston-r", rc_version="8.5.1",
                           rc_image="img", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="test")
    crash = "Restarting (1) 5 seconds ago"
    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **_k: True)
    monkeypatch.setattr(lc.runner.paths, "exists", lambda _n: True)
    monkeypatch.setattr(lc.runner.record, "list_meta", lambda: [meta])
    monkeypatch.setattr(lc.runner.record, "read_meta", lambda _n: meta)
    monkeypatch.setattr(lc.runner.record, "read_compose", lambda _n: {})
    monkeypatch.setattr(lc.runner.queries, "rc_restart_count", lambda _n: 7)
    # What each path actually asks docker: the project aggregate names Mongo as
    # running, which is precisely what used to mislead the list.
    monkeypatch.setattr(lc.runner.queries, "project_states",
                        lambda: {"houston-r": "restarting(1), running(1)"})
    monkeypatch.setattr(lc.runner.queries, "rc_status_by_project", lambda: {"houston-r": crash})
    monkeypatch.setattr(lc.runner.queries, "container_details", lambda _n: [
        {"service": "rocketchat", "state": "restarting", "status": crash, "health": ""},
        {"service": "mongo", "state": "running", "status": "Up 2 hours", "health": ""}])

    listed = lc.list_repros()[0]
    detailed = lc.detail("r")
    assert listed["state"] == detailed["state"] == "restarting"
    assert detailed["restarts"] == 7      # the crash loop is now visible


def test_detail_says_whether_this_repro_is_the_default(monkeypatch, tmp_path):
    """The panel offers "Make default" only when it would change something.

    list_repros() has always carried `default`; detail() did not, so the panel
    had to either hide the action or show it on the repro that already is one.
    """
    from houston import config, runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner.host, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner.record, "read_meta", lambda n: lc.runner.Metadata(
        name=n, project=f"houston-{n}", rc_version="8.5.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map"))
    monkeypatch.setattr(runner.record, "read_compose", lambda n: {"services": {"rocketchat": {}}})

    assert lc.detail("a")["is_default"] is False       # nothing pinned yet
    config.update_config(lambda cfg: cfg.__setitem__("default_repro", "a"))
    assert lc.detail("a")["is_default"] is True
    assert lc.detail("b")["is_default"] is False


def test_detail_recovers_the_bind_host_of_a_workspace_older_than_the_key(
        monkeypatch, tmp_path):
    """The bind host was only ever written INTO the compose port mappings, so the
    panel could not say anything true about reaching a workspace from another
    machine. New workspaces record it; existing ones are read back out of the file
    they already have, rather than being told "unknown"."""
    import json as _json
    from dataclasses import asdict

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="old", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="http://localhost:3001", host_port=3001,
                           version_source="t")
    ws = lc.runner.workspace("old")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    (ws / "docker-compose.yml").write_text(
        "services:\n  rocketchat:\n    image: i\n    ports:\n"
        "    - 0.0.0.0:3001:3000\n    environment:\n      ROOT_URL: x\n")
    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **_k: False)

    assert lc.detail("old")["bind_host"] == "0.0.0.0"
