"""`houston.services.envvars`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from houston import rcapi
import pytest


def test_env_var_names_are_validated_before_reaching_compose():
    """An invalid name produces a compose file docker rejects, so refuse it here."""
    import pytest

    from houston.errors import ValidationError
    from houston.services import envvars

    assert envvars.parse_set(["A=1", "B_2=x=y"]) == {"A": "1", "B_2": "x=y"}
    assert envvars.parse_set([]) == {}
    with pytest.raises(ValidationError, match="not KEY=VALUE"):
        envvars.parse_set(["JUST_A_KEY"])
    for bad in ("2LEADING=1", "has-hyphen=1", "has space=1", "=1"):
        with pytest.raises(ValidationError, match="valid environment variable name"):
            envvars.parse_set([bad])
    with pytest.raises(ValidationError, match="valid environment variable name"):
        envvars.check_names(["has-hyphen"])


def test_setting_expansion_and_the_bare_setting_id_trap():
    """A Rocket.Chat SETTING only applies from the environment WITH the prefix.

    Verified against a live 8.6.1 workspace: `Accounts_ShowFormLogin=false` left the
    setting `True`, while `OVERWRITE_SETTING_Accounts_ShowFormLogin=false` made it
    `False`. The bare form is accepted by docker and silently does nothing, which is
    why --setting exists and why a bare setting id is warned about.
    """
    from houston.services import envvars
    assert envvars.SETTING_PREFIX == "OVERWRITE_SETTING_"
    assert envvars.as_setting(["Message_AllowEditing=false"]) == {
        "OVERWRITE_SETTING_Message_AllowEditing": "false"}
    # A value containing '=' survives; only the first separator splits.
    assert envvars.as_setting(["A_B=x=y"]) == {"OVERWRITE_SETTING_A_B": "x=y"}
    assert envvars.as_setting([]) == {}
    # It reuses the same name validation as --set.
    import pytest
    from houston.errors import ValidationError
    with pytest.raises(ValidationError, match="not KEY=VALUE"):
        envvars.as_setting(["Message_AllowEditing"])


def test_bare_setting_warning_asks_the_workspace_and_stays_quiet_when_it_cannot(monkeypatch):
    """Which names are settings is version-specific, so ask the workspace, not a list.

    And it is only a warning path: an unreachable workspace must not block an env
    change, since setting env on a repro that is not serving is legitimate.
    """
    from houston.services import envvars
    # `admin_pass` because a workspace's admin password is per workspace now, and
    # everything that logs in reads it off the record. A stub without it raises
    # AttributeError inside a `try` and the warning silently never fires -- which is
    # exactly how this stub failed when the field was added.
    meta = type("M", (), {"name": "e", "root_url": "http://x", "extra": {},
                          "admin_pass": "admin123"})()

    monkeypatch.setattr(envvars.lifecycle.admin, "login", lambda m: object())
    monkeypatch.setattr(rcapi, "setting_ids",
                        lambda *a, **k: {"Message_AllowEditing", "Accounts_ShowFormLogin"})
    seen: list = []
    envvars.warn_bare_settings(meta, ["Message_AllowEditing", "MY_OWN_VAR"], seen.append)
    msgs = " ".join(str(getattr(e, "message", e)) for e in seen)
    assert "Message_AllowEditing is a Rocket.Chat SETTING" in msgs
    assert "OVERWRITE_SETTING_Message_AllowEditing" in msgs, "must give the fix"
    assert "MY_OWN_VAR" not in msgs, "a real env var must not be flagged"

    # Already prefixed -> nothing to say, and no API call needed.
    seen.clear()
    envvars.warn_bare_settings(meta, ["OVERWRITE_SETTING_Message_AllowEditing"], seen.append)
    assert seen == []

    # Workspace unreachable -> silent, never fatal.
    seen.clear()
    monkeypatch.setattr(envvars.lifecycle.admin, "login",
                        lambda m: (_ for _ in ()).throw(RuntimeError("not serving")))
    envvars.warn_bare_settings(meta, ["Message_AllowEditing"], seen.append)
    assert seen == []
    seen.clear()
    monkeypatch.setattr(envvars.lifecycle.admin, "login", lambda m: object())
    monkeypatch.setattr(rcapi, "setting_ids", lambda *a, **k: None)
    envvars.warn_bare_settings(meta, ["Message_AllowEditing"], seen.append)
    assert seen == []


def test_set_env_refuses_a_no_op_and_warns_on_load_bearing_keys(tmp_path, monkeypatch):
    """Load-bearing keys are allowed — reproducing a broken config is the point —
    but never silently, because the repro stops working and the cause is invisible."""
    from houston import compose, runner
    from houston.services import envvars
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(envvars.lifecycle.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(envvars.lifecycle.naming, "resolve_name", lambda n: n)

    with pytest.raises(errors.ValidationError, match="nothing to change"):
        envvars.set_env("e", {}, [], emit=lambda ev: None)

    meta = runner.Metadata(
        name="e", project="houston-e", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map")
    doc = {"services": {"rocketchat": {"environment": {"PORT": "3000", "KEEP": "1"}},
                        "rocketchat-2": {"environment": {"PORT": "3000"}}}}
    monkeypatch.setattr(runner.record, "read_meta", lambda n: meta)
    monkeypatch.setattr(runner.record, "read_compose", lambda n: doc)
    written = {}
    monkeypatch.setattr(runner.record, "write",
                        lambda n, y, m, files=None: written.update(yaml=y, meta=m))
    monkeypatch.setattr(runner.engine, "up", lambda n, pull=True, force_recreate="": 0)

    events = []
    r = envvars.set_env("e", {"MONGO_URL": "mongodb://elsewhere", "MY": "v"}, ["KEEP"],
                        emit=events.append)
    assert r["restarted"] is True
    assert any("load-bearing" in str(getattr(e, "message", e)) for e in events), \
        "MONGO_URL must be called out"
    # Applied to EVERY rocketchat service, and the unset key is gone from each.
    out = compose.yaml.safe_load(written["yaml"])
    for svc in ("rocketchat", "rocketchat-2"):
        assert out["services"][svc]["environment"]["MY"] == "v", svc
        assert "KEEP" not in out["services"][svc]["environment"], svc
    # And it is recorded, so `up --force` keeps it.
    assert written["meta"].extra["env"] == {"KEEP": None, "MONGO_URL": "mongodb://elsewhere",
                                            "MY": "v"}


def test_set_env_can_write_without_restarting(tmp_path, monkeypatch):
    from houston import runner
    from houston.services import envvars
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(envvars.lifecycle.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(envvars.lifecycle.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner.record, "read_meta", lambda n: runner.Metadata(
        name="e", project="p", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map"))
    monkeypatch.setattr(runner.record, "read_compose",
                        lambda n: {"services": {"rocketchat": {"environment": {}}}})
    monkeypatch.setattr(runner.record, "write", lambda *a, **k: None)
    called = []
    monkeypatch.setattr(runner.engine, "up",
                        lambda n, pull=True, force_recreate="": called.append(n) or 0)
    r = envvars.set_env("e", {"A": "1"}, [], restart=False, emit=lambda ev: None)
    assert r["restarted"] is False and called == [], "must not touch containers"
