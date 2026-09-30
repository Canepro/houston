/**
 * Turn an opaque `docker compose up` failure into a one-line, actionable cause.
 *
 * The original error -- "`docker compose up` failed" -- is easy to misread: a Podman report
 * mistook a Hub rate-limit and a MongoDB kernel abort for port/volume problems. On a failed
 * `up` this scans the evidence docker leaves behind -- the containers' own logs, plus a
 * captured pull attempt when nothing started -- for known-fatal signatures and returns a
 * short hint.
 *
 * `match()` is pure string matching so it unit-tests without Docker; `diagnoseFailure()`
 * gathers the evidence and calls it.
 *
 * THE HINT TEXT IS THE CONTRACT. These strings are what a support engineer reads at the
 * moment a boot failed, and wording that differs from the established hints gives two
 * different answers to the same ticket. They are held character for character to the
 * established text rather than paraphrased.
 */
import { composeLogsCapture, composePullCapture } from './runner/engine';

/**
 * (signature substrings, hint). First match wins, so order most-specific first.
 * Matching is case-insensitive; any one substring in the group is enough.
 */
const SIGNATURES: readonly (readonly [readonly string[], string])[] = Object.freeze([
  [
    ['toomanyrequests', 'unauthenticated pull rate limit', 'you have reached your pull rate'],
    "Docker Hub's anonymous pull rate limit was hit. Run `docker login` (Hub " +
      'username + a Personal Access Token) and retry. Note: registry.rocket.chat ' +
      'images still count against Docker Hub for anonymous clients.',
  ],
  [
    [
      'kernel versions 6.19',
      'server-121912',
      '12257600',
      'incompatibility with this version of mongodb',
    ],
    "MongoDB refused to start: this host's Linux kernel (>= 6.19) is incompatible " +
      'with MongoDB 8.0 (SERVER-121912) - it is NOT a volume/permission problem. Use ' +
      'an engine/VM on kernel < 6.19 for RC versions that require Mongo 8.0. See ' +
      'https://jira.mongodb.org/browse/SERVER-121912',
  ],
  [
    ['no matching manifest', 'no match for platform', 'does not match the specified platform'],
    'The image has no build for this CPU architecture (e.g. arm64). Pick an image/' +
      'tag that ships this arch, or run the engine with emulation.',
  ],
  [
    ['notyetinitialized', 'replicasetnoprimary', 'topology is closed', 'no primary detected'],
    'MongoDB is up but its replica set never initialised (no primary). This is ' +
      'common under amd64-on-arm64 emulation (e.g. the bitnami/legacy Mongo image); ' +
      'prefer a natively-supported Mongo flavor/version for this host.',
  ],
  [
    [
      'manifest unknown',
      'not found: manifest',
      'manifest for',
      'no such manifest',
      'failed to resolve reference',
    ],
    'The image tag was not found in the registry - check the RC version / Mongo tag ' +
      'actually exists (or use --offline with a cached image).',
  ],
  [
    ['unauthorized', 'authentication required', 'requested access to the resource is denied'],
    'The registry rejected the pull as unauthorized - this image likely needs ' +
      '`docker login` first (private / Enterprise image).',
  ],
  [
    [
      'bind: permission denied',
      'cannot bind',
      'rootlessport',
      'permission denied while trying to connect',
    ],
    'Binding the host port was denied - on rootless Podman/Docker, ports below 1024 ' +
      'need privileges. Recreate with a higher --port.',
  ],
  [
    ['no space left on device'],
    'The engine ran out of disk. Free space (RC images are ~1.5 GB each), then retry ' +
      '- e.g. `docker system prune` or `houston prune`.',
  ],
]);

/** Every signature group, for a test that counts them. */
export const SIGNATURE_COUNT = SIGNATURES.length;

/** Return a cause hint for the first known signature in `text`, else null. */
export function match(text: string): string | null {
  const low = (text || '').toLowerCase();
  for (const [needles, hint] of SIGNATURES) {
    if (needles.some((n) => low.includes(n))) return hint;
  }
  return null;
}

/**
 * Best-effort cause for a failed `up` on repro `name`, or null.
 *
 * Reads what docker left behind: container logs first (a service that started then
 * hard-exited, like mongod on kernel 6.19, logs its own reason); if nothing ever started,
 * reproduce the pull to surface registry errors (rate limit, auth, missing manifest).
 * NEVER RAISES -- diagnosis is advisory, and a diagnosis that throws would replace the
 * real error with its own.
 */
export async function diagnoseFailure(name: string): Promise<string | null> {
  let logs: string;
  try {
    logs = await composeLogsCapture(name);
  } catch {
    // Diagnosis must never mask the real error.
    logs = '';
  }
  const hint = match(logs);
  if (hint !== null) return hint;
  if (!logs.trim()) {
    // Nothing started -> a pull or create failure, which leaves no container log.
    try {
      return match(await composePullCapture(name));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The signature table, for the spec that holds it to the established one. Frozen so a
 * caller cannot reorder it.
 */
export function signatures(): readonly (readonly [readonly string[], string])[] {
  return SIGNATURES;
}
