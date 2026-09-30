"""`houston.services.edge.spec`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from edgehelpers import _doctor, _home as _home, _msgs, _read_acme, _write_acme
from houston.errors import ValidationError
from houston.services import edge as fd
from houston.services import lifecycle as lc
import pytest
import yaml


def test_the_served_domain_is_readable_by_another_process():
    """`up` runs in a different process from the `serve` that set this up, and the
    port-443 error is far more useful when it can name what holds it."""
    assert fd.served_domain() == ""
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    assert fd.served_domain() == "support.xyz.com"


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

    monkeypatch.setattr(edgesvc.spec, "installed", lambda: True)
    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    monkeypatch.setattr(edgesvc.routes, "register", lambda *a, **kw: False)
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


def test_write_materialises_the_project(_home):
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    assert fd.installed()
    assert fd.dynamic_dir().is_dir()
    assert yaml.safe_load(fd.compose_path().read_text())["services"]["edge"]


def test_an_edge_with_no_domain_still_serves_local_names():
    """`up --https` on a box with no domain and no configuration at all. A
    resolver declared without an email makes Traefik fail at startup, so the
    branch is real rather than tidiness."""
    cmd = fd.compose_doc(fd.Edge())["services"]["edge"]["command"]
    assert not any("certificatesresolvers" in a for a in cmd)
    assert "--entryPoints.websecure.address=:443" in cmd


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
    monkeypatch.setattr(fd.routes, "registered", lambda: 1 / 0)
    checks = _doctor(monkeypatch)
    assert checks, "the report must still come back"
    assert "could not be determined" in _msgs(checks, "warn")


def test_reattach_reports_what_it_could_not_join():
    fd.write(fd.Edge())
    assert fd.reattach_all() == [], "nothing registered, nothing to fail"


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


def test_writing_the_edge_creates_the_certs_directory(tmp_path, monkeypatch):
    """Before compose mounts it: a bind-mount source that does not exist is
    created by Docker as root, and houston then cannot write certificates in."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    fd.write(fd.Edge())
    assert fd.certs_dir().is_dir()


def test_edge_stop_reports_a_compose_that_could_not_run(tmp_path, monkeypatch):
    """It discarded the exit code and printed success unconditionally, so a compose
    that could not run at all reported the ports as free -- the same
    reported-success-without-reading-the-answer shape this codebase keeps finding."""
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import edge as edgesvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    edgesvc.write(edgesvc.Edge())                      # so `installed()` is True
    monkeypatch.setattr(edgesvc.engine, "down", lambda: 1)
    r = CliRunner().invoke(cli.app, ["edge", "stop"])
    assert r.exit_code != 0, r.output
    assert "could not stop the edge" in (r.output or ""), r.output


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


def test_deleting_a_name_that_is_not_here_says_so(tmp_path):
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    gone = fd.delete_host("nothing.example.org", confirm=True, restart=False)
    assert gone["routes"] == [] and gone["acme"] == []
    assert gone["certificate"] is False and gone["declaration"] is False


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
