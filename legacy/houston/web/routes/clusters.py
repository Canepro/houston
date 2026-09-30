"""The cloud ledger: what clusters exist, what each one holds, what each one costs.

**Two verbs at two lifetimes, and the role table draws the line between them.** Reading
the ledger is readonly+ on purpose — a report whose job is to stop a cluster being
forgotten works better the more people can see it, and hiding the bill from everyone who
is not an admin is how a bill runs. `prepare` is an ordinary write: it installs a
StorageClass, an ingress controller and cert-manager, costs nothing and is idempotent.
`create` and `delete` are admin, and neither is people-management: one spends real money
for as long as nobody remembers to remove it, and the other destroys a cluster that may
hold colleagues' work on boxes this one has never seen.

The region sweep is a job because it is twenty seconds of round trips, not because it
changes anything — it only ever lists.
"""
from __future__ import annotations

from fastapi import Body, Request

from houston.errors import ConflictError, ValidationError
from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name -- but `register` is the only thing anything outside this
#: package may reach for, and a test walks the imports to prove nothing does.
__all__ = ("register",)


# A peer of `edge`, and surfaced the same way: a cluster is not a workspace, so it
# never appears in the grid, and something holding your workspaces, your volumes and
# -- on a managed one -- your money has to be answerable somewhere.
#
# SPLIT INTO A CHEAP LIST AND A PROBE PER CLUSTER, deliberately. `status()` is six or
# more round trips and a refusing cluster spends the whole timeout on every one of
# them, so a single endpoint returning everything would make the page as slow as its
# worst cluster. The browser draws a card per context from the cheap list and fills
# each one in as its own request returns.
def clusters_list():
    """Which clusters this box could talk to. Probes nothing; see the note above."""
    from houston.services import cluster as clustersvc
    return clustersvc.known_contexts()


def cluster_status(context: str = ""):
    """One cluster: what it holds and what it costs, or why that could not be read.

    Never reports a zero it did not read -- the fields come back `None` and
    `unreadable` names which, which is the whole discipline of the ledger and the
    reason this is not just a table of numbers.
    """
    from houston.services import cluster as clustersvc
    return clustersvc.status(context)


def cluster_iam_policy(name: str = ""):
    """The permissions documents, so somebody with no shell can still hand them out."""
    from houston.services import eks as ekssvc
    if name:
        return {"documents": [{"name": name,
                               "filename": ekssvc.IAM_DOCUMENTS[name][0]
                               if name in ekssvc.IAM_DOCUMENTS else "",
                               "purpose": ekssvc.IAM_DOCUMENTS[name][1]
                               if name in ekssvc.IAM_DOCUMENTS else "",
                               "body": ekssvc.iam_document(name)}]}
    return {"documents": [
        {"name": key, "filename": fname, "purpose": purpose,
         "body": ekssvc.iam_document(key)}
        for key, (fname, purpose) in sorted(ekssvc.IAM_DOCUMENTS.items())]}


def cluster_sweep(request: Request, body: dict = Body(default={})):
    """Ask AWS what exists, region by region. A JOB: it is ~20s of round trips."""
    from houston.services import eks as ekssvc
    region = str((body or {}).get("region") or "").strip()
    job = _deps.jobs(request).submit("cluster-sweep", ekssvc.sweep_clusters,
                      [region] if region else None,
                      owned_only=not bool((body or {}).get("all")),
                      label=region or "all regions")
    return {"job_id": job.id}


def cluster_prepare(request: Request, body: dict = Body(...)):
    from houston.services import eks as ekssvc
    context = str((body or {}).get("context") or "").strip()
    if not context:
        raise ValidationError("`context` is required: which cluster to prepare.")
    job = _deps.jobs(request).submit("cluster-prepare", ekssvc.aws.prepare_cluster, context,
                      label=context)
    return {"job_id": job.id}


def cluster_create(request: Request, body: dict = Body(...)):
    """Build a managed cluster. Twenty minutes, and billable from the first minute.

    The GUI does not get a softer gate than the terminal: `create_cluster` refuses
    unless the AWS account is approved on this box, and that refusal is not
    reachable by any flag or field. What the web layer adds is that it is admin --
    see ROUTE_ROLES.
    """
    from houston.services import eks as ekssvc
    name = str((body or {}).get("name") or "").strip()
    if not name:
        raise ValidationError("`name` is required, e.g. {\"name\": \"support\"}")
    subnets = (body or {}).get("subnets") or {}
    if subnets and not isinstance(subnets, dict):
        raise ValidationError("`subnets` wants an object of {availability-zone: subnet-id}")
    # `expires` ARRIVES THE WAY THE FLAG TAKES IT -- a number of days, or the word
    # `never` -- and is turned into what the service wants here. Parsed rather than
    # trusted: an unparseable value must not silently become "no expiry", because
    # the expiry tag is the only thing that will later say this cluster was meant
    # to be temporary.
    want = str((body or {}).get("expires") or "").strip().lower()
    if not want:
        days: int | None = ekssvc.DEFAULT_EXPIRY_DAYS
    elif want == "never":
        days = None
    else:
        try:
            days = int(want)
        except ValueError:
            raise ValidationError(
                f"`expires` wants a number of days or \"never\", got {want!r}") from None
    try:
        nodes = int((body or {}).get("nodes") or 0)
    except (TypeError, ValueError):
        raise ValidationError("`nodes` wants a whole number") from None
    job = _deps.jobs(request).submit("cluster-create", ekssvc.aws.create_cluster, name,
                      region=str((body or {}).get("region") or "").strip(),
                      nodes=nodes or ekssvc.DEFAULT_NODES,
                      expires_days=days,
                      subnets=subnets or None,
                      label=name)
    return {"job_id": job.id}


def cluster_delete(request: Request, body: dict = Body(...)):
    """Destroy a managed cluster. Every refusal the CLI has applies here too.

    `force` is accepted and passed through rather than being quietly unavailable:
    a cluster wedged badly enough to need it is exactly the case somebody with no
    shell cannot otherwise get out of. It is admin-only and the six guards in
    `delete_cluster` are what actually decide.
    """
    from houston.services import eks as ekssvc
    name = str((body or {}).get("name") or "").strip()
    if not name:
        raise ValidationError("`name` is required: which cluster to delete.")
    job = _deps.jobs(request).submit("cluster-delete", ekssvc.aws.delete_cluster, name,
                      region=str((body or {}).get("region") or "").strip(),
                      force=bool((body or {}).get("force")),
                      label=name)
    return {"job_id": job.id}


def cluster_forget(body: dict = Body(...)):
    """Remove a kubeconfig entry for a cluster that is not there any more.

    NOT a delete. `delete` takes the cluster away and tidies the entries it wrote;
    this is for the entry left behind when the cluster went some other way — from
    the console, or by a colleague. Those entries are unreachable for ever and a
    card can only ever say "not answering" about them.

    Synchronous: it is three local `kubectl config` calls, so a job id and an
    Activity row would be more machinery than the work.
    """
    from houston.services import k8s
    context = str((body or {}).get("context") or "").strip()
    if not context:
        raise ValidationError("`context` is required: which entry to forget.")
    if not (body or {}).get("force") and k8s.reach(context).ok:
        raise ConflictError(
            f"{context!r} is answering, so it is a cluster you can still use "
            f"rather than a leftover entry. Delete the cluster to remove it.")
    gone = k8s.forget_context(context)
    if not gone:
        # `kubectl config unset` succeeds whether or not there was anything to
        # unset, so "it worked" is not evidence the entry is gone.
        raise ConflictError(
            f"{context} is still named by a kubeconfig on this machine. Remove it "
            f"by hand: `kubectl config delete-context {context}`")
    return {"context": context, "forgotten": True}


ROUTES = (
    ("get", "/api/clusters", clusters_list),
    ("get", "/api/clusters/status", cluster_status),
    ("get", "/api/clusters/iam-policy", cluster_iam_policy),
    ("post", "/api/clusters/sweep", cluster_sweep),
    ("post", "/api/clusters/prepare", cluster_prepare),
    ("post", "/api/clusters/create", cluster_create),
    ("post", "/api/clusters/delete", cluster_delete),
    ("post", "/api/clusters/forget", cluster_forget),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
