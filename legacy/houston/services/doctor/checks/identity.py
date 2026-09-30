"""Who can sign in to the GUI, and whether the state files are private.

One module per check SUBJECT. `check(ctx)` returns the rows it produced and never
raises: the whole point of this report is to run when the environment is broken, so a
check that fails degrades to a `warn` row rather than taking the report with it.
"""
from __future__ import annotations



from houston import config

from houston.services.doctor.rows import Ctx, Report, Row

#: The check id this module owns. Passed explicitly to `Report.line`, where the
#: original had a rolling `subject` variable that every block reassigned.
SUBJECT = "identity"


def _accounts(line, usersvc) -> None:
    """Who can sign in, and with what role.

    Nothing else reports this, and an install with no admin cannot make one from the
    GUI -- the repair is hand-editing a file most people would not think to look for.
    """
    if not usersvc.any_users():
        line(SUBJECT, "warn", "No GUI accounts — `houston serve` will refuse to start on "
                     "anything but loopback (`houston users add <name>`)", check="gui-accounts")
    else:
        admins = usersvc.admins()
        if admins:
            line(SUBJECT, "ok", f"{len(usersvc.list_users())} GUI account(s), "
                       f"admin: {', '.join(admins)}",
                 elsewhere="the People page", check="gui-accounts")
        else:
            line(SUBJECT, "fail", "No admin account — nobody can manage people from the "
                         "GUI. `houston users role <name> admin`", check="gui-admin")
        implicit = usersvc.implicit_admins()
        if implicit:
            line(SUBJECT, "warn", f"admin by default (blank role column): "
                         f"{', '.join(implicit)} — that is the migration for "
                         "accounts made before roles existed, not a choice. "
                         f"`houston users role {implicit[0]} member`", check="gui-roles")
        # Reported rather than warned about: this is the default and it is a
        # deliberate one, but "what may a member actually do on this box?" should
        # be answerable without reading source. Same reason `serve` names the
        # implicit admins -- a state that is visible is a state somebody can
        # disagree with.
        from houston.services import lifecycle as lcsvc
        if config.load_config().get(lcsvc.CREATE_POLICY_KEY) == "admin":
            line(SUBJECT, "ok", "members may not set --rc-image/--reg-token/--bind "
                       "(gui.create_policy admin)",
                 elsewhere="which fields the New workspace form offers", check="gui-create-policy")
        else:
            line(SUBJECT, "ok", "members may set --rc-image/--reg-token/--bind — narrow "
                       "it with `houston config set gui.create_policy admin`",
                 elsewhere="which fields the New workspace form offers", check="gui-create-policy")
    # `acme/dns.env` is a live DNS-provider API TOKEN, which the README tells people
    # to chmod by hand, and `ca/ca.key` mints trusted certificates for any name on
    # this box. Both were outside this loop while audit.log was inside it.


def _event_log(line) -> None:
    """Where the history is, and whether it is being written.

    A log nobody can find is one nobody reads, and a log that has silently stopped
    writing is worse than none -- so this reports the path, the size and the disabled
    case. Never a fail: the tool works perfectly without it.
    """
    try:
        from houston.services import eventlog
        _lp = eventlog.log_path()
        if eventlog.max_bytes() <= 0:
            line(SUBJECT, "warn", "Event log disabled (HOUSTON_LOG_MAX_MB=0) — nothing is "
                         "recording what houston did", check="event-log")
        elif _lp.exists():
            _mb = _lp.stat().st_size / 1_048_576
            line(SUBJECT, "ok", f"Event log: {_lp} ({_mb:.1f} MB of "
                       f"{eventlog.max_bytes() / 1_048_576:.0f} MB, then one "
                       f"rotation)", check="event-log")
        else:
            line(SUBJECT, "ok", f"Event log: {_lp} — written from the first command that "
                       f"reports progress", check="event-log")
    except Exception:  # noqa: BLE001 - a check must never break the report
        line(SUBJECT, "warn", "Event log status could not be determined", check="event-log")


def _state_files(line, sessionsvc, usersvc) -> None:
    """Whether the files that DECIDE who can sign in are sound: private, writable,
    and not quietly holding work a killed process left behind."""
    from houston import tls as _tlsmod
    for path in (usersvc.users_file(), sessionsvc.sessions_file(),
                 config.home() / "audit.log",
                 _tlsmod.acme_dir() / "dns.env",
                 config.home() / "ca" / "ca.key"):
        if path.exists() and (path.stat().st_mode & 0o077):
            line(SUBJECT, "warn", f"{path} is readable by other local users "
                         f"(mode {oct(path.stat().st_mode)[-3:]}); it should be 0600", check="state-file-perms")
    home = config.home()
    # WRITABLE, WHICH IS A DIFFERENT QUESTION FROM 0700. `home-perms` asks whether
    # other local users can READ the accounts and sessions; nothing asked whether
    # houston can WRITE. On a home it cannot, `list` and `doctor` both exit 0
    # while `up` and `users add` raise a bare PermissionError -- and doctor's only
    # hint was "Could not tell whether cluster 'houston-local' exists ([Errno 13]
    # Permission denied) - kind needs Docker", because the error surfaced through
    # the kind probe (which writes houston's own kubeconfig dir) and was reported
    # as a Docker problem. The symptom was found and attributed to the wrong thing.
    #
    # Probed rather than derived from st_mode: a mode says what the bits are, and
    # a read-only mount, a full disk or a container's user mapping all deny a write
    # with the bits looking fine.
    from houston.services import journal as journalsvc
    _event_log(line)
    for label, path in (("state root", home),
                        ("workspaces", home / "repros"),
                        ("locks", home / "locks"),
                        ("journal", journalsvc.journal_dir())):
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".houston-write-probe"
            probe.write_text("x")
            probe.unlink()
        except OSError as exc:
            line(SUBJECT, "fail", f"{path} is not writable ({exc.strerror or exc}) — every "
                         f"command that creates or records anything will fail with "
                         f"a bare {type(exc).__name__}. houston's {label}.",
                 check="home-writable")
            break
    if home.exists() and (home.stat().st_mode & 0o077):
        line(SUBJECT, "warn", f"{home} is 0{oct(home.stat().st_mode)[-3:]}, so another "
                     "local user can read the accounts and sessions inside it "
                     "— `serve` tightens it to 0700 at startup", check="home-perms")
    # A state file written by a NEWER houston must not be half-understood.
    marker = "# houston-state: "
    try:
        for ln in sessionsvc.sessions_file().read_text().splitlines():
            if ln.startswith(marker):
                seen = int(ln[len(marker):].strip())
                if seen > sessionsvc.STATE_VERSION:
                    line(SUBJECT, "fail", f"{sessionsvc.sessions_file()} was written by a "
                                 f"newer houston (state v{seen}, this reads "
                                 f"v{sessionsvc.STATE_VERSION}) — upgrade rather "
                                 "than run against it", check="sessions-file")
                break
    except OSError:
        pass


def check(ctx: Ctx) -> list[Row]:
    report = Report()
    line = report.line
    # ONE try around both halves, which is what it has always been: a failure reading
    # the accounts must skip the file checks too and produce exactly one row. Two trys
    # would be a behaviour change wearing the clothes of a refactor.
    try:
        from houston.services import sessions as sessionsvc
        from houston.services import users as usersvc

        _accounts(line, usersvc)
        _state_files(line, sessionsvc, usersvc)
    except Exception:  # noqa: BLE001 - a check must never break the report
        line(SUBJECT, "warn", "Identity status could not be determined")
    return report.rows
