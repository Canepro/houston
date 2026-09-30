"""The web GUI and the people who use it: `serve` `users` `audit` `chown`.

These four are one subject: `serve` is the only reason named accounts exist at all, and
`users`, `audit` and `chown` are what a shared server needs once it has them. The CLI
mints and manages the accounts; the GUI is where they are spent.

`serve` is long because it decides, before binding anything, what the box is actually
going to serve: which host names are allowed, whether the browser's hop is https, which
proxy's forwarded headers to believe, and whether a first-run link may exist at all
(loopback bind, no accounts -- never on a bind the network can reach).
"""
from __future__ import annotations

import os
import shutil
import sys
from functools import partial
from pathlib import Path

import typer

from houston import config, errors, ui
from houston.services import lifecycle as lcsvc
from houston.services import promote as promotesvc
# `serve --domain` arranges TLS the same way `edge` does, and reports it with the
# same function -- one place decides what "actually being served" means, or the
# GUI and `tls-status` answer differently about the same certificate.
from houston.cli.https_cmds import _report_gui_tls
from houston.cli._common import (_cli_actor, _err, _fail)


def _list_gui_users(usersvc):
    """List accounts, including the pre-roles implicit-admin migration state."""
    rows = usersvc.list_users()
    if not rows:
        ui.note("no users yet — add one with `houston users add <name>`")
        ui.hint("  or just run `houston serve` — it prints a one-time link that "
                "creates the first one.")
        return
    ui.panel("GUI users", [
        (u.name, u.created_at + "  [" + usersvc.role_of(u.name)
         + ("" if u.role else " (implicit)") + "]") for u in rows])
    implicit = usersvc.implicit_admins()
    if implicit:
        ui.hint("  (implicit) = the role column is blank, which means admin. "
                "That is the\n  migration for accounts made before roles "
                "existed, not a default.")
        ui.hint(f"  narrow one with: houston users role {implicit[0]} member")


def _change_gui_user_role(name, role, sessionsvc, usersvc):
    """Change authority and revoke sessions so it takes effect immediately."""
    if not role:
        _err(f"`users role {name}` needs a role ({' | '.join(usersvc.ROLES)})")
    try:
        user = usersvc.set_role(name, role)
        ended = sessionsvc.revoke_user(name)
    except errors.ReproError as exc:
        _fail(exc)
    ui.ok(f"✓ {user.name!r} is now {user.role}.")
    if ended:
        ui.hint(f"  {ended} active session(s) signed out, so it takes effect now.")
    ui.hint("  roles bound the GUI. The CLI has no roles: anyone with a shell "
            "on this box\n  is already in the docker group. A readonly user "
            "with an ssh key is not readonly.")


def _remove_gui_user(name, usersvc):
    """Remove an account; the service also ends its active sessions."""
    try:
        ended = usersvc.remove(name)
    except errors.ReproError as exc:
        _fail(exc)
    ui.ok(f"✓ user {name!r} removed.")
    if ended:
        ui.hint(f"  {ended} active session(s) signed out.")


def _password_for_user(action, ask_password, name, role, typed, usersvc):
    """Validate the account request and obtain a generated or prompted password."""
    try:
        usersvc.require_valid_name(name)
    except errors.ReproError as exc:
        _fail(exc)
    if name != typed:
        ui.note(f"  {typed!r} becomes {name!r} — an account name becomes part "
                "of a workspace name, and therefore a DNS label.")
    if ask_password:
        password = typer.prompt(f"Password for {name}", hide_input=True)
        if password != typer.prompt("Repeat", hide_input=True):
            _err("the two passwords do not match")
        minted = False
    else:
        password, minted = usersvc.mint_password(), True
    if role and action == "passwd":
        _err("`users passwd` takes no role — change one with "
             f"`houston users role {name} {role}`")
    if role:
        try:
            usersvc.require_valid_role(role)
        except errors.ReproError as exc:
            _fail(exc)
    return password, minted


def _report_gui_password(action, added, ended, minted, name, password, usersvc):
    """Report the one moment a generated credential exists in readable form."""
    ui.ok(f"✓ user {name!r} {'added' if action == 'add' else 'password changed'}.")
    if minted:
        ui.panel(f"password for {name}", [(password, "")])
        ui.hint("  Shown once. houston keeps only a scrypt hash, so nobody — "
                "including you —\n  can read it back. Send it over something "
                "the person can delete afterwards.")
    if action == "passwd" and ended:
        ui.hint(f"  {ended} active session(s) signed out.")
    if action == "add":
        ui.hint(f"  role: {added.role}" + (
            "  (the first account has to be an admin, or nobody could promote "
            "anyone)" if added.role == "admin"
            else "  — change it with `houston users role %s <role>`" % name))
        if len(usersvc.list_users()) == 1:
            ui.hint("  `houston serve` will now ask for this login, and the "
                    "first-run link is spent.")


def _set_gui_password(action, ask_password, name, role, typed, usersvc):
    """Add an account or replace its password without accepting it in argv."""
    password, minted = _password_for_user(
        action, ask_password, name, role, typed, usersvc)
    ended, added = 0, None
    try:
        if action == "add":
            added = usersvc.add(
                name, password, role=usersvc.normalise_role(role) if role else "")
        else:
            ended = usersvc.set_password(name, password)
    except errors.ReproError as exc:
        _fail(exc)
    _report_gui_password(action, added, ended, minted, name, password, usersvc)


_USERS_HELP = """Manage who can sign in to the web GUI.

A shared `houston serve` needs named accounts rather than one session token:
the token is handed to everybody, changes on every restart, and cannot answer
"who tore down TICKET-1234?". With users, every job records who ran it.

\b
`add` and `passwd` GENERATE the password and show it once:
    houston users add bob
    houston users add bob readonly          # with a role; member by default
    houston users add bob --ask-password    # type one instead

The GUI has always minted them, and for two reasons that apply just as much at
a terminal. An admin who types a colleague's password also knows it, which
makes every audit line signed with that name deniable. And a generated one is
~96 bits, where a typed one clears a twelve-character minimum and is otherwise
whatever somebody thought of — which is the only thing standing between an
account and a distributed guessing attack, because the sign-in throttle bounds
one address and nothing bounds a thousand.

Either way the password is never an ARGUMENT: `ps` shows command lines to every
user on the machine.
"""


def users_cmd(
    action: str = typer.Argument("list", help="list | add | passwd | remove | role"),
    name: str = typer.Argument("", help="the user name, for add/passwd/remove/role"),
    role: str = typer.Argument("", help="admin | member | readonly, for `add` and `role`"),
    ask_password: bool = typer.Option(
        False, "--ask-password",
        help="type a password instead of letting houston generate one"),
) -> None:
    """Manage GUI accounts."""
    from houston.services import sessions as sessionsvc
    from houston.services import users as usersvc

    if action == "list":
        return _list_gui_users(usersvc)

    if not name:
        _err(f"`users {action}` needs a name, e.g. `houston users {action} alice`")

    # One normalisation for every branch below, so `role`, `remove` and `passwd`
    # find the account that `add` created and every line printed names it the way
    # the file spells it. The service normalises too -- but it cannot fix what this
    # layer PRINTS, and `revoke_user` here takes the name straight from argv.
    typed, name = name, usersvc.normalize_name(name)

    if action == "role":
        return _change_gui_user_role(name, role, sessionsvc, usersvc)

    if action == "remove":
        return _remove_gui_user(name, usersvc)

    if action in ("add", "passwd"):
        return _set_gui_password(action, ask_password, name, role, typed, usersvc)

    _err(f"unknown action {action!r} (want: list | add | passwd | remove | role)")


users_cmd.__doc__ = _USERS_HELP


def audit_cmd(
    actor: str = typer.Option("", "--actor", help="only this account"),
    kind: str = typer.Option("", "--kind", help="only this action, e.g. down-volumes"),
    since: str = typer.Option("", "--since", help="only after this ISO date, e.g. 2026-08-01"),
    q: str = typer.Option("", "--grep", help="substring of the action or its target"),
    n: int = typer.Option(50, "-n", "--lines", help="how many to show"),
    denied: bool = typer.Option(False, "--denied", help="only refusals"),
    tsv: bool = typer.Option(False, "--tsv", help="raw tab-separated, for awk/cut and log shipping"),
) -> None:
    """Read the activity trail: who did what, and whether it was allowed.

    The log has been written since accounts landed and there was no way to read
    it -- "who tore down TICKET-1234?" meant ssh and `cat`. Six tab-separated
    columns: time, who, action, target, origin, outcome.

    `origin` says how the identity was established, which is what makes a line
    evidence or not:

      session   a signed-in GUI request; the server checked a credential
      local     the CLI, where the OS login matched a known account
      asserted  the CLI with HOUSTON_USER set -- honoured as given, so a CLAIM
      system    houston acting on its own behalf
    """
    from houston.services import audit as auditsvc
    res = auditsvc.read(limit=max(1, n), actor_name=actor, kind=kind, q=q, since=since)
    rows = [r for r in res["lines"] if not denied or r["outcome"] == "denied"]
    if not rows:
        ui.note(f"nothing matched in {res['path']}")
        return
    if tsv:
        for r in rows:
            typer.echo(f"{r['ts']}\t{r['actor'] or '-'}\t{r['kind']}\t{r['label']}\t"
                       f"{r['origin'] or '-'}\t{r['outcome']}")
        return
    width = max(len(r["actor"] or "-") for r in rows)
    for r in reversed(rows):            # oldest first, like a log
        colour = typer.colors.RED if r["outcome"] == "denied" else None
        # The origin is only worth the column width when it is NOT a checked
        # session -- that is the common case and the trustworthy one.
        mark = "" if r["origin"] == "session" else f"  [{r['origin'] or 'legacy'}]"
        typer.secho(f"{r['ts'][:19]}  {(r['actor'] or '-'):<{width}}  "
                    f"{r['kind']:<14} {r['label']}{mark}"
                    + ("  DENIED" if r["outcome"] == "denied" else ""), fg=colour)
    if res["truncated"]:
        ui.hint(f"  (stopped early: {res['path']} is large. Narrow it with --since "
                "or --actor, or ship it somewhere with an index.)")


def chown_cmd(
    name: str = typer.Option("", "--name", "-n"),
    to: str = typer.Option(..., "--to", help="the account taking it over"),
) -> None:
    """Hand a workspace over to somebody else.

    Ticket handover is the workflow the shared box is built around, and the record
    only ever knew who typed `up` -- so "belongs to alice" kept warning the wrong
    person, which is how people learn to click through warnings. Who CREATED it
    stays in the record; who owns it now is what moves.
    """
    try:
        res = lcsvc.set_owner(name, to, by=_cli_actor())
    except errors.ReproError as exc:
        _fail(exc)
    ui.ok(f"✓ {res['name']!r} now belongs to {res['to']}"
          + (f" (was {res['from']})" if res["from"] else ""))


def _tighten_account_files():
    """Keep local account, session, and audit data private on a shared box."""
    # Nothing tightens <home> today -- runner._restrict only covers workspaces --
    # and it holds the users file, the sessions file and the audit trail. That is
    # the design's own adversary #2: another local user on the shared box.
    try:
        home = config.home()
        home.mkdir(parents=True, exist_ok=True)
        if (home.stat().st_mode & 0o077):
            home.chmod(0o700)
            ui.note(f"  tightened {home} to 0700 (it holds accounts, sessions and "
                    "the audit log)")
        # And the files themselves. They are CREATED 0600, but os.open does not
        # change the mode of a file that already exists -- so one written by an
        # older houston keeps whatever the umask gave it, forever. Found by
        # `doctor` on a real box: audit.log was 664.
        from houston.services import sessions as _s
        from houston.services import users as _u
        for _f in (_u.users_file(), _s.sessions_file(), home / "audit.log"):
            try:
                if _f.exists() and (_f.stat().st_mode & 0o077):
                    _f.chmod(0o600)
                    ui.note(f"  tightened {_f.name} to 0600")
            except OSError:
                pass
    except OSError:
        pass


def _announce_transport(basic, domain, door, loopback, tlsmod, trusted, url):
    """Print the URL, certificate arrangement, and transport posture."""
    typer.secho(f"houston GUI: {url}", bold=True)
    if door:
        if door.wildcard:
            ui.hint(f"  one *.{domain} certificate covers every workspace — no "
                    "per-name issuance, no weekly limit to hit.")
        else:
            ui.hint(f"  each workspace name gets its own certificate. A DNS API "
                    f"token in {tlsmod.dns_env_path()} would make it one wildcard.")
        ui.hint(f"  {domain} must already resolve to this machine, or the "
                "certificate cannot be issued.")
        ui.hint("  the first request may take a few seconds while Let's Encrypt "
                "issues it.")
        ui.hint(f"  workspaces published under this name: houston up -v <X.Y.Z> "
                f"--domain <ticket>.{domain}")
    # One line naming the posture, so an operator can read how people sign in and
    # whether the transport is believed, without inferring it from flags.
    if basic:
        how = ("https, arranged by houston" if domain
               # "https, trusted from X" read as a statement of fact, and it is
               # conditional: --trust-proxy grants permission to believe
               # X-Forwarded-Proto, and until a peer in X actually sends it this is
               # plain http with a non-Secure cookie. The line said otherwise.
               else f"https when the proxy says so, trusted from {', '.join(trusted)}"
               if trusted
               # Loopback is not "plain http" in any sense that matters: the
               # password crosses no network. Saying so keeps the warning that
               # DOES matter (the line below, on a reachable bind) meaningful.
               else "loopback, so nothing crosses a network" if loopback
               else "PLAIN HTTP on a reachable interface")
        ui.hint(f"  auth: named accounts over {how}")
        if loopback and not domain:
            # The commonest question after "it works": how do I let anyone else
            # in. Answered here rather than only in --help, because this is the
            # screen somebody is actually looking at.
            # The two answers that need no security decision from the reader. The
            # plain-http one is deliberately absent: this is the screen a
            # first-time user is looking at, and it used to hand them --insecure
            # before they had any reason to weigh it. Somebody who wants that path
            # reaches it by adding --bind, and the refusal explains it there.
            ui.hint("  reachable from this machine only. To share it:")
            ui.hint("    houston serve --domain <name.example.com> --email "
                    "you@example.com")
            ui.hint("    …or, behind a lab/proxy already doing TLS: --bind 0.0.0.0 "
                    "--allow-host <name>\n      --trust-proxy <its address>")
        if not domain and not trusted and not loopback:
            ui.warn("  ⚠ the session cookie will NOT be marked Secure, and the "
                    "sign-in page will warn\n    about an unencrypted connection. "
                    "If TLS terminates at a proxy in front,\n    tell houston "
                    "which one: --trust-proxy <its address>")


def _announce_accounts(basic, setup_key, usersvc):
    """Name the accounts available, or explain the single-use setup link."""
    if basic:
        names = ", ".join(f"{u.name} ({usersvc.role_of(u.name)})"
                          for u in usersvc.list_users())
        ui.hint(f"  sign in as: {names}")
        implicit = usersvc.implicit_admins()
        if implicit:
            # Said out loud rather than left to be discovered: these accounts are
            # admin because their role column is blank, which is the migration for
            # everything created before roles existed.
            ui.warn(f"  ⚠ admin by default (blank role): {', '.join(implicit)}")
            ui.hint(f"    narrow one with: houston users role {implicit[0]} member")
        ui.hint("  every action is recorded against the account that took it.")
    elif setup_key:
        ui.hint("  this link creates the first account. It is single-use and "
                "expires in 15 minutes.")
        ui.hint("  the part after # never reaches the server, so it cannot appear "
                "in a log.")
        ui.hint("  prefer a terminal? `houston users add <name>`, then start this "
                "again.")


def _announce(basic, domain, door, edgesvc, loopback, setup_key, tlsmod, trust_proxy, url, usable_trusted, usersvc):
    """Everything printed once the server is about to listen."""
    trusted = usable_trusted(trust_proxy)
    if domain:
        # Trust the edge's exact addresses, never its whole workspace-filled subnet.
        trusted += edgesvc.container_addresses()
    _tighten_account_files()
    _announce_transport(basic, domain, door, loopback, tlsmod, trusted, url)
    _announce_accounts(basic, setup_key, usersvc)
    return trusted


def _start_front_door(domain, door, edgesvc, email):
    """Start the edge and prove the name has a real certificate.

    The Docker+Compose preflight must precede writes. Expected edge conflicts are
    rendered as domain errors, and a started Traefik is insufficient because ACME
    issuance happens later in the background.
    """
    lcsvc.require_docker()
    ui.note("starting the edge (one Traefik, :80 and :443 for every name)…")
    try:
        edgesvc.write(door)
        started = edgesvc.ensure_running(acme_email=email,
                                         acme_staging=door.acme_staging)
    except errors.ReproError as exc:
        _fail(exc)
    if not started:
        holder = edgesvc.port_holder(443)
        _err("the edge did not start"
             + (f" — {holder} is holding :443." if holder else ".")
             + (f"\n  docker said: {started.why}" if started.why else "")
             + f"\n  Its compose project is `{edgesvc.PROJECT}` in "
             f"{edgesvc.edge_dir()}; `houston edge status` reports it."
             + f"\n  Full output: cd {edgesvc.edge_dir()} && docker compose -p "
             f"{edgesvc.PROJECT} up")
    _report_gui_tls(domain)


def _local_gui_url(allow_host, bind, loopback, port, setup_key):
    """Build a useful URL, never presenting a wildcard bind as an address."""
    host = "localhost"
    if not loopback:
        wildcard = bind in ("0.0.0.0", "::", "[::]")
        host = (next((h for h in (allow_host or []) if h != "*"), "")
                or ("<this-box>" if wildcard else bind))
    if setup_key:
        # A URL fragment never reaches the server, proxy logs, or Referer.
        url = f"http://{host}:{port}/setup#k={setup_key}"
    else:
        url = f"http://{host}:{port}/"
    return url


def _open_the_front_door(allow_host, bind, domain, door, edgesvc, email, loopback, port, setup_key):
    """Put this GUI behind the shared edge, or name its direct listener."""
    if door:
        _start_front_door(domain, door, edgesvc, email)
        return f"https://{domain}/"
    return _local_gui_url(allow_host, bind, loopback, port, setup_key)


def _refuse_a_password_in_the_clear(allow, allow_host, basic, bind, domain, door, insecure, loopback, port, trust_proxy, trusted_problems):
    """The refusals a reachable bind earns, and the warnings a loopback one does not."""
    # --domain means houston is arranging TLS itself, through its own front door.
    # It therefore KNOWS the browser hop is https and the plain-http last hop is
    # container-to-host on the bridge -- so the refusal below would be refusing
    # its own most secure configuration.
    # --trust-proxy is a STRONGER statement than --insecure: it names which peer
    # terminates TLS, rather than merely asserting that somebody does. So it
    # satisfies the same bind-time check, and unlike --insecure it also makes the
    # cookie Secure and silences the (then false) transport warning.
    tls_upstream = bool(domain) or insecure or bool(trust_proxy)

    if basic and not loopback and not tls_upstream:
        # Sessions send the password ONCE, at sign-in -- but that one time is
        # still in the clear on plain http, and the cookie minted from it then
        # rides every request. So a plain-http bind on a reachable interface is
        # still refused unless somebody says the transport is protected.
        #
        # But this process cannot tell whether the password is actually exposed:
        # behind a TLS-terminating proxy the browser speaks https and only the
        # last hop is plain, which is safe and is how a shared box normally runs.
        # So both ways out have to be offered. The first version named only the
        # loopback one, which is no route at all when the proxy lives on another
        # machine -- it cannot reach a loopback bind -- and that made accounts
        # unusable on exactly the shared server they exist for.
        #
        # The second route is spelled out rather than echoed back as a full
        # command: an echo built from bind+port drops any --allow-host that was
        # passed, and the copy-pasted result then 403s the proxy's Host header.
        _err(f"signing in over plain http on {bind} puts the password on the wire "
             "once, and the\n  session cookie on every request after it — both "
             "readable by anyone on the path.\n  Refused by default.\n"
             "  Have a hostname pointing here? Let houston do the TLS:\n"
             "    houston serve --domain <your-domain> --email you@example.com\n"
             "  TLS proxy on THIS box? Keep the GUI on loopback and point the "
             "proxy at it:\n"
             f"    houston serve --bind 127.0.0.1 --port {port} "
             "--allow-host <your-domain>\n"
             "  TLS terminating upstream (remote proxy, lab, load balancer)?\n"
             "    name the peer, so the cookie is marked Secure too:\n"
             "      --trust-proxy <the proxy's address>\n"
             "  Nothing doing TLS at all, on a network you trust?\n"
             "    add --insecure to the command you just ran\n"
             "  --trust-proxy and --insecure answer different questions: the first "
             "says who is\n"
             "  encrypting it, the second says nobody is and you accept that. If "
             "there is a\n"
             "  proxy, name it — it is the better answer and --insecure is then "
             "not needed.",
             # Exit 3 (`preflight`), matching the no-accounts branch a few lines
             # up. These are the two halves of one question -- may this bind
             # serve? -- and they reported it as 3 and 1, so a script could not
             # treat "fix your invocation" as one case. 1 means an internal fault,
             # which neither of them is.
             exit_code=3)

    _warn_about_reachable_bind(allow, allow_host, bind, domain, door, loopback,
                               trust_proxy, trusted_problems)


def _warn_about_reachable_bind(allow, allow_host, bind, domain, door, loopback,
                               trust_proxy, trusted_problems):
    """Explain reachable-bind choices which are valid but commonly surprising."""
    # Not for the bridge: that address is reachable from containers on this box,
    # not from the network, which is the entire reason the front door uses it.
    if not loopback and not door:
        ui.warn(f"  ⚠ binding {bind} exposes docker control (create/delete repros + volumes) "
                "to your network — use only if you mean to.")
    if "*" in allow:
        ui.warn("  ⚠ --allow-host '*' accepts ANY Host header — only on a trusted/ephemeral network.")
    # Said BEFORE the server comes up, because the symptom otherwise is silence:
    # it starts, it serves, and the one thing the flag was for quietly did not
    # happen.
    for problem in trusted_problems(trust_proxy):
        ui.warn(f"  ⚠ {problem}")
    # --allow-host names who may reach it; --bind decides whether anyone can. Given
    # one without the other, the flag is inert and the server comes up answering
    # loopback only -- which it then reports as working, so the reader retries the
    # same command or concludes the address is wrong. Observed costing three
    # attempts on a real box. It is a note, not a refusal: naming a Host you will
    # reach through a proxy on loopback is a legitimate setup.
    if allow_host and loopback and not domain:
        ui.note(f"  note: --allow-host {allow_host[0]} names who may reach this, but "
                "the bind is still\n        loopback, so nothing off this machine "
                "can. Add --bind 0.0.0.0 if you\n        meant to publish it.")
    # The mirror image, and the one that actually cost the time: bound where others
    # can reach it, but the allow-list still holds nothing, so only localhost passes
    # the Host guard and every request by the name somebody types is a 403. `serve`
    # used to print a healthy startup screen and say nothing about it.
    if not loopback and not door and not allow_host:
        ui.warn("  ⚠ nothing is in --allow-host, so only localhost is accepted — a "
                "request by any\n    other name will be a 403. Add --allow-host "
                "<the name you will type>, or '*'.")


def _first_run_key(_cmdline, basic, domain, frsvc, loopback):
    """The one-time key that turns the first visitor into the first account."""
    # No accounts? Two cases, and only one of them starts.
    #
    # A session token in the URL is gone: it was a standing credential with no
    # identity behind it, regenerated on every restart, landing in shell history
    # and screenshots -- and it made `audit.log` record `-` for every action, in
    # the mode that shipped by default.
    setup_key = ""
    if not basic:
        if loopback and not domain:
            # A fresh key per start. The design proposed reporting an outstanding
            # one instead, which cannot be done: only its sha256 is stored, on
            # purpose, so it cannot be reprinted. Minting again is the honest
            # version -- the URL just printed is always the one that works.
            setup_key = frsvc.mint()
        else:
            # Amber and two steps, NOT a red `error:`. Nothing has gone wrong
            # here: this is the documented first-run sequence on a shared box, and
            # on a rebuilt one -- where ~/.houston is empty, so EVERY serve says
            # it -- a red failure reads as houston being broken rather than as
            # two commands in a row. Red is reserved for something that failed.
            #
            # It still EXITS NON-ZERO, and it has to: `serve` did not serve, and a
            # systemd unit reporting success while nothing is listening is the
            # worse lie. Exit 3, `preflight` -- the taxonomy's name for a
            # condition the caller must fix before this can run at all.
            # Whole block on stderr, heading and steps together: it precedes a
            # non-zero exit, so `serve > /dev/null` must still say why nothing
            # started -- and a block split across two streams interleaves into
            # nonsense the moment either one is redirected.
            ui.warn("houston needs an account before it will serve on an "
                    "interface other than loopback.", err=True)
            typer.echo("\n  1. create one — the password is generated and shown "
                       "once:\n"
                       "       houston users add <name>\n"
                       "  2. start it again:\n"
                       f"       {_cmdline()}\n", err=True)
            raise typer.Exit(3)
    return setup_key


#: Set by `bin/houston`, the dispatcher, to its own absolute path with its symlinks
#: resolved: the command the owner installed.
_DISPATCHER_ENV = "HOUSTON_DISPATCHER"


def _service_executable() -> str:
    """What a unit's ExecStart runs: the dispatcher that ran this, else this build.

    It named THIS build -- the venv's console script here, `node <checkout>/tools/cli.js`
    in the TypeScript one -- so a unit went stale the moment routing.conf moved `serve`,
    and would die with the Python at Phase 9.3. The owner's decision of 2026-09-28
    (g2-08): both builds name `bin/houston`, which Phase 9.3 turns into the TypeScript
    entry itself. Run directly, not through it, this build still names itself.

    systemd REFUSES a relative ExecStart, so this has to be absolute even when houston
    is not on PATH: a dispatcher path that is not absolute is not used, and in a venv
    the console script sits next to the interpreter, which is the case `which` misses.
    """
    dispatcher = os.environ.get(_DISPATCHER_ENV, "")
    if os.path.isabs(dispatcher):
        return dispatcher
    return shutil.which("houston") or str(Path(sys.executable).parent / "houston")


def _print_service_unit(_cmdline, basic, edgesvc, print_service):
    """How to keep this running, printed rather than installed."""
    if print_service:
        # Printed after the checks above, never before: a unit that reproduces a
        # command which would be refused is worse than no unit at all.
        cmdline = _cmdline(_service_executable(), service=True)

        typer.echo(f"\n# systemd — survives logout, restarts on crash, starts on boot.\n"
                   f"# Write this to {edgesvc.UNIT_PATH}:\n")
        typer.echo(edgesvc.systemd_unit(cmdline, os.environ.get("USER", "houston")))
        typer.echo("# Then:")
        typer.echo(f"    sudo tee {edgesvc.UNIT_PATH} > /dev/null   # paste the above")
        typer.echo("    sudo systemctl daemon-reload")
        typer.echo("    sudo systemctl enable --now houston")
        typer.echo("    systemctl status houston && journalctl -u houston -f")
        typer.echo("\n# No systemd? nohup survives logout — and nothing else:")
        typer.echo(f"    nohup {cmdline} > {config.home() / 'serve.log'} 2>&1 &")
        typer.echo("# It will NOT restart on crash, NOT come back after a reboot,")
        typer.echo("# NOT rotate that log, and there is no `status` to ask.")
        if not basic:
            typer.echo("\n# Note: no accounts exist, so this would refuse to start on a")
            typer.echo("# reachable interface. `houston users add <name>` first.")
        raise typer.Exit(0)


def _resolve_front_door(allow, bind, domain, door, edgesvc, email, no_domain, port, tlsmod):
    """Whether this GUI is served through the shared front door, and on what name."""
    # Reuse the name this box was already set up with. `serve --domain X --email Y`
    # records both, and without this you had to retype them on every restart --
    # and a plain `serve` did not merely forget, it went back to loopback while
    # the edge's GUI route still pointed at a process it could no longer reach,
    # so the name 502'd. Pass --no-domain for a deliberately local session.
    if not domain and not no_domain:
        domain = edgesvc.served_domain()
        if domain:
            ui.note(f"  serving {domain} (set up earlier; --no-domain for a local "
                    "session)")
    if domain:
        # Normalized before anything reads it: it becomes the Host() rule, a TLS
        # SNI name and the printed URL, so a surviving scheme corrupts all three.
        domain, fixed = tlsmod.normalize_domain(domain)
        if fixed:
            ui.note(f"  using --domain {domain} ({fixed})")
        cfg = config.load_config()
        given_email = email
        email = email or str(cfg.get("acme_email") or "")
        if not email:
            _err("a Let's Encrypt certificate needs a contact email:\n"
                 f"  houston serve --domain {domain} --email you@example.com\n"
                 "It is remembered after the first use, or set it once with:\n"
                 "  houston config set acme.email you@example.com")
        if given_email and given_email != str(cfg.get("acme_email") or ""):
            # `up` documents the email as remembered after first use; it was not
            # true here, so every restart needed it retyped.
            config.save_config({**cfg, "acme_email": email})
        # No "this publishes the GUI with no login" warning here any more. With a
        # --domain the bind is never loopback, so the accounts check below ALWAYS
        # refuses -- nothing was ever published, and warning about a thing that
        # cannot happen, one line above refusing to do it, is what made this screen
        # read as two contradictory answers to the same question.
        # The bridge, not 0.0.0.0: the front door is the only thing that needs to
        # reach the GUI, so the port never has to be exposed to the network.
        gui_bind = bind or edgesvc.bridge_address()
        if not gui_bind:
            _err("could not read the Docker bridge address, which is how the front "
                 "door reaches the GUI.\n"
                 "  Is Docker running? `houston doctor` checks.")
        bind = gui_bind
        # Traefik forwards the original Host, so the allow-list has to accept it
        # or every proxied request is a 403.
        allow.append(domain)
        # resolve(), not the constructor: the challenge and whether a wildcard is
        # possible are both derived from whether DNS credentials exist, the same
        # rule `up --domain` already uses. Never asked for.
        door = edgesvc.Edge.resolve(domain, email, gui_host=bind, gui_port=port)
    elif not bind:
        bind = "127.0.0.1"
    return bind, domain, door, email


def _normalise_allowed_hosts(allow_host, tlsmod):
    """Accept a Host the way a browser sends it, however the flag was spelt."""
    # Normalised HERE, before anything reads it: `allow` becomes the Host allow-list
    # AND the host in the printed URL, so a value carrying a scheme, a port or a
    # trailing slash used to produce both a list that matched nothing and a URL like
    # `http://https://lab.example.com/:9944/`. Reported as three separate attempts
    # that each started, claimed to be healthy, and 403'd every request.
    #
    # Reported the way --domain already reports its own fix-ups, a few lines below,
    # so the correction is visible rather than silent.
    allow = []
    for _given in (allow_host or []):
        try:
            _host, _fixed = tlsmod.normalize_allow_host(_given)
        except errors.ReproError as exc:
            _fail(exc)
        if _fixed:
            ui.note(f"  using --allow-host {_host} ({_fixed})")
        allow.append(_host)
    allow_host = list(allow)      # so _cmdline() echoes the corrected form back
    return allow, allow_host


_SERVE_HELP = """Launch the web GUI (needs `pip install 'houston\\[gui]'`).

\b
TRYING IT OUT? There is nothing to learn:
    houston serve

Binds localhost — nothing crosses a network, and none of the options below
apply. The first run prints a one-time link ending in /setup#k=... ; open the
whole url, including the part after #, to make the first account.

(On a box already set up with --domain, plain `serve` keeps serving that name.
Add --no-domain for a local session.)

The rest is only about letting OTHER machines reach it:

\b
    your team, over HTTPS    --domain rc.example.com --email you@example.com
    a lab or proxy in front  --bind 0.0.0.0 --allow-host <name> --trust-proxy <ip>
    a plain IP, no TLS       --bind 0.0.0.0 --allow-host <ip>

--bind decides whether anything off this machine can reach it; --allow-host
says which names may be used to. Whatever you type in the address bar must be
listed there or every request is a 403, and either flag alone does nothing.

--trust-proxy names whatever already terminates TLS (a lab url, ngrok, a load
balancer) so the session cookie can be marked Secure. Address or CIDR — a bare
0.0.0.0 is one address and matches nothing; 0.0.0.0/0 is anywhere.

The third row is refused until you say what protects the password. `serve`
prints the flag to add, and why, at the point it stops.

Binding anything but localhost exposes docker control — creating and deleting
repros and their volumes — to whoever can reach the port.
"""


def _serve_cmdline(domain, email, bind, insecure, trust_proxy, port, allow_host,
                   exe="houston", *, service=False):
    """Rebuild a resolved serve invocation for a refusal or service unit."""
    import shlex
    parts = [exe, "serve"]
    if domain:
        parts += ["--domain", domain, "--email", email]
    else:
        parts += ["--bind", bind]
        if insecure:
            parts.append("--insecure")
        for cidr in (trust_proxy or []):
            parts += ["--trust-proxy", cidr]
    if port != 7070:
        parts += ["--port", str(port)]
    for host in (allow_host or []):
        parts += ["--allow-host", host]
    if service:
        parts.append("--no-open")
    return " ".join(shlex.quote(part) for part in parts)


def _run_serve(port, domain, email, no_domain, bind, allow_host, no_open,
               print_service, insecure, trust_proxy, uvicorn, create_app,
               trusted_problems, usable_trusted, webbrowser, tlsmod, edgesvc,
               usersvc, frsvc):
    """Resolve the security posture, announce it, and own the uvicorn process."""
    allow, allow_host = _normalise_allowed_hosts(allow_host, tlsmod)
    basic = usersvc.any_users()
    door = None
    bind, domain, door, email = _resolve_front_door(
        allow, bind, domain, door, edgesvc, email, no_domain, port, tlsmod)
    loopback = bind in ("127.0.0.1", "localhost", "::1")
    cmdline = partial(_serve_cmdline, domain, email, bind, insecure,
                      trust_proxy, port, allow_host)
    setup_key = _first_run_key(cmdline, basic, domain, frsvc, loopback)
    _refuse_a_password_in_the_clear(
        allow, allow_host, basic, bind, domain, door, insecure, loopback, port,
        trust_proxy, trusted_problems)
    _print_service_unit(cmdline, basic, edgesvc, print_service)
    url = _open_the_front_door(
        allow_host, bind, domain, door, edgesvc, email, loopback, port, setup_key)
    trusted = _announce(
        basic, domain, door, edgesvc, loopback, setup_key, tlsmod, trust_proxy,
        url, usable_trusted, usersvc)
    app_obj = create_app(allow_hosts=allow, accounts=True,
                         public_https=bool(domain), first_run=bool(setup_key),
                         trust_proxy=trusted)
    if not no_open and loopback:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001 - headless / no browser is fine
            pass
    # A LIVENESS FILE, for the marker promotion and nothing else. `services.promote`
    # refuses to move a home to `dual-v1` while a GUI is running against it: the jobs it
    # is holding are work the five state locks do not represent, and its in-memory caches
    # would outlive the marker it was started under. Without a file to look at, that
    # check has nothing to check and the clause is decoration.
    #
    # Best effort in both directions. A home that cannot be written must not stop the
    # server, and a crash leaves the file behind -- which is why the reader asks the
    # kernel whether the pid is alive rather than trusting the file's existence.
    pid_file = promotesvc.serve_pid_path(config.home())
    try:
        pid_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        pid_file.write_text(f"{os.getpid()}\n", encoding="utf-8")
    except OSError:
        pid_file = None
    try:
        # The process owns forwarded-header trust; clients may not choose security facts.
        uvicorn.run(app_obj, host=bind, port=port, log_level="warning",
                    proxy_headers=False)
    finally:
        if pid_file is not None:
            try:
                pid_file.unlink(missing_ok=True)
            except OSError:
                pass


def serve(
    port: int = typer.Option(7070, "--port", help="host port for the web GUI"),
    domain: str = typer.Option("", "--domain", help="serve the GUI over HTTPS on this hostname, via houston's shared front door"),
    email: str = typer.Option("", "--email", help="contact address for the Let's Encrypt certificate (remembered after the first use)"),
    no_domain: bool = typer.Option(False, "--no-domain", help="ignore the domain this box was set up with and serve locally"),
    # Default resolved below, not here: with --domain the GUI should bind the
    # Docker bridge, and an empty default is the only way to tell "the user chose
    # 127.0.0.1" from "the user chose nothing".
    bind: str = typer.Option("", "--bind", help="interface to bind (default: loopback, or the Docker bridge with --domain)"),
    allow_host: list[str] = typer.Option(None, "--allow-host", help="extra Host header to accept, e.g. a reverse-proxy domain (repeatable; '*' = any host). Needed for iximiuz/Codespaces/remote access"),
    no_open: bool = typer.Option(False, "--no-open", help="don't open a browser"),
    no_token: bool = typer.Option(False, "--no-token", hidden=True,
                                  help="deprecated no-op: there is no session token any more"),
    print_service: bool = typer.Option(False, "--print-service", help="print how to keep this running (systemd unit, or nohup) and exit — writes nothing"),
    # Hidden, not removed. It is the only way to serve plain http on a reachable
    # interface (an EC2 public IP with no proxy), so it has to keep working -- but
    # putting it in --help meant every first-time reader met a security decision
    # that does not apply to them, on localhost or behind a lab's TLS. The one
    # moment it IS needed, `serve` refuses and names it, with the command to add
    # it to. That refusal is a better teacher than a line in a list.
    insecure: bool = typer.Option(False, "--insecure", hidden=True,
                                  help="no TLS anywhere: the password crosses the network readable, and you accept that. Only needed on a reachable bind with no proxy in front"),
    trust_proxy: list[str] = typer.Option(None, "--trust-proxy", help="TLS ends at this proxy: believe its X-Forwarded-Proto/-For and mark the cookie Secure (address or CIDR, repeatable)"),
) -> None:
    """Launch the web GUI."""
    try:
        import uvicorn
        from houston.web.app import create_app, trusted_problems, usable_trusted
    except ImportError:
        _err("the web GUI needs extra deps — install them with: pip install 'houston[gui]'")
    import webbrowser

    from houston import tls as tlsmod
    from houston.services import edge as edgesvc
    from houston.services import users as usersvc

    from houston.services import firstrun as frsvc
    return _run_serve(
        port, domain, email, no_domain, bind, allow_host, no_open, print_service,
        insecure, trust_proxy, uvicorn, create_app, trusted_problems,
        usable_trusted, webbrowser, tlsmod, edgesvc, usersvc, frsvc)


# Typer reads the callback docstring after import. Keeping the prose outside the
# callback preserves its byte-identical public help without making it executable span.
serve.__doc__ = _SERVE_HELP
