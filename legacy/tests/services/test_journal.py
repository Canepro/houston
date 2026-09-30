"""`houston.services.journal`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_index
from conftest import source_of, source_through
from houston.services import lifecycle as lc
from servicehelpers import _idp_meta
import json
import pytest


def test_an_advisory_note_is_cleared_only_when_ITS_subject_is_gone(monkeypatch, tmp_path):
    """`recover()` drops an advisory note whose subject is gone. Which subject?

    It asked `runner.exists(entry.workspace)`, which is right for every kind today
    because every one of them is about a workspace -- and only accidentally right. An
    `Entry` is keyed on a workspace name and `runner.exists()` looks for markers under
    `repros/<name>/`, so a note about something that is NOT a workspace answers False
    always and is cleared silently at the next `serve` startup. A note about a
    half-created cloud cluster is exactly that shape, and it is the most expensive note
    the product could hold.
    """
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    # Unchanged for a workspace kind: absent means gone.
    e = journal.Entry(id="a", kind=journal.CREATE_UNFINISHED, workspace="ghost", pid=1)
    assert journal.still_there(e) is False

    # A kind whose subject is NOT a workspace asks its own question, and is believed.
    monkeypatch.setitem(journal._SUBJECT_EXISTS, "cluster_unfinished",
                        lambda entry: True)
    c = journal.Entry(id="b", kind="cluster_unfinished", workspace="rc-support", pid=1)
    assert journal.still_there(c) is True, \
        "a cluster that IS there must not be read as gone because no workspace matches"

    # ...and when its own question says gone, it really is gone.
    monkeypatch.setitem(journal._SUBJECT_EXISTS, "cluster_unfinished",
                        lambda entry: False)
    assert journal.still_there(c) is False

    # A predicate that cannot answer keeps the note. "I could not ask" is not "it is
    # gone", and the two mistakes do not cost the same: a stale note wastes a line, a
    # dropped one loses the only record that something is still billing.
    def boom(entry):
        raise RuntimeError("no credentials")

    monkeypatch.setitem(journal._SUBJECT_EXISTS, "cluster_unfinished", boom)
    assert journal.still_there(c) is True, \
        "an unanswerable subject must not be treated as an absent one"


# --- the journal: side effects a killed process must not leave behind ---------
#
# `web/jobs.py` runs long operations on DAEMON threads, so a restart, an OOM kill or
# a plain SIGKILL ends them where they stand and skips every `finally`. Those blocks
# are doing real work -- `backup` stops Rocket.Chat, `loadtest` turns the API rate
# limiter off -- and the registry is in memory, so a restart loses even the knowledge
# that a job existed. Measured: under SIGKILL the `finally` does not run.

def test_a_live_owner_means_the_note_is_not_abandoned(tmp_path, monkeypatch):
    """Repairing an entry whose job is still running would re-enable the rate limiter
    underneath a load test that has not finished.

    So liveness is checked by pid AND the owner's start time -- pid alone is not
    enough, because the OS recycles them, which is the same mistake `forward_alive`
    was making about port-forwards.
    """
    import os

    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    mine = journal.record(journal.RATE_LIMITER_OFF, "w")
    assert mine, "the entry must be written"
    assert len(journal.open_entries()) == 1
    assert journal.abandoned() == [], "this process is alive; leave it alone"

    # A RECYCLED pid: still a live process, but not the one that wrote this.
    entry = journal.open_entries()[0]
    assert entry.pid == os.getpid()
    (journal.journal_dir() / f"{entry.id}.json").write_text(json.dumps({
        **{k: getattr(entry, k) for k in ("id", "kind", "workspace", "pid", "at")},
        "started": "999999999", "detail": {}}))
    assert len(journal.abandoned()) == 1, \
        "same pid, different start time -- a different process, so the owner is gone"


def test_the_note_is_cleared_when_the_cleanup_runs_and_kept_when_it_does_not(
        tmp_path, monkeypatch):
    """A surviving entry has to mean precisely "the cleanup did not happen"."""
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    with journal.side_effect(journal.RATE_LIMITER_OFF, "w"):
        assert len(journal.open_entries()) == 1
    assert journal.open_entries() == [], "cleared on the way out"

    # Cleared on an exception too: the `finally` ran, so the state was restored.
    with pytest.raises(RuntimeError):
        with journal.side_effect(journal.RATE_LIMITER_OFF, "w"):
            raise RuntimeError("boom")
    assert journal.open_entries() == []

    # An unknown kind is refused, because recovery has to know how to undo it --
    # a note nothing can repair would sit there forever looking like a fault.
    with pytest.raises(ValueError):
        journal.record("something_new", "w")


def test_a_note_for_a_workspace_that_is_gone_is_not_a_failure(tmp_path, monkeypatch):
    """Whatever was done to it went with it, so clearing the note is the right
    outcome -- not an unrepairable warning that never goes away."""
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(journal.runner.paths, "exists", lambda n: False)
    eid = journal.record(journal.ROCKETCHAT_STOPPED, "deleted-long-ago")
    path = journal.journal_dir() / f"{eid}.json"
    data = json.loads(path.read_text())
    data.update(pid=999999, started="1")
    path.write_text(json.dumps(data))
    rows = journal.recover()
    assert rows[0]["repaired"] is True, rows
    assert journal.open_entries() == []


def test_a_finished_create_clears_every_earlier_claim_that_it_did_not_finish(
        tmp_path, monkeypatch):
    """Notes are per-process, and some facts invalidate other processes' notes.

    A create that FAILED left a `CREATE_UNFINISHED` note; a later create of the same
    name that succeeded cleared only the note it had written itself, so the stale one
    went on claiming a complete workspace had never finished. Seen exactly that way:
    one attempt died on a preflight, the retry succeeded, and the warning stayed.
    """
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    for at in ("T1", "T2"):
        eid = journal.record(journal.CREATE_UNFINISHED, "w")
        path = journal.journal_dir() / f"{eid}.json"
        data = json.loads(path.read_text())
        data["at"] = at
        path.write_text(json.dumps(data))
    journal.record(journal.CREATE_UNFINISHED, "elsewhere")
    assert len(journal.open_entries()) == 3

    assert journal.clear_kind(journal.CREATE_UNFINISHED, "w") == 2
    assert [e.workspace for e in journal.open_entries()] == ["elsewhere"], \
        "another workspace's note is not this workspace's business"


def test_an_advisory_note_for_a_workspace_that_is_gone_stops_warning(
        tmp_path, monkeypatch):
    """Advisory notes are never repaired, so nothing would ever clear one whose
    workspace has been removed -- it would warn forever about something that cannot be
    acted on. A create that failed and rolled back is exactly that case."""
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(journal.runner.paths, "exists", lambda n: False)
    eid = journal.record(journal.CREATE_UNFINISHED, "rolled-back")
    path = journal.journal_dir() / f"{eid}.json"
    data = json.loads(path.read_text())
    data.update(pid=999999, started="1")
    path.write_text(json.dumps(data))

    assert journal.recover() == [], "nothing to report about a workspace that is gone"
    assert journal.open_entries() == [], "and the note is dropped, not kept"

    # While the workspace IS there, it is reported and deliberately not repaired.
    monkeypatch.setattr(journal.runner.paths, "exists", lambda n: True)
    eid = journal.record(journal.CREATE_UNFINISHED, "still-here")
    path = journal.journal_dir() / f"{eid}.json"
    data = json.loads(path.read_text())
    data.update(pid=999999, started="1")
    path.write_text(json.dumps(data))
    rows = journal.recover()
    assert len(rows) == 1 and rows[0]["repaired"] is False, rows
    assert "houston ready" in rows[0]["why"], rows[0]
    assert len(journal.open_entries()) == 1, "kept until somebody acts on it"


def test_the_bench_workspace_and_the_constraints_can_be_undone(tmp_path, monkeypatch):
    """The two side effects added beside the first pair. `benchmark` left the most
    expensive thing on this branch behind -- a Rocket.Chat and a MongoDB per version --
    and a performance run's CPU/RAM caps have to go back to the PRIOR values rather
    than to "unlimited", which is why the note carries them."""
    from houston.perf import constrain as constrain_mod
    from houston.services import journal, recovery

    recovery.install()

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(journal.runner.paths, "exists", lambda n: True)
    dead = {"pid": 999999, "started": "1"}

    def _plant(kind, **detail):
        eid = journal.record(kind, "w", **detail)
        path = journal.journal_dir() / f"{eid}.json"
        data = json.loads(path.read_text())
        data.update(dead)
        path.write_text(json.dumps(data))

    removed: list = []
    monkeypatch.setattr(journal.runner.engine, "down",
                        lambda n, volumes=False: removed.append((n, volumes)))
    monkeypatch.setattr(journal.runner.paths, "remove", lambda n: None)
    _plant(journal.BENCH_WORKSPACE)
    assert journal.recover()[0]["repaired"] is True
    assert removed == [("w", True)], "the volume goes too; it was a throwaway"

    # Constraints: the prior values survive the round trip and reach restore().
    got: list = []
    monkeypatch.setattr(constrain_mod, "restore", lambda applied: got.extend(applied) or [])
    _plant(journal.CONSTRAINTS_APPLIED, applied=[{
        "container": "abc", "service": "rocketchat", "prior_nano": 2_000_000_000,
        "prior_mem": 1073741824, "prior_swap": -1, "set_cpus": True,
        "set_mem": False}])
    assert journal.recover()[0]["repaired"] is True
    assert len(got) == 1 and got[0].prior_nano == 2_000_000_000, got
    assert got[0].set_mem is False, "restore must not cap a dimension nobody capped"


def test_describe_only_describes(monkeypatch):
    """`describe()` is a formatting function and must not DO anything.

    It briefly did: a repair block was inserted with an anchor that matched the first
    `if entry.kind == ROCKETCHAT_STOPPED:` in the file, which is in `describe`, not in
    `_repair`. So describing an entry tore down a workspace and returned True instead
    of a sentence -- caught because a test asserted `repaired is True` and got False,
    with `what` holding a boolean.
    """

    from houston.services import journal

    src = source_of(journal.describe)
    for forbidden in ("runner.", "restore(", "subprocess", "clear("):
        assert forbidden not in src, f"describe() must not reach for {forbidden!r}"
    for kind in journal.KINDS:
        text = journal.describe(journal.Entry(id="i", kind=kind, workspace="w", pid=1,
                                              at="T"))
        assert isinstance(text, str) and "w" in text, (kind, text)


def _offenders_in_one_module(ARMING_CALLS, GUARDED, ast, offenders, path, tree):
    """Every function in one file, and whether what it arms is journalled."""
    for fn in [n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        body = ast.unparse(fn)
        recorded = {ast.unparse(c.args[0]).rsplit(".", 1)[-1]
                    for c in ast.walk(fn)
                    if isinstance(c, ast.Call)
                    and ast.unparse(c.func).endswith("journal.record") and c.args}
        where = f"{path.name}:{fn.name}"
        for value, kind in GUARDED.items():
            # ARMED = this setting is set to False by ONE call. Asking whether the
            # function mentions the setting anywhere AND contains ", False)" anywhere
            # was true of the big functions by luck and false of the small ones by
            # luck: `_restore_capacity` turns the LIMITER back on and turns METRICS
            # off, which is two settings and neither is an arming. Reading the call
            # itself is the question actually being asked, and it is the one that
            # survives a function being split.
            alias = ("RC_RATE_LIMITER_SETTING"
                     if value == "API_Enable_Rate_Limiter" else "EMAIL_2FA_SETTING")
            armed = any(
                any(value in ast.unparse(a) or alias in ast.unparse(a)
                    for a in call.args)
                and any(isinstance(a, ast.Constant) and a.value is False
                        for a in call.args)
                for call in ast.walk(fn) if isinstance(call, ast.Call))
            if armed and kind not in recorded:
                offenders.append(f"{where} disables {value} and records no {kind}")
        for call, kind in ARMING_CALLS.items():
            if call + "(" in body and kind not in recorded:
                offenders.append(f"{where} calls {call}() and records no {kind}")


def _the_side_effects_a_kill_must_not_strand():
    """The walk itself: every function in the package, and what each of them arms."""
    import ast
    import pathlib as _pl

    from houston import config
    from houston.services import journal

    root = _pl.Path(config.__file__).parent

    #: setting value -> the journal kind that undoes turning it off/on.
    GUARDED = {
        "API_Enable_Rate_Limiter": "RATE_LIMITER_OFF",
        journal.EMAIL_2FA_SETTING: "EMAIL_2FA_OFF",
    }
    #: Calls that arm something a kill must not strand, and the kind for each.
    ARMING_CALLS = {
        "constrain_mod.apply": "CONSTRAINTS_APPLIED",
        "mongoprof.start": "MONGO_PROFILER_ON",
    }

    offenders: list[str] = []
    for path in sorted(root.rglob("*.py")):
        # journal.py is the REPAIR side by definition -- `_repair` puts these settings
        # back, so it mentions every one of them and journals none. Excluded by name
        # rather than by a cleverer predicate, because "the module that undoes them" is
        # the honest reason and a predicate would drift.
        if "/data/" in str(path) or path.name == "journal.py":
            continue
        text = path.read_text()
        try:
            tree = ast.parse(text)
        except SyntaxError:                                    # pragma: no cover
            continue
        _offenders_in_one_module(ARMING_CALLS, GUARDED, ast, offenders, path, tree)
    return journal, offenders


def test_every_side_effect_that_outlives_a_kill_is_journalled():
    """The walk that makes the journal a registry rather than a habit.

    THIS TEST USED TO PASS FOR THE WRONG REASON, TWICE, and a second reviewer found
    both. It was a hardcoded four-function list rather than a walk, so `houston/seed.py`
    and `houston/configimport.py` -- which both disable the API rate limiter, and seed
    also disables email-2FA -- were simply outside its scope. And even once they were in
    scope the assertion silently skipped, because the guard was the source text
    `"config.RC_RATE_LIMITER_SETTING" in src` while both files spelled the setting as
    the bare literal `"API_Enable_Rate_Limiter"`. A test whose guard is defeated by the
    very drift it is meant to catch.

    So it walks the package now, and it matches on the SETTING STRING rather than on
    how a file happens to spell the constant -- there is no spelling that dodges it
    short of building the name at runtime, which the invariant below forbids.

    Why it matters in use: README promises "Email-2FA and the rate limiter are disabled
    while seeding and restored afterwards." A GUI seed of the `large` profile is minutes
    long against `jobs.drain`'s 25 seconds, so a `systemctl restart` mid-seed is
    routine. What survived was a workspace with the limiter AND email-2FA off, silently
    different from the one an engineer was about to measure, and invisible to both
    `doctor`'s `interrupted-work` row and `serve`'s startup recovery.
    """
    journal, offenders = _the_side_effects_a_kill_must_not_strand()

    assert not offenders, (
        "these arm a side effect that outlives a SIGKILL and journal nothing:\n  "
        + "\n  ".join(offenders))

    # The kinds this walk depends on must exist, so a rename cannot turn the whole
    # thing into a no-op that reports green.
    for kind in ("RATE_LIMITER_OFF", "EMAIL_2FA_OFF", "CONSTRAINTS_APPLIED",
                 "MONGO_PROFILER_ON", "RC_METRICS_ON"):
        assert hasattr(journal, kind), kind


def test_a_dry_run_of_the_journal_does_not_change_it():
    """`recover(dry_run=True)` DELETED advisory notes whose workspace was gone.

    The clear sat above the dry_run check, so a dry run over two notes reported one and
    removed the other -- and a dry run is the only way to inspect the journal without
    repairing it, which makes mutating one a contradiction in terms.
    """
    from houston import runner
    from houston.services import journal

    import os
    ident = journal.record(journal.CREATE_UNFINISHED, "ghost-workspace")
    assert ident, "the note was not written"
    # Owned by a process that cannot be us, so `abandoned()` includes it.
    path = journal.journal_dir() / f"{ident}.json"
    import json as _json
    doc = _json.loads(path.read_text())
    doc["pid"] = 999999 if os.getpid() != 999999 else 999998
    doc["started"] = "1"
    path.write_text(_json.dumps(doc))

    assert not runner.exists("ghost-workspace")     # the branch under test
    rows = journal.recover(dry_run=True)

    assert path.exists(), "a dry run deleted the note it was only meant to report"
    assert any(r["workspace"] == "ghost-workspace" for r in rows), rows


def _an_interrupted_create_that_asked_for_a_seed(monkeypatch, tmp_path):
    """A create killed after the workspace existed and before the seed ran."""
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))

    # 1. THE NOTE `create_repro` WRITES carries the request. That is where the detail
    #    was missing -- `journal.record` has always accepted **detail and was called
    #    with none -- so asserting on a hand-written note would prove nothing.
    seen: dict = {}

    def capture(*a, **k):
        for e in journal.open_entries():
            if e.kind == journal.CREATE_UNFINISHED and e.workspace == "halfmade":
                seen.update(e.detail)
        raise RuntimeError("stop here; the note has been read")

    monkeypatch.setattr(lc.create_docker, "_create_repro_locked", capture)
    try:
        lc.create_repro(lc.CreateReq(version="8.5.1", name="halfmade", seed=True,
                                     seed_profile="standard"))
    except RuntimeError:
        pass
    return journal, seen


def test_ready_carries_the_seed_the_interrupted_create_asked_for(monkeypatch, tmp_path):
    """`ready` cleared the note and never ran the pending seed.

    The note says the workspace "may be running WITHOUT its preset configuration or
    seed data" and names `ready` as what completes it. `wait_and_finalize` ran
    post_ready -- recoverable, because meta.extra["post_ready"] is persisted -- and
    then `clear_kind`. It could not seed and did not say so: `req.seed` lived only in
    the dead process's CreateReq, `meta.extra["seed"]` is written only AFTER a seed
    succeeds, and `journal.record` was called with no detail at all although it accepts
    **detail.

    Verified live: SIGKILL an `up --wait --seed` once compose has detached, run `ready`,
    get "ready" and exit 0, and find the workspace holding two users and one channel --
    with the note gone. That is worse than leaving it, because the engineer follows the
    tool's own instruction, is told the workspace is complete, doctor agrees, and the
    evidence that anything was missing has been deleted.
    """
    journal, seen = _an_interrupted_create_that_asked_for_a_seed(monkeypatch, tmp_path)
    assert seen.get("seed") is True, (
        f"the create's own note does not record that a seed was asked for: {seen}")
    assert seen.get("seed_profile") == "standard", seen

    ident = journal.record(journal.CREATE_UNFINISHED, "halfmade",
                           seed=True, seed_profile="standard", seed_stats=False)

    # 2. And `pending_seed` reads it back, so `ready` has something to act on. Only
    #    ABANDONED notes count: one whose owner is alive belongs to a create still
    #    running, and seeding under it would seed twice.
    import json as _json
    import os
    path = journal.journal_dir() / f"{ident}.json"
    doc = _json.loads(path.read_text())
    assert journal.pending_seed("halfmade") == {}, (
        "a note owned by a LIVE process was treated as pending work")
    doc["pid"] = 999999 if os.getpid() != 999999 else 999998
    doc["started"] = "1"
    path.write_text(_json.dumps(doc))

    pending = journal.pending_seed("halfmade")
    assert pending.get("seed") is True, pending
    assert pending.get("seed_profile") == "standard", pending
    # A create that asked for NO seed leaves nothing for `ready` to do.
    assert journal.pending_seed("never-existed") == {}


def test_journal_timestamps_are_utc_like_every_other_record(tmp_path, monkeypatch):
    """`time.strftime` with no second argument is LOCAL time.

    So one event read 22:29 in a journal note and 16:59 in the repro.json written
    beside it -- and a note is read next to `doctor`, `list` and an audit line, all of
    which are UTC.
    """
    import time as _time

    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ident = journal.record(journal.RATE_LIMITER_OFF, "clocktest")
    entry = next(e for e in journal.open_entries() if e.id == ident)

    assert entry.at.endswith("Z"), f"not marked as UTC: {entry.at}"
    stamped = _time.strptime(entry.at, "%Y-%m-%dT%H:%M:%SZ")
    now = _time.gmtime()
    # Within a minute of UTC now. On a box whose local time is UTC this would pass
    # either way, so the "Z" assertion above is what actually pins it.
    assert abs(_time.mktime(stamped) - _time.mktime(now)) < 60, (entry.at,
                                                                _time.asctime(now))


def test_the_restore_records_the_window_where_the_database_is_empty(monkeypatch,
                                                                   tmp_path):
    """`--drop` is not enough on its own, so the restore drops the DATABASE first --
    and a multi-GB bundle then takes minutes to load.

    `_Quiesced` journals ROCKETCHAT_STOPPED, so a SIGKILL in that window gets
    Rocket.Chat restarted by recovery and reported as REPAIRED, against an empty
    database. Nothing recorded the drop. README promises "the target database is dropped
    first, so you never get a hybrid" -- true, and it swapped in a worse failure that
    was invisible.

    Advisory, because re-running a mongorestore at `serve` startup is not something a
    GUI startup may spend; `doctor`'s `interrupted-work` row reports it and the same
    `restore` command finishes it.
    """

    from houston.services import backup, journal

    assert journal.DATABASE_DROPPED in journal.KINDS
    assert journal.DATABASE_DROPPED in journal.ADVISORY, (
        "recovery must not silently re-run a mongorestore at startup")

    # Through the calls, not just this function's own text: 2b.15 moved the restore
    # body into `_load_from_bundle`, and a search of `_restore_locked` alone then
    # reported the journalling gone when it had only moved one level down.
    src = source_through(backup._restore_locked)
    assert "journal.DATABASE_DROPPED" in src, "the drop window is still unrecorded"
    # BEFORE the drop, or it records nothing useful.
    assert source_index(src, "journal.DATABASE_DROPPED") < source_index(src, "_drop_database("), src
    # And cleared only on a successful load.
    assert "if rc == 0:" in src and "journal.clear(drop_note)" in src

    # The note names the bundle, because "restore it again" needs to say which one.
    text = journal.describe(journal.Entry(
        id="i", kind=journal.DATABASE_DROPPED, workspace="w", pid=1, at="T",
        detail={"bundle": "/b/x.rcbak"}))
    assert "/b/x.rcbak" in text and "EMPTY" in text, text


def test_an_interrupted_create_note_survives_a_serve_restart(monkeypatch, tmp_path):
    """The P0 journal fix, doing the job it was made for.

    Advisory notes are cleared when their subject is gone, and that question used to be
    `runner.exists(entry.workspace)`. A cluster is not a workspace, so this note --
    the most expensive one the product can hold -- would have been deleted at the next
    `serve` startup, silently.
    """
    from houston.services import eks, journal, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    journal.record(journal.CLUSTER_UNFINISHED, "rc-support",
                   region="eu-west-1", account="1")

    # The cluster is still there: the note must survive.
    monkeypatch.setattr(eks.aws, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.PRESENT, doc={}))
    monkeypatch.setattr(journal, "abandoned", journal.open_entries)
    rows = journal.recover(dry_run=True)
    assert [r["kind"] for r in rows] == [journal.CLUSTER_UNFINISHED]
    assert journal.open_entries(), "a live billable cluster's note was dropped"

    # Could not ask: the note must ALSO survive. A credential expiring between the
    # create and the next startup must not lose the record.
    monkeypatch.setattr(eks.aws, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.REFUSED))
    assert journal.recover(dry_run=True), "an unaskable subject is not an absent one"

    # And when AWS says it is genuinely gone, the note clears itself.
    monkeypatch.setattr(eks.aws, "describe_cluster",
                        lambda n, r: k8s.Answer(state=k8s.ABSENT))
    journal.recover()
    assert not journal.open_entries()


def test_recovery_restarts_rocketchat_and_re_enables_the_rate_limiter(
        tmp_path, monkeypatch):
    """The two states an interrupted job leaves behind, and what undoes each.

    `_Quiesced`'s own docstring calls a workspace left stopped "a worse outcome than
    the failure itself"; the rate limiter being off is a security-relevant setting
    nobody chose. Verified live as well: SIGKILL a real quiesce and `serve` starts
    Rocket.Chat again at its next startup.
    """
    from houston.services import journal, recovery

    recovery.install()

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(journal.runner.paths, "exists", lambda n: True)
    dead = {"pid": 999999, "started": "1"}

    def _plant(kind, **detail):
        eid = journal.record(kind, "w", **detail)
        path = journal.journal_dir() / f"{eid}.json"
        data = json.loads(path.read_text())
        data.update(dead)
        path.write_text(json.dumps(data))
        return eid

    started: list = []
    monkeypatch.setattr(journal.runner.engine, "start_services", lambda n, svcs: started.append((n, svcs)) or 0)
    _plant(journal.ROCKETCHAT_STOPPED, services=["rocketchat"])
    rows = journal.recover()
    assert rows and rows[0]["repaired"] is True, rows
    assert started == [("w", ["rocketchat"])], started
    assert journal.open_entries() == [], "a repaired note is cleared"

    # The rate limiter, and a repair that FAILS must keep its note.
    from houston import rcapi
    from houston.services import lifecycle
    monkeypatch.setattr(lifecycle.admin, "login", lambda m: object())
    monkeypatch.setattr(journal.runner.record, "read_meta", lambda n: _idp_meta("default"))
    monkeypatch.setattr(rcapi, "set_setting", lambda *a, **k: False)
    _plant(journal.RATE_LIMITER_OFF)
    rows = journal.recover(login=lifecycle.login)
    assert rows[0]["repaired"] is False, rows
    assert len(journal.open_entries()) == 1, "an unrepaired note must survive"

    monkeypatch.setattr(rcapi, "set_setting", lambda *a, **k: True)
    assert journal.recover(login=lifecycle.login)[0]["repaired"] is True
    assert journal.open_entries() == []


def test_doctor_tells_a_cli_box_about_interrupted_work(tmp_path, monkeypatch):
    """`serve` repairs from the journal at startup, and a CLI-only box never starts
    one -- so `doctor` is the only place that would ever mention it there.

    An entry a LIVE job holds is reported as progress, not as a fault.
    """
    from houston.services import doctor, journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    journal.record(journal.RATE_LIMITER_OFF, "mine")        # this process: alive
    rows = [r for r in doctor.run_checks()["checks"]
            if r.get("check") == "interrupted-work"]
    assert rows and rows[0]["status"] == "ok", rows
    assert "in progress" in rows[0]["message"], rows[0]

    entry = journal.open_entries()[0]
    path = journal.journal_dir() / f"{entry.id}.json"
    data = json.loads(path.read_text())
    data.update(pid=999999, started="1")
    path.write_text(json.dumps(data))
    rows = [r for r in doctor.run_checks()["checks"]
            if r.get("check") == "interrupted-work"]
    assert rows and rows[0]["status"] == "warn", rows
    assert "rate limiter" in rows[0]["message"], rows[0]


def test_the_cli_records_the_seed_it_is_about_to_run(monkeypatch, tmp_path):
    """`cli.up` built `CreateReq(..., seed=False)` because it seeds itself afterwards.

    So the write-ahead note recorded `seed: False` with the profile defaulted, and
    `create_repro` cleared it before control returned -- which meant the `pending_seed`
    recovery landed in v0.72.2 covered the GUI and NOT `houston up --seed`, the
    invocation the README documents. Exactly the scenario lifecycle.py describes:
    "told the workspace is complete, doctor agrees, and the evidence that anything was
    missing has been deleted."
    """
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import journal
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    captured: dict = {}

    # The INNER function, so the real `create_repro` runs and actually writes the
    # write-ahead note -- stubbing `create_repro` itself would mean no note existed to
    # observe, which is a test that cannot see the thing it is about.
    def fake_locked(req, emit=None, stream_output=False, **_kw):
        captured["req"] = req
        for e in journal.open_entries():
            if e.kind == journal.CREATE_UNFINISHED:
                captured["note"] = dict(e.detail)
        raise RuntimeError("stop before the CLI seeds")

    monkeypatch.setattr(lc.create_docker, "_create_repro_locked", fake_locked)
    CliRunner().invoke(cli.app, ["up", "--version", "8.5.1", "--name", "sd",
                                 "--seed", "--seed-profile", "standard", "--offline"])

    req = captured.get("req")
    assert req is not None, "create_repro was never called"
    assert req.seed is True, "the CLI still hides its seed intent from the service"
    assert req.seed_profile == "standard", req.seed_profile
    # `seed_here` keeps the two-phase shape: the CLI runs the seed, so the service
    # must not, or the workspace would be seeded twice.
    assert req.seed_here is True, "seed_here not set; create_repro would seed too"

    note = captured.get("note")
    assert note, "no write-ahead note existed during the create"
    assert note.get("seed") is True, note
    assert note.get("seed_profile") == "standard", note


def _renamed_by_the_axes(monkeypatch, tmp_path) -> dict:
    """`--deployment multi-instance` with no `--name`: the create is locked and noted under
    `rc8-5-1`, the name derived BEFORE `resolve_axes` ran, and makes
    `rc8-5-1-multi-instance`. The inner function is stubbed to say so, so the real
    `create_repro` writes and handles the note."""
    from houston.services import journal
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: dict = {}

    def fake_locked(req, emit=None, stream_output=False, **_kw):
        seen["during"] = [e.workspace for e in journal.open_entries()
                          if e.kind == journal.CREATE_UNFINISHED]
        return {"name": "rc8-5-1-multi-instance"}

    monkeypatch.setattr(lc.create_docker, "_create_repro_locked", fake_locked)
    return seen


def test_a_renaming_create_hands_the_caller_a_note_under_the_name_it_made(monkeypatch, tmp_path):
    """With `seed_here` the note is the caller's to close, and the caller closes it by the
    name it is handed back. Recorded under the pre-rename name, it was never closed (P21,
    g1-09); moved to the created one, it still covers the caller's seed."""
    from houston.services import journal
    from houston.services import lifecycle as lc

    seen = _renamed_by_the_axes(monkeypatch, tmp_path)
    out = lc.create_repro(lc.CreateReq(version="8.5.1", deployment="multi-instance",
                                       replicas=3, offline=True, seed_here=True))
    assert out["name"] == "rc8-5-1-multi-instance"
    assert seen["during"] == ["rc8-5-1"], "the note is written under the lock's name"
    notes = [(e.workspace, e.detail.get("seed_here")) for e in journal.open_entries()
             if e.kind == journal.CREATE_UNFINISHED]
    assert notes == [("rc8-5-1-multi-instance", True)], notes


def test_up_leaves_no_note_for_a_workspace_the_axes_renamed(monkeypatch, tmp_path):
    """`up --offline --version 8.5.1 --deployment multi-instance --replicas 3` left
    journal/<id>.json {kind: create_unfinished, workspace: 'rc8-5-1'} behind, and `doctor`
    then reported an unfinished create for a workspace that does not exist (P21, g1-09)."""
    from typer.testing import CliRunner

    from houston import cli, jsonout
    from houston.services import journal

    _renamed_by_the_axes(monkeypatch, tmp_path)
    try:
        # --json, so the panel does not need a whole record to render from.
        r = CliRunner().invoke(cli.app, ["up", "--offline", "--version", "8.5.1",
                                         "--deployment", "multi-instance", "--replicas", "3",
                                         "--json"])
    finally:
        jsonout.json_mode_reset()     # process-global; the next test's prose is not ours
    assert r.exit_code == 0, r.output
    left = [(e.kind, e.workspace) for e in journal.open_entries()]
    assert left == [], left


def test_clearing_a_workspace_s_notes_leaves_every_other_subject_alone(tmp_path,
                                                                       monkeypatch):
    """What `down --volumes` and `prune` call once the record is gone.

    Every note ABOUT that workspace goes, whoever wrote it. Two things stay: another
    workspace's notes, and a `cluster_unfinished` whose `workspace` field happens to hold
    the same name -- it is about a cloud cluster that may be billing, and a workspace of
    that name being deleted says nothing about it. Every kind is decided one way or the
    other, so a new one cannot fall into a default nobody chose.
    """
    from houston.services import journal

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    assert set(journal.WORKSPACE_KINDS) | set(journal.OUTLIVE_THE_WORKSPACE) \
        == set(journal.KINDS)
    assert not set(journal.WORKSPACE_KINDS) & set(journal.OUTLIVE_THE_WORKSPACE)
    for kind in journal.KINDS:
        journal.record(kind, "gone")
    journal.record(journal.CREATE_UNFINISHED, "gone")
    journal.record(journal.CREATE_UNFINISHED, "other")
    journal.record(journal.RATE_LIMITER_OFF, "other")

    assert journal.clear_workspace("gone") == len(journal.WORKSPACE_KINDS) + 1
    assert sorted((e.kind, e.workspace) for e in journal.open_entries()) == [
        ("cluster_unfinished", "gone"), ("create_unfinished", "other"),
        ("rate_limiter_off", "other")]
    assert journal.clear_workspace("gone") == 0, "nothing left to clear is not an error"
