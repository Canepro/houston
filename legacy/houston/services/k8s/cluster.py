"""Bringing houston's OWN cluster into existence, and taking it away.

Tier k3. The only cluster this package may create is the local one; everything else is
adopted. `delete_cluster` takes NO cluster parameter at all, deliberately -- it can only
ever mean ours, and a parameter would be an invitation to pass somebody else's.
"""
from __future__ import annotations

from houston.errors import ConflictError
from houston.errors import CreateFailedError
from houston.errors import DockerError
from houston import runner

from houston.errors import PreflightError
from houston.services.events import Emit, info, null_emit
from houston.services.k8s import ask
from houston.services.k8s import capabilities
from houston.services.k8s import context as kubectx
from houston.services.k8s import exec as kubeexec
from houston.services.k8s import reachability
from houston.services.k8s import tools
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, CLUSTER_NAME, CONTEXT

#: Lock name for cluster creation. Not a valid repro name (`sanitize` strips the
#: underscores), so it can never collide with a workspace's own lock.
CLUSTER_LOCK = "__cluster__"

#: Creating a cluster pulls a node image on first use and waits for the control
#: plane. Nothing like the 8s a probe gets.
CREATE_TIMEOUT = 600.0

DELETE_TIMEOUT = 120.0

def ensure_kubeconfig(plan, emit: Emit = null_emit) -> str:
    """The context to use, with houston's OWN kubeconfig guaranteed to know it.

    `ensure_cluster` was called only when a cluster had to be created -- and its own
    docstring says the export must happen either way, naming this exact case: "a
    different or fresh HOUSTON_HOME". So the comment described the fix and the call
    site defeated it. With a kind cluster already up and a fresh home, every command
    failed with `context was not found for specified context: kind-houston-local`
    and could not self-heal, because the only thing that writes that context ran
    later -- or, when the cluster existed, never.

    CLAUDE.md tells anyone writing a script to `export HOUSTON_HOME=$(mktemp -d)`,
    so this was reachable by following our own instructions once a cluster existed.

    For a cluster houston did not create there is nothing to export: the user's own
    kubeconfig already names it, and rewriting it is not ours to do.
    """
    if plan.create or plan.context == CONTEXT:
        # ALREADY DONE IS DONE. Two call sites reach this per create -- the preflight
        # in `lifecycle` needs the kubeconfig before it asks about the namespace, and
        # `create_workspace` needs the context -- so the banner appeared twice and,
        # worse, `ensure_cluster` took `repro_lock(CLUSTER_LOCK)` twice, doubling the
        # window a concurrent create waits on provisioning. Cheap to skip: if our own
        # kubeconfig already names this context and the API server answers, there is
        # nothing left for the export to do. A fresh HOUSTON_HOME fails both halves
        # and still exports, which is the case that made this function necessary.
        if not plan.create and kubectx.cluster_context() == plan.context \
                and reachability.reachable(plan.context):
            return plan.context
        return ensure_cluster(emit=emit)
    return plan.context

def _create_under_lock(emit, kubeconfig):
    """Create the shared kind cluster, with one process doing it at a time."""
    with runner.repro_lock(CLUSTER_LOCK, timeout=CREATE_TIMEOUT):
        if CLUSTER_NAME in kubectx.clusters()[0]:
            info(emit, f"reusing cluster {CLUSTER_NAME}", phase="provision")
        else:
            info(emit, f"creating cluster {CLUSTER_NAME} — first time on this "
                       "machine, so this pulls a node image",
                 phase="provision", pct=5)
            kubeexec.owned_env()          # make the directories before kind writes into them
            res = kube.run(["kind", "create", "cluster", "--name", CLUSTER_NAME,
                       "--kubeconfig", str(kubeconfig)],
                      timeout=CREATE_TIMEOUT, own=True)
            if res.returncode != 0:
                combined = f"{res.stdout or ''}\n{res.stderr or ''}".lower()
                # A create that lost a race to something not holding this lock
                # (a manual `kind create`) is success, not failure.
                if "already exist" not in combined:
                    raise CreateFailedError(
                        f"could not create the cluster {CLUSTER_NAME}: "
                        + ask.why(res))


def ensure_cluster(emit: Emit = null_emit) -> str:
    """Create houston's cluster if it is not there, and return its context.

    Serialised with the SAME lock every other mutating operation uses
    (`runner.repro_lock`), rather than a second lock of its own. Two simultaneous
    `up`s would otherwise both see no cluster and both run `kind create`, and the
    second fails with "node(s) already exist". The re-check inside the lock means
    the loser of the race reuses rather than retries -- concurrent workspaces are
    the entire point of one-cluster-many-namespaces, so the lock has to hold.

    Nothing about this touches `~/.kube/config`: `--kubeconfig` is passed
    explicitly AND the environment is redirected, because kind writes the file it
    is given and also honours KUBECONFIG for the context switch.
    """
    if not tools.which("kind"):
        raise PreflightError(
            "kind is not installed, so houston cannot create a cluster. Install "
            "kind, or point kubectl at a cluster you already have.")
    kubeconfig = kubeexec.owned_kubeconfig()
    _create_under_lock(emit, kubeconfig)
    # ALWAYS export, not only after creating. `kind get clusters` reads Docker, so
    # it sees a cluster that houston's OWN kubeconfig knows nothing about -- which
    # happens whenever the cluster outlives the kubeconfig: a different or fresh
    # HOUSTON_HOME, a deleted config, or a cluster someone made by hand. Then
    # "reusing cluster" is followed by every kubectl call going to localhost:8080
    # and the create failing with "the API server is not answering" about a cluster
    # that is perfectly healthy.
    #
    # PR #3 does this and says why: "refresh the owned kubeconfig for both new and
    # pre-existing clusters". I ported the create and left the export behind.
    export = kube.run(["kind", "export", "kubeconfig", "--name", CLUSTER_NAME,
                  "--kubeconfig", str(kubeconfig)], timeout=APPLY_TIMEOUT, own=True)
    if export.returncode != 0:
        raise CreateFailedError(
            f"cluster {CLUSTER_NAME} exists but its kubeconfig could not be read: "
            + ask.why(export))
    context = kubectx.cluster_context()
    if not reachability.reachable(context):
        raise CreateFailedError(
            f"cluster {CLUSTER_NAME} was created but its API server is not "
            f"answering at {context!r}. `kind delete cluster --name "
            f"{CLUSTER_NAME}` and try again.")
    info(emit, f"cluster {CLUSTER_NAME} ready at {context}", phase="provision")
    return context

def cluster_reclaimable() -> bool:
    """Whether houston's own cluster exists and holds nothing of ours.

    Mirrors `delete_cluster`'s own guard so a caller can ASK before offering to reclaim,
    rather than finding out by being refused.

    UNREACHABLE IS NOT EMPTY. This used to return True for a cluster that exists and
    does not answer, reasoning that `kind delete` talks to Docker rather than to the
    API server so nothing stops it. That is true and it is the wrong conclusion: a
    control plane that cannot be reached is the case where houston knows LEAST about
    what it would destroy, not most. A paused container, a Docker restart or a laptop
    resuming all produce it, and `prune` then stated the cluster was "empty" and
    deleted it -- measured, with five Running pods and an 8 Gi Bound PVC in it.

    This module's governing rule already says so one function down: "I could not ask"
    and "it is not there" are different answers and only one of them is safe to act
    on. `--force` is how a genuinely wedged cluster is reclaimed, and it stays a
    thing the operator types.
    """
    if not tools.which("kind") or CLUSTER_NAME not in kubectx.clusters()[0]:
        return False
    ctx = kubectx.cluster_context()
    if not reachability.reachable(ctx):
        return False
    # `None` (could not ask) must NOT read as "empty and therefore reclaimable".
    held = capabilities.workspace_namespaces(ctx)
    return held is not None and not held

def delete_cluster(*, force: bool = False, emit: Emit = null_emit) -> bool:
    """Delete houston's own cluster. Returns False if there was nothing to delete.

    Refuses while any workspace namespace is still in it, unless forced. On a
    shared box the cluster holds other people's workspaces, and `prune` reclaiming
    the cluster out from under a colleague mid-ticket is the failure this guards --
    the namespaces carry `houston.io/owner`, so the refusal can say whose.

    Only ever CLUSTER_NAME. There is no parameter for which cluster to delete,
    because a delete that can be pointed anywhere eventually is.
    """
    if not tools.which("kind"):
        return False
    with runner.repro_lock(CLUSTER_LOCK, timeout=DELETE_TIMEOUT):
        if CLUSTER_NAME not in kubectx.clusters()[0]:
            return False
        context = kubectx.cluster_context()
        # THE GUARD IS NOT INSIDE `reachable()`. It used to be, so an unreachable
        # cluster skipped the whole ownership check -- including the "could not
        # read" refusal directly below, which exists for exactly this case and
        # could never fire in it. `kind delete` talks to Docker, so unreachability
        # was no obstacle: a paused control plane holding live workspaces was
        # deleted with one `prune --yes`, the prompt calling it empty.
        if not force:
            if not reachability.reachable(context):
                raise ConflictError(
                    f"cluster {CLUSTER_NAME} exists but is not answering, so what "
                    f"it holds cannot be read — it may hold workspaces, including "
                    f"somebody else's. Start it (`docker start "
                    f"{CLUSTER_NAME}-control-plane`) and try again, or pass --force "
                    f"to delete it and everything in it unread.")
            live = capabilities.workspace_namespaces(context)
            if live is None:
                raise ConflictError(
                    f"cannot tell what cluster {CLUSTER_NAME} still holds: the "
                    f"namespace list could not be read. Refusing to delete a "
                    f"cluster that may hold somebody's workspace — check the "
                    f"cluster, or pass --force to take it and everything in it.")
            if live:
                raise ConflictError(
                    f"cluster {CLUSTER_NAME} still holds {len(live)} workspace "
                    f"namespace(s): {', '.join(sorted(live)[:5])}. Remove those "
                    "workspaces first, or pass --force to take the cluster and "
                    "everything in it.")
        info(emit, f"deleting cluster {CLUSTER_NAME}", phase="teardown")
        res = kube.run(["kind", "delete", "cluster", "--name", CLUSTER_NAME],
                  timeout=DELETE_TIMEOUT, own=True)
        if res.returncode != 0:
            raise DockerError(f"could not delete the cluster {CLUSTER_NAME}: "
                              + ask.why(res))
    return True
