"""`houston.browser.kubernetes_pane`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, _fake_detail, _kube_detail, _pane, _sign_in, _stub_lifecycle,
    browser as browser, page as page, serve as serve
)
from houston.services import users as usersvc

def test_the_action_pane_leads_with_what_this_state_admits(serve, page, monkeypatch):
    """Eleven equally-weighted items under four headings is a taxonomy, and a taxonomy
    is what you need when you do not know what you are looking for. The question people
    arrive at this pane with is "what do I do with this workspace now", and a heading
    called "Keep or move it" does not answer it -- nor could a 30px row with a label
    carry the reason anything was worth doing.

    Two at most, chosen by a rule over facts about THIS workspace, and nothing appears
    twice: a promoted item leaves the list below.
    """
    _stub_lifecycle(monkeypatch, _fake_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#actpane .apn")
        m = _pane(page)
        assert [n[0] for n in m["next"]] == ["Add sample data", "Send an API call"], m["next"]
        assert m["next"][0][1] == "Add sample data", "the card is the label, nothing else"
        assert m["groups"][:2] == ["Next, probably", "Everything else"], m["groups"]
        labels = [r[0] for r in m["rest"]]
        assert "Add sample data" not in labels and "Send an API call" not in labels, labels
        # and the suggestion is the same action, not a second way of describing it
        page.click("#actpane .apn")
        page.wait_for_selector("#seed-dialog[open]")
        assert page.errors == [], page.errors


def test_the_pane_never_offers_what_this_runtime_refuses(serve, page, monkeypatch):
    """Dropped entirely, not disabled. A greyed button invites "why can't I?" about a
    thing that will never be available on this runtime -- both would be measuring the
    `kubectl port-forward` rather than Rocket.Chat -- and the pane says so once, in
    prose, instead of eleven times in grey.
    """
    _stub_lifecycle(monkeypatch, _kube_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#actpane .aplist")
        m = _pane(page)
        labels = [r[0] for r in m["rest"]] + [n[0] for n in m["next"]]
        assert "Run a load test" not in labels, labels
        assert "Find capacity" not in labels, labels
        assert "Check the certificate" not in labels, labels
        assert "Compose-only" in page.text_content("#actpane")
        assert page.errors == [], page.errors
