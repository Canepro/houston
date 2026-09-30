"""`houston.web.routes.edge`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from webhelpers import (
    _as, _auth, anon_client as anon_client, basic_client as basic_client
)

def test_edge_endpoint_reports_each_route_and_whether_it_is_reachable(
        basic_client, monkeypatch):
    """A route the edge cannot reach answers 502 rather than erroring -- the one
    failure nothing else in the UI would surface."""
    from houston.services import edge as edgesvc

    edgesvc.write(edgesvc.Edge(domain="gui.example.com", acme_email="o@e.com"))
    monkeypatch.setattr(edgesvc.engine, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    edgesvc.register("alice-rc8-5-1", "t1.example.com")
    edgesvc.register("bob-rc8-5-1", "t2.example.com")
    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    monkeypatch.setattr(edgesvc.networks, "attached_networks",
                        lambda: {edgesvc.workspace_network("alice-rc8-5-1")})

    body = basic_client.get("/api/edge",
                            headers=_auth("alice", "correct-horse-battery")).json()
    assert body["installed"] is True and body["running"] is True
    assert body["domain"] == "gui.example.com"
    by_name = {r["name"]: r for r in body["routes"]}
    assert by_name["alice-rc8-5-1"]["host"] == "t1.example.com"
    assert by_name["alice-rc8-5-1"]["reachable"] is True
    assert by_name["bob-rc8-5-1"]["reachable"] is False, "attached to neither"


def test_a_passthrough_route_is_not_reported_unreachable(basic_client, monkeypatch):
    """SEEN IN A BROWSER, against a name answering 200 from the public internet.

    `reachable` was `workspace_network(n) in attached` -- the right question for a
    route that names a CONTAINER, which the edge resolves over a shared Docker
    network. A passthrough route names an ADDRESS and there is no network to join, so
    the test could never be true and every Kubernetes workspace was reported broken.

    Three places read that one field, and all three were wrong: the header said
    "edge: 1 unreachable", the rail filed the workspace under "Wants you", and the
    detail panel said "The edge cannot reach this workspace ... the edge is not on
    this workspace's network" -- about a name that worked.
    """
    from houston.services import edge as edgesvc

    edgesvc.write(edgesvc.Edge(domain="gui.example.com", acme_email="o@e.com"))
    monkeypatch.setattr(edgesvc.engine, "_docker", lambda *a, **k: type(
        "P", (), {"returncode": 0, "stdout": ""})())
    edgesvc.register("composews", "t1.example.com")
    edgesvc.register("k8sws", "k1.example.com", passthrough="10.0.0.9:31855")
    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    # The edge is on the COMPOSE workspace's network and on nothing else -- which is
    # every Kubernetes workspace's normal, permanent state.
    monkeypatch.setattr(edgesvc.networks, "attached_networks",
                        lambda: {edgesvc.workspace_network("composews")})

    body = basic_client.get("/api/edge",
                            headers=_auth("alice", "correct-horse-battery")).json()
    by_name = {r["name"]: r for r in body["routes"]}
    assert by_name["composews"]["reachable"] is True
    assert by_name["composews"]["passthrough"] is False
    assert by_name["k8sws"]["passthrough"] is True
    assert by_name["k8sws"]["reachable"] is True, \
        "a passthrough has no network to be attached to; absence is not a fault"

    # And a container-backed route the edge really cannot reach is still reported.
    edgesvc.register("orphan", "t2.example.com")
    body = basic_client.get("/api/edge",
                            headers=_auth("alice", "correct-horse-battery")).json()
    assert {r["name"]: r["reachable"] for r in body["routes"]}["orphan"] is False


def test_edge_endpoint_says_so_when_there_is_none(basic_client):
    body = basic_client.get("/api/edge",
                            headers=_auth("alice", "correct-horse-battery")).json()
    assert body["installed"] is False and body["routes"] == []


def test_a_member_cannot_delete_a_name_from_the_shared_edge(basic_client):
    """A member creates and destroys their OWN workspaces; the box's shared front
    door is not theirs to edit -- and this one deletes a private key."""
    from houston.services import users as usersvc
    usersvc.add("bob", "bobs-good-password", role="member")
    _as(basic_client, "bob", "bobs-good-password")
    r = basic_client.delete("/api/edge/hosts/x.example.org?confirm=true",
                            headers=_auth())
    assert r.status_code == 403, r.text


def test_deleting_an_edge_name_without_confirm_is_a_400_not_a_deletion(basic_client,
                                                                      tmp_path):
    """`confirm` is a parameter, not an assumption. A request that forgets it must
    get told what it would have destroyed, not have it destroyed."""
    from houston.services import edge as edgesvc
    edgesvc.write(edgesvc.Edge(acme_email="ops@xyz.com"))
    edgesvc.register("x", "x.example.org", local=True)
    edgesvc.issue_local_cert("x.example.org")

    r = basic_client.delete("/api/edge/hosts/x.example.org", headers=_auth())
    assert r.status_code == 400, r.text
    assert "PRIVATE KEY" in r.json()["error"]
    assert (edgesvc.certs_dir() / "x.example.org.crt").is_file()

    r = basic_client.delete("/api/edge/hosts/x.example.org?confirm=true",
                            headers=_auth())
    assert r.status_code == 200, r.text
    assert r.json()["certificate"] is True
    assert not (edgesvc.certs_dir() / "x.example.org.crt").exists()


def test_a_refusal_from_the_edge_delete_becomes_its_status(basic_client):
    """The `ReproError` -> http_status contract, on the newest route."""
    from houston.services import edge as edgesvc
    edgesvc.write(edgesvc.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    r = basic_client.delete("/api/edge/hosts/support.xyz.com?confirm=true",
                            headers=_auth())
    assert r.status_code == 409, r.text          # ConflictError
    assert "GUI's own name" in r.json()["error"]


def test_the_edge_payload_names_certificates_with_no_route(basic_client):
    """The GUI cannot offer to delete what the payload does not mention, and an
    operator handed `serve` and no shell has no other way to see it."""
    import json as _json

    from houston import tls
    from houston.services import edge as edgesvc
    edgesvc.write(edgesvc.Edge(acme_email="ops@xyz.com"))
    edgesvc.register("live", "live.example.org", local=True)
    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    (tls.acme_dir() / tls.ACME_FILE).write_text(_json.dumps({"le": {"Certificates": [
        {"domain": {"main": "live.example.org", "sans": []}},
        {"domain": {"main": "orphan.example.org", "sans": []}},
    ]}}), encoding="utf-8")

    body = basic_client.get("/api/edge", headers=_auth()).json()
    assert body["stale_certs"] == ["orphan.example.org"], body["stale_certs"]
