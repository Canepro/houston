"""Helpers the specs split out of `tests/test_edge.py` share, lifted whole.

Imported by name, the way these tests already import from `conftest`. The ones
that are CALLED need nothing more than that; a fixture, which is REQUESTED by
parameter name, is discovered in whatever module namespace it is imported into,
so it travels the same way and carries a `# noqa` where nothing reads the name.
Phase 02b requires the root `conftest.py` to stay as it is.
"""
from __future__ import annotations
from houston.services import edge as fd
import pytest


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


# --- what `up --domain` decides -------------------------------------------------

def _resolve(monkeypatch, *, running: bool = True, https: bool = False,
             emitted: list | None = None):
    from houston.services import lifecycle as lc

    monkeypatch.setattr(fd.engine, "running", lambda: running)
    monkeypatch.setattr(fd.acme, "issue_local_cert", lambda host: None)
    req = (lc.CreateReq(version="8.5.1", https=True) if https else
           lc.CreateReq(version="8.5.1", domain="t1.support.xyz.com",
                        acme_email="ops@xyz.com"))
    emit = (lambda ev: emitted.append(ev)) if emitted is not None else lc.null_emit
    return lc._resolve_tls(req, "alice-rc8-5-1", "127.0.0.1", emit=emit)


# --- doctor ---------------------------------------------------------------------

def _doctor(monkeypatch, *, running=True, meta=()):
    """run_checks() with the network probes stubbed out."""
    import requests

    from houston import runner
    from houston.services import doctor, lifecycle as lc

    monkeypatch.setattr(runner.host, "docker_available", lambda **_k: True)
    monkeypatch.setattr(runner.host, "docker_server_version", lambda: "29.0")
    monkeypatch.setattr(runner.host, "compose_version", lambda: "5.3.1")
    monkeypatch.setattr(runner.host, "docker_kernel_version", lambda: "6.1.0")
    monkeypatch.setattr(runner.host, "hub_logged_in", lambda: True)
    monkeypatch.setattr(runner.ports, "port_free", lambda p, h="": True)
    monkeypatch.setattr(runner.ports, "pick_port", lambda: 3000)
    monkeypatch.setattr(runner.record, "list_meta", lambda: list(meta))
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [])
    monkeypatch.setattr(requests, "get", lambda *a, **k: (_ for _ in ()).throw(
        requests.RequestException()))
    monkeypatch.setattr(fd.engine, "running", lambda: running)
    return doctor.run_checks()["checks"]


def _msgs(checks, status=None):
    return " | ".join(c["message"] for c in checks
                      if status is None or c["status"] == status)


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
