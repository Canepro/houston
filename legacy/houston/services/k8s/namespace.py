"""One namespace per workspace, and the rules for taking one away.

Tier k3. Selection is BY LABEL: `namespace_labels` reads what the cluster says rather than
matching a name prefix, because a prefix match once made a namespace somebody else
created eligible for teardown. A namespace that cannot be CONFIRMED gone is not gone.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.errors import DockerError
from houston import runner

import time

from houston.errors import ConflictError
from houston.services.events import Emit, info, null_emit, warn
from houston.services.k8s import ask
from houston.services.k8s import context as kubectx
from houston.services.k8s import names as vocab
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, CLUSTER_NAME, NS_GONE_INTERVAL, NS_GONE_TRIES, OWNER_LABEL_KEY, OWNER_LABEL_VALUE, OWNER_OF_LABEL, OWNER_SELECTOR, RELEASE, WORKSPACE_LABEL

# --- a workspace: namespace, MongoDB, the chart ----------------------------------















def namespace_for(name: str) -> str:
    """The namespace this workspace's objects ACTUALLY live in.

    RECORDED, not derived, for the same reason as `runner.project_name`: a
    namespace cannot be renamed in place, so once objects exist the prefix that
    minted them is history rather than a description. `create_workspace` writes
    this into `extra["namespace"]` and `lifecycle` already prefers the recorded
    value in two places; deriving it everywhere else meant a changed prefix would
    leave `down` deleting a namespace that was never created while the real one
    kept its pods, its PVCs and its port-forward.
    """
    return runner.recorded(name, "namespace") or vocab.mint_namespace(name)

def _labels(name: str, owner: str = "") -> dict[str, str]:
    """The labels every resource houston creates carries.

    `managed-by` is what teardown selects on. `workspace` and `owner` are what make
    a refusal specific -- "the cluster still holds 2 namespaces" is actionable only
    if it can say whose.
    """
    out = {OWNER_LABEL_KEY: OWNER_LABEL_VALUE, WORKSPACE_LABEL: name}
    if owner:
        out[OWNER_OF_LABEL] = owner
    return out

def _refuse_foreign_namespace(ns: str, name: str, labels: dict[str, str],
                              owner: str) -> None:
    """Raise unless `labels` prove this namespace is this workspace's."""
    if labels.get(OWNER_LABEL_KEY) != OWNER_LABEL_VALUE:
        raise ConflictError(
            f"namespace {ns} already exists and is not managed by houston, so it "
            f"will not be adopted -- `down --volumes` deletes a namespace and its "
            f"volumes, and houston cannot tell a namespace an older houston made "
            f"from one somebody else made. Use a different --name, or delete it "
            f"yourself first: kubectl delete namespace {ns}")
    theirs = labels.get(WORKSPACE_LABEL, "")
    if theirs and theirs != name:
        raise ConflictError(
            f"namespace {ns} belongs to houston workspace {theirs!r}, not {name!r}. "
            f"Two workspaces cannot share a namespace; use a different --name")
    held_by = labels.get(OWNER_OF_LABEL, "")
    if held_by and held_by != owner:
        _refuse_foreign_owner(ns, held_by, owner)


def _refuse_foreign_owner(ns: str, held_by: str, owner: str) -> None:
    """Explain why a namespace owned by another user cannot be adopted."""
    # `owner` EMPTY IS NOT A MATCH. This was `held_by and owner and ...`, so a box
    # with no accounts -- where `_cli_actor()` returns "" because team mode is
    # opt-in -- skipped the comparison entirely and adopted a namespace stamped
    # with somebody else's name. Found by doing it on a live cluster: the label
    # survived (`--overwrite` only sets the keys it is given) and Rocket.Chat was
    # installed into their namespace anyway.
    #
    # Not knowing who you are is not evidence that you are the owner. An owner
    # label can only have been written by a box with accounts, so meeting one
    # while unable to identify yourself is exactly the case to refuse -- and
    # HOUSTON_USER is the way to answer it.
    # An EMPTY owner means HOUSTON_USER was not set, which is not the same as
    # "this box has no accounts" -- on a box with adm/mem/ro this said there were
    # none, and pointed at creating an account rather than at the variable the very
    # next sentence recommends. The refusal was right; the reason was not.
    # TEAM MODE OFF IS NOT THE SAME AS THE VARIABLE BEING UNSET, and saying the
    # wrong one made the namespace permanently un-adoptable. `_cli_actor()`
    # returns "" whenever this box has no GUI accounts -- even with
    # HOUSTON_USER set, which is deliberate and is what makes team mode opt-in.
    # So on such a box the message said "HOUSTON_USER is not set" while it WAS,
    # and the remedy it named, setting that same variable, produced the identical
    # refusal. Verified: `HOUSTON_USER=alice` (the true owner) → same error
    # verbatim. Whichever case it is, the remedy now works.
    from houston.services import users as usersvc
    try:
        team_mode = usersvc.any_users()
    except Exception:  # noqa: BLE001 - unreadable user file: assume the safe case
        team_mode = True
    if owner:
        mine = f"you are {owner!r}"
        remedy = (f"Use a different --name, or identify yourself with "
                  f"`HOUSTON_USER={held_by} houston ...` if it is yours")
    elif team_mode:
        mine = "houston cannot tell who you are, because HOUSTON_USER is not set"
        remedy = (f"Use a different --name, or identify yourself with "
                  f"`HOUSTON_USER={held_by} houston ...` if it is yours")
    else:
        mine = ("this box has no houston accounts, so it has no way to say who "
                "you are — HOUSTON_USER alone is not enough, because names are "
                "only honoured once accounts exist")
        remedy = (f"Use a different --name, or make the account and claim it: "
                  f"`houston users add {held_by}` then "
                  f"`HOUSTON_USER={held_by} houston ...`")
    raise ConflictError(
        f"namespace {ns} belongs to {held_by!r} on this cluster and {mine}. "
        f"Adopting it would make `down --volumes` delete their data. {remedy}")


def _cluster_loss_proves_namespace_absent(ns: str, context: str,
                                          emit: Emit) -> bool:
    """Whether an unreachable namespace belonged to a provably deleted cluster."""
    if vocab.is_ours(context):
        names, probe_failed = kubectx.clusters()
        if not probe_failed and CLUSTER_NAME not in names:
            info(emit, f"cluster {CLUSTER_NAME!r} no longer exists, so namespace "
                       f"{ns} went with it — removing the local record",
                 phase="teardown")
            return True
    return False


def _labels_for_deletion(ns: str, context: str, emit: Emit):
    """Read namespace ownership, distinguishing cluster deletion from reachability."""
    try:
        return namespace_labels(ns, context=context), False
    except DockerError:
        # A DELETED CLUSTER IS NOT AN UNREACHABLE ONE. Its kubeconfig entry survives,
        # but a namespace cannot outlive a cluster that is provably absent. A failed
        # kind probe remains "I could not ask" and is re-raised.
        if _cluster_loss_proves_namespace_absent(ns, context, emit):
            return None, True
        raise


def _delete_namespace_and_volumes(name: str, ns: str, context: str, own: bool,
                                  emit: Emit, sleep) -> bool:
    """Delete a namespace and confirm that its pods and volumes are gone."""
    pvcs = workspace_pvcs(name, context=context)
    info(emit, f"deleting namespace {ns}: {len(pvcs)} volume(s), "
               "pods and the release", phase="teardown", pct=10)
    res = kube.run(["kubectl", "--context", context, "delete", "namespace", ns,
               "--wait=false"], timeout=APPLY_TIMEOUT, own=own)
    if res.returncode != 0:
        raise DockerError(f"could not delete namespace {ns}: " + ask.why(res))
    seen = None
    for attempt in range(NS_GONE_TRIES):
        seen = ask.ask_object("namespace", ns, context=context)
        if seen.absent:
            info(emit, f"namespace {ns} and its volume(s) are gone",
                 phase="teardown", pct=100)
            return True
        if seen.present:
            phase = ((seen.doc or {}).get("status") or {}).get("phase") or "Terminating"
            if attempt % 4 == 0:
                info(emit, f"namespace {ns} is {phase} — waiting for the pods and "
                           "volume(s) to go", phase="teardown",
                     pct=min(90, 20 + attempt * 5))
        elif attempt % 4 == 0:
            info(emit, f"cannot reach cluster {context!r} to confirm {ns} is "
                       f"gone — still trying", phase="teardown",
                 pct=min(90, 20 + attempt * 5))
        sleep(NS_GONE_INTERVAL)
    if seen is not None and seen.refused:
        warn(emit, f"could not confirm that namespace {ns} is gone: "
                   f"{seen.why()} — the local record is KEPT. Check the cluster "
                   f"({context!r}), then `houston down --name {name} --volumes` "
                   f"again.", phase="teardown")
        return False
    warn(emit, f"namespace {ns} is still terminating after "
               f"{int(NS_GONE_TRIES * NS_GONE_INTERVAL)}s — Kubernetes will "
               f"finish on its own. The local record is KEPT so you can retry: "
               f"`kubectl get ns {ns}`, then `houston down --name {name} "
               f"--volumes` again once it is gone.", phase="teardown")
    return False


def _uninstall_workspace_workloads(ns: str, context: str, own: bool,
                                   emit: Emit) -> bool:
    """Remove the release and hand-written MongoDB while retaining its PVC."""
    info(emit, f"uninstalling {RELEASE} from {ns} — the volume is kept",
         phase="teardown")
    rel = kube.run(["helm", "uninstall", RELEASE, "--kube-context", context, "-n", ns],
              timeout=APPLY_TIMEOUT, own=own)
    if rel.returncode != 0 and "not found" not in ask.why(rel).lower():
        raise DockerError(f"could not uninstall {RELEASE} from {ns}: " + ask.why(rel))
    gone = kube.run(["kubectl", "--context", context, "-n", ns, "delete",
                "statefulset,service", "-l", OWNER_SELECTOR],
               timeout=APPLY_TIMEOUT, own=own)
    if gone.returncode != 0:
        raise DockerError(f"could not remove MongoDB from {ns}: " + ask.why(gone))
    return True

def namespace_owner(ns: str, *, context: str) -> str | None:
    """Who a namespace says it belongs to. `""` = it names nobody. `None` = unreadable.

    THREE ANSWERS, because the caller is `prune --orphans`, which deletes. Collapsing
    "it names nobody" and "I could not read it" into one empty string is what makes a
    colleague's namespace look unowned, and the label is the only evidence there is
    that somebody else made it -- their `repro.json` is on their machine, not here.

    A namespace that is GONE answers `""` rather than `None`, and the distinction is
    the point: `namespace_labels` returns None for "it is not there" and RAISES for
    "I could not ask". Nobody owns a namespace that does not exist, and deleting it
    is a no-op -- so that case must not be treated as the unreadable one, or a
    namespace that vanished between the listing and the sweep would block the sweep.
    """
    try:
        labels = namespace_labels(ns, context=context)
    except Exception:  # noqa: BLE001 - could not ask: the only `None` answer
        return None
    if labels is None:                      # asked, and it is not there
        return ""
    return labels.get(OWNER_OF_LABEL, "")

def namespace_labels(ns: str, *, context: str) -> dict[str, str] | None:
    """A namespace's labels, `None` if it does not exist -- and RAISES if the cluster
    could not be asked.

    The three answers are different and were being collapsed into two. "I asked and
    it is not there" is safe to act on; "I could not ask" is not, and a wrong
    kube-context, an expired credential or an RBAC denial all produce the second
    while looking like the first.
    """
    # NO LONGER MATCHED ON THE SERVER'S PROSE. This read `Error from server
    # (NotFound)` out of stderr, which worked and was still the wrong shape: the
    # comment it replaces records that the first attempt matched `"not found"` and
    # classified `Error in configuration: context was not found for specified
    # context: ...` as an absent namespace. Both versions depend on how kubectl
    # words itself, which is not a contract -- the skill file tells callers never to
    # branch on our prose for the same reason. `--ignore-not-found` makes the API
    # server state absence in the PAYLOAD, so there is no wording to get wrong.
    seen = ask.ask_object("namespace", ns, context=context).require(
        f"namespace {ns}", context=context)
    if seen.absent:
        return None
    labels = ((seen.doc or {}).get("metadata") or {}).get("labels") or {}
    if not isinstance(labels, dict):
        return {}
    return {str(k): str(v) for k, v in labels.items()}

def assert_namespace_available(name: str, *, context: str, owner: str = "") -> None:
    """Refuse now if this workspace's namespace belongs to somebody else.

    A PREFLIGHT, so it runs before the write-ahead `repro.json`. `ensure_namespace`
    makes the same check -- it has to, since it is the thing that would do the
    labelling -- but by then a provisional record exists, and a refusal that created
    nothing should leave nothing behind. Observed: a refused create left an
    `incomplete` record that `prune` then offered to delete.

    IT ALSO READS THE PHASE, because ownership was the only thing it looked at. A
    namespace that is `Terminating` still carries its labels, so this passed, and the
    create then died several steps later on `unable to create new content in namespace
    X because it is being terminated` -- at exit 7, after emitting "namespace X" as a
    completed step for a namespace it had not created, and leaving exactly the record
    this preflight exists to prevent, holding a host port. The everyday trigger is
    `down --volumes` followed by re-creating under the same ticket name.

    Refused rather than waited out. Kubernetes finishes on its own and the wait is
    usually seconds, but a finalizer can wedge indefinitely, and a preflight that
    sometimes blocks for a minute is a worse contract than one that says retry.
    """
    seen = ask.ask_object("namespace", namespace_for(name), context=context).require(
        f"namespace {namespace_for(name)}", context=context)
    if seen.absent:
        return
    meta = (seen.doc or {}).get("metadata") or {}
    phase = ((seen.doc or {}).get("status") or {}).get("phase") or ""
    if phase == "Terminating":
        raise ConflictError(
            f"namespace {namespace_for(name)} is still Terminating, so nothing can be "
            f"created in it yet. Kubernetes will finish on its own -- `kubectl get ns "
            f"{namespace_for(name)}` shows when -- then run this again. A workspace "
            f"just torn down with `--volumes` takes a few seconds to go.")
    labels = meta.get("labels") or {}
    _refuse_foreign_namespace(namespace_for(name), name,
                             {str(k): str(v) for k, v in labels.items()}
                             if isinstance(labels, dict) else {}, owner)

def ensure_namespace(name: str, *, context: str, owner: str = "",
                     emit: Emit = null_emit) -> str:
    """Create the workspace's namespace with its ownership labels.

    REFUSES A NAMESPACE THAT IS NOT OURS. This used to `create` (ignoring the result,
    so an existing one was fine) and then `label --overwrite` whatever was there --
    which stamped houston's ownership onto a namespace it did not make, after which
    `down --volumes` would delete it and its PVCs.

    The realistic trigger is not a stranger: it is two houston users on one adopted
    cluster. Name collisions are guarded through the local `repro.json`, and another
    user's home is invisible from here, so the namespace itself is the only evidence
    there is -- and overwriting the labels destroyed it.

    An UNLABELLED namespace is refused too, and that is a deliberate change of intent.
    The old docstring adopted one so "a namespace made by an older houston gains
    them"; houston cannot tell that from somebody else's namespace, and being wrong
    deletes data. The refusal names the manual step instead.
    """
    ns = namespace_for(name)
    existing = namespace_labels(ns, context=context)
    if existing is not None:
        _refuse_foreign_namespace(ns, name, existing, owner)
    else:
        kube.run(["kubectl", "--context", context, "create", "namespace", ns],
            timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    labels = [f"{k}={v}" for k, v in _labels(name, owner).items()]
    res = kube.run(["kubectl", "--context", context, "label", "namespace", ns,
               *labels, "--overwrite"], timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        raise CreateFailedError(
            f"could not label namespace {ns}: "
            + ask.why(res)
            + " — without the label it would be invisible to teardown")
    info(emit, f"created namespace {ns}", phase="provision")
    return ns

def _refuse_a_namespace_that_is_not_ours(context, ns):
    """Somebody else's namespace, with this workspace's name on it."""
    # Refused rather than deleted. Reaching a namespace houston does not own is
    # either the adoption bug above leaving one half-labelled, or the wrong
    # cluster -- and neither is a reason to delete somebody's namespace.
    raise ConflictError(
        f"namespace {ns} exists but is not labelled as houston's, so it will "
        f"not be deleted. Check you are on the right cluster "
        f"({context!r}), then remove it yourself if you meant to")


def _refuse_an_unreadable_namespace():
    """A namespace we cannot prove is this workspace's is one we may not delete."""
    # ABSENT IS THE MOST CONFIRMED-GONE STATE THERE IS, and this returned False for
    # it -- so `teardown` read "not confirmed gone", kept the local record, and said
    # so. The consequence is that a Kubernetes record whose namespace has already
    # been removed could NEVER be deleted: `down --volumes` refused it every time,
    # for ever. The commonest way to reach that is `prune` reclaiming the cluster,
    # or the cluster being recreated -- after which every record from the old one is
    # immortal.
    #
    # Introduced by the change that gave `namespace_labels` three answers instead of
    # two. Splitting "I could not ask" from "it is not there" was right; wiring the
    # second one into the failure branch beside it was not. "I could not ask" still
    # raises, which is the case that mattered.
    return True


def delete_namespace(name: str, *, context: str, volumes: bool = False,
                     emit: Emit = null_emit, sleep=time.sleep) -> bool:
    """Remove a workspace. Returns False if there was nothing there.

    **`helm uninstall` does not delete the PVCs a StatefulSet created.** Kubernetes
    retains them deliberately. Deleting the NAMESPACE does remove them -- which is
    why `down` without `--volumes` cannot just delete the namespace, or it would
    silently destroy data that Compose's `down` keeps.

    So the two paths differ, matching Compose exactly:
      down            uninstall the release, keep the namespace and its PVCs
      down --volumes  delete the namespace, taking the PVCs with it
    """
    ns = namespace_for(name)
    own = vocab.is_ours(context)
    # `namespace_labels`, not `workspace_namespaces`: that one returns [] both when
    # there is nothing there and when the cluster could not be asked, and this used
    # the second as proof of the first. A wrong kube-context, an expired credential
    # or an RBAC denial therefore reported "nothing to remove" -- after which the
    # caller deleted the local record and told the reader the namespace and its
    # PersistentVolumeClaim were gone, while all of it went on running with the only
    # record that knew about it destroyed. `namespace_labels` raises instead.
    labels, cluster_absent = _labels_for_deletion(ns, context, emit)
    if cluster_absent:
        return True
    if labels is None:

        return True
    if labels.get(OWNER_LABEL_KEY) != OWNER_LABEL_VALUE:
        return _refuse_a_namespace_that_is_not_ours(context, ns)
    if volumes:
        # Reported as it happens, and WAITED for. `--wait=false` returned instantly
        # and `down` said "removed" while the namespace was still Terminating, the
        # pods still shutting down and the PVC still there -- so `houston up` with
        # the same name could race a half-deleted namespace, and anyone checking
        # with kubectl saw the opposite of what they had just been told.
        return _delete_namespace_and_volumes(name, ns, context, own, emit, sleep)
    # CHECKED. Both of these had their return codes dropped, so an RBAC denial or an
    # unreachable API server left the release installed and the pods running while
    # `down` reported success. "already uninstalled" is not a failure -- a repeated
    # `down` is normal -- so that one case is allowed through by name.
    # The hand-written MongoDB is not part of the release, so it is removed by
    # label rather than by helm -- and its PVC is deliberately left behind.
    return _uninstall_workspace_workloads(ns, context, own, emit)

def workspace_pvcs(name: str, *, context: str) -> list[str]:
    """PVCs belonging to a workspace, so `prune` can prove what it reclaimed.

    Still `[]` on a refused read, and deliberately: the one caller uses this to say
    how many volumes are about to go, so being wrong understates a count in a
    message. Nothing branches on it. Named here so the next reader knows it was
    considered rather than missed.
    """
    res = kube.run(["kubectl", "--context", context, "-n", namespace_for(name),
               "get", "pvc", "-l", OWNER_SELECTOR, "-o", "name"],
              own=vocab.is_ours(context))
    if res.returncode != 0:
        return []
    return [ln.split("/", 1)[-1].strip()
            for ln in (res.stdout or "").splitlines() if ln.strip()]

def wait_namespace_gone(ns: str, *, context: str, emit: Emit = null_emit,
                        sleep=time.sleep) -> bool:
    """Block until namespace `ns` is actually gone. False if it is still terminating.

    Extracted for `prune --orphans`, which swept namespaces with `--wait=false` and
    then asked `_reclaim_cluster` for the control plane in the same call -- so
    `delete_cluster` refused, correctly, because the namespaces prune had just deleted
    were still Terminating. Reclaiming the cluster took a SECOND prune twenty seconds
    later, and about 600 MB survived the prune that had emptied it.

    Same bound as `delete_namespace`'s own loop, and the same reasoning: a namespace
    that has not gone has not gone, and saying otherwise is what left an orphan once.
    """
    # SAME CORRECTION AS `delete_namespace`, and it mattered more here: on a cluster
    # houston did not create, the caller passed a context that does not exist in the
    # kubeconfig, kubectl exited non-zero, and this returned True -- so `prune
    # --orphans` printed "removed 1 orphaned namespace(s)" with exit 0 over a
    # namespace still Terminating, which is the exact regression this function's
    # docstring says it was written to prevent.
    seen = None
    for attempt in range(NS_GONE_TRIES):
        seen = ask.ask_object("namespace", ns, context=context)
        if seen.absent:
            return True
        if seen.present:
            phase = ((seen.doc or {}).get("status") or {}).get("phase") or "Terminating"
            if attempt % 4 == 0:
                info(emit, f"namespace {ns} is {phase} — waiting for it to go before "
                           f"the cluster can be reclaimed", phase="done")
        elif attempt % 4 == 0:
            info(emit, f"cannot reach cluster {context!r} to confirm {ns} is gone — "
                       f"still trying", phase="done")
        sleep(NS_GONE_INTERVAL)
    if seen is not None and seen.refused:
        warn(emit, f"could not confirm that namespace {ns} is gone: {seen.why()} — "
                   f"the cluster is left alone.", phase="done")
        return False
    warn(emit, f"namespace {ns} is still terminating; the cluster is left alone. "
               f"`houston prune` again once `kubectl get ns` is clear.", phase="done")
    return False
