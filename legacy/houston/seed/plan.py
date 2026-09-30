"""plan -- see the package docstring."""
from __future__ import annotations

from dataclasses import dataclass, field
from houston.seed_profiles import PROFILES as PROFILES
from houston.seed_profiles import Shape as Shape

from houston.seed import wording
from houston.seed.kinds import ANCHOR_MESSAGES, CHANNEL, DISCUSSION, DM, GENERAL, PRIVATE, REACT_EVERY, TEAM, TEAM_CHANNEL, TEAM_CHANNEL_PRIVATE, TEAM_PRIVATE, _DISCUSSABLE, _PRIVATE_KINDS
from houston.seed.wording import _DISCUSSION_NAMES

@dataclass(frozen=True)
class RoomSpec:
    """One room, fully decided before anything is created."""

    kind: str
    name: str
    members: tuple[str, ...]
    messages: int
    #: Indexes of this room's messages that get one threaded reply each. A tuple
    #: rather than a count, so the readback knows WHICH message to look under.
    threads: tuple[int, ...] = ()
    #: Indexes of this room's messages that get a reaction. Planned rather than
    #: decided while posting, for the same reason as `threads`: a count nobody can
    #: predict is a count nobody can check, and reactions were the one part of a
    #: `rich` profile that did work -- so they were also the part with no evidence.
    reactions: tuple[int, ...] = ()
    #: A team's name for a team channel; the parent room's name for a discussion.
    parent: str = ""
    #: For a discussion: the index of the parent message it hangs off, or -1 for a
    #: discussion created against the room rather than against a message. Both are
    #: real paths in the product and they produce different system messages.
    from_message: int = -1

    @property
    def private(self) -> bool:
        return self.kind in _PRIVATE_KINDS

    @property
    def replies(self) -> int:
        return len(self.threads)

    @property
    def reacted(self) -> int:
        return len(self.reactions)

    @property
    def total_messages(self) -> int:
        """Messages that will exist in the room: the base ones, the replies, and the
        opening line of a discussion that was created from a message.

        A threaded reply IS a message in the room -- `channels.messages` returns it
        with a `tmid` -- so a count that omits it does not match what the server
        reports, which is exactly the mismatch a verifier would report as a fault.

        A discussion opened from a message is the same trap one level down: it
        arrives holding `ANCHOR_MESSAGES` before anyone posts into it, and leaving
        those out made every message-anchored discussion report more than planned on
        a perfectly good seed.
        """
        return (self.messages + self.replies
                + (ANCHOR_MESSAGES if self.from_message >= 0 else 0))

@dataclass(frozen=True)
class Plan:
    """The manifest: what will exist when seeding finishes."""

    profile: str
    users: int
    #: Standalone public channels. Kept as a top-level field because both
    #: front-ends print it in the "seeding N users, N channels" line.
    channels: int
    messages: int           # per room, before replies
    reactions: bool
    rooms: tuple[RoomSpec, ...] = ()

    @property
    def dms(self) -> int:
        return sum(1 for r in self.rooms if r.kind == DM)

    @property
    def rich(self) -> bool:
        """Kept for callers that ask whether this profile does threads/reactions."""
        return self.reactions

    @property
    def total_messages(self) -> int:
        return sum(r.total_messages for r in self.rooms)

    @property
    def total_replies(self) -> int:
        return sum(r.replies for r in self.rooms)

    def by_kind(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for r in self.rooms:
            out[r.kind] = out.get(r.kind, 0) + 1
        return out

    def named(self, name: str) -> RoomSpec | None:
        return next((r for r in self.rooms if r.name == name), None)

def _discussions_and_dms(add, names, rooms, shape):
    """The discussions hung off the rooms that can carry one, and the DMs between users."""
    parents = [r for r in rooms if r.kind in _DISCUSSABLE]
    for d in range(shape.discussions):
        if not parents:
            break
        parent = parents[d % len(parents)]
        # Alternating: half are opened FROM a message (which is how a support
        # engineer usually makes one, and which leaves a different system message
        # in the parent), half against the room itself.
        add(DISCUSSION, wording._pool_name(_DISCUSSION_NAMES, d, sep=" "), 3,
            max(2, shape.messages // 4),
            parent=parent.name, from_message=0 if d % 2 == 0 else -1)

    # Capped at the number of DISTINCT pairs: `im.create` for a pair that already has
    # a room returns that same room, so asking for five DMs from two users produced
    # five records pointing at one or two rooms -- and the verification then reported
    # rooms as short that were simply the same room counted twice.
    n = len(names)
    for i in range(min(shape.dms, n * (n - 1) // 2)):
        if n < 2:
            break
        a, b = wording.dm_pair(names, i)
        msgs = max(2, shape.messages // 5)
        rooms.append(RoomSpec(
            DM, f"{a}~{b}", (a, b), msgs, wording._threads(msgs),
            reactions=wording._threads(msgs, REACT_EVERY) if shape.reactions else ()))


def _channels_and_teams(add, names, rooms, shape):
    """The public and private channels, and the teams with their own channels inside."""
    for i in range(shape.channels):
        add(CHANNEL, wording.channel_name(i), 4, shape.messages)
    for i in range(shape.private):
        # Fewer messages: a private room's value here is that it EXISTS and is
        # invisible to a non-member, not that it is busy.
        add(PRIVATE, wording.private_name(i), 3, max(3, shape.messages // 2))
    for t in range(shape.teams):
        # Alternating, so any profile with two or more teams has one of each. A
        # private team is a different object from a private channel -- its main
        # room is type `p` AND it owns other rooms -- and only one of the two is
        # exercised by making every team public.
        tname = wording.team_name(t)
        add(TEAM if t % 2 == 0 else TEAM_PRIVATE, tname, 4, max(3, shape.messages // 2))
        for c in range(shape.team_channels):
            add(TEAM_CHANNEL if c % 2 == 0 else TEAM_CHANNEL_PRIVATE,
                wording.team_channel_name(t, c), 3, max(3, shape.messages // 2), parent=tname)
    # Everyone is already in `general`, so it is the one room where the whole user
    # list authors.
    rooms.append(RoomSpec(
        GENERAL, "general", tuple(names), shape.messages, wording._threads(shape.messages),
        reactions=wording._threads(shape.messages, REACT_EVERY) if shape.reactions else ()))


def _build(shape: Shape, names: list[str]) -> tuple[RoomSpec, ...]:
    """Turn a shape into the concrete list of rooms, in CREATION order.

    Order matters and is part of the manifest: a team exists before its channels,
    and every discussion's parent exists before the discussion. Sorting this list
    later would break seeding, so nothing does.
    """
    rooms: list[RoomSpec] = []
    idx = 0

    def add(kind: str, name: str, size: int, messages: int, **kw) -> RoomSpec:
        nonlocal idx
        spec = RoomSpec(kind=kind, name=name, members=wording._members(names, idx, size),
                        messages=messages, threads=wording._threads(messages),
                        reactions=wording._threads(messages, REACT_EVERY) if shape.reactions else (),
                        **kw)
        rooms.append(spec)
        idx += 1
        return spec

    _channels_and_teams(add, names, rooms, shape)

    _discussions_and_dms(add, names, rooms, shape)
    return tuple(rooms)

def plan_from(profile: str, users=None, channels=None, messages=None) -> Plan:
    if profile not in PROFILES:
        raise ValueError(
            f"unknown seed profile {profile!r} (want {' | '.join(PROFILES)})"
        )
    base = PROFILES[profile]
    shape = Shape(
        users=base.users if users is None else max(0, users),
        channels=base.channels if channels is None else max(0, channels),
        private=base.private, teams=base.teams, team_channels=base.team_channels,
        discussions=base.discussions, dms=base.dms,
        messages=base.messages if messages is None else max(0, messages),
        reactions=base.reactions,
    )
    names = [wording.username(i) for i in range(shape.users)]
    return Plan(profile=profile, users=shape.users, channels=shape.channels,
                messages=shape.messages, reactions=shape.reactions,
                rooms=_build(shape, names))

@dataclass
class _Made:
    """What actually got created, alongside the spec that asked for it."""

    spec: RoomSpec
    rid: str = ""
    team_id: str = ""
    reused: bool = False
    messages: int = 0
    replies: int = 0
    reactions: int = 0
    failed: str = ""
    message_ids: list[str] = field(default_factory=list)

@dataclass
class RoomFacts:
    """What the server says about one planned room."""

    spec: RoomSpec
    found: bool = False
    rid: str = ""
    messages: int = 0        # content messages, replies included
    replies: int = 0         # of those, the ones inside a thread
    reacted: int = 0         # of those, the ones carrying at least one reaction
    threads: int = 0         # parent messages that have a thread
    in_team: bool = True     # for a team channel: is it actually IN the team
    unreadable: str = ""     # why this room could not be checked at all
