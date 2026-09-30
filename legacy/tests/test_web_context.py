"""The frozen `AppContext` (skipped unless the [gui] extra is installed).

`web/app.py` hands ~80 nested route handlers their configuration by closure. Phase 2a
moves those handlers into `web/routes/`, where the closure does not reach -- so the
nine values first have to become one object with a name, a shape and exactly one
construction site. These tests pin that object, because everything built on top of it
in the following eleven steps assumes all three.

Three hazards are pinned here rather than described:

* **The shape.** Eleven modules will take this object and nothing else. A field added,
  renamed or dropped silently is a route module reading `None`.
* **The construction order.** A handler that captures a value decided AFTER it was
  defined reads a stale copy. The context is built before the first registration, and
  that is asserted against the source rather than trusted.
* **`public_https` is the one value a request must not take from the frozen copy.** It
  is assigned after `create_app()` returns -- `tests/test_web.py` does exactly that to
  prove the `__Host-` cookie is refused once the hop resolves https. Freezing the live
  read is the specific bug this file exists to catch before a route module ships it.
"""

from __future__ import annotations

import dataclasses

import pytest

from conftest import OWN_MODULE, call_sequence, source_through

pytest.importorskip("fastapi")

from houston.web.app import create_app  # noqa: E402
from houston.web.context import FIELDS, AppContext, live_public_https  # noqa: E402


def test_the_context_has_exactly_the_nine_declared_fields():
    """FIELDS is the contract the route modules are written against."""
    assert tuple(f.name for f in dataclasses.fields(AppContext)) == FIELDS
    assert len(FIELDS) == 9


def test_the_app_carries_the_context_and_it_is_frozen():
    app = create_app(allow_hosts=["rc.example.com"])
    ctx = app.state.ctx
    assert isinstance(ctx, AppContext)
    with pytest.raises(dataclasses.FrozenInstanceError):
        ctx.accounts = False


def test_every_field_agrees_with_what_the_app_actually_uses():
    """The context is not a second, parallel copy of the configuration."""
    app = create_app(allow_hosts=["rc.example.com"], accounts=False, public_https=True)
    ctx = app.state.ctx

    assert ctx.allowed == frozenset({"localhost", "127.0.0.1", "::1", "rc.example.com"})
    assert ctx.any_host is False
    assert ctx.csp.startswith("default-src 'self'")
    assert "form-action 'self'" in ctx.csp
    assert ctx.cookie_secure == "__Host-houston_session"
    assert ctx.cookie_name == "houston_session"
    # Identity, not equality: one registry per application, and a copy would mean
    # a job submitted through the context never appears in /api/jobs.
    assert ctx.jobs is app.state.jobs
    assert ctx.accounts is False and app.state.accounts is False
    assert ctx.public_https is True
    assert ctx.trust_proxy is app.state.trusted_proxies


def test_any_host_is_recorded_when_the_allow_list_is_a_star():
    ctx = create_app(allow_hosts=["*"]).state.ctx
    assert ctx.any_host is True


def test_the_context_is_built_before_the_first_handler_is_registered():
    """A handler defined before the context exists would capture a stale value.

    Asserted against the source because there is no runtime moment at which to
    observe it: by the time a request arrives every closure has already been made.
    The middleware registration counts as a handler and is checked by name, because
    it moved into `security.install()` and a marker list that quietly matched nothing
    would pass forever -- hence the non-vacuity assertion.
    """
    # THROUGH THE CALLS, not through two text offsets in one function. 2b.15 moved the
    # construction into `_configure_app`, and comparing offsets inside `create_app`
    # compares nothing once the two things live in different functions -- it reported
    # the context missing, which is the same sentence it would print if somebody had
    # deleted it.
    order = call_sequence(create_app, through=OWN_MODULE)
    assert "build" in order, "create_app no longer builds an AppContext at all"
    registrars = [m for m in ("install", "register_all") if m in order]
    assert registrars, "create_app registers nothing -- this walk would prove nothing"
    assert order.index("build") < min(order.index(m) for m in registrars), (
        "the AppContext is constructed after a handler is already registered")


def test_public_https_is_read_live_and_not_from_the_frozen_copy():
    """The frozen field records the build-time answer; the app carries the live one.

    `tests/test_web.py` flips `app.state.public_https` after construction to prove the
    prefixed cookie is refused over https. A route module that reads `ctx.public_https`
    for that decision would keep answering `False` and hand the plain-named cookie
    back over https -- which is the whole of what the `__Host-` prefix buys.
    """
    app = create_app(allow_hosts=["testserver"])
    assert app.state.ctx.public_https is False
    assert live_public_https(app) is False

    app.state.public_https = True
    assert live_public_https(app) is True
    # The frozen record does NOT follow, and that is the point of asserting it.
    assert app.state.ctx.public_https is False


def test_build_is_the_only_construction_site_create_app_uses():
    """`create_app` calls `context.build(...)` rather than filling the fields itself.

    Two construction sites is how the application and a test end up with contexts
    that differ in one field -- which is invisible until the field is the one a
    guard reads.
    """
    src = source_through(create_app)
    assert "context.build(" in src
    assert src.count("AppContext(") == 0, "create_app builds the object by hand"


def test_trust_proxy_is_the_same_list_the_application_state_holds():
    """Parsed ONCE. Two parses of one flag is two answers waiting to disagree."""
    app = create_app(trust_proxy=["10.0.0.0/8"])
    assert app.state.ctx.trust_proxy is app.state.trusted_proxies
    assert len(app.state.trusted_proxies) == 1


def test_the_trust_proxy_parsers_still_import_from_web_app():
    """They moved to context.py with the field they parse; `serve` still imports
    them from `houston.web.app`, and so does the suite.

    A re-export, not a copy: same function object, so there is nothing to drift.
    """
    from houston.web import app as webapp
    from houston.web import context as ctxmod

    for name in ("parse_trusted", "usable_trusted", "trusted_problems",
                 "_rightmost_untrusted"):
        assert getattr(webapp, name) is getattr(ctxmod, name), name


def test_the_csp_is_built_once_and_names_the_grafana_port():
    from houston import config
    from houston.web.context import content_security_policy

    csp = content_security_policy()
    assert f"frame-src 'self' http://localhost:{config.MONITOR_PORTS[1]}" in csp
    assert create_app().state.ctx.csp == csp
