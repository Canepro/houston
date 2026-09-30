"""Reading a create request: what runtime it means, what it would provision, what it
may not ask for.

Tier 0. Pure shaping and refusal -- nothing here writes, and `capacity` depends on it to
know whether a create will provision a cluster and therefore whether the cluster overhead
counts against this machine.
"""
from __future__ import annotations

from houston import config, presets
# `_common` for its --set coercions, private module and all: this decides whether
# `presigned` is on, and the preset decides the same thing from the same string.
# Two readings of "true" is how they come to disagree.
from houston.presets import _common
from houston.services import topology
from houston.errors import ValidationError
from houston.services.events import Emit, info, null_emit, warn
from houston.services.lifecycle.types import (_BILLABLE_CONTEXT_PREFIXES,
                                              _BROWSER_HOST_PARAM, _LOOPBACK_BINDS, CreateReq)


def _will_provision(req: "CreateReq") -> bool:
    """Whether this create is going to CREATE a cluster, as opposed to use one.

    The two capacity questions below both turn on it, and both used to ask something
    narrower that gave the wrong answer the moment houston could use a cluster it did
    not make: `cluster_exists` is specifically OUR kind cluster, so a box whose k3s was
    about to be adopted was billed 600 MB for a control plane already running -- and
    `check_capacity` refusing a create the host can hold is how people learn to type
    --force by reflex.

    False on any doubt. An unprobeable cluster is not evidence that one will be built.
    """
    if topology.normalize(getattr(req, "runtime", "")) != topology.KUBERNETES:
        return False
    try:
        from houston.services import k8s
        # The request's context, or this answers for the WRONG cluster: with `kind`
        # installed, an un-passed context makes `plan_cluster` plan a kind create and
        # return True, so `check_capacity` would reserve a control plane's RAM for a
        # workspace going to a cluster that already exists somewhere else.
        return k8s.plan_cluster(req_context(req)).create
    except Exception:  # noqa: BLE001 - no cluster and no kind: the create will refuse
        return False


def infer_runtime(req: "CreateReq") -> str:
    """The runtime this request means, with a context taken as saying Kubernetes.

    A CONTEXT IS A KUBERNETES WORD. Somebody who typed `--context <an eks arn>` has
    already said where this runs, and making them also type `--runtime kubernetes` is
    houston asking twice and refusing on the answer it did not repeat -- measured on
    a first run, where the whole command had to be retyped for it.

    Only from an EXPLICIT `--context`, never from the box default: a default cluster
    is a convenience for the Kubernetes work somebody already does, and letting it
    silently move `up` off Compose would change what an un-flagged command means for
    every workspace on the box.
    """
    named = str(getattr(req, "runtime", "") or "").strip()
    if named:
        return named
    if str(getattr(req, "context", "") or "").strip():
        return topology.KUBERNETES
    return named


def _say_where_this_is_going(req: "CreateReq", typed_runtime: str,
                             emit: Emit = null_emit) -> None:
    """Say out loud when a SAVED setting decided where this workspace goes.

    `kubernetes.context` changes what other commands mean and nothing ever mentioned
    it, which produced two opposite complaints from the same silence:

      * somebody sets a default cluster, runs `up`, and gets a Docker workspace --
        because a bare `up` is Compose whatever is saved, deliberately, since letting
        a saved cluster move every un-flagged command off Compose would change what
        `up` means for the whole box;
      * somebody runs `cluster create`, which SETS that default, and from then on
        `--runtime kubernetes` quietly means the EKS cluster it just built rather than
        the free local one it meant yesterday -- at roughly $8.46 a day.

    Both are the same defect: a stored setting that decides something, with nothing on
    screen saying it did. Neither is a refusal. The first is correct behaviour that
    merely looks wrong, and the second is a thing people legitimately want -- so this
    reports, and the operator decides.

    An explicit `--context` says nothing here: naming the cluster on the command line
    is already the unambiguous form, and a note repeating what was just typed is noise.
    """
    saved = config.default_kube_context()
    if not saved or str(getattr(req, "context", "") or "").strip():
        return
    if topology.normalize(getattr(req, "runtime", "")) == topology.KUBERNETES:
        # Only when it COSTS: a saved kind or k3s context being used by
        # `--runtime kubernetes` is the whole point of saving one, and warning about it
        # every time would train people to stop reading these.
        if _saved_default_is_billable(saved):
            warn(emit,
                 f"this workspace is going to {saved!r}, which costs money by the "
                 f"hour — it was chosen because it is this box's saved default "
                 f"cluster, not because this command named one. `--context <name>` "
                 f"names a cluster outright; `houston config set "
                 f"kubernetes.context ''` clears the default.",
                 phase="preflight")
        return
    if typed_runtime:
        return          # they said `--runtime docker`; they are not confused
    info(emit,
         f"this workspace is going to Docker. {saved!r} is saved as this box's "
         f"default cluster, but a plain `up` never uses it — add `--runtime "
         f"kubernetes` to send this one there, or `--context <name>` to name a "
         f"cluster outright.",
         phase="preflight")


def _saved_default_is_billable(context: str) -> bool:
    """Whether a saved context names a cluster somebody is paying for.

    Read from the CONTEXT NAME, never by probing. This runs on the way into every
    create, including Compose ones, and a create that pauses to ask a cloud API which
    kind of cluster it is not about to use has bought nothing at a real price -- the
    same reason `cluster.provider_of` falls back to the name when a cluster has no
    nodes to ask.
    """
    low = context.strip().lower()
    return any(low.startswith(p) for p in _BILLABLE_CONTEXT_PREFIXES)


def req_context(req: "CreateReq") -> str:
    """Which cluster this request names, falling back to the box's default.

    ONE function because two callers need the same answer and disagreeing is a real
    failure rather than an untidiness: `_will_provision` decides whether
    `check_capacity` reserves a control plane's RAM, and `_create_kubernetes` decides
    where the workspace actually goes. A default applied in one and not the other
    reserves memory for a kind cluster while building in EKS, or the reverse.

    Resolved here rather than in the CLI so both front ends get it -- `serve` has no
    flags to fall back FROM, and the stored key is the box's setting either way.
    """
    named = str(getattr(req, "context", "") or "").strip()
    return named or config.default_kube_context()


def _unknown_params(params: dict, pre: presets.Preset) -> list[str]:
    return sorted(set(params) - set(pre.params_help))


def _requested_bind_host(req: "CreateReq") -> str:
    """The interface these ports will be published on, as far as is known this early.

    `req.bind_public` can still widen it later -- `_resolve_tls` sets that when an
    ACME challenge needs the host reachable -- so this is the REQUESTED bind, not the
    final one. Callers that must not over-promise use it in the conservative
    direction: loopback here means "do not assume anything is reachable".
    """
    cfg = config.load_config()
    return str(req.bind or cfg.get("bind_host") or config.DEFAULT_BIND_HOST)


def _derive_idp_host(req: "CreateReq", emit: Emit = null_emit) -> None:
    """Default a preset's browser-facing hostname from the URL the browser will use.

    `--root-url https://rc.example.com` and `--domain rc.example.com` both say, in as
    many words, "people will type this". The saml/oidc presets otherwise send the
    browser to `localhost:8081` / `keycloak:8085`, and `s3_minio` in presigned mode
    hands it `minio:9000` -- all of which name the visitor's own laptop, so the SAML
    button returned to the login page, the OIDC popup opened blank, and file previews
    failed, none of them logging anything. Keycloak also refuses an AuthnRequest whose
    Destination is not the URL it arrived on, so the two cannot be left to disagree.

    Explicit `--set` always wins; nothing is derived for a workspace nobody said would
    be reached from elsewhere.
    """
    param = _BROWSER_HOST_PARAM.get(req.preset or "")
    if not param:
        return
    params = dict(req.params or {})
    if params.get(param):
        return
    # s3_minio ONLY in presigned mode. In the default proxy mode the browser never
    # touches MinIO -- Rocket.Chat streams the bytes -- so `minio:9000` is reached
    # over the compose network, which is strictly more reliable than a host address
    # that depends on the bind and on DNS. Deriving there would trade a working
    # internal URL for a fragile external one to fix a problem that does not exist.
    if req.preset == "s3_minio" and not _common.truthy_param(params, "presigned"):
        return
    # A HOST IS ONLY WORTH DERIVING IF IT CAN BE REACHED, and with the default
    # loopback bind it cannot -- by anything, including Rocket.Chat's own container.
    # Measured: a port published on 127.0.0.1 is unreachable from a container by the
    # host's address (connect fails), and reachable when published on 0.0.0.0 (200).
    #
    # That matters because OIDC's url serves the browser AND RC's backend. Deriving it
    # here would have moved the backend off compose DNS -- which always worked -- onto
    # an address nothing can reach, turning one broken leg into two. `up --preset oidc
    # --domain rc.example.com` is the invocation that does it, and it is a plausible
    # one. So: derive only when the ports are published somewhere a derived host could
    # answer, and otherwise say so below rather than guess.
    if _requested_bind_host(req) in _LOOPBACK_BINDS:
        return
    from urllib.parse import urlsplit
    source = req.root_url or (f"https://{req.domain}" if req.domain else "")
    host = urlsplit(source).hostname if source else ""
    if not host or host in ("localhost", "127.0.0.1"):
        return
    params[param] = host
    req.params = params
    info(emit, f"the {req.preset} preset will address its own service as {host!r}, "
               f"taken from the URL you gave — that is the name the browser follows, "
               f"and its default names this machine. Override with "
               f"`--set {param}=...`.",
         phase="create")


# The default for create's `monitor_attach` hook. A create may be asked for monitoring,
# and the thing that knows how to attach it lives a layer up -- so the parameter defaults
# to a refusal rather than to `None`, and a caller that forgets gets a ValidationError
# naming the omission instead of a TypeError deep inside the k8s branch.
def _missing_monitor_attach(_name: str, _emit: Emit) -> dict:
    raise ValidationError("monitoring attachment was not supplied by the caller")
