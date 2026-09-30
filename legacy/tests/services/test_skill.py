"""`houston.services.skill`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
import json
import pytest


# --- the agent skill ------------------------------------------------------------

def test_the_repo_copies_of_the_skill_match_the_packaged_one():
    """Three copies of one file, and the two under `.claude/` and `.agents/` exist so
    a fresh clone teaches an agent to drive this tool. Three copies is also how they
    drift, so this is the thing that stops them.

    It is a real check rather than a formality: the packaged copy is what
    `houston skill install` writes on a machine that has no checkout, so a repo
    copy that says something different is instructions half the callers never see.
    """
    from pathlib import Path

    from houston.services import skill

    # `resolve()` crosses the `houston/data` symlink (Phase 9.0): the packaged file is
    # `<repo>/data/skill/SKILL.md`, so the repository root is two directories up from it.
    # `parents[3]` from there is $HOME, whose `.claude/skills/houston/SKILL.md` exists on
    # the machine that runs `houston skill install` -- a pass that meant nothing.
    root = Path(skill.packaged()).resolve().parents[2]
    want = skill.packaged().read_text(encoding="utf-8")
    for rel in (".claude/skills/houston/SKILL.md", ".agents/skills/houston/SKILL.md"):
        copy = root / rel
        assert copy.exists(), f"{rel} is missing — `cp {skill.packaged()} {rel}`"
        assert copy.read_text(encoding="utf-8") == want, (
            f"{rel} has drifted from the packaged skill — copy it again")


def test_the_skill_knows_stale_from_edited_locally(tmp_path, monkeypatch):
    """Two ways an installed file can differ, needing opposite answers: the package
    moved on (reinstall it) or a human edited it (that is theirs). The sidecar's
    recorded sha is what separates them -- without it, an edit and a new release look
    identical and one of the two gets clobbered."""
    from houston.services import skill

    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path))
    assert skill.host_state("claude").status == "absent"

    skill.install("claude")
    assert skill.host_state("claude").status == "current"
    assert skill.install("claude")["hosts"][0]["action"] == "unchanged"

    path = skill.target("claude")
    path.write_text("a human changed this\n", encoding="utf-8")
    assert skill.host_state("claude").status == "modified"
    with pytest.raises(errors.ConflictError):
        skill.install("claude")
    assert path.read_text(encoding="utf-8") == "a human changed this\n", \
        "a refusal that had already overwritten the file would be worse than none"
    skill.install("claude", force=True)
    assert skill.host_state("claude").status == "current"

    # A copy this build wrote, from an older build: stale, and overwritten freely.
    path.write_text("what 0.1.0 shipped\n", encoding="utf-8")
    (path.parent / skill.SIDECAR).write_text(json.dumps(
        {"houston_version": "0.1.0", "sha256": skill.sha256("what 0.1.0 shipped\n")}),
        encoding="utf-8")
    assert skill.host_state("claude").status == "stale"
    assert skill.install("claude")["hosts"][0]["action"] == "updated"


def test_the_skill_reports_the_copy_an_agent_actually_reads(tmp_path, monkeypatch):
    """An agent reads `.claude/skills/` relative to the PROJECT before it reads a
    home directory, so in a checkout that is the file in play. Reporting only the
    home copy told a developer `current: false` while they were reading a perfectly
    current skill -- and then pointed them at `skill install`, which writes a
    different copy somewhere the agent was not reading.

    Found by driving the skill and watching `capabilities` say exactly that.
    """
    from houston.services import skill

    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path / "home"))
    project = tmp_path / "checkout"
    (project / ".claude" / "skills" / "houston").mkdir(parents=True)
    local = project / ".claude" / "skills" / "houston" / "SKILL.md"
    local.write_text(skill.packaged().read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.chdir(project)

    st = skill.state()
    assert st["hosts"]["project"]["status"] == "current"
    assert st["hosts"]["project"]["scope"] == "project"
    # Nothing is installed in the home, and that does NOT make the state stale:
    # absent copies are not copies somebody read.
    assert st["hosts"]["claude"]["status"] == "absent"
    assert st["current"] is True

    # A checkout carrying an out-of-date copy is worth reporting even though the
    # home copy might be fine, because nobody knows which one the caller loaded.
    local.write_text("what an older branch shipped\n", encoding="utf-8")
    assert skill.state()["current"] is False


def test_the_skill_never_writes_into_the_houston_state_directory(tmp_path, monkeypatch):
    """It is read by an agent that knows nothing about HOUSTON_HOME, so it goes
    where that agent looks -- and a test that got this wrong would write into the
    developer's real ~/.claude."""
    from houston.services import skill

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path / "home"))
    skill.install("all")
    assert (tmp_path / "home" / ".claude" / "skills" / "houston" / "SKILL.md").exists()
    assert not (tmp_path / "state").exists()


def test_no_copy_anywhere_is_not_current(tmp_path, monkeypatch):
    from houston.services import skill

    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path / "home"))
    empty = tmp_path / "elsewhere"
    empty.mkdir()
    monkeypatch.chdir(empty)
    st = skill.state()
    assert st["current"] is False, "nothing installed is not the same as up to date"
