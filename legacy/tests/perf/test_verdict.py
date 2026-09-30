"""`houston.perf.verdict`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from corehelpers import _facts
from houston import seed


def test_verdict_rules():
    from houston.perf import verdict
    base = {"p95": 120.0, "rps": 50.0, "error_rate": 0.0}
    # saturated event loop -> named finding
    v = verdict.analyze(base, rcmetrics={"rocketchat": {
        "eventloop_lag_s": {"mean": 0.3, "max": 1.2, "last": 0.9, "n": 5}}})
    assert any("event loop saturated" in f for f in v)
    # COLLSCAN -> missing index finding
    v2 = verdict.analyze(base, mongo={"total": 8, "collscan": 3, "slow": [
        {"ns": "rocketchat.rocketchat_message", "op": "query", "millis": 900,
         "plan": "COLLSCAN", "docs": 50000, "keys": 0, "ret": 20, "cmd": ""}]})
    assert any("COLLSCAN" in f and "missing index" in f for f in v2)
    # errors with 429s + timeline start time
    v3 = verdict.analyze({"p95": 100.0, "rps": 10.0, "error_rate": 0.2,
                          "status": {"429": 50}}, timeline={"first_error_s": 42})
    assert any("429" in f and "~42s" in f for f in v3)
    # histogram lag key preferred; degraded tier
    v5 = verdict.analyze(base, rcmetrics={"rocketchat": {
        "eventloop_lag_max_s": {"mean": 0.15, "max": 0.23, "last": 0.2, "n": 6}}})
    assert any("degraded" in f for f in v5)
    # high client latency with no server signal -> queueing finding, not "headroom"
    v6 = verdict.analyze({"p95": 1400.0, "rps": 15.0, "error_rate": 0.0})
    assert any("queueing outside" in f for f in v6)
    # clean run -> headroom statement
    v4 = verdict.analyze(base)
    assert len(v4) == 1 and "headroom" in v4[0]


def test_verdict_spike_and_soak_rules():
    from houston.perf import verdict
    base = {"p95": 120.0, "rps": 50.0, "error_rate": 0.0}
    v = verdict.analyze(base, spike={"baseline_p95": 100.0, "spike_p95": 900.0,
                                     "recovered_after_s": None})
    assert any("Did not recover" in f for f in v)
    v2 = verdict.analyze(base, soak={"rocketchat": 75e6})
    assert any("75MB/h" in f and "leak" in f for f in v2)
    v3 = verdict.analyze(base, spike={"baseline_p95": 100.0, "spike_p95": 900.0,
                                      "recovered_after_s": 4})
    assert len(v3) == 1 and "headroom" in v3[0]   # quick recovery isn't a finding


def test_verdict_refuses_to_judge_an_unmeasured_run():
    from houston.perf import verdict
    # A run that issued no requests emits no latency keys at all (handleSummary
    # drops undefined values). It used to render as a measured 0ms and end in
    # "the workspace has headroom at this load" -- a health claim from no data.
    zero = {"rps": 0, "count": 0, "error_rate": 0, "checks_rate": None,
            "status": {"2xx": 0, "429": 0, "4xx": 0, "5xx": 0, "other": 0}}
    for summary in (zero, {}):
        v = verdict.analyze(summary)
        assert len(v) == 1
        assert "No requests were recorded" in v[0]
        assert "headroom" not in v[0]


def test_a_clean_seed_verifies_clean():
    plan = seed.plan_from("small")
    verdict = seed.verify(plan, _facts(plan))
    assert verdict["ok"] is True
    assert verdict["faults"] == [] and verdict["extra"] == []
    assert verdict["checked"] == len(plan.rooms)


def test_more_content_than_planned_is_not_a_fault():
    """Seeding only ever ADDS, so a room holding more than this run planned cannot
    be evidence that this run lost anything: it had content already, which is what a
    second `houston seed`, a preset that posts on boot, or a restored backup all
    look like.

    Gating on exact equality is precisely what made an earlier version of this idea
    refuse a workspace that was working, and a check that fails when nothing is
    wrong is one people learn to bypass.
    """
    plan = seed.plan_from("small")
    facts = _facts(plan)
    facts["rooms"][0].messages += 40
    verdict = seed.verify(plan, facts)
    assert verdict["ok"] is True, verdict["faults"]
    assert len(verdict["extra"]) == 1
    assert verdict["extra"][0]["room"] == plan.rooms[0].name


def test_fewer_messages_than_planned_is_a_fault():
    plan = seed.plan_from("small")
    facts = _facts(plan)
    facts["rooms"][0].messages -= 1
    verdict = seed.verify(plan, facts)
    assert verdict["ok"] is False
    assert verdict["faults"][0]["kind"] == "messages"
    assert verdict["faults"][0]["got"] == plan.rooms[0].total_messages - 1


def test_a_room_that_could_not_be_read_is_a_gap_in_the_check_not_a_fault():
    """One 500 on a listing must not fail an otherwise perfect seed. The version of
    this that required `not unavailable` for a pass did exactly that."""
    plan = seed.plan_from("small")
    facts = _facts(plan)
    facts["rooms"][1].unreadable = "HTTP 500"
    verdict = seed.verify(plan, facts)
    assert verdict["ok"] is True
    assert verdict["unreadable"] == [{"what": plan.rooms[1].name, "why": "HTTP 500"}]


def test_a_room_that_is_absent_is_a_fault_even_though_the_lookup_failed():
    """Rocket.Chat answers a lookup for a deleted room with HTTP 400 and
    `error-room-not-found`. That is an ANSWER, not a failure to ask -- and filing it
    under "could not read" made a workspace with a missing room verify clean. Found
    live, by deleting one and watching the check pass.
    """
    plan = seed.plan_from("small")
    facts = _facts(plan)
    facts["rooms"][0].found = False
    facts["rooms"][0].unreadable = ""       # what ABSENT leaves behind
    verdict = seed.verify(plan, facts)
    assert verdict["ok"] is False
    assert verdict["faults"][0]["kind"] == "missing"


def test_a_team_channel_that_is_not_in_its_team_is_a_fault():
    """A channel can exist and not be in the team, which looks identical from
    `channels.info` -- and is the whole difference between a team workspace and a
    workspace with similarly-named channels."""
    plan = seed.plan_from("small")
    facts = _facts(plan)
    room = next(f for f in facts["rooms"] if f.spec.kind == seed.TEAM_CHANNEL)
    room.in_team = False
    verdict = seed.verify(plan, facts)
    assert any(f["kind"] == "team" for f in verdict["faults"])


def test_fewer_reactions_than_planned_is_a_fault():
    plan = seed.plan_from("standard")
    facts = _facts(plan)
    facts["rooms"][0].reacted -= 1
    verdict = seed.verify(plan, facts)
    assert verdict["ok"] is False
    assert verdict["faults"][0]["kind"] == "reactions"
