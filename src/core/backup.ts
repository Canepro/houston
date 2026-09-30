/**
 * Back up and restore a repro's Rocket.Chat database — shared by CLI and web API.
 *
 * Built on `mongodump --archive` / `mongorestore --archive`, the procedure the official docs
 * describe for Docker deployments, with three deliberate changes:
 *
 *   --drop   the docs omit it, so a restore MERGES into the existing collections and
 *            leaves a hybrid of two databases that looks fine and behaves wrongly.
 *   --db     scopes the dump to Rocket.Chat's own database, so `admin`/`local` never
 *            travel and the target's replica-set configuration is left alone.
 *   --gzip   a seeded repro's dump is large; roughly a 10x saving for one flag.
 *
 * Rocket.Chat is also STOPPED for the duration of both operations. `mongodump` is
 * not point-in-time consistent across collections, so a dump taken while RC writes
 * can capture a half-finished state; and dropping collections under a live writer
 * is what --drop exists to prevent. Mongo itself keeps running throughout.
 *
 * A backup is a BUNDLE, not a bare dump. Restoring an 8.5 database into a 6.x
 * workspace fails in ways that are hard to trace, so the manifest travels with the
 * archive and `restore` refuses or warns before touching anything.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import {
  ConflictError,
  DockerError,
  NotFoundError,
  NotReadyError,
  ReproError,
  ValidationError,
  errorText,
} from '../lib/errors';
import { type Emit, info, nullEmit, warn } from '../lib/events';
import { pathExpandUser, joinPath } from '../lib/home';
import { JsonFloat, dumpsIndented, getHoustonVersion } from '../lib/jsonout';
import {
  formatFixed,
  pathIsDir,
  floatString,
  toInt,
  fileErrorText,
  strerrorText,
  quotedText,
  shownValue,
  isTruthy,
  roundSeconds,
} from '../lib/format';
import { loads } from '../lib/json-text';
import { mkdirParents } from '../lib/mkdir-parents';
import { makeTempDir } from '../lib/tempdir';
import { Interrupted, cleanup, unwindsOnInterrupt } from '../seams/exec';
import {
  BadGzip,
  UnsafeBundleEntry,
  extractTarGz,
  gzipFailure,
  readMember,
  writeTarGzFromDir,
} from '../lib/targz';

import * as audit from './audit';
import { compatibility } from './backup-compat';
import * as journal from './journal';
import { login } from './lifecycle/admin';
import { createRepro } from './lifecycle/create-docker';
import { resolveName, sanitize } from './lifecycle/naming';
import { mayDestroy } from './lifecycle/ownership';
import { requireDocker } from './lifecycle/preconditions';
import { waitAndFinalize, waitServing } from './lifecycle/ready';
import { type CreateReq, createReq } from './lifecycle/types';
import { getSetting, setSetting } from './rcapi';
import {
  composeExecCapture,
  composeExecFromFile,
  composeExecToFile,
  startServices,
  stopServices,
} from './runner/engine';
import { exists } from './runner/paths';
import { DEFAULT_DATABASE, databaseOf } from './database-of';
import { workspace } from './runner/paths';
import {
  type Metadata,
  adminPass,
  readCompose,
  readMeta,
  rcServices,
  updateMeta,
} from './runner/record';
import * as topology from './topology';

type Bag = Record<string, unknown>;

/** Bundle layout. `schema` is checked on read. */
export const SCHEMA = 1;
export const SUFFIX = '.rcbak';
export const MANIFEST = 'manifest.json';
export const ARCHIVE = 'mongo.archive.gz';
export const COMPOSE = 'compose.yml';
export const RECORD = 'repro.json';
export const FILES_DIR = 'files';

export const MONGO_SERVICE = 'mongodb';

export const DUMP_TIMEOUT = 3600.0;
export const PROBE_TIMEOUT = 30.0;

function bagOf(value: unknown): Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Bag;
}

/** Stop Rocket.Chat dead; the note is what a killed process leaves behind. */
export async function repairStopped(
  entry: journal.Entry,
  _emit: Emit,
  _login: unknown,
): Promise<boolean> {
  const context = String(entry.detail.context ?? '');
  if (context !== '') {
    const { scaleRocketchat } = await import('./kube/scale');
    // A falsy recorded count (0, '', null) means 1, and a recorded string that is not an
    // integer throws out of the handler -- `toInt` refuses it rather than silently falling
    // back to 1.
    const recorded = entry.detail.replicas;
    const replicas = isTruthy(recorded) ? toInt(recorded) : 1;
    return (await scaleRocketchat(entry.workspace, { replicas, context })) === 0;
  }
  const services = Array.isArray(entry.detail.services)
    ? entry.detail.services.map((name) => String(name))
    : [];
  return services.length > 0 && (await startServices(entry.workspace, services)) === 0;
}

export function installJournalRepairs(): void {
  journal.registerRepair(journal.ROCKETCHAT_STOPPED, repairStopped);
}

export function backupsDir(): string {
  // `config.home() / "backups"`, and every workspace path below joined the same way:
  // `path.join` folded a `..` in the home that the kernel resolves through a symlink, so a
  // backup went into a directory `backups` never lists.
  const dir = joinPath(config.home(), 'backups');
  // Made with its parents, the mode 0700 on the leaf only.
  mkdirParents(dir, 0o700);
  return dir;
}

/** The current UTC time as `YYYYMMDD-HHMMSS`. */
export function utcStamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

/**
 * The database this workspace uses, hoisted to `core/database-of.ts` so `mongoprof`
 * and `scaleseed` can reach it without an upward edge. Re-exported here so it stays
 * reachable as `backup.databaseOf`.
 */
export { DEFAULT_DATABASE, databaseOf } from './database-of';
/**
 * The kube context for a Kubernetes workspace, or '' if it is a Compose one.
 *
 * One question asked in one place. backup's LOGIC -- the bundle format, the manifest,
 * the safety checks -- is runtime-agnostic and stays shared; only the five places that
 * actually touch a container differ, and each consults this.
 */
export async function kube(name: string): Promise<string> {
  if ((await topology.ofRepro(name)) !== topology.KUBERNETES) return '';
  const meta = await readMeta(name);
  const extra = bagOf(meta.extra);
  const { CONTEXT } = await import('./kube/names');
  return String(isTruthy(extra[config.EXTRA_CONTEXT]) ? extra[config.EXTRA_CONTEXT] : CONTEXT);
}

/**
 * A timeout in SECONDS, as the constants here state it, for a compose seam that takes
 * MILLISECONDS. `PROBE_TIMEOUT` (30.0) and `DUMP_TIMEOUT` (3600.0) reached
 * `composeExecCapture` / `composeExecToFile` / `composeExecFromFile` unconverted, so the tools
 * probe, the `ulimit -n` probe and the drop were killed after 30 ms and every mongodump and
 * mongorestore after 3.6 s: on a real engine every compose backup, restore, rollback and
 * pre-upgrade backup was refused, and a rollback had already rewritten the workspace to the old
 * version when it was. Converted here, at the call into the seam, so the constants keep
 * their established names and values; the Kubernetes branch converts in `kube/transfer.ts`.
 */
function composeTimeoutMs(timeout?: number): number | undefined {
  return timeout === undefined ? undefined : timeout * 1000;
}

async function execCapture(
  name: string,
  argv: readonly string[],
  timeout?: number,
): Promise<[number, string]> {
  const context = await kube(name);
  if (context !== '') {
    const { execCapture: kubeExecCapture } = await import('./kube/transfer');
    return await kubeExecCapture(name, argv, {
      context,
      ...(timeout !== undefined ? { timeout } : {}),
    });
  }
  return await composeExecCapture(name, MONGO_SERVICE, argv, composeTimeoutMs(timeout));
}

async function execToFile(
  name: string,
  argv: readonly string[],
  dest: string,
  timeout?: number,
): Promise<[number, string]> {
  const context = await kube(name);
  if (context !== '') {
    const { execToFile: kubeExecToFile } = await import('./kube/transfer');
    return await kubeExecToFile(name, argv, dest, {
      context,
      ...(timeout !== undefined ? { timeout } : {}),
    });
  }
  return await composeExecToFile(name, MONGO_SERVICE, argv, dest, composeTimeoutMs(timeout));
}

async function execFromFile(
  name: string,
  argv: readonly string[],
  src: string,
  timeout?: number,
): Promise<[number, string]> {
  const context = await kube(name);
  if (context !== '') {
    const { execFromFile: kubeExecFromFile } = await import('./kube/transfer');
    return await kubeExecFromFile(name, argv, src, {
      context,
      ...(timeout !== undefined ? { timeout } : {}),
    });
  }
  return await composeExecFromFile(name, MONGO_SERVICE, argv, src, composeTimeoutMs(timeout));
}

/**
 * Credential flags for the database tools, empty unless the operator manages it.
 *
 * The hand-written StatefulSet runs without authentication, so both paths existed and
 * only one was exercised until an audit ran the operator too.
 */
export async function mongoAuth(name: string): Promise<string[]> {
  const context = await kube(name);
  if (context === '') return [];
  const meta = await readMeta(name);
  if (bagOf(meta.extra).mongo_managed_by !== 'operator') return [];
  const { mongoToolAuth } = await import('./kube/operator');
  return await mongoToolAuth(name, { context });
}

/**
 * Fail early and clearly if the Mongo image has no database tools.
 *
 * Verified present in mongodb/mongodb-community-server; checked rather than assumed
 * because the bitnami-legacy flavor is a different image and a missing binary would
 * otherwise surface as an empty archive.
 */
export async function requireMongoTools(name: string): Promise<void> {
  const [rc] = await execCapture(
    name,
    ['sh', '-c', 'command -v mongodump && command -v mongorestore'],
    PROBE_TIMEOUT,
  );
  if (rc !== 0) {
    throw new NotReadyError(
      `the mongodb for ${quotedText(name)} has no mongodump/mongorestore, or is ` +
        'not running. Start the repro (`houston start`) and try again.',
    );
  }
}

/** mongod's own recommended minimum. Below this a big restore risks EMFILE. */
export const NOFILE_MIN = 64000;

export async function warnLowFdLimit(name: string, emit: Emit = nullEmit): Promise<number> {
  const [rc, out] = await execCapture(name, ['sh', '-c', 'ulimit -n'], PROBE_TIMEOUT);
  let limit: number;
  try {
    // The first line, trimmed, read by `toInt`, which throws for both an empty string and
    // a line that is not a decimal integer.
    const first = out.trim().split(/\r?\n/u)[0] as string;
    limit = toInt(first);
  } catch {
    return 0;
  }
  if (rc === 0 && limit < NOFILE_MIN) {
    warn(
      emit,
      `this repro's mongodb can open only ${String(limit)} files ` +
        `(MongoDB asks for ${String(NOFILE_MIN)}). Restoring anyway, one collection ` +
        `at a time. Recreate it with \`houston up --force --name ${name}\` to ` +
        'pick up the raised limit.',
      { phase: 'restore' },
    );
  }
  return limit;
}

export async function rcServicesOf(name: string): Promise<string[]> {
  // On Kubernetes there is no compose file to read service names out of, and none is
  // needed: `Quiesced` scales by label instead. The list is a Compose concept, so it
  // is empty there rather than faked.
  if ((await kube(name)) !== '') return [];
  const svcs = await rcServices(name);
  if (svcs.length === 0) {
    throw new DockerError(`${quotedText(name)} has no rocketchat service in its compose file`);
  }
  return svcs;
}

/**
 * Stop Rocket.Chat for the duration, and start it again no matter what.
 *
 * A failed dump that leaves the workspace stopped is a worse outcome than the failure
 * itself -- the user came back to a repro that silently is not serving.
 */
export class Quiesced {
  note = '';

  constructor(
    readonly name: string,
    readonly services: readonly string[],
    readonly emit: Emit,
    readonly skip = false,
  ) {}

  async enter(): Promise<this> {
    if (this.skip) {
      warn(
        this.emit,
        '--live: Rocket.Chat keeps running, so the dump may catch a ' +
          'half-written state. Prefer the default for anything you ' +
          'intend to restore.',
        { phase: 'backup' },
      );
      return this;
    }
    info(this.emit, 'stopping Rocket.Chat so the dump is consistent (Mongo keeps running)', {
      phase: 'backup',
      pct: 10,
    });
    const context = await kube(this.name);
    // BEFORE it goes down, and carrying what will bring it back. `exit` starts it again
    // "no matter what" -- except the one case where nothing runs at all: a daemon job
    // thread killed by a restart or an OOM. This note is what lets a later `serve` or
    // `doctor` see it and fix it.
    this.note = journal.record(journal.ROCKETCHAT_STOPPED, this.name, {
      context,
      replicas: 1,
      services: [...this.services],
    });
    if (context !== '') {
      const { scaleRocketchat } = await import('./kube/scale');
      // ONLY Rocket.Chat. `stopWorkspace` would take MongoDB with it, and a dump needs
      // the database up and only its writers quiesced.
      await scaleRocketchat(this.name, { replicas: 0, context });
      const meta = await readMeta(this.name);
      const pid = bagOf(meta.extra).port_forward_pid;
      if (isTruthy(pid)) {
        const { namespaceFor } = await import('./kube/namespace');
        const { stopPortForward } = await import('./lifecycle/ready');
        // `toInt(pid)`: a recorded pid that is not an integer throws rather than silently
        // becoming 0.
        stopPortForward(toInt(pid), { namespace: await namespaceFor(this.name) });
        await updateMeta(this.name, (m) => {
          delete bagOf(m.extra).port_forward_pid;
        });
      }
    } else {
      await stopServices(this.name, this.services);
    }
    return this;
  }

  /**
   * The way out, which runs on the way out of an Interrupted too: a Ctrl-C in the dump
   * starts Rocket.Chat again, clears the note and waits for it to serve, as it always has,
   * where this build's `process.exit(130)` left the workspace STOPPED, its
   * `rocketchat_stopped` note on disk for `doctor` to warn about, and mongodump running.
   * A `cleanup`, so its waits -- `compose start rocketchat` among them -- start after the
   * interrupt.
   */
  async exit(): Promise<void> {
    if (this.skip) return;
    await cleanup(async () => await this.restart());
  }

  private async restart(): Promise<void> {
    const context = await kube(this.name);
    let failed: boolean;
    if (context !== '') {
      const { scaleRocketchat } = await import('./kube/scale');
      failed = (await scaleRocketchat(this.name, { replicas: 1, context })) !== 0;
    } else {
      failed = (await startServices(this.name, this.services)) !== 0;
    }
    if (failed) {
      warn(
        this.emit,
        `Rocket.Chat did not come back up on ${quotedText(this.name)} - the data is ` +
          `safe, but the workspace is stopped. Start it with ` +
          `\`houston start --name ${this.name}\`.`,
        { phase: 'backup' },
      );
      return;
    }
    journal.clear(this.note);
    // Rocket.Chat has been STARTED, which is not the same as serving. `waitServing` is
    // runtime-aware and re-establishes the forward, so one call covers both runtimes.
    try {
      await waitServing(await readMeta(this.name), this.emit, 300.0);
    } catch (exc) {
      // Any failure but a Ctrl-C: an Interrupted in the wait leaves `exit` here, and
      // the bundle is never packed. Caught, it was this warning, then "packing the bundle",
      // a bundle written and "✓ backed up", then exit 130.
      if (exc instanceof Interrupted) throw exc;
      warn(
        this.emit,
        `the dump is complete, but ${quotedText(this.name)} is not serving on its ` +
          `published port again (${errorText(exc)}). Run ` +
          `\`houston ready --name ${this.name}\` to bring it back.`,
        { phase: 'backup' },
      );
    }
  }
}

// --- create -------------------------------------------------------------------

/** Dump a repro's database into a bundle. Returns {path, bytes, manifest}. */
export async function create(
  name: string,
  {
    out = '',
    note = '',
    live = false,
    emit = nullEmit,
  }: { out?: string; note?: string; live?: boolean; emit?: Emit } = {},
): Promise<Bag> {
  const target = await resolveName(name);
  // Docker is required only when Docker is what runs it. Everything below this is
  // runtime-agnostic: the bundle, the manifest and the safety checks are the same on
  // both, and only the five places that touch a container differ.
  if ((await kube(target)) === '') await requireDocker();
  const { reproLock } = await import('./runner/locks');
  // UNWOUND by a Ctrl-C: through `Quiesced.exit`, the staging directory's removal and the
  // lock's release. The one catch on the way, `composeExecToFile`'s, answers the
  // interrupted dump as a failed one (`[1, 'Interrupted']`), and the `finally` after
  // it is the cleanup either way; the
  // DockerError it then raises is answered as the interrupt it came from (see `runCli`).
  return await unwindsOnInterrupt(
    async () =>
      await reproLock(target, async () => await createLocked(target, { out, note, live, emit })),
  );
}

/**
 * The path with a leading `~` or `~name` expanded, and spelled as `pathExpandUser` spells
 * it: every caller-supplied bundle and `--out` goes through it before anything touches the
 * filesystem. It replaced a leading `~` with the home by `path.join`, so `~bob/x` was the
 * current user's `bob/x`, a trailing `/` and a doubled one printed where the established
 * spelling has neither, a path with no `~` was not normalised at all, and a HOME holding
 * `..` was folded.
 */
export function expandUser(value: string): string {
  return pathExpandUser(value);
}

async function dumpToBundle({
  database,
  dest,
  emit,
  live,
  meta,
  note,
  services,
  target,
  ws,
}: {
  database: string;
  dest: string;
  emit: Emit;
  live: boolean;
  meta: Metadata;
  note: string;
  services: readonly string[];
  target: string;
  ws: string;
}): Promise<Bag> {
  // A fresh `houston-backup-` directory in the temporary directory `tempRoot` settles
  // on, not in `$TMPDIR` as given -- a TMPDIR that is gone was an ENOENT stack where the
  // established behaviour falls back to /tmp.
  const staging = makeTempDir('houston-backup-');
  try {
    const archive = path.join(staging, ARCHIVE);
    let rc: number;
    let err: string;
    let started = 0;
    const quiesced = new Quiesced(target, services, emit, live);
    await quiesced.enter();
    try {
      info(emit, `dumping database ${quotedText(database)}`, { phase: 'backup', pct: 30 });
      started = performance.now();
      [rc, err] = await execToFile(
        target,
        ['mongodump', '--archive', '--gzip', '--db', database, ...(await mongoAuth(target))],
        archive,
        DUMP_TIMEOUT,
      );
    } finally {
      await quiesced.exit();
    }
    if (rc !== 0) {
      throw new DockerError(
        `mongodump failed for ${quotedText(target)}: ${err.trim().slice(0, 600)}`,
      );
    }
    if (!fs.existsSync(archive) || fs.statSync(archive).size === 0) {
      throw new DockerError(
        `mongodump produced an empty archive for database ${quotedText(database)} - ` +
          'is this repro seeded, and is MONGO_URL correct?',
      );
    }

    const manifest: Bag = {
      schema: SCHEMA,
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/u, '+00:00'),
      houston_version: ourVersion(),
      repro: target,
      label: note,
      database,
      rc_version: meta.rcVersion,
      rc_image: meta.rcImage,
      mongo_tag: meta.mongoTag,
      mongo_flavor: meta.mongoFlavor,
      preset: meta.preset,
      params: bagOf(meta.extra).params ?? {},
      runtime: topology.ofMeta(meta),
      deployment: bagOf(meta.extra)[config.EXTRA_DEPLOYMENT] ?? '',
      env_overrides: bagOf(meta.extra).env ?? {},
      sidecar_volumes: await sidecarVolumes(target),
      archive_sha256: sha256File(archive),
      archive_bytes: fs.statSync(archive).size,
      // Seconds on a monotonic clock, rounded to 1 place, half to even.
      dump_seconds: roundSeconds(performance.now() - started),
      live,
    };
    fs.writeFileSync(path.join(staging, MANIFEST), serialiseManifest(manifest), 'utf8');
    // `copyWithMetadata`, which keeps the file's mode and times: `copyFileSync` kept the mode and
    // made every copy's mtime "now", so the bundle recorded the time of the backup for the
    // compose file, the record and every preset file.
    const times = new Map<string, bigint>();
    for (const [src, dst] of [
      [joinPath(ws, 'docker-compose.yml'), COMPOSE],
      [joinPath(ws, 'repro.json'), RECORD],
    ] as [string, string][]) {
      if (fs.existsSync(src)) copyWithMetadata(src, path.join(staging, dst), times);
    }
    copyPresetFiles(ws, path.join(staging, FILES_DIR), times);

    info(emit, 'packing the bundle', { phase: 'backup', pct: 85 });
    await writeTarGzFromDir(staging, dest, { mtimeNs: times });
    return manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function createLocked(
  target: string,
  {
    out = '',
    note = '',
    live = false,
    emit = nullEmit,
  }: { out?: string; note?: string; live?: boolean; emit?: Emit } = {},
): Promise<Bag> {
  const meta = await readMeta(target);
  await requireMongoTools(target);
  const database = await databaseOf(target);
  const services = await rcServicesOf(target);

  let dest =
    out !== '' ? expandUser(out) : joinPath(backupsDir(), `${target}-${utcStamp()}${SUFFIX}`);
  if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
    dest = joinPath(dest, `${target}-${utcStamp()}${SUFFIX}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    throw new ConflictError(`${dest} already exists; pass a different --out`);
  }

  const ws = workspace(target);
  const manifest = await dumpToBundle({
    database,
    dest,
    emit,
    live,
    meta,
    note,
    services,
    target,
    ws,
  });

  fs.chmodSync(dest, 0o600); // the dump contains every message and credential hash
  const size = fs.statSync(dest).size;
  info(emit, `backup written to ${dest} (${human(size)})`, { phase: 'done', pct: 100 });
  return { name: target, path: dest, bytes: size, manifest };
}

/**
 * The version this build reports as its own.
 *
 * This build has no installed-package metadata to read until it is packaged, so it
 * reports `jsonout`'s registry value, which the front door sets from the package and
 * which defaults to the placeholder.
 */
export function ourVersion(): string {
  return getHoustonVersion();
}

export async function sidecarVolumes(name: string): Promise<string[]> {
  let doc: Bag;
  try {
    doc = await readCompose(name);
  } catch {
    return [];
  }
  return Object.keys(bagOf(doc.volumes))
    .filter((volume) => volume !== 'mongodb_data')
    .sort();
}

/**
 * A file's times, then its mode, copied onto its copy. The times should be exact to the
 * nanosecond; `utimes` here keeps microseconds, so the exact mtime is also put in `times`,
 * keyed by the copy, for `writeTarGzFromDir` to record as the copy's.
 */
function copyMetadata(src: string, dst: string, times: Map<string, bigint>): void {
  const st = fs.statSync(src, { bigint: true });
  fs.utimesSync(dst, Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9);
  times.set(dst, st.mtimeNs);
  fs.chmodSync(dst, Number(st.mode) & 0o7777);
}

/** A file copied with its status: the bytes, then `copyMetadata`. */
function copyWithMetadata(src: string, dst: string, times: Map<string, bigint>): void {
  fs.copyFileSync(src, dst);
  copyMetadata(src, dst, times);
}

/** Every entry `copyTree` could not copy, as `(src, dst, why)` triples; `why` names the file. */
class TreeCopyError extends Error {
  constructor(readonly failures: readonly [string, string, string][]) {
    super(`could not copy ${failures.map((row) => row[2]).join('; ')}`);
    this.name = 'Error';
  }
}

/**
 * A tree copied into `dst`, which may already exist: a link is copied as what it points to,
 * a directory recursively, a file with `copyWithMetadata`, and the directory itself gets `copyMetadata`
 * LAST, after its entries were written -- so its mode and mtime are the source's.
 * `fs.cpSync` left every directory at the umask's mode and "now". A failure is collected
 * and the rest still copied, then thrown together as one `TreeCopyError`.
 */
function copyTree(src: string, dst: string, times: Map<string, bigint>): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dst, { recursive: true });
  const failures: [string, string, string][] = [];
  const collect = (error: unknown, from: string, to: string): void => {
    if (error instanceof TreeCopyError) failures.push(...error.failures);
    else if (typeof (error as NodeJS.ErrnoException).errno === 'number') {
      failures.push([from, to, fileErrorText(error, from)]);
    } else throw error;
  };
  for (const entry of entries) {
    const srcname = path.join(src, entry.name);
    const dstname = path.join(dst, entry.name);
    try {
      const directory = entry.isSymbolicLink() ? pathIsDir(srcname) : entry.isDirectory();
      if (directory) copyTree(srcname, dstname, times);
      else copyWithMetadata(srcname, dstname, times);
    } catch (error) {
      collect(error, srcname, dstname);
    }
  }
  try {
    copyMetadata(src, dst, times);
  } catch (error) {
    collect(error, src, dst);
  }
  if (failures.length > 0) throw new TreeCopyError(failures);
}

/**
 * Copy preset-generated workspace files (traefik/dynamic.yml, LDIF, ...).
 *
 * Deliberately excludes `import/`: those are customers' uploaded settings dumps,
 * transient by design, and a backup is not where they should accumulate.
 *
 * `times` collects the exact mtime of every copy (see `copyMetadata`).
 */
export function copyPresetFiles(
  ws: string,
  dest: string,
  times: Map<string, bigint> = new Map(),
): void {
  const skip = new Set(['docker-compose.yml', 'repro.json', 'import']);
  for (const item of fs.readdirSync(ws)) {
    if (skip.has(item) || item.startsWith('.')) continue;
    const source = joinPath(ws, item);
    fs.mkdirSync(dest, { recursive: true });
    // `pathIsDir`, which follows a link and is false for one that dangles.
    if (pathIsDir(source)) {
      copyTree(source, path.join(dest, item), times);
    } else {
      copyWithMetadata(source, path.join(dest, item), times);
    }
  }
}

/**
 * The manifest as bundles have always carried it: indented by 2, keys sorted.
 *
 * The shared renderer in `lib/jsonout` does the hard parts -- recursive key sorting,
 * escaping everything past ASCII -- so this and the `--json` envelope cannot drift. What is
 * left here is the one thing a manifest knows that a JSON encoder cannot: `dump_seconds`
 * is a float, and an integral one is written with its `.0`.
 */
export function serialiseManifest(manifest: Bag): string {
  const value: Bag = { ...manifest };
  if ('dump_seconds' in value) {
    value.dump_seconds = new JsonFloat(Number(value.dump_seconds ?? 0));
  }
  return dumpsIndented(value, 2);
}

export function human(n: number): string {
  // The `.0f` / `.1f` formats round half to EVEN; `toFixed` is half AWAY FROM ZERO.
  // Measured: 1280 bytes has always read `1.2 KB`, and was `1.3 KB` here.
  // `formatFixed` is the one implementation of those format specs.
  let value = n;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (value < 1024 || unit === 'GB') {
      return unit === 'B' ? `${formatFixed(value, 0)} ${unit}` : `${formatFixed(value, 1)} ${unit}`;
    }
    value /= 1024.0;
  }
  return `${formatFixed(value, 1)} GB`;
}

// --- read / list ----------------------------------------------------------------

/**
 * A caller-supplied bundle path, as a path that is safe to stat.
 *
 * The path reaches here from a CLI argument or a JSON body, so every filesystem call
 * on it has to be guarded: a 300-character name raises ENAMETOOLONG and an unreadable
 * file raises EPERM, and both used to escape as a 500 rather than the "that is not a
 * bundle" this is.
 */
export function bundlePath(bundle: string): string {
  // Outside the `try`: a NotFoundError and an OS error are all it catches, so a `~name`
  // nobody has is an unhandled `HomeUnknown`, not "not a usable path".
  const resolved = expandUser(bundle);
  try {
    if (!pathExists(resolved)) {
      throw new NotFoundError(`no backup bundle at ${resolved}`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new ValidationError(
      `${quotedText(String(bundle).slice(0, 120))} is not a usable path: ${fileErrorText(error)}`,
    );
  }
}

/**
 * Whether a path exists: false only for the errors that mean "not there" (ENOENT, ENOTDIR,
 * EBADF, ELOOP), and any other thrown.
 *
 * `fs.existsSync` answers false for EVERY failure, so a 300-character name -- ENAMETOOLONG
 * -- was reported as a missing bundle (404, exit 4) where the established answer refuses it
 * as a path that cannot be used (400, exit 2), which is what it is.
 */
function pathExists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code ?? '');
    if (['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'].includes(code)) return false;
    throw error;
  }
}

/** The manifest of a bundle, without unpacking the archive. */
export async function readManifest(bundle: string): Promise<Bag> {
  const target = bundlePath(bundle);
  let raw: Buffer | null;
  try {
    raw = await readMember(target, MANIFEST);
  } catch (error) {
    // The unsafe-entry check throws its own refusal out of `readManifest` untouched -- it
    // is not an archive error, an OS error or a JSON error -- so this is not wrapped in the
    // "not a readable bundle" prose either. `UnsafeBundleEntry` already IS the
    // established `ValidationError`, message included.
    if (error instanceof UnsafeBundleEntry) throw error;
    const message = errorText(error);
    const gzip = gzipFailure(error);
    if (gzip?.truncated === true) {
      throw new ValidationError(
        `${target} ends part-way through: it is truncated, or still being written. ` +
          `(${gzip.text})`,
      );
    }
    if (gzip !== null) {
      // An archive that cannot be read: not gzip at all, or corrupt data inside it.
      throw new ValidationError(`${target} is not a readable backup bundle: ${gzip.text}`);
    }
    if ((error as NodeJS.ErrnoException).code !== undefined) {
      // A filesystem error -- unreadable, a directory, a device node: "not a bundle", not a bug.
      throw new ValidationError(
        `${target} cannot be read as a backup bundle: ${strerrorText(error, target)}`,
      );
    }
    throw new ValidationError(`${target} is not a readable backup bundle: ${message}`);
  }
  if (raw === null) {
    throw new ValidationError(`${target} has no ${MANIFEST}; is it an houston backup?`);
  }
  let data: unknown;
  try {
    // `loads`, the shared decoder with the established messages: a malformed manifest is
    // refused in the words it has always been refused in, and `Unexpected end of JSON
    // input` is not that sentence.
    data = loads(raw.toString('utf8'));
  } catch (error) {
    throw new ValidationError(`${target} has a malformed ${MANIFEST}: ${errorText(error)}`);
  }
  const manifest = data as Bag;
  const schema = manifest.schema;
  // The schema compares with `true` equal to 1: a manifest carrying `"schema": true` has
  // always been accepted, so it is accepted here rather than refused for a shape never
  // objected to before. The message quotes with `shownValue`, so a string schema reads
  // `'2'`, as it always has.
  const schemaMatches =
    schema === SCHEMA || (typeof schema === 'boolean' && Number(schema) === SCHEMA);
  if (!schemaMatches) {
    throw new ValidationError(
      `${target} uses bundle schema ${shownValue(schema)}, this houston reads ${String(SCHEMA)}. ` +
        'Use the version of houston that wrote it.',
    );
  }
  return manifest;
}

/**
 * Bundles in the managed directory, newest first.
 *
 * A bundle whose manifest cannot be read is still listed, marked with `error`:
 * silently hiding it is how a corrupt backup gets discovered at the worst moment.
 */
/**
 * The `*.rcbak` bundles in `backupsDir()`: in DIRECTORY order, as the directory hands them
 * over -- the listing's mtime sort is stable, so bundles of one mtime keep it, where a
 * sorted readdir put them in name order -- and none from a directory that cannot be read,
 * which lists as empty (an EACCES here was a stack and exit 1 where the established answer
 * is "no backups yet"). Names are read as BYTES and stat'ed as bytes: a file name that is
 * not UTF-8 decoded to a U+FFFD that named no file, and the stat of it crashed. Its
 * manifest is still read by the decoded name, so such a bundle is listed UNREADABLE ("no
 * backup bundle at ..."), where the previous implementation reads it; a JavaScript string
 * cannot carry the byte back out.
 */
function bundleFiles(): { full: Buffer; shown: string }[] {
  // `opendirSync`, not `readdirSync`: libuv's scandir SORTS the names it returns, where
  // opendir reads them in the order the directory holds them.
  // Decoded as latin1, one character per byte, so the bytes come back whole.
  const entries: Buffer[] = [];
  try {
    const handle = fs.opendirSync(backupsDir(), { encoding: 'latin1' });
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        entries.push(Buffer.from(entry.name, 'latin1'));
      }
    } finally {
      handle.closeSync();
    }
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).errno !== 'number') throw error;
    return [];
  }
  const dir = Buffer.from(`${backupsDir()}${path.sep}`);
  return entries
    .filter((entry) => entry.toString('latin1').endsWith(SUFFIX))
    .map((entry) => {
      const full = Buffer.concat([dir, entry]);
      return { full, shown: full.toString('utf8') };
    });
}

/** The manifest's value for `key`, or "" when it has none: a held null stays null. */
function field(m: Bag, key: string): unknown {
  return Object.hasOwn(m, key) ? m[key] : '';
}

export async function listBackups(name = ''): Promise<Bag[]> {
  const out: Bag[] = [];
  for (const { full, shown } of bundleFiles()) {
    const stat = fs.statSync(full);
    const row: Bag = { path: shown, bytes: stat.size, mtime: stat.mtimeMs / 1000 };
    try {
      const m = await readManifest(shown);
      Object.assign(row, {
        repro: field(m, 'repro'),
        label: field(m, 'label'),
        rc_version: field(m, 'rc_version'),
        created_at: field(m, 'created_at'),
        mongo_tag: field(m, 'mongo_tag'),
        preset: field(m, 'preset'),
        error: '',
      });
    } catch (error) {
      if (!(error instanceof ValidationError) && !(error instanceof NotFoundError)) throw error;
      Object.assign(row, {
        repro: '',
        label: '',
        rc_version: '',
        created_at: '',
        mongo_tag: '',
        preset: '',
        error: String((error as Error).message),
      });
    }
    if (name !== '' && row.repro !== name) continue;
    out.push(row);
  }
  // Bundles OUTLIVE the workspace they came from, but they are matched to one by NAME,
  // and houston derives names from the version -- so recreating a workspace reliably
  // produces the same name as a destroyed one. They are still listed, and marked.
  let born = '';
  if (name !== '') {
    try {
      born = String((await readMeta(name)).createdAt || '');
    } catch {
      born = '';
    }
  }
  for (const row of out) {
    row.predates_workspace = Boolean(
      born !== '' &&
      row.created_at !== undefined &&
      row.created_at !== '' &&
      String(row.created_at) < born,
    );
  }
  return out.sort((left, right) => Number(right.mtime) - Number(left.mtime));
}

// --- restore -----------------------------------------------------------------------

/**
 * Refuse a restore over somebody else's workspace, and record the refusal.
 *
 * One helper because `restore` learns its target two ways -- from `name`, before
 * anything is read, and from the bundle's manifest afterwards.
 */
export async function requireMayDestroy(target: string): Promise<void> {
  const [allowed, why] = await mayDestroy(target, audit.actor());
  if (!allowed) {
    audit.record('restore', target, { outcome: 'denied' });
    throw new ConflictError(why);
  }
}

/** Create the bundle's workspace, then explain clearly if its load fails. */
export async function restoreNew(
  target: string,
  bundle: string,
  manifest: Bag,
  emit: Emit,
  { allowUpgrade, force }: { allowUpgrade: boolean; force: boolean },
): Promise<Bag> {
  const { reproLock } = await import('./runner/locks');
  return await reproLock(target, async () => {
    await createFromManifest(target, manifest, emit);
    try {
      return await restoreLocked(target, bundle, manifest, emit, {
        allowUpgrade,
        force,
        created: true,
      });
    } catch (error) {
      if (!(error instanceof ReproError)) throw error;
      // The workspace was created before the load failed, so it exists and is EMPTY.
      // Left unsaid, that reads as "the command did nothing".
      const Cartridge = error.constructor as new (message: string) => ReproError;
      throw new Cartridge(
        `${error.message}\n  note: ${quotedText(target)} was created and is running, ` +
          `but empty. Retry with \`houston restore <bundle> --name ${target}\`, or remove ` +
          `it with \`houston down --name ${target} --volumes --yes\`.`,
      );
    }
  });
}

/**
 * Restore a bundle into a repro.
 *
 * Three target modes: in place (`restore(b)`), new (`restore(b, { new: true })`), other
 * (`restore(b, { name: 'other' })`).
 */
export async function restore(
  bundle: string,
  {
    name = '',
    new: isNew = false,
    allowUpgrade = false,
    force = false,
    emit = nullEmit,
  }: { name?: string; new?: boolean; allowUpgrade?: boolean; force?: boolean; emit?: Emit } = {},
): Promise<Bag> {
  // Docker only when Docker is what runs the TARGET. `new=true` has no target yet, so
  // it is checked below once the name is known -- and restoring into a fresh workspace
  // still creates a Compose one, because a bundle carries no runtime.
  const existing = name !== '' && !isNew ? await resolveName(name) : '';
  // Authorisation FIRST, when the target is already known.
  if (existing !== '') await requireMayDestroy(existing);
  if (!(existing !== '' && (await kube(existing)) !== '')) await requireDocker();
  const bundleFile = expandUser(bundle);
  const manifest = await readManifest(bundleFile);

  if (isNew) {
    const newName = name !== '' ? sanitize(name) : await deriveNewName(manifest);
    return await restoreNew(newName, bundleFile, manifest, emit, { allowUpgrade, force });
  }

  const wanted = name !== '' ? name : String(manifest.repro ?? '');
  let resolved: string;
  try {
    resolved = await resolveName(wanted);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    throw new NotFoundError(`${error.message} - pass --new to create it from the bundle instead`);
  }
  await requireMayDestroy(resolved);
  const { reproLock } = await import('./runner/locks');
  return await reproLock(
    resolved,
    async () =>
      await restoreLocked(resolved, bundleFile, manifest, emit, {
        allowUpgrade,
        force,
        created: false,
      }),
  );
}

/**
 * Empty the target database so the restore is exact, not a merge.
 *
 * Uses the shell the repro's own Mongo image ships (mongosh from 5.0; `mongo` before
 * that), so this works on both flavors.
 */
export async function dropDatabase(
  name: string,
  database: string,
  emit: Emit = nullEmit,
): Promise<void> {
  const meta = await readMeta(name);
  let shell = 'mongosh';
  try {
    // `toInt` of the tag's major part, which keeps the default `mongosh` when the tag does
    // not parse (`4x` throws, where `parseInt` would answer 4).
    const major = toInt(String(meta.mongoTag).split('.')[0] ?? '');
    if (major < 5) shell = 'mongo';
  } catch {
    /* not a version; mongosh is the default */
  }
  info(emit, `dropping database ${quotedText(database)} so the restore is exact`, {
    phase: 'restore',
    pct: 40,
  });
  const [rc, out] = await execCapture(
    name,
    [shell, database, '--quiet', ...(await mongoAuth(name)), '--eval', 'db.dropDatabase()'],
    PROBE_TIMEOUT,
  );
  if (rc !== 0) {
    // Not fatal: --drop below still clears every collection the bundle carries.
    warn(
      emit,
      `could not drop ${quotedText(database)} first (${out.trim().slice(0, 200)}); ` +
        'collections absent from the bundle may survive',
      { phase: 'restore' },
    );
  }
}

export async function deriveNewName(manifest: Bag): Promise<string> {
  const base = sanitize(`${String(manifest.repro ?? '') || 'restored'}-restored`);
  let candidate = base;
  let n = 2;
  while (await exists(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/** Materialise a workspace matching the bundle, then leave it ready to load. */
export async function createFromManifest(target: string, manifest: Bag, emit: Emit): Promise<void> {
  if (await exists(target)) {
    throw new ConflictError(
      `${quotedText(target)} already exists; drop --new to restore into it, or pass ` +
        '--name for a different one',
    );
  }
  info(
    emit,
    `creating ${quotedText(target)} at Rocket.Chat ${String(manifest.rc_version ?? '')} ` +
      `(preset ${String(manifest.preset ?? '') || 'default'})`,
    { phase: 'create', pct: 5 },
  );
  // An archive that recorded its axes rebuilds from them; an older one falls back to
  // inferring them from the preset name. The preset comes from the manifest in BOTH
  // branches.
  const deployment = manifest.deployment;
  const axes: Partial<CreateReq> =
    deployment !== undefined && deployment !== null && String(deployment) !== ''
      ? {
          runtime: String(manifest.runtime ?? ''),
          deployment: String(deployment),
          preset: String(manifest.preset ?? '') || 'default',
        }
      : { preset: String(manifest.preset ?? '') || 'default' };
  const req = createReq({
    version: String(manifest.rc_version ?? ''),
    name: target,
    ...axes,
    mongo: String(manifest.mongo_tag ?? ''),
    params: bagOf(manifest.params),
    env: bagOf(manifest.env_overrides) as Record<string, string | null>,
    wait: true,
  });
  await createRepro(req, emit);
}

/**
 * Safely unpack and checksum the Mongo archive before touching the target.
 *
 * GUARDED, where an early version was not: a file truncated AFTER the manifest
 * member passes `readManifest` and fails here, and an unwrapped gzip error leaves the
 * ReproError contract. Nothing is lost either way -- this is still the staging step.
 */
export async function unpackArchive(
  bundle: string,
  staging: string,
  manifest: Bag,
): Promise<string> {
  const truncationMessage = `${bundle} ends part-way through: it is truncated, or still being written`;
  try {
    await extractTarGz(bundle, staging);
  } catch (error) {
    // Same as `readManifest`: the unsafe-entry refusal is not caught -- it is not an
    // archive error, not an OS error and not a JSON error -- so it reads the same here, with
    // no "could not be unpacked" wrapper.
    if (error instanceof UnsafeBundleEntry) throw error;
    // Nor is `BadGzip` -- a trailer read past the end of the deflate data whose CRC
    // disagrees, or a second member that is not gzip: an OS error, which the unpack does
    // not catch either, so it is an unhandled error, as it always was.
    if (error instanceof BadGzip) throw error;
    const message = errorText(error);
    const gzip = gzipFailure(error);
    if (gzip?.truncated === true) {
      throw new ValidationError(`${truncationMessage}. Nothing has been restored. (${gzip.text})`);
    }
    throw new ValidationError(
      `${bundle} could not be unpacked: ${gzip?.text ?? message}. Nothing has been restored.`,
    );
  }
  const archive = path.join(staging, ARCHIVE);
  if (!fs.existsSync(archive)) {
    throw new ValidationError(`${bundle} has no ${ARCHIVE}; is it an houston backup?`);
  }
  const expected = String(manifest.archive_sha256 ?? '');
  if (expected !== '' && sha256File(archive) !== expected) {
    throw new ValidationError(
      `${bundle} is corrupt: the archive does not match its recorded checksum`,
    );
  }
  return archive;
}

/**
 * Drop and load the database while Rocket.Chat is durably quiesced.
 *
 * `--numParallelCollections=1`: the default of 4 builds four collections' indexes at
 * once, and on a repro whose mongod still has Docker's default 1024 open-file limit
 * that hit EMFILE inside WiredTiger -- which PANICS and aborts mongod rather than
 * failing the one operation, leaving the restore half-applied.
 */
export async function restoreArchive({
  database,
  emit,
  manifest,
  bundle,
  services,
  target,
  archive,
}: {
  database: string;
  emit: Emit;
  manifest: Bag;
  bundle: string;
  services: readonly string[];
  target: string;
  archive: string;
}): Promise<number> {
  const sourceDb = String(manifest.database ?? '') || DEFAULT_DATABASE;
  // One collection at a time keeps old repros with Docker's 1024 fd limit alive.
  const argv = [
    'mongorestore',
    '--archive',
    '--gzip',
    '--drop',
    '--numParallelCollections=1',
    ...(await mongoAuth(target)),
  ];
  if (sourceDb !== database) {
    argv.push(`--nsFrom=${sourceDb}.*`, `--nsTo=${database}.*`);
    info(emit, `remapping database ${quotedText(sourceDb)} -> ${quotedText(database)}`, {
      phase: 'restore',
    });
  }
  const quiesced = new Quiesced(target, services, emit);
  await quiesced.enter();
  let rc: number;
  let out: string;
  let elapsed: number;
  try {
    // --drop is NOT enough on its own: a collection that exists here but is absent
    // from the bundle survives. NOTED BEFORE THE DROP: between here and mongorestore
    // returning, the workspace has NO data, and `Quiesced` only journals
    // ROCKETCHAT_STOPPED.
    const dropNote = journal.record(journal.DATABASE_DROPPED, target, {
      bundle,
      database,
    });
    await dropDatabase(target, database, emit);
    info(emit, `restoring into database ${quotedText(database)}`, {
      phase: 'restore',
      pct: 50,
    });
    const started = performance.now();
    [rc, out] = await execFromFile(target, argv, archive, DUMP_TIMEOUT);
    elapsed = roundSeconds(performance.now() - started);
    if (rc === 0) {
      journal.clear(dropNote);
    }
  } finally {
    await quiesced.exit();
  }
  if (rc !== 0) {
    throw new DockerError(
      `mongorestore failed for ${quotedText(target)}: ${out.trim().slice(-800)}`,
    );
  }
  return elapsed;
}

/** Unpack the bundle and restore the database over the running workspace. */
export async function loadFromBundle({
  database,
  emit,
  manifest,
  bundle,
  services,
  target,
}: {
  database: string;
  emit: Emit;
  manifest: Bag;
  bundle: string;
  services: readonly string[];
  target: string;
}): Promise<number> {
  // A fresh `houston-restore-` directory, under `tempRoot()` as the backup's is.
  const staging = makeTempDir('houston-restore-');
  try {
    info(emit, 'unpacking the bundle', { phase: 'restore', pct: 20 });
    const archive = await unpackArchive(bundle, staging, manifest);
    return await restoreArchive({
      database,
      emit,
      manifest,
      bundle,
      services,
      target,
      archive,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function restoreLocked(
  target: string,
  bundle: string,
  manifest: Bag,
  emit: Emit,
  { allowUpgrade, force, created }: { allowUpgrade: boolean; force: boolean; created: boolean },
): Promise<Bag> {
  const meta = await readMeta(target);
  const compat = compatibility(manifest, meta);
  if (!compat.allowed && !force) {
    throw new ValidationError(compat.blocked_reason + ' Pass --force to try anyway.');
  }
  if (compat.requires_flag === 'allow_upgrade' && !(allowUpgrade || force)) {
    throw new ValidationError(
      `${compat.warnings[0] ?? ''} Pass --allow-upgrade if that is what you want.`,
    );
  }
  for (const line of compat.warnings) {
    warn(emit, line, { phase: 'restore' });
  }

  await requireMongoTools(target);
  await warnLowFdLimit(target, emit);
  const database = await databaseOf(target);
  const services = await rcServicesOf(target);

  const elapsed = await loadFromBundle({
    database,
    emit,
    manifest,
    bundle,
    services,
    target,
  });

  // A duration rounded to one place is always written with its decimal point, so an
  // integral one is `0.0s` / `5.0s`; `String` of the same JavaScript number printed `0s`,
  // about one real restore in ten.
  info(emit, `restored in ${floatString(elapsed)}s; waiting for Rocket.Chat`, {
    phase: 'restore',
    pct: 85,
  });
  const result = await waitAndFinalize(await readMeta(target), emit, 300.0, false);
  await retargetSiteUrl(target, emit);
  info(emit, `${quotedText(target)} restored from ${path.basename(bundle)}`, {
    phase: 'done',
    pct: 100,
  });
  return {
    name: target,
    bundle,
    created,
    database,
    restore_seconds: elapsed,
    from_version: compat.from_version,
    to_version: compat.to_version,
    direction: compat.direction,
    warnings: compat.warnings,
    url: result.url ?? '',
  };
}

export async function deleteBackup(bundle: string): Promise<Bag> {
  const target = bundlePath(bundle);
  // Compared UNRESOLVED on purpose: traversal is rejected by this either way, and
  // resolving would refuse a symlink sitting in the backups directory -- a reasonable
  // way to keep bundles on another disk, whose unlink removes only the link.
  if (path.dirname(target) !== backupsDir()) {
    throw new ValidationError(
      `${target} is not in the managed backup directory; delete it yourself`,
    );
  }
  try {
    fs.unlinkSync(target);
  } catch (error) {
    throw new ValidationError(`could not delete ${target}: ${strerrorText(error, target)}`);
  }
  return { deleted: target };
}

/**
 * Point a restored workspace's Site_Url at ITSELF.
 *
 * A restore is a full mongorestore, so the bundle's `Site_Url` comes with it and
 * ROOT_URL does not override a stored setting. Rocket.Chat derives email links,
 * OAuth/SAML/OIDC redirect URIs, integration callbacks and mobile deep links from it,
 * so a restored workspace advertising the SOURCE's URL sends every one of them to the
 * wrong place. Best-effort: a restore that worked must not fail because one setting
 * could not be rewritten.
 */
export async function retargetSiteUrl(target: string, emit: Emit = nullEmit): Promise<void> {
  try {
    const meta = await readMeta(target);
    const want = meta.publicUrl || meta.rootUrl;
    if (want === '') return;
    const auth = await login(meta);
    const current = await getSetting(meta.rootUrl, auth, adminPass(meta), 'Site_Url');
    if (typeof current === 'string' && current.replace(/\/+$/u, '') === want.replace(/\/+$/u, '')) {
      return;
    }
    if (await setSetting(meta.rootUrl, auth, adminPass(meta), 'Site_Url', want)) {
      info(
        emit,
        `Site_Url retargeted from ${quotedText(String(current))} to ${quotedText(want)} - ` +
          `the bundle carried the source workspace's address`,
        { phase: 'restore' },
      );
    } else {
      warn(
        emit,
        `Site_Url still reads ${quotedText(String(current))}, which is the workspace this ` +
          'bundle came from - Rocket.Chat builds email links and OAuth ' +
          'redirects from it. Set it in Admin > General.',
        { phase: 'restore' },
      );
    }
  } catch (exc) {
    warn(
      emit,
      `could not check Site_Url after the restore (${errorText(exc)}); if this ` +
        `bundle came from another workspace it still names that one`,
      { phase: 'restore' },
    );
  }
}
