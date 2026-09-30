"""`houston.seed.plan`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import rcapi
from houston import seed


# --- seed ---------------------------------------------------------------------


def test_seed_profile_and_overrides():
    p = seed.plan_from("standard")
    assert (p.users, p.channels, p.messages, p.rich) == (20, 5, 20, True)
    p2 = seed.plan_from("standard", users=3, messages=1)
    assert p2.users == 3 and p2.messages == 1 and p2.channels == 5  # override + inherit
    # An override reshapes the MANIFEST, not just the counts: three users means
    # every room's membership is drawn from three names.
    assert all(set(r.members) <= {"alice", "bob", "carol"} for r in p2.rooms)


# --- the seed manifest --------------------------------------------------------
#
# A plan used to be four numbers and everything else was `random`. It is a MANIFEST
# now -- every room named, every membership decided, every message counted before
# the first HTTP call -- and these hold that line, because the readback below is
# only meaningful if the plan is something a workspace can be compared against.

def test_the_seed_manifest_is_the_same_every_time():
    """Two runs of one profile must produce the same workspace. Without it, a
    customer's ticket and the reproduction of it cannot be compared, and nothing can
    be read back and checked -- a plan of counts has nothing to check against."""
    a, b = seed.plan_from("standard"), seed.plan_from("standard")
    assert a.rooms == b.rooms
    assert [r.members for r in a.rooms] == [r.members for r in b.rooms]
    assert a.total_messages == b.total_messages


def test_seed_profile_strict():
    try:
        seed.plan_from("larg")   # typo must not silently seed `small`
    except ValueError as exc:
        assert "unknown seed profile" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_seed_returns_durations_and_latency(monkeypatch):
    # drive the seed body with a mock poster; no server needed.
    from unittest.mock import MagicMock
    from houston import seed
    # The mock has to answer a room CREATE as well as a message post: messages go
    # by `rid` now, because a discussion's name is a server-generated slug and
    # `#name` cannot reach one.
    resp = MagicMock(ok=True)
    resp.json.return_value = {"message": {"_id": "m"}, "channel": {"_id": "r1"},
                              "group": {"_id": "r1"}, "room": {"_id": "r1"},
                              "team": {"_id": "t1", "roomId": "r1"}}
    post = MagicMock(return_value=resp)
    plan = seed.plan_from("small", users=2, channels=1, messages=3)
    monkeypatch.setattr(rcapi, "login", lambda *a, **k: (_ for _ in ()).throw(Exception("no server")))
    out = seed._seed_body("http://x", {"h": "1"}, plan, post, lambda m: None)
    assert set(out["durations"]) == {"users", "channels", "messages", "dms"}
    assert out["latency"]["count"] >= 1   # message latencies collected


def test_seed_does_not_count_failed_dms():
    class _Resp:
        def __init__(self, ok):
            self.ok, self.status_code = ok, 200 if ok else 400

        def json(self):
            return {"message": {"_id": "m1"}}

    # every im.create is rejected (revoked create-d permission, DM max users)
    def post(path, _headers, _payload):
        return _Resp(not path.endswith("im.create"))

    plan = seed.plan_from("small", users=3, channels=1, messages=1)
    out = seed._seed_body("http://x", {"h": "1"}, plan, post, lambda _m: None)
    # was 3: post() returns None only on a TRANSPORT error, so a 400 still counted
    # and the number reached the performance report as workload never created.
    assert out["dms"] == 0


def test_a_discussion_hangs_off_a_room_that_exists_first():
    """Creation order is part of the manifest: a team before its channels, a parent
    before its discussions. Nothing sorts this list later, because sorting it would
    break seeding."""
    plan = seed.plan_from("standard")
    seen: set[str] = set()
    for room in plan.rooms:
        if room.parent:
            assert room.parent in seen, f"{room.name} is created before {room.parent}"
        seen.add(room.name)


def test_two_teams_do_not_fight_over_one_channel_name():
    """A channel name is unique workspace-wide, so two teams both wanting `planning`
    would collide and the second team would come out empty."""
    plan = seed.plan_from("large")
    names = [r.name for r in plan.rooms]
    assert len(names) == len(set(names))
    team_channels = [r.name for r in plan.rooms if r.kind.startswith("team-channel")]
    assert all("-" in n for n in team_channels)


def test_a_thread_reply_is_posted_the_only_way_that_creates_a_thread():
    """The defect this exists for: `chat.postMessage` with a `tmid` answers 400, so
    every reply this module attempted was silently lost and no thread was ever
    created -- while the `rich` profiles advertised threads and reactions and
    delivered reactions.

    Asserted on the CALL SHAPE, because that is what was wrong: the server said no
    and the seeder counted it as a message it had failed to post, so nothing
    downstream noticed for as long as the feature existed.
    """
    calls: list[tuple[str, dict]] = []

    class _Resp:
        ok, status_code = True, 200

        @staticmethod
        def json():
            return {"message": {"_id": "m1"}, "channel": {"_id": "r1"},
                    "group": {"_id": "r1"}, "room": {"_id": "r1"},
                    "team": {"_id": "t1", "roomId": "r1"}}

    def post(path, _headers, payload):
        calls.append((path, payload))
        return _Resp()

    plan = seed.plan_from("small", users=2, channels=1, messages=5)
    seed._seed_body("http://x", {"h": "1"}, plan, post, lambda _m: None)
    threaded = [p for path, p in calls
                if path.endswith("chat.sendMessage") and (p.get("message") or {}).get("tmid")]
    assert threaded, "no threaded reply was posted at all"
    assert all("rid" in p["message"] for p in threaded), "a thread reply needs its room"
    assert not [p for path, p in calls if path.endswith("chat.postMessage")], \
        "chat.postMessage cannot create a thread and is not used for messages any more"


def test_reactions_are_planned_rather_than_decided_while_posting():
    """They were the one part of a `rich` profile that worked, which made them the
    part with no evidence: `i % 3 == 0` lived in the posting loop, so nothing could
    say how many there should be and nothing checked how many there were."""
    rich = seed.plan_from("standard")
    room = next(r for r in rich.rooms if r.kind == seed.CHANNEL)
    assert room.reactions == tuple(range(0, room.messages, seed.REACT_EVERY))
    assert room.reacted == len(room.reactions)
    # `small` asks for none, and plans none.
    assert all(r.reactions == () for r in seed.plan_from("small").rooms)


def test_the_seeder_reacts_exactly_where_the_manifest_says(monkeypatch):
    calls: list[tuple[str, dict]] = []

    class _Resp:
        ok, status_code = True, 200

        @staticmethod
        def json():
            return {"message": {"_id": "m1"}, "channel": {"_id": "r1"},
                    "group": {"_id": "r1"}, "room": {"_id": "r1"},
                    "team": {"_id": "t1", "roomId": "r1"}}

    def post(path, _headers, payload):
        calls.append((path, payload))
        return _Resp()

    # `general` is LOOKED UP rather than created (every workspace ships it), and the
    # lookup is a GET rather than the injected `post` -- so without this the one room
    # every user is in gets no rid and no messages, and the totals are quietly short.
    monkeypatch.setattr(seed.requests, "get", lambda *a, **k: _Resp())
    plan = seed.plan_from("standard", users=2, channels=1, messages=6)
    seed._seed_body("http://x", {"h": "1"}, plan, post, lambda _m: None)
    reacts = [p for path, p in calls if path.endswith("chat.react")]
    assert reacts, "a rich profile that reacts nowhere"
    assert all("messageId" in p and "emoji" in p for p in reacts)
    # One per planned index per room, and not one per message.
    assert len(reacts) == sum(r.reacted for r in plan.rooms)
