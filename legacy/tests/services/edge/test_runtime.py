"""`houston.services.edge.runtime`: its own spec file.

Co-located out of `tests/test_edge.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from edgehelpers import _acme_workspace, _ok_compose, _write_acme
from houston.errors import ValidationError
from houston.services import edge as fd
import pytest


def test_resolving_tls_never_starts_a_container(tmp_path, monkeypatch):
    """A resolve function that starts docker made the TEST SUITE stand up a real
    edge holding :443, which then broke a live run on the same box. Docker work
    belongs in the create path."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.services import lifecycle as lc

    def boom(*a, **k):
        raise AssertionError("_resolve_tls started a container")

    monkeypatch.setattr(fd.runtime, "ensure_running", boom)
    monkeypatch.setattr(fd.runtime, "up", boom)
    req = lc.CreateReq(version="8.5.1", domain="t1.example.com", acme_email="o@e.com")
    lc._resolve_tls(req, "w", "127.0.0.1")


def test_ensure_running_writes_a_bare_config_when_there_is_none(tmp_path, monkeypatch):
    """The lazy start itself: `up --https` on a box with no configuration at all
    has to produce a working edge. (That it is CALLED from the create path, and
    not from _resolve_tls, is pinned by test_resolving_tls_never_starts_a_container
    above; the container-level start is verified live, not here.)"""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(fd.engine, "running", lambda: False)
    monkeypatch.setattr(fd.runtime, "up", lambda pull=True: _ok_compose())
    assert fd.ensure_running()
    assert fd.installed(), "a bare edge config must have been written"
    assert not fd.route_path("_gui").exists(), "and no broken GUI route with it"


def test_one_workspace_that_will_not_move_does_not_block_the_others(tmp_path, monkeypatch):
    """Nor the edge: whatever still holds the port is named by port_holder()."""
    _acme_workspace("good", "t1.example.com", tmp_path)
    _acme_workspace("bad", "t2.example.com", tmp_path)
    monkeypatch.setattr(fd.engine, "running", lambda: False)
    monkeypatch.setattr(fd.engine, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    monkeypatch.setattr(fd.runtime, "up", lambda pull=True: _ok_compose())

    real = fd.adopt

    def flaky(name):
        if name == "bad":
            raise ValidationError("nope")
        return real(name)

    monkeypatch.setattr(fd.runtime, "adopt", flaky)
    assert fd.ensure_running()
    assert fd.registered() == ["good"]


def test_a_stopped_edge_is_not_started_just_to_delete(tmp_path, monkeypatch):
    """Nothing can write the entry back while it is stopped, and starting it would
    claim :443 as a side effect of a deletion."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    _write_acme()
    monkeypatch.setattr(fd.engine, "foreign_edge", lambda: "")
    monkeypatch.setattr(fd.engine, "running", lambda: False)
    monkeypatch.setattr(fd.runtime, "up", lambda pull=True: pytest.fail("must not start"))
    assert fd.delete_host("gone.example.org", confirm=True)["foreign"] == ""
    assert fd.delete_host("gone.example.org", confirm=True)["restarted"] is None
