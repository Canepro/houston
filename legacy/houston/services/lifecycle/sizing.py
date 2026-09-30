"""What a workspace costs, and whether this box has it.

Tier 0. `check_capacity` REFUSES rather than warning: the tool is usually run on a laptop
already running other stacks, and a create that starts and then cannot finish leaves a
half-made workspace behind.
"""
from __future__ import annotations

from houston import runner
from houston.errors import PreflightError
from houston.services import topology
from houston.services.events import Emit, null_emit, warn
from houston.services.lifecycle import request
from houston.services.lifecycle.types import CreateReq


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
    `houston doctor` reports it, and the GUI's home page leads with it. They used
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
    from houston.services import topology
    if topology.normalize(getattr(req, "runtime", "")) != topology.KUBERNETES:
        return 0
    # The chart's own baseline, on both deployments -- see KUBE_CHART_MB.
    need = KUBE_CHART_MB
    # Charged when a control plane is about to be BUILT, which is the only case where
    # its memory is new. An earlier version charged unless houston's own kind cluster
    # existed, on the reasoning that "somebody else's cluster being up does not mean
    # the control plane is already paid for" -- true while houston always created its
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
    from houston.services import topology
    if topology.normalize(getattr(req, "runtime", "")) != topology.KUBERNETES:
        return
    # The floor's whole premise is that the container VM has to hold a control plane.
    # When the cluster is not one houston is about to build in Docker -- an adopted
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


def runtime_cost(runtime: str, deployment: str = "") -> dict:
    """Roughly what one workspace costs, from the numbers `check_capacity` spends.

    The same constants, not a second set written for the screen: a card that quotes
    1.1 GB while the preflight reserves something else is a card that will be
    contradicted by the refusal it was meant to prevent. `cluster_mb` is charged
    separately because it is paid once per machine, not once per workspace.
    """
    from houston.services import topology
    if topology.normalize(runtime) != topology.KUBERNETES:
        return {"workspace_mb": WORKSPACE_MB, "cluster_mb": 0, "shape": "2 containers"}
    deployment = deployment or topology.DEPLOYMENTS[topology.KUBERNETES][0]
    micro = deployment == topology.MICROSERVICES
    return {
        "workspace_mb": WORKSPACE_MB + KUBE_CHART_MB + (MICROSERVICES_MB if micro else 0),
        "cluster_mb": CLUSTER_MB,
        "shape": "9 pods" if micro else "5 pods",
    }


def _refuse_for_capacity(available_mb, emit, headroom, need, req, reserve, swap_mb, total_mb):
    """Say no, and say what to stop instead. Long because the message is the product here: a refusal nobody can act on is a refusal they work around with --force."""
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
        "  Free some memory first — `houston stop --name <it>` keeps the data:\n"
        "    houston list\n"
        "  Or override this check if you are sure:  --force")


def _say_what_is_left(emit, headroom, need):
    """Say so while it is still comfortable, so the ceiling is visible before it is
    hit rather than only in the refusal."""
    if headroom - need < WORKSPACE_MB:
        warn(emit, f"after this one, about {max(0, headroom - need)} MB is left "
                   f"— roughly {max(0, (headroom - need)) // WORKSPACE_MB} more "
                   "workspace(s). `houston list` shows what is running.",
             phase="create")


def _needed_mb(preset_name, provisioning, req):
    """What this create will actually take: the workspace, its preset's sidecars, monitoring if asked for, and the Kubernetes overhead -- which is not a Compose workspace with a different label."""
    need = WORKSPACE_MB + PRESET_MB.get(preset_name, 0)
    if req.monitor:
        need += MONITORING_MB
    # A Kubernetes workspace is not a Compose workspace with a different label. It
    # brings a control plane if there is not one yet, and microservices runs six
    # more processes than a monolith -- charging it as Compose would let through
    # exactly the create this function exists to refuse.
    need += _kube_overhead_mb(req, provisioning)
    return need


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
    limits and enough RAM are what actually bound the total", and houston sets no
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
    provisioning = request._will_provision(req)
    _check_engine_floor(req, emit, provisioning)
    mem = runner.host_memory()
    if mem is None:                     # not Linux: skip rather than guess
        return
    total_mb, available_mb, swap_mb = mem
    need = _needed_mb(preset_name, provisioning, req)

    reserve = host_reserve_mb(total_mb)
    headroom = available_mb - reserve
    if need <= headroom:
        _say_what_is_left(emit, headroom, need)
        return

    _refuse_for_capacity(available_mb, emit, headroom, need, req, reserve, swap_mb, total_mb)
