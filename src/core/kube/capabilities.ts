/**
 * What this cluster can do, asked rather than assumed.
 *
 * Tier k2, read-only. Storage classes, API groups, nodes and the versions behind them. A
 * cluster that cannot be asked yields a refusal, never an empty list -- see `ask.ts`.
 */
import { askList, items, refused } from './ask';
import { kube } from './exec';
import { CONTEXT, OWNER_SELECTOR, isOurs } from './names';
import { versionKey, type Preflight } from './tools';

function metadataOf(item: Record<string, unknown>): Record<string, unknown> {
  const meta = item.metadata;
  return meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}

function annotationsOf(meta: Record<string, unknown>): Record<string, unknown> {
  const ann = meta.annotations;
  return ann !== null && typeof ann === 'object' ? (ann as Record<string, unknown>) : {};
}

/**
 * `[all storage class names, the default one]`, or null.
 *
 * The guide's step 1 opens with the warning that matters here: "Local Kubernetes
 * distributions such as Kind, K3s, and Minikube often ship without a storage provisioner
 * enabled." Without one, a PVC stays Pending forever and the workspace never boots --
 * with no error that names storage.
 *
 * NULL, NOT `[[], '']`. A cluster that could not be asked was reporting the same answer
 * as a cluster with no storage provisioner, so `doctor` told somebody with a perfectly
 * good default StorageClass that their volume would stay Pending -- and gave it a green
 * verdict, because a warning about missing storage is a warning and "I could not read
 * your cluster" is not something it could say.
 */
export async function storageClasses(context = CONTEXT): Promise<[string[], string] | null> {
  const seen = await askList('storageclass', { context });
  if (refused(seen)) return null;
  const names: string[] = [];
  let fallback = '';
  for (const item of items(seen)) {
    const meta = metadataOf(item);
    const name = String(meta.name ?? '');
    if (name === '') continue;
    names.push(name);
    if (annotationsOf(meta)['storageclass.kubernetes.io/is-default-class'] === 'true') {
      fallback = name;
    }
  }
  return [names, fallback];
}

/**
 * Whether `kubectl top` can answer here, i.e. metrics-server is installed.
 *
 * Asked rather than assumed per distribution: kind ships none, k3s ships one, and
 * minikube has it as an addon that is off by default -- and any of the three can be
 * changed by the person running the cluster.
 */
export async function metricsAvailable(context = CONTEXT): Promise<boolean> {
  const res = await kube.run(['kubectl', '--context', context, 'top', 'nodes', '--no-headers'], {
    own: isOurs(context),
  });
  return res.returncode === 0;
}

/**
 * `[how many nodes, which architectures]`, or null. Both matter, for different reasons.
 *
 * Node COUNT decides whether a node-local default StorageClass can bite: `local-path` on
 * kind and k3s alike is `WaitForFirstConsumer`, so on more than one node a MongoDB pod
 * rescheduled elsewhere cannot rebind its volume. ARCHITECTURE matters because on kind
 * and k3s the node is this machine and on a managed cluster it need not be --
 * `bitnamilegacy/mongodb`, which every Rocket.Chat below 8 pairs with, is amd64-only.
 *
 * "0 nodes" was the answer for a cluster nobody could read, and it is a sentence doctor
 * then printed next to a tick.
 */
export async function nodesSummary(context = CONTEXT): Promise<[number, string[]] | null> {
  const seen = await askList('nodes', { context });
  if (refused(seen)) return null;
  const rows = items(seen);
  const arches = new Set<string>();
  for (const item of rows) {
    const status = item.status;
    const nodeInfo =
      status !== null && typeof status === 'object'
        ? (status as { nodeInfo?: { architecture?: unknown } }).nodeInfo
        : undefined;
    const arch = String(nodeInfo?.architecture ?? '');
    if (arch !== '') arches.add(arch);
  }
  return [rows.length, [...arches].sort()];
}

/**
 * Ingress controllers installed in this cluster, best choice first, or null.
 *
 * ORDERED, because the caller adopts the first one and the API's order is not a
 * preference. An EKS cluster carrying both `alb` and `nginx` would otherwise have the
 * choice made by whichever the API server happened to list first -- and the two behave
 * differently for ACME http-01 solving and for endpoint discovery, so that is a real
 * difference decided by nothing.
 *
 * The cluster's OWN default wins: `ingressclass.kubernetes.io/is-default-class` is
 * Kubernetes' way of saying which controller an Ingress with no class gets, so somebody
 * has already answered this question and houston should not overrule them. Names are the
 * tiebreak after that -- arbitrary, but the same arbitrary answer every time, which
 * "whatever the API listed first" was not.
 */
export async function ingressClasses(context = CONTEXT): Promise<string[] | null> {
  const seen = await askList('ingressclass', { context });
  if (refused(seen)) return null;
  const rows: [number, string][] = [];
  for (const item of items(seen)) {
    const meta = metadataOf(item);
    const name = String(meta.name ?? '');
    if (name === '') continue;
    const isDefault =
      String(
        annotationsOf(meta)['ingressclass.kubernetes.io/is-default-class'] ?? '',
      ).toLowerCase() === 'true';
    rows.push([isDefault ? 0 : 1, name]);
  }
  rows.sort(
    (left, right) => left[0] - right[0] || (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0),
  );
  return rows.map(([, name]) => name);
}

/**
 * Namespaces houston owns, selected by LABEL, or null if it could not be asked.
 *
 * THIS RETURNED `[]` FOR A REFUSED READ, and `[]` is what "this cluster holds no houston
 * workspaces" looks like -- so a namespace-scoped RBAC identity, an 8 s PROBE_TIMEOUT
 * under load or a control-plane restart all read as an empty cluster. Seven callers act
 * on that, three of them destructively: `removeMonitoring` uninstalls the SHARED
 * Prometheus/Grafana stack while another workspace is using it, `mongodbResources` does
 * the same for the shared operator -- leaving other workspaces' MongoDBCommunity
 * finalizers with nothing to clear, so THEIR teardown hangs -- and `createWorkspace`'s
 * `hadNamespace` goes false, which makes a failed create delete a namespace `down` had
 * kept, PVC and all. That last one is data loss.
 */
export async function workspaceNamespaces(context = CONTEXT): Promise<string[] | null> {
  const seen = await askList('namespace', { context, selector: OWNER_SELECTOR });
  if (refused(seen)) return null;
  return items(seen)
    .map((item) => String(metadataOf(item).name ?? ''))
    .filter((name) => name !== '')
    .sort();
}

/**
 * The first Rocket.Chat release published as a MULTI-ARCHITECTURE image.
 *
 * MEASURED with `docker manifest inspect` against registry.rocket.chat: 7.8.0, 7.9.0 and
 * 7.10.0 each return a single `manifest.v2+json` -- one architecture, amd64 -- while
 * 8.0.0 and 8.5.1 return `manifest.list.v2+json` carrying amd64 and arm64.
 *
 * Recorded as a version rather than read from the registry on every create, because
 * asking would put a network call to a third-party registry -- and, with `docker
 * manifest inspect`, a Docker dependency -- inside the one runtime that is meant not to
 * need Docker at all.
 */
export const FIRST_MULTIARCH_RC: readonly number[] = [8, 0, 0];

/**
 * What Kubernetes calls the architectures houston's images are built for. Node
 * architectures come back in these terms from `.status.nodeInfo.architecture`.
 */
export const AMD64 = 'amd64';

function atLeast(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Why this cluster's nodes cannot run this Rocket.Chat image, or ''.
 *
 * Same shape and same reason as `storageBlocker`: a refusal beats a create that installs
 * cleanly and then cannot pull. `nodesSummary` has always READ the node architectures
 * and its docstring has always said why they matter -- the value went to one string on
 * `doctor`'s screen and was never compared against anything.
 *
 * THE IRONY IS THE POINT: the amd64-only range is precisely the range houston exists for.
 * Reproducing a customer's old version is the product's whole purpose, and a Graviton
 * node group is an ordinary way to run EKS cheaply.
 *
 * Bounded by what is actually known. An unread architecture is not a mismatch, an
 * unreachable cluster is not our question, and a cluster with even one amd64 node can
 * run the image -- Kubernetes will schedule it there, and pinning it with a nodeSelector
 * would trade a fast, legible `ErrImagePull` for a silent `Pending`.
 */
export function architectureBlocker(pre: Preflight, rcVersion: string): string {
  if (!pre.clusterReachable || pre.architectures.length === 0) return '';
  const key = versionKey(rcVersion);
  // A VERSION THIS CANNOT READ MUST NOT BECOME A REFUSAL. `versionKey` answers [-1] for
  // anything non-numeric, which sorts BELOW every real release -- so a version it could
  // not parse would read as "older than 8.0.0" and block a create that is very likely
  // fine. The direction of the mistake is the one this module exists to prevent: "I
  // could not tell" turning into "no".
  if (key.length === 0 || (key[0] as number) < 0 || atLeast(key, FIRST_MULTIARCH_RC)) return '';
  if (pre.architectures.includes(AMD64)) return '';
  const shape = [...pre.architectures].sort().join(', ');
  return (
    `Rocket.Chat ${rcVersion} is published for ${AMD64} only, and every node in this ` +
    `cluster is ${shape}. The workspace would install and then fail to pull with 'no ` +
    `matching manifest'. Add an ${AMD64} node group, or use Rocket.Chat ` +
    `${FIRST_MULTIARCH_RC.join('.')} or newer, or reproduce this version on the Docker ` +
    `runtime — which pins \`platform: linux/${AMD64}\` and runs it under emulation, ` +
    'something a Kubernetes node cannot do.'
  );
}

/**
 * Why a workspace's volume could not bind in this cluster, or ''.
 *
 * Takes an already-probed Preflight rather than a context, so it cannot be called on
 * data from an unreachable cluster -- reporting "no StorageClass" for a cluster nobody
 * could reach is the same wrong answer as reporting an absent cluster for a stopped
 * Docker.
 *
 * This is a REFUSAL, not a warning, for the reason that makes it nasty: with no
 * provisioner the PVC stays Pending, the pod stays Pending, and Rocket.Chat never starts
 * -- so there are no Rocket.Chat logs to find it in. Left to run, it costs the full
 * readiness timeout and then reports "Rocket.Chat did not become ready", which blames
 * the one component that is innocent.
 */
export function storageBlocker(pre: Preflight): string {
  if (!pre.clusterReachable) return ''; // not our question; unreachable is reported first
  if (pre.defaultStorageClass !== '') return '';
  if (pre.unreadable.includes('storage')) {
    // NOT "has no StorageClass". `preflight` records that the read was refused; this
    // refused the create anyway and blamed the customer's cluster, which on a
    // namespace-scoped RBAC identity made houston unusable AND sent the engineer to ask
    // a platform team to install a provisioner that was already there. Still a refusal,
    // because a create whose volume cannot be predicted is not a create worth starting
    // -- but a refusal that names the right thing.
    return (
      `Cluster '${pre.context}' would not let houston read its StorageClasses, so ` +
      "whether the workspace's volume can bind is unknown. This is a permissions " +
      'problem on the credential in your kubeconfig, not a missing provisioner: ' +
      '`kubectl get storageclass` as yourself says which.'
    );
  }
  const where = `Cluster '${pre.context}'`;
  if (pre.storageClasses.length > 0) {
    return (
      `${where} has StorageClasses (${pre.storageClasses.join(', ')}) but none is ` +
      "marked default, so the workspace's volume would stay Pending and Rocket.Chat " +
      'would never start. Mark one default with: kubectl patch storageclass <name> -p ' +
      '\'{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}\''
    );
  }
  return (
    `${where} has no StorageClass, so the workspace's volume would stay Pending forever ` +
    'and Rocket.Chat would never start — with nothing in its logs naming storage, ' +
    'because it never runs. The official guide warns that local distributions often ' +
    'ship without a provisioner.'
  );
}
