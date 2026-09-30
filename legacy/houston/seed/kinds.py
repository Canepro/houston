"""kinds -- see the package docstring."""
from __future__ import annotations

from houston.seed_profiles import PROFILES as PROFILES
from houston.seed_profiles import Shape as Shape


#: One message in every N gets a thread reply. A fixed stride rather than a
#: probability, so the plan can state how many replies there will be -- and so the
#: readback can tell "the thread was not created" from "the dice said no".
THREAD_EVERY = 5

#: And one in every N gets a reaction, on the profiles that ask for them.
REACT_EVERY = 3

#: What a discussion created FROM a message starts with, before anyone posts into
#: it: Rocket.Chat copies the parent message in as the discussion's anchor -- it
#: comes back with an empty `msg` and no `t`, so a message listing counts it as
#: content -- and the `reply` we send alongside becomes the first real line.
#:
#: MEASURED, on live 7.4.1 and 8.5.1, not assumed: the first guess was one, and the
#: room held two. It is stated here rather than absorbed into a fudge factor because
#: a plan that cannot say what a room will contain is the thing this module exists
#: to stop being.
#:
#: 6.x was deliberately not measured -- it is out of support, and a floor nobody
#: runs is a claim nobody can maintain. If the number ever differs on a future
#: release the room reads as holding MORE than planned, which is reported and not a
#: fault, so an unmeasured version degrades quietly rather than failing.
ANCHOR_MESSAGES = 2

# --- the room kinds -----------------------------------------------------------
#: Every shape of room Rocket.Chat has, because every one of them is something a
#: customer files a ticket about. The kind decides which endpoint creates it and
#: which endpoint reads it back; nothing else in this module branches on it.
CHANNEL = "channel"                              # public, standalone

PRIVATE = "private"                              # private, standalone

TEAM = "team"                                    # a public team's main room

TEAM_PRIVATE = "team-private"                    # a private team's main room

TEAM_CHANNEL = "team-channel"                    # public channel inside a team

TEAM_CHANNEL_PRIVATE = "team-channel-private"    # private channel inside a team

DISCUSSION = "discussion"                        # a child room of a parent room

DM = "dm"

GENERAL = "general"                              # the room every workspace ships

#: Kinds whose rooms a discussion may hang off. `general` is excluded on purpose:
#: it is the one room a reader will already be looking at, and burying the seeded
#: discussions there makes them hard to find rather than easy.
_DISCUSSABLE = (CHANNEL, PRIVATE, TEAM, TEAM_PRIVATE, TEAM_CHANNEL,
                TEAM_CHANNEL_PRIVATE)

#: Which kinds are private, for the readback (`groups.*` vs `channels.*`) and for
#: anything that wants to say so on screen.
_PRIVATE_KINDS = (PRIVATE, TEAM_PRIVATE, TEAM_CHANNEL_PRIVATE)

#: `get()`'s answer for "the server says this room does not exist", as opposed to
#: "the server could not be asked". One is a fault and the other is a gap in the
#: check, and they must never be the same value.
ABSENT = "<absent>"
