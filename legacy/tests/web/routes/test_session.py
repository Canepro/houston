"""`houston.web.routes.session`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient
from houston.services import lifecycle as lc
from houston.web.app import create_app
from webhelpers import (
    H, PASSWORD, _FWD, _app, _auth, _first_run_client, _fresh_auth_state,
    _reset_auth_state, anon_client as anon_client, basic_client as basic_client, client
)

def test_the_referrer_policy_does_not_null_this_pages_own_origin():
    """`no-referrer` is not free: per Fetch, the `Origin` of a non-CORS POST follows
    the referrer policy, so it makes this page's own form POST arrive as
    `Origin: null`.

    That is survivable while `Sec-Fetch-Site` is present to answer first -- but a
    browser omits `Sec-Fetch-*` for any URL that is not potentially trustworthy,
    and `houston serve --insecure` on a real hostname is exactly that. The guard
    then saw a bare `Origin: null`, could not match it against the allow-list, and
    refused every sign-in and every SPA write as cross-site.

    Asserted on the sign-in page specifically because that is the one a signed-out
    browser POSTs. tests/test_browser.py drives the real thing over a public name.
    """
    r = client().get("/signin")
    assert r.headers["referrer-policy"] == "same-origin"
    # The property `no-referrer` was there for: nothing about this origin travels
    # to another one. `same-origin` still guarantees it.
    assert r.headers["referrer-policy"] != "no-referrer"


def test_an_anonymous_page_is_sent_to_the_sign_in_page(anon_client):
    """A browser navigating to the app gets the page that fixes the problem,
    carrying where it was going. Answering an HTML navigation with JSON is how
    the old design ended up with no login screen at all."""
    r = anon_client.get("/", headers={"Host": "localhost"}, follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"].startswith("/signin?e=required")


def test_the_sign_in_page_and_its_stylesheet_are_reachable_signed_out(anon_client):
    """Otherwise the login is an unstyled wall of text -- or worse, itself a
    redirect loop."""
    r = anon_client.get("/signin", headers={"Host": "localhost"})
    assert r.status_code == 200
    assert "<form method=\"post\" action=\"/signin\"" in r.text
    assert anon_client.get("/app.css", headers={"Host": "localhost"}).status_code == 200


def test_the_sign_in_page_is_rendered_in_the_theme_the_browser_is_using(anon_client):
    """It loads app.css but has no script, so nothing ever set `data-theme` and it
    came up white on a dark desktop — the one screen in the product that could not
    ask. app.js writes the choice to a cookie; the server stamps it here. A browser
    that has never had the cookie gets no attribute, and `prefers-color-scheme` in
    app.css decides.
    """
    h = {"Host": "localhost"}
    assert "data-theme" not in anon_client.get("/signin", headers=h).text

    anon_client.cookies.set("houston_theme", "dark")
    assert '<html lang="en" data-theme="dark">' in anon_client.get("/signin", headers=h).text
    anon_client.cookies.set("houston_theme", "light")
    assert '<html lang="en" data-theme="light">' in anon_client.get("/signin", headers=h).text

    # The value lands in the document, and a cookie is attacker-settable. Anything
    # that is not one of the two literals yields no attribute at all.
    for junk in ('dark"><script>alert(1)</script>', "DARK", "", "; --bg: red"):
        anon_client.cookies.set("houston_theme", junk)
        body = anon_client.get("/signin", headers=h).text
        assert "data-theme" not in body, junk
        assert "<script>" not in body, junk
    anon_client.cookies.delete("houston_theme")


def test_signing_in_sets_a_session_cookie_and_admits(anon_client, monkeypatch):
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [])
    r = anon_client.post("/signin", follow_redirects=False,
                         data={"user": "alice", "password": "correct-horse-battery"})
    assert r.status_code == 303 and r.headers["location"] == "/"
    cookie = r.headers["set-cookie"]
    assert "houston_session=" in cookie
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie.replace("samesite", "SameSite")
    assert anon_client.get("/api/repros", headers=_auth()).status_code == 200


def test_the_cookie_is_host_prefixed_and_secure_only_when_the_browser_hop_is_https(tmp_path, monkeypatch):
    """__Host- requires Secure, and http://localhost cannot have it -- so the name
    is decided by the transport, and exactly one name is live per scheme."""
    from houston.services import users as usersvc
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _reset_auth_state()
    usersvc.add("alice", "correct-horse-battery")
    c = TestClient(create_app(public_https=True),
                   base_url="http://localhost")
    r = c.post("/signin", follow_redirects=False,
               data={"user": "alice", "password": "correct-horse-battery"})
    assert r.status_code == 303
    assert "__Host-houston_session=" in r.headers["set-cookie"]
    assert "Secure" in r.headers["set-cookie"]
    _reset_auth_state()


def test_a_wrong_password_or_unknown_user_is_refused(anon_client):
    for user, pw in (("alice", "wrong-x-x-x-x"), ("ghost", "correct-horse-battery")):
        r = anon_client.post("/signin", data={"user": user, "password": pw},
                             follow_redirects=False)
        assert r.status_code == 303
        assert r.headers["location"].startswith("/signin?e=bad")
        assert "set-cookie" not in r.headers, "a failed sign-in must mint nothing"


def test_signing_out_ends_the_session_on_the_server(basic_client, monkeypatch):
    """Not just a cleared cookie: the point of a server-side session is that the
    server can end it. Replaying the same cookie afterwards must fail."""
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [])
    jar = dict(basic_client.cookies)
    assert basic_client.get("/api/repros", headers=_auth()).status_code == 200
    r = basic_client.post("/signout", headers=_auth(), follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/signin?e=signedout"
    basic_client.cookies.clear()
    basic_client.cookies.update(jar)          # replay the exact cookie
    assert basic_client.get("/api/repros", headers=_auth()).status_code == 401


def test_a_second_sign_in_does_not_reuse_the_first_token(anon_client):
    """Session fixation: every sign-in mints a fresh id."""
    first = anon_client.post("/signin", follow_redirects=False,
                             data={"user": "alice", "password": "correct-horse-battery"})
    anon_client.cookies.clear()
    second = anon_client.post("/signin", follow_redirects=False,
                              data={"user": "alice", "password": "correct-horse-battery"})
    assert first.headers["set-cookie"] != second.headers["set-cookie"]


def test_who_am_i_replaces_the_actor_field_on_health(basic_client):
    """/api/health stopped reading credentials: an endpoint left open for uptime
    checks should not be in the identity business."""
    assert "actor" not in basic_client.get("/api/health", headers=_auth()).json()
    me = basic_client.get("/api/session", headers=_auth()).json()
    assert me["user"] == "alice" and me["accounts"] is True


def test_your_sessions_can_be_listed_and_revoked_individually(basic_client):
    """The answer to "I signed in on the customer's laptop", which only exists
    because the session lives on the server."""
    rows = basic_client.get("/api/sessions", headers=_auth()).json()["sessions"]
    assert len(rows) == 1 and rows[0]["current"] is True
    assert len(rows[0]["sid"]) == 8, "the full verifier must never be handed out"
    r = basic_client.delete(f"/api/sessions?sid={rows[0]['sid']}", headers=_auth())
    assert r.status_code == 200
    assert basic_client.get("/api/sessions", headers=_auth()).status_code == 401


def test_the_sign_in_endpoint_is_throttled_per_address(anon_client, monkeypatch):
    """scrypt now runs on exactly ONE endpoint, which is what finally makes a
    guessing bound possible: services/users.py cannot refuse on a counter without
    refusing correct passwords too (that was B2), but a login endpoint can decline
    to spend the CPU at all. Keyed on the ADDRESS, so nobody can throttle a
    colleague by guessing at their name."""
    from houston.web import app as webapp
    for _ in range(webapp.SIGNIN_MAX_FAILURES):
        anon_client.post("/signin", data={"user": "alice", "password": "nope-nope-nope"},
                         follow_redirects=False)
    r = anon_client.post("/api/session", json={"user": "alice", "password": "nope-nope-nope"})
    assert r.status_code == 429

    # ...and the throttle is on the ADDRESS, not on alice: a different client
    # signs her in normally while the attacker is still blocked.
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [])
    other = TestClient(anon_client.app, base_url="http://localhost")
    webapp._signin_fails.pop("testclient", None)
    ok = other.post("/api/session", json={"user": "alice",
                                          "password": "correct-horse-battery"})
    assert ok.status_code == 200 and ok.json()["user"] == "alice"


def test_who_am_i_is_answerable_without_being_signed_in(anon_client):
    """So the page can tell "signed out" from "this server has no accounts"."""
    me = anon_client.get("/api/session", headers={"Host": "localhost"}).json()
    assert me == {"user": "", "role": "", "accounts": True}


def test_every_api_route_declares_a_minimum_role():
    """DEFAULT DENY covers the runtime; this covers the reviewer.

    An endpoint shipping unguarded is structurally the same mistake as the audit
    gap -- added in one place, not registered in the other -- so it fails the
    build rather than waiting to be noticed.
    """
    from houston.web import app as webapp
    app = create_app()
    missing = []
    for route in app.routes:
        path = getattr(route, "path", "")
        if not (path.startswith("/api/") or path in ("/signin", "/signout")):
            continue
        methods = sorted(getattr(route, "methods", None) or ["WS"])
        for m in methods:
            if m in ("HEAD", "OPTIONS"):
                continue
            if webapp.route_requirement(m, path) is None:
                missing.append(f"{m} {path}")
    assert not missing, ("these routes declare no minimum role, so they are "
                         f"refused at runtime: {missing}")


def test_allow_host_star_does_not_also_trust_every_origin():
    """`--allow-host '*'` is documented as widening the HOST allow-list -- what a
    proxy in front of `serve` needs. `_cross_site` resolved Origin through the same
    closure, so `*` silently disabled the cross-site guard too: the guard whose
    docstring records a forged `Origin: https://evil.example` streaming a workspace's
    container log, LDAP bind passwords included.
    """
    from houston.services import users as usersvc

    _fresh_auth_state()
    usersvc.add("alice", PASSWORD, role="admin")
    app = create_app(allow_hosts=["*"])
    c = TestClient(app, base_url="http://anything.example")
    assert c.post("/signin", data={"user": "alice", "password": PASSWORD},
                  follow_redirects=False,
                  headers={"Origin": "http://anything.example"}).status_code == 303

    # The Host half still works: that is what `*` is for.
    assert app.state.host_ok("whatever.example") is True
    # The Origin half does not follow it. A forged Origin names a host this request
    # was not addressed to, and that is what makes it cross-site.
    assert app.state.cross_site({"origin": "https://evil.example",
                                 "host": "anything.example"}) is True, \
        "a foreign Origin must still count as cross-site under --allow-host '*'"
    # ...and the SPA's own same-origin call keeps working, which is the case `*`
    # exists for and the reason this is not simply an allow-list membership test.
    assert app.state.cross_site({"origin": "https://anything.example",
                                 "host": "anything.example"}) is False


def test_the_first_account_is_created_by_spending_the_key(tmp_path, monkeypatch):
    """One step, not two. A key-for-session exchange followed by an account
    creation would mean a privileged session with no account behind it existing
    in between -- the anonymous admin mode this design removes."""
    c, key = _first_run_client(tmp_path, monkeypatch)
    assert c.get("/setup", headers=H).status_code == 200
    r = c.post("/api/session/first-run", headers=H,
               json={"key": key, "user": "alice", "password": "alice-good-password"})
    assert r.status_code == 200 and r.json() == {"user": "alice", "role": "admin"}
    assert "houston_session=" in r.headers["set-cookie"]
    assert c.get("/api/session", headers=H).json()["role"] == "admin"


def test_the_key_is_single_use_and_setup_disappears_with_it(tmp_path, monkeypatch):
    c, key = _first_run_client(tmp_path, monkeypatch)
    c.post("/api/session/first-run", headers=H,
           json={"key": key, "user": "alice", "password": "alice-good-password"})
    again = c.post("/api/session/first-run", headers=H,
                   json={"key": key, "user": "eve", "password": "eves-good-password"})
    assert again.status_code == 409
    # and the door itself is gone, so a stale bookmark is not a second way in
    assert c.get("/setup", headers=H).status_code == 404
    assert c.get("/setup.js", headers=H).status_code == 404


def test_a_wrong_key_creates_nothing(tmp_path, monkeypatch):
    from houston.services import users as usersvc
    c, _key = _first_run_client(tmp_path, monkeypatch)
    r = c.post("/api/session/first-run", headers=H,
               json={"key": "not-the-key", "user": "eve", "password": "eves-good-password"})
    assert r.status_code == 401
    assert usersvc.any_users() is False, "a failed attempt must create no account"


def test_setup_is_closed_when_the_flow_was_never_opened(tmp_path, monkeypatch):
    """`serve` sets first_run only on a loopback bind with no accounts. Anywhere
    else these must not exist at all."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _fresh_auth_state()
    c = TestClient(create_app(first_run=False), base_url="http://localhost")
    assert c.get("/setup", headers=H).status_code == 404
    assert c.post("/api/session/first-run", headers=H,
                  json={"key": "x", "user": "a", "password": "b"}).status_code == 409


def test_a_same_origin_form_post_with_a_null_origin_is_allowed(anon_client):
    """The regression that only a real browser found.

    A same-origin form POST from a page served with `Referrer-Policy: no-referrer`
    arrives as `Sec-Fetch-Site: same-origin` with `Origin: null`. Treating that
    "null" as a foreign host refused the sign-in form in every real browser, while
    every HTTP test passed because TestClient sends neither header.
    """
    r = anon_client.post("/signin", follow_redirects=False,
                         data={"user": "alice", "password": "correct-horse-battery"},
                         headers={"Host": "localhost", "Origin": "null",
                                  "Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 303 and r.headers["location"] == "/"


def test_signing_in_by_a_dotted_name_files_the_session_under_the_stored_one(anon_client):
    """verify() accepts `lucy.felix` for the `lucy-felix` account, so the session
    must be filed under the name that EXISTS — not the one that was typed.

    Filing it as typed broke the guarantee set_password() is built to make.
    users.set_password() and users.remove() call sessions.revoke_user() with the
    stored name, so a dotted account's live sessions survived a password reset:
    changing a compromised credential left the intruder signed in for up to seven
    days, and revoke reported 0 sessions ended while saying it had succeeded.

    Found in a browser — the top bar read `lucy.felix` beside a People row reading
    `lucy-felix`, which is the same defect wearing a cosmetic face.
    """
    from houston.services import sessions as sessionsvc
    from houston.services import users as usersvc
    usersvc.add("lucy.felix", "correct-horse-battery")

    r = anon_client.post("/signin", follow_redirects=False,
                         data={"user": "lucy.felix",
                               "password": "correct-horse-battery"},
                         headers={"Host": "localhost", "Origin": "null",
                                  "Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 303, r.text
    token = r.cookies.get("houston_session") or ""
    assert sessionsvc.verify(token).user == "lucy-felix", "filed under the typed name"

    # The invariant that broke: replacing the password must end that session.
    ended = usersvc.set_password("lucy.felix", "a-brand-new-password")
    assert ended == 1, f"password reset ended {ended} sessions, so one outlived it"
    assert sessionsvc.verify(token) is None, "the session survived its own password"


def test_forwarded_headers_are_ignored_from_an_untrusted_peer():
    """uvicorn believes X-Forwarded-* from 127.0.0.1 by DEFAULT, so on the default
    bind any other local user could rewrite the client address and the scheme --
    both of which decide security here. `serve` passes proxy_headers=False and
    this resolves it explicitly instead."""
    c = _app()                      # no trust_proxy at all
    r = c.post("/signin", data={"user": "alice", "password": PASSWORD},
               headers=_FWD, follow_redirects=False)
    assert r.status_code == 303
    cookie = r.headers["set-cookie"]
    assert "Secure" not in cookie, "a client must not be able to claim https"
    assert "__Host-" not in cookie


def test_a_trusted_proxy_makes_the_cookie_secure_and_host_prefixed():
    """The live symptom this fixes: behind a TLS-terminating proxy the session
    cookie was issued without Secure and without __Host-, on a public https URL,
    and the sign-in page warned about a connection that was actually encrypted."""
    c = _app(trust_proxy=["127.0.0.1"])
    r = c.post("/signin", data={"user": "alice", "password": PASSWORD},
               headers=_FWD, follow_redirects=False)
    assert r.status_code == 303
    cookie = r.headers["set-cookie"]
    assert "__Host-houston_session=" in cookie and "Secure" in cookie


def test_the_transport_warning_follows_the_same_decision():
    """Deriving the banner and the cookie independently is how a misconfigured
    proxy ends up minting a cookie the browser then sends in clear.

    The peer is non-loopback in both halves: on loopback the warning is suppressed
    regardless, because there the password crosses no network.
    """
    warned = _app(peer="10.0.0.9").get("/signin", headers=_FWD)
    assert "not encrypted" in warned.text, "an untrusted X-Forwarded-Proto is ignored"
    quiet = _app(peer="10.0.0.9", trust_proxy=["10.0.0.0/8"]).get("/signin", headers=_FWD)
    assert "not encrypted" not in quiet.text


def test_the_throttle_keys_on_the_real_client_behind_a_trusted_proxy():
    """Without this every user shares one bucket -- the proxy's address -- so one
    person mistyping their password ten times locks out the whole team."""
    from houston.web import app as webapp
    c = _app(trust_proxy=["127.0.0.1"])
    for _ in range(webapp.SIGNIN_MAX_FAILURES):
        c.post("/api/session", json={"user": "alice", "password": "wrong-wrong-x"},
               headers=_FWD)
    assert c.post("/api/session", json={"user": "alice", "password": "wrong-wrong-x"},
                  headers=_FWD).status_code == 429
    # a DIFFERENT client behind the same proxy is unaffected
    other = {**_FWD, "X-Forwarded-For": "203.0.113.77"}
    assert c.post("/api/session", json={"user": "alice", "password": PASSWORD},
                  headers=other).status_code == 200


def test_changing_your_own_password_behind_a_proxy_keeps_you_signed_in():
    """The cookie's NAME and its Secure flag follow the BROWSER's hop, not the bind.

    Behind --trust-proxy that hop is https while public_https is False (houston
    did not arrange the TLS), so the guard reads `__Host-houston_session`.
    me_password was the one call site of four that did not pass the resolved
    scheme, so it wrote the plain name: every session was revoked, the replacement
    went out under a name nothing reads, and changing your own password signed you
    out having just answered {"ok": true}. The replacement also went out WITHOUT
    Secure and without the prefix that stops a sibling workspace -- which the
    design puts on a neighbouring host, running admin/admin123 -- shadowing it.

    Nothing covered me_password behind a proxy, which is why it shipped.
    """
    c = _app(trust_proxy=["127.0.0.1"], base="https://localhost")
    r = c.post("/api/session", json={"user": "alice", "password": PASSWORD},
               headers=_FWD)
    assert r.status_code == 200
    assert r.headers["set-cookie"].startswith("__Host-houston_session=")

    r = c.post("/api/me/password",
               json={"old": PASSWORD, "new": "a-brand-new-password"}, headers=_FWD)
    assert r.status_code == 200, r.text
    cookie = r.headers["set-cookie"]
    assert cookie.startswith("__Host-houston_session="), \
        f"the replacement cookie is under a name the guard does not read: {cookie}"
    assert "Secure" in cookie, f"a session token went out without Secure: {cookie}"

    who = c.get("/api/session", headers=_FWD)
    assert who.json()["user"] == "alice", "changing my own password signed me out"
