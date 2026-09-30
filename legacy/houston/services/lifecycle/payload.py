"""`detail` -- the one payload the GUI renders a whole panel from -- and its helpers.

Tier 3, and its own module on purpose. `tests/test_browser.py`'s `_fake_detail()` is a
hand-written copy of this shape; when the two drift the panel breaks in production with
the entire suite green. One file is what the fixture-vs-real invariant test points at.

Separate from `inspect` for that reason alone: everything here could have lived there,
and then the trap would have had 250 lines to hide in instead of 120.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from houston import config, runner
from houston.services import topology
from houston.services.lifecycle import inspect, naming
from houston.services.redact import redact_env

def _since(iso: str) -> str:
    """An ISO timestamp -> docker's phrasing for how long ago it was ("2 hours").

    The panel's Uptime cell is filled from docker's own `Status` string on Compose;
    on Kubernetes the same cell has to be built from a pod's startTime, and it has to
    read the SAME way. Two vocabularies in one column is how a reader stops trusting
    the column.
    """
    if not iso:
        return ""
    try:
        then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    secs = (datetime.now(timezone.utc) - then).total_seconds()
    if secs < 0:
        return ""
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        n = int(secs // size)
        if n:
            return f"{n} {unit}" + ("s" if n != 1 else "")
    n = int(secs)
    return f"{n} second" + ("s" if n != 1 else "")


def _bind_host_of(m: runner.Metadata) -> str:
    """The address this workspace publishes its ports ON, for the panel's
    remote-access notice. "" means genuinely unknown.

    Recorded in the metadata at create time. Read back out of the generated compose
    file for workspaces made before it was recorded, so a workspace that already
    exists gets the accurate notice rather than the hedged one -- the fact was always
    on disk, just not where a reader could ask for it.
    """
    extra = m.extra if isinstance(m.extra, dict) else {}
    recorded = str(extra.get("bind_host") or "")
    if recorded:
        return recorded
    if topology.of_meta(m) == topology.KUBERNETES:
        # Kubernetes has recorded it from the first workspace it ever made, so an
        # absence here is not "older than the key" -- there is nothing to recover.
        return ""
    try:
        doc = runner.read_compose(m.name)
    except Exception:  # noqa: BLE001 - no file, or half-written; unknown is fine
        return ""
    svcs = doc.get("services", {}) if isinstance(doc, dict) else {}
    rc = svcs.get("rocketchat") or svcs.get("rocketchat-1") or {}
    for port in rc.get("ports") or []:
        parts = str(port).split(":")
        if len(parts) >= 3 and parts[0]:
            return parts[0]
    return ""


def _env_rows(doc: dict, overrides: dict | None = None) -> list[dict]:
    """The RC service's env as [{key, value, override}], credentials masked.

    `override` marks the keys the user set with `env --set`, so the panel can tell
    those apart from the preset/base defaults -- "remove" means a different thing
    for each.
    """
    own = set(overrides or {})
    svcs = doc.get("services", {})
    rc_svc = svcs.get("rocketchat") or svcs.get("rocketchat-1") or {}
    env = rc_svc.get("environment", {})
    if isinstance(env, dict):
        pairs = sorted(env.items())
    elif isinstance(env, list):  # compose list form "K=V"
        pairs = [(k, v) for k, v in ((e.split("=", 1) + [""])[:2] for e in env)]
    else:
        return []
    return [{"key": k, "value": redact_env(k, str(v)), "override": k in own}
            for k, v in pairs]


def _kubernetes_detail(d: dict, m, target: str, _x: dict) -> dict:
    """The panel for a workspace that has pods rather than containers."""
    from houston.services import k8s
    context = str(_x.get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    # BOTH AT ONCE. These are two independent reads of the same namespace, and on
    # a managed cluster each is a round trip -- run in sequence they are most of
    # what the detail panel spends, and the panel is what somebody stares at while
    # deciding whether a workspace is healthy.
    #
    # The dependency below is only ever used to SKIP work, never to change what is
    # asked, so starting both and discarding one is safe. The trade is explicit: a
    # workspace that turns out to be down costs one extra list of an empty
    # namespace -- a read, concurrent, so it adds no wall-clock -- and every
    # running workspace, which is the case anyone actually watches, halves.
    with ThreadPoolExecutor(max_workers=2) as _pool:
        _f_state = _pool.submit(inspect.kubernetes_state, target, m)
        _f_pods = _pool.submit(k8s.pod_rows, target, context=context)
        d["state"] = _f_state.result()
        # Pods, in the containers tab's own three columns. This block used to be
        # deliberately empty on the reasoning that invented rows would be a
        # plausible wrong answer -- true, but these are not invented, and the empty
        # list was itself a wrong answer: the tab reads it as "no containers" and
        # printed "this repro is down" under a running workspace, with no way at
        # all to see an ImagePullBackOff from the browser.
        d["containers"] = [] if d["state"] == "down" else _f_pods.result()
    # Uptime from the earliest RUNNING pod, which is as close as this runtime
    # gets to the workspace's own uptime. Left empty when nothing is running,
    # because "—" is the honest cell for a stopped workspace.
    started = sorted(r["started"] for r in d["containers"]
                     if r["state"] == "running" and r["started"])
    d["uptime"] = _since(started[0]) if started else ""
    # Health stays empty on purpose: the kv falls back to the state, which here
    # already distinguishes starting/running/stopped. A per-pod answer is in the
    # containers tab, where it belongs.
    d["health"] = ""
    # ROCKET.CHAT'S OWN restart count, which this branch never set -- so the panel's
    # restart cell and the triage rule that reads it were both dead on Kubernetes,
    # on a runtime where a crash-looping workspace is the common failure. Its own
    # pod, by the label `pod_rows` marks, because nine pods here have a count each
    # and "RC restarts: 3" must not be a sidecar's.
    d["restarts"] = max((int(r.get("restarts") or 0)
                         for r in d["containers"] if r.get("app")), default=0)
    # LINKS ARE NOT COMPOSE-SHAPED, and leaving them out of this branch cost the
    # panel every address a scenario publishes. A preset's UI answers on the SAME
    # host port under both runtimes -- Compose binds it, Kubernetes port-forwards
    # it to the same number deliberately (k8s.scenario_ui_forwards) -- so one
    # list is right for both. Without it, phpLDAPadmin, Keycloak, MinIO, Mailpit
    # and Grafana were unreachable from the GUI on Kubernetes while the CLI
    # printed all of them.
    d["links"] = inspect.repro_links(m)
    # Named rather than reconstructed. Every message that mentions it builds it
    # from `namespace_for`, and a browser rebuilding the same string from the
    # workspace name is a second implementation of a naming rule.
    d["namespace"] = str(_x.get("namespace") or "")
    return d


def _compose_detail(d: dict, m, target: str) -> dict:
    """The panel for a workspace that has containers."""

    # `container_details` returns [] both for "no containers" AND for "docker could
    # not be asked", so deriving state from it alone asserted `down` whenever the
    # daemon was unreachable — while list_repros() reported "?" for the same repro.
    # The two views must agree, and neither may claim to know what it cannot.
    if not runner.docker_available():
        d["state"], d["uptime"], d["health"] = "?", "", ""
        d["containers"] = []
        d["links"] = inspect.repro_links(m)
        d["env"] = _env_rows(runner.read_compose(target), m.extra.get("env")
                             if isinstance(m.extra, dict) else None)
        return d
    containers = runner.container_details(target)
    rc = [c for c in containers if c["service"] == "rocketchat" or c["service"].startswith("rocketchat-")]
    rc_status = next((c["status"] for c in rc), "")
    d["state"] = inspect.repro_state(rc_status, bool(containers))
    up, health = inspect._uptime_health(rc_status)
    d["uptime"] = up
    # The SAME rule the list uses, so the summary can no longer contradict the
    # containers array printed directly beneath it.
    d["degraded"] = (inspect.degraded_reason({c["service"]: c["status"] for c in containers})
                     if d["state"] == "running" else "")
    d["health"] = ("degraded" if d["degraded"]
                   else health or (d["state"] if d["state"] != "down" else ""))
    # A climbing restart count is the difference between "slow to boot" and
    # "crash-looping"; wait_serving already warns on it during a create, but after
    # that nothing surfaced it. Only asked when containers exist -- it costs two
    # docker calls, and a `down` repro has nothing to inspect.
    if containers:
        d["restarts"] = runner.rc_restart_count(target)
    d["links"] = inspect.repro_links(m)
    d["containers"] = containers
    d["env"] = _env_rows(runner.read_compose(target), m.extra.get("env")
                         if isinstance(m.extra, dict) else None)
    return d


def detail(name: str) -> dict:
    """Rich detail for the GUI panel: summary + state/uptime/health + links +
    containers + the RC service's env vars."""
    target = naming.resolve_name(name)
    m = runner.read_meta(target)
    d = inspect._summary(m)
    # The env tab masks credentials and tells the reader that the workspace's
    # docker-compose.yml is the source of truth for a real value (see redact_env)
    # -- but nothing in the GUI said where that workspace is.
    d["workspace"] = str(runner.workspace(target))
    # The list payload has carried `default` all along; the panel needs it too, so
    # it can offer "Make default" only where that would change something.
    d["is_default"] = target == config.load_config().get("default_repro")
    _x = m.extra if isinstance(m.extra, dict) else {}
    d["created_by"] = _x.get("owner") or _x.get("created_by", "")
    d["owner"] = d["created_by"]
    d["made_by"] = _x.get("created_by", "")
    d["owner_history"] = list(_x.get("owner_history") or [])
    # Which address this workspace's ports are bound to. The panel needs it to say
    # anything true about reaching the workspace from ANOTHER machine: every link
    # below is built from `localhost`, which for a browser on a different box than
    # `serve` names that browser's own machine. Reported, never acted on -- ROOT_URL
    # is what Rocket.Chat itself advertises and is deliberately left alone.
    d["bind_host"] = _bind_host_of(m)
    # The panel keys its HTTPS row and its "Check TLS" action off these. list_repros()
    # carried them and detail() did not, so the feature was invisible in the panel.
    d["public_url"] = m.public_url
    d["tls"] = m.extra.get("tls", "") if isinstance(m.extra, dict) else ""
    # ASKED FIRST, before docker is asked anything. A Kubernetes workspace's state
    # does not depend on the local daemon, and the branch below reads the workspace's
    # compose file -- which this runtime does not have, so a box whose docker was
    # merely asleep answered the panel with a FileNotFoundError, i.e. 500, for a
    # workspace that was running perfectly well in the cluster.
    if topology.of_meta(m) == topology.KUBERNETES:
        return _kubernetes_detail(d, m, target, _x)
    return _compose_detail(d, m, target)
