"""`houston.browser.surfaces_rail`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, _fake_detail, _sign_in, _stub_lifecycle, browser as browser,
    page as page, serve as serve
)
from houston.services import users as usersvc

def test_the_dashboard_renders_a_workspace_card(serve, page, monkeypatch):
    d = _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.wait_for_function(
            "() => document.querySelector('#repros').textContent.includes('t1234')")
        assert d["name"] in page.text_content("#repros")
        assert page.errors == [], page.errors


def test_the_detail_panel_opens_and_switches_tabs(serve, page, monkeypatch):
    """The panel is built by hand from ~200 lines of el() calls. A single undefined
    key throws mid-render and leaves half a panel on screen."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        assert "7.4.1" in page.text_content("#detail"), "the overview did not render"
        page.click("button.tab:has-text('Containers')")
        page.wait_for_function(
            "() => document.querySelector('#d-body').textContent.includes('rocketchat')")
        assert page.errors == [], page.errors


def test_the_log_viewer_streams_container_output(serve, page, monkeypatch):
    """The log tab and its WebSocket, which no test had ever rendered. `docker` is
    replaced by a fake process, so this needs no engine.

    The OVERFLOW policy is covered by unit tests in test_web.py rather than here:
    tripping it through a browser needs 3000+ lines and a reader slow enough to
    fall behind, which is a flake generator, not a test.
    """
    from houston import runner

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")

    # Stubbed BEFORE Popen is replaced: the stats poll runs every three seconds
    # against this same repro and would otherwise reach the fake through
    # runner.container_ids, which is not what it expects at all.
    monkeypatch.setattr(runner.engine, "container_ids", lambda name: [])
    monkeypatch.setattr(runner.queries, "docker_stats", lambda ids: "")

    class _FakeProc:
        """Stands in for `docker compose logs -f`."""
        def __enter__(self): return self
        def __exit__(self, *exc): return False

        def __init__(self, *a, **kw):
            lines = [f'houston-t1234-rocketchat-1  | {{"level":30,"msg":"line {i}"}}'
                     for i in range(5)]
            self.stdout = iter(line + "\n" for line in lines)
            self.returncode = 0

        def terminate(self): pass
        def wait(self, timeout=None): return 0
        def kill(self): pass

    from houston.web.routes import logs as logsmod
    monkeypatch.setattr(logsmod, "open_log_process", lambda ws, tail: _FakeProc())
    monkeypatch.setattr(runner.paths, "workspace", lambda name: "/tmp")

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        page.click("button.tab:has-text('Logs')")
        page.wait_for_selector("button.tab.active:has-text('Logs')")
        page.wait_for_selector("#logview")
        page.wait_for_function(
            "() => document.querySelector('#logview').textContent.includes('line 4')",
            timeout=10000)
        body = page.text_content("#logview")
        assert "line 0" in body and "line 4" in body
        assert page.errors == [], page.errors


def test_the_backups_tab_lists_what_is_there(serve, page, monkeypatch):
    """The tab fetches AFTER it renders, so it opens showing "loading…". Asserting
    on the container rather than on its content would pass whether or not
    /api/backups works — that mistake was made once already in this file."""
    from houston.services import backup as backupsvc

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    monkeypatch.setattr(backupsvc, "list_backups", lambda name="": [
        {"path": "/tmp/t1234-2026-08-09.tar.zst", "bytes": 1234567,
         "rc_version": "7.4.1", "mongo_tag": "7.0", "preset": "base",
         "label": "", "created_at": "2026-08-09T10:00:00+00:00"}])

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        page.click("button.tab:has-text('Backups')")
        page.wait_for_function(
            "() => document.querySelector('#d-body').textContent"
            ".includes('t1234-2026-08-09')")
        assert "7.4.1" in page.text_content("#d-body")
        assert page.errors == [], page.errors


def test_a_readonly_user_is_offered_nothing_in_the_detail_panel_either(serve, page,
                                                                       monkeypatch):
    """The panel's action row branches on canWrite(), and two buttons were appended
    PAST the branch: "Make default" and the red, destructive "Down". So a readonly
    user saw "you can look, but not change anything here" with two change buttons
    directly beneath it.

    The existing readonly test covers the dashboard toolbar and the cards, which
    were right -- the card renderer returns early. Nothing covered the panel.

    Found in the audit trail, not by reading:
        dheeraj  denied  POST /api/repros/{name}/default needs member
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    usersvc.add("ronly", "read-only-password", role="readonly")
    with serve() as s:
        _sign_in(page, s.url, user="ronly", password="read-only-password")
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        assert "readonly" in page.text_content(".d-actions")
        for label in ("Make default", "Down", "Stop", "Restart", "Load test"):
            assert page.locator(f".d-actions button:has-text('{label}')").count() == 0, \
                f"a readonly user is offered {label!r}, which the server refuses"
        # ...and the thing that IS allowed is still there.
        assert page.locator(".d-actions a:has-text('Open RC')").count() == 1, \
            "opening the workspace is a link, not an action on it"
        assert page.errors == [], page.errors


def test_nothing_in_the_page_is_painted_a_hardcoded_dark_colour(serve, page):
    """Every colour comes from a token, so one palette swap re-themes the whole GUI.
    A literal that assumed a dark ground survives the swap and shows up as a black
    bar on a white page — the top bar and the dot grid both did exactly that."""
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        for sel in ("body", ".topbar", ".statusbar"):
            bg = page.eval_on_selector(sel, "e => getComputedStyle(e).backgroundColor")
            nums = [int(n) for n in __import__("re").findall(r"\d+", bg)[:3]]
            assert sum(nums) / 3 > 150, f"{sel} is dark ({bg}) on the light theme"


def test_no_control_is_hidden_behind_the_status_bar(serve, page, monkeypatch):
    """The status bar used to be position:fixed, and the old layout reserved 3.5rem
    of bottom padding for it. The three-pane shell has no such gutter, so "Prune
    down repros" rendered at y=860 underneath a bar occupying 870-900 — present in
    the DOM, clickable by a test, invisible to a person.

    The bar is a row of the shell now rather than an overlay. This asserts the
    property rather than the implementation: nothing sits under it.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        bar = page.eval_on_selector(".statusbar", "e => e.getBoundingClientRect().top")
        for sel in ("#btn-prune", "#btn-new", "#filter"):
            box = page.eval_on_selector(sel, "e => e.getBoundingClientRect().bottom")
            assert box <= bar + 1, f"{sel} is underneath the status bar ({box} > {bar})"
        assert page.errors == [], page.errors


def test_the_one_button_a_screen_is_asking_for_carries_the_accent(serve, page,
                                                                  monkeypatch):
    """This stylesheet's own rule is that colour is a signal — green = running,
    blue = you can click it — and the primary button was `--ink`: in dark, a white
    slab, the brightest thing on the page and the only thing on it saying nothing.

    Asserted as "the accent, and specifically not the text colour", because the
    failure mode is someone reaching for maximum contrast again.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        got = page.eval_on_selector("#btn-new", """el => {
            const cs = getComputedStyle(el), root = getComputedStyle(document.documentElement);
            const swatch = (v) => { const d = document.createElement('div');
              d.style.color = v.trim(); document.body.append(d);
              const c = getComputedStyle(d).color; d.remove(); return c; };
            return { bg: cs.backgroundColor,
                     accent: swatch(root.getPropertyValue('--accent-fill')),
                     ink: swatch(root.getPropertyValue('--ink')),
                     shadow: cs.boxShadow };
        }""")
        assert got["bg"] == got["accent"], f"primary button is {got['bg']}, not the accent"
        assert got["bg"] != got["ink"], "the primary button is raw luminance again"
        assert got["shadow"] != "none", "and it does not sit above the page"
        assert page.errors == [], page.errors


def test_a_burst_of_log_lines_costs_one_layout_not_one_per_line(serve, page,
                                                                monkeypatch):
    """Every arriving line used to rescan the whole 3000-entry buffer to rebuild
    the service dropdown, append a row, and then READ scrollHeight to follow —
    which forces a synchronous layout. The stream opens with tail=300, so that was
    300 forced reflows back to back before a chatty container had even started.
    That is the one-to-two second freeze, and the scroll thrashing with it.

    Driven through the page's own handler with a burst of 400 lines, and asserted
    on the thing that actually caused it: how many times the DOM was touched.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click(".wrow")
        page.wait_for_selector("#d-body")
        page.locator(".tab", has_text="Logs").click()
        page.wait_for_selector("#logview")

        got = page.evaluate("""async () => {
            await import('/js/main.js');
            const {ctx} = await import('/js/shared.js');
            const {queueLog} = await import('/js/logs.js');
            const logv = ctx.logv;
            const box = document.querySelector('#logview');
            let appends = 0;
            const real = box.append.bind(box);
            box.append = (...a) => { appends++; return real(...a); };
            const t0 = performance.now();
            for (let i = 0; i < 400; i++) {
              logv.buf.push({ ts: '12:00:00', level: 'info',
                              service: 'rocketchat', msg: 'line ' + i });
              queueLog(logv.buf[logv.buf.length - 1]);
            }
            const queued = performance.now() - t0;
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return { appends, queued, rows: box.childElementCount };
        }""")
        assert got["rows"] >= 400, "the lines did not reach the view"
        # One insertion for the whole burst, not four hundred.
        assert got["appends"] <= 2, f"{got['appends']} DOM insertions for 400 lines"
        assert page.errors == [], page.errors


def test_scrolling_up_in_the_logs_offers_one_press_back_to_the_latest(serve, page,
                                                                      monkeypatch):
    """Scrolling up detaches you from the stream — otherwise it drags you back
    mid-sentence — so there has to be one press that returns. It counts what
    arrived while you were reading, which is the thing you want to know before
    deciding to go back at all.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click(".wrow")
        page.wait_for_selector("#d-body")
        page.locator(".tab", has_text="Logs").click()
        page.wait_for_selector("#logview")
        feed = """async (n) => { await import('/js/main.js'); const {ctx} = await import('/js/shared.js');
          const {queueLog} = await import('/js/logs.js'); const logv = ctx.logv;
          return new Promise(r => {
            for (let i = 0; i < n; i++) {
              const e = { ts: '12:00:00', level: 'info', service: 'rocketchat',
                          msg: 'line ' + i };
              logv.buf.push(e); queueLog(e);
            }
            requestAnimationFrame(() => requestAnimationFrame(r));
        }); }"""
        page.evaluate(feed, 200)
        # at the bottom, following: nothing to offer
        assert page.locator("#log-jump").is_hidden()

        page.evaluate("() => { document.querySelector('#logview').scrollTop = 0; }")
        page.wait_for_selector("#log-jump:not([hidden])")
        assert page.evaluate("async () => (await import('/js/shared.js')).ctx.logv.follow") is False, \
            "the stream is still dragging the reader back"
        page.evaluate(feed, 5)
        assert page.locator("#log-jump").inner_text() == "↓ 5 new"

        page.click("#log-jump")
        page.wait_for_selector("#log-jump", state="hidden")
        assert page.evaluate("async () => (await import('/js/shared.js')).ctx.logv.follow") is True, "one press did not re-attach"
        assert page.evaluate(
            "() => { const b = document.querySelector('#logview');"
            "        return b.scrollHeight - b.scrollTop - b.clientHeight < 24; }")
        assert page.errors == [], page.errors


def test_reduced_motion_keeps_every_state_and_removes_the_travel(serve, browser,
                                                                 monkeypatch):
    """The polish pass put a transition on everything you can touch. A person who
    has asked their OS for less motion must still get every hover and press state —
    just instantly. Durations rather than `none`, so `transitionend` still fires.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    ctx = browser.new_context(reduced_motion="reduce")
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    try:
        with serve() as s:
            _sign_in(pg, s.url)
            pg.wait_for_selector("#btn-new")
            dur = pg.eval_on_selector("#btn-new",
                                      "el => getComputedStyle(el).transitionDuration")
            # every declared duration collapses; Chromium prints 1e-05s for .01ms
            assert all(float(d.strip().rstrip("s")) <= 0.001 for d in dur.split(",")), dur
            # the state itself is untouched — still the accent, still raised
            assert pg.eval_on_selector(
                "#btn-new", "el => getComputedStyle(el).boxShadow") != "none"
            assert pg.errors == [], pg.errors
    finally:
        ctx.close()


def test_the_action_pane_names_the_thing_not_one_of_its_parts(serve, page, monkeypatch):
    """`monitor` attaches Prometheus, Grafana, Loki and the exporters; "Stream to
    Grafana" named the last hop of it, and the job it starts has always said
    "Attaching monitoring". The button now agrees with its own progress line.

    Asserted because a label is exactly what a later edit changes back by accident.
    """
    d = _fake_detail()
    d["monitoring"] = False
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click(".wrow")
        page.wait_for_selector("#d-body")
        labels = page.eval_on_selector_all("#actpane button", "e => e.map(x => x.textContent)")
        assert "Attach monitoring" in labels
        assert "PAT and Token" in labels
        assert not [x for x in labels if "Grafana" in x or "Mint" in x], labels
        assert page.errors == [], page.errors
