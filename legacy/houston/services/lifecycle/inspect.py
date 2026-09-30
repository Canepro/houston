"""What a workspace IS right now: its state, its health, its links, and the list.

Tier 3. Reads the on-disk record and the engine; never changes either. `detail` lives
next door in `payload` because it is the payload-shape trap -- the browser suite renders
from a fixture of it, so a key that drifts from what this layer really returns breaks the
panel in production with the whole suite green.

Named `inspect` after the command group it serves. It shadows the standard library's
`inspect` only for an importer that asks for it by a bare name from inside this package,
which nothing here does -- every import in this package is absolute.
"""
from __future__ import annotations

import re

from houston import config, runner
from houston.services import topology
from houston.services.lifecycle import naming, notes
from houston.services.lifecycle.types import ESSENTIAL_SERVICES, _PRESET_LINKS

def repro_state(rc_status: str, has_containers: bool) -> str:
    """The state to report for a repro, from its Rocket.Chat container's docker
    `Status` string ("Up 2 hours (healthy)", "Restarting (1) 5 seconds ago", ...).

    BOTH the list and the detail panel must derive state from this, because they
    used to disagree. The list read compose's PROJECT-level aggregate, where the
    always-running Mongo put "running(" in the string and made a crash-looping RC
    report "running"; the panel checked only whether RC was literally "running"
    and flattened everything else to "stopped". So one repro showed two different
    states at the same moment, and neither of them said "restarting" -- during a
    crash loop, which is exactly when the answer matters.

    `has_containers` separates "the stack is gone" (down) from "containers exist
    but Rocket.Chat has none" (stopped).
    """
    s = (rc_status or "").strip()
    if not s:
        return "stopped" if has_containers else "down"
    low = s.lower()
    if low.startswith("up"):
        # docker reports a paused container as "Up 3 days (Paused)".
        return "paused" if "(paused)" in low else "running"
    if low.startswith("exited"):
        return "stopped"
    # "Restarting (1) 5 seconds ago" -> restarting; "Created"/"Dead" -> as-is.
    return low.split(" (")[0].split(" ")[0] or "down"


def kubernetes_state(name: str, meta) -> str:
    """`running` / `down` for a Kubernetes workspace.

    `repro_state()` asks docker whether the project's containers exist, so it called
    a live Kubernetes workspace `down` -- the state column was reporting on the
    wrong runtime entirely.
    """
    from houston.services import k8s
    context = str((getattr(meta, "extra", None) or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    # "?" ON A REFUSED READ, which is the word the Docker branch one function up
    # already uses when the daemon is unreachable -- and which the browser already
    # renders (app.js `stateClass`, and the guard that stops it claiming "0 running").
    # Without it a healthy workspace read as `down` whenever the cluster could not be
    # asked: measured at 8.3s, one PROBE_TIMEOUT, with `docker pause` on the control
    # plane, while the workspace was serving throughout. `down` is the word that
    # invites `up --force` and `down --volumes`, so it is the worst available guess.
    held = k8s.workspace_namespaces(context)
    if held is None:
        return "?"
    if k8s.namespace_for(name) not in held:
        return "down"
    # The namespace EXISTING is not the workspace running. A plain `down` keeps the
    # namespace and its PVC on purpose and uninstalls the release, so a torn-down
    # workspace reported "starting" -- and would have reported it forever, because
    # nothing was coming. Ask for the workload instead.
    if not k8s.workload_exists(name, context=context):
        return "down"
    # Scaled to zero is STOPPED, not starting. `stop` is implemented as scale-to-zero
    # -- there is no other "stopped" on this runtime -- and without this the column
    # said "starting" for a workspace that had been deliberately stopped and was
    # never going to move. The word has to match the verb the user just used.
    if k8s.desired_replicas(name, context=context) == 0:
        return "stopped"
    if k8s.workspace_ready(name, context=context):
        return "running"
    # NOT-READY IS NOT ALWAYS STARTING. Everything that was not ready read as
    # "starting", which is a promise: it says something is coming. For a wedged
    # `pending-install` release or a pod in ImagePullBackOff / CreateContainerConfigError
    # nothing is coming, and the column said "starting" for as long as anyone looked.
    # Both facts were already available -- `terminal_pod_failure` returned the pod,
    # the reason and the message while `list` printed "starting" beside it -- and
    # nothing consulted them. Verified live: a deployment on an unpullable image
    # reported `starting` while `terminal_pod_failure` named ImagePullBackOff.
    #
    # `failed` rather than a reason, because this is a state COLUMN: `info` and the
    # detail panel carry the why. Any probe here may itself be refused, and a refused
    # read must not manufacture a failure, so each is guarded and falls back to the
    # honest "starting".
    try:
        if k8s.terminal_pod_failure(name, context=context):
            return "failed"
    except Exception:  # noqa: BLE001 - a refused probe is not evidence of failure
        pass
    try:
        state, _ = k8s.release_state(k8s.RELEASE, k8s.namespace_for(name), context)
        if state in k8s.PENDING_STATES or state == "failed":
            return "failed"
    except Exception:  # noqa: BLE001 - same
        pass
    return "starting"


def degraded_reason(services: dict) -> str:
    """Why a workspace that LOOKS running is not usable, or "".

    `services` is {service: docker Status string}. Reported as a distinct health
    rather than as a state, because the workspace genuinely is running -- what is
    wrong is that something it needs is not.
    """
    for svc in ESSENTIAL_SERVICES:
        status = (services or {}).get(svc)
        if status is not None and not status.startswith("Up "):
            first = status.split(" (")[0].strip().lower() or "not running"
            return f"{svc} is {first}"
    return ""


def _uptime_health(status: str) -> tuple[str, str]:
    """Parse a docker `Status` string -> (uptime, health).
    "Up 2 hours (healthy)" -> ("2 hours", "healthy"); "Exited (0) ..." -> ("", "")."""
    if not status:
        return "", ""
    mm = re.search(r"\(([^)]+)\)", status)
    health = mm.group(1) if (mm and status.startswith("Up ")) else ""
    # Docker spells the transitional one "health: starting" inside the Status
    # string, and a bare "healthy"/"unhealthy" for the settled ones. Taken verbatim
    # the panel rendered "Health: health: starting". The prefix is noise from the
    # string format, not part of the value.
    if health.startswith("health: "):
        health = health[len("health: "):]
    up = status[3:].split(" (")[0].strip() if status.startswith("Up ") else ""
    return up, health


def _forward_gap(meta: runner.Metadata) -> str:
    """Why a running Kubernetes workspace's URL will not answer, or "".

    Only where a pid was actually recorded: `forward_alive(None)` is False, and
    reading that as "nothing is running" is the confusion this release spent itself
    removing. A `/proc` read per row is cheap enough for `list`.
    """
    from houston.services import k8s

    extra = meta.extra if isinstance(meta.extra, dict) else {}
    pid = extra.get("port_forward_pid")
    if not pid:
        return ""
    ns = str(extra.get("namespace") or k8s.namespace_for(meta.name))
    if k8s.forward_alive(pid, namespace=ns, host_port=meta.host_port):
        return ""
    return ("no port-forward, so the URL will not answer — "
            f"`houston ready --name {meta.name}` re-establishes it")


def repro_links(m: runner.Metadata) -> list[dict]:
    """Clickable URLs for a repro: RC, extra instances, preset sidecars (S3,
    Keycloak, Mailpit, widget), and monitoring — [{label, url, kind}]."""
    links = [{"label": "Rocket.Chat", "url": m.external_url, "kind": "rc"}]
    extra = m.extra if isinstance(m.extra, dict) else {}
    if m.public_url:
        # Keep the plain http way in as well: with the local CA the browser warns
        # until `trust-ca` has run, and this is the link that always just works.
        links.append({"label": "direct HTTP", "url": m.root_url, "kind": "rc"})
    n = extra.get("instances")
    if isinstance(n, int) and n > 1:
        for i in range(1, n + 1):
            links.append({"label": f"instance {i}", "url": f"http://localhost:{m.host_port + i}", "kind": "rc"})
    ports = config.PRESET_PORTS.get(m.preset, ())
    for label, idx in _PRESET_LINKS.get(m.preset, []):
        if idx < len(ports):
            links.append({"label": label, "url": f"http://localhost:{ports[idx]}", "kind": "sidecar"})
    if extra.get("monitoring"):
        links.append({"label": "Grafana", "url": f"http://localhost:{config.MONITOR_PORTS[1]}", "kind": "monitor"})
        links.append({"label": "Prometheus", "url": f"http://localhost:{config.MONITOR_PORTS[0]}", "kind": "monitor"})
    return links


def _summary(meta: runner.Metadata) -> dict:
    # DERIVED here, not read out of the record. Every workspace created before the
    # groups existed -- and every workspace created before the next wording fix --
    # gets the current shape and the current words, because this is a read. The
    # record's own copy is a record; nothing renders from it.
    #
    # The recorded flat list is the fallback, and it is only reached by a workspace
    # that has notes no group accounts for (a preset that has since been deleted,
    # a note some older release appended by hand). Losing those would be worse than
    # rendering them ungrouped, which the panel and the terminal both still do.
    groups = notes.note_groups_of(meta)
    recorded = list(meta.extra.get("notes", []) if isinstance(meta.extra, dict) else [])
    d = {
        "notes": notes.flatten_notes(groups) if groups else recorded,
        "note_groups": groups,
        "name": meta.name, "rc_version": meta.rc_version, "mongo_tag": meta.mongo_tag,
        "mongo_flavor": meta.mongo_flavor, "preset": meta.preset, "root_url": meta.root_url,
        "host_port": meta.host_port, "login": {"user": config.ADMIN_USERNAME, "password": meta.admin_pass},
        "pinned": meta.pinned,
        # Which runtime, and how Rocket.Chat is arranged inside it. `list_repros`
        # has carried the runtime all along and the DETAIL payload had neither, so
        # the panel rendered every workspace as though it were Compose -- and
        # offered actions the Kubernetes path can only refuse.
        "runtime": topology.of_meta(meta),
        "deployment": topology.axes_of_meta(meta).get("deployment", ""),
    }
    # Whether this workspace HAS sample data, and whether the readback agreed. The
    # panel needs it to know whether "add sample data" is the obvious next thing or a
    # repeat: seeding only ever adds, so offering it first on a workspace that is
    # already full is a wrong guess, and a wrong guess about what to do next is worse
    # than not guessing. Always present, never conditional -- a key that appears only
    # sometimes is how the panel's payload drifts from what the tests render.
    _seed = (meta.extra.get("seed") if isinstance(meta.extra, dict) else None) or {}
    d["seed"] = {"profile": _seed.get("profile", ""), "at": _seed.get("at", ""),
                 "ok": bool((_seed.get("verification") or {}).get("ok"))} if _seed else None
    n = meta.extra.get("instances") if isinstance(meta.extra, dict) else None
    if n:
        d["instances"] = int(n)
        d["instance_urls"] = [f"http://localhost:{meta.host_port + i}" for i in range(1, int(n) + 1)]
    if isinstance(meta.extra, dict) and meta.extra.get("monitoring"):
        d["monitoring"] = True
        d["grafana_url"] = f"http://localhost:{config.MONITOR_PORTS[1]}"
    return d


def describe(name: str) -> dict:
    return _summary(runner.read_meta(naming.resolve_name(name)))


def _row_for(m, *, default: str, docker_up: bool, states: dict,
             status_map: dict, svc_map: dict) -> dict:
    """One workspace as `list` and the GUI table see it.

    Its own function because the two runtimes answer "what state is this in" from
    different places, and the branch that decides is three lines inside fifty.
    """
    rc_status = status_map.get(m.project, "")
    # `states` is only consulted for "does this project have ANY container",
    # never for the state itself -- see repro_state().
    # A Kubernetes workspace has no compose project, so asking docker whether
    # its containers exist answered `down` for a workspace that was running --
    # the state column was reporting on the wrong runtime entirely.
    if topology.of_meta(m) == topology.KUBERNETES:
        state = kubernetes_state(m.name, m)
    else:
        state = "?" if not docker_up else repro_state(
            rc_status, bool(states.get(m.project)))
    uptime, health = _uptime_health(rc_status)
    if topology.of_meta(m) == topology.KUBERNETES:
        # `list` printed `running` beside a URL that refused connections, and only
        # `info` said otherwise. A port-forward dies with its pod, so this is the
        # NORMAL state after any restart -- and `running` is not wrong about the
        # pods, which is exactly why the reader has nothing to go on. Carried in
        # `degraded`, the field both front-ends already render for the Compose
        # side, so no consumer has to learn a new key.
        degraded_why = _forward_gap(m) if state == "running" else ""
    else:
        degraded_why = (degraded_reason(svc_map.get(m.project, {}))
                        if state == "running" else "")
    degraded = "degraded" if degraded_why else ""
    runtime = topology.of_meta(m)
    monitored = bool(isinstance(m.extra, dict) and m.extra.get("monitoring"))
    extra_ = m.extra if isinstance(m.extra, dict) else {}
    owner = extra_.get("owner") or extra_.get("created_by", "")
    return {"name": m.name, "created_by": owner,
                "owner": owner, "made_by": extra_.get("created_by", ""),
                "rc_version": m.rc_version, "mongo_tag": m.mongo_tag,
                "host_port": m.host_port, "root_url": m.root_url, "state": state,
                # Which runtime, so a row can say so. A Compose and a Kubernetes
                # workspace differ in what every other command will do to them --
                # which commands refuse, where the data lives, how to reach it --
                # and the list was the one place both looked identical.
                "runtime": runtime,
                # The https URL when `up --https` was used; "" otherwise. The CLI
                # and GUI show this in preference to root_url, which stays http.
                "public_url": m.public_url, "tls": m.extra.get("tls", "") if isinstance(m.extra, dict) else "",
                "preset": m.preset, "pinned": m.pinned, "default": m.name == default,
                "monitoring": monitored, "created_at": m.created_at,
                "uptime": uptime,
                "health": (degraded or health
                           or (state if state == "running" else "")),
                "degraded": degraded_why,
                "grafana_url": f"http://localhost:{config.MONITOR_PORTS[1]}" if monitored else None,
            "links": repro_links(m)}


def list_repros() -> list[dict]:
    metas = runner.list_meta()
    default = config.load_config().get("default_repro")
    docker_up = runner.docker_available()
    states = (runner.project_states() or {}) if docker_up else {}
    # ONE docker ps for every service of every project, so the list and the panel
    # cannot disagree about whether a workspace is degraded -- which is exactly how
    # they came to disagree about `state` before repro_state() existed.
    #
    # Still through `rc_status_by_project()` for the Rocket.Chat line, even though
    # that now derives from the same cached call: it is the seam existing tests stub,
    # and a stub that silently goes inert is how a test keeps passing for a reason
    # other than the one in its name -- which happened twice on this branch already.
    svc_map = runner.services_by_project() if docker_up else {}
    status_map = runner.rc_status_by_project() if docker_up else {}
    out = []
    for m in metas:
        out.append(_row_for(m, default=default, docker_up=docker_up,
                            states=states, status_map=status_map,
                            svc_map=svc_map))
    return out
