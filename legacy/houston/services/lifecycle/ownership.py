"""Who owns a workspace, and who may destroy or hand over one.

Tier 1. The gate is deliberately policy-driven rather than hard-coded: `may_destroy` and
`may_chown` read the box's configured policy, and the default lets an admin act for
everybody -- which is why the GUI's `ROUTE_ROLES` cannot be the only check and why these
live in the service layer where both front-ends reach them.
"""
from __future__ import annotations

from datetime import datetime, timezone

from houston import config, runner
from houston.errors import ConflictError, NotFoundError, ValidationError
from houston.services import audit as auditsvc
from houston.services.lifecycle import naming
from houston.services.lifecycle.types import CREATE_POLICY_KEY, DESTROY_POLICY_KEY


def owner_of(name: str) -> str:
    """Who owns `name` NOW, or "" for a pre-team workspace or one that is gone.

    `owner` wins over `created_by`, which is deliberately immutable: who made a
    workspace is a fact about the past and stays in the record, while who is
    responsible for it today is a thing that changes when a ticket is handed
    over. Before this, "belongs to alice" kept warning bob about data that had
    been his for a week -- which teaches people to click through the warning.
    """
    try:
        meta = runner.read_meta(name)
    except Exception:
        return ""
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    return extra.get("owner") or extra.get("created_by", "")


def set_owner(name: str, to: str, *, by: str = "") -> dict:
    """Hand a workspace over. Returns {name, from, to}.

    Ownership is a real verb because the workflow team-server.md §3.3 was written
    around -- support engineers handing tickets to each other -- was never
    modelled at all: the record only ever knew who typed `up`.
    """
    target = naming.resolve_name(name)
    # Enforced HERE, beside the mutation, exactly as teardown() enforces
    # may_destroy: the CLI and the GUI both reach this function, and a check at
    # either front end alone would leave the other open.
    allowed, why = may_chown(target, by or auditsvc.actor())
    if not allowed:
        auditsvc.record("chown", target, outcome="denied")
        raise ConflictError(why)
    to = (to or "").strip().lower()
    if not to:
        raise ValidationError("no new owner given (--to <name>)")
    from houston.services import users as usersvc
    if usersvc.any_users() and not usersvc.role_of(to):
        raise NotFoundError(
            f"no account named {to!r} (see `houston users list`) — a workspace "
            "cannot be handed to somebody who cannot sign in")
    was = owner_of(target)

    def mutate(meta):
        extra = meta.extra if isinstance(meta.extra, dict) else {}
        history = list(extra.get("owner_history") or [])
        history.append({"from": was, "to": to, "by": by or auditsvc.actor(),
                        "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        extra["owner"] = to
        extra["owner_history"] = history[-20:]
        meta.extra = extra

    runner.update_meta(target, mutate)
    auditsvc.record("chown", f"{target} {was or '-'} -> {to}")
    return {"name": target, "from": was, "to": to}


def may_set_privileged_fields(actor: str) -> bool:
    """Whether `actor` may set rc_image / reg_token / bind on a create.

    Open unless the box has explicitly narrowed it. Note the asymmetry with
    may_destroy() below, which defaults the OTHER way and should: destroying
    somebody else's workspace loses a colleague's in-progress work, and no create
    field does that.
    """
    if config.load_config().get(CREATE_POLICY_KEY) != "admin":
        return True
    if not actor:                     # no accounts on this box: nothing to bound
        return True
    from houston.services import users as usersvc
    return usersvc.at_least(usersvc.role_of(actor), "admin")


def _owner_gate(name: str, actor: str) -> tuple[bool, str]:
    """(allowed, the current owner when refusing). The ownership rule itself.

    ONE implementation, because two operations apply it and they must not drift:
    `may_destroy` and `may_chown`. Reassigning a workspace is not a lesser act than
    destroying it -- it is the act that DECIDES who may destroy it -- so it is
    gated by the same rule rather than by a weaker one of its own.
    """
    if config.load_config().get(DESTROY_POLICY_KEY) == "anyone":
        return True, ""
    if not actor:                     # no accounts on this box: nothing to bound
        return True, ""
    from houston.services import users as usersvc
    if usersvc.role_of(actor) == "admin":
        return True, ""
    owner = owner_of(name)
    if not owner or owner == actor:
        return True, ""
    return False, owner


def may_destroy(name: str, actor: str) -> tuple[bool, str]:
    """(allowed, why not). Advisory for a front end, enforced by teardown()."""
    allowed, owner = _owner_gate(name, actor)
    if allowed:
        return True, ""
    # The old message told the refused caller to run `chown --to <themselves>`,
    # which was accurate -- `set_owner` was ungated, so following the refusal
    # defeated it in one command. It is gated now, so the advice names who can
    # actually run it instead of reading as an instruction to the wrong person.
    return False, (f"{name} belongs to {owner} — ask {owner}, or an admin can "
                   f"force it. ({owner} or an admin can run "
                   f"`houston chown -n {name} --to {actor}` to hand it over "
                   "for good.)")


def may_chown(name: str, actor: str) -> tuple[bool, str]:
    """(allowed, why not). Advisory for a front end, enforced by set_owner().

    `POST /api/repros/{name}/owner` is member+ and this was not checked at all, so
    a member who had just been refused a destroy could reassign the workspace to
    themselves and destroy it on the next call -- two HTTP requests, both audited,
    neither prevented. Ownership is what `may_destroy` consults, so leaving the
    write to it open made that check advisory in the literal sense.
    """
    allowed, owner = _owner_gate(name, actor)
    if allowed:
        return True, ""
    return False, (f"{name} belongs to {owner} — only {owner} or an admin can "
                   f"hand it over. Taking ownership is what decides who may "
                   f"destroy a workspace, so it is gated the same way as "
                   f"`down --volumes`.")
