"""Free space where images and volumes land.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations

import shutil


from houston import config

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "disk"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # Disk headroom (RC images are ~1.5 GB each).
    try:
        free_gb = shutil.disk_usage(config.home().parent).free / 1e9
        if free_gb >= 10:
            line(SUBJECT, "ok", f"Disk: {free_gb:.0f} GB free")
        else:
            line(SUBJECT, "warn", f"Disk: only {free_gb:.0f} GB free — images are ~1.5 GB each")
    except OSError:
        line(SUBJECT, "warn", "couldn't check disk space")
    return report.rows
