"""`houston.browser.kubernetes_panel`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, _fake_detail, _kube_detail, _sign_in, _stub_lifecycle, _stub_list,
    browser as browser, page as page, serve as serve
)
from houston.services import users as usersvc

def test_the_panel_leads_with_what_is_wrong_and_what_to_do(serve, page, monkeypatch):
    """The panel is opened when something looks wrong, and it opened with six facts
    that never change. The one thing on it that said anything was wrong -- the restart
    banner -- was under them, i.e. under the fold on a 900px window, and it named no
    action: it said "check the Logs tab" and left you to find the tab.

    It leads with it now, above the TABS rather than inside Overview, because what is
    wrong with a workspace is not a property of the tab you happen to be on -- it was
    invisible from Logs, which is exactly where you go when something is wrong.
    """
    _stub_lifecycle(monkeypatch, _fake_detail(restarts=4, health="unhealthy"))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#detail .triage .tri")
        m = page.evaluate("""() => {
          const tri = document.querySelector('#detail .triage');
          const tabs = document.querySelector('#detail .tabs');
          return {
            title: tri.querySelector('.tri-t b').textContent,
            why: tri.querySelector('.tri-t span').textContent,
            acts: [...tri.querySelectorAll('.tri-a button')].map(b => b.textContent),
            // 4 == DOCUMENT_POSITION_FOLLOWING: the block precedes the tab strip
            beforeTabs: !!(tri.compareDocumentPosition(tabs) & 4),
            // and one problem, not two: a restart loop and its failing healthcheck
            // are the same fault reported twice
            count: document.querySelectorAll('#detail .triage .tri').length,
          };
        }""")
        assert m["title"] == "Rocket.Chat has restarted 4×", m["title"]
        assert "memory pressure" in m["why"]
        assert m["acts"][:1] == ["Open the logs"], m["acts"]
        assert m["beforeTabs"], "the triage block is below the tab strip"
        assert m["count"] == 1, "a restart loop and its healthcheck are one problem"
        # And the action IS the tab, not a sentence telling you to go and find it.
        page.click("#detail .triage .tri-a button")
        page.wait_for_selector("button.tab.active:has-text('Logs')")
        assert page.errors == [], page.errors


def test_a_down_workspace_is_told_what_it_still_holds(serve, page, monkeypatch):
    """"down" is not a fault, and the panel said nothing about it at all: the reader
    had to infer from a greyed action pane that the port and the data volume are still
    reserved and that bringing it up reuses both.
    """
    _stub_lifecycle(monkeypatch, _fake_detail(state="down", health="", uptime=""))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#detail .triage .tri")
        why = page.text_content("#detail .triage .tri-t span")
        assert ":3001" in why and "data volume" in why, why
        assert page.text_content("#detail .triage .tri-a button") == "Bring it up"
        assert page.errors == [], page.errors


def test_a_pod_that_cannot_start_is_named_in_the_panel(serve, page, monkeypatch):
    """An ImagePullBackOff was reachable only by opening the Containers tab and
    reading a table. It is the answer to "why is this workspace not up", so it is on
    the panel -- named, with its reason.

    `blocked` is decided in services/k8s.py, beside the list of reasons a pod never
    recovers from: `ContainerCreating` is a waiting reason too, and a browser holding
    its own copy of that policy would report a booting workspace as broken.
    """
    d = _kube_detail(containers=[
        {"service": "rocketchat-0", "state": "pending", "status": "ImagePullBackOff",
         "health": "", "blocked": True, "restarts": 0, "started": ""},
        {"service": "mongodb-0", "state": "pending", "status": "ContainerCreating",
         "health": "", "blocked": False, "restarts": 0, "started": ""}])
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#detail .triage .tri")
        title = page.text_content("#detail .triage .tri-t b")
        why = page.text_content("#detail .triage .tri-t span")
        assert title == "One pod cannot start", title
        assert "rocketchat-0 — ImagePullBackOff" in why, why
        assert "mongodb-0" not in why, "a pod that is merely starting is not a fault"
        page.click("#detail .triage .tri-a button")
        page.wait_for_selector("#d-body .dtable")
        assert page.errors == [], page.errors


def _the_bar_stays_above_the_panel_all_the_way_down(page):
    """Scrolling to the bottom must not put the action bar underneath anything."""
    # PINNED, not merely on screen. This assertion used to pass for the wrong
    # reason: the panel was short enough that the bar's natural position happened
    # to be visible, so it said nothing about stickiness -- and stickiness was in
    # fact not working at all, because `bottom` holds an element that would fall
    # BELOW the scrollport and does not drag one down from above.
    pin = page.evaluate("""() => {
      const b = document.querySelector('#detail .d-actions').getBoundingClientRect();
      const panel = document.querySelector('#detail').getBoundingClientRect();
      return {gap: Math.round(window.innerHeight - b.bottom),
              taller: panel.height > window.innerHeight};
    }""")
    assert pin["taller"], "the panel has to be taller than the screen to pin anything"
    assert pin["gap"] <= 2, f"the bar sits {pin['gap']}px above the bottom, not pinned"
    # And it is still there with the panel scrolled to its end.
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(200)
    assert page.evaluate("""() => {
      const b = document.querySelector('#detail .d-actions').getBoundingClientRect();
      return b.bottom > 0 && b.top < window.innerHeight;
    }"""), "the action bar left the screen"
    page.click("#detail .panetoggle")
    page.wait_for_selector("#actpane .apdanger", state="visible")
    assert page.errors == [], page.errors


def _the_three_parts_fit_at_430px(page):
    """A picker that scrolls, a panel that does not, and a bar that stays put."""
    m = page.evaluate("""() => {
      const rows = document.querySelector('#repros');
      const chips = [...rows.querySelectorAll('.wrow')];
      return {
        sideways: document.body.scrollWidth > window.innerWidth + 2,
        // one row of chips, not six stacked rows
        railHeight: Math.round(rows.getBoundingClientRect().height),
        oneRow: new Set(chips.map((c) => Math.round(
          c.getBoundingClientRect().top))).size === 1,
        railScrolls: rows.scrollWidth > rows.clientWidth + 2,
        sticky: getComputedStyle(document.querySelector('#detail .d-actions')).position,
        pane: getComputedStyle(document.querySelector('#actpane')).display,
        toggle: getComputedStyle(document.querySelector('.panetoggle')).display,
      };
    }""")
    assert not m["sideways"], "the page scrolls sideways"
    assert m["oneRow"], "the chips are not on one row"
    assert m["railHeight"] <= 60, f"the picker is {m['railHeight']}px tall"
    assert m["railScrolls"], "six chips at 430px have to scroll, not wrap"
    assert m["sticky"] == "sticky", "the action bar scrolls away with the panel"
    assert m["pane"] == "none", "the whole pane is still open at the bottom"
    assert m["toggle"] != "none", "and there is no way to get it back"


def test_the_narrow_layout_is_a_picker_a_panel_and_a_bar(serve, page, monkeypatch):
    """Below 760px the layout was merely survivable: it stacked and nothing overlapped,
    but nothing was designed for it. The rail was a capped vertical strip spending 38vh
    of a phone on a list of four names, and the action pane was eleven items in a
    wrapping grid at the bottom of the document -- which pushed the danger zone off the
    end of a panel that can be several screens tall.

    Three changes: the rail is a one-row chip picker, the state actions are a bar that
    stays put while the panel scrolls, and the rest of the pane is one tap away.
    """
    _stub_list(monkeypatch, [_fake_detail(name=f"ws-{i}") for i in range(6)])
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros .wrow")
        page.set_viewport_size({"width": 430, "height": 780})
        page.click("#repros >> text=ws-2")
        page.wait_for_selector("#d-body .kv-grid")
        page.wait_for_timeout(250)
        _the_three_parts_fit_at_430px(page)
        _the_bar_stays_above_the_panel_all_the_way_down(page)


def test_a_sidecar_that_keeps_restarting_is_a_fault_on_kubernetes(serve, page, monkeypatch):
    """The restart rule read `d.restarts`, and the Kubernetes branch of detail() never
    set it -- so both the restart cell and the triage rule were dead on the runtime where
    a crash-looping workspace is the common failure. Found on a live microservices
    workspace whose `ddp-streamer` pod had restarted three times while the panel called
    it healthy.

    Two halves. `restarts` is now Rocket.Chat's OWN pod, by the label the server selects
    on -- nine pods here have a count each and "RC restarts: 3" must not be a sidecar's.
    And a sidecar that keeps restarting gets its own entry, because Rocket.Chat depends
    on it and the fault is the same one a layer along.
    """
    d = _kube_detail(restarts=0, containers=[
        {"service": "rocketchat-rocketchat-579c867b87-mwq4w", "state": "running",
         "status": "1/1 ready", "health": "healthy", "app": True, "restarts": 0},
        {"service": "rocketchat-ddp-streamer-768f896d7-rpcw9", "state": "running",
         "status": "1/1 ready · 3 restarts", "health": "healthy", "app": False,
         "restarts": 3},
        # One restart is what a slow first boot looks like, on either runtime.
        {"service": "rocketchat-presence-7ffb7dc6f7-m25vt", "state": "running",
         "status": "1/1 ready · 1 restart", "health": "healthy", "app": False,
         "restarts": 1}])
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        # The OVERVIEW, not a banner: waiting for `.triage .tri` would wait for the
        # very thing this test says must not appear, and time out instead of asserting.
        page.wait_for_selector("#detail .dtable, #detail .tabs")
        m = page.evaluate("""() => [...document.querySelectorAll('#detail .triage .tri')].map(
          (t) => [t.querySelector('.tri-t b').textContent,
                  t.querySelector('.tri-t span').textContent])""")
        # NOT A BANNER ANY MORE, and that is the correction. Every pod here is
        # `1/1 ready`; ddp-streamer restarted three times while NATS came up, which is
        # what a normal microservices boot looks like. "keeps restarting" is present
        # tense, so on a workspace that has served ever since it was simply false --
        # and a banner that is always there is one nobody reads. Reported from a live
        # workspace in exactly this state.
        assert m == [], m
        # The count is not hidden, only demoted: the server puts "· 3 restarts" in the
        # pod's status string, so the containers tab still carries it -- which is where
        # a fact belongs when it is not asking anything of the reader.
        assert "3 restarts" in d["containers"][1]["status"]


def test_a_sidecar_that_is_not_ready_and_restarting_is_still_a_fault(serve, page, monkeypatch):
    """The other half: dropping the cumulative-count banner must not drop the real
    crash-loop it was there for. A pod in CrashLoopBackOff is not ready, so `health`
    tells them apart -- decided by the server, next to the list that defines it."""
    d = _kube_detail(restarts=0, containers=[
        {"service": "rocketchat-rocketchat-579c867b87-mwq4w", "state": "running",
         "status": "1/1 ready", "health": "healthy", "app": True, "restarts": 0},
        {"service": "rocketchat-ddp-streamer-768f896d7-rpcw9", "state": "running",
         "status": "CrashLoopBackOff · 7 restarts", "health": "", "app": False,
         "restarts": 7}])
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#detail .triage .tri")
        m = page.evaluate("""() => [...document.querySelectorAll('#detail .triage .tri')].map(
          (t) => t.querySelector('.tri-t b').textContent)""")
        assert m == ["rocketchat-ddp-streamer-768f896d7-rpcw9 keeps restarting"], m
