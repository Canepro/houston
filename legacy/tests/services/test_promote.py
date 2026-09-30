"""Promoting a home to `dual-v1`, and every way that must be refused instead.

`tests/test_lock.py` covers the lock primitive and the exclusive marker. This file covers
the MIGRATION between marker values -- the operation the Phase-8 strangler needs before
it may mix commands against one home.

The property is not "promotion works". It is that every reachable end state is
explainable: the journal is written first and removed last, a failure of any kind removes
it and leaves the exclusive marker exactly as it was, and a kill leaves either the old
marker plus a journal or `dual-v1` plus a journal -- never a changed marker with no
record of why.

The real crash-and-recover behaviour is `yarn test:state-handoff`, which kills actual
processes at the two points in the protocol. What is here is the decision logic around
those points, which is cheaper to ask directly.
"""
from __future__ import annotations

import json
import os
import pathlib

import pytest

from houston import lock
from houston.errors import ConflictError, ValidationError
from houston.services import promote


@pytest.fixture()
def home(tmp_path, monkeypatch):
    root = tmp_path / "home"
    root.mkdir(mode=0o700)
    monkeypatch.setenv("HOUSTON_HOME", str(root))
    monkeypatch.delenv(promote.PEER_ENV, raising=False)
    return root


def plant(root, value: str) -> None:
    (root / lock.MARKER_NAME).write_text(f"{value}\n", encoding="utf-8")
    os.chmod(root / lock.MARKER_NAME, 0o600)


# ----------------------------------------------------------------------- the lock order

def test_the_five_locks_expand_the_runner_lock_per_workspace(home):
    (home / "repros" / "TICKET-9").mkdir(parents=True)
    (home / "repros" / "TICKET-1").mkdir(parents=True)
    assert promote.lock_paths(home) == [
        ".config.lock",
        "locks/users.lock",
        "locks/sessions.lock",
        "logs/houston.log",
        # SORTED, not directory order: the order is the deadlock-avoidance property and
        # `iterdir` order differs between two builds reading one directory.
        "locks/TICKET-1.lock",
        "locks/TICKET-9.lock",
    ]


def test_the_lock_order_is_the_one_both_builds_hold():
    assert lock.LOCK_ORDER == (".config.lock", "locks/users.lock", "locks/sessions.lock",
                               "logs/houston.log", "locks/<workspace>.lock")


# ------------------------------------------------------------- the serve liveness file

def test_a_live_serve_is_reported(home):
    (home / "serve.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
    assert promote.serve_is_running(home) == os.getpid()


def test_a_stale_serve_pid_does_not_block_for_ever(home):
    # A crash leaves the file behind, so its existence cannot be the signal. The reader
    # asks the kernel, which is why a pid nothing owns answers None.
    (home / "serve.pid").write_text("2147483646\n", encoding="utf-8")
    assert promote.serve_is_running(home) is None


@pytest.mark.parametrize("raw", ["", "not-a-pid", "123abc", "0", "-1", " "])
def test_a_malformed_serve_pid_is_no_server(home, raw):
    (home / "serve.pid").write_text(f"{raw}\n", encoding="utf-8")
    assert promote.serve_is_running(home) is None


# ----------------------------------------------------------------- refusing to promote

def test_an_unclaimed_home_has_nothing_to_promote(home):
    with pytest.raises(ValidationError, match="names no owner"):
        promote.promote(home)
    assert not lock.transition_path(home).exists()


def test_an_unrecognised_marker_is_refused_and_not_rewritten(home):
    plant(home, "rust")
    with pytest.raises(ValidationError, match="not a marker this build"):
        promote.promote(home)
    # The marker is EVIDENCE. Promotion is not a repair tool and must not overwrite it.
    assert (home / lock.MARKER_NAME).read_text(encoding="utf-8") == "rust\n"
    assert not lock.transition_path(home).exists()


def test_an_already_dual_home_is_a_no_op(home):
    plant(home, "dual-v1")
    assert promote.promote(home) == {"marker": "dual-v1", "promoted": False,
                                     "reason": "already-dual"}
    # No journal was ever written, so nothing is left for a recovery to find.
    assert not lock.transition_path(home).exists()


def test_no_peer_validator_refuses_and_leaves_the_home_alone(home):
    plant(home, "python")
    # `dual-v1` means BOTH builds read this home and agreed. With no second reader there
    # is nothing to agree with, and assuming would write the one claim the marker is not
    # allowed to make on one build's word.
    with pytest.raises(ValidationError, match=promote.PEER_ENV):
        promote.promote(home)
    assert (home / lock.MARKER_NAME).read_text(encoding="utf-8") == "python\n"
    assert not lock.transition_path(home).exists()


def test_a_live_serve_refuses_and_removes_only_its_own_journal(home, monkeypatch):
    plant(home, "python")
    (home / "serve.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
    monkeypatch.setenv(promote.PEER_ENV, "true")
    with pytest.raises(ConflictError, match="serve` is running"):
        promote.promote(home)
    assert (home / lock.MARKER_NAME).read_text(encoding="utf-8") == "python\n"
    assert not lock.transition_path(home).exists()


def test_a_second_promotion_loses_the_race_without_cleaning_up_after_the_first(home):
    plant(home, "python")
    lock.begin_transition(home, {"started_by": "python:4242"})
    with pytest.raises(ConflictError):
        promote.promote(home)
    # THE JOURNAL SURVIVES. The loser must not tidy away the winner's record, which is
    # still in flight.
    assert lock.transition_path(home).exists()


def test_a_peer_that_disagrees_refuses_and_names_the_paths(home, monkeypatch, tmp_path):
    plant(home, "python")
    # A peer that answers the right SCHEMA about a different home: the documents parse,
    # and they disagree, which is the case the marker exists to catch.
    other = tmp_path / "other"
    other.mkdir()
    # The REAL TypeScript validator, which is genuinely the other build -- a Python peer
    # would now be refused for being this build before the disagreement was ever reached.
    # It reads `argv[2]`, so the home this call appends is ignored and it answers about
    # `other`: two different builds, two different homes, one guaranteed disagreement.
    root = pathlib.Path(__file__).resolve().parents[3]   # the repository: tools/ is beside src/
    monkeypatch.setenv(promote.PEER_ENV, f"node {root / 'tools' / 'validate-state.js'} {other}")
    (home / "config.yaml").write_text("a: 1\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="do not agree about this home"):
        promote.promote(home)
    assert (home / lock.MARKER_NAME).read_text(encoding="utf-8") == "python\n"
    assert not lock.transition_path(home).exists()


def test_a_peer_that_is_this_build_is_refused(home, monkeypatch):
    plant(home, "python")
    # Pointing the peer at THIS build makes the comparison a build agreeing with itself,
    # which agrees whatever it got wrong. The marker says two implementations checked the
    # home, so this has to be a refusal rather than the easiest way to pass.
    monkeypatch.setenv(promote.PEER_ENV,
                       f"{os.sys.executable} -m houston.services.promote")
    with pytest.raises(ValidationError, match="which is this build"):
        promote.promote(home)
    assert (home / lock.MARKER_NAME).read_text(encoding="utf-8") == "python\n"
    assert not lock.transition_path(home).exists()


def test_a_peer_speaking_another_schema_is_a_refusal_not_a_diff(home, monkeypatch):
    plant(home, "python")
    monkeypatch.setenv(
        promote.PEER_ENV,
        f"{os.sys.executable} -c \"import json,sys;print(json.dumps({{'schema':'other'}}))\" --")
    with pytest.raises(ValidationError, match="disagree about the QUESTION"):
        promote.promote(home)
    assert not lock.transition_path(home).exists()


# ------------------------------------------------------------------ the journal itself

def test_the_journal_is_created_once(home):
    assert lock.begin_transition(home, {"a": 1}) is True
    assert lock.begin_transition(home, {"a": 2}) is False
    # The FIRST caller's record survives.
    assert lock.read_transition(home) == {"a": 1}


def test_an_unparseable_journal_still_counts_as_in_flight(home):
    lock.transition_path(home).write_text("not json at all\n", encoding="utf-8")
    assert lock.read_transition(home) == {}
    assert "in flight" in (lock.transition_reason(home) or "")


def test_no_journal_is_absent_rather_than_empty(home):
    assert lock.read_transition(home) is None
    assert lock.transition_reason(home) is None


@pytest.mark.parametrize("shape", ["not-utf8", "directory", "dangling-symlink", "unreadable"])
def test_a_present_journal_counts_as_in_flight_even_unreadable_or_not_utf8(home, shape):
    # PRESENCE is the signal, so a journal that cannot be read is still one. Each of these
    # read as None here -- every command went ahead -- and the TypeScript build refused the
    # first, so the one file the two builds must both read as "stop" was read two ways.
    from houston.errors import PreflightError
    plant(home, "python")
    path = lock.transition_path(home)
    if shape == "not-utf8":
        path.write_bytes(b'{"started_by": "\xff"}\n')
    elif shape == "directory":
        path.mkdir()
    elif shape == "dangling-symlink":
        path.symlink_to(home / "nowhere")
    else:
        path.write_text("{}\n", encoding="utf-8")
        os.chmod(path, 0o000)
    assert lock.read_transition(home) == {}
    with pytest.raises(PreflightError, match="in flight"):
        lock.require_this_implementation(home)


def test_the_journal_blocks_every_command_including_the_owner(home):
    from houston.errors import PreflightError
    # Checked BEFORE ownership: a command from the home's OWN build would invalidate the
    # validation just as surely as one from the other build.
    plant(home, "python")
    lock.begin_transition(home, {"started_by": "python:1"})
    with pytest.raises(PreflightError, match="in flight"):
        lock.require_this_implementation(home)
    lock.clear_transition(home)
    lock.require_this_implementation(home)          # and it stops blocking once cleared


# ------------------------------------------------------------------- the marker writer

def test_the_marker_is_replaced_atomically_and_stays_0600(home):
    plant(home, "python")
    before = (home / lock.MARKER_NAME).stat().st_ino
    lock.write_marker(home, "dual-v1")
    after = (home / lock.MARKER_NAME).stat()
    assert (home / lock.MARKER_NAME).read_text(encoding="utf-8") == "dual-v1\n"
    # A DIFFERENT inode: temp-then-rename, not truncate-and-write. A truncate leaves a
    # window in which the marker is empty, and an empty marker reads as "never claimed".
    assert after.st_ino != before
    assert after.st_mode & 0o777 == 0o600
    assert [p.name for p in home.iterdir() if ".tmp" in p.name] == []


# ---------------------------------------------------------------------- the comparison

def test_differences_names_a_key_one_side_invented():
    left = {"schema": promote.SUMMARY_SCHEMA, "formats": {"a": {"x": 1}}}
    right = {"schema": promote.SUMMARY_SCHEMA, "formats": {"a": {"x": 1, "runtime": "docker"}}}
    # ABSENCE, not just inequality: an absent `extra.runtime` means docker, so a build
    # that materialised the key changed the meaning while every resolved value matched.
    assert promote.differences(left, right) == [".a.runtime"]


def test_differences_separates_an_absent_key_from_an_explicit_null():
    left = {"schema": promote.SUMMARY_SCHEMA, "formats": {"a": {}}}
    right = {"schema": promote.SUMMARY_SCHEMA, "formats": {"a": {"gone": None}}}
    assert promote.differences(left, right) == [".a.gone"]


def test_identical_documents_have_no_differences():
    doc = {"schema": promote.SUMMARY_SCHEMA, "formats": {"a": {"x": [1, 2], "y": None}}}
    assert promote.differences(doc, json.loads(json.dumps(doc))) == []


# ------------------------------------------------------------------------- validation

def test_validate_reports_every_format_and_absence_as_absence(home):
    summary = promote.validate_home(home)
    assert summary["schema"] == promote.SUMMARY_SCHEMA
    # A peer pointed at the SAME build would agree with itself every time, whatever
    # either of them got wrong, so the document says which build answered.
    assert summary["build"] == "python"
    # THE WHOLE TABLE. A format missing from the validator is a format promotion never
    # checked, and the marker would then claim more than was measured.
    assert sorted(summary["formats"]) == [
        "acme", "audit", "backups", "ca", "clusters", "config", "edge", "eventlog",
        "firstrun", "journal", "presets", "sessions", "users", "workspaces"]
    # An empty home is EMPTY, not defaulted: a validator that filled in what it could not
    # find would assert the very thing it exists to check.
    assert summary["formats"]["config"]["present"] is False
    assert summary["formats"]["users"]["names"] == []


def test_validate_leaves_houston_home_as_it_found_it(home, monkeypatch):
    monkeypatch.setenv("HOUSTON_HOME", str(home))
    promote.validate_home(home)
    assert os.environ["HOUSTON_HOME"] == str(home)


def test_recover_on_a_home_with_no_journal_does_nothing(home):
    plant(home, "python")
    assert promote.recover(home) == {"recovered": False, "reason": "no-transition",
                                     "marker": "python"}


def test_recover_refuses_a_journal_that_is_a_directory(home):
    # A directory is in flight -- it refuses every command -- but no promotion wrote it and
    # `clear_transition` cannot unlink it. Recovering promoted the home to dual-v1 on its
    # strength, left it there and reported success, so the home stayed refused for good.
    plant(home, "python")
    lock.transition_path(home).mkdir()
    with pytest.raises(ConflictError, match="is a directory"):
        promote.recover(home)
    assert (home / lock.MARKER_NAME).read_text(encoding="utf-8") == "python\n"
    assert lock.transition_path(home).is_dir()


def test_recover_after_the_swap_only_clears_the_journal(home):
    # The state a kill between the marker replacement and the cleanup leaves. Recovery
    # must NOT re-validate here: the promotion already happened, and by now the other
    # build may legitimately have written to the home.
    plant(home, "dual-v1")
    lock.begin_transition(home, {"from": "python", "to": "dual-v1"})
    assert promote.recover(home) == {"recovered": True, "reason": "completed-cleanup",
                                     "marker": "dual-v1"}
    assert not lock.transition_path(home).exists()
    assert (home / lock.MARKER_NAME).read_text(encoding="utf-8") == "dual-v1\n"
