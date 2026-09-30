"""Compose v2 or newer, which houston's whole substrate is.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import runner
from houston.services.doctor.probes import (_major_version)

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "compose"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # docker compose v2 or newer
    cv = runner.compose_version()
    cv_major = _major_version(cv)
    if cv_major is not None and cv_major >= 2:
        line(SUBJECT, "ok", f"docker compose v{cv_major} ({cv})")
    elif cv:
        line(SUBJECT, "warn", f"docker compose {cv} — houston needs Compose v2 or newer")
    else:
        line(SUBJECT, "warn", "couldn't detect `docker compose` — install Compose v2 or newer")
    return report.rows
