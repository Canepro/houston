/**
 * What things are called, and how to tell one of ours from anything else.
 *
 * Tier k0: every constant, the label vocabulary, and the pure functions that read it. Nothing
 * here talks to a cluster, reads a file or spawns a process, so every other module in the
 * package may reach it and it may reach none of them.
 *
 * The label vocabulary is the load-bearing part. Selection is BY LABEL, never by name
 * prefix -- `isOurs` and `OWNER_SELECTOR` are the only two ways to ask "is this
 * houston's", and a name-prefix match was how a workspace called `houston-anything`
 * somebody else made once became eligible for teardown.
 */

/**
 * The cluster houston creates and owns. One cluster with a namespace per workspace, not
 * a cluster per workspace: a control plane each would forbid concurrent repros on
 * laptop-scale hardware, which is behaviour houston already has on Compose.
 *
 * houston USES whatever cluster it is pointed at and creates this one only when there is
 * none. What survives from the earlier "always create" draft is the TEARDOWN asymmetry,
 * which is the part that matters: a cluster houston created it may delete; in one you
 * supplied it owns only the namespaces carrying its label.
 */
export const CLUSTER_NAME = 'houston-local';

/** kind prefixes the kubeconfig context with `kind-`. */
export const CONTEXT = `kind-${CLUSTER_NAME}`;

/**
 * One namespace per workspace. The official guide creates a named namespace and says
 * the name is the operator's choice, so this fits the documented model.
 */
export const NAMESPACE_PREFIX = 'houston-';

/**
 * The Helm release name INSIDE that namespace. Deliberately the same name the official
 * docs use, so every command copied from docs.rocket.chat works with one substitution
 * (the namespace) rather than a translation.
 */
export const RELEASE = 'rocketchat';

/** Every chart application writer, including microservices; backing services stay up. */
export const APPLICATION_SELECTOR = `app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/name!=nats`;

/** The monolith alone: legacy stop journals never changed microservice counts. */
export const MONOLITH_SELECTOR = 'app.kubernetes.io/name=rocketchat';

/**
 * Ownership. Selection is ALWAYS by this label, never by a name prefix: anyone can
 * create a namespace called `houston-anything`, and a teardown that matched on the
 * prefix would eventually delete one houston never made.
 */
export const OWNER_LABEL_KEY = 'app.kubernetes.io/managed-by';

export const OWNER_LABEL_VALUE = 'houston';

export const OWNER_SELECTOR = `${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE}`;

export const WORKSPACE_LABEL = 'houston.io/workspace';

export const OWNER_OF_LABEL = 'houston.io/owner';

/** A tool's floor, as the major/minor pair it must reach. */
export type Floor = readonly [number, number];

/**
 * The tools, and the floor each must clear. These two are the official guide's own
 * requirement ("kubectl v1.21+, Helm 3") and they are all that USING Kubernetes needs --
 * namespaces, helm, PVCs, port-forward and exec are plain Kubernetes and work on k3s,
 * minikube, Docker Desktop or a remote cluster exactly as they work on kind.
 */
export const CORE_TOOLS: Readonly<Record<string, Floor>> = Object.freeze({
  kubectl: [1, 21] as Floor,
  helm: [3, 0] as Floor,
});

/**
 * WHY each floor is the number it is, so `doctor` can say something true when a tool is
 * below one. It rendered every floor as "the floor the official Rocket.Chat guide
 * requires", which is unverifiable for all of them: the guide's prerequisites name
 * `kubectl` and `eksctl` with NO versions, and do not mention `kind` at all. A reason
 * attached to the wrong number is worse than no reason.
 */
export const TOOL_FLOOR_REASON: Readonly<Record<string, string>> = Object.freeze({
  kind: "where kind's config API and `extraPortMappings` settled",
});

export const DEFAULT_FLOOR_REASON = 'the floor houston requires';

/**
 * Needed only to PROVISION a cluster ON THIS MACHINE, never to use one. kind has no
 * documented floor, so 0.20 is where `extraPortMappings` and the config API settled.
 *
 * `Preflight.canProvision` is keyed on THIS registry rather than on `PROVISION_TOOLS`,
 * and the distinction is not cosmetic. The property is an `every()`, so a second entry
 * here would make it false on every box that has kind and not the other tool -- taking
 * the cluster probe with it, along with two strings in the GUI create dialog. Adding an
 * entry HERE is a breaking change; adding one to the cloud registry below is not.
 */
export const LOCAL_PROVISION_TOOLS: Readonly<Record<string, Floor>> = Object.freeze({
  kind: [0, 20] as Floor,
});

/**
 * Numbers a test or an operator may move, kept together so the reader can find them.
 *
 * NO FLOOR IS ENFORCED for eksctl, and that is the honest answer rather than a missing
 * one. houston needs it to accept a ClusterConfig with `managedNodeGroups`, an `addons`
 * entry carrying a pinned version, and `metadata.version: "1.33"` -- and which eksctl
 * release first satisfied all three has not been MEASURED here, because no cluster has
 * been built with it. A guessed floor is unsafe in both directions, so [0, 0] reports
 * the version found and enforces nothing.
 *
 * CERT_MANAGER_WEBHOOK_TRIES is the webhook wait's OWN bound, not CERT_MANAGER_TRIES: 60
 * tries at CERT_MANAGER_INTERVAL (3 s) is 180 s, the rollout waits' `--timeout=180s`. On a
 * cluster that ever had cert-manager, the new cainjector waits a full leader-lease duration
 * before it injects the webhook's CA bundle, which a 60 s bound cannot outlast;
 * `waitForTheWebhook` in certmanager.ts has the measurement.
 */
export const tuning: {
  CLOUD_PROVISION_TOOLS: Record<string, Floor>;
  MONGO_READY_TRIES: number;
  CERT_MANAGER_TRIES: number;
  CERT_MANAGER_WEBHOOK_TRIES: number;
  ISSUER_WAIT_TRIES: number;
  INSTALL_QUIET_S: number;
  INSTALL_REPORT_EVERY_S: number;
} = {
  CLOUD_PROVISION_TOOLS: { eksctl: [0, 0] as Floor },
  MONGO_READY_TRIES: 60,
  CERT_MANAGER_TRIES: 20,
  CERT_MANAGER_WEBHOOK_TRIES: 60,
  ISSUER_WAIT_TRIES: 20,
  INSTALL_QUIET_S: 30,
  INSTALL_REPORT_EVERY_S: 30,
};

/** Everything that can provision anything. `doctor` reports on all tools. */
export function provisionTools(): Record<string, Floor> {
  return { ...LOCAL_PROVISION_TOOLS, ...tuning.CLOUD_PROVISION_TOOLS };
}

export function tools(): Record<string, Floor> {
  return { ...CORE_TOOLS, ...provisionTools() };
}

/** How a cluster came to exist, which is what decides how far houston may go. */
export const PROVIDER_KIND = 'kind'; // houston made it, so houston may delete it

export const PROVIDER_EXTERNAL = 'external'; // you made it; houston owns its namespaces only

/** Seconds. Long enough for a loaded laptop, short enough that `doctor` answers. */
export const PROBE_TIMEOUT = 8.0;

/** Whether a context names the cluster houston created. */
export function isOurs(context: string): boolean {
  return context === CONTEXT;
}

/**
 * Signals that say what distribution a cluster is, in order of reliability, each
 * verified against a live cluster: `providerID` (`kind://docker/…`, `k3s://docker-01`),
 * then the kubelet's version suffix (`+k3s`, `+rke2`), then node labels.
 *
 * THE RULE IS NOT "NEVER A BRANCH". The label does reach conditionals -- whether an
 * ingress may be installed and the local CA's private key copied into a cluster Secret,
 * whether a cost estimate is produced, the port-forward-only warning, and whether
 * missing AWS tooling is a failure or a warning. The rule that IS true: a distribution
 * label never widens what houston may do, and every branch on it fails closed. So a
 * mislabelled cluster loses capability rather than gaining it, and the residual effect
 * is UNDER-reporting -- the safe direction for a capability and the unsafe one for a
 * bill, which is what `cluster list` exists to catch.
 */
export const PROVIDER_ID_PREFIX: readonly (readonly [string, string])[] = Object.freeze([
  ['kind://', 'kind'],
  ['k3s://', 'k3s'],
  ['aws://', 'eks'],
  ['gce://', 'gke'],
  ['azure://', 'aks'],
] as const);

export const KUBELET_SUFFIX: readonly (readonly [string, string])[] = Object.freeze([
  ['+k3s', 'k3s'],
  ['+rke2', 'rke2'],
] as const);

/** The chart, never vendored -- it is the topology's source of truth. */
export const HELM_REPO = 'rocketchat';

export const HELM_REPO_URL = 'https://rocketchat.github.io/helm-charts';

export const CHART = `${HELM_REPO}/rocketchat`;

/**
 * In-cluster MongoDB. `mongodb` rather than `mongo`, so the URL matches Compose's
 * `config.MONGO_URL` and the two runtimes read the same way.
 */
export const MONGO_SERVICE = 'mongodb';

export const MONGO_URL = `mongodb://${MONGO_SERVICE}-0.${MONGO_SERVICE}:27017/rocketchat?replicaSet=rs0`;

export const MONGO_OPLOG_URL = `mongodb://${MONGO_SERVICE}-0.${MONGO_SERVICE}:27017/local?replicaSet=rs0`;

/**
 * The image the hand-written StatefulSet runs, and the reasoning, because there is no
 * upstream answer to copy: the official Kubernetes guide documents ONLY the operator,
 * and the chart's bundled option is the Bitnami subchart it tells you to migrate away
 * from.
 *
 * `mongo` is the Docker Official Image, picked over `mongodb/mongodb-community-server`
 * for one decisive reason: COVERAGE. This StatefulSet exists to serve the versions the
 * operator cannot reach, and community-server has no tag below 4.4 -- 3.6, 4.0 and 4.2
 * are all 404 -- while houston's map goes down to MongoDB 3.6 for Rocket.Chat < 3.0.
 *
 * Two lesser reasons that still matter: `mongo` publishes amd64 AND arm64 across that
 * whole range, where `bitnamilegacy` is amd64-only; and it takes ownership of /data/db
 * itself, so this needs none of the fix-permission init container compose.ts carries.
 */
export const MONGO_IMAGE_REPO = 'mongo';

/** The image this runtime's StatefulSet actually runs. See `MONGO_IMAGE_REPO`. */
export function mongoImage(tag: string): string {
  return `${MONGO_IMAGE_REPO}:${tag}`;
}

/**
 * The volume a workspace's data lives on. Running MongoDB with no volume at all puts
 * its data in the pod's writable layer, where it dies with a reschedule -- while
 * `--fresh` tells the user it deleted a PVC that never existed. `backup`, `restore` and
 * `upgrade` all assume the data survives a restart.
 */
export const MONGO_VOLUME_GB = 8;

/**
 * How mongosh must connect BEFORE the replica set is initiated. Without
 * `directConnection=true` it tries to discover the set's topology, finds no primary, and
 * fails its handshake with "ReadConcernMajorityNotAvailableYet".
 */
export const MONGO_DIRECT_URI = 'mongodb://localhost:27017/?directConnection=true';

/** How long to wait for the Rocket.Chat pod to EXIST before forwarding to it. */
export const POD_WAIT_TRIES = 40;

/**
 * Consecutive refused reads before the pod wait gives up and says so. A single unlucky
 * probe is not evidence of anything; nine of them in a row, which is what a destroyed
 * cluster produced, are.
 */
export const POD_WAIT_REFUSALS = 4;

export const POD_WAIT_INTERVAL = 3.0;

/**
 * How long to watch a namespace actually go away. Deleting one is not instant: pods
 * drain, finalizers run, and the PVC goes last.
 *
 * 60 s was three seconds too small for the DEFAULT workspace shape, and it failed the
 * same way every time: a microservices teardown finished at 63 s, 3 runs out of 3, so a
 * completely healthy teardown reported failure, kept the record, skipped the operator
 * and monitoring cleanup, and demanded a second command. 180 s rather than 63 s so the
 * margin survives a slower disk or a busier node; it costs nothing on the happy path.
 */
export const NS_GONE_TRIES = 72;

export const NS_GONE_INTERVAL = 2.5;

export const APPLY_TIMEOUT = 120.0;

export const INSTALL_TIMEOUT = 900.0;

/** The namespace a NEW workspace's objects are created in. */
export function mintNamespace(name: string): string {
  return `${NAMESPACE_PREFIX}${name}`;
}

/**
 * Measured: 7554 MB free before `helm install`, 6524 MB with all eleven pods Running.
 * Rounded up, and charged only to the FIRST monitored workspace on a cluster, because
 * that is the one that pays for it.
 */
export const MONITORING_MB = 1100;
