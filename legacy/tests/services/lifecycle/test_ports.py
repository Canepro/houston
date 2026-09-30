"""`houston.services.lifecycle.ports`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from houston import errors
from houston.services import lifecycle as lc
import pytest


def test_pick_host_port_conflict(monkeypatch):
    class P:  # minimal preset stand-in
        instances = 1
    monkeypatch.setattr(lc.ports, "own_ports", lambda name: set())
    monkeypatch.setattr(lc.runner.ports, "used_ports", lambda: {8300})
    with pytest.raises(errors.ConflictError):
        lc.pick_host_port(8300, P(), exclude="")     # claimed by another repro


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

    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **_k: True)
    monkeypatch.setattr(lc.runner.paths, "exists", lambda _n: False)
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **k: None)
    monkeypatch.setattr(lc.ports, "check_sidecar_ports", lambda *a, **k: None)
    monkeypatch.setattr(lc.ports, "pick_host_port", lambda *a, **k: 3001)
    _real_resolve = lc.versions.resolve      # bind before patching, or it recurses
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: _real_resolve(v, offline=True))

    def fake_write(name, compose_yaml, meta, files=None):
        seen["meta"] = meta
        seen["yaml"] = compose_yaml
        return None

    monkeypatch.setattr(lc.runner.record, "write", fake_write)
    monkeypatch.setattr(lc.ready, "_up", lambda *a, **k: 0)

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
