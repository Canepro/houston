"""Load-test service for the web GUI (a focused subset of the CLI `loadtest`).

Supports the common options — scenario, vus, duration, users, slo, constrain,
diag, stats, live — with the SAME safety-critical restore-in-`finally` as the CLI
(rate limiter, Prometheus setting, resource caps, and the users.json token file
are always restored/cleaned up, even on failure). Returns a structured result.

The full-featured CLI `loadtest` (ramp/spike/custom/webhook/save/compare/report)
is unchanged; unifying the two behind this service is a planned follow-up.
"""

from __future__ import annotations

import re
import time
from dataclasses import asdict as dc_asdict
from dataclasses import dataclass, field

import requests

from houston import config, rcapi, runner
from houston import seed as seeder
from houston.errors import DockerError, NotReadyError, ValidationError
from houston.services import journal, lifecycle
from houston.services.events import Emit, info, null_emit, warn

_GUI_SCENARIOS = ("messages", "login", "read", "mixed", "journey", "badbot")


def _repair_constraints(entry, _emit, _login) -> bool:
    from houston.perf import constrain as constrain_mod
    applied = [constrain_mod.Applied(**a) for a in (entry.detail.get("applied") or [])]
    return not constrain_mod.restore(applied)


def _repair_metrics(entry, _emit, login) -> bool:
    from houston import monitoring
    if login is None:
        return False
    meta = runner.read_meta(entry.workspace)
    auth = login(meta)
    return bool(auth and rcapi.set_setting(meta.root_url, auth, meta.admin_pass,
                                           monitoring.RC_METRICS_SETTING, False))


def install_journal_repairs() -> None:
    journal.register_repair(journal.CONSTRAINTS_APPLIED, _repair_constraints)
    journal.register_repair(journal.RC_METRICS_ON, _repair_metrics)


@dataclass
class LoadtestReq:
    name: str
    scenario: str = "messages"
    vus: int = 10
    duration: str = "30s"
    users_n: int = 10
    slo: str = ""
    constrain: str = ""
    diag: bool = True
    stats: bool = False
    live: bool = False
    slowms: int = 100


def _rc_services_in(doc: dict) -> list[str]:
    return [s for s in doc.get("services", {}) if s == "rocketchat" or s.startswith("rocketchat-")]


def _loadtest_target(doc: dict) -> str:
    svcs = doc.get("services", {})
    if "traefik" in svcs:
        return "http://traefik:80"
    rc = _rc_services_in(doc)
    if "rocketchat" in rc:
        return "http://rocketchat:3000"
    return f"http://{rc[0]}:3000" if rc else "http://rocketchat:3000"


def _short(full: str, repro_name: str) -> str:
    prefix = f"{config.PROJECT_PREFIX}{repro_name}-"
    s = full[len(prefix):] if full.startswith(prefix) else full
    return re.sub(r"-\d+$", "", s)


def _login_seed_users(root_url: str, count: int) -> list[dict]:
    users: list[dict] = []
    url = root_url.rstrip("/") + "/api/v1/login"
    for i in range(count):
        uname = seeder.username(i)
        try:
            r = requests.post(url, json={"user": uname, "password": uname}, timeout=10)
        except requests.RequestException:
            break
        if r.status_code == 200:
            d = r.json().get("data") or {}
            if d.get("authToken"):
                users.append({"username": uname, "password": uname,
                              "token": d["authToken"], "uid": d["userId"]})
    return users


def require_compose_for_perf(name: str, operation: str) -> None:
    """Refuse a load test or capacity search on a Kubernetes workspace, and say why.

    Not merely "unimplemented". The number would be WRONG in a way that reads as a
    result: a Kubernetes workspace is reached through `kubectl port-forward`, which
    is a single userspace relay -- it saturates, serialises and drops connections far
    below what Rocket.Chat itself would, so every figure the run produced would be a
    measurement of the forward. A plausible wrong number is the one failure mode this
    tool cannot afford in a report a support engineer sends to a customer.
    """
    from houston.services import topology
    target = lifecycle.resolve_name(name)
    if topology.of_repro(target) != topology.KUBERNETES:
        return
    version = ""
    try:
        version = runner.read_meta(target).rc_version
    except Exception:  # noqa: BLE001 - the refusal matters more than the example
        pass
    raise ValidationError(
        f"{operation} is Compose-only. A Kubernetes workspace is reached through a "
        "`kubectl port-forward`, which is a single userspace relay: it saturates and "
        "drops connections long before Rocket.Chat does, so every number this "
        "produced would be measuring the forward. Run it against a Compose "
        f"workspace on the same version instead — `houston up --version "
        f"{version or '<version>'} --name perf` — where the client talks to the "
        "container directly.")


@dataclass
class _LoadRun:
    """The side effects one load test arms, and what it has measured so far.

    Six things are switched on before k6 runs and switched back after it, in a
    `finally` that must run whichever way the test ended. Passing them between
    named steps as fifteen parameters and twelve return values is the same tangle
    with more punctuation in it; this is what they actually are."""
    applied_constraints: list = field(default_factory=list)
    limiter_was_off: bool = True
    limiter_note: str = ""
    constrain_note: str = ""
    metrics_note: str = ""
    mongo_note: str = ""
    metrics_changed: bool = False
    mongo_prior: object = None
    sampler: object = None
    mon: object = None
    resources: object = None
    summary: object = None
    rcm_report: dict = field(default_factory=dict)
    since_ms: int = 0


def _put_everything_back(auth, constrain_mod, emit, m, mongoprof, monitoring, run):
    """Undo every side effect this run armed, whichever way it ended."""
    # users.json holds live seeded-user auth tokens — delete it FIRST, so no
    # later restore step failing can leave credentials on disk.
    (runner.workspace(m.name) / "loadtest" / "users.json").unlink(missing_ok=True)
    if run.sampler:
        run.rcm_report = run.sampler.stop()
    if run.mon:
        run.resources = run.mon.stop()
    if not run.limiter_was_off:
        try:
            rcapi.set_setting(m.root_url, auth, m.admin_pass,
                              config.RC_RATE_LIMITER_SETTING, True)
            journal.clear(run.limiter_note)
        except Exception:  # noqa: BLE001
            warn(emit, "could not restore the API rate limiter setting", phase="restore")
    if run.metrics_changed:
        try:
            rcapi.set_setting(m.root_url, auth, m.admin_pass,
                              monitoring.RC_METRICS_SETTING, False)
            journal.clear(run.metrics_note)
        except Exception:  # noqa: BLE001
            warn(emit, "could not restore the Prometheus metrics setting", phase="restore")
    if run.mongo_prior:
        # Wrapped like its neighbours: an exception here would skip the
        # resource-cap restore below and leave the containers capped.
        try:
            mongoprof.stop(m.name, run.mongo_prior)
            journal.clear(run.mongo_note)
        except Exception:  # noqa: BLE001
            warn(emit, "could not restore the Mongo profiler level", phase="restore")
    # CLEARED AFTER, like its three siblings above. Clearing first threw away the
    # note on the one path it exists for: `restore` RETURNS problems rather than
    # raising, and the loop below is there to report them -- so a failed restore
    # left the containers capped with the record of their prior values already
    # deleted, which is precisely what CONSTRAINTS_APPLIED carries them for.
    _cap_problems = constrain_mod.restore(run.applied_constraints)
    for problem in _cap_problems:
        warn(emit, f"could not restore resource limits - {problem}", phase="restore")
    if not _cap_problems:
        journal.clear(run.constrain_note)


def _arm_and_run(auth, constrain_mod, emit, k6, m, mongoprof, monitoring, per_service, perf, rc_services, rcmetrics, req, run, target, token, users):
    """Constrain, disable the limiter, turn the diagnostics on, and run k6."""
    if per_service:
        try:
            run.applied_constraints = constrain_mod.apply(m.name, per_service)
            # NOTED WITH THE PRIOR VALUES, so a killed run can be undone exactly
            # rather than reset to "unlimited". `restore` runs in the `finally`
            # below; this is what covers the run that never reaches it.
            run.constrain_note = journal.record(
                journal.CONSTRAINTS_APPLIED, m.name,
                applied=[dc_asdict(a) for a in run.applied_constraints])
        except RuntimeError as exc:
            raise DockerError(f"could not apply constrain: {exc}") from exc
        info(emit, f"constrained: {constrain_mod.human(per_service)} (restored after)", phase="k6")
    run.limiter_was_off = rcapi.get_setting(m.root_url, auth, m.admin_pass,
                                        config.RC_RATE_LIMITER_SETTING) is False
    if not run.limiter_was_off:
        # JOURNALLED BEFORE IT IS TURNED OFF. The `finally` below turns it back
        # on, and a daemon thread killed by a restart or an OOM runs no `finally`
        # at all -- so the note on disk is what survives to say the API rate
        # limiter is off on this workspace and nobody meant to leave it that way.
        run.limiter_note = journal.record(journal.RATE_LIMITER_OFF, m.name)
        rcapi.set_setting(m.root_url, auth, m.admin_pass,
                          config.RC_RATE_LIMITER_SETTING, False)
    if req.diag:
        if rcapi.get_setting(m.root_url, auth, m.admin_pass,
                             monitoring.RC_METRICS_SETTING) is not True:
            # Journalled like its two neighbours. Both of these are restored in the
            # `finally` below, which is precisely the block a SIGKILL does not run
            # -- so without a note a killed --diag run leaves Rocket.Chat's metrics
            # endpoint open and the profiler armed, with nothing on disk saying so.
            run.metrics_note = journal.record(journal.RC_METRICS_ON, m.name)
            run.metrics_changed = rcapi.set_setting(m.root_url, auth, m.admin_pass,
                                                monitoring.RC_METRICS_SETTING, True)
        run.mongo_prior = mongoprof.start(m.name, req.slowms)
        if run.mongo_prior is not None:
            # Carrying the PRIOR level, because `mongoprof.stop` restores to a value
            # rather than to off, and a workspace that already had profiling on must
            # keep it. Same distinction CONSTRAINTS_APPLIED already draws.
            run.mongo_note = journal.record(journal.MONGO_PROFILER_ON, m.name,
                                        prior=run.mongo_prior)
    run.mon = perf.ResourceMonitor(m.name).start() if req.stats else None
    run.since_ms = int(time.time() * 1000)
    if req.diag:
        run.sampler = rcmetrics.RCMetricsSampler(m.name, rc_services).start()
    info(emit, f"running k6: {req.scenario} @ {req.vus} VUs for {req.duration} -> {target}"
               f" ({'%d seeded users' % len(users) if users else 'admin token'})", phase="k6")
    run.summary = k6.run(m.name, req.scenario, vus=req.vus, duration=req.duration, ramp=None,
                     token=token, uid=auth.user_id, target=target, users=users or None,
                     password=m.admin_pass,
                     quiet=True, timeline=req.diag, spike=None, live=req.live)


def _loadtest_verdict(emit, m, mongoprof, req, rules, run, slo_mod, timeline_mod, verdict_mod):
    """What the run proved: the SLO, the diagnosis, and where to look at it."""
    mongo_slow = mongoprof.collect(m.name, run.since_ms) if (req.diag and run.mongo_prior) else None
    tl = None
    if req.diag:
        points = runner.workspace(m.name) / "loadtest" / "points.json"
        tl = timeline_mod.parse(points)
        points.unlink(missing_ok=True)

    slo_results = slo_mod.evaluate(rules, run.summary) if rules else []
    short_stats = {_short(k, m.name): v for k, v in run.resources.items()} if run.resources else None
    verdict_lines = (verdict_mod.analyze(run.summary, rcmetrics=run.rcm_report or None, mongo=mongo_slow,
                                         resources=short_stats, timeline=tl)
                     if req.diag else [])
    passed = (not slo_results) or all(r["ok"] for r in slo_results)

    grafana = f"http://localhost:{config.MONITOR_PORTS[1]}" if req.live else None
    info(emit, f"done: p95 {run.summary.get('p95', 0):.0f}ms at {run.summary.get('rps', 0):.1f} req/s, "
               f"{run.summary.get('error_rate', 0) * 100:.2f}% errors"
               + ("" if passed else " - SLO FAIL"), phase="done",
         data={"passed": passed})
    return grafana, mongo_slow, passed, short_stats, slo_results, tl, verdict_lines


def _loadtest_preflight(constrain_mod, req, slo_mod):
    """Refuse what cannot be run, then resolve the workspace, its target and its users."""
    lifecycle.require_docker()
    if req.scenario not in _GUI_SCENARIOS:
        raise ValidationError(f"scenario must be one of {', '.join(_GUI_SCENARIOS)}")
    if req.vus < 1:
        raise ValidationError("vus must be >= 1")

    # Refused here rather than at the top, so a bad --scenario is still named before
    # a bad --name: the request's own shape is cheaper to check and is what the
    # caller most likely got wrong. But BEFORE read_compose, which raised a bare
    # FileNotFoundError naming a compose file a Kubernetes workspace does not have --
    # outside the ReproError contract, so the GUI answered 500 to a request that is
    # merely unsupported. The same defect the env tab had, in a second place.
    require_compose_for_perf(req.name, "loadtest")
    m = runner.read_meta(lifecycle.resolve_name(req.name))
    doc = runner.read_compose(m.name)
    target = _loadtest_target(doc)
    rc_services = _rc_services_in(doc) or ["rocketchat"]

    if req.live:
        if not (isinstance(m.extra, dict) and m.extra.get("monitoring")):
            raise ValidationError("live streaming needs monitoring attached first")
        prom_cmd = (doc.get("services", {}).get("prometheus") or {}).get("command", [])
        if not any("remote-write-receiver" in str(c) for c in prom_cmd):
            raise ValidationError("live needs Prometheus with remote-write - re-attach monitoring")

    try:
        rules = slo_mod.parse(req.slo) if req.slo else []
    except ValueError as exc:
        raise ValidationError(f"bad slo: {exc}") from exc
    per_service = {}
    if req.constrain:
        try:
            per_service = constrain_mod.resolve_services(
                constrain_mod.parse(req.constrain), list(doc.get("services", {})))
        except ValueError as exc:
            raise ValidationError(f"bad constrain: {exc}") from exc

    try:
        auth = lifecycle.login(m)
        token = rcapi.generate_pat(m.root_url, auth, m.admin_pass,
                                   token_name="houston-loadtest", bypass_2fa=True,
                                   workspace=m.name)
    except Exception as exc:  # noqa: BLE001
        raise NotReadyError(f"could not authenticate (ready?): {exc}") from exc

    users = _login_seed_users(m.root_url, req.users_n) if req.users_n > 0 else []
    return auth, m, per_service, rc_services, rules, target, token, users


def run_loadtest(req: LoadtestReq, emit: Emit = null_emit) -> dict:
    from houston import monitoring, perf
    from houston.perf import (constrain as constrain_mod, k6, mongoprof, rcmetrics,
                               slo as slo_mod, timeline as timeline_mod, verdict as verdict_mod)

    auth, m, per_service, rc_services, rules, target, token, users = _loadtest_preflight(constrain_mod, req, slo_mod)

    run = _LoadRun()
    try:
        _arm_and_run(auth, constrain_mod, emit, k6, m, mongoprof, monitoring, per_service, perf, rc_services, rcmetrics, req, run, target, token, users)
    except RuntimeError as exc:
        raise DockerError(str(exc)) from exc
    finally:
        _put_everything_back(auth, constrain_mod, emit, m, mongoprof, monitoring, run)

    grafana, mongo_slow, passed, short_stats, slo_results, tl, verdict_lines = _loadtest_verdict(emit, m, mongoprof, req, rules, run, slo_mod, timeline_mod, verdict_mod)
    return {
        "ctx": {"name": m.name, "scenario": req.scenario, "vus": req.vus,
                "duration": req.duration, "users": len(users), "target": target,
                "constrained": constrain_mod.human(per_service) if per_service else ""},
        "summary": run.summary, "slo": slo_results, "passed": passed,
        "verdict": verdict_lines,
        "diag": {"rcmetrics": run.rcm_report, "mongo": mongo_slow, "timeline": tl} if req.diag else None,
        "resources": {k: dc_asdict(v) for k, v in short_stats.items()} if short_stats else None,
        "grafana_url": grafana,
    }


# --- capacity ----------------------------------------------------------------

@dataclass
class CapacityReq:
    name: str
    scenario: str = "journey"
    users_n: int = 10
    slo: str = "p95=500ms,error=2%"
    start: int = 10
    max_vus: int = 640
    step_duration: str = "20s"
    constrain: str = ""


@dataclass
class _CapacitySearch:
    """The side effects one capacity search arms, and the steps it has taken.

    The same shape as `_LoadRun` and for the same reason: five things are
    switched on before the search and back after it, and the search itself
    accumulates a step list and a pass/fail boundary that every stage reads."""
    applied: list = field(default_factory=list)
    limiter_was_off: bool = True
    limiter_note: str = ""
    constrain_note: str = ""
    metrics_note: str = ""
    metrics_changed: bool = False
    steps: list = field(default_factory=list)
    last_pass: object = None
    first_fail: object = None


def _capacity_verdict(emit, req, search):
    """Where the SLO broke, and what broke it."""
    if search.last_pass is None:
        result = f"breaches the SLO even at {req.start} VUs - start lower"
    elif search.first_fail is None:
        result = f"holds the SLO up to {search.last_pass} VUs (never breached; raise max to push further)"
    else:
        result = f"~{search.last_pass} concurrent VUs (holds at {search.last_pass}, breaks at {search.first_fail})"
    breach = (next((r for r in search.steps if r["vus"] == search.first_fail), None) if search.first_fail
              else next((r for r in search.steps if not r["ok"]), None))
    why = ""
    if breach:
        why = (f"at {breach['vus']} VUs the RC event loop saturated (lag peaked "
               f"at {breach['lag_max_s'] * 1000:.0f}ms)" if breach["lag_max_s"] >= 0.5
               else f"at {breach['vus']} VUs: {'; '.join(breach['breached'])}")
    info(emit, f"capacity: {result}", phase="done", data={"capacity_vus": search.last_pass})
    return result, why


def _capacity_preflight(constrain_mod, req, slo_mod):
    """Refuse what cannot be searched, then resolve the workspace and its users."""
    lifecycle.require_docker()
    if req.scenario not in _GUI_SCENARIOS:
        raise ValidationError(f"scenario must be one of {', '.join(_GUI_SCENARIOS)}")
    try:
        rules = slo_mod.parse(req.slo)
    except ValueError as exc:
        raise ValidationError(f"bad slo: {exc}") from exc
    if req.start < 1 or req.max_vus < req.start:
        raise ValidationError("start must be >= 1 and max >= start")

    require_compose_for_perf(req.name, "capacity")   # see run_loadtest for the why
    m = runner.read_meta(lifecycle.resolve_name(req.name))
    doc = runner.read_compose(m.name)
    target = _loadtest_target(doc)
    rc_services = _rc_services_in(doc) or ["rocketchat"]
    per_service = {}
    if req.constrain:
        try:
            per_service = constrain_mod.resolve_services(
                constrain_mod.parse(req.constrain), list(doc.get("services", {})))
        except ValueError as exc:
            raise ValidationError(f"bad constrain: {exc}") from exc
    try:
        auth = lifecycle.login(m)
        token = rcapi.generate_pat(m.root_url, auth, m.admin_pass,
                                   token_name="houston-loadtest", bypass_2fa=True,
                                   workspace=m.name)
    except Exception as exc:  # noqa: BLE001
        raise NotReadyError(f"could not authenticate (ready?): {exc}") from exc
    users = _login_seed_users(m.root_url, req.users_n) if req.users_n > 0 else []
    return auth, m, per_service, rc_services, rules, target, token, users


def _put_the_workspace_back(auth, constrain_mod, emit, m, monitoring, search):
    """Undo every side effect the search armed, whichever way it ended."""
    if not search.limiter_was_off:
        try:
            rcapi.set_setting(m.root_url, auth, m.admin_pass, config.RC_RATE_LIMITER_SETTING, True)
            journal.clear(search.limiter_note)
        except Exception:  # noqa: BLE001
            warn(emit, "could not restore the API rate limiter setting", phase="restore")
    if search.metrics_changed:
        try:
            rcapi.set_setting(m.root_url, auth, m.admin_pass, monitoring.RC_METRICS_SETTING, False)
            journal.clear(search.metrics_note)
        except Exception:  # noqa: BLE001
            warn(emit, "could not restore the Prometheus metrics setting", phase="restore")
    # See run_loadtest: cleared only when the restore actually succeeded.
    _cap_problems = constrain_mod.restore(search.applied)
    for problem in _cap_problems:
        warn(emit, f"could not restore resource limits - {problem}", phase="restore")
    if not _cap_problems:
        journal.clear(search.constrain_note)
    (runner.workspace(m.name) / "loadtest" / "users.json").unlink(missing_ok=True)


def _search_for_capacity(auth, constrain_mod, emit, m, monitoring, per_service, req, run_step, search):
    """Double until the SLO breaks, then bisect between the last pass and the first fail."""
    if per_service:
        try:
            search.applied = constrain_mod.apply(m.name, per_service)
            # NOTED WITH THE PRIOR VALUES, so a killed run can be undone exactly
            # rather than reset to "unlimited". `restore` runs in the `finally`
            # below; this is what covers the run that never reaches it.
            search.constrain_note = journal.record(
                journal.CONSTRAINTS_APPLIED, m.name,
                applied=[dc_asdict(a) for a in search.applied])
        except RuntimeError as exc:
            raise DockerError(f"could not apply constrain: {exc}") from exc
    search.limiter_was_off = rcapi.get_setting(m.root_url, auth, m.admin_pass,
                                        config.RC_RATE_LIMITER_SETTING) is False
    if not search.limiter_was_off:
        search.limiter_note = journal.record(journal.RATE_LIMITER_OFF, m.name)
        rcapi.set_setting(m.root_url, auth, m.admin_pass, config.RC_RATE_LIMITER_SETTING, False)
    if rcapi.get_setting(m.root_url, auth, m.admin_pass, monitoring.RC_METRICS_SETTING) is not True:
        search.metrics_note = journal.record(journal.RC_METRICS_ON, m.name)
        search.metrics_changed = rcapi.set_setting(m.root_url, auth, m.admin_pass,
                                            monitoring.RC_METRICS_SETTING, True)
    info(emit, f"capacity search: {req.scenario}, SLO {req.slo}, steps of {req.step_duration}", phase="k6")
    n = req.start
    while n <= req.max_vus:
        row = run_step(n)
        if row["ok"]:
            search.last_pass = n
            n *= 2
        else:
            search.first_fail = n
            break
    if search.first_fail and search.last_pass:
        lo, hi = search.last_pass, search.first_fail
        for _ in range(2):
            mid = (lo + hi) // 2
            if mid <= lo or mid >= hi:
                break
            row = run_step(mid, tag=" (bisect)")
            if row["ok"]:
                lo = search.last_pass = mid
            else:
                hi = search.first_fail = mid


def run_capacity(req: CapacityReq, emit: Emit = null_emit) -> dict:
    from houston import monitoring
    from houston.perf import constrain as constrain_mod, k6, rcmetrics, slo as slo_mod

    auth, m, per_service, rc_services, rules, target, token, users = _capacity_preflight(constrain_mod, req, slo_mod)

    search = _CapacitySearch()

    def run_step(n: int, tag: str = "") -> dict:
        sampler = rcmetrics.RCMetricsSampler(m.name, rc_services).start()
        try:
            s = k6.run(m.name, req.scenario, vus=n, duration=req.step_duration, ramp=None,
                       token=token, uid=auth.user_id, target=target, users=users or None,
                       password=m.admin_pass, quiet=True)
        finally:
            rcm = sampler.stop()
        res = slo_mod.evaluate(rules, s)
        lag_max = 0.0
        for sm in rcm.values():
            lag = sm.get("eventloop_lag_max_s") or sm.get("eventloop_lag_s")
            if lag:
                lag_max = max(lag_max, lag["max"])
        row = {"vus": n, "rps": s.get("rps", 0.0), "p95": s.get("p95", 0.0),
               "error_rate": s.get("error_rate", 0.0), "ok": all(r["ok"] for r in res),
               "lag_max_s": lag_max,
               "breached": [f"{r['key']} {r['op']} {r['raw']} (actual {slo_mod.fmt_actual(r['key'], r['actual'])})"
                            for r in res if not r["ok"]]}
        search.steps.append(row)
        info(emit, f"{n} VUs{tag}: {row['rps']:.1f} req/s, p95 {row['p95']:.0f}ms, "
                   f"{'PASS' if row['ok'] else 'FAIL'}", phase="k6")
        return row

    try:
        _search_for_capacity(auth, constrain_mod, emit, m, monitoring, per_service, req, run_step, search)
    finally:
        _put_the_workspace_back(auth, constrain_mod, emit, m, monitoring, search)

    result, why = _capacity_verdict(emit, req, search)
    return {"ctx": {"name": m.name, "scenario": req.scenario, "slo": req.slo,
                    "constrained": constrain_mod.human(per_service) if per_service else ""},
            "steps": search.steps, "capacity_vus": search.last_pass, "breach_vus": search.first_fail,
            "result": result, "why": why}
