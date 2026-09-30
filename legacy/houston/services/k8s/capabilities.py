"""What this cluster can do, asked rather than assumed.

Tier k2, read-only. Storage classes, API groups, nodes and the versions behind them. A
cluster that cannot be asked yields a refusal, never an empty list -- see `ask.Answer`.
"""
from __future__ import annotations

from houston.services.k8s import ask
from houston.services.k8s import names as vocab
from houston.services.k8s import tools
from houston.services.k8s.exec import kube
from houston.services.k8s.names import CONTEXT, OWNER_SELECTOR
from houston.services.k8s.tools import Preflight

def storage_classes(context: str = CONTEXT) -> tuple[list[str], str] | None:
    """(all storage class names, the default one).

    The guide's step 1, and it opens with the warning that matters here: "Local
    Kubernetes distributions such as Kind, K3s, and Minikube often ship without a
    storage provisioner enabled." Without one, a PVC stays Pending forever and the
    workspace never boots -- with no error that names storage.
    """
    # `None`, NOT `[], ""`. A cluster that could not be asked was reporting the same
    # answer as a cluster with no storage provisioner, so `doctor` told somebody with
    # a perfectly good default StorageClass that their volume would stay Pending --
    # and gave it a green verdict, because a warning about missing storage is a
    # warning and "I could not read your cluster" is not something it could say.
    seen = ask.ask_list("storageclass", context=context)
    if seen.refused:
        return None
    names, default = [], ""
    items = seen.items
    for item in items:
        meta = item.get("metadata") or {}
        name = meta.get("name") or ""
        if not name:
            continue
        names.append(name)
        ann = meta.get("annotations") or {}
        if ann.get("storageclass.kubernetes.io/is-default-class") == "true":
            default = name
    return names, default

def metrics_available(context: str = CONTEXT) -> bool:
    """Whether `kubectl top` can answer here, i.e. metrics-server is installed.

    Asked rather than assumed per distribution: kind ships none, k3s ships one, and
    minikube has it as an addon that is off by default -- and any of the three can be
    changed by the person running the cluster. `stats` already discovers this by trying;
    this is the same question asked before anybody needs the answer, so `doctor` can say
    it instead of `stats` being the way you find out.
    """
    return kube.run(["kubectl", "--context", context, "top", "nodes", "--no-headers"],
               own=vocab.is_ours(context)).returncode == 0

def nodes_summary(context: str = CONTEXT) -> tuple[int, list[str]] | None:
    """(how many nodes, which architectures). Both matter, for different reasons.

    Node COUNT decides whether a node-local default StorageClass can bite: `local-path`
    on kind and k3s alike is `WaitForFirstConsumer`, so on more than one node a MongoDB
    pod rescheduled elsewhere cannot rebind its volume. ARCHITECTURE matters because on
    kind and k3s the node is this machine and on a managed cluster it need not be --
    `bitnamilegacy/mongodb`, which every Rocket.Chat below 8 pairs with, is amd64-only.
    """
    # "0 nodes" was the answer for a cluster nobody could read, and it is a
    # sentence doctor then printed next to a tick.
    seen = ask.ask_list("nodes", context=context)
    if seen.refused:
        return None
    arches = [str((((it.get("status") or {}).get("nodeInfo") or {}).get("architecture")) or "")
              for it in seen.items]
    return len(seen.items), sorted({a for a in arches if a})

def ingress_classes(context: str = CONTEXT) -> list[str] | None:
    """Ingress controllers installed in this cluster, best choice first.

    kind ships none -- verified on this box, `get ingressclass` returns "No
    resources found" -- which is why houston installs Traefik into its OWN
    cluster and refuses `--domain` against yours rather than installing into it.

    ORDERED, because the caller adopts the first one and the API's order is not a
    preference. An EKS cluster carrying both `alb` (AWS Load Balancer Controller) and
    `nginx` would otherwise have the choice made by whichever the API server happened
    to list first -- and the two behave differently for ACME http-01 solving and for
    `ingress_endpoint` discovery, so that is a real difference decided by nothing.

    The cluster's OWN default wins: `ingressclass.kubernetes.io/is-default-class` is
    Kubernetes' way of saying which controller an Ingress with no class gets, so
    somebody has already answered this question and houston should not overrule them.
    Names are the tiebreak after that -- arbitrary, but the same arbitrary answer every
    time, which "whatever the API listed first" was not.
    """
    seen = ask.ask_list("ingressclass", context=context)
    if seen.refused:
        return None
    rows = []
    for it in seen.items:
        meta = (it.get("metadata") or {})
        name = str(meta.get("name") or "")
        if not name:
            continue
        default = str((meta.get("annotations") or {}).get(
            "ingressclass.kubernetes.io/is-default-class") or "").lower() == "true"
        rows.append((0 if default else 1, name))
    return [name for _rank, name in sorted(rows)]

def workspace_namespaces(context: str = CONTEXT) -> list[str] | None:
    """Namespaces houston owns, selected by LABEL. `None` if it could not be asked.

    Never by name prefix -- see OWNER_LABEL_KEY.

    THIS RETURNED `[]` FOR A REFUSED READ, and `[]` is what "this cluster holds no
    houston workspaces" looks like -- so a namespace-scoped RBAC identity, an 8s
    PROBE_TIMEOUT under load or a control-plane restart all read as an empty
    cluster. Seven callers act on that, three of them destructively:
    `remove_monitoring` uninstalls the SHARED Prometheus/Grafana stack while another
    workspace is using it, `mongodb_resources` does the same for the shared operator
    -- leaving other workspaces' MongoDBCommunity finalizers with nothing to clear,
    so THEIR teardown hangs -- and `create_workspace`'s `had_namespace` goes False,
    which makes a failed create delete a namespace `down` had kept, PVC and all.
    That last one is data loss, and the guard's own comment says it was observed.

    So the third answer exists and every caller has to say which way it leans. The
    Answer-type migration reached `delete_namespace`, `wait_namespace_gone`,
    `namespace_labels` and doctor's reads, and stopped just short of this one.
    """
    seen = ask.ask_list("namespace", context=context, selector=OWNER_SELECTOR)
    if seen.refused:
        return None
    return sorted(str(((it.get("metadata") or {}).get("name")) or "")
                  for it in seen.items
                  if ((it.get("metadata") or {}).get("name")))

#: The first Rocket.Chat release published as a MULTI-ARCHITECTURE image.
#:
#: MEASURED with `docker manifest inspect` against registry.rocket.chat: 7.8.0, 7.9.0
#: and 7.10.0 each return a single `manifest.v2+json` -- one architecture, amd64 --
#: while 8.0.0 and 8.5.1 return `manifest.list.v2+json` carrying amd64 and arm64. The
#: audit that prompted this measured the same thing at 6.5.0, 4.8.0 and 3.18.0.
#:
#: Recorded as a version rather than read from the registry on every create, because
#: asking would put a network call to a third-party registry -- and, with
#: `docker manifest inspect`, a Docker dependency -- inside the one runtime that is
#: meant not to need Docker at all.
FIRST_MULTIARCH_RC = (8, 0, 0)

#: What Kubernetes calls the architectures houston's images are built for. Node
#: architectures come back in these terms from `.status.nodeInfo.architecture`.
AMD64 = "amd64"

def architecture_blocker(pre: Preflight, rc_version: str) -> str:
    """Why this cluster's nodes cannot run this Rocket.Chat image, or "".

    Same shape and same reason as `storage_blocker`: a refusal beats a create that
    installs cleanly and then cannot pull. `nodes_summary` has always READ the node
    architectures and its docstring has always said why they matter -- the value went
    to one string on `doctor`'s screen and was never compared against anything.

    THE IRONY IS THE POINT: the amd64-only range is precisely the range houston exists
    for. Reproducing a customer's old version is the product's whole purpose, and a
    Graviton node group is an ordinary way to run EKS cheaply.

    Bounded by what is actually known. An unread architecture is not a mismatch, an
    unreachable cluster is not our question, and a cluster with even one amd64 node can
    run the image -- Kubernetes will schedule it there, and pinning it with a
    nodeSelector would trade a fast, legible `ErrImagePull` for a silent `Pending`.
    """
    if not pre.cluster_reachable or not pre.architectures:
        return ""
    key = tools._version_key(rc_version)
    # A VERSION THIS CANNOT READ MUST NOT BECOME A REFUSAL. `_version_key` answers
    # `(-1,)` for anything non-numeric, which sorts BELOW every real release -- so a
    # version it could not parse would read as "older than 8.0.0" and block a create
    # that is very likely fine. Unreachable today, because `versions.resolve` refuses
    # `latest` long before here, but the direction of the mistake is the one this
    # module exists to prevent: "I could not tell" turning into "no".
    if not key or key[0] < 0 or key >= FIRST_MULTIARCH_RC:
        return ""
    if AMD64 in pre.architectures:
        return ""
    shape = ", ".join(sorted(pre.architectures))
    return (f"Rocket.Chat {rc_version} is published for {AMD64} only, and every node in "
            f"this cluster is {shape}. The workspace would install and then fail to "
            f"pull with 'no matching manifest'. Add an {AMD64} node group, or use "
            f"Rocket.Chat {'.'.join(str(n) for n in FIRST_MULTIARCH_RC)} or newer, or "
            f"reproduce this version on the Docker runtime — which pins "
            f"`platform: linux/{AMD64}` and runs it under emulation, something a "
            f"Kubernetes node cannot do.")

def storage_blocker(pre: Preflight) -> str:
    """Why a workspace's volume could not bind in this cluster, or "".

    Takes an already-probed Preflight rather than a context, so it cannot be
    called on data from an unreachable cluster -- reporting "no StorageClass" for
    a cluster nobody could reach is the same wrong answer as reporting an absent
    cluster for a stopped Docker.

    This is a REFUSAL, not a warning, for the reason that makes it nasty: with no
    provisioner the PVC stays Pending, the pod stays Pending, and **Rocket.Chat
    never starts** -- so there are no Rocket.Chat logs to find it in. Left to run,
    it costs the full readiness timeout and then reports "Rocket.Chat did not
    become ready", which blames the one component that is innocent.
    """
    if not pre.cluster_reachable:
        return ""          # not our question; the caller reports unreachable first
    if pre.default_storage_class:
        return ""
    if "storage" in pre.unreadable:
        # NOT "has no StorageClass". `preflight` records that the read was refused;
        # this refused the create anyway and blamed the customer's cluster, which on a
        # namespace-scoped RBAC identity made houston unusable AND sent the engineer
        # to ask a platform team to install a provisioner that was already there
        # (`standard (default) rancher.io/local-path`, measured). The lesson reached
        # doctor and stopped one function short of the blocker that refuses.
        #
        # Still a refusal, because a create whose volume cannot be predicted is not a
        # create worth starting -- but a refusal that names the right thing.
        return (f"Cluster {pre.context!r} would not let houston read its "
                f"StorageClasses, so whether the workspace's volume can bind is "
                f"unknown. This is a permissions problem on the credential in your "
                f"kubeconfig, not a missing provisioner: `kubectl get storageclass` "
                f"as yourself says which.")
    where = f"Cluster {pre.context!r}"
    if pre.storage_classes:
        return (f"{where} has StorageClasses ({', '.join(pre.storage_classes)}) but "
                "none is marked default, so the workspace's volume would stay Pending "
                "and Rocket.Chat would never start. Mark one default with: kubectl "
                "patch storageclass <name> -p "
                "'{\"metadata\":{\"annotations\":"
                "{\"storageclass.kubernetes.io/is-default-class\":\"true\"}}}'")
    return (f"{where} has no StorageClass, so the workspace's volume would stay "
            "Pending forever and Rocket.Chat would never start — with nothing in its "
            "logs naming storage, because it never runs. The official guide warns "
            "that local distributions often ship without a provisioner.")
