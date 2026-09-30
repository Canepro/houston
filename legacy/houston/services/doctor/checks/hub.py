"""Docker Hub authentication, because anonymous pulls are rate limited.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import runner

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "hub-auth"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # Docker Hub auth: anonymous pulls hit Hub's rate limit (registry.rocket.chat
    # counts against Hub too), which shows up as a silent, container-less `down`.
    hub = runner.hub_logged_in()
    if hub is True:
        line(SUBJECT, "ok", "logged in to Docker Hub (avoids anonymous pull-rate limits)")
    elif hub is False:
        line(SUBJECT, "warn", "not logged in to Docker Hub — anonymous pulls can hit the rate "
                     "limit; run `docker login`. registry.rocket.chat counts against Hub too")
    return report.rows
