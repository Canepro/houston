"""host -- see the package docstring."""
from __future__ import annotations

import json
import os
from houston import exec as subprocess
import threading
import time
from pathlib import Path

from houston.runner import engine
from houston.runner.engine import docker

def host_memory() -> tuple[int, int, int] | None:
    """(total_mb, available_mb, swap_total_mb) for the machine, or None.

    MemAvailable, not MemFree: free memory excludes the page cache, which the
    kernel reclaims on demand, so `free` looks alarming on a healthy box and
    reassuring on a doomed one. MemAvailable is the kernel's own estimate of what
    a new workload can actually get, which is exactly the question here.

    Linux only. Everywhere else this returns None and the caller skips the check
    rather than guessing -- a wrong refusal is worse than no refusal.
    """
    try:
        fields = {}
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                fields[key] = int(rest.strip().split()[0])   # kB
    except (OSError, ValueError, IndexError):
        return None
    if "MemTotal" not in fields or "MemAvailable" not in fields:
        return None
    return (fields["MemTotal"] // 1024, fields["MemAvailable"] // 1024,
            fields.get("SwapTotal", 0) // 1024)

def docker_capacity() -> tuple[float, int] | None:
    """(cpus, memory_bytes) available to the docker engine/VM, or None.

    Never raises: callers use this during best-effort restore paths, where an
    OSError (docker gone, fork failure) must not escape."""
    try:
        r = docker.run(["docker", "info", "--format", "{{.NCPU}} {{.MemTotal}}"],
                           capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    try:
        ncpu, mem = r.stdout.split()
        return float(ncpu), int(mem)
    except ValueError:
        return None

#: `docker info` forks a client that talks to the daemon: ~35 ms, and /api/health
#: calls it on every poll. One open dashboard is 4 per 4 s; a ten-person team with
#: a few tabs each turns the health check -- the cheap, unauthenticated one -- into
#: the most expensive thing the server does. Short enough that `doctor` and the
#: badge still react to Docker stopping within a poll or two.
_DOCKER_TTL = 3.0

_docker_seen: tuple[float, bool] | None = None

_docker_lock = threading.Lock()

def docker_available(*, max_age: float = _DOCKER_TTL) -> bool:
    """Whether the daemon answers. Cached briefly; `max_age=0` forces a probe."""
    global _docker_seen
    now = time.monotonic()
    if max_age > 0:
        seen = _docker_seen
        if seen is not None and now - seen[0] < max_age:
            return seen[1]
    try:
        proc = docker.run(
            ["docker", "info"], capture_output=True, text=True, timeout=10
        )
        ok = proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    with _docker_lock:
        _docker_seen = (now, ok)
    return ok

def docker_server_version() -> str | None:
    return engine._first_line(["docker", "version", "--format", "{{.Server.Version}}"])

def compose_version() -> str | None:
    return engine._first_line(["docker", "compose", "version", "--short"])

def compose_standalone_version() -> str | None:
    """The version of a STANDALONE `docker-compose` binary, or None.

    Asked only when `docker compose` has already failed, and it changes the answer
    completely. Compose v2 ships as a docker CLI PLUGIN, and the same binary also works
    when invoked directly -- so a box can have `docker-compose` on PATH printing a
    perfectly good v2 help text while `docker compose` does not exist, because the
    binary was never put where the docker CLI looks for plugins. Reported from an EC2
    instance where `docker-compose` worked and every houston command did not.

    houston deliberately does NOT fall back to it: `docker compose -p` and the plugin's
    own project handling are what every path here is written against, and quietly using a
    second entry point would mean two code paths for one operation. Telling someone to
    register the binary they already have is a smaller ask than a fallback nobody tests.
    """
    return engine._first_line(["docker-compose", "version", "--short"])

def docker_kernel_version() -> str | None:
    """Kernel of the engine host/VM (e.g. Podman machine), or None. This is the
    kernel MongoDB actually runs on - not the macOS/Windows host kernel."""
    return engine._first_line(["docker", "info", "--format", "{{.KernelVersion}}"])

def hub_logged_in() -> bool | None:
    """Best-effort: is the client authenticated to Docker Hub? True/False, or None
    when no auth file is readable (can't tell). Checks Docker and Podman auth
    files, honouring REGISTRY_AUTH_FILE / DOCKER_CONFIG."""
    candidates: list[Path] = []
    for env in ("REGISTRY_AUTH_FILE", "DOCKER_CONFIG"):
        val = os.environ.get(env)
        if val:
            p = Path(val)
            candidates.append(p if p.suffix == ".json" else p / "config.json")
    candidates += [Path.home() / ".docker" / "config.json",
                   Path.home() / ".config" / "containers" / "auth.json"]
    hub_keys = ("https://index.docker.io/v1/", "index.docker.io",
                "registry-1.docker.io", "docker.io")
    seen = False
    for path in candidates:
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        seen = True
        auths = data.get("auths") or {}
        if any(k in auths for k in hub_keys):
            return True
    return False if seen else None
