/**
 * `docker compose` for one workspace.
 *
 * Every function here is the workspace-aware half: it turns a name into a directory and hands
 * argv to `seams/docker-cli`, which knows nothing about workspaces. The error contracts are
 * the established ones, and they differ on purpose -- the mutating calls propagate a launch
 * failure, the best-effort samplers degrade to "no sample" rather than stranding their
 * caller.
 */
import {
  invalidateQueries,
  compose as runCompose,
  composeFromFile,
  composeStream,
  composeToFile,
} from '../../seams/docker-cli';
import type { ProcessResult } from '../../seams/exec';

import * as paths from './paths';

export interface ComposeOptions {
  readonly capture?: boolean;
  readonly timeoutMs?: number;
  readonly text?: boolean;
}

/**
 * Run `docker compose <args>` in a repro workspace.
 *
 * `timeoutMs` is opt-in and left unset by default: `up`, `pull` and `logs -f` are
 * legitimately long-running. Bounded callers pass one so a wedged daemon cannot block
 * a worker forever.
 */
export async function compose(
  name: string,
  args: readonly string[],
  options: ComposeOptions = {},
): Promise<ProcessResult> {
  return await runCompose(args, { ...options, cwd: paths.workspace(name) });
}

/**
 * Run `docker compose <args>` streaming combined output line by line, for live
 * progress in the web UI. Returns the exit code.
 */
export async function stream(
  name: string,
  args: readonly string[],
  onLine?: (line: string) => void,
  { abortSignal }: { abortSignal?: AbortSignal } = {},
): Promise<number | null> {
  return await composeStream(args, {
    cwd: paths.workspace(name),
    ...(onLine !== undefined ? { onLine } : {}),
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
}

/**
 * A compose command that CHANGES container state.
 *
 * Drops the memoised query results afterwards: a dashboard that still showed "running"
 * for two seconds after a Stop would be a cache the user can notice, which is worse
 * than the process spawns the memo saves.
 */
async function mutating(name: string, args: readonly string[]): Promise<number | null> {
  try {
    return (await compose(name, args)).exitCode;
  } finally {
    invalidateQueries();
  }
}

/**
 * `docker compose up -d`. `forceRecreate` names ONE service to rebuild anyway.
 *
 * Compose decides what to recreate by comparing a config hash it stores on the
 * container. MEASURED that this is not always enough: an `env` apply interrupted
 * mid-recreate left the compose file carrying a variable the container did not have,
 * and a later `up` reported "Booted in 0s" without recreating -- so the workspace kept
 * running configuration its own recorded state disagreed with, and no houston command
 * reconverged it.
 *
 * Scoped to one service on purpose. Recreating everything would take Mongo down with it
 * on every apply, and the whole reason this is safe is that it does not.
 */
export async function up(
  name: string,
  { pull = true, forceRecreate = '' } = {},
): Promise<number | null> {
  if (pull) {
    // A failed pull is deliberately non-fatal: cached images may satisfy `up -d` anyway
    // (a registry hiccup), and `up` itself fails loudly if an image is truly missing.
    await compose(name, ['pull']);
  }
  // --remove-orphans: if the compose file changed shape (a different preset after
  // --force), containers of dropped services are cleaned up.
  const args = ['up', '-d', '--remove-orphans'];
  // --no-deps so rebuilding Rocket.Chat does not take its database with it.
  if (forceRecreate) args.push('--force-recreate', '--no-deps', forceRecreate);
  return await mutating(name, args);
}

export async function down(name: string, { volumes = false } = {}): Promise<number | null> {
  const args = ['down', '--remove-orphans'];
  if (volumes) args.push('-v');
  return await mutating(name, args);
}

export async function start(name: string): Promise<number | null> {
  return await mutating(name, ['start']);
}

export async function stop(name: string): Promise<number | null> {
  return await mutating(name, ['stop']);
}

export async function restart(name: string): Promise<number | null> {
  return await mutating(name, ['restart']);
}

export async function logs(
  name: string,
  { follow = false, tail }: { follow?: boolean; tail?: number } = {},
): Promise<number | null> {
  const args = ['logs'];
  if (follow) args.push('-f');
  if (tail !== undefined) args.push('--tail', String(tail));
  return (await compose(name, args)).exitCode;
}

/** Run a command inside a running compose service (`docker compose exec -T`). */
export async function composeExec(
  name: string,
  service: string,
  args: readonly string[],
): Promise<number | null> {
  return (await compose(name, ['exec', '-T', service, ...args])).exitCode;
}

/**
 * Like `composeExec`, but captures stdout.
 *
 * Returns `[1, '']` instead of raising when the exec cannot run or the timeout expires,
 * so best-effort samplers degrade to "no sample" rather than stranding their caller.
 */
export async function composeExecCapture(
  name: string,
  service: string,
  args: readonly string[],
  timeoutMs?: number,
): Promise<[number, string]> {
  try {
    const result = await compose(name, ['exec', '-T', service, ...args], {
      capture: true,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return [result.exitCode ?? 1, String(result.stdout ?? '')];
  } catch {
    return [1, ''];
  }
}

/** Run a command in a service, writing its RAW stdout to `destination`. */
export async function composeExecToFile(
  name: string,
  service: string,
  args: readonly string[],
  destination: string,
  timeoutMs?: number,
): Promise<[number, string]> {
  try {
    const result = await composeToFile(['exec', '-T', service, ...args], destination, {
      cwd: paths.workspace(name),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return [result.exitCode ?? 1, result.stderr];
  } catch (error) {
    return [1, String(error)];
  }
}

/** Run a command in a service with `source` piped to its stdin. */
export async function composeExecFromFile(
  name: string,
  service: string,
  args: readonly string[],
  source: string,
  timeoutMs?: number,
): Promise<[number, string]> {
  try {
    const result = await composeFromFile(['exec', '-T', service, ...args], source, {
      cwd: paths.workspace(name),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return [result.exitCode ?? 1, result.output];
  } catch (error) {
    return [1, String(error)];
  }
}

/**
 * Stop specific services, leaving the rest of the project running.
 *
 * `stop` stops everything including Mongo -- useless for a dump, which needs Mongo up
 * and only the writers quiesced.
 */
export async function stopServices(
  name: string,
  services: readonly string[],
): Promise<number | null> {
  return (await compose(name, ['stop', ...services])).exitCode;
}

export async function startServices(
  name: string,
  services: readonly string[],
): Promise<number | null> {
  return (await compose(name, ['start', ...services])).exitCode;
}

/** Stop and remove specific services (`docker compose rm -s -f <services>`). */
export async function rmServices(
  name: string,
  services: readonly string[],
): Promise<number | null> {
  return (await compose(name, ['rm', '-s', '-f', ...services])).exitCode;
}

/** Container id(s) of one compose service in this repro (usually a single id). */
export async function serviceContainerIds(name: string, service: string): Promise<string[]> {
  const result = await compose(name, ['ps', '-q', service], { capture: true });
  if (result.exitCode !== 0) return [];
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Container ids of a repro's running services (`docker compose ps -q`). */
export async function containerIds(name: string): Promise<string[]> {
  const result = await compose(name, ['ps', '-q'], { capture: true });
  return String(result.stdout ?? '')
    .split(/\s+/u)
    .filter(Boolean);
}

/** `docker compose ps` for a repro, as service/state/status lines. */
export async function ps(name: string): Promise<string> {
  const result = await compose(name, ['ps', '--format', '{{.Service}}\t{{.State}}\t{{.Status}}'], {
    capture: true,
  });
  return String(result.stdout ?? '');
}

/**
 * Captured (not streamed) combined logs for a repro, for post-mortem diagnosis of a
 * failed `up`. '' on error.
 */
export async function composeLogsCapture(name: string, { tail = 200 } = {}): Promise<string> {
  const result = await compose(name, ['logs', '--no-color', '--tail', String(tail)], {
    capture: true,
  });
  return String(result.stdout ?? '') + String(result.stderr ?? '');
}

/**
 * Captured output of `docker compose pull`, used to surface registry errors when a
 * repro never started any container. '' on error.
 */
export async function composePullCapture(name: string): Promise<string> {
  const result = await compose(name, ['pull'], { capture: true });
  return String(result.stdout ?? '') + String(result.stderr ?? '');
}
