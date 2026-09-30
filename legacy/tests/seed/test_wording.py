"""`houston.seed.wording`: its own spec file.

Co-located out of `tests/test_core.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from houston import seed


def test_seed_usernames_avoid_userN_collision():
    # ldap/saml presets use user1..userN; seed users must never collide.
    names = [seed.username(i) for i in range(60)]
    assert all(not n.startswith("user") for n in names)
    assert len(set(names)) == len(names)          # unique
    assert names[0] == "alice"


def test_seed_channel_names_unique():
    names = [seed.channel_name(i) for i in range(30)]
    assert len(set(names)) == len(names)


def test_dm_pairs_do_not_repeat_while_there_are_pairs_left():
    """`random.sample` drew with replacement across DMs, so the same pair could come
    up twice -- and the second `im.create` returns the SAME room, so a plan asking
    for five DM rooms could quietly produce four."""
    for n in (5, 6, 20):
        names = [seed.username(i) for i in range(n)]
        # The published bound: `gap == n / 2` on an even count folds back onto
        # pairs an earlier gap already produced, so it is (n-1)//2 bands, not n//2.
        pairs = [frozenset(seed.dm_pair(names, i)) for i in range(n * ((n - 1) // 2))]
        assert len(set(pairs)) == len(pairs), f"a pair repeated with {n} users"
        assert all(len(p) == 2 for p in pairs), "a pair must never be a user with itself"
    # And every profile stays inside it.
    for profile in ("small", "standard", "large"):
        plan = seed.plan_from(profile)
        dms = [r for r in plan.rooms if r.kind == seed.DM]
        assert len({frozenset(r.members) for r in dms}) == len(dms), profile
