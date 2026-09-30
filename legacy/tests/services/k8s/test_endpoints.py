"""`houston.services.k8s.endpoints`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston.services import lifecycle as lc
from servicehelpers import _k8s_svc_json, _lb, _svc, _svc_reader


def test_prepare_waits_for_the_load_balancer_address_it_is_asked_for(monkeypatch):
    """`cluster prepare` runs immediately after a twenty-minute `cluster create`.

    An ELB commonly takes one to three minutes to publish a hostname, so asking once
    made a blank CNAME target the NORMAL outcome of a successful create — on the one
    line an operator needs in order to finish the job.

    And a blank has two causes that need opposite next actions: "still coming" (prepare
    again in a minute) and "nothing is waiting for an address" (re-running will never
    help, because this cluster has no load-balancing ingress). Nothing in the result
    distinguished them, so the CLI advised re-running in both cases.
    """
    from houston.services import k8s

    # Pending for two ticks, then an address.
    seq = [("", "", 1), ("", "", 1), ("traefik", "a.elb.aws", 0)]
    monkeypatch.setattr(k8s.endpoints, "loadbalancer_state", lambda ctx=None: seq.pop(0))
    said: list = []
    slept: list = []
    got = k8s.wait_for_loadbalancer("c", emit=lambda e: said.append(e.message),
                                    sleep=slept.append)
    assert got == ("traefik", "a.elb.aws")
    assert len(slept) == 2, "it must actually wait rather than spin"
    assert len([m for m in said if "waiting for" in m]) == 1, \
        "one line, not one per tick — the log is read by a person"

    # NOTHING PENDING: answered on the first read, with no sleeping at all. Spending
    # three minutes proving a cluster has no ingress is the slowest possible way to
    # say so.
    monkeypatch.setattr(k8s.endpoints, "loadbalancer_state", lambda ctx=None: ("", "", 0))
    slept.clear()
    assert k8s.wait_for_loadbalancer("c", sleep=slept.append) == ("", "")
    assert slept == [], "there was nothing to wait for"


def _a_cluster_holding_the_edges_port(monkeypatch, tmp_path):
    """A cluster whose ingress has DNATed the port the shared edge wants."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    chosen = k8s.Preflight(tools={
        n: k8s.Tool(name=n, path=f"/usr/bin/{n}", version=(9, 9, 9), raw="v9.9.9")
        for n in ("kubectl", "helm")})
    # NOT reachable, deliberately: houston's own cluster does not exist yet, which is
    # the state the box was in when this fired for real. The check used to live inside
    # the reachable-cluster block, so on exactly that box it never ran.
    chosen.context = k8s.CONTEXT
    chosen.distribution = "kind"
    chosen.cluster_reachable = False
    chosen.will_create = True
    monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **k: chosen)
    monkeypatch.setattr(k8s.context, "active_context", lambda: "default")
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, **kw: True)
    monkeypatch.setattr(k8s.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(k8s.endpoints, "loadbalancer_service",
                        lambda ctx: ("traefik", "172.16.0.2") if ctx == "default" else ("", ""))
    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", lambda ctx: False)
    monkeypatch.setattr(k8s.endpoints, "host_port_claim",
                        lambda ctx, **kw: k8s.PortClaim(
                            context=ctx, service="kube-system/traefik",
                            address="172.16.0.2", ports=[80, 443])
                        if ctx == "default" else None)

    from houston.services import edge as edgesvc
    monkeypatch.setattr(edgesvc.spec, "installed", lambda: True)
    monkeypatch.setattr(edgesvc.routes, "registered", lambda: [])
    monkeypatch.setattr(edgesvc.spec, "current",
                        lambda: type("E", (), {"domain": "gui.example.test"})())

    rows = doctor.run_checks()["checks"]
    hit = [r for r in rows if r.get("check") == "kubernetes-edge-port"]
    return doctor, edgesvc, hit, rows


def test_doctor_reports_the_cluster_that_took_the_edge_s_port(monkeypatch, tmp_path):
    """Silent until now, and it breaks a working setup. k3s's ServiceLB claims host
    :80/:443 with a hostPort -- CNI portmap DNAT, not a socket bind -- so nothing errors,
    no pod fails, and kube-proxy's KUBE-SERVICES chain gets the packet before Docker's.
    Measured on this box: the edge's own GUI name answered 404 through the host and 502
    direct to the edge, with nothing connecting the two.

    The cluster that does it need not be the one houston is USING. On the box where this
    was measured it was not: houston had chosen kind, which has no LoadBalancer, while
    the k3s alongside it held the port."""
    doctor, edgesvc, hit, rows = _a_cluster_holding_the_edges_port(monkeypatch, tmp_path)
    assert hit, [r["message"][:60] for r in rows]
    assert hit[0]["status"] == "warn", hit[0]
    assert "'default'" in hit[0]["message"], "name the cluster that took it"
    assert "172.16.0.2" in hit[0]["message"], "and the address"
    # The GUI's own name is what breaks, and counting workspace routes alone reported
    # "0 names" about a real outage.
    assert "gui.example.test" in hit[0]["message"], hit[0]["message"]

    # No edge, no conflict: the cluster holding the port is then simply how it works.
    monkeypatch.setattr(edgesvc.spec, "installed", lambda: False)
    assert not [r for r in doctor.run_checks()["checks"]
                if r.get("check") == "kubernetes-edge-port"]

    # The capability facts -- cert-manager among them -- belong to a cluster that
    # ANSWERS, and there is none here. They are covered where a reachable one is stubbed;
    # asserting them in this test is what tied the port check to reachability originally.
    assert not [r for r in doctor.run_checks()["checks"]
                if r.get("check") == "kubernetes-cert-manager"], \
        "described a cluster that is not there"


def test_the_ingress_endpoint_is_the_service_reachable_from_outside(monkeypatch):
    """Publishing :443 is not enough to be an ingress, and the first real cluster said so.

    Asked on this box's k3s, THREE Services publish 443 -- `default/kubernetes` (the
    API server), `kube-system/metrics-server` and `kube-system/traefik` -- and only
    the last is the ingress. Both others are ClusterIP, which is not merely unrouted
    from outside but unroutable: a virtual IP realised by kube-proxy's netfilter
    rules on the node. So a ClusterIP cannot be a front door whatever port it
    publishes, and reachability is what separates them.

    Found by the ambiguity guard firing on a healthy cluster, which is the guard
    doing its job -- the alternative was picking the API server and passing a
    workspace's TLS through to it.
    """
    from houston.services import k8s

    _svc_reader(monkeypatch, [
        _svc("default", "kubernetes", "ClusterIP"),
        _svc("kube-system", "metrics-server", "ClusterIP"),
        _svc("kube-system", "traefik", "LoadBalancer", node_port=31123,
             address="172.16.0.2"),
    ])
    monkeypatch.setattr(k8s.endpoints, "is_local_address", lambda ip: ip == "172.16.0.2")
    ep = k8s.ingress_endpoint("default")
    assert (ep.address, ep.port) == ("172.16.0.2", 443), ep
    assert ep.source == "loadbalancer" and ep.service == "kube-system/traefik", ep
    assert ep.local is True, "k3s's ServiceLB address IS one of this host's own"
    assert str(ep) == "172.16.0.2:443", "the shape a passthrough route needs"


def test_a_nodeport_is_a_real_endpoint_and_not_a_degraded_one(monkeypatch):
    """`k8s-https.md` §2 calls NodePort "a fallback for a cluster with no
    LoadBalancer address at all -- not the k3s path", and then its own acceptance
    test ran through one, because it had to.

    Every LoadBalancer Service carries a nodePort anyway, so this is an answer rather
    than a consolation -- and it is THE answer on a cluster whose ingress has been
    moved off the host ports, which is exactly what `doctor` tells a k3s user to do
    when the cluster is taking :443 from the edge.
    """
    from houston.services import k8s

    _svc_reader(monkeypatch, [
        _svc("kube-system", "traefik", "NodePort", node_port=31123),
    ])
    monkeypatch.setattr(k8s.endpoints, "is_local_address", lambda ip: True)
    ep = k8s.ingress_endpoint("default")
    assert (ep.address, ep.port) == ("172.16.0.2", 31123), ep
    assert ep.source == "nodeport", ep


def test_a_cluster_with_no_reachable_ingress_answers_none(monkeypatch):
    """Absence, asserted by the cluster, is a fact and safe to act on -- as distinct
    from the refused read above. kind ships no ingress controller at all."""
    from houston.services import k8s

    _svc_reader(monkeypatch, [_svc("default", "kubernetes", "ClusterIP")])
    assert k8s.ingress_endpoint("default") is None


def test_services_are_asked_for_across_every_namespace(monkeypatch):
    """`-A`, and it must come AFTER the subcommand.

    Without it kubectl reads the CURRENT namespace, so the ingress -- which lives in
    `kube-system` -- is invisible and the cluster reads as having none: an empty,
    exit-0, entirely believable wrong answer. And `--all-namespaces` belongs to `get`
    rather than being global, so placed before it kubectl answers "flags cannot be
    placed before plugin name: --context". Both were live bugs, in that order.
    """
    from houston.services import k8s

    seen = _svc_reader(monkeypatch, [
        _svc("kube-system", "traefik", "LoadBalancer", address="10.0.0.9")])
    k8s.ingress_endpoint("default")
    argv = seen[0]
    assert "-A" in argv, argv
    assert argv.index("-A") > argv.index("get"), \
        "kubectl refuses --all-namespaces placed before the subcommand"


def test_the_edge_joins_a_kind_clusters_docker_network(monkeypatch):
    """A kind cluster's ingress is unreachable from where the edge lives.

    kind's node is a CONTAINER on kind's own Docker network, so its ingress NodePort
    answers from the host and not from a container on the default bridge. Measured:
    `172.18.0.2:30925` reachable from the host and from a container on the `kind`
    network, **unreachable** from one on `bridge` -- which is exactly where the edge
    is. `k8s-https.md` §4's fifth finding, and the one part of it that is genuinely
    kind-specific.

    `edge.attach` could not do this: it derives a network from a WORKSPACE name, and a
    cluster is not a workspace.
    """
    from houston.services import edge as edgesvc
    from houston.services import k8s

    # The derivation is pure -- no Docker in k8s.py, which owns no such seam.
    assert k8s.kind_node_container("kind-houston-local") == \
        "houston-local-control-plane"
    assert k8s.kind_node_container("default") == "", "k3s has no node container"
    assert k8s.kind_node_container("kind-") == ""

    joined: list[str] = []
    monkeypatch.setattr(edgesvc.spec, "installed", lambda: True)
    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    monkeypatch.setattr(edgesvc.routes, "register", lambda *a, **kw: False)
    monkeypatch.setattr(edgesvc.networks, "container_network",
                        lambda c: "kind" if c == "houston-local-control-plane" else "")
    monkeypatch.setattr(edgesvc.networks, "attach_network",
                        lambda n: joined.append(n) or True)

    ep = k8s.IngressEndpoint("172.18.0.2", 30925, "nodeport",
                             "ingress-nginx/ingress-nginx-controller", False)
    lc._route_kubernetes_name("ws", lc._KubeTls(
        host="a.example.com", ingress_class="nginx", endpoint=ep,
        context="kind-houston-local", cluster_owns_443=False))
    assert joined == ["kind"], "the edge must join the network the node is on"

    # And a k3s cluster has nothing to join: its endpoint is on the host itself.
    joined.clear()
    lc._route_kubernetes_name("ws", lc._KubeTls(
        host="a.example.com", ingress_class="traefik",
        endpoint=k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                     "kube-system/traefik", True),
        context="default", cluster_owns_443=False))
    assert joined == [], "joining a network k3s does not have would only fail"


def test_doctor_says_which_https_shape_the_box_is_in(monkeypatch, tmp_path):
    """One row that answers "can this box serve a name, and how".

    Every fact in it is reported somewhere above -- the ingress class, the load
    balancer, the edge, the port claim -- and reading four rows and composing them is
    exactly what nobody does at the moment they need the answer. Which of the two
    shapes the box is in is the fact every HTTPS question turns on: the cluster owning
    :443 and answering directly, or the edge owning it and passing the name through.
    """
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    pre = k8s.Preflight(context="default", cluster_reachable=True,
                        cluster_exists=True, ingress_classes=["traefik"],
                        distribution="k3s", provider=k8s.PROVIDER_EXTERNAL,
                        default_storage_class="local-path",
                        tools={n: k8s.Tool(name=n, version=(1, 36), path="/x")
                               for n in k8s.CORE_TOOLS})
    monkeypatch.setattr(k8s.probe, "preflight", lambda ctx="": pre)
    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", lambda ctx: True)
    monkeypatch.setattr(k8s.endpoints, "port_claiming_cluster", lambda **kw: None)

    def shape(ep):
        monkeypatch.setattr(k8s.endpoints, "ingress_endpoint", lambda ctx, **kw: ep)
        rows = [r for r in doctor.run_checks()["checks"]
                if r.get("check") == "kubernetes-https"]
        assert rows, "the row must always be emitted for a reachable cluster"
        return rows[0]["message"]

    # The cluster owns :443 -- answered directly, no edge in the path.
    said = shape(k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                     "kube-system/traefik", True))
    assert "CLUSTER's own ingress" in said, said
    assert "directly" in said, said

    # The edge owns it -- the name is passed through to a NodePort.
    said = shape(k8s.IngressEndpoint("172.16.0.2", 32492, "nodeport",
                                     "kube-system/traefik", True))
    assert "edge" in said and "passed through by SNI" in said, said
    assert "32492" in said, "name the endpoint, so it can be dialled by hand"

    # Nothing reachable: say what it would take, not that something is broken.
    said = shape(None)
    assert "not servable yet" in said, said

    # AND IT MUST NOT PROMISE A CERT-MANAGER SECRET WHEN THERE IS NO CERT-MANAGER.
    # This row sat directly under one saying cert-manager was not installed, and
    # described what WOULD happen as though it already did.
    monkeypatch.setattr(k8s.certmanager, "cert_manager_installed", lambda ctx: False)
    said = shape(k8s.IngressEndpoint("172.16.0.2", 443, "loadbalancer",
                                     "kube-system/traefik", True))
    assert "once cert-manager is installed" in said, said
    assert "from a cert-manager Secret" not in said, said


def test_host_port_claim_reads_the_ports_the_service_actually_asks_for(monkeypatch):
    """The ports are the diagnosis, and nothing read them.

    A cluster holding :443 breaks serving and the TLS-ALPN challenge; one holding
    :80 breaks HTTP-01 and the redirect. The detection only ever asked whether a
    LoadBalancer had a local address, so it reported ":443" whatever it found --
    including on a box configured for `acme.challenge http`, where :80 was the port
    that mattered and the report named the wrong one.
    """
    import subprocess

    from houston.services import k8s

    doc = _k8s_svc_json(
        # Skipped: a ClusterIP takes no host port however it is addressed.
        _lb("kubernetes", "default", "10.43.0.1", [443], kind="ClusterIP"),
        # Skipped: a LoadBalancer nobody answered for holds nothing.
        _lb("pending", "apps", "", [80]),
        # Skipped: an address this host does not hold is somebody else's problem.
        _lb("elsewhere", "apps", "203.0.113.9", [80, 443]),
        _lb("traefik", "kube-system", "172.16.0.2", [80, 443]),
    )
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: subprocess.CompletedProcess(
        args=a, returncode=0, stdout=doc, stderr=""))
    monkeypatch.setattr(k8s.endpoints, "is_local_address", lambda ip: ip == "172.16.0.2")

    claim = k8s.host_port_claim("default")
    assert claim is not None, "the local LoadBalancer must be found"
    assert claim.ports == [80, 443], claim
    assert claim.service == "kube-system/traefik", "say WHICH service, so it can be patched"
    assert claim.address == "172.16.0.2"

    # Only :80. This is the case the old check called ":443".
    only80 = _k8s_svc_json(_lb("traefik", "kube-system", "172.16.0.2", [80]))
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: subprocess.CompletedProcess(
        args=a, returncode=0, stdout=only80, stderr=""))
    assert k8s.host_port_claim("default").ports == [80]

    # A port set that does not overlap the edge's is not a conflict at all.
    monkeypatch.setattr(k8s.endpoints, "host_port_claim",
                        lambda ctx, **kw: k8s.PortClaim(context=ctx, service="a/b",
                                                        address="172.16.0.2", ports=[8080]))
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, **kw: True)
    monkeypatch.setattr(k8s.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(k8s.context, "active_context", lambda: "default")
    assert k8s.port_claiming_cluster() is None, "8080 is not the edge's port"


def _a_managed_cluster_with_its_own_ingress(monkeypatch):
    """A cloud cluster that publishes its own address, so this box's edge is irrelevant."""
    from houston import tls as tlsmod
    from houston.services import k8s
    from houston.services import lifecycle as lc

    HOST = "t1.rc.example.com"

    def decide(*, endpoint_local, claim_ports):
        said: list = []
        monkeypatch.setattr(k8s.probe, "preflight",
                            lambda ctx=None: k8s.Preflight(distribution="eks"))
        monkeypatch.setattr(k8s.certmanager, "ensure_cert_manager", lambda **kw: None)
        monkeypatch.setattr(k8s.ingress, "ensure_ingress", lambda **kw: "traefik")
        addr = "172.16.0.2" if endpoint_local else "a1b2.elb.amazonaws.com"
        monkeypatch.setattr(k8s.endpoints, "ingress_endpoint", lambda ctx, **kw: k8s.IngressEndpoint(
            address=addr, port=443, source="loadbalancer",
            service="traefik/traefik", local=endpoint_local))
        monkeypatch.setattr(k8s.endpoints, "host_port_claim", lambda ctx: (
            k8s.PortClaim(context="ctx", address="172.16.0.2",
                          ports=list(claim_ports),
                          service="traefik/traefik") if claim_ports else None))
        req = lc.CreateReq(version="8.5.1", name="t", runtime="kubernetes",
                           domain=HOST, acme_email="a@b.c")
        tlsspec = tlsmod.TlsSpec(mode=tlsmod.MODE_ACME, host=HOST,
                                 acme_email="a@b.c")
        plan = k8s.ClusterPlan(context="ctx", distribution="eks", create=False)
        out = lc._kubernetes_tls_plan(req, tlsspec, plan,
                                      emit=lambda e: said.append(e.message))
        return out, said

    # A MANAGED CLUSTER: its ingress is elsewhere, so the cluster owns the name and no
    # edge is involved. This is the case that could not create a workspace at all.
    out, said = decide(endpoint_local=False, claim_ports=())
    return decide, out, said


def test_a_managed_clusters_name_is_not_routed_through_this_machines_edge(monkeypatch):
    """The edge on this laptop cannot front a load balancer in AWS.

    `host_port_claim` asks whether the cluster holds THIS HOST's ports, which for any
    managed cluster is definitionally no -- so `cluster_owns_443` came out false and
    the plan fell through to the shared edge. That is not merely wasteful. The
    workspace's name resolves to the cluster's own load balancer, so no packet for it
    ever arrives on this machine; the edge could not serve it however it were set up.

    MEASURED against a real EKS cluster: `up --domain houston-test-1.kestron.org`
    announced "the http-01 challenge arrives on the edge's :80", went to start an edge
    it had no use for, and refused the entire create because a different
    HOUSTON_HOME on the box already owned one. A shared support server -- several
    people, one machine, one cluster in AWS -- is exactly the arrangement this feature
    exists for, and it could not create a workspace there at all.
    """
    decide, out, said = _a_managed_cluster_with_its_own_ingress(monkeypatch)
    assert out.cluster_owns_443 is True, \
        "a remote load balancer cannot be fronted by this machine's edge"
    assert any("not in the path" in m for m in said), \
        "and the operator must be told where the challenge actually goes"
    assert not any("edge's :80" in m for m in said), \
        "it must stop announcing an edge that cannot be reached"

    # A LOCAL cluster holding this host's :443 is unchanged -- it always owned it.
    out, _ = decide(endpoint_local=True, claim_ports=(80, 443))
    assert out.cluster_owns_443 is True

    # A LOCAL cluster that does NOT hold :443 still goes through the edge, which is
    # the whole reason the edge exists and must not have been broken by this.
    out, said = decide(endpoint_local=True, claim_ports=())
    assert out.cluster_owns_443 is False, \
        "a local cluster with no host claim still needs the edge in front of it"
    assert any("edge's :80" in m for m in said)


def test_prepare_resolves_a_short_cluster_name_like_every_other_cluster_command(
        monkeypatch, tmp_path):
    """`--context support` is the form `cluster create` prints in its own closing line
    and the form the shipped guide teaches. An EKS context is really
    `arn:aws:eks:<region>:<account>:cluster/support`, which nobody types.

    MEASURED on a freshly built cluster: `houston cluster prepare --context support`
    failed in 0.27 seconds — far too fast to have asked AWS anything — with "could not
    read the StorageClasses in 'support' ... This is a permissions problem on the
    credential in your kubeconfig". A confident and completely wrong diagnosis that
    sends somebody to fix IAM, when the context simply had not been expanded.

    `cluster status` had resolved short names all along; `prepare` passed the raw
    argument straight to kubectl. Two commands in the same group disagreeing about
    what a cluster may be called is the kind of thing only a live run finds.
    """
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    seen: dict = {}

    def resolve(name):
        seen["asked"] = name
        return (ARN, "") if name in ("support", ARN) else (name, "")

    monkeypatch.setattr(k8s.context, "assert_context_known", resolve)
    # Everything below answers only for the RESOLVED name, exactly as a kubeconfig
    # does: the short name is not a context and kubectl refuses it.
    monkeypatch.setattr(k8s.capabilities, "storage_classes",
                        lambda ctx: (["gp2", "gp3"], "gp3") if ctx == ARN else None)
    monkeypatch.setattr(k8s.ingress, "ensure_ingress", lambda **kw: "traefik")
    monkeypatch.setattr(k8s.certmanager, "ensure_cert_manager", lambda **kw: None)
    monkeypatch.setattr(k8s.endpoints, "wait_for_loadbalancer", lambda ctx, **kw: ("t", "elb.aws"))
    monkeypatch.setattr(k8s.endpoints, "loadbalancer_state", lambda ctx=None: ("t", "elb.aws", 0))

    out = eks.prepare_cluster("support")
    assert seen["asked"] == "support", "the short name has to reach the resolver"
    assert out["context"] == ARN, "and the result must report the context it used"
    assert out["storage_class"] == "gp3"
    assert out["cname_target"] == "elb.aws", \
        "the CNAME target is the one line an operator needs to finish the job"


def test_edge_start_does_not_claim_success_while_a_cluster_holds_the_ports(
        tmp_path, monkeypatch):
    """`edge start` printed "every registered name is served again" about a box that
    served none of them.

    The edge really does start: k3s's ServiceLB claims host ports by CNI portmap DNAT,
    not by binding, so compose succeeds, the container binds :80 and :443, and every
    packet is taken by kube-proxy before Docker sees it. This message was the last
    thing a manager's install said before two days of the GUI being dark, and it said
    the opposite of the truth.
    """
    import subprocess

    from typer.testing import CliRunner

    from houston import cli
    from houston.services import edge as edgesvc, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    edgesvc.write(edgesvc.Edge())
    monkeypatch.setattr(edgesvc.runtime, "up", lambda **k: subprocess.CompletedProcess(
        args=[], returncode=0, stdout="", stderr=""))
    monkeypatch.setattr(k8s.endpoints, "port_claiming_cluster",
                        lambda *a, **k: k8s.PortClaim(
                            context="default", service="kube-system/traefik",
                            address="172.31.46.139", ports=[80, 443]))

    out = CliRunner().invoke(cli.app, ["edge", "start"]).output or ""
    assert "every registered name is served again" not in out, out
    assert "NOT reachable" in out, out
    assert "'default'" in out and "172.31.46.139" in out, out
    assert "NodePort" in out, "hand over the command that gives the ports back"
    assert "--disable servicelb" in out, "and how to stop it recurring"

    # With nothing holding the ports the message is the plain success it always was.
    monkeypatch.setattr(k8s.endpoints, "port_claiming_cluster", lambda *a, **k: None)
    plain = CliRunner().invoke(cli.app, ["edge", "start"]).output or ""
    assert "every registered name is served again" in plain, plain
    assert "NOT reachable" not in plain, plain
