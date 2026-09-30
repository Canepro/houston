"""The engine's kernel against MongoDB 8 (SERVER-121912).

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import runner
from houston.services.doctor.probes import (_mongo_kernel_conflict)

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "engine-kernel"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # Engine/VM kernel vs Mongo 8 (SERVER-121912): mongod 8.0 hard-exits on
    # kernel >= 6.19, which recent RC versions require. Common on fresh Podman /
    # FCOS machines and easy to misread as a volume/permission failure.
    if ctx.docker_up:
        kv = runner.docker_kernel_version()
        if _mongo_kernel_conflict("8.0", kv):
            line(SUBJECT, "warn", f"engine kernel {kv} — MongoDB 8.0 will not start (SERVER-121912); "
                         "use an engine on kernel < 6.19 for RC versions that require Mongo 8")
        elif kv:
            line(SUBJECT, "ok", f"engine kernel {kv}")
    return report.rows
