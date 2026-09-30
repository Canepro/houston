/**
 * Which binaries are here and what version they are.
 *
 * Tier k1. `kind` is OPTIONAL: creating a cluster needs it, using one does not, so a missing
 * `kind` narrows what houston can do without stopping it working in the cluster you already
 * have. `Preflight` is everything `doctor` needs in one pass, changing nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { kube } from './exec';
import {
  CORE_TOOLS,
  LOCAL_PROVISION_TOOLS,
  PROBE_TIMEOUT,
  tools as allTools,
  tuning,
} from './names';

/** One binary: whether it is there, what version, and whether that is enough. */
export interface Tool {
  readonly name: string;
  readonly path: string;
  readonly version: readonly number[];
  readonly raw: string;
}

export function makeTool(values: Partial<Tool> & { name: string }): Tool {
  return { path: '', version: [], raw: '', ...values };
}

export function toolPresent(tool: Tool): boolean {
  return tool.path !== '';
}

/**
 * Whether this tool clears its floor.
 *
 * An unknown version with the binary present is NOT a failure: a distro may print
 * something this does not parse, and refusing to proceed over an unrecognised version
 * string would be worse than trying.
 */
export function newEnough(tool: Tool): boolean {
  const floor = allTools()[tool.name];
  if (floor === undefined || tool.version.length === 0) return true;
  const mine = tool.version.slice(0, floor.length);
  for (const [index, bound] of floor.entries()) {
    const part = mine[index] ?? 0;
    if (part > bound) return true;
    if (part < bound) return false;
  }
  return true;
}

export function pretty(tool: Tool): string {
  return tool.version.length > 0 ? tool.version.join('.') : tool.raw || '?';
}

/** Absolute path to a tool, or '' -- the one place PATH is consulted. */
export function which(tool: string): string {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here, or not executable */
    }
  }
  return '';
}

/**
 * First dotted number in a version string, as a list.
 *
 * Deliberately loose: `kind v0.32.0 go1.26.3 linux/amd64`, `Client Version: v1.36.3` and
 * `v4.2.3+g43e8b7f` are all real output from the three tools, and each spells it
 * differently.
 */
export function parseVersion(text: string): number[] {
  const match = /v?(\d+)\.(\d+)(?:\.(\d+))?/u.exec(text || '');
  if (match === null) return [];
  // The optional third group is `undefined` when the string carried only major.minor,
  // which is `v4.2` and is a real answer -- it is dropped, as it always has been, rather
  // than read as a zero.
  return (match.slice(1) as (string | undefined)[])
    .filter((part) => part !== undefined)
    .map((part) => Number(part));
}

/**
 * How each tool is asked for its version.
 *
 * The fallback is `--version`, and a tool that does not accept it is not merely unprobed:
 * `parseVersion` returns [] on the error text and `newEnough` answers true on an empty
 * version -- deliberately and correctly, so an unparseable version never blocks a working
 * tool. The two combine into a floor that silently passes. `eksctl` is cobra-based and
 * spells it `eksctl version`, so it is listed here rather than left to a fallback it
 * would fail.
 */
const VERSION_ARGV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  kind: ['version'],
  kubectl: ['version', '--client'],
  helm: ['version', '--short'],
  eksctl: ['version'],
});

/** Locate one tool and read its version. */
export async function tool(name: string): Promise<Tool> {
  const found = makeTool({ name, path: which(name) });
  if (!toolPresent(found)) return found;
  const argv = [name, ...(VERSION_ARGV[name] ?? ['--version'])];
  const res = await kube.run(argv, { timeout: PROBE_TIMEOUT });
  const text = res.stdout || res.stderr;
  const raw = text === '' ? '' : (text.trim().split('\n')[0] ?? '');
  return { ...found, raw, version: parseVersion(raw) };
}

/** Sort key for a semver-ish string. Non-numeric parts sort low. */
export function versionKey(text: string): number[] {
  return String(text)
    .split('.')
    .map((part) => {
      const digits = /^(\d+)/u.exec(part);
      return digits === null ? -1 : Number(digits[1]);
    });
}

/**
 * What this machine can do, as facts rather than a verdict.
 *
 * The verdict belongs to the caller, because it depends on what is being asked: a box
 * with no `kind` is perfectly healthy if nobody wants Kubernetes, and broken if a
 * Kubernetes workspace already exists on it.
 */
export interface Preflight {
  tools: Record<string, Tool>;
  clusterExists: boolean;
  clusterReachable: boolean;
  /**
   * Whether HELM can reach the cluster, asked separately from kubectl on purpose --
   * they can disagree, and when they do the create is already four minutes in. '' means
   * not asked (no cluster to ask about).
   */
  helmReachable: string;
  storageClasses: string[];
  defaultStorageClass: string;
  /**
   * Ingress controllers installed here. Empty is NOT a fault -- a workspace reached by
   * port-forward needs none. It only blocks `--domain`, so it is checked at create time
   * against what was asked for, never in `doctor`.
   */
  ingressClasses: string[];
  otherClusters: string[];
  namespaces: string[];
  /**
   * What this cluster IS. The name is for the wording of a message and never for a
   * branch that widens what houston may do -- `k3s --disable traefik` is a real setup
   * and minikube's ingress is an addon that ships off, so what a cluster CAN do is each
   * of the fields below.
   */
  distribution: string;
  nodeCount: number;
  architectures: string[];
  metrics: boolean;
  /** Evidence that a LoadBalancer works here, or ''. */
  loadbalancer: string;
  /**
   * The context actually probed, and how that cluster came to exist. On a box with no
   * kind this is whatever `kubectl` is already pointed at -- the bring-your-own-cluster
   * case, where houston manages namespaces and never the cluster.
   */
  context: string;
  provider: string;
  /**
   * Whether this call would BRING THE CLUSTER INTO EXISTENCE. Reported rather than
   * inferred from `clusterReachable`, because "not answering" and "not made yet" are
   * different sentences and send a reader to different places.
   */
  willCreate: boolean;
  /**
   * Which cluster facts could not be READ, as opposed to read as empty. A restricted
   * kubeconfig can pass /readyz and then be refused every actual read, and reporting
   * those as "no StorageClass, no ingress, 0 nodes" made doctor state three false facts
   * under a green verdict.
   */
  unreadable: string[];
  /**
   * Why the cluster question could not be ANSWERED, as opposed to answered no. `kind get
   * clusters` fails when Docker is down and returns nothing when there are simply no
   * clusters -- both give an empty list, and reporting the first as "the cluster does
   * not exist" would send someone to create one that is already there.
   */
  probeFailed: string;
}

export function preflight(values: Partial<Preflight> = {}): Preflight {
  return {
    tools: {},
    clusterExists: false,
    clusterReachable: false,
    helmReachable: '',
    storageClasses: [],
    defaultStorageClass: '',
    ingressClasses: [],
    otherClusters: [],
    namespaces: [],
    distribution: '',
    nodeCount: 0,
    architectures: [],
    metrics: false,
    loadbalancer: '',
    context: '',
    provider: '',
    willCreate: false,
    unreadable: [],
    probeFailed: '',
    ...values,
  };
}

function everyToolReady(found: Preflight, registry: Readonly<Record<string, unknown>>): boolean {
  // Keyed on the REGISTRY rather than on what happens to be in `found.tools`, because
  // every() over nothing is true: a Preflight carrying no tool information at all
  // claimed every tool was ready, which is "I have no idea" reported as "yes".
  return Object.keys(registry).every((name) => {
    const tool = found.tools[name];
    return tool !== undefined && toolPresent(tool) && newEnough(tool);
  });
}

/** Whether Kubernetes can be USED. Provisioning is a separate question. */
export function toolsReady(found: Preflight): boolean {
  return everyToolReady(found, CORE_TOOLS);
}

/**
 * Whether houston can CREATE a cluster ON THIS MACHINE, as opposed to use one.
 *
 * Keyed on `LOCAL_PROVISION_TOOLS`, so a cloud tool appearing in the registry cannot
 * turn this false on a box that has kind.
 */
export function canProvision(found: Preflight): boolean {
  return everyToolReady(found, LOCAL_PROVISION_TOOLS);
}

/**
 * Whether houston can CREATE a cluster on a cloud provider.
 *
 * False on an empty registry, deliberately: every() over nothing is true, and "there is
 * no cloud tooling compiled in" must not read as "yes, this box can build you an EKS
 * cluster".
 */
export function canProvisionCloud(found: Preflight): boolean {
  if (Object.keys(tuning.CLOUD_PROVISION_TOOLS).length === 0) return false;
  return everyToolReady(found, tuning.CLOUD_PROVISION_TOOLS);
}

/**
 * Only the tools that stop Kubernetes working. A missing `kind` means houston cannot
 * make you a cluster, not that it cannot use yours.
 */
export function missingTools(found: Preflight): string[] {
  return Object.keys(CORE_TOOLS).filter((name) => {
    const tool = found.tools[name];
    return tool !== undefined && !toolPresent(tool);
  });
}

export function outdatedTools(found: Preflight): string[] {
  return Object.entries(found.tools)
    .filter(([, tool]) => toolPresent(tool) && !newEnough(tool))
    .map(([name]) => name);
}

/** A cluster is reachable and houston could put a workspace in it. */
export function usable(found: Preflight): boolean {
  return toolsReady(found) && found.clusterReachable;
}
