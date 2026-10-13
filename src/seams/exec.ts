/**
 * The single boundary through which Houston launches operating-system processes.
 *
 * This is deliberately a mechanism, not a policy layer. A non-zero exit and a
 * signal are returned as process facts. Spawn and timeout failures are typed only
 * enough for an adapter to preserve their cause; Docker, Kubernetes, TLS, and the
 * CLI remain responsible for translating those facts into their distinct public
 * contracts.
 *
 * Every command is an argv tuple and `shell` is always false. Text decoding is
 * opt-in: output is bytes unless text is requested. Only `startDetached` calls `unref()`;
 * using a process group for safe cancellation does not make an ordinary child outlive
 * Houston.
 *
 * It is also where a Ctrl-C reaches what Houston is waiting on (see "CTRL-C" below): a
 * child is the one wait every command has, and the lock and HTTP seams register theirs
 * here because this is the only module below all of them.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

export type Argv = readonly [string, ...string[]];
export type TextEncoding = 'utf8' | 'utf-8';
export type ProcessChunk = string | Buffer;
export type ProcessOutput = string | Buffer | null;

export interface ProcessResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: ProcessOutput;
  readonly stderr: ProcessOutput;
}

interface CommonOptions {
  readonly cwd?: string | URL;
  /** A supplied environment replaces, rather than extends, the parent environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** `null` keeps bytes; UTF-8 text uses strict decoding. */
  readonly encoding?: TextEncoding | null;
  readonly input?: string | Buffer | Uint8Array;
  /** Stream large input without reading it all into Houston first. */
  readonly stdin?: Readable | 'inherit' | 'ignore';
  readonly timeoutMs?: number;
  /** The signal sent when `timeoutMs` expires; SIGKILL unless given. */
  readonly timeoutSignal?: NodeJS.Signals | number;
  /** Cancels a running child without changing a signal exit into an exception. */
  readonly abortSignal?: AbortSignal;
  readonly abortKillSignal?: NodeJS.Signals | number;
  /** Start a POSIX session so cancellation can reach the entire process group. */
  readonly processGroup?: boolean;
  /**
   * `'caller'`: a Ctrl-C does not take this child over (see `interruptibly`); whoever
   * started it answers the interrupt. The lock seam's holder is the one such child: it IS
   * the lock, and the lock is held until the unwind has left the block that took it.
   */
  readonly interrupt?: 'popen' | 'caller';
}

export interface CaptureOptions extends CommonOptions {
  /** Fold stderr into stdout in observed stream order, like stderr=STDOUT. */
  readonly mergeStderr?: boolean;
}

export interface StreamOptions extends CommonOptions {
  readonly mergeStderr?: boolean;
  readonly onStdout?: (chunk: ProcessChunk) => void;
  readonly onStderr?: (chunk: ProcessChunk) => void;
  /** Backpressure-aware destinations; ownership and closing stay with the caller. */
  readonly stdoutSink?: Writable;
  readonly stderrSink?: Writable;
}

export type InheritOptions = Omit<
  CommonOptions,
  'encoding' | 'input' | 'stdin' | 'timeoutMs' | 'timeoutSignal'
> & {
  readonly timeoutMs?: number;
  readonly timeoutSignal?: NodeJS.Signals | number;
  /**
   * The child's stdout is this process's stderr, fd 2: whoever
   * watches the terminal still sees it, and a stdout that belongs to a machine does not.
   */
  readonly stdoutToStderr?: boolean;
};

export interface DetachedOptions {
  readonly cwd?: string | URL;
  readonly env?: NodeJS.ProcessEnv;
}

export interface DetachedProcess {
  readonly argv: readonly string[];
  readonly pid: number;
}

/** A launch failure with the original Node error retained as `cause`. */
export class SpawnFailure extends Error {
  override readonly cause: NodeJS.ErrnoException;
  readonly argv: readonly string[];

  constructor(argv: readonly string[], cause: NodeJS.ErrnoException) {
    super(`could not spawn ${JSON.stringify(argv[0])}`, { cause });
    this.name = 'SpawnFailure';
    this.argv = [...argv];
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A timeout with any output produced before cancellation attached. */
export class ProcessTimeout extends Error {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly result: ProcessResult;

  constructor(argv: readonly string[], timeoutMs: number, result: ProcessResult) {
    super(`${JSON.stringify(argv[0])} timed out after ${timeoutMs} ms`);
    this.name = 'ProcessTimeout';
    this.argv = [...argv];
    this.timeoutMs = timeoutMs;
    this.result = result;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ------------------------------------------------------------------------------- CTRL-C

/**
 * The Ctrl-C interrupt, raised where Houston was waiting when Ctrl-C arrived.
 *
 * NOT an `Error` a command should report. It is raised at the wait the command was in,
 * every `finally` and every `cleanup` on the stack runs as it unwinds, and the CLI turns
 * it into a silent exit 130. An ordinary-failure handler must not catch it -- a `catch`
 * here does, so a `catch` that is such a handler rethrows it
 * (`if (error instanceof Interrupted) throw error`).
 */
export class Interrupted extends Error {
  constructor() {
    super('');
    this.name = 'Interrupted';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * How long a child that was being waited on when the interrupt arrived is given to end on
 * its own, on the assumption that it also received the ^C, before it is SIGKILLed and the
 * interrupt resumes. MEASURED against an earlier release with SIGINT sent to its pid alone,
 * so the child never saw it: `logs --follow` and `down`, each waiting on a `sleep 30`,
 * exited 0.31 s after the signal, with the child killed.
 */
export const POPEN_SIGINT_WAIT_MS = 250;

/**
 * How long an unwind may run outside every `cleanup` before it is answered as a plain exit.
 *
 * Unwinding is the rejection reaching the command's own `finally` and `catch` blocks: the
 * child's 250 ms above, and then JavaScript and awaits that have already settled. Two
 * seconds is that with room to spare. A `cleanup` is a `finally` doing real work --
 * `backup` starting Rocket.Chat again and waiting for it to serve, up to five minutes --
 * and that has never had a bound, so this puts none on it: the clock stops while one
 * runs. What the bound catches is an unwind this build cannot finish -- a wait nobody
 * registered, which a Ctrl-C does not reach -- and a second Ctrl-C catches the rest, as it
 * always has.
 */
const UNWIND_BOUND_MS = 2_000;

/** A running `cleanup`: `interrupted` once a Ctrl-C has landed inside it. */
interface Cleanup {
  interrupted: boolean;
}

/** What an async call chain is inside of: an `unwindsOnInterrupt` body, a `cleanup`. */
interface Frame {
  readonly unwinds: boolean;
  readonly cleanup: Cleanup | null;
}

/** A wait the interrupt can take over: stop the work, then raise or leave it pending. */
interface Waiting {
  readonly unwinds: boolean;
  take(raise: boolean): Promise<void>;
}

type InterruptState =
  | { readonly mode: 'idle' }
  /** No unwind is on the stack: stop what is being waited on, and end the process. */
  | { readonly mode: 'exit' }
  /** An unwind is: raise Interrupted where the command waits, and let it run. */
  | { readonly mode: 'raise'; delivered: boolean };

const frames = new AsyncLocalStorage<Frame>();

/**
 * The stop signal of the job this call chain belongs to: `serve`'s Stop button.
 *
 * The Ctrl-C machinery here is the whole process's. A GUI job is one of many in `serve`, and
 * the only way to end one that was stuck -- a create waiting ten minutes on a port-forward it
 * could not see -- was to kill the server, while its lock held up every other operation on
 * that workspace. So a job carries its own signal. Aborted, every wait in that job that a
 * Ctrl-C could reach rejects with Interrupted, a child stopped first; so does every wait it
 * starts afterwards, so a catch that swallows one cannot carry the job on; and the other
 * jobs never notice. Waits inside `cleanup` still run to the end.
 */
const stops = new AsyncLocalStorage<AbortSignal>();

/** Run `body` as a job that aborting `signal` stops (see `stops`). */
export function stoppable<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
  return stops.run(signal, body);
}

/**
 * Run `body` outside any job's stop scope: for work SHARED between jobs, such as a probe
 * memoised for the whole process. Started inside a job that is then stopped, its answer
 * would be "refused" for every job that awaits it, for as long as the process runs.
 */
export function unstoppable<T>(body: () => Promise<T>): Promise<T> {
  return stops.exit(body);
}

/** This chain's stop signal -- none inside cleanup, which runs to the end regardless. */
function stopSignal(): AbortSignal | undefined {
  return frames.getStore()?.cleanup != null ? undefined : stops.getStore();
}
const waiting = new Set<Waiting>();
/** Waits taken over and still in their grace: calling one ends the grace now. */
const inGrace = new Set<() => void>();
const cleanups = new Set<Cleanup>();
const stopping: Promise<void>[] = [];
let unwinding = 0;
let lastCleanup = 0;
let state: InterruptState = { mode: 'idle' };
let endProcess: (() => void) | null = null;
let bound: NodeJS.Timeout | undefined;

function exitNow(): void {
  const end = endProcess;
  endProcess = null;
  if (bound !== undefined) clearTimeout(bound);
  end?.();
}

function armBound(): void {
  if (bound !== undefined) clearTimeout(bound);
  const check = (): void => {
    const cleaning = [...cleanups].some((one) => !one.interrupted);
    if (cleaning || performance.now() - lastCleanup < UNWIND_BOUND_MS) {
      bound = setTimeout(check, UNWIND_BOUND_MS);
      return;
    }
    exitNow();
  };
  bound = setTimeout(check, UNWIND_BOUND_MS);
}

/**
 * What a wait about to START does once a Ctrl-C has been answered: `run` in a `cleanup`,
 * `raise` if it is the first wait of an unwind that nothing pending had taken the interrupt
 * for, and otherwise `hold` -- never start, never settle -- because the process is ending.
 *
 * A wait that starts AFTER the Interrupted was raised, outside any cleanup, is code
 * that must never run: something caught the interrupt as if it were an ordinary failure
 * and carried on (a TypeScript `catch` meant as an ordinary-failure handler). Carrying on
 * with it would start the next child, send the next request, print the next line -- so the
 * process ends there.
 */
function gate(): 'run' | 'raise' | 'hold' {
  if (state.mode === 'idle') return 'run';
  if (state.mode === 'exit') return 'hold';
  const frame = frames.getStore();
  if (frame?.cleanup != null && !frame.cleanup.interrupted) return 'run';
  if (frame?.unwinds === true && !state.delivered) {
    state.delivered = true;
    return 'raise';
  }
  exitNow();
  return 'hold';
}

/**
 * A wait Ctrl-C can reach. `start` begins the work and says how to `stop` it; `graceMs` is
 * how long the work may take to end on its own first (`POPEN_SIGINT_WAIT_MS` for a child).
 *
 * Taken over by an interrupt, the wait never settles with the work's own result: inside
 * `unwindsOnInterrupt` it rejects with an Interrupted once the work is stopped, and
 * outside it stays pending while the process ends. A child that exits inside the grace
 * is still an interrupt, whatever the child did.
 */
export function interruptibly<T>(
  start: () => { readonly done: Promise<T>; readonly stop: () => void },
  graceMs = 0,
): Promise<T> {
  const gated = gate();
  if (gated === 'raise') return Promise.reject(new Interrupted());
  if (gated === 'hold') return new Promise<T>(() => undefined);
  const signal = stopSignal();
  if (signal?.aborted === true) return Promise.reject(new Interrupted());
  const { done, stop } = start();
  const frame = frames.getStore();
  return new Promise<T>((resolve, reject) => {
    let taken = false;
    const entry: Waiting = {
      unwinds: frame?.unwinds === true,
      take: async (raise) => {
        taken = true;
        if (graceMs > 0) {
          // A LATER Ctrl-C lands inside this grace: the child is killed and the unwind goes
          // on. So the grace can be cut short (`interrupt`), rather than the second Ctrl-C
          // finding nothing pending and ending the process with nothing unwound.
          let timer: NodeJS.Timeout | undefined;
          let hurry = (): void => undefined;
          await Promise.race([
            done.then(
              () => undefined,
              () => undefined,
            ),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, graceMs);
              hurry = resolve;
              inGrace.add(hurry);
            }),
          ]);
          clearTimeout(timer);
          inGrace.delete(hurry);
        }
        stop();
        if (raise) reject(new Interrupted());
      },
    };
    // Its job stopped: this wait alone is taken over, as a Ctrl-C would take it.
    const stopped = (): void => {
      if (waiting.delete(entry)) void entry.take(true);
    };
    waiting.add(entry);
    signal?.addEventListener('abort', stopped, { once: true });
    done.then(
      (value) => {
        waiting.delete(entry);
        signal?.removeEventListener('abort', stopped);
        if (!taken) resolve(value);
      },
      (error: unknown) => {
        waiting.delete(entry);
        signal?.removeEventListener('abort', stopped);
        if (!taken) reject(error);
      },
    );
  });
}

/**
 * Where a pending interrupt is raised in work that waits on nothing a Ctrl-C reaches --
 * packing a bundle -- this is the wait.
 */
export function interruptPoint(): Promise<void> {
  return interruptibly(() => ({ done: Promise.resolve(), stop: () => undefined }));
}

/** A sleep, which a Ctrl-C interrupts. */
export function sleep(ms: number): Promise<void> {
  return interruptibly(() => {
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    return { done, stop: () => clearTimeout(timer) };
  });
}

/**
 * Run `body` so that a Ctrl-C UNWINDS it: the waits inside reject with `Interrupted`,
 * and the `finally` and `catch` blocks around them run on the way out.
 *
 * Outside every such body a Ctrl-C ends the process once what it waits on is stopped, with
 * nothing unwound (`interrupt`). That is the default on purpose. Every TypeScript `catch`
 * catches an Interrupted, and the ordinary-failure handlers they stand for must not:
 * raised into a path that has not been read for that, the interrupt is swallowed and the
 * command carries on -- `ready`'s restart count answers 0 and it prints one more
 * `still booting` line. So an unwind is asked for where a cleanup is, around a body whose
 * catches have been read.
 */
export async function unwindsOnInterrupt<T>(body: () => Promise<T>): Promise<T> {
  unwinding += 1;
  try {
    return await frames.run({ unwinds: true, cleanup: null }, body);
  } finally {
    unwinding -= 1;
  }
}

/**
 * Run `fn` as cleanup: to completion, whether or not an Interrupted is unwinding
 * through it. Its waits start normally after the interrupt, and a Ctrl-C while it runs
 * raises inside it.
 */
export async function cleanup<T>(fn: () => Promise<T>): Promise<T> {
  const parent = frames.getStore();
  const running: Cleanup = { interrupted: false };
  cleanups.add(running);
  try {
    return await frames.run({ unwinds: parent?.unwinds === true, cleanup: running }, fn);
  } finally {
    cleanups.delete(running);
    lastCleanup = performance.now();
  }
}

/** Whether a Ctrl-C has been answered by `interrupt` in this process. */
export function interruptRaised(): boolean {
  return state.mode !== 'idle';
}

/** Resolves once every wait the interrupt took over has had its work stopped. */
export async function interruptSettled(): Promise<void> {
  await Promise.allSettled(stopping);
}

/**
 * The CLI's Ctrl-C: `runMain`'s SIGINT listener calls this, with how to end the process.
 *
 * Inside `unwindsOnInterrupt`, the waits there raise Interrupted and the command
 * unwinds; `end` is called only if the unwind cannot finish (`UNWIND_BOUND_MS`), if it
 * resumes the command instead (`gate`), or at a second Ctrl-C with nothing left to raise
 * in. Anywhere else, every pending wait has its work stopped -- a child after its grace
 * (`POPEN_SIGINT_WAIT_MS`), then SIGKILLed -- and then `end` is called. A Ctrl-C while an
 * earlier one's grace runs ends the grace: the child is killed there and then.
 */
export function interrupt(end: () => void): void {
  // Whatever an earlier Ctrl-C left in its grace is killed now, and goes on as it would have.
  const hurried = [...inGrace];
  inGrace.clear();
  for (const hurry of hurried) hurry();
  if (state.mode === 'exit') return;
  endProcess = end;
  const first = state.mode === 'idle';
  if (first) state = unwinding > 0 ? { mode: 'raise', delivered: false } : { mode: 'exit' };
  const raising = state.mode === 'raise' ? state : null;
  for (const running of cleanups) running.interrupted = true;
  const taken = [...waiting];
  waiting.clear();
  if (raising === null) {
    // Nothing to stop: end now, in this handler.
    if (taken.length === 0) {
      exitNow();
      return;
    }
    const stopped = taken.map((one) => one.take(false));
    stopping.push(...stopped);
    void Promise.allSettled(stopped).then(exitNow);
    return;
  }
  if (!first && hurried.length === 0 && !taken.some((one) => one.unwinds)) {
    exitNow();
    return;
  }
  for (const one of taken) {
    if (one.unwinds) raising.delivered = true;
    stopping.push(one.take(one.unwinds));
  }
  armBound();
}

/** Forget an interrupt, for a test that raised one in its own process. */
export function resetInterruptForTest(): void {
  if (bound !== undefined) clearTimeout(bound);
  bound = undefined;
  state = { mode: 'idle' };
  endProcess = null;
  waiting.clear();
  inGrace.clear();
  cleanups.clear();
  stopping.length = 0;
  unwinding = 0;
  lastCleanup = 0;
}

type Mode = 'capture' | 'stream' | 'inherit';

/**
 * How long the death of a child killed by SIGINT is held back before it is reported.
 *
 * A terminal's Ctrl-C signals its whole foreground process group at once, so the child
 * and Houston are interrupted by the same keypress and Houston's SIGINT is sent before the
 * child can die of its own. The interrupt must be answered first, and the command
 * interrupted whatever the child's status says, as it always has been. Node does not keep
 * that order: the signal and the child's exit both wait for the event loop, and the exit
 * can be handed to JS first. MEASURED on a pty,
 * `logs --name <ws> --follow` waiting on a docker whose `compose logs` was `sleep 30`,
 * Ctrl-C typed: in 14 of 300 runs (two loops at once; 1 of 100 alone) the child's `close`
 * reached JS 1.2 to 2.3 ms before Houston's own SIGINT -- in the same turn of the loop in
 * 13, 407 turns later in one. `logs` then returned 0, since it discards compose's code,
 * and `runMain` wrote an `end` record of 0 and removed its handler before the interrupt
 * got there: exit 0, every one of the 14. An earlier release gave 130 and an `end` of 130
 * in every run.
 *
 * Held, the interrupt that came with the child's death is answered first, by `runMain`
 * or by a command's own listener: 300 of 300 runs then exited 130 with an `end` of 130, 4
 * of them in the late order. The result is unchanged; only
 * when it is reported moves. A child killed on its own, with no interrupt for Houston,
 * is reported this much later and otherwise as before -- `logs` still exits 0, as it
 * always has. Not held: a child this seam signalled itself, and a child in its own
 * process group (`processGroup`), which a terminal's Ctrl-C does not reach.
 */
const INTERRUPT_GRACE_MS = 100;

/**
 * Node cannot map a child's stderr to that same child's newly-created stdout pipe.
 * A tiny Node relay supplies one real descriptor to both fds without using a shell.
 * The control fd reports an inner spawn error separately from user output.
 */
const MERGE_RELAY = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Socket } = require('node:net');
let failed = false;
let finished = false;
let controlStream;
const child = spawn(process.argv[1], process.argv.slice(2), {
  shell: false,
  stdio: ['inherit', process.stdout, process.stdout],
});
child.once('error', error => {
  failed = true;
  controlStream.destroy();
  fs.writeSync(3, JSON.stringify({
    name: error.name,
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
  }));
  process.exit(127);
});
child.once('exit', (code, signal) => {
  if (failed) return;
  finished = true;
  controlStream.destroy();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
let control = '';
controlStream = new Socket({ fd: 4, readable: true, writable: false })
  .setEncoding('utf8')
  .on('data', chunk => {
    control += chunk;
    let newline;
    while ((newline = control.indexOf('\n')) !== -1) {
      const raw = control.slice(0, newline);
      control = control.slice(newline + 1);
      const signal = /^\d+$/.test(raw) ? Number(raw) : raw;
      child.kill(signal);
    }
  })
  .on('end', () => {
    if (!failed && !finished) child.kill('SIGKILL');
  });
`;

function command(argv: Argv): { file: string; args: string[]; frozen: readonly string[] } {
  if (argv.length === 0 || argv[0].length === 0)
    throw new TypeError('argv must name an executable');
  return { file: argv[0], args: argv.slice(1), frozen: Object.freeze([...argv]) };
}

function decode(chunks: readonly Buffer[], encoding: TextEncoding | null): string | Buffer {
  const joined = Buffer.concat(chunks);
  return encoding === null ? joined : new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals | number,
  processGroup: boolean,
): void {
  if (child.pid === undefined) return;
  if (processGroup && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  child.kill(signal);
}

function signalManagedChild(
  child: ChildProcess,
  signal: NodeJS.Signals | number,
  processGroup: boolean,
  mergeRelayControl: Writable | null,
): void {
  if (mergeRelayControl !== null && (!processGroup || process.platform === 'win32')) {
    if (!mergeRelayControl.destroyed && mergeRelayControl.writable) {
      try {
        mergeRelayControl.write(`${signal}\n`);
      } catch {
        mergeRelayControl.destroy();
      }
    }
    return;
  }
  signalChild(child, signal, processGroup);
}

/**
 * A child Houston waits on: a Ctrl-C gives it `POPEN_SIGINT_WAIT_MS` to exit on its own,
 * then SIGKILLs it (see `interruptibly`). Unless its caller answers the
 * interrupt itself (`interrupt: 'caller'`).
 */
function runMode(
  argv: Argv,
  mode: Mode,
  options: CaptureOptions | StreamOptions | InheritOptions,
): Promise<ProcessResult> {
  if (options.interrupt === 'caller') return launch(argv, mode, options).done;
  return interruptibly(() => launch(argv, mode, options), POPEN_SIGINT_WAIT_MS);
}

/** No child was started, so there is nothing for an interrupt to stop. */
function notLaunched(error: Error): { done: Promise<ProcessResult>; stop: () => void } {
  return { done: Promise.reject(error), stop: () => undefined };
}

function launch(
  argv: Argv,
  mode: Mode,
  options: CaptureOptions | StreamOptions | InheritOptions,
): { done: Promise<ProcessResult>; stop: () => void } {
  const resolved = command(argv);
  const processGroup = options.processGroup ?? false;
  const encoding = 'encoding' in options ? (options.encoding ?? null) : null;
  const mergeStderr = 'mergeStderr' in options && options.mergeStderr === true;
  const ioOptions = mode === 'inherit' ? null : (options as CaptureOptions | StreamOptions);
  if (ioOptions?.input !== undefined && ioOptions.stdin !== undefined) {
    return notLaunched(new TypeError('input and stdin are mutually exclusive'));
  }
  if (mergeStderr && mode === 'stream' && (options as StreamOptions).stderrSink !== undefined) {
    return notLaunched(new TypeError('stderrSink cannot be used when mergeStderr is true'));
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    return notLaunched(new RangeError('timeoutMs must be a finite non-negative number'));
  }
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const mergedChunks: Buffer[] = [];

  const mergedThroughRelay = mergeStderr && mode !== 'inherit';
  const stdinMode =
    ioOptions?.input !== undefined ||
    (ioOptions?.stdin !== undefined && typeof ioOptions.stdin !== 'string')
      ? 'pipe'
      : (ioOptions?.stdin ?? 'inherit');
  let child: ChildProcess;
  try {
    child = nodeSpawn(
      mergedThroughRelay ? process.execPath : resolved.file,
      mergedThroughRelay
        ? ['-e', MERGE_RELAY, '--', resolved.file, ...resolved.args]
        : resolved.args,
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        detached: processGroup,
        shell: false,
        stdio:
          mode === 'inherit'
            ? (options as InheritOptions).stdoutToStderr === true
              ? ['inherit', 2, 'inherit']
              : 'inherit'
            : mergedThroughRelay
              ? [stdinMode, 'pipe', 'ignore', 'pipe', 'pipe']
              : [stdinMode, 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    return notLaunched(new SpawnFailure(resolved.frozen, error as NodeJS.ErrnoException));
  }

  let stop = (): void => undefined;
  const done = new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    // Whether this seam sent the child a signal itself, and whether a death by SIGINT is
    // being held back (see INTERRUPT_GRACE_MS).
    let signalled = false;
    let holding = false;
    let timer: NodeJS.Timeout | undefined;
    let closed: { exitCode: number | null; exitSignal: NodeJS.Signals | null } | null = null;
    let pendingSinkWrites = 0;
    const mergeControl: Buffer[] = [];
    const mergeRelayControl = mergedThroughRelay ? (child.stdio[4] as Writable | null) : null;
    if (mergedThroughRelay) {
      (child.stdio[3] as Readable | null)?.on('data', (chunk: Buffer) => {
        mergeControl.push(Buffer.from(chunk));
      });
    }

    const stdoutDecoder =
      mode === 'stream' && encoding !== null ? new TextDecoder('utf-8', { fatal: true }) : null;
    const stderrDecoder =
      mode === 'stream' && encoding !== null ? new TextDecoder('utf-8', { fatal: true }) : null;
    const streamOptions = mode === 'stream' ? (options as StreamOptions) : null;

    const finishStream = (
      decoder: TextDecoder | null,
      callback: ((chunk: ProcessChunk) => void) | undefined,
    ): void => {
      if (decoder === null || callback === undefined) return;
      try {
        const tail = decoder.decode();
        if (tail.length > 0) {
          callback(tail);
        }
      } catch (error) {
        fail(error);
      }
    };

    const cleanup = (keepSinkErrorListener?: Writable): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', abort);
      if (ioOptions?.stdin !== undefined && typeof ioOptions.stdin !== 'string') {
        ioOptions.stdin.removeListener('error', fail);
        if (child.stdin !== null) ioOptions.stdin.unpipe(child.stdin);
      }
      if (streamOptions?.stdoutSink !== keepSinkErrorListener) {
        streamOptions?.stdoutSink?.removeListener('error', fail);
      }
      if (streamOptions?.stderrSink !== keepSinkErrorListener) {
        streamOptions?.stderrSink?.removeListener('error', fail);
      }
    };

    const controlError = (error: NodeJS.ErrnoException): void => {
      // The relay is gone -- killed with the child it relays for, by the same terminal
      // Ctrl-C -- so there is nothing left to signal, as ESRCH is nothing for a direct child
      // (`signalChild`). Its death reaches `close` like any other. Rejecting here turned a
      // signal sent to a dead relay into the command's error: Kubernetes `logs`, Ctrl-C'd on
      // a terminal, terminates kubectl, as it always has, and wrote a JS stack of
      // `read ECONNRESET` instead of exiting 254.
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
        mergeRelayControl?.destroy();
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      mergeRelayControl?.destroy();
      reject(error);
    };

    mergeRelayControl?.once('error', controlError);

    const abort = (): void => {
      signalled = true;
      try {
        signalManagedChild(
          child,
          options.abortKillSignal ?? 'SIGTERM',
          processGroup,
          mergeRelayControl,
        );
      } catch (error) {
        fail(error);
      }
    };

    const fail = (error: unknown, possibleLateSinkError?: Writable): void => {
      if (settled) return;
      settled = true;
      cleanup(possibleLateSinkError);
      if (possibleLateSinkError !== undefined) {
        // Writable implementations may both pass the error to the write callback
        // and emit it just afterward. Keep the once-listener for that turn so the
        // duplicate cannot become uncaught, then remove it if no event arrives.
        setImmediate(() => possibleLateSinkError.removeListener('error', fail));
      }
      try {
        signalManagedChild(child, 'SIGKILL', processGroup, mergeRelayControl);
      } catch {
        // Preserve the initiating error; the cancellation failure is secondary.
      }
      reject(error);
    };

    const complete = (): void => {
      if (settled || closed === null || pendingSinkWrites > 0 || holding) return;
      if (mergeControl.length > 0) {
        let record: NodeJS.ErrnoException;
        try {
          const fields = JSON.parse(Buffer.concat(mergeControl).toString('utf8')) as Record<
            string,
            unknown
          >;
          record = Object.assign(new Error(String(fields.message ?? 'spawn failed')), fields);
        } catch (error) {
          record = Object.assign(new Error('merge relay did not report a valid spawn error'), {
            cause: error,
          });
        }
        fail(new SpawnFailure(resolved.frozen, record));
        return;
      }

      const captured = mode === 'capture';
      let result: ProcessResult;
      try {
        result = {
          argv: resolved.frozen,
          exitCode: closed.exitCode,
          signal: closed.exitSignal,
          stdout: captured ? decode(mergeStderr ? mergedChunks : stdoutChunks, encoding) : null,
          stderr: captured && !mergeStderr ? decode(stderrChunks, encoding) : null,
        };
      } catch (error) {
        fail(error);
        return;
      }
      settled = true;
      cleanup();
      if (timedOut && options.timeoutMs !== undefined) {
        reject(new ProcessTimeout(resolved.frozen, options.timeoutMs, result));
      } else {
        resolve(result);
      }
    };

    const writeSink = (sink: Writable, source: Readable, chunk: Buffer): void => {
      pendingSinkWrites += 1;
      source.pause();
      try {
        sink.write(chunk, (error: Error | null | undefined) => {
          pendingSinkWrites -= 1;
          if (error != null) {
            fail(error, sink);
            return;
          }
          source.resume();
          complete();
        });
      } catch (error) {
        pendingSinkWrites -= 1;
        fail(error);
      }
    };

    child.once('error', (cause: NodeJS.ErrnoException) => {
      fail(new SpawnFailure(resolved.frozen, cause));
    });

    if (mode !== 'inherit') {
      // RETAINED ONLY WHEN CAPTURED. The merged copy was kept in every mode, so a `stream`
      // with `mergeStderr` -- Kubernetes `logs -f` is one -- held all the output it had
      // delivered, for a result that is `null` outside capture mode.
      child.stdout?.on('data', (chunk: Buffer) => {
        const copy = Buffer.from(chunk);
        if (mode === 'capture') (mergeStderr ? mergedChunks : stdoutChunks).push(copy);
        if (streamOptions?.onStdout !== undefined) {
          try {
            streamOptions.onStdout(
              stdoutDecoder === null ? copy : stdoutDecoder.decode(copy, { stream: true }),
            );
          } catch (error) {
            fail(error);
          }
        }
        if (streamOptions?.stdoutSink !== undefined && child.stdout !== null) {
          writeSink(streamOptions.stdoutSink, child.stdout, copy);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const copy = Buffer.from(chunk);
        if (mode === 'capture') (mergeStderr ? mergedChunks : stderrChunks).push(copy);
        const callback = mergeStderr ? streamOptions?.onStdout : streamOptions?.onStderr;
        if (callback !== undefined) {
          try {
            callback(stderrDecoder === null ? copy : stderrDecoder.decode(copy, { stream: true }));
          } catch (error) {
            fail(error);
          }
        }
        const sink = mergeStderr ? streamOptions?.stdoutSink : streamOptions?.stderrSink;
        if (sink !== undefined && child.stderr !== null) writeSink(sink, child.stderr, copy);
      });
      if (streamOptions?.stdoutSink !== undefined) {
        streamOptions.stdoutSink.once('error', fail);
      }
      if (!mergeStderr && streamOptions?.stderrSink !== undefined) {
        streamOptions.stderrSink.once('error', fail);
      }
      child.stdout?.once('end', () => finishStream(stdoutDecoder, streamOptions?.onStdout));
      child.stderr?.once('end', () =>
        finishStream(
          stderrDecoder,
          mergeStderr ? streamOptions?.onStdout : streamOptions?.onStderr,
        ),
      );

      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        // A broken pipe when the child exits before consuming all its input is suppressed,
        // as it always has been, which also avoids an unhandled EventEmitter error.
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') fail(error);
      });
      if (
        ioOptions?.stdin !== undefined &&
        typeof ioOptions.stdin !== 'string' &&
        child.stdin !== null
      ) {
        ioOptions.stdin.once('error', fail);
        ioOptions.stdin.pipe(child.stdin);
      } else {
        child.stdin?.end(ioOptions?.input);
      }
    }

    options.abortSignal?.addEventListener('abort', abort, { once: true });
    if (options.abortSignal?.aborted === true) abort();

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        signalled = true;
        try {
          signalManagedChild(
            child,
            options.timeoutSignal ?? 'SIGKILL',
            processGroup,
            mergeRelayControl,
          );
        } catch (error) {
          fail(error);
        }
      }, options.timeoutMs);
    }

    child.once('close', (exitCode, exitSignal) => {
      closed = { exitCode, exitSignal };
      if (exitSignal === 'SIGINT' && !signalled && !processGroup) {
        // The child is gone, so nothing is left to time out: the grace must not become a
        // ProcessTimeout for a child that finished inside its deadline.
        if (timer !== undefined) clearTimeout(timer);
        holding = true;
        setTimeout(() => {
          holding = false;
          complete();
        }, INTERRUPT_GRACE_MS);
        return;
      }
      complete();
    });

    // A Ctrl-C's `run` answer: SIGKILL the child and raise (see `interruptibly`).
    stop = () => fail(new Interrupted());
  });
  return { done, stop };
}

/** Run to completion while retaining stdout and stderr separately by default. */
export function capture(argv: Argv, options: CaptureOptions = {}): Promise<ProcessResult> {
  return runMode(argv, 'capture', options);
}

/** Deliver stdout/stderr as they arrive without retaining an unbounded copy. */
export function stream(argv: Argv, options: StreamOptions = {}): Promise<ProcessResult> {
  return runMode(argv, 'stream', options);
}

/** Run with the parent's stdin/stdout/stderr, including its TTY identity. */
export function inherit(argv: Argv, options: InheritOptions = {}): Promise<ProcessResult> {
  return runMode(argv, 'inherit', options);
}

/**
 * Start a child that intentionally outlives this command.
 *
 * Detached children cannot safely retain Houston's pipes: a referenced pipe would
 * keep the launching command alive. The returned PID is the cleanup handle.
 */
export function startDetached(argv: Argv, options: DetachedOptions = {}): Promise<DetachedProcess> {
  const resolved = command(argv);
  let child: ChildProcess;
  try {
    child = nodeSpawn(resolved.file, resolved.args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
  } catch (error) {
    return Promise.reject(new SpawnFailure(resolved.frozen, error as NodeJS.ErrnoException));
  }

  return new Promise<DetachedProcess>((resolve, reject) => {
    child.once('error', (cause: NodeJS.ErrnoException) => {
      reject(new SpawnFailure(resolved.frozen, cause));
    });
    child.once('spawn', () => {
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error('spawned child has no pid'));
        return;
      }
      child.unref();
      resolve({ argv: resolved.frozen, pid });
    });
  });
}
