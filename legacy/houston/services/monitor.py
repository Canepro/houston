"""Attach/detach the Prometheus+Grafana monitoring add-on — shared by CLI and API.

Extracted from cli.py's `monitor` command. Raises houston.errors and reports via
`emit`; also used by the web GUI (and needed by loadtest --live).
"""

from __future__ import annotations

from houston import compose, config, monitoring, rcapi, runner
from houston.errors import DockerError, NotReadyError, ValidationError
from houston.services import lifecycle
from houston.services.events import Emit, info, null_emit, warn


def _mapping(value, what: str, name: str) -> dict:
    """`value`, when it is the mapping a compose document holds there; else refused.

    A hand-edited compose file can hold a service with no body (`mongodb:` alone reads
    as None), or a list or a string where a mapping belongs. `svc.get` on one was an
    AttributeError, a traceback and exit 1 -- after the metrics setting had been turned
    on, and before anything was written. This refuses at the same point, in one line
    (P21, g3-35).
    """
    if not isinstance(value, dict):
        raise ValidationError(
            f"cannot edit the compose file of {name!r}: {what} is a "
            f"{type(value).__name__}, not a mapping")
    return value


def _detect_bind(doc: dict, name: str = "") -> str:
    """Host bind interface from an existing published port (ip:host:container)."""
    for service, svc in _mapping(doc.get("services", {}), "'services'", name).items():
        for p in _mapping(svc, f"service {service!r}", name).get("ports", []):
            parts = str(p).split(":")
            if len(parts) == 3:
                return parts[0]
    return config.DEFAULT_BIND_HOST


def _rc_services_in(doc: dict) -> list[str]:
    return [s for s in doc.get("services", {}) if s == "rocketchat" or s.startswith("rocketchat-")]


def attach(name: str, emit: Emit = null_emit) -> dict:
    from houston.services import topology
    if topology.of_repro(lifecycle.resolve_name(name)) == topology.KUBERNETES:
        return _attach_kubernetes(lifecycle.resolve_name(name), emit)
    lifecycle.require_docker()
    target = lifecycle.resolve_name(name)
    # Same read-compose -> write-compose -> `docker compose up` shape as env and
    # backup, so it takes the same per-repro lock.
    with runner.repro_lock(target):
        return _attach_locked(target, emit)


def _attach_locked(target: str, emit: Emit = null_emit) -> dict:
    m = runner.read_meta(target)
    doc = runner.read_compose(m.name)
    lifecycle.check_monitor_ports(exclude=m.name)   # raises ConflictError on a taken port
    try:
        auth = lifecycle.login(m)
        if not rcapi.set_setting(m.root_url, auth, m.admin_pass,
                                 monitoring.RC_METRICS_SETTING, True):
            warn(emit, "could not enable RC metrics via the API (is it ready?)", phase="config")
    except Exception as exc:  # noqa: BLE001
        raise NotReadyError(f"repro not reachable to enable metrics (ready first): {exc}") from exc

    services = _mapping(doc.setdefault("services", {}), "'services'", m.name)
    services.update(monitoring.bind_ports(monitoring.services(), _detect_bind(doc, m.name)))
    _mapping(doc.setdefault("volumes", {}), "'volumes'", m.name).update(monitoring.volumes())
    m.extra["monitoring"] = True
    m.extra["monitoring_ports"] = list(config.MONITOR_PORTS)
    m.extra["notes"] = [n for n in m.extra.get("notes", []) if n not in monitoring.notes()] + monitoring.notes()
    targets = _rc_services_in(doc) or ["rocketchat"]
    runner.write(m.name, compose.to_yaml(doc), m, files=monitoring.files(targets, project=m.project))

    info(emit, "attaching monitoring (pulling images if needed)...", phase="boot")
    if runner.up(m.name, pull=True) != 0:
        raise DockerError("`docker compose up` failed bringing up monitoring")
    grafana = f"http://localhost:{config.MONITOR_PORTS[1]}"
    info(emit, f"monitoring attached to {m.name!r}", phase="done",
         data={"grafana_url": grafana, "notes": monitoring.notes()})
    return {"name": m.name, "monitoring": True, "grafana_url": grafana, "notes": monitoring.notes()}


def _kube_target(m) -> tuple[str, str]:
    """(namespace, context) for a Kubernetes workspace, defaulted like lifecycle's."""
    extra = getattr(m, "extra", None) or {}
    from houston.services import k8s
    return (str(extra.get("namespace") or k8s.namespace_for(m.name)),
            str(extra.get(config.EXTRA_CONTEXT) or k8s.CONTEXT))


def _attach_kubernetes(target: str, emit: Emit = null_emit) -> dict:
    """Point the cluster's shared stack at this workspace, and publish Grafana.

    Nothing is installed INTO the workspace. Rocket.Chat's chart already publishes a
    PodMonitor -- `podMonitor.enabled` and `prometheusScraping.enabled` are its
    defaults -- so what `--monitor` supplies is the Prometheus willing to read it,
    which lives once per cluster. That makes this a much cheaper operation than its
    Compose twin, and a shared one: see `k8s.remove_monitoring`.

    RC's own `Prometheus_Enabled` setting is turned on the same way as on Compose,
    over the same REST seam, because the port-forward makes the workspace reachable
    at exactly the URL the record already holds.
    """
    from houston.services import k8s
    m = runner.read_meta(target)
    namespace, context = _kube_target(m)
    lifecycle.check_monitor_ports(exclude=m.name)
    try:
        auth = lifecycle.login(m)
        if not rcapi.set_setting(m.root_url, auth, m.admin_pass,
                                 monitoring.RC_METRICS_SETTING, True):
            warn(emit, "could not enable RC metrics via the API (is it ready?)",
                 phase="config")
    except Exception as exc:  # noqa: BLE001
        raise NotReadyError(
            f"repro not reachable to enable metrics (ready first): {exc}") from exc

    k8s.ensure_monitoring(context=context, emit=emit)
    k8s.set_monitoring_label(namespace, context=context, wanted=True)
    port = config.MONITOR_PORTS[1]
    pid = k8s.grafana_forward(context=context, host_port=port,
                              bind_host=str((m.extra or {}).get("bind_host") or ""))
    runner.update_meta(m.name, lambda meta: meta.extra.update(
        {"monitoring": True, "monitoring_ports": [port], "grafana_pid": pid}))
    grafana = f"http://localhost:{port}"
    # Don't hand over a URL that has not answered yet. `port-forward` returns a pid
    # before it binds the socket, and the workspace path already carries a test
    # named for this exact mistake -- so this waits, and says so rather than
    # printing a link that quietly does not work.
    if not k8s.forward_reachable(port):
        warn(emit, f"Grafana is installed but {grafana} is not answering yet; "
                   f"re-run `houston monitor --name {m.name}` if it stays quiet",
             phase="monitor")
    info(emit, f"monitoring attached to {m.name!r}", phase="done",
         data={"grafana_url": grafana})
    return {"name": m.name, "monitoring": True, "grafana_url": grafana,
            "notes": [f"Grafana: {grafana} (admin/admin)",
                      "the stack is SHARED by every workspace on this cluster"]}


def _detach_kubernetes(target: str, emit: Emit = null_emit) -> dict:
    """Stop wanting the shared stack; uninstall it only if nobody else does."""
    from houston.services import k8s
    m = runner.read_meta(target)
    namespace, context = _kube_target(m)
    rc_ok = False
    # EMITTED, not silent. Removing the shared stack can take minutes -- it deletes
    # operator custom resources and then uninstalls a release -- and this function used
    # to say nothing at all until it was finished. A GUI job then showed "running" with
    # an empty log for the whole time, which is indistinguishable from a hang; that is
    # exactly how a nine-minute finalizer wait was reported as one.
    info(emit, f"turning Rocket.Chat's metrics off in {m.name!r}", phase="monitor")
    try:
        auth = lifecycle.login(m)
        rc_ok = rcapi.set_setting(m.root_url, auth, m.admin_pass,
                                  monitoring.RC_METRICS_SETTING, False)
    except Exception:  # noqa: BLE001 - best-effort; the repro may be stopped
        pass
    if not rc_ok:
        info(emit, "the workspace did not answer, so its metrics setting was left as "
                   "it is — the stack still comes down", phase="monitor")
    k8s.set_monitoring_label(namespace, context=context, wanted=False)
    info(emit, "checking whether another workspace still wants the shared stack",
         phase="monitor")
    removed = k8s.remove_monitoring(context=context, emit=emit)
    pid = (m.extra or {}).get("grafana_pid")
    if pid:
        # The Grafana forward lives in the SHARED monitoring namespace, not the
        # workspace's -- so that is the identity to prove before signalling a pid.
        lifecycle._stop_port_forward(int(pid), namespace=k8s.MONITORING_NAMESPACE)
    runner.update_meta(m.name, lambda meta: [meta.extra.pop(k, None) for k in
                                             ("monitoring", "monitoring_ports",
                                              "grafana_pid")])
    info(emit, f"monitoring detached from {m.name!r}", phase="done",
         data={"rc_setting_reset": rc_ok, "stack_removed": removed})
    return {"name": m.name, "monitoring": False, "rc_setting_reset": rc_ok,
            "stack_removed": removed}


def detach(name: str, emit: Emit = null_emit) -> dict:
    from houston.services import topology
    if topology.of_repro(lifecycle.resolve_name(name)) == topology.KUBERNETES:
        return _detach_kubernetes(lifecycle.resolve_name(name), emit)
    lifecycle.require_docker()
    target = lifecycle.resolve_name(name)
    # Same read-compose -> write-compose -> `docker compose up` shape as env and
    # backup, so it takes the same per-repro lock.
    with runner.repro_lock(target):
        return _detach_locked(target, emit)


def _detach_locked(target: str, emit: Emit = null_emit) -> dict:
    m = runner.read_meta(target)
    doc = runner.read_compose(m.name)
    rc_ok = False
    # Same reasoning as the Kubernetes path above: this had two emits and the last one
    # was at the end, so there was nothing to tell "working" from "wedged".
    info(emit, f"turning Rocket.Chat's metrics off in {m.name!r}", phase="monitor")
    try:
        auth = lifecycle.login(m)
        rc_ok = rcapi.set_setting(m.root_url, auth, m.admin_pass,
                                  monitoring.RC_METRICS_SETTING, False)
    except Exception:  # noqa: BLE001 - best-effort; the repro may be stopped
        pass
    if not rc_ok:
        info(emit, "the workspace did not answer, so its metrics setting was left as "
                   "it is — the containers still come down", phase="monitor")
    info(emit, f"removing {len(monitoring.SERVICES)} monitoring container(s)",
         phase="monitor")
    runner.rm_services(m.name, list(monitoring.SERVICES))
    info(emit, "removing the monitoring volumes", phase="monitor")
    # Remove the volumes while they are still DECLARED. `docker compose down -v`
    # only removes declared volumes, so dropping them from the doc below without
    # deleting them first orphans prometheus_tsdb/grafana_data/loki_data forever.
    for bad in runner.remove_volumes(m.name, list(monitoring.VOLUMES)):
        warn(emit, f"could not remove monitoring volume {bad} - remove it by hand",
             phase="done")
    # From the mappings the file holds, which are left out when it holds none: an empty
    # compose file is written back `{}`. A `services:` or `volumes:` that is not a mapping
    # was an AttributeError here too, and is refused the same way.
    services = _mapping(doc.get("services", {}), "'services'", m.name)
    for s in monitoring.SERVICES:
        services.pop(s, None)
    volumes = _mapping(doc.get("volumes", {}), "'volumes'", m.name)
    for v in monitoring.VOLUMES:
        volumes.pop(v, None)
    m.extra.pop("monitoring", None)
    m.extra.pop("monitoring_ports", None)
    m.extra["notes"] = [n for n in m.extra.get("notes", []) if n not in monitoring.notes()]
    runner.write(m.name, compose.to_yaml(doc), m)
    info(emit, f"monitoring detached from {m.name!r}", phase="done", data={"rc_setting_reset": rc_ok})
    return {"name": m.name, "monitoring": False, "rc_setting_reset": rc_ok}
