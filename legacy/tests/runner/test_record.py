"""`houston.runner.record`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from edgehelpers import _acme_workspace
from houston import runner
from houston.services import edge as fd
from houston.services import lifecycle as lc
from servicehelpers import _legacy_home
import json
import pytest


def test_read_meta_tolerates_a_field_from_a_newer_version(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ws = tmp_path / "repros" / "r"
    ws.mkdir(parents=True)
    (ws / "docker-compose.yml").write_text("name: houston-r\n", encoding="utf-8")
    blob = {
        "name": "r", "project": "houston-r", "rc_version": "8.5.1", "rc_image": "i",
        "mongo_tag": "8.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3000", "host_port": 3000,
        "version_source": "map (fallback)",
        "a_field_from_the_future": {"nested": True},   # written by a newer houston
    }
    (ws / "repro.json").write_text(json.dumps(blob), encoding="utf-8")
    # Metadata(**blob) used to TypeError, and list_meta swallows that -- silently
    # dropping the repro from `houston list`.
    m = runner.read_meta("r")
    assert m.name == "r" and m.host_port == 3000
    assert [x.name for x in runner.list_meta()] == ["r"]


def test_metadata_external_url_prefers_https_and_survives_an_old_repro_json(tmp_path, monkeypatch):
    """public_url is additive: a repro.json written before it must still load."""
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = runner.Metadata(
        name="x", project="houston-x", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map")
    assert m.external_url == "http://localhost:3000"       # no TLS -> unchanged
    m.public_url = "https://x.houston.localhost:8443"
    assert m.external_url == "https://x.houston.localhost:8443"

    runner.write("x", "services: {}\n", m)
    (runner.workspace("x") / "repro.json").write_text(
        json.dumps({"name": "x", "project": "houston-x", "rc_version": "8.6.1",
                    "rc_image": "i", "mongo_tag": "8.0", "mongo_flavor": "official",
                    "preset": "default", "root_url": "http://localhost:3000",
                    "host_port": 3000, "version_source": "map"}), encoding="utf-8")
    old = runner.read_meta("x")
    assert old.public_url == "" and old.external_url == "http://localhost:3000"


def test_a_generated_page_for_the_browser_gets_the_advertised_url(tmp_path, monkeypatch):
    """`{{ROOT_URL}}` substituted the loopback URL even when the caller gave a real one.

    `meta.root_url` is deliberately `http://localhost:<port>` -- the address houston's
    own API calls use -- and `public_url` is set only by TLS, so `--root-url
    http://box:3007` reached the compose ROOT_URL and nothing else. The livechat
    preset's demo page uses this placeholder to load Rocket.Chat's widget script, so
    on any machine but the docker host it fetched that script from the visitor's own
    localhost and the widget silently never appeared.
    """
    from houston import runner

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(name="w", project="houston-w", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="livechat", root_url="http://localhost:3007",
                           host_port=3007, version_source="t")
    meta.extra["advertised_url"] = "http://box.example.com:3007"
    runner.write("w", "services: {}\n", meta,
                 files=[("livechat/index.html", "src='{{ROOT_URL}}/livechat'")])
    page = (runner.workspace("w") / "livechat" / "index.html").read_text()
    assert "http://box.example.com:3007/livechat" in page, page
    assert "localhost" not in page, page

    # With nothing advertised the loopback URL is still right, and still used.
    plain = runner.Metadata(name="p", project="houston-p", rc_version="8.5.1",
                            rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                            preset="livechat", root_url="http://localhost:3008",
                            host_port=3008, version_source="t")
    runner.write("p", "services: {}\n", plain,
                 files=[("livechat/index.html", "src='{{ROOT_URL}}/livechat'")])
    assert "http://localhost:3008/livechat" in (
        runner.workspace("p") / "livechat" / "index.html").read_text()


def test_promote_command_reproduces_the_flags_actually_used():
    """The staging -> production hint must be copy-pasteable.

    It is the same two flags the workspace was created with, plus --force, so it
    reproduces the repro rather than describing a different one.
    """
    from houston import runner
    from houston.cli import _promote_command

    def meta(**extra):
        return runner.Metadata(
            name="testrepo", project="p", rc_version="8.4.2", rc_image="i",
            mongo_tag="8.0", mongo_flavor="official", preset="default",
            root_url="http://localhost:3000", host_port=3000, version_source="map",
            public_url="https://testrepo.kestron.org", extra={"tls": "acme", **extra})

    cmd = _promote_command(meta(tls_email="me@example.com"), "testrepo.kestron.org")
    assert "--domain testrepo.kestron.org" in cmd
    assert "--email me@example.com" in cmd
    assert "--force" in cmd and "--wait" in cmd
    # Nothing that no longer exists as a flag.
    for dead in ("--acme-challenge", "--acme-dns-provider", "--acme-email",
                 "--acme-staging", "--tls-cert", "--tls-san"):
        assert dead not in cmd

    # No --bind either: the public bind is derived at create time from --domain,
    # so spelling it in the hint would be noise the user has to understand.
    assert "--bind" not in cmd


def test_detail_exposes_the_https_fields_the_panel_keys_off(tmp_path, monkeypatch):
    """The panel's HTTPS row and "Check TLS" action both test detail().public_url.

    list_repros() carried public_url/tls and detail() did not, so the whole feature
    was invisible in the detail panel even though the links were right.
    """
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="g", project="houston-g", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map",
        public_url="https://g.houston.localhost:8443",
        extra={"tls": "local", "tls_ports": [8443]})
    monkeypatch.setattr(runner.host, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner.record, "read_meta", lambda n: meta)
    monkeypatch.setattr(runner.record, "read_compose", lambda n: {"services": {"rocketchat": {}}})

    d = lc.detail("g")
    assert d["public_url"] == "https://g.houston.localhost:8443"
    assert d["tls"] == "local"
    # The clickable link prefers https, and the plain port stays available.
    urls = [x["url"] for x in d["links"]]
    assert "https://g.houston.localhost:8443" in urls
    assert "http://localhost:3000" in urls

    # A repro without --https must not grow the row or the action.
    meta.public_url = ""
    meta.extra = {}
    d2 = lc.detail("g")
    assert d2["public_url"] == "" and d2["tls"] == ""


def test_a_kubernetes_workspace_keeps_the_namespace_it_was_created_in(tmp_path,
                                                                     monkeypatch):
    """A namespace cannot be renamed in place, so once its objects exist the prefix
    that minted it is history rather than a description.

    Deriving it meant a changed prefix would send `down` at a namespace that was
    never created while the real one kept its pods, its PVCs and its port-forward.
    Pre-fix this returns "houston-legacy"; the recorded namespace is the finding.
    """
    from houston import runner as runnersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runnersvc.Metadata(name="legacy", project="rcrepro-legacy",
                              rc_version="8.5.1", rc_image="i", mongo_tag="7.0",
                              mongo_flavor="official", preset="default",
                              root_url="http://localhost:3000", host_port=3000,
                              version_source="x",
                              extra={"namespace": "rc-repro-legacy"})
    runnersvc.write_record("legacy", meta)
    assert k8s.namespace_for("legacy") == "rc-repro-legacy", (
        "a workspace must be addressed by the namespace its objects are in, not "
        "by the prefix this build would mint today")
    assert k8s.namespace_for("absent") == k8s.mint_namespace("absent")


def test_the_pre_rename_state_directory_is_adopted_not_recreated(tmp_path,
                                                                 monkeypatch):
    """The move must carry the workspace across intact, still addressed by the names
    its containers and namespace actually carry.

    Recreating anything here would destroy the customer data a repro exists to hold,
    so the check is that the OLD project and the OLD namespace survive the migration.
    """
    from houston import runner as runnersvc
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    legacy = _legacy_home(tmp_path)

    res = migratesvc.migrate()
    assert res["moved"] is True
    assert not legacy.exists(), "the old directory must not be left behind"
    assert (tmp_path / ".houston" / "repros" / "w1" / "repro.json").exists()
    assert runnersvc.project_name("w1") == "rcrepro-w1", "adopted, not re-minted"
    assert res["namespaces_recorded"] == ["w1"]
    meta = runnersvc.read_meta("w1")
    assert meta.extra["namespace"] == "rc-repro-w1"


def test_doctor_reports_a_workspace_whose_idp_points_at_this_machine(tmp_path, monkeypatch):
    """`up` warns about this at create time now, and every workspace made before that
    is silent.

    An IdP preset addresses its own service as THIS machine by default, which on a
    shared box names each visitor's own laptop: the SAML button returns to the login
    page, the OIDC popup opens blank, presigned previews fail, and none of them logs
    anything.
    """
    from houston import runner
    from houston.services import doctor

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def meta(name, preset, **extra):
        m = runner.Metadata(name=name, project="p", rc_version="8.5.1", rc_image="i",
                            mongo_tag="8.0", mongo_flavor="official", preset=preset,
                            root_url="http://localhost:3001", host_port=3001,
                            version_source="t")
        m.extra.update(extra)
        return m

    listed = [
        meta("wide", "saml", bind_host="0.0.0.0"),                       # reported
        meta("told", "oidc", bind_host="0.0.0.0",
             params={"idp_host": "box.example.com"}),                    # already handled
        meta("local", "saml", bind_host="127.0.0.1"),                    # localhost is true
        meta("plain", "default", bind_host="0.0.0.0"),                   # no IdP at all
    ]
    from houston import runner as runner_mod

    monkeypatch.setattr(runner_mod.record, "list_meta", lambda: listed)

    hits = [r for r in doctor.run_checks()["checks"]
            if r.get("check") == "preset-browser-host"]
    assert len(hits) == 1, [h["message"][:60] for h in hits]
    assert "'wide'" in hits[0]["message"], hits[0]
    assert "--set idp_host=" in hits[0]["message"], hits[0]


def test_a_stale_kubernetes_record_is_a_warning_not_a_failed_preflight(monkeypatch,
                                                                      tmp_path):
    """`doctor` reported a missing cluster as a FAIL when any record referenced it.

    So the verdict read "Not ready — fix the ✗ item(s)" about a box that was completely
    usable: the next `up` builds a fresh cluster, and the stale record is a cleanup task
    rather than a broken machine. A verdict that fails on tidiness is one people stop
    reading. It is a warning now, and it names the command that clears the record --
    the place to learn about a stale record is the command that removes it.

    Driven through `run_checks` rather than by reading the source, so it asserts the
    STATUS a caller sees and the verdict it produces.
    """
    from houston import runner
    from houston.services import doctor as doctorsvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="ghost", project="houston-ghost", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map")
    meta.extra.update({"runtime": "kubernetes", "namespace": "houston-ghost",
                       "context": k8s.CONTEXT})
    monkeypatch.setattr(runner.record, "list_meta", lambda: [meta])

    # A box with the tools, no cluster, and one Kubernetes record pointing at it.
    pre = k8s.Preflight(
        tools={}, cluster_exists=False, cluster_reachable=False, storage_classes=[],
        default_storage_class="", ingress_classes=[], other_clusters=[], namespaces=[],
        distribution="kind", node_count=0, architectures=[], metrics=False,
        loadbalancer="", context=k8s.CONTEXT, provider="kind", will_create=True,
        probe_failed="")
    monkeypatch.setattr(k8s.probe, "preflight", lambda *a, **k: pre)

    rows = doctorsvc.run_checks()["checks"]
    hits = [r for r in rows if r.get("check") == "kubernetes-cluster"]
    assert hits, sorted({r.get("check") for r in rows})
    row = hits[0]

    assert row["status"] == "warn", (
        f"a stale record still {row['status']}s the preflight: {row['message']}")
    assert "is gone" in row["message"], row["message"]
    # Actionable: names the record and the command that clears it.
    assert "ghost" in row["message"], row["message"]
    assert "houston down" in row["message"], row["message"]


def test_an_interrupted_env_apply_is_healed_by_the_next_one(monkeypatch, tmp_path):
    """Compose decides what to recreate from a config hash on the container, and that
    was measured not to fire: after the interrupted apply above, re-running `env`
    reported success and changed nothing.

    Forcing it is scoped to the one service — Mongo and its volume are untouched, which
    is the reason recreating here is safe at all.
    """
    from houston import runner
    from houston.services import envvars, lifecycle as lcmod

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lcmod.naming, "resolve_name", lambda n: "drift")
    meta = type("M", (), {"extra": {}, "rc_version": "8.5.1", "name": "drift"})()
    monkeypatch.setattr(runner.record, "read_meta", lambda n: meta)
    monkeypatch.setattr(runner.record, "read_compose", lambda n: {"services": {"rocketchat": {
        "environment": {"ROOT_URL": "http://localhost:3000"}}}})
    monkeypatch.setattr(runner.record, "write", lambda *a, **kw: None)
    monkeypatch.setattr(envvars, "warn_bare_settings", lambda *a, **kw: None)
    seen: dict = {}

    def fake_up(name, *, pull=True, force_recreate=""):
        seen["force"] = force_recreate
        return 0

    monkeypatch.setattr(runner.engine, "up", fake_up)
    envvars.set_env("drift", {"A": "1"}, [], restart=True)
    assert seen["force"] == "rocketchat", \
        "without --force-recreate an interrupted apply persists and no command heals it"


def test_root_url_substitution(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import runner
    meta = runner.Metadata(
        name="lc", project="houston-lc", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="livechat",
        root_url="http://localhost:4321", host_port=4321, version_source="map",
    )
    runner.write("lc", "services: {}\n", meta,
                 files=[("livechat/index.html", "src={{ROOT_URL}}/livechat")])
    written = (runner.workspace("lc") / "livechat/index.html").read_text()
    assert written == "src=http://localhost:4321/livechat"   # placeholder resolved


def test_used_ports_includes_sidecars_and_monitoring(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="x", project="houston-x", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="saml",
        root_url="http://localhost:3000", host_port=3000, version_source="map",
        extra={"sidecar_ports": [8081], "monitoring_ports": [9090, 5050]},
    )
    runner.write("x", "services: {}\n", meta)
    # RC port, sidecar port, AND monitoring ports are all claimed so a new
    # repro's auto-picked port can't collide with any of them.
    assert {3000, 8081, 9090, 5050} <= runner.used_ports()


def test_a_workspace_is_not_readable_by_other_local_users(tmp_path, monkeypatch):
    """The compose file carries ADMIN_PASS and REG_TOKEN, and preset files carry
    LDAP/MinIO credentials. At the default umask every local user could read them
    -- fine on a laptop, not on the shared box this is for."""
    import stat

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    from houston import runner

    runner.write("x", "services: {}\n",
                 runner.Metadata(name="x", project="p", rc_version="8.5.1",
                                 rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                                 preset="default", root_url="u", host_port=3000,
                                 version_source="s"),
                 files=[("ldap/seed.ldif", "userPassword: secret\n")])
    ws = runner.workspace("x")
    # The DIRECTORY is the barrier: 0700 means no other local user can traverse
    # in, so nothing inside is reachable whatever its own mode.
    assert stat.S_IMODE(ws.stat().st_mode) == 0o700
    # Nested directories stay traversable: some volumes mount a DIRECTORY and the
    # container must list it. Prometheus globs its file_sd_configs dir, and at
    # 0700 it started cleanly and scraped NOTHING -- worse than crashing. The
    # 0700 root keeps other users out of these regardless of their own mode.
    assert stat.S_IMODE((ws / "ldap").stat().st_mode) == 0o755
    # Files stay readable, and MUST: half of these are bind-mounted into
    # containers that run as non-root (Prometheus as 65534, Grafana, Loki, the
    # OTel collector). 0600 made them unreadable and Prometheus crash-looped on
    # "open /etc/prometheus/prometheus.yml: permission denied". Verified that a
    # container reads a 0644 file inside a 0700 directory perfectly well -- the
    # bind mount is resolved by the daemon, so the host directory never applies.
    for rel in ("docker-compose.yml", "repro.json", "ldap/seed.ldif"):
        mode = stat.S_IMODE((ws / rel).stat().st_mode)
        assert mode == 0o644, f"{rel} is {oct(mode)}"


def test_a_compose_only_command_refuses_cleanly_rather_than_traceback(monkeypatch, tmp_path):
    """Found by running the command, not by the suite.

    Adding the topology guard to `stats` made it the FIRST raiser of a ReproError
    in a command that had no `except errors.ReproError` handler — every other
    handler was wired when the taxonomy landed, but `stats` had never needed one.
    The guard therefore escaped as a rich traceback and exit 1: a stack dump where
    the user should see one red line, and the one exit code the README defines as
    "a bug in houston" for a condition that is entirely expected.

    This is the shape the whole taxonomy exists to prevent, so it is pinned at the
    process boundary where a script would see it.

    It is driven through `env --set` now rather than `stats`, because `stats` gained
    a Kubernetes path and no longer refuses. The property being pinned is the
    refusal's SHAPE, not which command happens to raise it, so it follows whichever
    command still does.
    """
    from typer.testing import CliRunner

    from houston import cli, runner as runner_mod
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = runner_mod.Metadata(name="k", project="p", rc_version="8.6.1", rc_image="i",
                            mongo_tag="8.0", mongo_flavor="official", preset="default",
                            root_url="u", host_port=3010, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    runner_mod.write("k", "services: {}\n", m)
    monkeypatch.setattr(runner_mod.host, "docker_available", lambda **_k: True)

    res = CliRunner().invoke(cli.app, ["env", "--name", "k", "--set", "A=b"])
    assert res.exit_code == 2, f"a compose-only refusal exited {res.exit_code}, expected 2"
    assert res.exception is None or isinstance(res.exception, SystemExit), (
        "the error escaped as an exception instead of being rendered")
    assert "helm" in res.output, "the alternative is stated to the user"
    assert "Traceback" not in res.output


def test_a_local_https_workspace_is_not_adoptable(tmp_path, monkeypatch):
    """`--https` uses a local certificate on its own allocated port; it holds no
    443 and has no public name to register."""
    import dataclasses
    import json

    from houston import runner
    from houston.errors import ValidationError

    f = {x.name: "" for x in dataclasses.fields(runner.Metadata)}
    f.update(name="l", project="houston-l", rc_version="8.5.1", mongo_tag="8.0",
             host_port=3000, preset="default", root_url="http://localhost:3000",
             extra={"tls": "local", "tls_ports": [8443]})
    ws = runner.workspace("l")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(json.dumps(dataclasses.asdict(runner.Metadata(**f))))
    (ws / "docker-compose.yml").write_text("services: {}\n")

    assert fd.holders_of_443() == []
    with pytest.raises(ValidationError):
        fd.adopt("l")


def test_a_workspace_with_no_name_restores_nothing(tmp_path, monkeypatch):
    from houston import runner
    from houston.services import lifecycle as lc

    _acme_workspace("w", "t1.example.com", tmp_path)
    meta = runner.read_meta("w")
    meta.public_url = ""
    called = []
    monkeypatch.setattr(fd.routes, "register", lambda *a, **k: called.append(True))
    lc._restore_route(meta)
    assert called == []


def test_tls_status_survives_a_workspace_with_no_port_of_its_own(tmp_path, monkeypatch):
    """Adoption clears tls_ports, and `[0]` on the empty list was an IndexError --
    a traceback from `tls-status` on exactly the workspaces the edge serves."""
    from houston import cli, runner
    from typer.testing import CliRunner

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("w", "t1.example.com", tmp_path)
    meta = runner.read_meta("w")
    meta.extra["tls_ports"] = []
    runner.write("w", "services: {}\n", meta)
    monkeypatch.setattr(runner.host, "docker_available", lambda **k: True)
    r = CliRunner().invoke(cli.app, ["tls-status", "--name", "w"])
    assert "IndexError" not in (r.output or ""), r.output
    assert not isinstance(r.exception, IndexError)


def test_tls_troubleshooting_on_kubernetes_does_not_send_you_to_the_edge(tmp_path,
                                                                        monkeypatch):
    """A Kubernetes workspace's certificate is not the edge's, and every line of this
    advice named Traefik and `houston logs` -- which on that runtime shows
    Rocket.Chat, not a proxy. The tlsalpn/Cloudflare branch is about a challenge
    cert-manager does not implement at all.

    Sending someone to `edge logs` for a certificate the edge never saw is the entire
    reason this branch exists.
    """
    from houston import cli, runner
    from houston.services import topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    _acme_workspace("kws", "k1.example.com", tmp_path)
    _acme_workspace("w", "t1.example.com", tmp_path)      # the Compose control
    meta = runner.read_meta("kws")
    topology.stamp(meta.extra, topology.KUBERNETES)
    meta.extra["namespace"] = "houston-kws"
    runner.write("kws", "", meta)

    said: list[str] = []
    monkeypatch.setattr(cli.ui, "hint", lambda m, *a, **k: said.append(m))
    cli._tls_troubleshoot(runner.read_meta("kws"), "acme", "k1.example.com", 443)
    joined = "\n".join(said)
    assert "describe certificate kws-tls" in joined, joined
    assert "clusterissuer" in joined, joined
    assert "order,challenge" in joined, "an ACME order is where a public name fails"
    assert "tlsalpn" not in joined, "cert-manager does not implement it"
    assert "grep -i traefik" not in joined, "the edge's log has nothing about this name"

    # And the Compose advice is untouched, which is what the Compose suite guards.
    said.clear()
    cli._tls_troubleshoot(runner.read_meta("w"), "acme", "t1.example.com", 443)
    assert "tlsalpn" in "\n".join(said), "still the right advice on Compose"
