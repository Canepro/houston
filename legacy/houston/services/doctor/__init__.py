"""Preflight environment checks, shared by `houston doctor` and the web GUI.

Both front-ends run the IDENTICAL checks: the CLI colours and prints the rows, the API
serves them as JSON. Checks never raise -- each degrades to a `warn` row -- because the
whole point is to run when the environment is broken.

**This module is the orchestrator and nothing else now.** It builds the context, starts
the AWS probe, asks `checks/` to run every subject in `RUN_ORDER`, and tallies. The
checks themselves live one module per subject; `rows.py` holds the id vocabulary and
the only way to add a row; `probes.py` holds the measurements other code also needs.

`checks` is imported by string, not by name: every check module imports
`houston.services.doctor.rows`, and importing a submodule runs this initialiser first,
so naming one here would be a cycle. `rows` and `probes` may be imported directly --
neither reaches back into this package.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from houston.services import lifecycle as lc
from houston.services.doctor import checks
from houston.services.doctor.probes import (INOTIFY_PER_CLUSTER,  # noqa: F401
                                            MONGO8_BAD_KERNEL, _kernel_major_minor,
                                            _major_version, _mongo_kernel_conflict,
                                            inotify_headroom, inotify_in_use,
                                            mongo_kernel_conflict)
from houston.services.doctor.rows import CHECKS, Ctx, Report, Row  # noqa: F401


def _run_every_check(ctx: Ctx) -> list[Row]:
    """Every check module in `checks.RUN_ORDER`, with its rows concatenated.

    The loop is HERE rather than in `checks/__init__.py` because that module may not
    import anything -- see its docstring. Modules are resolved by string, which is also
    what keeps this file from naming them and closing the same cycle one level up.

    **Deliberately no try/except around each module.** Every check already owns its own,
    and each one degrades to a `warn` row -- that is the rule the subject is written
    around. Adding a second net here would CHANGE what a crash does: today an escape
    ends the report, and with a per-module net the modules after it would go on running
    and the report would gain rows it has never had. The decomposition is not the place
    to decide that.
    """
    from importlib import import_module

    rows: list[Row] = []
    for name in checks.RUN_ORDER:
        rows += import_module(f"{__name__}.checks.{name}").check(ctx)
    return rows


def run_checks(context: str = "") -> dict:
    """Run every preflight check and return the findings.

    `context` names the cluster to report on, defaulting to the box's
    `kubernetes.context`. It must be honoured for the reason k8s.py:1117 gives --
    *"a preflight whose job is to predict a boot must not be a second opinion about
    it"*. Without it, somebody about to run `up --context eks-support` would get a
    report about the local kind cluster instead, which is the same disagreement that
    comment records having already been fixed once.

    {"checks": [{"status": "ok"|"warn"|"fail", "message": str}, ...],
     "counts": {...}, "verdict": "ok"|"warn"|"fail",
     "repros": {"total": int, "running": int} | None}
    """
    ctx = Ctx(context=context)
    # THE AWS PROBE, STARTED NOW AND READ LATER. It is by far the slowest thing this
    # report does and it shares nothing with the Docker and Kubernetes checks: MEASURED
    # at 1783ms of a 2485ms run, almost all of it a network round trip for
    # `sts get-caller-identity`. Run where it is USED it simply added to the total;
    # started here it finishes while the local checks run and is usually already waiting
    # by the time the report gets to it.
    #
    # Errors are carried, not raised: `.result()` re-raises inside the check that reads
    # it, which is inside the same `try` the sequential call was in, so a broken `aws`
    # still degrades exactly as it did.
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        from houston.services import eks as ekssvc
        ctx.cloud = pool.submit(ekssvc.aws.preflight)
        ctx.owned = pool.submit(ekssvc.remembered)
    except Exception:  # noqa: BLE001 - a report must not fail to start over this
        ctx.cloud = ctx.owned = None

    rows = _run_every_check(ctx)
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in ("ok", "warn", "fail")}
    verdict = "fail" if counts["fail"] else ("warn" if counts["warn"] else "ok")

    # Repro tally. Counted through list_repros() so doctor's idea of "running" is the
    # dashboard's (see lc.repro_state), not a second opinion.
    repros = None
    if ctx.docker_up:
        try:
            listed = lc.list_repros()
            if listed:
                repros = {"total": len(listed),
                          "running": sum(1 for r in listed if r["state"] == "running")}
        except Exception:  # noqa: BLE001 - a tally must never break the report
            repros = None

    # The pool started above. Shut down explicitly rather than left to garbage
    # collection: `serve` calls this on every visit to the dashboard, and an executor
    # per call is a thread pool per call.
    pool.shutdown(wait=False)
    return {"checks": rows, "counts": counts, "verdict": verdict, "repros": repros}
