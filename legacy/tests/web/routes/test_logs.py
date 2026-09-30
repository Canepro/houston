"""`houston.web.routes.logs`: its own spec file.

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
    _as, _auth, _ws_headers, anon_client as anon_client, basic_client as basic_client,
    client
)

def test_a_cross_site_websocket_is_refused_before_it_is_accepted(basic_client):
    """The confirmed exploit. A WebSocket handshake is exempt from CORS, so the
    browser makes it cross-origin and attaches the cached Basic credential itself
    -- and this handler re-implemented `guard`'s checks while omitting the
    cross-site one. Measured before the fix: a forged Origin was refused 403 on a
    POST and ACCEPTED here, then streamed the workspace's log.
    """
    from starlette.websockets import WebSocketDisconnect
    creds = _auth("alice", "correct-horse-battery")
    with pytest.raises(WebSocketDisconnect):
        with basic_client.websocket_connect(
                "/api/repros/w1/logs/stream",
                headers={**creds, **_ws_headers(**{"Origin": "https://evil.example",
                                                   "Sec-Fetch-Site": "cross-site"})}):
            pass


def test_a_websocket_with_no_origin_is_refused_when_the_credential_is_ambient(basic_client):
    """A browser ALWAYS sends Origin on a WS upgrade, so an absent one cannot be
    read as same-origin the way it can for a plain fetch. With Basic in play the
    credential is attached by the browser, so the handshake has to prove it came
    from us."""
    from starlette.websockets import WebSocketDisconnect
    creds = _auth("alice", "correct-horse-battery")
    with pytest.raises(WebSocketDisconnect):
        with basic_client.websocket_connect("/api/repros/w1/logs/stream",
                                            headers={**creds, **_ws_headers()}):
            pass


def test_a_readonly_user_cannot_read_logs_or_env(basic_client, monkeypatch):
    """Not an oversight. A workspace log carries LDAP bind passwords and OAuth
    client secrets, so "read-only" cannot mean "may read those"."""
    from houston.services import users as usersvc
    usersvc.add("ronly", "read-only-password", role="readonly")
    _as(basic_client, "ronly", "read-only-password")
    assert basic_client.get("/api/repros/x/logs", headers=_auth()).status_code == 403
    assert basic_client.get("/api/repros/x/env", headers=_auth()).status_code == 403


def test_the_log_stream_drops_the_oldest_line_not_the_newest():
    """Which end gets dropped is the whole behaviour of the log panel.

    It used to discard the NEWEST: once a chatty container filled the queue, every
    line arriving from then on was thrown away while the viewer sat rendering a
    window from minutes ago, on a panel with "follow" ticked. And the cap was
    10,000 against a browser (app.js LOG_MAX) that keeps 3,000 -- so 7,000 of those
    held lines could never have been displayed even if they had survived.
    """
    import asyncio

    from houston.web.routes.logs import WS_QUEUE_MAX, make_log_offer

    assert WS_QUEUE_MAX == 3_000, "keep this in step with LOG_MAX in app.js"

    q = asyncio.Queue(maxsize=WS_QUEUE_MAX)
    dropped = [0]
    offer = make_log_offer(q, dropped)

    for i in range(WS_QUEUE_MAX + 500):
        offer(f"line-{i}")

    assert q.qsize() == WS_QUEUE_MAX, "the bound still holds"
    assert dropped[0] == 500, "and it counts what it threw away, so it can say so"
    assert q.get_nowait() == "line-500", "the OLDEST went, not the newest"
    rest = [q.get_nowait() for _ in range(q.qsize())]
    assert rest[-1] == f"line-{WS_QUEUE_MAX + 499}", "the newest line survived"


def test_the_end_of_stream_sentinel_is_never_dropped():
    """It is what closes the socket. Losing it leaves the browser waiting on a
    stream that has already ended."""
    import asyncio

    from houston.web.routes.logs import WS_QUEUE_MAX, make_log_offer

    q = asyncio.Queue(maxsize=WS_QUEUE_MAX)
    offer = make_log_offer(q, [0])
    for i in range(WS_QUEUE_MAX):
        offer(f"line-{i}")
    assert q.qsize() == WS_QUEUE_MAX, "full"
    offer(None)
    items = [q.get_nowait() for _ in range(q.qsize())]
    assert items[-1] is None, "the sentinel was dropped by the overflow policy"


def _a_signed_in_websocket_client(monkeypatch, tmp_path):
    """A client carrying the `__Host-` cookie a browser would have set over https."""
    import io
    from houston import runner
    from houston.services import sessions, users as usersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    usersvc.add("alice", "correct-horse-battery", role="admin")
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(lc.payload, "detail", lambda n: {"name": n})
    # The point of this test is the handshake, so the stream behind it is a stub:
    # otherwise it goes on to spawn `docker compose logs -f` for a workspace that
    # was never created.
    class _P:
        stdout = io.StringIO("")
        def poll(self): return 0
        def kill(self): pass
        def terminate(self): pass
        def wait(self, timeout=None): return 0
    # The stream handler resolves this in its OWN module now, so the patch has to
    # point there: patching `web.app` would be a patch that lands on nothing and
    # lets the test spawn a real `docker compose logs -f`.
    from houston.web.routes import logs as logsmod
    monkeypatch.setattr(logsmod, "open_log_process", lambda ws_dir, tail: _P())
    monkeypatch.setattr(runner.paths, "workspace", lambda n: tmp_path)

    app = create_app(allow_hosts=["testserver"])
    token = sessions.create("alice", label="test")
    c = TestClient(app)
    return c, token


def test_a_host_prefixed_cookie_is_accepted_on_the_websocket(monkeypatch, tmp_path):
    """The log stream refused a signed-in browser behind a TLS-terminating proxy.

    An HTTP scope and a WebSocket scope do not always carry the same `client`
    behind a proxy, so `resolve_peer` could conclude https for the sign-in that
    minted the cookie and plain http for the socket that reads it back. It then
    looked up `houston_session`, the browser had sent `__Host-houston_session`,
    and the handshake was refused 403 — with nothing written anywhere saying so.

    `__Host-` is PROOF of the scheme: a browser will not store one without Secure
    and will not send it over http. If it arrives, the hop is https whatever this
    end concluded. Only ever in that direction — honouring the plain name when
    https was resolved would give back exactly what the prefix buys.
    """
    c, token = _a_signed_in_websocket_client(monkeypatch, tmp_path)

    # No trusted proxy is configured, so the socket resolves the hop as plain
    # http and asks for the plain name — the shape the live failure had.
    with c.websocket_connect(
        "/api/repros/t1/logs/stream?tail=1",
        headers={"Origin": "http://testserver"},
        cookies={"__Host-houston_session": token},
    ) as ws:
        assert ws is not None       # accepted: the prefixed cookie was honoured

    # The reverse is refused: a plain-named cookie must not satisfy a lookup that
    # resolved https, or the prefix protects nothing.
    app2 = create_app(allow_hosts=["testserver"])
    app2.state.public_https = True
    with pytest.raises(Exception):
        with TestClient(app2).websocket_connect(
            "/api/repros/t1/logs/stream?tail=1",
            headers={"Origin": "https://testserver"},
            cookies={"houston_session": token},
        ):
            pass


def test_the_rest_logs_route_is_kubernetes_aware_like_the_websocket_one(monkeypatch):
    """The WebSocket log handler dispatches on topology — with a comment saying so —
    and the REST route seventy lines below it did not.

    So the same Kubernetes workspace in the same GUI had a streaming log view that
    worked and a REST one that answered compose's "no configuration file provided".
    Anything using the documented HTTP API got the broken half.
    """
    from houston import runner
    from houston.services import k8s, topology

    monkeypatch.setattr(lc.naming, "resolve_name", lambda n, actor="": "k")
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)

    def _no_compose(*a, **k):
        raise AssertionError("compose must not be asked about a k8s workspace")

    monkeypatch.setattr(runner.engine, "compose_stream", _no_compose)
    monkeypatch.setattr(runner.record, "read_meta",
                        lambda n: type("M", (), {"extra": {"context": "ctx"}})())

    class _Proc:
        stdout = ["pod line one\n", "pod line two\n"]
        def wait(self, timeout=None):
            return 0

    seen = {}

    def _log_process(name, **kw):
        seen.update(name=name, **kw)
        return _Proc()

    monkeypatch.setattr(k8s.status, "log_process", _log_process)

    c = client()
    r = c.get("/api/repros/k/logs", headers=_auth())
    assert r.status_code == 200, r.text
    assert r.json()["logs"] == "pod line one\npod line two", r.json()
    assert seen["context"] == "ctx", seen
    assert seen["follow"] is False, "the REST route is not a stream"
