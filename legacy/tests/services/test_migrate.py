"""`houston.services.migrate`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from servicehelpers import _legacy_home


def test_the_event_log_is_renamed_before_the_migration_says_anything(tmp_path,
                                                                    monkeypatch):
    """`events.info` TEES every event into the event log, which opens
    logs/houston.log as a side effect of being called.

    So a migration that announced the move before renaming the log would create the
    destination file itself and turn its own rename into a permanent no-op: the box
    keeps logs/rc-repro.log forever, `pending()` stays true, and the whole migration
    re-runs on every single command. Pre-fix logs/rc-repro.log survives; its absence
    is the finding.
    """
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    _legacy_home(tmp_path)

    migratesvc.migrate(emit=lambda ev: None)
    logs = tmp_path / ".houston" / "logs"
    assert not (logs / "rc-repro.log").exists(), sorted(p.name for p in logs.iterdir())
    assert (logs / "houston.log").read_text().startswith('{"ts":"old"}')
    assert migratesvc.pending() is False, "a finished migration must not re-run"


def test_a_target_holding_only_this_tools_own_event_log_is_still_migrated(
        tmp_path, monkeypatch):
    """`logs/houston.log` is opened by the FIRST command that runs at all, before any
    state has been adopted.

    So a box where somebody ran a single `houston --version` between upgrading and
    adopting has a non-empty ~/.houston containing nothing but a record of that one
    command -- and treating that as "state" refuses the migration permanently, on the
    strength of a file whose entire content is the invocation that created it. This
    is not hypothetical; it happened during this rename. Pre-fix the move is refused
    with a ConflictError; the move happening is the finding.
    """
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    _legacy_home(tmp_path)
    (tmp_path / ".houston" / "logs").mkdir(parents=True)
    (tmp_path / ".houston" / "logs" / "houston.log").write_text('{"cmd":"--version"}\n')

    assert migratesvc.migrate()["moved"] is True
    assert not (tmp_path / ".rc-repro").exists()
    assert (tmp_path / ".houston" / "repros" / "w1" / "repro.json").exists()


def test_agent_skill_copies_are_moved_to_the_new_directory_name(tmp_path,
                                                                monkeypatch):
    """`skill install` writes into ~/.claude/skills/<tool>/, so the directory name IS
    the tool name and a rename strands the copy.

    Nothing breaks loudly, which is the problem: the stale SKILL.md keeps teaching
    agents to run `rc-repro <cmd>`, a command that no longer exists, and the agent
    that follows it fails in a way that looks like the agent's fault. Safe to do
    unattended -- unlike the other leftovers these are this tool's own files, in a
    directory it made for itself, with no sudo and nothing shared.
    """
    from houston.services import migrate as migratesvc

    monkeypatch.delenv("HOUSTON_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    # A gate may supply a separate skill root; this migration fixture owns both.
    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path))
    _legacy_home(tmp_path)
    for rel in (".claude/skills", ".agents/skills"):
        old = tmp_path / rel / "rc-repro"
        old.mkdir(parents=True)
        (old / "SKILL.md").write_text("# rc-repro\n")

    res = migratesvc.migrate()
    # The behavioural claim FIRST, so this fails on the behaviour against the pre-fix
    # code rather than on a result key that did not exist yet.
    for rel in (".claude/skills", ".agents/skills"):
        assert not (tmp_path / rel / "rc-repro").exists(), (
            f"{rel}/rc-repro survived the migration, still telling agents to run a "
            f"command that no longer exists")
        new = tmp_path / rel / "houston" / "SKILL.md"
        assert new.exists(), f"{rel} did not get the renamed copy"
        assert "name: houston" in new.read_text()
    assert len(res["skills_replaced"]) == 2, res["skills_replaced"]


def test_an_explicit_home_is_never_migrated_out_from_under_the_operator(tmp_path,
                                                                       monkeypatch):
    """HOUSTON_HOME set means somebody said where state lives. Moving a directory
    they named by hand is not this code's decision to make."""
    from houston.services import migrate as migratesvc

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "chosen"))
    _legacy_home(tmp_path)

    assert migratesvc.legacy_home() is None
    assert migratesvc.migrate()["moved"] is False
    assert (tmp_path / ".rc-repro").exists()
