"""`houston.browser.kubernetes_dialogs`: its own spec file.

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

def test_the_seed_job_shows_what_it_made_and_whether_it_was_confirmed(
        serve, page, monkeypatch, tmp_path):
    """A seed job had no result renderer at all: the browser saw progress lines and
    then nothing, while the CLI printed a table. The readback verdict is the part
    worth showing -- it is the difference between "the seeder says it made 283
    messages" and "283 messages are in there"."""
    from houston.services import lifecycle as lcsvc

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    # The panel's live chart polls /stats for a RUNNING workspace, and this one has
    # no compose project on disk -- so the poll would shell out in a directory that
    # does not exist. The chart is not what this test is about.
    monkeypatch.setattr(lcsvc.runner.engine, "container_ids", lambda *a, **k: [])
    # The seed route reads the workspace record, which is a real file rather than
    # something `_stub_lifecycle` intercepts.
    import json as _json
    (tmp_path / "repros" / "t1234").mkdir(parents=True, exist_ok=True)
    (tmp_path / "repros" / "t1234" / "repro.json").write_text(_json.dumps({
        "name": "t1234", "project": "p", "rc_version": "7.4.1", "rc_image": "i",
        "mongo_tag": "7.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001,
        "version_source": "x", "extra": {}}))
    monkeypatch.setattr(lcsvc.seeding, "run_seed_inline", lambda *a, **k: {
        "users": 20, "messages": 283, "threads": 48, "rooms_total": 22, "dms": 5,
        "rooms": {"channel": 5, "team": 1, "discussion": 3, "dm": 5},
        "verification": {"ok": True, "faults": [], "extra": [], "unreadable": [],
                         "checked": 22}})
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        page.click("button:has-text('Add sample data')")
        page.wait_for_selector("#seed-dialog[open]")
        page.click("#seed-submit")
        page.wait_for_selector("#job-log", timeout=20000)
        page.wait_for_timeout(2500)
        body = page.text_content("#job-log")
        assert "match the plan" in body, body[-400:]
        assert "283 messages" in body and "48 in threads" in body
        assert "channel 5" in body and "discussion 3" in body
        assert page.errors == [], page.errors


def test_the_create_dialog_says_what_it_builds_and_what_the_box_has_left(
        serve, page, monkeypatch):
    """A card carries what a `<select>` could not: what this runtime BUILDS.

    It used to quote a memory estimate as well, and that came out: the figure
    depends on the preset, the arrangement and whatever else is running, so it was a
    guess dressed as a fact -- while the line beside it answers "will it fit" from
    the box itself, which is the question and is measured. `up` already REFUSES
    without headroom, so that belongs at the moment of choosing rather than in the
    failure afterwards.
    """
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        page.wait_for_function(
            "() => document.querySelector('#create-room').textContent.includes('free')",
            timeout=15000)
        assert "room for about" in page.locator("#create-room").inner_text()

        compose = page.locator("#runtime-forks button").first.inner_text()
        kube = page.locator("#runtime-forks button").nth(1).inner_text()
        assert "2 containers" in compose, compose
        # Microservices is not a monolith with a label, and the card says so.
        assert "9 pods" in kube, kube
        # And no invented weight on either.
        for card in (compose, kube):
            assert "GB" not in card and "MB" not in card, card
        assert page.errors == [], page.errors


def _a_page_offering_more_than_one_cluster(monkeypatch):
    """A create dialog rendered against a box with several clusters to choose between."""
    from houston.services import cluster as clustersvc
    from houston.services import k8s, users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")

    adopted = k8s.Preflight(tools={
        "kubectl": k8s.Tool(name="kubectl", path="/usr/bin/kubectl",
                            version=(1, 30, 0), raw="v1.30.0"),
        "helm": k8s.Tool(name="helm", path="/usr/bin/helm",
                         version=(3, 14, 0), raw="v3.14.0"),
    })
    adopted.context = "default"
    adopted.distribution = "k3s"
    adopted.cluster_reachable = True
    monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **k: adopted)
    monkeypatch.setattr(clustersvc, "known_contexts", lambda: {"contexts": [
        {"context": "arn:aws:eks:us-east-1:1:cluster/support", "ours": False,
         "provider": "eks", "billable": True, "is_default": True, "aliases": []},
        {"context": "default", "ours": False, "provider": "",
         "billable": False, "is_default": False, "aliases": []},
    ], "unreadable": "", "default": "arn:aws:eks:us-east-1:1:cluster/support"})


def test_the_runtime_card_names_no_cluster_because_it_cannot_know_which(
        page, serve, monkeypatch):
    """This test used to require the card to READ "Kubernetes (k3s)", and the reason
    was sound: it once read the literal "Kubernetes (kind)" and so named a cluster the
    create would not touch. The property being guarded is that the card must not name
    the WRONG cluster.

    It now names none, which satisfies that property for a reason the original could
    not have: the card is chosen BEFORE the cluster is. A picker sits under it offering
    EKS, kind and k3s, and the card does not re-render when that changes -- so any
    distribution in the label is guaranteed to be wrong for somebody. Reported from a
    real screen by somebody heading for EKS and told the card meant k3s, which reads as
    the wrong choice.

    The fact moved rather than vanished: the picker names the cluster that will
    actually be used, including when there is none and one will be built.
    """
    _a_page_offering_more_than_one_cluster(monkeypatch)

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.wait_for_function(
            "() => document.querySelector('#sb-engines')"
            ".textContent.includes('k3s')", timeout=15000)
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        page.wait_for_selector("#runtime-forks button")
        kube = page.locator("#runtime-forks button").nth(1).inner_text()

        # THE ORIGINAL FEAR, unchanged: no cluster the create would not use.
        assert "kind" not in kube, "named a cluster the create would not use"
        assert "k3s" not in kube, \
            "and naming the local one is that same mistake once EKS is on the picker"
        assert "Kubernetes" in kube

        # The fact is under it, where the choice is actually made.
        page.click("#runtime-forks >> text=Kubernetes")
        page.wait_for_timeout(600)
        opts = page.evaluate(
            "Array.from(document.querySelectorAll('#context-select option'))"
            ".map(o => o.textContent)")
        assert any("cluster/support" in o for o in opts), \
            "the picker must name the cluster that will actually be used"
        assert page.errors == [], page.errors


def test_the_arrangement_says_what_it_builds(serve, page, monkeypatch):
    """The note under the segmented control describes the ARRANGEMENT, which is the
    choice directly above it. It used to describe the runtime and repeat "HTTPS is
    not available here" -- the same fact the absence line in Advanced now states
    from the server's registry, and only one of the two would have been updated when
    that changes."""
    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        assert "One Rocket.Chat process" in page.locator("#runtime-hint").inner_text()
        page.locator("#runtime-forks button:has-text('Kubernetes')").click()
        note = page.locator("#runtime-hint").inner_text()
        assert "ddp-streamer" in note, note
        assert "HTTPS" not in note, "the refusal is stated once, in Advanced"
        page.locator("#deployment-seg button:has-text('monolith')").click()
        assert "One Rocket.Chat process" in page.locator("#runtime-hint").inner_text()
        assert page.errors == [], page.errors
