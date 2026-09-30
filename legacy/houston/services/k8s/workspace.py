"""Creating a workspace in a cluster: the one function everything below this line serves.

Tier k4, and nothing in the package imports it -- which is what being the top of the
tiers means. It is the orchestrator: the namespace, MongoDB, the chart release, the
scenario's manifests and the port-forward, in the order that each one's failure can
still be acted on.
"""
from __future__ import annotations

import secrets
import time

from houston.errors import PreflightError
from houston.services.events import Emit, info, null_emit, warn

from houston.services.k8s import capabilities
from houston.services.k8s import certmanager
from houston.services.k8s import chart
from houston.services.k8s import cluster
from houston.services.k8s import context as kubectx
from houston.services.k8s import forward
from houston.services.k8s import ingress
from houston.services.k8s import manifests as kubedocs
from houston.services.k8s import names as vocab
from houston.services.k8s import namespace as kubens
from houston.services.k8s import operator
from houston.services.k8s import probe
from houston.services.k8s import release as kuberelease
from houston.services.k8s import replicaset
from houston.services.k8s.certmanager import IssuerSpec
from houston.services.k8s.context import ClusterPlan
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, CHART, MONGO_OPLOG_URL, MONGO_URL, MONGO_VOLUME_GB, RELEASE
from houston.services.k8s.operator import MONGO_URL_SECRET, OPERATOR_MIN_MONGO, REG_TOKEN_SECRET


def _prepare_cluster(plan, resolved, emit):
    """Provision or adopt the cluster, resolve its chart, and enforce capability gates."""
    plan = plan or kubectx.plan_cluster()
    context = cluster.ensure_kubeconfig(plan, emit=emit)
    if not plan.create and not vocab.is_ours(context):
        info(emit, f"using your {plan.distribution} cluster {context!r} — houston "
                   "creates a namespace in it and never removes the cluster",
             phase="provision", pct=5)
    had_cluster = not plan.create
    if not had_cluster or plan.distribution != "kind":
        info(emit, f"the {plan.distribution} cluster has its own image store, separate "
                   f"from Docker's — a version already pulled for Compose is fetched "
                   f"again here (about 1.6 GB the first time)",
             phase="provision", pct=6)
    chart.ensure_repo(emit=emit)
    chart_version = chart.resolve_chart_version(resolved.rc_version, emit=emit)
    info(emit, f"chart {chart_version} for Rocket.Chat {resolved.rc_version}",
         phase="plan")
    pre = probe.preflight(context)
    blocked = (capabilities.storage_blocker(pre)
               or capabilities.architecture_blocker(pre, resolved.rc_version))
    if blocked:
        raise PreflightError(blocked)
    return plan, context, had_cluster, chart_version


def _ensure_workspace_namespace(name, context, owner, emit):
    """Create or adopt the namespace and remember whether rollback may remove it."""
    # Whether the namespace was already here decides what a failure may undo. A
    # re-create over a namespace kept by `down` must NOT have its rollback delete
    # that namespace: the PVC goes with it, and `down` had just promised the data
    # would be there. REFUSED READS COUNT AS "IT WAS ALREADY THERE": never destroy
    # data we could not prove was ours to destroy.
    held = capabilities.workspace_namespaces(context)
    had_namespace = held is None or kubens.namespace_for(name) in held
    namespace = kubens.ensure_namespace(
        name, context=context, owner=owner, emit=emit)
    return namespace, had_namespace


def _operator_database(name, resolved, owner, namespace, context, emit):
    """Install an operator-managed MongoDB and return its connection metadata."""
    operator.ensure_operator(context=context, namespace=namespace, emit=emit)
    app_password = secrets.token_urlsafe(24)
    info(emit, f"MongoDB {resolved.mongo_tag} via the operator, SCRAM auth, "
               f"{MONGO_VOLUME_GB}Gi volume", phase="provision", pct=20)
    kuberelease.apply(operator.mongo_rbac_manifest(name, owner=owner),
          namespace=namespace, context=context)
    kuberelease.apply(operator.mongo_secret_manifest(
        name, admin_password=secrets.token_urlsafe(24),
        app_password=app_password, owner=owner),
        namespace=namespace, context=context)
    operator_doc = operator.mongodb_community_manifest(
        name, resolved.mongo_tag, owner=owner)
    kuberelease.apply(operator_doc, namespace=namespace, context=context)
    operator.wait_for_mongodb(namespace=namespace, context=context, emit=emit)
    return {
        "mongo_url": operator.operator_mongo_url(namespace, app_password),
        "oplog_url": operator.operator_mongo_url(namespace, app_password, oplog=True),
        "rendered": {"mongodb": operator_doc},
        "managed_by": "operator",
        "image": (f"mongodb-community-server {operator.operator_version(resolved.mongo_tag)} "
                  "(operator's choice)"),
    }


def _statefulset_database(name, resolved, owner, namespace, context, emit,
                          operator_requested):
    """Install the unauthenticated StatefulSet fallback and initiate its replica set."""
    floor = ".".join(str(n) for n in OPERATOR_MIN_MONGO)
    why_no_auth = (
        "the MongoDB operator is opt-in — add `--mongo-operator` for a "
        "database with SCRAM authentication"
        if not operator_requested else
        f"the operator cannot manage MongoDB below {floor}, so this falls "
        f"back to a plain StatefulSet")
    info(emit, f"MongoDB {resolved.mongo_tag}, {MONGO_VOLUME_GB}Gi volume "
               f"(no authentication: {why_no_auth})",
         phase="provision", pct=20)
    kuberelease.apply(kubedocs.mongo_manifest(name, resolved.mongo_tag, owner=owner),
          namespace=namespace, context=context)
    replicaset.init_replica_set(namespace=namespace, context=context, emit=emit)
    return {"mongo_url": MONGO_URL, "oplog_url": MONGO_OPLOG_URL,
            "rendered": {}, "managed_by": "statefulset",
            "image": vocab.mongo_image(resolved.mongo_tag)}


def _provision_database(name, resolved, use_operator, owner, namespace, context, emit):
    """Choose the operator or StatefulSet path without changing their ordering."""
    requested = use_operator or operator.operator_enabled()
    if requested and operator.operator_supports(resolved.mongo_tag, forced=use_operator):
        return _operator_database(name, resolved, owner, namespace, context, emit)
    return _statefulset_database(
        name, resolved, owner, namespace, context, emit, requested)


def _apply_scenario_and_secrets(name, preset, reg_token, owner, namespace,
                                context, database, emit):
    """Apply scenario resources and the Secrets consumed by the Rocket.Chat chart."""
    rendered = database["rendered"]
    manifests = list(getattr(preset, "kubernetes_manifests", None) or [])
    if manifests:
        count = len(manifests)
        info(emit, f"applying the {getattr(preset, 'scenario', '') or preset.name} "
                   f"scenario — {count} resource{'' if count == 1 else 's'}",
             phase="provision", pct=25)
        for i, manifest in enumerate(manifests):
            body = kubedocs.render_scenario_manifest(manifest, name)
            rendered[f"scenario-{i}" if i else "scenario"] = body
            kuberelease.apply(body, namespace=namespace, context=context)
    kuberelease.apply(operator.mongo_url_secret_manifest(
        name, mongo_url=database["mongo_url"], oplog_url=database["oplog_url"],
        owner=owner), namespace=namespace, context=context)
    if reg_token:
        info(emit, "installing the registration token Secret", phase="boot")
        kuberelease.apply(operator.reg_token_secret_manifest(
            name, token=reg_token, owner=owner), namespace=namespace, context=context)


def _install_chart(name, resolved, microservices, replicas, root_url, tls_host,
                   reg_token, admin_password, preset, issuer, ingress_class,
                   namespace, context, chart_version, emit):
    """Build values, prepare TLS, and install the Rocket.Chat release."""
    values = chart.values_for(
        rc_version=resolved.rc_version, rc_image=resolved.rc_image,
        microservices=microservices, replicas=replicas,
        root_url=("" if tls_host else root_url), host=tls_host,
        oplog=resolved.oplog, mongo_secret=MONGO_URL_SECRET,
        reg_token_secret=(REG_TOKEN_SECRET if reg_token else ""),
        admin_password=admin_password, preset_env=getattr(preset, "env", None))
    if tls_host:
        spec = issuer or IssuerSpec(mode="local")
        certmanager.ensure_issuer(spec, context=context, ingress_class=ingress_class,
                                  emit=emit)
        values.update(ingress.ingress_values(
            tls_host, ingress_class=ingress_class,
            secret_name=certmanager.tls_secret_for(name), issuer=spec.name))
    values.update(kubedocs.container_security_context(chart_version))
    info(emit, f"installing {CHART} as {RELEASE} — the pods pull the image now, "
               f"which is the longest step of a create", phase="boot", pct=60)
    kuberelease.install(namespace=namespace, context=context, values=values,
                        chart_version=chart_version, emit=emit)
    return values


def _rollback_create(namespace, context, had_namespace, had_cluster, emit):
    """Undo only resources this create proved it introduced."""
    if had_namespace:
        warn(emit, f"create failed — namespace {namespace} and its volume are "
                   "left as they were", phase="teardown")
        return
    warn(emit, f"create failed — removing namespace {namespace}", phase="teardown")
    try:
        kube.run(["kubectl", "--context", context, "delete", "namespace", namespace,
             "--wait=false"], timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
        if not had_cluster:
            cluster.delete_cluster(emit=emit)
    except Exception:  # noqa: BLE001 - the original failure is what matters
        pass


def _connect_workspace(name, namespace, context, host_port, bind_host,
                       previous_pid, previous_port, tls_host, values, rendered,
                       chart_version, microservices, database, emit):
    """Wait for TLS, establish forwards, persist manifests, and return metadata."""
    cert_ready = False
    if tls_host:
        cert_ready = certmanager.wait_for_certificate(
            certmanager.tls_secret_for(name), namespace=namespace,
            context=context, emit=emit)
    pid = forward.port_forward(
        name, namespace=namespace, context=context, host_port=host_port,
        bind_host=bind_host, previous_pid=previous_pid,
        previous_port=previous_port, emit=emit)
    time.sleep(1.0)
    if forward.forward_alive(pid, namespace=namespace, host_port=host_port):
        info(emit, f"port-forward established — http://localhost:{host_port}",
             phase="boot", pct=90)
    else:
        pid = 0
        warn(emit, f"the port-forward did not stay up, so "
                   f"http://localhost:{host_port} is not reachable yet. Once the "
                   f"pod is running: kubectl -n {namespace} port-forward "
                   f"deployment/{RELEASE}-rocketchat {host_port}:3000 "
                   f"— or `houston ready --name {name}` to re-establish it.",
             phase="boot")
    kubedocs.record_rendered(name, values=values, manifests=rendered)
    ui = forward.scenario_ui_forwards(
        name, namespace=namespace, context=context, bind_host=bind_host, emit=emit)
    return {"scenario_forwards": {str(k): v for k, v in ui.items()},
            "context": context, "namespace": namespace, "bind_host": bind_host,
            "chart_version": chart_version, "release": RELEASE,
            "port_forward_pid": pid, "microservices": microservices,
            "mongo_managed_by": database["managed_by"],
            "mongo_image": database["image"], "tls_host": tls_host,
            "certificate_ready": cert_ready}


def create_workspace(*, name: str, resolved, host_port: int, microservices: bool,
                     replicas: int = 1, owner: str = "", root_url: str = "",
                     bind_host: str = "", use_operator: bool = False,
                     reg_token: str = "", preset=None, plan: ClusterPlan | None = None,
                     tls_host: str = "", ingress_class: str = "",
                     issuer: "IssuerSpec | None" = None,
                     admin_password: str = "", previous_pid: int = 0,
                     previous_port: int | None = None,
                     emit: Emit = null_emit) -> dict:
    """Build a Kubernetes workspace, and return what repro.json needs.

    A PARALLEL path to lifecycle's compose one rather than a refactor of it, which
    is PR #3's call and the right one: lifecycle.py is compose-shaped throughout
    and two front-ends depend on it, so the Docker default stays byte-identical
    and this owns the Kubernetes sequence instead. Naming, version resolution and
    metadata are shared, not reimplemented.

    Ordered so nothing waits on something that cannot happen: the replica set is
    initiated BEFORE the chart goes in, because Rocket.Chat needs change streams
    and would otherwise sit at not-ready with nothing in its logs naming MongoDB.
    """
    plan, context, had_cluster, chart_version = _prepare_cluster(plan, resolved, emit)

    namespace, had_namespace = _ensure_workspace_namespace(name, context, owner, emit)
    try:
        database = _provision_database(
            name, resolved, use_operator, owner, namespace, context, emit)

        _apply_scenario_and_secrets(
            name, preset, reg_token, owner, namespace, context, database, emit)
        values = _install_chart(
            name, resolved, microservices, replicas, root_url, tls_host,
            reg_token, admin_password, preset, issuer, ingress_class,
            namespace, context, chart_version, emit)
    except Exception:
        # A failed create must not leave anything a user cannot see. No repro.json
        # is written until this returns, so a surviving namespace would be
        # invisible to `list` and to `down` -- and on Compose a failed `up` at
        # least leaves a workspace directory you can find. The cluster goes too if
        # this call created it and nothing else is using it: `delete_cluster`
        # refuses while any other workspace namespace is there, so a colleague's
        # concurrent `up` is safe from this.
        _rollback_create(namespace, context, had_namespace, had_cluster, emit)
        raise

    # AFTER the try/except, so a certificate that has not arrived cannot roll back a
    # workspace that installed perfectly well. cert-manager issues asynchronously
    # from the Ingress annotation, so this is the difference between "the name works"
    # and "the name will work in a moment, probably".
    return _connect_workspace(
        name, namespace, context, host_port, bind_host, previous_pid,
        previous_port, tls_host, values, database["rendered"], chart_version,
        microservices, database, emit)
