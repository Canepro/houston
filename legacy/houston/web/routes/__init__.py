"""The route modules, and the order `create_app()` registers them in.

Each module exposes exactly one public function, `register(app, ctx)`, and nothing
else. `REGISTRATION_ORDER` is that order, as data rather than as twelve import
statements, so one test can read it and it cannot drift from the order actually used.

**The order matters in exactly one place, and it is the last entry.** `spa` mounts
`StaticFiles(..., html=True)` at `/`, which matches every path — so anything registered
after it is unreachable and an API route would quietly start answering with the SPA's
`index.html`: a 200 with the wrong body, which no status assertion catches. A test
asserts there is exactly one Mount in `app.routes` and that it is the final entry,
rather than trusting this comment.

Nothing else here depends on order. Every API template is distinguishable by shape — a
path parameter does not span a `/`, so `/api/repros/{name}` cannot match
`/api/repros/t1/detail` — which is why the groups can be arranged to read the way the
documentation groups the commands rather than to satisfy the router.
"""
from __future__ import annotations

#: Module name -> what it is responsible for. Imported and called in this order.
REGISTRATION_ORDER = (
    "session",      # sign in, sign out, who am I, first run
    "people",       # accounts, roles, the audit log
    "meta",         # the box: health, doctor, settings, machine, presets, versions
    "repros",       # workspaces: make, look, change, destroy
    "logs",         # the polled tail and the live stream
    "data",         # seed, scale, settings import
    "backup",       # backup, restore, upgrade
    "clusters",     # the cloud ledger
    "edge",         # the shared Traefik front door
    "perf",         # load tests, capacity, the monitoring add-on
    "jobs",         # the background job registry
    "spa",          # the catch-all static mount -- ALWAYS LAST
)


def register_all(app, ctx) -> None:
    """Call every module's `register` in `REGISTRATION_ORDER`."""
    from importlib import import_module

    for module in REGISTRATION_ORDER:
        import_module(f"{__name__}.{module}").register(app, ctx)
