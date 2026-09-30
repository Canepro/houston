"""Work a killed process left half-done, and the event log.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations




from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "interrupted-work"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # SIDE EFFECTS NOBODY MEANT TO LEAVE. A GUI job killed mid-operation runs no
    # `finally`, so a backup can leave Rocket.Chat stopped and a load test can leave
    # the API rate limiter off -- and `web/jobs.py` keeps its registry in memory, so
    # a restart loses even the knowledge that a job existed. The journal is the only
    # durable trace, and `serve` repairs from it at startup; this is what tells a
    # CLI-only box, which never starts one.
    try:
        from houston.services import journal
        stranded = journal.abandoned()
        if stranded:
            for entry in stranded[:5]:
                # The suffix has to match what recovery will actually DO. An advisory
                # kind already names its own fix inside `describe`, and telling the
                # reader `serve` repairs it would be false -- serve reports those and
                # deliberately does not act, because finishing one means waiting for a
                # workspace to serve.
                tail = ("" if entry.kind in journal.ADVISORY
                        else " — `houston serve` repairs this at startup, or fix it "
                             "by hand")
                line(SUBJECT, "warn", journal.describe(entry) + tail, check="interrupted-work")
        elif journal.open_entries():
            # Open but owned by a live process: a job is running right now, which is
            # not a fault and must not read as one.
            line(SUBJECT, "ok", f"{len(journal.open_entries())} operation(s) in progress "
                       f"(a running job holds them)", check="interrupted-work")
    except Exception:  # noqa: BLE001 - a check must never break the report
        pass
    return report.rows
