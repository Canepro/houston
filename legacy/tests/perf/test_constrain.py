"""`houston.perf.constrain`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from corehelpers import _fake_run


def test_constrain_parse():
    from houston.perf import constrain
    c = constrain.parse("rc=2cpu/2g,mongo=0.5cpu/512m")
    assert c["rc"] == {"cpus": 2.0, "mem": "2g"}
    assert c["mongo"] == {"cpus": 0.5, "mem": "512m"}
    assert constrain.parse("rc=1cpu")["rc"] == {"cpus": 1.0, "mem": None}
    assert constrain.parse("mongo=1gb")["mongo"] == {"cpus": None, "mem": "1g"}
    for bad in ("rc", "rc=", "rc=fast", "rc=0cpu", "rc=2cpu/2parsecs"):
        try:
            constrain.parse(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {bad!r}")


def test_constrain_resolve_aliases():
    from houston.perf import constrain
    lim = {"cpus": 1.0, "mem": "1g"}
    # single-instance: rc -> rocketchat; mongo -> mongodb
    services = ["rocketchat", "mongodb", "mongo-init"]
    r = constrain.resolve_services({"rc": lim, "mongo": lim}, services)
    assert set(r) == {"rocketchat", "mongodb"}
    # multi-instance: rc expands to every instance
    multi = ["rocketchat-1", "rocketchat-2", "traefik", "nats", "mongodb"]
    r2 = constrain.resolve_services({"rc": lim}, multi)
    assert set(r2) == {"rocketchat-1", "rocketchat-2"}
    # exact service names pass through; unknown ones are actionable errors
    assert set(constrain.resolve_services({"traefik": lim}, multi)) == {"traefik"}
    try:
        constrain.resolve_services({"keycloak": lim}, services)
    except ValueError as exc:
        assert "keycloak" in str(exc)
    else:
        raise AssertionError("expected ValueError for unknown service")


def test_constrain_restore_never_raises(monkeypatch):
    # restore() runs inside the callers' finally; an OSError escaping it would
    # skip their remaining cleanup (deleting the seeded-user token file) and mask
    # whatever error triggered the finally. Report it, don't raise.
    from houston.perf import constrain

    def boom(*_a, **_k):
        raise FileNotFoundError("docker")

    monkeypatch.setattr(constrain.subprocess, "run", boom)
    monkeypatch.setattr(constrain.runner.host, "docker_capacity", lambda: (8.0, 8_000_000_000))
    problems = constrain.restore(
        [constrain.Applied("cid1", "rocketchat", 0, 0, 0, set_cpus=True)])
    assert len(problems) == 1 and "rocketchat" in problems[0]


def test_constrain_human():
    from houston.perf import constrain
    assert constrain.human({"rc": {"cpus": 2.0, "mem": "2g"},
                            "mongo": {"cpus": 0.5, "mem": None}}) == "rc=2cpu/2g, mongo=0.5cpu"


def test_constrain_restore_only_touches_capped_dimensions(monkeypatch):
    # A CPU-only --constrain must not make restore() impose a memory limit on a
    # container that had none (which, with --memory-swap == --memory, would also
    # disable swap) — restore only puts back what apply() actually changed.
    from houston.perf import constrain
    calls = []
    monkeypatch.setattr(constrain.subprocess, "run", _fake_run(calls))
    monkeypatch.setattr(constrain.runner.host, "docker_capacity", lambda: (8.0, 8_000_000_000))
    a = constrain.Applied("cid1", "rocketchat", 0, 0, 0, set_cpus=True, set_mem=False)
    assert constrain.restore([a]) == []
    assert calls == [["docker", "update", "--cpus", "8", "cid1"]]


def test_constrain_restore_reports_partial_failure(monkeypatch):
    # docker info unavailable, a real prior CPU limit but no prior memory limit:
    # the memory dimension can't be resolved. That must be REPORTED — it used to
    # be silent whenever the built command was non-empty, so the test's memory
    # cap stayed applied and the caller printed no warning.
    from houston.perf import constrain
    calls = []
    monkeypatch.setattr(constrain.subprocess, "run", _fake_run(calls))
    monkeypatch.setattr(constrain.runner.host, "docker_capacity", lambda: None)
    a = constrain.Applied("cid1", "rocketchat", 4_000_000_000, 0, 0,
                          set_cpus=True, set_mem=True)
    problems = constrain.restore([a])
    assert len(problems) == 1 and "memory" in problems[0]
    assert calls == [["docker", "update", "--cpus", "4", "cid1"]]   # CPU still restored


def test_constrain_restore_reproduces_implicit_swap_default(monkeypatch):
    # MemorySwap == 0 next to a real Memory limit is docker's "twice memory"
    # default, not "unknown". Restoring swap == memory would hand back a
    # STRICTER config (no swap) than the container started with.
    from houston.perf import constrain
    calls = []
    monkeypatch.setattr(constrain.subprocess, "run", _fake_run(calls))
    monkeypatch.setattr(constrain.runner.host, "docker_capacity", lambda: (8.0, 8_000_000_000))
    a = constrain.Applied("cid1", "mongodb", 0, 2_147_483_648, 0, set_cpus=False, set_mem=True)
    assert constrain.restore([a]) == []
    assert calls == [["docker", "update", "--memory", "2147483648",
                      "--memory-swap", "4294967296", "cid1"]]
    # an explicit prior swap limit round-trips verbatim; -1 stays unlimited
    for prior_swap, expected in ((3_000_000_000, "3000000000"), (-1, "-1")):
        calls.clear()
        constrain.restore([constrain.Applied("c", "mongodb", 0, 2_147_483_648, prior_swap,
                                             set_cpus=False, set_mem=True)])
        assert calls[0][-2] == expected


def test_constrain_inspect_limits_bad_output_is_runtime_error(monkeypatch):
    # Every call site catches RuntimeError; a ValueError from int() would escape
    # as a raw traceback (CLI) or an InternalError job (GUI).
    from houston.perf import constrain
    monkeypatch.setattr(constrain.subprocess, "run", _fake_run([], stdout="<no value>\n"))
    try:
        constrain._inspect_limits("cid1")
    except RuntimeError as exc:
        assert "cid1" in str(exc)
    else:
        raise AssertionError("expected RuntimeError for unparseable docker inspect output")
