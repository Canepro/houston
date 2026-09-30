"""The guard chain after it left `create_app()` (skipped unless [gui] is installed).

`web/security.py` holds the authorisation table, the middleware that reads it, the
Host and cross-site checks, the peer/scheme resolution underneath them, and the two
limiters that bound what an unauthenticated caller can spend. All of it used to be
either module-level in `web/app.py` or a closure inside `create_app()`.

Four things can break in a move like this without a single existing test noticing, and
each has a test here:

* **A re-export that is a copy rather than the same object.** The suite clears and
  inspects the sign-in throttle through `houston.web.app`. A copied dict clears a
  dict nothing reads, and every throttle test passes while the bound is gone.
* **A closure becoming a module global.** `host_ok` and friends closed over one
  application's allow-list. If the move left any of them reading module state, two
  apps in one process would answer for each other — and the suite builds dozens.
* **The middleware registering more than once, or not at all.** `install()` is now
  called by name instead of a decorator running as the factory body executes.
* **`app.state.public_https` stopping being live.** `cookie_name` decides the
  `__Host-` prefix, which is the whole of what a sibling workspace cannot forge.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from houston.web import app as webapp  # noqa: E402
from houston.web import security  # noqa: E402
from houston.web.app import create_app  # noqa: E402


def test_the_throttle_state_is_shared_by_reference_not_copied():
    """`webapp._signin_fails.clear()` must clear the dict the limiter reads."""
    assert webapp._signin_fails is security._signin_fails
    assert webapp._signin_lock is security._signin_lock
    assert webapp._preauth_seen is security._preauth_seen
    assert webapp._preauth_lock is security._preauth_lock
    assert webapp.ROUTE_ROLES is security.ROUTE_ROLES

    with security._signin_lock:
        security._signin_fails.clear()
    webapp._signin_failed("1.2.3.4")
    assert security._signin_fails.get("1.2.3.4"), \
        "a failure recorded through web.app did not reach the limiter's own state"
    with security._signin_lock:
        security._signin_fails.clear()


def test_the_throttle_bounds_agree_across_the_re_export():
    for name in ("SIGNIN_MAX_FAILURES", "SIGNIN_WINDOW", "_SIGNIN_MAX_KEYS",
                 "PREAUTH_AUDIT_WINDOW"):
        assert getattr(webapp, name) == getattr(security, name), name
    for name in ("_signin_retry_after", "_signin_failed", "_signin_ok",
                 "_preauth_should_audit", "route_requirement"):
        assert getattr(webapp, name) is getattr(security, name), name


def test_two_applications_do_not_share_one_allow_list():
    """The checks take a context. Module state here would make them answer for each
    other, and the suite builds dozens of applications in one process."""
    a = create_app(allow_hosts=["a.example"])
    b = create_app(allow_hosts=["b.example"])
    assert a.state.host_ok("a.example") is True
    assert a.state.host_ok("b.example") is False
    assert b.state.host_ok("b.example") is True
    assert b.state.host_ok("a.example") is False


def test_allow_host_star_widens_hosts_without_widening_origins():
    """The distinction `*` once collapsed: it must not disable the cross-site guard."""
    app = create_app(allow_hosts=["*"])
    assert app.state.host_ok("anything.example") is True
    assert app.state.cross_site({"origin": "https://evil.example",
                                 "host": "anything.example"}) is True
    assert app.state.cross_site({"origin": "https://anything.example",
                                 "host": "anything.example"}) is False


def test_the_guard_is_installed_exactly_once():
    """Registered by a named call now, not by a decorator running as the factory
    body executes -- so "twice" and "never" are both newly possible."""
    from starlette.middleware.base import BaseHTTPMiddleware

    app = create_app()
    installed = [m for m in app.user_middleware if m.cls is BaseHTTPMiddleware]
    assert len(installed) == 1, f"expected one guard middleware, found {len(installed)}"


def test_cookie_name_follows_the_live_https_answer_not_the_frozen_one():
    app = create_app()
    ctx = app.state.ctx
    assert security.cookie_name(app, ctx) == "houston_session"
    app.state.public_https = True
    assert security.cookie_name(app, ctx) == "__Host-houston_session", \
        "the __Host- prefix is decided from a stale copy of public_https"


def test_the_table_uses_ws_as_its_only_non_http_method():
    """The `("WS", ...)` entries are the deliberate special case: a WebSocket
    handshake never reaches the HTTP middleware, so the handler consults the table
    itself and the pseudo-method is how it names its own row."""
    http_methods = {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"}
    ws_keys = [k for k in security.ROUTE_ROLES if k[0] == "WS"]
    assert ws_keys, "the WS special case disappeared from the table"
    for method, template in security.ROUTE_ROLES:
        assert method in http_methods or method == "WS", (method, template)
    for _method, template in ws_keys:
        assert "/logs/stream" in template, template


def test_matched_template_asks_starlettes_own_matcher():
    """A second regex table beside ROUTE_ROLES is the drift the table exists to stop."""
    app = create_app()
    scope = {"type": "http", "method": "GET", "path": "/api/repros/t1/detail",
             "path_params": {}, "headers": [], "root_path": ""}
    assert security.matched_template(app, scope) == "/api/repros/{name}/detail"
    scope["path"] = "/api/nothing-here"
    assert security.matched_template(app, scope) == "", \
        "an unmatched path must resolve to '' so route_requirement returns None"
