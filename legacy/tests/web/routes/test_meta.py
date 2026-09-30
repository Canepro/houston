"""`houston.web.routes.meta`: its own spec file.

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
    H, _as, _auth, anon_client as anon_client, basic_client as basic_client, client
)

def test_health_needs_no_session():
    r = client(sign_in=False).get("/api/health", headers=H)
    assert r.status_code == 200 and "docker" in r.json()


def test_non_localhost_host_rejected():
    r = client(host="http://evil.example").get("/api/health")
    assert r.status_code == 403


def test_host_guard_is_case_insensitive():
    """Hostnames are case-insensitive; comparing them raw is a fail-CLOSED bug.

    `curl http://LOCALHOST:7070/` and a proxy forwarding `Host: Lab.Example.Com`
    both got "host not allowed", which reads like the guard is broken rather
    than like a spelling difference.
    """
    app = create_app(allow_hosts=["Lab.Example.Com"])
    c = TestClient(app, base_url="http://localhost")
    for hdr in ("LOCALHOST", "LocalHost", "localhost",
                "lab.example.com", "LAB.EXAMPLE.COM", "Lab.Example.Com:443"):
        assert c.get("/api/health", headers={"host": hdr}).status_code == 200, hdr
    # Case folding must not widen the allow-list to unrelated hosts.
    for hdr in ("evil.example", "lab.example.com.evil", "notlocalhost"):
        assert c.get("/api/health", headers={"host": hdr}).status_code == 403, hdr


def test_allow_host_permits_proxy_domain():
    # reverse-proxy access (iximiuz/Codespaces): allow the proxy host, or '*'.
    proxy = "https://x.iximiuz.com"
    assert TestClient(create_app(), base_url=proxy).get("/api/health").status_code == 403
    assert TestClient(create_app(allow_hosts=["x.iximiuz.com"]),
                      base_url=proxy).get("/api/health").status_code == 200
    assert TestClient(create_app(allow_hosts=["*"]),
                      base_url=proxy).get("/api/health").status_code == 200


def test_missing_host_header_rejected():
    # "" used to be a member of the allow-list, so a Host-less request walked
    # straight past the DNS-rebind guard.
    assert client().get("/api/health", headers={"host": ""}).status_code == 403


def test_ipv6_loopback_host_allowed():
    # '[::1]:7070'.split(':')[0] is '[', so a naive port strip 403s the IPv6
    # loopback even though '::1' is in the allow-list. Set the header directly:
    # TestClient's transport can't parse a bracketed IPv6 base_url.
    for hdr in ("[::1]:7070", "[::1]"):
        assert client().get("/api/health", headers={"host": hdr}).status_code == 200


def test_security_headers_are_set():
    csp = client().get("/api/health").headers["content-security-policy"]
    directives = dict((d.strip().split(" ", 1) + [""])[:2]
                      for d in csp.split(";") if d.strip())
    # script-src 'self' with no 'unsafe-inline' means an injected inline handler
    # (`<img onerror=...>`) cannot run even if a renderer forgets to escape.
    assert directives["script-src"].strip() == "'self'"
    # style ATTRIBUTES are used throughout the UI, so styles do need it
    assert "'unsafe-inline'" in directives["style-src"]
    assert directives["object-src"].strip() == "'none'"
    r = client().get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    # No Referer may carry anything off-origin -- `same-origin` sends none at all
    # to another origin, which is the whole of what `no-referrer` bought here. See
    # test_the_referrer_policy_does_not_null_this_pages_own_origin for why it may
    # not be `no-referrer`.
    assert r.headers["referrer-policy"] == "same-origin"


def test_the_guards_own_refusals_carry_the_security_headers():
    """`_answer_with_security_headers` names the headers "that every answer carries",
    and the answers the guard gives itself -- a 401, a Host or cross-site 403, the 303
    to sign-in -- never reached it, so they went out with none of them."""
    c = client(sign_in=False)
    evil = client(host="http://evil.example", sign_in=False)
    for label, r, api in (
        ("401", c.get("/api/settings"), True),
        ("host 403", evil.get("/api/health"), True),
        ("host 403 off /api", evil.get("/"), False),
        ("cross-site 403", c.post("/api/repros", headers={"Origin": "http://evil.example"}), True),
        ("303", c.get("/", follow_redirects=False), False),
    ):
        assert r.status_code in (401, 403, 303), label
        assert "script-src 'self'" in r.headers.get("content-security-policy", ""), label
        assert r.headers.get("x-content-type-options") == "nosniff", label
        assert r.headers.get("referrer-policy") == "same-origin", label
        assert r.headers.get("cache-control") == (None if api else "no-cache"), label


def test_version_preview_endpoint(monkeypatch):
    monkeypatch.setattr(lc.runner.host, "docker_kernel_version", lambda: "6.1.167")
    r = client().get("/api/versions/8.5.1?offline=true", headers=H)
    assert r.status_code == 200
    b = r.json()
    # Lets the create dialog show the pairing before committing to a multi-GB pull.
    assert b["mongo_tag"] == "8.0" and b["mongo_flavor"] == "official"
    assert "warning" not in b                      # kernel 6.1 runs Mongo 8 fine
    assert client().get("/api/versions/nonsense", headers=H).status_code == 400


def test_version_preview_warns_about_the_mongo8_kernel_trap(monkeypatch):
    # SERVER-121912: mongod 8.0 hard-exits on kernel >= 6.19, and the failure reads
    # like a volume/permission problem. Surface it before the pull, not minutes in.
    monkeypatch.setattr(lc.runner.host, "docker_kernel_version", lambda: "6.19.7-200.fc43")
    b = client().get("/api/versions/8.5.1?offline=true", headers=H).json()
    assert "SERVER-121912" in b["warning"]
    # an older RC pairs with an older Mongo, so no warning
    older = client().get("/api/versions/7.10.13?offline=true", headers=H).json()
    assert "warning" not in older and older["mongo_tag"] == "7.0"


def test_doctor_endpoint_returns_the_same_report_the_cli_renders(monkeypatch):
    from houston.services import doctor as doctorsvc
    monkeypatch.setattr(doctorsvc, "run_checks", lambda **_k: {
        "checks": [{"status": "fail", "message": "Docker daemon not running"}],
        "counts": {"ok": 0, "warn": 0, "fail": 1}, "verdict": "fail", "repros": None})
    r = client().get("/api/doctor", headers=H)
    assert r.status_code == 200
    body = r.json()
    # The dashboard needs the verdict to colour its banner, not just the rows.
    assert body["verdict"] == "fail"
    assert body["checks"][0]["status"] == "fail"


def test_the_browser_report_drops_what_the_browser_already_shows(monkeypatch):
    """A row tagged `elsewhere` names a place the GUI shows the same fact
    permanently — the edge chip, the People page, the New workspace form. In the
    browser those made a diagnostic mostly a summary of the window around it.

    The CLI keeps them: a terminal has no chip, no user list and no rail, so
    `houston doctor` is the only place they are ever said. That asymmetry is the
    whole point, so it is asserted from both ends.
    """
    from houston.services import doctor as doctorsvc
    full = {
        "checks": [
            {"status": "ok", "message": "Docker daemon running"},
            {"status": "ok", "message": "3 GUI account(s), admin: lovekesh",
             "elsewhere": "the People page"},
            {"status": "fail", "message": "No admin account"},
        ],
        "counts": {"ok": 2, "warn": 0, "fail": 1}, "verdict": "fail", "repros": None,
    }
    monkeypatch.setattr(doctorsvc, "run_checks", lambda **_k: dict(full))
    msgs = [c["message"] for c in client().get("/api/doctor", headers=H).json()["checks"]]
    assert "3 GUI account(s), admin: lovekesh" not in msgs
    assert "Docker daemon running" in msgs
    # Never a row that reports a PROBLEM, even about the same subject.
    assert "No admin account" in msgs
    # and the counts still describe every check that ran, so the verdict holds
    assert client().get("/api/doctor", headers=H).json()["counts"]["ok"] == 2


def test_doctor_endpoint_needs_a_session():
    assert client(sign_in=False).get("/api/doctor").status_code == 401


def test_static_assets_must_revalidate_so_an_upgrade_is_not_masked():
    """StaticFiles sends ETag/Last-Modified but no Cache-Control.

    With no freshness directive a browser may reuse a cached copy WITHOUT
    revalidating (heuristic freshness, RFC 9111 4.2.2), so after upgrading houston
    the old GUI modules keep running and new UI simply is not there — which looks
    exactly like a missing feature. `no-cache` means "revalidate first", not
    "don't store", so the ETag still answers 304.
    """
    c = client()
    for path in ("/", "/js/boot.js", "/js/main.js", "/app.css"):
        r = c.get(path)
        assert r.status_code == 200, path
        assert r.headers.get("cache-control") == "no-cache", path
        assert r.headers.get("etag"), f"{path} must still carry an ETag for the 304"

    # A matching ETag stays cheap.
    etag = c.get("/js/main.js").headers["etag"]
    r = c.get("/js/main.js", headers={"If-None-Match": etag})
    assert r.status_code == 304 and not r.content

    # API responses are not given a blanket directive here; the SSE stream sets its
    # own, and the rest are dynamic anyway.
    assert c.get("/api/health").headers.get("cache-control") is None


def test_settings_says_whether_an_email_is_remembered_without_leaking_it(monkeypatch,
                                                                        tmp_path):
    """The create dialog's email field is optional only if one is remembered.

    The placeholder used to say "leave blank, it is remembered" -- true for someone
    who ran `houston config set acme.email`, false for everyone else, and the GUI
    has no way to set it. A blank field then produced a job that failed on a value
    the form had called optional.
    """
    from houston import config as cfgmod
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    c = client()
    body = c.get("/api/settings", headers=H).json()
    # The point of this test is the ABSENCE of the address, so assert that rather
    # than the exact shape -- it used to compare the whole dict, which made adding a
    # field to the response a failing test about email leakage.
    assert body["acme_email_remembered"] is False
    # THE ADDRESS, not every "@" in the document. A blanket scan reads a KUBECONFIG
    # CONTEXT as an email: `eksctl` names its contexts
    # `<user>@<cluster>.<region>.eksctl.io`, and those rows are in this payload for the
    # create dialog's cluster picker. Measured — this test failed on a box that simply
    # had an eksctl-created cluster, reporting an email leak that was a cluster name.
    assert not any("@" in str(v) for k, v in body.items() if k != "kube_clusters")
    for row in (body.get("kube_clusters") or []):
        assert "acme" not in str(row).lower() and "email" not in str(row).lower()

    cfgmod.update_config(lambda cfg: cfg.__setitem__("acme_email", "ops@rocket.chat"))
    r = c.get("/api/settings", headers=H)
    assert r.json()["acme_email_remembered"] is True
    assert "ops@rocket.chat" not in r.text, "the address itself must never be returned"


def test_settings_reports_the_boxs_default_bind_host(monkeypatch, tmp_path):
    """The create dialog cannot tell a browser on ANOTHER machine the truth without
    it: with the default 127.0.0.1 the workspace it is about to make will answer on
    the server and nowhere else, which a GUI-only user has no other way to find out.

    An interface, not a credential -- `up` prints it on every create.
    """
    from houston import config as cfgmod
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    c = client()
    assert c.get("/api/settings", headers=H).json()["default_bind_host"] == "127.0.0.1"
    cfgmod.update_config(lambda cfg: cfg.__setitem__("bind_host", "0.0.0.0"))
    assert c.get("/api/settings", headers=H).json()["default_bind_host"] == "0.0.0.0"


def test_settings_needs_a_session():
    assert client(sign_in=False).get("/api/settings").status_code == 401


def test_health_stays_open_for_uptime_checks(basic_client):
    assert basic_client.get("/api/health",
                            headers={"Host": "localhost"}).status_code == 200


def test_health_says_nothing_about_identity(anon_client):
    """It used to carry an `actor` field, which existed only because there was
    nowhere else to ask who was signed in. `GET /api/session` is that place now,
    and an endpoint left open for uptime checks has no business reading
    credentials -- deriving there let an anonymous caller spend scrypt per request
    just by attaching a header."""
    body = anon_client.get("/api/health", headers={"Host": "localhost"}).json()
    assert body["ok"] is True
    assert "actor" not in body


def test_the_app_drains_on_shutdown(monkeypatch):
    """The hook has to be wired to the app, not just exist."""
    drained = []
    app = create_app()
    monkeypatch.setattr(type(app.state.jobs), "drain",
                        lambda self, timeout=25.0: drained.append(True) or [])
    with TestClient(app, base_url="http://localhost") as c:
        c.get("/api/health")
    assert drained == [True], "lifespan shutdown never ran drain()"


# --- the edge, in the GUI (its own endpoint) ------------------------------------

def test_edge_status_is_not_on_the_health_endpoint(basic_client):
    """/api/health is the cheap, unauthenticated one that every tab polls every
    four seconds; the edge status shells out to docker twice."""
    body = basic_client.get("/api/health",
                            headers=_auth("alice", "correct-horse-battery")).json()
    assert "routes" not in body and "edge" not in body


def test_the_host_guard_names_the_host_it_refused(anon_client):
    """"host not allowed (use serve --allow-host)" never said WHICH name to add —
    and the name is right there in the request. Naming it turns the 403 a browser
    shows into a one-step fix instead of a guessing game.

    The value is attacker-supplied, so it is truncated and repr-quoted. This is a
    JSON body served with nosniff, so it cannot become markup.
    """
    r = anon_client.get("/api/health", headers={"Host": "lab.example.com"})
    assert r.status_code == 403
    body = r.json()["error"]
    assert "lab.example.com" in body, body
    assert "--allow-host lab.example.com" in body, "and the exact flag to add"
    # A port on the refused Host must not end up inside the suggested flag.
    r2 = anon_client.get("/api/health", headers={"Host": "lab.example.com:9944"})
    assert "--allow-host lab.example.com`" in r2.json()["error"], r2.json()


def test_the_host_guard_bounds_what_it_echoes_back(anon_client):
    """A 4 KB Host header must not become a 4 KB error body."""
    r = anon_client.get("/api/health", headers={"Host": "a" * 4000})
    assert r.status_code == 403
    assert len(r.json()["error"]) < 400, "the echoed Host was not truncated"


def test_settings_tells_the_dialog_who_may_set_the_privileged_fields(basic_client,
                                                                    monkeypatch):
    """The dialog must ask rather than recompute the rule: two places deciding one
    permission is how it ended up offering fields the API rejects."""
    from houston import config as cfgmod
    from houston.services import users as usersvc
    usersvc.add("bob", "bobs-good-password", role="member")
    _as(basic_client, "bob", "bobs-good-password")
    body = basic_client.get("/api/settings", headers=_auth()).json()
    assert body["may_set_privileged"] is True, "open by default"
    assert body["privileged_fields"] == list(lc.PRIVILEGED_CREATE_FIELDS)

    cfgmod.update_config(lambda c: c.__setitem__(lc.CREATE_POLICY_KEY, "admin"))
    assert basic_client.get("/api/settings",
                            headers=_auth()).json()["may_set_privileged"] is False


def test_settings_publishes_what_each_runtime_costs_and_refuses(monkeypatch, tmp_path):
    """Both are facts the create dialog would otherwise have to hardcode, and both
    have moved: the refusal list has shrunk twice -- `--reg-token` and every preset
    were on it until they were built -- and a card quoting a cost the preflight does
    not use is a card the refusal contradicts.
    """
    from houston.services import lifecycle as lcsvc
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    body = client().get("/api/settings", headers=H).json()
    kube = next(r for r in body["runtimes"] if r["name"] == "kubernetes")
    docker = next(r for r in body["runtimes"] if r["name"] == "docker")

    assert docker["unsupported"] == [], "Compose refuses none of them"
    # `https` LEFT this set when the Kubernetes ingress path landed, and the GUI
    # follows automatically: `app.js` hides exactly the fields this list names, so the
    # HTTPS control appeared in the create dialog with no JS change. That is the
    # property this endpoint exists for -- a copy in JS would still be refusing it.
    assert {u["field"] for u in kube["unsupported"]} == {"fresh"}
    assert all(u["why"] for u in kube["unsupported"]), "a refusal without a reason"

    # The same constants check_capacity spends, per deployment.
    assert docker["cost"]["monolith"]["workspace_mb"] == lcsvc.WORKSPACE_MB
    micro = kube["cost"]["microservices"]
    assert micro["workspace_mb"] > kube["cost"]["monolith"]["workspace_mb"], \
        "microservices is not a monolith with a label"
    assert micro["cluster_mb"] == lcsvc.CLUSTER_MB, "charged once per machine"


def test_a_failing_recovery_does_not_stop_serve_from_serving(monkeypatch):
    """A box that cannot be repaired still has to be able to serve. Anything else
    turns one stuck workspace into an outage of the whole GUI."""
    from houston.services import journal

    def _explode(*a, **k):
        raise RuntimeError("cluster unreachable")

    monkeypatch.setattr(journal, "recover", _explode)
    c = client()
    assert c.get("/api/health", headers=_auth()).status_code == 200
