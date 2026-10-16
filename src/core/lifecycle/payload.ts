/**
 * `detail` -- the one payload the GUI renders a whole panel from -- and its helpers.
 *
 * Tier 3, and its own module on purpose. The browser suite's fixture is a hand-written copy
 * of this shape; when the two drift the panel breaks in production with the entire suite
 * green. One file is what the fixture-vs-real invariant test points at.
 */
import * as fs from 'node:fs';
import { isIP } from 'node:net';

import * as config from '../../lib/config';
import { storedText, toText } from '../../lib/format';
import { pathExpandUser } from '../../lib/home';
import { redactEnv } from '../../lib/redact';
import { CONTEXT as KUBE_CONTEXT } from '../kube/names';
import { podRows } from '../kube/status';
import { dockerAvailable } from '../runner/host';
import { containerDetails, rcRestartCount } from '../runner/queries';
import { type Metadata, readCompose, readMeta } from '../runner/record';
import * as paths from '../runner/paths';
import * as topology from '../topology';

import * as inspect from './inspect';
import * as naming from './naming';
import { LAST_BACKUP_KEY, UPGRADE_FROM_KEY } from './types';

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * ISO 8601 extended-format parsing with a required offset, NOT `Date.parse`.
 *
 * `Date.parse` accepts `"2026"` and `"Mar 5 2020"`, which have always been refused. An
 * offset is required here; a naive stamp has always been a failure of `now() - then`, and
 * returning "" is the safe direction for a read path that must not take the panel down.
 *
 * THREE SHAPES ARE DELIBERATELY NOT REPRODUCED, all measured against the previous
 * implementation:
 *
 *   `2026-01-01T00:00:00`      a NAIVE time there, and the subtraction then throws a
 *                              TypeError out of `detail()`; this answers "".
 *   `2026-01-01T00:00:00+01`   a whole-hour offset is accepted there; this answers "".
 *   `20260101T000000Z`         the ISO basic format is accepted there; this answers "".
 *
 * None is a shape Kubernetes emits: a pod `startTime` is RFC 3339 with a colon-bearing
 * offset, `metav1.Time` marshals it that way, and every such value agrees exactly. The
 * refusal direction is "an age we could not read", never a wrong one.
 */
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/u;

function parseIso(iso: string): number | null {
  const match = ISO_RE.exec(iso);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second = '0', fraction = '0', zone] = match;
  const millis = Number(`0.${fraction}`) * 1000;
  const offset = zone === 'Z' ? 0 : zoneToMinutes(zone as string);
  if (offset === null) return null;
  const at = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millis,
  );
  return at - offset * 60_000;
}

function zoneToMinutes(zone: string): number | null {
  const match = /^([+-])(\d{2}):?(\d{2})$/u.exec(zone);
  if (match === null) return null;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * An ISO timestamp -> docker's phrasing for how long ago it was ("2 hours").
 *
 * The panel's Uptime cell is filled from docker's own `Status` string on Compose; on
 * Kubernetes the same cell has to be built from a pod's startTime, and it has to read the
 * SAME way. Two vocabularies in one column is how a reader stops trusting the column.
 */
export function since(iso: string, now = Date.now()): string {
  if (!iso) return '';
  const then = parseIso(iso);
  if (then === null) return '';
  const secs = (now - then) / 1000;
  if (secs < 0) return '';
  const units: readonly [string, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    const n = Math.floor(secs / size);
    if (n) return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
  }
  const n = Math.floor(secs);
  return `${String(n)} second${n === 1 ? '' : 's'}`;
}

/**
 * The address this workspace publishes its ports ON, for the panel's remote-access
 * notice. "" means genuinely unknown.
 *
 * Recorded in the metadata at create time. Read back out of the generated compose file
 * for workspaces made before it was recorded, so a workspace that already exists gets the
 * accurate notice rather than the hedged one.
 */
export async function bindHostOf(meta: Metadata): Promise<string> {
  const extra = bag(meta.extra);
  const recorded = toText(extra.bind_host);
  if (recorded) return recorded;
  if (topology.ofMeta(meta) === topology.KUBERNETES) {
    // Kubernetes has recorded it from the first workspace it ever made, so an absence
    // here is not "older than the key" -- there is nothing to recover.
    return '';
  }
  let doc: Record<string, unknown>;
  try {
    doc = await readCompose(meta.name);
  } catch {
    // no file, or half-written; unknown is fine
    return '';
  }
  const services = bag(doc.services);
  const rc = bag(services.rocketchat ?? services['rocketchat-1']);
  const ports = Array.isArray(rc.ports) ? rc.ports : [];
  for (const port of ports) {
    // Interpolated mappings cannot establish an observed address without evaluation.
    if (typeof port !== 'string' || port.includes('$')) continue;
    // The two rightmost fields are the ports. A legacy IPv6 address can be bracketed or
    // bare, but a malformed bracketed address must remain unknown rather than becoming `[`.
    const published = port.replace(/\/(?:tcp|udp|sctp)$/iu, '');
    const parts = published.split(':');
    if (parts.length < 3) continue;
    const address = parts.slice(0, -2).join(':');
    const bracketed = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : '';
    if (isIP(bracketed) === 6) return bracketed;
    if (isIP(address) !== 0) return address;
  }
  return '';
}

/**
 * The RC service's env as [{key, value, override}], credentials masked.
 *
 * `override` marks the keys the user set with `env --set`, so the panel can tell those
 * apart from the preset/base defaults -- "remove" means a different thing for each.
 */
export function envRows(
  doc: Record<string, unknown>,
  overrides: Record<string, unknown> | null = null,
): { key: string; value: string; override: boolean }[] {
  const own = new Set(Object.keys(overrides ?? {}));
  const svcs = bag(doc.services);
  const rc = bag(svcs.rocketchat ?? svcs['rocketchat-1']);
  const env = rc.environment;
  let pairs: [unknown, unknown][];
  if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
    pairs = Object.entries(env).map(([key, value]) => [key, value]);
    // Sorted by key and then by value.
    pairs.sort((left, right) => {
      const a = String(left[0]);
      const b = String(right[0]);
      if (a !== b) return a < b ? -1 : 1;
      const x = String(left[1] ?? '');
      const y = String(right[1] ?? '');
      return x < y ? -1 : x > y ? 1 : 0;
    });
  } else if (Array.isArray(env)) {
    // compose list form "K=V", in the order the file declares -- split at the first `=` and
    // nothing sorted, as it always has been.
    pairs = env.map((entry) => {
      const text = String(entry);
      const at = text.indexOf('=');
      return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
    });
  } else {
    return [];
  }
  // `storedText` of each value: these are the environment the container is given, so they
  // read as the compose file holds them and as `houston env` reports them -- a hand-edited
  // bare `yes`, `~` or `.inf` is `True`, `None` and `inf`, where `String(value ?? '')` said
  // `true`, `` and `Infinity`.
  return pairs.map(([key, value]) => ({
    key: String(key),
    value: redactEnv(String(key), storedText(value)),
    override: own.has(String(key)),
  }));
}

/**
 * The recorded `env` when `extra` is a mapping, else null: a record whose `extra` is
 * null or not an object has no recorded env, where `meta.extra.env` read through the null
 * and `info --json` ended in a TypeError stack.
 */
function recordedEnv(meta: Metadata): Record<string, unknown> | null {
  const extra: unknown = meta.extra;
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return null;
  const env = (extra as Record<string, unknown>).env;
  return typeof env === 'object' && env !== null ? (env as Record<string, unknown>) : null;
}

/**
 * The panel for a workspace that has pods rather than containers.
 *
 * BOTH READS AT ONCE: two independent reads of the same namespace, and on a managed
 * cluster each is a round trip. The dependency below is only ever used to SKIP work,
 * never to change what is asked, so starting both and discarding one is safe.
 */
export async function kubernetesDetail(
  d: Record<string, unknown>,
  meta: Metadata,
  target: string,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const context = isTruthy(extra[config.EXTRA_CONTEXT])
    ? String(extra[config.EXTRA_CONTEXT])
    : KUBE_CONTEXT;
  // Both at once -- and the pod read's answer is only ASKED FOR when the workspace is not
  // down. `Promise.all` asked for both, so a pod read that failed on a down workspace -- no
  // namespace to list, a metrics API that is gone -- failed `info` with a TypeError stack
  // where the established answer reports the workspace down. Settled either way before
  // this returns, so nothing is left running behind it.
  const pods = podRows(target, { context }).then(
    (rows) => ({ rows, failure: null as unknown }),
    (failure: unknown) => ({ rows: [] as Awaited<ReturnType<typeof podRows>>, failure }),
  );
  let state: string;
  try {
    state = await inspect.kubernetesState(target, meta);
  } finally {
    await pods;
  }
  d.state = state;
  // Pods, in the containers tab's own three columns. This block used to be deliberately
  // empty on the reasoning that invented rows would be a plausible wrong answer -- true,
  // but these are not invented, and the empty list was itself a wrong answer.
  if (state === 'down') d.containers = [];
  else {
    const read = await pods;
    if (read.failure !== null) throw read.failure;
    d.containers = read.rows;
  }
  // Uptime from the earliest RUNNING pod, which is as close as this runtime gets to the
  // workspace's own uptime.
  const started = (d.containers as Awaited<ReturnType<typeof podRows>>)
    .filter((row) => row.state === 'running' && row.started !== '')
    .map((row) => row.started)
    .sort();
  d.uptime = started.length > 0 ? since(started[0] as string) : '';
  // Health stays empty on purpose: the kv falls back to the state, which here already
  // distinguishes starting/running/stopped.
  d.health = '';
  // ROCKET.CHAT'S OWN restart count, which this branch never set -- so the panel's restart
  // cell and the triage rule that reads it were both dead on Kubernetes.
  d.restarts = (d.containers as Awaited<ReturnType<typeof podRows>>).reduce(
    (most, row) => (row.app ? Math.max(most, Number(row.restarts) || 0) : most),
    0,
  );
  // LINKS ARE NOT COMPOSE-SHAPED, and leaving them out of this branch cost the panel every
  // address a scenario publishes.
  d.links = inspect.reproLinks(meta);
  d.namespace = String(extra.namespace ?? '');
  return d;
}

/** The panel for a workspace that has containers. */
export async function composeDetail(
  d: Record<string, unknown>,
  meta: Metadata,
  target: string,
): Promise<Record<string, unknown>> {
  // `containerDetails` returns [] both for "no containers" AND for "docker could not be
  // asked", so deriving state from it alone asserted `down` whenever the daemon was
  // unreachable -- while `listRepros` reported "?" for the same repro.
  if (!(await dockerAvailable())) {
    d.state = '?';
    d.uptime = '';
    d.health = '';
    d.containers = [];
    d.links = inspect.reproLinks(meta);
    d.env = envRows(await readCompose(target), recordedEnv(meta));
    return d;
  }
  const containers = await containerDetails(target);
  const rc = containers.filter(
    (c) => c.service === 'rocketchat' || c.service.startsWith('rocketchat-'),
  );
  const rcStatus = rc[0]?.status ?? '';
  d.state = inspect.reproState(rcStatus, containers.length > 0);
  const [up, health] = inspect.uptimeHealth(rcStatus);
  d.uptime = up;
  // The SAME rule the list uses, so the summary can no longer contradict the containers
  // array printed directly beneath it.
  const services: Record<string, string> = {};
  for (const container of containers) services[container.service] = container.status;
  d.degraded = d.state === 'running' ? inspect.degradedReason(services) : '';
  d.health = isTruthy(d.degraded) ? 'degraded' : health || (d.state !== 'down' ? d.state : '');
  // A climbing restart count is the difference between "slow to boot" and
  // "crash-looping"; only asked when containers exist -- it costs two docker calls.
  if (containers.length > 0) d.restarts = await rcRestartCount(target);
  d.links = inspect.reproLinks(meta);
  d.containers = containers;
  d.env = envRows(await readCompose(target), recordedEnv(meta));
  return d;
}

/**
 * The version a rollback of the last upgrade returns to, or "" when none can be made.
 *
 * What `upgrade.rollback` needs: the pre-upgrade bundle recorded AND still on disk. A
 * rollback clears `upgraded_from` and an upgrade without a backup clears the bundle, so
 * neither leaves one offered; a bundle deleted since is refused there, so it is not offered
 * here. A path that cannot even be expanded is a hand-edited record, and "" rather than a
 * panel that will not open.
 */
export function rollbackTarget(extra: Record<string, unknown>): string {
  const from = extra[UPGRADE_FROM_KEY];
  const bundle = extra[LAST_BACKUP_KEY];
  if (!isTruthy(from) || typeof bundle !== 'string' || bundle === '') return '';
  try {
    return fs.existsSync(pathExpandUser(bundle)) ? String(from) : '';
  } catch {
    return '';
  }
}

/**
 * Full detail for the GUI panel: summary + state/uptime/health + links + containers +
 * the RC service's env vars.
 */
export async function detail(name: string): Promise<Record<string, unknown>> {
  const target = await naming.resolveName(name);
  return await detailOf(target, await readMeta(target));
}

/**
 * The detail for a record already in hand, so a caller adding to the payload (the CLI's
 * access advice) works from the same snapshot rather than a second read that may differ.
 */
export async function detailOf(target: string, meta: Metadata): Promise<Record<string, unknown>> {
  const d = await inspect.summary(meta);
  // The env tab masks credentials and tells the reader that the workspace's
  // docker-compose.yml is the source of truth for a real value -- but nothing in the GUI
  // said where that workspace is.
  d.workspace = String(paths.workspace(target));
  // The list payload has carried `default` all along; the panel needs it too, so it can
  // offer "Make default" only where that would change something.
  const fallback = config.loadConfig().default_repro;
  d.is_default = isTruthy(fallback) && target === String(fallback);
  const extra = bag(meta.extra);
  const owner = isTruthy(extra.owner)
    ? String(extra.owner)
    : isTruthy(extra.created_by)
      ? String(extra.created_by)
      : '';
  d.created_by = owner;
  d.owner = owner;
  d.made_by = isTruthy(extra.created_by) ? String(extra.created_by) : '';
  d.owner_history = Array.isArray(extra.owner_history) ? [...extra.owner_history] : [];
  // The panel offers "Roll back to <version>" only when this is set.
  d.rollback_to = rollbackTarget(extra);
  // Which address this workspace's ports are bound to. The panel needs it to say anything
  // true about reaching the workspace from ANOTHER machine: every link below is built
  // from `localhost`, which for a browser on a different box than `serve` names that
  // browser's own machine.
  d.bind_host = await bindHostOf(meta);
  // The panel keys its HTTPS row and its "Check TLS" action off these.
  d.public_url = meta.publicUrl;
  d.tls = isTruthy(extra.tls) ? String(extra.tls) : '';
  // ASKED FIRST, before docker is asked anything. A Kubernetes workspace's state does not
  // depend on the local daemon, and the branch below reads the workspace's compose file --
  // which this runtime does not have, so a box whose docker was merely asleep answered
  // the panel with a bare ENOENT, i.e. 500.
  if (topology.ofMeta(meta) === topology.KUBERNETES) {
    return await kubernetesDetail(d, meta, target, extra);
  }
  return await composeDetail(d, meta, target);
}
