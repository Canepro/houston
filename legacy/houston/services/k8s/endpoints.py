"""Where a cluster receives traffic, and whether that is this box.

Tier k2, read-only. Ingress endpoints, host-port claims and the address arithmetic
around them. `is_local_address` is a bind test rather than a dial, which is why it is
the one place in this tier that opens a socket.
"""
from __future__ import annotations

import json
import shutil
import socket
import time
from dataclasses import dataclass, field

from houston.errors import ConflictError
from houston.services.events import Emit, info, null_emit
from houston.services.k8s import ask
from houston.services.k8s import context as kubectx
from houston.services.k8s import names as vocab
from houston.services.k8s import reachability
from houston.services.k8s.exec import kube
from houston.services.k8s.names import CONTEXT, PROBE_TIMEOUT

def loadbalancer_service(context: str = CONTEXT) -> tuple[str, str]:
    """`(service name, address)` for the first LoadBalancer Service that has one.

    Split out from `loadbalancer_address`, which returns a SENTENCE for the report --
    "traefik has 172.16.0.2". That was the only caller for a while, and the first
    caller that needed the address itself got the sentence and silently did nothing
    with it: `_is_local_address("traefik has 172.16.0.2")` is False, so a `doctor`
    check written against it never fired. A value shaped for a screen is not a value.

    This is also the address the Kubernetes HTTPS work needs -- the endpoint an edge
    passes TLS through to -- so it is a seam rather than a helper for one check.
    """
    # READ AS OBJECTS, NOT AS A JSONPATH. The jsonpath this replaces interpolated
    # `{...ingress[0].ip}{...ingress[0].hostname}` adjacently, with nothing between
    # them. It was safe only because the two platforms in play populate exactly one
    # each -- k3s ServiceLB sets `ip`, an AWS ELB/NLB sets `hostname` -- so a Service
    # carrying BOTH (some controllers do, and dual-stack setups do) yielded the two
    # concatenated into one nonsense string, which then travelled into
    # `IngressEndpoint.address` and out as a printed CNAME target somebody would paste
    # into DNS.
    #
    # HOSTNAME IS PREFERRED EXPLICITLY rather than by hoping the other field is empty.
    # A CNAME target has to be a name, and where a provider gives both, the name is
    # the stable one -- an ELB's addresses change under it.
    #
    # And every ingress entry is considered, not `[0]` alone: a provider that lists an
    # address-less entry first would otherwise read as a load balancer with no address.
    name, address, _pending = loadbalancer_state(context)
    return name, address

def loadbalancer_state(context: str = CONTEXT) -> tuple[str, str, int]:
    """`(service name, address, how many LoadBalancer Services have no address yet)`.

    THE THIRD VALUE IS THE ONE `loadbalancer_service` COULD NOT EXPRESS. It returns a
    name only alongside an address, so "this cluster has no LoadBalancer Service" and
    "it has one and the provider has not published an address yet" both came back as
    `("", "")` -- and a caller that wanted to wait could not tell whether waiting had
    any point. On EKS the second is the normal state for the first minute or two after
    a create.
    """
    found = ask.ask_list("svc", context=context, all_namespaces=True)
    if found.refused:
        return "", "", 0
    pending = 0
    for svc in found.items:
        if str(((svc.get("spec") or {}).get("type")) or "") != "LoadBalancer":
            continue
        status = ((svc.get("status") or {}).get("loadBalancer") or {})
        for entry in (status.get("ingress") or []):
            addr = str(entry.get("hostname") or entry.get("ip") or "").strip()
            if addr:
                return str((svc.get("metadata") or {}).get("name") or ""), addr, pending
        pending += 1
    return "", "", pending

#: How long `wait_for_loadbalancer` will wait for a provider to publish an address.
#: An AWS ELB/NLB commonly takes one to three minutes; k3s ServiceLB is immediate.
LOADBALANCER_TRIES = 60

LOADBALANCER_INTERVAL = 3.0

def wait_for_loadbalancer(context: str, *, emit: Emit = null_emit,
                          sleep=time.sleep) -> tuple[str, str]:
    """`(service name, address)` once a provider has published one, or ("", "").

    `loadbalancer_service` asks once, which is right for a report. It is wrong for
    `cluster prepare`, which runs immediately after a 20-minute `cluster create` and
    whose `cname_target` is the one line an operator needs in order to finish the job:
    an ELB commonly takes one to three minutes to publish a hostname, so the normal
    outcome of a successful create was a blank CNAME target.

    A BLANK IS STILL A REAL ANSWER at the end of the wait -- no controller, or nobody
    asked for a LoadBalancer Service -- and the caller must not print it as though it
    were a hostname. This only stops "not yet" being reported as "none".
    """
    said = False
    for attempt in range(LOADBALANCER_TRIES):
        name, address, pending = loadbalancer_state(context)
        if address:
            return name, address
        if not pending:
            # NOTHING IS PENDING. No LoadBalancer Service is waiting on an address, so
            # no amount of waiting will produce one, and spending three minutes proving
            # it would be the slowest possible way to say "there is no ingress here".
            # This is also the answer on a refused read -- see `loadbalancer_state`.
            return "", ""
        if not said:
            info(emit, f"waiting for {pending} load balancer(s) to be given an "
                       f"address — a cloud provider takes a minute or two",
                 phase="provision")
            said = True
        if attempt < LOADBALANCER_TRIES - 1:
            sleep(LOADBALANCER_INTERVAL)
    return "", ""

def loadbalancer_address(context: str = CONTEXT) -> str:
    """Evidence that a LoadBalancer works here, phrased for the report, or "".

    EVIDENCE, not a capability claim: "no address" means either no controller or nobody
    asked for one, and those cannot be told apart from outside. Reported as what it is,
    because a cluster that has given a Service a real address has demonstrably got a
    load balancer -- which on k3s is ServiceLB and on kind is nothing at all.

    For the address itself, call `loadbalancer_service`.
    """
    name, addr = loadbalancer_service(context)
    return f"{name} has {addr}" if addr else ""

@dataclass(frozen=True)
class IngressEndpoint:
    """Where the edge dials to reach one cluster's ingress. The one new seam.

    THE EARLIER DESIGN GOT THIS WRONG AND IT IS WORTH RECORDING WHY, because the
    wrong version is written down in two places. `.docs/design/k8s-https.md` §2 calls
    the endpoint "the ingress Service's LoadBalancer address on port 443, and nothing
    else", and demotes a NodePort to "a fallback for a cluster with no LoadBalancer
    address at all -- not the k3s path". Its own acceptance test then ran through a
    NodePort, because it had to.

    Both sources are first-class, and which one is available is a fact about the
    cluster rather than a preference:

    * a LoadBalancer address that is NOT one of this host's own -- kind with MetalLB,
      or any remote cluster. The edge reaches it directly.
    * a LoadBalancer address that IS one of this host's own -- k3s's ServiceLB. Still
      dialable (measured: from a container on an unrelated Docker network,
      172.16.0.2:443 answered with the cluster's certificate), but it also means the
      cluster is receiving on a port the edge thinks it owns, which is `PortClaim`'s
      business and is why `local` is reported rather than hidden.
    * a NodePort, when there is no LoadBalancer address at all. Every one of these
      Services carries one anyway, so this is a real answer and not a degraded one.

    `source` and `service` exist so a message can name what was chosen and where it
    came from. Nothing branches on `source`; that is the point of having a seam.
    """
    address: str
    port: int
    #: "loadbalancer" | "nodeport" -- for the sentence, never for a branch.
    source: str = ""
    #: `namespace/name` of the Service this came from.
    service: str = ""
    #: Whether `address` is one of THIS host's own addresses.
    local: bool = False

    def __str__(self) -> str:
        return f"{self.address}:{self.port}"

#: How a Service that fronts an ingress controller is recognised. There is no
#: Kubernetes link from an IngressClass to the Service that serves it -- the class
#: names a CONTROLLER string and nothing else -- so this is inferred, and the
#: inference is stated rather than buried.
#:
#: Two conditions, and the second is what makes it defensible. It must publish 443,
#: and it must be REACHABLE FROM OUTSIDE THE CLUSTER -- LoadBalancer or NodePort. A
#: ClusterIP is not merely unrouted from a Docker container but unroutable: a virtual
#: IP realised by kube-proxy's netfilter rules on the node, measured answering `000`
#: from the host. So a ClusterIP Service cannot be an ingress front door, whatever
#: port it publishes.
#:
#: Port alone was tried first and was wrong on the very first real cluster: k3s
#: answers with THREE Services on 443 -- `default/kubernetes` (the API server),
#: `kube-system/metrics-server` and `kube-system/traefik` -- and only the last is the
#: ingress. Both of the others are ClusterIP, so the reachability condition separates
#: them exactly.
#:
#: STATED LIMIT: an ingress controller exposed by a hostPort DaemonSet rather than a
#: Service -- an ingress-nginx installed that way -- has no Service to find here, so
#: this answers None and the caller refuses. That is the same gap
#: `port_claiming_cluster` records, and narrower than it sounds: it is not how any of
#: kind, k3s or a managed cluster ships.
INGRESS_PORT = 443

#: Service types that can be reached from outside the cluster at all.
REACHABLE_SERVICE_TYPES = ("LoadBalancer", "NodePort")

def ingress_endpoint(context: str = CONTEXT, *,
                     port: int = INGRESS_PORT) -> "IngressEndpoint | None":
    """The address the edge passes TLS through to, or None if this cluster has none.

    None means the cluster ANSWERED and has no Service fronting `port`. A read that
    could not be made raises instead, through `Answer.require` -- because "I could
    not ask" and "there is no ingress here" would send a caller to two completely
    different places, and only one of them is safe to act on. That distinction is
    this module's oldest rule and the reason `Answer` exists.
    """
    svcs = ask.ask_list("svc", context=context, all_namespaces=True) \
        .require("Services", context=context)
    fronting = []
    for svc in svcs.items:
        spec = svc.get("spec") or {}
        if (spec.get("type") or "") not in REACHABLE_SERVICE_TYPES:
            continue
        ports = [p for p in (spec.get("ports") or [])
                 if isinstance(p, dict) and p.get("port") == port]
        if not ports:
            continue
        meta = svc.get("metadata") or {}
        where = f"{meta.get('namespace', 'default')}/{meta.get('name', '?')}"
        ingress = ((svc.get("status") or {}).get("loadBalancer") or {}).get("ingress") or []
        addr = next((i.get("ip") or i.get("hostname") or "" for i in ingress), "")
        node_port = next((p.get("nodePort") for p in ports
                          if isinstance(p.get("nodePort"), int)), None)
        fronting.append((where, spec.get("type") or "", addr, node_port))
    if not fronting:
        return None
    if len(fronting) > 1:
        # NOT a guess. Picking the first would work on every cluster anybody has
        # tested and silently serve the wrong ingress on the one that matters.
        raise ConflictError(
            f"cluster {context!r} has {len(fronting)} externally-reachable Services "
            f"publishing :{port} ({', '.join(w for w, *_ in fronting)}), so which one "
            f"fronts the ingress cannot be told from Kubernetes -- an IngressClass "
            f"names a controller, never a Service. Reach this workspace on its "
            f"port-forward instead, or remove the ambiguity in the cluster.")
    where, kind, addr, node_port = fronting[0]
    if addr:
        return IngressEndpoint(address=addr, port=port, source="loadbalancer",
                               service=where, local=is_local_address(addr))
    if node_port is not None:
        node = node_address(context)
        if node:
            return IngressEndpoint(address=node, port=int(node_port),
                                   source="nodeport", service=where,
                                   local=is_local_address(node))
    return None

def kind_node_container(context: str) -> str:
    """The Docker container holding a kind cluster's node, or "" if not kind.

    A pure derivation, no I/O and no `docker` -- `runner`/`edge` own that seam and this
    module must not grow a second one. kind names its context `kind-<cluster>` and its
    single node container `<cluster>-control-plane`, which is enough to ask Docker
    where that container lives.

    This exists because a kind cluster's ingress NodePort is on kind's own Docker
    network: reachable from the host, and not from a container on the default bridge.
    So the edge has to join it, which is `k8s-https.md` §4's fifth finding and the one
    piece of it that is genuinely kind-specific.
    """
    if not context.startswith("kind-"):
        return ""
    cluster = context[len("kind-"):]
    return f"{cluster}-control-plane" if cluster else ""

def node_address(context: str = CONTEXT) -> str:
    """An address a node answers on, for the NodePort case, or "".

    InternalIP, and deliberately not ExternalIP: this is dialled from the edge, a
    container on the same box, so the routable answer is the one on the cluster's own
    network. On k3s and kind that is the same machine either way.
    """
    seen = ask.ask_list("nodes", context=context).require("nodes", context=context)
    for node in seen.items:
        for entry in ((node.get("status") or {}).get("addresses") or []):
            if entry.get("type") == "InternalIP" and entry.get("address"):
                return str(entry["address"])
    return ""

@dataclass
class PortClaim:
    """A cluster holding one of THIS host's ports through a LoadBalancer Service.

    The failure this exists to name is silent by construction. k3s's ServiceLB
    (klipper) claims a host port with a `hostPort`, which is CNI portmap DNAT and
    not a socket bind -- so nothing conflicts, no pod fails, `ss` shows only
    docker-proxy, and `docker ps` shows nothing at all because k3s runs on
    containerd under systemd. houston's edge then binds :80 and :443 perfectly
    happily and never receives a packet on either: kube-proxy's chain gets them
    first. Measured on the box where it took a manager's GUI dark for two days --
    every name answered the cluster's 404 and the cluster's certificate, while
    `houston edge status` said the edge was running, because it was.

    `ports` is what the Service asks for, so both :80 and :443 are visible. That
    distinction is the whole diagnosis on an ACME failure: :443 taken breaks
    TLS-ALPN and serving, :80 taken breaks HTTP-01 -- and a check that only knew
    about :443 would have called the second one healthy.
    """
    context: str
    service: str
    address: str
    ports: list[int] = field(default_factory=list)

def is_local_address(ip: str) -> bool:
    """Whether `ip` is one of THIS host's own addresses.

    Bind is the test, because bind is the question: a socket can only bind an
    address the host holds. Cheaper and more portable than parsing `ip addr`, and
    it is the same check the kernel would make.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((ip, 0))
        return True
    except OSError:
        return False

def host_port_claim(context: str,
                    timeout: float = PROBE_TIMEOUT) -> PortClaim | None:
    """The LoadBalancer Service in `context` claiming ports on this host, or None.

    `-o json` rather than a jsonpath because three facts are wanted per Service --
    the address, the ports and where it lives -- and a jsonpath that emits three
    lists leaves the caller re-associating them by position.
    """
    res = kube.run(["kubectl", "--context", context, "get", "svc", "-A", "-o", "json"],
              own=vocab.is_ours(context), timeout=timeout)
    if res.returncode != 0:
        return None
    try:
        items = json.loads(res.stdout or "{}").get("items") or []
    except (ValueError, AttributeError, TypeError):
        return None
    for svc in items:
        spec = svc.get("spec") or {}
        if spec.get("type") != "LoadBalancer":
            continue
        ingress = ((svc.get("status") or {}).get("loadBalancer") or {}).get("ingress") or []
        addr = next((i.get("ip") or i.get("hostname") or "" for i in ingress), "")
        # A LoadBalancer with no address, or one on an address this host does not
        # hold, takes nothing from anybody -- that is a cloud provider's job or a
        # controller that never answered.
        if not addr or not is_local_address(addr):
            continue
        ports = sorted({p["port"] for p in spec.get("ports") or []
                        if isinstance(p.get("port"), int)})
        if not ports:
            continue
        meta = svc.get("metadata") or {}
        where = f"{meta.get('namespace', 'default')}/{meta.get('name', '?')}"
        return PortClaim(context=context, service=where, address=addr, ports=ports)
    return None

def port_claiming_cluster(ports: tuple[int, ...] = (80, 443),
                          contexts: tuple[str, ...] = (),
                          timeout: float = PROBE_TIMEOUT) -> PortClaim | None:
    """The first reachable cluster claiming any of `ports` on this host, or None.

    Both candidates are checked, and the one houston USES is not the interesting
    one: on the box where this was measured houston was on kind, which has no
    LoadBalancer at all, while the k3s alongside it held the ports. A cluster
    houston is not using can still take the edge's ports away.

    `timeout` exists because this also runs on the `edge start` path, where it is a
    WARNING and must cost nearly nothing. Four probes at the 8s default is half a
    minute added to starting a proxy -- on a box whose kubeconfig points at an
    unreachable remote cluster, which is a normal laptop. The no-kubectl exit comes
    first for the same reason: a Docker-only box must not pay for this at all.

    LIMIT, STATED RATHER THAN LEFT TO BE DISCOVERED: only LoadBalancer Services are
    inspected. The DNAT mechanism this whole function exists to catch is a hostPort,
    and a DaemonSet with a hostPort on 80/443 -- an ingress-nginx installed that way,
    for instance -- would claim the ports and not be found here. Default k3s uses a
    LoadBalancer, which is the case that took a manager's GUI dark for two days and is
    covered; the gap is real and narrower than it sounds.
    """
    if not shutil.which("kubectl"):
        return None
    for ctx in dict.fromkeys(contexts or (CONTEXT, kubectx.active_context())):
        if not ctx or not reachability.reachable(ctx, timeout=timeout):
            continue
        claim = host_port_claim(ctx, timeout=timeout)
        if claim and set(claim.ports) & set(ports):
            return claim
    return None
