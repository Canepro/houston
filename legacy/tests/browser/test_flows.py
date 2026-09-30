"""`houston.browser.flows`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, _sign_in, browser as browser, page as page, serve as serve
)
from houston.services import firstrun as frsvc
from houston.services import users as usersvc

# --- the flows ---------------------------------------------------------------------

def test_a_signed_out_browser_lands_on_the_sign_in_page(serve, page):
    """M7: there was no login page at all -- just the browser's grey Basic dialog,
    which cannot show an error, cannot be styled and has no way back."""
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        page.goto(s.url)
        page.wait_for_url("**/signin**")
        assert page.is_visible("#u") and page.is_visible("#p")
        assert "houston" in page.title()
        assert page.errors == []


def test_a_wrong_password_shows_an_error_in_the_page(serve, page):
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url, password="not-the-password")
        page.wait_for_selector(".signin-banner.bad")
        assert "not right" in page.text_content(".signin-banner.bad")
        assert page.errors == []


def test_signing_in_renders_the_dashboard(serve, page):
    """The whole point: a session cookie, and app.js actually running."""
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.wait_for_selector("#whoami:not([hidden])")
        assert page.text_content("#whoami").strip() == "alice"
        assert page.is_visible("#btn-new"), "an admin may create"
        assert page.errors == [], page.errors


def test_sign_out_ends_the_session_and_returns_to_the_login(serve, page):
    """HTTP Basic had no logout at all; the browser cached until the tab closed."""
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.click("#whoami")
        page.wait_for_selector("#me-menu:not([hidden])")
        page.click("#me-out")
        page.wait_for_url("**/signin**")
        # and the session is really gone: going back does not restore it
        page.goto(s.url)
        page.wait_for_url("**/signin**")


def test_first_run_creates_the_first_admin_in_the_browser(serve, page):
    """The only path that can create an account with nobody signed in. The key
    lives in the URL FRAGMENT, so only a browser can complete this -- which is
    precisely why it needed a browser test."""
    key = frsvc.mint()
    with serve(first_run=True) as s:
        page.goto(f"{s.url}/setup#k={key}")
        page.fill("#u", "alice")
        page.fill("#p", PASSWORD)
        page.click("button[type=submit]")
        page.wait_for_selector("#repros")          # straight into the dashboard
        # Pre-existing race, same shape as the one CI caught next door: #repros
        # exists before app.js has filled #whoami from /api/session, so a slow
        # runner reads "" here. It has simply not lost the race yet.
        page.wait_for_selector("#whoami:not([hidden])")
        assert page.text_content("#whoami").strip() == "alice"
        # the key must not survive in the address bar
        assert "#k=" not in page.url
        assert usersvc.role_of("alice") == "admin"
        assert page.errors == [], page.errors


def test_the_setup_page_says_so_when_the_key_is_missing(serve, page):
    frsvc.mint()
    with serve(first_run=True) as s:
        page.goto(f"{s.url}/setup")               # no fragment
        page.wait_for_selector("#err:not([hidden])")
        assert "setup link" in page.text_content("#err")


def test_a_readonly_user_is_not_offered_what_it_cannot_do(serve, page):
    """The bug reported from a real session: the server refused correctly, but the
    interface still rendered Stop / Restart / Seed / Logs, so a readonly user
    clicked them and reasonably concluded roles were not working."""
    usersvc.add("alice", PASSWORD, role="admin")
    usersvc.add("ronly", "read-only-password", role="readonly")
    with serve() as s:
        _sign_in(page, s.url, user="ronly", password="read-only-password")
        # `#repros` is in the served HTML, so waiting for it proves nothing about
        # the async boot. `#whoami` is only unhidden once GET /api/session has
        # answered, which is what the role assertions below actually depend on --
        # this used to pass on timing alone.
        page.wait_for_selector("#whoami:not([hidden])")
        assert page.text_content("#whoami").strip() == "ronly · readonly"
        assert page.is_hidden("#btn-new"), "creating is member+"
        assert page.is_hidden("#btn-prune"), "pruning is member+"
        assert page.errors == [], page.errors


def test_an_admin_can_open_people_and_a_member_cannot(serve, page):
    usersvc.add("alice", PASSWORD, role="admin")
    usersvc.add("bob", "bobs-good-password", role="member")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.click("#whoami")
        page.wait_for_selector("#me-people:not([hidden])")
        page.click("#me-people")
        page.wait_for_selector("#people-dialog[open]")
        # The list is fetched after the dialog opens, so wait for the content
        # rather than for the container -- asserting on "loading…" would be a
        # test that passes whether or not /api/users works.
        page.wait_for_function(
            "() => document.querySelector('#people-body').textContent.includes('alice')")
        assert "admin" in page.text_content("#people-body")
        assert page.errors == [], page.errors

        # ...and a member is not offered the entry point at all.
        # Signed out through the UI, not by GETting /signout: that route is POST
        # only on purpose, because a logout reachable by GET is CSRF-able and gets
        # fired by link prefetchers.
        page.click("#people-close")
        page.click("#whoami")
        page.wait_for_selector("#me-menu:not([hidden])")
        page.click("#me-out")
        page.wait_for_url("**/signin**")
        _sign_in(page, s.url, user="bob", password="bobs-good-password")
        page.wait_for_selector("#whoami:not([hidden])")
        page.click("#whoami")
        page.wait_for_selector("#me-menu:not([hidden])")
        assert page.is_hidden("#me-people"), "a member is not offered People at all"


def test_the_activity_page_opens_both_of_its_tabs(serve, page):
    """H5's read path. History is a different fetch from Running, so a broken one
    is invisible until somebody clicks it.

    A page rather than a dialog since v0.39.0: Activity is about the whole box and
    about things that have already happened, which is not what an overlay is for.
    """
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("#btn-jobs")
        page.wait_for_selector("#act-tabs")
        page.click("#act-tab-history")
        page.wait_for_selector("#jobs-filter:not([hidden])")
        # the account that was just created is in the trail
        page.wait_for_function(
            "() => document.querySelector('#jobs-list').textContent.includes('alice')")
        assert page.errors == [], page.errors
