"""wording -- see the package docstring."""
from __future__ import annotations

from houston.seed_profiles import PROFILES as PROFILES
from houston.seed_profiles import Shape as Shape

from houston.seed.kinds import THREAD_EVERY

# Realistic pools; overflow gets a numeric suffix (e.g. alice, bob, …, alice2).
# NOTE: deliberately avoids `userN` names, which the ldap/saml presets use.
_FIRST_NAMES = [
    "alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi",
    "ivan", "judy", "mallory", "niaj", "olivia", "peggy", "quinn", "rupert",
    "sybil", "trent", "uma", "victor", "wendy", "xavier", "yvonne", "zack",
]

_CHANNEL_NAMES = [
    "team-chat", "dev", "support", "random", "announcements", "design",
    "qa", "ops", "product", "sales", "incidents", "watercooler",
]

_PRIVATE_NAMES = ["leadership", "private-project", "security", "hiring"]

_TEAM_NAMES = ["platform", "customer-success", "infrastructure"]

_TEAM_CHANNEL_NAMES = ["planning", "standup", "incidents", "releases"]

_DISCUSSION_NAMES = [
    "customer escalation 4821", "rollback plan", "release checklist",
    "post-mortem draft", "capacity for Q3", "onboarding questions",
]

_MESSAGES = [
    "Hey team, any update on this?",
    "Can someone review my PR when you get a chance?",
    "Deploying to staging now 🚀",
    "Heads up: maintenance window tonight at 10pm.",
    "Thanks, that fixed it!",
    "I'm seeing the same issue on my end.",
    "Let's sync about this in standup.",
    "Docs are updated, please take a look.",
    "Good morning! What's on the agenda today?",
    "Anyone free for a quick call?",
    "Ticket #4821 is resolved.",
    "Nice work everyone 👏",
    "Reminder: submit your timesheets.",
    "Rolling back the last change, it broke the build.",
    "LGTM ✅",
    "Where did we land on the pricing question?",
]

_REPLIES = [
    "Good catch — looking now.",
    "Same here, reproduced on 8.5.1.",
    "Fixed in the branch, pushing shortly.",
    "Can you share the log line?",
    "Agreed, let's do that.",
]

_EMOJI = [":+1:", ":tada:", ":eyes:", ":rocket:"]

def username(i: int) -> str:
    base = _FIRST_NAMES[i % len(_FIRST_NAMES)]
    grp = i // len(_FIRST_NAMES)
    return base if grp == 0 else f"{base}{grp + 1}"

def _pool_name(pool: list[str], i: int, sep: str = "-") -> str:
    base = pool[i % len(pool)]
    grp = i // len(pool)
    return base if grp == 0 else f"{base}{sep}{grp + 1}"

def channel_name(i: int) -> str:
    return _pool_name(_CHANNEL_NAMES, i)

def private_name(i: int) -> str:
    return _pool_name(_PRIVATE_NAMES, i)

def team_name(i: int) -> str:
    return _pool_name(_TEAM_NAMES, i)

def team_channel_name(team_i: int, i: int) -> str:
    """Prefixed with the team, because a channel name is unique workspace-wide.

    Two teams both wanting `planning` is the common case, and the second create
    would fail with a name clash rather than producing the second team's channel.
    """
    return f"{team_name(team_i)}-{_pool_name(_TEAM_CHANNEL_NAMES, i)}"

def _members(names: list[str], index: int, size: int) -> tuple[str, ...]:
    """A rotating window over the user list: deterministic, and varied per room.

    `random.sample` gave a different membership on every run, which is why nothing
    downstream could state what a room would contain. The stride of 3 keeps
    consecutive rooms from having identical membership without needing randomness.
    """
    if not names:
        return ()
    size = max(1, min(size, len(names)))
    return tuple(names[(index * 3 + j) % len(names)] for j in range(size))

def _threads(messages: int, every: int = THREAD_EVERY) -> tuple[int, ...]:
    return tuple(range(0, messages, every)) if messages else ()

def dm_pair(names: list[str], i: int) -> tuple[str, str]:
    """The i-th DM pair, walking increasing gaps so no pair repeats early.

    `random.sample(names, 2)` drew with replacement across DMs, so the same pair
    could be picked twice -- and the second `im.create` returns the SAME room, so a
    plan asking for five DM rooms could produce four.

    Walking `gap` gives `n * ((n - 1) // 2)` distinct pairs before any repeats. The
    bound is not `n * (n // 2)`: at `gap == n / 2` on an even user count the pair
    {a, a + gap} is the same unordered pair as {a + gap, a}, so that last band of
    gaps yields half as many. No profile comes near the limit -- `large` asks for 20
    DMs from 100 users, where the bound is 4,950 -- but a caller passing --users 4
    with 20 DMs would, and it should get repeats rather than a wrong promise.
    """
    n = len(names)
    # The gap wraps within 1..n-1 so it can never be a multiple of n, because a gap
    # of 0 pairs a user WITH THEMSELVES -- `im.create` accepts that and makes a
    # self-DM, which is a real Rocket.Chat object and not what a plan asking for a
    # conversation between two people meant. It appeared the moment `--users 2` was
    # passed with the default five DMs.
    gap = 1 + (i // n) % (n - 1)
    a = i % n
    return names[a], names[(a + gap) % n]

#: A message with one of these is the SERVER talking about the room, not a person
#: talking in it. Rather than list them (there are dozens -- `uj`, `au`, `ru`,
#: `room_changed_topic`, `discussion-created`, ...), anything carrying a `t` at all
#: is treated as a system message, which is what the client does to decide whether
#: to render it as a grey line.
def _is_content(message: dict) -> bool:
    return not message.get("t")

def _in_team(get, hdr, team_name_: str, room_name: str) -> bool:
    body, _ = get("/api/v1/teams.info", hdr, teamName=team_name_)
    team_id = ((body or {}).get("teamInfo") or {}).get("_id")
    if not team_id:
        return False
    rooms, _ = get("/api/v1/teams.listRooms", hdr, teamId=team_id, count=100)
    return any(r.get("name") == room_name for r in ((rooms or {}).get("rooms") or []))
