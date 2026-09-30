"""The background job registry, over HTTP: list, poll, stream.

A job outlives the dialog that started it and any page refresh, which is the whole
point — without these three a long capacity search was computed and then unreachable.

**Everything here is scoped by `_may_read_job`.** Job results and error text sit at
readonly+, so before that rule existed any signed-in account could read another user's
output — and for `logs`, `env` and `api` that output is credentials. It was also how
the rollback path's oracle became readable BELOW the role allowed to trigger it. The
stream and the poll apply the SAME scope: leaving the live half open would have made
the scoping on the other decorative.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name and the suite patches some of them -- but `register` is
#: the only thing anything outside this package may reach for, and a test walks the
#: imports to prove nothing does.
__all__ = ("register",)

def _may_read_job(request: Request, owner: str) -> bool:
    """The `/api/audit` rule, applied to job output: an admin sees every job,
    everyone else sees their own.

    Job results and error text were not scoped to the submitter and sit at
    readonly+, so any signed-in account could read another user's output --
    which for `logs`, `env` and `api` is credentials, and which is also the
    channel that made the rollback path oracle readable BELOW the role that
    could trigger it. A job with no actor is token mode, where a shared secret
    genuinely cannot say who asked, so there is nobody to scope it to.
    """
    from houston.services import users as usersvc
    me = getattr(request.state, "actor", "") or ""
    if not me or not owner:
        return True
    return owner == me or usersvc.at_least(usersvc.role_of(me), "admin")


def jobs_list(request: Request):
    """Retained jobs, newest first. A job outlives the dialog that started it
    (and any page refresh), so without this the output of a long capacity or
    capacity search was computed and then unreachable.

    Filtered to what the caller may read, for the same reason `/api/audit` is:
    a member's own work is a legitimate question, another member's is not.
    """
    return {"jobs": [j for j in _deps.jobs(request).list_jobs()
                     if _may_read_job(request, str(j.get("actor") or ""))]}


def job_state(request: Request, job_id: str):
    job = _deps.jobs(request).get(job_id)
    if not job:
        return JSONResponse({"error": "no such job"}, status_code=404)
    if not _may_read_job(request, job.actor):
        # 404, not 403: whether a job id exists is itself the answer here, and
        # a distinguishable "exists but not yours" is the oracle again.
        return JSONResponse({"error": "no such job"}, status_code=404)
    return {"id": job.id, "kind": job.kind, "status": job.status,
            "result": job.result, "error": job.error, "error_kind": job.error_kind,
            # Said out loud, because a result panel that renders nothing looks
            # exactly like a job that produced nothing.
            "result_dropped": job.result_dropped,
            "n_events": job.n_events}


async def job_stream(request: Request, job_id: str, since: int = 0):
    job = _deps.jobs(request).get(job_id)
    if not job:
        return JSONResponse({"error": "no such job"}, status_code=404)
    # The SAME scope as the polled endpoint. This is the live half of the same
    # document, so leaving it open would have made the scoping above decorative.
    if not _may_read_job(request, job.actor):
        return JSONResponse({"error": "no such job"}, status_code=404)

    async def gen():
        idx = since
        while True:
            # The next index comes from the job, not from counting: a flood
            # trims the oldest events, so the absolute index can jump.
            evs, done, nxt = job.snapshot(idx)
            base = nxt - len(evs)
            for n, e in enumerate(evs):
                yield f"id: {base + n}\ndata: {json.dumps(e)}\n\n"
            idx = nxt
            if done and not evs:
                break
            await asyncio.sleep(0.2)
    # no-cache / no-transform keep reverse proxies (the case --allow-host
    # exists for) from buffering the stream into uselessness.
    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
    })


ROUTES = (
    ("get", "/api/jobs", jobs_list),
    ("get", "/api/jobs/{job_id}", job_state),
    ("get", "/api/jobs/{job_id}/stream", job_stream),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
