/**
 * Recording who did what, from a layer that must not import the module that stores it.
 *
 * `core/audit` ranks above `core/rcapi`, and `core/rcapi.generatePat` needs it, because
 * that is where a PAT is audited -- deliberately, and for this reason: there
 * are eight non-test call sites for that function, so a record written at one handler
 * would have missed six, and a bypass-2FA admin token for somebody else's workspace is
 * one of the two most sensitive things this tool can do.
 *
 * So the registry is the dependency inversion, the same shape `events.ts` uses for sinks
 * and `teammode.ts` for its probe: this module is owned by a lower layer, and the upper
 * one registers into it.
 *
 * ## The default writes to stderr, and that is not a placeholder
 *
 * The audit log swallows a failed write -- "an unwritable log must never stop the work" --
 * so throwing here would be a behaviour the log does not have. Doing nothing would be worse:
 * a silently dropped audit line looks identical to an action nobody took, and the whole point
 * of the file is that it is evidence.
 *
 * So the fallback WRITES THE LINE, to stderr, in the same tab-separated shape. Nothing is
 * lost, the gap is visible the first time somebody mints a token before the real
 * recorder is registered, and `--json` is unharmed: stdout carries the envelope and
 * nothing else, which is exactly why `ui` goes to stderr in that mode too.
 *
 * Fields are sanitised HERE rather than in the recorder, because the reason they are
 * sanitised does not depend on where they are stored: a tab forges a column and a newline
 * forges a whole line, and in a file whose only job is to say who did what, a forged line
 * is the difference between evidence and fiction.
 *
 * It sits above `format` rather than with the leaves, because the sanitiser is
 * `isPrintableText` and that answer lives there; nothing below `core/` imports it, so
 * the registry is still the only route a lower module has to the recorder.
 */
import { isPrintableText } from './format';

/** One audited action: its kind, its label, and its outcome. */
export interface AuditRecorder {
  (kind: string, label: string, options: { outcome: string }): void;
}

let recorder: AuditRecorder | null = null;

/** Install the real recorder. Returns a function that removes it again. */
export function installAuditRecorder(fn: AuditRecorder): () => void {
  recorder = fn;
  return () => {
    if (recorder === fn) recorder = null;
  };
}

/** Whether a real recorder is installed. For the fallback's own test, and for `doctor`. */
export function auditRecorderInstalled(): boolean {
  return recorder !== null;
}

export const FIELD_LIMIT = 200;

/**
 * One stored field, unable to break the record or the line separator.
 *
 * Control characters go, tab included -- `isPrintableText` is false for tab, newline,
 * carriage return and the rest of the range, so one property is tested rather than a list
 * of characters somebody has to remember to extend.
 *
 * The field is the printable code points other than tab, cut to `limit`, and both halves
 * count CODE POINTS. This filtered code points and then cut the joined string at 200
 * UTF-16 units, so a label of astral characters lost a hundred of them and ended in half a
 * surrogate pair, written to the file as U+FFFD; and it asked `\p{C}\p{Z}` of Node's
 * Unicode, where Unicode 15.0 still calls U+1FAE9 unassigned and drops it. The cut is on
 * the code points now, and the test is the Unicode 15.0 table in `unicode-tables`.
 */
export function field(value: string, limit: number = FIELD_LIMIT): string {
  return [...(value || '')]
    .filter((char) => char !== '\t' && isPrintableText(char))
    .slice(0, limit)
    .join('');
}

/**
 * Audit an action by the current actor. What service code calls.
 *
 * Best-effort by contract: a recorder that throws must not stop the work it was recording,
 * exactly as an unwritable log does not.
 */
export function recordAudit(kind: string, label = '', { outcome = 'ok' } = {}): void {
  if (recorder !== null) {
    try {
      recorder(kind, label, { outcome });
      return;
    } catch {
      // Fall through to the line below rather than losing the record entirely.
    }
  }
  const line = [
    new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    field(kind) || '-',
    field(label) || '-',
    outcome || 'ok',
  ].join('\t');
  process.stderr.write(`houston.audit\t${line}\n`);
}
