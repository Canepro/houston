"""`houston.web.routes.repros`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from houston import errors
from houston.services import lifecycle as lc
from webhelpers import (
    H, PASSWORD, _CROSS, _as, _auth, _stub_call_target, _workspace,
    anon_client as anon_client, basic_client as basic_client, client
)

def test_api_requires_a_session(monkeypatch):
    assert client(sign_in=False).get("/api/repros", headers=H).status_code == 401
    # Mock the service so the authorized half is a real assertion — it used to be
    # `== 200 or True`, which passes unconditionally.
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [])
    assert client().get("/api/repros", headers=H).status_code == 200


def test_list_repros(monkeypatch):
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [{"name": "x", "state": "running"}])
    r = client().get("/api/repros", headers=H)
    assert r.status_code == 200 and r.json()["repros"][0]["name"] == "x"


def test_reproerror_maps_to_http_status(monkeypatch):
    def boom(name):
        raise errors.NotFoundError("no such repro")
    monkeypatch.setattr(lc.inspect, "describe", boom)
    r = client().get("/api/repros/ghost", headers=H)
    assert r.status_code == 404 and r.json()["kind"] == "NotFoundError"


def test_validation_error_maps_to_400(monkeypatch):
    """Through the REAL refusal rather than a stubbed one.

    This used to stub `lc.teardown` to raise. Teardown is a job now, and a job answers
    200 with an id -- so the refusal moved to `check_teardown_request`, which runs on
    the request thread precisely so that a wrong request still gets its status code.
    Exercising the genuine unconfirmed-volumes path asserts the mapping AND that the
    check is still reached, which the stub could not.
    """
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    r = client().delete("/api/repros/x?volumes=true", headers=H)
    assert r.status_code == 400, r.text
    assert "irreversible" in r.json()["error"]


def test_create_returns_job_id(monkeypatch):
    monkeypatch.setattr(lc.create_docker, "create_repro",
                        lambda req, emit, stream_output=False: {"name": "rc8-5-1"})
    r = client().post("/api/repros", headers=H, json={"version": "8.5.1", "preset": "default"})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")


def test_detail_and_stats_endpoints(monkeypatch):
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.payload, "detail", lambda n: {"name": n, "state": "running", "uptime": "2 hours",
                                                 "containers": [], "env": [], "links": []})
    r = client().get("/api/repros/x/detail", headers=H)
    assert r.status_code == 200 and r.json()["uptime"] == "2 hours"
    # stats parses docker stats rocketchat rows into cpu + mem_mb
    monkeypatch.setattr(lc.runner.engine, "container_ids", lambda n: ["c1"])
    monkeypatch.setattr(lc.runner.queries, "docker_stats", lambda ids: "houston-x-rocketchat-1\t120.0%\t900MiB / 8GiB")
    r = client().get("/api/repros/x/stats", headers=H)
    j = r.json()
    assert r.status_code == 200 and j["cpu"] == 120.0 and j["mem_mb"] > 900


def test_stats_answers_a_kubernetes_workspace_over_http(monkeypatch, tmp_path):
    """`stats` refused this runtime and now answers it, in the same shape.

    The refusal was right while there was nothing behind it -- running `docker stats`
    on nothing and returning a plausible zero is the failure that would be believed.
    It is `kubectl top` now, summed over every Rocket.Chat pod so replicas count the
    way compose instances do, and the payload keys are unchanged because the GUI
    renders from them.

    Docker must not be reached for it: that was the original defect.
    """
    from houston import runner as R
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = R.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                   mongo_tag="8.0", mongo_flavor="official", preset="default",
                   root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    R.write("k", "services: {}\n", m)

    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.engine, "container_ids",
                        lambda n: pytest.fail("docker was reached for a Kubernetes "
                                              "workspace"))
    monkeypatch.setattr(k8s.status, "pod_metrics", lambda name, *, context: [
        {"pod": "rocketchat-a", "cpu_millicores": 150.0, "mem_bytes": 400e6},
        {"pod": "rocketchat-b", "cpu_millicores": 50.0, "mem_bytes": 200e6}])

    r = client().get("/api/repros/k/stats", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"cpu", "mem_mb"}, "the GUI renders from these keys"
    assert body["mem_mb"] == 600.0, "every Rocket.Chat pod counts, not just the first"
    assert body["cpu"] == 20.0, "millicores rendered on the same scale as docker's %"


def test_reading_env_over_http_answers_for_a_kubernetes_workspace(
        monkeypatch, tmp_path):
    """This route raised a bare FileNotFoundError, so `serve` answered 500.

    A path in a stack trace, for a request that was merely unsupported, while
    `stats` on the same workspace answered cleanly. It then refused with 400, and now
    answers -- read out of the running container, which shows variables the chart
    contributes that no document houston writes would ever list.

    Asserted through real HTTP because 500 versus 400 versus 200 is the whole
    history of this endpoint.
    """
    import json as _json
    from dataclasses import asdict

    from houston import runner as R
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = R.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                   mongo_tag="8.0", mongo_flavor="official", preset="default",
                   root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    ws = R.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    assert not (ws / "docker-compose.yml").exists()

    monkeypatch.setattr(lc.naming, "resolve_name", lambda n, actor="": n)
    monkeypatch.setattr(k8s.status, "container_env", lambda name, *, context: {
        "ROOT_URL": "http://localhost:3010", "ADMIN_PASS": "admin123"})

    r = client().get("/api/repros/k/env", headers=H)
    assert r.status_code == 200, r.text
    keys = {row["key"]: row["value"] for row in r.json()["env"]}
    assert keys["ROOT_URL"] == "http://localhost:3010"
    assert keys["ADMIN_PASS"] != "admin123", "credentials are masked over HTTP too"


def test_an_error_payload_carries_the_stable_code_not_just_the_class_name(monkeypatch):
    """errors.py promises `code` is "the stable identifier a machine-readable
    payload reports, so callers branch on it rather than on prose" -- and nothing
    kept that promise. The web layer answered only `kind`, which is the Python
    class name: renaming a class is a refactor, renaming a `code` is a breaking
    change, so a caller branching on `kind` was branching on the one field nobody
    had agreed not to move.

    Asserted through real HTTP for every class in the taxonomy, because the value
    that matters is the one a client actually receives.
    """
    from houston import errors

    cases = [
        (errors.NotFoundError("gone"), 404, "NOT_FOUND"),
        (errors.ValidationError("bad"), 400, "VALIDATION_FAILED"),
        (errors.ConflictError("taken"), 409, "CONFLICT"),
        (errors.NotReadyError("booting"), 409, "NOT_READY"),
        (errors.DockerError("engine down"), 502, "ENGINE_UNAVAILABLE"),
        (errors.PreflightError("no room"), 409, "PREFLIGHT_FAILED"),
        (errors.CreateFailedError("dead"), 500, "CREATE_FAILED"),
    ]
    for exc, status, code in cases:
        def boom(*_a, _exc=exc, **_kw):
            raise _exc
        monkeypatch.setattr(lc.payload, "detail", boom)
        r = client().get("/api/repros/x/detail", headers=H)
        assert r.status_code == status, f"{code} answered {r.status_code}"
        assert r.json()["code"] == code, f"{code} was not published"
        assert r.json()["kind"] == type(exc).__name__, "kind stays, for anything reading it"


def test_a_gate_tells_the_caller_what_a_human_must_run(monkeypatch):
    """`AuthorityGateError.as_gate()` was written "for a machine-readable error
    payload" and had no caller anywhere, so `approve_with` -- the exact command for
    a human to run, which is the entire point of a gate -- never left the process.
    A caller could see 403 and had no way to learn what would clear it.
    """
    from houston import errors

    def boom(*_a, **_kw):
        raise errors.AuthorityGateError(
            "the target cluster is not an approved one", kind="cluster",
            subject="kind-houston", approve_with="houston doctor --approve-cluster kind-houston",
            code="GATE_UNAPPROVED_CLUSTER")
    monkeypatch.setattr(lc.payload, "detail", boom)
    r = client().get("/api/repros/x/detail", headers=H)
    assert r.status_code == 403
    body = r.json()
    assert body["code"] == "GATE_UNAPPROVED_CLUSTER"
    assert body["code"] in errors.GATE_CODES, "gates are declared, not invented at the call site"
    assert body["gate"]["approve_with"] == "houston doctor --approve-cluster kind-houston"
    assert body["gate"]["subject"] == "kind-houston"


def test_create_only_accepts_known_fields(monkeypatch):
    seen = {}
    monkeypatch.setattr(lc.create_docker, "create_repro",
                        lambda req, emit, stream_output=False, **_kw: seen.update(v=req.version) or {"name": "x"})
    r = client().post("/api/repros", headers=H,
                      json={"version": "8.5.1", "bogus_field": "drop me"})
    assert r.status_code == 200 and seen["v"] == "8.5.1"   # unknown key ignored, no crash


def test_up_endpoint_recreates_a_downed_repro_from_stored_metadata(monkeypatch):
    import time as _t
    import types
    # `down` (keep data) removes the containers, so `docker compose start` can
    # never revive it -- /state is useless and the GUI card had no way back up.
    seen = {}
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.runner.record, "read_meta",
                        lambda n: types.SimpleNamespace(rc_version="8.5.1", preset="ldap"))

    def fake_create(req, emit, stream_output=False):
        seen.update(version=req.version, preset=req.preset, name=req.name,
                    wait=req.wait, offline=req.offline)
        return {"name": req.name}

    monkeypatch.setattr(lc.create_docker, "create_repro", fake_create)
    r = client().post("/api/repros/x/up", headers=H)
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    for _ in range(400):                     # poll rather than a fixed sleep
        if seen:
            break
        _t.sleep(0.01)
    # nothing is re-entered by the user: version and preset come from repro.json
    assert seen == {"version": "8.5.1", "preset": "ldap", "name": "x",
                    "wait": True, "offline": True}


def test_set_default_endpoint(monkeypatch, tmp_path):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    r = client().post("/api/repros/rc8-5-1/default", headers=H)
    assert r.status_code == 200 and r.json()["default"] == "rc8-5-1"
    from houston import config
    assert config.load_config()["default_repro"] == "rc8-5-1"


def test_pat_endpoint_maps_a_failure_to_not_ready(monkeypatch):
    from houston import rcapi, runner as runner_mod
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner_mod.record, "read_meta",
                        lambda n: type("M", (), {"name": n, "root_url": "http://x",
                                                 "extra": {}, "admin_pass": "admin123"})())
    monkeypatch.setattr(lc.admin, "login", lambda m: type("A", (), {"user_id": "u1"})())
    monkeypatch.setattr(rcapi, "generate_pat", lambda *a, **k: "tok_abc")
    r = client().post("/api/repros/x/pat", headers=H, json={})
    assert r.status_code == 200
    assert r.json()["token"] == "tok_abc" and r.json()["user_id"] == "u1"

    # A workspace that is up but not finalized cannot mint one -> 409, not 500.
    monkeypatch.setattr(rcapi, "generate_pat", lambda *a, **k: None)
    assert client().post("/api/repros/x/pat", headers=H, json={}).status_code == 409


def test_api_call_endpoint_relays_the_response(monkeypatch):
    from houston import rcapi
    _stub_call_target(monkeypatch)
    seen = {}

    def fake_call(root_url, method, path, auth=None, data=None, extra_headers=None, **kw):
        seen.update(root_url=root_url, method=method, path=path, data=data,
                    extra=extra_headers, token=auth.token)
        return 200, '{"success":true}'

    monkeypatch.setattr(rcapi.rcapi, "call", fake_call)
    r = client().post("/api/repros/x/call", headers=H,
                      json={"method": "post", "path": "/api/v1/users.update",
                            "data": '{"userId": "abc"}'})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == 200 and body["text"] == '{"success":true}'
    assert body["tag"] == "admin" and body["url"] == "http://x:3000/api/v1/users.update"
    assert isinstance(body["elapsed_ms"], (int, float))
    # The method is upper-cased and the JSON body arrives parsed, not as a string.
    assert seen["method"] == "POST" and seen["data"] == {"userId": "abc"}
    assert seen["extra"] is None and seen["token"] == "t1"


def test_api_call_reports_a_rocketchat_error_as_a_result_not_a_failure(monkeypatch):
    """A 403 from Rocket.Chat is the answer the user asked for.

    Mapping it onto the endpoint's own status would have surfaced it as a red
    toast with no body -- exactly the detail needed to see WHY it was refused.
    """
    from houston import rcapi
    _stub_call_target(monkeypatch)
    monkeypatch.setattr(rcapi.rcapi, "call",
                        lambda *a, **k: (403, '{"error":"unauthorized"}'))
    r = client().post("/api/repros/x/call", headers=H, json={"method": "GET", "path": "/api/v1/me"})
    assert r.status_code == 200
    assert r.json()["status"] == 403 and "unauthorized" in r.json()["text"]


def test_api_call_uses_a_pat_and_the_2fa_header_when_asked(monkeypatch):
    from houston import rcapi
    _stub_call_target(monkeypatch)
    monkeypatch.setattr(rcapi, "generate_pat", lambda *a, **k: "pat_xyz")
    seen = {}

    def fake_call(root_url, method, path, auth=None, data=None, extra_headers=None, **kw):
        seen.update(token=auth.token, user_id=auth.user_id, extra=extra_headers)
        return 200, "{}"

    monkeypatch.setattr(rcapi.rcapi, "call", fake_call)
    r = client().post("/api/repros/x/call", headers=H,
                      json={"method": "GET", "path": "/api/v1/me", "pat": True, "two_fa": True})
    assert r.status_code == 200 and r.json()["tag"] == "PAT+2fa"
    # The PAT replaces the login token; the user id stays.
    assert seen["token"] == "pat_xyz" and seen["user_id"] == "u1"
    assert seen["extra"]["x-2fa-method"] == "password"


def test_api_call_rejects_bad_input_before_touching_the_workspace(monkeypatch):
    from houston import rcapi
    _stub_call_target(monkeypatch)
    monkeypatch.setattr(rcapi.rcapi, "call", lambda *a, **k: pytest.fail("should not have been called"))
    post = lambda body: client().post("/api/repros/x/call", headers=H, json=body)  # noqa: E731
    assert post({"method": "GET", "path": ""}).status_code == 400            # no path
    assert post({"method": "TRACE", "path": "/api/v1/me"}).status_code == 400  # not whitelisted
    bad_json = post({"method": "POST", "path": "/api/v1/me", "data": "{nope}"})
    assert bad_json.status_code == 400 and "valid JSON" in bad_json.json()["error"]


def test_api_call_cannot_be_pointed_at_another_host(monkeypatch):
    """`path` must stay a path on this repro, never a new destination.

    This endpoint takes a caller-supplied URL fragment and has the server fetch
    it, which is the shape of an SSRF. It is safe only because rcapi.call()
    joins `root_url + "/" + path.lstrip("/")` -- pin that, because a "cleaner"
    urljoin() here would silently start honouring an absolute URL.
    """
    from urllib.parse import urlparse

    from houston import rcapi
    _stub_call_target(monkeypatch)
    seen = []
    monkeypatch.setattr(rcapi.rcapi, "call",
                        lambda root, m, p, **k: (seen.append(root), (200, "{}"))[1])
    for hostile in ("http://evil.example/x", "//evil.example/x", "/../../evil"):
        r = client().post("/api/repros/x/call", headers=H,
                          json={"method": "GET", "path": hostile})
        assert r.status_code == 200
        # The host is what matters, not the spelling: "http://evil.example/x"
        # survives as a path *segment* ("http://x:3000/http://evil.example/x"),
        # which is fine. It reaching evil.example is not.
        assert urlparse(r.json()["url"]).netloc == "x:3000", hostile
    assert seen == ["http://x:3000"] * 3


def test_api_call_maps_a_dead_workspace_to_not_ready(monkeypatch):
    import requests

    from houston import rcapi
    _stub_call_target(monkeypatch)

    def boom(*a, **k):
        raise requests.ConnectionError("connection refused")

    monkeypatch.setattr(rcapi.rcapi, "call", boom)
    r = client().post("/api/repros/x/call", headers=H, json={"method": "GET", "path": "/api/v1/me"})
    assert r.status_code == 409 and "connection refused" in r.json()["error"]


def test_api_call_needs_a_session():
    assert client(sign_in=False).post("/api/repros/x/call", json={"method": "GET", "path": "/"}).status_code == 401


def test_tls_endpoint_probes_this_host_not_the_public_name(monkeypatch):
    """The GUI check must not let a proxy in front answer for us.

    Probing the public hostname reported Cloudflare's valid edge certificate as the
    repro's own while its Traefik had none. It dials 127.0.0.1 with the domain as
    SNI, and reports the public name separately.
    """
    from houston import runner as runner_mod
    from houston import tls as tlsmod
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    meta = runner_mod.Metadata(
        name="t", project="p", rc_version="8.4.2", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map",
        public_url="https://rc1.example.com",
        extra={"tls": "acme", "tls_ports": [443]})
    monkeypatch.setattr(runner_mod.record, "read_meta", lambda n: meta)

    seen = []

    def fake_verify(host, port=443, timeout=10.0, cafile=None, sni=None):
        seen.append((host, port, sni))
        if host == "127.0.0.1":
            return {"serving": True, "issuer": "CN = YR2", "subject": "CN = rc1.example.com",
                    "dates": "notAfter=Nov  1 2026", "fallback": False,
                    "trusted": True, "trusted_via_ca": True, "error": ""}
        return {"serving": True, "issuer": "CN = Cloudflare Inc ECC CA-3", "subject": "",
                "dates": "", "fallback": False, "trusted": True,
                "trusted_via_ca": True, "error": ""}

    monkeypatch.setattr(tlsmod, "verify", fake_verify)
    r = client().get("/api/repros/t/tls", headers=H)
    assert r.status_code == 200
    b = r.json()
    assert b["issuer"] == "CN = YR2", "must report what THIS host serves"
    assert b["public_issuer"] == "CN = Cloudflare Inc ECC CA-3"
    assert b["mode"] == "acme" and b["public_url"] == "https://rc1.example.com"
    # The local probe carries the domain as SNI; the public probe uses the name.
    assert ("127.0.0.1", 443, "rc1.example.com") in seen
    assert ("rc1.example.com", 443, None) in seen


def test_tls_endpoint_refuses_a_repro_without_https(monkeypatch):
    from houston import runner as runner_mod
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner_mod.record, "read_meta", lambda n: runner_mod.Metadata(
        name="t", project="p", rc_version="8.4.2", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map"))
    r = client().get("/api/repros/t/tls", headers=H)
    assert r.status_code == 400 and "not created with --https" in r.json()["error"]


def test_tls_endpoint_needs_a_session():
    assert client(sign_in=False).get("/api/repros/t/tls").status_code == 401


def test_env_endpoints(monkeypatch):
    """GET reports the effective env; POST is a job because the recreate is slow."""
    from houston.services import envvars as envsvc
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(envsvc, "current", lambda n: {
        "name": n, "overrides": ["MY"],
        "env": [{"key": "MY", "value": "v", "override": True},
                {"key": "ADMIN_PASS", "value": "********", "override": False}]})
    r = client().get("/api/repros/e/env", headers=H)
    assert r.status_code == 200
    assert r.json()["overrides"] == ["MY"]
    assert [e["key"] for e in r.json()["env"]] == ["MY", "ADMIN_PASS"]

    seen = {}
    monkeypatch.setattr(envsvc, "set_env",
                        lambda name, sets, unset, restart=True, emit=None:
                        seen.update(name=name, sets=sets, unset=unset, restart=restart)
                        or {"name": name, "restarted": restart, "overrides": []})
    r = client().post("/api/repros/e/env", headers=H,
                      json={"set": {"A": "1"}, "unset": ["B"]})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    # The endpoint answers with a job id and does the work on another thread, so
    # `seen` is filled in after the response, not before it. Reading it straight away
    # passed whenever that thread happened to win; this is the bounded poll every other
    # job test in this layer already does.
    for _ in range(400):
        if seen:
            break
        __import__("time").sleep(0.01)
    assert seen["sets"] == {"A": "1"} and seen["unset"] == ["B"] and seen["restart"] is True


def test_env_post_rejects_the_wrong_shapes(monkeypatch):
    """`set` must be an object and `unset` a list — a string for either would reach
    the service layer and produce something incoherent."""
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    for body, msg in [({"set": ["A=1"]}, "must be an object"),
                      ({"unset": "B"}, "must be a list")]:
        r = client().post("/api/repros/e/env", headers=H, json=body)
        assert r.status_code == 400 and msg in r.json()["error"], body


def test_env_endpoints_need_a_session():
    assert client(sign_in=False).get("/api/repros/e/env").status_code == 401
    assert client(sign_in=False).post("/api/repros/e/env", json={"set": {}}).status_code == 401


def test_env_post_keeps_settings_and_plain_vars_apart(monkeypatch):
    """`setting` is prefixed by the SERVER, not the caller.

    The two kinds are not interchangeable — a Rocket.Chat setting only works with
    OVERWRITE_SETTING_, a plain env var only works without it — so the rule lives in
    one place and every front-end gets it.
    """
    from houston.services import envvars as envsvc
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    seen = {}
    monkeypatch.setattr(envsvc, "set_env",
                        lambda name, sets, unset, restart=True, emit=None:
                        seen.update(sets=sets, unset=unset)
                        or {"name": name, "restarted": True, "overrides": []})

    r = client().post("/api/repros/e/env", headers=H, json={
        "set": {"MY_PLAIN": "raw"},
        "setting": {"Message_AllowStarring": "false"},
        "unset": ["OLD"]})
    assert r.status_code == 200
    assert seen["sets"] == {"MY_PLAIN": "raw",
                            "OVERWRITE_SETTING_Message_AllowStarring": "false"}
    assert seen["unset"] == ["OLD"]

    # An already-prefixed setting id is not double-prefixed.
    client().post("/api/repros/e/env", headers=H,
                  json={"setting": {"OVERWRITE_SETTING_Foo_Bar": "1"}})
    assert seen["sets"] == {"OVERWRITE_SETTING_Foo_Bar": "1"}

    # And the shape is validated.
    r = client().post("/api/repros/e/env", headers=H, json={"setting": ["A=1"]})
    assert r.status_code == 400 and "must be an object" in r.json()["error"]


# --- untyped JSON bodies (#audit) ------------------------------------------------
#
# A body field arrives as whatever JSON says it is. Each of these reached code that
# assumed a string and raised, escaping as an opaque 500 to any caller using the
# documented HTTP API. The shipped GUI always sends strings, so none were reachable
# from the browser -- which is exactly why they survived.

def test_create_without_a_version_is_a_400_not_a_500():
    r = client().post("/api/repros", headers=H, json={"preset": "default"})
    assert r.status_code == 400 and "version" in r.json()["error"]
    assert client().post("/api/repros", headers=H, json={}).status_code == 400


def test_create_still_accepts_a_valid_body(monkeypatch):
    monkeypatch.setattr(lc.create_docker, "create_repro",
                        lambda req, emit, stream_output=False: {"name": req.version})
    r = client().post("/api/repros", headers=H, json={"version": "8.5.1", "bogus": 1})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")


def test_state_rejects_a_non_string_action(monkeypatch):
    """`action` reached dict.get() and raised "unhashable type" for a dict/list."""
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    for bad in ({}, [], 5, None):
        r = client().post("/api/repros/x/state", headers=H, json={"action": bad})
        assert r.status_code == 400, f"{bad!r} gave {r.status_code}"


def test_an_anonymous_api_call_is_401_with_no_browser_dialog(anon_client):
    """WWW-Authenticate is what summoned the browser's own grey password box.

    Dropping it is precisely what makes a real sign-in page possible: as long as
    the header is sent, the browser prompts before the page can.
    """
    r = anon_client.get("/api/repros", headers={"Host": "localhost"})
    assert r.status_code == 401
    assert "www-authenticate" not in r.headers
    assert r.json()["kind"] == "Unauthorized"


def test_a_malformed_session_cookie_does_not_crash(anon_client):
    for bad in ("", "!!!", "x" * 5000, "a.b.c"):
        anon_client.cookies.set("houston_session", bad)
        r = anon_client.get("/api/repros", headers={"Host": "localhost"})
        assert r.status_code == 401, bad
    anon_client.cookies.clear()


def test_a_password_change_ends_every_session_it_minted(basic_client, monkeypatch):
    """Changing a compromised password must not leave the intruder signed in for
    the next seven days."""
    from houston.services import sessions as sessionsvc
    from houston.services import users as usersvc
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [])
    assert basic_client.get("/api/repros", headers=_auth()).status_code == 200
    # set_password does the revoking ITSELF now. This used to read
    # `usersvc.set_password(...)` then `assert sessionsvc.revoke_user("alice") == 1`
    # -- which asserted the opposite: that the caller still had to remember. Any
    # caller that forgot left a replaced credential working for seven days.
    ended = usersvc.set_password("alice", "a-brand-new-password")
    assert ended == 1, "the service, not the caller, ends the sessions"
    assert sessionsvc.revoke_user("alice") == 0, "there is nothing left to revoke"
    assert basic_client.get("/api/repros", headers=_auth()).status_code == 401


def test_a_job_records_who_ran_it(basic_client, monkeypatch, tmp_path):
    """Attribution is the point of named accounts — without it they are just a
    shared password with extra steps."""
    monkeypatch.setattr(lc.create_docker, "create_repro",
                        lambda req, emit, stream_output=False: {"name": "x"})
    hdr = _auth("alice", "correct-horse-battery")
    assert basic_client.post("/api/repros", headers=hdr,
                             json={"version": "8.5.1"}).status_code == 200
    rows = basic_client.get("/api/jobs", headers=hdr).json()["jobs"]
    assert rows[0]["actor"] == "alice"


def test_the_audit_log_survives_a_restart(basic_client, monkeypatch, tmp_path):
    """journald is not always where somebody will look, and an in-memory job list
    is gone the moment the service restarts."""
    monkeypatch.setattr(lc.create_docker, "create_repro",
                        lambda req, emit, stream_output=False: {"name": "x"})
    basic_client.post("/api/repros", headers=_auth("alice", "correct-horse-battery"),
                      json={"version": "8.5.1"})
    from houston.web.jobs import AUDIT_FILE
    # Account changes are audited too now, so pick the line under test rather
    # than assuming the file has exactly one.
    lines = [ln for ln in (tmp_path / AUDIT_FILE).read_text().splitlines()
             if "\tcreate\t" in ln]
    assert len(lines) == 1, lines
    when, who, kind, label, origin, outcome = lines[0].split("\t")
    assert who == "alice" and kind == "create" and label == "8.5.1"
    assert when.startswith("20")
    # The two new columns are APPENDED, so the four an existing `cut -f2` reads
    # are still in the same positions.
    assert origin == "session", "a signed-in GUI request, so the identity is checked"
    assert outcome == "ok"


def test_the_actor_comes_from_the_session_not_the_body(basic_client, monkeypatch):
    """Otherwise anyone could create a workspace in a colleague's namespace."""
    seen = {}
    monkeypatch.setattr(lc.create_docker, "create_repro",
                        lambda req, emit, stream_output=False, **_kw:
                        seen.update(actor=req.actor) or {"name": "x"})
    r = basic_client.post("/api/repros", headers=_auth("alice", "correct-horse-battery"),
                          json={"version": "8.5.1", "actor": "bob"})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_")
    for _ in range(400):                     # the create runs on a job thread
        if seen:
            break
        __import__("time").sleep(0.01)
    assert seen["actor"] == "alice", "the body's actor must be ignored"


# --- CSRF (F2) ------------------------------------------------------------------
# In token mode the unguessable ?t= doubles as a CSRF token. A Basic credential
# does not: the browser attaches it automatically, `Host:` is whatever this server
# answers to, and Basic is not a cookie so SameSite never applies. Confirmed
# reachable before the fix -- a body-less POST to /upgrade/rollback, which drops
# the workspace database.

def test_a_cross_site_state_change_is_refused(basic_client):
    creds = _auth("alice", "correct-horse-battery")
    for path in ("/api/repros/x/upgrade/rollback", "/api/repros/x/pat",
                 "/api/repros/x/default", "/api/repros/x/monitor"):
        r = basic_client.post(path, headers={**creds, **_CROSS})
        assert r.status_code == 403, f"{path} -> {r.status_code}"


def test_a_cross_site_delete_is_refused(basic_client):
    r = basic_client.delete("/api/repros/x?volumes=true&confirm=true",
                            headers={**_auth("alice", "correct-horse-battery"), **_CROSS})
    assert r.status_code == 403


def test_the_apps_own_requests_still_work(basic_client):
    """Sec-Fetch-Site: same-origin is what the SPA's own fetch() sends."""
    creds = _auth("alice", "correct-horse-battery")
    r = basic_client.post("/api/repros/x/default",
                          headers={**creds, "Host": "localhost",
                                   "Sec-Fetch-Site": "same-origin",
                                   "Origin": "http://localhost"})
    assert r.status_code != 403


def test_non_browser_clients_are_unaffected(basic_client):
    """curl and CI send neither header; refusing them would break every script."""
    r = basic_client.post("/api/repros/x/default",
                          headers={**_auth("alice", "correct-horse-battery"),
                                   "Host": "localhost"})
    assert r.status_code != 403


def test_a_cross_site_read_is_refused_too(basic_client):
    """Reads used to be waved through as the milder case. They are not.

    `GET /api/repros/{name}/logs` hands over a workspace's container log, which
    carries LDAP bind passwords and OAuth client secrets, and `/api/repros`
    discloses every ticket number on the box. The guard therefore covers every
    /api/ path, not just the state-changing methods.
    """
    creds = _auth("alice", "correct-horse-battery")
    for path in ("/api/repros", "/api/repros/x/logs", "/api/repros/x/detail",
                 "/api/jobs"):
        r = basic_client.get(path, headers={**creds, **_CROSS})
        assert r.status_code == 403, f"{path} -> {r.status_code}"


def test_a_readonly_user_may_look_but_not_touch(basic_client, monkeypatch):
    from houston.services import users as usersvc
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [])
    usersvc.add("ronly", "read-only-password", role="readonly")
    _as(basic_client, "ronly", "read-only-password")

    assert basic_client.get("/api/repros", headers=_auth()).status_code == 200
    assert basic_client.get("/api/doctor", headers=_auth()).status_code == 200
    for path in ("/api/repros/x/state", "/api/repros/x/seed", "/api/repros/x/pat"):
        r = basic_client.post(path, json={}, headers=_auth())
        assert r.status_code == 403, f"{path} -> {r.status_code}"
    assert basic_client.delete("/api/repros/x?volumes=true", headers=_auth()).status_code == 403


def test_only_an_admin_may_choose_the_image_or_the_interface(basic_client, monkeypatch):
    """`rc_image` runs an arbitrary container as the serve user, `reg_token` is an EE
    licence secret, and `bind` can publish a workspace with fixed admin/admin123
    credentials to the network. Those decide what code runs and where it listens,
    which is not the same question as "make me a workspace".

    `port` was in this list and has been REMOVED — see the test below. It is the
    counter-example: a role check that guarded nothing while costing a member the
    most reachable field in the create dialog.

    This is no longer the DEFAULT: a member may set all three unless the box has
    narrowed `gui.create_policy`, which is what this sets up. See
    test_a_member_may_set_the_image_and_bind_by_default.
    """
    from houston import config as cfgmod
    from houston.services import users as usersvc
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    cfgmod.update_config(lambda c: c.__setitem__(lc.CREATE_POLICY_KEY, "admin"))
    usersvc.add("bob", "bobs-good-password", role="member")
    _as(basic_client, "bob", "bobs-good-password")
    for field, value in (("rc_image", "evil/image"), ("bind", "0.0.0.0"),
                         ("reg_token", "x")):
        r = basic_client.post("/api/repros", headers=_auth(),
                              json={"version": "8.5.1", field: value})
        assert r.status_code == 400, f"{field} -> {r.status_code}"
        assert "admin" in r.json()["error"]
    # the ordinary body still works for a member
    assert basic_client.post("/api/repros", headers=_auth(),
                             json={"version": "8.5.1"}).status_code == 200
    # ...and an admin is unaffected by the narrowing.
    _as(basic_client, "alice", PASSWORD)
    assert basic_client.post(
        "/api/repros", headers=_auth(),
        json={"version": "8.5.1", "bind": "0.0.0.0", "rc_image": "registry/rc:x",
              "reg_token": "tok", "port": 3999}).status_code == 200


def test_a_member_may_still_choose_a_host_port(basic_client, monkeypatch):
    """The privileged range this might have guarded — 80 or 443, squatted out from
    under the edge — is refused for EVERYBODY by lifecycle's 1024-65535 check, admin
    included. So the role check protected nothing."""
    from houston.services import users as usersvc
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.create_docker, "create_repro", lambda req, **kw: {"name": "x"})
    usersvc.add("bob", "bobs-good-password", role="member")
    _as(basic_client, "bob", "bobs-good-password")
    r = basic_client.post("/api/repros", headers=_auth(),
                          json={"version": "8.5.1", "port": 3999})
    assert r.status_code == 200, r.text


# --- the activity trail gets readers (H5) -----------------------------------------

def test_the_audit_log_can_finally_be_read(basic_client, monkeypatch):
    """It has been written since accounts landed and read by nothing -- no CLI
    command, no endpoint, no view. "Who tore down TICKET-1234?" meant ssh and cat."""
    monkeypatch.setattr(lc.create_docker, "create_repro",
                        lambda req, emit, stream_output=False: {"name": "x"})
    basic_client.post("/api/repros", headers=_auth(), json={"version": "8.5.1"})
    out = basic_client.get("/api/audit", headers=_auth()).json()
    kinds = [r["kind"] for r in out["lines"]]
    assert "create" in kinds
    row = next(r for r in out["lines"] if r["kind"] == "create")
    assert row["actor"] == "alice" and row["origin"] == "session"
    assert row["outcome"] == "ok"


def test_a_refusal_is_recorded_so_the_role_lines_can_be_reviewed(basic_client):
    """Whether `readonly` is drawn in the right place is an open question in the
    design; `grep denied` is the evidence to settle it with."""
    from houston.services import users as usersvc
    usersvc.add("ronly", "read-only-password", role="readonly")
    _as(basic_client, "ronly", "read-only-password")
    assert basic_client.post("/api/repros", json={"version": "8.5.1"},
                             headers=_auth()).status_code == 403
    out = basic_client.get("/api/audit", headers=_auth()).json()
    denied = [r for r in out["lines"] if r["outcome"] == "denied"]
    assert denied and "needs member" in denied[0]["label"]


def test_handing_over_moves_the_owner_and_keeps_who_made_it(basic_client, tmp_path):
    """Who CREATED it is a fact about the past and stays; who is responsible for
    it today is what a handover changes. Before this, "belongs to alice" kept
    warning bob about data that had been his for a week."""
    from houston.services import users as usersvc
    from houston import runner
    usersvc.add("bob", "bobs-good-password", role="member")
    _workspace("t4471", "alice", tmp_path)
    r = basic_client.post("/api/repros/t4471/owner", json={"to": "bob"}, headers=_auth())
    assert r.status_code == 200 and r.json()["to"] == "bob"
    extra = runner.read_meta("t4471").extra
    assert extra["owner"] == "bob"
    assert extra["created_by"] == "alice", "creation is immutable"
    assert extra["owner_history"][-1]["from"] == "alice"
    assert lc.owner_of("t4471") == "bob"


def test_you_cannot_hand_a_workspace_to_somebody_who_cannot_sign_in(basic_client, tmp_path):
    _workspace("t4471", "alice", tmp_path)
    r = basic_client.post("/api/repros/t4471/owner", json={"to": "ghost"}, headers=_auth())
    assert r.status_code == 404 and "no account" in r.json()["error"]


def test_a_member_cannot_destroy_somebody_elses_workspace(basic_client, tmp_path, monkeypatch):
    """§3.3's guardrail was a confirm dialog, which stops being a guardrail around
    the twentieth time you click through it for your own workspaces."""
    from houston.services import users as usersvc
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    usersvc.add("bob", "bobs-good-password", role="member")
    _workspace("alices-box", "alice", tmp_path)
    _as(basic_client, "bob", "bobs-good-password")
    r = basic_client.delete("/api/repros/alices-box?volumes=true&confirm=true",
                            headers=_auth())
    assert r.status_code == 409
    assert "belongs to alice" in r.json()["error"]


def test_help_on_a_colleagues_workspace_stays_open(basic_client, tmp_path, monkeypatch):
    """Only DESTRUCTION is gated. Covering somebody's ticket is the workflow this
    exists for, so start/stop/logs/seed on their workspace stay allowed."""
    from houston.services import users as usersvc
    # `**kw`: set_state takes an emit now, so the route can carry what the
    # service says -- a Kubernetes start cannot restore the URL and must say so.
    monkeypatch.setattr(lc.state, "set_state", lambda n, a, **kw: None)
    usersvc.add("bob", "bobs-good-password", role="member")
    _workspace("alices-box", "alice", tmp_path)
    _as(basic_client, "bob", "bobs-good-password")
    r = basic_client.post("/api/repros/alices-box/state", json={"action": "restart"},
                          headers=_auth())
    assert r.status_code == 200


def test_a_null_origin_without_sec_fetch_site_is_still_refused(basic_client):
    """An opaque origin -- a sandboxed iframe, a data: URL -- cannot be matched
    against the allow-list, so with no Sec-Fetch-Site to appeal to it counts as
    cross-site."""
    r = basic_client.post("/api/repros/x/state", json={"action": "stop"},
                          headers={"Host": "localhost", "Origin": "null"})
    assert r.status_code == 403


# --- gui.create_policy: whose box is it? -------------------------------------------

def test_a_member_may_set_the_image_and_bind_by_default(basic_client, monkeypatch):
    """A member can already create workspaces and tear them down WITH their data.
    Against that, "you may destroy Maria's customer repro but not choose which
    interface your own listens on" is not a security boundary, it is an inconsistent
    ladder — so the default is open and `gui.create_policy admin` narrows it.
    """
    from houston import config as cfgmod
    from houston.services import users as usersvc
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.create_docker, "create_repro", lambda req, **kw: {"name": "x"})
    usersvc.add("bob", "bobs-good-password", role="member")
    _as(basic_client, "bob", "bobs-good-password")

    for field, value in (("bind", "0.0.0.0"), ("rc_image", "registry/rc:x"),
                         ("reg_token", "an-ee-licence")):
        r = basic_client.post("/api/repros", headers=_auth(),
                              json={"version": "8.5.1", field: value})
        assert r.status_code == 200, f"{field} refused by default: {r.text}"

    # ...and a box that wants the boundary still gets it.
    cfgmod.update_config(lambda c: c.__setitem__(lc.CREATE_POLICY_KEY, "admin"))
    assert basic_client.post("/api/repros", headers=_auth(),
                             json={"version": "8.5.1", "bind": "0.0.0.0"}
                             ).status_code == 400


def test_the_refusal_names_the_setting_that_opens_it(basic_client, monkeypatch):
    """A boundary with no door on the other side is just a wall — the lesson from
    bind_host, which lifecycle read and `config set` would not write."""
    from houston import config as cfgmod
    from houston.cli import _CONFIG_KEYS
    from houston.services import users as usersvc
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    cfgmod.update_config(lambda c: c.__setitem__(lc.CREATE_POLICY_KEY, "admin"))
    usersvc.add("bob", "bobs-good-password", role="member")
    _as(basic_client, "bob", "bobs-good-password")
    r = basic_client.post("/api/repros", headers=_auth(),
                          json={"version": "8.5.1", "bind": "0.0.0.0"})
    assert "gui.create_policy anyone" in r.json()["error"]
    assert "config set bind_host" in r.json()["error"]
    for key in ("gui.create_policy", "gui.destroy_policy", "bind_host"):
        assert key in _CONFIG_KEYS, f"{key} is documented policy with no way to set it"


def test_a_down_engine_is_502_on_the_two_routes_that_check_it(monkeypatch):
    """`POST /pat` and `POST /call` both call `lc.require_docker()`, and every
    existing test of them patches it to a no-op — so the engine-down branch of
    both was never exercised in either direction.

    It answers 502 now (the dependency underneath is not there) rather than 409
    ("poll again"), matching what `/state` has always returned for the same
    condition. Pinned on both routes because the class is shared: changing it back
    silently would move two statuses at once.
    """
    from houston import runner as runner_mod
    monkeypatch.setattr(runner_mod.host, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n, **kw: n)
    c = client()
    for path, body in (("/api/repros/x/pat", {}),
                       ("/api/repros/x/call", {"method": "GET", "path": "/api/info"})):
        r = c.post(path, headers=H, json=body)
        assert r.status_code == 502, f"{path} answered {r.status_code}, expected 502"
        assert r.json()["kind"] == "DockerError"
    # /state already answered 502 for this on main — the point is that all three agree.
    assert errors.DockerError.http_status == 502


def test_a_path_as_a_preset_is_refused_on_the_request_not_inside_the_job(monkeypatch):
    """Found by driving the create route live, after the escape itself was fixed.

    `presets._user_path` refuses a path, so the escape WAS blocked -- the job failed
    with a ValidationError and nothing was created. But the caller got `200
    {"job_id": ...}` and had to open the Activity list to learn the request was wrong on
    arrival, which is the same mistake `check_state_request` and `check_teardown_request`
    exist to prevent. And the first attempt at this preflight returned **500**, because
    `presets` raises plain `ValueError` throughout and the web layer maps `ReproError`
    only -- so the conversion belongs here, where `_create_repro_locked` already does
    the same thing at the service boundary.
    """
    r = client().post("/api/repros", headers=H,
                      json={"version": "8.5.1", "preset": "/tmp/anything",
                            "name": "escapi"})
    assert r.status_code == 400, r.text
    assert "not a preset name" in r.json()["error"], r.text
    assert "job_id" not in r.json(), "a refused create handed back a job to watch"

    for bad in ("../../etc/passwd", "sub/dir", "UPPER"):
        r = client().post("/api/repros", headers=H,
                          json={"version": "8.5.1", "preset": bad, "name": "x"})
        assert r.status_code == 400, (bad, r.status_code, r.text)

    # A REAL preset name still reaches the job, which is the half a blunt fix breaks.
    monkeypatch.setattr(lc.create_docker, "create_repro",
                        lambda req, emit, stream_output=False: {"name": "ok"})
    r = client().post("/api/repros", headers=H,
                      json={"version": "8.5.1", "preset": "ldap", "name": "ok"})
    assert r.status_code == 200 and r.json()["job_id"].startswith("job_"), r.text
