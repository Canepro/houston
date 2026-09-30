"""`houston.web.routes.people`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from webhelpers import (
    H, _as, _auth, anon_client as anon_client, basic_client as basic_client, client
)

def test_a_member_cannot_manage_people(basic_client, monkeypatch):
    from houston.services import users as usersvc
    usersvc.add("bob", "bobs-good-password", role="member")
    _as(basic_client, "bob", "bobs-good-password")
    assert basic_client.get("/api/users", headers=_auth()).status_code == 403
    assert basic_client.post("/api/users", json={"name": "eve"},
                             headers=_auth()).status_code == 403
    # ...but may still change their OWN password
    r = basic_client.post("/api/me/password", headers=_auth(),
                          json={"old": "bobs-good-password", "new": "another-good-one"})
    assert r.status_code == 200


def test_an_admin_creates_an_account_and_the_server_mints_the_password(basic_client):
    """An admin who TYPES a colleague's password also knows it, which makes every
    audit line signed with that name deniable."""
    r = basic_client.post("/api/users", json={"name": "carol", "role": "member"},
                          headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "member" and len(body["password"]) >= 12
    # and it works
    _as(basic_client, "carol", body["password"])
    assert basic_client.get("/api/session", headers=_auth()).json()["user"] == "carol"


def test_the_last_admin_is_protected_through_the_api(basic_client):
    r = basic_client.post("/api/users/alice/role", json={"role": "member"},
                          headers=_auth())
    assert r.status_code == 409 and "only admin" in r.json()["error"]
    assert basic_client.delete("/api/users/alice", headers=_auth()).status_code == 409


def test_a_blank_role_resolves_to_admin_over_http(basic_client):
    """The upgrade path: every account created before roles existed has a blank
    column. If blank did not mean admin, an install whose only account predates
    this would have zero admins and no way to make one."""
    from houston.services import users as usersvc
    # A line written the way a version before roles did it: no role column.
    stored = usersvc._read()
    stored["legacy"] = (usersvc.hash_password("legacy-password-here"), "2026-01-01", "")
    usersvc._write(stored)
    rows = basic_client.get("/api/users", headers=_auth()).json()
    legacy = next(u for u in rows["users"] if u["name"] == "legacy")
    assert legacy["role"] == "admin" and legacy["implicit"] is True
    assert rows["implicit_admins"] == ["legacy"]


def test_changing_a_role_ends_that_users_sessions(basic_client):
    from houston.services import sessions as sessionsvc
    from houston.services import users as usersvc
    usersvc.add("bob", "bobs-good-password", role="member")
    token = sessionsvc.create("bob")
    assert sessionsvc.verify(token) is not None
    basic_client.post("/api/users/bob/role", json={"role": "readonly"}, headers=_auth())
    assert sessionsvc.verify(token) is None, "a demotion must reach a live session"


def test_a_non_admin_only_ever_sees_their_own_lines(basic_client):
    """Self-audit rather than admin-only: "wait, did I do that?" is a legitimate
    question, and a 403 there teaches people the log is not for them."""
    from houston.services import users as usersvc
    usersvc.add("bob", "bobs-good-password", role="member")
    # alice (admin) generates a line of her own
    basic_client.post("/api/users/bob/role", json={"role": "member"}, headers=_auth())
    _as(basic_client, "bob", "bobs-good-password")
    out = basic_client.get("/api/audit?actor=alice", headers=_auth()).json()
    assert out["scope"] == "bob", "the actor filter is forced, not honoured"
    assert all(r["actor"] == "bob" for r in out["lines"])


def test_changing_your_own_password_is_throttled_like_a_login():
    """It takes a password and derives scrypt on it, so it is a login endpoint
    whatever it is called. _do_signin claims "scrypt runs HERE and nowhere else,
    which is what makes a guessing bound possible at all" -- this endpoint quietly
    made that false, and any signed-in account, readonly included, could spend the
    threadpool on it without limit.
    """
    from houston.web import app as webapp

    c = client()
    for _ in range(webapp.SIGNIN_MAX_FAILURES):
        r = c.post("/api/me/password",
                   json={"old": "not-my-password", "new": "a-brand-new-password"},
                   headers=H)
        assert r.status_code == 400, r.text        # ValidationError, still counted
    r = c.post("/api/me/password",
               json={"old": "not-my-password", "new": "a-brand-new-password"},
               headers=H)
    assert r.status_code == 429
    assert r.headers.get("Retry-After"), "a 429 that does not say when is not useful"
