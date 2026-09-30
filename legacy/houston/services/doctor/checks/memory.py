"""RAM and swap, which is what `check_capacity` spends.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston.services import lifecycle as lc

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "memory"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # Memory headroom, in workspaces rather than megabytes -- "3.2 GB available"
    # does not tell you whether you can start another one, and that is the only
    # question anybody is actually asking. Added after seven concurrent stacks
    # OOM-killed a 10 GB host: every `up` had succeeded, and nothing anywhere
    # reported that the machine was nearly full.
    cap = lc.capacity()
    if cap["known"]:
        total_mb, avail_mb, swap_mb = cap["total_mb"], cap["available_mb"], cap["swap_mb"]
        room = cap["room"]
        detail = f"{avail_mb} MB available of {total_mb} MB"
        if room >= 2:
            # No count when there is plenty. The count exists to answer "can I
            # start another one", and while the answer is an unqualified yes it is
            # a number to read past; the two rows below still say it the moment it
            # stops being one.
            line(SUBJECT, "ok", f"Memory: {detail}")
        elif room == 1:
            line(SUBJECT, "warn", f"Memory: {detail} — room for about 1 more workspace")
        else:
            line(SUBJECT, "warn", f"Memory: {detail} — NOT enough for another workspace. "
                         "`houston stop --name <it>` frees memory and keeps the data")
        if swap_mb == 0:
            line(SUBJECT, "warn", "No swap: memory pressure becomes an OOM kill rather than "
                         "slowdown, and the kernel picks its own victim", check="swap")
    return report.rows
