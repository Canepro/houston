/**
 * Named accounts for the web GUI -- shared by the CLI and the web API.
 *
 * A shared deployment needs to answer "who tore down TICKET-1234?", and a session token
 * cannot: it is one secret handed to everybody, regenerated on every restart. Named users
 * give attribution, survive restarts, and let a person be removed without disrupting anyone
 * else.
 *
 * ## scrypt, and the two runtimes that disagree at the boundary
 *
 * Hashing is scrypt from the standard library on both sides -- houston is deliberately
 * dependency-light and has no bcrypt or passlib. The cost parameters live in each line so
 * they can be raised later without invalidating existing entries, and `check` reads
 * `n`/`r`/`p` FROM THE STORED LINE for exactly that reason.
 *
 * `maxmem` is stated explicitly rather than left to the default, for one reason. Node's
 * rule is `128 * N * r > maxmem` -- a strict inequality, so the default 32 MiB ACCEPTS
 * N=32768 at r=8 (which is exactly 32 MiB), while the previous implementation's scrypt --
 * OpenSSL at its own default -- refuses it. The two runtimes disagree at that boundary, and
 * a hash one build could write and the other could not verify locks every account out of
 * one of them. Naming the number here means the agreement is written down rather than
 * inherited.
 *
 * The async `crypto.scrypt` is used rather than `scryptSync`: service entry points are
 * asynchronous so nothing blocks the event loop for ~100 ms per sign-in, and the
 * timing gate pins `UV_THREADPOOL_SIZE` precisely because this form uses the threadpool.
 *
 * ## The dummy hash is a literal, and that is the defect it fixes
 *
 * `DUMMY_HASH` is a well-formed line built from random bytes, NOT `hashPassword('dummy')`.
 * The obvious version derives scrypt TWICE -- once to build the dummy, once to check
 * against it -- so an unknown user cost exactly double a known one, and the timing side
 * channel the line was written to close was instead created by it, twice as loud as the
 * early return it replaced. Measured before that change: 46.6 ms unknown against 23.7 ms
 * known, a ratio of 1.97.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import * as config from '../lib/config';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { joinPath } from '../lib/home';
import {
  compareCodePoints,
  decodeUtf8Strict,
  fileErrorOf,
  strerrorText,
  quotedText,
  splitTextLines,
  stripText,
} from '../lib/format';
import { installTeamModeProbe } from '../lib/teammode';
import { OPEN_FOR_WRITE, withFileLock } from '../seams/fs/lock';

import { record as auditRecord, audit as auditWrite } from './audit';
import { revokeUser } from './sessions';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const USERS_FILE = 'users';

/**
 * scrypt cost. N=16384 lands around 100 ms on a laptop, which is the point: it is the
 * difference between a guessable password being brute-forced in hours and in centuries.
 * Written into every line, so raising it later is a per-user migration rather than a
 * flag day.
 */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const DKLEN = 32;
const SALT_BYTES = 16;

/** Stated rather than defaulted. See this module's docstring. */
export const SCRYPT_MAXMEM = 33_554_432;

/**
 * A password below this is refused outright. Short of a policy engine, length is the
 * single control that matters most.
 */
export const MIN_PASSWORD = 12;

/**
 * Usernames become part of a repro name and therefore a DNS label, so they are restricted
 * to what `sanitize()` would leave untouched. Input is NORMALISED to this shape rather
 * than refused -- see `normalizeName`.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/u;
const NAME_MAX = 31;
/** Everything `sanitize()` folds to a dash. */
const NAME_SEPARATORS = /[^a-z0-9-]+/gu;

export function usersFile(): string {
  return joinPath(config.home(), USERS_FILE);
}

function lockFile(): string {
  return joinPath(config.home(), 'locks', 'users.lock');
}

export interface User {
  readonly name: string;
  readonly createdAt: string;
  /** Reserved: "" = full access. See `parse`. */
  readonly role: string;
}

/** `scrypt$n$r$p$salt$hash`, self-describing so the cost can change later. */
export async function hashPassword(password: string, salt?: Buffer): Promise<string> {
  const useSalt = salt ?? randomBytes(SALT_BYTES);
  const digest = await scrypt(Buffer.from(password, 'utf8'), useSalt, DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    useSalt.toString('base64'),
    digest.toString('base64'),
  ].join('$');
}

/**
 * What an unknown user is checked against, so a miss costs the same as a hit.
 *
 * A well-formed line with a random salt and a random digest costs nothing to build and
 * makes `check` do exactly ONE derivation, which is what the real path does. The digest
 * is never meant to match; a password deriving to these 32 bytes has the same odds as
 * guessing the salt.
 */
const DUMMY_HASH = [
  'scrypt',
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  randomBytes(SALT_BYTES).toString('base64'),
  randomBytes(DKLEN).toString('base64'),
].join('$');

/** Constant-time verify against a stored hash. */
export async function check(password: string, stored: string): Promise<boolean> {
  let want: Buffer;
  let expected: Buffer;
  try {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [scheme, n, r, p, salt, digest] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (scheme !== 'scrypt') return false;
    expected = Buffer.from(digest, 'base64');
    want = await scrypt(
      Buffer.from(password, 'utf8'),
      Buffer.from(salt, 'base64'),
      expected.length,
      {
        N: Number.parseInt(n, 10),
        r: Number.parseInt(r, 10),
        p: Number.parseInt(p, 10),
        maxmem: SCRYPT_MAXMEM,
      },
    );
  } catch {
    // A malformed line is a failed check, not a crash in the sign-in path.
    return false;
  }
  if (want.length !== expected.length) return false;
  return timingSafeEqual(want, expected);
}

/**
 * `name:hash:created_at[:role]` -> the four fields, or null.
 *
 * The trailing role is optional. `created_at` is a DATE ONLY, because ":" is the field
 * delimiter and an ISO timestamp would split straight into the role column; a legacy line
 * carrying a full timestamp is defensively cut back to its date here.
 *
 * `stripText(line)`, which is not `trim()`: the two whitespace sets disagree in both
 * directions. `trim()` took the BOM a Windows editor leaves on the first line, so
 * `\ufeffalice` -- an account no typed name finds -- was read as `alice`, the only admin,
 * and `users add` rewrote the line without it; and it kept the information separators
 * `\x1c`-`\x1f` that `stripText` strips, and wrote them back.
 */
function parse(line: string): [string, string, string, string] | null {
  const trimmed = stripText(line);
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(':');
  if (parts.length < 3) return null;
  let created = parts[2] as string;
  const role = parts.length > 3 ? (parts[3] as string) : '';
  if (created.includes(':')) created = created.split(':')[0] as string;
  return [parts[0] as string, parts[1] as string, created, role];
}

/** name -> [hash, created_at, role]. A missing file is an empty map, not an error.
 *
 * Exported so a check can read the real file through the real parser rather than
 * re-parsing it; `writeAll` is exported for the same reason.
 */
export function readAll(): Map<string, [string, string, string]> {
  const target = usersFile();
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    // The C library's reason. The root callback reads this file on every invocation, so
    // this sentence is what `up --help` answers with when `users` is a directory:
    // `cannot read <path>: Is a directory`, where `String(error)` said
    // `Error: EISDIR: illegal operation on a directory, read`.
    throw new ValidationError(`cannot read ${target}: ${strerrorText(error, target)}`);
  }
  // STRICT UTF-8 -- and deliberately NOT turned into the ValidationError above. A decode
  // failure is not a failed read, so a `users` holding `al\xffice` escapes `readAll`,
  // the root callback and the app, and `main` reports it as unhandled: the
  // stack trace, `error: <path> is not valid UTF-8 (byte 0xff at position 2: invalid start
  // byte) - this is unhandled, ...`, a REPRO_ERROR envelope under
  // --json, exit 1 -- for `up --help` and `list --json` alike (measured). The lenient
  // `readFileSync(target, 'utf8')` put a U+FFFD in, read the account `al\ufffdice`, and
  // answered both as a sound home does, exit 0.
  const text = decodeUtf8Strict(bytes, target);
  const out = new Map<string, [string, string, string]>();
  // `splitTextLines(text)`, which also breaks at a lone `\r`, `\v`, `\f`, `\x1c`-`\x1e`, NEL and
  // the two Unicode separators. `split('\n')` read a CR-only file as ONE account, alice with
  // the role `admin\rbob`, and the next write rewrote that line, so bob's account was gone.
  for (const line of splitTextLines(text)) {
    const parsed = parse(line);
    if (parsed !== null) out.set(parsed[0], [parsed[1], parsed[2], parsed[3]]);
  }
  return out;
}

/**
 * Rewrite the file atomically, owner-only.
 *
 * Exported so a fixed-salt fixture can write through the real writer, and the HEADER and
 * ROW bytes are what gets compared rather than a transcription.
 *
 * 0600 is set BEFORE the content is in place: creating it world-readable and chmod-ing
 * it afterwards would leave exactly the window this file exists to prevent.
 */
export function writeAll(users: Map<string, [string, string, string]>): void {
  const target = usersFile();
  // No explicit mode, as the directory has always been created. `config.saveConfig`
  // creates the home 0700 and is normally what gets there first; tightening it here would
  // invent a difference from earlier releases in a directory mode. The FILE is 0600
  // either way -- that is the mode that matters, and it
  // is applied at creation below.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = joinPath(path.dirname(target), `${path.basename(target)}.${process.pid}.tmp`);
  const lines = [
    '# houston GUI accounts. Managed by `houston users`.',
    '# name:hash:created_at[:role]',
  ];
  // The names sorted by code point. `sort()` compares UTF-16 units, which puts an astral name
  // (U+1D400) before a BMP one above the surrogates (U+FF41) in the rewritten file.
  for (const name of [...users.keys()].sort(compareCodePoints)) {
    const [hashed, created, role] = users.get(name) as [string, string, string];
    lines.push(`${name}:${hashed}:${created}` + (role ? `:${role}` : ''));
  }
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, lines.join('\n') + '\n', null, 'utf8');
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
}

/**
 * Exclusive access for a read-modify-write of the users file.
 *
 * Every mutation here is read-whole-file -> change one entry -> rewrite. Without this,
 * two of them interleave and the later write reads a snapshot taken before the earlier one
 * landed, so the earlier change is gone -- with both callers told they succeeded. Measured
 * before it existed: eight concurrent `houston users add` left TWO accounts on disk, and
 * the other six were reported created, complete with a minted password. The sharpest case
 * is not `add` but a password reset: `users passwd` on a compromised account can be
 * silently discarded by any concurrent write, and the admin is looking at a new password
 * while the old one still works.
 *
 * READS ARE DELIBERATELY NOT LOCKED. The write lands through `rename`, which is atomic, so
 * a reader sees the whole old file or the whole new one and never a torn mix. That
 * matters: `roleOf()` runs in the web guard on EVERY api request, and a lock on that path
 * would buy nothing and cost a syscall per request.
 */
async function locked<T>(body: () => T | Promise<T>): Promise<T> {
  // The locks directory, then `users.lock` opened for writing: a locks directory this user
  // may not create, or a lock file it may not open for writing, throws `fileErrorOf`'s
  // established error here too, rather than Node's sentence or a lock taken read-only.
  const dir = path.dirname(lockFile());
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw fileErrorOf(error, dir);
  }
  return await withFileLock(lockFile(), body, { open: OPEN_FOR_WRITE });
}

/**
 * The three tiers, widest first. `admin` manages people; `member` is today's behaviour and
 * the default for a new account; `readonly` may look but not touch, and specifically may
 * NOT read logs, env or mint tokens -- workspace logs carry LDAP bind passwords and OAuth
 * client secrets, so "read-only" cannot mean "may read those".
 */
export const ROLES: readonly string[] = Object.freeze(['admin', 'member', 'readonly']);
const RANK: Readonly<Record<string, number>> = Object.freeze({ admin: 3, member: 2, readonly: 1 });

/**
 * A BLANK role column means admin, and that is not a default -- it is the migration.
 *
 * Every account created before roles existed has an empty column, and it has always been
 * documented as `"" = full access`. Reading blank as anything narrower would
 * silently demote every existing user, and on an install whose only account predates the
 * change it would leave the box with NO admin and no way to make one from the GUI.
 */
export const IMPLICIT_ADMIN = 'admin';

/**
 * The effective role for a stored column value.
 *
 * `stripText` here and below, not `trim()`, for the reason `parse` gives: `users role bob
 * $'member\x1f'` has always made bob a member and was refused here as an unknown role, and
 * a stored column holding one read as an admin.
 */
export function normaliseRole(role: string): string {
  const value = stripText(role || '').toLowerCase();
  return ROLES.includes(value) ? value : IMPLICIT_ADMIN;
}

/** Whether `role` satisfies a minimum of `needed`. Unknown -> false. */
export function atLeast(role: string, needed: string): boolean {
  return (RANK[role || ''] ?? 0) >= (RANK[needed || ''] ?? 99);
}

export function requireValidRole(role: string): void {
  if (!ROLES.includes(stripText(role || '').toLowerCase())) {
    throw new ValidationError(`unknown role ${quote(role)} (want: ${ROLES.join(', ')})`);
  }
}

/**
 * The effective role of `name`, or "" if there is no such account.
 *
 * Read live on every check rather than snapshotted into the session line: a demotion that
 * only takes effect at the user's next sign-in is a demotion that has not happened, and
 * the person you are demoting is the one least likely to sign out.
 */
export function roleOf(name: string): string {
  const stored = readAll().get(normalizeName(name));
  return stored === undefined ? '' : normaliseRole(stored[2]);
}

export function admins(): string[] {
  return [...readAll().entries()]
    .filter(([, [, , role]]) => normaliseRole(role) === 'admin')
    .map(([name]) => name)
    .sort(compareCodePoints);
}

/** Accounts that are admin only because their role column is blank. */
export function implicitAdmins(): string[] {
  return [...readAll().entries()]
    .filter(([, [, , role]]) => !stripText(role || ''))
    .map(([name]) => name)
    .sort(compareCodePoints);
}

/**
 * Refuse to remove the last way back in.
 *
 * Enforced here rather than in the web layer so `houston users remove` obeys it too -- a
 * box with zero admins cannot make one from the GUI, and the repair is hand-editing a file
 * most people would not know to look for.
 */
function requireNotLastAdmin(
  name: string,
  users: Map<string, [string, string, string]>,
  what: string,
): void {
  const current = [...users.entries()]
    .filter(([, [, , role]]) => normaliseRole(role) === 'admin')
    .map(([who]) => who);
  if (current.length === 1 && current[0] === name) {
    throw new ConflictError(
      `${quote(name)} is the only admin, so ${what} would leave this server with none ` +
        'and no way to make another from the GUI. Promote somebody first: ' +
        '`houston users role <name> admin`',
    );
  }
}

/**
 * The stored form of `name`. `lucy.felix` -> `lucy-felix`.
 *
 * People's names are dotted -- that is how every corporate directory writes them -- and
 * refusing them outright was not the cosmetic problem it looked like. A box with no
 * accounts also refuses to start `serve` on a network-reachable bind, so `users add
 * lucy.felix` failing was the reason the GUI could not be brought up at all. Repro names
 * have always been TRANSFORMED rather than rejected, and account names now agree.
 *
 * Length is deliberately NOT touched. Silently truncating somebody's identity is worse
 * than refusing it, so a name still too long after this is `requireValidName`'s to reject
 * and the person's to shorten.
 */
export function normalizeName(name: string): string {
  const cleaned = (name || '').toLowerCase().replace(/\./gu, '-');
  return cleaned.replace(NAME_SEPARATORS, '-').replace(/^-+/u, '').replace(/-+$/u, '');
}

/**
 * A string's length in CODE POINTS, where `String.length` counts UTF-16 units.
 *
 * The two agree until a character sits outside the Basic Multilingual Plane, and then
 * `.length` counts it twice. Measured with `.length`, six emoji were twelve characters, so
 * a six-character password cleared the twelve-character floor -- the enforced minimum
 * halved for exactly the characters a person picks to look strong -- and the refusal's
 * "(got N)" doubled every astral character in it. Iterating the string walks code points,
 * and a lone surrogate counts as one of them.
 */
function lengthChecked(value: string): number {
  return [...value].length;
}

/**
 * The invariant for what may be STORED, applied to an already-normalised name.
 *
 * Every caller runs `normalizeName` first, so what arrives here is lowercase `[a-z0-9-]`
 * already. That leaves exactly two ways to fail, and they have different fixes, so they
 * say different things -- the single combined message used to answer "at most 31
 * characters" to somebody whose name was `...`.
 */
export function requireValidName(name: string): void {
  if (!name) {
    throw new ValidationError(
      'a user name needs at least one letter or digit — it becomes part of a workspace ' +
        'name, and therefore a DNS label.',
    );
  }
  // Counted in code points (`lengthChecked`), like the password below. Through either front door
  // the name is normalised and therefore ASCII, where the two counts agree; this keeps
  // them agreeing for a caller that hands the check a name it did not normalise.
  const length = lengthChecked(name);
  if (length > NAME_MAX) {
    throw new ValidationError(
      `user name ${quote(name)} is ${length} characters; the limit is ${NAME_MAX}, ` +
        'because it becomes part of a workspace name and therefore a DNS label.',
    );
  }
  if (!NAME_RE.test(name)) {
    throw new ValidationError(
      `invalid user name ${quote(name)} — lowercase letters, digits and '-', starting ` +
        'with a letter or digit. It becomes part of a workspace name and therefore a ' +
        'DNS label.',
    );
  }
}

/**
 * The floor every typed password meets: `users add/passwd --ask-password`, the GUI's
 * change-my-password and its first-run account all come through here, so this one count
 * is the whole of the policy.
 */
export function requireValidPassword(password: string): void {
  const length = lengthChecked(password || '');
  if (length < MIN_PASSWORD) {
    throw new ValidationError(
      `password must be at least ${MIN_PASSWORD} characters (got ${length})`,
    );
  }
}

// --- public API -----------------------------------------------------------------

/** Whether this box has any accounts at all. */
export function anyUsers(): boolean {
  return readAll().size > 0;
}

export function listUsers(): User[] {
  return [...readAll().entries()]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([name, [, created, role]]) => ({ name, createdAt: created, role }));
}

/**
 * `admin` for the very first account, `member` for every one after it.
 *
 * Blank-means-admin is the MIGRATION for accounts that predate roles; it must not become
 * the behaviour for new ones, or `houston users add bob` silently hands bob the ability to
 * delete everybody's data. New accounts therefore always get an EXPLICIT role written to
 * their line. The first one has to be admin, though: a box whose only account is a member
 * has nobody who can promote anyone, and no way to fix it from the GUI.
 */
export function defaultRoleForNewAccount(): string {
  return readAll().size === 0 ? 'admin' : 'member';
}

/**
 * Bytes of entropy in a password houston generates. 12 bytes is ~96 bits: long enough that
 * guessing it is not a threat model, short enough to read aloud once over a call.
 */
const NEW_PASSWORD_BYTES = 12;

/**
 * A password the server chose, not a person.
 *
 * Lives here rather than in the web layer because BOTH front ends need it and the argument
 * is the same in both. An admin who types a colleague's password also knows it, which
 * makes every audit line signed with that name deniable; generating it means an admin can
 * reset the credential but never hold it. It is also the only real defence against
 * distributed online guessing: the per-address throttle bounds one source, nothing bounds
 * a thousand, and a ~96-bit secret does not care how many there are.
 */
export function mintPassword(): string {
  return randomBytes(NEW_PASSWORD_BYTES).toString('base64url');
}

export async function add(name: string, password: string, role = ''): Promise<User> {
  // Normalised HERE rather than only at the two front ends, so the service is correct on
  // its own terms: `add` is what decides the stored form, and the returned User carries it
  // back so a caller prints the name it really made instead of the one it was handed.
  const stored = normalizeName(name);
  requireValidName(stored);
  requireValidPassword(password);
  if (role) requireValidRole(role);
  // Derived OUTSIDE the lock: scrypt is ~100 ms by design and depends on nothing in the
  // file, so holding the lock across it would serialise account creation on the one part
  // that does not need to be.
  const hashed = await hashPassword(password);
  // Date, not a full timestamp: ":" is the field delimiter, and an ISO time
  // ("...T08:52:23+00:00") splits straight into the role column. Only ever displayed, so
  // day granularity is enough.
  const created = new Date().toISOString().slice(0, 10);
  const chosen = await locked(() => {
    // Resolved inside the lock: `defaultRoleForNewAccount` answers "is the file empty?",
    // so two concurrent first accounts would otherwise both read empty and both come out
    // admin.
    const picked = role || defaultRoleForNewAccount();
    requireValidRole(picked);
    const users = readAll();
    if (users.has(stored)) {
      throw new ConflictError(
        `user ${quote(stored)} already exists (change the password with ` +
          `\`houston users passwd ${stored}\`)`,
      );
    }
    users.set(stored, [hashed, created, picked]);
    writeAll(users);
    return picked;
  });
  // Audited HERE, not at the two front ends. `core/audit.ts`'s own docstring records why:
  // the single call site used to be JobManager.submit(), so everything synchronous wrote
  // nothing -- and that set was the destructive operations. `houston users role` proved it
  // by writing no line at all while the identical HTTP call wrote one.
  auditRecord('user-add', `${stored} role=${chosen}`);
  return { name: stored, createdAt: created, role: chosen };
}

/**
 * Replace a password. Returns how many live sessions that ended.
 *
 * The revocation belongs HERE, not at the two front ends, for the reason `core/audit.ts`
 * gives about auditing: an invariant every caller has to remember is one the next caller
 * silently breaks. A credential that has been replaced must not keep working through a
 * session that outlived it -- changing a compromised password while the intruder stays
 * signed in for seven days is not a fix.
 *
 * Revoked OUTSIDE the users lock: it takes a different file's lock, and holding one while
 * reaching for another is how a deadlock gets built. The window between is harmless -- the
 * old password stops verifying the moment the write lands.
 */
export async function setPassword(name: string, password: string): Promise<number> {
  requireValidPassword(password);
  const stored = normalizeName(name);
  const hashed = await hashPassword(password);
  await locked(() => {
    const users = readAll();
    const existing = users.get(stored);
    if (existing === undefined) {
      throw new NotFoundError(`no user ${quote(stored)} (see \`houston users list\`)`);
    }
    users.set(stored, [hashed, existing[1], existing[2]]);
    writeAll(users);
  });
  auditRecord('user-passwd', stored);
  return await revokeUser(stored);
}

/**
 * Delete an account. Returns how many live sessions that ended.
 *
 * Same argument as `setPassword`: an account that can no longer sign in but is still
 * signed in has not been removed.
 */
export async function remove(name: string): Promise<number> {
  const stored = normalizeName(name);
  await locked(() => {
    const users = readAll();
    if (!users.has(stored)) {
      throw new NotFoundError(`no user ${quote(stored)} (see \`houston users list\`)`);
    }
    requireNotLastAdmin(stored, users, 'removing them');
    users.delete(stored);
    writeAll(users);
  });
  auditRecord('user-remove', stored);
  return await revokeUser(stored);
}

/** Change what `name` may do. Returns the updated user. */
export async function setRole(name: string, role: string): Promise<User> {
  requireValidRole(role);
  const stored = normalizeName(name);
  const wanted = normaliseRole(role);
  const created = await locked(() => {
    const users = readAll();
    const existing = users.get(stored);
    if (existing === undefined) {
      throw new NotFoundError(`no user ${quote(stored)} (see \`houston users list\`)`);
    }
    // Read AND checked under the lock: a demotion racing another demotion could otherwise
    // take the last admin away, each having seen the other still in place.
    if (wanted !== 'admin') requireNotLastAdmin(stored, users, `making them ${role}`);
    users.set(stored, [existing[0], existing[1], wanted]);
    writeAll(users);
    return existing[1];
  });
  auditRecord('user-role', `${stored} -> ${wanted}`);
  return { name: stored, createdAt: created, role: wanted };
}

// --- verification ------------------------------------------------------------------

/**
 * Record a failed credential check.
 *
 * Written with origin `attempt`, never `session`: the name here is whatever the caller
 * typed and belongs to nobody. It may not even be an account. Recording it as an ordinary
 * line would make the log say "alice did something" when alice is the name that was
 * guessed AT. The name is not validated first, on purpose -- an invalid one is exactly the
 * traffic worth seeing, and the field sanitiser is what makes it safe to write down.
 */
function auditFailure(name: string, source: string): void {
  auditWrite(name || '-', 'signin', source || 'local', {
    origin: 'attempt',
    outcome: 'denied',
  });
}

/**
 * Whether these credentials are valid. Constant-time; never cached.
 *
 * An unknown user still performs a full derivation: returning early would make the response
 * time reveal which names exist.
 *
 * NOTHING HERE REFUSES A CORRECT PASSWORD. An earlier version consulted a lockout counter
 * before checking, which had two reachable consequences: anyone who could reach the port
 * could lock out a named colleague with five wrong guesses, and after `houston users passwd
 * alice` every still-open tab replayed the OLD credential on its four-second poll, each
 * poll sliding the window forward, so the account stayed locked and the correct NEW
 * password was refused with it. That counter is gone entirely; prevention stops at the
 * per-address throttle in the web layer, and what replaces the intent is DETECTION -- a
 * failed check writes an audit line, which survives a restart as an in-memory counter
 * could not.
 */
export async function verify(name: string, password: string, source = ''): Promise<boolean> {
  // A password that is not a string. The declared type rules that out at compile time, but
  // the web layer hands this whatever JSON arrived, so the runtime guard stays -- written as
  // a type test, which is the form that survives the type checker knowing better than the
  // caller does.
  if (!name || typeof password !== 'string') return false;

  // Looked up normalised, so somebody created as `lucy-felix` can sign in with the
  // `lucy.felix` they were asked for and think of as their name. Audited RAW, though:
  // an invalid name is exactly the traffic worth seeing, and normalising it first would
  // launder a probe for `Lucy.Felix` into a tidy line about `lucy-felix`.
  const stored = readAll().get(normalizeName(name));
  if (stored === undefined) {
    // Burn the same work as a real check so timing does not enumerate users. ONE
    // derivation, exactly like the branch below.
    await check(password, DUMMY_HASH);
    auditFailure(name, source);
    return false;
  }
  if (!(await check(password, stored[0]))) {
    auditFailure(name, source);
    return false;
  }
  return true;
}

/**
 * A name quoted in a message by `quotedText`, which picks double quotes for a value holding a
 * single one and escapes a backslash or a control character. This wrapped the value in
 * single quotes as it was, so `users role bob "o'x"` said `unknown role 'o'x'` where the
 * established message says `"o'x"`, and `a\b` lost its escaping.
 */
function quote(value: string): string {
  return quotedText(value);
}

/**
 * Answer `lib/teammode.ts` without it having to import this module.
 *
 * `core/kube/namespace` needs one bit from here -- whether this box has accounts -- and
 * sits below it in the layer order. That registry's docstring records what naming the
 * wrong remedy cost: a namespace was left permanently un-adoptable because the message
 * said "HOUSTON_USER is not set" while it WAS.
 */
export function installTeamModeAnswer(): () => void {
  return installTeamModeProbe(() => anyUsers());
}

installTeamModeAnswer();
