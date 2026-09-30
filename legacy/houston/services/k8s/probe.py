"""Everything `doctor` needs about Kubernetes, in one pass, changing nothing.

Tier k2, and the top of it: this module asks every other probe and assembles the
answer. Named `probe` and not `preflight` because the package exports a `Preflight`
class, and a module that shadows a symbol it has to export is unreachable through the
façade the moment anything imports it.
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

from houston.errors import PreflightError
from houston.services.k8s import capabilities
from houston.services.k8s import context as kubectx
from houston.services.k8s import endpoints
from houston.services.k8s import names as vocab
from houston.services.k8s import reachability
from houston.services.k8s import tools
from houston.services.k8s.exec import kube
from houston.services.k8s.names import (CLUSTER_NAME, CONTEXT, PROVIDER_EXTERNAL,
                                        PROVIDER_KIND, TOOLS)
from houston.services.k8s.tools import Preflight

#: How many MINOR versions kubectl may differ from the API server and still be
#: supported. Kubernetes publishes ±1; outside it, calls do not fail cleanly -- they
#: fail on a field the other side does not know about, which reads as a bug in
#: whatever was being deployed.
KUBECTL_SKEW = 1

def server_version(context: str) -> tuple[int, ...] | None:
    """The API server's version, or None if it could not be read.

    Separate from `tools.tool("kubectl").version`, which is the CLIENT, and the distinction
    is the whole point of the check below. A static floor cannot express skew: the
    floor here is `kubectl >= 1.21`, and Rocket.Chat's own Launchpad builds clusters at
    1.33 -- so a kubectl that passes the floor by eleven minors is still outside the
    supported window, and passing a floor is exactly what it will report doing.
    """
    res = kube.run(["kubectl", "--context", context, "version", "--output=json"],
              own=vocab.is_ours(context))
    if res.returncode != 0:
        return None
    try:
        raw = (json.loads(res.stdout or "{}").get("serverVersion") or {}
               ).get("gitVersion") or ""
    except ValueError:
        return None
    return tools._parse_version(raw) or None

def skew(context: str, client: tuple[int, ...] | None = None) -> dict | None:
    """How far kubectl is from this cluster's API server, or None if unaskable.

    Returns the two versions and whether the gap is supported, rather than a verdict:
    `doctor` wants to say which two numbers it is talking about, and a check that
    reports "unsupported" without them sends somebody to look up both.
    """
    server = server_version(context)
    if not server:
        return None
    if client is None:
        client = tools.tool("kubectl").version
    if not client or len(client) < 2 or len(server) < 2:
        return None
    gap = abs(client[1] - server[1]) if client[0] == server[0] else 99
    return {"client": client, "server": server, "gap": gap,
            "ok": gap <= KUBECTL_SKEW}

def _fill_in_cluster_facts(out):
    """Everything that needs the cluster, asked in parallel because each is a round trip."""
    # EIGHT INDEPENDENT READS, TOGETHER. The ordering rule this function is built on
    # is about the PRECONDITION above -- there is no point asking an API server for
    # storage classes when kubectl is absent or the server is not answering -- and
    # that gate stays exactly where it was. Everything below it needs only
    # `out.context` and nothing below it needs anything else below it.
    #
    # MEASURED against a live EKS cluster: `doctor` made 42 calls in 24.3 seconds, and
    # about forty of them were kubectl or helm round trips at 1.2-2.2s each. Run one
    # after another these eight are most of that; the AWS block this function sits
    # beside was parallelised first and simply stopped being the slow half.
    #
    # `unreadable` is appended in a FIXED order afterwards rather than as each answer
    # lands, so the report does not vary with which call happened to return first.
    with ThreadPoolExecutor(max_workers=8) as pool:
        # Asked HERE, beside kubectl's answer, so a disagreement is found before a
        # create spends four minutes earning it.
        f_helm = pool.submit(reachability.helm_reachable, out.context)
        # EACH ANSWER READ, not assumed. `reachable()` probes /readyz, which a
        # restricted credential can usually still get -- so passing it is not evidence
        # that any of these reads will be permitted.
        f_sc = pool.submit(capabilities.storage_classes, out.context)
        f_ic = pool.submit(capabilities.ingress_classes, out.context)
        f_ns = pool.submit(capabilities.workspace_namespaces, out.context)
        f_dist = pool.submit(kubectx.distribution, out.context)
        f_nodes = pool.submit(capabilities.nodes_summary, out.context)
        f_metrics = pool.submit(capabilities.metrics_available, out.context)
        f_lb = pool.submit(endpoints.loadbalancer_address, out.context)

        out.helm_reachable = f_helm.result()
        sc = f_sc.result()
        if sc is None:
            out.unreadable.append("storage")
        else:
            out.storage_classes, out.default_storage_class = sc
        ic = f_ic.result()
        if ic is None:
            out.unreadable.append("ingress")
        else:
            out.ingress_classes = ic
        ns_seen = f_ns.result()
        if ns_seen is None:
            out.unreadable.append("namespaces")
        else:
            out.namespaces = ns_seen
        out.distribution = f_dist.result()
        ns_ = f_nodes.result()
        if ns_ is None:
            out.unreadable.append("nodes")
        else:
            out.node_count, out.architectures = ns_
        out.metrics = f_metrics.result()
        out.loadbalancer = f_lb.result()


def _settle_context_and_ask_the_cluster(context, out):
    """Which context this run uses, and everything only the cluster can answer."""
    # THE SAME FUNCTION `up` USES, and that is the whole point of the call. An
    # earlier version resolved the context itself -- `kind` cluster if one existed,
    # else whatever `kubectl` pointed at -- which agreed with `plan_cluster` on every
    # box that had only one of the two and disagreed on the box that had both: with
    # `kind` installed but no cluster yet and k3s running, `doctor` reported "Using
    # your cluster 'default' (k3s)" while `up` went and created a kind cluster. A
    # preflight whose job is to predict a boot must not be a second opinion about it.
    if context:
        out.context = context
    else:
        try:
            plan = kubectx.plan_cluster()
        except PreflightError:
            plan = None
        if plan:
            out.context = plan.context
            out.will_create = plan.create
        else:
            # THE REASON WAS THROWN AWAY WITH THE EXCEPTION. `plan_cluster` raises
            # both for "no kind and no kubeconfig" and for "kubectl is pointed at
            # 'X', which is not answering", and dropping it left `context` empty --
            # so doctor fell through to "No Kubernetes cluster configured, install
            # kind or point kubectl at an existing cluster" for somebody whose
            # cluster IS configured and whose credentials are what need fixing. It
            # sent them to configure a second one.
            #
            # Naming what kubectl is pointed at restores doctor's own correct
            # branch, and where there genuinely is nothing this is still "" and the
            # message that was wrong before is right.
            out.context = kubectx.active_context()
    out.provider = PROVIDER_KIND if out.context == CONTEXT else PROVIDER_EXTERNAL

    if not out.context or out.will_create:
        # Nothing to probe: the cluster this create would use does not exist yet, and
        # asking the OTHER cluster for its storage classes would describe a machine
        # houston is not about to use.
        return out
    out.cluster_reachable = reachability.reachable(out.context)
    if not out.cluster_reachable:
        return out
    _fill_in_cluster_facts(out)
    return out


def preflight(context: str = "") -> Preflight:
    """Everything `doctor` needs, in one pass, changing nothing.

    **kind is optional.** Creating a cluster needs it; using one does not.
    Namespaces, helm releases, PVCs, port-forwards and exec are plain Kubernetes
    and behave the same on k3s, minikube, Docker Desktop or a remote cluster. So
    a missing `kind` narrows what houston can do -- it cannot make you a cluster
    -- without stopping it working in the cluster you already have.

    Which cluster gets probed, in order: the one asked for, else houston's own if
    it exists, else whatever `kubectl` is already pointed at.

    Ordered so each step's precondition is known. There is no point asking an API
    server for storage classes when `kubectl` is absent or the server is not
    answering, and a timeout there would be misreported as "no storage" -- sending
    someone to fix the wrong thing.
    """
    out = Preflight(tools={name: tools.tool(name) for name in TOOLS})

    if out.can_provision:
        found, out.probe_failed = kubectx.clusters()
        if out.probe_failed:
            return out
        out.cluster_exists = CLUSTER_NAME in found
        out.other_clusters = [c for c in found if c != CLUSTER_NAME]

    if not out.tools["kubectl"].present:
        return out

    return _settle_context_and_ask_the_cluster(context, out)
