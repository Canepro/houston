"""Seeding a workspace through REST, and checking that what was asked for arrived.

Tier 3. `run_seed_inline` takes `repro_lock` -- it was the ONLY mutating operation that
did not, and a seed running into a backup's `_Quiesced` fails mid-manifest and reports
faults nobody caused. Reentrant per thread, so `up --seed` is unaffected.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from houston import runner
from houston import seed as seeder
from houston.errors import NotReadyError, ValidationError
from houston.services.events import Emit, info, null_emit, warn
from houston.services.lifecycle import admin
from houston.services.lifecycle.types import _INTERACTIVE_LOCK_WAIT

def check_seed(meta: runner.Metadata, auth, plan, result: dict,
               emit: Emit = null_emit, tokens: dict | None = None) -> dict:
    """Read the seeded workspace back, compare it with the manifest, and record it.

    Both front-ends call this, because both had the same hole: the seed summary was
    what the seeder ASKED for, and nothing anywhere checked it. `messages: ~62` --
    the tilde was the tool admitting it did not know.

    REPORTS, it does not refuse. A mismatch is written into the result and warned
    about; whether that ends the command is the caller's decision and the default is
    that it does not. The version of this idea that shipped elsewhere gated on exact
    equality over a seeder that was losing every thread reply, so `up --seed` failed
    on a healthy workspace -- and a check that fails when nothing is wrong is one
    people learn to bypass.

    The verification is persisted into `repro.json` either way. A seeded workspace
    that says what it contains, and whether that was confirmed, is the difference
    between a reproduction and a pile of plausible content.
    """
    try:
        facts = seeder.readback(meta.root_url, auth, plan, tokens=tokens)
        verdict = seeder.verify(plan, facts)
    except Exception as exc:  # noqa: BLE001 - a check must never break the seed
        warn(emit, f"could not read the seed back: {exc}", phase="seed")
        # `why` travels with the verdict, so a caller rendering from the RETURN VALUE
        # can say what went wrong without also subscribing to the events. The CLI does
        # exactly that -- it has the richer renderer -- and passing it an emit as well
        # made every line print twice.
        return {"ok": None, "why": str(exc), "faults": [], "unreadable": [],
                "checked": 0, "rooms": []}
    result["verification"] = {k: verdict[k] for k in
                              ("ok", "faults", "extra", "unreadable", "checked")}
    result["readback"] = verdict["rooms"]
    if verdict["faults"]:
        warn(emit, f"seed readback found {len(verdict['faults'])} mismatch(es): "
                   + "; ".join(f"{f['room'] or 'users'} wanted {f['want']}, found {f['got']}"
                               for f in verdict["faults"][:3]), phase="seed")
    elif verdict["extra"]:
        info(emit, f"readback: {len(verdict['extra'])} room(s) hold more than this run "
                   "planned — they had content already (a re-seed, a preset, a restore)",
             phase="seed")
    elif verdict["unreadable"]:
        warn(emit, f"{len(verdict['unreadable'])} room(s) could not be read back — "
                   "not counted as a fault", phase="seed")
    else:
        info(emit, f"readback: {verdict['checked']} rooms match the plan", phase="seed")
    try:
        runner.update_meta(meta.name, lambda m: m.extra.update({"seed": {
            "profile": plan.profile,
            "planned": result.get("planned", {}),
            "actual": {k: result.get(k) for k in
                       ("users", "rooms", "rooms_total", "messages", "threads", "dms")},
            "verification": result["verification"],
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }}))
    except Exception:  # noqa: BLE001 - a record is not worth failing a good seed
        pass
    return verdict


def _seed_inline_locked(meta: runner.Metadata, profile: str, stats: bool,
                        emit: Emit) -> dict:
    from houston import perf
    try:
        auth = admin.login(meta)
    except Exception as exc:  # noqa: BLE001
        raise NotReadyError(f"can't seed - repro not ready: {exc}") from exc
    try:
        plan = seeder.plan_from(profile)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    info(emit, f"seeding (profile {profile})", phase="seed")
    mon = perf.ResourceMonitor(meta.name).start() if stats else None
    t0 = time.monotonic()
    tokens: dict = {}
    try:
        s = seeder.seed(meta.root_url, auth, plan, tokens_out=tokens,
                        admin_password=meta.admin_pass,
                        workspace=meta.name,
                        log=lambda m: info(emit, m.strip(), phase="seed"))
    finally:
        resources = mon.stop() if mon else None
    s["total_s"] = time.monotonic() - t0
    if resources is not None:
        s["resources_keys"] = sorted(resources)
    check_seed(meta, auth, plan, s, emit, tokens=tokens)
    return s


def run_seed_inline(meta: runner.Metadata, profile: str, stats: bool, emit: Emit) -> dict:
    """Seed a workspace through REST, serialised like every other mutating operation.

    IT WAS THE ONLY ONE THAT WAS NOT. `create_repro`, `set_state`, `teardown`,
    `set_env`, `monitor.attach`, `backup.create`, `upgrade.run`, `run_scale` and
    `clear_scale` all take `repro_lock`; a seed writes the same collections through a
    different door and took nothing. `run_scale`'s own comment states the rule --
    "running it while a backup is dumping would put half of it in the archive" -- and
    the worse direction is the other one: `_Quiesced` STOPS Rocket.Chat for the dump, so
    a seed running into it fails mid-manifest and the readback reports faults nobody
    caused.

    Reentrant per thread, so the `up --seed` path is unaffected: `create_repro` already
    holds this lock and re-entering it is free.
    """
    with runner.repro_lock(meta.name, timeout=_INTERACTIVE_LOCK_WAIT):
        return _seed_inline_locked(meta, profile, stats, emit)
