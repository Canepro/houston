"""`houston.services.lifecycle.tlsplan`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import call_order
from houston import errors
from houston.services import lifecycle as lc
from servicehelpers import _kube_tls_env, _local_spec
import pytest


def test_a_loopback_name_is_not_reached_by_a_cluster_on_a_host_address():
    """`_name_reaches` on its own, because the decision above turns on it.

    The real resolver, no stubs: `*.houston.localhost` is loopback by construction
    and a ServiceLB address is not, which is the pairing that produced a 404 from a
    URL the create had just printed as ready.
    """
    import types

    claim = types.SimpleNamespace(address="172.16.0.2", ports=[80, 443])
    assert lc._name_reaches("ws.houston.localhost", claim) is False
    assert lc._name_reaches("localhost", claim) is False
    # Unresolvable is NOT a mismatch: a `--domain` whose DNS has not propagated is
    # the normal state of a name being set up, and must not be moved off the cluster
    # for a reason that stops being true in minutes.
    assert lc._name_reaches("no-such-host.invalid", claim) is True
    # A claim with no address cannot be reached by anything.
    assert lc._name_reaches("localhost", types.SimpleNamespace(address="")) is False


def test_https_on_kubernetes_installs_an_ingress_when_the_cluster_has_none(monkeypatch):
    """Adopt what is there, install what is not -- and the order is the point.

    The ingress controller is the component a support case is usually about, so a
    cluster already running nginx keeps running nginx. Installing is only for a cluster
    that has NONE: k3s with `--disable traefik`, a bare kubeadm, or houston's own
    fresh kind cluster, where `--https` used to be a dead end.

    This replaced a blanket refusal, and with it the `plan.create` refusal: a cluster
    that does not exist yet is now created and filled in rather than turned away.
    """
    from houston import tls as tlsmod
    from houston.services import k8s

    # Already has one: the plan uses that class.
    plan = _kube_tls_env(monkeypatch, ingress=("traefik",))
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), plan)
    assert ktls.ingress_class == "traefik"

    # Had none: the plan must use what was INSTALLED, not what the earlier probe saw.
    # Reading `pre.ingress_classes` after an install finds nothing -- the class is a
    # separate object that appears a moment behind the release.
    plan = _kube_tls_env(monkeypatch, ingress=(), ingress_class="nginx")
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), plan)
    assert ktls.ingress_class == "nginx"

    # A cluster that does not exist yet is created, not refused. `ensure_kubeconfig` is
    # what makes it, and the plan then probes the cluster it just brought up.
    made: list = []
    monkeypatch.setattr(k8s.cluster, "ensure_kubeconfig",
                        lambda plan, emit=None: made.append(plan.context) or "default")
    unmade = k8s.ClusterPlan(context="default", distribution="kind", create=True)
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), unmade)
    assert made == ["default"], "the cluster has to exist before it can be asked"
    assert ktls.ingress_class == "nginx"

    # cert-manager is no longer a refusal either: the guide lists it as a prerequisite
    # AND gives the command, so houston runs the documented step. Requiring it by hand
    # while installing the ingress automatically was an inconsistency with no reason.
    acme = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host="a.example.com", port=443,
                          acme_email="ops@example.com")
    nocm = _kube_tls_env(monkeypatch, cert_manager=False)
    made: list[str] = []
    monkeypatch.setattr(k8s.certmanager, "ensure_cert_manager",
                        lambda **kw: made.append(kw["context"]))
    lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", domain="a.example.com"),
                            acme, nocm)
    assert made == ["default"], "cert-manager is installed, not demanded"


def test_the_https_plan_reports_whether_the_cluster_already_owns_443(monkeypatch):
    """Two topologies, both normal, and they need different things.

    k3s's ServiceLB claims host :80/:443 by hostPort DNAT, so the name reaches the
    cluster's ingress with no edge involved. Anywhere else the edge must own :443 and
    pass the name through. Measured rather than assumed, because getting it wrong
    either requires an edge that is not needed or omits one that is.
    """
    # THE CLAIM HAS TO BE TRUE FOR THIS NAME. Holding host :443 is not the same as
    # being where the workspace's hostname points, and this asserted only the first:
    # k3s ServiceLB claims 172.16.0.2 while `<name>.houston.localhost` resolves to
    # loopback, klipper's DNAT is IPv4-only, and the EDGE answers there -- so the
    # https URL houston printed returned 404. Both directions are pinned now.
    plan = _kube_tls_env(monkeypatch, claims=(80, 443))
    monkeypatch.setattr(lc.tlsplan, "_name_reaches", lambda host, claim: True)
    ktls = lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), plan)
    assert ktls.cluster_owns_443 is True
    assert ktls.ingress_class == "traefik"
    assert str(ktls.endpoint) == "172.16.0.2:443"

    # Same claim, but the name does not resolve to the ingress: through the edge.
    plan = _kube_tls_env(monkeypatch, claims=(80, 443))
    monkeypatch.setattr(lc.tlsplan, "_name_reaches", lambda host, claim: False)
    assert lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                   _local_spec(), plan).cluster_owns_443 is False, \
        "a name that resolves elsewhere is not served by the cluster, claim or no claim"

    plan = _kube_tls_env(monkeypatch, claims=())
    assert lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                    _local_spec(), plan).cluster_owns_443 is False


def test_routing_a_name_starts_the_edge_only_when_the_cluster_does_not_own_443(monkeypatch):
    """Two topologies, and one of them needs no edge at all.

    With k3s's ServiceLB holding host :80/:443 the name reaches the cluster's ingress
    directly -- starting an edge would take the port away from the thing already
    serving it. Anywhere else the edge must own :443 and pass the name through.
    """
    from houston.services import edge as edgesvc
    from houston.services import k8s

    ep = k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer", "kube-system/traefik",
                             True)
    starts: list[str] = []
    monkeypatch.setattr(edgesvc.engine, "running", lambda: False)
    monkeypatch.setattr(edgesvc.spec, "installed", lambda: False)
    monkeypatch.setattr(edgesvc.runtime, "ensure_running",
                        lambda **kw: starts.append("started") or edgesvc.StartResult(True))
    monkeypatch.setattr(edgesvc.routes, "register", lambda *a, **kw: False)

    lc._route_kubernetes_name("ws", lc._KubeTls(
        host="a.example.com", ingress_class="traefik", endpoint=ep,
        cluster_owns_443=True))
    assert starts == [], "the cluster already answers on :443; do not take the port"

    lc._route_kubernetes_name("ws", lc._KubeTls(
        host="a.example.com", ingress_class="traefik", endpoint=ep,
        cluster_owns_443=False))
    assert starts == ["started"], "nothing else holds :443, so the edge must"


def test_nothing_is_installed_before_every_read_only_refusal_has_passed(monkeypatch):
    """A refusal must leave nothing behind, and this one left an ingress controller.

    Measured on a fresh kind box: the create built the cluster, installed
    traefik/traefik into it, and THEN refused for want of cert-manager. Every check
    that can be answered by reading has to come first, so the one step that changes
    the cluster is the last thing before it is committed to.
    """

    # THROUGH THE STEPS: the plan is an orchestrator over named steps now, and the
    # ordering this asserts runs across three of them.
    local, cm, ing, ep = call_order(
        lc.tlsplan._kubernetes_tls_plan, "is_local_cluster", "ensure_cert_manager",
        "ensure_ingress", "ingress_endpoint", through=lc.tlsplan)
    assert local < cm, "refuse a remote cluster before creating anything in it"
    assert cm < ing, "cert-manager first — the ingress annotation names its issuer"
    assert ing < ep, "the endpoint is the Service the ingress install created"

    # And a refusal really does happen without touching the cluster: `--https` on a
    # cluster that is not on this machine would send the CA key there.
    from houston.services import k8s

    plan = _kube_tls_env(monkeypatch, distribution="eks", ingress=())
    monkeypatch.setattr(k8s.certmanager, "ensure_cert_manager",
                        lambda **kw: pytest.fail("must not install"))
    monkeypatch.setattr(k8s.ingress, "ensure_ingress",
                        lambda **kw: pytest.fail("must not install"))
    with pytest.raises(errors.AuthorityGateError):
        lc._kubernetes_tls_plan(lc.CreateReq(version="8.5.1", https="local"),
                                _local_spec(), plan)


def test_a_default_certificate_before_issuance_is_not_blamed_on_a_proxy(monkeypatch):
    """An ingress controller serves its OWN default certificate for a name it has no
    certificate for yet — so while cert-manager works through the ACME order, the
    cluster answers with exactly the certificate this check used to blame on
    "something in front is terminating TLS".

    OBSERVED through the GUI on a first workspace on a cold EKS cluster: the image
    pull ate the certificate window, the wait expired, and the create finished by
    sending the reader to `doctor` to look for a port conflict on their own machine
    that did not exist. The certificate arrived about a minute later.

    `certificate_ready` was computed by `create_workspace` all along and thrown away.
    It is the whole difference between "not issued yet" and "issued, and somebody else
    is answering for this name".
    """
    from houston.services import lifecycle as lcmod
    from houston import tls as tlsmod

    ktls = lcmod._KubeTls(host="x.example.com", ingress_class="traefik",
                          endpoint=None, context="c", issuer=None)
    monkeypatch.setattr(tlsmod, "verify", lambda *a, **kw: {
        "serving": True, "fallback": True, "issuer": "CN = TRAEFIK DEFAULT CERT"})

    # NOT ISSUED YET: the ordinary case, and it must read as one.
    said: list = []
    lcmod._publish_kubernetes_name("w", ktls, cert_ready=False,
                                   emit=lambda e: said.append(e.message),
                                   sleep=lambda _s: None)
    joined = " ".join(said)
    assert "has not issued one yet" in joined, said
    assert "something in front" not in joined, \
        "a certificate that is still coming is not a proxy stealing the name"
    assert "houston doctor" not in joined, \
        "and it must not send somebody hunting a port conflict that does not exist"

    # ISSUED, and the name still answers with somebody else's default certificate.
    # Now the alarming reading is the correct one.
    said.clear()
    lcmod._publish_kubernetes_name("w", ktls, cert_ready=True,
                                   emit=lambda e: said.append(e.message),
                                   sleep=lambda _s: None)
    joined = " ".join(said)
    assert "something in front is terminating TLS" in joined, said
    assert "houston doctor" in joined, said


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
    monkeypatch.setattr(edgesvc.spec, "installed", lambda: True)
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
