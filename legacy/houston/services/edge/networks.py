"""networks -- see the package docstring."""
from __future__ import annotations

from houston import runner

from houston.services.edge import engine
from houston.services.edge.paths import CONTAINER

def workspace_network(name: str) -> str:
    """The network compose creates for a workspace: `<project>_default`."""
    return f"{runner.project_name(name)}_default"

def backend_container(name: str, service: str) -> str:
    """The container compose creates for one of a workspace's services.

    A CONTAINER name, not a service alias, and that distinction is the whole
    reason routes work. The edge is attached to many workspace networks, each
    containing a service called `rocketchat`; asking for `rocketchat` from there
    resolved 6/6 to one particular workspace. Container names are unique across
    every network, so they cannot be confused.
    """
    return f"{runner.project_name(name)}-{service}-1"

def container_addresses() -> list[str]:
    """Every IP the edge container currently holds, one per network it has joined.

    This is what `serve --domain` trusts for X-Forwarded-*, and it has to be the
    EXACT set rather than a subnet: the edge reaches the host from an address on a
    workspace network, and that /16 also contains the customer-image Rocket.Chat
    containers. A CIDR here would hand X-Forwarded-For to every workspace.

    Re-read rather than cached: the set changes as the edge joins networks.
    """
    out = engine._docker("inspect", CONTAINER, "--format",
                  "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}")
    if out.returncode != 0:
        return []
    return [a for a in out.stdout.split() if a]

def attached_networks() -> set[str]:
    """Workspace networks the edge is currently joined to."""
    out = engine._docker("inspect", CONTAINER, "--format",
                  "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}\n{{end}}")
    if out.returncode != 0:
        return set()
    return {ln.strip() for ln in out.stdout.splitlines() if ln.strip()}

def attach(name: str) -> bool:
    """Join the edge to `name`'s own network, live. Idempotent.

    This is what replaces recreating the workspace. `docker network connect` acts
    on a RUNNING container -- verified: reachable immediately afterwards, with the
    target's StartedAt unchanged. Nothing stops, nothing is rebuilt, no volume is
    touched, so doing this to twenty workspaces costs twenty seconds rather than
    twenty rebuilds.

    Joining the EDGE to the workspace's network (rather than the workspace to a
    shared one) is what preserves isolation: each workspace keeps the private
    network compose already gave it, and verified that w1 could reach w2 neither
    by name nor by IP with the edge attached to both.
    """
    net = workspace_network(name)
    if net in attached_networks():
        return True
    # A workspace that has never been `up`ed has no network yet; not an error, the
    # attach simply happens after it is created.
    return engine._docker("network", "connect", net, CONTAINER).returncode == 0

def attach_network(net: str) -> bool:
    """Join the edge to a Docker network BY NAME. Idempotent.

    `attach` joins a network derived from a WORKSPACE name, which is every network the
    edge has ever needed -- until a cluster turned out to be one too. A kind cluster's
    node is a container on kind's own Docker network, so its NodePort is reachable from
    the host and NOT from a container on the default bridge, which is where the edge
    lives. Measured exactly that way: `172.18.0.2:30925` answered from the host and
    from a container on the `kind` network, and was unreachable from one on `bridge`.

    Kept separate from `attach` rather than generalising it: that function's whole
    contract is "the network compose made for this workspace", and its name is what
    makes the container-name routing rule readable.
    """
    if not net or net in attached_networks():
        return True
    return engine._docker("network", "connect", net, CONTAINER).returncode == 0

def container_network(container: str) -> str:
    """The first Docker network `container` is on, or "".

    Used to find out where a cluster's node lives, so the edge can join it. Read
    rather than assumed: kind's default network is called `kind`, but a cluster
    created with a different config need not be on it.
    """
    out = engine._docker("inspect", container, "--format",
                  "{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}")
    if out.returncode != 0:
        return ""
    names = [n for n in out.stdout.split() if n]
    return names[0] if names else ""

def detach(name: str) -> None:
    """Leave `name`'s network. Best-effort -- the network may already be gone."""
    engine._docker("network", "disconnect", "-f", workspace_network(name), CONTAINER)
