"""`houston.services.k8s.capabilities`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from servicehelpers import _completed
import pytest


def test_an_amd64_only_rocket_chat_is_refused_on_an_arm64_only_cluster():
    """`nodes_summary` has always READ the node architectures and its docstring has
    always said why they matter. The value went to one string on `doctor`'s screen and
    was never compared against anything.

    MEASURED with `docker manifest inspect` against registry.rocket.chat: 7.8.0, 7.9.0
    and 7.10.0 return a single `manifest.v2+json` — amd64 alone — while 8.0.0 and 8.5.1
    return a manifest list carrying amd64 and arm64.

    The irony is the point: the amd64-only range is precisely the range houston exists
    for, and a Graviton node group is an ordinary way to run EKS cheaply.
    """
    from houston.services import k8s

    arm = k8s.Preflight(cluster_reachable=True, architectures=["arm64"])
    said = k8s.architecture_blocker(arm, "6.5.0")
    assert said, "an amd64-only image on an arm64-only cluster cannot pull"
    assert "6.5.0" in said and "arm64" in said
    assert "Docker runtime" in said, "the refusal has to name the answer"

    # THE BOUNDARY, measured. 8.0.0 is the first multi-arch release; refusing it would
    # take away a version that works.
    assert not k8s.architecture_blocker(arm, "8.0.0")
    assert k8s.architecture_blocker(arm, "7.10.0")

    # ONE amd64 NODE IS ENOUGH. Kubernetes schedules it there, and pinning with a
    # nodeSelector would trade a fast, legible ErrImagePull for a silent Pending.
    mixed = k8s.Preflight(cluster_reachable=True, architectures=["amd64", "arm64"])
    assert not k8s.architecture_blocker(mixed, "6.5.0")

    # AND NOTHING IS INFERRED FROM WHAT WAS NOT READ. An unread architecture list is
    # not a mismatch, and an unreachable cluster is a different report's problem —
    # the same rule `storage_blocker` opens with.
    assert not k8s.architecture_blocker(
        k8s.Preflight(cluster_reachable=True, architectures=[]), "6.5.0")
    assert not k8s.architecture_blocker(
        k8s.Preflight(cluster_reachable=False, architectures=["arm64"]), "6.5.0")


def test_ensure_ingress_installs_the_guides_own_chart(monkeypatch):
    """`helm install traefik traefik/traefik -n traefik --create-namespace` is the
    official Rocket.Chat guide's own example, so a cluster houston filled in looks
    like a cluster somebody followed the guide on.

    And the chart's default Service type is LEFT ALONE. `helm show values` renders
    `type: LoadBalancer`; on a cluster with a provider it gets an address and the
    cluster owns :443, and on one without it stays `<pending>` while Kubernetes
    allocates NodePorts anyway. That is why no NodePort is configured anywhere --
    `ingress_endpoint` reads whichever exists.
    """
    import subprocess as sp

    from houston.services import k8s

    calls: list[list[str]] = []
    seen = {"n": 0}

    def classes(ctx):
        seen["n"] += 1
        return [] if seen["n"] == 1 else ["traefik"]

    monkeypatch.setattr(k8s.capabilities, "ingress_classes", classes)
    monkeypatch.setattr(k8s.release, "clear_pending_release", lambda *a, **kw: None)
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: calls.append(argv)
                        or sp.CompletedProcess(argv, 0, "", ""))
    assert k8s.ensure_ingress(context="c", distribution="k3s",
                              sleep=lambda s: None) == "traefik"
    helm = next(c for c in calls if "upgrade" in c)
    assert helm[:4] == ["helm", "upgrade", "--install", "traefik"], helm
    assert "traefik/traefik" in helm
    assert "--create-namespace" in helm
    assert not any(a.startswith("service.type") for a in helm), \
        "the chart's own Service type is what the guide gives; do not override it"
    # AND NO `--wait`, NOR THE ROLLBACK FLAG THAT IMPLIES IT. Helm's readiness check
    # for a LoadBalancer Service waits for an address to be populated, and this chart's
    # Service is a LoadBalancer -- so on a cluster with no provider `--wait` cannot
    # succeed on exactly the cluster being installed into. Measured on k3s with
    # `--disable servicelb`: "release traefik failed, and has been uninstalled due to
    # atomic being set: context deadline exceeded", five minutes after three healthy
    # pods. The controller is waited for with `rollout status` instead.
    assert "--wait" not in helm, helm
    assert "--atomic" not in helm and "--rollback-on-failure" not in helm, helm
    assert any(c[:2] == ["kubectl", "--context"] and "rollout" in c for c in calls), \
        "the controller still has to be waited for, just not through helm"


def test_ensure_ingress_waits_for_the_class_not_just_the_release(monkeypatch):
    """helm returning means the Deployment is ready. The IngressClass is a SEPARATE
    object the chart creates, so a create that went straight on to reading the classes
    would find none and refuse for want of the thing it had just installed."""
    import subprocess as sp

    from houston.services import k8s

    looks = {"n": 0}

    def classes(ctx):
        looks["n"] += 1
        return ["traefik"] if looks["n"] > 3 else []

    monkeypatch.setattr(k8s.capabilities, "ingress_classes", classes)
    monkeypatch.setattr(k8s.release, "clear_pending_release", lambda *a, **kw: None)
    monkeypatch.setattr(k8s.kube, "run",
                        lambda argv, **kw: sp.CompletedProcess(argv, 0, "", ""))
    assert k8s.ensure_ingress(context="c", distribution="kind",
                              sleep=lambda s: None) == "traefik"
    assert looks["n"] > 2, "it has to keep looking, not read once"


def test_ensure_ingress_refuses_a_read_it_could_not_make(monkeypatch):
    """The module's oldest rule at one more call site. Reading a refused list as "this
    cluster has no controller" would install one into a cluster that already had it,
    over a credential problem."""
    from houston.services import k8s

    monkeypatch.setattr(k8s.capabilities, "ingress_classes", lambda ctx: None)
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **kw: pytest.fail("must not install"))
    with pytest.raises(errors.DockerError) as exc:
        k8s.ensure_ingress(context="c", distribution="k3s")
    assert "refusing to guess" in str(exc.value)


def test_prepare_installs_a_storage_class_only_when_none_is_default(monkeypatch,
                                                                    tmp_path):
    """EKS ships `gp2` on the in-tree provisioner and marks nothing default, so the
    addon houston pins at Launchpad's version sits there referenced by nothing and
    every PVC would stay Pending.

    But a cluster that already HAS a default has been set up by somebody, and replacing
    their choice is not this command's business: `up` needs one to exist, and two
    defaults is an error state in Kubernetes anyway.
    """
    from houston.services import eks, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    applied: list = []
    monkeypatch.setattr(k8s.release, "apply",
                        lambda man, **kw: applied.append(man))
    monkeypatch.setattr(k8s.ingress, "ensure_ingress", lambda **kw: "traefik")
    monkeypatch.setattr(k8s.certmanager, "ensure_cert_manager", lambda **kw: None)
    # `prepare` WAITS for the address now — an ELB takes a minute or two to publish
    # one, so asking once made a blank CNAME target the normal outcome of a create.
    monkeypatch.setattr(k8s.endpoints, "wait_for_loadbalancer",
                        lambda ctx, **kw: ("traefik", "elb.aws"))
    monkeypatch.setattr(k8s.endpoints, "loadbalancer_state",
                        lambda ctx=None: ("traefik", "elb.aws", 0))

    # Nothing default: install, and with the CSI provisioner rather than the in-tree
    # one the cluster ships.
    # `prepare_cluster` resolves the context now, like every other cluster command --
    # `--context support` is the form the guide teaches and an ARN is what kubectl
    # needs. The double answers the resolver rather than the raw string.
    monkeypatch.setattr(k8s.context, "assert_context_known", lambda c: (c, ""))
    monkeypatch.setattr(k8s.capabilities, "storage_classes", lambda ctx: (["gp2"], ""))
    out = eks.prepare_cluster("arn:aws:eks:x")
    assert out["storage_class"] == "gp3"
    assert "ebs.csi.aws.com" in applied[0], "the in-tree provisioner is the one EKS ships"
    assert "is-default-class" in applied[0]
    assert "WaitForFirstConsumer" in applied[0], \
        "binding before the pod lands puts the volume in the wrong availability zone"
    assert out["cname_target"] == "elb.aws"

    # One already default: adopt it and touch nothing.
    applied.clear()
    monkeypatch.setattr(k8s.capabilities, "storage_classes", lambda ctx: (["gp2", "mine"], "mine"))
    out = eks.prepare_cluster("arn:aws:eks:x")
    assert out["storage_class"] == "mine" and applied == []
    assert "storage class 'mine'" in out["already"]

    # A refused read is not "none default" -- that would install a second default into
    # a cluster whose classes houston could not see.
    monkeypatch.setattr(k8s.capabilities, "storage_classes", lambda ctx: None)
    with pytest.raises(errors.PreflightError):
        eks.prepare_cluster("arn:aws:eks:x")


def test_a_refused_cluster_read_is_not_reported_as_a_cluster_with_nothing(monkeypatch):
    """`doctor` told somebody with a working default StorageClass, Traefik and one
    Ready node that they had none of the three, and gave it a green verdict.

    `reachable()` probes `/readyz`, which a restricted credential can usually still
    get -- so passing it is no evidence the actual reads will be permitted. Each of
    the three then read a permission denial as an absence, because `[]` was the
    answer for both "this cluster has none" and "I was not allowed to look".

    The wire shape is the nasty part and is measured, not imagined: a denied
    `get storageclass -o json` emits an EMPTY items document on stdout **and** exits
    1. A classifier that looked at the payload before the exit code would rebuild the
    bug inside the fix.
    """
    from houston.services import k8s

    denied = _completed(1, out='{"apiVersion":"v1","items":[],"kind":"List"}',
                        err='Error from server (Forbidden): storageclasses.storage.'
                            'k8s.io is forbidden: User "sa" cannot list resource')
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: denied)

    assert k8s.storage_classes("limited") is None, \
        "a forbidden read was reported as 'no StorageClass'"
    assert k8s.ingress_classes("limited") is None
    assert k8s.nodes_summary("limited") is None

    # And an empty cluster still answers empty -- the fix must not turn "none" into
    # "unknown", or every kind cluster would start warning about its absent ingress.
    empty = _completed(0, out='{"apiVersion":"v1","items":[],"kind":"List"}')
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: empty)
    assert k8s.storage_classes("kind") == ([], "")
    assert k8s.ingress_classes("kind") == []
    assert k8s.nodes_summary("kind") == (0, [])
