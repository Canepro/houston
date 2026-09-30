/**
 * A durable, redacted record of what houston did — the file you read after the fact.
 *
 * WHY THIS EXISTS. Everything else here is either state or a stream. `audit.log` records
 * who ATTEMPTED what, not what happened or why it failed. `journal/` holds side effects a
 * kill must not strand -- actionable state, a closed set of kinds. `web/jobs.ts` buffers a
 * job's events beautifully and keeps them in MEMORY, so a `serve` restart loses even the
 * knowledge that a job existed. And on the CLI a failure prints to stderr and is gone when
 * the terminal scrolls. The richest record this tool produces was the one that never
 * survived the process.
 *
 * WHY IT IS CHEAP. `Emit` is already the single funnel every long-running function goes
 * through, so one sink covers ~125 emit sites without touching any of them.
 *
 * FOUR RULES, each of which is a way this could have gone wrong:
 *
 *   NEVER THROW, NEVER PRINT. A log that cannot be written must not break the operation it
 *   was describing, and it must never touch stdout: `--json` promises exactly one envelope
 *   there and this would be the thing that broke it. Any filesystem error disables the sink
 *   for the rest of the process.
 *
 *   REDACT AT THE SINK. Terminal events carry the whole result document, and the token, pat
 *   and env paths hold live credentials -- `MONGO_URL` carries a password in its VALUE,
 *   which is why `URL_USERINFO` exists. Writing them to a file is an exposure that does not
 *   exist otherwise, so this is the one place the feature can make things worse.
 *
 *   IMPORT ONLY LEAVES AT MODULE LEVEL. Redaction lives in its own dependency-free leaf.
 *
 *   BOUNDED. Two files, ~8 MiB. On a tool whose whole premise is that the box runs out of
 *   disk and RAM first, an unbounded log is a bug.
 *
 * ## The APPEND is synchronous; only the ROTATION is enqueued
 *
 * `write` is one `write()` to an O_APPEND descriptor, which is what makes it safe without a
 * lock: `serve` runs continuously while somebody uses the CLI, so two writers is the NORMAL
 * case here, and for a regular file on a local filesystem O_APPEND makes the offset update
 * and the write one operation. It is also what lets this be called from `Emit`, which is
 * synchronous.
 *
 * The rotation is the one part that needs a cross-process lock, and the seam offers no
 * synchronous one -- it spawns `flock(1)`, and the native addon that would have provided a
 * synchronous alternative is ruled out (`seams/fs/lock.ts` says why). A durable sink
 * enqueues its own I/O and must not make the operation fail, so the rotation is enqueued,
 * and `rotate` below records why appending across it loses nothing.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { joinPath } from '../lib/home';
import { mkdirParents } from '../lib/mkdir-parents';
/**
 * PER-EXECUTION attribution, because one `serve` process is one `run` and it runs many
 * jobs at once. Without this, two concurrent creates interleave in the log with nothing to
 * tell them apart -- which would undermine the whole point of having it.
 *
 * `AsyncLocalStorage` carries it across a job's every await, and `lib/context.ts` already
 * holds `jobId` and `workspace` for exactly this.
 */
import { currentContext } from '../lib/context';
import { THIS_IMPLEMENTATION } from '../lib/lock';
import { type Emit, type Event, installSink } from '../lib/events';
import { REDACTED, SECRET_KEY_HINTS, URL_USERINFO } from '../lib/redact';
import { parseFloat_, toInt } from '../lib/format';
import { dumps } from '../lib/json-text';
import { withFileLock } from '../seams/fs/lock';

/**
 * One id per process, so `grep '"run":"<id>"'` is one invocation start to finish -- across
 * the CLI and across a GUI job, which is what makes this a timeline rather than a pile of
 * lines.
 */
export const RUN = randomBytes(4).toString('hex');

/** Current file plus one rotation. `HOUSTON_LOG_MAX_MB=0` disables logging entirely. */
export const DEFAULT_MAX_MB = 4;
export const DIRNAME = 'logs';
export const FILENAME = 'houston.log';

/**
 * `data` keys DROPPED rather than walked. A result document is unbounded and holds
 * whatever the operation returned; the others are credentials by name. Dropping beats
 * redacting because a walk can miss a shape and this cannot.
 */
const DROP_KEYS: readonly string[] = Object.freeze([
  'result',
  'token',
  'auth',
  'password',
  'authtoken',
  'auth_token',
]);

/**
 * Set once the sink has failed. Checked FIRST, so a broken log costs one boolean per event
 * rather than an exception per event.
 */
let disabled = false;
/** Cached, so there is no stat() per record. */
let size: number | null = null;

/**
 * WHICH BUILD WROTE THE RECORD, the same field the previous implementation writes. Both builds
 * append to one `logs/houston.log` once a home is `dual-v1`: without the writer on every line,
 * a failure could not be told apart from the other build's.
 */
export const IMPL = THIS_IMPLEMENTATION;

/**
 * Filled in by whoever knows: the CLI sets the command line once at startup, and `emit`
 * cannot work it out for itself. `via` is `dispatcher` when the process was started with this
 * build's route in `HOUSTON_DISPATCHED_ROUTE` (`lib/lock.ts`'s `consumeDispatch`) and `direct`
 * otherwise.
 */
const CONTEXT: { cmd: string; actor: string; ws: string; via: 'dispatcher' | 'direct' } = {
  cmd: '',
  actor: '',
  ws: '',
  via: 'direct',
};

/** Record what this process is, for every line it will write. */
export function configure({
  cmd = '',
  actor = '',
  ws = '',
  via = '',
}: { cmd?: string; actor?: string; ws?: string; via?: '' | 'dispatcher' | 'direct' } = {}): void {
  if (cmd) CONTEXT.cmd = cmd;
  if (actor) CONTEXT.actor = actor;
  if (via) CONTEXT.via = via;
  if (ws) CONTEXT.ws = ws;
}

/** For a test that needs a clean slate; module state like any other. */
export function resetForTest(): void {
  disabled = false;
  size = null;
  CONTEXT.cmd = '';
  CONTEXT.actor = '';
  CONTEXT.ws = '';
  CONTEXT.via = 'direct';
}

/**
 * `HOUSTON_LOG_MAX_MB` in bytes, truncated, and the default when it is not a number. Read
 * by `parseFloat_` and `toInt`, not `Number`: `Number(' ')` is 0, which DISABLED the log --
 * no `start`, no `end`, for every command -- where `' '` is no number and the log keeps its
 * 4 MB; and `0x10` is 16 MB to `Number` and the default here, `1_0` the reverse. An
 * infinity is `toInt`'s `OutOfRange`, which is not caught here, so its callers'
 * best-effort handling is what answers it, as it always has.
 */
export function maxBytes(): number {
  const raw = config.env('HOUSTON_LOG_MAX_MB') || String(DEFAULT_MAX_MB);
  let megabytes: number;
  try {
    megabytes = parseFloat_(raw);
  } catch {
    return DEFAULT_MAX_MB * 1_048_576;
  }
  try {
    return toInt(megabytes * 1_048_576);
  } catch (error) {
    if ((error as Error).name === 'InvalidValue') return DEFAULT_MAX_MB * 1_048_576;
    throw error;
  }
}

export function logPath(): string {
  return joinPath(config.home(), DIRNAME, FILENAME);
}

/**
 * Strip credentials from anything about to be written.
 *
 * Reuses the shared leaf rather than a second copy: a redaction rule that exists twice is
 * one that will disagree with itself. `depth` bounds a pathological structure rather than
 * trusting the shape of a result document.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = String(k);
      const low = key.toLowerCase();
      if (DROP_KEYS.includes(low)) continue;
      if (SECRET_KEY_HINTS.some((h) => low.includes(h))) out[key] = REDACTED;
      else out[key] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // The credential the KEY NAME never reveals: `scheme://user:password@host`.
    return value.replace(URL_USERINFO, `$1:${REDACTED}@`);
  }
  return value;
}

/**
 * One record as one JSON line.
 *
 * No spaces after the separators, and anything unserialisable becomes its string form
 * rather than raising -- this is a logger, and a log line that throws is the defect the
 * whole module is written against.
 *
 * Through `json-text.dumps`, not `JSON.stringify`, which this claimed to be and was not: it
 * wrote the `—` of every NOT_READY and conflict message, and any non-ASCII in an argv, as
 * raw UTF-8 where the established line escapes everything past ASCII (`\u2014`), so the
 * one file both builds append to held two spellings of one record. The values each side
 * parses were always equal; the bytes now are.
 */
function encode(record: Record<string, unknown>): string {
  return dumps(record, { separators: [',', ':'], default: (value) => String(value) });
}

/** Append one line. Swallows everything; disables itself on the first failure. */
function write(record: Record<string, unknown>): void {
  if (disabled) return;
  const cap = maxBytes();
  if (cap <= 0) {
    disabled = true;
    return;
  }
  try {
    const target = logPath();
    // ONE write() to an O_APPEND file. For a regular file on a local filesystem, O_APPEND
    // makes the offset update and the write one operation, so a single write per record
    // cannot interleave with another writer's. No lock and no read-modify-write.
    if (size === null) {
      // 0700 on `logs/` alone; a parent it makes takes the umask's mode.
      mkdirParents(path.dirname(target), 0o700);
      size = fs.existsSync(target) ? fs.statSync(target).size : 0;
    }
    if (size > cap) {
      rotate(target);
      // The cached size is DROPPED rather than zeroed. Zeroing would claim the rotation
      // has happened, and it is in flight; the next append re-stats and gets the truth
      // whichever side of the rename it lands on.
      size = null;
      mkdirParents(path.dirname(target), 0o700);
      size = fs.existsSync(target) ? fs.statSync(target).size : 0;
    }
    const line = Buffer.from(`${encode(record)}\n`, 'utf8');
    // 0600: this can carry a workspace name, an actor and an error message, and it lives
    // in a home that only `serve` tightens to 0700.
    const fd = fs.openSync(target, 'a', 0o600);
    try {
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
    size += line.length;
  } catch {
    // A read-only home, a full disk, a path that is not a directory. Off for the rest of
    // the process, and silent: see the module docstring.
    disabled = true;
  }
}

/**
 * Current -> .1, replacing whatever was there. Best-effort, and ENQUEUED rather than
 * awaited.
 *
 * This is the one NON-ATOMIC moment, which is why it takes a cross-process lock: two
 * processes that both see the file over the cap would otherwise both rename it, and the
 * second rename carries the first one's records out of the only two files anything reads.
 * The size is therefore re-checked UNDER the lock, so the check and the rename are ONE
 * decision. The SIGKILL test in `seams/fs/lock.test.ts` asserts exactly this ("loses no
 * event-log record across the rotation boundary") because the site is otherwise silent by
 * contract.
 *
 * ## Why this is async while `write` is not
 *
 * The seam offers no synchronous cross-process lock -- it spawns `flock(1)`, and the native
 * addon that would have given a synchronous one is ruled out. A durable sink enqueues its
 * own I/O and must not make the operation fail, so the APPEND stays synchronous (one
 * `write()` to an O_APPEND descriptor, which needs no lock) and only the rotation is
 * enqueued.
 *
 * Appending while a rotation is in flight loses nothing. Each append opens by PATH, so
 * records written before the rename are in the file that BECOMES `.1`, and records written
 * after it land in a fresh `houston.log`. Both are read. What would lose records is two
 * renames in a row, and that is precisely what the under-lock re-check prevents.
 *
 * `inFlight` keeps one rotation per process: without it every append over the cap would
 * queue another, and a hundred queued rotations is a hundred `flock` spawns.
 */
let inFlight: Promise<void> | null = null;

function rotate(target: string): void {
  if (inFlight !== null) return;
  const cap = maxBytes();
  inFlight = (async () => {
    try {
      // The LOG FILE itself is the lock path, not a separate file under `locks/`, because
      // that is what the previous implementation's rotation flocks. A rotator here that
      // locked something else would not exclude that one, and both would rename.
      await withFileLock(target, () => {
        let current: number;
        try {
          current = fs.statSync(target).size;
        } catch {
          // Somebody rotated it away already.
          return;
        }
        if (current <= cap) return;
        try {
          fs.renameSync(target, `${target}.1`);
        } catch (error) {
          // Losing the race to rename is fine; losing a record is not.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      });
    } catch {
      /* a failed rotation keeps appending rather than dropping anything */
    } finally {
      inFlight = null;
    }
  })();
}

/**
 * The rotation, AWAITED before a record instead of enqueued after it: the established
 * order, where the write that finds the log over its cap rotates first and then lands in a
 * fresh `houston.log`.
 *
 * The CLI calls this before a run's `start` record and before its `end`, the two writes it can
 * wait for. The enqueued rotation in `write` put a run's own records on the far side of the
 * rename: for `--version` over a 4 MiB log, `start` and `end` both went to `houston.log.1`
 * with no `houston.log` left, and without flock(1) the rename landed between them. Events
 * written mid-run from a synchronous emit still enqueue theirs, as a durable sink must.
 *
 * The decision is the established one: this process's size of the file (read from disk
 * before its first record), the rename only if the file is STILL over the cap under the
 * lock, and the size taken as 0 afterwards whether or not this process was the one that
 * renamed it.
 */
export async function rotateIfOver(): Promise<void> {
  try {
    await settle();
    const cap = maxBytes();
    if (disabled || cap <= 0) return;
    const target = logPath();
    const current = size ?? (fs.existsSync(target) ? fs.statSync(target).size : 0);
    if (current <= cap) return;
    await withFileLock(target, () => {
      if (fs.statSync(target).size > maxBytes()) fs.renameSync(target, `${target}.1`);
    });
    size = 0;
  } catch {
    /* a failed rotation keeps appending rather than dropping anything */
    size = 0;
  }
}

/** Wait for any in-flight rotation. For a test that needs the boundary to have landed. */
export async function settle(): Promise<void> {
  while (inFlight !== null) await inFlight;
}

function base(kind: string): Record<string, unknown> {
  const ctx = currentContext();
  const rec: Record<string, unknown> = {
    ts: `${new Date().toISOString().slice(0, 19)}Z`,
    run: RUN,
    pid: process.pid,
    kind,
    impl: IMPL,
    via: CONTEXT.via,
    // A serve process handles concurrent actors. The job/request attribution must come
    // from AsyncLocalStorage; the process context remains the fallback for one-shot CLI
    // commands, where `started()` configures it once.
    actor: ctx.actor || CONTEXT.actor,
    cmd: CONTEXT.cmd,
    ws: ctx.workspace || CONTEXT.ws,
  };
  if (ctx.jobId) {
    // The key that separates concurrent jobs inside one `serve`. `run` alone cannot: it is
    // per PROCESS, and a serve is one process for many jobs.
    rec.job = ctx.jobId;
  }
  return rec;
}

export function started(cmd: string, actor = ''): void {
  configure({ cmd, actor });
  write(base('start'));
}

export function ended(exitCode: number, secs: number): void {
  write({ ...base('end'), exit: Math.trunc(exitCode), secs: Math.round(secs * 100) / 100 });
}

export function failed(code: string, message: string, { stackTraceOnStderr = false } = {}): void {
  write({
    ...base('error'),
    code,
    msg: redact(String(message)),
    trace: Boolean(stackTraceOnStderr),
  });
}

/**
 * Record one `Event`. Called from the emit helpers, so every site is covered.
 *
 * DOCKER'S ECHO IS SKIPPED. A streamed `up` turns every line of `docker compose pull` output
 * into an event, so a GUI create emits several hundred `Downloading 45.09MB` records. That is
 * echo, not narrative: logging it buries the four lines that matter and spends the whole size
 * cap on one create. `HOUSTON_LOG_ECHO=1` keeps it for when somebody is debugging a pull. A
 * warning or an error is NEVER skipped, echo or not.
 */
export function event(ev: Event): void {
  if (disabled) return;
  const level = ev.level || 'info';
  const data: Record<string, unknown> = ev.data;
  if (
    level !== 'warn' &&
    level !== 'error' &&
    Boolean(data.echo) &&
    config.env('HOUSTON_LOG_ECHO') !== '1'
  ) {
    return;
  }
  const rec: Record<string, unknown> = {
    ...base('event'),
    // An empty phase would be written as `""`. It cannot occur here: `EmittedPhase` has no
    // empty member, so the fallback is unreachable
    // and the lint rule that spots always-truthy conditions says so. Every record this
    // build writes is byte-identical either way.
    phase: ev.phase,
    level,
    msg: redact(String(ev.message)),
  };
  const clean = redact(data) as Record<string, unknown>;
  if (Object.keys(clean).length > 0) rec.data = clean;
  write(rec);
}

/**
 * A GUI job beginning. The record `web/jobs` could never keep: its registry is in memory,
 * so a restart loses even the knowledge that a job existed.
 */
export function jobStarted(_jobId: string, kind: string, label: string): void {
  write({ ...base('job-start'), job_kind: kind, label });
}

export function jobEnded(
  _jobId: string,
  kind: string,
  label: string,
  status: string,
  error: string,
): void {
  const rec: Record<string, unknown> = { ...base('job-end'), job_kind: kind, label, status };
  if (error) rec.msg = redact(String(error));
  write(rec);
}

/**
 * Lease the durable Event sink for one CLI/server lifecycle.
 *
 * EXPLICIT rather than import-time registration, unlike `audit` and `journal`: re-importing
 * a cached module cannot restore cleared global state, and two app factories must share one
 * invocation while retaining independent shutdown ownership.
 */
export function installEventlogSink(): () => void {
  return installSink('eventlog', event as Emit);
}

/** Hold one best-effort durable-sink lease for a complete lifecycle. */
export async function withEventlogSink<T>(body: () => T | Promise<T>): Promise<T> {
  let unregister: () => void;
  try {
    unregister = installEventlogSink();
  } catch {
    // Logging must never stop the caller.
    unregister = () => undefined;
  }
  try {
    return await body();
  } finally {
    try {
      unregister();
    } catch {
      /* logging must never stop shutdown */
    }
  }
}
