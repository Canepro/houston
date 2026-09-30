"""`houston.services.k8s.cluster`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from houston import errors
from servicehelpers import _cluster_env
import json
import pytest


def test_the_cluster_is_not_taken_out_from_under_a_colleagues_workspace(monkeypatch, tmp_path):
    """On a shared box the cluster holds other people's workspaces. `prune`
    reclaiming it mid-ticket is the failure this guards, and the namespaces carry
    an owner label so the refusal can be specific."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    deleted = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, f"{k8s.CLUSTER_NAME}\n", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "get namespace" in j:
            # `-o json`: `workspace_namespaces` goes through `ask_list` now, because it
            # has to be able to say "I could not ask" -- `-o name` cannot carry that,
            # and a stub answering the old shape leaves the destructive callers
            # untested against the very case this is about.
            return sp.CompletedProcess(argv, 0, json.dumps({"items": [{"metadata": {"name": "houston-t1"}}, {"metadata": {"name": "houston-t2"}}]}), "")
        if "delete" in argv:
            deleted.append(argv)
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    with pytest.raises(errors.ConflictError) as caught:
        k8s.delete_cluster()
    assert "2 workspace namespace(s)" in str(caught.value)
    assert "houston-t1" in str(caught.value), "name them, so it is actionable"
    assert not deleted, "it deleted the cluster anyway"

    # --force takes it, because sometimes that is what you want.
    assert k8s.delete_cluster(force=True) is True
    assert deleted, "--force must actually delete"


def test_an_unreachable_cluster_is_never_treated_as_an_empty_one(monkeypatch):
    """K-01. `delete_cluster`'s whole ownership guard lived inside
    `if not force and reachable(context)`, so an unreachable cluster skipped it --
    including the "could not read" refusal written for exactly that case.

    `kind delete` talks to Docker, so unreachability was no obstacle: a paused
    control plane holding live workspaces was deleted by one `prune --yes`, with the
    prompt calling the cluster empty. A cluster nobody can reach is the case houston
    knows LEAST about, not most.
    """
    from houston.services import k8s

    # Holds a workspace and cannot be reached: the worst case, and the one that used
    # to delete it.
    calls = _cluster_env(monkeypatch, reachable=False, held=["houston-victim"])
    assert k8s.cluster_reclaimable() is False
    with pytest.raises(errors.ConflictError, match="not answering"):
        k8s.delete_cluster()
    assert not [a for a in calls if "delete" in a and "cluster" in a], \
        "the cluster was deleted without its contents ever being read"

    # Empty but unreachable: still refused — "empty" is not something we know.
    _cluster_env(monkeypatch, reachable=False, held=[])
    assert k8s.cluster_reclaimable() is False
    with pytest.raises(errors.ConflictError):
        k8s.delete_cluster()

    # Reachable and genuinely empty: the legitimate reclaim still works.
    calls = _cluster_env(monkeypatch, reachable=True, held=[])
    assert k8s.cluster_reclaimable() is True
    assert k8s.delete_cluster() is True
    assert [a for a in calls if "delete" in a and "cluster" in a]

    # Reachable and occupied: refused, naming what it holds.
    _cluster_env(monkeypatch, reachable=True, held=["houston-victim"])
    with pytest.raises(errors.ConflictError, match="still holds"):
        k8s.delete_cluster()

    # --force is still the way through a wedged one.
    calls = _cluster_env(monkeypatch, reachable=False, held=["houston-victim"])
    assert k8s.delete_cluster(force=True) is True
