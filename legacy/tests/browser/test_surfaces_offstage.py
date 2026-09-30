"""`houston.browser.surfaces_offstage`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, _sign_in, _stub_lifecycle, browser as browser, page as page,
    serve as serve
)
from houston.services import users as usersvc

def test_a_running_workspace_on_home_offers_both_places_it_could_mean(serve, page,
                                                                      monkeypatch):
    """Two destinations live in this row and they are genuinely different: the row
    opens the WORKSPACE (houston's page about it) and Open goes to Rocket.Chat
    itself. The old row only did the first, which made reaching the actual chat
    server — the thing everybody is here for — a two-step.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector(".wsrow")
        row = page.locator(".wsrow").first
        assert "t1234" in row.locator(".wsrow-t b").inner_text()
        assert row.locator(".wsrow-m").inner_text() == "7.4.1 · base · :3001"
        assert "2h" in row.locator(".wsrow-up").inner_text()

        # Open leaves for Rocket.Chat, in a new tab
        opener = row.locator("a", has_text="Open")
        assert opener.get_attribute("target") == "_blank"
        # The workspace's ROOT_URL, verbatim -- no trailing slash, because nothing
        # normalises it through URL.toString() any more.
        assert opener.get_attribute("href") == "http://localhost:3001", \
            opener.get_attribute("href")

        # and the row itself stays inside houston
        row.locator(".wsrow-main").click()
        page.wait_for_selector("#d-body")
        assert "t1234" in page.text_content(".d-head")
        assert page.errors == [], page.errors
