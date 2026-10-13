/**
 * The `docker` and `docker compose` command line, and the two memos in front of it.
 *
 * Thin by contract. This module knows argv, a working directory, and how long a docker
 * fact stays true; it knows nothing about workspaces, presets or metadata. Everything
 * that needs a workspace name lives in `core/runner`, which supplies the directory --
 * that is what keeps the seam below the state owner rather than entangled with it.
 *
 * ## The error policy is the caller's, deliberately
 *
 * `runner.compose` raises when docker cannot be launched; `composeExecCapture` returns
 * `[1, '']` instead; `firstLine` and `composeLs` return null; `dockerStats` returns an
 * empty string. Those are four different contracts on top of one launch, and
 * flattening them into a universal "never throws" wrapper would silently turn a refusal
 * into an empty answer at the two sites that distinguish them. So the primitives here
 * propagate what `exec` raises, and each adapter above applies its own.
 *
 * ## The two memos
 *
 * `QUERY_TTL_MS` (2.5 s) covers the read-only queries the dashboard poll repeats. Each
 * open tab asks for /api/repros every 4 s, which is `docker compose ls` plus `docker ps`
 * plus `docker info`; ten teammates with a tab open is ~40 process spawns every 4
 * seconds on a shared box. Memoised just long enough to collapse concurrent tabs into
 * one call, and INVALIDATED by every mutation so the UI never shows a stale state after
 * an action -- a cache the user can notice would be worse than the spawns.
 *
 * `DOCKER_TTL_MS` (3 s) covers `docker info` alone. It forks a client that talks to the
 * daemon (~35 ms) and /api/health calls it on every poll, which turns the cheap
 * unauthenticated check into the most expensive thing the server does. Short enough
 * that `doctor` and the badge still react to Docker stopping within a poll or two.
 */
import * as fs from 'node:fs';

import { active as jsonActive } from '../lib/jsonout';

import { Interrupted, capture, inherit, stream, type ProcessResult } from './exec';

/** How long `docker info`'s answer is reused: three seconds. */
export const DOCKER_TTL_MS = 3_000;

/** How long a read-only docker query is reused: two and a half seconds. */
export const QUERY_TTL_MS = 2_500;

export interface DockerOptions {
  readonly input?: string | Buffer;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /**
   * Retain stdout and stderr. Without it the child INHERITS the terminal, as
   * `capture_output=False` does -- not "they go nowhere", which is what this said while
   * `docker` captured every call and dropped what it caught.
   */
  readonly capture?: boolean;
  /** UTF-8 text like `text=True`; otherwise bytes, which is what an archive needs. */
  readonly text?: boolean;
  readonly mergeStderr?: boolean;
  /**
   * A replacement environment.
   *
   * Nothing in `core/runner` passes one today -- docker reads DOCKER_HOST,
   * DOCKER_CONTEXT and DOCKER_CONFIG from the inherited environment and that is the
   * behaviour every caller wants. It is here because a process seam that cannot say
   * which environment it runs under forces the first caller that needs one to go
   * around it.
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly abortSignal?: AbortSignal;
}

function options(given: DockerOptions): {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  encoding: 'utf8' | null;
  mergeStderr?: boolean;
  abortSignal?: AbortSignal;
  input?: string | Buffer;
} {
  return {
    ...(given.cwd !== undefined ? { cwd: given.cwd } : {}),
    ...(given.timeoutMs !== undefined ? { timeoutMs: given.timeoutMs } : {}),
    ...(given.env !== undefined ? { env: given.env } : {}),
    ...(given.mergeStderr !== undefined ? { mergeStderr: given.mergeStderr } : {}),
    ...(given.abortSignal !== undefined ? { abortSignal: given.abortSignal } : {}),
    ...(given.input === undefined ? {} : { input: given.input }),
    encoding: given.text === false ? null : 'utf8',
  };
}

/**
 * Run a `docker ...` command. Raises what `exec` raises; the adapter decides.
 *
 * Uncaptured, docker INHERITS the terminal:
 * that is how `pull` draws its progress, how `up`, `stop` and `down` say which container
 * they touched, and how a failure reaches the person in docker's own words -- `Error
 * response from daemon: ...` above houston's one-line diagnosis. This captured every call
 * and dropped what it caught, so none of that was ever shown.
 *
 * Under --json the child's stdout goes to stderr instead, as `compose` sends it there in
 * JSON mode: stdout carries JSON and nothing else.
 */
export async function docker(
  argv: readonly string[],
  given: DockerOptions = {},
): Promise<ProcessResult> {
  const command = ['docker', ...argv] as [string, ...string[]];
  if (given.capture === true) return await capture(command, options(given));
  return await inherit(command, {
    ...(given.cwd !== undefined ? { cwd: given.cwd } : {}),
    ...(given.timeoutMs !== undefined ? { timeoutMs: given.timeoutMs } : {}),
    ...(given.env !== undefined ? { env: given.env } : {}),
    ...(given.abortSignal !== undefined ? { abortSignal: given.abortSignal } : {}),
    stdoutToStderr: jsonActive(),
  });
}

/**
 * Run `docker compose <args>` in a directory.
 *
 * `timeoutMs` is opt-in and left unset by default: `up`, `pull` and `logs -f` are
 * legitimately long-running. Bounded callers (samplers, one-shot queries) pass one so a
 * wedged daemon cannot block a worker forever.
 */
export async function compose(
  args: readonly string[],
  given: DockerOptions = {},
): Promise<ProcessResult> {
  return await docker(['compose', ...args], given);
}

/**
 * Run `docker compose <args>` delivering combined stdout+stderr line by line.
 *
 * Streamed rather than captured so the GUI sees progress as it happens; the CLI keeps
 * the blocking path, which inherits the terminal for docker's own progress rendering.
 */
export async function composeStream(
  args: readonly string[],
  given: DockerOptions & { onLine?: (line: string) => void } = {},
): Promise<number | null> {
  let buffered = '';
  const deliver = (chunk: string | Buffer): void => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/u, '');
      buffered = buffered.slice(newline + 1);
      if (given.onLine !== undefined && line !== '') given.onLine(line);
      newline = buffered.indexOf('\n');
    }
  };
  const result = await stream(['docker', 'compose', ...args] as [string, ...string[]], {
    ...options({ ...given, mergeStderr: true }),
    onStdout: deliver,
  });
  // A final line with no trailing newline is still a line.
  if (buffered.trim() !== '' && given.onLine !== undefined) given.onLine(buffered.trim());
  return result.exitCode;
}

/**
 * Run `docker compose <args>` writing its RAW stdout to a file.
 *
 * Binary-safe on purpose: `mongodump --archive` emits BSON, and the text-mode decode
 * and newline translation an ordinary capture applies would corrupt it silently -- the
 * dump would restore with errors nobody could trace back here. Returns the exit code
 * and stderr as text.
 */
export async function composeToFile(
  args: readonly string[],
  destination: string,
  given: DockerOptions = {},
): Promise<{ exitCode: number | null; stderr: string }> {
  const sink = fs.createWriteStream(destination);
  try {
    const errors: Buffer[] = [];
    const result = await stream(['docker', 'compose', ...args] as [string, ...string[]], {
      ...options({ ...given, text: false }),
      stdoutSink: sink,
      onStderr: (chunk) => {
        errors.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      },
    });
    return { exitCode: result.exitCode, stderr: Buffer.concat(errors).toString('utf8') };
  } finally {
    await new Promise<void>((resolve) => sink.end(resolve));
  }
}

/**
 * Run `docker compose <args>` with a file piped to its stdin.
 *
 * The counterpart of `composeToFile`, for `mongorestore --archive`. Output is merged so
 * a caller has one blob to show when a restore fails.
 */
export async function composeFromFile(
  args: readonly string[],
  source: string,
  given: DockerOptions = {},
): Promise<{ exitCode: number | null; output: string }> {
  const input = fs.createReadStream(source);
  const collected: Buffer[] = [];
  const result = await stream(['docker', 'compose', ...args] as [string, ...string[]], {
    ...options({ ...given, text: false, mergeStderr: true }),
    stdin: input,
    onStdout: (chunk) => {
      collected.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    },
  });
  return { exitCode: result.exitCode, output: Buffer.concat(collected).toString('utf8') };
}

interface Memo {
  at: number;
  value: unknown;
}

const queries = new Map<string, Memo>();
let dockerSeen: { at: number; ok: boolean } | null = null;

/** Drop every memoised docker fact. Called after anything that changes one. */
export function invalidateQueries(): void {
  queries.clear();
  dockerSeen = null;
}

/**
 * Memoise one read-only query for `QUERY_TTL_MS`.
 *
 * Concurrent callers share the stored value only once it exists; an in-flight call is
 * not shared -- two simultaneous misses both run.
 */
export async function cachedQuery<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = queries.get(key);
  if (hit !== undefined && now - hit.at < QUERY_TTL_MS) return hit.value as T;
  const value = await produce();
  queries.set(key, { at: now, value });
  return value;
}

/**
 * Whether the daemon answers. Cached briefly; `maxAgeMs: 0` forces a probe.
 *
 * Never raises a failure: a missing binary or a timeout is an answer of "no", which is what
 * every caller needs during a preflight or a health poll. An interrupt is not an answer, so
 * it passes, and nothing is cached for it.
 */
export async function dockerAvailable({
  maxAgeMs = DOCKER_TTL_MS,
  env,
}: { maxAgeMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
  const now = Date.now();
  if (maxAgeMs > 0 && dockerSeen !== null && now - dockerSeen.at < maxAgeMs) return dockerSeen.ok;
  let ok: boolean;
  try {
    const result = await docker(['info'], {
      capture: true,
      timeoutMs: 10_000,
      ...(env !== undefined ? { env } : {}),
    });
    ok = result.exitCode === 0;
  } catch (error) {
    // Not a failure to report: Ctrl-C or a stopped job, which must unwind (see exec).
    if (error instanceof Interrupted) throw error;
    // A missing binary or a timeout is an answer of "no", which is what a preflight or
    // a health poll needs -- not an exception to wrap at every call site.
    ok = false;
  }
  dockerSeen = { at: now, ok };
  return ok;
}

/** Run a command and return its trimmed stdout, or null on any failure; an interrupt passes. */
export async function firstLine(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  let result: ProcessResult;
  try {
    result = await capture(argv as [string, ...string[]], {
      encoding: 'utf8',
      timeoutMs: 10_000,
      ...(env !== undefined ? { env } : {}),
    });
  } catch (error) {
    // Not a failure to report: Ctrl-C or a stopped job, which must unwind (see exec).
    if (error instanceof Interrupted) throw error;
    return null;
  }
  return result.exitCode === 0 ? String(result.stdout ?? '').trim() : null;
}
