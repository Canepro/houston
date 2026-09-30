"""Which binaries are here and what version they are.

Tier k1. `kind` is OPTIONAL: creating a cluster needs it, using one does not, so a missing `kind`
narrows what houston can do without stopping it working in the cluster you already have.
`Preflight` is everything `doctor` needs in one pass, changing nothing.
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field

from houston.services.k8s import exec as kubeexec
from houston.services.k8s.names import (CORE_TOOLS, LOCAL_PROVISION_TOOLS,
                                        PROBE_TIMEOUT, TOOLS, tuning)

@dataclass
class Tool:
    """One binary: whether it is there, what version, and whether that is enough."""
    name: str
    path: str = ""
    version: tuple[int, ...] = ()
    raw: str = ""

    @property
    def present(self) -> bool:
        return bool(self.path)

    @property
    def new_enough(self) -> bool:
        floor = TOOLS.get(self.name)
        if not floor or not self.version:
            # Unknown version with the binary present is not a failure: a distro
            # may print something this does not parse, and refusing to proceed
            # over an unrecognised version string would be worse than trying.
            return True
        return self.version[:len(floor)] >= floor

    @property
    def pretty(self) -> str:
        return ".".join(str(n) for n in self.version) if self.version else (self.raw or "?")

@dataclass
class Preflight:
    """What this machine can do, as facts rather than a verdict.

    The verdict belongs to the caller, because it depends on what is being asked:
    a box with no `kind` is perfectly healthy if nobody wants Kubernetes, and
    broken if a Kubernetes workspace already exists on it.
    """
    tools: dict[str, Tool] = field(default_factory=dict)
    cluster_exists: bool = False
    cluster_reachable: bool = False
    #: Whether HELM can reach the cluster, asked separately from kubectl on purpose.
    #: See `helm_reachable`. "" means not asked (no cluster to ask about).
    helm_reachable: str = ""
    storage_classes: list[str] = field(default_factory=list)
    default_storage_class: str = ""
    #: Ingress controllers installed here. Empty is NOT a fault -- a workspace
    #: reached by port-forward needs none. It only blocks `--domain`, so it is
    #: checked at create time against what was asked for, never in `doctor`.
    ingress_classes: list[str] = field(default_factory=list)
    other_clusters: list[str] = field(default_factory=list)
    namespaces: list[str] = field(default_factory=list)
    #: What this cluster IS, and what it can do. The name is for the wording of a
    #: message and never for a branch -- what it CAN do is each of the fields below,
    #: because `k3s --disable traefik` is a real setup and minikube's ingress is an
    #: addon that ships off.
    distribution: str = ""
    node_count: int = 0
    architectures: list[str] = field(default_factory=list)
    metrics: bool = False
    #: Evidence that a LoadBalancer works here, or "" -- see loadbalancer_address().
    loadbalancer: str = ""
    #: The context actually probed, and how that cluster came to exist. On a box
    #: with no kind this is whatever `kubectl` is already pointed at -- the
    #: bring-your-own-cluster case, where houston manages namespaces and never
    #: the cluster.
    context: str = ""
    provider: str = ""
    #: Whether this call would BRING THE CLUSTER INTO EXISTENCE. Reported rather
    #: than inferred from `cluster_reachable`, because "not answering" and "not made
    #: yet" are different sentences and send a reader to different places.
    will_create: bool = False
    #: Which cluster facts could not be READ, as opposed to read as empty. Same
    #: distinction as `probe_failed` below, one level down: a restricted kubeconfig
    #: can pass `/readyz` and then be refused every actual read, and reporting those
    #: as "no StorageClass, no ingress, 0 nodes" made doctor state three false facts
    #: under a green verdict. Named here so the verdict can see them.
    unreadable: list[str] = field(default_factory=list)
    #: Why the cluster question could not be ANSWERED, as opposed to answered no.
    #: `kind get clusters` fails when Docker is down, and returns nothing when there
    #: are simply no clusters -- both give an empty list. Reporting the first as
    #: "the cluster does not exist" would send someone to create one that is
    #: already there, so the two are kept apart.
    probe_failed: str = ""

    @property
    def tools_ready(self) -> bool:
        """Whether Kubernetes can be USED. Provisioning is a separate question.

        Keyed on CORE_TOOLS rather than on what happens to be in `self.tools`, because
        `all()` over nothing is True: a Preflight carrying no tool information at all
        claimed every tool was ready, which is "I have no idea" reported as "yes".
        """
        return all(n in self.tools and self.tools[n].present
                   and self.tools[n].new_enough for n in CORE_TOOLS)

    @property
    def can_provision(self) -> bool:
        """Whether houston can CREATE a cluster ON THIS MACHINE, as opposed to use one.

        Same reasoning as `tools_ready`: no information is not a yes. Keyed on
        LOCAL_PROVISION_TOOLS, so a cloud tool appearing in the registry cannot turn
        this False on a box that has kind -- see that dict for what that would break.
        """
        return all(n in self.tools and self.tools[n].present
                   and self.tools[n].new_enough for n in LOCAL_PROVISION_TOOLS)

    @property
    def can_provision_cloud(self) -> bool:
        """Whether houston can CREATE a cluster on a cloud provider.

        False on an empty registry, deliberately: `all()` over nothing is True, and
        "there is no cloud tooling compiled in" must not read as "yes, this box can
        build you an EKS cluster".
        """
        if not tuning.CLOUD_PROVISION_TOOLS:
            return False
        return all(n in self.tools and self.tools[n].present
                   and self.tools[n].new_enough for n in tuning.CLOUD_PROVISION_TOOLS)

    @property
    def missing_tools(self) -> list[str]:
        """Only the ones that stop Kubernetes working. A missing `kind` means
        houston cannot make you a cluster, not that it cannot use yours."""
        return [n for n in CORE_TOOLS if n in self.tools and not self.tools[n].present]

    @property
    def outdated_tools(self) -> list[str]:
        return [n for n, t in self.tools.items() if t.present and not t.new_enough]

    @property
    def usable(self) -> bool:
        """A cluster is reachable and houston could put a workspace in it."""
        return self.tools_ready and self.cluster_reachable

def which(tool: str) -> str:
    """Absolute path to a tool, or "" -- the one place PATH is consulted."""
    return shutil.which(tool) or ""

def _parse_version(text: str) -> tuple[int, ...]:
    """First dotted number in a version string, as a tuple.

    Deliberately loose: `kind v0.32.0 go1.26.3 linux/amd64`,
    `Client Version: v1.36.3` and `v4.2.3+g43e8b7f` are all real output from the
    three tools, and each spells it differently.
    """
    match = re.search(r"v?(\d+)\.(\d+)(?:\.(\d+))?", text or "")
    if not match:
        return ()
    return tuple(int(g) for g in match.groups() if g is not None)

def tool(name: str) -> Tool:
    """Locate one tool and read its version."""
    found = Tool(name=name, path=which(name))
    if not found.present:
        return found
    # The fallback is `--version`, and a tool that does not accept it is not merely
    # unprobed: `_parse_version` returns () on the error text, and `Tool.new_enough`
    # answers True on an empty version -- deliberately and correctly, so that an
    # unparseable version never blocks a working tool. The two combine into a floor
    # that silently passes. `eksctl` is cobra-based and spells it `eksctl version`,
    # so it is listed here rather than left to a fallback it would fail.
    argv = {
        "kind": [name, "version"],
        "kubectl": [name, "version", "--client"],
        "helm": [name, "version", "--short"],
        "eksctl": [name, "version"],
    }.get(name, [name, "--version"])
    res = kubeexec.kube.run(argv, timeout=PROBE_TIMEOUT)
    found.raw = (res.stdout or res.stderr or "").strip().splitlines()[0] if (
        res.stdout or res.stderr) else ""
    found.version = _parse_version(found.raw)
    return found

def _version_key(text: str) -> tuple:
    """Sort key for a semver-ish string. Non-numeric parts sort low."""
    out = []
    for part in str(text).split("."):
        digits = re.match(r"(\d+)", part)
        out.append(int(digits.group(1)) if digits else -1)
    return tuple(out)
