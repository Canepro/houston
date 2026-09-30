/**
 * Two builds must exclude each other from one state directory.
 *
 * This module is deliberately SMALLER than the lock module of earlier releases, and that
 * difference is the subject of this comment.
 *
 * That module does two things: it owns the `~/.houston/IMPLEMENTATION`
 * marker, and it adds an OFD write lock beside each of the five `flock` sites. The second
 * half exists because of a measurement: `flock` and Linux OFD locks do NOT exclude each
 * other, so a `flock` holder does not block an OFD acquirer.
 *
 *     lock held by A          B takes flock     B takes OFD
 *     flock only              BLOCKED           ACQUIRED   <- walks straight through
 *     OFD only                ACQUIRED          BLOCKED    <- and so does this
 *     flock + additive OFD    BLOCKED           BLOCKED    <- the fix
 *
 * **This module takes no file lock, and that is a measured decision rather than an
 * omission.** Node has no built-in `flock`, and the native addon that would provide
 * one is ruled out: `fs-ext` ships no prebuilt binary for any platform, so it compiles
 * against the ABI of whichever Node installed it. It loads on Node 24 or on
 * Node 26 and never both from one `node_modules`, which collides head-on with this
 * project's own two-major test matrix, and it does not install on a stock musl image at
 * all. Making the one mechanism whose entire job is preventing silent corruption into
 * an ABI-pinned, per-platform, compiled dependency buys a lock and pays for it with a
 * new class of hard failure. The cross-process lock is `seams/fs/lock.ts`'s instead,
 * taken by a `flock(1)` child process.
 *
 * **So the marker carries the whole weight here:** the `~/.houston/IMPLEMENTATION`
 * marker is the dual-run safety mechanism, not the lock, and the additive OFD lock is
 * defence in depth. This build keeps the marker exactly as earlier releases implement it
 * -- same file, same names, same `O_EXCL` claim, same refusal text -- and adds no OFD lock
 * of its own.
 *
 * **The consequence, stated rather than discovered:** an exclusive marker is what makes
 * a foreign build fail loudly. `dual-v1` must not be promoted on the strength of a lock
 * this build does not have; an interoperability test has to test the MARKER's refusal as
 * the primary mechanism.
 *
 * **This module imports nothing but `errors` and two rank-0 leaves, `mkdir-parents` and
 * `home`.** It is pure mechanism -- no policy, no configuration. That is what keeps
 * `config.ts`, which is one of the lock sites, able to import it without a sideways or
 * upward edge.
 */
import * as fs from 'fs';
import * as path from 'path';

import { PreflightError } from './errors';
import { joinPath } from './home';
import { mkdirParents } from './mkdir-parents';

/** The file that records which build last wrote a home. */
export const MARKER_NAME = 'IMPLEMENTATION';

/**
 * What THIS build calls itself.
 *
 * The marker value earlier releases write is another name. This must differ from it, or
 * the whole mechanism is a no-op: the refusal is triggered by finding a name that is
 * neither this build's nor `dual-v1`.
 */
export const THIS_IMPLEMENTATION = 'typescript';

/**
 * The marker value that meant "both builds have been cleared to share this home", and now
 * means the home's state formats were validated by the build that ships (and by an earlier
 * release too, when a peer validator is configured). Kept on write for the marker window: a
 * fresh home is claimed with it, so an earlier release and an older build never race this
 * one for a home, and a home carrying the earlier releases' marker is promoted to it once
 * it is read back.
 */
export const DUAL_IMPLEMENTATION = 'dual-v1';

/**
 * What a launcher that routed commands between two builds set to `mixed` when it sent them
 * to BOTH and to `single` when it sent them all to one. `bin/houston` is this build's entry
 * and sets neither variable, so every run is `direct`; the two are still read and
 * forgotten, because a process that inherits stale values must not act on them. Nothing
 * acts on the table's value: a fresh home is `dual-v1` whatever it says.
 */
export const DISPATCH_TABLE_ENV = 'HOUSTON_DISPATCHED_TABLE';

/**
 * The route such a launcher exec'd, `py` or `ts`. A build that found its OWN route here was
 * dispatched, and the event log records that as `via`; `bin/houston` sets none, so every
 * run records `direct`.
 */
export const DISPATCH_ROUTE_ENV = 'HOUSTON_DISPATCHED_ROUTE';

/** What a two-build routing table called this build. */
export const THIS_ROUTE = 'ts';

/**
 * How this process was started -- `dispatcher` or `direct` -- and the launcher's variables
 * forgotten. Both variables describe THIS exec and nothing after it: a subprocess this
 * build starts was not dispatched, and must not claim a home for both builds on the
 * strength of a table it never saw. The entry point calls this once, after the home is
 * claimed.
 */
export function consumeDispatch(): 'dispatcher' | 'direct' {
  const route = process.env[DISPATCH_ROUTE_ENV];
  delete process.env[DISPATCH_ROUTE_ENV];
  delete process.env[DISPATCH_TABLE_ENV];
  return route === THIS_ROUTE ? 'dispatcher' : 'direct';
}

/**
 * The marker's path in `home`. Joined component by component (`joinPath`), keeping a
 * `..` as written, because `path.join` folds a `..` in the home against the text before
 * it: `link/../hh` claimed `hh` in the working directory while earlier releases claimed
 * the `other/hh` the kernel resolves, so each marked a directory the other never looked in.
 */
export function markerPath(home: string): string {
  return joinPath(home, MARKER_NAME);
}

/**
 * Which build last wrote this home, or null if it has never been claimed.
 *
 * NEVER THROWS. A missing, unreadable, empty or uninterpretable marker returns null;
 * `requireThisImplementation` distinguishes a genuinely absent path by attempting an
 * exclusive claim. If a path exists but cannot be interpreted, that claim fails and the
 * command refuses without overwriting evidence.
 */
export function readImplementation(home: string): string | null {
  let text: string;
  try {
    // STRICT decoding: bytes that are not UTF-8 are an unreadable marker (null, and the
    // claim then refuses), never a name. Node's 'utf8' substitutes U+FFFD, which turned
    // them into a build called '��...'.
    // `ignoreBOM` keeps a BOM in the text, as earlier releases read it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      fs.readFileSync(markerPath(home)),
    );
  } catch {
    return null;
  }
  // `stripText` and `firstTextLine`, not `trim()` and `split('\n')`: `trim()` also strips
  // U+FEFF, so a marker saved with a BOM read as the earlier releases' marker here and as
  // an unknown build to them -- the one file both builds must read identically. Local
  // rather than `format`'s, because this module imports nothing but `errors`.
  const stripped = stripText(text);
  if (stripped === '') return null;
  const name = stripText(firstTextLine(stripped)).toLowerCase();
  return name || null;
}

/** The whitespace `stripText` removes, as code points, not a regex. */
const SPACE_CHARS = new Set(
  [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
    0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
    0x205f, 0x3000,
  ].map((point) => String.fromCodePoint(point)),
);

/** The single characters a line ends at; `\r\n` is one boundary. */
const LINE_ENDS = new Set(
  [0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029].map((point) =>
    String.fromCodePoint(point),
  ),
);

/** The first line: the text up to the first line boundary. */
function firstTextLine(text: string): string {
  let end = 0;
  while (end < text.length && !LINE_ENDS.has(text[end] as string)) end += 1;
  return text.slice(0, end);
}

function stripText(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && SPACE_CHARS.has(text[start] as string)) start += 1;
  while (end > start && SPACE_CHARS.has(text[end - 1] as string)) end -= 1;
  return text.slice(start, end);
}

/**
 * Whether `home` holds nothing at all -- it does not exist, or it is an empty directory. A
 * path that cannot be listed, or is not a directory, is NOT empty.
 */
export function homeIsEmpty(home: string): boolean {
  try {
    return fs.readdirSync(home).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Atomically claim an unclaimed home and return the marker now present.
 *
 * `wx` is `O_WRONLY | O_CREAT | O_EXCL`, which closes the check-then-write race between
 * two implementations starting against a fresh home. Existing markers are never
 * overwritten, including `dual-v1`. Null means the marker could not be created or read
 * safely. `value` is this build's own name, or `dual-v1` for an empty home, which is claimed
 * for both builds.
 */
export function claim(
  home: string,
  value: typeof THIS_IMPLEMENTATION | typeof DUAL_IMPLEMENTATION = THIS_IMPLEMENTATION,
): string | null {
  const found = readImplementation(home);
  if (found !== null) return found;

  const target = markerPath(home);
  let fd: number;
  try {
    // The home made with its parents: 0700 on the home alone, and the umask's mode on any
    // parent it has to make, which a recursive mkdir would also have made 0700.
    mkdirParents(path.dirname(target), 0o700);
    fd = fs.openSync(target, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readImplementation(home);
    return null;
  }
  try {
    fs.writeFileSync(fd, `${value}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(target);
    } catch {
      /* already gone */
    }
    return null;
  }
  return value;
}

/**
 * A ready-to-raise explanation if this home belongs to another build, else null.
 *
 * The message is here rather than at the call site because it is the same message
 * wherever it is raised, and because this module is the only place that knows what the
 * marker means.
 */
export function conflictReason(home: string): string | null {
  const found = readImplementation(home);
  if (found === null || found === THIS_IMPLEMENTATION || found === DUAL_IMPLEMENTATION) {
    return null;
  }
  return (
    `${markerPath(home)} says this state directory was last written by the ` +
    `'${found}' build of houston, and this is the '${THIS_IMPLEMENTATION}' build. ` +
    'They do not share state safely: the two do not lock each other out of a ' +
    'workspace, so running both against one home races docker compose against ' +
    `itself and orphans containers no tool can then see. Use the '${found}' build ` +
    'for this home, or give this build its own: export HOUSTON_HOME=<a new path>.'
  );
}

/**
 * Refuse a home the other build owns; claim it otherwise.
 *
 * The policy lives here, beside the mechanism, rather than at the call site: this
 * module is the only thing that knows what the marker means, and a second caller must
 * not have to restate the reasoning to get the same refusal.
 */
export function requireThisImplementation(home: string): void {
  // FAIL CLOSED, and BEFORE the ownership question. A promotion in flight is holding all
  // five state locks and validating this home; a command that got past here would write
  // to it and invalidate the check the new marker is about to be based on. It is checked
  // first because it is true regardless of who owns the home -- including when THIS build
  // owns it, which is the case an ownership-first order would wave through.
  const inFlight = transitionReason(home);
  if (inFlight) throw new PreflightError(inFlight);

  const reason = conflictReason(home);
  if (reason) throw new PreflightError(reason);

  const found = readImplementation(home);
  if (found === DUAL_IMPLEMENTATION) return;

  // A FRESH HOME IS CLAIMED FOR BOTH, exactly as earlier releases do. `dual-v1`
  // says every state format in the home was read by both builds and they agreed, and an
  // EMPTY home has no format to disagree about. `dual-v1` is kept on write for the marker
  // window: a fresh home is claimed for both whatever `HOUSTON_DISPATCHED_TABLE` says, so an
  // earlier release and an older build never race this one for it. A home
  // with anything in it and no marker is still claimed for this build alone.
  const freshForBoth = found === null && homeIsEmpty(home);
  const claimed = claim(home, freshForBoth ? DUAL_IMPLEMENTATION : THIS_IMPLEMENTATION);
  if (claimed === THIS_IMPLEMENTATION) return;
  if (claimed === DUAL_IMPLEMENTATION) return;
  if (claimed) {
    throw new PreflightError(
      conflictReason(home) ?? `${markerPath(home)} was claimed by '${claimed}'`,
    );
  }
  throw new PreflightError(
    `cannot safely claim ${markerPath(home)} for this build. Check that ` +
      'HOUSTON_HOME is writable and that its IMPLEMENTATION marker is readable.',
  );
}

// ---------------------------------------------------------------- the promotion journal
//
// The transition journal, the same file and protocol as earlier releases use. The earlier
// releases' marker and `typescript` are EXCLUSIVE owners; `dual-v1` says the state formats
// in this home have been validated by both builds. Getting from one to the other is a
// migration, and a migration that can be interrupted needs a record that says so --
// otherwise a kill between "validated" and "marker replaced" leaves a home nobody can
// classify.
//
// So promotion writes a JOURNAL first and removes it last, and every normal command in
// BOTH builds refuses while it exists. The three states a kill can leave are all
// explainable; a changed marker with no explanation is not reachable.

/**
 * The journal that says a promotion is in flight.
 *
 * A SIBLING of the marker, not a rewrite of it: the marker keeps saying who owns the
 * home until the swap actually happens, so an interrupted promotion degrades to "still
 * exclusive" rather than to "unknown".
 */
export const TRANSITION_NAME = 'IMPLEMENTATION.transition';

/**
 * The order the five state locks are taken in, by the path each names under the home.
 *
 * FIXED, and the same list earlier releases hold, because two builds taking
 * the same five locks in two different orders is a deadlock that only appears under
 * contention -- the one kind of bug a test on a quiet box does not find. The runner's lock
 * is per workspace and expands, in sorted name order, at the position shown.
 */
export const LOCK_ORDER = [
  '.config.lock',
  'locks/users.lock',
  'locks/sessions.lock',
  'logs/houston.log',
  'locks/<workspace>.lock',
] as const;

/** The journal's path in `home`, joined as `markerPath` is and for its reason. */
export function transitionPath(home: string): string {
  return joinPath(home, TRANSITION_NAME);
}

/**
 * The in-flight promotion record, or null. Never throws.
 *
 * A journal that exists but cannot be parsed still counts as in flight and comes back as
 * an empty record: the file's PRESENCE is the fail-closed signal, and a corrupt one must
 * not read as "nothing is happening".
 *
 * So only a path that is NOT THERE is null -- and "there" means what `wx` in
 * `beginTransition` means, a directory entry, which a dangling symlink is. Every other
 * failure to read one counts as in flight. This used to return null for ANY read error, so
 * a journal that was a directory or unreadable let every command in both builds through,
 * and earlier releases let a non-UTF-8 one through that this build refused. Decoding is
 * STRICT, as theirs is, so a record that is not UTF-8 is `{}` in both rather
 * than a `started_by` of U+FFFD here and "another process" there.
 */
export function readTransition(home: string): Record<string, unknown> | null {
  const target = transitionPath(home);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      fs.readFileSync(target),
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return {};
    try {
      fs.lstatSync(target);
      return {};
    } catch {
      return null;
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Why a normal command must refuse right now, or null.
 *
 * Both builds refuse while a promotion is in flight, and for the same reason: the home is
 * momentarily being validated under all five locks, and a write now would invalidate the
 * check the new marker is about to be based on.
 */
export function transitionReason(home: string): string | null {
  const record = readTransition(home);
  if (record === null) return null;
  const startedBy =
    typeof record.started_by === 'string' && record.started_by !== ''
      ? record.started_by
      : 'another process';
  return (
    `${transitionPath(home)} says a promotion to '${DUAL_IMPLEMENTATION}' is in ` +
    `flight, started by '${startedBy}'. Every command refuses while it exists, ` +
    'because the promotion validates this home under all five state locks and a ' +
    'write now would invalidate the check the new marker is based on. If no ' +
    'promotion is actually running, it was interrupted: remove that file and run the ' +
    'command again. The marker was not touched, so the next run validates the home ' +
    'from scratch (a marker already at the target means only this cleanup was lost).'
  );
}

/**
 * Create the journal atomically, leaving the marker alone. False if one already exists.
 *
 * `wx` is what makes two concurrent promotions impossible: the loser sees the file and
 * stops, rather than both proceeding to validate and swap.
 */
export function beginTransition(home: string, record: Record<string, unknown>): boolean {
  const target = transitionPath(home);
  let fd: number;
  try {
    mkdirParents(path.dirname(target), 0o700); // leaf-only, as `claim`
    fd = fs.openSync(target, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record, Object.keys(record).sort())}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(home);
  return true;
}

/** Remove the journal and fsync the directory. The LAST step of a promotion. */
export function clearTransition(home: string): void {
  try {
    fs.unlinkSync(transitionPath(home));
  } catch {
    return;
  }
  fsyncDir(home);
}

/**
 * Durably record a rename or unlink in the CONTAINING directory.
 *
 * Without this the marker's new contents can be on disk while the directory entry
 * pointing at them is not, which after a power loss is the half-promoted home the
 * journal exists to make impossible.
 */
export function fsyncDir(directory: string): void {
  let fd: number;
  try {
    fd = fs.openSync(directory, 'r');
  } catch {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    /* not supported on this filesystem */
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Replace the marker atomically with `value`, then fsync the directory.
 *
 * Temp-then-rename, because a truncate-and-write leaves a window in which the marker is
 * empty -- and an empty marker reads as "never claimed", which is the one answer that
 * lets the wrong build claim the home.
 */
export function writeMarker(home: string, value: string): void {
  const target = markerPath(home);
  const tmp = `${target}.${String(process.pid)}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${value}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  fsyncDir(home);
}
