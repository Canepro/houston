"""The guard chain: what a request must prove before a handler ever sees it.

Everything security-load-bearing about `web/app.py` that is not a handler lives here:
the authorisation table, the middleware that reads it, the Host and cross-site checks,
the peer/scheme resolution those depend on, and the two limiters that bound what an
unauthenticated caller can spend.

**`ROUTE_ROLES` stays in the WEB layer, deliberately.** It is tempting to push it down
into `services/` so the CLI is covered by the same table. That would be a privilege
escalation, not a tightening: the CLI reaches the same service functions and
`_cli_actor` honours `HOUSTON_USER` exactly as given, so a service-layer role check
would make `HOUSTON_USER=<any admin>` a one-word bypass of the whole table. The web
layer is the only place where the identity is one the server established itself.

**DEFAULT DENY.** A route absent from the table is refused at runtime, and an invariant
test walks `app.routes` to prove none is unlisted. An endpoint shipping unguarded is
structurally the same mistake as the audit gap — added in one place, not registered in
the other.

**Why these are functions taking `ctx` rather than closures.** They were nested inside
`create_app()` and captured its locals. Eleven route modules now need the same checks,
and a closure does not cross a module boundary — so the configuration arrives as the
frozen `AppContext` and the live application as `app`. The split is not cosmetic: `app`
is passed only where a value must be read LIVE (`app.state.public_https`, which a test
assigns after the app is built, and `app.router.routes`, which grows as modules
register). Everything else comes off the frozen context.
"""
from __future__ import annotations

import ipaddress
import threading
import time
from urllib.parse import quote

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.routing import Match

from houston.services import audit as auditsvc
from houston.services import sessions
from houston.web import jobs as jobs_mod
from houston.web.context import AppContext, _rightmost_untrusted


# Failed sign-ins per client address, for the one endpoint that derives scrypt.
# This is where a guessing bound BELONGS: services/users.py cannot refuse on a
# counter without refusing correct passwords too (that was B2), but a login
# endpoint can refuse to spend the CPU at all. Keyed on the address, so nobody can
# throttle a colleague by guessing at their name.
SIGNIN_MAX_FAILURES = 10
SIGNIN_WINDOW = 60.0
#: How many client addresses the throttle remembers. Process memory only, and that
#: is a real limit: a restart forgets every accumulated failure. Bounded so an
#: address-varying flood cannot grow it without limit -- see `_signin_failed`, which
#: evicts oldest-first rather than clearing the whole map.
_SIGNIN_MAX_KEYS = 4096
_signin_fails: dict[str, list[float]] = {}
_signin_lock = threading.Lock()

#: How often one client address may put a PRE-AUTHENTICATION refusal in the audit
#: log for the same reason. The WebSocket Host and Origin checks run before any
#: credential is read, so an unauthenticated caller could write a line per request
#: with a ~200-byte name of their choosing -- and audit.log rotates at 32 MB with 5
#: kept, so a sustained flood pushes genuine `signin` and `denied` evidence off the
#: end. `audit._field` already makes the CONTENT unforgeable; this bounds the
#: VOLUME, which was the other half.
PREAUTH_AUDIT_WINDOW = 60.0
_preauth_seen: dict[tuple[str, str], float] = {}
_preauth_lock = threading.Lock()


def _preauth_should_audit(source: str, why: str) -> bool:
    """Whether this pre-auth refusal is the first from `source` for `why` this window.

    Coalescing rather than dropping: the first refusal of each kind from each address
    is always recorded, so the evidence that something is probing survives -- what is
    discarded is the thousandth identical copy of it.
    """
    now = time.monotonic()
    key = (source, why)
    with _preauth_lock:
        last = _preauth_seen.get(key, 0.0)
        if last and now - last < PREAUTH_AUDIT_WINDOW:
            return False
        if len(_preauth_seen) > _SIGNIN_MAX_KEYS:
            for k in [k for k, seen in _preauth_seen.items()
                      if now - seen > PREAUTH_AUDIT_WINDOW]:
                del _preauth_seen[k]
        _preauth_seen[key] = now
        return True


def _signin_retry_after(source: str) -> int:
    """Seconds this address must wait, or 0. Sliding window, so it recovers."""
    now = time.monotonic()
    with _signin_lock:
        hits = [t for t in _signin_fails.get(source, []) if now - t < SIGNIN_WINDOW]
        _signin_fails[source] = hits
        if len(hits) < SIGNIN_MAX_FAILURES:
            return 0
        return max(1, int(SIGNIN_WINDOW - (now - hits[0])) + 1)


def _signin_failed(source: str) -> None:
    now = time.monotonic()
    with _signin_lock:
        # Bounded: an address-varying flood must not grow this without limit. It used
        # to `.clear()` WHOLESALE at the limit, which handed the flood a way to erase
        # the counter it was tripping -- 4096 requests from throwaway addresses reset
        # every accumulated failure on the box, including the ones bounding a real
        # attempt against a real account. Evicted oldest-first instead, so pressure
        # costs the least recently active entries and never the active one.
        if len(_signin_fails) > _SIGNIN_MAX_KEYS:
            # Entries whose newest failure has aged out of the window carry no
            # information at all, so they go first.
            for key in [k for k, hits in _signin_fails.items()
                        if not hits or now - hits[-1] > SIGNIN_WINDOW]:
                del _signin_fails[key]
            # Still over: drop the least recently active, keeping the newest half.
            if len(_signin_fails) > _SIGNIN_MAX_KEYS:
                for key in sorted(_signin_fails,
                                  key=lambda k: _signin_fails[k][-1]
                                  )[:len(_signin_fails) - _SIGNIN_MAX_KEYS // 2]:
                    del _signin_fails[key]
        _signin_fails.setdefault(source, []).append(now)


def _signin_ok(source: str) -> None:
    """Forget this address's failures after a SUCCESSFUL sign-in.

    It used to `pop` the whole window, so one valid low-privilege credential reset the
    throttle between guessing rounds from the same address: sign in as the readonly
    account, and the next batch of attempts against an admin name starts from zero. The
    bound is per address by design (see the comment above), so the reset has to be too
    -- but a reset earned by knowing ONE password should not buy an unbounded number of
    guesses at another.
    Half the window is dropped instead: a legitimate user who mistyped once and then
    succeeded is unaffected, and a caller working through a list still accumulates.
    """
    with _signin_lock:
        seen = _signin_fails.get(source)
        if not seen:
            return
        if len(seen) <= 1:
            _signin_fails.pop(source, None)
        else:
            _signin_fails[source] = seen[len(seen) // 2:]



# The minimum role for every route, by (method, route template). Three rules make
# this the whole of the authorization story rather than a checklist that drifts:
#
#   * DEFAULT DENY. A route missing from this table is admin-only at runtime, and
#     a test walks app.routes and fails the build if any /api/ route is unlisted.
#     An endpoint shipping unguarded is structurally the same mistake as the audit
#     gap -- something added in one place and not registered in the other.
#   * It lives in the WEB layer, deliberately, not in the service layer. The CLI
#     reaches the same service functions and `_cli_actor` honours HOUSTON_USER as
#     given (cli.py:132), so a service-layer check would make `HOUSTON_USER=<any
#     admin>` a one-word escalation -- a boundary that is not one.
#   * Reads are readonly+, writes are member+, and people-management is admin.
#     The exceptions are the reads that are not really reads: logs, the effective
#     environment, a minted PAT and an arbitrary REST call all hand over
#     credentials, so they are member+.
#
#   "" (empty) marks a route reachable with no session at all -- see `open_path`.
_OPEN, _READ, _WRITE, _ADMIN = "", "readonly", "member", "admin"

ROUTE_ROLES: dict[tuple[str, str], str] = {
    # the login itself, and the uptime check
    ("GET", "/signin"): _OPEN, ("POST", "/signin"): _OPEN,
    ("POST", "/signout"): _OPEN,
    ("GET", "/api/health"): _OPEN,
    ("GET", "/api/session"): _OPEN, ("POST", "/api/session"): _OPEN,
    ("DELETE", "/api/session"): _OPEN,
    # your own sessions
    ("GET", "/api/sessions"): _READ, ("DELETE", "/api/sessions"): _READ,
    # looking
    ("GET", "/api/repros"): _READ,
    ("GET", "/api/repros/{name}"): _READ,
    ("GET", "/api/repros/{name}/detail"): _READ,
    ("GET", "/api/repros/{name}/stats"): _READ,
    ("GET", "/api/repros/{name}/tls"): _READ,
    ("GET", "/api/repros/{name}/upgrade"): _READ,
    ("GET", "/api/jobs"): _READ,
    ("GET", "/api/jobs/{job_id}"): _READ,
    ("GET", "/api/jobs/{job_id}/stream"): _READ,
    ("GET", "/api/backups"): _READ,
    ("POST", "/api/backups/compatibility"): _READ,   # a question, not a change
    ("GET", "/api/doctor"): _READ,
    ("GET", "/api/edge"): _READ,
    # Destructive, and irreversibly so: it deletes a private key. Admin for the
    # same reason people-management is -- a member can create and destroy their
    # own workspaces, but the box's shared front door is not theirs to edit.
    ("DELETE", "/api/edge/hosts/{host}"): _ADMIN,
    ("GET", "/api/kubernetes"): _READ,
    # THE CLUSTER LEDGER. Reads, and readonly+ like every other read -- a report whose
    # job is to stop a cluster being forgotten works better the more people can see it,
    # and hiding the bill from everyone who is not an admin is how a bill runs.
    ("GET", "/api/clusters"): _READ,
    ("GET", "/api/clusters/status"): _READ,
    ("GET", "/api/clusters/iam-policy"): _READ,
    # The region sweep asks AWS rather than a cluster, and it only ever lists. It is a
    # job because it is twenty seconds of round trips, not because it changes anything.
    ("POST", "/api/clusters/sweep"): _READ,
    # `prepare` CHANGES a cluster -- it installs a StorageClass, an ingress controller
    # and cert-manager -- so it is a write like any other. It costs nothing and is
    # idempotent, which is why it is not admin.
    ("POST", "/api/clusters/prepare"): _WRITE,
    # ADMIN, and neither of these is people-management. `create` spends real money for
    # as long as nobody remembers to remove it, and `delete` destroys a cluster that
    # may hold colleagues' work on boxes this one has never seen. The rule this repo
    # already applies to the shared edge -- "a member can create and destroy their own
    # workspaces, but the box's shared front door is not theirs to edit" -- is the same
    # rule, and a cluster is a good deal more shared than the edge.
    ("POST", "/api/clusters/create"): _ADMIN,
    ("POST", "/api/clusters/delete"): _ADMIN,
    # Clearing a kubeconfig entry destroys nothing, but it takes a name off this
    # box and the write-vs-read line here is about changing state, not about risk.
    ("POST", "/api/clusters/forget"): _WRITE,
    ("GET", "/api/machine"): _READ,
    ("GET", "/api/presets"): _READ,
    ("GET", "/api/settings"): _READ,
    ("GET", "/api/versions/{version}"): _READ,
    # reads that hand over credentials -- see the note above
    ("GET", "/api/repros/{name}/logs"): _WRITE,
    # "WS" IS THE SPECIAL CASE, and it is spelled out rather than inferred. It is
    # not an HTTP method: a WebSocket handshake never reaches `guard`, so this row is
    # consulted by `logs_stream` itself, and the invariant walk in tests/test_web.py
    # substitutes "WS" for the empty method set a WebSocketRoute reports. The pairing
    # of ("WS", <path>) here with ("WS", <path>) there is the whole of what makes the
    # one endpoint that streams LDAP bind passwords covered by this table at all.
    ("WS", "/api/repros/{name}/logs/stream"): _WRITE,
    ("GET", "/api/repros/{name}/env"): _WRITE,
    # changing a workspace
    ("POST", "/api/repros"): _WRITE,
    ("POST", "/api/repros/{name}/up"): _WRITE,
    ("POST", "/api/repros/{name}/state"): _WRITE,
    ("POST", "/api/repros/{name}/ready"): _WRITE,
    ("POST", "/api/repros/{name}/seed"): _WRITE,
    ("POST", "/api/repros/{name}/scale"): _WRITE,
    ("DELETE", "/api/repros/{name}/scale"): _WRITE,
    ("POST", "/api/repros/{name}/env"): _WRITE,
    ("POST", "/api/repros/{name}/monitor"): _WRITE,
    ("POST", "/api/repros/{name}/default"): _WRITE,
    ("POST", "/api/repros/{name}/owner"): _WRITE,
    ("POST", "/api/repros/{name}/config-import"): _WRITE,
    ("POST", "/api/repros/{name}/config-import/plan"): _WRITE,
    ("POST", "/api/repros/{name}/backup"): _WRITE,
    ("POST", "/api/repros/{name}/upgrade"): _WRITE,
    ("POST", "/api/repros/{name}/upgrade/rollback"): _WRITE,
    ("POST", "/api/repros/{name}/loadtest"): _WRITE,
    ("POST", "/api/repros/{name}/capacity"): _WRITE,
    ("POST", "/api/restore"): _WRITE,
    ("POST", "/api/repros/{name}/pat"): _WRITE,
    ("POST", "/api/repros/{name}/call"): _WRITE,
    ("DELETE", "/api/repros/{name}"): _WRITE,   # ownership is checked in the handler
    ("POST", "/api/prune"): _WRITE,
    ("DELETE", "/api/backups"): _WRITE,
    # people
    ("GET", "/api/users"): _ADMIN,
    ("POST", "/api/users"): _ADMIN,
    ("DELETE", "/api/users/{name}"): _ADMIN,
    ("POST", "/api/users/{name}/role"): _ADMIN,
    ("POST", "/api/users/{name}/password"): _ADMIN,
    ("POST", "/api/me/password"): _READ,        # your own, whoever you are
    # readonly+ : the handler forces non-admins to their OWN lines, so the
    # role gate here is "signed in", not "may see everyone".
    ("GET", "/api/audit"): _READ,
    # first run: reachable only while there are no accounts at all
    ("GET", "/setup"): _OPEN, ("GET", "/setup.js"): _OPEN,
    ("POST", "/api/session/first-run"): _OPEN,
}



def route_requirement(method: str, template: str) -> str | None:
    """The minimum role for a route, or None when it is not in the table.

    None means DENY -- returned rather than defaulted so the caller can tell
    "admin only" apart from "nobody registered this", and log the difference.

    `("WS", "")` and `("GET", "")` both land here as None, which is correct and is
    load-bearing: `matched_template` returns "" when nothing matched, so an unrouted
    path is refused by the same rule as an unregistered one rather than by a separate
    branch that could be forgotten.
    """
    return ROUTE_ROLES.get((method.upper(), template))


def hostname(hdr: str | None) -> str:
    """A Host header's bare hostname: port stripped, lowercased.

    Handles bracketed IPv6 ("[::1]:7070" -> "::1"), which a plain
    split(":") would mangle to "[" — making the "::1" entry unmatchable.
    """
    h = (hdr or "").strip()
    if h.startswith("["):
        return h[1:].split("]", 1)[0].lower()
    return h.split(":", 1)[0].lower()


def host_ok(ctx: AppContext, hdr: str | None) -> bool:
    # A missing/empty Host is rejected rather than allowed: "" must not be a
    # member of the allow-list, or any Host-less request slips past it.
    return ctx.any_host or hostname(hdr) in ctx.allowed


def origin_ok(ctx: AppContext, hdr: str | None,
              host_hdr: str | None = None) -> bool:
    """Whether an ORIGIN is ours. Deliberately NOT `host_ok`.

    These are two different questions and `*` answered them differently.
    `--allow-host '*'` is documented as widening the HOST allow-list -- "answer
    to whatever name reaches you", which is what a proxy in front of `serve`
    needs. Resolving Origin through the same closure made `*` mean "trust any
    origin" too, silently disabling the cross-site guard whose docstring records
    a confirmed attack: a forged `Origin: https://evil.example` that streamed a
    workspace's container log, LDAP bind passwords and all.

    The test is the actual definition of same-origin: the Origin's host equals
    the HOST THIS REQUEST WAS MADE TO. That keeps `*` working for the case it
    exists for -- the SPA served from whatever name the proxy uses posts to that
    same name -- while a forged Origin still fails, because it names a host the
    request was not addressed to. Simply requiring membership of the allow-list
    would have broken sign-in entirely under `*`, which is the wrong trade: the
    wildcard's whole point is that the name is not known in advance.

    A NAMED entry also counts on its own, for the proxy that rewrites Host to an
    internal name while the browser still sends the external one.
    """
    origin_host = hostname(hdr)
    if not origin_host:
        return False
    return origin_host in ctx.allowed or origin_host == hostname(host_hdr)


def cross_site(ctx: AppContext, headers, *,
               require_origin: bool = False) -> bool:
    """Whether this request was made from another site.

    ONE implementation, because the duplication was the defect. `guard` had
    this check and the WebSocket handler re-implemented the Host and
    credential checks around it while omitting this one -- and a WebSocket
    handshake is exempt from CORS, so the browser makes it cross-origin and
    attaches the cached credential itself. Confirmed before this existed: a
    forged `Origin: https://evil.example` was refused 403 on a POST and
    ACCEPTED on `/api/repros/{name}/logs/stream`, which then streamed the
    workspace's container log -- where LDAP bind passwords and OAuth client
    secrets live.

    `require_origin` is for the WebSocket handshake alone. There an absent
    `Origin` cannot be read as "same-origin", because the browser always
    sends one on a WS upgrade; anything without it is a non-browser client.
    It must NOT be set for SSE: a same-origin `EventSource` sends no `Origin`
    at all, so requiring one would refuse the SPA's own job stream. SSE is
    covered instead by being subject to CORS, plus `Sec-Fetch-Site` below.
    """
    site = headers.get("sec-fetch-site", "")
    if site:
        # AUTHORITATIVE when present. The browser sets it, it is a forbidden
        # header name so page script cannot forge it, and it answers exactly
        # the question being asked. Consulting `Origin` as well -- which the
        # first version did -- broke the sign-in form in every real browser:
        # a same-origin form POST from a page served with
        # `Referrer-Policy: no-referrer` arrives as
        #     Sec-Fetch-Site: same-origin
        #     Origin: null
        # and "null" is not a host in the allow-list, so the login was
        # refused as cross-site. Caught only once a browser drove it; every
        # HTTP test passed, because TestClient sends neither header.
        return site not in ("same-origin", "none")
    origin = headers.get("origin", "")
    # No Sec-Fetch-Site. NOT only a non-browser client or an old browser, which
    # is what this said while the sign-in form on every --insecure box 403'd: a
    # current browser omits `Sec-Fetch-*` for any URL that is not "potentially
    # trustworthy", and plain http on a real hostname is not (localhost is,
    # which is why nothing local ever reproduced it). So this branch IS the
    # browser path whenever the GUI is served over http off-loopback, and the
    # `Origin` it carries has to be a real one -- see the Referrer-Policy note
    # in `guard`, which is what makes sure it is.
    #
    # A literal "null" is still an opaque origin -- a sandboxed iframe, a data:
    # URL -- unmatchable against the allow-list, so it still counts as cross.
    if origin:
        if origin == "null":
            return True
        return not origin_ok(ctx, origin.split("://", 1)[-1],
                                 headers.get("host"))
    return require_origin


def resolve_peer(app, scope_headers, peer: str) -> tuple[str, bool]:
    """(client address, is the BROWSER's hop https).

    One decision, three consumers -- the cookie's Secure flag and prefix, the
    sign-in page's transport warning, and the sign-in throttle key. Deriving
    them independently is how a misconfigured proxy ends up minting a cookie
    the browser then sends in clear.

    X-Forwarded-* is believed ONLY from a peer inside --trust-proxy. From
    anyone else both headers are ignored entirely, because a client that can
    choose its own address can dodge the throttle, and a client that can
    choose the scheme can turn Secure off.
    """
    https = bool(app.state.public_https)
    trusted = app.state.trusted_proxies
    if trusted and peer:
        try:
            addr = ipaddress.ip_address(peer)
        except ValueError:
            return peer, https
        if any(addr in net for net in trusted):
            fwd = scope_headers.get("x-forwarded-for", "")
            if fwd:
                # THE RIGHTMOST UNTRUSTED HOP, not the leftmost. An appending
                # proxy adds the peer it saw to the END of whatever the client
                # sent, so the LEFT of the list is attacker-written: rotating a
                # fake leftmost value gave every request its own throttle key and
                # the sign-in bound never applied. Walking from the right past
                # the hops we trust yields the first address no proxy of ours
                # vouched for, which is the client as far as this box can know.
                peer = _rightmost_untrusted(fwd, trusted) or peer
            proto = scope_headers.get("x-forwarded-proto", "")
            if proto:
                https = proto.split(",")[0].strip().lower() == "https"
    return peer, https

def peer_of(app, request: Request) -> tuple[str, bool]:
    """`resolve_peer` for an HTTP request: (client address, is the browser's hop https).

    One helper rather than the two-line expression repeated at every call site, because
    getting `request.client` wrong when it is None is a crash on a route nobody tests
    with a missing peer.
    """
    return resolve_peer(app, request.headers,
                        request.client.host if request.client else "")


def cookie_name(app, ctx: AppContext, https: bool | None = None) -> str:
    secure = app.state.public_https if https is None else https
    return ctx.cookie_secure if secure else ctx.cookie_name


# --- minting and revoking the session itself -----------------------------------
# These three sit here rather than beside the handlers that call them because they are
# the same subject as everything above: `do_signin` is the ONE place scrypt is derived,
# which is what makes the per-address bound at the top of this file possible at all --
# one endpoint to throttle instead of every door re-deriving whatever it was handed.
# And the two cookie writers decide `Secure` and the `__Host-` prefix, which is a
# security attribute and not a detail of the route that happens to set it.


def set_session_cookie(app, ctx: AppContext, response, token: str,
                       https: bool | None = None) -> None:
    secure = bool(app.state.public_https if https is None else https)
    response.set_cookie(
        cookie_name(app, ctx, secure), token,
        max_age=sessions.ABSOLUTE_SECONDS, path="/", httponly=True,
        secure=secure,
        # Lax, not Strict: pasting a workspace link into chat and following it
        # is the support workflow, and Strict blanks the first load. Lax still
        # withholds the cookie from cross-site POSTs and from subresource
        # requests, which includes the WebSocket and EventSource handshakes.
        samesite="lax")


def clear_session_cookie(ctx: AppContext, response) -> None:
    # Both names, so switching a box between http and https cannot strand a
    # cookie the new scheme will not overwrite.
    for name in (ctx.cookie_secure, ctx.cookie_name):
        response.delete_cookie(name, path="/")


def do_signin(user: str, password: str, source: str, agent: str):
    """Shared by the form post and the JSON twin. Returns (token, error).

    scrypt runs HERE and nowhere else, which is what makes a guessing bound
    possible at all: one endpoint to throttle, instead of every door in the
    app re-deriving whatever Authorization header it was handed.
    """
    from houston.services import users as usersvc

    if not usersvc.any_users():
        return "", "nouser"
    if _signin_retry_after(source):
        return "", "rate"
    if not usersvc.verify(user, password, source=source):
        _signin_failed(source)
        return "", "bad"
    _signin_ok(source)
    # The session carries the STORED name, not the one that was typed. verify()
    # accepts either, so `lucy.felix` signs in to the `lucy-felix` account --
    # and a session filed under `lucy.felix` then belongs to an account that
    # does not exist by that name. Two things break, one of them quietly:
    # `sessions.revoke_user()` is called with the stored name by
    # users.set_password() and users.remove(), so a dotted account's live
    # sessions SURVIVED a password reset -- the one guarantee set_password
    # exists to make -- and the audit trail spelled the same person two ways.
    # Found in a browser, where the top bar read `lucy.felix` next to a People
    # row reading `lucy-felix`.
    return (sessions.create(usersvc.normalize_name(user),
                            label=sessions.describe_agent(agent)), "")


def matched_template(app, scope) -> str:
    """The route TEMPLATE this request will dispatch to, e.g.
    "/api/repros/{name}".

    Resolved by asking Starlette's own matcher rather than by keeping a second
    regex table beside ROUTE_ROLES: two independent ways of deciding which
    route a path belongs to is precisely the drift the table exists to stop.
    Needed because middleware runs BEFORE the router, so scope["route"] does
    not exist yet.
    """
    for route in app.router.routes:
        if route.matches(scope)[0] is Match.FULL:
            return getattr(route, "path", "")
    return ""

async def _answer_with_security_headers(call_next, ctx, path, request):
    """Call the route, then put the headers on it that every answer carries."""
    return _with_security_headers(await call_next(request), ctx, path)


def _with_security_headers(response, ctx, path):
    """The headers every answer carries -- the guard's own refusals included.

    They were added only to answers that reached a route, so the 401, 403 and 303
    the guard answers with itself went out bare: no CSP, no nosniff, no Referrer-Policy
    on exactly the responses an unauthenticated caller sees.
    """
    response.headers.setdefault("Content-Security-Policy", ctx.csp)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # StaticFiles sends ETag + Last-Modified but no Cache-Control, and with no
    # freshness directive a browser is free to reuse a cached copy WITHOUT
    # revalidating (heuristic freshness, RFC 9111 4.2.2). After upgrading
    # houston that means the old app.js/app.css keep being used and the new UI
    # simply is not there -- indistinguishable from a missing feature, and only
    # fixable with a hard refresh nobody should have to know about.
    # `no-cache` means "revalidate first", not "don't store": the ETag still
    # answers 304, so this costs a conditional request, not a re-download.
    if not path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    # `same-origin`, not `no-referrer`. The reason for suppressing the Referer
    # is unchanged and still met: the first-run key rides in a FRAGMENT, which
    # no policy ever copies into a Referer, and `same-origin` sends nothing at
    # all to another origin -- so no outbound link carries anything about this
    # one either.
    #
    # What `no-referrer` ALSO did was null the `Origin` header on this page's
    # own form POST: per Fetch, the Origin of a non-CORS POST follows the
    # referrer policy, so a same-origin sign-in arrived as `Origin: null`. That
    # is survivable while `Sec-Fetch-Site` is there to appeal to -- but a
    # browser omits `Sec-Fetch-*` entirely for a URL that is not "potentially
    # trustworthy", and plain http on a real hostname is not. On an --insecure
    # box the guard therefore saw a bare `Origin: null`, could not match it
    # against the allow-list, and refused every sign-in and every SPA write as
    # cross-site. `http://localhost` IS potentially trustworthy, which is
    # exactly why the suite and every local run missed it.
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def _role_refusal(actor: str, need, request: Request, template: str):
    """The role table applied to one API call: a 403, or None to carry on."""
    from houston.services import users as usersvc
    role = usersvc.role_of(actor)      # live, never from the session
    if need is None:
        # The REQUESTED PATH when no route matched. `template` is ""
        # exactly then, so the line read `GET  (no role declared)` and
        # an operator reading audit.log could not tell which route had
        # been refused -- which is the one thing that line exists to say.
        where = template or (request.url.path or "?")
        auditsvc.audit(actor, "denied", f"{request.method} {where} "
                       "(no role declared)", origin_="session",
                       outcome="denied")
        return JSONResponse(
            {"error": f"{request.method} {template} declares no minimum "
                      "role, so it is refused (see ROUTE_ROLES)",
             "kind": "Forbidden"}, status_code=403)
    if not usersvc.at_least(role, need):
        # Recorded, because "is readonly drawn in the right place?" is
        # an open question in the design and `grep denied` is the
        # evidence to settle it with -- opinion is not.
        auditsvc.audit(actor, "denied",
                       f"{request.method} {template} needs {need}",
                       origin_="session", outcome="denied")
        return JSONResponse(
            {"error": f"this needs the {need!r} role; you are {role!r}",
             "kind": "Forbidden"}, status_code=403)
    return None


async def _authorise(app, ctx: AppContext, request: Request, path: str):
    """Refuse the request, or say who is making it.

    Two answers in one, because in a middleware a `return` is an ANSWER: the
    response that ends the request here, or the actor for the one that goes on.
    A helper that could only do the second would have to be inlined at every
    refusal, which is the shape this was in.
    """
    template = matched_template(app, request.scope)
    need = route_requirement(request.method, template)
    # `""` in the table means "reachable with no session". /app.css is
    # open too, or the sign-in page is an unstyled wall of text.
    open_path = need == _OPEN or path == "/app.css"
    _addr, _https = peer_of(app, request)
    sess = sessions.verify(request.cookies.get(cookie_name(app, ctx, _https), ""))
    actor = sess.user if sess else ""
    if actor and path.startswith("/api/") and not open_path:
        denied = _role_refusal(actor, need, request, template)
        if denied is not None:
            return denied, ""
    if not open_path and not actor:
        # An API caller gets a machine-readable 401 it can act on; a
        # BROWSER gets sent to the page that fixes the problem, carrying
        # where it was going. Answering an HTML navigation with JSON is
        # how the old design ended up with no login screen at all.
        if path.startswith("/api/"):
            return JSONResponse(
                {"error": "sign in to use houston", "kind": "Unauthorized"},
                status_code=401), ""
        nxt = request.url.path
        if request.url.query:
            nxt += "?" + request.url.query
        return RedirectResponse(
            f"/signin?e=required&next={quote(nxt, safe='/?=&')}",
            status_code=303), ""
    return None, actor


async def guard(app, ctx: AppContext, request: Request, call_next):
    if not host_ok(ctx, request.headers.get("host")):
        # Name the Host that was refused, and the exact flag that would admit
        # it. "host not allowed (use serve --allow-host)" left the reader to
        # guess WHICH name to add, which is the whole of the fix -- and the
        # value is right there in the request. Truncated and quoted with !r
        # because it is attacker-supplied; this is a JSON body served with
        # nosniff, so it cannot become markup, but it should not be unbounded.
        refused = (request.headers.get("host") or "")[:120]
        return _with_security_headers(JSONResponse(
            {"error": f"host not allowed: {refused!r} is not in the allow-list. "
                      f"Restart with `--allow-host {refused.split(':')[0]}` "
                      "(or '*' for any host).",
             "kind": "Forbidden"}, status_code=403), ctx, request.url.path)
    path = request.url.path
    # Cross-site request. In TOKEN mode the unguessable ?t= doubles as a CSRF
    # token, but a Basic credential is attached by the BROWSER on every
    # request and `Host:` is whatever this server answers to -- so the host
    # allow-list waves a forged request straight through, and Basic is not a
    # cookie so SameSite never applies. Confirmed reachable: a body-less POST
    # to /upgrade/rollback (which drops the database) from any origin.
    #
    # Every /api/ path, not just the state-changing methods it used to cover.
    # A cross-site READ of /api/repros/{name}/logs hands over LDAP bind
    # passwords and OAuth secrets, so it was never the milder case. The SPA
    # itself is same-origin; non-browser clients (curl, CI) send neither
    # header and are unaffected, so nothing scripted changes.
    if request.method not in ("GET", "HEAD", "OPTIONS") or path.startswith("/api/"):
        if cross_site(ctx, request.headers):
            return _with_security_headers(JSONResponse(
                {"error": "cross-site request refused", "kind": "Forbidden"},
                status_code=403), ctx, path)
    actor = ""
    if app.state.accounts:
        refused, actor = await _authorise(app, ctx, request, path)
        if refused is not None:
            return _with_security_headers(refused, ctx, path)
    # Who did this, for job attribution. Every action now has a name behind
    # it -- the shared secret that could not say is gone. A contextvar rather than fifteen
    # extra handler parameters; it propagates into the threadpool where every
    # `def` handler runs.
    request.state.actor = actor
    jobs_mod.CURRENT_ACTOR.set(actor)
    # How that identity was established, so the log can say which of its lines
    # are evidence. "session" only when a real credential was checked.
    auditsvc.set_origin("session" if actor else "")
    return await _answer_with_security_headers(call_next, ctx, path, request)


def install(app, ctx: AppContext) -> None:
    """Register the guard middleware, and publish the three checks on `app.state`.

    The state entries are not decoration: `logs_stream` is a WebSocket, which never
    passes through HTTP middleware, so it re-runs these checks itself — and the
    invariant test asserts it calls the SHARED ones rather than a second, shorter copy
    of the list. That second copy is how the Origin check went missing on the one
    endpoint that streams LDAP bind passwords.
    """
    app.state.host_ok = lambda hdr: host_ok(ctx, hdr)
    app.state.origin_ok = lambda hdr, host_hdr=None: origin_ok(ctx, hdr, host_hdr)
    app.state.cross_site = lambda headers, *, require_origin=False: cross_site(
        ctx, headers, require_origin=require_origin)

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        # A thin adapter, not a second implementation: `guard` is module-level so it
        # is 137 lines with a name of its own rather than 137 lines inside whatever
        # registered it, and so a test can drive it without building an application.
        return await guard(app, ctx, request, call_next)
