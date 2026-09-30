/**
 * Which host ports a workspace may take, and picking one without racing.
 *
 * Tier 1. `pickHostPort` holds a lock across the choose-and-claim window, because two `up`
 * runs that each found the same free port both bind it and the second fails with a message
 * about Docker rather than about the race that caused it.
 */
import * as config from '../../lib/config';
import { ConflictError, ValidationError } from '../../lib/errors';
import { type Preset } from '../../lib/presets/types';
import { reproLock } from '../runner/locks';
import * as paths from '../runner/paths';
import * as portSeam from '../runner/ports';
import { type Metadata, listMeta, readMeta } from '../runner/record';

import { INTERACTIVE_LOCK_WAIT } from './types';

/** A list of ports, spelled as the message has always spelled it: `[8081]`, `[9090, 5050]`. */
function portList(ports: readonly number[]): string {
  return `[${ports.map(String).join(', ')}]`;
}

/** An integer, or a string of ASCII digits read as one; anything else is null. */
function digits(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number.parseInt(value, 10);
  return null;
}

export async function ownPorts(name: string): Promise<Set<number>> {
  if (!name || !(await paths.exists(name))) return new Set();
  let meta: Metadata;
  try {
    meta = await readMeta(name);
  } catch {
    // half-written record
    return new Set();
  }
  const own = new Set<number>([meta.hostPort]);
  const extra = meta.extra;
  const n = extra.instances;
  if (typeof n === 'number' && Number.isInteger(n) && n > 1) {
    for (let i = 1; i <= n; i += 1) own.add(meta.hostPort + i);
  }
  // tls_ports too, or `up --force --https` on an existing repro would not recognise its
  // OWN TLS port as reusable and would drift to the next one -- leaking a port number on
  // every recreate, and changing the URL each time.
  for (const key of ['sidecar_ports', 'monitoring_ports', 'tls_ports']) {
    const claimed = extra[key];
    if (!Array.isArray(claimed)) continue;
    for (const value of claimed) {
      const port = digits(value);
      if (port !== null) own.add(port);
    }
  }
  return own;
}

export async function checkSidecarPorts(pre: Preset, exclude = ''): Promise<void> {
  if (pre.ports.length === 0) return;
  const wanted = new Set(pre.ports);
  let own = new Set<number>();
  for (const meta of await listMeta()) {
    const claimed = new Set<unknown>(
      Array.isArray(meta.extra.sidecar_ports) ? meta.extra.sidecar_ports : [],
    );
    if (meta.name === exclude) {
      own = new Set([...claimed].map(digits).filter((port): port is number => port !== null));
      continue;
    }
    const overlap = [...claimed]
      .filter((value): value is number => typeof value === 'number' && wanted.has(value))
      .sort((a, b) => a - b);
    if (overlap.length > 0) {
      throw new ConflictError(
        `preset '${pre.name}' publishes port(s) ${portList(overlap)}, already claimed ` +
          `by repro '${meta.name}' - delete it first: houston down --name ${meta.name} --volumes`,
      );
    }
  }
  for (const port of [...wanted].filter((p) => !own.has(p)).sort((a, b) => a - b)) {
    if (!(await portSeam.portFree(port))) {
      throw new ConflictError(
        `preset '${pre.name}' needs host port ${String(port)}, already in use on this machine`,
      );
    }
  }
}

export async function checkMonitorPorts(exclude = ''): Promise<void> {
  const wanted = new Set<number>(config.MONITOR_PORTS);
  let own = new Set<number>();
  for (const meta of await listMeta()) {
    const claimed = new Set<unknown>(
      Array.isArray(meta.extra.monitoring_ports) ? meta.extra.monitoring_ports : [],
    );
    if (meta.name === exclude) {
      own = new Set([...claimed].map(digits).filter((port): port is number => port !== null));
      continue;
    }
    const overlap = [...claimed]
      .filter((value): value is number => typeof value === 'number' && wanted.has(value))
      .sort((a, b) => a - b);
    if (overlap.length > 0) {
      throw new ConflictError(
        `monitoring needs port(s) ${portList(overlap)}, already used by repro ` +
          `'${meta.name}' (its monitoring) - stop it first: houston monitor --name ` +
          `${meta.name} --off`,
      );
    }
  }
  for (const port of [...wanted].filter((p) => !own.has(p)).sort((a, b) => a - b)) {
    if (!(await portSeam.portFree(port))) {
      throw new ConflictError(
        `monitoring needs host port ${String(port)}, already in use on this machine`,
      );
    }
  }
}

/**
 * The lock name port allocation serialises on.
 *
 * `reproLock` is PER REPRO, and two creates for two different names hold two different
 * locks -- so both could read `usedPorts()`, see the same gap and pick the same port, and
 * the heavy pool allows at least two creates at once by design. A box-wide name (no
 * workspace is called this; `requireValidName` would reject the leading underscore) makes
 * allocation the one cross-workspace critical section it has to be.
 */
export const PORT_LOCK = '_ports';

/**
 * Choose a free host port, serialised box-wide.
 *
 * Held only for the choice, not for the create: the window that matters is between
 * reading `usedPorts()` and the caller writing its own record, and the record is written
 * by `createRepro` while it still holds its own per-repro lock. Two locks rather than one,
 * because holding a box-wide lock across a whole create would serialise every concurrent
 * workspace and defeat the heavy pool entirely.
 */
export async function pickHostPort(port: number, pre: Preset, exclude = ''): Promise<number> {
  return await reproLock(PORT_LOCK, async () => await pickHostPortLocked(port, pre, exclude), {
    timeoutMs: INTERACTIVE_LOCK_WAIT * 1000,
  });
}

export async function pickHostPortLocked(port: number, pre: Preset, exclude = ''): Promise<number> {
  const span = pre.instances > 1 ? pre.instances + 1 : 1;
  if (port) {
    if (port + span - 1 > portSeam.PORT_MAX) {
      throw new ValidationError(
        `--port ${String(port)}: a ${String(pre.instances)}-instance repro needs ports ` +
          `up to ${String(port + span - 1)} (past 65535)`,
      );
    }
    const own = await ownPorts(exclude);
    const used = new Set(
      [...(await portSeam.usedPorts())].filter((usedPort) => !own.has(usedPort)),
    );
    for (let candidate = port; candidate < port + span; candidate += 1) {
      if (used.has(candidate)) {
        throw new ConflictError(
          `port ${String(candidate)} is already claimed by another repro (see \`houston list\`)`,
        );
      }
      if (!own.has(candidate) && !(await portSeam.portFree(candidate))) {
        throw new ConflictError(`port ${String(candidate)} is already in use on this machine`);
      }
    }
    return port;
  }
  try {
    return span > 1 ? await portSeam.pickPortRange(span) : await portSeam.pickPort();
  } catch (error) {
    throw new ConflictError(error instanceof Error ? error.message : String(error));
  }
}
