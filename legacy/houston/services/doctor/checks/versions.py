"""Whether the RC->MongoDB pairing can be looked up.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations


import requests


from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "version-lookup"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # Live version lookup reachability.
    try:
        r = requests.get("https://releases.rocket.chat/8.5.1/info", timeout=5)
        if r.status_code == 200:
            line(SUBJECT, "ok", "releases.rocket.chat reachable (live version lookup available)")
        else:
            line(SUBJECT, "warn", "releases.rocket.chat returned non-200 — use `--offline` if needed")
    except requests.RequestException:
        line(SUBJECT, "warn", "releases.rocket.chat unreachable — use `--offline` (falls back to shipped map)")
    return report.rows
