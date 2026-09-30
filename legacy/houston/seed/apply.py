"""apply -- see the package docstring."""
from __future__ import annotations

import time
import requests
from houston import config, rcapi
from houston.seed_profiles import PROFILES as PROFILES
from houston.seed_profiles import Shape as Shape
from houston.services import journal
from houston.perf import Timings

from houston.seed import wording
from houston.seed.kinds import CHANNEL, DISCUSSION, DM, GENERAL, TEAM, TEAM_PRIVATE
from houston.seed.plan import Plan, RoomSpec, _Made
from houston.seed.wording import _EMOJI, _MESSAGES, _REPLIES

def _quiesce_settings(_set, admin, admin_password, log, root_url):
    """Turn off the two settings that would make seeding fail, and journal both."""
    # Make seeding possible/fast: new users' logins aren't blocked by email-2FA,
    # and bulk calls aren't throttled. Both settings are restored to their PRIOR
    # values afterwards — in a finally, so a mid-seed crash can't leave the
    # workspace's security settings silently changed. ("Was off before" is only
    # honoured when we could actually read the setting; unknown -> restore on.)
    email_2fa = "Accounts_TwoFactorAuthentication_By_Email_Enabled"
    rate_limiter = "API_Enable_Rate_Limiter"
    # Prior values (None = the read failed). "Unreadable" is NOT "was on": the
    # old rule restored ON for both, so a single transient 500 — likely, since
    # seeding starts the moment RC answers — turned email-2FA on for the ldap /
    # saml / oidc / livechat presets, which deliberately switch it OFF because
    # their users have no mailbox here. Only touch a value we actually observed,
    # and only put back what we actually changed.
    email_2fa_prev = rcapi.get_setting(root_url, admin, admin_password, email_2fa)
    # "UNREADABLE" IS NOT "WAS ON" -- the rule the email-2FA lines above state in as
    # many words, and the limiter line twelve lines down did not follow. `... is False`
    # makes an unreadable setting indistinguishable from one that was on, so a single
    # transient 500 (likely: seeding starts the moment RC answers) made this disable the
    # limiter and then force it ON in the `finally`, on a workspace that may have had it
    # off deliberately. Only touch what was actually observed.
    limiter_prev = rcapi.get_setting(root_url, admin, admin_password, rate_limiter)
    email_2fa_changed = False
    _authorship_warning = (
        "seeded users may not be loginable, so messages will be authored by admin")
    if email_2fa_prev is None:
        log(f"  ⚠ could not read the email-2FA setting — leaving it alone; {_authorship_warning}")
    elif email_2fa_prev:
        email_2fa_changed = _set(email_2fa, False)
        if not email_2fa_changed:
            # Previously silent: the bool was discarded, so a failed disable
            # surfaced only as "0 usable as authors" further down.
            log(f"  ⚠ could not disable email-2FA — {_authorship_warning}")
    return email_2fa, email_2fa_changed, limiter_prev, rate_limiter


def seed(root_url, admin: rcapi.Auth, plan: Plan, log=lambda m: None, workspace: str = "",
         tokens_out: dict | None = None, admin_password: str = "") -> dict:
    """Seed the repro. `log(msg)` is called with progress lines.

    `tokens_out`, when given, is filled with the per-user sessions this created, for
    a readback that has to look at a DM. An out-parameter rather than a key in the
    result: the result is written into `repro.json` and rendered in a browser, and a
    session token has no business in either.
    """
    base = root_url.rstrip("/")
    # The workspace's own admin password, falling back to the shared loopback one --
    # the same fallback `runner.Metadata.admin_pass` applies from the other side.
    # `set_setting` re-authenticates for a 2FA-guarded change, so a wrong password
    # here fails the settings step of a seed that had otherwise worked.
    admin_password = admin_password or config.ADMIN_PASSWORD
    session = requests.Session()
    admin_hdr = {**admin.headers(), "Content-Type": "application/json"}

    def post(path: str, headers: dict, payload: dict):
        try:
            return session.post(f"{base}{path}", headers=headers, json=payload, timeout=30)
        except requests.RequestException:
            return None

    def _set(setting_id: str, value) -> bool:
        return rcapi.set_setting(root_url, admin, admin_password, setting_id, value)

    email_2fa, email_2fa_changed, limiter_prev, rate_limiter = _quiesce_settings(_set, admin, admin_password, log, root_url)
    # JOURNALLED, both of them. The `finally` below is the only thing that puts these
    # back, and it is exactly the block a SIGKILL, an OOM or a `systemctl restart` does
    # not run. A GUI seed of the `large` profile is minutes long against `jobs.drain`'s
    # 25 seconds, so this is a routine interruption, not an exotic one -- and what
    # survives is a workspace with the rate limiter AND email-2FA off, silently
    # different from the one somebody is about to measure, with nothing on disk for
    # `doctor` or `serve`'s recovery to find. `workspace` is optional so the pure
    # seed path stays callable without a name; every real caller passes it.
    limiter_note = email_2fa_note = ""
    if limiter_prev is True:
        if workspace:
            limiter_note = journal.record(journal.RATE_LIMITER_OFF, workspace)
        if not _set(rate_limiter, False):
            journal.clear(limiter_note)
            limiter_note = ""
            log("  ⚠ could not disable the API rate limiter — seed rates may be throttled")
    if email_2fa_changed and workspace:
        email_2fa_note = journal.record(journal.EMAIL_2FA_OFF, workspace)

    try:
        return _seed_body(root_url, admin_hdr, plan, post, log, tokens_out)
    finally:
        if limiter_prev is True:
            if _set(rate_limiter, True):
                journal.clear(limiter_note)
        if email_2fa_changed:
            if _set(email_2fa, True):
                journal.clear(email_2fa_note)

def _json(resp) -> dict:
    """A response's JSON body, or {}.

    `.ok` is true for any 2xx, and a front proxy (Traefik fronts the multi-instance
    preset) can answer 200 with an HTML error page — a raw JSONDecodeError there
    would abort the entire seed mid-way.
    """
    try:
        return resp.json() or {}
    except (ValueError, AttributeError):
        return {}

def _message_id(resp) -> str | None:
    """The posted message's `_id`, or None."""
    return (_json(resp).get("message") or {}).get("_id")

def _send_replies(_room_id, admin_hdr, fill, made, ordinals, timed):
    """The replies that go under a thread, once every room has its messages."""
    # 4. Discussions LAST, so the half that hang off a message have one to hang off.
    for name, rec in made.items():
        spec = rec.spec
        if spec.kind != DISCUSSION:
            continue
        parent = made.get(spec.parent)
        if not parent or not parent.rid:
            rec.failed = "no parent room"
            continue
        payload: dict = {"prid": parent.rid, "t_name": spec.name,
                         "users": list(spec.members)}
        if 0 <= spec.from_message < len(parent.message_ids):
            # Opened FROM a message, which is how a support engineer usually makes
            # one, and which leaves a different system message in the parent.
            payload["pmid"] = parent.message_ids[spec.from_message]
            payload["reply"] = _REPLIES[spec.from_message % len(_REPLIES)]
        r = timed("channels", "/api/v1/rooms.createDiscussion", admin_hdr, payload)
        if r is None or not r.ok:
            rec.failed = "rooms.createDiscussion"
            continue
        rec.rid = _room_id(_json(r))
        fill(ordinals[name], rec)


def _fill_rooms(_room_id, admin_hdr, durs, hdr_for, made, msg, post, timed):
    """Put the messages, threads and replies into the rooms that were made."""
    # 3. Messages, threads and reactions. One call shape for every room kind:
    #    chat.sendMessage against an rid. A discussion's `name` is a generated slug
    #    rather than its title, so addressing rooms by `#name` -- as this used to --
    #    cannot reach one at all.
    def fill(ordinal: int, rec: _Made) -> None:
        spec = rec.spec
        if not rec.rid:
            return
        bucket = "dms" if spec.kind == DM else "messages"
        for i in range(spec.messages):
            # Stride 7 against a pool of 16 is coprime, so a room walks the whole
            # pool before repeating; the room's ordinal offsets it so two rooms do
            # not open with the same line. The first cut multiplied by the count of
            # messages ALREADY posted, which made the effective stride 8 -- half the
            # pool size -- and every room said "Hey team, any update on this?" three
            # times out of five.
            body = {"rid": rec.rid,
                    "msg": _MESSAGES[(ordinal * 5 + i * 7) % len(_MESSAGES)]}
            t = time.monotonic()
            r = post("/api/v1/chat.sendMessage", hdr_for(spec.members, i), {"message": body})
            dt = time.monotonic() - t
            durs[bucket] += dt
            if r is None or not r.ok:
                continue
            msg.add(dt * 1000)
            rec.messages += 1
            mid = _message_id(r)
            if mid:
                rec.message_ids.append(mid)
            if i in spec.threads and mid:
                # THE THREAD. `chat.postMessage` with a `tmid` answers 400, so every
                # reply this module used to attempt was lost and no thread was ever
                # created -- while `rich` profiles advertised them. `chat.sendMessage`
                # takes the whole message object, `tmid` included, and is what the
                # client itself uses.
                tr = timed(bucket, "/api/v1/chat.sendMessage", hdr_for(spec.members, i + 1),
                           {"message": {"rid": rec.rid, "tmid": mid,
                                        "msg": _REPLIES[i % len(_REPLIES)]}})
                if tr is not None and tr.ok:
                    rec.replies += 1
            if mid and i in spec.reactions:
                rr = timed(bucket, "/api/v1/chat.react", hdr_for(spec.members, i),
                           {"messageId": mid, "emoji": _EMOJI[i % len(_EMOJI)]})
                if rr is not None and rr.ok:
                    rec.reactions += 1

    ordinals = {name: n for n, name in enumerate(made)}
    for name, rec in made.items():
        if rec.spec.kind != DISCUSSION:
            fill(ordinals[name], rec)

    _send_replies(_room_id, admin_hdr, fill, made, ordinals, timed)


def _make_a_channel(_lookup, _room_id, admin_hdr, made, members, rec, spec, timed):
    """A plain public or private channel, which is what most of the plan is."""
    # A plain channel or group, standalone or inside a team. `extraData.teamId`
    # puts it in the team in ONE call -- `teams.createRoom` does not exist on
    # 8.5.1 (404), and create-then-`teams.addRooms` is two round trips for the
    # same result.
    path = "/api/v1/groups.create" if spec.private else "/api/v1/channels.create"
    payload: dict = {"name": spec.name, "members": list(members)}
    if spec.parent:
        team = made.get(spec.parent)
        if team and team.team_id:
            payload["extraData"] = {"teamId": team.team_id}
    r = timed("channels", path, admin_hdr, payload)
    if r is not None and r.ok:
        rec.rid = _room_id(_json(r))
    else:
        rec.rid, rec.reused = _lookup(spec), True
        if not rec.rid:
            rec.failed = "create"


def _make_team_or_team_private(_lookup, admin_hdr, members, rec, spec, timed):
    """Create the team or  team private kind, which is not made the way a channel is."""
    r = timed("channels", "/api/v1/teams.create", admin_hdr, {
        "name": spec.name, "type": 1 if spec.private else 0,
        "members": list(members)})
    body = _json(r)
    if r is not None and r.ok:
        rec.team_id = (body.get("team") or {}).get("_id", "")
        rec.rid = (body.get("team") or {}).get("roomId", "")
    else:
        rec.rid, rec.reused = _lookup(spec), True
        if not rec.rid:
            rec.failed = "teams.create"


def _make_dm(_room_id, admin_hdr, rec, spec, timed, tokens):
    """Create the dm kind, which is not made the way a channel is."""
    owner = spec.members[0]
    hdr = ({**tokens[owner].headers(), "Content-Type": "application/json"}
           if owner in tokens else admin_hdr)
    r = timed("dms", "/api/v1/im.create", hdr, {"username": spec.members[1]})
    # post() returns None only on a TRANSPORT error, so a 400/403 (revoked
    # create-d permission, Accounts_Direct_Message_Max_Users) still counted
    # as a DM and still fired a doomed postMessage. The reported count then
    # landed in the performance report as workload that was never created.
    if r is None or not r.ok:
        rec.failed = "im.create"
        return
    rec.rid = _room_id(_json(r))


def _make_general(_lookup, rec, spec):
    """Create the general kind, which is not made the way a channel is."""
    # Not created -- every workspace ships it. Looked up, because messages
    # go by rid and a name would not reach a renamed default room.
    rec.rid = _lookup(spec)
    if not rec.rid:
        rec.failed = "general not found"


def _make_rooms(admin_hdr, made, plan, root_url, timed, tokens):
    """Create every room the plan names, in the order the plan puts them in."""
    def _room_id(body: dict) -> str:
        for key in ("channel", "group", "room", "discussion"):
            rid = (body.get(key) or {}).get("_id")
            if rid:
                return rid
        return ""

    def _lookup(spec: RoomSpec) -> str:
        """The id of a room that already exists, so a re-seed adds to it.

        A second `houston seed` used to abandon a private group it had not created
        this run (its freshly-sampled members were not in it, so every post 400'd).
        With a deterministic manifest the membership is the same on every run, so
        the room can simply be reused -- and the readback reports the totals, which
        is a better answer than silently doing less.
        """
        path = "/api/v1/groups.info" if spec.private else "/api/v1/channels.info"
        try:
            r = requests.get(f"{root_url.rstrip('/')}{path}",
                             headers=admin_hdr, params={"roomName": spec.name}, timeout=30)
        except requests.RequestException:
            return ""
        return _room_id(_json(r)) if r.ok else ""

    # 2. Rooms, in the manifest's order (a team before its channels, a parent
    #    before its discussions). Every call goes through `timed`, so the buckets
    #    add up without an outer wrapper subtracting one from another.
    for spec in plan.rooms:
        rec = _Made(spec=spec)
        made[spec.name] = rec
        members = list(spec.members)
        if spec.kind == DISCUSSION:
            # NOT here. Half of them are meant to hang off a MESSAGE in the parent,
            # and at this point no message has been posted anywhere -- so the `pmid`
            # branch could never fire and every discussion came out attached to the
            # room instead. The whole variant was dead code, silently. They are
            # created in their own pass below, after the parents have said something.
            continue
        if spec.kind == GENERAL:
            _make_general(_lookup, rec, spec)
            continue
        if spec.kind == DM:
            _make_dm(_room_id, admin_hdr, rec, spec, timed, tokens)
            continue
        if spec.kind in (TEAM, TEAM_PRIVATE):
            _make_team_or_team_private(_lookup, admin_hdr, members, rec, spec, timed)
            continue
        _make_a_channel(_lookup, _room_id, admin_hdr, made, members, rec, spec, timed)
    return _room_id


def _seed_body(root_url, admin_hdr: dict, plan: Plan, post, log,
               tokens_out: dict | None = None) -> dict:
    """Create everything the plan names; split out so seed() can guarantee setting
    restoration in a finally. Times each phase and collects per-message latency for
    the seed timing breakdown."""
    durs = {"users": 0.0, "channels": 0.0, "messages": 0.0, "dms": 0.0}
    msg = Timings()   # primary chat.sendMessage latencies

    def timed(bucket: str, path: str, headers: dict, payload: dict):
        t = time.monotonic()
        r = post(path, headers, payload)
        durs[bucket] += time.monotonic() - t
        return r

    # 1. Users (idempotent: an existing user just gets logged into).
    tokens: dict[str, rcapi.Auth] = {}
    names = [wording.username(i) for i in range(plan.users)]
    _t = time.monotonic()
    for un in names:
        post("/api/v1/users.create", admin_hdr, {
            "name": un.capitalize(), "username": un, "email": f"{un}@example.com",
            "password": un, "verified": True, "requirePasswordChange": False,
            "joinDefaultChannels": True,
        })
        try:
            tokens[un] = rcapi.login(root_url, un, un)
        except Exception:  # noqa: BLE001 - fall back to admin authorship
            pass
    durs["users"] = time.monotonic() - _t
    if tokens_out is not None:
        tokens_out.update(tokens)
    log(f"users: {len(names)} ({len(tokens)} usable as authors)")

    def hdr_for(members: tuple[str, ...], turn: int) -> dict:
        """The author of one message: the members, round-robin.

        Round-robin rather than a random pick, for the same reason as everything
        else here -- but it is also better content: a random pick can leave a
        member who never speaks, while this guarantees every member of a room
        authors in it as soon as there are as many messages as members.
        """
        authors = [tokens[u] for u in members if u in tokens]
        if not authors:
            return admin_hdr
        return {**authors[turn % len(authors)].headers(),
                "Content-Type": "application/json"}

    made: dict[str, _Made] = {}

    _room_id = _make_rooms(admin_hdr, made, plan, root_url, timed, tokens)

    _fill_rooms(_room_id, admin_hdr, durs, hdr_for, made, msg, post, timed)

    return _result(plan, made, names, durs, msg, log)

def _result(plan: Plan, made: dict[str, _Made], names: list[str],
            durs: dict, msg: Timings, log) -> dict:
    """The seed summary. The legacy keys keep their meaning; the rest are new."""
    rooms = [r for r in made.values()]
    created = [r for r in rooms if r.rid and not r.failed]
    total_msgs = sum(r.messages for r in rooms)
    total_replies = sum(r.replies for r in rooms)
    dms = sum(1 for r in created if r.spec.kind == DM)
    by_kind: dict[str, int] = {}
    for r in created:
        by_kind[r.spec.kind] = by_kind.get(r.spec.kind, 0) + 1
    failed = [(r.spec.name, r.failed) for r in rooms if r.failed]
    if failed:
        log(f"  ⚠ {len(failed)} room(s) not created: "
            + ", ".join(f"{n} ({why})" for n, why in failed[:4]))
    log(f"messages: {total_msgs + total_replies} ({total_replies} in threads)  "
        f"rooms: {len(created)}  DMs: {dms}")
    return {
        # Legacy keys, unchanged in meaning: both front-ends and the performance
        # report read these.
        "users": len(names),
        "channels": sum(1 for r in created if r.spec.kind == CHANNEL),
        "messages": total_msgs + total_replies,
        "dms": dms,
        "durations": durs, "latency": msg.summary(), "latency_hist": msg.histogram(),
        # The manifest's own vocabulary, for the readback and for anything that
        # wants to say what is in there.
        "profile": plan.profile,
        "rooms": by_kind,
        "rooms_total": len(created),
        "threads": total_replies,
        "reactions": sum(r.reactions for r in rooms),
        "reused": sum(1 for r in created if r.reused),
        "failed": [{"name": n, "why": w} for n, w in failed],
        "planned": {
            "rooms": plan.by_kind(),
            "rooms_total": len(plan.rooms),
            "messages": plan.total_messages,
            "threads": plan.total_replies,
            "users": plan.users,
        },
        "created": [{"kind": r.spec.kind, "name": r.spec.name, "rid": r.rid,
                     "parent": r.spec.parent, "private": r.spec.private,
                     "messages": r.messages, "replies": r.replies,
                     "reused": r.reused}
                    for r in created],
    }
