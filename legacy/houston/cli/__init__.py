"""houston command-line interface (Typer)."""

from __future__ import annotations

import sys
import time
from typing import NoReturn

import typer

from houston import config, errors, jsonout, lock, ui
# The Typer instances come from a LEAF module. `_app.py`'s docstring says why: putting
# them here deadlocks the package against its own command modules.
from houston.cli._app import app, skill_app
# `_common` and `_render` are imported BY NAME, and only those two. Neither imports
# anything under `houston.cli`, so neither carries the parent edge back here that turns
# an import into a cycle -- which is exactly what disqualifies `_perf_render`, whose one
# `from houston.cli._render import ...` is enough to close the loop. Its symbols resolve
# lazily below with the commands'.
from houston.cli._common import (_UNSET, _cli_actor,  # noqa: F401
                                 _cli_actor_and_origin, _cli_emit, _err, _fail, _report,
                                 _HTTP_METHODS, _login, _log_failure, _not_answering,
                                 _parse_set_params, _port_claim_note, _promote_command,
                                 _rc_services_in, _require_docker, _require_engine,
                                 _resolve_name, _run_and_echo)
from houston.cli._render import (_ASCII_MAP, _ascii,  # noqa: F401
                                 _fmt_duration, _human_bytes, _note_lines,
                                 _print_notes, _print_resources, _render_create_result,
                                 _short_container, _short_res_map, _summary_panel,
                                 _tls_label)
from houston.services.events import Event

#: `houston.cli.<name>` -> the module that defines it, resolved on first access by
#: `__getattr__` below.
#:
#: LAZY, and that is a gate requirement rather than a nicety. Importing
#: `houston.cli.data_cmds` runs this initialiser first, so a command module that reaches
#: back here -- and every one of them does, through `_common` -- closes a cycle the
#: moment this file imports it by name. `tools/scc_check.py` reported exactly that:
#: one component of nine modules. Resolving on attribute access leaves no static edge,
#: which is the same shape `web/routes/__init__.py` uses.
#:
#: The names are here because `houston.cli.<x>` is how the suite reaches a good many of
#: them, and a package that answers for its own commands is worth keeping.
_LAZY = {
    "_app": None, "_common": None, "_render": None, "_perf_render": None,
    "_BOOL_CONFIG_KEYS": "settings_cmds", "_CONFIG_KEYS": "settings_cmds",
    "_clear_scale": "data_cmds", "_print_seed_result": "data_cmds",
    "_print_seed_verification": "data_cmds", "_run_scale": "data_cmds",
    "_run_seed": "data_cmds", "backup_cmd": "data_cmds", "backups_cmd": "data_cmds",
    "config_import": "data_cmds", "restore_cmd": "data_cmds", "seed_cmd": "data_cmds",
    "upgrade_cmd": "data_cmds",
    "_edge_route_host": "https_cmds", "_report_gui_tls": "https_cmds",
    "_tls_troubleshoot": "https_cmds", "edge_cmd": "https_cmds",
    "tls_status": "https_cmds", "trust_ca": "https_cmds",
    "info": "inspect_cmds", "list_cmd": "inspect_cmds", "logs": "inspect_cmds",
    "ready": "inspect_cmds", "stats": "inspect_cmds",
    "capabilities": "other_cmds", "doctor": "other_cmds", "monitor": "other_cmds",
    "presets_cmd": "other_cmds", "skill_install": "other_cmds",
    "skill_status": "other_cmds", "versions_cmd": "other_cmds",
    "_fmt_compare_value": "_perf_render", "_load_shape": "_perf_render",
    "_login_seed_users": "_perf_render", "_metric": "_perf_render",
    "_print_compare": "_perf_render", "_print_diag": "_perf_render",
    "_print_loadtest": "_perf_render", "_print_steps": "_perf_render",
    "_status_breakdown": "_perf_render", "_workspace_snapshot": "_perf_render",
    "_loadtest_target": "_perf_run", "_parse_endpoint": "perf_cmds",
    "_parse_ramp": "perf_cmds", "capacity": "perf_cmds", "loadtest": "perf_cmds",
    "api": "rest_cmds", "pat": "rest_cmds", "token": "rest_cmds",
    "config_cmd": "settings_cmds", "env_cmd": "settings_cmds", "use": "settings_cmds",
    "_cluster_reclaimable": "lifecycle_cmds", "_orphan_owner": "lifecycle_cmds",
    "down": "lifecycle_cmds", "prune": "lifecycle_cmds", "restart": "lifecycle_cmds",
    "start": "lifecycle_cmds", "stop": "lifecycle_cmds", "up": "lifecycle_cmds",
    "cluster_cmd": "cluster_cmds", "CLUSTER_ACTIONS": "cluster_cmds",
    "audit_cmd": "gui_cmds", "chown_cmd": "gui_cmds", "serve": "gui_cmds",
    "users_cmd": "gui_cmds",
}

#: Names in `_LAZY` that are MODULES rather than symbols, so `__getattr__` hands back
#: the module itself.
_LEAF_MODULES = ("_app", "_common", "_render", "_perf_render")

#: The only `houston.cli.*` modules this initialiser may import BY NAME. Both import
#: nothing under `houston.cli`, so neither carries a parent edge back here. Everything
#: else -- including `_perf_render`, which imports `_render` -- goes through
#: `__getattr__`, or `tools/scc_check.py` reports the cycle.
_STATIC_IMPORTS_ALLOWED = ("_app", "_common", "_render")


def __getattr__(name: str):
    """Resolve a command or helper from the module that defines it, on first access."""
    if name not in _LAZY:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    where = _LAZY[name] or name
    module = import_module(f"{__name__}.{where}")
    value = module if name in _LEAF_MODULES else getattr(module, name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_LAZY))



def _print_version(value: bool) -> None:
    """`--version`, eager so it answers before any command is resolved.

    It did not exist, while CONTRIBUTING and this project's own notes told people
    to run it to check what a box has -- and the only place the number appeared at
    all was the sign-in page footer, which needs the GUI up and reachable to read.
    So the one question you ask a remote box after deploying to it ("did the pull
    land?") had no answer from a shell, and a version bump meant to make that
    answerable was answerable only in a browser.

    Read from the INSTALLED distribution metadata, like `__version__` itself: that
    is the number the running code actually is, and a stale editable install
    reporting an old one is the true answer, not a bug to paper over.
    """
    if value:
        from houston import __version__
        typer.echo(f"houston {__version__}")
        raise typer.Exit(0)


@app.callback()
def _before_any_command(
    version: bool = typer.Option(False, "--version", "-V", is_eager=True,
                                 callback=lambda v: _print_version(v),
                                 help="print the installed houston version and exit"),
) -> None:
    """Runs before every command.

    Publishes who is running this so the service layer can audit without every
    command passing an actor down. Without it, `houston down --volumes` on a
    shared box appended a line reading `-` -- present, but useless.
    """
    from houston.services import audit as auditsvc
    actor, how = _cli_actor_and_origin()
    auditsvc.set_actor(actor)
    auditsvc.set_origin(how)


def _migration_emit(ev: Event) -> None:
    """Migration progress, always on stderr.

    This runs from the root callback, BEFORE the command has parsed `--json` and so
    before `jsonout.activate()` has put `ui` into stderr mode. Under `--json` stdout
    carries the envelope and nothing else, so the usual `_cli_emit` -- which reaches
    for `typer.echo` -- would corrupt the contract for any caller who happened to be
    the first to run after an upgrade. None of this is a command's data anyway.
    """
    if ev.level in ("warn", "error"):
        ui.warn(ev.message, err=True)
    else:
        typer.secho(f"  {ev.message}", err=True, fg=typer.colors.BRIGHT_BLACK)


def _adopt_pre_rename_state() -> None:
    """Move a pre-rename state directory into place, once, before anything reads it.

    Best-effort and never fatal. A box this cannot migrate must still be able to run
    `doctor`, because `doctor` is the command that explains why -- exiting here would
    take away the tool that diagnoses the thing that just went wrong.
    """
    try:
        from houston.services import migrate as migratesvc
        if not migratesvc.pending():
            return
        migratesvc.migrate(emit=_migration_emit)
    except errors.ReproError as exc:
        ui.warn(str(exc), err=True)
    except Exception:  # noqa: BLE001 - never let this stop a command running
        pass

# --- helpers ------------------------------------------------------------------












# Map the non-ASCII punctuation that shows up in preset descriptions to ASCII —
# em/en dashes, ellipsis, curly quotes, arrows etc. are East-Asian "ambiguous"
# width and render double-wide in some terminals, breaking box alignment.






# --- commands -----------------------------------------------------------------




























# Settings worth remembering, shown name -> config.yaml key. An allowlist, so a
# typo cannot write junk into the config file.
#: The settings that are booleans rather than strings. `config set` coerces these,
#: because storing what was typed made `false` truthy -- see `config.truthy`.






#: Distinguishes "this key is not set" from "this key is set to something falsy".
#: `None` cannot do it -- a config file may legitimately hold it -- and `or` cannot
#: either, which is the bug this exists to prevent recurring.













# --- backup / restore / upgrade -------------------------------------------------


































#: What `houston cluster` accepts. ONE tuple, because three things read it -- the
#: refusal below, the argument's own help, and the test that checks the shipped EKS
#: walkthrough still names commands that exist. A guide that tells somebody to run a
#: renamed action is worse than no guide.



_MAIN_HELP = """The console-script entry point, and the last line of the error contract.

    FOUR REACHABLE STATES RAISED A NON-ReproError and blew straight past every handler
    in this file: a workspace directory holding a docker-compose.yml and no repro.json
    (FileNotFoundError -- which is exactly what an interrupted create leaves between
    the two atomic_writes, and `runner.exists()` returns True for it while
    `list_meta()` skips it, so the workspace is invisible to `list` and reachable by
    name only as a traceback); a repro.json missing fields, from an older build or a
    truncated write (TypeError: Metadata.__init__() missing 7 required positional
    arguments); a malformed config.yaml (yaml.parser.ParserError); and a non-writable
    HOUSTON_HOME (PermissionError on .../locks).

    Each printed a Python traceback, exited 1, and under `--json` wrote ZERO BYTES to
    stdout. That last part is the one that matters: "exactly one envelope, and it is
    the last line" is the single promise a caller is told it may depend on, and it was
    broken precisely when the caller most needed it. Exit 1 is `internal` in
    EXIT_CODES, so a script could not tell a corrupt state file from a bug either.

    The traceback still goes to stderr, unabridged -- this changes where the failure is
    reported, not whether it is.
"""


def main() -> None:
    """Run the CLI behind its final error boundary."""
    # THE TIMELINE'S TWO ENDS. `run` ties every event between them to one invocation,
    # which is what makes the log readable backwards from a failure. Best-effort: a log
    # that cannot be written must not stop the command.
    # BEFORE the event log, which is the first thing in the process to write under
    # HOUSTON_HOME. One line into logs/houston.log is enough to make a freshly
    # created ~/.houston non-empty, and the adoption then refuses to move ~/.rc-repro
    # onto it -- stranding every workspace on the box behind a conflict this tool
    # caused itself, one command ago. Ordering is the whole fix.
    _adopt_pre_rename_state()
    try:
        lock.require_this_implementation(config.home())
    except errors.ReproError as exc:
        # THROUGH THE CONTRACT, not as a traceback. This runs before `app()`, so
        # nothing downstream would turn it into a red line, the class's own exit code
        # (3, not 1) and -- for a `--json` caller -- the single envelope stdout is
        # promised. Raising it bare printed a traceback, exited 1 and wrote ZERO BYTES
        # to stdout under `--json`, which is the exact defect this function's own
        # docstring lists four instances of. `_exit_reporting` was written for it.
        # AND NOT LOGGED: the event log is the first write under HOUSTON_HOME, and this is
        # the refusal to write there. Recording it put an `error` line into the home.
        _exit_reporting(exc, log=False)
    # Whether bin/houston exec'd this build for this command, for the event log -- and
    # the dispatcher's words removed from the environment, now that the claim has read
    # them, so no child process inherits them (STATE 8.9.0, 3.3).
    via = lock.consume_dispatch()

    _t0 = time.monotonic()
    try:
        from houston.services import eventlog
        unregister_eventlog = eventlog.install_eventlog_sink()
        eventlog.configure(via=via)
        eventlog.started(" ".join(sys.argv[1:]), actor=_cli_actor())
    except Exception:  # noqa: BLE001
        eventlog, unregister_eventlog = None, lambda: None

    def _done(code: int) -> None:
        try:
            eventlog.ended(code, time.monotonic() - _t0)
        except Exception:  # noqa: BLE001
            pass

    try:
        app()
    except SystemExit as exc:
        _done(int(exc.code or 0) if isinstance(exc.code, int) else 0)
        # A command that exited normally. Click's standalone mode has already turned
        # its `typer.Exit` into this, which is why the branches BELOW have to do that
        # conversion themselves -- they run outside click.
        raise
    except errors.ReproError as exc:
        _done(getattr(exc, "exit_code", 1))
        _exit_reporting(exc)        # a domain error that escaped a command's handler
    except KeyboardInterrupt:
        ui.warn("interrupted")
        _done(130)
        sys.exit(130)
    except BaseException as exc:    # noqa: BLE001 - the contract's last line
        __import__("traceback").print_exc()
        _done(1)
        unhandled = errors.ReproError(
            f"{type(exc).__name__}: {exc} - this is unhandled, and the traceback is "
            f"on stderr. If it names a file under HOUSTON_HOME, that file is the problem.")
        # Logged HERE, with `trace`, because this is the one path that printed a
        # traceback -- and then reported without a second record.
        _log_failure(errors.ReproError.code, str(unhandled), trace=True)
        _exit_reporting(unhandled, code=1, log=False)
    finally:
        unregister_eventlog()


main.__doc__ = _MAIN_HELP


def _exit_reporting(exc: errors.ReproError, code: int | None = None, *,
                    log: bool = True) -> NoReturn:
    """Report `exc` through the normal contract and exit, from OUTSIDE a command.

    `_fail` -> `ui.die` signals by raising `typer.Exit`, and typer.Exit is
    `RuntimeError`-derived, NOT a SystemExit:

        >>> [c.__name__ for c in typer.Exit.__mro__][:3]
        ['Exit', 'RuntimeError', 'Exception']

    Click converts it inside `app()`. Out here nothing does, so calling `_fail`
    directly from `main()` let it propagate as an uncaught exception: a second
    traceback after the message, and the wrong exit code -- 1 instead of the class's
    own. Measured: `houston env --name nope` printed the right error, then a
    traceback, then exited 1 where the published table says 4. The BaseException
    branch was written with this guard and the ReproError branch beside it was not,
    which is how the same defect survived the commit that fixed it.

    Rejected: making `ui.die` raise SystemExit instead. That changes behaviour inside
    every command, where click's standalone mode handles typer.Exit correctly today --
    a large blast radius for a two-line problem out here.
    """
    want = code if code is not None else getattr(exc, "exit_code", 1)
    # `--json` MAY NOT HAVE BEEN PARSED YET. The flag is a command parameter, so
    # `jsonout.activate()` runs inside the command -- and some failures happen before
    # any command does. `_before_any_command` is the sharp one: it reads the accounts
    # file on EVERY invocation, so an unreadable or wrong-type `~/.houston/users` (a
    # stale directory, a file owned by another user on the shared box) failed there and
    # left a `--json` caller with the empty stdout this whole contract exists to
    # prevent. If the caller asked for JSON on the command line, they get JSON.
    if not jsonout.active() and "--json" in sys.argv[1:]:
        jsonout.activate()
    try:
        if log:
            _fail(exc)
        else:
            _report(exc)
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - typer.Exit, whose code we already have
        pass
    sys.exit(want)


if __name__ == "__main__":
    main()


#: EVERY command, in the order it is registered -- and this tuple IS the root `--help`
#: listing. Forty command fixtures plus that listing are frozen surfaces
#: (`tests/test_frozen.py`), so a line moved here is a published change.
#:
#: Registration is a TABLE, not the order the command modules happen to be imported, and
#: it has to be: the order below interleaves the groups -- 21 runs across 10 groups, with
#: `lifecycle` at positions 0, 2, 4, 5, 6, 7 and `other` at 3 -- so no sequence of module
#: imports can reproduce it. The phase plan assumed it could. Re-derive with
#: `git show f36ff80:houston/cli/__init__.py` and read the decorator order.
#:
#: `(module, the name a user types, the function in that module)`. An empty module means
#: the command has not left this file yet; the last of the three commits empties it.
REGISTRATION_ORDER = (
    ("", "up", "up"),
    ("inspect_cmds", "ready", "ready"),
    ("", "down", "down"),
    ("other_cmds", "monitor", "monitor"),
    ("", "prune", "prune"),
    ("", "start", "start"),
    ("", "stop", "stop"),
    ("", "restart", "restart"),
    ("settings_cmds", "use", "use"),
    ("inspect_cmds", "list", "list_cmd"),
    ("inspect_cmds", "info", "info"),
    ("", "users", "users_cmd"),
    ("https_cmds", "edge", "edge_cmd"),
    ("settings_cmds", "config", "config_cmd"),
    ("settings_cmds", "env", "env_cmd"),
    ("https_cmds", "tls-status", "tls_status"),
    ("https_cmds", "trust-ca", "trust_ca"),
    ("rest_cmds", "token", "token"),
    ("rest_cmds", "api", "api"),
    ("rest_cmds", "pat", "pat"),
    ("data_cmds", "seed", "seed_cmd"),
    ("data_cmds", "config-import", "config_import"),
    ("data_cmds", "backup", "backup_cmd"),
    ("data_cmds", "backups", "backups_cmd"),
    ("data_cmds", "restore", "restore_cmd"),
    ("data_cmds", "upgrade", "upgrade_cmd"),
    ("inspect_cmds", "stats", "stats"),
    ("perf_cmds", "loadtest", "loadtest"),
    ("perf_cmds", "capacity", "capacity"),
    ("inspect_cmds", "logs", "logs"),
    ("other_cmds", "presets", "presets_cmd"),
    ("other_cmds", "versions", "versions_cmd"),
    ("", "audit", "audit_cmd"),
    ("", "chown", "chown_cmd"),
    ("other_cmds", "capabilities", "capabilities"),
    ("other_cmds", "install", "skill_install"),  # skill sub-command
    ("other_cmds", "status", "skill_status"),  # skill sub-command
    ("other_cmds", "doctor", "doctor"),
    ("", "cluster", "cluster_cmd"),
    ("", "serve", "serve"),
)

#: The two `skill` sub-commands, which hang off their own Typer rather than the root.
SKILL_COMMANDS = ("install", "status")


def _register() -> None:
    """Attach every command to its Typer, in `REGISTRATION_ORDER`.

    Called once, at the bottom of this module, so every function it names already
    exists. Resolving by NAME rather than by importing forty symbols is what keeps the
    order in one readable place instead of spread across thirteen import statements --
    and a typo is an AttributeError at import time rather than a command missing from
    `--help`.
    """
    import sys
    from importlib import import_module

    here = sys.modules[__name__]
    for module, name, func in REGISTRATION_ORDER:
        owner = import_module(f"{__name__}.{module}") if module else here
        target = skill_app if name in SKILL_COMMANDS else app
        target.command(name=name)(getattr(owner, func))
    # AFTER the sub-commands, though Click lists groups after commands whichever way
    # round this goes -- see tests/test_cli_package.py, which measures it rather than
    # assuming it.
    app.add_typer(skill_app, name="skill")


_register()
