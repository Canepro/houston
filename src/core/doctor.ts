/**
 * Preflight environment checks, shared by `houston doctor` and the web GUI.
 *
 * Both front-ends run the IDENTICAL checks: the CLI colours and prints the rows, the API
 * serves them as JSON. Checks never raise — each degrades to a `warn` row — because the whole
 * point is to run when the environment is broken.
 *
 * The previous implementation splits the checks into one module per subject because its
 * check runner was a single 1,044-line function with a rolling `subject` variable; this
 * module keeps the subject boundary as one `check*` function per subject and the same
 * `CHECKS` vocabulary, which is the published contract (`doctor --json`). `row()` is still
 * the only way to add a row, so a subject cannot forget its id.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { namesOf } from '../lib/presets/composite';
import * as config from '../lib/config';
import { pathHome, joinPath } from '../lib/home';
import { getHoustonVersion } from '../lib/jsonout';
import { mongoKernelConflict as mongoKernelConflictOf } from '../lib/mongo-kernel';
import {
  formatFixed,
  toInt,
  quotedText,
  splitTextLines,
  toText,
  strerrorText,
  isTruthy,
} from '../lib/format';
import { docker } from '../seams/docker-cli';
import { releasesReachable } from './rcapi';

import {
  dockerAvailable,
  dockerKernelVersion,
  dockerServerVersion,
  engine,
  composeVersion,
  hubLoggedIn,
} from './runner/host';
import { pickPort, portFree } from './runner/ports';
import { listMeta, type Metadata } from './runner/record';
import * as users from './users';
import * as sessions from './sessions';
import * as eventlog from './eventlog';
import * as journal from './journal';
import { capacity } from './lifecycle/sizing';
import { CREATE_POLICY_KEY } from './lifecycle/types';
import { journalDir } from './journal';
import { acmeDir } from './tls';
import { LEGACY_EDGE_PROJECT, LEGACY_HOME_DIRNAME } from './migrate';
import * as topology from './topology';

import type * as KubeToolsNS from './kube/tools';

type Row = Record<string, unknown>;

/**
 * Every check id `runChecks` can report, in report order.
 *
 * A published contract, the machine-readable half of `doctor --json`. A caller watches
 * an ID; the message beside it is prose. One id per SUBJECT, not per outcome.
 *
 * A CONST TUPLE, so `CheckId` below is the closed set and `Report.line` can only be
 * handed a member of it. In the previous implementation this is three separate walks --
 * one per check module asserting `SUBJECT in doctor.CHECKS`, one asserting the subjects
 * are unique, and one reading `doctor --json`'s rows back -- and none of them could see a
 * row filed under a literal that no module declared as its SUBJECT. Here every one of the
 * ninety-odd `line(...)` call sites is checked by the compiler, including the ones that
 * override the id with `check:`.
 */
export const CHECKS = Object.freeze([
  'preflight', // the report itself could not be assembled
  'docker',
  'compose',
  'engine-kernel',
  'hub-auth',
  'disk',
  'memory',
  'swap',
  'version-lookup',
  'ports',
  'edge',
  'edge-routes-stale',
  'edge-routes-unreachable',
  'gui-accounts',
  'gui-admin',
  'gui-roles',
  'gui-create-policy',
  'state-file-perms',
  'home-perms',
  'home-writable',
  'sessions-file',
  'identity',
  'kubernetes',
  'kubernetes-tools',
  'kubernetes-cluster',
  'kubernetes-storage',
  'kubernetes-ingress',
  'kubernetes-loadbalancer',
  'kubernetes-metrics',
  'kubernetes-other-clusters',
  'inotify',
  'kubernetes-cert-manager',
  'kubernetes-edge-port',
  'kubernetes-chart-repo',
  'kubernetes-https',
  'kubernetes-helm-reach',
  'kubernetes-cloud',
  'kubernetes-skew',
  'kubernetes-cloud-owned',
  'install-fresh',
  'edge-config-drift',
  'preset-browser-host',
  'interrupted-work',
  'event-log',
  'legacy-artifacts',
] as const);

/** A declared check id. Anything else does not compile at the `line()` call site. */
export type CheckId = (typeof CHECKS)[number];

/** The three outcomes a row may carry. `doctor --json` publishes exactly these. */
export type CheckStatus = 'ok' | 'warn' | 'fail';

/** What one check needs from the run, and what it may hand to the next. */
export interface Ctx {
  /** The cluster to report on, defaulting to the box's `kubernetes.context`. */
  context: string;
  /** Whether the Docker daemon answered. Set by the `docker` check. */
  dockerUp: boolean;
  /** `aws.preflight()` and `eks.remembered()`, started early and read by `kubernetes`. */
  cloud: Promise<Bag> | null;
  owned: Promise<Bag[]> | null;
}

type Bag = Record<string, unknown>;

function bagOf(value: unknown): Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Bag;
}

/** The rows one check produced, and the only way to add one. */
export class Report {
  readonly rows: Row[] = [];

  /**
   * Add a row. `subject` is the check id unless `check` overrides it.
   *
   * `elsewhere` names a place the GUI shows this fact PERMANENTLY; the web report drops
   * those rows. Only ever set on an `ok` row.
   */
  line(
    subject: CheckId,
    status: CheckStatus,
    msg: string,
    { elsewhere = '', check = '' }: { elsewhere?: string; check?: CheckId | '' } = {},
  ): void {
    const cid: string = check !== '' ? check : subject;
    // Declared, not free-form: a typo would be a check that silently stops being
    // watchable. Falls back to `preflight` rather than throwing -- a diagnostic must
    // never answer a mis-declared id with a 500.
    //
    // UNREACHABLE FROM PRODUCTION AND DELIBERATELY KEPT. `CheckId` makes a mis-declared
    // id a compile error at every call site in this module, which is the point of the
    // type; this branch is what still happens when one arrives anyway -- from a caller
    // that cast, or from a future dynamic id -- and `doctor --json`'s promise that every
    // row carries a watchable id is what it protects. Deleting it because the compiler
    // says it cannot fire would trade a diagnostic's 200 for a 500.
    if (!(CHECKS as readonly string[]).includes(cid)) {
      this.rows.push({
        check: 'preflight',
        status: 'warn',
        message:
          `internal: check id ${quotedText(cid)} is not in ` +
          `doctor.CHECKS, so this row is unwatchable — ${msg}`,
      });
      return;
    }
    const row: Row = { check: cid, status, message: msg };
    if (elsewhere !== '') row.elsewhere = elsewhere;
    this.rows.push(row);
  }
}

// --- probes -------------------------------------------------------------------

/**
 * Leading integer of a version string ('v2.29.1' -> 2, '5.3.1' -> 5), or null.
 *
 * Comparing only the first CHARACTER reported every Compose release newer than v2 as
 * unsupported.
 */
export function majorVersion(version: string | null | undefined): number | null {
  const m = /^v?(\d+)/u.exec((version ?? '').trim());
  return m === null ? null : Number.parseInt(m[1] as string, 10);
}

export const INOTIFY_PER_CLUSTER = 60;

/** How many inotify instances this UID already holds, or null if unknowable. */
export function inotifyInUse(proc = '/proc'): number | null {
  let uid: number;
  let pids: string[];
  try {
    uid = process.getuid !== undefined ? process.getuid() : -1;
    pids = fs.readdirSync(proc).filter((entry) => /^\d+$/u.test(entry));
  } catch {
    return null;
  }
  let total = 0;
  for (const pid of pids) {
    const base = `${proc}/${pid}`;
    try {
      if (fs.statSync(base).uid !== uid) continue;
      for (const fd of fs.readdirSync(`${base}/fd`)) {
        try {
          if (fs.readlinkSync(`${base}/fd/${fd}`) === 'anon_inode:inotify') total += 1;
        } catch {
          continue;
        }
      }
    } catch {
      continue; // the process went away, or is not ours
    }
  }
  return total;
}

/**
 * Whether the kernel will let another watcher start.
 *
 * Linux-only by construction: the file does not exist elsewhere, and a missing file is
 * silence rather than a warning about a limit that does not apply.
 */
export function inotifyHeadroom(
  clusters = 1,
  file = '/proc/sys/fs/inotify/max_user_instances',
  inUse: number | null = null,
): [CheckStatus, string][] {
  let limit: number;
  try {
    // `toInt` of the file's text: `parseInt` accepted `1024abc` and emitted a row where
    // `toInt` throws and the check stays silent.
    limit = toInt(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const need = Math.max(1, clusters) * INOTIFY_PER_CLUSTER;
  const used = inUse === null ? inotifyInUse() : inUse;
  const free = used === null ? limit : Math.max(0, limit - used);
  const seen = used === null ? '' : `, ${String(used)} already in use by this user`;
  if (free < need) {
    return [
      [
        'fail',
        `inotify instances: ${String(limit)}${seen} — about ${String(free)} left for the ` +
          `~${String(need)} that ${String(Math.max(1, clusters))} cluster(s) want. Traefik will ` +
          `start, load NO dynamic configuration and serve its own ` +
          `default certificate, which looks like a broken route rather ` +
          `than a kernel limit. \`sudo sysctl -w ` +
          `fs.inotify.max_user_instances=1024\``,
      ],
    ];
  }
  if (free < need * 2) {
    return [
      [
        'warn',
        `inotify instances: ${String(limit)}${seen} — about ${String(free)} left against ` +
          `the ~${String(need)} wanted, which is tight. A watcher that cannot ` +
          `start makes Traefik serve its own default certificate. ` +
          `\`sudo sysctl -w fs.inotify.max_user_instances=1024\``,
      ],
    ];
  }
  return [
    [
      'ok',
      `inotify instances: ${String(limit)}${seen} (kind and Traefik watch files; ` +
        `~${String(need)} needed here)`,
    ],
  ];
}

/** Why this MongoDB cannot start on this engine, or "" if it can. */
export function mongoKernelConflict(mongoTag: string, kernel?: string | null): string {
  return mongoKernelConflictOf(mongoTag, kernel);
}

// --- docker / compose / kernel / hub / disk / memory / versions / ports -------

export async function checkDocker(ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  // maxAge 0: somebody running `doctor` has explicitly asked whether Docker is up RIGHT
  // NOW -- answering that from a cache is how a diagnostic tells you the opposite of
  // the truth.
  ctx.dockerUp = await dockerAvailable({ maxAgeMs: 0 });
  const found = ctx.dockerUp ? await engine() : null;
  if (found !== null && found.kind === 'podman') {
    // Podman answering as `docker`: said as itself, with the one difference that stops
    // workspaces outright.
    line(
      'docker',
      'ok',
      `Podman ${found.version || '?'} answering as docker` +
        `${found.rootless ? ', rootless' : ''}${found.shim ? ', through the podman-docker shim' : ''}`,
    );
    if (!found.healthchecks) {
      line(
        'docker',
        'warn',
        `Podman runs no container healthchecks here (cgroup manager '${found.cgroupDriver || '?'}'): ` +
          'a workspace on MongoDB 8 or with several instances waits on one and will not start. ' +
          'Use cgroup_manager = "systemd" under a systemd user session, a Podman machine, or Docker.',
      );
    }
  } else if (ctx.dockerUp) {
    // The server version, or '?' when it is empty: an empty-but-successful probe is '?',
    // as it always was, where `??` kept the empty string.
    const version = await dockerServerVersion();
    line(
      'docker',
      'ok',
      `Docker daemon running (${version !== null && version !== '' ? version : '?'})`,
    );
  } else {
    line('docker', 'fail', 'Docker daemon not running — start Docker Desktop / dockerd');
  }
  return report.rows;
}

export async function checkCompose(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  const cv = await composeVersion();
  const cvMajor = majorVersion(cv);
  if (cv !== null && cv.toLowerCase().includes('podman-compose')) {
    line('compose', 'fail', `docker compose is ${cv}: houston needs the Compose v2 plugin`);
  } else if (cvMajor !== null && cvMajor >= 2) {
    line('compose', 'ok', `docker compose v${String(cvMajor)} (${String(cv)})`);
  } else if (cv !== null && cv !== '') {
    line('compose', 'warn', `docker compose ${cv} — houston needs Compose v2 or newer`);
  } else {
    line('compose', 'warn', "couldn't detect `docker compose` — install Compose v2 or newer");
  }
  return report.rows;
}

export async function checkKernel(ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  if (ctx.dockerUp) {
    const kv = await dockerKernelVersion();
    if (mongoKernelConflict('8.0', kv) !== '') {
      line(
        'engine-kernel',
        'warn',
        `engine kernel ${String(kv)} — MongoDB 8 and newer will not start (SERVER-121912); ` +
          'use an engine on kernel 7.0.14 or newer for RC versions that require Mongo 8',
      );
    } else if (kv !== null && kv !== '') {
      line('engine-kernel', 'ok', `engine kernel ${kv}`);
    }
  }
  return report.rows;
}

export async function checkHub(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  const hub = await hubLoggedIn();
  if (hub === true) {
    line('hub-auth', 'ok', 'logged in to Docker Hub (avoids anonymous pull-rate limits)');
  } else if (hub === false) {
    line(
      'hub-auth',
      'warn',
      'not logged in to Docker Hub — anonymous pulls can hit the rate ' +
        'limit; run `docker login`. registry.rocket.chat counts against Hub too',
    );
  }
  return report.rows;
}

export async function checkDisk(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  try {
    const stat = fs.statfsSync(path.dirname(config.home()));
    const freeGb = (Number(stat.bavail) * Number(stat.bsize)) / 1e9;
    if (freeGb >= 10) {
      line('disk', 'ok', `Disk: ${formatFixed(freeGb, 0)} GB free`);
    } else {
      line(
        'disk',
        'warn',
        `Disk: only ${formatFixed(freeGb, 0)} GB free — images are ~1.5 GB each`,
      );
    }
  } catch {
    line('disk', 'warn', "couldn't check disk space");
  }
  return report.rows;
}

export async function checkMemory(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  // Memory headroom, in workspaces rather than megabytes -- "3.2 GB available" does not
  // tell you whether you can start another one, and that is the only question anybody
  // is actually asking.
  const cap = await capacity();
  if (cap.known) {
    const totalMb = cap.total_mb ?? 0;
    const availMb = cap.available_mb ?? 0;
    const swapMb = cap.swap_mb ?? 0;
    const room = cap.room ?? 0;
    const detail = `${String(availMb)} MB available of ${String(totalMb)} MB`;
    if (room >= 2) {
      line('memory', 'ok', `Memory: ${detail}`);
    } else if (room === 1) {
      line('memory', 'warn', `Memory: ${detail} — room for about 1 more workspace`);
    } else {
      line(
        'memory',
        'warn',
        `Memory: ${detail} — NOT enough for another workspace. ` +
          '`houston stop --name <it>` frees memory and keeps the data',
      );
    }
    if (swapMb === 0) {
      line(
        'memory',
        'warn',
        'No swap: memory pressure becomes an OOM kill rather than ' +
          'slowdown, and the kernel picks its own victim',
        { check: 'swap' },
      );
    }
  }
  return report.rows;
}

export async function checkVersions(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  // Live version lookup reachability. Through `rcapi`, which is the one module allowed
  // to make requests. `null` is a transport failure -- NO response at all -- and saying
  // "returned non-200" for a box with no network would name the wrong fault.
  const status = await releasesReachable();
  if (status === null) {
    line(
      'version-lookup',
      'warn',
      'releases.rocket.chat unreachable — use `--offline` (falls back to shipped map)',
    );
  } else if (status === 200) {
    line('version-lookup', 'ok', 'releases.rocket.chat reachable (live version lookup available)');
  } else {
    line(
      'version-lookup',
      'warn',
      'releases.rocket.chat returned non-200 — use `--offline` if needed',
    );
  }
  return report.rows;
}

export async function checkPorts(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  try {
    const free = await pickPort();
    if (await portFree(3000)) {
      line(
        'ports',
        'ok',
        `Port 3000 free (repros auto-pick from 3000; next free: ${String(free)})`,
      );
    } else {
      line(
        'ports',
        'warn',
        `Port 3000 in use — \`up\` will auto-pick the next free port (${String(free)})`,
      );
    }
  } catch (exc) {
    // bounded scan found nothing bindable
    line('ports', 'fail', String((exc as Error).message));
  }
  return report.rows;
}

// --- install / legacy ---------------------------------------------------------

export async function checkInstall(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  try {
    const reported = getHoustonVersion();
    // THE CHECKOUT BESIDE THE RUNNING BUILD, derived from this module's own location --
    // not the current working directory. houston may be invoked from anywhere, and
    // reading `./package.json` from a random project directory both misses the real
    // checkout and warns about the wrong tree's version. The previous implementation read
    // its own manifest the same way; that file now belongs to it, and THIS build's version
    // lives in package.json at the package root. A checkout is a root that still has src/
    // beside dist/: an installed tarball ships neither src/ nor a tree a fix could be made
    // in, so there is nothing to compare against and the row says so.
    const root = path.resolve(__dirname, '..', '..');
    const source = path.join(root, 'package.json');
    if (fs.existsSync(source) && fs.existsSync(path.join(root, 'src'))) {
      let checkout = '';
      try {
        const manifest = JSON.parse(fs.readFileSync(source, 'utf8')) as { version?: unknown };
        checkout = typeof manifest.version === 'string' ? manifest.version : '';
      } catch {
        checkout = '';
      }
      if (checkout !== '' && checkout !== reported) {
        // The TypeScript build reports `jsonout`'s registry value, which the front door
        // sets from the package; the placeholder is `0.0.0` until this build is
        // packaged. The comparison still catches a stale link, which is the point.
        line(
          'install-fresh',
          'warn',
          `running houston ${reported}, but the checkout at ${path.dirname(source)} ` +
            `is ${checkout} — the build is reporting a different version, so a fix in ` +
            `that tree may NOT be what is answering. Rebuild so the two agree`,
        );
      } else {
        line(
          'install-fresh',
          'ok',
          `houston ${reported}, matching the checkout at ${path.dirname(source)}`,
        );
      }
    } else {
      line('install-fresh', 'ok', `houston ${reported} (installed, no checkout alongside)`);
    }
  } catch {
    line('install-fresh', 'warn', 'could not determine which houston build is running');
  }
  return report.rows;
}

/** A pre-rename edge still holding :80/:443, which stops the new one starting. */
async function legacyEdgeContainers(line: Report['line']): Promise<void> {
  if (!(await dockerAvailable())) return;
  let seen: string;
  try {
    const result = await docker(
      [
        'ps',
        '--filter',
        `label=com.docker.compose.project=${LEGACY_EDGE_PROJECT}`,
        '--filter',
        'status=running',
        '--format',
        '{{.Names}}',
      ],
      { capture: true, timeoutMs: 15_000 },
    );
    seen = String(result.stdout ?? '');
  } catch {
    seen = '';
  }
  const held = seen
    .trim()
    .split(/\r?\n/u)
    .filter((entry) => entry !== '');
  if (held.length > 0) {
    line(
      'legacy-artifacts',
      'warn',
      `${held[0] as string} is the pre-rename edge and still holds :80 and ` +
        `:443, so the new one cannot start — \`docker compose -p ` +
        `${LEGACY_EDGE_PROJECT} down\` then \`houston edge start\``,
      { check: 'legacy-artifacts' },
    );
  }
}

/** A CA anchor installed under the previous name. */
function legacyCaAnchor(line: Report['line']): void {
  for (const anchorDir of [
    '/usr/local/share/ca-certificates',
    '/etc/pki/ca-trust/source/anchors',
  ]) {
    const oldCa = path.join(anchorDir, 'rc-repro-local-ca.crt');
    if (!fs.existsSync(oldCa)) continue;
    // NOT stale, and saying so would be actively harmful. `ensureCa` is idempotent, so
    // the migration carried the SAME certificate authority across.
    line(
      'legacy-artifacts',
      'ok',
      `${oldCa} still carries the local CA in use — it keeps ` +
        `working under its old name. \`houston trust-ca\` installs ` +
        `the same certificate under its new name; remove the old ` +
        `file only after that, and only for tidiness`,
      { check: 'legacy-artifacts' },
    );
  }
}

export async function checkLegacy(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  // WHAT THE RENAME COULD NOT MOVE. Silent when clean.
  try {
    // `LEGACY_HOME_DIRNAME` under the user's home, joined by `joinPath`: `path.join`
    // folded a `..` in HOME and warned about a directory the kernel -- and every earlier
    // release -- does not find.
    const legacyState = joinPath(pathHome(), LEGACY_HOME_DIRNAME);
    if (fs.existsSync(legacyState) && fs.statSync(legacyState).isDirectory()) {
      line(
        'legacy-artifacts',
        'warn',
        `${legacyState} is still here. It is adopted automatically ` +
          `unless HOUSTON_HOME is set, which it is — unset it and run ` +
          `any houston command, or move it by hand`,
        { check: 'legacy-artifacts' },
      );
    }

    const staleEnv = config.legacyEnvUsed();
    if (staleEnv.length > 0) {
      line(
        'legacy-artifacts',
        'warn',
        `reading the pre-rename ${staleEnv.join(', ')}; rename to ` +
          `HOUSTON_* — the old names will stop being read`,
        { check: 'legacy-artifacts' },
      );
    }

    const unit = '/etc/systemd/system/rc-repro.service';
    if (fs.existsSync(unit)) {
      line(
        'legacy-artifacts',
        'warn',
        `${unit} is the pre-rename service and will fail at boot — ` +
          `\`sudo systemctl disable --now rc-repro && sudo rm ${unit}\`, ` +
          `then \`houston serve --print-service\` for the new one`,
        { check: 'legacy-artifacts' },
      );
    }

    for (const hostDir of ['.claude/skills', '.agents/skills']) {
      // `rc-repro` under the host's directory in the user's home, joined as the legacy
      // state above is.
      const oldSkill = joinPath(pathHome(), hostDir, 'rc-repro');
      if (fs.existsSync(oldSkill) && fs.statSync(oldSkill).isDirectory()) {
        line(
          'legacy-artifacts',
          'warn',
          `${oldSkill} still teaches agents to run \`rc-repro\`, a ` +
            `command that no longer exists — \`rm -rf ${oldSkill}\` ` +
            `and \`houston skill install\``,
          { check: 'legacy-artifacts' },
        );
      }
    }

    // Deliberately NOT flagged: `rcrepro-<name>` containers. The edge is the exception,
    // because it is a singleton.
    await legacyEdgeContainers(line);
    legacyCaAnchor(line);
  } catch {
    line('legacy-artifacts', 'warn', 'could not check for pre-rename leftovers', {
      check: 'legacy-artifacts',
    });
  }
  return report.rows;
}

// --- edge ---------------------------------------------------------------------

/** Every route the edge is serving: the ones whose workspace is gone, and the ones
 * nothing answers on. */
async function edgeRoutes(line: Report['line'], ctx: Ctx, routes: string[]): Promise<void> {
  const networks = await import('./edge/networks');
  if (!ctx.dockerUp) return;
  // A route whose workspace is gone points the edge at nothing.
  const known = new Set((await listMeta()).map((m) => m.name));
  const stale = routes.filter((r) => !known.has(r));
  if (stale.length > 0) {
    const sorted = [...stale].sort();
    const hosts = sorted.slice(0, 5).map((r) => {
      const routesMod = require('./edge/routes') as { routeHost: (name: string) => string };
      return routesMod.routeHost(r) || r;
    });
    line(
      'edge',
      'warn',
      `${String(stale.length)} edge route(s) with no workspace: ` +
        `${sorted.slice(0, 5).join(', ')} — \`down\` cannot ` +
        `remove these, the workspace is what is gone. ` +
        `\`houston edge delete ${hosts[0] as string}\` forgets a name, ` +
        `its certificate and its key`,
    );
  }
  // A route the edge cannot REACH is a 502 rather than an error.
  const engine = await import('./edge/engine');
  if (await engine.running()) {
    const attached = await networks.attachedNetworks();
    const orphan: string[] = [];
    for (const route of routes) {
      if (!known.has(route)) continue;
      if (!attached.has(await networks.workspaceNetwork(route))) orphan.push(route);
    }
    if (orphan.length > 0) {
      line(
        'edge',
        'warn',
        `${String(orphan.length)} route(s) the edge cannot reach: ` +
          `${[...orphan].sort().slice(0, 5).join(', ')} — they answer 502. ` +
          '`houston edge restart` re-attaches them',
      );
    }
  }
}

export async function checkEdge(ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  try {
    const edge = await import('./edge/spec');
    const engine = await import('./edge/engine');
    if (edge.installed()) {
      const served = edge.servedDomain();
      const where = served !== '' ? ` (${served})` : '';
      const routes = (await import('./edge/routes')).registered();
      if (!ctx.dockerUp) {
        line('edge', 'warn', `Edge${where} installed — cannot check it, Docker is down`);
      } else if (await engine.running()) {
        line(
          'edge',
          'ok',
          `Edge running${where} — holds :80/:443, ` + `${String(routes.length)} workspace route(s)`,
          { elsewhere: 'the edge chip in the header' },
        );
      } else if (routes.length === 0 && served === '') {
        // NOTHING TO REACH. A stopped edge with no https workspace and no GUI name on it
        // breaks nothing, and `fail` made `doctor` exit 1 on a box that had simply finished
        // with HTTPS -- "every https name (0 route(s)) is unreachable" about no names at all.
        line(
          'edge',
          'ok',
          'Edge installed and stopped — no https workspace uses it. ' +
            '`houston edge start` when one does',
        );
      } else {
        const holder = await engine.portHolder(443);
        const because = holder !== '' ? ` — ${holder} is holding :443` : '';
        line(
          'edge',
          'fail',
          `Edge${where} is NOT running${because}. Every https ` +
            `name on this box (${String(routes.length)} route(s)) is ` +
            'unreachable. `houston edge start`',
        );
      }
      if (ctx.dockerUp && (await engine.running())) {
        const [staleCfg, liveOnly] = await edge.configDrift();
        if (staleCfg.length > 0 || liveOnly.length > 0) {
          const shown = [...staleCfg, ...liveOnly].slice(0, 3);
          line(
            'edge',
            'warn',
            `the edge's configuration on disk and the running ` +
              `container disagree (${shown.join(', ')}` +
              `${staleCfg.length + liveOnly.length > 3 ? '…' : ''}). ` +
              `Whatever was changed has not been applied — ` +
              '`houston edge restart`',
            { check: 'edge-config-drift' },
          );
        }
      }
      await edgeRoutes(line, ctx, routes);
    }
  } catch {
    line('edge', 'warn', 'Edge status could not be determined');
  }
  return report.rows;
}

// --- identity / event log / work -----------------------------------------------

/** Who can sign in, and with what role. */
function identityAccounts(line: Report['line']): void {
  if (!users.anyUsers()) {
    line(
      'identity',
      'warn',
      'No GUI accounts — `houston serve` will refuse to start on ' +
        'anything but loopback (`houston users add <name>`)',
      { check: 'gui-accounts' },
    );
  } else {
    const admins = users.admins();
    if (admins.length > 0) {
      line(
        'identity',
        'ok',
        `${String(users.listUsers().length)} GUI account(s), ` + `admin: ${admins.join(', ')}`,
        { elsewhere: 'the People page', check: 'gui-accounts' },
      );
    } else {
      line(
        'identity',
        'fail',
        'No admin account — nobody can manage people from the ' +
          'GUI. `houston users role <name> admin`',
        { check: 'gui-admin' },
      );
    }
    const implicit = users.implicitAdmins();
    if (implicit.length > 0) {
      line(
        'identity',
        'warn',
        `admin by default (blank role column): ` +
          `${implicit.join(', ')} — that is the migration for ` +
          'accounts made before roles existed, not a choice. ' +
          `\`houston users role ${implicit[0] as string} member\``,
        { check: 'gui-roles' },
      );
    }
    // Reported rather than warned about: this is the default and it is a deliberate one,
    // but "what may a member actually do on this box?" should be answerable without
    // reading source.
    // THE KEY `houston config set gui.create_policy` WRITES, `lifecycle.CREATE_POLICY_KEY`.
    // This read `gui_create_policy`, which nothing writes, so after an admin narrowed the
    // policy the row still told them members may set those fields.
    if (config.loadConfig()[CREATE_POLICY_KEY] === 'admin') {
      line(
        'identity',
        'ok',
        'members may not set --rc-image/--reg-token/--bind ' + '(gui.create_policy admin)',
        { elsewhere: 'which fields the New workspace form offers', check: 'gui-create-policy' },
      );
    } else {
      line(
        'identity',
        'ok',
        'members may set --rc-image/--reg-token/--bind — narrow ' +
          'it with `houston config set gui.create_policy admin`',
        { elsewhere: 'which fields the New workspace form offers', check: 'gui-create-policy' },
      );
    }
  }
}

/** Where the history is, and whether it is being written. */
function identityEventLog(line: Report['line']): void {
  try {
    const logPath = eventlog.logPath();
    if (eventlog.maxBytes() <= 0) {
      line(
        'identity',
        'warn',
        'Event log disabled (HOUSTON_LOG_MAX_MB=0) — nothing is ' + 'recording what houston did',
        { check: 'event-log' },
      );
    } else if (fs.existsSync(logPath)) {
      const mb = fs.statSync(logPath).size / 1_048_576;
      line(
        'identity',
        'ok',
        `Event log: ${logPath} (${formatFixed(mb, 1)} MB of ` +
          `${formatFixed(eventlog.maxBytes() / 1_048_576, 0)} MB, then one ` +
          'rotation)',
        { check: 'event-log' },
      );
    } else {
      line(
        'identity',
        'ok',
        `Event log: ${logPath} — written from the first command that ` + 'reports progress',
        { check: 'event-log' },
      );
    }
  } catch {
    line('identity', 'warn', 'Event log status could not be determined', {
      check: 'event-log',
    });
  }
}

/** Whether the files that DECIDE who can sign in are sound. */
function identityStateFiles(line: Report['line']): void {
  for (const file of [
    users.usersFile(),
    sessions.sessionsFile(),
    // Joined component by component, a `..` kept, as every path under the home is.
    joinPath(config.home(), 'audit.log'),
    joinPath(acmeDir(), 'dns.env'),
    joinPath(config.home(), 'ca', 'ca.key'),
  ]) {
    if (fs.existsSync(file) && (fs.statSync(file).mode & 0o077) !== 0) {
      line(
        'identity',
        'warn',
        `${file} is readable by other local users ` +
          `(mode ${(fs.statSync(file).mode & 0o777).toString(8).padStart(3, '0')}); it should be 0600`,
        { check: 'state-file-perms' },
      );
    }
  }
  const home = config.home();
  // WRITABLE, WHICH IS A DIFFERENT QUESTION FROM 0700. Probed rather than derived from
  // st_mode: a read-only mount, a full disk or a container's user mapping all deny a
  // write with the bits looking fine.
  identityEventLog(line);
  for (const [label, target] of [
    ['state root', home],
    ['workspaces', joinPath(home, 'repros')],
    ['locks', joinPath(home, 'locks')],
    ['journal', journalDir()],
  ] as [string, string][]) {
    try {
      fs.mkdirSync(target, { recursive: true });
      const probe = joinPath(target, '.houston-write-probe');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
    } catch (error) {
      // The C library's reason, "Permission denied", where Node's own message was
      // "EACCES: permission denied, open '...'".
      line(
        'identity',
        'fail',
        `${target} is not writable (${strerrorText(error, target)}) — every ` +
          `command that creates or records anything will fail the same way. ` +
          `houston's ${label}.`,
        { check: 'home-writable' },
      );
      break;
    }
  }
  if (fs.existsSync(home) && (fs.statSync(home).mode & 0o077) !== 0) {
    line(
      'identity',
      'warn',
      `${home} is 0${(fs.statSync(home).mode & 0o777).toString(8)}, so another ` +
        'local user can read the accounts and sessions inside it ' +
        '— `serve` tightens it to 0700 at startup',
      { check: 'home-perms' },
    );
  }
  // A state file written by a NEWER houston must not be half-understood.
  const marker = '# houston-state: ';
  let sessionText: string;
  try {
    sessionText = fs.readFileSync(sessions.sessionsFile(), 'utf8');
  } catch {
    // A failed read: nothing to read, nothing to say
    return;
  }
  // NOT inside the `catch` above. Only a failed read is caught there, so a marker line that
  // is not an integer throws `toInt`'s RangeError out of the whole check -- which degrades to
  // "Identity status could not be determined". Swallowing it would silently ignore a
  // file this build does not understand.
  for (const ln of splitTextLines(sessionText)) {
    if (ln.startsWith(marker)) {
      const seen = toInt(ln.slice(marker.length));
      if (seen > sessions.STATE_VERSION) {
        line(
          'identity',
          'fail',
          `${sessions.sessionsFile()} was written by a ` +
            `newer houston (state v${String(seen)}, this reads ` +
            `v${String(sessions.STATE_VERSION)}) — upgrade rather ` +
            'than run against it',
          { check: 'sessions-file' },
        );
      }
      break;
    }
  }
}

export async function checkIdentity(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  // ONE try around both halves: a failure reading the accounts must skip the file checks
  // too and produce exactly one row.
  try {
    identityAccounts(line);
    identityStateFiles(line);
  } catch {
    line('identity', 'warn', 'Identity status could not be determined');
  }
  return report.rows;
}

export async function checkWork(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  // SIDE EFFECTS NOBODY MEANT TO LEAVE. The journal is the only durable trace.
  try {
    const stranded = journal.abandoned();
    if (stranded.length > 0) {
      for (const entry of stranded.slice(0, 5)) {
        // The suffix has to match what recovery will actually DO.
        const tail = journal.ADVISORY.includes(entry.kind)
          ? ''
          : ' — `houston serve` repairs this at startup, or fix it by hand';
        line('interrupted-work', 'warn', journal.describe(entry) + tail, {
          check: 'interrupted-work',
        });
      }
    } else if (journal.openEntries().length > 0) {
      // Open but owned by a live process: a job is running right now, which is not a
      // fault and must not read as one.
      line(
        'interrupted-work',
        'ok',
        `${String(journal.openEntries().length)} operation(s) in progress ` +
          '(a running job holds them)',
        { check: 'interrupted-work' },
      );
    }
  } catch {
    // a check must never break the report
  }
  return report.rows;
}

// --- presets ------------------------------------------------------------------

export async function checkPresets(_ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  // THE WORKSPACES ALREADY OUT THERE. `up` warns about this at create time now, but
  // every workspace made before that is silent.
  const hostParam: Record<string, string> = {
    saml: 'idp_host',
    oidc: 'idp_host',
    s3_minio: 's3_host',
  };
  try {
    for (const meta of await listMeta()) {
      // OWN keys only of the host-parameter table. A preset named `constructor` -- a legal
      // name -- found Object.prototype's here and printed a bogus `--set function Object()
      // { [native code] }=...` row.
      const extra = bagOf(meta.extra);
      // `toText` of the recorded bind: a falsy recorded value is the empty bind, not the
      // string "false".
      const bind = toText(extra.bind_host);
      if (bind === '' || bind === '127.0.0.1' || bind === 'localhost') continue;
      // Each preset of a composed workspace, whose params are recorded per preset.
      const names = namesOf((meta.preset || '').trim());
      for (const preset of names) {
        const param = Object.hasOwn(hostParam, preset) ? hostParam[preset] : undefined;
        if (param === undefined) continue;
        const own =
          names.length > 1 ? bagOf(bagOf(extra.preset_params)[preset]) : bagOf(extra.params);
        if (isTruthy(own[param])) continue; // someone said where the browser is
        const key = names.length > 1 ? `${preset}.${param}` : param;
        line(
          'preset-browser-host',
          'warn',
          `${quotedText(meta.name)} is bound to ${bind} but its ${quotedText(preset)} ` +
            `preset still points the browser at this machine. From ` +
            `anywhere else that address is the visitor's own laptop and ` +
            `login fails silently. Re-create with ` +
            `\`--set ${key}=<the host people type>\``,
          { check: 'preset-browser-host' },
        );
      }
    }
  } catch {
    // a check must never break the report
  }
  return report.rows;
}

// --- kubernetes ---------------------------------------------------------------

/** Whether TLS can be issued, and what address a workspace would actually answer on. */
async function reportCertmanagerAndEndpoints(
  line: Report['line'],
  pre: KubeToolsNS.Preflight,
): Promise<void> {
  const { certManagerInstalled } = await import('./kube/certmanager');
  const { endpointString, ingressEndpoint } = await import('./kube/endpoints');
  // ASKED ONCE, because this is a CRD read against a remote API server.
  let cm: boolean;
  try {
    cm = await certManagerInstalled(pre.context);
  } catch {
    cm = false;
  }
  if (cm) {
    line(
      'kubernetes',
      'ok',
      'cert-manager: installed — a Certificate can be issued in this cluster',
      { check: 'kubernetes-cert-manager' },
    );
  } else {
    line(
      'kubernetes',
      'ok',
      'cert-manager: not installed — installed on first use by a workspace that asks ' +
        "for a certificate, with the guide's own `kubectl apply`",
      { check: 'kubernetes-cert-manager' },
    );
  }
  let endpoint: Awaited<ReturnType<typeof ingressEndpoint>> | null;
  try {
    endpoint = await ingressEndpoint(pre.context);
  } catch {
    endpoint = null;
  }
  if (endpoint === null) {
    line(
      'kubernetes',
      'ok',
      'https: not servable yet — this cluster publishes no ' +
        ':443 Service reachable from outside it. A workspace ' +
        'that asks for a name installs an ingress controller; ' +
        'port-forward needs none',
      { check: 'kubernetes-https' },
    );
  } else {
    const owner =
      endpoint.local && endpoint.port === 443 ? "the CLUSTER's own ingress" : "houston's edge";
    const via =
      endpoint.local && endpoint.port === 443
        ? 'directly'
        : `passed through by SNI to ${endpointString(endpoint)}`;
    const where = cm
      ? 'TLS terminates in the cluster, from a cert-manager Secret'
      : 'a name would be servable here once cert-manager is installed';
    line(
      'kubernetes',
      'ok',
      `https: ${owner} answers this host's :443, and a ` +
        `workspace name is served ${via} — ${where} ` +
        `(${endpoint.source} ${endpointString(endpoint)}, ${endpoint.service})`,
      { check: 'kubernetes-https' },
    );
  }
}

/** Helm, cert-manager and the endpoints a workspace would be reached on. */
async function clusterAddons(line: Report['line'], pre: KubeToolsNS.Preflight): Promise<void> {
  const { kube, helmEnv } = await import('./kube/exec');
  const { CHART } = await import('./kube/names');
  try {
    const repo = await kube.run(['helm', 'search', 'repo', CHART, '-o', 'json'], {
      env: helmEnv(pre.context),
    });
    if (repo.returncode === 0 && !['', '[]'].includes(repo.stdout.trim())) {
      line('kubernetes', 'ok', `chart ${CHART} resolves in houston's Helm home`, {
        check: 'kubernetes-chart-repo',
      });
    } else {
      line(
        'kubernetes',
        'warn',
        `chart ${CHART} does not resolve in the Helm ` +
          `home houston installs from — \`up\` adds the repo ` +
          `itself, so this matters only if a create fails ` +
          `naming it`,
        { check: 'kubernetes-chart-repo' },
      );
    }
  } catch {
    // a check must never break the report
  }
  // HELM'S OWN ANSWER, because houston drives two clients and this check only ever
  // asked one.
  if (pre.helmReachable !== '') {
    line(
      'kubernetes',
      'fail',
      `helm cannot reach cluster ${quotedText(pre.context)} although ` +
        `kubectl can — every Kubernetes create will fail at ` +
        `the chart, after MongoDB, and roll back. helm said: ` +
        `${pre.helmReachable}. A kubeconfig left over from a ` +
        `previous install of the same cluster does this; ` +
        `regenerate it (k3s: \`sudo cat ` +
        `/etc/rancher/k3s/k3s.yaml > ~/.kube/config\`, kind: ` +
        '`kind export kubeconfig --name <cluster>`)',
      { check: 'kubernetes-helm-reach' },
    );
  }
  await reportCertmanagerAndEndpoints(line, pre);
}

/** The two capabilities a workspace cannot be created without. */
function reportStorageAndIngress(
  line: Report['line'],
  needed: CheckStatus,
  pre: KubeToolsNS.Preflight,
): void {
  if (pre.unreadable.includes('storage')) {
    line(
      'kubernetes',
      needed,
      `Cluster ${quotedText(pre.context)} would not let houston read ` +
        `its StorageClasses, so whether a workspace's volume ` +
        `can bind is unknown — check the credential in your ` +
        'kubeconfig has read access',
      { check: 'kubernetes-storage' },
    );
  } else if (pre.defaultStorageClass === '') {
    line(
      'kubernetes',
      needed,
      `Cluster ${quotedText(pre.context)} has no default ` +
        `StorageClass — a workspace's volume would stay ` +
        'Pending with no error naming storage',
      { check: 'kubernetes-storage' },
    );
  } else {
    line('kubernetes', 'ok', `Storage: ${pre.defaultStorageClass} (default)`, {
      check: 'kubernetes-storage',
    });
  }

  if (pre.unreadable.includes('ingress')) {
    line(
      'kubernetes',
      'warn',
      `Cluster ${quotedText(pre.context)} would not let houston read ` +
        'its IngressClasses — whether a hostname can be ' +
        'served from it is unknown',
      { check: 'kubernetes-ingress' },
    );
  } else if (pre.ingressClasses.length > 0) {
    line(
      'kubernetes',
      'ok',
      `Ingress: ${pre.ingressClasses.join(', ')} — a hostname can be served from this cluster`,
      {
        check: 'kubernetes-ingress',
      },
    );
  } else {
    line(
      'kubernetes',
      'ok',
      'Ingress: none installed — workspaces are reached by ' +
        'port-forward, which needs no controller',
      { check: 'kubernetes-ingress' },
    );
  }
}

/** Version skew, storage, ingress, load balancer and metrics. */
async function clusterCapabilities(
  line: Report['line'],
  needed: CheckStatus,
  pre: KubeToolsNS.Preflight,
): Promise<void> {
  const { skew, KUBECTL_SKEW } = await import('./kube/probe');
  const gap = await skew(pre.context);
  if (gap !== null && !gap.ok) {
    const cv = gap.client.slice(0, 2).join('.');
    const sv = gap.server.slice(0, 2).join('.');
    line(
      'kubernetes',
      needed,
      `kubectl ${cv} is outside the supported ±${String(KUBECTL_SKEW)} ` +
        `window for this cluster's API server (${sv}) — calls do not fail cleanly ` +
        `across that gap, they fail on a field one side does not ` +
        `know, which reads as a bug in whatever was being deployed`,
      { check: 'kubernetes-skew' },
    );
  } else if (gap !== null) {
    line(
      'kubernetes',
      'ok',
      `kubectl matches the API server (${gap.server.slice(0, 2).join('.')})`,
      {
        check: 'kubernetes-skew',
      },
    );
  }
  reportStorageAndIngress(line, needed, pre);
  if (pre.loadbalancer !== '') {
    line('kubernetes', 'ok', `Load balancer: working — ${pre.loadbalancer}`, {
      check: 'kubernetes-loadbalancer',
    });
  } else {
    line(
      'kubernetes',
      'ok',
      'Load balancer: not confirmed — no LoadBalancer Service ' + 'here has an address',
      { check: 'kubernetes-loadbalancer' },
    );
  }
  if (pre.metrics) {
    line('kubernetes', 'ok', 'Metrics: metrics-server answering — `houston stats` works here', {
      check: 'kubernetes-metrics',
    });
  } else {
    line(
      'kubernetes',
      'ok',
      'Metrics: no metrics-server — `houston stats` refuses ' + 'and says how to install it',
      { check: 'kubernetes-metrics' },
    );
  }
}

/** Which cluster this is, what shape it is, and whose it is. */
async function clusterIdentity(line: Report['line'], pre: KubeToolsNS.Preflight): Promise<void> {
  const { CLUSTER_NAME, PROVIDER_EXTERNAL } = await import('./kube/names');
  const count =
    pre.namespaces.length > 0 ? `, ${String(pre.namespaces.length)} workspace namespace(s)` : '';
  // WHAT it is and what SHAPE it is, on the line that names it. "0 nodes" WAS PRINTED
  // FOR A CLUSTER NOBODY COULD READ, beside a tick.
  const shapeParts: string[] = [];
  if (pre.unreadable.includes('nodes')) {
    shapeParts.push('node count unknown');
  } else {
    shapeParts.push(`${String(pre.nodeCount)} node${pre.nodeCount === 1 ? '' : 's'}`);
  }
  if (pre.architectures.length > 0) shapeParts.push(pre.architectures.join(', '));
  const shape = shapeParts.join(', ');
  const where =
    (shape !== ''
      ? ` (${pre.distribution || 'unknown'}, ${shape})`
      : ` (${pre.distribution || 'unknown'})`) + count;
  if (pre.provider === PROVIDER_EXTERNAL) {
    line(
      'kubernetes',
      'ok',
      `Using cluster ${quotedText(pre.context)}${where} — houston creates namespaces ` +
        'in it; only `houston cluster delete` removes a cluster, and only one houston built',
      { check: 'kubernetes-cluster' },
    );
  } else {
    line('kubernetes', 'ok', `Cluster ${quotedText(CLUSTER_NAME)} reachable${where}`, {
      check: 'kubernetes-cluster',
    });
  }
}

/** Who holds the shared edge, and whether this box can still reach it. */
function reportEdgeClaim(
  claim: { context: string; ports: number[]; address: string; service: string },
  harmed: string[],
  installedEdge: boolean,
  line: Report['line'],
): void {
  if (!installedEdge) return;
  const what =
    harmed.length > 0
      ? `${harmed.slice(0, 3).join(', ')}${harmed.length > 3 ? '…' : ''}`
      : 'every name it is given';
  const took = claim.ports
    .filter((p) => p === 80 || p === 443)
    .map((p) => `:${String(p)}`)
    .join(', ');
  const hurts: string[] = [];
  if (claim.ports.includes(443)) hurts.push('serving https', 'the tls-alpn challenge');
  if (claim.ports.includes(80)) hurts.push('the http-01 challenge', 'the :80 redirect');
  const broken =
    hurts.length > 1
      ? `${hurts.slice(0, -1).join(', ')} and ${hurts[hurts.length - 1] as string}`
      : hurts.length === 1
        ? (hurts[0] as string)
        : "the edge's ports";
  line(
    'kubernetes',
    'warn',
    `cluster ${quotedText(claim.context)} holds this host's ${took} at ` +
      `${claim.address} (${claim.service}), so houston's edge cannot ` +
      `receive there: ${what} answers from the cluster through the host ` +
      `— a 404 and the cluster's own certificate — while the ` +
      `edge itself is fine and bound. This breaks ` +
      `${broken}. A box serves HTTPS for one runtime at a ` +
      `time: remove the edge on a Kubernetes box, or give the host ` +
      `ports back with \`kubectl -n kube-system patch svc ` +
      `${claim.service.split('/').at(-1) as string} -p ` +
      `'{"spec":{"type":"NodePort"}}'\` — which the ` +
      `next k3s install undoes, so make it permanent with \`--disable ` +
      `traefik --disable servicelb\``,
    { check: 'kubernetes-edge-port' },
  );
}

/** No cluster yet: say what `up` would build, and what is already on this box. */
async function reportClusterToCreate(
  inUse: boolean,
  k8sWorkspaces: string[],
  line: Report['line'],
  pre: KubeToolsNS.Preflight,
): Promise<void> {
  const { CLUSTER_NAME } = await import('./kube/names');
  const { activeContext } = await import('./kube/context');
  const { reachable } = await import('./kube/reachability');
  const { distribution } = await import('./kube/context');
  const { pretty } = await import('./kube/tools');
  const kind = pre.tools.kind;
  // `pretty(kind)`, not `.raw`: the raw line is `kind version 0.32.0 ...`, which read as
  // "by kind kind version ...". The same fix `reportToolVersions` already carries.
  const by = kind !== undefined && kind.path !== '' ? ` by kind ${pretty(kind)}` : '';
  const stale = [...k8sWorkspaces].sort().slice(0, 3).join(', ');
  const more = k8sWorkspaces.length > 3 ? '…' : '';
  line(
    'kubernetes',
    inUse ? 'warn' : 'ok',
    inUse
      ? `Cluster ${quotedText(CLUSTER_NAME)} is gone, so ${String(k8sWorkspaces.length)} ` +
          `record(s) point at nothing (${stale}${more}). Their data went ` +
          `with it; \`houston down --name <it> --volumes\` clears each ` +
          `record, and the next \`up\` builds a fresh cluster.`
      : `No cluster yet — ${quotedText(CLUSTER_NAME)} is created on first use${by}`,
    { check: 'kubernetes-cluster' },
  );
  // The box that has BOTH.
  const other = await activeContext();
  if (other !== '' && other !== pre.context && (await reachable(other))) {
    line(
      'kubernetes',
      'ok',
      `Cluster ${quotedText(other)} ` +
        `(${(await distribution(other)) || 'unknown'}) is running and ` +
        `will NOT be used by default — houston creates its own ` +
        `while kind is installed. Use it with ` +
        `\`--context ${other}\`, or make it this box's default ` +
        `with \`houston config set kubernetes.context ${other}\``,
      { check: 'kubernetes-other-clusters' },
    );
  }
}

/** The cloud clusters this box remembers making, and what each still costs. */
function reportOwnedClusters(cloud: Bag, line: Report['line'], remembered: Bag[]): void {
  const eks = require('./eks') as {
    daysUntil: (expires: string) => number | null;
    identityPretty: (identity: unknown) => string;
    cloudReady: (pre: never) => boolean;
    blockers: (pre: never) => string[];
  };
  for (const owned of remembered) {
    const left = eks.daysUntil(String(owned.expires ?? ''));
    // PAST ITS DATE is a louder answer than "still running".
    const when =
      left === null
        ? ''
        : left >= 0
          ? ` — ${String(left)} day(s) left on its expiry`
          : ` — ${String(-left)} day(s) PAST the expiry it was created with`;
    line(
      'kubernetes',
      'warn',
      `houston built the ${String(owned.provider ?? 'cloud')} cluster ` +
        `${quotedText(String(owned.name))} in ${String(owned.region)} ` +
        `(account ${String(owned.account)}) on ` +
        `${String(owned.created_at ?? '').slice(0, 10)}${when} — it is billing ` +
        `until \`houston cluster delete ${String(owned.name)}\` removes it`,
      { check: 'kubernetes-cloud-owned' },
    );
  }

  // AND WHEN THE RECORD IS EMPTY BUT THE ACCOUNT IS RIGHT HERE.
  // `cloudReady`, not a `.ready` attribute: the TypeScript preflight carries the facts
  // and the helper decides readiness, so reading a missing property would make this
  // warning unreachable.
  const ready = eks.cloudReady(cloud as never);
  if (remembered.length === 0 && ready) {
    line(
      'kubernetes',
      'warn',
      'this box has no local record of a cloud cluster, which is not ' +
        'the same as there being none — the record is best-effort and a ' +
        'fresh HOUSTON_HOME, a rebuilt box or a create made elsewhere ' +
        `all lose it. The account (${eks.identityPretty((cloud as { identity?: unknown }).identity)}) is reachable ` +
        'from here, so ask AWS instead: `houston cluster list` sweeps ' +
        'every enabled region by tag.',
      { check: 'kubernetes-cloud-owned' },
    );
  }
}

/** The cloud side: what AWS can be asked, and what this box remembers owning. */
async function reportCloudClusters(
  ctx: Ctx,
  line: Report['line'],
  pre: KubeToolsNS.Preflight,
): Promise<void> {
  const eks = await import('./eks');
  // Started at the top of runChecks; usually finished by now.
  const cloud =
    ctx.cloud !== null
      ? ((await ctx.cloud) as Bag)
      : ((await eks.aws.preflight()) as unknown as Bag);
  const remembered =
    ctx.owned !== null ? ((await ctx.owned) as Bag[]) : (eks.remembered() as Bag[]);
  reportOwnedClusters(cloud, line, remembered);

  const tools = Object.values(bagOf(cloud.tools)) as { path?: string }[];
  const onEks = (pre.distribution || '') === 'eks';
  if (onEks || tools.some((tool) => (tool.path ?? '') !== '')) {
    const ready = eks.cloudReady(cloud as never);
    if (ready) {
      // WHICH STAGE, of the six the Clusters page and the overview show: ready is stage 1
      // done, and the row says what stage 2 is and how to do it, or that it is done too.
      const account = String(bagOf(cloud.identity).account ?? '');
      const approved = account !== '' && config.approvedAwsAccounts().has(account);
      const stage = approved
        ? ` — account approved; stage 3 is \`houston cluster create <name> --region ${String(
            cloud.region ?? '',
          )} --zone <your zone>\``
        : ` — stage 2, approve the account for spending: \`houston config set ` +
          `cluster.approved_accounts ${account || '<account id>'}\``;
      line(
        'kubernetes',
        'ok',
        `AWS ready — ${eks.identityPretty(cloud.identity as never)}, region ` +
          `${String(cloud.region ?? '')}${stage}`,
        { check: 'kubernetes-cloud' },
      );
    } else {
      // `fail` only when a cluster in use NEEDS it.
      for (const blocker of eks.blockers(cloud as never, { toBuild: true })) {
        line('kubernetes', onEks ? 'fail' : 'warn', `AWS: ${blocker}`, {
          check: 'kubernetes-cloud',
        });
      }
    }
  }
}

/** Which of the Kubernetes tools are here, and which are too old to trust. */
async function reportToolVersions(
  k8sWorkspaces: string[],
  line: Report['line'],
  needed: CheckStatus,
  pre: KubeToolsNS.Preflight,
): Promise<void> {
  const { missingTools, outdatedTools } = await import('./kube/tools');
  const { TOOL_FLOOR_REASON, DEFAULT_FLOOR_REASON } = await import('./kube/names');
  const { tools: allTools } = await import('./kube/names');
  const missing = missingTools(pre);
  if (missing.length > 0) {
    line(
      'kubernetes',
      'fail',
      `${String(k8sWorkspaces.length)} Kubernetes workspace(s) exist but ` +
        `${missing.join(', ')} is not installed — they ` +
        'cannot be reached or torn down',
      { check: 'kubernetes-tools' },
    );
  }
  const { pretty: prettyTool, toolsReady } = await import('./kube/tools');
  for (const name of outdatedTools(pre)) {
    const got = pre.tools[name] as { raw: string };
    const floor = (allTools()[name] ?? []).join('.');
    const whyFloor = TOOL_FLOOR_REASON[name] ?? DEFAULT_FLOOR_REASON;
    // `Tool.pretty` -- the parsed dotted version when there is one, not the raw first
    // line of the tool's own output.
    line(
      'kubernetes',
      needed,
      `${name} ${prettyTool(got as never)} is older than ${floor}, ${whyFloor}`,
      { check: 'kubernetes-tools' },
    );
  }
  if (toolsReady(pre)) {
    line(
      'kubernetes',
      'ok',
      'Kubernetes tools present (' +
        Object.values(pre.tools)
          .filter((tool) => tool.path !== '')
          .map((tool) => `${tool.name} ${prettyTool(tool)}`)
          .join(', ') +
        ')',
      { check: 'kubernetes-tools' },
    );
  }
}

/** The shared edge, the other clusters on this box, and the inotify headroom. */
async function reportEdgeAndNeighbours(
  line: Report['line'],
  pre: KubeToolsNS.Preflight,
  k8sMethods: { activeContext: () => Promise<string> },
): Promise<void> {
  const { portClaimingCluster } = await import('./kube/endpoints');
  let claim: Awaited<ReturnType<typeof portClaimingCluster>>;
  try {
    claim = await portClaimingCluster({
      contexts: [pre.context, await k8sMethods.activeContext()].filter((c) => c !== ''),
    });
  } catch {
    claim = null;
  }
  if (claim !== null) {
    try {
      const edgeSpec = await import('./edge/spec');
      const installedEdge = edgeSpec.installed();
      const fd = installedEdge ? edgeSpec.current() : null;
      const registered = (await import('./edge/routes')).registered();
      // The GUI's own name is served by the edge too, and on the box where this was
      // measured it was the ONLY affected name.
      const harmed = installedEdge
        ? [...(fd !== null && fd.domain !== '' ? [fd.domain] : []), ...registered]
        : [];
      reportEdgeClaim(claim, harmed, installedEdge, line);
    } catch {
      // a check must not break the report
    }
  }

  // "Other" must exclude the one we just said we are USING.
  const others = pre.otherClusters.filter((c) => `kind-${c}` !== pre.context);
  if (others.length > 0) {
    line(
      'kubernetes',
      'ok',
      `${String(others.length)} other kind cluster(s) on this box ` +
        `(${others.join(', ')}) — houston never deletes ` +
        'a cluster it did not create',
      { check: 'kubernetes-other-clusters' },
    );
  }
  for (const row of inotifyHeadroom(others.length + 1)) {
    line('kubernetes', row[0], row[1], { check: 'inotify' });
  }
}

/** The cluster row and everything under it. */
async function reportCluster(
  ctx: Ctx,
  inUse: boolean,
  k8sWorkspaces: string[],
  line: Report['line'],
  needed: CheckStatus,
  pre: KubeToolsNS.Preflight,
): Promise<void> {
  const { CLUSTER_NAME, CONTEXT } = await import('./kube/names');
  const { missingTools, toolsReady } = await import('./kube/tools');
  const missing = missingTools(pre);
  if (missing.length > 0 && !inUse) {
    // One line, not five.
    line(
      'kubernetes',
      'ok',
      `Kubernetes not set up (${missing.join(', ')} ` +
        `not installed) — Compose workspaces are unaffected`,
      { check: 'kubernetes-tools' },
    );
  } else {
    await reportToolVersions(k8sWorkspaces, line, needed, pre);

    await reportCloudClusters(ctx, line, pre);

    if (pre.clusterReachable) {
      await clusterIdentity(line, pre);
      await clusterCapabilities(line, needed, pre);
      await clusterAddons(line, pre);
    } else if (pre.probeFailed !== '') {
      // NOT "does not exist". `kind` talks to Docker, so this is what a stopped Docker
      // looks like.
      line(
        'kubernetes',
        needed,
        `Could not tell whether cluster ${quotedText(CLUSTER_NAME)} ` +
          `exists (${pre.probeFailed}) — kind needs Docker`,
        { check: 'kubernetes-cluster' },
      );
    } else if (pre.willCreate) {
      await reportClusterToCreate(inUse, k8sWorkspaces, line, pre);
    } else if (pre.context === CONTEXT && pre.clusterExists) {
      line(
        'kubernetes',
        'ok',
        `Cluster ${quotedText(CLUSTER_NAME)} exists and this ` +
          `HOUSTON_HOME has not used it yet, so its kubeconfig is ` +
          `not exported here — the next \`houston up\` exports it ` +
          `and reuses the cluster`,
        { check: 'kubernetes-cluster' },
      );
    } else if (pre.context !== '') {
      // NAMED IS NOT CONFIGURED. `doctor --context no-such-context` passed, calling a context
      // the kubeconfig does not hold "configured but not answering"; `cluster status` says
      // the true thing, and so does this now -- a failure when it was asked for by name.
      const { contexts } = await import('./kube/context');
      const [named, unread] = await contexts();
      if (unread === '' && !named.includes(pre.context)) {
        line(
          'kubernetes',
          ctx.context !== '' ? 'fail' : needed,
          `No kubeconfig context named ${quotedText(pre.context)}` +
            (named.length > 0
              ? `. This machine can see: ${named.map((name) => quotedText(name)).join(', ')}`
              : ', and the kubeconfig names none'),
          { check: 'kubernetes-cluster' },
        );
      } else {
        line(
          'kubernetes',
          needed,
          `Cluster ${quotedText(pre.context)} is configured but its API ` +
            'server is not answering',
          { check: 'kubernetes-cluster' },
        );
      }
    } else if (toolsReady(pre)) {
      // CONTEXTS BUT NO CURRENT ONE is not "nothing configured": a deleted cluster that was
      // current leaves exactly this, and the Clusters page lists the rest as running. houston
      // never picks one by itself, so it says how -- against the file it actually reads.
      const { contexts } = await import('./kube/context');
      const [named] = await contexts();
      if (named.length > 0) {
        const { userEnv } = await import('./kube/exec');
        const file = userEnv()?.KUBECONFIG ?? '';
        const first = named[0] as string;
        line(
          'kubernetes',
          needed,
          'kubectl has no current context, so houston has no cluster to use by default. ' +
            `The kubeconfig names ${named.map((name) => quotedText(name)).join(', ')}: ` +
            `\`kubectl ${file === '' ? '' : `--kubeconfig ${file} `}config use-context ${first}\` ` +
            `makes one the default, or pass \`--context ${first}\` to the command that needs it`,
          { check: 'kubernetes-cluster' },
        );
      } else {
        line(
          'kubernetes',
          needed,
          'No Kubernetes cluster configured — install kind so ' +
            'houston can create one, or point kubectl at an ' +
            'existing cluster (k3s, minikube, Docker Desktop)',
          { check: 'kubernetes-cluster' },
        );
      }
    }
  }
}

export async function checkKubernetes(ctx: Ctx): Promise<Row[]> {
  const report = new Report();
  const line = report.line.bind(report);
  // Severity depends on whether anything USES Kubernetes.
  try {
    const { preflight } = await import('./kube/probe');
    const { activeContext } = await import('./kube/context');
    const k8sWorkspaces = (await listMeta())
      .filter((m: Metadata) => topology.ofMeta(m) === topology.KUBERNETES)
      .map((m: Metadata) => m.name);
    const inUse = k8sWorkspaces.length > 0;
    const needed = inUse ? 'fail' : 'warn';
    const pre = await preflight(ctx.context !== '' ? ctx.context : config.defaultKubeContext());

    await reportCluster(ctx, inUse, k8sWorkspaces, line, needed, pre);

    await reportEdgeAndNeighbours(line, pre, { activeContext });
  } catch {
    line('kubernetes', 'warn', 'Kubernetes status could not be determined');
  }
  return report.rows;
}

// --- orchestration ------------------------------------------------------------

/** Module name -> check. Run in this order; the report is read top to bottom. */
export const RUN_ORDER: readonly (readonly [string, (ctx: Ctx) => Promise<Row[]>])[] =
  Object.freeze([
    ['docker', checkDocker],
    ['compose', checkCompose],
    ['kernel', checkKernel],
    ['hub', checkHub],
    ['disk', checkDisk],
    ['memory', checkMemory],
    ['versions', checkVersions],
    ['ports', checkPorts],
    ['install', checkInstall],
    ['legacy', checkLegacy],
    ['edge', checkEdge],
    ['identity', checkIdentity],
    ['k8s', checkKubernetes],
    ['work', checkWork],
    ['presets', checkPresets],
  ]);

/** Every check in RUN_ORDER, with its rows concatenated. */
export async function runEveryCheck(ctx: Ctx): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [, check] of RUN_ORDER) {
    rows.push(...(await check(ctx)));
  }
  return rows;
}

/**
 * Run every preflight check and return the findings.
 *
 * `context` names the cluster to report on, defaulting to the box's
 * `kubernetes.context`. It must be honoured: a preflight whose job is to predict a boot
 * must not be a second opinion about it.
 */
export async function runChecks(context = ''): Promise<Bag> {
  const ctx: Ctx = { context, dockerUp: false, cloud: null, owned: null };
  // THE AWS PROBE, STARTED NOW AND READ LATER. It is by far the slowest thing this
  // report does (MEASURED at 1783ms of a 2485ms run) and shares nothing with the local
  // checks. Errors are carried, not raised: awaiting inside the
  // check that reads it re-raises there, inside the same `try` the sequential call was
  // in, so a broken `aws` still degrades exactly as it did.
  try {
    const { aws, remembered } = await import('./eks');
    // The promise is CARRIED, so a rejection re-raises where it is awaited, not where it
    // started. A no-op handler is attached to each so the
    // rejection is not ALSO an unhandled-rejection event when a code path (the
    // missing-tools one-liner) never reaches the await; the stored promise keeps
    // rejecting, because `catch` returns a NEW promise and the original is what is kept.
    const cloud = aws.preflight() as unknown as Promise<Bag>;
    const owned = Promise.resolve(remembered()) as Promise<Bag[]>;
    void cloud.catch(() => undefined);
    void owned.catch(() => undefined);
    ctx.cloud = cloud;
    ctx.owned = owned;
  } catch {
    // a report must not fail to start over this
    ctx.cloud = null;
    ctx.owned = null;
  }

  const rows = await runEveryCheck(ctx);
  const counts: Record<string, number> = { ok: 0, warn: 0, fail: 0 };
  for (const row of rows) {
    const status = String(row.status);
    if (status in counts) counts[status] = (counts[status] ?? 0) + 1;
  }
  const verdict = (counts.fail ?? 0) > 0 ? 'fail' : (counts.warn ?? 0) > 0 ? 'warn' : 'ok';

  // Repro tally. Counted through `listRepros()` so doctor's idea of "running" is the
  // dashboard's, not a second opinion.
  let repros: Bag | null = null;
  if (ctx.dockerUp) {
    try {
      const { listRepros } = await import('./lifecycle/inspect');
      const listed = await listRepros();
      if (listed.length > 0) {
        repros = {
          total: listed.length,
          running: listed.filter((r) => r.state === 'running').length,
        };
      }
    } catch {
      repros = null;
    }
  }
  return { checks: rows, counts, verdict, repros };
}
