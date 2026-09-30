"""`houston.services.edge.routes`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston.services import edge as fd


# --- registration on disk -------------------------------------------------------

def test_register_and_deregister_only_touch_their_own_route():
    fd.register("alice", "a.example.com")
    fd.register("bob", "b.example.com")
    assert fd.registered() == ["alice", "bob"]

    fd.deregister("bob")
    assert fd.registered() == ["alice"]
    assert fd.route_path("alice").is_file(), "a neighbour must survive"


def test_registering_twice_replaces_rather_than_duplicates():
    fd.register("alice", "old.example.com")
    fd.register("alice", "new.example.com")
    assert fd.registered() == ["alice"]
    assert "new.example.com" in fd.route_path("alice").read_text()


def test_the_two_kinds_of_route_are_told_apart_on_disk():
    """Read from the route FILE, because the caller that needs to know is looking at
    routes rather than at workspaces -- a route outlives its workspace, which is the
    whole reason `deregister` exists."""
    fd.register("compose", "c.example.com")
    fd.register("kube", "k.example.com", passthrough="172.16.0.2:443")
    assert fd.is_passthrough("kube") is True
    assert fd.is_passthrough("compose") is False
    assert fd.is_passthrough("never-registered") is False


def test_restarting_the_edge_does_not_report_a_kubernetes_route_as_broken(monkeypatch):
    """`reattach_all` joins each routed workspace's Docker network, because
    recreating the edge loses runtime attachments while the route files survive.

    A Kubernetes workspace has no Docker network and no compose project, so attaching
    one can only fail -- and reporting that failure would name a perfectly healthy
    workspace as unreachable on every single `edge start`.
    """
    fd.register("compose", "c.example.com")
    fd.register("kube", "k.example.com", passthrough="172.16.0.2:443")
    tried: list[str] = []

    def _attach(name):
        tried.append(name)
        return False                    # as `docker network connect` would, for both

    monkeypatch.setattr(fd.networks, "attach", _attach)
    failed = fd.reattach_all()
    assert tried == ["compose"], "it tried to join a network Kubernetes does not have"
    assert failed == ["compose"], failed


def test_two_workspaces_cannot_claim_the_same_hostname():
    """Ports have been guarded since long before names were, and names needed it more.

    A route file is keyed by WORKSPACE NAME, so two workspaces given the same
    `--domain` each write their own file claiming the same `Host()`. Traefik then
    picks one and the other silently never answers -- the failure this module's own
    docstring warns about one layer down, in the same words: it "looks stable under
    testing and would silently serve the wrong workspace forever".

    Found by running a scenario matrix on one box: THREE route files all claiming
    `HostSNI(rc-rpro-test.kestron.org)`, two pointing at NodePorts that no longer
    existed. Traefik chose a dead one, so the name returned EOF, cert-manager's
    self check failed, and the certificate never issued -- for a chain that was
    otherwise entirely correct. It cost an hour to find because every individual
    component was right.
    """
    fd.register("alice", "shared.example.com")
    assert fd.route_host("alice") == "shared.example.com"
    assert fd.host_owner("shared.example.com") == "alice"
    # Case-insensitively, because DNS is.
    assert fd.host_owner("SHARED.example.com") == "alice"
    # A workspace may always re-claim its OWN name -- that is every `up` after a
    # `down`, and refusing it would break bringing a workspace back.
    assert fd.host_owner("shared.example.com", excluding="alice") == ""
    # A passthrough route counts too: it is HostSNI rather than Host, and the whole
    # point is that both kinds share one entrypoint.
    fd.register("kube", "k.example.com", passthrough="10.0.0.1:443")
    assert fd.route_host("kube") == "k.example.com"
    assert fd.host_owner("k.example.com") == "kube"
    assert fd.host_owner("nobody.example.com") == ""


def test_a_passthrough_route_is_not_reported_unreachable(tmp_path, monkeypatch):
    """`edge status` computed reachability as Docker-network membership, and a
    PASSTHROUGH route joins no workspace network -- so every Kubernetes workspace
    was listed `NO (502)`.

    Measured in production conditions on EC2: a workspace answering HTTP 200 from
    the internet on a real Let's Encrypt certificate, reported unreachable by the
    command whose job is to say whether it is reachable. `/api/edge` had already
    learned this; the CLI had not, which is the same two-front-ends drift as the
    `Host(` / `HostSNI(` parser.
    """
    from houston.services import edge as edgesvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(edgesvc.routes, "is_passthrough", lambda n: n == "kube")
    monkeypatch.setattr(edgesvc.networks, "workspace_network",
                        lambda n: f"houston-{n}_default")

    # A passthrough forwards raw TCP to a NodePort; there is no network to join.
    assert edgesvc.route_reachable("kube", set()) is True
    # An HTTP route still needs the edge to have joined its network.
    assert edgesvc.route_reachable("cmp", set()) is False
    assert edgesvc.route_reachable("cmp", {"houston-cmp_default"}) is True


def test_deregistering_an_unknown_workspace_is_not_an_error():
    """Teardown must be idempotent: `down` may run after a failed create that
    never registered anything."""
    fd.deregister("never-existed")


def test_the_guis_own_route_is_not_listed_as_a_workspace():
    fd.write(fd.Edge(domain="support.xyz.com", acme_email="ops@xyz.com"))
    fd.register("alice", "a.example.com")
    assert fd.registered() == ["alice"]


def test_registering_a_passthrough_asks_for_no_certificate():
    """`register` returns "this name needs a certificate of its own", and the caller
    counts that against Let's Encrypt's weekly limit. A passthrough name presents no
    certificate at the edge at all, so counting it would spend budget on nothing."""
    assert fd.register("kws", "kws.example.com",
                       passthrough="172.16.0.2:443") is False
    assert fd.registered() == ["kws"]
    assert not (fd.certs_dir() / "kws.example.com.crt").exists(), \
        "no local certificate is issued for a name the edge does not terminate"


def test_delete_host_finds_every_route_claiming_the_name(tmp_path):
    """The collision that cost an hour was THREE files on one host. Removing one
    would leave the name still claimed and still broken."""
    fd.write(fd.Edge(acme_email="ops@xyz.com"))
    for n in ("a", "b", "c"):
        fd.register(n, "dupe.example.org", passthrough="10.0.0.5:31443")

    assert fd.routes_for("dupe.example.org") == ["a", "b", "c"]
    gone = fd.delete_host("dupe.example.org", confirm=True, restart=False)
    assert gone["routes"] == ["a", "b", "c"]
    assert fd.registered() == []
