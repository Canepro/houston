"""Whether this install is newer than the box thinks.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations

import re



from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "install-fresh"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # WHICH BUILD IS ACTUALLY RUNNING. `__version__` comes from the INSTALLED
    # distribution metadata, so a stale editable install or a pipx that was never
    # refreshed reports an old number while the checkout beside it holds the fix.
    # Three shipped fixes looked ineffective for exactly this reason, and nothing in
    # the tool said which build was answering.
    try:
        from pathlib import Path

        import houston as _pkg

        src = Path(_pkg.__file__).resolve().parent.parent / "pyproject.toml"
        if src.is_file():
            found = re.search(r'^version = "([^"]+)"', src.read_text(encoding="utf-8"), re.M)
            checkout = found.group(1) if found else ""
            if checkout and checkout != _pkg.__version__:
                line(SUBJECT, "warn", f"running houston {_pkg.__version__}, but the checkout at "
                             f"{src.parent} is {checkout} — the installed metadata is "
                             f"stale, so a fix in that tree is NOT what is answering. "
                             f"`pip install -e .` (or `pipx reinstall`) to catch up")
            else:
                line(SUBJECT, "ok", f"houston {_pkg.__version__}, matching the checkout at "
                           f"{src.parent}")
        else:
            # A packaged install with no source beside it: nothing to disagree with,
            # and saying the version is still the useful half of the answer.
            line(SUBJECT, "ok", f"houston {_pkg.__version__} (installed, no checkout alongside)")
    except Exception:  # noqa: BLE001 - a check must never break the report
        line(SUBJECT, "warn", "could not determine which houston build is running")
    return report.rows
