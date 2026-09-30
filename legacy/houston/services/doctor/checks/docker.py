"""Is the container engine there at all.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import runner

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "docker"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # Docker daemon (everything else that needs Docker degrades gracefully).
    # max_age=0: the dashboard poll memoises this, but somebody running `doctor`
    # has explicitly asked whether Docker is up RIGHT NOW -- answering that from a
    # cache is how a diagnostic tells you the opposite of the truth.
    ctx.docker_up = runner.docker_available(max_age=0)
    if ctx.docker_up:
        line(SUBJECT, "ok", f"Docker daemon running ({runner.docker_server_version() or '?'})")
    else:
        line(SUBJECT, "fail", "Docker daemon not running — start Docker Desktop / dockerd")
    return report.rows
