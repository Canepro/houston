"""Remembered settings, so they need not be retyped: `use` `config` `env`.

Two scopes that read alike and are not: `config` writes THIS BOX's remembered defaults
under `HOUSTON_HOME`, while `env` changes one workspace's Rocket.Chat environment and
restarts it. `use` picks which workspace the name-less commands mean.
"""
from __future__ import annotations


import typer

from houston import config, errors, ui
from houston.services import envvars as envsvc
from houston.services import lifecycle as lcsvc
from houston.cli._common import (_UNSET, _cli_emit,
                                 _err, _fail)


def use(name: str = typer.Argument(..., help="repro to make the default")) -> None:
    """Set the default repro for name-less commands."""
    # THROUGH resolve_name, like every other name-taking command. This called
    # `runner.exists()` on the literal string, so `use TICKET-1234` failed on a
    # workspace really named `ticket-1234` while `info --name TICKET-1234` found it --
    # and `name_candidates()`'s docstring is written about exactly that defect and says
    # it was fixed. `use` was missed. On a box with accounts the owner-prefix half
    # bites too: `up --name test` makes `alice-test`, and `use test` could not find it.
    # A typed error, so the exit code is 4 rather than a flat 1.
    try:
        target = lcsvc.resolve_name(name)
    except errors.ReproError as exc:
        _fail(exc)
    config.update_config(lambda cfg: cfg.__setitem__("default_repro", target))
    ui.ok(f"✓ default repro is now {target!r}.")


_BOOL_CONFIG_KEYS = frozenset({"acme.staging"})


_CONFIG_KEYS: dict[str, str] = {
    # The default cluster for `--runtime kubernetes`, so a box that always works in
    # one cluster says so once instead of on every `up`. `--context` still wins.
    # Stored FLAT (`kubernetes_context`) -- see config.KUBE_CONTEXT_KEY for why that
    # is mechanical rather than a style choice.
    "kubernetes.context": config.KUBE_CONTEXT_KEY,
    # Which AWS accounts `cluster create` may spend in. Comma separated; absent means
    # none, and none means every create is gated. NOT overridable by `--force`, which
    # is a reflex where this is a decision.
    "cluster.approved_accounts": config.CLOUD_ACCOUNTS_KEY,
    "acme.email": "acme_email",
    # Not a flag on `up`, on purpose: HTTPS is meant to be --domain plus --email and
    # nothing else. It stays reachable here because Let's Encrypt allows only 5
    # failed validations per hostname per hour and 5 duplicate certificates per week
    # -- without a way to rehearse against staging, a misconfigured first attempt
    # locks the hostname out for a week.
    "acme.staging": "acme_staging",
    # `http` | `tlsalpn` | `dns`. Normally derived and never asked for -- dns-01 when
    # credentials exist, TLS-ALPN otherwise -- and this exists because a real box had
    # NEITHER available: TLS-ALPN validation failed on every attempt with `remote error:
    # tls: unrecognized name`, and dns-01 was impossible because the operator had the
    # machine and not the zone. http-01 validates on :80, which needs only host access,
    # and there was no way to select it. Setting it turns the edge's :80 redirect off,
    # because that redirect would send Let's Encrypt away from the challenge path.
    "acme.challenge": "acme_challenge",
    # Only needed when the variable names in dns.env do not identify the provider
    # on their own; normally it is inferred.
    "acme.dns_provider": "acme_dns_provider",
    # Which interface every workspace on this box publishes on, unless `up --bind`
    # overrides it. lifecycle.py has read this all along (`req.bind or
    # cfg.get("bind_host") or DEFAULT_BIND_HOST`) and config.py maps
    # HOUSTON_BIND_HOST onto it -- but it was not in this table, so the only
    # supported way to set it was an environment variable on the serve process.
    #
    # That mattered once `bind` became admin-only on POST /api/repros: a member was
    # told "only an admin can set this" and the admin had nowhere to set it either.
    # A boundary with no door on the other side is just a wall.
    #
    # Box-level is also the right SHAPE for this decision. Every workspace runs
    # fixed admin/admin123 credentials, so "does this machine publish those beyond
    # loopback?" is one answer for the box, not a checkbox on each create.
    "bind_host": "bind_host",
    # Both GUI policies. Neither was in this table: lifecycle.py documented
    # `gui.destroy_policy` as the way to loosen who may delete somebody else's
    # workspace, and there was no supported way to write it -- the same missing door
    # as bind_host above, in the same file, unnoticed for the same reason. A policy
    # nobody can set is a comment.
    #
    #   gui.create_policy   anyone (default) | admin  -- rc_image, reg_token, bind
    #   gui.destroy_policy  owner (default)  | anyone  -- `down --volumes` on
    #                                                     somebody else's workspace
    #
    # They default OPPOSITE ways on purpose. A create field only ever affects the
    # workspace being created; destroying somebody else's loses a colleague's
    # in-progress work, which no create field can do.
    "gui.create_policy": "gui.create_policy",
    "gui.destroy_policy": "gui.destroy_policy",
}


def _config_set(action, key, stored, value):
    """The `set` action: validate against the key's own rules, then remember it."""
    if action == "set":
        if not value:
            _err(f"`config set {key}` needs a value")
        # A misspelt policy falls back to the strict reading, which is safe but
        # silent -- and somebody who typed `anyonr` would believe they had opened it.
        if key in ("gui.create_policy", "gui.destroy_policy"):
            strict = "admin" if key == "gui.create_policy" else "owner"
            if value not in ("anyone", strict):
                _err(f"{key} takes 'anyone' or '{strict}' (got {value!r})")
        stored_value: object = value
        if key in _BOOL_CONFIG_KEYS:
            # COERCED, because the raw string was stored and `bool("false")` is True --
            # so this command could turn a setting on and never off. Refused rather
            # than guessed for anything unrecognised: silently storing a truthy string
            # is the defect being fixed.
            low = value.strip().lower()
            if low not in config._TRUE + config._FALSE or low == "":
                _err(f"{key} takes true or false (got {value!r})")
            stored_value = config.truthy(value)
        config.update_config(lambda c: c.__setitem__(stored, stored_value))
        ui.ok(f"✓ {key} = {stored_value}")
        return
    _err(f"unknown action {action!r} (want: list | get | set | unset)")


def config_cmd(
    action: str = typer.Argument("list", help="list | get | set | unset"),
    key: str = typer.Argument("", help="e.g. kubernetes.context"),
    value: str = typer.Argument("", help="the value, for `set`"),
) -> None:
    """Read or write remembered settings, so they need not be retyped every run.

    Keys: kubernetes.context, cluster.approved_accounts, acme.email, acme.staging,
    acme.dns_provider,
    bind_host, gui.create_policy, gui.destroy_policy. Stored in
    ~/.houston/config.yaml.

    \b
    Members may set --rc-image/--reg-token/--bind by default. Where an account is
    not the same thing as trust, narrow it:
        houston config set gui.create_policy admin
    \b
    And to publish every workspace on this box beyond loopback, one decision
    instead of one per create:
        houston config set bind_host 0.0.0.0
    """
    if action == "list":
        cfg = config.load_config()
        for shown, stored in _CONFIG_KEYS.items():
            # `.get(k, _UNSET)`, not `.get(k) or ...`: a stored `False` is falsy, so
            # `or` rendered it as "(unset)" -- and `acme.staging` is a BOOLEAN whose
            # whole history is people not being able to tell which way it is set.
            # `config set acme.staging false` then reported success and both `list`
            # and `get` said the key was unset, which is the same confusion one layer
            # up from the `bool("false")` defect this key already had.
            value = cfg.get(stored, _UNSET)
            typer.echo(f"  {shown:20} "
                       f"{'(unset)' if value is _UNSET else value}")
        return
    if key not in _CONFIG_KEYS:
        _err(f"unknown key {key!r} (want: {', '.join(_CONFIG_KEYS)})")
    stored = _CONFIG_KEYS[key]
    if action == "get":
        # Same distinction as `list`: an empty line means the key is not set, so a
        # `False` that printed as one was indistinguishable from absent.
        value = config.load_config().get(stored, _UNSET)
        typer.echo("" if value is _UNSET else value)
        return
    if action == "unset":
        config.update_config(lambda c: c.pop(stored, None))
        ui.ok(f"✓ {key} unset.")
        return
    return _config_set(action, key, stored, value)


def _env_read_or_write(name, no_restart, set_, setting, unset):
    """With nothing to set, `env` is a read; otherwise it applies and reports."""
    if not set_ and not setting and not unset:
        # WRAPPED LIKE ITS SIBLINGS. `stats`, `logs`, `info`, `token`, `tls-status`,
        # `chown` and `seed` all catch this; the env READ path did not, so an unknown
        # name escaped to main() -- which then mishandled it (see `_exit_reporting`)
        # and exited 1 where the table says 4.
        try:
            cur = envsvc.current(name)
        except errors.ReproError as exc:
            _fail(exc)
        # DRIFT IS MARKED, NOT FOLDED IN. A recorded value the container is not
        # running was displayed as `<- yours`, which confirms a setting that is not in
        # effect — on the exact question this command exists to answer.
        rows = [(e["key"], e["value"]
                 + ("   <- yours" if e["override"] else "")
                 + ("   !! NOT IN THE RUNNING CONTAINER" if e.get("drift") else ""))
                for e in cur["env"]]
        ui.panel(f"env: {cur['name']}", rows)
        if cur.get("drift"):
            ui.warn(f"  {len(cur['drift'])} recorded value(s) are NOT what the "
                    f"container is running: " + ", ".join(cur["drift"]))
            ui.warn("  Rocket.Chat is using the old value. `houston env --set "
                    f"{cur['drift'][0]}=<value> --name {cur['name']}` re-applies and "
                    "recreates the container.")
        elif not cur.get("live_read", True):
            # SAID, because "no drift reported" and "drift could not be checked" are
            # different, and only one of them is reassuring.
            ui.hint("  the container could not be read, so this is the recorded "
                    "configuration and not a statement about what is running.")
        if cur["overrides"]:
            ui.hint("  your overrides: " + ", ".join(cur["overrides"]))
        else:
            ui.hint("  no overrides — this is the preset/base environment.")
        ui.hint("  a Rocket.Chat setting: houston env --setting Some_Setting_Id=value" +
                (f" --name {cur['name']}" if name else ""))
        ui.hint("  a raw env var:        houston env --set KEY=VALUE" +
                (f" --name {cur['name']}" if name else ""))
        return
    try:
        sets = {**envsvc.parse_set(set_ or []), **envsvc.as_setting(setting or [])}
        result = envsvc.set_env(name, sets, list(unset or []),
                                restart=not no_restart, emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    verb = "applied" if result["restarted"] else "written (not yet applied)"
    ui.ok(f"✓ env {verb} on {result['name']!r}.")
    for o in result["overrides"]:
        typer.echo(f"    {o['key']} = " + ("(removed)" if o["removed"] else o["value"]))
    if result["restarted"]:
        ui.hint(f"  verify: houston env --name {result['name']}")


def env_cmd(
    name: str = typer.Option("", "--name", "-n"),
    set_: list[str] = typer.Option(None, "--set", help="raw env var KEY=VALUE (repeatable)"),
    setting: list[str] = typer.Option(None, "--setting", help="Rocket.Chat SETTING Id=VALUE (repeatable) — adds the OVERWRITE_SETTING_ prefix for you, which a setting needs to take effect"),
    unset: list[str] = typer.Option(None, "--unset", help="KEY to remove entirely, including a preset default (repeatable)"),
    no_restart: bool = typer.Option(False, "--no-restart", help="write the change but don't recreate the container yet"),
) -> None:
    """Show or change a repro's Rocket.Chat environment variables.

    With no --set/--unset, lists the effective environment (credentials masked) and
    marks which keys you have overridden.

    An env var cannot be changed inside a running container, so applying a change
    recreates the Rocket.Chat container. MongoDB keeps running and its volume is
    untouched, so no data is lost and it takes seconds.
    """
    return _env_read_or_write(name, no_restart, set_, setting, unset)
