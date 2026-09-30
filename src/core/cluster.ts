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
import { type Emit, nullEmit } from '../lib/events';

import * as eks from './eks';
import { ABSENT, type Answer, askList, items, present, refused } from './kube/ask';
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
import { workspaceNamespaces } from './kube/capabilities';
import { monitoringInstalled } from './kube/monitoring';
import {
  CLUSTER_NAME,
  NAMESPACE_PREFIX,
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
export const NAT_GATEWAY_USD_HR = 0.045;

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
  {
    loadbalancers = 0,
    volumeGb = 0.0,
  }: { loadbalancers?: number | null; volumeGb?: number | null } = {},
): CostEstimate | null {
  if (!BILLABLE.includes(dist)) return null;
  let total = EKS_CONTROL_PLANE_USD_HR + NAT_GATEWAY_USD_HR;
  // `Object.hasOwn` and a `Map`, for the reason `nodeInventory` builds one: the key is a
  // label the cluster chose. `INSTANCE_USD_HR['toString']` is a FUNCTION, so the rate was
  // not undefined, the type was not reported as unpriced, and the total became NaN.
  const unpricedCounts = new Map<string, number>();
  const incomplete: string[] = [];
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
      'us-east-1 on-demand: control plane, NAT gateway, nodes, ' +
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

export interface ContextRow {
  readonly context: string;
  readonly short: string;
  readonly region: string;
  readonly aliases: string[];
  readonly ours: boolean;
  readonly provider: string;
  readonly billable: boolean;
  readonly is_default: boolean;
}

/** One row per context: whose it is, and whether it can be reached at all. */
async function contextRows(
  aliases: Record<string, string[]>,
  byDefault: string,
  names: readonly string[],
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
  return { aliases: Object.fromEntries(aliasesOf), byDefault, names, unreadable };
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
  const { aliases, byDefault, names, unreadable } = await contextAliases();
  return { contexts: await contextRows(aliases, byDefault, names), unreadable, default: byDefault };
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
async function mapLimit<T, R>(
  inputs: readonly T[],
  limit: number,
  run: (input: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= inputs.length) return;
      out[index] = await run(inputs[index] as T, index);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, inputs.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return out;
}

export interface WorkspaceRow {
  readonly namespace: string;
  readonly name: string;
  readonly owner: string;
  readonly owner_readable: boolean;
  readonly pvcs: number;
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
}

/**
 * Set `gone` when AWS says this EKS cluster does not exist. Never throws.
 *
 * Split out of `status` because it is the one place a REPORT asks AWS anything, and the
 * rule it has to obey is narrow enough to want stating on its own: a cluster is marked gone
 * only when `describeCluster` returns ABSENT. Anything else -- REFUSED, a malformed ARN, an
 * exception on the way -- leaves the cluster listed and the reader told it could not be read.
 */
async function markIfAwsSaysGone(out: Ledger, context: string): Promise<void> {
  if (!context.startsWith('arn:aws:eks:')) return;
  const bits = context.split(':');
  const name = context.split('/').pop() ?? '';
  if (bits.length < 6 || name === '') return;
  let seen: { state: string };
  try {
    seen = await eks.aws.describeCluster(name, bits[3] as string);
  } catch {
    // a report must not raise on a lookup
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
  const [dist, nodes, spaces, lbs, oper, mon] = await Promise.all([
    distribution(ctx),
    askList('nodes', { context: ctx }),
    workspaceNamespaces(ctx),
    askList('svc', { context: ctx, allNamespaces: true }),
    operatorPresence(ctx),
    monitoringInstalled(ctx),
  ]);

  out.distribution = providerOf(ctx, dist);
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
  };
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
  await markIfAwsSaysGone(out, ctx);
  // Everything below needs the API server. Reporting zeros for a cluster that did not answer
  // is the exact failure this module is written against, so the fields stay null and the
  // caller is told why.
  out.unreadable.push('cluster');
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

  volumeGb = await askTheClusterEverything(ctx, out, volumeGb);

  // LAST, because it prices things read above it. Computing it beside the node inventory --
  // where it used to be -- meant the load balancers and workspace volumes had not been
  // counted yet, so a total printed one line under "1 LoadBalancer(s) — each one is billed"
  // silently excluded it.
  if (out.instance_types !== null) {
    out.cost = estimateUsdHr(out.distribution, out.instance_types, {
      loadbalancers: out.loadbalancers,
      volumeGb,
    });
  }
  return out;
}
