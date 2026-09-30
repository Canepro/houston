"""`houston.runner.ports`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import runner
from houston.services import lifecycle as lc
from servicehelpers import _dns_env, _req


def test_pick_port_bounded(monkeypatch):
    # Hosts where nothing can bind (sandboxes) must get a clean error, not an
    # OverflowError from scanning past 65535.
    monkeypatch.setattr(runner.ports, "port_free", lambda p, h="": False)
    monkeypatch.setattr(runner.ports, "used_ports", set)
    try:
        runner.pick_port()
    except RuntimeError as exc:
        assert "no free host port" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")
    try:
        runner.pick_port_range(3)
    except RuntimeError as exc:
        assert "consecutive" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_privileged_port_is_not_reported_busy_just_because_we_cannot_bind_it(monkeypatch):
    """443 is publishable even though an unprivileged process cannot bind it.

    The docker daemon runs as root, so `ports: 443:443` works fine. bind() as the
    calling user raises EACCES, and treating that as "in use" made
    `up --https --domain ...` refuse 443 on every non-root machine with nothing
    listening on it at all.
    """
    import socket
    from houston import runner

    real_socket = socket.socket

    class FakeSock:
        """Nothing is listening; bind() fails the way a privileged port does."""
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def settimeout(self, _t): pass
        def setsockopt(self, *a): pass
        def connect_ex(self, _addr): return 111          # ECONNREFUSED: no listener
        def bind(self, addr):
            if addr[1] < 1024:
                raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(socket, "socket", FakeSock)
    assert runner.port_free(443) is True
    assert runner.port_free(8443) is True

    # A real listener must still register as busy — the connect() probe catches it.
    class Listening(FakeSock):
        def connect_ex(self, _addr): return 0
    monkeypatch.setattr(socket, "socket", Listening)
    assert runner.port_free(443) is False
    assert runner.port_free(8443) is False

    # And a genuine EADDRINUSE on an unprivileged port is still busy.
    class InUse(FakeSock):
        def bind(self, addr): raise OSError(98, "Address already in use")
    monkeypatch.setattr(socket, "socket", InUse)
    assert runner.port_free(8443) is False
    socket.socket = real_socket


def test_staging_is_reachable_through_config_only(tmp_path, monkeypatch):
    """Not a flag on `up` -- but Let's Encrypt allows only 5 failed validations per
    hostname per hour, so a way to rehearse has to exist somewhere."""
    from houston import config as cfgmod
    from houston import runner
    from houston.cli import _CONFIG_KEYS
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner.ports, "port_free", lambda p, h="": True)
    assert "acme.staging" in _CONFIG_KEYS

    cfgmod.update_config(lambda c: c.__setitem__("acme_staging", True))
    spec = lc._resolve_tls(_req(domain="rc1.example.com", acme_email="a@b.c"), "x", "")
    assert spec.acme_staging is True


def test_tls_alpn_is_the_default_matching_the_official_compose(tmp_path, monkeypatch):
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner.ports, "port_free", lambda p, h="": True)
    spec = lc._resolve_tls(_req(domain="rc1.example.com", acme_email="a@b.c"), "x", "")
    assert spec.acme_challenge == "tlsalpn"


def test_dns01_is_selected_when_credentials_exist(tmp_path, monkeypatch):
    """The presence of the file IS the signal -- nobody creates it by accident.

    It is the only way to issue when Let's Encrypt cannot connect inbound: behind
    NAT, behind a tunnel, or behind a proxy that terminates TLS in front of you.
    """
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner.ports, "port_free", lambda p, h="": True)
    _dns_env(tmp_path)
    req = _req(domain="rc1.example.com", acme_email="a@b.c")
    spec = lc._resolve_tls(req, "x", "")
    assert spec.acme_challenge == "dns" and spec.acme_dns_provider == "cloudflare"
    # dns-01 never accepts an inbound connection, so the workspace must NOT be
    # widened to 0.0.0.0 -- these repros run admin/admin123.
    assert req.bind_public is False


def test_an_explicit_provider_overrides_inference(tmp_path, monkeypatch):
    from houston import config as cfgmod
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(runner.ports, "port_free", lambda p, h="": True)
    _dns_env(tmp_path, "SOME_UNKNOWN_THING=x\n")
    cfgmod.update_config(lambda c: c.__setitem__("acme_dns_provider", "exoscale"))
    spec = lc._resolve_tls(_req(domain="rc1.example.com", acme_email="a@b.c"), "x", "")
    assert spec.acme_challenge == "dns" and spec.acme_dns_provider == "exoscale"


def test_port_free_detects_loopback_listener():
    # Regression: repros bind 127.0.0.1:<port>, and a wildcard-bind probe with
    # SO_REUSEADDR can miss a loopback listener on macOS -> auto-pick collides.
    import socket
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    try:
        assert runner.port_free(port) is False   # something IS listening on loopback
    finally:
        srv.close()
