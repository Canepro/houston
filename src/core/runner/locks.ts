/**
 * The workspace lock: exclusive for one repro, across callers AND processes.
 *
 * The mechanism is `seams/fs/lock.ts`; what lives here is the policy -- which file a
 * workspace's lock is, how long to wait, and the sentence a refusal becomes. The seam reports
 * the failure; this adapter owns the public error contract, which is the same division the
 * process seam draws.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as config from '../../lib/config';
import { joinPath } from '../../lib/home';
import { fileErrorOf } from '../../lib/format';
import { mkdirParents } from '../../lib/mkdir-parents';
import {
  LockUnavailable,
  OPEN_FOR_WRITE,
  conflictFrom,
  holdsFileLock,
  withFileLock,
} from '../../seams/fs/lock';

/** The workspace lock's established 900 s wait, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 900_000;

export function lockPath(name: string): string {
  // `locks/<name>.lock` under the home, joined component by component, a `..` kept
  // (`joinPath`): `path.join` folded a `..` in the home, so an earlier version and the
  // previous implementation locked two different files for one workspace.
  return joinPath(config.home(), 'locks', `${name}.lock`);
}

/**
 * Hold this repro's lock for the duration of `body`.
 *
 * Every mutating operation does read-compose -> write-compose -> `docker compose up`.
 * Two interleaving on one repro corrupts it: compose races itself and leaves an
 * orphaned container behind, which is how a repro ends up with Rocket.Chat gone and a
 * stray `<hash>_houston-...` container in its place.
 *
 * REENTRANT, and that is load-bearing rather than tidy: `restore --new` holds the lock and
 * then calls `createRepro`, which takes it again. The seam tracks the depth per async
 * execution. The nested frame must not re-take the file lock, because `flock` self-blocks
 * on a second descriptor exactly as an OFD lock does.
 *
 * Degrades to in-process-only where no `flock(1)` exists, as the previous implementation
 * degrades without `fcntl`: a hard dependency would be worse than the
 * race it prevents, and the `IMPLEMENTATION` marker is the mechanism that still refuses
 * a foreign build.
 */
export async function reproLock<T>(
  name: string,
  body: () => T | Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const target = lockPath(name);
  if (!holdsFileLock(target)) {
    // A home this user may not write is `<home>/locks: Permission denied`, where Node's
    // own sentence is `EACCES: permission denied, mkdir ...`.
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
    } catch (error) {
      throw fileErrorOf(error, path.dirname(target));
    }
  }
  try {
    // `open(path, "w")`: a lock file this user cannot write, or a directory in its place,
    // raises before the body runs rather than being locked read-only.
    return await withFileLock(target, body, { timeoutMs, open: OPEN_FOR_WRITE });
  } catch (error) {
    if (error instanceof LockUnavailable) throw conflictFrom(error, name, timeoutMs / 1000);
    throw error;
  }
}

/**
 * Read-modify-write config.yaml under a lock held across PROCESSES; `mutate(cfg)` edits it.
 *
 * `config.updateConfig` is atomic about the FILE and says nothing about the UPDATE: `serve`
 * runs continuously while somebody uses the CLI on the same box, each mutates a different
 * key, both write, and the later rename wins with the other change gone and nothing logged.
 * The previous implementation holds its config lock (`home/.config.lock`, flock plus an
 * OFD lock) around the same three steps; this is that lock, on that file, so the two
 * builds also exclude each other. Every production writer comes through here.
 */
async function withConfigLock<T>(body: () => T | Promise<T>): Promise<T> {
  // The home made with its parents, the mode 0700 on the home alone.
  mkdirParents(config.home(), 0o700);
  const target = joinPath(config.home(), '.config.lock');
  // `.config.lock` opened `O_WRONLY | O_CREAT`: created 0600, never truncated, and a lock
  // that cannot be opened for writing is the established OS error here too.
  return await withFileLock(target, body, {
    open: { truncate: false, mode: 0o600 },
  });
}

export async function updateConfig(mutate: (cfg: config.Config) => void): Promise<config.Config> {
  return await withConfigLock(() => config.updateConfig(mutate));
}

/**
 * Read, decide, and write config.yaml under one cross-process lock.
 *
 * A caller with no change must avoid config.updateConfig: it always rewrites the file, which
 * can refresh versioned metadata even when its callback did not mutate a value.
 */
export async function updateConfigIf(mutate: (cfg: config.Config) => boolean): Promise<boolean> {
  return await withConfigLock(() => {
    const cfg = config.loadConfig(false);
    if (!mutate(cfg)) return false;
    config.saveConfig(cfg);
    return true;
  });
}

/** Whether this execution already holds `name`'s lock. */
export function heldBy(name: string): boolean {
  return holdsFileLock(lockPath(name));
}
