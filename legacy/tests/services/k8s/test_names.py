"""`houston.services.k8s.names`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from houston.services import lifecycle as lc
from servicehelpers import _fake_run
import json
import pytest


def test_the_release_is_named_as_the_official_docs_name_it():
    """PR #3 calls the release `rc`. The official guide calls it `rocketchat`, and
    with one release per namespace there is no reason to differ -- so every command
    copied from docs.rocket.chat works by substituting the namespace alone."""
    from houston.services import k8s

    assert k8s.RELEASE == "rocketchat"
    assert k8s.CLUSTER_NAME == "houston-local"


def test_teardown_waits_for_the_namespace_rather_than_claiming_it_is_gone(
        monkeypatch, tmp_path):
    """`kubectl delete namespace --wait=false` returns instantly, so `down` printed
    "removed" while the namespace was Terminating, the pods were still shutting down
    and the PVC was still there. Anyone checking with kubectl saw the opposite of
    what they had just been told, and `up` with the same name could race a
    half-deleted namespace.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    said: list = []
    phases = ["Terminating", "Terminating", ""]

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        joined = " ".join(argv)
        # ONE query answers both questions now, which is what a cluster actually
        # returns: the labels that prove the namespace is houston's and the phase
        # that says whether it has gone are fields of the same object. The stub
        # returns that object rather than two narrow strings, because a stub that
        # answers in a shape kubectl cannot produce is how the fix under test would
        # pass here and fail on a real cluster.
        if "get namespace" in joined and "-o json" in joined:
            phase = phases.pop(0) if phases else ""
            if not phase:
                # `--ignore-not-found`: gone is exit 0 with nothing on stdout.
                return sp.CompletedProcess(argv, 0, "", "")
            return sp.CompletedProcess(argv, 0, json.dumps({
                "metadata": {"name": "houston-k", "labels": {
                    k8s.OWNER_LABEL_KEY: k8s.OWNER_LABEL_VALUE,
                    k8s.WORKSPACE_LABEL: "k"}},
                "status": {"phase": phase}}), "")
        if "get pvc" in joined:
            return sp.CompletedProcess(argv, 0, "persistentvolumeclaim/data-mongodb-0\n", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    assert k8s.delete_namespace("k", context=k8s.CONTEXT, volumes=True,
                                emit=lambda e: said.append(e.message),
                                sleep=lambda _s: None) is True
    assert any("1 volume(s)" in m for m in said), said
    assert any("Terminating" in m for m in said), "it never said it was waiting"
    assert any("are gone" in m for m in said), "it never confirmed the end state"


def test_namespaces_are_selected_by_label_never_by_name(monkeypatch):
    """The safety property. Anyone can create a namespace called
    `houston-anything`; a teardown matching on the prefix would eventually delete
    one houston never made. Asserted on the argv, because that is the thing that
    reaches the cluster."""
    from houston.services import k8s

    seen = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        seen.append(argv)
        # `-o json`: `workspace_namespaces` goes through `ask_list` now, because it
        # has to be able to say "I could not ask" -- `-o name` cannot carry that,
        # and a stub answering the old shape leaves the destructive callers
        # untested against the very case this is about.
        return sp.CompletedProcess(argv, 0, json.dumps({"items": [{"metadata": {"name": "houston-t1"}}]}), "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    assert k8s.workspace_namespaces() == ["houston-t1"]
    argv = seen[0]
    assert "-l" in argv and k8s.OWNER_SELECTOR in argv, argv
    # The context legitimately contains the prefix (kind-houston-local). What must
    # not appear is a SELECTOR built from the name: no field-selector, and no
    # argument that is the prefix used as a match.
    selectors = [a for i, a in enumerate(argv)
                 if i and argv[i - 1] not in ("--context",) and a != "--context"]
    assert not any(a.startswith("--field-selector") for a in selectors), argv
    assert not any(a.strip('"\'') == k8s.NAMESPACE_PREFIX for a in selectors), argv


def test_a_cluster_houston_did_not_create_is_marked_external(monkeypatch):
    """The ownership rule at the right granularity. houston may delete a cluster
    it created; in one you supplied it owns only the namespaces it labelled, and
    the cluster itself is never its to remove."""
    from houston.services import k8s

    # No kind: the bring-your-own path, where the cluster kubectl points at is
    # adopted. With kind INSTALLED houston creates its own instead of adopting
    # anyone's, so that is not the setup this rule is about.
    monkeypatch.setattr(k8s.tools, "which", lambda t: "" if t == "kind" else f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "get clusters": (0, "somebody-elses\n"),
        "config current-context": (0, "kind-somebody-elses\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": []}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    pre = k8s.preflight()
    assert pre.cluster_exists is False, "ours is not among them"
    assert pre.provider == k8s.PROVIDER_EXTERNAL
    assert pre.context == "kind-somebody-elses"
    assert pre.will_create is False, "a cluster houston cannot make is never one it creates"

    # And ours, when it IS there, is the one houston may manage fully.
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": []}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    ours = k8s.preflight()
    assert ours.cluster_exists and ours.provider == k8s.PROVIDER_KIND
    assert ours.context == k8s.CONTEXT


def test_the_cluster_in_use_is_not_also_listed_as_another_cluster(monkeypatch, tmp_path):
    """It described the same cluster twice -- "Using your cluster 'kind-kind'"
    followed by "1 other kind cluster(s) (kind)" -- and the second mention reads as
    a different one."""
    from houston.services import doctor, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({
        "get clusters": (0, f"{k8s.CLUSTER_NAME}\nsomebody-elses\n"),
        "config current-context": (0, f"{k8s.CONTEXT}\n"),
        "/readyz": (0, "ok"),
        "get storageclass": (0, '{"items": [{"metadata": {"name": "standard",'
                                ' "annotations": {"storageclass.kubernetes.io/'
                                'is-default-class": "true"}}}]}'),
        "get namespace": (0, ""),
        "version": (0, "v9.9.9"),
    }))
    msgs = [r["message"] for r in doctor.run_checks()["checks"]]
    assert any(f"Cluster {k8s.CLUSTER_NAME!r} reachable" in m for m in msgs), msgs
    others = [m for m in msgs if "other kind cluster" in m]
    assert len(others) == 1 and "somebody-elses" in others[0], others
    assert k8s.CLUSTER_NAME not in others[0], \
        "the cluster in use was counted again as an 'other' one"


# --- provisioning ---------------------------------------------------------------

def test_creating_a_cluster_never_writes_the_users_kubeconfig(monkeypatch, tmp_path):
    """kind writes the file it is GIVEN and also honours KUBECONFIG for the context
    switch, so both are set. Verified live as well -- a real `kind create` left
    ~/.kube/config byte-identical and current-context on kind-kind -- but pinned
    here because the live check is not in CI."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    calls = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        calls.append((own, argv))
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    assert k8s.ensure_cluster() == k8s.CONTEXT
    create = [a for own, a in calls if "create" in a]
    assert create, calls
    argv = create[0]
    assert "--kubeconfig" in argv, "kind must be told where to write"
    assert str(tmp_path) in argv[argv.index("--kubeconfig") + 1], \
        "it wrote outside HOUSTON_HOME"
    assert all(own for own, a in calls if "create" in a), \
        "the create must also run with the redirected environment"


def test_a_second_up_reuses_the_cluster_instead_of_racing_to_create_it(monkeypatch, tmp_path):
    """Two simultaneous `up`s would both see no cluster and both run `kind create`;
    the second fails with "node(s) already exist". The re-check inside the lock
    means the loser reuses rather than retries -- concurrent workspaces are the
    whole point of one-cluster-many-namespaces."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    created = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "create" in argv:
            created.append(argv)
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    k8s.ensure_cluster()
    assert not created, "it created a cluster that was already there"


def test_deleting_the_cluster_can_only_ever_target_our_own(monkeypatch, tmp_path):
    """The safety property. There is no parameter for which cluster to delete,
    because a delete that can be pointed anywhere eventually is. Asserted on the
    argv, since that is what reaches the machine.

    Verified live too: after `delete_cluster`, the unrelated `kind` cluster on this
    box was still there.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    seen = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        seen.append(argv)
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, f"kind\n{k8s.CLUSTER_NAME}\nother\n", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "get namespace" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    assert k8s.delete_cluster() is True
    deletes = [a for a in seen if "delete" in a]
    assert len(deletes) == 1, deletes
    argv = deletes[0]
    # The property is about the --name VALUE, not about the whole argv: `kind` is
    # legitimately argv[0], the binary.
    assert argv[argv.index("--name") + 1] == k8s.CLUSTER_NAME, argv
    # And no other cluster the machine happens to have is named anywhere in it.
    targets = argv[argv.index("--name") + 1:]
    assert targets == [k8s.CLUSTER_NAME], f"more than our cluster is targeted: {targets}"


def test_an_uninitiated_replica_set_is_reported_as_dead_not_left_to_time_out(
        monkeypatch, tmp_path):
    """Exit 7, known dead. Every second waited after this is spent waiting for
    something that cannot happen, and the readiness timeout would blame
    Rocket.Chat."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def never_ok(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        if "jsonpath" in " ".join(argv):
            return sp.CompletedProcess(argv, 0, "true", "")   # container is up...
        if "--eval" in argv:
            return sp.CompletedProcess(argv, 0, "0", "")   # ...but rs.status().ok == 0
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", never_ok)
    with pytest.raises(errors.CreateFailedError) as caught:
        k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                             sleep=lambda _s: None)
    assert "change streams" in str(caught.value), "say WHY Rocket.Chat needs it"
    assert caught.value.exit_code == 7

    # And MongoDB never becoming ready is equally terminal, naming the command
    # that shows why.
    def never_ready(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        return sp.CompletedProcess(argv, 0, "false", "")

    monkeypatch.setattr(k8s.kube, "run", never_ready)
    monkeypatch.setattr(k8s.tuning, "MONGO_READY_TRIES", 2)
    with pytest.raises(errors.CreateFailedError) as caught2:
        k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                             sleep=lambda _s: None)
    assert "describe pod" in str(caught2.value), "name what to run next"
    assert "never started" in str(caught2.value), \
        "a pod stuck Pending has not started; it is not 'not ready'"


def test_the_headless_service_publishes_dns_before_the_pod_is_ready():
    """The circular dependency one layer below the readiness probe.

    A headless Service does not publish DNS for a not-ready pod. This pod cannot be
    ready until the replica set is initiated, so `rs.initiate` could not resolve
    `mongodb-0.mongodb` to verify the member is itself, and mongod refused with "no
    host described in new configuration ... maps to this node".

    Publishing not-ready addresses is the standard bootstrap pattern for a
    StatefulSet database -- the MongoDB operator does the same.
    """
    import yaml

    from houston.services import k8s

    svc = [d for d in yaml.safe_load_all(k8s.mongo_manifest("t", "8.0"))
           if d["kind"] == "Service"][0]
    # The literal STRING "None" -- that is how Kubernetes documents a headless
    # Service, and YAML's null is `null`, not `None`. Asserting `is None` here
    # would fail against a manifest the API server accepts.
    assert svc["spec"]["clusterIP"] == "None", "must stay headless for stable pod DNS"
    assert svc["spec"].get("publishNotReadyAddresses") is True, \
        "without this, rs.initiate cannot resolve its own member"
    # And the member host the initiate script uses is the one this service serves.
    assert f"{k8s.MONGO_SERVICE}-0.{k8s.MONGO_SERVICE}" in k8s.RS_INITIATE


def test_a_cluster_that_outlived_its_kubeconfig_is_reconnected(monkeypatch, tmp_path):
    """`kind get clusters` reads Docker, so it sees clusters houston's OWN kubeconfig
    knows nothing about. That happens whenever the cluster outlives the config: a
    fresh or different HOUSTON_HOME, a deleted config, a cluster made by hand.

    Without an export, "reusing cluster" was followed by every kubectl call going to
    localhost:8080 and the create failing with "the API server is not answering"
    about a cluster that was perfectly healthy. Observed exactly that way: a
    workspace left running from an earlier session broke the next run.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    seen = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        joined = " ".join(argv)
        seen.append(joined)
        if "get clusters" in joined:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "current-context" in joined:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in joined:
            return sp.CompletedProcess(argv, 0, "ok", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    assert k8s.ensure_cluster() == k8s.CONTEXT
    assert any("export kubeconfig" in c for c in seen), \
        "it reused a cluster without writing it into houston's kubeconfig"
    assert not any("create cluster" in c for c in seen), "it recreated an existing one"

    # A failed export is terminal and says so, rather than leaving every later
    # kubectl call to fail against localhost:8080.
    def broken(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        joined = " ".join(argv)
        if "get clusters" in joined:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "export kubeconfig" in joined:
            return sp.CompletedProcess(argv, 1, "", "permission denied")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", broken)
    with pytest.raises(errors.CreateFailedError) as caught:
        k8s.ensure_cluster()
    assert "kubeconfig could not be read" in str(caught.value)


def test_up_waits_before_seeding_a_kubernetes_workspace(monkeypatch, tmp_path):
    """`up --seed` ran the seeder the instant helm returned:

        error: can't seed — repro not ready (`houston ready --name rc8-5-1`)

    The CLI already forces wait=True when seeding -- `wait=(wait or seed)` -- and
    this path never read it. Helm returning is not Rocket.Chat serving.
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
    order: list = []
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc.ports, "pick_host_port", lambda *a, **kw: 3000)
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                  "mongo_flavor": "official", "oplog": False, "source": "t"})())
    monkeypatch.setattr(k8s.workspace, "create_workspace", lambda **kw: {
        "context": k8s.CONTEXT, "namespace": "houston-k", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": "",
        "microservices": False})
    monkeypatch.setattr(lc.ready, "wait_serving",
                        lambda *a, **kw: order.append("wait") or {"ready": True})
    monkeypatch.setattr(lc.seeding, "run_seed_inline",
                        lambda *a, **kw: order.append("seed") or {"users": 5})

    lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k", seed=True,
                                       wait=True, runtime=topology.KUBERNETES))
    assert order == ["wait", "seed"], f"seeded before it was serving: {order}"

    # And without --seed or --wait it still returns promptly.
    order.clear()
    lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k",
                                       runtime=topology.KUBERNETES))
    assert order == []


def test_the_statefulset_image_covers_the_versions_the_operator_cannot():
    """Why `mongo:` and not MongoDB Inc's own image, pinned so it is not "fixed".

    This StatefulSet exists to serve what the operator cannot reach, and
    `mongodb/mongodb-community-server` publishes NO tag below 4.4 -- 3.6, 4.0 and
    4.2 are 404 on Docker Hub -- while houston pairs Rocket.Chat < 3.0 with MongoDB
    3.6. "Make it consistent with compose.py" looks like a tidy-up and would break
    precisely the versions this code was written for.

    Same MongoDB either way: same source, version, storage engine and wire protocol,
    differing in base OS and packaging.
    """
    import yaml

    from houston.services import k8s

    assert k8s.mongo_image("3.6") == "mongo:3.6"
    docs = list(yaml.safe_load_all(k8s.mongo_manifest("t", "3.6")))
    sts = [d for d in docs if d and d.get("kind") == "StatefulSet"][0]
    assert sts["spec"]["template"]["spec"]["containers"][0]["image"] == "mongo:3.6"


def test_the_kubernetes_create_passes_the_url_it_just_computed(monkeypatch, tmp_path):
    """`create_workspace` has taken `root_url` since it was written; nothing gave it one.

    So the parameter existed, `values_for` had a branch for it, and the branch was
    dead on every real create -- which is how a whole runtime shipped with no
    ROOT_URL. The fix is one keyword, and this is the test that keeps it there.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
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
    monkeypatch.setattr(lc.sizing, "check_capacity", lambda *a, **kw: None)
    monkeypatch.setattr(lc.ports, "pick_host_port", lambda *a, **kw: 3456)
    monkeypatch.setattr(lc.versions, "resolve", lambda v, offline=False: type(
        "R", (), {"rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                  "mongo_flavor": "official", "oplog": False, "source": "t"})())
    seen: dict = {}
    monkeypatch.setattr(k8s.workspace, "create_workspace", lambda **kw: seen.update(kw) or {
        "context": k8s.CONTEXT, "namespace": "houston-k", "chart_version": "7.0.0",
        "release": k8s.RELEASE, "port_forward_pid": 0, "bind_host": "",
        "microservices": False})

    lc._create_kubernetes(lc.CreateReq(version="8.5.1", name="k",
                                       runtime=topology.KUBERNETES))
    assert seen.get("root_url") == "http://localhost:3456", \
        "the create computed a URL and did not pass it, so the chart set none"


def test_the_ca_issuer_is_a_tls_secret_and_a_clusterissuer_that_signs_from_it():
    """A `ca` issuer rather than an `acme` one is what makes `--https` and `--domain`
    the same values.yaml with one field different."""
    import yaml as _yaml

    from houston.services import k8s

    docs = [d for d in _yaml.safe_load_all(
        k8s.ca_issuer_manifest("-----BEGIN CERTIFICATE-----\nc\n-----END CERTIFICATE-----",
                               "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----"))
        if d]
    secret = next(d for d in docs if d["kind"] == "Secret")
    issuer = next(d for d in docs if d["kind"] == "ClusterIssuer")
    assert secret["type"] == "kubernetes.io/tls", "cert-manager reads tls.crt/tls.key"
    assert set(secret["stringData"]) == {"tls.crt", "tls.key"}
    assert secret["metadata"]["namespace"] == k8s.CERT_MANAGER_NAMESPACE, \
        "a ClusterIssuer reads its Secret from the cluster-resource namespace"
    assert issuer["spec"]["ca"]["secretName"] == secret["metadata"]["name"]
    # Labelled as ours, so it can be told from a cluster's own issuers.
    assert issuer["metadata"]["labels"][k8s.OWNER_LABEL_KEY] == k8s.OWNER_LABEL_VALUE


def test_the_ledger_can_reach_houstons_own_cluster_from_a_fresh_home(monkeypatch,
                                                                     tmp_path):
    """A cluster that is up, and reported as not answering.

    `is_ours()` is a NAME compare, so houston decides its own cluster is its own and
    reaches it through its OWN kubeconfig — which a fresh HOUSTON_HOME has not got.
    `ensure_kubeconfig` exists for exactly this and its docstring names the case:
    "With a kind cluster already up and a fresh home, every command failed ... and
    could not self-heal". It was fixed for `up`, and `cluster status` reintroduced it
    by probing without calling it. CLAUDE.md tells anyone writing a script to
    `export HOUSTON_HOME=$(mktemp -d)`, so it is reachable by following our own
    instructions.
    """
    from houston.services import cluster, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    exported: list = []
    monkeypatch.setattr(k8s.cluster, "ensure_kubeconfig",
                        lambda plan, emit=None: exported.append(plan.context) or "")
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([k8s.CONTEXT, "someone-elses"], ""))
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, timeout=None: False)

    cluster.status(context=k8s.CONTEXT)
    assert exported == [k8s.CONTEXT], \
        "houston's own cluster must have its kubeconfig exported before probing"

    # And NOT for a cluster somebody else made: there is nothing to export, and
    # rewriting their kubeconfig is not ours to do.
    exported.clear()
    cluster.status(context="someone-elses")
    assert exported == [], "a cluster houston did not create must be left alone"


def test_a_deleted_cluster_lets_its_records_be_removed(monkeypatch):
    """A DELETED cluster is not an UNREACHABLE one, and the refusal could not tell.

    When a kind cluster is removed its kubeconfig entry survives, so `kubectl get ns`
    fails with "The connection to the server 127.0.0.1:39911 was refused" and
    `namespace_labels` raises -- correctly, because a cluster that is merely stopped
    genuinely cannot be asked, and collapsing that into "not there" once destroyed a
    live workspace's record.

    But a namespace cannot outlive the cluster it lived in. So there was NO WAY to
    delete the record of a workspace whose cluster had gone: the namespace query cannot
    answer, `teardown` refuses, and `doctor` reports the cluster missing for ever.
    Reported from a live box in exactly that state.
    """
    from houston.errors import DockerError
    from houston.services import k8s

    def refused(ns, *, context):
        raise DockerError("could not ask cluster 'kind-houston-local' about namespace "
                          "houston-x: The connection to the server 127.0.0.1:39911 "
                          "was refused")
    monkeypatch.setattr(k8s.namespace, "namespace_labels", refused)
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: True)

    # The kind probe SUCCEEDED and the cluster is not in it -> provably gone.
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([], ""))
    assert k8s.delete_namespace("x", context=k8s.CONTEXT, volumes=True) is True, (
        "a record whose cluster was deleted still cannot be removed")

    # The cluster IS there and merely unreachable -> still a refusal. This is the case
    # the guard was written for and it must not be weakened.
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([k8s.CLUSTER_NAME], ""))
    try:
        k8s.delete_namespace("x", context=k8s.CONTEXT, volumes=True)
    except DockerError:
        pass
    else:
        raise AssertionError("an unreachable but EXISTING cluster was treated as gone")

    # The probe itself failed (no Docker, no kind) -> also still a refusal: that is
    # "I could not ask" a second time, not evidence of absence.
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([], "Cannot connect to the Docker daemon"))
    try:
        k8s.delete_namespace("x", context=k8s.CONTEXT, volumes=True)
    except DockerError:
        pass
    else:
        raise AssertionError("a failed kind probe was treated as proof of absence")

    # And a cluster houston does not own is never assumed gone on kind's word.
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: False)
    monkeypatch.setattr(k8s.context, "clusters", lambda: ([], ""))
    try:
        k8s.delete_namespace("x", context="some-remote", volumes=True)
    except DockerError:
        pass
    else:
        raise AssertionError("kind's listing was used to judge a foreign cluster")


def test_a_label_value_yaml_reads_as_a_boolean_is_quoted():
    """`no` is a legal workspace name and `on` is a legal account name, and both land
    in a label. kubectl parses YAML 1.1, where eleven spellings of each boolean are
    boolean -- so an unquoted one arrived at the API server as `false` and was refused
    with "cannot unmarshal bool into Go struct field ObjectMeta.metadata.labels of
    type string". Measured by `tools/parity-manifests.js` against a real API server:
    106 corpus values through the name and owner slots, every one rejected.

    The counterpart of `scalar()` in `src/core/kube/manifests.ts`, and gated against it
    over the same corpus."""
    from houston.services.k8s.names import scalar

    # The eleven booleans, the specials, the numerics and the sexagesimals.
    for hostile in ("y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO",
                    "true", "True", "TRUE", "false", "False", "FALSE",
                    "on", "On", "ON", "off", "Off", "OFF",
                    "~", "null", "Null", "NULL", ".inf", ".nan", "-.inf",
                    "0", "007", "0x1f", "0b101", "1_000", "1.5", "1e3", "-3",
                    "12:30:45", "1:30"):
        assert scalar(hostile) == json.dumps(hostile), hostile

    # Anything a YAML reader could mistake for structure.
    for hostile in ("", " ", "a: b", "a #c", " lead", "trail ", "-dash", "?q",
                    "[x]", "{x}", "#h", "&a", "*a", "!t", "|b", ">f", "%p", "@r"):
        assert scalar(hostile) == json.dumps(hostile), hostile

    # An ORDINARY name is left exactly as it was, so the manifests every real
    # workspace produces are unchanged.
    for ordinary in ("tkt-1234", "lovekesh", "my-workspace", "a", "rc8-5-1"):
        assert scalar(ordinary) == ordinary, ordinary


def test_a_hostile_workspace_name_reaches_the_manifest_quoted():
    """The whole point of the helper, one layer up: the label block a real manifest
    carries. A plain name must still be emitted plain, or every manifest on every box
    changes to fix a case almost nobody hits."""
    from houston.services.k8s import manifests

    plain = manifests.mongo_manifest("tkt-1234", tag="7.0", owner="lovekesh")
    assert "houston.io/workspace: tkt-1234" in plain
    assert "houston.io/owner: lovekesh" in plain

    hostile = manifests.mongo_manifest("no", tag="7.0", owner="on")
    assert 'houston.io/workspace: "no"' in hostile
    assert 'houston.io/owner: "on"' in hostile
    # And it still parses as the STRING that went in, which is what the API server
    # refused before.
    import yaml

    for doc in yaml.safe_load_all(hostile):
        labels = ((doc or {}).get("metadata") or {}).get("labels") or {}
        if "houston.io/workspace" in labels:
            assert labels["houston.io/workspace"] == "no"
            assert labels["houston.io/owner"] == "on"
