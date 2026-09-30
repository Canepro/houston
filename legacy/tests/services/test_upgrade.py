"""`houston.services.upgrade`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_of, source_through
from houston.services import backup as bk
from houston.services import upgrade as up
from servicehelpers import _completed, _idp_meta


def test_can_upgrade_never_raises_for_a_missing_repro(monkeypatch):
    monkeypatch.setattr(up.lifecycle.preconditions, "require_docker", lambda: None)
    assert up.can_upgrade("no-such-repro")["can_upgrade"] is False


def test_a_forced_mongo_major_upgrade_says_what_it_actually_does(monkeypatch, tmp_path):
    """`--force` past a cross-major MongoDB block did not do what the refusal implied.

    README and `plan()`'s own comment both describe it as "refused rather than
    attempted", and `_apply_image` rewrites only the Rocket.Chat services and the oplog
    variable -- nothing touches the `mongodb` service, and `meta.mongo_tag` is left
    alone. So a forced upgrade gave new Rocket.Chat against the OLD MongoDB with the
    record still naming the old pairing, and the refusal never mentioned `--force` at
    all.
    """

    from houston.services import upgrade as upsvc

    # Through the calls: 2b.15 moved the forced-major wording into
    # `_refuse_or_warn`, and reading `_run_locked` alone reported it gone.
    src = source_through(upsvc._run_locked)
    # The refusal now names --force AND what it would really do.
    assert "upgrades Rocket.Chat only" in src, src[:200]
    # And forcing warns rather than proceeding silently.
    assert "--force: upgrading Rocket.Chat ONLY" in src

    # `_apply_image` really does leave MongoDB alone -- the premise of the warning.
    # Asserted on the loop's SELECTOR rather than on the word "mongodb", which also
    # appears in the oplog URL it sets: it iterates only services named `rocketchat`
    # or `rocketchat-*`, so no MongoDB service can be reached from it.
    img = source_of(upsvc._apply_image)
    assert 's == "rocketchat" or s.startswith("rocketchat-")' in img, (
        "if _apply_image no longer selects only Rocket.Chat services, the warning "
        "above is wrong")
    assert 'service["image"] = f"{rc_image}:{tag}"' in img


def test_no_backup_clears_the_previous_upgrades_recorded_bundle(monkeypatch, tmp_path):
    """`--no-backup` left the PREVIOUS upgrade's bundle recorded while
    `upgraded_from` was updated regardless, so the two disagreed and nothing noticed.

    A later `--rollback` read that stale path and restored it with force=True, which
    bypasses the downgrade refusal -- so "undo the last upgrade" dropped the current
    database and loaded data from TWO versions back.
    """
    import json as _json
    from dataclasses import asdict

    from houston.services import upgrade as up

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    stale = tmp_path / "from-7-0.rcbak"
    stale.write_bytes(b"x")

    m = bk.runner.Metadata(name="u", project="p", rc_version="8.0.0",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="http://localhost:3000",
                           host_port=3000, version_source="t")
    m.extra[up.LAST_BACKUP_KEY] = str(stale)        # recorded by the 7.0 -> 8.0 run
    m.extra[up.UPGRADE_FROM_KEY] = "7.0.0"
    ws = bk.runner.workspace("u")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")
    (ws / "docker-compose.yml").write_text(
        "services:\n  rocketchat:\n    image: i\n", encoding="utf-8")

    monkeypatch.setattr(up.lifecycle.preconditions, "require_engine", lambda *a, **kw: None)
    monkeypatch.setattr(up.lifecycle.naming, "resolve_name", lambda n: n)
    monkeypatch.setattr(bk.runner.engine, "up", lambda *a, **kw: 0)
    monkeypatch.setattr(up, "_wait_ready", lambda *a, **kw: None, raising=False)

    monkeypatch.setattr(up, "plan", lambda *a, **kw: {
        "allowed": True, "mongo_blocked": False, "to_version": "9.0.0",
        "from_version": "8.0.0", "rc_image": "i", "oplog": False,
        "blocked_reason": "", "warnings": [], "notes": []})
    try:
        up._run_locked("u", "9.0.0", offline=True, force=False, no_backup=True,
                       rollback_on_failure=False, emit=lambda e: None)
    except Exception:                      # noqa: BLE001 - the boot is not the subject
        pass

    after = bk.runner.read_meta("u").extra
    assert up.LAST_BACKUP_KEY not in after or not after[up.LAST_BACKUP_KEY], (
        "the previous upgrade's bundle is still recorded, so `--rollback` would "
        f"restore two versions back: {after.get(up.LAST_BACKUP_KEY)!r}")


def test_upgrade_reaches_a_kubernetes_workspace_with_no_docker_on_the_box(
        tmp_path, monkeypatch):
    """The reproduction from the review, at the service layer.

    `require_running` called `require_docker()` before resolving the name, so it
    could not tell a Kubernetes workspace from a Compose one when it mattered most.
    """
    import shutil as _shutil

    from houston.services import k8s, lifecycle as lc, topology, upgrade

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner_meta = _idp_meta("default")
    runner_meta.extra["runtime"] = "kubernetes"
    monkeypatch.setattr(upgrade.runner.record, "read_meta", lambda n: meta)
    monkeypatch.setattr(lc.naming, "resolve_name", lambda n, actor="": "k")
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    monkeypatch.setattr(_shutil, "which", lambda n: f"/usr/bin/{n}")
    monkeypatch.setattr(lc.runner.host, "docker_available", lambda **k: False)
    monkeypatch.setattr(k8s.status, "workload_exists", lambda *a, **k: True)

    assert upgrade.require_running("k") is meta, "a healthy k8s workspace, no Docker"


def test_kubernetes_migration_errors_come_from_kubernetes_logs(tmp_path, monkeypatch):
    """`_migration_errors` always read Compose logs and swallowed every failure.

    On a Kubernetes workspace `compose_logs_capture` answers "no configuration file
    provided", the bare `except` turned that into an empty list, and a migration
    failure therefore reported no diagnostics at all — silently, at the one moment
    they are worth most.
    """

    from houston.services import k8s, topology, upgrade

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(topology, "of_repro", lambda n: topology.KUBERNETES)
    monkeypatch.setattr(upgrade.runner.record, "read_meta", lambda n: _idp_meta("default"))

    def _no(*a, **k):
        raise AssertionError("compose logs must not be read for a k8s workspace")

    monkeypatch.setattr(upgrade.runner.engine, "compose_logs_capture", _no)

    class _Proc:
        stdout = ["ok\n", "Migration failed: could not apply 305\n"]
        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(k8s.status, "log_process", lambda *a, **k: _Proc())
    hits = upgrade._migration_errors("k")
    assert hits == ["Migration failed: could not apply 305"], hits


def test_the_operator_is_not_installed_with_telemetry_on(monkeypatch):
    """K-13. The chart sends the cluster UID, the Kubernetes version and deployment
    UIDs to MongoDB on a weekly timer, enabled by default. Nobody using a support
    reproduction tool opted into third-party analytics about the cluster they are
    debugging, and on a customer's adopted cluster houston would be what started it.
    """
    from houston.services import k8s

    seen: list[list[str]] = []
    monkeypatch.setattr(k8s.kube, "run",
                        lambda argv, **kw: seen.append(argv) or _completed(0))
    monkeypatch.setattr(k8s.operator, "operator_installed", lambda **kw: False)
    monkeypatch.setattr(k8s, "wait_operator_ready", lambda **kw: None, raising=False)
    try:
        k8s.ensure_operator(context="c")
    except Exception:                      # noqa: BLE001 - the install is not the subject
        pass
    upgrade = [a for a in seen if "upgrade" in a and "--install" in a]
    assert upgrade, "the operator install never ran"
    flat = " ".join(upgrade[0])
    assert "operator.telemetry.send.enabled=false" in flat, flat
