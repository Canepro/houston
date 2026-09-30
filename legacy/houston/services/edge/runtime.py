"""runtime -- see the package docstring."""
from __future__ import annotations

from houston import exec as subprocess
from pathlib import Path
from houston import runner, tls
from houston.errors import ConflictError, ReproError, ValidationError

from houston.services.edge import acme
from houston.services.edge import engine
from houston.services.edge import networks
from houston.services.edge import paths
from houston.services.edge import routes as edge_routes
from houston.services.edge import spec as edge_spec
from houston.services.edge.paths import PROJECT
from houston.services.edge.types import Edge, StartResult

def adopt(name: str) -> dict:
    """Move a workspace that runs its OWN Traefik onto the edge, without
    recreating it.

    Four steps, none of which stops Rocket.Chat or MongoDB:

      1. remove ONLY the workspace's traefik container -- this is what frees 443
      2. attach the edge to the workspace's network, live
      3. write the route
      4. rewrite the compose file so a future `up` matches reality

    Step 4 is a file write and is NOT applied: compose files take effect on the
    next `up`, so nothing restarts now. That is the difference from the first
    version, which called `up` here and therefore recreated every container --
    minutes of downtime per workspace, and a rebuild is where an incompatibility
    or a lost volume would come from. Twenty workspaces is now twenty seconds.
    """
    from houston import compose as compose_mod
    from houston import tls as tlsmod

    meta = runner.read_meta(name)
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    host = (meta.public_url or "").split("://", 1)[-1].split("/", 1)[0]
    if extra.get("tls") != tlsmod.MODE_ACME or not host:
        raise ValidationError(
            f"{name!r} is not a --domain workspace, so there is nothing to move "
            "onto the edge")

    # 1. Its Traefik, and only its Traefik. `docker rm -f` on one container leaves
    #    every other service in the project running.
    engine._docker("rm", "-f", networks.backend_container(name, tlsmod.SERVICE))

    # 2. Live attach -- no restart of anything. Only if the edge exists yet:
    #    adoption usually runs BEFORE it starts, because freeing 443 is the whole
    #    reason it could not. reattach_all() picks these up after the start.
    if engine.running():
        networks.attach(name)

    # 3 + 4.
    instances = extra.get("instances") if isinstance(extra.get("instances"), int) else 1
    doc = runner.read_compose(name)
    doc.get("services", {}).pop(tlsmod.SERVICE, None)
    extra = dict(extra)
    extra["edge"] = True
    # It no longer publishes 443, and leaving the claim would make every later
    # workspace allocate around a port this one does not hold.
    extra["tls_ports"] = []
    meta.extra = extra
    runner.write(name, compose_mod.to_yaml(doc), meta)
    edge_routes.register(name, host, instances=instances)
    return {"name": name, "host": host}

def systemd_unit(exec_start: str, user: str) -> str:
    """The unit that keeps `houston serve` up (design §3.2).

    Printed for the operator to install, never written by houston: writing it
    needs root, and a tool that edits /etc/systemd on your behalf is a bigger
    thing to trust than one that shows you the file. It also keeps this testable
    as a pure string, with no privileged CI.

    `Restart=always` is only safe BECAUSE named accounts exist: with the old
    session token every restart minted a new one and killed every bookmark.
    """
    return (
        "[Unit]\n"
        "Description=houston GUI\n"
        "After=docker.service\n"
        "Requires=docker.service\n"
        "\n"
        "[Service]\n"
        f"User={user}\n"
        f"ExecStart={exec_start}\n"
        "Restart=always\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )

def _why(res: subprocess.CompletedProcess, limit: int = 500) -> str:
    """The line that explains a docker failure, not the first 500 characters of noise.

    Same rule as `k8s.why`, and for the same reason: compose puts its diagnostics FIRST
    and its error LAST, so taking a prefix reliably shows the least useful part.
    """
    text = "\n".join(t for t in ((res.stderr or ""), (res.stdout or "")) if t)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for ln in reversed(lines):
        low = ln.lower()
        if low.startswith("error") or "error:" in low or "cannot" in low:
            return ln[:limit]
    return (lines[-1][:limit] if lines else "docker said nothing")

def _prepare_edge(acme_email: str, acme_staging: bool) -> None:
    """Repair stale GUI state and materialise the requested edge configuration.

    `acme_email` MATTERS. A bare edge declares no
    resolver -- right for `up --https`, which only ever serves local-CA names --
    and a `--domain` workspace registered against it produced routes Traefik
    rejected with "Router uses a nonexistent certificate resolver: le", so the
    name 404'd while looking perfectly configured from the outside. The first
    workspace that needs Let's Encrypt therefore teaches the edge how to ask.
    """
    # Repair a GUI route left by an older houston. That version wrote one even
    # with no domain, producing `Host(``)` -- which Traefik rejects at every
    # reload with "empty args for matcher Host", plus a certResolver a bare edge
    # never declares. Not writing it any more does nothing for the edges that
    # already have it, and nobody would think to look in a generated directory.
    gui = paths.route_path("_gui")
    if not edge_spec.served_domain() and gui.exists():
        gui.unlink(missing_ok=True)

    want_acme = bool(acme_email)
    if not edge_spec.installed():
        edge_spec.write(Edge(acme_email=acme_email, acme_staging=acme_staging)
              if want_acme else Edge())
    elif want_acme and not acme.has_acme():
        # Upgrade in place: keep whatever domain `serve` gave it, add the resolver.
        edge_spec.write(Edge.resolve(edge_spec.served_domain(), acme_email,
                           acme_staging=acme_staging))
        engine.down()                 # so the new flags are actually applied
    # A container of ours that is UP but holds no ports cannot be repaired by the
    # `compose up -d` below: its resolved configuration has not changed, so compose
    # leaves it exactly as it is and reports success. Remove it first, so what follows
    # is a real attempt that either takes the ports or fails naming whoever has them.
    stalled = engine.our_container()
    if stalled and not engine.publishes_ports(stalled):
        engine.down()


def _adopt_legacy_port_holders() -> None:
    """Move every compatible pre-edge workspace off the shared HTTPS port."""
    # Workspaces from before the edge run their own Traefik on 443, which is
    # exactly why the edge cannot start. Moving them across is now instant and
    # touches no data, so it happens automatically rather than behind a flag --
    # the flag existed when doing this meant recreating every container, and
    # asking permission for something expensive is very different from asking
    # permission for removing one proxy container.
    for held in engine.holders_of_443():
        try:
            adopt(held)
        except (ReproError, OSError):
            # One workspace that will not move must not stop the others, or the
            # edge. Whatever still holds the port is named by port_holder().
            continue


def ensure_running(acme_email: str = "", acme_staging: bool = False) -> "StartResult":
    """Start the edge lazily, on the first route that needs it.

    Never at install and never on plain `serve`: a laptop that never asks for a
    name never learns this exists. Workspace and GUI HTTPS remain unrelated.
    """
    _prepare_edge(acme_email, acme_staging)

    if engine.running():
        # RUNNING IS NOT UP TO DATE. This returned True here, and the caller had already
        # rewritten the compose file -- `serve --domain X --email Y` calls `write(door)`
        # first -- so a changed resolver email, a changed domain or any new flag was
        # written to disk and never applied. The container kept the command line it was
        # created with, `serve` reported success, and nothing said the two disagreed.
        # Found on a box whose `acme.json` held an account for a MIStyped address while
        # the corrected one was being passed on every restart.
        #
        # `docker compose up -d` is the right instrument: it is idempotent and recreates
        # the container ONLY if the resolved configuration changed, so this costs one
        # compose call when nothing has and does the necessary thing when something has.
        # The adoption loop below is skipped -- nothing else can be holding :443 while
        # this edge has it.
        res = up(pull=False)
        return (StartResult(True) if res.returncode == 0
                else StartResult(False, _why(res)))
    _adopt_legacy_port_holders()
    res = up(pull=False)
    if res.returncode == 0:
        return StartResult(True)
    return StartResult(False, _why(res))

def up(*, pull: bool = True) -> subprocess.CompletedProcess:
    """Start the edge, and return what docker said. No network to create: it joins
    each workspace's own.

    Returns the CompletedProcess rather than its return code, because the return code
    was all the callers ever got and a failed start is precisely the moment the output
    matters -- see `StartResult`.
    """
    other = engine.foreign_edge()
    if other:
        # Refuse rather than replace. `compose up` would happily take the other
        # home's container, and the first anyone would know is every one of its
        # names going dark.
        raise ConflictError(
            "another houston edge is already running on this machine, from a "
            f"different home:\n    {other}\n"
            "  Starting this one would REPLACE it and take down every https name "
            "it serves.\n"
            "  houston is designed around one shared home per box — set "
            "HOUSTON_HOME to the same\n"
            "  directory as the other user, or stop that edge first:\n"
            f"    HOUSTON_HOME={Path(other).parent} houston edge stop")
    if pull:
        engine._compose("pull")            # non-fatal, exactly as runner.up does it
    res = engine._compose("up", "-d", "--remove-orphans")
    if res.returncode == 0:
        # Every start, not just the first: a recreated container has none of its
        # previous attachments, and the route files that outlived it would then
        # all answer 502.
        edge_routes.reattach_all()
    return res

def _validate_host_deletion(host: str, confirm: bool) -> tuple[str, list[str]]:
    """Validate a destructive hostname request and return its claimed routes."""
    host = (host or "").strip().rstrip(".")
    if not host:
        raise ValidationError("name a hostname to delete: `houston edge delete "
                              "<host>`. `houston edge status` lists them.")
    gui = edge_spec.served_domain()
    if gui and gui.casefold() == host.casefold():
        raise ConflictError(
            f"{host} is the GUI's own name, so deleting it would take `houston "
            f"serve` off HTTPS while you are probably using it. Stop the edge "
            f"(`houston edge stop`) if that is really what you want.")
    routes = edge_routes.routes_for(host)
    live = [n for n in routes if runner.exists(n)]
    if live:
        raise ConflictError(
            f"{host} still belongs to workspace {', '.join(live)!r} — deleting its "
            f"certificate would leave a workspace that cannot serve its own name. "
            f"`houston down --name {live[0]} --volumes` first, then delete the "
            f"name.")
    if not confirm:
        raise ValidationError(
            f"deleting {host} removes its certificate and PRIVATE KEY and cannot be "
            f"undone - pass confirm=true")
    return host, routes


def _delete_host_files(host: str, routes: list[str]) -> tuple[list[str], bool, bool, list[str]]:
    """Delete route, certificate, declaration, and ACME state for one hostname."""
    # Passthrough first: the answer for a Kubernetes name is genuinely different,
    # and saying "certificate removed" about one that was never here would be a lie
    # in the shape this codebase keeps finding -- reporting the attempt as the outcome.
    through = [n for n in routes if edge_routes.is_passthrough(n)]
    for name in routes:
        edge_routes.deregister(name)
    crt, key = paths.certs_dir() / f"{host}.crt", paths.certs_dir() / f"{host}.key"
    had_cert = crt.is_file() or key.is_file()
    crt.unlink(missing_ok=True)
    key.unlink(missing_ok=True)
    decl = paths.dynamic_dir() / f"_cert-{host}.yml"
    had_decl = decl.is_file()
    decl.unlink(missing_ok=True)
    return through, had_cert, had_decl, acme.forget_acme(host)


def _restart_after_acme_delete(stores: list[str], restart: bool) -> tuple[str, bool | None]:
    """Refresh our edge's in-memory ACME store, or identify a foreign edge."""
    foreign, restarted = "", None
    if stores and restart:
        if engine.running():
            restarted = engine.down() == 0 and up(pull=False).returncode == 0
        else:
            foreign = engine.foreign_edge()
    return foreign, restarted


def delete_host(host: str, *, confirm: bool = False, restart: bool = True) -> dict:
    """Forget `host` entirely: its routes, certificate, key, and ACME entry.

    Returns what actually went, per kind, so the caller reports the deletion it made
    instead of the one it attempted.

    Three refusals, and each one is a case where deleting would break something the
    caller can still see:

    * a LIVE workspace still claims the name -- `down` it first, named in the error.
      A route whose workspace record is gone is the orphan this command exists for,
      so that one proceeds.
    * the name is the GUI's own -- deleting it takes `serve` off the network the
      operator is most likely using to run this.
    * `confirm` is not set. A private key is not recoverable and this is the only
      gate; `--yes` on the CLI, an explicit body field in the GUI.

    `restart` is the part that is easy to get wrong. Traefik holds its ACME store in
    memory and persists the whole file when a certificate changes, so an edit made
    underneath a running Traefik can be written back from memory later -- the entry
    reappears, hours after a command said it was deleted. Restarting rebuilds that
    memory from the edited file. Routes are files, so every other name comes back
    with no re-registration; that property is why a restart is affordable here.
    """
    host, routes = _validate_host_deletion(host, confirm)
    through, had_cert, had_decl, stores = _delete_host_files(host, routes)
    # Docker is asked ONLY for an ACME deletion. A route or a local certificate is
    # read from disk every time, so removing the file is already in effect; making a
    # file deletion depend on a daemon to decide it need not restart would be a cost
    # with nothing bought.
    #
    # `running()` is HOME-AWARE -- it matches the compose project label AND the
    # working directory -- so `down()` here cannot reach an edge belonging to a
    # different HOUSTON_HOME, which every home naming its project `houston_edge`
    # would otherwise make trivially possible. That is not a hypothetical: doing it
    # by hand cost this box's owner their edge once, following an error message that
    # did not know about it either.
    #
    # Which leaves the case worth REPORTING rather than guarding: ours is not
    # running and somebody else's is. A foreign edge mounts its own home's ACME
    # store, so the certificate just deleted was this home's copy and NOT the one
    # being served -- and a plain "removed" would read as a name that stopped
    # resolving.
    foreign, restarted = _restart_after_acme_delete(stores, restart)
    return {
        "host": host,
        "routes": routes,
        "passthrough": through,
        "certificate": had_cert,
        "declaration": had_decl,
        "acme": stores,
        "restarted": restarted,
        "foreign": foreign,
        "kept": ["acme/" + tls.ISSUED_FILE] if tls.issued_path().is_file() else [],
    }

def logs(*, tail: int = 200, follow: bool = False) -> int:
    """Stream or dump the edge's own log, and return the exit code.

    The edge is where HTTPS actually succeeds or fails, and until now there was no way
    to read it from houston: `edge` offered status/start/stop/restart, so the answer to
    "my name serves nothing" lived in a container whose name you had to know. Asked
    verbatim by someone whose https name would not come up -- "where are the default
    logs for it?".

    It matters most for ACME. Traefik requests certificates in the BACKGROUND after it
    starts, so a name can be routed, the edge can be healthy, and issuance can still be
    failing -- and the only record of why is here:

        "unable to obtain ACME certificate for domains ... error presenting token"

    Not captured: this inherits stdout so `-f` behaves like `docker compose logs -f`,
    which is the point of it.
    """
    argv = ["logs", f"--tail={tail}"]
    if follow:
        argv.append("-f")
    # Same seam, same contract: an absent `edge/` must not be a traceback. Not
    # reachable from the CLI, which guards on `installed()` first, and hardened anyway
    # -- a seam that raises for one caller raises for the next one.
    try:
        return subprocess.run(["docker", "compose", "-p", PROJECT, *argv],
                              cwd=paths.edge_dir(), text=True).returncode
    except (OSError, subprocess.SubprocessError):
        return 127

def status() -> dict:
    """What `doctor` and the GUI report."""
    return {
        "installed": edge_spec.installed(),
        "running": engine.running(),
        "routes": edge_routes.registered(),
        # Which workspace networks it is currently joined to. A route with no
        # attachment is a 502 rather than an error, so the two belong side by side.
        "attached": sorted(networks.attached_networks()),
    }
