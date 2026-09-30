"""`houston.perf.k6`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import config
import json


def test_loadtest_scenarios_and_scripts_present():
    from importlib import resources
    from houston.perf import k6
    d = resources.files("houston").joinpath("data", "loadtest")
    assert "custom" in k6.SCENARIOS
    for name in k6.SCENARIOS:
        assert d.joinpath(f"{name}.js").is_file()
    assert d.joinpath("common.js").is_file()


def test_loadtest_journey_scenario_registered():
    from importlib import resources
    from houston.perf import k6
    assert "journey" in k6.SCENARIOS
    d = resources.files("houston").joinpath("data", "loadtest")
    assert d.joinpath("journey.js").is_file()
    # journey + mixed emit per-step trends; common.js collects them into `steps`
    assert "step_" in d.joinpath("journey.js").read_text(encoding="utf-8")
    assert "step_" in d.joinpath("mixed.js").read_text(encoding="utf-8")
    assert "steps" in d.joinpath("common.js").read_text(encoding="utf-8")


def test_new_scenarios_registered():
    from importlib import resources
    from houston.perf import k6
    d = resources.files("houston").joinpath("data", "loadtest")
    for s in ("webhook", "badbot"):
        assert s in k6.SCENARIOS and d.joinpath(f"{s}.js").is_file()
    assert "SPIKE" in d.joinpath("common.js").read_text(encoding="utf-8")


def test_k6_keeps_secrets_out_of_the_argv(tmp_path, monkeypatch):
    import types
    from houston.perf import k6
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ws = tmp_path / "repros" / "r"
    ws.mkdir(parents=True)
    captured = {}

    def fake_run(cmd, **_kw):
        captured["cmd"] = cmd
        (ws / "loadtest" / "summary.json").write_text(json.dumps({"rps": 1}), encoding="utf-8")
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(k6.subprocess, "run", fake_run)
    k6.run("r", "messages", vus=1, duration="1s", ramp=None,
           token="PAT-SECRET-VALUE", uid="u1", target="http://rocketchat:3000")
    argv = " ".join(captured["cmd"])
    # `ps` / /proc/<pid>/cmdline expose the argv to every local user for the whole
    # run, and `docker inspect` afterwards.
    assert "PAT-SECRET-VALUE" not in argv
    assert config.ADMIN_PASSWORD not in argv
    assert "--env-file" in captured["cmd"]
    # non-secret env still rides the argv, and the secret file does not outlive the run
    assert "RC_URL=http://rocketchat:3000" in captured["cmd"]
    assert not (ws / "loadtest" / "k6.env").exists()
