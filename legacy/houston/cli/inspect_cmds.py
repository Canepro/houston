"""Looking at a workspace without changing it: `list` `info` `logs` `ready` `stats`.

`ready` is here rather than with the lifecycle commands on purpose: it starts nothing
and stops nothing, it polls `/api/info` until Rocket.Chat answers. What it shares with
`list` and `stats` is that running it twice costs nothing and tells you the same thing.
"""
from __future__ import annotations

import time

import typer

from houston import config, errors, jsonout, perf, runner, ui
from houston.services import lifecycle as lcsvc
from houston.services import topology
from houston.cli._common import (_cli_emit,
                                 _fail, _require_engine, _resolve_name)
from houston.cli._render import (_fmt_duration, _print_notes, _print_resources,
                                 _short_container,
                                 _summary_panel)


def ready(
    name: str = typer.Option("", "--name", "-n"),
    timeout: float = typer.Option(300.0, "--timeout", help="seconds to wait"),
    json_out: bool = typer.Option(False, "--json", help="NDJSON progress on stdout, then one final JSON envelope"),
) -> None:
    """Block until Rocket.Chat is serving (polls /api/info)."""
    if json_out:
        jsonout.activate()
    target = _resolve_name(name)
    _require_engine(target)
    m = runner.read_meta(target)
    if not json_out:
        typer.echo(f"Waiting for {m.name!r} to serve {m.root_url} ...")
    writer = jsonout.EventWriter() if json_out else None
    try:
        result = lcsvc.wait_and_finalize(
            m, emit=(writer.emit if writer else _cli_emit), timeout=timeout)
    except errors.ReproError as exc:
        # A TIMEOUT is NotReadyError -> exit 5 ("still unknown, poll again"), which
        # is deliberately not the exit 7 of a create that is known dead. A poller
        # that cannot tell those apart either gives up on a slow boot or waits
        # forever on a corpse.
        _fail(exc)
    if json_out:
        jsonout.reply("ready", {**result, "name": m.name, "url": m.external_url})
        return
    ui.ok("✓ ready")
    _summary_panel(m, extra_rows=[("Booted in", _fmt_duration(result["booted_s"]))])
    ui.hint(f"  next: houston logs --name {m.name} -f")
    _print_notes(m)


def list_cmd(
    json_out: bool = typer.Option(False, "--json", help="print the result as one JSON envelope (see `--json` on `info`)"),
) -> None:
    """List all repros with version, port, status and URL."""
    if json_out:
        jsonout.activate()
    # INSIDE the try. This call reads every repro.json and asks docker for the
    # project states, so it is not the "obviously safe" line it looks like -- and
    # unguarded, a ReproError here reached a --json caller as a traceback on stderr
    # with nothing on stdout, which is the one thing the envelope exists to prevent.
    try:
        repros = lcsvc.list_repros()
    except errors.ReproError as exc:
        _fail(exc)
    if json_out:
        # An empty list is a SUCCESS, not the prose "No repros yet". A caller
        # asking "what is on this box" and getting nothing has its answer.
        jsonout.reply("list", {"repros": repros, "count": len(repros)})
        return
    if not repros:
        typer.echo("No repros yet. Create one with `houston up --version <X.Y.Z>`.")
        return
    # The owner column only appears on a shared box, so single-user output --
    # and anything parsing it -- is unchanged.
    shared = any(r.get("created_by") for r in repros)
    owner_h = f"{'OWNER':<12} " if shared else ""
    typer.echo(f"{'NAME':<20} {owner_h}{'RC':<9} {'MONGO':<7} {'WHERE':<8} "
               f"{'PORT':<6} {'STATE':<10} URL")
    for r in repros:
        flag = "*" if r["default"] else (" " if not r["pinned"] else "·")
        owner = f"{(r.get('created_by') or '-'):<12} " if shared else ""
        typer.echo(
            f"{flag}{r['name']:<19} {owner}{r['rc_version']:<9} {r['mongo_tag']:<7} "
            # "compose"/"k8s" rather than the canonical names: this is a narrow
            # column read at a glance, and the canonical value is in `info`.
            f"{('k8s' if r.get('runtime') == topology.KUBERNETES else 'compose'):<8} "
            f"{r['host_port']:<6} {r['state']:<10} {r.get('public_url') or r['root_url']}"
        )
    typer.echo("\n* = default repro   · = pinned")


def info(
    name: str = typer.Option("", "--name", "-n"),
    json_out: bool = typer.Option(False, "--json", help="print the result as one JSON envelope on stdout; prose moves to stderr"),
) -> None:
    """Show a repro's URL, admin credentials and a curl snippet."""
    if json_out:
        jsonout.activate()
    target = _resolve_name(name)
    if json_out:
        # The full detail payload, which is what makes this the command to paste
        # into a ticket. It carries the admin login -- a fixed sandbox credential
        # this tool prints on every `up` and documents in the README, not a secret.
        # Anything that IS one is masked before it gets here (lifecycle.redact_env).
        try:
            jsonout.reply("info", lcsvc.detail(target))
        except errors.ReproError as exc:
            _fail(exc)
        return
    m = runner.read_meta(target)
    _summary_panel(m)
    ui.hint(f"  api  : houston api --name {m.name} GET /api/v1/me")
    ui.hint(f"  curl : {m.root_url}/api/info")
    _print_notes(m)


def _kubernetes_stats(meta, seconds, watch):
    """Sample every pod in the namespace, continuously or to a window peak."""
    from houston.services import k8s
    context = str((meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    deadline = time.monotonic() + (0.0 if watch else max(0.0, seconds))
    peak: dict[str, dict] = {}
    while True:
        try:
            rows = k8s.pod_metrics(meta.name, context=context, selector="")
        except errors.ReproError as exc:
            _fail(exc)
        if watch:
            _print_pod_metrics(rows)
        else:
            for row in rows:
                previous = peak.get(row["pod"])
                if previous is None or row["mem_bytes"] > previous["mem_bytes"]:
                    peak[row["pod"]] = dict(row)
                else:
                    previous["cpu_millicores"] = max(
                        previous["cpu_millicores"], row["cpu_millicores"])
            if time.monotonic() >= deadline:
                _print_pod_metrics(sorted(peak.values(), key=lambda item: -item["mem_bytes"]))
                return
        try:
            time.sleep(2)
        except KeyboardInterrupt:
            return


def _print_pod_metrics(rows):
    """Render one Kubernetes metrics sample in the CLI's stable column shape."""
    typer.echo("")
    for row in rows:
        typer.echo(f"  {row['pod']:<44} CPU {row['cpu_millicores']:>6.0f}m"
                   f"   RAM {row['mem_bytes'] / 1e6:>7.1f} MB")
    if not rows:
        ui.note("no pods are running in this workspace's namespace")


def stats(
    name: str = typer.Option("", "--name", "-n"),
    for_: float = typer.Option(5.0, "--for", help="seconds to sample"),
    watch: bool = typer.Option(False, "--watch", "-w", help="stream live (Ctrl-C to stop)"),
) -> None:
    """Sample a repro's container CPU/RAM (peak over a window, or --watch live)."""
    target = _resolve_name(name)
    _require_engine(target)
    m = runner.read_meta(target)
    if topology.of_repro(m.name) == topology.KUBERNETES:
        return _kubernetes_stats(m, for_, watch)
    if watch:
        typer.echo(f"Live stats for {m.name!r} (Ctrl-C to stop)…")
        try:
            while True:
                ids = runner.container_ids(m.name)
                out = runner.docker_stats(ids)
                typer.echo("")
                for line in out.splitlines():
                    parts = line.split("\t")
                    if len(parts) >= 3:
                        typer.echo(f"  {_short_container(parts[0], m.name):<14} CPU {parts[1]:>7}   RAM {parts[2]}")
                time.sleep(2)
        except KeyboardInterrupt:
            return
    typer.echo(f"Sampling {m.name!r} for {for_:.0f}s…")
    with perf.ResourceMonitor(m.name) as mon:
        time.sleep(for_)
    _print_resources(mon.report(), m.name)


def logs(
    name: str = typer.Option("", "--name", "-n"),
    follow: bool = typer.Option(False, "--follow", "-f", help="stream logs"),
    tail: int = typer.Option(0, "--tail", help="only the last N lines (0 = all)"),
) -> None:
    """Tail a repro's logs."""
    target = _resolve_name(name)
    _require_engine(target)
    # Logs are the first thing anyone reads when reproducing a ticket, so this
    # dispatches rather than refusing. It used to send Kubernetes users away with a
    # `kubectl` line -- workable in a terminal, and nothing at all in the browser,
    # where `serve` exists precisely so a support engineer needs no shell.
    if topology.of_repro(target) == topology.KUBERNETES:
        from houston.services import k8s
        meta = runner.read_meta(target)
        context = str((meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
        proc = k8s.log_process(target, context=context, tail=tail or 200,
                               follow=follow)
        try:
            for line in proc.stdout or []:
                typer.echo(line.rstrip("\n"))
        except KeyboardInterrupt:      # Ctrl-C on a follow is how you leave
            pass
        finally:
            proc.terminate()
        raise typer.Exit(proc.wait() or 0)
    runner.logs(target, follow=follow, tail=tail or None)
