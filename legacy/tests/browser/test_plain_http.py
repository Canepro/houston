"""`houston.browser.plain_http`: its own spec file.

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

def test_signing_in_works_over_plain_http_on_a_real_hostname(serve_public, public_page):
    """The defect a support engineer hit on a shared AWS box, and the reason the
    GUI could not be used there at all.

    `houston serve --bind 0.0.0.0 --allow-host <name> --insecure` serves the login
    over plain http on a public name. A browser attaches `Sec-Fetch-*` only to a
    potentially trustworthy URL, which that is not -- so the guard fell through to
    `Origin`, and the page's own `Referrer-Policy: no-referrer` had already nulled
    it (per Fetch, a non-CORS POST's Origin follows the referrer policy). The guard
    cannot match "null" against the allow-list, so every sign-in was answered
    `{"error": "cross-site request refused"}` and there was no way into the GUI.

    Nothing localhost-shaped reproduces it: 127.0.0.1 IS potentially trustworthy,
    so there the `Sec-Fetch-Site: same-origin` branch answers first and the null
    Origin is never consulted.
    """
    usersvc.add("alice", PASSWORD, role="admin")
    with serve_public() as s:
        _sign_in(public_page, s.public_url)
        public_page.wait_for_load_state()
        # Checked before waiting on any selector, so the refusal reports itself
        # instead of arriving 30s later as "#repros never appeared".
        assert "cross-site request refused" not in public_page.content(), \
            "the sign-in form POST was refused as cross-site"
        public_page.wait_for_selector("#repros")
        # `#whoami` is filled by app.js after /api/session answers, so reading it
        # the moment #repros exists is a race -- it passed on a fast laptop and
        # failed in CI with `assert '' == 'alice'`. Every other test in this file
        # waits for the :not([hidden]) form; this one has to as well.
        public_page.wait_for_selector("#whoami:not([hidden])")
        assert public_page.text_content("#whoami").strip() == "alice"
        assert public_page.errors == [], public_page.errors


def test_a_write_from_the_spa_survives_plain_http_on_a_real_hostname(serve_public,
                                                                    public_page):
    """The same missing `Sec-Fetch-*` reaches every `fetch()` the SPA makes.

    A same-origin POST/DELETE also carries its Origin per the referrer policy, so
    with `no-referrer` every write from the dashboard was a 403 too -- signing in
    was merely the first thing that could not be done.

    The pass is "the guard did not eat it", not a particular status. Asserting 404
    tied this to the engine: resolve_name() shells out to docker, so without it the
    handler answers 502 and the test failed for a reason it is not about.
    """
    usersvc.add("alice", PASSWORD, role="admin")
    with serve_public() as s:
        _sign_in(public_page, s.public_url)
        public_page.wait_for_load_state()
        # Pre-fix this is where it stops: the login itself was refused, so the
        # write below could not even be reached to be measured.
        assert "cross-site request refused" not in public_page.content(), \
            "the sign-in form POST was refused as cross-site"
        public_page.wait_for_selector("#repros")
        res = public_page.evaluate(
            """async () => {
                const r = await fetch('/api/repros/does-not-exist', {
                    method: 'DELETE', credentials: 'same-origin' });
                return {status: r.status, text: (await r.text()).slice(0, 200)};
            }""")
        assert res["status"] != 403, \
            f"the guard refused a same-origin write ({res['status']}: {res['text']})"
        assert "cross-site" not in res["text"], res["text"]


def test_a_link_row_shows_the_workspaces_root_url_verbatim(serve_public, public_page,
                                                          monkeypatch):
    """One workspace, one address, everywhere: the ROOT_URL the server reported.

    The panel used to show two. `localUrl()` swapped `localhost` for whatever host
    the GUI was loaded from -- applied to the href but not the label, so "What is in
    this workspace" read http://localhost:3000 while the URL row below it read
    http://<gui-host>:3000/. The rewrite is gone entirely: ROOT_URL is what Rocket
    .Chat itself is configured with, so it is the address that identifies the
    workspace, and a number that appears in no config file is not an improvement on
    it.

    Never caught because `_fake_detail()` carries `"links": []`, so no browser test
    had ever rendered one of these rows.
    """
    d = _fake_detail()
    d["links"] = [{"label": "Rocket.Chat", "url": "http://localhost:3001", "kind": ""}]
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve_public() as s:
        _sign_in(public_page, s.public_url)
        public_page.wait_for_selector("#repros")
        public_page.wait_for_selector("#whoami:not([hidden])")
        public_page.click("text=t1234")
        public_page.wait_for_selector(".linkrow")
        row = public_page.locator(".linkrow").first
        shown = row.locator(".l-u").inner_text().strip()
        href = row.get_attribute("href")
        assert shown == "http://localhost:3001", shown
        assert href == "http://localhost:3001", href
        assert shown == href, "the row must open exactly what it displays"
        # The GUI is being viewed at a public name; that must not leak into the url.
        assert PUBLIC_NAME not in shown and PUBLIC_NAME not in href
        assert public_page.errors == [], public_page.errors


def test_a_placeholder_url_in_a_link_row_is_left_alone(serve_public, public_page,
                                                       monkeypatch):
    """A preset note can name a place as `<repro-url>/livechat` rather than a real
    url. That is not a URL and must not go through the host rewrite, which would
    turn it into `http://<host>/<repro-url>/livechat`."""
    d = _fake_detail()
    d["links"] = [{"label": "Livechat", "url": "<repro-url>/livechat", "kind": ""}]
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve_public() as s:
        _sign_in(public_page, s.public_url)
        public_page.wait_for_selector("#repros")
        public_page.wait_for_selector("#whoami:not([hidden])")
        public_page.click("text=t1234")
        public_page.wait_for_selector(".linkrow")
        shown = public_page.locator(".linkrow").first.locator(".l-u").inner_text().strip()
        assert shown == "<repro-url>/livechat", shown
        assert public_page.errors == [], public_page.errors


def test_the_workspace_row_says_kubernetes_and_stays_quiet_about_docker(
        serve, page, monkeypatch):
    """A Kubernetes workspace must never look like a Compose one in the list.

    Which commands refuse, where the data lives and how to reach it all differ, and
    the row was the one place the two were indistinguishable. Shown only when it is
    NOT the default: Compose is the overwhelming majority, so labelling every row
    "docker" would be noise on the common case and make the rare one HARDER to spot.
    """
    from houston.services import lifecycle as lc

    rows = [dict(_fake_detail(name="kube-one"), runtime="kubernetes"),
            dict(_fake_detail(name="compose-one"), runtime="docker")]
    monkeypatch.setattr(lc.inspect, "list_repros", lambda: [dict(r) for r in rows])
    monkeypatch.setattr(lc.payload, "detail", lambda name: dict(rows[0]))
    monkeypatch.setattr(lc.naming, "resolve_name", lambda name: name)
    usersvc.add("alice", PASSWORD, role="admin")

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.wait_for_function(
            "() => document.querySelector('#repros').textContent.includes('kube-one')")
        kube = page.locator(".wrow", has_text="kube-one").locator(".meta").inner_text()
        compose = page.locator(".wrow", has_text="compose-one").locator(".meta").inner_text()

    assert "k8s" in kube, kube
    assert "docker" not in compose and "k8s" not in compose, compose


def _the_arrangement_follows_the_runtime_back(arrangement, fork, page):
    """Switching back to Docker takes away what only Kubernetes could offer."""
    # An arrangement the user PICKS must stick. Wiring the runtime handler to
    # this control too made every choice snap back to the runtime default:
    # picking monolith on Kubernetes created a microservices workspace, and the
    # dialog looked correct throughout. Found by clicking, not by a test.
    page.locator("#deployment-seg button:has-text('monolith')").click()
    assert arrangement() == "monolith"
    assert page.locator("#replicas-row").is_hidden(), \
        "replicas mean nothing on a monolith"
    page.locator("#deployment-seg button:has-text('microservices')").click()
    assert arrangement() == "microservices"

    # Back to Compose and HTTPS returns -- the hiding is a consequence of the
    # choice, not a one-way door. So does the option that deletes data.
    fork("Docker Compose").click()
    assert page.eval_on_selector("#create-https-block", "e => e.hidden") is False
    assert page.locator("#mongo-operator").count() == 0
    assert page.eval_on_selector("#adv-gone", "e => e.hidden") is True
    opts = page.eval_on_selector_all(
        "select[name=existing] option", "es => es.map(e => e.textContent)")
    assert any("DELETE" in o for o in opts), opts


def _an_unsupported_field_is_absent_not_disabled(page):
    """What the server says it cannot do, and the controls that therefore are not there."""
    # AND THE REMOVAL PATH, driven directly, because no runtime refuses `--domain`
    # any more and it would otherwise be untested code that a future one relies
    # on. The re-add is the half that breaks: taking an option away is easy and
    # putting it back in the right place is what gets forgotten.
    def modes_for(unsupported):
        page.evaluate(
            "async u => (await import('/js/clusters.js'))"
            ".syncAdvancedForRuntime({unsupported: u})",
            unsupported,
        )
        return page.eval_on_selector_all(
            "#https-mode option", "es => es.map(e => e.value)")

    assert "acme" not in modes_for([{"field": "domain"}]), "removed, not disabled"
    assert "local" in modes_for([{"field": "domain"}]), "the block itself stays"
    assert "acme" in modes_for([]), "and it comes back"
    assert page.eval_on_selector("#create-https-block", "e => e.hidden") is False
    # Refusing HTTPS itself is what takes the whole block, and only that.
    assert page.eval_on_selector(
        "#create-https-block", "e => e.hidden") is False
    modes_for([{"field": "https"}])
    assert page.eval_on_selector("#create-https-block", "e => e.hidden") is True
    # Back to what this runtime ACTUALLY refuses, because the assertions below
    # continue from here -- driving the function directly means owning the state
    # it leaves behind.
    modes_for([{"field": "fresh"}])
    assert page.eval_on_selector("#create-https-block", "e => e.hidden") is False
    # `fresh` is one OPTION of the existing-name select, not the whole control:
    # reuse and force work on both runtimes.
    opts = page.eval_on_selector_all(
        "select[name=existing] option", "es => es.map(e => e.textContent)")
    assert not any("DELETE" in o for o in opts), opts
    assert any("Reuse" in o for o in opts), opts


def _https_is_offered_where_it_is_possible(page):
    """The HTTPS block, and the advanced options a runtime simply does not have."""
    # HTTPS STAYS, and it used to go away here. The chart's own Ingress and a
    # cert-manager `ca` issuer made `--https` real on this runtime, so the field
    # must be offered -- and the GUI got that for free, because `app.js` hides
    # exactly the fields `/api/settings` names and nothing more. A copy of the
    # list in JS would still be hiding this control.
    #
    # `hidden` rather than is_visible: the HTTPS block lives inside the Advanced
    # disclosure, so is_visible() would be answering about the twisty.
    assert page.eval_on_selector("#create-https-block", "e => e.hidden") is False
    # And the form still says what it DID take away, from the server's own
    # registry -- which is now only the destructive rebuild.
    assert page.eval_on_selector("#adv-gone", "e => e.hidden") is False
    # textContent, not inner_text: this line lives inside the same closed
    # <details>, and inner_text answers "" for anything a closed twisty hides --
    # which would pass whatever the text said.
    gone = page.eval_on_selector("#adv-gone", "e => e.textContent")
    assert "HTTPS" not in gone, gone
    assert "domain" not in gone, gone
    assert "DELETE data" in gone, gone
    # BOTH certificate modes are offered, because both are built: `--https` from a
    # `ca` ClusterIssuer holding houston's CA, `--domain` from an ACME one.
    modes = page.eval_on_selector_all(
        "#https-mode option", "es => es.map(e => e.value)")
    assert "local" in modes and "acme" in modes, modes


def test_the_create_dialog_offers_a_runtime_and_follows_it(serve, page, monkeypatch):
    """You could not create a Kubernetes workspace from the GUI at all -- the axes
    existed on CreateReq and in the CLI, and the dialog had no control for either.

    The options come from /api/settings, never a list written in JS: the same
    reasoning as the privileged fields, where two places deciding the same thing
    made the dialog offer a field the API rejected.

    And picking Kubernetes has to CHANGE the form, not just the value sent:
    multi-instance does not exist there, microservices does not exist on Compose,
    the MongoDB operator is Kubernetes-only, and HTTPS is refused by the service
    layer -- so offering it would produce a create that fails on submit.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")

        # The runtime is a pair of CARDS now, not a select: it decides what the
        # other twenty-odd fields mean, and the two facts that decide it -- what it
        # costs and what it cannot do -- have nowhere to live inside an <option>.
        # The assertions below are the same ones; only the widget moved.
        def fork(name):
            return page.locator(f"#runtime-forks button:has-text('{name}')")

        def arrangement():
            return page.locator("#deployment-seg button[aria-pressed='true']").inner_text()

        def arrangements():
            return page.locator("#deployment-seg button").all_inner_texts()

        # Compose is the default and its arrangement list is Compose's.
        assert page.locator("#runtime-value").input_value() == "docker"
        assert fork("Docker Compose").get_attribute("aria-pressed") == "true"
        assert any("monolith" in d for d in arrangements()), arrangements()
        assert any("multi-instance" in d for d in arrangements()), arrangements()
        assert not any("microservices" in d for d in arrangements()), arrangements()
        assert page.locator("#mongo-operator").count() == 0
        # A card carries what a select could not: what this runtime BUILDS.
        assert "containers" in fork("Docker Compose").inner_text()
        assert "pods" in fork("Kubernetes").inner_text()

        fork("Kubernetes").click()
        assert any("microservices" in d for d in arrangements()), arrangements()
        # The RUNTIME'S default, not the one Compose had selected: `--runtime k8s`
        # on the CLI defaults to microservices, and the two must not disagree.
        assert arrangement() == "microservices"
        assert not any("multi-instance" in d for d in arrangements()), arrangements()
        # Kubernetes-only control appears.
        assert page.locator("#mongo-operator").count() == 1
        _https_is_offered_where_it_is_possible(page)

        _an_unsupported_field_is_absent_not_disabled(page)

        _the_arrangement_follows_the_runtime_back(arrangement, fork, page)


def test_creating_a_kubernetes_workspace_sends_the_axes(serve, page, monkeypatch):
    """The payload is what matters: a dialog that renders the control and posts
    nothing extra would look right and build a Compose workspace."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        sent = []

        # POST ONLY. `page.route` matches every method, and the dashboard polls GET
        # /api/repros every four seconds (POLL_MS in app.js) -- so a poll landing
        # first put a GET at sent[0], whose post_data is None, and the assertion below
        # died on `json.loads(None)` instead of saying anything useful. It also
        # answered that poll with `{"job_id": "j1"}`, giving the dashboard a nonsense
        # workspace list mid-test. Rare on an idle box, seen once in a full-suite run
        # on a loaded one; a test that fails one run in ten teaches people to re-run
        # rather than read, which is worse than a test that does not exist.
        def _capture(route):
            if route.request.method != "POST":
                route.continue_()
                return
            sent.append(route.request.post_data)
            route.fulfill(status=200, content_type="application/json",
                          body='{"job_id": "j1"}')

        page.route("**/api/repros", _capture)
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        assert page.errors == [], page.errors
        page.fill("input[name=version]", "8.5.1")
        page.locator("#runtime-forks button:has-text('Kubernetes')").click()
        page.locator("#deployment-seg button:has-text('microservices')").click()
        page.check("input[name=mongo_operator]")
        page.click("#create-submit")
        for _ in range(40):
            if sent:
                break
            page.wait_for_timeout(100)

    assert sent, "the create was never POSTed"
    assert sent[0] is not None, "a POST with no body reached the route"
    import json as _json
    body = _json.loads(sent[0])
    assert body["runtime"] == "kubernetes", body
    assert body["deployment"] == "microservices", body
    assert body["mongo_operator"] is True, body
