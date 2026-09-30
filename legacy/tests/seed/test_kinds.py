"""`houston.seed.kinds`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from corehelpers import _facts
from houston import seed


def test_every_profile_contains_every_kind_of_room():
    """Support tickets are rarely about a public channel. They are about a
    discussion inside a private team channel, or a thread nobody else can see -- so
    `small` carries one of each rather than being a scaled-down `standard`."""
    for profile in ("small", "standard", "large"):
        kinds = set(seed.plan_from(profile).by_kind())
        for kind in (seed.CHANNEL, seed.PRIVATE, seed.TEAM, seed.TEAM_CHANNEL,
                     seed.TEAM_CHANNEL_PRIVATE, seed.DISCUSSION, seed.DM,
                     seed.GENERAL):
            assert kind in kinds, f"{profile} has no {kind}"
    # And both team visibilities appear as soon as there are two teams.
    assert seed.TEAM_PRIVATE in seed.plan_from("standard").by_kind()


def test_a_planned_thread_is_counted_as_a_message_in_its_room():
    """A threaded reply IS a message in the room -- `channels.messages` returns it
    with a `tmid` -- so a plan that omits it cannot match what the server reports,
    and every room would verify as short by the number of its threads."""
    plan = seed.plan_from("small")
    room = next(r for r in plan.rooms if r.kind == seed.CHANNEL)
    assert room.threads == tuple(range(0, room.messages, seed.THREAD_EVERY))
    assert room.total_messages == room.messages + len(room.threads)


def test_a_discussion_that_lost_its_anchor_is_a_fault():
    """The `pmid` variant was dead code for a while: discussions were created before
    their parents had posted anything, so the branch could never fire and every
    discussion came out attached to the room instead. Nothing noticed.

    It is caught by the message count rather than by a check of its own, and that is
    deliberate: a discussion opened from a message arrives holding ANCHOR_MESSAGES it
    did not post, so a `pmid` that stops being sent makes the room come back exactly
    that much short -- which is a fault, named by room.
    """
    plan = seed.plan_from("standard")
    anchored = next(r for r in plan.rooms
                    if r.kind == seed.DISCUSSION and r.from_message >= 0)
    plain = next(r for r in plan.rooms
                 if r.kind == seed.DISCUSSION and r.from_message < 0)
    assert anchored.total_messages - plain.total_messages == seed.ANCHOR_MESSAGES

    facts = _facts(plan)
    lost = next(f for f in facts["rooms"] if f.spec is anchored)
    lost.messages -= seed.ANCHOR_MESSAGES          # what an un-anchored one looks like
    verdict = seed.verify(plan, facts)
    assert verdict["ok"] is False
    assert verdict["faults"][0]["room"] == anchored.name
