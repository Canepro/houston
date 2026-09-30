"""Whether the ports houston binds are free.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import runner

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "ports"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # Ports.
    try:
        free = runner.pick_port()
        if runner.port_free(3000):
            line(SUBJECT, "ok", f"Port 3000 free (repros auto-pick from 3000; next free: {free})")
        else:
            line(SUBJECT, "warn", f"Port 3000 in use — `up` will auto-pick the next free port ({free})")
    except RuntimeError as exc:   # bounded scan found nothing bindable
        line(SUBJECT, "fail", str(exc))
    return report.rows
