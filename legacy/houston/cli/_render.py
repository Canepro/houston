"""Turning a result document into something a person reads in a terminal.

Rendering only. Nothing here decides anything, asks anything, or fails: the panels, the
note lists, the byte and duration formatting and the ASCII fallback for a terminal that
cannot draw the box characters. Keeping it apart from `_common.py` is what stops "how a
workspace is summarised" from drifting between the three commands that summarise one.

This module imports nothing from `houston.cli`.
"""
from __future__ import annotations

import re
import shutil
import textwrap

import typer

from houston import config, runner, ui
from houston.services import lifecycle as lcsvc

def _fmt_duration(secs: int) -> str:
    """Human duration: 42s, 1m03s."""
    return f"{secs}s" if secs < 60 else f"{secs // 60}m{secs % 60:02d}s"


_ASCII_MAP = str.maketrans({
    "—": "-", "–": "-", "…": "...", "’": "'", "‘": "'",
    "“": '"', "”": '"', "→": "->", "←": "<-", "·": "-", " ": " ",
})


def _ascii(text: str) -> str:
    return text.translate(_ASCII_MAP)


def _tls_label(meta: runner.Metadata) -> str:
    """How the cert was obtained, for the summary panel."""
    return {
        "local": "local CA (houston trust-ca)",
        "acme": "Let's Encrypt",
        "own": "supplied certificate",
    }.get(str(meta.extra.get("tls") or ""), "enabled")


def _summary_panel(meta: runner.Metadata, extra_rows: list[tuple[str, str]] | None = None) -> None:
    """The boxed repro summary (URL + login + versions), shared by up/ready/info,
    followed by multi-instance URLs. Title is the repro name only — kept pure
    ASCII so box-drawing alignment can't be thrown off by wide/emoji glyphs
    (status like "✓ ready" is printed on its own line by the caller)."""
    # `mongo_flavor` describes a COMPOSE image choice, and the Kubernetes path makes
    # its own -- so printing it there claimed an image that workspace does not run.
    # Where the runtime recorded what it actually built, say that instead.
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    managed_by = extra.get("mongo_managed_by", "")
    mongo = (f"{meta.mongo_tag} (via the {managed_by})" if managed_by
             else f"{meta.mongo_tag} ({meta.mongo_flavor})")
    rows = [
        ("Rocket.Chat", meta.rc_version),
        ("MongoDB", mongo),
        ("Preset", meta.preset),
        # external_url, not root_url: with --https the browser wants the https URL,
        # while root_url stays the plain http one houston's own API calls use.
        ("URL", meta.external_url),
        ("Login", f"{config.ADMIN_USERNAME} / {meta.admin_pass}"),
    ]
    owner = meta.extra.get("created_by", "") if isinstance(meta.extra, dict) else ""
    if owner:
        rows.append(("Owner", owner))
    if meta.public_url:
        rows.append(("TLS", _tls_label(meta)))
        rows.append(("Direct HTTP", meta.root_url))
    rows += extra_rows or []
    ui.panel(meta.name, rows)
    n = meta.extra.get("instances")
    if n:
        ui.hint(f"  instances ({n}, load-balanced by Traefik):")
        for i in range(1, int(n) + 1):
            ui.hint(f"    rocketchat-{i}: http://localhost:{meta.host_port + i}")


def _render_create_result(result: dict) -> None:
    """Format a create_repro result the way `up` used to (panel + notes + hints)."""
    meta = runner.read_meta(result["name"])
    if result.get("waited"):
        ui.ok("✓ ready")
        extra = [("Booted in", _fmt_duration(result["booted_s"]))] if result.get("booted_s") is not None else None
        _summary_panel(meta, extra_rows=extra)
        ui.hint(f"  next: houston logs --name {meta.name} -f")
    else:
        ui.ok("✓ starting")
        _summary_panel(meta)
        ui.hint(f"  ready when serving : houston ready --name {meta.name}")
        ui.hint(f"  follow logs        : houston logs --name {meta.name} -f")
    _print_notes(meta)


def _short_container(full: str, repro_name: str, keep_index: bool = False) -> str:
    """houston-<name>-rocketchat-1 -> rocketchat (or rocketchat-1 if keep_index)."""
    s = full
    prefix = f"{config.PROJECT_PREFIX}{repro_name}-"
    if s.startswith(prefix):
        s = s[len(prefix):]
    return s if keep_index else re.sub(r"-\d+$", "", s)


def _short_res_map(resources: dict, repro_name: str) -> dict:
    """Short-name-keyed resource map, keeping the instance index when a base name
    repeats (multi-instance rocketchat-1/-2/-3) so no row overwrites another."""
    bases = [_short_container(k, repro_name) for k in resources]
    dup = {b for b in bases if bases.count(b) > 1}
    out = {}
    for k, v in resources.items():
        base = _short_container(k, repro_name)
        out[_short_container(k, repro_name, keep_index=True) if base in dup else base] = v
    return out


def _print_resources(report: dict, repro_name: str) -> None:
    if not report:
        return
    typer.echo("")
    ui.note("Resource cost (idle -> peak):")
    labelled = _short_res_map(report, repro_name)
    for name in sorted(labelled):
        r = labelled[name]
        mem_delta = (r.peak_mem - r.idle_mem) / 1e6
        typer.echo(
            f"  {name:<14} "
            f"CPU {r.idle_cpu:.0f}% -> {r.peak_cpu:.0f}%   "
            f"RAM {r.peak_mem/1e6:.0f} MB (+{mem_delta:.0f})"
        )


def _note_lines(line: str, width: int) -> list[str]:
    """One note line, as terminal lines.

    An INDENTED line is something to paste, and is never wrapped. It used to be, and
    the box it was wrapped inside made it worse: `kubectl -n houston-x port-forward
    deployment/rocketchat-` on one line and `  rocketchat 3000:3000` on the next is a
    command that fails when it is pasted, which is the only thing anybody does with
    it. It overflows the width instead, and the terminal soft-wraps a line that is
    still one line to select.
    """
    text = _ascii(line)
    if text[:1] == " " and text.strip():
        return ["      " + text.strip()]
    # break_on_hyphens=False: the default splits "metrics-server" across two lines,
    # and a reader who greps for the word it named does not find it.
    return textwrap.wrap(text, width=width, initial_indent="    ",
                         subsequent_indent="    ", break_on_hyphens=False) or [""]


def _print_notes(meta: runner.Metadata) -> None:
    """What is in this workspace, as sections rather than one wall of bullets.

    Rendered from the GROUPS (see services/lifecycle.note_group), so the terminal and
    the browser show the same structure from one definition -- facts as an aligned
    two-column block, prose wrapped, and the things you have to paste set off on their
    own and never wrapped.

    No box. A box has to wrap its content to its own width, and the content here
    includes commands that must survive a copy; the group titles already say where one
    section ends and the next begins, which is the only thing the border was doing.
    """
    groups = lcsvc.note_groups_of(meta)
    if not groups:
        # A workspace with notes that no group accounts for: still shown, ungrouped,
        # through the same renderer rather than a second one.
        flat = list(meta.extra.get("notes") or []) if isinstance(meta.extra, dict) else []
        if not flat:
            return
        groups = [lcsvc.note_group("", body=flat)]
    width = min(shutil.get_terminal_size((90, 24)).columns, 88)
    ui.line("")
    # A dim divider, not a heading: the group titles below are the headings, and a
    # second cyan bold line above them made the two read as peers.
    head = "what is in this workspace "
    ui.line("  " + typer.style(head + "-" * max(1, width - len(head) - 3),
                               fg=typer.colors.BRIGHT_BLACK))
    for g in groups:
        rows = g.get("rows") or []
        body = g.get("body") or []
        cmds = g.get("commands") or []
        if not (rows or body or cmds):
            continue                      # a title with nothing under it is not a section
        ui.line("")
        if g.get("title"):
            ui.note("  " + _ascii(str(g["title"])), bold=True)
        if rows:
            kw = max(len(str(k)) for k, _ in rows)
            for k, v in rows:
                ui.line(f"    {_ascii(str(k)).ljust(kw)}   {_ascii(str(v))}")
        for line in body:
            for out in _note_lines(line, width - 6):
                ui.line(out)
        for c in cmds:
            ui.line("      " + _ascii(str(c)))


def _human_bytes(n: int) -> str:
    from houston.services.backup import _human
    return _human(n)
