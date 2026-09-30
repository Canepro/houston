"""`houston.browser.kubernetes_rail`: its own spec file.

Co-located out of `tests/test_browser.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("playwright.sync_api")

from browserhelpers import (
    PASSWORD, _fake_detail, _kube_detail, _pane, _sign_in, _stub_lifecycle, _stub_list,
    browser as browser, page as page, serve as serve
)
from houston.services import users as usersvc

def test_the_env_tab_renders_on_kubernetes_where_it_used_to_be_blank(
        serve, page, monkeypatch):
    """It read `detail().env`, which the Kubernetes branch of detail() never set --
    so the tab rendered an empty table and a hint, on a workspace whose environment
    the CLI could print. It fetches /env now, which is the one seam both front-ends
    share."""
    from houston.services import envvars as envsvc

    _stub_lifecycle(monkeypatch, _kube_detail())
    monkeypatch.setattr(envsvc, "current", lambda name: {
        "name": name, "overrides": ["MY_FLAG"],
        "env": [{"key": "ROOT_URL", "value": "http://localhost:3001", "override": False},
                {"key": "MY_FLAG", "value": "1", "override": True},
                {"key": "MONGO_URL", "value": "********", "override": False}]})
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        page.click("button.tab:has-text('Env vars')")
        page.wait_for_function(
            "() => document.querySelector('#d-body').textContent.includes('MY_FLAG')")
        body = page.text_content("#d-body")
        assert "ROOT_URL" in body and "MONGO_URL" in body
        # Every write here is refused by the server with a helm hint, so the controls
        # that could only produce a red toast are not rendered -- and the helm route
        # is given instead.
        assert page.query_selector("#d-body button.danger") is None
        assert "Set + restart" not in body
        assert "helm -n houston-t1234 upgrade" in body, body
        assert page.errors == [], page.errors


def test_the_env_tab_still_offers_the_controls_on_compose(serve, page, monkeypatch):
    from houston.services import envvars as envsvc

    _stub_lifecycle(monkeypatch)
    monkeypatch.setattr(envsvc, "current", lambda name: {
        "name": name, "overrides": [],
        "env": [{"key": "ROOT_URL", "value": "http://localhost:3001", "override": False}]})
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        page.click("button.tab:has-text('Env vars')")
        page.wait_for_function(
            "() => document.querySelector('#d-body').textContent.includes('ROOT_URL')")
        assert "Set + restart" in page.text_content("#d-body")
        assert page.query_selector("#d-body button.danger") is not None
        assert page.errors == [], page.errors


def test_the_env_tab_shows_the_refusal_rather_than_an_empty_table(
        serve, page, monkeypatch):
    """A stopped Kubernetes workspace has no container to read the environment out
    of, and the server says so. That message is the answer -- rendering an empty
    table instead would look like a workspace with no environment."""
    from houston import errors as errs
    from houston.services import envvars as envsvc

    def refuse(name):
        raise errs.NotReadyError("no Rocket.Chat pod in houston-t1234 to read the "
                                 "environment from — is 't1234' running?")

    _stub_lifecycle(monkeypatch, _kube_detail(state="stopped"))
    monkeypatch.setattr(envsvc, "current", refuse)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        page.click("button.tab:has-text('Env vars')")
        page.wait_for_function(
            "() => document.querySelector('#d-body').textContent"
            ".includes('no Rocket.Chat pod')")
        assert page.errors == [], page.errors


def test_the_containers_tab_shows_pods_and_says_so_on_kubernetes(
        serve, page, monkeypatch):
    """It printed "No containers — this repro is down." under a RUNNING Kubernetes
    workspace, because the payload's list was always empty on that runtime."""
    _stub_lifecycle(monkeypatch, _kube_detail(containers=[
        {"service": "rocketchat-rocketchat-6d9-abc", "state": "running",
         "status": "1/1 ready", "health": "healthy"},
        {"service": "rocketchat-mongodb-0", "state": "pending",
         "status": "ImagePullBackOff", "health": ""}]))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        page.click("button.tab:has-text('Containers')")
        page.wait_for_selector("#d-body table.dtable")
        body = page.text_content("#d-body")
        assert "rocketchat-mongodb-0" in body
        # The reason a pod cannot start, which the GUI had no way to show at all.
        assert "ImagePullBackOff" in body
        assert "No containers" not in body
        assert "Pods, not containers" in body
        # The column is named for what is in it.
        assert page.text_content("#d-body table.dtable th") == "pod"
        assert page.errors == [], page.errors


def test_the_live_chart_stops_asking_when_the_answer_is_a_refusal(
        serve, page, monkeypatch, tmp_path):
    """kind ships no metrics-server, so /stats answers 409 forever. The chart used to
    swallow it and repaint an empty box every three seconds under a title that says
    "live", throwing away the server's own instructions for fixing it."""
    import json as _json

    from houston import errors as errs
    from houston.services import k8s as k8ssvc

    (tmp_path / "repros" / "t1234").mkdir(parents=True)
    (tmp_path / "repros" / "t1234" / "repro.json").write_text(_json.dumps({
        "name": "t1234", "project": "p", "rc_version": "7.4.1", "rc_image": "i",
        "mongo_tag": "7.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001,
        "version_source": "x", "extra": {"runtime": "kubernetes"}}))
    _stub_lifecycle(monkeypatch, _kube_detail())

    def no_metrics(name, **kw):
        raise errs.NotReadyError("this cluster has no metrics-server, so there is "
                                 "nothing to read CPU and memory from. Install it "
                                 "with:\n  kubectl apply -f https://example/x.yaml")

    monkeypatch.setattr(k8ssvc.status, "pod_metrics", no_metrics)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_function(
            "() => document.querySelector('#chart')"
            " && document.querySelector('#chart').textContent.includes('metrics-server')")
        # And it stopped asking, rather than repainting the same refusal forever.
        assert page.evaluate(
            "async () => (await import('/js/shared.js')).ctx.dstate.statsTimer"
        ) is None
        assert page.errors == [], page.errors


def test_a_credential_note_is_not_labelled_a_sudo_setup_step(serve, page, monkeypatch):
    """The setup block said "Do this once, on your machine … Needs sudo." over
    whatever the first indented note happened to be.

    For `ldap` that is a phpLDAPadmin CREDENTIAL, so the panel told an ldap reader to
    sudo their way through "log in with DN cn=admin,dc=example,dc=com / admin" -- a
    sentence that is not true of anything. `stopped`, so the live chart's /stats poll
    stays out of a test about text.
    """
    from houston import presets as presets_mod

    notes = list(presets_mod.load("ldap").notes or [])
    assert any(n.startswith("    ") for n in notes), \
        "the indented credential is the condition under test"
    usersvc.add("alice", PASSWORD, role="admin")
    _stub_lifecycle(monkeypatch, _fake_detail(state="stopped", preset="ldap",
                                              notes=notes))
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        body = page.text_content("#d-body")
        assert "cn=admin,dc=example,dc=com" in body, "the credential is still shown"
        assert "Needs sudo" not in body, \
            "a credential was labelled a setup step that needs sudo"
        assert page.errors == [], page.errors


def test_the_one_preset_with_a_real_setup_step_keeps_it(serve, page, monkeypatch):
    """`oidc` cannot log anyone in until `127.0.0.1  keycloak` is in /etc/hosts, and
    the introducing sentence says exactly that -- which is what now qualifies a note
    as a setup step."""
    from houston import presets as presets_mod

    usersvc.add("alice", PASSWORD, role="admin")
    _stub_lifecycle(monkeypatch, _fake_detail(
        state="stopped", preset="oidc",
        notes=list(presets_mod.load("oidc").notes or [])))
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .setup", timeout=15000)
        setup = page.text_content("#d-body .setup")
        assert "127.0.0.1  keycloak" in setup, setup
        assert "Needs sudo" in setup
        assert page.errors == [], page.errors


def test_the_three_panes_survive_a_narrow_window(serve, page, monkeypatch, tmp_path):
    """532px of the layout was fixed -- a 288px rail and a 244px action pane -- and
    nothing was responsive: the @media rules still named `.layout`, the class the
    workbench redesign replaced with `.panes`, so they had matched nothing since.

    Measured before the fix, at 900px tall with a workspace open: 236px of stage at
    768, 108px at 640, and at 480 the page scrolled sideways with 42px of stage.

    The stage is also `position: sticky`, which in ONE column rides up over the row
    above -- the rail ended up underneath the panel and its rows could not be
    clicked at all. That reset lived in the dead rule and went with it.
    """
    import json as _json

    _stub_lifecycle(monkeypatch)
    usersvc.add("alice", PASSWORD, role="admin")
    (tmp_path / "repros" / "t1234").mkdir(parents=True, exist_ok=True)
    (tmp_path / "repros" / "t1234" / "repro.json").write_text(_json.dumps({
        "name": "t1234", "project": "p", "rc_version": "7.4.1", "rc_image": "i",
        "mongo_tag": "7.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001,
        "version_source": "x", "extra": {}}))

    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        for width in (1440, 1024, 768, 640, 480, 380):
            page.set_viewport_size({"width": width, "height": 900})
            page.wait_for_timeout(150)
            m = page.evaluate("""() => {
              const r = document.querySelector('.rail').getBoundingClientRect();
              const d = document.querySelector('#detail').getBoundingClientRect();
              return {over: document.documentElement.scrollWidth
                             > document.documentElement.clientWidth,
                      stage: Math.round(d.width),
                      overlap: Math.round(Math.min(r.bottom, d.bottom)
                                          - Math.max(r.top, d.top))
                               > 2 && Math.round(Math.min(r.right, d.right)
                                          - Math.max(r.left, d.left)) > 2};
            }""")
            assert not m["over"], f"the page scrolls sideways at {width}px"
            assert m["stage"] >= 320, f"the stage is {m['stage']}px at {width}px"
            assert not m["overlap"], f"the rail and the stage overlap at {width}px"
        assert page.errors == [], page.errors


def test_a_note_that_ends_in_a_name_is_not_glued_to_the_next_one(serve, page, monkeypatch):
    """The notes pattern has three shapes, and this is the third one's rule: prose
    lines are joined into a paragraph only when the previous line was WRAPPED — they
    were written for an 80-column terminal, not as separate points.

    "Ends in any lowercase word" was too broad, and the Kubernetes notes proved it:
    "monolith on kind-houston-local — about 5 pods, namespace houston-x" is a
    complete point that happens to end in an identifier, and it was being glued to
    the MongoDB note after it — two unrelated facts in one bullet, in the notes a
    reader consults to find out what their workspace actually is.

    Both sides are pinned here, because narrowing the rule could easily have broken
    the wrapping it exists for -- `oidc`'s real notes must still join, which is the
    test directly after this one.
    """
    kube_notes = [
        "monolith on kind-houston-local — about 5 pods, namespace houston-x",
        "MongoDB 8.0 as a plain StatefulSet — mongo:8.0, NO authentication.",
        "reachable on this box at http://localhost:3000",
    ]
    _stub_lifecycle(monkeypatch, _fake_detail(state="stopped", notes=kube_notes))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        paras = page.eval_on_selector_all(
            "#d-body .note-p", "es => es.map(e => e.textContent.trim())")
        assert len(paras) == 3, paras
        assert paras[0].endswith("houston-x"), paras[0]
        assert "StatefulSet" not in paras[0], "two notes were glued into one bullet"
        assert page.errors == [], page.errors


def test_a_genuinely_wrapped_note_still_joins_the_line_after_it(serve, page, monkeypatch):
    """The other side of the same rule, and the reason narrowing it was risky:
    `oidc`'s real notes trail off in "…can reach Keycloak at the", which is what
    wrapping actually looks like, and those two lines are one point."""
    from houston import presets as presets_mod

    oidc = list(presets_mod.load("oidc").notes or [])
    assert oidc[0].rstrip().endswith("the"), \
        "the fixture for this assertion is oidc's real wrapped line"
    _stub_lifecycle(monkeypatch, _fake_detail(state="stopped", preset="oidc", notes=oidc))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body")
        joined = page.eval_on_selector_all(
            "#d-body .note-p", "es => es.map(e => e.textContent)")
        assert any("host entry" in t and "/etc/hosts" in t for t in joined), \
            f"the wrapped oidc line stopped joining: {joined}"
        assert page.errors == [], page.errors


def test_a_long_line_in_a_note_scrolls_instead_of_being_clipped_away(
        serve, page, monkeypatch):
    """A Kubernetes workspace's notes carry `export KUBECONFIG=<absolute path>`, and
    it did not fit: `.note-cmd` came out 1147px inside an 824px panel, and
    `.panelcard`'s `overflow-x: hidden` silently CLIPPED the rest — so the reader was
    told to paste a path whose end they could not see.

    `white-space: pre` has to stay (a pasted line's spacing is load-bearing and
    another test asserts it), so the fix is `min-width: 0` on the flex/grid items:
    without it they refuse to shrink below their content and the `overflow-x: auto`
    that was already there never engages.
    """
    long_path = "/tmp/pytest-of-someone/a-very-long-isolated-home-0/clients/kubernetes/config"
    notes = ["houston keeps its own kubeconfig; a bare kubectl will not see this:",
             f"    export KUBECONFIG={long_path}"]
    _stub_lifecycle(monkeypatch, _fake_detail(state="stopped", notes=notes))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .note-cmd")
        m = page.evaluate("""() => {
          const card = document.querySelector('#d-body .panelcard');
          const box = document.querySelector('#d-body .note-cmd');
          const code = box.querySelector('code');
          return {cardOver: card.scrollWidth > card.clientWidth + 2,
                  boxOver: box.scrollWidth > box.clientWidth + 2,
                  codeScrolls: code.scrollWidth > code.clientWidth,
                  overflowX: getComputedStyle(code).overflowX,
                  ws: getComputedStyle(code).whiteSpace};
        }""")
        assert not m["cardOver"], "the card still overflows, so the panel clips it"
        assert not m["boxOver"], "the code box still pushes past its own bounds"
        assert m["codeScrolls"] and m["overflowX"] == "auto", \
            "the long line has to scroll inside its box"
        assert m["ws"] == "pre", "a pasted line's spacing must survive"
        assert page.errors == [], page.errors


def test_a_grouped_note_gets_its_own_card_with_a_fact_table_and_a_copy_button(
        serve, page, monkeypatch):
    """A Kubernetes workspace had ten things to say and said them as one bulleted
    dump: the cluster, the namespace and the arrangement welded into a sentence; the
    `kubectl port-forward` you actually have to paste sitting mid-paragraph as prose;
    the ldap preset's phpLDAPadmin credentials one bullet among the rest.

    They are three different kinds of content and each now gets the shape it needs --
    facts as a table, prose as prose, commands as a code block with Copy -- one card
    per group. What this asserts is that all three arrive: a `.notetable` row for a
    fact, the group's own title, and a copyable block for a command.
    """
    groups = [
        {"title": "Kubernetes",
         "rows": [["Cluster", "kind-houston-local"], ["Namespace", "houston-t1234"],
                  ["Arrangement", "microservices"]],
         "body": [], "commands": []},
        {"title": "Port forward",
         "rows": [],
         "body": ["The port-forward dies with the pod. Start it again:"],
         "commands": ["kubectl -n houston-t1234 port-forward deployment/rc 3001:3000"]},
    ]
    _stub_lifecycle(monkeypatch, _kube_detail(note_groups=groups,
                                              notes=["Kubernetes:", "    Cluster  x"]))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .notetable")
        m = page.evaluate("""() => {
          const cards = [...document.querySelectorAll('#d-body .panelcard')];
          const titled = t => cards.find(c => (c.querySelector('.section-label')
                                               || {}).textContent === t);
          const kube = titled('Kubernetes'), fwd = titled('Port forward');
          const rows = kube ? [...kube.querySelectorAll('.notetable tr')].map(
            r => [r.querySelector('th').textContent, r.querySelector('td').textContent])
            : null;
          return {rows,
                  fwdCmd: fwd ? (fwd.querySelector('.note-cmd code') || {}).textContent : null,
                  fwdCopy: !!(fwd && fwd.querySelector('.note-cmd .cp')),
                  fwdProse: fwd ? fwd.textContent.includes('dies with the pod') : false,
                  // the facts must NOT also be a bullet in the old flat dump
                  flatDump: cards.some(c => c.textContent.includes('Cluster  x'))};
        }""")
        assert m["rows"] == [["Cluster", "kind-houston-local"],
                             ["Namespace", "houston-t1234"],
                             ["Arrangement", "microservices"]], m["rows"]
        assert m["fwdCmd"] == \
            "kubectl -n houston-t1234 port-forward deployment/rc 3001:3000"
        assert m["fwdCopy"], "a command you have to paste needs its Copy button"
        assert m["fwdProse"], "the group's own prose has to survive next to it"
        assert not m["flatDump"], \
            "the flat notes are still rendered too, so every fact appears twice"
        assert page.errors == [], page.errors


def test_the_overview_says_which_runtime_the_workspace_runs_on(
        serve, page, monkeypatch):
    """Both runtimes rendered an identical Overview. A support engineer handed a link
    could see the version, the scenario and the health of a workspace with no way to
    tell whether it was Compose or Kubernetes -- which decides what half the actions
    in the pane will even do.

    It takes Port's cell: the port is already in the identity line under the name and
    in the URL box below, and the grid is deliberately exactly six so it fills two rows
    of three with no hole.
    """
    _stub_lifecycle(monkeypatch, _kube_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .kv-grid")
        cells = page.evaluate("""() => [...document.querySelectorAll(
          '#d-body .kv-grid .kv')].map(c => [
            c.querySelector('.k').textContent, c.querySelector('.v').textContent])""")
        keys = [k for k, _ in cells]
        assert "Runs on" in keys, keys
        assert dict(cells)["Runs on"] == "Kubernetes · microservices"
        assert len(cells) == 6, "the grid is six cells so two rows of three fill"
        assert page.errors == [], page.errors


def _the_tab_strip_scrolls_rather_than_pushing_the_page(page):
    """At 380px the tabs have to be reachable without the page scrolling sideways."""
    # Five uppercase tabs want 402px. With the shell's `overflow: hidden` gone
    # they would push the whole page sideways, so the strip scrolls itself --
    # which also makes BACKUPS reachable, and it was not.
    page.set_viewport_size({"width": 380, "height": 900})
    page.wait_for_timeout(200)
    t = page.evaluate("""() => {
      const strip = document.querySelector('.tabs');
      const tabs = [...strip.querySelectorAll('.tab')];
      const last = tabs[tabs.length - 1];
      strip.scrollLeft = strip.scrollWidth;
      const r = last.getBoundingClientRect(), s = strip.getBoundingClientRect();
      return {label: last.textContent, scrolls: strip.scrollWidth > strip.clientWidth,
              reachable: r.right <= s.right + 2 && r.left >= s.left - 2,
              sideways: document.documentElement.scrollWidth
                        > document.documentElement.clientWidth};
    }""")
    assert not t["sideways"], "the tab strip pushes the page sideways at 380px"
    assert t["scrolls"], "the strip should be scrollable, not squeezed"
    assert t["reachable"], f"{t['label']} cannot be scrolled into view"
    assert page.errors == [], page.errors


def _the_panel_shows_its_whole_card_at_520px(page):
    """Every cell and every card rendered, with the page scrolling rather than the panel."""
    m = page.evaluate("""() => {
      const stage = document.querySelector('.stage');
      const cards = [...document.querySelectorAll('#d-body .panelcard')];
      const last = cards[cards.length - 1].getBoundingClientRect();
      const sb = document.querySelector('.statusbar').getBoundingClientRect();
      const grid = document.querySelectorAll('#d-body .kv-grid .kv').length;
      return {pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
              sideways: document.body.scrollWidth > window.innerWidth + 2,
              // nothing hidden inside an internal scroller
              stageHidden: stage.scrollHeight - stage.clientHeight,
              lastBottom: last.bottom, sbTop: sb.top, cells: grid,
              cards: cards.length};
    }""")
    assert m["pageScrolls"], "the page has to scroll; the panel does not fit 900px"
    assert not m["sideways"], "and it must not scroll sideways"
    assert m["stageHidden"] <= 2, \
        f"{m['stageHidden']}px of the panel is hidden inside the stage's own scroller"
    assert m["cells"] == 6, f"only {m['cells']} of the six Overview cells rendered"
    assert m["cards"] >= 9, f"only {m['cards']} cards rendered of the 8 groups + scenario"
    assert m["lastBottom"] <= m["sbTop"] + 2, \
        "the status bar is drawn over the panel instead of below it"


def test_the_panel_is_not_a_two_hundred_pixel_window_on_a_narrow_screen(
        serve, page, monkeypatch):
    """"Everything collapses when I resize the browser."

    The shell is viewport-locked by design -- `body.shell` is 100vh with
    `overflow: hidden` and each pane scrolls inside it, which is right when the three
    sit side by side. Stacked into one column it gave each of them a third of the
    screen: the workspace panel came out a ~200px window showing four of its six
    cells, with every notes card below the cut and reachable only by scrolling a box
    nothing marked as a box. The status bar stayed pinned to the viewport too, so it
    was drawn ACROSS the middle of the panel.

    In one column the page scrolls instead: the panes stack in normal flow, each as
    tall as its content, and the status bar is last. The rail stays capped, because
    it is a picker and not content.
    """
    groups = [{"title": f"Group {i}", "kind": "", "rows": [],
               "body": [f"Something worth reading, number {i}."], "commands": []}
              for i in range(8)]
    _stub_lifecycle(monkeypatch, _kube_detail(note_groups=groups))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .panelcard")
        page.set_viewport_size({"width": 520, "height": 900})
        page.wait_for_timeout(300)
        _the_panel_shows_its_whole_card_at_520px(page)
        _the_tab_strip_scrolls_rather_than_pushing_the_page(page)


def test_a_place_a_group_names_is_the_link_row_and_not_a_second_row(
        serve, page, monkeypatch):
    """The monitoring notes name Grafana and Prometheus, and both are already link
    rows in the panel -- with the password, which is the part the link row does not
    know. While every note lived in one card, that card merged the two; splitting the
    notes into cards put the same two urls on screen twice, once as rows and again as
    prose one card below, which is the exact duplication the merge was written for.

    So the merge is across every group, not just the card that owns the prose.
    """
    groups = [
        {"title": "Monitoring", "rows": [],
         "body": ["Grafana:    http://localhost:5050  (admin/admin; anonymous view enabled)",
                  "Dashboards auto-provisioned: Rocket.Chat Metrics, MongoDB."],
         "commands": []},
    ]
    d = _kube_detail(note_groups=groups, notes=[], links=[
        {"label": "Rocket.Chat", "url": "http://localhost:3001", "kind": "rc"},
        {"label": "Grafana", "url": "http://localhost:5050", "kind": "monitor"}])
    _stub_lifecycle(monkeypatch, d)
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .linkrow")
        m = page.evaluate("""() => {
          const body = document.querySelector('#d-body');
          const rows = [...body.querySelectorAll('.linkrow')].map(r => r.textContent);
          return {
            grafanaRows: rows.filter(t => t.includes('localhost:5050')).length,
            // the password the note carries has to survive the merge
            creds: rows.some(t => t.includes('admin/admin')),
            // and what the note said BESIDES a place is still there
            rest: body.textContent.includes('auto-provisioned'),
          };
        }""")
        assert m["grafanaRows"] == 1, "Grafana is on screen twice"
        assert m["creds"], "the merge dropped the credential the note carried"
        assert m["rest"], "the rest of the group's prose was dropped with it"
        assert page.errors == [], page.errors


def test_a_healthy_workspace_gets_no_triage_block_at_all(serve, page, monkeypatch):
    """The quiet state is ABSENCE, not a green box saying everything is fine. A panel
    that always carries a status block trains people to stop reading it, and the facts
    below it already say the workspace is healthy.
    """
    _stub_lifecycle(monkeypatch, _fake_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .kv-grid")
        assert page.locator("#detail .triage").count() == 0
        assert page.errors == [], page.errors


def test_the_rail_groups_by_what_each_workspace_wants_from_you(serve, page, monkeypatch):
    """A flat alphabetical list is fine with two workspaces and is the wrong shape for
    the shared box this tool is run on, which carries eight to twelve. "Which one is
    unhappy" was a question you answered by reading every row, and the unhappy one
    could be anywhere in the list.

    "Wants you" is deliberately not "not running": a stopped workspace is doing exactly
    what it was told and a restart-looping one is not, so putting them together would
    make the group mean nothing.
    """
    _stub_list(monkeypatch, [
        _fake_detail(name="aa-loop", state="restarting", restarts=4),
        _fake_detail(name="bb-sick", state="running", health="unhealthy"),
        _fake_detail(name="cc-fine", state="running"),
        _fake_detail(name="dd-stopped", state="stopped", uptime="", health=""),
        _fake_detail(name="ee-down", state="down", uptime="", health=""),
    ])
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros .rgrp")
        m = page.evaluate("""() => {
          const out = [];
          let g = null;
          for (const c of document.querySelector('#repros').children) {
            if (c.classList.contains('rgrp')) {
              g = {title: c.querySelector('.rgrp-t').textContent,
                   count: c.querySelector('.rgrp-n').textContent, rows: []};
              out.push(g);
            } else if (g) g.rows.push(c.querySelector('.nm').textContent);
          }
          return out;
        }""")
        assert [g["title"] for g in m] == ["Wants you", "Running", "Not running"], m
        assert [g["count"] for g in m] == ["2", "1", "2"], m
        assert m[0]["rows"] == ["aa-loop", "bb-sick"], m[0]
        assert m[1]["rows"] == ["cc-fine"], m[1]
        assert m[2]["rows"] == ["dd-stopped", "ee-down"], m[2]
        assert page.errors == [], page.errors


def test_one_state_gets_no_group_headings(serve, page, monkeypatch):
    """A heading over a list that is entirely one state is a label for the thing it is
    inside, and the rail head's pill already says "3 running". The rule is conditional,
    so both halves of it are asserted: three running workspaces get no headings, and the
    moment one of them is in another state all three headings appear.
    """
    _stub_list(monkeypatch, [_fake_detail(name=f"ws-{i}") for i in range(3)])
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros .wrow")
        assert page.locator("#repros .rgrp").count() == 0
        assert page.locator("#repros .wrow").count() == 3
        # The rule itself, both ways round, without waiting out a four-second poll.
        titles = page.evaluate("""async () => { const {railGroups} = await import('/js/api.js'); return [
          railGroups([{state: 'running'}, {state: 'running'}]).map(g => g[0]),
          railGroups([{state: 'running'}, {state: 'stopped'}]).map(g => g[0]),
        ]; }""")
        assert titles[0] == ["", "", ""], titles[0]
        assert titles[1] == ["Wants you", "Running", "Not running"], titles[1]
        assert page.errors == [], page.errors


def test_a_long_workspace_name_does_not_push_the_rail_sideways(serve, page, monkeypatch):
    """`.rows` was left on the implicit `auto` grid track, which is at least as wide as
    its widest item's MIN-content. That was survivable while a row could wrap, and it
    made the rail scroll sideways -- clipping the state and the group counts off the
    right edge -- the moment anything in a row could not.

    A guard, not a regression test: the row wraps again, so the track is no longer what
    stops it. The narrow strip is where a name cannot wrap, and that is asserted here
    too, because that is the layout the rule now protects.
    """
    long_name = "a-really-long-workspace-name-for-ticket-4821"
    _stub_list(monkeypatch, [
        _fake_detail(name=long_name, preset="ldap"),
        _fake_detail(name="dana-upgrade", uptime="4 minutes", monitoring=True),
    ])
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros .wrow")
        for width in (1440, 430):
            page.set_viewport_size({"width": width, "height": 900})
            page.wait_for_timeout(200)
            m = page.evaluate("""() => {
              const rows = document.querySelector('#repros');
              return {sideways: rows.scrollWidth > rows.clientWidth + 1,
                      inside: [...rows.querySelectorAll('.wrow')].every(
                        (r) => r.scrollWidth <= r.clientWidth + 1),
                      title: rows.querySelector('.wrow').title};
            }""")
            # At 430 the strip scrolls BY DESIGN -- it is a horizontal picker -- so what
            # is asserted there is that no individual chip overflows its own box.
            if width > 760:
                assert not m["sideways"], f"the rail scrolls sideways at {width}px"
            assert m["inside"], f"a row is wider than its own box at {width}px"
            assert m["title"] == long_name, "the full name has to stay reachable"
        # The wide row keeps every part: the port and the owner are what people search a
        # shared box's rail by, and one line could not hold them.
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(200)
        meta = page.locator(".wrow", has_text="dana-upgrade").locator(".meta").inner_text()
        assert ":3001" in meta and "alice" in meta and "monitored" in meta, meta
        assert page.errors == [], page.errors


def test_a_seeded_workspace_is_not_told_to_seed_itself(serve, page, monkeypatch):
    """Seeding only ever ADDS, so "add sample data" on a workspace that is already full
    is a wrong guess -- and a wrong guess about what to do next is worse than not
    guessing. The ladder moves on to the next thing its state admits.
    """
    _stub_lifecycle(monkeypatch, _fake_detail(
        seed={"profile": "standard", "at": "2026-08-19T09:00:00+00:00", "ok": True}))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#actpane .apn")
        m = _pane(page)
        assert [n[0] for n in m["next"]] == ["Send an API call", "Back up now"], m["next"]
        assert "Add sample data" in [r[0] for r in m["rest"]]
        assert page.errors == [], page.errors


def test_nothing_is_suggested_for_a_workspace_that_is_not_running(serve, page, monkeypatch):
    """What a down workspace's state admits is "start it", which the panel's own action
    row and the triage block above it both offer. Suggesting "add sample data" against a
    workspace that cannot answer would be an invitation to a red toast.
    """
    _stub_lifecycle(monkeypatch, _fake_detail(state="down", uptime="", health=""))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#actpane .aplist")
        m = _pane(page)
        assert m["next"] == [], m["next"]
        # The heading says what the list is when nothing has been picked out of it.
        assert m["groups"][:1] == ["What you can do with it"], m["groups"]
        assert "need the workspace running" in m["note"]
        # Everything that needs it running is offered but refused in place, rather than
        # being hidden -- it will be available again the moment it is up.
        rest = dict(m["rest"])
        assert rest["Add sample data"] is True, "it would only answer with a red toast"
        assert rest["Use for CLI commands"] is False, "that one does not need it running"
        assert page.errors == [], page.errors


def test_a_kubernetes_log_line_is_split_by_pod_like_a_compose_one(serve, page, monkeypatch):
    """kubectl streams these workspaces' logs with `--prefix`, so every line arrives as
    `[pod/<pod>/<container>] the actual line`. The viewer knew only Compose's
    `service-1  | line`, so on the runtime where it matters most -- nine pods logging at
    once on microservices -- the SERVICE column was empty, the service filter had nothing
    to offer, and 55 characters of pod name sat in front of every message.

    Worse when the line was JSON: the message was taken from the parsed object, so the
    prefix was dropped entirely and nine pods' logs interleaved with no way to tell which
    said what.

    Lines below are verbatim from a live microservices workspace.
    """
    _stub_lifecycle(monkeypatch, _kube_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        parsed = page.evaluate("""async () => { await import('/js/main.js'); const {parseLogLine} = await import('/js/logs.js'); return [
          parseLogLine('[pod/rocketchat-presence-7ffb7dc6f7-7v88f/presence-service] NetworkBroker started successfully.'),
          parseLogLine('[pod/rocketchat-rocketchat-579c867b87-mclgv/rocketchat] {"level":50,"time":1755600000000,"msg":"You have not provided a mail URL."}'),
          parseLogLine('rocketchat-1  | {"level":30,"time":1755600000000,"msg":"started"}'),
        ]; }""")
        # The CONTAINER, not the pod: a pod name carries a replicaset hash that changes
        # on every rollout, and the container is the same word Compose calls a service.
        assert parsed[0]["service"] == "presence", parsed[0]
        assert parsed[0]["msg"] == "NetworkBroker started successfully.", parsed[0]
        assert parsed[0]["pod"] == "rocketchat-presence-7ffb7dc6f7-7v88f", parsed[0]
        # JSON still parses, and the pod is no longer lost with the prefix.
        assert parsed[1]["service"] == "rocketchat", parsed[1]
        assert parsed[1]["level"] == "error", parsed[1]
        assert parsed[1]["msg"] == "You have not provided a mail URL.", parsed[1]
        assert parsed[1]["pod"] == "rocketchat-rocketchat-579c867b87-mclgv", parsed[1]
        # And the Compose shape is untouched.
        assert parsed[2]["service"] == "rocketchat", parsed[2]
        assert parsed[2]["msg"] == "started", parsed[2]
        # The rendered row puts it in the service cell, with the pod on the tooltip --
        # which is what tells two replicas of one service apart.
        cell = page.evaluate("""async () => {
          await import('/js/main.js');
          const {logRow, parseLogLine} = await import('/js/logs.js');
          const r = logRow(parseLogLine(
            '[pod/rocketchat-ddp-streamer-768f896d7-2r7w7/ddp-streamer] hello'));
          const s = r.querySelector('.ls');
          return [s.textContent, s.title, r.querySelector('.lm').textContent];
        }""")
        assert cell == ["ddp-streamer", "rocketchat-ddp-streamer-768f896d7-2r7w7", "hello"], cell
        assert page.errors == [], page.errors


def test_a_note_paragraph_is_as_wide_as_the_card_it_is_in(serve, page, monkeypatch):
    """The prose in a note card was capped at 74ch. A measure like that is the right
    idea for a page of running text and the wrong one inside a card: it made the
    paragraph 647px wide in an 832px card at 1440, and the SAME 647px in a 1344px card
    at 1920 -- half the box -- while the code block directly under it ran the full
    width. Text stopping at half the box with a border drawn round the whole of it
    reads as a broken layout, not as a measure.
    """
    groups = [{"title": "1 · Point kubectl and helm at this cluster", "rows": [],
               "body": ["houston keeps its own kubeconfig so creating a cluster cannot "
                        "move the context you were using. A bare `kubectl` will not see "
                        "this workspace until it is pointed here, and every command "
                        "below assumes it:"],
               "commands": ["export KUBECONFIG=/home/you/.houston/clients/kubernetes/config"]}]
    _stub_lifecycle(monkeypatch, _kube_detail(note_groups=groups))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        page.click("text=t1234")
        page.wait_for_selector("#d-body .note-cmd")
        for width in (1440, 1920):
            page.set_viewport_size({"width": width, "height": 1000})
            page.wait_for_timeout(200)
            m = page.evaluate("""() => {
              const card = [...document.querySelectorAll('#d-body .panelcard')].find(
                (c) => c.textContent.includes('own kubeconfig'));
              const w = (sel) => Math.round(
                card.querySelector(sel).getBoundingClientRect().width);
              return {para: w('.note-p'), cmd: w('.note-cmd'),
                      card: Math.round(card.clientWidth)};
            }""")
            # The paragraph and the thing under it share one edge. Comparing them to each
            # other rather than to a number is what makes this hold at every width.
            assert abs(m["para"] - m["cmd"]) <= 2, (
                f"at {width}px the paragraph is {m['para']}px and the code block "
                f"{m['cmd']}px in a {m['card']}px card")
        assert page.errors == [], page.errors


def test_a_restart_count_that_climbs_is_a_fault_even_while_ready(serve, page, monkeypatch):
    """A pod flapping on a slow cycle is ready half the time, so readiness alone would
    miss it. The count CLIMBING is the honest test -- the same rule the boot watcher in
    `services/lifecycle.py` already used (`rc >= 2 and rc > seen["restarts"]`).

    Exercised on the rule itself, in the page: a browser test cannot easily make the
    server answer differently between two polls, and the arithmetic is the part that
    was wrong.
    """
    _stub_lifecycle(monkeypatch, _kube_detail(restarts=0))
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        seen = page.evaluate("""async () => { await import('/js/main.js'); const {restartsClimbing} = await import('/js/util.js'); return [
          restartsClimbing('w', 'pod', 3),   // first sight: not evidence of anything
          restartsClimbing('w', 'pod', 3),   // unchanged
          restartsClimbing('w', 'pod', 4),   // climbing
          restartsClimbing('w', 'pod', 4)]; }   // settled again
        """)
        assert seen == [False, False, True, False], seen
        assert page.errors == [], page.errors


def test_the_gui_has_exactly_one_jobActive_and_the_page_parses(serve, page, monkeypatch):
    """A second `const jobActive` at module scope is a SyntaxError, and app.js is one
    module with global state -- so it would not merely break this view, it would leave
    the WHOLE GUI blank.

    Nearly shipped exactly that while adding the filter above, because a helper of the
    same name already existed 2800 lines earlier. Asserted on the source as well as by
    rendering, since a blank page is the symptom and a duplicate declaration is the
    cause.
    """
    import pathlib

    import houston

    # Located through the package, not by counting directories up from this file.
    # `parent.parent` was the repo root while this test lived in `tests/`; one
    # directory deeper it is `tests/`, and the read failed with FileNotFoundError.
    src = (pathlib.Path(houston.__file__).parent
           / "data" / "webui" / "js" / "util.js").read_text()
    assert src.count("const jobActive") == 1, "duplicate module-scope declaration"

    _stub_lifecycle(monkeypatch, _fake_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        # Module exports are the interface; ES-module bindings are not globals.
        exported = page.evaluate("""async () => {
          await import('/js/main.js');
          const util = await import('/js/util.js');
          const jobs = await import('/js/jobs.js');
          return [typeof util.jobActive, typeof jobs.pollJobUntilDone,
                  typeof util.apiForm];
        }""")
        assert exported == ["function", "function", "function"]
        assert page.errors == [], page.errors


def test_the_stats_poll_discards_another_workspaces_answer(serve, page, monkeypatch):
    """`docker stats` can take most of a minute while this fires every three seconds,
    and the response carries no workspace name -- so a poll started for A that lands
    after the reader clicked B pushed A's CPU onto B's chart. A plausible-looking wrong
    answer, not a visible glitch.

    Exercised on the guard itself: making a browser deliver two overlapping slow
    responses in a fixed order is far more fragile than asserting the rule.
    """
    _stub_lifecycle(monkeypatch, _fake_detail())
    usersvc.add("alice", PASSWORD, role="admin")
    with serve() as s:
        _sign_in(page, s.url)
        page.wait_for_selector("#repros")
        src = page.evaluate("""async () => { await import('/js/main.js');
          return (await import('/js/logs.js')).startStats.toString(); }""")
        assert "inFlight" in src, "a slow poll must not be joined by the next one"
        assert "asked !== ctx.SELECTED" in src, (
            "a late answer for another workspace is discarded")
        assert "finally" in src, "the guard must be released on every path"
