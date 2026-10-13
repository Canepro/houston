/**
 * Who did what, in a file that survives a restart.
 *
 * The calls live in the service layer rather than at either front door because `audit()`
 * used to live in the web layer's job runner, so `houston down --volumes` on a shared box
 * left no trace at all, and the single call site was `JobManager.submit()`, so every
 * endpoint that worked SYNCHRONOUSLY wrote nothing -- and that set was teardown and prune,
 * the two most destructive operations in the product. A log that fills with creates and
 * seeds and stays silent about deletions is worse than no log, because it looks complete.
 *
 * ## This module is the RECORDER; `lib/audit.ts` is the registry
 *
 * It was one module that everything imported. Here it is two, because
 * `core/rcapi` audits a minted PAT and sits BELOW this file in the layer order --
 * `lib/audit.ts`'s docstring gives that reasoning and owns the dependency inversion. So
 * the split is: `lib/audit.ts` holds `recordAudit`, the field sanitiser and the
 * stderr fallback; this file holds the state directory, the format, the rotation and the
 * reader, and installs itself as the real recorder at import time.
 *
 * Installing at IMPORT is deliberate, not a convenience: importing this module gives you a
 * module that writes to the file; there is no arming step to forget. `installRecorder()`
 * is exported for the same reason `installTeamModeProbe` is: a test needs to take it back
 * out again.
 *
 * ## The timestamp is `+00:00`, not `Z`
 *
 * The file's established timestamps read `2026-09-15T16:48:13+00:00`.
 * `Date.prototype.toISOString()` emits `2026-09-15T16:48:13.000Z`. Both are valid ISO 8601
 * and they are not the same bytes, and this file is read back by `parseLine` byte for
 * byte, including the lines a home earlier releases wrote already holds. `lib/audit.ts`'s
 * FALLBACK writes `Z` because it writes to stderr, where nothing parses it; the file gets
 * the established spelling.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FIELD_LIMIT, field, installAuditRecorder } from '../lib/audit';
import * as config from '../lib/config';
import { ValidationError } from '../lib/errors';
import { currentContext } from '../lib/context';
import { joinPath } from '../lib/home';

/** Appended to on every audited action. Tab-separated so `cut`/`awk` work on it. */
export const AUDIT_FILE = 'audit.log';

/**
 * How the identity on a line was established. Seven values rather than a
 * verified/asserted boolean, because the code already distinguishes them and the
 * difference is what makes a line evidence or not:
 *
 *   session   a signed-in GUI request. The server checked a credential.
 *   local     the CLI, where the OS login matched a known account.
 *   asserted  the CLI with HOUSTON_USER set. Taken at face value, so it is a CLAIM.
 *   setup     the one-time first-run key, spent creating the first account.
 *   system    houston acting on its own behalf (rotation, startup).
 *   attempt   a credential check that FAILED. The name is whatever the caller typed and
 *             belongs to nobody -- it may not even be an account. It is its own origin
 *             precisely so nothing reads these lines as "alice did something": alice is
 *             the name that was GUESSED AT, not the actor.
 *   sso       an Okta sign-in that linked or created the account it names.
 *
 * `setOrigin` silently ignores anything not in this list, so a value missing from it does
 * not raise -- it writes "-" and looks like a legacy line. `setup` was omitted at first
 * and did exactly that, on the first two lines of every new install.
 */
export const ORIGINS: readonly string[] = Object.freeze([
  'session',
  'local',
  'asserted',
  'setup',
  'system',
  'attempt',
  'sso',
]);

/** Rotate at 32 MB, keeping five. Checked cheaply rather than on every write. */
export const MAX_BYTES = 32 * 1024 * 1024;
export const KEEP = 5;

const FIELDS = 6;

export function auditPath(): string {
  return joinPath(config.home(), AUDIT_FILE);
}

/**
 * The current actor and how it was established.
 *
 * Set once -- by the web guard per request, by the CLI at startup -- rather than threaded
 * through fifteen signatures. `AsyncLocalStorage` holds them and audit code reads it, so
 * there is one context object instead of two variables.
 */
export function actor(): string {
  return currentContext().actor || '';
}

export function origin(): string {
  const value = currentContext().origin || '';
  return ORIGINS.includes(value) ? value : '';
}

/** Keep `audit.log` bounded. Best-effort, like everything else here. */
function rotateIfNeeded(target: string): void {
  try {
    if (fs.statSync(target).size < MAX_BYTES) return;
  } catch {
    return;
  }
  try {
    for (let n = KEEP - 1; n > 0; n -= 1) {
      const src = `${target}.${n}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${target}.${n + 1}`);
    }
    fs.renameSync(target, `${target}.1`);
  } catch {
    /* best-effort */
  }
}

export interface AuditOptions {
  readonly origin?: string;
  readonly outcome?: string;
}

/**
 * The current UTC time in ISO 8601, to the second.
 *
 * Seconds precision and an explicit `+00:00` offset. Taking the first 19 characters of
 * `toISOString()` drops both the milliseconds and the offset, so the offset is appended
 * rather than assumed.
 */
function stamp(now: Date): string {
  return `${now.toISOString().slice(0, 19)}+00:00`;
}

/**
 * Append one line: timestamp, actor, kind, label, origin, outcome.
 *
 * The last two fields are APPENDED, never inserted, so every existing `cut -f2` keeps
 * working and a four-field line is unambiguously one written before they existed.
 *
 * Best-effort -- an unwritable log must never stop the work. Created 0600: on the shared
 * box this exists for, the trail names people and what they touched, and the mode is
 * applied AT CREATION rather than by a later chmod, which would leave a window where the
 * file is world-readable.
 */
export function audit(
  actorName: string,
  kind: string,
  label: string,
  { origin: originValue = '', outcome = 'ok' }: AuditOptions = {},
): void {
  try {
    const line =
      [
        stamp(new Date()),
        field(actorName) || '-',
        field(kind) || '-',
        field(label) || '-',
        originValue || origin() || '-',
        outcome || 'ok',
      ].join('\t') + '\n';
    const target = auditPath();
    // No explicit mode, as the directory has always been created. `config.saveConfig`
    // creates the home 0700 and is normally what gets there first, but when this is the
    // first writer the directory is left at the umask default -- so tightening it here
    // would invent a difference from earlier releases in a file mode. Node's default is
    // 0o777 masked by umask, the same default.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfNeeded(target);
    const fd = fs.openSync(target, 'a', 0o600);
    try {
      fs.writeSync(fd, line, null, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* an unwritable log must never stop the work */
  }
}

/** Audit an action by the CURRENT actor. What service code calls. */
export function record(kind: string, label = '', { outcome = 'ok' } = {}): void {
  audit(actor(), kind, label, { origin: origin(), outcome });
}

export interface AuditRecord {
  ts: string;
  actor: string;
  kind: string;
  label: string;
  origin: string;
  outcome: string;
}

// Acceptance is not completion. Background jobs record both in the existing
// sixth field, while old rows and unknown values retain their earlier meaning.
const KNOWN_OUTCOMES = new Set(['ok', 'denied', 'accepted', 'done', 'error', 'stopped']);

/**
 * One stored line -> a record, or null if it is not one.
 *
 * A four-field line (written before origin/outcome existed) parses with `origin=""` and
 * `outcome="ok"`, so old logs stay readable rather than being silently skipped by the
 * reader that was supposed to make them useful.
 */
export function parseLine(line: string): AuditRecord | null {
  const trimmed = line.replace(/\n$/u, '');
  if (!trimmed) return null;
  const parts = trimmed.split('\t');
  if (parts.length < 4) return null;
  while (parts.length < FIELDS) parts.push('-');
  const originCell = parts[4] as string;
  const outcomeCell = parts[5] as string;
  return {
    ts: parts[0] as string,
    actor: parts[1] as string,
    kind: parts[2] as string,
    label: parts[3] as string,
    origin: originCell === '-' ? '' : originCell,
    outcome: KNOWN_OUTCOMES.has(outcomeCell) ? outcomeCell : 'ok',
  };
}

export interface ReadOptions {
  readonly limit?: number;
  readonly actorName?: string;
  readonly kind?: string;
  readonly q?: string;
  readonly since?: string;
  readonly maxBytes?: number;
}

export interface AuditPage {
  lines: AuditRecord[];
  truncated: boolean;
  path: string;
}

/** `bytes.split(b"\n")`: every piece, the empty ones and the last one included. */
function splitBytes(block: Buffer, separator: number): Buffer[] {
  const pieces: Buffer[] = [];
  let start = 0;
  for (let at = block.indexOf(separator); at >= 0; at = block.indexOf(separator, start)) {
    pieces.push(block.subarray(start, at));
    start = at + 1;
  }
  pieces.push(block.subarray(start));
  return pieces;
}

/**
 * The most recent matching lines, newest first.
 *
 * Read BACKWARDS from the end in chunks: the interesting lines are the recent ones, and a
 * year-old log on a busy box should not be walked from the start to show today.
 * `maxBytes` bounds the scan and the result says when it stopped, because an unindexed
 * file has an honest limit and pretending otherwise is how a filter silently lies about
 * what it found.
 */
export function read(options: ReadOptions = {}): AuditPage {
  const {
    limit = 200,
    actorName = '',
    kind = '',
    q = '',
    since = '',
    maxBytes = 8 * 1024 * 1024,
  } = options;
  // A DATE, or refused. `since` is compared as text against each line's ISO timestamp, so
  // `--since notadate` silently filtered out every line and answered "nothing matched".
  if (since !== '' && Number.isNaN(Date.parse(since))) {
    throw new ValidationError(
      `--since wants an ISO date such as 2026-10-09 or 2026-10-09T08:00:00, not '${since}'`,
    );
  }
  const target = auditPath();
  const out: AuditRecord[] = [];
  let scanned = 0;
  let truncated = false;

  let size: number;
  try {
    size = fs.statSync(target).size;
  } catch {
    return { lines: [], truncated: false, path: target };
  }

  const chunk = 64 * 1024;
  let tail: Buffer = Buffer.alloc(0);
  try {
    const fd = fs.openSync(target, 'r');
    try {
      let pos = size;
      while (pos > 0 && out.length < limit && scanned < maxBytes) {
        const step = Math.min(chunk, pos);
        pos -= step;
        const buffer = Buffer.alloc(step);
        const got = fs.readSync(fd, buffer, 0, step, pos);
        const block = Buffer.concat([buffer.subarray(0, got), tail]);
        scanned += step;
        // `block.split(b"\n")`, then `raw.decode("utf-8", "replace")` per line: the BYTES
        // are split, and only a whole line is decoded. An earlier version decoded each 64 KiB
        // block and re-encoded its partial first line, so a character the block boundary
        // cut in two became two or three U+FFFD for good -- `josé` printed `jos��` and
        // `--grep josé` did not find it. `toString('utf8')` replaces a bad
        // sequence as the `replace` handler does, one U+FFFD per maximal subpart, and
        // keeps a BOM as the codec does.
        const lines = splitBytes(block, 0x0a);
        // The first element is a partial line unless this chunk reached the start of the
        // file, so it is carried into the next read rather than parsed here.
        tail = pos > 0 ? (lines.shift() ?? Buffer.alloc(0)) : Buffer.alloc(0);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const rec = parseLine((lines[i] as Buffer).toString('utf8'));
          if (rec === null) continue;
          if (actorName && rec.actor !== actorName) continue;
          if (kind && rec.kind !== kind) continue;
          if (since && rec.ts < since) continue;
          if (q && !(rec.label + rec.kind).toLowerCase().includes(q.toLowerCase())) continue;
          out.push(rec);
          if (out.length >= limit) break;
        }
      }
      truncated = pos > 0 && (out.length >= limit || scanned >= maxBytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* a partially readable log still returns what it had */
  }
  return { lines: out, truncated, path: target };
}

/**
 * Install this module as the recorder `lib/audit.recordAudit` reaches.
 *
 * Returns the uninstall, so a test can put the stderr fallback back. Called at import
 * time below, so the recorder is in place as soon as the module is loaded.
 */
export function installRecorder(): () => void {
  return installAuditRecorder((kind, label, { outcome }) => {
    record(kind, label, { outcome });
  });
}

installRecorder();

export { FIELD_LIMIT, field };
