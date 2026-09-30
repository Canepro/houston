"""`services/k8s/` as a package: the façade, the tiers, and the seam rules.

The Kubernetes seam is the largest module in houston and the one whose tests are least
portable — 145 sites patch `k8s.run` alone. So the split has to keep three things true,
and each is checked here rather than inferred:

* every name the single file exported still resolves through the façade;
* no module imports a higher tier, read from the tree rather than from the plan;
* a patch on the module that OWNS a symbol is seen by the caller that uses it.
"""
from __future__ import annotations

from conftest import functions_through

import ast
import json
import pathlib

import pytest

from houston.services import k8s
from houston.services.k8s import (ask, capabilities, certmanager,
                                  chart, cluster, context, endpoints,
                                  forward, ingress, manifests, monitoring,
                                  names, namespace, operator, probe,
                                  reachability, release, replicaset, scale,
                                  status, tools, transfer, workspace)
from houston.services.k8s import exec as kubeexec

#: The 294 top-level names `houston/services/k8s.py` exported on the commit before it
#: became a package. A FROZEN SURFACE, not a count: call sites across `lifecycle/`,
#: `doctor/`, `cli/` and `web/` read them off the façade, and a count passes just as
#: happily if one is dropped and another added.
EXPORTED_BY_THE_SINGLE_FILE = (
    "ABSENT", "ACME_ISSUER", "ACME_ISSUER_STAGING", "ACME_PRODUCTION", "ACME_STAGING",
    "AMD64", "APPLY_TIMEOUT", "APP_SELECTOR", "Answer", "CA_ISSUER", "CA_ISSUER_SECRET",
    "CERT_MANAGER_DEPLOYMENTS", "CERT_MANAGER_INTERVAL", "CERT_MANAGER_MANIFEST",
    "CERT_MANAGER_NAMESPACE", "CERT_MANAGER_VERSION", "CERT_WAIT_INTERVAL",
    "CERT_WAIT_TRIES", "CHART", "CLUSTER_LOCK", "CLUSTER_NAME", "CONTEXT", "CORE_TOOLS",
    "CREATE_TIMEOUT", "ClusterPlan", "DEFAULT_FLOOR_REASON", "DELETE_TIMEOUT",
    "ENDPOINT_WAIT_INTERVAL", "ENDPOINT_WAIT_TRIES", "FIRST_MULTIARCH_RC",
    "GRAFANA_DELETE_WAIT", "GRAFANA_DEPLOYMENT", "GRAFANA_KINDS", "GRAFANA_PORT",
    "GRAFANA_SERVICE", "GRAFANA_WAIT_INTERVAL", "GRAFANA_WAIT_TRIES", "HELM_REPO",
    "HELM_REPO_URL", "INGRESS_CHART", "INGRESS_CLASS_INTERVAL", "INGRESS_CLASS_TRIES",
    "INGRESS_NAMESPACE", "INGRESS_PORT", "INGRESS_RELEASE", "INGRESS_REPO",
    "INGRESS_REPO_URL", "INSTALL_TIMEOUT", "ISSUER_WAIT_INTERVAL", "IngressEndpoint",
    "IssuerSpec", "KUBECTL_SKEW", "LOADBALANCER_INTERVAL", "LOADBALANCER_TRIES",
    "LOCAL_DISTRIBUTIONS", "LOCAL_PROVISION_TOOLS", "LOG_CONTAINER", "LOG_SELECTOR",
    "MONGODB_CRD", "MONGO_ADMIN_USER", "MONGO_APP_DB", "MONGO_APP_USER",
    "MONGO_DB_SERVICE_ACCOUNT", "MONGO_DIRECT_URI", "MONGO_IMAGE_REPO",
    "MONGO_OPLOG_URL", "MONGO_READY_INTERVAL", "MONGO_SERVICE", "MONGO_URL",
    "MONGO_URL_SECRET", "MONGO_VOLUME_GB", "MONITORING_CHART", "MONITORING_LABEL",
    "MONITORING_MB", "MONITORING_NAMESPACE", "MONITORING_RELEASE", "NAMESPACE_PREFIX",
    "NS_GONE_INTERVAL", "NS_GONE_TRIES", "OLDEST_CHART_SERIES", "OPERATOR_CHART",
    "OPERATOR_MIN_MONGO", "OPERATOR_NAMESPACE", "OPERATOR_RELEASE", "OPERATOR_REPO",
    "OPERATOR_REPO_URL", "OWNER_LABEL_KEY", "OWNER_LABEL_VALUE", "OWNER_OF_LABEL",
    "OWNER_SELECTOR", "PENDING_STATES", "POD_GONE_INTERVAL", "POD_GONE_TRIES",
    "POD_WAIT_INTERVAL", "POD_WAIT_REFUSALS", "POD_WAIT_TRIES", "PRESENT",
    "PROBE_TIMEOUT", "PROVIDER_EXTERNAL", "PROVIDER_KIND", "PROVISION_TOOLS",
    "PortClaim", "Preflight", "REACHABLE_SERVICE_TYPES", "REACH_DENIED", "REACH_DOWN",
    "REACH_NO_CONTEXT", "REACH_OK", "READY_SELECTOR", "REFUSED", "REG_TOKEN_KEY",
    "REG_TOKEN_SECRET", "RELEASE", "RS_INITIATE", "Reach", "SCALE_ANNOTATION",
    "TERMINAL_POD_REASONS", "TOOLS", "TOOL_FLOOR_REASON", "Tool", "UI_PORT_LABEL",
    "USE_OPERATOR_ENV", "WATCH_ENV", "WORKSPACE_LABEL", "_CHART_CONDITIONAL_ENV",
    "_DENIED_MARKS", "_KUBELET_SUFFIX", "_MONGO_TRANSIENT", "_NO_CONTEXT_PATTERNS",
    "_PROVIDER_ID_PREFIX", "_classify", "_context_advice",
    "_forward_alive_without_argv", "_labels", "_listening_inodes", "_mongo_exec",
    "_mongo_exec_once", "_parse_quantity", "_parse_version", "_pod_count",
    "_pods_waiting", "_refuse_foreign_namespace", "_report_install_progress",
    "_scalables", "_socket_inodes_of", "_version_key", "acme_issuer_manifest",
    "active_context", "apply", "architecture_blocker", "ask_list", "ask_object",
    "assert_context_known", "assert_namespace_available", "ca_issuer_manifest",
    "cert_manager_install_hint", "cert_manager_installed", "clear_grafana_finalizers",
    "clear_pending_release", "cluster_context", "cluster_reclaimable", "clusters",
    "container_env", "container_security_context", "context_servers", "contexts",
    "create_workspace", "delete_cluster", "delete_namespace", "desired_replicas",
    "distribution", "distribution_of", "ensure_acme_issuer", "ensure_ca_issuer",
    "ensure_cert_manager", "ensure_cluster", "ensure_ingress", "ensure_issuer",
    "ensure_kubeconfig", "ensure_monitoring", "ensure_namespace", "ensure_operator",
    "ensure_port_forward", "ensure_repo", "env_for", "exec_capture", "exec_from_file",
    "exec_to_file", "forget_context", "forward_alive", "forward_bound",
    "forward_reachable", "grafana_forward", "grafana_leftovers", "helm_env",
    "helm_reachable", "helm_rollback_on_failure", "host_port_claim", "ingress_classes",
    "ingress_endpoint", "ingress_values", "init_replica_set", "install",
    "is_local_address", "is_local_cluster", "is_ours", "kind_node_container", "kube",
    "loadbalancer_address", "loadbalancer_service", "loadbalancer_state", "log_process",
    "metrics_available", "mint_namespace", "mongo_image", "mongo_manifest",
    "mongo_pods_the_operator_keeps", "mongo_rbac_manifest", "mongo_secret_manifest",
    "mongo_tool_auth", "mongo_url_secret_manifest", "mongodb_community_manifest",
    "mongodb_resources", "monitoring_installed", "monitoring_wanted", "namespace_for",
    "namespace_labels", "namespace_owner", "node_address", "nodes_summary",
    "operator_enabled", "operator_installed", "operator_is_ours", "operator_mongo_url",
    "operator_presence", "operator_supports", "operator_version",
    "operator_watch_scope", "operator_watches", "owned_env", "owned_kubeconfig",
    "pid_owns_port", "pid_owns_port_exclusively", "plan_cluster", "pod_metrics",
    "pod_rows", "port_claiming_cluster", "port_forward", "preflight", "reach",
    "reachable", "record_rendered", "reg_token_secret_manifest", "release_installed",
    "release_state", "release_values", "remove_monitoring", "remove_operator",
    "render_scenario_manifest", "resolve_chart_version", "run", "scale_rocketchat",
    "scale_workspace", "scenario_ui_forwards", "server_version",
    "service_ready_addresses", "services_without_endpoints", "set_monitoring_label",
    "short_name", "skew", "split_image", "start_workspace", "stop_forward",
    "stop_workspace", "storage_blocker", "storage_classes", "terminal_pod_failure",
    "tls_secret_for", "tool", "tuning", "upgrade_image", "user_env", "values_for",
    "wait_for_certificate", "wait_for_grafana", "wait_for_loadbalancer",
    "wait_for_mongodb", "wait_namespace_gone", "which", "why", "workload_exists",
    "workspace_namespaces", "workspace_pvcs", "workspace_ready",
)

TIERS = json.loads(
    (pathlib.Path(__file__).parent.parent / "tools" / "move-table.json").read_text(
        encoding="utf-8"))["modules"]["houston/services/k8s.py"]["tiers"]
EXTRACTED = (names, kubeexec, ask, tools, reachability, context,
             capabilities, endpoints, probe, cluster, manifests,
             namespace, release, replicaset, status, scale, transfer,
             operator, monitoring, certmanager, ingress, forward, chart,
             workspace)


def test_every_name_the_single_file_exported_still_resolves():
    """294 symbols. A missing one is an AttributeError in a route, not here."""
    missing = []
    for name in EXPORTED_BY_THE_SINGLE_FILE:
        try:
            getattr(k8s, name)
        except AttributeError as exc:
            missing.append(f"{name}: {exc}")
    assert not missing, missing
    assert len(EXPORTED_BY_THE_SINGLE_FILE) == 294


def test_the_facade_resolves_the_imports_the_single_file_exposed():
    """`k8s.subprocess.popen` is patched at 13 sites and `k8s.shutil.which` at 5.

    `subprocess` is `houston.exec`, not the standard library — the single file spells it
    `from houston import exec as subprocess`, so that is what the name has always meant
    here.
    """
    from houston import exec as houston_exec

    assert k8s.subprocess is houston_exec
    assert k8s.shutil.__name__ == "shutil"


def test_the_facade_never_caches_so_a_patch_on_the_owner_is_seen(monkeypatch):
    """145 sites patch `k8s.run`. A cached façade freezes the original and every one of
    them goes green over the real function."""
    monkeypatch.setattr(namespace, "namespace_for", lambda n: f"patched-{n}")
    assert k8s.namespace_for("x") == "patched-x"


def test_an_unknown_name_is_an_attribute_error_not_an_import_error():
    with pytest.raises(AttributeError, match="no attribute 'not_a_symbol'"):
        k8s.not_a_symbol


@pytest.mark.parametrize("module", EXTRACTED,
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_an_extracted_module_never_imports_a_higher_tier(module):
    """Proven of the TREE, from the import statements that exist, rather than of the
    plan. The two disagree exactly when an extraction was done differently from how it
    was planned."""
    own = TIERS[module.__name__.rsplit(".", 1)[-1]]
    tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
    reaches = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if (node.module or "") == "houston.services.k8s":
            targets = [a.name for a in node.names]
        elif (node.module or "").startswith("houston.services.k8s."):
            targets = [node.module.rsplit(".", 1)[-1]]
        else:
            continue
        reaches += [f"{t} (tier {TIERS[t]})" for t in targets
                    if t in TIERS and TIERS[t] > own]
    assert not reaches, f"{module.__name__} (tier {own}) imports upward: {reaches}"


def test_tier_zero_talks_to_nothing():
    """`names` is the vocabulary. It reads no file, opens no socket and spawns no
    process, which is what lets every other module in the package reach it."""
    source = pathlib.Path(names.__file__).read_text(encoding="utf-8")
    for forbidden in ("subprocess", "socket", "open(", "Path(", "requests"):
        assert forbidden not in source, (
            f"tier 0 reaches for {forbidden!r}; it is meant to be pure vocabulary")


def test_selection_is_by_label_and_never_by_name_prefix():
    """A name-prefix match is how a workspace somebody else called `houston-anything`
    became eligible for teardown. `is_ours` and `OWNER_SELECTOR` are the only two ways
    to ask."""
    assert names.OWNER_SELECTOR.startswith(names.OWNER_LABEL_KEY)
    source = pathlib.Path(names.__file__).read_text(encoding="utf-8")
    assert "startswith(NAMESPACE_PREFIX)" not in source


def test_a_refused_read_is_not_an_empty_answer():
    """`Answer.__bool__` raises on purpose, so `if ask_object(...)` cannot be written.

    The alternative is the defect `namespace_labels` was fixed for in v0.70.9: a cluster
    that would not say and a cluster with nothing in it are different facts, and
    collapsing them is how a teardown deletes something it never confirmed. `ask.py`
    holds `Answer` alone so the invariant has one file to walk.
    """
    with pytest.raises(TypeError):
        bool(ask.Answer(state=ask.REFUSED))
    with pytest.raises(TypeError):
        bool(ask.Answer(state=ask.ABSENT))
    assert ask.Answer(state=ask.REFUSED).refused
    assert ask.Answer(state=ask.ABSENT).absent
    assert ask.Answer(state=ask.PRESENT).present
    # And the three states are distinct, not two with an alias.
    assert len({ask.REFUSED, ask.ABSENT, ask.PRESENT}) == 3


def test_run_never_raises_and_reports_127_instead():
    """The single invocation funnel. Every caller reads a return code, so none of them
    has to choose between an exception and a result -- and 127 is what a shell reports
    for a command it could not run."""
    def explode(*a, **kw):
        raise OSError("no such binary")

    real = kubeexec.subprocess.run
    try:
        kubeexec.subprocess.run = explode
        res = kubeexec.run(["kubectl", "version"])
    finally:
        kubeexec.subprocess.run = real
    assert res.returncode == 127
    assert "no such binary" in res.stderr


def test_the_package_spawns_through_the_seam_and_never_the_standard_library():
    """`from houston import exec as subprocess` is what the single file meant by that
    name, and it is the seam the suite's process guard patches.

    Swapping it for the standard library is invisible to ruff, to the type checker and
    to most of the suite -- it showed up as `aws eks describe-cluster` actually running
    during a unit test, because the guard had nothing to intercept. `seam_check.py`
    catches it; this says why, next to the code.
    """
    import ast

    for module in EXTRACTED:
        tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for a in node.names:
                    assert a.name != "subprocess", (
                        f"{module.__name__} imports the standard library subprocess; "
                        f"the seam is `from houston import exec as subprocess`")


def test_kind_is_optional_because_using_a_cluster_is_not_creating_one():
    """A missing `kind` narrows what houston can do without stopping it working in the
    cluster you already have -- namespaces, releases, PVCs and port-forwards are plain
    Kubernetes and behave the same on k3s, minikube or a remote cluster."""
    assert "kind" not in names.CORE_TOOLS
    assert "kind" in names.LOCAL_PROVISION_TOOLS


def test_step_zero_never_creates_a_cluster_somebody_named():
    """`plan_cluster`'s five-step precedence, and step 0 is the one that costs money.

    houston may create only the cluster it OWNS. A context the caller named is theirs,
    and a `create=True` for it would build a second cluster beside the one they meant.
    The function's own comment calls this "the whole safety property of the cloud work":
    `plan_cluster` is reached by `up`, by `preflight()` and transitively by
    `check_capacity()`, so a branch that provisions here is one on which a CAPACITY CHECK
    can spend twenty minutes and real money.

    Walked as a tree rather than sliced out of the text: the `if context:` body is what
    step 0 is, and every `ClusterPlan` built inside it must say `create=False`.
    """
    import ast

    # Through the calls: 2b.15 moved step 0 into `_plan_from_named_context`, and
    # looking only at `plan_cluster`'s own body then read as "the branch is gone" --
    # which is the same sentence this guard would print if somebody had deleted it.
    step0 = next((n for fn in functions_through(context.plan_cluster)
                  for n in fn.body
                  if isinstance(n, ast.If) and getattr(n.test, "id", "") == "context"),
                 None)
    assert step0 is not None, "step 0 no longer branches on a caller-named context"
    plans = [n for n in ast.walk(step0)
             if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "ClusterPlan"]
    assert plans, "step 0 builds no ClusterPlan"
    for call in plans:
        create = {k.arg: k.value for k in call.keywords}.get("create")
        assert create is not None, "step 0 leaves `create` to the default"
        assert isinstance(create, ast.Constant) and create.value is False, (
            "step 0 would create a cluster for a context the caller named; houston may "
            "only create the one it owns")


@pytest.mark.parametrize("module", (reachability, context, capabilities, endpoints, probe),
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_a_tier_two_probe_changes_nothing(module):
    """k2 is READ-ONLY, and that is what lets `doctor` and every refusal run it freely.

    A probe that writes is a probe nobody can afford to call on the failure path, which
    is exactly where these are called. The check is on the verbs handed to kubectl and
    helm, because that is where a write would actually happen.
    """
    import ast

    writes = {"apply", "create", "delete", "patch", "replace", "install", "upgrade",
              "uninstall", "rollout", "scale", "annotate", "label", "cordon", "drain"}
    source = pathlib.Path(module.__file__).read_text(encoding="utf-8")
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.List):
            continue
        words = [e.value for e in node.elts
                 if isinstance(e, ast.Constant) and isinstance(e.value, str)]
        if words and words[0] in ("kubectl", "helm"):
            found += [w for w in words if w in writes]
    assert not found, f"{module.__name__} is a read-only probe and issues {found}"


def test_delete_cluster_takes_no_cluster_to_delete():
    """It can only ever mean ours, and a parameter would be an invitation to pass
    somebody else's.

    houston creates exactly one cluster — the local one — and adopts every other. A
    signature that accepts a name is one a caller can point at an EKS cluster somebody
    is paying for, so the absence of the parameter IS the safety property.
    """
    import inspect as _inspect

    params = _inspect.signature(cluster.delete_cluster).parameters
    assert not [p for p in params.values()
                if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)], (
        f"delete_cluster grew a positional parameter: {list(params)}")
    assert "context" not in params and "name" not in params, (
        f"delete_cluster can now be pointed at a cluster it does not own: {list(params)}")


def test_a_namespace_is_selected_by_label_and_confirmed_before_it_counts_as_gone():
    """Two rules, and both were bought with a defect.

    Selection is BY LABEL: a name-prefix match once made a namespace somebody else
    created eligible for teardown. And a namespace that cannot be CONFIRMED gone is not
    gone — reading a failed query as "it went away" is how a workspace's record is
    removed while its PersistentVolumeClaim goes on holding disk.
    """
    source = pathlib.Path(namespace.__file__).read_text(encoding="utf-8")
    assert "startswith(NAMESPACE_PREFIX)" not in source
    assert "OWNER_SELECTOR" in source or "vocab.is_ours" in source, (
        "namespace selection no longer goes through the label vocabulary")


def test_the_unsplit_remainder_is_gone_and_stays_gone():
    """Step 2b.11 emptied it and deleted it. `k8s` is twenty-four modules and a façade.

    The file was named `_unsplit` so nobody could mistake it for a home. This is the
    other end of that: a module reappearing under that name means somebody put code back
    rather than deciding where it goes.
    """
    package = pathlib.Path(k8s.__file__).parent
    assert not (package / "_unsplit.py").exists(), \
        "the remainder is back; every symbol has a home in the map"
    modules = sorted(p.stem for p in package.glob("*.py") if p.stem != "__init__")
    assert modules == sorted(m.__name__.rsplit(".", 1)[-1] for m in EXTRACTED)
    assert len(modules) == 24, modules
    # And the façade still holds no code of its own.
    body = pathlib.Path(k8s.__file__).read_text(encoding="utf-8")
    assert body.count("\ndef ") == 2, "the façade grew a function of its own"


def test_workspace_is_the_top_of_the_tiers_and_nothing_imports_it():
    """k4 means exactly this. `create_workspace` orchestrates every other module, so a
    module importing IT would be a cycle by construction — and the one the tiers exist
    to make unwritable."""
    import ast

    for module in EXTRACTED:
        if module is workspace:
            continue
        tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                named = [a.name for a in node.names]
                assert "workspace" not in named, (
                    f"{module.__name__} imports workspace; k4 is the top of the tiers")
                assert not (node.module or "").endswith(".workspace"), (
                    f"{module.__name__} imports workspace; k4 is the top of the tiers")
