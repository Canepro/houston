"""Creating a workspace on Docker Compose, and the front door both runtimes come in by.

Tier 5. `create_repro` takes the lock and dispatches; `_create_repro_locked` is the
Compose path, and it is a PLAN plus a sequence of named steps rather than one function.

It was 503 lines at cyclomatic complexity 99, and the cost was not aesthetic: the order
of those lines is load-bearing in about a dozen places, every one of them recorded in a
comment saying what broke when it was somewhere else -- the runtime read before
`resolve_axes` normalises it, the Kubernetes refusal above `_resolve_tls`, the capacity
check before any docker work, the foreign-edge preflight before anything is written, the
edge attach after `compose up`. A reader cannot hold 503 lines in mind well enough to
notice when one of those moves. Each step now names what it does, and the order is
visible in one screen at the bottom of this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from houston import compose, config, presets, runner, versions
from houston.errors import (ConflictError, DockerError, PreflightError,
                            ValidationError)
from houston.services import audit as auditsvc
from houston.services import diagnose, topology
from houston.services import edge as edgesvc
from houston.services.events import Emit, info, null_emit, warn
from houston.services.lifecycle import (create_k8s, inspect, naming, ownership, ports,
                                        preconditions, ready, request, seeding,
                                        sizing, tlsplan)
from houston.services.lifecycle.types import _BROWSER_HOST_PARAM, _LOOPBACK_BINDS, CreateReq

@dataclass
class CreatePlan:
    """What one Compose create knows, in the order it comes to know it.

    Every field is filled by exactly one step and read by the ones after it, so the
    sequence at the bottom of this module IS the data flow -- there is no hidden channel
    between steps. The defaults are not meaningful values; they exist so a step can be
    called in a test without constructing the twenty fields it does not look at.
    """

    req: CreateReq
    emit: Emit
    stream_output: bool = False
    monitor_attach: object = request._missing_monitor_attach
    #: `_resolve_pairing`
    cfg: dict = field(default_factory=dict)
    resolved: object = None
    #: `_load_preset`
    pre: object = None
    wait: bool = False
    #: `_settle_name`
    repro_name: str = ""
    #: `_claim_ports`
    host_port: int = 0
    root: str = ""
    token: str = ""
    bind_host: str = ""
    tlsspec: object = None
    #: `_warn_about_the_browser_host`
    public: str = ""
    #: `_build_document`
    env_overrides: dict = field(default_factory=dict)
    admin_password: str = ""
    spec: object = None
    doc: dict = field(default_factory=dict)
    #: `_build_record`
    meta: object = None
    #: `_prepare_edge`, then `_attach_monitoring`
    files: list = field(default_factory=list)




def _clear_the_unfinished_note(req: CreateReq, name: str, note) -> None:
    """EVERY note for this workspace, not just the one just written.

    An earlier create that failed left its own, and clearing only ours left that one
    claiming a finished workspace had never finished.

    UNLESS THE CALLER STILL HAS WORK TO DO. With `seed_here` the CLI runs the seed after
    the create returns, so clearing here would delete the note in the window it exists
    for -- a kill between those two points leaves a workspace serving with no seed and
    nothing recording it. `cli.up` clears it once the seed is done.
    """
    from houston.services import journal

    if not req.seed_here:
        journal.clear(note)
        journal.clear_kind(journal.CREATE_UNFINISHED, naming._derive_for(req) or name)


def _create_under_the_lock(req: CreateReq, name: str, emit: Emit, *,
                           stream_output: bool, monitor_attach) -> dict:
    """The create itself, plus the write-ahead note that says it may not have finished.

    A CREATE THAT NEVER FINISHES LEAVES A WORKSPACE THAT LOOKS FINE. Measured by killing
    one mid-flight: `docker compose up -d` has already detached, so the containers come
    up on their own and `list` reports it `running` -- which is true. What is lost is
    everything after readiness: the preset's self-configuration, the seed, the edge
    route. So a `saml` workspace can be serving with no IdP certificate and nothing
    anywhere says the create stopped early.

    Advisory rather than repaired automatically: finishing it means waiting for
    Rocket.Chat to serve and then running post_ready, which can take the full readiness
    timeout, and `serve`'s startup must not hold the GUI shut for that. `houston ready
    --name <it>` is the same work on demand and clears this note.

    Separated from `create_repro` so the note's lifecycle -- written before the work,
    cleared after it, and NOT cleared by a refusal that created nothing -- reads in one
    place. It is the part that was got wrong three times.
    """
    with runner.repro_lock(name):
        from houston.services import journal
        # WHAT THE NOTE HAS TO CARRY. `ready` is the command the note tells people to
        # run, and it could not finish a seed because the request that asked for one
        # died with the process -- `req.seed` lives in a CreateReq nobody can read any
        # more, and meta.extra["seed"] is written only AFTER a seed succeeds. So the
        # note said "may be running without its preset configuration or seed data",
        # `ready` ran post_ready, seeded nothing, printed "ready" and CLEARED the note.
        # That is worse than leaving it: the engineer follows the tool's own
        # instruction, is told the workspace is complete, doctor agrees, and the
        # evidence that anything was missing has been deleted.
        detail = dict(seed=bool(req.seed), seed_here=bool(req.seed_here),
                      seed_profile=str(req.seed_profile or ""), seed_stats=bool(req.stats))
        note = journal.record(journal.CREATE_UNFINISHED, name, **detail)
        try:
            out = _create_repro_locked(req, emit, stream_output=stream_output, monitor_attach=monitor_attach)
        except BaseException:
            # A REFUSAL CREATED NOTHING, so it must leave nothing. Without this the
            # note survived every kind of refusal -- a bad version, a taken port, a
            # capacity preflight, a namespace-ownership check, a Kubernetes-unsupported
            # flag -- one per attempt, and `doctor` then warned about a workspace that
            # does not exist while telling the reader to run `houston ready` on it,
            # which exits 4. The write-ahead note is for a create that died HALF WAY,
            # which is a different thing from one that never started.
            journal.clear(note)
            raise
        # RE-KEYED TO THE WORKSPACE THAT EXISTS. The note is recorded under the name
        # derived BEFORE `resolve_axes` ran, and `--deployment multi-instance` without a
        # `--name` renames the workspace on the way (`rc8-5-1` becomes
        # `rc8-5-1-multi-instance`). With `seed_here` the note is the CALLER's to close,
        # and `cli.up` closes it by the name it was handed back -- so the one under the
        # old name was never cleared, and `doctor` reported an unfinished create for a
        # workspace that does not exist (P21, g1-09). Moved rather than dropped: until
        # the caller's seed lands, a kill must still leave a note, for the right name.
        created = str(out.get("name") or name)
        if req.seed_here and created != name:
            journal.clear(note)
            note = journal.record(journal.CREATE_UNFINISHED, created, **detail)
        _clear_the_unfinished_note(req, name, note)
        return out


def create_repro(req: CreateReq, emit: Emit = null_emit, *, stream_output: bool = False,
                 monitor_attach=request._missing_monitor_attach) -> dict:
    """Create-or-reuse a repro. Returns a result dict (meta + boot/seed info).

    `stream_output=True` streams docker's line output through `emit` (for the web
    job log); False leaves docker's own progress on the terminal (CLI default).
    Serialised per repro, like every other mutating operation: `up --force` racing
    a backup or an env change makes compose reconcile against itself. The name is
    derived here rather than inside, because the lock needs it before any work
    starts -- it depends only on the request, so it is cheap to compute twice.
    """
    # ONCE, HERE, before anything reads it. `runtime` is consulted at a dozen places
    # downstream and inferring it at each would be a dozen chances to disagree; this
    # is the entry point every create comes through, and after it `req.runtime` means
    # what the caller meant rather than only what they typed.
    typed_runtime = str(getattr(req, "runtime", "") or "").strip()
    req.runtime = request.infer_runtime(req)
    request._say_where_this_is_going(req, typed_runtime, emit)

    name = naming._derive_for(req)
    if not name:
        raise ValidationError(
            f"name {req.name!r} contains no usable characters (want a-z, 0-9, '-')")
    naming._require_valid_name(name)
    return _create_under_the_lock(
        req, name, emit, stream_output=stream_output,
        monitor_attach=monitor_attach)


def _reuse(name: str, wait: bool, req: CreateReq, emit: Emit, *, stream_output: bool,
           resolved=None, preset_name: str = "") -> dict:
    meta = runner.read_meta(name)
    # An existing repro is reused EXACTLY as recorded. Say so when the request
    # asked for something else: `up --version 9.9.9 --name existing` silently
    # booted the old version, which is fatal for a tool whose whole premise is
    # version matching. (The version check in wait_and_finalize compares RC's
    # reported version against the STORED one, so it stays quiet here.)
    mismatch: list[str] = []
    if resolved is not None and resolved.rc_version != meta.rc_version:
        mismatch.append(f"version {resolved.rc_version} (existing: {meta.rc_version})")
    if preset_name and preset_name != meta.preset:
        mismatch.append(f"preset {preset_name!r} (existing: {meta.preset!r})")
    if req.monitor and not (isinstance(meta.extra, dict) and meta.extra.get("monitoring")):
        mismatch.append("monitoring (existing: not attached)")
    if mismatch:
        msg = (f"{name!r} already exists and is reused as-is, ignoring requested "
               + "; ".join(mismatch)
               + ". Use --force to rebuild it, or --fresh to also wipe its data.")
        warn(emit, msg, phase="create", code="VERSION_IGNORED_ON_REUSE",
             requested=resolved.rc_version, running=meta.rc_version,
             ignored=list(mismatch))
        # AND IN THE ENVELOPE. In prose this is loud; under `--json` it was an NDJSON
        # progress event and the envelope still said `ok: true, warnings: []`. A caller
        # following the documented strategy -- read to end of stream, parse the last
        # line -- saw unqualified success from a tool whose single purpose is running
        # the version you asked for. `data.rc_version` and `data.reused` made it
        # detectable by a careful reader, which is a mitigation, not the contract.
    state = runner.rc_state(name)
    if state == "running":
        info(emit, f"{name!r} is already running.", phase="create")
    else:
        info(emit, f"{name!r} already exists - bringing it back up.", phase="create")
        if ready._up(name, pull=False, emit=emit, stream_output=stream_output) != 0:
            raise DockerError("`docker compose up` failed")
    # A reused workspace gets its https name back. This path never resolved TLS --
    # it reuses the record as-is -- so after a `down`, `up` printed
    # "URL https://…" from that record while the name served nothing at all: the
    # route was removed by the teardown and never rewritten. Cheap to put right
    # now that a name is a file rather than a Traefik of its own.
    ready._restore_route(meta, emit)

    result = inspect._summary(meta)
    result["reused"] = True
    result["waited"] = wait
    if wait:
        result.update(ready.wait_and_finalize(meta, emit))
    # NOT when the caller seeds. `seed_here` means the CLI runs it after this returns,
    # so seeding here as well would seed the workspace twice -- the manifest only ever
    # adds, so the readback would report rooms holding more than planned and the second
    # pass would collide on names it had just created.
    if req.seed and not req.seed_here:
        result["seed"] = seeding.run_seed_inline(meta, req.seed_profile, req.stats, emit)
    return result


def _resolve_axes(plan: CreatePlan) -> None:
    """Runtime x deployment x scenario, decided before anything else reads the request."""
    # An existing workspace's RECORDED runtime beats the flag default. Without this,
    # `houston up -v 8.5.1 --name X` on a Kubernetes workspace defaulted to docker
    # and ran `docker compose up` against a workspace with no compose file:
    #
    #     'rc8-5-1' already exists - bringing it back up.
    #     no configuration file provided: not found
    #     error: `docker compose up` failed
    #
    # The flag says what to CREATE. What already exists is a fact, not a preference,
    # and `--runtime` is only consulted when there is nothing to consult instead.
    # Read BEFORE resolve_axes: it normalises an empty --runtime to "docker",
    # after which `not req.runtime` is never true and this could not fire.
    existing = naming._derive_for(plan.req)
    if not plan.req.runtime and existing and runner.exists(existing):
        plan.req.runtime = topology.of_repro(existing)
    # Runtime x deployment x scenario, decided before anything else looks at the
    # request. The resolved axes are written BACK onto `req` as a preset name and
    # `--set` params, so every reader below -- name derivation, the preset loader,
    # capacity, repro.json -- is untouched and `--deployment multi-instance
    # --replicas 3` reaches compose.build by the exact path `--preset
    # multi-instance --set instances=3` always did.
    axes = topology.resolve_axes(runtime=plan.req.runtime, deployment=plan.req.deployment,
                                 replicas=plan.req.replicas, preset=plan.req.preset,
                                 params=plan.req.params)
    topology.require_registered(axes.runtime)
    for hint in axes.hints:
        info(plan.emit, hint, phase="plan")
    plan.req.preset, plan.req.params = axes.preset, axes.params
    plan.req.runtime, plan.req.deployment, plan.req.replicas = (axes.runtime, axes.deployment,
                                                 axes.replicas)
    # ABOVE THE RUNTIME DISPATCH, deliberately, and this is why: it started life
    # below it, so `--root-url` derived an IdP host on Compose and derived nothing at
    # all on Kubernetes -- the same defect it was written to fix, surviving in the
    # runtime that was not being tested. Both runtimes resolve the preset from
    # `req.params`, so one call site above the fork covers both by construction.
    #
    # The IdP presets bake a browser-facing hostname into Rocket.Chat's settings and
    # their default names THIS machine. `--root-url` and `--domain` are the caller
    # telling us the address the browser will use, so use it rather than shipping a
    # workspace whose SSO points somewhere the browser has never heard of.
    request._derive_idp_host(plan.req, plan.emit)


def _resolve_pairing(plan: CreatePlan) -> None:
    """Which Rocket.Chat and which MongoDB, and whether this engine can run the pair."""
    preconditions.require_docker()
    plan.cfg = config.load_config()

    try:
        plan.resolved = versions.resolve(plan.req.version, offline=plan.req.offline)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    # SAID BEFORE THE BUILD, not discovered after it. `resolve()` already knows when
    # releases.rocket.chat answered 404 -- it stamps `source` -- and the create path
    # ignored it, so `up --version 99.99.99` built the whole compose document, created
    # containers and failed at the pull with docker's own "not found", ~90 seconds
    # later, leaving a workspace to clean up. The fact was available the whole time.
    #
    # A WARNING rather than a refusal, deliberately: the shipped map can still pair a
    # version the live index has never heard of -- a fresh release, an internal build
    # with `--rc-image` -- and refusing would break those. This only makes sure the
    # reader is told before they wait.
    if getattr(plan.resolved, "source", "") == "map (no such release)":
        warn(plan.emit, f"releases.rocket.chat has no {plan.req.version} — the pairing below "
                   f"comes from the shipped map, and the image pull will fail unless "
                   f"this tag really exists (`houston versions {plan.req.version}`).",
             phase="resolve")
    if plan.req.rc_image or plan.cfg.get("rc_image"):
        plan.resolved.rc_image = plan.req.rc_image or plan.cfg["rc_image"]
    if plan.req.mongo:
        versions.apply_mongo_override(plan.resolved, plan.req.mongo)

    # Before any docker work: this pairing cannot boot on this engine, and mongod
    # says so by exiting with a message that reads like a permission fault. `doctor`
    # has known the rule for a while and could only warn, because it does not know
    # which version you are about to ask for; here the pairing is resolved, so the
    # answer is exact. The rule is a leaf; this caller supplies the engine probe.
    from houston.services import mongo_kernel
    conflict = mongo_kernel.mongo_kernel_conflict(plan.resolved.mongo_tag, runner.docker_kernel_version())
    if conflict:
        raise PreflightError(conflict)


def _load_preset(plan: CreatePlan) -> None:
    """The preset, its parameters, and whether this create has to wait for readiness."""

    try:
        plan.pre = presets.load(plan.req.preset, plan.req.params)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    unknown = request._unknown_params(plan.req.params, plan.pre)
    if unknown:
        valid = ", ".join(sorted(plan.pre.params_help)) or "(this preset takes no --set params)"
        raise ValidationError(
            f"unknown --set param(s) for preset {plan.req.preset!r}: {', '.join(unknown)} - valid: {valid}")

    plan.wait = plan.req.wait or bool(plan.pre.post_ready) or plan.req.seed


def _settle_name(plan: CreatePlan) -> None:
    """The workspace's name, and every refusal that depends on having one."""
    plan.repro_name = naming._derive_for(plan.req)
    naming._warn_name_coerced(plan.req, plan.emit)
    # Before any docker work, and only for a workspace that does not exist yet:
    # `up` on an existing one reuses its containers and adds nothing.
    # `--force` is NOT a reason to skip this. sizing.check_capacity() has its own force
    # branch that warns loudly and proceeds -- written, per its comment, because
    # "this is the guard that exists after an OOM took out a 10 GB host: overriding
    # it has to stay visible". Excluding force HERE made that branch unreachable for
    # a new workspace, so the loud override became a silent one: the function was
    # never called at all. The caller is what turned the warning off.
    if not runner.exists(naming._derive_for(plan.req)):
        sizing.check_capacity(plan.req, plan.req.preset, plan.emit)
    if not plan.repro_name:
        raise ValidationError(f"name {plan.req.name!r} contains no usable characters (want a-z, 0-9, '-')")
    # sanitize() fixes the CHARACTERS but not the length, and the first thing below
    # is a stat on the derived path -- which raises ENAMETOOLONG rather than
    # returning False for an over-long name.
    naming._require_valid_name(plan.repro_name)
    if plan.req.port and not (1024 <= plan.req.port <= 65535):
        raise ValidationError(f"--port {plan.req.port} is out of range (want 1024-65535)")


def _claim_ports(plan: CreatePlan) -> None:
    """The host port, the URL houston will call itself by, and the TLS plan."""

    preconditions._guard_project_collision(plan.repro_name)
    ports.check_sidecar_ports(plan.pre, exclude=plan.repro_name)
    if plan.req.monitor:
        ports.check_monitor_ports(exclude=plan.repro_name)
    plan.host_port = ports.pick_host_port(plan.req.port, plan.pre, exclude=plan.repro_name)
    # ALWAYS the published local port, never an override. `--root-url` says what
    # Rocket.Chat should ADVERTISE, and it still does that through the compose spec
    # below -- but `root` is what houston calls itself, and runner.Metadata's own
    # docstring makes that a contract: root_url "stays the plain
    # http://localhost:<port> that houston's own API calls (login, PAT, seeding,
    # load tests) use".
    #
    # Letting the override through broke that contract, and readiness is where it
    # showed: `ready` polls meta.root_url, so a workspace whose root_url held a
    # public https name reported "Rocket.Chat did not become ready within 300s"
    # while /api/info on the local port answered 200 the whole time. Reproduced with
    # `up --root-url https://lab.example.com`: still booting at 127s, 200 locally.
    # Nothing about readiness should depend on DNS, a certificate, or the edge.
    plan.root = f"http://localhost:{plan.host_port}"
    plan.token = plan.req.reg_token or plan.cfg.get("reg_token") or ""
    plan.bind_host = request._requested_bind_host(plan.req)
    plan.tlsspec = tlsplan._resolve_tls(plan.req, plan.repro_name, plan.bind_host, exclude=plan.repro_name, emit=plan.emit)


def _warn_about_the_bind(plan: CreatePlan) -> None:
    """What publishing this workspace off loopback exposes, said once, at create time."""
    if plan.req.bind_public and plan.bind_host not in ("0.0.0.0", "::"):
        # Derived from the challenge (see _resolve_tls), not requested.
        plan.bind_host = "0.0.0.0"
        warn(plan.emit, f"binding 0.0.0.0 so Let's Encrypt can reach this host for the "
                   f"{plan.req.acme_challenge} challenge - that exposes the workspace, and "
                   "it runs the fixed admin/admin123 credentials. `houston down` when "
                   "you are finished.", phase="tls")
    elif plan.bind_host not in _LOOPBACK_BINDS:
        # THE SAME EXPOSURE, ASKED FOR RATHER THAN DERIVED, AND IT WAS SILENT. The
        # warning above fires only when houston widened the bind ITSELF for an ACME
        # challenge; `up --bind 0.0.0.0` typed by hand got the normal panel, a URL
        # reading `http://localhost:<port>`, and nothing else. Verified from the box's
        # own LAN address: /api/info 200, and POST /api/v1/login with admin/admin123
        # returning a full admin authToken.
        #
        # `config.DEFAULT_BIND_HOST`'s comment states this threat model exactly, and
        # `errors.GATE_PUBLIC_EXPOSURE` was declared for it. The opt-in is deliberate
        # and stays; being quiet about it was not a decision, it was an omission.
        #
        # The SIDE SERVICES travel with it and are the part people do not picture: a
        # Mailpit inbox holding every 2FA code and reset link the workspace issues,
        # Keycloak, MinIO, phpLDAPadmin, and with --monitor a Grafana on admin/admin
        # with anonymous view enabled. Seeded users are worse than the admin -- their
        # password IS their username.
        _side = ", ".join(
            f"{svc}:{config.PRESET_PORTS[svc][0]}"
            for svc in ([plan.req.preset] if plan.req.preset in config.PRESET_PORTS else []))
        # WHAT THE PANEL DOES NOT ALREADY SAY, and nothing else. The Rocket.Chat
        # admin is generated for a workspace bound this wide and printed two lines
        # below, so repeating it here -- as this used to -- is a sentence people
        # learn to scroll past, which costs the next warning its reader. What is
        # left is the part that is still weak and still fixed: the preset's own
        # UIs, Grafana, and seeded users.
        _weak = ([f"the {plan.req.preset} UI on {_side}"] if _side else []) \
            + (["Grafana on admin/admin"] if plan.req.monitor else []) \
            + (["seeded users, whose password is their username"] if plan.req.seed else [])
        warn(plan.emit, f"--bind {plan.bind_host} publishes this workspace on every interface"
                   + (f" — and {', '.join(_weak)}" if _weak else "")
                   + ". Only do this on a trusted network.", phase="create")
    # RC advertises the https URL (links, OAuth callbacks, CORS all derive from
    # ROOT_URL); `root` stays http so houston's own API calls need no CA.


def _warn_about_the_browser_host(plan: CreatePlan) -> None:
    """An IdP preset whose own service still names the BROWSER's machine, not this one."""
    plan.public = plan.tlsspec.root_url if plan.tlsspec else ""
    # SAID AT CREATE TIME, because it cannot be discovered afterwards. The IdP presets
    # send the BROWSER to a hostname baked into Rocket.Chat's settings, and the default
    # names this machine -- `localhost:8081` for SAML, `keycloak:8085` for OIDC. A
    # workspace bound wide, or given a public name, is one somebody intends to reach
    # from ELSEWHERE, and from there both of those addresses are the visitor's own
    # laptop: the SAML button bounces off nothing and returns to the login page, and
    # the OIDC popup opens a name that does not resolve and renders blank. That is the
    # entire bug report, and the create said nothing.
    _browser_param = _BROWSER_HOST_PARAM.get(plan.req.preset or "")
    if _browser_param and not (plan.req.params or {}).get(_browser_param):
        # TWO STATES REACH HERE, and both leave this preset's own service addressed as
        # this machine. `_derive_idp_host` fixes only the case where a URL was given
        # AND the bind can carry it; everything else has to be said, because what is
        # wrong is invisible -- SAML returns to the login page, OIDC opens a blank
        # window, presigned previews fail, and none of them logs anything.
        #
        # Two things are wrong in either state, not one: the service the browser is
        # sent TO, and the callback it is sent BACK to (Rocket.Chat's Site_Url). The
        # recipe names both, because half a fix fails at the next step and reads as
        # the same bug not being fixed.
        _default_host = {"saml": "localhost", "oidc": "keycloak",
                         "s3_minio": "minio"}[plan.req.preset]
        _svc_port = config.PRESET_PORTS[plan.req.preset][0]
        _advertised = plan.req.root_url or plan.req.domain
        _why = ""
        if plan.bind_host not in _LOOPBACK_BINDS:
            _why = (f"this {plan.req.preset!r} workspace is bound to {plan.bind_host}, so "
                    f"somebody will open it from another machine")
        elif _advertised:
            # DELIBERATELY NOT DERIVED. Pointing the service at {_advertised} while its
            # port is on loopback would break Rocket.Chat's own access to it as well --
            # measured: a container cannot reach a 127.0.0.1-published port by the
            # host's address. So the bind has to move first, and saying that is the
            # only useful thing to do here.
            _why = (f"this {plan.req.preset!r} workspace advertises {_advertised}, but its "
                    f"ports are published on {plan.bind_host or config.DEFAULT_BIND_HOST} "
                    f"where nothing off this box can reach them")
        if _why:
            warn(plan.emit, f"{_why} — and its own service still points the browser at "
                       f"{_default_host}:{_svc_port}, which names that browser's OWN "
                       f"machine. SAML returns to the login page, OIDC opens a blank "
                       f"window, presigned previews fail. None of them logs an error.",
                 phase="create")
            warn(plan.emit, f"    Both halves have to move. Re-create with:\n"
                       f"      --bind 0.0.0.0 --port {plan.host_port} "
                       f"--root-url http://<host>:{plan.host_port} "
                       f"--set {_browser_param}=<host>\n"
                       f"    where <host> is the name people actually type.",
                 phase="create")

    # Overrides already on this repro are carried forward: `up --force` rebuilds the


def _build_document(plan: CreatePlan) -> None:
    """Carried-forward env, the admin password, and the compose document itself."""
    # compose file from the spec, so without this a rebuild would silently drop env
    # the user had set. Anything named on THIS run wins.
    plan.env_overrides = {}
    if runner.exists(plan.repro_name):
        try:
            prev = runner.read_meta(plan.repro_name).extra.get("env")
            if isinstance(prev, dict):
                plan.env_overrides.update(prev)
        except Exception:  # noqa: BLE001 - half-written record; nothing to carry
            pass
    plan.env_overrides.update(plan.req.env or {})

    # THE ADMIN PASSWORD, decided here because this is where both halves of
    # "reachable from off this box" are finally known. Generated for a public
    # workspace and left empty -- meaning the shared `admin123` -- for a loopback
    # one; `runner.Metadata.admin_pass` reads it back with that same fallback, and
    # every login in the codebase goes through that property.
    #
    # It has to reach the compose document as well as the record: the document is
    # what actually provisions the admin, so a password written only to repro.json
    # would be a stored credential for a login that does not exist.
    plan.admin_password = (config.generate_admin_password()
                      if preconditions.reachable_beyond_loopback(tlsspec=plan.tlsspec,
                                                   bind_host=plan.bind_host) else "")
    plan.spec = compose.Spec.from_resolved(
        plan.resolved, project_name=runner.project_name(plan.repro_name),
        root_url=(plan.req.root_url or plan.public or plan.root),
        host_port=plan.host_port, reg_token=plan.token or None, preset=plan.pre,
        bind_host=plan.bind_host, monitoring=plan.req.monitor, tls=plan.tlsspec,
        env_overrides=plan.env_overrides)
    plan.spec.admin_password = plan.admin_password
    try:
        plan.doc = compose.build(plan.spec)
    except ValueError as exc:
        # e.g. a preset naming an entry_service it doesn't define.
        raise ValidationError(str(exc)) from exc


def _build_record(plan: CreatePlan) -> None:
    """`repro.json`: everything a later command needs that the compose file does not say."""

    plan.meta = runner.Metadata(
        name=plan.repro_name, project=plan.spec.project_name, rc_version=plan.resolved.rc_version,
        rc_image=plan.resolved.rc_image, mongo_tag=plan.resolved.mongo_tag,
        mongo_flavor=plan.resolved.mongo_flavor, preset=plan.pre.name, root_url=plan.root,
        host_port=plan.host_port, version_source=plan.resolved.source, pinned=plan.req.pin,
        public_url=plan.public, admin_password=plan.admin_password,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    # Stamped on every create, compose included, so "absent" keeps meaning exactly
    # one thing: a workspace older than the key. See services/topology.py.
    topology.stamp(plan.meta.extra, plan.req.runtime or topology.DOCKER)
    plan.meta.extra[config.EXTRA_DEPLOYMENT] = plan.req.deployment or topology.MONOLITH
    # Recorded so a reader can be told the truth about reaching this workspace from
    # another machine. It was only ever written INTO the compose port mappings, which
    # meant every caller that wanted to know had to parse the generated file --
    # Kubernetes has recorded it in the metadata since its first workspace.
    plan.meta.extra["bind_host"] = plan.bind_host
    # WHAT ROCKET.CHAT ADVERTISES, when that is not what houston calls it. `root_url`
    # on the record is deliberately the plain loopback URL that houston's own API
    # calls use, and `public_url` is set only by TLS -- so `--root-url http://box:3007`
    # was written into the compose ROOT_URL and recorded nowhere. Anything generated
    # FOR THE BROWSER then got loopback: the livechat preset's demo page substitutes
    # `{{ROOT_URL}}` to load Rocket.Chat's widget script, so on any machine but this
    # one it fetched the script from the visitor's own localhost and the widget never
    # appeared, with nothing logged anywhere.
    if plan.spec.root_url and plan.spec.root_url != plan.root:
        plan.meta.extra["advertised_url"] = plan.spec.root_url
    if plan.pre.post_ready:
        plan.meta.extra["post_ready"] = plan.pre.post_ready
    if plan.pre.notes:
        plan.meta.extra["notes"] = plan.pre.notes
    if plan.pre.instances > 1:
        plan.meta.extra["instances"] = plan.pre.instances
    if plan.pre.extra:
        plan.meta.extra.update(plan.pre.extra)
    if plan.pre.ports:
        plan.meta.extra["sidecar_ports"] = plan.pre.ports
    if plan.env_overrides:
        plan.meta.extra["env"] = plan.env_overrides
    if plan.req.actor:
        # Who owns this. Shown by `list` and the GUI card, so a shared server can
        # say whose workspace this is without guessing from the name prefix.
        plan.meta.extra["created_by"] = plan.req.actor
    if plan.req.params:
        # Recorded so a repro can be rebuilt exactly: `backup` copies these into its
        # manifest, and `restore --new` would otherwise recreate an s3_minio repro
        # with the DEFAULT bucket rather than the one whose data it is loading.
        plan.meta.extra["params"] = dict(plan.req.params)


def _attach_monitoring(plan: CreatePlan) -> None:
    """Prometheus and Grafana, when asked for."""
    if plan.req.monitor:
        from houston import monitoring
        targets = compose.rc_service_names(plan.pre.instances)
        plan.files += monitoring.files(targets, project=plan.spec.project_name)
        plan.meta.extra["monitoring"] = True
        plan.meta.extra["monitoring_ports"] = list(config.MONITOR_PORTS)
        plan.meta.extra.setdefault("notes", [])
        plan.meta.extra["notes"] = list(plan.meta.extra["notes"]) + monitoring.notes()


def _replace_existing(plan: CreatePlan) -> None:
    """Taking down what is already there, and the gate on destroying its data."""

    if runner.exists(plan.repro_name):
        # `--fresh` DELETES THE DATA VOLUME, which is the same irreversible act
        # `down --volumes` is gated on -- and this branch consulted nobody. The gate
        # sat on the two verbs whose NAMES sound destructive rather than on the set
        # that actually is, so a colleague's reproduction state could be wiped by an
        # `up` that reads as "start it again". Checked only for `--fresh`: a plain
        # overwrite recreates containers and leaves the volume alone.
        if plan.req.fresh:
            allowed, why = ownership.may_destroy(plan.repro_name, auditsvc.actor())
            if not allowed:
                auditsvc.record("up-fresh", plan.repro_name, outcome="denied")
                raise ConflictError(why)
        # Volumes the OLD compose file declared but the new one doesn't (switching
        # preset with --force, dropping --monitor) would be orphaned: `down -v`
        # only removes what the file declares, so once it's rewritten nothing can
        # ever reach them again.
        stale: set[str] = set()
        if not plan.req.fresh:
            try:
                stale = set(runner.read_compose(plan.repro_name).get("volumes") or {}) - set(plan.doc["volumes"])
            except Exception:  # noqa: BLE001 - unreadable old file: nothing to reconcile
                stale = set()
        if runner.down(plan.repro_name, volumes=plan.req.fresh) != 0:
            raise DockerError(f"could not tear down the existing {plan.repro_name!r}; not overwriting it")
        for bad in runner.remove_volumes(plan.repro_name, sorted(stale)):
            warn(plan.emit, f"could not remove {bad}, left over from the previous preset",
                 phase="create")


def _start_the_workspace(plan: CreatePlan) -> None:
    """Write the record, then the compose file, then bring it up, then attach the edge."""

    runner.write(plan.repro_name, compose.to_yaml(plan.doc), plan.meta, files=plan.files)
    if plan.req.pin:
        config.update_config(lambda cfg: cfg.__setitem__("default_repro", plan.repro_name))

    info(plan.emit, f"creating {plan.repro_name!r} - RC {plan.resolved.rc_version}, "
               f"Mongo {plan.resolved.mongo_tag} ({plan.resolved.mongo_flavor}), preset {plan.pre.name}",
         phase="create", data={"name": plan.repro_name})

    rc = ready._up(plan.repro_name, pull=not plan.req.no_pull, emit=plan.emit, stream_output=plan.stream_output)
    if rc != 0:
        cause = diagnose.diagnose_failure(plan.repro_name)
        head = f"`docker compose up` failed - {cause}" if cause else "`docker compose up` failed."
        raise DockerError(
            f"{head} Workspace kept for inspection - retry with --force, or discard: "
            f"houston down --name {plan.repro_name} --volumes")

    # AFTER the workspace is up, because attaching needs the network `docker
    # compose up` has only just created. Registering during the build wrote a
    # correct route to a backend the edge could not resolve, so the name answered
    # 502 -- and 502 is not an error anyone sees, it just looks like a broken
    # workspace. Idempotent: register() attaches too, for every later call.
    if plan.tlsspec:
        edgesvc.attach(plan.repro_name)


def _finish(plan: CreatePlan) -> dict:
    """The summary the caller gets back, plus waiting and seeding when asked."""
    result = inspect._summary(plan.meta)
    result["reused"] = False
    result["waited"] = plan.wait
    if plan.wait:
        result.update(ready.wait_and_finalize(plan.meta, plan.emit))
    # NOT when the caller seeds. `seed_here` means the CLI runs it after this returns,
    # so seeding here as well would seed the workspace twice -- the manifest only ever
    # adds, so the readback would report rooms holding more than planned and the second
    # pass would collide on names it had just created.
    if plan.req.seed and not plan.req.seed_here:
        result["seed"] = seeding.run_seed_inline(plan.meta, plan.req.seed_profile, plan.req.stats, plan.emit)
    return result


def _refuse_a_foreign_edge(plan: CreatePlan) -> None:
    """An edge belonging to another HOUSTON_HOME, refused before anything is written."""
    # REFUSED BEFORE ANYTHING IS WRITTEN. `edge.up()` checks `foreign_edge()` -- an
    # edge belonging to a DIFFERENT HOUSTON_HOME, which compose would silently
    # replace because every home keys the project by the same name -- and it did so
    # only after the local CA, the certificate, the route file and the whole edge
    # project had been written. Observed: exit 8 with a correct cross-home message,
    # and left behind edge/spec.json, edge/domain, edge/compose.yml, ca/{ca.crt,
    # ca.key,ca.srl}, edge/certs/<name>.{crt,key} and edge/dynamic/_cert-<name>.yml
    # for a workspace that does not exist. `edge status` then reported "STOPPED"
    # and "every https name on this box is unreachable" -- false, the other home's
    # edge was serving them -- and /api/edge answered installed:true, so the GUI
    # showed a red badge on a box whose edge was running.
    #
    # A preflight, like the namespace and teardown gates: a refusal leaves nothing.
    stolen = edgesvc.foreign_edge()
    if stolen:
        raise ConflictError(
            f"the shared edge on this box belongs to another HOUSTON_HOME "
            f"({stolen}). Starting one from here would REPLACE it and take down "
            f"every https name it serves, because compose keys the project by name "
            f"and both homes use the same one. Use that home, or stop its edge "
            f"first.")


def _issue_certificate(plan: CreatePlan, local: bool) -> None:
    """A local certificate, or the private directory Traefik needs before it mounts it."""
    from houston import tls as tlsmod

    if local:
        info(plan.emit, f"issuing a local certificate for {plan.tlsspec.host}", phase="tls")
        edgesvc.issue_local_cert(plan.tlsspec.host)
    else:
        # Traefik writes acme.json here; it must exist and be private BEFORE
        # the container mounts it, or Traefik refuses to use it.
        tlsmod.acme_dir().mkdir(parents=True, exist_ok=True)
        tlsmod.acme_dir().chmod(0o700)


def _start_the_edge(plan: CreatePlan, local: bool) -> None:
    """Lazily, by the first workspace that needs a name -- never at install or by `serve`."""

    # Started HERE, not in _resolve_tls. Lazily, by the first workspace that
    # needs a name -- not at install, not by `serve`, since whether the GUI has
    # a public hostname is an unrelated question. It has to happen where docker
    # work legitimately happens, though: putting it in _resolve_tls made a
    # resolve function start containers, and the TEST SUITE then started a real
    # edge that held :443 and broke a live run. Caught by running it.
    # The email goes WITH it: an edge started bare by an earlier `--https`
    # declares no resolver, and a --domain route naming one it does not have
    # is rejected at load, so the name 404s while looking correct outside.
    if not edgesvc.running() or (not local and not edgesvc.has_acme()):
        info(plan.emit, "starting the edge (one Traefik, :80 and :443 for every name)",
             phase="tls")
        started = edgesvc.ensure_running(
            acme_email="" if local else plan.tlsspec.acme_email,
            acme_staging=plan.tlsspec.acme_staging)
        if not started:
            holder = edgesvc.port_holder(443)
            because = (f" — {holder} is holding :443" if holder
                       else (f" — {started.why}" if started.why else ""))
            warn(plan.emit, f"the edge did not start{because}, so {plan.tlsspec.host} will "
                       "not answer yet. The workspace itself is unaffected; free "
                       "the port and `houston edge start`.", phase="tls")


def _register_the_name(plan: CreatePlan, local: bool) -> None:
    """The route, and the certificate request it may or may not imply."""
    from houston import tls as tlsmod


    needs_cert = edgesvc.register(plan.repro_name, plan.tlsspec.host,
                                  instances=plan.pre.instances or 1, local=local)
    if local:
        pass
    elif needs_cert:
        # No reachability checks. Whether the domain resolves here, and how
        # traffic gets to this host, is the operator's business -- houston
        # cannot see a tunnel, a port-forward or a firewall from in here, and
        # refusing to create the repro over a guess was the single biggest
        # source of confusion in this path.
        info(plan.emit, f"requesting a certificate from Let's Encrypt "
                   f"({'staging' if plan.tlsspec.acme_staging else 'production'}) "
                   f"for {plan.tlsspec.host} — the edge does this in the background; "
                   f"confirm with `houston tls-status -n {plan.repro_name}`",
             phase="tls")
        # Counted BEFORE the warning, so the name being created is included --
        # the useful number is "after this one", not "before it".
        tlsmod.record_issuance(plan.tlsspec.host)
        budget = tlsmod.budget_warning(plan.tlsspec.host)
        if budget:
            warn(plan.emit, budget, phase="tls")
    else:
        info(plan.emit, f"registering {plan.tlsspec.host} — covered by the wildcard, "
                   "no certificate request", phase="tls")


def _record_tls(plan: CreatePlan, local: bool) -> None:
    """What the record has to say so `tls-status` and the panel can tell the truth."""

    plan.meta.extra["tls"] = plan.tlsspec.mode
    plan.meta.extra["edge"] = True
    # Deliberately NO tls_ports: used_ports() feeds port allocation, and
    # claiming a port this workspace does not publish would make every later
    # workspace route around one it never held.
    if not local:
        plan.meta.extra["tls_staging"] = plan.tlsspec.acme_staging
        plan.meta.extra["tls_email"] = plan.tlsspec.acme_email
    plan.meta.extra.setdefault("notes", [])
    plan.meta.extra["notes"] = list(plan.meta.extra["notes"]) + [
        f"served by the edge at https://{plan.tlsspec.host}",
        "the edge holds :443 for the whole box; this workspace publishes none",
    ]


def _prepare_edge(plan: CreatePlan) -> None:
    """The shared Traefik edge: refuse a foreign one, get a certificate, route the name.

    Nothing here is conditional on the runtime -- a workspace never terminates TLS, so
    all of it is the edge's business and none of it changes this workspace's containers.
    """
    plan.files = list(plan.pre.files)
    if not plan.tlsspec:
        return
    from houston import tls as tlsmod

    # ONE path, whether the name is a real domain or a .houston.localhost one. The only
    # difference is where the certificate comes from, and that is the edge's business --
    # so no tls/ files are written here, no port is claimed, and nothing about this
    # workspace's containers depends on it.
    local = plan.tlsspec.mode == tlsmod.MODE_LOCAL
    _refuse_a_foreign_edge(plan)
    _issue_certificate(plan, local)
    _start_the_edge(plan, local)
    _register_the_name(plan, local)
    _record_tls(plan, local)





def _create_repro_locked(req: CreateReq, emit: Emit = null_emit, *,
                         stream_output: bool = False,
                         monitor_attach=request._missing_monitor_attach) -> dict:
    """The Compose create, as a plan and the steps that fill it in.

    The ORDER below is the specification. Each step's own docstring and comments say why
    it sits where it does; several of them record a defect caused by sitting somewhere
    else.
    """
    plan = CreatePlan(req=req, emit=emit, stream_output=stream_output,
                      monitor_attach=monitor_attach)
    _resolve_axes(plan)

    if req.runtime == topology.KUBERNETES:
        # A PARALLEL path, not a branch woven through this function. Everything
        # below is compose-shaped -- host ports, a compose document, `docker
        # compose up` -- and two front-ends depend on it behaving exactly as it
        # does. Handing Kubernetes off here keeps the Docker default byte-identical
        # and puts the Kubernetes sequence in the module that owns it.
        #
        # TLS is refused rather than ignored. `_resolve_tls` runs BELOW this line,
        # so `--https` on a Kubernetes workspace did nothing at all and said nothing
        # about it -- the workspace came up on plain http and the flag evaporated.
        # Silently doing less than asked is the failure this whole runtime split has
        # produced most often, so it is named here rather than discovered later.
        preconditions._refuse_unsupported_on_kubernetes(req)
        return create_k8s._create_kubernetes(req, emit=emit, monitor_attach=monitor_attach)
    _resolve_pairing(plan)
    _load_preset(plan)
    _settle_name(plan)

    if runner.exists(plan.repro_name) and not plan.req.force and not plan.req.fresh:
        return _reuse(plan.repro_name, plan.wait, plan.req, plan.emit,
                      stream_output=plan.stream_output, resolved=plan.resolved,
                      preset_name=plan.pre.name)
    _claim_ports(plan)
    _warn_about_the_bind(plan)
    _warn_about_the_browser_host(plan)
    _build_document(plan)
    _build_record(plan)
    _prepare_edge(plan)
    _attach_monitoring(plan)
    _replace_existing(plan)
    _start_the_workspace(plan)
    return _finish(plan)
