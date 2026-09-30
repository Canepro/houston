"""`houston.services.cluster`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations


def test_the_cost_estimate_counts_the_nodes_it_cannot_price(monkeypatch):
    """A total that silently drops what it did not recognise reads as complete.

    Same failure as a zero for an unreadable cluster, one layer along: the number is
    believable, arrived at honestly, and wrong in the direction that costs money.
    """
    from houston.services import cluster

    # Free distributions are not priced at all -- quoting zero for somebody's own k3s
    # would be a claim about their infrastructure bill.
    assert cluster.estimate_usd_hr("k3s", {"": 1}) is None
    assert cluster.estimate_usd_hr("kind", {"": 1}) is None

    base = cluster.EKS_CONTROL_PLANE_USD_HR + cluster.NAT_GATEWAY_USD_HR
    disk = (cluster.NODE_VOLUME_GB * cluster.EBS_GP3_USD_GB_MONTH
            / cluster.HOURS_PER_MONTH)

    got = cluster.estimate_usd_hr("eks", {"t3.large": 3})
    assert got["usd_hr"] == round(
        base + 3 * (cluster.INSTANCE_USD_HR["t3.large"] + disk), 4)
    assert got["estimate"] is True and not got["unpriced"]

    # An unknown type is REPORTED, not dropped and not guessed at -- and its DISK is
    # still counted. This assertion used to read `base + one t3.large` exactly, which
    # said an unpriced node contributes nothing at all; a live run showed that eksctl
    # attaches 80 GB to it like any other, so "we cannot price the instance" is not
    # "this node is free".
    mixed = cluster.estimate_usd_hr("eks", {"t3.large": 1, "x9.enormous": 2})
    assert mixed["unpriced"] == {"x9.enormous": 2}
    assert mixed["usd_hr"] == round(
        base + cluster.INSTANCE_USD_HR["t3.large"] + 3 * disk, 4), \
        "the priced part must be right, the disks all counted, the caller told which "\
        "instance types could not be priced"


def test_a_managed_cluster_with_no_nodes_is_not_a_free_one(monkeypatch):
    """Found live, against a real EKS cluster whose node group was being deleted.

    `distribution()` reads a NODE's providerID, which is the most reliable signal there
    is — when there is a node. Zero nodes is not an edge case: it is every cluster
    mid-create, mid-delete, or scaled to nothing. The ledger answered "unknown", which
    did not match BILLABLE, so it priced a running control plane at nothing at all —
    the exact failure this module exists to prevent, rebuilt one layer up.
    """
    from houston.services import cluster

    arn = "arn:aws:eks:us-east-1:533674205877:cluster/houston-probe"
    assert cluster.provider_of(arn, "unknown") == "eks"
    assert cluster.provider_of(arn, "") == "eks"

    # A node that CAN say still wins — the ARN is a fallback, not an override.
    assert cluster.provider_of(arn, "eks") == "eks"
    assert cluster.provider_of("default", "k3s") == "k3s"
    assert cluster.provider_of("default", "unknown") == "unknown"

    # And the pricing follows: a control plane with no nodes still bills.
    priced = cluster.estimate_usd_hr(cluster.provider_of(arn, "unknown"), {})
    assert priced is not None, "an EKS cluster with no nodes was priced at nothing"
    assert priced["usd_hr"] == round(
        cluster.EKS_CONTROL_PLANE_USD_HR + cluster.NAT_GATEWAY_USD_HR, 4)


def test_a_node_costs_its_disk_as_well_as_itself():
    """Found by `eksctl --dry-run`, before any money was spent.

    eksctl gives every node an 80 GB gp3 volume that the node group did not ask for.
    A disk is not an instance TYPE, so `INSTANCE_USD_HR` could not express it and the
    "unpriced types are reported" safeguard could not see it: the cost was not
    underpriced, it was uncounted, and the total read as complete.
    """
    from houston.services import cluster

    disk = (cluster.NODE_VOLUME_GB * cluster.EBS_GP3_USD_GB_MONTH
            / cluster.HOURS_PER_MONTH)
    base = cluster.EKS_CONTROL_PLANE_USD_HR + cluster.NAT_GATEWAY_USD_HR

    one = cluster.estimate_usd_hr("eks", {"t3.large": 1})
    assert one["usd_hr"] == round(
        base + cluster.INSTANCE_USD_HR["t3.large"] + disk, 4)

    # Counted for EVERY node, including one whose TYPE could not be priced — an
    # unrecognised instance still has a volume attached to it.
    mixed = cluster.estimate_usd_hr("eks", {"x9.enormous": 2})
    assert mixed["unpriced"] == {"x9.enormous": 2}
    assert mixed["usd_hr"] == round(base + 2 * disk, 4), \
        "the disks of unpriced nodes were dropped along with their instance cost"


def _a_cluster_with_something_of_everything_on_it(monkeypatch, tmp_path):
    """A cluster holding one of each billable thing, so nothing priced is missed."""
    from houston.services import cluster, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    disk = cluster.EBS_GP3_USD_GB_MONTH / cluster.HOURS_PER_MONTH
    # Built from the RAW components, not from an already-rounded subtotal: the
    # implementation sums everything and rounds once, and rounding twice here made the
    # test disagree with correct arithmetic by a hundredth of a cent.
    raw = (cluster.EKS_CONTROL_PLANE_USD_HR + cluster.NAT_GATEWAY_USD_HR
           + cluster.INSTANCE_USD_HR["t3.large"] + cluster.NODE_VOLUME_GB * disk)
    bare = cluster.estimate_usd_hr("eks", {"t3.large": 1})["usd_hr"]
    return bare, cluster, disk, k8s, raw


def test_the_ledger_prices_everything_it_puts_on_the_screen(monkeypatch, tmp_path):
    """Counting a thing and not pricing it is the most convincing way to be wrong.

    MEASURED against a live cluster: the report printed "1 LoadBalancer(s) — each one
    is billed on a managed cluster" and then a total that excluded it, along with the
    workspace's own volume. About ten per cent low, arrived at honestly, and with the
    evidence of the omission printed one line above the number.

    The cause was ordering: the estimate was computed beside the node inventory, before
    the load balancers and volumes had been read at all.
    """
    bare, cluster, disk, k8s, raw = _a_cluster_with_something_of_everything_on_it(monkeypatch, tmp_path)
    assert bare == round(raw, 4)

    priced = cluster.estimate_usd_hr("eks", {"t3.large": 1},
                                     loadbalancers=1, volume_gb=8)
    assert priced["usd_hr"] == round(
        raw + cluster.LOADBALANCER_USD_HR + 8 * disk, 4)
    assert not priced["incomplete"]

    # A count that could not be READ is a different answer from one that is zero, and
    # says so -- "incomplete" rather than a quietly smaller number.
    partial = cluster.estimate_usd_hr("eks", {"t3.large": 1},
                                      loadbalancers=None, volume_gb=None)
    assert partial["usd_hr"] == bare
    assert partial["incomplete"] == ["load balancers", "workspace volumes"]

    # ORDERING, end to end: a cluster with a load balancer must price it. This is the
    # structural half of the bug -- the arithmetic was always right, it just ran too
    # early to see its inputs.
    monkeypatch.setattr(k8s.context, "contexts", lambda: (["c"], ""))
    monkeypatch.setattr(k8s.reachability, "reachable", lambda ctx=None, timeout=None: True)
    monkeypatch.setattr(k8s.reachability, "reach", lambda ctx=None, timeout=None: k8s.Reach(
        status=k8s.REACH_OK))
    monkeypatch.setattr(k8s.context, "distribution", lambda ctx: "eks")
    monkeypatch.setattr(k8s.names, "is_ours", lambda ctx: False)
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx: [])
    monkeypatch.setattr(k8s.operator, "operator_installed", lambda ctx: False)
    monkeypatch.setattr(k8s.monitoring, "monitoring_installed", lambda ctx: False)

    def ask(kind, **kw):
        if kind == "nodes":
            return k8s.Answer(state=k8s.PRESENT, doc={"items": [
                {"metadata": {"labels": {
                    "node.kubernetes.io/instance-type": "t3.large"}}}]})
        if kind == "svc":
            return k8s.Answer(state=k8s.PRESENT,
                              doc={"items": [{"spec": {"type": "LoadBalancer"}}]})
        return k8s.Answer(state=k8s.PRESENT, doc={"items": []})

    monkeypatch.setattr(k8s.ask, "ask_list", ask)
    out = cluster.status(context="c")
    assert out["loadbalancers"] == 1
    assert out["cost"]["usd_hr"] == round(raw + cluster.LOADBALANCER_USD_HR, 4), \
        "the load balancer on the line above must be in the total below it"
