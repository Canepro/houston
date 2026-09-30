"""Prometheus and Grafana in the cluster, attachable to any workspace.

Shared, like the operator, and reference-counted the same careful way.
"""
from __future__ import annotations

from houston.errors import CreateFailedError
from houston.errors import DockerError
from houston.services.events import Emit
from houston.services.events import info
from houston.services.events import null_emit
import time
from houston.services.events import warn

from houston.services.k8s import ask
from houston.services.k8s import capabilities
from houston.services.k8s import exec as kubeexec
from houston.services.k8s import names as vocab
from houston.services.k8s import operator
from houston.services.k8s import release as kuberelease
from houston.services.k8s.exec import kube
from houston.services.k8s.names import APPLY_TIMEOUT, HELM_REPO, HELM_REPO_URL, INSTALL_TIMEOUT, NAMESPACE_PREFIX
from houston.services.k8s.operator import OPERATOR_NAMESPACE

#: The official chart, and it is a STACK: kube-prometheus-stack, grafana-operator
#: and Loki as dependencies. Eleven pods and about 1.0 GB measured on kind.
#: The namespace label that says a workspace wants the shared stack. One name, in
#: one place: it was a literal at the setter AND a literal in the reference count,
#: which is two chances to disagree about the thing that decides whether the shared
#: stack gets uninstalled.
MONITORING_LABEL = "houston.io/monitoring"

MONITORING_RELEASE = "monitoring"

MONITORING_CHART = f"{HELM_REPO}/monitoring"

#: Installed ONCE per cluster, next to the MongoDB operator, for the same reason and
#: then one more. The reason it shares: kube-prometheus-stack owns cluster-scoped
#: CRDs (Prometheus, PodMonitor, ...), so a per-workspace install collides on them
#: at the second workspace. The extra reason: even with every dependency disabled
#: the chart still renders a ClusterRole and ClusterRoleBinding at FIXED names
#: (`monitoring-otel-collector-role`) plus a log-collector DaemonSet -- so the
#: per-namespace install that looks like the compose shape does not compose either,
#: and would put one collector per node per workspace on the same host paths.
#:
#: Sharing is also what makes this affordable: one 1.0 GB stack for every workspace
#: on the box rather than 1.0 GB each, on a tool whose capacity preflight exists
#: because it runs on laptops.
MONITORING_NAMESPACE = OPERATOR_NAMESPACE

#: grafana-operator names the Grafana instance's Service this; `monitoring-grafana`
#: is the operator itself and serves nothing useful. Forwarding the wrong one gives
#: a page that loads and has no dashboards.
GRAFANA_SERVICE = "monitoring-grafana-service"

GRAFANA_DEPLOYMENT = "monitoring-grafana-deployment"

GRAFANA_PORT = 3000

#: Up to four minutes. The operator has to reconcile a Grafana CR into a Deployment
#: and then pull its image, which is well past what helm's own wait allows for.
GRAFANA_WAIT_TRIES = 48

GRAFANA_WAIT_INTERVAL = 5.0

#: cert-manager's namespace is baked into its own manifests and its CRDs are
#: cluster-scoped, so it is not one of ours to place.
CERT_MANAGER_NAMESPACE = "cert-manager"

def monitoring_installed(context: str) -> bool:
    """Whether this cluster already has a WORKING shared stack.

    `helm status` exits 0 for a release in any state, including one a killed install
    left in `pending-install` -- so this returned True for a namespace holding no
    Prometheus and no Grafana, `ensure_monitoring` took its early return, skipped
    both the install and `wait_for_grafana`, and `monitor` reported the stack
    attached. The dashboards did not exist.

    That is the exact collapse `release_state` was written for, in a function that
    was not migrated with the others. Only `deployed` means there is something to
    leave alone; pending, failed and absent all mean the install below should run,
    and it is `upgrade --install`, so running it is the repair.
    """
    try:
        state, _revision = kuberelease.release_state(MONITORING_RELEASE, MONITORING_NAMESPACE,
                                         context)
    except DockerError:
        # Could not ask. Not "installed" -- the caller's next step is an idempotent
        # `upgrade --install`, which is the safer way to be wrong here.
        return False
    return state == "deployed"

def ensure_monitoring(*, context: str, emit: Emit = null_emit) -> None:
    """Install the shared stack, or leave the existing one alone.

    The two `...SelectorNilUsesHelmValues=false` overrides are the whole reason a
    shared stack works. kube-prometheus-stack defaults them to true, which restricts
    Prometheus to monitors carrying its OWN release label -- so a workspace's
    PodMonitor, in a different namespace and a different release, is ignored and
    Grafana shows a dashboard with no data. Nothing errors; the graphs are simply
    empty, which is the kind of failure that gets read as "monitoring is broken"
    rather than "the selector excluded it".

    Rocket.Chat's own chart needs nothing: `prometheusScraping.enabled` and
    `podMonitor.enabled` are already its defaults, so the workspace publishes a
    PodMonitor as soon as it is installed. The scrape starts because the shared
    Prometheus is willing to look outside its own release, not because `--monitor`
    changed anything about the workspace.
    """
    kube.run(["helm", "repo", "add", HELM_REPO, HELM_REPO_URL, "--force-update"],
        timeout=APPLY_TIMEOUT, env=kubeexec.helm_env(context))
    if monitoring_installed(context):
        info(emit, "monitoring stack already on this cluster (shared)",
             phase="monitor")
        return
    info(emit, f"installing the monitoring stack in {MONITORING_NAMESPACE} "
               "(once per cluster, ~1 GB)", phase="monitor")
    # Deliberately NOT `--wait`. This chart creates grafana-operator custom
    # resources in the same release that installs the operator, and helm's readiness
    # check reaches them before the operator has reconciled anything:
    #
    #     Error: resource GrafanaDashboard/houston-system/monitoring-node-exporter-full
    #     not ready. status: NotFound, message: Resource not found
    #
    # which is a race, not a failure -- the stack came up perfectly well anyway, and
    # ten pods were Running while helm reported it broken. So the release is applied
    # without waiting and the thing that actually matters is waited for below.
    # Same as the operator above, and same blast radius: one shared release.
    kuberelease.clear_pending_release(MONITORING_RELEASE, MONITORING_NAMESPACE, context,
                          emit=emit)
    res = kube.run(["helm", "upgrade", "--install", MONITORING_RELEASE, MONITORING_CHART,
               "--kube-context", context, "-n", MONITORING_NAMESPACE,
               "--create-namespace",
               "--set", "operator.prometheus.prometheusSpec."
                        "serviceMonitorSelectorNilUsesHelmValues=false",
               "--set", "operator.prometheus.prometheusSpec."
                        "podMonitorSelectorNilUsesHelmValues=false",
               "--timeout", "9m", *kuberelease.helm_rollback_on_failure()],
              timeout=INSTALL_TIMEOUT, env=kubeexec.helm_env(context))
    if res.returncode != 0:
        raise CreateFailedError("could not install the monitoring stack: " + ask.why(res))
    wait_for_grafana(context=context, emit=emit)

def wait_for_grafana(*, context: str, emit: Emit = null_emit,
                     sleep=time.sleep) -> None:
    """Wait for the Grafana the operator builds, in two steps, because it arrives late.

    `monitoring-grafana-deployment` does not exist when helm returns: the
    grafana-operator has to see the Grafana custom resource and create it. So this
    waits for the Deployment to EXIST and only then for it to be available --
    `kubectl rollout status` on a missing Deployment is an error, not a wait, which
    would turn "not yet" into "failed".
    """
    for attempt in range(GRAFANA_WAIT_TRIES):
        res = kube.run(["kubectl", "--context", context, "-n", MONITORING_NAMESPACE,
                   "get", "deployment", GRAFANA_DEPLOYMENT, "-o",
                   "jsonpath={.status.availableReplicas}"], own=vocab.is_ours(context))
        if (res.stdout or "").strip() not in ("", "0"):
            return
        if attempt % 5 == 0:
            info(emit, "waiting for Grafana", phase="monitor")
        sleep(GRAFANA_WAIT_INTERVAL)
    warn(emit, "Grafana has not come up yet; the stack is installed and it should "
               f"appear shortly — kubectl -n {MONITORING_NAMESPACE} get pods",
         phase="monitor")

#: The grafana-operator custom resources this chart creates, in the order they must be
#: deleted -- children before the Grafana instance that owns them.
GRAFANA_KINDS: tuple[str, ...] = ("grafanadashboard", "grafanadatasource",
                                  "grafanafolder", "grafana")

#: How long ONE kind's delete may block. Short on purpose: a delete that has not
#: finished in this long is waiting on a finalizer nothing will clear, and the useful
#: response is to clear it, not to keep waiting. It was 60s per kind, and four of them
#: ran before a five-minute `helm uninstall --wait` that was also doomed.
GRAFANA_DELETE_WAIT = 15

def grafana_leftovers(context: str) -> list[tuple[str, str]]:
    """`(kind, name)` for every grafana-operator resource still present.

    Read AFTER a delete has been asked for and given a deadline, so a non-empty
    result means "these are not going to go on their own".
    """
    out: list[tuple[str, str]] = []
    for kind in GRAFANA_KINDS:
        res = kube.run(["kubectl", "--context", context, "-n", MONITORING_NAMESPACE,
                   "get", kind, "-o", "jsonpath={.items[*].metadata.name}"],
                  own=vocab.is_ours(context))
        if res.returncode != 0:
            continue                      # the CRD is not installed; nothing to find
        out.extend((kind, n) for n in (res.stdout or "").split())
    return out

def clear_grafana_finalizers(context: str) -> int:
    """Strip the operator finalizer from whatever is left, so the delete completes.

    A last resort, and safe as one: the operator that put the finalizer there is gone,
    so there is nothing whose cleanup we are skipping -- and the alternative is a
    namespace that sits in Terminating for ever and a release the next `--monitor`
    cannot install into.
    """
    cleared = 0
    for kind, name in grafana_leftovers(context):
        res = kube.run(["kubectl", "--context", context, "-n", MONITORING_NAMESPACE,
                   "patch", kind, name, "--type=merge", "-p",
                   '{"metadata":{"finalizers":[]}}'], own=vocab.is_ours(context))
        cleared += 1 if res.returncode == 0 else 0
    return cleared


def _monitoring_consumers(context: str, excluding: str, emit: Emit):
    """Namespaces other than `excluding` that still request the shared stack."""
    held = capabilities.workspace_namespaces(context)
    if held is None:
        warn(emit, "not removing the shared monitoring stack: the cluster's "
                   "namespace list could not be read, so whether another workspace "
                   "still wants it is unknown", phase="monitor")
        return None
    others = []
    for ns in held:
        if ns == excluding:
            continue
        wants = monitoring_wanted(ns, context=context)
        if wants is None:
            warn(emit, f"not removing the shared monitoring stack: could not read "
                       f"whether {ns} still wants it", phase="monitor")
            return None
        if wants:
            others.append(ns)
    return others


def _remove_grafana_resources(context: str, emit: Emit) -> None:
    """Delete operator resources before uninstalling the operator that finalises them."""
    # The grafana-operator's own resources go FIRST, while the operator that
    # processes their finalizers is still running. Letting helm delete everything at
    # once deadlocks: it removes the operator Deployment and then waits on a
    # GrafanaFolder whose finalizer nothing is left to clear.
    #
    # The ordering is not sufficient when the operator is already gone: the resources
    # then spend their full delete timeout waiting for finalizers nothing can clear.
    # The deletes get a SHORT deadline and are then CHECKED. Whether the operator is
    # running is deliberately not the test; what matters is whether the resources went.
    info(emit, "removing the Grafana resources", phase="monitor")
    for kind in GRAFANA_KINDS:
        kube.run(["kubectl", "--context", context, "-n", MONITORING_NAMESPACE, "delete",
             kind, "--all", "--ignore-not-found", f"--timeout={GRAFANA_DELETE_WAIT}s"],
            timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    stuck = grafana_leftovers(context)
    if stuck:
        warn(emit, f"{len(stuck)} Grafana resource(s) will not delete — nothing is left "
                   "to clear their finalizers, so clearing them now", phase="monitor")
        clear_grafana_finalizers(context)


def _uninstall_monitoring_release(context: str, emit: Emit) -> None:
    """Uninstall Helm while retaining the original best-effort finalizer recovery."""
    info(emit, "uninstalling the monitoring release", phase="monitor")
    res = kube.run(["helm", "uninstall", MONITORING_RELEASE, "--kube-context", context,
               "-n", MONITORING_NAMESPACE, "--wait", "--timeout", "5m"],
              timeout=INSTALL_TIMEOUT, own=vocab.is_ours(context))
    if res.returncode != 0:
        # The release is removed either way; a stuck finalizer must not leave the
        # cluster in a state the next `--monitor` cannot install into.
        clear_grafana_finalizers(context)
        warn(emit, "the monitoring stack needed its finalizers cleared by hand: "
                   + ask.why(res), phase="monitor")


def _reclaim_monitoring_volumes(context: str, emit: Emit) -> None:
    """Remove the Prometheus claims Helm deliberately leaves behind."""
    pvcs = kube.run(["kubectl", "--context", context, "-n", MONITORING_NAMESPACE,
                "get", "pvc", "-o", "name"],
               timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
    names = [ln.strip() for ln in (pvcs.stdout or "").splitlines() if ln.strip()]
    if pvcs.returncode != 0:
        warn(emit, "could not check whether the monitoring stack left a volume "
                   "behind — `kubectl -n " + MONITORING_NAMESPACE + " get pvc` "
                   "shows it", phase="monitor")
    elif names:
        gone = kube.run(["kubectl", "--context", context, "-n", MONITORING_NAMESPACE,
                    "delete", "pvc", "--all", "--ignore-not-found",
                    f"--timeout={GRAFANA_DELETE_WAIT}s"],
                   timeout=APPLY_TIMEOUT, own=vocab.is_ours(context))
        if gone.returncode == 0:
            info(emit, f"reclaimed {len(names)} monitoring volume(s)", phase="monitor")
        else:
            warn(emit, f"the monitoring stack's {len(names)} volume(s) could not be "
                       f"reclaimed and are still allocated: " + ask.why(gone),
                 phase="monitor")


def remove_monitoring(*, context: str, excluding: str = "",
                     emit: Emit = null_emit) -> bool:
    """Uninstall the shared stack. Returns False if another workspace still wants it.

    Shared, so `--off` on one workspace must not blind the others. This is the whole
    behavioural difference from Compose, where the stack belongs to a project and
    detaching it is unambiguous.

    `excluding` is the namespace of a workspace being DESTROYED, and it exists because
    the count reads a label on the namespace while `workspace_namespaces` does not
    filter by phase: a namespace still Terminating is still listed and still labelled,
    so a teardown asking "does anyone else want this?" would be told yes by the
    workspace it is in the middle of deleting.
    """
    # Nothing installed is nothing to report. Without this, `monitor --off` on a
    # workspace that never had monitoring ran the uninstall anyway, helm answered
    # "Release not loaded: monitoring: release: not found", and the fallback path
    # announced that "the monitoring stack needed its finalizers cleared by hand" --
    # a frightening sentence about wreckage that did not exist. Measured on a live
    # detach after an attach that had failed.
    if not operator.release_installed(MONITORING_RELEASE, MONITORING_NAMESPACE, context):
        return False
    others = _monitoring_consumers(context, excluding, emit)
    if others is None:
        return False
    if others:
        info(emit, "leaving the monitoring stack up — still used by "
                   + ", ".join(sorted(n.removeprefix(NAMESPACE_PREFIX) for n in others)),
             phase="monitor")
        return False
    _remove_grafana_resources(context, emit)
    _uninstall_monitoring_release(context, emit)
    # THE PROMETHEUS VOLUME, which helm does not take with the release. A
    # StatefulSet's PersistentVolumeClaims outlive it by design -- that is what keeps
    # a workspace's MongoDB data across a plain `down` -- but nothing here ever
    # deleted these, and there was no code path anywhere that could: a clean
    # `monitor --off` left `prometheus-...-db-...-0` Bound, 10 Gi, permanently. On a
    # laptop that is disk; on EKS it is a billed EBS volume nobody can see the source
    # of. Deleted by NAMESPACE, not by label: the chart's PVCs carry its own labels,
    # not houston's, and this namespace is houston's own.
    _reclaim_monitoring_volumes(context, emit)
    return True

def monitoring_wanted(namespace: str, *, context: str) -> bool | None:
    """Whether a workspace namespace is marked as wanting monitoring.

    A label on the namespace rather than a lookup in repro.json: `remove_monitoring`
    has to answer "does anyone else still want this?" about workspaces it is not
    holding the record for, and possibly ones created by a different user of the
    same cluster.
    """
    # `None` WHEN THE LABEL COULD NOT BE READ. This returned False for any failed
    # call, and False here means "this workspace does not want monitoring" -- so it is
    # the INNER test of `remove_monitoring`'s reference count. Fixing
    # `workspace_namespaces` to stop claiming an empty cluster does not help if the
    # per-namespace question then answers "no" for a namespace nobody could read: the
    # count still comes back empty and the SHARED stack is still uninstalled while
    # another workspace is using it. Same defect, one level down.
    #
    # `-o json` rather than a jsonpath, because an empty jsonpath result cannot say
    # whether the LABEL is absent or the NAMESPACE is.
    seen = ask.ask_object("namespace", namespace, context=context)
    if seen.refused:
        return None
    if seen.absent:
        return False
    labels = ((seen.doc or {}).get("metadata") or {}).get("labels") or {}
    return str(labels.get(MONITORING_LABEL, "")).strip() == "true" \
        if isinstance(labels, dict) else False

def set_monitoring_label(namespace: str, *, context: str, wanted: bool) -> None:
    """Mark (or unmark) a namespace as wanting the shared stack."""
    value = "true" if wanted else "-"
    kube.run(["kubectl", "--context", context, "label", "--overwrite", "namespace",
         namespace, f"{MONITORING_LABEL}={value}" if wanted
         else f"{MONITORING_LABEL}-"], own=vocab.is_ours(context))
