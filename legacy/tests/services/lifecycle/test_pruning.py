"""`houston.services.lifecycle.pruning`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import call_sequence
from conftest import source_index
from conftest import source_of
from houston import errors
from houston.services import lifecycle as lc
from servicehelpers import _completed


def test_prune_gives_back_the_cluster_it_created(monkeypatch, tmp_path):
    """Measured live: with every workspace gone, `prune` said "Nothing to prune" and left
    houston's own kind control plane running -- 514 MiB holding nothing. Both the README
    and the agent skill said `prune` reclaims it; `delete_cluster` had exactly one caller,
    a failed create's rollback, so the documented promise was never kept and the memory
    the tool tells you to worry about was the memory it left behind.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.pruning, "prunable", lambda: [])
    monkeypatch.setattr(lc.pruning, "orphan_namespaces", lambda *a, **k: [])
    deleted = []
    monkeypatch.setattr(k8s.cluster, "delete_cluster",
                        lambda **kw: deleted.append(kw) is None or True)

    res = lc.prune(confirm=True)
    assert res["cluster"] is True, "the cluster was left running with nothing in it"
    assert deleted, "delete_cluster was never called"

    # And after a prune that DID remove workspaces, the same offer applies.
    deleted.clear()
    monkeypatch.setattr(lc.pruning, "prunable", lambda: [])
    res = lc.prune(confirm=True, orphans=False)
    assert res["cluster"] is True


def test_prune_audits_the_namespaces_it_swept_not_just_the_records(monkeypatch, tmp_path):
    """The audit subject was `",".join(targets)` -- local records only.

    A sweep of three namespaces and no records therefore wrote `prune` with an empty
    subject, so between that and the silent stdout there was no trace anywhere of what
    had been destroyed.
    """
    from houston.services import audit as auditsvc
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen = []
    monkeypatch.setattr(auditsvc, "record", lambda a, s="", **k: seen.append((a, s)))
    monkeypatch.setattr(lc.pruning, "prunable", lambda *a, **k: [])
    monkeypatch.setattr(lc.pruning, "orphan_namespaces", lambda *a, **k: ["houston-ghost"])
    monkeypatch.setattr(lc.pruning, "_reclaim_cluster", lambda *a, **k: False)

    # The audit is written before the sweep, so the sweep itself is not stubbed and
    # whatever it does with no cluster to talk to is not what this asserts.
    try:
        lc.prune(confirm=True, orphans=True)
    except Exception:  # noqa: BLE001
        pass

    assert seen, "prune recorded no audit entry at all"
    action, subject = seen[0]
    assert action == "prune"
    assert "houston-ghost" in subject, subject


def test_one_unreadable_workspace_does_not_abort_the_whole_prune(monkeypatch,
                                                                 tmp_path):
    """K-04. `prune` caught ConflictError but not the DockerError `delete_namespace`
    raises, so the first unreadable workspace ended the run and every later one was
    silently left -- the reported "prune doesn't work"."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc.pruning, "orphan_namespaces", lambda *a, **kw: [])
    monkeypatch.setattr(lc.pruning, "_reclaim_cluster", lambda emit: False)
    monkeypatch.setattr(lc.pruning, "prunable", lambda: ["bad", "good"])
    monkeypatch.setattr(lc.topology, "of_repro", lambda n: lc.topology.DOCKER)
    monkeypatch.setattr(lc.edgesvc.networks, "detach", lambda n: None)
    monkeypatch.setattr(lc.edgesvc.routes, "deregister", lambda n: None)
    removed: list[str] = []
    monkeypatch.setattr(lc.runner.paths, "remove", lambda n: removed.append(n))
    monkeypatch.setattr(lc.state, "_clear_default_if", lambda n: None)

    def down(name, **kw):
        if name == "bad":
            raise errors.DockerError("could not ask the cluster")
        return 0
    monkeypatch.setattr(lc.runner.engine, "down", down)

    out = lc.prune(confirm=True, only=["bad", "good"])
    assert out["removed"] == ["good"], \
        "the unreadable workspace ended the sweep instead of being skipped"


def test_prune_acts_only_on_what_the_prompt_showed(monkeypatch, tmp_path):
    """`cli.prune` computed `prunable()` for the prompt and `prune()` recomputed it
    after the answer.

    So on a shared box a workspace that went `down` while somebody read the prompt was
    deleted without ever appearing on screen -- and the ownership gate does not help,
    because with the default `owner` policy an admin passes for everybody. README says
    "`prune` lists what it will delete".
    """
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    # `a` was shown; `b` appeared afterwards.
    monkeypatch.setattr(lc.pruning, "prunable", lambda: ["a", "b"])
    monkeypatch.setattr(lc.pruning, "orphan_namespaces", lambda *a, **k: [])
    monkeypatch.setattr(lc.pruning, "_reclaim_cluster", lambda *a, **k: False)
    removed: list = []
    monkeypatch.setattr(lc.runner.engine, "down", lambda n, volumes=False: removed.append(n) or 0)
    monkeypatch.setattr(lc.runner.paths, "remove", lambda n: None)
    monkeypatch.setattr(lc.state, "_clear_default_if", lambda n: None)
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **k: None)
    said: list = []

    res = lc.prune(confirm=True, only=["a"], emit=lambda ev: said.append(ev.message))

    assert res["targets"] == ["a"], res["targets"]
    assert "b" not in removed, f"pruned {removed}, which includes one nobody was shown"
    assert any("became prunable after the list was shown" in m for m in said), said


def test_orphaned_namespaces_are_found_but_never_swept_by_default(
        monkeypatch, tmp_path):
    """A namespace with no local record is unreachable by every other command.

    Every houston command starts from the state directory, so a workspace whose
    repro.json is gone -- interrupted create, wiped HOUSTON_HOME, a different home
    -- keeps its pods and its PersistentVolumeClaim running and simply cannot be
    seen. One was found holding 8Gi and five CrashLoopBackOff pods, removable only
    by hand with kubectl.

    It is OPT-IN, and that is the point: on a shared cluster an unrecorded namespace
    may be a colleague's workspace created from their own home, so "this machine has
    no record of it" is not evidence that it is rubbish.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="known", project="p", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    ws = lc.runner.workspace("known")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces",
                        lambda ctx=k8s.CONTEXT: ["houston-known", "houston-p3",
                                                 k8s.OPERATOR_NAMESPACE])
    found = lc.orphan_namespaces()
    assert found == ["houston-p3"], found
    assert k8s.OPERATOR_NAMESPACE not in found, \
        "the shared operator/monitoring namespace is not a workspace"

    # Default prune leaves them entirely alone.
    monkeypatch.setattr(lc.pruning, "prunable", lambda: [])
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    deleted: list[str] = []

    def fake_run(argv, **kw):
        import subprocess as sp
        if "delete" in argv and "namespace" in argv:
            deleted.append(argv[-2] if argv[-1].startswith("--") else argv[-1])
        return sp.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(k8s.kube, "run", fake_run)

    assert lc.prune(confirm=True)["orphans"] == []
    assert deleted == [], "a sweep nobody asked for could delete a colleague's work"

    # Asked for explicitly, it removes exactly the unexplained one.
    out = lc.prune(confirm=True, orphans=True)
    assert out["orphans"] == ["houston-p3"]
    assert deleted == ["houston-p3"], deleted


def test_reclaiming_the_cluster_can_only_ever_reach_our_own(monkeypatch, tmp_path):
    """The teardown asymmetry the runtime split is built on: what houston created it may
    destroy, what you supplied it only borrows a namespace in. `delete_cluster` takes no
    parameter, needs the `kind` binary, and refuses while a workspace namespace remains --
    so an adopted k3s cannot be reached from a prune at all. And a refusal is not a failed
    prune: the workspaces are already gone, which is what was asked for.
    """
    from houston.errors import ConflictError
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.pruning, "prunable", lambda: [])
    monkeypatch.setattr(lc.pruning, "orphan_namespaces", lambda *a, **k: [])

    # No kind binary: there is nothing of ours to give back.
    monkeypatch.setattr(k8s.tools, "which", lambda _t: "")
    assert k8s.cluster_reclaimable() is False

    # A cluster that still holds a workspace refuses, and the prune still succeeds.
    def refuse(**_kw):
        raise ConflictError("cluster houston-local still holds 1 workspace namespace(s)")
    monkeypatch.setattr(k8s.cluster, "delete_cluster", refuse)
    events = []
    res = lc.prune(confirm=True, emit=events.append)
    assert res["cluster"] is False
    assert any("left alone" in e.message for e in events), [e.message for e in events]


def test_waiting_for_an_orphan_asks_the_cluster_it_was_deleted_from(monkeypatch, tmp_path):
    """`prune --orphans` deleted with `_orphan_context()` and then waited with the
    hardcoded `k8s.CONTEXT`.

    `_orphan_context()` exists BECAUSE that hardcoding was already found and fixed
    once, at the delete call, one block above -- and it was reintroduced at the wait.
    On any cluster houston did not create the two disagree, so the wait asked a
    context that is not in the kubeconfig, kubectl exited non-zero, and the loop read
    that as "gone": `✓ removed 1 orphaned namespace(s)`, exit 0, over a namespace
    still Terminating. Invisible on kind, where the two happen to be equal, which is
    why a live pass on kind did not catch it.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.pruning, "prunable", lambda: [])
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc.pruning, "orphan_namespaces", lambda *a, **k: ["houston-p9"])
    monkeypatch.setattr(lc.pruning, "_orphan_context", lambda: "someone-elses-cluster")
    monkeypatch.setattr(lc.pruning, "_reclaim_cluster", lambda emit: False)
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: _completed(0))

    asked: list = []

    def spy_wait(ns, *, context, emit=None, **kw):
        asked.append(context)
        return True

    monkeypatch.setattr(k8s.namespace, "wait_namespace_gone", spy_wait)
    lc.prune(confirm=True, orphans=True)
    assert asked == ["someone-elses-cluster"], (
        f"waited on {asked} but deleted from 'someone-elses-cluster' — the two must "
        f"be the same cluster")
    assert k8s.CONTEXT not in asked, "the hardcoded kind context is back"


def test_prune_says_which_namespaces_it_destroyed(monkeypatch, tmp_path):
    """`prune --orphans` deleted namespaces and their PersistentVolumeClaims and then
    printed "Nothing to prune."

    `lifecycle.prune` returns them as `orphans`; the CLI rendered `removed` alone, so a
    sweep that removed no local record -- the normal case for the situation --orphans
    exists for -- reported the irreversible half of the command as the no-op half. The
    confirmation prompt did name them, which is no help under `--yes`.
    """
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.pruning, "prunable", lambda *a, **k: [])
    monkeypatch.setattr(lc.pruning, "orphan_namespaces", lambda *a, **k: ["houston-ghost"])
    monkeypatch.setattr(cli, "_cluster_reclaimable", lambda *a, **k: False)
    monkeypatch.setattr(lc.pruning, "prune", lambda **k: {
        "targets": [], "removed": [], "orphans": ["houston-ghost"], "cluster": False})

    res = CliRunner().invoke(cli.app, ["prune", "--orphans", "--yes"])

    assert res.exit_code == 0, res.output
    assert "houston-ghost" in res.output, res.output
    assert "Nothing to prune" not in res.output, res.output


def test_prune_waits_for_the_namespaces_it_swept_before_reclaiming_the_cluster():
    """`prune --orphans` needed running TWICE to give the cluster back.

    The sweep deletes with `--wait=false` and `_reclaim_cluster` ran immediately after
    in the same call, so `delete_cluster` refused -- correctly -- because the namespaces
    prune had just deleted were still Terminating. Observed: run 1 left houston-local
    and its control plane, run 2 twenty seconds later printed "the cluster is gone".
    About 600 MB survived the prune that had emptied it.
    """

    from houston.services import k8s
    from houston.services import lifecycle as lc

    # THROUGH THE STEPS: `prune` is an orchestrator over named steps now, and the wait
    # lives in the one that sweeps. Ordering across them is what this claims.
    seq = call_sequence(lc.pruning.prune, through=lc.pruning)
    assert "wait_namespace_gone" in seq, (
        "prune still reclaims the cluster without waiting for its own sweep")
    # The LAST `_reclaim_cluster`, because the first is the nothing-to-prune early
    # return -- there is no sweep to wait for on that path.
    assert seq.index("wait_namespace_gone") < len(seq) - 1 - seq[::-1].index(
        "_reclaim_cluster"), seq
    assert callable(k8s.wait_namespace_gone)
    # Same bound as delete_namespace's own loop rather than a second opinion.
    assert "NS_GONE_TRIES" in source_of(k8s.wait_namespace_gone)


def test_prune_reads_the_same_answer_teardown_does(monkeypatch):
    """`prune` discarded `delete_namespace`'s answer and reported the workspace pruned.

    It then called `runner.remove(name)` unconditionally -- so a namespace that could
    NOT be deleted lost the only local record that knew about it, while it and its
    PersistentVolumeClaim went on running. That is precisely the defect v0.70.9 fixed in
    `teardown`, left standing twenty lines away in the same file.
    """

    from houston.services import lifecycle as lc

    src = source_of(lc.pruning)
    assert "if not k8s.delete_namespace(" in src, (
        "prune still removes the record without checking the namespace went")
    # The record removal must be AFTER the check, not before it.
    assert source_index(src, "if not k8s.delete_namespace(") < source_index(src, "runner.remove(name)")
    assert "was NOT pruned" in src, "prune does not say when it kept a record"
    # And the cluster reclaim reports a namespace that would not go.
    assert "if not k8s.wait_namespace_gone(" in src, (
        "prune drops the wait's answer, so the single-pass reclaim degrades silently")


def test_an_orphaned_namespace_owned_by_someone_else_is_left_alone(monkeypatch,
                                                                   tmp_path):
    """K-02. `prune --orphans` deleted a stray namespace and its PVC without ever
    reading `houston.io/owner` -- and a stray is by definition what a colleague's
    workspace looks like from here, since their repro.json is on their machine.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.pruning, "prunable", lambda: [])
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc.auditsvc, "actor", lambda: "me")
    monkeypatch.setattr(lc.pruning, "_orphan_context", lambda: "c")
    monkeypatch.setattr(lc.pruning, "orphan_namespaces",
                        lambda *a, **kw: ["houston-hers", "houston-mine",
                                          "houston-unreadable"])
    monkeypatch.setattr(lc.pruning, "_reclaim_cluster", lambda emit: False)
    owners = {"houston-hers": "alice", "houston-mine": "me",
              "houston-unreadable": None}
    monkeypatch.setattr(k8s.namespace, "namespace_owner",
                        lambda ns, **kw: owners[ns])
    monkeypatch.setattr(k8s.namespace, "wait_namespace_gone", lambda *a, **kw: True)
    deleted: list[str] = []
    monkeypatch.setattr(k8s.kube, "run",
                        lambda argv, **kw: (deleted.append(argv[-2])
                                            if "delete" in argv else None)
                        or _completed(0))

    out = lc.prune(confirm=True, orphans=True)
    assert deleted == ["houston-mine"], deleted
    assert out["orphans"] == ["houston-mine"]

    # --force is the documented way to take them anyway.
    deleted.clear()
    out = lc.prune(confirm=True, orphans=True, force=True)
    assert sorted(deleted) == ["houston-hers", "houston-mine",
                               "houston-unreadable"], deleted


def test_prune_takes_the_repair_notes_of_what_it_removed_and_only_that(monkeypatch,
                                                                       tmp_path):
    """`prune` deletes a down workspace's record the way `down --volumes` does, and
    left its notes the same way -- so `doctor` advised `houston ready` on a workspace
    that `prune` had just removed.

    Only what it REMOVED: a workspace whose `down` failed keeps its record, so it keeps
    its notes, and a workspace that was never a target is not this prune's business.
    """
    import json as _json

    from houston.services import journal, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **kw: None)
    monkeypatch.setattr(lc.pruning, "orphan_namespaces", lambda *a, **kw: [])
    monkeypatch.setattr(lc.pruning, "_reclaim_cluster", lambda emit: False)
    monkeypatch.setattr(lc.pruning, "prunable", lambda: ["cmp", "kub", "stuck"])
    monkeypatch.setattr(lc.edgesvc.networks, "detach", lambda n: None)
    monkeypatch.setattr(lc.edgesvc.routes, "deregister", lambda n: None)
    monkeypatch.setattr(lc.runner.engine, "down",
                        lambda n, volumes=False: 1 if n == "stuck" else 0)
    monkeypatch.setattr(k8s.namespace, "delete_namespace", lambda *a, **k: True)
    for name, runtime in (("cmp", "docker"), ("kub", "kubernetes"),
                          ("stuck", "docker")):
        (tmp_path / "repros" / name).mkdir(parents=True)
        (tmp_path / "repros" / name / "repro.json").write_text(_json.dumps({
            "name": name, "project": f"houston-{name}", "rc_version": "8.5.1",
            "rc_image": "i", "mongo_tag": "8.0", "mongo_flavor": "official",
            "preset": "default", "root_url": "http://localhost:3001",
            "host_port": 3001, "version_source": "x",
            "extra": {"runtime": runtime, "context": "default"}}))
        journal.record(journal.CREATE_UNFINISHED, name)
        journal.record(journal.MONGO_PROFILER_ON, name)
    journal.record(journal.CREATE_UNFINISHED, "bystander")

    out = lc.prune(confirm=True, only=["cmp", "kub", "stuck"])

    assert out["removed"] == ["cmp", "kub"], out
    left = sorted((e.kind, e.workspace) for e in journal.open_entries())
    assert left == [("create_unfinished", "bystander"), ("create_unfinished", "stuck"),
                    ("mongo_profiler_on", "stuck")], \
        f"prune left the notes of what it removed, or took what it kept: {left}"
