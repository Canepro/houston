"""What a route module needs from the application it is registering into.

The twelve modules under `web/routes/` hold their handlers at MODULE level, not nested
inside the function that registers them. That is deliberate and it is the whole reason
this file exists.

Nested handlers reach the application by closure, which is exactly what `create_app()`
did and exactly what could not survive the split: a closure does not cross a module
boundary. Keeping them nested inside a per-module `register()` would only move the
problem — one 2,091-line factory becomes twelve 200-line ones, every handler still
anonymous inside something else, and `tools/structure_check.py` counting twelve new
over-cap functions where there had been one. Module level gives each handler its own
name, its own measured size, and a signature FastAPI can introspect without help.

The cost is that a module-level handler has no `app`. FastAPI's answer is the request,
which carries it: `request.app` is the application that matched the route, and
`request.app.state.ctx` is that application's frozen `AppContext`. These four helpers
are that lookup with a name on it, so a route module never spells out the chain and the
suite can find every site that reaches for live application state.

`carrier` rather than `request` in the signatures below: a `WebSocket` carries `.app`
in exactly the same way, and `logs_stream` is a WebSocket.
"""
from __future__ import annotations

from houston.web import security
from houston.web.context import AppContext
from houston.web.jobs import JobManager


def ctx(carrier) -> AppContext:
    """This application's frozen context."""
    return carrier.app.state.ctx


def jobs(carrier) -> JobManager:
    """This application's job registry. Per-application, never global: two apps in one
    process must not see each other's jobs, and the suite builds dozens."""
    return carrier.app.state.ctx.jobs


def peer(request) -> tuple[str, bool]:
    """(client address, is the BROWSER's hop https) — the throttle key and the cookie's
    Secure flag, decided once."""
    return security.peer_of(request.app, request)


def cookie_name(carrier, https: bool | None = None) -> str:
    """Which of the two session cookie names is live for this request's scheme."""
    return security.cookie_name(carrier.app, carrier.app.state.ctx, https)


def set_session_cookie(request, response, token: str, https: bool | None = None) -> None:
    """Mint the session cookie on `response`, with the right name and `Secure` flag."""
    security.set_session_cookie(request.app, request.app.state.ctx, response, token, https)


def clear_session_cookie(request, response) -> None:
    """Remove BOTH cookie names, so switching a box between http and https cannot
    strand one the new scheme will never overwrite."""
    security.clear_session_cookie(request.app.state.ctx, response)
