"""Helpers the specs split out of `tests/test_web.py` share, lifted whole.

Imported by name, the way these tests already import from `conftest`. The ones that are
CALLED need nothing more than that; a fixture, which is REQUESTED by parameter name, is
discovered in whatever module namespace it is imported into, so it travels the same way.
Phase 02b requires the root `conftest.py` to stay as it is.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient
from houston.services import lifecycle as lc
from houston.web.app import create_app

#: Every request now carries a session cookie, so `H` is just the Host header the
#: allow-list wants. Kept under its old name so the ~90 call sites did not have to
#: change when the credential did.
H = {"Host": "localhost"}


PASSWORD = "correct-horse-battery"


def _fresh_auth_state():
    from houston.services import sessions as sessionsvc
    sessionsvc._cache.clear()
    sessionsvc._stamp = (-1, -1)
    sessionsvc._flushed.clear()
    from houston.web import app as webapp
    webapp._signin_fails.clear()


def client(host="http://localhost", *, sign_in=True, role=""):
    """An app with accounts, signed in as alice unless told otherwise.

    There is no token mode any more: a session is the only way in, so the default
    client holds one. `sign_in=False` gives the signed-out view.
    """
    from houston.services import users as usersvc
    _fresh_auth_state()
    if not usersvc.any_users():
        usersvc.add("alice", PASSWORD, role=role or "admin")
    c = TestClient(create_app(), base_url=host)
    if sign_in:
        r = c.post("/signin", data={"user": "alice", "password": PASSWORD},
                   follow_redirects=False, headers=H)
        assert r.status_code == 303, r.text
    return c


def _stub_call_target(monkeypatch):
    """Wire up /call's dependencies except rcapi.call, which each test sets."""
    from houston import runner as runner_mod
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner_mod.record, "read_meta",
                        lambda n: type("M", (), {"name": n, "root_url": "http://x:3000",
                                                 "extra": {}, "admin_pass": "admin123"})())
    monkeypatch.setattr(lc.admin, "login", lambda m: type("A", (), {"user_id": "u1", "token": "t1"})())


def _auth(user=None, password=None):
    """Kept as the way every test names the Host it is talking to.

    It used to build an Authorization header; Basic is gone, and the session
    cookie the `signed_in` fixture holds is what authenticates now. Callers did
    not have to change.
    """
    return {"Host": "localhost"}


def _reset_auth_state():
    from houston.services import sessions as sessionsvc
    sessionsvc._cache.clear()
    sessionsvc._stamp = (-1, -1)
    sessionsvc._flushed.clear()
    from houston.web import app as webapp
    webapp._signin_fails.clear()


@pytest.fixture
def anon_client(tmp_path, monkeypatch):
    """An accounts-mode app with nobody signed in."""
    from houston.services import users as usersvc
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _reset_auth_state()
    usersvc.add("alice", "correct-horse-battery")
    yield TestClient(create_app(), base_url="http://localhost")
    _reset_auth_state()


@pytest.fixture
def basic_client(anon_client):
    """Signed in as alice. TestClient keeps the cookie jar, so every later
    request in a test carries the session exactly as a browser would."""
    r = anon_client.post("/signin", data={"user": "alice",
                                          "password": "correct-horse-battery"},
                         follow_redirects=False)
    assert r.status_code == 303, r.text
    return anon_client


_CROSS = {"Host": "localhost", "Sec-Fetch-Site": "cross-site",
          "Origin": "https://evil.example"}


# --- B1: the logs WebSocket (confirmed exploitable before this) ------------------

def _ws_headers(**over):
    h = {"Host": "localhost"}
    h.update(over)
    return h


# --- roles (M10) ------------------------------------------------------------------
# The role column has been parsed, displayed and enforced NOWHERE since it was
# added. These lock in what it now means.

def _as(client, name, password):
    """Sign `client` in as somebody else, replacing whatever session it holds."""
    client.cookies.clear()
    r = client.post("/signin", data={"user": name, "password": password},
                    follow_redirects=False)
    assert r.status_code == 303, r.text
    return client


# --- first run (D8): creating the very first account ------------------------------

def _first_run_client(tmp_path, monkeypatch):
    from houston.services import firstrun as frsvc
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _fresh_auth_state()
    key = frsvc.mint()
    return TestClient(create_app(first_run=True), base_url="http://localhost"), key


# --- ownership: handover, and a destruction gate (phase 5) ------------------------

def _workspace(name, owner, tmp_path):
    """A workspace record on disk, owned by somebody."""
    from houston import runner
    ws = runner.workspace(name)
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "docker-compose.yml").write_text("services: {}\n")
    meta = runner.Metadata(name=name, project=f"houston-{name}", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="map",
                           extra={"created_by": owner})
    import json as _j
    from dataclasses import asdict
    (ws / "repro.json").write_text(_j.dumps(asdict(meta)))
    return meta


# --- --trust-proxy (P12): whose X-Forwarded-* is believed -------------------------

_FWD = {"Host": "localhost", "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.9", "Sec-Fetch-Site": "same-origin"}


def _app(**kw):
    """A client whose peer address is a real IP.

    TestClient reports its peer as the literal string "testclient", which is not
    an address and is therefore never trusted -- correct behaviour, but it makes
    the trusted case untestable unless the client is given one.
    """
    from houston.services import users as usersvc
    _fresh_auth_state()
    if not usersvc.any_users():
        usersvc.add("alice", PASSWORD, role="admin")
    peer = kw.pop("peer", "127.0.0.1")
    # `base` matters once a test follows a cookie the proxy's scheme made Secure:
    # httpx, like a browser, will not send one back over http://.
    base = kw.pop("base", "http://localhost")
    return TestClient(create_app(**kw), base_url=base, client=(peer, 5555))
