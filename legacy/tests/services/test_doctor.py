"""`houston.services.doctor`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_of
from houston import errors
from houston.services import lifecycle as lc
import pytest


def test_kernel_major_minor_parsing():
    from houston.services import doctor as doctorsvc
    assert doctorsvc._kernel_major_minor("6.19.7-200.fc43.aarch64") == (6, 19)
    assert doctorsvc._kernel_major_minor("5.15.0-generic") == (5, 15)
    assert doctorsvc._kernel_major_minor("6.19") == (6, 19)
    assert doctorsvc._kernel_major_minor(None) is None
    assert doctorsvc._kernel_major_minor("not-a-kernel") is None


def test_compose_major_version_parsing():
    from houston.services import doctor as doctorsvc
    # A first-CHARACTER compare reported every Compose newer than v2 as
    # unsupported (v5 is current) and would misread v10 as v1.
    assert doctorsvc._major_version("2.29.1") == 2
    assert doctorsvc._major_version("v2.29.1") == 2
    assert doctorsvc._major_version("5.3.1") == 5
    assert doctorsvc._major_version("10.0.0") == 10
    assert doctorsvc._major_version("1.29.2") == 1        # genuinely too old
    assert doctorsvc._major_version(None) is None
    assert doctorsvc._major_version("") is None
    assert doctorsvc._major_version("unknown") is None


def test_an_impossible_mongo_kernel_pairing_is_refused_before_any_docker_work(monkeypatch):
    """SERVER-121912: mongod 8.0 EXITS on kernel >= 6.19 — not degrades, exits,
    with a message that reads like a volume or permission fault.

    `doctor` has known the rule for a while and could only warn, because it does
    not know which release you are about to boot. Nothing on the create path
    checked it, so `up` would pull ~1.5 GB of images, create the containers and
    then let mongod die, leaving `diagnose` to explain it afterwards. Now the
    pairing is resolved first and an impossible one is refused.
    """
    from houston.services import doctor

    # The rule itself: version-aware, so it answers differently per pairing.
    assert doctor.mongo_kernel_conflict("8.0", "6.19.7-200.fc43.aarch64")
    assert "SERVER-121912" in doctor.mongo_kernel_conflict("8.0", "6.19.7")
    assert doctor.mongo_kernel_conflict("7.0", "6.19.7") == ""   # 7.0 is unaffected
    assert doctor.mongo_kernel_conflict("8.0", "6.18.0") == ""   # older kernel is fine
    assert doctor.mongo_kernel_conflict("8.0", "") == ""         # unknown: do not guess
    assert doctor.mongo_kernel_conflict("", "6.19.7") == ""      # unknown: do not guess

    # And the create path refuses with it, before it touches docker.
    pulled: list = []
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.runner.host, "docker_kernel_version", lambda: "6.19.7-200.fc43")
    monkeypatch.setattr(lc.runner.paths, "exists", lambda n: False)
    monkeypatch.setattr(lc.runner.record, "write", lambda *a, **k: pulled.append("wrote"))
    monkeypatch.setattr(lc.versions, "resolve",
                        lambda v, offline=False: type("R", (), {
                            "rc_version": v, "mongo_tag": "8.0", "rc_image": "img",
                            "mongo_flavor": "mongodb", "mongo_shell": "mongosh",
                            "oplog": False, "source": "test", "note": ""})())
    with pytest.raises(errors.PreflightError) as caught:
        lc._create_repro_locked(lc.CreateReq(version="8.6.1"))
    assert "mongod 8.0 exits" in str(caught.value)
    assert caught.value.exit_code == 3, "a wrong environment is a preflight failure"
    assert not pulled, "it refused only AFTER starting work"


def test_doctor_warns_before_inotify_runs_out(tmp_path):
    """The symptom of this one points nowhere near its cause.

    With `fs.inotify.max_user_instances` exhausted, Traefik STARTS, stays up, logs
    "Cannot start the provider *file.Provider ... too many open files", and then
    serves its own default certificate to every request. That looks exactly like a
    broken route or a bad certificate and is neither -- it cost three full runs of an
    audit to find, which is precisely the kind of thing `doctor` exists to say first.

    It is also not hypothetical on a developer box: the limit is per-user, kind's own
    docs raise it for multi-cluster use, and it resets on reboot -- this host was
    raised to 1024 during the audit and was back to the 128 default afterwards.
    """
    from houston.services import doctor

    def at(limit, clusters, in_use=0):
        f = tmp_path / f"lim{limit}"
        f.write_text(str(limit))
        # `in_use` pinned: the verdict is about what is LEFT now, so leaving it unset
        # would read this machine's live consumption and make the thresholds below
        # depend on whatever else happens to be watching files while the suite runs.
        return doctor.inotify_headroom(clusters, path=str(f), in_use=in_use)

    # Plenty of room: say so, so the number is visible before it bites.
    assert at(4096, 1)[0][0] == "ok"

    # The kind default with several clusters is the failure that was actually hit.
    status, msg = at(128, 5)[0]
    assert status == "fail"
    assert "default certificate" in msg,         "name the symptom, or the reader cannot connect this to what they are seeing"
    assert "sysctl" in msg and "max_user_instances" in msg, "and give the fix"

    # Between need and 2x need is tight rather than broken.
    assert at(128, 2)[0][0] == "warn"

    # THE DEFECT: a limit high enough on paper, already spent. `in_use` was a parameter
    # the body never read, so this printed a green tick -- "inotify instances: 128 (~60
    # needed here)" -- while Traefik was failing with EMFILE and loading no dynamic
    # configuration at all. Measured on this box during the HTTPS work.
    status, msg = at(128, 1, in_use=120)[0]
    assert status == "fail", f"passed a limit with nothing left: {msg}"
    assert "in use" in msg, "say what is consuming it, or the number looks fine"

    # And consumption is reported even when the verdict is ok, so the margin is visible
    # before it closes.
    assert "in use" in at(4096, 1, in_use=30)[0][1]

    # Not Linux: the file is absent, and a limit that does not apply is not a finding.
    assert doctor.inotify_headroom(1, path=str(tmp_path / "absent")) == []
    # An unreadable/garbage value is silence too, never a crash in a diagnostic.
    bad = tmp_path / "garbage"
    bad.write_text("not-a-number")
    assert doctor.inotify_headroom(1, path=str(bad)) == []


def test_doctor_says_the_home_is_not_writable_rather_than_blaming_kind(monkeypatch,
                                                                       tmp_path):
    """A read-only HOUSTON_HOME passed `doctor` and surfaced as a kind problem.

    `home-perms` asks whether OTHER local users can read the accounts and sessions;
    nothing asked whether houston can write. So `list` and `doctor` exited 0 while
    `up` and `users add` raised a bare PermissionError -- and doctor's only mention of
    it was "Could not tell whether cluster 'houston-local' exists ([Errno 13]
    Permission denied) - kind needs Docker", because the error surfaced through the
    kind probe (which writes houston's own kubeconfig dir) and was attributed to
    Docker. The symptom was found and blamed on the wrong thing.
    """
    import os

    from houston.services import doctor as doctorsvc

    home = tmp_path / "ro-home"
    home.mkdir()
    os.chmod(home, 0o500)
    monkeypatch.setenv("HOUSTON_HOME", str(home))
    try:
        rows = doctorsvc.run_checks()["checks"]
    finally:
        os.chmod(home, 0o700)

    hits = [r for r in rows if r.get("check") == "home-writable"]
    assert hits, ("doctor reported no home-writable row on a home it cannot write: "
                  + str(sorted({r.get("check") for r in rows})))
    assert hits[0]["status"] == "fail", hits[0]
    assert "not writable" in hits[0]["message"], hits[0]["message"]
    assert "home-writable" in doctorsvc.CHECKS


def test_doctor_reports_on_the_cluster_up_would_actually_use(monkeypatch, tmp_path):
    """`doctor` must not become a second opinion about the boot.

    k8s.py:1117 records this as a bug already fixed once: `doctor` resolved the cluster
    itself and disagreed with `up` on a box with both kind and k3s -- it said "Using
    your cluster 'default'" while `up` built a kind cluster. Shipping `--context` on
    `up` alone recreates it for exactly the people who need it most, so `doctor` takes
    the same option and honours the same box default.
    """
    from houston import config
    from houston.services import doctor as doctorsvc
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    seen: list[str] = []

    def spy(context: str = ""):
        seen.append(context)
        return k8s.Preflight(tools={})

    monkeypatch.setattr(k8s.probe, "preflight", spy)

    doctorsvc.run_checks(context="eks-support")
    assert seen and seen[-1] == "eks-support", \
        "an explicit --context must reach the preflight `up` shares"

    seen.clear()
    config.update_config(
        lambda c: c.__setitem__(config.KUBE_CONTEXT_KEY, "eks-default"))
    doctorsvc.run_checks()
    assert seen and seen[-1] == "eks-default", \
        "the box default must reach doctor too, or it reports on a different cluster"

    seen.clear()
    doctorsvc.run_checks(context="explicit")
    assert seen and seen[-1] == "explicit", "an explicit context still wins"


def test_doctor_says_which_build_is_actually_answering(tmp_path, monkeypatch):
    """`__version__` comes from INSTALLED distribution metadata, so a stale editable
    install or a pipx that was never refreshed reports an old number while the
    checkout beside it holds the fix.

    Three shipped fixes looked ineffective for exactly that reason this week, and
    nothing in the tool said which build was answering.
    """
    from houston.services import doctor

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    rows = doctor.run_checks()["checks"]
    hit = [r for r in rows if r.get("check") == "install-fresh"]
    assert hit, [r.get("check") for r in rows]
    # This checkout is in step with its own install, which is the ok case.
    assert hit[0]["status"] == "ok", hit[0]
    assert "houston" in hit[0]["message"], hit[0]


    # The exception is RE-RAISED after being recorded, which is why pytest sees an
    # unhandled thread exception above: swallowing a BaseException is its own bug, and
    # the worker thread is ending either way. The warning is the cost of being honest.


def test_doctor_never_raises_out_of_a_bad_check_id():
    """A bare `assert` guarded a published contract.

    `doctor.CHECKS` is the registry of ids `doctor --json` publishes, and `line()`
    asserted membership. Asserts are stripped under `python -O`, so the guard vanishes
    exactly where a mis-declared id becomes unnoticeable -- and unstripped it raised
    AssertionError out of `GET /api/doctor`, which is a 500 and directly contradicts
    this function's own rule that a check must never break the report.
    """

    from houston.services import doctor as doctorsvc
    from houston.services.doctor.rows import Report

    # DRIVEN, not read. This used to grep `run_checks` for the fallback string, which
    # phase 2a moved into `Report.line` -- and a source grep that follows the code is a
    # source grep that will be pointed somewhere else again. Calling it cannot drift.
    report = Report()
    report.line("not-a-declared-id", "warn", "something happened")
    assert len(report.rows) == 1
    row = report.rows[0]
    # `preflight` exists for "the report itself could not be assembled", so it is the
    # honest place for a row whose own id is broken.
    assert row["check"] == "preflight" and "preflight" in doctorsvc.CHECKS
    assert "not-a-declared-id" in row["message"] and "something happened" in row["message"]
    assert "assert cid in CHECKS" not in source_of(Report.line), "still a bare assert"
