"""The workspace itself: list it, look at it, make it, change it, destroy it.

Everything addressed at `/api/repros` and `/api/repros/{name}` that is not logs, a
backup, a load test or a settings import. The read half is thin — `lifecycle` already
owns the shape — and the write half is almost entirely "submit a job and hand back its
id", because every one of these is longer than a request should be held open for.

Two handlers are not what they look like. `GET /api/repros/{name}/env` and
`POST /api/repros/{name}/call` are reads in the HTTP sense and member+ in the table,
because what they hand over is credentials: the effective environment carries LDAP bind
passwords and OAuth secrets, and the REST console mints and spends an admin token.
"""
from __future__ import annotations

import json
import time

from fastapi import Body, Request

from houston import config
from houston import presets as presets_mod
from houston import runner
from houston.errors import NotReadyError, ValidationError
from houston.services import audit as auditsvc
from houston.services import lifecycle as lc
from houston.services import monitor as monitorsvc
from houston.services import topology
from houston.web.context import AppContext
from houston.web.routes import _deps


#: The module's one entry point. The handlers below are public NAMES -- FastAPI reports
#: a route by its function name and the suite patches some of them -- but `register` is
#: the only thing anything outside this package may reach for, and a test walks the
#: imports to prove nothing does.
__all__ = ("register",)

# What the API-call console may send. A whitelist because `method` reaches
# requests.request() verbatim; the CLI's own examples only use these.
_API_METHODS = ("GET", "POST", "PUT", "DELETE", "PATCH")


def list_repros():
    return {"repros": lc.list_repros()}


def describe(name: str):
    return lc.describe(name)


def detail(name: str):
    return lc.detail(name)


def stats(name: str):
    from houston.perf import resources as R
    target = lc.resolve_name(name)
    if topology.of_repro(target) == topology.KUBERNETES:
        # `kubectl top` for the same two numbers, summed over every Rocket.Chat
        # pod so replicas are counted the way compose counts instances. It needs
        # metrics-server, which kind does not ship -- pod_metrics refuses and
        # says how to install it rather than reporting a confident zero.
        from houston.services import k8s
        meta = runner.read_meta(target)
        context = str((meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
        rows = k8s.pod_metrics(target, context=context)
        return {"cpu": round(sum(r["cpu_millicores"] for r in rows) / 10.0, 1),
                "mem_mb": round(sum(r["mem_bytes"] for r in rows) / 1e6, 1)}
    ids = runner.container_ids(target)
    prefix = f"{config.PROJECT_PREFIX}{target}-"
    cpu = mem = 0.0
    for line in runner.docker_stats(ids).splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        # Strip the `houston-<name>-` prefix before matching. A substring test
        # against the full container name meant a repro NAMED e.g.
        # "rocketchat-slow" matched every container, silently summing Mongo and
        # every sidecar into the RC chart.
        svc = parts[0][len(prefix):] if parts[0].startswith(prefix) else parts[0]
        if svc == "rocketchat" or svc.startswith("rocketchat-"):
            cpu += R._parse_cpu(parts[1])
            used, _ = R._parse_mem(parts[2])
            mem += used
    return {"cpu": round(cpu, 1), "mem_mb": round(mem / 1e6, 1)}


def _create_fields(req, request):
    """The fields a caller may set, and the ones only an owner of the box may."""
    allowed = set(lc.CreateReq.__dataclass_fields__) - {"actor"}
    fields = {k: v for k, v in req.items() if k in allowed}
    # From the session, never the body: a caller must not be able to create a
    # workspace in somebody else's namespace by asking.
    fields["actor"] = getattr(request.state, "actor", "") or ""
    # `version` is CreateReq's only required field, so omitting it raised a
    # TypeError from the constructor -- an opaque 500 for any caller using the
    # documented HTTP API rather than the GUI (which always sends the key).
    if not str(fields.get("version") or "").strip():
        raise ValidationError("`version` is required, e.g. {\"version\": \"8.5.1\"}")
    # Four fields decide what CODE runs and where it listens, which is a
    # different question from "make me a workspace". `rc_image` runs an
    # arbitrary image as the serve user; `reg_token` is an EE licence secret;
    # `bind` can publish a workspace with fixed admin/admin123 credentials to
    # the whole network; `context` picks the CLUSTER, so on a shared serve it can
    # put a colleague's workspace somewhere they cannot see or reach it.
    #
    # `port` USED to be in this list and should not have been. The only harm it
    # could do was taking a privileged port -- squatting 80 or 443 out from
    # under the edge -- and lifecycle.py:663 already refuses anything outside
    # 1024-65535 for everybody, admin included. So the check protected nothing
    # and cost a member the most reachable field in the dialog: "Host port" sits
    # in the main section, not behind Advanced, and typing one failed the whole
    # create with a message about images and interfaces.
    privileged = [k for k in lc.PRIVILEGED_CREATE_FIELDS if fields.get(k)]
    if privileged:
        who = getattr(request.state, "actor", "") or ""
        if not lc.may_set_privileged_fields(who):
            # Reachable only where somebody has narrowed the policy on purpose,
            # so the message says that rather than implying a built-in rule.
            extra = ("  For a workspace everyone on this box should reach, "
                     "`houston config set bind_host 0.0.0.0` sets it once for "
                     "the box." if "bind" in privileged else "")
            raise ValidationError(
                f"{', '.join(privileged)} is limited to admins on this box "
                "(`gui.create_policy admin`) — they decide what code runs and "
                "where it listens. An admin can widen it again with "
                "`houston config set gui.create_policy anyone`." + extra)
    return fields


def create(request: Request, req: dict = Body(...)):
    fields = _create_fields(req, request)
    creq = lc.CreateReq(**fields)
    # REFUSED ON THE REQUEST, like the state and teardown preflights. A bad preset
    # name is pure argument validation, and validating it inside the job meant a
    # caller got 200 and a job id and had to open the Activity list to learn the
    # request was wrong on arrival. Found by driving this route live: the escape
    # WAS blocked -- the job failed with a ValidationError and nothing was created
    # -- but the answer arrived in the wrong place.
    # Same rule, one line up the stack: a context that does not exist is pure
    # argument validation and is answerable WITHOUT talking to any cluster, so it
    # is refused here rather than failing the job. `contexts()` reads the two
    # kubeconfigs and nothing else.
    if creq.context:
        from houston.services import k8s
        known, unreadable = k8s.contexts()
        if known and creq.context not in known:
            raise ValidationError(
                f"no kubeconfig context named {creq.context!r} on this server. "
                "It can see: " + ", ".join(repr(c) for c in known))
        # An unreadable kubeconfig does NOT refuse here -- "I could not ask" is
        # not "it is not there", and the create's own preflight probes the cluster
        # for real. Refusing on it would make a transient kubectl failure look
        # like a typo.
        _ = unreadable
    if creq.preset:
        # Converted here rather than in `presets`: that module raises plain
        # ValueError throughout and `_create_repro_locked` translates it at the
        # service boundary (lifecycle.py:1258). Doing the same at this preflight
        # keeps one convention -- without it the refusal was a 500, because the web
        # layer maps ReproError and nothing else.
        try:
            presets_mod._user_path(creq.preset)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
    job = _deps.jobs(request).submit("create", lc.create_repro, creq, stream_output=True,
                      monitor_attach=monitorsvc.attach, label=creq.name or creq.version)
    return {"job_id": job.id}


def state(request: Request, name: str, body: dict = Body(...)):
    """Stop/start/restart, as a JOB rather than a blocking call.

    It used to be synchronous, and three things followed from that. The progress
    the service emits went nowhere -- on Kubernetes `stop` waits up to 60s for
    pods to go and says so as it waits. It was invisible in the Activity list, so
    on a shared box nobody could see a state change was in flight. And it was
    outside `jobs.drain()`, so a `systemctl restart` could cut it mid-scale with
    nothing recording that anything had been interrupted.
    """
    # REFUSED HERE, QUEUED THERE. A job answers 200 with an id, so validating
    # inside it would turn "that is not an action" and "no such workspace" into a
    # job that failed -- a 200 for a request that was wrong on arrival. The checks
    # are pure argument validation and cost nothing.
    action = body.get("action", "")
    target = lc.check_state_request(name, action)
    job = _deps.jobs(request).submit("state", lc.set_state, target, str(action), label=target)
    return {"job_id": job.id}


def bring_up(request: Request, name: str):
    """Recreate a `down`ed repro's containers from its stored metadata.

    `docker compose start` cannot revive a repro that was `down`ed — there are
    no containers left to start — so /state is useless for it. This is the
    GUI's equivalent of the CLI's `up --version <same> --name <same>`: the
    workspace and repro.json survive a `down`, so nothing needs re-entering.
    offline=True because the stored version needs no fresh lookup.
    """
    target = lc.resolve_name(name)
    meta = runner.read_meta(target)
    req = lc.CreateReq(version=meta.rc_version, name=target, wait=True,
                       offline=True, **topology.axes_of_meta(meta))
    job = _deps.jobs(request).submit("up", lc.create_repro, req, stream_output=True, label=target)
    return {"job_id": job.id}


def ready(request: Request, name: str):
    meta = runner.read_meta(lc.resolve_name(name))
    job = _deps.jobs(request).submit("ready", lc.wait_and_finalize, meta, label=meta.name)
    return {"job_id": job.id}


def set_default(name: str):
    """Make this repro the default (the CLI's `houston use`).

    The dashboard displayed the `default` pill but had no way to move it --
    the create dialog's Pin checkbox was the only path, so changing it meant
    recreating a repro or dropping to the CLI.
    """
    target = lc.resolve_name(name)
    config.update_config(lambda cfg: cfg.__setitem__("default_repro", target))
    return {"ok": True, "default": target}


def create_pat(name: str, body: dict = Body(default={})):
    """Mint a Personal Access Token and return ready-to-use API headers.

    Synchronous rather than a job: it is two HTTP calls against a repro that
    is already serving, and the caller wants the value back.
    """
    from houston import rcapi
    target = lc.resolve_name(name)
    lc.require_engine(target)
    meta = runner.read_meta(target)
    label = str(body.get("label") or "houston")
    bypass_2fa = bool(body.get("bypass_2fa", True))
    try:
        auth = lc.login(meta)
        # Not `token` -- that name is create_app's server auth token, and
        # rebinding it here reads like the handler is overwriting it.
        pat = rcapi.generate_pat(meta.root_url, auth, meta.admin_pass,
                                 token_name=label, bypass_2fa=bypass_2fa,
                                 workspace=meta.name)
    except Exception as exc:  # noqa: BLE001 - surface as a 409, not a 500
        raise NotReadyError(
            f"could not create a token (is it ready? `houston ready -n {meta.name}`): {exc}"
        ) from exc
    if not pat:
        raise NotReadyError("Rocket.Chat did not return a token (is it ready?)")
    return {"token": pat, "user_id": auth.user_id, "label": label,
            "bypass_2fa": bypass_2fa, "root_url": meta.root_url}


def env_get(name: str):
    """The RC service's effective environment, with user overrides marked."""
    from houston.services import envvars as envsvc
    return envsvc.current(name)


def env_set(request: Request, name: str, body: dict = Body(...)):
    """Change env vars and recreate Rocket.Chat so they take effect.

    A job, not synchronous: recreating the container takes seconds to tens of
    seconds, and the GUI already knows how to stream a job's progress.
    """
    from houston.services import envvars as envsvc
    target = lc.resolve_name(name)
    sets = body.get("set") or {}
    if not isinstance(sets, dict):
        raise ValidationError("`set` must be an object of KEY: VALUE")
    # Rocket.Chat SETTINGS come in separately and are prefixed here, not by the
    # caller: a bare setting id silently does nothing, so the rule belongs on
    # the server where every front-end gets it.
    settings = body.get("setting") or {}
    if not isinstance(settings, dict):
        raise ValidationError("`setting` must be an object of SettingId: VALUE")
    sets = {**sets, **envsvc.prefix_settings(settings)}
    unset = body.get("unset") or []
    if not isinstance(unset, list):
        raise ValidationError("`unset` must be a list of key names")
    job = _deps.jobs(request).submit("env", envsvc.set_env, target, sets, [str(u) for u in unset],
                      restart=bool(body.get("restart", True)), label=target)
    return {"job_id": job.id}


def tls_state(name: str):
    """What the repro is ACTUALLY serving over TLS — the GUI's `tls-status`.

    `up --wait` only proves Rocket.Chat booted: it polls the internal http port.
    Traefik obtains its certificate in the background afterwards and falls back
    to a self-signed placeholder when ACME fails, so HTTPS needs its own check.
    """
    from houston import tls as tlsmod
    meta = runner.read_meta(lc.resolve_name(name))
    if not meta.public_url:
        raise ValidationError(f"{meta.name!r} was not created with --https")
    mode = str(meta.extra.get("tls") or "")
    host = meta.public_url.split("://", 1)[1].split(":")[0]
    port = int((meta.extra.get("tls_ports") or [443])[0])
    cafile = (str(tlsmod.ca_dir() / tlsmod.CA_CRT)
              if mode == tlsmod.MODE_LOCAL else None)
    # Dial THIS host with the domain as SNI: probing the public name lets a
    # proxy in front answer instead, and its certificate is not ours.
    #
    # UNLESS TLS TERMINATES IN THE CLUSTER, where there is no "ours" on this host
    # to be answered for -- the certificate is a Secret in the cluster and the
    # cluster's own ingress holds :443. Loopback then reaches whatever else is
    # listening here, which on a box running houston's edge is a Traefik that has
    # never heard of the name and answers with its placeholder. MEASURED against a
    # live EKS workspace whose certificate `openssl` and `curl` both fetched
    # correctly from this very box, while this endpoint called it not-yet-issued.
    if str(meta.extra.get("tls_terminates") or "") == "cluster":
        out = tlsmod.verify(host, port, cafile=cafile)
    else:
        out = tlsmod.verify("127.0.0.1", port, cafile=cafile, sni=host)
    out.update(mode=mode, public_url=meta.public_url, name=meta.name)
    if mode == tlsmod.MODE_ACME:
        pub = tlsmod.verify(host, 443)
        out["public_issuer"] = pub["issuer"]
        out["public_error"] = pub["error"]
    return out


def _api_request(body, meta, rcapi):
    """What to call, with which credential, and the refusals before anything is sent."""
    method = str(body.get("method") or "GET").upper()
    if method not in _API_METHODS:
        raise ValidationError(
            f"unsupported method {method!r} (use {', '.join(_API_METHODS)})")
    path = str(body.get("path") or "").strip()
    if not path:
        raise ValidationError("no API path given, e.g. /api/v1/me")
    raw = str(body.get("data") or "").strip()
    try:
        payload = json.loads(raw) if raw else None
    except json.JSONDecodeError as exc:
        raise ValidationError(f"request body is not valid JSON: {exc}") from exc

    use_pat = bool(body.get("pat"))
    two_fa = bool(body.get("two_fa"))
    try:
        auth = lc.login(meta)
        if use_pat:
            # Same swap the CLI's --pat does: exercise the workspace the way a
            # customer script does, through a token rather than a login session.
            auth = rcapi.Auth(
                token=rcapi.generate_pat(meta.root_url, auth, meta.admin_pass,
                                         bypass_2fa=True, workspace=meta.name),
                user_id=auth.user_id)
    except Exception as exc:  # noqa: BLE001 - surface as a 409, not a 500
        raise NotReadyError(
            f"could not authenticate (is it ready? `houston ready -n {meta.name}`): {exc}"
        ) from exc
    return auth, method, path, payload, two_fa, use_pat


def api_call(name: str, body: dict = Body(...)):
    """One authenticated REST call against a repro -- the GUI's `houston api`.

    A non-2xx *from Rocket.Chat* is a result, not a failure of this endpoint:
    it comes back 200 with the status in the payload, so the panel can show
    "HTTP 403" and the response body the way the CLI prints them. Only being
    unable to make the call at all (bad input, no auth, no connection) is an
    error status here.

    Not an open proxy: rcapi.rcapi.call() builds `root_url + "/" + path.lstrip("/")`,
    so the host is always this repro's own. A `path` of "http://elsewhere/x"
    or "//elsewhere/x" lands as a path segment on the workspace, not a new
    destination.
    """
    import requests

    from houston import rcapi
    target = lc.resolve_name(name)
    lc.require_engine(target)
    meta = runner.read_meta(target)

    auth, method, path, payload, two_fa, use_pat = _api_request(body, meta, rcapi)

    # Audited at the USER-INITIATED call site, never inside rcapi.rcapi.call() --
    # that is the internal transport for login, seeding and every load test,
    # so auditing there would drown the log in houston talking to itself.
    # The body is never recorded: it can carry a password being set.
    auditsvc.record("api-call", f"{meta.name} {method} {path}")
    extra = rcapi.password_2fa_headers(meta.admin_pass) if two_fa else None
    started = time.monotonic()
    try:
        status, text = rcapi.rcapi.call(meta.root_url, method, path,
                                  auth=auth, data=payload, extra_headers=extra)
    except requests.RequestException as exc:
        raise NotReadyError(f"request failed: {exc}") from exc
    tag = ("PAT" if use_pat else "admin") + ("+2fa" if two_fa else "")
    return {"status": status, "text": text, "tag": tag,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 1),
            "url": f"{meta.root_url.rstrip('/')}/{path.lstrip('/')}"}


def set_owner(request: Request, name: str, body: dict = Body(...)):
    """Hand a workspace over. `created_by` is left alone -- who made it is a
    fact about the past; who is responsible for it today is what changes."""
    return lc.set_owner(name, str(body.get("to") or ""),
                        by=getattr(request.state, "actor", "") or "")


def teardown(request: Request, name: str, volumes: bool = False,
             confirm: bool = False):
    """Destroy a workspace, as a job.

    MEASURED at 48.5s on kind and 61s on k3s -- `delete_namespace` waits for the
    namespace and its PersistentVolumeClaims to actually go, which is deliberate
    and is why returning early once left an orphan. Held open as an HTTP request
    that whole time it occupied a threadpool worker, streamed none of the progress
    it emits, and -- the part that matters -- was not joined by `jobs.drain()`, so
    a graceful shutdown could cut it between `kubectl delete --wait=false` and the
    confirmation loop and leave a half-deleted namespace with nothing recording it.
    """
    # The confirmation and the ownership gate stay on the REQUEST: a member who
    # asked to destroy a colleague's workspace must be told so by the call they
    # made, not by a job they then have to go and read.
    target = lc.check_teardown_request(name, volumes=volumes, confirm=confirm)
    job = _deps.jobs(request).submit("teardown", lc.teardown, target, volumes=volumes,
                      confirm=confirm, label=target)
    return {"job_id": job.id}


def prune(request: Request, body: dict = Body(default={})):
    """Sweep every `down` workspace, as a job. Serial over each one, so it scales
    with how many there are -- 18.7s for two workspaces and two orphan namespaces
    -- and it emits a line per workspace that a synchronous call discarded."""
    job = _deps.jobs(request).submit("prune", lc.prune,
                      confirm=bool(body.get("confirm", False)),
                      orphans=bool(body.get("orphans", False)))
    return {"job_id": job.id}


ROUTES = (
    ("get", "/api/repros", list_repros),
    ("get", "/api/repros/{name}", describe),
    ("get", "/api/repros/{name}/detail", detail),
    ("get", "/api/repros/{name}/stats", stats),
    ("post", "/api/repros", create),
    ("post", "/api/repros/{name}/state", state),
    ("post", "/api/repros/{name}/up", bring_up),
    ("post", "/api/repros/{name}/ready", ready),
    ("post", "/api/repros/{name}/default", set_default),
    ("post", "/api/repros/{name}/pat", create_pat),
    ("get", "/api/repros/{name}/env", env_get),
    ("post", "/api/repros/{name}/env", env_set),
    ("get", "/api/repros/{name}/tls", tls_state),
    ("post", "/api/repros/{name}/call", api_call),
    ("post", "/api/repros/{name}/owner", set_owner),
    ("delete", "/api/repros/{name}", teardown),
    ("post", "/api/prune", prune),
)


def register(app, ctx: AppContext) -> None:
    """Attach this module's routes. Registration order inside the module is ROUTES'
    order, which is the order they were declared in the single factory this came from."""
    for verb, path, handler in ROUTES:
        getattr(app, verb)(path)(handler)
