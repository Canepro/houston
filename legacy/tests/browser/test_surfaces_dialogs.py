"""`houston.browser.surfaces_dialogs`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, _seed_stale_cert, _sign_in, _stub_lifecycle, browser as browser,
    page as page, serve as serve
)
from houston.services import users as usersvc

def test_the_create_dialog_opens_and_lists_presets(serve, page, monkeypatch):
    """The most-used dialog in the product, and nothing had ever rendered it."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        page.wait_for_function(
            "() => document.querySelector('#preset-select').options.length > 0")
        opts = page.eval_on_selector(
            "#preset-select", "s => [...s.options].map(o => o.value)")
        assert "default" in opts and "ldap" in opts, \
            f"the built-in presets are missing: {opts}"
        page.click("#create-cancel")
        # A closed <dialog> is not "hidden" in the way wait_for_selector means, so
        # ask the element itself.
        page.wait_for_function(
            "() => !document.querySelector('#create-dialog').open")
        assert page.errors == [], page.errors


def test_the_load_test_dialog_opens_from_the_panel(serve, page, monkeypatch):
    """Reached only from the detail panel's action row, so it needs a workspace to
    exist before it can be rendered at all — which is why nothing had rendered it."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        page.click("button:has-text('Load test')")
        page.wait_for_selector("#perf-dialog[open]")
        assert "t1234" in page.text_content("#perf-title")
        # `live` needs the monitoring stack, and the fixture says it is off
        assert page.is_disabled("#perf-form >> [name=live]"), \
            "the live option must be disabled without monitoring attached"
        page.click("#perf-cancel")
        page.wait_for_function("() => !document.querySelector('#perf-dialog').open")
        assert page.errors == [], page.errors


def test_the_doctor_dialog_renders_its_checks(serve, page, monkeypatch):
    """The badge could only ever say up/down. This is the panel that says WHY."""
    from houston.services import doctor as doctorsvc

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    monkeypatch.setattr(doctorsvc, "run_checks", lambda **_k: {
        "checks": [{"status": "ok", "message": "Docker daemon running (27.0.3)"},
                   # a fact the browser already shows permanently, and a PROBLEM
                   # about the same subject — only the first is the dialog's job
                   {"status": "ok", "message": "Edge running — holds :80/:443",
                    "elsewhere": "the edge chip in the header"},
                   {"status": "warn", "message": "1 edge route(s) with no workspace"},
                   {"status": "fail",
                    "message": "2 GB free - a workspace needs about 6"}],
        "counts": {}, "verdict": "fail",
        "repros": {"total": 1, "running": 1}})

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#doctor-badge")
        page.click("#doctor-badge")
        page.wait_for_selector("#doctor-dialog[open]")
        page.wait_for_function(
            "() => !document.querySelector('#doctor-body').textContent.includes('Checking')")
        body = page.text_content("#doctor-body")
        assert "Docker daemon running" in body
        assert "a workspace needs about 6" in body, "the reason has to reach the screen"
        assert "Edge running" not in body, \
            "a row the header already carries was restated in the diagnostic"
        assert "no workspace" in body, \
            "a WARNING was dropped along with the fact it shares a subject with"
        # `houston doctor` prints a repro tally because a terminal has nowhere
        # else to say it. The rail lists them by name, behind this dialog.
        assert "1 total, 1 running" not in body
        page.click("#doctor-close")
        assert page.errors == [], page.errors


def test_the_edge_badge_surfaces_an_unreachable_route(serve, page, monkeypatch):
    """A route the edge cannot reach answers 502 rather than erroring, so it looks
    like a broken workspace instead of a broken route. Surfacing that is the whole
    reason the badge exists.

    Deliberately NOT the empty state: refreshEdgeBadge() hides the badge when no
    edge is installed, so "No edge yet" is unreachable from it and a test clicking
    there would only ever have proved the badge was hidden.
    """
    from houston.services import edge as edgesvc

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    monkeypatch.setattr(edgesvc.runtime, "status", lambda: {
        "installed": True, "running": True, "routes": ["t1234", "t9999"],
        "attached": ["houston-t1234_default"]})
    monkeypatch.setattr(edgesvc.spec, "served_domain", lambda: "support.example.com")
    monkeypatch.setattr(edgesvc.networks, "workspace_network",
                        lambda n: f"houston-{n}_default")

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#edge-badge:not([hidden])")
        assert "1 unreachable" in page.text_content("#edge-badge"), \
            "t9999's network is not attached, so the edge cannot reach it"
        page.click("#edge-badge")
        page.wait_for_selector("#edge-dialog[open]")
        assert "t9999" in page.text_content("#edge-body")
        page.click("#edge-close")
        page.wait_for_function("() => !document.querySelector('#edge-dialog').open")
        assert page.errors == [], page.errors


def test_an_admin_can_delete_a_certificate_nothing_points_at(serve, page, monkeypatch):
    """`down --volumes` removes a workspace's ROUTE and walks past its certificate,
    which is keyed by hostname -- so a Let's Encrypt certificate AND private key for
    a name nobody serves stays on the box. An operator handed `serve` and no shell
    had no way to see that, let alone remove it.
    """
    from houston.services import edge as edgesvc

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    host = _seed_stale_cert()
    monkeypatch.setattr(edgesvc.runtime, "status", lambda: {
        "installed": True, "running": True, "routes": [], "attached": []})
    monkeypatch.setattr(edgesvc.spec, "served_domain", lambda: "")
    # Deleting an ACME entry restarts the edge so Traefik reloads the store; there
    # is no Traefik here, and starting one is not what this test is about.
    monkeypatch.setattr(edgesvc.engine, "running", lambda: False)
    monkeypatch.setattr(edgesvc.engine, "foreign_edge", lambda: "")

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#edge-badge:not([hidden])")
        page.click("#edge-badge")
        page.wait_for_selector("#edge-dialog[open]")
        assert "certificate held with no route" in page.text_content("#edge-body")
        assert host in page.text_content("#edge-body")

        page.on("dialog", lambda d: d.accept())
        page.click("#edge-body button.danger")
        page.wait_for_function(
            "() => !document.querySelector('#edge-body').textContent"
            ".includes('old-ticket-991')")
        assert edgesvc.acme_hosts() == [], "the store on disk, not just the DOM"
        assert page.errors == [], page.errors


def test_a_member_is_not_offered_the_delete_at_all(serve, page, monkeypatch):
    """ABSENT, not disabled -- the rule this GUI uses everywhere. The route is admin
    in ROUTE_ROLES, so a member clicking it would get a 403 toast; showing them a
    control that can only fail is the thing the rule exists to prevent.

    They still SEE the row: knowing the box is holding a stray private key is not
    privileged, and a member who can see it can ask someone who can remove it.
    """
    from houston.services import edge as edgesvc

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    usersvc.add("bob", "bobs-good-password", role="member")
    host = _seed_stale_cert()
    monkeypatch.setattr(edgesvc.runtime, "status", lambda: {
        "installed": True, "running": True, "routes": [], "attached": []})
    monkeypatch.setattr(edgesvc.spec, "served_domain", lambda: "")

    with serve() as s:
        _sign_in(page, s.url, user="bob", password="bobs-good-password")
        page.wait_for_selector("#edge-badge:not([hidden])")
        page.click("#edge-badge")
        page.wait_for_selector("#edge-dialog[open]")
        assert host in page.text_content("#edge-body")
        assert page.locator("#edge-body button.danger").count() == 0
        assert page.errors == [], page.errors


def _a_box_whose_policy_allows_one_thing(monkeypatch, page):
    """A signed-in page on a box whose create policy is narrower than the role."""
    from houston import config as cfgmod
    from houston.services import lifecycle as lcmod

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    usersvc.add("mem", "members-good-password", role="member")

    def open_dialog():
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        # These fields live inside <details class="adv">, which is COLLAPSED. Without
        # expanding it every one of them is invisible whatever the policy says, and
        # an is_hidden() assertion passes for the wrong reason -- the first version
        # of this test did exactly that and would have passed against the bug.
        page.eval_on_selector_all(
            "#create-dialog details.adv", "ds => ds.forEach(d => d.open = true)")
        page.wait_for_selector("#create-form [name=mongo]", state="visible")
    return cfgmod, lcmod, open_dialog


def test_the_create_dialog_follows_the_box_policy_not_the_role(serve, page,
                                                               monkeypatch):
    """The dialog offered rc_image / reg_token / bind to everybody while the API
    refused them from a non-admin, so a member could fill one in and have the whole
    create fail -- app.py's comment claimed the GUI "never sends them for a member".

    It asks the SERVER now (GET /api/settings -> may_set_privileged), so the box
    policy reaches the interface too. Two places computing one permission is what
    produced the mismatch in the first place.

    Open is the DEFAULT: a member can already create workspaces and tear them down
    with their data, so withholding the interface their own listens on is an
    inconsistent ladder rather than a boundary.

    `port` is deliberately always offered: it is not privileged any more, because
    the privileged-port range it might have guarded is refused for everyone anyway.
    """
    cfgmod, lcmod, open_dialog = _a_box_whose_policy_allows_one_thing(monkeypatch, page)

    with serve() as s:
        _sign_in(page, s.url, user="mem", password="members-good-password")
        page.wait_for_selector("#btn-new")
        open_dialog()
        for name in lcmod.PRIVILEGED_CREATE_FIELDS:
            if name == "context":
                continue        # governed by TWO rules; asserted on its own below
            assert page.is_visible(f"#create-form [name={name}]"), \
                f"a member is not offered {name!r}, which the server accepts"
        # `context` is the first field governed by the box policy AND by the runtime:
        # it picks a CLUSTER, which means nothing on Compose. So "the server accepts
        # it" is only half the question here, and offering it on Docker would be the
        # bug -- this dialog's rule is that a field with no meaning is ABSENT.
        assert page.is_hidden("#create-form [name=context]"), \
            "a cluster picker has no meaning on Compose"
        page.locator("#runtime-forks button:has-text('Kubernetes')").click()
        assert page.is_visible("#create-form [name=context]"), \
            "a member is not offered a cluster on Kubernetes, which the server accepts"
        page.locator("#runtime-forks button:has-text('Docker Compose')").click()
        assert page.is_visible("#create-form [name=port]"), \
            "a host port is a member's to choose"
        page.click("#create-cancel")
        page.wait_for_function("() => !document.querySelector('#create-dialog').open")

        # ...and a box that narrows the policy: the same member, same session.
        cfgmod.update_config(
            lambda c: c.__setitem__(lcmod.CREATE_POLICY_KEY, "admin"))
        open_dialog()
        for name in lcmod.PRIVILEGED_CREATE_FIELDS:
            assert page.is_hidden(f"#create-form [name={name}]"), \
                f"gui.create_policy=admin did not reach the dialog for {name!r}"
        # And for `context`, on the runtime where it WOULD otherwise be offered --
        # hidden on Compose proves nothing about it, since it is hidden there anyway.
        page.locator("#runtime-forks button:has-text('Kubernetes')").click()
        assert page.is_hidden("#create-form [name=context]"), \
            "gui.create_policy=admin did not reach the cluster picker on Kubernetes"
        assert page.errors == [], page.errors


def test_https_is_in_section_two_and_is_still_not_a_second_twisty(serve, page,
                                                                  monkeypatch):
    """This test used to assert HTTPS lived inside Advanced options. It no longer
    does, and the distinction matters: the failure it was written for was TWO SIBLING
    TWISTIES making the form look like it had two Advanced sections, and being inside
    Advanced was one way to avoid that rather than the point itself.

    HTTPS is now a titled group in section 2, beside the cluster. It is not a
    disclosure, so the original failure cannot recur -- and there is a reason it moved:
    on a managed cluster the domain decides whether the workspace has a real address at
    all, and it was the LAST field inside a collapsed Advanced, two clicks and a scroll
    from the cluster choice it depends on.

    The second half of the original test is kept exactly, because it guards the half a
    move like this quietly breaks: that the mode selector still drives its fields.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")

        # THE ORIGINAL FEAR, unchanged: one Advanced disclosure, and HTTPS is not a
        # second one.
        assert page.locator("#create-dialog details.adv").count() == 1, \
            "the form has more than one Advanced disclosure again"
        assert page.eval_on_selector(
            "#create-https-block", "el => !el.closest('details')"), \
            "HTTPS must not become a disclosure of its own"
        # collapsed by default, so Advanced is still not in anybody's way
        assert page.eval_on_selector("#create-dialog details.adv", "d => d.open") is False

        # And it is reachable without opening anything.
        assert page.is_visible("#create-https-block")
        assert page.eval_on_selector(
            "#create-https-block",
            "el => el.closest('section') === document.querySelector('#runtime-forks')"
            ".closest('section')"), "HTTPS belongs with 'where it runs'"

        # The mode selector still drives the Let's Encrypt fields.
        assert page.locator("input[name=domain]").is_hidden()
        page.select_option("#https-mode", "acme")
        assert page.locator("input[name=domain]").is_visible()
        assert page.locator("input[name=acme_email]").is_visible()
        page.select_option("#https-mode", "local")
        assert page.locator("input[name=domain]").is_hidden()
        assert page.text_content("#https-mode-hint").strip() != ""
        assert page.errors == [], page.errors


def test_you_can_change_your_own_password_from_the_browser(serve, page):
    """POST /api/me/password has existed since v0.23.0 — role-gated, throttled like
    a login, requires the current password, ends every other session and keeps this
    one. NOTHING in the browser called it. It was built and unreachable.

    The end-to-end property: change it, stay signed in, and the new password is the
    one that works.
    """
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#whoami:not([hidden])")
        page.click("#whoami")
        page.wait_for_selector("#me-menu:not([hidden])")
        page.click("#me-passwd")
        page.wait_for_selector("#passwd-dialog[open]")

        # the current password is genuinely required
        page.fill("#passwd-form [name=old]", "not-my-password")
        page.fill("#passwd-form [name=new]", "a-brand-new-password")
        page.click("#passwd-go")
        page.wait_for_selector("#passwd-err:not([hidden])")
        assert "not your current password" in page.text_content("#passwd-err")

        page.fill("#passwd-form [name=old]", PASSWORD)
        page.click("#passwd-go")
        page.wait_for_function("() => !document.querySelector('#passwd-dialog').open")

        # still signed in — the endpoint re-issues this session on purpose
        page.reload()
        page.wait_for_selector("#whoami:not([hidden])")
        assert page.text_content("#whoami").strip() == "alice"
        assert usersvc.verify("alice", "a-brand-new-password") is True
        assert usersvc.verify("alice", PASSWORD) is False
        assert page.errors == [], page.errors
