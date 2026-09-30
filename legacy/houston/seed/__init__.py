"""A deterministic manifest of rooms, seeded over REST and read back against the plan.

Split by phase 02b step 2b.15 under `tools/move-table.json`'s reviewed map, into
tiers that cannot import upward:

    * `kinds` (tier 0)
    * `repairs` (tier 0)
    * `wording` (tier 1)
    * `plan` (tier 2)
    * `apply` (tier 3)
    * `check` (tier 4)

This file is the COMPATIBILITY SURFACE and holds no code of its own. Its
`__getattr__` deliberately does NOT cache: the suite patches the OWNING module
while production reads the façade, so a cached value is a value that stops seeing
the patch. Nothing in the suite may patch this module -- `monkeypatch.undo()`
restores by writing a REAL attribute here, which permanently shadows
`__getattr__` for every later test in the process.
"""
from __future__ import annotations

#: name -> the module that defines it, generated from the CURRENT tree by
#: `tools/move_table.py --sync-facade` and gated by `--check`.
_OWNER = {
    "ABSENT": "kinds",
    "ANCHOR_MESSAGES": "kinds",
    "CHANNEL": "kinds",
    "DISCUSSION": "kinds",
    "DM": "kinds",
    "GENERAL": "kinds",
    "PRIVATE": "kinds",
    "Plan": "plan",
    "REACT_EVERY": "kinds",
    "RoomFacts": "plan",
    "RoomSpec": "plan",
    "TEAM": "kinds",
    "TEAM_CHANNEL": "kinds",
    "TEAM_CHANNEL_PRIVATE": "kinds",
    "TEAM_PRIVATE": "kinds",
    "THREAD_EVERY": "kinds",
    "_CHANNEL_NAMES": "wording",
    "_DISCUSSABLE": "kinds",
    "_DISCUSSION_NAMES": "wording",
    "_EMOJI": "wording",
    "_FIRST_NAMES": "wording",
    "_MESSAGES": "wording",
    "_Made": "plan",
    "_PRIVATE_KINDS": "kinds",
    "_PRIVATE_NAMES": "wording",
    "_REPLIES": "wording",
    "_TEAM_CHANNEL_NAMES": "wording",
    "_TEAM_NAMES": "wording",
    "_build": "plan",
    "_channels_and_teams": "plan",
    "_collect_faults": "check",
    "_discussions_and_dms": "plan",
    "_fill_rooms": "apply",
    "_in_team": "wording",
    "_is_content": "wording",
    "_json": "apply",
    "_make_a_channel": "apply",
    "_make_dm": "apply",
    "_make_general": "apply",
    "_make_rooms": "apply",
    "_make_team_or_team_private": "apply",
    "_members": "wording",
    "_message_id": "apply",
    "_pool_name": "wording",
    "_quiesce_settings": "apply",
    "_read_discussion": "check",
    "_read_dm": "check",
    "_readers": "check",
    "_repair_email_2fa": "repairs",
    "_repair_rate_limiter": "repairs",
    "_repair_setting": "repairs",
    "_result": "apply",
    "_room_facts": "check",
    "_seed_body": "apply",
    "_send_replies": "apply",
    "_threads": "wording",
    "channel_name": "wording",
    "dm_pair": "wording",
    "install_journal_repairs": "repairs",
    "plan_from": "plan",
    "private_name": "wording",
    "readback": "check",
    "seed": "apply",
    "team_channel_name": "wording",
    "team_name": "wording",
    "username": "wording",
    "verify": "check",
}

#: Names the single file explicitly RE-EXPORTED -- `from houston.seed_profiles import
#: PROFILES as PROFILES`, the idiom that says "this is part of my surface". Callers read
#: them off `seed`, so the façade has to carry them or the re-export silently stops.
#: ...and the modules the single file imported, which the suite reaches the same way.
#: `seed.rcapi` was always `houston.rcapi`, so patching it was always patching that
#: module from wherever -- kept rather than re-pointed, because the object reached is
#: identical either way.
_ALIAS = {
    "PROFILES": "houston.seed_profiles:PROFILES",
    "Shape": "houston.seed_profiles:Shape",
    "rcapi": "houston.rcapi",
    "requests": "requests",
}


def __getattr__(name: str):
    """Resolve a name from the module that owns it, on EVERY access."""
    from importlib import import_module

    owner = _OWNER.get(name)
    if owner is not None:
        return getattr(import_module(f"{__name__}.{owner}"), name)
    if name in set(_OWNER.values()):
        return import_module(f"{__name__}.{name}")
    target = _ALIAS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module, _, attribute = target.partition(":")
    resolved = import_module(module)
    return getattr(resolved, attribute) if attribute else resolved


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_OWNER) | set(_ALIAS) | set(_OWNER.values()))
