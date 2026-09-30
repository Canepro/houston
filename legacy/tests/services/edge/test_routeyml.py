"""`houston.services.edge.routeyml`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from edgehelpers import _doc
from houston.errors import ValidationError
from houston.services import edge as fd
import pytest
import yaml


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


def test_a_passthrough_backend_must_carry_a_port():
    """Traefik loads a TCP router whose server has no port as a router with no
    reachable server: the name answers nothing and the reason appears only in the
    edge's own log. Refused where the value arrives instead."""
    with pytest.raises(ValidationError) as exc:
        fd.passthrough_route_yml("kws", "k.example.com", "172.16.0.2")
    assert "address" in str(exc.value) and "port" in str(exc.value)
    with pytest.raises(ValidationError):
        fd.passthrough_route_yml("kws", "k.example.com", "")


def test_it_can_reach_the_gui_which_is_a_host_process():
    """The GUI is uvicorn on the host, not a container, so it is not on the edge
    network and has no name there."""
    svc = _doc()["services"]["edge"]
    assert "host.docker.internal:host-gateway" in svc["extra_hosts"]
    assert "host.docker.internal" in fd.gui_route_yml(
        fd.Edge(domain="d", gui_port=7070))


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
