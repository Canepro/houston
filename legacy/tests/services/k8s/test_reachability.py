"""`houston.services.k8s.reachability`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from servicehelpers import _aws_ready, _kube_probe_stubs
import pytest


# --- "I could not ask" has four answers, not two -------------------------------------

def test_reach_tells_a_refused_cluster_apart_from_a_dead_one(monkeypatch):
    """A cluster that answers and refuses is not a cluster that is down.

    `reachable()` returned a bool, so four different situations arrived at the caller
    as one fact and got one message: "is not answering". Three of those four are not
    about the cluster's health at all, and the advice that came with the bool sent the
    reader to check a cluster that was in perfect condition.

    Every string below was produced by a real `kubectl` on a real cluster during live
    EKS testing on 2026-09-02, which is why they are exact rather than representative.
    The two DENIED phrasings came from the SAME cluster the same afternoon -- `get
    --raw` produces the first, the discovery client the second -- so matching one of
    them is matching none of them half the time.
    """
    import types
    from houston.services import k8s

    cases = [
        ("error: You must be logged in to the server (Unauthorized)", k8s.REACH_DENIED),
        ("couldn't get current server API group list: the server has asked for the "
         "client to provide credentials", k8s.REACH_DENIED),
        ("Error from server (Forbidden): nodes is forbidden", k8s.REACH_DENIED),
        ("Error in configuration: context was not found for specified context: arn:x",
         k8s.REACH_NO_CONTEXT),
        ('error: context "x" does not exist', k8s.REACH_NO_CONTEXT),
        ("dial tcp 127.0.0.1:8080: connect: connection refused", k8s.REACH_DOWN),
        ("Unable to connect to the server: net/http: TLS handshake timeout",
         k8s.REACH_DOWN),
    ]
    for said, expected in cases:
        monkeypatch.setattr(k8s.kube, "run", lambda *a, _s=said, **kw: types.SimpleNamespace(
            returncode=1, stdout="", stderr=_s))
        got = k8s.reach("x")
        assert got.status == expected, f"{said!r} classified as {got.status}"
        assert not got.ok
        assert got.why(), "every non-ok answer must be able to say what it was"

    # And the healthy case is still healthy, through the bool the resolution order uses.
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **kw: types.SimpleNamespace(
        returncode=0, stdout="ok", stderr=""))
    assert k8s.reach("x").ok and k8s.reachable("x")


def test_isolation_is_derived_from_the_target_not_chosen_at_the_call_site(monkeypatch):
    """`own` is never passed by hand. Each function derives it from the context it
    is targeting, so forgetting it is not a thing that can happen -- and the
    discovery path deliberately stays ambient, because reading the cluster you
    already configured is the entire point of it."""
    from houston.services import k8s

    seen = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        seen.append((own, " ".join(argv)))
        return sp.CompletedProcess(argv, 0, "ok", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    k8s.reachable(k8s.CONTEXT)          # ours -> isolated
    k8s.reachable("k3s-default")        # theirs -> ambient
    assert seen[0][0] is True, "our own cluster must not use the ambient kubeconfig"
    assert seen[1][0] is False, "their cluster must be read from their kubeconfig"

    # And discovery of the active context is ambient by definition.
    seen.clear()
    k8s.active_context()
    assert seen[0][0] is False, "discovery must read the config the user set up"


def test_the_ledger_never_reports_a_zero_it_did_not_read(monkeypatch, tmp_path):
    """A ledger exists to stop a cluster being forgotten. The way it fails at that is
    by reporting an unreadable cluster as an empty one -- "0 workspaces, nothing
    costing you money" is precisely the sentence that lets a bill run.

    So every count is None when the read was REFUSED, never 0, and `unreadable` names
    which. This is `k8s.Answer`'s three-answer discipline applied to a screen instead
    of a delete, and the screen is where the mistake is quietest.
    """
    from houston.services import cluster, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The named context has to EXIST, because `status` refuses an unknown one the same
    # way `up --context` does -- a typo is a bad argument, not a cluster that is down.
    monkeypatch.setattr(k8s.context, "contexts", lambda: (["eks-support"], ""))
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, timeout=None: True)
    monkeypatch.setattr(k8s.reachability, "reach", lambda ctx=None, timeout=None: k8s.Reach(
        status=k8s.REACH_OK))
    monkeypatch.setattr(k8s.context, "distribution", lambda ctx: "eks")
    monkeypatch.setattr(k8s.operator, "operator_installed", lambda ctx: False)
    monkeypatch.setattr(k8s.monitoring, "monitoring_installed", lambda ctx: False)
    # Everything refuses: no nodes, no namespaces, no services.
    monkeypatch.setattr(k8s.ask, "ask_list",
                        lambda kind, **kw: k8s.Answer(state=k8s.REFUSED))
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx: None)

    out = cluster.status(context="eks-support")
    assert out["nodes"] is None and out["workspaces"] is None
    assert out["pvcs"] is None and out["loadbalancers"] is None
    assert set(out["unreadable"]) >= {"nodes", "workspaces", "loadbalancers"}
    for key in ("nodes", "workspaces", "pvcs", "loadbalancers"):
        assert out[key] != 0, f"{key} reported 0 for a read that was refused"

    # And an UNREACHABLE cluster reports nothing at all rather than an empty one.
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, timeout=None: False)
    monkeypatch.setattr(k8s.reachability, "reach", lambda ctx=None, timeout=None: k8s.Reach(
        status=k8s.REACH_DOWN))
    out = cluster.status(context="eks-support")
    assert out["reachable"] is False and "cluster" in out["unreadable"]
    assert out["workspaces"] is None and out["loadbalancers"] is None


def test_a_cluster_that_refuses_is_not_reported_as_one_that_is_down(monkeypatch):
    """The three places a person READS the answer must name which of the four it was.

    Measured, three times in one day of live testing against a real EKS cluster:
    `cluster status` told an engineer to check an ACTIVE cluster that was merely
    refusing their credential; `cluster delete` said an ACTIVE cluster "is not
    answering" when the real cause was a fresh HOUSTON_HOME with no kubeconfig entry
    for it; and `plan_cluster` offered three guesses at a cause it had not read.
    """
    from houston.services import cluster as clustersvc
    from houston.services import eks, k8s

    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    # The kubeconfig is STATED, not read: this box's real one is whatever the last
    # live test left in it, and a unit test that reads it passes or fails by accident.
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([ARN], ""))

    # 1. the ledger -- and the counts below it stay unknown, not zero.
    monkeypatch.setattr(k8s.reachability, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_DENIED))
    monkeypatch.setattr(k8s.names, "is_ours", lambda ctx: False)
    report = clustersvc.status(ARN)
    assert report["reachable"] is False
    assert report["reach_status"] == k8s.REACH_DENIED
    assert "refused these credentials" in report["reach_why"]
    assert "create-access-entry" in report["reach_advice"], \
        "the advice must point at the access entry, not at the cluster's health"
    assert report["nodes"] is None and report["workspaces"] is None, \
        "a refused read must still leave every count unknown rather than zero"

    # 2. plan_cluster's refusal.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default",
                      reachable=False, reach_status=k8s.REACH_NO_CONTEXT)
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([ARN], ""))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.plan_cluster(context=ARN)
    assert "no kubeconfig entry" in str(exc.value), \
        "a context this box has never heard of is not a statement about the cluster"
    assert "update-kubeconfig" in str(exc.value), \
        "and for an EKS arn the advice is the command that writes one"

    # 3. the delete guard still REFUSES -- it just says which kind of unreadable.
    _aws_ready(monkeypatch)
    monkeypatch.setattr(eks.aws, "owns_cluster",
                        lambda n, r: k8s.Answer(state=k8s.PRESENT, doc={"arn": ARN}))
    monkeypatch.setattr(k8s.reachability, "reach",
                        lambda ctx=None, timeout=None: k8s.Reach(status=k8s.REACH_DENIED))
    with pytest.raises(errors.PreflightError) as exc:
        eks.delete_cluster("s", region="us-east-1")
    assert "not an empty one" in str(exc.value), "the refusal itself must not weaken"
    assert "refused these credentials" in str(exc.value)


def test_a_cluster_houston_can_no_longer_remove_says_so(monkeypatch, tmp_path):
    """Uninstalling the kind BINARY does not remove the cluster it built.

    The containers keep running, the API server keeps answering, and 675 MiB stays
    held -- while `delete_cluster`, `cluster_reclaimable` and `prune` all open with
    `if not which("kind"): return False`, so every control that would take it away
    answers "there was nothing to delete" rather than "I cannot delete it".

    That is the same conflation this module exists to prevent, applied to a control
    instead of a count: reporting nothing where the honest answer is "I cannot" is how
    a thing gets forgotten. Reported live by somebody who uninstalled kind and could
    not understand why the ledger still listed the cluster -- it was right to, and it
    could not say the one thing that had actually changed.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    OURS = "kind-houston-local"
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([OURS], ""))
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: True)
    monkeypatch.setattr(k8s.cluster, "ensure_kubeconfig", lambda plan, emit=None: OURS)
    monkeypatch.setattr(k8s.reachability, "reach", lambda *a, **k: k8s.Reach(status=k8s.REACH_OK))
    monkeypatch.setattr(k8s.context, "distribution", lambda c: "kind")
    monkeypatch.setattr(k8s.ask, "ask_list", lambda kind, **kw: k8s.Answer(state=k8s.REFUSED))
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda c: [])
    monkeypatch.setattr(k8s.operator, "operator_installed", lambda c: False)
    monkeypatch.setattr(k8s.monitoring, "monitoring_installed", lambda c: False)

    monkeypatch.setattr(k8s.tools, "which", lambda t: "" if t == "kind" else "/usr/bin/" + t)
    stuck = clustersvc.status(OURS)
    assert stuck["reachable"] is True, "the cluster is still up — that is the point"
    assert stuck["manageable"] is False
    assert "no longer remove it" in stuck["unmanageable_why"]
    assert "docker rm -f" in stuck["unmanageable_why"], \
        "and it must give the way out that does not need the missing binary"

    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/" + t)
    fine = clustersvc.status(OURS)
    assert fine["manageable"] is True and fine["unmanageable_why"] == "", \
        "with kind installed there is nothing to warn about"

    # A cluster that is NOT houston's was never houston's to remove, so kind being
    # absent says nothing about it.
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s.tools, "which", lambda t: "" if t == "kind" else "/usr/bin/" + t)
    theirs = clustersvc.status(OURS)
    assert theirs["manageable"] is True


def test_a_cluster_of_ours_that_is_gone_stops_being_listed_but_a_running_one_does_not(
        monkeypatch, tmp_path):
    """Three cases, and only the middle one is new.

    houston writes its OWN kubeconfig when it builds its own cluster and never
    removes that entry. So a cluster deleted outside houston -- or one whose `kind`
    was uninstalled and whose container was then removed by hand -- left a context for
    something that does not exist, on every screen, for ever, unusable and impossible
    to clear. Reported from a real machine.

    Dropping it whenever `kind` is missing would be the wrong fix and `plan_cluster`
    says why: doing that once made a RUNNING cluster invisible, "containers holding
    memory that nothing in houston could see or remove". So the question is whether
    the cluster is there, not whether the binary is.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    OURS = "kind-houston-local"
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([OURS, "default"], ""))
    monkeypatch.setattr(k8s.context, "cluster_context", lambda: OURS)
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: c == OURS)

    def listed(kind_installed, answers):
        monkeypatch.setattr(k8s.tools, "which",
                            lambda t: "/usr/bin/kind" if kind_installed else "")
        monkeypatch.setattr(k8s.reachability, "reach", lambda *a, **k: k8s.Reach(
            status=k8s.REACH_OK if answers else k8s.REACH_DOWN))
        return [r["context"] for r in clustersvc.known_contexts()["contexts"]]

    # 1. kind installed: listed whatever it is doing -- houston can rebuild it.
    assert OURS in listed(kind_installed=True, answers=False)

    # 2. kind gone but the cluster is UP: still listed. It is real, it holds memory,
    #    and hiding it is the failure this rule is written around.
    assert OURS in listed(kind_installed=False, answers=True)

    # 3. kind gone and the cluster does not answer: a stale entry for a thing that is
    #    not there. Dropped -- it can be neither used, rebuilt, nor reclaimed.
    left = listed(kind_installed=False, answers=False)
    assert OURS not in left
    assert "default" in left, "and it must not take anybody else's cluster with it"


def test_the_phantom_rule_never_touches_a_cluster_that_is_not_ours(monkeypatch, tmp_path):
    """An adopted k3s or EKS context that is down is somebody else's business.

    houston did not write those entries and removing them from a report would be
    hiding the operator's own kubeconfig from them -- and an EKS cluster that is not
    answering is exactly the one they most need to see, because it is still billing.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([ARN, "default"], ""))
    monkeypatch.setattr(k8s.context, "cluster_context", lambda: "")   # we built nothing
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s.tools, "which", lambda t: "")
    monkeypatch.setattr(k8s.reachability, "reach", lambda *a, **k: k8s.Reach(status=k8s.REACH_DOWN))

    listed = [r["context"] for r in clustersvc.known_contexts()["contexts"]]
    assert listed == [ARN, "default"], \
        "a billing cluster that is not answering is the one you most need to see"
