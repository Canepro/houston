"""`houston.services.k8s.context`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_of
from houston import errors
from houston.services import lifecycle as lc
from servicehelpers import _kube_probe_stubs
import pytest
import subprocess


def test_a_cluster_can_be_named_by_the_name_people_actually_call_it(monkeypatch):
    """`--context support`, not the forty-eight character ARN, every single time.

    `aws eks update-kubeconfig` writes the cluster ARN as the context name, so the
    daily command was `--context arn:aws:eks:us-east-1:533674205877:cluster/support`
    for a workspace that lives for an afternoon. Nobody types that; they paste it, and
    pasting the wrong one is the failure this whole feature guards against everywhere
    else.
    """
    from houston.services import k8s

    A = "arn:aws:eks:us-east-1:1:cluster/support"
    B = "arn:aws:eks:eu-west-1:1:cluster/perf"
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([A, B, "default"], ""))

    assert k8s.assert_context_known("support")[0] == A, "the short name resolves"
    assert k8s.assert_context_known(A)[0] == A, "the full name still works"
    assert k8s.assert_context_known("default")[0] == "default", "so do short contexts"
    assert k8s.assert_context_known("perf")[0] == B

    with pytest.raises(errors.ValidationError) as exc:
        k8s.assert_context_known("nope")
    assert "no kubeconfig context named" in str(exc.value), \
        "an unknown name is still a typo, not a resolution"


def test_the_same_cluster_name_in_two_places_refuses_instead_of_picking_one(monkeypatch):
    """`support` in us-east-1 and `support` in eu-west-1 are different clusters.

    Silently taking the first is how somebody deletes the wrong one. This module
    refuses and names both, the way every other ambiguous-destructive decision here
    does.
    """
    from houston.services import k8s

    A = "arn:aws:eks:us-east-1:1:cluster/support"
    B = "arn:aws:eks:eu-west-1:1:cluster/support"
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([A, B], ""))

    with pytest.raises(errors.ValidationError) as exc:
        k8s.assert_context_known("support")
    said = str(exc.value)
    assert "more than one" in said
    assert A in said and B in said, "the refusal must name both, or it cannot be acted on"
    # And each full name still reaches exactly the one it names.
    assert k8s.assert_context_known(A)[0] == A
    assert k8s.assert_context_known(B)[0] == B


def test_an_unreadable_kubeconfig_still_does_not_turn_a_real_name_into_a_typo(monkeypatch):
    """The rule the short-name path must not break: "I could not ask" is not "absent"."""
    from houston.services import k8s

    monkeypatch.setattr(k8s.context, "contexts", lambda: ([], "permission denied"))
    resolved, why = k8s.assert_context_known("support")
    assert resolved == "support", "it is passed through untouched, not refused"
    assert why == "permission denied"


def test_an_interrupted_kubernetes_create_still_leaves_a_record(monkeypatch, tmp_path):
    """Killed part-way through, a create must leave something `down` can find.

    `create_workspace` builds the namespace, MongoDB, the release, the scenario's
    manifests and the port-forward -- minutes of work -- and the record used to be
    written only after it returned. Stopping `serve` with a create job still running
    does exactly that, and it was reported from real use: a full microservices
    workspace with twelve pods left running and INVISIBLE, because `list`, `info`
    and `down` all begin at the state directory and there was nothing in it.

    Compose never had this. It writes the record first and starts containers after,
    so an interrupted create is still listed and still removable. This is the same
    guarantee for the other runtime.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # The namespace-ownership preflight talks to the cluster and lives OUTSIDE
    # `create_workspace`, so stubbing that one is no longer enough to keep a test
    # off a real kubectl. Refusing to guess is the point of it, so it is stubbed
    # rather than softened.
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s.context, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s.cluster, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s.reachability, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s.namespace, "assert_namespace_available", lambda *a, **kw: None)
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc.runner.ports, "pick_port", lambda *a, **kw: 3999, raising=False)

    # The kill, at the worst possible moment: everything built, nothing recorded.
    def die(**kw):
        raise KeyboardInterrupt("serve shut down mid-create")
    monkeypatch.setattr(k8s.workspace, "create_workspace", die)

    req = lc.CreateReq(version="8.5.1", name="interrupted", runtime="kubernetes",
                       deployment="microservices")
    with pytest.raises(BaseException):
        lc.create_repro(req)

    assert lc.runner.exists("interrupted"), (
        "the workspace was left running with no record at all -- nothing in "
        "houston could see it, let alone remove it")
    meta = lc.runner.read_meta("interrupted")
    assert topology.of_meta(meta) == topology.KUBERNETES
    assert meta.extra.get("namespace") == k8s.namespace_for("interrupted"), \
        "teardown selects on the namespace, so it has to be recorded"
    assert meta.extra.get("incomplete") is True, \
        "and it must be distinguishable from a create that finished"


def test_a_url_is_only_printed_once_the_forward_is_confirmed_alive(monkeypatch, tmp_path):
    """A port-forward that dies on spawn leaves a URL that looks like an address and
    answers nothing -- which sends someone to debug Rocket.Chat when the forward is
    what failed. Observed twice on live runs before this.

    So the URL is confirmed, not assumed, and a dead forward hands over the command
    that establishes one instead of a promise.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    said: list = []
    monkeypatch.setattr(k8s.time, "sleep", lambda _s: None)
    # THE CLUSTER IS A DOUBLE, not this developer's kubeconfig. `create_workspace`
    # calls `plan_cluster()` when given no plan, and that reads the real
    # `~/.kube/config` -- so these passed only on a box whose current-context
    # happened to name a REACHABLE cluster, and failed the moment one was deleted
    # or the box had none. A unit test must not depend on that.
    monkeypatch.setattr(k8s.context, "plan_cluster",
                        lambda context="": k8s.ClusterPlan(
                            context=k8s.CONTEXT, distribution="kind", create=False))
    # And the export it would do for that plan: `ensure_kubeconfig` reaches for the
    # kind binary, which is not what any of these tests are about.
    monkeypatch.setattr(k8s.cluster, "ensure_kubeconfig", lambda plan, **kw: plan.context)
    # And the adopted-cluster helm preflight, for the same reason: it asks the real
    # cluster whether helm can reach it. "" means it can.
    monkeypatch.setattr(k8s.reachability, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s.cluster, "ensure_cluster", lambda **k: k8s.CONTEXT)
    monkeypatch.setattr(k8s.chart, "ensure_repo", lambda **k: None)
    monkeypatch.setattr(k8s.chart, "resolve_chart_version", lambda *a, **k: "7.0.2")
    monkeypatch.setattr(k8s.probe, "preflight",
                        lambda *a, **k: k8s.Preflight(cluster_reachable=True,
                                                      default_storage_class="s"))
    monkeypatch.setattr(k8s.namespace, "ensure_namespace", lambda n, **k: f"houston-{n}")
    monkeypatch.setattr(k8s.release, "apply", lambda *a, **k: None)
    monkeypatch.setattr(k8s.replicaset, "init_replica_set", lambda **k: None)
    monkeypatch.setattr(k8s.operator, "ensure_operator", lambda **k: None)
    monkeypatch.setattr(k8s.operator, "wait_for_mongodb", lambda **k: None)
    monkeypatch.setattr(k8s.release, "install", lambda **k: None)
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    monkeypatch.setattr(k8s.forward, "port_forward", lambda *a, **k: 999999999)  # dead pid
    resolved = type("R", (), {"rc_version": "8.6.1", "mongo_tag": "8.0",
                              "rc_image": "img", "oplog": False})()

    out = k8s.create_workspace(name="k", resolved=resolved, host_port=3010,
                               microservices=False,
                               emit=lambda e: said.append(e.message))
    assert out["port_forward_pid"] == 0, "a dead forward must not be recorded as live"
    assert not any(m.strip() == "http://localhost:3010" for m in said), \
        "it printed a URL it had not confirmed"
    assert any("port-forward" in m and "kubectl" in m for m in said), said


# --- the engine floor -----------------------------------------------------------

def test_a_kubernetes_create_is_refused_when_the_ENGINE_is_too_small(monkeypatch):
    """The host and the container engine are different machines on macOS and on
    Podman, and the capacity check only ever asked the host. A laptop with 32 GB and
    a 4 GB VM passed everything and then could not run a Kubernetes workspace -- the
    failure arriving minutes later as pods stuck Pending, which names nothing."""
    from houston.services import k8s
    monkeypatch.setattr(k8s.context, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context=k8s.CONTEXT, distribution="kind", create=True))
    monkeypatch.setattr(lc.runner.host, "docker_capacity", lambda: (2.0, 3 * 1024 ** 3))
    with pytest.raises(errors.PreflightError) as caught:
        lc.check_capacity(lc.CreateReq(version="8.5.1", runtime="kubernetes"))
    said = str(caught.value)
    assert "2 CPUs" in said and "3.0 GiB" in said
    assert "podman machine set" in said, "a refusal has to say how to fix it"

    # Compose runs two containers and works on that VM: a floor there would refuse
    # creates that succeed today.
    monkeypatch.setattr(lc.runner.host, "host_memory", lambda: (16000, 12000, 0))
    lc.check_capacity(lc.CreateReq(version="8.5.1"))


def test_force_downgrades_the_engine_floor_to_a_warning(monkeypatch):
    events = []
    from houston.services import k8s
    monkeypatch.setattr(k8s.context, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context=k8s.CONTEXT, distribution="kind", create=True))
    monkeypatch.setattr(lc.runner.host, "docker_capacity", lambda: (1.0, 1 * 1024 ** 3))
    monkeypatch.setattr(lc.runner.host, "host_memory", lambda: (16000, 12000, 0))
    lc.check_capacity(lc.CreateReq(version="8.5.1", runtime="kubernetes", force=True),
                      emit=events.append)
    assert any("below the Kubernetes floor" in e.message for e in events)


def test_doctor_is_told_which_cluster_is_not_answering(monkeypatch):
    """`preflight` dropped the reason with the exception.

    `plan_cluster` raises both for "no kind and no kubeconfig" and for "kubectl is
    pointed at 'X', which is not answering" -- and `except PreflightError: plan =
    None` left `context` empty for both. So doctor fell through to "No Kubernetes
    cluster configured, install kind or point kubectl at an existing cluster" for
    somebody whose cluster IS configured and whose credentials are what need fixing,
    sending them to configure a second one.
    """
    from houston.errors import PreflightError
    from houston.services import k8s

    monkeypatch.setattr(k8s.context, "plan_cluster", lambda *_a, **_k: (_ for _ in ()).throw(
        PreflightError("kubectl is pointed at 'my-prod', which is not answering")))
    monkeypatch.setattr(k8s.context, "active_context", lambda: "my-prod")
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx: False)
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([], False))

    pre = k8s.preflight()
    assert pre.context == "my-prod", \
        "the cluster kubectl names must survive, or doctor cannot say which one"
    assert pre.cluster_reachable is False
    assert pre.will_create is False

    # And where there genuinely is no cluster, it is still empty -- the message that
    # was wrong above is the right one there.
    monkeypatch.setattr(k8s.context, "active_context", lambda: "")
    assert k8s.preflight().context == ""


def test_the_only_difference_between_kind_and_k3s_is_whether_a_cluster_is_built(monkeypatch):
    """`up --runtime kubernetes` could only ever use a cluster houston built itself:
    `create_workspace` opened with `ensure_cluster()`, which refuses when `kind` is
    absent. So on a box running k3s -- an ordinary way to have Kubernetes -- `doctor`
    said "Using your cluster 'default'" and `up` refused to use it, two commands in one
    tool contradicting each other.

    Provisioning is the ONE step that differs. Everything after it already took
    `context=`, which is why adopting a cluster is a resolver and not a runtime.
    """
    from houston.errors import PreflightError
    from houston.services import k8s

    # kind, with its cluster already up: ours, and nothing to build. Today's behaviour.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=True, active="default")
    plan = k8s.plan_cluster()
    assert (plan.context, plan.distribution, plan.create) == (k8s.CONTEXT, "kind", False)

    # kind, no cluster yet: build ours. Today's behaviour, and the k3s box is IGNORED --
    # "no change to kind" is the stronger promise, so an existing cluster elsewhere never
    # takes the choice away from a box that can make its own.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    plan = k8s.plan_cluster()
    assert (plan.context, plan.distribution, plan.create) == (k8s.CONTEXT, "kind", True)

    # No kind: skip provisioning and use what kubectl points at.
    _kube_probe_stubs(monkeypatch, kind=False, our_cluster=False, active="default")
    plan = k8s.plan_cluster()
    assert (plan.context, plan.distribution, plan.create) == ("default", "k3s", False)

    # No kind and nothing reachable: refuse, and the message is now true.
    _kube_probe_stubs(monkeypatch, kind=False, our_cluster=False, active="")
    try:
        k8s.plan_cluster()
    except PreflightError as exc:
        assert "not pointed at one either" in str(exc), str(exc)
    else:
        raise AssertionError("a box with no cluster and no kind must be refused")


def test_a_named_context_is_adopted_and_never_provisioned(monkeypatch):
    """`--context` is step 0, and its whole point is that it cannot build anything.

    Provisioning a cloud cluster costs ~20 minutes and real money, and `plan_cluster`
    is reached by `check_capacity` through `_will_provision` -- so a `create=True` that
    an explicit context could produce would be a code path on which a CAPACITY CHECK
    spends money. `create` therefore keeps meaning exactly "this `up` will build a kind
    cluster", and a named context always returns False.

    The stubs put the box in the state that made this necessary: kind installed, no
    cluster of ours yet, so the un-named call plans a BUILD and ignores the k3s beside
    it.
    """
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s.context, "contexts", lambda: (["default", "eks-support"], ""))

    assert k8s.plan_cluster().create is True, "unchanged when no context is named"

    plan = k8s.plan_cluster(context="eks-support")
    assert (plan.context, plan.create) == ("eks-support", False), \
        "a named context must ADOPT, with kind installed and no cluster of our own"


def test_an_unknown_context_is_refused_and_says_what_exists(monkeypatch):
    """A typo is argument validation, so it refuses with the list rather than probing."""
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s.context, "contexts", lambda: (["default", "eks-support"], ""))

    with pytest.raises(errors.ValidationError) as exc:
        k8s.plan_cluster(context="eks-suport")
    assert "eks-suport" in str(exc.value)
    assert "eks-support" in str(exc.value), "the refusal must name what IS there"


def test_a_kubeconfig_that_cannot_be_read_does_not_refuse_a_context(monkeypatch):
    """"I could not ask" is not "it is not there", and only one is safe to act on.

    `contexts()` returns the reason separately for exactly this: if the refusal above
    fired on an unreadable kubeconfig, a transient `kubectl` failure would be reported
    to the user as a typo in their cluster name. The reachability probe is the real
    test and answers for itself.
    """
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([], "permission denied"))

    plan = k8s.plan_cluster(context="eks-support")
    assert (plan.context, plan.create) == ("eks-support", False), \
        "an unreadable kubeconfig must not be read as 'that context does not exist'"


def test_a_named_context_that_does_not_answer_is_refused(monkeypatch):
    """And the refusal carries the read failure, so the cause is not thrown away."""
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default",
                      reachable=False)
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([], "kubeconfig unreadable"))

    with pytest.raises(errors.PreflightError) as exc:
        k8s.plan_cluster(context="eks-support")
    assert "nothing answered" in str(exc.value), \
        "the refusal must name WHICH kind of unreachable this was"
    assert "kubeconfig unreadable" in str(exc.value), \
        "the reason the list could not be read belongs in the refusal"


def test_a_refused_context_is_told_what_to_do_about_THAT_context(monkeypatch):
    """The remedy has to match the cluster, and for one case it was actively wrong.

    Both refusals used to end in `aws eks update-kubeconfig`, which is the right hint
    for the case `--context` was built for and the wrong one for houston's OWN kind
    cluster -- where the answer is to stop passing `--context`, because a named context
    is adopted rather than created. Measured: on a fresh HOUSTON_HOME,
    `--context kind-houston-local` refused and told the user to run an AWS command
    about a local kind cluster.
    """
    from houston.services import k8s

    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s.context, "contexts", lambda: (["default"], ""))

    # Ours, absent, and kind is here to build it.
    with pytest.raises(errors.ValidationError) as exc:
        k8s.plan_cluster(context=k8s.CONTEXT)
    assert "WITHOUT" in str(exc.value) and "--context" in str(exc.value)
    assert "aws eks update-kubeconfig" not in str(exc.value), \
        "an AWS remedy for a local kind cluster is the defect this test exists for"

    # Ours, absent, and no kind to build it with -- a different remedy.
    monkeypatch.setattr(k8s.tools, "which", lambda t: "")
    with pytest.raises(errors.ValidationError) as exc:
        k8s.plan_cluster(context=k8s.CONTEXT)
    assert "Install kind" in str(exc.value)

    # Somebody else's cluster, absent: the AWS hint is right here and stays.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default")
    monkeypatch.setattr(k8s.context, "contexts", lambda: (["default"], ""))
    with pytest.raises(errors.ValidationError) as exc:
        k8s.plan_cluster(context="my-eks")
    assert "aws eks update-kubeconfig" in str(exc.value)

    # Ours, PRESENT in the kubeconfig but not answering -- same remedy, other error.
    _kube_probe_stubs(monkeypatch, kind=True, our_cluster=False, active="default",
                      reachable=False)
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([k8s.CONTEXT, "default"], ""))
    with pytest.raises(errors.PreflightError) as exc:
        k8s.plan_cluster(context=k8s.CONTEXT)
    assert "WITHOUT" in str(exc.value)
    assert "get nodes" not in str(exc.value), \
        "telling someone to debug kubectl against a cluster houston would build is noise"

    # Somebody else's, present but not answering: debug it, and `aws` is named because
    # an EKS kubeconfig cannot authenticate without it.
    with pytest.raises(errors.PreflightError) as exc:
        k8s.plan_cluster(context="default")
    assert "get nodes" in str(exc.value) and "`aws` on PATH" in str(exc.value)


def test_a_cluster_houston_made_is_found_by_asking_it_not_by_asking_kind(monkeypatch):
    """`cluster_exists` was `CLUSTER_NAME in clusters()`, and that probe needs the kind
    BINARY. So uninstalling kind while its cluster was still running made the cluster
    invisible -- node containers holding memory that nothing in houston could see or
    remove, and resolution quietly falling through to a different cluster.
    """
    from houston.services import k8s

    # kind gone, but our kubeconfig still names a cluster that answers.
    _kube_probe_stubs(monkeypatch, kind=False, our_cluster=True, active="default")
    plan = k8s.plan_cluster()
    assert plan.context == k8s.CONTEXT, "our own cluster is still the one to use"
    assert plan.create is False


def test_a_create_refused_for_want_of_a_cluster_leaves_no_record(monkeypatch, tmp_path):
    """Measured on a box with k3s and no kind: the refusal left an `incomplete`
    repro.json, `list` showed it as a workspace, and `used_ports()` went on reserving its
    port -- so a create that could never have succeeded held :3142 until somebody ran
    `down --volumes`.

    The write-ahead record is not the problem and must not be weakened: it exists because
    an interrupted create once left a workspace running and unrecorded. The order was.
    Choosing the cluster only probes, so it belongs above the write.
    """
    from houston.errors import PreflightError

    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **k: None)
    # Only functions that predate this change, so the test drives the OLD code too: no
    # kind and nothing for kubectl to point at is the box that gets refused.
    monkeypatch.setattr(k8s.tools, "which", lambda _t: "")
    monkeypatch.setattr(k8s.context, "cluster_context", lambda: "")
    monkeypatch.setattr(k8s.context, "active_context", lambda: "")
    req = lc.CreateReq(version="8.5.1", runtime="kubernetes", name="ghost", offline=True)
    try:
        lc._create_kubernetes(req)
    except PreflightError:
        pass
    else:
        raise AssertionError("it must refuse")
    assert not (tmp_path / "repros" / "ghost").exists(), \
        "a refusal wrote a record for a workspace that was never created"
    assert lc.runner.used_ports() == set(), "and it reserved that workspace's port"


def test_an_existing_cluster_is_never_planned_as_one_to_create(monkeypatch):
    """Caught by a live sweep, in the resolver itself.

    An earlier version decided `create` from whether THIS HOME's kubeconfig named a
    reachable context. A fresh HOUSTON_HOME facing a cluster that already exists -- a
    wiped state directory, a second user on the box, a kubeconfig cleared by a previous
    `prune` -- therefore planned to create one. Two consequences, the second serious:
    `check_capacity` charged 600 MB for a control plane already running, and the failed
    create's rollback was told the cluster was its to delete, so a create that died would
    have taken a cluster it did not make.

    `create` follows the CLUSTER now. `ensure_cluster` already re-exports the kubeconfig
    when it finds a cluster its config does not know about, which is why the context is
    knowable before it has been read.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/kind" if t == "kind" else "")
    monkeypatch.setattr(k8s.context, "cluster_context", lambda: "")       # this home knows nothing
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None: False)

    monkeypatch.setattr(k8s.context, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    plan = k8s.plan_cluster()
    assert plan.create is False, "an existing cluster must never be planned as a create"
    assert plan.context == k8s.CONTEXT

    monkeypatch.setattr(k8s.context, "clusters", lambda: ([], ""))
    assert k8s.plan_cluster().create is True, "and a missing one still is"


def _a_cluster_that_is_about_to_be_made():
    """A plan whose cluster does not exist yet, so nothing can be asked of it."""
    from houston.services import lifecycle as lc

    import ast

    # DERIVED: the call must sit under a test of `plan.create`, wherever in the steps it
    # lives. Reading the text around it broke the moment the create became a plan and
    # twelve steps -- and a text search could not have told a guarded call from one that
    # merely had the words nearby.
    tree = ast.parse(source_of(lc.create_k8s))
    guarded = [c for node in ast.walk(tree)
               if isinstance(node, ast.If) and "'create'" in ast.dump(node.test)
               for c in ast.walk(node) if isinstance(c, ast.Call)
               and getattr(c.func, "attr", "") == "assert_namespace_available"]
    every = [c for c in ast.walk(tree) if isinstance(c, ast.Call)
             and getattr(c.func, "attr", "") == "assert_namespace_available"]
    return every, guarded, lc


def test_the_namespace_preflight_is_skipped_when_the_cluster_is_about_to_be_made(
        tmp_path, monkeypatch):
    """The ownership preflight asks kubectl about a namespace, and on a fresh box the
    context it would ask about does not exist yet.

    `namespace_labels` correctly refuses to read "context was not found" as "no
    namespace" -- so with the check running unconditionally, the FIRST Kubernetes
    create on any box failed with houston's own "refusing to guess". Found by doing
    exactly that after `prune` had reclaimed the cluster; every earlier live run of
    the check passed only because a cluster happened to be there.

    A cluster that does not exist holds no namespace to collide with, and
    `ensure_namespace` repeats the check once it is up.
    """

    every, guarded, lc = _a_cluster_that_is_about_to_be_made()
    assert every, "the namespace preflight is gone entirely"
    assert len(guarded) == len(every), \
        "the preflight must be skipped when houston is about to create the cluster"

    # And it must still run when the cluster is already there.
    asked: list = []
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston.services import k8s
    monkeypatch.setattr(k8s.namespace, "assert_namespace_available",
                        lambda name, **kw: asked.append(name))
    # The helm gate sits directly above the call under test, in the same
    # `not plan.create` block, and it SHELLS OUT -- so on a box with no reachable
    # cluster it refuses the create and this test's subject never runs. Pinned, for
    # the reason `_kube_tls_env` pins it: nothing in this suite may need a cluster.
    monkeypatch.setattr(k8s.reachability, "helm_reachable", lambda ctx: "")
    monkeypatch.setattr(k8s.context, "plan_cluster",
                        lambda *a, **kw: k8s.ClusterPlan(context="default",
                                                         distribution="k3s",
                                                         create=False))
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc.ports, "pick_host_port", lambda *a, **kw: 3000)
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "rc_image": "i", "mongo_tag": "8.0",
                  "mongo_flavor": "official", "source": "t", "oplog": False})())
    monkeypatch.setattr(k8s.workspace, "create_workspace", lambda **kw: {
        "context": "default", "namespace": "houston-x", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": ""})
    try:
        lc._create_repro_locked(lc.CreateReq(version="8.5.1", name="x",
                                             runtime="kubernetes"))
    except Exception:  # noqa: BLE001 - the call above is what is being asserted
        pass
    assert asked == ["x"], asked


def test_a_create_refuses_when_helm_cannot_reach_the_cluster_kubectl_can(monkeypatch,
                                                                        tmp_path):
    """THE DEFECT, and it cost four minutes each time.

    houston drives kubectl AND helm; they resolve their configuration differently --
    `helm_env` gives helm houston's HELM_* homes while leaving KUBECONFIG to whoever
    owns the cluster -- and only kubectl was ever asked. Measured on a box whose
    `~/.kube/config` carried the server CA and client certificate of a PREVIOUS
    install of the same cluster: kubectl was entirely happy (`get ns`, `auth whoami`
    as system:admin, the whole MongoDB phase) and helm refused every call. So the
    create built a namespace, a StatefulSet, a PersistentVolume and an initiated
    replica set, then died at the chart and rolled all of it back:

        create failed — removing namespace houston-k8slive
        error: helm install failed: Error: kubernetes cluster unreachable: Get
        "https://127.0.0.1:6443/version": tls: failed to verify certificate: x509:
        certificate signed by unknown authority

    An error naming neither the cause nor the cure, for a condition readable in one
    second. A refusal here leaves nothing -- the gate this codebase applies to every
    other read-only precondition on this path.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **_k: True)
    monkeypatch.setattr(lc.runner.paths, "exists", lambda _n: False)
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **k: None)
    monkeypatch.setattr(lc.ports, "pick_host_port", lambda *a, **k: 3001)
    _real = lc.versions.resolve
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: _real(v, offline=True))
    monkeypatch.setattr(k8s.cluster, "ensure_kubeconfig", lambda plan, emit=None: "default")
    monkeypatch.setattr(k8s.reachability, "helm_reachable",
                        lambda ctx: 'Error: kubernetes cluster unreachable: '
                                    'x509: certificate signed by unknown authority')
    # Anything that would BUILD is a failure of the gate, not of the stub.
    monkeypatch.setattr(k8s.namespace, "assert_namespace_available",
                        lambda *a, **k: pytest.fail("gate ran too late"))
    monkeypatch.setattr(k8s.workspace, "create_workspace",
                        lambda **k: pytest.fail("a namespace was built anyway"))
    # `plan_cluster` lives on k8s, and lifecycle calls it as `k8s.plan_cluster()` --
    # patching the name on `lc` would have patched nothing and the test would have
    # passed against the real cluster on whatever box it ran.
    monkeypatch.setattr(k8s.context, "plan_cluster", lambda *_a, **_k: k8s.ClusterPlan(
        context="default", distribution="k3s", create=False))

    with pytest.raises(errors.ValidationError) as exc:
        lc.create_repro(lc.CreateReq(version="8.5.1", name="hg",
                                     runtime="kubernetes", wait=False),
                        emit=lc.null_emit)
    said = str(exc.value)
    assert "helm cannot reach cluster" in said, said
    assert "although kubectl can" in said, said
    # The CURE, named. This is the whole difference from the error it replaces.
    assert "previous install of the same cluster" in said, said
    assert "/etc/rancher/k3s/k3s.yaml > ~/.kube/config" in said, said
    assert "kind export kubeconfig" in said, said
    assert "doctor" in said, said


def test_a_kubeconfig_that_could_not_be_listed_says_so_rather_than_showing_nothing(monkeypatch,
                                                                                   tmp_path):
    """"I could not read the kubeconfig" is not "there are no clusters"."""
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([], "permission denied"))
    out = clustersvc.known_contexts()
    assert out["contexts"] == []
    assert out["unreadable"] == "permission denied", \
        "the caller has to be able to say the page may be missing clusters"


def test_one_cluster_with_two_context_names_is_one_row_and_one_bill(monkeypatch, tmp_path):
    """`eksctl` and `aws eks update-kubeconfig` each name the same cluster differently.

    eksctl writes `<iam-user>@<cluster>.<region>.eksctl.io`; the AWS CLI writes the
    cluster ARN. A cluster built with one and adopted with the other has BOTH in the
    kubeconfig, and a ledger that lists contexts then lists that cluster twice and
    prices it twice. Reported from a real screen: "Costing money 2 · ~$16.87/day" for a
    single cluster costing $8.44. Doubling the bill is the exact failure this module
    exists to prevent, in the other direction from a zero.

    The API server settles it without a probe, and the ARN is the name kept, because it
    says which account and which region -- the two facts the eksctl alias omits and the
    two that matter when acting on the wrong cluster.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    ALIAS = "iam-root-account@support.us-east-1.eksctl.io"
    SERVER = "https://ABC123.gr7.us-east-1.eks.amazonaws.com"
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([ALIAS, ARN, "default"], ""))
    monkeypatch.setattr(k8s.context, "context_servers", lambda: (
        {ALIAS: SERVER, ARN: SERVER, "default": "https://127.0.0.1:6443"}, ""))
    monkeypatch.setattr(k8s.context, "cluster_context", lambda: "")
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s.tools, "which", lambda t: "/usr/bin/" + t)
    monkeypatch.setattr(k8s.reachability, "reach", lambda *a, **k: k8s.Reach(status=k8s.REACH_OK))

    rows = clustersvc.known_contexts()["contexts"]
    names = [r["context"] for r in rows]
    assert names.count(ARN) == 1
    assert ALIAS not in names, "the same cluster must not be listed, or billed, twice"
    assert names == [ARN, "default"], "and nobody else's cluster is disturbed"
    kept = next(r for r in rows if r["context"] == ARN)
    assert kept["aliases"] == [ALIAS], \
        "the other name is carried, so a kubeconfig entry is not mistaken for a second cluster"


def test_forgetting_a_context_also_clears_a_pointer_left_at_it(monkeypatch, tmp_path):
    """`kubectl config delete-context` removes the entry and leaves `current-context`
    naming it, so the file is left pointing at something that is no longer in it.

    MEASURED on this box after a real `cluster delete`: `contexts()` answered
    ['default'] and `active_context()` answered the deleted cluster's ARN. Everything
    that asks "which cluster is kubectl on" got a name with nothing behind it, and
    houston reported "pointed at <arn>, which is not answering" -- about a cluster
    that had been deleted, whose entry had been removed, and which the context list
    correctly no longer showed. Six unrelated Kubernetes tests failed on it.

    A pointer at nothing is the worst-behaved litter of the three, because it is the
    one thing a context LIST cannot show you.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    ran: list[list[str]] = []

    def fake_run(cmd, **kw):
        ran.append(list(cmd))
        out = ARN if list(cmd[:3]) == ["kubectl", "config", "current-context"] else ""
        return subprocess.CompletedProcess(list(cmd), 0, stdout=out, stderr="")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    monkeypatch.setattr(k8s.context, "contexts", lambda: (["default"], ""))
    assert k8s.forget_context(ARN) is True
    assert ["kubectl", "config", "unset", "current-context"] in ran, \
        "the entry was removed and the pointer at it was left behind"


def test_forgetting_a_context_leaves_a_pointer_at_a_different_one_alone(monkeypatch,
                                                                       tmp_path):
    """Clearing litter must not take away the cluster somebody is working in.

    The unset is conditional on `current-context` naming the context being forgotten;
    an unconditional one would answer "no cluster" on a box whose kubectl was pointed
    at a perfectly good cluster that simply was not this one.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ran: list[list[str]] = []

    def fake_run(cmd, **kw):
        ran.append(list(cmd))
        out = "default" if list(cmd[:3]) == ["kubectl", "config",
                                             "current-context"] else ""
        return subprocess.CompletedProcess(list(cmd), 0, stdout=out, stderr="")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    monkeypatch.setattr(k8s.context, "contexts", lambda: (["default"], ""))
    k8s.forget_context("arn:aws:eks:us-east-1:1:cluster/support")
    assert ["kubectl", "config", "unset", "current-context"] not in ran, \
        "kubectl was pointed at another cluster and forgetting this one took it away"
