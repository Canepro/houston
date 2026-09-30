"""check -- see the package docstring."""
from __future__ import annotations

import requests
from houston import rcapi
from houston.seed_profiles import PROFILES as PROFILES
from houston.seed_profiles import Shape as Shape

from houston.seed import apply
from houston.seed import wording
from houston.seed.kinds import ABSENT, DISCUSSION, DM, TEAM_CHANNEL, TEAM_CHANNEL_PRIVATE
from houston.seed.plan import Plan, RoomFacts

def _read_discussion(count_messages, f, facts, get, hdr, rids, spec):
    """Read a discussion back: it is not found the way a channel is."""
    prid = rids.get(spec.parent)
    if not prid:
        # The parent's own row already says whether it is absent or merely
        # unreadable; repeating the guess here would double-count one fault.
        parent = next((x for x in facts if x.spec.name == spec.parent), None)
        if parent is not None and not parent.found and not parent.unreadable:
            return
        f.unreadable = f"parent {spec.parent!r} not readable"
        return
    body, why = get("/api/v1/chat.getDiscussions", hdr, roomId=prid, count=100)
    if body is None:
        if why != ABSENT:
            f.unreadable = why
        return
    # Matched on the DISPLAY name: `rooms.createDiscussion` gives the room a
    # generated slug for its `name` and puts the title in `fname`, so a
    # readback keyed on the name it was asked for finds nothing at all.
    for m in (body.get("messages") or []):
        if m.get("msg") == spec.name:
            f.found, f.rid = True, m.get("drid", "")
            break
    if f.rid:
        path = ("/api/v1/groups.messages" if spec.private
                else "/api/v1/channels.messages")
        f.messages, f.replies, f.reacted, f.unreadable = count_messages(
            f.rid, path, hdr)


def _read_dm(as_user, count_messages, f, get, spec):
    """Read a dm back: it is not found the way a channel is."""
    headers = as_user(spec.members[0])
    if headers is None:
        f.unreadable = f"cannot sign in as {spec.members[0]}"
        return
    body, why = get("/api/v1/im.list", headers, count=0)
    if body is None:
        f.unreadable = why
        return
    for room in (body.get("ims") or body.get("update") or []):
        if spec.members[1] in (room.get("usernames") or []):
            f.found, f.rid = True, room.get("_id", "")
            break
    if f.rid:
        f.messages, f.replies, f.reacted, f.unreadable = count_messages(
            f.rid, "/api/v1/im.messages", headers)


def _room_facts(as_user, count_messages, facts, get, hdr, plan, rids):
    """Read every planned room back, and say what is actually in it."""
    for spec in plan.rooms:
        f = RoomFacts(spec=spec)
        facts.append(f)
        if spec.kind == DM:
            _read_dm(as_user, count_messages, f, get, spec)
            continue
        if spec.kind == DISCUSSION:
            _read_discussion(count_messages, f, facts, get, hdr, rids, spec)
            continue
        info_path = "/api/v1/groups.info" if spec.private else "/api/v1/channels.info"
        body, why = get(info_path, hdr, roomName=spec.name)
        if body is None:
            if why != ABSENT:
                f.unreadable = why
            continue
        room = body.get("channel") or body.get("group") or {}
        f.rid = room.get("_id", "")
        f.found = bool(f.rid)
        if not f.found:
            continue
        rids[spec.name] = f.rid
        msg_path = "/api/v1/groups.messages" if spec.private else "/api/v1/channels.messages"
        f.messages, f.replies, f.reacted, f.unreadable = count_messages(
            f.rid, msg_path, hdr)
        tl, why = get("/api/v1/chat.getThreadsList", hdr, rid=f.rid, count=100)
        if tl is not None:
            f.threads = int(tl.get("total") or 0)
        if spec.parent and spec.kind in (TEAM_CHANNEL, TEAM_CHANNEL_PRIVATE):
            # A channel can exist and NOT be in the team, which looks identical from
            # `channels.info` and is the whole difference between a team workspace
            # and a workspace with similarly-named channels.
            f.in_team = wording._in_team(get, hdr, spec.parent, spec.name)


def _readers(base, cache, login, root_url, session):
    """The three reads this needs, sharing one session and one cache of what was asked."""
    def get(path: str, headers: dict, **params):
        """(body, why). `why` is "" on success and `ABSENT` when the room is gone.

        Rocket.Chat answers a lookup for a room that does not exist with HTTP 400
        and `errorType: error-room-not-found`, which is an ANSWER, not a failure to
        ask -- and the difference is the whole verdict. Treating it as "could not
        read" filed a deleted room under `unreadable`, where nothing counts it as a
        fault, so a workspace missing a room verified clean. Found live, by deleting
        one and watching the check pass.
        """
        try:
            r = session.get(f"{base}{path}", headers=headers, params=params, timeout=30)
        except requests.RequestException as exc:
            return None, str(exc)
        if not r.ok:
            body = apply._json(r)
            if r.status_code in (400, 404) and "not-found" in str(body.get("errorType", "")):
                return None, ABSENT
            return None, f"HTTP {r.status_code}"
        return apply._json(r), ""

    def as_user(name: str) -> dict | None:
        if name not in cache:
            try:
                cache[name] = {**login(root_url, name, name).headers(),
                               "Content-Type": "application/json"}
            except Exception:  # noqa: BLE001 - reported as unreadable, never a fault
                cache[name] = {}
        return cache[name] or None

    def count_messages(rid: str, path: str, headers: dict) -> tuple[int, int, int, str]:
        """(content messages, replies, reacted, why).

        All three come out of ONE listing: a reacted message carries a `reactions`
        object and a reply carries a `tmid`, so asking per message would be N calls
        for facts the room already handed over.
        """
        body, why = get(path, headers, roomId=rid, count=0)
        if body is None:
            return 0, 0, 0, why
        msgs = [m for m in (body.get("messages") or []) if wording._is_content(m)]
        return (len(msgs),
                sum(1 for m in msgs if m.get("tmid")),
                sum(1 for m in msgs if m.get("reactions")),
                "")
    return as_user, count_messages, get


def readback(root_url, admin: rcapi.Auth, plan: Plan,
             login=rcapi.login, tokens: dict | None = None) -> dict:
    """Re-read the seeded workspace and report what is actually there.

    Reads as the ADMIN wherever the admin can see the room, and as a participant
    where it cannot: a direct message belongs to its two users and is invisible to
    everyone else, so a readback that only used the admin token would report every
    DM missing.

    `tokens` are the sessions the SEEDER already minted, and passing them is not an
    optimisation. Seeding turns email-2FA off for its own logins and turns it back
    on afterwards -- so by the time this runs, signing in as a user needs a code
    from a mailbox that does not exist, and every DM comes back "cannot sign in".
    On a workspace with 2FA off the fallback login works and this can be called on
    its own. `login` is injectable so a test does not need a server.
    """
    base = root_url.rstrip("/")
    session = requests.Session()
    hdr = {**admin.headers(), "Content-Type": "application/json"}
    cache: dict[str, dict] = {
        name: {**auth.headers(), "Content-Type": "application/json"}
        for name, auth in (tokens or {}).items()}

    as_user, count_messages, get = _readers(base, cache, login, root_url, session)

    facts: list[RoomFacts] = []
    rids: dict[str, str] = {}
    _room_facts(as_user, count_messages, facts, get, hdr, plan, rids)

    users, why = get("/api/v1/users.list", hdr, count=0)
    known = ({u.get("username") for u in (users.get("users") or [])}
             if users is not None else set())
    planned_users = [wording.username(i) for i in range(plan.users)]
    return {
        "rooms": facts,
        "users_found": sorted(u for u in planned_users if u in known),
        "users_unreadable": why if users is None else "",
        "planned_users": planned_users,
    }

def _collect_faults(extra, facts, faults, unreadable):
    """Every way what is there can differ from what the plan asked for."""
    def fault(kind: str, name: str, want, got, detail: str = "") -> None:
        faults.append({"kind": kind, "room": name, "want": want, "got": got,
                       "detail": detail})

    def counted(kind: str, name: str, want: int, got: int) -> None:
        """A count that disagrees -- and WHICH WAY it disagrees decides everything.

        Seeding only ever adds, so `got > want` cannot be evidence that this run
        lost anything: the room already held content, which is what a second
        `houston seed`, a preset that posts on boot, or a restored backup all look
        like. Reported, because a reader comparing against the manifest should know,
        but never as a fault -- gating on exact equality is what made the earlier
        version of this refuse a workspace that was working.

        `got < want` is the real signal: something was asked for and is not there.
        """
        if got < want:
            fault(kind, name, want, got)
        elif got > want:
            extra.append({"kind": kind, "room": name, "want": want, "got": got})

    missing_users = [u for u in facts["planned_users"] if u not in facts["users_found"]]
    if facts.get("users_unreadable"):
        unreadable.append({"what": "users", "why": facts["users_unreadable"]})
    elif missing_users:
        fault("users", "", len(facts["planned_users"]),
              len(facts["users_found"]), ", ".join(missing_users[:5]))

    for f in facts["rooms"]:
        spec = f.spec
        if f.unreadable:
            unreadable.append({"what": spec.name, "why": f.unreadable})
            continue
        if not f.found:
            fault("missing", spec.name, spec.kind, "absent")
            continue
        counted("messages", spec.name, spec.total_messages, f.messages)
        counted("threads", spec.name, spec.replies, f.replies)
        counted("reactions", spec.name, spec.reacted, f.reacted)
        if not f.in_team:
            fault("team", spec.name, f"in {spec.parent}", "not in the team")


def verify(plan: Plan, facts: dict) -> dict:
    """Compare the manifest with what was read back.

    Returns findings, never raises: whether a mismatch should end the command is
    the CALLER's decision, and the default is that it should not. A verifier that
    fails a healthy workspace teaches people to pass the override by reflex, and
    then it is protecting nothing -- which is exactly what happened to the version
    of this that shipped with an exact-equality gate and a known-lossy seeder.
    """
    faults: list[dict] = []
    extra: list[dict] = []
    unreadable: list[dict] = []

    _collect_faults(extra, facts, faults, unreadable)
        # A discussion's ANCHOR is checked by that message count, not separately: one
        # opened from a message arrives holding ANCHOR_MESSAGES it did not post, so a
        # `pmid` that silently stopped being sent makes the room come back two short
        # -- a fault, named by room. That is not a happy accident; it is why the
        # anchor is in the plan instead of being subtracted out. The variant was dead
        # code for a while (discussions were created before their parents had said
        # anything) and nothing noticed, which is what this now prevents.
    return {
        "ok": not faults,
        "faults": faults,
        "extra": extra,
        "unreadable": unreadable,
        "checked": len(facts["rooms"]),
        "rooms": [{"kind": f.spec.kind, "name": f.spec.name, "found": f.found,
                   "messages": f.messages, "want_messages": f.spec.total_messages,
                   "replies": f.replies, "want_replies": f.spec.replies,
                   "reacted": f.reacted, "want_reacted": f.spec.reacted,
                   "threads": f.threads, "in_team": f.in_team,
                   "unreadable": f.unreadable}
                  for f in facts["rooms"]],
    }
