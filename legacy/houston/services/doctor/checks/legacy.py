"""Leftovers from a previous name or layout.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import exec as subprocess
from houston import runner

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "legacy-artifacts"


def _legacy_edge_containers(line) -> None:
    """A pre-rename edge still holding :80/:443, which stops the new one starting.

    Lifted out of `check` for size alone; the call sits where this code sat, inside the
    one `try`.
    """
    from houston.services import migrate as _mig

    if runner.docker_available():
        try:
            seen = subprocess.run(
                ["docker", "ps", "--filter",
                 f"label=com.docker.compose.project={_mig.LEGACY_EDGE_PROJECT}",
                 "--filter", "status=running", "--format", "{{.Names}}"],
                capture_output=True, text=True, timeout=15, check=False).stdout
        except (OSError, subprocess.SubprocessError):
            seen = ""
        held = (seen or "").strip().splitlines()
        if held:
            line(SUBJECT, "warn", f"{held[0]} is the pre-rename edge and still holds :80 and "
                         f":443, so the new one cannot start — `docker compose -p "
                         f"{_mig.LEGACY_EDGE_PROJECT} down` then `houston edge start`",
                 check=SUBJECT)


def _legacy_ca_anchor(line) -> None:
    """A CA anchor installed under the previous name.

    Lifted out of `check` for size alone; the call sits where this code sat, inside the
    one `try`.
    """
    from pathlib import Path

    for anchor_dir in ("/usr/local/share/ca-certificates",
                       "/etc/pki/ca-trust/source/anchors"):
        old_ca = Path(anchor_dir) / "rc-repro-local-ca.crt"
        if old_ca.exists():
            # NOT stale, and saying so would be actively harmful. `ensure_ca` is
            # idempotent, so the migration carried the SAME certificate authority
            # across -- this anchor holds the CA that is still signing every local
            # name. Removing it first, as this used to advise, breaks trust for all
            # of them until `trust-ca` runs. The old filename is the only problem,
            # and it is cosmetic.
            line(SUBJECT, "ok", f"{old_ca} still carries the local CA in use — it keeps "
                       f"working under its old name. `houston trust-ca` installs "
                       f"the same certificate under its new name; remove the old "
                       f"file "
                       f"only after that, and only for tidiness", check=SUBJECT)


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # WHAT THE RENAME COULD NOT MOVE. `services/migrate.py` adopts the state
    # directory, but three classes of thing are outside its reach: anything root-owned
    # (a sudo decision, not an unattended one), the shared edge (taking :80 and :443
    # down is an outage nobody asked for), and copies this tool installed into other
    # tools' directories. Each is INVISIBLE rather than broken -- a stale systemd unit
    # fails at boot, an orphaned skill teaches an agent commands that no longer exist,
    # a surviving edge silently keeps the port the new one needs. Silent when clean:
    # a box that never ran the old name gets no rows about it.
    try:
        from pathlib import Path

        from houston import config as _cfg
        from houston.services import migrate as _mig

        legacy_state = Path.home() / _mig.LEGACY_HOME_DIRNAME
        if legacy_state.is_dir():
            line(SUBJECT, "warn", f"{legacy_state} is still here. It is adopted automatically "
                         f"unless HOUSTON_HOME is set, which it is — unset it and run "
                         f"any houston command, or move it by hand", check=SUBJECT)

        stale_env = _cfg.legacy_env_used()
        if stale_env:
            line(SUBJECT, "warn", f"reading the pre-rename {', '.join(stale_env)}; rename to "
                         f"HOUSTON_* — the old names will stop being read", check=SUBJECT)

        unit = Path("/etc/systemd/system/rc-repro.service")
        if unit.exists():
            line(SUBJECT, "warn", f"{unit} is the pre-rename service and will fail at boot — "
                         f"`sudo systemctl disable --now rc-repro && sudo rm {unit}`, "
                         f"then `houston serve --print-service` for the new one",
                 check=SUBJECT)

        for host_dir in (".claude/skills", ".agents/skills"):
            old_skill = Path.home() / host_dir / "rc-repro"
            if old_skill.is_dir():
                line(SUBJECT, "warn", f"{old_skill} still teaches agents to run `rc-repro`, a "
                             f"command that no longer exists — `rm -rf {old_skill}` "
                             f"and `houston skill install`", check=SUBJECT)

        # Deliberately NOT flagged: `rcrepro-<name>` containers. A workspace created
        # before the rename keeps the project its containers carry, and `project_name`
        # now reads that rather than deriving it -- those are adopted, not orphaned.
        # The edge is the exception, because it is a singleton: only one process can
        # hold :80 and :443, so the old one surviving means the new one cannot start.
        _legacy_edge_containers(line)

        _legacy_ca_anchor(line)
    except Exception:  # noqa: BLE001 - a check must never break the report
        line(SUBJECT, "warn", "could not check for pre-rename leftovers", check="legacy-artifacts")
    return report.rows
