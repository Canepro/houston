"""The shared edge: one Traefik holding 443 for the whole box.

Pure-logic only -- no Docker, like the rest of the suite. The container-level
claims (two workspaces behind one edge, hot registration, no published
ports, reaching a host process over the bridge) were verified live against
traefik:v3.4 before this was written; what those runs proved is recorded in
docs/design/team-server.md §11.
"""

from __future__ import annotations
from edgehelpers import _doc, _doctor, _msgs, _resolve


def test_it_does_not_mount_the_docker_socket():
    """The file provider exists precisely so this is not needed."""
    vols = _doc()["services"]["edge"]["volumes"]
    assert not any("docker.sock" in v for v in vols)


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
    """Every service network reference names a declared Compose network.

    This is the exact project-level defect the old live-Docker test caught, without
    making the suite's result depend on whether Docker happens to be installed.
    """
    doc = _doc()
    declared = set(doc.get("networks", {}))
    for name, service in doc["services"].items():
        references = service.get("networks", {})
        assert set(references) <= declared, f"{name} refers to an undefined network"


def test_host_ports_are_overridable_but_container_ports_are_not():
    svc = _doc(http_port=8080, https_port=8443)["services"]["edge"]
    assert svc["ports"] == ["8080:80", "8443:443"]
    assert "--entryPoints.websecure.address=:443" in svc["command"]


def test_a_domain_workspace_claims_no_port_at_all(monkeypatch):
    """The entire point. It terminates no TLS, so there is nothing to conflict
    with -- which is what deletes the port-443 arbitration, the `--adopt` flag and
    the second-workspace refusal along with it."""
    spec = _resolve(monkeypatch)
    assert spec.port == 443, "the URL carries no port; the EDGE holds it"
    assert not hasattr(spec, "http_redirect"), "the edge redirects :80 once, for all"


def test_local_https_takes_the_same_path_as_a_real_domain(monkeypatch):
    """`--https` used to run its own Traefik on an allocated port, so ten of them
    ate ten ports and each got a different URL. Now every name answers on 443."""
    spec = _resolve(monkeypatch, https=True)
    assert spec.port == 443
    assert spec.host.endswith(".houston.localhost")


def test_doctor_says_nothing_about_a_edge_that_was_never_set_up(monkeypatch):
    """Most installs have none; rows about it would be noise."""
    assert "ront door" not in _msgs(_doctor(monkeypatch))


def test_the_edge_mounts_the_local_certificate_directory():
    """issue_local_cert() writes a declaration pointing at /etc/traefik/certs.
    Without the mount that path does not exist inside the container and Traefik
    quietly serves its OWN default certificate -- which looks exactly like a
    working setup until you read the issuer."""
    vols = _doc()["services"]["edge"]["volumes"]
    assert any(v.startswith("./certs:") for v in vols), vols
