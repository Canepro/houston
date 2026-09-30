"""The commands that belong to no group: monitor, presets, versions, doctor, capabilities, skill.

Not a leftovers drawer -- what they share is that none is about one workspace's
lifecycle. `doctor` and `capabilities` answer questions about the BOX (and
`capabilities` answers offline, deliberately: it is asked before anyone knows whether
the environment works, and "does this box work" is `doctor`). `presets` and `versions`
answer questions about what houston can build. `monitor` attaches or detaches the
Prometheus and Grafana add-on, and `skill` installs the agent skill file.
"""
from __future__ import annotations

import shutil
import textwrap

import typer

from houston import errors, jsonout, presets, ui, versions
from houston.services import monitor as monitorsvc
# `capabilities` reports what THIS build can do, which means asking the Typer app
# itself. The leaf, never the package: importing `houston.cli` from a command module
# is the circle `_app.py` exists to keep open.
from houston.cli._app import app
from houston.cli._common import (_cli_emit,
                                 _err, _fail, _resolve_name)
from houston.cli._render import (_ascii)


def monitor(
    name: str = typer.Option("", "--name", "-n"),
    off: bool = typer.Option(False, "--off", help="detach: remove Prometheus + Grafana"),
) -> None:
    """Attach (or --off to detach) Prometheus + Grafana on a running repro."""
    target = _resolve_name(name)
    try:
        if off:
            res = monitorsvc.detach(target, emit=_cli_emit)
            ui.ok(f"✓ monitoring detached from {res['name']!r}"
                  + ("" if res["rc_setting_reset"] else " (metrics setting left as-is — repro not reachable)"))
            # On Kubernetes the stack is shared, so "detached" does not mean
            # "gone" -- and a user who came to free memory needs to know which
            # of the two happened.
            if res.get("stack_removed") is False:
                ui.note("the shared monitoring stack stays up — other workspaces "
                        "on this cluster are still using it")
        else:
            res = monitorsvc.attach(target, emit=_cli_emit)
            ui.ok(f"✓ monitoring attached to {res['name']!r}")
            typer.echo("")
            for line in res["notes"]:
                ui.note(line)
    except errors.ReproError as exc:
        _fail(exc)


def presets_cmd() -> None:
    """List available presets."""
    items = presets.list_presets()
    inner = min(shutil.get_terminal_size((90, 24)).columns, 88) - 4   # box content width
    typer.secho("Presets", bold=True)
    typer.echo("")
    for p in items:
        lines = textwrap.wrap(_ascii(" ".join(p.description.split())), width=inner) or [""]
        if p.params_help:
            lines.append("")
            key_w = max(len(k) for k in p.params_help)
            for key, help_text in p.params_help.items():
                entry = f"--set {key.ljust(key_w)}   {_ascii(' '.join(help_text.split()))}"
                cont = " " * (len("--set ") + key_w + 3)   # hang-indent wrapped help
                lines += textwrap.wrap(entry, width=inner, subsequent_indent=cont)
        title = p.name + ("  [needs license]" if p.requires_license else "")
        ui.box(title, lines, inner)
        typer.echo("")
    ui.hint("run: houston up --version <X.Y.Z> --preset <name> [--set key=value]")


def versions_cmd(
    version: str = typer.Argument(..., help="Rocket.Chat version, e.g. 7.4.1"),
    offline: bool = typer.Option(False, "--offline"),
) -> None:
    """Show the resolved MongoDB pairing for a Rocket.Chat version."""
    try:
        r = versions.resolve(version, offline=offline)
    except ValueError as exc:
        _err(str(exc))
    typer.echo(f"Rocket.Chat {r.rc_version}")
    typer.echo(f"  image        : {r.rc_image}:{r.rc_version}")
    typer.echo(f"  mongo        : {r.mongo_tag}  (flavor: {r.mongo_flavor}, shell: {r.mongo_shell})")
    typer.echo(f"  oplog url    : {'yes' if r.oplog else 'no (deprecated in 8.x)'}")
    typer.echo(f"  resolved via : {r.source}")
    if r.note:
        typer.echo(f"  note         : {r.note}")


def capabilities() -> None:
    """What this build can do, as JSON, for an agent or a script.

    No `--json` flag, deliberately: this command IS JSON. A flag that is accepted
    and then ignored is worse than no flag.

    Every field is derived from the registered app rather than written out, because
    a hardcoded list is right on the day it is written and wrong the first time a
    flag moves -- which is exactly the drift a caller reads this to avoid. Answers
    offline and with no container engine: it is asked BEFORE anybody knows whether
    the environment works, and the question "does this box work" is `doctor`.
    """
    jsonout.activate()
    jsonout.reply("capabilities", jsonout.capabilities(app))


def skill_install(
    host: str = typer.Option("all", "--host", help="claude | agents | all"),
    force: bool = typer.Option(False, "--force", help="overwrite a locally-edited copy"),
    json_out: bool = typer.Option(False, "--json", help="print the result as one JSON envelope"),
) -> None:
    """Copy the packaged skill where an agent will find it."""
    from houston.services import skill as skillsvc
    if json_out:
        jsonout.activate()
    try:
        res = skillsvc.install(host, force=force)
    except errors.ReproError as exc:
        _fail(exc)
    if json_out:
        jsonout.reply("skill-install", res)
        return
    for row in res["hosts"]:
        (ui.ok if row["action"] != "unchanged" else ui.hint)(
            f"  {row['action']:<9} {row['path']}")
    ui.hint(f"  version {res['version']}")


def skill_status(
    json_out: bool = typer.Option(False, "--json", help="print the result as one JSON envelope"),
) -> None:
    """Whether the installed skill matches this build."""
    from houston.services import skill as skillsvc
    if json_out:
        jsonout.activate()
    st = skillsvc.state()
    if json_out:
        jsonout.reply("skill-status", st)
        return
    for host, row in sorted(st["hosts"].items()):
        mark = {"current": ui.ok, "absent": ui.hint}.get(row["status"], ui.warn)
        mark(f"  {host:<8} {row['status']:<9} {row['path']}")
    if not st["current"]:
        ui.hint("  `houston skill install` writes the copy this build ships.")


def doctor(
    json_out: bool = typer.Option(False, "--json", help="print the report as one JSON envelope; exits 3 on any failing check"),
    context: str = typer.Option("", "--context", help="report on this Kubernetes cluster by kubeconfig context name, as `up --context` would use it"),
) -> None:
    """Preflight: check Docker, Compose, disk, connectivity and ports."""
    from houston.services import doctor as doctorsvc
    if json_out:
        jsonout.activate()
    report = doctorsvc.run_checks(context=context)
    if json_out:
        # `doctor --json` used to answer `{"ok": true, "warnings": [], "data":
        # {"verdict": "warn", "counts": {"warn": 6}}}`. Six warnings, and the field
        # designed to carry them empty -- reachable through data.checks[].status, which
        # is not what a caller is told to read.
        for row in report.get("checks", []):
            if row.get("status") in ("warn", "fail"):
                jsonout.warn_once(f"DOCTOR_{str(row.get('check') or 'check').upper()}"
                                  .replace("-", "_"),
                                  str(row.get("message") or ""),
                                  check=row.get("check"), status=row.get("status"))
        if report["verdict"] == "fail":
            # The envelope and the process must describe the same outcome. A success
            # envelope followed by exit 3 makes a machine caller choose which half of
            # the contract to believe. The individual failed rows remain available as
            # structured warnings, while the stable error code carries the verdict.
            jsonout.fail(errors.PreflightError("doctor checks failed", details=report), warnings=jsonout.warnings_so_far())
        jsonout.reply("doctor", report)
        return
    marks = {
        "ok": ("\u2713", typer.colors.GREEN),
        "warn": ("\u26a0", typer.colors.YELLOW),
        "fail": ("\u2717", typer.colors.RED),
    }
    for row in report["checks"]:
        sym, color = marks[row["status"]]
        typer.secho(f'{sym} {row["message"]}', fg=color)
    if report["repros"]:
        typer.echo(f'  repros: {report["repros"]["total"]} total, '
                   f'{report["repros"]["running"]} running')
    typer.echo("")
    if report["verdict"] == "fail":
        typer.secho("Not ready — fix the ✗ item(s) above.", fg=typer.colors.RED)
        raise typer.Exit(1)
    if report["verdict"] == "warn":
        typer.secho("Usable, with warnings above.", fg=typer.colors.YELLOW)
    else:
        typer.secho("All good — houston is ready.", fg=typer.colors.GREEN)
