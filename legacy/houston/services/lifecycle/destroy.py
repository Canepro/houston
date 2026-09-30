"""Removing a workspace: its containers or its namespace, and its record.

Tier 4, and named `destroy` rather than `teardown` because the package also exports a
function called `teardown`, and a module that shadows a symbol it has to export is
unreachable from the façade the moment anything imports it.
"""
from __future__ import annotations

import shutil

from houston import config, runner
from houston.errors import ConflictError, DockerError, ValidationError
from houston.services import audit as auditsvc
from houston.services import topology
from houston.services import edge as edgesvc
from houston.services.events import Emit, info, null_emit, warn
from houston.services.lifecycle import (naming, ownership, preconditions,
                                        ready, state)
from houston.services.lifecycle.types import _INTERACTIVE_LOCK_WAIT

def _remove_the_cluster_side(context, emit, k8s, meta, target, volumes):
    """Everything the namespace held that outlives it: the chart release, the operator, and the cluster itself when houston made it."""
    if volumes:
        # AFTER the namespace, never before: deleting it took this workspace's
        # MongoDBCommunity with it while the operator was still there to clear
        # the finalizer. `--volumes` means delete everything, so an operator
        # left running afterwards is the wrong answer -- and `remove_operator`
        # refuses while any other workspace still needs it.
        ns = k8s.namespace_for(target)
        # The GRAFANA forward, which `monitor --off` stops and this path did not.
        # It targets a deployment in `houston-system`, so unlike the workspace's
        # own forward it survives the workspace -- and it went on holding :5050
        # after the workspace was destroyed, so the next `up --monitor` was
        # refused for a port held by a corpse. Measured exactly that way. Only on
        # `--volumes`: after a plain `down` the stack and its label are kept on
        # purpose, and Grafana stays reachable for a workspace coming back.
        gpid = (meta.extra or {}).get("grafana_pid")
        if gpid:
            ready._stop_port_forward(int(gpid),
                               namespace=k8s.MONITORING_NAMESPACE)
        # RETURN DELIBERATELY NOT READ, and this is the one place on this
        # path where that is right. An audit flagged it as the same defect as
        # the four fixed in v0.76.4 and it is not: `remove_operator` returns
        # False for THREE reasons -- not installed, still wanted by another
        # workspace, and a failed uninstall -- and the first two are the
        # normal outcome of a shared resource being shared. Only the third is
        # a problem, and it already warns at the point of failure, with the
        # helm reason. Branching on the bool here would report "the operator
        # could not be removed" every time it was correctly left up for a
        # second workspace. Checked by reading both functions: a false
        # warning on the everyday path is worse than no warning.
        k8s.remove_operator(context=context, excluding=ns, emit=emit)
        # AND the monitoring stack, which had the same hole and is far more
        # expensive: ten pods and ~840 MB left running after the workspace that
        # asked for them was destroyed. `remove_monitoring` has always been able
        # to do this -- reference-counted on a namespace label, Grafana's custom
        # resources deleted before the operator that finalises them -- and only
        # `monitor --off` ever called it, so `down --volumes` walked past it.
        # On Compose there was nothing to fix: the stack is part of the
        # workspace's own compose project and goes down with it.
        # Same, and more so: `remove_monitoring` returns True even when the
        # uninstall failed, because the release is gone either way and it has
        # already warned and cleared the finalizers itself.
        k8s.remove_monitoring(context=context, excluding=ns, emit=emit)
        # CHECKED, not assumed. `ignore_errors=True` means a record that
        # could not be removed -- a permission problem, a file held open --
        # is silently left behind, and the success line two branches below
        # then says "and the local record". Saying so is the whole difference
        # between a stale record somebody knows about and one they do not.
        shutil.rmtree(runner.workspace(target), ignore_errors=True)
        if runner.workspace(target).exists():
            warn(emit, f"the namespace is gone but {runner.workspace(target)} "
                       f"could not be removed, so `list` will still show "
                       f"{target!r}. Remove that directory by hand.",
                 phase="teardown")
        # Its repair notes go too, whether or not the directory did: what they repair
        # went with the namespace, and a record removed by hand would strand them.
        from houston.services import journal
        journal.clear_workspace(target)
        state._clear_default_if(target)


def _stop_the_forwards(k8s, meta, target):
    """The port-forwards this workspace was published on. They outlive the namespace because they are processes on THIS box, not cluster objects."""
    pid = (meta.extra or {}).get("port_forward_pid")
    if pid:
        ready._stop_port_forward(int(pid), namespace=k8s.namespace_for(target))
    # A preset's UI forwards too, or `down` leaves 8082 bound to a namespace
    # that no longer exists -- and the NEXT workspace using that preset finds
    # the port taken by a corpse.
    for ui_pid in (meta.extra or {}).get("scenario_forwards", {}).values():
        try:
            ready._stop_port_forward(int(ui_pid),
                               namespace=k8s.namespace_for(target))
        except (TypeError, ValueError):
            pass


def _drop_the_edge_route(emit, k8s, target, volumes):
    """A route left behind points at something that is gone, so the hostname 502s instead of 404ing and nobody can reuse the name. After the cluster work, because a teardown that could not confirm the namespace is gone has not torn the workspace down."""
    # THE EDGE ROUTE, which this branch returned without dropping. The
    # Compose path twenty lines below has always done it, for a reason that
    # applies identically here: a route left behind points at something that
    # is gone, so the hostname 502s instead of 404ing and the name can never
    # be reused by anyone else. Placed AFTER the cluster work and after the
    # early return above, because a teardown that could not confirm the
    # namespace is gone has not torn the workspace down and its name should
    # go on answering.
    #
    # No `detach`: that disconnects a Docker network a Kubernetes workspace
    # does not have. Deregistering is the whole of it.
    edgesvc.deregister(target)
    # Docker's nouns are wrong here. "containers, data volume, and
    # record" for a workspace that has a namespace and a PVC says nothing
    # about what actually went away -- and `helm uninstall` does NOT delete
    # a PVC, so the difference between these two paths is precisely the
    # thing the user needs told.
    if volumes:
        info(emit, f"{target!r} removed — namespace "
                   f"{k8s.namespace_for(target)}, its "
                   "PersistentVolumeClaim and the local record",
             phase="done")
    else:
        info(emit, f"{target!r} down — the {k8s.RELEASE} release is "
                   f"uninstalled; namespace {k8s.namespace_for(target)} "
                   "and its PersistentVolumeClaim are KEPT, so `up` again "
                   "reuses the data. `down --volumes` deletes it.",
             phase="done")


def _teardown_kubernetes(target: str, volumes: bool, emit: Emit) -> dict:
    """Remove the namespace, or just stop what is in it."""
    # Deliberately BELOW the confirmation, the ownership gate and the audit
    # record: all three are about whose data is being destroyed, which does
    # not depend on the runtime, and duplicating them here is how one
    # runtime quietly loses a check the other keeps. Inside the lock for
    # the same reason compose is.
    #
    # Without this dispatch, `down` reached for a compose project that is
    # not there and answered "no configuration file provided: not found" --
    # a workspace that could be CREATED and never removed, which is worse
    # than not being able to create one.
    from houston.services import k8s
    meta = runner.read_meta(target)
    context = str((meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    _stop_the_forwards(k8s, meta, target)
    found = k8s.delete_namespace(target, context=context, volumes=volumes,
                                 emit=emit)
    # BRANCHED ON, at last. This value was returned to the caller as
    # `{"found": ...}` and read by nobody -- not the CLI, not the web layer,
    # not app.js -- so `--volumes` deleted the local record, the shared
    # operator and the monitoring stack whatever it said, and reported the
    # namespace and its PersistentVolumeClaim as removed. `delete_namespace`
    # now means "confirmed absent" by True and raises when it could not ask,
    # so False here is either a namespace that was already gone or one still
    # terminating -- and neither is a reason to destroy the only record of it.
    if volumes and not found:
        warn(emit, f"{target!r}: the namespace is not confirmed gone, so the "
                   f"local record is KEPT. Nothing else was removed -- the "
                   f"operator and any monitoring stack are untouched. Re-run "
                   f"`houston down --name {target} --volumes` once "
                   f"`kubectl get ns {k8s.namespace_for(target)}` says it is "
                   f"absent.", phase="teardown")
        return {"name": target, "removed": False, "found": found,
                "runtime": topology.KUBERNETES}
    _remove_the_cluster_side(context, emit, k8s, meta, target, volumes)
    _drop_the_edge_route(emit, k8s, target, volumes)
    return {"name": target, "removed": volumes, "found": found,
            "runtime": topology.KUBERNETES}


def _teardown_compose(target: str, volumes: bool) -> None:
    """Detach from the edge, bring the project down, and forget the name."""
    # BEFORE `down`, not after: compose cannot remove a network that still has
    # an active endpoint, and the edge attached to it is exactly that -- so
    # leaving it attached makes `down` fail with "network has active
    # endpoints" and strands the workspace half torn down.
    edgesvc.detach(target)
    if runner.down(target, volumes=volumes) != 0:
        raise DockerError(f"`docker compose down` failed for {target!r}")
    # A route left behind points the edge at a container that no longer
    # exists, so that hostname would 502 instead of 404 -- and the name could
    # never be reused by anyone else.
    edgesvc.deregister(target)
    if volumes:
        runner.remove(target)
        # A note about a workspace that is gone advises work nobody can do: `doctor`
        # kept telling people to `houston ready` a workspace this had just deleted.
        from houston.services import journal
        journal.clear_workspace(target)
        state._clear_default_if(target)


def teardown(name: str, *, volumes: bool = False, confirm: bool = False, emit: Emit = null_emit) -> dict:
    target = naming.resolve_name(name)
    preconditions.require_engine(target)
    if volumes and not confirm:
        raise ValidationError(f"deleting {target!r}'s data volume and record is irreversible - "
                              "pass confirm=true")
    if volumes:
        allowed, why = ownership.may_destroy(target, auditsvc.actor())
        if not allowed:
            auditsvc.record("down-volumes", target, outcome="denied")
            raise ConflictError(why)
    # Recorded BEFORE the work, not after: a teardown that dies half way through
    # has still destroyed containers, and that is exactly the event someone will
    # come looking for. Auditing here rather than at the route/command covers the
    # CLI and the GUI at once -- the single web-side call site missed both of the
    # destructive operations entirely.
    auditsvc.record("down-volumes" if volumes else "down", target)
    # Locked: `down` during a create races `docker compose up` and leaves orphaned
    # containers behind -- the exact corruption repro_lock exists to prevent -- and
    # `down --volumes` during an upgrade destroys the workspace while its
    # pre-upgrade bundle survives, so `upgrade --rollback` can never find it again.
    with runner.repro_lock(target, timeout=_INTERACTIVE_LOCK_WAIT):
        # The two runtimes answer DIFFERENTLY, and always did: the Kubernetes path
        # reports `found` and its own `runtime`, and says its own "done" line, because
        # what it removed is a namespace rather than a set of containers. Returning from
        # inside the lock is deliberate -- the compose line below would otherwise be said
        # about a workspace that has none.
        if topology.of_repro(target) == topology.KUBERNETES:
            return _teardown_kubernetes(target, volumes, emit)
        _teardown_compose(target, volumes)
    info(emit, f"{target!r} {'removed' if volumes else 'down (data kept)'}", phase="done")
    return {"name": target, "removed": volumes}
