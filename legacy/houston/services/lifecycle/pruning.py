"""What is safe to remove in bulk, and removing it.

Tier 4. `prunable` decides and `prune` acts, kept apart so the GUI can show what WOULD
go before anything does. Named `pruning` for the same reason `destroy` is not `teardown`.
"""
from __future__ import annotations

from houston import config, runner
from houston.errors import (ConflictError, DockerError, ReproError,
                            ValidationError)
from houston.services import audit as auditsvc
from houston.services import topology
from houston.services import edge as edgesvc
from houston.services.events import Emit, info, null_emit, warn
from houston.services.lifecycle import (ownership, preconditions, ready,
                                        state)

def prunable() -> list[str]:
    """Names of repros that are safe to prune: not pinned and with no containers
    (a plain `down`). Raises DockerError if docker can't be queried — deleting on
    that ambiguity would be destructive.

    DOCKER ONLY IF THERE IS A COMPOSE WORKSPACE TO ASK ABOUT. `preconditions.require_docker()` ran
    unconditionally at the top, so `prune` was refused outright on a host that uses
    only an adopted cluster and has no Docker at all -- while the loop below has asked
    Kubernetes about Kubernetes workspaces for a while. The gate contradicted the
    runtime it was gating.
    """
    me = auditsvc.actor()
    candidates = [m for m in runner.list_meta()
                  if not (m.pinned or not ownership.may_destroy(m.name, me)[0])]
    states: dict | None = None
    if any(topology.of_meta(m) != topology.KUBERNETES for m in candidates):
        preconditions.require_docker()
        states = runner.project_states()
        if states is None:
            raise DockerError("couldn't query docker compose projects - not pruning (is Docker healthy?)")
    out: list[str] = []
    for m in candidates:
        if topology.of_meta(m) == topology.KUBERNETES:
            # ASK KUBERNETES, not Docker. "Is it down" was decided by whether a
            # compose PROJECT was running, and a Kubernetes workspace never has one
            # -- so every Kubernetes workspace looked down, including a healthy one
            # serving traffic. `prune` then offered to delete N "down" repros with a
            # live workspace among them, and its compose teardown could not remove
            # any of them anyway.
            from houston.services import k8s
            context = str((m.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
            try:
                running = k8s.workload_exists(m.name, context=context)
            except DockerError:
                # NOT PRUNABLE, rather than "down". `workload_exists` now refuses to
                # guess when the cluster cannot be asked, and the safe reading of "I
                # could not tell" is to leave the workspace alone -- it is not
                # PROVABLY down, and this list is a delete list. Skipped rather than
                # raised so one unreadable workspace does not stop the others being
                # pruned, which is the same failure one function down.
                continue
            if running:
                continue
            out.append(m.name)
            continue
        if states is not None and m.project not in states:
            out.append(m.name)
    return out


def _orphan_context() -> str:
    """Which cluster to look for orphaned namespaces in.

    `k8s.CONTEXT` was hardcoded here, which meant that on a box using a cluster
    houston did not create -- the whole point of the k3s path -- `prune --orphans`
    looked for strays in a kind cluster that may not even exist, and reported none.
    """
    from houston.services import k8s
    try:
        return k8s.plan_cluster().context
    except Exception:  # noqa: BLE001 - no cluster at all: nothing to sweep
        return k8s.CONTEXT


def _reclaim_cluster(emit: Emit = null_emit) -> bool:
    """Give back houston's own cluster once nothing of ours is left in it.

    Only ever OUR cluster: `delete_cluster` takes no parameter, needs the `kind` binary,
    and refuses while any workspace namespace remains -- so a cluster somebody else
    supplied (a k3s, a minikube, anything adopted) cannot be reached from here at all.
    That is the teardown asymmetry the runtime split is built on: what houston created
    it may destroy, and what you supplied it only ever borrows a namespace in.

    Best-effort: a cluster that will not go is not a failed prune. The workspaces are
    already gone, which is what was asked for.
    """
    from houston.services import k8s
    try:
        return k8s.delete_cluster(emit=emit)
    except ReproError as exc:
        warn(emit, f"the cluster was left alone: {exc}", phase="done")
        return False
    except Exception:  # noqa: BLE001 - never let cleanup fail a successful prune
        return False


def orphan_namespaces(context: str = "") -> list[str]:
    """Namespaces labelled ours that NO local record can explain.

    A workspace whose `repro.json` is gone -- an interrupted create, a wiped
    HOUSTON_HOME, a workspace made under a different one -- leaves its namespace,
    its pods and its PersistentVolumeClaim running with nothing able to remove them:
    every houston command starts from the state directory, so the workspace is
    simply invisible. One was found holding 8Gi and five CrashLoopBackOff pods with
    no way to reach it short of `kubectl delete namespace` by hand.

    Reported, never swept automatically. On a shared cluster an unrecorded namespace
    may be a COLLEAGUE's workspace created from their own home, so deleting it
    because this machine has no record of it would destroy their work. `prune
    --orphans` is the opt-in.
    """
    from houston.services import k8s
    ctx = context or _orphan_context()
    try:
        found = k8s.workspace_namespaces(ctx)
    except Exception:  # noqa: BLE001 - no cluster is not an error here
        return []
    if found is None:
        # Could not ask. Sweeping nothing is the safe answer: the alternative is
        # `prune --orphans` reporting a clean cluster it never managed to read.
        return []
    known = {k8s.namespace_for(m.name) for m in runner.list_meta()}
    return sorted(ns for ns in found
                  if ns not in known and ns != k8s.OPERATOR_NAMESPACE)


def _sweep_orphan_namespaces(emit, force, stray):
    """Namespaces whose workspace record is gone. Separate from the workspaces themselves because one is removing what houston knows about and the other is removing what it has lost track of."""
    swept = []
    # HOISTED, and that is the fix. The sweep below resolved the context properly and
    # the wait further down used the hardcoded `k8s.CONTEXT` -- the very hardcoding
    # `_orphan_context` was introduced to remove, reintroduced one block later. On any
    # cluster houston did not create the two disagreed, so the wait asked a context
    # that does not exist and read the failure as "gone". One variable, so they cannot
    # drift apart again.
    ctx = _orphan_context()
    if stray:
        from houston.services import k8s
        me = auditsvc.actor()
        for ns in stray:
            # THE LABEL IS READ, and it is the only evidence there is. A stray is by
            # definition a namespace no LOCAL record explains -- which on a shared
            # cluster is exactly what a colleague's workspace looks like, because
            # their `repro.json` is on their machine. `houston.io/owner` is stamped
            # on the namespace for this, and the sweep deleted it without ever
            # looking: measured, a namespace labelled `owner=alice` removed with
            # `✓ removed 1 orphaned namespace(s)` and its PersistentVolumeClaim
            # with it.
            owner = k8s.namespace_owner(ns, context=ctx)
            if owner is None and not force:
                warn(emit, f"cannot read who namespace {ns} belongs to, so it is "
                           f"left alone — `--force` sweeps it unread", phase="done")
                continue
            if owner and owner != me and not force:
                warn(emit, f"namespace {ns} belongs to {owner!r}, not to you — left "
                           f"alone. Ask {owner}, or `--force` to sweep it anyway",
                     phase="done")
                continue
            res = k8s.kube.run(["kubectl", "--context", ctx, "delete", "namespace",
                           ns, "--wait=false"], timeout=k8s.APPLY_TIMEOUT,
                          own=k8s.is_ours(ctx))
            if res.returncode == 0:
                swept.append(ns)
                info(emit, f"removed orphaned namespace {ns}", phase="done")
            else:
                warn(emit, f"could not remove orphaned namespace {ns}: "
                           f"{(res.stderr or '').strip()[:120]}", phase="done")
    # THE SWEEP USED `--wait=false`, AND THE RECLAIM RAN IMMEDIATELY AFTER. So
    # `delete_cluster` refused -- correctly -- because the namespaces prune had just
    # deleted were still Terminating, and reclaiming the cluster took a SECOND prune
    # twenty seconds later. About 600 MB survived the prune that emptied it, which is
    # the memory this tool tells people to worry about. Waiting for what we just
    # deleted is the same lesson `delete_namespace` records against itself.
    if swept:
        from houston.services import k8s
        for ns in swept:
            # SAID, when it does not go. The cluster reclaim below refuses while any
            # workspace namespace remains, so dropping this answer turned the
            # single-pass prune back into the two-run behaviour it was fixed for --
            # silently, which is the part worth fixing.
            if not k8s.wait_namespace_gone(ns, context=ctx, emit=emit):
                warn(emit, f"namespace {ns} is still terminating, so the cluster is "
                           f"left alone this pass — `houston prune` again once "
                           f"`kubectl get ns` is clear.", phase="done")
    return swept


def _prune_kubernetes(name: str, emit: Emit, removed: list) -> None:
    """The same dispatch `teardown` makes, for the same reason.

    `prune` called `docker compose down` on a workspace that has no compose project,
    which always failed -- so a Kubernetes workspace could be listed for pruning and
    never actually pruned, and its namespace and PersistentVolumeClaim stayed on the
    cluster. This path always finishes the workspace itself; the caller does nothing
    more with it.
    """
    # The same dispatch `teardown` makes, for the same reason: this
    # called `docker compose down` on a workspace that has no compose
    # project, which always failed -- so a Kubernetes workspace could
    # be listed for pruning and never actually pruned, and its
    # namespace and PersistentVolumeClaim stayed on the cluster.
    from houston.services import k8s
    meta = runner.read_meta(name)
    context = str((meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    for ui_pid in (meta.extra or {}).get("scenario_forwards", {}).values():
        try:
            ready._stop_port_forward(
                int(ui_pid), namespace=k8s.namespace_for(name))
        except (TypeError, ValueError):
            pass
    pid = (meta.extra or {}).get("port_forward_pid")
    if pid:
        ready._stop_port_forward(int(pid),
                           namespace=k8s.namespace_for(name))
    # THE ANSWER IS READ, exactly as `teardown` reads it. This
    # discarded it and then removed the local record and reported the
    # workspace pruned regardless -- which is the defect v0.70.9 fixed
    # in `teardown` and left standing here, twenty lines away. A
    # namespace that could not be deleted therefore lost the only
    # record that knew about it, while it and its PersistentVolumeClaim
    # went on running.
    if not k8s.delete_namespace(name, context=context, volumes=True,
                                emit=emit):
        warn(emit, f"{name!r} was NOT pruned: its namespace is not "
                   f"confirmed gone, so the record is kept. "
                   f"`kubectl get ns {k8s.namespace_for(name)}`, then "
                   f"prune again.", phase="done")
        return
    # Same route the Kubernetes branch of `teardown` now drops, for
    # the same reason: `prune` bypasses `teardown()` entirely, so it
    # has to do this itself or the edge is left pointing at a
    # namespace that no longer exists. The Compose branch below has
    # always had this line; this branch never did.
    edgesvc.deregister(name)
    runner.remove(name)
    # Its repair notes with it, as `teardown` does: see `journal.WORKSPACE_KINDS`.
    from houston.services import journal
    journal.clear_workspace(name)
    state._clear_default_if(name)
    removed.append(name)
    info(emit, f"pruned {name!r}", phase="done")


def _remove_one_workspace(name: str, emit: Emit, removed: list) -> None:
    """One workspace, and the reason a failure on it must not stop the rest.

    `prune` is a bulk operation somebody runs to reclaim a box, so a single
    workspace that will not come down has to be reported and stepped over --
    stopping there would leave the rest of the list untouched and the reader with
    one error and no idea what else is still holding disk.
    """
    try:
        with runner.repro_lock(name, timeout=5.0):
            if topology.of_repro(name) == topology.KUBERNETES:
                _prune_kubernetes(name, emit, removed)
                return
            # Detach BEFORE `down`: compose cannot remove a network that still
            # has an active endpoint, and the attached edge is one.
            edgesvc.detach(name)
            if runner.down(name, volumes=True) != 0:
                warn(emit, f"could not clean up {name!r} - skipping", phase="done")
                return
            # prune bypasses teardown(), so it drops the route itself or the
            # edge is left pointing at nothing.
            edgesvc.deregister(name)
            runner.remove(name)
            # Under the lock, like the removal: see `journal.clear_workspace`.
            from houston.services import journal
            journal.clear_workspace(name)
    except ConflictError:
        warn(emit, f"{name!r} is in use by another operation - skipping",
             phase="done")
        return
    except DockerError as exc:
        # ONE UNREADABLE WORKSPACE MUST NOT END THE SWEEP. `delete_namespace`
        # raises DockerError when the cluster cannot be asked, and only
        # ConflictError was caught -- so the first unreadable workspace aborted
        # prune entirely and every later one was silently left, which is the
        # reported "prune doesn't work". Measured: targets ['k8spf','k8stls'],
        # the second genuinely prunable and never touched.
        warn(emit, f"{name!r} could not be removed ({exc}) - skipping",
             phase="done")
        return
    state._clear_default_if(name)
    removed.append(name)
    info(emit, f"pruned {name!r}", phase="done")


def _remove_each_workspace(emit, removed, targets):
    """Each workspace in turn, and the reason a failure on one must not stop the rest."""
    for name in targets:
        _remove_one_workspace(name, emit, removed)


def prune(*, confirm: bool = False, orphans: bool = False, force: bool = False,
          only: list[str] | None = None, emit: Emit = null_emit) -> dict:
    """Delete every `down` workspace. `only` narrows it to a list already shown.

    THE CONFIRMATION AND THE ACTION HAD DIFFERENT TARGET LISTS. `cli.prune` computed
    `prunable()` to print the prompt and this recomputed it after the answer, so on a
    shared box a workspace that went `down` while somebody read the prompt was deleted
    without ever appearing on screen -- and the ownership gate does not help, because
    with the default `owner` policy an admin passes for everybody. README says "`prune`
    lists what it will delete".

    `only` is the list that was shown; anything that has appeared since is skipped and
    named. Anything that has GONE since is simply absent from the intersection.
    """
    targets = prunable()
    if only is not None:
        shown = set(only)
        appeared = [t for t in targets if t not in shown]
        targets = [t for t in targets if t in shown]
        for t in appeared:
            warn(emit, f"{t!r} became prunable after the list was shown and is left "
                       f"alone — run prune again to include it", phase="done")
    stray = orphan_namespaces() if orphans else []
    if not targets and not stray:
        # Still worth asking about the CLUSTER. With every workspace gone, houston's
        # own kind cluster is a 514 MiB control plane holding nothing -- and both the
        # README and the agent skill said `prune` reclaims it, which nothing did:
        # `delete_cluster` had exactly one caller, a failed create's rollback. So the
        # documented promise was never kept, and the memory the tool tells you to worry
        # about was the memory it left behind.
        return {"targets": [], "removed": [], "orphans": [],
                "cluster": _reclaim_cluster(emit)}
    if not confirm:
        raise ValidationError(f"prune deletes {len(targets)} down repro(s) incl. data - pass confirm=true")
    # The NAMESPACES go in the subject too. Recording only `targets` meant a sweep that
    # deleted three namespaces and no local records wrote `- prune - system ok`, with no
    # trace anywhere of what it destroyed -- and on a shared cluster orphan_namespaces()
    # is explicit that one of those may be a colleague's.
    subject = ",".join(targets + [f"ns:{ns}" for ns in stray])
    auditsvc.record("prune", subject)
    removed = []
    _remove_each_workspace(emit, removed, targets)
    swept = _sweep_orphan_namespaces(emit, force, stray)
    return {"targets": targets, "removed": removed, "orphans": swept,
            "cluster": _reclaim_cluster(emit)}
