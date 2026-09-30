"""What things are called, and how to tell one of ours from anything else.

Tier 0 of `services/k8s/`: every constant, the label vocabulary, and the three pure
functions that read it. Nothing here talks to a cluster, reads a file or spawns a
process, so every other module in the package may reach it and it may reach none of
them.

The label vocabulary is the load-bearing part. Selection is BY LABEL, never by name
prefix -- `is_ours` and `OWNER_SELECTOR` are the only two ways to ask "is this
houston's", and a name-prefix match was how a workspace called `houston-anything`
somebody else made once became eligible for teardown.
"""
from __future__ import annotations

import json
import re

from types import SimpleNamespace

#: YAML 1.1 reads eleven spellings of each boolean, and kubectl's parser is a 1.1
#: parser. A label value of `no` therefore arrives at the API server as the boolean
#: false and is refused with "cannot unmarshal bool into Go struct field
#: ObjectMeta.metadata.labels of type string" -- and `no` is a perfectly legal
#: workspace name and a perfectly legal account name, both of which land in a label.
_YAML11_BOOLEANS = re.compile(
    r"^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE"
    r"|on|On|ON|off|Off|OFF)$")

_YAML11_NUMERIC = re.compile(
    r"^[-+]?(0[boxX]?[0-9a-fA-F_]*|[0-9][0-9_]*(\.[0-9_]*)?([eE][-+]?[0-9]+)?)$")

_YAML11_SPECIAL = re.compile(
    r"^(~|null|Null|NULL|\.inf|\.Inf|\.INF|[-+]\.inf|\.nan|\.NaN|\.NAN)$")

#: Sexagesimal: YAML 1.1 reads `12:30:45` as 45045.
_YAML11_SEXAGESIMAL = re.compile(r"^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?$")

#: Anything that could end the scalar, start a new node, carry an indicator, or be
#: read as a line break. U+0085, U+2028 and U+2029 are line breaks in YAML.
_STRUCTURAL = re.compile("[\n\r\t  ]")
_INDICATOR = re.compile(r"^[\s\-?:,\[\]{}#&*!|>'\"%@`]")


def scalar(value: str) -> str:
    """One value, emitted so a YAML 1.1 reader gets back the string that went in.

    These manifests are hand-written templates rather than a document tree, so the
    quoting has to be explicit -- `compose.py` solves the same problem by emitting
    through a YAML library. Explicit is also what a corpus can be pointed at, and
    `tools/parity-manifests.js` points one at exactly this: 48 values through three
    slots, sent to a real API server from both implementations.

    The counterpart of `scalar()` in `src/core/kube/manifests.ts`, and deliberately
    the same rules in the same order. `json.dumps` is used for the quoted form
    because a JSON string is a valid YAML double-quoted scalar, with
    `ensure_ascii=False` so the bytes match what `JSON.stringify` produces rather
    than escaping every non-ASCII character the other side leaves alone.
    """
    plain = (
        value != ""
        and not _YAML11_BOOLEANS.match(value)
        and not _YAML11_NUMERIC.match(value)
        and not _YAML11_SPECIAL.match(value)
        and not _YAML11_SEXAGESIMAL.match(value)
        and not _STRUCTURAL.search(value)
        and not _INDICATOR.match(value)
        and ": " not in value
        and " #" not in value
        and value.strip() == value
    )
    return value if plain else json.dumps(value, ensure_ascii=False)

#: The cluster houston creates and owns. One cluster with a namespace per
#: workspace, not a cluster per workspace: a control plane each would forbid
#: concurrent repros on laptop-scale hardware, which is behaviour houston
#: already has on Compose.
#:
#: houston USES whatever cluster it is pointed at and creates this one only when
#: there is none. An earlier draft always created it, on the argument that kind's
#: `extraPortMappings` are fixed at creation so an adopted cluster could never
#: serve a hostname. Measured on Linux, that is false: kind nodes are directly
#: routable from the host on the `kind` bridge (`curl https://172.19.0.2:6443` ->
#: 200, no mapping), so an ingress in any kind cluster is reachable at the node's
#: :80 and the edge reaches it with `docker network connect`, as it already does
#: for Compose workspaces.
#:
#: What survives is the TEARDOWN asymmetry, which is the part that matters: a
#: cluster houston created it may delete; in one you supplied it owns only the
#: namespaces carrying its label.
CLUSTER_NAME = "houston-local"

#: kind prefixes the kubeconfig context with `kind-`.
CONTEXT = f"kind-{CLUSTER_NAME}"

#: One namespace per workspace. The official guide creates a named namespace and
#: says the name is the operator's choice, so this fits the documented model.
NAMESPACE_PREFIX = "houston-"

#: The Helm release name INSIDE that namespace. Deliberately the same name the
#: official docs use, so every command copied from docs.rocket.chat works with
#: one substitution (the namespace) rather than a translation. PR #3 calls it
#: `rc`, which makes `helm upgrade rocketchat ...` from the docs wrong.
RELEASE = "rocketchat"

#: Ownership. Selection is ALWAYS by this label, never by a name prefix: anyone
#: can create a namespace called `houston-anything`, and a teardown that matched
#: on the prefix would eventually delete one houston never made.
OWNER_LABEL_KEY = "app.kubernetes.io/managed-by"

OWNER_LABEL_VALUE = "houston"

OWNER_SELECTOR = f"{OWNER_LABEL_KEY}={OWNER_LABEL_VALUE}"

WORKSPACE_LABEL = "houston.io/workspace"

OWNER_OF_LABEL = "houston.io/owner"

#: The tools, and the floor each must clear. These two are the official guide's
#: own requirement ("kubectl v1.21+, Helm 3") and they are all that USING
#: Kubernetes needs -- namespaces, helm, PVCs, port-forward and exec are plain
#: Kubernetes and work on k3s, minikube, Docker Desktop or a remote cluster
#: exactly as they work on kind.
CORE_TOOLS: dict[str, tuple[int, int]] = {
    "kubectl": (1, 21),
    "helm": (3, 0),
}

#: WHY each floor is the number it is, so `doctor` can say something true when a tool
#: is below one. It rendered every floor as "the floor the official Rocket.Chat guide
#: requires", which is unverifiable for all of them: the guide's prerequisites name
#: `kubectl` and `eksctl` with NO versions, and do not mention `kind` at all. A reason
#: attached to the wrong number is worse than no reason -- it sends somebody to a
#: document that does not contain the requirement they are being held to.
TOOL_FLOOR_REASON: dict[str, str] = {
    "kind": "where kind's config API and `extraPortMappings` settled",
}

DEFAULT_FLOOR_REASON = "the floor houston requires"

#: Needed only to PROVISION a cluster ON THIS MACHINE, never to use one. kind has no
#: documented floor, so 0.20 is where `extraPortMappings` and the config API settled.
#: Without it houston cannot create a cluster; it can still run perfectly well in one
#: you already have.
#:
#: `Preflight.can_provision` is keyed on THIS dict rather than on PROVISION_TOOLS
#: below, and the distinction is not cosmetic. The property is an `all()`, so a second
#: entry in the dict it reads would make it False on every box that has kind and not
#: the other tool -- taking `preflight`'s own `cluster_exists` probe with it, along
#: with two strings in the GUI create dialog that read `can_provision` to decide
#: whether to say "no cluster yet" and "Kubernetes (kind)". Adding an entry HERE is a
#: breaking change; adding one to the cloud dict below is not.
LOCAL_PROVISION_TOOLS: dict[str, tuple[int, int]] = {
    "kind": (0, 20),
}

#: Needed to provision a cluster on a CLOUD provider, and never to use one. Separate
#: from the local dict for the reason given there, and empty until the cloud work
#: lands -- `all()` over nothing is True, which is why `can_provision_cloud` guards
#: against an empty registry rather than trusting it.
#: NO FLOOR ENFORCED, AND THAT IS THE HONEST ANSWER RATHER THAN A MISSING ONE.
#: houston needs eksctl to accept a ClusterConfig with `managedNodeGroups`, an
#: `addons` entry carrying a pinned version, and `metadata.version: "1.33"` -- and
#: which eksctl release first satisfied all three has not been MEASURED here, because
#: no cluster has been built with it. A guessed floor is not a safe default in either
#: direction: too high refuses a setup that works, too low admits one that fails at
#: create with a cryptic error either way. (0, 0) reports the version found and
#: enforces nothing, which is what "we have not measured this yet" actually looks
#: like. Raise it the moment a real create says what it needs.
#:
#: CERT_MANAGER_WEBHOOK_TRIES is the webhook wait's OWN bound, not CERT_MANAGER_TRIES:
#: 60 tries at CERT_MANAGER_INTERVAL (3 s) is 180 s, the rollout waits' `--timeout=180s`.
#: On a cluster that ever had cert-manager, the new cainjector waits a full leader-lease
#: duration before it injects the webhook's CA bundle, which a 60 s bound cannot outlast;
#: `certmanager._wait_for_the_webhook` has the measurement.
tuning = SimpleNamespace(
    CLOUD_PROVISION_TOOLS={"eksctl": (0, 0)}, MONGO_READY_TRIES=60,
    CERT_MANAGER_TRIES=20, CERT_MANAGER_WEBHOOK_TRIES=60, ISSUER_WAIT_TRIES=20,
    INSTALL_QUIET_S=30, INSTALL_REPORT_EVERY_S=30)

#: Everything that can provision anything. Kept because `doctor` reports on all tools
#: and `TOOLS` below is built from it; no property is keyed on this one.
PROVISION_TOOLS: dict[str, tuple[int, int]] = {**LOCAL_PROVISION_TOOLS,
                                               **tuning.CLOUD_PROVISION_TOOLS}

TOOLS: dict[str, tuple[int, int]] = {**CORE_TOOLS, **PROVISION_TOOLS}

#: How a cluster came to exist, which is what decides how far houston may go.
PROVIDER_KIND = "kind"          # houston made it, so houston may delete it

PROVIDER_EXTERNAL = "external"  # you made it; houston owns its namespaces only

#: Seconds. Long enough for a loaded laptop, short enough that `doctor` answers.
PROBE_TIMEOUT = 8.0

def is_ours(context: str) -> bool:
    """Whether a context names the cluster houston created."""
    return context == CONTEXT

#: What `distribution` a cluster is. `k3s --disable traefik` is a real setup, minikube
#: ships ingress as an addon that is off, and kind gains one when houston installs it,
#: so what a cluster CAN do is always PROBED (see Preflight); what it IS is a label.
#:
#: THE RULE IS NOT "NEVER A BRANCH" -- this comment used to say that, and it was not
#: true. The label does reach conditionals, and a reader who trusted the absolute would
#: not go looking for them:
#:
#:   * `is_local_cluster()`      -- may an ingress be installed, and may the local CA's
#:                                  PRIVATE KEY be copied into a cluster Secret
#:   * `cluster.BILLABLE`        -- whether a cost estimate is produced at all
#:   * `lifecycle._BILLABLE_DISTRIBUTIONS` -- the "no --domain, port-forward only" warn
#:   * `doctor`'s `on_eks`       -- missing AWS tooling as `fail` rather than `warn`
#:
#: The rule that IS true, and the one that matters: **a distribution label never widens
#: what houston may do, and every branch on it fails closed.** `is_local_cluster` says
#: so itself -- "Unknown answers False, deliberately... 'I do not know where this
#: cluster is' must not come out as yes" -- so a mislabelled or unreadable cluster
#: loses capability rather than gaining it. `cluster.provider_of` then repairs the
#: commonest mislabel one layer up by reading `eks` out of an `arn:aws:eks:` context
#: name when the node probe answers "unknown", which was measured against a real
#: cluster whose node group was mid-delete.
#:
#: The residual effect of a mislabel is therefore UNDER-reporting: an EKS cluster that
#: answers "unknown" and whose context is not an ARN gets no cost estimate and no
#: port-forward warning. That is the safe direction for a capability and the unsafe
#: one for a bill, which is what `cluster list` exists to catch.
#:
#: Signals in order of reliability, each verified against a live cluster: `providerID`
#: (`kind://docker/…`, `k3s://docker-01`), then the kubelet's version suffix (`+k3s`,
#: `+rke2`), then node labels. A managed cluster's `providerID` names its cloud, which
#: is the most reliable "this is not a disposable cluster" signal there is.
_PROVIDER_ID_PREFIX = (("kind://", "kind"), ("k3s://", "k3s"), ("aws://", "eks"),
                       ("gce://", "gke"), ("azure://", "aks"))

_KUBELET_SUFFIX = (("+k3s", "k3s"), ("+rke2", "rke2"))

#: The chart, never vendored -- it is the topology's source of truth.
HELM_REPO = "rocketchat"

HELM_REPO_URL = "https://rocketchat.github.io/helm-charts"

CHART = f"{HELM_REPO}/rocketchat"

#: In-cluster MongoDB. `mongodb` rather than PR #3's `mongo`, so the URL matches
#: Compose's `config.MONGO_URL` and the two runtimes read the same way.
MONGO_SERVICE = "mongodb"

MONGO_URL = f"mongodb://{MONGO_SERVICE}-0.{MONGO_SERVICE}:27017/rocketchat?replicaSet=rs0"

MONGO_OPLOG_URL = f"mongodb://{MONGO_SERVICE}-0.{MONGO_SERVICE}:27017/local?replicaSet=rs0"

#: The image the hand-written StatefulSet runs, and the reasoning, because there is
#: no upstream answer to copy: the official Kubernetes guide documents ONLY the
#: operator, and the chart's bundled option is the Bitnami subchart it tells you to
#: migrate away from. This path is houston's own, so the choice has to defend itself.
#:
#: `mongo` is the Docker Official Image, and it is picked over MongoDB Inc's
#: `mongodb/mongodb-community-server` for one decisive reason: COVERAGE. This
#: StatefulSet exists to serve the versions the operator cannot reach, and
#: community-server has no tag below 4.4 -- 3.6, 4.0 and 4.2 are all 404 -- while
#: houston's map goes down to MongoDB 3.6 for Rocket.Chat < 3.0. Switching to it
#: would break precisely the versions this code was written for.
#:
#: Two lesser reasons that still matter: `mongo` publishes amd64 AND arm64 across
#: that whole range, where `bitnamilegacy` is amd64-only; and it takes ownership of
#: /data/db itself, so this needs none of the fix-permission init container that
#: compose.py carries for community-server's different UID.
#:
#: What it is NOT is a different MongoDB. `mongo:8.0` and
#: `mongodb/mongodb-community-server:8.0-ubi8` are the same source, version, storage
#: engine and wire protocol; they differ in base OS and packaging. That distinction
#: is worth stating because `mongo_flavor` -- a Compose concept -- used to be
#: reported for this path as though it applied.
MONGO_IMAGE_REPO = "mongo"

def mongo_image(tag: str) -> str:
    """The image this runtime's StatefulSet actually runs. See MONGO_IMAGE_REPO."""
    return f"{MONGO_IMAGE_REPO}:{tag}"

#: The volume a workspace's data lives on. PR #3 runs MongoDB with no volume at
#: all, so its data lives in the pod's writable layer and dies with a reschedule --
#: while `--fresh` tells the user it deleted a PVC that never existed. `backup`,
#: `restore` and `upgrade` all assume the data survives a restart.
MONGO_VOLUME_GB = 8

#: How mongosh must connect BEFORE the replica set is initiated. Without
#: `directConnection=true` it tries to discover the set's topology, finds no
#: primary, and fails its handshake with "ReadConcernMajorityNotAvailableYet".
#: `compose.py` already knew this -- "directConnection=true lets mongosh reach the
#: node before rs.initiate" -- and the first cut of this module did not.
MONGO_DIRECT_URI = "mongodb://localhost:27017/?directConnection=true"

#: How long to wait for the Rocket.Chat pod to EXIST before forwarding to it.
POD_WAIT_TRIES = 40

#: Consecutive refused reads before the pod wait gives up and says so. A single
#: unlucky probe is not evidence of anything; nine of them in a row, which is what a
#: destroyed cluster produced, are.
POD_WAIT_REFUSALS = 4

POD_WAIT_INTERVAL = 3.0

#: How long to watch a namespace actually go away. Deleting one is not instant:
#: pods drain, finalizers run, and the PVC goes last.
#:
#: 60s was three seconds too small for the DEFAULT workspace shape, and it failed the
#: same way every time: a microservices teardown finished at 63s, 3 runs out of 3, so
#: a completely healthy teardown reported failure, kept the record, skipped
#: `remove_operator` and `remove_monitoring`, and demanded a second command. Measured
#: again here on a lighter synthetic namespace -- 8 pods with Rocket.Chat's own 30s
#: grace period plus a PVC -- at 56.7s, i.e. inside the old budget by 3.3 seconds.
#: The bound was never wrong in kind, only in size, and it scales with pod count:
#: microservices is 9 pods where monolith is 4.
#:
#: 180s rather than 63s so the margin survives a slower disk or a busier node. This
#: costs nothing on the happy path -- the loop returns as soon as the namespace is
#: gone -- and only bounds how long a genuinely stuck teardown is waited on.
NS_GONE_TRIES = 72

NS_GONE_INTERVAL = 2.5

APPLY_TIMEOUT = 120.0

INSTALL_TIMEOUT = 900.0

def mint_namespace(name: str) -> str:
    """The namespace a NEW workspace's objects are created in."""
    return f"{NAMESPACE_PREFIX}{name}"

#: Measured: 7554 MB free before `helm install`, 6524 MB with all eleven pods
#: Running. Rounded up, and charged only to the FIRST monitored workspace on a
#: cluster, because that is the one that pays for it.
MONITORING_MB = 1100