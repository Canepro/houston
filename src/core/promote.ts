/**
 * Promote an exclusively-owned home to `dual-v1`, or refuse and leave it alone.
 *
 * One side of a two-sided protocol; the other is the previous implementation's. The
 * operation's whole purpose is that EITHER implementation can perform it and each refuses
 * while the other is performing it. A protocol only one side implements is not a protocol.
 *
 * `IMPLEMENTATION` holds the marker value earlier releases write or `typescript`, and each
 * build refuses a home the other owns. `dual-v1` is the third value and it means something
 * specific -- **every state format in this home has been read by both builds and they
 * agreed**. It is the recorded result of a check, and this module is the check.
 *
 * **Why it is a migration, not an assignment.** Between "the formats validate" and "the
 * marker says dual-v1" there is a window, and a kill inside it must not leave a home
 * nobody can classify. So the operation writes `IMPLEMENTATION.transition` FIRST and
 * removes it LAST, every command in both builds refuses while it exists
 * (`lock.transitionReason`), and the three reachable end states are all explainable:
 *
 *     journal + exclusive marker  -> interrupted before the swap; recover() re-validates
 *     journal + dual-v1           -> the swap landed, the cleanup did not; recover() tidies
 *     no journal                  -> nothing in flight, whatever the marker says
 *
 * **How quiescence is established**, in this order and for this reason:
 *
 *   1. the journal appears, so no command that STARTS from now on will do anything;
 *   2. `serve` is asked for -- a live GUI has work the locks do not represent, and its
 *      in-memory caches would outlive the marker it was started under;
 *   3. all five state locks are taken, in the fixed order `lock.LOCK_ORDER` names, so
 *      anything already in flight has finished.
 *
 * (1) closes the future and (3) closes the past. Neither alone is quiescence.
 *
 * **Both readers, really both.** `validateHome()` reads every format with THIS build's
 * real readers. The peer build's answer comes from the command named by
 * `HOUSTON_PEER_VALIDATOR`. With no peer configured there is no second reader and
 * promotion REFUSES -- a marker that says two builds agreed must never be written on the
 * strength of one.
 */
import * as fs from 'fs';
import * as path from 'path';

import type * as AuditNS from './audit';
import type * as BackupNS from './backup';
import type * as JournalNS from './journal';
import type * as RecordNS from './runner/record';
import type * as SessionsNS from './sessions';
import type * as UsersNS from './users';
import type * as EdgeSpecNS from './edge/spec';
import { PROJECT as EDGE_PROJECT } from './edge/paths';
import type * as FirstrunNS from './firstrun';
import type * as TlsNS from './tls';
import type * as ConfigNS from '../lib/config';
import { ConflictError, PreflightError, ValidationError } from '../lib/errors';
import { type Emit, event, nullEmit } from '../lib/events';
import { joinPath } from '../lib/home';
import * as lock from '../lib/lock';
import type * as ExecNS from '../seams/exec';
import { withFileLock } from '../seams/fs/lock';

/**
 * The command that validates a home with the OTHER build. It receives the home as its
 * last argument and must print one JSON document of the shape `validateHome` returns.
 */
export const PEER_ENV = 'HOUSTON_PEER_VALIDATOR';

/** Written by `serve` while it runs, so promotion can tell a live GUI from a stale file. */
export const SERVE_PID_NAME = 'serve.pid';

/**
 * The document version. A peer that answers a different one has not been taught this
 * protocol, and disagreeing about the QUESTION is not the same as disagreeing about the
 * answer -- so it is reported as a refusal rather than as a format mismatch.
 */
export const SUMMARY_SCHEMA = 'houston.state.validation.v1';

/**
 * `SERVE_PID_NAME` under the home. Every path in this module is joined onto the home
 * component by component, a `..` kept as written (`joinPath`), because `path.join` folds
 * a `..` in the home that the kernel -- and so the previous implementation -- resolves
 * through a symlink: an earlier version validated a different directory from the one the
 * previous implementation validates.
 */
export function servePidPath(home: string): string {
  return joinPath(home, SERVE_PID_NAME);
}

/**
 * The pid of a live `serve` against this home, or null.
 *
 * A STALE file is not a live server: `serve` removes it on a clean exit and a kill -9
 * leaves it behind. `process.kill(pid, 0)` asks the kernel instead of trusting the file,
 * so a crashed GUI from last week does not block a promotion forever.
 */
export function serveIsRunning(home: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(servePidPath(home), 'utf8').trim();
  } catch {
    return null;
  }
  // `toInt`'s question, not `parseInt`'s: a trailing-garbage pid is not a pid.
  if (!/^\d+$/u.test(raw)) return null;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM is alive and owned by somebody else, which is still alive.
    if (code === 'EPERM') return pid;
    return null;
  }
  return pid;
}

// ------------------------------------------------------------------- the five locks

/**
 * Every per-workspace runner lock, in sorted name order.
 *
 * The runner's lock is per repro, so "all five" expands here. Sorted, because the ORDER
 * is the deadlock-avoidance property and sorting is the one ordering both builds reach
 * without sharing a data structure.
 */
function workspaceLockNames(home: string): string[] {
  const repros = joinPath(home, 'repros');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repros, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => `locks/${name}.lock`);
}

/**
 * The established state locks, expanded in order, followed by the shared edge lock.
 *
 * Relative to the home so the two implementations' answers can be compared as strings:
 * "the same order" is only checkable if each can say what its order IS.
 */
export function lockPaths(home: string): string[] {
  const out: string[] = [];
  for (const entry of lock.LOCK_ORDER) {
    if (entry === 'locks/<workspace>.lock') out.push(...workspaceLockNames(home));
    else out.push(entry);
  }
  // Shared edge mutations run after their caller's workspace lock. Promotion must
  // wait for edge-only operations too, without changing the established peer order.
  out.push(`locks/${EDGE_PROJECT}.lock`);
  return out;
}

/**
 * Hold the established state locks and then the shared edge lock, released in reverse.
 *
 * Recursive rather than a loop, because `withFileLock` is scoped: each lock has to stay
 * held for the duration of the next one's acquisition and of the body, and unwinding has
 * to happen in reverse whether the body returned or threw. A loop would need the release
 * callbacks stored and replayed by hand, which is where the unwinding order goes wrong.
 */
export async function withAllStateLocks<T>(
  home: string,
  body: (held: string[]) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const wanted = lockPaths(home);
  const held: string[] = [];

  const take = async (index: number): Promise<T> => {
    if (index >= wanted.length) return body(held);
    const relative = wanted[index] as string;
    const target = joinPath(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.closeSync(fs.openSync(target, 'a', 0o600));
    try {
      return await withFileLock(
        target,
        async () => {
          held.push(relative);
          return take(index + 1);
        },
        { timeoutMs },
      );
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ValidationError) throw error;
      throw new ConflictError(
        `another houston process is still holding ${relative} ` +
          `(waited ${String(Math.round(timeoutMs / 1000))}s). Promotion needs this home ` +
          'quiet: stop any running command or `houston serve`, then retry.',
      );
    }
  };

  return take(0);
}

// ---------------------------------------------------------------------- validation

export interface ValidationSummary {
  schema: string;
  /**
   * WHICH BUILD ANSWERED. Without it, a peer validator pointed at the SAME build would
   * compare a build with itself, agree every time, and write a marker claiming two
   * builds had checked the home. The agreement is only worth anything if the two answers
   * come from different implementations.
   */
  build: string;
  formats: Record<string, unknown>;
}

/**
 * Read every state format in this home with THIS build's real readers.
 *
 * Deliberately made of what each READER answers rather than of file bytes: two builds
 * agreeing about bytes they both misread is not the property `dual-v1` claims.
 *
 * A format that is ABSENT is reported as absent, never as a default. That distinction is
 * what `repro.json` is built on -- an absent `extra.runtime` means docker -- and a
 * validator that filled it in would be asserting the very thing it is meant to check.
 */
export async function validateHome(home: string): Promise<ValidationSummary> {
  // CALL-TIME requires: `config.home()` is read when these modules load, and this function
  // is handed a home that is not necessarily the ambient one.
  const previous = process.env.HOUSTON_HOME;
  process.env.HOUSTON_HOME = home;
  try {
    const config = require('../lib/config') as typeof ConfigNS;
    const users = require('./users') as typeof UsersNS;
    const sessions = require('./sessions') as typeof SessionsNS;
    const audit = require('./audit') as typeof AuditNS;
    const record = require('./runner/record') as typeof RecordNS;
    const backup = require('./backup') as typeof BackupNS;
    const journal = require('./journal') as typeof JournalNS;

    const formats: Record<string, unknown> = {};

    const cfg = config.loadConfig(false);
    formats.config = {
      present: fs.existsSync(joinPath(home, 'config.yaml')),
      keys: Object.keys(cfg).sort(),
      values: Object.fromEntries(
        Object.keys(cfg)
          .sort()
          .map((key) => [key, canonical(cfg[key])]),
      ),
    };

    const accounts = users.listUsers();
    formats.users = {
      present: fs.existsSync(users.usersFile()),
      names: accounts.map((row) => row.name).sort(),
      // The role, NOT the hash. A validation document is written to a journal and
      // printed by a peer process; the question here is whether both builds read the
      // same accounts, not whether a password verifies.
      roles: Object.fromEntries(accounts.map((row) => [row.name, row.role])),
      created: Object.fromEntries(accounts.map((row) => [row.name, row.createdAt])),
    };

    formats.sessions = {
      present: fs.existsSync(sessions.sessionsFile()),
      sids: sessionSids(sessions),
    };

    const page = audit.read({ limit: 100_000 });
    formats.audit = {
      present: fs.existsSync(audit.auditPath()),
      records: page.lines.map((row) => [row.actor, row.kind, row.label, row.origin, row.outcome]),
    };

    formats.workspaces = await workspaces(home, record);
    formats.backups = await backups(backup);
    formats.journal = journalEntries(journal);
    formats.eventlog = eventlogState(home);
    // The rest of the table. Read as DIRECTORY CONTENTS and the few decoded fields a
    // reader branches on, rather than as bytes: a certificate and a CA key are random by
    // construction, and what the two builds have to agree about is which files are there
    // and what the JSON beside them says.
    formats.firstrun = firstrunState();
    formats.edge = edgeState(home);
    formats.acme = acmeState();
    formats.ca = caState();
    formats.clusters = clustersState(home);
    formats.presets = presetsState(config);

    return { schema: SUMMARY_SCHEMA, build: lock.THIS_IMPLEMENTATION, formats };
  } finally {
    if (previous === undefined) delete process.env.HOUSTON_HOME;
    else process.env.HOUSTON_HOME = previous;
  }
}

function sessionSids(sessions: typeof SessionsNS): string[] {
  let text: string;
  try {
    text = fs.readFileSync(sessions.sessionsFile(), 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split('\n')) {
    // The module's own line parser, not a second one written here.
    const parsed = sessions.parse(line);
    if (parsed !== null) out.push(parsed.sid);
  }
  return out.sort();
}

async function workspaces(home: string, record: typeof RecordNS): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let names: string[];
  try {
    names = fs
      .readdirSync(joinPath(home, 'repros'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return out;
  }
  for (const name of names) {
    let meta;
    try {
      meta = await record.readMeta(name);
    } catch (error) {
      out[name] = { error: (error as Error).constructor.name };
      continue;
    }
    const extra = meta.extra as Record<string, unknown>;
    const env = extra.env;
    const isEnv = env !== null && typeof env === 'object' && !Array.isArray(env);
    out[name] = {
      // KEY PRESENCE, separately from the values: an absent `extra.runtime` means docker
      // and an absent `extra.last_upgrade_backup` means nothing to restore, so a build
      // that materialised either would differ HERE even though every resolved value
      // still matched.
      extraKeys: Object.keys(extra).sort(),
      adminPass: record.adminPass(meta),
      rcVersion: meta.rcVersion,
      hostPort: meta.hostPort,
      envKeys: isEnv ? Object.keys(env as Record<string, unknown>).sort() : null,
      envNullKeys: isEnv
        ? Object.keys(env as Record<string, unknown>)
            .filter((key) => (env as Record<string, unknown>)[key] === null)
            .sort()
        : null,
    };
  }
  return out;
}

async function backups(backup: typeof BackupNS): Promise<Record<string, unknown>> {
  try {
    const rows = await backup.listBackups();
    return {
      bundles: rows
        .map((row) => [path.basename(String(row.path)), row.repro ?? '', row.error ?? ''])
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    };
  } catch (error) {
    return { error: (error as Error).constructor.name };
  }
}

function journalEntries(journal: typeof JournalNS): Record<string, unknown> {
  try {
    return {
      entries: journal
        .openEntries()
        .map((entry) => [entry.kind, entry.workspace])
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    };
  } catch (error) {
    return { error: (error as Error).constructor.name };
  }
}

function eventlogState(home: string): Record<string, unknown> {
  const directory = joinPath(home, 'logs');
  let names: string[];
  try {
    names = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith('houston.log'))
      .sort();
  } catch {
    return { files: [], records: 0 };
  }
  let records = 0;
  for (const name of names) {
    try {
      for (const line of fs.readFileSync(joinPath(directory, name), 'utf8').split('\n')) {
        if (line.trim() !== '') records += 1;
      }
    } catch {
      continue;
    }
  }
  return { files: names, records };
}

/**
 * Presence and SHAPE only. The file holds a one-shot credential's digest, and a
 * validation document is written to a journal and printed by a peer process.
 */
function firstrunState(): Record<string, unknown> {
  const firstrun = require('./firstrun') as typeof FirstrunNS;
  const target = firstrun.keyPath();
  if (!fs.existsSync(target)) return { present: false };
  const lines = fs.readFileSync(target, 'utf8').split('\n');
  return {
    present: true,
    headers: lines.filter((line) => line.startsWith('#')),
    rows: lines.filter((line) => line !== '' && !line.startsWith('#')).length,
    mode: fs.statSync(target).mode & 0o777,
  };
}

function edgeState(home: string): Record<string, unknown> {
  const spec = require('./edge/spec') as typeof EdgeSpecNS;
  let routes: string[];
  try {
    routes = fs.readdirSync(joinPath(home, 'edge', 'routes')).sort();
  } catch {
    routes = [];
  }
  return { domain: spec.servedDomain(), configured: spec.current() !== null, routes };
}

function acmeState(): Record<string, unknown> {
  const tls = require('./tls') as typeof TlsNS;
  const issued = joinPath(tls.acmeDir(), 'issued.json');
  if (!fs.existsSync(issued)) return { present: false };
  try {
    const data: unknown = JSON.parse(fs.readFileSync(issued, 'utf8'));
    const isObject = data !== null && typeof data === 'object' && !Array.isArray(data);
    return { present: true, hosts: isObject ? Object.keys(data).sort() : null };
  } catch {
    return { present: true, malformed: true };
  }
}

/**
 * File names and modes. The PEM BYTES are openssl's and random by construction -- what
 * another build reads is whether the CA is there and usable.
 */
function caState(): Record<string, unknown> {
  const tls = require('./tls') as typeof TlsNS;
  const directory = tls.caDir();
  let names: string[];
  try {
    names = fs.readdirSync(directory).sort();
  } catch {
    return { present: false, files: [] };
  }
  return {
    present: true,
    files: names.map((name) => [name, fs.statSync(joinPath(directory, name)).mode & 0o777]),
  };
}

function clustersState(home: string): Record<string, unknown> {
  try {
    return { names: fs.readdirSync(joinPath(home, 'clusters')).sort() };
  } catch {
    return { names: [] };
  }
}

/**
 * USER-AUTHORED preset files. Neither build writes these; both read them, and a
 * disagreement about which exist is a disagreement about what `up --preset` can do.
 */
function presetsState(config: typeof ConfigNS): Record<string, unknown> {
  try {
    return { names: fs.readdirSync(config.presetDir()).sort() };
  } catch {
    return { names: [] };
  }
}

/** The wire shape the two builds compare. */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') {
    const held = value as number;
    if (Number.isNaN(held)) return { $float: 'nan' };
    if (held === Infinity) return { $float: 'inf' };
    if (held === -Infinity) return { $float: '-inf' };
    return held;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return { $datetime: value.toISOString() };
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return String(value);
}

/**
 * What the OTHER build makes of this home.
 *
 * Through the exec seam, because that is the only module allowed to spawn anything: the
 * seam owns quoting, the timeout and the error typing, and a second subprocess site here
 * would be a fourth place to get those subtly different.
 */
export async function peerValidate(home: string): Promise<ValidationSummary> {
  const command = (process.env[PEER_ENV] ?? '').trim();
  if (command === '') {
    throw new ValidationError(
      `${PEER_ENV} is not set, so there is no second reader and nothing to validate ` +
        `against. A '${lock.DUAL_IMPLEMENTATION}' marker says both builds have read ` +
        'every format in this home and agreed; it must not be written on one build’s ' +
        'word. Set it to the command that validates a home with the other build.',
    );
  }
  const exec = require('../seams/exec') as typeof ExecNS;
  const parts = splitCommand(command);
  if (parts.length === 0) {
    throw new ValidationError(`${PEER_ENV} is set but holds no command.`);
  }
  const argv: [string, ...string[]] = [parts[0] as string, ...parts.slice(1), home];
  const result = await exec.capture(argv, { timeoutMs: 300_000, encoding: 'utf8' });
  if (result.exitCode !== 0) {
    throw new ValidationError(
      `the peer validator (${command}) exited ${String(result.exitCode)} and this home ` +
        `cannot be promoted until it succeeds: ${String(result.stderr ?? '')
          .trim()
          .slice(0, 400)}`,
    );
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(String(result.stdout ?? ''));
  } catch (error) {
    throw new ValidationError(
      `the peer validator (${command}) did not print one JSON document: ${String(error)}`,
    );
  }
  const record = loaded as { schema?: unknown; build?: unknown } | null;
  if (record !== null && typeof record === 'object' && record.build === lock.THIS_IMPLEMENTATION) {
    throw new ValidationError(
      `the peer validator (${command}) is the '${lock.THIS_IMPLEMENTATION}' build, which ` +
        `is this build. A '${lock.DUAL_IMPLEMENTATION}' marker says TWO implementations ` +
        'read this home and agreed; one build agreeing with itself is not that, and it ' +
        `would agree whatever either of them got wrong. Point ${PEER_ENV} at the other build.`,
    );
  }
  if (record === null || typeof record !== 'object' || record.schema !== SUMMARY_SCHEMA) {
    throw new ValidationError(
      `the peer validator answered schema ${JSON.stringify(record?.schema ?? null)}, this ` +
        `build speaks ${JSON.stringify(SUMMARY_SCHEMA)}. The two builds disagree about ` +
        'the QUESTION, which is not something a state comparison can resolve.',
    );
  }
  return loaded as ValidationSummary;
}

/** `shlex.split` for the shapes a validator command actually takes. */
function splitCommand(command: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return out;
}

/** Every path at which the two validation documents disagree. */
export function differences(ours: ValidationSummary, theirs: ValidationSummary): string[] {
  const out: string[] = [];
  const walk = (left: unknown, right: unknown, at: string): void => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      left !== null &&
      right !== null &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const keys = [
        ...new Set([
          ...Object.keys(left as Record<string, unknown>),
          ...Object.keys(right as Record<string, unknown>),
        ]),
      ].sort();
      for (const key of keys) {
        walk(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          `${at}.${key}`,
        );
      }
      return;
    }
    out.push(at === '' ? '$' : at);
  };
  walk(ours.formats, theirs.formats, '');
  return out;
}

// -------------------------------------------------------------------- the operation

/** What `recover` answers: a promotion result, or the three keys of an early answer. */
export type RecoverResult = Omit<PromoteResult, 'promoted'> & { promoted?: boolean };

export interface PromoteResult {
  marker: string | null;
  promoted: boolean;
  from?: string;
  reason?: string;
  locks?: string[];
  recovered?: boolean;
}

/**
 * Promote this home to `dual-v1`, or refuse and leave it exactly as it was.
 *
 * The order is the contract and every step is here in it. The journal is removed on
 * EVERY failure path, because a refusal that left it behind would lock the operator out
 * of their own home for a reason that no longer applies.
 */
export async function promote(
  home: string,
  {
    emit = nullEmit,
    timeoutMs = 30_000,
    peer = 'required',
  }: { emit?: Emit; timeoutMs?: number; peer?: 'required' | 'optional' } = {},
): Promise<PromoteResult> {
  const found = lock.readImplementation(home);
  if (found === lock.DUAL_IMPLEMENTATION) {
    emit(event(`${home} is already ${lock.DUAL_IMPLEMENTATION}`, { phase: 'preflight', pct: 100 }));
    return { marker: found, promoted: false, reason: 'already-dual' };
  }
  if (found === null) {
    throw new ValidationError(
      `${lock.markerPath(home)} names no owner, so there is nothing to promote. Run a ` +
        'command against this home first, or check HOUSTON_HOME.',
    );
  }
  if (found !== lock.THIS_IMPLEMENTATION && found !== 'python') {
    throw new ValidationError(
      `${lock.markerPath(home)} says '${found}', which is not a marker this build ` +
        'understands. Refusing rather than rewriting it: an unrecognised marker is ' +
        'evidence, and promotion is not a repair tool.',
    );
  }

  // 1. THE JOURNAL FIRST, and the exclusive marker untouched. From this instant every
  //    command in both builds refuses, so nothing new can start writing.
  const record = {
    schema: SUMMARY_SCHEMA,
    from: found,
    to: lock.DUAL_IMPLEMENTATION,
    started_by: `${lock.THIS_IMPLEMENTATION}:${String(process.pid)}`,
    started_at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
  };
  if (!lock.beginTransition(home, record)) {
    throw new ConflictError(
      lock.transitionReason(home) ?? `${lock.transitionPath(home)} already exists`,
    );
  }
  emit(event('transition journal written', { phase: 'preflight', pct: 10 }));

  try {
    return await runPromotion(home, found, emit, timeoutMs, peer);
  } catch (error) {
    // EVERY failure path: the journal is removed and the original marker is still
    // whatever it was. A refusal must leave the home usable, and the marker is
    // deliberately not touched before this point.
    lock.clearTransition(home);
    throw error;
  }
}

async function runPromotion(
  home: string,
  found: string,
  emit: Emit,
  timeoutMs: number,
  peer: 'required' | 'optional',
): Promise<PromoteResult> {
  // 2. No live `serve`. Its jobs are work the locks do not represent, and its caches
  //    would outlive the marker it was started under.
  const pid = serveIsRunning(home);
  if (pid !== null) {
    throw new ConflictError(
      `\`houston serve\` is running against this home (pid ${String(pid)}). Promotion ` +
        'needs the home quiet, and a live GUI holds state in memory that would outlive ' +
        'the marker it started under. Stop it, then retry.',
    );
  }
  emit(event('no serve running', { phase: 'preflight', pct: 20 }));

  await withAllStateLocks(
    home,
    async (held) => {
      // 3. All five, in the fixed order. Anything already in flight has now finished.
      emit(event(`holding ${String(held.length)} state locks`, { phase: 'preflight', pct: 40 }));

      // 4. Both readers, under those locks, on a home nothing else can move. Only this
      //    build ships, so for the marker window an adoption asks a peer only when one is
      //    configured: this build's reading of every format, under every lock, is the
      //    validation a home the previous implementation left gets.
      const ours = await validateHome(home);
      emit(event('this build read every format', { phase: 'plan', pct: 60 }));
      if (peer === 'optional' && (process.env[PEER_ENV] ?? '').trim() === '') {
        emit(
          event('no peer configured: the other build is retired, this reading stands', {
            phase: 'plan',
            pct: 85,
          }),
        );
      } else {
        const theirs = await peerValidate(home);
        emit(event('the peer build read every format', { phase: 'plan', pct: 75 }));

        const diverged = differences(ours, theirs);
        if (diverged.length > 0) {
          const extra = diverged.length <= 12 ? '' : ` (and ${String(diverged.length - 12)} more)`;
          throw new ValidationError(
            'the two builds do not agree about this home, so it cannot become ' +
              `'${lock.DUAL_IMPLEMENTATION}'. They differ at: ${diverged.slice(0, 12).join(', ')}${extra}.`,
          );
        }
        emit(event('both builds agree about every format', { phase: 'plan', pct: 85 }));
      }

      // 5. Only now. Atomic replace, then fsync the DIRECTORY so the entry survives a
      //    power loss and not just the contents.
      lock.writeMarker(home, lock.DUAL_IMPLEMENTATION);
      emit(event(`marker is now ${lock.DUAL_IMPLEMENTATION}`, { phase: 'config', pct: 95 }));
    },
    timeoutMs,
  );

  // 6. The journal goes LAST, outside the locks: a kill between the swap and here leaves
  //    `dual-v1` plus a journal, which recovery recognises and tidies.
  lock.clearTransition(home);
  emit(
    event(`${home} is now ${lock.DUAL_IMPLEMENTATION}`, {
      phase: 'done',
      pct: 100,
      terminal: true,
    }),
  );
  return {
    marker: lock.DUAL_IMPLEMENTATION,
    promoted: true,
    from: found,
    locks: lockPaths(home),
  };
}

/**
 * THE MARKER WINDOW (kept while 1.x installs are supported). A home whose marker is the exclusive
 * value earlier releases write -- an install of an earlier release -- is not refused and
 * not simply relabelled: it goes through the promotion above, every state format read back
 * by this build under all five locks, the marker swapped atomically, the journal cleared
 * last, and the caller told once. A peer is asked only when `HOUSTON_PEER_VALIDATOR` names
 * one (a checkout with the previous implementation installed). Any other marker is left to
 * `requireThisImplementation`: `dual-v1` and this build's own are used as they are, a
 * transition journal and an unknown build stay refused. On any failure the marker is still
 * the earlier releases' value and the journal is gone, so the home is exactly as it was.
 *
 * Returns the one-time notice to show, or null when there was nothing to adopt.
 */
export async function adoptRetiredHome(
  home: string,
  emit: Emit = nullEmit,
): Promise<string | null> {
  const inFlight = lock.transitionReason(home);
  if (inFlight) throw new PreflightError(inFlight);
  if (lock.readImplementation(home) !== 'python') return null;
  const peer = (process.env[PEER_ENV] ?? '').trim() === '' ? 'optional' : 'required';
  await promote(home, { emit, peer });
  return (
    `note: ${home} was last written by houston 1.x. Every state ` +
    `file in it read back, and it is marked '${lock.DUAL_IMPLEMENTATION}' now: this build ` +
    'carries on with it, and nothing else in it changed.'
  );
}

/** Whether `target` is a directory: follows a symlink, false for anything not stat'able. */
function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finish or abandon an interrupted promotion. Safe to run repeatedly.
 *
 * Which of the two is decided by the MARKER, because the marker is what the swap changes:
 *
 *   - already `dual-v1` -- the swap landed and only the cleanup was lost. Remove the
 *     journal. Re-validating here would ask permission for something already done, and
 *     would fail for the ordinary reason that the other build has since written.
 *   - still exclusive -- the swap never happened. Re-run the WHOLE protocol under the
 *     same locks, because the state may have moved since the interrupted attempt read it,
 *     and completing on the strength of that stale read is what the journal prevents.
 */
export async function recover(
  home: string,
  { emit = nullEmit, timeoutMs = 30_000 }: { emit?: Emit; timeoutMs?: number } = {},
): Promise<RecoverResult> {
  const record = lock.readTransition(home);
  // The two early answers carry the established three keys and no `promoted`: nothing was
  // promoted by THIS call, and a key the previous implementation never writes is a
  // difference in every result either build reads back.
  if (record === null) {
    return {
      recovered: false,
      reason: 'no-transition',
      marker: lock.readImplementation(home),
    };
  }

  // A DIRECTORY is no journal a promotion wrote -- `beginTransition` creates a file -- and it
  // is one `clearTransition` cannot remove. Recovering on its strength would promote the home
  // because of a stray directory, then leave it in place and report success while every
  // command in both builds still refused.
  if (isDirectory(lock.transitionPath(home))) {
    throw new ConflictError(
      `${lock.transitionPath(home)} is a directory, which no promotion writes. ` +
        'Recovery will not promote this home on the strength of it, and cannot remove ' +
        'it: check that no promotion is running, then remove it by hand.',
    );
  }

  if (lock.readImplementation(home) === lock.DUAL_IMPLEMENTATION) {
    lock.clearTransition(home);
    emit(
      event('promotion had already landed; journal cleared', {
        phase: 'done',
        pct: 100,
        terminal: true,
      }),
    );
    return {
      recovered: true,
      reason: 'completed-cleanup',
      marker: lock.DUAL_IMPLEMENTATION,
    };
  }

  emit(event('re-validating an interrupted promotion', { phase: 'preflight', pct: 10 }));
  try {
    // Recovery keeps the peer requirement the interrupted attempt had: an adoption that
    // was interrupted is finished by the next command's adoption, not here.
    const result = await runPromotion(
      home,
      typeof record.from === 'string' ? record.from : '',
      emit,
      timeoutMs,
      'required',
    );
    return { ...result, recovered: true, reason: 'revalidated' };
  } catch (error) {
    lock.clearTransition(home);
    throw error;
  }
}
