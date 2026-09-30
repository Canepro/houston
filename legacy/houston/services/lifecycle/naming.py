"""What a workspace is called: sanitising, deriving, and resolving a name to a record.

Tier 0, and the busiest leaf in the package -- `resolve_name` alone is patched at 49
sites in the suite. Every cross-module caller reaches it as `naming.resolve_name(...)`
rather than by importing the function, so a patch on this module is seen by all of them;
see the package docstring.
"""
from __future__ import annotations

import re

from houston import config, runner
from houston.errors import NotFoundError, ValidationError
from houston.services.events import Emit, warn
from houston.services.lifecycle.types import CreateReq


_NAME_RE = re.compile(r"[^a-z0-9-]+")


# What sanitize() can produce, and therefore the only shape a real repro has.
_VALID_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


# The name becomes a directory entry (255 bytes on ext4/APFS) and a compose project
# name, and the generated container names add `houston-<name>-<service>-1` on top.
# Unbounded, it passed validation and then raised ENAMETOOLONG from the filesystem
# -- a 500 from the web API and a raw traceback from the CLI. 64 leaves ample room
# for every suffix houston appends and is longer than any real repro name.
NAME_MAX = 64


def _require_valid_name(name: str) -> None:
    if not _VALID_NAME_RE.match(name):
        raise ValidationError(
            f"invalid repro name {name!r} (lowercase letters, digits and '-' only)")
    if len(name) > NAME_MAX:
        raise ValidationError(
            f"repro name is {len(name)} characters; the limit is {NAME_MAX} "
            "(it becomes a directory and a set of container names)")


def sanitize(name: str) -> str:
    name = name.lower().replace(".", "-")
    return _NAME_RE.sub("-", name).strip("-")


def _warn_name_coerced(req: "CreateReq", emit: Emit) -> None:
    """Say so when `--name` is not the name the workspace gets.

    `sanitize` slugifies rather than refusing, which is right -- `TICKET-1234` and
    `ticket 1234` should both work -- but it was silent, and slugifying is not
    injective: `../escape` and `escape` both become `escape`, as do `a/b` and `a-b`.
    There is no traversal here (the result contains no separator) and no injection
    (nothing reaches a shell), but two different tickets could silently land on ONE
    workspace and share its data, which is the failure worth naming.
    """
    if not req.name:
        return
    became = sanitize(req.name)
    if became and became != req.name:
        warn(emit, f"--name {req.name!r} becomes {became!r} — a workspace name is a "
                   f"directory and a DNS label. Another name that reduces to "
                   f"{became!r} would be the same workspace, data included.",
             phase="create")


def derive_name(version: str, preset: str, actor: str = "") -> str:
    """The workspace name for a version+preset, namespaced by who asked.

    Without `actor` this returns the same name for everybody -- so on a shared
    server the second person to run `up -v 8.5.1` silently REUSED the first
    person's workspace, data and all, with no warning. Prefixing by the
    authenticated user makes two people running the same version two workspaces.

    Left off entirely on a single-user machine, where the prefix would be noise
    and would break every existing name.
    """
    base = "rc" + version
    if preset and preset != "default":
        base += "-" + preset
    if actor:
        base = f"{actor}-{base}"
    return sanitize(base)


def owner_prefix(name: str, actor: str) -> str:
    """`name` namespaced to `actor`, unless it already is.

    An explicit --name still wins, but on a shared server it has to be somebody's
    or two people typing `--name test` collide exactly as the derived names did.
    """
    if not actor:
        return name
    return name if name.startswith(f"{actor}-") else f"{actor}-{name}"


def name_candidates(name: str, actor: str = "") -> list[str]:
    """The workspaces `name` could mean, best match first.

    Creation TRANSFORMS what you type -- `sanitize()` always, and the owner prefix
    when there are accounts -- so resolution has to apply the same transforms or
    the name never round-trips. It did not, and in two separate ways:

      up   --name TICKET-1234  ->  creates 'ticket-1234'   (sanitize)
      down --name TICKET-1234  ->  ValidationError         (validate, no sanitize)

    which broke the README's own first example on a plain single-user install,
    and then:

      up   --name test         ->  creates 'alice-test'    (owner prefix)
      down --name test         ->  NotFoundError

    once any account existed. The first is older than the team work; the prefix
    only widened it. Both are the same bug -- create and resolve disagreeing about
    what a name means -- so both are fixed by deriving the candidates the same way.

    Order matters, and is: what you typed, then what creating it would have made,
    then the bare sanitized form.

      * exact first, so a full name always wins -- `alice-test` resolves to itself
        rather than being prefixed again, and a colleague's `bob-rc8-5-1` is
        reachable by typing it;
      * the OWNER-PREFIXED form before the bare one, because that is what `up`
        would target. With both `ticket-1234` (made before accounts) and
        `alice-ticket-1234` present, `--name TICKET-1234` has to mean the same
        workspace here as it does there, or the round trip is broken again in a
        subtler way;
      * the bare form last, so pre-accounts workspaces stay reachable.
    """
    out: list[str] = []
    # Only if it is already a legal name: this one is used as a filesystem path,
    # and the sanitized forms below are safe by construction while raw input is
    # not ('../../x' must never be probed as a path).
    if _VALID_NAME_RE.match(name or "") and len(name) <= NAME_MAX:
        out.append(name)
    clean = sanitize(name or "")
    if actor and clean:
        prefixed = owner_prefix(clean, actor)
        if prefixed not in out:
            out.append(prefixed)
    if clean and clean not in out:
        out.append(clean)
    return out


def resolve_name(name: str | None, actor: str = "") -> str:
    """Explicit name (must exist) else the configured default (must exist).

    `actor` lets a name typed without the owner prefix find the workspace it
    created; without one this behaves exactly as it did before accounts existed.
    """
    if name:
        for candidate in name_candidates(name, actor):
            if runner.exists(candidate):
                return candidate
        # Nothing matched. Report the shape problem when there is one -- "invalid
        # name" is more use than "not found" for `--name 'my repro!'` -- and
        # otherwise say what was looked for, in the form it would have been made.
        _require_valid_name(sanitize(name) or name)
        raise NotFoundError(f"no repro named {name!r} (run `houston list`)")
    default = config.load_config().get("default_repro")
    if not default:
        raise ValidationError("no name given and no default repro set (use `houston use <name>`)")
    _require_valid_name(default)
    if not runner.exists(default):
        raise NotFoundError(f"default repro {default!r} no longer exists; set another with `houston use`")
    return default


def _derive_for(req: "CreateReq") -> str:
    """The workspace name for this request. Used twice -- by the lock wrapper and
    by the body -- so they cannot drift apart and lock a different repro than the
    one being written."""
    if req.name:
        return sanitize(owner_prefix(sanitize(req.name), req.actor))
    return derive_name(req.version, req.preset, req.actor)
