"""Helpers the specs split out of `tests/test_browser.py` share, lifted whole.

Imported by name, the way these tests already import from `conftest`. The ones that are
CALLED need nothing more than that; a fixture, which is REQUESTED by parameter name, is
discovered in whatever module namespace it is imported into, so it travels the same way.
Phase 02b requires the root `conftest.py` to stay as it is.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from houston.web.app import create_app
import socket
import threading
import time

sync_playwright = pytest.importorskip("playwright.sync_api").sync_playwright


PASSWORD = "alice-good-password"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Server:
    """A real uvicorn on a real port. TestClient cannot be driven by a browser."""

    def __init__(self, app, port: int):
        import uvicorn
        self.port = port
        cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
        self.server = uvicorn.Server(cfg)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        deadline = time.time() + 15
        while time.time() < deadline:
            if getattr(self.server, "started", False):
                return self
            time.sleep(0.05)
        raise RuntimeError("uvicorn did not start")

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=10)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


@pytest.fixture
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser):
    ctx = browser.new_context()
    pg = ctx.new_page()
    # A JS error that leaves the page half-rendered is exactly the failure these
    # exist to catch, so collect them and let each test assert none happened.
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    yield pg
    ctx.close()


@pytest.fixture
def serve(tmp_path, monkeypatch):
    """A server factory bound to an isolated home.

    The Kubernetes probe is stubbed for the whole file. Every page load fetches
    /api/kubernetes for the footer, and `preflight()` shells out to kubectl half a dozen
    times -- so on a developer machine that happens to have a cluster, ninety browser
    tests would each spend seconds probing it, and NOTHING in the suite is allowed to
    depend on a live cluster. The two tests that care about the footer's contents set
    the value in the page instead.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **k: k8s.Preflight())

    def _start(**kw):
        return _Server(create_app(allow_hosts=["127.0.0.1"], **kw), _free_port())
    return _start


def _sign_in(page, url, user="alice", password=PASSWORD):
    page.goto(f"{url}/signin")
    page.fill("#u", user)
    page.fill("#p", password)
    page.click("button[type=submit]")


# --- surfaces the auth tests never render -------------------------------------------
#
# Everything above this line is about signing in. The create dialog, the log viewer
# and the backups tab had never been rendered by any test at all -- and app.js is
# ~2200 lines where a typo fails nothing. These are the same kind of smoke test:
# one path through each screen, enough to catch "it is blank" or "the button does
# nothing".

def _fake_detail(name="t1234", state="running", **over):
    """A detail payload shaped like lc.detail()'s, so the panel renders offline.

    Every key the panel INDEXES INTO has to be here -- `d.containers.map` on an
    undefined throws, which surfaces as a blank panel rather than an error, and
    that is precisely the failure these tests exist to catch.
    """
    return {
        "name": name, "state": state, "rc_version": "7.4.1", "mongo_tag": "7.0",
        "mongo_flavor": "mongodb", "host_port": 3001, "uptime": "2h", "preset": "base",
        "health": "healthy", "url": "http://localhost:3001", "root_url": "http://localhost:3001",
        "public_url": "", "login": {"user": "admin", "password": "admin123"},
        # DRIFTED, and invisible until the guard below learned to look at the
        # branches production takes. `degraded` is only added when Docker answers,
        # and `instances`/`instance_urls` only when the record carries a count -- so
        # the multi-instance panel was rendered here from keys `detail()` never
        # returns, and `app.js` reads all three.
        "degraded": "",
        "instances": 1, "instance_urls": [],
        # `service`, not `name` -- that is the key the containers tab reads, and
        # getting it wrong renders an empty table rather than an error.
        "containers": [{"service": "rocketchat", "state": "running",
                        "status": "Up 2 hours", "health": "healthy"}],
        # THE SHAPES MATTER, and three of these were wrong for as long as this
        # helper existed: `env` was a dict where detail() returns a list of rows,
        # `notes` a string where it returns a list, `tls` a dict where it returns a
        # string. Nothing caught it because no test opened the tab that iterates
        # them -- `for (const e of {...})` throws "is not iterable", which is a blank
        # panel. test_fake_detail_matches_the_real_payload below now compares the two
        # so the next drift fails here instead of in production.
        "env": [{"key": "ROOT_URL", "value": "http://localhost:3001", "override": False}],
        "links": [], "notes": [], "note_groups": [], "restarts": 0, "monitoring": False,
        "tls": "", "is_default": False, "created_by": "alice", "owner": "alice",
        "made_by": "alice", "owner_history": [], "workspace": "/tmp/ws", "default": False,
        "grafana_url": "", "diag": {},
        # The three axes the panel now reads: which runtime it is, how it is
        # arranged, and what address it publishes on.
        "runtime": "docker", "deployment": "monolith", "bind_host": "127.0.0.1",
        # None until something seeds it. The action pane's first suggestion turns on
        # this, so the fake has to carry the key whichever way it is set.
        "seed": None,
        "pinned": False,
        # Kubernetes-only, "" on Compose: the fixture is the UNION of what both
        # branches of detail() return, so one fixture covers either runtime.
        "namespace": "",
        **over,
    }


def _stub_lifecycle(monkeypatch, detail=None):
    from houston.services import lifecycle as lc
    d = detail or _fake_detail()
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [dict(d)])
    monkeypatch.setattr(lc.payload, "detail", lambda name: dict(d))
    monkeypatch.setattr(lc.naming, "resolve_name", lambda name: d["name"])
    return d


def _seed_stale_cert(host="old-ticket-991.kestron.org"):
    """A certificate in the ACME store that no route points at.

    Written through the real files rather than a stub, because the whole point of
    the payload key is that `acme_hosts()` reads the store: a stub would prove the
    dialog renders a list and nothing about where the list comes from.
    """
    import json

    from houston import tls
    tls.acme_dir().mkdir(parents=True, exist_ok=True)
    (tls.acme_dir() / tls.ACME_FILE).write_text(json.dumps({"le": {
        "Account": {"Email": "ops@example.com"},
        "Certificates": [{"domain": {"main": host, "sans": []}}]}}), encoding="utf-8")
    return host


# --- plain http on a real hostname (the --insecure / --bind 0.0.0.0 box) -----------
#
# Every other test here drives http://127.0.0.1, which browsers class as
# "potentially trustworthy" -- and that one property is why the whole suite, and
# every local run, was blind to the defect below. A shared box reached by NAME over
# plain http is not trustworthy, so the browser omits `Sec-Fetch-*` entirely, and
# the cross-site guard falls through to `Origin`.

PUBLIC_NAME = "houston.support.example.com"


@pytest.fixture
def public_browser():
    """A browser that resolves a real-looking hostname to the loopback server.

    `--host-resolver-rules` is what makes the origin `http://<name>:<port>` rather
    than `http://127.0.0.1:<port>`, without touching /etc/hosts or needing DNS.
    """
    with sync_playwright() as p:
        b = p.chromium.launch(
            args=[f"--host-resolver-rules=MAP {PUBLIC_NAME} 127.0.0.1"])
        yield b
        b.close()


@pytest.fixture
def public_page(public_browser):
    ctx = public_browser.new_context()
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    yield pg
    ctx.close()


@pytest.fixture
def serve_public(tmp_path, monkeypatch):
    """As `serve`, but answering to the public name as well as the loopback one."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def _start(**kw):
        app = create_app(allow_hosts=["127.0.0.1", PUBLIC_NAME], **kw)
        port = _free_port()
        srv = _Server(app, port)
        srv.public_url = f"http://{PUBLIC_NAME}:{port}"
        return srv
    return _start


# --- the panel against a Kubernetes workspace ---------------------------------------
#
# `serve` exists so a support engineer needs no shell, and on Kubernetes that is the
# only way in for anybody without kubectl. Three of these tabs rendered a confident
# wrong answer on that runtime and one rendered nothing at all.

def _kube_detail(name="t1234", **over):
    over.setdefault("containers", [])
    return _fake_detail(name, runtime="kubernetes", deployment="microservices",
                        namespace=f"houston-{name}", **over)


def _stub_list(monkeypatch, rows):
    """Several workspaces in the rail, with the panel answering for whichever is asked."""
    from houston.services import lifecycle as lc
    by_name = {r["name"]: r for r in rows}
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [dict(r) for r in rows])
    monkeypatch.setattr(lc.payload, "detail", lambda name: dict(by_name[name]))
    monkeypatch.setattr(lc.naming, "resolve_name", lambda name: name)
    return rows


def _pane(page):
    return page.evaluate("""() => ({
      // The label and nothing else: a reason written under each suggestion was a
      // sentence to read before you could act on it.
      next: [...document.querySelectorAll('#actpane .apn')].map(
        (b) => [b.querySelector('b').textContent, b.textContent]),
      rest: [...document.querySelectorAll('#actpane .aplist button')].map(
        (b) => [b.textContent, b.disabled]),
      groups: [...document.querySelectorAll('#actpane .apgroup')].map((g) => g.textContent),
      note: (document.querySelector('#actpane .apnote') || {}).textContent || "",
    })""")


# --- clusters: the ledger in a browser -----------------------------------------------

_CL_ARN = "arn:aws:eks:us-east-1:1:cluster/support"


_CL_PERF = "arn:aws:eks:eu-west-1:1:cluster/perf"


def _fake_cluster_status(context="", emit=None):
    """Shaped like `cluster.status()`. See the shape test at the end of this block."""
    if context == _CL_ARN:
        return {"context": context, "distribution": "eks", "provider": "external",
                "ours": False, "reachable": True, "unreadable": [],
                "reach_status": "ok", "reach_why": "", "reach_advice": "",
                "manageable": True, "unmanageable_why": "", "gone": False,
                "nodes": 2, "age_hours": 148.0, "instance_types": {"t3.large": 2},
                "workspaces": [{"name": "t1", "owner": "alice",
                                "owner_readable": True, "pvcs": 1}],
                "pvcs": 1, "loadbalancers": 1, "operator": False, "monitoring": False,
                "cost": {"usd_hr": 0.3523, "basis": "us-east-1 on-demand",
                         "unpriced": [], "incomplete": False}}
    return {"context": context, "distribution": "", "provider": "", "ours": False,
            "reachable": False, "unreadable": ["cluster"], "reach_status": "denied",
            "reach_why": "it answered and refused these credentials",
            "reach_advice": " Ask whoever created it to run `aws eks create-access-entry`.",
            "manageable": True, "unmanageable_why": "", "gone": False,
            "nodes": None, "age_hours": None, "instance_types": None,
            "workspaces": None, "pvcs": None, "loadbalancers": None,
            "operator": None, "monitoring": None, "cost": None}


def _stub_clusters(monkeypatch):
    from houston.services import cluster as clustersvc
    monkeypatch.setattr(clustersvc, "known_contexts", lambda: {"contexts": [
        {"context": _CL_ARN, "ours": False, "provider": "eks",
         "billable": True, "is_default": True},
        {"context": _CL_PERF, "ours": False, "provider": "eks",
         "billable": True, "is_default": False},
    ], "unreadable": "", "default": _CL_ARN})
    monkeypatch.setattr(clustersvc, "status", _fake_cluster_status)
