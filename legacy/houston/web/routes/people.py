"""Accounts, roles, and the record of who did what.

Admin-only, with two deliberate exceptions that are not people-management at all:
`POST /api/me/password` is your own password whoever you are, and `GET /api/audit` is
readonly+ because the handler forces a non-admin to their OWN lines — the role gate
there means "signed in", not "may see everyone".

Changing your own password is throttled like the login, because it is one: it verifies
the current password, which derives scrypt, so it is a second door onto the same cost
and would otherwise be an unthrottled oracle for a credential the caller already partly
has.
"""
from __future__ import annotations

from fastapi import Body, Request
from fastapi.responses import JSONResponse

from houston.errors import ValidationError
from houston.services import audit as auditsvc
from houston.services import sessions
from houston.web import security
from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name -- but `register` is the only thing anything outside this
#: package may reach for, and a test walks the imports to prove nothing does.
__all__ = ("register",)


# The password generator lives in services/users.py, not here: `houston users add`
# mints them too, and two definitions of "a password houston generated" is how the
# two front ends quietly drift apart on the one value that decides whether an
# account is guessable.
def users_list():
    from houston.services import users as usersvc
    rows = []
    for u in usersvc.list_users():
        live = sessions.list_for(u.name)
        rows.append({"name": u.name, "role": usersvc.role_of(u.name),
                     "implicit": not u.role, "created_at": u.created_at,
                     "sessions": len(live),
                     "last_seen": max((s.last_seen for s in live), default=0)})
    return {"users": rows, "roles": list(usersvc.ROLES),
            "implicit_admins": usersvc.implicit_admins()}


def users_add(body: dict = Body(...)):
    """Create an account. The SERVER mints the password and returns it once.

    An admin who types a colleague's password also knows it, which makes every
    audit line signed with that name deniable. Generating it means the admin
    can reset the credential but never hold it.
    """
    from houston.services import users as usersvc
    # The response below is what the People dialog renders the new row from,
    # so it has to carry the name that was STORED, not the one that was typed.
    name = usersvc.normalize_name(str(body.get("name") or ""))
    role = str(body.get("role") or "member")
    usersvc.require_valid_name(name)
    usersvc.require_valid_role(role)
    password = usersvc.mint_password()
    usersvc.add(name, password, role=usersvc.normalise_role(role))
    return {"name": name, "role": usersvc.normalise_role(role),
            "password": password,
            "note": "shown once; houston does not store it in readable form"}


def users_role(name: str, body: dict = Body(...)):
    from houston.services import users as usersvc
    role = str(body.get("role") or "")
    u = usersvc.set_role(name, role)
    # A demotion must reach the sessions the user already holds, or it takes
    # effect only when they next sign in -- and the person being demoted is
    # the least likely to sign out. (role_of is read live per request, so this
    # is belt and braces; the sign-out is what makes it visible to them.)
    # u.name, not the path segment: set_role() resolves the account by its
    # stored name, so revoking by anything else can end nobody's session while
    # reporting the role change as done.
    ended = sessions.revoke_user(u.name)
    return {"name": u.name, "role": u.role, "sessions_ended": ended}


def users_reset_password(name: str):
    """Reset somebody's password to a freshly minted one, shown once."""
    from houston.services import users as usersvc
    password = usersvc.mint_password()
    ended = usersvc.set_password(name, password)   # ...which ends their sessions
    return {"name": name, "password": password, "sessions_ended": ended}


def users_remove(name: str):
    from houston.services import users as usersvc
    # Refuses the last admin, and ends their sessions.
    ended = usersvc.remove(name)
    return {"name": name, "removed": True, "sessions_ended": ended}


def me_password(request: Request, body: dict = Body(...)):
    """Change your OWN password. Requires the current one.

    Every other session you hold ends; this one survives, so changing your
    password does not sign you out of the tab you changed it in.
    """
    from houston.services import users as usersvc
    me = getattr(request.state, "actor", "") or ""
    old, new = str(body.get("old") or ""), str(body.get("new") or "")
    # Throttled like the login, because it is one. _do_signin claims "scrypt
    # runs HERE and nowhere else, which is what makes a guessing bound possible
    # at all" -- and this endpoint quietly made that false. It takes a password,
    # derives scrypt on it, and had no bound, so any signed-in account,
    # readonly included, could spend the threadpool on it indefinitely.
    source = _deps.peer(request)[0]
    wait = security._signin_retry_after(source)
    if wait:
        return JSONResponse({"error": "too many attempts from this address",
                             "kind": "Unauthorized"}, status_code=429,
                            headers={"Retry-After": str(wait)})
    if not usersvc.verify(me, old, source=source):
        security._signin_failed(source)
        raise ValidationError("that is not your current password")
    security._signin_ok(source)
    usersvc.require_valid_password(new)
    _addr, https = _deps.peer(request)
    # Read BEFORE set_password, which now ends every session this account
    # holds. Asking afterwards would always answer None, so the tab that
    # changed the password would be handed no replacement cookie and would be
    # signed out -- the exact thing the docstring above promises it is not.
    keep = request.cookies.get(_deps.cookie_name(request, https), "")
    current = sessions.verify(keep)
    ended = usersvc.set_password(me, new)
    token = sessions.create(me, label=current.label if current else "",
                            origin="session") if current else ""
    auditsvc.record("me-passwd", me)
    resp = JSONResponse({"ok": True, "sessions_ended": max(0, ended - 1)})
    if token:
        # `https` is not optional here, and leaving it off was a real bug. The
        # cookie's NAME and its Secure flag both follow the browser's hop, and
        # behind --trust-proxy that hop is https while app.state.public_https
        # is False (houston did not arrange the TLS itself). So this wrote
        # `houston_session` while the guard three hundred lines up read
        # `__Host-houston_session`: changing your own password signed you out,
        # having just answered {"ok": true}, and the replacement token went out
        # without Secure and without the prefix that stops a sibling workspace
        # shadowing this cookie. Every other call site passed it; this one did
        # not, and no test covered me_password behind a proxy.
        _deps.set_session_cookie(request, resp, token, https)
    return resp


def audit_read(request: Request, limit: int = 200, actor: str = "",
               kind: str = "", q: str = "", since: str = ""):
    """The activity trail. Until now it was written and never read.

    An admin sees every line. A member or readonly sees only their OWN,
    forced server-side -- self-audit rather than admin-only, because "wait,
    did I do that?" is a legitimate question and answering it with a 403
    teaches people the log is not for them.
    """
    from houston.services import users as usersvc
    me = getattr(request.state, "actor", "") or ""
    if me and not usersvc.at_least(usersvc.role_of(me), "admin"):
        actor = me                       # not a filter they can widen
    out = auditsvc.read(limit=max(1, min(int(limit), 1000)),
                        actor_name=actor, kind=kind, q=q, since=since)
    out["scope"] = "all" if actor == "" else actor
    return out


ROUTES = (
    ("get", "/api/users", users_list),
    ("post", "/api/users", users_add),
    ("post", "/api/users/{name}/role", users_role),
    ("post", "/api/users/{name}/password", users_reset_password),
    ("delete", "/api/users/{name}", users_remove),
    ("post", "/api/me/password", me_password),
    ("get", "/api/audit", audit_read),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
