"""`houston.services.k8s.workspace`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from conftest import OWN_MODULE, call_order, source_through


def test_the_service_account_is_applied_before_the_database_that_needs_it():
    """Order matters and is not obvious: the RoleBinding has to exist before the
    StatefulSet tries to create a pod, or the pod is rejected and the operator
    backs off. Applying it with the Secrets -- ahead of the MongoDBCommunity
    resource -- is what makes the first attempt the successful one."""

    from houston.services import k8s

    # THROUGH THE STEPS. This is an ordering claim, and 2b.15 put the two calls in
    # different helpers of the same module -- where comparing two text offsets in
    # `create_workspace` alone compares nothing. `call_order` splices each step's own
    # calls in at the point the orchestrator calls them, which is the order the
    # assertion has always been about.
    rbac, community = call_order(k8s.create_workspace, "mongo_rbac_manifest",
                                 "mongodb_community_manifest", through=OWN_MODULE)
    assert rbac < community, "RBAC must be applied before the MongoDBCommunity"


def test_kubernetes_records_what_built_the_database_not_a_compose_flavour():
    """`mongo_flavor` is "official" / "bitnami-legacy" -- a COMPOSE image choice.

    The Kubernetes StatefulSet honours neither value, so reporting it made
    `houston list` print "8.0 (official)" for a workspace running Docker Hub's
    `mongo:8.0`. A label describing an image the workspace does not run is worse
    than no label, because it is the field someone checks when a version-specific
    bug will not reproduce.
    """

    from houston.services import k8s

    src = source_through(k8s.create_workspace)
    assert '"mongo_managed_by"' in src and '"mongo_image"' in src
    # Both branches must set it, or the record is right only half the time. DERIVED:
    # the claim is that the operator path and the StatefulSet path each say what built
    # the database, not that the value is reached by an assignment spelt
    # `managed_by = `. 2b.15 made both branches return a dict with the key in it, at
    # which point counting that spelling counted zero -- and would have counted zero
    # just the same if somebody had deleted the field. FINDINGS 3c, again.
    import ast as _ast

    said = {_ast.literal_eval(v) for node in _ast.walk(_ast.parse(src))
            if isinstance(node, _ast.Dict)
            for k, v in zip(node.keys, node.values)
            if isinstance(k, _ast.Constant) and k.value == "managed_by"
            and isinstance(v, _ast.Constant)}
    assert said == {"operator", "statefulset"}, (
        f"both database paths must record what built it, got {said or 'nothing'}")
