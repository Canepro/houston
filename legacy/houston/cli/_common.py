"""What every command needs: failing, resolving a name, and speaking to the caller.

Fifteen symbols, each used by many of the forty commands, so they belong below all of
them rather than beside whichever one happened to define them first.

**`_fail` and `_err` are the CLI half of the error contract.** Failure is a raised
`ReproError` everywhere under `services/`; these are where it becomes a red line and an
exit code — or, under `--json`, exactly one envelope on the last line of stdout. Seventy
five error paths that predate `jsonout` honour the contract because they route through
here rather than printing.

**`_cli_emit` is the CLI half of the event contract.** Every long-running service
function takes an `emit`, and this is the one the terminal passes; `web/jobs.py` passes
a different one. A service function that prints instead of emitting is invisible in the
GUI, and this is the asymmetry that makes that true.

This module imports nothing from `houston.cli`.
"""
from __future__ import annotations

import os
from typing import NoReturn

import requests
import typer

from houston import config, errors, jsonout, rcapi, runner, ui
from houston.services import lifecycle as lcsvc
from houston.services.events import Event

def _err(msg: str, exit_code: int = 1) -> NoReturn:
    """Error-exit: a red line on stderr and a non-zero status.

    In JSON mode it is an error envelope instead, because the contract is that
    EVERY reply is one. This wrapper exists so that the forty-eight call sites
    that predate jsonout.py -- `up`'s `--set` parsing, `config-import`'s missing
    file, every "can't seed" -- honour it without being touched. A contract that
    holds only on the paths somebody remembered is worse than none: a caller gets
    clean JSON until the moment something goes wrong, which is the moment it needed
    the JSON.

    The code is the base `REPRO_ERROR` and the exit stays 1, exactly as before.
    Saying "unclassified" is honest; picking a plausible code would tell a caller
    to retry, or not to, on no evidence.
    """
    _log_failure(errors.ReproError.code, msg)
    if jsonout.active():
        jsonout.fail(errors.ReproError(msg))
    ui.die(msg, exit_code=exit_code)


def _log_failure(code: str, message: str, *, trace: bool = False) -> None:
    """Record a failure in the durable log, with the stable code beside the prose.

    Both `_err` and `_fail` route through here, which between them are every error path
    in this file -- the same reason those two wrappers exist at all. Best-effort and
    silent: the failure being reported matters more than logging it. `trace` says a
    traceback went to stderr, which only the unhandled path in `main` does -- the soak
    health check reads it (STATE 8.9.0, 3.3).
    """
    try:
        from houston.services import eventlog
        eventlog.failed(code, message, traceback_on_stderr=trace)
    except Exception:  # noqa: BLE001
        pass


def _fail(exc: errors.ReproError) -> NoReturn:
    """Exit on a domain error with the exit code its CLASS defines.

    One helper instead of a mapping at each of the 26 handlers, so errors.py
    stays the only place an exit code is decided. Before this every failure was
    exit 1, so a script could tell that something went wrong but never what: a
    workspace that is still booting and one that is known dead looked identical.
    See errors.EXIT_CODES for the published map.
    """
    _log_failure(getattr(exc, "code", "") or errors.ReproError.code, str(exc))
    _report(exc)


def _report(exc: errors.ReproError) -> NoReturn:
    """`_fail` WITHOUT the durable record: the red line, the envelope and the exit code.

    For the one failure that must not write under HOUSTON_HOME -- the startup refusal of a
    home another build owns. Logging it put an `error` line into the very home the process
    had just refused to use, which is what the refusal exists to prevent.
    """
    if jsonout.active():
        jsonout.fail(exc)
    ui.die(str(exc), exit_code=exc.exit_code)


def _resolve_name(name: str | None) -> str:
    """Return the target repro name: explicit, else the configured default.

    Delegates to the service layer so both front-ends share one implementation
    (and one set of name-validation rules) rather than drifting apart.

    The actor goes with it so a name typed WITHOUT the owner prefix still finds
    the workspace it created: `up --name test` makes `alice-test`, and every other
    command has to accept `test` for it or the documented workflow breaks the day
    somebody runs `users add`."""
    try:
        return lcsvc.resolve_name(name, actor=_cli_actor())
    except errors.ReproError as exc:
        _fail(exc)


def _require_docker() -> None:
    """Refuse early when the engine is down, with a code rather than a flat 1.

    It used to call `_err()` directly, so the single most common failure there is
    exited 1 -- the one value that says nothing. Delegating to the service means
    it now carries whatever code its class defines, and the class is decided in
    one place for both front-ends instead of here.
    """
    try:
        lcsvc.require_docker()
    except errors.ReproError as exc:
        _fail(exc)


def _require_engine(target: str) -> None:
    """The engine THIS workspace needs. See `lifecycle.require_engine`.

    Every caller resolves the name first, which is the whole point: the gate cannot
    know which engine to ask for until it knows what it is being asked about.
    """
    try:
        lcsvc.require_engine(target)
    except errors.ReproError as exc:
        _fail(exc)


def _not_answering(m: runner.Metadata, exc: Exception, what: str) -> NoReturn:
    """A REST command that could not reach or could not authenticate to a workspace.

    A CONNECTION failure is NOT_READY -- exit 5, "poll again" -- and not the
    unclassified 1. Every one of these messages already told the reader to run
    `houston ready`, while exiting the one code that tells a script not to bother
    polling; and `services/monitor.py` raises NotReadyError for the very same
    condition, so an unreachable workspace answered differently depending on which
    verb you reached for. Measured: `api` against a workspace whose Rocket.Chat
    container was still coming back from an `env` change exited 1.

    Anything else -- a refused login, a 2FA challenge nothing can satisfy -- stays
    unclassified, because it is not something waiting will fix.
    """
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        _fail(errors.NotReadyError(
            f"{m.name!r} is not answering yet, so {what} cannot run — wait for it with "
            f"`houston ready --name {m.name}`"))
    # A 429 is the other "wait and it will work": Rocket.Chat rate-limits token
    # creation per user, so two perf runs back to back -- which is exactly the
    # `--save baseline` then `--compare baseline` pair the README prints -- have the
    # second refused. Reported as unclassified it read like a broken workspace.
    if "429" in str(exc) or "Too Many Requests" in str(exc):
        _fail(errors.NotReadyError(
            f"Rocket.Chat is rate-limiting token creation on {m.name!r}, so {what} "
            "cannot run yet. Its limiter resets in about a minute — try again then."))
    # No "ready?" here: the two conditions waiting actually fixes are handled above, so
    # telling everybody else to poll sent them to a command that could not help.
    _err(f"{what} failed: {exc}")


def _login(meta: runner.Metadata) -> rcapi.Auth:
    """Admin login for a repro. Passes the repro's Mailpit URL (email preset)
    so rcapi can satisfy an email-2FA challenge automatically."""
    return rcapi.login(meta.root_url, password=meta.admin_pass,
                       mailpit_url=meta.extra.get(config.EXTRA_MAILPIT_URL))


def _parse_set_params(set_: list[str] | None) -> dict[str, str]:
    """Parse repeated `--set KEY=VALUE` options into a preset params dict."""
    params: dict[str, str] = {}
    for item in set_ or []:
        if "=" not in item:
            _err(f"--set expects KEY=VALUE, got {item!r}")
        k, v = item.split("=", 1)
        params[k.strip()] = v.strip()
    return params


def _cli_actor() -> str:
    return _cli_actor_and_origin()[0]


def _cli_actor_and_origin() -> tuple[str, str]:
    """Who is running the CLI, and how confident we are about it.

    The second value is the audit log's `origin` column, and it exists because
    these two cases are NOT the same evidence:

      local     os.getlogin() matched a known account. The OS said so.
      asserted  HOUSTON_USER was set. Honoured even for an unknown name (see
                below), so it is a claim, not a check.

    Recording them identically would make every line only as trustworthy as the
    weakest one.

    Team mode is opt-in: it starts the moment somebody runs `houston users add`.
    Until then this returns "" and every workspace keeps the name it has always
    had. Once accounts exist, the login name is used if it matches one, so nobody
    has to remember a flag before typing `up`. HOUSTON_USER overrides it for the
    case where the OS account and the GUI account differ.
    """
    from houston.services import users
    if not users.any_users():
        return "", "system"
    known = {u.name for u in users.list_users()}
    named = config.env("HOUSTON_USER").strip().lower()
    if named:
        # Explicit: honoured even if unknown, so the mismatch shows up in `list`
        # rather than silently falling back to the shared namespace.
        return named, "asserted"
    try:
        login = os.getlogin()
    except OSError:                     # no controlling terminal (cron, container)
        login = os.environ.get("USER", "")
    login = login.strip().lower()
    return (login, "local") if login in known else ("", "system")


def _cli_emit(ev: Event) -> None:
    """Print a service progress event on the terminal. Terminal events, and the
    INFORMATIONAL `done` ones, are suppressed — the command wrapper prints the final
    panel itself and would otherwise say it twice.

    A `done` WARNING is a different thing and is printed. The suppression used to key
    on the phase alone, so six warnings a service raises at the end of its work reached
    nobody on the CLI: an orphaned namespace that could not be removed, a workspace
    skipped by `prune`, a cluster left alone, a monitoring volume left behind, and the
    one k8s.py:3560 exists to say -- that `stop` frees Rocket.Chat's memory and NOT
    operator-managed MongoDB's. Each was written to be read at exactly the moment it
    fires, and `phase="done"` is where a service says what it finished doing.

    NOTHING UNDER --json. The info branch is a bare `typer.echo`, which `jsonout`'s
    stderr mode does not reach, so `cluster list --json` wrote its 21 `[i/21] region`
    progress lines to stdout ahead of the envelope -- a stdout that is meant to carry the
    envelope and nothing else. A JSON caller gets what a run found in the envelope, its
    warnings included, and the TypeScript CLI's emitter prints nothing while --json is
    active; this now does the same."""
    if jsonout.active():
        return
    if ev.terminal or (ev.phase == "done" and ev.level == "info"):
        return
    if ev.level in ("warn", "error"):
        ui.warn("  " + ev.message, err=True)
    else:
        typer.echo(f"  {ev.message}")


def _run_and_echo(cmd: list[str]) -> None:
    from houston import exec as subprocess
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        ui.warn(f"  ⚠ {cmd[0]} failed: {exc}")
        return
    for line in (r.stdout or "").splitlines():
        typer.echo(f"  {line}")


def _promote_command(m: runner.Metadata, host: str) -> str:
    """The staging -> production command, rebuilt from what this repro actually used."""
    x = m.extra if isinstance(m.extra, dict) else {}
    return " ".join([
        f"houston up -v {m.rc_version}", f"--name {m.name}",
        f"--domain {host}", f"--email {x.get('tls_email') or '<you@example.com>'}",
        "--force", "--wait",
    ])


_UNSET = object()


_HTTP_METHODS = {"GET", "POST", "PUT", "DELETE", "PATCH"}



def _rc_services_in(doc: dict) -> list[str]:
    return [s for s in doc.get("services", {}) if s == "rocketchat" or s.startswith("rocketchat-")]


def _port_claim_note() -> str:
    """A cluster holding this host's :80/:443, as a sentence, or "".

    THE EDGE STARTING IS NOT THE EDGE WORKING, and every message on the start path
    conflated the two. A k3s ServiceLB claims host ports by DNAT rather than by
    binding, so the edge binds both ports, compose reports success, and this printed
    "every registered name is served again" about a box where no name was served at
    all -- for two days, on a manager's install, with `houston edge status` agreeing
    that the edge was running. It was running. It was also unreachable.

    Cheap enough to run on the start path: one `kubectl get svc` per candidate
    context, and only when a context answers at all.
    """
    from houston.services import k8s

    try:
        # 3s, not the 8s probe default: this is a warning on the way to starting a
        # proxy, and four probes at the default would put half a minute on `edge
        # start` for any box with a kubeconfig pointing somewhere unreachable.
        claim = k8s.port_claiming_cluster(timeout=3.0)
    except Exception:  # noqa: BLE001 - a warning must never break a start
        return ""
    if not claim:
        return ""
    took = ", ".join(f":{p}" for p in claim.ports if p in (80, 443))
    return (f"cluster {claim.context!r} holds this host's {took} at {claim.address} "
            f"({claim.service}), so the edge is bound but cannot receive: names answer "
            f"from the cluster, not from houston.\n"
            f"  Give the ports back: kubectl -n kube-system patch svc "
            f"{claim.service.split('/')[-1]} -p "
            f"'{{\"spec\":{{\"type\":\"NodePort\"}}}}'\n"
            f"  A k3s reinstall undoes that patch. Permanently: install with "
            f"`--disable traefik --disable servicelb`, or put those two under "
            f"`disable:` in /etc/rancher/k3s/config.yaml.")
