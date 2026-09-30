"""routes -- see the package docstring."""
from __future__ import annotations

from houston import runner

from houston.services.edge import networks
from houston.services.edge import paths
from houston.services.edge import routeyml
from houston.services.edge import spec as edge_spec
from houston.services.edge.paths import _RULE_HOST

def route_reachable(name: str, attached: set[str] | list[str]) -> bool:
    """Whether the edge can actually deliver `name`'s route, given what it is attached to.

    TWO DIFFERENT QUESTIONS behind one column. An HTTP route is delivered over a
    Docker network the edge has joined, so membership is the test. A PASSTHROUGH
    route forwards raw TCP to an address -- a cluster NodePort -- and joins no
    workspace network at all, so membership is always False for it and the honest
    answer is not "unreachable".

    `/api/edge` learned this and `edge status` did not, so the CLI reported
    `NO (502)` for every Kubernetes workspace. Measured in production conditions: a
    workspace answering HTTP 200 from the internet on a real Let's Encrypt
    certificate, listed as unreachable by the command whose job is to say so. One
    implementation here because that is the second time these two front ends
    disagreed about the same route file.
    """
    if is_passthrough(name):
        return True
    return networks.workspace_network(name) in set(attached)

def is_passthrough(name: str) -> bool:
    """Whether `name`'s route passes TLS through rather than terminating it.

    Read from the route FILE, and parsed rather than sniffed for a substring: the
    caller that needs it is `reattach_all` on the `edge start` path, which is looking
    at routes and may have no workspace record to consult -- a route outlives its
    workspace, which is the whole reason `deregister` exists.

    False for anything unreadable. The only consequence of being wrong here is an
    attach that was not needed, which is a no-op, so the safe answer is the one that
    behaves as this function's absence did.
    """
    import yaml

    try:
        doc = yaml.safe_load(paths.route_path(name).read_text(encoding="utf-8"))
    except (OSError, ValueError, yaml.YAMLError):
        return False
    return isinstance(doc, dict) and "tcp" in doc

def register(name: str, host: str, instances: int = 1, local: bool = False,
             passthrough: str = "") -> bool:
    """Add (or replace) a workspace's route. Picked up without a restart.

    Returns whether `host` needs a certificate OF ITS OWN -- False when the edge's
    wildcard already covers it, which is what the caller counts against the weekly
    limit (§6). Decided here because this is where the edge's own configuration is
    readable.

    Attaching is part of registering, not a separate step a caller can forget: a
    route pointing at a container the edge cannot resolve is a 502 rather than an
    error, which is the hardest kind of failure to diagnose.

    `passthrough` is an `<address>:<port>` the edge forwards raw TCP to instead of
    terminating -- a Kubernetes workspace's ingress. It takes a plain address on
    purpose: the edge has no business knowing what a cluster is, and keeping this
    module runtime-agnostic is what stops "does this workspace terminate TLS" from
    becoming a build-time property again. The caller resolves the address; this
    writes a route to it.

    Two things do NOT happen for a passthrough, and both would be wrong rather than
    merely wasteful. There is no `attach`: that joins a Docker network named after a
    compose project, and a Kubernetes workspace has neither. And the return is always
    False, because no certificate is requested for a name the edge does not present
    one for -- counting it against the weekly limit would spend budget on nothing.
    """
    paths.dynamic_dir().mkdir(parents=True, exist_ok=True)
    if passthrough:
        runner.atomic_write(paths.route_path(name),
                            routeyml.passthrough_route_yml(name, host, passthrough))
        return False
    door = edge_spec.current()
    covered = bool(door and door.covers(host))
    runner.atomic_write(paths.route_path(name), routeyml.workspace_route_yml(
        name, host, instances, local=local,
        wildcard_base=door.domain if (covered and door) else ""))
    networks.attach(name)
    return not covered

def deregister(name: str) -> None:
    """Remove a workspace's route. Removing the file 404s that host and leaves
    every other route untouched -- verified."""
    paths.route_path(name).unlink(missing_ok=True)

def route_host(name: str) -> str:
    """The hostname `name`'s route claims, or "".

    Read from the file rather than from the workspace record, for the same reason
    `is_passthrough` is: a route outlives its workspace, and the caller that needs to
    know about a collision is looking at routes.
    """
    try:
        found = _RULE_HOST.search(paths.route_path(name).read_text(encoding="utf-8"))
    except OSError:
        return ""
    return found.group(1) if found else ""

def host_owner(host: str, *, excluding: str = "") -> str:
    """Which OTHER workspace's route already claims `host`, or "".

    NOTHING CHECKED THIS, and ports have been guarded since long before names were.
    A route file is keyed by WORKSPACE NAME, so two workspaces given the same
    `--domain` each write their own file claiming the same `Host()` -- and Traefik
    picks one. That is the failure this module's own docstring warns about one layer
    down, in the same words: it "looks stable under testing and would silently serve
    the wrong workspace forever".

    Found by running it: three route files on one box all claiming
    `HostSNI(rc-rpro-test.kestron.org)` after a matrix of scenarios, two of them
    pointing at NodePorts that no longer existed. Traefik chose a dead one, so the
    name returned EOF, cert-manager's self check failed, and the certificate never
    issued -- for a chain that was otherwise completely correct.

    `excluding` is the workspace being created or brought back, which is allowed to
    re-claim its own name.
    """
    if not host:
        return ""
    for other in registered():
        if other == excluding:
            continue
        if route_host(other).casefold() == host.casefold():
            return other
    return ""

def routes_for(host: str) -> list[str]:
    """EVERY route file claiming `host`, not just the first.

    `host_owner` answers "is this name taken", which needs one name and stops. This
    answers "what would I have to remove to free it", and the difference is not
    theoretical: the collision that cost an hour of debugging was THREE route files
    on one host, two of them pointing at NodePorts that no longer existed. A cleanup
    that removed one would have left the name still broken and still claimed.
    """
    if not host:
        return []
    return [n for n in registered() if route_host(n).casefold() == host.casefold()]

def registered() -> list[str]:
    """Workspace names with a route right now (the GUI's own route excluded)."""
    if not paths.dynamic_dir().is_dir():
        return []
    return sorted(p.stem for p in paths.dynamic_dir().glob("*.yml")
                  if not p.stem.startswith("_"))

def reattach_all() -> list[str]:
    """Join every routed workspace's network. Returns the ones that failed.

    Attachments are RUNTIME state on the container, so recreating the edge --
    an upgrade, a `restart`, a reboot that pulls a new image -- loses every one
    of them while the route files survive untouched. The result is a set of names
    that answer 502 rather than erroring, so this runs after every start rather
    than waiting for someone to notice.
    """
    failed = []
    for name in registered():
        # A passthrough route has no network to join -- it names an address, not a
        # container. Attaching would run `docker network connect` for a compose
        # project that does not exist, fail, and report a perfectly healthy
        # Kubernetes workspace as one the edge could not reach, on every restart.
        if is_passthrough(name):
            continue
        if not networks.attach(name):
            failed.append(name)
    return failed
