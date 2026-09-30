"""Getting data into and out of a workspace: seed, import, backup, restore, upgrade.

One subject rather than two. An upgrade takes a backup first and a rollback restores it,
so the snapshot commands and the version-move command are halves of one operation and
splitting them would put those halves in different files.

`config-import` reads a customer's exported `*-settings.json` from a support dump and
applies the plan it produces -- which is the whole reason this tool exists, so it is
worth saying where it lives.
"""
from __future__ import annotations

import contextlib
import time
from pathlib import Path
from typing import Optional

import typer

from houston import config, errors, jsonout, perf, runner, ui
from houston import seed as seeder
from houston.perf.timings import fmt_ms
from houston.services import data as datasvc
from houston.services import lifecycle as lcsvc
from houston.services.events import null_emit
from houston.cli._common import (_cli_emit,
                                 _err, _fail, _login, _require_engine, _resolve_name)
from houston.cli._render import (_human_bytes,
                                 _print_resources)


def _seed_preamble(channels, messages, meta, profile, quiet, stats, users):
    """Resolve the workspace, its credentials and the plan, before anything is written."""
    try:
        auth = _login(meta)
    except Exception as exc:  # noqa: BLE001
        # A 429 IS NOT "NOT READY". Rocket.Chat's own login limiter answers 429 after
        # a few failed attempts, and pointing at `ready` there sends someone to a
        # command that will report success and change nothing -- the workspace is up,
        # it is the limiter refusing. Keyed on the status because the prose is RC's.
        if "429" in str(exc) or "too many requests" in str(exc).lower():
            _err(f"can't seed — Rocket.Chat's login rate limiter is refusing "
                 f"({exc}). The workspace is up; wait about a minute and retry, or "
                 f"turn the limiter off for this repro with "
                 f"`houston api -n {meta.name} -X POST /settings/"
                 f"{config.RC_RATE_LIMITER_SETTING} -d '{{\"value\": false}}'`.")
        _err(f"can't seed — repro not ready (`houston ready --name {meta.name}`): {exc}")
    try:
        plan = seeder.plan_from(profile, users, channels, messages)
    except ValueError as exc:
        _err(str(exc))
    if not quiet:
        typer.echo(
            f"Seeding {meta.name!r} (profile: {profile} — {plan.users} users, "
            f"{plan.channels} channels, {plan.messages} msgs/channel)…"
        )
    mon = perf.ResourceMonitor(meta.name).start() if stats else None
    return auth, mon, plan


def _run_seed(meta: runner.Metadata, profile: str,
              users=None, channels=None, messages=None, stats: bool = False,
              verify: bool = False) -> dict:
    """Seed, print the result, and RETURN the summary.

    The return value is new and is why: `up --seed --json` promises exactly one
    envelope, so the seed summary has to fold into the create's envelope rather
    than being printed beside it. Every error path in here goes through `_err`,
    which in JSON mode is an envelope -- the same seed failure used to leave a
    `--json` caller with an empty stdout and exit 1.

    UNDER THE WORKSPACE LOCK, as the GUI's `run_seed_inline` has always run. It took none,
    so a seed started while a backup, an upgrade or a GUI job held the workspace ran into
    it at once -- into `_Quiesced` stopping Rocket.Chat mid-manifest -- and its record was
    then lost without a word when `update_meta`'s own 60 s wait for the same lock timed out.
    Held from the login to the gate, with the default wait, as the TypeScript build holds
    it; a lock it cannot get is refused through `_fail`, before any request (P21, g3-12).
    """
    with contextlib.ExitStack() as held:
        try:
            held.enter_context(runner.repro_lock(meta.name))
        except errors.ReproError as exc:
            _fail(exc)
        quiet = jsonout.active()
        auth, mon, plan = _seed_preamble(channels, messages, meta, profile, quiet, stats, users)
        t0 = time.monotonic()
        tokens: dict = {}
        try:
            s = seeder.seed(meta.root_url, auth, plan, tokens_out=tokens,
                            admin_password=meta.admin_pass,
                            workspace=meta.name,
                            log=(lambda m: None) if quiet else (lambda m: typer.echo(f"  {m}")))
        finally:
            resources = mon.stop() if mon else None   # stop the sampler thread even if seed raises
        total = time.monotonic() - t0
        if not quiet:
            _print_seed_result(s, total, resources, meta)
        # NO `emit`. `check_seed` emits the same facts this renders from the returned
        # verdict, so passing one printed every line twice -- caught live, as duplicated
        # "readback: 11 rooms match the plan". The reason a readback could not run now
        # travels as `why`, so nothing is lost by rendering from the value alone.
        verdict = lcsvc.check_seed(meta, auth, plan, s, tokens=tokens)
        if not quiet:
            _print_seed_verification(verdict)
        # `--verify-seed` turns the report into a gate. Off by default on purpose: a
        # check that fails a healthy workspace is one people learn to bypass, and the
        # readback is worth having as information whether or not it refuses.
        # UNPROVEN IS NOT PASSED. This gated on `faults`, which is [] when the readback
        # could not run -- so `--verify-seed`, the flag whose whole job is to refuse an
        # unverified seed, exited 0 on a seed it had verified nothing about.
        if verify and verdict.get("ok") is None:
            _fail(errors.CreateFailedError(
                "seed verification could not run, so the seed is UNPROVEN (drop "
                "--verify-seed to accept it anyway; the attempt is recorded in "
                "repro.json either way)"))
        if verify and verdict.get("faults"):
            _fail(errors.CreateFailedError(
                f"seed verification failed: {len(verdict['faults'])} mismatch(es) between "
                "the plan and the workspace (drop --verify-seed to seed anyway; the "
                "readback is recorded in repro.json either way)"))
        return {**s, "profile": profile, "elapsed_s": round(total, 2)}


def _print_seed_verification(verdict: dict) -> None:
    """The readback, in one line when it agrees and a list when it does not."""
    if not verdict:
        return
    if verdict.get("ok") is None:
        # NOT SILENCE. `ok is None` means the readback could not run AT ALL, and
        # returning here printed nothing whatsoever -- so a verification that failed
        # looked exactly like one nobody asked for, the absence of the "✓ readback"
        # line being the only difference. The shipped agent skill says it in bold:
        # treat a missing `verification.ok` as UNPROVEN.
        why = verdict.get("why") or "no reason recorded"
        ui.warn(f"  ⚠ the seed readback could not run ({why}), so nothing about this "
                f"seed is verified. `houston seed --name <it>` re-runs it.")
        return
    faults = verdict.get("faults") or []
    unreadable = verdict.get("unreadable") or []
    extra = verdict.get("extra") or []
    if not faults and not unreadable and not extra:
        ui.ok(f"✓ readback: {verdict['checked']} rooms match the plan")
        return
    for f in faults:
        ui.warn(f"  ⚠ {f['room'] or 'users'}: wanted {f['want']}, found {f['got']}"
                + (f" ({f['detail']})" if f.get("detail") else ""))
    if extra:
        ui.note(f"  · {len(extra)} room(s) hold more than this run planned — they had "
                "content already (a re-seed, a preset, a restore). Not a fault: "
                "seeding only ever adds.")
    for u in unreadable:
        # Reported apart from the faults, and never as one: a single unreadable
        # room is a gap in the CHECK, not a defect in the workspace.
        ui.hint(f"  · {u['what']} could not be read back ({u['why']})")


def _run_scale(meta: runner.Metadata, spec_str: str) -> None:
    # Delegates to the shared service (same code the web GUI runs); the CLI
    # formats the result and prints its own headline warning.
    ui.warn("bulk Mongo prefill: users are credential-less and messages fire no "
            "app hooks — for scale/perf repros, not feature testing.")
    try:
        res = datasvc.run_scale(meta.name, spec_str, emit=null_emit)
    except errors.ReproError as exc:
        _fail(exc)
    if "users" in res:
        ui.ok(f"✓ inserted {res['users']:,} users")
    if "messages" in res:
        ui.ok(f"✓ inserted {res['messages']:,} messages into {res['room']!r}")


def _clear_scale(meta: runner.Metadata) -> None:
    try:
        res = datasvc.clear_scale(meta.name, emit=null_emit)
    except errors.ReproError as exc:
        _fail(exc)
    ui.ok(f"✓ removed {res['users']:,} scale users and {res['messages']:,} scale messages")


def _print_seed_result(s: dict, total: float, resources, meta: runner.Metadata) -> None:
    d = s.get("durations", {})
    lat = s.get("latency", {})
    ui.ok(f"✓ seeded in {fmt_ms(total * 1000)}")

    def row(label: str, count_num: int, dur_s: float, display: str = "", extra: str = "") -> None:
        rate = f"{count_num / dur_s:.1f}/s" if dur_s > 0.05 and count_num else ""
        typer.echo(f"  {label:<9} {(display or str(count_num)):>5}   {dur_s:4.1f}s   {rate:<8} {extra}")

    lat_str = ""
    if lat.get("count"):
        lat_str = (f"p50 {fmt_ms(lat['p50'])} · p95 {fmt_ms(lat['p95'])} · "
                   f"p99 {fmt_ms(lat['p99'])}  {s.get('latency_hist', '')}")
    row("users", s["users"], d.get("users", 0.0))
    row("channels", s["channels"], d.get("channels", 0.0))
    # No tilde. It was there because the count was an estimate -- thread replies
    # were counted optimistically and nothing read the room back. Both are fixed,
    # so the number is now exactly what is in the workspace.
    row("messages", s["messages"], d.get("messages", 0.0), extra=lat_str)
    if s.get("threads"):
        row("threads", s["threads"], 0.0)
    if s.get("reactions"):
        row("reactions", s["reactions"], 0.0)
    if s.get("rooms_total"):
        row("rooms", s["rooms_total"], d.get("channels", 0.0),
            extra=" · ".join(f"{k} {v}" for k, v in sorted((s.get("rooms") or {}).items())))
    row("DMs", s["dms"], d.get("dms", 0.0))
    _print_resources(resources or {}, meta.name)


def seed_cmd(
    name: str = typer.Option("", "--name", "-n"),
    profile: str = typer.Option("small", "--profile", help="small | standard | large"),
    users: Optional[int] = typer.Option(None, "--users", help="override user count"),
    channels: Optional[int] = typer.Option(None, "--channels", help="override channel count"),
    messages: Optional[int] = typer.Option(None, "--messages", help="override messages per channel"),
    stats: bool = typer.Option(False, "--stats", help="also report CPU/RAM cost of the seed"),
    scale: str = typer.Option(
        None, "--scale",
        help="bulk Mongo prefill for scale repros, e.g. users=50000,messages=800000@team-chat"),
    clear_scale: bool = typer.Option(
        False, "--clear-scale", help="remove data a prior --scale added, then exit"),
    verify: bool = typer.Option(
        False, "--verify-seed",
        help="fail if the readback disagrees with the plan (the readback runs and is recorded either way)"),
) -> None:
    """Populate a repro with sample users, channels, DMs and messages.

    --scale bulk-inserts users/messages straight into MongoDB (orders of
    magnitude faster than the REST seed) to reproduce SCALE/perf behaviour.
    Bulk users are credential-less and messages fire no app hooks; use the
    default REST seed when you need real, loginable users.
    """
    target = _resolve_name(name)
    _require_engine(target)
    m = runner.read_meta(target)
    if clear_scale:
        _clear_scale(m)
        return
    if scale:
        _run_scale(m, scale)
        return
    _run_seed(m, profile, users, channels, messages, stats=stats, verify=verify)


def config_import(
    settings_file: str = typer.Argument(
        ..., help="path to a support-dump *-settings.json"),
    name: str = typer.Option("", "--name", "-n"),
    only: str = typer.Option(
        None, "--only", help="comma-separated id prefixes, e.g. Livechat,LDAP,Accounts"),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="show the import plan without changing anything"),
) -> None:
    """Apply a customer's exported settings (from a support dump) to a repro.

    Imports only settings the customer CHANGED from default, skipping secrets the
    dump redacts and identity/environment settings (license, Site_Url, assets)
    that would break or pollute a local repro.
    """
    path = Path(settings_file)
    if not path.is_file():
        _err(f"no such file: {settings_file}")
    target = _resolve_name(name)
    # `config-import` speaks REST to a URL -- `topology.require_compose`'s own
    # docstring names it as runtime-agnostic -- so gating it on Docker refused it on
    # a Kubernetes host that has none.
    _require_engine(target)
    m = runner.read_meta(target)
    onlyset = {p.strip() for p in only.split(",")} if only else None
    try:
        plan = datasvc.import_plan(m.name, str(path), only=onlyset)
    except errors.ReproError as exc:
        _fail(exc)

    lines = [f"apply    {plan['counts']['apply']} customized setting(s)",
             f"skip     {plan['counts']['redacted']} redacted secret(s), "
             f"{plan['counts']['denied']} identity/environment setting(s)"]
    if plan["oauth_services"]:
        lines.append(f"oauth    pre-create: {', '.join(plan['oauth_services'])}")
    typer.echo("")
    ui.box("config import" + (" (dry run)" if dry_run else ""), lines, 64,
           title_color=typer.colors.CYAN)
    if plan["redacted"]:
        ui.warn("  set these by hand (redacted in the dump): " + ", ".join(plan["redacted"]))
    if dry_run:
        for item in plan["apply"]:
            typer.echo(f"    {item['id']:<48} = {item['value']}")
        return

    try:
        res = datasvc.import_apply(m.name, str(path), only=onlyset, emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    if res["failed"]:
        ui.warn(f"  {res['failed']} setting(s) rejected: {', '.join(res['failures'][:10])}"
                + (" ..." if res["failed"] > 10 else ""))
    ui.ok(f"✓ imported {res['applied']} setting(s), skipped {res['skipped']}")
    ui.hint("  some settings need an RC restart to fully take effect: "
            f"houston restart --name {m.name}")


def backup_cmd(
    name: str = typer.Option("", "--name", "-n"),
    out: str = typer.Option("", "--out", help="write the bundle here instead of ~/.houston/backups/"),
    label: str = typer.Option("", "--label", help="a note stored in the bundle, e.g. 'before upgrade'"),
    live: bool = typer.Option(False, "--live", help="don't stop Rocket.Chat first (faster, but the dump may be inconsistent)"),
) -> None:
    """Back up a repro's Rocket.Chat database into a restorable bundle.

    Rocket.Chat is stopped for the dump so it is consistent, then started again;
    MongoDB keeps running throughout and its data volume is untouched.

    The bundle carries the database alongside the repro's version, preset and
    parameters, so `houston restore --new` can rebuild the whole workspace from
    it — on this machine or somebody else's.
    """
    from houston.services import backup as backupsvc
    try:
        # `note=`, not `label=`: JobManager.submit() owns the `label` keyword, so the
        # service takes the note under a different name (see backup.create).
        res = backupsvc.create(name, out=out, note=label, live=live, emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    m = res["manifest"]
    ui.ok(f"✓ backed up {res['name']!r} ({m['rc_version']}) — {_human_bytes(res['bytes'])}")
    typer.echo(f"    {res['path']}")
    if m.get("sidecar_volumes"):
        ui.warn("  sidecar data is NOT included: " + ", ".join(m["sidecar_volumes"]))
    ui.hint(f"  restore it:  houston restore {res['path']}")


def backups_cmd(
    name: str = typer.Option("", "--name", "-n", help="only bundles from this repro"),
) -> None:
    """List backup bundles in ~/.houston/backups/, newest first."""
    from houston.services import backup as backupsvc
    rows = backupsvc.list_backups(name)
    if not rows:
        ui.note("no backups yet — make one with `houston backup`")
        return
    for r in rows:
        if r["error"]:
            ui.warn(f"  {Path(r['path']).name}  UNREADABLE: {r['error']}")
            continue
        label = f"  ({r['label']})" if r["label"] else ""
        typer.echo(f"  {Path(r['path']).name}")
        typer.echo(f"      {r['repro']}  RC {r['rc_version']}  "
                   f"{_human_bytes(r['bytes'])}  {r['created_at']}{label}")
        if r.get("predates_workspace"):
            # Bundles outlive their workspace and are matched by NAME, and houston
            # derives names from the version -- so recreating a workspace inherits
            # the old one's backups with nothing to say they are not its own.
            ui.warn("      ^ from an EARLIER workspace of this name, not the one "
                    "running now — restoring it loads that workspace's data")


def restore_cmd(
    bundle: str = typer.Argument(..., help="path to a .rcbak bundle"),
    name: str = typer.Option("", "--name", "-n", help="restore into this repro (default: the one it came from)"),
    new: bool = typer.Option(False, "--new", help="create a fresh repro from the bundle instead of restoring into an existing one"),
    allow_upgrade: bool = typer.Option(False, "--allow-upgrade", help="permit restoring older data into a newer workspace (Rocket.Chat will migrate it)"),
    force: bool = typer.Option(False, "--force", help="ignore compatibility refusals"),
) -> None:
    """Restore a backup bundle into a repro.

    Three targets:

      houston restore B                  in place — the repro it came from
      houston restore B --new            a fresh repro built from the bundle
      houston restore B --name other     an existing, different repro

    Existing collections are DROPPED, so the result is the backup's data and not a
    merge of the two. Downgrading (newer data into an older workspace) is refused:
    Rocket.Chat does not migrate a database backwards.
    """
    from houston.services import backup as backupsvc
    try:
        res = backupsvc.restore(bundle, name=name, new=new,
                                allow_upgrade=allow_upgrade, force=force,
                                emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    what = "created and restored" if res["created"] else "restored"
    ui.ok(f"✓ {what} {res['name']!r} from {Path(res['bundle']).name} "
          f"in {res['restore_seconds']}s")
    if res["direction"] == "upgrade":
        ui.warn(f"  {res['from_version']} data now runs on {res['to_version']} — "
                "Rocket.Chat has migrated it")
    if res.get("url"):
        ui.hint(f"  {res['url']}")


def _render_upgrade(dry_run, force, name, no_backup, no_rollback, offline, p, to, upgradesvc):
    """Show the plan, do the upgrade, and report what actually came back."""
    ui.panel(f"upgrade: {p['name']}", [
        ("Rocket.Chat", f"{p['from_version']}  ->  {p['to_version']}"),
        ("MongoDB", f"{p['from_mongo']}" + ("" if p["from_mongo"] == p["to_mongo"]
                                            else f"  ->  {p['to_mongo']}")),
        ("image", f"{p['rc_image']}:{p['to_version']}"),
        ("source", p["source"]),
    ])
    for line in p["warnings"]:
        ui.warn("  " + line)
    if not p["allowed"]:
        (ui.warn if force else ui.fail)("  " + p["blocked_reason"])
        if not force:
            ui.hint("  --force overrides this, but expect it to fail")
            raise typer.Exit(1)
    if dry_run:
        ui.note("  --dry-run: nothing changed")
        return

    try:
        res = upgradesvc.run(name, to, offline=offline, force=force,
                             no_backup=no_backup,
                             rollback_on_failure=not no_rollback, emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    ui.ok(f"✓ {res['name']!r} upgraded {res['from_version']} -> {res['to_version']} "
          f"in {res['boot_seconds']}s")
    # ONLY WHEN IT DISAGREES. `wait_ready` reads the UNAUTHENTICATED `/api/info`,
    # which reports the minor alone -- so a successful upgrade to 8.5.3 printed
    # "Rocket.Chat reports 8.5" directly under "upgraded 8.5.1 -> 8.5.3", which reads
    # as a contradiction on the one command whose entire purpose is changing the
    # version. Agreement is the expected case and saying it in a narrower form than
    # the line above is worse than not saying it; disagreement is the fact worth
    # printing, and the check is a prefix for the same truncation reason.
    running = res["running_version"]
    if running and running != "?" and not str(res["to_version"]).startswith(running):
        ui.warn(f"    but Rocket.Chat reports {running} — the upgrade did not land "
                f"the image you asked for")
    if res["migration_errors"]:
        ui.warn(f"  {len(res['migration_errors'])} migration error(s) in the boot log:")
        for line in res["migration_errors"]:
            typer.echo(f"      {line}")
    if res["backup"]:
        ui.hint(f"  roll back:  houston upgrade --rollback --name {res['name']}")


def upgrade_cmd(
    to: str = typer.Option("", "--to", help="target Rocket.Chat version, e.g. 8.6.1"),
    name: str = typer.Option("", "--name", "-n"),
    dry_run: bool = typer.Option(False, "--dry-run", help="show what would happen and stop"),
    no_backup: bool = typer.Option(False, "--no-backup", help="skip the automatic pre-upgrade backup (no rollback will be possible)"),
    no_rollback: bool = typer.Option(False, "--no-rollback", help="leave a failed upgrade in place instead of rolling it back"),
    rollback: bool = typer.Option(False, "--rollback", help="undo the last upgrade from its pre-upgrade backup"),
    bundle: str = typer.Option("", "--bundle", help="with --rollback: restore this bundle instead of the recorded one"),
    offline: bool = typer.Option(False, "--offline", help="resolve the version from the built-in map, no network (so a version that was never released still resolves — the map matches on the series)"),
    force: bool = typer.Option(False, "--force", help="ignore refusals (downgrades, MongoDB major changes)"),
) -> None:
    """Upgrade a RUNNING repro to another Rocket.Chat version.

    Rocket.Chat runs its database migrations on boot, so this is the honest way to
    reproduce "it broke after we upgraded": real data, real migrations. A
    pre-upgrade backup is taken automatically and `--rollback` restores it.

    The repro has to be running — the backup needs MongoDB up, and the migrations
    only happen when Rocket.Chat boots.
    """
    from houston.services import upgrade as upgradesvc
    if rollback:
        try:
            res = upgradesvc.rollback(name, bundle=bundle, emit=_cli_emit)
        except errors.ReproError as exc:
            _fail(exc)
        ui.ok(f"✓ {res['name']!r} rolled back to {res['rolled_back_to']}")
        return

    if not to:
        _err("no target version given — use `--to 8.6.1` (or `--rollback` to undo)")
    try:
        p = upgradesvc.plan(name, to, offline=offline)
    except errors.ReproError as exc:
        _fail(exc)

    return _render_upgrade(dry_run, force, name, no_backup, no_rollback, offline, p, to, upgradesvc)
