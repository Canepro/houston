"""`houston.browser.clusters`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, _CL_ARN, _CL_PERF, _fake_cluster_status, _sign_in, _stub_clusters,
    browser as browser, page as page, serve as serve
)

def test_the_clusters_view_never_shows_a_zero_it_did_not_read(serve, page, monkeypatch):
    """The ledger's whole discipline, in the place a person actually reads it.

    A cluster that refused must show `?` in every count and say WHY -- "0 workspaces,
    nothing costing you money" is the sentence that lets a bill run, and it is the one
    thing this screen must never print about a cluster it could not reach.
    """
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    _stub_clusters(monkeypatch)
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-clusters")
        page.click("#btn-clusters")
        page.wait_for_selector(".cl-card", timeout=15000)
        page.wait_for_timeout(900)

        cards = page.query_selector_all(".cl-card")
        assert len(cards) == 2, "one card per context"

        good, bad = cards[0].inner_text(), cards[1].inner_text()
        assert "2× t3.large" in good and "$0.3523/hr" in good
        # The refusing one: unknown everywhere, and the cause named rather than guessed.
        assert "?" in bad
        assert "refusing" in bad
        assert "refused these credentials" in bad
        assert "create-access-entry" in bad, "the advice must point at the access entry"
        assert "unknown, not zero" in bad.lower()
        assert page.errors == []


def test_the_cluster_chip_wants_you_in_amber_and_is_never_red(serve, page, monkeypatch):
    """Colour is a signal here: red means about to destroy something.

    A cluster that is merely expensive is not that, and `.chip.down` -- the only
    non-green chip that existed -- is red. Painting the ledger with it would have said
    "destruction" about a running cluster somebody is deliberately paying for.
    """
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    _stub_clusters(monkeypatch)
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#cluster-badge:not([hidden])", timeout=15000)
        page.click("#btn-clusters")
        page.wait_for_timeout(1200)
        cls = page.get_attribute("#cluster-badge", "class")
        assert "warn" in cls, "one cluster is refusing, which is exactly 'wants you'"
        assert "down" not in cls, "red is for destroying something, not for a bill"
        assert page.errors == []


def test_only_an_admin_is_offered_the_controls_that_spend_or_destroy(serve, page, monkeypatch):
    """Building a cluster costs money and deleting one is irreversible.

    A readonly session still SEES the ledger -- that is the point of it -- and is
    offered neither control. The role is resolved before the cards paint, because it
    arrives on the four-second poll and drawing first produced an admin's cards with a
    readonly user's buttons, differently on each run.
    """
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    usersvc.add("ronly", "read-only-password", role="readonly")
    _stub_clusters(monkeypatch)
    with serve() as s:
        _sign_in(page, s.url, user="ronly", password="read-only-password")
        page.wait_for_selector("#btn-clusters")
        page.click("#btn-clusters")
        page.wait_for_selector(".cl-card", timeout=15000)
        page.wait_for_timeout(900)
        body = page.inner_text("#detail")
        assert "$0.3523/hr" in body, "a readonly session still sees what the box costs"
        assert "Delete cluster" not in body
        assert "Build a managed cluster" not in page.inner_text("#actpane")
        assert "admin action" in page.inner_text("#actpane")
        assert page.errors == []


        # The admin half is asserted by the delete-dialog test below, which can only
        # reach the dialog if the control is offered. Signing in twice on one page
        # cannot test it: the second visit to /signin is already authenticated and
        # redirects, so the form is never there to fill.


def test_the_delete_dialog_will_not_arm_until_the_name_is_typed(serve, page, monkeypatch):
    """Every other destructive control here acts on something visible on screen.

    This one destroys a cluster that may be holding colleagues' work on machines this
    box has never seen, so the name has to be typed -- and the dialog says what it is
    holding before asking.
    """
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    _stub_clusters(monkeypatch)
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-clusters")
        page.click("#btn-clusters")
        page.wait_for_selector(".cl-card", timeout=15000)
        page.wait_for_timeout(900)
        # The admin-positive half of the role test above: an admin IS offered both.
        assert "Build a managed cluster" in page.inner_text("#actpane")
        assert "Delete cluster" in page.inner_text("#detail")
        page.click(".cl-card >> nth=0 >> text=Delete cluster")
        page.wait_for_selector("#cluster-delete-dialog[open]")
        assert page.is_disabled("#cluster-delete-go")
        assert "holding 1 workspace(s)" in page.inner_text("#cluster-delete-holds")
        page.fill("#cluster-delete-form input[name=confirm]", "wrong")
        assert page.is_disabled("#cluster-delete-go"), "a near miss must not arm it"
        page.fill("#cluster-delete-form input[name=confirm]", "support")
        assert not page.is_disabled("#cluster-delete-go")
        assert page.errors == []


def test_the_fake_cluster_status_matches_the_real_payload(monkeypatch, tmp_path):
    """The payload-shape trap, closed for the ledger as well as the panel.

    Every cluster test above renders from `_fake_cluster_status`, so a key that
    differs from what `cluster.status()` really returns breaks this screen in
    production with the file green -- which is exactly how three keys drifted on the
    workspace panel before the equivalent test existed.
    """
    from houston.services import cluster as clustersvc
    from houston.services import k8s as k8ssvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8ssvc.context, "contexts", lambda: ([_CL_ARN], ""))
    monkeypatch.setattr(k8ssvc.names, "is_ours", lambda c: False)
    monkeypatch.setattr(k8ssvc.reachability, "reach", lambda *a, **k: k8ssvc.Reach(status=k8ssvc.REACH_DENIED))
    real = clustersvc.status(_CL_ARN)
    fake = _fake_cluster_status(_CL_ARN)
    missing = sorted(set(real) - set(fake))
    assert not missing, (
        f"cluster.status() returns keys the browser fake does not have: {missing}. "
        "The screen renders from the fake, so this is a panel that breaks in "
        "production with this file green.")


def test_the_cluster_action_pane_survives_the_four_second_poll(serve, page, monkeypatch):
    """It did not, and no screenshot taken inside four seconds could show it.

    `render()` runs on a four-second timer and does two separate things to this
    column: it clears `#actpane`'s contents, and it toggles `no-detail` on `.panes`,
    which hides the column outright. Both had to learn about this view. Fixing only
    the first looked completely correct in every screenshot and in every test above,
    because they all assert within a second or two of opening the page -- so the
    build button and the permissions documents vanished a few seconds later, which is
    exactly when somebody would be reaching for them.

    The wait is what this test IS. Do not shorten it.
    """
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    _stub_clusters(monkeypatch)
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-clusters")
        page.click("#btn-clusters")
        page.wait_for_selector(".cl-card", timeout=15000)
        assert page.is_visible("text=Build a managed cluster")

        page.wait_for_timeout(5200)          # longer than the poll, deliberately
        assert "no-detail" not in (page.get_attribute(".panes", "class") or ""), \
            "the poll hid the action pane's whole column again"
        assert page.is_visible("text=Build a managed cluster"), \
            "the build button vanished a few seconds after the view was opened"
        assert page.is_visible("text=Copy operator policy")
        assert page.errors == []


def _a_domain_changes_what_the_note_says(page):
    """With a name pointed at it, a managed cluster stops needing a port-forward."""
    # HTTPS IS IN SECTION 2 NOW, beside the cluster it depends on. It used to be
    # the last thing inside Advanced -- two clicks and a scroll from the decision
    # it belongs to -- which on a managed cluster hid the field that decides
    # whether the workspace has a real address at all.
    assert page.is_visible("#create-https-block"), \
        "the certificate choice must be reachable without opening Advanced"
    assert page.evaluate(
        "(()=>{let e=document.querySelector('#create-https-block');"
        "while(e){if(e.tagName==='DETAILS')return false;e=e.parentElement}return true})()"), \
        "and it must not be inside the Advanced disclosure"

    # One field, made findable: the button sets the mode and lands in it.
    page.click("#cluster-note >> text=Set a domain")
    page.wait_for_timeout(400)
    assert page.evaluate("document.activeElement.name") == "domain"
    assert page.input_value("#https-mode") == "acme"

    # Once it has one, it stops asking.
    page.fill("#create-form [name=domain]", "t1.rc.example.com")
    page.wait_for_timeout(300)
    assert "port-forward" not in page.inner_text("#cluster-note"), \
        "it kept telling somebody to set a domain they had just set"
    assert "costs money" in page.inner_text("#cluster-note"), \
        "the cost is still true whether or not a domain was given"


def _the_note_says_what_a_managed_cluster_costs(labels, page):
    """The cost and the reachability, named, before anyone commits to either."""
    # LEAVING THE PICKER ALONE IS THE LIKELIEST THING ANYBODY DOES, and on a box
    # whose saved default is a managed cluster it lands there. This note used to
    # key on an EXPLICIT choice, so the default path -- the one most people take
    # -- was the single path with nothing said about the money.
    implicit = page.inner_text("#cluster-note")
    assert "costs money" in implicit, \
        "the default option resolves to a billing cluster and must say so"
    assert _CL_ARN in implicit, "and must name the cluster it would pick"
    # The option itself says where it goes, rather than only "Decide for me".
    assert any("Decide for me" in t and _CL_ARN in t for t in labels), \
        "'Decide for me' must say what it decided"

    # Choosing the managed one explicitly says the same thing.
    page.select_option("#context-select", _CL_ARN)
    page.wait_for_timeout(400)
    note = page.inner_text("#cluster-note")
    assert "costs money" in note
    assert "port-forward" in note, "and that no domain means no real address"


def _the_cluster_row_appears_only_for_kubernetes(page):
    """Which cluster is part of where it runs, so it belongs to section 2 and to no other runtime."""
    # Compose says nothing about clusters at all.
    assert page.is_hidden("#context-row")
    assert page.is_hidden("#cluster-note")

    page.click("#runtime-forks >> text=Kubernetes")
    page.wait_for_timeout(600)
    assert page.is_visible("#context-row"), \
        "the cluster picker must be reachable without opening Advanced"
    assert page.evaluate(
        "(()=>{let e=document.querySelector('#context-row');"
        "while(e){if(e.tagName==='DETAILS')return false;e=e.parentElement}return true})()"), \
        "it must not be inside the Advanced disclosure"
    assert page.evaluate(
        "!!document.querySelector('#runtime-forks').closest('section')"
        ".querySelector('#context-row')"), "and it must be in section 2"

    # The picker says which of them costs money, from the SERVER's judgement.
    labels = page.evaluate(
        "Array.from(document.querySelectorAll('#context-select option'))"
        ".map(o=>o.textContent)")
    assert any("costs money" in t for t in labels)
    assert not any("costs money" in t and "kind" in t for t in labels), \
        "a local cluster must not be labelled as billable"
    return labels


def test_the_create_form_says_what_a_managed_cluster_commits_you_to(serve, page, monkeypatch):
    """WHICH cluster is part of "where it runs", so it is section 2, not Advanced.

    Advanced is for fields whose default is right until you have a reason to change
    it. On a managed cluster neither of the two that matter has a working default:
    the cluster falls back to whatever this box was last pointed at -- possibly a
    colleague's, possibly one that bills by the hour -- and no domain means the
    workspace is reachable only by a port-forward, which on a cluster you are paying
    to have somewhere else wastes the entire point of it.

    The domain field is NOT duplicated into section 2. One field, made findable.
    """
    from houston.services import cluster as clustersvc
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    monkeypatch.setattr(clustersvc, "known_contexts", lambda: {"contexts": [
        {"context": _CL_ARN, "ours": False, "provider": "eks",
         "billable": True, "is_default": True},
        {"context": "kind-houston-local", "ours": True, "provider": "",
         "billable": False, "is_default": False},
    ], "unreadable": "", "default": _CL_ARN})

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")

        labels = _the_cluster_row_appears_only_for_kubernetes(page)

        _the_note_says_what_a_managed_cluster_costs(labels, page)

        _a_domain_changes_what_the_note_says(page)

        # A free cluster is not nagged about at all.
        page.select_option("#context-select", "kind-houston-local")
        page.wait_for_timeout(300)
        assert page.is_hidden("#cluster-note")
        assert page.errors == []


def test_section_two_does_not_quote_this_laptops_memory_for_a_cluster_in_aws(
        serve, page, monkeypatch):
    """"5.4 GB free · room for about 4 more" is about the machine you are sitting at.

    It sat in section 2's header unconditionally, so choosing a managed cluster left a
    number about a laptop next to a decision to run in AWS -- and "room for about 4
    more" is not merely irrelevant there, it is false: the capacity that decides is the
    cluster's, which this dialog does not have and `cluster status` reports instead.

    It still shows for Compose and for the local cluster houston builds, which are the
    cases where it is the right number and where `up` really does refuse without it.
    """
    from houston.services import cluster as clustersvc
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    monkeypatch.setattr(clustersvc, "known_contexts", lambda: {"contexts": [
        {"context": _CL_ARN, "ours": False, "provider": "eks",
         "billable": True, "is_default": False},
        {"context": "kind-houston-local", "ours": True, "provider": "",
         "billable": False, "is_default": False},
    ], "unreadable": "", "default": ""})

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        page.wait_for_timeout(700)

        # Compose runs here, so the number is the right one.
        assert "free" in page.inner_text("#create-room"), \
            "on Compose this is exactly the number `up` refuses on"

        page.click("#runtime-forks >> text=Kubernetes")
        page.wait_for_timeout(600)
        page.select_option("#context-select", "kind-houston-local")
        page.wait_for_timeout(400)
        assert "free" in page.inner_text("#create-room"), \
            "houston's own cluster runs on this machine too"

        page.select_option("#context-select", _CL_ARN)
        page.wait_for_timeout(400)
        assert page.inner_text("#create-room").strip() == "", \
            "a cluster in AWS is not this laptop, and its memory says nothing about it"
        assert page.errors == []


def test_the_clusters_view_speaks_english_and_explains_its_own_numbers(
        serve, page, monkeypatch):
    """Three things a first-timer read as broken.

    The card said ``default for `up` `` with the backtick CHARACTERS on screen, where
    every other code fragment in this GUI is a <code> element -- it simply looked like
    a rendering fault. "Copy context" is a word from the terminal, on a screen built
    for somebody who does not open one. And the rail said "No workspaces yet" beside a
    card saying "holding TICKET-1234": both true, because one counts this machine's
    records and the other counts what is in the cluster, and on a shared cluster they
    disagree permanently, since a colleague's workspace is in the cluster and will
    never be in your rail. Nothing said so.
    """
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    _stub_clusters(monkeypatch)
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-clusters")
        page.click("#btn-clusters")
        page.wait_for_selector(".cl-card", timeout=15000)
        page.wait_for_timeout(900)
        body = page.inner_text("#detail")

        assert "`" not in body, \
            "a backtick on screen is a rendering fault to everybody who sees it"
        assert page.query_selector(".cl-card code"), \
            "code fragments are <code> here, as everywhere else in this GUI"

        assert "Copy context" not in body, "'context' is terminal vocabulary"
        assert "Copy name" in body

        # The two counts are reconciled where they disagree.
        assert "holding" in body
        assert "only this machine's" in body, \
            "the rail and the card count different things and must say so"
        assert page.errors == []


def test_a_cluster_aws_says_is_gone_does_not_read_as_one_that_is_down(serve, page,
                                                                     monkeypatch):
    """A deleted cluster and an unreachable one are opposite situations that the
    screen used to draw identically: "not answering", every count dimmed, and "These
    are unknown, not zero."

    For a cluster AWS says does not exist, all three are wrong. Nothing is unknown,
    nothing is costing anything, and the only thing wanted is that the leftover
    kubeconfig entry be cleared. Reported from a real screen after a delete that had
    worked -- the cluster kept appearing, and the card made it look like a cluster
    that was still there and merely unwell.
    """
    from houston.services import cluster as clustersvc
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")

    def gone_status(context="", emit=None):
        row = dict(_fake_cluster_status(context))
        if context == _CL_PERF:
            row.update({"gone": True, "reach_advice":
                        "AWS says this cluster no longer exists, so it is not costing "
                        "anything. The kubeconfig entry naming it is left over — "
                        "`houston cluster forget perf` removes it."})
        return row

    _stub_clusters(monkeypatch)
    monkeypatch.setattr(clustersvc, "status", gone_status)
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-clusters")
        page.click("#btn-clusters")
        page.wait_for_selector(".cl-card", timeout=15000)
        page.wait_for_timeout(900)

        card = page.query_selector_all(".cl-card")[1].inner_text()
        assert "gone" in card.lower(), card
        assert "no longer exists" in card, card
        assert "not answering" not in card, \
            "a cluster that has been deleted is not a cluster that is down"
        assert "unknown, not zero" not in card.lower(), \
            "nothing about a deleted cluster is unknown"
        assert "nothing" in card, "its cost is nothing, definitely, not unreadably"
        assert page.errors == []


def test_a_gone_cluster_offers_only_controls_that_can_work(serve, page, monkeypatch):
    """"A control that cannot succeed is worse than no control" — the rule this file
    already applies to a readonly user's logs and env tabs.

    On a cluster AWS says does not exist, "Prepare" has nothing to prepare and "Delete
    cluster" has nothing to delete; both could only ever produce a red toast. What is
    actually wanted is the leftover kubeconfig entry cleared, so that is the control
    offered instead — and it is not red, because it destroys nothing.
    """
    from houston.services import cluster as clustersvc
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")

    def status(context="", emit=None):
        row = dict(_fake_cluster_status(context))
        if context == _CL_PERF:
            row.update({"gone": True, "reach_advice": "AWS says this cluster no longer "
                        "exists, so it is not costing anything."})
        return row

    _stub_clusters(monkeypatch)
    monkeypatch.setattr(clustersvc, "status", status)
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-clusters")
        page.click("#btn-clusters")
        page.wait_for_selector(".cl-card", timeout=15000)
        page.wait_for_timeout(900)

        cards = page.query_selector_all(".cl-card")
        live = [b.inner_text() for b in cards[0].query_selector_all(".cl-foot button")]
        dead = [b.inner_text() for b in cards[1].query_selector_all(".cl-foot button")]

        assert "Prepare" in live and any("Delete" in b for b in live), live
        assert "Prepare" not in dead, "there is nothing to prepare on a cluster that is gone"
        assert not any("Delete" in b for b in dead), \
            "there is nothing to delete either — AWS already has not got it"
        assert any("Forget" in b for b in dead), \
            "the one thing wanted is the leftover entry cleared"
        # NOT RED. Red means about to destroy something, and this destroys nothing —
        # the cluster is already gone and only a local file changes.
        forget = [b for b in cards[1].query_selector_all(".cl-foot button")
                  if "Forget" in b.inner_text()][0]
        assert "danger" not in (forget.get_attribute("class") or "")
        assert page.errors == []


def test_the_local_certificate_option_goes_when_the_cluster_is_not_on_this_machine(
        serve, page, monkeypatch):
    """"Local certificate" would copy houston's CA PRIVATE KEY into a Secret in a
    cluster that is not this machine's, and that key can mint a certificate for any
    name this box trusts. `_kubernetes_tls_plan` refuses it as an authority gate.

    An option that cannot succeed is worse than no option — it invites a click, costs
    a filled-in form, and explains itself only after the submit. This dialog's rule is
    that such fields are ABSENT, not disabled.

    ONLY WHEN WE POSITIVELY KNOW. Compose, an unknown cluster and the local one
    houston would build all keep the option; only a cluster the server says is
    billable takes it away. Removing a working choice on a guess is the worse of the
    two mistakes.
    """
    from houston.services import cluster as clustersvc
    from houston.services import users as usersvc

    usersvc.add("alice", PASSWORD, role="admin")
    monkeypatch.setattr(clustersvc, "known_contexts", lambda: {"contexts": [
        {"context": _CL_ARN, "ours": False, "provider": "eks",
         "billable": True, "is_default": True},
        {"context": "kind-houston-local", "ours": True, "provider": "",
         "billable": False, "is_default": False},
    ], "unreadable": "", "default": _CL_ARN})

    modes = ("Array.from(document.querySelectorAll('#https-mode option'))"
             ".map(o=>o.value)")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")

        # Compose runs here by definition, so both certificate routes stay.
        assert "local" in page.evaluate(modes)

        # Kubernetes defaulting to the managed cluster: the local CA cannot go there.
        page.click("#runtime-forks >> text=Kubernetes")
        page.wait_for_timeout(700)
        assert "local" not in page.evaluate(modes), \
            "the CA private key does not leave this box, so the option must not be offered"
        assert "acme" in page.evaluate(modes), \
            "Let's Encrypt DOES work against a cluster anywhere — it must stay"

        # Choosing the local cluster brings it back: this is about where the cluster
        # is, not about the runtime.
        page.select_option("#context-select", "kind-houston-local")
        page.wait_for_timeout(700)
        assert "local" in page.evaluate(modes), \
            "a cluster on this machine can hold houston's own CA"

        # And selecting it, then moving back to the managed cluster, must not leave
        # the form carrying a mode that has just been removed.
        page.select_option("#https-mode", "local")
        page.select_option("#context-select", _CL_ARN)
        page.wait_for_timeout(700)
        assert page.eval_on_selector("#https-mode", "e=>e.value") != "local", \
            "a removed option must not stay selected"
        assert page.errors == []


def test_the_cluster_picker_shows_a_name_not_sixty_characters_of_arn(serve, page,
                                                                    monkeypatch):
    """An EKS context is `arn:aws:eks:<region>:<account>:cluster/<name>`. With
    "costs money" and "default" appended that made a ninety-five character `<option>`,
    and a native select cannot shrink text — it ran out of its box. Reported from a
    real screen.

    The name and the region are the two facts a person needs to pick a cluster; the
    account id is not. Both come from the SERVER beside `billable`, because deriving
    them here would be a second copy of a rule the service owns.

    THE VALUE IS UNTOUCHED. Shortening what is SENT would send a name the server
    cannot resolve, which is the one way this change could do damage.
    """
    from houston.services import cluster as clustersvc
    from houston.services import users as usersvc

    arn = "arn:aws:eks:us-east-1:533674205877:cluster/chatrepo"
    usersvc.add("alice", PASSWORD, role="admin")
    monkeypatch.setattr(clustersvc, "known_contexts", lambda: {"contexts": [
        {"context": arn, "short": "chatrepo", "region": "us-east-1", "ours": False,
         "provider": "eks", "billable": True, "is_default": True},
        {"context": "kind-houston-local", "short": "kind-houston-local",
         "region": "", "ours": True, "provider": "", "billable": False,
         "is_default": False},
    ], "unreadable": "", "default": arn})

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#btn-new")
        page.click("#btn-new")
        page.wait_for_selector("#create-dialog[open]")
        page.click("#runtime-forks >> text=Kubernetes")
        page.wait_for_timeout(700)

        opts = page.evaluate(
            "Array.from(document.querySelectorAll('#context-select option'))"
            ".map(o => ({t: o.textContent, v: o.value}))")
        managed = next(o for o in opts if o["v"] == arn)
        assert "chatrepo" in managed["t"] and "us-east-1" in managed["t"], managed
        assert arn not in managed["t"], \
            "the whole ARN in an option is what overflowed the control"
        assert "533674205877" not in managed["t"], \
            "the account id is the half of an ARN nobody needs in a picker"
        assert len(managed["t"]) < 60, f"still {len(managed['t'])} characters: {managed['t']}"
        # The facts that made it worth showing at all are still there.
        assert "costs money" in managed["t"] and "default" in managed["t"], managed

        # AND WHAT IS SENT IS UNCHANGED. This is the invariant that matters.
        assert managed["v"] == arn
        assert any(o["v"] == "kind-houston-local" for o in opts)
        # "Decide for me" names the cluster it would pick, and shortly.
        decide = next(o for o in opts if o["v"] == "")
        assert "chatrepo" in decide["t"] and arn not in decide["t"], decide
        assert page.errors == []
