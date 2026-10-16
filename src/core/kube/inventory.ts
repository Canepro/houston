/**
 * The read-only Kubernetes inventory for `houston inspect`.
 *
 * A refused read is not an empty resource list. Inspection keeps whatever the cluster did
 * answer and records a warning for each unanswered question, so an RBAC denial or sleeping
 * API server cannot be rendered as “no nodes” or “no services”. Nothing here reads Secrets,
 * ConfigMaps, or container environments, and it never changes cluster state.
 */
import { Interrupted } from '../../seams/exec';

import { askList, present, type Answer } from './ask';
import { clusters } from './context';
import { CLUSTER_NAME, CONTEXT } from './names';
import { podRow, type PodRow } from './status';

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapOf(value: unknown): Record<string, unknown> {
  return isMapping(value) ? value : {};
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(mapOf) : [];
}

function hasName(item: Record<string, unknown>): boolean {
  return (
    isMapping(item.metadata) && typeof item.metadata.name === 'string' && item.metadata.name !== ''
  );
}

function validNode(item: Record<string, unknown>): boolean {
  return hasName(item);
}

const SERVICE_PORT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function validPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function validTargetPort(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return (
    validPortNumber(value) ||
    (typeof value === 'string' &&
      value.length <= 15 &&
      /[a-z]/u.test(value) &&
      SERVICE_PORT_NAME.test(value))
  );
}

function validProtocol(value: unknown): boolean {
  return (
    value === undefined || value === null || value === 'TCP' || value === 'UDP' || value === 'SCTP'
  );
}

function validNodePort(value: unknown): boolean {
  return value === undefined || value === null || validPortNumber(value);
}

function validServicePort(value: unknown): boolean {
  return (
    isMapping(value) &&
    validPortNumber(value.port) &&
    validTargetPort(value.targetPort) &&
    validProtocol(value.protocol) &&
    validNodePort(value.nodePort)
  );
}

function validService(item: Record<string, unknown>): boolean {
  if (!hasName(item) || !isMapping(item.spec)) return false;
  const ports = item.spec.ports;
  return (
    ports === undefined || ports === null || (Array.isArray(ports) && ports.every(validServicePort))
  );
}

function validPod(item: Record<string, unknown>): boolean {
  return hasName(item);
}

export interface NodeRecord {
  name: string;
  status: 'Ready' | 'NotReady';
  /** The `node-role.kubernetes.io/<role>` labels, sorted; [] on a kind or k3s worker. */
  roles: string[];
  /** The kubelet's version, which is the node's Kubernetes version. */
  version: string;
  ready: boolean;
  internal_ip: string;
  external_ip: string;
  os_image: string;
  kernel_version: string;
  container_runtime: string;
  created_at: string;
  /** Kubernetes quantities as the API spells them: `8`, `7910m`, `16298896Ki`. */
  allocatable_cpu: string;
  allocatable_memory: string;
}

export interface ServicePort {
  name: string;
  protocol: string;
  port: number;
  /** A number or a named port, so text either way. */
  target_port: string;
  /** Only a NodePort or LoadBalancer Service has one; null otherwise, never absent. */
  node_port: number | null;
}

export interface ServiceRecord {
  name: string;
  type: string;
  cluster_ip: string;
  /** `spec.externalIPs`, then every address the LoadBalancer has been given. */
  external_ips: string[];
  ports: ServicePort[];
}

export interface KubernetesInventory {
  context: string;
  namespace: string;
  /** null means Docker/kind could not be asked; false is an actual answer. */
  cluster_exists: boolean | null;
  nodes: NodeRecord[];
  services: ServiceRecord[];
  pods: PodRow[];
  warnings: string[];
}

const ROLE_LABEL = 'node-role.kubernetes.io/';

/** One node of a `kubectl get nodes -o json` document, as the inspection shows it. */
export function nodeRecord(item: Record<string, unknown>): NodeRecord {
  const metadata = mapOf(item.metadata);
  const status = mapOf(item.status);
  const info = mapOf(status.nodeInfo);
  const allocatable = mapOf(status.allocatable);
  const ready = listOf(status.conditions).some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
  const roles = Object.entries(mapOf(metadata.labels))
    .filter(([key, value]) => key.startsWith(ROLE_LABEL) && value !== null)
    .map(([key]) => key.slice(ROLE_LABEL.length))
    .filter((role) => role !== '')
    .sort();
  const addresses = Object.fromEntries(
    listOf(status.addresses)
      .map((address) => [String(address.type ?? ''), String(address.address ?? '')])
      .filter(([type]) => type !== ''),
  );
  return {
    name: String(metadata.name ?? ''),
    status: ready ? 'Ready' : 'NotReady',
    roles,
    version: String(info.kubeletVersion ?? ''),
    ready,
    internal_ip: String(addresses.InternalIP ?? ''),
    external_ip: String(addresses.ExternalIP ?? ''),
    os_image: String(info.osImage ?? ''),
    kernel_version: String(info.kernelVersion ?? ''),
    container_runtime: String(info.containerRuntimeVersion ?? ''),
    created_at: String(metadata.creationTimestamp ?? ''),
    allocatable_cpu: String(allocatable.cpu ?? ''),
    allocatable_memory: String(allocatable.memory ?? ''),
  };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonBlankText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

interface ServiceAddresses {
  external: string[];
  malformed: boolean;
}

/**
 * The addresses the Service response explicitly supplies. Preserve readable parts of a mixed
 * response, but leave a warning for any malformed collection or consumed entry so `[]` never
 * claims the API confirmed no externally reachable address.
 */
function serviceAddresses(item: Record<string, unknown>): ServiceAddresses {
  const spec = mapOf(item.spec);
  const external: string[] = [];
  let malformed = false;
  if (hasOwn(spec, 'externalIPs')) {
    if (!Array.isArray(spec.externalIPs)) malformed = true;
    else {
      for (const entry of spec.externalIPs) {
        const address = nonBlankText(entry);
        if (address === null) malformed = true;
        else external.push(address);
      }
    }
  }

  const status = item.status;
  if (status === undefined || status === null) return { external, malformed };
  if (!isMapping(status)) return { external, malformed: true };
  if (!hasOwn(status, 'loadBalancer')) return { external, malformed };
  const loadBalancer = status.loadBalancer;
  if (!isMapping(loadBalancer)) return { external, malformed: true };
  if (!hasOwn(loadBalancer, 'ingress')) return { external, malformed };
  const ingress = loadBalancer.ingress;
  if (!Array.isArray(ingress)) return { external, malformed: true };

  for (const entry of ingress) {
    if (!isMapping(entry)) {
      malformed = true;
      continue;
    }
    const hasIp = hasOwn(entry, 'ip');
    const hasHostname = hasOwn(entry, 'hostname');
    const ip = hasIp ? nonBlankText(entry.ip) : null;
    const hostname = hasHostname ? nonBlankText(entry.hostname) : null;
    if ((hasIp && ip === null) || (hasHostname && hostname === null)) malformed = true;
    if (ip !== null) external.push(ip);
    else if (hostname !== null) external.push(hostname);
    else malformed = true;
  }
  return { external, malformed };
}

function hasMalformedServiceAddresses(item: Record<string, unknown>): boolean {
  return serviceAddresses(item).malformed;
}

/** One Service of a `kubectl get services -o json` document, as the inspection shows it. */
export function serviceRecord(item: Record<string, unknown>): ServiceRecord {
  const metadata = mapOf(item.metadata);
  const spec = mapOf(item.spec);
  const ports = listOf(spec.ports).map((port) => ({
    name: String(port.name ?? ''),
    protocol: String(port.protocol ?? 'TCP'),
    port: Number(port.port ?? 0),
    target_port:
      port.targetPort === undefined || port.targetPort === null ? '' : String(port.targetPort),
    node_port: typeof port.nodePort === 'number' ? port.nodePort : null,
  }));
  const { external } = serviceAddresses(item);
  return {
    name: String(metadata.name ?? ''),
    type: String(spec.type ?? 'ClusterIP'),
    cluster_ip: String(spec.clusterIP ?? ''),
    external_ips: external,
    ports,
  };
}

function by<T>(rows: T[], nameOf: (row: T) => string): T[] {
  return rows.sort((left, right) => {
    const a = nameOf(left);
    const b = nameOf(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * A list response is known only when it has the collection shape kubectl promises.
 *
 * `askList` distinguishes a refused call from a present empty collection. It intentionally
 * keeps its API broad enough for callers that only care about a particular object, though,
 * so a syntactically valid but malformed list document can still reach this layer. That is
 * unknown, not an empty resource set: rendering it as `none` is the exact operational lie
 * this inventory exists to prevent.
 */
function listDocument(answer: Answer): Record<string, unknown>[] | null {
  if (!present(answer)) return null;
  const raw = answer.doc.items;
  if (
    !Array.isArray(raw) ||
    !raw.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
  ) {
    return null;
  }
  return raw as Record<string, unknown>[];
}

async function captured<T>(
  ask: () => Promise<Answer>,
  map: (record: Record<string, unknown>) => T,
  valid: (record: Record<string, unknown>) => boolean,
  sort: (row: T) => string,
  refusedWarning: string,
  malformedWarning: string,
  hasMalformedPartial: (record: Record<string, unknown>) => boolean = () => false,
): Promise<{ rows: T[]; warning: string | null }> {
  try {
    const answer = await ask();
    const records = listDocument(answer);
    if (records === null)
      return { rows: [], warning: present(answer) ? malformedWarning : refusedWarning };
    const accepted: T[] = [];
    let malformed = false;
    for (const record of records) {
      if (valid(record)) {
        accepted.push(map(record));
        if (hasMalformedPartial(record)) malformed = true;
      } else malformed = true;
    }
    return {
      rows: by(accepted, sort),
      warning: malformed ? malformedWarning : null,
    };
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return { rows: [], warning: refusedWarning };
  }
}

/**
 * Collect whatever can be read without treating a failure as an empty cluster.
 *
 * Context and namespace must have been recorded when the workspace was created. Falling back
 * to a current default could inspect a different cluster or namespace, so a missing value is
 * a warning and no Kubernetes command is issued.
 */
export async function inventory({
  context,
  namespace,
}: {
  context: string;
  namespace: string;
}): Promise<KubernetesInventory> {
  const result: KubernetesInventory = {
    context,
    namespace,
    cluster_exists: null,
    nodes: [],
    services: [],
    pods: [],
    warnings: [],
  };
  if (context === '' || namespace === '') {
    result.warnings.push('the repro has no recorded Kubernetes context or namespace');
    return result;
  }

  const kind =
    context === CONTEXT
      ? clusters().then(
          ([names, reason]) => ({
            exists: reason === '' ? names.includes(CLUSTER_NAME) : null,
            reason,
          }),
          (error: unknown) => {
            if (error instanceof Interrupted) throw error;
            return { exists: null, reason: 'could not inspect Kind cluster names' };
          },
        )
      : Promise.resolve({ exists: null, reason: '' });
  const [nodes, services, pods, local] = await Promise.all([
    captured(
      () => askList('nodes', { context }),
      nodeRecord,
      validNode,
      (node) => node.name,
      'could not inspect cluster nodes',
      'Kubernetes returned invalid node JSON',
    ),
    captured(
      () => askList('services', { context, namespace }),
      serviceRecord,
      validService,
      (service) => service.name,
      'could not inspect repro services',
      'Kubernetes returned invalid service JSON',
      hasMalformedServiceAddresses,
    ),
    captured(
      () => askList('pods', { context, namespace }),
      podRow,
      validPod,
      (pod) => pod.service,
      'could not inspect repro pods',
      'Kubernetes returned invalid pod JSON',
    ),
    kind,
  ]);
  result.nodes = nodes.rows;
  result.services = services.rows;
  result.pods = pods.rows;
  result.cluster_exists = local.exists;
  for (const entry of [nodes.warning, services.warning, pods.warning]) {
    if (entry !== null) result.warnings.push(entry);
  }
  if (local.reason !== '') result.warnings.push('could not inspect Kind cluster names');
  return result;
}
