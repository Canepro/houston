/**
 * Where a cluster receives traffic, and whether that is this box.
 *
 * Tier k2, read-only. Ingress endpoints, host-port claims and the address arithmetic around
 * them. `isLocalAddress` is a bind test rather than a dial, which is why it is the one place
 * in this tier that opens a socket.
 */
import * as net from 'node:net';

import { ConflictError } from '../../lib/errors';
import { info, nullEmit, type Emit } from '../../lib/events';

import { askList, items, require_ } from './ask';
import { activeContext } from './context';
import { kube } from './exec';
import { CONTEXT, PROBE_TIMEOUT, isOurs } from './names';
import { reachable } from './reachability';
import { which } from './tools';
import type { Sleep } from './replicaset';

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function mapOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/**
 * `[service name, address, how many LoadBalancer Services have no address yet]`.
 *
 * THE THIRD VALUE IS THE ONE A NAME-AND-ADDRESS PAIR COULD NOT EXPRESS: "this cluster has
 * no LoadBalancer Service" and "it has one and the provider has not published an address
 * yet" both came back as `['', '']`, so a caller that wanted to wait could not tell whether
 * waiting had any point. On EKS the second is the normal state for the first minute or two
 * after a create.
 *
 * READ AS OBJECTS, NOT AS A JSONPATH. The jsonpath this replaces interpolated `ip` and
 * `hostname` adjacently with nothing between them, which was safe only because the two
 * platforms in play populate exactly one each -- so a Service carrying BOTH yielded the two
 * concatenated into one nonsense string that travelled out as a printed CNAME target
 * somebody would paste into DNS. HOSTNAME IS PREFERRED EXPLICITLY: a CNAME target has to be
 * a name, and where a provider gives both, the name is the stable one.
 */
export async function loadbalancerState(context = CONTEXT): Promise<[string, string, number]> {
  const { name, address, pending } = await loadbalancerRead(context);
  return [name, address, pending];
}

/**
 * The same read, saying whether the cluster answered at all. `loadbalancerState` reads a
 * refusal as "none", which is right for a report and wrong for a teardown: a delete that
 * took "could not ask" for "gone" handed the VPC to eksctl with a load balancer still in it.
 */
export async function loadbalancerRead(
  context = CONTEXT,
): Promise<{ refused: boolean; name: string; address: string; pending: number }> {
  const found = await askList('svc', { context, allNamespaces: true });
  if (found.state === 'refused') return { refused: true, name: '', address: '', pending: 0 };
  let pending = 0;
  for (const svc of items(found)) {
    if (String(mapOf(svc.spec).type ?? '') !== 'LoadBalancer') continue;
    const status = mapOf(mapOf(svc.status).loadBalancer);
    // Every ingress entry is considered, not `[0]` alone: a provider that lists an
    // address-less entry first would otherwise read as a load balancer with no address.
    let found_address = '';
    for (const entry of listOf(status.ingress)) {
      const addr = String(entry.hostname ?? entry.ip ?? '').trim();
      if (addr !== '') {
        found_address = addr;
        break;
      }
    }
    if (found_address !== '') {
      return {
        refused: false,
        name: String(mapOf(svc.metadata).name ?? ''),
        address: found_address,
        pending,
      };
    }
    pending += 1;
  }
  return { refused: false, name: '', address: '', pending };
}

/** `[service name, address]` for the first LoadBalancer Service that has one. */
export async function loadbalancerService(context = CONTEXT): Promise<[string, string]> {
  const [name, address] = await loadbalancerState(context);
  return [name, address];
}

/**
 * How long `waitForLoadbalancer` will wait for a provider to publish an address. An AWS
 * ELB/NLB commonly takes one to three minutes; k3s ServiceLB is immediate.
 */
export const LOADBALANCER_TRIES = 60;

export const LOADBALANCER_INTERVAL = 3.0;

/**
 * `[service name, address]` once a provider has published one, or `['', '']`.
 *
 * `loadbalancerService` asks once, which is right for a report. It is wrong for `cluster
 * prepare`, which runs immediately after a 20-minute create and whose CNAME target is the
 * one line an operator needs: an ELB commonly takes one to three minutes, so the normal
 * outcome of a successful create was a blank CNAME target.
 *
 * A BLANK IS STILL A REAL ANSWER at the end of the wait, and the caller must not print it
 * as though it were a hostname. This only stops "not yet" being reported as "none".
 */
export async function waitForLoadbalancer(
  context: string,
  { emit = nullEmit, sleep = realSleep }: { emit?: Emit; sleep?: Sleep } = {},
): Promise<[string, string]> {
  let said = false;
  for (let attempt = 0; attempt < LOADBALANCER_TRIES; attempt += 1) {
    const [name, address, pending] = await loadbalancerState(context);
    if (address !== '') return [name, address];
    if (pending === 0) {
      // NOTHING IS PENDING. No LoadBalancer Service is waiting on an address, so no amount
      // of waiting will produce one, and spending three minutes proving it would be the
      // slowest possible way to say "there is no ingress here".
      return ['', ''];
    }
    if (!said) {
      info(
        emit,
        `waiting for ${String(pending)} load balancer(s) to be given an address — a cloud ` +
          'provider takes a minute or two',
        { phase: 'provision' },
      );
      said = true;
    }
    if (attempt < LOADBALANCER_TRIES - 1) await sleep(LOADBALANCER_INTERVAL);
  }
  return ['', ''];
}

/**
 * Evidence that a LoadBalancer works here, phrased for the report, or ''.
 *
 * EVIDENCE, not a capability claim: "no address" means either no controller or nobody asked
 * for one, and those cannot be told apart from outside.
 */
export async function loadbalancerAddress(context = CONTEXT): Promise<string> {
  const [name, addr] = await loadbalancerService(context);
  return addr !== '' ? `${name} has ${addr}` : '';
}

/**
 * Where the edge dials to reach one cluster's ingress. The one new seam.
 *
 * Both sources are first-class, and which one is available is a fact about the cluster
 * rather than a preference: a LoadBalancer address that is not one of this host's own
 * (kind with MetalLB, or any remote cluster); a LoadBalancer address that IS one of this
 * host's own (k3s's ServiceLB, still dialable but also receiving on a port the edge thinks
 * it owns, which is why `local` is reported rather than hidden); or a NodePort, when there
 * is no LoadBalancer address at all.
 *
 * `source` and `service` exist so a message can name what was chosen and where it came
 * from. Nothing branches on `source`; that is the point of having a seam.
 */
export interface IngressEndpoint {
  readonly address: string;
  readonly port: number;
  /** "loadbalancer" | "nodeport" -- for the sentence, never for a branch. */
  readonly source: string;
  /** `namespace/name` of the Service this came from. */
  readonly service: string;
  /** Whether `address` is one of THIS host's own addresses. */
  readonly local: boolean;
}

export function endpointString(endpoint: IngressEndpoint): string {
  return `${endpoint.address}:${String(endpoint.port)}`;
}

/**
 * How a Service that fronts an ingress controller is recognised. There is no Kubernetes
 * link from an IngressClass to the Service that serves it -- the class names a CONTROLLER
 * string and nothing else -- so this is inferred, and the inference is stated.
 *
 * Two conditions, and the second is what makes it defensible. It must publish 443, and it
 * must be REACHABLE FROM OUTSIDE THE CLUSTER. A ClusterIP is not merely unrouted from a
 * Docker container but unroutable: a virtual IP realised by kube-proxy's netfilter rules on
 * the node, measured answering `000` from the host.
 *
 * Port alone was tried first and was wrong on the very first real cluster: k3s answers with
 * THREE Services on 443 -- the API server, metrics-server and traefik -- and only the last
 * is the ingress. Both of the others are ClusterIP.
 */
export const INGRESS_PORT = 443;

/** Service types that can be reached from outside the cluster at all. */
export const REACHABLE_SERVICE_TYPES: readonly string[] = ['LoadBalancer', 'NodePort'];

/**
 * An address a node answers on, for the NodePort case, or ''.
 *
 * InternalIP, and deliberately not ExternalIP: this is dialled from the edge, a container
 * on the same box, so the routable answer is the one on the cluster's own network.
 */
export async function nodeAddress(context = CONTEXT): Promise<string> {
  const seen = require_(await askList('nodes', { context }), 'nodes', { context });
  for (const node of items(seen)) {
    for (const entry of listOf(mapOf(node.status).addresses)) {
      if (entry.type === 'InternalIP' && String(entry.address ?? '') !== '') {
        return String(entry.address);
      }
    }
  }
  return '';
}

/**
 * Whether `ip` is one of THIS host's own addresses.
 *
 * Bind is the test, because bind is the question: a socket can only bind an address the
 * host holds. Cheaper and more portable than parsing `ip addr`, and it is the same check
 * the kernel would make.
 */
export function isLocalAddress(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: ip, port: 0 }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * The address the edge passes TLS through to, or null if this cluster has none.
 *
 * null means the cluster ANSWERED and has no Service fronting `port`. A read that could not
 * be made raises instead, through `require_` -- because "I could not ask" and "there is no
 * ingress here" would send a caller to two completely different places.
 */
export async function ingressEndpoint(
  context = CONTEXT,
  { port = INGRESS_PORT }: { port?: number } = {},
): Promise<IngressEndpoint | null> {
  const svcs = require_(await askList('svc', { context, allNamespaces: true }), 'Services', {
    context,
  });
  const fronting: { where: string; kind: string; addr: string; nodePort: number | null }[] = [];
  for (const svc of items(svcs)) {
    const spec = mapOf(svc.spec);
    if (!REACHABLE_SERVICE_TYPES.includes(String(spec.type ?? ''))) continue;
    const ports = listOf(spec.ports).filter((entry) => entry.port === port);
    if (ports.length === 0) continue;
    const meta = mapOf(svc.metadata);
    const where = `${String(meta.namespace ?? 'default')}/${String(meta.name ?? '?')}`;
    const ingress = listOf(mapOf(mapOf(svc.status).loadBalancer).ingress);
    const addr = ingress.length > 0 ? String(ingress[0]?.ip ?? ingress[0]?.hostname ?? '') : '';
    const withNodePort = ports.find((entry) => typeof entry.nodePort === 'number');
    fronting.push({
      where,
      kind: String(spec.type ?? ''),
      addr,
      nodePort: withNodePort === undefined ? null : (withNodePort.nodePort as number),
    });
  }
  if (fronting.length === 0) return null;
  if (fronting.length > 1) {
    // NOT a guess. Picking the first would work on every cluster anybody has tested and
    // silently serve the wrong ingress on the one that matters.
    throw new ConflictError(
      `cluster '${context}' has ${String(fronting.length)} externally-reachable Services ` +
        `publishing :${String(port)} (${fronting.map((entry) => entry.where).join(', ')}), so ` +
        'which one fronts the ingress cannot be told from Kubernetes -- an IngressClass ' +
        'names a controller, never a Service. Reach this workspace on its port-forward ' +
        'instead, or remove the ambiguity in the cluster.',
    );
  }
  const only = fronting[0] as {
    where: string;
    kind: string;
    addr: string;
    nodePort: number | null;
  };
  if (only.addr !== '') {
    return {
      address: only.addr,
      port,
      source: 'loadbalancer',
      service: only.where,
      local: await isLocalAddress(only.addr),
    };
  }
  if (only.nodePort !== null) {
    const node = await nodeAddress(context);
    if (node !== '') {
      return {
        address: node,
        port: only.nodePort,
        source: 'nodeport',
        service: only.where,
        local: await isLocalAddress(node),
      };
    }
  }
  return null;
}

/**
 * The Docker container holding a kind cluster's node, or '' if not kind.
 *
 * A pure derivation, no I/O and no `docker` -- `runner` and `edge` own that seam and this
 * module must not grow a second one. kind names its context `kind-<cluster>` and its single
 * node container `<cluster>-control-plane`.
 *
 * This exists because a kind cluster's ingress NodePort is on kind's own Docker network:
 * reachable from the host, and not from a container on the default bridge.
 */
export function kindNodeContainer(context: string): string {
  if (!context.startsWith('kind-')) return '';
  const cluster = context.slice('kind-'.length);
  return cluster === '' ? '' : `${cluster}-control-plane`;
}

/**
 * A cluster holding one of THIS host's ports through a LoadBalancer Service.
 *
 * The failure this exists to name is silent by construction. k3s's ServiceLB claims a host
 * port with a `hostPort`, which is CNI portmap DNAT and not a socket bind -- so nothing
 * conflicts, no pod fails, `ss` shows only docker-proxy, and `docker ps` shows nothing at
 * all because k3s runs on containerd under systemd. houston's edge then binds :80 and :443
 * perfectly happily and never receives a packet on either. Measured on the box where it
 * took a manager's GUI dark for two days.
 *
 * `ports` is what the Service asks for, so both :80 and :443 are visible. That distinction
 * is the whole diagnosis on an ACME failure: :443 taken breaks TLS-ALPN and serving, :80
 * taken breaks HTTP-01.
 */
export interface PortClaim {
  readonly context: string;
  readonly service: string;
  readonly address: string;
  readonly ports: number[];
}

/**
 * The LoadBalancer Service in `context` claiming ports on this host, or null.
 *
 * `-o json` rather than a jsonpath because three facts are wanted per Service -- the
 * address, the ports and where it lives -- and a jsonpath that emits three lists leaves the
 * caller re-associating them by position.
 */
export async function hostPortClaim(
  context: string,
  timeout = PROBE_TIMEOUT,
): Promise<PortClaim | null> {
  const res = await kube.run(['kubectl', '--context', context, 'get', 'svc', '-A', '-o', 'json'], {
    own: isOurs(context),
    timeout,
  });
  if (res.returncode !== 0) return null;
  let rows: Record<string, unknown>[];
  try {
    rows = listOf(mapOf(JSON.parse(res.stdout || '{}')).items);
  } catch {
    return null;
  }
  for (const svc of rows) {
    const spec = mapOf(svc.spec);
    if (spec.type !== 'LoadBalancer') continue;
    const ingress = listOf(mapOf(mapOf(svc.status).loadBalancer).ingress);
    const addr = ingress.length > 0 ? String(ingress[0]?.ip ?? ingress[0]?.hostname ?? '') : '';
    // A LoadBalancer with no address, or one on an address this host does not hold, takes
    // nothing from anybody -- that is a cloud provider's job or a controller that never
    // answered.
    if (addr === '' || !(await isLocalAddress(addr))) continue;
    const ports = [
      ...new Set(
        listOf(spec.ports)
          .map((entry) => entry.port)
          .filter((value): value is number => typeof value === 'number'),
      ),
    ].sort((left, right) => left - right);
    if (ports.length === 0) continue;
    const meta = mapOf(svc.metadata);
    return {
      context,
      service: `${String(meta.namespace ?? 'default')}/${String(meta.name ?? '?')}`,
      address: addr,
      ports,
    };
  }
  return null;
}

/**
 * The first reachable cluster claiming any of `ports` on this host, or null.
 *
 * Both candidates are checked, and the one houston USES is not the interesting one: on the
 * box where this was measured houston was on kind, which has no LoadBalancer at all, while
 * the k3s alongside it held the ports.
 *
 * `timeout` exists because this also runs on the `edge start` path, where it is a WARNING
 * and must cost nearly nothing. The no-kubectl exit comes first for the same reason: a
 * Docker-only box must not pay for this at all.
 *
 * LIMIT, STATED RATHER THAN LEFT TO BE DISCOVERED: only LoadBalancer Services are
 * inspected. A DaemonSet with a hostPort on 80/443 would claim the ports and not be found
 * here. Default k3s uses a LoadBalancer, which is the case that took a manager's GUI dark.
 */
export async function portClaimingCluster({
  ports = [80, 443],
  contexts = [],
  timeout = PROBE_TIMEOUT,
}: {
  ports?: readonly number[];
  contexts?: readonly string[];
  timeout?: number;
} = {}): Promise<PortClaim | null> {
  if (which('kubectl') === '') return null;
  const candidates =
    contexts.length > 0 ? [...new Set(contexts)] : [...new Set([CONTEXT, await activeContext()])];
  for (const ctx of candidates) {
    if (ctx === '' || !(await reachable(ctx, timeout))) continue;
    const claim = await hostPortClaim(ctx, timeout);
    if (claim !== null && claim.ports.some((port) => ports.includes(port))) return claim;
  }
  return null;
}
