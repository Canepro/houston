"""The only way in, and the only ways out: sign in, sign out, who am I, first run.

`POST /signin` is a real `<form method="post">` served by a real page, not a state
inside the SPA — `web/signin.py`'s docstring gives the three reasons. The JSON twin at
`POST /api/session` exists for scripts and for the SPA itself; both spend their
credential through `security.do_signin`, which is the one place scrypt is derived and
therefore the one place a per-address bound can be applied.

**First run is one step, deliberately.** Exchanging the key for a session and then
creating an account would mean a privileged session with no person behind it existing in
between, however briefly — which is the anonymous admin mode this whole design removes.
The key is only ever spent creating a named account, and only while `/setup` is open at
all: `serve` opens it on a loopback bind with no accounts, and never on a bind the
network can reach.
"""
from __future__ import annotations

from urllib.parse import quote

from fastapi import Body, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from houston.services import audit as auditsvc
from houston.services import sessions
from houston.web import security
from houston.web import signin as signin_page
from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name and the suite patches some of them -- but `register` is
#: the only thing anything outside this package may reach for, and a test walks the
#: imports to prove nothing does.
__all__ = ("register",)


# Which palette to render the SIGN-IN page in. Written by app.js, never by the
# server, and read only here: it decides a colour and nothing else, which is why
# it is not HttpOnly (a script has to set it) and why an unrecognised value is
# simply ignored rather than rejected. `prefers-color-scheme` in app.css covers
# the browser that has never had it.
THEME_COOKIE = "houston_theme"


def _first_run_open(request) -> bool:
    from houston.services import users as usersvc
    return request.app.state.first_run and not usersvc.any_users()


def setup_page(request: Request):
    if not _first_run_open(request):
        return JSONResponse({"error": "not found", "kind": "NotFoundError"},
                            status_code=404)
    return HTMLResponse(
        signin_page.setup_page(theme=request.cookies.get(THEME_COOKIE, "")))


def setup_script(request: Request):
    """The one script served to an unauthenticated caller, and it is ~40 lines.

    A key in the URL fragment can only be read by JavaScript -- that is the
    property that keeps it out of every server log. app.js is not opened for
    it: that file maps the whole API surface, and this needs two fields.
    """
    if not _first_run_open(request):
        return JSONResponse({"error": "not found", "kind": "NotFoundError"},
                            status_code=404)
    return HTMLResponse(signin_page.SETUP_JS, media_type="application/javascript")


def first_run(request: Request, body: dict = Body(...)):
    """Exchange the first-run key for the first admin account, in one step.

    Deliberately not two. A key-for-session exchange followed by an
    account-creation call would mean a privileged session with no account
    behind it existing in between, however briefly -- which is the anonymous
    admin mode this whole design removes. Here the key is only ever spent
    creating a named person.
    """
    from houston.services import firstrun as frsvc
    from houston.services import users as usersvc
    if not _first_run_open(request):
        return JSONResponse({"error": "this server already has accounts",
                             "kind": "ConflictError"}, status_code=409)
    source, https = _deps.peer(request)
    if security._signin_retry_after(source):
        return JSONResponse({"error": "too many attempts from this address",
                             "kind": "Unauthorized"}, status_code=429)
    if not frsvc.valid(str(body.get("key") or "")):
        security._signin_failed(source)
        return JSONResponse(
            {"error": "that setup link is wrong or has expired. Restart "
                      "`houston serve` for a fresh one.", "kind": "Unauthorized"},
            status_code=401)
    # Normalised before ANYTHING else uses it. `add()` would normalise on its
    # own, but the audit actor, and above all the session minted below, are
    # built from this variable -- so the raw form would sign the very first
    # admin in under a name that does not exist in the users file, and the
    # next request would bounce them back to a login they cannot pass.
    name = usersvc.normalize_name(str(body.get("user") or ""))
    password = str(body.get("password") or "")
    usersvc.require_valid_name(name)
    usersvc.require_valid_password(password)
    # Publish the identity BEFORE creating the account, so the `user-add` line
    # services/users.py writes carries this actor and origin. Without it the
    # very first line in a new box's log has no name against it -- which is
    # exactly the gap the origin column exists to close.
    auditsvc.set_actor(name)
    auditsvc.set_origin("setup")
    usersvc.add(name, password, role="admin")   # the first account must be one
    frsvc.consume()
    security._signin_ok(source)
    token = sessions.create(name, origin="setup",
                            label=sessions.describe_agent(
                                request.headers.get("user-agent", "")))
    auditsvc.audit(name, "first-run", "first account created",
                   origin_="setup", outcome="ok")
    resp = JSONResponse({"user": name, "role": "admin"})
    _deps.set_session_cookie(request, resp, token, https)
    return resp


def signin_form(request: Request, e: str = "", next: str = "/"):
    # Already signed in? Nobody needs to see this page. Straight through to
    # where they were going, so a stale /signin bookmark is not a dead end.
    if sessions.verify(request.cookies.get(_deps.cookie_name(request, _deps.peer(request)[1]), "")):
        return RedirectResponse(signin_page.safe_next(next), status_code=303)
    # The "not encrypted" warning is about the password crossing a NETWORK.
    # On a loopback connection it does not, so showing it there is a false
    # alarm on the most common install -- and a red banner that is wrong on a
    # laptop is how people learn to ignore red banners.
    addr, https = _deps.peer(request)
    local = addr in ("127.0.0.1", "::1", "localhost")
    html = signin_page.page(
        error=e, next_url=next,
        server=(request.headers.get("host") or "").split(":")[0],
        secure=https or local,
        retry_after=security._signin_retry_after(addr),
        theme=request.cookies.get(THEME_COOKIE, ""))
    return HTMLResponse(html, status_code=401 if e in ("bad", "rate") else 200)


def signin_submit(request: Request, user: str = Form(""),
                  password: str = Form(""), next: str = Form("/")):
    source, https = _deps.peer(request)
    token, err = security.do_signin(user, password, source,
                            request.headers.get("user-agent", ""))
    target = signin_page.safe_next(next)
    if err:
        # The name is deliberately NOT echoed back into the form. It would be
        # reflected input on an unauthenticated page, and the browser's own
        # autofill restores it anyway.
        return RedirectResponse(f"/signin?e={err}&next={quote(target, safe='/?=&')}",
                                status_code=303)
    # 303 so the POST is not in history and a refresh cannot resubmit it.
    resp = RedirectResponse(target, status_code=303)
    _deps.set_session_cookie(request, resp, token, https)
    return resp


def session_create(request: Request, body: dict = Body(default={})):
    """The JSON twin of POST /signin, for scripts and for the SPA."""
    source, https = _deps.peer(request)
    token, err = security.do_signin(str(body.get("user") or ""),
                            str(body.get("password") or ""), source,
                            request.headers.get("user-agent", ""))
    if err:
        detail = {"bad": "that name or password is not right",
                  "rate": "too many attempts from this address",
                  "nouser": "there are no accounts on this server yet"}[err]
        return JSONResponse({"error": detail, "kind": "Unauthorized"},
                            status_code=429 if err == "rate" else 401)
    sess = sessions.verify(token)
    resp = JSONResponse({"user": sess.user, "expires_at": sess.expires_at})
    _deps.set_session_cookie(request, resp, token, https)
    return resp


def session_whoami(request: Request):
    """Who am I. Replaces the `actor` field bolted onto /api/health, which
    only existed because there was nowhere else to ask."""
    from houston.services import users as usersvc
    sess = sessions.verify(request.cookies.get(_deps.cookie_name(request, _deps.peer(request)[1]), ""))
    if not sess:
        return {"user": "", "role": "", "accounts": bool(request.app.state.accounts)}
    return {"user": sess.user, "role": usersvc.role_of(sess.user),
            "accounts": True, "origin": sess.origin,
            "expires_at": sess.expires_at, "label": sess.label}


def session_end(request: Request):
    """Sign out — a logout that actually ends something on the server."""
    raw = request.cookies.get(_deps.cookie_name(request, _deps.peer(request)[1]), "")
    ended = sessions.revoke(raw) if raw else False
    resp = JSONResponse({"ok": True, "ended": ended})
    _deps.clear_session_cookie(request, resp)
    return resp


def signout_form(request: Request):
    raw = request.cookies.get(_deps.cookie_name(request, _deps.peer(request)[1]), "")
    if raw:
        sessions.revoke(raw)
    # No goodbye page: what you want next is to walk away or to sign back in,
    # and /signin?e=signedout is both, with the name field focused.
    resp = RedirectResponse("/signin?e=signedout", status_code=303)
    _deps.clear_session_cookie(request, resp)
    return resp


def sessions_list(request: Request):
    """Your own live sessions. The answer to "I signed in on the customer's
    laptop", which no cookie attribute gives you and which only exists
    because sessions are server-side."""
    sess = sessions.verify(request.cookies.get(_deps.cookie_name(request, _deps.peer(request)[1]), ""))
    if not sess:
        return {"sessions": []}
    here = sess.sid[:8]
    return {"sessions": [{**s.public(), "current": s.sid[:8] == here}
                         for s in sessions.list_for(sess.user)]}


def sessions_revoke(request: Request, all: bool = False, sid: str = ""):
    sess = sessions.verify(request.cookies.get(_deps.cookie_name(request, _deps.peer(request)[1]), ""))
    if not sess:
        return JSONResponse({"error": "not signed in", "kind": "Unauthorized"},
                            status_code=401)
    if all:
        n = sessions.revoke_user(sess.user)
        resp = JSONResponse({"ok": True, "ended": n})
        _deps.clear_session_cookie(request, resp)
        return resp
    # By sid PREFIX, because that is all the listing hands out -- the full
    # value is a verifier and a page that shows it gives away every session
    # it lists. Scoped to your own sessions, so a prefix collision with
    # somebody else's cannot revoke theirs.
    target = next((s for s in sessions.list_for(sess.user)
                   if s.sid[:8] == sid), None)
    if not target:
        return JSONResponse({"error": "no such session", "kind": "NotFoundError"},
                            status_code=404)
    # THE ANSWER IS READ. `revoke_sid` returns False when the sid was not in the
    # store, and this reported `{"ok": true, "ended": 1}` regardless -- so a
    # sign-out that revoked nothing looked like one that worked. Reachable as a
    # race: the session can expire between `list_for` above and this line.
    if not sessions.revoke_sid(target.sid):
        return JSONResponse(
            {"error": "that session had already ended", "kind": "NotFoundError"},
            status_code=404)
    return {"ok": True, "ended": 1}


ROUTES = (
    ("get", "/setup", setup_page),
    ("get", "/setup.js", setup_script),
    ("post", "/api/session/first-run", first_run),
    ("get", "/signin", signin_form),
    ("post", "/signin", signin_submit),
    ("post", "/api/session", session_create),
    ("get", "/api/session", session_whoami),
    ("delete", "/api/session", session_end),
    ("post", "/signout", signout_form),
    ("get", "/api/sessions", sessions_list),
    ("delete", "/api/sessions", sessions_revoke),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
