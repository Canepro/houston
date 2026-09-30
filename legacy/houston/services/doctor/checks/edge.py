"""The shared Traefik and the routes it is serving.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import runner

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "edge"


def _routes(line, edgesvc, routes, ctx) -> None:
    """Every route the edge is serving: the ones whose workspace is gone, and the
    ones nothing answers on.

    Lifted out of `check` for size alone. The CALL sits exactly where this code sat --
    inside `if edgesvc.installed():`, inside the one `try` -- so an edge that is not
    installed still skips it and a failure still produces exactly one row.
    """
    if ctx.docker_up:
        # A route whose workspace is gone points the edge at nothing, so
        # that hostname 502s instead of 404ing and the name cannot be
        # reused.
        known = {m.name for m in runner.list_meta()}
        stale = [r for r in routes if r not in known]
        if stale:
            # `down --name <it>` was the advice and it CANNOT work here: the
            # workspace is what is missing, so `down` answers "no such
            # workspace" and the route stays. Found by running doctor against
            # a home with exactly this state. `edge delete` takes the HOSTNAME,
            # which is the thing that still exists -- and removes the
            # certificate and private key the route was serving, which `down`
            # never did for a workspace that was still there either.
            hosts = [edgesvc.route_host(r) or r for r in sorted(stale)[:5]]
            line(SUBJECT, "warn", f"{len(stale)} edge route(s) with no workspace: "
                         f"{', '.join(sorted(stale)[:5])} — `down` cannot "
                         f"remove these, the workspace is what is gone. "
                         f"`houston edge delete {hosts[0]}` forgets a name, "
                         f"its certificate and its key")
        # A route the edge cannot REACH is a 502 rather than an error, and
        # nothing else in the tool would ever say so. Happens after the
        # edge is recreated, since attachments are runtime state.
        if edgesvc.running():
            attached = set(edgesvc.attached_networks())
            orphan = [r for r in routes if r in known
                      and edgesvc.workspace_network(r) not in attached]
            if orphan:
                line(SUBJECT, "warn",
                     f"{len(orphan)} route(s) the edge cannot reach: "
                     f"{', '.join(sorted(orphan)[:5])} — they answer 502. "
                     "`houston edge restart` re-attaches them")


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # The shared edge. Silent unless one is set up, so a single-user install
    # sees no rows about a thing it does not have -- but once one exists it is
    # reported, because everything on the box depends on it (§8, shared fate):
    # while it is down the GUI and EVERY registered workspace are unreachable,
    # and nothing else in this report would say so.
    try:
        from houston.services import edge as edgesvc

        if edgesvc.installed():
            served = edgesvc.served_domain()
            where = f" ({served})" if served else ""
            routes = edgesvc.registered()
            if not ctx.docker_up:
                line(SUBJECT, "warn", f"Edge{where} installed — cannot check it, Docker is down")
            elif edgesvc.running():
                line(SUBJECT, "ok", f"Edge running{where} — holds :80/:443, "
                           f"{len(routes)} workspace route(s)",
                     elsewhere="the edge chip in the header")
            else:
                # Name what is holding the port. "the edge is not running" sends
                # you looking at the edge, when the cause is usually something
                # else on :443 -- a Traefik left by an older houston, or an
                # unrelated web server.
                holder = edgesvc.port_holder(443) if ctx.docker_up else ""
                because = f" — {holder} is holding :443" if holder else ""
                line(SUBJECT, "fail", f"Edge{where} is NOT running{because}. Every https "
                             f"name on this box ({len(routes)} route(s)) is "
                             "unreachable. `houston edge start`")
            if ctx.docker_up and edgesvc.running():
                # CHANGED ON DISK AND NOT APPLIED. The container keeps the command
                # line it was created with, so a rewritten compose file reaches
                # nothing until the edge is recreated -- and every other message
                # went on saying the edge was fine. `edge start` re-applies now;
                # this is what says the two had diverged in the first place.
                stale_cfg, live_only = edgesvc.config_drift()
                if stale_cfg or live_only:
                    shown = ", ".join((stale_cfg + live_only)[:3])
                    line(SUBJECT, "warn", f"the edge's configuration on disk and the running "
                                 f"container disagree ({shown}"
                                 f"{'…' if len(stale_cfg + live_only) > 3 else ''}). "
                                 f"Whatever was changed has not been applied — "
                                 f"`houston edge restart`",
                         check="edge-config-drift")
            _routes(line, edgesvc, routes, ctx)
    except Exception:  # noqa: BLE001 - a check must never break the report
        line(SUBJECT, "warn", "Edge status could not be determined")
    return report.rows
