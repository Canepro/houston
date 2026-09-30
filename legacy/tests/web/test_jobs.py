"""`houston.web.jobs`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""

from __future__ import annotations

from conftest import source_of
from houston.services import events
from houston.services import lifecycle as lc
from pathlib import Path
from servicehelpers import _await_finish
import pytest


def test_job_events_are_capped_with_absolute_indices():
    from houston.web import jobs as J
    job = J.Job(id="job_x", kind="t")
    for i in range(J.MAX_EVENTS_PER_JOB + 50):
        job.emit(events.Event(f"e{i}"))
    # `serve` is long-lived and every streamed docker line is an Event, so the
    # per-job buffer is bounded -- but the index the SSE stream hands out stays
    # absolute, so a reader cannot desync by counting.
    assert len(job.events) == J.MAX_EVENTS_PER_JOB
    assert job.n_events == J.MAX_EVENTS_PER_JOB + 50
    evs, done, nxt = job.snapshot(0)
    assert len(evs) == J.MAX_EVENTS_PER_JOB and nxt == job.n_events
    assert job.snapshot(nxt) == ([], done, nxt)      # nothing new after catching up


def test_job_registry_evicts_finished_jobs_only():
    from houston.web import jobs as J
    mgr = J.JobManager()
    for i in range(J.MAX_JOBS + 20):
        mgr._jobs[f"job_{i}"] = J.Job(id=f"job_{i}", kind="t", status="done")
    mgr._jobs["job_live"] = J.Job(id="job_live", kind="t", status="running")
    mgr._evict_locked()
    assert len(mgr._jobs) <= J.MAX_JOBS
    assert mgr.get("job_live") is not None    # a running job is never evicted
    assert mgr.get("job_0") is None           # the oldest finished ones go first


# --- job concurrency is bounded (F10) -------------------------------------------
# Job RETENTION was bounded; concurrency was not. Ten teammates each starting a
# capacity search meant ten k6 containers against one engine -- searches that
# invalidate each other and starve the workspaces under test. A perf tool that
# silently produces wrong numbers under contention is worse than one that waits.

def test_a_second_load_test_waits_rather_than_corrupting_the_first():
    import threading
    import time as _t

    from houston.web.jobs import JobManager

    jobs = JobManager()
    started, release = threading.Event(), threading.Event()

    def hog(emit=None):
        started.set()
        release.wait(timeout=5)
        return {"ok": True}

    def quick(emit=None):
        return {"ok": True}

    first = jobs.submit("loadtest", hog, label="a")
    assert started.wait(timeout=5), "the first job should start immediately"
    second = jobs.submit("loadtest", quick, label="b")
    _t.sleep(0.2)
    assert second.status == "queued", "a concurrent load test is not a measurement"

    # And a queued job must not look finished: the SSE stream closes on that, and
    # eviction drops anything not active.
    _events, done, _n = second.snapshot(0)
    assert done is False, "a queued job reported as finished closes its own stream"

    release.set()
    for _ in range(50):
        if second.status == "done":
            break
        _t.sleep(0.1)
    assert second.status == "done" and first.status == "done"


def test_a_failing_job_releases_its_slot():
    """One leaked slot on the measurement pool (size 1) wedges every future load
    test for the life of the process."""
    import time as _t

    from houston.errors import ValidationError
    from houston.web.jobs import JobManager

    jobs = JobManager()

    def boom(emit=None):
        raise ValidationError("nope")

    failed = jobs.submit("loadtest", boom, label="a")
    for _ in range(50):
        if failed.status == "error":
            break
        _t.sleep(0.1)
    assert failed.status == "error"

    after = jobs.submit("loadtest", lambda emit=None: {"ok": True}, label="b")
    for _ in range(50):
        if after.status == "done":
            break
        _t.sleep(0.1)
    assert after.status == "done", "the slot was never released"


def test_ordinary_jobs_are_not_queued():
    """Reads, state changes and seeds stay unbounded, as before."""
    import time as _t

    from houston.web.jobs import JobManager

    jobs = JobManager()
    job = jobs.submit("seed", lambda emit=None: {"ok": True}, label="x")
    for _ in range(50):
        if job.status == "done":
            break
        _t.sleep(0.1)
    assert job.status == "done"


def test_a_seed_is_serialised_like_every_other_mutation():
    """`run_seed_inline` was the only data-mutating operation with no `repro_lock`.

    `create_repro`, `set_state`, `teardown`, `set_env`, `monitor.attach`,
    `backup.create`, `upgrade.run`, `run_scale` and `clear_scale` all take it; a seed
    writes the same collections through a different door and took nothing.
    `run_scale`'s own comment states the rule -- "running it while a backup is dumping
    would put half of it in the archive" -- and the worse direction is the other one:
    `_Quiesced` STOPS Rocket.Chat for the dump, so a seed running into it fails
    mid-manifest and the readback reports faults nobody caused.
    """

    from houston.services import data as lc_data

    src = source_of(lc.run_seed_inline)
    assert "repro_lock" in src, "a seed still races every other mutator"
    # Reentrant per thread, so `up --seed` (which already holds it) is unaffected.
    assert "reentrant" in src.lower() or "re-entering" in src.lower()

    # And the seed is pooled: hundreds of REST writes against one workspace.
    from houston.web import jobs
    assert jobs._slots_for("seed") is not None, "seed submits unbounded"

    # CONFIG-IMPORT IS THE OTHER ONE, and it was missed right beside the seed: it
    # applies a customer dump's settings to a live workspace over REST and had
    # neither a lock nor a pool. Two on one workspace interleave setting by setting,
    # and one running into a backup's `_Quiesced` -- which stops Rocket.Chat for the
    # dump -- half-applies, leaving settings matching neither the dump nor the
    # workspace. Verified by reading it rather than assumed: an audit claimed
    # `data.py` already locked it, and the two locks there belong to run_scale and
    # clear_scale.
    src_import = source_of(lc_data.import_apply)
    assert "repro_lock" in src_import, "config-import still races every other mutator"
    assert jobs._slots_for("config-import") is not None, \
        "config-import submits unbounded"
    assert jobs._slots_for("config-import") is jobs._slots_for("seed"), \
        "the two data-mutating operations share one ceiling"

    # DOING AND UNDOING SHARE A CEILING. `scale` was pooled and `clear-scale` was not,
    # which bounds half the work -- the same asymmetry `monitor`/`monitor-off` was
    # fixed for, and `clear-scale` bulk-deletes through the same Mongo exec that
    # `scale` bulk-inserts through.
    for pair in (("scale", "clear-scale"), ("monitor", "monitor-off")):
        assert jobs._slots_for(pair[0]) is jobs._slots_for(pair[1]) is not None, pair

    # The reads stay unpooled ON PURPOSE, and this records why so it is a decision
    # rather than an oversight. `ready` is what the dashboard polls every few seconds:
    # a ceiling there queues the GUI's own refresh behind whatever else is running,
    # and the hazard an audit raised for it -- concurrent `ensure_port_forward` calls
    # recording pids for forwards that never bound -- is closed at the source, since
    # `port_forward` now returns 0 rather than a pid when it cannot get the socket.
    for cheap in ("env", "ready", "state"):
        assert jobs._slots_for(cheap) is None, (
            f"{cheap} is a read and pooling it queues the dashboard's own polling")


def test_the_monitor_job_is_pooled_and_the_walk_can_see_it():
    """`monitor` chose its kind with a ternary, and the pool walk skipped non-constant
    kinds BY CONSTRUCTION -- with a comment naming this very route as the case it
    skipped.

    So `monitor` sat outside every pool unnoticed, and `monitorsvc.attach` does a
    PULLING `runner.up`: Prometheus, Grafana, Loki, an OTel collector and two exporters.
    N members clicking Monitor was N pulling compose-ups on one engine, which is the
    failure the pool was added for.
    """
    from houston.web import jobs

    for kind in ("monitor", "monitor-off"):
        assert jobs._slots_for(kind) is not None, f"{kind} is unpooled"
    # Both resolve to the SAME pool, since they are the same work in two directions.
    assert jobs._slots_for("monitor") is jobs._slots_for("monitor-off")


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_a_job_that_dies_of_a_baseexception_does_not_stay_running_forever():
    """Only `ReproError` and `Exception` were caught.

    So anything else -- a KeyboardInterrupt delivered to the worker thread, a
    SystemExit from a library, a MemoryError -- left `status` at "running". That is in
    ACTIVE_STATUSES, so `_evict_locked` can never drop the job, `_trim_results` never
    releases its result, and the SSE stream never terminates: a browser tab holds the
    connection open waiting for an event that cannot arrive.
    """
    from houston.web import jobs

    reg = jobs.JobManager()

    def boom(emit=None):
        raise KeyboardInterrupt("delivered to the worker")

    job = reg.submit("ready", boom, label="x")
    reg.drain(timeout=15.0)

    got = reg.get(job.id)
    assert got is not None
    assert got.status not in jobs.ACTIVE_STATUSES, (
        f"status is {got.status!r} — the job is still active and can never be evicted")
    assert got.status == "error", got.status
    assert "KeyboardInterrupt" in (got.error or ""), got.error


# --- graceful shutdown (F15) ----------------------------------------------------

def test_shutdown_waits_for_a_running_job():
    """A backup killed inside _Quiesced leaves Rocket.Chat STOPPED with nothing to
    restart it; a load test killed mid-run leaves CPU caps applied. Daemon threads
    skip every `finally`, and `Restart=always` makes that routine."""
    import time as _t

    from houston.web.jobs import JobManager

    jobs = JobManager()
    cleaned = []

    def slow(emit=None):
        try:
            _t.sleep(0.4)
            return {"ok": True}
        finally:
            cleaned.append("restored")

    jobs.submit("seed", slow, label="x")
    _t.sleep(0.05)
    left = jobs.drain(timeout=5)
    assert left == [], "the job should have finished before the deadline"
    assert cleaned == ["restored"], "its cleanup must have run"


def test_shutdown_is_bounded_and_names_what_it_abandoned():
    """A capacity search can run for an hour; a shutdown that never completes is
    its own failure, and systemd would SIGKILL us anyway."""
    import threading
    import time as _t

    from houston.web.jobs import JobManager

    jobs = JobManager()
    release = threading.Event()
    job = jobs.submit("seed", lambda emit=None: release.wait(timeout=10), label="x")
    _t.sleep(0.05)
    left = jobs.drain(timeout=0.3)
    assert left == [job.id], "an abandoned job must be named"
    release.set()


def test_new_work_is_refused_once_shutting_down():
    from houston.errors import ConflictError
    from houston.web.jobs import JobManager

    jobs = JobManager()
    jobs.drain(timeout=0)
    with pytest.raises(ConflictError):
        jobs.submit("seed", lambda emit=None: None, label="x")


def _the_job_kinds_and_the_pools_they_claim():
    """Every kind the registry knows, and which pool each one is serialised through."""
    import ast
    import pathlib

    from houston.web import jobs

    # EVERY module in the web layer, not just app.py. Phase 2a moved the submitting
    # handlers into `web/routes/`, and a walk that keeps reading one file would have
    # gone on passing over eight sites instead of sixteen. The receiver is matched by
    # source text because there are now two spellings of the same registry: `jobs` when
    # the factory still held it, and `_deps.jobs(request)` from a module-level handler.
    web = pathlib.Path(jobs.__file__).parent
    submits: list[tuple[str, str]] = []
    nodes = [n for p in sorted(web.rglob("*.py")) for n in ast.walk(ast.parse(p.read_text()))]
    for node in nodes:
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "submit"
                and ast.unparse(node.func.value).startswith(("jobs", "_deps.jobs("))):
            continue
        if not node.args:
            continue
        # A TERNARY IS TWO KINDS, NOT AN OPAQUE ONE. This used to skip anything that
        # was not an `ast.Constant`, with a comment naming the monitor route as the
        # case it skipped -- and that route was the one sitting outside every pool.
        # A skip whose comment names its own blind spot is a blind spot.
        first = node.args[0]
        if isinstance(first, ast.Constant):
            kinds = [str(first.value)]
        elif (isinstance(first, ast.IfExp)
              and isinstance(first.body, ast.Constant)
              and isinstance(first.orelse, ast.Constant)):
            kinds = [str(first.body.value), str(first.orelse.value)]
        else:
            raise AssertionError(
                f"jobs.submit's kind is {ast.dump(first)[:60]}, which this walk cannot "
                f"read -- hoist it into a local so the pool can be checked")
        target = node.args[1] if len(node.args) > 1 else None
        for k in kinds:
            submits.append((k, ast.unparse(target) if target else ""))
    return jobs, submits


def test_every_engine_heavy_job_kind_lands_in_a_pool():
    """A job's POOL is chosen by its kind STRING, and the kind string is not the work.

    Two routes submitted engine-heavy work under a label nobody had added to
    `_HEAVY_KINDS`: "up" calls `lc.create_repro`, the same function as "create", and
    "rollback" restores a bundle exactly as "restore" does. Both resolved to no pool at
    all, so N concurrent `POST /api/repros/{name}/up` calls ran N compose-ups at once,
    past a `check_capacity` each passes independently because none has finished
    allocating yet. A GUI that retries a failed start reaches that by accident.

    This is the shape of nearly every defect this codebase has shipped: a registry that
    is correct and is not enforced by a walk. `ROUTE_ROLES` has had one since
    test_web.py:1534 and has never drifted; the job pools had none. Parsed rather than
    grepped, because a 26-line grep window straddles route boundaries in app.py and
    gives the wrong answer -- that mistake was made while finding this.
    """
    jobs, submits = _the_job_kinds_and_the_pools_they_claim()

    assert len(submits) >= 14, f"only found {len(submits)} jobs.submit sites - parser drifted"

    # RULE 1: two kinds submitting the SAME callable must resolve to the same pool.
    # This is what "up" and "create" violated, and it needs no maintained list.
    by_target: dict[str, set[str]] = {}
    for kind, target in submits:
        if target:
            by_target.setdefault(target, set()).add(kind)
    for target, kinds in by_target.items():
        pools = {id(jobs._slots_for(k)) for k in kinds}
        assert len(pools) == 1, (
            f"{target} is submitted as {sorted(kinds)}, which resolve to different "
            f"pools - the same work must be bounded the same way")

    # RULE 2: work that costs a container engine a whole workspace is pooled. A
    # maintained list, so adding an unpooled one is a visible decision rather than an
    # omission; the names are dotted so "run" and "create" cannot collide.
    engine_heavy = {
        "lc.create_repro", "backupsvc.create", "backupsvc.restore",
        "upgradesvc.run", "upgradesvc.rollback", "lc.teardown", "lc.prune",
        "datasvc.run_scale",
        # `attach` does a pulling `runner.up` of six containers; `detach` removes them
        # and their volumes. The ternary above hid this from Rule 1.
        "monitorsvc.detach if off else monitorsvc.attach",
        # Hundreds of REST writes against one workspace.
        "lc.run_seed_inline",
    }
    for kind, target in submits:
        if target in engine_heavy:
            assert jobs._slots_for(kind) is not None, (
                f"job kind {kind!r} submits {target}, which costs an engine a whole "
                f"workspace, and lands in no pool - add it to jobs._HEAVY_KINDS")


def test_the_queue_ceiling_counts_the_pool_it_protects_not_the_kind():
    """`MAX_QUEUED_PER_KIND` counted per KIND against pools shared by many kinds.

    The measurement in jobs.py's own comment -- 40 capacity submissions producing 40
    live OS threads -- motivated a bound of 32. Counting per kind made the reachable
    total 3x32 against the measurement pool of 1, so the bound written to stop 40
    threads permitted 96. `_evict_locked` cannot claw any of it back either: a queued
    job is correctly counted active, so MAX_JOBS is unenforceable against exactly the
    jobs this refuses.

    Referenced by the OLD constant name, which survives as an alias, so this asserts
    the counting BEHAVIOUR rather than the presence of a renamed constant -- failing
    on `AttributeError` would prove only that a name is new.

    TWO kinds share that pool now, not three: `benchmark` was deleted in step 0.12.
    The arithmetic below moved with it, and the test failed loudly when it did not --
    49 accepted against a ceiling of 32 -- which is the coupling being deleted showing
    up where it should.
    """
    import threading as _threading

    from houston.errors import ConflictError
    from houston.web import jobs

    ceiling = jobs.MAX_QUEUED_PER_KIND
    reg = jobs.JobManager()
    blocked = _threading.Event()
    try:
        accepted = 0
        # The kinds that SHARE the measurement pool, round-robin.
        pool_kinds = ("loadtest", "capacity")
        for i in range(ceiling * len(pool_kinds) + 8):
            kind = pool_kinds[i % len(pool_kinds)]
            try:
                reg.submit(kind, lambda emit=None: blocked.wait(30), label=f"j{i}")
                accepted += 1
            except ConflictError:
                break
        # One escapes the queue into the single running slot, hence the slack.
        assert accepted <= ceiling + 2, (
            f"{accepted} jobs accepted across {len(pool_kinds)} kinds sharing one pool, "
            f"against a ceiling of {ceiling} - the count is per kind, not per pool")
    finally:
        blocked.set()
        reg.drain(timeout=10.0)


def test_job_status_is_set_before_the_terminal_event(monkeypatch):
    from houston.web import jobs as J
    captured = []
    original = J.Job.emit

    def spy(self, ev):
        captured.append((ev.terminal, self.status, self.result))
        original(self, ev)

    monkeypatch.setattr(J.Job, "emit", spy)
    job = J.JobManager().submit("t", lambda emit: "R")
    _await_finish(job)
    terminal = [c for c in captured if c[0]]
    # A client that polls /api/jobs/<id> on seeing `terminal` used to read
    # status="running" with result=None, because the event came first.
    assert terminal and terminal[-1] == (True, "done", "R")


def test_job_internal_error_does_not_leak_a_traceback():
    from houston.web import jobs as J
    job = J.JobManager().submit("t", lambda emit: 1 / 0)
    _await_finish(job)
    assert job.status == "error" and job.error_kind == "InternalError"
    evs, _done, _n = job.snapshot(0)
    # The traceback goes to the server's stderr; it must not ride the SSE payload
    # into a browser, which renders whatever it is handed.
    assert evs and all("trace" not in (e.get("data") or {}) for e in evs)

def test_an_unwritable_audit_log_does_not_break_the_job(monkeypatch):
    from houston import config as cfgmod
    from houston.web import jobs as jobs_mod
    # audit() imports config lazily, so patch the source module, not jobs.
    monkeypatch.setattr(cfgmod, "home",
                        lambda: Path("/proc/definitely-not-writable"))
    jobs_mod.audit("alice", "create", "8.5.1")     # must not raise


def test_the_job_queue_is_bounded_at_submit_not_at_the_slot():
    """The measurement and heavy pools bound how many jobs RUN at once, and they
    are acquired inside the worker thread -- so the thread already exists by the
    time it waits. Measured before this: 40 capacity submissions against a pool of
    size 1 produced 40 live OS threads and 40 retained Job objects, which
    _evict_locked() will not drop because a queued job is correctly active.
    """
    import threading

    from houston.errors import ConflictError
    from houston.web.jobs import MAX_QUEUED_PER_KIND, JobManager

    jm = JobManager()
    gate = threading.Event()
    before = threading.active_count()

    def slow(emit=None):
        gate.wait(timeout=30)
        return {"ok": True}

    try:
        for _ in range(MAX_QUEUED_PER_KIND + 1):     # +1 is the one that runs
            jm.submit("capacity", slow, label="q")
        with pytest.raises(ConflictError, match="waiting for a free slot"):
            jm.submit("capacity", slow, label="one-too-many")
        grew = threading.active_count() - before
        assert grew <= MAX_QUEUED_PER_KIND + 1, \
            f"threads are still unbounded: {grew} new ones"
    finally:
        gate.set()

    # An UNPOOLED kind is untouched -- reads and state changes were never the
    # problem and must not start refusing.
    jm2 = JobManager()
    for _ in range(MAX_QUEUED_PER_KIND + 5):
        jm2.submit("state", lambda emit=None: None, label="s")


def test_a_finished_job_releases_its_result_but_keeps_its_summary():
    """A capacity result is ~118 KB of nested loadtest documents, and MAX_JOBS is a
    hundred -- 68.8 MB held for the life of the process, measured. The Activity list
    only ever renders summary(), which excludes the result, so a hundred summaries
    and ten results is the right shape.
    """
    from houston.web.jobs import KEEP_RESULTS, JobManager

    jm = JobManager()
    for i in range(KEEP_RESULTS + 5):
        jm.submit("state", lambda emit=None, n=i: {"payload": "x" * 1000, "n": n},
                  label=f"j{i}")
    for jid in list(jm._jobs):
        jm._threads[jid].join(timeout=10)
    jm.submit("state", lambda emit=None: None, label="trigger")   # trims on submit

    kept = [j for j in jm._jobs.values() if j.result is not None]
    dropped = [j for j in jm._jobs.values() if j.result_dropped]
    assert len(dropped) == 5, f"expected 5 released, got {len(dropped)}"
    assert len(kept) <= KEEP_RESULTS

    # Everything the list view needs survives on a job whose result went.
    gone = dropped[0]
    assert gone.summary()["status"] == "done"
    assert gone.summary()["label"].startswith("j")
    assert gone.n_events > 0, "the progress trail is not what costs memory"


def test_releasing_a_result_drops_BOTH_references_to_it():
    """`job.result` and the terminal event's data["result"] are the SAME object,
    not a copy -- which is easy to misread, and clearing only one frees nothing."""
    from houston.services.events import Event
    from houston.web.jobs import Job

    job = Job(id="j", kind="capacity")
    payload = {"big": ["x"] * 100}
    job.result = payload
    job.status = "done"
    job.emit(Event("done", phase="done", terminal=True, data={"result": payload}))
    assert job.result is job.events[-1].data["result"], "premise of the test"

    job.forget_result()
    assert job.result is None
    assert "result" not in job.events[-1].data, "the second reference still held it"
    assert job.result_dropped is True
