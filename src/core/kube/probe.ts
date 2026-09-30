/**
 * Everything `doctor` needs about Kubernetes, in one pass, changing nothing.
 *
 * Tier k2 and the top of it: this module asks every other probe and assembles the answer.
 */
import { PreflightError } from '../../lib/errors';

import {
  ingressClasses,
  metricsAvailable,
  nodesSummary,
  storageClasses,
  workspaceNamespaces,
} from './capabilities';
import { activeContext, clusters, distribution, planCluster, type ClusterPlan } from './context';
import { loadbalancerAddress } from './endpoints';
import { kube } from './exec';
import {
  CLUSTER_NAME,
  CONTEXT,
  PROVIDER_EXTERNAL,
  PROVIDER_KIND,
  isOurs,
  tools as allTools,
} from './names';
import { helmReachable, reachable } from './reachability';
import {
  canProvision,
  parseVersion,
  preflight as newPreflight,
  tool,
  type Preflight,
  type Tool,
} from './tools';

/**
 * How many MINOR versions kubectl may differ from the API server and still be supported.
 * Kubernetes publishes ±1; outside it, calls do not fail cleanly -- they fail on a field
 * the other side does not know about, which reads as a bug in whatever was being deployed.
 */
export const KUBECTL_SKEW = 1;

/**
 * The API server's version, or null if it could not be read.
 *
 * Separate from the CLIENT version, and the distinction is the whole point of the check
 * below. A static floor cannot express skew: the floor is `kubectl >= 1.21`, and
 * Rocket.Chat's own Launchpad builds clusters at 1.33 -- so a kubectl that passes the floor
 * by eleven minors is still outside the supported window, and passing a floor is exactly
 * what it will report doing.
 */
export async function serverVersion(context: string): Promise<number[] | null> {
  const res = await kube.run(['kubectl', '--context', context, 'version', '--output=json'], {
    own: isOurs(context),
  });
  if (res.returncode !== 0) return null;
  let raw: string;
  try {
    const doc = JSON.parse(res.stdout || '{}') as { serverVersion?: { gitVersion?: string } };
    raw = doc.serverVersion?.gitVersion ?? '';
  } catch {
    return null;
  }
  const parsed = parseVersion(raw);
  return parsed.length > 0 ? parsed : null;
}

export interface Skew {
  client: readonly number[];
  server: readonly number[];
  gap: number;
  ok: boolean;
}

/**
 * How far kubectl is from this cluster's API server, or null if unaskable.
 *
 * Returns the two versions and whether the gap is supported, rather than a verdict:
 * `doctor` wants to say which two numbers it is talking about, and a check that reports
 * "unsupported" without them sends somebody to look up both.
 */
export async function skew(context: string, client?: readonly number[]): Promise<Skew | null> {
  const server = await serverVersion(context);
  if (server === null) return null;
  const clientVersion = client ?? (await tool('kubectl')).version;
  if (clientVersion.length < 2 || server.length < 2) return null;
  const gap =
    clientVersion[0] === server[0]
      ? Math.abs((clientVersion[1] as number) - (server[1] as number))
      : 99;
  return { client: clientVersion, server, gap, ok: gap <= KUBECTL_SKEW };
}

/**
 * Everything that needs the cluster, asked in parallel because each is a round trip.
 *
 * EIGHT INDEPENDENT READS, TOGETHER. The ordering rule this function is built on is about
 * the PRECONDITION above it -- there is no point asking an API server for storage classes
 * when kubectl is absent or the server is not answering -- and that gate stays exactly
 * where it was. Everything below it needs only `out.context`.
 *
 * MEASURED against a live EKS cluster: `doctor` made 42 calls in 24.3 seconds, and about
 * forty of them were kubectl or helm round trips at 1.2-2.2 s each.
 *
 * `unreadable` is appended in a FIXED order afterwards rather than as each answer lands, so
 * the report does not vary with which call happened to return first.
 */
async function fillInClusterFacts(out: Preflight): Promise<void> {
  const [helm, sc, ic, ns, dist, nodes, metrics, lb] = await Promise.all([
    // Asked HERE, beside kubectl's answer, so a disagreement is found before a create
    // spends four minutes earning it.
    helmReachable(out.context),
    // EACH ANSWER READ, not assumed. `reachable()` probes /readyz, which a restricted
    // credential can usually still get -- so passing it is not evidence that any of these
    // reads will be permitted.
    storageClasses(out.context),
    ingressClasses(out.context),
    workspaceNamespaces(out.context),
    distribution(out.context),
    nodesSummary(out.context),
    metricsAvailable(out.context),
    loadbalancerAddress(out.context),
  ]);

  out.helmReachable = helm;
  if (sc === null) out.unreadable.push('storage');
  else [out.storageClasses, out.defaultStorageClass] = sc;
  if (ic === null) out.unreadable.push('ingress');
  else out.ingressClasses = ic;
  if (ns === null) out.unreadable.push('namespaces');
  else out.namespaces = ns;
  out.distribution = dist;
  if (nodes === null) out.unreadable.push('nodes');
  else [out.nodeCount, out.architectures] = nodes;
  out.metrics = metrics;
  out.loadbalancer = lb;
}

/** Which context this run uses, and everything only the cluster can answer. */
async function settleContextAndAskTheCluster(context: string, out: Preflight): Promise<Preflight> {
  // THE SAME FUNCTION `up` USES, and that is the whole point of the call. An earlier
  // version resolved the context itself, which agreed with `planCluster` on every box that
  // had only one of the two and disagreed on the box that had both: with `kind` installed
  // but no cluster yet and k3s running, `doctor` reported "Using your cluster 'default'
  // (k3s)" while `up` went and created a kind cluster. A preflight whose job is to predict
  // a boot must not be a second opinion about it.
  if (context !== '') {
    out.context = context;
  } else {
    let plan: ClusterPlan | null = null;
    try {
      plan = await planCluster();
    } catch (error) {
      if (!(error instanceof PreflightError)) throw error;
    }
    if (plan !== null) {
      out.context = plan.context;
      out.willCreate = plan.create;
    } else {
      // THE REASON WAS THROWN AWAY WITH THE EXCEPTION. `planCluster` raises both for "no
      // kind and no kubeconfig" and for "kubectl is pointed at 'X', which is not
      // answering", and dropping it left `context` empty -- so doctor fell through to "No
      // Kubernetes cluster configured" for somebody whose cluster IS configured and whose
      // credentials are what need fixing. It sent them to configure a second one.
      out.context = await activeContext();
    }
  }
  out.provider = out.context === CONTEXT ? PROVIDER_KIND : PROVIDER_EXTERNAL;

  if (out.context === '' || out.willCreate) {
    // Nothing to probe: the cluster this create would use does not exist yet, and asking
    // the OTHER cluster for its storage classes would describe a machine houston is not
    // about to use.
    return out;
  }
  out.clusterReachable = await reachable(out.context);
  if (!out.clusterReachable) return out;
  await fillInClusterFacts(out);
  return out;
}

/**
 * Everything `doctor` needs, in one pass, changing nothing.
 *
 * kind is optional. Creating a cluster needs it; using one does not. So a missing `kind`
 * narrows what houston can do -- it cannot make you a cluster -- without stopping it
 * working in the cluster you already have.
 *
 * Which cluster gets probed, in order: the one asked for, else houston's own if it exists,
 * else whatever `kubectl` is already pointed at.
 *
 * Ordered so each step's precondition is known. There is no point asking an API server for
 * storage classes when `kubectl` is absent or the server is not answering, and a timeout
 * there would be misreported as "no storage".
 */
export async function preflight(context = ''): Promise<Preflight> {
  // One tool at a time, in TOOLS order, as `{name: tools.tool(name) for name in TOOLS}`
  // asks them. `Promise.all` ran the four version probes at once, so `helm version --short`
  // could reach the log before `kubectl version --client`, in a different order from run to
  // run.
  const found: [string, Tool][] = [];
  for (const name of Object.keys(allTools())) found.push([name, await tool(name)]);
  const out = newPreflight({ tools: Object.fromEntries(found) });

  if (canProvision(out)) {
    const [seen, probeFailed] = await clusters();
    out.probeFailed = probeFailed;
    if (probeFailed !== '') return out;
    out.clusterExists = seen.includes(CLUSTER_NAME);
    out.otherClusters = seen.filter((entry) => entry !== CLUSTER_NAME);
  }

  if (out.tools.kubectl === undefined || out.tools.kubectl.path === '') return out;

  return await settleContextAndAskTheCluster(context, out);
}
