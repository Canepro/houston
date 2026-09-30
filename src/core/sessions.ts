/**
 * Server-side sessions for the web GUI -- the credential a browser actually carries.
 *
 * Sessions replaced HTTP Basic, and the difference that matters is not cryptographic: a
 * session is a thing the SERVER holds, so it can be ended. Basic cannot be -- there is no
 * logout, the password rides on every request for the life of the tab, and it is what forced
 * the password-derived cache that `core/users.ts` no longer has.
 *
 * A session id is 256 bits. Only its sha256 reaches disk, for the reason the users file
 * holds no passwords: a stolen copy of `<home>/sessions` must not be a set of live
 * credentials. Revoking one is deleting a line, which is also what makes the file a
 * working repair tool at 2am.
 *
 * Two clocks, both wall-clock because they outlive the process:
 *
 *     idle       12h   a support engineer should not sign in mid-investigation
 *     absolute    7d   a forgotten tab should not be a standing credential
 *
 * `last_seen` is written back at most once a minute per session (`FLUSH_EVERY`): the
 * dashboard polls every four seconds, and a disk write per poll per open tab is a
 * self-inflicted load for a value nobody reads at that resolution.
 *
 * ## What this module may change, and what it must not
 *
 * The file is TAB-delimited behind a `# houston-state: 1` header, and both of those are
 * format-significant bytes the previous implementation reads too. Nothing here may tidy
 * them.
 *
 * Two locks are layered, an in-process one under an `flock`, because `serve` mutates this
 * from concurrent requests while `houston users remove` mutates it from another process.
 * The seam `seams/fs/lock.ts` already provides both tiers -- it serialises in-process by
 * lock path and then takes the cross-process lock -- so `withFileLock` is the whole of that
 * layering here, exactly as `core/runner/locks.ts` uses it. The entry points that touch
 * the file are therefore asynchronous; the pure helpers are not.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { joinPath } from '../lib/home';
import { toInt, fileErrorOf, splitTextLines } from '../lib/format';
import { OPEN_FOR_WRITE, withFileLock } from '../seams/fs/lock';

export const SESSIONS_FILE = 'sessions';

/**
 * Bumped if the on-disk shape ever changes. Written as a comment line so `houston doctor`
 * can refuse to run against a file a newer version wrote rather than silently misreading
 * it.
 */
export const STATE_VERSION = 1;

export const IDLE_SECONDS = 12 * 3600;
export const ABSOLUTE_SECONDS = 7 * 86400;
const FLUSH_EVERY = 60.0;

/**
 * A session id is unguessable, so there is no lockout and no backoff here -- the only
 * bound needed is on the number of lines, so a long-lived server cannot grow this file
 * without limit. Far above any real team's open-tab count.
 */
const MAX_SESSIONS = 4096;

const HEADER =
  '# houston GUI sessions. Managed by the server; delete a line to revoke it.\n' +
  `# houston-state: ${STATE_VERSION}\n` +
  '# sha256(token)\tuser\tcreated\tlast_seen\tlabel\torigin\n';

/** One stored session. `sid` is the digest -- the raw token is never stored. */
export interface Session {
  /** sha256 hex of the token: what is stored, never the token. */
  readonly sid: string;
  readonly user: string;
  readonly created: number;
  readonly lastSeen: number;
  /** "Firefox on Linux", for the "your sessions" list. */
  readonly label: string;
  /** session | setup */
  readonly origin: string;
}

/**
 * Whichever bound bites first. DERIVED, never stored -- storing it would mean two sources
 * of truth for one fact.
 */
export function expiresAt(s: Session): number {
  return Math.min(s.created + ABSOLUTE_SECONDS, s.lastSeen + IDLE_SECONDS);
}

/** Whether this session is still inside both bounds. `now` is seconds, as on disk. */
export function alive(s: Session, now?: number): boolean {
  return (now ?? Date.now() / 1000) < expiresAt(s);
}

/**
 * What may be shown to the owner.
 *
 * `sid` is truncated: the full value is a verifier, and a page that lists it hands over
 * every session it lists.
 */
export function publicView(s: Session): Record<string, unknown> {
  return {
    sid: s.sid.slice(0, 8),
    user: s.user,
    created: s.created,
    last_seen: s.lastSeen,
    label: s.label,
    origin: s.origin,
    expires_at: expiresAt(s),
  };
}

export function sessionsFile(): string {
  return joinPath(config.home(), SESSIONS_FILE);
}

function lockFile(): string {
  return joinPath(config.home(), 'locks', 'sessions.lock');
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// --- persistence ----------------------------------------------------------------

let cache = new Map<string, Session>();
let stamp: [number, number] = [-1, -1];
const flushed = new Map<string, number>();

function fileStamp(): [number, number] {
  try {
    const st = fs.statSync(sessionsFile(), { bigint: true });
    return [Number(st.mtimeNs), Number(st.size)];
  } catch {
    return [-1, -1];
  }
}

/**
 * One line of the file, or null.
 *
 * The two clocks are read by `toInt`, which is not `parseInt`: `parseInt` took `NOWx` and
 * `NOW.0` by their leading digits and wrote them back as clean integers, read ` 1_NOW` as 1
 * -- expired, so the session was dropped -- and refused fullwidth digits, so `users remove
 * bob` left bob signed in on a line the previous implementation reads and revokes. `toInt`
 * throws on text that is not an integer, and that is a line `parse` skips.
 */
export function parse(line: string): Session | null {
  const trimmed = line.replace(/\n$/u, '');
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split('\t');
  if (parts.length < 6) return null;
  let created: number;
  let lastSeen: number;
  try {
    created = toInt(parts[2]);
    lastSeen = toInt(parts[3]);
  } catch {
    return null;
  }
  return {
    sid: parts[0] as string,
    user: parts[1] as string,
    created,
    lastSeen,
    label: parts[4] as string,
    origin: parts[5] as string,
  };
}

/**
 * The session map, re-read only when the file has actually changed.
 *
 * mtime AND size, exactly as the users file does it: a same-size rewrite inside the mtime
 * granularity is what a revocation looks like.
 */
function load(force = false): Map<string, Session> {
  const current = fileStamp();
  if (!force && current[0] === stamp[0] && current[1] === stamp[1] && cache.size > 0) {
    return cache;
  }
  let text: string;
  try {
    text = fs.readFileSync(sessionsFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = '';
    else return cache;
  }
  const out = new Map<string, Session>();
  // `splitTextLines(text)`. `split('\n')` kept the `\r` of a CRLF file in the origin field and
  // wrote it back, and read two sessions separated by a lone `\r` as one, so `users remove`
  // signed one of them out where the established answer signs out both.
  for (const line of splitTextLines(text)) {
    const s = parse(line);
    if (s !== null) out.set(s.sid, s);
  }
  cache = out;
  stamp = current;
  return cache;
}

/**
 * Rewrite atomically, owner-only, dropping anything already expired.
 *
 * 0600 is applied at CREATION rather than by a later chmod: this file is a set of live
 * credentials and a world-readable window is the whole problem.
 *
 * Exported so a fixed-row fixture can write through the real writer, and the HEADER and
 * ROW bytes are what gets compared rather than a transcription. `users.ts` exports
 * `writeAll` for the same reason.
 */
export function writeAll(rows: Map<string, Session>): void {
  const now = Date.now() / 1000;
  const keep = [...rows.values()]
    .filter((s) => alive(s, now))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_SESSIONS);

  const target = sessionsFile();
  // No explicit mode, as the directory has always been created. `config.saveConfig`
  // creates the home 0700 and is normally what gets there first; tightening it here would
  // invent a difference from earlier releases in a directory mode. The FILE is 0600
  // either way -- that is the mode that matters, and it
  // is applied at creation below.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = joinPath(
    path.dirname(target),
    `${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  const body =
    HEADER +
    keep
      .map((s) => `${s.sid}\t${s.user}\t${s.created}\t${s.lastSeen}\t${s.label}\t${s.origin}\n`)
      .join('');
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

  cache = new Map(keep.map((s) => [s.sid, s]));
  // `flushed` mirrors this file, so it has to shrink with it. Entries were only ever
  // dropped on an explicit revoke -- and a session normally ends by EXPIRING, or by being
  // dropped by the MAX_SESSIONS cap, neither of which goes through revokeSid(). So the
  // file was bounded two ways while the map shadowing it grew for the life of the
  // process. Slow for a human team; fast for anything scripted against POST /api/session,
  // which mints a session per call.
  const live = new Set(keep.map((s) => s.sid));
  for (const sid of [...flushed.keys()]) if (!live.has(sid)) flushed.delete(sid);
  stamp = fileStamp();
}

/**
 * A field that cannot break the record separator.
 *
 * The label comes from a User-Agent header, which is attacker-controlled. Only printable
 * characters are kept -- not tab, newline, carriage return or the rest of the control
 * range; the single property that says so here is the Unicode "Other" and "Separator"
 * categories minus the plain space.
 */
function clean(value: string, limit = 60): string {
  return [...(value || '')]
    .filter((char) => char === ' ' || !/[\p{C}\p{Z}]/u.test(char))
    .join('')
    .slice(0, limit);
}

/** Drop the in-memory cache. For a test that rewrites the file behind this module. */
export function resetCache(): void {
  cache = new Map();
  stamp = [-1, -1];
  flushed.clear();
}

// --- public API ------------------------------------------------------------------

export interface CreateOptions {
  readonly label?: string;
  readonly origin?: string;
}

/**
 * Mint a session for `user` and return the RAW token -- the only time it exists.
 *
 * The caller puts it in a cookie; the server keeps only its digest, so a session cannot be
 * recovered from disk, only revoked.
 */
export async function create(user: string, options: CreateOptions = {}): Promise<string> {
  const { label = '', origin = 'session' } = options;
  const token = tokenUrlsafe(32);
  const now = Math.floor(Date.now() / 1000);
  const s: Session = {
    sid: digest(token),
    user,
    created: now,
    lastSeen: now,
    label: clean(label) || 'unknown',
    origin,
  };
  await locked(() => {
    const rows = new Map(load(true));
    rows.set(s.sid, s);
    writeAll(rows);
  });
  return token;
}

/**
 * The session this token names, or null if it is unknown or expired.
 *
 * Touches `last_seen` so an active tab keeps its session alive, but writes that back at
 * most once a minute per session (see `FLUSH_EVERY`).
 */
export async function verify(token: string): Promise<Session | null> {
  if (!token) return null;
  const sid = digest(token);
  const s = load().get(sid);
  if (s === undefined) return null;
  const now = Date.now() / 1000;
  if (!alive(s, now)) return null;
  if (now - (flushed.get(sid) ?? 0) >= FLUSH_EVERY) {
    flushed.set(sid, now);
    const touched: Session = { ...s, lastSeen: Math.floor(now) };
    try {
      await locked(() => {
        const rows = new Map(load(true));
        // Not revoked while we waited.
        if (rows.has(sid)) {
          rows.set(sid, touched);
          writeAll(rows);
        }
      });
    } catch {
      // A read-only home must not 500.
    }
    return touched;
  }
  return s;
}

/** End one session by its token (what sign-out does). */
export async function revoke(token: string): Promise<boolean> {
  return await revokeSid(digest(token));
}

export async function revokeSid(sid: string): Promise<boolean> {
  const removed = await locked(() => {
    const rows = new Map(load(true));
    if (!rows.has(sid)) return false;
    rows.delete(sid);
    writeAll(rows);
    return true;
  });
  if (removed) flushed.delete(sid);
  return removed;
}

/**
 * End every session belonging to `user`. Returns how many.
 *
 * Called on 'sign out everywhere', and on a password change or account removal -- a
 * credential that has been revoked must not keep working through a session that outlived
 * it.
 */
export async function revokeUser(user: string): Promise<number> {
  return await locked(() => {
    const rows = new Map(load(true));
    const doomed = [...rows.entries()].filter(([, s]) => s.user === user).map(([sid]) => sid);
    for (const sid of doomed) {
      rows.delete(sid);
      flushed.delete(sid);
    }
    if (doomed.length > 0) writeAll(rows);
    return doomed.length;
  });
}

/** A user's own live sessions, newest activity first. */
export function listFor(user: string): Session[] {
  const now = Date.now() / 1000;
  // A SNAPSHOT: `load()` returns the module-level cache itself rather than a copy, and both
  // `load(true)` and `writeAll()` replace it.
  const rows = [...load().values()];
  return rows
    .filter((s) => s.user === user && alive(s, now))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * "Firefox on Linux" from a User-Agent, for the sessions list.
 *
 * Deliberately crude. This exists so somebody can recognise their own devices in a list,
 * not to profile anything, and a wrong guess costs a slightly odd label.
 */
export function describeAgent(userAgent: string): string {
  const ua = userAgent || '';
  const browser =
    (
      [
        ['Edge', 'Edg/'],
        ['Opera', 'OPR/'],
        ['Firefox', 'Firefox/'],
        ['Chrome', 'Chrome/'],
        ['Safari', 'Safari/'],
        ['curl', 'curl/'],
      ] as const
    ).find(([, key]) => ua.includes(key))?.[0] ?? '';
  const system =
    (
      [
        ['Windows', 'Windows'],
        ['macOS', 'Mac OS'],
        ['Android', 'Android'],
        ['iOS', 'iPhone'],
        ['iOS', 'iPad'],
        ['Linux', 'Linux'],
      ] as const
    ).find(([, key]) => ua.includes(key))?.[0] ?? '';
  if (browser && system) return `${browser} on ${system}`;
  return browser || system || 'unknown';
}

/**
 * A URL-safe token: base64url of n random bytes, unpadded.
 *
 * Byte count rather than character count, and the padding is stripped, so a token from
 * this build has the established alphabet and length.
 */
function tokenUrlsafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Cross-process exclusion, layered under the in-process one.
 *
 * Both tiers come from the seam: it serialises callers in this process by lock path and
 * then takes `flock`. The same two layers `reproLock` uses, and for the same reason.
 */
async function locked<T>(body: () => T): Promise<T> {
  // The locks directory, then `sessions.lock` opened for writing: a locks directory this
  // user may not create, or a lock file it may not open for writing, throws `fileErrorOf`'s
  // established error here too, rather than Node's sentence or a lock taken read-only.
  const dir = path.dirname(lockFile());
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw fileErrorOf(error, dir);
  }
  return await withFileLock(lockFile(), body, { open: OPEN_FOR_WRITE });
}
