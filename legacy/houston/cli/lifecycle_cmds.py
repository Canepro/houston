"""Making a workspace exist, and making it stop: `up` `start` `stop` `restart` `down` `prune`.

`up` is the command this tool is for -- one line that boots a version-matched Rocket.Chat
against a compatible MongoDB -- and it is long because everything optional hangs off it:
presets, seeding, scaling, HTTPS, monitoring, Kubernetes.

`down` and `prune` are the other half of the promise. `prune` refuses a pinned or running
workspace and says which, because "delete every workspace that is down" is only safe if
it is exactly that.
"""
from __future__ import annotations


import typer

from houston import errors, jsonout, runner, ui
from houston.services import journal, monitor as monitorsvc
from houston.services import envvars as envsvc
from houston.services import lifecycle as lcsvc
from houston.services import topology
# `up --seed` runs the same seeding `houston seed` does, so the helper lives with
# the `seed` command and this is a sibling reaching across. That is the only such
# reach in the package, and it is the right direction: `up` uses `seed`, not the
# reverse.
from houston.cli.data_cmds import _run_seed
from houston.cli._common import (_cli_actor, _cli_emit,
                                 _fail, _parse_set_params, _resolve_name)
from houston.cli._render import (_render_create_result)


def _orphan_owner(ns: str) -> str | None:
    """Who a stray namespace says it belongs to, for the prune prompt.

    `""` names nobody, `None` could not be read — the same three answers the service
    makes its decision on, so the prompt cannot promise a sweep the service will then
    refuse. Never raises: this is prompt text, and a cleanup verb must not fail
    because a probe did.
    """
    try:
        from houston.services import k8s
        from houston.services.lifecycle import _orphan_context
        return k8s.namespace_owner(ns, context=_orphan_context())
    except Exception:  # noqa: BLE001
        return None


def _cluster_reclaimable() -> bool:
    """Whether `prune` has a cluster to give back. Never raises: a cleanup verb must not
    fail because a probe did."""
    try:
        from houston.services import k8s
        return k8s.cluster_reclaimable()
    except Exception:  # noqa: BLE001
        return False


def _create_and_report(json_out, req, seed, seed_profile, stats, verify_seed):
    """Run the create, then say what happened in whichever form the caller asked for."""
    # In JSON mode the progress goes out as NDJSON `houston.event.v1` lines rather
    # than as prose, and the envelope below is the LAST line -- so a caller reads to
    # end-of-stream and parses one line, with no incremental parser and no guessing
    # about where the machine-readable part starts.
    writer = jsonout.EventWriter() if json_out else None
    try:
        result = lcsvc.create_repro(req, emit=(writer.emit if writer else _cli_emit),
                                    stream_output=False, monitor_attach=monitorsvc.attach)
    except errors.ReproError as exc:
        _fail(exc)
    if not json_out:
        _render_create_result(result)
    seeded = None
    if seed:
        seeded = _run_seed(runner.read_meta(result["name"]), seed_profile,
                           stats=stats, verify=verify_seed)
    # THE NOTE IS OURS TO CLOSE. `seed_here` told `create_repro` not to clear it,
    # because between its return and this line the workspace is serving with no seed
    # and a kill there is exactly what the note is for. `_run_seed` exits the process
    # on failure, so reaching this means the seed landed -- or none was asked for.
    journal.clear_kind(journal.CREATE_UNFINISHED, result["name"])
    if json_out:
        data = dict(result)
        if seeded is not None:
            # Folded in, not printed beside: exactly one envelope per command.
            data["seed"] = seeded
        jsonout.reply("up", data)


def _create_request(bind, context, deployment, domain, email, env, force, fresh, https, ingress_class, mongo, mongo_operator, monitor, name, no_pull, offline, pin, port, preset, rc_image, reg_token, replicas, root_url, runtime, seed, seed_profile, set_, setting, stats, version, wait):
    """The command's options, folded into the one request the service layer takes. As many parameters as `up` has options, because that is what it is."""
    req = lcsvc.CreateReq(
        version=version, preset=preset, name=name, port=port, root_url=root_url,
        bind=bind, rc_image=rc_image, mongo=mongo, reg_token=reg_token,
        # THE REAL SEED REQUEST, even though the CLI seeds itself afterwards.
        # `seed=False` meant the write-ahead note recorded `seed: False` with the
        # profile defaulted, and `create_repro` cleared the note before control ever
        # returned here -- so the `pending_seed` recovery landed in v0.72.2 covered the
        # GUI and NOT `houston up --seed`, the invocation the README documents. That
        # is the exact scenario lifecycle.py describes: "told the workspace is
        # complete, doctor agrees, and the evidence that anything was missing has been
        # deleted."
        #
        # `seed_here=True` keeps the two-phase shape -- the CLI still runs the seed, so
        # it keeps its richer rendering and `--verify-seed` -- while the note tells the
        # truth about what was asked for and is cleared by whoever finishes it.
        params=_parse_set_params(set_), seed=seed, seed_here=True,
        seed_profile=seed_profile, stats=stats, pin=pin,
        wait=(wait or seed), offline=offline, no_pull=no_pull, fresh=fresh,
        force=force, monitor=monitor, actor=_cli_actor(),
        runtime=runtime, deployment=deployment, replicas=replicas, context=context,
        mongo_operator=mongo_operator,
        https=https, domain=domain, acme_email=email, ingress_class=ingress_class,
        env={**envsvc.parse_set(env or []), **envsvc.as_setting(setting or [])},
    )
    return req


def up(
    version: str = typer.Option(..., "--version", "-v", help="Rocket.Chat version, e.g. 6.5.3"),
    preset: str = typer.Option("default", "--preset", "-p", help="scenario to apply: ldap, saml, oidc, email, s3_minio, livechat, airgapped"),
    runtime: str = typer.Option("", "--runtime", help="where it runs: docker (default) | kubernetes"),
    deployment: str = typer.Option("", "--deployment", help="how RC is arranged. docker: monolith (default) | multi-instance. kubernetes: microservices (default) | monolith"),
    replicas: int = typer.Option(0, "--replicas", help="Rocket.Chat instances (needs --deployment multi-instance on docker)"),
    context: str = typer.Option("", "--context", help="which Kubernetes cluster — its own name (`support`) or the full context name. ADOPTS it; never creates one. Remembered after the first use (`houston config set kubernetes.context`)"),
    mongo_operator: bool = typer.Option(False, "--mongo-operator", help="kubernetes: manage MongoDB with the official operator (adds SCRAM auth; needs MongoDB 6.0+)"),
    name: str = typer.Option("", "--name", "-n", help="repro name (default: derived)"),
    port: int = typer.Option(0, "--port", help="host port (default: first free >= 3000)"),
    root_url: str = typer.Option("", "--root-url", help="override ROOT_URL"),
    bind: str = typer.Option("", "--bind", help="host interface for published ports (default 127.0.0.1 — local only). 0.0.0.0 exposes RC AND sidecars with well-known credentials to your whole network — use deliberately"),
    rc_image: str = typer.Option("", "--rc-image", help="override the RC image repo"),
    mongo: str = typer.Option("", "--mongo", help="override the resolved MongoDB tag"),
    reg_token: str = typer.Option("", "--reg-token", help="cloud registration token (EE license)"),
    set_: list[str] = typer.Option(None, "--set", help="preset parameter KEY=VALUE (repeatable), e.g. --set users=5"),
    seed: bool = typer.Option(False, "--seed", help="populate with sample users/channels/messages after boot"),
    seed_profile: str = typer.Option("small", "--seed-profile", help="seed size: small | standard | large"),
    verify_seed: bool = typer.Option(False, "--verify-seed", help="with --seed: fail if the readback disagrees with the plan"),
    pin: bool = typer.Option(False, "--pin", help="mark persistent + set as default"),
    wait: bool = typer.Option(False, "--wait", help="block until RC is serving"),
    offline: bool = typer.Option(False, "--offline", help="skip the live version lookup"),
    no_pull: bool = typer.Option(False, "--no-pull", help="don't pull images first"),
    fresh: bool = typer.Option(False, "--fresh", help="wipe this repro's volume first"),
    force: bool = typer.Option(False, "--force", help="overwrite an existing repro"),
    monitor: bool = typer.Option(False, "--monitor", help="also add Prometheus + Grafana (RC metrics dashboard)"),
    stats: bool = typer.Option(False, "--stats", help="with --seed: report the CPU/RAM cost of seeding"),
    domain: str = typer.Option("", "--domain", help="serve HTTPS at this hostname with a Let's Encrypt certificate. The domain must already point at this host and 443 must be reachable"),
    email: str = typer.Option("", "--email", help="contact email for Let's Encrypt. Remembered after the first use (`houston config set acme.email`)"),
    json_out: bool = typer.Option(False, "--json", help="NDJSON progress on stdout, then one final JSON envelope; prose moves to stderr"),
    https: bool = typer.Option(False, "--https", help="serve HTTPS with a local certificate instead — no domain needed (run `houston trust-ca` once)"),
    ingress_class: str = typer.Option("", "--ingress-class", help="Kubernetes only: which IngressClass to route through, when the cluster has more than one (e.g. `alb`, `nginx`). Defaults to the cluster's own default class"),
    env: list[str] = typer.Option(None, "--env", "-e", help="extra raw env var KEY=VALUE (repeatable). Persisted, so `up --force` keeps it; change it later with `houston env`"),
    setting: list[str] = typer.Option(None, "--setting", help="Rocket.Chat SETTING Id=VALUE (repeatable) — adds the OVERWRITE_SETTING_ prefix a setting needs"),
) -> None:
    """Create and start a version-matched Rocket.Chat repro."""
    # Orchestration lives in the shared service layer (same code the web GUI
    # runs); this wrapper just parses options, prints progress, and formats the
    # result. --seed is applied after (with the CLI's richer --stats output), so
    # `wait` is forced on when seeding, as before.
    if json_out:
        jsonout.activate()
    req = _create_request(bind, context, deployment, domain, email, env, force, fresh, https, ingress_class, mongo, mongo_operator, monitor, name, no_pull, offline, pin, port, preset, rc_image, reg_token, replicas, root_url, runtime, seed, seed_profile, set_, setting, stats, version, wait)
    return _create_and_report(json_out, req, seed, seed_profile, stats, verify_seed)


def _confirm_destruction(json_out, target, volumes, yes):
    """The confirmation --volumes needs, and the refusal when it cannot be asked for."""
    if volumes and json_out and not yes:
        # REFUSED, not silently downgraded to keeping the volume. There is nobody
        # to prompt on this path, and the two ways out of that are "delete the data
        # without being asked" and "quietly do something other than what was typed".
        # Neither is acceptable for an irreversible verb, so it asks for the
        # confirmation to be made explicit instead.
        _fail(errors.ValidationError(
            "--volumes deletes the data volume and the record, and --json has "
            "nobody to prompt. Add --yes to confirm it in the command."))
    if volumes:
        # --volumes is irreversible (deletes the Mongo data + the record). On a
        # shared box the thing you most need to know first is whose it is, so the
        # owner leads the prompt -- and is still printed under --yes, where there
        # is no prompt to read but there is a log to read afterwards.
        owner, me = lcsvc.owner_of(target), _cli_actor()
        whose = f" -- owned by {owner}" if owner and owner != me else ""
        if not yes:
            if whose:
                ui.warn(f"{target!r} belongs to {owner}, not you.")
            typer.confirm(
                # No !r: the quotes it adds collide with the possessive and the
                # prompt reads "deletes 'alice-rc8-6-1''s data volume", which is
                # a confusing thing to put in front of somebody about to type y.
                f"This permanently deletes the data volume and record for {target}"
                f"{whose}. Continue?",
                abort=True,
            )
        elif whose:
            ui.warn(f"deleting {target!r}, owned by {owner}.")


def down(
    name: str = typer.Option("", "--name", "-n"),
    volumes: bool = typer.Option(False, "--volumes", help="also delete the data volume and forget the repro"),
    yes: bool = typer.Option(False, "--yes", "-y", help="skip the confirmation prompt (for scripts/CI)"),
    json_out: bool = typer.Option(False, "--json", help="print the result as one JSON envelope; --volumes then requires --yes"),
) -> None:
    """Remove a repro's containers. Keeps data (and the record) unless --volumes."""
    if json_out:
        jsonout.activate()
    target = _resolve_name(name)
    _confirm_destruction(json_out, target, volumes, yes)
    try:
        # confirm=True: the prompt above (or --yes) already gated it.
        # `emit` MATTERS HERE. This passed none, so every warning the teardown raises
        # went nowhere -- including the one that says the local record was KEPT because
        # the namespace could not be confirmed gone. The GUI streams these and showed
        # it; the CLI printed a success line over the top of it.
        out = lcsvc.teardown(target, volumes=volumes, confirm=True, emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    # The nouns depend on the runtime, and this line hardcoded Docker's. A
    # Kubernetes workspace has no containers and no Docker volume -- it has a
    # namespace and a PersistentVolumeClaim -- and `helm uninstall` does NOT delete
    # a PVC, so which of the two paths kept the data is exactly what needs saying.
    # The service layer already knows; asking it beats guessing here.
    kube = (out or {}).get("runtime") == topology.KUBERNETES
    if json_out:
        jsonout.reply("down", {**(out or {}), "name": target, "volumes": volumes})
        return
    what = ("namespace, PersistentVolumeClaim and record" if kube
            else "containers, data volume, and record")
    # `(out or {})` like the `kube` line above: teardown returning None is a shape the
    # tests around this rely on, and `.get` on it is an AttributeError that surfaces as
    # exit 1 from a command that worked.
    if volumes and not (out or {}).get("removed", True):
        # THE SERVICE SAID NO. This printed "✓ removed" from the `--volumes` FLAG rather
        # than from the result, so a teardown that refused and kept the record reported
        # complete success -- and `list` then went on showing the workspace, which is
        # how the contradiction reaches somebody. The warning above says why; this says
        # what to do, and the exit code stops a script believing it.
        ui.warn(f"{target!r} was NOT removed — see above. `houston list` still shows "
                f"it, which is correct: the record is deliberately kept.")
        raise typer.Exit(errors.NotReadyError.exit_code)
    if volumes:
        ui.ok(f"✓ {target!r} removed ({what}).")
    else:
        kept = ("the namespace and its PersistentVolumeClaim are kept" if kube
                else "data kept")
        ui.ok(f"✓ {target!r} down ({kept}).")
        typer.echo(f"  bring it back: houston up --version <same> --name {target}")
        typer.echo("  delete for good: add --volumes, or run `houston prune`")


def _prune_empty_cluster(reclaim, yes, orphans, force):
    """Offer to return an otherwise empty houston-owned cluster."""
    if not reclaim:
        typer.echo("Nothing to prune.")
        return
    if not yes:
        typer.echo("Nothing to prune, but houston's own Kubernetes cluster is "
                   "empty and can be given back (about 0.5 GB).")
        typer.confirm("Delete the cluster?", abort=True)
    try:
        res = lcsvc.prune(confirm=True, orphans=orphans, force=force, emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    if res.get("cluster"):
        ui.ok("✓ the cluster is gone — the next Kubernetes workspace creates a new one.")
    else:
        typer.echo("Nothing to prune.")


def _confirm_prune(targets, stray):
    """Name every destructive target before asking once."""
    typer.echo("These down repros will be deleted — containers, data volumes, and records:")
    me = _cli_actor()
    for target in targets:
        owner = lcsvc.owner_of(target)
        typer.echo(f"  - {target}" + (f"   (owned by {owner})" if owner and owner != me else ""))
    if stray:
        typer.echo("")
        typer.echo("These Kubernetes namespaces are labelled houston's but no "
                   "local record explains them — their PersistentVolumeClaims go too:")
        for namespace in stray:
            owner = _orphan_owner(namespace)
            if owner is None:
                typer.echo(f"  - {namespace}   (owner could not be read — needs --force)")
            elif owner and owner != me:
                typer.echo(f"  - {namespace}   (belongs to {owner} — needs --force)")
            else:
                typer.echo(f"  - {namespace}")
        typer.echo("  (on a shared cluster one of these may belong to a colleague)")
    typer.confirm("Continue?", abort=True)


def _render_prune_result(res):
    """Report records, orphan namespaces, and the cluster independently."""
    if res["removed"]:
        ui.ok(f"✓ pruned {len(res['removed'])}: {', '.join(res['removed'])}")
    if res.get("orphans"):
        ui.ok(f"✓ removed {len(res['orphans'])} orphaned namespace(s): "
              f"{', '.join(res['orphans'])}")
    if not res["removed"] and not res.get("orphans"):
        typer.echo("Nothing to prune.")
    if res.get("cluster"):
        ui.ok("✓ the cluster is gone too — the next Kubernetes workspace creates a new one.")


def prune(
    yes: bool = typer.Option(False, "--yes", "-y", help="skip the confirmation prompt (for scripts/CI)"),
    orphans: bool = typer.Option(False, "--orphans",
                                 help="also delete Kubernetes namespaces houston owns "
                                      "that no local record explains"),
    force: bool = typer.Option(False, "--force",
                               help="with --orphans, sweep namespaces that belong to "
                                    "somebody else or whose owner cannot be read"),
) -> None:
    """Delete every `down` repro — INCLUDING its data volume and record. Skips pinned and running ones."""
    try:
        targets = lcsvc.prunable()
        stray = lcsvc.orphan_namespaces() if orphans else []
    except errors.ReproError as exc:
        _fail(exc)
    # The CLUSTER is reclaimable separately from any workspace: with everything gone,
    # houston's own kind control plane is 514 MiB holding nothing, and both the README
    # and the agent skill said `prune` gives it back -- which nothing did.
    reclaim = _cluster_reclaimable()
    if not targets and not stray:
        _prune_empty_cluster(reclaim, yes, orphans, force)
        return
    if not yes:
        _confirm_prune(targets, stray)
    try:
        res = lcsvc.prune(confirm=True, orphans=orphans, force=force,
                          only=targets, emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    # BOTH lists, because a sweep that removed only namespaces used to report
    # "Nothing to prune." while deleting them and their PersistentVolumeClaims -- the
    # irreversible half of this command, reported as the no-op half. `removed` is
    # local records; `orphans` is namespaces no local record explained, which is the
    # normal case for the situation --orphans exists for.
    _render_prune_result(res)


def start(name: str = typer.Option("", "--name", "-n")) -> None:
    """Resume a stopped repro (fast, no rebuild)."""
    target = _resolve_name(name)
    try:
        lcsvc.set_state(target, "start", emit=_cli_emit)
    except errors.ReproError as exc:
        # Keeps the recreate hint AND the class's code: `stop` and `restart` exit 3
        # for this exact condition, and `start` exiting 1 made the same failure
        # answer differently depending on which verb you reached for.
        ui.die(f"could not start {target!r} — if it was `down`ed, use "
               "`houston up` to recreate it", exit_code=exc.exit_code)
    ui.ok(f"✓ {target!r} started.")


def stop(name: str = typer.Option("", "--name", "-n")) -> None:
    """Pause a repro, keeping its containers and data."""
    target = _resolve_name(name)
    try:
        lcsvc.set_state(target, "stop", emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    ui.ok(f"✓ {target!r} stopped (resume with `houston start`).")


def restart(name: str = typer.Option("", "--name", "-n")) -> None:
    """Restart a repro."""
    target = _resolve_name(name)
    try:
        lcsvc.set_state(target, "restart", emit=_cli_emit)
    except errors.ReproError as exc:
        _fail(exc)
    ui.ok(f"✓ {target!r} restarted.")
