"""engine -- see the package docstring."""
from __future__ import annotations

from houston import exec as subprocess
from houston import runner

from houston.services.edge import paths
from houston.services.edge.paths import CONTAINER, PROJECT

def holders_of_443() -> list[str]:
    """Workspaces running their OWN Traefik on 443.

    They predate the edge, and they are why it cannot start: a machine has
    one port 443, and theirs already has it. Read from the record rather than from
    docker, so this answers the same whether they are running or merely `down`.
    """
    out = []
    for meta in runner.list_meta():
        extra = meta.extra if isinstance(meta.extra, dict) else {}
        if extra.get("edge"):
            continue
        if 443 in [int(p) for p in (extra.get("tls_ports") or []) if str(p).isdigit()]:
            out.append(meta.name)
    return out

# --- docker -------------------------------------------------------------------

def _docker(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess:
    """Run one docker command. NEVER RAISES; the caller reads returncode.

    Same contract as `k8s.run`, and it did not have it. A missing binary or a timeout
    came out as a raw `FileNotFoundError`/`TimeoutExpired` from a seam every caller
    treats as returning a result -- so on a box with no docker at all, `edge status`,
    `register` and `attach` produced a traceback instead of the handled error the rest
    of the tool gives. 127 is what a shell reports for "command not found", and the
    reason travels in stderr where `_why` already looks for it.
    """
    try:
        return subprocess.run(["docker", *args], text=True, capture_output=True,
                              timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(["docker", *args], returncode=127,
                                           stdout="", stderr=str(exc))

def bridge_address() -> str:
    """The Docker bridge gateway, or "" if it cannot be determined.

    What the GUI binds when a edge is in front of it: the edge reaches
    it here (via host.docker.internal, which resolves to this), and nothing off the
    box can -- verified reachable from a container and refused from 127.0.0.1. That
    is strictly better than 0.0.0.0, which would publish the control plane to the
    whole network just so one container could reach it.

    Read rather than hardcoded to 172.17.0.1: that is only the DEFAULT bridge
    subnet, and a box with a custom `bip` or an occupied 172.17/16 gets a different
    one.
    """
    out = _docker("network", "inspect", "bridge", "--format",
                  "{{(index .IPAM.Config 0).Gateway}}")
    return out.stdout.strip() if out.returncode == 0 else ""

def _compose(*args: str, timeout: float | None = None) -> subprocess.CompletedProcess:
    """`docker compose` in the edge's own project. NEVER RAISES; read the returncode.

    An explicit -p: the project must NOT be derived from the directory name, or it
    would depend on where <home> happens to be.

    THE SAME CONTRACT `_docker` ABOVE ALREADY HAD, and this did not -- one function
    apart, for the same reason, and it was the one that broke. `cwd` is `edge_dir()`,
    and a home that has never had an edge has no such directory, so `subprocess.run`
    raised FileNotFoundError out of a seam every caller treats as returning a result:
    `houston edge stop` on a fresh home answered with a Python traceback naming a
    path under HOUSTON_HOME. `_compose_capture` had the guard; this did not.

    127 is what a shell reports for "could not run it", and the reason travels in
    stderr where `_why` already looks for it.
    """
    argv = ["docker", "compose", "-p", PROJECT, *args]
    try:
        return subprocess.run(argv, cwd=paths.edge_dir(), text=True,
                              capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(argv, returncode=127, stdout="",
                                           stderr=str(exc))

def port_holder(port: int = 443) -> str:
    """What is holding `port`, named, or "" if nothing is.

    The edge failing to bind is the one startup error that is genuinely somebody
    else's fault, and "the edge did not start" is useless on its own -- hit twice
    while building this, once from a stale front door left by an older houston
    and once from an unrelated Traefik. Docker can name a container; anything else
    is at least identified as not-us.
    """
    out = _docker("ps", "--format", "{{.Names}}\t{{.Ports}}")
    if out.returncode == 0:
        mine = running()
        for line in out.stdout.splitlines():
            name, _, ports = line.partition("\t")
            if f":{port}->" not in ports:
                continue
            # Skipping by NAME alone hid the most confusing case of all: an edge
            # from a different HOUSTON_HOME has exactly our container name, so it
            # was excluded as "us" and reported as "something outside Docker".
            if name == CONTAINER and mine:
                continue
            if name == CONTAINER:
                return f"an edge from another HOUSTON_HOME ({name!r})"
            proj = _docker("inspect", name, "--format",
                           '{{index .Config.Labels "com.docker.compose.project"}}')
            label = proj.stdout.strip() if proj.returncode == 0 else ""
            # The project MATTERS, because it is what `docker compose -p ... down`
            # takes. Naming only the container sent somebody at our own project, which
            # is the one command that cannot free the port.
            if label and label != PROJECT:
                return f"the container {name!r} (compose project {label!r})"
            return f"the container {name!r}"
    from houston import runner as runner_mod

    return "" if runner_mod.port_free(port) else "something outside Docker"

def foreign_edge() -> str:
    """The working directory of an edge belonging to a DIFFERENT HOUSTON_HOME.

    Compose keys a project by NAME, and every home uses the same one, so
    `docker compose -p houston_edge up -d` REPLACES another home's container
    rather than failing -- silently taking down every https name that edge was
    serving. Observed doing exactly that while testing.

    It matters more than the "one shared home" assumption in §3.2 suggests,
    because the default home is `~/.houston`: on a box where two people each run
    houston as themselves, the second `up --https` quietly steals the first
    one's ingress.
    """
    out = _docker("ps", "--filter", f"label=com.docker.compose.project={PROJECT}",
                  "--filter", "status=running", "--format", "{{.ID}}")
    for cid in out.stdout.split():
        where = _docker("inspect", cid, "--format",
                        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
        found = where.stdout.strip()
        if found and found != str(paths.edge_dir()):
            return found
    return ""

def _compose_capture(*args: str) -> str:
    """`docker compose` in the edge project, captured. "" if it could not run."""
    try:
        res = subprocess.run(["docker", "compose", "-p", PROJECT, *args],
                             cwd=paths.edge_dir(), text=True, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return (res.stdout or "") + (res.stderr or "")

def down() -> int:
    """Stop the edge. Routes are files and survive this, so starting it again
    restores every name with no re-registration."""
    return _compose("down", "--remove-orphans").returncode

def running() -> bool:
    """Whether THIS home's edge is running.

    The project label alone is not enough. Every HOUSTON_HOME uses the same
    compose project name, so a container started from a different home matched
    and this returned True -- while `installed()`, which reads the current home,
    returned False. `ensure_running()` then skipped writing any configuration,
    the routes went into a directory nothing was watching, and every name 404'd
    with `edge status` reporting "no edge yet" beside a running edge.

    The design assumes ONE shared home per box (§3.2), and this does not change
    that: it makes the unsupported case fail loudly -- the start is attempted and
    refused by whoever holds :443, which port_holder() names -- rather than
    silently doing nothing.
    """
    cid = our_container()
    return bool(cid) and publishes_ports(cid)

def our_container() -> str:
    """The id of a RUNNING edge container belonging to THIS home, or "".

    Split out from `running()` so the two questions stay separate: whether a
    container of ours is up, and whether it is actually serving. Conflating them is
    what let a Traefik holding no ports be reported as a working edge.
    """
    out = _docker("ps", "--filter", f"label=com.docker.compose.project={PROJECT}",
                  "--filter", "status=running", "--format", "{{.ID}}")
    for cid in out.stdout.split():
        where = _docker("inspect", cid, "--format",
                        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
        if where.stdout.strip() == str(paths.edge_dir()):
            return cid
    return ""

def publishes_ports(cid: str) -> bool:
    """Whether container `cid` actually HOLDS :80 and :443.

    Up is not the same as serving, and the gap is not theoretical: a container can
    start while another process owns its ports, and Docker then runs it with the
    bindings simply absent. That is a Traefik answering on nothing -- it cannot serve
    a single name -- and `running()` used to call it running. `edge status` then said
    "State running" over an edge that was serving nothing, which is the one shape of
    wrong answer this file exists to avoid: every workspace with a name depends on
    this component, and nothing else in the tool would have contradicted it.

    It also restores an invariant `ensure_running` states out loud and then relies on:
    that nothing else can hold :443 while our edge is up.
    """
    seen = _docker("inspect", cid, "--format", "{{json .NetworkSettings.Ports}}")
    if seen.returncode != 0:
        return True     # cannot tell: do not invent a failure
    try:
        import json as _json
        ports = _json.loads(seen.stdout.strip() or "{}") or {}
    except ValueError:
        return True
    return all(ports.get(f"{p}/tcp") for p in (80, 443))
