"""Repro lifecycle orchestration shared by the CLI and the web API.

Extracted from cli.py so both front-ends run the identical flow. Functions raise
`rc_repro.errors` and report progress through `emit` (see services.events); they
never call typer / sys.exit / typer.confirm.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

from dataclasses import asdict

from rc_repro import compose, config, presets, rcapi, runner, versions
from rc_repro import seed as seeder
from rc_repro.errors import (AuthorityGateError, ConflictError, CreateFailedError,
                            DockerError, NotFoundError, NotReadyError,
                            PreflightError, ReproError, ValidationError)
from rc_repro.services import audit as auditsvc
from rc_repro.services import edge as edgesvc
from rc_repro.services import diagnose, postready, topology
# `_common` for its --set coercions, private module and all: this decides whether
# `presigned` is on, and the preset decides the same thing from the same string.
# Two readings of "true" is how they come to disagree.
from rc_repro.presets import _common
from rc_repro.services.events import Emit, info, null_emit, warn

_NAME_RE = re.compile(r"[^a-z0-9-]+")
# What sanitize() can produce, and therefore the only shape a real repro has.
_VALID_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
# The name becomes a directory entry (255 bytes on ext4/APFS) and a compose project
# name, and the generated container names add `rcrepro-<name>-<service>-1` on top.
# Unbounded, it passed validation and then raised ENAMETOOLONG from the filesystem
# -- a 500 from the web API and a raw traceback from the CLI. 64 leaves ample room
# for every suffix rc-repro appends and is longer than any real repro name.
NAME_MAX = 64

#: How long an INTERACTIVE mutator waits for the repro lock. repro_lock's own
#: default is 900s, which is right for a create or a restore queued behind
#: another -- and wrong for a button: nobody wants a Stop click to hang for
#: fifteen minutes rather than say "something else is working on this".
_INTERACTIVE_LOCK_WAIT = 60.0


def _require_valid_name(name: str) -> None:
    if not _VALID_NAME_RE.match(name):
        raise ValidationError(
            f"invalid repro name {name!r} (lowercase letters, digits and '-' only)")
    if len(name) > NAME_MAX:
        raise ValidationError(
            f"repro name is {len(name)} characters; the limit is {NAME_MAX} "
            "(it becomes a directory and a set of container names)")


# --- naming (pure) ------------------------------------------------------------

def sanitize(name: str) -> str:
    name = name.lower().replace(".", "-")
    return _NAME_RE.sub("-", name).strip("-")


def _warn_name_coerced(req: "CreateReq", emit: Emit) -> None:
    """Say so when `--name` is not the name the workspace gets.

    `sanitize` slugifies rather than refusing, which is right -- `TICKET-1234` and
    `ticket 1234` should both work -- but it was silent, and slugifying is not
    injective: `../escape` and `escape` both become `escape`, as do `a/b` and `a-b`.
    There is no traversal here (the result contains no separator) and no injection
    (nothing reaches a shell), but two different tickets could silently land on ONE
    workspace and share its data, which is the failure worth naming.
    """
    if not req.name:
        return
    became = sanitize(req.name)
    if became and became != req.name:
        warn(emit, f"--name {req.name!r} becomes {became!r} — a workspace name is a "
                   f"directory and a DNS label. Another name that reduces to "
                   f"{became!r} would be the same workspace, data included.",
             phase="create")


def derive_name(version: str, preset: str, actor: str = "") -> str:
    """The workspace name for a version+preset, namespaced by who asked.

    Without `actor` this returns the same name for everybody -- so on a shared
    server the second person to run `up -v 8.5.1` silently REUSED the first
    person's workspace, data and all, with no warning. Prefixing by the
    authenticated user makes two people running the same version two workspaces.

    Left off entirely on a single-user machine, where the prefix would be noise
    and would break every existing name.
    """
    base = "rc" + version
    if preset and preset != "default":
        base += "-" + preset
    if actor:
        base = f"{actor}-{base}"
    return sanitize(base)


def owner_prefix(name: str, actor: str) -> str:
    """`name` namespaced to `actor`, unless it already is.

    An explicit --name still wins, but on a shared server it has to be somebody's
    or two people typing `--name test` collide exactly as the derived names did.
    """
    if not actor:
        return name
    return name if name.startswith(f"{actor}-") else f"{actor}-{name}"


# --- preconditions ------------------------------------------------------------

def require_docker() -> None:
    """Refuse when the container engine is not answering.

    `DockerError`, not `NotReadyError`. The distinction is the whole point of the
    exit-code taxonomy: `NOT_READY` (exit 5, HTTP 409) means "it is coming up,
    poll again", and an absent engine is never that -- polling cannot start
    Docker. It is a preflight problem the caller must fix, so `ENGINE_UNAVAILABLE`
    (exit 3, HTTP 502): the dependency this tool sits on is not there.

    It matters more once a second topology exists: "the engine is not answering"
    will cover a missing cluster and an unreachable API server too, and those are
    the same kind of answer -- fix your environment -- not the same kind as a
    workspace that has not finished booting.
    """
    if not runner.docker_available():
        # Named for the platform, because "Start Docker Desktop" on Linux names a
        # product that is usually not the one installed -- and a reader who cannot
        # find the thing the error names tends to doubt the error, not the wording.
        starter = ("Start Docker Desktop" if sys.platform in ("darwin", "win32")
                   else "Start it with `sudo systemctl start docker`")
        raise DockerError(f"Docker isn't running. {starter} and try again.")
    # AND the compose plugin, because every path here shells out to `docker compose`
    # and a box can have one without the other. Reported from a fresh Amazon Linux EC2
    # instance where `docker ps` worked and `rc-repro up` died with docker's own
    # unhelpful pair:
    #
    #     docker: 'compose' is not a docker command.
    #     unknown shorthand flag: 'd' in -d
    #
    # `docker_available()` runs `docker info`, which says nothing about the plugin, so
    # the engine looked fine and the failure arrived from the middle of a create. It is
    # a preflight fault -- fix your environment -- so it is raised as one, once, with
    # the package to install.
    cv = runner.compose_version()
    major = cv.split(".")[0].lstrip("v") if cv else ""
    if not major.isdigit() or int(major) < 2:
        if cv:
            raise PreflightError(
                f"`docker compose` reports {cv}, and rc-repro needs v2 or newer. "
                "Upgrade the compose plugin, then `docker compose version`.")
        # NOT NECESSARILY ABSENT. The same binary is both the plugin and a standalone
        # `docker-compose`, so a box can have a working v2 on PATH while
        # `docker compose` does not exist -- the binary was never put where the docker
        # CLI looks. Seen on EC2, and "install the plugin" is the wrong instruction
        # there: it is installed, just not registered.
        standalone = runner.compose_standalone_version()
        if standalone:
            raise PreflightError(
                f"`docker compose` is not available, but a standalone "
                f"`docker-compose` {standalone} is on PATH — the binary is there and the "
                f"docker CLI cannot see it as a plugin. rc-repro calls `docker compose`, "
                f"so register it once:\n"
                f"    mkdir -p ~/.docker/cli-plugins\n"
                f"    ln -sf \"$(command -v docker-compose)\" "
                f"~/.docker/cli-plugins/docker-compose\n"
                f"  Then `docker compose version` should print {standalone}.")
        raise PreflightError(
            "`docker compose` v2 is not available — the plugin is not installed. "
            "Everything rc-repro does with containers goes through it."
            "\n  Amazon Linux / RHEL / Fedora: `sudo dnf install -y docker-compose-plugin`"
            "\n  Debian / Ubuntu:              `sudo apt-get install -y docker-compose-plugin`"
            "\n  Then `docker compose version`, and `rc-repro doctor` to check the rest.")


#: Rocket.Chat settled at 670-770 MB and MongoDB at 124-184 MB per workspace on
#: the host that OOMed -- so ~950 MB at REST. Rounded UP to 1100, deliberately:
#: those were idle figures, RC's Node heap reached 721 MB under a mild load test,
#: and calibrating to the resting case would have permitted exactly the seven
#: stacks that took the machine down. Matches design §8's "roughly 1.2 GB".
WORKSPACE_MB = 1100
#: Sidecars a preset adds. Keycloak (saml/oidc) is by far the largest.
PRESET_MB = {"saml": 450, "oidc": 450, "s3_minio": 120, "ldap": 80,
             "livechat": 60, "multi-instance": 400, "email": 40}
#: Prometheus + Grafana + Loki + the OTel collector + two exporters.
MONITORING_MB = 280

# Kubernetes costs on top of a workspace, and both are load-bearing for the same
# reason WORKSPACE_MB is: the formula that refuses a create has to know what it is
# about to start, or it refuses the wrong things and permits the fatal ones.
#
# CLUSTER_MB is MEASURED -- `docker stats kind-control-plane` reads 573 MiB idle on
# this box -- and is charged ONCE, only when the cluster still has to be created.
# Every workspace after that shares it.
CLUSTER_MB = 600

# KUBE_CHART_MB is what the CHART costs beyond the app itself, and it applies to
# both deployments. Measured, and it corrected an assumption: a "monolith" on this
# chart is FIVE pods, not two -- it runs NATS (two pods plus nats-box) regardless
# of `microservices.enabled`, which Compose's monolith does not. A live monolith
# workspace plus a fresh cluster took the host from 8322 MB available to 6351, so
# 1971 MB total with NATS still starting; against WORKSPACE_MB + CLUSTER_MB = 1700
# that leaves roughly this much unaccounted for.
KUBE_CHART_MB = 500

# MICROSERVICES_MB is now HALF measured, and the halves are worth separating.
#
# MEASURED: a microservices workspace on chart 7.0.2 is nine pods against a
# monolith's five, and the four extra are `account`, `authorization`,
# `ddp-streamer` and `presence`. Not five -- this chart version ships no
# `stream-hub` deployment, which the earlier estimate assumed it did.
#
# STILL ESTIMATED: what those four cost. The memory delta could NOT be measured,
# and the reason is worth recording so nobody trusts the number more than it
# deserves: both readings -- 1971 MB for the monolith, 1787 MB for microservices --
# were taken at readiness, while several pods were still ContainerCreating. They
# are early reads, they are within noise of each other, and the microservices one
# came out LOWER, which cannot be true. A real figure needs a settle-time wait and
# per-pod `docker stats`.
#
# So this is 4 pods x ~200 MB, and it stays deliberately on the generous side:
# under-charging lets through a create that OOMs a swapless host, where the kernel
# picks its own victim and destroys somebody else's work.
MICROSERVICES_MB = 800

#: Left unspent: for the OS, Docker, the page cache -- and, mostly, for GROWTH.
#: A fifth of the host, never below 1 GB.
#:
#: The proportion is the lesson from the incident. That box OOMed while
#: MemAvailable still read ~3.3 GB, because the danger is not the memory a
#: workspace takes at admission but the memory seven already-admitted ones take
#: an hour later: Rocket.Chat is Node, its heap grows with use, and a mild load
#: test alone pushed one to 721 MB. A fixed 1 GB reserve waved the fatal
#: configuration through when I tested it against the real numbers; a fifth
#: refuses it.
#:
#: This is why the check cannot be the only defence -- see the growth caveat in
#: check_capacity().
def host_reserve_mb(total_mb: int) -> int:
    return max(1024, total_mb // 5)


def capacity() -> dict:
    """How much room this machine has left, in workspaces.

    ONE formula, three consumers: `check_capacity` refuses a create with it,
    `rc-repro doctor` reports it, and the GUI's home page leads with it. They used
    to agree by coincidence -- doctor carried its own copy of the arithmetic -- and
    a home page that says "room for 2 more" while the create is refused is worse
    than one that says nothing.

    Megabytes are not the answer to the question anybody is asking. "3.2 GB
    available" does not tell you whether you can start another workspace; `room`
    does. Written after seven concurrent stacks OOM-killed a 10 GB host.
    """
    mem = runner.host_memory()
    if mem is None:                      # not Linux: say so rather than guess
        return {"known": False}
    total_mb, avail_mb, swap_mb = mem
    reserve = host_reserve_mb(total_mb)
    usable = max(0, avail_mb - reserve)
    # `room` IS DENOMINATED IN COMPOSE WORKSPACES, AND SAYS SO. It divided by
    # WORKSPACE_MB (1100) and was reported as the machine's capacity whatever runtime
    # the reader was about to use -- while a Kubernetes microservices workspace costs
    # 2400 plus 600 for a control plane, which `runtime_cost` already knows and this
    # function was never told. Observed in the same minute: doctor saying "4128 MB
    # available — room for about 1 more workspace" and `up --runtime kubernetes`
    # exiting 3 with "needs about 2400 MB and only 2144 MB is free to use". Exactly the
    # disagreement this docstring says the one formula exists to prevent.
    #
    # `room_by_runtime` is the honest answer, and `room` keeps its meaning for the
    # three existing consumers rather than changing under them.
    rooms = {}
    for label, runtime, deployment in (("docker", topology.DOCKER, ""),
                                       ("kubernetes-monolith", topology.KUBERNETES,
                                        topology.MONOLITH),
                                       ("kubernetes-microservices", topology.KUBERNETES,
                                        topology.MICROSERVICES)):
        cost = runtime_cost(runtime, deployment)
        per = int(cost["workspace_mb"]) or WORKSPACE_MB
        rooms[label] = max(0, usable - int(cost.get("cluster_mb") or 0)) // per
    return {"known": True, "total_mb": total_mb, "available_mb": avail_mb,
            "reserve_mb": reserve, "swap_mb": swap_mb,
            "workspace_mb": WORKSPACE_MB,
            "room": usable // WORKSPACE_MB,
            "room_denominated_in": "docker",
            "room_by_runtime": rooms}


def _kube_overhead_mb(req: "CreateReq", provisioning: bool = True) -> int:
    """What Kubernetes adds to a workspace's memory bill, in MB.

    Zero for Compose, which is every workspace today. The control plane is charged
    only when it still has to be created: it is shared, so billing it to the second
    and third workspace would refuse creates the host could actually hold -- and a
    capacity check that is wrong in the safe direction still stops people using the
    tool, which is how they learn to pass --force by reflex.
    """
    from rc_repro.services import topology
    if topology.normalize(getattr(req, "runtime", "")) != topology.KUBERNETES:
        return 0
    # The chart's own baseline, on both deployments -- see KUBE_CHART_MB.
    need = KUBE_CHART_MB
    # Charged when a control plane is about to be BUILT, which is the only case where
    # its memory is new. An earlier version charged unless rc-repro's own kind cluster
    # existed, on the reasoning that "somebody else's cluster being up does not mean
    # the control plane is already paid for" -- true while rc-repro always created its
    # own, and wrong as soon as it can use one that is already running, where the 600
    # MB is spent whatever this create does.
    if provisioning:
        need += CLUSTER_MB
    # An empty deployment means "that runtime's default", which for Kubernetes is
    # microservices -- the expensive one. Reading empty as free would under-charge
    # the common case, and `check_capacity` can be reached with an unresolved
    # request from `restore` and the GUI as well as from `up`.
    deployment = getattr(req, "deployment", "") or topology.DEPLOYMENTS[
        topology.KUBERNETES][0]
    if deployment == topology.MICROSERVICES:
        need += MICROSERVICES_MB
    return need


#: What the container ENGINE must have before a Kubernetes workspace is worth
#: starting: a control plane, the MongoDB operator or a StatefulSet, and on
#: microservices six more Rocket.Chat processes. Taken from PR #3, whose measured
#: floor these are; the value of them is not the numbers but WHERE they are read
#: from -- `docker info`, i.e. the VM, not `/proc/meminfo`.
ENGINE_FLOOR_CPUS = 4
ENGINE_FLOOR_MEMORY_GIB = 6.0


def _will_provision(req: "CreateReq") -> bool:
    """Whether this create is going to CREATE a cluster, as opposed to use one.

    The two capacity questions below both turn on it, and both used to ask something
    narrower that gave the wrong answer the moment rc-repro could use a cluster it did
    not make: `cluster_exists` is specifically OUR kind cluster, so a box whose k3s was
    about to be adopted was billed 600 MB for a control plane already running -- and
    `check_capacity` refusing a create the host can hold is how people learn to type
    --force by reflex.

    False on any doubt. An unprobeable cluster is not evidence that one will be built.
    """
    from rc_repro.services import topology
    if topology.normalize(getattr(req, "runtime", "")) != topology.KUBERNETES:
        return False
    try:
        from rc_repro.services import k8s
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
    rc-repro asking twice and refusing on the answer it did not repeat -- measured on
    a first run, where the whole command had to be retyped for it.

    Only from an EXPLICIT `--context`, never from the box default: a default cluster
    is a convenience for the Kubernetes work somebody already does, and letting it
    silently move `up` off Compose would change what an un-flagged command means for
    every workspace on the box.
    """
    from rc_repro.services import topology
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
    from rc_repro.services import topology
    if topology.normalize(getattr(req, "runtime", "")) == topology.KUBERNETES:
        # Only when it COSTS: a saved kind or k3s context being used by
        # `--runtime kubernetes` is the whole point of saving one, and warning about it
        # every time would train people to stop reading these.
        if _saved_default_is_billable(saved):
            warn(emit,
                 f"this workspace is going to {saved!r}, which costs money by the "
                 f"hour — it was chosen because it is this box's saved default "
                 f"cluster, not because this command named one. `--context <name>` "
                 f"names a cluster outright; `rc-repro config set "
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


#: Context-name shapes that identify a managed cluster without asking anything.
#: `aws eks update-kubeconfig` writes the cluster ARN as the context name and
#: `gcloud container clusters get-credentials` writes `gke_<project>_<zone>_<name>`,
#: so both name their own service. AKS is NOT here and cannot be: `az aks
#: get-credentials` writes the bare cluster name, which is indistinguishable from a
#: kind or k3s context -- so an AKS default is missed by this check rather than
#: guessed at, and a guess that called someone's k3s billable would be the worse
#: error of the two.
_BILLABLE_CONTEXT_PREFIXES = ("arn:aws:eks:", "gke_")


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


def _check_engine_floor(req: "CreateReq", emit: Emit = null_emit,
                        provisioning: bool = True) -> None:
    """Refuse a Kubernetes create the container engine is too small for.

    Compose is left alone: it runs two containers and works on a 2 GB VM, so a floor
    there would refuse creates that succeed today.

    Silent when the engine cannot be asked. An unreadable `docker info` is not
    evidence of a small VM, and a refusal on no evidence is the failure mode this
    whole family of checks has to avoid -- `up` already refuses for real capacity,
    and a second refusal nobody can explain is how people learn to pass --force by
    reflex.
    """
    from rc_repro.services import topology
    if topology.normalize(getattr(req, "runtime", "")) != topology.KUBERNETES:
        return
    # The floor's whole premise is that the container VM has to hold a control plane.
    # When the cluster is not one rc-repro is about to build in Docker -- an adopted
    # k3s, minikube, anything -- the premise is void and `docker info` is describing a
    # machine the workspace will not run on.
    if not provisioning:
        return
    cap = runner.docker_capacity()
    if cap is None:
        return
    cpus, mem_bytes = cap
    gib = mem_bytes / (1024 ** 3)
    short = []
    if cpus and cpus < ENGINE_FLOOR_CPUS:
        short.append(f"{cpus:.0f} CPUs (needs {ENGINE_FLOOR_CPUS})")
    if gib and gib < ENGINE_FLOOR_MEMORY_GIB:
        short.append(f"{gib:.1f} GiB of memory (needs {ENGINE_FLOOR_MEMORY_GIB})")
    if not short:
        return
    if getattr(req, "force", False):
        warn(emit, "the container engine is below the Kubernetes floor — "
                   + " and ".join(short) + ". Continuing because --force was given.",
             phase="preflight")
        return
    raise PreflightError(
        "the container engine has " + " and ".join(short) + ". A Kubernetes "
        "workspace needs a control plane, MongoDB and the chart, and below this it "
        "does not fail cleanly -- pods stay Pending with nothing naming memory. "
        "Raise the VM (Docker Desktop: Settings -> Resources; Podman: "
        "`podman machine set --cpus 4 --memory 6144`), or use --runtime docker. "
        "--force overrides this.")


def unsupported_fields(runtime: str) -> list[dict]:
    """What a runtime cannot honour, from the registry the create path enforces.

    Published so the create dialog can say it BEFORE somebody fills a field in --
    and, more to the point, so it cannot say it wrongly. The list has shrunk twice
    while the GUI's own copy of it would not have: `--reg-token` and every preset
    were on it until they were built. Two places deciding the same thing is how a
    form ends up refusing something that works, which is worse than not mentioning
    it at all.
    """
    from rc_repro.services import topology
    if topology.normalize(runtime) != topology.KUBERNETES:
        return []
    return [{"field": name, "why": why} for name, why in _KUBERNETES_UNSUPPORTED]


def runtime_cost(runtime: str, deployment: str = "") -> dict:
    """Roughly what one workspace costs, from the numbers `check_capacity` spends.

    The same constants, not a second set written for the screen: a card that quotes
    1.1 GB while the preflight reserves something else is a card that will be
    contradicted by the refusal it was meant to prevent. `cluster_mb` is charged
    separately because it is paid once per machine, not once per workspace.
    """
    from rc_repro.services import topology
    if topology.normalize(runtime) != topology.KUBERNETES:
        return {"workspace_mb": WORKSPACE_MB, "cluster_mb": 0, "shape": "2 containers"}
    deployment = deployment or topology.DEPLOYMENTS[topology.KUBERNETES][0]
    micro = deployment == topology.MICROSERVICES
    return {
        "workspace_mb": WORKSPACE_MB + KUBE_CHART_MB + (MICROSERVICES_MB if micro else 0),
        "cluster_mb": CLUSTER_MB,
        "shape": "9 pods" if micro else "5 pods",
    }


def check_capacity(req: "CreateReq", preset_name: str = "", emit: Emit = null_emit) -> None:
    """Refuse to create a workspace the host cannot hold.

    Written after seven concurrent stacks OOM-killed a 10 GB host with no swap:
    the kernel killed a Rocket.Chat process, load average hit 165, and the box had
    to be recovered. Every individual `up` had succeeded -- nothing anywhere asked
    whether there was room for one more, which is exactly the gap
    docs/design/team-server.md §8 recorded as "made visible, not solved".

    It cannot be the only defence, and should not be presented as one: the memory
    that kills a host is the memory workspaces take LATER, not at admission. This
    stops the obviously-doomed create and keeps the ceiling visible.

    AND THE OTHER DEFENCE THIS USED TO NAME DOES NOT EXIST. It read "container memory
    limits and enough RAM are what actually bound the total", and rc-repro sets no
    memory limit on anything: the generated compose file carries `ulimits.nofile` on
    MongoDB and nothing else -- no `mem_limit`, no `memswap_limit`, no `cpus`, no
    `deploy.resources` -- and `values_for` sets no chart `resources` either. `docker
    inspect` on a live workspace reports `NanoCpus=0 Memory=0`. So admission control is
    in fact the only defence, on a paragraph that says admission control is not enough.
    `perf/constrain.py` can cap a workspace, and only for the duration of a capacity
    run.

    Saying so rather than adding limits: a cap low enough to matter is a cap that
    OOM-kills a legitimately busy Rocket.Chat, and picking the number needs measurement
    across versions and deployment shapes rather than a guess made while fixing a
    docstring. What is fixed here is the claim.

    A REFUSAL rather than a warning, because the failure is not confined to the
    workspace being created: the OOM killer picks its own victim, so on a shared
    server this destroys a colleague's work. A warning would be advice nobody
    reads until after the machine is down. Overridable with --force, and the
    message says what to stop instead.
    """
    # The ENGINE's floor first, and it is a different question from the host's
    # headroom. On Linux the engine is the host and the two agree; on macOS and on
    # Podman the container VM has its own allocation, so a laptop with 32 GB and a
    # 4 GB VM passes every check below and then cannot run a Kubernetes workspace at
    # all -- the failure arriving later as pods that never schedule, which names
    # nothing a reader can act on.
    # Probed once and passed to both, because both ask the same question and the probe
    # talks to a cluster.
    provisioning = _will_provision(req)
    _check_engine_floor(req, emit, provisioning)
    mem = runner.host_memory()
    if mem is None:                     # not Linux: skip rather than guess
        return
    total_mb, available_mb, swap_mb = mem
    need = WORKSPACE_MB + PRESET_MB.get(preset_name, 0)
    if req.monitor:
        need += MONITORING_MB
    # A Kubernetes workspace is not a Compose workspace with a different label. It
    # brings a control plane if there is not one yet, and microservices runs six
    # more processes than a monolith -- charging it as Compose would let through
    # exactly the create this function exists to refuse.
    need += _kube_overhead_mb(req, provisioning)

    reserve = host_reserve_mb(total_mb)
    headroom = available_mb - reserve
    if need <= headroom:
        # Say so while it is still comfortable, so the ceiling is visible before
        # it is hit rather than only in the refusal.
        if headroom - need < WORKSPACE_MB:
            warn(emit, f"after this one, about {max(0, headroom - need)} MB is left "
                       f"— roughly {max(0, (headroom - need)) // WORKSPACE_MB} more "
                       "workspace(s). `rc-repro list` shows what is running.",
                 phase="create")
        return

    running = [m.name for m in runner.list_meta()]
    swap_note = ("\n  This host has NO SWAP, so there is no buffer at all: memory "
                 "pressure becomes an OOM kill rather than slowdown."
                 if swap_mb == 0 else "")
    if getattr(req, "force", False):
        # The docstring above has always said "Overridable with --force" and the
        # refusal below has always told the user to pass it -- and nothing here ever
        # read req.force, so the advertised way out did not exist. Following the
        # message produced the identical refusal, and on `up` --force ALSO means
        # "overwrite this repro", so obeying the advice risked destroying a workspace
        # while still being blocked. Same shape as the --https guard that was shipped
        # and dead: prose that describes behaviour nothing implements.
        #
        # It warns rather than passing silently, because this is the guard that
        # exists after an OOM took out a 10 GB host: overriding it has to stay
        # visible, especially on a shared server where the kernel picks the victim.
        warn(emit, f"--force: creating anyway, though this workspace wants about "
                   f"{need} MB and only {max(0, headroom)} MB is free to use."
                   f"{swap_note} If the host runs out, the OOM killer chooses what "
                   f"dies — which may be a colleague's workspace, not this one.",
             phase="create")
        return
    raise PreflightError(
        f"not enough memory: this workspace needs about {need} MB and only "
        f"{max(0, headroom)} MB is free to use "
        f"({available_mb} MB available, {reserve} MB kept for the OS, Docker and "
        f"the page cache, {total_mb} MB total).{swap_note}\n"
        f"  {len(running)} workspace(s) exist: {', '.join(running[:6]) or 'none'}"
        f"{' …' if len(running) > 6 else ''}\n"
        "  Free some memory first — `rc-repro stop --name <it>` keeps the data:\n"
        "    rc-repro list\n"
        "  Or override this check if you are sure:  --force")


def name_candidates(name: str, actor: str = "") -> list[str]:
    """The workspaces `name` could mean, best match first.

    Creation TRANSFORMS what you type -- `sanitize()` always, and the owner prefix
    when there are accounts -- so resolution has to apply the same transforms or
    the name never round-trips. It did not, and in two separate ways:

      up   --name TICKET-1234  ->  creates 'ticket-1234'   (sanitize)
      down --name TICKET-1234  ->  ValidationError         (validate, no sanitize)

    which broke the README's own first example on a plain single-user install,
    and then:

      up   --name test         ->  creates 'alice-test'    (owner prefix)
      down --name test         ->  NotFoundError

    once any account existed. The first is older than the team work; the prefix
    only widened it. Both are the same bug -- create and resolve disagreeing about
    what a name means -- so both are fixed by deriving the candidates the same way.

    Order matters, and is: what you typed, then what creating it would have made,
    then the bare sanitized form.

      * exact first, so a full name always wins -- `alice-test` resolves to itself
        rather than being prefixed again, and a colleague's `bob-rc8-5-1` is
        reachable by typing it;
      * the OWNER-PREFIXED form before the bare one, because that is what `up`
        would target. With both `ticket-1234` (made before accounts) and
        `alice-ticket-1234` present, `--name TICKET-1234` has to mean the same
        workspace here as it does there, or the round trip is broken again in a
        subtler way;
      * the bare form last, so pre-accounts workspaces stay reachable.
    """
    out: list[str] = []
    # Only if it is already a legal name: this one is used as a filesystem path,
    # and the sanitized forms below are safe by construction while raw input is
    # not ('../../x' must never be probed as a path).
    if _VALID_NAME_RE.match(name or "") and len(name) <= NAME_MAX:
        out.append(name)
    clean = sanitize(name or "")
    if actor and clean:
        prefixed = owner_prefix(clean, actor)
        if prefixed not in out:
            out.append(prefixed)
    if clean and clean not in out:
        out.append(clean)
    return out


def require_engine(target: str) -> None:
    """Require the engine THIS workspace runs on -- not the one Compose needs.

    `require_docker()` was called before anything looked at the runtime, so every
    Kubernetes path went through a gate it has no use for. On a host with no Docker
    at all -- which is the documented adopt-an-existing-cluster setup -- `upgrade`,
    `upgrade --rollback`, `ready`, `logs`, `token`, `api`, `pat`, `seed` and `down`
    all refused a perfectly healthy workspace with "Docker isn't running".

    `teardown` is the sharpest case: it dispatches on the runtime *inside* itself,
    under a comment about a workspace that "could be CREATED and never removed" --
    and the gate three lines above defeated that dispatch entirely.

    Three modules already got this right and said so in comments (`backup.py`,
    `monitor.py`, and `envvars.py`, which refuses Kubernetes outright rather than
    dispatching). Nobody generalised it, so each new call site started from the
    Compose assumption again. This is that generalisation; the inline versions in
    those three predate it and do the same thing.

    CONTRACT: `target` is an already-resolved workspace name. `resolve_name` reads
    repro.json and asks no engine anything, so resolving first costs nothing and is
    what makes a runtime-aware gate possible at all.
    """
    if topology.of_repro(target) != topology.KUBERNETES:
        require_docker()
        return
    # kubectl is the engine here. Said rather than assumed: without it every
    # Kubernetes operation fails one layer deeper, in a subprocess whose "command
    # not found" names nothing the reader can act on.
    if not shutil.which("kubectl"):
        raise PreflightError(
            f"{target!r} runs on Kubernetes and `kubectl` is not on PATH, so "
            f"rc-repro cannot reach it. Install kubectl and make sure your "
            f"kubeconfig points at the cluster this workspace lives in.")


def resolve_name(name: str | None, actor: str = "") -> str:
    """Explicit name (must exist) else the configured default (must exist).

    `actor` lets a name typed without the owner prefix find the workspace it
    created; without one this behaves exactly as it did before accounts existed.
    """
    if name:
        for candidate in name_candidates(name, actor):
            if runner.exists(candidate):
                return candidate
        # Nothing matched. Report the shape problem when there is one -- "invalid
        # name" is more use than "not found" for `--name 'my repro!'` -- and
        # otherwise say what was looked for, in the form it would have been made.
        _require_valid_name(sanitize(name) or name)
        raise NotFoundError(f"no repro named {name!r} (run `rc-repro list`)")
    default = config.load_config().get("default_repro")
    if not default:
        raise ValidationError("no name given and no default repro set (use `rc-repro use <name>`)")
    _require_valid_name(default)
    if not runner.exists(default):
        raise NotFoundError(f"default repro {default!r} no longer exists; set another with `rc-repro use`")
    return default


# --- port accounting ----------------------------------------------------------

def own_ports(name: str) -> set[int]:
    if not name or not runner.exists(name):
        return set()
    try:
        m = runner.read_meta(name)
    except Exception:  # noqa: BLE001 - half-written record
        return set()
    own = {m.host_port}
    n = m.extra.get("instances") if isinstance(m.extra, dict) else None
    if isinstance(n, int) and n > 1:
        own.update(m.host_port + i for i in range(1, n + 1))
    # tls_ports too, or `up --force --https` on an existing repro would not
    # recognise its OWN TLS port as reusable and would drift to the next one --
    # leaking a port number on every recreate, and changing the URL each time.
    for key in ("sidecar_ports", "monitoring_ports", "tls_ports"):
        claimed = m.extra.get(key) if isinstance(m.extra, dict) else None
        if isinstance(claimed, list):
            own.update(int(p) for p in claimed if isinstance(p, int) or str(p).isdigit())
    return own


def check_sidecar_ports(pre: presets.Preset, exclude: str = "") -> None:
    if not pre.ports:
        return
    wanted = set(pre.ports)
    own: set[int] = set()
    for m in runner.list_meta():
        claimed = set(m.extra.get("sidecar_ports") or []) if isinstance(m.extra, dict) else set()
        if m.name == exclude:
            own = claimed
            continue
        overlap = sorted(claimed & wanted)
        if overlap:
            raise ConflictError(
                f"preset {pre.name!r} publishes port(s) {overlap}, already claimed by "
                f"repro {m.name!r} - delete it first: rc-repro down --name {m.name} --volumes")
    for p in sorted(wanted - own):
        if not runner.port_free(p):
            raise ConflictError(f"preset {pre.name!r} needs host port {p}, already in use on this machine")


def check_monitor_ports(exclude: str = "") -> None:
    wanted = set(config.MONITOR_PORTS)
    own: set[int] = set()
    for m in runner.list_meta():
        claimed = set(m.extra.get("monitoring_ports") or []) if isinstance(m.extra, dict) else set()
        if m.name == exclude:
            own = claimed
            continue
        overlap = sorted(claimed & wanted)
        if overlap:
            raise ConflictError(f"monitoring needs port(s) {overlap}, already used by repro {m.name!r} "
                                f"(its monitoring) - stop it first: rc-repro monitor --name {m.name} --off")
    for p in sorted(wanted - own):
        if not runner.port_free(p):
            raise ConflictError(f"monitoring needs host port {p}, already in use on this machine")


#: The lock name port allocation serialises on. `repro_lock` is PER REPRO, and two
#: creates for two different names hold two different locks -- so both could read
#: `used_ports()`, see the same gap and pick the same port, and the heavy pool allows at
#: least two creates at once by design. A box-wide name (no workspace is called this;
#: `_require_valid_name` would reject the leading underscore) makes allocation the one
#: cross-workspace critical section it has to be.
_PORT_LOCK = "_ports"


def pick_host_port(port: int, pre: presets.Preset, exclude: str = "") -> int:
    """Choose a free host port, serialised box-wide.

    Held only for the choice, not for the create: the window that matters is between
    reading `used_ports()` and the caller writing its own record, and the record is
    written by `create_repro` while it still holds its own per-repro lock. Two locks
    rather than one, because holding a box-wide lock across a whole create would
    serialise every concurrent workspace and defeat the heavy pool entirely.
    """
    with runner.repro_lock(_PORT_LOCK, timeout=_INTERACTIVE_LOCK_WAIT):
        return _pick_host_port_locked(port, pre, exclude)


def _pick_host_port_locked(port: int, pre: presets.Preset, exclude: str = "") -> int:
    span = pre.instances + 1 if pre.instances > 1 else 1
    if port:
        if port + span - 1 > runner.PORT_MAX:
            raise ValidationError(f"--port {port}: a {pre.instances}-instance repro needs ports "
                                  f"up to {port + span - 1} (past 65535)")
        own = own_ports(exclude)
        used = runner.used_ports() - own
        for p in range(port, port + span):
            if p in used:
                raise ConflictError(f"port {p} is already claimed by another repro (see `rc-repro list`)")
            if p not in own and not runner.port_free(p):
                raise ConflictError(f"port {p} is already in use on this machine")
        return port
    try:
        return runner.pick_port_range(span) if span > 1 else runner.pick_port()
    except RuntimeError as exc:
        raise ConflictError(str(exc)) from exc


def owner_of(name: str) -> str:
    """Who owns `name` NOW, or "" for a pre-team workspace or one that is gone.

    `owner` wins over `created_by`, which is deliberately immutable: who made a
    workspace is a fact about the past and stays in the record, while who is
    responsible for it today is a thing that changes when a ticket is handed
    over. Before this, "belongs to alice" kept warning bob about data that had
    been his for a week -- which teaches people to click through the warning.
    """
    try:
        meta = runner.read_meta(name)
    except Exception:
        return ""
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    return extra.get("owner") or extra.get("created_by", "")


def set_owner(name: str, to: str, *, by: str = "") -> dict:
    """Hand a workspace over. Returns {name, from, to}.

    Ownership is a real verb because the workflow team-server.md §3.3 was written
    around -- support engineers handing tickets to each other -- was never
    modelled at all: the record only ever knew who typed `up`.
    """
    target = resolve_name(name)
    # Enforced HERE, beside the mutation, exactly as teardown() enforces
    # may_destroy: the CLI and the GUI both reach this function, and a check at
    # either front end alone would leave the other open.
    allowed, why = may_chown(target, by or auditsvc.actor())
    if not allowed:
        auditsvc.record("chown", target, outcome="denied")
        raise ConflictError(why)
    to = (to or "").strip().lower()
    if not to:
        raise ValidationError("no new owner given (--to <name>)")
    from rc_repro.services import users as usersvc
    if usersvc.any_users() and not usersvc.role_of(to):
        raise NotFoundError(
            f"no account named {to!r} (see `rc-repro users list`) — a workspace "
            "cannot be handed to somebody who cannot sign in")
    was = owner_of(target)

    def mutate(meta):
        extra = meta.extra if isinstance(meta.extra, dict) else {}
        history = list(extra.get("owner_history") or [])
        history.append({"from": was, "to": to, "by": by or auditsvc.actor(),
                        "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        extra["owner"] = to
        extra["owner_history"] = history[-20:]
        meta.extra = extra

    runner.update_meta(target, mutate)
    auditsvc.record("chown", f"{target} {was or '-'} -> {to}")
    return {"name": target, "from": was, "to": to}


def _derive_for(req: "CreateReq") -> str:
    """The workspace name for this request. Used twice -- by the lock wrapper and
    by the body -- so they cannot drift apart and lock a different repro than the
    one being written."""
    if req.name:
        return sanitize(owner_prefix(sanitize(req.name), req.actor))
    return derive_name(req.version, req.preset, req.actor)


# --- create -------------------------------------------------------------------

@dataclass
class CreateReq:
    version: str
    preset: str = "default"
    name: str = ""
    port: int = 0
    root_url: str = ""
    bind: str = ""
    rc_image: str = ""
    mongo: str = ""
    reg_token: str = ""
    params: dict = field(default_factory=dict)
    seed: bool = False
    #: "The CALLER will run the seed, not create_repro." The CLI seeds after
    #: `create_repro` returns so it can render the verification table and honour
    #: `--verify-seed`; the GUI lets the service do it. Both must still record the
    #: seed in the write-ahead note, or `ready` cannot finish an interrupted create --
    #: which is what happened when the CLI passed `seed=False` to hide its intent.
    seed_here: bool = False
    seed_profile: str = "small"
    pin: bool = False
    wait: bool = False
    offline: bool = False
    no_pull: bool = False
    fresh: bool = False
    force: bool = False
    monitor: bool = False
    stats: bool = False
    # The three axes (services/topology.py). Empty/0 means "that runtime's
    # default", never "unset but meaningful" -- resolve_axes turns them into
    # canonical values, and writes the deployment back out as a preset + params so
    # the rest of create is unchanged.
    runtime: str = ""
    deployment: str = ""
    replicas: int = 0
    #: WHICH cluster, for `--runtime kubernetes`. Empty means "decide for me" and
    #: keeps `plan_cluster`'s existing four steps; naming one ADOPTS it and never
    #: provisions -- see `k8s.plan_cluster` step 0 for why that asymmetry is the whole
    #: safety property rather than a convenience.
    #:
    #: PRIVILEGED (see PRIVILEGED_CREATE_FIELDS). Choosing the cluster a workspace
    #: lands in is the same class of decision as `rc_image` ("what code runs") and
    #: `bind` ("where it listens"), and on a shared `serve` it can point a colleague's
    #: workspace at a cluster they cannot see.
    context: str = ""
    # Kubernetes only. The operator brings SCRAM auth and owns the MongoDB
    # bootstrap; it is opt-in because its default would replace a path proven on a
    # live cluster with one that is not. See services/k8s.py.
    mongo_operator: bool = False
    # HTTPS. Two ways in, matching the official docs' DOMAIN + LETSENCRYPT_EMAIL:
    #   --domain [+ --email]  a Let's Encrypt certificate for a public hostname
    #   --https               a certificate from rc-repro's own local CA, no domain
    https: bool = False
    domain: str = ""
    acme_email: str = ""
    # Not a flag: `rc-repro config set acme.staging true`. Let's Encrypt allows 5
    # failed validations per hostname per hour, so a way to rehearse has to exist --
    # but it is not part of the everyday two-flag path.
    acme_staging: bool = False
    # Derived by _pick_challenge, never asked for: dns-01 when provider credentials
    # exist, otherwise the inbound TLS-ALPN-01 the official compose uses.
    acme_challenge: str = "tlsalpn"
    acme_dns_provider: str = ""
    # Kubernetes only, and only when a cluster has more than one. An EKS cluster
    # carrying both `alb` and `nginx` had the choice made by whichever the API server
    # listed first, and the two behave differently for ACME http-01 solving. Empty
    # means "the cluster's own default class, else the first by name" -- see
    # `k8s.ingress_classes`.
    ingress_class: str = ""
    # `up --env KEY=VALUE`. Merged over the preset's env; a None value removes a key.
    env: dict = field(default_factory=dict)
    # Who asked for this, when the GUI has named accounts. Namespaces the derived
    # workspace name so two people can run the same version, and is recorded on the
    # workspace so `list` can show who owns what.
    actor: str = ""
    # Set by _resolve_tls: TLS-ALPN is validated by Let's Encrypt CONNECTING here,
    # so --domain has to publish on a public interface. Derived, not asked for --
    # an explicit --bind always wins.
    bind_public: bool = False


def _tls_from_record(name: str) -> "tuple[bool, str] | None":
    """(https, domain) an EXISTING workspace was created with, or None.

    Read from repro.json rather than remembered in the request, because the `up`
    that brings a workspace back is a different invocation -- usually a different
    day -- from the one that gave it a name.
    """
    if not name or not runner.exists(name):
        return None
    try:
        meta = runner.read_meta(name)
    except Exception:  # noqa: BLE001 - half-written record
        return None
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    mode = extra.get("tls")
    if not mode or not meta.public_url:
        return None
    from rc_repro import tls as tlsmod

    if mode == tlsmod.MODE_LOCAL:
        return (True, "")
    host = meta.public_url.split("://", 1)[-1].split("/", 1)[0]
    return (False, host) if host else None


def _resolve_tls(req: CreateReq, repro_name: str, bind_host: str, exclude: str = "",
                 emit: Emit = null_emit):
    """Turn the --https flags into a tls.TlsSpec, or None when --https is absent.

    Validates here rather than letting Traefik fail at boot: a bad combination
    otherwise produces a repro that comes up and serves nothing, with the reason
    only in `docker compose logs traefik`.
    """
    # A domain means HTTPS; requiring --https alongside it was ceremony. --https on
    # its own selects the local-CA mode, which needs nothing else.
    if not (req.https or req.domain or req.acme_email):
        # ...unless this workspace ALREADY has an https name. `down` then `up` is
        # the documented way to bring a workspace back ("data intact"), and it
        # silently dropped TLS: the record went on claiming public_url while
        # nothing served it. Harmless to re-derive, because the name and the
        # certificate both live outside the workspace -- restoring it is writing a
        # route file, where before it would have meant rebuilding a Traefik.
        restored = _tls_from_record(exclude or repro_name)
        if restored is None:
            return None
        req.https, req.domain = restored
        if not (req.https or req.domain):
            return None
        info(emit, f"restoring the https name this workspace already had"
                   f"{' (' + req.domain + ')' if req.domain else ''}", phase="tls")

    from rc_repro import tls as tlsmod

    # Normalized before anything else reads it: it becomes ROOT_URL, the Host()
    # router rule and a TLS SNI name, so a scheme or trailing slash surviving this
    # far corrupts all three at once.
    domain, fixed = (tlsmod.normalize_domain(req.domain) if req.domain else ("", ""))
    if fixed:
        req.domain = domain          # so downstream and repro.json agree with reality

    cfg = config.load_config()
    if domain:
        mode = tlsmod.MODE_ACME
        # DOMAIN + LETSENCRYPT_EMAIL, the two the official compose asks for. The
        # email is remembered so only the first run needs it.
        req.acme_email = req.acme_email or str(cfg.get("acme_email") or "")
        if not req.acme_email:
            raise ValidationError(
                "a Let's Encrypt certificate needs a contact email:\n"
                "  rc-repro up ... --domain " + domain + " --email you@example.com\n"
                "It is remembered after the first use, or set it once with:\n"
                "  rc-repro config set acme.email you@example.com")
        # `config.truthy`, not `bool`: a config written by an older rc-repro holds the
        # STRING "false", which bool() reads as True -- so staging could never be
        # turned back off. See config.truthy for the measurement.
        req.acme_staging = req.acme_staging or config.truthy(cfg.get("acme_staging"))
        _pick_challenge(req, cfg, emit)
    else:
        mode = tlsmod.MODE_LOCAL

    # The workspace stays on loopback whatever the challenge. It publishes no TLS
    # port at all now, so there is nothing for Let's Encrypt to connect TO here --
    # the EDGE answers the TLS-ALPN challenge on 443, for every name it serves.
    # Widening a workspace's bind (these run fixed weak credentials) for a
    # challenge that no longer reaches it would expose them for nothing.
    req.bind_public = False

    host = domain or tlsmod.local_host_for(repro_name)
    # Every name answers on the edge's 443. No port is allocated per workspace and
    # no port is probed: this workspace terminates no TLS, so there is nothing to
    # conflict with. That deletes the whole port-443 arbitration -- the conflict
    # error, the `own_ports` exemption, `_pick_tls_port`, and the http-redirect
    # probe, which the edge does once for every name instead of each workspace
    # fighting over :80.
    port = 443

    # ONE NAME, ONE WORKSPACE. Both runtimes come through here, so this is the single
    # place the collision can be refused -- and `exclude` already carries the
    # workspace that is allowed to re-claim its own name.
    taken = edgesvc.host_owner(host, excluding=exclude or repro_name)
    if taken:
        raise ConflictError(
            f"{host} is already served for workspace {taken!r}, and the edge routes by "
            f"hostname -- two claims on one name means Traefik picks one and the other "
            f"silently never answers. Use a different name, or `rc-repro down --name "
            f"{taken}` first.")

    return tlsmod.TlsSpec(
        mode=mode, host=host, port=port, acme_email=req.acme_email,
        acme_staging=req.acme_staging, acme_challenge=req.acme_challenge,
        acme_dns_provider=req.acme_dns_provider)


def _pick_challenge(req: CreateReq, cfg: dict, emit: Emit = null_emit) -> None:
    """Choose the ACME challenge. Not a flag -- there is a right answer.

    TLS-ALPN-01 is the default and what the official compose uses. It needs Let's
    Encrypt to reach this host on 443, which is impossible behind NAT, behind a
    tunnel, or behind a proxy that terminates TLS in front of the origin.

    dns-01 needs none of that: the provider's API writes a TXT record and Let's
    Encrypt never connects here. So it is selected exactly when credentials for it
    exist, which is the only signal that says "the operator set this up on purpose".
    """
    from rc_repro import tls as tlsmod

    if not tlsmod.dns_env_vars():
        req.acme_challenge = "tlsalpn"
        return
    provider = str(cfg.get("acme_dns_provider") or "")
    if not provider:
        provider, why = tlsmod.infer_dns_provider()
        if not provider:
            # Credentials are present but unreadable as a provider. Falling back to
            # tlsalpn silently would ignore a file the user deliberately created.
            raise ValidationError(
                f"{tlsmod.dns_env_path()} exists, so dns-01 was assumed, but the "
                f"provider could not be worked out: {why}.\n"
                f"  Name it with `rc-repro config set acme.dns_provider <name>` — "
                f"providers and their variables: {tlsmod.LEGO_PROVIDER_DOCS}\n"
                f"  Or delete the file to use the inbound challenge instead.")
    ok, detail = tlsmod.dns_credentials(provider)
    if not ok:
        raise ValidationError(detail)
    req.acme_challenge = "dns"
    req.acme_dns_provider = provider
    info(emit, f"using the dns-01 challenge via {provider} ({detail}) — no inbound "
               "connection needed, so the workspace stays on loopback", phase="tls")


def _unknown_params(params: dict, pre: presets.Preset) -> list[str]:
    return sorted(set(params) - set(pre.params_help))


#: Presets that hand the BROWSER a hostname, and the `--set` param that carries it.
#: Each default names THIS machine -- `localhost:8081`, `keycloak:8085`, `minio:9000`
#: -- which is right on a laptop and wrong on every shared install, where it names
#: the visitor's own machine instead. The value is not the container network's
#: business; it is whatever the person typing actually uses.
_BROWSER_HOST_PARAM = {"saml": "idp_host", "oidc": "idp_host", "s3_minio": "s3_host"}


def _requested_bind_host(req: "CreateReq") -> str:
    """The interface these ports will be published on, as far as is known this early.

    `req.bind_public` can still widen it later -- `_resolve_tls` sets that when an
    ACME challenge needs the host reachable -- so this is the REQUESTED bind, not the
    final one. Callers that must not over-promise use it in the conservative
    direction: loopback here means "do not assume anything is reachable".
    """
    cfg = config.load_config()
    return str(req.bind or cfg.get("bind_host") or config.DEFAULT_BIND_HOST)


#: Binds from which nothing off this machine can reach a published port.
_LOOPBACK_BINDS = ("127.0.0.1", "localhost", "::1", "")


def reachable_beyond_loopback(*, tlsspec=None, bind_host: str = "") -> bool:
    """Whether anything off this machine can reach this workspace.

    This is the ONE question `config.ADMIN_PASSWORD` turns on.
    `config.DEFAULT_BIND_HOST`'s own comment states the threat model: loopback is
    WHY a fixed weak credential is acceptable at all. Both ways of removing that
    premise are here, and they are genuinely different mechanisms -- a public name
    reaches Rocket.Chat through the edge while the workspace itself stays on
    loopback, so the bind check alone answers "no" for the very case that matters
    most, which is exactly how `--domain` came to be created in silence.

    A LOCAL-CA `--https` name is deliberately NOT public: `<name>.rcrepro.localhost`
    resolves to 127.0.0.1, nothing off the box can reach it, and treating it as
    exposed would rotate the password for the common local case for no gain.
    """
    from rc_repro import tls as _tlsmod          # lazy, as everywhere else here
    if tlsspec is not None and getattr(tlsspec, "mode", "") == _tlsmod.MODE_ACME:
        return True
    return bind_host not in _LOOPBACK_BINDS


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


def _guard_project_collision(name: str) -> None:
    """Refuse to create when a docker compose project of the same derived name
    already exists but belongs to a DIFFERENT workspace.

    The project name is `rcrepro-<name>` regardless of RC_REPRO_HOME, so a repro
    named after an existing one in another home would make `docker compose up`
    reconcile (hijack) the other workspace's containers/volume. Best-effort: if
    docker can't be queried, skip the check rather than block."""
    existing = runner.project_config_files()
    if not existing:
        return
    proj = runner.project_name(name)
    if proj not in existing:
        return
    ours = str(runner.workspace(name) / "docker-compose.yml")
    files = existing[proj]
    if ours not in files:
        raise ConflictError(
            f"a docker compose project {proj!r} already exists, owned by a different "
            f"workspace ({files or 'unknown'}). Creating {name!r} here would hijack its "
            "containers and data volume - choose a different --name.")


def login(meta: runner.Metadata) -> rcapi.Auth:
    """THE admin login every service function goes through.

    `password=` is not optional here even though `rcapi.login` has a default. The
    default is the shared loopback `admin123`, and a workspace with a public name
    has its own -- so leaving it off would authenticate `pat`, `api`, `seed`,
    `loadtest`, `monitor`, `upgrade` and readiness with the wrong password and
    return a 401 that names nothing.
    """
    return rcapi.login(meta.root_url, password=meta.admin_pass,
                       mailpit_url=meta.extra.get(config.EXTRA_MAILPIT_URL))


def create_repro(req: CreateReq, emit: Emit = null_emit, *, stream_output: bool = False) -> dict:
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
    req.runtime = infer_runtime(req)
    _say_where_this_is_going(req, typed_runtime, emit)

    name = _derive_for(req)
    if not name:
        raise ValidationError(
            f"name {req.name!r} contains no usable characters (want a-z, 0-9, '-')")
    _require_valid_name(name)
    # A CREATE THAT NEVER FINISHES LEAVES A WORKSPACE THAT LOOKS FINE. Measured by
    # killing one mid-flight: `docker compose up -d` has already detached, so the
    # containers come up on their own and `list` reports it `running` -- which is true.
    # What is lost is everything after readiness: the preset's self-configuration, the
    # seed, the edge route. So a `saml` workspace can be serving with no IdP
    # certificate and nothing anywhere says the create stopped early.
    #
    # Advisory rather than repaired automatically: finishing it means waiting for
    # Rocket.Chat to serve and then running post_ready, which can take the full
    # readiness timeout, and `serve`'s startup must not hold the GUI shut for that.
    # `rc-repro ready --name <it>` is the same work on demand and clears this note.
    with runner.repro_lock(name):
        from rc_repro.services import journal
        # WHAT THE NOTE HAS TO CARRY. `ready` is the command the note tells people to
        # run, and it could not finish a seed because the request that asked for one
        # died with the process -- `req.seed` lives in a CreateReq nobody can read any
        # more, and meta.extra["seed"] is written only AFTER a seed succeeds. So the
        # note said "may be running without its preset configuration or seed data",
        # `ready` ran post_ready, seeded nothing, printed "ready" and CLEARED the note.
        # That is worse than leaving it: the engineer follows the tool's own
        # instruction, is told the workspace is complete, doctor agrees, and the
        # evidence that anything was missing has been deleted.
        note = journal.record(journal.CREATE_UNFINISHED, name,
                              seed=bool(req.seed),
                              seed_here=bool(req.seed_here),
                              seed_profile=str(req.seed_profile or ""),
                              seed_stats=bool(req.stats))
        try:
            out = _create_repro_locked(req, emit, stream_output=stream_output)
        except BaseException:
            # A REFUSAL CREATED NOTHING, so it must leave nothing. Without this the
            # note survived every kind of refusal -- a bad version, a taken port, a
            # capacity preflight, a namespace-ownership check, a Kubernetes-unsupported
            # flag -- one per attempt, and `doctor` then warned about a workspace that
            # does not exist while telling the reader to run `rc-repro ready` on it,
            # which exits 4. The write-ahead note is for a create that died HALF WAY,
            # which is a different thing from one that never started.
            journal.clear(note)
            raise
        # EVERY note for this workspace, not just the one written above: an earlier
        # create that failed left its own, and clearing only ours left that one
        # claiming a finished workspace had never finished.
        #
        # UNLESS THE CALLER STILL HAS WORK TO DO. With `seed_here` the CLI runs the
        # seed after this returns, so clearing here would delete the note in the
        # window it exists for -- a kill between these two points leaves a workspace
        # serving with no seed and nothing recording it. `cli.up` clears it once the
        # seed is done.
        if not req.seed_here:
            journal.clear(note)
            journal.clear_kind(journal.CREATE_UNFINISHED, _derive_for(req) or name)
        return out


def _create_repro_locked(req: CreateReq, emit: Emit = null_emit, *,
                         stream_output: bool = False) -> dict:
    # An existing workspace's RECORDED runtime beats the flag default. Without this,
    # `rc-repro up -v 8.5.1 --name X` on a Kubernetes workspace defaulted to docker
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
    existing = _derive_for(req)
    if not req.runtime and existing and runner.exists(existing):
        req.runtime = topology.of_repro(existing)
    # Runtime x deployment x scenario, decided before anything else looks at the
    # request. The resolved axes are written BACK onto `req` as a preset name and
    # `--set` params, so every reader below -- name derivation, the preset loader,
    # capacity, repro.json -- is untouched and `--deployment multi-instance
    # --replicas 3` reaches compose.build by the exact path `--preset
    # multi-instance --set instances=3` always did.
    axes = topology.resolve_axes(runtime=req.runtime, deployment=req.deployment,
                                 replicas=req.replicas, preset=req.preset,
                                 params=req.params)
    topology.require_registered(axes.runtime)
    for hint in axes.hints:
        info(emit, hint, phase="plan")
    req.preset, req.params = axes.preset, axes.params
    req.runtime, req.deployment, req.replicas = (axes.runtime, axes.deployment,
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
    _derive_idp_host(req, emit)

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
        _refuse_unsupported_on_kubernetes(req)
        return _create_kubernetes(req, emit=emit)
    require_docker()
    cfg = config.load_config()

    try:
        resolved = versions.resolve(req.version, offline=req.offline)
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
    if getattr(resolved, "source", "") == "map (no such release)":
        warn(emit, f"releases.rocket.chat has no {req.version} — the pairing below "
                   f"comes from the shipped map, and the image pull will fail unless "
                   f"this tag really exists (`rc-repro versions {req.version}`).",
             phase="resolve")
    if req.rc_image or cfg.get("rc_image"):
        resolved.rc_image = req.rc_image or cfg["rc_image"]
    if req.mongo:
        versions.apply_mongo_override(resolved, req.mongo)

    # Before any docker work: this pairing cannot boot on this engine, and mongod
    # says so by exiting with a message that reads like a permission fault. `doctor`
    # has known the rule for a while and could only warn, because it does not know
    # which version you are about to ask for; here the pairing is resolved, so the
    # answer is exact. Imported inside the function -- doctor imports this module.
    from rc_repro.services import doctor as doctorsvc
    conflict = doctorsvc.mongo_kernel_conflict(resolved.mongo_tag)
    if conflict:
        raise PreflightError(conflict)

    try:
        pre = presets.load(req.preset, req.params)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    unknown = _unknown_params(req.params, pre)
    if unknown:
        valid = ", ".join(sorted(pre.params_help)) or "(this preset takes no --set params)"
        raise ValidationError(
            f"unknown --set param(s) for preset {req.preset!r}: {', '.join(unknown)} - valid: {valid}")

    wait = req.wait or bool(pre.post_ready) or req.seed
    repro_name = _derive_for(req)
    _warn_name_coerced(req, emit)
    # Before any docker work, and only for a workspace that does not exist yet:
    # `up` on an existing one reuses its containers and adds nothing.
    # `--force` is NOT a reason to skip this. check_capacity() has its own force
    # branch that warns loudly and proceeds -- written, per its comment, because
    # "this is the guard that exists after an OOM took out a 10 GB host: overriding
    # it has to stay visible". Excluding force HERE made that branch unreachable for
    # a new workspace, so the loud override became a silent one: the function was
    # never called at all. The caller is what turned the warning off.
    if not runner.exists(_derive_for(req)):
        check_capacity(req, req.preset, emit)
    if not repro_name:
        raise ValidationError(f"name {req.name!r} contains no usable characters (want a-z, 0-9, '-')")
    # sanitize() fixes the CHARACTERS but not the length, and the first thing below
    # is a stat on the derived path -- which raises ENAMETOOLONG rather than
    # returning False for an over-long name.
    _require_valid_name(repro_name)
    if req.port and not (1024 <= req.port <= 65535):
        raise ValidationError(f"--port {req.port} is out of range (want 1024-65535)")

    if runner.exists(repro_name) and not req.force and not req.fresh:
        return _reuse(repro_name, wait, req, emit, stream_output=stream_output,
                      resolved=resolved, preset_name=pre.name)

    _guard_project_collision(repro_name)
    check_sidecar_ports(pre, exclude=repro_name)
    if req.monitor:
        check_monitor_ports(exclude=repro_name)
    host_port = pick_host_port(req.port, pre, exclude=repro_name)
    # ALWAYS the published local port, never an override. `--root-url` says what
    # Rocket.Chat should ADVERTISE, and it still does that through the compose spec
    # below -- but `root` is what rc-repro calls itself, and runner.Metadata's own
    # docstring makes that a contract: root_url "stays the plain
    # http://localhost:<port> that rc-repro's own API calls (login, PAT, seeding,
    # load tests) use".
    #
    # Letting the override through broke that contract, and readiness is where it
    # showed: `ready` polls meta.root_url, so a workspace whose root_url held a
    # public https name reported "Rocket.Chat did not become ready within 300s"
    # while /api/info on the local port answered 200 the whole time. Reproduced with
    # `up --root-url https://lab.example.com`: still booting at 127s, 200 locally.
    # Nothing about readiness should depend on DNS, a certificate, or the edge.
    root = f"http://localhost:{host_port}"
    token = req.reg_token or cfg.get("reg_token") or ""
    bind_host = _requested_bind_host(req)
    tlsspec = _resolve_tls(req, repro_name, bind_host, exclude=repro_name, emit=emit)
    if req.bind_public and bind_host not in ("0.0.0.0", "::"):
        # Derived from the challenge (see _resolve_tls), not requested.
        bind_host = "0.0.0.0"
        warn(emit, f"binding 0.0.0.0 so Let's Encrypt can reach this host for the "
                   f"{req.acme_challenge} challenge - that exposes the workspace, and "
                   "it runs the fixed admin/admin123 credentials. `rc-repro down` when "
                   "you are finished.", phase="tls")
    elif bind_host not in _LOOPBACK_BINDS:
        # THE SAME EXPOSURE, ASKED FOR RATHER THAN DERIVED, AND IT WAS SILENT. The
        # warning above fires only when rc-repro widened the bind ITSELF for an ACME
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
            for svc in ([req.preset] if req.preset in config.PRESET_PORTS else []))
        # WHAT THE PANEL DOES NOT ALREADY SAY, and nothing else. The Rocket.Chat
        # admin is generated for a workspace bound this wide and printed two lines
        # below, so repeating it here -- as this used to -- is a sentence people
        # learn to scroll past, which costs the next warning its reader. What is
        # left is the part that is still weak and still fixed: the preset's own
        # UIs, Grafana, and seeded users.
        _weak = ([f"the {req.preset} UI on {_side}"] if _side else []) \
            + (["Grafana on admin/admin"] if req.monitor else []) \
            + (["seeded users, whose password is their username"] if req.seed else [])
        warn(emit, f"--bind {bind_host} publishes this workspace on every interface"
                   + (f" — and {', '.join(_weak)}" if _weak else "")
                   + ". Only do this on a trusted network.", phase="create")
    # RC advertises the https URL (links, OAuth callbacks, CORS all derive from
    # ROOT_URL); `root` stays http so rc-repro's own API calls need no CA.
    public = tlsspec.root_url if tlsspec else ""
    # SAID AT CREATE TIME, because it cannot be discovered afterwards. The IdP presets
    # send the BROWSER to a hostname baked into Rocket.Chat's settings, and the default
    # names this machine -- `localhost:8081` for SAML, `keycloak:8085` for OIDC. A
    # workspace bound wide, or given a public name, is one somebody intends to reach
    # from ELSEWHERE, and from there both of those addresses are the visitor's own
    # laptop: the SAML button bounces off nothing and returns to the login page, and
    # the OIDC popup opens a name that does not resolve and renders blank. That is the
    # entire bug report, and the create said nothing.
    _browser_param = _BROWSER_HOST_PARAM.get(req.preset or "")
    if _browser_param and not (req.params or {}).get(_browser_param):
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
                         "s3_minio": "minio"}[req.preset]
        _svc_port = config.PRESET_PORTS[req.preset][0]
        _advertised = req.root_url or req.domain
        _why = ""
        if bind_host not in _LOOPBACK_BINDS:
            _why = (f"this {req.preset!r} workspace is bound to {bind_host}, so "
                    f"somebody will open it from another machine")
        elif _advertised:
            # DELIBERATELY NOT DERIVED. Pointing the service at {_advertised} while its
            # port is on loopback would break Rocket.Chat's own access to it as well --
            # measured: a container cannot reach a 127.0.0.1-published port by the
            # host's address. So the bind has to move first, and saying that is the
            # only useful thing to do here.
            _why = (f"this {req.preset!r} workspace advertises {_advertised}, but its "
                    f"ports are published on {bind_host or config.DEFAULT_BIND_HOST} "
                    f"where nothing off this box can reach them")
        if _why:
            warn(emit, f"{_why} — and its own service still points the browser at "
                       f"{_default_host}:{_svc_port}, which names that browser's OWN "
                       f"machine. SAML returns to the login page, OIDC opens a blank "
                       f"window, presigned previews fail. None of them logs an error.",
                 phase="create")
            warn(emit, f"    Both halves have to move. Re-create with:\n"
                       f"      --bind 0.0.0.0 --port {host_port} "
                       f"--root-url http://<host>:{host_port} "
                       f"--set {_browser_param}=<host>\n"
                       f"    where <host> is the name people actually type.",
                 phase="create")

    # Overrides already on this repro are carried forward: `up --force` rebuilds the
    # compose file from the spec, so without this a rebuild would silently drop env
    # the user had set. Anything named on THIS run wins.
    env_overrides: dict = {}
    if runner.exists(repro_name):
        try:
            prev = runner.read_meta(repro_name).extra.get("env")
            if isinstance(prev, dict):
                env_overrides.update(prev)
        except Exception:  # noqa: BLE001 - half-written record; nothing to carry
            pass
    env_overrides.update(req.env or {})

    # THE ADMIN PASSWORD, decided here because this is where both halves of
    # "reachable from off this box" are finally known. Generated for a public
    # workspace and left empty -- meaning the shared `admin123` -- for a loopback
    # one; `runner.Metadata.admin_pass` reads it back with that same fallback, and
    # every login in the codebase goes through that property.
    #
    # It has to reach the compose document as well as the record: the document is
    # what actually provisions the admin, so a password written only to repro.json
    # would be a stored credential for a login that does not exist.
    admin_password = (config.generate_admin_password()
                      if reachable_beyond_loopback(tlsspec=tlsspec,
                                                   bind_host=bind_host) else "")
    spec = compose.Spec.from_resolved(
        resolved, project_name=runner.project_name(repro_name),
        root_url=(req.root_url or public or root),
        host_port=host_port, reg_token=token or None, preset=pre,
        bind_host=bind_host, monitoring=req.monitor, tls=tlsspec,
        env_overrides=env_overrides)
    spec.admin_password = admin_password
    try:
        doc = compose.build(spec)
    except ValueError as exc:
        # e.g. a preset naming an entry_service it doesn't define.
        raise ValidationError(str(exc)) from exc

    meta = runner.Metadata(
        name=repro_name, project=spec.project_name, rc_version=resolved.rc_version,
        rc_image=resolved.rc_image, mongo_tag=resolved.mongo_tag,
        mongo_flavor=resolved.mongo_flavor, preset=pre.name, root_url=root,
        host_port=host_port, version_source=resolved.source, pinned=req.pin,
        public_url=public, admin_password=admin_password,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    # Stamped on every create, compose included, so "absent" keeps meaning exactly
    # one thing: a workspace older than the key. See services/topology.py.
    topology.stamp(meta.extra, req.runtime or topology.DOCKER)
    meta.extra[config.EXTRA_DEPLOYMENT] = req.deployment or topology.MONOLITH
    # Recorded so a reader can be told the truth about reaching this workspace from
    # another machine. It was only ever written INTO the compose port mappings, which
    # meant every caller that wanted to know had to parse the generated file --
    # Kubernetes has recorded it in the metadata since its first workspace.
    meta.extra["bind_host"] = bind_host
    # WHAT ROCKET.CHAT ADVERTISES, when that is not what rc-repro calls it. `root_url`
    # on the record is deliberately the plain loopback URL that rc-repro's own API
    # calls use, and `public_url` is set only by TLS -- so `--root-url http://box:3007`
    # was written into the compose ROOT_URL and recorded nowhere. Anything generated
    # FOR THE BROWSER then got loopback: the livechat preset's demo page substitutes
    # `{{ROOT_URL}}` to load Rocket.Chat's widget script, so on any machine but this
    # one it fetched the script from the visitor's own localhost and the widget never
    # appeared, with nothing logged anywhere.
    if spec.root_url and spec.root_url != root:
        meta.extra["advertised_url"] = spec.root_url
    if pre.post_ready:
        meta.extra["post_ready"] = pre.post_ready
    if pre.notes:
        meta.extra["notes"] = pre.notes
    if pre.instances > 1:
        meta.extra["instances"] = pre.instances
    if pre.extra:
        meta.extra.update(pre.extra)
    if pre.ports:
        meta.extra["sidecar_ports"] = pre.ports
    if env_overrides:
        meta.extra["env"] = env_overrides
    if req.actor:
        # Who owns this. Shown by `list` and the GUI card, so a shared server can
        # say whose workspace this is without guessing from the name prefix.
        meta.extra["created_by"] = req.actor
    if req.params:
        # Recorded so a repro can be rebuilt exactly: `backup` copies these into its
        # manifest, and `restore --new` would otherwise recreate an s3_minio repro
        # with the DEFAULT bucket rather than the one whose data it is loading.
        meta.extra["params"] = dict(req.params)
    files = list(pre.files)
    if tlsspec:
        from rc_repro import tls as tlsmod

        # ONE path, whether the name is a real domain or a .rcrepro.localhost one.
        # The only difference is where the certificate comes from, and that is the
        # edge's business -- so no tls/ files are written here, no port is claimed,
        # and nothing about this workspace's containers depends on it.
        local = tlsspec.mode == tlsmod.MODE_LOCAL
        # REFUSED BEFORE ANYTHING IS WRITTEN. `edge.up()` checks `foreign_edge()` -- an
        # edge belonging to a DIFFERENT RC_REPRO_HOME, which compose would silently
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
                f"the shared edge on this box belongs to another RC_REPRO_HOME "
                f"({stolen}). Starting one from here would REPLACE it and take down "
                f"every https name it serves, because compose keys the project by name "
                f"and both homes use the same one. Use that home, or stop its edge "
                f"first.")
        if local:
            info(emit, f"issuing a local certificate for {tlsspec.host}", phase="tls")
            edgesvc.issue_local_cert(tlsspec.host)
        else:
            # Traefik writes acme.json here; it must exist and be private BEFORE
            # the container mounts it, or Traefik refuses to use it.
            tlsmod.acme_dir().mkdir(parents=True, exist_ok=True)
            tlsmod.acme_dir().chmod(0o700)

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
            info(emit, "starting the edge (one Traefik, :80 and :443 for every name)",
                 phase="tls")
            started = edgesvc.ensure_running(
                acme_email="" if local else tlsspec.acme_email,
                acme_staging=tlsspec.acme_staging)
            if not started:
                holder = edgesvc.port_holder(443)
                because = (f" — {holder} is holding :443" if holder
                           else (f" — {started.why}" if started.why else ""))
                warn(emit, f"the edge did not start{because}, so {tlsspec.host} will "
                           "not answer yet. The workspace itself is unaffected; free "
                           "the port and `rc-repro edge start`.", phase="tls")

        needs_cert = edgesvc.register(repro_name, tlsspec.host,
                                      instances=pre.instances or 1, local=local)
        if local:
            pass
        elif needs_cert:
            # No reachability checks. Whether the domain resolves here, and how
            # traffic gets to this host, is the operator's business -- rc-repro
            # cannot see a tunnel, a port-forward or a firewall from in here, and
            # refusing to create the repro over a guess was the single biggest
            # source of confusion in this path.
            info(emit, f"requesting a certificate from Let's Encrypt "
                       f"({'staging' if tlsspec.acme_staging else 'production'}) "
                       f"for {tlsspec.host} — the edge does this in the background; "
                       f"confirm with `rc-repro tls-status -n {repro_name}`",
                 phase="tls")
            # Counted BEFORE the warning, so the name being created is included --
            # the useful number is "after this one", not "before it".
            tlsmod.record_issuance(tlsspec.host)
            budget = tlsmod.budget_warning(tlsspec.host)
            if budget:
                warn(emit, budget, phase="tls")
        else:
            info(emit, f"registering {tlsspec.host} — covered by the wildcard, "
                       "no certificate request", phase="tls")

        meta.extra["tls"] = tlsspec.mode
        meta.extra["edge"] = True
        # Deliberately NO tls_ports: used_ports() feeds port allocation, and
        # claiming a port this workspace does not publish would make every later
        # workspace route around one it never held.
        if not local:
            meta.extra["tls_staging"] = tlsspec.acme_staging
            meta.extra["tls_email"] = tlsspec.acme_email
        meta.extra.setdefault("notes", [])
        meta.extra["notes"] = list(meta.extra["notes"]) + [
            f"served by the edge at https://{tlsspec.host}",
            "the edge holds :443 for the whole box; this workspace publishes none",
        ]
    if req.monitor:
        from rc_repro import monitoring
        targets = compose.rc_service_names(pre.instances)
        files += monitoring.files(targets, project=spec.project_name)
        meta.extra["monitoring"] = True
        meta.extra["monitoring_ports"] = list(config.MONITOR_PORTS)
        meta.extra.setdefault("notes", [])
        meta.extra["notes"] = list(meta.extra["notes"]) + monitoring.notes()

    if runner.exists(repro_name):
        # `--fresh` DELETES THE DATA VOLUME, which is the same irreversible act
        # `down --volumes` is gated on -- and this branch consulted nobody. The gate
        # sat on the two verbs whose NAMES sound destructive rather than on the set
        # that actually is, so a colleague's reproduction state could be wiped by an
        # `up` that reads as "start it again". Checked only for `--fresh`: a plain
        # overwrite recreates containers and leaves the volume alone.
        if req.fresh:
            allowed, why = may_destroy(repro_name, auditsvc.actor())
            if not allowed:
                auditsvc.record("up-fresh", repro_name, outcome="denied")
                raise ConflictError(why)
        # Volumes the OLD compose file declared but the new one doesn't (switching
        # preset with --force, dropping --monitor) would be orphaned: `down -v`
        # only removes what the file declares, so once it's rewritten nothing can
        # ever reach them again.
        stale: set[str] = set()
        if not req.fresh:
            try:
                stale = set(runner.read_compose(repro_name).get("volumes") or {}) - set(doc["volumes"])
            except Exception:  # noqa: BLE001 - unreadable old file: nothing to reconcile
                stale = set()
        if runner.down(repro_name, volumes=req.fresh) != 0:
            raise DockerError(f"could not tear down the existing {repro_name!r}; not overwriting it")
        for bad in runner.remove_volumes(repro_name, sorted(stale)):
            warn(emit, f"could not remove {bad}, left over from the previous preset",
                 phase="create")

    runner.write(repro_name, compose.to_yaml(doc), meta, files=files)
    if req.pin:
        config.update_config(lambda cfg: cfg.__setitem__("default_repro", repro_name))

    info(emit, f"creating {repro_name!r} - RC {resolved.rc_version}, "
               f"Mongo {resolved.mongo_tag} ({resolved.mongo_flavor}), preset {pre.name}",
         phase="create", data={"name": repro_name})

    rc = _up(repro_name, pull=not req.no_pull, emit=emit, stream_output=stream_output)
    if rc != 0:
        cause = diagnose.diagnose_failure(repro_name)
        head = f"`docker compose up` failed - {cause}" if cause else "`docker compose up` failed."
        raise DockerError(
            f"{head} Workspace kept for inspection - retry with --force, or discard: "
            f"rc-repro down --name {repro_name} --volumes")

    # AFTER the workspace is up, because attaching needs the network `docker
    # compose up` has only just created. Registering during the build wrote a
    # correct route to a backend the edge could not resolve, so the name answered
    # 502 -- and 502 is not an error anyone sees, it just looks like a broken
    # workspace. Idempotent: register() attaches too, for every later call.
    if tlsspec:
        edgesvc.attach(repro_name)

    result = _summary(meta)
    result["reused"] = False
    result["waited"] = wait
    if wait:
        result.update(wait_and_finalize(meta, emit))
    # NOT when the caller seeds. `seed_here` means the CLI runs it after this returns,
    # so seeding here as well would seed the workspace twice -- the manifest only ever
    # adds, so the readback would report rooms holding more than planned and the second
    # pass would collide on names it had just created.
    if req.seed and not req.seed_here:
        result["seed"] = run_seed_inline(meta, req.seed_profile, req.stats, emit)
    return result


def _restore_route(meta: "runner.Metadata", emit: Emit = null_emit) -> None:
    """Re-register a workspace's https name with the edge. Best-effort.

    Never fatal: the workspace is up and usable either way, and failing a reuse
    over the ingress would be the wrong trade.
    """
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    if not (extra.get("tls") and meta.public_url):
        return
    from rc_repro import tls as tlsmod

    host = meta.public_url.split("://", 1)[-1].split("/", 1)[0]
    local = extra.get("tls") == tlsmod.MODE_LOCAL
    try:
        if not edgesvc.running():
            edgesvc.ensure_running(acme_email="" if local else extra.get("tls_email", ""),
                                   acme_staging=bool(extra.get("tls_staging")))
        if local:
            edgesvc.issue_local_cert(host)
        instances = extra.get("instances") if isinstance(extra.get("instances"), int) else 1
        edgesvc.register(meta.name, host, instances=instances, local=local)
        info(emit, f"{host} is served by the edge again", phase="tls")
    except Exception as exc:  # noqa: BLE001 - the workspace is fine regardless
        warn(emit, f"could not restore the https name {host}: {exc}. "
                   "`rc-repro edge status` reports it.", phase="tls")


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
        warn(emit, msg, phase="create")
        # AND IN THE ENVELOPE. In prose this is loud; under `--json` it was an NDJSON
        # progress event and the envelope still said `ok: true, warnings: []`. A caller
        # following the documented strategy -- read to end of stream, parse the last
        # line -- saw unqualified success from a tool whose single purpose is running
        # the version you asked for. `data.rc_version` and `data.reused` made it
        # detectable by a careful reader, which is a mitigation, not the contract.
        from rc_repro import jsonout
        jsonout.warn_once("VERSION_IGNORED_ON_REUSE", msg,
                          requested=resolved.rc_version, running=meta.rc_version,
                          ignored=list(mismatch))

    state = runner.rc_state(name)
    if state == "running":
        info(emit, f"{name!r} is already running.", phase="create")
    else:
        info(emit, f"{name!r} already exists - bringing it back up.", phase="create")
        if _up(name, pull=False, emit=emit, stream_output=stream_output) != 0:
            raise DockerError("`docker compose up` failed")
    # A reused workspace gets its https name back. This path never resolved TLS --
    # it reuses the record as-is -- so after a `down`, `up` printed
    # "URL https://…" from that record while the name served nothing at all: the
    # route was removed by the teardown and never rewritten. Cheap to put right
    # now that a name is a file rather than a Traefik of its own.
    _restore_route(meta, emit)

    result = _summary(meta)
    result["reused"] = True
    result["waited"] = wait
    if wait:
        result.update(wait_and_finalize(meta, emit))
    # NOT when the caller seeds. `seed_here` means the CLI runs it after this returns,
    # so seeding here as well would seed the workspace twice -- the manifest only ever
    # adds, so the readback would report rooms holding more than planned and the second
    # pass would collide on names it had just created.
    if req.seed and not req.seed_here:
        result["seed"] = run_seed_inline(meta, req.seed_profile, req.stats, emit)
    return result


def _up(name: str, *, pull: bool, emit: Emit, stream_output: bool) -> int:
    if not stream_output:
        return runner.up(name, pull=pull)   # docker draws its own progress on the terminal
    # `echo="docker"` marks this as ECHO rather than narrative: every line of
    # `docker compose pull` comes through here, so a create emits several hundred
    # "Downloading 45.09MB" events. The GUI wants them; the durable log does not, and
    # would spend its whole size cap on one create. `RC_REPRO_LOG_ECHO=1` keeps them.
    on_line = lambda ln: info(emit, ln, phase="boot", echo="docker")  # noqa: E731
    if pull:
        runner.compose_stream(name, "pull", on_line=on_line)   # non-fatal, like runner.up
    return runner.compose_stream(name, "up", "-d", "--remove-orphans", on_line=on_line)


# --- readiness / finalize -----------------------------------------------------

def wait_serving(meta: runner.Metadata, emit: Emit, timeout: float) -> dict:
    if topology.of_meta(meta) == topology.KUBERNETES:
        # `rc_state` asks docker whether a CONTAINER is running, so `ready` on a
        # Kubernetes workspace answered "Rocket.Chat container is not running" about
        # a workspace whose pods were fine. It also re-establishes the port-forward,
        # which is the whole reason `ready` is the right place to ask: a forward
        # dies with its pod, and this is the command someone runs when the URL is
        # not answering.
        return _wait_serving_kubernetes(meta, emit, timeout)
    seen: dict = {"restarts": 0, "cause": None}

    def is_alive() -> bool:
        return runner.rc_state(meta.name) in ("running", "restarting", "created")

    def tick(elapsed: float) -> None:
        # Surface a crash-loop: if RC keeps restarting, boot is slow for a reason
        # (usually CPU/RAM pressure or a boot error), not just "taking a while".
        rc = runner.rc_restart_count(meta.name)
        if rc >= 2 and rc > seen["restarts"]:
            warn(emit, f"Rocket.Chat has restarted {rc}x - checking why", phase="wait")
            # ASK, rather than assert. The old wording named resource pressure as the
            # cause, and `diagnose` -- which exists for exactly this and holds the
            # signature list -- was never consulted anywhere on the readiness path;
            # its only caller is the `docker compose up` failure above. Measured: a
            # workspace whose MONGO_URL pointed at a host that does not exist spent
            # 303s restarting 10x and was then told it was short of RAM, on a box
            # with 5.7 GB free, while its own logs said "Topology is closed" and
            # diagnose.match() on those same logs returned the right answer.
            #
            # Giving up EARLY only when the cause is known. A boot that restarts
            # twice and then settles is ordinary -- v0.71.1 is the whole lesson --
            # so a restart count is not evidence of anything by itself. A matched
            # signature is.
            if seen["cause"] is None:
                seen["cause"] = diagnose.diagnose_failure(meta.name) or ""
            if seen["cause"]:
                raise _readiness_failure(meta, seen, known=str(seen["cause"]))
        seen["restarts"] = max(seen["restarts"], rc)
        pct = max(0.0, min(99.0, elapsed / timeout * 100)) if timeout else None
        info(emit, f"still booting ({int(elapsed)}s)", phase="wait", pct=pct)

    try:
        served = rcapi.wait_ready(meta.root_url, timeout=timeout, is_alive=is_alive,
                                  on_tick=tick)
    except rcapi.NotReady as exc:
        if seen["cause"] is None:
            seen["cause"] = diagnose.diagnose_failure(meta.name) or ""
        raise _readiness_failure(meta, seen, prefix=str(exc)) from exc
    # SERVING IS NOT USABLE. Rocket.Chat answers /api/info with no database behind it,
    # so a workspace whose mongodb had exited passed this and was reported ready,
    # running and healthy -- while `api` and `seed` refused it and pointed the reader
    # back at `ready`, the command that had just said yes.
    why = degraded_reason(runner.services_by_project().get(meta.project, {}))
    if why:
        raise NotReadyError(
            f"{meta.name!r} is serving, but {why} - Rocket.Chat answers /api/info "
            f"without a database, so this looks ready and no login will work. "
            f"`docker start {meta.project}-{ESSENTIAL_SERVICES[0]}-1`, or "
            f"`rc-repro up --version {meta.rc_version} --name {meta.name}` to "
            f"rebuild the stack.")
    return served


def _readiness_failure(meta: runner.Metadata, seen: dict, *, prefix: str = "",
                       known: str = "") -> NotReadyError:
    """The one place a readiness failure is worded.

    `known` is a diagnosis from `diagnose`, which is preferred over anything guessed:
    it comes from a matched log signature rather than from a restart count. The
    resource-pressure sentence survives only as a POSSIBILITY, and only when nothing
    was matched -- stated as fact it sent a reader hunting for memory they had.
    """
    cause = known or str(seen.get("cause") or "")
    head = prefix or (f"Rocket.Chat is not becoming ready in {meta.name!r}")
    if cause:
        return NotReadyError(f"{head} - {cause}")
    restarts = int(seen.get("restarts") or 0)
    if restarts >= 2:
        return NotReadyError(
            f"{head} - Rocket.Chat restarted {restarts}x and nothing in its logs "
            f"matches a known cause. Free memory or raise Docker's CPU+RAM if the "
            f"box is loaded, then `rc-repro ready --name {meta.name}`; otherwise "
            f"`rc-repro logs --name {meta.name}` has what happened.")
    return NotReadyError(head)


def finalize(meta: runner.Metadata, emit: Emit):
    try:
        auth = login(meta)
        if rcapi.complete_setup_wizard(meta.root_url, auth, meta.admin_pass):
            info(emit, "setup wizard skipped — no registration needed", phase="post_ready")
        return auth
    except Exception:  # noqa: BLE001 - finalize is best-effort
        return None


def _say_ready(emit: Emit, final: bool) -> None:
    """The workspace is serving. Whether that is the END is the caller's to say."""
    if final:
        info(emit, "ready", phase="done", pct=100.0)
    else:
        # NO PERCENTAGE, deliberately. `wait_serving` has already emitted 100 by the
        # time this runs, so naming any number here sends the bar BACKWARDS -- seen on
        # a real create as `[100%] ... is serving at`, then `[85%] the workspace is
        # up`, then `[100%]` again. `pct` is optional precisely so a step that is not a
        # position on the bar can decline to move it.
        info(emit, "the workspace is up", phase="wait")


def wait_and_finalize(meta: runner.Metadata, emit: Emit = null_emit,
                      timeout: float = 300.0, final: bool = True) -> dict:
    """Wait for the workspace to serve, then finish it off.

    `final` is whether this call is the END of what the user asked for. It is
    for `rc-repro ready`, which is exactly this and nothing else; `up` seeds
    afterwards, restore restores afterwards, and an upgrade has a rollback still
    to consider. All three used to announce phase `done` at 100% here and then
    carry on working -- MEASURED on a real create as `done: ready` at 414s
    followed by 46 more seconds of seeding, and in the GUI as a progress bar
    that fills up and then keeps going.

    A caller that is not the end says the workspace is up, which is the true
    and useful half, and leaves `done` to whoever actually finishes.
    """
    started = time.monotonic()
    served = wait_serving(meta, emit, timeout)
    elapsed = int(time.monotonic() - started)
    auth = finalize(meta, emit)
    postready.run_post_ready(meta, auth, emit)
    # AND THE SEED THE INTERRUPTED CREATE ASKED FOR. The note says the workspace "may
    # be running without its preset configuration or seed data" and names this command
    # as the thing that completes it -- and this used to run post_ready, seed nothing,
    # print "ready" and clear the note anyway. Verified: SIGKILL an `up --wait --seed`
    # after compose has detached, run `ready`, get exit 0, and find a workspace with
    # two users and one channel and no note left saying so. That is worse than leaving
    # the note, because the evidence went with it.
    #
    # From the NOTE, not from meta: the request died with the process, and
    # meta.extra["seed"] is written only after a seed has already succeeded.
    from rc_repro.services import journal
    pending = journal.pending_seed(meta.name)
    if pending.get("seed_here"):
        # The process that wrote this note is still running and will seed itself.
        # `pending_seed` only returns ABANDONED notes, so this is the create-path call
        # inside that same process rather than a later `ready`.
        pending = {}
    if pending and not (isinstance(meta.extra, dict) and meta.extra.get("seed")):
        info(emit, f"finishing the seed the interrupted create asked for "
                   f"(profile: {pending.get('seed_profile') or 'small'})", phase="seed")
        try:
            run_seed_inline(meta, str(pending.get("seed_profile") or "small"),
                            bool(pending.get("seed_stats")), emit)
        except ReproError as exc:
            # The note STAYS: a seed that could not be finished is exactly what it is
            # for, and clearing it here would delete the only record again.
            warn(emit, f"the interrupted create's seed could not be finished ({exc}) - "
                       f"the note stays; `rc-repro seed --name {meta.name}` retries it",
                 phase="seed")
            running = served.get("version", "?")
            _say_ready(emit, final)
            return {"booted_s": elapsed, "running_version": running}
    journal.clear_kind(journal.CREATE_UNFINISHED, meta.name)
    running = served.get("version", "?")
    if running != "?" and not meta.rc_version.startswith(running):
        warn(emit, f"running version {running} != requested {meta.rc_version}", phase="wait")
    _say_ready(emit, final)
    return {"booted_s": elapsed, "running_version": running}


# --- a workspace's notes, as groups ------------------------------------------
#
# A note used to be a string, and the whole set a flat list. That was readable in a
# terminal and became a dump in a browser: eleven bullets in a row, half of them
# repeating metadata the panel already states above them, with the commands you
# actually have to paste buried in the middle as prose.
#
# So the GROUPS are the source and the flat list is DERIVED from them. One
# definition, two renderings: the CLI keeps printing strings and cannot drift from
# what the browser shows, older workspaces whose records hold only the flat list
# still render the old way, and nothing needs a heuristic to work out where one
# thought ends and the next begins -- which is what the browser was doing, and it
# got it wrong twice.
#
# Three kinds of content, because that is what is actually in there:
#   rows      -- facts. Key and value, rendered as a table, never as a sentence.
#   body      -- the thing a reader needs to KNOW. Prose, and only prose.
#   commands  -- the thing a reader has to PASTE. Its own block, with a copy button.


def note_group(title: str, *, rows: list | None = None, body: list | None = None,
               commands: list | None = None, kind: str = "") -> dict:
    return {"title": title, "kind": kind,
            "rows": [list(r) for r in (rows or [])],
            "body": list(body or []), "commands": list(commands or [])}


def flatten_notes(groups: list[dict]) -> list[str]:
    """The groups as the flat string list every existing consumer expects.

    Indentation is the contract the flat form already had and the CLI and the browser
    both parse: a four-space line is something to paste. `key: value` rows become
    that same shape so a terminal reader sees a list rather than a table it has no
    way to draw.
    """
    out: list[str] = []
    for group in groups:
        rows = group.get("rows") or []
        if rows:
            width = max(len(str(k)) for k, _ in rows)
            out.append(f"{group['title']}:")
            out.extend(f"    {str(k).ljust(width)}  {v}" for k, v in rows)
        elif group.get("title"):
            out.append(f"{group['title']}:")
        out.extend(group.get("body") or [])
        out.extend(f"    {c}" for c in (group.get("commands") or []))
    return out


# --- the groups, DERIVED from the record --------------------------------------
#
# Derived on every read, not remembered from the create. They used to be built once
# and frozen into `repro.json`, and that is a bug with a name in this file already:
# the "What works here" note told people `backup` had no Kubernetes path for three
# releases after it grew one, and the fix only reached workspaces created after it --
# every existing record kept repeating the old sentence, because the record WAS the
# source. A workspace's notes are a pure function of what the record already holds
# (namespace, context, release, bind host, which preset), so they are recomputed on
# every read and the copy in the record is only ever a record.


def scenario_group(meta: runner.Metadata) -> list[dict]:
    """The preset's own prose as the leading group. Empty for a plain workspace."""
    name = (meta.preset or "").strip()
    if not name or name == "default":
        return []
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    params = dict(extra.get("params") or {})
    try:
        # The SAME resolution the create used, per runtime: a scenario yields native
        # manifests on Kubernetes and a compose service on Docker, and its notes
        # follow the shape it was built in. Resolving it the other way would print
        # instructions for a workspace nobody has.
        if topology.of_meta(meta) == topology.KUBERNETES:
            pre = presets.resolve(name, topology.KUBERNETES, params)
        else:
            pre = presets.load(name, params)
    except Exception:  # noqa: BLE001 - a preset file removed after the create
        # This runs on a READ path (`info`, the GUI panel). A workspace whose preset
        # is no longer loadable still has to be able to describe itself rather than
        # answer 500, so it loses its scenario prose and keeps everything else.
        return []
    notes = list(getattr(pre, "notes", None) or [])
    if not notes:
        return []
    # kind="scenario", not a title the panel has to recognise by its prefix. The
    # panel feeds this group BACK into the scenario card instead of giving it a card
    # of its own: that card already absorbs a place note into the link row naming the
    # same url, and already tells a hosts-file setup step from a credential that
    # merely looks like one. A plain group card loses both.
    return [note_group(f"Scenario · {pre.name}", kind="scenario", body=notes)]


def _kubernetes_https_group(meta: runner.Metadata, extra: dict,
                            ns: str) -> list[dict]:
    """The HTTPS card for a Kubernetes workspace: where TLS actually terminates.

    The one thing genuinely different from Compose, and the thing a support case needs
    told. On Compose the edge holds the certificate as a file; here it holds nothing
    for this name -- it matches the SNI and forwards raw TCP, and the certificate is a
    `kubernetes.io/tls` Secret that cert-manager filled from an annotation on the
    chart's own Ingress. So the commands that answer "why is my certificate wrong" are
    `kubectl describe certificate`, not `rc-repro edge logs`.
    """
    from rc_repro import tls as tlsmod
    from rc_repro.services import k8s

    local = str(extra.get("tls") or "") != tlsmod.MODE_ACME
    endpoint = str(extra.get("ingress_endpoint") or "")
    issuer = k8s.CA_ISSUER if local else k8s.ACME_ISSUER
    body = [
        f"{meta.public_url} is served by the chart's own Ingress in {ns}. TLS "
        f"terminates IN THE CLUSTER, from the Secret {k8s.tls_secret_for(meta.name)} "
        f"that cert-manager issued -- so the failure modes a customer hits (a wrong "
        f"secretName, an expired Certificate, an annotation naming a missing issuer) "
        f"are the real ones here.",
    ]
    if endpoint:
        body.append(
            f"The edge does not decrypt this name: it matches the SNI and forwards "
            f"raw TCP to {endpoint}. Nothing about the certificate is the edge's, and "
            f"`rc-repro edge logs` will not mention it.")
    body.append(
        "A locally-issued certificate: run `rc-repro trust-ca` once and the browser "
        "accepts it, on every workspace on this box."
        if local else
        "A publicly trusted certificate from Let's Encrypt, obtained by cert-manager "
        "over the http-01 challenge. Renewal is cert-manager's, not the edge's.")
    return [note_group("HTTPS", body=body, commands=[
        f"kubectl -n {ns} describe certificate {k8s.tls_secret_for(meta.name)}",
        f"kubectl describe clusterissuer {issuer}",
        f"rc-repro tls-status --name {meta.name}",
    ])]


def kubernetes_note_groups(meta: runner.Metadata) -> list[dict]:
    """What a Kubernetes workspace is and how to reach it, from its record."""
    from rc_repro.services import k8s

    extra = meta.extra if isinstance(meta.extra, dict) else {}
    ns = str(extra.get("namespace") or meta.project or "")
    release = str(extra.get("release") or "rocketchat")
    context = str(extra.get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    micro = topology.axes_of_meta(meta).get("deployment", "") == topology.MICROSERVICES
    pods = 9 if micro else 5
    bind_host = str(extra.get("bind_host") or "")
    port = meta.host_port or 3000
    root = meta.root_url or f"http://localhost:{port}"
    # The port-forward carries the bind host: a workspace created with
    # `--bind 0.0.0.0` needs `--address 0.0.0.0` to come back the same way.
    addr = ("" if bind_host in ("", "127.0.0.1", "localhost")
            else f"--address {bind_host} ")
    # What is IN the namespace versus what is shared by the cluster, stated rather
    # than left to be discovered. The guide installs the MongoDB operator into the
    # Rocket.Chat namespace because it assumes one Rocket.Chat per cluster; rc-repro
    # runs several, its CRDs are cluster-scoped, and a second per-namespace install
    # collides on them. So the deviation is deliberate and has to be visible here --
    # otherwise the first person to run the guide's `kubectl -n <ns> get pods` finds
    # no operator and reasonably concludes it was never installed.
    if extra.get("mongo_managed_by") == "operator":
        mongo_group = note_group("MongoDB", rows=[
            ("Version", meta.mongo_tag),
            ("Image", str(extra.get("mongo_image") or "")),
            ("Managed by", "the official operator"),
            ("Authentication", "SCRAM"),
        ])
        shared = [note_group("The MongoDB operator is shared", body=[
            f"One install in {k8s.OPERATOR_NAMESPACE} watches every namespace, "
            f"rather than one per workspace as the official guide shows. Its CRDs "
            f"are cluster-scoped, so a second per-workspace install would collide "
            f"on them. Nothing of it lives in {ns} except the database, its Secrets "
            f"and its ServiceAccount."],
            commands=[
                f"kubectl -n {k8s.OPERATOR_NAMESPACE} get pods",
                f"kubectl -n {ns} get mongodbcommunity",
            ])]
    else:
        mongo_group = note_group("MongoDB", rows=[
            ("Version", meta.mongo_tag),
            ("Image", str(extra.get("mongo_image") or "")),
            ("Managed by", "a plain StatefulSet"),
            ("Authentication", "none"),
        ], body=[
            f"This path is rc-repro's own: the official guide documents only the "
            f"operator, which needs MongoDB "
            f"{'.'.join(str(n) for n in k8s.OPERATOR_MIN_MONGO)}+. Add "
            f"`--mongo-operator` for the documented path, with authentication."])
        shared = []
    # There is no "reachable at <url>" note any more. The summary panel prints the
    # URL immediately above these notes, the GUI panel's identity line carries it and
    # its links table lists it -- so the note was the fourth copy of one string on one
    # screen, and the browser had to de-duplicate it against the link row to avoid
    # showing it twice. What is NOT said anywhere else is what a non-loopback bind
    # means, and that is the only case this group appears in at all.
    # THE URL IS ONLY PUBLISHED WHILE THE FORWARD LIVES, and nothing said so once it
    # had stopped. A port-forward dies with its pod, so this is ordinary rather than
    # exceptional -- a `restart`, a rescheduled pod, a reboot -- and `list` then showed
    # `running` beside a URL that refused connections. "running" is not wrong about the
    # pods, which is exactly why the reader has nothing to go on: the state is right,
    # the URL is dead, and the repair was documented nowhere.
    #
    # Derived on every read rather than recorded, like every other group here, so it
    # disappears the moment the forward is back. Worded to cover a stopped workspace
    # too, because `_summary` is a read that does not know the state and a note that is
    # only right for one of the two would be worse than one that names both verbs.
    # ONLY WHERE A PID WAS RECORDED. `forward_alive(None)` is False, and reading that
    # as "no forward is running" would be the same mistake this release spent itself
    # removing: a record written before rc-repro tracked the pid, or by a path that
    # never had one, tells us nothing about what is listening. No pid is "I cannot
    # say", and the note claims a fact, so it stays quiet.
    forward = []
    recorded_pid = extra.get("port_forward_pid")
    if ns and recorded_pid and not k8s.forward_alive(recorded_pid, namespace=ns,
                                                    host_port=port):
        forward = [note_group("The URL is not published right now", body=[
            f"No port-forward is running for this workspace, so {root} will not "
            f"answer -- a forward dies with its pod, and rc-repro does not keep one "
            f"alive in the background. This says nothing about Rocket.Chat itself; "
            f"the pods may be perfectly healthy."],
            commands=[f"rc-repro ready --name {meta.name}",
                      f"rc-repro start --name {meta.name}   # if it is stopped"])]
    reach = []
    if addr:
        reach = [note_group("Reachable from other machines", body=[
            f"This workspace publishes on {bind_host}, so it answers at "
            f"http://<this-box>:{port} from anything that can route here -- and it "
            f"runs {config.ADMIN_USERNAME}/{meta.admin_pass}. Keep it off "
            f"untrusted networks."])]
    # GROUPS, not a flat list -- see `note_group` for why. The facts that used to be
    # sentences ("microservices on kind-x - about 9 pods, namespace rc-repro-y") are
    # rows now: that one was three facts welded into prose, and it is what the
    # browser kept gluing to the note after it.
    return [
        note_group("Kubernetes", rows=[
            ("Cluster", context),
            ("Namespace", ns),
            ("Arrangement", "microservices" if micro else "monolith"),
            ("Pods", f"about {pods}"),
        ]),
        mongo_group,
        *forward,
        *reach,
        # THE ORDER IS THE SEQUENCE somebody has to perform, and it was wrong: the
        # port-forward came first, so the first command anyone pasted ran against
        # whatever cluster their own kubectl happened to be pointed at -- or at
        # nothing. The export has to come before every other line here, and the
        # port-forward before anything that reaches Rocket.Chat itself, so the three
        # groups now read top to bottom as: point your tools here, open the way in,
        # then look at what is inside.
        # WHICH kubeconfig, and it is not the same answer on both clusters. rc-repro
        # keeps its own only for the cluster it CREATED: every call is
        # `own=is_ours(context)`, so on a cluster rc-repro adopted it uses the config
        # you already set up and writes nothing of its own. The note said "export
        # KUBECONFIG=<rc-repro's own>" unconditionally -- wrong three ways on an
        # adopted cluster: rc-repro created no cluster, that file does not describe
        # yours, and your kubectl was already pointed at the right one. Following it
        # broke the shell it was pasted into.
        (note_group("1 · Point kubectl and helm at this cluster", body=[
            "rc-repro keeps its own kubeconfig so creating a cluster cannot move the "
            "context you were using. A bare `kubectl` will not see this workspace "
            "until it is pointed here, and every command below assumes it:"],
            commands=[f"export KUBECONFIG={k8s.owned_kubeconfig()}"])
         if k8s.is_ours(context) else
         note_group("1 · Your kubectl already reaches this workspace", body=[
             f"This workspace lives in a cluster you supplied, so there is nothing to "
             f"export -- rc-repro used the kubeconfig you already have and wrote none "
             f"of its own. Every command below runs against context {context!r}; add "
             f"`--context {context}` to any of them if you work in more than one."],
             commands=[f"kubectl config current-context   # expect {context}"])),
        note_group("2 · Open the way in", body=[
            f"Rocket.Chat is reached through a port-forward, which is tied to its pod "
            f"and dies with it. This is the one rc-repro started, so run it again if "
            f"{root} stops answering:"],
            commands=[f"kubectl -n {ns} port-forward {addr}"
                      f"deployment/{release}-rocketchat {port}:3000"]),
        # HTTPS, WHICH THIS RUNTIME'S NOTES SAID NOTHING ABOUT. `compose_note_groups`
        # has an HTTPS card and this function had none, so a Kubernetes workspace with
        # a name showed the port-forward and never mentioned it.
        #
        # And it must NOT reuse the Compose wording. That card says "served by the
        # edge … the edge holds :443 for the whole box" -- true there and false here:
        # the edge does not decrypt this name, the certificate is a Secret in the
        # workspace's own namespace, and the thing that issued it is cert-manager. A
        # card that named the wrong terminator would send someone to `edge logs` for a
        # certificate the edge never saw.
        *(_kubernetes_https_group(meta, extra, ns) if meta.public_url else []),
        note_group("3 · Look at what is inside", body=[
            "What is running, what Rocket.Chat is saying, and the values the release "
            "was installed with:"],
            commands=[
                f"kubectl -n {ns} get pods",
                f"kubectl -n {ns} logs -l app.kubernetes.io/name=rocketchat -f",
                f"helm -n {ns} get values {release}",
            ]),
        # After the three steps, not before them: it carries two `kubectl` lines, and
        # nothing that needs the kubeconfig may appear above the export that sets it.
        *shared,
        note_group("Monitoring", body=[
            f"Prometheus and Grafana are shared by the cluster, not installed per "
            f"workspace: this puts one stack in {k8s.OPERATOR_NAMESPACE}, and `--off` "
            f"leaves it up while any other workspace still wants it."],
            commands=[f"rc-repro monitor --name {meta.name}"]),
        # This used to say "logs, stats and backup have no Kubernetes path yet". Two
        # of the three were right and backup was not: it has run on this runtime
        # since it learned to exec through `kubectl` instead of compose, and an audit
        # found the note still telling users otherwise. A workspace's own notes are
        # where someone checks what they can do with it, so a stale one costs them a
        # capability they already have -- which is also why this is derived and not
        # read back out of a record written months ago.
        note_group("What works here", body=[
            "`logs`, `stats`, `env`, `upgrade`, `backup`, `restore`, `seed`, "
            "`monitor`, `api`, `pat` and `token` all work on this runtime. `stats` "
            "needs metrics-server in the cluster and says so if it is missing; "
            "`env --set` refuses and hands over the `helm upgrade` that changes a "
            "value."]),
    ]


def compose_note_groups(meta: runner.Metadata) -> list[dict]:
    """The add-ons a Compose workspace gained, each as its own group.

    Same three sources the create appended to the flat list -- the scenario (above),
    the edge, the monitoring stack -- so this changes their shape and not one word of
    their content.
    """
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    groups: list[dict] = []
    if extra.get("edge") and meta.public_url:
        groups.append(note_group("HTTPS", body=[
            f"served by the edge at {meta.public_url}",
            "the edge holds :443 for the whole box; this workspace publishes none"]))
    if extra.get("monitoring"):
        from rc_repro import monitoring
        groups.append(note_group("Monitoring", body=monitoring.notes()))
    return groups


def local_url_note(meta: runner.Metadata, scenario: list[dict]) -> list[dict]:
    """Correct `localhost` in a preset's own browser URLs, when it is wrong.

    `ldap` prints phpLDAPadmin, `s3_minio` its console, `email` Mailpit's inbox,
    `livechat` a demo page -- all browser URLs, all written when the browser was
    assumed to be on the docker host. On a workspace bound wide or given a public URL
    it is not, and `localhost` then names the reader's own machine: the same mistake
    that made the saml and oidc buttons fail silently, in prose instead of a setting.

    Said here rather than fixed in four presets because the right host is a fact about
    the RECORD -- the bind host and the advertised URL -- which a preset builder is
    never given.

    KEYED ON THE NOTES THEMSELVES, which the first version got wrong: it fired
    whenever a preset had side-service ports, so a `saml` workspace whose `idp_host`
    had already put the real host in every line was told "the URLs above say
    localhost". They did not. A correction that describes text the reader is not
    looking at is worse than no correction.
    """
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    body = [line for g in scenario for line in (g.get("body") or [])]
    if not any("localhost" in line for line in body):
        return []
    ports = [p for p in (extra.get("sidecar_ports") or []) if isinstance(p, int)]
    bind_host = str(extra.get("bind_host") or "")
    advertised = str(extra.get("advertised_url") or "")
    if not ports or not (advertised or bind_host not in ("", "127.0.0.1", "localhost")):
        return []
    from urllib.parse import urlsplit
    host = (urlsplit(advertised).hostname if advertised else "") or "<this-box>"
    return [note_group("Reaching this preset's own pages", body=[
        f"The URLs above say `localhost`, which names whichever machine the browser "
        f"is on. From anywhere but this box, use {host} instead: "
        f"{', '.join(f'http://{host}:{p}' for p in sorted(ports)[:4])}.",
        f"Those ports are published on {bind_host or '127.0.0.1'}, so they are "
        f"reachable only as far as that bind allows."])]


def note_groups_of(meta: runner.Metadata) -> list[dict]:
    """Every group this workspace has, scenario first. The one entry point."""
    scenario = scenario_group(meta)
    if topology.of_meta(meta) == topology.KUBERNETES:
        # Not corrected here: a Kubernetes workspace is reached through a port-forward
        # the reader runs themselves, so `localhost` is genuinely their localhost.
        return scenario + kubernetes_note_groups(meta)
    return scenario + compose_note_groups(meta) + local_url_note(meta, scenario)


# --- seed (inline, used by create --seed) -------------------------------------

def check_seed(meta: runner.Metadata, auth, plan, result: dict,
               emit: Emit = null_emit, tokens: dict | None = None) -> dict:
    """Read the seeded workspace back, compare it with the manifest, and record it.

    Both front-ends call this, because both had the same hole: the seed summary was
    what the seeder ASKED for, and nothing anywhere checked it. `messages: ~62` --
    the tilde was the tool admitting it did not know.

    REPORTS, it does not refuse. A mismatch is written into the result and warned
    about; whether that ends the command is the caller's decision and the default is
    that it does not. The version of this idea that shipped elsewhere gated on exact
    equality over a seeder that was losing every thread reply, so `up --seed` failed
    on a healthy workspace -- and a check that fails when nothing is wrong is one
    people learn to bypass.

    The verification is persisted into `repro.json` either way. A seeded workspace
    that says what it contains, and whether that was confirmed, is the difference
    between a reproduction and a pile of plausible content.
    """
    try:
        facts = seeder.readback(meta.root_url, auth, plan, tokens=tokens)
        verdict = seeder.verify(plan, facts)
    except Exception as exc:  # noqa: BLE001 - a check must never break the seed
        warn(emit, f"could not read the seed back: {exc}", phase="seed")
        # `why` travels with the verdict, so a caller rendering from the RETURN VALUE
        # can say what went wrong without also subscribing to the events. The CLI does
        # exactly that -- it has the richer renderer -- and passing it an emit as well
        # made every line print twice.
        return {"ok": None, "why": str(exc), "faults": [], "unreadable": [],
                "checked": 0, "rooms": []}
    result["verification"] = {k: verdict[k] for k in
                              ("ok", "faults", "extra", "unreadable", "checked")}
    result["readback"] = verdict["rooms"]
    if verdict["faults"]:
        warn(emit, f"seed readback found {len(verdict['faults'])} mismatch(es): "
                   + "; ".join(f"{f['room'] or 'users'} wanted {f['want']}, found {f['got']}"
                               for f in verdict["faults"][:3]), phase="seed")
    elif verdict["extra"]:
        info(emit, f"readback: {len(verdict['extra'])} room(s) hold more than this run "
                   "planned — they had content already (a re-seed, a preset, a restore)",
             phase="seed")
    elif verdict["unreadable"]:
        warn(emit, f"{len(verdict['unreadable'])} room(s) could not be read back — "
                   "not counted as a fault", phase="seed")
    else:
        info(emit, f"readback: {verdict['checked']} rooms match the plan", phase="seed")
    try:
        runner.update_meta(meta.name, lambda m: m.extra.update({"seed": {
            "profile": plan.profile,
            "planned": result.get("planned", {}),
            "actual": {k: result.get(k) for k in
                       ("users", "rooms", "rooms_total", "messages", "threads", "dms")},
            "verification": result["verification"],
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }}))
    except Exception:  # noqa: BLE001 - a record is not worth failing a good seed
        pass
    return verdict



def run_seed_inline(meta: runner.Metadata, profile: str, stats: bool, emit: Emit) -> dict:
    """Seed a workspace through REST, serialised like every other mutating operation.

    IT WAS THE ONLY ONE THAT WAS NOT. `create_repro`, `set_state`, `teardown`,
    `set_env`, `monitor.attach`, `backup.create`, `upgrade.run`, `run_scale` and
    `clear_scale` all take `repro_lock`; a seed writes the same collections through a
    different door and took nothing. `run_scale`'s own comment states the rule --
    "running it while a backup is dumping would put half of it in the archive" -- and
    the worse direction is the other one: `_Quiesced` STOPS Rocket.Chat for the dump, so
    a seed running into it fails mid-manifest and the readback reports faults nobody
    caused.

    Reentrant per thread, so the `up --seed` path is unaffected: `create_repro` already
    holds this lock and re-entering it is free.
    """
    with runner.repro_lock(meta.name, timeout=_INTERACTIVE_LOCK_WAIT):
        return _seed_inline_locked(meta, profile, stats, emit)


def _seed_inline_locked(meta: runner.Metadata, profile: str, stats: bool,
                        emit: Emit) -> dict:
    from rc_repro import perf
    try:
        auth = login(meta)
    except Exception as exc:  # noqa: BLE001
        raise NotReadyError(f"can't seed - repro not ready: {exc}") from exc
    try:
        plan = seeder.plan_from(profile)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    info(emit, f"seeding (profile {profile})", phase="seed")
    mon = perf.ResourceMonitor(meta.name).start() if stats else None
    t0 = time.monotonic()
    tokens: dict = {}
    try:
        s = seeder.seed(meta.root_url, auth, plan, tokens_out=tokens,
                        admin_password=meta.admin_pass,
                        workspace=meta.name,
                        log=lambda m: info(emit, m.strip(), phase="seed"))
    finally:
        resources = mon.stop() if mon else None
    s["total_s"] = time.monotonic() - t0
    if resources is not None:
        s["resources_keys"] = sorted(resources)
    check_seed(meta, auth, plan, s, emit, tokens=tokens)
    return s


# --- read / state -------------------------------------------------------------

def _summary(meta: runner.Metadata) -> dict:
    # DERIVED here, not read out of the record. Every workspace created before the
    # groups existed -- and every workspace created before the next wording fix --
    # gets the current shape and the current words, because this is a read. The
    # record's own copy is a record; nothing renders from it.
    #
    # The recorded flat list is the fallback, and it is only reached by a workspace
    # that has notes no group accounts for (a preset that has since been deleted,
    # a note some older release appended by hand). Losing those would be worse than
    # rendering them ungrouped, which the panel and the terminal both still do.
    groups = note_groups_of(meta)
    recorded = list(meta.extra.get("notes", []) if isinstance(meta.extra, dict) else [])
    d = {
        "notes": flatten_notes(groups) if groups else recorded,
        "note_groups": groups,
        "name": meta.name, "rc_version": meta.rc_version, "mongo_tag": meta.mongo_tag,
        "mongo_flavor": meta.mongo_flavor, "preset": meta.preset, "root_url": meta.root_url,
        "host_port": meta.host_port, "login": {"user": config.ADMIN_USERNAME, "password": meta.admin_pass},
        "pinned": meta.pinned,
        # Which runtime, and how Rocket.Chat is arranged inside it. `list_repros`
        # has carried the runtime all along and the DETAIL payload had neither, so
        # the panel rendered every workspace as though it were Compose -- and
        # offered actions the Kubernetes path can only refuse.
        "runtime": topology.of_meta(meta),
        "deployment": topology.axes_of_meta(meta).get("deployment", ""),
    }
    # Whether this workspace HAS sample data, and whether the readback agreed. The
    # panel needs it to know whether "add sample data" is the obvious next thing or a
    # repeat: seeding only ever adds, so offering it first on a workspace that is
    # already full is a wrong guess, and a wrong guess about what to do next is worse
    # than not guessing. Always present, never conditional -- a key that appears only
    # sometimes is how the panel's payload drifts from what the tests render.
    _seed = (meta.extra.get("seed") if isinstance(meta.extra, dict) else None) or {}
    d["seed"] = {"profile": _seed.get("profile", ""), "at": _seed.get("at", ""),
                 "ok": bool((_seed.get("verification") or {}).get("ok"))} if _seed else None
    n = meta.extra.get("instances") if isinstance(meta.extra, dict) else None
    if n:
        d["instances"] = int(n)
        d["instance_urls"] = [f"http://localhost:{meta.host_port + i}" for i in range(1, int(n) + 1)]
    if isinstance(meta.extra, dict) and meta.extra.get("monitoring"):
        d["monitoring"] = True
        d["grafana_url"] = f"http://localhost:{config.MONITOR_PORTS[1]}"
    return d


# Preset sidecar links to surface on the dashboard: preset -> [(label, index into
# config.PRESET_PORTS[preset])]. Ports come from config so they never drift.
_PRESET_LINKS = {
    "email": [("Mailpit", 0)],
    "s3_minio": [("MinIO console", 1), ("MinIO API", 0)],
    "saml": [("Keycloak", 0)],
    "oidc": [("Keycloak", 0)],
    "livechat": [("Widget site", 0)],
    "ldap": [("phpLDAPadmin", 0)],
}


def repro_links(m: runner.Metadata) -> list[dict]:
    """Clickable URLs for a repro: RC, extra instances, preset sidecars (S3,
    Keycloak, Mailpit, widget), and monitoring — [{label, url, kind}]."""
    links = [{"label": "Rocket.Chat", "url": m.external_url, "kind": "rc"}]
    extra = m.extra if isinstance(m.extra, dict) else {}
    if m.public_url:
        # Keep the plain http way in as well: with the local CA the browser warns
        # until `trust-ca` has run, and this is the link that always just works.
        links.append({"label": "direct HTTP", "url": m.root_url, "kind": "rc"})
    n = extra.get("instances")
    if isinstance(n, int) and n > 1:
        for i in range(1, n + 1):
            links.append({"label": f"instance {i}", "url": f"http://localhost:{m.host_port + i}", "kind": "rc"})
    ports = config.PRESET_PORTS.get(m.preset, ())
    for label, idx in _PRESET_LINKS.get(m.preset, []):
        if idx < len(ports):
            links.append({"label": label, "url": f"http://localhost:{ports[idx]}", "kind": "sidecar"})
    if extra.get("monitoring"):
        links.append({"label": "Grafana", "url": f"http://localhost:{config.MONITOR_PORTS[1]}", "kind": "monitor"})
        links.append({"label": "Prometheus", "url": f"http://localhost:{config.MONITOR_PORTS[0]}", "kind": "monitor"})
    return links


def repro_state(rc_status: str, has_containers: bool) -> str:
    """The state to report for a repro, from its Rocket.Chat container's docker
    `Status` string ("Up 2 hours (healthy)", "Restarting (1) 5 seconds ago", ...).

    BOTH the list and the detail panel must derive state from this, because they
    used to disagree. The list read compose's PROJECT-level aggregate, where the
    always-running Mongo put "running(" in the string and made a crash-looping RC
    report "running"; the panel checked only whether RC was literally "running"
    and flattened everything else to "stopped". So one repro showed two different
    states at the same moment, and neither of them said "restarting" -- during a
    crash loop, which is exactly when the answer matters.

    `has_containers` separates "the stack is gone" (down) from "containers exist
    but Rocket.Chat has none" (stopped).
    """
    s = (rc_status or "").strip()
    if not s:
        return "stopped" if has_containers else "down"
    low = s.lower()
    if low.startswith("up"):
        # docker reports a paused container as "Up 3 days (Paused)".
        return "paused" if "(paused)" in low else "running"
    if low.startswith("exited"):
        return "stopped"
    # "Restarting (1) 5 seconds ago" -> restarting; "Created"/"Dead" -> as-is.
    return low.split(" (")[0].split(" ")[0] or "down"


# States beyond running/stopped/down that repro_state() can now hand to the UI:
# mid-transition or wedged, rather than plainly up/stopped/gone. This is the
# backend->UI contract for them -- tests/test_core.py asserts the web UI styles
# each one and offers it as a status filter, so adding a state here fails loudly
# until the dashboard handles it (a state it does not know renders unstyled and,
# before this existed, with no lifecycle buttons at all).
TRANSIENT_STATES = ("restarting", "created", "paused", "dead")


#: The services whose absence makes a "running" workspace a lie. Rocket.Chat serves
#: /api/info with no database behind it -- measured: /api/info 200, login 000 after
#: 15s, `ready` exit 0, `list` running, detail health "healthy", and the truth sitting
#: in the same payload's containers array as ("mongodb", "exited"). Every remediation
#: the tool then offered pointed back at `ready`, which reported success, so there was
#: no way out of the loop without reading `docker ps` by hand.
#:
#: DELIBERATELY JUST THE DATABASE. A stopped Mailpit or phpLDAPadmin is a side service
#: a person can live without; treating every preset sidecar as fatal would refuse
#: workspaces that are fine.
ESSENTIAL_SERVICES = ("mongodb",)


def _forward_gap(meta: runner.Metadata) -> str:
    """Why a running Kubernetes workspace's URL will not answer, or "".

    Only where a pid was actually recorded: `forward_alive(None)` is False, and
    reading that as "nothing is running" is the confusion this release spent itself
    removing. A `/proc` read per row is cheap enough for `list`.
    """
    from rc_repro.services import k8s

    extra = meta.extra if isinstance(meta.extra, dict) else {}
    pid = extra.get("port_forward_pid")
    if not pid:
        return ""
    ns = str(extra.get("namespace") or k8s.namespace_for(meta.name))
    if k8s.forward_alive(pid, namespace=ns, host_port=meta.host_port):
        return ""
    return ("no port-forward, so the URL will not answer — "
            f"`rc-repro ready --name {meta.name}` re-establishes it")


def degraded_reason(services: dict) -> str:
    """Why a workspace that LOOKS running is not usable, or "".

    `services` is {service: docker Status string}. Reported as a distinct health
    rather than as a state, because the workspace genuinely is running -- what is
    wrong is that something it needs is not.
    """
    for svc in ESSENTIAL_SERVICES:
        status = (services or {}).get(svc)
        if status is not None and not status.startswith("Up "):
            first = status.split(" (")[0].strip().lower() or "not running"
            return f"{svc} is {first}"
    return ""


def _uptime_health(status: str) -> tuple[str, str]:
    """Parse a docker `Status` string -> (uptime, health).
    "Up 2 hours (healthy)" -> ("2 hours", "healthy"); "Exited (0) ..." -> ("", "")."""
    if not status:
        return "", ""
    mm = re.search(r"\(([^)]+)\)", status)
    health = mm.group(1) if (mm and status.startswith("Up ")) else ""
    # Docker spells the transitional one "health: starting" inside the Status
    # string, and a bare "healthy"/"unhealthy" for the settled ones. Taken verbatim
    # the panel rendered "Health: health: starting". The prefix is noise from the
    # string format, not part of the value.
    if health.startswith("health: "):
        health = health[len("health: "):]
    up = status[3:].split(" (")[0].strip() if status.startswith("Up ") else ""
    return up, health


def list_repros() -> list[dict]:
    metas = runner.list_meta()
    default = config.load_config().get("default_repro")
    docker_up = runner.docker_available()
    states = (runner.project_states() or {}) if docker_up else {}
    # ONE docker ps for every service of every project, so the list and the panel
    # cannot disagree about whether a workspace is degraded -- which is exactly how
    # they came to disagree about `state` before repro_state() existed.
    #
    # Still through `rc_status_by_project()` for the Rocket.Chat line, even though
    # that now derives from the same cached call: it is the seam existing tests stub,
    # and a stub that silently goes inert is how a test keeps passing for a reason
    # other than the one in its name -- which happened twice on this branch already.
    svc_map = runner.services_by_project() if docker_up else {}
    status_map = runner.rc_status_by_project() if docker_up else {}
    out = []
    for m in metas:
        rc_status = status_map.get(m.project, "")
        # `states` is only consulted for "does this project have ANY container",
        # never for the state itself -- see repro_state().
        # A Kubernetes workspace has no compose project, so asking docker whether
        # its containers exist answered `down` for a workspace that was running --
        # the state column was reporting on the wrong runtime entirely.
        if topology.of_meta(m) == topology.KUBERNETES:
            state = kubernetes_state(m.name, m)
        else:
            state = "?" if not docker_up else repro_state(
                rc_status, bool(states.get(m.project)))
        uptime, health = _uptime_health(rc_status)
        if topology.of_meta(m) == topology.KUBERNETES:
            # `list` printed `running` beside a URL that refused connections, and only
            # `info` said otherwise. A port-forward dies with its pod, so this is the
            # NORMAL state after any restart -- and `running` is not wrong about the
            # pods, which is exactly why the reader has nothing to go on. Carried in
            # `degraded`, the field both front-ends already render for the Compose
            # side, so no consumer has to learn a new key.
            degraded_why = _forward_gap(m) if state == "running" else ""
        else:
            degraded_why = (degraded_reason(svc_map.get(m.project, {}))
                            if state == "running" else "")
        degraded = "degraded" if degraded_why else ""
        runtime = topology.of_meta(m)
        monitored = bool(isinstance(m.extra, dict) and m.extra.get("monitoring"))
        extra_ = m.extra if isinstance(m.extra, dict) else {}
        owner = extra_.get("owner") or extra_.get("created_by", "")
        out.append({"name": m.name, "created_by": owner,
                    "owner": owner, "made_by": extra_.get("created_by", ""),
                    "rc_version": m.rc_version, "mongo_tag": m.mongo_tag,
                    "host_port": m.host_port, "root_url": m.root_url, "state": state,
                    # Which runtime, so a row can say so. A Compose and a Kubernetes
                    # workspace differ in what every other command will do to them --
                    # which commands refuse, where the data lives, how to reach it --
                    # and the list was the one place both looked identical.
                    "runtime": runtime,
                    # The https URL when `up --https` was used; "" otherwise. The CLI
                    # and GUI show this in preference to root_url, which stays http.
                    "public_url": m.public_url, "tls": m.extra.get("tls", "") if isinstance(m.extra, dict) else "",
                    "preset": m.preset, "pinned": m.pinned, "default": m.name == default,
                    "monitoring": monitored, "created_at": m.created_at,
                    "uptime": uptime,
                    "health": (degraded or health
                               or (state if state == "running" else "")),
                    "degraded": degraded_why,
                    "grafana_url": f"http://localhost:{config.MONITOR_PORTS[1]}" if monitored else None,
                    "links": repro_links(m)})
    return out


def describe(name: str) -> dict:
    return _summary(runner.read_meta(resolve_name(name)))


# Substrings that mark an env value as a credential. The env tab is a debugging
# aid served to any client holding the session token, and it carried real secrets
# verbatim: REG_TOKEN (an EE license), the LDAP bind password, MinIO's secret key.
# The workspace's docker-compose.yml on disk stays the source of truth for anyone
# who genuinely needs a value.
_SECRET_KEY_HINTS = ("password", "pass", "secret", "token", "_key", "apikey",
                     "credential")
REDACTED = "********"


#: A credential embedded in a URL: `scheme://user:password@host`. Matched on the
#: VALUE, because the key that carries it says nothing -- `MONGO_URL`, `MONGO_URI`
#: and `MONGO_OPLOG_URL` name no secret and hold one.
_URL_USERINFO = re.compile(r"([a-zA-Z][a-zA-Z0-9+.\-]*://[^/\s:@]+):([^/\s@]+)@")


def redact_env(key: str, value: str) -> str:
    """Mask an env value that carries a credential; pass anything else through.

    Two rules, because one was not enough. The KEY names a credential
    (`*password*`, `*token*`, `*secret*`, ...) -- that catches REG_TOKEN, the LDAP
    bind password and MinIO's secret key.

    Or the VALUE carries one inside a URL. `MONGO_URL` matches no hint and on the
    Kubernetes operator path holds `mongodb://rocketchat:<real SCRAM password>@...`,
    resolved out of a Secret the moment the container's environment is read -- so the
    env tab, which exists so that a debugging aid does not hand over credentials,
    handed over the database password to every member. Only the userinfo goes: the
    host, database and replicaSet in the rest of that string are exactly what a
    reader is looking at it for.
    """
    low = key.lower()
    if value and any(h in low for h in _SECRET_KEY_HINTS):
        return REDACTED
    return _URL_USERINFO.sub(rf"\1:{REDACTED}@", value or "")


def _env_rows(doc: dict, overrides: dict | None = None) -> list[dict]:
    """The RC service's env as [{key, value, override}], credentials masked.

    `override` marks the keys the user set with `env --set`, so the panel can tell
    those apart from the preset/base defaults -- "remove" means a different thing
    for each.
    """
    own = set(overrides or {})
    svcs = doc.get("services", {})
    rc_svc = svcs.get("rocketchat") or svcs.get("rocketchat-1") or {}
    env = rc_svc.get("environment", {})
    if isinstance(env, dict):
        pairs = sorted(env.items())
    elif isinstance(env, list):  # compose list form "K=V"
        pairs = [(k, v) for k, v in ((e.split("=", 1) + [""])[:2] for e in env)]
    else:
        return []
    return [{"key": k, "value": redact_env(k, str(v)), "override": k in own}
            for k, v in pairs]


def _bind_host_of(m: runner.Metadata) -> str:
    """The address this workspace publishes its ports ON, for the panel's
    remote-access notice. "" means genuinely unknown.

    Recorded in the metadata at create time. Read back out of the generated compose
    file for workspaces made before it was recorded, so a workspace that already
    exists gets the accurate notice rather than the hedged one -- the fact was always
    on disk, just not where a reader could ask for it.
    """
    extra = m.extra if isinstance(m.extra, dict) else {}
    recorded = str(extra.get("bind_host") or "")
    if recorded:
        return recorded
    if topology.of_meta(m) == topology.KUBERNETES:
        # Kubernetes has recorded it from the first workspace it ever made, so an
        # absence here is not "older than the key" -- there is nothing to recover.
        return ""
    try:
        doc = runner.read_compose(m.name)
    except Exception:  # noqa: BLE001 - no file, or half-written; unknown is fine
        return ""
    svcs = doc.get("services", {}) if isinstance(doc, dict) else {}
    rc = svcs.get("rocketchat") or svcs.get("rocketchat-1") or {}
    for port in rc.get("ports") or []:
        parts = str(port).split(":")
        if len(parts) >= 3 and parts[0]:
            return parts[0]
    return ""


def _since(iso: str) -> str:
    """An ISO timestamp -> docker's phrasing for how long ago it was ("2 hours").

    The panel's Uptime cell is filled from docker's own `Status` string on Compose;
    on Kubernetes the same cell has to be built from a pod's startTime, and it has to
    read the SAME way. Two vocabularies in one column is how a reader stops trusting
    the column.
    """
    if not iso:
        return ""
    try:
        then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    secs = (datetime.now(timezone.utc) - then).total_seconds()
    if secs < 0:
        return ""
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        n = int(secs // size)
        if n:
            return f"{n} {unit}" + ("s" if n != 1 else "")
    n = int(secs)
    return f"{n} second" + ("s" if n != 1 else "")


def detail(name: str) -> dict:
    """Rich detail for the GUI panel: summary + state/uptime/health + links +
    containers + the RC service's env vars."""
    target = resolve_name(name)
    m = runner.read_meta(target)
    d = _summary(m)
    # The env tab masks credentials and tells the reader that the workspace's
    # docker-compose.yml is the source of truth for a real value (see redact_env)
    # -- but nothing in the GUI said where that workspace is.
    d["workspace"] = str(runner.workspace(target))
    # The list payload has carried `default` all along; the panel needs it too, so
    # it can offer "Make default" only where that would change something.
    d["is_default"] = target == config.load_config().get("default_repro")
    _x = m.extra if isinstance(m.extra, dict) else {}
    d["created_by"] = _x.get("owner") or _x.get("created_by", "")
    d["owner"] = d["created_by"]
    d["made_by"] = _x.get("created_by", "")
    d["owner_history"] = list(_x.get("owner_history") or [])
    # Which address this workspace's ports are bound to. The panel needs it to say
    # anything true about reaching the workspace from ANOTHER machine: every link
    # below is built from `localhost`, which for a browser on a different box than
    # `serve` names that browser's own machine. Reported, never acted on -- ROOT_URL
    # is what Rocket.Chat itself advertises and is deliberately left alone.
    d["bind_host"] = _bind_host_of(m)
    # The panel keys its HTTPS row and its "Check TLS" action off these. list_repros()
    # carried them and detail() did not, so the feature was invisible in the panel.
    d["public_url"] = m.public_url
    d["tls"] = m.extra.get("tls", "") if isinstance(m.extra, dict) else ""
    # ASKED FIRST, before docker is asked anything. A Kubernetes workspace's state
    # does not depend on the local daemon, and the branch below reads the workspace's
    # compose file -- which this runtime does not have, so a box whose docker was
    # merely asleep answered the panel with a FileNotFoundError, i.e. 500, for a
    # workspace that was running perfectly well in the cluster.
    if topology.of_meta(m) == topology.KUBERNETES:
        from rc_repro.services import k8s
        context = str(_x.get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
        # BOTH AT ONCE. These are two independent reads of the same namespace, and on
        # a managed cluster each is a round trip -- run in sequence they are most of
        # what the detail panel spends, and the panel is what somebody stares at while
        # deciding whether a workspace is healthy.
        #
        # The dependency below is only ever used to SKIP work, never to change what is
        # asked, so starting both and discarding one is safe. The trade is explicit: a
        # workspace that turns out to be down costs one extra list of an empty
        # namespace -- a read, concurrent, so it adds no wall-clock -- and every
        # running workspace, which is the case anyone actually watches, halves.
        with ThreadPoolExecutor(max_workers=2) as _pool:
            _f_state = _pool.submit(kubernetes_state, target, m)
            _f_pods = _pool.submit(k8s.pod_rows, target, context=context)
            d["state"] = _f_state.result()
            # Pods, in the containers tab's own three columns. This block used to be
            # deliberately empty on the reasoning that invented rows would be a
            # plausible wrong answer -- true, but these are not invented, and the empty
            # list was itself a wrong answer: the tab reads it as "no containers" and
            # printed "this repro is down" under a running workspace, with no way at
            # all to see an ImagePullBackOff from the browser.
            d["containers"] = [] if d["state"] == "down" else _f_pods.result()
        # Uptime from the earliest RUNNING pod, which is as close as this runtime
        # gets to the workspace's own uptime. Left empty when nothing is running,
        # because "—" is the honest cell for a stopped workspace.
        started = sorted(r["started"] for r in d["containers"]
                         if r["state"] == "running" and r["started"])
        d["uptime"] = _since(started[0]) if started else ""
        # Health stays empty on purpose: the kv falls back to the state, which here
        # already distinguishes starting/running/stopped. A per-pod answer is in the
        # containers tab, where it belongs.
        d["health"] = ""
        # ROCKET.CHAT'S OWN restart count, which this branch never set -- so the panel's
        # restart cell and the triage rule that reads it were both dead on Kubernetes,
        # on a runtime where a crash-looping workspace is the common failure. Its own
        # pod, by the label `pod_rows` marks, because nine pods here have a count each
        # and "RC restarts: 3" must not be a sidecar's.
        d["restarts"] = max((int(r.get("restarts") or 0)
                             for r in d["containers"] if r.get("app")), default=0)
        # LINKS ARE NOT COMPOSE-SHAPED, and leaving them out of this branch cost the
        # panel every address a scenario publishes. A preset's UI answers on the SAME
        # host port under both runtimes -- Compose binds it, Kubernetes port-forwards
        # it to the same number deliberately (k8s.scenario_ui_forwards) -- so one
        # list is right for both. Without it, phpLDAPadmin, Keycloak, MinIO, Mailpit
        # and Grafana were unreachable from the GUI on Kubernetes while the CLI
        # printed all of them.
        d["links"] = repro_links(m)
        # Named rather than reconstructed. Every message that mentions it builds it
        # from `namespace_for`, and a browser rebuilding the same string from the
        # workspace name is a second implementation of a naming rule.
        d["namespace"] = str(_x.get("namespace") or "")
        return d

    # `container_details` returns [] both for "no containers" AND for "docker could
    # not be asked", so deriving state from it alone asserted `down` whenever the
    # daemon was unreachable — while list_repros() reported "?" for the same repro.
    # The two views must agree, and neither may claim to know what it cannot.
    if not runner.docker_available():
        d["state"], d["uptime"], d["health"] = "?", "", ""
        d["containers"] = []
        d["links"] = repro_links(m)
        d["env"] = _env_rows(runner.read_compose(target), m.extra.get("env")
                             if isinstance(m.extra, dict) else None)
        return d
    containers = runner.container_details(target)
    rc = [c for c in containers if c["service"] == "rocketchat" or c["service"].startswith("rocketchat-")]
    rc_status = next((c["status"] for c in rc), "")
    d["state"] = repro_state(rc_status, bool(containers))
    up, health = _uptime_health(rc_status)
    d["uptime"] = up
    # The SAME rule the list uses, so the summary can no longer contradict the
    # containers array printed directly beneath it.
    d["degraded"] = (degraded_reason({c["service"]: c["status"] for c in containers})
                     if d["state"] == "running" else "")
    d["health"] = ("degraded" if d["degraded"]
                   else health or (d["state"] if d["state"] != "down" else ""))
    # A climbing restart count is the difference between "slow to boot" and
    # "crash-looping"; wait_serving already warns on it during a create, but after
    # that nothing surfaced it. Only asked when containers exist -- it costs two
    # docker calls, and a `down` repro has nothing to inspect.
    if containers:
        d["restarts"] = runner.rc_restart_count(target)
    d["links"] = repro_links(m)
    d["containers"] = containers
    d["env"] = _env_rows(runner.read_compose(target), m.extra.get("env")
                         if isinstance(m.extra, dict) else None)
    return d


#: Actions `set_state` understands. One tuple, so the validator, the error message
#: and the front-ends cannot list three different sets.
STATE_ACTIONS = ("start", "stop", "restart")


def check_state_request(name: str, action: object) -> str:
    """Refuse a bad stop/start/restart BEFORE any work is queued. Returns the target.

    A PREFLIGHT, in the sense v0.70.9 established for namespace ownership: a refusal
    must leave no trace. The GUI runs this as a job now, and a job answers 200 with an
    id -- so a bad action or an unknown name would have become a job that failed rather
    than a 400 or a 404 on the request that made the mistake. The checks are pure
    argument validation and cost nothing, so they stay on the request thread; only the
    work is queued.
    """
    if not isinstance(action, str):
        raise ValidationError(f"action must be a string (want "
                              f"{'|'.join(STATE_ACTIONS)}), got {type(action).__name__}")
    if action not in STATE_ACTIONS:
        raise ValidationError(f"unknown action {action!r} "
                              f"(want {'|'.join(STATE_ACTIONS)})")
    return resolve_name(name)


def check_teardown_request(name: str, *, volumes: bool = False,
                           confirm: bool = False) -> str:
    """Refuse an unconfirmed or unowned teardown before it is queued. Returns the target.

    Same reason as `check_state_request`, and the stake is higher: without it a member
    who asked to destroy a colleague's workspace got 200 and a job id, and had to open
    the Activity list to discover they had been refused. The refusal belongs on the
    request. `teardown` repeats both checks, because the CLI calls it directly and a
    guard that only one front-end performs is not a guard.
    """
    target = resolve_name(name)
    if volumes and not confirm:
        raise ValidationError(f"deleting {target!r}'s data volume and record is "
                              "irreversible - pass confirm=true")
    if volumes:
        allowed, why = may_destroy(target, auditsvc.actor())
        if not allowed:
            auditsvc.record("down-volumes", target, outcome="denied")
            raise ConflictError(why)
    return target


def set_state(name: str, action: str, emit: Emit = null_emit) -> dict:
    """Stop/start/restart a workspace. Returns what happened, for a caller that
    has to decide what to do next.

    `needs_ready` is the one fact a front-end cannot work out for itself: on
    Kubernetes a `start` scales the deployment back up and CANNOT re-establish the
    port-forward that died with the old pod, so the workspace is running and its
    URL is dark until `ready` waits for the pod and attaches a new one. The GUI used
    to infer that from "did this emit anything", which is a proxy for the real
    question and would answer wrongly the moment any other warning was added.
    """
    target = resolve_name(name)
    # Guarded here rather than in each front-end: the CLI's `stop`/`start`/`restart`
    # and the GUI's always-enabled buttons both arrive through this one function, so
    # one guard covers both and cannot drift between them.
    #
    # Looked up by a hashable key: `action` arrives from a JSON body, and a dict or
    # list reached .get() and raised "unhashable type" -- a 500 rather than the
    # "unknown action" this already knows how to say. Validated BEFORE the runtime
    # split so a bad action is rejected the same way on both.
    if not isinstance(action, str):
        raise ValidationError(f"action must be a string (want start|stop|restart), "
                              f"got {type(action).__name__}")
    if action not in ("start", "stop", "restart"):
        raise ValidationError(f"unknown action {action!r} (want start|stop|restart)")
    if topology.of_repro(target) == topology.KUBERNETES:
        _set_state_kubernetes(target, action, emit=emit)
        return {"name": target, "action": action,
                "runtime": topology.KUBERNETES,
                "needs_ready": action in ("start", "restart")}
    fn = {"start": runner.start, "stop": runner.stop, "restart": runner.restart}.get(action)
    if fn is None:
        raise ValidationError(f"unknown action {action!r} (want start|stop|restart)")
    # Locked like every other mutator. Stop/Restart are always-enabled GUI buttons,
    # so they were clickable straight through a create, backup or upgrade running on
    # the same repro -- and app.js's PENDING map only blocks within ONE tab, so a
    # second tab, a second user or the CLI walked right past it. Stopping mid-backup
    # is the nastiest: _Quiesced.__exit__ restarts the services afterwards, so the
    # stack silently comes back up and the "workspace is stopped" warning never fires.
    # A short timeout because this is interactive: waiting 15 minutes on a click is
    # not a better answer than "something else is working on it, try again".
    with runner.repro_lock(target, timeout=_INTERACTIVE_LOCK_WAIT):
        if fn(target) != 0:
            # A `down`ed repro has no containers, so `compose start` can never
            # revive it. Say what actually works instead of the exit code.
            hint = ""
            if action in ("start", "restart") and runner.rc_state(target) == "absent":
                hint = (f" - {target!r} was `down`ed, so it has no containers to "
                        "start; recreate them from its stored metadata instead")
            raise DockerError(f"`docker compose {action}` failed for {target!r}{hint}")
    # Compose keeps its published port across a stop/start, so nothing has to be
    # re-attached and there is nothing further for the caller to do.
    return {"name": target, "action": action, "runtime": topology.DOCKER,
            "needs_ready": False}


def _set_state_kubernetes(target: str, action: str,
                          emit: Emit = null_emit) -> None:
    """stop/start/restart by scaling, which is the nearest true thing Kubernetes has.

    Compose's contract is what this has to match, not Kubernetes' vocabulary: `stop`
    gives the memory back and keeps the data, `start` brings the same workspace back
    on the same port. Scaling to 0 does exactly that -- the PersistentVolumeClaim is
    untouched, so this is as far from `down --volumes` as `docker compose stop` is.

    The port-forward is a real difference and is handled rather than ignored: it dies
    with the pod, so `stop` kills it deliberately (leaving it would publish a port
    that answers nothing) and `start` hands back to `ready`, which re-establishes it.
    """
    from rc_repro.services import k8s

    meta = runner.read_meta(target)
    extra = meta.extra if isinstance(meta.extra, dict) else {}
    context = str(extra.get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    with runner.repro_lock(target, timeout=_INTERACTIVE_LOCK_WAIT):
        if action in ("stop", "restart"):
            k8s.stop_workspace(target, context=context, emit=emit)
            pid = extra.get("port_forward_pid")
            if pid:
                _stop_port_forward(int(pid), namespace=k8s.namespace_for(target))
                runner.update_meta(target,
                                   lambda m: m.extra.pop("port_forward_pid", None))
        if action in ("start", "restart"):
            k8s.start_workspace(target, context=context, emit=emit)
            # NO PORT-FORWARD HERE, and that is the tested answer rather than the
            # obvious one. Restoring it looks like the right symmetry -- `stop` killed
            # it, so `start` should put it back -- and it does not work: scaling up
            # from zero takes far longer than `port_forward`'s brief pod wait, so
            # kubectl attaches to a pod that is not ready, binds the socket for a
            # moment and exits. Measured on a live cluster: `start` reported success,
            # a reachability probe passed, the recorded pid was dead seconds later and
            # the URL answered 000 for the next minute. The codebase already knew the
            # shape of this -- "a forward ... stays alive briefly, long enough to be
            # reused and even to serve one request, before it exits".
            #
            # Only `ready` waits for the pod before forwarding, so only `ready` can
            # honestly restore the URL. What was missing was not the forward: it was
            # SAYING so anywhere but the CLI. This is emitted from the service, so the
            # GUI gets the same sentence instead of a bare {"ok": true}.
            warn(emit, f"{target!r} is scaling back up. Its URL is a port-forward that "
                       f"died with the old pod, and a new one can only be attached "
                       f"once the pod is ready — `rc-repro ready --name {target}` "
                       f"waits for it and re-establishes the forward.", phase="boot")


def _clear_default_if(name: str) -> None:
    def mutate(cfg: dict) -> None:
        if cfg.get("default_repro") == name:
            cfg.pop("default_repro", None)

    # Locked read-modify-write: prune() calls this in a loop and the GUI runs it on
    # worker threads, so a plain read/write pair can lose an update.
    config.update_config(mutate)


#: Who may DESTROY a workspace somebody else owns. `owner` is the default:
#: §3.3's guardrail was "confirms first, naming the owner", and a confirm dialog
#: stops being a guardrail around the twentieth time you click through it for your
#: own workspaces -- by which point the audit log tells you who did it only after
#: the data is gone. `anyone` restores the previous behaviour exactly, for a team
#: that would rather have the confirm.
#:
#: Only DESTRUCTION is gated. Visibility is not, and neither is help: starting,
#: stopping, seeding, load-testing and reading logs on a colleague's workspace all
#: stay open, because covering someone's ticket is the workflow this exists for.
DESTROY_POLICY_KEY = "gui.destroy_policy"

#: Who may set the create fields that decide what CODE runs and where it LISTENS:
#: `rc_image`, `reg_token`, `bind`.
#:
#: DEFAULT: anyone who may create at all, which is member and up. Set it to `admin`
#: to narrow it.
#:
#: The default started as `admin` and was wrong, for a reason worth keeping written
#: down. A member can already create workspaces and tear them down WITH their data.
#: Against that, "you may destroy Maria's customer repro but not choose which
#: interface your own listens on" is not a security boundary -- it is an
#: inconsistent ladder, and every rung it adds is friction for somebody doing the
#: job. A member who needs `--reg-token` to reproduce an Enterprise bug, or `--bind`
#: because the entire point of the box is that teammates reach it, is not escalating
#: anything; they are using the product.
#:
#: What each field actually costs, so narrowing it is an informed choice rather than
#: a reflex:
#:
#:   rc_image   the sharpest. An arbitrary image runs as the user running `serve`.
#:              Anyone with a shell on this box can already do it -- the CLI has no
#:              roles -- so restricting it only binds people who ONLY have the GUI.
#:   reg_token  an EE licence the caller SUPPLIES. Not a secret they extract: the env
#:              tab masks anything key-named like a credential, REG_TOKEN included.
#:   bind       publishes a workspace running fixed admin/admin123. Prefer setting
#:              `bind_host` once for the box; this is the per-workspace override.
#:
#: Narrow it where an account is not the same thing as trust:
#:     rc-repro config set gui.create_policy admin
CREATE_POLICY_KEY = "gui.create_policy"

#: The fields CREATE_POLICY_KEY governs. Named here rather than inline in web/app.py
#: so the check and the message cannot drift apart.
PRIVILEGED_CREATE_FIELDS = ("rc_image", "reg_token", "bind", "context")

#: Distributions where a workspace costs money for as long as it exists, and so where
#: reaching it only by port-forward is a waste rather than a choice. Named here rather
#: than reusing `cluster.BILLABLE` because that one prices a cluster and this one warns
#: about a workspace -- and a services module importing another for a tuple of three
#: strings is a dependency bought at a poor price.
_BILLABLE_DISTRIBUTIONS = ("eks", "gke", "aks")


def may_set_privileged_fields(actor: str) -> bool:
    """Whether `actor` may set rc_image / reg_token / bind on a create.

    Open unless the box has explicitly narrowed it. Note the asymmetry with
    may_destroy() below, which defaults the OTHER way and should: destroying
    somebody else's workspace loses a colleague's in-progress work, and no create
    field does that.
    """
    if config.load_config().get(CREATE_POLICY_KEY) != "admin":
        return True
    if not actor:                     # no accounts on this box: nothing to bound
        return True
    from rc_repro.services import users as usersvc
    return usersvc.at_least(usersvc.role_of(actor), "admin")


def _owner_gate(name: str, actor: str) -> tuple[bool, str]:
    """(allowed, the current owner when refusing). The ownership rule itself.

    ONE implementation, because two operations apply it and they must not drift:
    `may_destroy` and `may_chown`. Reassigning a workspace is not a lesser act than
    destroying it -- it is the act that DECIDES who may destroy it -- so it is
    gated by the same rule rather than by a weaker one of its own.
    """
    if config.load_config().get(DESTROY_POLICY_KEY) == "anyone":
        return True, ""
    if not actor:                     # no accounts on this box: nothing to bound
        return True, ""
    from rc_repro.services import users as usersvc
    if usersvc.role_of(actor) == "admin":
        return True, ""
    owner = owner_of(name)
    if not owner or owner == actor:
        return True, ""
    return False, owner


def may_destroy(name: str, actor: str) -> tuple[bool, str]:
    """(allowed, why not). Advisory for a front end, enforced by teardown()."""
    allowed, owner = _owner_gate(name, actor)
    if allowed:
        return True, ""
    # The old message told the refused caller to run `chown --to <themselves>`,
    # which was accurate -- `set_owner` was ungated, so following the refusal
    # defeated it in one command. It is gated now, so the advice names who can
    # actually run it instead of reading as an instruction to the wrong person.
    return False, (f"{name} belongs to {owner} — ask {owner}, or an admin can "
                   f"force it. ({owner} or an admin can run "
                   f"`rc-repro chown -n {name} --to {actor}` to hand it over "
                   "for good.)")


def may_chown(name: str, actor: str) -> tuple[bool, str]:
    """(allowed, why not). Advisory for a front end, enforced by set_owner().

    `POST /api/repros/{name}/owner` is member+ and this was not checked at all, so
    a member who had just been refused a destroy could reassign the workspace to
    themselves and destroy it on the next call -- two HTTP requests, both audited,
    neither prevented. Ownership is what `may_destroy` consults, so leaving the
    write to it open made that check advisory in the literal sense.
    """
    allowed, owner = _owner_gate(name, actor)
    if allowed:
        return True, ""
    return False, (f"{name} belongs to {owner} — only {owner} or an admin can "
                   f"hand it over. Taking ownership is what decides who may "
                   f"destroy a workspace, so it is gated the same way as "
                   f"`down --volumes`.")


def teardown(name: str, *, volumes: bool = False, confirm: bool = False, emit: Emit = null_emit) -> dict:
    target = resolve_name(name)
    require_engine(target)
    if volumes and not confirm:
        raise ValidationError(f"deleting {target!r}'s data volume and record is irreversible - "
                              "pass confirm=true")
    if volumes:
        allowed, why = may_destroy(target, auditsvc.actor())
        if not allowed:
            auditsvc.record("down-volumes", target, outcome="denied")
            raise ConflictError(why)
    # Recorded BEFORE the work, not after: a teardown that dies half way through
    # has still destroyed containers, and that is exactly the event someone will
    # come looking for. Auditing here rather than at the route/command covers the
    # CLI and the GUI at once -- the single web-side call site missed both of the
    # destructive operations entirely.
    auditsvc.record("down-volumes" if volumes else "down", target)
    # Locked: `down` during a create races `docker compose up` and leaves orphaned
    # containers behind -- the exact corruption repro_lock exists to prevent -- and
    # `down --volumes` during an upgrade destroys the workspace while its
    # pre-upgrade bundle survives, so `upgrade --rollback` can never find it again.
    with runner.repro_lock(target, timeout=_INTERACTIVE_LOCK_WAIT):
        if topology.of_repro(target) == topology.KUBERNETES:
            # Deliberately BELOW the confirmation, the ownership gate and the audit
            # record: all three are about whose data is being destroyed, which does
            # not depend on the runtime, and duplicating them here is how one
            # runtime quietly loses a check the other keeps. Inside the lock for
            # the same reason compose is.
            #
            # Without this dispatch, `down` reached for a compose project that is
            # not there and answered "no configuration file provided: not found" --
            # a workspace that could be CREATED and never removed, which is worse
            # than not being able to create one.
            from rc_repro.services import k8s
            meta = runner.read_meta(target)
            context = str((meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
            pid = (meta.extra or {}).get("port_forward_pid")
            if pid:
                _stop_port_forward(int(pid), namespace=k8s.namespace_for(target))
            # A preset's UI forwards too, or `down` leaves 8082 bound to a namespace
            # that no longer exists -- and the NEXT workspace using that preset finds
            # the port taken by a corpse.
            for ui_pid in (meta.extra or {}).get("scenario_forwards", {}).values():
                try:
                    _stop_port_forward(int(ui_pid),
                                       namespace=k8s.namespace_for(target))
                except (TypeError, ValueError):
                    pass
            found = k8s.delete_namespace(target, context=context, volumes=volumes,
                                         emit=emit)
            # BRANCHED ON, at last. This value was returned to the caller as
            # `{"found": ...}` and read by nobody -- not the CLI, not the web layer,
            # not app.js -- so `--volumes` deleted the local record, the shared
            # operator and the monitoring stack whatever it said, and reported the
            # namespace and its PersistentVolumeClaim as removed. `delete_namespace`
            # now means "confirmed absent" by True and raises when it could not ask,
            # so False here is either a namespace that was already gone or one still
            # terminating -- and neither is a reason to destroy the only record of it.
            if volumes and not found:
                warn(emit, f"{target!r}: the namespace is not confirmed gone, so the "
                           f"local record is KEPT. Nothing else was removed -- the "
                           f"operator and any monitoring stack are untouched. Re-run "
                           f"`rc-repro down --name {target} --volumes` once "
                           f"`kubectl get ns {k8s.namespace_for(target)}` says it is "
                           f"absent.", phase="teardown")
                return {"name": target, "removed": False, "found": found,
                        "runtime": topology.KUBERNETES}
            if volumes:
                # AFTER the namespace, never before: deleting it took this workspace's
                # MongoDBCommunity with it while the operator was still there to clear
                # the finalizer. `--volumes` means delete everything, so an operator
                # left running afterwards is the wrong answer -- and `remove_operator`
                # refuses while any other workspace still needs it.
                ns = k8s.namespace_for(target)
                # The GRAFANA forward, which `monitor --off` stops and this path did not.
                # It targets a deployment in `rc-repro-system`, so unlike the workspace's
                # own forward it survives the workspace -- and it went on holding :5050
                # after the workspace was destroyed, so the next `up --monitor` was
                # refused for a port held by a corpse. Measured exactly that way. Only on
                # `--volumes`: after a plain `down` the stack and its label are kept on
                # purpose, and Grafana stays reachable for a workspace coming back.
                gpid = (meta.extra or {}).get("grafana_pid")
                if gpid:
                    _stop_port_forward(int(gpid),
                                       namespace=k8s.MONITORING_NAMESPACE)
                # RETURN DELIBERATELY NOT READ, and this is the one place on this
                # path where that is right. An audit flagged it as the same defect as
                # the four fixed in v0.76.4 and it is not: `remove_operator` returns
                # False for THREE reasons -- not installed, still wanted by another
                # workspace, and a failed uninstall -- and the first two are the
                # normal outcome of a shared resource being shared. Only the third is
                # a problem, and it already warns at the point of failure, with the
                # helm reason. Branching on the bool here would report "the operator
                # could not be removed" every time it was correctly left up for a
                # second workspace. Checked by reading both functions: a false
                # warning on the everyday path is worse than no warning.
                k8s.remove_operator(context=context, excluding=ns, emit=emit)
                # AND the monitoring stack, which had the same hole and is far more
                # expensive: ten pods and ~840 MB left running after the workspace that
                # asked for them was destroyed. `remove_monitoring` has always been able
                # to do this -- reference-counted on a namespace label, Grafana's custom
                # resources deleted before the operator that finalises them -- and only
                # `monitor --off` ever called it, so `down --volumes` walked past it.
                # On Compose there was nothing to fix: the stack is part of the
                # workspace's own compose project and goes down with it.
                # Same, and more so: `remove_monitoring` returns True even when the
                # uninstall failed, because the release is gone either way and it has
                # already warned and cleared the finalizers itself.
                k8s.remove_monitoring(context=context, excluding=ns, emit=emit)
                # CHECKED, not assumed. `ignore_errors=True` means a record that
                # could not be removed -- a permission problem, a file held open --
                # is silently left behind, and the success line two branches below
                # then says "and the local record". Saying so is the whole difference
                # between a stale record somebody knows about and one they do not.
                shutil.rmtree(runner.workspace(target), ignore_errors=True)
                if runner.workspace(target).exists():
                    warn(emit, f"the namespace is gone but {runner.workspace(target)} "
                               f"could not be removed, so `list` will still show "
                               f"{target!r}. Remove that directory by hand.",
                         phase="teardown")
                _clear_default_if(target)
            # THE EDGE ROUTE, which this branch returned without dropping. The
            # Compose path twenty lines below has always done it, for a reason that
            # applies identically here: a route left behind points at something that
            # is gone, so the hostname 502s instead of 404ing and the name can never
            # be reused by anyone else. Placed AFTER the cluster work and after the
            # early return above, because a teardown that could not confirm the
            # namespace is gone has not torn the workspace down and its name should
            # go on answering.
            #
            # No `detach`: that disconnects a Docker network a Kubernetes workspace
            # does not have. Deregistering is the whole of it.
            edgesvc.deregister(target)
            # Docker's nouns are wrong here. "containers, data volume, and
            # record" for a workspace that has a namespace and a PVC says nothing
            # about what actually went away -- and `helm uninstall` does NOT delete
            # a PVC, so the difference between these two paths is precisely the
            # thing the user needs told.
            if volumes:
                info(emit, f"{target!r} removed — namespace "
                           f"{k8s.namespace_for(target)}, its "
                           "PersistentVolumeClaim and the local record",
                     phase="done")
            else:
                info(emit, f"{target!r} down — the {k8s.RELEASE} release is "
                           f"uninstalled; namespace {k8s.namespace_for(target)} "
                           "and its PersistentVolumeClaim are KEPT, so `up` again "
                           "reuses the data. `down --volumes` deletes it.",
                     phase="done")
            return {"name": target, "removed": volumes, "found": found,
                    "runtime": topology.KUBERNETES}
        # BEFORE `down`, not after: compose cannot remove a network that still has
        # an active endpoint, and the edge attached to it is exactly that -- so
        # leaving it attached makes `down` fail with "network has active
        # endpoints" and strands the workspace half torn down.
        edgesvc.detach(target)
        if runner.down(target, volumes=volumes) != 0:
            raise DockerError(f"`docker compose down` failed for {target!r}")
        # A route left behind points the edge at a container that no longer
        # exists, so that hostname would 502 instead of 404 -- and the name could
        # never be reused by anyone else.
        edgesvc.deregister(target)
        if volumes:
            runner.remove(target)
            _clear_default_if(target)
    info(emit, f"{target!r} {'removed' if volumes else 'down (data kept)'}", phase="done")
    return {"name": target, "removed": volumes}


def prunable() -> list[str]:
    """Names of repros that are safe to prune: not pinned and with no containers
    (a plain `down`). Raises DockerError if docker can't be queried — deleting on
    that ambiguity would be destructive.

    DOCKER ONLY IF THERE IS A COMPOSE WORKSPACE TO ASK ABOUT. `require_docker()` ran
    unconditionally at the top, so `prune` was refused outright on a host that uses
    only an adopted cluster and has no Docker at all -- while the loop below has asked
    Kubernetes about Kubernetes workspaces for a while. The gate contradicted the
    runtime it was gating.
    """
    me = auditsvc.actor()
    candidates = [m for m in runner.list_meta()
                  if not (m.pinned or not may_destroy(m.name, me)[0])]
    states: dict | None = None
    if any(topology.of_meta(m) != topology.KUBERNETES for m in candidates):
        require_docker()
        states = runner.project_states()
        if states is None:
            raise DockerError("couldn't query docker compose projects - not pruning (is Docker healthy?)")
    out: list[str] = []
    for m in candidates:
        if topology.of_meta(m) == topology.KUBERNETES:
            # ASK KUBERNETES, not Docker. "Is it down" was decided by whether a
            # compose PROJECT was running, and a Kubernetes workspace never has one
            # -- so every Kubernetes workspace looked down, including a healthy one
            # serving traffic. `prune` then offered to delete N "down" repros with a
            # live workspace among them, and its compose teardown could not remove
            # any of them anyway.
            from rc_repro.services import k8s
            context = str((m.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
            try:
                running = k8s.workload_exists(m.name, context=context)
            except DockerError:
                # NOT PRUNABLE, rather than "down". `workload_exists` now refuses to
                # guess when the cluster cannot be asked, and the safe reading of "I
                # could not tell" is to leave the workspace alone -- it is not
                # PROVABLY down, and this list is a delete list. Skipped rather than
                # raised so one unreadable workspace does not stop the others being
                # pruned, which is the same failure one function down.
                continue
            if running:
                continue
            out.append(m.name)
            continue
        if states is not None and m.project not in states:
            out.append(m.name)
    return out



def _orphan_context() -> str:
    """Which cluster to look for orphaned namespaces in.

    `k8s.CONTEXT` was hardcoded here, which meant that on a box using a cluster
    rc-repro did not create -- the whole point of the k3s path -- `prune --orphans`
    looked for strays in a kind cluster that may not even exist, and reported none.
    """
    from rc_repro.services import k8s
    try:
        return k8s.plan_cluster().context
    except Exception:  # noqa: BLE001 - no cluster at all: nothing to sweep
        return k8s.CONTEXT


def orphan_namespaces(context: str = "") -> list[str]:
    """Namespaces labelled ours that NO local record can explain.

    A workspace whose `repro.json` is gone -- an interrupted create, a wiped
    RC_REPRO_HOME, a workspace made under a different one -- leaves its namespace,
    its pods and its PersistentVolumeClaim running with nothing able to remove them:
    every rc-repro command starts from the state directory, so the workspace is
    simply invisible. One was found holding 8Gi and five CrashLoopBackOff pods with
    no way to reach it short of `kubectl delete namespace` by hand.

    Reported, never swept automatically. On a shared cluster an unrecorded namespace
    may be a COLLEAGUE's workspace created from their own home, so deleting it
    because this machine has no record of it would destroy their work. `prune
    --orphans` is the opt-in.
    """
    from rc_repro.services import k8s
    ctx = context or _orphan_context()
    try:
        found = k8s.workspace_namespaces(ctx)
    except Exception:  # noqa: BLE001 - no cluster is not an error here
        return []
    if found is None:
        # Could not ask. Sweeping nothing is the safe answer: the alternative is
        # `prune --orphans` reporting a clean cluster it never managed to read.
        return []
    known = {k8s.namespace_for(m.name) for m in runner.list_meta()}
    return sorted(ns for ns in found
                  if ns not in known and ns != k8s.OPERATOR_NAMESPACE)

def _reclaim_cluster(emit: Emit = null_emit) -> bool:
    """Give back rc-repro's own cluster once nothing of ours is left in it.

    Only ever OUR cluster: `delete_cluster` takes no parameter, needs the `kind` binary,
    and refuses while any workspace namespace remains -- so a cluster somebody else
    supplied (a k3s, a minikube, anything adopted) cannot be reached from here at all.
    That is the teardown asymmetry the runtime split is built on: what rc-repro created
    it may destroy, and what you supplied it only ever borrows a namespace in.

    Best-effort: a cluster that will not go is not a failed prune. The workspaces are
    already gone, which is what was asked for.
    """
    from rc_repro.services import k8s
    try:
        return k8s.delete_cluster(emit=emit)
    except ReproError as exc:
        warn(emit, f"the cluster was left alone: {exc}", phase="done")
        return False
    except Exception:  # noqa: BLE001 - never let cleanup fail a successful prune
        return False


def prune(*, confirm: bool = False, orphans: bool = False, force: bool = False,
          only: list[str] | None = None, emit: Emit = null_emit) -> dict:
    """Delete every `down` workspace. `only` narrows it to a list already shown.

    THE CONFIRMATION AND THE ACTION HAD DIFFERENT TARGET LISTS. `cli.prune` computed
    `prunable()` to print the prompt and this recomputed it after the answer, so on a
    shared box a workspace that went `down` while somebody read the prompt was deleted
    without ever appearing on screen -- and the ownership gate does not help, because
    with the default `owner` policy an admin passes for everybody. README says "`prune`
    lists what it will delete".

    `only` is the list that was shown; anything that has appeared since is skipped and
    named. Anything that has GONE since is simply absent from the intersection.
    """
    targets = prunable()
    if only is not None:
        shown = set(only)
        appeared = [t for t in targets if t not in shown]
        targets = [t for t in targets if t in shown]
        for t in appeared:
            warn(emit, f"{t!r} became prunable after the list was shown and is left "
                       f"alone — run prune again to include it", phase="done")
    stray = orphan_namespaces() if orphans else []
    if not targets and not stray:
        # Still worth asking about the CLUSTER. With every workspace gone, rc-repro's
        # own kind cluster is a 514 MiB control plane holding nothing -- and both the
        # README and the agent skill said `prune` reclaims it, which nothing did:
        # `delete_cluster` had exactly one caller, a failed create's rollback. So the
        # documented promise was never kept, and the memory the tool tells you to worry
        # about was the memory it left behind.
        return {"targets": [], "removed": [], "orphans": [],
                "cluster": _reclaim_cluster(emit)}
    if not confirm:
        raise ValidationError(f"prune deletes {len(targets)} down repro(s) incl. data - pass confirm=true")
    # The NAMESPACES go in the subject too. Recording only `targets` meant a sweep that
    # deleted three namespaces and no local records wrote `- prune - system ok`, with no
    # trace anywhere of what it destroyed -- and on a shared cluster orphan_namespaces()
    # is explicit that one of those may be a colleague's.
    subject = ",".join(targets + [f"ns:{ns}" for ns in stray])
    auditsvc.record("prune", subject)
    removed = []
    for name in targets:
        # Per repro, not around the whole loop: prune touches every `down` repro,
        # and holding them all would block unrelated work for the length of the
        # sweep. A repro that somebody grabbed in between is skipped rather than
        # waited on -- it is no longer idle, so it no longer qualifies for pruning.
        try:
            with runner.repro_lock(name, timeout=5.0):
                if topology.of_repro(name) == topology.KUBERNETES:
                    # The same dispatch `teardown` makes, for the same reason: this
                    # called `docker compose down` on a workspace that has no compose
                    # project, which always failed -- so a Kubernetes workspace could
                    # be listed for pruning and never actually pruned, and its
                    # namespace and PersistentVolumeClaim stayed on the cluster.
                    from rc_repro.services import k8s
                    meta = runner.read_meta(name)
                    context = str((meta.extra or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
                    for ui_pid in (meta.extra or {}).get("scenario_forwards", {}).values():
                        try:
                            _stop_port_forward(
                                int(ui_pid), namespace=k8s.namespace_for(name))
                        except (TypeError, ValueError):
                            pass
                    pid = (meta.extra or {}).get("port_forward_pid")
                    if pid:
                        _stop_port_forward(int(pid),
                                           namespace=k8s.namespace_for(name))
                    # THE ANSWER IS READ, exactly as `teardown` reads it. This
                    # discarded it and then removed the local record and reported the
                    # workspace pruned regardless -- which is the defect v0.70.9 fixed
                    # in `teardown` and left standing here, twenty lines away. A
                    # namespace that could not be deleted therefore lost the only
                    # record that knew about it, while it and its PersistentVolumeClaim
                    # went on running.
                    if not k8s.delete_namespace(name, context=context, volumes=True,
                                                emit=emit):
                        warn(emit, f"{name!r} was NOT pruned: its namespace is not "
                                   f"confirmed gone, so the record is kept. "
                                   f"`kubectl get ns {k8s.namespace_for(name)}`, then "
                                   f"prune again.", phase="done")
                        continue
                    # Same route the Kubernetes branch of `teardown` now drops, for
                    # the same reason: `prune` bypasses `teardown()` entirely, so it
                    # has to do this itself or the edge is left pointing at a
                    # namespace that no longer exists. The Compose branch below has
                    # always had this line; this branch never did.
                    edgesvc.deregister(name)
                    runner.remove(name)
                    _clear_default_if(name)
                    removed.append(name)
                    info(emit, f"pruned {name!r}", phase="done")
                    continue
                # Detach BEFORE `down`: compose cannot remove a network that still
                # has an active endpoint, and the attached edge is one.
                edgesvc.detach(name)
                if runner.down(name, volumes=True) != 0:
                    warn(emit, f"could not clean up {name!r} - skipping", phase="done")
                    continue
                # prune bypasses teardown(), so it drops the route itself or the
                # edge is left pointing at nothing.
                edgesvc.deregister(name)
                runner.remove(name)
        except ConflictError:
            warn(emit, f"{name!r} is in use by another operation - skipping",
                 phase="done")
            continue
        except DockerError as exc:
            # ONE UNREADABLE WORKSPACE MUST NOT END THE SWEEP. `delete_namespace`
            # raises DockerError when the cluster cannot be asked, and only
            # ConflictError was caught -- so the first unreadable workspace aborted
            # prune entirely and every later one was silently left, which is the
            # reported "prune doesn't work". Measured: targets ['k8spf','k8stls'],
            # the second genuinely prunable and never touched.
            warn(emit, f"{name!r} could not be removed ({exc}) - skipping",
                 phase="done")
            continue
        _clear_default_if(name)
        removed.append(name)
        info(emit, f"pruned {name!r}", phase="done")
    swept = []
    # HOISTED, and that is the fix. The sweep below resolved the context properly and
    # the wait further down used the hardcoded `k8s.CONTEXT` -- the very hardcoding
    # `_orphan_context` was introduced to remove, reintroduced one block later. On any
    # cluster rc-repro did not create the two disagreed, so the wait asked a context
    # that does not exist and read the failure as "gone". One variable, so they cannot
    # drift apart again.
    ctx = _orphan_context()
    if stray:
        from rc_repro.services import k8s
        me = auditsvc.actor()
        for ns in stray:
            # THE LABEL IS READ, and it is the only evidence there is. A stray is by
            # definition a namespace no LOCAL record explains -- which on a shared
            # cluster is exactly what a colleague's workspace looks like, because
            # their `repro.json` is on their machine. `rc-repro.io/owner` is stamped
            # on the namespace for this, and the sweep deleted it without ever
            # looking: measured, a namespace labelled `owner=alice` removed with
            # `✓ removed 1 orphaned namespace(s)` and its PersistentVolumeClaim
            # with it.
            owner = k8s.namespace_owner(ns, context=ctx)
            if owner is None and not force:
                warn(emit, f"cannot read who namespace {ns} belongs to, so it is "
                           f"left alone — `--force` sweeps it unread", phase="done")
                continue
            if owner and owner != me and not force:
                warn(emit, f"namespace {ns} belongs to {owner!r}, not to you — left "
                           f"alone. Ask {owner}, or `--force` to sweep it anyway",
                     phase="done")
                continue
            res = k8s.run(["kubectl", "--context", ctx, "delete", "namespace",
                           ns, "--wait=false"], timeout=k8s.APPLY_TIMEOUT,
                          own=k8s.is_ours(ctx))
            if res.returncode == 0:
                swept.append(ns)
                info(emit, f"removed orphaned namespace {ns}", phase="done")
            else:
                warn(emit, f"could not remove orphaned namespace {ns}: "
                           f"{(res.stderr or '').strip()[:120]}", phase="done")
    # THE SWEEP USED `--wait=false`, AND THE RECLAIM RAN IMMEDIATELY AFTER. So
    # `delete_cluster` refused -- correctly -- because the namespaces prune had just
    # deleted were still Terminating, and reclaiming the cluster took a SECOND prune
    # twenty seconds later. About 600 MB survived the prune that emptied it, which is
    # the memory this tool tells people to worry about. Waiting for what we just
    # deleted is the same lesson `delete_namespace` records against itself.
    if swept:
        from rc_repro.services import k8s
        for ns in swept:
            # SAID, when it does not go. The cluster reclaim below refuses while any
            # workspace namespace remains, so dropping this answer turned the
            # single-pass prune back into the two-run behaviour it was fixed for --
            # silently, which is the part worth fixing.
            if not k8s.wait_namespace_gone(ns, context=ctx, emit=emit):
                warn(emit, f"namespace {ns} is still terminating, so the cluster is "
                           f"left alone this pass — `rc-repro prune` again once "
                           f"`kubectl get ns` is clear.", phase="done")
    return {"targets": targets, "removed": removed, "orphans": swept,
            "cluster": _reclaim_cluster(emit)}


#: What `up` accepts on Compose and cannot honour on Kubernetes, with the reason.
#: Each of these was ACCEPTED and silently dropped: the create succeeded, said
#: nothing, and produced a workspace that was not what was asked for. `--preset ldap`
#: is the clearest -- the Kubernetes path's only `presets.load` is a hardcoded
#: "default", so the preset name was written into repro.json and nothing else
#: happened. `rc-repro list` then showed "ldap" for a workspace with no LDAP in it.
#:
#: This is the failure mode of the whole runtime split, and it has now produced
#: `--seed`, `--https`, `mongo_flavor`, `mongo_shell` and these. A refusal that names
#: the missing thing is worth more than a create that quietly does less.
_KUBERNETES_UNSUPPORTED: tuple[tuple[str, str], ...] = (
    # `https`, not `tls`. The first cut of this guard read `getattr(req, "tls", "")`
    # -- a field CreateReq does not have -- so it returned "" every time and the
    # refusal never fired once. It was shipped, described in a commit message, and
    # was dead code: `--https` went on being silently dropped exactly as before. A
    # guard keyed on a name nobody checks is worse than no guard, because the
    # docstring then says the case is handled. Hence the loop reads real fields and
    # the test drives it through CreateReq rather than a hand-made object.
    # The reason, stated as what rc-repro has not built rather than as what your
    # cluster lacks. The first version read "HTTPS needs an ingress controller and
    # cert-manager" -- and told a k3s user their cluster was missing both when it
    # ships Traefik as the DEFAULT ingress class with a LoadBalancer already on :443.
    # Verified by hand on k3s: an Ingress with a TLS secret minted from rc-repro's own
    # local CA served Rocket.Chat over https with `ssl_verify_result: 0`, no
    # cert-manager anywhere. So the blocker is this side of the fence, and naming
    # someone else's cluster for it sends them to install something they do not need.
    # `https` IS NO LONGER HERE. The chart's own Ingress template builds the Ingress,
    # cert-manager issues from a `ca` ClusterIssuer backed by rc-repro's CA, and the
    # edge passes the name through by SNI instead of terminating it. What replaced the
    # blanket refusal is a set of REFUSALS ABOUT THIS CLUSTER, in
    # `_kubernetes_tls_plan`: no ingress class, no cert-manager, no reachable :443
    # Service, a cluster that is not on this machine. Each names one missing thing and
    # what to do about it, which a runtime-wide "not supported" could not.
    #
    # `--domain` stays, and its reason is now the true one. It used to say "a hostname
    # needs the Ingress that --https needs" -- which stopped being true the moment
    # --https built that Ingress. What is actually missing is the ACME ClusterIssuer;
    # the ingress half is done and proven, including a real Let's Encrypt certificate
    # issued from inside a cluster by hand.
    # `domain` HAS ALSO LEFT, and for the same reason `https` did: what was missing
    # was an ACME ClusterIssuer, and that is now one `IssuerSpec` away from the `ca`
    # one -- the guide's own values.yaml with the issuer name swapped. What refuses
    # instead is `_kubernetes_tls_plan`, per cluster: no ingress class, no
    # cert-manager, no reachable :443 Service. The contact-email requirement is
    # `_resolve_tls`'s, shared with Compose.
    ("fresh", "--fresh means DELETE this workspace's data, and the Kubernetes path "
              "keeps the PersistentVolumeClaim — use `rc-repro down --name <n> "
              "--volumes` first, which does delete it"),
)


def _refuse_unsupported_on_kubernetes(req: CreateReq) -> None:
    """Refuse what this runtime cannot honour, rather than accepting and dropping it.

    Ordered so the most consequential is reported first when several are set: being
    told about `--fresh` matters more than being told about `--reg-token`, because
    one of them is about data.
    """
    for name, why in _KUBERNETES_UNSUPPORTED:
        if getattr(req, name, None):
            raise ValidationError(
                f"--{name.replace('_', '-')} is not supported on Kubernetes yet: "
                f"{why}. Use --runtime docker for a workspace that needs it.")
    # A preset reaches Kubernetes when it has an adapter for it -- the Scenario
    # contract from #3. Those that do not are still refused, because being recorded
    # and not applied is what this guard exists to prevent; but the refusal is now
    # per preset rather than a blanket "not supported", and it names the ones that
    # DO work so the answer is actionable.
    if req.preset and req.preset != "default":
        works = ", ".join(sorted(presets.scenario_names())) or "none yet"
        try:
            resolved_preset = presets.resolve(req.preset, topology.KUBERNETES,
                                              req.params or {})
        except ValueError as exc:
            raise ValidationError(
                f"preset {req.preset!r} cannot be resolved for Kubernetes: {exc}. "
                f"Presets with a Kubernetes adapter: {works}. Or use "
                f"--runtime docker, where every preset works.") from exc
        # RESOLVING is not the same as WORKING. A preset with no scenario adapter
        # comes back with its Compose `services` intact -- Keycloak, Mailpit, MinIO
        # -- and this runtime builds no compose document, so those containers would
        # simply never exist while the settings pointing at them were applied. That
        # is the silent-drop shape again, one level further in: the workspace boots,
        # the preset is recorded, and the scenario it names is not there.
        if resolved_preset.services and not resolved_preset.kubernetes_manifests:
            raise ValidationError(
                f"preset {req.preset!r} needs backing services "
                f"({', '.join(sorted(resolved_preset.services))}) and has no "
                f"Kubernetes adapter to create them, so they would be missing while "
                f"Rocket.Chat was configured to use them. Presets with an adapter: "
                f"{works}. Or use --runtime docker, where every preset works.")


@dataclass
class _KubeTls:
    """What `--https` needs from the cluster, once every refusal has passed.

    Built before the write-ahead record, from reads only, so a refusal leaves nothing
    behind -- the same discipline `plan_cluster` and `assert_namespace_available`
    already follow on this path.
    """
    host: str
    ingress_class: str
    endpoint: "object"
    #: The cluster this workspace lives in, so the route step can ask whether the edge
    #: needs to join its Docker network.
    context: str = ""
    #: Which ClusterIssuer this workspace's Ingress will name. `--https` and `--domain`
    #: differ in this one field and nothing else, which is the guide's own values.yaml
    #: with the issuer swapped.
    issuer: "object" = None
    #: Whether the CLUSTER is already receiving on this host's :443. When it is, the
    #: name works through the cluster with no edge at all; when it is not, the edge
    #: has to own :443 and pass through. Measured rather than assumed, because both
    #: are normal and they need different things.
    cluster_owns_443: bool = False


def _kubernetes_tls_plan(req: CreateReq, tlsspec, plan, *,
                         emit: Emit = null_emit) -> _KubeTls:
    """Refuse, or return what the ingress needs. Reads only; writes nothing.

    Every refusal here costs one probe and no state. That ordering is the point: an
    `up --https` that cannot work should say so in a second, not after four minutes
    of MongoDB and a chart install.
    """
    from rc_repro import tls as tlsmod
    from rc_repro.services import k8s

    # Both modes are honoured now, and they are the same code path with a different
    # ClusterIssuer -- which is what the official values.yaml already implies.
    spec = k8s.IssuerSpec(mode=("acme" if tlsspec.mode == tlsmod.MODE_ACME
                                else "local"),
                          acme_email=tlsspec.acme_email,
                          acme_staging=tlsspec.acme_staging)
    # Which request every refusal below is about. Defined here, beside the spec it is
    # derived from, because the first refusal comes before the cluster is even probed.
    asked = "--domain" if spec.mode == "acme" else "--https"
    # THE CLUSTER HAS TO EXIST BEFORE IT CAN BE ASKED ANYTHING. This used to refuse
    # outright when `plan.create` was set -- there was nothing to probe and rc-repro
    # installed no ingress controller, so `--https` on a box whose only Kubernetes was
    # a not-yet-created kind cluster was a dead end. Now the cluster is brought up
    # first and filled in, so the refusal is gone.
    #
    # `ensure_kubeconfig` is what creates it, it takes the cluster lock, and it is
    # idempotent -- `create_workspace` calls it again later and it short-circuits. The
    # cost is stated rather than hidden: with a name asked for, the cluster is created
    # slightly earlier than the write-ahead record, so an interrupted create can leave
    # a cluster with no workspace. `prune` reclaims a cluster rc-repro made, which is
    # what that is for.
    context = k8s.ensure_kubeconfig(plan, emit=emit) if plan.create else plan.context
    pre = k8s.preflight(context)
    # WHERE THE CA KEY WOULD GO. `tls_local.py`: this key "can mint a certificate for
    # any name the browser will trust". On this machine's own cluster that is the same
    # trust boundary as the box. On somebody else's it is not, and there is a better
    # answer that needs no CA at all.
    #
    # ONLY for the local issuer, and that asymmetry is the whole reason `--domain` is
    # the answer this refusal points at: an ACME issuer holds a Let's Encrypt account
    # key, which is the cluster's own and mints nothing this box trusts. So `--domain`
    # works against a cluster anywhere, and `--https` does not.
    if spec.mode == "local" and \
            not k8s.is_local_cluster(pre.distribution or plan.distribution):
        raise AuthorityGateError(
            f"--https would copy rc-repro's CA private key into a Secret in cluster "
            f"{context!r}, which is not on this machine "
            f"({pre.distribution or plan.distribution or 'unknown'}). That key can "
            f"mint a certificate for any name this box trusts, so it does not leave "
            f"here. Use --domain for a publicly-trusted certificate instead, or "
            f"reach the workspace on its port-forward.",
            code="GATE_UNAPPROVED_CLUSTER")
    # ADOPT WHAT IS THERE, INSTALL WHAT IS NOT -- and this is the FIRST thing on this
    # path that changes the cluster, which is why every refusal above it is a read.
    # It sat above the cert-manager check once, and a create on a fresh kind box then
    # built a cluster, installed Traefik into it, and refused for want of cert-manager:
    # a refusal that left an install behind. Measured exactly that way.
    #
    # Adopting comes first, and not only to save work: the ingress controller is the
    # component a support case is usually about, so a cluster already running nginx
    # keeps running nginx. Installing is only for a cluster that has none.
    #
    # It raises for the two cases it must not paper over: a read it could not make,
    # and a cluster that is not on this machine -- where the chart's LoadBalancer
    # Service would provision a billable cloud load balancer implicitly.
    where = pre.distribution or plan.distribution
    # THE GUIDE'S TWO PREREQUISITES, in the order they depend on each other. Both are
    # adopted when the cluster has them and installed with the guide's own command when
    # it does not; both refuse on a cluster that is not on this machine, where CRDs and
    # a LoadBalancer are somebody else's to create; and neither is ever removed.
    #
    # cert-manager first: it is what the ingress annotation will name, and an issuer
    # created before its webhook is serving is accepted and then never reconciled.
    k8s.ensure_cert_manager(context=context, distribution=where, emit=emit)
    ingress_class = k8s.ensure_ingress(context=context, distribution=where,
                                       prefer=req.ingress_class, emit=emit)
    # AFTER `ensure_ingress`, because on a cluster that had none the ingress Service is
    # something rc-repro has just created. Read before it, this found nothing and
    # refused for want of the thing it was about to install.
    endpoint = k8s.ingress_endpoint(context)
    if endpoint is None:
        raise PreflightError(
            f"{asked}: cluster {context!r} has the ingress class {ingress_class!r} but "
            f"no Service publishing :443 that can be reached from outside it, so "
            f"nothing can route to this workspace's name. `kubectl get svc -A` — the "
            f"controller's Service needs to be a LoadBalancer or a NodePort. An "
            f"ingress exposed by a hostPort DaemonSet has none to find.")
    claim = k8s.host_port_claim(context)
    # HOW THE CHALLENGE GETS IN, said rather than discovered. cert-manager implements
    # http01 and dns01 and NOT tls-alpn, so a public name needs Let's Encrypt to reach
    # :80 for it. Two ways that happens, both measured:
    #
    #   * the cluster holds host :80 itself (k3s ServiceLB) -- the challenge arrives
    #     at its ingress directly. Proven end to end with a real production
    #     certificate.
    #   * the edge holds :80 -- it answers 301 to https on the same host and path, and
    #     that lands on the SNI passthrough, which reaches the cluster. Let's Encrypt
    #     follows an http-01 redirect and does not validate the target's certificate,
    #     so this works even before any certificate exists. Both halves measured
    #     (a 301 preserving the path; the challenge path served 200 through the
    #     passthrough from a cert-manager-shaped solver Ingress with no `tls:` block).
    #
    # No third case is refused, because a box where neither holds :80 has nothing
    # listening on it and the failure is a plain connection refused that Let's Encrypt
    # reports itself. Saying which of the two applies is worth more than a guard.
    #   * the cluster's ingress is somewhere else entirely -- a managed cluster's load
    #     balancer. The name resolves to IT, so the challenge arrives there and this
    #     machine is not in the path at any point.
    remote_ingress = endpoint is not None and not endpoint.local
    if spec.mode == "acme":
        info(emit, ("the http-01 challenge goes straight to the cluster's own load "
                    f"balancer ({endpoint.address}) — this machine is not in the path"
                    if remote_ingress else
                    "the http-01 challenge will reach the cluster's ingress directly "
                    "— it holds this host's :80"
                    if claim and 80 in (claim.ports or []) else
                    "the http-01 challenge arrives on the edge's :80 and is redirected "
                    "onto the passthrough, which reaches the cluster"),
             phase="tls")
    # WHETHER THIS HOSTNAME REACHES THE CLUSTER, not whether the cluster holds *a*
    # host address. `claim` answers the second question, and the two come apart on
    # exactly the shape this branch is used on: k3s ServiceLB claims :443 at the
    # host's own address, so `claim` said yes -- while `<name>.rcrepro.localhost`
    # resolves to ::1 first, klipper's DNAT is IPv4-only, and the edge is what
    # answers there. rc-repro therefore skipped writing the passthrough route and
    # printed an https URL that returned 404. Measured on this box: the claim is
    # 172.16.0.2 [80,443] while the name resolves to ['::1', '127.0.0.1'].
    #
    # So the claim now has to be true FOR THIS NAME. Getting it wrong in the other
    # direction is cheap -- an unnecessary edge route is a passthrough that forwards
    # to the same ingress -- which is why this is written to fail closed.
    owns = bool(claim and 443 in (claim.ports or []))
    if owns and not _name_reaches(tlsspec.host, claim):
        info(emit, f"{tlsspec.host} does not resolve to the cluster's ingress "
                   f"({claim.address}), so the name is published through the edge "
                   f"rather than straight at the cluster", phase="tls")
        owns = False
    # A REMOTE INGRESS CANNOT BE FRONTED BY A LOCAL EDGE, so there is nothing here to
    # decide. `claim` asks whether the cluster holds THIS HOST's :443, which for any
    # managed cluster is definitionally no -- its ingress is a load balancer in
    # somebody else's data centre, which is the case `IngressEndpoint` already names:
    # "a LoadBalancer address that is NOT one of this host's own -- kind with MetalLB,
    # or any remote cluster". Falling through to the edge for it was not merely
    # wasteful, it was impossible: the workspace's name resolves to that load
    # balancer, so no packet for it ever arrives on this machine.
    #
    # MEASURED against EKS. `up --domain` announced "the http-01 challenge arrives on
    # the edge's :80", tried to start an edge it had no use for, and refused the whole
    # create because a different RC_REPRO_HOME on the box already owned one -- a
    # shared support server being exactly what this feature is for.
    if not owns and remote_ingress:
        owns = True
    return _KubeTls(host=tlsspec.host, ingress_class=ingress_class,
                    endpoint=endpoint, issuer=spec, context=context,
                    cluster_owns_443=owns)


def _name_reaches(host: str, claim) -> bool:
    """Whether `host` resolves to the address the cluster's ingress answers on.

    Unresolvable is True, deliberately: a `--domain` whose DNS has not propagated yet
    is the normal case for a name being set up, and answering False there would move
    a public name onto the edge for a reason that stops being true minutes later.
    The case this exists to catch is a name that resolves SOMEWHERE ELSE, which is
    a fact rather than a not-yet.
    """
    import socket
    address = str(getattr(claim, "address", "") or "")
    if not address:
        return False
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(host, 443)}
    except OSError:
        return True
    return address in addrs


#: How long the proof below waits for the route to be LIVE, not merely written.
#: Found by running it: the check fired on a chain that was completely correct and
#: reported "answered with a proxy's own default certificate", because a route file
#: appearing and Traefik's file provider having reloaded it are a second apart and
#: `tls.verify` ran in between. Polling is what `cli._report_gui_tls` already does
#: about ACME for exactly the same reason -- a single probe reports "not yet" for
#: every healthy create and teaches people to ignore the line that matters.
PUBLISH_PROOF_TRIES = 8
PUBLISH_PROOF_PAUSE = 1.5


def _route_kubernetes_name(name: str, ktls: _KubeTls, *,
                           emit: Emit = null_emit) -> None:
    """Put the name in front of the cluster. BEFORE the chart, and that is not tidiness.

    An ACME order starts the moment cert-manager sees the Ingress -- which the chart
    creates during `helm install` -- and the http-01 challenge arrives on this host's
    :80. If the edge is not up and the route is not written by then, Let's Encrypt gets
    a connection refused, the order fails, and `wait_for_certificate` spends its whole
    budget on a challenge that could never have been answered. The first version of
    this did exactly that: it published the name AFTER the install and after the
    certificate wait.

    Writing the route early is harmless in the other direction: it points at the
    cluster's ingress, which exists whether or not this workspace does, so the name
    404s from the cluster for the few minutes before its Ingress appears.
    """
    # Imported here rather than at module scope, like every other `k8s` use in this
    # file: `lifecycle` is the Compose-shaped module both front-ends load, and keeping
    # the Kubernetes seam a local import is what stops that becoming a hard dependency.
    from rc_repro.services import k8s as k8s_mod

    if not ktls.cluster_owns_443:
        if not edgesvc.running():
            info(emit, "starting the edge (one Traefik, :80 and :443 for every name)",
                 phase="tls")
            started = edgesvc.ensure_running()
            if not started:
                holder = edgesvc.port_holder(443)
                because = (f" — {holder} is holding :443" if holder
                           else (f" — {started.why}" if started.why else ""))
                warn(emit, f"the edge did not start{because}, so {ktls.host} will not "
                           f"answer yet. The workspace itself is unaffected; free the "
                           f"port and `rc-repro edge start`.", phase="tls")
    if edgesvc.installed():
        # THE EDGE MAY NOT BE ABLE TO REACH THE ENDPOINT YET. A kind cluster's node is
        # a container on kind's own Docker network, so its ingress NodePort answers
        # from the host and not from a container on the default bridge -- measured:
        # 172.18.0.2:30925 reachable from the host and from the `kind` network,
        # unreachable from `bridge`. Joining is the same mechanism `attach` uses for a
        # workspace's network, applied to the cluster's.
        node = k8s_mod.kind_node_container(
            str(getattr(ktls, "context", "") or ""))
        if node:
            net = edgesvc.container_network(node)
            if net and edgesvc.attach_network(net):
                info(emit, f"the edge joined the cluster's Docker network ({net}) — "
                           f"its ingress is not reachable from the default bridge",
                     phase="tls")
        edgesvc.register(name, ktls.host, passthrough=str(ktls.endpoint))
        info(emit, f"{ktls.host} → {ktls.endpoint} ({ktls.endpoint.source}), passed "
                   f"through untouched — TLS terminates in the cluster",
             phase="tls")
    elif ktls.cluster_owns_443:
        info(emit, f"{ktls.host} is served by the cluster's own ingress, which holds "
                   f"this host's :443 — no edge needed", phase="tls")


def _publish_kubernetes_name(name: str, ktls: _KubeTls, *, cert_ready: bool = True,
                             emit: Emit = null_emit, sleep=time.sleep) -> None:
    """Put the name in front of the cluster, and then CHECK it rather than claim it.

    Two topologies, both normal, and the difference decides whether the edge is
    needed at all:

    * the cluster is already receiving on this host's :443 (k3s ServiceLB) -- the
      name reaches the cluster's own ingress directly, and an edge is not required.
      A route is still registered when one exists, because it costs nothing and it is
      what serves the name over any address the cluster's DNAT does not cover.
    * the cluster is not -- the edge must own :443 and pass the name through by SNI.

    The check at the end is the part that matters. Measured on a box in exactly this
    state: the edge was bound, running, healthy, and answering every https name with
    its own default certificate because the cluster had taken the port underneath it.
    `tls.verify` already reports that as `fallback`, so proving it is one existing
    call rather than a new mechanism -- and a name that does not work must say so at
    create time, not be discovered in a browser.
    """
    from rc_repro import tls as tlsmod

    # Routing happened before the install (`_route_kubernetes_name`); this is only the
    # check. Kept a separate call because the two have opposite ordering needs: the
    # route must exist before the chart creates the Ingress, and the proof cannot mean
    # anything until it does.
    # PROVED, NOT ANNOUNCED -- and polled, because a route being WRITTEN and a proxy
    # having RELOADED it are not the same moment. Verified live: this reported a
    # default certificate for a chain that was entirely correct, and the same name
    # served the cluster's certificate seconds later.
    # ONLY for the local issuer. A Let's Encrypt certificate is checked against the
    # SYSTEM store -- that is the whole claim being made about it -- and rc-repro's own
    # CA may not even exist on a box that has only ever used `--domain`, which is how
    # this was found. `cli.tls_status` already makes exactly this distinction.
    cafile = (str(tlsmod.ca_dir() / tlsmod.CA_CRT)
              if getattr(ktls.issuer, "mode", "local") != "acme" else None)
    seen: dict = {}
    for attempt in range(PUBLISH_PROOF_TRIES):
        seen = tlsmod.verify(ktls.host, 443, cafile=cafile)
        if seen.get("serving") and not seen.get("fallback"):
            break
        if attempt < PUBLISH_PROOF_TRIES - 1:
            sleep(PUBLISH_PROOF_PAUSE)
    if seen.get("fallback") and not cert_ready:
        # THE ORDINARY CASE, and it was being reported as the alarming one. An ingress
        # controller serves its OWN default certificate for a name it has no
        # certificate for yet -- so while cert-manager is still working through the
        # ACME order, the cluster answers with exactly the certificate this branch
        # used to blame on "something in front". `cert_ready` is False here, which
        # says plainly that nothing was issued in time.
        #
        # OBSERVED through the GUI on a first workspace on a cold cluster: the image
        # pull ate the certificate window, the wait expired, and the create finished
        # by telling the reader to go looking for a port conflict on their own machine
        # that did not exist. The certificate arrived a minute later.
        warn(emit, f"{ktls.host} is answering with the ingress controller's own "
                   f"default certificate ({seen.get('issuer')}) because cert-manager "
                   f"has not issued one yet — the ACME order is usually still "
                   f"running. The workspace is up. `rc-repro tls-status --name "
                   f"{name}` re-checks it, and `kubectl -n rc-repro-{name} get "
                   f"certificate` says what cert-manager is waiting on.",
             phase="tls")
    elif seen.get("fallback"):
        # The certificate IS issued and the name still answers with somebody's default
        # one, so the cluster is not the thing terminating TLS for it.
        warn(emit, f"{ktls.host} answered with a proxy's own default certificate "
                   f"({seen.get('issuer')}), not the one in the cluster — the "
                   f"certificate was issued, so something in front is terminating TLS "
                   f"for this name instead of passing it through. `rc-repro doctor` "
                   f"names a cluster holding this host's ports.", phase="tls")
    elif not seen.get("serving"):
        warn(emit, f"nothing answered TLS for {ktls.host} yet "
                   f"({seen.get('error') or 'no certificate offered'}). The workspace "
                   f"is up on its port-forward; `rc-repro tls-status --name {name}` "
                   f"re-checks the name.", phase="tls")
    else:
        info(emit, f"https://{ktls.host} is serving the cluster's certificate "
                   f"({seen.get('issuer')})", phase="tls")


def _create_kubernetes(req: CreateReq, emit: Emit = null_emit) -> dict:
    """The Kubernetes half of `_create_repro_locked`.

    Shares everything that is not runtime-specific -- name derivation, version
    resolution, the capacity refusal, host-port allocation, repro.json -- and
    delegates only the sequence that differs. A workspace created here is a
    workspace like any other: `list`, `info`, `logs` and `down` find it because it
    has a repro.json, which is what `runner.exists()` now looks for.
    """
    from rc_repro.services import k8s

    repro_name = _derive_for(req)
    _warn_name_coerced(req, emit)
    _require_valid_name(repro_name)
    # NO refusal for an existing workspace. `down` tells the user "bring it back:
    # rc-repro up ...", and this raised "already exists, down first or --force" at
    # them -- two messages in the same tool contradicting each other about the same
    # workspace. Compose reuses; so does this. The namespace and its PVC survived a
    # plain `down`, which is exactly what makes bringing it back meaningful.
    reused = runner.exists(repro_name)
    if reused:
        info(emit, f"{repro_name!r} already exists — bringing it back up",
             phase="plan")
    check_capacity(req, req.preset, emit)

    # SAID BEFORE IT IS DONE, not after. This is a live lookup against
    # releases.rocket.chat and the cluster probing below it is a dozen kubectl round
    # trips -- on EKS each one is a second or two. Together they were a minute or more
    # of complete silence after the opening line, and a reader watching the GUI's log
    # field sees a create that has stopped. The same defect as the install's 254-second
    # gap, at the other end of the same command.
    info(emit, f"resolving Rocket.Chat {req.version} and its MongoDB pairing",
         phase="plan")
    try:
        resolved = versions.resolve(req.version, offline=req.offline)
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
    if getattr(resolved, "source", "") == "map (no such release)":
        warn(emit, f"releases.rocket.chat has no {req.version} — the pairing below "
                   f"comes from the shipped map, and the image pull will fail unless "
                   f"this tag really exists (`rc-repro versions {req.version}`).",
             phase="resolve")
    if req.rc_image:
        resolved.rc_image = req.rc_image
    if req.mongo:
        versions.apply_mongo_override(resolved, req.mongo)

    # A workspace that comes back must come back at the SAME address. Allocating
    # afresh moved it from :3382 to :3000 on the `up` after a `down` -- so every
    # bookmark, every curl in a ticket and the URL the user had just been shown all
    # pointed at nothing. An explicit --port still wins; otherwise the recorded one
    # does, and only a genuinely new workspace allocates.
    recorded = 0
    if reused:
        try:
            recorded = int(runner.read_meta(repro_name).host_port or 0)
        except (OSError, ValueError, TypeError):
            recorded = 0
    host_port = req.port or recorded or pick_host_port(
        0, presets.load("default", {}), exclude=repro_name)
    # Same resolution order Compose uses: the flag, then the box-level config, then
    # loopback. This was dropped entirely on the Kubernetes path.
    cfg = config.load_config()
    reg_token = req.reg_token or cfg.get("reg_token") or ""
    bind_host = req.bind or cfg.get("bind_host") or config.DEFAULT_BIND_HOST
    root = f"http://localhost:{host_port}"
    microservices = req.deployment == topology.MICROSERVICES
    # Resolved ONCE: the same object builds the workspace and supplies its notes,
    # so what was applied and what is printed cannot disagree.
    preset_for_notes = presets.resolve(req.preset or "default", topology.KUBERNETES,
                                       req.params or {})
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
    # THE CLUSTER IS CHOSEN FIRST, before a single byte is written. `plan_cluster` only
    # probes, and it is what refuses when there is no cluster and no `kind` -- so that
    # refusal now costs nothing, where before it left an `incomplete` record that `list`
    # showed as a workspace and whose port `used_ports()` went on reserving.
    # THE CORE TOOLS FIRST, before anything is provisioned. `Preflight` models this
    # exactly right and the create path never asked it: with `kubectl` absent, `up`
    # built an entire kind cluster, THEN failed, and blamed the API server -- "cluster
    # rc-repro-local was created but its API server is not answering" -- when the API
    # server was fine and the binary rc-repro talks to it with was not installed. A
    # `repro.json` holding a host port was left behind too. `doctor` has named these
    # correctly all along; this is the same question asked where it can still refuse
    # cheaply.
    pre = k8s.preflight()
    if pre.missing_tools:
        raise PreflightError(
            f"{', '.join(pre.missing_tools)} is not installed, and a Kubernetes "
            f"workspace cannot be created or used without it. Install it and try "
            f"again — `rc-repro doctor` lists what this runtime needs.")
    plan = k8s.plan_cluster(req_context(req))
    # A BILLABLE CLUSTER AND NO PUBLIC NAME. Warned, not refused, and the distinction
    # matters: a refusal would remove the one way to reach a workspace whose ingress is
    # broken, which is exactly when somebody needs it. But on a cluster that costs
    # money by the hour, a port-forward is a poor thing to have paid for -- it is tied
    # to a pod, dies with it, serves one machine, and leaves the cluster's whole reason
    # for being remote unused.
    if plan.distribution in _BILLABLE_DISTRIBUTIONS and not (req.domain or "").strip():
        warn(emit,
             f"{plan.context!r} is a {plan.distribution} cluster, and without --domain "
             f"this workspace is reachable only by a port-forward from this machine — "
             f"tied to a pod, gone when it restarts, and one person at a time. "
             f"`--domain <name>` gives it a publicly-trusted address instead.",
             phase="preflight")
    # BEFORE the write-ahead record below. Adopting a namespace that is not ours is
    # refused, and a refusal that created nothing must leave nothing behind -- the
    # provisional record exists so a create that dies HALF WAY can still be removed,
    # which is a different situation from one that never started.
    # ONLY WHEN THERE IS A CLUSTER TO ASK. `plan.create` means rc-repro is about to
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
    tlsspec = _resolve_tls(req, repro_name, bind_host, exclude=repro_name, emit=emit)
    ktls = None
    if not plan.create:
        # THE PREFLIGHT NEEDS A KUBECONFIG THAT KNOWS THIS CONTEXT, and on a fresh
        # RC_REPRO_HOME it does not have one: the cluster exists, so nothing was
        # created, so nothing exported the context this is about to ask through.
        # Every attempt then failed with `context was not found` and the next one
        # failed identically, because the export runs later in the create it never
        # reached. Idempotent, and a no-op for a cluster rc-repro did not make.
        k8s.ensure_kubeconfig(plan, emit=emit)
        # HELM'S OWN ANSWER, and this is the cheapest refusal on the path.
        #
        # rc-repro drives kubectl AND helm, they resolve their configuration
        # differently, and only kubectl was ever asked. Measured on this box: a
        # `~/.kube/config` carrying the server CA and client certificate of a
        # PREVIOUS install of the same cluster left kubectl completely happy -- `get
        # ns`, `auth whoami` as system:admin, the whole MongoDB phase -- while helm
        # refused every call with `x509: certificate signed by unknown authority`. So
        # this create built a namespace, a StatefulSet, a PersistentVolume and an
        # initiated replica set, spent four minutes doing it, then died at the chart
        # and rolled all of it back:
        #
        #     create failed — removing namespace rc-repro-k8slive
        #     error: helm install failed: Error: kubernetes cluster unreachable ...
        #
        # An error naming neither the cause nor the cure, for a condition readable in
        # one second. Only for an ADOPTED cluster: `plan.create` has no cluster to ask
        # yet, and one rc-repro makes itself gets a kubeconfig it wrote.
        _helm_why = k8s.helm_reachable(plan.context)
        if _helm_why:
            raise ValidationError(
                f"helm cannot reach cluster {plan.context!r}, although kubectl can. "
                f"The chart install would fail after MongoDB and roll the whole "
                f"workspace back. helm said: {_helm_why} — a kubeconfig left over "
                f"from a previous install of the same cluster does this. Regenerate "
                f"it (k3s: `sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config`; "
                f"kind: `kind export kubeconfig --name <cluster>`) and run this "
                f"again. `rc-repro doctor` reports the same thing.")
        k8s.assert_namespace_available(repro_name, context=plan.context,
                                       owner=req.actor)
    if tlsspec:
        # Named before the probing starts. `_kubernetes_tls_plan` asks the cluster
        # about its ingress classes, its cert-manager CRD and its ingress endpoint
        # before it emits anything, which on a managed cluster is several seconds of
        # nothing at the exact moment the reader is waiting to learn where HTTPS is
        # coming from.
        info(emit, f"checking {plan.context} for the ingress and cert-manager HTTPS "
                   f"needs", phase="tls")
        # AFTER `ensure_kubeconfig`, because every probe in it needs a kubeconfig that
        # knows the context, and BEFORE the write-ahead record below, because a
        # refusal must leave nothing. `plan.create` is refused inside.
        ktls = _kubernetes_tls_plan(req, tlsspec, plan, emit=emit)
    # Same decision as the compose path and the same reason -- see
    # `reachable_beyond_loopback`. On this runtime the workspace's own ports are
    # loopback port-forwards, so `--domain` is the case that removes the premise.
    #
    # Decided BEFORE the provisional record, not beside the chart install that uses
    # it. The provisional exists precisely so a create that dies half way can still
    # be cleaned up, and a chart installed with a generated password that was never
    # written down is a workspace nobody can log into -- `down` would still work,
    # and nothing else would.
    admin_password = (config.generate_admin_password()
                      if reachable_beyond_loopback(tlsspec=tlsspec,
                                                   bind_host=bind_host) else "")
    provisional = runner.Metadata(
        name=repro_name, project=k8s.namespace_for(repro_name),
        rc_version=resolved.rc_version, rc_image=resolved.rc_image,
        mongo_tag=resolved.mongo_tag, mongo_flavor=resolved.mongo_flavor,
        preset=req.preset, root_url=root, host_port=host_port,
        version_source=resolved.source, pinned=req.pin,
        admin_password=admin_password,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    topology.stamp(provisional.extra, topology.KUBERNETES)
    provisional.extra[config.EXTRA_DEPLOYMENT] = req.deployment or topology.MICROSERVICES
    provisional.extra["namespace"] = k8s.namespace_for(repro_name)
    # The chosen context, not a guess at it. This was `k8s.CONTEXT` unconditionally,
    # which was right only while rc-repro's own cluster was the only one it could use.
    provisional.extra[config.EXTRA_CONTEXT] = plan.context
    provisional.extra["distribution"] = plan.distribution
    provisional.extra["incomplete"] = True
    if req.actor:
        provisional.extra["created_by"] = req.actor
    # Through the runner seam, so the workspace directory is restricted to 0700 the
    # way every Compose one is. Writing repro.json directly here skipped that, and
    # this runtime is the one that also writes `kubernetes/values.yaml` with
    # ADMIN_PASS in it.
    runner.write_record(repro_name, provisional)

    # BEFORE the create, so an ACME challenge has somewhere to land the moment the
    # chart's Ingress appears. See `_route_kubernetes_name`.
    if ktls:
        _route_kubernetes_name(repro_name, ktls, emit=emit)

    # The forward this workspace was LAST published on, so a `--port` change retires
    # it instead of orphaning it. Read from the record rather than from the new
    # request: the whole failure is that the two ports differ.
    _prev_pid, _prev_port = 0, None
    if reused:
        try:
            _old = runner.read_meta(repro_name)
            _prev_pid = int((_old.extra or {}).get("port_forward_pid") or 0)
            _prev_port = int(_old.host_port or 0) or None
        except Exception:  # noqa: BLE001 - no record, no forward to retire
            _prev_pid, _prev_port = 0, None
    out = k8s.create_workspace(
        name=repro_name, resolved=resolved, host_port=host_port,
        microservices=microservices, replicas=req.replicas or 1,
        owner=req.actor, bind_host=bind_host, admin_password=admin_password,
        previous_pid=_prev_pid, previous_port=_prev_port,
        # PASSED AT LAST. `create_workspace` has taken `root_url` since it was
        # written and this call never supplied it, so `values_for` never set
        # anything and the chart emitted no ROOT_URL -- Rocket.Chat ran on its own
        # default while every human reached it here. The Compose path has always
        # threaded this; the omission is why the two runtimes disagreed about what a
        # workspace calls itself.
        root_url=root,
        # With a name, the chart's own Ingress template builds the Ingress -- rc-repro
        # hand-writes none, which is what keeps the `/sockjs` and `/websocket` split to
        # ddp-streamer the chart's business rather than something to emulate.
        tls_host=(ktls.host if ktls else ""),
        ingress_class=(ktls.ingress_class if ktls else ""),
        issuer=(ktls.issuer if ktls else None),
        use_operator=req.mongo_operator,
        # Through a Secret referenced by `valueFrom`, never as a values literal:
        # `helm get values` is readable by anyone who can reach the release, and
        # rc-repro writes the values to disk for a human to read. This refusal used
        # to say the token "is injected through the preset environment, which this
        # runtime does not apply yet" -- preset env has been applied here for some
        # time, so the reason had outlived itself while the flag stayed refused.
        reg_token=reg_token,
        # Resolved through the KUBERNETES adapter, so a scenario yields native
        # manifests here and a compose service on the other runtime -- one intent,
        # two renderings. `_refuse_unsupported_on_kubernetes` has already proved
        # this resolves, so a failure here would be a bug rather than bad input.
        preset=preset_for_notes,
        plan=plan,
        emit=emit)

    meta = runner.Metadata(
        name=repro_name, project=out["namespace"], rc_version=resolved.rc_version,
        rc_image=resolved.rc_image, mongo_tag=resolved.mongo_tag,
        # NOT `resolved.mongo_flavor`. That is a COMPOSE concept -- "official" vs
        # "bitnami-legacy" -- and this runtime honours neither: `k8s.create_workspace`
        # records `mongo_managed_by` and `mongo_image` for exactly this reason, and
        # says so in its own comment. The DISPLAY was fixed when `rc-repro list`
        # started printing "8.0 (official)" for a workspace running Docker Hub's
        # mongo:8.0; the provisional record here kept writing the value, so a JSON
        # consumer reading `mongo_flavor` still got a name for a different image.
        mongo_flavor="", preset=req.preset, root_url=root,
        host_port=host_port, version_source=resolved.source, pinned=req.pin,
        admin_password=admin_password,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    topology.stamp(meta.extra, topology.KUBERNETES)
    meta.extra[config.EXTRA_DEPLOYMENT] = req.deployment or topology.MICROSERVICES
    meta.extra.update({k: v for k, v in out.items() if k != "microservices"})
    # WHAT kind of cluster this workspace lives in. A label, never a branch -- it is
    # what lets `doctor`, the notes and a support case say "k3s" instead of leaving a
    # reader to infer it from a context name.
    meta.extra["distribution"] = plan.distribution
    if ktls:
        from rc_repro import tls as tlsmod

        # The SAME three fields the Compose path records, so `list`, `info`,
        # `repro_links`, the GUI grid and `tls-status` all work on a Kubernetes
        # workspace for free -- none of them asks which runtime it is. `root_url`
        # deliberately stays the plain http port-forward URL that rc-repro's own API
        # calls use; `public_url` is what a human opens.
        meta.public_url = f"https://{ktls.host}"
        meta.extra["tls"] = (tlsmod.MODE_ACME if ktls.issuer.mode == "acme"
                             else tlsmod.MODE_LOCAL)
        # `edge` means "a route file speaks for this name". It is what `note_groups_of`
        # keys the HTTPS card on, and it is False in the topology where the cluster
        # holds :443 itself and no edge is involved at all.
        meta.extra["edge"] = edgesvc.installed()
        # Where TLS actually terminates, which is the one thing genuinely different
        # from Compose and the thing a support case needs told: the certificate is a
        # cluster Secret issued by cert-manager, not a file the edge loaded.
        meta.extra["tls_terminates"] = "cluster"
        meta.extra["ingress_endpoint"] = str(ktls.endpoint)
        meta.extra["ingress_class"] = ktls.ingress_class
        # `certificate_ready` decides how a fallback certificate is EXPLAINED. It
        # was computed here all along and thrown away, so the check that reports
        # the result did not know whether one had ever been issued.
        _publish_kubernetes_name(repro_name, ktls,
                                 cert_ready=bool(out.get("certificate_ready")),
                                 emit=emit)
    if req.replicas > 1:
        meta.extra["instances"] = req.replicas
    if req.actor:
        meta.extra["created_by"] = req.actor
    # Recorded so the notes can be REBUILT from the record rather than read back out
    # of it -- a dynamic scenario's prose is a function of its params, and nothing
    # was keeping them.
    if req.params:
        meta.extra["params"] = dict(req.params)
    # A preset's self-configuration actions, recorded exactly as the Compose path
    # records them. Without this the OIDC preset would create no OAuth provider and
    # the SAML preset no provider settings -- both recorded and neither applied,
    # which is the silent-drop shape this runtime keeps producing.
    if getattr(preset_for_notes, "post_ready", None):
        meta.extra["post_ready"] = preset_for_notes.post_ready
    # Built by `note_groups_of` from the record this function has just finished
    # writing, which is the same call `info` and the GUI panel make. Constructing
    # them here instead is how a workspace came to keep the wording it was created
    # with for life; writing them at all is now only so the record says what the
    # workspace is without a reader having to re-derive it.
    groups = note_groups_of(meta)
    # THE GROUPS ARE NOT PERSISTED. They are rendered presentation -- roughly 5.5 KB of
    # a 6.4 KB Kubernetes record, the same content as `notes` a second time, and
    # including an absolute `export KUBECONFIG=<home>/clients/kubernetes/config` that
    # is wrong the moment the home moves or the workspace is copied between boxes,
    # which backup/restore invite. Nothing ever read the stored copy: `detail()` calls
    # `note_groups_of` itself, and so does the CLI. The only reason to write it was so
    # the record "says what the workspace is", and it says that in `notes`.
    meta.extra.pop("note_groups", None)
    # Derived, never written twice: the CLI and every workspace record made before
    # groups existed read this, and a second hand-maintained copy is how the two
    # would come to disagree.
    meta.extra["notes"] = flatten_notes(groups)
    # No compose document, so `write` is given an empty one rather than a fake:
    # a file that looks like a compose project but is not would be worse than none.
    ws = runner.workspace(repro_name)
    ws.mkdir(parents=True, exist_ok=True)
    runner.atomic_write(ws / "repro.json",
                        json.dumps(asdict(meta), indent=2))
    # --wait and --seed were ignored here, so `up --seed` ran the seeder the instant
    # helm returned and failed with "can't seed - repro not ready". The CLI already
    # forces wait=True when seeding; this path simply never read it.
    result = {"name": repro_name, "meta": asdict(meta), "url": root,
              "reused": reused, "runtime": topology.KUBERNETES}
    # A preset with post_ready actions MUST wait, or there is nothing to configure
    # against -- the same rule the Compose path applies at `wait = req.wait or
    # bool(pre.post_ready) or req.seed`.
    if req.wait or req.seed or bool(meta.extra.get("post_ready")):
        # wait_and_finalize, not bare wait_serving: it also finalizes the setup
        # wizard over REST and runs the preset's post_ready actions. Waiting and
        # stopping there left every self-configuring preset half-applied.
        result.update(wait_and_finalize(meta, emit, timeout=600.0,
                                        final=False))
        result["ready"] = True
    # NOT when the caller seeds. `seed_here` means the CLI runs it after this returns,
    # so seeding here as well would seed the workspace twice -- the manifest only ever
    # adds, so the readback would report rooms holding more than planned and the second
    # pass would collide on names it had just created.
    if req.seed and not req.seed_here:
        result["seed"] = run_seed_inline(meta, req.seed_profile, req.stats, emit)
    # `--monitor` last, and only once the workspace is serving: attaching turns on
    # RC's own Prometheus_Enabled over REST, which needs a workspace that answers.
    # Ignoring the flag here is what `--seed` did, and it produced a create that
    # silently did less than it was asked for.
    if req.monitor:
        if not (req.wait or req.seed):
            wait_serving(meta, emit, timeout=600.0)
        from rc_repro.services import monitor as monitorsvc
        # An add-on failing does not un-create the workspace. The first live run of
        # this failed on the monitoring chart and exited 7 with `montest` up,
        # serving, and listed as running -- a create reported as failed while its
        # result was sitting there working. The workspace is the deliverable; say
        # what went wrong with the extra and name the command that retries it.
        try:
            result["monitoring"] = monitorsvc.attach(repro_name, emit)
        except ReproError as exc:
            warn(emit, f"the workspace is up, but monitoring did not attach: {exc}",
                 phase="monitor")
            warn(emit, f"retry it with: rc-repro monitor --name {repro_name}",
                 phase="monitor")
            result["monitoring"] = {"monitoring": False, "error": str(exc)}
    info(emit, f"{root}  admin / {meta.admin_pass}", phase="done", pct=100)
    return result


def _stop_port_forward(pid: int, *, namespace: str = "") -> None:
    """Kill a workspace's port-forward, if it is still ours to kill.

    Best-effort and deliberately narrow, and it was not narrow enough: the check was
    "is this process a kubectl port-forward", which is liveness wearing identity's
    clothes. A recycled pid belonging to ANOTHER workspace's forward -- or another
    user's, on a shared box -- passed it and was signalled, which is precisely the
    failure this docstring already called much worse than leaving a dead pid recorded.

    `namespace` is the discriminator, and every caller knows it. Delegated to
    `k8s.forward_alive` so there is one definition of "ours".
    """
    from rc_repro.services import k8s
    if not k8s.forward_alive(pid, namespace=namespace):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass


def kubernetes_state(name: str, meta) -> str:
    """`running` / `down` for a Kubernetes workspace.

    `repro_state()` asks docker whether the project's containers exist, so it called
    a live Kubernetes workspace `down` -- the state column was reporting on the
    wrong runtime entirely.
    """
    from rc_repro.services import k8s
    context = str((getattr(meta, "extra", None) or {}).get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    # "?" ON A REFUSED READ, which is the word the Docker branch one function up
    # already uses when the daemon is unreachable -- and which the browser already
    # renders (app.js `stateClass`, and the guard that stops it claiming "0 running").
    # Without it a healthy workspace read as `down` whenever the cluster could not be
    # asked: measured at 8.3s, one PROBE_TIMEOUT, with `docker pause` on the control
    # plane, while the workspace was serving throughout. `down` is the word that
    # invites `up --force` and `down --volumes`, so it is the worst available guess.
    held = k8s.workspace_namespaces(context)
    if held is None:
        return "?"
    if k8s.namespace_for(name) not in held:
        return "down"
    # The namespace EXISTING is not the workspace running. A plain `down` keeps the
    # namespace and its PVC on purpose and uninstalls the release, so a torn-down
    # workspace reported "starting" -- and would have reported it forever, because
    # nothing was coming. Ask for the workload instead.
    if not k8s.workload_exists(name, context=context):
        return "down"
    # Scaled to zero is STOPPED, not starting. `stop` is implemented as scale-to-zero
    # -- there is no other "stopped" on this runtime -- and without this the column
    # said "starting" for a workspace that had been deliberately stopped and was
    # never going to move. The word has to match the verb the user just used.
    if k8s.desired_replicas(name, context=context) == 0:
        return "stopped"
    if k8s.workspace_ready(name, context=context):
        return "running"
    # NOT-READY IS NOT ALWAYS STARTING. Everything that was not ready read as
    # "starting", which is a promise: it says something is coming. For a wedged
    # `pending-install` release or a pod in ImagePullBackOff / CreateContainerConfigError
    # nothing is coming, and the column said "starting" for as long as anyone looked.
    # Both facts were already available -- `terminal_pod_failure` returned the pod,
    # the reason and the message while `list` printed "starting" beside it -- and
    # nothing consulted them. Verified live: a deployment on an unpullable image
    # reported `starting` while `terminal_pod_failure` named ImagePullBackOff.
    #
    # `failed` rather than a reason, because this is a state COLUMN: `info` and the
    # detail panel carry the why. Any probe here may itself be refused, and a refused
    # read must not manufacture a failure, so each is guarded and falls back to the
    # honest "starting".
    try:
        if k8s.terminal_pod_failure(name, context=context):
            return "failed"
    except Exception:  # noqa: BLE001 - a refused probe is not evidence of failure
        pass
    try:
        state, _ = k8s.release_state(k8s.RELEASE, k8s.namespace_for(name), context)
        if state in k8s.PENDING_STATES or state == "failed":
            return "failed"
    except Exception:  # noqa: BLE001 - same
        pass
    return "starting"


#: How many consecutive ready-but-not-Rocket.Chat rounds before the port is called
#: foreign. Each round costs a `workspace_ready` probe plus a socket check, so this is
#: seconds of grace for a pod that has just passed its probe -- not a retry budget.
FOREIGN_PORT_STRIKES = 4


def _wait_serving_kubernetes(meta: runner.Metadata, emit: Emit,
                             timeout: float) -> dict:
    """Wait for a Kubernetes workspace to serve, and make sure it is reachable.

    Two jobs, because on this runtime they are different questions. The pod being
    Ready is Kubernetes' answer; the URL answering also needs a live port-forward,
    and a forward dies with its pod. `ready` is exactly when someone asks "why is
    the URL not answering", so it re-establishes one rather than reporting a
    healthy workspace the caller still cannot reach.
    """
    import time as _time

    from rc_repro.services import k8s

    extra = meta.extra if isinstance(meta.extra, dict) else {}
    context = str(extra.get(config.EXTRA_CONTEXT) or k8s.CONTEXT)
    namespace = str(extra.get("namespace") or k8s.namespace_for(meta.name))
    deadline = _time.monotonic() + timeout
    last = 0.0
    #: Consecutive rounds where the workspace is ready and the port answers with
    #: something that is not Rocket.Chat. Grace, not tolerance: it ends in a refusal.
    foreign = 0
    while _time.monotonic() < deadline:
        if k8s.workspace_ready(meta.name, context=context):
            pid = k8s.ensure_port_forward(
                meta.name, namespace=namespace, context=context,
                host_port=meta.host_port, pid=extra.get("port_forward_pid"),
                bind_host=str(extra.get("bind_host") or ""), emit=emit)
            if pid and pid != extra.get("port_forward_pid"):
                runner.update_meta(meta.name,
                                   lambda m: m.extra.update({"port_forward_pid": pid}))
                # AND IN MEMORY, or whoever renders from this `meta` afterwards is
                # reading the pid we just replaced. `ready` repaired a dead forward
                # and then printed "The URL is not published right now" underneath
                # "is serving at <url>" -- both true of different moments, and only
                # on the repair path. That note is the only honest signal about a
                # dead forward, so a false one there teaches people to ignore it.
                if isinstance(meta.extra, dict):
                    meta.extra["port_forward_pid"] = pid
            # The pod being Ready is not the URL answering. `kubectl port-forward`
            # returns a pid before it binds the socket, so declaring ready here on
            # the strength of the pid alone is a guess -- and after `restart` it was
            # a wrong one: `ready` exited 0 and the very next request to the URL it
            # had just confirmed got nothing at all. Confirm the socket, and if it
            # is not up yet go round again rather than reporting a workspace the
            # caller cannot reach.
            if k8s.forward_reachable(meta.host_port):
                # OCCUPANCY IS NOT IDENTITY, and this was the only runtime that
                # confused the two. The Docker path has always gone through
                # `rcapi.wait_ready`, which polls /api/info; here readiness was
                # concluded from a Ready pod plus "the port answers" and nothing ever
                # asked Rocket.Chat anything. A foreign process holding the recorded
                # port therefore passed: `ready` printed "is serving at <url>" and
                # exited 0 while a completely different program served that URL, and
                # every conclusion a support engineer drew from it was about the wrong
                # software. The port is only validated at create time and 3000+ is the
                # most contested range on a dev box, so this is an ordinary event.
                served = rcapi.api_info(meta.root_url)
                if served is not None:
                    # THE SERVICE IS NEVER TRAVERSED by anything on this path, and on
                    # this runtime that matters: readiness reads pod status, the
                    # port-forward targets the Deployment, and the default deployment
                    # is microservices, where in-cluster Service traffic is what
                    # carries the product. So a Service whose selector matches nothing
                    # looked exactly like a healthy workspace -- reachable through the
                    # forward, 200 from the host, and dead to every pod in the cluster.
                    #
                    # WARNED, not gated: endpoints churn during a rollout and a false
                    # negative here would block a boot, which is worse than the defect.
                    empty = k8s.services_without_endpoints(meta.name, context=context)
                    if empty:
                        warn(emit, "no ready pod is behind "
                                   + ", ".join(empty)
                                   + f" — the URL works because the port-forward goes "
                                     f"straight to the Deployment, but nothing inside "
                                     f"the cluster can reach {'these' if len(empty) > 1 else 'it'}"
                                     f". `kubectl -n {namespace} get endpointslices` "
                                     f"shows what is behind each Service.",
                             phase="ready")
                    info(emit, f"{meta.name!r} is serving at {meta.root_url}",
                         phase="ready", pct=100)
                    return {"ready": True, "url": meta.root_url}
                # WHOSE forward is irrelevant once the workspace itself is ready.
                # The first version raised only when our forward was dead, and the
                # live run found the case that misses: on a dual-stack box kubectl
                # binds `[::1]` quite happily while a squatter holds `127.0.0.1`, so
                # our forward is ALIVE, `localhost` resolves v4-first to the squatter,
                # and this polled to a timeout. Measured -- `ss -ltnp` showed python
                # on 127.0.0.1:3001 and kubectl on [::1]:3001 at the same moment.
                #
                # So the test is the workspace's own state: if Kubernetes says it is
                # ready and the port answers with something that is not Rocket.Chat,
                # then whatever is on that port is not this workspace, and waiting
                # will not change it. Counted rather than acted on at once, because a
                # pod that has just passed its probe may not be serving for another
                # moment, and accusing somebody then would be worse than waiting.
                foreign += 1
                if foreign >= FOREIGN_PORT_STRIKES:
                    raise ConflictError(
                        f"port {meta.host_port} is answering, but not with "
                        f"Rocket.Chat, and {meta.name!r} is otherwise ready — so "
                        f"nothing served on {meta.root_url} can be trusted to be this "
                        f"workspace. Something else holds that port. `ss -ltnp | grep "
                        f"{meta.host_port}` says what; note it may hold only IPv4 "
                        f"while the port-forward has IPv6, which looks healthy from "
                        f"rc-repro and wrong from a browser. Free the port, or "
                        f"`rc-repro down --name {meta.name}` then `rc-repro up` for "
                        f"one that is free.")
                extra = dict(extra, port_forward_pid=pid)
            else:
                foreign = 0
                extra = dict(extra, port_forward_pid=pid)
        # Stop waiting for something Kubernetes has already decided cannot happen.
        # A mistyped version or an unreachable registry used to cost the full timeout
        # and then report the timeout rather than the cause.
        doomed = k8s.terminal_pod_failure(meta.name, context=context)
        if doomed:
            pod, reason, message = doomed
            raise CreateFailedError(
                f"{meta.name!r} cannot start: pod {pod} is {reason}"
                + (f" — {message}" if message else "")
                + f". Nothing will change by waiting. `kubectl -n {namespace} "
                  f"describe pod {pod}` has the detail.")
        now = _time.monotonic()
        if now - last > 15:
            last = now
            info(emit, f"waiting for Rocket.Chat in {namespace}", phase="wait")
        _time.sleep(3.0)
    raise NotReadyError(
        f"Rocket.Chat did not become ready within {int(timeout)}s. "
        f"kubectl -n {namespace} get pods")
