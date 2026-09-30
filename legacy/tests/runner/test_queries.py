"""`houston.runner.queries`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations


def test_a_readiness_failure_asks_diagnose_instead_of_asserting_memory_pressure(
        monkeypatch, tmp_path):
    """`diagnose` holds the signature list and the readiness path never called it.

    Its only caller was the `docker compose up` non-zero branch. So a workspace that
    came up and then failed to serve -- the commonest real shape -- got a hardcoded
    sentence instead. Measured: `env --set MONGO_URL=mongodb://nope:27017/...`, the
    product's own feature, then `ready` -> exit 5 after 303s saying "Rocket.Chat
    restarted 10x; likely resource pressure (free repros / raise Docker CPU+RAM)" on a
    box with 5.7 GB free, while RC's own logs said "Topology is closed" and
    diagnose.match() on those exact logs returned the right answer.

    Two things are asserted: the diagnosis is PREFERRED, and the resource-pressure
    sentence survives only as a possibility and only when nothing matched -- stated as
    fact it sends a reader hunting for memory they already have.
    """
    from houston import rcapi, runner
    from houston.errors import NotReadyError
    from houston.services import diagnose
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = lc.runner.Metadata(
        name="slow", project="houston-slow", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map")
    monkeypatch.setattr(runner.queries, "rc_state", lambda n: "running")
    monkeypatch.setattr(runner.queries, "rc_restart_count", lambda n: 0)
    # raising=False: this test is about the MESSAGE, and must fail against the
    # pre-fix tree for that reason rather than on a missing attribute name.
    monkeypatch.setattr(runner.queries, "services_by_project", lambda: {}, raising=False)

    def timeout(*a, **k):
        raise rcapi.NotReady("Rocket.Chat did not become ready within 300s")
    monkeypatch.setattr(rcapi, "wait_ready", timeout)

    # 1. A KNOWN cause is preferred and the guess is nowhere in the message.
    monkeypatch.setattr(diagnose, "diagnose_failure",
                        lambda n: "MongoDB is up but its replica set never initialised")
    try:
        lc.wait_serving(meta, lambda ev: None, 1.0)
    except NotReadyError as exc:
        assert "replica set never initialised" in str(exc), str(exc)
        assert "resource pressure" not in str(exc).lower(), str(exc)
        assert "raise Docker" not in str(exc), str(exc)
    else:
        raise AssertionError("wait_serving did not raise")

    # 2. Nothing matched and no restarts: no invented cause at all.
    monkeypatch.setattr(diagnose, "diagnose_failure", lambda n: None)
    try:
        lc.wait_serving(meta, lambda ev: None, 1.0)
    except NotReadyError as exc:
        assert "did not become ready" in str(exc), str(exc)
        assert "resource pressure" not in str(exc).lower(), str(exc)
    else:
        raise AssertionError("wait_serving did not raise")


def test_a_crash_loop_stops_waiting_once_the_cause_is_known(monkeypatch, tmp_path):
    """`ready` spent the full 300s polling through a visible crash loop.

    `is_alive()` returns True for "restarting", so a crash-looping container is
    intermittently alive and the fail-fast callback never fired; `tick` counted the
    restarts, warned, and nothing acted on the count.

    Giving up on the COUNT alone would be wrong -- v0.71.1 is the whole lesson: a boot
    that restarts twice and settles is ordinary, and a banner that is always on is one
    nobody reads. A matched log signature is different: that is evidence, so this stops
    on evidence and keeps waiting without it.
    """
    from houston import rcapi, runner
    from houston.errors import NotReadyError
    from houston.services import diagnose
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = lc.runner.Metadata(
        name="loop", project="houston-loop", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map")
    monkeypatch.setattr(runner.queries, "rc_state", lambda n: "restarting")
    monkeypatch.setattr(runner.queries, "rc_restart_count", lambda n: 3)
    # raising=False: this test is about the MESSAGE, and must fail against the
    # pre-fix tree for that reason rather than on a missing attribute name.
    monkeypatch.setattr(runner.queries, "services_by_project", lambda: {}, raising=False)

    ticks = {"n": 0}

    def never_ready(root_url, timeout=300.0, is_alive=None, on_tick=None, **k):
        # Two ticks is a fraction of the 100 the real 300s wait would spend.
        for i in range(2):
            ticks["n"] += 1
            on_tick(float(i))
        raise rcapi.NotReady("Rocket.Chat did not become ready within 300s")
    monkeypatch.setattr(rcapi, "wait_ready", never_ready)

    monkeypatch.setattr(diagnose, "diagnose_failure",
                        lambda n: "MongoDB refused the connection")
    try:
        lc.wait_serving(meta, lambda ev: None, 300.0)
    except NotReadyError as exc:
        assert "MongoDB refused the connection" in str(exc), str(exc)
    else:
        raise AssertionError("wait_serving did not raise")
    assert ticks["n"] == 1, (
        f"kept polling for {ticks['n']} ticks after the cause was known")

    # And WITHOUT a known cause it keeps waiting, rather than aborting on a count.
    ticks["n"] = 0
    monkeypatch.setattr(diagnose, "diagnose_failure", lambda n: None)
    try:
        lc.wait_serving(meta, lambda ev: None, 300.0)
    except NotReadyError:
        pass
    assert ticks["n"] == 2, f"gave up after {ticks['n']} ticks with no evidence"


def test_env_reports_what_the_container_is_running_not_what_it_was_asked_to_run(
        monkeypatch, tmp_path):
    """The question this command exists to answer is "is this setting actually set?".

    OBSERVED: an `env` apply interrupted mid-recreate (a SIGPIPE from a truncating pipe
    is an ordinary way for that to happen) left
    `OVERWRITE_SETTING_Accounts_RegistrationForm=Disabled` in the compose file and in
    `repro.json`, and absent from the container. `houston env` then displayed it as
    `<- yours` while Rocket.Chat served the old value — a confirming display for a
    setting that was not in effect. Neither `start`, `restart` nor a re-run `up`
    reconverged it.

    The Kubernetes branch of `current()` already read the running container and its
    comment says why: "strictly more accurate". Compose could answer from the document
    it generated, so it did.
    """
    from houston import runner
    from houston.services import envvars, lifecycle as lcmod, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lcmod.naming, "resolve_name", lambda n: "drift")
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.DOCKER)
    meta = type("M", (), {"extra": {"env": {"OVERWRITE_SETTING_Accounts_RegistrationForm":
                                            "Disabled"}}})()
    monkeypatch.setattr(runner.record, "read_meta", lambda n: meta)
    monkeypatch.setattr(runner.record, "read_compose", lambda n: {"services": {"rocketchat": {
        "environment": {"OVERWRITE_SETTING_Accounts_RegistrationForm": "Disabled",
                        "ROOT_URL": "http://localhost:3000"}}}})

    # The container never got the variable.
    monkeypatch.setattr(runner.queries, "rc_container_env",
                        lambda n: {"ROOT_URL": "http://localhost:3000"})
    out = envvars.current("drift")
    assert out["drift"] == ["OVERWRITE_SETTING_Accounts_RegistrationForm"]
    assert out["live_read"] is True
    row = next(e for e in out["env"] if e["key"].startswith("OVERWRITE_"))
    assert row["drift"] is True and row["live"] == ""
    assert not [e for e in out["env"] if e["key"] == "ROOT_URL" and e.get("drift")], \
        "a value that matches must not be marked"

    # A DIFFERENT value is drift too, not only a missing one.
    monkeypatch.setattr(runner.queries, "rc_container_env", lambda n: {
        "OVERWRITE_SETTING_Accounts_RegistrationForm": "Public",
        "ROOT_URL": "http://localhost:3000"})
    row = next(e for e in envvars.current("drift")["env"]
               if e["key"].startswith("OVERWRITE_"))
    assert row["drift"] is True and row["live"] == "Public", \
        "the reader has to see what it is actually running, not only that it differs"

    # AND A CONTAINER THAT COULD NOT BE READ IS NOT UNIVERSAL DRIFT. `None` means the
    # question could not be asked -- the module's rule -- so nothing is claimed, and
    # `live_read` says so rather than the report looking clean.
    monkeypatch.setattr(runner.queries, "rc_container_env", lambda n: None)
    quiet = envvars.current("drift")
    assert quiet["drift"] == [] and quiet["live_read"] is False
    assert not any(e.get("drift") for e in quiet["env"])


# --- docker query memo (F17) ----------------------------------------------------
# Each open tab polls /api/repros every 4s: `docker compose ls` + `docker ps` +
# `docker info`. Ten teammates with a tab open is ~40 process spawns every four
# seconds on the shared box.

def test_repeated_dashboard_polls_do_not_respawn_docker(monkeypatch):
    from houston import runner

    runner.invalidate_docker_queries()
    calls = []
    monkeypatch.setattr(runner.queries, "_compose_ls", lambda: calls.append(1) or [])
    for _ in range(10):
        runner.project_states()
    assert len(calls) == 1, f"{len(calls)} docker calls for 10 polls"


def test_a_state_change_is_never_served_from_the_memo(monkeypatch):
    """A dashboard still showing "running" two seconds after a Stop is a cache the
    user can notice -- worse than the spawns it saves."""
    from houston import runner

    runner.invalidate_docker_queries()
    state = {"status": "running(1)"}
    monkeypatch.setattr(runner.queries, "_compose_ls",
                        lambda: [{"Name": "houston-x", "Status": state["status"]}])
    assert runner.project_states()["houston-x"] == "running(1)"

    # Stop it: the compose call is faked, but the invalidation is the real one.
    monkeypatch.setattr(runner.docker, "compose", lambda name, *a, **k: type("P", (), {"returncode": 0})())
    state["status"] = "exited(1)"
    runner.stop("x")
    assert runner.project_states()["houston-x"] == "exited(1)", "stale after a stop"
