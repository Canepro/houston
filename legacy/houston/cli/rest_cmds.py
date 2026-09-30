"""Speaking to a workspace's REST API: `token` `api` `pat`.

All three hand over a credential, which is why the GUI's equivalents sit at member+
rather than at readonly+: a minted token and an arbitrary authenticated call are reads
only in the HTTP sense.

`api` whitelists the method because it reaches `requests.request()` verbatim.
"""
from __future__ import annotations

import json
import time

import requests
import typer

from houston import rcapi, runner
from houston.perf.timings import fmt_ms
from houston.cli._common import (_err, _login, _not_answering,
                                 _require_engine, _resolve_name)


def token(name: str = typer.Option("", "--name", "-n")) -> None:
    """Mint an API auth token (X-Auth-Token / X-User-Id headers)."""
    target = _resolve_name(name)
    _require_engine(target)
    m = runner.read_meta(target)
    try:
        auth = _login(m)
    except Exception as exc:  # noqa: BLE001 - surface any auth/connection failure
        _not_answering(m, exc, "logging in")
    typer.echo(f'-H "X-Auth-Token: {auth.token}" -H "X-User-Id: {auth.user_id}"')


def api(
    method: str = typer.Argument(..., help="HTTP method, e.g. GET / POST"),
    path: str = typer.Argument(..., help="API path, e.g. /api/v1/users.update"),
    name: str = typer.Option("", "--name", "-n"),
    data: str = typer.Option("", "--data", "-d", help="JSON request body (for POST/PUT)"),
    pat: bool = typer.Option(False, "--pat", help="auth with a bypass-2FA Personal Access Token (like a customer script)"),
    two_fa: bool = typer.Option(False, "--2fa", help="add the admin password-2FA header (to pass 2FA-guarded endpoints)"),
) -> None:
    """Make an authenticated REST call against a repro and print the response.

    Examples:
      houston api GET  /api/v1/me
      houston api POST /api/v1/users.update --pat -d '{"userId":"ID","data":{"name":"X"}}'
      houston api POST /api/v1/users.update --2fa -d '{"userId":"ID","data":{"name":"X"}}'
    """
    target = _resolve_name(name)
    _require_engine(target)
    m = runner.read_meta(target)
    try:
        auth = _login(m)
        if pat:
            token = rcapi.generate_pat(m.root_url, auth, m.admin_pass, bypass_2fa=True, workspace=m.name)
            auth = rcapi.Auth(token=token, user_id=auth.user_id)  # use the PAT as the auth token
    except Exception as exc:  # noqa: BLE001
        _not_answering(m, exc, "this API call")

    try:
        body = json.loads(data) if data else None
    except json.JSONDecodeError as exc:
        _err(f"--data is not valid JSON: {exc}")

    extra = rcapi.password_2fa_headers(m.admin_pass) if two_fa else None
    _t = time.monotonic()
    try:
        status, text = rcapi.rcapi.call(m.root_url, method, path, auth=auth, data=body, extra_headers=extra)
    except requests.RequestException as exc:
        _err(f"request failed: {exc}")
    elapsed = fmt_ms((time.monotonic() - _t) * 1000)
    tag = "PAT" if pat else "admin"
    if two_fa:
        tag += "+2fa"
    typer.secho(f"HTTP {status}  [{tag}]  in {elapsed}", fg=typer.colors.GREEN if status < 400 else typer.colors.RED)
    typer.echo(text)
    # Exit non-zero on an HTTP error so `houston api ... || handle` (the
    # customer-script / CI use case) can detect it, not just transport failures.
    if status >= 400:
        raise typer.Exit(1)


def pat(
    name: str = typer.Option("", "--name", "-n"),
    label: str = typer.Option("houston", "--label", help="token name shown in the admin UI"),
    bypass_2fa: bool = typer.Option(True, "--bypass-2fa/--no-bypass-2fa", help='create with "Ignore Two Factor Authentication"'),
) -> None:
    """Mint a Personal Access Token and print ready-to-use headers (curl/Postman)."""
    target = _resolve_name(name)
    _require_engine(target)
    m = runner.read_meta(target)
    try:
        auth = _login(m)
        token = rcapi.generate_pat(m.root_url, auth, m.admin_pass, token_name=label, bypass_2fa=bypass_2fa, workspace=m.name)
    except Exception as exc:  # noqa: BLE001
        _not_answering(m, exc, "minting a token")
    typer.echo(f"# Personal Access Token for {m.name} ({m.root_url}) — bypass_2fa={bypass_2fa}")
    typer.echo(f'-H "X-Auth-Token: {token}" -H "X-User-Id: {auth.user_id}"')
