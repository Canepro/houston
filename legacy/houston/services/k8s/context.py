"""Which cluster, named the way kubectl names it.

Tier k2, read-only. Contexts, distributions, and the rules for choosing between them --
including `plan_cluster`'s five-step precedence, whose step 0 never sets `create=True`
on a named context, because houston may only create the cluster it owns.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from houston.errors import PreflightError, ValidationError
from houston.services.k8s import ask
from houston.services.k8s import names as vocab
from houston.services.k8s import reachability
from houston.services.k8s import tools
from houston.services.k8s.exec import kube
from houston.services.k8s.names import CLUSTER_NAME, CONTEXT, _KUBELET_SUFFIX, _PROVIDER_ID_PREFIX

def clusters() -> tuple[list[str], str]:
    """(every kind cluster on this machine, why the question could not be answered).

    kind talks to Docker, so this fails when Docker is down -- and it fails by
    printing to stderr and exiting non-zero, which is indistinguishable from "no
    clusters" if only the stdout is read. Returning the reason separately is what
    stops a stopped Docker being reported as an absent cluster.
    """
    res = kube.run(["kind", "get", "clusters"], own=True)
    if res.returncode != 0:
        return [], ask.why(res, limit=120)
    return [ln.strip() for ln in (res.stdout or "").splitlines()
            if ln.strip() and "No kind clusters" not in ln], ""

def forget_context(context: str) -> bool:
    """Remove one context from whichever kubeconfig holds it. True if it is now gone.

    BOTH FILES, because houston wrote into both. `cluster create` runs `aws eks
    update-kubeconfig`, which writes to the USER's kubeconfig -- so an entry for a
    cluster houston built and then deleted is houston's own litter, and removing it
    is symmetry rather than editing somebody's configuration behind their back.

    VERIFIED, not assumed. The first version returned the exit status, and `kubectl
    config unset users.<name>` succeeds whether or not there was anything to unset --
    so it reported True for a context it had not touched, on a box where the entry
    lived in the other file.
    """
    for own in (True, False):
        for verb, target in (("delete-context", context), ("delete-cluster", context),
                             ("unset", f"users.{context}")):
            kube.run(["kubectl", "config", verb, target], own=own)
        # AND THE POINTER AT IT. `kubectl config delete-context` removes the entry and
        # leaves `current-context` naming it, so the file is left pointing at something
        # that is no longer in it. Everything that asks "which cluster is kubectl on"
        # then gets a name with nothing behind it, and houston reported "pointed at
        # <arn>, which is not answering" -- about a cluster that had been deleted, whose
        # entry had been removed, and which `contexts()` correctly no longer listed.
        #
        # MEASURED on this box after a real delete: `contexts()` answered ['default']
        # and `active_context()` answered the dead ARN, and six unrelated Kubernetes
        # tests failed on a cluster nothing could see.
        now = kube.run(["kubectl", "config", "current-context"], own=own)
        if now.returncode == 0 and (now.stdout or "").strip() == context:
            kube.run(["kubectl", "config", "unset", "current-context"], own=own)
    return context not in contexts()[0]

def context_servers() -> tuple[dict[str, str], str]:
    """(context name -> the API server it points at, why the question failed).

    TWO CONTEXTS CAN BE ONE CLUSTER, and on EKS that is the normal case rather than an
    oddity: `eksctl create cluster` writes `<iam-user>@<cluster>.<region>.eksctl.io`
    and `aws eks update-kubeconfig` writes the cluster ARN, and a cluster built with
    one and adopted with the other has both. Anything that lists CONTEXTS then lists
    that cluster twice.

    The server URL is what settles it. Two contexts naming the same API server are the
    same cluster whatever they are called, and it needs no probe -- the kubeconfig
    already knows.
    """
    servers: dict[str, str] = {}
    reasons: list[str] = []
    for own in (False, True):
        res = kube.run(["kubectl", "config", "view", "-o", "json"], own=own)
        if res.returncode != 0:
            reasons.append(ask.why(res, limit=120))
            continue
        try:
            doc = json.loads(res.stdout or "{}")
        except ValueError:
            reasons.append("kubeconfig is not readable as JSON")
            continue
        by_name = {c.get("name"): ((c.get("cluster") or {}).get("server") or "")
                   for c in (doc.get("clusters") or [])}
        for ctx in (doc.get("contexts") or []):
            name = ctx.get("name")
            target = (ctx.get("context") or {}).get("cluster")
            if name and by_name.get(target):
                servers.setdefault(name, by_name[target])
    return servers, "; ".join(reasons) if reasons and not servers else ""

def contexts() -> tuple[list[str], str]:
    """(every context this machine can name, why the question could not be answered).

    BOTH kubeconfigs, because `--context` may legitimately name either: the ones the
    user set up -- `aws eks update-kubeconfig` writes one -- and the one houston keeps
    for a cluster it created. Reading only the user's would refuse
    `--context kind-houston-local`, which is a reasonable thing to type and means
    "use the cluster you already made, do not make another".

    Two answers rather than one, for the reason `clusters()` gives: a kubeconfig that
    cannot be READ is not a kubeconfig with no contexts IN it, and only one of those is
    safe to act on. The caller that refuses an unknown context must not fire on the
    first.
    """
    found: list[str] = []
    reasons: list[str] = []
    for own in (False, True):
        res = kube.run(["kubectl", "config", "get-contexts", "-o", "name"], own=own)
        if res.returncode != 0:
            reasons.append(ask.why(res, limit=120))
            continue
        found.extend(ln.strip() for ln in (res.stdout or "").splitlines() if ln.strip())
    if not found and reasons:
        return [], "; ".join(dict.fromkeys(reasons))
    return sorted(dict.fromkeys(found)), ""

def active_context() -> str:
    """The context `kubectl` would use right now, or "".

    This is the bring-your-own-cluster entry point: on a box with k3s, minikube,
    Docker Desktop or a kubeconfig pointing at a remote cluster, this is the
    cluster houston would work in.
    """
    res = kube.run(["kubectl", "config", "current-context"])
    return (res.stdout or "").strip() if res.returncode == 0 else ""

#: Distributions that run ON THIS MACHINE. The `locality` axis from
#: `.docs/design/kubernetes-cluster-model.md` §2, derived rather than probed exactly as
#: that document says it can be: a cluster whose providerID names a cloud is not on
#: this laptop.
#:
#: It decides one thing here and it is not cosmetic: whether houston may copy its CA
#: PRIVATE KEY into a cluster Secret. `tls_local.py` says what that key is -- it "can
#: mint a certificate for any name the browser will trust". On a local cluster the
#: trust boundary is this box, which already holds the key at 0600. On a remote or
#: shared one it is not, and `--domain` (which needs no CA at all) is the answer there.
LOCAL_DISTRIBUTIONS = ("kind", "k3s", "minikube", "docker-desktop", "rke2")

def is_local_cluster(distribution: str) -> bool:
    """Whether a cluster of this distribution runs on this machine.

    Unknown answers False, deliberately. The question this gates is "may the CA key
    leave this box", and "I do not know where this cluster is" must not come out as
    yes.
    """
    return (distribution or "").strip().lower() in LOCAL_DISTRIBUTIONS

def cluster_context() -> str:
    """The context houston's own cluster is reachable at.

    Read back from the owned kubeconfig rather than assumed from kind's naming
    convention, so a future kind that names contexts differently does not silently
    point every command at nothing.
    """
    res = kube.run(["kubectl", "config", "current-context"], own=True)
    found = (res.stdout or "").strip() if res.returncode == 0 else ""
    return found or CONTEXT

def distribution(context: str) -> str:
    """What kind of Kubernetes this is, as a label. "unknown" is a fine answer.

    Asks the first node, because every signal lives there and one node is enough to
    identify a distribution. Never raises: an unreachable cluster is "unknown", and a
    label nobody branches on is not worth a failure.
    """
    res = kube.run(["kubectl", "--context", context, "get", "nodes", "-o",
               "jsonpath={.items[0].spec.providerID} {.items[0].status.nodeInfo."
               "kubeletVersion} {.items[0].metadata.labels."
               "node\\.kubernetes\\.io/instance-type} {.items[0].metadata.name}"],
              own=vocab.is_ours(context))
    if res.returncode != 0:
        return "unknown"
    parts = (res.stdout or "").split()
    blob = " ".join(parts)
    for prefix, name in _PROVIDER_ID_PREFIX:
        if prefix in blob:
            return name
    for suffix, name in _KUBELET_SUFFIX:
        if suffix in blob:
            return name
    if "minikube" in blob:
        return "minikube"
    if "docker-desktop" in blob:
        return "docker-desktop"
    return "unknown"

@dataclass
class ClusterPlan:
    """Which cluster this create will use, decided before anything is written.

    The whole Kubernetes/k3s difference is ONE STEP: provisioning. With `kind` here,
    houston creates its own cluster exactly as it always has; without it, that step
    is skipped and the cluster `kubectl` already points at is used instead. Every step
    afterwards is the same code, because every function below takes `context=`.

    `create` is the only thing any caller needs to know beyond the context: it decides
    what a failed create may roll back (never a cluster we did not make), and whether
    `check_capacity` should charge for a control plane that does not exist yet.
    """
    context: str
    distribution: str = ""
    create: bool = False          # this call will bring the cluster into existence

def short_name(context: str) -> str:
    """The cluster's own name inside a context name.

    `aws eks update-kubeconfig` writes the cluster ARN as the context, so the name
    somebody actually calls the cluster is the last path segment of it. For a short
    context -- `default`, `kind-houston-local` -- the whole thing already is that
    name, which is why this is safe to apply to every context rather than to EKS ones.

    AND THE OTHER SHAPE AWS WRITES. `eksctl` names its context
    `<user>@<cluster>.<region>.eksctl.io`, which has no `/` at all -- so this returned
    the whole forty-four-character string as the cluster's "short" name. That made
    `--context support` fail to match a cluster whose only context was the eksctl one,
    and put the untouched string into a picker that had asked for something short.
    Both halves of the same fact: the two tools name one cluster differently, which is
    also why `known_contexts` dedupes them.
    """
    if context.endswith(".eksctl.io") and "@" in context:
        return context.split("@", 1)[1].split(".", 1)[0]
    return context.rsplit("/", 1)[-1]

def assert_context_known(context: str) -> tuple[str, str]:
    """Resolve a context to its full name, or refuse. Returns (resolved, unreadable).

    Shared, because `up --context` and `cluster status --context` must refuse the same
    typo the same way -- two commands taking the same option and disagreeing about
    whether its value exists is the shape `doctor` and `up` were already fixed for.

    A CLUSTER'S OWN NAME IS ACCEPTED, not only its full context name. On EKS the
    context is the cluster ARN --
    `arn:aws:eks:us-east-1:533674205877:cluster/support` -- which has to be pasted on
    every `up`, several times a day, for a workspace that lives for an afternoon.
    `--context support` means the same thing and is the form people actually hold in
    their heads. Resolved rather than guessed: an exact context name always wins, a
    short name has to match exactly one cluster, and two clusters of the same name in
    different regions or accounts REFUSE and name both -- acting on the wrong one is
    this feature's whole failure mode, and a silent pick of the first is how that
    happens.

    The second return value is the reason `contexts()` could not answer, and it is a
    reason rather than a refusal ON PURPOSE: "I could not read the kubeconfig" is not
    "that context is not in it", so an unreadable list must not turn a real cluster
    name into an argument error. The caller decides what to do with it.
    """
    known, unreadable = contexts()
    if not known or context in known:
        return context, unreadable
    hits = [c for c in known if short_name(c) == context]
    # TWO NAMES FOR ONE CLUSTER IS NOT AMBIGUITY. `eksctl create cluster` writes
    # `<user>@<name>.<region>.eksctl.io` and `aws eks update-kubeconfig` writes the
    # ARN, so a cluster houston built has BOTH -- and once `short_name` learned the
    # eksctl shape, both started matching the short name and this refused the normal
    # case with "they are different clusters", which they are not.
    #
    # MEASURED on a cluster created minutes earlier: `up --context chatrepo` -- the
    # exact form `cluster create` prints in its own closing line -- was refused.
    #
    # The API server settles it with no probe, the same way `known_contexts` dedupes
    # the ledger: two contexts naming the same server are one cluster. The ARN is
    # preferred as the answer because it says which account and region, which is what
    # matters when the refusal below is genuinely warranted.
    if len(hits) > 1:
        servers, _why = context_servers()
        distinct = {servers.get(c) for c in hits if servers.get(c)}
        if len(distinct) == 1 and len(servers) >= len(hits):
            best = next((c for c in sorted(hits) if c.startswith("arn:aws:eks:")),
                        sorted(hits)[0])
            return best, unreadable
    if len(hits) == 1:
        return hits[0], unreadable
    if len(hits) > 1:
        raise ValidationError(
            f"{context!r} names more than one cluster this machine can see: "
            + ", ".join(repr(c) for c in sorted(hits))
            + ". Give the full context name — they are different clusters, and "
              "acting on the wrong one is not recoverable.")
    raise ValidationError(
        f"no kubeconfig context named {context!r}. This machine can see: "
        + ", ".join(repr(c) for c in known)
        + "." + _context_advice(context, absent=True))

def _context_advice(context: str, *, absent: bool) -> str:
    """The remedy line for a context houston was asked for and cannot use.

    Split out because BOTH refusals in `plan_cluster` need one and both used to end
    in advice about `aws eks update-kubeconfig` -- the right hint for the case
    `--context` was built for, and exactly the WRONG one for houston's own cluster,
    where the answer is to stop passing `--context` at all. Measured: on a fresh
    `HOUSTON_HOME`, `--context kind-houston-local` refused correctly and then told
    the user to run an AWS command about a local kind cluster.

    `absent` separates the two cases, because they have different remedies: a context
    that is not in the kubeconfig needs one PUT there, while one that is there and
    does not answer needs the cluster looked at.
    """
    if context == CONTEXT:
        if not tools.which("kind"):
            return (f" {context!r} is the cluster houston builds for itself, and "
                    f"`kind` is not installed, so it cannot be built. Install kind, "
                    f"or name a cluster you already have.")
        return (f" {context!r} is the cluster houston builds for itself, and a named "
                f"context is always adopted rather than created — run `up` WITHOUT "
                f"`--context` and it will be built.")
    if absent:
        return (" For an EKS cluster, `aws eks update-kubeconfig --name <cluster> "
                "--region <region>` writes one.")
    return (f" Check that `kubectl --context {context} get nodes` works; for EKS that "
            f"also needs `aws` on PATH to mint a token.")

def _plan_from_kind_or_current():
    """What to use when no context was named: kind's cluster, ours, or the active one."""
    if tools.which("kind"):
        # `create` is decided by whether the CLUSTER exists, never by whether this
        # home's kubeconfig happens to know about it. An earlier version required the
        # kubeconfig to name a reachable context, so a fresh HOUSTON_HOME facing an
        # existing cluster planned to CREATE one -- which charged 600 MB of capacity for
        # a control plane already running and, far worse, told a failed create's
        # rollback that the cluster was its to delete. `ensure_cluster` already
        # re-exports the kubeconfig for exactly this case, so the context is knowable
        # before it has been read.
        # AND THE PROBE'S SECOND RETURN VALUE IS NOT DISCARDED. `clusters()` returns
        # (names, why_it_could_not_be_answered) precisely so a stopped Docker is not
        # read as an absent cluster -- and this read `[0]` alone. With kind installed,
        # Docker down and a healthy k3s beside it, `clusters()` answers ([], "...") so
        # `create` became True, `ensure_cluster` then failed on `kind create cluster`,
        # and steps 3 and 4 below -- which would have USED the cluster that works --
        # were never reached. `preflight()` inherited the same answer and reported
        # will_create=True.
        #
        # Not tested live, and said so: proving it means stopping the Docker daemon,
        # which on this box would take down an edge somebody else is serving from. The
        # mechanism is the same conflation `namespace_labels` was fixed for in v0.70.9,
        # and the remedy is the same -- do not act on "I could not ask" as though it
        # were "it is not there".
        names, unasked = clusters()
        if unasked:
            ours_now = cluster_context()
            if ours_now and reachability.reachable(ours_now):
                return ClusterPlan(context=ours_now,
                                   distribution=distribution(ours_now), create=False)
            active_now = active_context()
            if active_now and reachability.reachable(active_now):
                return ClusterPlan(context=active_now,
                                   distribution=distribution(active_now), create=False)
            raise PreflightError(
                f"kind is installed but could not be asked what exists ({unasked}), so "
                f"houston cannot tell whether its cluster is there. `kubectl` is "
                + ("not pointed at a working cluster either" if not active_now else
                   f"pointed at {active_now!r}, which is not answering")
                + ". Usually this is Docker not running: start it, or point kubectl at "
                  "a cluster you already have.")
        return ClusterPlan(context=CONTEXT, distribution="kind",
                           create=CLUSTER_NAME not in names)
    # No kind binary. Our own kubeconfig may still name a cluster that is up -- one
    # houston made before kind was uninstalled -- and that is ours to use even though
    # we could no longer create or delete it.
    ours = cluster_context()
    if ours and reachability.reachable(ours):
        return ClusterPlan(context=ours, distribution=distribution(ours), create=False)
    active = active_context()
    if active and reachability.reachable(active):
        return ClusterPlan(context=active, distribution=distribution(active),
                           create=False)
    raise PreflightError(
        "kind is not installed, so houston cannot create a cluster, and `kubectl` is "
        + ("not pointed at one either" if not active else
           f"pointed at {active!r}, which is not answering")
        + ". Install kind, or point kubectl at a cluster you already have.")


def _plan_from_named_context(context):
    """What a context the caller named can be: ours, a kind cluster, or somebody else's."""
    if context:
        # NEVER `create=True` on an explicitly named context, and this is the whole
        # safety property of the cloud work rather than a nicety. `up` may bring
        # exactly one kind of cluster into existence -- the local one -- and everything
        # else is a cluster somebody else made, or one `cluster create` made on
        # purpose, at a different lifecycle, with a human watching it spend money.
        #
        # A `--provider eks` BRANCH HERE would be the bug: this function is called by
        # `up`, by `preflight()`, and transitively by `check_capacity()` through
        # `_will_provision()` -- so such a branch is a code path on which a CAPACITY
        # CHECK can spend twenty minutes and real money. Keeping `create` meaning
        # exactly "this `up` will build a kind cluster" is what makes that impossible
        # by construction instead of by care.
        context, unreadable = assert_context_known(context)
        # `unreadable` deliberately does NOT refuse. "I could not read the kubeconfig"
        # is not "that context is not in it", and acting on the first as though it were
        # the second is the conflation this module keeps being fixed for. The
        # reachability probe below is the real test and it answers for itself.
        got = reachability.reach(context)
        if not got.ok:
            # NAME WHICH OF THE FOUR IT WAS. "does not answer" plus a guess at three
            # causes was the message for a cluster that was answering perfectly and
            # refusing the credential, and for one this box simply had no kubeconfig
            # entry for -- both of which sent the reader to check a healthy cluster.
            raise PreflightError(
                f"context {context!r} cannot be used: {got.why()}"
                + (f" ({got.detail})" if got.detail else "")
                + (f" (and the kubeconfig could not be listed: {unreadable})"
                   if unreadable else "")
                + "."
                + (got.advice(context)
                   or _context_advice(context, absent=False)))
        return ClusterPlan(context=context, distribution=distribution(context),
                           create=False)
    return _plan_from_kind_or_current()


def plan_cluster(context: str = "") -> ClusterPlan:
    """Choose the cluster, probing only -- nothing here writes to the machine.

    Separate from `ensure_cluster` on purpose, and the reason is a measured defect: the
    write-ahead `repro.json` is written before `create_workspace` runs, so a create that
    refuses for want of a cluster left an `incomplete` record that `list` showed as a
    workspace and whose port `used_ports()` reserved. A pure probe can run BEFORE that
    write, so the refusal costs nothing.

    Order, and it is short because it is not a precedence contest:

      0. the context asked for                           -- ADOPTS. never creates.
      1. a cluster houston created, if it still answers  -- ask the cluster, not `kind`
      2. `kind` present                                   -- create ours, as today
      3. whatever `kubectl` points at, if it answers       -- k3s, minikube, anything
      4. refuse

    Step 0 exists because steps 1-4 have no way to say "that one". With the `kind`
    BINARY present, step 2 wins over step 3 -- MEASURED, a healthy k3s answering in
    0.083s passed over for a cluster that did not exist yet -- so a remote cluster was
    unreachable by any means: there was no flag, no config key and no field, and
    `kubectl config use-context` only moves the ACTIVE context, which step 2 never
    reaches.

    Step 1 asks the owned kubeconfig rather than `kind get clusters` deliberately: that
    probe needs the kind BINARY, so uninstalling kind while its cluster still ran made
    the cluster invisible -- containers holding memory that nothing in houston could
    see or remove, and resolution quietly falling through to a different cluster.
    """
    return _plan_from_named_context(context)

def distribution_of(context: str) -> str:
    """`distribution(context)`, tolerating a cluster that cannot be asked.

    A thin wrapper so `ensure_ingress` can key its refusal on locality without a
    second failure mode: an unreadable distribution answers "" and
    `is_local_cluster("")` is False, which is the safe direction for a question about
    whether to create something billable.
    """
    try:
        return distribution(context)
    except Exception:  # noqa: BLE001 - a locality guess must not raise
        return ""
