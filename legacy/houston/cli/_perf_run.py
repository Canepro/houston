"""The capacity search, and the three preflight helpers both perf commands share.

A leaf, not a command module: it parses no options and renders no terminal output that
`_perf_render` does not already own. `capacity` and `loadtest` are two subjects, and
keeping both in one file left it at 721 code lines after the functions themselves were
already decomposed."""
from __future__ import annotations

from datetime import datetime
from datetime import timezone
from houston import config
from houston import errors
from houston import jsonout
from houston import rcapi
from houston import runner
from houston import ui
from houston.cli._common import _err
from houston.cli._common import _fail
from houston.cli._common import _login
from houston.cli._common import _not_answering
from houston.cli._common import _rc_services_in
from houston.cli._common import _resolve_name
from houston.cli._perf_render import _login_seed_users
from houston.perf import report as perf_report
from houston.perf.timings import fmt_ms
from houston.services import journal
import dataclasses
import os
import platform
import typer


def _perf_modules():
    """Load optional performance modules only after Docker preflight succeeds."""
    from types import SimpleNamespace
    from houston import monitoring
    from houston.perf import (baseline, constrain as constrain_mod, k6, mongoprof,
                              rcmetrics, slo as slo_mod, timeline as timeline_mod,
                              verdict as verdict_mod)
    return SimpleNamespace(
        monitoring=monitoring, baseline=baseline, constrain=constrain_mod, k6=k6,
        mongoprof=mongoprof, rcmetrics=rcmetrics, slo=slo_mod,
        timeline=timeline_mod, verdict=verdict_mod)


def _loadtest_target(doc: dict) -> str:
    """The in-network URL k6 should hit. Multi-instance repros front RC with
    Traefik; single-instance ones expose `rocketchat` (or `rocketchat-1`)."""
    svcs = doc.get("services", {})
    if "traefik" in svcs:
        return "http://traefik:80"
    rc = _rc_services_in(doc)
    if "rocketchat" in rc:
        return "http://rocketchat:3000"
    if rc:
        return f"http://{rc[0]}:3000"
    return "http://rocketchat:3000"


def _require_perf_workspace(name, operation):
    """Refuse non-Compose workspaces with the CLI's typed error rendering."""
    from houston.services import perf as perfsvc
    resolved = _resolve_name(name)
    try:
        perfsvc.require_compose_for_perf(resolved, operation)
    except errors.ReproError as exc:
        _fail(exc)
    meta = runner.read_meta(_resolve_name(name))
    compose = runner.read_compose(meta.name)
    return meta, compose, _loadtest_target(compose)


def _resolve_constraints(mods, constraints, compose):
    """Map user-facing service groups to the services in this workspace."""
    if not constraints:
        return {}
    try:
        return mods.constrain.resolve_services(
            constraints, list(compose.get("services", {})))
    except ValueError as exc:
        _err(f"bad --constrain: {exc}")


@dataclasses.dataclass
class _CapacityOptions:
    name: str
    scenario: str
    users_n: int
    slo: str
    start: int
    max_vus: int
    step_duration: str
    constrain: str
    report: bool
    report_path: str
    json_out: bool


@dataclasses.dataclass
class _CapacityRun:
    applied_constraints: list = dataclasses.field(default_factory=list)
    limiter_was_off: bool = True
    limiter_note: str = ""
    constrain_note: str = ""
    metrics_note: str = ""
    metrics_changed: bool = False
    steps: list = dataclasses.field(default_factory=list)
    last_pass: int | None = None
    first_fail: int | None = None


def _validate_capacity(opts, mods):
    """Parse the SLO and constraints and reject unsupported search shapes."""
    if opts.scenario not in mods.k6.SCENARIOS or opts.scenario in ("custom", "webhook"):
        _err("capacity supports the built-in scenarios (journey/messages/read/mixed/login/badbot)")
    try:
        rules = mods.slo.parse(opts.slo)
    except ValueError as exc:
        _err(f"bad --slo: {exc}")
    if opts.start < 1 or opts.max_vus < opts.start:
        _err("--start must be >= 1 and --max >= --start")
    try:
        constraints = mods.constrain.parse(opts.constrain) if opts.constrain else {}
    except ValueError as exc:
        _err(f"bad --constrain: {exc}")
    return rules, constraints


def _capacity_identity(meta, users_n):
    """Create the admin PAT and any seeded-user identities for a search."""
    try:
        auth = _login(meta)
        token = rcapi.generate_pat(
            meta.root_url, auth, meta.admin_pass, token_name="houston-loadtest",
            bypass_2fa=True, workspace=meta.name)
    except Exception as exc:  # noqa: BLE001
        _not_answering(meta, exc, "this API call")
    users = _login_seed_users(meta, users_n) if users_n > 0 else []
    return auth, token, users


def _capacity_step(state, opts, mods, meta, rc_services, auth, token, users,
                   target, n, tag=""):
    """Measure and render one concurrency point in the capacity search."""
    sampler = mods.rcmetrics.RCMetricsSampler(meta.name, rc_services).start()
    try:
        summary = mods.k6.run(
            meta.name, opts.scenario, vus=n, duration=opts.step_duration, ramp=None,
            token=token, uid=auth.user_id, target=target, users=users or None,
            password=meta.admin_pass, quiet=True)
    finally:
        metrics = sampler.stop()
    evaluated = mods.slo.evaluate(state.rules, summary)
    lag_max = 0.0
    for service_metrics in metrics.values():
        lag = (service_metrics.get("eventloop_lag_max_s")
               or service_metrics.get("eventloop_lag_s"))
        if lag:
            lag_max = max(lag_max, lag["max"])
    row = {"vus": n, "rps": summary.get("rps", 0.0),
           "p95": summary.get("p95", 0.0),
           "error_rate": summary.get("error_rate", 0.0),
           "ok": all(item["ok"] for item in evaluated), "lag_max_s": lag_max,
           "breached": [f"{item['key']} {item['op']} {item['raw']} "
                        f"(actual {mods.slo.fmt_actual(item['key'], item['actual'])})"
                        for item in evaluated if not item["ok"]]}
    state.steps.append(row)
    if not opts.json_out:
        mark = (typer.style("PASS", fg=typer.colors.GREEN) if row["ok"] else
                typer.style(f"FAIL ({'; '.join(row['breached'])})", fg=typer.colors.RED))
        typer.echo(f"  {n:>4} VUs{tag:<9}  {row['rps']:>7.1f} req/s   "
                   f"p95 {fmt_ms(row['p95']):>7}   err {row['error_rate'] * 100:>5.2f}%   {mark}")
    return row


def _prepare_capacity(state, opts, mods, meta, auth, per_service, users):
    """Apply caps and enable the settings needed throughout the search."""
    if per_service:
        try:
            state.applied_constraints = mods.constrain.apply(meta.name, per_service)
        except RuntimeError as exc:
            _err(f"could not apply --constrain: {exc}")
        state.constrain_note = journal.record(
            journal.CONSTRAINTS_APPLIED, meta.name,
            applied=[dataclasses.asdict(item) for item in state.applied_constraints])
    state.limiter_was_off = rcapi.get_setting(
        meta.root_url, auth, meta.admin_pass, config.RC_RATE_LIMITER_SETTING) is False
    if not state.limiter_was_off:
        state.limiter_note = journal.record(journal.RATE_LIMITER_OFF, meta.name)
        rcapi.set_setting(meta.root_url, auth, meta.admin_pass,
                          config.RC_RATE_LIMITER_SETTING, False)
    if rcapi.get_setting(meta.root_url, auth, meta.admin_pass,
                         mods.monitoring.RC_METRICS_SETTING) is not True:
        state.metrics_note = journal.record(journal.RC_METRICS_ON, meta.name)
        state.metrics_changed = rcapi.set_setting(
            meta.root_url, auth, meta.admin_pass,
            mods.monitoring.RC_METRICS_SETTING, True)
    if not opts.json_out:
        identity = f"{len(users)} seeded users" if users else "admin token"
        suffix = (f", constrained {mods.constrain.human(per_service)}"
                  if per_service else "")
        typer.secho(f"Capacity search: {opts.scenario} as {identity}, SLO {opts.slo} "
                    f"(steps of {opts.step_duration}{suffix})\n", bold=True)


def _search_capacity(state, opts, run_step):
    """Double concurrency until breach, then tighten the boundary twice."""
    n = opts.start
    while n <= opts.max_vus:
        row = run_step(n)
        if row["ok"]:
            state.last_pass = n
            n *= 2
        else:
            state.first_fail = n
            break
    if state.first_fail and state.last_pass:
        low, high = state.last_pass, state.first_fail
        for _ in range(2):
            middle = (low + high) // 2
            if middle <= low or middle >= high:
                break
            row = run_step(middle, tag=" (bisect)")
            if row["ok"]:
                low = state.last_pass = middle
            else:
                high = state.first_fail = middle


def _restore_capacity(state, mods, meta, auth):
    """Restore settings, caps, and transient seeded-user credentials."""
    if not state.limiter_was_off:
        try:
            rcapi.set_setting(meta.root_url, auth, meta.admin_pass,
                              config.RC_RATE_LIMITER_SETTING, True)
        except Exception:  # noqa: BLE001
            ui.warn("  ⚠ could not restore the API rate limiter setting")
        else:
            journal.clear(state.limiter_note)
    if state.metrics_changed:
        try:
            rcapi.set_setting(meta.root_url, auth, meta.admin_pass,
                              mods.monitoring.RC_METRICS_SETTING, False)
            journal.clear(state.metrics_note)
        except Exception:  # noqa: BLE001
            ui.warn("  ⚠ could not restore the Prometheus metrics setting")
    problems = mods.constrain.restore(state.applied_constraints)
    for problem in problems:
        ui.warn(f"  ⚠ could not restore resource limits — {problem}")
    if not problems:
        journal.clear(state.constrain_note)
    (runner.workspace(meta.name) / "loadtest" / "users.json").unlink(missing_ok=True)


def _execute_capacity(opts, mods, meta, compose, target, auth, token, users,
                      per_service, rules):
    """Run capacity setup, search, and guaranteed restoration."""
    state = _CapacityRun()
    state.rules = rules
    rc_services = _rc_services_in(compose) or ["rocketchat"]
    run_step = lambda n, tag="": _capacity_step(
        state, opts, mods, meta, rc_services, auth, token, users, target, n, tag)
    try:
        _prepare_capacity(state, opts, mods, meta, auth, per_service, users)
        _search_capacity(state, opts, run_step)
    finally:
        _restore_capacity(state, mods, meta, auth)
    return state


def _capacity_result(state, opts):
    """Describe the measured boundary and the refined breach reason."""
    if state.last_pass is None:
        result = f"breaches the SLO even at {opts.start} VUs — start lower (--start)"
    elif state.first_fail is None:
        result = (f"holds the SLO up to {state.last_pass} VUs "
                  "(never breached; raise --max to push further)")
    else:
        result = (f"~{state.last_pass} concurrent VUs (holds at {state.last_pass}, "
                  f"breaks at {state.first_fail})")
    breach = (next((row for row in state.steps if row["vus"] == state.first_fail), None)
              if state.first_fail else next((row for row in state.steps if not row["ok"]), None))
    why = ""
    if breach and breach["lag_max_s"] >= 0.5:
        why = (f"at {breach['vus']} VUs the RC event loop saturated "
               f"(lag peaked at {fmt_ms(breach['lag_max_s'] * 1000)})")
    elif breach:
        why = f"at {breach['vus']} VUs: {'; '.join(breach['breached'])}"
    return result, why


def _finish_capacity(opts, mods, meta, users, target, per_service, state):
    """Render, report, and optionally emit the capacity JSON envelope."""
    result, why = _capacity_result(state, opts)
    if not opts.json_out:
        typer.echo("")
        typer.secho(f"Capacity: {result}", bold=True,
                    fg=typer.colors.GREEN if state.last_pass else typer.colors.RED)
        if why:
            ui.note(f"  why it broke: {why}")
    ctx = {"name": meta.name, "version": meta.rc_version, "scenario": opts.scenario,
           "slo": opts.slo, "users": len(users), "step_duration": opts.step_duration,
           "target": target,
           "constrained": mods.constrain.human(per_service) if per_service else ""}
    if opts.report or opts.report_path:
        host = {"os": platform.platform(), "cpu": os.cpu_count() or "?",
                "docker": runner.docker_server_version() or "?",
                "compose": runner.compose_version() or "?"}
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        path = perf_report.write_capacity(
            ctx, state.steps, result, why, host, stamp, dest=opts.report_path or None)
        if not opts.json_out:
            typer.echo("")
            ui.ok(f"✓ wrote {path}")
    if opts.json_out:
        jsonout.reply("capacity", {"ctx": ctx, "steps": state.steps,
                                   "capacity_vus": state.last_pass,
                                   "breach_vus": state.first_fail,
                                   "result": result, "why": why})


def _run_capacity_command(opts):
    """Validate, execute, and render one CLI capacity search."""
    mods = _perf_modules()
    rules, constraints = _validate_capacity(opts, mods)
    meta, compose, target = _require_perf_workspace(opts.name, "capacity")
    per_service = _resolve_constraints(mods, constraints, compose)
    auth, token, users = _capacity_identity(meta, opts.users_n)
    state = _execute_capacity(
        opts, mods, meta, compose, target, auth, token, users, per_service, rules)
    _finish_capacity(opts, mods, meta, users, target, per_service, state)
