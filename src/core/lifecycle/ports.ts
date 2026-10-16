/**
 * Which host ports a workspace may take, and picking one without racing.
 *
 * Tier 1. Creates hold `withPortPublication` across checking every requested port and
 * publishing their workspace record. Choosing a port alone does not reserve it.
 */
import * as config from '../../lib/config';
import { ConflictError, ValidationError } from '../../lib/errors';
import { namesOf } from '../../lib/presets/composite';
import { type Preset } from '../../lib/presets/types';
import { reproLock } from '../runner/locks';
import * as paths from '../runner/paths';
import * as portSeam from '../runner/ports';
import {
  extraBag,
  hasComposeInstancePorts,
  type Metadata,
  listMeta,
  readMeta,
} from '../runner/record';

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
  return claimedPorts(meta);
}

/** Every recorded publication participates, regardless of which service requested it. */
function claimedPorts(meta: Metadata): Set<number> {
  const own = new Set<number>([meta.hostPort]);
  const extra = extraBag(meta);
  const n = extra.instances;
  if (hasComposeInstancePorts(meta) && typeof n === 'number' && Number.isInteger(n) && n > 1) {
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

/** A workspace already holding side ports another wants, and which of them. */
export interface SideHolder {
  name: string;
  ports: number[];
}

/**
 * Walk the records once: the first workspace but `exclude` holding any of `wanted`,
 * and `exclude`'s own allocation. ONE loop, so the refusal `checkSidecarPorts` makes and
 * the question `sidecarHolder` answers before it cannot disagree.
 */
async function sideClaims(
  wanted: ReadonlySet<number>,
  exclude: string,
): Promise<{ held: SideHolder | null; own: Set<number> }> {
  let own = new Set<number>();
  for (const meta of await listMeta()) {
    const claimed = claimedPorts(meta);
    if (meta.name === exclude) {
      own = claimed;
      continue;
    }
    const overlap = [...claimed].filter((value) => wanted.has(value)).sort((a, b) => a - b);
    if (overlap.length > 0) return { held: { name: meta.name, ports: overlap }, own };
  }
  return { held: null, own };
}

/**
 * Who already holds a requested host port, or null. A preset name (including a combination)
 * uses the registry ports; a resolved port list also covers parameter-dependent services.
 * Asked BEFORE a create, by a restore as new: finding a conflict after a job has already
 * started is too late to be useful. `exclude` permits an existing workspace's own allocation.
 */
export async function sidecarHolder(
  preset: string | readonly number[],
  exclude = '',
): Promise<SideHolder | null> {
  const wanted = new Set(
    typeof preset === 'string'
      ? namesOf(preset).flatMap((name) => config.PRESET_PORTS[name] ?? [])
      : preset,
  );
  if (wanted.size === 0) return null;
  return (await sideClaims(wanted, exclude)).held;
}

export async function checkSidecarPorts(pre: Preset, exclude = ''): Promise<void> {
  if (pre.ports.length === 0) return;
  const wanted = new Set(pre.ports);
  const { held, own } = await sideClaims(wanted, exclude);
  if (held !== null) {
    throw new ConflictError(
      `preset '${pre.name}' publishes port(s) ${portList(held.ports)}, already claimed ` +
        `by repro '${held.name}' - delete it first: houston down --name ${held.name} --volumes`,
    );
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
    const claimed = claimedPorts(meta);
    if (meta.name === exclude) {
      own = claimed;
      continue;
    }
    const overlap = [...claimed].filter((value) => wanted.has(value)).sort((a, b) => a - b);
    if (overlap.length > 0) {
      const recordedMonitoring = extraBag(meta).monitoring_ports;
      const monitoring = Array.isArray(recordedMonitoring) ? recordedMonitoring : [];
      const onlyMonitoring = overlap.every((port) =>
        monitoring.some((value) => digits(value) === port),
      );
      throw new ConflictError(
        `monitoring needs port(s) ${portList(overlap)}, already used by repro ` +
          (onlyMonitoring
            ? `'${meta.name}' (its monitoring) - stop it first: houston monitor --name ${meta.name} --off`
            : `'${meta.name}' - delete it first: houston down --name ${meta.name} --volumes`),
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
 * The home-wide lock name port allocation serialises on.
 *
 * `reproLock` is PER REPRO, and two creates for two different names hold two different
 * locks -- so both could read `usedPorts()`, see the same gap and pick the same port, and
 * the heavy pool allows at least two creates at once by design. A box-wide name (no
 * workspace is called this; `requireValidName` would reject the leading underscore) makes
 * allocation the one cross-workspace critical section in a shared server's home.
 */
export const PORT_LOCK = '_ports';

/**
 * Check and publish the complete allocation before another workspace can choose.
 *
 * The existing workspace record is the claim: no new reservation format or abandoned
 * claim file is introduced. A failure before publication releases the native lock;
 * after publication, a partial workspace retains its claim until safe teardown.
 * Actual deployment and readiness must run outside this section.
 */
export async function withPortPublication<T>(publish: () => Promise<T>): Promise<T> {
  return await reproLock(PORT_LOCK, publish, { timeoutMs: INTERACTIVE_LOCK_WAIT * 1000 });
}

/**
 * Choose a free host port. Creates retain the enclosing publication lock after this
 * nested, reentrant choice until their side/monitoring/RC claims are visible.
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
    // A legacy duplicate record is another claim even when this workspace claims
    // the same number. Excluding one's own record must not erase somebody else's.
    for (const meta of await listMeta()) {
      if (meta.name !== exclude) {
        for (const claimed of claimedPorts(meta)) used.add(claimed);
      }
    }
    for (let candidate = port; candidate < port + span; candidate += 1) {
      // An instance's own port on one of this workspace's fixed side ports (saml's 8081,
      // ldap's 8082...): both would be published on it, and only one can be.
      if (pre.ports.includes(candidate)) {
        if (candidate === port) {
          throw new ConflictError(
            `--port ${String(port)} is also a port this workspace's presets or monitoring publish. Pick a different --port.`,
          );
        }
        throw new ConflictError(
          `--port ${String(port)}: instance port ${String(candidate)} is also a port this ` +
            "workspace's presets publish. Pick a --port whose next " +
            `${String(span - 1)} ports avoid ${pre.ports.join(', ')}.`,
        );
      }
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
    let start = 3000;
    for (;;) {
      const candidate =
        span > 1 ? await portSeam.pickPortRange(span, start) : await portSeam.pickPort(start);
      if (!pre.ports.some((side) => side >= candidate && side < candidate + span)) return candidate;
      start = candidate + 1;
      if (start + span - 1 > portSeam.PORT_MAX)
        throw new Error('no free allocation avoids the preset ports');
    }
  } catch (error) {
    throw new ConflictError(error instanceof Error ? error.message : String(error));
  }
}
