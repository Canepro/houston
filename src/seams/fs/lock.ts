/**
 * The cross-process lock, and the marker that is the real dual-run safety mechanism.
 *
 * `src/lib/lock.ts` owns the `~/.houston/IMPLEMENTATION` marker and nothing else,
 * because `config.ts` is one of the five lock sites and has to import it. THIS module
 * is the other half: the file lock itself, which needs the process seam and therefore
 * cannot sit underneath `config`. Both halves are re-exported here so a state owner
 * has one import rather than two, and so the marker policy and the lock protocol
 * cannot drift apart.
 *
 * ## Why a child process holds the lock
 *
 * Node has no `flock`. The one native module that would provide it (`fs-ext`) was
 * measured and ruled out: it ships no prebuilt binary for any platform, so it is
 * ABI-pinned to whichever Node compiled it -- NODE_MODULE_VERSION 137 against 147 --
 * which one `node_modules` cannot satisfy for this project's own Node 24 + 26 matrix,
 * and it does not install on a stock musl image at all.
 *
 * What that measurement did NOT consider is that `flock(1)` from util-linux is already on
 * every Linux box, takes a real `flock(2)` on the file, and then `exec`s a command
 * that inherits the locked descriptor. So the lock is taken by a child that holds it
 * for exactly as long as the critical section, and the kernel releases it when that
 * child dies -- including a SIGKILL of this process, because the holder's stdin pipe
 * closes and it exits.
 *
 * MEASURED HERE, both directions, which is the claim this module exists to make:
 *
 *     an earlier release holds flock+OFD  ->  a flock(1) acquirer: BLOCKED (conflict exit)
 *     flock(1) holds                      ->  an earlier release's acquirer: BLOCKED (EWOULDBLOCK)
 *
 * ## What is degraded, and where
 *
 * NO OFD LOCK IS TAKEN. Earlier releases take `flock` plus an additive OFD lock because
 * the two do not exclude each other, so a build taking only OFD would walk straight
 * through a `flock` holder. This build takes only `flock`, and that is safe against
 * earlier releases for a reason worth stating rather than assuming: they take BOTH, so
 * whichever one an acquirer takes, it contends. The additive OFD line protects
 * against a third implementation that takes OFD alone -- which this build is not.
 * `LOCK_PLATFORM_MATRIX` says so per platform rather than leaving a reader to infer it.
 *
 * Where `flock(1)` is absent -- macOS and Windows have no such binary -- the tier is
 * `none` and cross-process exclusion degrades to the marker, which is the same
 * degradation earlier releases already accept on Windows. The ordering is deliberate: the
 * marker is the dual-run safety mechanism and the lock is defence in depth.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { ConflictError } from '../../lib/errors';
import { fileErrorOf } from '../../lib/format';
import { capture, interruptibly, stream, SpawnFailure, type ProcessResult } from '../exec';

export {
  MARKER_NAME,
  THIS_IMPLEMENTATION,
  DUAL_IMPLEMENTATION,
  markerPath,
  readImplementation,
  claim,
  conflictReason,
  requireThisImplementation,
} from '../../lib/lock';

/** Which mechanism actually excludes another process on this platform. */
export type LockTier = 'flock-cli' | 'none';

/** The exit code `flock(1)` is told to use for "somebody else holds it". */
export const CONFLICT_EXIT_CODE = 4;

/**
 * Written on stdout by the holder AFTER `flock` has taken the lock and `exec`ed it.
 * Seeing it is the only proof of acquisition: `flock` itself says nothing on success.
 */
export const HELD_SENTINEL = 'houston-lock-held';

/**
 * The holder. It announces the lock, then lives until its stdin closes -- which
 * happens when the owner releases, exits, or is killed. There is no timer on purpose:
 * the pipe closing is the one event that is delivered in every one of those cases,
 * including SIGKILL, where a handler would never run.
 *
 * ONE SIGNAL IS HANDLED, SIGINT, and handled by doing nothing (see `IGNORING_SIGINT`):
 * Node resets an inherited SIG_IGN to the default when it starts, so the holder has to
 * ignore it itself, and it does so BEFORE it announces the lock: the owner treats the
 * sentinel as the lock being held, so a Ctrl-C landing after the announcement and before
 * the handler would have killed the holder and freed a lock its owner believes it has.
 * Every other signal still ends it, as it ends its owner.
 */
const HOLDER_SOURCE =
  "process.on('SIGINT', () => undefined);" +
  `process.stdout.write(${JSON.stringify(`${HELD_SENTINEL}\n`)});` +
  "process.stdin.on('end', () => process.exit(0));" +
  'process.stdin.resume();';

/**
 * flock(1) with SIGINT IGNORED, which an `exec` keeps: `sh -c 'trap "" INT; exec "$@"'`.
 *
 * A terminal's Ctrl-C reaches its whole foreground process group, flock(1) and the holder
 * included. flock(1) died of the keypress that interrupted its owner, Node closes a child's
 * stdin when the child exits, and the holder's stdin ending released the lock while the
 * owner's unwind still ran under it -- `backup` starting Rocket.Chat again. The lock must
 * be held until the interrupt's unwind leaves the block that took it. Only SIGINT: a group
 * SIGHUP, SIGQUIT or SIGTERM -- a terminal hanging up, `timeout(1)` -- still ends flock(1)
 * and the holder with their owner, where a session of their own left a flock(1) WAITER
 * behind to take the lock up to fifteen minutes later. The owner's own interrupt reaches
 * the wait (`interruptibly` below).
 */
const IGNORING_SIGINT = ['/bin/sh', '-c', 'trap "" INT; exec "$@"', 'sh'] as const;

/** One row of the platform matrix. */
export interface PlatformLockRow {
  /** `process.platform` plus libc or architecture, as `doctor` would print it. */
  readonly platform: string;
  readonly tier: LockTier;
  /** Whether a holder of the OTHER implementation is actually excluded. */
  readonly crossImplementation: 'excluded' | 'marker-only';
  readonly support: 'supported' | 'degraded';
  /** Whether this row was measured on a real box or is reasoned from the mechanism. */
  readonly measured: boolean;
  readonly note: string;
}

/**
 * {platform} x {lock tier, cross-implementation exclusion, supported/degraded}.
 *
 * `measured` is part of the row because three platforms behave three ways and only one
 * of them has been run here. A matrix that presents a reasoned row and a measured row
 * identically is a matrix that will be trusted for the wrong one.
 */
export const LOCK_PLATFORM_MATRIX: readonly PlatformLockRow[] = Object.freeze([
  Object.freeze({
    platform: 'linux-glibc',
    tier: 'flock-cli' as const,
    crossImplementation: 'excluded' as const,
    support: 'supported' as const,
    measured: true,
    note:
      'util-linux flock(1) takes flock(2) and execs the holder, which inherits the ' +
      'locked descriptor. Measured against an earlier release holding it, in both directions.',
  }),
  Object.freeze({
    platform: 'linux-musl',
    tier: 'flock-cli' as const,
    crossImplementation: 'excluded' as const,
    support: 'degraded' as const,
    measured: false,
    note:
      'BusyBox ships a flock applet with -w but no --conflict-exit-code, so the ' +
      'acquisition sentinel rather than the exit code decides. Not measured here: the ' +
      'musl probe could not reach its own egress.',
  }),
  Object.freeze({
    platform: 'darwin-arm64',
    tier: 'none' as const,
    crossImplementation: 'marker-only' as const,
    support: 'degraded' as const,
    measured: false,
    note:
      'macOS ships no flock(1). Cross-process exclusion is the IMPLEMENTATION marker ' +
      'alone, which is what earlier releases already accept on a platform without fcntl.',
  }),
  Object.freeze({
    platform: 'darwin-x64',
    tier: 'none' as const,
    crossImplementation: 'marker-only' as const,
    support: 'degraded' as const,
    measured: false,
    note: 'As darwin-arm64: no flock(1) in the base system.',
  }),
  Object.freeze({
    platform: 'win32',
    tier: 'none' as const,
    crossImplementation: 'marker-only' as const,
    support: 'degraded' as const,
    measured: false,
    note:
      'No flock(1) and no fcntl. Earlier releases are thread-only here too, so the two ' +
      'degrade together rather than one of them claiming a guarantee the other lacks.',
  }),
]);

/** The matrix key for the machine this process is on. */
export function platformKey(): string {
  if (process.platform === 'linux') return isMusl() ? 'linux-musl' : 'linux-glibc';
  if (process.platform === 'darwin') return `darwin-${process.arch}`;
  return process.platform;
}

function isMusl(): boolean {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    return report.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

/** A failure to take the lock, before the public error contract is applied. */
export class LockUnavailable extends Error {
  /** `process` is another OS process; `in-process` is another caller in this one. */
  readonly layer: 'process' | 'in-process';
  readonly path: string;
  readonly waitedMs: number;
  readonly reason: string;

  constructor(layer: 'process' | 'in-process', path: string, waitedMs: number, reason: string) {
    super(`could not lock ${path} after ${waitedMs} ms: ${reason}`);
    this.name = 'LockUnavailable';
    this.layer = layer;
    this.path = path;
    this.waitedMs = waitedMs;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface FlockTool {
  readonly tier: LockTier;
  /** Absent when the tier is `none`. */
  readonly binary: string;
  /** util-linux understands `--conflict-exit-code`; BusyBox does not. */
  readonly conflictExitCode: boolean;
  readonly raw: string;
}

let probed: Promise<FlockTool> | null = null;

const ABSENT: FlockTool = Object.freeze({
  tier: 'none',
  binary: '',
  conflictExitCode: false,
  raw: '',
});

/**
 * The absolute path to a tool on PATH, or "": a `which`, in Node.
 *
 * Resolved here rather than left to the spawn, because "no flock on this box" is the
 * answer on two of the five platforms in the matrix and it should not cost a failed
 * spawn to learn. It also makes the degraded path reachable from a test by setting
 * `process.env.PATH`, which a spawn's own resolution is not: a sandboxed test runner
 * gives each test a COPY of `process.env`, so the real `environ` the child would
 * inherit still names the real PATH.
 */
function which(tool: string): string {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here, or not executable */
    }
  }
  return '';
}

/**
 * Locate `flock(1)` once per process.
 *
 * Probing per acquisition would spend a spawn on every lock, and the answer cannot
 * change under a running process in any way that matters. `resetLockProbe` exists so a
 * test can force the degraded path without uninstalling the binary.
 */
export function flockTool(): Promise<FlockTool> {
  probed ??= (async (): Promise<FlockTool> => {
    const binary = which('flock');
    if (binary === '') return ABSENT;
    try {
      const result = await capture([binary, '--version'], { encoding: 'utf8', timeoutMs: 5_000 });
      const raw = `${(result.stdout as string) || ''}${(result.stderr as string) || ''}`.trim();
      // BusyBox answers its own usage text on --version and exits non-zero. That is a
      // usable flock; only a binary that does not identify itself at all is not.
      if (result.exitCode !== 0 && !/flock/i.test(raw)) return ABSENT;
      return {
        tier: 'flock-cli',
        binary,
        conflictExitCode: /util-linux/i.test(raw),
        raw: raw.split('\n')[0] ?? '',
      };
    } catch {
      // EACCES, or a timeout. Both mean "no usable flock here", which is a degradation
      // rather than a failure -- see the module comment.
      return ABSENT;
    }
  })();
  return probed;
}

/** Forget the probed tool. Tests only; production probes once and keeps the answer. */
export function resetLockProbe(): void {
  probed = null;
}

/** What `doctor` prints: this machine's row, plus the whole matrix for context. */
export async function lockStatus(): Promise<{
  platform: string;
  row: PlatformLockRow | undefined;
  tier: LockTier;
  crossImplementation: 'excluded' | 'marker-only';
  support: 'supported' | 'degraded';
  detail: string;
  matrix: readonly PlatformLockRow[];
}> {
  const platform = platformKey();
  const row = LOCK_PLATFORM_MATRIX.find((entry) => entry.platform === platform);
  const tool = await flockTool();
  return {
    platform,
    row,
    tier: tool.tier,
    crossImplementation: tool.tier === 'none' ? 'marker-only' : 'excluded',
    support: tool.tier === 'none' ? 'degraded' : 'supported',
    detail:
      tool.tier === 'none'
        ? 'no flock(1) on PATH: cross-process exclusion is the IMPLEMENTATION marker alone'
        : `${tool.raw}${tool.conflictExitCode ? '' : ' (no --conflict-exit-code; sentinel decides)'}`,
    matrix: LOCK_PLATFORM_MATRIX,
  };
}

/** A held lock. `release()` is idempotent and never throws. */
export interface FileLockHandle {
  readonly path: string;
  readonly tier: LockTier;
  release(): Promise<void>;
}

/**
 * In-process serialisation, keyed by lock path.
 *
 * A per-name in-process lock sits UNDERNEATH the flock, because flock is per open file
 * DESCRIPTION: two callers in one process that each open the file would both be granted
 * it. Two async callers here would each spawn their own holder, which do exclude each
 * other -- but only by making the second one wait out a real timeout for a conflict this
 * process could have resolved itself.
 */
const inProcess = new Map<string, Promise<void>>();

async function enterInProcess(key: string, timeoutMs: number): Promise<() => void> {
  const started = Date.now();
  for (;;) {
    const waiting = inProcess.get(key);
    if (waiting === undefined) break;
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new LockUnavailable('in-process', key, Date.now() - started, 'held by this process');
    }
    await Promise.race([
      waiting,
      new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 50))),
    ]);
  }
  let release!: () => void;
  inProcess.set(
    key,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return () => {
    inProcess.delete(key);
    release();
  };
}

/**
 * How a lock site opens its lock file before it flocks the descriptor.
 *
 * `flock(1)` opens the path ITSELF, with `O_RDONLY | O_CREAT` and 0666, and falls back to
 * a plain read-only open of a directory. So left alone it creates the lock at the umask's
 * mode, takes a lock file this user may read but not write, locks a directory without
 * complaint, and reports anything it cannot open as its own exit 66 -- which the refusal
 * below turned into "another houston process is still working ... (waited 900s)", exit 8,
 * at once. A lock site opens for WRITING first and raises that open's failure, a
 * `FileError`, unhandled, exit 1, before anything is written: `Is a directory`, `Permission
 * denied`, `No such file or directory` for a dangling link. Opening the path that way here
 * first gives the established file mode and the established failure; `flock(1)` then locks
 * a file that exists and that this user may open.
 */
export interface LockFileOpen {
  /** Whether the open truncates: a plain write-mode open does; the config lock's does not. */
  readonly truncate: boolean;
  /** The creation mode before the umask: 0o666 for a plain open, 0o600 for the config lock. */
  readonly mode: number;
}

/** A plain write-mode open, truncating at 0o666: the workspace, users and sessions locks. */
export const OPEN_FOR_WRITE: LockFileOpen = Object.freeze({ truncate: true, mode: 0o666 });

export interface AcquireOptions {
  /** How long to wait before refusing. Mirrors `reproLock`'s 900 s default. */
  readonly timeoutMs?: number;
  /**
   * Open the lock file as the lock site always has, and raise what that open raises.
   * Absent, `flock(1)` alone opens the path -- the rotation and promotion sites, which open
   * differently and whose callers own their failures.
   */
  readonly open?: LockFileOpen;
}

/** Open `target` for writing as the lock site always has, raising that open's `FileError`. */
function openForWrite(target: string, how: LockFileOpen): void {
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | (how.truncate ? fs.constants.O_TRUNC : 0);
  let fd: number;
  try {
    fd = fs.openSync(target, flags, how.mode);
  } catch (error) {
    throw fileErrorOf(error, target);
  }
  fs.closeSync(fd);
}

/**
 * Take an exclusive cross-process lock on `path`, creating it if absent.
 *
 * Returns a handle rather than taking a callback so a state owner can hold the lock
 * across its own write-ahead ordering. `withFileLock` is the ordinary way in.
 */
export async function acquireFileLock(
  path: string,
  options: AcquireOptions = {},
): Promise<FileLockHandle> {
  const timeoutMs = options.timeoutMs ?? 900_000;
  const leaveInProcess = await enterInProcess(path, timeoutMs);
  // After the in-process layer and before the tier, in the established order: the
  // in-process lock comes first, and the file is opened whatever the tier, macOS included.
  if (options.open !== undefined) {
    try {
      openForWrite(path, options.open);
    } catch (error) {
      leaveInProcess();
      throw error;
    }
  }
  const tool = await flockTool();
  if (tool.tier === 'none') {
    // Degraded exactly as earlier releases degrade without flock: this process is serialised,
    // and a foreign process is stopped by the marker rather than by this.
    return { path, tier: 'none', release: async () => leaveInProcess() };
  }

  const started = Date.now();
  const control = new PassThrough();
  let acquired = false;
  let seen = '';
  let settle!: (error?: Error) => void;
  const held = new Promise<void>((resolve, reject) => {
    settle = (error?: Error) => {
      if (error !== undefined) reject(error);
      else resolve();
    };
  });

  const argv: [string, ...string[]] = [
    ...IGNORING_SIGINT,
    tool.binary,
    '--exclusive',
    '--timeout',
    String(Math.max(0, timeoutMs) / 1000),
    ...(tool.conflictExitCode ? ['--conflict-exit-code', String(CONFLICT_EXIT_CODE)] : []),
    path,
    process.execPath,
    '-e',
    HOLDER_SOURCE,
  ];

  // CTRL-C WHILE WAITING means the lock was never taken and nothing may go on waiting for
  // it. Here the wait is a flock(1) child, and `process.exit` left it waiting: `down`
  // Ctrl-C'd behind another command's lock exited 130, and its waiter took the lock when
  // the other released it, minutes after the command that wanted it had gone. So the WAIT
  // is what an interrupt takes over -- the waiter is SIGKILLed at once -- and the child is
  // not: once it holds the lock it IS the lock, held until the unwind leaves the block
  // that took it.
  const waiter = new AbortController();
  let finished: Promise<ProcessResult> | undefined;
  const start = (): { done: Promise<void>; stop: () => void } => {
    const running = stream(argv, {
      stdin: control,
      encoding: 'utf8',
      interrupt: 'caller',
      abortSignal: waiter.signal,
      abortKillSignal: 'SIGKILL',
      onStdout: (chunk) => {
        seen += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (!acquired && seen.includes(HELD_SENTINEL)) {
          acquired = true;
          settle();
        }
      },
    });

    finished = running.then(
      (result) => {
        if (!acquired) {
          // No sentinel means the lock was never taken. The exit code says why when the
          // tool can spell it; otherwise not seeing the sentinel IS the answer.
          settle(
            new LockUnavailable(
              'process',
              path,
              Date.now() - started,
              result.exitCode === CONFLICT_EXIT_CODE || !tool.conflictExitCode
                ? 'another process holds it'
                : `flock exited ${String(result.exitCode)}: ${String(result.stderr ?? '').trim()}`,
            ),
          );
        }
        return result;
      },
      (error: unknown) => {
        if (!acquired) {
          settle(
            error instanceof SpawnFailure
              ? new LockUnavailable('process', path, Date.now() - started, error.message)
              : (error as Error),
          );
        }
        throw error;
      },
    );
    // The holder's own failure after acquisition must not surface as an unhandled
    // rejection; `release()` is where it is waited on and reported.
    finished.catch(() => undefined);
    return { done: held, stop: () => waiter.abort() };
  };

  try {
    await interruptibly(start);
  } catch (error) {
    control.end();
    await finished?.catch(() => undefined);
    leaveInProcess();
    throw error;
  }

  let released = false;
  return {
    path,
    tier: tool.tier,
    release: async () => {
      if (released) return;
      released = true;
      control.end();
      await finished?.catch(() => undefined);
      leaveInProcess();
    },
  };
}

/** Lock names already held by THIS async execution, so a nested take is reentrant. */
const HELD = new AsyncLocalStorage<Set<string>>();

/**
 * Run `fn` while holding an exclusive lock on `path`.
 *
 * REENTRANT within one async execution, and that is load-bearing rather than tidy:
 * `restore --new` holds a workspace's lock and then calls `createRepro`, which takes it
 * again. A per-thread depth would track that for threads; an `AsyncLocalStorage` is the
 * same statement about an async call tree, and the nested frame must not re-take
 * the file lock because `flock` self-blocks on a second descriptor exactly as an OFD
 * lock does.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => T | Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  const held = HELD.getStore();
  if (held?.has(path) === true) return await fn();

  const handle = await acquireFileLock(path, options);
  const nested = new Set(held ?? []);
  nested.add(path);
  try {
    return await HELD.run(nested, async () => await fn());
  } finally {
    await handle.release();
  }
}

/** Whether this async execution already holds `path`. For an adapter's own bookkeeping. */
export function holdsFileLock(path: string): boolean {
  return HELD.getStore()?.has(path) === true;
}

/**
 * The refusal an adapter raises when a lock cannot be taken.
 *
 * The seam reports the failure; the adapter owns the public contract. This helper
 * exists so the two workspace-level sentences `reproLock` raises -- one naming
 * another OPERATION, one naming another PROCESS -- stay one substitution apart
 * instead of being retyped at each call site.
 */
export function conflictFrom(
  error: LockUnavailable,
  what: string,
  timeoutSeconds: number,
): ConflictError {
  const who = error.layer === 'in-process' ? 'operation' : 'process';
  return new ConflictError(
    `another houston ${who} is still working on '${what}' ` +
      `(waited ${String(Math.trunc(timeoutSeconds))}s). Check \`houston list\` and the ` +
      'Activity list, then retry.',
  );
}
