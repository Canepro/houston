"""Creating a workspace on Kubernetes.

Tier 5. The Kubernetes half of create, split from the Compose half because the two share
a request and almost nothing else: this one talks to a cluster that may not exist yet,
has no compose file to write, and publishes a name through an ingress rather than a port.

Like the Compose half, this is a PLAN plus named steps rather than one function. It was
417 lines, and the same argument applies: the order carries decisions that each cost a
real defect to learn -- the write-ahead record before any cluster resource exists, the
cluster chosen before a byte is written, the core tools checked before a kind cluster is
built. The order is visible at the bottom of this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
from dataclasses import asdict
from datetime import datetime, timezone

from houston import config, presets, runner, versions
from houston.errors import PreflightError, ReproError, ValidationError
from houston.services import edge as edgesvc
from houston.services import topology
from houston.services.events import Emit, info, null_emit, warn
from houston.services.lifecycle import (naming, notes, ports, preconditions, ready,
                                        request, seeding, sizing, tlsplan)
from houston.services.lifecycle.types import CreateReq, _BILLABLE_DISTRIBUTIONS

@dataclass
class KubeCreate:
    """What one Kubernetes create knows, in the order it comes to know it.

    `plan` is the CLUSTER plan `k8s.plan_cluster` returns -- which cluster, what
    distribution, what it costs -- and is why the parameter these steps take is `job`
    rather than `plan`: the two would otherwise be the same word for different things in
    every line that reads either.
    """

    req: CreateReq
    emit: Emit
    monitor_attach: object = None
    #: `_settle_name`
    repro_name: str = ""
    reused: bool = False
    #: `_resolve_pairing`
    resolved: object = None
    recorded: int = 0
    host_port: int = 0
    #: `_settle_addressing`
    cfg: dict = field(default_factory=dict)
    reg_token: str = ""
    bind_host: str = ""
    root: str = ""
    microservices: bool = False
    preset_for_notes: object = None
    #: `_plan_cluster`
    pre: object = None
    plan: object = None
    #: `_plan_tls`
    tlsspec: object = None
    ktls: object = None
    #: `_write_provisional_record`
    admin_password: str = ""
    provisional: object = None
    #: `_create_the_workspace`
    out: dict = field(default_factory=dict)
    #: `_build_record`
    meta: object = None
    groups: object = None
    result: dict = field(default_factory=dict)


def _k8s_settle_name(job: KubeCreate) -> None:
    """The name, whether this is a re-create, and the capacity refusal."""
    job.repro_name = naming._derive_for(job.req)
    naming._warn_name_coerced(job.req, job.emit)
    naming._require_valid_name(job.repro_name)
    # NO refusal for an existing workspace. `down` tells the user "bring it back:
    # houston up ...", and this raised "already exists, down first or --force" at
    # them -- two messages in the same tool contradicting each other about the same
    # workspace. Compose reuses; so does this. The namespace and its PVC survived a
    # plain `down`, which is exactly what makes bringing it back meaningful.
    job.reused = runner.exists(job.repro_name)
    if job.reused:
        info(job.emit, f"{job.repro_name!r} already exists — bringing it back up",
             phase="plan")
    sizing.check_capacity(job.req, job.req.preset, job.emit)


def _k8s_resolve_pairing(job: KubeCreate) -> None:
    """Rocket.Chat, its MongoDB and the host port -- announced before the slow part starts."""
    # SAID BEFORE IT IS DONE, not after. This is a live lookup against
    # releases.rocket.chat and the cluster probing below it is a dozen kubectl round
    # trips -- on EKS each one is a second or two. Together they were a minute or more
    # of complete silence after the opening line, and a reader watching the GUI's log
    # field sees a create that has stopped. The same defect as the install's 254-second
    # gap, at the other end of the same command.
    info(job.emit, f"resolving Rocket.Chat {job.req.version} and its MongoDB pairing",
         phase="plan")
    try:
        job.resolved = versions.resolve(job.req.version, offline=job.req.offline)
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
    if getattr(job.resolved, "source", "") == "map (no such release)":
        warn(job.emit, f"releases.rocket.chat has no {job.req.version} — the pairing below "
                   f"comes from the shipped map, and the image pull will fail unless "
                   f"this tag really exists (`houston versions {job.req.version}`).",
             phase="resolve")
    if job.req.rc_image:
        job.resolved.rc_image = job.req.rc_image
    if job.req.mongo:
        versions.apply_mongo_override(job.resolved, job.req.mongo)

    # A workspace that comes back must come back at the SAME address. Allocating
    # afresh moved it from :3382 to :3000 on the `up` after a `down` -- so every
    # bookmark, every curl in a ticket and the URL the user had just been shown all
    # pointed at nothing. An explicit --port still wins; otherwise the recorded one
    # does, and only a genuinely new workspace allocates.
    job.recorded = 0
    if job.reused:
        try:
            job.recorded = int(runner.read_meta(job.repro_name).host_port or 0)
        except (OSError, ValueError, TypeError):
            job.recorded = 0
    job.host_port = job.req.port or job.recorded or ports.pick_host_port(
        0, presets.load("default", {}), exclude=job.repro_name)


def _k8s_settle_addressing(job: KubeCreate) -> None:
    """How this workspace is reached and what shape it is, in Compose's own order."""
    # Same resolution order Compose uses: the flag, then the box-level config, then
    # loopback. This was dropped entirely on the Kubernetes path.
    job.cfg = config.load_config()
    job.reg_token = job.req.reg_token or job.cfg.get("reg_token") or ""
    job.bind_host = job.req.bind or job.cfg.get("bind_host") or config.DEFAULT_BIND_HOST
    job.root = f"http://localhost:{job.host_port}"
    job.microservices = job.req.deployment == topology.MICROSERVICES
    # Resolved ONCE: the same object builds the workspace and supplies its notes,
    # so what was applied and what is printed cannot disagree.
    job.preset_for_notes = presets.resolve(job.req.preset or "default", topology.KUBERNETES,
                                       job.req.params or {})


def _k8s_plan_cluster(job: KubeCreate) -> None:
    """Which cluster, what it would cost, and whether this box has the tools to talk to it."""
    from houston.services import k8s

    # THE CLUSTER IS CHOSEN FIRST, before a single byte is written. `plan_cluster` only
    # probes, and it is what refuses when there is no cluster and no `kind` -- so that
    # refusal now costs nothing, where before it left an `incomplete` record that `list`
    # showed as a workspace and whose port `used_ports()` went on reserving.
    # THE CORE TOOLS FIRST, before anything is provisioned. `Preflight` models this
    # exactly right and the create path never asked it: with `kubectl` absent, `up`
    # built an entire kind cluster, THEN failed, and blamed the API server -- "cluster
    # houston-local was created but its API server is not answering" -- when the API
    # server was fine and the binary houston talks to it with was not installed. A
    # `repro.json` holding a host port was left behind too. `doctor` has named these
    # correctly all along; this is the same question asked where it can still refuse
    # cheaply.
    job.pre = k8s.preflight()
    if job.pre.missing_tools:
        raise PreflightError(
            f"{', '.join(job.pre.missing_tools)} is not installed, and a Kubernetes "
            f"workspace cannot be created or used without it. Install it and try "
            f"again — `houston doctor` lists what this runtime needs.")
    job.plan = k8s.plan_cluster(request.req_context(job.req))
    # A BILLABLE CLUSTER AND NO PUBLIC NAME. Warned, not refused, and the distinction
    # matters: a refusal would remove the one way to reach a workspace whose ingress is
    # broken, which is exactly when somebody needs it. But on a cluster that costs
    # money by the hour, a port-forward is a poor thing to have paid for -- it is tied
    # to a pod, dies with it, serves one machine, and leaves the cluster's whole reason
    # for being remote unused.
    if job.plan.distribution in _BILLABLE_DISTRIBUTIONS and not (job.req.domain or "").strip():
        warn(job.emit,
             f"{job.plan.context!r} is a {job.plan.distribution} cluster, and without --domain "
             f"this workspace is reachable only by a port-forward from this machine — "
             f"tied to a pod, gone when it restarts, and one person at a time. "
             f"`--domain <name>` gives it a publicly-trusted address instead.",
             phase="preflight")
    # BEFORE the write-ahead record below. Adopting a namespace that is not ours is
    # refused, and a refusal that created nothing must leave nothing behind -- the
    # provisional record exists so a create that dies HALF WAY can still be removed,
    # which is a different situation from one that never started.
    # ONLY WHEN THERE IS A CLUSTER TO ASK. `plan.create` means houston is about to
    # build its own, so the context does not exist in any kubeconfig yet and asking
    # kubectl about a namespace in it fails with "context was not found" -- which
    # `namespace_labels` correctly refuses to read as "no namespace", and then every
    # first Kubernetes create on a fresh box failed. Found by doing exactly that after
    # `prune` had reclaimed the cluster; the earlier runs of this check passed only
    # because a cluster happened to be there.
    #
    # Nothing is lost by skipping it: a cluster that does not exist yet holds no
    # namespace to collide with, and `ensure_namespace` makes the same check again once
    # the cluster is up.
    # THE HTTPS PLAN, and it goes here for the same reason `plan_cluster` does: every
    # refusal in it is a read, so an `up --https` that cannot work costs a second
    # rather than four minutes of MongoDB followed by a chart install. `_resolve_tls`
    # is the SHARED call the Compose path makes -- domain normalisation, the remembered
    # ACME email, and restoring the name a workspace already had all come from there
    # rather than being written twice.


def _k8s_plan_tls(job: KubeCreate) -> None:
    """The HTTPS name, and which of the two mechanisms will serve it."""
    from houston.services import k8s

    job.tlsspec = tlsplan._resolve_tls(job.req, job.repro_name, job.bind_host, exclude=job.repro_name, emit=job.emit)
    job.ktls = None
    if not job.plan.create:
        # THE PREFLIGHT NEEDS A KUBECONFIG THAT KNOWS THIS CONTEXT, and on a fresh
        # HOUSTON_HOME it does not have one: the cluster exists, so nothing was
        # created, so nothing exported the context this is about to ask through.
        # Every attempt then failed with `context was not found` and the next one
        # failed identically, because the export runs later in the create it never
        # reached. Idempotent, and a no-op for a cluster houston did not make.
        k8s.ensure_kubeconfig(job.plan, emit=job.emit)
        # HELM'S OWN ANSWER, and this is the cheapest refusal on the path.
        #
        # houston drives kubectl AND helm, they resolve their configuration
        # differently, and only kubectl was ever asked. Measured on this box: a
        # `~/.kube/config` carrying the server CA and client certificate of a
        # PREVIOUS install of the same cluster left kubectl completely happy -- `get
        # ns`, `auth whoami` as system:admin, the whole MongoDB phase -- while helm
        # refused every call with `x509: certificate signed by unknown authority`. So
        # this create built a namespace, a StatefulSet, a PersistentVolume and an
        # initiated replica set, spent four minutes doing it, then died at the chart
        # and rolled all of it back:
        #
        #     create failed — removing namespace houston-k8slive
        #     error: helm install failed: Error: kubernetes cluster unreachable ...
        #
        # An error naming neither the cause nor the cure, for a condition readable in
        # one second. Only for an ADOPTED cluster: `plan.create` has no cluster to ask
        # yet, and one houston makes itself gets a kubeconfig it wrote.
        _helm_why = k8s.helm_reachable(job.plan.context)
        if _helm_why:
            raise ValidationError(
                f"helm cannot reach cluster {job.plan.context!r}, although kubectl can. "
                f"The chart install would fail after MongoDB and roll the whole "
                f"workspace back. helm said: {_helm_why} — a kubeconfig left over "
                f"from a previous install of the same cluster does this. Regenerate "
                f"it (k3s: `sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config`; "
                f"kind: `kind export kubeconfig --name <cluster>`) and run this "
                f"again. `houston doctor` reports the same thing.")
        k8s.assert_namespace_available(job.repro_name, context=job.plan.context,
                                       owner=job.req.actor)


def _k8s_plan_kube_tls(job: KubeCreate) -> None:
    """What the in-cluster ingress needs, when the edge is not the thing serving the name."""
    if job.tlsspec:
        # Named before the probing starts. `_kubernetes_tls_plan` asks the cluster
        # about its ingress classes, its cert-manager CRD and its ingress endpoint
        # before it emits anything, which on a managed cluster is several seconds of
        # nothing at the exact moment the reader is waiting to learn where HTTPS is
        # coming from.
        info(job.emit, f"checking {job.plan.context} for the ingress and cert-manager HTTPS "
                   f"needs", phase="tls")
        # AFTER `ensure_kubeconfig`, because every probe in it needs a kubeconfig that
        # knows the context, and BEFORE the write-ahead record below, because a
        # refusal must leave nothing. `plan.create` is refused inside.
        job.ktls = tlsplan._kubernetes_tls_plan(job.req, job.tlsspec, job.plan, emit=job.emit)
    # Same decision as the compose path and the same reason -- see
    # `reachable_beyond_loopback`. On this runtime the workspace's own ports are
    # loopback port-forwards, so `--domain` is the case that removes the premise.
    #
    # Decided BEFORE the provisional record, not beside the chart install that uses
    # it. The provisional exists precisely so a create that dies half way can still
    # be cleaned up, and a chart installed with a generated password that was never
    # written down is a workspace nobody can log into -- `down` would still work,


def _k8s_write_provisional_record(job: KubeCreate) -> None:
    """A record BEFORE any cluster resource exists, so a killed create leaves something."""
    from houston.services import k8s

    # A WRITE-AHEAD RECORD, before a single cluster resource exists.
    #
    # `create_workspace` below builds the namespace, MongoDB, the chart release, the
    # scenario's manifests and the port-forward -- minutes of work -- and only after
    # it returned was anything written down. Kill the process in that window (a
    # `serve` shutdown with a create job still running does exactly this) and the
    # workspace is left fully running with NO record: invisible to `list`, `info`
    # and `down`, and unreachable by every command, because all of them start from
    # the state directory. Two such orphans were found holding several GB between
    # them, removable only with `kubectl delete namespace` by hand.
    #
    # Compose never had this: it writes the record at the top and starts containers
    # afterwards, so an interrupted create leaves something to clean up with. This
    # makes the runtimes agree. The namespace name is deterministic, so it can be
    # recorded before it exists; everything learned later is merged in below.
    # and nothing else would.
    job.admin_password = (config.generate_admin_password()
                      if preconditions.reachable_beyond_loopback(tlsspec=job.tlsspec,
                                                   bind_host=job.bind_host) else "")
    job.provisional = runner.Metadata(
        name=job.repro_name, project=k8s.namespace_for(job.repro_name),
        rc_version=job.resolved.rc_version, rc_image=job.resolved.rc_image,
        mongo_tag=job.resolved.mongo_tag, mongo_flavor=job.resolved.mongo_flavor,
        preset=job.req.preset, root_url=job.root, host_port=job.host_port,
        version_source=job.resolved.source, pinned=job.req.pin,
        admin_password=job.admin_password,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    topology.stamp(job.provisional.extra, topology.KUBERNETES)
    job.provisional.extra[config.EXTRA_DEPLOYMENT] = job.req.deployment or topology.MICROSERVICES
    job.provisional.extra["namespace"] = k8s.namespace_for(job.repro_name)
    # The chosen context, not a guess at it. This was `k8s.CONTEXT` unconditionally,
    # which was right only while houston's own cluster was the only one it could use.
    job.provisional.extra[config.EXTRA_CONTEXT] = job.plan.context
    job.provisional.extra["distribution"] = job.plan.distribution
    job.provisional.extra["incomplete"] = True
    if job.req.actor:
        job.provisional.extra["created_by"] = job.req.actor
    # Through the runner seam, so the workspace directory is restricted to 0700 the
    # way every Compose one is. Writing repro.json directly here skipped that, and
    # this runtime is the one that also writes `kubernetes/values.yaml` with
    # ADMIN_PASS in it.
    runner.write_record(job.repro_name, job.provisional)

    # BEFORE the create, so an ACME challenge has somewhere to land the moment the
    # chart's Ingress appears. See `_route_kubernetes_name`.
    if job.ktls:
        tlsplan._route_kubernetes_name(job.repro_name, job.ktls, emit=job.emit)

    # The forward this workspace was LAST published on, so a `--port` change retires
    # it instead of orphaning it. Read from the record rather than from the new
    # request: the whole failure is that the two ports differ.


def _k8s_create_the_workspace(job: KubeCreate) -> None:
    """The namespace, MongoDB, the chart release and the port-forward -- the long part."""
    from houston.services import k8s

    _prev_pid, _prev_port = 0, None
    if job.reused:
        try:
            _old = runner.read_meta(job.repro_name)
            _prev_pid = int((_old.extra or {}).get("port_forward_pid") or 0)
            _prev_port = int(_old.host_port or 0) or None
        except Exception:  # noqa: BLE001 - no record, no forward to retire
            _prev_pid, _prev_port = 0, None
    job.out = k8s.create_workspace(
        name=job.repro_name, resolved=job.resolved, host_port=job.host_port,
        microservices=job.microservices, replicas=job.req.replicas or 1,
        owner=job.req.actor, bind_host=job.bind_host, admin_password=job.admin_password,
        previous_pid=_prev_pid, previous_port=_prev_port,
        # PASSED AT LAST. `create_workspace` has taken `root_url` since it was
        # written and this call never supplied it, so `values_for` never set
        # anything and the chart emitted no ROOT_URL -- Rocket.Chat ran on its own
        # default while every human reached it here. The Compose path has always
        # threaded this; the omission is why the two runtimes disagreed about what a
        # workspace calls itself.
        root_url=job.root,
        # With a name, the chart's own Ingress template builds the Ingress -- houston
        # hand-writes none, which is what keeps the `/sockjs` and `/websocket` split to
        # ddp-streamer the chart's business rather than something to emulate.
        tls_host=(job.ktls.host if job.ktls else ""),
        ingress_class=(job.ktls.ingress_class if job.ktls else ""),
        issuer=(job.ktls.issuer if job.ktls else None),
        use_operator=job.req.mongo_operator,
        # Through a Secret referenced by `valueFrom`, never as a values literal:
        # `helm get values` is readable by anyone who can reach the release, and
        # houston writes the values to disk for a human to read. This refusal used
        # to say the token "is injected through the preset environment, which this
        # runtime does not apply yet" -- preset env has been applied here for some
        # time, so the reason had outlived itself while the flag stayed refused.
        reg_token=job.reg_token,
        # Resolved through the KUBERNETES adapter, so a scenario yields native
        # manifests here and a compose service on the other runtime -- one intent,
        # two renderings. `_refuse_unsupported_on_kubernetes` has already proved
        # this resolves, so a failure here would be a bug rather than bad input.
        preset=job.preset_for_notes,
        plan=job.plan,
        emit=job.emit)


def _k8s_build_record(job: KubeCreate) -> None:
    """`repro.json` as it stands once the cluster has answered."""

    job.meta = runner.Metadata(
        name=job.repro_name, project=job.out["namespace"], rc_version=job.resolved.rc_version,
        rc_image=job.resolved.rc_image, mongo_tag=job.resolved.mongo_tag,
        # NOT `resolved.mongo_flavor`. That is a COMPOSE concept -- "official" vs
        # "bitnami-legacy" -- and this runtime honours neither: `k8s.create_workspace`
        # records `mongo_managed_by` and `mongo_image` for exactly this reason, and
        # says so in its own comment. The DISPLAY was fixed when `houston list`
        # started printing "8.0 (official)" for a workspace running Docker Hub's
        # mongo:8.0; the provisional record here kept writing the value, so a JSON
        # consumer reading `mongo_flavor` still got a name for a different image.
        mongo_flavor="", preset=job.req.preset, root_url=job.root,
        host_port=job.host_port, version_source=job.resolved.source, pinned=job.req.pin,
        admin_password=job.admin_password,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    topology.stamp(job.meta.extra, topology.KUBERNETES)
    job.meta.extra[config.EXTRA_DEPLOYMENT] = job.req.deployment or topology.MICROSERVICES
    job.meta.extra.update({k: v for k, v in job.out.items() if k != "microservices"})
    # WHAT kind of cluster this workspace lives in. A label, never a branch -- it is
    # what lets `doctor`, the notes and a support case say "k3s" instead of leaving a
    # reader to infer it from a context name.
    job.meta.extra["distribution"] = job.plan.distribution
    if job.ktls:
        from houston import tls as tlsmod

        # The SAME three fields the Compose path records, so `list`, `info`,
        # `repro_links`, the GUI grid and `tls-status` all work on a Kubernetes
        # workspace for free -- none of them asks which runtime it is. `root_url`
        # deliberately stays the plain http port-forward URL that houston's own API
        # calls use; `public_url` is what a human opens.
        job.meta.public_url = f"https://{job.ktls.host}"
        job.meta.extra["tls"] = (tlsmod.MODE_ACME if job.ktls.issuer.mode == "acme"
                             else tlsmod.MODE_LOCAL)
        # `edge` means "a route file speaks for this name". It is what `note_groups_of`
        # keys the HTTPS card on, and it is False in the topology where the cluster
        # holds :443 itself and no edge is involved at all.
        job.meta.extra["edge"] = edgesvc.installed()
        # Where TLS actually terminates, which is the one thing genuinely different
        # from Compose and the thing a support case needs told: the certificate is a
        # cluster Secret issued by cert-manager, not a file the edge loaded.
        job.meta.extra["tls_terminates"] = "cluster"
        job.meta.extra["ingress_endpoint"] = str(job.ktls.endpoint)
        job.meta.extra["ingress_class"] = job.ktls.ingress_class
        # `certificate_ready` decides how a fallback certificate is EXPLAINED. It
        # was computed here all along and thrown away, so the check that reports
        # the result did not know whether one had ever been issued.
        tlsplan._publish_kubernetes_name(job.repro_name, job.ktls,
                                 cert_ready=bool(job.out.get("certificate_ready")),
                                 emit=job.emit)


def _k8s_record_the_request(job: KubeCreate) -> None:
    """What was ASKED for, so the workspace can be rebuilt exactly as it was."""
    if job.req.replicas > 1:
        job.meta.extra["instances"] = job.req.replicas
    if job.req.actor:
        job.meta.extra["created_by"] = job.req.actor
    # Recorded so the notes can be REBUILT from the record rather than read back out
    # of it -- a dynamic scenario's prose is a function of its params, and nothing
    # was keeping them.
    if job.req.params:
        job.meta.extra["params"] = dict(job.req.params)
    # A preset's self-configuration actions, recorded exactly as the Compose path
    # records them. Without this the OIDC preset would create no OAuth provider and
    # the SAML preset no provider settings -- both recorded and neither applied,
    # which is the silent-drop shape this runtime keeps producing.
    if getattr(job.preset_for_notes, "post_ready", None):
        job.meta.extra["post_ready"] = job.preset_for_notes.post_ready
    # Built by `note_groups_of` from the record this function has just finished
    # writing, which is the same call `info` and the GUI panel make. Constructing
    # them here instead is how a workspace came to keep the wording it was created
    # with for life; writing them at all is now only so the record says what the


def _k8s_write_record(job: KubeCreate) -> None:
    """The notes a reader needs, then the record -- and no compose file, because it is not one."""
    # workspace is without a reader having to re-derive it.
    job.groups = notes.note_groups_of(job.meta)
    # THE GROUPS ARE NOT PERSISTED. They are rendered presentation -- roughly 5.5 KB of
    # a 6.4 KB Kubernetes record, the same content as `notes` a second time, and
    # including an absolute `export KUBECONFIG=<home>/clients/kubernetes/config` that
    # is wrong the moment the home moves or the workspace is copied between boxes,
    # which backup/restore invite. Nothing read the stored copy: `payload.detail()`
    # calls `notes.note_groups_of` itself, and so does the CLI. The only reason to write
    # it was so the record "says what the workspace is", and it says that in `notes`.
    job.meta.extra.pop("note_groups", None)
    # Derived, never written twice: the CLI and every workspace record made before
    # groups existed read this, and a second hand-maintained copy is how the two
    # would come to disagree.
    job.meta.extra["notes"] = notes.flatten_notes(job.groups)
    # No compose document, so `write` is given an empty one rather than a fake:
    # a file that looks like a compose project but is not would be worse than none.
    ws = runner.workspace(job.repro_name)
    ws.mkdir(parents=True, exist_ok=True)
    runner.atomic_write(ws / "repro.json",
                        json.dumps(asdict(job.meta), indent=2))
    # --wait and --seed were ignored here, so `up --seed` ran the seeder the instant
    # helm returned and failed with "can't seed - repro not ready". The CLI already


def _k8s_finish(job: KubeCreate) -> dict:
    """Waiting, seeding, monitoring, and the line the caller reads at the end."""
    # forces wait=True when seeding; this path simply never read it.
    job.result = {"name": job.repro_name, "meta": asdict(job.meta), "url": job.root,
              "reused": job.reused, "runtime": topology.KUBERNETES}
    # A preset with post_ready actions MUST wait, or there is nothing to configure
    # against -- the same rule the Compose path applies at `wait = req.wait or
    # bool(pre.post_ready) or req.seed`.
    if job.req.wait or job.req.seed or bool(job.meta.extra.get("post_ready")):
        # wait_and_finalize, not bare wait_serving: it also finalizes the setup
        # wizard over REST and runs the preset's post_ready actions. Waiting and
        # stopping there left every self-configuring preset half-applied.
        job.result.update(ready.wait_and_finalize(job.meta, job.emit, timeout=600.0,
                                        final=False))
        job.result["ready"] = True
    # NOT when the caller seeds. `seed_here` means the CLI runs it after this returns,
    # so seeding here as well would seed the workspace twice -- the manifest only ever
    # adds, so the readback would report rooms holding more than planned and the second
    # pass would collide on names it had just created.
    if job.req.seed and not job.req.seed_here:
        job.result["seed"] = seeding.run_seed_inline(job.meta, job.req.seed_profile, job.req.stats, job.emit)
    # `--monitor` last, and only once the workspace is serving: attaching turns on
    # RC's own Prometheus_Enabled over REST, which needs a workspace that answers.
    # Ignoring the flag here is what `--seed` did, and it produced a create that
    # silently did less than it was asked for.
    if job.req.monitor:
        if not (job.req.wait or job.req.seed):
            ready.wait_serving(job.meta, job.emit, timeout=600.0)
        # An add-on failing does not un-create the workspace. The first live run of
        # this failed on the monitoring chart and exited 7 with `montest` up,
        # serving, and listed as running -- a create reported as failed while its
        # result was sitting there working. The workspace is the deliverable; say
        # what went wrong with the extra and name the command that retries it.
        try:
            job.result["monitoring"] = job.monitor_attach(job.repro_name, job.emit)
        except ReproError as exc:
            warn(job.emit, f"the workspace is up, but monitoring did not attach: {exc}",
                 phase="monitor")
            warn(job.emit, f"retry it with: houston monitor --name {job.repro_name}",
                 phase="monitor")
            job.result["monitoring"] = {"monitoring": False, "error": str(exc)}
    info(job.emit, f"{job.root}  admin / {job.meta.admin_pass}", phase="done", pct=100)
    return job.result


def _create_kubernetes(req: CreateReq, emit: Emit = null_emit, *, monitor_attach=request._missing_monitor_attach) -> dict:
    """The Kubernetes half of `_create_repro_locked`.

    Shares everything that is not runtime-specific -- name derivation, version
    resolution, the capacity refusal, host-port allocation, repro.json -- and
    delegates only the sequence that differs. A workspace created here is a
    workspace like any other: `list`, `info`, `logs` and `down` find it because it
    has a repro.json, which is what `runner.exists()` now looks for.
    """
    job = KubeCreate(req=req, emit=emit, monitor_attach=monitor_attach)
    _k8s_settle_name(job)
    _k8s_resolve_pairing(job)
    _k8s_settle_addressing(job)
    _k8s_plan_cluster(job)
    _k8s_plan_tls(job)
    _k8s_plan_kube_tls(job)
    _k8s_write_provisional_record(job)
    _k8s_create_the_workspace(job)
    _k8s_build_record(job)
    _k8s_record_the_request(job)
    _k8s_write_record(job)
    return _k8s_finish(job)
