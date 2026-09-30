"""`houston.browser.surfaces_panel`: its own spec file.

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

def test_the_home_page_leads_with_capacity(serve, page, monkeypatch):
    """The stage used to say "Select a workspace", which answers a question nobody
    asked. It leads with the constraint that actually bites: `up` refuses without
    headroom, and seven concurrent stacks once OOM-killed a 10 GB host with every
    individual create having succeeded.

    It must agree with the refusal — one formula, three consumers (check_capacity,
    doctor, here). A home page saying "room for 2 more" while the create is refused
    is worse than one saying nothing.
    """
    from houston.services import lifecycle as lcmod

    _stub_lifecycle(monkeypatch)
    monkeypatch.setattr(lcmod.sizing, "capacity", lambda: {
        "known": True, "total_mb": 10240, "available_mb": 4096, "reserve_mb": 2048,
        "swap_mb": 0, "workspace_mb": 1100, "room": 1})
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.wait_for_function(
            "() => document.querySelector('#detail').textContent.includes('room for')")
        body = page.text_content("#detail")
        assert "room for about 1 more" in body
        assert "Memory on this machine" in body
        assert page.errors == [], page.errors


def test_a_down_workspace_is_something_home_asks_you_about(serve, page, monkeypatch):
    """It still holds a port and a data volume, and nothing anywhere said so."""
    d = _fake_detail(name="upgrade-test", state="down")
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.wait_for_function(
            "() => document.querySelector('#detail').textContent.includes('Needs you')")
        assert "upgrade-test is down" in page.text_content("#detail")
        assert "still holds port" in page.text_content("#detail")

        # ...and picking it replaces home with the workspace, actions and all
        page.click(".wrow")
        page.wait_for_selector("#d-body")
        assert "upgrade-test" in page.text_content(".d-head")
        assert page.errors == [], page.errors


def test_a_card_is_not_the_same_colour_as_the_thing_it_stands_on(serve, page,
                                                                 monkeypatch):
    """The stage carried `--panel` and so does every card on it, which made a card
    an outline drawn on a field of its own colour — and left 242px below the last
    one reading as a hole in the panel rather than as page.

    The stage is ground now. The property is simply that the two differ, which is
    what "in a box" has to mean.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_function(
            "() => document.querySelector('#detail .hcard') !== null")
        got = page.evaluate("""() => {
            const seen = (el) => {           // the first ancestor that paints
              for (let n = el; n; n = n.parentElement) {
                const c = getComputedStyle(n).backgroundColor;
                if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
              }
              return null;
            };
            const card = document.querySelector('#detail .hcard');
            return { card: getComputedStyle(card).backgroundColor,
                     ground: seen(document.querySelector('#detail')),
                     rail: getComputedStyle(document.querySelector('.rail')).backgroundColor };
        }""")
        assert got["card"] != got["ground"], \
            f"card and its ground are both {got['card']} — the box is only a border"
        # the rail stays a surface; it is the well between the panes that is ground
        assert got["rail"] == got["card"], "the rail stopped agreeing with the cards"
        assert page.errors == [], page.errors


def test_a_note_that_names_a_place_joins_the_row_that_already_lists_it(serve, page,
                                                                       monkeypatch):
    """Monitoring's notes name Grafana and Prometheus — the two links the server
    ALREADY reports — and add the one thing the links cannot: the password. Shown
    as prose they became a second, duplicate list of the same urls directly under
    the first, which is what made the block read as a dump of leftovers.

    So: one row per place, carrying everything known about it.
    """
    d = _fake_detail()
    d["links"] = [
        {"label": "Rocket.Chat", "url": "http://localhost:3001", "kind": "rc"},
        {"label": "Grafana", "url": "http://localhost:5050", "kind": "monitor"},
        {"label": "Prometheus", "url": "http://localhost:9090", "kind": "monitor"},
    ]
    d["notes"] = [
        "Grafana:    http://localhost:5050  (admin/admin; anonymous view enabled)",
        "Prometheus: http://localhost:9090  (Status -> Targets: rocketchat, mongodb)",
        "Dashboards auto-provisioned: Rocket.Chat Metrics, MongoDB, Node Exporter Full.",
    ]
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click(".wrow")
        page.wait_for_selector("#d-body")

        rows = page.locator("#detail .linkrow")
        assert rows.count() == 3, "a url is listed twice, or a row went missing"
        graf = page.locator("#detail .linkrow:has(.l-u:text-is('http://localhost:5050'))")
        assert graf.locator(".l-c").inner_text() == "admin/admin", \
            "the password the links cannot carry did not make it onto the row"
        assert "anonymous view" in graf.locator(".l-sub").inner_text()
        # Prometheus's parenthetical is a remark, not a login — inventing a
        # credential chip out of "Status -> Targets: …" would be worse than none.
        prom = page.locator("#detail .linkrow:has(.l-u:text-is('http://localhost:9090'))")
        assert prom.locator(".l-c").count() == 0
        assert "Targets" in prom.locator(".l-sub").inner_text()
        # and the line that is genuinely prose stays prose
        assert page.locator("#detail .note-p", has_text="auto-provisioned").count() == 1
        assert page.errors == [], page.errors
