/**
 * The first-run key: how the very first account gets created.
 *
 * Somebody has to be able to create the first admin, and at that moment there is nobody to
 * authorise them. The old answer was a session token in the URL, printed on every `serve`
 * start -- a standing credential with no identity behind it, regenerated on every restart,
 * landing in shell history and screenshots.
 *
 * This is the narrow replacement:
 *
 * - It exists ONLY on a loopback bind with no accounts. On any reachable interface
 *   `serve` refuses to start instead, because a bootstrap credential reachable from the
 *   network is the thing being removed, not a smaller version of it.
 * - It rides in the URL FRAGMENT (`/setup#k=...`). A fragment is never sent to the
 *   server, so it cannot appear in an access log, a proxy log or a `Referer`.
 * - Single use and 15 minutes. Consuming it CREATES the first admin in the same request,
 *   so there is never an anonymous privileged session -- not even briefly.
 * - Only the sha256 reaches disk, like every other credential here.
 *
 * EVERY `serve` MINTS A FRESH KEY, and that supersedes any URL printed earlier. Reporting
 * an outstanding key instead cannot be done, because only the sha256 reaches disk and a
 * key that cannot be read back cannot be reprinted. Minting again is the honest version:
 * the URL just printed is always the one that works, and the consequence to know is that
 * restarting `serve` invalidates the previous `/setup#k=...` link.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { joinPath } from '../lib/home';

export const FIRST_RUN_FILE = 'first-run';
export const TTL_SECONDS = 15 * 60;

export function keyPath(): string {
  return joinPath(config.home(), FIRST_RUN_FILE);
}

function digest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** `[sha256, expires]` for the outstanding key, or null. */
function read(): [string, number] | null {
  let text: string;
  try {
    text = fs.readFileSync(keyPath(), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) return null;
    const expires = Number.parseInt(parts[2] as string, 10);
    if (!Number.isFinite(expires)) return null;
    return [parts[0] as string, expires];
  }
  return null;
}

/** Create a key and return it. The caller prints it; only its hash is kept. */
export function mint(): string {
  // A URL-safe token: base64url of 24 random bytes, unpadded.
  const key = randomBytes(24).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body =
    '# houston first-run key. Single use, 15 minutes.\n' +
    '# sha256(key)\tminted\texpires\n' +
    `${digest(key)}\t${now}\t${now + TTL_SECONDS}\n`;
  const target = keyPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = joinPath(path.dirname(target), `${path.basename(target)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, body, null, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* already renamed away */
    }
  }
  return key;
}

/**
 * Whether `key` is the outstanding, unexpired one. Constant-time compare.
 *
 * The comparison is over the two HEX DIGESTS, which are the same length by construction,
 * so `timingSafeEqual` can be used directly -- it throws on a length mismatch, and a
 * stored digest of the wrong length is a corrupt file rather than a wrong key.
 */
export function valid(key: string): boolean {
  const found = read();
  if (found === null || !key) return false;
  const [stored, expires] = found;
  const mine = digest(key);
  if (stored.length !== mine.length) return false;
  const same = timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(mine, 'utf8'));
  return same && expires > Date.now() / 1000;
}

/** Burn the key. Called once the first account exists, so it cannot be replayed. */
export function consume(): void {
  fs.rmSync(keyPath(), { force: true });
}
