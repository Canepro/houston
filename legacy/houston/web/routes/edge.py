"""The shared Traefik front door: what it holds, and removing a name from it.

One edge holds :80/:443 for the whole box and a workspace gains or loses HTTPS by a
route file appearing or disappearing — none of it is in any workspace's compose file, so
this is the only place to ask what the edge is actually serving.

`DELETE /api/edge/hosts/{host}` is ADMIN for the same reason people-management is: it
deletes a private key, irreversibly, and a member may create and destroy their own
workspaces but the box's shared front door is not theirs to edit.
"""
from __future__ import annotations

from houston.services import audit as auditsvc
from houston.web.context import AppContext


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name -- but `register` is the only thing anything outside this
#: package may reach for, and a test walks the imports to prove nothing does.
__all__ = ("register",)


def _route_host(edgesvc, name: str) -> str:
    """The hostname a route file serves, for display.

    `edge.route_host` — which matches `Host()` and `HostSNI()` alike — rather than
    the local copy that matched only the first, and so reported every Kubernetes
    passthrough route as unreachable in three places at once.
    """
    return edgesvc.route_host(name)


def edge_status():
    """The shared Traefik, and whether each name it serves is actually
    reachable.

    Its own endpoint rather than a field on /api/health: this shells out to
    docker twice and health is the cheap, unauthenticated one that every tab
    polls every four seconds.
    """
    from houston.services import edge as edgesvc

    st = edgesvc.status()
    attached = set(st.pop("attached", []))
    st["domain"] = edgesvc.served_domain()
    st["routes"] = [
        {"name": n,
         "host": _route_host(edgesvc, n),
         # WHICH KIND OF ROUTE, because "reachable" means different things for the
         # two and only one of them is an attachment question.
         "passthrough": edgesvc.is_passthrough(n),
         # A route the edge cannot reach answers 502 rather than erroring, which is
         # the one failure nothing else in the UI would surface -- for a route that
         # names a CONTAINER, which the edge resolves over a shared Docker network.
         #
         # A PASSTHROUGH ROUTE NAMES AN ADDRESS, and there is no network to join, so
         # this test is not merely useless for it but inverted: it can never be true,
         # so every Kubernetes workspace was reported unreachable. Seen in a browser
         # against a name answering 200 from the public internet: the header said
         # "edge: 1 unreachable", the rail filed the workspace under "Wants you", and
         # the panel said "The edge cannot reach this workspace ... the edge is not on
         # this workspace's network". Three places, one field, all of them wrong.
         # The same helper `edge status` uses; the rule lives in the service.
         "reachable": edgesvc.route_reachable(n, attached)}
        for n in st.get("routes", [])
    ]
    # CERTIFICATES WITH NO ROUTE -- the other half of the blind spot `orphan_certs`
    # covers. That one finds a declaration whose certificate is missing; this finds
    # a certificate, and a private key, that nothing points at. Sent to the browser
    # because a name cannot be cleaned up until it can be SEEN, and an operator
    # handed `serve` and no shell had no way to see this at all.
    claimed = {r["host"].casefold() for r in st["routes"] if r["host"]}
    claimed.add((st["domain"] or "").casefold())
    st["stale_certs"] = [h for h in edgesvc.acme_hosts()
                         if h.casefold() not in claimed]
    return st


def edge_host_delete(host: str, confirm: bool = False):
    """Forget a name completely — route, certificate, private key, ACME entry.

    The GUI needs this at least as much as the terminal does: a support engineer
    handed `serve` and no shell has no other way to remove a Let's Encrypt
    private key for a customer-shaped hostname from the box, and `down --volumes`
    does not do it — it removes the route and walks past the certificate.

    `confirm` is a query parameter rather than an assumption. `delete_host`
    refuses without it, so a request that forgets the flag gets a 400 naming
    what it would have destroyed instead of destroying it.
    """
    from houston.services import edge as edgesvc

    auditsvc.record("edge-delete-host", host,
                    outcome="ok" if confirm else "denied")
    return edgesvc.delete_host(host, confirm=confirm)


ROUTES = (
    ("get", "/api/edge", edge_status),
    ("delete", "/api/edge/hosts/{host}", edge_host_delete),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
