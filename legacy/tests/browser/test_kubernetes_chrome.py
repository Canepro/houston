"""`houston.browser.kubernetes_chrome`: its own spec file.

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

def test_the_top_links_become_one_menu_on_a_narrow_screen(serve, page, monkeypatch):
    """Four links, a theme toggle and an account name wrapped onto a second row of
    chrome below 760px -- on a 430px screen that is a quarter of the height spent
    before anything has been said about a workspace.

    The same four buttons move into a popover; there is no second copy of them, because
    two sets of the same controls is two things to keep in step and they drift.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.set_viewport_size({"width": 430, "height": 780})
        page.wait_for_timeout(200)
        assert page.locator("#nav-toggle").is_visible(), "no way to reach the links"
        assert not page.locator("#btn-jobs").is_visible(), "they are still on the bar"
        # One set of buttons, not two.
        assert page.locator("#btn-jobs").count() == 1
        page.click("#nav-toggle")
        page.wait_for_selector("#btn-jobs", state="visible")
        assert page.get_attribute("#nav-toggle", "aria-expanded") == "true"
        page.click("#btn-jobs")
        page.wait_for_function(
            "() => document.querySelector('#btn-jobs').hasAttribute('aria-current')")
        # and choosing one puts the menu away
        assert not page.locator("#btn-jobs").is_visible()
        # Back on a wide screen they are links again, with no hamburger.
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(200)
        assert page.locator("#btn-jobs").is_visible()
        assert not page.locator("#nav-toggle").is_visible()
        assert page.errors == [], page.errors


def test_the_header_is_the_doctor_button_and_the_footer_names_both_engines(
        serve, page, monkeypatch):
    """The header said "docker: up". That was the whole environment when Docker was the
    only runtime; it is one engine of two now, and it made the one control that answers
    "is this box usable" look like a status label.

    So the header says what it DOES and the footer says what each engine is doing --
    because a workspace can run in either and the answer for one says nothing about the
    other.
    """
    _stub_lifecycle(monkeypatch, _fake_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#doctor-badge")
        assert page.text_content("#doctor-badge").strip() == "doctor"
        # The footer names both, whatever the cluster answer turns out to be here.
        page.wait_for_function(
            "() => !document.querySelector('#sb-engines').textContent.includes('k8s: ?')")
        footer = page.text_content("#sb-engines")
        assert footer.startswith("docker: "), footer
        # "not set up" is what an empty Preflight means, and it is a real state: a box
        # with no kubectl. The cluster-shaped wording is asserted below.
        assert "k8s: not set up" in footer, footer
        # And it is still the way to the report.
        page.click("#doctor-badge")
        page.wait_for_selector("#doctor-dialog[open]")
        assert page.errors == [], page.errors


def test_the_doctor_chip_goes_red_only_when_nothing_can_run_a_workspace(
        serve, page, monkeypatch):
    """Docker being down is not a broken box on a machine whose Kubernetes is up, and
    colouring the chip red there would be crying wolf at somebody whose k3s works. Red
    means nothing here can run a workspace at all."""
    _stub_lifecycle(monkeypatch, _fake_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#doctor-badge")
        classes = page.evaluate("""async () => {
          await import('/js/main.js');
          const {ctx} = await import('/js/shared.js');
          const {paintEngines} = await import('/js/util.js');
          const badge = document.querySelector('#doctor-badge');
          const out = {};
          ctx.DOCKER_OK = false; ctx.KUBE = {usable: true, reachable: true,
                                     distribution: 'k3s', context: 'default'};
          paintEngines();
          out.dockerDownKubeUp = badge.className;
          out.footer = document.querySelector('#sb-engines').textContent;
          ctx.DOCKER_OK = false; ctx.KUBE = {usable: false, reachable: false};
          paintEngines();
          out.bothDown = badge.className;
          ctx.DOCKER_OK = true; ctx.KUBE = null;
          paintEngines();
          out.dockerOnly = badge.className;
          return out;
        }""")
        assert "up" in classes["dockerDownKubeUp"], \
            "a working k3s is not a broken box just because Docker is off"
        assert "k3s default" in classes["footer"], classes["footer"]
        assert "down" in classes["bothDown"], "nothing can run: that is red"
        assert "up" in classes["dockerOnly"]
        assert page.errors == [], page.errors


def test_in_progress_shows_only_jobs_that_are(serve, page, monkeypatch):
    """The tab is labelled "In progress" and rendered every retained job, so finished
    and failed ones sat under it — making the one question it exists to answer, "is
    anything running", unanswerable.

    `jobActive` already existed and was already used by the job dialog; this view
    simply did not consult it.
    """
    import json

    _stub_lifecycle(monkeypatch, _fake_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.route("**/api/jobs", lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"jobs": [
                {"id": "j1", "kind": "create", "label": "a", "status": "running"},
                {"id": "j2", "kind": "backup", "label": "b", "status": "queued"},
                {"id": "j3", "kind": "create", "label": "c", "status": "done"},
                {"id": "j4", "kind": "seed", "label": "d", "status": "error"}]})))
        page.click("#btn-jobs")
        page.wait_for_selector("#jobs-list")
        page.wait_for_timeout(400)
        shown = page.evaluate(
            """() => [...document.querySelectorAll('#jobs-list .jstatus')]
                       .map((e) => e.textContent)""")
        assert sorted(shown) == ["queued", "running"], (
            shown, page.inner_html("#jobs-list")[:400])
        assert page.errors == [], page.errors
