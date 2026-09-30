"""Workspaces whose preset points the browser at this machine.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import runner

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "preset-browser-host"


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # THE WORKSPACES ALREADY OUT THERE. `up` warns about this at create time now, but
    # every workspace made before that is silent: an IdP preset addresses its own
    # service as THIS machine by default, which on a shared box names each visitor's
    # own laptop -- the SAML button returns to the login page, the OIDC popup opens
    # blank, presigned previews fail, and none of them logs anything.
    _HOST_PARAM = {"saml": "idp_host", "oidc": "idp_host", "s3_minio": "s3_host"}
    try:
        for meta in runner.list_meta():
            param = _HOST_PARAM.get((meta.preset or "").strip())
            if not param:
                continue
            extra = meta.extra if isinstance(meta.extra, dict) else {}
            if (dict(extra.get("params") or {})).get(param):
                continue          # someone said where the browser is
            bind = str(extra.get("bind_host") or "")
            if bind in ("", "127.0.0.1", "localhost"):
                continue          # local-only, so localhost really is localhost
            line(SUBJECT, "warn", f"{meta.name!r} is bound to {bind} but its {meta.preset!r} "
                         f"preset still points the browser at this machine. From "
                         f"anywhere else that address is the visitor's own laptop and "
                         f"login fails silently. Re-create with "
                         f"`--set {param}=<the host people type>`",
                 check="preset-browser-host")
    except Exception:  # noqa: BLE001 - a check must never break the report
        pass
    return report.rows
