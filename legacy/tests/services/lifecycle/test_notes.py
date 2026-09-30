"""`houston.services.lifecycle.notes`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston.services import lifecycle as lc
from servicehelpers import _k8s_meta


def test_the_flat_notes_are_derived_from_the_groups_not_maintained_beside_them():
    """A workspace's notes now exist in two renderings -- grouped cards in the GUI,
    a flat list of lines in the terminal and in every record written before groups
    existed. Two hand-written copies is how the two come to disagree, so the groups
    are the source and the flat list is computed from them.

    What the flattening has to preserve is the notes pattern the panel already
    parses: an INDENTED line is a copyable box, a line naming a place is a link row,
    anything else is prose. So a group's rows come out as an aligned indented block
    (a table where it is read as text), its commands come out indented (a code box),
    and its prose comes out flush (prose).
    """
    g = lc.note_group("Kubernetes", rows=[("Cluster", "kind-x"), ("Namespace", "rc-y")])
    assert g == {"title": "Kubernetes", "kind": "", "body": [], "commands": [],
                 "rows": [["Cluster", "kind-x"], ["Namespace", "rc-y"]]}

    lines = lc.flatten_notes([
        g,
        lc.note_group("Port forward", body=["It dies with the pod. Start it again:"],
                      commands=["kubectl -n rc-y port-forward deployment/rc 3001:3000"]),
    ])
    assert lines == [
        "Kubernetes:",
        "    Cluster    kind-x",      # padded to the widest key, so the column lines up
        "    Namespace  rc-y",
        "Port forward:",
        "It dies with the pod. Start it again:",
        "    kubectl -n rc-y port-forward deployment/rc 3001:3000",
    ], lines
    # The two shapes that matter to the parser, stated as such: indentation is what
    # makes a line copyable, and prose must not be indented or it becomes a command.
    assert lines[1].startswith("    ") and lines[-1].startswith("    ")
    assert not lines[4].startswith(" ")


def test_an_empty_group_contributes_no_stray_heading():
    """A group is built unconditionally and filled conditionally -- the operator note
    only exists on one MongoDB path -- so an empty one must vanish rather than leave a
    bare `Monitoring:` above nothing."""
    assert lc.flatten_notes([lc.note_group("Monitoring")]) == ["Monitoring:"]
    assert lc.flatten_notes([]) == []
    assert lc.flatten_notes([lc.note_group("", body=["a bare line"])]) == ["a bare line"]


def test_a_compose_workspaces_add_ons_are_groups_too():
    """The edge lines and the monitoring block were appended to one flat list, so a
    monitored workspace behind HTTPS had five unrelated bullets in a row. Same words,
    three sections -- and derived, so an older record gets them as well.
    """
    m = lc.runner.Metadata(
        name="c", project="houston-c", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        public_url="https://c.example.test",
        extra={"edge": True, "tls": "local", "monitoring": True})
    groups = {g["title"]: g for g in lc.note_groups_of(m)}
    assert list(groups) == ["HTTPS", "Monitoring"]
    assert "https://c.example.test" in " ".join(groups["HTTPS"]["body"])
    assert any("Grafana" in n for n in groups["Monitoring"]["body"])
    # A plain workspace has nothing to add and gets no empty sections.
    m.extra = {}
    m.public_url = ""
    assert lc.note_groups_of(m) == []


def test_a_shared_workspace_says_which_host_its_preset_pages_are_on(tmp_path, monkeypatch):
    """Four presets print browser URLs that say `localhost` — phpLDAPadmin, MinIO's
    console, Mailpit's inbox, the livechat demo page.

    All were written when the browser was assumed to be on the docker host. On a
    workspace bound wide or given a public URL it is not, and `localhost` then names
    the reader's own machine: the same mistake that made the saml and oidc buttons
    fail silently, in prose instead of a setting. A preset builder is never given the
    bind host or the advertised URL, so the correction belongs to the record.
    """
    from houston import runner
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def meta(**extra):
        m = runner.Metadata(name="w", project="p", rc_version="8.5.1", rc_image="i",
                            mongo_tag="8.0", mongo_flavor="official", preset="ldap",
                            root_url="http://localhost:3007", host_port=3007,
                            version_source="t")
        m.extra.update(extra)
        return m

    shared = lc.note_groups_of(meta(
        sidecar_ports=[8082], bind_host="0.0.0.0",
        advertised_url="http://box.example.com:3007"))
    body = " ".join(l for g in shared for l in (g.get("body") or []))
    assert "box.example.com:8082" in body, body
    assert "localhost" in body, "name the thing being corrected, not just the fix"

    # Bound wide with no URL given: the host is unknown, so it is not invented.
    wide = lc.note_groups_of(meta(sidecar_ports=[8082], bind_host="0.0.0.0"))
    assert "<this-box>:8082" in " ".join(
        l for g in wide for l in (g.get("body") or [])), wide

    def titles(groups):
        return [g.get("title") for g in groups]

    # An ordinary laptop workspace gains nothing: localhost really is localhost.
    assert "Reaching this preset's own pages" not in titles(
        lc.note_groups_of(meta(sidecar_ports=[8082], bind_host="127.0.0.1")))
    # And a preset with no pages of its own has nothing to correct.
    assert "Reaching this preset's own pages" not in titles(
        lc.note_groups_of(meta(bind_host="0.0.0.0")))

    # THE CORRECTION MUST NOT DESCRIBE TEXT THAT IS NOT THERE. A `saml` workspace with
    # a derived `idp_host` already prints the real host in every line, and the first
    # version of this told its reader "the URLs above say localhost" about notes that
    # said no such thing. Keyed on the notes, so it stays silent here.
    saml = runner.Metadata(name="s", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="saml",
                           root_url="http://localhost:3007", host_port=3007,
                           version_source="t")
    saml.extra.update({"sidecar_ports": [8081], "bind_host": "0.0.0.0",
                       "advertised_url": "http://box.example.com:3007",
                       "params": {"idp_host": "box.example.com"}})
    groups = lc.note_groups_of(saml)
    assert "Reaching this preset's own pages" not in titles(groups), titles(groups)
    assert not any("localhost" in l for g in groups
                   for l in (g.get("body") or [])), groups


def test_summary_carries_preset_notes_derived_and_not_the_frozen_copy():
    """These are what the GUI renders from the create job's result and the CLI prints
    after `up` -- the Keycloak realm, the /etc/hosts line.

    DERIVED from the preset on every read, not read back out of the record. A note
    written into `repro.json` at create time keeps its wording for the life of the
    workspace, which is how a Kubernetes workspace went on telling people `backup`
    had no path on that runtime for three releases after it grew one -- the fix
    reached new workspaces and no existing one. So the stale copy in this record is
    deliberately not what the preset says, and it is the preset's that has to come
    out.
    """
    from houston import presets

    m = lc.runner.Metadata(
        name="x", project="houston-x", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="oidc",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        extra={"notes": ["a sentence some older release wrote down"]})
    s = lc._summary(m)
    assert s["notes"] == lc.flatten_notes([lc.note_group(
        "Scenario · oidc", kind="scenario", body=presets.load("oidc").notes)])
    assert "a sentence some older release wrote down" not in s["notes"]
    # The grouped form is what the panel renders, and the scenario has to be MARKED
    # as one -- the panel feeds that group back into its links card rather than
    # giving it a card of its own.
    assert [g["kind"] for g in s["note_groups"]] == ["scenario"]
    assert any("/etc/hosts" in n for n in s["notes"])


def test_the_kubeconfig_note_matches_which_cluster_the_workspace_is_in(monkeypatch):
    """The note said `export KUBECONFIG=<houston's own>` on every Kubernetes
    workspace. On a cluster houston ADOPTED that is wrong three ways -- it created no
    cluster, that file does not describe yours, and your kubectl already pointed at the
    right one -- so pasting step 1 broke the shell it was pasted into. houston only
    keeps its own kubeconfig for the cluster it created (`own=is_ours(context)`), and
    the note has to say the same thing the code does."""
    from houston import runner
    from houston.services import k8s, lifecycle as lc

    def note_text(context):
        meta = runner.Metadata(
            name="w", project=k8s.namespace_for("w"), rc_version="8.5.1",
            rc_image="registry.rocket.chat/rocketchat/rocket.chat:8.5.1",
            mongo_tag="8.0", mongo_flavor="community", preset="default",
            root_url="http://localhost:3000", host_port=3000,
            version_source="shipped")
        meta.extra.update({"runtime": "kubernetes", "namespace": k8s.namespace_for("w"),
                           "context": context, "deployment": "monolith"})
        return "\n".join(lc.flatten_notes(lc.note_groups_of(meta)))

    ours = note_text(k8s.CONTEXT)
    assert "export KUBECONFIG=" in ours, ours
    assert str(k8s.owned_kubeconfig()) in ours

    adopted = note_text("default")
    assert "export KUBECONFIG=" not in adopted, \
        "told the user to export a kubeconfig that does not describe their cluster"
    assert str(k8s.owned_kubeconfig()) not in adopted
    assert "'default'" in adopted, adopted


def test_the_notes_say_the_operator_is_shared_when_it_is_used():
    """The deviation from the official guide has to be visible where someone reads it.

    The guide installs the operator INTO the Rocket.Chat namespace. houston runs
    several workspaces, its CRDs are cluster-scoped, so it installs once in
    houston-system watching everything. Undocumented, the first person to run the
    guide's `kubectl -n <ns> get pods` finds no operator and concludes it was never
    installed.
    """
    # Asserted against the groups a real record produces rather than against the
    # source of the function that builds them: the notes are derived on every read
    # now, so the record is the input and the rendered groups are the output, and
    # only the second of those is what anybody sees.
    def groups_for(managed_by):
        m = lc.runner.Metadata(
            name="k", project="houston-k", rc_version="8.5.1", rc_image="i",
            mongo_tag="8.0", mongo_flavor="official", preset="default",
            root_url="http://localhost:3000", host_port=3000, version_source="map",
            extra={"runtime": "kubernetes", "deployment": "microservices",
                   "namespace": "houston-k", "context": "kind-houston-local",
                   "release": "rocketchat", "mongo_managed_by": managed_by,
                   "mongo_image": "mongo:8.0"})
        return {g["title"]: g for g in lc.note_groups_of(m)}

    op = groups_for("operator")
    shared = op["The MongoDB operator is shared"]
    assert "official guide" in " ".join(shared["body"])
    # And it says where to look, not just that it is elsewhere.
    assert any("get mongodbcommunity" in c for c in shared["commands"])
    assert ("Managed by", "the official operator") in [tuple(r) for r in op["MongoDB"]["rows"]]
    # Monitoring deviates the same way and for the same reason, on both paths.
    assert "shared by the cluster, not installed per" in " ".join(op["Monitoring"]["body"])
    # A plain StatefulSet has no operator to explain, and says so where the guide
    # would have led someone to expect authentication.
    sts = groups_for("statefulset")
    assert "The MongoDB operator is shared" not in sts
    assert ("Authentication", "none") in [tuple(r) for r in sts["MongoDB"]["rows"]]
    assert "official guide" in " ".join(sts["MongoDB"]["body"])


def test_the_url_is_not_repeated_as_a_note_when_the_bind_is_loopback():
    """"reachable on this box at http://localhost:3000" was the fourth copy of that
    string on one screen -- the summary panel prints it, the panel's identity line
    carries it, the links table lists it -- and the browser had to de-duplicate the
    note against the link row to stop it appearing twice.

    What is not said anywhere else is what a NON-loopback bind means, and that is the
    only case the group appears in.
    """
    quiet = [g["title"] for g in lc.note_groups_of(_k8s_meta())]
    assert "Reachable from other machines" not in quiet
    assert not any("reachable on this box" in n
                   for n in lc.flatten_notes(lc.note_groups_of(_k8s_meta())))

    public = lc.note_groups_of(_k8s_meta(bind_host="0.0.0.0"))
    warned = {g["title"]: g for g in public}["Reachable from other machines"]
    assert "0.0.0.0" in " ".join(warned["body"])
    assert "admin123" in " ".join(warned["body"])          # what it exposes
    # The port-forward has to come back the same way it was published, or the
    # workspace is unreachable from the machines the note just warned about.
    forward = {g["title"]: g for g in public}["2 · Open the way in"]
    assert "--address 0.0.0.0" in forward["commands"][0]
