"""`houston.browser.surfaces_chrome`: its own spec file.

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

def test_the_theme_is_light_by_default_and_the_choice_survives_a_reload(serve, page):
    """Light is the default; the choice is remembered per BROWSER, not per account —
    it is a property of the screen you are sitting at, and the same person on a
    projector and a laptop wants different answers."""
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        assert page.get_attribute("html", "data-theme") == "light"

        page.click("#theme-toggle")
        assert page.get_attribute("html", "data-theme") == "dark"

        page.reload()
        page.wait_for_selector("#repros")
        assert page.get_attribute("html", "data-theme") == "dark", "the choice was forgotten"

        # The control is a drawn mark now, and it shows where the click GOES rather
        # than where you are: on a dark page it is a sun. Since it has no text, the
        # accessible name is the only name it has — so that is asserted, not the art.
        btn = page.locator("#theme-toggle")
        assert btn.inner_text().strip() == "", "the toggle went back to a word"
        assert btn.locator("svg").count() == 1
        assert btn.get_attribute("aria-label") == "Switch to the light theme"
        assert btn.locator("circle").count() == 1, "a dark page should offer the sun"
        page.click("#theme-toggle")
        assert btn.get_attribute("aria-label") == "Switch to the dark theme"
        assert btn.locator("circle").count() == 0, "a light page should offer the moon"
        # And the mark follows the theme's ink rather than carrying its own colour.
        # BOTH reads in one evaluation, deliberately: the chip has a 140ms colour
        # transition and the pointer is still over it after the click, so two
        # separate eval_on_selector calls sample the same transition at different
        # points and disagree -- `rgb(108,126,185)` vs `rgb(74,102,209)`, both of
        # them interpolated. Sampling once compares the two properties rather
        # than comparing one property against itself a few milliseconds later.
        assert page.evaluate("""() => {
            const b = document.querySelector('#theme-toggle');
            return getComputedStyle(b.querySelector('svg')).stroke
                 === getComputedStyle(b).color;
        }"""), "the mark stopped following the button's ink"
        assert page.errors == [], page.errors


def test_people_rows_have_their_own_shape_not_activitys(serve, page, monkeypatch):
    """People borrowed `.jobrow`, which is four fixed cells for Activity — and a
    person needs six. Every row landed out of step with the one above it the
    moment Activity's grid was tightened.

    Also: no role PILL beside the role SELECT. The select already says which role
    this is, and saying it twice is not emphasis.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    usersvc.add("bob", PASSWORD, role="member")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.click("#whoami")
        page.wait_for_selector("#me-menu:not([hidden])")
        page.click("#me-people")
        page.wait_for_selector("#people-dialog[open]")
        page.wait_for_function("() => document.querySelectorAll('.prow').length >= 2")

        assert page.locator("#people-dialog .jobrow").count() == 0, \
            "People is wearing Activity's row again"
        assert page.locator("#people-dialog .jstatus").count() == 0, \
            "the role is shown twice — once as a pill and once as the select"
        row = page.locator(".prow", has_text="bob").first
        assert row.locator("select").input_value() == "member"
        assert row.locator("button", has_text="reset").count() == 1
        assert row.locator("button", has_text="remove").count() == 1
        # every row has the same number of cells, which is what lets them line up
        counts = page.eval_on_selector_all(
            ".prow", "rs => rs.map(r => r.children.length)")
        assert len(set(counts)) == 1, counts
        assert page.errors == [], page.errors


def test_a_background_poll_does_not_navigate_the_page_for_you(serve, page,
                                                              monkeypatch):
    """refreshHome() repainted the stage whenever no workspace was SELECTED — and
    Activity and Scenarios are stage views with nothing selected. So the timer
    dropped Home on top of whatever you were reading, seconds after you opened it:
    the page appearing to navigate itself.

    `!SELECTED` was never the same question as "is Home on screen". render() has
    always asked the right one; this is the same fix, in the place that missed it.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        for opener, marker in (("#btn-jobs", "#act-tabs"), ("#btn-scenarios", ".hcard.scen")):
            page.click(opener)
            page.wait_for_selector(marker)
            page.evaluate(
                "async () => (await import('/js/state.js')).refreshHome(true)"
            )
            page.wait_for_timeout(400)
            assert page.locator(marker).count() >= 1, \
                f"a background poll replaced {opener} with Home"
            assert "Good " not in page.text_content(".home-head h1"), \
                "the greeting is on screen — Home won"
        assert page.errors == [], page.errors


def test_activity_and_a_workspace_are_different_views_of_the_stage(serve, page,
                                                                   monkeypatch):
    """Opening Activity must not silently deselect the workspace you were on, and
    picking a workspace must leave Activity. The rail selection and the stage view
    are separate pieces of state for exactly that reason."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")

        page.click(".wrow")
        page.wait_for_selector("#d-body")
        assert page.is_visible("#actpane .apdanger"), "the workspace pane is up"

        page.click("#btn-jobs")
        page.wait_for_selector("#act-tabs")
        assert page.locator("#actpane .apdanger").count() == 0, \
            "the per-workspace pane has no business on a box-wide page"
        assert page.locator(".wrow[aria-current=true]").count() == 1, \
            "the workspace stayed selected in the rail"

        page.click(".wrow")
        page.wait_for_selector("#d-body")
        assert page.locator("#act-tabs").count() == 0, "picking a workspace leaves Activity"
        assert page.errors == [], page.errors


def test_the_scenarios_page_shows_the_setup_step_a_preset_needs(serve, page):
    """A preset's `notes` were printed by `up` and `info` and shown NOWHERE in the
    browser. For `oidc` that is not cosmetic: the scenario does not work at all
    until `127.0.0.1  keycloak` is in /etc/hosts, and a GUI-only user had no way to
    learn that — the login simply fails and nothing says why.

    Real preset data, not a fixture: if a note stops carrying its setup step, this
    fails.
    """
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.click("#btn-scenarios")
        page.wait_for_function(
            "() => document.querySelector('#detail').textContent.includes('oidc')")
        body = page.text_content("#detail")
        assert "127.0.0.1  keycloak" in body, "the hosts entry oidc cannot work without"
        assert "/etc/hosts" in body
        assert "8085" in body, "and where the Keycloak console is"
        # The line you have to TYPE keeps its spacing exactly and is copyable; the
        # prose around it is free to wrap, because it was wrapped for an 80-column
        # terminal and re-flowing it is the right thing to do. Asserting `pre` on
        # the whole block, as this once did, protected the wrong half.
        cmd = page.locator(".note-cmd code", has_text="127.0.0.1")
        assert cmd.count() == 1, "the hosts entry is not a copyable line"
        assert cmd.first.inner_text() == "127.0.0.1  keycloak", "its spacing changed"
        assert page.eval_on_selector(
            ".note-cmd code", "e => getComputedStyle(e).whiteSpace") == "pre"
        assert page.locator(".note-cmd .cp").first.is_visible(), "and it can be copied"
        # The line that names WHERE the console is is not prose — it is a place,
        # and the two facts on it are the url and the password. As a paragraph
        # ("Keycloak admin console: http://keycloak:8085  (admin/admin, realm
        # 'houston').") both were buried mid-sentence in grey text.
        # by url, because `saml` names its own Keycloak console on the same page
        row = page.locator(".linkrow:has(.l-u:text-is('http://keycloak:8085'))")
        assert row.count() == 1, "the console line did not become a row"
        assert "Keycloak admin console" in row.locator(".l-n").inner_text()
        assert row.locator(".l-c").inner_text() == "admin/admin", "credentials not lifted out"
        assert "houston" in row.locator(".l-sub").inner_text(), "the realm was dropped"
        assert row.first.get_attribute("href") == "http://keycloak:8085"
        assert page.errors == [], page.errors


def test_every_page_is_reachable_and_says_which_one_you_are_on(serve, page,
                                                               monkeypatch):
    """Activity and Scenarios shipped one-way: you could reach them and nothing led
    back, because the brand was a <div> and no link was ever marked current. You
    could not tell where you were, or that there was anywhere else to be."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        assert page.get_attribute("#btn-home", "aria-current") is not None

        page.click("#btn-jobs")
        page.wait_for_selector("#act-tabs")
        assert page.get_attribute("#btn-jobs", "aria-current") is not None
        assert page.get_attribute("#btn-home", "aria-current") is None

        page.click("#btn-home")
        page.wait_for_function(
            "() => document.querySelector('#detail').textContent.includes('workspace(s)')")

        page.click("#btn-scenarios")
        page.wait_for_function(
            "() => document.querySelector('#detail').textContent.includes('Scenarios')")
        page.click(".brand")                       # the wordmark goes home too
        page.wait_for_function(
            "() => document.querySelector('#detail').textContent.includes('workspace(s)')")
        assert page.errors == [], page.errors


def test_the_dashboard_poll_does_not_close_the_page_you_are_reading(serve, page,
                                                                    monkeypatch):
    """render() runs every four seconds to redraw the rail. It used to redraw the
    STAGE too, so opening Scenarios and reading it for four seconds put you back on
    the home page with no interaction at all."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.click("#btn-scenarios")
        page.wait_for_function(
            "() => document.querySelector('#detail').textContent.includes('Scenarios')")
        page.wait_for_timeout(5000)                # longer than POLL_MS
        assert "Scenarios" in page.text_content("#detail"), \
            "the poll replaced the page while it was being read"
        assert page.errors == [], page.errors


def test_preset_notes_are_read_as_points_not_as_lines(serve, page):
    """The notes are prose wrapped for an 80-column terminal. Rendering one line per
    <div> makes the /etc/hosts entry look like the sentence beside it; joining every
    consecutive line turns the email preset's five points into one wall.

    The rule reads what the previous line ENDS with, because that is the only
    reliable signal in the data: a line trailing off in a plain lowercase word was
    wrapped, one ending in a url, a path, a number or punctuation was finished.
    `livechat` is the case that proves it — two consecutive points that each end in
    a url, followed by one starting with a lowercase username.
    """
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.click("#btn-scenarios")
        page.wait_for_function(
            "() => document.querySelector('#detail').textContent.includes('livechat')")

        def parts(scenario, sel):
            return page.eval_on_selector_all(
                f"xpath=//div[contains(@class,'hcard')][.//b[text()='{scenario}']]"
                f"//*[contains(@class,'{sel}')]",
                "els => els.map(e => e.textContent.trim())")

        # livechat's first two points each NAME A PLACE, so they are rows; the two
        # that follow are prose, and they are two rather than one.
        assert parts("livechat", "l-u") == ["http://localhost:8090",
                                            "<repro-url>/livechat"]
        assert parts("livechat", "l-w") == ["widget embedded, cross-origin",
                                            "same-origin"], "the aside naming what it is for"
        live = parts("livechat", "note-p")
        assert len(live) == 2, f"livechat's two prose points became {len(live)}: {live}"
        assert live[0].startswith("admin is an available"), \
            "a point starting with a lowercase username was folded into the one above"

        oidc = parts("oidc", "note-p")
        assert oidc[0].startswith("OIDC needs one host entry") and "same URL" in oidc[0], \
            "a sentence wrapped across two lines was split into two paragraphs"
        assert page.errors == [], page.errors
