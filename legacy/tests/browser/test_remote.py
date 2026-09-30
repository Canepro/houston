"""`houston.browser.remote`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, PUBLIC_NAME, _fake_detail, _sign_in, _stub_lifecycle, browser as browser,
    page as page, public_browser as public_browser, public_page as public_page,
    serve as serve, serve_public as serve_public
)
from houston.services import users as usersvc

# --- reached from another machine ----------------------------------------------------
#
# The EC2 shape: one `serve` on a box everybody reaches over its address, and nobody
# has a shell on it. Every link this GUI renders is built from `localhost`, which for
# a browser somewhere else names the READER'S machine -- so the panel has to say what
# the address means from where the reader is standing.
#
# Nothing is detected to work that out. `remoteHost()` reads location.hostname, which
# is the address in the browser's own URL bar, and `serve_public`'s host-resolver rule
# makes that a real name rather than 127.0.0.1 -- the same fixture the plain-http
# sign-in defect needed, for the same reason.

def test_the_panel_says_that_localhost_means_the_readers_own_machine(
        serve_public, public_page, monkeypatch):
    """And says how to fix it -- without touching the URL it is talking about.

    ROOT_URL is Rocket.Chat's own advertised address and houston's 71 internal API
    calls go through it, so the notice is ADDITIVE: the URL row must still read
    exactly what the workspace was built with.
    """
    _stub_lifecycle(monkeypatch, _fake_detail(bind_host="127.0.0.1"))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve_public() as s:
        _sign_in(public_page, s.public_url)
        public_page.wait_for_selector("#repros")
        public_page.click("text=t1234")
        public_page.wait_for_selector("#d-body")
        public_page.wait_for_selector("#d-body .banner.warn")
        said = public_page.text_content("#d-body .banner.warn")
        assert PUBLIC_NAME in said, said
        assert "0.0.0.0" in said, said
        assert "admin/admin123" in said, said
        # THE URL IS UNTOUCHED. This is the whole constraint on the feature.
        assert public_page.text_content("#d-body .urlbox").find(
            "http://localhost:3001") >= 0
        assert public_page.errors == [], public_page.errors


def test_a_wide_bound_workspace_is_given_the_address_that_works_from_here(
        serve_public, public_page, monkeypatch):
    """Bound to 0.0.0.0 there is nothing to warn about -- only an address to state.

    Stated as text with a copy button rather than as a link: the links are built from
    the workspace's own root_url and stay that way.
    """
    _stub_lifecycle(monkeypatch, _fake_detail(bind_host="0.0.0.0"))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve_public() as s:
        _sign_in(public_page, s.public_url)
        public_page.wait_for_selector("#repros")
        public_page.click("text=t1234")
        public_page.wait_for_selector("#d-body")
        public_page.wait_for_function(
            "() => document.querySelector('#d-body').textContent"
            ".includes('From this machine')")
        body = public_page.text_content("#d-body")
        assert f"http://{PUBLIC_NAME}:3001" in body, body
        # Not the amber one: nothing is being asked of the reader.
        assert public_page.query_selector("#d-body .banner.warn") is None
        assert public_page.errors == [], public_page.errors


def test_a_local_browser_is_told_none_of_this(serve, page, monkeypatch):
    """On a laptop every localhost link is correct, so the notice would be noise.

    The same assertion proves the loopback branch of `remoteHost()`: this server is
    reached at 127.0.0.1, which is exactly what must NOT count as remote.
    """
    _stub_lifecycle(monkeypatch, _fake_detail(bind_host="127.0.0.1"))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .urlbox")
        assert page.query_selector("#d-body .banner.warn") is None
        assert "From this machine" not in page.text_content("#d-body")
        assert page.evaluate(
            "async () => (await import('/js/util.js')).remoteHost()"
        ) == ""
        assert page.errors == [], page.errors


def test_the_create_dialog_warns_a_remote_reader_about_the_default_bind(
        serve_public, public_page, monkeypatch):
    """The one fact a browser-only user cannot find out any other way: the workspace
    they are about to create will answer on the server and nowhere else.

    ONE LINE, and asserted as such. This was four sentences that restated what a reader
    could infer -- which machine they are browsing from, what loopback means -- above a
    form they were already filling in. The remote hostname is deliberately gone: it is in
    the address bar. What cannot be inferred is the bind, and what is a decision is the
    choice between a hostname and 0.0.0.0."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve_public() as s:
        _sign_in(public_page, s.public_url)
        public_page.wait_for_selector("#repros")
        public_page.click("#btn-new")
        public_page.wait_for_selector("#create-dialog[open]")
        public_page.wait_for_selector("#create-bind-hint:not([hidden])")
        said = public_page.text_content("#create-bind-hint")
        assert "0.0.0.0" in said, said
        assert "hostname" in said, "the safer of the two options has to be offered"
        assert "admin/admin123" in said, "and what 0.0.0.0 costs has to be attached to it"
        # A ceiling, because this grew to 388 characters one clause at a time.
        assert len(said) < 170, f"{len(said)} chars — this is a hint, not a paragraph"
        assert public_page.errors == [], public_page.errors


def test_the_create_dialog_stays_quiet_on_a_laptop(serve, page, monkeypatch):
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        assert page.is_hidden("#create-bind-hint")
        assert page.errors == [], page.errors
