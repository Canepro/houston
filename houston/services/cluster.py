"""The cluster ledger: what a cluster is holding, and what that is costing.

Read-only and free. Nothing here mutates a cluster, spends money or needs a cloud
credential, which is why it can be the first thing built and why it is useful on a
kind cluster and an adopted k3s as well as on a managed one.

**The failure this module is written against.** A ledger whose job is "make a
forgotten cluster impossible to forget" is worse than useless if it reports an
unreadable cluster as an empty one: "0 workspaces, nothing costing you money" is
exactly the sentence that lets a bill run. So every fact here is `None` when it could
not be read, never `0`, and `unreadable` names which ones -- the same three-answer
discipline `k8s.Answer` exists for, applied to a screen instead of a delete.

`k8s` is the Kubernetes seam and stays it: everything below asks through `k8s`.
"""

from __future__ import annotations

import datetime as _dt

from concurrent.futures import ThreadPoolExecutor

from houston.services import k8s
from houston.services.events import Emit, null_emit

#: Estimated USD/hour, us-east-1 on-demand. ONE table, because the ledger and the
#: spend gate that will gate `cluster create` must quote the same number --
#: `lifecycle.runtime_cost` already states the rule for RAM: "the same constants, not
#: a second set written for the screen: a card that quotes 1.1 GB while the preflight
#: reserves something else is a card that will be contradicted by the refusal it was
#: meant to prevent". An hourly rate quoted at create and a different one in the
#: ledger is that bug in dollars.
#:
#: Deliberately small. An instance type that is not here is COUNTED and reported as
#: unpriced rather than guessed at or silently omitted -- a total that quietly drops
#: the nodes it did not recognise is the same lie as a zero for an unreadable cluster.
EKS_CONTROL_PLANE_USD_HR = 0.10
NAT_GATEWAY_USD_HR = 0.045

#: A node's DISK, which `INSTANCE_USD_HR` cannot express because a disk is not an
#: instance type -- so it was not underpriced, it was UNCOUNTED, and the "unpriced
#: types are reported" safeguard above could not see it either. MEASURED from `eksctl
#: create cluster --dry-run`, which resolves `volumeSize: 80` and `volumeType: gp3`
#: for a node group that asked for neither. Assumed rather than read, and the basis
#: string says so.
#: MEASURED live: an eksctl node group with no `volumeSize` resolves to 80 GB gp3,
#: and `describe-volumes` on a running cluster showed exactly that beside the
#: workspace's own 8 GB. Still an assumption in the sense that a node group asking
#: for something else is not read back, and the basis string says which.
NODE_VOLUME_GB = 80
EBS_GP3_USD_GB_MONTH = 0.08
HOURS_PER_MONTH = 730.0

#: A LoadBalancer Service provisions a real load balancer and bills by the hour. The
#: ledger has always COUNTED them -- "1 LoadBalancer(s) — each one is billed on a
#: managed cluster" is printed one line above the total -- and never priced them,
#: which is the same failure as the node disks one layer along: a figure arrived at
#: honestly, believable, and low. us-east-1 classic/NLB hourly; an ALB differs and
#: capacity units are not modelled.
LOADBALANCER_USD_HR = 0.0225
INSTANCE_USD_HR: dict[str, float] = {
    "t3.medium": 0.0416,
    "t3.large": 0.0832,      # what Launchpad names as the minimum
    "t3.xlarge": 0.1664,
    "m5.large": 0.096,
    "m5.xlarge": 0.192,
}

#: Distributions that cost money to keep running. A kind cluster on a laptop and a
#: k3s in a VM you already pay for are both free as far as houston is concerned;
#: quoting dollars for them would be noise, and quoting zero would be a claim about
#: somebody else's infrastructure bill.
BILLABLE = ("eks", "gke", "aks")


def _oldest_node_age_hours(items: list[dict]) -> float | None:
    """Hours since the oldest node appeared, as a proxy for the cluster's age.

    A proxy because nothing asks the control plane when it was created: EKS knows,
    kind does not, and the answer has to mean the same thing on both. The oldest node
    is close enough for "this has been up for eleven days" and is readable everywhere.
    """
    stamps: list[_dt.datetime] = []
    for it in items:
        raw = str(((it.get("metadata") or {}).get("creationTimestamp")) or "")
        if not raw:
            continue
        try:
            stamps.append(_dt.datetime.fromisoformat(raw.replace("Z", "+00:00")))
        except ValueError:
            continue
    if not stamps:
        return None
    now = _dt.datetime.now(_dt.timezone.utc)
    return max(0.0, (now - min(stamps)).total_seconds() / 3600.0)


def _claimed_gb(answer) -> float | None:
    """Gigabytes claimed by these PVCs, or None if the cluster would not say.

    None rather than 0.0 for a refused read, for the reason the whole module exists:
    an unreadable volume list priced at nothing is a bill that looks free.
    """
    if answer.refused:
        return None
    total = 0.0
    for it in answer.items:
        raw = str((((it.get("spec") or {}).get("resources") or {}
                    ).get("requests") or {}).get("storage") or "")
        if not raw:
            continue
        try:
            if raw.endswith("Gi"):
                total += float(raw[:-2])
            elif raw.endswith("Mi"):
                total += float(raw[:-2]) / 1024.0
            elif raw.endswith("Ti"):
                total += float(raw[:-2]) * 1024.0
        except ValueError:
            continue
    return total


def _node_inventory(items: list[dict]) -> dict[str, int]:
    """Instance type -> how many. `""` for a node that does not say."""
    out: dict[str, int] = {}
    for it in items:
        labels = (it.get("metadata") or {}).get("labels") or {}
        kind = str(labels.get("node.kubernetes.io/instance-type") or "")
        out[kind] = out.get(kind, 0) + 1
    return out


def provider_of(context: str, distribution: str) -> str:
    """The distribution, by a route that does not require a node to exist.

    `k8s.distribution()` reads a NODE's providerID, which is the most reliable signal
    there is -- when there is a node. A managed cluster with zero of them is not an
    edge case: it is every cluster mid-create, mid-delete, or with its node group
    scaled to nothing.

    MEASURED against a real EKS cluster whose node group was being deleted:
    `distribution` answered "unknown", so it did not match BILLABLE, so the ledger
    priced a control plane that was very much running at nothing at all. That is the
    failure this module was written against, rebuilt one layer up.

    The context name settles what the nodes cannot: `aws eks update-kubeconfig` writes
    the cluster ARN as the context name, and an ARN names its own service.
    """
    if distribution and distribution != "unknown":
        return distribution
    if context.startswith("arn:aws:eks:"):
        return "eks"
    return distribution


def region_of(context: str) -> str:
    """The region inside a context name, or "".

    Beside `provider_of` and for the same reason: the context name carries facts the
    cluster cannot always be asked for, and both shapes AWS writes contain this one --
    `aws eks update-kubeconfig` writes `arn:aws:eks:<region>:<account>:cluster/<name>`
    and `eksctl` writes `<user>@<name>.<region>.eksctl.io`.

    Wanted so a picker can say `chatrepo (us-east-1)` instead of sixty characters of
    ARN. Which region a cluster is in is the half of an ARN a person actually needs;
    the account id is the half they do not.
    """
    if context.startswith("arn:aws:eks:"):
        bits = context.split(":")
        return bits[3] if len(bits) > 4 else ""
    if context.endswith(".eksctl.io"):
        # `<user>@<name>.<region>.eksctl.io` -> the part before `.eksctl.io`, last dot.
        stem = context[: -len(".eksctl.io")]
        return stem.rsplit(".", 1)[-1] if "." in stem else ""
    return ""


def estimate_usd_hr(distribution: str, inventory: dict[str, int], *,
                    loadbalancers: int | None = 0,
                    volume_gb: float | None = 0.0) -> dict | None:
    """What this cluster costs per hour, or None when the question does not apply.

    Everything the ledger can SEE is priced, because everything it can see is on the
    screen already: the row above the total says "1 LoadBalancer(s) — each one is
    billed on a managed cluster" and then the total left it out. Counting a thing and
    not pricing it is the most convincing way to be wrong, since the reader can see
    you noticed.

    `unpriced` and `incomplete` are separate answers. An instance type that is not in
    the table is a gap in this build's knowledge; a count that came back None is a
    read that FAILED, and the difference matters because only one of them gets better
    by adding a row to a dict.
    """
    if distribution not in BILLABLE:
        return None
    total = EKS_CONTROL_PLANE_USD_HR + NAT_GATEWAY_USD_HR
    unpriced: dict[str, int] = {}
    incomplete: list[str] = []
    for kind, count in inventory.items():
        rate = INSTANCE_USD_HR.get(kind)
        if rate is None:
            unpriced[kind] = count
            continue
        total += rate * count
    # Node disks, counted for EVERY node including the ones whose type could not be
    # priced -- an unrecognised instance type still has a volume attached to it.
    total += (sum(inventory.values()) * NODE_VOLUME_GB
              * EBS_GP3_USD_GB_MONTH / HOURS_PER_MONTH)

    if loadbalancers is None:
        incomplete.append("load balancers")
    else:
        total += loadbalancers * LOADBALANCER_USD_HR
    if volume_gb is None:
        incomplete.append("workspace volumes")
    else:
        total += volume_gb * EBS_GP3_USD_GB_MONTH / HOURS_PER_MONTH

    return {"usd_hr": round(total, 4), "unpriced": unpriced,
            "incomplete": incomplete,
            "basis": ("us-east-1 on-demand: control plane, NAT gateway, nodes, "
                      f"{NODE_VOLUME_GB} GB gp3 per node (eksctl's default, not read "
                      "back), load balancers and workspace volumes"),
            "estimate": True}


def known_contexts() -> dict:
    """Every cluster this box could talk to, without talking to any of them but one.

    Deliberately cheap and deliberately incomplete. `status()` is six or more probes
    per cluster and one that is refusing spends the whole timeout, so a caller that
    wanted a list of three clusters would wait on the slowest -- and a front end that
    fetches this first can draw the cards immediately and fill each one in as its own
    `status()` returns. A cluster nobody can reach then costs one slow card rather
    than a slow page.

    Nothing here is a claim about a cluster's health, and none of these fields comes
    from a probe: the context names are the kubeconfig's, `ours` is which kubeconfig
    they came from, and `provider` is read from the shape of the name. A caller that
    needs to know whether a cluster is up asks `status()`, which is the function that
    goes and finds out.
    """
    from houston import config

    names, unreadable = k8s.contexts()
    default = config.default_kube_context()
    # ONE ROW PER CLUSTER, not one per context. `eksctl create cluster` writes
    # `<iam-user>@<cluster>.<region>.eksctl.io` and `aws eks update-kubeconfig` writes
    # the ARN, so a cluster built with one and adopted with the other has both -- and
    # a list of CONTEXTS then shows it twice and prices it twice. Reported from a real
    # screen: "Costing money 2 · ~$16.87/day" for a single cluster costing $8.44. A
    # ledger whose whole job is to make spend visible must not double it.
    #
    # The API server settles it with no probe: two contexts naming the same server are
    # the same cluster whatever they are called. The ARN is kept as the name to show,
    # because it says which account and which region -- the two facts the eksctl alias
    # leaves out and the two that matter when acting on the wrong cluster.
    servers, _srv_why = k8s.context_servers()
    aliases: dict[str, list[str]] = {}
    if servers:
        by_server: dict[str, list[str]] = {}
        for name in names:
            url = servers.get(name)
            if url:
                by_server.setdefault(url, []).append(name)
        keep: set[str] = set()
        for url, group in by_server.items():
            best = next((g for g in sorted(group) if g.startswith("arn:aws:eks:")),
                        sorted(group)[0])
            keep.add(best)
            if len(group) > 1:
                aliases[best] = sorted(n for n in group if n != best)
        names = [n for n in names if n not in servers or n in keep]
    # THE ONE PROBE, and only in one situation. houston writes its OWN kubeconfig
    # when it builds its own cluster and never removes that entry -- so a cluster that
    # has been deleted outside houston, or whose `kind` was uninstalled and the
    # container removed by hand, leaves a context for something that does not exist.
    # It then showed on every screen for ever, unusable, unreclaimable and impossible
    # to clear.
    #
    # It is NOT enough to drop it whenever `kind` is missing. `plan_cluster` records
    # what that costs: uninstalling the binary while the cluster still ran made the
    # cluster invisible, "containers holding memory that nothing in houston could see
    # or remove". A running cluster stays listed however little houston can do with
    # it -- `status()` says it can no longer be removed and how to remove it anyway.
    #
    # So the question is whether the cluster is THERE, which costs one probe, bounded:
    # our own context only, and only when the binary that would manage it is absent.
    drop: set[str] = set()
    ours_ctx = k8s.cluster_context()
    if ours_ctx and ours_ctx in names and not k8s.which("kind") \
            and not k8s.reach(ours_ctx).ok:
        drop.add(ours_ctx)
    rows = []
    for name in names:
        if name in drop:
            continue
        provider = provider_of(name, "")
        rows.append({
            "context": name,
            # WHAT TO SHOW, decided here rather than in JavaScript -- the same reason
            # `billable` is: a rule the service owns should not get a second copy in
            # the front end. A picker rendering the full context put ninety-five
            # characters of ARN plus two suffixes into one `<option>`, which a native
            # select cannot shrink, and the text ran out of its box.
            "short": k8s.short_name(name),
            "region": region_of(name),
            # The other names this same cluster answers to, so a caller that sees one
            # of them in a kubeconfig can tell it is not a second cluster.
            "aliases": aliases.get(name, []),
            "ours": k8s.is_ours(name),
            # "" means "not knowable from the name" -- kind and k3s and minikube all
            # look alike here, and guessing would put a distribution on a card that
            # `status()` then contradicts.
            "provider": provider,
            "billable": provider in BILLABLE,
            "is_default": name == default,
        })
    return {"contexts": rows, "unreadable": unreadable, "default": default}


#: How many cluster reads `status` keeps in flight. Bounded on purpose: each one is a
#: kubectl subprocess, and a cluster holding twenty workspaces would otherwise fork
#: sixty at once on a laptop that is already running other stacks. Eight covers the six
#: independent top-level reads in one go and keeps the per-namespace wave moving.
STATUS_WORKERS = 8


def _mark_if_aws_says_gone(out: dict, context: str) -> None:
    """Set `gone` when AWS says this EKS cluster does not exist. Never raises.

    Split out of `status` because it is the one place a REPORT asks AWS anything, and
    the rule it has to obey is narrow enough to want stating on its own: a cluster is
    marked gone only when `describe_cluster` returns ABSENT. Anything else -- REFUSED,
    a malformed ARN, an exception on the way -- leaves the cluster listed and the
    reader told it could not be read.
    """
    if not context.startswith("arn:aws:eks:"):
        return
    bits = context.split(":")
    name = context.rsplit("/", 1)[-1]
    if len(bits) < 6 or not name:
        return
    try:
        from houston.services import eks as ekssvc
        seen = ekssvc.describe_cluster(name, bits[3])
    except Exception:  # noqa: BLE001 - a report must not raise on a lookup
        return
    if seen.state != k8s.ABSENT:
        return
    out["gone"] = True
    out["reach_advice"] = (
        "AWS says this cluster no longer exists, so it is not costing anything. The "
        "kubeconfig entry naming it is left over -- `houston cluster forget "
        f"{name}` removes it, or `kubectl config delete-context {context}`.")


def status(context: str = "", emit: Emit = null_emit) -> dict:
    """Everything a cluster is holding, in one read-only pass.

    `context` defaults to the box's configured cluster, so `cluster status` and `up`
    answer about the same one -- the same reason `doctor` takes it.
    """
    from houston import config

    named = (context or "").strip()
    if named:
        # THE SAME REFUSAL `up --context` GIVES. A context nobody can name is a bad
        # argument, not a cluster that is down, and calling it "not answering" would
        # send somebody to check a cluster that does not exist. An unreadable
        # kubeconfig deliberately does not refuse here either -- see the helper.
        named, _unreadable = k8s.assert_context_known(named)
    ctx = named or config.default_kube_context()
    if not ctx:
        try:
            ctx = k8s.plan_cluster().context
        except Exception:  # noqa: BLE001 - no cluster is a report, not a crash
            ctx = k8s.active_context()

    volume_gb: float | None = 0.0
    out: dict = {
        "context": ctx, "distribution": "", "provider": "", "ours": False,
        "reachable": False, "unreadable": [],
        # DECLARED HERE, not only where they are set. Every caller reads this document
        # -- the CLI renderer, the `--json` envelope, and `_fake_detail`-style test
        # doubles -- so a key that appears only on some paths is the payload-shape trap
        # this repo already has a name for.
        "reach_status": k8s.REACH_DOWN, "reach_why": "", "reach_advice": "",
        # Whether houston can still TAKE THIS CLUSTER AWAY, which is not the same
        # question as whether it can use it.
        "manageable": True, "unmanageable_why": "",
        # AWS asserting the cluster is not there, which is not the same as it not
        # answering. Only ever set from a definite ABSENT -- see below.
        "gone": False,
        "nodes": None, "age_hours": None, "instance_types": None,
        "workspaces": None, "pvcs": None, "loadbalancers": None,
        "operator": None, "monitoring": None, "cost": None,
    }
    if not ctx:
        out["unreadable"].append("context")
        return out

    out["ours"] = k8s.is_ours(ctx)
    # A CLUSTER HOUSTON MADE AND CAN NO LONGER REMOVE. `delete_cluster`,
    # `cluster_reclaimable` and `prune` all open with `if not which("kind"): return
    # False`, so uninstalling the kind BINARY leaves the cluster running, reachable,
    # holding memory -- and silently unreclaimable, because those functions answer
    # "there was nothing to delete" rather than "I cannot delete it". The module
    # docstring's rule applies to a control as much as to a count: reporting nothing
    # where the honest answer is "I cannot" is how a thing gets forgotten.
    if out["ours"] and not k8s.which("kind"):
        out["manageable"] = False
        out["unmanageable_why"] = (
            "houston built this cluster and can no longer remove it: kind is not "
            "installed. It keeps running and holding memory until something takes it "
            "away. Reinstall kind and `houston prune`, or remove its container "
            f"directly with `docker rm -f {k8s.CLUSTER_NAME}-control-plane`.")
    if out["ours"]:
        # houston's OWN cluster is reached through houston's OWN kubeconfig, and a
        # fresh HOUSTON_HOME has not got one yet -- so a cluster that is up and
        # visible in `kubectl config get-contexts` answers "not answering" here.
        #
        # `ensure_kubeconfig` exists for exactly this and its docstring names the case:
        # "With a kind cluster already up and a fresh home, every command failed ...
        # and could not self-heal". That was fixed for `up`, and this command
        # reintroduced it by probing without calling it. CLAUDE.md tells anyone writing
        # a script to `export HOUSTON_HOME=$(mktemp -d)`, so it is reachable by
        # following our own instructions.
        #
        # Best effort: a status report must not fail because an export did not work.
        # If it does not, `reachable` below answers False and says so honestly.
        try:
            k8s.ensure_kubeconfig(
                k8s.ClusterPlan(context=ctx, distribution="kind", create=False))
        except Exception:  # noqa: BLE001 - a report must not raise on a repair
            pass
    got = k8s.reach(ctx)
    out["reachable"] = got.ok
    # WHY it could not be read, not merely that it could not. A ledger that says "is
    # not answering" for a cluster that is ACTIVE and merely refusing this credential
    # sends the reader to check the cluster, which is the one place the problem is
    # not -- measured against a live EKS cluster, as an IAM user with no access entry.
    out["reach_status"] = got.status
    out["reach_why"] = got.why()
    out["reach_advice"] = got.advice(ctx)
    if not out["reachable"]:
        # A CLUSTER THAT AWS SAYS IS GONE. `cluster delete` removes the cluster; it
        # does not reach into every kubeconfig on the machine and tidy the entries
        # that named it, and `aws eks update-kubeconfig` and `eksctl` each wrote one.
        # A cluster deleted OUTSIDE houston therefore keeps a context for ever, and
        # the card for it says only "not answering" -- which reads as a cluster that
        # is down and still billing, the most alarming reading of the cheapest state.
        #
        # HERE AND NOT IN `known_contexts`. This costs an AWS round trip, and the list
        # is the function whose entire contract is that it probes nothing -- one probe
        # per cloud cluster on a four-second poll is what made the page slow enough to
        # be reported. `status` is per card, already spends `reach`, and is only
        # reached at all when that has already failed.
        #
        # ONLY ON A DEFINITE NO. `describe_cluster` answers PRESENT, ABSENT or REFUSED,
        # and only ABSENT is AWS asserting the cluster is not there. REFUSED is "I
        # could not ask" -- expired credentials, no route, a permission boundary -- and
        # calling that gone would report a BILLING cluster as deleted, which is the one
        # mistake this module exists to prevent.
        _mark_if_aws_says_gone(out, ctx)
        # Everything below needs the API server. Reporting zeros for a cluster that
        # did not answer is the exact failure this module is written against, so the
        # fields stay None and the caller is told why.
        out["unreadable"].append("cluster")
        return out

    # READ CONCURRENTLY, in two waves. Every read below is an independent kubectl
    # round trip and none of them writes, but they ran one after another -- about a
    # dozen calls for a cluster holding two workspaces, and on a managed cluster each
    # one is a second or two over the network.
    #
    # MEASURED against a live EKS cluster: 18.15 seconds for one card, while the same
    # box answered the cheap LIST in 0.31. The GUI draws a card per cluster and fills
    # each in from its own request, so this number is exactly how long somebody sits
    # looking at `?`. Threads rather than async because every one of these is a
    # subprocess waiting on a socket, which is where the GIL is not held.
    #
    # The SECOND wave depends on the first: which namespaces exist has to come back
    # before their owners and volumes can be asked for. Within a wave nothing depends
    # on anything else, and results are assembled in a fixed order afterwards so the
    # document does not vary with which call happened to finish first.
    with ThreadPoolExecutor(max_workers=STATUS_WORKERS) as pool:
        f_dist = pool.submit(k8s.distribution, ctx)
        f_nodes = pool.submit(k8s.ask_list, "nodes", context=ctx)
        f_spaces = pool.submit(k8s.workspace_namespaces, ctx)
        f_lbs = pool.submit(k8s.ask_list, "svc", context=ctx, all_namespaces=True)
        f_oper = pool.submit(k8s.operator_presence, ctx)
        f_mon = pool.submit(k8s.monitoring_installed, ctx)

        out["distribution"] = provider_of(ctx, f_dist.result())
        out["provider"] = (k8s.PROVIDER_KIND if out["distribution"] == "kind"
                           else k8s.PROVIDER_EXTERNAL)

        nodes = f_nodes.result()
        if nodes.refused:
            out["unreadable"].append("nodes")
        else:
            out["nodes"] = len(nodes.items)
            out["age_hours"] = _oldest_node_age_hours(nodes.items)
            out["instance_types"] = _node_inventory(nodes.items)

        spaces = f_spaces.result()
        if spaces is None:
            out["unreadable"].append("workspaces")
        else:
            # Wave two: three reads per namespace, all in flight together.
            per = {ns: (pool.submit(k8s.namespace_owner, ns, context=ctx),
                        pool.submit(k8s.workspace_pvcs,
                                    ns.removeprefix(k8s.NAMESPACE_PREFIX), context=ctx),
                        pool.submit(k8s.ask_list, "pvc", context=ctx, namespace=ns))
                   for ns in spaces}
            rows = []
            pvcs_total = 0
            pvcs_unreadable = False
            for ns in spaces:
                f_owner, f_held, f_pvc = per[ns]
                owner = f_owner.result()
                name = ns.removeprefix(k8s.NAMESPACE_PREFIX)
                try:
                    held = f_held.result()
                except Exception:  # noqa: BLE001 - one unreadable workspace is not zero
                    held, pvcs_unreadable = [], True
                pvcs_total += len(held)
                gb = _claimed_gb(f_pvc.result())
                if gb is None:
                    pvcs_unreadable = True
                    volume_gb = None
                elif volume_gb is not None:
                    volume_gb += gb
                rows.append({"namespace": ns, "name": name,
                             "owner": owner if owner is not None else "",
                             "owner_readable": owner is not None,
                             "pvcs": len(held)})
            out["workspaces"] = rows
            out["pvcs"] = None if pvcs_unreadable else pvcs_total
            if pvcs_unreadable:
                out["unreadable"].append("pvcs")

        lbs = f_lbs.result()
        if lbs.refused:
            out["unreadable"].append("loadbalancers")
        else:
            out["loadbalancers"] = sum(
                1 for it in lbs.items
                if str(((it.get("spec") or {}).get("type")) or "") == "LoadBalancer")

        # PRESENCE, not ownership. The card's question is "does this cluster have a
        # MongoDB operator", and since `ensure_operator` adopts a foreign one rather
        # than installing beside it, asking about houston's own release would report
        # "no operator" for a cluster that has a perfectly good one and would use it.
        out["operator"] = f_oper.result().present
        out["monitoring"] = f_mon.result()

    # LAST, because it prices things read above it. Computing it beside the node
    # inventory -- where it used to be -- meant the load balancers and workspace
    # volumes had not been counted yet, so a total printed one line under
    # "1 LoadBalancer(s) — each one is billed" silently excluded it.
    if out["instance_types"] is not None:
        out["cost"] = estimate_usd_hr(
            out["distribution"], out["instance_types"],
            loadbalancers=out["loadbalancers"], volume_gb=volume_gb)
    return out
