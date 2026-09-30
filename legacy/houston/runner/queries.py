"""queries -- see the package docstring."""
from __future__ import annotations

import json
from houston import exec as subprocess

from houston.runner import cache
from houston.runner import engine
from houston.runner import record as runner_record
from houston.runner.engine import docker

def remove_volumes(name: str, volumes: list[str]) -> list[str]:
    """Delete named volumes belonging to a repro's compose project.

    `docker compose down -v` only removes volumes DECLARED in the compose file, so
    a volume whose declaration is dropped (detaching monitoring, switching preset
    with --force) becomes unreachable and survives forever. Containers must be
    gone first. Returns the volume names that could not be removed.
    """
    proj = runner_record.project_name(name)
    failed: list[str] = []
    for vol in volumes:
        full = f"{proj}_{vol}"
        try:
            r = docker.run(["docker", "volume", "rm", full],
                               capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            failed.append(full)
            continue
        # Already gone is success, not a failure.
        if r.returncode != 0 and "no such volume" not in (r.stderr or "").lower():
            failed.append(full)
    return failed

def docker_stats(container_ids: list[str]) -> str:
    """One `docker stats --no-stream` sample for the given containers, as
    tab-separated `name<TAB>cpu%<TAB>mem-usage` lines ('' on error/none).

    Timed out: this is polled on a sampler thread once a second, so a wedged
    daemon would otherwise block that thread (and its child) forever — the
    thread is a daemon and its `join` gives up, so it would leak silently."""
    if not container_ids:
        return ""
    try:
        proc = docker.run(
            ["docker", "stats", "--no-stream", "--format",
             "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}", *container_ids],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout if proc.returncode == 0 else ""

def rc_state(name: str) -> str:
    """Coarse state of the rocketchat service: running | exited | created | absent.

    One `docker compose ps` per call — fine for a single repro. For listing many
    repros use project_states() instead (a single docker call for all of them).
    """
    for line in engine.ps(name).splitlines():
        parts = line.split("\t")
        # "rocketchat" for a normal repro, "rocketchat-1"/"-2"/… for a
        # multi-instance one — the first instance found is enough for readiness.
        if parts and (parts[0] == "rocketchat" or parts[0].startswith("rocketchat-")):
            return parts[1] if len(parts) > 1 else "unknown"
    return "absent"

def _compose_ls() -> list[dict] | None:
    """Parsed `docker compose ls --all --format json`, or None if the query failed.

    Newer compose emits a JSON array; older versions emit NDJSON (one object per
    line). Both are handled so callers work across compose versions.

    Bounded: the GUI polls this every 4s on a threadpool worker. A daemon that
    answers `docker info` (so docker_available() says yes) but then wedges on
    `compose ls` would otherwise park a worker per poll until the server stops
    answering at all. Failing to None is already the "couldn't ask docker" path.
    """
    try:
        proc = docker.run(
            ["docker", "compose", "ls", "--all", "--format", "json"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    raw = (proc.stdout or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return [data] if isinstance(data, dict) else data
    except json.JSONDecodeError:
        out = []
        for line in raw.splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return out

def project_states() -> dict[str, str] | None:
    """Map compose project name -> status string for ALL projects, in one call.

    Status looks like "running(3)" / "exited(2)"; a fully `down`ed repro (no
    containers) is absent from the output. Returns None if the query itself
    failed — callers that DELETE based on absence (prune) must not confuse
    "no projects" with "couldn't ask docker".
    """
    def query():
        data = _compose_ls()
        if data is None:
            return None
        return {item.get("Name", ""): item.get("Status", "") for item in data}
    return cache._cached_query("project_states", query)

def project_config_files() -> dict[str, str] | None:
    """Map compose project name -> its ConfigFiles string (comma-joined paths).

    Used to detect a project-name COLLISION: two repro workspaces (e.g. a real
    one and a throwaway in a different HOUSTON_HOME) derive the same project
    name `houston-<name>`, and `docker compose up` would then reconcile the wrong
    workspace's containers. None if docker couldn't be queried.
    """
    data = _compose_ls()
    if data is None:
        return None
    return {item.get("Name", ""): (item.get("ConfigFiles") or "") for item in data}

def rc_container_env(name: str) -> dict | None:
    """The RC container's ACTUAL environment, or None if it could not be read.

    The compose document is what a workspace was ASKED to run; this is what it IS
    running, and they diverge. MEASURED: an `env` apply interrupted mid-recreate
    (a SIGPIPE from a truncating pipe is an ordinary way for that to happen, Ctrl-C
    is another) left `OVERWRITE_SETTING_Accounts_RegistrationForm=Disabled` in both
    the compose file and `repro.json`, and absent from the container -- and neither
    `start`, `restart` nor a re-run `up` put it back, because none of them re-reads
    the compose config.

    NONE, NOT `{}`. "The container is not running" and "the container has no
    environment" are different facts, and the caller reports drift by comparing two
    sets -- so an empty one from a failed read would report every recorded variable
    as missing.
    """
    ids = engine.service_container_ids(name, "rocketchat") or engine.service_container_ids(name, "rocketchat-1")
    if not ids:
        return None
    try:
        r = docker.run(
            ["docker", "inspect", "--format", "{{json .Config.Env}}", ids[0]],
            capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    try:
        rows = json.loads(r.stdout or "null")
    except ValueError:
        return None
    if not isinstance(rows, list):
        return None
    out = {}
    for row in rows:
        key, sep, value = str(row).partition("=")
        if sep:
            out[key] = value
    return out

def rc_restart_count(name: str) -> int:
    """How many times the repro's rocketchat container has restarted — a nonzero
    and climbing value signals a crash-loop (usually resource pressure). 0 if
    unknown."""
    ids = engine.service_container_ids(name, "rocketchat") or engine.service_container_ids(name, "rocketchat-1")
    if not ids:
        return 0
    # Bounded for the same reason as _compose_ls: the detail panel refreshes this
    # on a timer, and "unknown" (0) is already the documented fallback.
    try:
        r = docker.run(["docker", "inspect", "--format", "{{.RestartCount}}", ids[0]],
                           capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return 0
    try:
        return int((r.stdout or "0").strip())
    except ValueError:
        return 0

def rc_status_by_project() -> dict[str, str]:
    """Map compose project -> its rocketchat container `Status` string
    ("Up 2 hours (healthy)"), in ONE `docker ps` call (cheap enough for the whole
    dashboard). Used to show uptime/health per repro without an N-call fan-out."""
    return {proj: svcs.get("rocketchat") or svcs.get("rocketchat-1") or ""
            for proj, svcs in services_by_project().items()}

def services_by_project() -> dict[str, dict[str, str]]:
    """Map compose project -> {service: `Status` string} for EVERY container.

    The same single `docker ps` this always ran; it just stopped discarding the rest
    of the output. `rc_status_by_project` used to keep the rocketchat line and throw
    the others away, which is why a repro whose MONGODB had exited reported `running`
    and `healthy` -- both derived from the Rocket.Chat container alone, and Rocket.Chat
    serves /api/info perfectly well with no database behind it. The truth was one field
    away in a call already being made.
    """
    return cache._cached_query("services_by_project", _services_by_project_uncached)

def _services_by_project_uncached() -> dict[str, dict[str, str]]:
    try:
        proc = docker.run(
            ["docker", "ps", "--all", "--format",
             '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Status}}'],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return {}          # same 4s-poll bound as _compose_ls; {} = "couldn't ask"
    if proc.returncode != 0:
        return {}
    out: dict[str, dict[str, str]] = {}
    for line in (proc.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[0]:
            out.setdefault(parts[0], {})[parts[1]] = parts[2]
    return out

def container_details(name: str) -> list[dict]:
    """Per-container [{service, state, status, health}] for a repro (incl. stopped)."""
    r = docker.compose(name, "ps", "--all", "--format", "json", capture=True)
    if r.returncode != 0:
        return []
    raw = (r.stdout or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        data = [data] if isinstance(data, dict) else data
    except json.JSONDecodeError:
        data = []
        for line in raw.splitlines():
            line = line.strip()
            if line:
                try:
                    data.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return [{"service": it.get("Service", ""), "state": it.get("State", ""),
             "status": it.get("Status", ""), "health": it.get("Health", "")}
            for it in data]
