"""`houston.services.k8s.monitoring`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from conftest import source_of
from servicehelpers import _completed, _helm_list
import json


def test_the_monitoring_stack_is_shared_by_the_cluster_not_owned_by_a_workspace():
    """The Compose shape does not transfer, and copying it would break at two.

    `helm template rocketchat/monitoring` with every dependency disabled still
    renders a ClusterRole and a ClusterRoleBinding at FIXED names
    (`monitoring-otel-collector-role`) plus a log-collector DaemonSet -- so a
    per-workspace release collides on cluster-scoped objects at the second
    workspace, exactly as the MongoDB operator's CRDs do, and would also put one
    collector per node per workspace on the same host paths.

    So it lives once in houston-system, like the operator, and `--monitor` on a
    workspace means "point the shared Prometheus at me", not "install a stack".
    """
    from houston.services import k8s

    assert k8s.MONITORING_NAMESPACE == k8s.OPERATOR_NAMESPACE == "houston-system"


def test_prometheus_is_told_to_look_outside_its_own_release():
    """The one setting a shared stack cannot work without.

    kube-prometheus-stack defaults `serviceMonitorSelectorNilUsesHelmValues` and its
    pod equivalent to true, which restricts Prometheus to monitors carrying its own
    release label. A workspace's PodMonitor is in another namespace and another
    release, so it is silently ignored: nothing errors, Grafana just draws empty
    graphs -- which reads as "monitoring is broken" rather than "the selector
    excluded it".
    """

    from houston.services import k8s

    src = source_of(k8s.ensure_monitoring)
    for key in ("serviceMonitorSelectorNilUsesHelmValues=false",
                "podMonitorSelectorNilUsesHelmValues=false"):
        assert key in src.replace("\"\n               \"", ""), key


def test_detaching_monitoring_leaves_it_up_for_the_workspaces_still_using_it(
        monkeypatch):
    """Shared means one workspace's `--off` must not blind the others.

    This is the real behavioural difference from Compose, where the stack belongs to
    a project and detaching is unambiguous. Getting it wrong is silent: the other
    workspaces keep running and just stop being observable.
    """
    import subprocess

    from houston.services import k8s

    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces",
                        lambda ctx: ["houston-a", "houston-b"])
    monkeypatch.setattr(k8s.monitoring, "monitoring_wanted",
                        lambda ns, *, context: ns == "houston-b")
    # The stack IS installed here: "who else wants it" is only a question once
    # something exists to keep, and `remove_monitoring` now returns early otherwise.
    monkeypatch.setattr(k8s.operator, "release_installed", lambda *a, **k: True)
    calls = []

    def fake_run(argv, **kw):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(k8s.kube, "run", fake_run)

    assert k8s.remove_monitoring(context=k8s.CONTEXT) is False
    assert not any("uninstall" in a for argv in calls for a in argv), calls

    monkeypatch.setattr(k8s.monitoring, "monitoring_wanted", lambda ns, *, context: False)
    calls.clear()
    assert k8s.remove_monitoring(context=k8s.CONTEXT) is True
    assert any("uninstall" in a for argv in calls for a in argv), calls


def test_finalizers_are_cleared_the_moment_the_deletes_stop_working(monkeypatch):
    """Nine minutes of silence, measured on a live workspace. The Grafana operator was
    already gone -- only the MongoDB operator was left in `houston-system` -- while
    twelve grafana-operator resources remained, one carrying
    `operator.grafana.com/finalizer` and a deletionTimestamp ten minutes old, with the
    release stuck in `uninstalling`. Every step paid its full timeout for nothing: four
    60-second deletes that could never finish, then a five-minute `helm uninstall
    --wait`, and only then the fallback that clears the finalizers -- which worked at
    once. The clearing has to happen when the deletes are seen to have failed, not nine
    minutes later."""
    import subprocess
    from houston.services import k8s

    monkeypatch.setattr(k8s.operator, "release_installed", lambda *a, **k: True)
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx: [])
    calls = []

    # The delete never works and the resources never go: exactly the live shape.
    def fake_run(argv, **kw):
        calls.append(" ".join(argv))
        joined = " ".join(argv)
        if "get" in argv and "jsonpath={.items[*].metadata.name}" in joined:
            return subprocess.CompletedProcess(argv, 0, "wedged-one", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    assert k8s.remove_monitoring(context=k8s.CONTEXT) is True

    patch_at = [i for i, c in enumerate(calls) if "finalizers" in c]
    uninstall_at = [i for i, c in enumerate(calls) if "uninstall" in c]
    assert patch_at, "never cleared the finalizers"
    assert uninstall_at, "never uninstalled the release"
    assert min(patch_at) < min(uninstall_at), (
        "cleared the finalizers only AFTER helm had already waited: " + str(calls))

    # And the per-kind deadline is short, because a delete still running after it is
    # waiting on something nothing will clear.
    deletes = [c for c in calls if " delete " in f" {c} "]
    assert deletes, calls
    assert all(f"--timeout={k8s.GRAFANA_DELETE_WAIT}s" in c for c in deletes), deletes
    assert k8s.GRAFANA_DELETE_WAIT <= 20, "a doomed delete must not block for a minute"


def test_grafana_is_forwarded_from_the_instance_not_the_operator():
    """`monitoring-grafana` is the grafana-OPERATOR and serves nothing useful;
    `monitoring-grafana-deployment` is the Grafana it manages. Forwarding the wrong
    one gives a page that loads and has no dashboards -- a working URL showing
    nothing, which is worse than a refusal."""
    from houston.services import k8s

    assert k8s.GRAFANA_DEPLOYMENT == "monitoring-grafana-deployment"
    # Deployment, not Service, for the same reason the workspace forward is:
    # a Service with no ready endpoint makes kubectl exit at once.
    src = source_of(k8s.grafana_forward)
    assert "deployment/{GRAFANA_DEPLOYMENT}" in src


def test_the_shared_teardown_chain_cannot_answer_from_ignorance(monkeypatch):
    """Removing a SHARED resource is decided by a chain of reads, and every link has
    to be able to say "I could not tell".

    `remove_monitoring` asks which namespaces exist, then asks each one whether it
    still wants monitoring. Fixing the first read and not the second changes nothing:
    the outer list comes back correct, the inner question answers "no" for a namespace
    whose label nobody could read, the count comes back empty, and the shared stack is
    uninstalled out from under a workspace that is using it. Same defect, one level
    down, and the walk over `returncode` did not see it because the shape was
    `return <expr> == "true"`.

    So this pins the CHAIN rather than a function: three reads that must admit None,
    and two callers that must refuse when they get it.
    """
    import typing

    from houston.services import k8s

    for fn in (k8s.workspace_namespaces, k8s.mongodb_resources, k8s.monitoring_wanted):
        ann = typing.get_type_hints(fn).get("return")
        assert "None" in str(ann), (
            f"{fn.__name__} feeds a shared-teardown decision and cannot say "
            f"'I could not tell' (returns {ann})")

    # And the two callers act on it. Asserted on behaviour, not on the source.
    monkeypatch.setattr(k8s.operator, "release_installed", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.operator, "operator_installed", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx=None: ["houston-other"])
    monkeypatch.setattr(k8s.operator, "mongodb_resources", lambda ctx: None)
    said: list = []
    assert k8s.remove_operator(context="c", emit=lambda e: said.append(e.message)) is False
    assert any("could not be listed" in m for m in said), said

    # The inner question specifically: the list is fine, the label is not.
    said.clear()
    monkeypatch.setattr(k8s.monitoring, "monitoring_wanted", lambda ns, **kw: None)
    assert k8s.remove_monitoring(context="c",
                                 emit=lambda e: said.append(e.message)) is False
    assert any("could not read whether" in m for m in said), said

    # A real "no" still means no, or the shared stack could never be reclaimed.
    said.clear()
    monkeypatch.setattr(k8s.monitoring, "monitoring_wanted", lambda ns, **kw: False)
    monkeypatch.setattr(k8s.kube, "run", lambda a, **kw: _completed(0))
    monkeypatch.setattr(k8s.monitoring, "clear_grafana_finalizers", lambda ctx: 0)
    assert k8s.remove_monitoring(context="c",
                                 emit=lambda e: said.append(e.message)) is True

    # One name for the label, in one place: it was a literal at the setter and a
    # literal in the reference count, which is two chances to disagree about the
    # thing that decides whether the shared stack is uninstalled.
    assert "houston.io/monitoring" not in source_of(k8s.set_monitoring_label)
    assert k8s.MONITORING_LABEL == "houston.io/monitoring"


def test_a_pending_shared_release_is_not_mistaken_for_a_working_one(monkeypatch):
    """`monitoring_installed` read the RETURN CODE of `helm status`, which is 0 for a
    release in any state -- including one a killed install left in `pending-install`.

    So it answered True for a namespace holding no Prometheus and no Grafana,
    `ensure_monitoring` took its early return, skipped both the install and
    `wait_for_grafana`, and `monitor` reported the stack attached while the
    dashboards did not exist. The same collapse `release_state` was written for, in
    the one function that was not migrated with the others.
    """
    from houston.services import k8s

    def listing(status):
        return _helm_list(k8s.MONITORING_RELEASE, status=status)

    for status, want in (("deployed", True), ("pending-install", False),
                         ("pending-upgrade", False), ("failed", False)):
        monkeypatch.setattr(k8s.kube, "run", lambda a, _s=status, **kw: _completed(
            0, out=listing(_s)))
        assert k8s.monitoring_installed("c") is want, status

    # Absent is absent; a refused list is not "installed" either, because the caller's
    # next move is an idempotent `upgrade --install`.
    monkeypatch.setattr(k8s.kube, "run", lambda a, **kw: _completed(0, out="[]"))
    assert k8s.monitoring_installed("c") is False
    monkeypatch.setattr(k8s.kube, "run", lambda a, **kw: _completed(1, err="boom"))
    assert k8s.monitoring_installed("c") is False


def test_the_workspace_being_destroyed_does_not_vote_to_keep_the_stack(monkeypatch):
    """The reference count reads a label on the workspace namespace, and
    `workspace_namespaces` does not filter by phase -- a namespace still Terminating is
    still listed and still labelled. Without excluding it, a teardown asking "does
    anyone else still want this?" is answered yes by the workspace it is deleting.
    """
    import subprocess as sp

    from houston.services import k8s

    def run(argv, timeout=None, own=False, env=None, input=None):
        j = " ".join(argv)
        if "helm list" in j:
            return sp.CompletedProcess(argv, 0, _helm_list(k8s.MONITORING_RELEASE), "")
        if "get namespace" in j and "-l" in j:
            # `-o json`: `workspace_namespaces` goes through `ask_list` now, because it
            # has to be able to say "I could not ask" -- `-o name` cannot carry that,
            # and a stub answering the old shape leaves the destructive callers
            # untested against the very case this is about.
            return sp.CompletedProcess(argv, 0, json.dumps({"items": [{"metadata": {"name": "houston-going"}}]}), "")
        if "get namespace houston-going" in j:
            # `monitoring_wanted` reads the namespace DOCUMENT now, not a jsonpath.
            # It has to tell "this workspace does not want monitoring" from "I could
            # not read the label" -- and it is the INNER test of the reference count,
            # so answering the second as the first uninstalls the shared stack out
            # from under a workspace that is using it. An empty jsonpath result also
            # cannot say whether the LABEL is absent or the NAMESPACE is.
            return sp.CompletedProcess(argv, 0, json.dumps({
                "metadata": {"name": "houston-going",
                             "labels": {k8s.MONITORING_LABEL: "true"}}}), "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", run)
    events = []
    # Not excluded: the dying workspace keeps its own stack alive forever.
    assert k8s.remove_monitoring(context="default", emit=events.append) is False
    assert any("still used by going" in e.message for e in events)
    # Excluded: nothing else wants it, so it goes.
    events.clear()
    assert k8s.remove_monitoring(context="default", excluding="houston-going",
                                 emit=events.append) is True


def test_the_monitoring_stack_reclaims_its_volume(monkeypatch):
    """K-11. A StatefulSet's PVCs outlive it by design -- that is what keeps a
    workspace's MongoDB data across a plain `down` -- and nothing deleted the
    monitoring one. There was no code path anywhere that could: a clean
    `monitor --off` left `prometheus-...-db-...-0` Bound, 10 Gi, permanently.
    """
    from houston.services import k8s

    seen: list[list[str]] = []

    def fake_run(argv, **kw):
        seen.append(argv)
        if "get" in argv and "pvc" in argv:
            return _completed(0, out="persistentvolumeclaim/prometheus-db-0\n")
        return _completed(0)
    monkeypatch.setattr(k8s.kube, "run", fake_run)
    monkeypatch.setattr(k8s.operator, "release_installed", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx=None: [])
    monkeypatch.setattr(k8s.monitoring, "grafana_leftovers", lambda ctx: [])
    monkeypatch.setattr(k8s.monitoring, "clear_grafana_finalizers", lambda ctx: None)

    assert k8s.remove_monitoring(context="c") is True
    deletes = [a for a in seen if "delete" in a and "pvc" in a]
    assert deletes, "the monitoring volume was left allocated"
