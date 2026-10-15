/**
 * What Docker holds for a workspace: its containers with the ports they publish, and the
 * networks and volumes compose made for its project.
 *
 * The port bindings are the point. `info` lists containers by state; it does not say
 * WHERE a container listens, and `127.0.0.1:3000->3000/tcp` against `0.0.0.0:3000` is the
 * whole difference between "open it in your browser" and "you need a tunnel". Every read
 * here preserves the difference between `[]` and an unreadable daemon. A person choosing a
 * route to a workspace must not see "no published ports" when Docker did not answer at all.
 */
import { stripText } from '../../lib/float-text';
import { splitTextLines } from '../../lib/format';
import { JsonSyntaxError, loads } from '../../lib/json-text';
import { docker } from '../../seams/docker-cli';
import { Interrupted } from '../../seams/exec';

import * as engine from './engine';
import { projectName } from './record';

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The rows of `compose ps --format json`: one array on current compose, NDJSON on older.
 *
 * `null` means Compose returned a JSON shape this reader cannot safely call an inventory.
 * Silently dropping a bad NDJSON row would turn a daemon's malformed answer into an empty
 * list, which is indistinguishable from a workspace with no containers.
 */
function rowsOf(raw: string): Record<string, unknown>[] | null {
  const trimmed = stripText(raw);
  if (trimmed === '') return [];
  const decodeFailed = (error: unknown): boolean =>
    error instanceof JsonSyntaxError || error instanceof SyntaxError;
  try {
    const document: unknown = loads(trimmed);
    if (isMapping(document)) return [document];
    return Array.isArray(document) && document.every(isMapping) ? document : null;
  } catch (error) {
    if (!decodeFailed(error)) throw error;
    const rows: Record<string, unknown>[] = [];
    for (const line of splitTextLines(trimmed)) {
      const stripped = stripText(line);
      if (stripped === '') continue;
      try {
        const row: unknown = loads(stripped);
        if (!isMapping(row)) return null;
        rows.push(row);
      } catch (lineError) {
        if (!decodeFailed(lineError)) throw lineError;
        return null;
      }
    }
    return rows;
  }
}

export interface PortBinding {
  /** The address the port is published on: `127.0.0.1`, `0.0.0.0`, `::`. */
  host_ip: string;
  host_port: number;
  container_port: number;
  protocol: string;
}

export interface ContainerRecord {
  service: string;
  name: string;
  state: string;
  status: string;
  ports: PortBinding[];
}

/** One inspection read: rows when known, otherwise a safe public warning. */
export interface InspectionRows<T> {
  rows: T[];
  warning: string | null;
}

export interface DockerInventory {
  containers: ContainerRecord[];
  networks: string[];
  volumes: string[];
  warnings: string[];
}

/**
 * The published ports of one `compose ps` row, from its `Publishers`.
 *
 * Compose lists every port a container EXPOSES there, published or not; an unpublished
 * one has `PublishedPort` 0 and no URL, and is not reachable from the host, so it is
 * left out. What remains is exactly what `docker ps` prints as `host->container`.
 */
export function portBindings(publishers: unknown): PortBinding[] {
  if (!Array.isArray(publishers)) return [];
  const bindings: PortBinding[] = [];
  for (const entry of publishers) {
    if (!isMapping(entry)) continue;
    const published = Number(entry.PublishedPort ?? 0);
    if (!Number.isInteger(published) || published <= 0) continue;
    bindings.push({
      host_ip: String(entry.URL ?? ''),
      host_port: published,
      container_port: Number(entry.TargetPort ?? 0),
      protocol: String(entry.Protocol ?? 'tcp'),
    });
  }
  return bindings.sort((left, right) => left.host_port - right.host_port);
}

/** One `compose ps --format json` row, as the inspection shows it. */
export function containerRecord(row: Record<string, unknown>): ContainerRecord {
  return {
    service: String(row.Service ?? ''),
    name: String(row.Name ?? ''),
    state: String(row.State ?? ''),
    status: String(row.Status ?? ''),
    ports: portBindings(row.Publishers),
  };
}

/** `host:port->port/proto`, the way `docker ps` spells one binding. */
export function bindingText(binding: PortBinding): string {
  const host = binding.host_ip.includes(':') ? `[${binding.host_ip}]` : binding.host_ip;
  return `${host}:${String(binding.host_port)}->${String(binding.container_port)}/${binding.protocol}`;
}

/** Every container of the workspace, stopped ones included. */
export async function containerRecords(name: string): Promise<InspectionRows<ContainerRecord>> {
  try {
    const result = await engine.compose(name, ['ps', '--all', '--format', 'json'], {
      capture: true,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      return { rows: [], warning: 'could not inspect workspace containers' };
    const rows = rowsOf(String(result.stdout ?? ''));
    if (rows === null) return { rows: [], warning: 'Docker returned invalid container JSON' };
    return {
      rows: rows
        .map(containerRecord)
        .sort((left, right) =>
          left.service < right.service ? -1 : left.service > right.service ? 1 : 0,
        ),
      warning: null,
    };
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return { rows: [], warning: 'could not inspect workspace containers' };
  }
}

/**
 * The names of the `kind` (`network` or `volume`) compose labelled with this workspace's
 * project. By LABEL, not by name prefix: the project name is what compose stamps on
 * everything it makes, and a volume someone named by hand to look like ours is not ours.
 */
async function labelled(name: string, kind: 'network' | 'volume'): Promise<InspectionRows<string>> {
  const project = await projectName(name);
  let stdout: string;
  try {
    const result = await docker(
      [
        kind,
        'ls',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--format',
        '{{.Name}}',
      ],
      { capture: true, timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) return { rows: [], warning: `could not inspect workspace ${kind}s` };
    stdout = String(result.stdout ?? '');
  } catch (error) {
    if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
    return { rows: [], warning: `could not inspect workspace ${kind}s` };
  }
  return {
    rows: splitTextLines(stdout)
      .map((line) => stripText(line))
      .filter((line) => line !== '')
      .sort(),
    warning: null,
  };
}

export async function networkNames(name: string): Promise<InspectionRows<string>> {
  return await labelled(name, 'network');
}

export async function volumeNames(name: string): Promise<InspectionRows<string>> {
  return await labelled(name, 'volume');
}

/**
 * The Docker side of `inspect`, with per-read warnings kept beside its empty arrays.
 *
 * A stopped workspace has known empty arrays. A stopped Docker daemon has the same arrays
 * plus a warning. Consumers must retain both facts rather than trying to infer one from the
 * other after this boundary.
 */
export async function dockerInventory(name: string): Promise<DockerInventory> {
  const [containers, networks, volumes] = await Promise.all([
    containerRecords(name),
    networkNames(name),
    volumeNames(name),
  ]);
  return {
    containers: containers.rows,
    networks: networks.rows,
    volumes: volumes.rows,
    warnings: [containers.warning, networks.warning, volumes.warning].filter(
      (warning): warning is string => warning !== null,
    ),
  };
}
