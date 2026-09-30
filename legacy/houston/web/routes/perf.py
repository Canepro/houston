"""Measurement attached to a workspace: load tests, capacity, the monitoring add-on.

Three endpoints that differ from the rest in one way — each one makes the box do
noticeably more work than answering a request — so all three are jobs and all three are
pooled by kind. `monitor` submits one of two kinds from a ternary, which is not a detail:
`attach` does a pulling `runner.up` of six containers and `detach` removes them and their
volumes, so both halves cost an engine a whole workspace and the pool walk in
`tests/test_web.py` reads the ternary as two kinds rather than skipping it.
"""
from __future__ import annotations

from fastapi import Body, Request

from houston.services import lifecycle as lc
from houston.services import monitor as monitorsvc
from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name -- but `register` is the only thing anything outside this
#: package may reach for, and a test walks the imports to prove nothing does.
__all__ = ("register",)


def loadtest(request: Request, name: str, body: dict = Body(default={})):
    from houston.services import perf as perfsvc
    target = lc.resolve_name(name)
    fields = set(perfsvc.LoadtestReq.__dataclass_fields__) - {"name"}
    req = perfsvc.LoadtestReq(name=target, **{k: v for k, v in body.items() if k in fields})
    job = _deps.jobs(request).submit("loadtest", perfsvc.run_loadtest, req, label=target)
    return {"job_id": job.id}


def capacity(request: Request, name: str, body: dict = Body(default={})):
    from houston.services import perf as perfsvc
    target = lc.resolve_name(name)
    fields = set(perfsvc.CapacityReq.__dataclass_fields__) - {"name"}
    req = perfsvc.CapacityReq(name=target, **{k: v for k, v in body.items() if k in fields})
    job = _deps.jobs(request).submit("capacity", perfsvc.run_capacity, req, label=target)
    return {"job_id": job.id}


def monitor(request: Request, name: str, off: bool = False):
    target = lc.resolve_name(name)
    # THE TERNARY STAYS, AND THE WALK READS IT NOW. As an `ast.IfExp` this was
    # skipped by `test_every_engine_heavy_job_kind_lands_in_a_pool` -- by
    # construction, with a comment naming this very route as the case it skipped --
    # so `monitor` sat outside every pool unnoticed. And `monitorsvc.attach` does a
    # PULLING `runner.up`: Prometheus, Grafana, Loki, an OTel collector and two
    # exporters. N members clicking Monitor was N pulling compose-ups on one
    # engine, which is the exact failure the pool was added for.
    #
    # Teaching the walk to resolve a two-constant ternary was the fix, rather than
    # contorting this call: the escape hatch is closed instead of moved, and the
    # walk now REFUSES a kind it cannot read rather than skipping it.
    job = _deps.jobs(request).submit("monitor-off" if off else "monitor",
                      monitorsvc.detach if off else monitorsvc.attach, target,
                      label=target)
    return {"job_id": job.id}


ROUTES = (
    ("post", "/api/repros/{name}/loadtest", loadtest),
    ("post", "/api/repros/{name}/capacity", capacity),
    ("post", "/api/repros/{name}/monitor", monitor),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
