/**
 * Facts about the machine and the Docker engine, none of them fatal.
 *
 * Every function here answers "I do not know" rather than raising: callers use them during
 * best-effort restore paths and preflights, where an error (docker gone, a fork failure) must
 * not escape.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { pathHome, joinPath } from '../../lib/home';
import { decodeUtf8Strict, isTruthy, expectedText } from '../../lib/format';
import { loads } from '../../lib/json-text';
import { docker, firstLine } from '../../seams/docker-cli';

export { DOCKER_TTL_MS, dockerAvailable } from '../../seams/docker-cli';

/**
 * `[totalMb, availableMb, swapTotalMb]` for the machine, or null.
 *
 * MemAvailable, not MemFree: free memory excludes the page cache, which the kernel
 * reclaims on demand, so `free` looks alarming on a healthy box and reassuring on a
 * doomed one. MemAvailable is the kernel's own estimate of what a new workload can
 * actually get, which is exactly the question here.
 *
 * Linux only. Everywhere else this returns null and the caller skips the check rather
 * than guessing -- a wrong refusal is worse than no refusal.
 */
export async function hostMemory(): Promise<[number, number, number] | null> {
  let text: string;
  try {
    text = await fs.readFile('/proc/meminfo', 'utf8');
  } catch {
    return null;
  }
  const fields = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [key, rest] = line.split(':', 2);
    if (key === undefined || rest === undefined) continue;
    const kilobytes = Number(rest.trim().split(/\s+/u)[0]);
    if (Number.isFinite(kilobytes)) fields.set(key, kilobytes);
  }
  const total = fields.get('MemTotal');
  const available = fields.get('MemAvailable');
  if (total === undefined || available === undefined) return null;
  return [
    Math.floor(total / 1024),
    Math.floor(available / 1024),
    Math.floor((fields.get('SwapTotal') ?? 0) / 1024),
  ];
}

/** `[cpus, memoryBytes]` available to the docker engine/VM, or null. Never raises. */
export async function dockerCapacity(): Promise<[number, number] | null> {
  let stdout: string;
  try {
    const result = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'], {
      capture: true,
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) return null;
    stdout = String(result.stdout ?? '');
  } catch {
    return null;
  }
  const [ncpu, memory] = stdout.trim().split(/\s+/u);
  if (ncpu === undefined || memory === undefined) return null;
  const cpus = Number(ncpu);
  const bytes = Number.parseInt(memory, 10);
  return Number.isFinite(cpus) && Number.isFinite(bytes) ? [cpus, bytes] : null;
}

export async function dockerServerVersion(): Promise<string | null> {
  return await firstLine(['docker', 'version', '--format', '{{.Server.Version}}']);
}

export async function composeVersion(): Promise<string | null> {
  return await firstLine(['docker', 'compose', 'version', '--short']);
}

/**
 * The version of a STANDALONE `docker-compose` binary, or null.
 *
 * Asked only when `docker compose` has already failed, and it changes the answer
 * completely. Compose v2 ships as a docker CLI PLUGIN, and the same binary also works
 * when invoked directly -- so a box can have `docker-compose` on PATH printing a
 * perfectly good v2 help text while `docker compose` does not exist, because the binary
 * was never put where the docker CLI looks for plugins. Reported from an EC2 instance
 * where `docker-compose` worked and every houston command did not.
 *
 * houston deliberately does NOT fall back to it: `docker compose -p` and the plugin's
 * own project handling are what every path here is written against, and quietly using a
 * second entry point would mean two code paths for one operation.
 */
export async function composeStandaloneVersion(): Promise<string | null> {
  return await firstLine(['docker-compose', 'version', '--short']);
}

/**
 * Kernel of the engine host/VM (for example a Podman machine), or null. This is the
 * kernel MongoDB actually runs on -- not the macOS/Windows host kernel.
 */
export async function dockerKernelVersion(): Promise<string | null> {
  return await firstLine(['docker', 'info', '--format', '{{.KernelVersion}}']);
}

/**
 * Best-effort: is the client authenticated to Docker Hub? true/false, or null when no
 * auth file is readable (cannot tell). Checks Docker and Podman auth files, honouring
 * REGISTRY_AUTH_FILE and DOCKER_CONFIG.
 */
export async function hubLoggedIn(): Promise<boolean | null> {
  const candidates: string[] = [];
  for (const name of ['REGISTRY_AUTH_FILE', 'DOCKER_CONFIG']) {
    const value = process.env[name];
    if (value === undefined || value === '') continue;
    // The variable, and each path onto it and onto the user's home, joined by
    // `joinPath`: `path.join` folded a `..` in the variable or in HOME that the kernel
    // resolves through a symlink, so a login earlier releases find was not read here.
    const spelled = joinPath(value);
    candidates.push(pathSuffix(spelled) === '.json' ? spelled : joinPath(spelled, 'config.json'));
  }
  candidates.push(
    joinPath(pathHome(), '.docker', 'config.json'),
    joinPath(pathHome(), '.config', 'containers', 'auth.json'),
  );

  const hubKeys = [
    'https://index.docker.io/v1/',
    'index.docker.io',
    'registry-1.docker.io',
    'docker.io',
  ];
  let seen = false;
  for (const candidate of candidates) {
    let document: unknown;
    try {
      // `loads` over a strict UTF-8 read, so a file that is not UTF-8 is a decode error and
      // skipped, where a lenient read found a login in it.
      document = loads(decodeUtf8Strict(await fs.readFile(candidate)));
    } catch {
      continue;
    }
    seen = true;
    // `auths` by a truth test, and membership as it has always been read: a null, false or
    // empty `auths` is no login (it was a TypeError stack here -- `in` on null), a LIST
    // holds a key as an element and a STRING as a substring, and anything else throws.
    const held =
      document !== null && typeof document === 'object' && !Array.isArray(document)
        ? (document as Record<string, unknown>).auths
        : undefined;
    const auths = isTruthy(held) ? held : {};
    if (hubKeys.some((key) => containsChecked(auths, key))) return true;
  }
  return seen ? false : null;
}

/** A path's suffix: from the last `.` of the last component, unless it leads or ends it. */
function pathSuffix(value: string): string {
  const name = path.basename(value.replace(/\/+$/u, ''));
  const at = name.lastIndexOf('.');
  return at > 0 && at < name.length - 1 ? name.slice(at) : '';
}

/** `key in container`, for what a JSON document holds. */
function containsChecked(container: unknown, key: string): boolean {
  if (typeof container === 'string') return container.includes(key);
  if (Array.isArray(container)) return container.includes(key);
  if (container !== null && typeof container === 'object') return Object.hasOwn(container, key);
  throw new TypeError(expectedText('a list, a string or an object', container));
}
