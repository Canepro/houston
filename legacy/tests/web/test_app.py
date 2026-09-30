"""`houston.web.app`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""

from __future__ import annotations

import pytest

# Every test here reaches `create_app`, which imports fastapi at module level.
# Without the [gui] extra this file must SKIP, the way `tests/test_web.py` did;
# before the split it raised three FAILURES that had nothing to do with the code
# under test. `tests/web/test_jobs.py` deliberately carries no such guard -- the
# job registry is pure, and every one of its tests runs without the extra.
pytest.importorskip("fastapi")

from conftest import source_of, source_through
from houston.services import lifecycle as lc
from houston.web.app import create_app
from webhelpers import (
    H, _CROSS, _auth, _workspace, anon_client as anon_client,
    basic_client as basic_client, client
)


def test_a_successful_signin_does_not_hand_back_the_whole_throttle_window():
    """One valid low-privilege credential reset the per-address failure window.

    So an attacker with any working account could sign in between rounds and start each
    batch of guesses against an admin name from zero. The bound is per address by design
    -- `services/users.py` cannot refuse on a counter without also refusing correct
    passwords -- so the reset has to be per address too; it just must not be total.
    """
    import houston.web.app as appmod

    with appmod._signin_lock:
        appmod._signin_fails.clear()
        appmod._signin_fails["1.2.3.4"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]

    appmod._signin_ok("1.2.3.4")
    left = appmod._signin_fails.get("1.2.3.4") or []
    assert left, "a success cleared the entire window"
    assert len(left) < 6, "a success changed nothing at all"
    # A legitimate user who mistyped once and then succeeded is unaffected.
    with appmod._signin_lock:
        appmod._signin_fails["5.6.7.8"] = [1.0]
    appmod._signin_ok("5.6.7.8")
    assert not appmod._signin_fails.get("5.6.7.8")
    with appmod._signin_lock:
        appmod._signin_fails.clear()


def test_the_throttle_key_is_the_rightmost_untrusted_hop():
    """An appending proxy adds the peer it saw to the END of X-Forwarded-For, so the
    LEFT of the list is attacker-written. Taking `[0]` gave every request its own
    rate-limit key, and the sign-in throttle -- the only thing bounding password
    guessing, because scrypt is spent at the endpoint -- never tripped."""
    from houston.web import app as webapp

    trusted = webapp.parse_trusted(["10.0.0.0/8"])
    # client -> proxy(10.0.0.5) -> us. The client's own claim is on the left.
    assert webapp._rightmost_untrusted("1.2.3.4, 10.0.0.5", trusted) == "1.2.3.4"
    # A rotated forgery on the left cannot displace the real hop.
    assert webapp._rightmost_untrusted("9.9.9.9, 1.2.3.4, 10.0.0.5",
                                       trusted) == "1.2.3.4"
    # Two trusted hops: still the first address neither of them vouched for.
    assert webapp._rightmost_untrusted("1.2.3.4, 10.0.0.5, 10.0.0.6",
                                       trusted) == "1.2.3.4"
    # Everything trusted, or nothing there: keep the socket peer.
    assert webapp._rightmost_untrusted("10.0.0.5", trusted) == ""
    assert webapp._rightmost_untrusted("", trusted) == ""


def test_the_signin_throttle_is_not_reset_wholesale_by_a_flood():
    """It `.clear()`ed the whole map past 4096 keys, so a flood from throwaway
    addresses erased the counter it was tripping -- including the failures bounding
    a real attempt against a real account."""
    from houston.web import app as webapp

    webapp._signin_fails.clear()
    # The flood comes first, so the victim is NEWER than most of it. Under `.clear()`
    # the victim was wiped regardless of age -- that is the defect. Under
    # oldest-first eviction the recently-active entry is the one that survives, which
    # is the entry that matters: an attempt still in progress is by definition recent.
    for n in range(webapp._SIGNIN_MAX_KEYS):
        webapp._signin_failed(f"flood-{n}")
    webapp._signin_failed("victim")
    webapp._signin_failed("victim")
    before = len(webapp._signin_fails["victim"])
    for n in range(webapp._SIGNIN_MAX_KEYS, webapp._SIGNIN_MAX_KEYS + 500):
        webapp._signin_failed(f"flood-{n}")

    assert "victim" in webapp._signin_fails, \
        "the flood erased the counter it was competing with"
    assert len(webapp._signin_fails["victim"]) == before, \
        "the victim's accumulated failures were reset"
    assert len(webapp._signin_fails) <= webapp._SIGNIN_MAX_KEYS + 1, "still bounded"
    webapp._signin_fails.clear()

def test_openapi_schema_not_exposed():
    # The schema path does not start with /api/, so the token guard never covered
    # it — it must not be served at all.
    assert client().get("/openapi.json", headers=H).status_code == 404


def test_the_cli_report_keeps_every_row(monkeypatch, capsys):
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import doctor as doctorsvc
    monkeypatch.setattr(doctorsvc, "run_checks", lambda **_k: {
        "checks": [{"status": "ok", "message": "3 GUI account(s), admin: lovekesh",
                    "elsewhere": "the People page"}],
        "counts": {"ok": 1, "warn": 0, "fail": 0}, "verdict": "ok", "repros": None})
    out = CliRunner().invoke(cli.app, ["doctor"]).output
    assert "3 GUI account(s)" in out, "the only place a terminal user learns this"


def test_the_spa_itself_is_still_reachable_cross_site(basic_client):
    """Only /api/ is guarded. A link to the GUI from a wiki or a chat message has
    to keep working -- refusing the document would break every bookmark."""
    r = basic_client.get("/", headers={**_auth("alice", "correct-horse-battery"),
                                       **_CROSS})
    assert r.status_code == 200


def test_a_named_allow_host_is_still_a_trusted_origin():
    """Splitting the two questions must not break the proxy case it exists for: a
    named host really is ours even when the proxy rewrote Host to something else."""
    app = create_app(allow_hosts=["rc.example.com"])
    assert app.state.origin_ok("rc.example.com", "localhost") is True
    assert app.state.cross_site({"origin": "https://rc.example.com",
                                 "host": "localhost"}) is False
    assert app.state.cross_site({"origin": "https://evil.example",
                                 "host": "localhost"}) is True


def test_every_websocket_handler_actually_enforces_its_table_entry():
    """The walk above proves a WS route has a TABLE ENTRY. It cannot prove the
    handler reads it.

    HTTP routes are covered by `guard`, one middleware for all of them, so an entry
    is enough. A WebSocket handshake is exempt from that middleware and each handler
    re-implements the checks -- which is how a forged `Origin` once streamed a
    workspace's container log, LDAP bind passwords and all. So for WS the table is
    only half the invariant: a second WS route added with an entry and no in-handler
    check would pass the walk and be wide open.
    """

    from starlette.routing import WebSocketRoute

    from houston.web import app as webapp

    app = create_app()
    unenforced, checked = [], 0
    for route in app.routes:
        if not isinstance(route, WebSocketRoute):
            continue
        path = getattr(route, "path", "")
        if not path.startswith("/api/"):
            continue
        checked += 1
        assert webapp.route_requirement("WS", path) is not None, path
        # THROUGH THE HANDLER'S OWN CALLS. 2b.15 moved the sign-in check into
        # `_refuse_unless_signed_in`, and reading the handler alone reported the table
        # unenforced -- which is the same sentence this guard prints for a WS route
        # that really is wide open. Following the calls tests strictly more: the check
        # has to be on the path, not merely in the file.
        src = source_through(route.endpoint)
        # The handler must consult the table itself, and it must run the shared
        # cross-site check rather than its own idea of one. Qualified with the module
        # since phase 2a: both were closures named `route_requirement` and
        # `_cross_site` inside `create_app`, and are now `web/security.py` functions
        # the handler reaches by name. Requiring the qualifier is what keeps this from
        # being satisfied by a same-named local helper, which the bare substring was.
        if "security.route_requirement(" not in src:
            unenforced.append(f"{path}: never calls security.route_requirement()")
        elif "security.cross_site(" not in src:
            unenforced.append(f"{path}: never calls security.cross_site()")
    assert checked, "no WebSocket routes found — this walk would pass vacuously"
    assert not unenforced, (
        "these WebSocket handlers have a ROUTE_ROLES entry but do not enforce it, "
        f"so the table is decorative for them: {unenforced}")


def test_minting_a_token_is_audited_at_the_one_place_all_callers_pass_through():
    """generate_pat has eight non-test call sites, so a fix at one handler would
    have missed six -- and a bypass-2FA admin token is one of the two most
    sensitive things this tool can do."""
    from houston import rcapi
    src = source_of(rcapi.generate_pat)
    assert "auditsvc.record(\"pat\"" in src


def test_an_admin_can_still_force_it(basic_client, tmp_path, monkeypatch):
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr("houston.runner.engine.down", lambda n, volumes=False: 0)
    monkeypatch.setattr("houston.runner.paths.remove", lambda n: None)
    _workspace("bobs-box", "bob", tmp_path)
    allowed, _why = lc.may_destroy("bobs-box", "alice")   # alice is admin
    assert allowed is True


def test_the_gate_is_one_config_line_away_from_the_old_behaviour(tmp_path, monkeypatch):
    """A team that preferred confirm-and-proceed should not have to fork."""
    from houston import config
    from houston.services import users as usersvc
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    usersvc.add("alice", "correct-horse-battery", role="admin")
    usersvc.add("bob", "bobs-good-password", role="member")
    _workspace("alices-box", "alice", tmp_path)
    assert lc.may_destroy("alices-box", "bob")[0] is False
    config.update_config(lambda c: c.__setitem__(lc.DESTROY_POLICY_KEY, "anyone"))
    assert lc.may_destroy("alices-box", "bob")[0] is True


def test_a_cidr_is_accepted_and_a_typo_simply_trusts_nothing():
    from houston.web.app import parse_trusted
    assert len(parse_trusted(["10.0.0.0/8", "127.0.0.1"])) == 2
    assert parse_trusted(["not-an-address", ""]) == [], \
        "a typo must mean 'not trusted', not a server that will not start"


def test_serve_repairs_interrupted_work_at_startup(monkeypatch):
    """The drain at shutdown is bounded, and a SIGKILL skips it entirely — so the
    next start is the only chance to put right what the last one was killed in the
    middle of.

    Asserted through the lifespan, because that is what actually runs it: a
    `recover()` defined and never called is the shape this whole journal exists to
    avoid.
    """
    from houston.services import journal

    called: list = []
    monkeypatch.setattr(journal, "recover", lambda *a, **k: called.append(True) or [
        {"id": "x", "kind": journal.ROCKETCHAT_STOPPED, "workspace": "w",
         "what": "'w': Rocket.Chat was stopped for a backup", "repaired": True,
         "why": ""}])
    with client():
        pass
    assert called, "startup must consult the journal"
