"""The shared edge: one Traefik holding 443 for the whole box.

Pure-logic only -- no Docker, like the rest of the suite. The container-level
claims (two workspaces behind one edge, hot registration, no published
ports, reaching a host process over the bridge) were verified live against
traefik:v3.4 before this was written; what those runs proved is recorded in
docs/design/team-server.md §11.
"""

from __future__ import annotations

import pytest

from conftest import source_index, source_of
import yaml

from houston import config
from houston.errors import ValidationError
from houston.services import edge as fd

def _ok_compose(*a, **k):
    """A successful `docker compose` run. `edge.up()` returns the CompletedProcess now,
    not its return code, so a failed start can say what docker said."""
    import subprocess
    return subprocess.CompletedProcess(["docker", "compose"], 0, "", "")




@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    return tmp_path


def _doc(**kw):
    return fd.compose_doc(fd.Edge(domain="support.xyz.com",
                                       acme_email="ops@xyz.com", **kw))


# --- staying invisible ----------------------------------------------------------

def test_the_edge_lives_outside_the_repro_directory(_home):
    """§3.1: `list`, `prune`, `down` and the GUI grid all enumerate repros_dir().
    Living outside it is what makes the edge untouchable by them -- no
    guard code, just the directory choice."""
    assert config.repros_dir() not in fd.edge_dir().parents
    assert fd.edge_dir().parent == config.home()


def test_the_project_name_cannot_collide_with_a_repro():
    """`down` on a repro named "edge" must not tear down the box's ingress.

    sanitize() maps everything outside [a-z0-9-] to "-", so no repro name can
    ever produce this project name -- but PROJECT_PREFIX + "edge" would.
    """
    from houston.services.lifecycle import sanitize

    assert "_" in fd.PROJECT
    assert fd.PROJECT != config.PROJECT_PREFIX + "edge"
    assert sanitize("edge_x") != "edge_x", "sanitize strips underscores"


# --- the compose document -------------------------------------------------------

def test_it_watches_a_directory_not_a_file():
    """Registration is "write one file"; a single --providers.file.filename would
    make it "rewrite the shared file", which cannot be done concurrently."""
    cmd = _doc()["services"]["edge"]["command"]
    assert f"--providers.file.directory=/etc/traefik/{fd.DYNAMIC_DIR}" in cmd
    assert "--providers.file.watch=true" in cmd
    assert not any(a.startswith("--providers.file.filename") for a in cmd)


def test_it_does_not_mount_the_docker_socket():
    """The file provider exists precisely so this is not needed."""
    vols = _doc()["services"]["edge"]["volumes"]
    assert not any("docker.sock" in v for v in vols)


def test_acme_storage_is_shared_with_workspaces():
    """§6: existing certificates are reused, so only NEW names cost against the
    50-per-domain-per-week limit. A private store would re-request every name."""
    from houston import tls

    vols = _doc()["services"]["edge"]["volumes"]
    assert any(v.startswith(f"{tls.acme_dir()}:") for v in vols)


def test_the_challenge_flags_come_from_the_workspace_code_path():
    """One implementation, so the two cannot drift on the thing that decides
    whether issuance works at all."""
    from houston import tls

    door = fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com")
    cmd = fd.compose_doc(door)["services"]["edge"]["command"]
    assert all(a in cmd for a in tls.acme_args(door.as_tls_spec()))
    assert "--certificatesresolvers.le.acme.email=ops@xyz.com" in cmd


def test_dns_credentials_are_mounted_only_for_the_dns_challenge():
    assert "env_file" not in _doc()["services"]["edge"]
    assert "env_file" in _doc(acme_challenge="dns")["services"]["edge"]


def test_the_edge_declares_no_network_of_its_own():
    """It joins each workspace's OWN network at runtime. Declaring a shared one
    here is precisely what would put every workspace on the same network and let
    them reach each other.

    Checked on the SERVICE as well as the document: removing only the top-level
    block left the service still naming it, and compose then refused the whole
    project -- "service edge refers to undefined network edge". Caught by running
    it, not by the version of this test that looked only at the top level.
    """
    doc = _doc()
    assert "networks" not in doc
    assert "networks" not in doc["services"]["edge"]


def test_the_edge_project_is_valid_compose(tmp_path, monkeypatch):
    """Parse what compose parses. A document that is structurally fine and still
    an invalid PROJECT is exactly the failure the networks key produced."""
    import subprocess

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    # THE SKIP HAS TO CATCH THE RIGHT FAILURE. This looked for returncode 127, which
    # is what a SHELL reports for "command not found" -- Python's subprocess raises
    # FileNotFoundError instead and never reaches the check. So the guard was dead and
    # the suite needed a docker binary while CLAUDE.md said nothing does. This is the
    # one test here that genuinely needs docker: it asks compose to parse the project,
    # which is the whole point of it.
    try:
        proc = subprocess.run(
            ["docker", "compose", "-f", str(fd.compose_path()), "config", "-q"],
            capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        pytest.skip(f"docker not available: {exc}")
    if proc.returncode == 127:
        pytest.skip("docker not available")
    assert proc.returncode == 0, proc.stderr


def test_it_can_reach_the_gui_which_is_a_host_process():
    """The GUI is uvicorn on the host, not a container, so it is not on the edge
    network and has no name there."""
    svc = _doc()["services"]["edge"]
    assert "host.docker.internal:host-gateway" in svc["extra_hosts"]
    assert "host.docker.internal" in fd.gui_route_yml(
        fd.Edge(domain="d", gui_port=7070))


def test_host_ports_are_overridable_but_container_ports_are_not():
    svc = _doc(http_port=8080, https_port=8443)["services"]["edge"]
    assert svc["ports"] == ["8080:80", "8443:443"]
    assert "--entryPoints.websecure.address=:443" in svc["command"]


def test_the_document_is_valid_yaml():
    from houston import compose

    assert yaml.safe_load(compose.to_yaml(_doc()))["services"]["edge"]


# --- routing --------------------------------------------------------------------

def test_a_workspace_backend_is_not_addressed_by_its_service_name():
    """The bug this exists to prevent: every workspace names its service
    `rocketchat`, Compose registers that as a network alias, and on a SHARED
    network Docker round-robins between them -- measured 3/3 across two
    workspaces. Alice's hostname would intermittently serve Bob's Rocket.Chat.
    """
    route = fd.workspace_route_yml("alice-rc8-5-1", "t1.support.xyz.com")
    assert "http://rocketchat:3000" not in route
    assert "http://houston-alice-rc8-5-1-rocketchat-1:3000" in route


def test_two_workspaces_get_distinct_backends():
    a = fd.workspace_route_yml("alice-rc8-5-1", "a.example.com")
    b = fd.workspace_route_yml("bob-rc8-5-1", "b.example.com")
    assert (fd.backend_container("alice-rc8-5-1", "rocketchat")
            != fd.backend_container("bob-rc8-5-1", "rocketchat"))
    assert a != b


def test_the_router_rule_names_the_host():
    """Traefik derives WHAT certificate to request from the Host() rule. A bare
    PathPrefix made it log "no domain found" and silently serve its default
    certificate -- indistinguishable from a failed issuance."""
    route = fd.workspace_route_yml("w", "t1.support.xyz.com")
    assert 'rule: "Host(`t1.support.xyz.com`)"' in route
    assert "certResolver: le" in route


def test_multi_instance_workspaces_list_every_backend():
    route = fd.workspace_route_yml("w", "h", instances=3)
    for i in (1, 2, 3):
        assert f"http://houston-w-rocketchat-{i}-1:3000" in route
    assert "sticky" in route, "DDP websockets must not be bounced mid-session"


def test_routes_are_valid_yaml():
    doc = yaml.safe_load(fd.workspace_route_yml("w", "h.example.com"))
    assert doc["http"]["routers"]["w"]["service"] == "w"


# --- registration on disk -------------------------------------------------------

def test_register_and_deregister_only_touch_their_own_route():
    fd.register("alice", "a.example.com")
    fd.register("bob", "b.example.com")
    assert fd.registered() == ["alice", "bob"]

    fd.deregister("bob")
    assert fd.registered() == ["alice"]
    assert fd.route_path("alice").is_file(), "a neighbour must survive"


def test_deregistering_an_unknown_workspace_is_not_an_error():
    """Teardown must be idempotent: `down` may run after a failed create that
    never registered anything."""
    fd.deregister("never-existed")


def test_registering_twice_replaces_rather_than_duplicates():
    fd.register("alice", "old.example.com")
    fd.register("alice", "new.example.com")
    assert fd.registered() == ["alice"]
    assert "new.example.com" in fd.route_path("alice").read_text()


def test_the_guis_own_route_is_not_listed_as_a_workspace():
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    fd.register("alice", "a.example.com")
    assert fd.registered() == ["alice"]


# --- the second kind of backend: passthrough -------------------------------------

def test_a_passthrough_route_does_not_decrypt_and_names_no_resolver():
    """The whole point of the Kubernetes shape: the edge forwards raw TCP.

    A Kubernetes workspace's certificate lives in a cluster Secret and its own
    Ingress terminates TLS. If the edge terminated instead, the Ingress `tls:` block,
    the Secret and cert-manager would never run -- and those are precisely where a
    customer's certificate bugs live, which is the class of bug this tool exists to
    reproduce.

    So: a TCP router, matched by SNI, `passthrough: true`, and NO certificate of any
    kind -- naming a resolver would send the edge to Let's Encrypt for a name it does
    not present a certificate for.
    """
    doc = yaml.safe_load(fd.passthrough_route_yml(
        "kws", "kws.houston.localhost", "172.16.0.2:443"))
    router = doc["tcp"]["routers"]["kws"]
    assert router["rule"] == "HostSNI(`kws.houston.localhost`)"
    assert router["tls"] == {"passthrough": True}, router
    assert doc["tcp"]["services"]["kws"]["loadBalancer"]["servers"] == \
        [{"address": "172.16.0.2:443"}]
    assert "http" not in doc, "a passthrough name has no HTTP router at the edge"
    assert "tls" not in doc, "and no certificate declaration"
    body = fd.passthrough_route_yml("kws", "k.example.com", "10.0.0.1:443")
    assert "certResolver" not in body, \
        "the edge must not request a certificate for a name it passes through"


def test_both_kinds_of_route_share_one_entrypoint():
    """One :443 does both jobs, which is what makes Compose and Kubernetes coexist.

    Traefik matches TCP routers by SNI first and falls through to HTTP routers for
    anything unmatched. Measured on this box with one Traefik and two names: the
    terminating name received the edge's own leaf and the passthrough name received
    the cluster's Secret, byte-identical to it. If these two ever named different
    entrypoints that property would be gone and nothing would fail loudly.
    """
    term = yaml.safe_load(fd.workspace_route_yml("compose", "c.example.com"))
    pass_ = yaml.safe_load(fd.passthrough_route_yml("kube", "k.example.com",
                                                   "172.16.0.2:443"))
    assert term["http"]["routers"]["compose"]["entryPoints"] == ["websecure"]
    assert pass_["tcp"]["routers"]["kube"]["entryPoints"] == ["websecure"]


def test_registering_a_passthrough_asks_for_no_certificate():
    """`register` returns "this name needs a certificate of its own", and the caller
    counts that against Let's Encrypt's weekly limit. A passthrough name presents no
    certificate at the edge at all, so counting it would spend budget on nothing."""
    assert fd.register("kws", "kws.example.com",
                       passthrough="172.16.0.2:443") is False
    assert fd.registered() == ["kws"]
    assert not (fd.certs_dir() / "kws.example.com.crt").exists(), \
        "no local certificate is issued for a name the edge does not terminate"


def test_a_passthrough_backend_must_carry_a_port():
    """Traefik loads a TCP router whose server has no port as a router with no
    reachable server: the name answers nothing and the reason appears only in the
    edge's own log. Refused where the value arrives instead."""
    with pytest.raises(ValidationError) as exc:
        fd.passthrough_route_yml("kws", "k.example.com", "172.16.0.2")
    assert "address" in str(exc.value) and "port" in str(exc.value)
    with pytest.raises(ValidationError):
        fd.passthrough_route_yml("kws", "k.example.com", "")


def test_the_two_kinds_of_route_are_told_apart_on_disk():
    """Read from the route FILE, because the caller that needs to know is looking at
    routes rather than at workspaces -- a route outlives its workspace, which is the
    whole reason `deregister` exists."""
    fd.register("compose", "c.example.com")
    fd.register("kube", "k.example.com", passthrough="172.16.0.2:443")
    assert fd.is_passthrough("kube") is True
    assert fd.is_passthrough("compose") is False
    assert fd.is_passthrough("never-registered") is False


def test_restarting_the_edge_does_not_report_a_kubernetes_route_as_broken(monkeypatch):
    """`reattach_all` joins each routed workspace's Docker network, because
    recreating the edge loses runtime attachments while the route files survive.

    A Kubernetes workspace has no Docker network and no compose project, so attaching
    one can only fail -- and reporting that failure would name a perfectly healthy
    workspace as unreachable on every single `edge start`.
    """
    fd.register("compose", "c.example.com")
    fd.register("kube", "k.example.com", passthrough="172.16.0.2:443")
    tried: list[str] = []

    def _attach(name):
        tried.append(name)
        return False                    # as `docker network connect` would, for both

    monkeypatch.setattr(fd, "attach", _attach)
    failed = fd.reattach_all()
    assert tried == ["compose"], "it tried to join a network Kubernetes does not have"
    assert failed == ["compose"], failed


def test_write_materialises_the_project(_home):
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    assert fd.installed()
    assert fd.dynamic_dir().is_dir()
    assert yaml.safe_load(fd.compose_path().read_text())["services"]["edge"]


def test_the_served_domain_is_readable_by_another_process():
    """`up` runs in a different process from the `serve` that set this up, and the
    port-443 error is far more useful when it can name what holds it."""
    assert fd.served_domain() == ""
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    assert fd.served_domain() == "support.xyz.com"


# --- workspaces stop serving TLS themselves -------------------------------------

def _spec(tls_on: bool):
    """A compose.Spec with and without TLS -- they must produce the same document."""
    from houston import compose, presets, tls

    return compose.Spec(
        project_name="houston-alice-rc8-5-1", rc_image="rc", rc_tag="8.5.1",
        mongo_tag="6.0", mongo_flavor="official", mongo_shell="mongosh",
        oplog=True, root_url="http://localhost:3000", host_port=3000,
        reg_token=None, preset=presets.load("default"),
        tls=(tls.TlsSpec(mode=tls.MODE_ACME, host="t1.support.xyz.com", port=443)
             if tls_on else None))


def test_a_workspaces_compose_is_identical_with_and_without_tls():
    """THE property the whole design rests on. Because this document does not
    change, adding or removing a name is a route file appearing or disappearing --
    no container is ever rebuilt to gain or lose HTTPS, which is what made
    migrating twenty workspaces a recreate-everything operation before."""
    from houston import compose

    assert compose.build(_spec(True)) == compose.build(_spec(False))


def test_a_workspace_runs_no_traefik_and_publishes_no_443():
    from houston import compose, tls

    doc = compose.build(_spec(True))
    assert tls.SERVICE not in doc["services"]
    published = [p for s in doc["services"].values() for p in s.get("ports", [])]
    assert not any(str(p).endswith(":443") for p in published)


def test_a_workspace_keeps_its_own_private_network():
    """No shared network anywhere in the document: that is what stops workspaces
    reaching each other, and the edge joins THEM instead."""
    from houston import compose

    doc = compose.build(_spec(True))
    assert "networks" not in doc
    assert "networks" not in doc["services"]["rocketchat"]


# --- what `up --domain` decides -------------------------------------------------

def _resolve(monkeypatch, *, running: bool = True, https: bool = False,
             emitted: list | None = None):
    from houston.services import lifecycle as lc

    monkeypatch.setattr(fd, "running", lambda: running)
    monkeypatch.setattr(fd, "issue_local_cert", lambda host: None)
    req = (lc.CreateReq(version="8.5.1", https=True) if https else
           lc.CreateReq(version="8.5.1", domain="t1.support.xyz.com",
                        acme_email="ops@xyz.com"))
    emit = (lambda ev: emitted.append(ev)) if emitted is not None else lc.null_emit
    return lc._resolve_tls(req, "alice-rc8-5-1", "127.0.0.1", emit=emit)


def test_a_domain_workspace_claims_no_port_at_all(monkeypatch):
    """The entire point. It terminates no TLS, so there is nothing to conflict
    with -- which is what deletes the port-443 arbitration, the `--adopt` flag and
    the second-workspace refusal along with it."""
    spec = _resolve(monkeypatch)
    assert spec.port == 443, "the URL carries no port; the EDGE holds it"
    assert not hasattr(spec, "http_redirect"), "the edge redirects :80 once, for all"


def test_a_workspace_is_never_published_publicly_for_a_challenge(monkeypatch):
    """TLS-ALPN used to force --domain onto 0.0.0.0 so Let's Encrypt could connect.
    Nothing connects to the workspace now -- the edge answers the challenge -- so
    widening the bind on a repro running fixed weak credentials buys nothing."""
    from houston.services import lifecycle as lc

    req = lc.CreateReq(version="8.5.1", domain="t1.support.xyz.com",
                       acme_email="ops@xyz.com")
    monkeypatch.setattr(fd, "running", lambda: True)
    lc._resolve_tls(req, "w", "127.0.0.1")
    assert req.bind_public is False


def test_local_https_takes_the_same_path_as_a_real_domain(monkeypatch):
    """`--https` used to run its own Traefik on an allocated port, so ten of them
    ate ten ports and each got a different URL. Now every name answers on 443."""
    spec = _resolve(monkeypatch, https=True)
    assert spec.port == 443
    assert spec.host.endswith(".houston.localhost")


def test_an_edge_with_no_domain_still_serves_local_names():
    """`up --https` on a box with no domain and no configuration at all. A
    resolver declared without an email makes Traefik fail at startup, so the
    branch is real rather than tidiness."""
    cmd = fd.compose_doc(fd.Edge())["services"]["edge"]["command"]
    assert not any("certificatesresolvers" in a for a in cmd)
    assert "--entryPoints.websecure.address=:443" in cmd


# --- doctor ---------------------------------------------------------------------

def _doctor(monkeypatch, *, running=True, meta=()):
    """run_checks() with the network probes stubbed out."""
    import requests

    from houston import runner
    from houston.services import doctor, lifecycle as lc

    monkeypatch.setattr(runner, "docker_available", lambda **_k: True)
    monkeypatch.setattr(runner, "docker_server_version", lambda: "29.0")
    monkeypatch.setattr(runner, "compose_version", lambda: "5.3.1")
    monkeypatch.setattr(runner, "docker_kernel_version", lambda: "6.1.0")
    monkeypatch.setattr(runner, "hub_logged_in", lambda: True)
    monkeypatch.setattr(runner, "port_free", lambda p, h="": True)
    monkeypatch.setattr(runner, "pick_port", lambda: 3000)
    monkeypatch.setattr(runner, "list_meta", lambda: list(meta))
    monkeypatch.setattr(lc, "list_repros", lambda: [])
    monkeypatch.setattr(requests, "get", lambda *a, **k: (_ for _ in ()).throw(
        requests.RequestException()))
    monkeypatch.setattr(fd, "running", lambda: running)
    return doctor.run_checks()["checks"]


def _msgs(checks, status=None):
    return " | ".join(c["message"] for c in checks
                      if status is None or c["status"] == status)


def test_doctor_says_nothing_about_a_edge_that_was_never_set_up(monkeypatch):
    """Most installs have none; rows about it would be noise."""
    assert "ront door" not in _msgs(_doctor(monkeypatch))


def test_doctor_reports_a_running_edge(monkeypatch):
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    fd.register("alice-rc8-5-1", "t1.support.xyz.com")
    checks = _doctor(monkeypatch)
    assert "support.xyz.com" in _msgs(checks, "ok")
    assert "1 workspace route" in _msgs(checks, "ok")


def test_a_stopped_edge_is_a_failure_not_a_warning(monkeypatch):
    """§8, shared fate: while it is down the GUI and every registered workspace
    are unreachable, and nothing else in the report would say so."""
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    fd.register("alice-rc8-5-1", "t1.support.xyz.com")
    failures = _msgs(_doctor(monkeypatch, running=False), "fail")
    assert "NOT running" in failures and "unreachable" in failures


def test_a_route_whose_workspace_is_gone_is_flagged(monkeypatch):
    """It points the edge at nothing, so that hostname 502s instead of
    404ing and the name cannot be reused."""
    fd.write(fd.Edge(domain="d", acme_email="e"))
    fd.register("deleted-by-hand", "t9.support.xyz.com")
    assert "deleted-by-hand" in _msgs(_doctor(monkeypatch), "warn")


def test_the_edge_check_never_breaks_the_report(monkeypatch):
    """doctor's contract: it must run when the environment is broken."""
    fd.write(fd.Edge(domain="d", acme_email="e"))
    monkeypatch.setattr(fd, "registered", lambda: 1 / 0)
    checks = _doctor(monkeypatch)
    assert checks, "the report must still come back"
    assert "could not be determined" in _msgs(checks, "warn")


# --- adopting a pre-front-door workspace ----------------------------------------
# Reported from a real box: one working `--domain` workspace, and the second was
# refused because the first one's own Traefik held 443. Setting up a edge
# then failed on the same port. Nothing could get out of that state.

def _acme_workspace(name: str, host: str, tmp_path):
    import dataclasses
    import json

    from houston import runner

    doc = ("services:\n"
           "  rocketchat:\n    image: rc\n    ports: ['0.0.0.0:3000:3000']\n"
           "  mongodb:\n    image: mongo\n"
           "  traefik:\n    image: traefik\n    ports: ['443:443', '80:80']\n")
    f = {x.name: "" for x in dataclasses.fields(runner.Metadata)}
    f.update(name=name, project=f"houston-{name}", rc_version="8.5.1",
             mongo_tag="8.0", host_port=3000, preset="email",
             root_url="http://localhost:3000", public_url=f"https://{host}",
             extra={"tls": "acme", "tls_ports": [443], "tls_email": "o@e.com"})
    ws = runner.workspace(name)
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(json.dumps(dataclasses.asdict(runner.Metadata(**f))))
    (ws / "docker-compose.yml").write_text(doc)


def test_a_pre_edge_workspace_is_found(tmp_path):
    _acme_workspace("lovekesh-rc8-5-1-email", "testrepo.kestron.org", tmp_path)
    assert fd.holders_of_443() == ["lovekesh-rc8-5-1-email"]


def test_adopting_drops_the_workspaces_own_traefik(tmp_path, monkeypatch):
    from houston import runner, tls

    _acme_workspace("w", "t1.kestron.org", tmp_path)
    monkeypatch.setattr(fd, "attach", lambda name: True)
    monkeypatch.setattr(fd, "_docker", lambda *a, **k: type("P", (), {"returncode": 0, "stdout": ""})())

    res = fd.adopt("w")
    assert res == {"name": "w", "host": "t1.kestron.org"}
    doc = runner.read_compose("w")
    assert tls.SERVICE not in doc["services"], "its Traefik must go, or 443 stays held"
    # No network edits: the workspace keeps its own, and the EDGE joined it live.
    assert "networks" not in doc


def test_adopting_registers_the_route_and_drops_the_port_claim(tmp_path, monkeypatch):
    from houston import runner

    _acme_workspace("w", "t1.kestron.org", tmp_path)
    monkeypatch.setattr(fd, "attach", lambda name: True)
    monkeypatch.setattr(fd, "_docker", lambda *a, **k: type("P", (), {"returncode": 0, "stdout": ""})())
    fd.adopt("w")

    assert fd.registered() == ["w"]
    assert "t1.kestron.org" in fd.route_path("w").read_text()
    meta = runner.read_meta("w")
    assert meta.extra["edge"] is True
    # It publishes no 443 now; leaving the claim would make every later workspace
    # allocate around a port this one does not hold.
    assert meta.extra["tls_ports"] == []
    assert fd.holders_of_443() == []


def test_adopting_keeps_the_data_volume(tmp_path, monkeypatch):
    """The whole point of transforming the compose file rather than recreating
    from scratch: `down -v` is never involved."""
    from houston import runner

    _acme_workspace("w", "t1.kestron.org", tmp_path)
    monkeypatch.setattr(fd, "attach", lambda name: True)
    calls = []
    monkeypatch.setattr(fd, "_docker", lambda *a, **k: calls.append(a) or
                        type("P", (), {"returncode": 0, "stdout": ""})())
    monkeypatch.setattr(runner, "up", lambda *a, **k: calls.append(("up",)) or 0)
    monkeypatch.setattr(runner, "down", lambda *a, **k: calls.append(("down",)) or 0)
    fd.adopt("w")
    assert ("up",) not in calls, "adopting must not recreate the workspace"
    assert ("down",) not in calls, "nor tear it down"
    assert any("rm" in c for c in calls), "only its traefik container is removed"


def test_a_local_https_workspace_is_not_adoptable(tmp_path, monkeypatch):
    """`--https` uses a local certificate on its own allocated port; it holds no
    443 and has no public name to register."""
    import dataclasses
    import json

    from houston import runner
    from houston.errors import ValidationError

    f = {x.name: "" for x in dataclasses.fields(runner.Metadata)}
    f.update(name="l", project="houston-l", rc_version="8.5.1", mongo_tag="8.0",
             host_port=3000, preset="default", root_url="http://localhost:3000",
             extra={"tls": "local", "tls_ports": [8443]})
    ws = runner.workspace("l")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(json.dumps(dataclasses.asdict(runner.Metadata(**f))))
    (ws / "docker-compose.yml").write_text("services: {}\n")

    assert fd.holders_of_443() == []
    with pytest.raises(ValidationError):
        fd.adopt("l")


# --- the edge is restartable without losing routes ------------------------------

def test_restarting_the_edge_reattaches_every_route(monkeypatch):
    """Attachments are RUNTIME state on the container, so recreating it -- an
    upgrade, a restart, a reboot that pulls a new image -- loses every one while
    the route files survive untouched. The names would then answer 502 rather
    than erroring, which nothing else in the tool would report."""
    fd.write(fd.Edge())
    monkeypatch.setattr(fd, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    for n in ("alice-rc8-5-1", "bob-rc8-5-1"):
        fd.register(n, f"{n}.example.com")

    attached = []
    monkeypatch.setattr(fd, "attach", lambda name: attached.append(name) or True)
    monkeypatch.setattr(fd, "_compose", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    fd.up(pull=False)
    assert sorted(attached) == ["alice-rc8-5-1", "bob-rc8-5-1"]


def test_reattach_reports_what_it_could_not_join():
    fd.write(fd.Edge())
    assert fd.reattach_all() == [], "nothing registered, nothing to fail"


def test_a_failed_start_names_what_holds_the_port(monkeypatch):
    """"The edge did not start" sends you looking at the edge, when the cause is
    almost always something ELSE on :443 -- hit twice while building this."""
    monkeypatch.setattr(fd, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0,
                  "stdout": "some-other-traefik\t0.0.0.0:443->443/tcp\n"})())
    assert "some-other-traefik" in fd.port_holder(443)


def test_an_edge_holding_no_ports_is_not_running(tmp_path, monkeypatch):
    """Up is not the same as serving, and Docker will happily run a container whose
    port bindings could not be established because something else owns them.

    That is a Traefik answering on nothing -- it cannot serve one name -- and it was
    reported as a working edge: `edge status` said "State running" while every https
    name on the box was dead. Nothing else in the tool contradicts this component, so
    a false green here is the whole answer a person gets. Pre-fix `running()` is True;
    False is the finding.
    """
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def fake(*a, **k):
        argv = " ".join(str(x) for x in a)
        if argv.startswith("ps"):
            out = "c0ffee\n"
        elif "working_dir" in argv:
            out = str(fd.edge_dir())
        elif "NetworkSettings.Ports" in argv:
            out = '{"443/tcp": null, "80/tcp": null}'      # up, holding nothing
        else:
            out = ""
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd, "_docker", fake)
    # The behavioural claim FIRST, so this fails on the behaviour against the pre-fix
    # code rather than on a helper that did not exist yet.
    assert fd.running() is False, "up but holding nothing is not running"
    assert fd.our_container() == "c0ffee", "...though the container really is up"


def test_an_edge_actually_holding_its_ports_is_running(tmp_path, monkeypatch):
    """The other half: the strictness must not break the normal case."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def fake(*a, **k):
        argv = " ".join(str(x) for x in a)
        if argv.startswith("ps"):
            out = "c0ffee\n"
        elif "working_dir" in argv:
            out = str(fd.edge_dir())
        elif "NetworkSettings.Ports" in argv:
            out = ('{"443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "443"}],'
                   ' "80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "80"}]}')
        else:
            out = ""
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd, "_docker", fake)
    assert fd.running() is True


def test_the_port_holder_names_the_project_that_can_free_it(monkeypatch):
    """`docker compose -p <project> down` is the command, so the PROJECT is the
    actionable half.

    Naming only the container sent somebody at our own project -- the one `-p` value
    that cannot possibly free the port -- which is exactly what happened when a
    pre-rename edge outlived the rename.
    """
    def fake(*a, **k):
        argv = " ".join(str(x) for x in a)
        if argv.startswith("ps"):
            out = "rcrepro_edge-edge-1\t0.0.0.0:443->443/tcp\n"
        elif "com.docker.compose.project" in argv:
            out = "rcrepro_edge"
        else:
            out = ""
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd, "_docker", fake)
    said = fd.port_holder(443)
    assert "rcrepro_edge-edge-1" in said
    assert "rcrepro_edge'" in said, f"the project has to be named too: {said}"


def test_a_bare_edge_writes_no_gui_route(tmp_path, monkeypatch):
    """`up --https` on a box with no public name starts a bare edge. Writing the
    GUI route anyway produced Host(``), which Traefik rejects at load -- "empty
    args for matcher Host" -- plus a certResolver a bare edge never declares. Two
    errors on every start, for a route that cannot work."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge())
    assert not fd.route_path("_gui").exists()
    assert fd.registered() == []


def test_giving_the_edge_a_domain_later_adds_the_gui_route(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge())
    fd.write(fd.Edge(domain="gui.example.com", acme_email="o@e.com"))
    assert 'Host(`gui.example.com`)' in fd.route_path("_gui").read_text()


def test_resolving_tls_never_starts_a_container(tmp_path, monkeypatch):
    """A resolve function that starts docker made the TEST SUITE stand up a real
    edge holding :443, which then broke a live run on the same box. Docker work
    belongs in the create path."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.services import lifecycle as lc

    def boom(*a, **k):
        raise AssertionError("_resolve_tls started a container")

    monkeypatch.setattr(fd, "ensure_running", boom)
    monkeypatch.setattr(fd, "up", boom)
    req = lc.CreateReq(version="8.5.1", domain="t1.example.com", acme_email="o@e.com")
    lc._resolve_tls(req, "w", "127.0.0.1")


def test_the_recorded_spec_survives_a_round_trip(tmp_path, monkeypatch):
    """`current()` reconstructed only the domain and the wildcard flag -- it dropped the
    email, the GUI host and the GUI port. So nothing but `serve --domain` could rebuild
    this edge, and `houston edge start` therefore could not apply a changed
    `acme.challenge`: regenerating the compose file would have pointed the front door at
    a GUI it no longer knew the address of.

    Measured consequence: `config set acme.challenge http` followed by `edge restart`
    kept validating over TLS-ALPN against the production CA, and the log went on
    reporting the identical failure."""
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge.resolve("gui.example.test", "who@example.test",
                             gui_host="172.17.0.1", gui_port=9944))
    back = fd.current()
    assert back is not None
    assert back.domain == "gui.example.test"
    assert back.acme_email == "who@example.test", "the email was the first thing lost"
    assert back.gui_host == "172.17.0.1", "and the GUI host the most damaging"
    assert back.gui_port == 9944

    # An edge written by a version that recorded no spec still reads back, at the old
    # fidelity, rather than failing a start.
    (fd.edge_dir() / fd.SPEC_FILE).unlink()
    legacy = fd.current()
    assert legacy is not None and legacy.domain == "gui.example.test"

    # Garbage does not fail a start either.
    (fd.edge_dir() / fd.SPEC_FILE).write_text("{not json")
    assert fd.current() is not None


def test_http_01_is_selectable_and_frees_the_challenge_path(tmp_path, monkeypatch):
    """houston offered exactly two challenges, derived and never asked for: dns-01 when
    credentials exist, TLS-ALPN otherwise. A real box had NEITHER available -- TLS-ALPN
    validation failed on every attempt with `remote error: tls: unrecognized name`, and
    dns-01 was impossible because the operator had the machine and not the DNS zone. With
    only host access and :80 open, http-01 was the one remaining option and there was no
    way to select it.

    Selecting it must also turn the :80 redirect OFF. An entryPoint redirection is a
    middleware on the entrypoint applied to every router on it -- measured: an explicit
    router for `/.well-known/acme-challenge/` on `web` still answered 301 -- so leaving
    it on would redirect Let's Encrypt away from the challenge it came to fetch."""
    from houston import config as cfgmod
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    cfgmod.save_config({"acme_challenge": "http"})
    door = fd.Edge.resolve("gui.example.test", "a@b.test")
    assert door.acme_challenge == "http"
    args = fd.compose_doc(door)["services"]["edge"]["command"]
    assert "--certificatesresolvers.le.acme.httpchallenge=true" in args, args
    assert "--certificatesresolvers.le.acme.httpchallenge.entrypoint=web" in args, args
    assert not any("tlschallenge" in a for a in args), args
    # THE POINT: :80 must stay available for the challenge.
    assert not any("redirections" in a for a in args), args

    # The default is unchanged -- TLS-ALPN with the redirect, exactly as before.
    cfgmod.save_config({})
    plain = fd.Edge.resolve("gui.example.test", "a@b.test")
    assert plain.acme_challenge == "tlsalpn"
    pargs = fd.compose_doc(plain)["services"]["edge"]["command"]
    assert any("tlschallenge" in a for a in pargs), pargs
    assert sum("redirections" in a for a in pargs) == 3, pargs

    # A value nobody recognises falls back to the derivation rather than being passed
    # through to Traefik, where it would be a startup failure.
    cfgmod.save_config({"acme_challenge": "banana"})
    assert fd.Edge.resolve("g.example.test", "a@b.test").acme_challenge == "tlsalpn"


def test_the_staging_switch_actually_reaches_the_edge(tmp_path, monkeypatch):
    """`acme.staging` existed everywhere except where it mattered. The field was on the
    spec, `tls.py` built the staging CA URL from it, `config set acme.staging true`
    mapped to it, and staging even had its own storage file so switching could never mix
    a staging certificate into the production store -- and nothing wired it to the EDGE.
    `serve --domain` called `Edge.resolve` without it, so the switch was unreachable for
    the one component that requests certificates.

    It matters on a rate-limited box: Let's Encrypt allows five FAILED authorizations per
    name per hour, a support server has a name per ticket, and every restart abandons an
    in-flight challenge -- so a handful of restarts spends the hour's budget and staging
    is the only safe way left to test the plumbing."""
    from houston import config as cfgmod
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    cfgmod.save_config({"acme_staging": True})
    door = fd.Edge.resolve("gui.example.test", "a@b.test")
    assert door.acme_staging is True

    args = fd.compose_doc(door)["services"]["edge"]["command"]
    assert any("acme-staging-v02.api.letsencrypt.org" in a for a in args), args
    # A SEPARATE store, so flipping back to production cannot serve a staging cert.
    assert any("acme-staging.json" in a for a in args), args

    # And production stays production when the switch is off.
    cfgmod.save_config({})
    prod = fd.Edge.resolve("gui.example.test", "a@b.test")
    assert prod.acme_staging is False
    prod_args = fd.compose_doc(prod)["services"]["edge"]["command"]
    assert not any("acme-staging" in a for a in prod_args), prod_args

    # An explicit value still wins over the config, for a caller that knows.
    forced = fd.Edge.resolve("gui.example.test", "a@b.test", acme_staging=True)
    assert forced.acme_staging is True


def test_a_running_edge_still_gets_a_changed_config_applied(tmp_path, monkeypatch):
    """`ensure_running` returned True the moment the edge was RUNNING -- and the caller
    had already rewritten the compose file, because `serve --domain X --email Y` calls
    `write(door)` first. So a changed resolver email, a changed domain or any new flag
    was written to disk and never applied: the container kept the command line it was
    created with, `serve` reported success, and nothing said the two disagreed.

    Found on a box whose `acme.json` held an ACME account for a mistyped address while
    the corrected one was being passed on every restart."""
    import subprocess
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(fd, "installed", lambda: True)
    monkeypatch.setattr(fd, "has_acme", lambda: True)
    monkeypatch.setattr(fd, "served_domain", lambda: "gui.example.test")
    monkeypatch.setattr(fd, "running", lambda: True)
    monkeypatch.setattr(fd, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd, "reattach_all", lambda: [])
    seen = []

    def fake(*args, **kw):
        seen.append(list(args))
        return subprocess.CompletedProcess(list(args), 0, "", "")

    monkeypatch.setattr(fd, "_compose", fake)
    assert fd.ensure_running(acme_email="a@b.test")
    # compose is asked to reconcile: it recreates only if the config changed, which is
    # exactly the decision we want it to make rather than assuming nothing has.
    assert any("up" in a for a in seen), seen

    # And a compose that cannot reconcile is a failure with a reason, not a silent yes.
    monkeypatch.setattr(fd, "_compose", lambda *a, **k: subprocess.CompletedProcess(
        list(a), 1, "", "Error response from daemon: port is already allocated"))
    bad = fd.ensure_running(acme_email="a@b.test")
    assert not bad and "already allocated" in bad.why, bad


def test_the_edge_logs_at_info_so_acme_is_visible(tmp_path, monkeypatch):
    """Traefik's default log level is ERROR, and houston set none -- so a Traefik that
    is healthy but has NOT yet obtained a certificate logged nothing at all. That is
    exactly the state people get stuck in: the name serves Traefik's own default
    certificate, `docker logs` comes back empty, and an empty log reads as "nothing is
    wrong" when it means "nothing has failed YET".

    Measured on two boxes on the same day. The one with a real DNS failure had nine ERR
    lines and no INF lines; the one mid-issuance had an empty log and a default
    certificate. Diagnosis needs the second one to talk."""
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    args = fd.compose_doc(fd.Edge.resolve("g.example.test", "a@b.test"))["services"]["edge"]["command"]
    assert "--log.level=INFO" in args, args
    # Before the file provider, so a provider that cannot start says so.
    assert args.index("--log.level=INFO") < next(
        i for i, a in enumerate(args) if "providers.file" in a), args
    # A bare edge -- no domain, no ACME -- gets it too: `up --https` fails the same way.
    bare = fd.compose_doc(fd.Edge())["services"]["edge"]["command"]
    assert "--log.level=INFO" in bare, bare


def test_a_failed_start_says_what_docker_said(tmp_path, monkeypatch):
    """"error: the edge did not start." was the whole message, on a fresh EC2 box where
    `docker ps -a` was empty -- no container to inspect, no port holder to name, and the
    compose error captured with `capture_output=True` and dropped one frame below.
    `up()` returned only a return code, so both failure sites could do nothing but guess.
    """
    import subprocess
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(fd, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd, "running", lambda: False)
    monkeypatch.setattr(fd, "holders_of_443", lambda: [])
    monkeypatch.setattr(fd, "installed", lambda: True)
    monkeypatch.setattr(fd, "has_acme", lambda: True)
    monkeypatch.setattr(fd, "served_domain", lambda: "gui.example.test")
    monkeypatch.setattr(fd, "reattach_all", lambda: [])
    monkeypatch.setattr(fd, "_compose", lambda *a, **k: subprocess.CompletedProcess(
        list(a), 1,
        stdout="",
        stderr='time="..." level=warning msg="a warning nobody needs"\n'
               "Error response from daemon: failed to pull traefik:v3.1: "
               "no space left on device\n"))

    res = fd.ensure_running(acme_email="a@b.test")
    assert not res, "a failed compose must not read as a start"
    assert res.ok is False
    # The LAST error line, not the first warning: compose puts diagnostics first.
    assert "no space left on device" in res.why, res.why
    assert "a warning nobody needs" not in res.why, res.why

    # And success still reads as success at every existing call site.
    monkeypatch.setattr(fd, "_compose", lambda *a, **k: subprocess.CompletedProcess(
        list(a), 0, stdout="", stderr=""))
    good = fd.ensure_running(acme_email="a@b.test")
    assert good and good.ok and good.why == ""


def test_a_certificate_that_cannot_be_written_is_refused_not_declared(tmp_path, monkeypatch):
    """Docker creates a missing bind-mount target as ROOT, so on a box where the edge
    started before any local certificate was issued, `edge/certs` is root-owned while
    `edge/dynamic` is not. The declaration then landed and the certificate did not, and
    Traefik retried the pair for ever -- "failed to find any PEM data in certificate
    input", once a second, serving nothing for that name. Two such orphans were found on
    a live box."""
    import os
    from houston import errors
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.certs_dir().mkdir(parents=True, exist_ok=True)
    fd.dynamic_dir().mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(os, "access", lambda p, mode: False)

    try:
        fd.issue_local_cert("w.houston.localhost")
    except errors.ReproError as exc:
        assert "not writable" in str(exc), exc
        assert "chown" in str(exc), "give the fix, not just the fault"
    else:
        raise AssertionError("declared a name whose certificate could not be written")

    # And nothing was declared, so there is no permanent error loop to explain.
    assert not list(fd.dynamic_dir().glob("_cert-*.yml"))


def test_orphaned_declarations_are_reportable(tmp_path, monkeypatch):
    """The state above, once it exists: a declaration with no certificate. Silent apart
    from a log nobody was pointed at, so `edge status` has to be able to see it."""
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.certs_dir().mkdir(parents=True, exist_ok=True)
    fd.dynamic_dir().mkdir(parents=True, exist_ok=True)
    (fd.dynamic_dir() / "_cert-a.localhost.yml").write_text("tls: {}\n")
    (fd.dynamic_dir() / "_cert-b.localhost.yml").write_text("tls: {}\n")
    (fd.certs_dir() / "b.localhost.crt").write_text("-----BEGIN CERTIFICATE-----\n")
    (fd.certs_dir() / "a.localhost.crt").write_text("")        # empty is as bad as absent

    assert fd.orphan_certs() == ["a.localhost"]


def test_ensure_running_writes_a_bare_config_when_there_is_none(tmp_path, monkeypatch):
    """The lazy start itself: `up --https` on a box with no configuration at all
    has to produce a working edge. (That it is CALLED from the create path, and
    not from _resolve_tls, is pinned by test_resolving_tls_never_starts_a_container
    above; the container-level start is verified live, not here.)"""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(fd, "running", lambda: False)
    monkeypatch.setattr(fd, "up", lambda pull=True: _ok_compose())
    assert fd.ensure_running()
    assert fd.installed(), "a bare edge config must have been written"
    assert not fd.route_path("_gui").exists(), "and no broken GUI route with it"


# --- adopting is automatic now ---------------------------------------------------

def test_a_legacy_workspace_is_moved_across_without_being_asked(tmp_path, monkeypatch):
    """`--adopt` existed when moving a workspace meant recreating every container:
    asking permission for something expensive is very different from asking to
    remove one proxy container. It is instant and touches no data now, so it
    happens by itself -- and it MUST, because the legacy Traefik holding :443 is
    the reason the edge cannot start at all."""
    _acme_workspace("legacy", "t1.example.com", tmp_path)
    monkeypatch.setattr(fd, "running", lambda: False)
    monkeypatch.setattr(fd, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    started = []
    monkeypatch.setattr(fd, "up", lambda pull=True: started.append(True) or _ok_compose())

    assert fd.ensure_running()
    assert fd.registered() == ["legacy"], "its route must exist after the move"
    assert started == [True]


def test_one_workspace_that_will_not_move_does_not_block_the_others(tmp_path, monkeypatch):
    """Nor the edge: whatever still holds the port is named by port_holder()."""
    _acme_workspace("good", "t1.example.com", tmp_path)
    _acme_workspace("bad", "t2.example.com", tmp_path)
    monkeypatch.setattr(fd, "running", lambda: False)
    monkeypatch.setattr(fd, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    monkeypatch.setattr(fd, "up", lambda pull=True: _ok_compose())

    real = fd.adopt

    def flaky(name):
        if name == "bad":
            raise ValidationError("nope")
        return real(name)

    monkeypatch.setattr(fd, "adopt", flaky)
    assert fd.ensure_running()
    assert fd.registered() == ["good"]


# --- a workspace keeps its name across down/up -----------------------------------

def test_reusing_a_workspace_restores_its_https_name(tmp_path, monkeypatch):
    """`down` then `up` is the documented way to bring a workspace back with its
    data. It printed "URL https://…" from the record while the name served
    NOTHING: teardown removed the route and the reuse path never resolved TLS, so
    nothing rewrote it. Found by running the round trip, not by any test."""
    from houston import runner
    from houston.services import lifecycle as lc

    _acme_workspace("w", "t1.example.com", tmp_path)
    fd.write(fd.Edge())
    monkeypatch.setattr(fd, "running", lambda: True)
    monkeypatch.setattr(fd, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    assert fd.registered() == [], "the teardown removed it"

    lc._restore_route(runner.read_meta("w"))
    assert fd.registered() == ["w"]
    assert "t1.example.com" in fd.route_path("w").read_text()


def test_restoring_a_name_never_fails_the_workspace(tmp_path, monkeypatch):
    """The workspace is up and usable either way; failing a reuse over the
    ingress would be the wrong trade."""
    from houston import runner
    from houston.services import lifecycle as lc

    _acme_workspace("w", "t1.example.com", tmp_path)
    monkeypatch.setattr(fd, "running", lambda: True)
    monkeypatch.setattr(fd, "register", lambda *a, **k: (_ for _ in ()).throw(
        OSError("disk full")))
    lc._restore_route(runner.read_meta("w"))          # must not raise


def test_a_workspace_with_no_name_restores_nothing(tmp_path, monkeypatch):
    from houston import runner
    from houston.services import lifecycle as lc

    _acme_workspace("w", "t1.example.com", tmp_path)
    meta = runner.read_meta("w")
    meta.public_url = ""
    called = []
    monkeypatch.setattr(fd, "register", lambda *a, **k: called.append(True))
    lc._restore_route(meta)
    assert called == []


def test_a_local_certificate_can_be_issued_before_any_edge_exists(tmp_path, monkeypatch):
    """The first `up --https` on a fresh box: nothing has created the watched
    directory yet, and atomic_write puts its temp file beside the target -- so a
    missing parent was a FileNotFoundError and `up --https` crashed outright.
    Found by running it, in an audit, not by any test."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert not fd.dynamic_dir().exists(), "precondition: no edge yet"

    fd.issue_local_cert("w.houston.localhost")
    assert (fd.certs_dir() / "w.houston.localhost.crt").is_file()
    decl = fd.dynamic_dir() / "_cert-w.houston.localhost.yml"
    assert decl.is_file() and "certFile:" in decl.read_text()


def test_the_edge_attaches_after_the_workspace_is_up_not_before(tmp_path, monkeypatch):
    """Attaching needs the network `docker compose up` has only just created.
    Registering during the build wrote a correct route to a backend the edge
    could not resolve, so the name answered 502 -- and a 502 is not an error
    anyone sees, it just looks like a broken workspace."""

    from houston.services import lifecycle as lc

    src = source_of(lc._create_repro_locked)
    up_at = source_index(src, "rc = _up(repro_name")
    attach_at = source_index(src, "edgesvc.attach(repro_name)")
    assert attach_at > up_at, "attach must come after the workspace is up"


def test_the_edge_mounts_the_local_certificate_directory():
    """issue_local_cert() writes a declaration pointing at /etc/traefik/certs.
    Without the mount that path does not exist inside the container and Traefik
    quietly serves its OWN default certificate -- which looks exactly like a
    working setup until you read the issuer."""
    vols = _doc()["services"]["edge"]["volumes"]
    assert any(v.startswith("./certs:") for v in vols), vols


def test_writing_the_edge_creates_the_certs_directory(tmp_path, monkeypatch):
    """Before compose mounts it: a bind-mount source that does not exist is
    created by Docker as root, and houston then cannot write certificates in."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge())
    assert fd.certs_dir().is_dir()


def test_tls_status_survives_a_workspace_with_no_port_of_its_own(tmp_path, monkeypatch):
    """Adoption clears tls_ports, and `[0]` on the empty list was an IndexError --
    a traceback from `tls-status` on exactly the workspaces the edge serves."""
    from houston import cli, runner
    from typer.testing import CliRunner

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("w", "t1.example.com", tmp_path)
    meta = runner.read_meta("w")
    meta.extra["tls_ports"] = []
    runner.write("w", "services: {}\n", meta)
    monkeypatch.setattr(runner, "docker_available", lambda **k: True)
    r = CliRunner().invoke(cli.app, ["tls-status", "--name", "w"])
    assert "IndexError" not in (r.output or ""), r.output
    assert not isinstance(r.exception, IndexError)


def test_a_certificate_with_no_subject_still_says_what_it_is_for():
    """cert-manager issues with NO subject at all -- the name is in the SANs only.

    So every Kubernetes workspace's certificate reported `Subject: ?`, which reads as
    a failure to parse rather than as a perfectly good certificate. `tls_local.py`
    already says why the SANs are the field that matters: browsers have ignored
    commonName since Chrome 58, so a certificate with only a CN is rejected outright.
    """
    from houston import tls as tlsmod
    from houston import tls_local

    crt, _ = tls_local.issue_leaf("probe.houston.localhost")
    assert "probe.houston.localhost" in tlsmod.cert_names(crt)
    assert "localhost" in tlsmod.cert_names(crt), "the leaf carries both"
    # Anything unparseable is an empty list, never an exception: this feeds a report.
    assert tlsmod.cert_names("not a certificate") == []


def test_tls_status_reports_the_names_when_there_is_no_subject(tmp_path, monkeypatch):
    """The row a reader checks to confirm the certificate is for the right name."""
    from typer.testing import CliRunner

    from houston import cli, runner
    from houston import tls as tlsmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("w", "t1.example.com", tmp_path)
    monkeypatch.setattr(runner, "docker_available", lambda **k: True)
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **k: {
        "serving": True, "fallback": False, "issuer": "CN = houston local CA",
        "subject": "", "dates": "notAfter=Nov 23 2026", "names": ["t1.example.com"],
        "trusted": True, "trusted_via_ca": True, "error": ""})
    r = CliRunner().invoke(cli.app, ["tls-status", "--name", "w"])
    assert "t1.example.com" in (r.output or ""), r.output
    assert "Subject" not in (r.output or ""), \
        "the row is what the certificate is VALID FOR, which a subject may not carry"


def test_tls_troubleshooting_on_kubernetes_does_not_send_you_to_the_edge(tmp_path,
                                                                        monkeypatch):
    """A Kubernetes workspace's certificate is not the edge's, and every line of this
    advice named Traefik and `houston logs` -- which on that runtime shows
    Rocket.Chat, not a proxy. The tlsalpn/Cloudflare branch is about a challenge
    cert-manager does not implement at all.

    Sending someone to `edge logs` for a certificate the edge never saw is the entire
    reason this branch exists.
    """
    from houston import cli, runner
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("kws", "k1.example.com", tmp_path)
    _acme_workspace("w", "t1.example.com", tmp_path)      # the Compose control
    meta = runner.read_meta("kws")
    topology.stamp(meta.extra, topology.KUBERNETES)
    meta.extra["namespace"] = "houston-kws"
    runner.write("kws", "", meta)

    said: list[str] = []
    monkeypatch.setattr(cli.ui, "hint", lambda m, *a, **k: said.append(m))
    cli._tls_troubleshoot(runner.read_meta("kws"), "acme", "k1.example.com", 443)
    joined = "\n".join(said)
    assert "describe certificate kws-tls" in joined, joined
    assert "clusterissuer" in joined, joined
    assert "order,challenge" in joined, "an ACME order is where a public name fails"
    assert "tlsalpn" not in joined, "cert-manager does not implement it"
    assert "grep -i traefik" not in joined, "the edge's log has nothing about this name"

    # And the Compose advice is untouched, which is what the Compose suite guards.
    said.clear()
    cli._tls_troubleshoot(runner.read_meta("w"), "acme", "t1.example.com", 443)
    assert "tlsalpn" in "\n".join(said), "still the right advice on Compose"


def test_verifying_tls_never_raises_when_the_ca_file_is_absent(tmp_path):
    """It is a REPORT, and it crashed its caller.

    `create_default_context(cafile=...)` raises FileNotFoundError for a CA that is not
    there -- an OSError, but raised one line above the handler that catches OSError. So
    a box that has only ever used `--domain` (and therefore never minted a local
    certificate, so `ca/ca.crt` does not exist) got a traceback out of the function
    whose entire job is to say what is being served.

    Found live, after the workspace had been built and its certificate issued: `up`
    ended in a Python traceback about a missing file.
    """
    from houston import tls as tlsmod

    import socket
    import ssl
    import threading

    from houston import tls_local

    # A REAL TLS server, because the bug is only reachable once the handshake has
    # succeeded: `verify` returns early when nothing answers, so pointing it at a dead
    # port exercises none of this and would pass whether the fix were there or not.
    crt, key = tls_local.issue_leaf("localhost")
    cert_f, key_f = tmp_path / "s.crt", tmp_path / "s.key"
    cert_f.write_text(crt)
    key_f.write_text(key)
    srv_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    srv_ctx.load_cert_chain(str(cert_f), str(key_f))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    port = sock.getsockname()[1]
    stop = threading.Event()

    def serve():
        sock.settimeout(0.5)
        while not stop.is_set():
            try:
                conn, _ = sock.accept()
            except (OSError, TimeoutError):
                continue
            try:
                with srv_ctx.wrap_socket(conn, server_side=True):
                    pass
            except (OSError, ssl.SSLError):
                pass

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    try:
        missing = str(tmp_path / "nope" / "ca.crt")
        r = tlsmod.verify("127.0.0.1", port, timeout=3.0, cafile=missing)
        assert r["serving"] is True, r          # the handshake really happened
        assert r["trusted_via_ca"] is False     # and the absent CA is an answer
    finally:
        stop.set()
        sock.close()
        t.join(timeout=3)


def test_the_kubernetes_proof_checks_the_right_trust_store(monkeypatch, tmp_path):
    """A Let's Encrypt certificate is checked against the SYSTEM store -- that is the
    whole claim being made about it -- and houston's own CA is not involved and may
    not exist. `cli.tls_status` already makes this distinction; the create path did
    not, and passed a CA file unconditionally."""
    from houston import tls as tlsmod
    from houston.services import edge as edgesvc
    from houston.services import k8s
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(edgesvc, "installed", lambda: True)
    seen: list = []
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **kw: seen.append(kw.get("cafile"))
                        or {"serving": True, "fallback": False, "issuer": "CN = x"})
    ep = k8s.IngressEndpoint("10.0.0.1", 443, "nodeport", "kube-system/traefik", False)

    def ktls(mode):
        return lc._KubeTls(host="a.example.com", ingress_class="traefik", endpoint=ep,
                           issuer=k8s.IssuerSpec(mode=mode, acme_email="a@b.c"),
                           cluster_owns_443=True)

    lc._publish_kubernetes_name("w", ktls("acme"), sleep=lambda s: None)
    assert seen[-1] is None, "a public certificate is a system-store question"
    lc._publish_kubernetes_name("w", ktls("local"), sleep=lambda s: None)
    assert seen[-1] and seen[-1].endswith("ca.crt"), seen


def test_the_staging_switch_can_be_turned_back_off(tmp_path, monkeypatch):
    """`bool("false")` is True, and that made the switch one-way.

    `config set` stored the raw string and every reader did
    `bool(cfg.get("acme_staging"))`, so turning staging ON worked and turning it OFF
    did nothing whatsoever. The asymmetry is what hid it for so long: the value people
    set first is the one that behaves.

    Measured on a live box -- `acme_staging: 'false'` in config.yaml and the very next
    create still ordering from the Let's Encrypt STAGING directory, producing a
    certificate no browser trusts, with nothing anywhere explaining why. A workspace
    that had rehearsed against staging could never be promoted to a real certificate.

    Both sides are asserted: what `config set` writes, and what a reader does with a
    config an OLDER houston already wrote as a string.
    """
    from typer.testing import CliRunner

    from houston import cli, config as cfgmod
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    run = CliRunner()

    assert run.invoke(cli.app, ["config", "set", "acme.staging", "true"]).exit_code == 0
    assert cfgmod.load_config()["acme_staging"] is True, "stored as a real boolean"
    assert run.invoke(cli.app, ["config", "set", "acme.staging", "false"]).exit_code == 0
    assert cfgmod.load_config()["acme_staging"] is False, "and it can be turned off"

    # A config written by an OLDER houston holds the string. Every box that ever ran
    # `config set acme.staging false` has one, so the read has to cope.
    cfgmod.save_config({"acme_staging": "false"})
    assert cfgmod.truthy(cfgmod.load_config().get("acme_staging")) is False
    door = fd.Edge.resolve("d.example.com", "o@e.com")
    assert door.acme_staging is False, "the edge must not stay on staging for ever"

    # And nonsense is refused rather than stored as something truthy.
    bad = run.invoke(cli.app, ["config", "set", "acme.staging", "maybe"])
    assert bad.exit_code != 0
    assert "true or false" in (bad.output or ""), bad.output


def test_two_workspaces_cannot_claim_the_same_hostname():
    """Ports have been guarded since long before names were, and names needed it more.

    A route file is keyed by WORKSPACE NAME, so two workspaces given the same
    `--domain` each write their own file claiming the same `Host()`. Traefik then
    picks one and the other silently never answers -- the failure this module's own
    docstring warns about one layer down, in the same words: it "looks stable under
    testing and would silently serve the wrong workspace forever".

    Found by running a scenario matrix on one box: THREE route files all claiming
    `HostSNI(rc-rpro-test.kestron.org)`, two pointing at NodePorts that no longer
    existed. Traefik chose a dead one, so the name returned EOF, cert-manager's
    self check failed, and the certificate never issued -- for a chain that was
    otherwise entirely correct. It cost an hour to find because every individual
    component was right.
    """
    fd.register("alice", "shared.example.com")
    assert fd.route_host("alice") == "shared.example.com"
    assert fd.host_owner("shared.example.com") == "alice"
    # Case-insensitively, because DNS is.
    assert fd.host_owner("SHARED.example.com") == "alice"
    # A workspace may always re-claim its OWN name -- that is every `up` after a
    # `down`, and refusing it would break bringing a workspace back.
    assert fd.host_owner("shared.example.com", excluding="alice") == ""
    # A passthrough route counts too: it is HostSNI rather than Host, and the whole
    # point is that both kinds share one entrypoint.
    fd.register("kube", "k.example.com", passthrough="10.0.0.1:443")
    assert fd.route_host("kube") == "k.example.com"
    assert fd.host_owner("k.example.com") == "kube"
    assert fd.host_owner("nobody.example.com") == ""


def test_resolving_tls_refuses_a_hostname_another_workspace_holds(tmp_path, monkeypatch):
    """Refused where BOTH runtimes pass, so neither can grow its own answer."""
    from houston import errors
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.register("first", "taken.example.com")

    req = lc.CreateReq(version="8.5.1", name="second",
                       domain="taken.example.com", acme_email="o@e.com")
    with pytest.raises(errors.ConflictError) as exc:
        lc._resolve_tls(req, "second", "127.0.0.1", exclude="second")
    assert "already served for workspace 'first'" in str(exc.value)
    assert "houston down --name first" in str(exc.value), "say how to free it"

    # And the workspace that owns it can still be brought back up.
    again = lc.CreateReq(version="8.5.1", name="first",
                         domain="taken.example.com", acme_email="o@e.com")
    spec = lc._resolve_tls(again, "first", "127.0.0.1", exclude="first")
    assert spec.host == "taken.example.com"


def test_stopping_an_edge_that_was_never_set_up_is_not_a_traceback(tmp_path,
                                                                   monkeypatch):
    """`edge stop` on a home with no `edge/` directory answered with a Python
    traceback:

        error: FileNotFoundError: [Errno 2] No such file or directory:
        PosixPath('/home/ubuntu/.houston/edge') - this is unhandled

    `cwd` for the compose seam is `edge_dir()`, and a home that has never had an edge
    has no such directory. `_docker` one function above it carries an explicit NEVER
    RAISES contract for exactly this class of problem, and `_compose_capture` has the
    guard too -- this was the one seam without it, and it was the one that broke.

    Hit while cleaning a shared box, which is precisely when a home has no edge.
    """
    from typer.testing import CliRunner

    from houston import cli

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert not fd.edge_dir().exists(), "the point of the test"

    r = CliRunner().invoke(cli.app, ["edge", "stop"])
    assert r.exception is None or isinstance(r.exception, SystemExit), r.exception
    assert "Traceback" not in (r.output or "")
    assert "nothing to stop" in (r.output or ""), r.output
    # And it must not claim the ports are free, which it knows nothing about.
    assert "are free" not in (r.output or ""), r.output


def test_the_compose_seam_never_raises(tmp_path, monkeypatch):
    """The seam itself, not just the command that found it. A seam that raises for one
    caller raises for the next, and every caller here treats it as returning a
    result."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "never-made"))
    assert not fd.edge_dir().exists()
    res = fd._compose("ps")
    assert res.returncode == 127, "127 is 'could not run it'"
    assert "No such file" in (res.stderr or ""), res.stderr
    # `down` is the caller that broke, and it now reports rather than raising.
    assert fd.down() == 127
    # And the log stream, the one remaining direct call with the same cwd.
    assert fd.logs(tail=1, follow=False) == 127


def test_edge_stop_reports_a_compose_that_could_not_run(tmp_path, monkeypatch):
    """It discarded the exit code and printed success unconditionally, so a compose
    that could not run at all reported the ports as free -- the same
    reported-success-without-reading-the-answer shape this codebase keeps finding."""
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import edge as edgesvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    edgesvc.write(edgesvc.Edge())                      # so `installed()` is True
    monkeypatch.setattr(edgesvc, "down", lambda: 1)
    r = CliRunner().invoke(cli.app, ["edge", "stop"])
    assert r.exit_code != 0, r.output
    assert "could not stop the edge" in (r.output or ""), r.output


def test_a_broken_gui_route_from_an_older_version_is_repaired(tmp_path, monkeypatch):
    """An older houston wrote a GUI route even with no domain, producing
    `Host(``)` -- rejected at every reload with "empty args for matcher Host".
    Not writing it any more does nothing for the edges that already have one, and
    nobody would think to look in a generated directory. Found on a real box."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge())
    fd.route_path("_gui").write_text('rule: "Host(``)"\n')   # as the old code left it
    monkeypatch.setattr(fd, "running", lambda: True)
    # A running edge now reconciles its compose file, so these have to stub the compose
    # call too -- they used to return before reaching it.
    monkeypatch.setattr(fd, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd, "reattach_all", lambda: [])
    monkeypatch.setattr(fd, "_compose", _ok_compose)

    fd.ensure_running()
    assert not fd.route_path("_gui").exists()


def test_a_real_gui_route_is_left_alone(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge(domain="gui.example.com", acme_email="o@e.com"))
    monkeypatch.setattr(fd, "running", lambda: True)
    monkeypatch.setattr(fd, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd, "reattach_all", lambda: [])
    monkeypatch.setattr(fd, "_compose", _ok_compose)
    fd.ensure_running()
    assert 'Host(`gui.example.com`)' in fd.route_path("_gui").read_text()


def test_another_homes_edge_is_not_mistaken_for_this_one(tmp_path, monkeypatch):
    """Every HOUSTON_HOME uses the same compose project name, so a container
    started from a DIFFERENT home matched the label filter and running() said
    True while installed() said False. ensure_running() then wrote no
    configuration at all, routes went into a directory nothing watched, and every
    name 404'd while `edge status` reported "no edge yet" beside a running edge.
    """
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    calls = []

    def fake_docker(*args, **kw):
        calls.append(args)
        out = ""
        if args[:1] == ("ps",):
            out = "deadbeef\n"
        elif args[:1] == ("inspect",):
            out = "/somebody/elses/.houston/edge\n"      # a different home
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd, "_docker", fake_docker)
    assert fd.running() is False, "a foreign edge is not this home's edge"


def test_this_homes_edge_is_recognised(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def fake_docker(*args, **kw):
        out = ""
        if args[:1] == ("ps",):
            out = "deadbeef\n"
        elif args[:1] == ("inspect",):
            out = str(fd.edge_dir()) + "\n"
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd, "_docker", fake_docker)
    assert fd.running() is True


def test_a_foreign_edge_holding_443_is_named_as_such(tmp_path, monkeypatch):
    """Skipping by container NAME alone hid the most confusing case: an edge from
    a different HOUSTON_HOME has exactly our name, so it was excluded as "us"
    and reported as "something outside Docker"."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def fake_docker(*args, **kw):
        out = ""
        if args[:2] == ("ps", "--format"):
            out = f"{fd.CONTAINER}\t0.0.0.0:443->443/tcp\n"
        elif args[:1] == ("ps",):
            out = "deadbeef\n"
        elif args[:1] == ("inspect",):
            out = "/somebody/elses/.houston/edge\n"
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd, "_docker", fake_docker)
    assert "another HOUSTON_HOME" in fd.port_holder(443)


def test_starting_an_edge_never_replaces_another_homes(tmp_path, monkeypatch):
    """Compose keys a project by NAME and every home uses the same one, so
    `up -d` REPLACED the other home's container rather than failing -- silently
    taking down every https name it served. Observed doing exactly that. It
    matters because the DEFAULT home is ~/.houston: on a shared box, the second
    person's `up --https` steals the first person's ingress."""
    from houston.errors import ConflictError

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    started = []

    def fake_docker(*args, **kw):
        out = ""
        if args[:1] == ("ps",):
            out = "deadbeef\n"
        elif args[:1] == ("inspect",):
            out = "/home/someone-else/.houston/edge\n"
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd, "_docker", fake_docker)
    monkeypatch.setattr(fd, "_compose", lambda *a, **k: started.append(a) or type(
        "P", (), {"returncode": 0, "stdout": ""})())

    with pytest.raises(ConflictError) as exc:
        fd.up(pull=False)
    assert "/home/someone-else/.houston/edge" in str(exc.value)
    assert started == [], "it must not have run compose at all"


def test_our_own_edge_is_not_treated_as_foreign(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def fake_docker(*args, **kw):
        out = ""
        if args[:1] == ("ps",):
            out = "deadbeef\n"
        elif args[:1] == ("inspect",):
            out = str(fd.edge_dir()) + "\n"
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd, "_docker", fake_docker)
    assert fd.foreign_edge() == ""


def test_edge_start_does_not_claim_success_while_a_cluster_holds_the_ports(
        tmp_path, monkeypatch):
    """`edge start` printed "every registered name is served again" about a box that
    served none of them.

    The edge really does start: k3s's ServiceLB claims host ports by CNI portmap DNAT,
    not by binding, so compose succeeds, the container binds :80 and :443, and every
    packet is taken by kube-proxy before Docker sees it. This message was the last
    thing a manager's install said before two days of the GUI being dark, and it said
    the opposite of the truth.
    """
    import subprocess

    from typer.testing import CliRunner

    from houston import cli
    from houston.services import edge as edgesvc, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    edgesvc.write(edgesvc.Edge())
    monkeypatch.setattr(edgesvc, "up", lambda **k: subprocess.CompletedProcess(
        args=[], returncode=0, stdout="", stderr=""))
    monkeypatch.setattr(k8s, "port_claiming_cluster",
                        lambda *a, **k: k8s.PortClaim(
                            context="default", service="kube-system/traefik",
                            address="172.31.46.139", ports=[80, 443]))

    out = CliRunner().invoke(cli.app, ["edge", "start"]).output or ""
    assert "every registered name is served again" not in out, out
    assert "NOT reachable" in out, out
    assert "'default'" in out and "172.31.46.139" in out, out
    assert "NodePort" in out, "hand over the command that gives the ports back"
    assert "--disable servicelb" in out, "and how to stop it recurring"

    # With nothing holding the ports the message is the plain success it always was.
    monkeypatch.setattr(k8s, "port_claiming_cluster", lambda *a, **k: None)
    plain = CliRunner().invoke(cli.app, ["edge", "start"]).output or ""
    assert "every registered name is served again" in plain, plain
    assert "NOT reachable" not in plain, plain


def test_the_tls_verdict_stops_waiting_when_no_challenge_can_reach_the_host(
        tmp_path, monkeypatch):
    """It waited twenty seconds for a certificate that could not arrive.

    With a cluster holding :80 and :443, neither HTTP-01 nor TLS-ALPN can complete --
    the challenge request is answered by the cluster. Polling anyway printed "waiting
    for the certificate…" and then a message saying issuance "may still complete",
    which is how a reader learns to ignore the line that mattered.
    """
    from houston import cli
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s, "port_claiming_cluster",
                        lambda *a, **k: k8s.PortClaim(
                            context="default", service="kube-system/traefik",
                            address="172.31.46.139", ports=[80, 443]))
    slept = []
    monkeypatch.setattr("time.sleep", lambda s: slept.append(s))
    said = []
    monkeypatch.setattr(cli.ui, "warn", lambda m, *a, **k: said.append(m))
    monkeypatch.setattr(cli.ui, "note", lambda m, *a, **k: said.append(m))
    monkeypatch.setattr(cli.ui, "hint", lambda m, *a, **k: said.append(m))
    monkeypatch.setattr(cli.ui, "ok", lambda m, *a, **k: said.append(m))

    cli._report_gui_tls("gui.example.test", tries=10, pause=2.0)

    assert not slept, "nothing to wait for — a cluster is answering the challenge"
    joined = "\n".join(said)
    assert "cannot get a certificate" in joined, joined
    assert "may still complete" not in joined, "that is false here"
    assert "172.31.46.139" in joined, joined


def test_the_port_claim_probe_costs_nothing_on_a_box_with_no_kubectl(monkeypatch):
    """This runs on the way to starting a proxy, so it must be nearly free.

    Four probes at the 8s default is half a minute added to `edge start` — on a box
    whose kubeconfig points at an unreachable remote cluster, which is an ordinary
    laptop. A Docker-only box must not pay for a Kubernetes check at all.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.shutil, "which", lambda name: None)
    called = []
    monkeypatch.setattr(k8s, "run", lambda *a, **k: called.append(a) or (_ for _ in ()).throw(
        AssertionError("no kubectl on this box — nothing should have been run")))
    assert k8s.port_claiming_cluster() is None
    assert not called, "a Docker-only box must not shell out at all"

    # With kubectl present, every probe carries the shortened timeout it was given.
    monkeypatch.setattr(k8s.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(k8s, "active_context", lambda: "default")
    seen = []

    def _run(argv, **kw):
        seen.append(kw.get("timeout"))
        import subprocess
        return subprocess.CompletedProcess(argv, 1, "", "")

    monkeypatch.setattr(k8s, "run", _run)
    k8s.port_claiming_cluster(timeout=3.0)
    assert seen and all(t == 3.0 for t in seen), seen


# --- forgetting a name --------------------------------------------------------
# `down --volumes` removes a ROUTE. Route files are keyed by workspace name and
# certificate material by HOSTNAME, so everything below survived a teardown with
# nothing in the tool able to see it, let alone remove it.

_ACME = {
    "le": {
        "Account": {"Email": "ops@xyz.com", "PrivateKey": "acct-key"},
        "Certificates": [
            {"domain": {"main": "gone.example.org", "sans": []},
             "certificate": "c1", "key": "k1"},
            {"domain": {"main": "keep.example.org", "sans": ["www.keep.example.org"]},
             "certificate": "c2", "key": "k2"},
        ],
    },
}


def _write_acme(staging: bool = False, doc: dict | None = None) -> None:
    import json as _json

    from houston import tls
    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    (tls.acme_dir() / tls.acme_storage_name(staging)).write_text(
        _json.dumps(doc if doc is not None else _ACME), encoding="utf-8")


def _read_acme(staging: bool = False) -> dict:
    import json as _json

    from houston import tls
    return _json.loads((tls.acme_dir() / tls.acme_storage_name(staging)).read_text())


def test_a_teardown_leaves_the_certificate_and_its_private_key(tmp_path):
    """THE DEFECT, stated as the thing that survives.

    `deregister` is what teardown calls and it unlinks `dynamic/<name>.yml`. The
    certificate, its key and the declaration that loads them are named after the
    HOST, so all three walk straight past it -- and `orphan_certs` reports nothing,
    because it flags a declaration whose certificate is MISSING and here everything
    is present, valid, and unreachable. The visible symptom is a TLS handshake that
    succeeds, with a genuine certificate for the name, into a 404.
    """
    host = "t-1234.houston.localhost"
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("t-1234", host, local=True)
    fd.issue_local_cert(host)
    _write_acme(doc={"le": {"Certificates": [
        {"domain": {"main": host, "sans": []}, "certificate": "c", "key": "k"}]}})

    fd.deregister("t-1234")                      # exactly what `down --volumes` calls

    assert (fd.certs_dir() / f"{host}.crt").is_file()
    assert (fd.certs_dir() / f"{host}.key").is_file()
    assert (fd.dynamic_dir() / f"_cert-{host}.yml").is_file()
    assert fd.acme_hosts() == [host]
    assert fd.orphan_certs() == [], "the wrong direction: it finds MISSING certs"


def test_delete_host_removes_everything_a_teardown_left(tmp_path):
    host = "t-1234.houston.localhost"
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("t-1234", host, local=True)
    fd.issue_local_cert(host)
    _write_acme(doc={"le": {"Account": {"Email": "ops@xyz.com"}, "Certificates": [
        {"domain": {"main": host, "sans": []}, "certificate": "c", "key": "k"}]}})

    gone = fd.delete_host(host, confirm=True, restart=False)

    assert gone["host"] == host
    assert gone["routes"] == ["t-1234"]
    assert gone["certificate"] is True
    assert gone["declaration"] is True
    assert gone["acme"] == ["acme.json"]
    assert not (fd.certs_dir() / f"{host}.crt").exists()
    assert not (fd.certs_dir() / f"{host}.key").exists()
    assert not (fd.dynamic_dir() / f"_cert-{host}.yml").exists()
    assert not fd.route_path("t-1234").exists()
    assert fd.acme_hosts() == []
    # The ACCOUNT is a registration with Let's Encrypt, not a certificate. Dropping
    # it makes the next issuance register again for nothing.
    assert _read_acme()["le"]["Account"] == {"Email": "ops@xyz.com"}


def test_delete_host_reports_only_what_actually_went(tmp_path):
    """A name with a route and no certificate must not be reported as a certificate
    deletion. Reporting the attempt as the outcome is the shape `edge stop` had."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("k1", "k1.example.org", passthrough="10.0.0.5:31443")

    gone = fd.delete_host("k1.example.org", confirm=True, restart=False)

    assert gone["routes"] == ["k1"]
    assert gone["passthrough"] == ["k1"], "so the caller can say where the cert IS"
    assert gone["certificate"] is False
    assert gone["declaration"] is False
    assert gone["acme"] == []
    assert gone["restarted"] is None, "no ACME entry went, so nothing needed a restart"


def test_delete_host_finds_every_route_claiming_the_name(tmp_path):
    """The collision that cost an hour was THREE files on one host. Removing one
    would leave the name still claimed and still broken."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    for n in ("a", "b", "c"):
        fd.register(n, "dupe.example.org", passthrough="10.0.0.5:31443")

    assert fd.routes_for("dupe.example.org") == ["a", "b", "c"]
    gone = fd.delete_host("dupe.example.org", confirm=True, restart=False)
    assert gone["routes"] == ["a", "b", "c"]
    assert fd.registered() == []


def test_delete_host_refuses_while_a_live_workspace_claims_the_name(tmp_path):
    """Deleting the certificate under a running workspace would leave one that
    cannot serve its own name. The workspace is NAMED, with the command."""
    from houston import runner
    from houston.errors import ConflictError

    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("live", "live.example.org", local=True)
    runner.workspace("live").mkdir(parents=True, exist_ok=True)
    (runner.workspace("live") / "repro.json").write_text("{}", encoding="utf-8")

    with pytest.raises(ConflictError) as exc:
        fd.delete_host("live.example.org", confirm=True, restart=False)
    assert "live" in str(exc.value)
    assert "down --name live --volumes" in str(exc.value)
    assert fd.route_path("live").exists(), "refused means nothing was touched"


def test_a_route_whose_workspace_is_gone_is_exactly_the_case_it_serves(tmp_path):
    """The orphan. `runner.exists` is False, so the refusal above must not fire --
    this is the state a teardown leaves and the reason the command exists."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("ghost", "ghost.example.org", local=True)
    fd.issue_local_cert("ghost.example.org")

    gone = fd.delete_host("ghost.example.org", confirm=True, restart=False)
    assert gone["routes"] == ["ghost"]
    assert gone["certificate"] is True


def test_delete_host_refuses_the_guis_own_name(tmp_path):
    """It would take `serve` off HTTPS while the operator is probably using it to
    run the command."""
    from houston.errors import ConflictError

    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    with pytest.raises(ConflictError) as exc:
        fd.delete_host("support.xyz.com", confirm=True, restart=False)
    assert "GUI's own name" in str(exc.value)


def test_delete_host_refuses_without_confirmation(tmp_path):
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("x", "x.example.org", local=True)
    fd.issue_local_cert("x.example.org")
    with pytest.raises(ValidationError) as exc:
        fd.delete_host("x.example.org", restart=False)
    assert "PRIVATE KEY" in str(exc.value)
    assert (fd.certs_dir() / "x.example.org.crt").is_file(), "nothing touched"


def test_delete_host_needs_a_hostname(tmp_path):
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    with pytest.raises(ValidationError) as exc:
        fd.delete_host("  ", confirm=True, restart=False)
    assert "edge delete" in str(exc.value)


def test_a_trailing_dot_is_the_same_name(tmp_path):
    """`example.org.` is how a resolver spells it and how a copy-paste arrives."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("x", "x.example.org", local=True)
    gone = fd.delete_host("x.example.org.", confirm=True, restart=False)
    assert gone["routes"] == ["x"]


def test_both_acme_stores_are_searched(tmp_path):
    """Staging and production are SEPARATE files. `config set acme.staging false`
    after a staging issuance leaves the staging entry behind, and a delete that
    looked only at the live store would report success over a key still on disk."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme(staging=False)
    _write_acme(staging=True)
    assert fd.acme_hosts() == ["gone.example.org", "keep.example.org",
                               "www.keep.example.org"]

    gone = fd.delete_host("gone.example.org", confirm=True, restart=False)
    assert sorted(gone["acme"]) == ["acme-staging.json", "acme.json"]
    for staging in (False, True):
        mains = [c["domain"]["main"] for c in _read_acme(staging)["le"]["Certificates"]]
        assert mains == ["keep.example.org"]


def test_a_name_held_only_as_a_san_is_found_and_removed(tmp_path):
    """A SAN is served exactly like a main name, so a delete that matched only
    `domain.main` would leave the certificate presenting the deleted name."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    gone = fd.delete_host("www.keep.example.org", confirm=True, restart=False)
    assert gone["acme"] == ["acme.json"]
    assert fd.acme_hosts() == ["gone.example.org"]


def test_the_rewritten_acme_store_is_still_0600(tmp_path):
    """It is a file full of private keys. `atomic_write` would create it 0644 from
    the umask, which is how a fix for one exposure becomes another."""
    import stat

    from houston import tls
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    fd.delete_host("gone.example.org", confirm=True, restart=False)
    mode = (tls.acme_dir() / tls.ACME_FILE).stat().st_mode
    assert stat.S_IMODE(mode) == 0o600, oct(stat.S_IMODE(mode))


def test_a_garbage_acme_store_is_not_an_exception(tmp_path):
    """A half-written or hand-edited store means "no certificate for that host in
    here", which is the only question being asked of it."""
    from houston import tls
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    (tls.acme_dir() / tls.ACME_FILE).write_text("{not json", encoding="utf-8")
    assert fd.acme_hosts() == []
    assert fd.delete_host("x.example.org", confirm=True, restart=False)["acme"] == []


def test_deleting_a_name_that_is_not_here_says_so(tmp_path):
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    gone = fd.delete_host("nothing.example.org", confirm=True, restart=False)
    assert gone["routes"] == [] and gone["acme"] == []
    assert gone["certificate"] is False and gone["declaration"] is False


def test_the_issuance_ledger_is_kept(tmp_path):
    """`acme/issued.json` is the rate-limit history `tls-status` counts against
    Let's Encrypt's five-a-week duplicate limit. Deleting a certificate does not
    give the budget back, so erasing the record would make the count LIE."""
    from houston import tls
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    tls.record_issuance("gone.example.org")
    _write_acme()
    gone = fd.delete_host("gone.example.org", confirm=True, restart=False)
    assert gone["kept"] == ["acme/issued.json"]
    assert tls.recent_issuances("example.org") == 1


def test_a_local_certificate_deletion_does_not_restart_the_edge(tmp_path,
                                                               monkeypatch):
    """A route and a local certificate are read from disk, so removing the file is
    already in effect. Restarting for those would interrupt every other name on the
    box and buy nothing."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("x", "x.example.org", local=True)
    fd.issue_local_cert("x.example.org")
    monkeypatch.setattr(fd, "running", lambda: True)
    monkeypatch.setattr(fd, "down", lambda: pytest.fail("should not restart"))
    assert fd.delete_host("x.example.org", confirm=True)["restarted"] is None


def test_an_acme_deletion_restarts_a_running_edge(tmp_path, monkeypatch):
    """Traefik holds the ACME store in memory and rewrites the whole file when a
    certificate changes, so an edit made underneath it can be written back from
    memory -- the entry reappears hours after a command said it was deleted.
    Restarting rebuilds that memory from the edited file."""
    import subprocess

    calls = []
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    # Pinned, because `foreign_edge` asks DOCKER -- and on a developer box with a
    # real edge running it answers truthfully, which made this test depend on the
    # machine it ran on. Nothing in this suite needs Docker; keep it that way.
    monkeypatch.setattr(fd, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd, "running", lambda: True)
    monkeypatch.setattr(fd, "down", lambda: calls.append("down") or 0)
    monkeypatch.setattr(fd, "up", lambda pull=True: calls.append("up")
                        or subprocess.CompletedProcess([], 0))
    assert fd.delete_host("gone.example.org", confirm=True)["restarted"] is True
    assert calls == ["down", "up"]


def test_a_stopped_edge_is_not_started_just_to_delete(tmp_path, monkeypatch):
    """Nothing can write the entry back while it is stopped, and starting it would
    claim :443 as a side effect of a deletion."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    monkeypatch.setattr(fd, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd, "running", lambda: False)
    monkeypatch.setattr(fd, "up", lambda pull=True: pytest.fail("must not start"))
    assert fd.delete_host("gone.example.org", confirm=True)["foreign"] == ""
    assert fd.delete_host("gone.example.org", confirm=True)["restarted"] is None


def test_edge_delete_from_the_cli(tmp_path):
    from typer.testing import CliRunner

    from houston import cli
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("x", "x.example.org", local=True)
    fd.issue_local_cert("x.example.org")

    r = CliRunner().invoke(cli.app, ["edge", "delete", "x.example.org", "--yes"])
    assert r.exit_code == 0, r.output
    assert "certificate and key for x.example.org removed" in r.output
    assert not fd.route_path("x").exists()


def test_edge_delete_without_a_host_says_which_command_lists_them(tmp_path):
    from typer.testing import CliRunner

    from houston import cli
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    r = CliRunner().invoke(cli.app, ["edge", "delete", "--yes"])
    assert r.exit_code != 0
    assert "edge status" in r.output


def test_edge_delete_renders_a_refusal_rather_than_raising(tmp_path):
    """A ConflictError uncaught here is a Python traceback with cli.py's source in
    it -- the exact failure `edge start` shipped with."""
    from typer.testing import CliRunner

    from houston import cli
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    r = CliRunner().invoke(cli.app, ["edge", "delete", "support.xyz.com", "--yes"])
    assert r.exit_code != 0
    assert "Traceback" not in r.output
    assert "GUI's own name" in r.output


def test_edge_status_names_a_certificate_with_no_route(tmp_path):
    """A name cannot be cleaned up until it can be SEEN, and a Let's Encrypt key
    for a customer-shaped hostname in acme.json was invisible to every command."""
    from typer.testing import CliRunner

    from houston import cli
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    r = CliRunner().invoke(cli.app, ["edge", "status"])
    assert "certificate(s) held with no route" in r.output
    assert "gone.example.org" in r.output
    assert "edge delete" in r.output


def test_a_foreign_edge_is_reported_and_never_restarted(tmp_path, monkeypatch):
    """Every home names its compose project `houston_edge`, so a naive restart would
    stop whichever container carries that label -- another HOUSTON_HOME's included.
    `running()` is home-aware and already prevents that; what was missing was the
    SENTENCE. A foreign edge reads its own ACME store, so the certificate deleted
    here is this home's copy and the name is still being served with the other one.

    Not hypothetical in either direction: this box's owner lost their edge to exactly
    this shape, by hand, following an error message that did not know about it.
    """
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    monkeypatch.setattr(fd, "running", lambda: False)      # not OURS
    monkeypatch.setattr(fd, "foreign_edge", lambda: "/home/someone/.houston/edge")
    monkeypatch.setattr(fd, "down", lambda: pytest.fail("would stop another home's edge"))
    monkeypatch.setattr(fd, "up", lambda pull=True: pytest.fail("nor start ours over it"))

    gone = fd.delete_host("gone.example.org", confirm=True)
    assert gone["restarted"] is None
    assert gone["foreign"] == "/home/someone/.houston/edge"
    # The deletion itself still happened -- the key came off THIS disk, which is
    # what was asked for.
    assert gone["acme"] == ["acme.json"]


def test_the_cli_says_the_deleted_key_was_not_the_one_being_served(tmp_path,
                                                                  monkeypatch):
    """A foreign edge mounts its OWN home's ACME store, so reporting a plain success
    would claim a name stopped being served when nothing changed for it."""
    from typer.testing import CliRunner

    from houston import cli
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    monkeypatch.setattr(fd, "foreign_edge", lambda: "/home/someone/.houston/edge")
    monkeypatch.setattr(fd, "running", lambda: False)

    r = CliRunner().invoke(cli.app, ["edge", "delete", "gone.example.org", "--yes"])
    assert r.exit_code == 0, r.output
    assert "another HOUSTON_HOME" in r.output
    assert "/home/someone/.houston/edge" in r.output
    # Collapsed: ui wraps, so the sentence is asserted on the unwrapped text.
    flat = " ".join(r.output.split())
    assert "reads its OWN certificate store" in flat, flat
    assert "not the certificate that name is being served with" in flat, flat


def test_tls_status_does_not_report_a_cluster_placeholder_as_this_workspaces_cert(
        tmp_path, monkeypatch):
    """It probed 127.0.0.1 ONLY, so on a box where something else holds IPv4 :443 it
    reported that thing's certificate as the workspace's.

    Found live: k3s ServiceLB DNATs IPv4 :443 into the cluster, whose ingress is also
    Traefik -- so `tls-status` on a healthy local-CA workspace showed
    `CN = TRAEFIK DEFAULT CERT` and advised that "ACME never succeeded", about a
    workspace that uses no ACME at all. `curl` and `tls.verify` on the NAME both
    agreed the real certificate was being served, from [::1], at the same moment.
    """
    from typer.testing import CliRunner

    from houston import cli, runner
    from houston import tls as tlsmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("w", "t1.example.com", tmp_path)
    monkeypatch.setattr(runner, "docker_available", lambda **k: True)

    asked: list[str] = []

    def fake_verify(host, port, **kw):
        asked.append(host)
        if host == "127.0.0.1":            # the squatter: a different Traefik
            return {"serving": True, "fallback": True,
                    "issuer": "CN = TRAEFIK DEFAULT CERT",
                    "subject": "CN = TRAEFIK DEFAULT CERT", "dates": "", "names": [],
                    "trusted": False, "trusted_via_ca": False, "error": ""}
        return {"serving": True, "fallback": False,
                "issuer": "CN = houston local CA", "subject": "CN = t1.example.com",
                "dates": "notAfter=Nov 23 2026", "names": ["t1.example.com"],
                "trusted": True, "trusted_via_ca": True, "error": ""}
    monkeypatch.setattr(tlsmod, "verify", fake_verify)

    r = CliRunner().invoke(cli.app, ["tls-status", "--name", "w"])
    assert "::1" in asked, f"the other loopback family was never tried: {asked}"
    assert "houston local CA" in (r.output or ""), r.output
    assert "TRAEFIK DEFAULT CERT" not in (r.output or ""), \
        "another program's placeholder was reported as this workspace's certificate"


def test_tls_status_still_reports_a_placeholder_when_every_family_serves_one(
        tmp_path, monkeypatch):
    """The counterpart: if nothing is serving the real certificate then the
    placeholder IS the finding, and must not be hidden by the family sweep."""
    from typer.testing import CliRunner

    from houston import cli, runner
    from houston import tls as tlsmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("w", "t1.example.com", tmp_path)
    monkeypatch.setattr(runner, "docker_available", lambda **k: True)
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **k: {
        "serving": True, "fallback": True, "issuer": "CN = TRAEFIK DEFAULT CERT",
        "subject": "CN = TRAEFIK DEFAULT CERT", "dates": "", "names": [],
        "trusted": False, "trusted_via_ca": False, "error": ""})
    r = CliRunner().invoke(cli.app, ["tls-status", "--name", "w"])
    assert "TRAEFIK DEFAULT CERT" in (r.output or ""), r.output


def test_config_get_and_list_tell_false_apart_from_unset(tmp_path, monkeypatch):
    """`cfg.get(k) or '(unset)'` renders a stored `False` as unset, and
    `acme.staging` is a BOOLEAN whose whole history is people not being able to tell
    which way it is set.

    `config set acme.staging false` reported success and then both `get` and `list`
    said the key was unset -- the same confusion, one layer up, as the `bool("false")`
    defect this key already had.
    """
    from typer.testing import CliRunner

    from houston import cli

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    run = CliRunner()

    assert run.invoke(cli.app, ["config", "set", "acme.staging", "false"]).exit_code == 0
    got = run.invoke(cli.app, ["config", "get", "acme.staging"])
    assert got.output.strip() == "False", f"a stored False printed as {got.output!r}"
    listed = run.invoke(cli.app, ["config", "list"]).output
    assert "(unset)" not in [ln for ln in listed.splitlines()
                             if "acme.staging" in ln][0], listed

    # And a key that really is unset still says so.
    assert run.invoke(cli.app, ["config", "unset", "acme.staging"]).exit_code == 0
    assert run.invoke(cli.app, ["config", "get", "acme.staging"]).output.strip() == ""
    listed = run.invoke(cli.app, ["config", "list"]).output
    assert "(unset)" in [ln for ln in listed.splitlines()
                         if "acme.staging" in ln][0], listed


def test_a_passthrough_route_is_not_reported_unreachable(tmp_path, monkeypatch):
    """`edge status` computed reachability as Docker-network membership, and a
    PASSTHROUGH route joins no workspace network -- so every Kubernetes workspace
    was listed `NO (502)`.

    Measured in production conditions on EC2: a workspace answering HTTP 200 from
    the internet on a real Let's Encrypt certificate, reported unreachable by the
    command whose job is to say whether it is reachable. `/api/edge` had already
    learned this; the CLI had not, which is the same two-front-ends drift as the
    `Host(` / `HostSNI(` parser.
    """
    from houston.services import edge as edgesvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(edgesvc, "is_passthrough", lambda n: n == "kube")
    monkeypatch.setattr(edgesvc, "workspace_network",
                        lambda n: f"houston-{n}_default")

    # A passthrough forwards raw TCP to a NodePort; there is no network to join.
    assert edgesvc.route_reachable("kube", set()) is True
    # An HTTP route still needs the edge to have joined its network.
    assert edgesvc.route_reachable("cmp", set()) is False
    assert edgesvc.route_reachable("cmp", {"houston-cmp_default"}) is True
