"""Driving real load at a workspace and reading the answer: `loadtest` `capacity`.

Both are CLI-only renderings over `services/perf.py`, which the GUI reaches as a job --
the measurement is shared, the presentation is not.

`_login_seed_users` POSTs `/api/v1/login` directly rather than through `rcapi`, which is
a recorded bypass of the REST seam (`tools/seam_check.py` counts it, by name, so it
cannot multiply while it waits for phase 5).
"""
from __future__ import annotations

import dataclasses
import os
import platform
import time
from dataclasses import asdict as dc_asdict
from datetime import datetime, timezone

import typer

from houston import config, jsonout, perf, rcapi, runner, ui
from houston.perf import report as perf_report
from houston.perf.timings import fmt_ms
from houston.services import journal
from houston.cli._common import _HTTP_METHODS, _err, _login, _not_answering, _rc_services_in, _require_docker
from houston.cli._perf_render import _load_shape, _login_seed_users, _print_compare, _print_diag, _print_loadtest, _workspace_snapshot
from houston.cli._render import _print_resources, _short_res_map
from houston.cli._perf_run import _CapacityOptions, _perf_modules, _require_perf_workspace, _resolve_constraints, _run_capacity_command


def _parse_endpoint(endpoint: str) -> tuple[str, str]:
    """'GET /api/v1/x' -> ('GET', '/api/v1/x'); a bare '/api/v1/x' defaults to GET.
    Raises ValueError on an empty/non-absolute path or an unsupported method."""
    e = endpoint.strip()
    if not e:
        raise ValueError("empty endpoint")
    parts = e.split(None, 1)
    if len(parts) == 2 and parts[0].isalpha():
        # First token looks like a method — it must be a supported one.
        if parts[0].upper() not in _HTTP_METHODS:
            raise ValueError(f"unsupported method {parts[0]!r} (use {', '.join(sorted(_HTTP_METHODS))})")
        method, path = parts[0].upper(), parts[1].strip()
    else:
        method, path = "GET", e
    if not path.startswith("/"):
        raise ValueError(f"path must start with '/': {path!r}")
    return method, path


def _parse_ramp(ramp: str) -> tuple[int, int]:
    """'10:200' -> (10, 200). Raises ValueError on a malformed spec."""
    parts = ramp.split(":")
    if len(parts) != 2:
        raise ValueError("ramp must be START:END, e.g. 10:200")
    try:
        start, end = int(parts[0]), int(parts[1])
    except ValueError:
        raise ValueError("ramp START and END must be integers, e.g. 10:200")
    if start < 0 or end < 1:
        raise ValueError("ramp needs START >= 0 and END >= 1, e.g. 10:200")
    return start, end




@dataclasses.dataclass
class _LoadOptions:
    name: str
    scenario: str
    endpoint: str
    body: str
    vus: int
    users_n: int
    duration: str
    ramp: str
    spike: str
    live: bool
    slo: str
    constrain: str
    diag: bool
    slowms: int
    stats: bool
    save: str
    compare: str
    json_out: bool
    report: bool
    report_path: str


@dataclasses.dataclass
class _LoadRun:
    applied_constraints: list = dataclasses.field(default_factory=list)
    limiter_was_off: bool = True
    limiter_note: str = ""
    constrain_note: str = ""
    metrics_note: str = ""
    mongo_note: str = ""
    metrics_changed: bool = False
    mongo_prior: object = None
    sampler: object = None
    monitor: object = None
    resources: object = None
    summary: object = None
    rcmetrics: dict = dataclasses.field(default_factory=dict)
    since_ms: int = 0




def _load_warning(opts, warnings, msg):
    """Keep machine-mode warnings in the payload and prose-mode warnings on stderr."""
    if opts.json_out:
        warnings.append(msg.strip().lstrip("⚠ "))
    else:
        ui.warn(msg)


def _custom_endpoint(opts):
    """Validate and render the environment for a custom request scenario."""
    if opts.scenario != "custom":
        if opts.endpoint or opts.body:
            _err("--endpoint/--body only apply to --scenario custom")
        return None, "", ""
    if not opts.endpoint:
        _err("--scenario custom needs --endpoint, e.g. --endpoint \"GET /api/v1/channels.list\"")
    try:
        method, path = _parse_endpoint(opts.endpoint)
    except ValueError as exc:
        _err(f"bad --endpoint: {exc}")
    if opts.body and method in ("GET", "DELETE"):
        _err(f"--body is not sent with a {method} request")
    return {"RC_METHOD": method, "RC_PATH": path, "RC_BODY": opts.body or None}, method, path


def _validate_load_options(opts, mods, warn):
    """Validate CLI-only load shapes and parse constraint and SLO expressions."""
    if opts.scenario not in mods.k6.SCENARIOS:
        _err(f"unknown scenario {opts.scenario!r} (choose: {', '.join(mods.k6.SCENARIOS)})")
    extra_env, method, path = _custom_endpoint(opts)
    if opts.vus < 1:
        _err("--vus must be >= 1")
    if opts.users_n < 0:
        _err("--users must be >= 0")
    if opts.ramp and opts.spike:
        _err("--ramp and --spike are mutually exclusive load shapes")
    for kind, shape in (("ramp", opts.ramp), ("spike", opts.spike)):
        if not shape:
            continue
        try:
            start, end = _parse_ramp(shape)
        except ValueError as exc:
            _err(f"bad --{kind}: {exc}")
        if kind == "spike" and end <= start:
            _err(f"--spike peak must exceed base ({shape!r})")
        if opts.vus != 10:
            warn(f"  note: --vus is ignored when --{kind} is given")
    for label in (opts.save, opts.compare):
        if label:
            try:
                mods.baseline.sanitize_label(label)
            except ValueError as exc:
                _err(str(exc))
    try:
        constraints = mods.constrain.parse(opts.constrain) if opts.constrain else {}
    except ValueError as exc:
        _err(f"bad --constrain: {exc}")
    try:
        rules = mods.slo.parse(opts.slo) if opts.slo else []
    except ValueError as exc:
        _err(f"bad --slo: {exc}")
    return extra_env, method, path, constraints, rules




def _check_live_monitoring(opts, meta, compose):
    """Require a current remote-write-capable monitoring attachment for --live."""
    if not opts.live:
        return
    if not (isinstance(meta.extra, dict) and meta.extra.get("monitoring")):
        _err(f"--live needs the monitoring stack — attach it first: houston monitor --name {meta.name}")
    prom_cmd = (compose.get("services", {}).get("prometheus") or {}).get("command", [])
    if not any("remote-write-receiver" in str(command) for command in prom_cmd):
        _err("--live needs Prometheus with remote-write enabled, but this repro's "
             "monitoring predates it. Re-attach it: "
             f"houston monitor --name {meta.name} --off && houston monitor --name {meta.name}")




def _load_baseline(mods, label):
    """Read a comparison baseline before starting any load."""
    if not label:
        return None
    try:
        return mods.baseline.load(label)
    except (FileNotFoundError, ValueError) as exc:
        _err(str(exc))


def _loadtest_identity(opts, meta, warn):
    """Create the admin PAT and optional seeded-user identities."""
    try:
        auth = _login(meta)
        token = rcapi.generate_pat(
            meta.root_url, auth, meta.admin_pass, token_name="houston-loadtest",
            bypass_2fa=True, workspace=meta.name)
    except Exception as exc:  # noqa: BLE001
        _not_answering(meta, exc, "this API call")
    users = []
    if opts.users_n > 0 and opts.scenario != "custom":
        users = _login_seed_users(meta, opts.users_n)
        if not users:
            warn("  ⚠ no seeded users could log in — using the admin token "
                 "(run `houston seed` first for realistic multi-user load)")
    return auth, token, users


def _webhook_environment(opts, meta, auth, extra_env):
    """Create the integration required by the webhook load scenario."""
    if opts.scenario != "webhook":
        return extra_env
    hook_path = rcapi.create_incoming_webhook(meta.root_url, auth, meta.admin_pass)
    if not hook_path:
        _err("could not create the incoming webhook integration (check admin permissions)")
    return {**(extra_env or {}), "RC_HOOK_PATH": hook_path}


def _apply_load_constraints(state, opts, mods, meta, auth, snapshot, per_service, warn):
    """Apply customer-sized caps and disable throttling before the run."""
    if per_service:
        try:
            state.applied_constraints = mods.constrain.apply(meta.name, per_service)
        except RuntimeError as exc:
            _err(f"could not apply --constrain: {exc}")
        # This CLI path journals the same persistent side effects as services/perf.
        state.constrain_note = journal.record(
            journal.CONSTRAINTS_APPLIED, meta.name,
            applied=[dataclasses.asdict(item) for item in state.applied_constraints])
        snapshot["constraints"] = mods.constrain.human(per_service)
        if not opts.json_out:
            ui.note(f"  constrained: {snapshot['constraints']} (restored after the test)")
    state.limiter_was_off = rcapi.get_setting(
        meta.root_url, auth, meta.admin_pass,
        config.RC_RATE_LIMITER_SETTING) is False
    if not state.limiter_was_off:
        state.limiter_note = journal.record(journal.RATE_LIMITER_OFF, meta.name)
        if not rcapi.set_setting(meta.root_url, auth, meta.admin_pass,
                                 config.RC_RATE_LIMITER_SETTING, False):
            journal.clear(state.limiter_note)
            state.limiter_note = ""
            warn("  ⚠ could not disable the API rate limiter — results may be throttled (429s)")


def _announce_loadtest(opts, meta, label, load, identity, target):
    """Print the run banner and live-dashboard hint in prose mode."""
    if opts.json_out:
        return
    typer.secho(f"Load test: {label} @ {load} as {identity} -> {target} "
                f"(via k6 on {meta.name!r}'s network)\n", bold=True)
    if opts.live:
        grafana = f"http://localhost:{config.MONITOR_PORTS[1]}"
        ui.note("  live: k6 metrics streaming into Prometheus — open the "
                f"'k6 Load Test' dashboard in Grafana ({grafana}), "
                "or Explore -> k6_*")


def _enable_load_diagnostics(state, opts, mods, meta, auth, warn):
    """Arm Rocket.Chat metrics and Mongo profiling for diagnostic runs."""
    if not opts.diag:
        return
    if rcapi.get_setting(meta.root_url, auth, meta.admin_pass,
                         mods.monitoring.RC_METRICS_SETTING) is not True:
        state.metrics_note = journal.record(journal.RC_METRICS_ON, meta.name)
        state.metrics_changed = rcapi.set_setting(
            meta.root_url, auth, meta.admin_pass,
            mods.monitoring.RC_METRICS_SETTING, True)
    state.mongo_prior = mods.mongoprof.start(meta.name, opts.slowms)
    if state.mongo_prior is None:
        warn("  ⚠ Mongo slow-query capture unavailable (profiler could not be enabled)")
    else:
        state.mongo_note = journal.record(
            journal.MONGO_PROFILER_ON, meta.name, prior=state.mongo_prior)


def _run_k6_load(state, opts, mods, meta, compose, auth, token, users,
                 target, extra_env):
    """Start optional samplers and execute the one k6 process."""
    rc_services = _rc_services_in(compose) or ["rocketchat"]
    state.monitor = perf.ResourceMonitor(meta.name).start() if opts.stats else None
    state.since_ms = int(time.time() * 1000)
    if opts.diag:
        state.sampler = mods.rcmetrics.RCMetricsSampler(meta.name, rc_services).start()
    state.summary = mods.k6.run(
        meta.name, opts.scenario, vus=opts.vus, duration=opts.duration,
        ramp=opts.ramp or None, token=token, uid=auth.user_id, target=target,
        extra_env=extra_env, users=users or None, password=meta.admin_pass,
        quiet=opts.json_out, timeline=opts.diag or bool(opts.spike),
        spike=opts.spike or None, live=opts.live)


def _restore_loadtest(state, opts, mods, meta, auth, warn):
    """Restore every mutable setting and remove transient credentials."""
    (runner.workspace(meta.name) / "loadtest" / "users.json").unlink(missing_ok=True)
    if state.sampler:
        state.rcmetrics = state.sampler.stop()
    if state.monitor:
        state.resources = state.monitor.stop()
    if not state.limiter_was_off:
        try:
            rcapi.set_setting(meta.root_url, auth, meta.admin_pass,
                              config.RC_RATE_LIMITER_SETTING, True)
            journal.clear(state.limiter_note)
        except Exception:  # noqa: BLE001 - best-effort restore
            warn("  ⚠ could not restore the API rate limiter setting")
    if state.metrics_changed:
        try:
            rcapi.set_setting(meta.root_url, auth, meta.admin_pass,
                              mods.monitoring.RC_METRICS_SETTING, False)
            journal.clear(state.metrics_note)
        except Exception:  # noqa: BLE001
            warn("  ⚠ could not restore the Prometheus metrics setting")
    if state.mongo_prior:
        try:
            mods.mongoprof.stop(meta.name, state.mongo_prior)
            journal.clear(state.mongo_note)
        except Exception:  # noqa: BLE001
            warn("  ⚠ could not restore the Mongo profiler level")
    problems = mods.constrain.restore(state.applied_constraints)
    for problem in problems:
        warn(f"  ⚠ could not restore resource limits — {problem}")
    if not problems:
        journal.clear(state.constrain_note)


def _execute_loadtest(opts, mods, meta, compose, auth, token, users, target,
                      extra_env, snapshot, per_service, label, load, identity, warn):
    """Run setup, measurement, and guaranteed restoration as one transaction."""
    state = _LoadRun(since_ms=int(time.time() * 1000))
    try:
        _apply_load_constraints(
            state, opts, mods, meta, auth, snapshot, per_service, warn)
        _announce_loadtest(opts, meta, label, load, identity, target)
        _enable_load_diagnostics(state, opts, mods, meta, auth, warn)
        _run_k6_load(
            state, opts, mods, meta, compose, auth, token, users, target, extra_env)
    except typer.Exit:
        # A refusal already made -- `_apply_load_constraints`' own `_err`. Click's `Exit` IS a
        # RuntimeError, so the clause below caught it and `_err`'d its exit code: a second
        # "error: 1" line, a second REPRO_ERROR record, and under --json a second envelope
        # after the first, where the contract is exactly one.
        raise
    except RuntimeError as exc:
        _err(str(exc))
    finally:
        _restore_loadtest(state, opts, mods, meta, auth, warn)
    return state


def _warn_baseline_differences(opts, base, ctx, snapshot, warn):
    """Explain comparisons whose scenario, load shape, or hardware differs."""
    if base and (base.get("ctx") or {}).get("scenario") not in (None, opts.scenario):
        warn(f"  ⚠ baseline {opts.compare!r} was a {(base['ctx']or{}).get('scenario')!r} run — "
             "comparing across scenarios")
    if base and _load_shape(base.get("ctx") or {}) != _load_shape(ctx):
        warn(f"  ⚠ baseline {opts.compare!r} ran a different load shape "
             f"({_load_shape(base.get('ctx') or {})} vs {_load_shape(ctx)}) — "
             "deltas reflect the offered load, not just the workspace")
    old_constraints = (base.get("snapshot") or {}).get("constraints") if base else None
    if base and old_constraints != snapshot.get("constraints"):
        warn(f"  ⚠ baseline {opts.compare!r} ran under different resource constraints "
             f"({old_constraints or 'none'} vs {snapshot.get('constraints') or 'none'}) — "
             "deltas reflect the hardware change")


def _collect_load_results(opts, mods, meta, users, target, snapshot, state,
                          rules, base, label, warn):
    """Read diagnostic artifacts and derive SLO, comparison, and verdict data."""
    mongo = (mods.mongoprof.collect(meta.name, state.since_ms)
             if opts.diag and state.mongo_prior else None)
    timeline = None
    if opts.diag or opts.spike:
        points = runner.workspace(meta.name) / "loadtest" / "points.json"
        timeline = mods.timeline.parse(points)
        points.unlink(missing_ok=True)
    ctx = {"name": meta.name, "version": meta.rc_version, "scenario": opts.scenario,
           "vus": opts.vus, "duration": opts.duration, "ramp": opts.ramp,
           "spike": opts.spike, "target": target, "label": label,
           "users": len(users), "constrained": snapshot.get("constraints", "")}
    slo_results = mods.slo.evaluate(rules, state.summary) if rules else []
    compare_rows = mods.baseline.compare({"summary": state.summary}, base) if base else []
    _warn_baseline_differences(opts, base, ctx, snapshot, warn)
    short_res = _short_res_map(state.resources, meta.name) if state.resources else None
    spike_rec = mods.timeline.spike_recovery(timeline) if opts.spike and timeline else None
    soak = (_short_res_map(state.monitor.mem_slopes(), meta.name)
            if state.monitor else None)
    verdict = (mods.verdict.analyze(
        state.summary, rcmetrics=state.rcmetrics or None, mongo=mongo,
        resources=short_res, timeline=timeline, soak=soak or None, spike=spike_rec)
        if opts.diag else [])
    diag = ({"rcmetrics": state.rcmetrics, "mongo": mongo, "timeline": timeline,
             "spike": spike_rec, "verdict": verdict} if opts.diag else None)
    return {"ctx": ctx, "slo": slo_results, "compare": compare_rows,
            "short_res": short_res, "spike": spike_rec, "diag": diag,
            "mongo": mongo, "timeline": timeline, "verdict": verdict}


def _render_load_results(opts, meta, state, result, base):
    """Render the human load-test summary in its established order."""
    if opts.json_out:
        return
    typer.echo("")
    _print_loadtest(result["ctx"], state.summary, result["slo"])
    spike = result["spike"]
    if spike:
        recovered = spike["recovered_after_s"]
        msg = (f"  spike: baseline p95 {fmt_ms(spike['baseline_p95'])} -> peak "
               f"{fmt_ms(spike['spike_p95'])} -> "
               + (f"recovered ~{recovered}s after load dropped" if recovered is not None
                  else "NOT recovered within the run"))
        (ui.ok if recovered is not None and recovered <= 30 else ui.warn)(msg)
    if opts.diag:
        _print_diag(state.rcmetrics, result["mongo"], result["timeline"],
                    result["verdict"], meta.name)
    if result["compare"]:
        _print_compare(result["compare"], base)
    _print_resources(state.resources or {}, meta.name)


def _save_load_outputs(opts, mods, meta, state, snapshot, result, base):
    """Persist an optional baseline and Markdown report after rendering."""
    saved_to = report_file = ""
    if opts.save:
        label = mods.baseline.sanitize_label(opts.save)
        saved_to = mods.baseline.save(opts.save, {
            "label": label, "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "ctx": result["ctx"], "summary": state.summary, "snapshot": snapshot})
        if not opts.json_out:
            typer.echo("")
            ui.ok(f"✓ saved baseline {label!r} (compare later with --compare {label})")
    if opts.report or opts.report_path:
        host = {"os": platform.platform(), "cpu": os.cpu_count() or "?",
                "docker": runner.docker_server_version() or "?",
                "compose": runner.compose_version() or "?"}
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        report_file = perf_report.write_loadtest(
            result["ctx"], state.summary, result["slo"], result["short_res"], host,
            stamp, dest=opts.report_path or None, snapshot=snapshot,
            compare={"label": base.get("label"), "saved_at": base.get("saved_at"),
                     "rows": result["compare"]} if base else None,
            diag=result["diag"])
        if not opts.json_out:
            typer.echo("")
            ui.ok(f"✓ wrote {report_file}")
    return saved_to, report_file


def _reply_load_json(opts, warnings, state, snapshot, result, base,
                     saved_to, report_file, passed):
    """Emit the single loadtest envelope, adding only artifacts that exist."""
    if not opts.json_out:
        return
    payload = {"ctx": result["ctx"], "summary": state.summary,
               "slo": result["slo"], "passed": passed,
               "snapshot": snapshot, "warnings": warnings}
    if result["diag"]:
        payload["diag"] = result["diag"]
    if state.resources:
        payload["resources"] = {
            key: dc_asdict(value) for key, value in (result["short_res"] or {}).items()}
    if base:
        payload["compare"] = {"baseline": base.get("label"), "rows": result["compare"]}
    if saved_to:
        payload["saved_baseline"] = saved_to
    if report_file:
        payload["report"] = report_file
    jsonout.reply("loadtest", payload)


def _run_loadtest_command(opts):
    """Validate, execute, render, and persist one CLI load test."""
    mods = _perf_modules()
    warnings = []
    warn = lambda message: _load_warning(opts, warnings, message)
    extra_env, method, path, constraints, rules = _validate_load_options(opts, mods, warn)
    meta, compose, target = _require_perf_workspace(opts.name, "loadtest")
    _check_live_monitoring(opts, meta, compose)
    per_service = _resolve_constraints(mods, constraints, compose)
    base = _load_baseline(mods, opts.compare)
    auth, token, users = _loadtest_identity(opts, meta, warn)
    extra_env = _webhook_environment(opts, meta, auth, extra_env)
    snapshot = _workspace_snapshot(
        meta, auth, instances=max(1, len(_rc_services_in(compose))))
    label = f"custom {method} {path}" if opts.scenario == "custom" else opts.scenario
    load = (f"spike {opts.spike}" if opts.spike else f"ramp {opts.ramp}"
            if opts.ramp else f"{opts.vus} VUs") + f" for {opts.duration}"
    identity = f"{len(users)} seeded users" if users else "admin token"
    state = _execute_loadtest(
        opts, mods, meta, compose, auth, token, users, target, extra_env,
        snapshot, per_service, label, load, identity, warn)
    result = _collect_load_results(
        opts, mods, meta, users, target, snapshot, state, rules, base, label, warn)
    _render_load_results(opts, meta, state, result, base)
    saved_to, report_file = _save_load_outputs(
        opts, mods, meta, state, snapshot, result, base)
    passed = not result["slo"] or all(item["ok"] for item in result["slo"])
    _reply_load_json(
        opts, warnings, state, snapshot, result, base, saved_to, report_file, passed)
    if not passed:
        raise typer.Exit(1)











def loadtest(
    name: str = typer.Option("", "--name", "-n"),
    scenario: str = typer.Option("messages", "--scenario", help="messages | login | read | mixed | journey | webhook | badbot | custom"),
    endpoint: str = typer.Option("", "--endpoint", help="custom scenario: the call to hit, e.g. \"GET /api/v1/channels.list?count=100\""),
    body: str = typer.Option("", "--body", help="custom scenario: JSON request body for POST/PUT/PATCH"),
    vus: int = typer.Option(10, "--vus", help="virtual users (k6 concurrent workers — not RC accounts)"),
    users_n: int = typer.Option(10, "--users", help="spread load across up to N seeded users (alice, bob, …); 0 = admin token only"),
    duration: str = typer.Option("30s", "--duration", help="test duration, e.g. 60s, 2m"),
    ramp: str = typer.Option("", "--ramp", help="ramp VUs start:end over --duration, e.g. 10:200"),
    spike: str = typer.Option("", "--spike", help="spike test base:peak over --duration (base 1/3, peak 1/3, recovery 1/3), e.g. 10:100 — reports recovery time"),
    live: bool = typer.Option(False, "--live", help="stream k6 metrics into the attached monitoring stack's Prometheus (watch live in Grafana)"),
    slo: str = typer.Option("", "--slo", help="pass/fail gate, e.g. p95=300ms,error=1%,rps=100"),
    constrain: str = typer.Option("", "--constrain", help="cap services to customer-sized hardware for the test, e.g. \"rc=2cpu/2g,mongo=1cpu/1g\" (live docker update; restored after)"),
    diag: bool = typer.Option(True, "--diag/--no-diag", help="server-side diagnosis: RC event-loop lag, Mongo slow queries, latency-over-time, verdict"),
    slowms: int = typer.Option(100, "--slowms", help="Mongo profiler threshold in ms (queries slower than this are captured)"),
    stats: bool = typer.Option(False, "--stats", help="also report container CPU/RAM during the test"),
    save: str = typer.Option("", "--save", help="save this run as a named baseline (~/.houston/loadtests/)"),
    compare: str = typer.Option("", "--compare", help="compare this run against a saved baseline"),
    json_out: bool = typer.Option(False, "--json", help="print the result as JSON (for CI/scripts); suppresses pretty output"),
    report: bool = typer.Option(False, "--report", help=f"write a markdown report to {config.reports_dir()}"),
    report_path: str = typer.Option("", "--report-path", help="write the report to this file/dir instead (implies --report)"),
) -> None:
    """Drive real HTTP load at a repro with k6 and check it against an SLO.

    Load is spread across seeded users when available (--users, default 10) so
    it carries real per-user identity; the journey scenario times each step of a
    realistic session. --save/--compare give before/after deltas across runs.
    k6 runs on the repro's docker network (works with loopback-only binds); the
    REST rate limiter is disabled for the run and restored after. Exits non-zero
    if a --slo rule is not met — usable as a CI gate.
    """
    # Activate before Docker preflight or any error so stdout is always JSON-only.
    if json_out:
        jsonout.activate()
    _require_docker()
    _run_loadtest_command(_LoadOptions(
        name=name, scenario=scenario, endpoint=endpoint, body=body, vus=vus,
        users_n=users_n, duration=duration, ramp=ramp, spike=spike, live=live,
        slo=slo, constrain=constrain, diag=diag, slowms=slowms, stats=stats,
        save=save, compare=compare, json_out=json_out, report=report,
        report_path=report_path))


























def capacity(
    name: str = typer.Option("", "--name", "-n"),
    scenario: str = typer.Option("journey", "--scenario", help="which workload to scale: journey | messages | read | mixed | login | badbot"),
    users_n: int = typer.Option(10, "--users", help="spread load across up to N seeded users; 0 = admin only"),
    slo: str = typer.Option("p95=500ms,error=2%", "--slo", help="the limit that defines 'capacity'"),
    start: int = typer.Option(10, "--start", help="first VU step"),
    max_vus: int = typer.Option(640, "--max", help="stop doubling past this many VUs"),
    step_duration: str = typer.Option("20s", "--step-duration", help="how long each step runs"),
    constrain: str = typer.Option("", "--constrain", help="find capacity on customer-sized hardware, e.g. \"rc=2cpu/2g\" (restored after)"),
    report: bool = typer.Option(False, "--report", help=f"write a markdown report to {config.reports_dir()}"),
    report_path: str = typer.Option("", "--report-path", help="write the report to this file/dir instead (implies --report)"),
    json_out: bool = typer.Option(False, "--json", help="print the result as JSON"),
) -> None:
    """Find how much concurrency a repro sustains before the SLO breaks.

    Doubles VUs (start, 2x, 4x, …) running the scenario at each step until a
    rule fails, then bisects between the last pass and first fail — ending with
    "handles ~N concurrent VUs" plus why it broke (event-loop lag at the wall).
    """
    # --json FIRST, as `loadtest` does: the engine check below is an `_err` too, and ahead
    # of the activation it answered `capacity --json` on a box with no Docker with a red
    # line on stderr and nothing on stdout -- no envelope for a caller that parses one.
    if json_out:
        jsonout.activate()          # before any `_err`; see `loadtest`
    _require_docker()
    _run_capacity_command(_CapacityOptions(
        name=name, scenario=scenario, users_n=users_n, slo=slo, start=start,
        max_vus=max_vus, step_duration=step_duration, constrain=constrain,
        report=report, report_path=report_path, json_out=json_out))
