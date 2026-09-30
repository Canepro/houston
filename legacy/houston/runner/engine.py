"""engine -- see the package docstring."""
from __future__ import annotations

from houston import exec as subprocess
from pathlib import Path
from types import SimpleNamespace

from houston.runner import cache
from houston.runner import paths

# --- docker compose -----------------------------------------------------------


def _compose(name: str, *args: str, capture: bool = False,
             timeout: float | None = None) -> subprocess.CompletedProcess:
    """Run `docker compose <args>` in a repro workspace.

    `timeout` is opt-in and left unset by default: `up`/`pull`/`logs -f` are
    legitimately long-running. Bounded callers (samplers, one-shot queries) pass
    one so a wedged daemon can't block a worker thread forever.

    Uncaptured, compose INHERITS the terminal, which is the point: docker draws its own
    pull progress and says in its own words why an `up` failed. Except its stdout under
    --json, where stdout belongs to a machine -- `jsonout` promises it carries JSON and
    nothing else, and compose's stdout landed raw among the NDJSON lines of `up --json`
    and ahead of the envelope of `down --json` (P21, g1-03, g2-03). So while JSON mode is
    active docker's stdout goes to fd 2, where the person running the command still sees
    it, and its stderr stays where it was.
    """
    from houston import jsonout
    cmd = ["docker", "compose", *args]
    stdout = {"stdout": 2} if not capture and jsonout.active() else {}
    return docker.run(cmd, cwd=paths.workspace(name), text=True,
                      capture_output=capture, timeout=timeout, **stdout)

def compose_stream(name: str, *args: str, on_line=None) -> int:
    """Run `docker compose <args>` streaming combined stdout+stderr line-by-line
    to `on_line` (for live progress in the web UI). Returns the exit code.

    Uses Popen (not subprocess.run) so callers get output as it happens; the CLI
    keeps the blocking `_compose` path, which inherits the terminal for docker's
    own progress rendering."""
    cmd = ["docker", "compose", *args]
    proc = docker.popen(
        cmd, cwd=paths.workspace(name), text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1,
    )
    try:
        for line in proc.stdout or []:
            line = line.rstrip("\n")
            if on_line and line:
                on_line(line)
    finally:
        if proc.stdout:
            proc.stdout.close()
    return proc.wait()

def up(name: str, *, pull: bool = True, force_recreate: str = "") -> int:
    """`docker compose up -d`. `force_recreate` names ONE service to rebuild anyway.

    Compose decides what to recreate by comparing a config hash it stores on the
    container. MEASURED that this is not always enough: an `env` apply interrupted
    mid-recreate left the compose file carrying a variable the container did not
    have, and a later `up` reported "Booted in 0s" without recreating -- so the
    workspace kept running configuration its own recorded state disagreed with, and
    no houston command reconverged it.

    Scoped to one service on purpose. Recreating everything would take Mongo down
    with it on every apply, and the whole reason this is safe is that it does not.
    """
    if pull:
        # A failed pull is deliberately non-fatal: cached images may satisfy
        # `up -d` anyway (e.g. registry hiccup), and `up` itself fails loudly
        # if an image is truly missing.
        docker.compose(name, "pull")
    # --remove-orphans: if the compose file changed shape (e.g. a different
    # preset after --force), containers of dropped services are cleaned up.
    args = ["up", "-d", "--remove-orphans"]
    if force_recreate:
        # `--no-deps` so rebuilding Rocket.Chat does not take its database with it.
        args += ["--force-recreate", "--no-deps", force_recreate]
    return _mutating(name, *args)

def down(name: str, *, volumes: bool = False) -> int:
    args = ["down", "--remove-orphans"]
    if volumes:
        args.append("-v")
    return _mutating(name, *args)

def start(name: str) -> int:
    return _mutating(name, "start")

def stop(name: str) -> int:
    return _mutating(name, "stop")

def restart(name: str) -> int:
    return _mutating(name, "restart")

def _mutating(name: str, *args: str) -> int:
    """A compose command that CHANGES container state.

    Drops the memoised query results afterwards: a dashboard that still showed
    "running" for two seconds after a Stop would be a cache the user can notice,
    which is worse than the process spawns the memo saves.
    """
    try:
        return docker.compose(name, *args).returncode
    finally:
        cache.invalidate_docker_queries()

def logs(name: str, *, follow: bool = False, tail: int | None = None) -> int:
    args = ["logs"]
    if follow:
        args.append("-f")
    if tail is not None:
        args += ["--tail", str(tail)]
    return docker.compose(name, *args).returncode

def compose_exec(name: str, service: str, args: list[str]) -> int:
    """Run a command inside a running compose service (docker compose exec -T)."""
    return docker.compose(name, "exec", "-T", service, *args).returncode

def compose_exec_capture(name: str, service: str, args: list[str],
                         timeout: float | None = None) -> tuple[int, str]:
    """Like compose_exec, but captures stdout: (returncode, stdout).

    Returns (1, "") instead of raising when the exec can't run or `timeout`
    expires, so best-effort samplers degrade to "no sample" rather than
    stranding their thread."""
    try:
        r = docker.compose(name, "exec", "-T", service, *args, capture=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return r.returncode, r.stdout or ""

def compose_exec_to_file(name: str, service: str, args: list[str], dest: "Path",
                         timeout: float | None = None) -> tuple[int, str]:
    """Run a command in a service, writing its RAW stdout to `dest`.

    Binary-safe on purpose: `mongodump --archive` emits BSON, and the text-mode
    decode/newline translation that compose_exec_capture applies would corrupt it
    silently -- the dump would restore with errors nobody could trace back here.
    Returns (returncode, stderr-as-text).
    """
    with open(dest, "wb") as fh:
        try:
            proc = docker.run(
                ["docker", "compose", "exec", "-T", service, *args],
                cwd=paths.workspace(name), stdout=fh, stderr=subprocess.PIPE,
                timeout=timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            return 1, str(exc)
    return proc.returncode, (proc.stderr or b"").decode("utf-8", "replace")

def compose_exec_from_file(name: str, service: str, args: list[str], src: "Path",
                           timeout: float | None = None) -> tuple[int, str]:
    """Run a command in a service with `src` piped to its stdin.

    The counterpart of compose_exec_to_file, for `mongorestore --archive`. Output
    is merged so a caller has one blob to show when a restore fails.
    """
    with open(src, "rb") as fh:
        try:
            proc = docker.run(
                ["docker", "compose", "exec", "-T", service, *args],
                cwd=paths.workspace(name), stdin=fh, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, timeout=timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            return 1, str(exc)
    return proc.returncode, (proc.stdout or b"").decode("utf-8", "replace")

def stop_services(name: str, services: list[str]) -> int:
    """Stop specific services, leaving the rest of the project running.

    `stop()` stops everything including Mongo -- useless for a dump, which needs
    Mongo up and only the writers quiesced.
    """
    return docker.compose(name, "stop", *services).returncode

def start_services(name: str, services: list[str]) -> int:
    return docker.compose(name, "start", *services).returncode

def rm_services(name: str, services: list[str]) -> int:
    """Stop and remove specific services (docker compose rm -s -f <services>)."""
    return docker.compose(name, "rm", "-s", "-f", *services).returncode

def service_container_ids(name: str, service: str) -> list[str]:
    """Container id(s) of one compose service in this repro (usually a single id)."""
    r = docker.compose(name, "ps", "-q", service, capture=True)
    if r.returncode != 0:
        return []
    return [line.strip() for line in r.stdout.splitlines() if line.strip()]

def container_ids(name: str) -> list[str]:
    """Container ids of a repro's running services (docker compose ps -q)."""
    proc = docker.compose(name, "ps", "-q", capture=True)
    return [line for line in (proc.stdout or "").split() if line]

def ps(name: str) -> str:
    """Return `docker compose ps` for a repro (service/state/status lines)."""
    proc = docker.compose(
        name, "ps", "--format", "{{.Service}}\t{{.State}}\t{{.Status}}", capture=True
    )
    return proc.stdout or ""

def _first_line(cmd: list[str]) -> str | None:
    """Run a command and return its trimmed stdout, or None on failure."""
    try:
        proc = docker.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None

def compose_logs_capture(name: str, *, tail: int = 200) -> str:
    """Captured (not streamed) combined logs for a repro - for post-mortem
    diagnosis of a failed `up`. '' on error."""
    r = docker.compose(name, "logs", "--no-color", "--tail", str(tail), capture=True)
    return (r.stdout or "") + (r.stderr or "")

def compose_pull_capture(name: str) -> str:
    """Captured output of `docker compose pull` (stdout+stderr) - used to surface
    registry errors when a repro never started any container. '' on error."""
    r = docker.compose(name, "pull", capture=True)
    return (r.stdout or "") + (r.stderr or "")

# The lambdas intentionally resolve the lower exec seam at call time, so its
# safety guard remains authoritative even when this object is imported first.
docker = SimpleNamespace(
    run=lambda *args, **kwargs: subprocess.run(*args, **kwargs),
    popen=lambda *args, **kwargs: subprocess.popen(*args, **kwargs), compose=_compose)
