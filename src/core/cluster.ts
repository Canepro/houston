/**
 * The cluster ledger: what a cluster is holding, and what that is costing.
 *
 * Read-only and free. Nothing here mutates a cluster, spends money or needs a cloud
 * credential, which is why it can be the first thing built and why it is useful on a kind
 * cluster and an adopted k3s as well as on a managed one.
 *
 * **The failure this module is written against.** A ledger whose job is "make a forgotten
 * cluster impossible to forget" is worse than useless if it reports an unreadable cluster
 * as an empty one: "0 workspaces, nothing costing you money" is exactly the sentence that
 * lets a bill run. So every fact here is `null` when it could not be read, never `0`, and
 * `unreadable` names which ones -- the same three-answer discipline `kube/ask`'s `Answer`
 * exists for, applied to a screen instead of a delete.
 *
 * `kube/` is the Kubernetes seam and stays it: everything below asks through it.
 */
import * as config from '../lib/config';
import { resolve4, resolveCname } from 'node:dns/promises';

import { type Emit, info, nullEmit } from '../lib/events';
import { compareCodePoints } from '../lib/format';
import { mapLimit } from '../lib/map-limit';

import * as eks from './eks';
import * as journal from './journal';
import { ABSENT, type Answer, askList, askObject, items, present, refused } from './kube/ask';
import { ensureKubeconfig } from './kube/cluster';
import {
  type ClusterPlan,
  activeContext,
  assertContextKnown,
  clusterContext,
  contextServers,
  contexts,
  distribution,
  planCluster,
  shortName,
} from './kube/context';
import { loadbalancerService } from './kube/endpoints';
import { workspaceNamespaces, ingressClasses, storageClasses } from './kube/capabilities';
import { monitoringInstalled } from './kube/monitoring';
import {
  CLUSTER_NAME,
  NAMESPACE_PREFIX,
  OWNER_OF_LABEL,
  OWNER_SELECTOR,
  PROVIDER_EXTERNAL,
  PROVIDER_KIND,
  isOurs,
} from './kube/names';
import { namespaceOwner, workspacePvcs } from './kube/namespace';
import { operatorPresence } from './kube/operator';
import { REACH_DOWN, reach, reachAdvice, reachOk, reachWhy } from './kube/reachability';
import { which } from './kube/tools';

/**
 * Estimated USD/hour, us-east-1 on-demand.
 *
 * ONE table, because the ledger and the spend gate that will gate `cluster create` must
 * quote the same number -- `lifecycle.runtimeCost` already states the rule for RAM: "the
 * same constants, not a second set written for the screen: a card that quotes 1.1 GB while
 * the preflight reserves something else is a card that will be contradicted by the refusal
 * it was meant to prevent". An hourly rate quoted at create and a different one in the
 * ledger is that bug in dollars.
 *
 * Deliberately small. An instance type that is not here is COUNTED and reported as unpriced
 * rather than guessed at or silently omitted -- a total that quietly drops the nodes it did
 * not recognise is the same lie as a zero for an unreadable cluster.
 */
export const EKS_CONTROL_PLANE_USD_HR = 0.1;
export const EKS_EXTENDED_CONTROL_PLANE_USD_HR = 0.6;
export const NAT_GATEWAY_USD_HR = 0.045;

/** Published EKS standard-support end dates, UTC; older offered versions are extended. */
const EKS_STANDARD_END: Readonly<Record<string, string>> = Object.freeze({
  '1.31': '2025-11-26',
  '1.32': '2026-03-23',
  '1.33': '2026-07-29',
  '1.34': '2026-12-02',
  '1.35': '2027-03-27',
  '1.36': '2027-08-02',
  '1.37': '2027-12-01',
});

export function eksControlPlaneRate(version: string, now = Date.now()): number {
  const end = EKS_STANDARD_END[version];
  if (end !== undefined)
    return now >= Date.parse(`${end}T00:00:00Z`)
      ? EKS_EXTENDED_CONTROL_PLANE_USD_HR
      : EKS_CONTROL_PLANE_USD_HR;
  return EKS_CONTROL_PLANE_USD_HR;
}

/**
 * A node's DISK, which `INSTANCE_USD_HR` cannot express because a disk is not an instance
 * type -- so it was not underpriced, it was UNCOUNTED, and the "unpriced types are
 * reported" safeguard could not see it either.
 *
 * MEASURED live: an eksctl node group with no `volumeSize` resolves to 80 GB gp3, and
 * `describe-volumes` on a running cluster showed exactly that beside the workspace's own 8
 * GB. Still an assumption in the sense that a node group asking for something else is not
 * read back, and the basis string says which.
 */
export const NODE_VOLUME_GB = 80;
export const EBS_GP3_USD_GB_MONTH = 0.08;
export const HOURS_PER_MONTH = 730.0;

/**
 * A LoadBalancer Service provisions a real load balancer and bills by the hour.
 *
 * The ledger has always COUNTED them -- "1 LoadBalancer(s) — each one is billed on a
 * managed cluster" is printed one line above the total -- and never priced them, which is
 * the same failure as the node disks one layer along: a figure arrived at honestly,
 * believable, and low. us-east-1 classic/NLB hourly; an ALB differs and capacity units are
 * not modelled.
 */
export const LOADBALANCER_USD_HR = 0.0225;

export const INSTANCE_USD_HR: Readonly<Record<string, number>> = Object.freeze({
  't3.medium': 0.0416,
  't3.large': 0.0832, // what Launchpad names as the minimum
  't3.xlarge': 0.1664,
  'm5.large': 0.096,
  'm5.xlarge': 0.192,
});

/**
 * Distributions that cost money to keep running.
 *
 * A kind cluster on a laptop and a k3s in a VM you already pay for are both free as far as
 * houston is concerned; quoting dollars for them would be noise, and quoting zero would be
 * a claim about somebody else's infrastructure bill.
 */
export const BILLABLE: readonly string[] = Object.freeze(['eks', 'gke', 'aks']);

type Bag = Record<string, unknown>;

function metadataOf(item: Bag): Bag {
  const meta = item.metadata;
  return typeof meta === 'object' && meta !== null ? (meta as Bag) : {};
}

/**
 * Hours since the oldest node appeared, as a proxy for the cluster's age.
 *
 * A proxy because nothing asks the control plane when it was created: EKS knows, kind does
 * not, and the answer has to mean the same thing on both. The oldest node is close enough
 * for "this has been up for eleven days" and is readable everywhere.
 */
export function oldestNodeAgeHours(list: readonly Bag[], now = Date.now()): number | null {
  const stamps: number[] = [];
  for (const it of list) {
    const raw = String(metadataOf(it).creationTimestamp ?? '');
    if (raw === '') continue;
    const at = parseInstant(raw);
    if (at === null) continue;
    stamps.push(at);
  }
  if (stamps.length === 0) return null;
  return Math.max(0.0, (now - Math.min(...stamps)) / 3600_000);
}

/**
 * An ISO-8601 instant, or null -- and `Date.parse` is not that.
 *
 * `Date.parse` accepts a pile of things that have always been rejected here: `"2026"` is a
 * year to it, and `"Mar 5 2020"` parses in JavaScript. A node whose
 * `creationTimestamp` is any of them would then be counted as the oldest and set the
 * cluster's whole reported age.
 *
 * TWO DELIBERATE DIFFERENCES REMAIN, both unreachable from a real cluster: `metav1.Time`
 * marshals as RFC 3339, so `creationTimestamp` is always `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * An offset is REQUIRED here and optional in the previous implementation, which reads a
 * stamp without one as a NAIVE time, and its subtraction against the current UTC time then
 * throws a TypeError -- out of the age computation, out of `status()`, and out of the
 * report.
 * Skipping the stamp is what the rest of this function already does with one it cannot
 * read, and a ledger that reports an unknown age is the whole point of this module.
 *
 * Basic-format ISO (`20260916T100000Z`) parses there and not here. That direction is the
 * safe one -- it yields a null age rather than a wrong one -- and buying it would cost a
 * second grammar plus a rewrite step, which is a new place to be wrong about a shape
 * Kubernetes does not emit.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

function parseInstant(raw: string): number | null {
  if (!ISO_INSTANT.test(raw)) return null;
  const at = Date.parse(raw.replace(' ', 'T'));
  return Number.isNaN(at) ? null : at;
}

/**
 * Gigabytes claimed by these PVCs, or null if the cluster would not say.
 *
 * null rather than 0.0 for a refused read, for the reason the whole module exists: an
 * unreadable volume list priced at nothing is a bill that looks free.
 */
export function claimedGb(answer: Answer): number | null {
  if (refused(answer)) return null;
  let total = 0.0;
  for (const it of items(answer)) {
    const spec = (it.spec ?? {}) as Bag;
    const resources = (spec.resources ?? {}) as Bag;
    const requests = (resources.requests ?? {}) as Bag;
    const raw = String(requests.storage ?? '');
    if (raw === '') continue;
    // The numeric head read as a float, so a malformed value is skipped rather than counted
    // as a zero -- which would read as a volume that exists and costs nothing.
    const head = (suffix: string): number | null => {
      const text = raw.slice(0, -suffix.length);
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/u.test(text.trim())) return null;
      return Number(text);
    };
    if (raw.endsWith('Gi')) {
      const value = head('Gi');
      if (value !== null) total += value;
    } else if (raw.endsWith('Mi')) {
      const value = head('Mi');
      if (value !== null) total += value / 1024.0;
    } else if (raw.endsWith('Ti')) {
      const value = head('Ti');
      if (value !== null) total += value * 1024.0;
    }
  }
  return total;
}

/**
 * Instance type -> how many. `""` for a node that does not say.
 *
 * THROUGH A `Map`, because the key is a label a cluster chose and a JavaScript object
 * already has keys. A node typed `toString` read `Object.prototype.toString` as its running
 * count and produced `"function toString() { [native code] }1"`; one typed `__proto__`
 * would have set the prototype instead of a count. A Map has neither problem, and
 * `Object.fromEntries` gives the plain object every caller downstream expects.
 */
export function nodeInventory(list: readonly Bag[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const it of list) {
    const labels = (metadataOf(it).labels ?? {}) as Bag;
    const kind = String(labels['node.kubernetes.io/instance-type'] ?? '');
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

/**
 * The distribution, by a route that does not require a node to exist.
 *
 * `kube.distribution()` reads a NODE's providerID, which is the most reliable signal there
 * is -- when there is a node. A managed cluster with zero of them is not an edge case: it
 * is every cluster mid-create, mid-delete, or with its node group scaled to nothing.
 *
 * MEASURED against a real EKS cluster whose node group was being deleted: `distribution`
 * answered "unknown", so it did not match BILLABLE, so the ledger priced a control plane
 * that was very much running at nothing at all. That is the failure this module was
 * written against, rebuilt one layer up.
 *
 * The context name settles what the nodes cannot: `aws eks update-kubeconfig` writes the
 * cluster ARN as the context name, and an ARN names its own service.
 */
export function providerOf(context: string, dist: string): string {
  if (dist !== '' && dist !== 'unknown') return dist;
  if (context.startsWith('arn:aws:eks:')) return 'eks';
  return dist;
}

/**
 * The region inside a context name, or "".
 *
 * Beside `providerOf` and for the same reason: the context name carries facts the cluster
 * cannot always be asked for, and both shapes AWS writes contain this one --
 * `aws eks update-kubeconfig` writes `arn:aws:eks:<region>:<account>:cluster/<name>` and
 * `eksctl` writes `<user>@<name>.<region>.eksctl.io`.
 *
 * Wanted so a picker can say `chatrepo (us-east-1)` instead of sixty characters of ARN.
 * Which region a cluster is in is the half of an ARN a person actually needs; the account
 * id is the half they do not.
 */
export function regionOf(context: string): string {
  if (context.startsWith('arn:aws:eks:')) {
    const bits = context.split(':');
    return bits.length > 4 ? (bits[3] as string) : '';
  }
  if (context.endsWith('.eksctl.io')) {
    // `<user>@<name>.<region>.eksctl.io` -> the part before `.eksctl.io`, last dot.
    const stem = context.slice(0, -'.eksctl.io'.length);
    return stem.includes('.') ? (stem.split('.').pop() as string) : '';
  }
  return '';
}

export interface CostEstimate {
  readonly usd_hr: number;
  readonly unpriced: Record<string, number>;
  readonly incomplete: string[];
  readonly basis: string;
  readonly estimate: boolean;
}

/**
 * What this cluster costs per hour, or null when the question does not apply.
 *
 * Everything the ledger can SEE is priced, because everything it can see is on the screen
 * already: the row above the total says "1 LoadBalancer(s) — each one is billed on a
 * managed cluster" and then the total left it out. Counting a thing and not pricing it is
 * the most convincing way to be wrong, since the reader can see you noticed.
 *
 * `unpriced` and `incomplete` are separate answers. An instance type that is not in the
 * table is a gap in this build's knowledge; a count that came back null is a read that
 * FAILED, and the difference matters because only one of them gets better by adding a row
 * to a table.
 */
export function estimateUsdHr(
  dist: string,
  inventory: Record<string, number>,
  options: { loadbalancers?: number | null; volumeGb?: number | null; version?: string } = {},
): CostEstimate | null {
  const { loadbalancers = 0, volumeGb = 0.0, version = '' } = options;
  // A managed cluster may bill without sharing EKS's control-plane, NAT or node rates.
  // Report GKE/AKS as unpriced until their own model exists.
  if (dist !== 'eks') return null;
  const supportTierKnown = Object.hasOwn(EKS_STANDARD_END, version);
  const controlPlaneRate = supportTierKnown
    ? eksControlPlaneRate(version)
    : EKS_CONTROL_PLANE_USD_HR;
  let total = controlPlaneRate + NAT_GATEWAY_USD_HR;
  // `Object.hasOwn` and a `Map`, for the reason `nodeInventory` builds one: the key is a
  // label the cluster chose. `INSTANCE_USD_HR['toString']` is a FUNCTION, so the rate was
  // not undefined, the type was not reported as unpriced, and the total became NaN.
  const unpricedCounts = new Map<string, number>();
  const incomplete: string[] = [];
  if (Object.hasOwn(options, 'version') && !supportTierKnown) {
    incomplete.push(
      version === ''
        ? 'EKS support tier (Kubernetes version unavailable)'
        : `EKS support tier (Kubernetes ${version} not in this rate table)`,
    );
  }
  for (const [kind, count] of Object.entries(inventory)) {
    const rate = Object.hasOwn(INSTANCE_USD_HR, kind) ? INSTANCE_USD_HR[kind] : undefined;
    if (rate === undefined) {
      unpricedCounts.set(kind, count);
      continue;
    }
    total += rate * count;
  }
  const unpriced = Object.fromEntries(unpricedCounts);
  // Node disks, counted for EVERY node including the ones whose type could not be priced --
  // an unrecognised instance type still has a volume attached to it.
  const nodes = Object.values(inventory).reduce((sum, n) => sum + n, 0);
  total += (nodes * NODE_VOLUME_GB * EBS_GP3_USD_GB_MONTH) / HOURS_PER_MONTH;

  if (loadbalancers === null) incomplete.push('load balancers');
  else total += loadbalancers * LOADBALANCER_USD_HR;
  if (volumeGb === null) incomplete.push('workspace volumes');
  else total += (volumeGb * EBS_GP3_USD_GB_MONTH) / HOURS_PER_MONTH;

  return {
    usd_hr: round4(total),
    unpriced,
    incomplete,
    basis:
      `us-east-1 on-demand: ${
        supportTierKnown
          ? `EKS ${version} ${controlPlaneRate === EKS_EXTENDED_CONTROL_PLANE_USD_HR ? 'extended' : 'standard'} support `
          : Object.hasOwn(options, 'version')
            ? `EKS ${version || 'version unavailable'}; standard support assumed as a lower bound for `
            : ''
      }` +
      'control plane, NAT gateway, nodes, ' +
      `${String(NODE_VOLUME_GB)} GB gp3 per node (eksctl's default, not read ` +
      'back), load balancers and workspace volumes',
    estimate: true,
  };
}

/**
 * `value` rounded to 4 places, a tie going to EVEN, which `toFixed` does not do.
 *
 * ON THE DOUBLE'S EXACT VALUE, which is why this is arithmetic on integers rather than
 * `value * 10_000`. Multiplying first rounds once before the rounding, so a value that is
 * slightly ABOVE a half lands exactly on it and then gets the tie-break -- and the
 * tie-break goes the other way. Measured against the established rounding over 200,000
 * inputs of the form `(k + 0.5) / 10_000`: 86,162 of them disagreed. A double is a dyadic
 * rational, so reading its mantissa and exponent gives the exact value and the comparison
 * against a half is then decidable rather than approximate.
 */
export function round4(value: number): number {
  if (!Number.isFinite(value)) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xf_ffff_ffff_ffffn;
  // |value| == mantissa / 2**shift, exactly.
  const mantissa = exponent === 0 ? fraction : fraction | 0x10_0000_0000_0000n;
  const shift = exponent === 0 ? 1074 : 1075 - exponent;
  // No fractional bits at all: already an integer, and rounding one to 4 places is a no-op.
  if (shift <= 0) return value;
  const scaled = mantissa * 10_000n;
  const denominator = 1n << BigInt(shift);
  const whole = scaled / denominator;
  const remainder = scaled % denominator;
  const twice = remainder * 2n;
  let rounded: bigint;
  if (twice > denominator) rounded = whole + 1n;
  else if (twice < denominator) rounded = whole;
  else rounded = whole % 2n === 0n ? whole : whole + 1n;
  const magnitude = Number(rounded) / 10_000;
  return negative ? -magnitude : magnitude;
}

/** Where a cluster lives: what decides how it is read and which part of a page shows it. */
export type Where = 'local' | 'aws' | 'elsewhere';

/** Context names local tools write for clusters that run on this machine. */
const LOCAL_CONTEXT = /^(?:kind-|k3d-)|^(?:minikube|docker-desktop|rancher-desktop|orbstack)$/u;

/**
 * Where a cluster lives, from its context name and its API server, without asking it.
 *
 * AWS by the shape of the name or of the EKS endpoint; this machine for houston's own kind
 * cluster, a name a local tool writes, or a server on the loopback; anywhere else is
 * elsewhere. A k3s on another machine is not this machine, whatever its distribution.
 * `ponytail:` the loopback is judged by NAME and never resolved, so a tunnel to 127.0.0.1
 * reads as local; resolve the host if that ever matters.
 */
export function whereOf(context: string, server = ''): Where {
  if (context.startsWith('arn:aws:eks:') || context.endsWith('.eksctl.io')) return 'aws';
  let host: string;
  try {
    host = new URL(server).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host.endsWith('.eks.amazonaws.com')) return 'aws';
  if (isOurs(context) || LOCAL_CONTEXT.test(context)) return 'local';
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.') ||
    host.endsWith('.docker.internal')
  )
    return 'local';
  return 'elsewhere';
}

export interface ContextRow {
  readonly context: string;
  readonly short: string;
  readonly region: string;
  readonly aliases: string[];
  readonly ours: boolean;
  readonly provider: string;
  readonly billable: boolean;
  readonly is_default: boolean;
  /** From the local build note only -- this list never probes. `status` asks AWS. */
  readonly made_by_houston: boolean;
  /** From the name and the API server, never a probe. */
  readonly where: Where;
}

/** One row per context: whose it is, and whether it can be reached at all. */
async function contextRows(
  aliases: Record<string, string[]>,
  byDefault: string,
  names: readonly string[],
  servers: ReadonlyMap<string, string>,
): Promise<ContextRow[]> {
  // THE ONE PROBE, and only in one situation. houston writes its OWN kubeconfig when it
  // builds its own cluster and never removes that entry -- so a cluster that has been
  // deleted outside houston, or whose `kind` was uninstalled and the container removed by
  // hand, leaves a context for something that does not exist. It then showed on every
  // screen for ever, unusable, unreclaimable and impossible to clear.
  //
  // It is NOT enough to drop it whenever `kind` is missing. `planCluster` records what that
  // costs: uninstalling the binary while the cluster still ran made the cluster invisible,
  // "containers holding memory that nothing in houston could see or remove". A running
  // cluster stays listed however little houston can do with it -- `status()` says it can no
  // longer be removed and how to remove it anyway.
  //
  // So the question is whether the cluster is THERE, which costs one probe, bounded: our
  // own context only, and only when the binary that would manage it is absent.
  const drop = new Set<string>();
  const oursCtx = await clusterContext();
  if (oursCtx !== '' && names.includes(oursCtx) && which('kind') === '') {
    if (!reachOk(await reach(oursCtx))) drop.add(oursCtx);
  }
  // The build note, read once for the whole list: `made_by_houston` here never probes.
  const builtHere = new Set(
    eks.remembered().map((entry) => `${String(entry.name ?? '')}@${String(entry.region ?? '')}`),
  );
  const rows: ContextRow[] = [];
  for (const name of names) {
    if (drop.has(name)) continue;
    const provider = providerOf(name, '');
    rows.push({
      context: name,
      // WHAT TO SHOW, decided here rather than in JavaScript -- the same reason `billable`
      // is: a rule the service owns should not get a second copy in the front end. A picker
      // rendering the full context put ninety-five characters of ARN plus two suffixes into
      // one `<option>`, which a native select cannot shrink, and the text ran out of its box.
      short: shortName(name),
      region: regionOf(name),
      // The other names this same cluster answers to, so a caller that sees one of them in a
      // kubeconfig can tell it is not a second cluster.
      aliases: Object.hasOwn(aliases, name) ? (aliases[name] as string[]) : [],
      ours: isOurs(name),
      // "" means "not knowable from the name" -- kind and k3s and minikube all look alike
      // here, and guessing would put a distribution on a card that `status()` then
      // contradicts.
      provider,
      billable: BILLABLE.includes(provider),
      is_default: name === byDefault,
      made_by_houston: builtHere.has(`${shortName(name)}@${regionOf(name)}`),
      where: whereOf(name, servers.get(name) ?? ''),
    });
  }
  return rows;
}

/** Contexts that are different names for the same API server. */
async function contextAliases(): Promise<{
  aliases: Record<string, string[]>;
  byDefault: string;
  names: string[];
  unreadable: string;
  servers: Map<string, string>;
}> {
  const [allNames, unreadable] = await contexts();
  const byDefault = config.defaultKubeContext();
  // ONE ROW PER CLUSTER, not one per context. `eksctl create cluster` writes
  // `<iam-user>@<cluster>.<region>.eksctl.io` and `aws eks update-kubeconfig` writes the
  // ARN, so a cluster built with one and adopted with the other has both -- and a list of
  // CONTEXTS then shows it twice and prices it twice. Reported from a real screen: "Costing
  // money 2 · ~$16.87/day" for a single cluster costing $8.44. A ledger whose whole job is
  // to make spend visible must not double it.
  //
  // The API server settles it with no probe: two contexts naming the same server are the
  // same cluster whatever they are called. The ARN is kept as the name to show, because it
  // says which account and which region -- the two facts the eksctl alias leaves out and the
  // two that matter when acting on the wrong cluster.
  const [servers] = await contextServers();
  // MAPS, not objects, all the way through: a kubeconfig context may be called anything,
  // and `'constructor' in servers` is true of an object that has never heard of it.
  const serverOf = new Map(Object.entries(servers));
  const aliasesOf = new Map<string, string[]>();
  let names = [...allNames];
  if (serverOf.size > 0) {
    const byServer = new Map<string, string[]>();
    for (const name of names) {
      const url = serverOf.get(name);
      if (url !== undefined && url !== '') {
        const group = byServer.get(url) ?? [];
        group.push(name);
        byServer.set(url, group);
      }
    }
    const keep = new Set<string>();
    for (const group of byServer.values()) {
      const sorted = [...group].sort();
      const best = sorted.find((g) => g.startsWith('arn:aws:eks:')) ?? (sorted[0] as string);
      keep.add(best);
      if (group.length > 1)
        aliasesOf.set(
          best,
          sorted.filter((n) => n !== best),
        );
    }
    names = names.filter((n) => !serverOf.has(n) || keep.has(n));
  }
  return {
    aliases: Object.fromEntries(aliasesOf),
    byDefault,
    names,
    unreadable,
    servers: serverOf,
  };
}

export interface KnownContexts {
  readonly contexts: ContextRow[];
  readonly unreadable: string;
  readonly default: string;
}

/**
 * Every cluster this box could talk to, without talking to any of them but one.
 *
 * Deliberately cheap and deliberately incomplete. `status()` is six or more probes per
 * cluster and one that is refusing spends the whole timeout, so a caller that wanted a list
 * of three clusters would wait on the slowest -- and a front end that fetches this first can
 * draw the cards immediately and fill each one in as its own `status()` returns. A cluster
 * nobody can reach then costs one slow card rather than a slow page.
 *
 * Nothing here is a claim about a cluster's health, and none of these fields comes from a
 * probe: the context names are the kubeconfig's, `ours` is which kubeconfig they came from,
 * and `provider` is read from the shape of the name. A caller that needs to know whether a
 * cluster is up asks `status()`, which is the function that goes and finds out.
 */
export async function knownContexts(): Promise<KnownContexts> {
  const { aliases, byDefault, names, unreadable, servers } = await contextAliases();
  return {
    contexts: await contextRows(aliases, byDefault, names, servers),
    unreadable,
    default: byDefault,
  };
}

/**
 * How many cluster reads `status` keeps in flight.
 *
 * Bounded on purpose: each one is a kubectl subprocess, and a cluster holding twenty
 * workspaces would otherwise fork sixty at once on a laptop that is already running other
 * stacks. Eight covers the six independent top-level reads in one go and keeps the
 * per-namespace wave moving.
 */
export const STATUS_WORKERS = 8;

/**
 * A map with at most `STATUS_WORKERS` calls in flight.
 *
 * Promises are concurrent by default, which is the trap: `Promise.all` over sixty reads
 * forks sixty subprocesses, and the bound is the whole reason for a worker count. Results
 * come back in ARGUMENT order however they finish, so the document does not
 * vary with which call happened to return first.
 */
export interface WorkspaceRow {
  readonly namespace: string;
  readonly name: string;
  readonly owner: string;
  readonly owner_readable: boolean;
  readonly pvcs: number;
}

/**
 * What `cluster prepare` sets up, read back: the default StorageClass, the ingress class,
 * whether cert-manager's API is there, the load balancer's address a DNS name points at,
 * and whether a name under the cluster's zone resolves to it. Each fact is null when it
 * could not be read; `dns_answers` is null until a zone is known. The whole block is null
 * for a cluster that did not answer.
 */
export interface Readiness {
  storage_class: string | null;
  ingress_class: string | null;
  cert_manager: boolean | null;
  cname_target: string;
  dns_answers: boolean | null;
}

export interface Ledger {
  context: string;
  distribution: string;
  provider: string;
  ours: boolean;
  reachable: boolean;
  unreadable: string[];
  reach_status: string;
  reach_why: string;
  reach_advice: string;
  manageable: boolean;
  unmanageable_why: string;
  gone: boolean;
  nodes: number | null;
  age_hours: number | null;
  instance_types: Record<string, number> | null;
  workspaces: WorkspaceRow[] | null;
  pvcs: number | null;
  loadbalancers: number | null;
  operator: boolean | null;
  monitoring: boolean | null;
  cost: CostEstimate | null;
  /** The short name and the region, so nobody has to read them out of the ARN. */
  name: string;
  region: string;
  /** Version returned by EKS, when AWS lets this server describe the cluster. */
  kubernetes_version?: string;
  /**
   * Whether houston built it: the `houston.io/managed-by` tag on the cluster itself, else the
   * local build note, else null -- "could not tell", which is not "no". `ours` is a different
   * question (whether this is houston's own kind cluster, and so which kubeconfig to use).
   */
  made_by_houston: boolean | null;
  /** RFC 3339 creation time from AWS or the build note; '' when neither knows. */
  created_at: string;
  /** The `houston.io/expires` reminder date (YYYY-MM-DD) or ''; days to it, or null. */
  expires: string;
  expires_in_days: number | null;
  /** The hourly rate times the age, rounded to 4 places; null when either is unknown. */
  spend_usd: number | null;
  ready: Readiness | null;
  /** The DNS zone workspaces get their public names under, from the cluster's note or tag; '' when none. */
  zone: string;
  /** This machine, AWS or elsewhere: which part of a page shows it, and how much is read. */
  where: Where;
}

// ---------------------------------------------------------------------------- next step

/** What `nextStep` is told; everything a front-end already has in hand. */
export interface NextStepInput {
  /** The four tools present, signed in to AWS, a region resolved. */
  readonly tools_ok: boolean;
  /** What stops it, as `eks.blockers` words it; lets stage 1 name the missing part. */
  readonly blockers?: readonly string[];
  /** This box has approved the AWS account for spending. */
  readonly approved: boolean;
  readonly account: string;
  readonly clusters: readonly Ledger[];
  /** Names of clusters a build is running for right now. */
  readonly building: readonly string[];
  /** Builds that failed part-way, and whether AWS still has the cluster (null: could not ask). */
  readonly failed: readonly FailedBuild[];
  readonly default_context: string;
}

export interface FailedBuild {
  readonly name: string;
  readonly region: string;
  readonly present: boolean | null;
}

/** One of the six stages, and the exact thing to do next. Printed verbatim by both front-ends. */
export interface NextStep {
  readonly stage: 1 | 2 | 3 | 4 | 5 | 6;
  readonly title: string;
  readonly why: string;
  readonly command: string;
  /** The cluster this step is about, or ''. */
  readonly cluster: string;
}

export const STAGES = ['Tools', 'Approve', 'Build', 'DNS', 'Run workspaces', 'Tear down'] as const;

/**
 * The next thing to do, decided once for the CLI, the GUI stepper and the docs.
 *
 * ONE TABLE, FIRST MATCH WINS, in the order a person meets these: what stops everything
 * (tools, approval) before what stops a cluster (a build, DNS), and what costs money
 * (an expiry, an idle cluster) before the happy path. Pure: it reads what it is given and
 * touches nothing, which is what lets both front-ends show the same sentence.
 */
export function nextStep(input: NextStepInput): NextStep {
  const failed = input.failed.find((build) => build.present !== false);
  if (failed !== undefined) {
    return {
      stage: 6,
      cluster: failed.name,
      title: `The build of ${failed.name} failed part-way and may be billing — delete what it left`,
      why:
        'eksctl may have built a VPC, a NAT gateway and a control plane before it failed, and ' +
        'houston does not destroy them on its own. Delete proves ownership by the tag in the ' +
        'config eksctl was handed, then checks AWS for anything left behind.',
      command: `houston cluster delete ${failed.name} --region ${failed.region}`,
    };
  }
  const building = input.building[0];
  if (building !== undefined) {
    return {
      stage: 3,
      cluster: building,
      title: `Building ${building} — about twenty minutes`,
      why:
        'Billing started when the build started. When it finishes, point a DNS name at the ' +
        'address it prints (stage 4).',
      command: '',
    };
  }
  const ordered = [...input.clusters].sort((a, b) => {
    const ad = a.context === input.default_context ? 0 : 1;
    const bd = b.context === input.default_context ? 0 : 1;
    return ad - bd;
  });
  const usable = ordered.filter((c) => !c.gone);
  if (usable.length === 0) {
    // What stops a BUILD matters only when there is nothing to use yet: a box with a
    // working cluster (kind, or a colleague's) is not told to install eksctl or approve
    // an account it will never build in.
    if (!input.tools_ok) {
      // ONLY THE SIGN-IN (or the region) MISSING is its own sentence. `eks.blockers` lists
      // no identity problem while a tool is absent, so a list with no tool in it means
      // every tool is there -- and "Install the four tools" sent somebody with an expired
      // SSO token looking for software they already had.
      const blockers = input.blockers ?? [];
      const toolMissing = blockers.some((line) => / is not installed$| is older than /u.test(line));
      if (blockers.length > 0 && !toolMissing) {
        const signIn = blockers.some((line) => line.startsWith('not signed in to AWS'));
        return {
          stage: 1,
          cluster: '',
          title: signIn ? 'Sign in to AWS on this machine' : 'Set an AWS region on this machine',
          why: blockers.join(' '),
          command: 'houston doctor',
        };
      }
      return {
        stage: 1,
        cluster: '',
        title: 'Install the four tools and sign in to AWS on this machine',
        why:
          'aws, eksctl, kubectl and helm, plus an AWS identity and a region. `houston doctor` ' +
          'names whichever is missing; a cluster is not built until all of them are there, ' +
          'because kubectl and helm are needed to prepare it after the money is spent.',
        command: 'houston doctor',
      };
    }
    if (!input.approved) {
      const account = input.account === '' ? '<account id>' : input.account;
      return {
        stage: 2,
        cluster: '',
        title: `Approve AWS account ${account} for spending on this box`,
        why:
          'houston will not build a cluster in an account until an admin names it here. It is a ' +
          'deliberate gate on money, and no flag skips it.',
        command: `houston config set cluster.approved_accounts ${account}`,
      };
    }
    return {
      stage: 3,
      cluster: '',
      title: 'Build a cluster',
      why:
        'About twenty minutes, and it bills from the first minute whether or not anything runs ' +
        'in it. Give it the DNS zone your workspace names will live under.',
      command: 'houston cluster create support --region us-east-1 --zone <your zone>',
    };
  }
  const dnsPending = usable.find(
    (c) => c.zone !== '' && c.ready !== null && c.ready.dns_answers === false,
  );
  if (dnsPending !== undefined) {
    const target = dnsPending.ready?.cname_target ?? '';
    return {
      stage: 4,
      cluster: dnsPending.name,
      title: `Point *.${dnsPending.zone} at ${target}, once`,
      why:
        `The name does not answer yet. Until it does, a workspace on ${dnsPending.name} is ` +
        'reachable only by a port-forward. Add the record at your DNS provider (a CNAME, ' +
        'not an A record: the address changes), then check it.',
      command: `*.${dnsPending.zone}   CNAME   ${target}`,
    };
  }
  // ONLY ONCE IT IS DUE. A build is often given a reminder a day or two out, and warning
  // from three days before flagged every new cluster the minute it was ready -- above the
  // DNS record it actually needed. The date itself stays on the cluster's details.
  const expiring = usable.find((c) => c.expires_in_days !== null && c.expires_in_days <= 0);
  if (expiring !== undefined) {
    const days = expiring.expires_in_days ?? 0;
    return {
      stage: 6,
      cluster: expiring.name,
      title:
        days < 0
          ? `${expiring.name} passed its expiry date ${String(-days)} d ago — keep it or delete it`
          : `${expiring.name} reaches its expiry date today — keep it or delete it`,
      why:
        'The date is a reminder tag and nothing deletes on it. Move it if the cluster is still ' +
        'needed; delete the cluster when it is not, because it bills either way.',
      command: `houston cluster keep ${expiring.name} --days 7`,
    };
  }
  const idle = usable.find(
    (c) =>
      c.reachable &&
      c.made_by_houston === true &&
      c.workspaces !== null &&
      c.workspaces.length === 0 &&
      c.cost !== null,
  );
  if (idle !== undefined) {
    const perDay = idle.cost === null ? '' : ` ~$${(idle.cost.usd_hr * 24).toFixed(2)}/day`;
    return {
      stage: 6,
      cluster: idle.name,
      title: `${idle.name} holds nothing and bills${perDay} — delete it when you are done`,
      why:
        'Removing workspaces does not lower the rate; only deleting the cluster stops it. ' +
        'Delete releases the load balancer, removes the cluster and checks AWS for leftovers.',
      command: `houston cluster delete ${idle.name}`,
    };
  }
  const ready = usable.find((c) => c.reachable);
  if (ready !== undefined) {
    return {
      stage: 5,
      cluster: ready.name,
      title: `Run a workspace on ${ready.name}`,
      why:
        `In the GUI: click New workspace and pick ${ready.name} under Where it runs` +
        (ready.zone !== ''
          ? `; its public name is pre-filled from ${ready.zone}.`
          : ready.where !== 'aws'
            ? '.'
            : '. Without a DNS zone it is reachable only by a port-forward; ' +
              `\`houston cluster prepare ${ready.name} --zone <zone>\` sets one.`),
      command: `houston up --version <version> --name <ticket> --context ${ready.name}`,
    };
  }
  const down = usable[0] as Ledger;
  return {
    stage: 5,
    cluster: down.name,
    title: `${down.name} is not answering — ${down.reach_why || 'it could not be read'}`,
    why:
      'Nothing about it could be read, which is not a report that it is empty or free. ' +
      (down.reach_advice || 'Check the credentials and the network, then read it again.'),
    command: `houston cluster status ${down.name}`,
  };
}

/**
 * Set `gone` when AWS says this EKS cluster does not exist. Never throws.
 *
 * Split out of `status` because it is the one place a REPORT asks AWS anything, and the
 * rule it has to obey is narrow enough to want stating on its own: a cluster is marked gone
 * only when `describeCluster` returns ABSENT. Anything else -- REFUSED, a malformed ARN, an
 * exception on the way -- leaves the cluster listed and the reader told it could not be read.
 */
/**
 * The AWS account the AWS CLI answers as, or '' when it cannot say. Asked once per five
 * minutes (`ponytail:` a process-wide memo; a credential switched mid-serve is seen within
 * that window).
 */
let callerMemo: { at: number; account: Promise<string> } | null = null;
function callerAccount(): Promise<string> {
  if (callerMemo === null || Date.now() - callerMemo.at > 300_000) {
    callerMemo = {
      at: Date.now(),
      account: eks.aws.whoami().then(
        (who) => who.account,
        () => '',
      ),
    };
  }
  return callerMemo.account;
}

async function askAwsAboutIt(out: Ledger, context: string): Promise<void> {
  if (!context.startsWith('arn:aws:eks:')) return;
  const bits = context.split(':');
  const name = context.split('/').pop() ?? '';
  if (bits.length < 6 || name === '') return;
  // ONLY IN THE CALLER'S OWN ACCOUNT. describe-cluster answers from the account the AWS
  // CLI is signed in to, so a cluster in another account -- a colleague's, another
  // profile's -- comes back "not found", and that was reported as gone: nothing billing,
  // Forget offered, for a cluster that was running. Another account is "could not ask".
  const caller = await callerAccount();
  if (caller === '' || caller !== bits[4]) return;
  let seen: Answer;
  try {
    seen = await eks.aws.describeCluster(name, bits[3] as string);
  } catch {
    // a report must not raise on a lookup
    return;
  }
  if (present(seen)) {
    // THE SAME DOCUMENT carries the tags `cluster create` wrote and the creation time, so
    // who built it and when it expires are read here, on every machine, for nothing extra.
    const doc: Record<string, unknown> = seen.doc;
    const tags = (doc.tags ?? {}) as Record<string, unknown>;
    out.made_by_houston = tags[eks.OWNED_TAG_KEY] === eks.OWNED_TAG_VALUE;
    const expires = tags[eks.EXPIRY_TAG_KEY];
    if (typeof expires === 'string') out.expires = expires;
    const zone = tags[eks.ZONE_TAG_KEY];
    if (typeof zone === 'string') out.zone = zone;
    if (typeof doc.createdAt === 'string') out.created_at = doc.createdAt;
    if (typeof doc.version === 'string') out.kubernetes_version = doc.version;
    return;
  }
  if (seen.state !== ABSENT) return;
  out.gone = true;
  out.reach_advice =
    'AWS says this cluster no longer exists, so it is not costing anything. The ' +
    'kubeconfig entry naming it is left over -- `houston cluster forget ' +
    `${name}\` removes it, or \`kubectl config delete-context ${context}\`.`;
}

/** The workspaces on this cluster, and what each one is holding. */
async function workspaceRows(
  ctx: string,
  spaces: string[] | null,
  out: Ledger,
  volumeGb: number | null,
): Promise<number | null> {
  if (spaces === null) {
    out.unreadable.push('workspaces');
    return volumeGb;
  }
  // Wave two: three reads per namespace, all in flight together under the same bound.
  const per = await mapLimit(spaces, STATUS_WORKERS, async (ns) => {
    const name = ns.startsWith(NAMESPACE_PREFIX) ? ns.slice(NAMESPACE_PREFIX.length) : ns;
    const [owner, held, pvc] = await Promise.all([
      namespaceOwner(ns, { context: ctx }),
      workspacePvcs(name, { context: ctx }).then(
        (v) => ({ ok: true as const, value: v }),
        () => ({ ok: false as const, value: [] as string[] }),
      ),
      askList('pvc', { context: ctx, namespace: ns }),
    ]);
    return { ns, name, owner, held, pvc };
  });

  const rows: WorkspaceRow[] = [];
  let pvcsTotal = 0;
  let pvcsUnreadable = false;
  let running = volumeGb;
  for (const { ns, name, owner, held, pvc } of per) {
    // one unreadable workspace is not zero
    if (!held.ok) pvcsUnreadable = true;
    pvcsTotal += held.value.length;
    const gb = claimedGb(pvc);
    if (gb === null) {
      pvcsUnreadable = true;
      running = null;
    } else if (running !== null) {
      running += gb;
    }
    rows.push({
      namespace: ns,
      name,
      owner: owner ?? '',
      owner_readable: owner !== null,
      pvcs: held.value.length,
    });
  }
  out.workspaces = rows;
  out.pvcs = pvcsUnreadable ? null : pvcsTotal;
  if (pvcsUnreadable) out.unreadable.push('pvcs');
  return running;
}

/** Every read the ledger needs, asked concurrently because each is a round trip. */
async function askTheClusterEverything(
  ctx: string,
  out: Ledger,
  volumeGb: number | null,
): Promise<number | null> {
  // READ CONCURRENTLY, in two waves. Every read below is an independent kubectl round trip
  // and none of them writes, but they ran one after another -- about a dozen calls for a
  // cluster holding two workspaces, and on a managed cluster each one is a second or two
  // over the network.
  //
  // MEASURED against a live EKS cluster: 18.15 seconds for one card, while the same box
  // answered the cheap LIST in 0.31. The GUI draws a card per cluster and fills each in from
  // its own request, so this number is exactly how long somebody sits looking at `?`.
  //
  // The SECOND wave depends on the first: which namespaces exist has to come back before
  // their owners and volumes can be asked for. Within a wave nothing depends on anything
  // else, and results are assembled in a fixed order afterwards so the document does not
  // vary with which call happened to finish first.
  const [dist, nodes, spaces, lbs, oper, mon, storage, ingress, certApi, lbService] =
    await Promise.all([
      distribution(ctx),
      askList('nodes', { context: ctx }),
      workspaceNamespaces(ctx),
      askList('svc', { context: ctx, allNamespaces: true }),
      operatorPresence(ctx),
      monitoringInstalled(ctx),
      // The four things `cluster prepare` leaves behind, so a page can say which stage a
      // cluster is at without anybody re-running prepare to find out.
      storageClasses(ctx),
      ingressClasses(ctx),
      askObject('customresourcedefinition', 'certificates.cert-manager.io', { context: ctx }),
      loadbalancerService(ctx),
    ]);

  out.distribution = providerOf(ctx, dist);
  if (out.distribution === 'eks') out.where = 'aws';
  out.ready = {
    storage_class: storage === null ? null : storage[1],
    ingress_class: ingress === null ? null : (ingress[0] ?? ''),
    cert_manager: refused(certApi) ? null : present(certApi),
    cname_target: lbService[1],
    dns_answers: await dnsAnswers(out.zone, lbService[1]),
  };
  out.provider = out.distribution === 'kind' ? PROVIDER_KIND : PROVIDER_EXTERNAL;

  if (refused(nodes)) {
    out.unreadable.push('nodes');
  } else {
    const list = items(nodes);
    out.nodes = list.length;
    out.age_hours = oldestNodeAgeHours(list);
    out.instance_types = nodeInventory(list);
  }

  const running = await workspaceRows(ctx, spaces, out, volumeGb);

  if (refused(lbs)) {
    out.unreadable.push('loadbalancers');
  } else {
    out.loadbalancers = items(lbs).filter(
      (it) => String(((it.spec ?? {}) as Bag).type ?? '') === 'LoadBalancer',
    ).length;
  }

  // PRESENCE, not ownership. The card's question is "does this cluster have a MongoDB
  // operator", and since `ensureOperator` adopts a foreign one rather than installing beside
  // it, asking about houston's own release would report "no operator" for a cluster that has
  // a perfectly good one and would use it.
  out.operator = present(oper);
  out.monitoring = mon;
  return running;
}

/** What houston's own cluster is, when the tool that made it is still here. */
async function describeOurCluster(ctx: string, out: Ledger): Promise<void> {
  out.ours = isOurs(ctx);
  // A CLUSTER HOUSTON MADE AND CAN NO LONGER REMOVE. `deleteCluster`, `clusterReclaimable`
  // and `prune` all open with `if (which('kind') === '') return false`, so uninstalling the
  // kind BINARY leaves the cluster running, reachable, holding memory -- and silently
  // unreclaimable, because those functions answer "there was nothing to delete" rather than
  // "I cannot delete it". The module docstring's rule applies to a control as much as to a
  // count: reporting nothing where the honest answer is "I cannot" is how a thing gets
  // forgotten.
  if (out.ours && which('kind') === '') {
    out.manageable = false;
    out.unmanageable_why =
      'houston built this cluster and can no longer remove it: kind is not ' +
      'installed. It keeps running and holding memory until something takes it ' +
      'away. Reinstall kind and `houston prune`, or remove its container ' +
      `directly with \`docker rm -f ${CLUSTER_NAME}-control-plane\`.`;
  }
  if (out.ours) {
    // houston's OWN cluster is reached through houston's OWN kubeconfig, and a fresh
    // HOUSTON_HOME has not got one yet -- so a cluster that is up and visible in `kubectl
    // config get-contexts` answers "not answering" here.
    //
    // `ensureKubeconfig` exists for exactly this and its docstring names the case: "With a
    // kind cluster already up and a fresh home, every command failed ... and could not
    // self-heal". That was fixed for `up`, and this command reintroduced it by probing
    // without calling it.
    //
    // Best effort: a status report must not fail because an export did not work. If it does
    // not, `reachable` below answers false and says so honestly.
    try {
      await ensureKubeconfig({ context: ctx, distribution: 'kind', create: false } as ClusterPlan);
    } catch {
      // a report must not raise on a repair
    }
  }
}

/** The shape of the answer, filled in as far as a context that may not exist allows. */
function emptyLedger(ctx: string): Ledger {
  return {
    context: ctx,
    distribution: '',
    provider: '',
    ours: false,
    reachable: false,
    unreadable: [],
    // DECLARED HERE, not only where they are set. Every caller reads this document -- the
    // CLI renderer, the `--json` envelope, and fixture-style test doubles -- so a key
    // that appears only on some paths is the payload-shape trap this repo already has a name
    // for.
    reach_status: REACH_DOWN,
    reach_why: '',
    reach_advice: '',
    // Whether houston can still TAKE THIS CLUSTER AWAY, which is not the same question as
    // whether it can use it.
    manageable: true,
    unmanageable_why: '',
    // AWS asserting the cluster is not there, which is not the same as it not answering.
    // Only ever set from a definite ABSENT.
    gone: false,
    nodes: null,
    age_hours: null,
    instance_types: null,
    workspaces: null,
    pvcs: null,
    loadbalancers: null,
    operator: null,
    monitoring: null,
    cost: null,
    name: shortName(ctx),
    region: regionOf(ctx),
    made_by_houston: null,
    created_at: '',
    expires: '',
    expires_in_days: null,
    spend_usd: null,
    ready: null,
    zone: '',
    where: whereOf(ctx),
  };
}

/**
 * What the local build note knows, for the fields AWS did not answer.
 *
 * The note is written by `cluster create` on the machine that ran it, so it is a fallback
 * and never the first word: a tag says the same thing on every machine, and AWS saying
 * "no tag" beats a note saying "I built it".
 */
function describeRecord(out: Ledger): void {
  const record = eks
    .remembered()
    .find((entry) => entry.name === out.name && (out.region === '' || entry.region === out.region));
  if (record === undefined) return;
  if (out.made_by_houston === null) out.made_by_houston = true;
  if (out.created_at === '' && typeof record.created_at === 'string')
    out.created_at = record.created_at;
  if (out.expires === '' && typeof record.expires === 'string') out.expires = record.expires;
  if (out.zone === '' && typeof record.zone === 'string') out.zone = record.zone;
}

/** What a name resolves to as a CNAME, or [] when it does not; never throws. */
export async function resolveName(host: string): Promise<string[]> {
  try {
    return await resolveCname(host);
  } catch {
    return [];
  }
}

/**
 * The IPv4 addresses a name answers with, or [] when it answers none; never throws.
 *
 * Asked only when a name has no CNAME: a name that answers with addresses but no CNAME is
 * a record a proxy rewrites -- Cloudflare's default, the orange cloud -- which is a
 * different fix from a record that is not there at all.
 */
export async function resolveAddresses(host: string): Promise<string[]> {
  try {
    return await resolve4(host);
  } catch {
    return [];
  }
}

/**
 * Whether a name under the cluster's zone reaches its load balancer: the wildcard CNAME
 * the guide asks for, checked with a name nobody uses. null when there is no zone or no
 * address to compare against; false when the name is missing or points elsewhere.
 */
async function dnsAnswers(zone: string, target: string): Promise<boolean | null> {
  if (zone === '' || target === '') return null;
  let answers: string[];
  try {
    answers = await resolveCname(`houston-probe.${zone}`);
  } catch {
    return false;
  }
  const want = target.toLowerCase().replace(/\.$/u, '');
  return answers.some((answer) => answer.toLowerCase().replace(/\.$/u, '') === want);
}

/** The rate times the age, or null when either side is unknown. Never negative. */
function spendSoFar(out: Ledger): number | null {
  if (out.cost === null || out.created_at === '') return null;
  const since = Date.parse(out.created_at);
  if (Number.isNaN(since)) return null;
  const hours = (Date.now() - since) / 3_600_000;
  if (hours < 0) return null;
  return round4(out.cost.usd_hr * hours);
}

/** What the ledger can still say about a cluster that will not answer. */
async function unreachableLedger(ctx: string, out: Ledger): Promise<Ledger> {
  // A CLUSTER THAT AWS SAYS IS GONE. `cluster delete` removes the cluster; it does not reach
  // into every kubeconfig on the machine and tidy the entries that named it, and `aws eks
  // update-kubeconfig` and `eksctl` each wrote one. A cluster deleted OUTSIDE houston
  // therefore keeps a context for ever, and the card for it says only "not answering" --
  // which reads as a cluster that is down and still billing, the most alarming reading of
  // the cheapest state.
  //
  // HERE AND NOT IN `knownContexts`. This costs an AWS round trip, and the list is the
  // function whose entire contract is that it probes nothing -- one probe per cloud cluster
  // on a four-second poll is what made the page slow enough to be reported. `status` is per
  // card, already spends `reach`, and is only reached at all when that has already failed.
  //
  // ONLY ON A DEFINITE NO. `describeCluster` answers PRESENT, ABSENT or REFUSED, and only
  // ABSENT is AWS asserting the cluster is not there. REFUSED is "I could not ask" --
  // expired credentials, no route, a permission boundary -- and calling that gone would
  // report a BILLING cluster as deleted, which is the one mistake this module exists to
  // prevent.
  await askAwsAboutIt(out, ctx);
  finishTheRecord(out);
  // Everything below needs the API server. Reporting zeros for a cluster that did not answer
  // is the exact failure this module is written against, so the fields stay null and the
  // caller is told why.
  out.unreadable.push('cluster');
  return out;
}

/** The API server a context names, from the kubeconfig; '' when it cannot be read. */
async function serverOf(ctx: string): Promise<string> {
  const [servers] = await contextServers();
  return Object.hasOwn(servers, ctx) ? (servers[ctx] as string) : '';
}

/**
 * The overview's read of a cluster that does not bill: whether it answers, what it is,
 * and which workspaces it holds.
 *
 * A working install does not change its storage class or its ingress between two looks,
 * and `up` checks both right before it creates anything, so a page that asked again on
 * every look paid eleven reads where three answer what it shows. `status` reads the rest
 * when somebody opens the cluster. What is not read stays null, never a zero or a tick.
 */
async function glance(ctx: string, where: Where): Promise<Ledger> {
  const out = emptyLedger(ctx);
  out.where = where;
  await describeOurCluster(ctx, out);
  const got = await reach(ctx);
  out.reachable = reachOk(got);
  out.reach_status = got.status;
  out.reach_why = reachWhy(got);
  out.reach_advice = reachAdvice(got, ctx);
  if (!out.reachable) {
    out.unreadable.push('cluster');
    return out;
  }
  const [dist, spaces, claims] = await Promise.all([
    distribution(ctx),
    askList('namespace', { context: ctx, selector: OWNER_SELECTOR }),
    askList('pvc', { context: ctx, allNamespaces: true, selector: OWNER_SELECTOR }),
  ]);
  out.distribution = providerOf(ctx, dist);
  // EKS under a name and a server that do not say so: it bills, so it is read in full.
  if (out.distribution === 'eks') return await status(ctx);
  out.provider = out.distribution === 'kind' ? PROVIDER_KIND : PROVIDER_EXTERNAL;
  if (refused(spaces)) {
    out.unreadable.push('workspaces');
    return out;
  }
  const held = new Map<string, number>();
  for (const claim of refused(claims) ? [] : items(claims)) {
    const ns = String(metadataOf(claim).namespace ?? '');
    held.set(ns, (held.get(ns) ?? 0) + 1);
  }
  const rows: WorkspaceRow[] = [];
  for (const space of items(spaces)) {
    const meta = metadataOf(space);
    const ns = String(meta.name ?? '');
    if (ns === '') continue;
    const labels = (
      typeof meta.labels === 'object' && meta.labels !== null ? meta.labels : {}
    ) as Bag;
    rows.push({
      namespace: ns,
      name: ns.startsWith(NAMESPACE_PREFIX) ? ns.slice(NAMESPACE_PREFIX.length) : ns,
      owner: String(labels[OWNER_OF_LABEL] ?? ''),
      owner_readable: true,
      pvcs: held.get(ns) ?? 0,
    });
  }
  out.workspaces = rows.sort((a, b) => compareCodePoints(a.namespace, b.namespace));
  if (refused(claims)) out.unreadable.push('pvcs');
  else out.pvcs = [...held.values()].reduce((sum, n) => sum + n, 0);
  return out;
}

/**
 * Everything a cluster is holding, in one read-only pass.
 *
 * `context` defaults to the box's configured cluster, so `cluster status` and `up` answer
 * about the same one -- the same reason `doctor` takes it.
 */
export async function status(context = '', _emit: Emit = nullEmit): Promise<Ledger> {
  let named = context.trim();
  if (named !== '') {
    // THE SAME REFUSAL `up --context` GIVES. A context nobody can name is a bad argument,
    // not a cluster that is down, and calling it "not answering" would send somebody to
    // check a cluster that does not exist. An unreadable kubeconfig deliberately does not
    // refuse here either -- see the helper.
    [named] = await assertContextKnown(named);
  }
  let ctx = named || config.defaultKubeContext();
  if (ctx === '') {
    try {
      ctx = (await planCluster()).context;
    } catch {
      // no cluster is a report, not a crash
      ctx = await activeContext();
    }
  }

  let volumeGb: number | null = 0.0;
  const out = emptyLedger(ctx);
  if (ctx === '') {
    out.unreadable.push('context');
    return out;
  }
  out.where = whereOf(ctx, await serverOf(ctx));

  await describeOurCluster(ctx, out);
  const got = await reach(ctx);
  out.reachable = reachOk(got);
  // WHY it could not be read, not merely that it could not. A ledger that says "is not
  // answering" for a cluster that is ACTIVE and merely refusing this credential sends the
  // reader to check the cluster, which is the one place the problem is not -- measured
  // against a live EKS cluster, as an IAM user with no access entry.
  out.reach_status = got.status;
  out.reach_why = reachWhy(got);
  out.reach_advice = reachAdvice(got, ctx);
  if (!out.reachable) return await unreachableLedger(ctx, out);

  // ONE describe per EKS status, on the reachable path too. The unreachable path already
  // paid it (for `gone`); here it buys who built the cluster and when it expires, read from
  // the cluster's own tags rather than from a note only the building machine has.
  await askAwsAboutIt(out, ctx);
  finishTheRecord(out);
  volumeGb = await askTheClusterEverything(ctx, out, volumeGb);

  // LAST, because it prices things read above it. Computing it beside the node inventory --
  // where it used to be -- meant the load balancers and workspace volumes had not been
  // counted yet, so a total printed one line under "1 LoadBalancer(s) — each one is billed"
  // silently excluded it.
  if (out.instance_types !== null) {
    out.cost = estimateUsdHr(out.distribution, out.instance_types, {
      loadbalancers: out.loadbalancers,
      volumeGb,
      version: out.kubernetes_version ?? '',
    });
  }
  out.spend_usd = spendSoFar(out);
  return out;
}

/** The note's answers for what AWS left blank, then the days to the expiry date. */
function finishTheRecord(out: Ledger): void {
  describeRecord(out);
  out.expires_in_days = eks.daysUntil(out.expires);
}

// ---------------------------------------------------------------------------- overview

/** What stops everything before any cluster is looked at; what the build flow's first two steps show. */
export interface OverviewPreflight {
  readonly tools_ok: boolean;
  readonly blockers: string[];
  readonly account: string;
  readonly identity: string;
  readonly region: string;
  readonly approved: boolean;
}

/** The AWS section's sums: a cluster on this machine or elsewhere is in none of them. */
export interface OverviewTotals {
  readonly clusters: number;
  /** Clusters that cost money by the hour and are not known to be gone. */
  readonly billable: number;
  /** The sum of the known hourly rates times 24; null when no cluster's rate could be read. */
  readonly usd_day: number | null;
  readonly spend_usd: number | null;
  /** Workspaces held, over the clusters whose list could be read. */
  readonly workspaces: number;
  /** Billing clusters whose rate could not be read (and builds with none yet): usd_day leaves them out. */
  readonly unpriced: number;
  /** Clusters whose workspace list could not be read: `workspaces` leaves them out. */
  readonly unread: number;
}

export interface Overview {
  readonly clusters: Ledger[];
  readonly failed: FailedBuild[];
  readonly preflight: OverviewPreflight;
  readonly totals: OverviewTotals;
  readonly next: NextStep;
  readonly default: string;
  readonly unreadable: string;
}

/** How long a server may reuse the AWS tool and identity checks between two overviews. */
export const PREFLIGHT_REUSE_MS = 10 * 60_000;
let lastPreflight: { at: number; value: Awaited<ReturnType<typeof eks.aws.preflight>> } | null =
  null;

/**
 * Every known cluster, the totals, and what to do next -- the one answer both front-ends
 * render, so the CLI and the GUI cannot disagree about what exists or what it costs.
 *
 * An AWS cluster is a full `status`, because its numbers are money and they change; any
 * other is a `glance`. Three at a time (`ponytail:` each status already runs its own reads
 * eight wide; a wider outer limit only multiplies kubectl processes -- raise it if a box
 * with many clusters proves slow). A progress line per cluster, because one EKS status is
 * measured at ~18 s and a page that shows nothing for a minute reads as broken.
 *
 * The stages and the totals are the AWS section's: a cluster on this machine has nothing
 * to approve, build or pay for. `reuse` lets a server keep the AWS tool and identity
 * checks for `PREFLIGHT_REUSE_MS` -- 1.9 s of a 2.6 s read on a box with only a k3s --
 * while a Re-check, and every CLI run, asks again.
 */
export async function overview(
  emit: Emit = nullEmit,
  {
    building = [] as readonly string[],
    reuse = false,
  }: { building?: readonly string[]; reuse?: boolean } = {},
): Promise<Overview> {
  const known = await knownContexts();
  if (!reuse || lastPreflight === null || Date.now() - lastPreflight.at > PREFLIGHT_REUSE_MS) {
    lastPreflight = { at: Date.now(), value: await eks.aws.preflight() };
  }
  const pre = lastPreflight.value;
  const blockers = eks.blockers(pre, { toBuild: true });
  const account = pre.identity.account;
  const preflight: OverviewPreflight = {
    tools_ok: blockers.length === 0,
    blockers,
    account,
    identity: pre.identity.arn,
    region: pre.region,
    approved: account !== '' && config.approvedAwsAccounts().has(account),
  };
  const clusters = await mapLimit(known.contexts, 3, async (row) => {
    info(emit, `reading ${row.short}…`, { phase: 'info' });
    return row.where === 'aws'
      ? await status(row.context, emit)
      : await glance(row.context, row.where);
  });
  const inAws = clusters.filter((ledger) => ledger.where === 'aws');
  // Builds that failed part-way: the note the create leaves stays until the cluster is
  // gone, and AWS is asked whether it is. A refused read is null, never "not there".
  // Only a build whose process is GONE failed; one still running (a CLI create in another
  // terminal) is building, and "delete what it left" would have pointed at a live build.
  const dead = new Set(journal.abandoned().map((entry) => entry.id));
  const running = new Set(building);
  const failed: FailedBuild[] = [];
  for (const entry of journal.openEntries()) {
    if (entry.kind !== journal.CLUSTER_UNFINISHED) continue;
    if (!dead.has(entry.id)) {
      running.add(entry.workspace);
      continue;
    }
    const region = String((entry.detail as Record<string, unknown>).region ?? '');
    let there: boolean | null;
    try {
      const seen = await eks.aws.describeCluster(entry.workspace, region);
      there = seen.state === ABSENT ? false : present(seen) ? true : null;
    } catch {
      there = null;
    }
    failed.push({ name: entry.workspace, region, present: there });
  }
  let usd = 0;
  let priced = 0;
  let spend = 0;
  let spent = 0;
  let workspaces = 0;
  let billable = 0;
  let unpriced = 0;
  let unread = 0;
  const names = new Set<string>();
  for (const ledger of inAws) {
    names.add(ledger.name);
    if (!ledger.gone) {
      billable += 1;
      // A billing cluster whose rate could not be read is money the total leaves out:
      // counted here so both front-ends can say the figure is partial.
      if (
        ledger.cost === null ||
        ledger.cost.incomplete.length > 0 ||
        Object.keys(ledger.cost.unpriced).length > 0
      )
        unpriced += 1;
    }
    if (ledger.cost !== null) {
      usd += ledger.cost.usd_hr;
      priced += 1;
    }
    if (ledger.spend_usd !== null) {
      spend += ledger.spend_usd;
      spent += 1;
    }
    if (ledger.workspaces !== null) workspaces += ledger.workspaces.length;
    else if (!ledger.gone) unread += 1;
  }
  // A cluster being built bills from its first minute and has no rate yet.
  for (const name of running) {
    if (names.has(name)) continue;
    billable += 1;
    unpriced += 1;
  }
  const totals: OverviewTotals = {
    clusters: inAws.length,
    billable,
    usd_day: priced === 0 ? null : Math.round(usd * 24 * 100) / 100,
    spend_usd: spent === 0 ? null : Math.round(spend * 100) / 100,
    workspaces,
    unpriced,
    unread,
  };
  return {
    clusters,
    failed,
    preflight,
    totals,
    next: nextStep({
      tools_ok: preflight.tools_ok,
      blockers,
      approved: preflight.approved,
      account,
      clusters: inAws,
      building: [...running],
      failed,
      default_context: known.default,
    }),
    default: known.default,
    unreadable: known.unreadable,
  };
}
