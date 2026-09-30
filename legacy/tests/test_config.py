"""`houston.config`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
import os
import pathlib

from edgehelpers import _home as _home
from houston import config
from houston import presets
from houston.services import edge as fd
import pytest


def test_the_admin_and_the_setup_wizard_reach_a_kubernetes_workspace():
    """`up` printed "Login admin / admin123" for a workspace where that user had
    never been created and the setup wizard was still waiting.

    Compose sets five variables to make a repro usable on arrival -- skip the wizard,
    auto-provision the first admin -- and the Kubernetes values carried none of them.
    Confidently stated credentials that do not work are worse than printing nothing:
    they send someone to debug their own typing.
    """
    from houston import config
    from houston.services import k8s

    env = {e["name"]: e["value"] for e in
           k8s.values_for(rc_version="8.5.1", rc_image="img",
                          microservices=True)["extraEnv"]}
    assert env["OVERWRITE_SETTING_Show_Setup_Wizard"] == "completed"
    # NO `INITIAL_USER`. It was here as "yes", which Rocket.Chat parses as JSON and
    # rejects -- `SyntaxError: Unexpected token 'y'` on every boot of every workspace --
    # and `true`, which RC's docs use, is worse: it parses, finds no `_id`, and logs
    # "Ignoring environment variable INITIAL_USER". The admin never came from it.
    # Measured on a fresh 8.5.1 database with the variable absent: zero INITIAL_USER
    # lines, login succeeds, /api/v1/me reports roles ['admin'], Show_Setup_Wizard
    # reads `completed`.
    assert "INITIAL_USER" not in env, (
        "INITIAL_USER is back; it does nothing but add a parse error to every boot")
    assert env["ADMIN_USERNAME"] == config.ADMIN_USERNAME
    assert env["ADMIN_PASS"] == config.ADMIN_PASSWORD
    assert env["ADMIN_EMAIL"] == config.ADMIN_EMAIL
    # And NOTHING the chart already sets. These two were here for one commit and
    # broke every install: a second entry for the same env key is not an override
    # but a conflict, and server-side apply refuses the Deployment outright --
    # "duplicate entries for key [name=\"DEPLOY_PLATFORM\"]". The chart knows it is
    # helm on Kubernetes; extraEnv is for what the chart does NOT know.
    for owned in ("DEPLOY_METHOD", "DEPLOY_PLATFORM", "MONGO_URL", "ROOT_URL",
                  "PORT"):
        assert owned not in env, (
            f"{owned} is set by the chart; a duplicate env key fails the install")


def test_config_env_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setenv("HOUSTON_REG_TOKEN", "tok-from-env")
    cfg = config.load_config()
    assert cfg["reg_token"] == "tok-from-env"
    # env wins over the file
    config.save_config({"reg_token": "tok-from-file"})
    assert config.load_config()["reg_token"] == "tok-from-env"


def test_the_pre_rename_environment_variable_still_says_where_state_lives(
        tmp_path, monkeypatch):
    """Renaming RC_REPRO_* to HOUSTON_* without reading the old spelling would not
    have failed -- it would have gone quiet.

    An RC_REPRO_HOME sitting in a shell profile or a CI job would simply stop being
    consulted, and the tool would resolve state to ~/.houston while every workspace
    that box owns is somewhere else: `list` empty, `up` cheerfully making a second
    copy. Pre-fix `home()` returns the default; the legacy path is the finding.
    """
    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("RC_REPRO_HOME", str(tmp_path / "legacy"))
    assert config.home() == tmp_path / "legacy"
    assert "RC_REPRO_HOME" in config.legacy_env_used(), "doctor has to be able to name it"


def test_env_values_never_persisted_to_config_file(tmp_path, monkeypatch):
    # Regression: read-modify-write flows (up --pin / use) must not bake
    # ephemeral env values (secrets!) into config.yaml.
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setenv("HOUSTON_REG_TOKEN", "SECRET")
    raw = config.load_config(with_env=False)   # what save paths must use
    assert "reg_token" not in raw
    raw["default_repro"] = "x"
    config.save_config(raw)
    assert "SECRET" not in config.config_file().read_text()
    # ...while readers still see the env value
    assert config.load_config()["reg_token"] == "SECRET"


def test_update_config_is_a_locked_read_modify_write(tmp_path, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setenv("HOUSTON_REG_TOKEN", "ephemeral-secret")
    config.update_config(lambda cfg: cfg.__setitem__("default_repro", "a"))
    config.update_config(lambda cfg: cfg.__setitem__("other", 1))
    raw = config.config_file().read_text(encoding="utf-8")
    # both updates survive (a read/write pair could lose one), and the env-only
    # token is never persisted into the file
    assert config.load_config(with_env=False) == {"default_repro": "a", "other": 1}
    assert "ephemeral-secret" not in raw


def test_a_browser_host_is_only_derived_when_something_could_reach_it(tmp_path,
                                                                     monkeypatch):
    """Deriving a host whose port is on loopback makes things WORSE, not better.

    OIDC's url serves the browser AND Rocket.Chat's own backend. Moving it off compose
    DNS -- which always worked -- onto the host's address breaks the backend leg too
    unless the ports are published somewhere a container can reach: measured, a port
    published on 127.0.0.1 is unreachable from a container by the host's address
    (connect fails) and reachable when published on 0.0.0.0 (200). `up --preset oidc
    --domain rc.example.com` is the plausible invocation that hits it, so the
    derivation is gated on the bind and the un-derivable states are reported instead.
    """
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    def derived(**kw):
        req = lc.CreateReq(version="8.5.1", name="n", **kw)
        lc._derive_idp_host(req)
        return (req.params or {}).get("idp_host")

    # Nothing to derive from, or nothing that could answer: left alone.
    assert derived(preset="saml") is None
    assert derived(preset="oidc", root_url="http://172.16.0.2:3013") is None, \
        "loopback bind — the derived host would be unreachable from RC itself"
    assert derived(preset="oidc", domain="rc.example.com") is None, \
        "same, and this is the invocation somebody would actually type"
    assert derived(preset="oidc", root_url="http://localhost:3001") is None

    # A bind that can carry it: derived.
    assert derived(preset="oidc", root_url="http://172.16.0.2:3013",
                   bind="0.0.0.0") == "172.16.0.2"
    assert derived(preset="saml", domain="rc.example.com",
                   bind="0.0.0.0") == "rc.example.com"

    # A configured bind counts the same as the flag, or the two would disagree about
    # the same workspace.
    from houston import config
    cfg = config.load_config()
    cfg["bind_host"] = "0.0.0.0"
    config.save_config(cfg)
    assert derived(preset="oidc", root_url="http://172.16.0.2:3013") == "172.16.0.2"


# --- a saved setting that decides something must say so ------------------------------

def test_a_saved_cluster_never_changes_what_a_bare_up_means_but_now_says_so(monkeypatch,
                                                                           tmp_path):
    """Two opposite complaints, one silence.

    Setting `kubernetes.context` changes what other commands mean and nothing ever
    mentioned it. So somebody sets a default cluster, runs `up`, and gets a Docker
    workspace -- correct, deliberate, and indistinguishable from a bug. And somebody
    runs `cluster create`, which SETS that default, after which `--runtime kubernetes`
    quietly means the EKS cluster it just built rather than the free local one it meant
    yesterday, at roughly $8.46 a day.

    Neither is a refusal: the first is right and the second is a thing people want.
    The fix is that both are now said out loud.
    """
    from houston import config
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    EKS = "arn:aws:eks:us-east-1:1:cluster/support"

    def said(saved, typed, **kw):
        cfg = config.load_config()
        cfg[config.KUBE_CONTEXT_KEY] = saved
        config.save_config(cfg)
        out = []
        req = lc.CreateReq(version="8.5.1", name="t", runtime=typed, **kw)
        was = str(req.runtime or "").strip()
        req.runtime = lc.infer_runtime(req)
        lc._say_where_this_is_going(req, was, lambda e: out.append((e.level, e.message)))
        return req.runtime, out

    # THE BEHAVIOUR IS UNCHANGED -- a bare `up` is still Docker. Only the silence went.
    runtime, out = said(EKS, "")
    assert runtime in ("", "docker"), "a saved cluster must NEVER move a bare `up`"
    assert out and "going to Docker" in out[0][1]
    assert "--runtime kubernetes" in out[0][1], "and it must say how to use the cluster"

    # An explicit `--runtime docker` is not confusion; it is an instruction.
    assert said(EKS, "docker")[1] == []

    # Naming the cluster is already unambiguous, so repeating it back is noise.
    assert said(EKS, "", context=EKS)[1] == []

    # A saved BILLABLE default chosen implicitly is a warning, because it costs money.
    runtime, out = said(EKS, "kubernetes")
    assert out and out[0][0] == "warn"
    assert "costs money by the hour" in out[0][1]
    assert "saved default" in out[0][1], "it must say WHY this cluster was chosen"

    # A saved free cluster used the same way is silent -- that is what saving one is
    # for, and warning every time would train people to stop reading these.
    assert said("default", "kubernetes")[1] == []
    assert said("k3s-prod", "kubernetes")[1] == []


def test_the_cheap_cluster_list_probes_nothing_and_says_which_cost_money(monkeypatch, tmp_path):
    """The list has to be cheap or the page is as slow as its worst cluster.

    `status()` is six or more round trips per cluster and a refusing one spends the
    whole timeout on every one of them. So this answers only what the kubeconfig and
    the context NAME already know, and the front end fills each card in from its own
    `status()` request -- one slow card instead of a slow page.
    """
    from houston import config
    from houston.services import cluster as clustersvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    monkeypatch.setattr(k8s.context, "contexts", lambda: ([ARN, "default", "kind-houston-local"], ""))
    monkeypatch.setattr(k8s.names, "is_ours", lambda c: c == "kind-houston-local")
    # Anything that would touch a cluster is made to explode: this function must not
    # reach one, and a test that merely asserted it was fast would not notice.
    #
    # THE ONE EXCEPTION IS NOT REACHED HERE. `known_contexts` probes our OWN context
    # when `kind` is missing, to tell a cluster that is gone from one that is merely
    # unmanageable -- so this states that houston built nothing, which is the case
    # every adopted cluster is in and the one this test is about. The probe itself has
    # its own test below.
    monkeypatch.setattr(k8s.context, "cluster_context", lambda: "")
    monkeypatch.setattr(k8s.reachability, "reach", lambda *a, **k: pytest.fail("known_contexts probed a cluster"))
    monkeypatch.setattr(k8s.reachability, "reachable", lambda *a, **k: pytest.fail("known_contexts probed a cluster"))
    cfg = config.load_config(); cfg[config.KUBE_CONTEXT_KEY] = ARN; config.save_config(cfg)

    out = clustersvc.known_contexts()
    rows = {r["context"]: r for r in out["contexts"]}
    assert set(rows) == {ARN, "default", "kind-houston-local"}
    assert rows[ARN]["billable"] is True and rows[ARN]["provider"] == "eks"
    assert rows[ARN]["is_default"] is True
    assert rows["default"]["billable"] is False
    assert rows["default"]["provider"] == "", \
        "kind and k3s look alike in a context name — guessing would put a distribution " \
        "on a card that status() then contradicts"
    assert rows["kind-houston-local"]["ours"] is True


# --- config / runner (12-factor items) -----------------------------------------


def test_preset_ports_match_registry():
    # Every preset with side services declares exactly its registry ports, so
    # allocation/preflight can see them.
    for name, expected in config.PRESET_PORTS.items():
        p = presets.load(name)
        assert p.ports == list(expected), f"{name} declares {p.ports}, registry says {expected}"
    assert presets.load("default").ports == []


def test_preset_ports_match_registry_on_every_runtime():
    """The registry ports are per PRESET, not per runtime, so both adapters declare them.

    The test above resolves through `presets.load`, which is the DOCKER adapter -- so a
    Kubernetes adapter that forgot `ports=` was invisible to the very invariant written
    to catch a missing port. The ldap adapter had, and an audit found it: phpLDAPadmin
    is published on the same fixed 8082 there (a port-forward rather than a compose
    mapping), but with an empty list `check_sidecar_ports` returns immediately and
    `sidecar_ports` is never recorded. A second Kubernetes workspace on that preset
    therefore got no refusal and its forward silently failed to bind, where Compose
    refuses up front and names the workspace already holding the port.
    """
    from houston.services import topology

    for name, expected in config.PRESET_PORTS.items():
        for runtime in (topology.DOCKER, topology.KUBERNETES):
            p = presets.resolve(name, runtime, {})
            assert p.ports == list(expected), (
                f"{name} on {runtime} declares {p.ports}, registry says "
                f"{list(expected)} — port allocation and the collision pre-flight "
                f"both read this list, and skip entirely when it is empty")


def test_the_new_environment_variable_wins_over_the_pre_rename_one(tmp_path,
                                                                  monkeypatch):
    """Both set is the normal state of a box part-way through the migration, and it
    has to behave as the NEW name says or the alias would pin people to the old one.
    """
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "new"))
    monkeypatch.setenv("RC_REPRO_HOME", str(tmp_path / "legacy"))
    assert config.home() == tmp_path / "new"


def test_a_pre_rename_override_still_reaches_the_config_layer(tmp_path, monkeypatch):
    """The alias belongs in `config.env`, not just in `home()` -- every one of the
    twelve variables had the same silent-default failure, not only HOUSTON_HOME.
    """
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.delenv("HOUSTON_REG_TOKEN", raising=False)
    monkeypatch.setenv("RC_REPRO_REG_TOKEN", "tok-from-legacy-env")
    assert config.load_config()["reg_token"] == "tok-from-legacy-env"


def test_the_state_directory_and_config_do_not_depend_on_the_umask(tmp_path):
    """`serve` tightens an existing loose home and `doctor` reports one, but neither
    runs on a pure-CLI box — and this directory also holds the audit log, the
    accounts file and the ACME material.

    config.yaml itself holds no secret (`reg_token` is env/flag only and is never
    persisted), so this is depth rather than a fix for an exposure.
    """
    import os
    import stat

    from houston import config

    home = tmp_path / "fresh"
    os.environ["HOUSTON_HOME"] = str(home)
    try:
        config.save_config({"bind_host": "127.0.0.1"})
        assert stat.S_IMODE(home.stat().st_mode) == 0o700, oct(home.stat().st_mode)
        mode = stat.S_IMODE((home / "config.yaml").stat().st_mode)
        assert mode == 0o600, oct(mode)
    finally:
        os.environ.pop("HOUSTON_HOME", None)


# --- staying invisible ----------------------------------------------------------

def test_the_edge_lives_outside_the_repro_directory(_home):
    """§3.1: `list`, `prune`, `down` and the GUI grid all enumerate repros_dir().
    Living outside it is what makes the edge untouchable by them -- no
    guard code, just the directory choice."""
    assert config.repros_dir() not in fd.edge_dir().parents
    assert fd.edge_dir().parent == config.home()


def test_the_staging_switch_can_be_turned_back_off(tmp_path, monkeypatch):
    """`bool("false")` is True, and that made the switch one-way.

    `config set` stored the raw string and every reader did
    `bool(cfg.get("acme_staging"))`, so turning staging ON worked and turning it OFF
    did nothing whatsoever. The asymmetry is what hid it for so long: the value people
    set first is the one that behaves.

    Measured on a live box -- `acme_staging: 'false'` in config.yaml and the very next
    create still ordering from the Let's Encrypt STAGING directory, producing a
    certificate no browser trusts, with nothing anywhere explaining why. A workspace
    that had rehearsed against staging could never be promoted to a real certificate.

    Both sides are asserted: what `config set` writes, and what a reader does with a
    config an OLDER houston already wrote as a string.
    """
    from typer.testing import CliRunner

    from houston import cli, config as cfgmod
    from houston.services import edge as fd

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    run = CliRunner()

    assert run.invoke(cli.app, ["config", "set", "acme.staging", "true"]).exit_code == 0
    assert cfgmod.load_config()["acme_staging"] is True, "stored as a real boolean"
    assert run.invoke(cli.app, ["config", "set", "acme.staging", "false"]).exit_code == 0
    assert cfgmod.load_config()["acme_staging"] is False, "and it can be turned off"

    # A config written by an OLDER houston holds the string. Every box that ever ran
    # `config set acme.staging false` has one, so the read has to cope.
    cfgmod.save_config({"acme_staging": "false"})
    assert cfgmod.truthy(cfgmod.load_config().get("acme_staging")) is False
    door = fd.Edge.resolve("d.example.com", "o@e.com")
    assert door.acme_staging is False, "the edge must not stay on staging for ever"

    # And nonsense is refused rather than stored as something truthy.
    bad = run.invoke(cli.app, ["config", "set", "acme.staging", "maybe"])
    assert bad.exit_code != 0
    assert "true or false" in (bad.output or ""), bad.output


def test_between_tests_the_home_is_still_not_the_real_one(monkeypatch):
    """Outside any test's own home, `config.home()` must still not be ~/.houston.

    `monkeypatch.undo()` is what teardown does, so this recreates the gap between two
    tests from inside one. Before the session fallback it resolved to the developer's
    real home, and a thread a previous test left running wrote a journal note there.
    """
    real = pathlib.Path.home() / ".houston"
    monkeypatch.undo()
    assert os.environ.get("HOUSTON_HOME"), "nothing to fall back to between tests"
    assert config.home() != real, f"between tests the home is the real {real}"
    assert config.home().resolve() != real.resolve()
