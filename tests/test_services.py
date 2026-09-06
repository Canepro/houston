"""Unit tests for the service layer (pure; no Docker).

These lock in the behaviour both the CLI and the web API depend on: naming,
error typing/HTTP mapping, port validation, and the event model.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from conftest import source_index, source_of

from houston import errors
from houston.services import events
from houston.services import lifecycle as lc


def test_error_http_status_mapping():
    assert errors.ValidationError.http_status == 400
    assert errors.ConflictError.http_status == 409
    assert errors.NotFoundError.http_status == 404
    assert errors.NotReadyError.http_status == 409
    assert errors.DockerError.http_status == 502
    assert issubclass(errors.ValidationError, errors.ReproError)


def test_sanitize_and_derive():
    assert lc.sanitize("RC 8.5.1!!") == "rc-8-5-1"
    assert lc.derive_name("8.5.1", "default") == "rc8-5-1"
    assert lc.derive_name("8.5.1", "ldap") == "rc8-5-1-ldap"
    assert lc.sanitize("...") == ""      # no usable chars -> empty (caller rejects)


def test_repro_state_from_rc_container_status():
    # "no rocketchat container" splits on whether anything else survives.
    assert lc.repro_state("", False) == "down"
    assert lc.repro_state("", True) == "stopped"
    assert lc.repro_state("Up 2 hours (healthy)", True) == "running"
    assert lc.repro_state("Up 5 seconds (health: starting)", True) == "running"
    assert lc.repro_state("Exited (0) 2 minutes ago", True) == "stopped"
    assert lc.repro_state("Created", True) == "created"
    assert lc.repro_state("Dead", True) == "dead"
    # docker reports a paused container as "Up …(Paused)" -- it must not read as running.
    assert lc.repro_state("Up 3 days (Paused)", True) == "paused"
    # The regression: a crash-looping RC. The list used to read compose's project
    # aggregate, where the healthy Mongo's "running(1)" made this "running", while
    # detail() called it "stopped". Both had to become "restarting".
    assert lc.repro_state("Restarting (1) 5 seconds ago", True) == "restarting"


def test_list_and_detail_agree_on_a_crash_looping_repro(monkeypatch, tmp_path):
    """The same repro, through both code paths, must report the same state."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = lc.runner.Metadata(name="r", project="houston-r", rc_version="8.5.1",
                           rc_image="img", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="test")
    crash = "Restarting (1) 5 seconds ago"
    monkeypatch.setattr(lc.runner, "docker_available", lambda **_k: True)
    monkeypatch.setattr(lc.runner, "exists", lambda _n: True)
    monkeypatch.setattr(lc.runner, "list_meta", lambda: [meta])
    monkeypatch.setattr(lc.runner, "read_meta", lambda _n: meta)
    monkeypatch.setattr(lc.runner, "read_compose", lambda _n: {})
    monkeypatch.setattr(lc.runner, "rc_restart_count", lambda _n: 7)
    # What each path actually asks docker: the project aggregate names Mongo as
    # running, which is precisely what used to mislead the list.
    monkeypatch.setattr(lc.runner, "project_states",
                        lambda: {"houston-r": "restarting(1), running(1)"})
    monkeypatch.setattr(lc.runner, "rc_status_by_project", lambda: {"houston-r": crash})
    monkeypatch.setattr(lc.runner, "container_details", lambda _n: [
        {"service": "rocketchat", "state": "restarting", "status": crash, "health": ""},
        {"service": "mongo", "state": "running", "status": "Up 2 hours", "health": ""}])

    listed = lc.list_repros()[0]
    detailed = lc.detail("r")
    assert listed["state"] == detailed["state"] == "restarting"
    assert detailed["restarts"] == 7      # the crash loop is now visible


def test_createreq_defaults():
    r = lc.CreateReq(version="8.5.1")
    assert r.preset == "default" and r.seed is False and r.params == {}
    # dataclass default_factory gives a fresh dict per instance
    lc.CreateReq(version="8.5.1").params["x"] = 1
    assert lc.CreateReq(version="8.5.1").params == {}


def test_require_docker_raises_when_down(monkeypatch):
    """An absent engine is a PREFLIGHT failure, not a "still coming up" one.

    It used to raise NotReadyError, which is exit 5 / HTTP 409 and means "poll
    again" -- advice that can never succeed, because polling does not start
    Docker. The caller has to fix their environment, so ENGINE_UNAVAILABLE:
    exit 3, HTTP 502, the dependency underneath is not there.

    Asserted on all three faces of the taxonomy, because each one is consumed by
    a different front-end and they have drifted apart before.
    """
    monkeypatch.setattr(lc.runner, "docker_available", lambda **_k: False)
    with pytest.raises(errors.DockerError) as caught:
        lc.require_docker()
    assert caught.value.code == "ENGINE_UNAVAILABLE"
    assert caught.value.exit_code == 3          # CLI: fix it, do not retry
    assert caught.value.http_status == 502      # web: upstream dependency is down
    # And specifically NOT the "poll again" answer it used to give.
    assert not isinstance(caught.value, errors.NotReadyError)
    assert errors.NotReadyError.exit_code == 5


def test_resolve_name_errors(monkeypatch):
    monkeypatch.setattr(lc.runner, "exists", lambda n: False)
    with pytest.raises(errors.NotFoundError):
        lc.resolve_name("ghost")
    monkeypatch.setattr(lc.config, "load_config", lambda *a, **k: {})
    with pytest.raises(errors.ValidationError):
        lc.resolve_name("")      # no name, no default


def test_pick_host_port_conflict(monkeypatch):
    class P:  # minimal preset stand-in
        instances = 1
    monkeypatch.setattr(lc, "own_ports", lambda name: set())
    monkeypatch.setattr(lc.runner, "used_ports", lambda: {8300})
    with pytest.raises(errors.ConflictError):
        lc.pick_host_port(8300, P(), exclude="")     # claimed by another repro


def test_pick_host_port_out_of_range(monkeypatch):
    class P:
        instances = 3      # needs a 4-port block
    with pytest.raises(errors.ValidationError):
        lc.pick_host_port(65535, P(), exclude="")    # block runs past 65535


def test_project_collision_guard(monkeypatch, tmp_path):
    # our workspace's compose path (what a same-home recreate would show)
    ours = str(tmp_path / "houston" / "repros" / "rc8-5-1" / "docker-compose.yml")
    monkeypatch.setattr(lc.runner, "project_name", lambda n: "houston-" + n)
    monkeypatch.setattr(lc.runner, "workspace",
                        lambda n: tmp_path / "houston" / "repros" / n)

    # foreign project with our derived name -> refuse
    monkeypatch.setattr(lc.runner, "project_config_files",
                        lambda: {"houston-rc8-5-1": "/Users/real/.houston/repros/rc8-5-1/docker-compose.yml"})
    with pytest.raises(errors.ConflictError):
        lc._guard_project_collision("rc8-5-1")

    # same project owned by OUR workspace (a --force recreate) -> allowed
    monkeypatch.setattr(lc.runner, "project_config_files",
                        lambda: {"houston-rc8-5-1": ours})
    lc._guard_project_collision("rc8-5-1")   # no raise

    # docker unavailable / no such project -> skip (best-effort)
    monkeypatch.setattr(lc.runner, "project_config_files", lambda: None)
    lc._guard_project_collision("rc8-5-1")
    monkeypatch.setattr(lc.runner, "project_config_files", lambda: {})
    lc._guard_project_collision("rc8-5-1")


def test_data_scale_ok_error_mapping():
    from houston.services import data
    # non-zero exit / no JSON -> DockerError (infra); {error} payload -> ValidationError (user)
    with pytest.raises(errors.DockerError):
        data._scale_ok(1, "boom", "user prefill")
    with pytest.raises(errors.DockerError):
        data._scale_ok(0, "no json here", "user prefill")
    with pytest.raises(errors.ValidationError):
        data._scale_ok(0, '{"error": "room not found"}', "message prefill", hint="make it first")
    assert data._scale_ok(0, '{"inserted": 500}', "user prefill") == {"inserted": 500}


def test_data_run_scale_validates(monkeypatch):
    from houston.services import data
    monkeypatch.setattr(data.lifecycle, "resolve_name", lambda n: n)
    with pytest.raises(errors.ValidationError):
        data.run_scale("x", "garbage-spec")          # parse_scale rejects
    with pytest.raises(errors.ValidationError):
        data.run_scale("x", "")                       # nothing to do


def test_data_import_plan(monkeypatch, tmp_path):
    from houston.services import data
    monkeypatch.setattr(data.lifecycle, "resolve_name", lambda n: n)
    dump = tmp_path / "s.json"
    dump.write_text(json.dumps([
        {"_id": "A", "value": "new", "packageValue": "old"},          # apply
        {"_id": "Site_Url", "value": "https://c", "packageValue": ""},  # denied
        {"_id": "SMTP_Password", "value": "XXXXXXXX", "packageValue": ""},  # redacted
    ]))
    plan = data.import_plan("x", str(dump))
    assert plan["counts"] == {"apply": 1, "redacted": 1, "denied": 1}
    assert plan["apply"][0]["id"] == "A"


def test_perf_run_loadtest_validates(monkeypatch):
    from houston.services import perf
    monkeypatch.setattr(perf.lifecycle.runner, "docker_available", lambda **_k: True)
    with pytest.raises(errors.ValidationError):
        perf.run_loadtest(perf.LoadtestReq(name="x", scenario="webhook"))  # not a GUI scenario
    with pytest.raises(errors.ValidationError):
        perf.run_loadtest(perf.LoadtestReq(name="x", scenario="messages", vus=0))


def test_repro_links():
    from houston import runner
    def meta(preset, extra=None):
        return runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                               mongo_tag="8.0", mongo_flavor="official", preset=preset,
                               root_url="http://localhost:8300", host_port=8300,
                               version_source="x", extra=extra or {})
    # s3_minio -> console + api URLs surfaced
    s3 = {l["label"]: l["url"] for l in lc.repro_links(meta("s3_minio"))}
    assert s3["Rocket.Chat"] == "http://localhost:8300"
    assert "MinIO console" in s3 and "MinIO API" in s3
    # oidc -> keycloak
    oidc = {l["label"]: l["url"] for l in lc.repro_links(meta("oidc"))}
    assert "Keycloak" in oidc and oidc["Keycloak"].startswith("http://localhost:")
    # monitoring adds Grafana + Prometheus
    mon = {l["label"] for l in lc.repro_links(meta("default", {"monitoring": True}))}
    assert {"Grafana", "Prometheus"} <= mon
    # multi-instance adds instance URLs
    mi = {l["label"] for l in lc.repro_links(meta("multi-instance", {"instances": 3}))}
    assert {"instance 1", "instance 2", "instance 3"} <= mi


def test_perf_capacity_benchmark_validate(monkeypatch):
    from houston.services import perf
    monkeypatch.setattr(perf.lifecycle.runner, "docker_available", lambda **_k: True)
    with pytest.raises(errors.ValidationError):
        perf.run_capacity(perf.CapacityReq(name="x", scenario="webhook"))
    with pytest.raises(errors.ValidationError):
        perf.run_capacity(perf.CapacityReq(name="x", scenario="journey", start=0))
    with pytest.raises(errors.ValidationError):
        perf.run_benchmark(["8.5.1"])          # needs >= 2 versions


def test_rc_restart_count(monkeypatch):
    import types
    from houston import runner
    monkeypatch.setattr(runner, "service_container_ids", lambda n, s: ["abc"] if s == "rocketchat" else [])
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: types.SimpleNamespace(stdout="7\n", returncode=0))
    assert runner.rc_restart_count("x") == 7
    monkeypatch.setattr(runner, "service_container_ids", lambda n, s: [])
    assert runner.rc_restart_count("x") == 0   # no container -> 0, no crash


def test_docker_queries_behind_the_gui_poll_cannot_hang_or_raise(monkeypatch):
    """A wedged daemon must degrade, not park a threadpool worker forever.

    docker_available() (timeout=10) can pass and the NEXT call still hang: these
    three run on the dashboard's 4s poll, so an unbounded one is a worker leak
    that ends with the server answering nothing. Each already has a documented
    "couldn't ask docker" value -- they just have to reach it.
    """
    import subprocess

    from houston import runner

    # `project_states` memoises for _QUERY_TTL, so this test only sees the stubbed
    # failure if the cache is cold -- and it is only cold by luck of test ORDER.
    # Any earlier test that reaches a real docker (the `--json` contract tests run
    # `list` and `doctor` for real, a file earlier in the alphabet) leaves a warm
    # entry, and this passed on the cached answer instead of the one under test.
    runner._query_cache.clear()

    for exc in (subprocess.TimeoutExpired(cmd="docker", timeout=30),
                FileNotFoundError("docker"),
                OSError("no fork")):
        def boom(*a, **k):
            raise exc

        monkeypatch.setattr(runner.subprocess, "run", boom)
        assert runner._compose_ls() is None                  # None = "couldn't ask"
        assert runner.project_states() is None               # prune refuses on None
        assert runner.rc_status_by_project() == {}
        monkeypatch.setattr(runner, "service_container_ids", lambda n, s: ["abc"])
        assert runner.rc_restart_count("x") == 0

    # And every one of them passes a timeout, so the hang cannot happen at all.
    calls = []
    monkeypatch.setattr(runner.subprocess, "run",
                        lambda *a, **k: calls.append(k.get("timeout")) or
                        __import__("types").SimpleNamespace(stdout="", returncode=1))
    runner._compose_ls(); runner.rc_status_by_project(); runner.rc_restart_count("x")
    assert calls and all(t is not None for t in calls), f"unbounded docker call: {calls}"


def test_kernel_major_minor_parsing():
    from houston.services import doctor as doctorsvc
    assert doctorsvc._kernel_major_minor("6.19.7-200.fc43.aarch64") == (6, 19)
    assert doctorsvc._kernel_major_minor("5.15.0-generic") == (5, 15)
    assert doctorsvc._kernel_major_minor("6.19") == (6, 19)
    assert doctorsvc._kernel_major_minor(None) is None
    assert doctorsvc._kernel_major_minor("not-a-kernel") is None


def test_hub_logged_in(monkeypatch, tmp_path):
    from houston import runner
    # no auth files readable anywhere -> can't tell (None)
    monkeypatch.delenv("REGISTRY_AUTH_FILE", raising=False)
    monkeypatch.delenv("DOCKER_CONFIG", raising=False)
    monkeypatch.setattr(runner.Path, "home", staticmethod(lambda: tmp_path / "nohome"))
    assert runner.hub_logged_in() is None

    # a config with a Hub auth entry -> True
    cfg = tmp_path / "config.json"
    cfg.write_text('{"auths": {"https://index.docker.io/v1/": {"auth": "x"}}}')
    monkeypatch.setenv("REGISTRY_AUTH_FILE", str(cfg))
    assert runner.hub_logged_in() is True

    # a readable config with only a non-Hub registry -> False
    cfg.write_text('{"auths": {"ghcr.io": {"auth": "x"}}}')
    assert runner.hub_logged_in() is False


def test_uptime_health_parsing():
    assert lc._uptime_health("Up 2 hours (healthy)") == ("2 hours", "healthy")
    assert lc._uptime_health("Up 47 minutes") == ("47 minutes", "")
    assert lc._uptime_health("Exited (0) 5 minutes ago") == ("", "")
    assert lc._uptime_health("") == ("", "")


def test_event_model_and_emit():
    seen: list[events.Event] = []
    events.info(seen.append, "hello", phase="boot", pct=50, name="x")
    events.warn(seen.append, "careful", phase="wait")
    assert seen[0].phase == "boot" and seen[0].pct == 50 and seen[0].data == {"name": "x"}
    assert seen[1].level == "warn"
    d = seen[0].as_dict()
    assert d["message"] == "hello" and d["terminal"] is False


# --- job manager (web/jobs.py; no fastapi needed) ----------------------------

def _await_finish(job, tries: int = 400) -> None:
    import time
    for _ in range(tries):
        if job.status != "running":
            return
        time.sleep(0.01)
    raise AssertionError(f"job {job.id} never finished")


def test_job_events_are_capped_with_absolute_indices():
    from houston.web import jobs as J
    job = J.Job(id="job_x", kind="t")
    for i in range(J.MAX_EVENTS_PER_JOB + 50):
        job.emit(events.Event(f"e{i}"))
    # `serve` is long-lived and every streamed docker line is an Event, so the
    # per-job buffer is bounded -- but the index the SSE stream hands out stays
    # absolute, so a reader cannot desync by counting.
    assert len(job.events) == J.MAX_EVENTS_PER_JOB
    assert job.n_events == J.MAX_EVENTS_PER_JOB + 50
    evs, done, nxt = job.snapshot(0)
    assert len(evs) == J.MAX_EVENTS_PER_JOB and nxt == job.n_events
    assert job.snapshot(nxt) == ([], done, nxt)      # nothing new after catching up


def test_job_registry_evicts_finished_jobs_only():
    from houston.web import jobs as J
    mgr = J.JobManager()
    for i in range(J.MAX_JOBS + 20):
        mgr._jobs[f"job_{i}"] = J.Job(id=f"job_{i}", kind="t", status="done")
    mgr._jobs["job_live"] = J.Job(id="job_live", kind="t", status="running")
    mgr._evict_locked()
    assert len(mgr._jobs) <= J.MAX_JOBS
    assert mgr.get("job_live") is not None    # a running job is never evicted
    assert mgr.get("job_0") is None           # the oldest finished ones go first


def test_job_status_is_set_before_the_terminal_event(monkeypatch):
    from houston.web import jobs as J
    captured = []
    original = J.Job.emit

    def spy(self, ev):
        captured.append((ev.terminal, self.status, self.result))
        original(self, ev)

    monkeypatch.setattr(J.Job, "emit", spy)
    job = J.JobManager().submit("t", lambda emit: "R")
    _await_finish(job)
    terminal = [c for c in captured if c[0]]
    # A client that polls /api/jobs/<id> on seeing `terminal` used to read
    # status="running" with result=None, because the event came first.
    assert terminal and terminal[-1] == (True, "done", "R")


def test_job_internal_error_does_not_leak_a_traceback():
    from houston.web import jobs as J
    job = J.JobManager().submit("t", lambda emit: 1 / 0)
    _await_finish(job)
    assert job.status == "error" and job.error_kind == "InternalError"
    evs, _done, _n = job.snapshot(0)
    # The traceback goes to the server's stderr; it must not ride the SSE payload
    # into a browser, which renders whatever it is handed.
    assert evs and all("trace" not in (e.get("data") or {}) for e in evs)


def test_job_reproerror_keeps_its_kind_on_the_wire():
    from houston.web import jobs as J

    def boom(emit):
        raise errors.NotFoundError("no such repro")

    job = J.JobManager().submit("t", boom)
    _await_finish(job)
    assert job.status == "error" and job.error_kind == "NotFoundError"
    evs, _done, _n = job.snapshot(0)
    assert evs[-1]["data"]["kind"] == "NotFoundError"


def test_set_state_explains_a_downed_repro(monkeypatch):
    monkeypatch.setattr(lc, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner, "start", lambda n: 1)
    monkeypatch.setattr(lc.runner, "rc_state", lambda n: "absent")
    with pytest.raises(errors.DockerError) as exc:
        lc.set_state("x", "start")
    # `compose start` cannot revive a repro with no containers -- say what does.
    assert "no containers to start" in str(exc.value)


def test_summary_carries_preset_notes_derived_and_not_the_frozen_copy():
    """These are what the GUI renders from the create job's result and the CLI prints
    after `up` -- the Keycloak realm, the /etc/hosts line.

    DERIVED from the preset on every read, not read back out of the record. A note
    written into `repro.json` at create time keeps its wording for the life of the
    workspace, which is how a Kubernetes workspace went on telling people `backup`
    had no path on that runtime for three releases after it grew one -- the fix
    reached new workspaces and no existing one. So the stale copy in this record is
    deliberately not what the preset says, and it is the preset's that has to come
    out.
    """
    from houston import presets

    m = lc.runner.Metadata(
        name="x", project="houston-x", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="oidc",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        extra={"notes": ["a sentence some older release wrote down"]})
    s = lc._summary(m)
    assert s["notes"] == lc.flatten_notes([lc.note_group(
        "Scenario · oidc", kind="scenario", body=presets.load("oidc").notes)])
    assert "a sentence some older release wrote down" not in s["notes"]
    # The grouped form is what the panel renders, and the scenario has to be MARKED
    # as one -- the panel feeds that group back into its links card rather than
    # giving it a card of its own.
    assert [g["kind"] for g in s["note_groups"]] == ["scenario"]
    assert any("/etc/hosts" in n for n in s["notes"])


def test_compose_major_version_parsing():
    from houston.services import doctor as doctorsvc
    # A first-CHARACTER compare reported every Compose newer than v2 as
    # unsupported (v5 is current) and would misread v10 as v1.
    assert doctorsvc._major_version("2.29.1") == 2
    assert doctorsvc._major_version("v2.29.1") == 2
    assert doctorsvc._major_version("5.3.1") == 5
    assert doctorsvc._major_version("10.0.0") == 10
    assert doctorsvc._major_version("1.29.2") == 1        # genuinely too old
    assert doctorsvc._major_version(None) is None
    assert doctorsvc._major_version("") is None
    assert doctorsvc._major_version("unknown") is None


def test_detail_reports_unknown_state_when_docker_is_unreachable(monkeypatch):
    from houston import runner
    monkeypatch.setattr(runner, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner, "read_meta", lambda n: lc.runner.Metadata(
        name=n, project=f"houston-{n}", rc_version="8.5.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map"))
    monkeypatch.setattr(runner, "read_compose", lambda n: {"services": {"rocketchat": {}}})
    d = lc.detail("x")
    # container_details() returns [] both for "none" and for "could not ask docker",
    # so detail() used to assert "down" while list_repros() said "?" for the same
    # repro -- and the panel then offered a Bring up button that could only fail.
    assert d["state"] == "?" and d["health"] == "" and d["uptime"] == ""
    assert d["containers"] == []


def test_detail_says_whether_this_repro_is_the_default(monkeypatch, tmp_path):
    """The panel offers "Make default" only when it would change something.

    list_repros() has always carried `default`; detail() did not, so the panel
    had to either hide the action or show it on the repro that already is one.
    """
    from houston import config, runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner, "read_meta", lambda n: lc.runner.Metadata(
        name=n, project=f"houston-{n}", rc_version="8.5.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map"))
    monkeypatch.setattr(runner, "read_compose", lambda n: {"services": {"rocketchat": {}}})

    assert lc.detail("a")["is_default"] is False       # nothing pinned yet
    config.update_config(lambda cfg: cfg.__setitem__("default_repro", "a"))
    assert lc.detail("a")["is_default"] is True
    assert lc.detail("b")["is_default"] is False


# --- --https flag resolution --------------------------------------------------


def _req(**kw):
    base = dict(version="8.6.1")
    base.update(kw)
    return lc.CreateReq(**base)


def test_a_domain_without_an_email_names_both_ways_to_give_one(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    with pytest.raises(errors.ValidationError) as ei:
        lc._resolve_tls(_req(domain="rc1.example.com"), "x", "")
    msg = str(ei.value)
    assert "--email" in msg and "config set acme.email" in msg


def test_no_reachability_guessing_stands_between_you_and_a_certificate(tmp_path,
                                                                       monkeypatch):
    """How traffic reaches this host is the operator's business.

    The old path refused to create the repro when the name did not resolve, resolved
    privately, or sat behind a proxy -- guesses this process cannot make correctly
    (it cannot see a tunnel, a port-forward or a firewall), and the single biggest
    source of confusion here.
    """
    from houston import runner, tls
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner, "port_free", lambda p, h="": True)
    for probe in ("dns_preflight", "reachability_gaps", "resolves_to",
                  "host_has_public_address"):
        assert not hasattr(tls, probe), f"{probe} should be gone"
    # A name that resolves nowhere is still accepted.
    spec = lc._resolve_tls(_req(domain="nowhere.invalid", acme_email="a@b.c"), "x", "")
    assert spec.mode == tls.MODE_ACME


def test_promote_command_reproduces_the_flags_actually_used():
    """The staging -> production hint must be copy-pasteable.

    It is the same two flags the workspace was created with, plus --force, so it
    reproduces the repro rather than describing a different one.
    """
    from houston import runner
    from houston.cli import _promote_command

    def meta(**extra):
        return runner.Metadata(
            name="testrepo", project="p", rc_version="8.4.2", rc_image="i",
            mongo_tag="8.0", mongo_flavor="official", preset="default",
            root_url="http://localhost:3000", host_port=3000, version_source="map",
            public_url="https://testrepo.kestron.org", extra={"tls": "acme", **extra})

    cmd = _promote_command(meta(tls_email="me@example.com"), "testrepo.kestron.org")
    assert "--domain testrepo.kestron.org" in cmd
    assert "--email me@example.com" in cmd
    assert "--force" in cmd and "--wait" in cmd
    # Nothing that no longer exists as a flag.
    for dead in ("--acme-challenge", "--acme-dns-provider", "--acme-email",
                 "--acme-staging", "--tls-cert", "--tls-san"):
        assert dead not in cmd

    # No --bind either: the public bind is derived at create time from --domain,
    # so spelling it in the hint would be noise the user has to understand.
    assert "--bind" not in cmd


def test_detail_exposes_the_https_fields_the_panel_keys_off(tmp_path, monkeypatch):
    """The panel's HTTPS row and "Check TLS" action both test detail().public_url.

    list_repros() carried public_url/tls and detail() did not, so the whole feature
    was invisible in the detail panel even though the links were right.
    """
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="g", project="houston-g", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map",
        public_url="https://g.houston.localhost:8443",
        extra={"tls": "local", "tls_ports": [8443]})
    monkeypatch.setattr(runner, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner, "read_meta", lambda n: meta)
    monkeypatch.setattr(runner, "read_compose", lambda n: {"services": {"rocketchat": {}}})

    d = lc.detail("g")
    assert d["public_url"] == "https://g.houston.localhost:8443"
    assert d["tls"] == "local"
    # The clickable link prefers https, and the plain port stays available.
    urls = [x["url"] for x in d["links"]]
    assert "https://g.houston.localhost:8443" in urls
    assert "http://localhost:3000" in urls

    # A repro without --https must not grow the row or the action.
    meta.public_url = ""
    meta.extra = {}
    d2 = lc.detail("g")
    assert d2["public_url"] == "" and d2["tls"] == ""


def test_env_overrides_survive_up_force(tmp_path, monkeypatch):
    """`up --force` rebuilds compose from the spec, so overrides must live in metadata.

    Verified live before this was written: editing only the generated compose file
    worked until the next `up --force`, which silently dropped the change.
    """
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="e", project="houston-e", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map",
        extra={"env": {"KEEP_ME": "yes", "GONE": None}})
    monkeypatch.setattr(runner, "exists", lambda n: True)
    monkeypatch.setattr(runner, "read_meta", lambda n: meta)

    carried: dict = {}
    if runner.exists("e"):
        prev = runner.read_meta("e").extra.get("env")
        if isinstance(prev, dict):
            carried.update(prev)
    carried.update({"NEW": "1"})          # what this run asked for
    assert carried == {"KEEP_ME": "yes", "GONE": None, "NEW": "1"}, \
        "existing overrides carry forward; this run's win"


def test_set_env_refuses_a_no_op_and_warns_on_load_bearing_keys(tmp_path, monkeypatch):
    """Load-bearing keys are allowed — reproducing a broken config is the point —
    but never silently, because the repro stops working and the cause is invisible."""
    from houston import compose, runner
    from houston.services import envvars
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(envvars.lifecycle, "require_docker", lambda: None)
    monkeypatch.setattr(envvars.lifecycle, "resolve_name", lambda n: n)

    with pytest.raises(errors.ValidationError, match="nothing to change"):
        envvars.set_env("e", {}, [], emit=lambda ev: None)

    meta = runner.Metadata(
        name="e", project="houston-e", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map")
    doc = {"services": {"rocketchat": {"environment": {"PORT": "3000", "KEEP": "1"}},
                        "rocketchat-2": {"environment": {"PORT": "3000"}}}}
    monkeypatch.setattr(runner, "read_meta", lambda n: meta)
    monkeypatch.setattr(runner, "read_compose", lambda n: doc)
    written = {}
    monkeypatch.setattr(runner, "write",
                        lambda n, y, m, files=None: written.update(yaml=y, meta=m))
    monkeypatch.setattr(runner, "up", lambda n, pull=True, force_recreate="": 0)

    events = []
    r = envvars.set_env("e", {"MONGO_URL": "mongodb://elsewhere", "MY": "v"}, ["KEEP"],
                        emit=events.append)
    assert r["restarted"] is True
    assert any("load-bearing" in str(getattr(e, "message", e)) for e in events), \
        "MONGO_URL must be called out"
    # Applied to EVERY rocketchat service, and the unset key is gone from each.
    out = compose.yaml.safe_load(written["yaml"])
    for svc in ("rocketchat", "rocketchat-2"):
        assert out["services"][svc]["environment"]["MY"] == "v", svc
        assert "KEEP" not in out["services"][svc]["environment"], svc
    # And it is recorded, so `up --force` keeps it.
    assert written["meta"].extra["env"] == {"KEEP": None, "MONGO_URL": "mongodb://elsewhere",
                                            "MY": "v"}


def test_set_env_can_write_without_restarting(tmp_path, monkeypatch):
    from houston import runner
    from houston.services import envvars
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(envvars.lifecycle, "require_docker", lambda: None)
    monkeypatch.setattr(envvars.lifecycle, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner, "read_meta", lambda n: runner.Metadata(
        name="e", project="p", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map"))
    monkeypatch.setattr(runner, "read_compose",
                        lambda n: {"services": {"rocketchat": {"environment": {}}}})
    monkeypatch.setattr(runner, "write", lambda *a, **k: None)
    called = []
    monkeypatch.setattr(runner, "up",
                        lambda n, pull=True, force_recreate="": called.append(n) or 0)
    r = envvars.set_env("e", {"A": "1"}, [], restart=False, emit=lambda ev: None)
    assert r["restarted"] is False and called == [], "must not touch containers"


# --- the two-flag HTTPS surface (#https-domain-email) ---------------------------

def test_up_offers_exactly_two_https_flags():
    """The official compose asks for DOMAIN and LETSENCRYPT_EMAIL; so do we.

    This grew to nine visible flags across three certificate modes, which is the
    complaint that prompted the rewrite. The removed ones must be gone from the
    signature, not merely hidden -- an unreachable code path behind a deleted flag
    is worse than either.
    """
    import inspect
    from houston.cli import up as up_cmd
    params = set(inspect.signature(up_cmd).parameters)
    assert {"domain", "email", "https"} <= params
    for dead in ("tls_cert", "tls_key", "tls_san", "acme_staging",
                 "acme_email", "acme_challenge", "acme_dns_provider"):
        assert dead not in params, f"--{dead.replace('_', '-')} should be gone"


def test_createreq_carries_no_dead_tls_fields():
    """CreateReq is the web API's schema too, so a stale field is a stale endpoint."""
    fields = set(lc.CreateReq.__dataclass_fields__)
    for dead in ("tls_cert", "tls_key", "tls_san", "acme_challenge_given"):
        assert dead not in fields, f"CreateReq.{dead} should be gone"
    assert {"domain", "acme_email", "https", "acme_staging"} <= fields
    # These two survive as DERIVED state, not input: _pick_challenge sets them and
    # no flag reaches them.
    assert {"acme_challenge", "acme_dns_provider"} <= fields


def test_staging_is_reachable_through_config_only(tmp_path, monkeypatch):
    """Not a flag on `up` -- but Let's Encrypt allows only 5 failed validations per
    hostname per hour, so a way to rehearse has to exist somewhere."""
    from houston import config as cfgmod
    from houston import runner
    from houston.cli import _CONFIG_KEYS
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner, "port_free", lambda p, h="": True)
    assert "acme.staging" in _CONFIG_KEYS

    cfgmod.update_config(lambda c: c.__setitem__("acme_staging", True))
    spec = lc._resolve_tls(_req(domain="rc1.example.com", acme_email="a@b.c"), "x", "")
    assert spec.acme_staging is True


def test_every_tls_attribute_the_cli_and_web_reach_for_exists():
    """Catches a module attribute that moved out from under a caller.

    Splitting the local CA into tls_local left `trust-ca` calling tls.ensure_ca(),
    which ruff cannot see (it is an attribute access, not a name) and no test
    exercised -- so it would have failed only when a user ran the command.
    """
    import ast
    import pathlib

    from houston import tls, tls_local
    mods = {"tlsmod": tls, "tls": tls, "tls_local": tls_local}
    missing = []
    for rel in ("houston/cli.py", "houston/web/app.py", "houston/compose.py",
                "houston/services/lifecycle.py"):
        tree = ast.parse(pathlib.Path(rel).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                    and node.value.id in mods and not hasattr(mods[node.value.id], node.attr)):
                missing.append(f"{rel}:{node.lineno} {node.value.id}.{node.attr}")
    assert not missing, "attribute(s) that no longer exist: " + ", ".join(missing)


# --- the challenge is derived, never asked for (#https-dns01) ---------------------

def _dns_env(tmp_path, body="CF_DNS_API_TOKEN=secret\n"):
    from houston import tls
    path = tls.dns_env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def test_tls_alpn_is_the_default_matching_the_official_compose(tmp_path, monkeypatch):
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner, "port_free", lambda p, h="": True)
    spec = lc._resolve_tls(_req(domain="rc1.example.com", acme_email="a@b.c"), "x", "")
    assert spec.acme_challenge == "tlsalpn"


def test_dns01_is_selected_when_credentials_exist(tmp_path, monkeypatch):
    """The presence of the file IS the signal -- nobody creates it by accident.

    It is the only way to issue when Let's Encrypt cannot connect inbound: behind
    NAT, behind a tunnel, or behind a proxy that terminates TLS in front of you.
    """
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner, "port_free", lambda p, h="": True)
    _dns_env(tmp_path)
    req = _req(domain="rc1.example.com", acme_email="a@b.c")
    spec = lc._resolve_tls(req, "x", "")
    assert spec.acme_challenge == "dns" and spec.acme_dns_provider == "cloudflare"
    # dns-01 never accepts an inbound connection, so the workspace must NOT be
    # widened to 0.0.0.0 -- these repros run admin/admin123.
    assert req.bind_public is False


def test_dns01_provider_inference_is_not_cloudflare_specific(tmp_path, monkeypatch):
    from houston import tls
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    for body, expected in (("CF_DNS_API_TOKEN=x\n", "cloudflare"),
                           ("AWS_ACCESS_KEY_ID=x\nAWS_SECRET_ACCESS_KEY=y\n", "route53"),
                           ("DO_AUTH_TOKEN=x\n", "digitalocean"),
                           ("HETZNER_API_KEY=x\n", "hetzner"),
                           ("AZURE_CLIENT_ID=x\n", "azuredns")):
        _dns_env(tmp_path, body)
        provider, why = tls.infer_dns_provider()
        assert provider == expected, f"{body!r} -> {provider!r}"
        assert "secret" not in why and "=" not in why, "never echo a credential VALUE"


def test_unrecognised_credentials_are_refused_not_silently_ignored(tmp_path,
                                                                   monkeypatch):
    """Falling back to tlsalpn would ignore a file the user deliberately created."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _dns_env(tmp_path, "SOME_UNKNOWN_THING=x\n")
    with pytest.raises(errors.ValidationError) as ei:
        lc._resolve_tls(_req(domain="rc1.example.com", acme_email="a@b.c"), "x", "")
    assert "config set acme.dns_provider" in str(ei.value)


def test_an_explicit_provider_overrides_inference(tmp_path, monkeypatch):
    from houston import config as cfgmod
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner, "port_free", lambda p, h="": True)
    _dns_env(tmp_path, "SOME_UNKNOWN_THING=x\n")
    cfgmod.update_config(lambda c: c.__setitem__("acme_dns_provider", "exoscale"))
    spec = lc._resolve_tls(_req(domain="rc1.example.com", acme_email="a@b.c"), "x", "")
    assert spec.acme_challenge == "dns" and spec.acme_dns_provider == "exoscale"


# --- per-user naming (#team-auth) --------------------------------------------------
#
# On a shared server the second person to run `up -v 8.5.1` silently REUSED the
# first person's workspace, data and all. That is a data-loss bug independent of
# anything else here.

def test_two_people_running_the_same_version_get_two_workspaces():
    assert lc.derive_name("8.5.1", "default") == "rc8-5-1"          # unchanged solo
    assert lc.derive_name("8.5.1", "default", "alice") == "alice-rc8-5-1"
    assert lc.derive_name("8.5.1", "default", "bob") == "bob-rc8-5-1"
    assert lc.derive_name("8.5.1", "ldap", "alice") == "alice-rc8-5-1-ldap"


def test_an_explicit_name_is_namespaced_too():
    """Two people typing `--name test` collide exactly as derived names did."""
    assert lc.owner_prefix("test", "alice") == "alice-test"
    assert lc.owner_prefix("test", "bob") == "bob-test"
    # Idempotent, so `up --name alice-test` does not become alice-alice-test.
    assert lc.owner_prefix("alice-test", "alice") == "alice-test"


def test_naming_is_unchanged_without_an_actor():
    """A single-user machine must keep every existing workspace name."""
    assert lc.derive_name("8.5.1", "default", "") == "rc8-5-1"
    assert lc.owner_prefix("test", "") == "test"


def test_the_lock_name_and_the_written_name_cannot_drift():
    """create_repro derives the name twice -- once to lock, once in the body. If
    they disagreed, the lock would guard a different repro than the one written."""
    for req in (lc.CreateReq(version="8.5.1", actor="alice"),
                lc.CreateReq(version="8.5.1", preset="ldap", actor="alice"),
                lc.CreateReq(version="8.5.1", name="My Repro!", actor="alice"),
                lc.CreateReq(version="8.5.1")):
        assert lc._derive_for(req) == lc._derive_for(req)
        assert lc._derive_for(req)


def test_a_derived_name_stays_a_valid_dns_label():
    """It becomes a hostname under the front door, so dots would break the TLS
    wildcard silently."""
    name = lc.derive_name("8.5.1", "default", "alice")
    assert "." not in name and name == lc.sanitize(name)


# --- job concurrency is bounded (F10) -------------------------------------------
# Job RETENTION was bounded; concurrency was not. Ten teammates each starting a
# capacity search meant ten k6 containers against one engine -- searches that
# invalidate each other and starve the workspaces under test. A perf tool that
# silently produces wrong numbers under contention is worse than one that waits.

def test_a_second_load_test_waits_rather_than_corrupting_the_first():
    import threading
    import time as _t

    from houston.web.jobs import JobManager

    jobs = JobManager()
    started, release = threading.Event(), threading.Event()

    def hog(emit=None):
        started.set()
        release.wait(timeout=5)
        return {"ok": True}

    def quick(emit=None):
        return {"ok": True}

    first = jobs.submit("loadtest", hog, label="a")
    assert started.wait(timeout=5), "the first job should start immediately"
    second = jobs.submit("loadtest", quick, label="b")
    _t.sleep(0.2)
    assert second.status == "queued", "a concurrent load test is not a measurement"

    # And a queued job must not look finished: the SSE stream closes on that, and
    # eviction drops anything not active.
    _events, done, _n = second.snapshot(0)
    assert done is False, "a queued job reported as finished closes its own stream"

    release.set()
    for _ in range(50):
        if second.status == "done":
            break
        _t.sleep(0.1)
    assert second.status == "done" and first.status == "done"


def test_a_failing_job_releases_its_slot():
    """One leaked slot on the measurement pool (size 1) wedges every future load
    test for the life of the process."""
    import time as _t

    from houston.errors import ValidationError
    from houston.web.jobs import JobManager

    jobs = JobManager()

    def boom(emit=None):
        raise ValidationError("nope")

    failed = jobs.submit("loadtest", boom, label="a")
    for _ in range(50):
        if failed.status == "error":
            break
        _t.sleep(0.1)
    assert failed.status == "error"

    after = jobs.submit("loadtest", lambda emit=None: {"ok": True}, label="b")
    for _ in range(50):
        if after.status == "done":
            break
        _t.sleep(0.1)
    assert after.status == "done", "the slot was never released"


def test_ordinary_jobs_are_not_queued():
    """Reads, state changes and seeds stay unbounded, as before."""
    import time as _t

    from houston.web.jobs import JobManager

    jobs = JobManager()
    job = jobs.submit("seed", lambda emit=None: {"ok": True}, label="x")
    for _ in range(50):
        if job.status == "done":
            break
        _t.sleep(0.1)
    assert job.status == "done"


# --- TLS after the edge ---------------------------------------------------------
# A workspace terminates no TLS, so `_resolve_tls` no longer allocates a port,
# probes one, or decides anything about a sidecar. What is left is: which name,
# and which certificate source.

def test_a_domain_still_needs_only_a_domain_and_an_email(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import tls
    from houston.services import edge as edgesvc
    from houston.services import lifecycle as lcsvc

    monkeypatch.setattr(edgesvc, "running", lambda: True)
    req = lcsvc.CreateReq(version="8.5.1", domain="chat.example.com",
                          acme_email="me@example.com")
    spec = lcsvc._resolve_tls(req, "w", "127.0.0.1")
    assert spec.mode == tls.MODE_ACME
    assert spec.host == "chat.example.com"
    assert spec.root_url == "https://chat.example.com", "443 carries no port"


def test_a_domain_without_an_email_says_how_to_set_one(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import errors
    from houston.services import lifecycle as lcsvc

    req = lcsvc.CreateReq(version="8.5.1", domain="chat.example.com")
    with pytest.raises(errors.ValidationError) as exc:
        lcsvc._resolve_tls(req, "w", "127.0.0.1")
    assert "config set acme.email" in str(exc.value)


def test_local_https_gets_a_localhost_name_and_no_port_of_its_own(tmp_path, monkeypatch):
    """It used to allocate 8443, 8444, ... one per workspace, each with its own
    URL. Every name answers on the edge's 443 now."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import tls
    from houston.services import edge as edgesvc
    from houston.services import lifecycle as lcsvc

    monkeypatch.setattr(edgesvc, "running", lambda: True)
    req = lcsvc.CreateReq(version="8.5.1", https=True)
    spec = lcsvc._resolve_tls(req, "w", "127.0.0.1")
    assert spec.mode == tls.MODE_LOCAL
    assert spec.host == "w.houston.localhost"
    assert spec.root_url == "https://w.houston.localhost"


def test_dns01_is_still_chosen_from_credentials_not_a_flag(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import tls
    from houston.services import edge as edgesvc
    from houston.services import lifecycle as lcsvc

    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    tls.dns_env_path().write_text("CF_DNS_API_TOKEN=secret\n")
    monkeypatch.setattr(edgesvc, "running", lambda: True)
    req = lcsvc.CreateReq(version="8.5.1", domain="chat.example.com",
                          acme_email="me@example.com")
    spec = lcsvc._resolve_tls(req, "w", "127.0.0.1")
    assert spec.acme_challenge == "dns" and spec.acme_dns_provider == "cloudflare"


# --- host capacity (an OOM took a 10 GB box down) --------------------------------
# Seven concurrent Rocket.Chat + MongoDB stacks exhausted a 10 GB host with no
# swap: the kernel OOM killer fired and the machine had to be recovered. Every
# individual `up` had succeeded -- nothing anywhere asked whether there was room
# for one more. docs/design/team-server.md §8 recorded this as "made visible, not
# solved"; these pin the guard that solves it.

def _mem(monkeypatch, available_mb, total_mb=10000, swap_mb=0):
    from houston import runner
    monkeypatch.setattr(runner, "host_memory",
                        lambda: (total_mb, available_mb, swap_mb))


# These five assert PreflightError, not NotReadyError. errors.py always documented
# capacity that way -- "capacity shortfalls ... use this" -- while the code raised
# NotReadyError, which is exit 5 and means "still unknown, poll again". Polling does
# not free memory, so exit 5 told a script to retry something retrying cannot fix.
# Same argument that moved `require_docker` off exit 5; HTTP status is 409 either way.
def test_a_workspace_is_refused_when_the_host_cannot_hold_it(monkeypatch):
    from houston import errors
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=1000)      # 100 MB usable after the reserve
    with pytest.raises(errors.PreflightError) as exc:
        lc.check_capacity(lc.CreateReq(version="8.5.1"))
    assert "not enough memory" in str(exc.value)


def test_the_refusal_says_what_to_stop_and_how(monkeypatch):
    """"Out of memory" with no next step just moves the problem to the operator."""
    from houston import errors
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=1000)
    with pytest.raises(errors.PreflightError) as exc:
        lc.check_capacity(lc.CreateReq(version="8.5.1"))
    msg = str(exc.value)
    assert "houston stop" in msg and "--force" in msg
    assert "NO SWAP" in msg, "no swap means no buffer at all; say so"


def test_the_advertised_force_override_actually_overrides(monkeypatch):
    """The refusal tells the user to pass --force. It has to then work.

    The test above pins the WORDS "--force" in the message; nothing pinned the
    behaviour, and check_capacity never read req.force -- so the documented escape
    hatch did not exist. Following the instruction produced the identical refusal,
    and because `up --force` also means "overwrite this repro", obeying the advice
    risked destroying a workspace while still being blocked.

    Found by an audit that hit the refusal, did what it said, and was refused again.
    The override also has to stay LOUD: this is the guard added after an OOM killer
    took out a 10 GB host, so bypassing it is reported, not silent.
    """
    from houston.services import lifecycle as lc
    from houston.services.events import Event

    _mem(monkeypatch, available_mb=1000)          # 100 MB usable: nowhere near enough
    seen: list[Event] = []
    lc.check_capacity(lc.CreateReq(version="8.5.1", force=True), "",
                      seen.append)                # must NOT raise

    warnings = [e for e in seen if e.level == "warn"]
    assert warnings, "an OOM guard must not be bypassed silently"
    text = " ".join(e.message for e in warnings)
    assert "--force" in text, "say which flag did this"
    assert "OOM" in text, "and what the consequence is"

    # Without it, the same host state still refuses -- this widens nothing else.
    with pytest.raises(errors.PreflightError):
        lc.check_capacity(lc.CreateReq(version="8.5.1"))


def test_plenty_of_memory_is_not_refused(monkeypatch):
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=9000)
    lc.check_capacity(lc.CreateReq(version="8.5.1"))       # must not raise


def test_a_preset_with_keycloak_needs_more_than_a_bare_workspace(monkeypatch):
    """saml/oidc run Keycloak, which is the biggest sidecar there is."""
    from houston import errors
    from houston.services import lifecycle as lc

    # Enough for a bare workspace, not for one plus Keycloak.
    _mem(monkeypatch, available_mb=lc.host_reserve_mb(10024) + lc.WORKSPACE_MB + 100)
    lc.check_capacity(lc.CreateReq(version="8.5.1"))       # bare: fits
    with pytest.raises(errors.PreflightError):
        lc.check_capacity(lc.CreateReq(version="8.5.1"), "saml")


def test_monitoring_counts_towards_the_estimate(monkeypatch):
    from houston import errors
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=lc.host_reserve_mb(10024) + lc.WORKSPACE_MB + 100)
    with pytest.raises(errors.PreflightError):
        lc.check_capacity(lc.CreateReq(version="8.5.1", monitor=True))


def test_the_last_workspace_warns_before_the_ceiling(monkeypatch):
    """The ceiling should be visible BEFORE it is hit, not only in the refusal."""
    from houston.services import lifecycle as lc

    _mem(monkeypatch, available_mb=lc.host_reserve_mb(10024) + lc.WORKSPACE_MB + 200)
    seen: list = []
    lc.check_capacity(lc.CreateReq(version="8.5.1"), "", lambda ev: seen.append(ev))
    assert any("is left" in str(getattr(e, "message", e)) for e in seen)


def test_a_host_we_cannot_measure_is_never_refused(monkeypatch):
    """Not Linux: skip rather than guess. A wrong refusal is worse than none."""
    from houston import runner
    from houston.services import lifecycle as lc

    monkeypatch.setattr(runner, "host_memory", lambda: None)
    lc.check_capacity(lc.CreateReq(version="8.5.1"))       # must not raise


def test_host_memory_prefers_available_over_free():
    """MemFree excludes the page cache, which the kernel reclaims on demand -- it
    looks alarming on a healthy box and reassuring on a doomed one."""
    from houston import runner

    mem = runner.host_memory()
    if mem is None:
        pytest.skip("not Linux")
    total, avail, _swap = mem
    assert total > 0 and 0 < avail <= total


def test_the_guard_would_have_stopped_the_incident(monkeypatch):
    """The REAL numbers from the host that died: 10024 MB total, 3350 MB
    available, no swap, and a seventh stack about to start.

    A fixed 1 GB reserve waved this exact configuration through when I tested it
    -- the box OOMed while MemAvailable still read 3.3 GB, because the memory that
    kills a host is what already-admitted workspaces take LATER. A proportional
    reserve refuses it.
    """
    from houston import errors
    from houston.services import lifecycle as lc

    _mem(monkeypatch, total_mb=10024, available_mb=3350, swap_mb=0)
    with pytest.raises(errors.PreflightError):
        lc.check_capacity(lc.CreateReq(version="8.5.1"), "multi-instance")


def test_the_reserve_scales_with_the_host():
    from houston.services import lifecycle as lc

    assert lc.host_reserve_mb(10024) == 2004, "a fifth of a 10 GB box"
    assert lc.host_reserve_mb(2048) == 1024, "never below 1 GB on a small one"


def test_an_impossible_mongo_kernel_pairing_is_refused_before_any_docker_work(monkeypatch):
    """SERVER-121912: mongod 8.0 EXITS on kernel >= 6.19 — not degrades, exits,
    with a message that reads like a volume or permission fault.

    `doctor` has known the rule for a while and could only warn, because it does
    not know which release you are about to boot. Nothing on the create path
    checked it, so `up` would pull ~1.5 GB of images, create the containers and
    then let mongod die, leaving `diagnose` to explain it afterwards. Now the
    pairing is resolved first and an impossible one is refused.
    """
    from houston.services import doctor

    # The rule itself: version-aware, so it answers differently per pairing.
    assert doctor.mongo_kernel_conflict("8.0", "6.19.7-200.fc43.aarch64")
    assert "SERVER-121912" in doctor.mongo_kernel_conflict("8.0", "6.19.7")
    assert doctor.mongo_kernel_conflict("7.0", "6.19.7") == ""   # 7.0 is unaffected
    assert doctor.mongo_kernel_conflict("8.0", "6.18.0") == ""   # older kernel is fine
    assert doctor.mongo_kernel_conflict("8.0", "") == ""         # unknown: do not guess
    assert doctor.mongo_kernel_conflict("", "6.19.7") == ""      # unknown: do not guess

    # And the create path refuses with it, before it touches docker.
    pulled: list = []
    monkeypatch.setattr(lc, "require_docker", lambda: None)
    monkeypatch.setattr(lc.runner, "docker_kernel_version", lambda: "6.19.7-200.fc43")
    monkeypatch.setattr(lc.runner, "exists", lambda n: False)
    monkeypatch.setattr(lc.runner, "write", lambda *a, **k: pulled.append("wrote"))
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: type("R", (), {
                            "rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                            "mongo_flavor": "mongodb", "mongo_shell": "mongosh",
                            "oplog": False, "source": "test", "note": ""})())
    with pytest.raises(errors.PreflightError) as caught:
        lc._create_repro_locked(lc.CreateReq(version="8.6.1"))
    assert "mongod 8.0 exits" in str(caught.value)
    assert caught.value.exit_code == 3, "a wrong environment is a preflight failure"
    assert not pulled, "it refused only AFTER starting work"


# --- readiness must not depend on DNS, a certificate, or the edge ----------------

def test_root_url_in_metadata_is_always_the_local_port(monkeypatch, tmp_path):
    """runner.Metadata's own docstring makes this a contract: root_url "stays the
    plain http://localhost:<port> that houston's own API calls (login, PAT, seeding,
    load tests) use", and public_url carries the external name.

    `--root-url` used to displace it, which put a public https name into root_url --
    and `ready` polls exactly that. Reported from a live box: "Rocket.Chat did not
    become ready within 300s" while `curl http://localhost:3000/api/info` answered
    200 the whole time. Reproduced here with `up --root-url https://lab.example.com`:
    still booting at 127s, 200 locally, and after the fix ready in 15s.

    The override still reaches Rocket.Chat -- it is what RC ADVERTISES, and the
    compose spec below keeps taking it.
    """
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen = {}

    monkeypatch.setattr(lc.runner, "docker_available", lambda **_k: True)
    monkeypatch.setattr(lc.runner, "exists", lambda _n: False)
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "check_sidecar_ports", lambda *a, **k: None)
    monkeypatch.setattr(lc, "pick_host_port", lambda *a, **k: 3001)
    _real_resolve = lc.versions.resolve      # bind before patching, or it recurses
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: _real_resolve(v, offline=True))

    def fake_write(name, compose_yaml, meta, files=None):
        seen["meta"] = meta
        seen["yaml"] = compose_yaml
        return None

    monkeypatch.setattr(lc.runner, "write", fake_write)
    monkeypatch.setattr(lc, "_up", lambda *a, **k: 0)

    lc.create_repro(lc.CreateReq(version="8.5.1", name="urlcase",
                                 root_url="https://lab.example.com", wait=False),
                    emit=lc.null_emit)

    meta = seen.get("meta")
    assert meta is not None, "create never wrote metadata"
    assert meta.root_url == "http://localhost:3001", \
        f"root_url must stay local, got {meta.root_url!r}"
    # And RC still advertises the override, or --root-url would do nothing at all.
    assert "ROOT_URL: https://lab.example.com" in seen["yaml"], \
        "RC should still advertise the override — otherwise --root-url does nothing"


def test_a_transitional_health_is_reported_without_dockers_string_prefix():
    """Docker spells the transitional state "health: starting" inside the Status
    string, and bare "healthy"/"unhealthy" for the settled ones.

    Taken verbatim the panel rendered "Health: health: starting". The prefix belongs
    to the string format, not to the value.
    """
    assert lc._uptime_health("Up 4 seconds (health: starting)") == ("4 seconds", "starting")
    assert lc._uptime_health("Up 2 hours (healthy)") == ("2 hours", "healthy")
    assert lc._uptime_health("Up 5 minutes (unhealthy)") == ("5 minutes", "unhealthy")
    # No healthcheck at all, and a stopped container, are both "no health".
    assert lc._uptime_health("Up 3 minutes") == ("3 minutes", "")
    assert lc._uptime_health("Exited (0) 1 minute ago") == ("", "")
# --- the topology socket --------------------------------------------------------
# Phase 1 of Kubernetes support: a workspace's runtime becomes a value that can be
# READ, instead of a shape (`docker-compose.yml` on disk) that can only be
# inferred. Only compose is registered, so none of this is user-visible yet -- the
# tests below are what make the seam checkable before there is a second runtime.

def test_a_workspace_with_no_runtime_key_reads_as_docker():
    """The compatibility gate. Every workspace on every existing box predates this
    key, and none of them is rewritten -- so an absent value must mean docker, or
    the socket silently orphans the entire installed base."""
    from houston.services import topology

    old = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                          mongo_tag="8.0", mongo_flavor="official", preset="default",
                          root_url="http://localhost:3000", host_port=3000,
                          version_source="test")
    assert old.extra == {}, "the fixture must genuinely lack the key"
    assert topology.of_meta(old) == topology.DOCKER


def test_an_unknown_runtime_reads_as_docker_rather_than_raising():
    """Forward compatibility, and the reason `of_meta` never raises: a workspace
    written by a NEWER houston naming a runtime this build has never heard of must
    still list and still tear down. A repro the installed version cannot remove is
    worse than one it renders imprecisely."""
    from houston.services import topology

    m = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                        mongo_tag="8.0", mongo_flavor="official", preset="default",
                        root_url="u", host_port=3000, version_source="t",
                        extra={"runtime": "nomad"})
    assert topology.of_meta(m) == topology.DOCKER
    # And a corrupt `extra` is survivable too -- runner already defends against it.
    broken = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                             mongo_tag="8.0", mongo_flavor="official", preset="default",
                             root_url="u", host_port=3000, version_source="t")
    broken.extra = "not-a-dict"          # type: ignore[assignment]
    assert topology.of_meta(broken) == topology.DOCKER


def test_the_runtime_survives_a_real_write_and_read(monkeypatch, tmp_path):
    """Round-trip through repro.json on disk, not through a mock. `read_meta`
    filters unknown keys, so a value living in the wrong place would be dropped
    between writing a workspace and reading it back."""
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                        mongo_tag="8.0", mongo_flavor="official", preset="default",
                        root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "services: {}\n", m)
    assert topology.of_repro("k") == topology.KUBERNETES
    assert lc.runner.read_meta("k").extra["runtime"] == "kubernetes"


def test_reading_the_runtime_of_a_missing_workspace_does_not_explode(tmp_path, monkeypatch):
    """`of_repro` is called before the caller's own existence check in some paths.
    It must not be the thing that fails, or the user gets a stat error instead of
    'no such repro'."""
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert topology.of_repro("nope") == topology.DOCKER


def test_normalize_accepts_what_people_type_and_refuses_what_they_mistype():
    """The opposite policy to `of_meta`: this reads input a human just typed, where
    a silent fallback would boot the wrong topology."""
    from houston.services import topology

    assert topology.normalize("") == topology.DOCKER, "omitting --runtime is not an error"
    assert topology.normalize(None) == topology.DOCKER
    for spelling in ("docker", "compose", "docker-compose", "DOCKER"):
        assert topology.normalize(spelling) == topology.DOCKER
    for spelling in ("k8s", "kube", "Kubernetes", " KUBERNETES "):
        assert topology.normalize(spelling) == topology.KUBERNETES
    with pytest.raises(errors.ValidationError) as caught:
        topology.normalize("nomad")
    assert caught.value.exit_code == 2, "a typo is a usage error, not a preflight one"
    assert "kubernetes" in str(caught.value), "the refusal lists what IS known"


def test_doctor_warns_before_inotify_runs_out(tmp_path):
    """The symptom of this one points nowhere near its cause.

    With `fs.inotify.max_user_instances` exhausted, Traefik STARTS, stays up, logs
    "Cannot start the provider *file.Provider ... too many open files", and then
    serves its own default certificate to every request. That looks exactly like a
    broken route or a bad certificate and is neither -- it cost three full runs of an
    audit to find, which is precisely the kind of thing `doctor` exists to say first.

    It is also not hypothetical on a developer box: the limit is per-user, kind's own
    docs raise it for multi-cluster use, and it resets on reboot -- this host was
    raised to 1024 during the audit and was back to the 128 default afterwards.
    """
    from houston.services import doctor

    def at(limit, clusters, in_use=0):
        f = tmp_path / f"lim{limit}"
        f.write_text(str(limit))
        # `in_use` pinned: the verdict is about what is LEFT now, so leaving it unset
        # would read this machine's live consumption and make the thresholds below
        # depend on whatever else happens to be watching files while the suite runs.
        return doctor.inotify_headroom(clusters, path=str(f), in_use=in_use)

    # Plenty of room: say so, so the number is visible before it bites.
    assert at(4096, 1)[0][0] == "ok"

    # The kind default with several clusters is the failure that was actually hit.
    status, msg = at(128, 5)[0]
    assert status == "fail"
    assert "default certificate" in msg,         "name the symptom, or the reader cannot connect this to what they are seeing"
    assert "sysctl" in msg and "max_user_instances" in msg, "and give the fix"

    # Between need and 2x need is tight rather than broken.
    assert at(128, 2)[0][0] == "warn"

    # THE DEFECT: a limit high enough on paper, already spent. `in_use` was a parameter
    # the body never read, so this printed a green tick -- "inotify instances: 128 (~60
    # needed here)" -- while Traefik was failing with EMFILE and loading no dynamic
    # configuration at all. Measured on this box during the HTTPS work.
    status, msg = at(128, 1, in_use=120)[0]
    assert status == "fail", f"passed a limit with nothing left: {msg}"
    assert "in use" in msg, "say what is consuming it, or the number looks fine"

    # And consumption is reported even when the verdict is ok, so the margin is visible
    # before it closes.
    assert "in use" in at(4096, 1, in_use=30)[0][1]

    # Not Linux: the file is absent, and a limit that does not apply is not a finding.
    assert doctor.inotify_headroom(1, path=str(tmp_path / "absent")) == []
    # An unreadable/garbage value is silence too, never a crash in a diagnostic.
    bad = tmp_path / "garbage"
    bad.write_text("not-a-number")
    assert doctor.inotify_headroom(1, path=str(bad)) == []


def test_kubernetes_logs_do_not_mangle_rocketchats_own_formatting(monkeypatch):
    """Rocket.Chat pretty-prints its logs; the reader came for THAT.

    `--prefix` was passed unconditionally, so every line arrived stamped with
    "[pod/rocketchat-rocketchat-<hash>/rocketchat] " and the columns Rocket.Chat
    lays out were pushed off the left of the screen -- destroying exactly the
    formatting somebody opened the logs to read. Reported from real use.

    With one pod the prefix names the only thing it could be, so it is pure noise.
    With several it is the only way to tell replicas apart, so it comes back.
    """
    from houston.services import k8s

    seen = {}

    def fake_popen(argv, **kw):
        seen["argv"] = argv
        class _P:
            stdout = None
            def terminate(self): pass
            def wait(self, timeout=None): return 0
        return _P()
    monkeypatch.setattr(k8s.subprocess, "Popen", fake_popen)

    def with_pods(n):
        import subprocess as sp
        monkeypatch.setattr(k8s, "run", lambda argv, **kw: sp.CompletedProcess(
            argv, 0, "\n".join(f"pod/rc-{i}" for i in range(n)), ""))
        k8s.log_process("w", context="c", tail=25, follow=True)
        return seen["argv"]

    single = with_pods(1)
    assert "--prefix" not in single, \
        "one pod: the prefix identifies the only candidate and costs the formatting"
    assert "-c" not in single, (
        "the selected pods have DIFFERENT container names -- rocketchat, "
        "ddp-streamer, presence -- so naming one would fail on the others")
    assert "-f" in single and "--tail" in single

    # THE SELECTOR IS THE POINT ON MICROSERVICES. It was the monolith deployment
    # alone, so ddp-streamer -- which carries the WebSocket -- produced no output at
    # all, and a realtime problem gave logs with nothing about realtime in them.
    sel = single[single.index("-l") + 1]
    assert f"app.kubernetes.io/instance={k8s.RELEASE}" in sel, \
        "the whole release, so a microservice the chart adds later is included too"
    assert "app.kubernetes.io/name!=nats" in sel, \
        "but not the message bus, which would drown Rocket.Chat's own lines"
    # And the narrow questions still ask the narrow one.
    assert k8s.APP_SELECTOR == "app.kubernetes.io/name=rocketchat", \
        "env means Rocket.Chat itself, not whichever pod sorted first"
    import inspect
    assert "LOG_SELECTOR" in inspect.signature(k8s.pod_metrics).parameters["selector"].default \
        or k8s.LOG_SELECTOR == inspect.signature(k8s.pod_metrics).parameters["selector"].default, \
        "stats sums every application pod, as Compose sums every rocketchat service"

    many = with_pods(3)
    assert "--prefix" in many, "several replicas are indistinguishable without it"

    # A failed pod count must not decide the shape either way -- it falls back to
    # the quiet form rather than guessing there are many.
    import subprocess as sp
    monkeypatch.setattr(k8s, "run",
                        lambda argv, **kw: sp.CompletedProcess(argv, 1, "", "boom"))
    k8s.log_process("w", context="c", tail=5, follow=False)
    assert "--prefix" not in seen["argv"] and "-f" not in seen["argv"]


def test_orphaned_namespaces_are_found_but_never_swept_by_default(
        monkeypatch, tmp_path):
    """A namespace with no local record is unreachable by every other command.

    Every houston command starts from the state directory, so a workspace whose
    repro.json is gone -- interrupted create, wiped HOUSTON_HOME, a different home
    -- keeps its pods and its PersistentVolumeClaim running and simply cannot be
    seen. One was found holding 8Gi and five CrashLoopBackOff pods, removable only
    by hand with kubectl.

    It is OPT-IN, and that is the point: on a shared cluster an unrecorded namespace
    may be a colleague's workspace created from their own home, so "this machine has
    no record of it" is not evidence that it is rubbish.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="known", project="p", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    ws = lc.runner.workspace("known")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    monkeypatch.setattr(k8s, "workspace_namespaces",
                        lambda ctx=k8s.CONTEXT: ["houston-known", "houston-p3",
                                                 k8s.OPERATOR_NAMESPACE])
    found = lc.orphan_namespaces()
    assert found == ["houston-p3"], found
    assert k8s.OPERATOR_NAMESPACE not in found, \
        "the shared operator/monitoring namespace is not a workspace"

    # Default prune leaves them entirely alone.
    monkeypatch.setattr(lc, "prunable", lambda: [])
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    deleted: list[str] = []

    def fake_run(argv, **kw):
        import subprocess as sp
        if "delete" in argv and "namespace" in argv:
            deleted.append(argv[-2] if argv[-1].startswith("--") else argv[-1])
        return sp.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(k8s, "run", fake_run)

    assert lc.prune(confirm=True)["orphans"] == []
    assert deleted == [], "a sweep nobody asked for could delete a colleague's work"

    # Asked for explicitly, it removes exactly the unexplained one.
    out = lc.prune(confirm=True, orphans=True)
    assert out["orphans"] == ["houston-p3"]
    assert deleted == ["houston-p3"], deleted


def test_env_and_stats_answer_on_kubernetes_instead_of_refusing(
        monkeypatch, tmp_path):
    """The last two commands that had no Kubernetes path now have one.

    `env` is answered from the RUNNING CONTAINER rather than a document. That is not
    a translation of the Compose behaviour, it is better than it: the chart
    contributes variables houston never set, so the generated values would not show
    them and the compose file has no equivalent here at all.

    `stats` needs metrics-server, which kind does not ship. When it is missing the
    refusal says so and how to install it -- a resource figure that is quietly zero
    is worse than one that is missing, which is the same reasoning `stats` already
    applies to a container it cannot find.
    """
    import json as _json
    from dataclasses import asdict

    from houston import errors as errs
    from houston.services import envvars, k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    m.extra["env"] = {"MY_OVERRIDE": "set-by-me"}
    ws = lc.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    # --- env: read from the container, credentials masked -------------------
    monkeypatch.setattr(k8s, "container_env", lambda name, *, context: {
        "ADMIN_PASS": "admin123", "MONGO_URL": "mongodb://mongodb:27017/rocketchat",
        "MY_OVERRIDE": "set-by-me", "ROOT_URL": "http://localhost:3000"})
    out = envvars.current("k")
    keys = {row["key"]: row for row in out["env"]}
    assert set(keys) == {"ADMIN_PASS", "MONGO_URL", "MY_OVERRIDE", "ROOT_URL"}
    assert keys["MY_OVERRIDE"]["override"] is True, "a user override is marked as one"
    assert keys["ROOT_URL"]["override"] is False
    assert keys["ADMIN_PASS"]["value"] != "admin123", \
        "credentials are masked here exactly as they are on Compose"

    # --- stats: real numbers, parsed from `kubectl top` output --------------
    import subprocess as sp

    def top(argv, **kw):
        if "top" in argv:
            return sp.CompletedProcess(
                argv, 0, "rocketchat-a   120m   500Mi\nrocketchat-b   80m   300Mi\n", "")
        return sp.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(k8s, "run", top)
    rows = k8s.pod_metrics("k", context="c")
    assert sum(r["cpu_millicores"] for r in rows) == 200.0, "replicas are summed"
    assert rows[0]["mem_bytes"] == 500 * 1024 ** 2, "Mi is binary, not 1e6"

    # --- and a refusal that names the fix when metrics-server is absent ------
    def no_metrics(argv, **kw):
        return sp.CompletedProcess(argv, 1, "", "error: Metrics API not available")
    monkeypatch.setattr(k8s, "run", no_metrics)
    with pytest.raises(errs.NotReadyError) as caught:
        k8s.pod_metrics("k", context="c")
    assert "metrics-server" in str(caught.value)
    assert "kubectl apply" in str(caught.value), "say how to install it"


def test_start_restores_the_replica_count_stop_recorded(monkeypatch):
    """`--replicas 2` came back as 1 after stop/start, silently.

    `stop` records the counts in a namespace annotation for exactly this, and `start`
    read it back through jsonpath -- escaping the SLASH in
    `houston.io/replicas-before-stop` while leaving the DOT in `houston.io`
    unescaped. jsonpath then read `houston` and `io/...` as separate path segments,
    matched nothing and returned empty, so every restore fell through to the default
    of 1. Measured on a live cluster: the slash-escaped form returns "" where the
    dot-escaped form returns the annotation.

    The annotation written to prevent this was therefore never once read back, and
    nothing said so -- the workspace simply had half the Rocket.Chat it was asked for.
    Found by running microservices with two replicas, which is the only shape where
    the default and the truth differ.

    Read as JSON and picked in Python now: a rule with no escaping in it cannot be
    got subtly wrong.
    """
    import json as _json

    from houston.services import k8s

    recorded = {"deployment/rocketchat-rocketchat": "2",
                "deployment/rocketchat-presence": "1"}
    scaled: list[str] = []

    def fake_run(argv, **kw):
        import subprocess as sp
        joined = " ".join(argv)
        if "get" in argv and "namespace" in argv and "json" in joined:
            return sp.CompletedProcess(argv, 0, _json.dumps(
                {"metadata": {"annotations": {k8s.SCALE_ANNOTATION:
                                              _json.dumps(recorded)}}}), "")
        if "scale" in argv:
            scaled.append(next(a for a in argv if a.startswith("--replicas="))
                          + " " + argv[-1])
        return sp.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(k8s, "run", fake_run)
    monkeypatch.setattr(k8s, "_scalables",
                        lambda ns, ctx: ["deployment/rocketchat-rocketchat",
                                         "deployment/rocketchat-presence"])

    k8s.start_workspace("w", context="c")
    assert "--replicas=2 deployment/rocketchat-rocketchat" in scaled, scaled
    assert "--replicas=1 deployment/rocketchat-presence" in scaled, scaled

    # A workspace stopped by hand carries no annotation; 1 is what `up` would give.
    def no_annotation(argv, **kw):
        import subprocess as sp
        if "get" in argv and "namespace" in argv:
            return sp.CompletedProcess(argv, 0, '{"metadata":{}}', "")
        if "scale" in argv:
            scaled.append(next(a for a in argv if a.startswith("--replicas="))
                          + " " + argv[-1])
        return sp.CompletedProcess(argv, 0, "", "")
    scaled.clear()
    monkeypatch.setattr(k8s, "run", no_annotation)
    k8s.start_workspace("w", context="c")
    assert all(x.startswith("--replicas=1") for x in scaled), scaled


def test_an_interrupted_kubernetes_create_still_leaves_a_record(monkeypatch, tmp_path):
    """Killed part-way through, a create must leave something `down` can find.

    `create_workspace` builds the namespace, MongoDB, the release, the scenario's
    manifests and the port-forward -- minutes of work -- and the record used to be
    written only after it returned. Stopping `serve` with a create job still running
    does exactly that, and it was reported from real use: a full microservices
    workspace with twelve pods left running and INVISIBLE, because `list`, `info`
    and `down` all begin at the state directory and there was nothing in it.

    Compose never had this. It writes the record first and starts containers after,
    so an interrupted create is still listed and still removable. This is the same
    guarantee for the other runtime.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The namespace-ownership preflight talks to the cluster and lives OUTSIDE
    # `create_workspace`, so stubbing that one is no longer enough to keep a test
    # off a real kubectl. Refusing to guess is the point of it, so it is stubbed
    # rather than softened.
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s, "assert_namespace_available", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "require_docker", lambda: None)
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc.runner, "pick_port", lambda *a, **kw: 3999, raising=False)

    # The kill, at the worst possible moment: everything built, nothing recorded.
    def die(**kw):
        raise KeyboardInterrupt("serve shut down mid-create")
    monkeypatch.setattr(k8s, "create_workspace", die)

    req = lc.CreateReq(version="8.5.1", name="interrupted", runtime="kubernetes",
                       deployment="microservices")
    with pytest.raises(BaseException):
        lc.create_repro(req)

    assert lc.runner.exists("interrupted"), (
        "the workspace was left running with no record at all -- nothing in "
        "houston could see it, let alone remove it")
    meta = lc.runner.read_meta("interrupted")
    assert topology.of_meta(meta) == topology.KUBERNETES
    assert meta.extra.get("namespace") == k8s.namespace_for("interrupted"), \
        "teardown selects on the namespace, so it has to be recorded"
    assert meta.extra.get("incomplete") is True, \
        "and it must be distinguishable from a create that finished"


def test_prune_asks_kubernetes_whether_a_kubernetes_workspace_is_down(
        monkeypatch, tmp_path):
    """"Is it down" was answered by Docker for every workspace, on both runtimes.

    `prunable` listed a repro when no compose PROJECT was running. A Kubernetes
    workspace never has one, so a healthy workspace serving traffic was reported as
    down and offered up for deletion -- `prune` announces "deletes N down repro(s)
    incl. data" with a live one counted among them. It could not then remove it
    either: the loop ran `docker compose down` against a workspace with no compose
    file, which always failed.

    Found by an audit that went looking for why an orphaned namespace was still
    running with no state file anywhere to manage it.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def workspace(name, runtime, port):
        m = lc.runner.Metadata(name=name, project=f"houston-{name}",
                               rc_version="8.5.1", rc_image="i", mongo_tag="8.0",
                               mongo_flavor="official", preset="default",
                               root_url=f"http://localhost:{port}", host_port=port,
                               version_source="t")
        if runtime == topology.KUBERNETES:
            topology.stamp(m.extra, runtime)
        ws = lc.runner.workspace(name)
        ws.mkdir(parents=True, exist_ok=True)
        (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    workspace("live-k8s", topology.KUBERNETES, 3000)
    workspace("gone-k8s", topology.KUBERNETES, 3001)
    workspace("down-docker", topology.DOCKER, 3002)

    monkeypatch.setattr(lc, "require_docker", lambda: None)
    monkeypatch.setattr(lc.runner, "project_states", lambda: set())
    monkeypatch.setattr(lc.auditsvc, "actor", lambda: "")
    monkeypatch.setattr(lc, "may_destroy", lambda n, a: (True, ""))
    # The live one still has its Rocket.Chat workload; the other does not.
    monkeypatch.setattr(k8s, "workload_exists",
                        lambda name, *, context: name == "live-k8s")

    targets = lc.prunable()
    assert "live-k8s" not in targets, (
        "a RUNNING Kubernetes workspace was offered for deletion, because the "
        "question was put to Docker and it has no compose project either way")
    assert "gone-k8s" in targets, "a Kubernetes workspace with no workload IS down"
    assert "down-docker" in targets, "and Compose must keep behaving as before"


def test_prune_removes_a_kubernetes_workspace_through_kubernetes(
        monkeypatch, tmp_path):
    """And having listed one, it has to be able to remove it.

    The loop called `runner.down` -- `docker compose down` -- for every target, so a
    Kubernetes workspace was warned about and skipped every time, leaving its
    namespace and PersistentVolumeClaim on the cluster indefinitely.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    ws = lc.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    monkeypatch.setattr(lc, "prunable", lambda: ["k"])
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc.runner, "down",
                        lambda *a, **kw: pytest.fail(
                            "it reached for `docker compose down` on Kubernetes"))
    deleted: list[tuple] = []
    monkeypatch.setattr(k8s, "delete_namespace",
                        lambda name, *, context, volumes, emit=None:
                            deleted.append((name, volumes)) or True)

    out = lc.prune(confirm=True)
    assert deleted == [("k", True)], "the namespace and its PVC must actually go"
    assert out["removed"] == ["k"]
    assert not lc.runner.workspace("k").exists(), "and the local record with it"


def test_reading_env_answers_from_the_container_on_kubernetes(monkeypatch, tmp_path):
    """`env` with no --set went through three states, and this pins the last one.

    First it raised a bare FileNotFoundError naming
    `repros/<n>/docker-compose.yml` -- a path, with no statement of what was wrong.
    That escaped the ReproError contract, so `serve` answered 500 to a request that
    is merely unsupported while `logs` and `stats` answered cleanly on the same
    workspace. Then it refused cleanly. Now it answers.

    From the RUNNING CONTAINER, which is not a translation of the Compose behaviour
    but better than it: the chart contributes variables houston never set, so
    neither the helm values nor any generated document would show them.

    `env --set` still refuses -- an environment variable cannot be changed inside a
    running container on either runtime, and here that means a helm upgrade.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import envvars, k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    ws = lc.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    assert not (ws / "docker-compose.yml").exists(), \
        "the absence of a compose file is the condition under test"

    monkeypatch.setattr(k8s, "container_env", lambda name, *, context: {
        "ROOT_URL": "http://localhost:3010", "ADMIN_PASS": "admin123"})
    out = envvars.current("k")
    keys = {r["key"]: r["value"] for r in out["env"]}
    assert keys["ROOT_URL"] == "http://localhost:3010"
    assert keys["ADMIN_PASS"] != "admin123", "credentials masked, as on Compose"

    # The WRITE path still refuses, and names the command that does the job.
    with pytest.raises(errors.ValidationError) as caught:
        envvars.set_env("k", {"A": "b"})
    assert "helm" in str(caught.value)
    assert caught.value.http_status == 400


def test_stop_says_so_when_the_operator_keeps_mongodb_running(monkeypatch):
    """An operator-managed MongoDB cannot be scaled to zero.

    The operator reconciles its StatefulSet straight back, and the Community operator
    has no way to pause reconciliation (checked upstream, not assumed). Two faults
    followed from not knowing that, and an audit of the operator path found both:

      * `stop` documents itself as giving the memory back. It gave back Rocket.Chat's
        and not MongoDB's, and said nothing -- so someone who ran `stop` to free the
        box was told it had worked.
      * The wait-for-pods-gone loop required EVERY pod to disappear, so every stop and
        every restart on this path burned the full POD_GONE_TRIES budget waiting for a
        pod that was never going to leave, then carried on regardless.

    The hand-written StatefulSet path is untouched: it scales to zero like anything
    else, and must not start paying for this.
    """
    from houston.services import k8s
    from houston.services.events import Event

    def cluster(*, operator: bool, pods: list[str]):
        """Stub kubectl for the handful of calls stop_workspace makes."""
        def run(argv, timeout=None, own=False, env=None):
            import subprocess as sp
            joined = " ".join(argv)
            if "mongodbcommunity" in joined:
                out = "mongodbcommunity.mongodbcommunity.mongodb.com/mongodb" \
                    if operator else ""
                return sp.CompletedProcess(argv, 0 if operator else 1, out, "")
            if "get pods" in joined or ("pods" in argv and "get" in argv):
                if "-l" in argv:                       # the mongo-only selector
                    keep = [p for p in pods if "mongodb" in p]
                    return sp.CompletedProcess(argv, 0, " ".join(keep), "")
                return sp.CompletedProcess(argv, 0, " ".join(pods), "")
            if "jsonpath={.spec.replicas}" in joined:
                return sp.CompletedProcess(argv, 0, "1", "")
            return sp.CompletedProcess(argv, 0, "", "")
        return run

    # --- the operator path: mongo is expected to survive ------------------
    monkeypatch.setattr(k8s, "run", cluster(operator=True, pods=["pod/mongodb-0"]))
    monkeypatch.setattr(k8s, "scale_workspace", lambda *a, **kw: 1)
    assert k8s.mongo_pods_the_operator_keeps("w", context="c") == {"pod/mongodb-0"}

    slept: list[float] = []
    seen: list[Event] = []
    k8s.stop_workspace("w", context="c", emit=seen.append, sleep=slept.append)
    assert not slept, (
        "it waited for a pod the operator will never remove; on the operator path "
        "every stop and restart paid the full timeout for nothing")
    text = " ".join(e.message for e in seen if e.level == "warn")
    assert "MongoDB stays up" in text, "stop must not claim memory it did not free"
    assert "--volumes" in text, "and must name what actually reclaims it"

    # --- the StatefulSet path: nothing survives, nothing is claimed --------
    monkeypatch.setattr(k8s, "run", cluster(operator=False, pods=[]))
    assert k8s.mongo_pods_the_operator_keeps("w", context="c") == set()
    seen.clear()
    k8s.stop_workspace("w", context="c", emit=seen.append, sleep=slept.append)
    assert not [e for e in seen if e.level == "warn"], \
        "the hand-written StatefulSet does scale to zero; do not warn about it"


def test_ready_speaks_for_every_probed_pod_not_just_the_first(monkeypatch):
    """`ready` used to read items[0].containerStatuses[0], which over-claimed twice.

    Found by an operational audit of a live microservices workspace:

      * With --replicas N it inspected ONE pod, so the workspace was declared ready
        on the strength of the first.
      * It only ever looked at the monolith container. `ddp-streamer` carries the
        WebSocket -- the realtime half of Rocket.Chat -- and was seen
        Running-but-not-Ready on a workspace `ready` had already called serving. A
        caller told "ready" could open the URL and find messages not arriving, which
        is the failure this tool exists to REPRODUCE, not to cause.

    account/authorization/presence are excluded on purpose: the chart ships them with
    no readinessProbe, so their pod-Ready flips as soon as the container starts and
    attests nothing. Waiting on it would cost time and buy no confidence.
    """
    import json as _json

    from houston.services import k8s

    def pods(*specs):
        """specs: (name, [ready flags]) -- no flags means Pending, no statuses."""
        items = []
        for pod_name, flags in specs:
            status = {"phase": "Pending" if flags is None else "Running"}
            if flags is not None:
                status["containerStatuses"] = [{"ready": f} for f in flags]
            items.append({"metadata": {"name": pod_name}, "status": status})
        return (0, _json.dumps({"items": items}))

    seen: list[list[str]] = []

    def stub(result):
        """Answer whichever output form the caller asked for.

        Deliberately format-aware, so this test is a real differential: the version
        being replaced asked for `-o jsonpath={.items[0]...ready}` and the new one
        asks for `-o json`. A stub that only spoke JSON would fail against the old
        code for the wrong reason -- output it could not parse -- and would prove
        nothing about the over-claiming this test is here to pin.
        """
        def run(argv, timeout=None, own=False, env=None):
            import subprocess as sp
            seen.append(argv)
            rc, payload = result
            if rc != 0:
                return sp.CompletedProcess(argv, rc, "", "")
            joined = " ".join(argv)
            if "jsonpath" in joined:
                items = _json.loads(payload).get("items") or []
                first = ((items[0].get("status", {}).get("containerStatuses") or [{}])[0]
                         if items else {})
                got = first.get("ready")
                return sp.CompletedProcess(
                    argv, 0, "" if got is None else str(got).lower(), "")
            return sp.CompletedProcess(argv, 0, payload, "")
        return run

    # One ready pod -- the monolith case, still true.
    monkeypatch.setattr(k8s, "run", stub(pods(("rc-0", [True]))))
    assert k8s.workspace_ready("w", context="c") is True

    # The selector must name both probed workloads and NEITHER unprobed one.
    argv = seen[-1]
    sel = argv[argv.index("-l") + 1]
    assert "rocketchat" in sel and "rocketchat-ddp-streamer" in sel, sel
    for unprobed in ("account", "authorization", "presence"):
        assert f"rocketchat-{unprobed}" not in sel, \
            f"{unprobed} has no readinessProbe, so waiting on it proves nothing"

    # THE items[0] BUG: three replicas, the third not ready.
    monkeypatch.setattr(k8s, "run", stub(
        pods(("rc-0", [True]), ("rc-1", [True]), ("rc-2", [False]))))
    assert k8s.workspace_ready("w", context="c") is False, \
        "a not-ready replica must not be hidden behind a ready first pod"

    # THE MICROSERVICES BUG: Rocket.Chat ready, ddp-streamer not.
    monkeypatch.setattr(k8s, "run", stub(
        pods(("rc-0", [True]), ("rc-ddp-streamer-0", [False]))))
    assert k8s.workspace_ready("w", context="c") is False, \
        "realtime is not serving, so the workspace is not ready"

    # A Pending pod has NO containerStatuses; "nothing failed" is not "ready".
    monkeypatch.setattr(k8s, "run", stub(pods(("rc-0", [True]), ("rc-ddp-0", None))))
    assert k8s.workspace_ready("w", context="c") is False

    # No pods at all is not ready either -- that is a torn-down workspace.
    monkeypatch.setattr(k8s, "run", stub(pods()))
    assert k8s.workspace_ready("w", context="c") is False

    # A sidecar that is not ready counts, even when the app container is.
    monkeypatch.setattr(k8s, "run", stub(pods(("rc-0", [True, False]))))
    assert k8s.workspace_ready("w", context="c") is False

    # kubectl failing is not readiness.
    monkeypatch.setattr(k8s, "run", stub((1, "")))
    assert k8s.workspace_ready("w", context="c") is False


def test_a_compose_only_operation_refuses_a_kubernetes_workspace(monkeypatch, tmp_path):
    """`stats` shells out to `docker stats` against a compose project, so it cannot
    serve a workspace that has no compose project. The refusal must name the
    alternative -- 'not supported' leaves the user to find what the person writing
    the message already knew."""
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                        mongo_tag="8.0", mongo_flavor="official", preset="default",
                        root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "services: {}\n", m)

    with pytest.raises(errors.ValidationError) as caught:
        topology.require_compose("k", "stats", instead="Use `kubectl top`.")
    assert "Kubernetes" in str(caught.value)
    assert "kubectl top" in str(caught.value), "the alternative is stated"

    # And it is SILENT for the runtime it is guarding -- a guard that fires on
    # compose would break every existing user of the command.
    topology.stamp(m.extra, topology.DOCKER)
    lc.runner.write("k", "services: {}\n", m)
    topology.require_compose("k", "stats")


def test_both_runtimes_are_registered_and_a_third_would_not_be():
    """Kubernetes joined `REGISTERED` only once its whole sequence -- cluster,
    namespace, MongoDB with an initiated replica set, the chart, a port-forward --
    ran on a live cluster rather than in stubs.

    Registration is what `up` consults, and it is deliberately separate from being
    SPELLABLE: a name can be recognised, and reported honestly as unavailable,
    before it works. That is how `kubernetes` behaved for six commits.
    """
    from houston.services import topology

    assert topology.REGISTERED == frozenset({topology.DOCKER, topology.KUBERNETES})
    assert topology.is_registered(topology.DOCKER)
    assert topology.is_registered(topology.KUBERNETES)
    assert not topology.is_registered("nomad")
    assert topology.normalize("k8s") == topology.KUBERNETES


def test_the_create_path_stamps_the_runtime_on_a_compose_workspace(monkeypatch, tmp_path):
    """The stamp has to happen on the REAL create path, not just be available as a
    helper. Compose workspaces are stamped too, deliberately: if only Kubernetes
    ones were, 'absent' would mean two different things -- an old workspace and a
    new compose one -- and no later reader could tell them apart.

    Captured at the `runner.write` seam, which is the last thing to see the
    metadata before it becomes repro.json.
    """
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    written: list = []
    monkeypatch.setattr(lc, "require_docker", lambda: None)
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **k: None)
    monkeypatch.setattr(lc.runner, "docker_kernel_version", lambda: "6.1.0")
    monkeypatch.setattr(lc.runner, "exists", lambda n: False)
    monkeypatch.setattr(lc.runner, "used_ports", lambda **k: set())
    monkeypatch.setattr(lc.runner, "port_free", lambda *a, **k: True)
    monkeypatch.setattr(lc.runner, "write",
                        lambda name, yaml, meta, files=None: written.append(meta))
    monkeypatch.setattr(lc.runner, "up", lambda *a, **k: 0)
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: type("R", (), {
                            "rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                            "mongo_flavor": "mongodb", "mongo_shell": "mongosh",
                            "oplog": False, "source": "test", "note": ""})())
    try:
        lc._create_repro_locked(lc.CreateReq(version="8.6.1", name="stamped"))
    except Exception:                       # noqa: BLE001
        pass                                # whatever happens AFTER the write is not this test
    assert written, "the create path never reached runner.write"
    assert written[0].extra.get("runtime") == topology.DOCKER, (
        "a workspace was written with no runtime recorded — every later reader "
        "would have to guess, which is the ambiguity this key exists to remove")


# --- the three axes -------------------------------------------------------------

def test_every_cell_of_the_runtime_deployment_matrix():
    """`--preset` used to carry two ideas at once -- the scenario AND the
    deployment shape -- because there was one axis to put them in. Of the nine
    presets shipped, eight are scenarios and exactly one, multi-instance, is a
    deployment: it adds a Traefik load balancer and a NATS mesh.

    Splitting them means `--preset` finally means the same thing in both runtimes.
    Every combination is decided in one function, because a rule enforced at two
    call sites eventually disagrees with itself.
    """
    from houston.services import topology as T

    ok = lambda **kw: T.resolve_axes(**kw)                                # noqa: E731

    # Defaults: omitting --runtime is the common case, not an error.
    assert (ok().runtime, ok().deployment, ok().replicas) == (T.DOCKER, T.MONOLITH, 1)
    # Kubernetes defaults to microservices, matching the chart's own default.
    k = ok(runtime="k8s")
    assert (k.runtime, k.deployment) == (T.KUBERNETES, T.MICROSERVICES)
    assert ok(runtime="k8s", deployment="monolith").deployment == T.MONOLITH
    # A scenario is a scenario regardless of where it runs -- the whole point.
    assert ok(preset="ldap").preset == "ldap"
    assert ok(runtime="k8s", preset="ldap").preset == "ldap"
    # multi-instance reaches the preset loader, which is how it stays compatible.
    m = ok(deployment="multi-instance", replicas=3)
    assert (m.preset, m.params["instances"], m.replicas) == ("multi-instance", 3, 3)
    assert ok(deployment="multi-instance").replicas == 2, "the preset's own default"


def test_the_refusals_name_what_to_do_instead(monkeypatch):
    """Each refusal is about coverage or physics -- never about category
    confusion. 'Is multi-instance a preset or a deployment?' stops being a
    question a user can get wrong, because there is one place it can live."""
    from houston.services import topology as T

    cases = [
        (dict(runtime="docker", deployment="microservices"), "--runtime kubernetes"),
        (dict(runtime="k8s", deployment="multi-instance"), "--runtime docker"),
        (dict(replicas=3), "--deployment multi-instance"),
        (dict(preset="ldap", deployment="multi-instance"), "separately"),
        (dict(preset="multi-instance", deployment="monolith"), "two different deployments"),
        (dict(runtime="nomad"), "Known runtimes"),
        (dict(deployment="sharded"), "Known deployments"),
        (dict(replicas=-1), "at least 1"),
    ]
    for kwargs, expect in cases:
        with pytest.raises(errors.ValidationError) as caught:
            T.resolve_axes(**kwargs)
        assert expect in str(caught.value), f"{kwargs} said {caught.value!r}"
        assert caught.value.exit_code == 2, "a bad combination is a usage error"

    # Resolving and being allowed stay separate questions, so a GUI can name a
    # runtime it cannot yet create. Both are registered now, so neither refuses --
    # the separation is what lets a THIRD runtime be named before it works.
    assert T.resolve_axes(runtime="k8s").runtime == T.KUBERNETES
    T.require_registered(T.KUBERNETES)
    T.require_registered(T.DOCKER)
    with pytest.raises(errors.ValidationError) as caught:
        T.require_registered("nomad")
    assert "not available in this build" in str(caught.value)


def test_the_old_spellings_keep_working_and_say_what_they_are_now():
    """Permanent aliases, not a deprecation with a deadline. They cost one dict
    lookup each, and breaking a command line that is pasted into support tickets
    buys nothing."""
    from houston.services import topology as T

    a = T.resolve_axes(preset="multi-instance", params={"instances": "3"})
    assert (a.deployment, a.replicas) == (T.MULTI_INSTANCE, 3)
    assert a.params["instances"] == "3", "the original param is preserved verbatim"
    assert any("--deployment multi-instance" in h for h in a.hints)
    assert any("--replicas 3" in h for h in a.hints)

    # #3's spelling: --deployment microservices with no --runtime means Kubernetes.
    b = T.resolve_axes(deployment="microservices")
    assert b.runtime == T.KUBERNETES
    assert any("implies --runtime kubernetes" in h for h in b.hints)

    # Nothing is deprecated about the NEW spelling, so it stays quiet.
    assert T.resolve_axes(deployment="multi-instance", replicas=3).hints == []


def test_rebuilding_a_workspace_does_not_nag_about_a_spelling_nobody_typed():
    """`restore` and the GUI's recreate button rebuild a request from a record.
    Both used to pass `preset=meta.preset`, which for a multi-instance workspace
    IS the legacy spelling -- so clicking Start printed a deprecation notice at a
    user who had typed neither flag."""
    from houston.services import topology as T

    m = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official",
                           preset="multi-instance", root_url="u", host_port=3000,
                           version_source="t",
                           extra={"runtime": "docker", "deployment": "multi-instance",
                                  "instances": 3})
    kwargs = T.axes_of_meta(m)
    assert kwargs == {"runtime": "docker", "deployment": "multi-instance",
                      "preset": "default", "replicas": 3}
    assert T.resolve_axes(**kwargs).hints == [], "rebuilding is not a deprecation"

    # A workspace older than the deployment key is not lost: for those the
    # deployment WAS the preset name, which is the ambiguity the split removes.
    old = lc.runner.Metadata(name="r", project="p", rc_version="8.5.1", rc_image="i",
                             mongo_tag="8.0", mongo_flavor="official",
                             preset="multi-instance", root_url="u", host_port=3000,
                             version_source="t")
    assert T.axes_of_meta(old)["deployment"] == T.MULTI_INSTANCE
    assert T.axes_of_meta(old)["runtime"] == T.DOCKER


# --- the Kubernetes preflight ---------------------------------------------------
# Phase 3 rung 1: `doctor` learns Kubernetes. Nothing here creates anything -- every
# function is a read, so these tests drive the whole surface with `k8s.run` stubbed.

def _fake_run(mapping):
    """Stub k8s.run: match on a substring of the joined argv."""
    import subprocess as sp

    def run(argv, timeout=None, own=False, env=None):
        # `env=` BECAUSE THE REAL ONE TAKES IT. This signature drifted: two probes in
        # the kubernetes block pass `env=helm_env(...)`, and a fake without the
        # parameter raises TypeError out of `k8s.preflight`, which doctor's outer
        # `except` swallows -- so the WHOLE kubernetes section silently vanished from
        # the report these tests then asserted over. The chart-repo probe has been
        # unexercised here for that reason; it is wrapped in its own bare `except`, so
        # nothing ever failed to say so.
        joined = " ".join(argv)
        # HELM REACHES THE CLUSTER unless a test says otherwise. `helm_reachable`
        # reports whatever a non-zero exit said, and "no stub" from the fallback below
        # would put a `fail` row in every doctor test that never mentioned helm. A
        # mapping that wants an UNREACHABLE helm says so with its own `helm list` key.
        if joined.startswith("helm list") and not any("helm list" in n for n in mapping):
            return sp.CompletedProcess(argv, 0, "", "")
        # A NAMESPACE-LABELS QUERY WITH NO STUB MEANS THE NAMESPACE IS NOT THERE,
        # which is what a create test is describing. Answered before the mapping
        # because the natural `"get namespace"` entry matches this query too, and
        # rc=0 with an empty body now reads as "exists, carrying no labels" -- an
        # unlabelled namespace is refused rather than adopted, since houston cannot
        # tell one an older version made from one somebody else made. A mapping that
        # wants to describe an EXISTING namespace says so with a `labels` key.
        if "{.metadata.labels}" in joined and not any("labels" in n for n in mapping):
            return sp.CompletedProcess(
                argv, 1, "",
                'Error from server (NotFound): namespaces "x" not found')
        for needle, (rc, out) in mapping.items():
            if needle in joined:
                return sp.CompletedProcess(argv, rc, out, "")
        return sp.CompletedProcess(argv, 1, "", "no stub")
    return run


def test_tool_versions_parse_the_three_formats_the_tools_actually_print():
    """Each tool spells its version differently, and all three strings below are
    real output from this machine. A parser that only handled one would report a
    present tool as unknown and, with a floor to check, refuse to proceed."""
    from houston.services import k8s

    assert k8s._parse_version("kind v0.32.0 go1.26.3 linux/amd64") == (0, 32, 0)
    assert k8s._parse_version("Client Version: v1.36.3") == (1, 36, 3)
    assert k8s._parse_version("v4.2.3+g43e8b7f") == (4, 2, 3)
    assert k8s._parse_version("something unparseable") == ()


def test_an_unparseable_version_is_not_treated_as_too_old():
    """A distro may print something this does not recognise. Refusing to proceed
    over an unrecognised version string is worse than trying: the binary is there,
    and the floor exists to catch a genuinely ancient one, not to gate on parsing."""
    from houston.services import k8s

    assert k8s.Tool(name="helm", path="/usr/bin/helm", raw="weird").new_enough
    assert not k8s.Tool(name="helm", path="/usr/bin/helm", version=(2, 17)).new_enough
    assert k8s.Tool(name="helm", path="/usr/bin/helm", version=(3, 0)).new_enough
    assert not k8s.Tool(name="helm").present


def test_a_missing_binary_never_raises_out_of_the_seam():
    """`doctor` is the command someone runs BECAUSE things are wrong. If the seam
    raised on a missing binary, every call site would need a wrapper and one
    forgotten wrapper takes down the whole report."""
    from houston.services import k8s

    res = k8s.run(["definitely-not-a-real-binary-xyz", "version"])
    assert res.returncode != 0
    assert res.stdout == ""


def test_namespaces_are_selected_by_label_never_by_name(monkeypatch):
    """The safety property. Anyone can create a namespace called
    `houston-anything`; a teardown matching on the prefix would eventually delete
    one houston never made. Asserted on the argv, because that is the thing that
    reaches the cluster."""
    from houston.services import k8s

    seen = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        seen.append(argv)
        # `-o json`: `workspace_namespaces` goes through `ask_list` now, because it
        # has to be able to say "I could not ask" -- `-o name` cannot carry that,
        # and a stub answering the old shape leaves the destructive callers
        # untested against the very case this is about.
        return sp.CompletedProcess(argv, 0, json.dumps({"items": [{"metadata": {"name": "houston-t1"}}]}), "")

    monkeypatch.setattr(k8s, "run", spy)
    assert k8s.workspace_namespaces() == ["houston-t1"]
    argv = seen[0]
    assert "-l" in argv and k8s.OWNER_SELECTOR in argv, argv
    # The context legitimately contains the prefix (kind-houston-local). What must
    # not appear is a SELECTOR built from the name: no field-selector, and no
    # argument that is the prefix used as a match.
    selectors = [a for i, a in enumerate(argv)
                 if i and argv[i - 1] not in ("--context",) and a != "--context"]
    assert not any(a.startswith("--field-selector") for a in selectors), argv
    assert not any(a.strip('"\'') == k8s.NAMESPACE_PREFIX for a in selectors), argv


def test_the_release_is_named_as_the_official_docs_name_it():
    """PR #3 calls the release `rc`. The official guide calls it `rocketchat`, and
    with one release per namespace there is no reason to differ -- so every command
    copied from docs.rocket.chat works by substituting the namespace alone."""
    from houston.services import k8s

    assert k8s.RELEASE == "rocketchat"
    assert k8s.CLUSTER_NAME == "houston-local"


def test_preflight_stops_before_asking_a_cluster_that_is_not_there(monkeypatch):
    """Ordering matters: asking an absent API server for storage classes would time
    out, and the timeout would be reported as "no storage" -- a wrong answer that
    sends someone to fix the wrong thing."""
    from houston.services import k8s

    asked = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        asked.append(" ".join(argv))
        if "get clusters" in " ".join(argv):
            return sp.CompletedProcess(argv, 0, "kind\n", "")
        return sp.CompletedProcess(argv, 0, "v1.0.0", "")

    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", spy)
    pre = k8s.preflight()
    assert pre.cluster_exists is False
    assert pre.other_clusters == ["kind"]
    assert not any("storageclass" in a for a in asked), \
        "it asked an absent cluster for storage"


def test_doctor_stays_quiet_about_kubernetes_when_nobody_is_using_it(monkeypatch, tmp_path):
    """A doctor that reports FAIL for a feature you are not using teaches people to
    ignore its failures. With no tools and no Kubernetes workspace, the whole
    subject is one informational line -- not five rows of absence."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda _t: "")
    report = doctor.run_checks()
    kube = [r for r in report["checks"] if "ubernetes" in r["message"]]
    assert len(kube) == 1, f"expected one line, got {[r['message'] for r in kube]}"
    assert kube[0]["status"] == "ok"
    assert "unaffected" in kube[0]["message"]


def test_doctor_fails_when_a_kubernetes_workspace_exists_but_the_tools_do_not(
        monkeypatch, tmp_path):
    """The same finding, opposite severity. A workspace that cannot be reached OR
    TORN DOWN is a real fault -- and the teardown half is what makes it urgent,
    because the resources keep running."""
    from houston.services import doctor, k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "services: {}\n", m)

    monkeypatch.setattr(k8s, "which", lambda _t: "")
    report = doctor.run_checks()
    kube = [r for r in report["checks"] if "Kubernetes workspace(s) exist" in r["message"]]
    assert len(kube) == 1, [r["message"] for r in report["checks"]]
    assert kube[0]["status"] == "fail"
    assert "torn down" in kube[0]["message"]
    assert report["verdict"] == "fail"


def test_a_cluster_with_no_default_storageclass_is_reported(monkeypatch, tmp_path):
    """The guide opens with this warning: local distributions "often ship without a
    storage provisioner enabled". The failure it causes is silent -- a PVC stays
    Pending forever and nothing in the output names storage."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": []}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    report = doctor.run_checks()
    sc = [r for r in report["checks"] if "StorageClass" in r["message"]]
    assert len(sc) == 1 and sc[0]["status"] == "warn", [r["message"] for r in report["checks"]]
    assert "Pending" in sc[0]["message"], "it must name the symptom, not just the cause"


def test_a_stopped_docker_is_not_reported_as_a_missing_cluster(monkeypatch, tmp_path):
    """`kind` talks to Docker. With Docker stopped, `kind get clusters` exits
    non-zero -- which reads as an empty list if only stdout is consulted, and
    "your cluster does not exist" is then a WRONG answer that sends someone to
    create a cluster that is already there.

    The two are kept apart: answered-no and could-not-ask.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "get clusters": (1, ""),          # non-zero: Docker is down
        "version": (0, "v9.9.9"),
    }))
    found, why = k8s.clusters()
    assert found == [] and why, "the reason must survive, not be flattened to []"

    report = doctor.run_checks()
    msgs = [r["message"] for r in report["checks"]]
    assert any("Could not tell whether cluster" in m for m in msgs), msgs
    assert not any("does not exist" in m for m in msgs), \
        "it claimed the cluster is absent when it merely could not ask"


def test_kubernetes_works_without_kind_because_kind_only_creates_clusters(monkeypatch):
    """kind is needed to PROVISION a cluster, never to USE one.

    Namespaces, helm releases, PVCs, port-forwards and exec are plain Kubernetes.
    They behave the same on k3s, minikube, Docker Desktop or a remote cluster, so a
    box with kubectl and helm and no kind is fully usable -- it just cannot be
    handed a cluster, it has to be pointed at one.

    The first cut of this module returned early when kind was absent, which made a
    perfectly good k3s box look like it had no Kubernetes at all.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s, "which", lambda t: "" if t == "kind" else f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "config current-context": (0, "k3s-default\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": [{"metadata": {"name": "local-path",'
                                ' "annotations": {"storageclass.kubernetes.io/'
                                'is-default-class": "true"}}}]}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    pre = k8s.preflight()
    assert pre.tools_ready, "kubectl + helm is all that USING Kubernetes needs"
    assert not pre.can_provision, "without kind it cannot create a cluster"
    assert pre.missing_tools == [], "a missing kind is not a missing requirement"
    assert pre.context == "k3s-default", "it fell back to the configured cluster"
    assert pre.provider == k8s.PROVIDER_EXTERNAL
    assert pre.cluster_reachable and pre.usable
    assert pre.default_storage_class == "local-path"


def test_a_cluster_houston_did_not_create_is_marked_external(monkeypatch):
    """The ownership rule at the right granularity. houston may delete a cluster
    it created; in one you supplied it owns only the namespaces it labelled, and
    the cluster itself is never its to remove."""
    from houston.services import k8s

    # No kind: the bring-your-own path, where the cluster kubectl points at is
    # adopted. With kind INSTALLED houston creates its own instead of adopting
    # anyone's, so that is not the setup this rule is about.
    monkeypatch.setattr(k8s, "which", lambda t: "" if t == "kind" else f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "get clusters": (0, "somebody-elses\n"),
        "config current-context": (0, "kind-somebody-elses\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": []}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    pre = k8s.preflight()
    assert pre.cluster_exists is False, "ours is not among them"
    assert pre.provider == k8s.PROVIDER_EXTERNAL
    assert pre.context == "kind-somebody-elses"
    assert pre.will_create is False, "a cluster houston cannot make is never one it creates"

    # And ours, when it IS there, is the one houston may manage fully.
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": []}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    ours = k8s.preflight()
    assert ours.cluster_exists and ours.provider == k8s.PROVIDER_KIND
    assert ours.context == k8s.CONTEXT


def test_doctor_names_both_ways_to_get_a_cluster_when_there_is_none(monkeypatch, tmp_path):
    """kubectl and helm but nothing to point them at. Naming only kind would be
    wrong -- pointing at an existing k3s or Docker Desktop cluster is equally
    valid, and for most people already done."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: "" if t == "kind" else f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "config current-context": (1, ""),
        "version": (0, "v9.9.9"),
    }))
    msgs = [r["message"] for r in doctor.run_checks()["checks"]]
    hit = [m for m in msgs if "No Kubernetes cluster configured" in m]
    assert len(hit) == 1, msgs
    assert "kind" in hit[0] and "k3s" in hit[0], "both routes must be named"


def test_the_cluster_in_use_is_not_also_listed_as_another_cluster(monkeypatch, tmp_path):
    """It described the same cluster twice -- "Using your cluster 'kind-kind'"
    followed by "1 other kind cluster(s) (kind)" -- and the second mention reads as
    a different one."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\nsomebody-elses\n"),
        "config current-context": (0, f"{k8s.CONTEXT}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": [{"metadata": {"name": "standard",'
                                ' "annotations": {"storageclass.kubernetes.io/'
                                'is-default-class": "true"}}}]}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    msgs = [r["message"] for r in doctor.run_checks()["checks"]]
    assert any(f"Cluster {k8s.CLUSTER_NAME!r} reachable" in m for m in msgs), msgs
    others = [m for m in msgs if "other kind cluster" in m]
    assert len(others) == 1 and "somebody-elses" in others[0], others
    assert k8s.CLUSTER_NAME not in others[0], \
        "the cluster in use was counted again as an 'other' one"


def test_the_kubeconfig_note_matches_which_cluster_the_workspace_is_in(monkeypatch):
    """The note said `export KUBECONFIG=<houston's own>` on every Kubernetes
    workspace. On a cluster houston ADOPTED that is wrong three ways -- it created no
    cluster, that file does not describe yours, and your kubectl already pointed at the
    right one -- so pasting step 1 broke the shell it was pasted into. houston only
    keeps its own kubeconfig for the cluster it created (`own=is_ours(context)`), and
    the note has to say the same thing the code does."""
    from houston import runner
    from houston.services import k8s, lifecycle as lc

    def note_text(context):
        meta = runner.Metadata(
            name="w", project=k8s.namespace_for("w"), rc_version="8.5.1",
            rc_image="registry.rocket.chat/rocketchat/rocket.chat:8.5.1",
            mongo_tag="8.0", mongo_flavor="community", preset="default",
            root_url="http://localhost:3000", host_port=3000,
            version_source="shipped")
        meta.extra.update({"runtime": "kubernetes", "namespace": k8s.namespace_for("w"),
                           "context": context, "deployment": "monolith"})
        return "\n".join(lc.flatten_notes(lc.note_groups_of(meta)))

    ours = note_text(k8s.CONTEXT)
    assert "export KUBECONFIG=" in ours, ours
    assert str(k8s.owned_kubeconfig()) in ours

    adopted = note_text("default")
    assert "export KUBECONFIG=" not in adopted, \
        "told the user to export a kubeconfig that does not describe their cluster"
    assert str(k8s.owned_kubeconfig()) not in adopted
    assert "'default'" in adopted, adopted


def test_doctor_names_the_cluster_up_would_actually_use(monkeypatch, tmp_path):
    """A box with BOTH kind and k3s. `doctor` resolved the cluster itself -- kind's
    if one existed, else whatever kubectl pointed at -- and `up` asked
    `plan_cluster`, which creates houston's own whenever kind is installed. With
    kind present but no cluster yet and k3s running, the two disagreed: the report
    said "Using your cluster 'default' (k3s)" and `up` went and built a kind
    cluster. A preflight whose whole job is predicting a boot cannot be a second
    opinion about it."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "get clusters": (0, "\n"),            # kind installed, no cluster yet
        "config current-context": (0, "default\n"),   # ...but k3s is up and active
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": []}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))

    plan = k8s.plan_cluster()
    pre = k8s.preflight()
    assert pre.context == plan.context, "doctor and up must name the same cluster"
    assert pre.will_create is plan.create

    msgs = [r["message"] for r in doctor.run_checks()["checks"]]
    assert not any("Using your cluster 'default'" in m for m in msgs), \
        "reported a cluster that up would not touch"
    assert any(f"No cluster yet — {k8s.CLUSTER_NAME!r} is created on first use" in m
               for m in msgs), msgs
    # ...and the one being set aside is still named, or the next question is why
    # houston is building a second cluster next to a working one.
    assert any("will NOT be used" in m and "'default'" in m for m in msgs), msgs


def test_doctor_reports_the_cluster_that_took_the_edge_s_port(monkeypatch, tmp_path):
    """Silent until now, and it breaks a working setup. k3s's ServiceLB claims host
    :80/:443 with a hostPort -- CNI portmap DNAT, not a socket bind -- so nothing errors,
    no pod fails, and kube-proxy's KUBE-SERVICES chain gets the packet before Docker's.
    Measured on this box: the edge's own GUI name answered 404 through the host and 502
    direct to the edge, with nothing connecting the two.

    The cluster that does it need not be the one houston is USING. On the box where this
    was measured it was not: houston had chosen kind, which has no LoadBalancer, while
    the k3s alongside it held the port."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    chosen = k8s.Preflight(tools={
        n: k8s.Tool(name=n, path=f"/usr/bin/{n}", version=(9, 9, 9), raw="v9.9.9")
        for n in ("kubectl", "helm")})
    # NOT reachable, deliberately: houston's own cluster does not exist yet, which is
    # the state the box was in when this fired for real. The check used to live inside
    # the reachable-cluster block, so on exactly that box it never ran.
    chosen.context = k8s.CONTEXT
    chosen.distribution = "kind"
    chosen.cluster_reachable = False
    chosen.will_create = True
    monkeypatch.setattr(k8s, "preflight", lambda *a, **k: chosen)
    monkeypatch.setattr(k8s, "active_context", lambda: "default")
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, **kw: True)
    monkeypatch.setattr(k8s.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(k8s, "loadbalancer_service",
                        lambda ctx: ("traefik", "172.16.0.2") if ctx == "default" else ("", ""))
    monkeypatch.setattr(k8s, "cert_manager_installed", lambda ctx: False)
    monkeypatch.setattr(k8s, "host_port_claim",
                        lambda ctx, **kw: k8s.PortClaim(
                            context=ctx, service="kube-system/traefik",
                            address="172.16.0.2", ports=[80, 443])
                        if ctx == "default" else None)

    from houston.services import edge as edgesvc
    monkeypatch.setattr(edgesvc, "installed", lambda: True)
    monkeypatch.setattr(edgesvc, "registered", lambda: [])
    monkeypatch.setattr(edgesvc, "current",
                        lambda: type("E", (), {"domain": "gui.example.test"})())

    rows = doctor.run_checks()["checks"]
    hit = [r for r in rows if r.get("check") == "kubernetes-edge-port"]
    assert hit, [r["message"][:60] for r in rows]
    assert hit[0]["status"] == "warn", hit[0]
    assert "'default'" in hit[0]["message"], "name the cluster that took it"
    assert "172.16.0.2" in hit[0]["message"], "and the address"
    # The GUI's own name is what breaks, and counting workspace routes alone reported
    # "0 names" about a real outage.
    assert "gui.example.test" in hit[0]["message"], hit[0]["message"]

    # No edge, no conflict: the cluster holding the port is then simply how it works.
    monkeypatch.setattr(edgesvc, "installed", lambda: False)
    assert not [r for r in doctor.run_checks()["checks"]
                if r.get("check") == "kubernetes-edge-port"]

    # The capability facts -- cert-manager among them -- belong to a cluster that
    # ANSWERS, and there is none here. They are covered where a reachable one is stubbed;
    # asserting them in this test is what tied the port check to reachability originally.
    assert not [r for r in doctor.run_checks()["checks"]
                if r.get("check") == "kubernetes-cert-manager"], \
        "described a cluster that is not there"


def test_missing_storage_is_a_refusal_because_nothing_would_ever_log_it():
    """The reason this cannot be left to the logs.

    With no provisioner the PVC stays Pending, the pod stays Pending, and
    Rocket.Chat NEVER STARTS -- so there are no Rocket.Chat logs to find it in.
    Left to run it costs the full readiness timeout and then reports "Rocket.Chat
    did not become ready", which blames the one component that is innocent and
    sends someone to debug it.

    Same reasoning as the mongo/kernel gate: there is no case where continuing
    works, so a warning would only be a slower failure.
    """
    from houston.services import k8s

    none_at_all = k8s.Preflight(context="c", cluster_reachable=True)
    msg = k8s.storage_blocker(none_at_all)
    assert msg, "an unprovisioned cluster must be refused"
    assert "never start" in msg, "it must name the symptom"
    assert "logs" in msg, "and say why the logs will not show it"

    # A cluster with classes but no DEFAULT is the subtler half, and fails the
    # same way -- so it gets the command that fixes it.
    no_default = k8s.Preflight(context="c", cluster_reachable=True,
                               storage_classes=["fast", "slow"])
    msg2 = k8s.storage_blocker(no_default)
    assert "none is marked default" in msg2
    assert "kubectl patch storageclass" in msg2, "name the fix, not just the fault"

    # Provisioned: silent.
    ok = k8s.Preflight(context="c", cluster_reachable=True,
                       storage_classes=["standard"], default_storage_class="standard")
    assert k8s.storage_blocker(ok) == ""


def test_storage_is_not_reported_for_a_cluster_nobody_could_reach():
    """Reporting "no StorageClass" for an unreachable cluster is the same wrong
    answer as reporting an absent cluster for a stopped Docker: it sends someone
    to fix storage when the problem is that nothing answered."""
    from houston.services import k8s

    unreachable = k8s.Preflight(context="c", cluster_reachable=False)
    assert k8s.storage_blocker(unreachable) == ""


def test_doctor_never_warns_about_ingress(monkeypatch, tmp_path):
    """This used to assert `doctor` did not MENTION ingress at all, on the reasoning that
    it cannot know whether you are about to ask for `--domain` and most workspaces never
    do. That reasoning was about not nagging, and it still holds -- but silence turned out
    to be the wrong way to keep it: on a cluster that already has an ingress controller
    (k3s ships Traefik) the report left a reader unable to see the one thing that
    distinguishes their cluster from a kind one.

    So it is reported as a FACT and never as a warning. Severity still belongs to whatever
    needs it, which is `ensure_ingress` adopting or installing one at create time.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": [{"metadata": {"name": "standard",'
                                ' "annotations": {"storageclass.kubernetes.io/'
                                'is-default-class": "true"}}}]}'),
        "get ingressclass": (0, ""),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    rows = doctor.run_checks()["checks"]
    ingress = [r for r in rows if "ingress" in r["message"].lower()]
    # SEVERITY, not a row count. Two rows mention it now: the fact itself, and the
    # `kubernetes-https` summary saying which shape the box is in. Asserting a count
    # made this test about the report's length rather than about nagging, which is the
    # property it exists to protect.
    assert ingress, "the fact is worth reporting — k3s having one is what tells that "\
                    "cluster apart from a kind one"
    assert {r["status"] for r in ingress} == {"ok"}, \
        "an absent ingress controller is not a fault"
    assert "kubernetes-ingress" in {r["check"] for r in ingress}
    assert "port-forward" in ingress[0]["message"], \
        "and it says why its absence does not matter"
    # Nothing anywhere in the report escalates over it.
    assert not any(r["status"] in ("warn", "fail") and "ingress" in r["message"].lower()
                   for r in rows)


def test_houston_never_rewrites_the_users_kubeconfig(monkeypatch, tmp_path):
    """The one way creating a cluster genuinely disturbs existing work.

    `kind create cluster` writes ~/.kube/config AND switches current-context to the
    cluster it just made. Without isolation, somebody working in their own cluster
    runs `houston up` and their next `kubectl get pods` answers from somewhere
    else -- with no indication anything moved.

    So anything touching houston's OWN cluster runs with KUBECONFIG and all five
    Helm homes pointed inside HOUSTON_HOME. Adopted from PR #3.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    env = k8s.owned_env()
    assert env["KUBECONFIG"].startswith(str(tmp_path)), env["KUBECONFIG"]
    for var in ("HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME",
                "HELM_REPOSITORY_CONFIG", "HELM_REPOSITORY_CACHE"):
        assert env[var].startswith(str(tmp_path)), f"{var} escapes to the user's home"
    # Pinning only repositories.yaml would still leave cache and data writes in
    # ~/.config/helm, which is why all of them move.
    assert k8s.owned_kubeconfig().parent.is_dir()


def test_isolation_is_derived_from_the_target_not_chosen_at_the_call_site(monkeypatch):
    """`own` is never passed by hand. Each function derives it from the context it
    is targeting, so forgetting it is not a thing that can happen -- and the
    discovery path deliberately stays ambient, because reading the cluster you
    already configured is the entire point of it."""
    from houston.services import k8s

    seen = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        seen.append((own, " ".join(argv)))
        return sp.CompletedProcess(argv, 0, "ok", "")

    monkeypatch.setattr(k8s, "run", spy)
    k8s.reachable(k8s.CONTEXT)          # ours -> isolated
    k8s.reachable("k3s-default")        # theirs -> ambient
    assert seen[0][0] is True, "our own cluster must not use the ambient kubeconfig"
    assert seen[1][0] is False, "their cluster must be read from their kubeconfig"

    # And discovery of the active context is ambient by definition.
    seen.clear()
    k8s.active_context()
    assert seen[0][0] is False, "discovery must read the config the user set up"


# --- capacity knows what Kubernetes costs ---------------------------------------

def test_a_kubernetes_workspace_is_not_charged_as_a_compose_one(monkeypatch, tmp_path):
    """`check_capacity` computed `WORKSPACE_MB + PRESET_MB` and nothing about the
    runtime, so a Kubernetes workspace was billed as if it were Compose -- missing a
    control plane (573 MiB measured) and five extra Node processes.

    This function exists because seven concurrent stacks OOM-killed a 10 GB host.
    Under-charging is not a rounding error here: the OOM killer picks its own
    victim, so it destroys somebody else's work.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda _t: "")     # no cluster of ours

    compose = lc.CreateReq(version="8.6.1")
    assert lc._kube_overhead_mb(compose) == 0, "Compose must be unaffected"

    # Kubernetes with nothing resolved: an empty deployment means that runtime's
    # DEFAULT, which is microservices -- the expensive one. Reading empty as free
    # would under-charge the common case.
    default_k8s = lc.CreateReq(version="8.6.1", runtime="kubernetes")
    assert lc._kube_overhead_mb(default_k8s) == (lc.CLUSTER_MB + lc.KUBE_CHART_MB
                                                + lc.MICROSERVICES_MB)

    mono = lc.CreateReq(version="8.6.1", runtime="k8s",
                        deployment=topology.MONOLITH)
    # A "monolith" on this chart is five pods, not two -- it runs NATS regardless
    # of microservices.enabled -- so it pays for the cluster AND the chart baseline.
    assert lc._kube_overhead_mb(mono) == lc.CLUSTER_MB + lc.KUBE_CHART_MB


def test_the_control_plane_is_charged_only_when_one_is_about_to_be_built(monkeypatch, tmp_path):
    """It is shared, so billing it to the second and third workspace would refuse creates
    the host could hold -- and a capacity check that is wrong in the safe direction still
    stops people using the tool, which is how they learn to pass --force by reflex.

    The charge now turns on whether this create will BUILD a control plane, which is the
    only case where its memory is new.
    """
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    req = lc.CreateReq(version="8.6.1", runtime="k8s", deployment=topology.MONOLITH)

    assert lc._kube_overhead_mb(req, provisioning=True) == lc.CLUSTER_MB + lc.KUBE_CHART_MB, \
        "the create that builds the cluster pays for it"
    assert lc._kube_overhead_mb(req, provisioning=False) == lc.KUBE_CHART_MB, \
        "the rest share the cluster but still pay for their own chart"


def test_a_cluster_that_is_already_running_is_not_charged_for(monkeypatch, tmp_path):
    """INVERTED, deliberately, and the old reasoning is worth recording.

    This charge used to be keyed on whether houston's OWN kind cluster existed, on the
    argument that "somebody else's cluster being up does not mean the control plane is
    already paid for" -- true while houston always created its own alongside, and wrong
    the moment it can use one that is already running, where the 600 MB is spent whatever
    this create does. Charging it anyway refuses creates the box can hold, on a box whose
    only cluster is the one about to be adopted.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    req = lc.CreateReq(version="8.6.1", runtime="kubernetes", deployment=topology.MONOLITH)
    # A k3s cluster that is up: nothing to build, so nothing to charge.
    monkeypatch.setattr(k8s, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context="default", distribution="k3s", create=False))
    assert lc._will_provision(req) is False
    assert lc._kube_overhead_mb(req, lc._will_provision(req)) == lc.KUBE_CHART_MB

    # And with kind and no cluster yet, the control plane is real and is charged.
    monkeypatch.setattr(k8s, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context=k8s.CONTEXT, distribution="kind", create=True))
    assert lc._will_provision(req) is True
    assert lc._kube_overhead_mb(req, lc._will_provision(req)) == \
        lc.CLUSTER_MB + lc.KUBE_CHART_MB


def test_no_cluster_and_no_kind_charges_nothing_because_the_create_refuses(monkeypatch, tmp_path):
    """The old rule was "an unprobeable cluster is charged for", on the reasoning that
    assuming it exists would let the create through and spend the memory anyway.

    There is nothing to be safe about any more: the only thing `plan_cluster` raises for
    is having no cluster AND no way to make one, and that create is refused before a byte
    is written. Charging for a control plane that will never be built would refuse for
    memory a create was never going to spend.
    """
    from houston.services import k8s, topology
    from houston.errors import PreflightError

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    def refuse(*_a, **_k):
        raise PreflightError("kind is not installed, ...")
    monkeypatch.setattr(k8s, "plan_cluster", refuse)
    # MONOLITH explicitly: an empty deployment means "that runtime's default", which for
    # Kubernetes is microservices and carries its own 800 MB.
    req = lc.CreateReq(version="8.6.1", runtime="k8s", deployment=topology.MONOLITH)
    assert lc._will_provision(req) is False
    assert lc._kube_overhead_mb(req, lc._will_provision(req)) == lc.KUBE_CHART_MB


def test_the_kubernetes_overhead_actually_reaches_the_refusal(monkeypatch, tmp_path):
    """The helper existing is not the same as it being used. Asserted end-to-end
    through `check_capacity`, because a correct estimate nothing consults refuses
    nothing -- and the first version of this change computed the overhead and then
    did not add it to `need`.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # A kind box with no cluster yet, so the control plane is part of the bill. STATED
    # rather than probed: `check_capacity` now asks which cluster it would use, and a
    # unit test must not depend on whether one happens to be running on the machine.
    monkeypatch.setattr(k8s, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context=k8s.CONTEXT, distribution="kind", create=True))
    # A host with room for exactly one Compose workspace and no more.
    need_k8s = (lc.WORKSPACE_MB + lc.CLUSTER_MB + lc.KUBE_CHART_MB
                + lc.MICROSERVICES_MB)
    tight = lc.WORKSPACE_MB + 200
    monkeypatch.setattr(lc.runner, "host_memory",
                        lambda: (8000, tight + lc.host_reserve_mb(8000), 0))
    monkeypatch.setattr(lc.runner, "list_meta", lambda: [])

    # Compose fits.
    lc.check_capacity(lc.CreateReq(version="8.6.1"), "default")
    # The same host cannot hold a Kubernetes one, and must say so.
    with pytest.raises(errors.PreflightError) as caught:
        lc.check_capacity(lc.CreateReq(version="8.6.1", runtime="kubernetes"),
                          "default")
    assert need_k8s > tight, "the fixture must actually be too small"
    assert f"{need_k8s} MB" in str(caught.value), "the bill must include the Kubernetes parts"
    # And it is a PREFLIGHT failure, not a "poll again". errors.py already said so
    # -- "capacity shortfalls ... use this" -- while the code raised NotReadyError,
    # exit 5, which tells a script to retry something retrying cannot fix. Polling
    # does not free memory. Same argument that moved `require_docker` off exit 5.
    assert caught.value.exit_code == 3, "a full host is a preflight failure"
    assert caught.value.code == "PREFLIGHT_FAILED"


# --- provisioning ---------------------------------------------------------------

def test_creating_a_cluster_never_writes_the_users_kubeconfig(monkeypatch, tmp_path):
    """kind writes the file it is GIVEN and also honours KUBECONFIG for the context
    switch, so both are set. Verified live as well -- a real `kind create` left
    ~/.kube/config byte-identical and current-context on kind-kind -- but pinned
    here because the live check is not in CI."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    calls = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        calls.append((own, argv))
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    assert k8s.ensure_cluster() == k8s.CONTEXT
    create = [a for own, a in calls if "create" in a]
    assert create, calls
    argv = create[0]
    assert "--kubeconfig" in argv, "kind must be told where to write"
    assert str(tmp_path) in argv[argv.index("--kubeconfig") + 1], \
        "it wrote outside HOUSTON_HOME"
    assert all(own for own, a in calls if "create" in a), \
        "the create must also run with the redirected environment"


def test_a_second_up_reuses_the_cluster_instead_of_racing_to_create_it(monkeypatch, tmp_path):
    """Two simultaneous `up`s would both see no cluster and both run `kind create`;
    the second fails with "node(s) already exist". The re-check inside the lock
    means the loser reuses rather than retries -- concurrent workspaces are the
    whole point of one-cluster-many-namespaces."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    created = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "create" in argv:
            created.append(argv)
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    k8s.ensure_cluster()
    assert not created, "it created a cluster that was already there"


def test_a_create_that_lost_a_race_is_success_not_failure(monkeypatch, tmp_path):
    """Somebody ran `kind create cluster --name houston-local` by hand while we
    held the lock. "already exist" means the thing we wanted is true."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "create" in argv:
            return sp.CompletedProcess(argv, 1, "", "node(s) already exist for a "
                                                     "cluster with the name")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    assert k8s.ensure_cluster() == k8s.CONTEXT

    # A create that fails for any OTHER reason is terminal, and says why.
    def broken(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        if "create" in argv:
            return sp.CompletedProcess(argv, 1, "", "ERROR: failed to pull image")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", broken)
    with pytest.raises(errors.CreateFailedError) as caught:
        k8s.ensure_cluster()
    assert "failed to pull image" in str(caught.value), "the reason must reach the user"
    assert caught.value.exit_code == 7, "known dead, not 'poll again'"


def test_ensure_cluster_refuses_without_kind_and_names_the_alternative(monkeypatch, tmp_path):
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda _t: "")
    with pytest.raises(errors.PreflightError) as caught:
        k8s.ensure_cluster()
    assert "point kubectl at a cluster you already have" in str(caught.value)
    assert caught.value.exit_code == 3


def test_deleting_the_cluster_can_only_ever_target_our_own(monkeypatch, tmp_path):
    """The safety property. There is no parameter for which cluster to delete,
    because a delete that can be pointed anywhere eventually is. Asserted on the
    argv, since that is what reaches the machine.

    Verified live too: after `delete_cluster`, the unrelated `kind` cluster on this
    box was still there.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    seen = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        seen.append(argv)
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, f"kind\n{k8s.CLUSTER_NAME}\nother\n", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "get namespace" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    assert k8s.delete_cluster() is True
    deletes = [a for a in seen if "delete" in a]
    assert len(deletes) == 1, deletes
    argv = deletes[0]
    # The property is about the --name VALUE, not about the whole argv: `kind` is
    # legitimately argv[0], the binary.
    assert argv[argv.index("--name") + 1] == k8s.CLUSTER_NAME, argv
    # And no other cluster the machine happens to have is named anywhere in it.
    targets = argv[argv.index("--name") + 1:]
    assert targets == [k8s.CLUSTER_NAME], f"more than our cluster is targeted: {targets}"


def test_the_cluster_is_not_taken_out_from_under_a_colleagues_workspace(monkeypatch, tmp_path):
    """On a shared box the cluster holds other people's workspaces. `prune`
    reclaiming it mid-ticket is the failure this guards, and the namespaces carry
    an owner label so the refusal can be specific."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    deleted = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "get namespace" in j:
            # `-o json`: `workspace_namespaces` goes through `ask_list` now, because it
            # has to be able to say "I could not ask" -- `-o name` cannot carry that,
            # and a stub answering the old shape leaves the destructive callers
            # untested against the very case this is about.
            return sp.CompletedProcess(argv, 0, json.dumps({"items": [{"metadata": {"name": "houston-t1"}}, {"metadata": {"name": "houston-t2"}}]}), "")
        if "delete" in argv:
            deleted.append(argv)
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    with pytest.raises(errors.ConflictError) as caught:
        k8s.delete_cluster()
    assert "2 workspace namespace(s)" in str(caught.value)
    assert "houston-t1" in str(caught.value), "name them, so it is actionable"
    assert not deleted, "it deleted the cluster anyway"

    # --force takes it, because sometimes that is what you want.
    assert k8s.delete_cluster(force=True) is True
    assert deleted, "--force must actually delete"


def test_deleting_a_cluster_that_is_not_there_is_not_an_error(monkeypatch, tmp_path):
    """`prune` calls this unconditionally; a missing cluster is the state it wanted."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({"get clusters": (0, "somebody-else\n")}))
    assert k8s.delete_cluster() is False


def test_the_replica_set_is_initiated_and_verified_not_assumed(monkeypatch, tmp_path):
    """`--replSet rs0` only puts mongod IN replica-set mode. Without rs.initiate()
    there is no primary, nothing can write, and Rocket.Chat waits forever -- which
    is what a real workspace did for 540 seconds, at 5 pods, with nothing in
    Rocket.Chat's logs naming MongoDB.

    The verification matters as much as the call: this is the step whose silent
    failure produces a workspace that looks created and can never become ready.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    scripts = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        j = " ".join(argv)
        if "jsonpath" in j:
            return sp.CompletedProcess(argv, 0, "true", "")
        if "--eval" in argv:
            script = argv[argv.index("--eval") + 1]
            scripts.append(script)
            out = "1" if script == "rs.status().ok" else ""
            return sp.CompletedProcess(argv, 0, out, "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                         sleep=lambda _s: None)
    assert any("rs.initiate" in s for s in scripts), scripts
    assert "rs.status().ok" in scripts, "it must verify, not trust the exit code"

    # A set that is already initiated is success, not failure.
    def already(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        j = " ".join(argv)
        if "jsonpath" in j:
            return sp.CompletedProcess(argv, 0, "true", "")
        if "--eval" in argv:
            script = argv[argv.index("--eval") + 1]
            if script == "rs.status().ok":
                return sp.CompletedProcess(argv, 0, "1", "")
            return sp.CompletedProcess(argv, 1, "", "already initialized")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", already)
    k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                         sleep=lambda _s: None)


def test_an_uninitiated_replica_set_is_reported_as_dead_not_left_to_time_out(
        monkeypatch, tmp_path):
    """Exit 7, known dead. Every second waited after this is spent waiting for
    something that cannot happen, and the readiness timeout would blame
    Rocket.Chat."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def never_ok(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        if "jsonpath" in " ".join(argv):
            return sp.CompletedProcess(argv, 0, "true", "")   # container is up...
        if "--eval" in argv:
            return sp.CompletedProcess(argv, 0, "0", "")   # ...but rs.status().ok == 0
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", never_ok)
    with pytest.raises(errors.CreateFailedError) as caught:
        k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                             sleep=lambda _s: None)
    assert "change streams" in str(caught.value), "say WHY Rocket.Chat needs it"
    assert caught.value.exit_code == 7

    # And MongoDB never becoming ready is equally terminal, naming the command
    # that shows why.
    def never_ready(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        return sp.CompletedProcess(argv, 0, "false", "")

    monkeypatch.setattr(k8s, "run", never_ready)
    monkeypatch.setattr(k8s, "MONGO_READY_TRIES", 2)
    with pytest.raises(errors.CreateFailedError) as caught2:
        k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                             sleep=lambda _s: None)
    assert "describe pod" in str(caught2.value), "name what to run next"
    assert "never started" in str(caught2.value), \
        "a pod stuck Pending has not started; it is not 'not ready'"


def test_initiation_waits_for_a_running_pod_not_a_ready_one(monkeypatch, tmp_path):
    """A circular wait, and it made the whole create a coin flip.

    The readiness probe runs mongosh, which cannot complete its handshake against
    an UNINITIATED replica set -- mongod logs
    "ReadConcernMajorityNotAvailableYet". So readiness depends on initiation, and
    waiting for readiness before initiating means each waits for the other. The
    probe occasionally scraped through and the workspace built; otherwise it timed
    out at 300s reporting that MongoDB never became ready, while mongod had been
    up the whole time.

    So this polls `.status.phase`, and the probe itself connects with
    `directConnection=true` -- which `compose.py` already knew it had to.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    asked = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        joined = " ".join(argv)
        asked.append(joined)
        if "jsonpath" in joined:
            # `ready` is FALSE and stays false, exactly as an uninitiated set
            # behaves; `started` is what says the container is exec-able.
            if "].ready" in joined:
                return sp.CompletedProcess(argv, 0, "false", "")
            return sp.CompletedProcess(argv, 0, "true", "")
        if "--eval" in argv:
            script = argv[argv.index("--eval") + 1]
            return sp.CompletedProcess(argv, 0,
                                       "1" if script == "rs.status().ok" else "", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    # Must succeed despite readiness never being true.
    k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                         sleep=lambda _s: None)
    assert not any("].ready" in a for a in asked), \
        "it waited on readiness, which cannot happen before initiation"
    assert any(".started" in a for a in asked), asked[:3]
    # And every mongosh call carries the direct URI.
    for call in [a for a in asked if "mongosh" in a]:
        assert "directConnection=true" in call, call


def test_the_readiness_probe_can_answer_before_the_set_is_initiated():
    """The manifest half of the same bug. A probe that cannot pass until initiation
    keeps the pod unready forever, and Kubernetes gives no hint that the PROBE is
    the problem."""
    import yaml

    from houston.services import k8s

    sts = [d for d in yaml.safe_load_all(k8s.mongo_manifest("t", "8.0"))
           if d["kind"] == "StatefulSet"][0]
    cmd = sts["spec"]["template"]["spec"]["containers"][0]["readinessProbe"]["exec"]["command"]
    assert any("directConnection=true" in part for part in cmd), cmd


def test_a_failed_create_leaves_no_namespace_nobody_can_see(monkeypatch, tmp_path):
    """repro.json is written only after a successful create, so a namespace that
    survives a failure is invisible to `list` and to `down`. On Compose a failed
    `up` at least leaves a workspace directory you can find."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    deleted = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        joined = " ".join(argv)
        if "get clusters" in joined:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "current-context" in joined:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in joined:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "get storageclass" in joined:
            return sp.CompletedProcess(argv, 0, '{"items":[{"metadata":{"name":"s",'
                '"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}]}', "")
        if "{.metadata.labels}" in joined:
            # WHAT A REAL CLUSTER SAYS about a namespace that is not there. This spy
            # answered every `get namespace` with rc=0 and an empty body, which now
            # reads as "exists, carrying no labels" -- and an unlabelled namespace is
            # refused rather than adopted, because houston cannot tell one an older
            # version made from one somebody else made.
            return sp.CompletedProcess(
                argv, 1, "", 'Error from server (NotFound): namespaces "x" not found')
        if "get ingressclass" in joined or "get namespace" in joined:
            return sp.CompletedProcess(argv, 0, "", "")
        if "delete namespace" in joined:
            deleted.append(joined)
        if "search repo" in joined:
            return sp.CompletedProcess(argv, 0,
                '[{"version":"7.0.2","app_version":"8.6.1"}]', "")
        if "jsonpath" in joined:
            return sp.CompletedProcess(argv, 0, "true", "")
        if "--eval" in argv:
            return sp.CompletedProcess(argv, 0, "1", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "apply", lambda *a, **k: None)
    # Mongo 8.0 takes the operator path; without these the wait polls a real clock.
    monkeypatch.setattr(k8s, "ensure_operator", lambda **k: None)
    monkeypatch.setattr(k8s, "wait_for_mongodb", lambda **k: None)
    monkeypatch.setattr(k8s, "install",
                        lambda **k: (_ for _ in ()).throw(
                            errors.CreateFailedError("helm exploded")))
    resolved = type("R", (), {"rc_version": "8.6.1", "mongo_tag": "8.0",
                              "rc_image": "img", "oplog": False})()
    with pytest.raises(errors.CreateFailedError):
        k8s.create_workspace(name="t", resolved=resolved, host_port=3000,
                             microservices=False)
    assert deleted, "the namespace survived a failed create"
    assert "houston-t" in deleted[0]


def test_the_headless_service_publishes_dns_before_the_pod_is_ready():
    """The circular dependency one layer below the readiness probe.

    A headless Service does not publish DNS for a not-ready pod. This pod cannot be
    ready until the replica set is initiated, so `rs.initiate` could not resolve
    `mongodb-0.mongodb` to verify the member is itself, and mongod refused with "no
    host described in new configuration ... maps to this node".

    Publishing not-ready addresses is the standard bootstrap pattern for a
    StatefulSet database -- the MongoDB operator does the same.
    """
    import yaml

    from houston.services import k8s

    svc = [d for d in yaml.safe_load_all(k8s.mongo_manifest("t", "8.0"))
           if d["kind"] == "Service"][0]
    # The literal STRING "None" -- that is how Kubernetes documents a headless
    # Service, and YAML's null is `null`, not `None`. Asserting `is None` here
    # would fail against a manifest the API server accepts.
    assert svc["spec"]["clusterIP"] == "None", "must stay headless for stable pod DNS"
    assert svc["spec"].get("publishNotReadyAddresses") is True, \
        "without this, rs.initiate cannot resolve its own member"
    # And the member host the initiate script uses is the one this service serves.
    assert f"{k8s.MONGO_SERVICE}-0.{k8s.MONGO_SERVICE}" in k8s.RS_INITIATE


def test_down_removes_a_kubernetes_workspace_instead_of_asking_docker(monkeypatch, tmp_path):
    """The gap the first successful CLI create exposed: `down` reached for a compose
    project that is not there and answered "no configuration file provided: not
    found", leaving a workspace that could be CREATED and never removed.

    The dispatch sits BELOW the confirmation, the ownership gate and the audit
    record, which are about whose data is being destroyed and do not depend on the
    runtime -- duplicating them per runtime is how one loses a check the other keeps.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.6.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3010,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    lc.runner.write("k", "", m)

    monkeypatch.setattr(lc, "require_docker", lambda: None)
    monkeypatch.setattr(lc.runner, "down",
                        lambda *a, **k: pytest.fail("it asked docker compose"))
    called = {}
    monkeypatch.setattr(k8s, "delete_namespace",
                        lambda name, **kw: called.update(name=name, **kw) or True)

    out = lc.teardown("k", volumes=False)
    assert out["runtime"] == topology.KUBERNETES
    assert called == {"name": "k", "context": k8s.CONTEXT, "volumes": False,
                      "emit": lc.null_emit}, called

    # And --volumes still needs the confirmation, which is shared rather than
    # reimplemented per runtime.
    with pytest.raises(errors.ValidationError):
        lc.teardown("k", volumes=True, confirm=False)


def test_stop_and_start_scale_a_kubernetes_workspace_rather_than_calling_compose(
        monkeypatch, tmp_path):
    """Kubernetes has no pause, so stop/start is scale-to-zero and back.

    What has to match is COMPOSE'S CONTRACT, not Kubernetes' vocabulary: `stop`
    gives the memory back and keeps the data, `start` brings the same workspace back
    on the same port. Scaling leaves the PersistentVolumeClaim untouched, which is
    what puts this as far from `down --volumes` as `docker compose stop` is.

    Dispatched in `set_state` rather than in each front-end: the CLI's
    stop/start/restart and the GUI's always-enabled buttons both arrive through this
    one function, so one branch covers both and cannot drift.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.6.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3010,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    lc.runner.write("k", "", m)

    for name in ("stop", "start", "restart"):
        monkeypatch.setattr(lc.runner, name,
                            lambda *a, **kw: pytest.fail("it called docker compose"))
    calls = []
    monkeypatch.setattr(k8s, "stop_workspace",
                        lambda n, **kw: calls.append(("stop", n)))
    monkeypatch.setattr(k8s, "start_workspace",
                        lambda n, **kw: calls.append(("start", n)))

    lc.set_state("k", "stop")
    assert calls == [("stop", "k")], calls

    calls.clear()
    lc.set_state("k", "start")
    assert calls == [("start", "k")], calls

    # restart is both, in that order -- not a no-op and not a start-then-stop.
    calls.clear()
    lc.set_state("k", "restart")
    assert calls == [("stop", "k"), ("start", "k")], calls

    # A bad action is still rejected the same way on both runtimes.
    with pytest.raises(errors.ValidationError):
        lc.set_state("k", "pause")


def test_a_stopped_kubernetes_workspace_remembers_what_to_scale_back_to(monkeypatch):
    """Kubernetes has no "stopped" state -- 0 replicas IS the mechanism -- so the
    number that was there has to be written down or `start` cannot restore it.

    Recorded BEFORE scaling, or the value read back is the zero just written. Stored
    on the namespace rather than in repro.json because scaling by hand is a
    legitimate thing to do and the cluster should carry its own truth -- and a
    workspace stopped by hand carries no annotation at all, which is why the
    fallback is 1 rather than a refusal.
    """
    from houston.services import k8s

    scaled, annotated = [], []

    def fake_run(argv, **kw):
        import subprocess
        if "get" in argv and "deployment,statefulset" in argv:
            out = "deployment.apps/rocketchat-rocketchat\nstatefulset.apps/mongodb\n"
        elif "annotate" in argv:
            annotated.append(argv)
            out = ""
        elif "get" in argv and any(a.startswith("jsonpath={.spec.replicas}")
                                   for a in argv):
            out = "2"
        elif "scale" in argv:
            scaled.append(argv)
            out = ""
        else:
            out = ""
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

    monkeypatch.setattr(k8s, "run", fake_run)
    k8s.stop_workspace("w", context=k8s.CONTEXT)

    payload = [a for a in annotated[0] if a.startswith(k8s.SCALE_ANNOTATION)][0]
    assert '"deployment.apps/rocketchat-rocketchat": "2"' in payload, payload
    assert "statefulset.apps/mongodb" in payload, \
        "MongoDB scales too -- a workspace holding its database resident is not stopped"
    assert any("--replicas=0" in a for argv in scaled for a in argv), scaled


def test_the_port_forward_targets_the_deployment_not_the_service(monkeypatch, tmp_path):
    """`port-forward svc/...` needs a ready ENDPOINT, and a Service has none until
    its pod passes readiness. The first version started the forward straight after
    `helm install`, kubectl found nothing to attach to and exited, and the URL that
    `up` printed never answered -- a lie rather than a delay.

    A deployment target only needs a pod to EXIST.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    spawned = []
    # "Running", not a pod name: kubectl refuses a ContainerCreating pod, so
    # waiting for existence alone spawned a forward that died immediately.
    monkeypatch.setattr(k8s, "run", _fake_run({
        # `-o json` now, because the pod wait has to tell a REFUSED read from "not
        # Running yet" -- empty stdout was identical for both, and it waited 40 x 3s
        # against a cluster that had been destroyed.
        "get pod": (0, json.dumps({"items": [{"status": {"phase": "Running"}}]})),
        "jsonpath": (0, "Running")}))
    monkeypatch.setattr(k8s.subprocess, "Popen",
                        lambda argv, **kw: spawned.append(argv) or _FakeProc(4242))
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s, "pid_owns_port_exclusively", lambda *a, **kw: True)
    pid = k8s.port_forward("k", namespace="houston-k", context=k8s.CONTEXT,
                           host_port=3010, sleep=lambda _s: None)
    assert pid == 4242
    argv = spawned[0]
    target = argv[argv.index("port-forward") + 1]
    assert target.startswith("deployment/"), f"forwarded to {target}"
    assert argv[-1] == "3010:3000", "the container port is 3000; the Service is 80"


def test_a_dead_port_forward_is_replaced_rather_than_trusted(monkeypatch, tmp_path):
    """A forward dies with its pod, so a recorded pid is not evidence it is alive --
    and a recycled pid is not evidence it is OURS. `ready` and `start` re-establish
    through this rather than assuming the create-time pid still holds."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert k8s.forward_alive(None) is False
    assert k8s.forward_alive(999999999) is False, "a pid that cannot be read is dead"
    # Our own process is alive but is NOT a port-forward, which is the recycled-pid
    # case: believing it would leave the workspace unreachable AND, at teardown,
    # signal something unrelated.

    spawned = []
    monkeypatch.setattr(k8s, "run", _fake_run({
        # `-o json` now, because the pod wait has to tell a REFUSED read from "not
        # Running yet" -- empty stdout was identical for both, and it waited 40 x 3s
        # against a cluster that had been destroyed.
        "get pod": (0, json.dumps({"items": [{"status": {"phase": "Running"}}]})),
        "jsonpath": (0, "Running")}))
    monkeypatch.setattr(k8s.subprocess, "Popen",
                        lambda argv, **kw: spawned.append(argv) or _FakeProc(77))
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s, "pid_owns_port_exclusively", lambda *a, **kw: True)
    assert k8s.ensure_port_forward("k", namespace="ns", context=k8s.CONTEXT,
                                   host_port=3010, pid=999999999) == 77
    assert spawned, "it trusted a dead pid"


def test_a_url_is_only_printed_once_the_forward_is_confirmed_alive(monkeypatch, tmp_path):
    """A port-forward that dies on spawn leaves a URL that looks like an address and
    answers nothing -- which sends someone to debug Rocket.Chat when the forward is
    what failed. Observed twice on live runs before this.

    So the URL is confirmed, not assumed, and a dead forward hands over the command
    that establishes one instead of a promise.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    said: list = []
    monkeypatch.setattr(k8s.time, "sleep", lambda _s: None)
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s, "ensure_cluster", lambda **k: k8s.CONTEXT)
    monkeypatch.setattr(k8s, "ensure_repo", lambda **k: None)
    monkeypatch.setattr(k8s, "resolve_chart_version", lambda *a, **k: "7.0.2")
    monkeypatch.setattr(k8s, "preflight",
                        lambda *a, **k: k8s.Preflight(cluster_reachable=True,
                                                      default_storage_class="s"))
    monkeypatch.setattr(k8s, "ensure_namespace", lambda n, **k: f"houston-{n}")
    monkeypatch.setattr(k8s, "apply", lambda *a, **k: None)
    monkeypatch.setattr(k8s, "init_replica_set", lambda **k: None)
    monkeypatch.setattr(k8s, "ensure_operator", lambda **k: None)
    monkeypatch.setattr(k8s, "wait_for_mongodb", lambda **k: None)
    monkeypatch.setattr(k8s, "install", lambda **k: None)
    monkeypatch.setattr(k8s, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    monkeypatch.setattr(k8s, "port_forward", lambda *a, **k: 999999999)  # dead pid
    resolved = type("R", (), {"rc_version": "8.6.1", "mongo_tag": "8.0",
                              "rc_image": "img", "oplog": False})()

    out = k8s.create_workspace(name="k", resolved=resolved, host_port=3010,
                               microservices=False,
                               emit=lambda e: said.append(e.message))
    assert out["port_forward_pid"] == 0, "a dead forward must not be recorded as live"
    assert not any(m.strip() == "http://localhost:3010" for m in said), \
        "it printed a URL it had not confirmed"
    assert any("port-forward" in m and "kubectl" in m for m in said), said


def test_the_microservices_surcharge_matches_the_pods_that_were_observed():
    """Half measured, half estimated, and the test says which.

    MEASURED live on chart 7.0.2: nine pods against a monolith's five, the four
    extra being account, authorization, ddp-streamer and presence. NOT five -- this
    chart ships no stream-hub deployment, which the first estimate assumed.

    STILL ESTIMATED: what they cost. Both memory readings were taken at readiness
    with pods still ContainerCreating, and the microservices one came out LOWER than
    the monolith's, which cannot be true.
    """
    from houston.services import lifecycle as lc

    assert lc.MICROSERVICES_MB == 800, "4 observed pods x ~200 MB"
    # Generous on purpose: under-charging lets through a create that OOMs a swapless
    # host, and the kernel picks its own victim.
    assert lc.MICROSERVICES_MB >= 4 * 200
    # And it is charged ON TOP of the chart baseline, not instead of it -- NATS is
    # in KUBE_CHART_MB because a monolith runs it too.
    assert lc.KUBE_CHART_MB > 0 and lc.CLUSTER_MB > 0


def test_a_cluster_that_outlived_its_kubeconfig_is_reconnected(monkeypatch, tmp_path):
    """`kind get clusters` reads Docker, so it sees clusters houston's OWN kubeconfig
    knows nothing about. That happens whenever the cluster outlives the config: a
    fresh or different HOUSTON_HOME, a deleted config, a cluster made by hand.

    Without an export, "reusing cluster" was followed by every kubectl call going to
    localhost:8080 and the create failing with "the API server is not answering"
    about a cluster that was perfectly healthy. Observed exactly that way: a
    workspace left running from an earlier session broke the next run.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    seen = []

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        joined = " ".join(argv)
        seen.append(joined)
        if "get clusters" in joined:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "current-context" in joined:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in joined:
            return sp.CompletedProcess(argv, 0, "ok", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    assert k8s.ensure_cluster() == k8s.CONTEXT
    assert any("export kubeconfig" in c for c in seen), \
        "it reused a cluster without writing it into houston's kubeconfig"
    assert not any("create cluster" in c for c in seen), "it recreated an existing one"

    # A failed export is terminal and says so, rather than leaving every later
    # kubectl call to fail against localhost:8080.
    def broken(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        joined = " ".join(argv)
        if "get clusters" in joined:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "export kubeconfig" in joined:
            return sp.CompletedProcess(argv, 1, "", "permission denied")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", broken)
    with pytest.raises(errors.CreateFailedError) as caught:
        k8s.ensure_cluster()
    assert "kubeconfig could not be read" in str(caught.value)


def test_a_failed_recreate_never_destroys_data_that_down_promised_to_keep(
        monkeypatch, tmp_path):
    """The most damaging defect on this branch, and it was caused by a fix.

    The rollback added for failed creates deletes the namespace -- correct when this
    call created it, catastrophic over a namespace `down` had kept. Proven live: a
    marker document written before `down` was GONE after a failed `up`, because the
    rollback took the namespace and the PVC with it. `down` had printed "the
    namespace and its PersistentVolumeClaim are kept" moments earlier.

    A failure may only undo what the same call did. Deleting retained data is what
    `down --volumes` is for -- asked for deliberately, behind a confirmation.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "ensure_cluster", lambda **kw: k8s.CONTEXT)
    monkeypatch.setattr(k8s, "ensure_repo", lambda **kw: None)
    monkeypatch.setattr(k8s, "resolve_chart_version", lambda *a, **kw: "7.0.2")
    monkeypatch.setattr(k8s, "preflight", lambda *a, **kw: k8s.Preflight(
        cluster_reachable=True, default_storage_class="standard"))
    monkeypatch.setattr(k8s, "ensure_namespace", lambda n, **kw: f"houston-{n}")
    monkeypatch.setattr(k8s, "apply", lambda *a, **kw: None)
    monkeypatch.setattr(k8s, "init_replica_set", lambda **kw: None)
    monkeypatch.setattr(k8s, "ensure_operator", lambda **kw: None)
    monkeypatch.setattr(k8s, "wait_for_mongodb", lambda **kw: None)
    monkeypatch.setattr(k8s, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    monkeypatch.setattr(k8s, "install", lambda **kw: (_ for _ in ()).throw(
        errors.CreateFailedError("helm exploded")))
    resolved = type("R", (), {"rc_version": "8.6.1", "mongo_tag": "8.0",
                              "rc_image": "img", "oplog": False})()

    deleted: list = []
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: (
        deleted.append(" ".join(argv)) if "delete namespace" in " ".join(argv) else None)
        or __import__("subprocess").CompletedProcess(argv, 0, "", ""))

    # The namespace was ALREADY there -- a re-create after `down`.
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda *a, **kw: ["houston-k"])
    with pytest.raises(errors.CreateFailedError):
        k8s.create_workspace(name="k", resolved=resolved, host_port=3010,
                             microservices=False)
    assert not deleted, "the rollback destroyed a namespace it did not create"

    # A genuinely new namespace IS cleaned up, or a failed create leaks something
    # `list` cannot show.
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda *a, **kw: [])
    with pytest.raises(errors.CreateFailedError):
        k8s.create_workspace(name="k", resolved=resolved, host_port=3010,
                             microservices=False)
    assert deleted, "a namespace this call created was left behind"


def test_exec_survives_a_terminating_pod_rather_than_failing_the_create(monkeypatch):
    """`containerStatuses[0].started` is still true for a TERMINATING pod, so a
    re-create can pass the wait and then exec into a pod on its way out:
    "unable to upgrade connection: container not found (mongod)". A one-shot exec
    turns that race into a failed create; retrying turns it into a delay."""
    from houston.services import k8s

    calls = []

    def flaky(argv, **kw):
        import subprocess as sp
        calls.append(1)
        if len(calls) < 3:
            return sp.CompletedProcess(argv, 1, "",
                                       'unable to upgrade connection: container '
                                       'not found ("mongod")')
        return sp.CompletedProcess(argv, 0, "1", "")

    monkeypatch.setattr(k8s, "run", flaky)
    res = k8s._mongo_exec(k8s.CONTEXT, "houston-k", "rs.status().ok",
                          sleep=lambda _s: None)
    assert res.returncode == 0 and len(calls) == 3, calls

    # A different failure is NOT retried -- that would just delay a real error.
    calls.clear()
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: __import__("subprocess")
                        .CompletedProcess(argv, 1, "", "authentication failed"))
    out = k8s._mongo_exec(k8s.CONTEXT, "houston-k", "x", sleep=lambda _s: None)
    assert out.returncode == 1


def test_bind_reaches_the_port_forward_instead_of_being_dropped(monkeypatch, tmp_path):
    """`--bind 0.0.0.0` was accepted on the Kubernetes path and then dropped, which
    is worse than refusing it: a workspace created for a shared box was reachable
    only from localhost and nothing said so.

    kubectl binds 127.0.0.1 by default and takes `--address`, so this is a real
    setting rather than a Compose-only one.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "run", _fake_run({
        # The pod wait reads `-o json` now; without this it sees a refused read and
        # correctly declines to wait forever, which is a different test than this one.
        "get pod": (0, json.dumps({"items": [{"status": {"phase": "Running"}}]})),
        "jsonpath": (0, "true")}))
    spawned: list = []
    monkeypatch.setattr(k8s.subprocess, "Popen",
                        lambda argv, **kw: spawned.append(argv) or _FakeProc(9))
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s, "pid_owns_port_exclusively", lambda *a, **kw: True)

    k8s.port_forward("n", namespace="ns", context=k8s.CONTEXT, host_port=3000,
                     bind_host="0.0.0.0", sleep=lambda _s: None)
    assert "--address" in spawned[0] and "0.0.0.0" in spawned[0], spawned[0]

    # Loopback needs no flag, and the default must stay loopback -- repros ship
    # fixed weak credentials, so widening is opt-in on both runtimes.
    for quiet in ("", "127.0.0.1", "localhost"):
        spawned.clear()
        k8s.port_forward("n", namespace="ns", context=k8s.CONTEXT, host_port=3000,
                         bind_host=quiet, sleep=lambda _s: None)
        assert "--address" not in spawned[0], quiet


def test_teardown_waits_for_the_namespace_rather_than_claiming_it_is_gone(
        monkeypatch, tmp_path):
    """`kubectl delete namespace --wait=false` returns instantly, so `down` printed
    "removed" while the namespace was Terminating, the pods were still shutting down
    and the PVC was still there. Anyone checking with kubectl saw the opposite of
    what they had just been told, and `up` with the same name could race a
    half-deleted namespace.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    said: list = []
    phases = ["Terminating", "Terminating", ""]

    def spy(argv, timeout=None, own=False, env=None):
        import subprocess as sp
        joined = " ".join(argv)
        # ONE query answers both questions now, which is what a cluster actually
        # returns: the labels that prove the namespace is houston's and the phase
        # that says whether it has gone are fields of the same object. The stub
        # returns that object rather than two narrow strings, because a stub that
        # answers in a shape kubectl cannot produce is how the fix under test would
        # pass here and fail on a real cluster.
        if "get namespace" in joined and "-o json" in joined:
            phase = phases.pop(0) if phases else ""
            if not phase:
                # `--ignore-not-found`: gone is exit 0 with nothing on stdout.
                return sp.CompletedProcess(argv, 0, "", "")
            return sp.CompletedProcess(argv, 0, json.dumps({
                "metadata": {"name": "houston-k", "labels": {
                    k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
                    k8s.WORKSPACE_LABEL: "k"}},
                "status": {"phase": phase}}), "")
        if "get pvc" in joined:
            return sp.CompletedProcess(argv, 0, "persistentvolumeclaim/data-mongodb-0\n", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", spy)
    assert k8s.delete_namespace("k", context=k8s.CONTEXT, volumes=True,
                                emit=lambda e: said.append(e.message),
                                sleep=lambda _s: None) is True
    assert any("1 volume(s)" in m for m in said), said
    assert any("Terminating" in m for m in said), "it never said it was waiting"
    assert any("are gone" in m for m in said), "it never confirmed the end state"


def test_the_admin_and_the_setup_wizard_reach_a_kubernetes_workspace():
    """`up` printed "Login admin / admin123" for a workspace where that user had
    never been created and the setup wizard was still waiting.

    Compose sets five variables to make a repro usable on arrival -- skip the wizard,
    auto-provision the first admin -- and the Kubernetes values carried none of them.
    Confidently stated credentials that do not work are worse than printing nothing:
    they send someone to debug their own typing.
    """
    from houston import config
    from houston.services import k8s

    env = {e["name"]: e["value"] for e in
           k8s.values_for(rc_version="8.5.1", rc_image="img",
                          microservices=True)["extraEnv"]}
    assert env["OVERWRITE_SETTING_Show_Setup_Wizard"] == "completed"
    # NO `INITIAL_USER`. It was here as "yes", which Rocket.Chat parses as JSON and
    # rejects -- `SyntaxError: Unexpected token 'y'` on every boot of every workspace --
    # and `true`, which RC's docs use, is worse: it parses, finds no `_id`, and logs
    # "Ignoring environment variable INITIAL_USER". The admin never came from it.
    # Measured on a fresh 8.5.1 database with the variable absent: zero INITIAL_USER
    # lines, login succeeds, /api/v1/me reports roles ['admin'], Show_Setup_Wizard
    # reads `completed`.
    assert "INITIAL_USER" not in env, (
        "INITIAL_USER is back; it does nothing but add a parse error to every boot")
    assert env["ADMIN_USERNAME"] == config.ADMIN_USERNAME
    assert env["ADMIN_PASS"] == config.ADMIN_PASSWORD
    assert env["ADMIN_EMAIL"] == config.ADMIN_EMAIL
    # And NOTHING the chart already sets. These two were here for one commit and
    # broke every install: a second entry for the same env key is not an override
    # but a conflict, and server-side apply refuses the Deployment outright --
    # "duplicate entries for key [name=\"DEPLOY_PLATFORM\"]". The chart knows it is
    # helm on Kubernetes; extraEnv is for what the chart does NOT know.
    for owned in ("DEPLOY_METHOD", "DEPLOY_PLATFORM", "MONGO_URL", "ROOT_URL",
                  "PORT"):
        assert owned not in env, (
            f"{owned} is set by the chart; a duplicate env key fails the install")


def test_a_failure_reports_its_reason_not_the_warnings_printed_before_it():
    """A real `helm install` failure surfaced two harmless duplicate-port warnings
    and hid its own reason, because the message took the FIRST 400 characters of
    stderr.

    Every tool here prints diagnostics first and its error last -- helm emits klog
    warnings then `Error: ...`, kubectl emits deprecation notices then the message --
    so a prefix reliably shows the least useful part. Warnings are not errors,
    however loudly they are printed.
    """
    import subprocess as sp

    from houston.services import k8s

    noisy = sp.CompletedProcess([], 1, "", (
        'I0813 18:03:17.247875 477232 warnings.go:107] "Warning: '
        'spec.template.spec.containers[2].ports[0]: duplicate port definition"\n'
        'I0813 18:03:17.247897 477232 warnings.go:107] "Warning: duplicate port '
        'name \\"metrics\\""\n'
        "Error: INSTALLATION FAILED: cannot re-use a name that is still in use"))
    got = k8s.why(noisy)
    assert "cannot re-use a name" in got, got
    assert "warnings.go" not in got, "a warning was reported as the failure"

    # No self-announcing error line: the last line is where these tools put it.
    assert k8s.why(sp.CompletedProcess([], 1, "", "connection refused")) == \
        "connection refused"
    # Nothing at all still says something, rather than an empty message.
    assert k8s.why(sp.CompletedProcess([], 1, "", "")) == "no reason given"
    # stdout is consulted too -- kubectl puts some failures there.
    assert "boom" in k8s.why(sp.CompletedProcess([], 1, "boom", ""))


def test_up_uses_the_runtime_the_workspace_already_has(monkeypatch, tmp_path):
    """`houston up -v 8.5.1 --name X` on a Kubernetes workspace defaulted to docker
    and ran `docker compose up` against a workspace with no compose file:

        'rc8-5-1' already exists - bringing it back up.
        no configuration file provided: not found
        error: `docker compose up` failed

    `--runtime` says what to CREATE. What already exists is a fact, not a preference.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    lc.runner.write("k", "", m)

    took: list = []
    monkeypatch.setattr(lc, "_create_kubernetes",
                        lambda req, emit=None: took.append(req.runtime) or {})
    monkeypatch.setattr(lc.runner, "up",
                        lambda *a, **kw: pytest.fail("it ran docker compose up"))
    # No --runtime at all, exactly as the failing command had it.
    lc._create_repro_locked(lc.CreateReq(version="8.5.1", name="k"))
    assert took == [topology.KUBERNETES], took


def test_up_brings_a_downed_kubernetes_workspace_back_instead_of_refusing(
        monkeypatch, tmp_path):
    """Two messages in the same tool contradicting each other about one workspace:

        $ houston down --name rc8-5-1
        ✓ down (the namespace and its PersistentVolumeClaim are kept).
          bring it back: houston up --version <same> --name rc8-5-1
        $ houston up -v 8.5.1 --runtime kubernetes
        error: 'rc8-5-1' already exists. `down` first, or pass --force

    Compose reuses an existing workspace. So does this now -- the namespace and PVC
    surviving a plain `down` is exactly what makes bringing it back meaningful.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The namespace-ownership preflight talks to the cluster and lives OUTSIDE
    # `create_workspace`, so stubbing that one is no longer enough to keep a test
    # off a real kubectl. Refusing to guess is the point of it, so it is stubbed
    # rather than softened.
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s, "assert_namespace_available", lambda *a, **kw: None)
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "", m)

    monkeypatch.setattr(lc, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "pick_host_port", lambda *a, **kw: 3000)
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                  "mongo_flavor": "official", "oplog": False, "source": "t"})())
    monkeypatch.setattr(k8s, "create_workspace", lambda **kw: {
        "context": k8s.CONTEXT, "namespace": "houston-k", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": "",
        "microservices": False})

    out = lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k",
                                            runtime=topology.KUBERNETES))
    assert out["reused"] is True, "it refused a workspace `down` said to bring back"


def test_the_install_is_idempotent_so_bringing_one_back_works(monkeypatch):
    """`helm install` fails on a release that already exists, which is every `up`
    over an existing workspace and every retry after a partial failure."""
    from houston.services import k8s

    seen: list = []
    monkeypatch.setattr(k8s.subprocess, "run",
                        lambda argv, **kw: seen.append(argv) or
                        __import__("subprocess").CompletedProcess(argv, 0, "", ""))
    k8s.install(namespace="ns", context=k8s.CONTEXT, values={}, chart_version="7.0.0")
    # THE INSTALL CALL, not the first subprocess call. `install` now asks for the
    # release's state first, because a release left `pending-install` by a killed
    # operation blocks every later attempt -- so the install is no longer argv[0] and
    # asserting on the ordinal was testing the call order rather than the property.
    installs = [a for a in seen if a[:3] == ["helm", "upgrade", "--install"]]
    assert len(installs) == 1, seen
    assert "--install" in installs[0], installs[0][:4]


def test_a_downed_workspace_is_down_not_perpetually_starting(monkeypatch, tmp_path):
    """A plain `down` keeps the namespace and its PVC on purpose and uninstalls the
    release. Asking only whether the namespace exists reported such a workspace as
    "starting" -- and it would have said so forever, because nothing was coming.

    Seen on a real box: `houston list` showed `starting` for a workspace the user
    had just torn down.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT

    monkeypatch.setattr(k8s, "workspace_namespaces", lambda *a, **kw: ["houston-k"])
    # Namespace kept, release gone -- exactly what `down` leaves behind.
    monkeypatch.setattr(k8s, "workload_exists", lambda *a, **kw: False)
    assert lc.kubernetes_state("k", m) == "down"

    # Workload back but not serving yet.
    monkeypatch.setattr(k8s, "workload_exists", lambda *a, **kw: True)
    monkeypatch.setattr(k8s, "workspace_ready", lambda *a, **kw: False)
    assert lc.kubernetes_state("k", m) == "starting"
    monkeypatch.setattr(k8s, "workspace_ready", lambda *a, **kw: True)
    assert lc.kubernetes_state("k", m) == "running"

    # And no namespace at all is still down.
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda *a, **kw: [])
    assert lc.kubernetes_state("k", m) == "down"


def test_list_says_which_runtime_each_workspace_is_on(monkeypatch, tmp_path):
    """Two workspaces that differ in what every other command will do to them --
    which ones refuse, where the data lives, how to reach it -- looked identical in
    `list`, which is the one place people look first."""
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    for name, rt in (("d", topology.DOCKER), ("k", topology.KUBERNETES)):
        m = lc.runner.Metadata(name=name, project="p", rc_version="8.5.1",
                               rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                               preset="default", root_url="u", host_port=3000,
                               version_source="t")
        topology.stamp(m.extra, rt)
        lc.runner.write(name, "services: {}\n", m)

    monkeypatch.setattr(lc.runner, "docker_available", lambda **kw: True)
    monkeypatch.setattr(lc.runner, "project_states", lambda: {})
    monkeypatch.setattr(lc.runner, "rc_status_by_project", lambda: {})
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda *a, **kw: [])
    rows = {r["name"]: r for r in lc.list_repros()}
    assert rows["d"]["runtime"] == topology.DOCKER
    assert rows["k"]["runtime"] == topology.KUBERNETES


def test_a_workspace_comes_back_on_the_port_it_left_on(monkeypatch, tmp_path):
    """`up` after `down` allocated a fresh port, so a workspace created on :3382
    came back on :3000 -- every bookmark, every curl pasted into a ticket, and the
    URL the user had just been shown all pointed at nothing.

    An explicit --port still wins; otherwise the recorded one does, and only a
    genuinely new workspace allocates.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The namespace-ownership preflight talks to the cluster and lives OUTSIDE
    # `create_workspace`, so stubbing that one is no longer enough to keep a test
    # off a real kubectl. Refusing to guess is the point of it, so it is stubbed
    # rather than softened.
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s, "assert_namespace_available", lambda *a, **kw: None)
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3382",
                           host_port=3382, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    lc.runner.write("k", "", m)

    monkeypatch.setattr(lc, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "pick_host_port",
                        lambda *a, **kw: 3000)          # what a fresh allocation gives
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                  "mongo_flavor": "official", "oplog": False, "source": "t"})())
    seen: dict = {}
    monkeypatch.setattr(k8s, "create_workspace", lambda **kw: seen.update(kw) or {
        "context": k8s.CONTEXT, "namespace": "houston-k", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": "",
        "microservices": False})

    out = lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k",
                                            runtime=topology.KUBERNETES))
    assert seen["host_port"] == 3382, "it moved a returning workspace to a new port"
    assert out["url"] == "http://localhost:3382"

    # An explicit --port still wins, because asking for one is asking for one.
    lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k", port=3999,
                                       runtime=topology.KUBERNETES))
    assert seen["host_port"] == 3999


def test_up_waits_before_seeding_a_kubernetes_workspace(monkeypatch, tmp_path):
    """`up --seed` ran the seeder the instant helm returned:

        error: can't seed — repro not ready (`houston ready --name rc8-5-1`)

    The CLI already forces wait=True when seeding -- `wait=(wait or seed)` -- and
    this path never read it. Helm returning is not Rocket.Chat serving.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The namespace-ownership preflight talks to the cluster and lives OUTSIDE
    # `create_workspace`, so stubbing that one is no longer enough to keep a test
    # off a real kubectl. Refusing to guess is the point of it, so it is stubbed
    # rather than softened.
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s, "assert_namespace_available", lambda *a, **kw: None)
    order: list = []
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "pick_host_port", lambda *a, **kw: 3000)
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                  "mongo_flavor": "official", "oplog": False, "source": "t"})())
    monkeypatch.setattr(k8s, "create_workspace", lambda **kw: {
        "context": k8s.CONTEXT, "namespace": "houston-k", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": "",
        "microservices": False})
    monkeypatch.setattr(lc, "wait_serving",
                        lambda *a, **kw: order.append("wait") or {"ready": True})
    monkeypatch.setattr(lc, "run_seed_inline",
                        lambda *a, **kw: order.append("seed") or {"users": 5})

    lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k", seed=True,
                                       wait=True, runtime=topology.KUBERNETES))
    assert order == ["wait", "seed"], f"seeded before it was serving: {order}"

    # And without --seed or --wait it still returns promptly.
    order.clear()
    lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k",
                                       runtime=topology.KUBERNETES))
    assert order == []


def test_ready_asks_kubernetes_not_docker(monkeypatch, tmp_path):
    """`houston ready` answered "Rocket.Chat container is not running (check
    `logs`)" about a workspace whose pods were perfectly healthy -- `rc_state` asks
    docker whether a CONTAINER runs.

    It also re-establishes the port-forward, because `ready` is exactly the command
    someone runs when the URL is not answering, and a forward dies with its pod.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra.update({"context": k8s.CONTEXT, "namespace": "houston-k",
                    "port_forward_pid": 999999999})
    lc.runner.write("k", "", m)

    monkeypatch.setattr(lc.runner, "rc_state",
                        lambda *a, **kw: pytest.fail("it asked docker"))
    monkeypatch.setattr(k8s, "workspace_ready", lambda *a, **kw: True)
    # `ready` now also confirms the socket answers AND that Rocket.Chat is what
    # answers -- see test_ready_confirms_the_socket_not_just_the_pid and
    # test_ready_refuses_a_url_served_by_something_that_is_not_rocketchat. Both
    # stubbed true here so this test stays about which RUNTIME is asked, which is
    # what it is named for.
    monkeypatch.setattr(k8s, "forward_reachable", lambda *a, **kw: True)
    monkeypatch.setattr(lc.rcapi, "api_info", lambda url, **kw: {"version": "8.5.1"})
    established: list = []
    monkeypatch.setattr(k8s, "ensure_port_forward",
                        lambda *a, **kw: established.append(kw) or 4242)

    out = lc.wait_serving(m, lc.null_emit, timeout=30.0)
    assert out["ready"] is True
    assert established, "ready did not re-establish the forward"
    # The dead pid must be replaced in the record, or `down` later signals nothing.
    assert lc.runner.read_meta("k").extra["port_forward_pid"] == 4242


def test_every_compose_only_command_refuses_with_a_way_forward(monkeypatch, tmp_path):
    """Six commands reached for a compose project that a Kubernetes workspace does
    not have, and answered "no configuration file provided: not found" -- which names
    nothing anyone can act on.

    A refusal that hands over the working command is worth more than an
    implementation that does not exist yet, and it can ship first. Each refusal
    names the namespace, so it is copy-pasteable rather than a hint.
    """
    from houston.services import envvars, k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    lc.runner.write("k", "", m)

    cases = [
        # This list has shrunk to one. `monitor`, `backup`, `logs`, `upgrade`,
        # `stats` and reading `env` all used to be here and now have Kubernetes
        # paths of their own, each covered by its own test.
        #
        # `env --set` is the one that stays, and not for want of effort: an
        # environment variable cannot be changed inside a running container on
        # either runtime. Compose rewrites its file and recreates the service; here
        # that is a helm upgrade, which is a different operation with different
        # consequences, so it hands the command over rather than guessing.
        (lambda: envvars.set_env("k", {"A": "b"}), "helm"),
    ]
    for call, expect in cases:
        with pytest.raises(errors.ValidationError) as caught:
            call()
        msg = str(caught.value)
        assert expect in msg, msg
        assert "houston-k" in msg, f"the namespace must be named: {msg}"
        assert caught.value.exit_code == 2

    # A Compose workspace passes straight through the guard.
    plain = lc.runner.Metadata(name="d", project="houston-d", rc_version="8.5.1",
                               rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                               preset="default", root_url="u", host_port=3001,
                               version_source="t")
    topology.stamp(plain.extra, topology.DOCKER)
    lc.runner.write("d", "services: {}\n", plain)
    topology.require_compose("d", "backup")     # silent


def test_mongodb_uses_the_operator_where_it_can_and_the_statefulset_where_it_cannot(
        monkeypatch, tmp_path):
    """Keyed on the MongoDB VERSION, which is the shape `mongo_flavor` already uses
    on the Compose side ("official" >= 8, "bitnami-legacy" below).

    houston pairs twelve MongoDB versions -- 3.0 through 8.2 -- because "the
    customer's exact version" is the product's promise, and the operator's window
    does not reach the old half. So this is not operator-or-StatefulSet; it is
    operator where it works, StatefulSet where it must, decided by one rule.
    """
    from houston.services import k8s

    # The version rule, with the operator switched on -- it is opt-in by default
    # until its PVC binds on a live cluster (see the opt-in test).
    monkeypatch.setenv(k8s.USE_OPERATOR_ENV, "1")
    for old in ("3.6", "4.4", "5.0"):
        assert not k8s.operator_supports(old), old
    for new in ("6.0", "7.0", "8.0", "8.2"):
        assert k8s.operator_supports(new), new
    assert not k8s.operator_supports("nonsense")


def test_the_operator_resource_asks_for_scram_and_the_two_documented_users():
    """Auth was the gap the operator is being adopted for: without it an
    authentication ticket cannot be reproduced on Kubernetes at all. Users, roles
    and secret names match the official guide so its commands transfer."""
    import yaml

    from houston.services import k8s

    doc = yaml.safe_load(k8s.mongodb_community_manifest("t", "8.0"))
    assert doc["kind"] == "MongoDBCommunity"
    assert doc["spec"]["type"] == "ReplicaSet" and doc["spec"]["members"] == 1
    assert doc["spec"]["security"]["authentication"]["modes"] == ["SCRAM"]
    users = {u["name"]: u for u in doc["spec"]["users"]}
    assert users["admin"]["roles"][0]["name"] == "root"
    assert users["rocketchat"]["roles"][0]["name"] == "readWrite"
    assert users["rocketchat"]["scramCredentialsSecretName"] == \
        "rocketchat-scram-credentials"
    # The volume survives, as it does on the hand-written path.
    assert doc["spec"]["statefulSet"]["spec"]["volumeClaimTemplates"][0][
        "spec"]["resources"]["requests"]["storage"].endswith("Gi")


def test_the_operator_is_installed_once_per_cluster_not_once_per_workspace(
        monkeypatch, tmp_path):
    """The guide installs the operator INTO the Rocket.Chat namespace, because it
    assumes one Rocket.Chat per cluster. Its CRDs are cluster-scoped, so a second
    per-namespace install collides on them rather than yielding a second operator --
    which is exactly what a tool running several workspaces at once would hit.

    So: one install, its own namespace, watching all of them.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: list = []
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: seen.append(" ".join(argv)) or
                        __import__("subprocess").CompletedProcess(argv, 0, "", ""))
    k8s.ensure_operator(context=k8s.CONTEXT)
    install = [c for c in seen if "upgrade --install" in c][0]
    assert f"-n {k8s.OPERATOR_NAMESPACE}" in install, install
    assert "houston-" not in install.split("-n ")[1].split()[0].replace(
        k8s.OPERATOR_NAMESPACE, ""), "it went into a workspace namespace"
    assert "operator.watchNamespace=*" in install, "it would not see other namespaces"
    # Idempotent: every workspace after the first re-runs this.
    assert "upgrade --install" in install


def test_the_mongo_uri_carries_credentials_and_the_operator_service_name():
    """The operator names its service `<name>-svc`, not `<name>` -- the two are not
    interchangeable, and the hand-written path uses the bare name."""
    from houston.services import k8s

    uri = k8s.operator_mongo_url("houston-t", "s3cret")
    assert "rocketchat:s3cret@" in uri
    assert "mongodb-0.mongodb-svc.houston-t.svc.cluster.local" in uri
    assert "authSource=rocketchat" in uri and "replicaSet=mongodb" in uri
    # The oplog URI points at `local` and needs no authSource.
    assert "/local?" in k8s.operator_mongo_url("houston-t", "s3cret", oplog=True)


def test_the_operator_gets_a_full_release_version_not_a_docker_tag():
    """houston carries a Docker TAG -- "8.0" -- because that is what pulls an image.
    The operator wants a RELEASE version, and the guide shows "8.0.0".

    Given "8.0" it accepts the resource and never reconciles it: no `.status.phase`
    at all, the operator healthy, MongoDB simply absent. The create then waited 300s
    and reported "the operator did not bring MongoDB up", which names nothing. Found
    on the first live run of the operator path.
    """
    import yaml

    from houston.services import k8s

    assert k8s.operator_version("8.0") == "8.0.0"
    assert k8s.operator_version("7.0") == "7.0.0"
    # An explicit --mongo 8.0.4 still means 8.0.4.
    assert k8s.operator_version("8.0.4") == "8.0.4"
    doc = yaml.safe_load(k8s.mongodb_community_manifest("t", "8.0"))
    assert doc["spec"]["version"] == "8.0.0", "a bare tag never reconciles"


def test_the_operator_is_opt_in_until_it_is_proven(monkeypatch):
    """A default that breaks the working case is worse than a missing feature.

    The hand-written StatefulSet was verified end to end on a live cluster -- admin
    login, PVC Bound, data surviving a down/up cycle. Routing MongoDB 6.0+ to the
    operator by default replaced that with a path whose PVC never binds:

        it reports: Pending ReplicaSet is not yet ready, retrying in 10 seconds
        data-volume-mongodb-0   Pending

    So the operator waits behind a flag. What that costs is auth, which is the
    thing it was adopted for -- and saying so is the point of this test.
    """
    from houston.services import k8s

    monkeypatch.delenv(k8s.USE_OPERATOR_ENV, raising=False)
    assert not k8s.operator_enabled()
    assert not k8s.operator_supports("8.0"), "a supported version must still not route"

    monkeypatch.setenv(k8s.USE_OPERATOR_ENV, "1")
    assert k8s.operator_enabled()
    assert k8s.operator_supports("8.0")
    assert not k8s.operator_supports("5.0"), "the version floor still applies"


def test_the_operator_volume_claims_cover_both_volumes_the_pod_mounts():
    """The operator's pod mounts `data-volume` AND `logs-volume`, and overriding
    `volumeClaimTemplates` REPLACES its defaults rather than merging with them --
    a run that declared only `data-volume` produced exactly one PVC, while both of
    the pod's containers mount both volumes. A template list that drops one leaves
    the pod referencing a claim nothing creates.

    (This was NOT what held the first live run at Pending -- that was the missing
    ServiceAccount, see the RBAC test below. Both are real; only one was blocking.)
    """
    import yaml

    from houston.services import k8s

    doc = yaml.safe_load(k8s.mongodb_community_manifest("t", "8.0"))
    names = [v["metadata"]["name"]
             for v in doc["spec"]["statefulSet"]["spec"]["volumeClaimTemplates"]]
    assert names == ["data-volume", "logs-volume"], names


def test_the_database_pod_gets_its_service_account_in_the_workspace_namespace():
    """What actually held the operator path at Pending for three sessions.

    The operator writes a StatefulSet whose pod runs as `mongodb-kubernetes-appdb`.
    Its chart creates that account only in the namespace the chart is installed
    into. houston installs the operator ONCE, in `houston-system`, because the
    chart owns cluster-scoped CRDs and a per-workspace install collides on them at
    the second workspace -- so the account is missing exactly where the pod needs it:

        error: pods "mongodb-0" is forbidden: error looking up service account
        houston-optest/mongodb-kubernetes-appdb: serviceaccount ... not found

    That is an event on the StatefulSet. The MongoDBCommunity resource reports only
    "Pending ReplicaSet is not yet ready", and because no pod is ever created,
    WaitForFirstConsumer holds both PVCs at Pending -- which is the symptom seen
    first and points at storage, which was never the problem.
    """
    import yaml

    from houston.services import k8s

    docs = {d["kind"]: d
            for d in yaml.safe_load_all(k8s.mongo_rbac_manifest("t", owner="o"))}
    assert set(docs) == {"ServiceAccount", "Role", "RoleBinding"}, sorted(docs)

    sa = k8s.MONGO_DB_SERVICE_ACCOUNT
    assert all(d["metadata"]["name"] == sa for d in docs.values())
    # The binding must name the LOCAL account. Pointing at the operator's namespace
    # would apply cleanly and still leave the pod unable to start.
    subject = docs["RoleBinding"]["subjects"][0]
    assert subject["kind"] == "ServiceAccount" and subject["name"] == sa
    assert "namespace" not in subject, "must bind the account in OUR namespace"
    assert docs["RoleBinding"]["roleRef"]["name"] == sa

    # Exactly what a member pod needs: read its own password Secret, and
    # patch/delete/get its own Pod to mark readiness and roll itself.
    rules = {r["resources"][0]: set(r["verbs"]) for r in docs["Role"]["rules"]}
    assert rules == {"secrets": {"get"}, "pods": {"patch", "delete", "get"}}, rules

    # Owned like everything else, so `prune` and the ownership guards see it.
    for doc in docs.values():
        assert doc["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "houston"


def test_the_service_account_is_applied_before_the_database_that_needs_it():
    """Order matters and is not obvious: the RoleBinding has to exist before the
    StatefulSet tries to create a pod, or the pod is rejected and the operator
    backs off. Applying it with the Secrets -- ahead of the MongoDBCommunity
    resource -- is what makes the first attempt the successful one."""

    from houston.services import k8s

    body = source_of(k8s.create_workspace)
    rbac = body.index("mongo_rbac_manifest")
    community = body.index("mongodb_community_manifest")
    assert rbac < community, "RBAC must be applied before the MongoDBCommunity"


def test_asking_for_the_operator_explicitly_satisfies_the_opt_in_but_not_the_floor(
        monkeypatch):
    """`--mongo-operator` is the user asking for it, so the opt-in switch is met.
    The VERSION floor still applies: the operator cannot manage MongoDB 5.0, and
    silently ignoring the flag would be worse than falling back."""
    from houston.services import k8s

    monkeypatch.delenv(k8s.USE_OPERATOR_ENV, raising=False)
    assert not k8s.operator_supports("8.0"), "off by default"
    assert k8s.operator_supports("8.0", forced=True), "--mongo-operator asks for it"
    assert not k8s.operator_supports("5.0", forced=True), "the floor still holds"


def test_the_monitoring_stack_is_shared_by_the_cluster_not_owned_by_a_workspace():
    """The Compose shape does not transfer, and copying it would break at two.

    `helm template rocketchat/monitoring` with every dependency disabled still
    renders a ClusterRole and a ClusterRoleBinding at FIXED names
    (`monitoring-otel-collector-role`) plus a log-collector DaemonSet -- so a
    per-workspace release collides on cluster-scoped objects at the second
    workspace, exactly as the MongoDB operator's CRDs do, and would also put one
    collector per node per workspace on the same host paths.

    So it lives once in houston-system, like the operator, and `--monitor` on a
    workspace means "point the shared Prometheus at me", not "install a stack".
    """
    from houston.services import k8s

    assert k8s.MONITORING_NAMESPACE == k8s.OPERATOR_NAMESPACE == "houston-system"


def test_prometheus_is_told_to_look_outside_its_own_release():
    """The one setting a shared stack cannot work without.

    kube-prometheus-stack defaults `serviceMonitorSelectorNilUsesHelmValues` and its
    pod equivalent to true, which restricts Prometheus to monitors carrying its own
    release label. A workspace's PodMonitor is in another namespace and another
    release, so it is silently ignored: nothing errors, Grafana just draws empty
    graphs -- which reads as "monitoring is broken" rather than "the selector
    excluded it".
    """

    from houston.services import k8s

    src = source_of(k8s.ensure_monitoring)
    for key in ("serviceMonitorSelectorNilUsesHelmValues=false",
                "podMonitorSelectorNilUsesHelmValues=false"):
        assert key in src.replace("\"\n               \"", ""), key


def test_detaching_monitoring_leaves_it_up_for_the_workspaces_still_using_it(
        monkeypatch):
    """Shared means one workspace's `--off` must not blind the others.

    This is the real behavioural difference from Compose, where the stack belongs to
    a project and detaching is unambiguous. Getting it wrong is silent: the other
    workspaces keep running and just stop being observable.
    """
    import subprocess

    from houston.services import k8s

    monkeypatch.setattr(k8s, "workspace_namespaces",
                        lambda ctx: ["houston-a", "houston-b"])
    monkeypatch.setattr(k8s, "monitoring_wanted",
                        lambda ns, *, context: ns == "houston-b")
    # The stack IS installed here: "who else wants it" is only a question once
    # something exists to keep, and `remove_monitoring` now returns early otherwise.
    monkeypatch.setattr(k8s, "release_installed", lambda *a, **k: True)
    calls = []

    def fake_run(argv, **kw):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(k8s, "run", fake_run)

    assert k8s.remove_monitoring(context=k8s.CONTEXT) is False
    assert not any("uninstall" in a for argv in calls for a in argv), calls

    monkeypatch.setattr(k8s, "monitoring_wanted", lambda ns, *, context: False)
    calls.clear()
    assert k8s.remove_monitoring(context=k8s.CONTEXT) is True
    assert any("uninstall" in a for argv in calls for a in argv), calls


def test_the_chart_repo_and_the_install_share_one_helm_home(monkeypatch, tmp_path):
    """`owned_env` set the kubeconfig AND every HELM_* variable together, and that
    conflation broke `up --runtime kubernetes` on a cluster houston ADOPTED. The chart
    repo went into houston's Helm home (`ensure_repo`, `own=True`) while the install that
    needed it read the user's (`is_ours(context)` is False on an adopted cluster). Two
    different repositories.yaml, so the create failed at 60% -- after the namespace, the
    operator and MongoDB had all been built -- with

        helm install failed: Error: repo rocketchat not found

    and then rolled the namespace back. Reproduced against a live k3s cluster with the
    user's Helm home moved aside: the pre-fix environment gives exactly that error and
    `helm_env` gives rc 0.

    The MongoDB operator path worked only because BOTH its halves used the user's home --
    consistent, and also wrong, because it wrote repositories into the home `owned_env`
    exists to keep houston out of."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.delenv("KUBECONFIG", raising=False)

    owned = k8s.owned_env()                       # what ensure_repo uses
    adopted = k8s.helm_env("default")             # a cluster we did not create
    ours = k8s.helm_env(k8s.CONTEXT)              # our own kind cluster

    key = "HELM_REPOSITORY_CONFIG"
    assert owned[key] == adopted[key] == ours[key], (
        "the repo and the install must read one repositories.yaml, whoever owns the "
        "cluster")
    for var in ("HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME",
                "HELM_REPOSITORY_CACHE"):
        assert adopted[var] == owned[var], f"{var} escaped to the user's home"
        assert str(tmp_path) in adopted[var], f"{var} is not under HOUSTON_HOME"

    # The kubeconfig is the half that MUST differ: ours for our cluster, the user's for
    # one we adopted -- which is what `owned_env` got right and could not express alone.
    assert "KUBECONFIG" not in adopted, "an adopted cluster must use the user's kubeconfig"
    assert ours["KUBECONFIG"] == str(k8s.owned_kubeconfig())

    # And an explicitly-set KUBECONFIG is preserved rather than deleted.
    monkeypatch.setenv("KUBECONFIG", "/tmp/theirs.yaml")
    assert k8s.helm_env("default")["KUBECONFIG"] == "/tmp/theirs.yaml"
    assert k8s.helm_env(k8s.CONTEXT)["KUBECONFIG"] == str(k8s.owned_kubeconfig())


def test_a_missing_compose_plugin_is_a_preflight_not_a_mid_create_crash(monkeypatch):
    """`docker_available()` runs `docker info`, which says nothing about the compose
    plugin -- and a box can have one without the other. Reported from a fresh Amazon
    Linux EC2 instance where `docker ps` worked and both entry points died from the
    middle of their work with docker's own unhelpful pair:

        docker: 'compose' is not a docker command.
        unknown shorthand flag: 'd' in -d

    `serve --domain` reported only "the edge did not start" with `docker ps -a` empty."""
    from houston import errors, runner
    from houston.services import lifecycle as lc

    monkeypatch.setattr(runner, "docker_available", lambda: True)

    monkeypatch.setattr(runner, "compose_version", lambda: None)
    try:
        lc.require_docker()
    except errors.PreflightError as exc:
        assert "not installed" in str(exc), exc
        assert "docker-compose-plugin" in str(exc), "name the package to install"
        assert exc.exit_code == 3, "an unusable environment is a preflight, not a crash"
    else:
        raise AssertionError("accepted a box with no compose plugin")

    # v1 is not enough either, and it says which version it found.
    monkeypatch.setattr(runner, "compose_version", lambda: "1.29.2")
    try:
        lc.require_docker()
    except errors.PreflightError as exc:
        assert "1.29.2" in str(exc), exc
    else:
        raise AssertionError("accepted Compose v1")

    # And v2 passes, which is every working box.
    monkeypatch.setattr(runner, "compose_version", lambda: "2.29.1")
    lc.require_docker()


def test_finalizers_are_cleared_the_moment_the_deletes_stop_working(monkeypatch):
    """Nine minutes of silence, measured on a live workspace. The Grafana operator was
    already gone -- only the MongoDB operator was left in `houston-system` -- while
    twelve grafana-operator resources remained, one carrying
    `operator.grafana.com/finalizer` and a deletionTimestamp ten minutes old, with the
    release stuck in `uninstalling`. Every step paid its full timeout for nothing: four
    60-second deletes that could never finish, then a five-minute `helm uninstall
    --wait`, and only then the fallback that clears the finalizers -- which worked at
    once. The clearing has to happen when the deletes are seen to have failed, not nine
    minutes later."""
    import subprocess
    from houston.services import k8s

    monkeypatch.setattr(k8s, "release_installed", lambda *a, **k: True)
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx: [])
    calls = []

    # The delete never works and the resources never go: exactly the live shape.
    def fake_run(argv, **kw):
        calls.append(" ".join(argv))
        joined = " ".join(argv)
        if "get" in argv and "jsonpath={.items[*].metadata.name}" in joined:
            return subprocess.CompletedProcess(argv, 0, "wedged-one", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", fake_run)
    assert k8s.remove_monitoring(context=k8s.CONTEXT) is True

    patch_at = [i for i, c in enumerate(calls) if "finalizers" in c]
    uninstall_at = [i for i, c in enumerate(calls) if "uninstall" in c]
    assert patch_at, "never cleared the finalizers"
    assert uninstall_at, "never uninstalled the release"
    assert min(patch_at) < min(uninstall_at), (
        "cleared the finalizers only AFTER helm had already waited: " + str(calls))

    # And the per-kind deadline is short, because a delete still running after it is
    # waiting on something nothing will clear.
    deletes = [c for c in calls if " delete " in f" {c} "]
    assert deletes, calls
    assert all(f"--timeout={k8s.GRAFANA_DELETE_WAIT}s" in c for c in deletes), deletes
    assert k8s.GRAFANA_DELETE_WAIT <= 20, "a doomed delete must not block for a minute"


def test_detaching_monitoring_reports_progress_rather_than_going_quiet(monkeypatch, tmp_path):
    """A GUI job showed "running" with an empty log for nine minutes, which is
    indistinguishable from a hang -- and that is how the finalizer wait above was
    reported. Both detach paths emitted almost nothing until they had finished."""
    from houston import runner
    from houston.services import monitor as monsvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="w", project="houston-w", rc_version="8.5.1",
        rc_image="img", mongo_tag="8.0", mongo_flavor="community",
        preset="default", root_url="http://localhost:3000", host_port=3000,
        version_source="shipped")
    meta.extra.update({"runtime": "kubernetes", "namespace": "houston-w",
                       "context": "kind-houston-local", "monitoring": True})
    ws = runner.workspace("w"); ws.mkdir(parents=True, exist_ok=True)
    import json
    from dataclasses import asdict
    runner.atomic_write(ws / "repro.json", json.dumps(asdict(meta), indent=2))

    from houston.services import k8s
    monkeypatch.setattr(k8s, "set_monitoring_label", lambda *a, **k: None)
    monkeypatch.setattr(k8s, "remove_monitoring", lambda **k: True)
    monkeypatch.setattr(monsvc.lifecycle, "login",
                        lambda m: (_ for _ in ()).throw(RuntimeError("down")))

    seen = []
    monsvc._detach_kubernetes("w", emit=lambda e: seen.append(e))
    # Something BEFORE the terminal event, or the log is empty while it works.
    assert len(seen) >= 3, [e.message for e in seen]
    assert any(e.phase == "monitor" for e in seen), [e.phase for e in seen]
    assert seen[-1].phase == "done", seen[-1].phase


def test_grafana_is_forwarded_from_the_instance_not_the_operator():
    """`monitoring-grafana` is the grafana-OPERATOR and serves nothing useful;
    `monitoring-grafana-deployment` is the Grafana it manages. Forwarding the wrong
    one gives a page that loads and has no dashboards -- a working URL showing
    nothing, which is worse than a refusal."""
    from houston.services import k8s

    assert k8s.GRAFANA_DEPLOYMENT == "monitoring-grafana-deployment"
    # Deployment, not Service, for the same reason the workspace forward is:
    # a Service with no ready endpoint makes kubectl exit at once.
    src = source_of(k8s.grafana_forward)
    assert "deployment/{GRAFANA_DEPLOYMENT}" in src


def test_monitor_at_create_time_waits_for_the_workspace_first():
    """Attaching turns on RC's own Prometheus_Enabled over REST, so it needs a
    workspace that answers. `up --monitor` without `--wait` would otherwise attach
    to something not yet serving and fail -- which is exactly what `--seed` did
    before it was fixed on this path."""

    src = source_of(lc._create_kubernetes)
    monitor_at = source_index(src, "req.monitor")
    assert "wait_serving" in src[monitor_at:monitor_at + 400], \
        "--monitor must wait for the workspace before attaching"


def test_the_grafana_url_is_not_handed_over_before_the_forward_answers(monkeypatch):
    """`kubectl port-forward` returns a pid before it binds the socket.

    The workspace path already carries a test named for this mistake. The Grafana
    path repeated it and the deployment matrix caught it: `houston monitor`
    reported attached and exited 0, and a curl to the URL it printed got nothing at
    all -- a link handed over that quietly did not work.
    """
    from houston.services import k8s

    slept = []
    assert k8s.forward_reachable(1, tries=3, interval=0.01,
                                 sleep=slept.append) is False
    assert len(slept) == 3, "must actually retry rather than check once"


def test_the_statefulset_image_covers_the_versions_the_operator_cannot():
    """Why `mongo:` and not MongoDB Inc's own image, pinned so it is not "fixed".

    This StatefulSet exists to serve what the operator cannot reach, and
    `mongodb/mongodb-community-server` publishes NO tag below 4.4 -- 3.6, 4.0 and
    4.2 are 404 on Docker Hub -- while houston pairs Rocket.Chat < 3.0 with MongoDB
    3.6. "Make it consistent with compose.py" looks like a tidy-up and would break
    precisely the versions this code was written for.

    Same MongoDB either way: same source, version, storage engine and wire protocol,
    differing in base OS and packaging.
    """
    import yaml

    from houston.services import k8s

    assert k8s.mongo_image("3.6") == "mongo:3.6"
    docs = list(yaml.safe_load_all(k8s.mongo_manifest("t", "3.6")))
    sts = [d for d in docs if d and d.get("kind") == "StatefulSet"][0]
    assert sts["spec"]["template"]["spec"]["containers"][0]["image"] == "mongo:3.6"


def test_kubernetes_records_what_built_the_database_not_a_compose_flavour():
    """`mongo_flavor` is "official" / "bitnami-legacy" -- a COMPOSE image choice.

    The Kubernetes StatefulSet honours neither value, so reporting it made
    `houston list` print "8.0 (official)" for a workspace running Docker Hub's
    `mongo:8.0`. A label describing an image the workspace does not run is worse
    than no label, because it is the field someone checks when a version-specific
    bug will not reproduce.
    """

    from houston.services import k8s

    src = source_of(k8s.create_workspace)
    assert '"mongo_managed_by"' in src and '"mongo_image"' in src
    # Both branches must set them, or the record is right only half the time.
    assert src.count("managed_by = ") == 2, "operator and statefulset must both record"


def test_the_notes_say_the_operator_is_shared_when_it_is_used():
    """The deviation from the official guide has to be visible where someone reads it.

    The guide installs the operator INTO the Rocket.Chat namespace. houston runs
    several workspaces, its CRDs are cluster-scoped, so it installs once in
    houston-system watching everything. Undocumented, the first person to run the
    guide's `kubectl -n <ns> get pods` finds no operator and concludes it was never
    installed.
    """
    # Asserted against the groups a real record produces rather than against the
    # source of the function that builds them: the notes are derived on every read
    # now, so the record is the input and the rendered groups are the output, and
    # only the second of those is what anybody sees.
    def groups_for(managed_by):
        m = lc.runner.Metadata(
            name="k", project="houston-k", rc_version="8.5.1", rc_image="i",
            mongo_tag="8.0", mongo_flavor="official", preset="default",
            root_url="http://localhost:3000", host_port=3000, version_source="map",
            extra={"runtime": "kubernetes", "deployment": "microservices",
                   "namespace": "houston-k", "context": "kind-houston-local",
                   "release": "rocketchat", "mongo_managed_by": managed_by,
                   "mongo_image": "mongo:8.0"})
        return {g["title"]: g for g in lc.note_groups_of(m)}

    op = groups_for("operator")
    shared = op["The MongoDB operator is shared"]
    assert "official guide" in " ".join(shared["body"])
    # And it says where to look, not just that it is elsewhere.
    assert any("get mongodbcommunity" in c for c in shared["commands"])
    assert ("Managed by", "the official operator") in [tuple(r) for r in op["MongoDB"]["rows"]]
    # Monitoring deviates the same way and for the same reason, on both paths.
    assert "shared by the cluster, not installed per" in " ".join(op["Monitoring"]["body"])
    # A plain StatefulSet has no operator to explain, and says so where the guide
    # would have led someone to expect authentication.
    sts = groups_for("statefulset")
    assert "The MongoDB operator is shared" not in sts
    assert ("Authentication", "none") in [tuple(r) for r in sts["MongoDB"]["rows"]]
    assert "official guide" in " ".join(sts["MongoDB"]["body"])


def test_the_oplog_user_can_actually_read_the_oplog(monkeypatch):
    """Two faults in one line, on the only versions that use it.

    Rocket.Chat below 8.x tails the oplog; 8.x dropped it. The operator's oplog URL
    addressed the `local` DATABASE while the user is defined in `rocketchat`, and
    carried no authSource -- so the driver authenticated against `local`, looking for
    a user that has never existed there. Even past that, reading `local` needs a role
    `readWrite` on the app database does not confer.

    The role is not an invention: Rocket.Chat's own chart grants exactly this to its
    bundled MongoDB, in templates/mongodb-init-configmap.yaml --
    `grantRolesToUser('<user>', [{ role: 'clusterMonitor', db: 'admin' }])`.

    This survived every live run because they all used 8.5.1, where the URL is never
    emitted at all.
    """
    import yaml

    from houston.services import k8s

    oplog = k8s.operator_mongo_url("houston-x", "PW", oplog=True)
    assert "/local?" in oplog, oplog
    assert f"authSource={k8s.MONGO_APP_DB}" in oplog, \
        "without authSource the driver authenticates against `local`"

    doc = yaml.safe_load(k8s.mongodb_community_manifest("t", "7.0"))
    app = {u["name"]: u for u in doc["spec"]["users"]}[k8s.MONGO_APP_USER]
    roles = {(r["name"], r["db"]) for r in app["roles"]}
    assert ("readWrite", k8s.MONGO_APP_DB) in roles, roles
    assert ("clusterMonitor", "admin") in roles, \
        "readWrite on the app db cannot read `local`"


def test_the_oplog_url_is_only_emitted_for_the_versions_that_use_it():
    """RC 8.x dropped oplog tailing, so emitting it there is wrong in the other
    direction. The rule lives in versions.py and applies to both runtimes; this
    checks the Kubernetes chart values honour it."""
    from houston.services import k8s

    with_oplog = k8s.values_for(rc_version="7.10.0", rc_image="i", microservices=False,
                                oplog=True, mongo_url="m", oplog_url="o")
    without = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                             oplog=False, mongo_url="m")
    assert with_oplog["externalMongodbOplogUrl"] == "o"
    assert "externalMongodbOplogUrl" not in without


def test_the_chart_fix_is_applied_only_where_the_chart_needs_it(monkeypatch):
    """Rocket.Chat 7.x could not install on Kubernetes at all, and no test saw it
    because every live run used 8.5.1.

    Chart 6.26.0 -- the exact-match chart for RC 7.10.0 -- ships
    `containerSecurityContext: {runAsUser: 999, fsGroup: 999}` and renders it onto
    the CONTAINER, where `fsGroup` does not exist. Helm 3 applied client-side and
    dropped it silently; Helm 4 applies server-side and the API server refuses the
    whole Deployment: ".spec.template.spec.containers[name=\\"rocketchat\\"]
    .securityContext.fsGroup: field not declared in schema".

    `null` is the override because Helm MERGES values -- passing a replacement map
    leaves the chart's own fsGroup underneath and changes nothing. And it is applied
    only where the chart has the field: injecting it into chart 7.0.0, which fixed
    the bug upstream, put a literal `fsGroup: null` onto the container instead --
    the same undeclared field from the other direction.
    """
    from houston.services import k8s

    def fake_run(argv, **kw):
        import subprocess
        has_fsgroup = "6.26.0" in argv
        body = ("containerSecurityContext:\n  runAsUser: 999\n  fsGroup: 999\n"
                if has_fsgroup else
                "containerSecurityContext:\n  runAsUser: 65533\n")
        return subprocess.CompletedProcess(argv, 0, stdout=body, stderr="")

    monkeypatch.setattr(k8s, "run", fake_run)
    assert k8s.container_security_context("6.26.0") == \
        {"containerSecurityContext": {"fsGroup": None}}
    assert k8s.container_security_context("7.0.0") == {}, \
        "a chart without the field must get no override at all"


def test_ready_confirms_the_socket_not_just_the_pid(monkeypatch, tmp_path):
    """`ready` exited 0 on a workspace whose URL answered nothing, after `restart`.

    The pod being Ready is Kubernetes' answer to a different question. `kubectl
    port-forward` returns a pid before it has bound the socket, so declaring ready
    on the strength of the pid is a guess -- and the live run caught it being wrong:
    `ready` returned success and the very next request to the URL it had just
    confirmed got nothing.

    So the loop keeps going until something actually answers on the port. This is
    the same defect as the Grafana URL, in the place it was fixed second.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3999",
                           host_port=3999, version_source="t")
    from houston.services import topology
    topology.stamp(m.extra, topology.KUBERNETES)

    monkeypatch.setattr(k8s, "workspace_ready", lambda *a, **kw: True)
    monkeypatch.setattr(k8s, "ensure_port_forward", lambda *a, **kw: 4242)
    monkeypatch.setattr(lc.runner, "update_meta", lambda *a, **kw: None)

    # Never reachable -> must NOT report ready, must raise the timeout instead.
    monkeypatch.setattr(k8s, "forward_reachable", lambda *a, **kw: False)
    try:
        lc._wait_serving_kubernetes(m, lc.null_emit, timeout=0.2)
    except errors.NotReadyError:
        pass
    else:
        raise AssertionError("a URL that answers nothing must not report ready")

    # Reachable AND Rocket.Chat answering -> ready. Both are now required: the port
    # answering says only that the port answers, so /api/info is what says the thing
    # on the other end is this workspace.
    monkeypatch.setattr(k8s, "forward_reachable", lambda *a, **kw: True)
    monkeypatch.setattr(lc.rcapi, "api_info", lambda url, **kw: {"version": "8.5.1"})
    out = lc._wait_serving_kubernetes(m, lc.null_emit, timeout=5.0)
    assert out == {"ready": True, "url": "http://localhost:3999"}, out


def test_a_port_forward_that_never_bound_is_not_recorded_as_a_pid(monkeypatch, tmp_path):
    """`port_forward` returned `proc.pid` the instant it spawned kubectl.

    kubectl cannot share a port: if something already holds it, it prints
    `Unable to listen on port N: bind: address already in use` and exits within
    milliseconds -- to DEVNULL, so nothing saw it -- and the pid was recorded anyway.
    The record then named a dead process while the squatter answered the URL, which is
    the first half of `ready` certifying somebody else's software.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "run", _fake_run({
        # `-o json` now, because the pod wait has to tell a REFUSED read from "not
        # Running yet" -- empty stdout was identical for both, and it waited 40 x 3s
        # against a cluster that had been destroyed.
        "get pod": (0, json.dumps({"items": [{"status": {"phase": "Running"}}]})),
        "jsonpath": (0, "Running")}))
    # kubectl exited: it never got the socket. Something else answers on the port,
    # which is exactly why this must not be read as success.
    monkeypatch.setattr(k8s.subprocess, "Popen",
                        lambda argv, **kw: _FakeProc(4242, exited=1))
    # THE SQUATTER HOLDS THE PORT, and our child never got it. The code asks the
    # ownership question now, because asking "does the port answer?" is answered
    # `True` by the squatter -- measured, 3 times out of 3, in a tenth of a
    # millisecond, so the warning below never fired in the one scenario it is for.
    monkeypatch.setattr(k8s, "pid_owns_port_exclusively", lambda *a, **kw: False)
    # AND SOMETHING REALLY IS LISTENING, which is what makes this the squatter case.
    # The warning distinguishes a collision from a pod that moved, so the double has
    # to say which of the two this is -- see the second half of this test.
    monkeypatch.setattr(k8s, "_listening_inodes", lambda port: {"sock:[1]"})
    said: list = []
    pid = k8s.port_forward("k", namespace="ns", context=k8s.CONTEXT, host_port=3010,
                           emit=lambda e: said.append(e.message),
                           sleep=lambda _s: None)
    assert pid == 0, "a pid was recorded for a forward that never came up"
    assert any("something else already holds it" in m for m in said), said

    # THE OTHER CAUSE, and it is the commonest one. During an upgrade or any rolling
    # update the pod the forward attached to goes away, kubectl exits, and NOTHING
    # holds the port. This used to print the squatter message anyway and tell the
    # reader to run `down` then `up` -- measured on a live upgrade, where the next
    # readiness check re-established the forward on its own seconds later. A false
    # alarm that prescribes destroying the workspace is worse than no alarm.
    monkeypatch.setattr(k8s, "_listening_inodes", lambda port: set())
    said.clear()
    assert k8s.port_forward("k", namespace="ns", context=k8s.CONTEXT, host_port=3010,
                            emit=lambda e: said.append(e.message),
                            sleep=lambda _s: None) == 0
    assert any("not a collision" in m for m in said), said
    assert not any("down --name" in m for m in said), \
        "nothing here justifies telling somebody to destroy the workspace"

    # And the ordinary case still works: child alive and holding its own socket.
    monkeypatch.setattr(k8s.subprocess, "Popen",
                        lambda argv, **kw: _FakeProc(4242))
    monkeypatch.setattr(k8s, "pid_owns_port_exclusively", lambda *a, **kw: True)
    assert k8s.port_forward("k", namespace="ns", context=k8s.CONTEXT, host_port=3010,
                            sleep=lambda _s: None) == 4242


def test_ready_refuses_a_url_served_by_something_that_is_not_rocketchat(
        monkeypatch, tmp_path):
    """`ready` printed "is serving at <url>" and exited 0 for a URL a FOREIGN process
    was serving.

    The Kubernetes readiness path concluded from a Ready pod plus "the port answers",
    and never asked Rocket.Chat anything -- while the Docker path has always gone
    through `rcapi.wait_ready`, which polls /api/info. So the two runtimes disagreed
    about what "ready" means, and the weaker one certified the wrong software. The
    port is validated only at create time and 3000+ is the most contested range on a
    dev box, so this is an ordinary event, not a contrived one.

    Occupancy is not identity. A support engineer reading that URL draws every
    conclusion about a program that is not Rocket.Chat.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3998",
                           host_port=3998, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)

    monkeypatch.setattr(k8s, "workspace_ready", lambda *a, **kw: True)
    monkeypatch.setattr(k8s, "ensure_port_forward", lambda *a, **kw: 0)
    monkeypatch.setattr(lc.runner, "update_meta", lambda *a, **kw: None)
    # The port answers -- but not with Rocket.Chat.
    monkeypatch.setattr(k8s, "forward_reachable", lambda *a, **kw: True)
    monkeypatch.setattr(lc.rcapi, "api_info", lambda url, **kw: None)
    monkeypatch.setattr(k8s, "terminal_pod_failure", lambda *a, **kw: None)

    # WHOSE forward holds the port is deliberately not part of the test, because it
    # turned out not to be the right question. The first version of this fix refused
    # only when OUR forward was dead, and a live run found the case that misses: on a
    # dual-stack box kubectl binds `[::1]` quite happily while a squatter holds
    # `127.0.0.1`, so the forward is ALIVE, `localhost` resolves v4-first to the
    # squatter, and `ready` polled to a timeout instead of saying so. Measured with
    # `ss -ltnp`: python on 127.0.0.1:3001 and kubectl on [::1]:3001 at once.
    #
    # The workspace's own state is the sound test: Kubernetes says ready, the port
    # answers, and it is not Rocket.Chat -- so that port is not this workspace,
    # whoever owns the socket.
    # Two strikes rather than the shipped four: this test is about the refusal, and
    # the grace period has its own assertion below.
    monkeypatch.setattr(lc, "FOREIGN_PORT_STRIKES", 2)
    for alive in (False, True):
        monkeypatch.setattr(k8s, "forward_alive", lambda *a, **kw: alive)
        with pytest.raises(errors.ConflictError) as caught:
            lc._wait_serving_kubernetes(m, lc.null_emit, timeout=60.0)
        said = str(caught.value)
        assert "3998" in said and "not with Rocket.Chat" in said, said
        assert "trusted to be this workspace" in said, \
            "say that the URL itself is not evidence"
        assert "IPv4" in said, "the dual-stack case is the one a reader cannot guess"

    # But NOT on the first look. A pod that has only just passed its probe may take a
    # moment more to serve, and accusing somebody then is worse than waiting -- so the
    # refusal needs consecutive strikes, and without room for them this is an honest
    # timeout rather than an accusation.
    monkeypatch.setattr(lc, "FOREIGN_PORT_STRIKES", 10**6)
    with pytest.raises(errors.NotReadyError):
        lc._wait_serving_kubernetes(m, lc.null_emit, timeout=0.5)


def test_a_create_stops_waiting_for_a_pod_that_cannot_start(monkeypatch):
    """A mistyped version cost the full timeout, then blamed the timeout.

    Kubernetes knows within seconds that an image does not exist; the readiness loop
    waited its whole 600s anyway and then reported "did not become ready", which names
    the symptom and not the cause. Taken from PR #3.

    The discrimination is the subtle part, and PR #3's note has it: `ImagePullBackOff`
    is a REASON, not a phase, and a pod that is merely pulling slowly from a
    rate-limited registry looks identical at the phase level. So the reason decides,
    and anything unrecognised keeps waiting -- the default has to be patience, or a
    slow pull becomes a failed create.
    """
    import json as _json

    from houston.services import k8s

    def pods(*states):
        return _json.dumps({"items": [
            {"metadata": {"name": p},
             "status": {"containerStatuses": [{"state": {"waiting": {
                 "reason": r, "message": m}}}]}}
            for p, r, m in states]})

    def cluster(payload, rc=0):
        def run(argv, **kw):
            import subprocess as sp
            return sp.CompletedProcess(argv, rc, payload, "")
        return run

    # An image that does not exist is decided; say so.
    monkeypatch.setattr(k8s, "run", cluster(pods(
        ("rocketchat-abc", "ErrImagePull", 'manifest for rocket.chat:9.9.9 not found'))))
    found = k8s.terminal_pod_failure("w", context="c")
    assert found is not None
    pod, reason, message = found
    assert pod == "rocketchat-abc" and reason == "ErrImagePull"
    assert "9.9.9" in message, "carry the registry's own words, not a paraphrase"

    # A pod still starting is NOT terminal -- this is the false positive that would
    # turn every slow pull into a failed create.
    monkeypatch.setattr(k8s, "run", cluster(pods(
        ("rocketchat-abc", "ContainerCreating", ""),
        ("mongodb-0", "PodInitializing", ""))))
    assert k8s.terminal_pod_failure("w", context="c") is None

    # Neither is a healthy pod with no waiting state at all.
    monkeypatch.setattr(k8s, "run", cluster(
        _json.dumps({"items": [{"metadata": {"name": "rc"},
                                "status": {"containerStatuses": [
                                    {"state": {"running": {}}}]}}]})))
    assert k8s.terminal_pod_failure("w", context="c") is None

    # An unreadable cluster is not evidence of failure either.
    monkeypatch.setattr(k8s, "run", cluster("", rc=1))
    assert k8s.terminal_pod_failure("w", context="c") is None
    monkeypatch.setattr(k8s, "run", cluster("not json"))
    assert k8s.terminal_pod_failure("w", context="c") is None

    # An init container counts: MongoDB's fix-permission container runs there.
    monkeypatch.setattr(k8s, "run", cluster(_json.dumps({"items": [
        {"metadata": {"name": "mongodb-0"},
         "status": {"initContainerStatuses": [{"state": {"waiting": {
             "reason": "CreateContainerConfigError", "message": "secret missing"}}}]}}]})))
    got = k8s.terminal_pod_failure("w", context="c")
    assert got and got[1] == "CreateContainerConfigError"


def test_the_registration_token_never_becomes_a_value_or_an_argument(monkeypatch):
    """The EE licence token reaches Rocket.Chat by REFERENCE, never as a literal.

    `--reg-token` was refused on this runtime, and the reason had outlived itself:
    "injected through the preset environment, which this runtime does not apply yet"
    -- preset env had been applied here for some time. Taken from PR #3, whose design
    is better than the obvious one, and the reason is exposure:

      * helm VALUES are readable with `helm get values` by anyone who can reach the
        release, and houston also writes them to `repros/<n>/kubernetes/values.yaml`
        for a human to read. That is precisely where the MongoDB password was moved
        out of, so putting a licence token there would undo the same lesson.
      * The manifest goes to `kubectl apply -f -` on STDIN, so the token is never a
        process argument either, where `ps` shows it to every user on the box.
    """
    import yaml as _yaml

    from houston.services import k8s

    token = "SUPERSECRETTOKEN"

    # 1. The Secret carries it; the values only name the Secret.
    doc = _yaml.safe_load(k8s.reg_token_secret_manifest("w", token=token, owner="me"))
    assert doc["kind"] == "Secret" and doc["type"] == "Opaque"
    assert doc["stringData"][k8s.REG_TOKEN_KEY] == token
    assert doc["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "houston", \
        "teardown selects on ownership, so the Secret has to carry it"

    values = k8s.values_for(rc_version="8.5.1",
                            rc_image="registry.rocket.chat/rocketchat/rocket.chat",
                            microservices=False,
                            mongo_url="mongodb://mongodb:27017/rocketchat",
                            reg_token_secret=k8s.REG_TOKEN_SECRET)
    assert token not in _yaml.safe_dump(values), \
        "the token must not be in anything `helm get values` can print"
    entry = next(e for e in values["extraEnv"] if e["name"] == "REG_TOKEN")
    assert entry["valueFrom"]["secretKeyRef"] == {"name": k8s.REG_TOKEN_SECRET,
                                                 "key": k8s.REG_TOKEN_KEY}
    assert "value" not in entry, "by reference, never by value"

    # 2. Without a token, nothing is referenced -- no dangling secretKeyRef.
    plain = k8s.values_for(rc_version="8.5.1",
                           rc_image="registry.rocket.chat/rocketchat/rocket.chat",
                           microservices=False,
                           mongo_url="mongodb://mongodb:27017/rocketchat")
    assert not any(e["name"] == "REG_TOKEN" for e in plain["extraEnv"]), \
        "a workspace with no token must not reference a Secret that does not exist"

    # 3. Applied on stdin, so it is never visible in argv.
    seen = {}
    def fake_run(argv, **kw):
        import subprocess as sp
        seen["argv"] = argv
        return sp.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(k8s.subprocess, "run",
                        lambda argv, **kw: fake_run(argv, **kw))
    k8s.apply(k8s.reg_token_secret_manifest("w", token=token), namespace="ns",
              context="c")
    assert token not in " ".join(seen["argv"]), \
        "`ps` would show a token passed as an argument to every user on the box"
    assert "-f" in seen["argv"] and "-" in seen["argv"], "applied from stdin"


def test_kubernetes_refuses_what_it_would_silently_drop(monkeypatch, tmp_path):
    """Five create options were ACCEPTED and then ignored on this runtime.

    `--preset ldap` is the clearest: the Kubernetes path's only `presets.load` is a
    hardcoded "default", so the name was written into repro.json and nothing else
    happened -- `houston list` showed "ldap" for a workspace with no LDAP in it. A
    create that reports success and produces something else is the worst outcome
    available, and it is the failure mode this whole runtime split keeps producing:
    --seed, --https, mongo_flavor and mongo_shell were all the same shape.

    `--fresh` is the one that matters most and is reported first: it means DELETE
    this workspace's data, and the Kubernetes path keeps the PersistentVolumeClaim.
    """
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def req(**kw):
        return lc.CreateReq(version="8.5.1", runtime=topology.KUBERNETES, **kw)

    cases = [
        # `--reg-token` used to be here, refused because "the EE registration token
        # is injected through the preset environment, which this runtime does not
        # apply yet". Preset env had been applied here for some time, so the reason
        # had outlived itself while the flag stayed refused; it now travels in an
        # Opaque Secret referenced by `valueFrom`, and is asserted below.
        (req(fresh=True), "--fresh"),
    ]
    for creq, expected in cases:
        with pytest.raises(errors.ValidationError) as caught:
            lc._refuse_unsupported_on_kubernetes(creq)
        assert expected in str(caught.value), f"{expected}: {caught.value}"

    # `--https` HAS LEFT THIS TABLE, and that is the point of the change rather than a
    # gap in it. A runtime-wide "not supported" cannot say which of four different
    # things is missing, so it was replaced by refusals about THIS CLUSTER, in
    # `_kubernetes_tls_plan`: no ingress class, no cert-manager, no reachable :443
    # Service, or a cluster that is not on this machine. The table's job is to catch
    # what would be ACCEPTED AND DROPPED, and --https is now honoured.
    lc._refuse_unsupported_on_kubernetes(req(https="local"))

    # `--domain` HAS ALSO LEFT, and for the same reason: what was missing was an ACME
    # ClusterIssuer, and that is now one IssuerSpec away from the `ca` one. The table
    # is down to the one option that is genuinely dropped rather than refused.
    lc._refuse_unsupported_on_kubernetes(req(domain="x.example",
                                             acme_email="ops@example.com"))
    assert [f["field"] for f in lc.unsupported_fields("kubernetes")] == ["fresh"]

    # What IS supported must still pass straight through, or this becomes a wall.
    lc._refuse_unsupported_on_kubernetes(req(preset="default", name="x", pin=True,
                                             monitor=True, seed=True, wait=True,
                                             mongo_operator=True, replicas=3,
                                             reg_token="abc"))
    # And `ldap` passes now BECAUSE it has an adapter -- the refusal is per preset,
    # not a blanket "presets do not work here". That is what slice 4 bought.
    lc._refuse_unsupported_on_kubernetes(req(preset="ldap", params={"users": "3"}))
    # The refusal names the ones that DO work, so the answer is actionable.
    # EVERY preset reaches Kubernetes now, each with its own backing workload:
    # openldap, keycloak (twice), mailpit, minio, nginx. The guard stays because it
    # is what keeps a future preset from being recorded and never applied.
    from houston import presets
    for p in presets.list_presets():
        # `multi-instance` is a DEPLOYMENT on this branch, not a scenario -- the
        # legacy YAML still exists in the catalogue and correctly refuses here,
        # because its nats/traefik pair is what --deployment provides natively.
        if p.name == "multi-instance":
            with pytest.raises(errors.ValidationError):
                lc._refuse_unsupported_on_kubernetes(req(preset=p.name))
            continue
        lc._refuse_unsupported_on_kubernetes(req(preset=p.name))

    # And it still bites: a preset with backing services and no manifests is refused,
    # naming the services that would have been missing.
    import dataclasses
    broken = dataclasses.replace(presets.load("email"), kubernetes_manifests=[])
    monkeypatch.setattr(presets, "resolve", lambda *a, **kw: broken)
    with pytest.raises(errors.ValidationError) as caught:
        lc._refuse_unsupported_on_kubernetes(req(preset="email"))
    assert "mailpit" in str(caught.value), caught.value


def test_the_kubernetes_refusals_are_reached_from_the_create_path():
    """Wired at the dispatch, not merely defined. A guard nothing calls is worse
    than no guard, because the docstring says it is handled."""

    src = source_of(lc._create_repro_locked)
    call = source_index(src, "_refuse_unsupported_on_kubernetes")
    dispatch = source_index(src, "_create_kubernetes(req")
    assert call < dispatch, "the refusal must run BEFORE the workspace is built"


def test_a_scenarios_settings_reach_the_rocket_chat_container(monkeypatch):
    """The SHARED half of the Scenario contract, and the half that silently did not
    arrive.

    `values_for` took `preset_env`, threaded it from `create_workspace`, and then
    never used it -- the parameter was declared, passed, and dropped on the floor.
    The live run showed the symptom exactly: OpenLDAP deployed, ready and labelled,
    and Rocket.Chat with no LDAP setting on it at all. A backing service nothing is
    configured to use is the same silent-drop shape as the rest of this runtime,
    one level further in.

    Appended AFTER the base list so a preset can override a default rather than be
    overridden by one -- the precedence compose.py already gives it.
    """
    from houston import presets
    from houston.services import k8s, topology

    preset = presets.resolve("ldap", topology.KUBERNETES, {"users": "7"})
    values = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                            preset_env=preset.env)
    got = {e["name"]: e["value"] for e in values["extraEnv"]}
    assert got.get("OVERWRITE_SETTING_LDAP_Host") == "openldap", got
    assert got.get("OVERWRITE_SETTING_LDAP_Enable") in ("true", "True"), got
    # The workspace's own admin env must survive alongside it.
    # The workspace's own admin env survives alongside it; INITIAL_USER is gone from
    # both runtimes and does not come back (see the extraEnv test above).
    assert got["ADMIN_USERNAME"] and "INITIAL_USER" not in got

    # A preset wins over a base default, rather than the other way round.
    override = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                              preset_env={"ADMIN_NAME": "Scenario"})
    names = [e["value"] for e in override["extraEnv"] if e["name"] == "ADMIN_NAME"]
    assert names[-1] == "Scenario", names


def test_the_chart_value_host_is_a_hostname_and_a_url_is_refused():
    """The chart CONCATENATES, so a URL here rendered a nonsense ROOT_URL.

    `rocketchat/rocketchat` 7.0.2, templates/chat-deployment.yaml:

        - name: ROOT_URL
          value: https://{{ .Values.host }}

    and `values_for` took a parameter called `root_url` and assigned it straight to
    `values["host"]`. Rendered with what `_create_kubernetes` computes:

        $ helm template rocketchat . --set host=http://localhost:32812
                - name: ROOT_URL
                  value: https://http://localhost:32812

    `.Values.host` is also the Ingress rule host, so the same value corrupts both
    the URL Rocket.Chat advertises and the name an ingress would route -- which is
    exactly what the HTTPS work has to set. Refused rather than normalised: a caller
    passing a URL here has a bug, and stripping the scheme would hide it.
    """
    from houston.services import k8s

    with pytest.raises(errors.ValidationError) as exc:
        k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                       host="http://localhost:32812")
    assert "bare hostname" in str(exc.value)
    # A port is the same trap one character smaller.
    with pytest.raises(errors.ValidationError):
        k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                       host="ticket.houston.localhost:443")
    # The legitimate shape, which is what the official values.yaml documents.
    values = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                            host="ticket.houston.localhost")
    assert values["host"] == "ticket.houston.localhost"


def test_a_kubernetes_workspace_advertises_the_url_it_is_reached_on():
    """This runtime set no ROOT_URL at all, on any workspace it ever made.

    The chart emits one only from `.Values.host`, and nothing passed it -- so
    Rocket.Chat ran on its own built-in default while every human reached it on an
    allocated port. ROOT_URL is what absolute links, OAuth callbacks and CORS derive
    from, so it was wrong for all three. Compose has always set it.

    And never twice: with `host` given, the chart writes ROOT_URL itself, and a
    second entry from `extraEnv` is a server-side-apply failure rather than an
    override -- the same `duplicate entries for key` that DEPLOY_PLATFORM produced.
    """
    from houston.services import k8s

    plain = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                           root_url="http://localhost:32812")
    env = {e["name"]: e.get("value") for e in plain["extraEnv"]}
    assert env.get("ROOT_URL") == "http://localhost:32812", env
    assert "host" not in plain, "a port-forward workspace has no ingress host"

    # With a name, the chart derives the URL -- so extraEnv must NOT carry one.
    named = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                           host="ticket.houston.localhost")
    assert [e for e in named["extraEnv"] if e["name"] == "ROOT_URL"] == [], \
        "the chart already emits ROOT_URL from `host`; a second entry is a conflict"

    # Asking for both is the caller not knowing which mechanism it wants.
    with pytest.raises(errors.ValidationError):
        k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                       root_url="http://localhost:1", host="a.example.com")


def test_the_kubernetes_create_passes_the_url_it_just_computed(monkeypatch, tmp_path):
    """`create_workspace` has taken `root_url` since it was written; nothing gave it one.

    So the parameter existed, `values_for` had a branch for it, and the branch was
    dead on every real create -- which is how a whole runtime shipped with no
    ROOT_URL. The fix is one keyword, and this is the test that keeps it there.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s, "assert_namespace_available", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "pick_host_port", lambda *a, **kw: 3456)
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                  "mongo_flavor": "official", "oplog": False, "source": "t"})())
    seen: dict = {}
    monkeypatch.setattr(k8s, "create_workspace", lambda **kw: seen.update(kw) or {
        "context": k8s.CONTEXT, "namespace": "houston-k", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": "",
        "microservices": False})

    lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k",
                                       runtime=topology.KUBERNETES))
    assert seen.get("root_url") == "http://localhost:3456", \
        "the create computed a URL and did not pass it, so the chart set none"


def test_tearing_down_a_kubernetes_workspace_drops_its_edge_route(monkeypatch, tmp_path):
    """The Kubernetes branch returned before the line that removes the route.

    Correct while a Kubernetes workspace could not have one. The moment `--https`
    lands it is a leak with a nasty shape: the route outlives the namespace, so the
    hostname 502s instead of 404ing -- pointing at a backend rather than at nothing
    -- and the name can never be reused by anyone else. The Compose branch twenty
    lines below has always dropped it, for exactly this reason.
    """
    from houston.services import edge as edgesvc
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="kws", project="houston-kws", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="",
                           preset="default", root_url="http://localhost:3001",
                           host_port=3001, version_source="t",
                           public_url="https://kws.houston.localhost")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["edge"] = True
    lc.runner.write("kws", "", m)
    # The route as `edge.register` would have left it.
    edgesvc.dynamic_dir().mkdir(parents=True, exist_ok=True)
    route = edgesvc.route_path("kws")
    route.write_text("# generated\n")

    monkeypatch.setattr(k8s, "workload_exists", lambda *a, **kw: True)
    monkeypatch.setattr(k8s, "delete_namespace", lambda *a, **kw: True)
    monkeypatch.setattr(k8s, "remove_operator", lambda *a, **kw: False)
    monkeypatch.setattr(k8s, "remove_monitoring", lambda *a, **kw: False)

    lc.teardown("kws", volumes=True, confirm=True)
    assert not route.exists(), \
        "the namespace went and the edge route stayed, so that name would 502 for ever"


def _svc(ns, name, kind, *, port=443, node_port=None, address=""):
    """One Service, shaped as `kubectl get svc -A -o json` really returns it."""
    entry = {"port": port, "name": "https"}
    if node_port is not None:
        entry["nodePort"] = node_port
    doc = {"metadata": {"namespace": ns, "name": name},
           "spec": {"type": kind, "ports": [entry]}}
    if address:
        doc["status"] = {"loadBalancer": {"ingress": [{"ip": address}]}}
    return doc


def _svc_reader(monkeypatch, items, *, rc=0, stderr=""):
    """Stub the ONE seam every cluster read goes through, and record the argv."""
    import subprocess as sp

    from houston.services import k8s

    seen: list[list[str]] = []

    def spy(argv, timeout=None, own=False, env=None):
        seen.append(argv)
        if "nodes" in argv:
            body = {"items": [{"status": {"addresses": [
                {"type": "Hostname", "address": "docker-01"},
                {"type": "InternalIP", "address": "172.16.0.2"}]}}]}
            return sp.CompletedProcess(argv, 0, json.dumps(body), "")
        return sp.CompletedProcess(argv, rc, json.dumps({"items": items}) if not rc
                                  else "", stderr)

    monkeypatch.setattr(k8s, "run", spy)
    return seen


def test_the_ingress_endpoint_is_the_service_reachable_from_outside(monkeypatch):
    """Publishing :443 is not enough to be an ingress, and the first real cluster said so.

    Asked on this box's k3s, THREE Services publish 443 -- `default/kubernetes` (the
    API server), `kube-system/metrics-server` and `kube-system/traefik` -- and only
    the last is the ingress. Both others are ClusterIP, which is not merely unrouted
    from outside but unroutable: a virtual IP realised by kube-proxy's netfilter
    rules on the node. So a ClusterIP cannot be a front door whatever port it
    publishes, and reachability is what separates them.

    Found by the ambiguity guard firing on a healthy cluster, which is the guard
    doing its job -- the alternative was picking the API server and passing a
    workspace's TLS through to it.
    """
    from houston.services import k8s

    _svc_reader(monkeypatch, [
        _svc("default", "kubernetes", "ClusterIP"),
        _svc("kube-system", "metrics-server", "ClusterIP"),
        _svc("kube-system", "traefik", "LoadBalancer", node_port=31123,
             address="172.16.0.2"),
    ])
    monkeypatch.setattr(k8s, "is_local_address", lambda ip: ip == "172.16.0.2")
    ep = k8s.ingress_endpoint("default")
    assert (ep.address, ep.port) == ("172.16.0.2", 443), ep
    assert ep.source == "loadbalancer" and ep.service == "kube-system/traefik", ep
    assert ep.local is True, "k3s's ServiceLB address IS one of this host's own"
    assert str(ep) == "172.16.0.2:443", "the shape a passthrough route needs"


def test_a_nodeport_is_a_real_endpoint_and_not_a_degraded_one(monkeypatch):
    """`k8s-https.md` §2 calls NodePort "a fallback for a cluster with no
    LoadBalancer address at all -- not the k3s path", and then its own acceptance
    test ran through one, because it had to.

    Every LoadBalancer Service carries a nodePort anyway, so this is an answer rather
    than a consolation -- and it is THE answer on a cluster whose ingress has been
    moved off the host ports, which is exactly what `doctor` tells a k3s user to do
    when the cluster is taking :443 from the edge.
    """
    from houston.services import k8s

    _svc_reader(monkeypatch, [
        _svc("kube-system", "traefik", "NodePort", node_port=31123),
    ])
    monkeypatch.setattr(k8s, "is_local_address", lambda ip: True)
    ep = k8s.ingress_endpoint("default")
    assert (ep.address, ep.port) == ("172.16.0.2", 31123), ep
    assert ep.source == "nodeport", ep


def test_a_cluster_that_could_not_be_asked_is_not_a_cluster_without_an_ingress(monkeypatch):
    """The module's oldest rule, at a new call site.

    Returning None for a refused read would make "your cluster has no ingress
    controller" the message for an expired credential, a wrong context or an
    unreachable API server -- and send the reader to install something they already
    have. `Answer.require` is what refuses to guess.
    """
    from houston.services import k8s

    _svc_reader(monkeypatch, [], rc=1,
                stderr="Error in configuration: context was not found")
    with pytest.raises(errors.DockerError) as exc:
        k8s.ingress_endpoint("nope")
    assert "refusing to guess" in str(exc.value)


def test_two_candidate_ingresses_are_reported_rather_than_guessed(monkeypatch):
    """Kubernetes does not link an IngressClass to the Service that serves it -- the
    class names a controller string and nothing else. So with two reachable Services
    on :443 there is no answer, and picking the first would work on every cluster
    anybody tests and silently pass one workspace's TLS to the wrong ingress on the
    cluster where it mattered."""
    from houston.services import k8s

    _svc_reader(monkeypatch, [
        _svc("kube-system", "traefik", "LoadBalancer", address="172.16.0.2"),
        _svc("ingress-nginx", "controller", "LoadBalancer", address="172.16.0.3"),
    ])
    with pytest.raises(errors.ConflictError) as exc:
        k8s.ingress_endpoint("default")
    assert "traefik" in str(exc.value) and "controller" in str(exc.value)
    assert "port-forward" in str(exc.value), "say what to do instead"


def test_a_cluster_with_no_reachable_ingress_answers_none(monkeypatch):
    """Absence, asserted by the cluster, is a fact and safe to act on -- as distinct
    from the refused read above. kind ships no ingress controller at all."""
    from houston.services import k8s

    _svc_reader(monkeypatch, [_svc("default", "kubernetes", "ClusterIP")])
    assert k8s.ingress_endpoint("default") is None


def test_services_are_asked_for_across_every_namespace(monkeypatch):
    """`-A`, and it must come AFTER the subcommand.

    Without it kubectl reads the CURRENT namespace, so the ingress -- which lives in
    `kube-system` -- is invisible and the cluster reads as having none: an empty,
    exit-0, entirely believable wrong answer. And `--all-namespaces` belongs to `get`
    rather than being global, so placed before it kubectl answers "flags cannot be
    placed before plugin name: --context". Both were live bugs, in that order.
    """
    from houston.services import k8s

    seen = _svc_reader(monkeypatch, [
        _svc("kube-system", "traefik", "LoadBalancer", address="10.0.0.9")])
    k8s.ingress_endpoint("default")
    argv = seen[0]
    assert "-A" in argv, argv
    assert argv.index("-A") > argv.index("get"), \
        "kubectl refuses --all-namespaces placed before the subcommand"


# --- --https on Kubernetes: the refusals, which are the feature -------------------

def _kube_tls_env(monkeypatch, *, ingress=("traefik",), cert_manager=True,
                  distribution="k3s", endpoint="present", claims=(),
                  ingress_class=None):
    """Stub the cluster reads `_kubernetes_tls_plan` makes. Nothing runs kubectl.

    That sentence was aspirational. `ensure_ingress` was NOT stubbed here -- each
    test was expected to do it -- and three did not, so they called the real one,
    which reads IngressClasses through kubectl. On a box with a reachable cluster
    that returns a class and the tests pass; on a box without one it raises

        DockerError: could not read the IngressClasses in cluster 'default' ...
        refusing to guess

    and they fail. So they passed here and failed on a clean machine, which is the
    worst way for a test to be wrong: the suite was green wherever it was written.

    `ingress_class` is what `ensure_ingress` returns -- by default the first class
    the cluster is said to have, which is what adopting one does. Pass it explicitly
    to describe an INSTALL, where the class that appears is not the one the earlier
    probe saw.
    """
    from houston.services import k8s

    pre = k8s.Preflight(context="default", cluster_reachable=True,
                        ingress_classes=list(ingress), distribution=distribution,
                        provider=k8s.PROVIDER_EXTERNAL)
    monkeypatch.setattr(k8s, "preflight", lambda ctx="": pre)
    _cls = ingress_class if ingress_class is not None else (
        list(ingress)[0] if ingress else "traefik")
    monkeypatch.setattr(k8s, "ensure_ingress", lambda **kw: _cls)
    # And helm's own reachability, for the same reason: it shells out, so a box with
    # a cluster answers "" and a box without one answers with an error that refuses
    # the create.
    monkeypatch.setattr(k8s, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s, "cert_manager_installed", lambda ctx: cert_manager)
    # Adopt-or-install is exercised in its own tests; here it must not reach a cluster.
    monkeypatch.setattr(k8s, "ensure_cert_manager", lambda **kw: None)
    ep = (k8s.IngressEndpoint(address="172.16.0.2", port=443, source="loadbalancer",
                              service="kube-system/traefik", local=True)
          if endpoint == "present" else None)
    monkeypatch.setattr(k8s, "ingress_endpoint", lambda ctx, **kw: ep)
    monkeypatch.setattr(k8s, "host_port_claim", lambda ctx, **kw: (
        k8s.PortClaim(context=ctx, service="kube-system/traefik",
                      address="172.16.0.2", ports=list(claims)) if claims else None))
    return k8s.ClusterPlan(context="default", distribution=distribution, create=False)


def _local_spec(host="ws.houston.localhost"):
    from houston import tls as tlsmod
    return tlsmod.TlsSpec(mode=tlsmod.MODE_LOCAL, host=host, port=443)


def test_https_on_kubernetes_installs_an_ingress_when_the_cluster_has_none(monkeypatch):
    """Adopt what is there, install what is not -- and the order is the point.

    The ingress controller is the component a support case is usually about, so a
    cluster already running nginx keeps running nginx. Installing is only for a cluster
    that has NONE: k3s with `--disable traefik`, a bare kubeadm, or houston's own
    fresh kind cluster, where `--https` used to be a dead end.

    This replaced a blanket refusal, and with it the `plan.create` refusal: a cluster
    that does not exist yet is now created and filled in rather than turned away.
    """
    from houston import tls as tlsmod
    from houston.services import k8s

    # Already has one: the plan uses that class.
    plan = _kube_tls_env(monkeypatch, ingress=("traefik",))
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), plan)
    assert ktls.ingress_class == "traefik"

    # Had none: the plan must use what was INSTALLED, not what the earlier probe saw.
    # Reading `pre.ingress_classes` after an install finds nothing -- the class is a
    # separate object that appears a moment behind the release.
    plan = _kube_tls_env(monkeypatch, ingress=(), ingress_class="nginx")
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), plan)
    assert ktls.ingress_class == "nginx"

    # A cluster that does not exist yet is created, not refused. `ensure_kubeconfig` is
    # what makes it, and the plan then probes the cluster it just brought up.
    made: list = []
    monkeypatch.setattr(k8s, "ensure_kubeconfig",
                        lambda plan, emit=None: made.append(plan.context) or "default")
    unmade = k8s.ClusterPlan(context="default", distribution="kind", create=True)
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), unmade)
    assert made == ["default"], "the cluster has to exist before it can be asked"
    assert ktls.ingress_class == "nginx"

    # cert-manager is no longer a refusal either: the guide lists it as a prerequisite
    # AND gives the command, so houston runs the documented step. Requiring it by hand
    # while installing the ingress automatically was an inconsistency with no reason.
    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    nocm = _kube_tls_env(monkeypatch, cert_manager=False)
    made: list[str] = []
    monkeypatch.setattr(k8s, "ensure_cert_manager",
                        lambda **kw: made.append(kw["context"]))
    lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", domain="a.example.com"),
                            acme, nocm)
    assert made == ["default"], "cert-manager is installed, not demanded"


def test_cert_manager_is_adopted_or_installed_like_the_ingress(monkeypatch):
    """The guide lists cert-manager as a prerequisite AND gives the command, so
    houston runs the documented step rather than demanding it.

    Requiring it by hand while installing the ingress controller automatically was an
    inconsistency with no reason behind it -- both are things the guide tells an
    operator to install, and both are now adopt-or-install.

    Installed BY KUBECTL as the guide does it, and that is load-bearing rather than
    stylistic: the static manifest has no `startupapicheck` and no Job at all, so two
    of the seven findings recorded against this work cannot arise -- nothing can fail a
    post-install hook, and the `crds.enabled`-versus-`installCRDs` trap has nowhere to
    happen.
    """
    import subprocess as sp

    from houston.services import k8s

    # Already there: adopted, nothing run.
    ran: list[list[str]] = []
    monkeypatch.setattr(k8s, "cert_manager_installed", lambda ctx: True)
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: ran.append(argv))
    k8s.ensure_cert_manager(context="c", distribution="k3s")
    assert ran == [], "nothing may be applied over a cert-manager already installed"

    # Absent on a local cluster: applied, then waited for.
    seen = {"n": 0}

    def present(ctx):
        seen["n"] += 1
        return seen["n"] > 1

    calls: list[list[str]] = []
    monkeypatch.setattr(k8s, "cert_manager_installed", present)
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: calls.append(argv)
                        or sp.CompletedProcess(argv, 0, "", ""))
    k8s.ensure_cert_manager(context="c", distribution="kind", sleep=lambda s: None)
    apply = next(c for c in calls if "apply" in c)
    assert apply[:2] == ["kubectl", "--context"], apply
    assert any(a.endswith("cert-manager.yaml") for a in apply), apply
    assert not any("helm" in a for a in apply), "the guide uses kubectl, not helm"
    # The WEBHOOK, not just the apply: an issuer created before it is serving is
    # accepted and then never reconciled.
    waited = [c for c in calls if "rollout" in c]
    assert len(waited) == len(k8s.CERT_MANAGER_DEPLOYMENTS), waited


def test_cert_manager_is_not_installed_into_somebody_elses_cluster(monkeypatch):
    """Six CRDs and an admission webhook change what a cluster IS, for every workload
    in it -- not something to do to a managed cluster on the way to booting a repro.
    There it names the command, and adopts as soon as it is there."""
    from houston.services import k8s

    monkeypatch.setattr(k8s, "cert_manager_installed", lambda ctx: False)
    monkeypatch.setattr(k8s, "run", lambda *a, **kw: pytest.fail("must not install"))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_cert_manager(context="prod", distribution="eks")
    msg = str(exc.value)
    assert "not on this machine" in msg
    assert "kubectl apply -f" in msg and "cert-manager.yaml" in msg, msg
    assert "adopts it as soon as it is there" in msg, "say what would change the answer"
    # Unknown locality must not read as local.
    monkeypatch.setattr(k8s, "distribution_of", lambda ctx: "")
    with pytest.raises(errors.PreflightError):
        k8s.ensure_cert_manager(context="prod", distribution="")


def test_cert_manager_applied_but_never_answering_is_a_failure(monkeypatch):
    """`kubectl apply` returns as soon as the objects are accepted. What matters is
    whether the cluster can issue a Certificate, which is the CRD being there."""
    import subprocess as sp

    from houston.services import k8s

    monkeypatch.setattr(k8s, "cert_manager_installed", lambda ctx: False)
    monkeypatch.setattr(k8s, "run",
                        lambda argv, **kw: sp.CompletedProcess(argv, 0, "", ""))
    monkeypatch.setattr(k8s, "CERT_MANAGER_TRIES", 2)
    with pytest.raises(errors.CreateFailedError) as exc:
        k8s.ensure_cert_manager(context="c", distribution="kind", sleep=lambda s: None)
    assert "CRDs never appeared" in str(exc.value)


def test_https_on_kubernetes_will_not_send_the_ca_key_to_a_remote_cluster(monkeypatch):
    """A `ca` ClusterIssuer means houston's CA PRIVATE KEY in a cluster Secret.

    `tls_local.py` says what that key is: it "can mint a certificate for any name the
    browser will trust". On this machine's own cluster that is the same trust boundary
    as the box, which already holds the key at 0600. On a managed cluster it is not,
    and there is a better answer that needs no CA at all.

    An `AuthorityGateError`, not a validation failure: the input is fine and the
    environment is fine, and what is missing is a decision houston is not entitled
    to make.
    """
    plan = _kube_tls_env(monkeypatch, distribution="eks")
    with pytest.raises(errors.AuthorityGateError) as exc:
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)
    assert "CA private key" in str(exc.value)
    assert "--domain" in str(exc.value), "name the alternative that needs no CA"
    # Unknown must not read as local: the question is whether a key may leave the box.
    plan = _kube_tls_env(monkeypatch, distribution="")
    with pytest.raises(errors.AuthorityGateError):
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)


def test_https_on_kubernetes_refuses_when_nothing_can_route_to_the_name(monkeypatch):
    """An ingress CLASS with no reachable Service is a controller nothing outside the
    cluster can reach. The workspace would install, the Ingress would exist, the
    certificate would issue, and the name would answer nothing."""
    plan = _kube_tls_env(monkeypatch, endpoint=None)
    with pytest.raises(errors.PreflightError) as exc:
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)
    assert "no Service publishing :443" in str(exc.value)


def test_the_https_plan_reports_whether_the_cluster_already_owns_443(monkeypatch):
    """Two topologies, both normal, and they need different things.

    k3s's ServiceLB claims host :80/:443 by hostPort DNAT, so the name reaches the
    cluster's ingress with no edge involved. Anywhere else the edge must own :443 and
    pass the name through. Measured rather than assumed, because getting it wrong
    either requires an edge that is not needed or omits one that is.
    """
    # THE CLAIM HAS TO BE TRUE FOR THIS NAME. Holding host :443 is not the same as
    # being where the workspace's hostname points, and this asserted only the first:
    # k3s ServiceLB claims 172.16.0.2 while `<name>.houston.localhost` resolves to
    # loopback, klipper's DNAT is IPv4-only, and the EDGE answers there -- so the
    # https URL houston printed returned 404. Both directions are pinned now.
    plan = _kube_tls_env(monkeypatch, claims=(80, 443))
    monkeypatch.setattr(lc, "_name_reaches", lambda host, claim: True)
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), plan)
    assert ktls.cluster_owns_443 is True
    assert ktls.ingress_class == "traefik"
    assert str(ktls.endpoint) == "172.16.0.2:443"

    # Same claim, but the name does not resolve to the ingress: through the edge.
    plan = _kube_tls_env(monkeypatch, claims=(80, 443))
    monkeypatch.setattr(lc, "_name_reaches", lambda host, claim: False)
    assert lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), plan).cluster_owns_443 is False, \
        "a name that resolves elsewhere is not served by the cluster, claim or no claim"

    plan = _kube_tls_env(monkeypatch, claims=())
    assert lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                    _local_spec(), plan).cluster_owns_443 is False


def test_a_loopback_name_is_not_reached_by_a_cluster_on_a_host_address():
    """`_name_reaches` on its own, because the decision above turns on it.

    The real resolver, no stubs: `*.houston.localhost` is loopback by construction
    and a ServiceLB address is not, which is the pairing that produced a 404 from a
    URL the create had just printed as ready.
    """
    import types

    claim = types.SimpleNamespace(address="172.16.0.2", ports=[80, 443])
    assert lc._name_reaches("ws.houston.localhost", claim) is False
    assert lc._name_reaches("localhost", claim) is False
    # Unresolvable is NOT a mismatch: a `--domain` whose DNS has not propagated is
    # the normal state of a name being set up, and must not be moved off the cluster
    # for a reason that stops being true in minutes.
    assert lc._name_reaches("no-such-host.invalid", claim) is True
    # A claim with no address cannot be reached by anything.
    assert lc._name_reaches("localhost", types.SimpleNamespace(address="")) is False


def test_a_domain_on_kubernetes_plans_an_acme_issuer(monkeypatch):
    """`--https` and `--domain` are the same code path with a different ClusterIssuer,
    which is what the official values.yaml already implies -- the ingress block is
    byte-identical and only the annotation's value differs.

    Staging gets its own issuer NAME rather than a flag on one issuer:
    `privateKeySecretRef` holds the ACME ACCOUNT KEY, and pointing a production order
    at a staging account fails in a way that names neither. `tls.py` separates its
    storage file for the same reason.
    """
    from houston import tls as tlsmod
    from houston.services import k8s

    plan = _kube_tls_env(monkeypatch)
    spec = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1",
                                                domain="a.example.com"), spec, plan)
    assert ktls.issuer.mode == "acme"
    assert ktls.issuer.name == k8s.ACME_ISSUER
    assert ktls.issuer.directory == k8s.ACME_PRODUCTION
    assert ktls.issuer.acme_email == "ops@example.com"

    staging = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                             acme_email="ops@example.com", acme_staging=True)
    st = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1",
                                              domain="a.example.com"), staging, plan)
    assert st.issuer.name == k8s.ACME_ISSUER_STAGING, "a separate ACME account"
    assert st.issuer.directory == k8s.ACME_STAGING


def test_a_domain_needs_no_local_cluster_because_no_ca_key_leaves_the_box(monkeypatch):
    """The asymmetry that makes `--domain` the answer `--https`'s refusal points at.

    A `ca` issuer holds houston's CA private key, which can mint a certificate for
    any name this box trusts -- so it does not go into somebody else's cluster. An
    ACME issuer holds a Let's Encrypt ACCOUNT key, which is the cluster's own and
    mints nothing here. So a managed cluster refuses `--https` and accepts `--domain`.
    """
    from houston import tls as tlsmod

    plan = _kube_tls_env(monkeypatch, distribution="eks")
    with pytest.raises(errors.AuthorityGateError):
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)
    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1",
                                                domain="a.example.com"), acme, plan)
    assert ktls.issuer.mode == "acme", "the same cluster is fine for a public name"


def test_the_acme_issuer_is_the_official_guides_own_shape():
    """From docs.rocket.chat/docs/deploy-with-kubernetes, with two deliberate
    departures, both stated where the manifest is built:

    * `ingressClassName` rather than the guide's `class`, which is the deprecated
      spelling of the same field. Measured: an issuer written the guide's way reached
      `Ready=True reason=ACMEAccountRegistered` on cert-manager 1.21, so this is about
      not inheriting a deprecation.
    * http01 and NOT tls-alpn -- cert-manager does not implement tls-alpn at all,
      which is why the challenge differs from the Compose path's default.
    """
    import yaml as _yaml

    from houston.services import k8s

    doc = _yaml.safe_load(k8s.acme_issuer_manifest(
        k8s.IssuerSpec(mode="acme", acme_email="ops@example.com"),
        ingress_class="traefik"))
    acme = doc["spec"]["acme"]
    assert acme["server"] == k8s.ACME_PRODUCTION
    assert acme["email"] == "ops@example.com"
    assert acme["privateKeySecretRef"]["name"].endswith("-account-key")
    assert acme["solvers"] == [{"http01": {"ingress": {"ingressClassName": "traefik"}}}]
    assert "tlsALPN01" not in str(acme), "cert-manager does not implement it"


def test_force_does_not_switch_the_memory_preflight_off(monkeypatch, tmp_path):
    """`check_capacity` has a `--force` branch that WARNS and proceeds, added because
    "this is the guard that exists after an OOM took out a 10 GB host: overriding it
    has to stay visible".

    The caller excluded force from the call entirely, so for a new workspace the
    function was never reached and the loud override was a silent one.
    """
    from houston.services import lifecycle as lcsvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    calls: list = []
    monkeypatch.setattr(lcsvc, "check_capacity",
                        lambda *a, **k: calls.append(True))
    monkeypatch.setattr(lcsvc.runner, "up", lambda *a, **k: 0)
    monkeypatch.setattr(lcsvc.runner, "down", lambda *a, **k: 0)

    for force in (False, True):
        calls.clear()
        try:
            lcsvc.create_repro(lcsvc.CreateReq(version="8.5.1", name=f"cap{int(force)}",
                                               force=force))
        except Exception:               # noqa: BLE001 - the boot is not the subject
            pass
        assert calls, f"check_capacity was never called with force={force}"


def test_a_half_written_workspace_is_a_404_not_a_traceback(tmp_path, monkeypatch):
    """`runner.write` writes two files, each atomically; the PAIR is not atomic. A
    kill between them left a directory `exists()` accepts and `read_meta` could not
    read, and the bare FileNotFoundError escaped the ReproError contract -- in
    `serve` a 500 with a traceback, because detail() runs on the request thread.
    """
    from houston import runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ws = runnersvc.workspace("halfwritten")
    ws.mkdir(parents=True)
    (ws / "docker-compose.yml").write_text("services: {}\n")

    assert runnersvc.exists("halfwritten"), "precondition: it looks like a workspace"
    with pytest.raises(errors.MissingRecordError) as exc:
        runnersvc.read_meta("halfwritten")
    assert exc.value.http_status == 404
    assert "down --name halfwritten" in str(exc.value), "must say how to remove it"
    # Still a FileNotFoundError, so the callers that already skip on that keep working.
    assert isinstance(exc.value, FileNotFoundError)
    assert [m.name for m in runnersvc.list_meta()] == []


def test_the_record_is_written_before_the_compose_file(tmp_path, monkeypatch):
    """Which half survives a kill is decided by this order. The record is what makes
    a directory a workspace; the compose document is regenerated by `up` anyway."""
    from houston import runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    order: list[str] = []
    real = runnersvc.atomic_write
    monkeypatch.setattr(runnersvc, "atomic_write",
                        lambda p, c, **k: order.append(p.name) or real(p, c, **k))
    meta = runnersvc.Metadata(name="ordered", project="p", rc_version="8.5.1",
                              rc_image="i", mongo_tag="7.0", mongo_flavor="official",
                              preset="default", root_url="http://localhost:3000",
                              host_port=3000, version_source="x")
    runnersvc.write("ordered", "services: {}\n", meta)
    assert order[:2] == ["repro.json", "docker-compose.yml"], order


def test_a_kubernetes_workspace_directory_is_restricted_like_every_other(tmp_path,
                                                                         monkeypatch):
    """`_restrict` lives in `runner.write`, and the Kubernetes path wrote repro.json
    with a bare `atomic_write` -- so the 0700 directory that `write`'s own comment
    calls "what does the work" was absent on the one runtime that also writes
    `kubernetes/values.yaml` with ADMIN_PASS in it.
    """
    from houston import runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runnersvc.Metadata(name="kube", project="p", rc_version="8.5.1",
                              rc_image="i", mongo_tag="7.0", mongo_flavor="official",
                              preset="default", root_url="http://localhost:3000",
                              host_port=3000, version_source="x")
    runnersvc.write_record("kube", meta)
    mode = runnersvc.workspace("kube").stat().st_mode & 0o777
    assert mode == 0o700, f"workspace root is {mode:o}, traversable by other users"
    assert runnersvc.read_meta("kube").name == "kube"


def test_a_workspace_keeps_the_compose_project_it_was_created_under(tmp_path,
                                                                    monkeypatch):
    """`project_name` derived the name from `PROJECT_PREFIX` instead of reading the
    one repro.json already records, so the prefix and the containers on the daemon
    were two sources of truth that merely happened to agree.

    Renaming the tool ends the agreement: `list` reads the RECORDED project and
    reports the workspace running, while `down` derives a different one and tears
    down nothing -- leaking the containers with their published ports and the
    customer's Mongo volume. Pre-fix this returns "houston-legacy"; the recorded
    "rcrepro-legacy" is the finding.
    """
    from houston import runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runnersvc.Metadata(name="legacy", project="rcrepro-legacy",
                              rc_version="8.5.1", rc_image="i", mongo_tag="7.0",
                              mongo_flavor="official", preset="default",
                              root_url="http://localhost:3000", host_port=3000,
                              version_source="x")
    runnersvc.write_record("legacy", meta)
    assert runnersvc.project_name("legacy") == "rcrepro-legacy", (
        "a workspace must be addressed by the project its containers actually "
        "carry, not by the prefix this build would mint today")


def test_a_workspace_with_no_record_is_minted_from_the_current_prefix(tmp_path,
                                                                     monkeypatch):
    """The other half of the same rule: reading the record must not break creation.

    `up` calls `project_name` before there is anything to read, so an absent record
    has to fall through to the mint-time prefix rather than raise or return "".
    """
    from houston import config, runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert runnersvc.project_name("fresh") == runnersvc.mint_project_name("fresh")
    assert runnersvc.project_name("fresh") == config.PROJECT_PREFIX + "fresh"


def test_a_kubernetes_workspace_keeps_the_namespace_it_was_created_in(tmp_path,
                                                                     monkeypatch):
    """A namespace cannot be renamed in place, so once its objects exist the prefix
    that minted it is history rather than a description.

    Deriving it meant a changed prefix would send `down` at a namespace that was
    never created while the real one kept its pods, its PVCs and its port-forward.
    Pre-fix this returns "houston-legacy"; the recorded namespace is the finding.
    """
    from houston import runner as runnersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runnersvc.Metadata(name="legacy", project="rcrepro-legacy",
                              rc_version="8.5.1", rc_image="i", mongo_tag="7.0",
                              mongo_flavor="official", preset="default",
                              root_url="http://localhost:3000", host_port=3000,
                              version_source="x",
                              extra={"namespace": "rc-repro-legacy"})
    runnersvc.write_record("legacy", meta)
    assert k8s.namespace_for("legacy") == "rc-repro-legacy", (
        "a workspace must be addressed by the namespace its objects are in, not "
        "by the prefix this build would mint today")
    assert k8s.namespace_for("absent") == k8s.mint_namespace("absent")


def _legacy_home(root, *, runtime="kubernetes"):
    """A pre-rename ~/.rc-repro with one workspace, a state marker and an event log."""
    import json as _json

    legacy = root / ".rc-repro"
    (legacy / "repros" / "w1").mkdir(parents=True)
    (legacy / "logs").mkdir()
    (legacy / "repros" / "w1" / "repro.json").write_text(_json.dumps({
        "name": "w1", "project": "rcrepro-w1", "rc_version": "8.5.1", "rc_image": "rc",
        "mongo_tag": "7.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3000", "host_port": 3000,
        "version_source": "live", "public_url": "https://w1.rcrepro.localhost",
        "extra": {"runtime": runtime, "tls": "local"}}))
    (legacy / "sessions").write_text(
        "# rc-repro GUI sessions.\n# rc-repro-state: 2\n")
    (legacy / "logs" / "rc-repro.log").write_text('{"ts":"old"}\n')
    return legacy


def test_the_pre_rename_state_directory_is_adopted_not_recreated(tmp_path,
                                                                 monkeypatch):
    """The move must carry the workspace across intact, still addressed by the names
    its containers and namespace actually carry.

    Recreating anything here would destroy the customer data a repro exists to hold,
    so the check is that the OLD project and the OLD namespace survive the migration.
    """
    from houston import runner as runnersvc
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    legacy = _legacy_home(tmp_path)

    res = migratesvc.migrate()
    assert res["moved"] is True
    assert not legacy.exists(), "the old directory must not be left behind"
    assert (tmp_path / ".houston" / "repros" / "w1" / "repro.json").exists()
    assert runnersvc.project_name("w1") == "rcrepro-w1", "adopted, not re-minted"
    assert res["namespaces_recorded"] == ["w1"]
    meta = runnersvc.read_meta("w1")
    assert meta.extra["namespace"] == "rc-repro-w1"


def test_the_event_log_is_renamed_before_the_migration_says_anything(tmp_path,
                                                                    monkeypatch):
    """`events.info` TEES every event into the event log, which opens
    logs/houston.log as a side effect of being called.

    So a migration that announced the move before renaming the log would create the
    destination file itself and turn its own rename into a permanent no-op: the box
    keeps logs/rc-repro.log forever, `pending()` stays true, and the whole migration
    re-runs on every single command. Pre-fix logs/rc-repro.log survives; its absence
    is the finding.
    """
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    _legacy_home(tmp_path)

    migratesvc.migrate(emit=lambda ev: None)
    logs = tmp_path / ".houston" / "logs"
    assert not (logs / "rc-repro.log").exists(), sorted(p.name for p in logs.iterdir())
    assert (logs / "houston.log").read_text().startswith('{"ts":"old"}')
    assert migratesvc.pending() is False, "a finished migration must not re-run"


def test_a_target_holding_only_this_tools_own_event_log_is_still_migrated(
        tmp_path, monkeypatch):
    """`logs/houston.log` is opened by the FIRST command that runs at all, before any
    state has been adopted.

    So a box where somebody ran a single `houston --version` between upgrading and
    adopting has a non-empty ~/.houston containing nothing but a record of that one
    command -- and treating that as "state" refuses the migration permanently, on the
    strength of a file whose entire content is the invocation that created it. This
    is not hypothetical; it happened during this rename. Pre-fix the move is refused
    with a ConflictError; the move happening is the finding.
    """
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    _legacy_home(tmp_path)
    (tmp_path / ".houston" / "logs").mkdir(parents=True)
    (tmp_path / ".houston" / "logs" / "houston.log").write_text('{"cmd":"--version"}\n')

    assert migratesvc.migrate()["moved"] is True
    assert not (tmp_path / ".rc-repro").exists()
    assert (tmp_path / ".houston" / "repros" / "w1" / "repro.json").exists()


def test_agent_skill_copies_are_moved_to_the_new_directory_name(tmp_path,
                                                                monkeypatch):
    """`skill install` writes into ~/.claude/skills/<tool>/, so the directory name IS
    the tool name and a rename strands the copy.

    Nothing breaks loudly, which is the problem: the stale SKILL.md keeps teaching
    agents to run `rc-repro <cmd>`, a command that no longer exists, and the agent
    that follows it fails in a way that looks like the agent's fault. Safe to do
    unattended -- unlike the other leftovers these are this tool's own files, in a
    directory it made for itself, with no sudo and nothing shared.
    """
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    _legacy_home(tmp_path)
    for rel in (".claude/skills", ".agents/skills"):
        old = tmp_path / rel / "rc-repro"
        old.mkdir(parents=True)
        (old / "SKILL.md").write_text("# rc-repro\n")

    res = migratesvc.migrate()
    # The behavioural claim FIRST, so this fails on the behaviour against the pre-fix
    # code rather than on a result key that did not exist yet.
    for rel in (".claude/skills", ".agents/skills"):
        assert not (tmp_path / rel / "rc-repro").exists(), (
            f"{rel}/rc-repro survived the migration, still telling agents to run a "
            f"command that no longer exists")
        new = tmp_path / rel / "houston" / "SKILL.md"
        assert new.exists(), f"{rel} did not get the renamed copy"
        assert "name: houston" in new.read_text()
    assert len(res["skills_replaced"]) == 2, res["skills_replaced"]


def test_two_populated_state_directories_are_refused_rather_than_merged(tmp_path,
                                                                       monkeypatch):
    """Merging two state directories means choosing which `users` file wins, and no
    safe answer exists -- so it is a typed refusal that names both paths."""
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    _legacy_home(tmp_path)
    (tmp_path / ".houston").mkdir()
    (tmp_path / ".houston" / "users").write_text("# houston GUI accounts.\nbob\tx\n")

    with pytest.raises(errors.ConflictError) as caught:
        migratesvc.migrate()
    assert ".rc-repro" in str(caught.value) and ".houston" in str(caught.value)
    assert (tmp_path / ".rc-repro").exists(), "a refusal must not have moved anything"


def test_an_explicit_home_is_never_migrated_out_from_under_the_operator(tmp_path,
                                                                       monkeypatch):
    """HOUSTON_HOME set means somebody said where state lives. Moving a directory
    they named by hand is not this code's decision to make."""
    from houston.services import migrate as migratesvc

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "chosen"))
    _legacy_home(tmp_path)

    assert migratesvc.legacy_home() is None
    assert migratesvc.migrate()["moved"] is False
    assert (tmp_path / ".rc-repro").exists()


def test_doctor_names_the_leftovers_the_rename_could_not_move(tmp_path, monkeypatch):
    """Three classes of thing are outside the migration's reach: root-owned files, the
    shared edge, and copies this tool installed into other tools' directories.

    Each is INVISIBLE rather than broken -- a stale systemd unit fails at boot, an
    orphaned skill teaches an agent commands that no longer exist -- so the whole
    value is that something says so. Every row carries the command that fixes it.
    """
    from houston import runner as runnersvc
    from houston.services import doctor

    # The DEVELOPER's own box may be running a pre-rename edge, which would make this
    # pass for the wrong reason and the clean-box test below fail for one.
    monkeypatch.setattr(runnersvc, "docker_available", lambda **kw: False)
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / ".rc-repro").mkdir()
    (tmp_path / ".agents" / "skills" / "rc-repro").mkdir(parents=True)

    rows = [r for r in doctor.run_checks()["checks"] if r["check"] == "legacy-artifacts"]
    found = " ".join(r["message"] for r in rows)
    assert ".rc-repro" in found and "skills/rc-repro" in found, found
    assert all(r["status"] == "warn" for r in rows), rows
    assert "rm -rf" in found, "a row that does not say how to fix it is just noise"


def test_doctor_is_silent_about_a_box_that_never_ran_the_old_name(tmp_path,
                                                                  monkeypatch):
    """A clean box must get no rows about leftovers it does not have -- otherwise the
    check becomes a permanent paragraph everybody learns to scroll past."""
    from houston import runner as runnersvc
    from houston.services import doctor

    monkeypatch.setattr(runnersvc, "docker_available", lambda **kw: False)
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("HOME", str(tmp_path))

    rows = [r for r in doctor.run_checks()["checks"] if r["check"] == "legacy-artifacts"]
    assert rows == [], rows


def _quoted_houston_commands() -> "list[tuple[str, str]]":
    """Every `houston <something>` this package tells a person to run, with its file."""
    import pathlib
    import re

    import houston

    root = pathlib.Path(houston.__file__).parent
    found = []
    for path in sorted(root.rglob("*.py")):
        # BACKTICKED only. This file's convention is that a backtick means "run
        # this", and prose mentions the tool by name constantly -- "another houston
        # edge is already running" is a sentence, not an instruction, and matching it
        # would make the check noisy enough to be switched off.
        for m in re.finditer(r"`houston ([a-z][a-z0-9-]*)",
                             path.read_text(encoding="utf-8")):
            found.append((m.group(1), path.name))
    return found


def test_every_command_this_tool_tells_you_to_run_actually_exists():
    """A message naming a command that does not exist is worse than no message: it
    reads as authoritative and costs the reader a round trip to find out otherwise.

    This is not hypothetical. The migration and the doctor check both said `houston
    edge up`, and the verb is `start` -- so the one instruction printed at somebody
    whose edge had just stopped was the one thing they could not run. Nothing else in
    the suite could have caught it: the string was correct English in a correct
    sentence, and no test executes the text of a warning.
    """
    from houston import cli

    known = {c.name or c.callback.__name__ for c in cli.app.registered_commands}
    known |= {g.name for g in cli.app.registered_groups}
    wrong = sorted({(verb, where) for verb, where in _quoted_houston_commands()
                    if verb not in known})
    assert not wrong, (
        "these messages name a `houston <verb>` that is not a registered command: "
        + ", ".join(f"`houston {v}` in {w}" for v, w in wrong))


def test_every_edge_action_this_tool_tells_you_to_run_actually_exists():
    """The same rule one level down, where it actually bit.

    `edge` dispatches on a positional action rather than sub-commands, so a wrong verb
    is not a Typer error at import -- it is a runtime "unknown action" in front of
    somebody following instructions. The valid set is read from the CLI's own help
    text so this cannot drift from it.
    """
    import pathlib
    import re

    import houston
    from houston import cli

    src = source_of(cli.edge) if hasattr(cli, "edge") else ""
    declared = re.search(r'help="((?:status|start)[^"]*)"',
                         src or pathlib.Path(cli.__file__).read_text(encoding="utf-8"))
    assert declared, "could not find the edge action list in the CLI to check against"
    valid = {w.strip() for w in declared.group(1).split("|")}
    assert "start" in valid and "status" in valid, valid

    root = pathlib.Path(houston.__file__).parent
    wrong = []
    for path in sorted(root.rglob("*.py")):
        for m in re.finditer(r"`houston edge ([a-z-]+)",
                             path.read_text(encoding="utf-8")):
            if m.group(1) not in valid:
                wrong.append(f"`houston edge {m.group(1)}` in {path.name}")
    assert not wrong, ("these messages name an edge action that does not exist: "
                       + ", ".join(sorted(set(wrong))) + f". Valid: {sorted(valid)}")


def test_a_contact_address_cannot_add_keys_to_a_cluster_scoped_issuer():
    """The ClusterIssuer was built by f-string, so an `acme_email` carrying newlines
    was interpolated verbatim and the result was VALID YAML cert-manager accepts.

    A ClusterIssuer is CLUSTER-SCOPED and shared by every workspace on the box, so
    `skipTLSVerify: true` injected through one workspace's contact address would
    apply to all of them. Pre-fix this rendered six keys under `spec.acme`; the two
    extra ones are the finding.
    """
    import yaml as _yaml

    from houston.services import k8s

    hostile = ("ops@example.com\n    skipTLSVerify: true\n"
               "    disableAccountKeyGeneration: true\n    # ")
    doc = _yaml.safe_load(k8s.acme_issuer_manifest(
        k8s.IssuerSpec(mode="acme", acme_email=hostile), ingress_class="traefik"))
    acme = doc["spec"]["acme"]
    assert set(acme) == {"server", "email", "privateKeySecretRef", "solvers"}, (
        "the contact address added keys to a cluster-scoped issuer")
    # It survives as ONE scalar rather than being dropped: the address is wrong and
    # Let's Encrypt will say so, which is the right place for that to fail.
    assert acme["email"] == hostile
    assert doc["kind"] == "ClusterIssuer" and doc["apiVersion"] == "cert-manager.io/v1"


def test_a_mongo_tag_cannot_add_structure_to_the_statefulset():
    """`mongo_manifest` builds YAML by f-string, and `--mongo` is a plain CreateReq
    field that `POST /api/repros` copies straight from the body -- and is NOT in
    PRIVILEGED_CREATE_FIELDS, so any member+ GUI account could reach it.

    Pre-fix this rendered `privileged: true` and `hostPID: true` into a valid
    two-document manifest that `kubectl apply` accepts, bypassing the very control
    that exists to stop a member choosing what code runs.
    """
    from houston.services import k8s

    hostile = ("8.0\n        securityContext:\n          privileged: true\n"
               "        hostPID: true\n        # ")
    with pytest.raises(errors.ValidationError, match="not a MongoDB image tag"):
        k8s.mongo_manifest("t", hostile)
    # The legitimate tags this runtime actually uses are untouched.
    for good in ("8.0", "7.0.14", "6.0.5-ubi8", "latest"):
        assert k8s.mongo_manifest("t", good), good


def test_an_acme_issuer_that_never_registers_says_why(monkeypatch):
    """Registering an ACME account is a real call to Let's Encrypt FROM INSIDE the
    cluster, so this fails on no pod egress or a rejected contact address -- and it
    should fail once, here, rather than silently per Certificate afterwards."""
    from houston.services import k8s

    monkeypatch.setattr(k8s, "apply", lambda *a, **kw: None)
    monkeypatch.setattr(k8s, "ask_object",
                        lambda *a, **kw: k8s.Answer(k8s.PRESENT, {"metadata": {}}))
    monkeypatch.setattr(k8s, "ISSUER_WAIT_TRIES", 2)
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_acme_issuer(k8s.IssuerSpec(mode="acme", acme_email="a@b.c"),
                               context="c", ingress_class="traefik",
                               sleep=lambda s: None)
    msg = str(exc.value)
    assert "egress" in msg and "contact address" in msg, msg


def test_the_issuer_call_dispatches_on_the_spec_not_on_the_caller(monkeypatch):
    """One call site, two mechanisms. A branch at the caller is how `--https` and
    `--domain` would drift into two code paths again."""
    from houston.services import k8s

    seen: list[str] = []
    monkeypatch.setattr(k8s, "ensure_ca_issuer",
                        lambda **kw: seen.append("ca"))
    monkeypatch.setattr(k8s, "ensure_acme_issuer",
                        lambda spec, **kw: seen.append("acme"))
    k8s.ensure_issuer(k8s.IssuerSpec(mode="local"), context="c",
                      ingress_class="traefik")
    k8s.ensure_issuer(k8s.IssuerSpec(mode="acme", acme_email="a@b.c"), context="c",
                      ingress_class="traefik")
    assert seen == ["ca", "acme"]


def test_the_ingress_values_are_the_official_guides_shape():
    """From docs.rocket.chat/docs/deploy-with-kubernetes, and the point is that a
    customer's values.yaml and houston's differ only in the issuer NAME:

        host: <domain.xyz>
        ingress:
          enabled: true
          ingressClassName: traefik
          annotations:
            cert-manager.io/cluster-issuer: production-cert-issuer
          tls:
            - secretName: rckube
              hosts: [<domain.xyz>]
    """
    from houston.services import k8s

    v = k8s.ingress_values("ws.houston.localhost", ingress_class="traefik",
                           secret_name="ws-tls")
    assert v["host"] == "ws.houston.localhost"
    assert v["ingress"]["enabled"] is True
    assert v["ingress"]["ingressClassName"] == "traefik"
    assert v["ingress"]["annotations"] == {
        "cert-manager.io/cluster-issuer": k8s.CA_ISSUER}
    assert v["ingress"]["tls"] == [{"secretName": "ws-tls",
                                    "hosts": ["ws.houston.localhost"]}]


def test_the_ca_issuer_is_a_tls_secret_and_a_clusterissuer_that_signs_from_it():
    """A `ca` issuer rather than an `acme` one is what makes `--https` and `--domain`
    the same values.yaml with one field different."""
    import yaml as _yaml

    from houston.services import k8s

    docs = [d for d in _yaml.safe_load_all(
        k8s.ca_issuer_manifest("-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----",
                               "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----"))
        if d]
    secret = next(d for d in docs if d["kind"] == "Secret")
    issuer = next(d for d in docs if d["kind"] == "ClusterIssuer")
    assert secret["type"] == "kubernetes.io/tls", "cert-manager reads tls.crt/tls.key"
    assert set(secret["stringData"]) == {"tls.crt", "tls.key"}
    assert secret["metadata"]["namespace"] == k8s.CERT_MANAGER_NAMESPACE, \
        "a ClusterIssuer reads its Secret from the cluster-resource namespace"
    assert issuer["spec"]["ca"]["secretName"] == secret["metadata"]["name"]
    # Labelled as ours, so it can be told from a cluster's own issuers.
    assert issuer["metadata"]["labels"][k8s.OWNER_LABEL_KEY] == k8s.OWNER_LABEL_VALUE


def test_an_issuer_that_never_reconciles_is_a_refusal_not_a_silence(monkeypatch):
    """`k8s-https.md` §4's third finding: a ClusterIssuer created before cert-manager
    is ready is ACCEPTED and then never reconciled -- no `.status` at all -- so no
    Certificate ever issues and nothing says why.

    Waiting for `Ready=True` means a workspace has either a working issuer or a
    refusal, never the silent third thing.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s, "apply", lambda *a, **kw: None)
    monkeypatch.setattr(k8s, "ask_object",
                        lambda *a, **kw: k8s.Answer(k8s.PRESENT, {"metadata": {}}))
    monkeypatch.setattr(k8s, "ISSUER_WAIT_TRIES", 2)
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_ca_issuer(context="c", sleep=lambda s: None)
    assert "did not become ready" in str(exc.value)
    assert "says nothing" in str(exc.value), "name the failure mode, not just the wait"

    # And it returns quietly once the condition is there.
    monkeypatch.setattr(k8s, "ask_object", lambda *a, **kw: k8s.Answer(
        k8s.PRESENT, {"status": {"conditions": [
            {"type": "Ready", "status": "True", "message": "Signing CA verified"}]}}))
    k8s.ensure_ca_issuer(context="c", sleep=lambda s: None)


def test_publishing_a_kubernetes_name_checks_it_instead_of_claiming_it(monkeypatch):
    """Measured on a box in exactly this state: the edge was bound, running, healthy,
    and answering every https name with its OWN default certificate, because the
    cluster had taken :443 underneath it. Nothing said so.

    `tls.verify` already reports that as `fallback`, so the proof is one existing call
    -- and a name that does not work has to say so at create time rather than be
    discovered in a browser.
    """
    from houston import tls as tlsmod
    from houston.services import edge as edgesvc
    from houston.services import k8s

    monkeypatch.setattr(edgesvc, "installed", lambda: True)
    monkeypatch.setattr(edgesvc, "running", lambda: True)
    monkeypatch.setattr(edgesvc, "register", lambda *a, **kw: False)
    ktls = lc._KubeTls(host="ws.houston.localhost", ingress_class="traefik",
                       endpoint=k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                                    "kube-system/traefik", True),
                       cluster_owns_443=True)
    said: list[str] = []
    emit = lambda ev: said.append(f"{ev.level}:{ev.message}")  # noqa: E731

    monkeypatch.setattr(tlsmod, "verify", lambda *a, **kw: {
        "serving": True, "fallback": True, "issuer": "CN = TRAEFIK DEFAULT CERT"})
    lc._publish_kubernetes_name("ws", ktls, emit=emit, sleep=lambda s: None)
    joined = "\n".join(said)
    assert "warn:" in joined and "default certificate" in joined, joined
    assert "terminating TLS for this name" in joined, joined

    said.clear()
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **kw: {
        "serving": True, "fallback": False, "issuer": "CN = houston local CA"})
    lc._publish_kubernetes_name("ws", ktls, emit=emit, sleep=lambda s: None)
    assert any("is serving the cluster's certificate" in s for s in said), said


def test_the_name_is_given_time_to_go_live_before_it_is_called_broken(monkeypatch):
    """Found by running it, on a chain that was completely correct.

    `up --https --runtime kubernetes` reported "answered with a proxy's own default
    certificate, so something in front is terminating TLS for this name instead of
    passing it through" -- and the same name served the cluster's certificate seconds
    later. A route file APPEARING and Traefik's file provider having RELOADED it are
    a second apart, and the proof ran in between.

    A check that fires on every healthy create is worse than no check: it is how a
    reader learns to ignore the one line here that would have told them something.
    `cli._report_gui_tls` already polls about ACME for exactly this reason.
    """
    from houston import tls as tlsmod
    from houston.services import edge as edgesvc
    from houston.services import k8s

    monkeypatch.setattr(edgesvc, "installed", lambda: True)
    monkeypatch.setattr(edgesvc, "running", lambda: True)
    monkeypatch.setattr(edgesvc, "register", lambda *a, **kw: False)
    ktls = lc._KubeTls(host="ws.houston.localhost", ingress_class="traefik",
                       endpoint=k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                                    "kube-system/traefik", True),
                       cluster_owns_443=False)
    said: list[str] = []
    # The real sequence: the default certificate twice while the proxy reloads, then
    # the cluster's.
    answers = [
        {"serving": True, "fallback": True, "issuer": "CN = TRAEFIK DEFAULT CERT"},
        {"serving": True, "fallback": True, "issuer": "CN = TRAEFIK DEFAULT CERT"},
        {"serving": True, "fallback": False, "issuer": "CN = houston local CA"},
    ]
    monkeypatch.setattr(tlsmod, "verify",
                        lambda *a, **kw: answers.pop(0) if answers else answers)
    lc._publish_kubernetes_name("ws", ktls,
                                emit=lambda ev: said.append(f"{ev.level}:{ev.message}"),
                                sleep=lambda s: None)
    joined = "\n".join(said)
    assert "warn:" not in joined, f"a reloading proxy is not a broken chain: {joined}"
    assert "is serving the cluster's certificate" in joined, joined
    assert not answers, "it must actually retry, not give up after one look"


def test_a_public_name_create_says_nothing_about_credentials(monkeypatch):
    """The warning that used to fire here is GONE, deliberately, and this is what
    replaced it.

    It said the name was reachable, that the password was generated rather than
    admin123, where to read it, and to `down --volumes` when finished -- next to a
    summary panel that prints the URL and `admin / <the password>` two lines later.
    Every clause was either already on screen or a generic reminder, and a warning
    people scroll past is worse than no warning: it trains them to scroll past the
    next one.

    What made the original necessary was that a public name ran the SAME `admin123`
    as every loopback workspace and nothing said so. That is no longer true --
    `reachable_beyond_loopback` generates a password for exactly these workspaces --
    so the condition the sentence existed to report does not occur any more.
    """
    from houston import tls as tlsmod

    plan = _kube_tls_env(monkeypatch)
    said: list[str] = []
    emit = lambda ev: said.append(f"{ev.level}:{ev.message}")  # noqa: E731
    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", name="pub",
                                         domain="a.example.com"), acme, plan,
                            emit=emit)
    joined = "\n".join(said)
    for gone in ("reachable by anyone who can resolve it", "admin password is GENERATED",
                 "admin123", "username as their password", "--volumes when you are"):
        assert gone not in joined, f"{gone!r} is still being said:\n{joined}"
    # The TLS progress it does still report is untouched -- removing a credentials
    # warning must not take the http-01 explanation with it.
    assert "http-01 challenge" in joined, joined


def test_a_public_name_still_gets_a_password_of_its_own(monkeypatch):
    """The property the warning used to announce. Removing the sentence must not be
    read, later, as removing the behaviour -- so it is asserted where the sentence
    used to be tested."""
    from houston import tls as tlsmod

    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    assert lc.reachable_beyond_loopback(tlsspec=acme, bind_host="127.0.0.1")


def test_the_route_exists_before_the_chart_can_start_an_acme_order(monkeypatch):
    """Ordering, and it is the whole difference between a certificate and a timeout.

    cert-manager starts an ACME order the moment it sees the Ingress -- which the CHART
    creates during `helm install` -- and the http-01 challenge arrives on this host's
    :80. The first version of this published the name AFTER the install and after
    `wait_for_certificate`, so Let's Encrypt got a connection refused, the order
    failed, and the wait spent its whole budget on a challenge that could never have
    been answered.

    Asserted on the ORDER of the two calls, because that is the thing that was wrong.
    """

    src = source_of(lc._create_kubernetes)
    route = source_index(src, "_route_kubernetes_name(")
    install = source_index(src, "k8s.create_workspace(")
    prove = source_index(src, "_publish_kubernetes_name(")
    assert route < install, "the challenge must have somewhere to land before the chart"
    assert install < prove, "and the proof means nothing until the Ingress exists"


def test_routing_a_name_starts_the_edge_only_when_the_cluster_does_not_own_443(monkeypatch):
    """Two topologies, and one of them needs no edge at all.

    With k3s's ServiceLB holding host :80/:443 the name reaches the cluster's ingress
    directly -- starting an edge would take the port away from the thing already
    serving it. Anywhere else the edge must own :443 and pass the name through.
    """
    from houston.services import edge as edgesvc
    from houston.services import k8s

    ep = k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer", "kube-system/traefik",
                             True)
    starts: list[str] = []
    monkeypatch.setattr(edgesvc, "running", lambda: False)
    monkeypatch.setattr(edgesvc, "installed", lambda: False)
    monkeypatch.setattr(edgesvc, "ensure_running",
                        lambda **kw: starts.append("started") or edgesvc.StartResult(True))
    monkeypatch.setattr(edgesvc, "register", lambda *a, **kw: False)

    lc._route_kubernetes_name("ws", lc._KubeTls(
        host="a.example.com", ingress_class="traefik", endpoint=ep,
        cluster_owns_443=True))
    assert starts == [], "the cluster already answers on :443; do not take the port"

    lc._route_kubernetes_name("ws", lc._KubeTls(
        host="a.example.com", ingress_class="traefik", endpoint=ep,
        cluster_owns_443=False))
    assert starts == ["started"], "nothing else holds :443, so the edge must"


def test_a_cold_mongod_is_retried_rather_than_failing_the_create(monkeypatch):
    """Reproduced twice out of two on freshly installed k3s clusters.

        error: could not initiate the MongoDB replica set:
               mongonetworkerror: connect econnrefused 127.0.0.1:27017

    `init_replica_set` waits for `containerStatuses[0].started` and its own comment
    says exactly why it cannot wait for READINESS -- readiness needs the replica set,
    and this is the initiation. That reasoning is right, and it leaves a window: the
    container is up and mongod has not bound :27017 yet.

    The retry existed and did not cover it. Its predicate was an allow-list of ONE
    error string ("container not found"), written for a different race -- a pod that
    reports `started` while terminating -- so a connection refusal returned on the
    first attempt and failed the whole create. On a warm cluster mongod binds before
    the exec arrives and nobody sees it; on an empty containerd store with a cold PVC
    it loses the race every time. Which means it fired on somebody's FIRST create.
    """
    import subprocess as sp

    from houston.services import k8s

    calls: list[int] = []

    def flaky(context, namespace, script):
        calls.append(1)
        if len(calls) < 3:
            return sp.CompletedProcess([], 1, "", "MongoNetworkError: connect "
                                       "ECONNREFUSED 127.0.0.1:27017")
        return sp.CompletedProcess([], 0, "1", "")

    monkeypatch.setattr(k8s, "_mongo_exec_once", flaky)
    res = k8s._mongo_exec("c", "ns", "rs.status().ok", sleep=lambda s: None)
    assert res.returncode == 0, "a cold mongod is a wait, not a dead create"
    assert len(calls) == 3, calls

    # A REAL error must still come straight back -- retrying an authentication
    # failure five times just makes the report slower and no more accurate.
    calls.clear()
    monkeypatch.setattr(k8s, "_mongo_exec_once", lambda *a: sp.CompletedProcess(
        [], 1, "", "MongoServerError: Authentication failed"))
    res = k8s._mongo_exec("c", "ns", "rs.status().ok", sleep=lambda s: None)
    assert res.returncode == 1
    assert k8s._mongo_exec_once("c", "ns", "x").returncode == 1  # sanity

    # And the other transient it was originally written for still retries.
    calls.clear()
    seen: list[int] = []

    def terminating(context, namespace, script):
        seen.append(1)
        if len(seen) < 2:
            return sp.CompletedProcess([], 1, "", 'container not found ("mongod")')
        return sp.CompletedProcess([], 0, "1", "")

    monkeypatch.setattr(k8s, "_mongo_exec_once", terminating)
    assert k8s._mongo_exec("c", "ns", "x", sleep=lambda s: None).returncode == 0
    assert len(seen) == 2


def test_the_edge_joins_a_kind_clusters_docker_network(monkeypatch):
    """A kind cluster's ingress is unreachable from where the edge lives.

    kind's node is a CONTAINER on kind's own Docker network, so its ingress NodePort
    answers from the host and not from a container on the default bridge. Measured:
    `172.18.0.2:30925` reachable from the host and from a container on the `kind`
    network, **unreachable** from one on `bridge` -- which is exactly where the edge
    is. `k8s-https.md` §4's fifth finding, and the one part of it that is genuinely
    kind-specific.

    `edge.attach` could not do this: it derives a network from a WORKSPACE name, and a
    cluster is not a workspace.
    """
    from houston.services import edge as edgesvc
    from houston.services import k8s

    # The derivation is pure -- no Docker in k8s.py, which owns no such seam.
    assert k8s.kind_node_container("kind-houston-local") == \
        "houston-local-control-plane"
    assert k8s.kind_node_container("default") == "", "k3s has no node container"
    assert k8s.kind_node_container("kind-") == ""

    joined: list[str] = []
    monkeypatch.setattr(edgesvc, "installed", lambda: True)
    monkeypatch.setattr(edgesvc, "running", lambda: True)
    monkeypatch.setattr(edgesvc, "register", lambda *a, **kw: False)
    monkeypatch.setattr(edgesvc, "container_network",
                        lambda c: "kind" if c == "houston-local-control-plane" else "")
    monkeypatch.setattr(edgesvc, "attach_network",
                        lambda n: joined.append(n) or True)

    ep = k8s.IngressEndpoint("172.18.0.2", 30925, "nodeport",
                             "ingress-nginx/ingress-nginx-controller", False)
    lc._route_kubernetes_name("ws", lc._KubeTls(
        host="a.example.com", ingress_class="nginx", endpoint=ep,
        context="kind-houston-local", cluster_owns_443=False))
    assert joined == ["kind"], "the edge must join the network the node is on"

    # And a k3s cluster has nothing to join: its endpoint is on the host itself.
    joined.clear()
    lc._route_kubernetes_name("ws", lc._KubeTls(
        host="a.example.com", ingress_class="traefik",
        endpoint=k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                     "kube-system/traefik", True),
        context="default", cluster_owns_443=False))
    assert joined == [], "joining a network k3s does not have would only fail"


def test_ensure_ingress_adopts_before_it_installs(monkeypatch):
    """A cluster already running nginx must keep running nginx.

    The ingress controller is the component a support case is usually ABOUT, so
    installing Traefik over the top of somebody's nginx would reproduce the wrong
    thing in exactly the dimension that matters.
    """
    from houston.services import k8s

    ran: list[list[str]] = []
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: ran.append(argv))
    monkeypatch.setattr(k8s, "ingress_classes", lambda ctx: ["nginx"])
    assert k8s.ensure_ingress(context="c", distribution="k3s") == "nginx"
    assert ran == [], "nothing may be installed over a controller that is already there"


def test_ensure_ingress_installs_the_guides_own_chart(monkeypatch):
    """`helm install traefik traefik/traefik -n traefik --create-namespace` is the
    official Rocket.Chat guide's own example, so a cluster houston filled in looks
    like a cluster somebody followed the guide on.

    And the chart's default Service type is LEFT ALONE. `helm show values` renders
    `type: LoadBalancer`; on a cluster with a provider it gets an address and the
    cluster owns :443, and on one without it stays `<pending>` while Kubernetes
    allocates NodePorts anyway. That is why no NodePort is configured anywhere --
    `ingress_endpoint` reads whichever exists.
    """
    import subprocess as sp

    from houston.services import k8s

    calls: list[list[str]] = []
    seen = {"n": 0}

    def classes(ctx):
        seen["n"] += 1
        return [] if seen["n"] == 1 else ["traefik"]

    monkeypatch.setattr(k8s, "ingress_classes", classes)
    monkeypatch.setattr(k8s, "clear_pending_release", lambda *a, **kw: None)
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: calls.append(argv)
                        or sp.CompletedProcess(argv, 0, "", ""))
    assert k8s.ensure_ingress(context="c", distribution="k3s",
                              sleep=lambda s: None) == "traefik"
    helm = next(c for c in calls if "upgrade" in c)
    assert helm[:4] == ["helm", "upgrade", "--install", "traefik"], helm
    assert "traefik/traefik" in helm
    assert "--create-namespace" in helm
    assert not any(a.startswith("service.type") for a in helm), \
        "the chart's own Service type is what the guide gives; do not override it"
    # AND NO `--wait`, NOR THE ROLLBACK FLAG THAT IMPLIES IT. Helm's readiness check
    # for a LoadBalancer Service waits for an address to be populated, and this chart's
    # Service is a LoadBalancer -- so on a cluster with no provider `--wait` cannot
    # succeed on exactly the cluster being installed into. Measured on k3s with
    # `--disable servicelb`: "release traefik failed, and has been uninstalled due to
    # atomic being set: context deadline exceeded", five minutes after three healthy
    # pods. The controller is waited for with `rollout status` instead.
    assert "--wait" not in helm, helm
    assert "--atomic" not in helm and "--rollback-on-failure" not in helm, helm
    assert any(c[:2] == ["kubectl", "--context"] and "rollout" in c for c in calls), \
        "the controller still has to be waited for, just not through helm"


def test_ensure_ingress_waits_for_the_class_not_just_the_release(monkeypatch):
    """helm returning means the Deployment is ready. The IngressClass is a SEPARATE
    object the chart creates, so a create that went straight on to reading the classes
    would find none and refuse for want of the thing it had just installed."""
    import subprocess as sp

    from houston.services import k8s

    looks = {"n": 0}

    def classes(ctx):
        looks["n"] += 1
        return ["traefik"] if looks["n"] > 3 else []

    monkeypatch.setattr(k8s, "ingress_classes", classes)
    monkeypatch.setattr(k8s, "clear_pending_release", lambda *a, **kw: None)
    monkeypatch.setattr(k8s, "run",
                        lambda argv, **kw: sp.CompletedProcess(argv, 0, "", ""))
    assert k8s.ensure_ingress(context="c", distribution="kind",
                              sleep=lambda s: None) == "traefik"
    assert looks["n"] > 2, "it has to keep looking, not read once"


def test_ensure_ingress_will_not_provision_a_cloud_load_balancer_implicitly(monkeypatch):
    """The chart's Service is a LoadBalancer, and on a managed cluster that provisions
    a REAL load balancer -- billable, created implicitly, in somebody's account.
    `.docs/design/kubernetes-cluster-model.md` already decided that one: never create a
    billable cloud resource implicitly. So a remote cluster is told what to run."""
    from houston.services import k8s

    import subprocess as sp

    monkeypatch.setattr(k8s, "ingress_classes", lambda ctx: [])
    # Only a HELM call is forbidden. Reads are fine -- deciding locality is itself a
    # read, and a stub that refuses every subprocess would fail on the question rather
    # than on the answer.
    def no_helm(argv, **kw):
        assert argv[0] != "helm", f"must not install: {argv}"
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", no_helm)
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_ingress(context="prod", distribution="eks")
    assert "not on this machine" in str(exc.value)
    assert "helm install traefik" in str(exc.value), "say what to run instead"
    # Unknown locality must not read as local: the question is whether to spend money.
    monkeypatch.setattr(k8s, "distribution_of", lambda ctx: "")
    with pytest.raises(errors.PreflightError):
        k8s.ensure_ingress(context="prod", distribution="")


def test_ensure_ingress_refuses_a_read_it_could_not_make(monkeypatch):
    """The module's oldest rule at one more call site. Reading a refused list as "this
    cluster has no controller" would install one into a cluster that already had it,
    over a credential problem."""
    from houston.services import k8s

    monkeypatch.setattr(k8s, "ingress_classes", lambda ctx: None)
    monkeypatch.setattr(k8s, "run", lambda *a, **kw: pytest.fail("must not install"))
    with pytest.raises(errors.DockerError) as exc:
        k8s.ensure_ingress(context="c", distribution="k3s")
    assert "refusing to guess" in str(exc.value)


def test_doctor_says_which_https_shape_the_box_is_in(monkeypatch, tmp_path):
    """One row that answers "can this box serve a name, and how".

    Every fact in it is reported somewhere above -- the ingress class, the load
    balancer, the edge, the port claim -- and reading four rows and composing them is
    exactly what nobody does at the moment they need the answer. Which of the two
    shapes the box is in is the fact every HTTPS question turns on: the cluster owning
    :443 and answering directly, or the edge owning it and passing the name through.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pre = k8s.Preflight(context="default", cluster_reachable=True,
                        cluster_exists=True, ingress_classes=["traefik"],
                        distribution="k3s", provider=k8s.PROVIDER_EXTERNAL,
                        default_storage_class="local-path",
                        tools={n: k8s.Tool(name=n, version=(1, 36), path="/x")
                               for n in k8s.CORE_TOOLS})
    monkeypatch.setattr(k8s, "preflight", lambda ctx="": pre)
    monkeypatch.setattr(k8s, "cert_manager_installed", lambda ctx: True)
    monkeypatch.setattr(k8s, "port_claiming_cluster", lambda **kw: None)

    def shape(ep):
        monkeypatch.setattr(k8s, "ingress_endpoint", lambda ctx, **kw: ep)
        rows = [r for r in doctor.run_checks()["checks"]
                if r.get("check") == "kubernetes-https"]
        assert rows, "the row must always be emitted for a reachable cluster"
        return rows[0]["message"]

    # The cluster owns :443 -- answered directly, no edge in the path.
    said = shape(k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                     "kube-system/traefik", True))
    assert "CLUSTER's own ingress" in said, said
    assert "directly" in said, said

    # The edge owns it -- the name is passed through to a NodePort.
    said = shape(k8s.IngressEndpoint("172.16.0.2", 32492, "nodeport",
                                     "kube-system/traefik", True))
    assert "edge" in said and "passed through by SNI" in said, said
    assert "32492" in said, "name the endpoint, so it can be dialled by hand"

    # Nothing reachable: say what it would take, not that something is broken.
    said = shape(None)
    assert "not servable yet" in said, said

    # AND IT MUST NOT PROMISE A CERT-MANAGER SECRET WHEN THERE IS NO CERT-MANAGER.
    # This row sat directly under one saying cert-manager was not installed, and
    # described what WOULD happen as though it already did.
    monkeypatch.setattr(k8s, "cert_manager_installed", lambda ctx: False)
    said = shape(k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                     "kube-system/traefik", True))
    assert "once cert-manager is installed" in said, said
    assert "from a cert-manager Secret" not in said, said


def test_nothing_is_installed_before_every_read_only_refusal_has_passed(monkeypatch):
    """A refusal must leave nothing behind, and this one left an ingress controller.

    Measured on a fresh kind box: the create built the cluster, installed
    traefik/traefik into it, and THEN refused for want of cert-manager. Every check
    that can be answered by reading has to come first, so the one step that changes
    the cluster is the last thing before it is committed to.
    """

    src = source_of(lc._kubernetes_tls_plan)
    local = source_index(src, "is_local_cluster(")
    cm = source_index(src, "ensure_cert_manager(")
    ing = source_index(src, "ensure_ingress(")
    ep = source_index(src, "ingress_endpoint(")
    assert local < cm, "refuse a remote cluster before creating anything in it"
    assert cm < ing, "cert-manager first — the ingress annotation names its issuer"
    assert ing < ep, "the endpoint is the Service the ingress install created"

    # And a refusal really does happen without touching the cluster: `--https` on a
    # cluster that is not on this machine would send the CA key there.
    from houston.services import k8s

    plan = _kube_tls_env(monkeypatch, distribution="eks", ingress=())
    monkeypatch.setattr(k8s, "ensure_cert_manager",
                        lambda **kw: pytest.fail("must not install"))
    monkeypatch.setattr(k8s, "ensure_ingress",
                        lambda **kw: pytest.fail("must not install"))
    with pytest.raises(errors.AuthorityGateError):
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)


def test_a_scenario_forward_waits_for_a_ready_endpoint(monkeypatch):
    """Binding a local socket is not the same as the backend answering.

    `kubectl port-forward svc/...` binds immediately and only then dials a pod, so a
    forward started while the workload is still booting passes a TCP check on the
    local side, fails upstream and exits. Keycloak takes about forty seconds to
    import its realm, and the live run showed exactly that: "keycloak published at
    http://localhost:8081", then connection refused a minute later.

    So the endpoint is waited for first. Third kind of forward, third time this
    lesson: the workspace URL needed the pod Running, Grafana needed the socket
    confirmed, and this needs a ready endpoint before either check means anything.
    """
    import subprocess

    from houston.services import k8s

    calls = []

    def fake_run(argv, **kw):
        calls.append(argv)
        if "svc" in argv and "get" in argv:
            return subprocess.CompletedProcess(argv, 0, stdout="kc 8081 8080\n", stderr="")
        if "endpoints" in argv:
            # Never ready -- the forward must NOT be started at all.
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(k8s, "run", fake_run)
    monkeypatch.setattr(k8s.subprocess, "Popen",
                        lambda *a, **kw: pytest.fail("forwarded before it was ready"))
    out = k8s.scenario_ui_forwards("w", namespace="houston-w", context=k8s.CONTEXT,
                                   sleep=lambda _s: None)
    assert out == {}, out
    assert sum("endpoints" in a for argv in calls for a in argv) >= 10, \
        "it must actually retry rather than check once"


def test_a_preset_configures_itself_through_the_runtime_that_owns_it(monkeypatch):
    """`no configuration file provided: not found` in the middle of a Kubernetes
    create, followed by "starting".

    That is docker compose's own wording for "there is no compose project here", and
    it appeared because a post_ready handler -- a preset configuring ITSELF -- called
    `runner.compose_exec` on a Kubernetes workspace. Presets exist on both runtimes
    now, so the one call that reaches into a container had to stop being a Compose
    call.
    """
    from houston.services import postready, topology

    m = postready.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                                  rc_image="i", mongo_tag="8.0",
                                  mongo_flavor="official", preset="saml",
                                  root_url="u", host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)

    monkeypatch.setattr(postready.runner, "compose_exec",
                        lambda *a, **kw: pytest.fail("it reached for docker compose"))
    from houston.services import k8s
    seen = []

    class _R:
        returncode, stdout, stderr = 0, "keycloak-abc", ""

    monkeypatch.setattr(k8s, "run", lambda argv, **kw: (seen.append(argv), _R())[1])
    assert postready._exec_in(m, "keycloak", ["bash", "-lc", "true"]) == 0
    assert any("kubectl" in a for argv in seen for a in argv), seen
    assert any("exec" in argv for argv in seen), seen

    # A Compose workspace must still go the other way -- this is a fork, not a swap.
    c = postready.runner.Metadata(name="c", project="houston-c", rc_version="8.5.1",
                                  rc_image="i", mongo_tag="8.0",
                                  mongo_flavor="official", preset="saml",
                                  root_url="u", host_port=3001, version_source="t")
    monkeypatch.setattr(postready.runner, "compose_exec", lambda *a, **kw: 0)
    monkeypatch.setattr(k8s, "run",
                        lambda *a, **kw: pytest.fail("it reached for kubectl"))
    assert postready._exec_in(c, "keycloak", ["true"]) == 0


def test_a_half_configured_preset_says_so_instead_of_reporting_success():
    """The create printed "could not fetch/apply IdP cert", then "starting", and
    left the reader to work out whether SAML actually worked.

    The DEPLOYMENT succeeding and the CONFIGURATION succeeding are different answers
    to different questions, and a workspace that is running with a half-applied
    preset has to say which one it is -- naming what failed and the command that
    retries it.
    """
    from houston.services import postready

    m = postready.runner.Metadata(name="w", project="p", rc_version="8.5.1",
                                  rc_image="i", mongo_tag="8.0",
                                  mongo_flavor="official", preset="saml",
                                  root_url="u", host_port=3000, version_source="t")
    m.extra["post_ready"] = [{"action": "saml_idp_cert"},
                             {"action": "keycloak_master_ssl_off"}]
    said: list = []
    postready._POST_READY_ACTIONS["saml_idp_cert"] = lambda *a, **kw: False
    postready._POST_READY_ACTIONS["keycloak_master_ssl_off"] = lambda *a, **kw: True
    try:
        failed = postready.run_post_ready(m, object(), lambda e: said.append(e.message))
    finally:
        import importlib
        importlib.reload(postready)

    assert failed == ["saml_idp_cert"], failed
    joined = " ".join(said)
    assert "RUNNING" in joined and "partly configured" in joined, joined
    assert "saml_idp_cert" in joined, joined
    assert "houston ready --name w" in joined, joined


def test_a_scenario_forward_targets_the_deployment_not_the_service(monkeypatch):
    """A live OIDC workspace: Keycloak 1/1 Running, the recorded forward pid gone,
    nothing answering on 8085.

    `kubectl port-forward svc/...` dies when the Service's endpoint churns. The
    workspace's own forward learned this and uses `deployment/`; scenario UIs then
    reintroduced it. It also has to publish the CONTAINER port -- a deployment
    forward cannot use the Service's port, and for SAML those differ (8081 -> 8080).
    """
    import subprocess

    from houston.services import k8s

    spawned = []

    def fake_run(argv, **kw):
        if "get" in argv and "svc" in argv:
            out = "keycloak 8081 8080\n"
        elif "endpointslices" in argv:
            # EndpointSlice, not the deprecated `endpoints`: kubectl warns on every
            # call to the old one ("v1 Endpoints is deprecated in v1.33+") and this
            # is a WAIT LOOP, so the day it stops being served the old call would
            # spin to its timeout rather than fail visibly.
            out = json.dumps({"items": [
                {"metadata": {"labels": {"kubernetes.io/service-name": "keycloak"}},
                 "endpoints": [{"conditions": {"ready": True}}]}]})
        else:
            out = ""
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

    monkeypatch.setattr(k8s, "run", fake_run)
    # `_FakeProc`, because the code asks `poll()` now: a scenario forward is only
    # published if OUR kubectl got the socket, not merely if the port answers.
    monkeypatch.setattr(k8s.subprocess, "Popen",
                        lambda argv, **kw: (spawned.append(argv), _FakeProc(4242))[1])
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s, "pid_owns_port_exclusively", lambda *a, **kw: True)

    out = k8s.scenario_ui_forwards("w", namespace="houston-w", context=k8s.CONTEXT,
                                   sleep=lambda _s: None)
    assert out == {8081: 4242}, out
    argv = spawned[0]
    assert "deployment/keycloak" in argv, argv
    assert not any(a.startswith("svc/") for a in argv), argv
    # host:container, so the CONTAINER port is what it maps to.
    assert "8081:8080" in argv, argv


def test_what_was_deployed_is_written_next_to_repro_json(tmp_path, monkeypatch):
    """A Compose workspace has a docker-compose.yml you can read; a Kubernetes one
    had only repro.json, because values go to `helm --values -` and manifests to
    `kubectl apply -f -` on stdin. Good for secrets, bad for answering "what did it
    actually deploy" -- especially once the cluster is gone and `helm get values` is
    no longer there to ask.

    Written for READING: re-running `up` regenerates them, exactly as it regenerates
    docker-compose.yml.
    """
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.services import k8s

    written = k8s.record_rendered(
        "w",
        values={"image": {"tag": "8.5.1"}, "existingMongodbSecret": "rocketchat-mongodb-url"},
        manifests={"mongodb": "kind: StatefulSet\n", "scenario": "kind: Deployment\n"})

    base = tmp_path / "repros" / "w" / "kubernetes"
    assert (base / "values.yaml").exists()
    assert (base / "mongodb.yaml").read_text() == "kind: StatefulSet\n"
    assert (base / "scenario.yaml").read_text() == "kind: Deployment\n"
    assert len(written) == 3, written

    # The values name the Secret; they must never CONTAIN the password. Moving the
    # MongoDB URL off `helm get values` was the point of v0.49.0, and writing it to
    # a file here would undo exactly that.
    body = (base / "values.yaml").read_text()
    assert "existingMongodbSecret" in body
    assert "mongodb://" not in body, body


def test_the_idp_cert_is_fetched_once_not_retried_around_a_retrier(monkeypatch):
    """A SAML create that sat for THIRTY MINUTES, found by the operational audit.

    `rcapi.fetch_saml_idp_cert` retries to its own deadline -- its docstring says
    "Retries until the IdP (e.g. Keycloak, which boots slowly) is serving" -- and
    v0.54.1 wrapped it in a second 20-attempt loop without reading that. 20 x 90s is
    half an hour of a create that looks hung and cannot be told from one that is.

    The deadline is passed IN instead, so there is one place that decides how long to
    wait.
    """

    from houston.services import postready

    src = source_of(postready._pr_saml_idp_cert)
    # The CALL, not the prose: the comment above it names the function to explain
    # why it is only called once, so counting the name counts the explanation too.
    assert src.count("rcapi.fetch_saml_idp_cert(") == 1, src
    assert "for attempt in range" not in src, "no loop around a function that loops"
    assert "timeout=IDP_CERT_DEADLINE" in src, src

    calls = []
    monkeypatch.setattr(postready.rcapi, "fetch_saml_idp_cert",
                        lambda url, **kw: (calls.append(kw), "")[1])
    postready._pr_saml_idp_cert(
        postready.runner.Metadata(name="w", project="p", rc_version="8.5.1",
                                  rc_image="i", mongo_tag="8.0",
                                  mongo_flavor="official", preset="saml",
                                  root_url="u", host_port=3000, version_source="t"),
        object(), {"descriptor_url": "http://localhost:8081/x", "setting": "s"},
        lambda e: None)
    assert len(calls) == 1, calls
    assert calls[0].get("timeout") == postready.IDP_CERT_DEADLINE, calls


# --- the panel, against a Kubernetes workspace ---------------------------------------

def _kube_workspace(tmp_path, monkeypatch, name="k", preset="ldap", extra=None):
    """A recorded Kubernetes workspace on disk, with NO compose file.

    The absence of the compose file is the condition every defect below shared: each
    of these code paths reached for it, and each answered with something outside the
    ReproError contract when it was not there.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name=name, project="p", rc_version="8.6.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset=preset,
                           root_url="http://localhost:3010", host_port=3010,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra.update({"context": k8s.CONTEXT, "namespace": f"houston-{name}",
                    "bind_host": "127.0.0.1", **(extra or {})})
    ws = lc.runner.workspace(name)
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    assert not (ws / "docker-compose.yml").exists()
    return m


def test_detail_gives_a_kubernetes_workspace_its_links_and_its_pods(
        monkeypatch, tmp_path):
    """The Kubernetes branch of detail() returned before it built either.

    `links` are not compose-shaped and never were: a preset's UI answers on the SAME
    host port under both runtimes, because k8s.scenario_ui_forwards forwards it to the
    same number deliberately. Leaving them out meant phpLDAPadmin, Keycloak, MinIO,
    Mailpit and Grafana were unreachable from the GUI on Kubernetes while the CLI
    printed every one of them.

    `containers` was empty on purpose, and the tab reads an empty list as "no
    containers — this repro is down" — under a workspace that was running, with no
    way at all to see an ImagePullBackOff from a browser.
    """
    from houston.services import k8s

    _kube_workspace(tmp_path, monkeypatch, preset="ldap")
    monkeypatch.setattr(lc, "kubernetes_state", lambda name, meta: "running")
    monkeypatch.setattr(k8s, "pod_rows", lambda name, **kw: [
        {"service": "rocketchat-rocketchat-1", "state": "running",
         "status": "1/1 ready", "health": "healthy", "restarts": 0,
         "started": "2026-08-18T10:00:00Z"},
        {"service": "rocketchat-mongodb-0", "state": "pending",
         "status": "ImagePullBackOff", "health": "", "restarts": 0, "started": ""}])

    d = lc.detail("k")
    labels = {link["label"] for link in d["links"]}
    assert "Rocket.Chat" in labels
    assert "phpLDAPadmin" in labels, "the scenario's own UI, on the same port as Compose"
    assert [c["service"] for c in d["containers"]] == [
        "rocketchat-rocketchat-1", "rocketchat-mongodb-0"]
    assert "ImagePullBackOff" in d["containers"][1]["status"]
    # microservices, because that is what this runtime DEFAULTS to and the record
    # names no deployment -- see topology.DEPLOYMENTS.
    assert d["runtime"] == "kubernetes" and d["deployment"] == "microservices"
    assert d["namespace"] == "houston-k"
    assert d["uptime"], "an uptime, from the earliest running pod"


def test_detail_of_a_kubernetes_workspace_survives_docker_being_down(
        monkeypatch, tmp_path):
    """detail() asked docker first, and its docker-unavailable branch reads the
    workspace's COMPOSE FILE. A Kubernetes workspace has none, so a box whose daemon
    was merely asleep answered the panel with a FileNotFoundError -- a 500 -- for a
    workspace running perfectly well in the cluster. The runtime is asked first now.
    """
    from houston.services import k8s

    _kube_workspace(tmp_path, monkeypatch, preset="default")
    monkeypatch.setattr(lc.runner, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc, "kubernetes_state", lambda name, meta: "running")
    monkeypatch.setattr(k8s, "pod_rows", lambda name, **kw: [])

    d = lc.detail("k")          # must not raise
    assert d["state"] == "running", "docker's absence says nothing about a cluster"
    assert d["links"], "and the links are still there"


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
    monkeypatch.setattr(lc.runner, "docker_available", lambda **_k: False)

    assert lc.detail("old")["bind_host"] == "0.0.0.0"


def test_a_load_test_refuses_a_kubernetes_workspace_instead_of_crashing(
        monkeypatch, tmp_path):
    """Both perf entry points read the compose file, so on Kubernetes they raised a
    bare FileNotFoundError: outside the ReproError contract, so `serve` answered 500
    and the CLI printed a traceback. And the refusal is not "unimplemented" -- the
    numbers would be measuring the `kubectl port-forward`.
    """
    from houston.services import perf

    _kube_workspace(tmp_path, monkeypatch, preset="default")
    monkeypatch.setattr(perf.lifecycle.runner, "docker_available", lambda **_k: True)
    with pytest.raises(errors.ValidationError) as caught:
        perf.run_loadtest(perf.LoadtestReq(name="k", scenario="messages", vus=1))
    assert "port-forward" in str(caught.value)
    with pytest.raises(errors.ValidationError):
        perf.run_capacity(perf.CapacityReq(name="k", scenario="messages"))


def test_pod_rows_names_the_reason_a_pod_cannot_start(monkeypatch):
    """The status column's job. A pod stuck on a bad image reports phase `Pending`,
    which says only that something has not happened; the waiting REASON says what.

    An init container is where a Kubernetes workspace most often wedges -- MongoDB
    ships two -- and a pod whose init container is failing has an EMPTY
    containerStatuses, so reading only that list showed "0/0 ready" and named nothing.
    """
    import json as _json

    from houston.services import k8s

    pods = {"items": [
        {"metadata": {"name": "rocketchat-mongodb-0"},
         "status": {"phase": "Pending",
                    "initContainerStatuses": [
                        {"ready": False, "restartCount": 3,
                         "state": {"waiting": {"reason": "CrashLoopBackOff"}}}],
                    "containerStatuses": []}},
        {"metadata": {"name": "rocketchat-rocketchat-x"},
         "status": {"phase": "Running", "startTime": "2026-08-18T10:00:00Z",
                    "initContainerStatuses": [
                        {"ready": True, "restartCount": 0,
                         "state": {"terminated": {"reason": "Completed"}}}],
                    "containerStatuses": [{"ready": True, "restartCount": 0,
                                           "state": {"running": {}}}]}}]}
    monkeypatch.setattr(k8s, "run", lambda *a, **kw: type(
        "R", (), {"returncode": 0, "stdout": _json.dumps(pods), "stderr": ""})())
    rows = {r["service"]: r for r in k8s.pod_rows("k", context="c")}
    assert rows["rocketchat-mongodb-0"]["status"].startswith("CrashLoopBackOff")
    assert "3 restarts" in rows["rocketchat-mongodb-0"]["status"]
    # A SUCCESSFUL init container is not a reason: reporting "Completed" as the pod's
    # status would hide a Rocket.Chat container that was crash-looping behind it.
    assert rows["rocketchat-rocketchat-x"]["status"] == "1/1 ready"
    assert rows["rocketchat-rocketchat-x"]["health"] == "healthy"


def test_pod_rows_answers_empty_rather_than_raising_when_the_cluster_is_asleep():
    """detail() is on the path of every panel open, so this may never raise: a
    workspace whose cluster is unreachable still has to render."""
    from houston.services import k8s

    import unittest.mock as mock
    with mock.patch.object(k8s, "run", return_value=type(
            "R", (), {"returncode": 1, "stdout": "", "stderr": "connection refused"})()):
        assert k8s.pod_rows("k", context="c") == []


def test_a_release_has_a_state_and_a_wedged_one_is_freed(monkeypatch):
    """`helm list -q` lists a `pending-install` release exactly as it lists a healthy
    one -- from helm's own --help: "By default, it lists all releases in any status."

    So `release_installed` said True for a release a killed `helm install` had left
    locked, `up` went on to `helm upgrade --install`, and helm refused with "another
    operation (install/upgrade/rollback) is in progress" -- whose central claim is
    false: nothing is in progress, the process that was doing it is gone. Every later
    attempt failed identically and houston offered no way out.

    The remedy depends on whether there is anything to go back TO, which is why "just
    run helm rollback" is not the whole answer: a pending-install at revision 1 never
    completed once, so a rollback has no target.
    """
    from houston.services import k8s

    # A state, not a presence.
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: _completed(
        0, out=_helm_list("rocketchat", status="pending-install", revision=1)))
    assert k8s.release_state("rocketchat", "ns", "c") == ("pending-install", 1)

    calls: list = []

    def spy(argv, **kw):
        calls.append(" ".join(argv))
        if "helm list" in " ".join(argv):
            return _completed(0, out=_helm_list("rocketchat",
                                                status="pending-install", revision=1))
        return _completed(0)

    monkeypatch.setattr(k8s, "run", spy)
    said: list = []
    assert k8s.clear_pending_release("rocketchat", "ns", "c",
                                     emit=said.append) == "uninstalled"
    assert any("helm uninstall rocketchat" in c for c in calls), calls
    assert not any("helm rollback" in c for c in calls), \
        "revision 1 never completed, so there is nothing to roll back to"

    # With a good revision behind it, rolling back is the right move.
    calls.clear()

    def spy2(argv, **kw):
        calls.append(" ".join(argv))
        if "helm list" in " ".join(argv):
            return _completed(0, out=_helm_list("rocketchat",
                                                status="pending-upgrade", revision=4))
        return _completed(0)

    monkeypatch.setattr(k8s, "run", spy2)
    assert "rolled back" in k8s.clear_pending_release("rocketchat", "ns", "c")
    assert any("helm rollback rocketchat 3" in c for c in calls), calls

    # A healthy release is left entirely alone.
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: _completed(
        0, out=_helm_list("rocketchat", status="deployed", revision=2)))
    assert k8s.clear_pending_release("rocketchat", "ns", "c") == ""


def test_the_upgrade_re_supplies_the_values_file_like_the_official_guide(monkeypatch):
    """The guide says: change the image tag in your values.yaml and run `helm
    upgrade`. This did `--reuse-values` instead, and two things broke.

    `--reuse-values` never applies the NEW chart's defaults (helm: "reuse the last
    release's values and merge in any overrides"), so a chart that ADDS a templated
    value renders against a map without it -- RC 7.4.0 -> 7.10.15 crosses chart
    6.23.2 -> 6.26.0, which added `podMonitor`, and it died on `nil pointer
    evaluating interface {}.enabled`.

    Worse, it carries per-chart-version workarounds. `containerSecurityContext:
    {fsGroup: null}` is REQUIRED on chart 6.26.0 and BREAKS chart 7.0.0, which fixed
    the problem upstream -- so carrying it across that upgrade reintroduces the bug
    it exists to fix. `--reset-then-reuse-values` does not save this either: it still
    re-applies the last release's values over the new defaults. Only re-supplying a
    values file, with that key recomputed against the TARGET chart, is correct.
    """
    from houston.services import k8s

    seen: list = []
    sent: list = []

    def fake(argv, **kw):
        seen.append(argv)
        sent.append(kw.get("input") or "")
        return _completed(0)

    monkeypatch.setattr(k8s.subprocess, "run", fake)
    # STUBBED AT THE `run` SEAM, not at `release_values`, deliberately: a test that
    # monkeypatches the new function fails against the old code with AttributeError,
    # which proves a rename rather than a defect. Answering `helm get values` here
    # means the assertions below run against either version and fail on BEHAVIOUR.
    release = {"containerSecurityContext": {"fsGroup": None},
               "externalMongodbUrl": "mongodb://keep-me",
               "microservices": {"enabled": True},
               "externalMongodbOplogUrl": "mongodb://local",
               "image": {"repository": "old", "tag": "7.4.0"}}
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: _completed(
        0, out=json.dumps(release) if "get" in argv else ""))
    # The TARGET chart has no `fsGroup` on the container, so nothing should be sent.
    monkeypatch.setattr(k8s, "container_security_context", lambda cv: {})

    k8s.upgrade_image(namespace="ns", context="c", chart_version="7.0.0",
                      image_repo="r", tag="8.0.0", oplog=False)

    argv = seen[-1]
    assert argv[:2] == ["helm", "upgrade"]
    assert "--values" in argv and "-" in argv, argv
    assert not any("reuse-values" in a for a in argv), \
        "a reuse flag is back; the guide supplies the whole file"
    assert not any(a == "--set" for a in argv), \
        "the tag goes in the values file, the way the guide changes it"

    body = json.loads(sent[-1])
    assert body["image"] == {"repository": "r", "tag": "8.0.0"}
    assert body["externalMongodbUrl"] == "mongodb://keep-me", \
        "create-time decisions must survive the upgrade"
    assert body["microservices"] == {"enabled": True}
    assert "containerSecurityContext" not in body, \
        "a workaround for the OLD chart was carried onto the new one"
    assert "externalMongodbOplogUrl" not in body, \
        "RC 8 dropped oplog tailing; the key is removed, not carried"

    # And where the target chart DOES need it, it is present -- recomputed, not reused.
    monkeypatch.setattr(k8s, "container_security_context",
                        lambda cv: {"containerSecurityContext": {"fsGroup": None}})
    k8s.upgrade_image(namespace="ns", context="c", chart_version="6.26.0",
                      image_repo="r", tag="7.10.15", oplog=False)
    assert json.loads(sent[-1])["containerSecurityContext"] == {"fsGroup": None}


def test_a_release_with_no_values_of_its_own_is_not_a_failure(monkeypatch):
    """`helm get values` answers the literal string `null` for a release installed
    with no values. That is an empty values file, not an error, and reading it as one
    would refuse every upgrade of such a release."""
    from houston.services import k8s

    monkeypatch.setattr(k8s, "run", lambda argv, **kw: _completed(0, out="null"))
    assert k8s.release_values("rocketchat", "ns", "c") == {}

    # A refused read is still refused: not knowing the values is not the same as
    # there being none, and upgrading on {} would erase the release's whole config.
    from houston.errors import DockerError
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: _completed(
        1, err="Error: release: not found"))
    with pytest.raises(DockerError):
        k8s.release_values("rocketchat", "ns", "c")


def test_the_flag_that_undoes_a_failed_install_is_named_for_the_helm_installed():
    """**`--atomic` does not exist in helm 4** -- it is `--rollback-on-failure`.

    So the standard advice for a wedged release would itself fail on a box running
    helm 4, and an unrecognised flag turns a working install into a broken one.
    Verified against the 4.2.3 on this machine: `helm upgrade --help` lists
    `--rollback-on-failure` and no `--atomic`.
    """
    from houston.services import k8s

    class _T:
        present, version = True, ()

    def at(ver):
        t = _T(); t.version = ver; return t

    import unittest.mock as m
    with m.patch.object(k8s, "tool", lambda n: at((4, 2, 3))):
        assert k8s.helm_rollback_on_failure() == ["--rollback-on-failure"]
    with m.patch.object(k8s, "tool", lambda n: at((3, 14, 0))):
        assert k8s.helm_rollback_on_failure() == ["--atomic"]
    with m.patch.object(k8s, "tool", lambda n: at(())):
        assert k8s.helm_rollback_on_failure() == [], \
            "an unknown helm gets no flag rather than a guessed one"


def test_a_multi_line_helm_error_keeps_its_reason(monkeypatch):
    """`why()` took the last line announcing itself as an error, and a Helm TEMPLATE
    error puts the location on that line and the cause on the indented lines after it.

    So the file and line survived and `nil pointer` did not -- which is what made the
    chart-version upgrade failure unreadable from houston's own output. The
    docstring's premise, diagnostics first and error last, holds for klog and inverts
    here.
    """
    from houston.services import k8s

    helm = ("Error: UPGRADE FAILED: template: rocketchat/templates/podmonitor.yaml:24:18\n"
            '  executing "podmonitor.yaml" at <.Values.podMonitor.enabled>:\n'
            "    nil pointer evaluating interface {}.enabled\n")
    got = k8s.why(_completed(1, err=helm))
    assert "nil pointer" in got, got
    assert "podmonitor.yaml:24:18" in got, "the location is still useful"

    # The klog case must be untouched: a warning is not an error however loudly printed.
    klog = ("W0824 12:00:00.1 warnings.go:70] v1 Endpoints is deprecated\n"
            "Error: release: not found\n")
    assert k8s.why(_completed(1, err=klog)) == "Error: release: not found"


class _FakeProc:
    """A `Popen` double that can answer `poll()`, because the code now asks.

    `port_forward` used to return `proc.pid` the instant it spawned, so a stub with
    nothing but a `pid` was enough. It now confirms the child actually got the socket
    -- kubectl exits within milliseconds when the port is taken, and returning that
    pid recorded a dead process while a squatter served the URL. A double without
    `poll()` cannot express either outcome.
    """

    def __init__(self, pid: int, exited: int | None = None):
        self.pid = pid
        self._exited = exited

    def poll(self):
        return self._exited


def _helm_list(*names: str, status: str = "deployed", revision: int = 1) -> str:
    """What `helm list -o json` really returns, for a stub that must not lie.

    The stubs here answered with the bare release name, which is the `-q` shape.
    `release_state` asks for `-o json` because a release has a STATUS and `-q` throws
    it away -- a `pending-install` release is listed by `-q` identically to a healthy
    one, which is how a wedged release read as a working one. A stub that keeps
    answering in the old shape would make the fix look broken here and leave it
    broken in production, which is this repo's payload-shape trap in a new place.
    """
    return json.dumps([{"name": nm, "namespace": "ns", "revision": revision,
                        "updated": "2026-08-24 00:00:00", "status": status,
                        "chart": "c-1.0.0", "app_version": "1.0.0"}
                       for nm in names if nm])


# --- the agent skill ------------------------------------------------------------

def test_the_repo_copies_of_the_skill_match_the_packaged_one():
    """Three copies of one file, and the two under `.claude/` and `.agents/` exist so
    a fresh clone teaches an agent to drive this tool. Three copies is also how they
    drift, so this is the thing that stops them.

    It is a real check rather than a formality: the packaged copy is what
    `houston skill install` writes on a machine that has no checkout, so a repo
    copy that says something different is instructions half the callers never see.
    """
    from pathlib import Path

    from houston.services import skill

    root = Path(skill.packaged()).resolve().parents[3]
    want = skill.packaged().read_text(encoding="utf-8")
    for rel in (".claude/skills/houston/SKILL.md", ".agents/skills/houston/SKILL.md"):
        copy = root / rel
        assert copy.exists(), f"{rel} is missing — `cp {skill.packaged()} {rel}`"
        assert copy.read_text(encoding="utf-8") == want, (
            f"{rel} has drifted from the packaged skill — copy it again")


def test_the_skill_states_only_numbers_the_build_still_confirms():
    """The skill said `standard` seeds 283 messages. The plan builds 287.

    Nothing caught it because a number in prose has no reader. `capabilities`
    publishes the profile NAMES and not their shapes, so this file was the only
    statement of the counts anywhere -- and it was wrong, in the one document a
    caller is told to trust before it has run anything. The registry walks
    elsewhere in this suite exist for exactly this shape of defect; the three
    claims below are the ones in the skill that a build change can falsify, so
    they get the same treatment as `ROUTE_ROLES` and `PHASES`.
    """
    import re

    from houston import errors, presets, seed
    from houston.services import skill

    text = skill.packaged().read_text(encoding="utf-8")

    # 1. The seed shape, as a sentence the file actually contains.
    m = re.search(r"`standard` is (\d+) rooms, (\d+) messages, (\d+) threads "
                  r"across (\d+) users", text)
    assert m, "the skill no longer states the `standard` profile's shape"
    plan = seed.plan_from("standard")
    assert [int(g) for g in m.groups()] == [len(plan.rooms), plan.total_messages,
                                           plan.total_replies, plan.users], (
        "the skill's `standard` numbers no longer match what seed.plan_from builds")

    # 2. The preset catalogue, both directions. A name the file invents is a caller
    #    sent to a refusal; a preset nobody documented is a feature with no door.
    #    `multi-instance` is the deliberate exception -- it is the deployment axis
    #    under its old name, and the file explains it as that rather than listing it.
    sentence = text.split("`capabilities.presets` lists what this build has:")[1]
    listed = set(re.findall(r"`([a-z0-9_-]+)`", sentence.split(".")[0]))
    catalog = {pre.name for pre in presets.list_presets()}
    assert listed <= catalog, f"the skill names presets that do not exist: {listed - catalog}"
    assert catalog - listed == {"multi-instance"}, (
        f"undocumented preset(s): {catalog - listed - {'multi-instance'}}")
    assert "--preset multi-instance" in text

    # 3. The exit-code table callers are told to branch on. `6` is in EXIT_CODES and
    #    nothing raises it, so the file names it as reserved instead of as a rule.
    bullets = {int(d) for d in re.findall(r"^   - `(\d)` ", text, re.M)}
    assert bullets == set(errors.EXIT_CODES) - {0, 6}, (
        f"the skill's exit-code table and errors.EXIT_CODES disagree: "
        f"{bullets ^ (set(errors.EXIT_CODES) - {0, 6})}")
    assert "`6` (gate)" in text

    # 4. The sample envelope carries a real version, in the one file whose closing
    #    section is about telling a caller whether it is current. Pinning it here is
    #    what lets it stay a real value instead of drifting into a fossil -- it was
    #    four minor versions behind when this walk was written.
    from houston import __version__
    assert f'"houston_version":"{__version__}"' in text, (
        "the skill's sample envelope names a version this build is not")


def test_the_skill_knows_stale_from_edited_locally(tmp_path, monkeypatch):
    """Two ways an installed file can differ, needing opposite answers: the package
    moved on (reinstall it) or a human edited it (that is theirs). The sidecar's
    recorded sha is what separates them -- without it, an edit and a new release look
    identical and one of the two gets clobbered."""
    from houston.services import skill

    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path))
    assert skill.host_state("claude").status == "absent"

    skill.install("claude")
    assert skill.host_state("claude").status == "current"
    assert skill.install("claude")["hosts"][0]["action"] == "unchanged"

    path = skill.target("claude")
    path.write_text("a human changed this\n", encoding="utf-8")
    assert skill.host_state("claude").status == "modified"
    with pytest.raises(errors.ConflictError):
        skill.install("claude")
    assert path.read_text(encoding="utf-8") == "a human changed this\n", \
        "a refusal that had already overwritten the file would be worse than none"
    skill.install("claude", force=True)
    assert skill.host_state("claude").status == "current"

    # A copy this build wrote, from an older build: stale, and overwritten freely.
    path.write_text("what 0.1.0 shipped\n", encoding="utf-8")
    (path.parent / skill.SIDECAR).write_text(json.dumps(
        {"houston_version": "0.1.0", "sha256": skill.sha256("what 0.1.0 shipped\n")}),
        encoding="utf-8")
    assert skill.host_state("claude").status == "stale"
    assert skill.install("claude")["hosts"][0]["action"] == "updated"


def test_the_skill_never_writes_into_the_houston_state_directory(tmp_path, monkeypatch):
    """It is read by an agent that knows nothing about HOUSTON_HOME, so it goes
    where that agent looks -- and a test that got this wrong would write into the
    developer's real ~/.claude."""
    from houston.services import skill

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path / "home"))
    skill.install("all")
    assert (tmp_path / "home" / ".claude" / "skills" / "houston" / "SKILL.md").exists()
    assert not (tmp_path / "state").exists()


# --- the engine floor -----------------------------------------------------------

def test_a_kubernetes_create_is_refused_when_the_ENGINE_is_too_small(monkeypatch):
    """The host and the container engine are different machines on macOS and on
    Podman, and the capacity check only ever asked the host. A laptop with 32 GB and
    a 4 GB VM passed everything and then could not run a Kubernetes workspace -- the
    failure arriving minutes later as pods stuck Pending, which names nothing."""
    from houston.services import k8s
    monkeypatch.setattr(k8s, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context=k8s.CONTEXT, distribution="kind", create=True))
    monkeypatch.setattr(lc.runner, "docker_capacity", lambda: (2.0, 3 * 1024 ** 3))
    with pytest.raises(errors.PreflightError) as caught:
        lc.check_capacity(lc.CreateReq(version="8.5.1", runtime="kubernetes"))
    said = str(caught.value)
    assert "2 CPUs" in said and "3.0 GiB" in said
    assert "podman machine set" in said, "a refusal has to say how to fix it"

    # Compose runs two containers and works on that VM: a floor there would refuse
    # creates that succeed today.
    monkeypatch.setattr(lc.runner, "host_memory", lambda: (16000, 12000, 0))
    lc.check_capacity(lc.CreateReq(version="8.5.1"))


def test_an_unreadable_engine_is_not_evidence_of_a_small_one(monkeypatch):
    """A refusal on no evidence is how people learn to pass --force by reflex."""
    monkeypatch.setattr(lc.runner, "docker_capacity", lambda: None)
    monkeypatch.setattr(lc.runner, "host_memory", lambda: (16000, 12000, 0))
    lc.check_capacity(lc.CreateReq(version="8.5.1", runtime="kubernetes"))


def test_force_downgrades_the_engine_floor_to_a_warning(monkeypatch):
    events = []
    from houston.services import k8s
    monkeypatch.setattr(k8s, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context=k8s.CONTEXT, distribution="kind", create=True))
    monkeypatch.setattr(lc.runner, "docker_capacity", lambda: (1.0, 1 * 1024 ** 3))
    monkeypatch.setattr(lc.runner, "host_memory", lambda: (16000, 12000, 0))
    lc.check_capacity(lc.CreateReq(version="8.5.1", runtime="kubernetes", force=True),
                      emit=events.append)
    assert any("below the Kubernetes floor" in e.message for e in events)


def test_the_skill_reports_the_copy_an_agent_actually_reads(tmp_path, monkeypatch):
    """An agent reads `.claude/skills/` relative to the PROJECT before it reads a
    home directory, so in a checkout that is the file in play. Reporting only the
    home copy told a developer `current: false` while they were reading a perfectly
    current skill -- and then pointed them at `skill install`, which writes a
    different copy somewhere the agent was not reading.

    Found by driving the skill and watching `capabilities` say exactly that.
    """
    from houston.services import skill

    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path / "home"))
    project = tmp_path / "checkout"
    (project / ".claude" / "skills" / "houston").mkdir(parents=True)
    local = project / ".claude" / "skills" / "houston" / "SKILL.md"
    local.write_text(skill.packaged().read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.chdir(project)

    st = skill.state()
    assert st["hosts"]["project"]["status"] == "current"
    assert st["hosts"]["project"]["scope"] == "project"
    # Nothing is installed in the home, and that does NOT make the state stale:
    # absent copies are not copies somebody read.
    assert st["hosts"]["claude"]["status"] == "absent"
    assert st["current"] is True

    # A checkout carrying an out-of-date copy is worth reporting even though the
    # home copy might be fine, because nobody knows which one the caller loaded.
    local.write_text("what an older branch shipped\n", encoding="utf-8")
    assert skill.state()["current"] is False


def test_no_copy_anywhere_is_not_current(tmp_path, monkeypatch):
    from houston.services import skill

    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path / "home"))
    empty = tmp_path / "elsewhere"
    empty.mkdir()
    monkeypatch.chdir(empty)
    st = skill.state()
    assert st["current"] is False, "nothing installed is not the same as up to date"


def test_the_flat_notes_are_derived_from_the_groups_not_maintained_beside_them():
    """A workspace's notes now exist in two renderings -- grouped cards in the GUI,
    a flat list of lines in the terminal and in every record written before groups
    existed. Two hand-written copies is how the two come to disagree, so the groups
    are the source and the flat list is computed from them.

    What the flattening has to preserve is the notes pattern the panel already
    parses: an INDENTED line is a copyable box, a line naming a place is a link row,
    anything else is prose. So a group's rows come out as an aligned indented block
    (a table where it is read as text), its commands come out indented (a code box),
    and its prose comes out flush (prose).
    """
    g = lc.note_group("Kubernetes", rows=[("Cluster", "kind-x"), ("Namespace", "rc-y")])
    assert g == {"title": "Kubernetes", "kind": "", "body": [], "commands": [],
                 "rows": [["Cluster", "kind-x"], ["Namespace", "rc-y"]]}

    lines = lc.flatten_notes([
        g,
        lc.note_group("Port forward", body=["It dies with the pod. Start it again:"],
                      commands=["kubectl -n rc-y port-forward deployment/rc 3001:3000"]),
    ])
    assert lines == [
        "Kubernetes:",
        "    Cluster    kind-x",      # padded to the widest key, so the column lines up
        "    Namespace  rc-y",
        "Port forward:",
        "It dies with the pod. Start it again:",
        "    kubectl -n rc-y port-forward deployment/rc 3001:3000",
    ], lines
    # The two shapes that matter to the parser, stated as such: indentation is what
    # makes a line copyable, and prose must not be indented or it becomes a command.
    assert lines[1].startswith("    ") and lines[-1].startswith("    ")
    assert not lines[4].startswith(" ")


def test_an_empty_group_contributes_no_stray_heading():
    """A group is built unconditionally and filled conditionally -- the operator note
    only exists on one MongoDB path -- so an empty one must vanish rather than leave a
    bare `Monitoring:` above nothing."""
    assert lc.flatten_notes([lc.note_group("Monitoring")]) == ["Monitoring:"]
    assert lc.flatten_notes([]) == []
    assert lc.flatten_notes([lc.note_group("", body=["a bare line"])]) == ["a bare line"]


def _k8s_meta(**extra):
    """A Kubernetes workspace record, as `repro.json` holds one."""
    base = {"runtime": "kubernetes", "deployment": "microservices",
            "namespace": "houston-old", "context": "kind-houston-local",
            "release": "rocketchat", "bind_host": "127.0.0.1",
            "mongo_managed_by": "statefulset", "mongo_image": "mongo:8.0"}
    base.update(extra)
    return lc.runner.Metadata(
        name="old", project="houston-old", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        extra=base)


#: Functions in `services/k8s.py` allowed to answer a FAILED call with an empty or
#: falsey value. Each one is a decision, not an oversight, and the reason is here so
#: the next reader does not have to re-derive it:
#:
#:   workspace_ready       False means "not ready yet", so the caller keeps waiting.
#:   terminal_pod_failure  None means "no terminal failure found", so it keeps waiting.
#:   pod_rows              display only; nothing branches on it.
#:   workspace_pvcs        one caller, and only to say how many volumes will go.
#:   container_security_context  {} means "no override", the conservative default,
#:                         and a chart nobody can read fails the install anyway.
#:
#: A function whose return type ALREADY admits `None` is exempt without being listed:
#: `-> list[str] | None` is how this module says "and I might not be able to ask", so
#: `return None` there is the third answer rather than a missing one.
_FALSEY_ON_FAILURE_ALLOWED = frozenset({
    "workspace_ready", "pod_rows", "workspace_pvcs", "container_security_context",
    # `_pods_waiting` returns a PROGRESS LINE, not a finding. "" means "say nothing
    # this tick" and the only caller skips the emit on it -- nothing reads it as a
    # claim that the namespace holds no pods, and no decision is taken on it. It runs
    # beside an install that is going perfectly well, so the alternative -- carrying a
    # third answer up into a log line -- would put "I could not ask about the pods" on
    # screen during a create that is fine.
    "_pods_waiting",
})


def test_no_kubectl_read_answers_a_failed_call_with_an_empty_one():
    """The fourth registry walk, and the one this release kept needing.

    `if res.returncode != 0: return []` is indistinguishable from "the cluster holds
    none of these", and every instance of it has cost something: `workspace_namespaces`
    uninstalled the SHARED monitoring stack and MongoDB operator out from under other
    workspaces and made a failed create delete a namespace `down` had kept -- PVC and
    all -- while `list` reported a healthy workspace as `down`. `storage_classes`,
    `ingress_classes` and `nodes_summary` told somebody with a working cluster they
    had no storage, no ingress and no nodes.

    Those were found one at a time, by hand, over four releases. The registries that
    have a walk behind them -- ROUTE_ROLES against app.routes, and the PHASES source
    walk -- have never drifted; this is the same idea for the shape rather than for a
    table. A new read that reaches for `return []` on failure now has to either carry
    the third answer or say in `_FALSEY_ON_FAILURE_ALLOWED` why it does not.
    """
    import ast

    from houston.services import k8s

    tree = ast.parse(source_of(k8s))
    offenders = []
    for fn in [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]:
        if fn.name in _FALSEY_ON_FAILURE_ALLOWED:
            continue
        # A signature that admits None is declaring the third answer, so returning it
        # is the fix rather than the defect. This is what makes the walk teach the
        # pattern instead of just forbidding a token.
        annotation = ast.unparse(fn.returns) if fn.returns is not None else ""
        if "None" in annotation:
            continue
        for node in ast.walk(fn):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if not (isinstance(test, ast.Compare)
                    and isinstance(test.left, ast.Attribute)
                    and test.left.attr == "returncode"
                    and isinstance(test.ops[0], ast.NotEq)):
                continue
            body = [st for st in node.body if not isinstance(st, ast.Pass)]
            if len(body) != 1 or not isinstance(body[0], ast.Return):
                continue
            val = body[0].value
            empty_literal = (
                val is None
                or (isinstance(val, ast.Constant) and not val.value)
                or (isinstance(val, (ast.List, ast.Dict, ast.Tuple, ast.Set))
                    and not getattr(val, "elts", None)
                    and not getattr(val, "keys", None)))
            if empty_literal:
                offenders.append(f"{fn.name} (line {node.lineno}) -> "
                                 f"{ast.unparse(val) if val is not None else 'None'}")
    assert not offenders, (
        "these read a failed call as a negative answer; carry the third answer or "
        "add the function to _FALSEY_ON_FAILURE_ALLOWED with the reason:\n  "
        + "\n  ".join(offenders))


def test_the_shared_teardown_chain_cannot_answer_from_ignorance(monkeypatch):
    """Removing a SHARED resource is decided by a chain of reads, and every link has
    to be able to say "I could not tell".

    `remove_monitoring` asks which namespaces exist, then asks each one whether it
    still wants monitoring. Fixing the first read and not the second changes nothing:
    the outer list comes back correct, the inner question answers "no" for a namespace
    whose label nobody could read, the count comes back empty, and the shared stack is
    uninstalled out from under a workspace that is using it. Same defect, one level
    down, and the walk over `returncode` did not see it because the shape was
    `return <expr> == "true"`.

    So this pins the CHAIN rather than a function: three reads that must admit None,
    and two callers that must refuse when they get it.
    """
    import typing

    from houston.services import k8s

    for fn in (k8s.workspace_namespaces, k8s.mongodb_resources, k8s.monitoring_wanted):
        ann = typing.get_type_hints(fn).get("return")
        assert "None" in str(ann), (
            f"{fn.__name__} feeds a shared-teardown decision and cannot say "
            f"'I could not tell' (returns {ann})")

    # And the two callers act on it. Asserted on behaviour, not on the source.
    monkeypatch.setattr(k8s, "release_installed", lambda *a, **kw: True)
    monkeypatch.setattr(k8s, "operator_installed", lambda *a, **kw: True)
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx=None: ["houston-other"])
    monkeypatch.setattr(k8s, "mongodb_resources", lambda ctx: None)
    said: list = []
    assert k8s.remove_operator(context="c", emit=lambda e: said.append(e.message)) is False
    assert any("could not be listed" in m for m in said), said

    # The inner question specifically: the list is fine, the label is not.
    said.clear()
    monkeypatch.setattr(k8s, "monitoring_wanted", lambda ns, **kw: None)
    assert k8s.remove_monitoring(context="c",
                                 emit=lambda e: said.append(e.message)) is False
    assert any("could not read whether" in m for m in said), said

    # A real "no" still means no, or the shared stack could never be reclaimed.
    said.clear()
    monkeypatch.setattr(k8s, "monitoring_wanted", lambda ns, **kw: False)
    monkeypatch.setattr(k8s, "run", lambda a, **kw: _completed(0))
    monkeypatch.setattr(k8s, "clear_grafana_finalizers", lambda ctx: 0)
    assert k8s.remove_monitoring(context="c",
                                 emit=lambda e: said.append(e.message)) is True

    # One name for the label, in one place: it was a literal at the setter and a
    # literal in the reference count, which is two chances to disagree about the
    # thing that decides whether the shared stack is uninstalled.
    assert "houston.io/monitoring" not in source_of(k8s.set_monitoring_label)
    assert k8s.MONITORING_LABEL == "houston.io/monitoring"


def test_a_cluster_that_cannot_be_listed_is_not_a_cluster_with_nothing_in_it(monkeypatch):
    """`workspace_namespaces` answered `[]` for a refused read, and three callers act
    on `[]` destructively.

    The realistic identity is a support engineer on a customer cluster with
    namespace-scoped RBAC -- no cluster-scoped verbs at all, so `get namespace` is
    Forbidden. An 8-second PROBE_TIMEOUT under load and a rolling control-plane
    restart produce the same answer.
    """
    from houston.services import k8s

    denied = _completed(1, err='Error from server (Forbidden): namespaces is '
                               'forbidden: User "system:serviceaccount:x:limited" '
                               'cannot list resource "namespaces" at the cluster scope')
    monkeypatch.setattr(k8s, "run", lambda a, **kw: denied)
    assert k8s.workspace_namespaces("limited") is None, \
        "a forbidden list read as an empty cluster"
    assert k8s.mongodb_resources("limited") is None

    # THE SHARED STACKS MUST BE LEFT ALONE. Both are reference-counted on a list that
    # could not be read, and both are used by other workspaces.
    said: list = []
    monkeypatch.setattr(k8s, "release_installed", lambda *a, **kw: True)
    assert k8s.remove_monitoring(context="limited",
                                 emit=lambda e: said.append(e.message)) is False
    assert any("could not be read" in m for m in said), said
    said.clear()
    monkeypatch.setattr(k8s, "operator_installed", lambda *a, **kw: True)
    assert k8s.remove_operator(context="limited",
                               emit=lambda e: said.append(e.message)) is False
    assert any("could not be listed" in m for m in said), said

    # AND A FAILED CREATE MUST NOT DELETE DATA IT COULD NOT PROVE WAS ITS OWN. This
    # is the data-loss one: `had_namespace` False sends the rollback into "removing
    # namespace", and the PVC goes with it after `down` promised it would be there.
    src = source_of(k8s.create_workspace)
    assert "_held is None or namespace_for(name) in _held" in src, \
        "a refused read must count as 'the namespace was already there'"

    # And a cluster whose contents are unknown is not an empty cluster to reclaim.
    from houston.errors import ConflictError
    monkeypatch.setattr(k8s, "which", lambda n: "/usr/bin/kind")
    monkeypatch.setattr(k8s, "clusters", lambda: ([k8s.CLUSTER_NAME], False))
    monkeypatch.setattr(k8s, "cluster_context", lambda: k8s.CONTEXT)
    monkeypatch.setattr(k8s, "reachable", lambda c: True)
    with pytest.raises(ConflictError) as caught:
        k8s.delete_cluster()
    assert "could not be read" in str(caught.value), caught.value


def test_a_kubernetes_workspace_is_not_down_just_because_nobody_could_ask(monkeypatch, tmp_path):
    """`list` reported a healthy Kubernetes workspace as `down` whenever the cluster
    could not be asked -- measured at 8.3s, one PROBE_TIMEOUT, with the control plane
    paused, while the workspace was serving throughout.

    `down` is the word that invites `up --force` and `down --volumes`, so it is the
    worst of the available guesses. The Docker branch in the same function has said
    `?` for an unreachable daemon all along, and the browser already renders it.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT

    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx=None: None)
    assert lc.kubernetes_state("k", m) == "?", "an unaskable cluster is not a down one"

    # A real empty answer still means down.
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx=None: [])
    assert lc.kubernetes_state("k", m) == "down"


def test_a_forward_is_confirmed_by_owning_the_socket_not_by_the_port_answering():
    """`forward_bound` asked whether the PORT answered, and lost that race 3 times
    out of 3 against a squatter -- in a tenth of a millisecond.

    `poll()` is None for a few hundred milliseconds after `Popen` while kubectl loads
    its kubeconfig and talks to the API server, and the squatter answers its socket
    instantly. So the function returned True, the dead pid was recorded after all,
    and the targeted warning it exists to produce never fired in the one scenario its
    docstring describes.

    Real sockets and a real child here, because the defect IS the timing: a stub
    would answer whatever it was told and prove nothing. Ownership has no window --
    either our pid holds a listening socket on that port or it does not.
    """
    import socket
    import subprocess

    from houston.services import k8s

    squatter = socket.socket()
    squatter.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    squatter.bind(("127.0.0.1", 0))
    port = squatter.getsockname()[1]
    squatter.listen(5)
    try:
        # A child that exits at once, standing in for a kubectl that cannot bind.
        doomed = subprocess.Popen(["sh", "-c", "exit 1"])
        assert k8s.forward_bound(doomed, port, tries=3, interval=0.1) is False, \
            "the squatter's socket was accepted as our child's"
        # And the ownership question itself, both ways.
        assert k8s.pid_owns_port(doomed.pid, port) is False
        import os
        assert k8s.pid_owns_port(os.getpid(), port) is True, \
            "this process really does hold that socket"
    finally:
        squatter.close()


def test_a_pending_shared_release_is_not_mistaken_for_a_working_one(monkeypatch):
    """`monitoring_installed` read the RETURN CODE of `helm status`, which is 0 for a
    release in any state -- including one a killed install left in `pending-install`.

    So it answered True for a namespace holding no Prometheus and no Grafana,
    `ensure_monitoring` took its early return, skipped both the install and
    `wait_for_grafana`, and `monitor` reported the stack attached while the
    dashboards did not exist. The same collapse `release_state` was written for, in
    the one function that was not migrated with the others.
    """
    from houston.services import k8s

    def listing(status):
        return _helm_list(k8s.MONITORING_RELEASE, status=status)

    for status, want in (("deployed", True), ("pending-install", False),
                         ("pending-upgrade", False), ("failed", False)):
        monkeypatch.setattr(k8s, "run", lambda a, _s=status, **kw: _completed(
            0, out=listing(_s)))
        assert k8s.monitoring_installed("c") is want, status

    # Absent is absent; a refused list is not "installed" either, because the caller's
    # next move is an idempotent `upgrade --install`.
    monkeypatch.setattr(k8s, "run", lambda a, **kw: _completed(0, out="[]"))
    assert k8s.monitoring_installed("c") is False
    monkeypatch.setattr(k8s, "run", lambda a, **kw: _completed(1, err="boom"))
    assert k8s.monitoring_installed("c") is False


def test_both_shared_releases_free_a_wedged_one_before_installing():
    """A killed `helm install` wedges the SHARED releases for every workspace on the
    cluster, and only the workspace's own release knew how to recover.

    `houston-system` holds the MongoDB operator and the monitoring stack, so one
    Ctrl-C inside their five-minute `--wait` left every later `--mongo-operator` and
    every `--monitor` failing with "another operation (install/upgrade/rollback) is
    in progress". `--rollback-on-failure` does not cover it: a killed helm is not
    there to perform the rollback.
    """

    from houston.services import k8s

    for fn in (k8s.ensure_operator, k8s.ensure_monitoring, k8s.install):
        src = source_of(fn)
        assert "clear_pending_release" in src, (
            f"{fn.__name__} cannot recover a release a killed helm left pending")


def test_doctor_is_told_which_cluster_is_not_answering(monkeypatch):
    """`preflight` dropped the reason with the exception.

    `plan_cluster` raises both for "no kind and no kubeconfig" and for "kubectl is
    pointed at 'X', which is not answering" -- and `except PreflightError: plan =
    None` left `context` empty for both. So doctor fell through to "No Kubernetes
    cluster configured, install kind or point kubectl at an existing cluster" for
    somebody whose cluster IS configured and whose credentials are what need fixing,
    sending them to configure a second one.
    """
    from houston.errors import PreflightError
    from houston.services import k8s

    monkeypatch.setattr(k8s, "plan_cluster", lambda *_a, **_k: (_ for _ in ()).throw(
        PreflightError("kubectl is pointed at 'my-prod', which is not answering")))
    monkeypatch.setattr(k8s, "active_context", lambda: "my-prod")
    monkeypatch.setattr(k8s, "reachable", lambda ctx: False)
    monkeypatch.setattr(k8s, "clusters", lambda: ([], False))

    pre = k8s.preflight()
    assert pre.context == "my-prod", \
        "the cluster kubectl names must survive, or doctor cannot say which one"
    assert pre.cluster_reachable is False
    assert pre.will_create is False

    # And where there genuinely is no cluster, it is still empty -- the message that
    # was wrong above is the right one there.
    monkeypatch.setattr(k8s, "active_context", lambda: "")
    assert k8s.preflight().context == ""


def test_a_forward_that_hid_its_arguments_is_not_called_dead(monkeypatch):
    """`forward_alive` identifies our port-forward from /proc/<pid>/cmdline -- and on
    a host where `kubectl` is a symlink to `k3s`, that command line is empty.

    k3s ships kubectl as a multi-call binary: dispatching rewrites its own argv, so
    the process shows `kubectl` and then nothing. Measured on such a host -- `ss
    -ltnp` reported that exact pid holding both :3000 sockets while this function
    returned False. Reading that as "the forward is gone" made `ensure_port_forward`
    respawn onto a port its own live forward already held, every single call, and told
    the reader the URL was not published while it was answering 200.

    An argv with nothing in it to check is "I cannot identify it this way", not a
    mismatch. Same distinction the rest of this module is built on.
    """
    from houston.services import k8s

    class _Proc:
        def __init__(self, path):
            self.path = str(path)

        def read_bytes(self):
            if self.path.endswith("/cmdline"):
                return cmdline
            raise OSError("no")

        def read_text(self, encoding=None):
            if self.path.endswith("/comm"):
                return comm
            raise OSError("no")

    monkeypatch.setattr(k8s, "Path", _Proc)
    # `pid_owns_port_exclusively`, not `forward_reachable`: the code asks whether OUR
    # child holds the socket, because "the port answers" is satisfied by a
    # squatter and lost that race 3 times out of 3.
    monkeypatch.setattr(k8s, "pid_owns_port", lambda *a, **kw: port_up)

    # The k3s shape: argv[0] and a hundred empty slots.
    cmdline, comm, port_up = b"kubectl \0" + b"\0" * 100, "kubectl", True
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is True

    # ...but only while the port it was started for is actually held. Three facts
    # together: our recorded pid, still a kubectl, and the port is up.
    port_up = False
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is False

    # A recycled pid running something else is still refused.
    cmdline, comm, port_up = b"nginx\0", "nginx", True
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is False

    # And a FULL argv is still matched strictly -- the strong path is unchanged, so a
    # different workspace's forward on a recycled pid does not pass.
    cmdline = b"\0".join([b"kubectl", b"--context", b"c", b"-n", b"houston-OTHER",
                          b"port-forward", b"deployment/x", b"3000:3000"])
    comm = "kubectl"
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is False
    cmdline = cmdline.replace(b"houston-OTHER", b"houston-k")
    assert k8s.forward_alive(4242, namespace="houston-k", host_port=3000) is True


def test_a_service_with_no_ready_pod_behind_it_is_reported(monkeypatch):
    """A Service whose selector matches nothing looked exactly like a healthy
    workspace.

    Readiness reads POD status and the port-forward targets the DEPLOYMENT, so nothing
    on either path ever traverses the Service -- the URL answers 200 from the host
    while every pod in the cluster gets nothing. That matters more than it sounds
    because the Kubernetes default deployment is microservices, where in-cluster
    Service traffic is what carries the product, so a working port-forward is weaker
    evidence than it looks.

    Reported and not gated: endpoints churn during a rollout, so a transient empty set
    is normal, and a false negative here would block a boot -- a worse failure than
    the one being found. Every doubt therefore returns "nothing to say".
    """
    from houston.services import k8s

    slices = {"items": [
        {"metadata": {"labels": {"kubernetes.io/service-name": "rocketchat-rocketchat"}},
         "endpoints": [{"conditions": {"ready": False}}]},
        {"metadata": {"labels": {"kubernetes.io/service-name": "rocketchat-ddp-streamer"}},
         "endpoints": [{"conditions": {"ready": True}}]},
    ]}
    # THE SHAPES ARE COPIED FROM A LIVE MICROSERVICES WORKSPACE, and that matters:
    # the first version of this test put `app.kubernetes.io/instance` in each
    # Service's LABELS, matching the first version of the code -- and the chart does
    # not do that. `rocketchat-ddp-streamer` carries only
    # `app.kubernetes.io/managed-by: Helm` as a label and names the instance in its
    # SELECTOR. So code and test agreed with each other and neither agreed with
    # Kubernetes, and the check was a silent no-op that this test passed. Verified by
    # dumping every Service on a real workspace.
    inst = "app.kubernetes.io/instance"
    svcs = {"items": [
        # Rocket.Chat's own, selector-backed: judged.
        {"metadata": {"name": "rocketchat-rocketchat",
                      "labels": {"app.kubernetes.io/managed-by": "Helm"}},
         "spec": {"selector": {inst: k8s.RELEASE, "app.kubernetes.io/name": "rocketchat"},
                  "type": "ClusterIP"}},
        {"metadata": {"name": "rocketchat-ddp-streamer",
                      "labels": {"app.kubernetes.io/managed-by": "Helm"}},
         "spec": {"selector": {inst: k8s.RELEASE,
                               "app.kubernetes.io/name": "rocketchat-ddp-streamer"},
                  "type": "ClusterIP"}},
        # Our own hand-rolled MongoDB: its selector names no instance, so it is
        # excluded without being named -- it has its own lifecycle and its own
        # reasons to be briefly empty.
        {"metadata": {"name": "mongodb",
                      "labels": {"houston.io/workspace": "w"}},
         "spec": {"selector": {"app": "mongodb"}, "type": "ClusterIP"}},
        # No selector: wired by hand, so there are no pods to be missing.
        {"metadata": {"name": "rocketchat-manual", "labels": {}},
         "spec": {"type": "ClusterIP"}},
        # ExternalName has no endpoints by definition.
        {"metadata": {"name": "rocketchat-alias", "labels": {}},
         "spec": {"selector": {inst: k8s.RELEASE}, "type": "ExternalName"}},
    ]}

    def answer(argv, **kw):
        if "endpointslices" in argv:
            return _completed(0, out=json.dumps(slices))
        if "svc" in argv:
            return _completed(0, out=json.dumps(svcs))
        return _completed(0, out="{}")

    monkeypatch.setattr(k8s, "run", answer)
    assert k8s.services_without_endpoints("w", context="c") == \
        ["rocketchat-rocketchat"], k8s.services_without_endpoints("w", context="c")

    # A refused read says nothing rather than accusing every Service in the namespace
    # -- the same rule as everywhere else in this module.
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: _completed(
        1, err="Error from server (Forbidden): cannot list endpointslices"))
    assert k8s.services_without_endpoints("w", context="c") == []
    assert k8s.service_ready_addresses("ns", context="c") is None

    # And it reads EndpointSlice, not the API kubectl warns about on every call.
    src = source_of(k8s.service_ready_addresses)
    assert "endpointslices" in src
    assert '"endpoints", ' not in src, "the deprecated v1 Endpoints API is back"

    # The filter reads the SELECTOR. Asserted directly because getting this wrong is
    # invisible: it makes the function return [] for everything, which looks exactly
    # like a healthy workspace and is what shipped in the first attempt.
    pick = source_of(k8s.services_without_endpoints)
    assert 'spec.get("selector") or {}).get(' in pick, \
        "the instance is matched on the selector, not on the Service's labels"


def test_a_dead_port_forward_is_said_out_loud_and_names_its_repair(monkeypatch, tmp_path):
    """`list` showed `running` beside a URL that refused connections, and nothing
    anywhere said `ready` was the repair.

    A port-forward dies with its pod, so this is ordinary rather than exceptional --
    a restart, a rescheduled pod, a reboot. And "running" is not WRONG: it is the
    pods' state, and they may be perfectly healthy. That is exactly why the reader had
    nothing to go on -- the state was right, the URL was dead, and the two facts never
    met. So the note is derived on every read rather than recorded, and disappears the
    moment the forward is back.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra.update({"context": k8s.CONTEXT, "namespace": "houston-k",
                    "port_forward_pid": 4242})

    def titles(meta):
        return [g["title"] for g in lc.note_groups_of(meta)]

    monkeypatch.setattr(k8s, "forward_alive", lambda *a, **kw: False)
    groups = lc.note_groups_of(m)
    dead = [g for g in groups if g["title"] == "The URL is not published right now"]
    assert dead, titles(m)
    assert any("houston ready --name k" in c for c in dead[0]["commands"]), dead[0]
    assert any("localhost:3000" in b for b in dead[0]["body"]), dead[0]
    # It must not read as an accusation against Rocket.Chat, which may be fine.
    assert any("says nothing about Rocket.Chat" in b for b in dead[0]["body"])

    # A live forward says nothing at all.
    monkeypatch.setattr(k8s, "forward_alive", lambda *a, **kw: True)
    assert "The URL is not published right now" not in titles(m)

    # AND NEITHER DOES A RECORD WITH NO PID. `forward_alive(None)` is False, and
    # reading that as "no forward is running" is the exact confusion this release
    # spent itself removing -- a record written before the pid was tracked tells us
    # nothing about what is listening, so a note claiming a fact must stay quiet.
    monkeypatch.setattr(k8s, "forward_alive", lambda *a, **kw: False)
    m.extra.pop("port_forward_pid")
    assert "The URL is not published right now" not in titles(m), \
        "no pid recorded is 'I cannot say', not 'nothing is running'"

    # A Compose workspace is not affected: it publishes a real port.
    c = lc.runner.Metadata(name="d", project="houston-d", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3001",
                           host_port=3001, version_source="t")
    assert "The URL is not published right now" not in titles(c)


def test_a_workspace_made_before_groups_existed_still_renders_as_groups():
    """The grouped notes were built at create time and written into `repro.json`, so
    they only ever reached workspaces created after the release that added them. Every
    existing workspace kept the flat eleven-bullet dump in `info` and in the GUI panel
    for life, and the only way to see the new shape was to destroy the workspace and
    build another -- which for a repro of a customer's issue is the one thing you
    cannot do.

    Notes are a pure function of the record (namespace, context, release, bind host,
    preset), so they are derived on every read. This record is exactly what an older
    release wrote: a flat list and no groups at all.
    """
    m = _k8s_meta()
    m.extra["notes"] = [
        "microservices on kind-houston-local - about 9 pods, namespace houston-old",
        "reachable on this box at http://localhost:3000",
    ]
    s = lc._summary(m)
    titles = [g["title"] for g in s["note_groups"]]
    assert titles[:2] == ["Kubernetes", "MongoDB"]
    # The three steps read in the order somebody has to perform them.
    assert titles[2:5] == ["1 · Point kubectl and helm at this cluster",
                           "2 · Open the way in",
                           "3 · Look at what is inside"], titles
    # The facts that were welded into a sentence are rows now, for this record too.
    rows = dict((k, v) for k, v in s["note_groups"][0]["rows"])
    assert rows == {"Cluster": "kind-houston-local", "Namespace": "houston-old",
                    "Arrangement": "microservices", "Pods": "about 9"}
    # And the flat list the CLI prints is the derived one, not the sentence above.
    assert s["notes"] == lc.flatten_notes(s["note_groups"])
    assert not any("about 9 pods, namespace" in n for n in s["notes"])


def test_the_url_is_not_repeated_as_a_note_when_the_bind_is_loopback():
    """"reachable on this box at http://localhost:3000" was the fourth copy of that
    string on one screen -- the summary panel prints it, the panel's identity line
    carries it, the links table lists it -- and the browser had to de-duplicate the
    note against the link row to stop it appearing twice.

    What is not said anywhere else is what a NON-loopback bind means, and that is the
    only case the group appears in.
    """
    quiet = [g["title"] for g in lc.note_groups_of(_k8s_meta())]
    assert "Reachable from other machines" not in quiet
    assert not any("reachable on this box" in n
                   for n in lc.flatten_notes(lc.note_groups_of(_k8s_meta())))

    public = lc.note_groups_of(_k8s_meta(bind_host="0.0.0.0"))
    warned = {g["title"]: g for g in public}["Reachable from other machines"]
    assert "0.0.0.0" in " ".join(warned["body"])
    assert "admin123" in " ".join(warned["body"])          # what it exposes
    # The port-forward has to come back the same way it was published, or the
    # workspace is unreachable from the machines the note just warned about.
    forward = {g["title"]: g for g in public}["2 · Open the way in"]
    assert "--address 0.0.0.0" in forward["commands"][0]


def test_a_compose_workspaces_add_ons_are_groups_too():
    """The edge lines and the monitoring block were appended to one flat list, so a
    monitored workspace behind HTTPS had five unrelated bullets in a row. Same words,
    three sections -- and derived, so an older record gets them as well.
    """
    m = lc.runner.Metadata(
        name="c", project="houston-c", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        public_url="https://c.example.test",
        extra={"edge": True, "tls": "local", "monitoring": True})
    groups = {g["title"]: g for g in lc.note_groups_of(m)}
    assert list(groups) == ["HTTPS", "Monitoring"]
    assert "https://c.example.test" in " ".join(groups["HTTPS"]["body"])
    assert any("Grafana" in n for n in groups["Monitoring"]["body"])
    # A plain workspace has nothing to add and gets no empty sections.
    m.extra = {}
    m.public_url = ""
    assert lc.note_groups_of(m) == []


def test_a_command_in_the_notes_is_never_wrapped_where_it_would_be_pasted(capsys):
    """`_print_notes` wrapped every line to the box it drew, commands included. A
    port-forward came out as `... port-forward deployment/rocketchat-` on one line and
    `  rocketchat 3000:3000` on the next, so the one thing anyone does with that line
    -- select it and paste it -- produced a broken command. The box is gone and an
    indented line overflows the width instead.

    Driven from a RECORDED flat note, which is both what an older workspace holds and
    the shape the derived groups render commands in.
    """
    from houston import cli

    forward = ("kubectl -n houston-a-fairly-long-workspace-name port-forward "
               "deployment/rocketchat-rocketchat 3000:3000")
    assert len(forward) > 88          # wider than anything `_print_notes` renders
    m = lc.runner.Metadata(
        name="c", project="houston-c", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        extra={"notes": ["bring the forward back with:", "    " + forward,
                         "`stats` needs metrics-server in the cluster " * 3]})
    cli._print_notes(m)
    out = capsys.readouterr().out.split("\n")
    assert [ln for ln in out if forward in ln], "the command has to survive as one line"
    assert not any(ln.rstrip().endswith("rocketchat-") for ln in out)
    # Prose is still wrapped, and a hyphenated word is not broken across the wrap.
    assert not any(ln.rstrip().endswith("metrics-") for ln in out)
    prose = [ln for ln in out if ln[:5] == "    " + ln[4:5].strip()]
    assert prose and max(len(ln) for ln in prose) <= 88


def test_the_terminal_prints_the_same_sections_the_panel_draws(capsys):
    """One definition, two renderings. The CLI used to print a flat list inside a box
    while the browser drew cards, and the two could only be compared by eye.
    """
    from houston import cli

    m = _k8s_meta()
    cli._print_notes(m)
    out = capsys.readouterr().out
    for group in lc.note_groups_of(m):
        # `_ascii` first: the terminal renderer replaces the middle dot in a step
        # heading, because a box-drawing or typographic glyph is not width-1 everywhere.
        title = cli._ascii(group["title"])
        assert any(ln.strip() == title for ln in out.split("\n")), title
        for k, v in group["rows"]:
            assert any(k in ln and str(v) in ln for ln in out.split("\n")), k
        for c in group["commands"]:
            assert c in out


def _kube_probe_stubs(monkeypatch, *, kind: bool, our_cluster: bool, active: str,
                      reachable: bool = True, reach_status: str = ""):
    """The four facts `plan_cluster` reads, stated instead of probed.

    BOTH reachability seams are stubbed. `reachable()` is the bool the resolution
    order uses and `reach()` is the four-way answer the refusal messages carry; they
    are the same probe and a test that stated one and left the other to run for real
    would drive a live `kubectl` from a unit test.
    """
    from houston.services import k8s
    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/kind" if (t == "kind" and kind) else "")
    monkeypatch.setattr(k8s, "clusters",
                        lambda: ([k8s.CLUSTER_NAME] if our_cluster else [], ""))
    monkeypatch.setattr(k8s, "cluster_context",
                        lambda: k8s.CONTEXT if our_cluster else "")
    monkeypatch.setattr(k8s, "active_context", lambda: active)
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None: reachable)
    status = reach_status or (k8s.REACH_OK if reachable else k8s.REACH_DOWN)
    monkeypatch.setattr(k8s, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=status))
    monkeypatch.setattr(k8s, "distribution", lambda ctx: "k3s")


def test_the_only_difference_between_kind_and_k3s_is_whether_a_cluster_is_built(monkeypatch):
    """`up --runtime kubernetes` could only ever use a cluster houston built itself:
    `create_workspace` opened with `ensure_cluster()`, which refuses when `kind` is
    absent. So on a box running k3s -- an ordinary way to have Kubernetes -- `doctor`
    said "Using your cluster 'default'" and `up` refused to use it, two commands in one
    tool contradicting each other.

    Provisioning is the ONE step that differs. Everything after it already took
    `context=`, which is why adopting a cluster is a resolver and not a runtime.
    """
    from houston.errors import PreflightError
    from houston.services import k8s

    # kind, with its cluster already up: ours, and nothing to build. Today's behaviour.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=True, active="default")
    plan = k8s.plan_cluster()
    assert (plan.context, plan.distribution, plan.create) == (k8s.CONTEXT, "kind", False)

    # kind, no cluster yet: build ours. Today's behaviour, and the k3s box is IGNORED --
    # "no change to kind" is the stronger promise, so an existing cluster elsewhere never
    # takes the choice away from a box that can make its own.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    plan = k8s.plan_cluster()
    assert (plan.context, plan.distribution, plan.create) == (k8s.CONTEXT, "kind", True)

    # No kind: skip provisioning and use what kubectl points at.
    _kube_probe_stubs(monkeypatch, kind=False, our_cluster=False, active="default")
    plan = k8s.plan_cluster()
    assert (plan.context, plan.distribution, plan.create) == ("default", "k3s", False)

    # No kind and nothing reachable: refuse, and the message is now true.
    _kube_probe_stubs(monkeypatch, kind=False, our_cluster=False, active="")
    try:
        k8s.plan_cluster()
    except PreflightError as exc:
        assert "not pointed at one either" in str(exc), str(exc)
    else:
        raise AssertionError("a box with no cluster and no kind must be refused")


def test_a_named_context_is_adopted_and_never_provisioned(monkeypatch):
    """`--context` is step 0, and its whole point is that it cannot build anything.

    Provisioning a cloud cluster costs ~20 minutes and real money, and `plan_cluster`
    is reached by `check_capacity` through `_will_provision` -- so a `create=True` that
    an explicit context could produce would be a code path on which a CAPACITY CHECK
    spends money. `create` therefore keeps meaning exactly "this `up` will build a kind
    cluster", and a named context always returns False.

    The stubs put the box in the state that made this necessary: kind installed, no
    cluster of ours yet, so the un-named call plans a BUILD and ignores the k3s beside
    it.
    """
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s, "contexts", lambda: (["default", "eks-support"], ""))

    assert k8s.plan_cluster().create is True, "unchanged when no context is named"

    plan = k8s.plan_cluster(context="eks-support")
    assert (plan.context, plan.create) == ("eks-support", False), \
        "a named context must ADOPT, with kind installed and no cluster of our own"


def test_an_unknown_context_is_refused_and_says_what_exists(monkeypatch):
    """A typo is argument validation, so it refuses with the list rather than probing."""
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s, "contexts", lambda: (["default", "eks-support"], ""))

    with pytest.raises(errors.ValidationError) as exc:
        k8s.plan_cluster(context="eks-suport")
    assert "eks-suport" in str(exc.value)
    assert "eks-support" in str(exc.value), "the refusal must name what IS there"


def test_a_kubeconfig_that_cannot_be_read_does_not_refuse_a_context(monkeypatch):
    """"I could not ask" is not "it is not there", and only one is safe to act on.

    `contexts()` returns the reason separately for exactly this: if the refusal above
    fired on an unreadable kubeconfig, a transient `kubectl` failure would be reported
    to the user as a typo in their cluster name. The reachability probe is the real
    test and answers for itself.
    """
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s, "contexts", lambda: ([], "permission denied"))

    plan = k8s.plan_cluster(context="eks-support")
    assert (plan.context, plan.create) == ("eks-support", False), \
        "an unreadable kubeconfig must not be read as 'that context does not exist'"


def test_a_named_context_that_does_not_answer_is_refused(monkeypatch):
    """And the refusal carries the read failure, so the cause is not thrown away."""
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default",
                      reachable=False)
    monkeypatch.setattr(k8s, "contexts", lambda: ([], "kubeconfig unreadable"))

    with pytest.raises(errors.PreflightError) as exc:
        k8s.plan_cluster(context="eks-support")
    assert "nothing answered" in str(exc.value), \
        "the refusal must name WHICH kind of unreachable this was"
    assert "kubeconfig unreadable" in str(exc.value), \
        "the reason the list could not be read belongs in the refusal"


def test_the_cluster_is_privileged_and_both_callers_resolve_it_the_same_way(monkeypatch,
                                                                           tmp_path):
    """One resolver, because two callers disagreeing is a real failure.

    `_will_provision` decides whether `check_capacity` reserves a control plane's RAM;
    `_create_kubernetes` decides where the workspace actually goes. A default applied
    in one and not the other reserves memory for a kind cluster while building in EKS.
    """
    from houston import config

    assert "context" in lc.PRIVILEGED_CREATE_FIELDS, \
        "choosing the cluster is the same class of decision as rc_image and bind"

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert lc.req_context(lc.CreateReq(version="8.5.1")) == ""

    config.update_config(lambda c: c.__setitem__(config.KUBE_CONTEXT_KEY, "eks-support"))
    assert lc.req_context(lc.CreateReq(version="8.5.1")) == "eks-support", \
        "the box default applies to both front ends, not just the CLI"
    assert lc.req_context(lc.CreateReq(version="8.5.1", context="other")) == "other", \
        "an explicit --context still wins"


def test_rebuilding_a_workspace_cannot_move_it_to_another_cluster():
    """`axes_of_meta` feeds `restore` and the GUI's start-a-downed-workspace button.

    Without the context those rebuild a request that sends `plan_cluster` back through
    its own four steps -- and on a box with the kind binary that is step 2, so a
    workspace living in a remote cluster would be rebuilt by BUILDING A LOCAL CLUSTER
    for it.
    """
    from houston.services import topology

    class M:
        preset = "default"
        extra = {"runtime": "kubernetes", "context": "eks-support"}

    assert topology.axes_of_meta(M()).get("context") == "eks-support"

    class Old:
        preset = "default"
        extra = {"runtime": "kubernetes"}

    assert "context" not in topology.axes_of_meta(Old()), \
        "a workspace older than --context must keep resolving exactly as it did"


def test_doctor_reports_on_the_cluster_up_would_actually_use(monkeypatch, tmp_path):
    """`doctor` must not become a second opinion about the boot.

    k8s.py:1117 records this as a bug already fixed once: `doctor` resolved the cluster
    itself and disagreed with `up` on a box with both kind and k3s -- it said "Using
    your cluster 'default'" while `up` built a kind cluster. Shipping `--context` on
    `up` alone recreates it for exactly the people who need it most, so `doctor` takes
    the same option and honours the same box default.
    """
    from houston import config
    from houston.services import doctor as doctorsvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: list[str] = []

    def spy(context: str = ""):
        seen.append(context)
        return k8s.Preflight(tools={})

    monkeypatch.setattr(k8s, "preflight", spy)

    doctorsvc.run_checks(context="eks-support")
    assert seen and seen[-1] == "eks-support", \
        "an explicit --context must reach the preflight `up` shares"

    seen.clear()
    config.update_config(
        lambda c: c.__setitem__(config.KUBE_CONTEXT_KEY, "eks-default"))
    doctorsvc.run_checks()
    assert seen and seen[-1] == "eks-default", \
        "the box default must reach doctor too, or it reports on a different cluster"

    seen.clear()
    doctorsvc.run_checks(context="explicit")
    assert seen and seen[-1] == "explicit", "an explicit context still wins"


def test_a_refused_context_is_told_what_to_do_about_THAT_context(monkeypatch):
    """The remedy has to match the cluster, and for one case it was actively wrong.

    Both refusals used to end in `aws eks update-kubeconfig`, which is the right hint
    for the case `--context` was built for and the wrong one for houston's OWN kind
    cluster -- where the answer is to stop passing `--context`, because a named context
    is adopted rather than created. Measured: on a fresh HOUSTON_HOME,
    `--context kind-houston-local` refused and told the user to run an AWS command
    about a local kind cluster.
    """
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s, "contexts", lambda: (["default"], ""))

    # Ours, absent, and kind is here to build it.
    with pytest.raises(errors.ValidationError) as exc:
        k8s.plan_cluster(context=k8s.CONTEXT)
    assert "WITHOUT" in str(exc.value) and "--context" in str(exc.value)
    assert "aws eks update-kubeconfig" not in str(exc.value), \
        "an AWS remedy for a local kind cluster is the defect this test exists for"

    # Ours, absent, and no kind to build it with -- a different remedy.
    monkeypatch.setattr(k8s, "which", lambda t: "")
    with pytest.raises(errors.ValidationError) as exc:
        k8s.plan_cluster(context=k8s.CONTEXT)
    assert "Install kind" in str(exc.value)

    # Somebody else's cluster, absent: the AWS hint is right here and stays.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s, "contexts", lambda: (["default"], ""))
    with pytest.raises(errors.ValidationError) as exc:
        k8s.plan_cluster(context="my-eks")
    assert "aws eks update-kubeconfig" in str(exc.value)

    # Ours, PRESENT in the kubeconfig but not answering -- same remedy, other error.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default",
                      reachable=False)
    monkeypatch.setattr(k8s, "contexts", lambda: ([k8s.CONTEXT, "default"], ""))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.plan_cluster(context=k8s.CONTEXT)
    assert "WITHOUT" in str(exc.value)
    assert "get nodes" not in str(exc.value), \
        "telling someone to debug kubectl against a cluster houston would build is noise"

    # Somebody else's, present but not answering: debug it, and `aws` is named because
    # an EKS kubeconfig cannot authenticate without it.
    with pytest.raises(errors.PreflightError) as exc:
        k8s.plan_cluster(context="default")
    assert "get nodes" in str(exc.value) and "`aws` on PATH" in str(exc.value)


def test_a_cloud_provisioning_tool_cannot_switch_off_local_provisioning(monkeypatch):
    """`can_provision` is an `all()`, so the registry it reads decides who it breaks.

    Putting a cloud tool in the same dict as kind would make the property False on
    every box that has kind and not that tool -- and it is not a cosmetic answer:
    `preflight()` gates its `cluster_exists`/`other_clusters` probe on it, and the GUI
    create dialog reads it to decide whether to say "no cluster yet" and to label the
    runtime card "Kubernetes (kind)". A box that can build a kind cluster would have
    stopped saying so because it had no AWS tooling installed.
    """
    from houston.services import k8s

    kind_only = {"kind": k8s.Tool(name="kind", path="/usr/bin/kind", version=(0, 32)),
                 "kubectl": k8s.Tool(name="kubectl", path="/usr/bin/kubectl",
                                     version=(1, 36)),
                 "helm": k8s.Tool(name="helm", path="/usr/bin/helm", version=(4, 2))}

    monkeypatch.setattr(k8s, "CLOUD_PROVISION_TOOLS", {"eksctl": (0, 195)})
    pre = k8s.Preflight(tools=dict(kind_only))

    assert pre.can_provision is True, \
        "a cloud tool in the registry must not disown a box that has kind"
    assert pre.can_provision_cloud is False, \
        "and the cloud answer is its own question"

    # With the cloud tool actually present, both are true and neither shadows the other.
    withcloud = dict(kind_only)
    withcloud["eksctl"] = k8s.Tool(name="eksctl", path="/usr/bin/eksctl",
                                   version=(0, 200))
    assert k8s.Preflight(tools=withcloud).can_provision_cloud is True

    # An EMPTY cloud registry is False, not True. `all()` over nothing is True, and
    # "no cloud tooling compiled in" must never read as "yes, this box builds EKS".
    monkeypatch.setattr(k8s, "CLOUD_PROVISION_TOOLS", {})
    assert k8s.Preflight(tools=dict(kind_only)).can_provision_cloud is False


def test_an_advisory_note_is_cleared_only_when_ITS_subject_is_gone(monkeypatch, tmp_path):
    """`recover()` drops an advisory note whose subject is gone. Which subject?

    It asked `runner.exists(entry.workspace)`, which is right for every kind today
    because every one of them is about a workspace -- and only accidentally right. An
    `Entry` is keyed on a workspace name and `runner.exists()` looks for markers under
    `repros/<name>/`, so a note about something that is NOT a workspace answers False
    always and is cleared silently at the next `serve` startup. A note about a
    half-created cloud cluster is exactly that shape, and it is the most expensive note
    the product could hold.
    """
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    # Unchanged for a workspace kind: absent means gone.
    e = journal.Entry(id="a", kind=journal.CREATE_UNFINISHED, workspace="ghost", pid=1)
    assert journal.still_there(e) is False

    # A kind whose subject is NOT a workspace asks its own question, and is believed.
    monkeypatch.setitem(journal._SUBJECT_EXISTS, "cluster_unfinished",
                        lambda entry: True)
    c = journal.Entry(id="b", kind="cluster_unfinished", workspace="rc-support", pid=1)
    assert journal.still_there(c) is True, \
        "a cluster that IS there must not be read as gone because no workspace matches"

    # ...and when its own question says gone, it really is gone.
    monkeypatch.setitem(journal._SUBJECT_EXISTS, "cluster_unfinished",
                        lambda entry: False)
    assert journal.still_there(c) is False

    # A predicate that cannot answer keeps the note. "I could not ask" is not "it is
    # gone", and the two mistakes do not cost the same: a stale note wastes a line, a
    # dropped one loses the only record that something is still billing.
    def boom(entry):
        raise RuntimeError("no credentials")

    monkeypatch.setitem(journal._SUBJECT_EXISTS, "cluster_unfinished", boom)
    assert journal.still_there(c) is True, \
        "an unanswerable subject must not be treated as an absent one"


def test_a_tool_probed_with_the_wrong_flag_passes_its_floor_silently(monkeypatch):
    """Two correct behaviours combine into a version floor that never fires.

    `tool()`'s fallback asks `<name> --version`. `_parse_version` returns () when it
    cannot read the output, and `Tool.new_enough` returns True on an empty version --
    deliberately, so an unparseable version never blocks a tool that works. Together
    they mean a tool that does not accept `--version` is reported present, new enough,
    and unversioned. `eksctl` is cobra-based and spells it `eksctl version`.
    """
    from houston.services import k8s

    seen: list[list[str]] = []

    def fake_run(argv, **kw):
        seen.append(list(argv))
        import subprocess
        if argv[1:] == ["--version"]:            # what cobra does with an unknown flag
            return subprocess.CompletedProcess(
                argv, 1, "", 'unknown flag: --version')
        return subprocess.CompletedProcess(argv, 0, "0.195.0", "")

    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/eksctl")
    monkeypatch.setattr(k8s, "run", fake_run)

    found = k8s.tool("eksctl")
    assert seen[-1] == ["eksctl", "version"], \
        f"probed with {seen[-1]}, which cobra refuses"
    assert found.version == (0, 195, 0), found.raw

    # And the hazard itself, stated so the reason for the mapping is not lost: an
    # unparsed version is not a failed floor, it is a PASSED one.
    assert k8s.Tool(name="x", path="/x", version=()).new_enough is True


def test_a_version_floor_says_something_true_about_where_it_came_from(monkeypatch,
                                                                     tmp_path):
    """`doctor` cited the official Rocket.Chat guide for every floor it enforces.

    It is unverifiable for all of them. Launchpad's prerequisites name `kubectl` and
    `eksctl` with no versions at all, and never mention `kind`. So somebody told their
    kind was "older than 0.20, the floor the official Rocket.Chat guide requires" was
    being sent to a document that does not contain the requirement -- and the same
    sentence would have been produced for any cloud tool added to the registry.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    old = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
        "helm": k8s.Tool(name="helm", path="/h", version=(4, 2)),
        "kind": k8s.Tool(name="kind", path="/kd", version=(0, 1)),   # below its floor
    })
    monkeypatch.setattr(k8s, "preflight", lambda context="": old)

    msgs = [r["message"] for r in doctorsvc.run_checks()["checks"]]
    hit = [m for m in msgs if "kind" in m and "older than" in m]
    assert hit, msgs
    assert "official Rocket.Chat guide" not in hit[0], \
        "the guide does not mention kind, let alone a version of it"
    assert "extraPortMappings" in hit[0], \
        "the floor should say what actually decided it"


def test_the_ledger_never_reports_a_zero_it_did_not_read(monkeypatch, tmp_path):
    """A ledger exists to stop a cluster being forgotten. The way it fails at that is
    by reporting an unreadable cluster as an empty one -- "0 workspaces, nothing
    costing you money" is precisely the sentence that lets a bill run.

    So every count is None when the read was REFUSED, never 0, and `unreadable` names
    which. This is `k8s.Answer`'s three-answer discipline applied to a screen instead
    of a delete, and the screen is where the mistake is quietest.
    """
    from houston.services import cluster, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The named context has to EXIST, because `status` refuses an unknown one the same
    # way `up --context` does -- a typo is a bad argument, not a cluster that is down.
    monkeypatch.setattr(k8s, "contexts", lambda: (["eks-support"], ""))
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, timeout=None: True)
    monkeypatch.setattr(k8s, "reach", lambda ctx=None, timeout=None: k8s.Reach(
        status=k8s.REACH_OK))
    monkeypatch.setattr(k8s, "distribution", lambda ctx: "eks")
    monkeypatch.setattr(k8s, "operator_installed", lambda ctx: False)
    monkeypatch.setattr(k8s, "monitoring_installed", lambda ctx: False)
    # Everything refuses: no nodes, no namespaces, no services.
    monkeypatch.setattr(k8s, "ask_list",
                        lambda kind, **kw: k8s.Answer(state=k8s.REFUSED))
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx: None)

    out = cluster.status(context="eks-support")
    assert out["nodes"] is None and out["workspaces"] is None
    assert out["pvcs"] is None and out["loadbalancers"] is None
    assert set(out["unreadable"]) >= {"nodes", "workspaces", "loadbalancers"}
    for key in ("nodes", "workspaces", "pvcs", "loadbalancers"):
        assert out[key] != 0, f"{key} reported 0 for a read that was refused"

    # And an UNREACHABLE cluster reports nothing at all rather than an empty one.
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, timeout=None: False)
    monkeypatch.setattr(k8s, "reach", lambda ctx=None, timeout=None: k8s.Reach(
        status=k8s.REACH_DOWN))
    out = cluster.status(context="eks-support")
    assert out["reachable"] is False and "cluster" in out["unreadable"]
    assert out["workspaces"] is None and out["loadbalancers"] is None


def test_the_cost_estimate_counts_the_nodes_it_cannot_price(monkeypatch):
    """A total that silently drops what it did not recognise reads as complete.

    Same failure as a zero for an unreadable cluster, one layer along: the number is
    believable, arrived at honestly, and wrong in the direction that costs money.
    """
    from houston.services import cluster

    # Free distributions are not priced at all -- quoting zero for somebody's own k3s
    # would be a claim about their infrastructure bill.
    assert cluster.estimate_usd_hr("k3s", {"": 1}) is None
    assert cluster.estimate_usd_hr("kind", {"": 1}) is None

    base = cluster.EKS_CONTROL_PLANE_USD_HR + cluster.NAT_GATEWAY_USD_HR
    disk = (cluster.NODE_VOLUME_GB * cluster.EBS_GP3_USD_GB_MONTH
            / cluster.HOURS_PER_MONTH)

    got = cluster.estimate_usd_hr("eks", {"t3.large": 3})
    assert got["usd_hr"] == round(
        base + 3 * (cluster.INSTANCE_USD_HR["t3.large"] + disk), 4)
    assert got["estimate"] is True and not got["unpriced"]

    # An unknown type is REPORTED, not dropped and not guessed at -- and its DISK is
    # still counted. This assertion used to read `base + one t3.large` exactly, which
    # said an unpriced node contributes nothing at all; a live run showed that eksctl
    # attaches 80 GB to it like any other, so "we cannot price the instance" is not
    # "this node is free".
    mixed = cluster.estimate_usd_hr("eks", {"t3.large": 1, "x9.enormous": 2})
    assert mixed["unpriced"] == {"x9.enormous": 2}
    assert mixed["usd_hr"] == round(
        base + cluster.INSTANCE_USD_HR["t3.large"] + 3 * disk, 4), \
        "the priced part must be right, the disks all counted, the caller told which "\
        "instance types could not be priced"


def test_being_signed_in_to_aws_is_a_prerequisite_houston_reads_not_one_it_holds(
        monkeypatch):
    """Three states, because "no credentials" and "I could not find out" differ.

    Only one of them is the operator's to fix by signing in, and houston never stores
    or refreshes a credential -- it reads whatever `aws configure`, SSO, an instance
    profile or the environment already arranged. The identity is then carried into
    every message, because `cluster support` exists in more than one AWS account and
    acting on the wrong one is this feature's whole failure mode.
    """
    import subprocess

    from houston.services import eks, k8s

    # No `aws` at all: a tool problem, not a credentials problem.
    monkeypatch.setattr(k8s, "which", lambda t: "")
    who = eks.whoami()
    assert not who.known and "not installed" in who.error

    # Present but refusing -- expired SSO, no profile, no route. AWS's own words are
    # kept, because they say which of those it was and houston cannot.
    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/aws")
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: subprocess.CompletedProcess(
        argv, 255, "", "Error loading SSO Token: Token has expired"))
    who = eks.whoami()
    assert not who.known and "expired" in who.error

    # Signed in: the ARN and the ACCOUNT, both, and the account is the half that
    # stops a cluster being built in the wrong one.
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: subprocess.CompletedProcess(
        argv, 0, '{"Account": "123456789012", '
                 '"Arn": "arn:aws:iam::123456789012:user/support-bot"}', ""))
    who = eks.whoami()
    assert who.known and who.account == "123456789012"
    assert "support-bot" in who.pretty and "123456789012" in who.pretty


def test_a_missing_tool_does_not_also_complain_about_credentials(monkeypatch):
    """Blockers are ordered by what to do first, and stop at the first cause.

    Asking about credentials before `aws` exists produces a second complaint about the
    same absence -- and a report that lists three problems where there is one teaches
    the reader that the list is noise.
    """
    from houston.services import eks, k8s

    absent = k8s.Tool(name="aws", path="")
    pre = eks.CloudPreflight(tools={"aws": absent}, identity=eks.Identity(), region="")
    assert pre.blockers == ["aws is not installed"], pre.blockers
    assert pre.ready is False

    # With the tool there and no credentials, the credential blocker appears -- and it
    # names what to do rather than only what is wrong.
    present = k8s.Tool(name="aws", path="/usr/bin/aws", version=(2, 15))
    pre = eks.CloudPreflight(tools={"aws": present}, identity=eks.Identity(),
                             region="eu-west-1")
    assert len(pre.blockers) == 1 and "not signed in" in pre.blockers[0]
    assert "aws sso login" in pre.blockers[0]

    # A region is its own blocker: houston and eksctl resolving it differently means
    # a cluster somewhere neither of them will look for it afterwards.
    pre = eks.CloudPreflight(
        tools={"aws": present},
        identity=eks.Identity(account="1", arn="arn:aws:iam::1:user/x"), region="")
    assert len(pre.blockers) == 1 and "region" in pre.blockers[0]

    pre = eks.CloudPreflight(
        tools={"aws": present},
        identity=eks.Identity(account="1", arn="arn:aws:iam::1:user/x"),
        region="eu-west-1")
    assert pre.ready is True and pre.blockers == []


def test_a_new_vpc_by_default_and_an_existing_one_only_when_named():
    """The decision, and it is not symmetric.

    There is no safe guess at which of an account's subnets a support workspace
    belongs in, and picking wrong puts a cluster somewhere it can be reached from, or
    cannot reach out from, in ways nobody asked for. New is the answer that is wrong in
    the recoverable direction.
    """
    from houston.services import eks

    fresh = eks.cluster_config("rc-support", region="eu-west-1")
    assert fresh["vpc"] == {"cidr": eks.DEFAULT_VPC_CIDR}
    assert "subnets" not in fresh["vpc"], "a default create must not adopt a VPC"

    named = eks.cluster_config("rc-support", region="eu-west-1",
                               subnets={"eu-west-1b": "subnet-b",
                                        "eu-west-1a": "subnet-a"})
    assert named["vpc"]["subnets"]["private"] == {
        "eu-west-1a": {"id": "subnet-a"}, "eu-west-1b": {"id": "subnet-b"}}
    assert "cidr" not in named["vpc"], "naming subnets means NOT making a VPC"


def test_the_cluster_shape_matches_the_reference_it_claims_to_match():
    """Launchpad is the reference for what an EKS cluster must PROVIDE, so the
    numbers that carry fidelity are copied and the one that does not is not.

    Managed node group rather than Auto Mode, Kubernetes 1.33, t3.large, and the EBS
    CSI addon pinned to the version Launchpad pins -- those decide whether a
    reproduction behaves like the customer's cluster. Node COUNT does not, so it is
    the one deliberate divergence: Launchpad sizes for a production workspace and a
    repro carries one.
    """
    from houston.services import eks

    doc = eks.cluster_config("rc-support", region="us-east-1")
    assert doc["metadata"]["version"] == "1.33"
    assert doc["managedNodeGroups"][0]["instanceType"] == "t3.large"
    assert doc["addons"] == [{"name": "aws-ebs-csi-driver", "version": "1.47.0"}]
    assert doc["iam"]["withOIDC"] is True, \
        "without OIDC the EBS addon installs and every PVC stays Pending"
    assert "autoModeConfig" not in doc, "Auto Mode is not the reference shape"
    assert doc["managedNodeGroups"][0]["desiredCapacity"] == eks.DEFAULT_NODES == 3

    assert eks.cluster_config("x", region="us-east-1",
                              nodes=5)["managedNodeGroups"][0]["desiredCapacity"] == 5


def test_doctor_is_silent_about_aws_until_aws_is_somebody_s_business(monkeypatch,
                                                                    tmp_path):
    """A Compose-and-kind box must not be padded with cloud complaints.

    The same reasoning as the one-line "Kubernetes not set up": a red line for a
    half-finished optional feature is how a report teaches people to ignore red lines.
    But on a cluster that IS EKS, `aws` is not optional -- the kubeconfig authenticates
    by shelling out to it -- so there it fails rather than warns.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import eks as ekssvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    nothing = ekssvc.CloudPreflight(
        tools={"aws": k8s.Tool(name="aws", path=""),
               "eksctl": k8s.Tool(name="eksctl", path="")},
        identity=ekssvc.Identity(), region="")
    monkeypatch.setattr(ekssvc, "preflight", lambda: nothing)

    def rows(distribution: str) -> list[dict]:
        pre = k8s.Preflight(tools={
            "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
            "helm": k8s.Tool(name="helm", path="/h", version=(4, 2))})
        pre.distribution = distribution
        monkeypatch.setattr(k8s, "preflight", lambda context="": pre)
        return doctorsvc.run_checks()["checks"]

    assert not [r for r in rows("k3s") if r["check"] == "kubernetes-cloud"], \
        "a k3s box has no business being told about AWS"

    on_eks = [r for r in rows("eks") if r["check"] == "kubernetes-cloud"]
    assert on_eks, "a cluster that IS EKS must be told aws is missing"
    assert all(r["status"] == "fail" for r in on_eks), \
        "on EKS a missing `aws` is not a warning — every kubectl call fails without it"


def _aws_ready(monkeypatch, account="123456789012"):
    """A box that could build a cluster: tools present, signed in, region set."""
    from houston.services import eks, k8s
    tool = k8s.Tool(name="x", path="/usr/bin/x", version=(9, 9))
    monkeypatch.setattr(eks, "preflight", lambda: eks.CloudPreflight(
        tools={"aws": tool, "eksctl": tool},
        identity=eks.Identity(account=account,
                              arn=f"arn:aws:iam::{account}:user/support-bot"),
        region="eu-west-1"))


def test_creating_a_cluster_is_gated_on_the_account_that_gets_the_bill(monkeypatch,
                                                                      tmp_path):
    """A GATE, not a confirmation, and keyed on the ACCOUNT rather than the name.

    The account is the thing that gets billed — the unit somebody actually owns and
    can consent to. And the gate carries `approve_with`, which is what to ask a human
    to run, never something the caller may run for itself.
    """
    from houston import errors
    from houston.services import eks

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    spent: list = []
    monkeypatch.setattr(eks.k8s, "run", lambda *a, **kw: spent.append(a) or None)

    with pytest.raises(errors.AuthorityGateError) as exc:
        eks.create_cluster("support")
    assert exc.value.code == "GATE_CLOUD_SPEND"
    assert "123456789012" in str(exc.value)
    assert "cluster.approved_accounts" in exc.value.approve_with
    assert not spent, "the gate must refuse BEFORE anything is run"

    # The gate is not reachable by --force anywhere: there is no such parameter on
    # create at all, which is the point. Approval is a decision, force is a reflex.
    import inspect
    assert "force" not in inspect.signature(eks.create_cluster).parameters


def test_an_approved_account_reaches_eksctl_with_the_right_command(monkeypatch,
                                                                  tmp_path):
    """What is actually run, asserted without running it.

    This is the expensive path's only unverifiable step, so the argv and the document
    handed to it are pinned here: everything up to the subprocess can be checked
    without an AWS account, which leaves "does eksctl behave as documented" as the
    single thing an account is needed for.
    """
    import yaml

    from houston import config
    from houston.services import eks, journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    config.update_config(
        lambda c: c.__setitem__(config.CLOUD_ACCOUNTS_KEY, "123456789012"))
    monkeypatch.setattr(eks, "describe_cluster",
                        lambda n, r: eks.k8s.Answer(state=eks.k8s.ABSENT))

    seen: dict = {}

    def fake_stream(argv, **kw):
        seen["argv"] = list(argv)
        seen["timeout"] = kw.get("timeout")
        seen["doc"] = yaml.safe_load(open(argv[argv.index("-f") + 1]).read())
        # The note must be on disk WHILE eksctl runs -- that is its whole purpose.
        seen["note_during"] = [e.kind for e in journal.open_entries()]
        return 0

    # `_stream`, not `k8s.run`: the create switched to streaming so a twenty-minute
    # build reports progress, and a stub left on the old seam does not intercept --
    # this test then shelled out to REAL eksctl against REAL credentials.
    monkeypatch.setattr(eks, "_stream", fake_stream)
    monkeypatch.setattr(eks.k8s, "run", lambda *a, **kw: None)
    eks.create_cluster("support", nodes=3)

    assert seen["argv"][:4] == ["eksctl", "create", "cluster", "-f"]
    assert seen["timeout"] == eks.CLUSTER_CREATE_TIMEOUT
    assert seen["timeout"] > 900, \
        "a 15-25 minute create cannot run under a timeout built for a local one"
    assert journal.CLUSTER_UNFINISHED in seen["note_during"], \
        "the note has to be down BEFORE the call; written after, it describes nothing"
    assert not journal.open_entries(), "and cleared once eksctl returned"

    doc = seen["doc"]
    # The OWNERSHIP tag specifically, not the whole dict: this asserts that the thing
    # authorising a later delete is set at creation, and `==` also asserted that
    # nothing else may ever be tagged -- which broke the moment an expiry was added,
    # for a reason that has nothing to do with what this test is about.
    tags = doc["metadata"]["tags"]
    assert tags[eks.OWNED_TAG_KEY] == eks.OWNED_TAG_VALUE, \
        "tagged AT creation — a later tagging step has a window that crashes inside"
    assert eks.EXPIRY_TAG_KEY in tags, "and a create carries an expiry by default"
    assert doc["vpc"] == {"cidr": eks.DEFAULT_VPC_CIDR}
    assert eks.remembered()[0]["account"] == "123456789012"


def test_a_create_that_fails_keeps_the_note_that_says_it_may_be_billing(monkeypatch,
                                                                       tmp_path):
    """eksctl can build a VPC, a NAT gateway and a control plane and then fail.

    houston does not decide on its own to destroy those — so the note stays, and it
    is the note, not the exception, that survives the process ending.
    """
    from houston import config, errors
    from houston.services import eks, journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    config.update_config(
        lambda c: c.__setitem__(config.CLOUD_ACCOUNTS_KEY, "123456789012"))
    monkeypatch.setattr(eks, "describe_cluster",
                        lambda n, r: eks.k8s.Answer(state=eks.k8s.ABSENT))
    monkeypatch.setattr(eks, "_stream", lambda *a, **kw: 1)
    monkeypatch.setattr(eks.k8s, "run", lambda *a, **kw: None)

    with pytest.raises(errors.CreateFailedError):
        eks.create_cluster("support")

    left = journal.open_entries()
    assert [e.kind for e in left] == [journal.CLUSTER_UNFINISHED]
    said = journal.describe(left[0])
    assert "BILLING NOW" in said
    assert "cloudformation describe-stacks" in said, \
        "the obvious `eksctl delete` is the advice that fails when a stack survives"
    assert "eu-west-1" in said and "123456789012" in said, \
        "a note that does not say where is unactionable"


def test_deleting_a_cloud_cluster_reproduces_every_guard_the_local_one_earned(
        monkeypatch, tmp_path):
    """Each of these is a way this already went wrong once on a kind cluster, where
    the cost was a container rather than somebody's afternoon and a VPC.

    Plus two only the cloud needs: the tag must say ours, and the refusal must name the
    account and region -- a cluster called `support` exists in more than one account,
    and acting on the wrong one is this feature's whole failure mode.
    """
    import subprocess

    from houston import errors
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    ran: list = []
    monkeypatch.setattr(eks, "_stream",
                        lambda argv, **kw: ran.append(list(argv)) or 0)
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: ran.append(list(argv))
                        or subprocess.CompletedProcess(argv, 0, "", ""))

    def tags(value):
        doc = {"arn": "arn:aws:eks:eu-west-1:1:cluster/support"}
        if value is not None:
            doc["tags"] = value
        return lambda n, r: k8s.Answer(state=k8s.PRESENT, doc=doc)

    # GUARD 5a: the tag read REFUSED is not a yes.
    monkeypatch.setattr(eks, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.REFUSED))
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("support")
    assert "cannot prove" in str(exc.value)
    assert not ran, "nothing may be run on a read that failed"

    # GUARD 5b: present but NOT ours -> a gate, and GUARD 6: it names where.
    monkeypatch.setattr(eks, "describe_cluster", tags({"someone": "else"}))
    with pytest.raises(errors.AuthorityGateError) as gate:
        eks.delete_cluster("support")
    assert gate.value.code == "GATE_DELETE_UNOWNED"
    assert "eu-west-1" in str(gate.value) and "123456789012" in str(gate.value)
    assert not ran

    ours = tags({eks.OWNED_TAG_KEY: eks.OWNED_TAG_VALUE})
    monkeypatch.setattr(eks, "describe_cluster", ours)

    # GUARD 1: unreadable is not empty -- and the refusal names WHICH kind of
    # unreadable, because "is not answering" was printed for an ACTIVE cluster whose
    # only problem was that this box had no kubeconfig entry for it.
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, timeout=None: False)
    monkeypatch.setattr(k8s, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_DOWN))
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("support")
    assert "nothing answered" in str(exc.value) and "not an empty one" in str(exc.value)
    assert not ran

    # The SAME guard, the same refusal, a different cause -- and the advice differs.
    monkeypatch.setattr(k8s, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_DENIED))
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("support")
    assert "refused these credentials" in str(exc.value), \
        "a cluster that answers and refuses is not a cluster that is down"
    assert "create-access-entry" in str(exc.value), \
        "and the advice must point at the access entry, not at the cluster's health"
    assert not ran

    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, timeout=None: True)
    monkeypatch.setattr(k8s, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_OK))

    # GUARD 2: an unreadable workspace list is not an empty one.
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx: None)
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("support")
    assert "could not be read" in str(exc.value)
    assert not ran

    # GUARD 3: non-empty refuses, and NAMES WHOSE -- on a shared cloud cluster this
    # refusal is the only record that colleagues on other boxes have work in here.
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx: ["houston-tkt-1"])
    monkeypatch.setattr(k8s, "namespace_owner", lambda ns, context: "priya")
    with pytest.raises(errors.ConflictError) as conf:
        eks.delete_cluster("support")
    assert "priya" in str(conf.value)
    assert not ran

    # GUARD 4: --force is the only override, and then it really does go.
    assert eks.delete_cluster("support", force=True) is True
    gone = ["eksctl", "delete", "cluster", "--name", "support",
            "--region", "eu-west-1", "--wait"]
    assert gone in ran, "--force is the override, and then it really does go"
    assert "--wait" in gone, \
        "without --wait eksctl returns before the teardown has actually happened"
    # AND THEN IT TIDIES, which is why that is no longer the LAST thing to run.
    # `aws eks update-kubeconfig` and `eksctl` each wrote a context naming this
    # cluster and neither removes it, so a cluster deleted successfully went on being
    # listed for ever. Those entries are houston's own litter and the delete clears
    # them -- after the cluster is gone, never before, so a delete that fails leaves
    # the operator still able to reach what they were deleting.
    after = ran[ran.index(gone) + 1:]
    assert any(c[:2] == ["kubectl", "config"] for c in after), \
        "the contexts naming a deleted cluster must be cleared with it"


def test_a_cluster_that_is_simply_gone_is_not_an_error(monkeypatch, tmp_path):
    """ABSENT is a fact AWS asserted, and deleting nothing is not a failure."""
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _aws_ready(monkeypatch)
    monkeypatch.setattr(eks, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.ABSENT))
    assert eks.delete_cluster("support") is False


def test_an_interrupted_create_note_survives_a_serve_restart(monkeypatch, tmp_path):
    """The P0 journal fix, doing the job it was made for.

    Advisory notes are cleared when their subject is gone, and that question used to be
    `runner.exists(entry.workspace)`. A cluster is not a workspace, so this note --
    the most expensive one the product can hold -- would have been deleted at the next
    `serve` startup, silently.
    """
    from houston.services import eks, journal, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    journal.record(journal.CLUSTER_UNFINISHED, "rc-support",
                   region="eu-west-1", account="1")

    # The cluster is still there: the note must survive.
    monkeypatch.setattr(eks, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.PRESENT, doc={}))
    monkeypatch.setattr(journal, "abandoned", journal.open_entries)
    rows = journal.recover(dry_run=True)
    assert [r["kind"] for r in rows] == [journal.CLUSTER_UNFINISHED]
    assert journal.open_entries(), "a live billable cluster's note was dropped"

    # Could not ask: the note must ALSO survive. A credential expiring between the
    # create and the next startup must not lose the record.
    monkeypatch.setattr(eks, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.REFUSED))
    assert journal.recover(dry_run=True), "an unaskable subject is not an absent one"

    # And when AWS says it is genuinely gone, the note clears itself.
    monkeypatch.setattr(eks, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.ABSENT))
    journal.recover()
    assert not journal.open_entries()


def test_a_version_floor_cannot_express_skew(monkeypatch):
    """Two different questions, and only the second can be true about a cluster.

    A floor is a fact about houston: kubectl >= 1.21. Skew is a fact about the cluster
    in front of you, and Rocket.Chat's own Launchpad builds them at 1.33 — so a kubectl
    eleven minors PAST the floor is still outside the supported ±1 window, and passing
    a floor is exactly what it would report doing. Calls do not fail cleanly across
    that gap; they fail on a field one side does not know, which reads as a bug in
    whatever was being deployed.
    """
    import subprocess

    from houston.services import k8s

    def server(ver: str):
        monkeypatch.setattr(k8s, "run", lambda argv, **kw:
                            subprocess.CompletedProcess(
                                argv, 0,
                                '{"serverVersion": {"gitVersion": "%s"}}' % ver, ""))

    server("v1.33.1")
    # The floor says this kubectl is fine. It is eleven minors from the server.
    assert k8s.Tool(name="kubectl", path="/k",
                    version=(1, 22)).new_enough is True, "the floor passes it"
    out = k8s.skew("ctx", client=(1, 22))
    assert out["ok"] is False and out["gap"] == 11, out

    # Inside the window, either side of it.
    assert k8s.skew("ctx", client=(1, 32))["ok"] is True
    assert k8s.skew("ctx", client=(1, 34))["ok"] is True
    assert k8s.skew("ctx", client=(1, 35))["ok"] is False

    # A different MAJOR is not a near miss.
    assert k8s.skew("ctx", client=(2, 33))["ok"] is False

    # Unreadable is None, not "fine" -- a skew nobody could measure must not be
    # reported as a match.
    monkeypatch.setattr(k8s, "run", lambda argv, **kw:
                        subprocess.CompletedProcess(argv, 1, "", "forbidden"))
    assert k8s.skew("ctx", client=(1, 33)) is None


def test_a_cloud_cluster_this_box_built_is_reported_even_with_no_aws_installed(
        monkeypatch, tmp_path):
    """A cluster does not stop billing because `aws` was uninstalled afterwards.

    Everything else AWS-shaped in `doctor` is behind a relevance gate — a Compose box
    must not be padded with cloud complaints. This one is deliberately outside it,
    because the box with no cloud tooling is exactly the box most likely to have
    forgotten a cluster it built. It reads the local pointer rather than AWS, which is
    the whole reason the pointer exists: `doctor` has to be able to say this without a
    credential or a round trip.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/kubectl"
                        if t in ("kubectl", "helm") else "")
    pre = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
        "helm": k8s.Tool(name="helm", path="/h", version=(4, 2))})
    monkeypatch.setattr(k8s, "preflight", lambda context="": pre)

    assert not [r for r in doctorsvc.run_checks()["checks"]
                if r["check"] == "kubernetes-cloud-owned"], "nothing built, nothing said"

    eks.remember("rc-support", region="eu-west-1", account="123456789012")
    rows = [r for r in doctorsvc.run_checks()["checks"]
            if r["check"] == "kubernetes-cloud-owned"]
    assert len(rows) == 1, rows
    said = rows[0]["message"]
    assert "rc-support" in said and "eu-west-1" in said and "123456789012" in said, \
        "a warning that does not say WHICH cluster, where, or whose is unactionable"
    assert "cluster delete rc-support" in said, "and it has to say how to stop it"

    # And it goes when the cluster does.
    eks.forget("rc-support")
    assert not [r for r in doctorsvc.run_checks()["checks"]
                if r["check"] == "kubernetes-cloud-owned"]


def test_which_kubeconfig_houston_reads_does_not_depend_on_which_kubectl_is_installed(
        monkeypatch, tmp_path):
    """Found live, and it was the worst possible failure text.

    `kubectl` on the box was a symlink to k3s, whose embedded client reads
    `/etc/rancher/k3s/k3s.yaml` when KUBECONFIG is unset. `aws eks update-kubeconfig`
    had just written the cluster into `~/.kube/config` — the standard path — so the two
    files never met, and `--context <the arn>` was refused with a message telling the
    operator to run the exact command they had just run. The context existed, was
    correct, and was invisible.
    """
    from houston.services import k8s

    home = tmp_path / "home"
    (home / ".kube").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("KUBECONFIG", raising=False)

    # No ~/.kube/config yet: leave kubectl's own default alone rather than pointing it
    # at a file that does not exist, which would take away whatever default it has.
    assert k8s.user_env() is None

    (home / ".kube" / "config").write_text("apiVersion: v1\n")
    env = k8s.user_env()
    assert env is not None and env["KUBECONFIG"] == str(home / ".kube" / "config"), \
        "the standard path must be named explicitly, not left to the binary"

    # An operator who SET it has said which files they mean. Obeyed untouched.
    monkeypatch.setenv("KUBECONFIG", "/somewhere/else.yaml")
    assert k8s.user_env() is None

    # And it is only for clusters houston does NOT own: its own kubeconfig still wins.
    monkeypatch.delenv("KUBECONFIG", raising=False)
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "rc"))
    assert k8s.owned_env()["KUBECONFIG"] != str(home / ".kube" / "config")


def test_a_managed_cluster_with_no_nodes_is_not_a_free_one(monkeypatch):
    """Found live, against a real EKS cluster whose node group was being deleted.

    `distribution()` reads a NODE's providerID, which is the most reliable signal there
    is — when there is a node. Zero nodes is not an edge case: it is every cluster
    mid-create, mid-delete, or scaled to nothing. The ledger answered "unknown", which
    did not match BILLABLE, so it priced a running control plane at nothing at all —
    the exact failure this module exists to prevent, rebuilt one layer up.
    """
    from houston.services import cluster

    arn = "arn:aws:eks:us-east-1:533674205877:cluster/houston-probe"
    assert cluster.provider_of(arn, "unknown") == "eks"
    assert cluster.provider_of(arn, "") == "eks"

    # A node that CAN say still wins — the ARN is a fallback, not an override.
    assert cluster.provider_of(arn, "eks") == "eks"
    assert cluster.provider_of("default", "k3s") == "k3s"
    assert cluster.provider_of("default", "unknown") == "unknown"

    # And the pricing follows: a control plane with no nodes still bills.
    priced = cluster.estimate_usd_hr(cluster.provider_of(arn, "unknown"), {})
    assert priced is not None, "an EKS cluster with no nodes was priced at nothing"
    assert priced["usd_hr"] == round(
        cluster.EKS_CONTROL_PLANE_USD_HR + cluster.NAT_GATEWAY_USD_HR, 4)


def test_a_node_costs_its_disk_as_well_as_itself():
    """Found by `eksctl --dry-run`, before any money was spent.

    eksctl gives every node an 80 GB gp3 volume that the node group did not ask for.
    A disk is not an instance TYPE, so `INSTANCE_USD_HR` could not express it and the
    "unpriced types are reported" safeguard could not see it: the cost was not
    underpriced, it was uncounted, and the total read as complete.
    """
    from houston.services import cluster

    disk = (cluster.NODE_VOLUME_GB * cluster.EBS_GP3_USD_GB_MONTH
            / cluster.HOURS_PER_MONTH)
    base = cluster.EKS_CONTROL_PLANE_USD_HR + cluster.NAT_GATEWAY_USD_HR

    one = cluster.estimate_usd_hr("eks", {"t3.large": 1})
    assert one["usd_hr"] == round(
        base + cluster.INSTANCE_USD_HR["t3.large"] + disk, 4)

    # Counted for EVERY node, including one whose TYPE could not be priced — an
    # unrecognised instance still has a volume attached to it.
    mixed = cluster.estimate_usd_hr("eks", {"x9.enormous": 2})
    assert mixed["unpriced"] == {"x9.enormous": 2}
    assert mixed["usd_hr"] == round(base + 2 * disk, 4), \
        "the disks of unpriced nodes were dropped along with their instance cost"


def test_the_ledger_can_reach_houstons_own_cluster_from_a_fresh_home(monkeypatch,
                                                                     tmp_path):
    """A cluster that is up, and reported as not answering.

    `is_ours()` is a NAME compare, so houston decides its own cluster is its own and
    reaches it through its OWN kubeconfig — which a fresh HOUSTON_HOME has not got.
    `ensure_kubeconfig` exists for exactly this and its docstring names the case:
    "With a kind cluster already up and a fresh home, every command failed ... and
    could not self-heal". It was fixed for `up`, and `cluster status` reintroduced it
    by probing without calling it. CLAUDE.md tells anyone writing a script to
    `export HOUSTON_HOME=$(mktemp -d)`, so it is reachable by following our own
    instructions.
    """
    from houston.services import cluster, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    exported: list = []
    monkeypatch.setattr(k8s, "ensure_kubeconfig",
                        lambda plan, emit=None: exported.append(plan.context) or "")
    monkeypatch.setattr(k8s, "contexts", lambda: ([k8s.CONTEXT, "someone-elses"], ""))
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, timeout=None: False)

    cluster.status(context=k8s.CONTEXT)
    assert exported == [k8s.CONTEXT], \
        "houston's own cluster must have its kubeconfig exported before probing"

    # And NOT for a cluster somebody else made: there is nothing to export, and
    # rewriting their kubeconfig is not ours to do.
    exported.clear()
    cluster.status(context="someone-elses")
    assert exported == [], "a cluster houston did not create must be left alone"


def test_more_than_one_cloud_cluster_can_be_remembered(monkeypatch, tmp_path):
    """Two clusters is a name question, not a capacity one.

    `create_cluster` refuses a name that already exists in the region and nothing
    else, and the pointer is keyed on the name — so a second cluster under a second
    name is simply a second pointer, and `doctor` warns about both. Recorded because
    "one owned cloud cluster per home" was written down as a P2 non-goal, and the
    thing that would ENFORCE it does not exist: it is possible, it is just not
    designed for.
    """
    from houston.services import eks

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    eks.remember("support-a", region="us-east-1", account="1")
    eks.remember("support-b", region="eu-west-1", account="1")

    names = sorted(r["name"] for r in eks.remembered())
    assert names == ["support-a", "support-b"]
    assert {r["region"] for r in eks.remembered()} == {"us-east-1", "eu-west-1"}

    # Forgetting one leaves the other.
    eks.forget("support-a")
    assert [r["name"] for r in eks.remembered()] == ["support-b"]


def test_no_call_site_re_implements_which_kubeconfig_to_use():
    """A rule repeated at eight sites is a rule that will be fixed at one of them.

    `owned_env() if is_ours(context) else None` was written out at eight places: once
    in `run()` and once each in apply, helm install, helm upgrade, port-forward, logs,
    exec-in and exec-out. When the kubeconfig resolution was fixed — so that houston's
    view of a kubeconfig stops depending on which kubectl BINARY is installed — the fix
    reached `run()` and none of the other seven. The preflight would pass on an EKS
    context and the first `kubectl apply` would fail on the very context it had just
    found.

    Walked rather than remembered, the same way `ROUTE_ROLES`, `PHASES` and
    `doctor.CHECKS` are: prose saying "always use the helper" is what was there before.
    """

    from houston.services import k8s

    src = source_of(k8s)
    body = src.split("def env_for(", 1)[1].split("\ndef ", 1)[0]

    # The rule appears in env_for -- that is where it belongs -- and nowhere else.
    everywhere = src.count("owned_env() if is_ours")
    inside = body.count("owned_env() if is_ours")
    assert everywhere == inside, (
        f"{everywhere - inside} call site(s) re-implement the kubeconfig rule instead "
        f"of calling env_for(); a fix to it will reach env_for and miss them")

    # And nothing passes a bare None for a context it did not resolve.
    assert "env=owned_env() if is_ours(context) else None" not in src


def test_a_billable_cluster_without_a_domain_warns_but_does_not_refuse(monkeypatch,
                                                                      tmp_path):
    """Warned, not refused, and the difference is the point.

    A refusal would remove the one way to reach a workspace whose ingress is broken —
    which is exactly when somebody needs a port-forward. But on a cluster billing by
    the hour, a port-forward is a poor thing to have paid for: tied to a pod, gone when
    it restarts, one machine at a time, and leaving the cluster's whole reason for
    being remote unused.
    """
    from houston.services import k8s
    from houston.services import lifecycle as lcmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: list = []

    def spy(ev):
        seen.append((ev.level, ev.message))

    def plan(dist):
        monkeypatch.setattr(k8s, "plan_cluster", lambda ctx="": k8s.ClusterPlan(
            context="the-cluster", distribution=dist, create=False))

    # A managed cluster and no name: warned.
    plan("eks")
    seen.clear()
    req = lcmod.CreateReq(version="8.5.1", runtime="kubernetes", context="the-cluster")
    try:
        lcmod._create_kubernetes(req, emit=spy)
    except Exception:  # noqa: BLE001 - it fails later; the warning is what is tested
        pass
    warned = [m for lvl, m in seen if lvl == "warn" and "--domain" in m]
    assert warned, [m for _, m in seen]
    assert "port-forward" in warned[0] and "eks" in warned[0]

    # The same cluster WITH a name: nothing to say.
    seen.clear()
    req = lcmod.CreateReq(version="8.5.1", runtime="kubernetes",
                          context="the-cluster", domain="rc.example.org")
    try:
        lcmod._create_kubernetes(req, emit=spy)
    except Exception:  # noqa: BLE001
        pass
    assert not [m for lvl, m in seen if lvl == "warn" and "--domain" in m]

    # And a local cluster is never warned about — it costs nothing to leave running.
    for local in ("kind", "k3s"):
        plan(local)
        seen.clear()
        req = lcmod.CreateReq(version="8.5.1", runtime="kubernetes",
                              context="the-cluster")
        try:
            lcmod._create_kubernetes(req, emit=spy)
        except Exception:  # noqa: BLE001
            pass
        assert not [m for lvl, m in seen if lvl == "warn" and "--domain" in m], \
            f"{local} is free to leave running; there is nothing to warn about"


def test_locality_was_standing_in_for_consent(monkeypatch):
    """Two guards refused to change a cluster that is not on this machine.

    The reasoning they carry is right and is not about locality: six CRDs and an
    admission webhook "are a change to what a cluster IS, for every workload in it --
    not something to do to somebody else's ON THE WAY TO BOOTING A REPRO". What makes
    that wrong is that nobody asked. `cluster prepare` is somebody asking, and for a
    cluster houston provisioned there is no somebody else to be careful of.

    `up` must never pass it, or the implicit install these guards exist to stop comes
    straight back.
    """
    import inspect

    from houston.services import k8s
    from houston.services import lifecycle as lcmod

    for fn in (k8s.ensure_ingress, k8s.ensure_cert_manager):
        assert "invited" in inspect.signature(fn).parameters, fn.__name__
        assert inspect.signature(fn).parameters["invited"].default is False, \
            f"{fn.__name__} must refuse by default; consent is the exception"

    # Uninvited on a remote cluster: refused, exactly as before.
    monkeypatch.setattr(k8s, "cert_manager_installed", lambda ctx: False)
    monkeypatch.setattr(k8s, "distribution_of", lambda ctx: "eks")
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_cert_manager(context="arn:aws:eks:x", distribution="eks")
    assert "not on this machine" in str(exc.value)

    # `up` never invites -- checked in the source, because a future edit that adds it
    # would restore the exact defect these guards were written for.
    assert "invited=" not in source_of(lcmod), \
        "the implicit create path must never invite an install into somebody's cluster"


def test_prepare_installs_a_storage_class_only_when_none_is_default(monkeypatch,
                                                                    tmp_path):
    """EKS ships `gp2` on the in-tree provisioner and marks nothing default, so the
    addon houston pins at Launchpad's version sits there referenced by nothing and
    every PVC would stay Pending.

    But a cluster that already HAS a default has been set up by somebody, and replacing
    their choice is not this command's business: `up` needs one to exist, and two
    defaults is an error state in Kubernetes anyway.
    """
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    applied: list = []
    monkeypatch.setattr(k8s, "apply",
                        lambda man, **kw: applied.append(man))
    monkeypatch.setattr(k8s, "ensure_ingress", lambda **kw: "traefik")
    monkeypatch.setattr(k8s, "ensure_cert_manager", lambda **kw: None)
    # `prepare` WAITS for the address now — an ELB takes a minute or two to publish
    # one, so asking once made a blank CNAME target the normal outcome of a create.
    monkeypatch.setattr(k8s, "wait_for_loadbalancer",
                        lambda ctx, **kw: ("traefik", "elb.aws"))
    monkeypatch.setattr(k8s, "loadbalancer_state",
                        lambda ctx=None: ("traefik", "elb.aws", 0))

    # Nothing default: install, and with the CSI provisioner rather than the in-tree
    # one the cluster ships.
    # `prepare_cluster` resolves the context now, like every other cluster command --
    # `--context support` is the form the guide teaches and an ARN is what kubectl
    # needs. The double answers the resolver rather than the raw string.
    monkeypatch.setattr(k8s, "assert_context_known", lambda c: (c, ""))
    monkeypatch.setattr(k8s, "storage_classes", lambda ctx: (["gp2"], ""))
    out = eks.prepare_cluster("arn:aws:eks:x")
    assert out["storage_class"] == "gp3"
    assert "ebs.csi.aws.com" in applied[0], "the in-tree provisioner is the one EKS ships"
    assert "is-default-class" in applied[0]
    assert "WaitForFirstConsumer" in applied[0], \
        "binding before the pod lands puts the volume in the wrong availability zone"
    assert out["cname_target"] == "elb.aws"

    # One already default: adopt it and touch nothing.
    applied.clear()
    monkeypatch.setattr(k8s, "storage_classes", lambda ctx: (["gp2", "mine"], "mine"))
    out = eks.prepare_cluster("arn:aws:eks:x")
    assert out["storage_class"] == "mine" and applied == []
    assert "storage class 'mine'" in out["already"]

    # A refused read is not "none default" -- that would install a second default into
    # a cluster whose classes houston could not see.
    monkeypatch.setattr(k8s, "storage_classes", lambda ctx: None)
    with pytest.raises(errors.PreflightError):
        eks.prepare_cluster("arn:aws:eks:x")


def test_naming_a_context_says_kubernetes_without_saying_it_twice(monkeypatch,
                                                                 tmp_path):
    """A context is a Kubernetes word.

    Measured on a first run: `--context <an eks arn>` without `--runtime kubernetes`
    was refused, and the whole command had to be retyped for the half houston could
    have worked out. Somebody who named a cluster has already said where it runs.

    Only from an EXPLICIT context, never from the box default — letting a default
    cluster silently move `up` off Compose would change what an un-flagged command
    means for every workspace on the box.
    """
    from houston import config
    from houston.services import lifecycle as lc
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    assert lc.infer_runtime(lc.CreateReq(version="8.5.1", context="arn:aws:eks:x")) \
        == topology.KUBERNETES
    # An explicit runtime always wins; inference never overrides what was typed.
    assert lc.infer_runtime(lc.CreateReq(version="8.5.1", context="arn:aws:eks:x",
                                         runtime="docker")) == "docker"
    assert lc.infer_runtime(lc.CreateReq(version="8.5.1")) == ""

    # THE BOX DEFAULT MUST NOT INFER. A configured cluster is a convenience for the
    # Kubernetes work somebody already does, not a statement that everything is now
    # Kubernetes.
    config.update_config(
        lambda c: c.__setitem__(config.KUBE_CONTEXT_KEY, "arn:aws:eks:default"))
    assert lc.infer_runtime(lc.CreateReq(version="8.5.1")) == "", \
        "a default cluster must not move an un-flagged `up` off Compose"


def test_creating_a_cluster_makes_it_the_default_and_deleting_it_takes_that_back(
        monkeypatch, tmp_path):
    """houston has just built this cluster and knows its ARN.

    Making the operator read it back out of `aws` and paste it into every later
    command is ceremony houston imposes on itself — and an ARN is the worst possible
    thing to ask somebody to retype.

    The delete has to put it back, or a `kubernetes.context` pointing at a cluster
    that no longer exists makes the next `up` fail on a context that cannot be found,
    which reads as a bug in `up` rather than the consequence of a delete.
    """
    from houston import config
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    arn = "arn:aws:eks:us-east-1:1:cluster/support"
    assert config.default_kube_context() == ""

    _aws_ready(monkeypatch)
    config.update_config(lambda c: c.__setitem__(config.CLOUD_ACCOUNTS_KEY,
                                                 "123456789012"))
    monkeypatch.setattr(eks, "describe_cluster", lambda n, r: k8s.Answer(
        state=k8s.ABSENT) if not eks.__dict__.get("_made") else None)
    # Simplest faithful stand-in: absent before, present with an arn after.
    made = {"yes": False}

    def describe(n, r):
        if made["yes"]:
            return k8s.Answer(state=k8s.PRESENT, doc={"arn": arn})
        return k8s.Answer(state=k8s.ABSENT)

    monkeypatch.setattr(eks, "describe_cluster", describe)
    monkeypatch.setattr(eks, "_stream", lambda *a, **kw: made.__setitem__("yes", True) or 0)
    monkeypatch.setattr(eks, "prepare_cluster", lambda ctx, emit=None: {})
    # A FAITHFUL DOUBLE: `k8s.run` returns a CompletedProcess, never None. The
    # create writes a per-cluster kubeconfig through it and reads `.returncode`
    # to decide whether the file is there to chmod.
    monkeypatch.setattr(k8s, "run", lambda *a, **kw: subprocess.CompletedProcess(
        args=a[0] if a else [], returncode=0, stdout="", stderr=""))

    eks.create_cluster("support", region="us-east-1")
    assert config.default_kube_context() == arn, \
        "the cluster it just built should be the one `up` goes to"

    # And the delete takes it back.
    monkeypatch.setattr(eks, "owns_cluster",
                        lambda n, r: k8s.Answer(state=k8s.PRESENT, doc={"arn": arn}))
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, timeout=None: True)
    monkeypatch.setattr(k8s, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_OK))
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx: [])
    monkeypatch.setattr(eks, "_stream", lambda *a, **kw: 0)
    eks.delete_cluster("support", region="us-east-1")
    assert config.default_kube_context() == "", \
        "a default pointing at a deleted cluster makes the next `up` fail obscurely"


def test_what_was_applied_to_a_cluster_is_written_down(monkeypatch, tmp_path):
    """Six weeks later the cluster is the only evidence and nobody remembers the flags.

    So the document eksctl was handed and the manifests applied afterwards are kept on
    this box. Two properties matter more than the writing itself:

    they survive a FAILED create -- which is precisely when somebody wants to read what
    was submitted, and when a temporary file would have taken the evidence with it;

    and they survive the DELETE. The pointer goes, because `doctor` warns from it and a
    warning must not outlive the cluster; the documents stay, because "what did we run
    in March" has nothing else to read.
    """
    import yaml

    from houston.services import eks

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    kept = eks.keep_manifest("support", "cluster.yaml", yaml.safe_dump(
        eks.cluster_config("support", region="us-east-1")))
    assert kept is not None and kept.is_file()
    assert kept.parent == eks.cluster_dir("support")

    eks.remember("support", region="us-east-1", account="1")
    assert [r["name"] for r in eks.remembered()] == ["support"]

    eks.forget("support")
    assert eks.remembered() == [], "doctor must stop warning about a deleted cluster"
    assert kept.is_file(), "what was built is worth more after the fact than during"

    # An unwritable home is not a reason to refuse a create.
    monkeypatch.setattr(eks.runner, "atomic_write",
                        lambda *a, **kw: (_ for _ in ()).throw(OSError("read-only")))
    assert eks.keep_manifest("support", "x.yaml", "body: 1") is None


def test_the_old_flat_pointer_is_still_read(monkeypatch, tmp_path):
    """A cluster created before manifests were kept must not vanish from `doctor`.

    The pointer moved from `clusters/<name>.json` to `clusters/<name>/cluster.json`,
    and the whole purpose of the warning it feeds is a cluster nobody is thinking about
    any more -- which is exactly the one that would be lost by a layout change.
    """
    import json

    from houston.services import eks

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    old = tmp_path / "clusters"
    old.mkdir(parents=True)
    (old / "legacy.json").write_text(json.dumps(
        {"name": "legacy", "region": "eu-west-1", "account": "1", "provider": "eks"}))

    eks.remember("modern", region="us-east-1", account="1")
    assert sorted(r["name"] for r in eks.remembered()) == ["legacy", "modern"]

    # And forgetting the old-shaped one actually removes it.
    eks.forget("legacy")
    assert [r["name"] for r in eks.remembered()] == ["modern"]


def test_the_ledger_prices_everything_it_puts_on_the_screen(monkeypatch, tmp_path):
    """Counting a thing and not pricing it is the most convincing way to be wrong.

    MEASURED against a live cluster: the report printed "1 LoadBalancer(s) — each one
    is billed on a managed cluster" and then a total that excluded it, along with the
    workspace's own volume. About ten per cent low, arrived at honestly, and with the
    evidence of the omission printed one line above the number.

    The cause was ordering: the estimate was computed beside the node inventory, before
    the load balancers and volumes had been read at all.
    """
    from houston.services import cluster, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    disk = cluster.EBS_GP3_USD_GB_MONTH / cluster.HOURS_PER_MONTH
    # Built from the RAW components, not from an already-rounded subtotal: the
    # implementation sums everything and rounds once, and rounding twice here made the
    # test disagree with correct arithmetic by a hundredth of a cent.
    raw = (cluster.EKS_CONTROL_PLANE_USD_HR + cluster.NAT_GATEWAY_USD_HR
           + cluster.INSTANCE_USD_HR["t3.large"] + cluster.NODE_VOLUME_GB * disk)
    bare = cluster.estimate_usd_hr("eks", {"t3.large": 1})["usd_hr"]
    assert bare == round(raw, 4)

    priced = cluster.estimate_usd_hr("eks", {"t3.large": 1},
                                     loadbalancers=1, volume_gb=8)
    assert priced["usd_hr"] == round(
        raw + cluster.LOADBALANCER_USD_HR + 8 * disk, 4)
    assert not priced["incomplete"]

    # A count that could not be READ is a different answer from one that is zero, and
    # says so -- "incomplete" rather than a quietly smaller number.
    partial = cluster.estimate_usd_hr("eks", {"t3.large": 1},
                                      loadbalancers=None, volume_gb=None)
    assert partial["usd_hr"] == bare
    assert partial["incomplete"] == ["load balancers", "workspace volumes"]

    # ORDERING, end to end: a cluster with a load balancer must price it. This is the
    # structural half of the bug -- the arithmetic was always right, it just ran too
    # early to see its inputs.
    monkeypatch.setattr(k8s, "contexts", lambda: (["c"], ""))
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, timeout=None: True)
    monkeypatch.setattr(k8s, "reach", lambda ctx=None, timeout=None: k8s.Reach(
        status=k8s.REACH_OK))
    monkeypatch.setattr(k8s, "distribution", lambda ctx: "eks")
    monkeypatch.setattr(k8s, "is_ours", lambda ctx: False)
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx: [])
    monkeypatch.setattr(k8s, "operator_installed", lambda ctx: False)
    monkeypatch.setattr(k8s, "monitoring_installed", lambda ctx: False)

    def ask(kind, **kw):
        if kind == "nodes":
            return k8s.Answer(state=k8s.PRESENT, doc={"items": [
                {"metadata": {"labels": {
                    "node.kubernetes.io/instance-type": "t3.large"}}}]})
        if kind == "svc":
            return k8s.Answer(state=k8s.PRESENT,
                              doc={"items": [{"spec": {"type": "LoadBalancer"}}]})
        return k8s.Answer(state=k8s.PRESENT, doc={"items": []})

    monkeypatch.setattr(k8s, "ask_list", ask)
    out = cluster.status(context="c")
    assert out["loadbalancers"] == 1
    assert out["cost"]["usd_hr"] == round(raw + cluster.LOADBALANCER_USD_HR, 4), \
        "the load balancer on the line above must be in the total below it"


def test_a_cluster_says_when_somebody_expected_to_be_finished_with_it():
    """A reminder, and deliberately nothing more.

    Nothing acts on this tag and in particular nothing deletes on it: removing a cloud
    cluster is minutes of destructive work on somebody's AWS account, and a timer is
    the worst possible thing to have decided it. On a shared cluster the namespaces
    may belong to colleagues on machines this box has never seen — the same argument
    the delete guards rest on.
    """
    import datetime as dt

    from houston.services import eks

    today = dt.date(2026, 9, 1)
    assert eks.expiry_date(7, today=today) == "2026-09-08"
    assert eks.expiry_date(0, today=today) == "2026-09-01"

    # `never` is a real answer, not a missing one. A cluster somebody means to keep
    # should be able to say so -- a reminder nobody can turn off is one everybody
    # learns to ignore, including for the clusters that matter.
    assert eks.expiry_date(None, today=today) == ""

    assert eks.days_until("2026-09-08", today=today) == 7
    assert eks.days_until("2026-08-25", today=today) == -7
    assert eks.days_until("", today=today) is None
    assert eks.days_until("not-a-date", today=today) is None

    # The tag rides in the ClusterConfig, so it is set AT creation like ownership --
    # there is no window in which the cluster exists without it.
    doc = eks.cluster_config("c", region="us-east-1", expires="2026-09-08")
    assert doc["metadata"]["tags"] == {
        eks.OWNED_TAG_KEY: eks.OWNED_TAG_VALUE,
        eks.EXPIRY_TAG_KEY: "2026-09-08"}

    # And a cluster with no expiry carries no empty tag -- an absent tag and a tag
    # whose value is "" are different things to anything reading them later.
    assert eks.cluster_config("c", region="us-east-1")["metadata"]["tags"] == {
        eks.OWNED_TAG_KEY: eks.OWNED_TAG_VALUE}


def test_doctor_says_how_far_past_its_date_a_cluster_is(monkeypatch, tmp_path):
    """The sum involved is one somebody has stopped thinking about.

    Read from the local pointer rather than from AWS, which is the whole reason the
    pointer carries it: `doctor` has to be able to say this with no credential and no
    round trip, on the box most likely to have forgotten the cluster.

    Still a warning and never a failure. Nothing here deletes, and a report that fails
    on somebody's spending decision is a report that gets ignored.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pre = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
        "helm": k8s.Tool(name="helm", path="/h", version=(4, 2))})
    monkeypatch.setattr(k8s, "preflight", lambda context="": pre)

    def row_for(expires):
        for f in (tmp_path / "clusters").glob("*/cluster.json"):
            f.unlink()
        eks.remember("c", region="us-east-1", account="1", expires=expires)
        hits = [r for r in doctorsvc.run_checks()["checks"]
                if r["check"] == "kubernetes-cloud-owned"]
        assert len(hits) == 1, hits
        return hits[0]

    past = row_for("2020-01-01")
    assert "PAST the expiry" in past["message"]
    assert past["status"] == "warn", "spending is the operator's decision, not a gate"

    ahead = row_for(eks.expiry_date(30))
    assert "day(s) left" in ahead["message"] and "PAST" not in ahead["message"]

    # No expiry: still warned about -- it is still costing money -- but with nothing
    # said about a date it never had.
    none = row_for("")
    assert "billing" in none["message"]
    assert "expiry" not in none["message"] and "PAST" not in none["message"]


def test_a_cluster_houston_made_is_found_by_asking_it_not_by_asking_kind(monkeypatch):
    """`cluster_exists` was `CLUSTER_NAME in clusters()`, and that probe needs the kind
    BINARY. So uninstalling kind while its cluster was still running made the cluster
    invisible -- node containers holding memory that nothing in houston could see or
    remove, and resolution quietly falling through to a different cluster.
    """
    from houston.services import k8s

    # kind gone, but our kubeconfig still names a cluster that answers.
    _kube_probe_stubs(monkeypatch, kind=False, our_cluster=True, active="default")
    plan = k8s.plan_cluster()
    assert plan.context == k8s.CONTEXT, "our own cluster is still the one to use"
    assert plan.create is False


def test_the_distribution_is_read_from_the_node_not_guessed_from_a_name(monkeypatch):
    """A label for messages, never a branch: `k3s --disable traefik` is a real setup, so
    what a cluster CAN do is probed and what it IS is only named. Signals are the ones
    verified against live clusters.
    """
    import subprocess as sp

    from houston.services import k8s

    def answer(text):
        return lambda argv, timeout=None, own=False: sp.CompletedProcess(argv, 0, text, "")

    monkeypatch.setattr(k8s, "run", answer("k3s://docker-01 v1.36.3+k3s1 k3s docker-01"))
    assert k8s.distribution("default") == "k3s"
    monkeypatch.setattr(k8s, "run", answer(
        "kind://docker/houston-local/houston-local-control-plane v1.36.1  x"))
    assert k8s.distribution("kind-houston-local") == "kind"
    monkeypatch.setattr(k8s, "run", answer("aws:///eu-west-1a/i-0abc v1.31.0-eks-1234 m5"))
    assert k8s.distribution("arn:aws:eks:x") == "eks", \
        "a cloud providerID is the most reliable 'not a disposable cluster' signal"
    monkeypatch.setattr(k8s, "run", answer(" v1.29.0  somenode"))
    assert k8s.distribution("x") == "unknown", "unknown is a fine answer"
    monkeypatch.setattr(k8s, "run",
                        lambda argv, timeout=None, own=False: sp.CompletedProcess(argv, 1, "", "no"))
    assert k8s.distribution("x") == "unknown", "an unreachable cluster is not a failure here"


def test_a_create_refused_for_want_of_a_cluster_leaves_no_record(monkeypatch, tmp_path):
    """Measured on a box with k3s and no kind: the refusal left an `incomplete`
    repro.json, `list` showed it as a workspace, and `used_ports()` went on reserving its
    port -- so a create that could never have succeeded held :3142 until somebody ran
    `down --volumes`.

    The write-ahead record is not the problem and must not be weakened: it exists because
    an interrupted create once left a workspace running and unrecorded. The order was.
    Choosing the cluster only probes, so it belongs above the write.
    """
    from houston.errors import PreflightError

    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **k: None)
    # Only functions that predate this change, so the test drives the OLD code too: no
    # kind and nothing for kubectl to point at is the box that gets refused.
    monkeypatch.setattr(k8s, "which", lambda _t: "")
    monkeypatch.setattr(k8s, "cluster_context", lambda: "")
    monkeypatch.setattr(k8s, "active_context", lambda: "")
    req = lc.CreateReq(version="8.5.1", runtime="kubernetes", name="ghost", offline=True)
    try:
        lc._create_kubernetes(req)
    except PreflightError:
        pass
    else:
        raise AssertionError("it must refuse")
    assert not (tmp_path / "repros" / "ghost").exists(), \
        "a refusal wrote a record for a workspace that was never created"
    assert lc.runner.used_ports() == set(), "and it reserved that workspace's port"


def test_doctor_reports_what_a_cluster_provides_the_same_way_on_every_distribution(
        monkeypatch, tmp_path):
    """The difference between kind and k3s is three capabilities -- ingress, load
    balancer, metrics -- and nothing in the report said so. A reader on a context called
    `default` was not even told it was k3s, and found out that `stats` works there by
    running it.

    All three are `ok` rows on purpose. A capability is a FACT; severity belongs to
    whatever needs it, and an absent ingress controller cannot affect a workspace reached
    by port-forward -- `ensure_ingress` is what adopts or installs one when something asks for a
    hostname. A doctor that warns about a feature you are not using teaches people to
    ignore its warnings.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def report_for(pre):
        monkeypatch.setattr(k8s, "preflight", lambda *a, **k: pre)
        monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/" + t)
        rows = doctor.run_checks()["checks"]
        return {r["check"]: r for r in rows if r["check"].startswith("kubernetes")}

    tools = {n: k8s.Tool(name=n, path="/usr/bin/" + n, version=(9, 9))
             for n in ("kubectl", "helm", "kind")}
    k3s = report_for(k8s.Preflight(
        tools=tools, cluster_reachable=True, context="default",
        provider=k8s.PROVIDER_EXTERNAL, distribution="k3s", node_count=1,
        architectures=["amd64"], default_storage_class="local-path",
        ingress_classes=["traefik"], metrics=True,
        loadbalancer="traefik has 172.16.0.2"))
    assert "k3s, 1 node, amd64" in k3s["kubernetes-cluster"]["message"]
    assert "traefik" in k3s["kubernetes-ingress"]["message"]
    assert "172.16.0.2" in k3s["kubernetes-loadbalancer"]["message"]
    assert "`houston stats` works here" in k3s["kubernetes-metrics"]["message"]
    assert all(k3s[c]["status"] == "ok" for c in
               ("kubernetes-ingress", "kubernetes-loadbalancer", "kubernetes-metrics"))

    kind = report_for(k8s.Preflight(
        tools=tools, cluster_reachable=True, cluster_exists=True, context=k8s.CONTEXT,
        provider=k8s.PROVIDER_KIND, distribution="kind", node_count=1,
        architectures=["amd64"], default_storage_class="standard"))
    assert "kind, 1 node, amd64" in kind["kubernetes-cluster"]["message"]
    # The same three subjects, answered the other way and still not a warning.
    assert "none installed" in kind["kubernetes-ingress"]["message"]
    assert "not confirmed" in kind["kubernetes-loadbalancer"]["message"]
    assert "refuses" in kind["kubernetes-metrics"]["message"]
    assert all(kind[c]["status"] == "ok" for c in
               ("kubernetes-ingress", "kubernetes-loadbalancer", "kubernetes-metrics"))
    # Storage is reported when it is THERE too, not only when it is missing.
    assert "standard (default)" in kind["kubernetes-storage"]["message"]


def test_the_mongodb_operator_goes_with_the_last_workspace_but_not_before(monkeypatch):
    """`--volumes` means delete everything, and an operator left running afterwards is
    the wrong answer -- but three things about it are shared, and the ORDER is what makes
    removing it safe rather than destructive.

    The reference count is not bureaucracy: with a second workspace still holding a
    `MongoDBCommunity`, removing the operator leaves its finalizer with nothing to clear
    it, so a later `down --volumes` on THAT workspace hangs in Terminating forever. It is
    the identical failure `remove_monitoring` recorded for a GrafanaFolder.
    """
    import subprocess as sp

    from houston.services import k8s

    calls = []

    def fake(mongodbs, installed=True, rc=0):
        def run(argv, timeout=None, own=False, env=None):
            calls.append(" ".join(argv))
            j = " ".join(argv)
            if "helm list" in j:
                return sp.CompletedProcess(
                    argv, 0, _helm_list(k8s.OPERATOR_RELEASE) if installed else "[]", "")
            if "get mongodbcommunity" in j:
                return sp.CompletedProcess(argv, 0, "\n".join(mongodbs), "")
            return sp.CompletedProcess(argv, rc, "", "boom" if rc else "")
        return run

    # Nothing left that needs it: the operator goes.
    calls.clear()
    monkeypatch.setattr(k8s, "run", fake([]))
    assert k8s.remove_operator(context="default") is True
    assert any("helm uninstall " + k8s.OPERATOR_RELEASE in c for c in calls), calls
    # The CRD is never touched: deleting it would delete every MongoDBCommunity in the
    # cluster, i.e. every other workspace's database.
    assert not any("delete crd" in c for c in calls), calls
    # Nor the namespace, which is shared with the monitoring stack.
    assert not any("delete namespace" in c for c in calls), calls

    # Another workspace still has one: left alone, and it says whose.
    calls.clear()
    events = []
    monkeypatch.setattr(k8s, "run", fake(["houston-other"]))
    assert k8s.remove_operator(context="default", emit=events.append) is False
    assert not any("helm uninstall" in c for c in calls), calls
    assert any("still used by other" in e.message for e in events), \
        [e.message for e in events]

    # A cluster that never had it is not an error and says nothing.
    calls.clear()
    monkeypatch.setattr(k8s, "run", fake([], installed=False))
    assert k8s.remove_operator(context="default") is False
    assert not any("helm uninstall" in c for c in calls), calls


def test_removing_the_operator_never_fails_a_teardown(monkeypatch):
    """The workspace is already gone by the time this runs, and the next
    `--mongo-operator` is an `upgrade --install` that repairs it. A teardown that reports
    failure for wreckage it cannot help would leave a user believing their workspace is
    still there."""
    import subprocess as sp

    from houston.services import k8s

    def run(argv, timeout=None, own=False, env=None):
        j = " ".join(argv)
        if "helm list" in j:
            return sp.CompletedProcess(argv, 0, _helm_list(k8s.OPERATOR_RELEASE), "")
        if "get mongodbcommunity" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        return sp.CompletedProcess(argv, 1, "", "uninstall exploded")

    monkeypatch.setattr(k8s, "run", run)
    events = []
    assert k8s.remove_operator(context="default", emit=events.append) is False
    assert any("could not be uninstalled" in e.message for e in events)


def test_down_volumes_takes_the_monitoring_stack_with_it(monkeypatch, tmp_path):
    """Reported from a live k3s box: after `down --volumes` the monitoring stack was
    still running -- ten pods and ~840 MB, wanted by nobody, because the workspace that
    asked for it had been destroyed.

    `remove_monitoring` could always do this. It was only ever called by `monitor --off`,
    so the teardown walked past the most expensive thing houston installs. On Compose
    there was nothing to fix: the stack is part of the workspace's own compose project
    and goes down with it.
    """
    import json as _json

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    (tmp_path / "repros" / "mon").mkdir(parents=True)
    (tmp_path / "repros" / "mon" / "repro.json").write_text(_json.dumps({
        "name": "mon", "project": "p", "rc_version": "8.5.1", "rc_image": "i",
        "mongo_tag": "8.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001, "version_source": "x",
        "extra": {"runtime": "kubernetes", "namespace": "houston-mon",
                  "context": "default", "monitoring": True,
                  "grafana_pid": 4242}}))
    monkeypatch.setattr(lc, "require_docker", lambda: None)
    monkeypatch.setattr(k8s, "delete_namespace", lambda *a, **k: True)
    called = {}
    monkeypatch.setattr(k8s, "remove_operator",
                        lambda **kw: called.setdefault("operator", kw) is None)
    monkeypatch.setattr(k8s, "remove_monitoring",
                        lambda **kw: called.setdefault("monitoring", kw) is None)

    stopped = []
    monkeypatch.setattr(lc, "_stop_port_forward",
                        lambda pid, **kw: stopped.append(pid))
    lc.teardown("mon", volumes=True, confirm=True)
    assert "monitoring" in called, "the monitoring stack was left running"
    # And the Grafana forward, which targets a deployment in `houston-system` and so
    # SURVIVES the workspace: it went on holding :5050 after the workspace was destroyed,
    # and the next `up --monitor` was refused for a port held by a corpse.
    assert 4242 in stopped, "the Grafana port-forward was left holding its host port"
    # The namespace being destroyed must not be counted as still wanting it: the count
    # reads a label on the namespace, and a namespace still Terminating is still listed
    # and still labelled.
    assert called["monitoring"]["excluding"] == "houston-mon"
    assert called["operator"]["excluding"] == "houston-mon"

    # A plain `down` keeps the namespace and the data, so the workspace can come back and
    # the stack it wants must stay with it.
    called.clear()
    (tmp_path / "repros" / "mon").mkdir(parents=True, exist_ok=True)
    (tmp_path / "repros" / "mon" / "repro.json").write_text(_json.dumps({
        "name": "mon", "project": "p", "rc_version": "8.5.1", "rc_image": "i",
        "mongo_tag": "8.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001, "version_source": "x",
        "extra": {"runtime": "kubernetes", "namespace": "houston-mon",
                  "context": "default", "monitoring": True}}))
    stopped.clear()
    lc.teardown("mon", volumes=False, confirm=True)
    assert called == {}, "a plain `down` must leave both alone — the workspace comes back"
    assert 4242 not in stopped, \
        "and Grafana stays reachable for a workspace that is coming back"
    assert topology.KUBERNETES  # the branch under test is the Kubernetes one


def test_the_workspace_being_destroyed_does_not_vote_to_keep_the_stack(monkeypatch):
    """The reference count reads a label on the workspace namespace, and
    `workspace_namespaces` does not filter by phase -- a namespace still Terminating is
    still listed and still labelled. Without excluding it, a teardown asking "does
    anyone else still want this?" is answered yes by the workspace it is deleting.
    """
    import subprocess as sp

    from houston.services import k8s

    def run(argv, timeout=None, own=False, env=None):
        j = " ".join(argv)
        if "helm list" in j:
            return sp.CompletedProcess(argv, 0, _helm_list(k8s.MONITORING_RELEASE), "")
        if "get namespace" in j and "-l" in j:
            # `-o json`: `workspace_namespaces` goes through `ask_list` now, because it
            # has to be able to say "I could not ask" -- `-o name` cannot carry that,
            # and a stub answering the old shape leaves the destructive callers
            # untested against the very case this is about.
            return sp.CompletedProcess(argv, 0, json.dumps({"items": [{"metadata": {"name": "houston-going"}}]}), "")
        if "get namespace houston-going" in j:
            # `monitoring_wanted` reads the namespace DOCUMENT now, not a jsonpath.
            # It has to tell "this workspace does not want monitoring" from "I could
            # not read the label" -- and it is the INNER test of the reference count,
            # so answering the second as the first uninstalls the shared stack out
            # from under a workspace that is using it. An empty jsonpath result also
            # cannot say whether the LABEL is absent or the NAMESPACE is.
            return sp.CompletedProcess(argv, 0, json.dumps({
                "metadata": {"name": "houston-going",
                             "labels": {k8s.MONITORING_LABEL: "true"}}}), "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s, "run", run)
    events = []
    # Not excluded: the dying workspace keeps its own stack alive forever.
    assert k8s.remove_monitoring(context="default", emit=events.append) is False
    assert any("still used by going" in e.message for e in events)
    # Excluded: nothing else wants it, so it goes.
    events.clear()
    assert k8s.remove_monitoring(context="default", excluding="houston-going",
                                 emit=events.append) is True


def test_detaching_monitoring_that_was_never_attached_says_nothing_alarming(monkeypatch):
    """Measured live: `monitor --off` on a workspace whose attach had failed ran the
    uninstall anyway, helm answered "Release not loaded: monitoring: release: not found",
    and the fallback announced that "the monitoring stack needed its finalizers cleared by
    hand" -- a frightening sentence about wreckage that did not exist.

    Nothing installed is nothing to report, which is also what `remove_operator` already
    did; the two are symmetric now.
    """
    import subprocess as sp

    from houston.services import k8s

    calls = []

    def run(argv, timeout=None, own=False, env=None):
        calls.append(" ".join(argv))
        # `helm list -o json` answers with an empty array: nothing installed here.
        return sp.CompletedProcess(argv, 0, "[]", "")

    monkeypatch.setattr(k8s, "run", run)
    events = []
    assert k8s.remove_monitoring(context="default", emit=events.append) is False
    assert not any("uninstall" in c for c in calls), calls
    assert not any("finalizer" in e.message for e in events), [e.message for e in events]


def test_prune_gives_back_the_cluster_it_created(monkeypatch, tmp_path):
    """Measured live: with every workspace gone, `prune` said "Nothing to prune" and left
    houston's own kind control plane running -- 514 MiB holding nothing. Both the README
    and the agent skill said `prune` reclaims it; `delete_cluster` had exactly one caller,
    a failed create's rollback, so the documented promise was never kept and the memory
    the tool tells you to worry about was the memory it left behind.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "prunable", lambda: [])
    monkeypatch.setattr(lc, "orphan_namespaces", lambda *a, **k: [])
    deleted = []
    monkeypatch.setattr(k8s, "delete_cluster",
                        lambda **kw: deleted.append(kw) is None or True)

    res = lc.prune(confirm=True)
    assert res["cluster"] is True, "the cluster was left running with nothing in it"
    assert deleted, "delete_cluster was never called"

    # And after a prune that DID remove workspaces, the same offer applies.
    deleted.clear()
    monkeypatch.setattr(lc, "prunable", lambda: [])
    res = lc.prune(confirm=True, orphans=False)
    assert res["cluster"] is True


def test_reclaiming_the_cluster_can_only_ever_reach_our_own(monkeypatch, tmp_path):
    """The teardown asymmetry the runtime split is built on: what houston created it may
    destroy, what you supplied it only borrows a namespace in. `delete_cluster` takes no
    parameter, needs the `kind` binary, and refuses while a workspace namespace remains --
    so an adopted k3s cannot be reached from a prune at all. And a refusal is not a failed
    prune: the workspaces are already gone, which is what was asked for.
    """
    from houston.errors import ConflictError
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "prunable", lambda: [])
    monkeypatch.setattr(lc, "orphan_namespaces", lambda *a, **k: [])

    # No kind binary: there is nothing of ours to give back.
    monkeypatch.setattr(k8s, "which", lambda _t: "")
    assert k8s.cluster_reclaimable() is False

    # A cluster that still holds a workspace refuses, and the prune still succeeds.
    def refuse(**_kw):
        raise ConflictError("cluster houston-local still holds 1 workspace namespace(s)")
    monkeypatch.setattr(k8s, "delete_cluster", refuse)
    events = []
    res = lc.prune(confirm=True, emit=events.append)
    assert res["cluster"] is False
    assert any("left alone" in e.message for e in events), [e.message for e in events]


def test_an_existing_cluster_is_never_planned_as_one_to_create(monkeypatch):
    """Caught by a live sweep, in the resolver itself.

    An earlier version decided `create` from whether THIS HOME's kubeconfig named a
    reachable context. A fresh HOUSTON_HOME facing a cluster that already exists -- a
    wiped state directory, a second user on the box, a kubeconfig cleared by a previous
    `prune` -- therefore planned to create one. Two consequences, the second serious:
    `check_capacity` charged 600 MB for a control plane already running, and the failed
    create's rollback was told the cluster was its to delete, so a create that died would
    have taken a cluster it did not make.

    `create` follows the CLUSTER now. `ensure_cluster` already re-exports the kubeconfig
    when it finds a cluster its config does not know about, which is why the context is
    knowable before it has been read.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/kind" if t == "kind" else "")
    monkeypatch.setattr(k8s, "cluster_context", lambda: "")       # this home knows nothing
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None: False)

    monkeypatch.setattr(k8s, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    plan = k8s.plan_cluster()
    assert plan.create is False, "an existing cluster must never be planned as a create"
    assert plan.context == k8s.CONTEXT

    monkeypatch.setattr(k8s, "clusters", lambda: ([], ""))
    assert k8s.plan_cluster().create is True, "and a missing one still is"


def _k8s_svc_json(*services):
    """A `kubectl get svc -A -o json` document, as kubectl really shapes it."""
    import json
    return json.dumps({"items": list(services)})


def _lb(name, ns, addr, ports, kind="LoadBalancer"):
    return {"metadata": {"name": name, "namespace": ns},
            "spec": {"type": kind, "ports": [{"port": p} for p in ports]},
            "status": {"loadBalancer": {"ingress": [{"ip": addr}] if addr else []}}}


def test_host_port_claim_reads_the_ports_the_service_actually_asks_for(monkeypatch):
    """The ports are the diagnosis, and nothing read them.

    A cluster holding :443 breaks serving and the TLS-ALPN challenge; one holding
    :80 breaks HTTP-01 and the redirect. The detection only ever asked whether a
    LoadBalancer had a local address, so it reported ":443" whatever it found --
    including on a box configured for `acme.challenge http`, where :80 was the port
    that mattered and the report named the wrong one.
    """
    import subprocess

    from houston.services import k8s

    doc = _k8s_svc_json(
        # Skipped: a ClusterIP takes no host port however it is addressed.
        _lb("kubernetes", "default", "10.43.0.1", [443], kind="ClusterIP"),
        # Skipped: a LoadBalancer nobody answered for holds nothing.
        _lb("pending", "apps", "", [80]),
        # Skipped: an address this host does not hold is somebody else's problem.
        _lb("elsewhere", "apps", "203.0.113.9", [80, 443]),
        _lb("traefik", "kube-system", "172.16.0.2", [80, 443]),
    )
    monkeypatch.setattr(k8s, "run", lambda *a, **k: subprocess.CompletedProcess(
        args=a, returncode=0, stdout=doc, stderr=""))
    monkeypatch.setattr(k8s, "is_local_address", lambda ip: ip == "172.16.0.2")

    claim = k8s.host_port_claim("default")
    assert claim is not None, "the local LoadBalancer must be found"
    assert claim.ports == [80, 443], claim
    assert claim.service == "kube-system/traefik", "say WHICH service, so it can be patched"
    assert claim.address == "172.16.0.2"

    # Only :80. This is the case the old check called ":443".
    only80 = _k8s_svc_json(_lb("traefik", "kube-system", "172.16.0.2", [80]))
    monkeypatch.setattr(k8s, "run", lambda *a, **k: subprocess.CompletedProcess(
        args=a, returncode=0, stdout=only80, stderr=""))
    assert k8s.host_port_claim("default").ports == [80]

    # A port set that does not overlap the edge's is not a conflict at all.
    monkeypatch.setattr(k8s, "host_port_claim",
                        lambda ctx, **kw: k8s.PortClaim(context=ctx, service="a/b",
                                                        address="172.16.0.2", ports=[8080]))
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, **kw: True)
    monkeypatch.setattr(k8s.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(k8s, "active_context", lambda: "default")
    assert k8s.port_claiming_cluster() is None, "8080 is not the edge's port"


def test_the_edge_port_row_names_the_port_it_found_not_always_443(monkeypatch, tmp_path):
    """A cluster holding only :80 was reported as holding :443.

    That is not cosmetic: the reader is being told which challenge cannot complete
    and which port to give back. On the box this came from, `acme.challenge` was
    `http` -- so :80 was the whole problem and the report pointed at the other port.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pre = k8s.Preflight(tools={
        n: k8s.Tool(name=n, path=f"/usr/bin/{n}", version=(9, 9, 9), raw="v9.9.9")
        for n in ("kubectl", "helm")})
    pre.context = "default"
    pre.cluster_reachable = False
    monkeypatch.setattr(k8s, "preflight", lambda *a, **k: pre)
    monkeypatch.setattr(k8s, "active_context", lambda: "default")
    monkeypatch.setattr(k8s, "reachable", lambda ctx=None, **kw: True)
    monkeypatch.setattr(k8s.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(k8s, "host_port_claim",
                        lambda ctx, **kw: k8s.PortClaim(
                            context=ctx, service="kube-system/traefik",
                            address="172.16.0.2", ports=[80]))

    from houston.services import edge as edgesvc
    monkeypatch.setattr(edgesvc, "installed", lambda: True)
    monkeypatch.setattr(edgesvc, "registered", lambda: ["w1"])
    monkeypatch.setattr(edgesvc, "current", lambda: None)

    hit = [r for r in doctor.run_checks()["checks"]
           if r.get("check") == "kubernetes-edge-port"]
    assert hit, "a cluster holding :80 is still a cluster holding the edge's port"
    msg = hit[0]["message"]
    assert ":80" in msg, msg
    assert ":443" not in msg, "it does not hold :443, and saying so sends the reader wrong"
    assert "http-01" in msg, "name the challenge that cannot complete"
    # The patch has to name the service that was found, not a guessed one.
    assert "patch svc traefik" in msg, msg
    # The recurrence is the point: the patch is undone by the next k3s install.
    assert "--disable servicelb" in msg, msg


def _idp_meta(preset: str = "oidc"):
    from houston.services import postready
    return postready.runner.Metadata(
        name="w", project="p", rc_version="8.5.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset=preset, root_url="http://localhost:3001",
        host_port=3001, version_source="t")


def test_an_oidc_provider_that_did_not_configure_is_reported_as_a_failure(monkeypatch):
    """The oidc preset's only self-config action could not be reported as failed.

    `run_post_ready` collects a failure on an explicit False, and this handler
    returned None on EVERY path -- so a workspace whose OAuth provider could not be
    created printed one warning, was left out of the "only partly configured"
    summary that exists for exactly this, and exited 0.
    """
    from houston.services import postready

    monkeypatch.setattr(postready.rcapi, "add_oauth_service", lambda *a, **kw: False)
    said: list = []
    m = _idp_meta()
    m.extra["post_ready"] = [{"action": "create_oauth_provider", "name": "Keycloak",
                              "settings": {"a": 1}}]
    failed = postready.run_post_ready(m, object(), lambda e: said.append(e.message))
    assert failed == ["create_oauth_provider"], failed
    joined = " ".join(said)
    assert "partly configured" in joined, joined


def test_a_provider_created_without_its_settings_is_not_a_success(monkeypatch):
    """Creating the provider is not the same as the provider working.

    The settings carry the realm URL, the client id and the secret. Every
    `set_setting` result was discarded, so a provider created with none of them
    reported "login button registered" -- and the button really was registered,
    pointing at nothing. That is what a support engineer sees as "I click the OIDC
    button and the page is blank".
    """
    from houston.services import postready

    monkeypatch.setattr(postready.rcapi, "add_oauth_service", lambda *a, **kw: True)
    monkeypatch.setattr(postready.time, "sleep", lambda s: None)
    # The url is the one that matters, and it is the one that refuses.
    monkeypatch.setattr(postready.rcapi, "set_setting",
                        lambda url, auth, pw, sid, val: "-url" not in sid)
    said: list = []
    settings = {"Accounts_OAuth_Custom-Keycloak": True,
                "Accounts_OAuth_Custom-Keycloak-url": "http://keycloak:8085/realms/x"}
    m = _idp_meta()
    m.extra["post_ready"] = [{"action": "create_oauth_provider", "name": "Keycloak",
                              "settings": settings}]
    failed = postready.run_post_ready(m, object(), lambda e: said.append(e.message))
    assert failed == ["create_oauth_provider"], failed
    joined = " ".join(said)
    assert "-url" in joined, "name the setting that did not apply"
    assert "lead nowhere" in joined, joined
    # And the happy path stays a success, or the fix would just refuse everything.
    monkeypatch.setattr(postready.rcapi, "set_setting", lambda *a, **kw: True)
    said.clear()
    assert postready.run_post_ready(m, object(), lambda e: said.append(e.message)) == []


def test_every_post_ready_handler_reports_a_boolean(monkeypatch):
    """The collection reads `is False`, so a handler that returns None opts itself
    out of it silently. Two did, and one of them was the oidc preset's only action.

    Enforced on the signatures rather than by calling them: a handler added later
    with `-> None` is the same bug again, and nothing else would catch it.
    """
    import inspect

    from houston.services import postready

    for name, fn in postready._POST_READY_ACTIONS.items():
        ret = inspect.signature(fn).return_annotation
        assert ret == "bool", f"{name} is annotated {ret!r}, not bool"
        src = source_of(fn)
        assert "return False" in src, f"{name} has no failure path to report"
        assert "return True" in src, f"{name} never reports success"


def test_the_idp_host_is_taken_from_the_url_the_caller_already_gave():
    """`--root-url` and `--domain` are the caller saying "people will type this".

    The saml/oidc presets otherwise address their IdP as this machine, so a
    workspace created with a public URL shipped SSO that pointed at the visitor's own
    laptop -- and the only clue was a login page the browser bounced back to. Nothing
    had to be guessed: the address was on the request all along.
    """
    from houston.services import lifecycle as lc

    # `--bind` throughout: a host is only derived when the ports are published
    # somewhere it could answer. See
    # test_a_browser_host_is_only_derived_when_something_could_reach_it for why
    # deriving under the default loopback bind makes things worse rather than better.
    said: list = []
    req = lc.CreateReq(version="8.5.1", name="n", preset="saml", bind="0.0.0.0",
                       root_url="https://rc.example.com")
    lc._derive_idp_host(req, lambda e: said.append(e.message))
    assert req.params["idp_host"] == "rc.example.com", req.params
    assert "rc.example.com" in " ".join(said), "say it, rather than doing it silently"

    # A domain is the same statement in a different flag.
    dom = lc.CreateReq(version="8.5.1", name="n", preset="oidc", bind="0.0.0.0",
                       domain="sso.example.com")
    lc._derive_idp_host(dom)
    assert dom.params["idp_host"] == "sso.example.com", dom.params

    # Explicit always wins.
    mine = lc.CreateReq(version="8.5.1", name="n", preset="saml", bind="0.0.0.0",
                        root_url="https://rc.example.com", params={"idp_host": "other"})
    lc._derive_idp_host(mine)
    assert mine.params["idp_host"] == "other", mine.params

    # Nothing is invented for a plain local workspace, or for a preset with no IdP.
    for req in (lc.CreateReq(version="8.5.1", name="n", preset="saml"),
                lc.CreateReq(version="8.5.1", name="n", preset="saml", bind="0.0.0.0",
                             root_url="http://localhost:3001"),
                lc.CreateReq(version="8.5.1", name="n", preset="ldap", bind="0.0.0.0",
                             root_url="https://rc.example.com")):
        lc._derive_idp_host(req)
        assert not (req.params or {}).get("idp_host"), req.params


def test_the_idp_host_is_derived_on_kubernetes_too(tmp_path, monkeypatch):
    """It was derived below the runtime dispatch, so it was derived on Compose and
    not at all on Kubernetes.

    That is the defect the derivation exists to fix, surviving inside the runtime
    nobody was testing -- exactly the shape of the `doctor`/`plan_cluster` split that
    named one cluster while `up` built another. Both runtimes resolve the preset from
    `req.params`, so one call site above the fork covers both by construction, and
    this test is on the call site rather than on either branch.
    """
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: dict = {}

    def _fake_k8s(req, emit=None, **kw):
        seen["params"] = dict(req.params or {})
        return {"ok": True}

    monkeypatch.setattr(lc, "_create_kubernetes", _fake_k8s)
    req = lc.CreateReq(version="8.5.1", name="k", preset="oidc", runtime="kubernetes",
                       bind="0.0.0.0", root_url="http://box.example.com:3007")
    lc._create_repro_locked(req)
    assert seen["params"].get("idp_host") == "box.example.com", seen

    # `--domain` is the other way a caller says it, but this runtime refuses that
    # flag outright (it needs the Ingress `--https` needs), so `--root-url` is the
    # only route in here. Asserted for saml as well as oidc: they take the same param
    # and it would be easy to wire one.
    seen.clear()
    lc._create_repro_locked(lc.CreateReq(version="8.5.1", name="k2", preset="saml",
                                         runtime="kubernetes", bind="0.0.0.0",
                                         root_url="http://box.example.com:3007"))
    assert seen["params"].get("idp_host") == "box.example.com", seen

    # Nothing invented for a plain Kubernetes workspace.
    seen.clear()
    lc._create_repro_locked(lc.CreateReq(version="8.5.1", name="k3", preset="oidc",
                                         runtime="kubernetes"))
    assert not seen["params"].get("idp_host"), seen


def test_a_shared_workspace_says_which_host_its_preset_pages_are_on(tmp_path, monkeypatch):
    """Four presets print browser URLs that say `localhost` — phpLDAPadmin, MinIO's
    console, Mailpit's inbox, the livechat demo page.

    All were written when the browser was assumed to be on the docker host. On a
    workspace bound wide or given a public URL it is not, and `localhost` then names
    the reader's own machine: the same mistake that made the saml and oidc buttons
    fail silently, in prose instead of a setting. A preset builder is never given the
    bind host or the advertised URL, so the correction belongs to the record.
    """
    from houston import runner
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def meta(**extra):
        m = runner.Metadata(name="w", project="p", rc_version="8.5.1", rc_image="i",
                            mongo_tag="8.0", mongo_flavor="official", preset="ldap",
                            root_url="http://localhost:3007", host_port=3007,
                            version_source="t")
        m.extra.update(extra)
        return m

    shared = lc.note_groups_of(meta(
        sidecar_ports=[8082], bind_host="0.0.0.0",
        advertised_url="http://box.example.com:3007"))
    body = " ".join(l for g in shared for l in (g.get("body") or []))
    assert "box.example.com:8082" in body, body
    assert "localhost" in body, "name the thing being corrected, not just the fix"

    # Bound wide with no URL given: the host is unknown, so it is not invented.
    wide = lc.note_groups_of(meta(sidecar_ports=[8082], bind_host="0.0.0.0"))
    assert "<this-box>:8082" in " ".join(
        l for g in wide for l in (g.get("body") or [])), wide

    def titles(groups):
        return [g.get("title") for g in groups]

    # An ordinary laptop workspace gains nothing: localhost really is localhost.
    assert "Reaching this preset's own pages" not in titles(
        lc.note_groups_of(meta(sidecar_ports=[8082], bind_host="127.0.0.1")))
    # And a preset with no pages of its own has nothing to correct.
    assert "Reaching this preset's own pages" not in titles(
        lc.note_groups_of(meta(bind_host="0.0.0.0")))

    # THE CORRECTION MUST NOT DESCRIBE TEXT THAT IS NOT THERE. A `saml` workspace with
    # a derived `idp_host` already prints the real host in every line, and the first
    # version of this told its reader "the URLs above say localhost" about notes that
    # said no such thing. Keyed on the notes, so it stays silent here.
    saml = runner.Metadata(name="s", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="saml",
                           root_url="http://localhost:3007", host_port=3007,
                           version_source="t")
    saml.extra.update({"sidecar_ports": [8081], "bind_host": "0.0.0.0",
                       "advertised_url": "http://box.example.com:3007",
                       "params": {"idp_host": "box.example.com"}})
    groups = lc.note_groups_of(saml)
    assert "Reaching this preset's own pages" not in titles(groups), titles(groups)
    assert not any("localhost" in l for g in groups
                   for l in (g.get("body") or [])), groups


def test_a_browser_host_is_only_derived_when_something_could_reach_it(tmp_path,
                                                                     monkeypatch):
    """Deriving a host whose port is on loopback makes things WORSE, not better.

    OIDC's url serves the browser AND Rocket.Chat's own backend. Moving it off compose
    DNS -- which always worked -- onto the host's address breaks the backend leg too
    unless the ports are published somewhere a container can reach: measured, a port
    published on 127.0.0.1 is unreachable from a container by the host's address
    (connect fails) and reachable when published on 0.0.0.0 (200). `up --preset oidc
    --domain rc.example.com` is the plausible invocation that hits it, so the
    derivation is gated on the bind and the un-derivable states are reported instead.
    """
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def derived(**kw):
        req = lc.CreateReq(version="8.5.1", name="n", **kw)
        lc._derive_idp_host(req)
        return (req.params or {}).get("idp_host")

    # Nothing to derive from, or nothing that could answer: left alone.
    assert derived(preset="saml") is None
    assert derived(preset="oidc", root_url="http://172.16.0.2:3013") is None, \
        "loopback bind — the derived host would be unreachable from RC itself"
    assert derived(preset="oidc", domain="rc.example.com") is None, \
        "same, and this is the invocation somebody would actually type"
    assert derived(preset="oidc", root_url="http://localhost:3001") is None

    # A bind that can carry it: derived.
    assert derived(preset="oidc", root_url="http://172.16.0.2:3013",
                   bind="0.0.0.0") == "172.16.0.2"
    assert derived(preset="saml", domain="rc.example.com",
                   bind="0.0.0.0") == "rc.example.com"

    # A configured bind counts the same as the flag, or the two would disagree about
    # the same workspace.
    from houston import config
    cfg = config.load_config()
    cfg["bind_host"] = "0.0.0.0"
    config.save_config(cfg)
    assert derived(preset="oidc", root_url="http://172.16.0.2:3013") == "172.16.0.2"


def test_the_requested_bind_is_read_in_one_place():
    """The derivation gates on the bind and the create publishes on it. Two spellings
    of `req.bind or cfg or default` is how they come to disagree about one workspace --
    and the disagreement would be silent, because each is right on its own."""

    from houston.services import lifecycle as lc

    src = source_of(lc._create_repro_locked)
    assert "_requested_bind_host(req)" in src, src[:200]
    assert 'req.bind or cfg.get("bind_host")' not in src, \
        "the bind expression was inlined again; call _requested_bind_host"


def test_the_engine_gate_asks_for_the_engine_the_workspace_actually_runs_on(
        tmp_path, monkeypatch):
    """`require_docker()` ran before anything looked at the runtime.

    So on a host with no Docker — the documented adopt-an-existing-cluster setup —
    `upgrade`, `rollback`, `ready`, `logs`, `token`, `api`, `pat`, `seed`,
    `config-import` and `down` all refused a healthy Kubernetes workspace with
    "Docker isn't running". `teardown` is the sharpest: it dispatches on the runtime
    *inside* itself, under a comment about a workspace that could be created and
    never removed, and the gate three lines above defeated that dispatch.

    `backup.py`, `monitor.py` and `envvars.py` already got this right and said so in
    comments. Nobody generalised it, so each new call site started from the Compose
    assumption again.
    """
    import shutil as _shutil

    from houston.errors import DockerError, PreflightError
    from houston.services import lifecycle as lc, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # Docker is NOT available, which is the whole point.
    monkeypatch.setattr(lc.runner, "docker_available", lambda **k: False)

    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    monkeypatch.setattr(_shutil, "which", lambda n: f"/usr/bin/{n}")
    lc.require_engine("k")          # must not raise: Docker is irrelevant here

    # A Compose workspace still needs Docker, or the gate would protect nothing.
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.DOCKER)
    with pytest.raises(DockerError):
        lc.require_engine("c")

    # And a Kubernetes workspace still needs kubectl — said here rather than failing
    # one layer down in a subprocess whose "command not found" names nothing.
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    monkeypatch.setattr(_shutil, "which", lambda n: None)
    with pytest.raises(PreflightError) as caught:
        lc.require_engine("k")
    assert "kubectl" in str(caught.value)


def test_upgrade_reaches_a_kubernetes_workspace_with_no_docker_on_the_box(
        tmp_path, monkeypatch):
    """The reproduction from the review, at the service layer.

    `require_running` called `require_docker()` before resolving the name, so it
    could not tell a Kubernetes workspace from a Compose one when it mattered most.
    """
    import shutil as _shutil

    from houston.services import k8s, lifecycle as lc, topology, upgrade

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner_meta = _idp_meta("default")
    runner_meta.extra["runtime"] = "kubernetes"
    monkeypatch.setattr(upgrade.runner, "read_meta", lambda n: meta)
    monkeypatch.setattr(lc, "resolve_name", lambda n, actor="": "k")
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    monkeypatch.setattr(_shutil, "which", lambda n: f"/usr/bin/{n}")
    monkeypatch.setattr(lc.runner, "docker_available", lambda **k: False)
    monkeypatch.setattr(k8s, "workload_exists", lambda *a, **k: True)

    assert upgrade.require_running("k") is meta, "a healthy k8s workspace, no Docker"


def test_kubernetes_migration_errors_come_from_kubernetes_logs(tmp_path, monkeypatch):
    """`_migration_errors` always read Compose logs and swallowed every failure.

    On a Kubernetes workspace `compose_logs_capture` answers "no configuration file
    provided", the bare `except` turned that into an empty list, and a migration
    failure therefore reported no diagnostics at all — silently, at the one moment
    they are worth most.
    """

    from houston.services import k8s, topology, upgrade

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    monkeypatch.setattr(upgrade.runner, "read_meta", lambda n: _idp_meta("default"))

    def _no(*a, **k):
        raise AssertionError("compose logs must not be read for a k8s workspace")

    monkeypatch.setattr(upgrade.runner, "compose_logs_capture", _no)

    class _Proc:
        stdout = ["ok\n", "Migration failed: could not apply 305\n"]
        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(k8s, "log_process", lambda *a, **k: _Proc())
    hits = upgrade._migration_errors("k")
    assert hits == ["Migration failed: could not apply 305"], hits


def test_scale_prefill_refuses_kubernetes_instead_of_asking_compose(tmp_path, monkeypatch):
    """`scaleseed` bulk-inserts through `compose_exec_capture`, so on a Kubernetes
    workspace this reached for a compose project that is not there and answered
    docker's "no configuration file provided: not found".

    Found while widening the engine gate: making `seed` runtime-aware without this
    would have traded a clear "Docker isn't running" for that.
    """
    from houston.errors import ValidationError
    from houston.services import data as datasvc, lifecycle as lc, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "resolve_name", lambda n, actor="": "k")
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    for fn in (lambda: datasvc.run_scale("k", "users=10"),
               lambda: datasvc.clear_scale("k")):
        with pytest.raises(ValidationError) as caught:
            fn()
        assert "seed" in str(caught.value).lower(), caught.value


def test_doctor_says_which_build_is_actually_answering(tmp_path, monkeypatch):
    """`__version__` comes from INSTALLED distribution metadata, so a stale editable
    install or a pipx that was never refreshed reports an old number while the
    checkout beside it holds the fix.

    Three shipped fixes looked ineffective for exactly that reason this week, and
    nothing in the tool said which build was answering.
    """
    from houston.services import doctor

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    rows = doctor.run_checks()["checks"]
    hit = [r for r in rows if r.get("check") == "install-fresh"]
    assert hit, [r.get("check") for r in rows]
    # This checkout is in step with its own install, which is the ok case.
    assert hit[0]["status"] == "ok", hit[0]
    assert "houston" in hit[0]["message"], hit[0]


def test_the_create_claim_names_the_binary_that_makes_it_true(tmp_path, monkeypatch):
    """"No cluster yet — 'houston-local' is created on first use" said nothing about
    what would create it.

    Reported as confusing by someone who believed kind was not installed: the row
    promised a cluster and gave the reader no way to tell the claim was well-founded.
    It requires kind (`can_provision`), so naming the kind settles it either way.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pre = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 30), raw="v1.30.0"),
        "helm": k8s.Tool(name="helm", path="/h", version=(3, 14), raw="v3.14.0"),
        "kind": k8s.Tool(name="kind", path="/kd", version=(0, 32, 0),
                         raw="kind v0.32.0 go1.26.3 linux/amd64"),
    })
    pre.context = k8s.CONTEXT
    pre.will_create = True
    monkeypatch.setattr(k8s, "preflight", lambda *a, **kw: pre)
    monkeypatch.setattr(k8s, "active_context", lambda: "")

    hit = [r for r in doctor.run_checks()["checks"]
           if r.get("check") == "kubernetes-cluster"]
    assert hit, "the cluster row must still be reported"
    msg = hit[0]["message"]
    assert "created on first use" in msg, msg
    assert "by kind 0.32.0" in msg, "cite the binary, and the parsed version not the banner"
    assert "go1.26" not in msg, "the raw version banner is not a version"


def test_doctor_reports_a_workspace_whose_idp_points_at_this_machine(tmp_path, monkeypatch):
    """`up` warns about this at create time now, and every workspace made before that
    is silent.

    An IdP preset addresses its own service as THIS machine by default, which on a
    shared box names each visitor's own laptop: the SAML button returns to the login
    page, the OIDC popup opens blank, presigned previews fail, and none of them logs
    anything.
    """
    from houston import runner
    from houston.services import doctor

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def meta(name, preset, **extra):
        m = runner.Metadata(name=name, project="p", rc_version="8.5.1", rc_image="i",
                            mongo_tag="8.0", mongo_flavor="official", preset=preset,
                            root_url="http://localhost:3001", host_port=3001,
                            version_source="t")
        m.extra.update(extra)
        return m

    listed = [
        meta("wide", "saml", bind_host="0.0.0.0"),                       # reported
        meta("told", "oidc", bind_host="0.0.0.0",
             params={"idp_host": "box.example.com"}),                    # already handled
        meta("local", "saml", bind_host="127.0.0.1"),                    # localhost is true
        meta("plain", "default", bind_host="0.0.0.0"),                   # no IdP at all
    ]
    monkeypatch.setattr(doctor.runner, "list_meta", lambda: listed)

    hits = [r for r in doctor.run_checks()["checks"]
            if r.get("check") == "preset-browser-host"]
    assert len(hits) == 1, [h["message"][:60] for h in hits]
    assert "'wide'" in hits[0]["message"], hits[0]
    assert "--set idp_host=" in hits[0]["message"], hits[0]


def _completed(rc=0, out="", err=""):
    import subprocess
    return subprocess.CompletedProcess(args=["kubectl"], returncode=rc,
                                       stdout=out, stderr=err)


def test_a_namespace_houston_did_not_make_is_refused_not_adopted(monkeypatch):
    """`ensure_namespace` ran `create` (ignoring the result, so an existing namespace
    was fine) and then `label --overwrite` whatever was there.

    That stamped houston's ownership onto a namespace it did not make, after which
    `down --volumes` deletes it and its PersistentVolumeClaims. The realistic trigger
    is not a stranger: it is two houston users on one adopted cluster, because name
    collisions are guarded through the local repro.json and another user's home is
    invisible from here. The namespace's own labels are the only evidence there is,
    and overwriting them destroyed it.
    """
    from houston.errors import ConflictError
    from houston.services import k8s

    def _labels_are(labels):
        monkeypatch.setattr(k8s, "namespace_labels", lambda ns, **kw: labels)

    labelled = {k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
                k8s.WORKSPACE_LABEL: "mine"}

    # Somebody else's namespace, or one an older houston left unlabelled: refused
    # either way, because houston cannot tell them apart and being wrong deletes data.
    _labels_are({})
    with pytest.raises(ConflictError) as caught:
        k8s.ensure_namespace("mine", context="c")
    assert "not managed by houston" in str(caught.value)
    assert "kubectl delete namespace" in str(caught.value), "name the manual step"

    # houston's, but another workspace's.
    _labels_are({**labelled, k8s.WORKSPACE_LABEL: "theirs"})
    with pytest.raises(ConflictError) as caught:
        k8s.ensure_namespace("mine", context="c")
    assert "'theirs'" in str(caught.value)

    # houston's, this workspace, another user.
    _labels_are({**labelled, k8s.OWNER_OF_LABEL: "bob"})
    with pytest.raises(ConflictError) as caught:
        k8s.ensure_namespace("mine", context="c", owner="alice")
    assert "bob" in str(caught.value)

    # Ours, this workspace: reused, and never re-created.
    _labels_are(labelled)
    calls = []
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: calls.append(argv) or _completed())
    assert k8s.ensure_namespace("mine", context="c") == k8s.namespace_for("mine")
    assert not any("create" in a for a in calls), calls
    assert any("label" in a for a in calls), calls


def test_cannot_ask_the_cluster_is_not_the_same_answer_as_nothing_is_there(monkeypatch):
    """`workspace_namespaces()` returned [] both when there was nothing there and when
    the cluster could not be asked, and `delete_namespace` read the second as the
    first.

    So a wrong kube-context, an expired credential or an RBAC denial reported
    "nothing to remove" -- and the caller then deleted the local record and said the
    namespace and its PersistentVolumeClaim were gone, while all of it went on running
    with the only record that knew about it destroyed.
    """
    from houston.errors import DockerError
    from houston.services import k8s

    # Genuinely absent.
    monkeypatch.setattr(k8s, "run", lambda *a, **k: _completed(
        1, err='Error from server (NotFound): namespaces "houston-x" not found'))
    assert k8s.namespace_labels("houston-x", context="c") is None

    # Could not ask -- and that must not look like absence.
    monkeypatch.setattr(k8s, "run", lambda *a, **k: _completed(
        1, err="Unable to connect to the server: dial tcp: i/o timeout"))
    with pytest.raises(DockerError) as caught:
        k8s.namespace_labels("houston-x", context="c")
    assert "refusing to guess" in str(caught.value)
    with pytest.raises(DockerError):
        k8s.delete_namespace("x", context="c", volumes=True)


def test_a_cluster_that_cannot_be_asked_never_reads_as_a_deleted_namespace(monkeypatch):
    """`delete_namespace`'s wait loop read `returncode != 0` as "the namespace is
    gone" -- so ONE transient API error, one expired credential or one wrong context
    made `down --volumes` announce a deletion that had not happened and drop the local
    record, leaving a namespace with no houston path back to it.

    Measured on this box: kubectl exits **1** for an absent namespace AND for a
    context that does not exist, so no threshold on the exit code can tell them
    apart. The exit code says only whether the API server answered; absence has to
    come from the payload. `.docs/design/k8s-answer-contract.md` has the runs.

    This is the `down` half. `wait_namespace_gone` below is the `prune` half, and it
    had the identical defect twenty lines away.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s, "namespace_labels",
                        lambda ns, **kw: {k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
                                          k8s.WORKSPACE_LABEL: "x"})
    monkeypatch.setattr(k8s, "workspace_pvcs", lambda *a, **k: ["data-x-0"])

    def _run(argv, **kw):
        if "delete" in argv:
            return _completed(0)
        # The cluster cannot be asked. NOT `Error from server (NotFound)`, which is
        # the API server asserting absence -- this is a client-side failure, and the
        # two must not land in the same branch.
        return _completed(1, err="Unable to connect to the server: dial tcp: "
                                 "i/o timeout")

    monkeypatch.setattr(k8s, "run", _run)
    said: list = []
    assert k8s.delete_namespace("x", context="c", volumes=True,
                                emit=lambda e: said.append(e.message),
                                sleep=lambda s: None) is False, \
        "a namespace nobody could ask about was reported deleted"
    joined = " ".join(said)
    assert "could not confirm" in joined, joined
    assert "record is KEPT" in joined, "say what was NOT done"
    # A DIFFERENT SENTENCE from the Terminating case, because the remedy differs:
    # one says wait, this one says go and look at your cluster.
    assert "still terminating" not in joined, \
        "an unreachable cluster is not a namespace that is taking its time"


def test_waiting_for_an_orphan_asks_the_cluster_it_was_deleted_from(monkeypatch, tmp_path):
    """`prune --orphans` deleted with `_orphan_context()` and then waited with the
    hardcoded `k8s.CONTEXT`.

    `_orphan_context()` exists BECAUSE that hardcoding was already found and fixed
    once, at the delete call, one block above -- and it was reintroduced at the wait.
    On any cluster houston did not create the two disagree, so the wait asked a
    context that is not in the kubeconfig, kubectl exited non-zero, and the loop read
    that as "gone": `✓ removed 1 orphaned namespace(s)`, exit 0, over a namespace
    still Terminating. Invisible on kind, where the two happen to be equal, which is
    why a live pass on kind did not catch it.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "prunable", lambda: [])
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "orphan_namespaces", lambda *a, **k: ["houston-p9"])
    monkeypatch.setattr(lc, "_orphan_context", lambda: "someone-elses-cluster")
    monkeypatch.setattr(lc, "_reclaim_cluster", lambda emit: False)
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: _completed(0))

    asked: list = []

    def spy_wait(ns, *, context, emit=None, **kw):
        asked.append(context)
        return True

    monkeypatch.setattr(k8s, "wait_namespace_gone", spy_wait)
    lc.prune(confirm=True, orphans=True)
    assert asked == ["someone-elses-cluster"], (
        f"waited on {asked} but deleted from 'someone-elses-cluster' — the two must "
        f"be the same cluster")
    assert k8s.CONTEXT not in asked, "the hardcoded kind context is back"


def test_a_refused_cluster_read_is_not_reported_as_a_cluster_with_nothing(monkeypatch):
    """`doctor` told somebody with a working default StorageClass, Traefik and one
    Ready node that they had none of the three, and gave it a green verdict.

    `reachable()` probes `/readyz`, which a restricted credential can usually still
    get -- so passing it is no evidence the actual reads will be permitted. Each of
    the three then read a permission denial as an absence, because `[]` was the
    answer for both "this cluster has none" and "I was not allowed to look".

    The wire shape is the nasty part and is measured, not imagined: a denied
    `get storageclass -o json` emits an EMPTY items document on stdout **and** exits
    1. A classifier that looked at the payload before the exit code would rebuild the
    bug inside the fix.
    """
    from houston.services import k8s

    denied = _completed(1, out='{"apiVersion":"v1","items":[],"kind":"List"}',
                        err='Error from server (Forbidden): storageclasses.storage.'
                            'k8s.io is forbidden: User "sa" cannot list resource')
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: denied)

    assert k8s.storage_classes("limited") is None, \
        "a forbidden read was reported as 'no StorageClass'"
    assert k8s.ingress_classes("limited") is None
    assert k8s.nodes_summary("limited") is None

    # And an empty cluster still answers empty -- the fix must not turn "none" into
    # "unknown", or every kind cluster would start warning about its absent ingress.
    empty = _completed(0, out='{"apiVersion":"v1","items":[],"kind":"List"}')
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: empty)
    assert k8s.storage_classes("kind") == ([], "")
    assert k8s.ingress_classes("kind") == []
    assert k8s.nodes_summary("kind") == (0, [])


def test_a_namespace_still_terminating_is_not_reported_as_gone(monkeypatch):
    """`delete_namespace` waited, then returned True even while the namespace was
    still Terminating -- and True is read as "confirmed absent", so the caller deleted
    the local record and tore down the shared operator and monitoring stack.

    Finalizers can wedge indefinitely; the workspace was then an orphan with no
    houston path left to it.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s, "namespace_labels",
                        lambda ns, **kw: {k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
                                          k8s.WORKSPACE_LABEL: "x"})
    monkeypatch.setattr(k8s, "workspace_pvcs", lambda *a, **k: ["data-x-0"])

    def _run(argv, **kw):
        if "delete" in argv:
            return _completed(0)
        # The document a real `get namespace -o json` returns, not a bare phase
        # string: `-o json` is what the code asks for, so a stub answering with
        # anything else is testing a wire shape that does not exist.
        return _completed(0, out=json.dumps({                # never goes away
            "metadata": {"name": "houston-x"},
            "status": {"phase": "Terminating"}}))

    monkeypatch.setattr(k8s, "run", _run)
    said: list = []
    assert k8s.delete_namespace("x", context="c", volumes=True,
                                emit=lambda e: said.append(e.message),
                                sleep=lambda s: None) is False
    joined = " ".join(said)
    assert "still terminating" in joined, joined
    assert "record is KEPT" in joined, "say what was NOT done"


def test_prune_does_not_need_docker_when_every_workspace_is_kubernetes(tmp_path, monkeypatch):
    """`prunable()` called `require_docker()` at the top, so `prune` was refused
    outright on a host that uses only an adopted cluster and has no Docker -- while
    the loop below it has asked Kubernetes about Kubernetes workspaces for a while.
    The gate contradicted the runtime it was gating.
    """
    from houston import runner
    from houston.services import k8s, lifecycle as lc, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = runner.Metadata(name="k", project="p", rc_version="8.5.1", rc_image="i",
                        mongo_tag="8.0", mongo_flavor="official", preset="default",
                        root_url="http://localhost:3001", host_port=3001,
                        version_source="t")
    m.extra["runtime"] = "kubernetes"
    monkeypatch.setattr(lc.runner, "list_meta", lambda: [m])
    monkeypatch.setattr(topology, "of_meta", lambda meta: topology.KUBERNETES)
    monkeypatch.setattr(lc, "may_destroy", lambda *a, **k: (True, ""))
    monkeypatch.setattr(k8s, "workload_exists", lambda *a, **k: False)

    def _no_docker(*a, **k):
        raise AssertionError("Docker must not be required for a Kubernetes-only host")

    monkeypatch.setattr(lc, "require_docker", _no_docker)
    assert lc.prunable() == ["k"]


def test_a_recycled_pid_is_not_our_port_forward(monkeypatch):
    """The check was "is this process a kubectl port-forward" -- liveness wearing
    identity's clothes.

    A recycled pid belonging to another workspace's forward, or another user's on a
    shared box, passed it: so houston could believe a workspace was reachable when it
    was not, decline to start the forward it needed, and signal a stranger's process at
    teardown. The argv already carries the proof.
    """
    from houston.services import k8s

    def _argv(*parts):
        class _P:
            def read_bytes(self):
                return "\0".join(parts).encode()
        monkeypatch.setattr(k8s, "Path", lambda _p: _P())

    ours = ("kubectl", "--context", "c", "-n", "houston-mine", "port-forward",
            "deployment/rocketchat-rocketchat", "3001:3000")
    _argv(*ours)
    assert k8s.forward_alive(42, namespace="houston-mine", host_port=3001)

    # Someone else's workspace, same box, recycled pid.
    _argv("kubectl", "--context", "c", "-n", "houston-theirs", "port-forward",
          "deployment/rocketchat-rocketchat", "3002:3000")
    assert not k8s.forward_alive(42, namespace="houston-mine", host_port=3001)

    # Same namespace, different port -- and a substring test would have matched.
    _argv("kubectl", "--context", "c", "-n", "houston-mine", "port-forward",
          "deployment/rocketchat-rocketchat", "13001:3000")
    assert not k8s.forward_alive(42, namespace="houston-mine", host_port=3001), \
        "13001 must not satisfy 3001"

    # Not a port-forward at all.
    _argv("python", "-m", "http.server")
    assert not k8s.forward_alive(42, namespace="houston-mine", host_port=3001)


def test_a_kubeconfig_error_is_not_read_as_an_absent_namespace(monkeypatch):
    """The first cut tested `"not found" in text`, and kubectl says

        Error in configuration: context was not found for specified context: nope

    for a bad --context. That contains "not found", so a kubeconfig problem was
    classified as an absent namespace -- which is precisely the "I could not ask"
    case this function exists to separate out, reintroduced by a sloppy match.
    Measured against a live cluster with a bogus context: `delete_namespace` returned
    False, meaning "nothing there", for a cluster it had never reached.

    Only the API says `Error from server (NotFound)`.
    """
    from houston.errors import DockerError
    from houston.services import k8s

    monkeypatch.setattr(k8s, "run", lambda *a, **k: _completed(
        1, err="Error in configuration: context was not found for specified "
               "context: no-such-context"))
    with pytest.raises(DockerError):
        k8s.namespace_labels("houston-x", context="no-such-context")

    # The server's own reason still reads as absence.
    monkeypatch.setattr(k8s, "run", lambda *a, **k: _completed(
        1, err='Error from server (NotFound): namespaces "houston-x" not found'))
    assert k8s.namespace_labels("houston-x", context="c") is None


def test_not_knowing_who_you_are_is_not_proof_the_namespace_is_yours(monkeypatch):
    """The owner comparison was `held_by and owner and held_by != owner`, so an empty
    owner skipped it.

    `_cli_actor()` returns "" until accounts exist -- team mode is opt-in -- so on a
    plain CLI box the check could not fire at all. Done on a live cluster: a namespace
    labelled `owner=bob` was adopted and Rocket.Chat installed into it.
    """
    from houston.errors import ConflictError
    from houston.services import k8s

    labels = {k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
              k8s.WORKSPACE_LABEL: "w", k8s.OWNER_OF_LABEL: "bob"}
    # THE NAMESPACE DOCUMENT, because the preflight reads the phase as well as the
    # labels now and gets both from one `get namespace -o json`. Stubbing
    # `namespace_labels` no longer intercepts anything, and a stub that answers a call
    # the code does not make tests nothing.
    ns_doc = json.dumps({"metadata": {"name": "houston-w", "labels": labels},
                         "status": {"phase": "Active"}})
    monkeypatch.setattr(k8s, "run", lambda *a, **k: _completed(0, out=ns_doc))

    # THE REASON DEPENDS ON WHETHER TEAM MODE IS ON, and saying the wrong one made
    # the namespace un-adoptable. `_cli_actor()` returns "" whenever this box has no
    # accounts -- even with HOUSTON_USER set -- so on such a box the old message
    # said "HOUSTON_USER is not set" while it WAS, and the remedy it named produced
    # the identical refusal. The refusal itself was always right.
    with pytest.raises(ConflictError) as caught:
        k8s.assert_namespace_available("w", context="c")          # no owner at all
    assert "no houston accounts" in str(caught.value), caught.value
    assert "houston users add bob" in str(caught.value), \
        "the remedy has to be one that actually works on a box with no accounts"
    assert "HOUSTON_USER=bob" in str(caught.value), "say how to identify yourself"

    # With accounts, an empty owner really does mean the variable is unset, and the
    # original message is the right one.
    from houston.services import users as usersvc
    usersvc.add("someone", "correct-horse-battery")
    with pytest.raises(ConflictError) as caught:
        k8s.assert_namespace_available("w", context="c")
    assert "HOUSTON_USER is not set" in str(caught.value), caught.value
    assert "HOUSTON_USER=bob" in str(caught.value), "say how to identify yourself"

    with pytest.raises(ConflictError):
        k8s.assert_namespace_available("w", context="c", owner="alice")

    # bob himself is fine.
    k8s.assert_namespace_available("w", context="c", owner="bob")

    # And a namespace of bob's that is still going away is refused for a DIFFERENT
    # reason, with a different remedy: waiting, not identifying yourself.
    gone = json.dumps({"metadata": {"name": "houston-w", "labels": labels},
                       "status": {"phase": "Terminating"}})
    monkeypatch.setattr(k8s, "run", lambda *a, **k: _completed(0, out=gone))
    with pytest.raises(ConflictError) as terminating:
        k8s.assert_namespace_available("w", context="c", owner="bob")
    assert "Terminating" in str(terminating.value), terminating.value


def test_the_no_auth_message_names_the_reason_that_actually_applies(monkeypatch):
    """It always said "no operator below 6.0, so no auth", and that was never the
    reason on any workspace anyone booted.

    `OPERATOR_MIN_MONGO` is (6, 0) and every supported Rocket.Chat resolves MongoDB to
    6.0, 7.0, 8.0 or 8.2, so the version floor is satisfied every time. The real
    reason is the other branch: the operator is OPT-IN and off. Somebody who wanted
    authentication was therefore sent to raise a MongoDB version that was not the
    obstacle -- while the workspace notes printed moments later said the true thing,
    so the two outputs contradicted each other.
    """
    from houston.services import k8s

    monkeypatch.delenv(k8s.USE_OPERATOR_ENV, raising=False)
    # The version floor is met for every version this tool actually pairs.
    for tag in ("6.0", "7.0", "8.0", "8.2"):
        parts = tuple(int(n) for n in tag.split("."))
        assert parts >= k8s.OPERATOR_MIN_MONGO, tag
        assert not k8s.operator_supports(tag), \
            "opt-in and off is the reason, not the version"
        assert k8s.operator_supports(tag, forced=True), \
            "forced, the same version IS supported -- so the floor was never the bar"

    # And 5.0 is the one case where the version really is the reason.
    assert not k8s.operator_supports("5.0", forced=True)

    # The source must offer both reasons rather than one. A walk, because this is a
    # message and no test would otherwise notice it going back to a single branch.
    body = source_of(k8s.create_workspace)
    assert "no authentication:" in body
    assert "opt-in" in body and "cannot manage MongoDB below" in body, (
        "the message must be able to name either reason")
    assert "no operator below" not in body, "the always-false wording is back"


def test_a_refused_create_is_refused_before_the_write_ahead_record():
    """A refusal that created nothing must leave nothing behind.

    The provisional `repro.json` exists so a create that dies HALF WAY can still be
    found and removed -- a different situation from one that never started. With the
    ownership check only inside `ensure_namespace`, a refused create left an
    `incomplete` record that `prune` then offered to delete. Seen on a live cluster.

    Asserted on the order in the source, the same way the Kubernetes refusals are.
    """

    from houston.services import lifecycle as lc

    src = source_of(lc._create_kubernetes)
    guard = source_index(src, "assert_namespace_available")
    record = source_index(src, 'repro.json"')
    assert guard < record, "the ownership refusal must precede the write-ahead record"


# --- the journal: side effects a killed process must not leave behind ---------
#
# `web/jobs.py` runs long operations on DAEMON threads, so a restart, an OOM kill or
# a plain SIGKILL ends them where they stand and skips every `finally`. Those blocks
# are doing real work -- `backup` stops Rocket.Chat, `loadtest` turns the API rate
# limiter off -- and the registry is in memory, so a restart loses even the knowledge
# that a job existed. Measured: under SIGKILL the `finally` does not run.

def test_a_live_owner_means_the_note_is_not_abandoned(tmp_path, monkeypatch):
    """Repairing an entry whose job is still running would re-enable the rate limiter
    underneath a load test that has not finished.

    So liveness is checked by pid AND the owner's start time -- pid alone is not
    enough, because the OS recycles them, which is the same mistake `forward_alive`
    was making about port-forwards.
    """
    import os

    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    mine = journal.record(journal.RATE_LIMITER_OFF, "w")
    assert mine, "the entry must be written"
    assert len(journal.open_entries()) == 1
    assert journal.abandoned() == [], "this process is alive; leave it alone"

    # A RECYCLED pid: still a live process, but not the one that wrote this.
    entry = journal.open_entries()[0]
    assert entry.pid == os.getpid()
    (journal.journal_dir() / f"{entry.id}.json").write_text(json.dumps({
        **{k: getattr(entry, k) for k in ("id", "kind", "workspace", "pid", "at")},
        "started": "999999999", "detail": {}}))
    assert len(journal.abandoned()) == 1, \
        "same pid, different start time -- a different process, so the owner is gone"


def test_the_note_is_cleared_when_the_cleanup_runs_and_kept_when_it_does_not(
        tmp_path, monkeypatch):
    """A surviving entry has to mean precisely "the cleanup did not happen"."""
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    with journal.side_effect(journal.RATE_LIMITER_OFF, "w"):
        assert len(journal.open_entries()) == 1
    assert journal.open_entries() == [], "cleared on the way out"

    # Cleared on an exception too: the `finally` ran, so the state was restored.
    with pytest.raises(RuntimeError):
        with journal.side_effect(journal.RATE_LIMITER_OFF, "w"):
            raise RuntimeError("boom")
    assert journal.open_entries() == []

    # An unknown kind is refused, because recovery has to know how to undo it --
    # a note nothing can repair would sit there forever looking like a fault.
    with pytest.raises(ValueError):
        journal.record("something_new", "w")


def test_recovery_restarts_rocketchat_and_re_enables_the_rate_limiter(
        tmp_path, monkeypatch):
    """The two states an interrupted job leaves behind, and what undoes each.

    `_Quiesced`'s own docstring calls a workspace left stopped "a worse outcome than
    the failure itself"; the rate limiter being off is a security-relevant setting
    nobody chose. Verified live as well: SIGKILL a real quiesce and `serve` starts
    Rocket.Chat again at its next startup.
    """
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(journal.runner, "exists", lambda n: True)
    dead = {"pid": 999999, "started": "1"}

    def _plant(kind, **detail):
        eid = journal.record(kind, "w", **detail)
        path = journal.journal_dir() / f"{eid}.json"
        data = json.loads(path.read_text())
        data.update(dead)
        path.write_text(json.dumps(data))
        return eid

    started: list = []
    monkeypatch.setattr(journal.runner, "start_services",
                        lambda n, svcs: started.append((n, svcs)) or 0)
    _plant(journal.ROCKETCHAT_STOPPED, services=["rocketchat"])
    rows = journal.recover()
    assert rows and rows[0]["repaired"] is True, rows
    assert started == [("w", ["rocketchat"])], started
    assert journal.open_entries() == [], "a repaired note is cleared"

    # The rate limiter, and a repair that FAILS must keep its note.
    from houston import rcapi
    from houston.services import lifecycle
    monkeypatch.setattr(lifecycle, "login", lambda m: object())
    monkeypatch.setattr(journal.runner, "read_meta",
                        lambda n: _idp_meta("default"))
    monkeypatch.setattr(rcapi, "set_setting", lambda *a, **k: False)
    _plant(journal.RATE_LIMITER_OFF)
    rows = journal.recover()
    assert rows[0]["repaired"] is False, rows
    assert len(journal.open_entries()) == 1, "an unrepaired note must survive"

    monkeypatch.setattr(rcapi, "set_setting", lambda *a, **k: True)
    assert journal.recover()[0]["repaired"] is True
    assert journal.open_entries() == []


def test_a_note_for_a_workspace_that_is_gone_is_not_a_failure(tmp_path, monkeypatch):
    """Whatever was done to it went with it, so clearing the note is the right
    outcome -- not an unrepairable warning that never goes away."""
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(journal.runner, "exists", lambda n: False)
    eid = journal.record(journal.ROCKETCHAT_STOPPED, "deleted-long-ago")
    path = journal.journal_dir() / f"{eid}.json"
    data = json.loads(path.read_text())
    data.update(pid=999999, started="1")
    path.write_text(json.dumps(data))
    rows = journal.recover()
    assert rows[0]["repaired"] is True, rows
    assert journal.open_entries() == []


def test_doctor_tells_a_cli_box_about_interrupted_work(tmp_path, monkeypatch):
    """`serve` repairs from the journal at startup, and a CLI-only box never starts
    one -- so `doctor` is the only place that would ever mention it there.

    An entry a LIVE job holds is reported as progress, not as a fault.
    """
    from houston.services import doctor, journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    journal.record(journal.RATE_LIMITER_OFF, "mine")        # this process: alive
    rows = [r for r in doctor.run_checks()["checks"]
            if r.get("check") == "interrupted-work"]
    assert rows and rows[0]["status"] == "ok", rows
    assert "in progress" in rows[0]["message"], rows[0]

    entry = journal.open_entries()[0]
    path = journal.journal_dir() / f"{entry.id}.json"
    data = json.loads(path.read_text())
    data.update(pid=999999, started="1")
    path.write_text(json.dumps(data))
    rows = [r for r in doctor.run_checks()["checks"]
            if r.get("check") == "interrupted-work"]
    assert rows and rows[0]["status"] == "warn", rows
    assert "rate limiter" in rows[0]["message"], rows[0]


def test_the_namespace_preflight_is_skipped_when_the_cluster_is_about_to_be_made(
        tmp_path, monkeypatch):
    """The ownership preflight asks kubectl about a namespace, and on a fresh box the
    context it would ask about does not exist yet.

    `namespace_labels` correctly refuses to read "context was not found" as "no
    namespace" -- so with the check running unconditionally, the FIRST Kubernetes
    create on any box failed with houston's own "refusing to guess". Found by doing
    exactly that after `prune` had reclaimed the cluster; every earlier live run of
    the check passed only because a cluster happened to be there.

    A cluster that does not exist holds no namespace to collide with, and
    `ensure_namespace` repeats the check once it is up.
    """

    from houston.services import lifecycle as lc

    src = source_of(lc._create_kubernetes)
    guard = source_index(src, "assert_namespace_available")
    # The call must sit under a `not plan.create` test, not at the top level.
    before = src[:guard]
    assert "if not plan.create:" in before.split("plan = k8s.plan_cluster(")[-1], \
        "the preflight must be skipped when houston is about to create the cluster"

    # And it must still run when the cluster is already there.
    asked: list = []
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.services import k8s
    monkeypatch.setattr(k8s, "assert_namespace_available",
                        lambda name, **kw: asked.append(name))
    # The helm gate sits directly above the call under test, in the same
    # `not plan.create` block, and it SHELLS OUT -- so on a box with no reachable
    # cluster it refuses the create and this test's subject never runs. Pinned, for
    # the reason `_kube_tls_env` pins it: nothing in this suite may need a cluster.
    monkeypatch.setattr(k8s, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s, "plan_cluster",
                        lambda *a, **kw: k8s.ClusterPlan(context="default",
                                                         distribution="k3s",
                                                         create=False))
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "pick_host_port", lambda *a, **kw: 3000)
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "rc_image": "i", "mongo_tag": "8.0",
                  "mongo_flavor": "official", "source": "t", "oplog": False})())
    monkeypatch.setattr(k8s, "create_workspace", lambda **kw: {
        "context": "default", "namespace": "houston-x", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": ""})
    try:
        lc._create_repro_locked(lc.CreateReq(version="8.5.1", name="x",
                                             runtime="kubernetes"))
    except Exception:  # noqa: BLE001 - the call above is what is being asserted
        pass
    assert asked == ["x"], asked


def test_a_finished_create_clears_every_earlier_claim_that_it_did_not_finish(
        tmp_path, monkeypatch):
    """Notes are per-process, and some facts invalidate other processes' notes.

    A create that FAILED left a `CREATE_UNFINISHED` note; a later create of the same
    name that succeeded cleared only the note it had written itself, so the stale one
    went on claiming a complete workspace had never finished. Seen exactly that way:
    one attempt died on a preflight, the retry succeeded, and the warning stayed.
    """
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    for at in ("T1", "T2"):
        eid = journal.record(journal.CREATE_UNFINISHED, "w")
        path = journal.journal_dir() / f"{eid}.json"
        data = json.loads(path.read_text())
        data["at"] = at
        path.write_text(json.dumps(data))
    journal.record(journal.CREATE_UNFINISHED, "elsewhere")
    assert len(journal.open_entries()) == 3

    assert journal.clear_kind(journal.CREATE_UNFINISHED, "w") == 2
    assert [e.workspace for e in journal.open_entries()] == ["elsewhere"], \
        "another workspace's note is not this workspace's business"


def test_an_advisory_note_for_a_workspace_that_is_gone_stops_warning(
        tmp_path, monkeypatch):
    """Advisory notes are never repaired, so nothing would ever clear one whose
    workspace has been removed -- it would warn forever about something that cannot be
    acted on. A create that failed and rolled back is exactly that case."""
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(journal.runner, "exists", lambda n: False)
    eid = journal.record(journal.CREATE_UNFINISHED, "rolled-back")
    path = journal.journal_dir() / f"{eid}.json"
    data = json.loads(path.read_text())
    data.update(pid=999999, started="1")
    path.write_text(json.dumps(data))

    assert journal.recover() == [], "nothing to report about a workspace that is gone"
    assert journal.open_entries() == [], "and the note is dropped, not kept"

    # While the workspace IS there, it is reported and deliberately not repaired.
    monkeypatch.setattr(journal.runner, "exists", lambda n: True)
    eid = journal.record(journal.CREATE_UNFINISHED, "still-here")
    path = journal.journal_dir() / f"{eid}.json"
    data = json.loads(path.read_text())
    data.update(pid=999999, started="1")
    path.write_text(json.dumps(data))
    rows = journal.recover()
    assert len(rows) == 1 and rows[0]["repaired"] is False, rows
    assert "houston ready" in rows[0]["why"], rows[0]
    assert len(journal.open_entries()) == 1, "kept until somebody acts on it"


def test_the_bench_workspace_and_the_constraints_can_be_undone(tmp_path, monkeypatch):
    """The two side effects added beside the first pair. `benchmark` leaves the most
    expensive thing on this branch behind -- a Rocket.Chat and a MongoDB per version --
    and a performance run's CPU/RAM caps have to go back to the PRIOR values rather
    than to "unlimited", which is why the note carries them."""
    from houston.perf import constrain as constrain_mod
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(journal.runner, "exists", lambda n: True)
    dead = {"pid": 999999, "started": "1"}

    def _plant(kind, **detail):
        eid = journal.record(kind, "w", **detail)
        path = journal.journal_dir() / f"{eid}.json"
        data = json.loads(path.read_text())
        data.update(dead)
        path.write_text(json.dumps(data))

    removed: list = []
    monkeypatch.setattr(journal.runner, "down",
                        lambda n, volumes=False: removed.append((n, volumes)))
    monkeypatch.setattr(journal.runner, "remove", lambda n: None)
    _plant(journal.BENCH_WORKSPACE)
    assert journal.recover()[0]["repaired"] is True
    assert removed == [("w", True)], "the volume goes too; it was a throwaway"

    # Constraints: the prior values survive the round trip and reach restore().
    got: list = []
    monkeypatch.setattr(constrain_mod, "restore", lambda applied: got.extend(applied) or [])
    _plant(journal.CONSTRAINTS_APPLIED, applied=[{
        "container": "abc", "service": "rocketchat", "prior_nano": 2_000_000_000,
        "prior_mem": 1073741824, "prior_swap": -1, "set_cpus": True,
        "set_mem": False}])
    assert journal.recover()[0]["repaired"] is True
    assert len(got) == 1 and got[0].prior_nano == 2_000_000_000, got
    assert got[0].set_mem is False, "restore must not cap a dimension nobody capped"


def test_describe_only_describes(monkeypatch):
    """`describe()` is a formatting function and must not DO anything.

    It briefly did: a repair block was inserted with an anchor that matched the first
    `if entry.kind == ROCKETCHAT_STOPPED:` in the file, which is in `describe`, not in
    `_repair`. So describing an entry tore down a workspace and returned True instead
    of a sentence -- caught because a test asserted `repaired is True` and got False,
    with `what` holding a boolean.
    """

    from houston.services import journal

    src = source_of(journal.describe)
    for forbidden in ("runner.", "restore(", "subprocess", "clear("):
        assert forbidden not in src, f"describe() must not reach for {forbidden!r}"
    for kind in journal.KINDS:
        text = journal.describe(journal.Entry(id="i", kind=kind, workspace="w", pid=1,
                                              at="T"))
        assert isinstance(text, str) and "w" in text, (kind, text)


def test_a_done_warning_reaches_the_terminal_and_a_done_info_does_not(capsys):
    """`_cli_emit` suppressed EVERY event at `phase="done"`, at every level.

    The suppression is right for the informational ones -- the command wrapper prints
    the final panel and would say it twice. It was wrong for warnings, and six of them
    are raised at exactly that phase, because `done` is where a service says what it
    finished doing. So a CLI user was never told that an orphaned namespace could not be
    removed, that a workspace was skipped by `prune`, that the cluster was left alone,
    that a monitoring volume was left behind, or -- the sharpest -- that `stop` on an
    operator-managed workspace frees Rocket.Chat's memory and not MongoDB's, which is a
    warning written specifically so `stop` would say it instead of staying quiet.
    """
    from houston import cli
    from houston.services.events import Event

    # The full 3x2 matrix, so this cannot pass by accident on one level.
    for level in ("info", "warn", "error"):
        for phase in ("done", "teardown"):
            capsys.readouterr()
            cli._cli_emit(Event(f"{level}-{phase}", phase=phase, level=level))
            out = capsys.readouterr()
            printed = f"{level}-{phase}" in (out.out + out.err)
            want = not (phase == "done" and level == "info")
            assert printed is want, (
                f"level={level} phase={phase}: printed={printed}, expected {want}")

    # A terminal event stays suppressed whatever its level -- that half was never the bug.
    capsys.readouterr()
    cli._cli_emit(Event("terminal-warn", phase="teardown", level="warn", terminal=True))
    out = capsys.readouterr()
    assert "terminal-warn" not in (out.out + out.err)


def test_prune_says_which_namespaces_it_destroyed(monkeypatch, tmp_path):
    """`prune --orphans` deleted namespaces and their PersistentVolumeClaims and then
    printed "Nothing to prune."

    `lifecycle.prune` returns them as `orphans`; the CLI rendered `removed` alone, so a
    sweep that removed no local record -- the normal case for the situation --orphans
    exists for -- reported the irreversible half of the command as the no-op half. The
    confirmation prompt did name them, which is no help under `--yes`.
    """
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "prunable", lambda *a, **k: [])
    monkeypatch.setattr(lc, "orphan_namespaces", lambda *a, **k: ["houston-ghost"])
    monkeypatch.setattr(cli, "_cluster_reclaimable", lambda *a, **k: False)
    monkeypatch.setattr(lc, "prune", lambda **k: {
        "targets": [], "removed": [], "orphans": ["houston-ghost"], "cluster": False})

    res = CliRunner().invoke(cli.app, ["prune", "--orphans", "--yes"])

    assert res.exit_code == 0, res.output
    assert "houston-ghost" in res.output, res.output
    assert "Nothing to prune" not in res.output, res.output


def test_prune_audits_the_namespaces_it_swept_not_just_the_records(monkeypatch, tmp_path):
    """The audit subject was `",".join(targets)` -- local records only.

    A sweep of three namespaces and no records therefore wrote `prune` with an empty
    subject, so between that and the silent stdout there was no trace anywhere of what
    had been destroyed.
    """
    from houston.services import audit as auditsvc
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen = []
    monkeypatch.setattr(auditsvc, "record", lambda a, s="", **k: seen.append((a, s)))
    monkeypatch.setattr(lc, "prunable", lambda *a, **k: [])
    monkeypatch.setattr(lc, "orphan_namespaces", lambda *a, **k: ["houston-ghost"])
    monkeypatch.setattr(lc, "_reclaim_cluster", lambda *a, **k: False)

    # The audit is written before the sweep, so the sweep itself is not stubbed and
    # whatever it does with no cluster to talk to is not what this asserts.
    try:
        lc.prune(confirm=True, orphans=True)
    except Exception:  # noqa: BLE001
        pass

    assert seen, "prune recorded no audit entry at all"
    action, subject = seen[0]
    assert action == "prune"
    assert "houston-ghost" in subject, subject


def test_a_workspace_whose_database_is_gone_is_not_reported_healthy(monkeypatch, tmp_path):
    """Rocket.Chat serves /api/info with NO DATABASE behind it.

    Measured on a live workspace: `docker stop <mongodb>`, then /api/info 200, login
    000 after 15s, `ready` exit 0 "ready", `list` running, `detail()` state=running
    health=healthy uptime="2 minutes" -- and the same payload's containers array
    holding ("mongodb", "exited"). The summary contradicted its own detail. Every
    remediation the tool then offered pointed back at `ready`: `api` exits 5 with
    "wait for it with `houston ready`" and `seed` exits 1 with the same, and `ready`
    reports success. There was no exit from that loop without reading `docker ps`.

    `degraded_reason` is one rule, consulted by the list, the panel and `ready`, so
    they cannot drift -- the same remedy `repro_state()` needed when the list and the
    panel disagreed about state.
    """
    from houston.services.lifecycle import ESSENTIAL_SERVICES, degraded_reason

    healthy = {"mongodb": "Up 2 hours", "rocketchat": "Up 2 hours (healthy)"}
    dead_db = {"mongodb": "Exited (0) 3 minutes ago",
               "rocketchat": "Up 2 hours (healthy)"}

    assert degraded_reason(healthy) == ""
    assert degraded_reason(dead_db) == "mongodb is exited", degraded_reason(dead_db)
    # A workspace with no mongodb container at all (Kubernetes, or an external Mongo)
    # is not evidence of a fault -- absence is not the same as stopped.
    assert degraded_reason({"rocketchat": "Up 2 hours (healthy)"}) == ""
    # SIDE SERVICES ARE NOT ESSENTIAL. A stopped Mailpit is something a person lives
    # with; treating every preset sidecar as fatal would refuse workspaces that work.
    assert "mailpit" not in ESSENTIAL_SERVICES
    assert degraded_reason({"mongodb": "Up 1 hour", "mailpit": "Exited (1) ago"}) == ""


def test_the_detail_summary_cannot_contradict_its_own_containers(monkeypatch, tmp_path):
    """`detail()` derived state AND health from the Rocket.Chat container alone."""
    from houston import runner
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "resolve_name", lambda n: "dbgone")
    monkeypatch.setattr(runner, "read_meta", lambda n: lc.runner.Metadata(
        name=n, project=f"houston-{n}", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map"))
    monkeypatch.setattr(runner, "docker_available", lambda: True)
    monkeypatch.setattr(runner, "container_details", lambda n: [
        {"service": "mongodb", "state": "exited",
         "status": "Exited (0) 3 minutes ago", "health": ""},
        {"service": "rocketchat", "state": "running",
         "status": "Up 2 hours (healthy)", "health": "healthy"},
    ])
    monkeypatch.setattr(runner, "rc_restart_count", lambda n: 0)
    monkeypatch.setattr(runner, "read_compose", lambda n: {})

    d = lc.detail("dbgone")

    assert d["state"] == "running"          # it IS running; that part was never wrong
    assert d["health"] == "degraded", d["health"]
    assert d["degraded"] == "mongodb is exited", d["degraded"]


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
    monkeypatch.setattr(runner, "rc_state", lambda n: "running")
    monkeypatch.setattr(runner, "rc_restart_count", lambda n: 0)
    # raising=False: this test is about the MESSAGE, and must fail against the
    # pre-fix tree for that reason rather than on a missing attribute name.
    monkeypatch.setattr(runner, "services_by_project", lambda: {}, raising=False)

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
    monkeypatch.setattr(runner, "rc_state", lambda n: "restarting")
    monkeypatch.setattr(runner, "rc_restart_count", lambda n: 3)
    # raising=False: this test is about the MESSAGE, and must fail against the
    # pre-fix tree for that reason rather than on a missing attribute name.
    monkeypatch.setattr(runner, "services_by_project", lambda: {}, raising=False)

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


def test_every_side_effect_that_outlives_a_kill_is_journalled():
    """The walk that makes the journal a registry rather than a habit.

    THIS TEST USED TO PASS FOR THE WRONG REASON, TWICE, and a second reviewer found
    both. It was a hardcoded four-function list rather than a walk, so `houston/seed.py`
    and `houston/configimport.py` -- which both disable the API rate limiter, and seed
    also disables email-2FA -- were simply outside its scope. And even once they were in
    scope the assertion silently skipped, because the guard was the source text
    `"config.RC_RATE_LIMITER_SETTING" in src` while both files spelled the setting as
    the bare literal `"API_Enable_Rate_Limiter"`. A test whose guard is defeated by the
    very drift it is meant to catch.

    So it walks the package now, and it matches on the SETTING STRING rather than on
    how a file happens to spell the constant -- there is no spelling that dodges it
    short of building the name at runtime, which the invariant below forbids.

    Why it matters in use: README promises "Email-2FA and the rate limiter are disabled
    while seeding and restored afterwards." A GUI seed of the `large` profile is minutes
    long against `jobs.drain`'s 25 seconds, so a `systemctl restart` mid-seed is
    routine. What survived was a workspace with the limiter AND email-2FA off, silently
    different from the one an engineer was about to measure, and invisible to both
    `doctor`'s `interrupted-work` row and `serve`'s startup recovery.
    """
    import ast
    import pathlib as _pl

    from houston import config
    from houston.services import journal

    root = _pl.Path(config.__file__).parent

    #: setting value -> the journal kind that undoes turning it off/on.
    GUARDED = {
        "API_Enable_Rate_Limiter": "RATE_LIMITER_OFF",
        journal.EMAIL_2FA_SETTING: "EMAIL_2FA_OFF",
    }
    #: Calls that arm something a kill must not strand, and the kind for each.
    ARMING_CALLS = {
        "constrain_mod.apply": "CONSTRAINTS_APPLIED",
        "mongoprof.start": "MONGO_PROFILER_ON",
    }

    offenders: list[str] = []
    for path in sorted(root.rglob("*.py")):
        # journal.py is the REPAIR side by definition -- `_repair` puts these settings
        # back, so it mentions every one of them and journals none. Excluded by name
        # rather than by a cleverer predicate, because "the module that undoes them" is
        # the honest reason and a predicate would drift.
        if "/data/" in str(path) or path.name == "journal.py":
            continue
        text = path.read_text()
        try:
            tree = ast.parse(text)
        except SyntaxError:                                    # pragma: no cover
            continue
        for fn in [n for n in ast.walk(tree)
                   if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            body = ast.unparse(fn)
            recorded = {ast.unparse(c.args[0]).rsplit(".", 1)[-1]
                        for c in ast.walk(fn)
                        if isinstance(c, ast.Call)
                        and ast.unparse(c.func).endswith("journal.record") and c.args}
            where = f"{path.name}:{fn.name}"
            for value, kind in GUARDED.items():
                # Armed = set to False somewhere in this function. Matched on the
                # VALUE, so `config.RC_RATE_LIMITER_SETTING` and the bare literal are
                # the same question.
                names = {value, "RC_RATE_LIMITER_SETTING", "EMAIL_2FA_SETTING"}
                mentions = any(n in body for n in names if n == value) or (
                    value == "API_Enable_Rate_Limiter"
                    and "RC_RATE_LIMITER_SETTING" in body)
                if value == journal.EMAIL_2FA_SETTING:
                    mentions = value in body or "EMAIL_2FA_SETTING" in body
                if mentions and ", False)" in body and kind not in recorded:
                    offenders.append(f"{where} disables {value} and records no {kind}")
            for call, kind in ARMING_CALLS.items():
                if call + "(" in body and kind not in recorded:
                    offenders.append(f"{where} calls {call}() and records no {kind}")

    assert not offenders, (
        "these arm a side effect that outlives a SIGKILL and journal nothing:\n  "
        + "\n  ".join(offenders))

    # The kinds this walk depends on must exist, so a rename cannot turn the whole
    # thing into a no-op that reports green.
    for kind in ("RATE_LIMITER_OFF", "EMAIL_2FA_OFF", "CONSTRAINTS_APPLIED",
                 "MONGO_PROFILER_ON", "RC_METRICS_ON"):
        assert hasattr(journal, kind), kind

def test_a_dry_run_of_the_journal_does_not_change_it():
    """`recover(dry_run=True)` DELETED advisory notes whose workspace was gone.

    The clear sat above the dry_run check, so a dry run over two notes reported one and
    removed the other -- and a dry run is the only way to inspect the journal without
    repairing it, which makes mutating one a contradiction in terms.
    """
    from houston import runner
    from houston.services import journal

    import os
    ident = journal.record(journal.CREATE_UNFINISHED, "ghost-workspace")
    assert ident, "the note was not written"
    # Owned by a process that cannot be us, so `abandoned()` includes it.
    path = journal.journal_dir() / f"{ident}.json"
    import json as _json
    doc = _json.loads(path.read_text())
    doc["pid"] = 999999 if os.getpid() != 999999 else 999998
    doc["started"] = "1"
    path.write_text(_json.dumps(doc))

    assert not runner.exists("ghost-workspace")     # the branch under test
    rows = journal.recover(dry_run=True)

    assert path.exists(), "a dry run deleted the note it was only meant to report"
    assert any(r["workspace"] == "ghost-workspace" for r in rows), rows


def test_a_refused_create_leaves_no_note_behind(monkeypatch, tmp_path):
    """The write-ahead note is for a create that died HALF WAY, not one that never
    started.

    `record` then `_create_repro_locked` then `clear`, with no try/finally, so ANY
    refusal stranded the note -- a bad version, a taken port, the capacity preflight, a
    namespace-ownership check, a Kubernetes-unsupported flag -- one per attempt. Seven
    accumulated during the audit, three of them for the same never-created name. Worse
    than untidy: `doctor` then warns "the create started at ... never finished ...
    `houston ready --name X` completes it", and that command exits 4 NOT_FOUND. On a
    CLI-only box nothing ever clears them, because recovery runs at `serve` startup and
    `doctor` reports without repairing.
    """
    from houston.errors import ValidationError
    from houston.services import journal
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "_create_repro_locked",
                        lambda *a, **k: (_ for _ in ()).throw(
                            ValidationError("--https is not supported on kubernetes")))

    before = len(journal.open_entries())
    try:
        lc.create_repro(lc.CreateReq(version="8.5.1", name="refu"))
    except ValidationError:
        pass
    else:
        raise AssertionError("the refusal did not propagate")

    after = journal.open_entries()
    assert len(after) == before, (
        f"a refused create left {len(after) - before} note(s): "
        f"{[e.kind + ':' + e.workspace for e in after]}")


def test_ready_carries_the_seed_the_interrupted_create_asked_for(monkeypatch, tmp_path):
    """`ready` cleared the note and never ran the pending seed.

    The note says the workspace "may be running WITHOUT its preset configuration or
    seed data" and names `ready` as what completes it. `wait_and_finalize` ran
    post_ready -- recoverable, because meta.extra["post_ready"] is persisted -- and
    then `clear_kind`. It could not seed and did not say so: `req.seed` lived only in
    the dead process's CreateReq, `meta.extra["seed"]` is written only AFTER a seed
    succeeds, and `journal.record` was called with no detail at all although it accepts
    **detail.

    Verified live: SIGKILL an `up --wait --seed` once compose has detached, run `ready`,
    get "ready" and exit 0, and find the workspace holding two users and one channel --
    with the note gone. That is worse than leaving it, because the engineer follows the
    tool's own instruction, is told the workspace is complete, doctor agrees, and the
    evidence that anything was missing has been deleted.
    """
    from houston.services import journal
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    # 1. THE NOTE `create_repro` WRITES carries the request. That is where the detail
    #    was missing -- `journal.record` has always accepted **detail and was called
    #    with none -- so asserting on a hand-written note would prove nothing.
    seen: dict = {}

    def capture(*a, **k):
        for e in journal.open_entries():
            if e.kind == journal.CREATE_UNFINISHED and e.workspace == "halfmade":
                seen.update(e.detail)
        raise RuntimeError("stop here; the note has been read")

    monkeypatch.setattr(lc, "_create_repro_locked", capture)
    try:
        lc.create_repro(lc.CreateReq(version="8.5.1", name="halfmade", seed=True,
                                     seed_profile="standard"))
    except RuntimeError:
        pass
    assert seen.get("seed") is True, (
        f"the create's own note does not record that a seed was asked for: {seen}")
    assert seen.get("seed_profile") == "standard", seen

    ident = journal.record(journal.CREATE_UNFINISHED, "halfmade",
                           seed=True, seed_profile="standard", seed_stats=False)

    # 2. And `pending_seed` reads it back, so `ready` has something to act on. Only
    #    ABANDONED notes count: one whose owner is alive belongs to a create still
    #    running, and seeding under it would seed twice.
    import json as _json
    import os
    path = journal.journal_dir() / f"{ident}.json"
    doc = _json.loads(path.read_text())
    assert journal.pending_seed("halfmade") == {}, (
        "a note owned by a LIVE process was treated as pending work")
    doc["pid"] = 999999 if os.getpid() != 999999 else 999998
    doc["started"] = "1"
    path.write_text(_json.dumps(doc))

    pending = journal.pending_seed("halfmade")
    assert pending.get("seed") is True, pending
    assert pending.get("seed_profile") == "standard", pending
    # A create that asked for NO seed leaves nothing for `ready` to do.
    assert journal.pending_seed("never-existed") == {}


def test_an_explicitly_wide_bind_is_warned_about(monkeypatch, tmp_path):
    """`--bind 0.0.0.0` published fixed weak credentials and said nothing.

    The exposure warning fired only on `req.bind_public`, which houston sets ITSELF
    when it widens the bind for an ACME challenge -- so the derived case was announced
    and the case a person deliberately asked for was silent. Verified from the box's
    own LAN address: /api/info 200, and POST /api/v1/login with admin/admin123
    returning a full admin authToken, after an `up` that printed the normal panel with
    a URL reading `http://localhost:<port>`.

    `config.DEFAULT_BIND_HOST`'s comment states this threat model exactly and
    `errors.GATE_PUBLIC_EXPOSURE` was declared for it. The opt-in is deliberate and
    stays; being quiet about it was an omission, not a decision.
    """

    from houston.services import lifecycle as lc

    src = source_of(lc._create_repro_locked)
    # The derived branch, and the ASKED-FOR branch beside it.
    assert "req.bind_public and bind_host not in" in src
    assert "elif bind_host not in _LOOPBACK_BINDS:" in src, (
        "an explicitly requested wide bind still has no warning branch")
    after = src.split("elif bind_host not in _LOOPBACK_BINDS:", 1)[1][:2600]
    # The WARNING ITSELF, not the block around it. The comments there record the
    # defect this branch was written for and quote the old credential by name, so a
    # naive substring search over the block reports the history as if it were the
    # message -- which is how this assertion first failed against a correct fix.
    said = after.split('warn(emit,', 1)[1].split('phase="create")', 1)[0]
    for expected in ("trusted network", "--bind", "every interface"):
        assert expected in said, f"the wide-bind warning does not mention {expected!r}"
    # The CREDENTIALS half is deliberately no longer here. The Rocket.Chat admin is
    # generated for a bind this wide and printed on the panel two lines below, so
    # saying it again was a sentence people scroll past -- and a warning nobody reads
    # costs the NEXT warning its reader. What survives is what the panel does not
    # say: the preset's own UI, Grafana, and seeded users, each named only when the
    # create actually has one.
    assert "admin123" not in said, (
        "the panel prints the real password; repeating a wrong one is worse than "
        f"silent:\n{said}")
    assert "seeded users, whose password is their username" in after, (
        "the credential that is STILL weak must survive the trim")
    assert "req.seed" in after, "and be said only when there are seeded users"


def test_a_restore_retargets_site_url_at_the_workspace_it_landed_in(monkeypatch,
                                                                    tmp_path):
    """A restore is a full mongorestore, so the bundle brings its Site_Url with it.

    Measured: source on 3111, restored to 3000, `env` reporting
    ROOT_URL=http://localhost:3000 and `GET /api/v1/settings/Site_Url` answering
    http://localhost:3111 -- with /api/info then advertising
    `"workspaceUrl": "localhost:3111"` while serving on 3000. ROOT_URL does not
    override a stored setting.

    Wrong in exactly the field a restored workspace is usually restored to look at:
    Rocket.Chat derives email links, OAuth/SAML/OIDC redirect URIs, integration
    callbacks and mobile deep links from it -- and if the source is still running, all
    of them open the source. `configimport.py` denies Site_Url on import for this
    reason and the restore path had no equivalent.
    """

    from houston import rcapi
    from houston import runner
    from houston.services import backup, lifecycle as lc

    # FIRST, and by source: the pre-fix tree has no retarget step at all, and this must
    # fail for that reason rather than on a missing attribute name.
    assert "Site_Url" in source_of(backup), (
        "nothing in the restore path touches Site_Url - a bundle from another "
        "workspace still names that workspace")
    # `restore()` resolves the target and delegates; the work is in `_restore_locked`.
    assert "_retarget_site_url" in source_of(backup._restore_locked), (
        "the restore path does not retarget Site_Url")

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = lc.runner.Metadata(
        name="restored", project="houston-restored", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map")
    monkeypatch.setattr(runner, "read_meta", lambda n: meta)
    monkeypatch.setattr(lc, "login", lambda m: object())
    monkeypatch.setattr(backup.lifecycle, "login", lambda m: object())
    monkeypatch.setattr(rcapi, "get_setting",
                        lambda *a, **k: "http://localhost:3111")
    wrote: list = []
    monkeypatch.setattr(rcapi, "set_setting",
                        lambda url, auth, pw, key, val: wrote.append((key, val)) or True)

    said: list = []
    backup._retarget_site_url("restored", lambda ev: said.append(ev.message))

    assert wrote == [("Site_Url", "http://localhost:3000")], wrote
    assert any("3111" in m for m in said), said

    # A workspace whose Site_Url ALREADY matches is left alone -- this must not write
    # a setting on every restore into the same workspace.
    wrote.clear()
    monkeypatch.setattr(rcapi, "get_setting",
                        lambda *a, **k: "http://localhost:3000")
    backup._retarget_site_url("restored", lambda ev: None)
    assert wrote == [], wrote


def test_doctor_says_the_home_is_not_writable_rather_than_blaming_kind(monkeypatch,
                                                                       tmp_path):
    """A read-only HOUSTON_HOME passed `doctor` and surfaced as a kind problem.

    `home-perms` asks whether OTHER local users can read the accounts and sessions;
    nothing asked whether houston can write. So `list` and `doctor` exited 0 while
    `up` and `users add` raised a bare PermissionError -- and doctor's only mention of
    it was "Could not tell whether cluster 'houston-local' exists ([Errno 13]
    Permission denied) - kind needs Docker", because the error surfaced through the
    kind probe (which writes houston's own kubeconfig dir) and was attributed to
    Docker. The symptom was found and blamed on the wrong thing.
    """
    import os

    from houston.services import doctor as doctorsvc

    home = tmp_path / "ro-home"
    home.mkdir()
    os.chmod(home, 0o500)
    monkeypatch.setenv("HOUSTON_HOME", str(home))
    try:
        rows = doctorsvc.run_checks()["checks"]
    finally:
        os.chmod(home, 0o700)

    hits = [r for r in rows if r.get("check") == "home-writable"]
    assert hits, ("doctor reported no home-writable row on a home it cannot write: "
                  + str(sorted({r.get("check") for r in rows})))
    assert hits[0]["status"] == "fail", hits[0]
    assert "not writable" in hits[0]["message"], hits[0]["message"]
    assert "home-writable" in doctorsvc.CHECKS


def test_a_bad_settings_file_is_a_validation_error_not_a_traceback(tmp_path):
    """A customer dump is exactly the file that arrives wrong.

    Truncated by a download, HTML from an expired share link, or the whole support
    bundle instead of the settings file inside it. `json.loads` raised a bare
    `json.JSONDecodeError`, which is not a `ReproError` -- so the CLI printed a
    traceback and the web layer answered 500, where every other bad input in this path
    says what is wrong with the file.
    """
    import json as _json

    from houston import configimport

    html = tmp_path / "customer-settings.json"
    html.write_text("<html><body>Link expired</body></html>")
    try:
        configimport.build_plan(html)
    except ValueError as exc:
        assert not isinstance(exc, _json.JSONDecodeError), (
            "still the raw decoder error, which no front-end handles")
        assert "customer-settings.json" in str(exc), str(exc)
        assert "not valid JSON" in str(exc), str(exc)
        assert "HTML" in str(exc), "the commonest cause is not mentioned"
    else:
        raise AssertionError("a non-JSON dump was accepted")

    # And the service layer turns it into the typed error both front-ends render.
    from houston.errors import ValidationError
    from houston.services import data as datasvc
    try:
        datasvc._build_plan(str(html), None)
    except ValidationError:
        pass
    else:
        raise AssertionError("services/data.py did not type the failure")


def test_journal_timestamps_are_utc_like_every_other_record(tmp_path, monkeypatch):
    """`time.strftime` with no second argument is LOCAL time.

    So one event read 22:29 in a journal note and 16:59 in the repro.json written
    beside it -- and a note is read next to `doctor`, `list` and an audit line, all of
    which are UTC.
    """
    import time as _time

    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ident = journal.record(journal.RATE_LIMITER_OFF, "clocktest")
    entry = next(e for e in journal.open_entries() if e.id == ident)

    assert entry.at.endswith("Z"), f"not marked as UTC: {entry.at}"
    stamped = _time.strptime(entry.at, "%Y-%m-%dT%H:%M:%SZ")
    now = _time.gmtime()
    # Within a minute of UTC now. On a box whose local time is UTC this would pass
    # either way, so the "Z" assertion above is what actually pins it.
    assert abs(_time.mktime(stamped) - _time.mktime(now)) < 60, (entry.at,
                                                                _time.asctime(now))


def test_prune_waits_for_the_namespaces_it_swept_before_reclaiming_the_cluster():
    """`prune --orphans` needed running TWICE to give the cluster back.

    The sweep deletes with `--wait=false` and `_reclaim_cluster` ran immediately after
    in the same call, so `delete_cluster` refused -- correctly -- because the namespaces
    prune had just deleted were still Terminating. Observed: run 1 left houston-local
    and its control plane, run 2 twenty seconds later printed "the cluster is gone".
    About 600 MB survived the prune that had emptied it.
    """

    from houston.services import k8s
    from houston.services import lifecycle as lc

    src = source_of(lc.prune)
    assert "wait_namespace_gone" in src, (
        "prune still reclaims the cluster without waiting for its own sweep")
    # Ordered: the wait must come BEFORE the reclaim it guards, or it changes nothing.
    # `rindex`, because the FIRST `_reclaim_cluster` is the nothing-to-prune early
    # return -- there is no sweep to wait for on that path.
    assert source_index(src, "wait_namespace_gone") < src.rindex("_reclaim_cluster"), src
    assert callable(k8s.wait_namespace_gone)
    # Same bound as delete_namespace's own loop rather than a second opinion.
    assert "NS_GONE_TRIES" in source_of(k8s.wait_namespace_gone)


def test_use_resolves_the_name_like_every_other_command(monkeypatch, tmp_path):
    """`use` called `runner.exists()` on the literal argument.

    So `use TICKET-1234` failed on a workspace really named `ticket-1234` while
    `info --name TICKET-1234` found it -- and `name_candidates()`'s docstring is
    written about exactly that defect and says it was fixed. `use` was missed. On a box
    with accounts the owner-prefix half bites too: `up --name test` makes `alice-test`,
    and `use test` could not find it. Exit was 1, where the table says 4.
    """
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: list = []
    monkeypatch.setattr(lc, "resolve_name",
                        lambda n: seen.append(n) or "ticket-1234")

    res = CliRunner().invoke(cli.app, ["use", "TICKET-1234"])
    assert res.exit_code == 0, res.output
    assert seen == ["TICKET-1234"], "use did not go through resolve_name"
    assert "ticket-1234" in res.output, res.output
    from houston import config
    assert config.load_config().get("default_repro") == "ticket-1234"

    # And an unknown name exits 4, not 1.
    def missing(n):
        from houston.errors import NotFoundError
        raise NotFoundError(f"no repro named {n!r}")
    monkeypatch.setattr(lc, "resolve_name", missing)
    res = CliRunner().invoke(cli.app, ["use", "nope"])
    assert res.exit_code == 4, (res.exit_code, res.output)


def test_a_failed_cap_restore_keeps_its_note(monkeypatch, tmp_path):
    """`journal.clear(constrain_note)` sat ABOVE the restore that may fail.

    `constrain_mod.restore` RETURNS problems rather than raising, and the loop beside
    it exists to report them -- so a failed restore left the containers capped with the
    note already deleted, throwing away the prior values CONSTRAINTS_APPLIED carries
    for exactly that repair. Its three siblings in the same `finally` all clear after a
    successful restore; this one did not, at all four sites.
    """

    from houston import cli
    from houston.services import perf as perfsvc

    for fn in (perfsvc.run_loadtest, perfsvc.run_capacity, cli.loadtest, cli.capacity):
        src = source_of(fn)
        if "constrain_note" not in src:
            continue
        name = getattr(fn, "__name__", str(fn))
        # The clear must be guarded by the problem list, not unconditional.
        assert "if not _cap_problems:" in src, (
            f"{name} clears the constraints note unconditionally")
        assert source_index(src, "_cap_problems = constrain_mod.restore") \
            < source_index(src, "journal.clear(constrain_note)"), (
            f"{name} still clears the note before restoring")


def test_the_cli_records_the_seed_it_is_about_to_run(monkeypatch, tmp_path):
    """`cli.up` built `CreateReq(..., seed=False)` because it seeds itself afterwards.

    So the write-ahead note recorded `seed: False` with the profile defaulted, and
    `create_repro` cleared it before control returned -- which meant the `pending_seed`
    recovery landed in v0.72.2 covered the GUI and NOT `houston up --seed`, the
    invocation the README documents. Exactly the scenario lifecycle.py describes:
    "told the workspace is complete, doctor agrees, and the evidence that anything was
    missing has been deleted."
    """
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import journal
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    captured: dict = {}

    # The INNER function, so the real `create_repro` runs and actually writes the
    # write-ahead note -- stubbing `create_repro` itself would mean no note existed to
    # observe, which is a test that cannot see the thing it is about.
    def fake_locked(req, emit=None, stream_output=False):
        captured["req"] = req
        for e in journal.open_entries():
            if e.kind == journal.CREATE_UNFINISHED:
                captured["note"] = dict(e.detail)
        raise RuntimeError("stop before the CLI seeds")

    monkeypatch.setattr(lc, "_create_repro_locked", fake_locked)
    CliRunner().invoke(cli.app, ["up", "--version", "8.5.1", "--name", "sd",
                                 "--seed", "--seed-profile", "standard", "--offline"])

    req = captured.get("req")
    assert req is not None, "create_repro was never called"
    assert req.seed is True, "the CLI still hides its seed intent from the service"
    assert req.seed_profile == "standard", req.seed_profile
    # `seed_here` keeps the two-phase shape: the CLI runs the seed, so the service
    # must not, or the workspace would be seeded twice.
    assert req.seed_here is True, "seed_here not set; create_repro would seed too"

    note = captured.get("note")
    assert note, "no write-ahead note existed during the create"
    assert note.get("seed") is True, note
    assert note.get("seed_profile") == "standard", note


def test_create_repro_does_not_seed_when_the_caller_will():
    """`seed_here` exists so the two front-ends cannot both seed.

    The manifest only ever ADDS, so a double pass makes the readback report rooms
    holding more than planned and the second attempt collide on names it just created.
    """

    from houston.services import lifecycle as lc

    src = source_of(lc)
    assert "if req.seed and not req.seed_here:" in src, (
        "an in-service seed site is not guarded against seed_here")
    assert src.count("if req.seed and not req.seed_here:") == 3, (
        f"expected all 3 seed sites guarded, found "
        f"{src.count('if req.seed and not req.seed_here:')}")
    assert "if req.seed:\n        result[\"seed\"]" not in src, "an unguarded site remains"


def test_a_seed_is_serialised_like_every_other_mutation():
    """`run_seed_inline` was the only data-mutating operation with no `repro_lock`.

    `create_repro`, `set_state`, `teardown`, `set_env`, `monitor.attach`,
    `backup.create`, `upgrade.run`, `run_scale` and `clear_scale` all take it; a seed
    writes the same collections through a different door and took nothing.
    `run_scale`'s own comment states the rule -- "running it while a backup is dumping
    would put half of it in the archive" -- and the worse direction is the other one:
    `_Quiesced` STOPS Rocket.Chat for the dump, so a seed running into it fails
    mid-manifest and the readback reports faults nobody caused.
    """

    from houston.services import data as lc_data
    from houston.services import lifecycle as lc

    src = source_of(lc.run_seed_inline)
    assert "repro_lock" in src, "a seed still races every other mutator"
    # Reentrant per thread, so `up --seed` (which already holds it) is unaffected.
    assert "reentrant" in src.lower() or "re-entering" in src.lower()

    # And the seed is pooled: hundreds of REST writes against one workspace.
    from houston.web import jobs
    assert jobs._slots_for("seed") is not None, "seed submits unbounded"

    # CONFIG-IMPORT IS THE OTHER ONE, and it was missed right beside the seed: it
    # applies a customer dump's settings to a live workspace over REST and had
    # neither a lock nor a pool. Two on one workspace interleave setting by setting,
    # and one running into a backup's `_Quiesced` -- which stops Rocket.Chat for the
    # dump -- half-applies, leaving settings matching neither the dump nor the
    # workspace. Verified by reading it rather than assumed: an audit claimed
    # `data.py` already locked it, and the two locks there belong to run_scale and
    # clear_scale.
    src_import = source_of(lc_data.import_apply)
    assert "repro_lock" in src_import, "config-import still races every other mutator"
    assert jobs._slots_for("config-import") is not None, \
        "config-import submits unbounded"
    assert jobs._slots_for("config-import") is jobs._slots_for("seed"), \
        "the two data-mutating operations share one ceiling"

    # DOING AND UNDOING SHARE A CEILING. `scale` was pooled and `clear-scale` was not,
    # which bounds half the work -- the same asymmetry `monitor`/`monitor-off` was
    # fixed for, and `clear-scale` bulk-deletes through the same Mongo exec that
    # `scale` bulk-inserts through.
    for pair in (("scale", "clear-scale"), ("monitor", "monitor-off")):
        assert jobs._slots_for(pair[0]) is jobs._slots_for(pair[1]) is not None, pair

    # The reads stay unpooled ON PURPOSE, and this records why so it is a decision
    # rather than an oversight. `ready` is what the dashboard polls every few seconds:
    # a ceiling there queues the GUI's own refresh behind whatever else is running,
    # and the hazard an audit raised for it -- concurrent `ensure_port_forward` calls
    # recording pids for forwards that never bound -- is closed at the source, since
    # `port_forward` now returns 0 rather than a pid when it cannot get the socket.
    for cheap in ("env", "ready", "state"):
        assert jobs._slots_for(cheap) is None, (
            f"{cheap} is a read and pooling it queues the dashboard's own polling")


def test_the_monitor_job_is_pooled_and_the_walk_can_see_it():
    """`monitor` chose its kind with a ternary, and the pool walk skipped non-constant
    kinds BY CONSTRUCTION -- with a comment naming this very route as the case it
    skipped.

    So `monitor` sat outside every pool unnoticed, and `monitorsvc.attach` does a
    PULLING `runner.up`: Prometheus, Grafana, Loki, an OTel collector and two exporters.
    N members clicking Monitor was N pulling compose-ups on one engine, which is the
    failure the pool was added for.
    """
    from houston.web import jobs

    for kind in ("monitor", "monitor-off"):
        assert jobs._slots_for(kind) is not None, f"{kind} is unpooled"
    # Both resolve to the SAME pool, since they are the same work in two directions.
    assert jobs._slots_for("monitor") is jobs._slots_for("monitor-off")


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_a_job_that_dies_of_a_baseexception_does_not_stay_running_forever():
    """Only `ReproError` and `Exception` were caught.

    So anything else -- a KeyboardInterrupt delivered to the worker thread, a
    SystemExit from a library, a MemoryError -- left `status` at "running". That is in
    ACTIVE_STATUSES, so `_evict_locked` can never drop the job, `_trim_results` never
    releases its result, and the SSE stream never terminates: a browser tab holds the
    connection open waiting for an event that cannot arrive.
    """
    from houston.web import jobs

    reg = jobs.JobManager()

    def boom(emit=None):
        raise KeyboardInterrupt("delivered to the worker")

    job = reg.submit("ready", boom, label="x")
    reg.drain(timeout=15.0)

    got = reg.get(job.id)
    assert got is not None
    assert got.status not in jobs.ACTIVE_STATUSES, (
        f"status is {got.status!r} — the job is still active and can never be evicted")
    assert got.status == "error", got.status
    assert "KeyboardInterrupt" in (got.error or ""), got.error
    # The exception is RE-RAISED after being recorded, which is why pytest sees an
    # unhandled thread exception above: swallowing a BaseException is its own bug, and
    # the worker thread is ending either way. The warning is the cost of being honest.


def test_doctor_never_raises_out_of_a_bad_check_id():
    """A bare `assert` guarded a published contract.

    `doctor.CHECKS` is the registry of ids `doctor --json` publishes, and `line()`
    asserted membership. Asserts are stripped under `python -O`, so the guard vanishes
    exactly where a mis-declared id becomes unnoticeable -- and unstripped it raised
    AssertionError out of `GET /api/doctor`, which is a 500 and directly contradicts
    this function's own rule that a check must never break the report.
    """

    from houston.services import doctor as doctorsvc

    src = source_of(doctorsvc.run_checks)
    assert "assert cid in CHECKS" not in src, "still a bare assert"
    assert '"preflight"' in src, "no fallback id for an undeclared check"
    # `preflight` exists for "the report itself could not be assembled", so it is the
    # honest place for a row whose own id is broken.
    assert "preflight" in doctorsvc.CHECKS


def test_a_private_key_is_never_written_at_the_umask():
    """`atomic_write` wrote at the umask, and `certs/<host>.key` went through it.

    So the edge's leaf key landed 0644 on a box where `~/.houston` is only tightened to
    0700 by `serve` or a config save -- neither of which runs on a CLI-only
    `up --https`. And the local CA key is created by `openssl genrsa -out`, which makes
    the file at 0666 & ~umask with the chmod landing after it: a real, if brief,
    world-readable key that can mint a certificate for any name the browser trusts.
    """
    import tempfile
    from pathlib import Path

    from houston import runner
    from houston.services import edge as edgesvc

    # The mode is applied to the TEMP file, so the target never exists at the umask
    # even for an instant.
    src = source_of(runner.atomic_write)
    assert "mode: int | None" in src
    assert source_index(src, "os.chmod(tmp, mode)") < source_index(src, "os.replace(tmp, path)"), src

    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "k.key"
        runner.atomic_write(target, "secret", mode=0o600)
        assert oct(target.stat().st_mode)[-3:] == "600", oct(target.stat().st_mode)

    # And the edge passes it for the key but not the certificate, which is public.
    esrc = source_of(edgesvc.issue_local_cert)
    assert 'f"{host}.key", key_pem, mode=0o600' in esrc, esrc[-400:]

    # The CA directory is created 0700 before the key is generated in it.
    from houston import tls_local
    csrc = source_of(tls_local)
    assert "mkdir(parents=True, exist_ok=True, mode=0o700)" in csrc


def test_a_successful_signin_does_not_hand_back_the_whole_throttle_window():
    """One valid low-privilege credential reset the per-address failure window.

    So an attacker with any working account could sign in between rounds and start each
    batch of guesses against an admin name from zero. The bound is per address by design
    -- `services/users.py` cannot refuse on a counter without also refusing correct
    passwords -- so the reset has to be per address too; it just must not be total.
    """
    import houston.web.app as appmod

    with appmod._signin_lock:
        appmod._signin_fails.clear()
        appmod._signin_fails["1.2.3.4"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]

    appmod._signin_ok("1.2.3.4")
    left = appmod._signin_fails.get("1.2.3.4") or []
    assert left, "a success cleared the entire window"
    assert len(left) < 6, "a success changed nothing at all"
    # A legitimate user who mistyped once and then succeeded is unaffected.
    with appmod._signin_lock:
        appmod._signin_fails["5.6.7.8"] = [1.0]
    appmod._signin_ok("5.6.7.8")
    assert not appmod._signin_fails.get("5.6.7.8")
    with appmod._signin_lock:
        appmod._signin_fails.clear()


def test_an_absent_namespace_is_confirmed_gone_not_a_failure(monkeypatch):
    """`delete_namespace` returned False when the namespace did not exist.

    `teardown` reads that as "not confirmed gone", keeps the local record and says so
    -- which means a Kubernetes record whose namespace has ALREADY been removed can
    never be deleted. `down --volumes` refuses it every time, for ever, and `list` goes
    on showing a workspace that is not there.

    Reached the moment a cluster is recreated: `prune` reclaims the kind cluster, the
    next `up` builds a new one, and every record from the old cluster is now immortal.
    Reported from a live box exactly that way -- the record dated three days earlier,
    the cluster's namespaces eight minutes old.

    Introduced by the change that gave `namespace_labels` three answers rather than
    two. Splitting "I could not ask" from "it is not there" was right; wiring the second
    into the failure branch beside it was not.
    """
    from houston.services import k8s

    # None = the namespace does not exist. (Cannot-ask RAISES, and still does.)
    monkeypatch.setattr(k8s, "namespace_labels", lambda ns, *, context: None)
    monkeypatch.setattr(k8s, "is_ours", lambda c: True)

    assert k8s.delete_namespace("gone", context="c", volumes=True) is True, (
        "an absent namespace reported as not-confirmed-gone; the record can never go")

    # And the case this branch was written for is untouched: cannot-ask still raises,
    # so a wrong context or an RBAC denial never reads as "nothing to remove".
    #
    # `clusters()` is stubbed to report the cluster PRESENT. Without that, the
    # deleted-cluster path added later would see this box's real kind listing -- which
    # is empty -- prove the cluster gone and return True, which is right for a deleted
    # cluster and not what this half is about.
    from houston.errors import DockerError

    def cannot_ask(ns, *, context):
        raise DockerError("could not ask cluster 'c' about namespace")
    monkeypatch.setattr(k8s, "namespace_labels", cannot_ask)
    monkeypatch.setattr(k8s, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    try:
        k8s.delete_namespace("gone", context="c", volumes=True)
    except DockerError:
        pass
    else:
        raise AssertionError("an unreachable cluster was treated as an absent namespace")


def test_down_reports_the_result_not_the_flag(monkeypatch, tmp_path):
    """`down --volumes` printed "✓ removed" from the FLAG, not from the result.

    So a teardown that refused -- returning `removed: False` and emitting a warning
    saying the local record was deliberately KEPT -- was reported as complete success,
    exit 0. The GUI got it right because it streams the events; the CLI passed no
    `emit` at all, so the warning went nowhere and the success line printed over the
    top of it. `list` then kept showing the workspace, which is how somebody finds out.
    """
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "resolve_name", lambda *a, **k: "stuck")
    monkeypatch.setattr(lc, "owner_of", lambda *a, **k: "", raising=False)
    monkeypatch.setattr(lc, "may_destroy", lambda *a, **k: (True, ""), raising=False)

    def refuses(name, **kw):
        emit = kw.get("emit")
        if emit:
            from houston.services.events import Event
            emit(Event("'stuck': the namespace is not confirmed gone, so the local "
                       "record is KEPT.", phase="teardown", level="warn"))
        return {"name": "stuck", "removed": False, "found": False,
                "runtime": "kubernetes"}
    monkeypatch.setattr(lc, "teardown", refuses)

    res = CliRunner().invoke(cli.app, ["down", "--name", "stuck", "--volumes", "--yes"])

    assert res.exit_code != 0, (
        f"exit 0 on a refused teardown\n{res.output}")
    assert "was NOT removed" in res.output, res.output
    # The service's own reason reaches the terminal, which needs the emit to be passed.
    assert "not confirmed gone" in res.output, (
        f"the teardown's warning never reached the user\n{res.output}")
    assert "✓" not in res.output.split("was NOT removed")[0][-40:], res.output

    # And a teardown that SUCCEEDS still reports success.
    monkeypatch.setattr(lc, "teardown", lambda name, **kw: {
        "name": "ok", "removed": True, "found": True, "runtime": "kubernetes"})
    res = CliRunner().invoke(cli.app, ["down", "--name", "ok", "--volumes", "--yes"])
    assert res.exit_code == 0, res.output
    assert "removed" in res.output and "NOT removed" not in res.output, res.output


def test_a_deleted_cluster_lets_its_records_be_removed(monkeypatch):
    """A DELETED cluster is not an UNREACHABLE one, and the refusal could not tell.

    When a kind cluster is removed its kubeconfig entry survives, so `kubectl get ns`
    fails with "The connection to the server 127.0.0.1:39911 was refused" and
    `namespace_labels` raises -- correctly, because a cluster that is merely stopped
    genuinely cannot be asked, and collapsing that into "not there" once destroyed a
    live workspace's record.

    But a namespace cannot outlive the cluster it lived in. So there was NO WAY to
    delete the record of a workspace whose cluster had gone: the namespace query cannot
    answer, `teardown` refuses, and `doctor` reports the cluster missing for ever.
    Reported from a live box in exactly that state.
    """
    from houston.errors import DockerError
    from houston.services import k8s

    def refused(ns, *, context):
        raise DockerError("could not ask cluster 'kind-houston-local' about namespace "
                          "houston-x: The connection to the server 127.0.0.1:39911 "
                          "was refused")
    monkeypatch.setattr(k8s, "namespace_labels", refused)
    monkeypatch.setattr(k8s, "is_ours", lambda c: True)

    # The kind probe SUCCEEDED and the cluster is not in it -> provably gone.
    monkeypatch.setattr(k8s, "clusters", lambda: ([], ""))
    assert k8s.delete_namespace("x", context=k8s.CONTEXT, volumes=True) is True, (
        "a record whose cluster was deleted still cannot be removed")

    # The cluster IS there and merely unreachable -> still a refusal. This is the case
    # the guard was written for and it must not be weakened.
    monkeypatch.setattr(k8s, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    try:
        k8s.delete_namespace("x", context=k8s.CONTEXT, volumes=True)
    except DockerError:
        pass
    else:
        raise AssertionError("an unreachable but EXISTING cluster was treated as gone")

    # The probe itself failed (no Docker, no kind) -> also still a refusal: that is
    # "I could not ask" a second time, not evidence of absence.
    monkeypatch.setattr(k8s, "clusters", lambda: ([], "Cannot connect to the Docker daemon"))
    try:
        k8s.delete_namespace("x", context=k8s.CONTEXT, volumes=True)
    except DockerError:
        pass
    else:
        raise AssertionError("a failed kind probe was treated as proof of absence")

    # And a cluster houston does not own is never assumed gone on kind's word.
    monkeypatch.setattr(k8s, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s, "clusters", lambda: ([], ""))
    try:
        k8s.delete_namespace("x", context="some-remote", volumes=True)
    except DockerError:
        pass
    else:
        raise AssertionError("kind's listing was used to judge a foreign cluster")


def test_a_stale_kubernetes_record_is_a_warning_not_a_failed_preflight(monkeypatch,
                                                                      tmp_path):
    """`doctor` reported a missing cluster as a FAIL when any record referenced it.

    So the verdict read "Not ready — fix the ✗ item(s)" about a box that was completely
    usable: the next `up` builds a fresh cluster, and the stale record is a cleanup task
    rather than a broken machine. A verdict that fails on tidiness is one people stop
    reading. It is a warning now, and it names the command that clears the record --
    the place to learn about a stale record is the command that removes it.

    Driven through `run_checks` rather than by reading the source, so it asserts the
    STATUS a caller sees and the verdict it produces.
    """
    from houston import runner
    from houston.services import doctor as doctorsvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="ghost", project="houston-ghost", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map")
    meta.extra.update({"runtime": "kubernetes", "namespace": "houston-ghost",
                       "context": k8s.CONTEXT})
    monkeypatch.setattr(runner, "list_meta", lambda: [meta])

    # A box with the tools, no cluster, and one Kubernetes record pointing at it.
    pre = k8s.Preflight(
        tools={}, cluster_exists=False, cluster_reachable=False, storage_classes=[],
        default_storage_class="", ingress_classes=[], other_clusters=[], namespaces=[],
        distribution="kind", node_count=0, architectures=[], metrics=False,
        loadbalancer="", context=k8s.CONTEXT, provider="kind", will_create=True,
        probe_failed="")
    monkeypatch.setattr(k8s, "preflight", lambda *a, **k: pre)

    rows = doctorsvc.run_checks()["checks"]
    hits = [r for r in rows if r.get("check") == "kubernetes-cluster"]
    assert hits, sorted({r.get("check") for r in rows})
    row = hits[0]

    assert row["status"] == "warn", (
        f"a stale record still {row['status']}s the preflight: {row['message']}")
    assert "is gone" in row["message"], row["message"]
    # Actionable: names the record and the command that clears it.
    assert "ghost" in row["message"], row["message"]
    assert "houston down" in row["message"], row["message"]


def test_an_unproven_seed_does_not_pass_verify_seed(monkeypatch, tmp_path):
    """`--verify-seed` gated on `faults`, which is [] when the readback COULD NOT RUN.

    `check_seed` returns `{"ok": None, "faults": [], ...}` when it cannot read the
    workspace back -- a login failure, a 429, a workspace that stopped answering. So
    the flag whose entire job is to refuse an unverified seed exited 0 on a seed it had
    verified nothing about, and `_print_seed_verification` returned before printing
    anything, making it indistinguishable from a seed nobody asked to verify.

    The shipped agent skill states the rule the other way round and in bold: "Treat a
    false or missing `verification.ok` as unproven -- do not infer success from a 2xx
    write or an attempted message count."
    """

    from houston import cli

    src = source_of(cli._run_seed)
    # The unknown is gated BEFORE the faults check, and on `ok`, not on `faults`.
    assert 'verify and verdict.get("ok") is None' in src, (
        "--verify-seed still passes a readback that could not run")
    assert source_index(src, 'verdict.get("ok") is None') < source_index(src, 'verdict.get("faults")'), (
        "the unknown case must be judged before the fault list")
    assert "UNPROVEN" in src

    # And the renderer says something rather than nothing.
    rsrc = source_of(cli._print_seed_verification)
    assert "could not run" in rsrc, "an unrunnable readback still prints nothing"
    assert 'if not verdict or verdict.get("ok") is None:\n        return' not in rsrc

    # AND THE REASON REACHES THE USER. This first asserted that `check_seed` is passed
    # an `emit`, which pinned the mechanism rather than the property -- and the
    # mechanism was then correctly removed, because the service emits the same facts
    # the CLI renders and every line printed twice. The reason travels in the verdict
    # as `why` now, so what matters is that the renderer shows it.
    assert 'verdict.get("why")' in rsrc, (
        "the reason a readback could not run is not shown to anybody")
    from houston.services import lifecycle as lc
    csrc = source_of(lc.check_seed)
    assert '"why": str(exc)' in csrc, "check_seed does not record why it could not read back"


def test_prune_reads_the_same_answer_teardown_does(monkeypatch):
    """`prune` discarded `delete_namespace`'s answer and reported the workspace pruned.

    It then called `runner.remove(name)` unconditionally -- so a namespace that could
    NOT be deleted lost the only local record that knew about it, while it and its
    PersistentVolumeClaim went on running. That is precisely the defect v0.70.9 fixed in
    `teardown`, left standing twenty lines away in the same file.
    """

    from houston.services import lifecycle as lc

    src = source_of(lc.prune)
    assert "if not k8s.delete_namespace(" in src, (
        "prune still removes the record without checking the namespace went")
    # The record removal must be AFTER the check, not before it.
    assert source_index(src, "if not k8s.delete_namespace(") < source_index(src, "runner.remove(name)")
    assert "was NOT pruned" in src, "prune does not say when it kept a record"
    # And the cluster reclaim reports a namespace that would not go.
    assert "if not k8s.wait_namespace_gone(" in src, (
        "prune drops the wait's answer, so the single-pass reclaim degrades silently")


def test_ending_a_session_that_had_already_ended_is_not_a_success(monkeypatch, tmp_path):
    """`revoke_sid` returns False when the sid is not in the store, and the route
    answered `{"ok": true, "ended": 1}` regardless.

    Reachable as a race: a session can expire between the `list_for` lookup and the
    revoke. A sign-out that revoked nothing should not report that it did.
    """

    import houston.web.app as appmod

    src = source_of(appmod.build_app) if hasattr(appmod, "build_app") \
        else pathlib_read()
    assert "if not sessions.revoke_sid(" in src, (
        "a failed session revoke is still reported as success")


def pathlib_read():
    import pathlib
    import houston.web.app as appmod
    return pathlib.Path(appmod.__file__).read_text()


def test_the_event_log_never_writes_a_credential(monkeypatch, tmp_path):
    """The one way this feature can make things WORSE rather than better.

    Before it, credentials lived in memory and on stdout. After it there is a FILE, so a
    hole in the redaction creates an exposure that did not exist. Terminal events carry
    the whole result document, the token/pat/env paths hold live credentials, and
    `MONGO_URL` carries a password in its VALUE -- which is why `_URL_USERINFO` exists
    and why matching on key names alone is not enough.
    """
    import json

    from houston.services import eventlog
    from houston.services.events import Event

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    eventlog._DISABLED = False
    eventlog._SIZE = None

    eventlog.event(Event(
        "connecting to mongodb://admin:s3cr3t-pw@mongodb:27017/rocketchat",
        phase="boot",
        data={
            "MONGO_URL": "mongodb://rcuser:another-secret@mongodb:27017/rc",
            "LDAP_BIND_PASSWORD": "bind-me",
            "OAUTH_CLIENT_SECRET": "shh",
            "api_key": "AKIAEXAMPLE",
            "result": {"authToken": "live-token", "nested": {"password": "deep"}},
            "token": "another-live-token",
            "harmless": "rocketchat",
        }))
    text = eventlog.log_path().read_text()

    for leaked in ("s3cr3t-pw", "another-secret", "bind-me", "shh", "AKIAEXAMPLE",
                   "live-token", "another-live-token", "deep"):
        assert leaked not in text, f"{leaked!r} was written to the log"
    # Redacted, not simply dropped: the shape of the event is still readable.
    doc = json.loads(text.strip().splitlines()[-1])
    assert doc["data"]["harmless"] == "rocketchat"
    assert doc["data"]["LDAP_BIND_PASSWORD"] == "********"
    assert "result" not in doc["data"] and "token" not in doc["data"]
    # The URL's userinfo is redacted in the MESSAGE too, where no key name exists.
    assert "mongodb://admin:********@" in doc["msg"], doc["msg"]


def test_events_imports_standalone_so_the_log_cannot_cycle():
    """The failure mode that would break every command at startup.

    `services/events.py` deliberately imports nothing from `houston` and is imported by
    thirteen modules. `eventlog` reaches `config` for the path and `lifecycle` for the
    redaction helpers, and `lifecycle` imports `events`. A module-level import in the
    tee is a circular import, and the symptom is not a subtle bug -- it is every command
    failing to start.
    """
    import ast
    import pathlib
    import subprocess
    import sys

    from houston.services import events

    tree = ast.parse(pathlib.Path(events.__file__).read_text())
    top = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    for node in top:
        mod = getattr(node, "module", "") or ""
        names = [a.name for a in node.names]
        assert not mod.startswith("houston"), (
            f"events.py imports {mod} at module level — that is the cycle")
        assert not any(n.startswith("houston") for n in names), names

    # And proven by import, in a fresh interpreter, with nothing else loaded first.
    root = str(pathlib.Path(events.__file__).parent.parent.parent)
    proc = subprocess.run(
        [sys.executable, "-c", "import houston.services.events; print('ok')"],
        capture_output=True, text=True, timeout=60,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": root, "HOME": "/tmp"})
    assert proc.returncode == 0 and "ok" in proc.stdout, proc.stderr[-400:]


def test_the_event_log_is_bounded_private_and_silent(monkeypatch, tmp_path):
    """Three properties that stop a log becoming its own problem."""
    import os

    from houston.services import eventlog
    from houston.services.events import Event

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setenv("HOUSTON_LOG_MAX_MB", "0.002")     # ~2 KB, to rotate quickly
    eventlog._DISABLED = False
    eventlog._SIZE = None

    for i in range(400):
        eventlog.event(Event(f"line {i} " + "x" * 60, phase="boot"))

    cur = eventlog.log_path()
    old = cur.with_suffix(cur.suffix + ".1")
    assert cur.exists() and old.exists(), "did not rotate"
    # TWO files, not a growing family.
    assert len(list(cur.parent.glob("houston.log*"))) == 2, sorted(cur.parent.iterdir())
    assert oct(cur.stat().st_mode)[-3:] == "600", oct(cur.stat().st_mode)
    assert oct(cur.parent.stat().st_mode)[-3:] == "700", oct(cur.parent.stat().st_mode)

    # An unwritable home DISABLES it and never raises -- the operation being described
    # matters more than describing it.
    ro = tmp_path / "ro"
    ro.mkdir()
    os.chmod(ro, 0o500)
    monkeypatch.setenv("HOUSTON_HOME", str(ro))
    monkeypatch.delenv("HOUSTON_LOG_MAX_MB", raising=False)
    eventlog._DISABLED = False
    eventlog._SIZE = None
    try:
        eventlog.event(Event("into a read-only home", phase="boot"))
        assert eventlog._DISABLED is True, "a failed write did not disable the log"
    finally:
        os.chmod(ro, 0o700)
        eventlog._DISABLED = False
        eventlog._SIZE = None


def test_dockers_echo_stays_out_but_warnings_never_do(monkeypatch, tmp_path):
    """`_up` turns every line of `docker compose pull` into an event.

    A GUI create emits several hundred "Downloading 45.09MB" records -- echo, not
    narrative. Logging it buries the four lines that matter and spends the whole size
    cap on one create. A warning or an error is never skipped, echo or not.
    """

    from houston.services import eventlog
    from houston.services import lifecycle as lc
    from houston.services.events import Event

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    eventlog._DISABLED = False
    eventlog._SIZE = None

    eventlog.event(Event("Downloading 45.09MB", phase="boot", data={"echo": "docker"}))
    eventlog.event(Event("resolved 8.5.1", phase="create"))
    eventlog.event(Event("pull failed: rate limit", phase="boot", level="warn",
                         data={"echo": "docker"}))
    text = eventlog.log_path().read_text()

    assert "Downloading 45.09MB" not in text, "docker echo reached the log"
    assert "resolved 8.5.1" in text
    assert "rate limit" in text, "a WARNING was skipped because it carried echo"

    # Opt back in when somebody is debugging a pull.
    monkeypatch.setenv("HOUSTON_LOG_ECHO", "1")
    eventlog.event(Event("Downloading 99MB", phase="boot", data={"echo": "docker"}))
    assert "Downloading 99MB" in eventlog.log_path().read_text()

    # And the tag really is applied at the one place that produces the echo.
    assert 'echo="docker"' in source_of(lc._up)


# --- the per-workspace admin password -----------------------------------------
# `config.ADMIN_PASSWORD` is `admin123` and `config.DEFAULT_BIND_HOST`'s own comment
# states why that is acceptable: nothing outside this machine can reach a loopback
# workspace. `--domain` removes that premise -- the edge answers for a name anybody
# on the internet can resolve -- and the credential did not change with it.

def _pin_edge(monkeypatch):
    """The edge, stubbed at its Docker seam.

    `foreign_edge` and `ensure_running` both shell out, and on a developer box with a
    real edge running the preflight answers truthfully and refuses the create -- so
    these tests would pass or fail by machine. Nothing in this suite needs Docker.
    """
    monkeypatch.setattr(lc.edgesvc, "foreign_edge", lambda: "")
    monkeypatch.setattr(lc.edgesvc, "ensure_running",
                        lambda **k: type("S", (), {"ok": True, "why": "", "started": True,
                                                   "note": ""})())
    monkeypatch.setattr(lc.edgesvc, "register", lambda *a, **k: False)
    monkeypatch.setattr(lc.edgesvc, "issue_local_cert", lambda *a, **k: None)
    monkeypatch.setattr(lc.edgesvc, "host_owner", lambda *a, **k: "")


def _capture_create(monkeypatch):
    """The create path with Docker stubbed at the seam, capturing record + compose."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen: dict = {}
    monkeypatch.setattr(lc.runner, "docker_available", lambda **_k: True)
    monkeypatch.setattr(lc.runner, "exists", lambda _n: False)
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "check_sidecar_ports", lambda *a, **k: None)
    monkeypatch.setattr(lc, "pick_host_port", lambda *a, **k: 3001)
    _real = lc.versions.resolve
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: _real(v, offline=True))
    monkeypatch.setattr(lc.runner, "write",
                        lambda name, yaml_, meta, files=None:
                        seen.update(meta=meta, yaml=yaml_))
    monkeypatch.setattr(lc, "_up", lambda *a, **k: 0)
    return seen


def test_a_loopback_workspace_keeps_the_shared_password(monkeypatch):
    """Nothing off this box can reach it, which is the entire reason `admin123` is
    acceptable. Rotating it here would cost every runbook and buy nothing."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen = _capture_create(monkeypatch)
    lc.create_repro(lc.CreateReq(version="8.5.1", name="loop", wait=False),
                    emit=lc.null_emit)
    assert seen["meta"].admin_password == "", "empty means the shared default"
    assert seen["meta"].admin_pass == config.ADMIN_PASSWORD
    assert "admin123" in seen["yaml"]


def test_a_public_name_gets_a_password_of_its_own(monkeypatch):
    """THE DEFECT. A name anybody on the internet can resolve was created running
    the same `admin123` every loopback workspace runs."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen = _capture_create(monkeypatch)
    monkeypatch.setattr(lc, "_resolve_tls", lambda req, name, bind, **k:
                        tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com",
                                       port=443, acme_email="ops@example.com"))
    _pin_edge(monkeypatch)
    lc.create_repro(lc.CreateReq(version="8.5.1", name="pub", wait=False,
                                 domain="a.example.com", acme_email="ops@example.com"),
                    emit=lc.null_emit)
    pw = seen["meta"].admin_password
    assert pw and pw != config.ADMIN_PASSWORD, f"still the shared one: {pw!r}"
    assert len(pw) >= 20, f"120 bits through token_urlsafe is 20 chars, got {pw!r}"
    assert seen["meta"].admin_pass == pw


def test_the_compose_document_provisions_the_password_that_was_recorded(monkeypatch):
    """The one invariant that makes the rest true. The compose document is what
    actually creates the admin, so a password written to repro.json and not to
    ADMIN_PASS would be a stored credential for a login that does not exist -- and
    every command reads the record, so ALL of them would 401 against a workspace
    whose real password is `admin123`."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen = _capture_create(monkeypatch)
    monkeypatch.setattr(lc, "_resolve_tls", lambda req, name, bind, **k:
                        tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="b.example.com",
                                       port=443, acme_email="ops@example.com"))
    _pin_edge(monkeypatch)
    lc.create_repro(lc.CreateReq(version="8.5.1", name="pair", wait=False,
                                 domain="b.example.com", acme_email="ops@example.com"),
                    emit=lc.null_emit)
    pw = seen["meta"].admin_password
    assert pw
    assert f"ADMIN_PASS: {pw}" in seen["yaml"] or pw in seen["yaml"], \
        "the record and the compose document disagree about the admin password"
    assert "admin123" not in seen["yaml"], "the old one must not also be in there"


def test_binding_wide_generates_one_too(monkeypatch):
    """`--bind 0.0.0.0` removes the same premise by the other mechanism, and the
    bind path is the one that already warned -- so it must not be the one left
    handing `admin123` to the LAN."""
    from houston import config, tls as tlsmod  # noqa: F401
    seen = _capture_create(monkeypatch)
    lc.create_repro(lc.CreateReq(version="8.5.1", name="wide", wait=False,
                                 bind="0.0.0.0"), emit=lc.null_emit)
    assert seen["meta"].admin_password != ""


def test_two_public_workspaces_do_not_share_a_password(monkeypatch):
    """Per WORKSPACE. One password for every public workspace on the box would make
    a single leak the whole box, which is the property being bought here."""
    from houston import config, tls as tlsmod  # noqa: F401
    made = []
    for i, host in enumerate(("c1.example.com", "c2.example.com")):
        seen = _capture_create(monkeypatch)
        monkeypatch.setattr(lc, "_resolve_tls", lambda req, name, bind, _h=host, **k:
                            tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host=_h, port=443,
                                           acme_email="ops@example.com"))
        _pin_edge(monkeypatch)
        lc.create_repro(lc.CreateReq(version="8.5.1", name=f"multi{i}", wait=False,
                                     domain=host, acme_email="ops@example.com"),
                        emit=lc.null_emit)
        made.append(seen["meta"].admin_password)
    assert made[0] and made[1] and made[0] != made[1]


def test_reachable_beyond_loopback_is_the_whole_decision():
    """Both mechanisms, and the one that looks public and is not.

    A local-CA `--https` name resolves to 127.0.0.1. Treating it as exposed would
    rotate the password for the ordinary local case -- the common one -- for nothing.
    """
    from houston import config, tls as tlsmod  # noqa: F401
    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    local = tlsmod.TlsSpec(mode=tlsmod.MODE_LOCAL, host="x.houston.localhost", port=443)
    assert lc.reachable_beyond_loopback(tlsspec=acme, bind_host="127.0.0.1")
    assert lc.reachable_beyond_loopback(tlsspec=None, bind_host="0.0.0.0")
    assert lc.reachable_beyond_loopback(tlsspec=None, bind_host="192.168.1.5")
    assert not lc.reachable_beyond_loopback(tlsspec=local, bind_host="127.0.0.1")
    assert not lc.reachable_beyond_loopback(tlsspec=None, bind_host="127.0.0.1")
    assert not lc.reachable_beyond_loopback(tlsspec=None, bind_host="::1")
    assert not lc.reachable_beyond_loopback(tlsspec=None, bind_host="")


def test_a_record_written_before_the_field_existed_still_works(tmp_path, monkeypatch):
    """BACK-COMPAT, and it is not cosmetic: a workspace made by an older houston
    really does run `admin123`, so the fallback is a statement of fact about that
    workspace, not a default."""
    from houston import config, tls as tlsmod  # noqa: F401
    import json

    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ws = runner.workspace("old")
    ws.mkdir(parents=True)
    (ws / "repro.json").write_text(json.dumps({
        "name": "old", "project": "houston-old", "rc_version": "6.5.3",
        "rc_image": "registry.rocket.chat/rocketchat/rocket.chat", "mongo_tag": "5.0",
        "mongo_flavor": "bitnami-legacy", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001,
        "version_source": "shipped"}), encoding="utf-8")
    meta = runner.read_meta("old")
    assert meta.admin_password == ""
    assert meta.admin_pass == "admin123"


def test_the_detail_payload_carries_the_workspace_password(tmp_path, monkeypatch):
    """What both front-ends read. The GUI's detail panel renders `login` with a copy
    button and the create dialog's result box shows the same dict, so a generated
    password reaches a browser-only operator through this one key -- which is also
    the payload-shape trap `_fake_detail` exists for."""
    from houston import config, tls as tlsmod  # noqa: F401
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="d", project="houston-d", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3001", host_port=3001, version_source="live",
        admin_password="s3cret-generated-value")
    assert lc._summary(meta)["login"] == {"user": "admin",
                                          "password": "s3cret-generated-value"}
    # And an older record still reports the password its Rocket.Chat really runs.
    meta.admin_password = ""
    assert lc._summary(meta)["login"]["password"] == "admin123"


def test_a_stale_edge_route_is_not_told_to_run_down(tmp_path, monkeypatch):
    """`down --name <it>` CANNOT remove a route whose workspace is gone -- the
    workspace is the missing half, so `down` answers "no such workspace" and the
    route stays exactly where it was.

    Found by running `houston doctor` against a home in that state and following
    its own advice. The route survives, the hostname goes on 502ing, and the name
    cannot be reused. `edge delete` takes the HOSTNAME, which is the part that still
    exists, and takes the certificate and private key with it.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import edge as edgesvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    edgesvc.write(edgesvc.Edge(domain="support.example.com",
                               acme_email="ops@example.com"))
    edgesvc.register("ghost", "ghost.example.com", local=True)
    monkeypatch.setattr(edgesvc, "running", lambda: True)
    monkeypatch.setattr(edgesvc, "config_drift", lambda: ([], []))
    monkeypatch.setattr(edgesvc, "attached_networks", lambda: set())
    monkeypatch.setattr(edgesvc, "port_holder", lambda p=443: "")

    rows = doctorsvc.run_checks()["checks"]
    said = " ".join(r["message"] for r in rows if "no workspace" in r["message"])
    assert said, "the stale route must still be reported"
    assert "edge delete ghost.example.com" in said, said
    assert "down --name" not in said, f"advice that cannot work: {said}"


# --- helm and kubectl are two clients ------------------------------------------

def test_helm_reachable_reports_what_helm_said(monkeypatch):
    """It returns the LINE, not a boolean. "helm cannot reach the cluster" sends a
    reader to the cluster; `x509: certificate signed by unknown authority` sends them
    to the kubeconfig, which is where the problem actually was."""
    from houston.services import k8s

    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({"helm list": (
        1, "")}))
    assert k8s.helm_reachable("default")           # non-empty == a problem

    monkeypatch.setattr(k8s, "run", _fake_run({"helm list": (0, "")}))
    assert k8s.helm_reachable("default") == "", "a working helm says nothing"


def test_a_missing_helm_is_not_reported_as_an_unreachable_cluster(monkeypatch):
    """There is already a tools check for that, and two rows about one binary is how
    a reader learns to distrust both."""
    from houston.services import k8s

    monkeypatch.setattr(k8s, "which", lambda t: "" if t == "helm" else f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run",
                        lambda *a, **k: pytest.fail("must not run a missing helm"))
    assert k8s.helm_reachable("default") == ""


def test_a_create_refuses_when_helm_cannot_reach_the_cluster_kubectl_can(monkeypatch,
                                                                        tmp_path):
    """THE DEFECT, and it cost four minutes each time.

    houston drives kubectl AND helm; they resolve their configuration differently --
    `helm_env` gives helm houston's HELM_* homes while leaving KUBECONFIG to whoever
    owns the cluster -- and only kubectl was ever asked. Measured on a box whose
    `~/.kube/config` carried the server CA and client certificate of a PREVIOUS
    install of the same cluster: kubectl was entirely happy (`get ns`, `auth whoami`
    as system:admin, the whole MongoDB phase) and helm refused every call. So the
    create built a namespace, a StatefulSet, a PersistentVolume and an initiated
    replica set, then died at the chart and rolled all of it back:

        create failed — removing namespace houston-k8slive
        error: helm install failed: Error: kubernetes cluster unreachable: Get
        "https://127.0.0.1:6443/version": tls: failed to verify certificate: x509:
        certificate signed by unknown authority

    An error naming neither the cause nor the cure, for a condition readable in one
    second. A refusal here leaves nothing -- the gate this codebase applies to every
    other read-only precondition on this path.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.runner, "docker_available", lambda **_k: True)
    monkeypatch.setattr(lc.runner, "exists", lambda _n: False)
    monkeypatch.setattr(lc, "check_capacity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "pick_host_port", lambda *a, **k: 3001)
    _real = lc.versions.resolve
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: _real(v, offline=True))
    monkeypatch.setattr(k8s, "ensure_kubeconfig", lambda plan, emit=None: "default")
    monkeypatch.setattr(k8s, "helm_reachable",
                        lambda ctx: 'Error: kubernetes cluster unreachable: '
                                    'x509: certificate signed by unknown authority')
    # Anything that would BUILD is a failure of the gate, not of the stub.
    monkeypatch.setattr(k8s, "assert_namespace_available",
                        lambda *a, **k: pytest.fail("gate ran too late"))
    monkeypatch.setattr(k8s, "create_workspace",
                        lambda **k: pytest.fail("a namespace was built anyway"))
    # `plan_cluster` lives on k8s, and lifecycle calls it as `k8s.plan_cluster()` --
    # patching the name on `lc` would have patched nothing and the test would have
    # passed against the real cluster on whatever box it ran.
    monkeypatch.setattr(k8s, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context="default", distribution="k3s", create=False))

    with pytest.raises(errors.ValidationError) as exc:
        lc.create_repro(lc.CreateReq(version="8.5.1", name="hg",
                                     runtime="kubernetes", wait=False),
                        emit=lc.null_emit)
    said = str(exc.value)
    assert "helm cannot reach cluster" in said, said
    assert "although kubectl can" in said, said
    # The CURE, named. This is the whole difference from the error it replaces.
    assert "previous install of the same cluster" in said, said
    assert "/etc/rancher/k3s/k3s.yaml > ~/.kube/config" in said, said
    assert "kind export kubeconfig" in said, said
    assert "doctor" in said, said


def test_doctor_fails_when_helm_cannot_reach_a_cluster_kubectl_can(monkeypatch,
                                                                  tmp_path):
    """FAIL, not warn: every Kubernetes create on this box is broken until it is
    fixed, and the tick doctor used to print beside it is what sent a reader looking
    at the chart instead of the kubeconfig."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": [{"metadata": {"name": "standard",'
                                ' "annotations": {"storageclass.kubernetes.io/'
                                'is-default-class": "true"}}}]}'),
        "get ingressclass": (0, ""),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
        # THE ONE THAT DISAGREES.
        "helm list": (1, "Error: kubernetes cluster unreachable: x509: certificate "
                         "signed by unknown authority"),
    }))
    rows = doctor.run_checks()["checks"]
    hit = [r for r in rows if "helm cannot reach" in r["message"]]
    assert hit, [r["message"][:60] for r in rows]
    assert hit[0]["status"] == "fail", hit
    assert "kubectl can" in hit[0]["message"]
    assert "roll back" in hit[0]["message"]


# --- the Kubernetes audit's findings (K-01 .. K-24) -----------------------------

def _cluster_env(monkeypatch, *, reachable, held):
    """houston's own kind cluster, present, with `held` workspace namespaces."""
    from houston.services import k8s
    calls: list = []
    monkeypatch.setattr(k8s, "run",
                        lambda argv, **kw: calls.append(argv) or _completed(0))
    monkeypatch.setattr(k8s, "which", lambda b: "/usr/bin/kind")
    monkeypatch.setattr(k8s, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    monkeypatch.setattr(k8s, "cluster_context", lambda: "kind-houston-local")
    monkeypatch.setattr(k8s, "reachable", lambda ctx, **kw: reachable)
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx=None: held)
    return calls


def test_an_unreachable_cluster_is_never_treated_as_an_empty_one(monkeypatch):
    """K-01. `delete_cluster`'s whole ownership guard lived inside
    `if not force and reachable(context)`, so an unreachable cluster skipped it --
    including the "could not read" refusal written for exactly that case.

    `kind delete` talks to Docker, so unreachability was no obstacle: a paused
    control plane holding live workspaces was deleted by one `prune --yes`, with the
    prompt calling the cluster empty. A cluster nobody can reach is the case houston
    knows LEAST about, not most.
    """
    from houston.services import k8s

    # Holds a workspace and cannot be reached: the worst case, and the one that used
    # to delete it.
    calls = _cluster_env(monkeypatch, reachable=False, held=["houston-victim"])
    assert k8s.cluster_reclaimable() is False
    with pytest.raises(errors.ConflictError, match="not answering"):
        k8s.delete_cluster()
    assert not [a for a in calls if "delete" in a and "cluster" in a], \
        "the cluster was deleted without its contents ever being read"

    # Empty but unreachable: still refused — "empty" is not something we know.
    _cluster_env(monkeypatch, reachable=False, held=[])
    assert k8s.cluster_reclaimable() is False
    with pytest.raises(errors.ConflictError):
        k8s.delete_cluster()

    # Reachable and genuinely empty: the legitimate reclaim still works.
    calls = _cluster_env(monkeypatch, reachable=True, held=[])
    assert k8s.cluster_reclaimable() is True
    assert k8s.delete_cluster() is True
    assert [a for a in calls if "delete" in a and "cluster" in a]

    # Reachable and occupied: refused, naming what it holds.
    _cluster_env(monkeypatch, reachable=True, held=["houston-victim"])
    with pytest.raises(errors.ConflictError, match="still holds"):
        k8s.delete_cluster()

    # --force is still the way through a wedged one.
    calls = _cluster_env(monkeypatch, reachable=False, held=["houston-victim"])
    assert k8s.delete_cluster(force=True) is True


def test_an_orphaned_namespace_owned_by_someone_else_is_left_alone(monkeypatch,
                                                                   tmp_path):
    """K-02. `prune --orphans` deleted a stray namespace and its PVC without ever
    reading `houston.io/owner` -- and a stray is by definition what a colleague's
    workspace looks like from here, since their repro.json is on their machine.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc, "prunable", lambda: [])
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc.auditsvc, "actor", lambda: "me")
    monkeypatch.setattr(lc, "_orphan_context", lambda: "c")
    monkeypatch.setattr(lc, "orphan_namespaces",
                        lambda *a, **kw: ["houston-hers", "houston-mine",
                                          "houston-unreadable"])
    monkeypatch.setattr(lc, "_reclaim_cluster", lambda emit: False)
    owners = {"houston-hers": "alice", "houston-mine": "me",
              "houston-unreadable": None}
    monkeypatch.setattr(k8s, "namespace_owner",
                        lambda ns, **kw: owners[ns])
    monkeypatch.setattr(k8s, "wait_namespace_gone", lambda *a, **kw: True)
    deleted: list[str] = []
    monkeypatch.setattr(k8s, "run",
                        lambda argv, **kw: (deleted.append(argv[-2])
                                            if "delete" in argv else None)
                        or _completed(0))

    out = lc.prune(confirm=True, orphans=True)
    assert deleted == ["houston-mine"], deleted
    assert out["orphans"] == ["houston-mine"]

    # --force is the documented way to take them anyway.
    deleted.clear()
    out = lc.prune(confirm=True, orphans=True, force=True)
    assert sorted(deleted) == ["houston-hers", "houston-mine",
                               "houston-unreadable"], deleted


def test_an_unreadable_workspace_is_not_offered_for_deletion_as_down(monkeypatch,
                                                                     tmp_path):
    """K-03. `workload_exists` returned `rc == 0 and stdout`, so a refused read was
    indistinguishable from "the workload is not there" -- and `prunable()` listed a
    LIVE workspace under "these down repros will be deleted, containers, data volumes
    and records". Measured against a workspace serving 200 at the time.
    """
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    ws = lc.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(json.dumps(asdict(m)), encoding="utf-8")

    # A refused read: non-zero exit, no stdout -- exactly what an RBAC denial or a
    # wrong context produces.
    monkeypatch.setattr(k8s, "run", lambda *a, **kw: _completed(1, err="forbidden"))
    with pytest.raises(errors.DockerError, match="could not ask"):
        k8s.workload_exists("k", context="c")
    assert lc.prunable() == [], \
        "a workspace nobody could read was offered for deletion as `down`"


def test_one_unreadable_workspace_does_not_abort_the_whole_prune(monkeypatch,
                                                                 tmp_path):
    """K-04. `prune` caught ConflictError but not the DockerError `delete_namespace`
    raises, so the first unreadable workspace ended the run and every later one was
    silently left -- the reported "prune doesn't work"."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc, "orphan_namespaces", lambda *a, **kw: [])
    monkeypatch.setattr(lc, "_reclaim_cluster", lambda emit: False)
    monkeypatch.setattr(lc, "prunable", lambda: ["bad", "good"])
    monkeypatch.setattr(lc.topology, "of_repro", lambda n: lc.topology.DOCKER)
    monkeypatch.setattr(lc.edgesvc, "detach", lambda n: None)
    monkeypatch.setattr(lc.edgesvc, "deregister", lambda n: None)
    removed: list[str] = []
    monkeypatch.setattr(lc.runner, "remove", lambda n: removed.append(n))
    monkeypatch.setattr(lc, "_clear_default_if", lambda n: None)

    def down(name, **kw):
        if name == "bad":
            raise errors.DockerError("could not ask the cluster")
        return 0
    monkeypatch.setattr(lc.runner, "down", down)

    out = lc.prune(confirm=True, only=["bad", "good"])
    assert out["removed"] == ["good"], \
        "the unreadable workspace ended the sweep instead of being skipped"


def test_a_wedged_workspace_is_not_reported_as_starting_for_ever(monkeypatch):
    """K-09. Everything not ready read as `starting`, which promises that something
    is coming. For a pod in ImagePullBackOff or a `pending-install` release nothing
    is, and both facts were already available -- `terminal_pod_failure` named the pod,
    the reason and the message while `list` printed "starting" beside it.
    """
    import types

    from houston.services import k8s

    meta = types.SimpleNamespace(extra={"context": "c"})
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx=None: ["houston-k"])
    monkeypatch.setattr(k8s, "workload_exists", lambda n, **kw: True)
    monkeypatch.setattr(k8s, "desired_replicas", lambda n, **kw: 1)
    monkeypatch.setattr(k8s, "workspace_ready", lambda n, **kw: False)
    monkeypatch.setattr(k8s, "release_state", lambda *a, **kw: ("deployed", 1))

    monkeypatch.setattr(k8s, "terminal_pod_failure", lambda n, **kw: None)
    assert lc.kubernetes_state("k", meta) == "starting"

    monkeypatch.setattr(k8s, "terminal_pod_failure",
                        lambda n, **kw: ("mongodb-0", "ImagePullBackOff", "no such host"))
    assert lc.kubernetes_state("k", meta) == "failed"

    monkeypatch.setattr(k8s, "terminal_pod_failure", lambda n, **kw: None)
    monkeypatch.setattr(k8s, "release_state", lambda *a, **kw: ("pending-install", 1))
    assert lc.kubernetes_state("k", meta) == "failed"

    # A REFUSED probe must not manufacture a failure: still `starting`.
    def boom(*a, **kw):
        raise errors.DockerError("could not ask")
    monkeypatch.setattr(k8s, "terminal_pod_failure", boom)
    monkeypatch.setattr(k8s, "release_state", boom)
    assert lc.kubernetes_state("k", meta) == "starting"


def test_the_mongodb_manifest_satisfies_pod_security_restricted():
    """K-10. `mongo_manifest` set no securityContext at all, so under PSA
    `restricted` the StatefulSet was ACCEPTED and no pod was ever created -- and
    every diagnostic went blind: `terminal_pod_failure` found no pod, `pod_rows` was
    empty, `storage_blocker` said nothing, and the PVC sat Pending pointing at
    storage, which was not the problem.

    Verified live against a namespace labelled `enforce=restricted`: pre-fix the API
    server rejected the pod with all four violations named; post-fix it Runs, mongod
    is uid 999, and the replica set reaches PRIMARY.
    """
    import yaml as _yaml

    from houston.services import k8s

    sts = [d for d in _yaml.safe_load_all(k8s.mongo_manifest("t", "8.0"))
           if d and d["kind"] == "StatefulSet"][0]
    pod = sts["spec"]["template"]["spec"]
    assert pod["securityContext"]["runAsNonRoot"] is True
    assert pod["securityContext"]["seccompProfile"]["type"] == "RuntimeDefault"
    container = pod["containers"][0]
    assert container["securityContext"]["allowPrivilegeEscalation"] is False
    assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
    # Requests so a namespace quota cannot reject the pod outright; no CPU limit,
    # because throttling mongod during a restore turns a backup test into a timeout.
    assert container["resources"]["requests"]["memory"]
    assert "cpu" not in container["resources"].get("limits", {})


def test_a_monolith_does_not_run_a_nats_cluster_it_never_uses():
    """K-15. The chart defaults `nats.enabled` on independently of
    `microservices.enabled`, so `--deployment monolith` ran a 3-pod NATS cluster
    nothing connected to -- three more pods to schedule, wait for and tear down.
    Confirmed by rendering chart 7.0.2: 6 NATS objects without this, 0 with it.
    """
    from houston.services import k8s

    mono = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=False,
                          host="rc.example.com")
    micro = k8s.values_for(rc_version="8.5.1", rc_image="i", microservices=True,
                           host="rc.example.com")
    assert mono["nats"]["enabled"] is False
    assert micro["nats"]["enabled"] is True
    # The cluster NAME stays either way: it is what the chart's own values call it.
    assert mono["nats"]["cluster"]["name"] == micro["nats"]["cluster"]["name"]


def test_a_forward_that_only_got_one_address_family_is_not_certified():
    """K-16. `kubectl port-forward` binds "localhost", which is BOTH 127.0.0.1 and
    [::1]. If an IPv4-only process already holds the port kubectl does NOT fail --
    it binds [::1] alone and runs happily -- and `pid_owns_port` said yes, so
    `forward_bound` certified a URL on which every IPv4 client reached the squatter.

    Reproduced live with a real kubectl forward and an IPv4 squatter: the old check
    True, the new one False, `127.0.0.1` serving a different program. Here the
    squatter is a CHILD process, because a socket this process binds is by definition
    its own and would make the split untestable.
    """
    import os
    import socket
    import subprocess
    import sys
    import time as _time

    from houston.services import k8s

    mine = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    try:
        mine.bind(("::1", 0))
    except OSError:
        mine.close()
        pytest.skip("no IPv6 loopback here to build the split with")
    mine.listen(1)
    port = mine.getsockname()[1]
    try:
        # Only this process holds it: exclusive, which is the healthy forward.
        assert k8s.pid_owns_port(os.getpid(), port) is True
        assert k8s.pid_owns_port_exclusively(os.getpid(), port) is True
        # A pid that holds nothing on it answers no to both.
        assert k8s.pid_owns_port_exclusively(1, port) is False

        squatter = subprocess.Popen(
            [sys.executable, "-c",
             "import socket,time;s=socket.socket();"
             "s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);"
             f"s.bind(('127.0.0.1',{port}));s.listen(1);time.sleep(30)"])
        try:
            for _ in range(50):
                if len(k8s._listening_inodes(port)) > 1:
                    break
                _time.sleep(0.1)
            assert len(k8s._listening_inodes(port)) > 1, "the split never formed"
            # THE SPLIT. Presence still says yes -- our IPv6 socket is really there --
            # and that is exactly the answer that certified a broken URL.
            assert k8s.pid_owns_port(os.getpid(), port) is True
            assert k8s.pid_owns_port_exclusively(os.getpid(), port) is False
        finally:
            squatter.terminate()
            squatter.wait(timeout=10)
    finally:
        mine.close()


def test_a_port_change_retires_the_previous_forward(monkeypatch):
    """K-06. `forward_alive` identifies a forward by namespace AND port, which is
    right for "is what I recorded still up" and wrong for "is there an old one to
    retire": `up --port 3261` asked about the NEW port, got False, recorded pid 0 and
    left the old kubectl holding 3260 with nothing able to find it again. It survived
    `down --volumes` for the same reason.
    """
    from houston.services import k8s

    signalled: list[int] = []
    monkeypatch.setattr(k8s.os, "kill", lambda pid, sig: signalled.append(pid))
    monkeypatch.setattr(k8s, "forward_alive",
                        lambda pid, **kw: kw.get("host_port") == 3260)

    # Asked about the port it is actually on: retired.
    assert k8s.stop_forward(4242, namespace="ns", host_port=3260) is True
    assert signalled == [4242]
    # Asked about the new port: not our forward, and nothing is signalled.
    signalled.clear()
    assert k8s.stop_forward(4242, namespace="ns", host_port=3261) is False
    assert signalled == []
    # No recorded pid at all is not an error.
    assert k8s.stop_forward(0, namespace="ns", host_port=3260) is False


def test_the_monitoring_stack_reclaims_its_volume(monkeypatch):
    """K-11. A StatefulSet's PVCs outlive it by design -- that is what keeps a
    workspace's MongoDB data across a plain `down` -- and nothing deleted the
    monitoring one. There was no code path anywhere that could: a clean
    `monitor --off` left `prometheus-...-db-...-0` Bound, 10 Gi, permanently.
    """
    from houston.services import k8s

    seen: list[list[str]] = []

    def fake_run(argv, **kw):
        seen.append(argv)
        if "get" in argv and "pvc" in argv:
            return _completed(0, out="persistentvolumeclaim/prometheus-db-0\n")
        return _completed(0)
    monkeypatch.setattr(k8s, "run", fake_run)
    monkeypatch.setattr(k8s, "release_installed", lambda *a, **kw: True)
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda ctx=None: [])
    monkeypatch.setattr(k8s, "grafana_leftovers", lambda ctx: [])
    monkeypatch.setattr(k8s, "clear_grafana_finalizers", lambda ctx: None)

    assert k8s.remove_monitoring(context="c") is True
    deletes = [a for a in seen if "delete" in a and "pvc" in a]
    assert deletes, "the monitoring volume was left allocated"


def test_the_operator_is_not_installed_with_telemetry_on(monkeypatch):
    """K-13. The chart sends the cluster UID, the Kubernetes version and deployment
    UIDs to MongoDB on a weekly timer, enabled by default. Nobody using a support
    reproduction tool opted into third-party analytics about the cluster they are
    debugging, and on a customer's adopted cluster houston would be what started it.
    """
    from houston.services import k8s

    seen: list[list[str]] = []
    monkeypatch.setattr(k8s, "run",
                        lambda argv, **kw: seen.append(argv) or _completed(0))
    monkeypatch.setattr(k8s, "operator_installed", lambda **kw: False)
    monkeypatch.setattr(k8s, "wait_operator_ready", lambda **kw: None, raising=False)
    try:
        k8s.ensure_operator(context="c")
    except Exception:                      # noqa: BLE001 - the install is not the subject
        pass
    upgrade = [a for a in seen if "upgrade" in a and "--install" in a]
    assert upgrade, "the operator install never ran"
    flat = " ".join(upgrade[0])
    assert "operator.telemetry.send.enabled=false" in flat, flat


def test_a_version_the_index_has_never_heard_of_is_named_before_the_build(
        monkeypatch, tmp_path):
    """`resolve()` stamps `source="map (no such release)"` when releases.rocket.chat
    answered 404, and the create path ignored it -- so `up --version 99.99.99` built
    the whole compose document, created containers and failed ~90s later at docker's
    own "not found", leaving a workspace to clean up.

    Measured on EC2 against the real index. A warning rather than a refusal: the
    shipped map can legitimately pair a version the live index has not indexed yet.
    """
    from houston import versions
    from houston.services import lifecycle as lcsvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    said: list[str] = []
    monkeypatch.setattr(lcsvc.runner, "up", lambda *a, **k: 0)
    monkeypatch.setattr(lcsvc.runner, "down", lambda *a, **k: 0)

    fields = {f.name: (f.default if f.default is not __import__("dataclasses").MISSING
                       else "") for f in __import__("dataclasses").fields(versions.Resolved)}
    fields.update(rc_version="99.99.99", rc_image="i", mongo_tag="8.0",
                  mongo_flavor="official", source="map (no such release)")
    monkeypatch.setattr(versions, "resolve", lambda *a, **kw: versions.Resolved(**fields))

    try:
        lcsvc.create_repro(lcsvc.CreateReq(version="99.99.99", name="bogus"),
                           emit=lambda e: said.append(e.message))
    except Exception:                      # noqa: BLE001 - the boot is not the subject
        pass
    assert any("has no 99.99.99" in m for m in said), said
    assert any("shipped map" in m for m in said), \
        "it must say where the pairing came from, not just that the version is unknown"

    # A version the index DOES know is not warned about.
    fields["source"] = "releases.rocket.chat"
    monkeypatch.setattr(versions, "resolve", lambda *a, **kw: versions.Resolved(**fields))
    said.clear()
    try:
        lcsvc.create_repro(lcsvc.CreateReq(version="8.5.1", name="fine"),
                           emit=lambda e: said.append(e.message))
    except Exception:                      # noqa: BLE001
        pass
    assert not [m for m in said if "has no" in m], said


# --- "I could not ask" has four answers, not two -------------------------------------

def test_reach_tells_a_refused_cluster_apart_from_a_dead_one(monkeypatch):
    """A cluster that answers and refuses is not a cluster that is down.

    `reachable()` returned a bool, so four different situations arrived at the caller
    as one fact and got one message: "is not answering". Three of those four are not
    about the cluster's health at all, and the advice that came with the bool sent the
    reader to check a cluster that was in perfect condition.

    Every string below was produced by a real `kubectl` on a real cluster during live
    EKS testing on 2026-09-02, which is why they are exact rather than representative.
    The two DENIED phrasings came from the SAME cluster the same afternoon -- `get
    --raw` produces the first, the discovery client the second -- so matching one of
    them is matching none of them half the time.
    """
    import types
    from houston.services import k8s

    cases = [
        ("error: You must be logged in to the server (Unauthorized)", k8s.REACH_DENIED),
        ("couldn't get current server API group list: the server has asked for the "
         "client to provide credentials", k8s.REACH_DENIED),
        ("Error from server (Forbidden): nodes is forbidden", k8s.REACH_DENIED),
        ("Error in configuration: context was not found for specified context: arn:x",
         k8s.REACH_NO_CONTEXT),
        ('error: context "x" does not exist', k8s.REACH_NO_CONTEXT),
        ("dial tcp 127.0.0.1:8080: connect: connection refused", k8s.REACH_DOWN),
        ("Unable to connect to the server: net/http: TLS handshake timeout",
         k8s.REACH_DOWN),
    ]
    for said, expected in cases:
        monkeypatch.setattr(k8s, "run", lambda *a, _s=said, **kw: types.SimpleNamespace(
            returncode=1, stdout="", stderr=_s))
        got = k8s.reach("x")
        assert got.status == expected, f"{said!r} classified as {got.status}"
        assert not got.ok
        assert got.why(), "every non-ok answer must be able to say what it was"

    # And the healthy case is still healthy, through the bool the resolution order uses.
    monkeypatch.setattr(k8s, "run", lambda *a, **kw: types.SimpleNamespace(
        returncode=0, stdout="ok", stderr=""))
    assert k8s.reach("x").ok and k8s.reachable("x")


def test_a_cluster_that_refuses_is_not_reported_as_one_that_is_down(monkeypatch):
    """The three places a person READS the answer must name which of the four it was.

    Measured, three times in one day of live testing against a real EKS cluster:
    `cluster status` told an engineer to check an ACTIVE cluster that was merely
    refusing their credential; `cluster delete` said an ACTIVE cluster "is not
    answering" when the real cause was a fresh HOUSTON_HOME with no kubeconfig entry
    for it; and `plan_cluster` offered three guesses at a cause it had not read.
    """
    from houston.services import cluster as clustersvc
    from houston.services import eks, k8s

    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    # The kubeconfig is STATED, not read: this box's real one is whatever the last
    # live test left in it, and a unit test that reads it passes or fails by accident.
    monkeypatch.setattr(k8s, "contexts", lambda: ([ARN], ""))

    # 1. the ledger -- and the counts below it stay unknown, not zero.
    monkeypatch.setattr(k8s, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_DENIED))
    monkeypatch.setattr(k8s, "is_ours", lambda ctx: False)
    report = clustersvc.status(ARN)
    assert report["reachable"] is False
    assert report["reach_status"] == k8s.REACH_DENIED
    assert "refused these credentials" in report["reach_why"]
    assert "create-access-entry" in report["reach_advice"], \
        "the advice must point at the access entry, not at the cluster's health"
    assert report["nodes"] is None and report["workspaces"] is None, \
        "a refused read must still leave every count unknown rather than zero"

    # 2. plan_cluster's refusal.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default",
                      reachable=False, reach_status=k8s.REACH_NO_CONTEXT)
    monkeypatch.setattr(k8s, "contexts", lambda: ([ARN], ""))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.plan_cluster(context=ARN)
    assert "no kubeconfig entry" in str(exc.value), \
        "a context this box has never heard of is not a statement about the cluster"
    assert "update-kubeconfig" in str(exc.value), \
        "and for an EKS arn the advice is the command that writes one"

    # 3. the delete guard still REFUSES -- it just says which kind of unreadable.
    _aws_ready(monkeypatch)
    monkeypatch.setattr(eks, "owns_cluster",
                        lambda n, r: k8s.Answer(state=k8s.PRESENT, doc={"arn": ARN}))
    monkeypatch.setattr(k8s, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_DENIED))
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("s", region="us-east-1")
    assert "not an empty one" in str(exc.value), "the refusal itself must not weaken"
    assert "refused these credentials" in str(exc.value)


# --- the command that looks where you are not already looking ------------------------

def test_a_cluster_in_a_region_nobody_named_is_still_found(monkeypatch):
    """Nothing else in houston can answer "what am I paying for".

    `cluster status` needs a context you already have and `doctor` reads a local
    pointer a fresh HOUSTON_HOME has not got, so a cluster in a region you have
    stopped thinking about is invisible to the entire tool. MEASURED: a cluster
    houston built sat in eu-west-1 for 16.8 hours and $2.47 while that day's checks
    swept only us-east-1, and it was found by an unrelated `aws` call.

    The ownership tag needed to find it had existed since the first cloud commit. What
    was missing was anything that went looking.
    """
    import types
    from houston.services import eks, k8s

    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/aws")

    def fake_run(argv, **kw):
        if "describe-regions" in argv:
            return types.SimpleNamespace(
                returncode=0, stdout='["us-east-1","eu-west-1","ap-south-1"]', stderr="")
        region = argv[argv.index("--region") + 1]
        if region == "eu-west-1":
            return types.SimpleNamespace(returncode=0, stdout='["support"]', stderr="")
        if region == "ap-south-1":                 # could not be asked at all
            return types.SimpleNamespace(
                returncode=255, stdout="", stderr="AccessDeniedException: no")
        return types.SimpleNamespace(returncode=0, stdout="[]", stderr="")

    monkeypatch.setattr(k8s, "run", fake_run)
    monkeypatch.setattr(eks, "describe_cluster", lambda n, r: k8s.Answer(
        state=k8s.PRESENT,
        doc={"status": "ACTIVE", "arn": f"arn:aws:eks:{r}:1:cluster/{n}",
             "createdAt": "2026-09-01T11:03:00Z",
             "tags": {eks.OWNED_TAG_KEY: eks.OWNED_TAG_VALUE,
                      eks.EXPIRY_TAG_KEY: "2026-09-08"}}))

    found = eks.sweep_clusters()
    names = [(c["region"], c["name"]) for c in found["clusters"]]
    assert names == [("eu-west-1", "support")], \
        "the sweep must find a cluster in a region the caller never named"
    assert found["clusters"][0]["expires"] == "2026-09-08"

    # AND A REGION THAT COULD NOT BE ASKED IS NOT A REGION WITH NOTHING IN IT. This is
    # the whole discipline of the module: a report that let fourteen refused regions
    # read as "you are paying for nothing" would be worse than no report at all.
    assert [b["region"] for b in found["unreadable"]] == ["ap-south-1"]
    assert "AccessDenied" in found["unreadable"][0]["why"]


def test_a_cluster_that_is_there_and_cannot_be_described_is_never_silently_dropped(monkeypatch):
    """`list-clusters` named it, so it EXISTS. Failing to describe it is not absence."""
    import types
    from houston.services import eks, k8s

    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/aws")
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: types.SimpleNamespace(
        returncode=0,
        stdout='["us-east-1"]' if "describe-regions" in argv else '["ghost"]',
        stderr=""))
    monkeypatch.setattr(eks, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.REFUSED))

    found = eks.sweep_clusters()
    assert found["clusters"] == []
    assert found["unreadable"] and "ghost" in found["unreadable"][0]["why"], \
        "a cluster that exists and could not be read must be reported, never dropped"


# --- a saved setting that decides something must say so ------------------------------

def test_a_saved_cluster_never_changes_what_a_bare_up_means_but_now_says_so(monkeypatch,
                                                                           tmp_path):
    """Two opposite complaints, one silence.

    Setting `kubernetes.context` changes what other commands mean and nothing ever
    mentioned it. So somebody sets a default cluster, runs `up`, and gets a Docker
    workspace -- correct, deliberate, and indistinguishable from a bug. And somebody
    runs `cluster create`, which SETS that default, after which `--runtime kubernetes`
    quietly means the EKS cluster it just built rather than the free local one it meant
    yesterday, at roughly $8.46 a day.

    Neither is a refusal: the first is right and the second is a thing people want.
    The fix is that both are now said out loud.
    """
    from houston import config
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    EKS = "arn:aws:eks:us-east-1:1:cluster/support"

    def said(saved, typed, **kw):
        cfg = config.load_config()
        cfg[config.KUBE_CONTEXT_KEY] = saved
        config.save_config(cfg)
        out = []
        req = lc.CreateReq(version="8.5.1", name="t", runtime=typed, **kw)
        was = str(req.runtime or "").strip()
        req.runtime = lc.infer_runtime(req)
        lc._say_where_this_is_going(req, was, lambda e: out.append((e.level, e.message)))
        return req.runtime, out

    # THE BEHAVIOUR IS UNCHANGED -- a bare `up` is still Docker. Only the silence went.
    runtime, out = said(EKS, "")
    assert runtime in ("", "docker"), "a saved cluster must NEVER move a bare `up`"
    assert out and "going to Docker" in out[0][1]
    assert "--runtime kubernetes" in out[0][1], "and it must say how to use the cluster"

    # An explicit `--runtime docker` is not confusion; it is an instruction.
    assert said(EKS, "docker")[1] == []

    # Naming the cluster is already unambiguous, so repeating it back is noise.
    assert said(EKS, "", context=EKS)[1] == []

    # A saved BILLABLE default chosen implicitly is a warning, because it costs money.
    runtime, out = said(EKS, "kubernetes")
    assert out and out[0][0] == "warn"
    assert "costs money by the hour" in out[0][1]
    assert "saved default" in out[0][1], "it must say WHY this cluster was chosen"

    # A saved free cluster used the same way is silent -- that is what saving one is
    # for, and warning every time would train people to stop reading these.
    assert said("default", "kubernetes")[1] == []
    assert said("k3s-prod", "kubernetes")[1] == []


# --- the permissions documents are shipped, not described ----------------------------

def test_every_permissions_document_is_shipped_and_every_shipped_one_is_listed():
    """A registry and a directory that disagree is how a document goes missing.

    These are pasted into `aws iam create-policy` and `kubectl apply` by somebody
    setting houston up for the first time, so an entry naming a file that is not
    there fails at the worst possible moment -- and a file nobody lists is one nobody
    knows to use.
    """
    from importlib import resources

    from houston.services import eks

    shipped = {p.name for p in
               resources.files("houston").joinpath("data", "iam").iterdir()
               if p.is_file()}
    listed = {fname for fname, _ in eks.IAM_DOCUMENTS.values()}
    assert listed == shipped, (
        f"registry and data/iam disagree — only in registry: {sorted(listed - shipped)}, "
        f"only on disk: {sorted(shipped - listed)}")
    for key in eks.IAM_DOCUMENTS:
        assert eks.iam_document(key).strip(), f"{key} is shipped empty"


def test_the_permissions_documents_ship_in_a_wheel():
    """package-data is a glob somebody has to remember to widen.

    Without it the files are in the repo, every test passes, and they are simply
    absent from an installed houston -- which is the one place they matter, because
    the person running `cluster iam-policy` is setting up a machine that is not this
    one.
    """
    import re
    from pathlib import Path

    from houston.services import eks

    text = Path(eks.__file__).parents[2].joinpath("pyproject.toml").read_text()
    globs = re.findall(r'"(data/[^"]+)"', text)
    for fname, _ in eks.IAM_DOCUMENTS.values():
        suffix = fname.rsplit(".", 1)[-1]
        assert f"data/iam/*.{suffix}" in globs, (
            f"{fname} would not ship: pyproject package-data has no "
            f"data/iam/*.{suffix} glob")


def test_the_two_permissions_nobody_would_guess_are_still_in_the_policy():
    """Both were found by a live create FAILING without them, twenty minutes in.

    `ec2:RunInstances` is the counter-intuitive one: EKS starts the nodes itself, and
    still checks that the CALLER could have launched them with the node group's
    launch template. A policy without it builds a cluster with ZERO NODES that bills
    at the full rate and can run nothing.
    `cloudformation:UpdateTerminationProtection` fails only on the delete path, and
    only after the cluster is already half removed.

    Neither is obvious from reading the policy, so this is the test that stops a
    tidy-up removing them.
    """
    import json

    from houston.services import eks

    doc = json.dumps(json.loads(eks.iam_document("operator")))
    assert "ec2:RunInstances" in doc, \
        "without it, `cluster create` produces a cluster with no nodes that still bills"
    assert "cloudformation:UpdateTerminationProtection" in doc, \
        "without it, `cluster delete` fails after the cluster is half gone"


def test_the_engineer_rbac_grants_the_cluster_scoped_things_aws_own_policy_omits():
    """`AmazonEKSAdminPolicy` is admin INSIDE a namespace and stops exactly there.

    houston crosses that line on every `up`: a namespace per workspace is the whole
    model, and a namespace is cluster-scoped. MEASURED against a live cluster -- with
    only the AWS managed policy, `up` failed twice, first unable to read StorageClasses
    and then unable to create the namespace at all.
    """
    import yaml

    from houston.services import eks

    docs = [d for d in yaml.safe_load_all(eks.iam_document("rbac")) if d]
    role = next(d for d in docs if d["kind"] == "ClusterRole")
    binding = next(d for d in docs if d["kind"] == "ClusterRoleBinding")

    def verbs(resource: str) -> set[str]:
        out: set[str] = set()
        for rule in role["rules"]:
            if resource in rule["resources"]:
                out |= set(rule["verbs"])
        return out

    assert {"create", "delete"} <= verbs("namespaces"), \
        "a namespace per workspace is the model, and AmazonEKSAdminPolicy cannot make one"
    assert "list" in verbs("storageclasses"), \
        "`up` reads StorageClasses before it creates anything and refuses without them"
    # Everything ELSE stays read-only: an engineer runs workspaces and does not
    # reshape the cluster they are running them in.
    for rule in role["rules"]:
        if "namespaces" in rule["resources"]:
            continue
        assert set(rule["verbs"]) <= {"get", "list", "watch"}, \
            f"{rule['resources']} grants more than a read: {rule['verbs']}"
    assert binding["subjects"][0]["name"] == "houston-engineers", \
        "the binding must name the group the EKS access entry puts people in"


def test_the_cheap_cluster_list_probes_nothing_and_says_which_cost_money(monkeypatch, tmp_path):
    """The list has to be cheap or the page is as slow as its worst cluster.

    `status()` is six or more round trips per cluster and a refusing one spends the
    whole timeout on every one of them. So this answers only what the kubeconfig and
    the context NAME already know, and the front end fills each card in from its own
    `status()` request -- one slow card instead of a slow page.
    """
    from houston import config
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    monkeypatch.setattr(k8s, "contexts", lambda: ([ARN, "default", "kind-houston-local"], ""))
    monkeypatch.setattr(k8s, "is_ours", lambda c: c == "kind-houston-local")
    # Anything that would touch a cluster is made to explode: this function must not
    # reach one, and a test that merely asserted it was fast would not notice.
    #
    # THE ONE EXCEPTION IS NOT REACHED HERE. `known_contexts` probes our OWN context
    # when `kind` is missing, to tell a cluster that is gone from one that is merely
    # unmanageable -- so this states that houston built nothing, which is the case
    # every adopted cluster is in and the one this test is about. The probe itself has
    # its own test below.
    monkeypatch.setattr(k8s, "cluster_context", lambda: "")
    monkeypatch.setattr(k8s, "reach", lambda *a, **k: pytest.fail("known_contexts probed a cluster"))
    monkeypatch.setattr(k8s, "reachable", lambda *a, **k: pytest.fail("known_contexts probed a cluster"))
    cfg = config.load_config(); cfg[config.KUBE_CONTEXT_KEY] = ARN; config.save_config(cfg)

    out = clustersvc.known_contexts()
    rows = {r["context"]: r for r in out["contexts"]}
    assert set(rows) == {ARN, "default", "kind-houston-local"}
    assert rows[ARN]["billable"] is True and rows[ARN]["provider"] == "eks"
    assert rows[ARN]["is_default"] is True
    assert rows["default"]["billable"] is False
    assert rows["default"]["provider"] == "", \
        "kind and k3s look alike in a context name — guessing would put a distribution " \
        "on a card that status() then contradicts"
    assert rows["kind-houston-local"]["ours"] is True


def test_a_kubeconfig_that_could_not_be_listed_says_so_rather_than_showing_nothing(monkeypatch,
                                                                                   tmp_path):
    """"I could not read the kubeconfig" is not "there are no clusters"."""
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "contexts", lambda: ([], "permission denied"))
    out = clustersvc.known_contexts()
    assert out["contexts"] == []
    assert out["unreadable"] == "permission denied", \
        "the caller has to be able to say the page may be missing clusters"


def test_a_cluster_houston_can_no_longer_remove_says_so(monkeypatch, tmp_path):
    """Uninstalling the kind BINARY does not remove the cluster it built.

    The containers keep running, the API server keeps answering, and 675 MiB stays
    held -- while `delete_cluster`, `cluster_reclaimable` and `prune` all open with
    `if not which("kind"): return False`, so every control that would take it away
    answers "there was nothing to delete" rather than "I cannot delete it".

    That is the same conflation this module exists to prevent, applied to a control
    instead of a count: reporting nothing where the honest answer is "I cannot" is how
    a thing gets forgotten. Reported live by somebody who uninstalled kind and could
    not understand why the ledger still listed the cluster -- it was right to, and it
    could not say the one thing that had actually changed.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    OURS = "kind-houston-local"
    monkeypatch.setattr(k8s, "contexts", lambda: ([OURS], ""))
    monkeypatch.setattr(k8s, "is_ours", lambda c: True)
    monkeypatch.setattr(k8s, "ensure_kubeconfig", lambda plan, emit=None: OURS)
    monkeypatch.setattr(k8s, "reach", lambda *a, **k: k8s.Reach(status=k8s.REACH_OK))
    monkeypatch.setattr(k8s, "distribution", lambda c: "kind")
    monkeypatch.setattr(k8s, "ask_list", lambda kind, **kw: k8s.Answer(state=k8s.REFUSED))
    monkeypatch.setattr(k8s, "workspace_namespaces", lambda c: [])
    monkeypatch.setattr(k8s, "operator_installed", lambda c: False)
    monkeypatch.setattr(k8s, "monitoring_installed", lambda c: False)

    monkeypatch.setattr(k8s, "which", lambda t: "" if t == "kind" else "/usr/bin/" + t)
    stuck = clustersvc.status(OURS)
    assert stuck["reachable"] is True, "the cluster is still up — that is the point"
    assert stuck["manageable"] is False
    assert "no longer remove it" in stuck["unmanageable_why"]
    assert "docker rm -f" in stuck["unmanageable_why"], \
        "and it must give the way out that does not need the missing binary"

    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/" + t)
    fine = clustersvc.status(OURS)
    assert fine["manageable"] is True and fine["unmanageable_why"] == "", \
        "with kind installed there is nothing to warn about"

    # A cluster that is NOT houston's was never houston's to remove, so kind being
    # absent says nothing about it.
    monkeypatch.setattr(k8s, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s, "which", lambda t: "" if t == "kind" else "/usr/bin/" + t)
    theirs = clustersvc.status(OURS)
    assert theirs["manageable"] is True


def test_the_eks_guide_ships_and_its_commands_are_real():
    """A procedure people copy, kept where the tool is rather than where the repo is.

    Two ways this rots. It can fail to ship -- package-data is a glob somebody has to
    remember to widen, and without it the file is in the repository, every test passes,
    and it is simply absent from an installed houston, which is the one place it
    matters. And it can drift from the CLI: a walkthrough is only useful if every
    command in it still exists, and nothing else would notice a renamed one.
    """
    import re
    from pathlib import Path

    from houston import cli
    from houston.services import eks

    body = eks.guide()
    assert eks.guide_path() is not None
    assert len(body.splitlines()) > 100, "the guide is a walkthrough, not a stub"

    text = Path(eks.__file__).parents[2].joinpath("pyproject.toml").read_text()
    assert "data/docs/*.md" in text, \
        "the guide would not ship: pyproject package-data has no data/docs/*.md glob"

    # Every `houston <command>` the guide tells somebody to RUN has to be one --
    # scanned from code only. The prose says "houston built this cluster" and
    # "houston never reaches it", and a scan of the whole text reads those as
    # commands named `built` and `never`.
    known = {c.name or (c.callback and c.callback.__name__) for c in cli.app.registered_commands}
    known |= {g.name for g in getattr(cli.app, "registered_groups", [])}
    known.discard(None)
    code = "\n".join(re.findall(r'```[a-z]*\n(.*?)```', body, re.S))
    code += "\n" + "\n".join(re.findall(r'`([^`\n]+)`', body))
    used = set(re.findall(r'\bhouston ([a-z][a-z-]*)', code))
    unknown = sorted(used - known)
    # AND THE ACTION AFTER IT. `houston cluster prepair` passes the check above --
    # `cluster` is a real command -- so a renamed action would sail through the very
    # test written to stop the guide rotting. Measured: it did.
    actions = set(re.findall(r'\bhouston cluster ([a-z][a-z-]*)', code))
    unknown += sorted(actions - set(cli.CLUSTER_ACTIONS) - {"--path", "--json"})
    assert not unknown, (
        f"the guide names commands that do not exist: {unknown}. "
        f"houston has: {sorted(known)}")


def test_the_readme_points_at_the_guide_that_actually_exists():
    """The README stopped repeating the walkthrough and links to it instead.

    That is the right call -- a 190-line procedure kept in two places is a procedure
    that will disagree with itself -- and it is only the right call while the link
    resolves.
    """
    from pathlib import Path

    from houston.services import eks

    root = Path(eks.__file__).parents[2]
    readme = root.joinpath("README.md").read_text()
    assert "houston/data/docs/eks.md" in readme, \
        "the README must say where the EKS walkthrough went"
    assert root.joinpath("houston/data/docs/eks.md").is_file(), \
        "and the path it names has to be there"
    assert "houston cluster guide" in readme


def test_a_cluster_of_ours_that_is_gone_stops_being_listed_but_a_running_one_does_not(
        monkeypatch, tmp_path):
    """Three cases, and only the middle one is new.

    houston writes its OWN kubeconfig when it builds its own cluster and never
    removes that entry. So a cluster deleted outside houston -- or one whose `kind`
    was uninstalled and whose container was then removed by hand -- left a context for
    something that does not exist, on every screen, for ever, unusable and impossible
    to clear. Reported from a real machine.

    Dropping it whenever `kind` is missing would be the wrong fix and `plan_cluster`
    says why: doing that once made a RUNNING cluster invisible, "containers holding
    memory that nothing in houston could see or remove". So the question is whether
    the cluster is there, not whether the binary is.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    OURS = "kind-houston-local"
    monkeypatch.setattr(k8s, "contexts", lambda: ([OURS, "default"], ""))
    monkeypatch.setattr(k8s, "cluster_context", lambda: OURS)
    monkeypatch.setattr(k8s, "is_ours", lambda c: c == OURS)

    def listed(kind_installed, answers):
        monkeypatch.setattr(k8s, "which",
                            lambda t: "/usr/bin/kind" if kind_installed else "")
        monkeypatch.setattr(k8s, "reach", lambda *a, **k: k8s.Reach(
            status=k8s.REACH_OK if answers else k8s.REACH_DOWN))
        return [r["context"] for r in clustersvc.known_contexts()["contexts"]]

    # 1. kind installed: listed whatever it is doing -- houston can rebuild it.
    assert OURS in listed(kind_installed=True, answers=False)

    # 2. kind gone but the cluster is UP: still listed. It is real, it holds memory,
    #    and hiding it is the failure this rule is written around.
    assert OURS in listed(kind_installed=False, answers=True)

    # 3. kind gone and the cluster does not answer: a stale entry for a thing that is
    #    not there. Dropped -- it can be neither used, rebuilt, nor reclaimed.
    left = listed(kind_installed=False, answers=False)
    assert OURS not in left
    assert "default" in left, "and it must not take anybody else's cluster with it"


def test_the_phantom_rule_never_touches_a_cluster_that_is_not_ours(monkeypatch, tmp_path):
    """An adopted k3s or EKS context that is down is somebody else's business.

    houston did not write those entries and removing them from a report would be
    hiding the operator's own kubeconfig from them -- and an EKS cluster that is not
    answering is exactly the one they most need to see, because it is still billing.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    monkeypatch.setattr(k8s, "contexts", lambda: ([ARN, "default"], ""))
    monkeypatch.setattr(k8s, "cluster_context", lambda: "")   # we built nothing
    monkeypatch.setattr(k8s, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s, "which", lambda t: "")
    monkeypatch.setattr(k8s, "reach", lambda *a, **k: k8s.Reach(status=k8s.REACH_DOWN))

    listed = [r["context"] for r in clustersvc.known_contexts()["contexts"]]
    assert listed == [ARN, "default"], \
        "a billing cluster that is not answering is the one you most need to see"


def test_every_shipped_data_file_is_actually_in_the_repository():
    """Present on this machine is not the same as shipped.

    `.gitignore` had `docs/` unanchored, which matches a directory of that name at ANY
    depth -- so `houston/data/docs/` was silently excluded. The guide existed here,
    the package-data glob covered it, the test that checks the glob passed, and it
    would have been absent from every clone and from any wheel built from one. Nothing
    in the suite could see the difference, because the suite runs against the working
    tree.

    So this asks GIT, which is the only thing that knows what a clone would get.
    """
    import subprocess
    from pathlib import Path

    from houston.services import eks

    root = Path(eks.__file__).parents[2]
    if not root.joinpath(".git").exists():
        pytest.skip("not a git checkout")

    data = root / "houston" / "data"
    files = [p for p in data.rglob("*") if p.is_file()]
    assert files, "no package data found at all — the layout changed"
    res = subprocess.run(
        ["git", "check-ignore", "--no-index", *[str(p) for p in files]],
        cwd=root, capture_output=True, text=True)
    hidden = sorted(line.strip() for line in res.stdout.splitlines() if line.strip())
    assert not hidden, (
        "package data excluded by .gitignore — present here, absent from a clone "
        f"and from any wheel built from one: {hidden}")


def test_a_cluster_can_be_named_by_the_name_people_actually_call_it(monkeypatch):
    """`--context support`, not the forty-eight character ARN, every single time.

    `aws eks update-kubeconfig` writes the cluster ARN as the context name, so the
    daily command was `--context arn:aws:eks:us-east-1:533674205877:cluster/support`
    for a workspace that lives for an afternoon. Nobody types that; they paste it, and
    pasting the wrong one is the failure this whole feature guards against everywhere
    else.
    """
    from houston.services import k8s

    A = "arn:aws:eks:us-east-1:1:cluster/support"
    B = "arn:aws:eks:eu-west-1:1:cluster/perf"
    monkeypatch.setattr(k8s, "contexts", lambda: ([A, B, "default"], ""))

    assert k8s.assert_context_known("support")[0] == A, "the short name resolves"
    assert k8s.assert_context_known(A)[0] == A, "the full name still works"
    assert k8s.assert_context_known("default")[0] == "default", "so do short contexts"
    assert k8s.assert_context_known("perf")[0] == B

    with pytest.raises(errors.ValidationError) as exc:
        k8s.assert_context_known("nope")
    assert "no kubeconfig context named" in str(exc.value), \
        "an unknown name is still a typo, not a resolution"


def test_the_same_cluster_name_in_two_places_refuses_instead_of_picking_one(monkeypatch):
    """`support` in us-east-1 and `support` in eu-west-1 are different clusters.

    Silently taking the first is how somebody deletes the wrong one. This module
    refuses and names both, the way every other ambiguous-destructive decision here
    does.
    """
    from houston.services import k8s

    A = "arn:aws:eks:us-east-1:1:cluster/support"
    B = "arn:aws:eks:eu-west-1:1:cluster/support"
    monkeypatch.setattr(k8s, "contexts", lambda: ([A, B], ""))

    with pytest.raises(errors.ValidationError) as exc:
        k8s.assert_context_known("support")
    said = str(exc.value)
    assert "more than one" in said
    assert A in said and B in said, "the refusal must name both, or it cannot be acted on"
    # And each full name still reaches exactly the one it names.
    assert k8s.assert_context_known(A)[0] == A
    assert k8s.assert_context_known(B)[0] == B


def test_an_unreadable_kubeconfig_still_does_not_turn_a_real_name_into_a_typo(monkeypatch):
    """The rule the short-name path must not break: "I could not ask" is not "absent"."""
    from houston.services import k8s

    monkeypatch.setattr(k8s, "contexts", lambda: ([], "permission denied"))
    resolved, why = k8s.assert_context_known("support")
    assert resolved == "support", "it is passed through untouched, not refused"
    assert why == "permission denied"


def test_no_hint_tells_somebody_to_pass_a_runtime_a_context_already_implies():
    """These are the lines people copy out of the terminal.

    `cluster create` finished by printing `houston up --runtime kubernetes --context
    arn:aws:eks:us-east-1:533674205877:cluster/rc-final --version 8.5.1` -- the two
    most awkward forms of the command at once, from the one place a first-timer is
    most likely to copy. `--context` has implied Kubernetes since `infer_runtime`
    landed, and a cluster's own name has been enough since short names did. A hint
    that teaches otherwise is not merely verbose; it is the tool contradicting itself.
    """
    from pathlib import Path

    from houston import cli

    text = Path(cli.__file__).read_text(encoding="utf-8")
    # Only strings that are printed, and only where both appear together.
    offenders = [line.strip() for line in text.splitlines()
                 if "--runtime kubernetes" in line and "--context" in line]
    assert not offenders, (
        "a printed hint passes --runtime kubernetes beside --context, which already "
        f"implies it: {offenders}")

    # And the create hint names the cluster rather than pasting its ARN back. The
    # hint is an f-string split over two source lines, so the window is the lines
    # around it rather than one quoted run.
    lines = text.splitlines()
    at = next((i for i, ln in enumerate(lines) if "point a workspace at it" in ln), -1)
    assert at >= 0, "the create hint moved — check it still teaches the short form"
    window = " ".join(lines[at:at + 2])
    assert "--runtime" not in window
    assert "{name}" in window, \
        "it must name the cluster the way the person just named it, not by its ARN"


def test_a_managed_clusters_name_is_not_routed_through_this_machines_edge(monkeypatch):
    """The edge on this laptop cannot front a load balancer in AWS.

    `host_port_claim` asks whether the cluster holds THIS HOST's ports, which for any
    managed cluster is definitionally no -- so `cluster_owns_443` came out false and
    the plan fell through to the shared edge. That is not merely wasteful. The
    workspace's name resolves to the cluster's own load balancer, so no packet for it
    ever arrives on this machine; the edge could not serve it however it were set up.

    MEASURED against a real EKS cluster: `up --domain houston-test-1.kestron.org`
    announced "the http-01 challenge arrives on the edge's :80", went to start an edge
    it had no use for, and refused the entire create because a different
    HOUSTON_HOME on the box already owned one. A shared support server -- several
    people, one machine, one cluster in AWS -- is exactly the arrangement this feature
    exists for, and it could not create a workspace there at all.
    """
    from houston import tls as tlsmod
    from houston.services import k8s
    from houston.services import lifecycle as lc

    HOST = "t1.rc.example.com"

    def decide(*, endpoint_local, claim_ports):
        said: list = []
        monkeypatch.setattr(k8s, "preflight",
                            lambda ctx=None: k8s.Preflight(distribution="eks"))
        monkeypatch.setattr(k8s, "ensure_cert_manager", lambda **kw: None)
        monkeypatch.setattr(k8s, "ensure_ingress", lambda **kw: "traefik")
        addr = "172.16.0.2" if endpoint_local else "a1b2.elb.amazonaws.com"
        monkeypatch.setattr(k8s, "ingress_endpoint", lambda ctx, **kw: k8s.IngressEndpoint(
            address=addr, port=443, source="loadbalancer",
            service="traefik/traefik", local=endpoint_local))
        monkeypatch.setattr(k8s, "host_port_claim", lambda ctx: (
            k8s.PortClaim(context="ctx", address="172.16.0.2",
                          ports=list(claim_ports),
                          service="traefik/traefik") if claim_ports else None))
        req = lc.CreateReq(version="8.5.1", name="t", runtime="kubernetes",
                           domain=HOST, acme_email="a@b.c")
        tlsspec = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host=HOST,
                                 acme_email="a@b.c")
        plan = k8s.ClusterPlan(context="ctx", distribution="eks", create=False)
        out = lc._kubernetes_tls_plan(req, tlsspec, plan,
                                      emit=lambda e: said.append(e.message))
        return out, said

    # A MANAGED CLUSTER: its ingress is elsewhere, so the cluster owns the name and no
    # edge is involved. This is the case that could not create a workspace at all.
    out, said = decide(endpoint_local=False, claim_ports=())
    assert out.cluster_owns_443 is True, \
        "a remote load balancer cannot be fronted by this machine's edge"
    assert any("not in the path" in m for m in said), \
        "and the operator must be told where the challenge actually goes"
    assert not any("edge's :80" in m for m in said), \
        "it must stop announcing an edge that cannot be reached"

    # A LOCAL cluster holding this host's :443 is unchanged -- it always owned it.
    out, _ = decide(endpoint_local=True, claim_ports=(80, 443))
    assert out.cluster_owns_443 is True

    # A LOCAL cluster that does NOT hold :443 still goes through the edge, which is
    # the whole reason the edge exists and must not have been broken by this.
    out, said = decide(endpoint_local=True, claim_ports=())
    assert out.cluster_owns_443 is False, \
        "a local cluster with no host claim still needs the edge in front of it"
    assert any("edge's :80" in m for m in said)


def test_one_cluster_with_two_context_names_is_one_row_and_one_bill(monkeypatch, tmp_path):
    """`eksctl` and `aws eks update-kubeconfig` each name the same cluster differently.

    eksctl writes `<iam-user>@<cluster>.<region>.eksctl.io`; the AWS CLI writes the
    cluster ARN. A cluster built with one and adopted with the other has BOTH in the
    kubeconfig, and a ledger that lists contexts then lists that cluster twice and
    prices it twice. Reported from a real screen: "Costing money 2 · ~$16.87/day" for a
    single cluster costing $8.44. Doubling the bill is the exact failure this module
    exists to prevent, in the other direction from a zero.

    The API server settles it without a probe, and the ARN is the name kept, because it
    says which account and which region -- the two facts the eksctl alias omits and the
    two that matter when acting on the wrong cluster.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    ALIAS = "iam-root-account@support.us-east-1.eksctl.io"
    SERVER = "https://ABC123.gr7.us-east-1.eks.amazonaws.com"
    monkeypatch.setattr(k8s, "contexts", lambda: ([ALIAS, ARN, "default"], ""))
    monkeypatch.setattr(k8s, "context_servers", lambda: (
        {ALIAS: SERVER, ARN: SERVER, "default": "https://127.0.0.1:6443"}, ""))
    monkeypatch.setattr(k8s, "cluster_context", lambda: "")
    monkeypatch.setattr(k8s, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/" + t)
    monkeypatch.setattr(k8s, "reach", lambda *a, **k: k8s.Reach(status=k8s.REACH_OK))

    rows = clustersvc.known_contexts()["contexts"]
    names = [r["context"] for r in rows]
    assert names.count(ARN) == 1
    assert ALIAS not in names, "the same cluster must not be listed, or billed, twice"
    assert names == [ARN, "default"], "and nobody else's cluster is disturbed"
    kept = next(r for r in rows if r["context"] == ARN)
    assert kept["aliases"] == [ALIAS], \
        "the other name is carried, so a kubeconfig entry is not mistaken for a second cluster"


def test_a_cluster_aws_says_is_gone_is_reported_gone_but_an_unreachable_one_is_not(
        monkeypatch, tmp_path):
    """`cluster delete` removes the cluster, not every kubeconfig entry naming it.

    Two tools wrote those entries, so a cluster deleted some OTHER way -- from the
    console, by a colleague -- keeps a context for ever, and its card says only "not
    answering": the alarming way to say nothing is there.

    ONLY ON A DEFINITE NO. `describe_cluster` answers PRESENT, ABSENT or REFUSED, and
    only ABSENT is AWS asserting it is not there. REFUSED means "I could not ask" --
    expired credentials, no route, a permission boundary -- and calling that gone would
    report a BILLING cluster as deleted, which is the one mistake this module exists to
    prevent.

    In `status` and NOT in `known_contexts`: this costs an AWS round trip, and the list
    is the function whose whole contract is that it probes nothing -- one probe per
    cloud cluster on a four-second poll is what made the page slow enough to be
    reported. Its own test holds that line; this one holds the behaviour.
    """
    from houston import config
    from houston.services import cluster as clustersvc
    from houston.services import eks as ekssvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    cfg = config.load_config(); cfg[config.KUBE_CONTEXT_KEY] = ARN; config.save_config(cfg)
    monkeypatch.setattr(k8s, "assert_context_known", lambda c: (c, ""))
    monkeypatch.setattr(k8s, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/" + t)
    # It does not answer -- which on its own says nothing about whether it exists.
    monkeypatch.setattr(k8s, "reach", lambda *a, **k: k8s.Reach(status=k8s.REACH_DOWN))

    monkeypatch.setattr(ekssvc, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.ABSENT))
    said = clustersvc.status(ARN)
    assert said["gone"] is True, "AWS said it is not there; the card must say so"
    assert "no longer exists" in said["reach_advice"]
    assert "forget" in said["reach_advice"], \
        "an operator told a cluster is gone needs the command that clears the entry"

    monkeypatch.setattr(ekssvc, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.REFUSED))
    assert clustersvc.status(ARN)["gone"] is False, \
        "'I could not ask' is not 'it is gone', and a cluster wrongly called deleted " \
        "is a bill nobody goes looking for"

    # A context that is not an EKS ARN is never asked about at all -- there is no AWS
    # question to ask about a kind or k3s cluster, and asking would spend a timeout.
    monkeypatch.setattr(ekssvc, "describe_cluster",
                        lambda n, r: pytest.fail("asked AWS about a local cluster"))
    assert clustersvc.status("default")["gone"] is False


def test_forgetting_a_context_also_clears_a_pointer_left_at_it(monkeypatch, tmp_path):
    """`kubectl config delete-context` removes the entry and leaves `current-context`
    naming it, so the file is left pointing at something that is no longer in it.

    MEASURED on this box after a real `cluster delete`: `contexts()` answered
    ['default'] and `active_context()` answered the deleted cluster's ARN. Everything
    that asks "which cluster is kubectl on" got a name with nothing behind it, and
    houston reported "pointed at <arn>, which is not answering" -- about a cluster
    that had been deleted, whose entry had been removed, and which the context list
    correctly no longer showed. Six unrelated Kubernetes tests failed on it.

    A pointer at nothing is the worst-behaved litter of the three, because it is the
    one thing a context LIST cannot show you.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    ran: list[list[str]] = []

    def fake_run(cmd, **kw):
        ran.append(list(cmd))
        out = ARN if list(cmd[:3]) == ["kubectl", "config", "current-context"] else ""
        return subprocess.CompletedProcess(list(cmd), 0, stdout=out, stderr="")

    monkeypatch.setattr(k8s, "run", fake_run)
    monkeypatch.setattr(k8s, "contexts", lambda: (["default"], ""))
    assert k8s.forget_context(ARN) is True
    assert ["kubectl", "config", "unset", "current-context"] in ran, \
        "the entry was removed and the pointer at it was left behind"


def test_forgetting_a_context_leaves_a_pointer_at_a_different_one_alone(monkeypatch,
                                                                       tmp_path):
    """Clearing litter must not take away the cluster somebody is working in.

    The unset is conditional on `current-context` naming the context being forgotten;
    an unconditional one would answer "no cluster" on a box whose kubectl was pointed
    at a perfectly good cluster that simply was not this one.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ran: list[list[str]] = []

    def fake_run(cmd, **kw):
        ran.append(list(cmd))
        out = "default" if list(cmd[:3]) == ["kubectl", "config",
                                             "current-context"] else ""
        return subprocess.CompletedProcess(list(cmd), 0, stdout=out, stderr="")

    monkeypatch.setattr(k8s, "run", fake_run)
    monkeypatch.setattr(k8s, "contexts", lambda: (["default"], ""))
    k8s.forget_context("arn:aws:eks:us-east-1:1:cluster/support")
    assert ["kubectl", "config", "unset", "current-context"] not in ran, \
        "kubectl was pointed at another cluster and forgetting this one took it away"


def test_a_step_that_is_not_the_end_does_not_announce_done_at_a_hundred_percent():
    """`wait_and_finalize` is the whole of `houston ready` and one step of `up`.

    MEASURED on a real EKS create: `done: ready` at 100% at 414s, then 46 more seconds
    of seeding, then a second `done`. In the GUI that is a progress bar that fills up
    and then keeps going; in a log it is a run that finishes twice.

    The invariant is not about the message but about who may claim the end: every
    caller that keeps working after this one passes `final=False`, and every caller
    that does not is the end and keeps the default.
    """
    import inspect

    from houston.services import lifecycle as lcmod

    said: list = []
    lcmod._say_ready(lambda e: said.append((e.phase, e.pct)), False)
    # NO PERCENTAGE. `wait_serving` has already emitted 100 by the time this runs, so
    # naming any number sends the bar BACKWARDS — observed on a real create as
    # `[100%] ... is serving at`, then `[85%] the workspace is up`, then `[100%]`.
    assert said == [("wait", None)], said
    said.clear()
    lcmod._say_ready(lambda e: said.append((e.phase, e.pct)), True)
    assert said == [("done", 100.0)], said

    # AND `final` DEFAULTS TO THE END, because the caller that forgets to think about
    # it is `houston ready`, for which the default is right.
    sig = inspect.signature(lcmod.wait_and_finalize)
    assert sig.parameters["final"].default is True


def test_every_caller_that_keeps_working_hands_off_the_terminal_event():
    """The half of the rule a unit test cannot see: which call sites pass `final=False`.

    Read from the source because it is a property OF the call sites. A caller that
    goes on working must not have announced the end, and -- the failure that this is
    really guarding -- a caller that has no later `done` must not hand it off either,
    or the run ends with no terminal event at all. Both directions have been wrong in
    this file within one change.
    """
    import ast
    import pathlib

    root = pathlib.Path(lc.__file__).parent
    for name in ("lifecycle.py", "upgrade.py", "backup.py"):
        path = root / name
        tree = ast.parse(path.read_text())
        for fn in ast.walk(tree):
            if not isinstance(fn, ast.FunctionDef):
                continue
            calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call)
                     and (getattr(n.func, "attr", "") == "wait_and_finalize"
                          or getattr(n.func, "id", "") == "wait_and_finalize")]
            if not calls:
                continue
            hands_off = any(k.arg == "final" and k.value.value is False
                            for c in calls for k in c.keywords)
            dones = [n.lineno for n in ast.walk(fn) if isinstance(n, ast.Call)
                     and getattr(n.func, "id", "") in ("info", "warn")
                     and any(k.arg == "phase" and getattr(k.value, "value", "") == "done"
                             for k in n.keywords)]
            later = [d for d in dones if d > max(c.lineno for c in calls)]
            where = f"{name}::{fn.name}"
            assert hands_off == bool(later), (
                f"{where}: passes final=False but nothing emits `done` afterwards"
                if hands_off else
                f"{where}: emits `done` at {later} after wait_and_finalize has already "
                f"announced one — pass final=False")


def test_the_longest_step_of_a_create_says_what_it_is_waiting_for(monkeypatch):
    """MEASURED on a real EKS create: 254 seconds between "installing
    rocketchat/rocketchat" and the next line, and nothing in between.

    `--atomic` (helm 3) and `--rollback-on-failure` (helm 4) both imply `--wait`, so
    helm blocks until the pods are Ready and prints nothing at all while it does. The
    comment at the call site claimed that passing `emit` made "helm's own progress
    reach both front ends", which it never could: the output is captured and comes
    back in one piece at the end.

    Four minutes of silence is where somebody decides the tool has hung and kills it,
    which leaves a half-installed release for the next `up` to clear.
    """
    import time as _time

    from houston.services import k8s

    monkeypatch.setattr(k8s, "INSTALL_QUIET_S", 1)
    monkeypatch.setattr(k8s, "INSTALL_REPORT_EVERY_S", 1)
    monkeypatch.setattr(k8s, "clear_pending_release", lambda *a, **k: None)
    monkeypatch.setattr(k8s, "_pods_waiting",
                        lambda ns, ctx: "1 starting (usually pulling the image)")
    said: list = []

    def slow(argv, **kw):
        _time.sleep(2.4)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.subprocess, "run", slow)
    k8s.install(namespace="ns", context="c", values={},
                emit=lambda e: said.append(e.message))
    progress = [m for m in said if "still installing" in m]
    assert progress, f"the longest step of a create said nothing: {said}"
    assert "pulling the image" in progress[0], progress


def test_a_fast_install_does_not_narrate_a_step_that_is_already_over(monkeypatch):
    """The quiet window is the point: a warm cluster installs in seconds and a line
    saying "still installing" about a step that has finished is noise, not progress.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s, "clear_pending_release", lambda *a, **k: None)
    monkeypatch.setattr(k8s, "_pods_waiting",
                        lambda ns, ctx: pytest.fail("probed pods for a fast install"))
    said: list = []
    monkeypatch.setattr(k8s.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 0, "", ""))
    k8s.install(namespace="ns", context="c", values={},
                emit=lambda e: said.append(e.message))
    assert not [m for m in said if "still installing" in m], said


def test_an_empty_cloud_record_beside_working_credentials_says_so_rather_than_nothing(
        monkeypatch, tmp_path):
    """Silence from the local pointer means one of two very different things.

    OBSERVED during an audit of this branch: an EKS cluster tagged `houston`, ACTIVE,
    expiring the next day, while the owner's `~/.houston/clusters/` did not exist at
    all -- so `doctor` on that box said nothing about it. The pointer is deliberately
    "best effort, never load-bearing", and CLAUDE.md tells anyone writing a script to
    `export HOUSTON_HOME=$(mktemp -d)`, so following this project's own instructions
    produces a create whose reminder is discarded.

    `doctor` is the command people run out of habit and `cluster list` is the one that
    actually asks AWS. Nothing routed the first to the second.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "which", lambda t: "/usr/bin/" + t)
    monkeypatch.setattr(k8s, "preflight", lambda context="": k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/k", version=(1, 36)),
        "helm": k8s.Tool(name="helm", path="/h", version=(4, 2))}))
    ready = eks.CloudPreflight(
        tools={"aws": k8s.Tool(name="aws", path="/a", version=(2, 0)),
               "eksctl": k8s.Tool(name="eksctl", path="/e", version=(0, 200))},
        identity=eks.Identity(account="123456789012",
                              arn="arn:aws:iam::123456789012:user/support"),
        region="eu-west-1")
    assert ready.ready, "the double has to be a box that COULD build a cluster"
    monkeypatch.setattr(eks, "preflight", lambda: ready)

    rows = [r for r in doctorsvc.run_checks()["checks"]
            if r["check"] == "kubernetes-cloud-owned"]
    assert len(rows) == 1, rows
    said = rows[0]["message"]
    assert rows[0]["status"] == "warn", "it is a spending decision, never a failure"
    assert "cluster list" in said, \
        "a report that names the gap and not the command that closes it is half a report"
    assert "not the same as there being none" in said

    # AND IT GOES QUIET THE MOMENT THERE IS A RECORD, because then the loop above says
    # the useful thing instead and repeating "I might not know" beside a named cluster
    # would teach the reader to skip both lines.
    eks.remember("rc-support", region="eu-west-1", account="123456789012")
    after = [r["message"] for r in doctorsvc.run_checks()["checks"]
             if r["check"] == "kubernetes-cloud-owned"]
    assert len(after) == 1 and "rc-support" in after[0], after
    assert "not the same as there being none" not in after[0]


def _crd(release: str = "", namespace: str = "") -> dict:
    """A MongoDBCommunity CRD document, optionally stamped as a helm release's."""
    ann = {}
    if release:
        ann = {"meta.helm.sh/release-name": release,
               "meta.helm.sh/release-namespace": namespace}
    return {"metadata": {"name": "mongodbcommunity.mongodb.com", "annotations": ann}}


def test_a_mongodb_operator_somebody_else_installed_is_adopted_not_installed_over(
        monkeypatch):
    """The one place the project's own adoption principle was not applied.

    cert-manager is keyed on `certificates.cert-manager.io` and ingress on any existing
    IngressClass, so both ADOPT a foreign install -- `cert_manager_installed`'s docstring
    states the reason: "the release can be named anything". The MongoDB operator asked
    instead whether houston's OWN release existed in houston's OWN namespace, so a
    platform team's operator was invisible and `helm upgrade --install` ran regardless.

    On a shared cluster that is a second cluster-scoped controller with
    `watchNamespace=*` reconciling `MongoDBCommunity` resources belonging to workloads
    houston knows nothing about, and a chart-version difference reaching cluster-scoped
    CRDs another install owns.
    """
    from houston.services import k8s

    ran: list = []
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: ran.append(list(argv)) or
                        subprocess.CompletedProcess(list(argv), 0, "", ""))
    monkeypatch.setattr(k8s, "operator_watch_scope", lambda ctx: ("*", ""))
    monkeypatch.setattr(k8s, "operator_presence",
                        lambda ctx: k8s.Answer(k8s.PRESENT,
                                               _crd("mongodb-operator", "platform")))
    said: list = []
    k8s.ensure_operator(context="c", namespace="houston-t1",
                        emit=lambda e: said.append(e.message))
    assert not [a for a in ran if a[:2] == ["helm", "upgrade"]], \
        "it installed a second cluster-scoped operator over somebody else's"
    assert any("adopting" in m for m in said), said

    # AND IT STILL INSTALLS ITS OWN. Adoption must not become "never install", or the
    # ordinary case -- an empty cluster -- silently stops working.
    ran.clear()
    monkeypatch.setattr(k8s, "operator_presence", lambda ctx: k8s.Answer(k8s.ABSENT))
    k8s.ensure_operator(context="c", namespace="houston-t1")
    assert [a for a in ran if a[:2] == ["helm", "upgrade"]], ran

    # AND A CRD THAT IS OUR OWN RELEASE IS UPGRADED, not adopted -- that is every
    # workspace after the first on houston's own cluster.
    ran.clear()
    monkeypatch.setattr(k8s, "operator_presence",
                        lambda ctx: k8s.Answer(k8s.PRESENT,
                                               _crd(k8s.OPERATOR_RELEASE,
                                                    k8s.OPERATOR_NAMESPACE)))
    k8s.ensure_operator(context="c", namespace="houston-t1")
    assert [a for a in ran if a[:2] == ["helm", "upgrade"]], ran


def test_an_unreadable_crd_refuses_rather_than_installing_cluster_scoped_resources(
        monkeypatch):
    """"I could not ask" is not "there is none", and here the action on the other side
    of that question installs CLUSTER-SCOPED CRDs.

    Everywhere else in this module the safe response to REFUSED is to leave a thing
    listed and say it could not be read. Here the safe response is a refusal, because
    guessing "no operator" reaches other people's databases.
    """
    from houston import errors
    from houston.services import k8s

    ran: list = []
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: ran.append(list(argv)) or
                        subprocess.CompletedProcess(list(argv), 0, "", ""))
    monkeypatch.setattr(k8s, "operator_presence", lambda ctx: k8s.Answer(
        k8s.REFUSED, None,
        subprocess.CompletedProcess([], 1, "", "forbidden: crds")))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_operator(context="c", namespace="houston-t1")
    assert "forbidden" in str(exc.value), "the refusal must say what the cluster said"
    assert "customresourcedefinitions" in str(exc.value), \
        "and name the permission that would fix it"
    assert not ran, "nothing may be written on a question that could not be answered"


def test_an_operator_that_does_not_watch_this_namespace_is_refused_not_waited_on(
        monkeypatch):
    """Adopting an operator that will never reconcile this workspace turns into a
    five-minute `wait_for_mongodb` timeout about a database nothing was coming for.

    The scope is a real answer when it can be read, so it is acted on. When it cannot
    be read, adoption still happens -- adopting installs nothing, which is the
    conservative action, and refusing on ignorance would break every cluster whose
    operator simply could not be introspected.
    """
    from houston import errors
    from houston.services import k8s

    ran: list = []
    monkeypatch.setattr(k8s, "run", lambda argv, **kw: ran.append(list(argv)) or
                        subprocess.CompletedProcess(list(argv), 0, "", ""))
    monkeypatch.setattr(k8s, "operator_presence",
                        lambda ctx: k8s.Answer(k8s.PRESENT, _crd("theirs", "platform")))
    monkeypatch.setattr(k8s, "operator_watch_scope", lambda ctx: ("platform,apps", ""))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_operator(context="c", namespace="houston-t1")
    assert "houston-t1" in str(exc.value) and "platform,apps" in str(exc.value)
    assert not ran

    # Unreadable scope -> adopt anyway, and say the scope was not read.
    monkeypatch.setattr(k8s, "operator_watch_scope", lambda ctx: ("", "RBAC denied"))
    said: list = []
    k8s.ensure_operator(context="c", namespace="houston-t1",
                        emit=lambda e: said.append(e.message))
    assert any("adopting" in m and "RBAC denied" in m for m in said), said
    assert not [a for a in ran if a[:2] == ["helm", "upgrade"]], ran


def test_the_operator_scope_reader_tells_own_namespace_from_unreadable(monkeypatch):
    """`WATCH_NAMESPACE` unset via a fieldRef is the chart's single-namespace default.

    That is a real answer -- own namespace only -- and reporting it as unreadable would
    make houston adopt an operator it has just been told does not cover it.
    """
    from houston.services import k8s

    dep = {"metadata": {"namespace": "platform"},
           "spec": {"template": {"spec": {"containers": [
               {"env": [{"name": "WATCH_NAMESPACE",
                         "valueFrom": {"fieldRef": {}}}]}]}}}}
    monkeypatch.setattr(k8s, "ask_list",
                        lambda *a, **k: k8s.Answer(k8s.PRESENT, {"items": [dep]}))
    assert k8s.operator_watch_scope("c") == ("platform", "")

    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.REFUSED, None, subprocess.CompletedProcess([], 1, "", "denied")))
    scope, unreadable = k8s.operator_watch_scope("c")
    assert scope == "" and unreadable, "a refusal is not an empty scope"

    assert k8s.operator_watches("*", "houston-t1")
    assert k8s.operator_watches("a,houston-t1", "houston-t1")
    assert not k8s.operator_watches("a,b", "houston-t1")


def test_a_load_balancer_with_both_an_ip_and_a_hostname_yields_one_of_them(monkeypatch):
    """The jsonpath this replaces interpolated ip and hostname adjacently.

    It was safe only because the two platforms in play populate exactly one each --
    k3s ServiceLB sets `ip`, an AWS ELB/NLB sets `hostname`. A Service carrying both,
    which some controllers and every dual-stack setup produce, yielded the two
    concatenated into one nonsense string that travelled into `IngressEndpoint.address`
    and out as a printed CNAME target somebody would paste into DNS.

    Hostname wins where both exist: a CNAME target has to be a name, and an ELB's
    addresses change under it.
    """
    from houston.services import k8s

    def svc(name, **ingress):
        return {"metadata": {"name": name}, "spec": {"type": "LoadBalancer"},
                "status": {"loadBalancer": {"ingress": [ingress]}}}

    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.PRESENT, {"items": [svc("both", ip="10.0.0.9", hostname="a.elb.aws")]}))
    assert k8s.loadbalancer_service("c") == ("both", "a.elb.aws")

    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.PRESENT, {"items": [svc("k3s-ish", ip="172.16.0.2")]}))
    assert k8s.loadbalancer_service("c") == ("k3s-ish", "172.16.0.2")

    # An address-less entry first must not read as "a load balancer with no address" --
    # the old code looked at `ingress[0]` and nothing else.
    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(k8s.PRESENT, {
        "items": [{"metadata": {"name": "late"}, "spec": {"type": "LoadBalancer"},
                   "status": {"loadBalancer": {"ingress": [{}, {"hostname": "b.aws"}]}}}]}))
    assert k8s.loadbalancer_service("c") == ("late", "b.aws")

    # A ClusterIP Service is not a load balancer, whatever its status says.
    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(k8s.PRESENT, {
        "items": [{"metadata": {"name": "cip"}, "spec": {"type": "ClusterIP"},
                   "status": {"loadBalancer": {"ingress": [{"ip": "1.2.3.4"}]}}}]}))
    assert k8s.loadbalancer_service("c") == ("", "")


def test_prepare_waits_for_the_load_balancer_address_it_is_asked_for(monkeypatch):
    """`cluster prepare` runs immediately after a twenty-minute `cluster create`.

    An ELB commonly takes one to three minutes to publish a hostname, so asking once
    made a blank CNAME target the NORMAL outcome of a successful create — on the one
    line an operator needs in order to finish the job.

    And a blank has two causes that need opposite next actions: "still coming" (prepare
    again in a minute) and "nothing is waiting for an address" (re-running will never
    help, because this cluster has no load-balancing ingress). Nothing in the result
    distinguished them, so the CLI advised re-running in both cases.
    """
    from houston.services import k8s

    # Pending for two ticks, then an address.
    seq = [("", "", 1), ("", "", 1), ("traefik", "a.elb.aws", 0)]
    monkeypatch.setattr(k8s, "loadbalancer_state", lambda ctx=None: seq.pop(0))
    said: list = []
    slept: list = []
    got = k8s.wait_for_loadbalancer("c", emit=lambda e: said.append(e.message),
                                    sleep=slept.append)
    assert got == ("traefik", "a.elb.aws")
    assert len(slept) == 2, "it must actually wait rather than spin"
    assert len([m for m in said if "waiting for" in m]) == 1, \
        "one line, not one per tick — the log is read by a person"

    # NOTHING PENDING: answered on the first read, with no sleeping at all. Spending
    # three minutes proving a cluster has no ingress is the slowest possible way to
    # say so.
    monkeypatch.setattr(k8s, "loadbalancer_state", lambda ctx=None: ("", "", 0))
    slept.clear()
    assert k8s.wait_for_loadbalancer("c", sleep=slept.append) == ("", "")
    assert slept == [], "there was nothing to wait for"


def test_a_refused_service_read_is_not_a_cluster_without_load_balancers(monkeypatch):
    """`loadbalancer_state` counts pending Services, and a refused read counts none.

    The caller must not then wait three minutes on a cluster it could not read; it
    returns immediately, and the empty address is reported as the honest "no address"
    it already was rather than becoming a new claim.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.REFUSED, None, subprocess.CompletedProcess([], 1, "", "denied")))
    assert k8s.loadbalancer_state("c") == ("", "", 0)
    slept: list = []
    assert k8s.wait_for_loadbalancer("c", sleep=slept.append) == ("", "")
    assert slept == []


def test_the_ingress_class_adopted_is_the_clusters_own_default_not_the_first_listed(
        monkeypatch):
    """An EKS cluster carrying both `alb` and `nginx` had the choice made by whichever
    the API server happened to list first.

    The two behave differently for ACME http-01 solving and for `ingress_endpoint`
    discovery, so that is a real difference decided by nothing. Kubernetes already has
    an answer -- `ingressclass.kubernetes.io/is-default-class` is how a cluster says
    which controller an unclassed Ingress gets -- so somebody has stated a preference
    and houston should not overrule it.
    """
    from houston.services import k8s

    def klass(name, default=False):
        meta = {"name": name}
        if default:
            meta["annotations"] = {
                "ingressclass.kubernetes.io/is-default-class": "true"}
        return {"metadata": meta}

    # The API lists alb first; nginx is the cluster's declared default.
    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.PRESENT, {"items": [klass("alb"), klass("nginx", default=True)]}))
    assert k8s.ingress_classes("c")[0] == "nginx", \
        "the cluster said which one it prefers and was overruled by list order"

    # With no default, the order is by name -- arbitrary, but the SAME arbitrary
    # answer every time, which "whatever the API listed first" was not.
    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.PRESENT, {"items": [klass("zeta"), klass("alpha")]}))
    assert k8s.ingress_classes("c") == ["alpha", "zeta"]

    # A refused read stays None -- "I could not ask" is not "there are none".
    monkeypatch.setattr(k8s, "ask_list", lambda *a, **k: k8s.Answer(
        k8s.REFUSED, None, subprocess.CompletedProcess([], 1, "", "denied")))
    assert k8s.ingress_classes("c") is None


def test_naming_an_ingress_class_is_obeyed_or_refused_never_quietly_ignored(monkeypatch):
    """Somebody who passes `--ingress-class alb` and silently gets nginx has been
    overruled without being told, which is worse than an error.

    And when several exist and none was named, the choice is stated: it is a decision,
    and this emit is the only place it is visible.
    """
    from houston import errors
    from houston.services import k8s

    monkeypatch.setattr(k8s, "ingress_classes", lambda ctx: ["nginx", "alb"])
    said: list = []
    got = k8s.ensure_ingress(context="c", distribution="eks", prefer="alb",
                             emit=lambda e: said.append(e.message))
    assert got == "alb" and any("as asked" in m for m in said), said

    with pytest.raises(errors.PreflightError) as exc:
        k8s.ensure_ingress(context="c", distribution="eks", prefer="traefik")
    assert "traefik" in str(exc.value) and "nginx, alb" in str(exc.value), \
        "the refusal has to say what the cluster actually has"

    said.clear()
    got = k8s.ensure_ingress(context="c", distribution="eks",
                             emit=lambda e: said.append(e.message))
    assert got == "nginx"
    assert any("this cluster has nginx, alb" in m and "--ingress-class" in m
               for m in said), said

    # ONE class is the ordinary case and must not gain a choice-of-several sentence.
    monkeypatch.setattr(k8s, "ingress_classes", lambda ctx: ["traefik"])
    said.clear()
    assert k8s.ensure_ingress(context="c", distribution="eks",
                              emit=lambda e: said.append(e.message)) == "traefik"
    assert not any("--ingress-class" in m for m in said), said


def test_a_chart_from_another_era_is_refused_rather_than_installed(monkeypatch):
    """The floor rule is right; below the chart repo's own history it runs out.

    MEASURED against the live index: 96 chart versions, and below 3.0.0 there is
    exactly one — 0.1.0, appVersion 1.16.0 — with nothing in between. So every request
    below chart 3.0.0's appVersion landed on a 1.16-era chart that predates `extraEnv`,
    `microservices.*`, `mongodb.enabled` and the security-context handling: every
    values key houston sets. It would render something, and not a working workspace.

    Refusing beats that and beats a pod that never starts, because the tool HAS an
    answer for these versions — the Docker runtime supports them natively.
    """
    import json as _json

    from houston import errors
    from houston.services import k8s

    # The real shape of the index at its old end, from the live repository.
    index = [{"version": "0.1.0", "app_version": "1.16.0"},
             {"version": "3.0.0", "app_version": "3.7.2"},
             {"version": "6.4.4", "app_version": "6.4.4"},
             {"version": "7.0.2", "app_version": "8.6.1"}]
    monkeypatch.setattr(k8s, "run", lambda *a, **kw: subprocess.CompletedProcess(
        [], 0, _json.dumps(index), ""))

    assert k8s.resolve_chart_version("6.4.4") == "6.4.4", "exact match still wins"
    assert k8s.resolve_chart_version("5.0.0") == "3.0.0", \
        "the floor rule is correct wherever a same-era chart exists"

    for old in ("3.0.0", "2.4.14", "1.0.0"):
        try:
            got = k8s.resolve_chart_version(old)
        except errors.ValidationError as exc:
            assert "Docker runtime" in str(exc), \
                "a refusal that does not name the answer is half a refusal"
            assert "0.1.0" in str(exc) and "1.16.0" in str(exc), \
                "and it has to show WHY — the chart it would otherwise have used"
        else:
            raise AssertionError(f"RC {old} resolved to chart {got}, a different era")

    # THE BOUNDARY ITSELF RESOLVES. Refusing one version too many would take away
    # Kubernetes support for a version that works.
    assert k8s.resolve_chart_version("3.7.2") == "3.0.0"

    # AND A VERSION NEWER THAN EVERY CHART IS THE OPPOSITE CASE, kept as it was: the
    # chart repo has not caught up with a fresh RC release, and the newest chart is the
    # honest best effort. Answering an OLD version that way was the bug -- RC 1.0.0
    # resolved to chart 7.0.2, which deploys 8.6.1, the furthest possible thing from
    # what was asked.
    # A VERSION NEWER THAN EVERY CHART IS THE OPPOSITE CASE and is not refused: the
    # chart repo has not caught up with a fresh RC release, and the newest chart at or
    # below it is the honest best effort. Answering an OLD version that way was the
    # bug — RC 1.0.0 resolved to chart 7.0.2, which deploys 8.6.1.
    said: list = []
    assert k8s.resolve_chart_version("99.0.0",
                                     emit=lambda e: said.append(e.message)) == "7.0.2"

    # AND IT SAYS NOTHING ON THE WAY. A chart behind the app is the normal case --
    # "most Rocket.Chat releases have no chart with a matching appVersion" -- so a line
    # about it fired on essentially every create, immediately before `chart X for
    # Rocket.Chat Y` said the same thing better. Observed on a real create as noise.
    assert said == [], said
    said.clear()
    k8s.resolve_chart_version("6.4.4", emit=lambda e: said.append(e.message))
    assert said == [], said


def test_an_amd64_only_rocket_chat_is_refused_on_an_arm64_only_cluster():
    """`nodes_summary` has always READ the node architectures and its docstring has
    always said why they matter. The value went to one string on `doctor`'s screen and
    was never compared against anything.

    MEASURED with `docker manifest inspect` against registry.rocket.chat: 7.8.0, 7.9.0
    and 7.10.0 return a single `manifest.v2+json` — amd64 alone — while 8.0.0 and 8.5.1
    return a manifest list carrying amd64 and arm64.

    The irony is the point: the amd64-only range is precisely the range houston exists
    for, and a Graviton node group is an ordinary way to run EKS cheaply.
    """
    from houston.services import k8s

    arm = k8s.Preflight(cluster_reachable=True, architectures=["arm64"])
    said = k8s.architecture_blocker(arm, "6.5.0")
    assert said, "an amd64-only image on an arm64-only cluster cannot pull"
    assert "6.5.0" in said and "arm64" in said
    assert "Docker runtime" in said, "the refusal has to name the answer"

    # THE BOUNDARY, measured. 8.0.0 is the first multi-arch release; refusing it would
    # take away a version that works.
    assert not k8s.architecture_blocker(arm, "8.0.0")
    assert k8s.architecture_blocker(arm, "7.10.0")

    # ONE amd64 NODE IS ENOUGH. Kubernetes schedules it there, and pinning with a
    # nodeSelector would trade a fast, legible ErrImagePull for a silent Pending.
    mixed = k8s.Preflight(cluster_reachable=True, architectures=["amd64", "arm64"])
    assert not k8s.architecture_blocker(mixed, "6.5.0")

    # AND NOTHING IS INFERRED FROM WHAT WAS NOT READ. An unread architecture list is
    # not a mismatch, and an unreachable cluster is a different report's problem —
    # the same rule `storage_blocker` opens with.
    assert not k8s.architecture_blocker(
        k8s.Preflight(cluster_reachable=True, architectures=[]), "6.5.0")
    assert not k8s.architecture_blocker(
        k8s.Preflight(cluster_reachable=False, architectures=["arm64"]), "6.5.0")


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
    monkeypatch.setattr(lcmod, "resolve_name", lambda n: "drift")
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.DOCKER)
    meta = type("M", (), {"extra": {"env": {"OVERWRITE_SETTING_Accounts_RegistrationForm":
                                            "Disabled"}}})()
    monkeypatch.setattr(runner, "read_meta", lambda n: meta)
    monkeypatch.setattr(runner, "read_compose", lambda n: {"services": {"rocketchat": {
        "environment": {"OVERWRITE_SETTING_Accounts_RegistrationForm": "Disabled",
                        "ROOT_URL": "http://localhost:3000"}}}})

    # The container never got the variable.
    monkeypatch.setattr(runner, "rc_container_env",
                        lambda n: {"ROOT_URL": "http://localhost:3000"})
    out = envvars.current("drift")
    assert out["drift"] == ["OVERWRITE_SETTING_Accounts_RegistrationForm"]
    assert out["live_read"] is True
    row = next(e for e in out["env"] if e["key"].startswith("OVERWRITE_"))
    assert row["drift"] is True and row["live"] == ""
    assert not [e for e in out["env"] if e["key"] == "ROOT_URL" and e.get("drift")], \
        "a value that matches must not be marked"

    # A DIFFERENT value is drift too, not only a missing one.
    monkeypatch.setattr(runner, "rc_container_env", lambda n: {
        "OVERWRITE_SETTING_Accounts_RegistrationForm": "Public",
        "ROOT_URL": "http://localhost:3000"})
    row = next(e for e in envvars.current("drift")["env"]
               if e["key"].startswith("OVERWRITE_"))
    assert row["drift"] is True and row["live"] == "Public", \
        "the reader has to see what it is actually running, not only that it differs"

    # AND A CONTAINER THAT COULD NOT BE READ IS NOT UNIVERSAL DRIFT. `None` means the
    # question could not be asked -- the module's rule -- so nothing is claimed, and
    # `live_read` says so rather than the report looking clean.
    monkeypatch.setattr(runner, "rc_container_env", lambda n: None)
    quiet = envvars.current("drift")
    assert quiet["drift"] == [] and quiet["live_read"] is False
    assert not any(e.get("drift") for e in quiet["env"])


def test_an_interrupted_env_apply_is_healed_by_the_next_one(monkeypatch, tmp_path):
    """Compose decides what to recreate from a config hash on the container, and that
    was measured not to fire: after the interrupted apply above, re-running `env`
    reported success and changed nothing.

    Forcing it is scoped to the one service — Mongo and its volume are untouched, which
    is the reason recreating here is safe at all.
    """
    from houston import runner
    from houston.services import envvars, lifecycle as lcmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lcmod, "resolve_name", lambda n: "drift")
    meta = type("M", (), {"extra": {}, "rc_version": "8.5.1", "name": "drift"})()
    monkeypatch.setattr(runner, "read_meta", lambda n: meta)
    monkeypatch.setattr(runner, "read_compose", lambda n: {"services": {"rocketchat": {
        "environment": {"ROOT_URL": "http://localhost:3000"}}}})
    monkeypatch.setattr(runner, "write", lambda *a, **kw: None)
    monkeypatch.setattr(envvars, "warn_bare_settings", lambda *a, **kw: None)
    seen: dict = {}

    def fake_up(name, *, pull=True, force_recreate=""):
        seen["force"] = force_recreate
        return 0

    monkeypatch.setattr(runner, "up", fake_up)
    envvars.set_env("drift", {"A": "1"}, [], restart=True)
    assert seen["force"] == "rocketchat", \
        "without --force-recreate an interrupted apply persists and no command heals it"


def test_prepare_resolves_a_short_cluster_name_like_every_other_cluster_command(
        monkeypatch, tmp_path):
    """`--context support` is the form `cluster create` prints in its own closing line
    and the form the shipped guide teaches. An EKS context is really
    `arn:aws:eks:<region>:<account>:cluster/support`, which nobody types.

    MEASURED on a freshly built cluster: `houston cluster prepare --context support`
    failed in 0.27 seconds — far too fast to have asked AWS anything — with "could not
    read the StorageClasses in 'support' ... This is a permissions problem on the
    credential in your kubeconfig". A confident and completely wrong diagnosis that
    sends somebody to fix IAM, when the context simply had not been expanded.

    `cluster status` had resolved short names all along; `prepare` passed the raw
    argument straight to kubectl. Two commands in the same group disagreeing about
    what a cluster may be called is the kind of thing only a live run finds.
    """
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    seen: dict = {}

    def resolve(name):
        seen["asked"] = name
        return (ARN, "") if name in ("support", ARN) else (name, "")

    monkeypatch.setattr(k8s, "assert_context_known", resolve)
    # Everything below answers only for the RESOLVED name, exactly as a kubeconfig
    # does: the short name is not a context and kubectl refuses it.
    monkeypatch.setattr(k8s, "storage_classes",
                        lambda ctx: (["gp2", "gp3"], "gp3") if ctx == ARN else None)
    monkeypatch.setattr(k8s, "ensure_ingress", lambda **kw: "traefik")
    monkeypatch.setattr(k8s, "ensure_cert_manager", lambda **kw: None)
    monkeypatch.setattr(k8s, "wait_for_loadbalancer", lambda ctx, **kw: ("t", "elb.aws"))
    monkeypatch.setattr(k8s, "loadbalancer_state", lambda ctx=None: ("t", "elb.aws", 0))

    out = eks.prepare_cluster("support")
    assert seen["asked"] == "support", "the short name has to reach the resolver"
    assert out["context"] == ARN, "and the result must report the context it used"
    assert out["storage_class"] == "gp3"
    assert out["cname_target"] == "elb.aws", \
        "the CNAME target is the one line an operator needs to finish the job"


def test_a_default_certificate_before_issuance_is_not_blamed_on_a_proxy(monkeypatch):
    """An ingress controller serves its OWN default certificate for a name it has no
    certificate for yet — so while cert-manager works through the ACME order, the
    cluster answers with exactly the certificate this check used to blame on
    "something in front is terminating TLS".

    OBSERVED through the GUI on a first workspace on a cold EKS cluster: the image
    pull ate the certificate window, the wait expired, and the create finished by
    sending the reader to `doctor` to look for a port conflict on their own machine
    that did not exist. The certificate arrived about a minute later.

    `certificate_ready` was computed by `create_workspace` all along and thrown away.
    It is the whole difference between "not issued yet" and "issued, and somebody else
    is answering for this name".
    """
    from houston.services import lifecycle as lcmod
    from houston import tls as tlsmod

    ktls = lcmod._KubeTls(host="x.example.com", ingress_class="traefik",
                          endpoint=None, context="c", issuer=None)
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **kw: {
        "serving": True, "fallback": True, "issuer": "CN = TRAEFIK DEFAULT CERT"})

    # NOT ISSUED YET: the ordinary case, and it must read as one.
    said: list = []
    lcmod._publish_kubernetes_name("w", ktls, cert_ready=False,
                                   emit=lambda e: said.append(e.message),
                                   sleep=lambda _s: None)
    joined = " ".join(said)
    assert "has not issued one yet" in joined, said
    assert "something in front" not in joined, \
        "a certificate that is still coming is not a proxy stealing the name"
    assert "houston doctor" not in joined, \
        "and it must not send somebody hunting a port conflict that does not exist"

    # ISSUED, and the name still answers with somebody else's default certificate.
    # Now the alarming reading is the correct one.
    said.clear()
    lcmod._publish_kubernetes_name("w", ktls, cert_ready=True,
                                   emit=lambda e: said.append(e.message),
                                   sleep=lambda _s: None)
    joined = " ".join(said)
    assert "something in front is terminating TLS" in joined, said
    assert "houston doctor" in joined, said


def test_the_agent_skill_does_not_claim_a_refusal_the_code_stopped_making():
    """A fifth registry walk, and this one guards a document rather than a table.

    `data/skill/SKILL.md` instructs something that is not a person, and its whole
    reason for existing is that a caller told the wrong thing has no way to notice. It
    said `--https` / `--domain` "does not create an Ingress for a Kubernetes workspace
    yet ... use `--runtime docker` when the case needs TLS" — long after the Kubernetes
    path grew an Ingress, a cert-manager issuer and a Let's Encrypt certificate proven
    against a live EKS cluster. Nothing caught it, because nothing compared the
    document to the registry it was describing.

    `_KUBERNETES_UNSUPPORTED` is that registry, and it is the same one `/api/settings`
    serves to the create dialog so a field can be ABSENT rather than refused. Anything
    that has left it is supported, and the skill must not go on refusing it.
    """
    import pathlib

    from houston.services import lifecycle as lcmod

    text = (pathlib.Path(lcmod.__file__).parent.parent
            / "data" / "skill" / "SKILL.md").read_text()
    refused = {f["field"] for f in lcmod.unsupported_fields("kubernetes")}
    assert refused, "the registry itself is empty — this walk would prove nothing"

    # The section that enumerates refusals, so a passing MENTION of a flag elsewhere
    # ("`--domain` creates an Ingress") is not read as a claim that it is refused.
    start = text.index("### What Kubernetes refuses, and why")
    end = text.index("###", start + 10)
    block = text[start:end]

    for field in ("https", "domain", "fresh", "reg_token"):
        flag = "--" + field.replace("_", "-")
        claimed = f"- `{flag}`" in block or f"`{flag}` /" in block
        if field in refused:
            assert claimed, (
                f"{flag} IS refused on Kubernetes and the skill does not say so — an "
                f"agent will hand a user a command that fails.")
        else:
            assert not claimed, (
                f"the skill still refuses {flag} on Kubernetes, and the code does not. "
                f"An agent reading this sends users to `--runtime docker` for something "
                f"that works — which is exactly how this drifted the first time.")


def test_every_service_module_is_named_in_the_map():
    """A sixth registry walk, for the map a person reads before touching anything.

    `CLAUDE.md`'s services list ends with its own prediction: "A number here drifts the
    first time somebody adds a module and forgets to come back — which is exactly how
    `eventlog` came to be missing from both." It happened again, twice: the entire
    cloud path shipped without `eks` or `cluster` appearing in that list or the command
    table, so the map for anyone arriving at this repo had no cloud in it at all.

    The file says the list IS the map, so a module missing from it is the bug rather
    than an omission somebody chose. `ls houston/services/` is the authority.
    """
    import pathlib

    from houston import services

    root = pathlib.Path(services.__file__).parent
    text = (root.parent.parent / "CLAUDE.md").read_text()
    modules = sorted(p.stem for p in root.glob("*.py") if p.stem != "__init__")
    assert modules, "found no service modules — this walk would prove nothing"

    missing = [m for m in modules if f"`{m}`" not in text]
    assert not missing, (
        "these service modules are not named in CLAUDE.md's map: "
        + ", ".join(missing)
        + ". The list is the map — add them, or the next person arrives without them.")


def test_tls_status_probes_the_name_when_tls_terminates_in_the_cluster(monkeypatch):
    """`tls-status` dials 127.0.0.1 with the domain as SNI so a proxy in front cannot
    answer for us. That is right for a workspace THIS box terminates TLS for, and
    wrong for every Kubernetes one: the certificate is a Secret in the cluster, the
    cluster's own ingress holds :443, and the create says so in as many words — "this
    machine is not in the path".

    MEASURED against a live EKS workspace: `openssl s_client` and `curl` both fetched
    a real Let's Encrypt certificate for the name from this very box, `curl` reported
    `ssl_verify_result: 0`, and `tls-status` answered "the ingress controller's
    built-in placeholder certificate ... the ACME order is stuck". Loopback had reached
    houston's OWN edge, a Traefik that has never heard of the name. A healthy
    workspace reported as broken is the exact failure this command exists to prevent.

    `tls_terminates` is recorded on the workspace by `_create_kubernetes`, so the
    answer is already there — it just was not asked.
    """
    import ast
    import pathlib

    from houston import cli as climod
    from houston.web import app as webmod

    for mod, where in ((climod, "the CLI's tls-status"), (webmod, "the GUI's /tls")):
        src = pathlib.Path(mod.__file__).read_text()
        assert 'tls_terminates") or "") == "cluster"' in src, (
            f"{where} does not branch on where TLS terminates, so on a Kubernetes "
            f"workspace it probes this box instead of the name and reports a healthy "
            f"workspace as broken.")
        # And the branch has to actually probe the HOST, not loopback again.
        tree = ast.parse(src)
        loopback_calls = [n for n in ast.walk(tree)
                          if isinstance(n, ast.Call)
                          and getattr(n.func, "attr", "") == "verify"
                          and n.args and isinstance(n.args[0], ast.Constant)
                          and n.args[0].value == "127.0.0.1"]
        host_calls = [n for n in ast.walk(tree)
                      if isinstance(n, ast.Call)
                      and getattr(n.func, "attr", "") == "verify"
                      and n.args and isinstance(n.args[0], ast.Name)
                      and n.args[0].id == "host"]
        assert loopback_calls, f"{where}: the Compose path must still probe loopback"
        assert host_calls, (
            f"{where}: nothing probes the name, so the cluster-terminated case cannot "
            f"be answered correctly.")
