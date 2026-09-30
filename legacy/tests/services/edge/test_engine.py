"""`houston.services.edge.engine`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from edgehelpers import _acme_workspace, _ok_compose, _write_acme
from houston.services import edge as fd
import pytest


def test_a_failed_start_names_what_holds_the_port(monkeypatch):
    """"The edge did not start" sends you looking at the edge, when the cause is
    almost always something ELSE on :443 -- hit twice while building this."""
    monkeypatch.setattr(fd.engine, "_docker", lambda *a, **k: type(
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

    monkeypatch.setattr(fd.engine, "_docker", fake)
    # The behavioural claim FIRST, so this fails on the behaviour against the pre-fix
    # code rather than on a helper that did not exist yet.
    assert fd.running() is False, "up but holding nothing is not running"
    assert fd.our_container() == "c0ffee", "...though the container really is up"


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

    monkeypatch.setattr(fd.engine, "_docker", fake)
    said = fd.port_holder(443)
    assert "rcrepro_edge-edge-1" in said
    assert "rcrepro_edge'" in said, f"the project has to be named too: {said}"


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

    monkeypatch.setattr(fd.engine, "_docker", fake_docker)
    assert fd.running() is False, "a foreign edge is not this home's edge"


# --- TLS after the edge ---------------------------------------------------------
# A workspace terminates no TLS, so `_resolve_tls` no longer allocates a port,
# probes one, or decides anything about a sidecar. What is left is: which name,
# and which certificate source.

def test_a_domain_still_needs_only_a_domain_and_an_email(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import tls
    from houston.services import edge as edgesvc
    from houston.services import lifecycle as lcsvc

    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    req = lcsvc.CreateReq(version="8.5.1", domain="chat.example.com",
                          acme_email="me@example.com")
    spec = lcsvc._resolve_tls(req, "w", "127.0.0.1")
    assert spec.mode == tls.MODE_ACME
    assert spec.host == "chat.example.com"
    assert spec.root_url == "https://chat.example.com", "443 carries no port"


def test_local_https_gets_a_localhost_name_and_no_port_of_its_own(tmp_path, monkeypatch):
    """It used to allocate 8443, 8444, ... one per workspace, each with its own
    URL. Every name answers on the edge's 443 now."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import tls
    from houston.services import edge as edgesvc
    from houston.services import lifecycle as lcsvc

    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    req = lcsvc.CreateReq(version="8.5.1", https=True)
    spec = lcsvc._resolve_tls(req, "w", "127.0.0.1")
    assert spec.mode == tls.MODE_LOCAL
    assert spec.host == "w.houston.localhost"
    assert spec.root_url == "https://w.houston.localhost"


def test_a_pre_edge_workspace_is_found(tmp_path):
    _acme_workspace("lovekesh-rc8-5-1-email", "testrepo.kestron.org", tmp_path)
    assert fd.holders_of_443() == ["lovekesh-rc8-5-1-email"]


def test_adopting_registers_the_route_and_drops_the_port_claim(tmp_path, monkeypatch):
    from houston import runner

    _acme_workspace("w", "t1.kestron.org", tmp_path)
    monkeypatch.setattr(fd.networks, "attach", lambda name: True)
    monkeypatch.setattr(fd.engine, "_docker", lambda *a, **k: type("P", (), {"returncode": 0, "stdout": ""})())
    fd.adopt("w")

    assert fd.registered() == ["w"]
    assert "t1.kestron.org" in fd.route_path("w").read_text()
    meta = runner.read_meta("w")
    assert meta.extra["edge"] is True
    # It publishes no 443 now; leaving the claim would make every later workspace
    # allocate around a port this one does not hold.
    assert meta.extra["tls_ports"] == []
    assert fd.holders_of_443() == []


# --- the edge is restartable without losing routes ------------------------------

def test_restarting_the_edge_reattaches_every_route(monkeypatch):
    """Attachments are RUNTIME state on the container, so recreating it -- an
    upgrade, a restart, a reboot that pulls a new image -- loses every one while
    the route files survive untouched. The names would then answer 502 rather
    than erroring, which nothing else in the tool would report."""
    fd.write(fd.Edge())
    monkeypatch.setattr(fd.engine, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    for n in ("alice-rc8-5-1", "bob-rc8-5-1"):
        fd.register(n, f"{n}.example.com")

    attached = []
    monkeypatch.setattr(fd.networks, "attach", lambda name: attached.append(name) or True)
    monkeypatch.setattr(fd.engine, "_compose", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    fd.up(pull=False)
    assert sorted(attached) == ["alice-rc8-5-1", "bob-rc8-5-1"]


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

    monkeypatch.setattr(fd.engine, "_docker", fake)
    assert fd.running() is True


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
    monkeypatch.setattr(fd.spec, "installed", lambda: True)
    monkeypatch.setattr(fd.acme, "has_acme", lambda: True)
    monkeypatch.setattr(fd.spec, "served_domain", lambda: "gui.example.test")
    monkeypatch.setattr(fd.engine, "running", lambda: True)
    monkeypatch.setattr(fd.engine, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd.routes, "reattach_all", lambda: [])
    seen = []

    def fake(*args, **kw):
        seen.append(list(args))
        return subprocess.CompletedProcess(list(args), 0, "", "")

    monkeypatch.setattr(fd.engine, "_compose", fake)
    assert fd.ensure_running(acme_email="a@b.test")
    # compose is asked to reconcile: it recreates only if the config changed, which is
    # exactly the decision we want it to make rather than assuming nothing has.
    assert any("up" in a for a in seen), seen

    # And a compose that cannot reconcile is a failure with a reason, not a silent yes.
    monkeypatch.setattr(fd.engine, "_compose", lambda *a, **k: subprocess.CompletedProcess(
        list(a), 1, "", "Error response from daemon: port is already allocated"))
    bad = fd.ensure_running(acme_email="a@b.test")
    assert not bad and "already allocated" in bad.why, bad


def test_a_failed_start_says_what_docker_said(tmp_path, monkeypatch):
    """"error: the edge did not start." was the whole message, on a fresh EC2 box where
    `docker ps -a` was empty -- no container to inspect, no port holder to name, and the
    compose error captured with `capture_output=True` and dropped one frame below.
    `up()` returned only a return code, so both failure sites could do nothing but guess.
    """
    import subprocess
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(fd.engine, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd.engine, "running", lambda: False)
    monkeypatch.setattr(fd.engine, "holders_of_443", lambda: [])
    monkeypatch.setattr(fd.spec, "installed", lambda: True)
    monkeypatch.setattr(fd.acme, "has_acme", lambda: True)
    monkeypatch.setattr(fd.spec, "served_domain", lambda: "gui.example.test")
    monkeypatch.setattr(fd.routes, "reattach_all", lambda: [])
    monkeypatch.setattr(fd.engine, "_compose", lambda *a, **k: subprocess.CompletedProcess(
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
    monkeypatch.setattr(fd.engine, "_compose", lambda *a, **k: subprocess.CompletedProcess(
        list(a), 0, stdout="", stderr=""))
    good = fd.ensure_running(acme_email="a@b.test")
    assert good and good.ok and good.why == ""


# --- adopting is automatic now ---------------------------------------------------

def test_a_legacy_workspace_is_moved_across_without_being_asked(tmp_path, monkeypatch):
    """`--adopt` existed when moving a workspace meant recreating every container:
    asking permission for something expensive is very different from asking to
    remove one proxy container. It is instant and touches no data now, so it
    happens by itself -- and it MUST, because the legacy Traefik holding :443 is
    the reason the edge cannot start at all."""
    _acme_workspace("legacy", "t1.example.com", tmp_path)
    monkeypatch.setattr(fd.engine, "running", lambda: False)
    monkeypatch.setattr(fd.engine, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    started = []
    monkeypatch.setattr(fd.runtime, "up", lambda pull=True: started.append(True) or _ok_compose())

    assert fd.ensure_running()
    assert fd.registered() == ["legacy"], "its route must exist after the move"
    assert started == [True]


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
    monkeypatch.setattr(fd.engine, "running", lambda: True)
    monkeypatch.setattr(fd.engine, "_docker", lambda *a, **k: type(
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
    monkeypatch.setattr(fd.engine, "running", lambda: True)
    monkeypatch.setattr(fd.routes, "register", lambda *a, **k: (_ for _ in ()).throw(
        OSError("disk full")))
    lc._restore_route(runner.read_meta("w"))          # must not raise


def test_the_compose_seam_never_raises(tmp_path, monkeypatch):
    """The seam itself, not just the command that found it. A seam that raises for one
    caller raises for the next, and every caller here treats it as returning a
    result."""
    from houston import exec as process

    def absent(*_args, **_kwargs):
        raise FileNotFoundError(2, "No such file or directory", "docker")

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "never-made"))
    monkeypatch.setattr(process, "run", absent)
    assert not fd.edge_dir().exists()
    res = fd._compose("ps")
    assert res.returncode == 127, "127 is 'could not run it'"
    assert "No such file" in (res.stderr or ""), res.stderr
    # `down` is the caller that broke, and it now reports rather than raising.
    assert fd.down() == 127
    # And the log stream, the one remaining direct call with the same cwd.
    assert fd.logs(tail=1, follow=False) == 127


def test_a_broken_gui_route_from_an_older_version_is_repaired(tmp_path, monkeypatch):
    """An older houston wrote a GUI route even with no domain, producing
    `Host(``)` -- rejected at every reload with "empty args for matcher Host".
    Not writing it any more does nothing for the edges that already have one, and
    nobody would think to look in a generated directory. Found on a real box."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge())
    fd.route_path("_gui").write_text('rule: "Host(``)"\n')   # as the old code left it
    monkeypatch.setattr(fd.engine, "running", lambda: True)
    # A running edge now reconciles its compose file, so these have to stub the compose
    # call too -- they used to return before reaching it.
    monkeypatch.setattr(fd.engine, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd.routes, "reattach_all", lambda: [])
    monkeypatch.setattr(fd.engine, "_compose", _ok_compose)

    fd.ensure_running()
    assert not fd.route_path("_gui").exists()


def test_a_real_gui_route_is_left_alone(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge(domain="gui.example.com", acme_email="o@e.com"))
    monkeypatch.setattr(fd.engine, "running", lambda: True)
    monkeypatch.setattr(fd.engine, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd.routes, "reattach_all", lambda: [])
    monkeypatch.setattr(fd.engine, "_compose", _ok_compose)
    fd.ensure_running()
    assert 'Host(`gui.example.com`)' in fd.route_path("_gui").read_text()


def test_this_homes_edge_is_recognised(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def fake_docker(*args, **kw):
        out = ""
        if args[:1] == ("ps",):
            out = "deadbeef\n"
        elif args[:1] == ("inspect",):
            out = str(fd.edge_dir()) + "\n"
        return type("P", (), {"returncode": 0, "stdout": out})()

    monkeypatch.setattr(fd.engine, "_docker", fake_docker)
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

    monkeypatch.setattr(fd.engine, "_docker", fake_docker)
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

    monkeypatch.setattr(fd.engine, "_docker", fake_docker)
    monkeypatch.setattr(fd.engine, "_compose", lambda *a, **k: started.append(a) or type(
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

    monkeypatch.setattr(fd.engine, "_docker", fake_docker)
    assert fd.foreign_edge() == ""


def test_a_local_certificate_deletion_does_not_restart_the_edge(tmp_path,
                                                               monkeypatch):
    """A route and a local certificate are read from disk, so removing the file is
    already in effect. Restarting for those would interrupt every other name on the
    box and buy nothing."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    fd.register("x", "x.example.org", local=True)
    fd.issue_local_cert("x.example.org")
    monkeypatch.setattr(fd.engine, "running", lambda: True)
    monkeypatch.setattr(fd.engine, "down", lambda: pytest.fail("should not restart"))
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
    monkeypatch.setattr(fd.engine, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd.engine, "running", lambda: True)
    monkeypatch.setattr(fd.engine, "down", lambda: calls.append("down") or 0)
    monkeypatch.setattr(fd.runtime, "up", lambda pull=True: calls.append("up")
                        or subprocess.CompletedProcess([], 0))
    assert fd.delete_host("gone.example.org", confirm=True)["restarted"] is True
    assert calls == ["down", "up"]


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
    monkeypatch.setattr(fd.engine, "running", lambda: False)      # not OURS
    monkeypatch.setattr(fd.engine, "foreign_edge", lambda: "/home/someone/.houston/edge")
    monkeypatch.setattr(fd.engine, "down", lambda: pytest.fail("would stop another home's edge"))
    monkeypatch.setattr(fd.runtime, "up", lambda pull=True: pytest.fail("nor start ours over it"))

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
    monkeypatch.setattr(fd.engine, "foreign_edge", lambda: "/home/someone/.houston/edge")
    monkeypatch.setattr(fd.engine, "running", lambda: False)

    r = CliRunner().invoke(cli.app, ["edge", "delete", "gone.example.org", "--yes"])
    assert r.exit_code == 0, r.output
    assert "another HOUSTON_HOME" in r.output
    assert "/home/someone/.houston/edge" in r.output
    # Collapsed: ui wraps, so the sentence is asserted on the unwrapped text.
    flat = " ".join(r.output.split())
    assert "reads its OWN certificate store" in flat, flat
    assert "not the certificate that name is being served with" in flat, flat
