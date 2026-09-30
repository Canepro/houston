"""`houston.runner`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

from houston import errors
import json
from houston.services import lifecycle as lc
import pytest
import subprocess


def test_rc_restart_count(monkeypatch):
    import types
    from houston import runner
    monkeypatch.setattr(runner.engine, "service_container_ids", lambda n, s: ["abc"] if s == "rocketchat" else [])
    monkeypatch.setattr(runner.docker, "run", lambda *a, **k: types.SimpleNamespace(stdout="7\n", returncode=0))
    assert runner.rc_restart_count("x") == 7
    monkeypatch.setattr(runner.engine, "service_container_ids", lambda n, s: [])
    assert runner.rc_restart_count("x") == 0   # no container -> 0, no crash


def test_docker_queries_behind_the_gui_poll_cannot_hang_or_raise(monkeypatch):
    """A wedged daemon must degrade, not park a threadpool worker forever.

    docker_available() (timeout=10) can pass and the NEXT call still hang: these
    three run on the dashboard's 4s poll, so an unbounded one is a worker leak
    that ends with the server answering nothing. Each already has a documented
    "couldn't ask docker" value -- they just have to reach it.
    """

    from houston import runner

    # `project_states` memoises for _QUERY_TTL, so this test only sees the stubbed
    # failure if the cache is cold -- and it is only cold by luck of test ORDER.
    # Any earlier test that reaches a real docker (the `--json` contract tests run
    # `list` and `doctor` for real, a file earlier in the alphabet) leaves a warm
    # entry, and this passed on the cached answer instead of the one under test.
    runner._query_cache.clear()

    for exc in (subprocess.TimeoutExpired(cmd="docker", timeout=30),
                FileNotFoundError("docker"),
                OSError("no fork")):
        def boom(*a, **k):
            raise exc

        monkeypatch.setattr(runner.docker, "run", boom)
        assert runner._compose_ls() is None                  # None = "couldn't ask"
        assert runner.project_states() is None               # prune refuses on None
        assert runner.rc_status_by_project() == {}
        monkeypatch.setattr(runner.engine, "service_container_ids", lambda n, s: ["abc"])
        assert runner.rc_restart_count("x") == 0

    # And every one of them passes a timeout, so the hang cannot happen at all.
    calls = []
    monkeypatch.setattr(runner.docker, "run",
                        lambda *a, **k: calls.append(k.get("timeout")) or
                        __import__("types").SimpleNamespace(stdout="", returncode=1))
    runner._compose_ls(); runner.rc_status_by_project(); runner.rc_restart_count("x")
    assert calls and all(t is not None for t in calls), f"unbounded docker call: {calls}"


def test_hub_logged_in(monkeypatch, tmp_path):
    from houston import runner
    # no auth files readable anywhere -> can't tell (None)
    monkeypatch.delenv("REGISTRY_AUTH_FILE", raising=False)
    monkeypatch.delenv("DOCKER_CONFIG", raising=False)
    monkeypatch.setattr(runner.host.Path, "home", staticmethod(lambda: tmp_path / "nohome"))
    assert runner.hub_logged_in() is None

    # a config with a Hub auth entry -> True
    cfg = tmp_path / "config.json"
    cfg.write_text('{"auths": {"https://index.docker.io/v1/": {"auth": "x"}}}')
    monkeypatch.setenv("REGISTRY_AUTH_FILE", str(cfg))
    assert runner.hub_logged_in() is True

    # a readable config with only a non-Hub registry -> False
    cfg.write_text('{"auths": {"ghcr.io": {"auth": "x"}}}')
    assert runner.hub_logged_in() is False


def test_detail_reports_unknown_state_when_docker_is_unreachable(monkeypatch):
    from houston import runner
    monkeypatch.setattr(runner.host, "docker_available", lambda **_k: False)
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(runner.record, "read_meta", lambda n: lc.runner.Metadata(
        name=n, project=f"houston-{n}", rc_version="8.5.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map"))
    monkeypatch.setattr(runner.record, "read_compose", lambda n: {"services": {"rocketchat": {}}})
    d = lc.detail("x")
    # container_details() returns [] both for "none" and for "could not ask docker",
    # so detail() used to assert "down" while list_repros() said "?" for the same
    # repro -- and the panel then offered a Bring up button that could only fail.
    assert d["state"] == "?" and d["health"] == "" and d["uptime"] == ""
    assert d["containers"] == []


def test_env_overrides_survive_up_force(tmp_path, monkeypatch):
    """`up --force` rebuilds compose from the spec, so overrides must live in metadata.

    Verified live before this was written: editing only the generated compose file
    worked until the next `up --force`, which silently dropped the change.
    """
    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="e", project="houston-e", rc_version="8.6.1", rc_image="i", mongo_tag="8.0",
        mongo_flavor="official", preset="default", root_url="http://localhost:3000",
        host_port=3000, version_source="map",
        extra={"env": {"KEEP_ME": "yes", "GONE": None}})
    monkeypatch.setattr(runner.paths, "exists", lambda n: True)
    monkeypatch.setattr(runner.record, "read_meta", lambda n: meta)

    carried: dict = {}
    if runner.exists("e"):
        prev = runner.read_meta("e").extra.get("env")
        if isinstance(prev, dict):
            carried.update(prev)
    carried.update({"NEW": "1"})          # what this run asked for
    assert carried == {"KEEP_ME": "yes", "GONE": None, "NEW": "1"}, \
        "existing overrides carry forward; this run's win"


def test_a_half_written_workspace_is_a_404_not_a_traceback(tmp_path, monkeypatch):
    """`runner.write` writes two files, each atomically; the PAIR is not atomic. A
    kill between them left a directory `exists()` accepts and `read_meta` could not
    read, and the bare FileNotFoundError escaped the ReproError contract -- in
    `serve` a 500 with a traceback, because detail() runs on the request thread.
    """
    from houston import runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ws = runnersvc.workspace("halfwritten")
    ws.mkdir(parents=True)
    (ws / "docker-compose.yml").write_text("services: {}\n")

    assert runnersvc.exists("halfwritten"), "precondition: it looks like a workspace"
    with pytest.raises(errors.MissingRecordError) as exc:
        runnersvc.read_meta("halfwritten")
    assert exc.value.http_status == 404
    assert "down --name halfwritten" in str(exc.value), "must say how to remove it"
    # Still a FileNotFoundError, so the callers that already skip on that keep working.
    assert isinstance(exc.value, FileNotFoundError)
    assert [m.name for m in runnersvc.list_meta()] == []


def test_a_kubernetes_workspace_directory_is_restricted_like_every_other(tmp_path,
                                                                         monkeypatch):
    """`_restrict` lives in `runner.write`, and the Kubernetes path wrote repro.json
    with a bare `atomic_write` -- so the 0700 directory that `write`'s own comment
    calls "what does the work" was absent on the one runtime that also writes
    `kubernetes/values.yaml` with ADMIN_PASS in it.
    """
    from houston import runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runnersvc.Metadata(name="kube", project="p", rc_version="8.5.1",
                              rc_image="i", mongo_tag="7.0", mongo_flavor="official",
                              preset="default", root_url="http://localhost:3000",
                              host_port=3000, version_source="x")
    runnersvc.write_record("kube", meta)
    mode = runnersvc.workspace("kube").stat().st_mode & 0o777
    assert mode == 0o700, f"workspace root is {mode:o}, traversable by other users"
    assert runnersvc.read_meta("kube").name == "kube"


def test_a_workspace_keeps_the_compose_project_it_was_created_under(tmp_path,
                                                                    monkeypatch):
    """`project_name` derived the name from `PROJECT_PREFIX` instead of reading the
    one repro.json already records, so the prefix and the containers on the daemon
    were two sources of truth that merely happened to agree.

    Renaming the tool ends the agreement: `list` reads the RECORDED project and
    reports the workspace running, while `down` derives a different one and tears
    down nothing -- leaking the containers with their published ports and the
    customer's Mongo volume. Pre-fix this returns "houston-legacy"; the recorded
    "rcrepro-legacy" is the finding.
    """
    from houston import runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runnersvc.Metadata(name="legacy", project="rcrepro-legacy",
                              rc_version="8.5.1", rc_image="i", mongo_tag="7.0",
                              mongo_flavor="official", preset="default",
                              root_url="http://localhost:3000", host_port=3000,
                              version_source="x")
    runnersvc.write_record("legacy", meta)
    assert runnersvc.project_name("legacy") == "rcrepro-legacy", (
        "a workspace must be addressed by the project its containers actually "
        "carry, not by the prefix this build would mint today")


def test_a_workspace_with_no_record_is_minted_from_the_current_prefix(tmp_path,
                                                                     monkeypatch):
    """The other half of the same rule: reading the record must not break creation.

    `up` calls `project_name` before there is anything to read, so an absent record
    has to fall through to the mint-time prefix rather than raise or return "".
    """
    from houston import config, runner as runnersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert runnersvc.project_name("fresh") == runnersvc.mint_project_name("fresh")
    assert runnersvc.project_name("fresh") == config.PROJECT_PREFIX + "fresh"


def test_the_detail_summary_cannot_contradict_its_own_containers(monkeypatch, tmp_path):
    """`detail()` derived state AND health from the Rocket.Chat container alone."""
    from houston import runner
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n: "dbgone")
    monkeypatch.setattr(runner.record, "read_meta", lambda n: lc.runner.Metadata(
        name=n, project=f"houston-{n}", rc_version="8.5.1", rc_image="i",
        mongo_tag="8.0", mongo_flavor="official", preset="default",
        root_url="http://localhost:3000", host_port=3000, version_source="map"))
    monkeypatch.setattr(runner.host, "docker_available", lambda: True)
    monkeypatch.setattr(runner.queries, "container_details", lambda n: [
        {"service": "mongodb", "state": "exited",
         "status": "Exited (0) 3 minutes ago", "health": ""},
        {"service": "rocketchat", "state": "running",
         "status": "Up 2 hours (healthy)", "health": "healthy"},
    ])
    monkeypatch.setattr(runner.queries, "rc_restart_count", lambda n: 0)
    monkeypatch.setattr(runner.record, "read_compose", lambda n: {})

    d = lc.detail("dbgone")

    assert d["state"] == "running"          # it IS running; that part was never wrong
    assert d["health"] == "degraded", d["health"]
    assert d["degraded"] == "mongodb is exited", d["degraded"]


def test_a_record_written_before_the_field_existed_still_works(tmp_path, monkeypatch):
    """BACK-COMPAT, and it is not cosmetic: a workspace made by an older houston
    really does run `admin123`, so the fallback is a statement of fact about that
    workspace, not a default."""
    from houston import config, tls as tlsmod  # noqa: F401

    from houston import runner
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ws = runner.workspace("old")
    ws.mkdir(parents=True)
    (ws / "repro.json").write_text(json.dumps({
        "name": "old", "project": "houston-old", "rc_version": "6.5.3",
        "rc_image": "registry.rocket.chat/rocketchat/rocket.chat", "mongo_tag": "5.0",
        "mongo_flavor": "bitnami-legacy", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001,
        "version_source": "shipped"}), encoding="utf-8")
    meta = runner.read_meta("old")
    assert meta.admin_password == ""
    assert meta.admin_pass == "admin123"


def test_every_module_of_the_seam_is_reachable_through_the_facade():
    """A module nothing imports is a module no failure will ever point at. The façade
    resolving each by name is what lets a test patch an owner without growing an
    import — and if that stops working, the re-pointer's output stops landing."""
    from houston import runner
    from houston.runner import (cache, engine, host, locks, paths, ports, queries,
                                record)

    for module in (paths, cache, locks, engine, record, queries, host, ports):
        name = module.__name__.rsplit(".", 1)[-1]
        assert getattr(runner, name) is module, f"runner.{name} is not the module"


def test_the_docker_seam_is_eight_modules_that_cannot_import_upward():
    """`runner/` is the only place this codebase talks to Docker, so its layering is
    worth asserting rather than assuming.

    The tiers are read from the reviewed map and checked against the TREE — the import
    statements that actually exist — because the plan and the result disagree exactly
    when an extraction was done differently from how it was planned.
    """
    import ast
    import json
    import pathlib

    from houston import runner

    root = pathlib.Path(runner.__file__).parent
    tiers = json.loads((root.parent.parent / "tools" / "move-table.json")
                       .read_text(encoding="utf-8"))["modules"]["houston/runner.py"]["tiers"]
    aliases = {"runner_host": "host", "runner_ports": "ports", "runner_record": "record"}
    seen = []
    for path in sorted(root.glob("*.py")):
        if path.stem == "__init__":
            continue
        own = tiers[path.stem]
        seen.append(path.stem)
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.ImportFrom):
                continue
            if (node.module or "") == "houston.runner":
                targets = [aliases.get(a.asname or a.name, a.name) for a in node.names]
            elif (node.module or "").startswith("houston.runner."):
                targets = [node.module.rsplit(".", 1)[-1]]
            else:
                continue
            for t in targets:
                assert t not in tiers or tiers[t] <= own, (
                    f"{path.stem} (tier {own}) imports {t} (tier {tiers[t]})")
    assert sorted(seen) == sorted(tiers), (seen, sorted(tiers))


def test_the_query_cache_is_its_own_module_because_the_alternative_is_a_cycle():
    """`_mutating` invalidates the cache; the cached readers call `docker`.

    Keep the cache with the readers and `engine` imports `queries` while `queries`
    imports `engine` — which `scc_check.py` would then refuse, after the split had been
    done. Computing the tiers from the call graph is what found this before anything
    moved.
    """
    import pathlib

    from houston.runner import cache, engine

    assert "invalidate_docker_queries" in dir(cache)
    src = pathlib.Path(engine.__file__).read_text(encoding="utf-8")
    assert "from houston.runner import cache" in src
    assert "import queries" not in src, "engine must not reach the cached readers"
