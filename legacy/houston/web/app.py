"""FastAPI application for the local houston GUI.

Imported lazily by `houston serve`. Blocking service calls run in path operations
declared with `def` (Starlette runs those in a threadpool), so the event loop is never
blocked. Long operations become background jobs (see jobs.py) streamed to the browser
over SSE.

**This module is the factory and nothing else now.** It builds the application, decides
the nine values in `web/context.py`, installs the guard chain from `web/security.py`,
and asks `web/routes/` to register every endpoint. The handlers themselves live there,
one module per group; the one thing that must not move is that `spa` is last in
`routes.REGISTRATION_ORDER`, because its mount matches every path.

The `web/security.py` and `web/context.py` names re-exported below are reached through
`houston.web.app` by `serve` and by the suite, some of them by reference so that
clearing the throttle here clears the one the limiter actually reads.
"""

from __future__ import annotations

import asyncio
import sys
from contextlib import asynccontextmanager


from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from houston.errors import ReproError, as_payload as error_body
from houston.services import lifecycle as lc
# `parse_trusted` and friends live in context.py now -- they parse `trust_proxy`,
# which is one of the nine fields -- and are re-exported here because `serve` and
# the suite have always imported them from this module.
from houston.web import context
from houston.web.context import (_rightmost_untrusted,  # noqa: F401
                                 parse_trusted, trusted_problems, usable_trusted)
from houston.web import routes
from houston.web import security
# The guard chain moved to security.py in one piece. Re-exported here because every
# one of these names is reached through `houston.web.app` by the suite (the throttle
# state by reference, so a `.clear()` still clears the live one) and because
# `route_requirement` is what the WebSocket handler below calls to enforce the table
# the middleware cannot reach.
from houston.web.security import (PREAUTH_AUDIT_WINDOW,  # noqa: F401
                                  ROUTE_ROLES, SIGNIN_MAX_FAILURES, SIGNIN_WINDOW,
                                  _preauth_lock, _preauth_seen, _preauth_should_audit,
                                  _SIGNIN_MAX_KEYS, _signin_fails, _signin_failed,
                                  _signin_lock, _signin_ok, _signin_retry_after,
                                  route_requirement)
from houston.web.jobs import JobManager


def _configure_app(accounts, allow_hosts, first_run, jobs, lifespan, public_https, trust_proxy):
    """Everything the app carries on its state, and the context every route reads it from."""
    app = FastAPI(title="houston", docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)
    app.state.jobs = jobs
    # Whether the login is enforced.
    app.state.basic_auth = accounts      # legacy name, still read by tests
    app.state.accounts = accounts
    # Whether the BROWSER's hop is https. Not derived from the request: behind the
    # edge every request arrives as plain http on the docker bridge, and
    # X-Forwarded-Proto is a client claim until `--trust-proxy` exists to say whose
    # claim to believe. `serve --domain` knows the answer as a server-side fact --
    # houston arranged the TLS itself -- so it passes it in. Decides the cookie's
    # `Secure` and `__Host-` prefix, so guessing here would be guessing about a
    # security attribute.
    app.state.public_https = public_https
    # Whether the first-run flow is available. `serve` sets it only on a
    # loopback bind with no accounts -- a bootstrap credential reachable from
    # the network is the thing being removed, not a smaller version of it.
    app.state.first_run = first_run
    #: Peers whose X-Forwarded-* headers are believed. EMPTY by default, and that
    #: is the whole point: uvicorn trusts 127.0.0.1 out of the box, so on the
    #: default bind any other local user could rewrite the client address and the
    #: scheme -- both of which decide security here. `serve` passes
    #: proxy_headers=False to uvicorn and resolves it below instead, where the
    #: trust is explicit and per-peer.
    app.state.trusted_proxies = parse_trusted(trust_proxy)

    # ONE construction site for the nine values the eighty handlers in web/routes/
    # reach through the request. Built HERE -- before a single route is registered --
    # so nothing can be attached to an application whose configuration was not final,
    # and `frozen=True` refuses any later assignment. web/context.py says why
    # `public_https` is the one field a request must still read live from `app.state`.
    ctx = context.build(allow_hosts=allow_hosts, jobs=jobs, accounts=accounts,
                        public_https=public_https,
                        trust_proxy=app.state.trusted_proxies)
    app.state.ctx = ctx
    return app, ctx


def create_app(allow_hosts: list[str] | None = None, *,
               accounts: bool = True, public_https: bool = False,
               first_run: bool = False, trust_proxy=None) -> FastAPI:
    """The GUI application. There is exactly one way in: a session.

    `token=` and `basic_auth=` are gone. Both were credentials the browser had to
    carry on every request -- one in the URL, one in a header -- and both are
    replaced by a cookie the server can revoke. `accounts` survives as a switch
    only so a test can build an app with the login disabled; `serve` always
    passes True.
    """
    # openapi_url=None as well as the doc UIs: the schema path does not start
    # with /api/, so `guard` below would serve it to anyone.
    jobs = JobManager()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        from houston.services import eventlog
        with eventlog.eventlog_sink():
            # STARTUP. Whatever the last process was killed in the middle of is still
            # true: the drain below is bounded, and a SIGKILL or an OOM skips it
            # entirely, so a previous run can have left Rocket.Chat stopped or the API rate
            # limiter off with nothing in memory recording it. `journal.recover`
            # acts only on notes whose owning process is provably gone, so a CLI operation running right now is left alone.
            try:
                from houston.services import recovery
                repaired = await asyncio.to_thread(recovery.recover, login=lc.login)
                for row in repaired:
                    mark = "repaired" if row["repaired"] else "STILL BROKEN"
                    print(f"houston: {mark}: {row['what']}", file=sys.stderr)
            except Exception as exc:  # noqa: BLE001 - a box that cannot be repaired must still serve
                print(f"houston: could not check for interrupted work: {exc}", file=sys.stderr)
            yield
            # Shutdown. Job threads are daemons, so without this a `systemctl restart`
            # kills them mid-operation and skips every `finally` -- leaving Rocket.Chat
            # stopped after an interrupted backup, or the rate limiter off and CPU caps
            # applied after an interrupted load test. Run in a thread because drain()
            # blocks on join() and this is the event loop. The surrounding lease remains
            # live until drain finishes, so every job's final event is durable.
            left = await asyncio.to_thread(jobs.drain)
            if left:
                # Named, so the operator knows which repro to look at rather than
                # finding it in a strange state days later.
                print(f"houston: shut down with {len(left)} job(s) still running: {', '.join(left)}", file=sys.stderr)

    app, ctx = _configure_app(accounts, allow_hosts, first_run, jobs, lifespan, public_https, trust_proxy)
    # The Host allow-list, the cross-site check, the peer/scheme resolution and the
    # middleware that reads the role table: all of it in security.py, installed here
    # BEFORE any route exists so nothing can be registered outside the chain.
    security.install(app, ctx)
    # Every route, in `REGISTRATION_ORDER`. Nothing is registered outside it any more,
    # which is what makes `spa` being last in that tuple the whole of the catch-all rule.
    routes.register_all(app, ctx)

    @app.exception_handler(ReproError)
    async def _repro_error(_: Request, exc: ReproError):
        return JSONResponse(error_body(exc), status_code=exc.http_status)

    return app
