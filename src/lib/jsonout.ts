/**
 * The machine-readable output contract: one envelope every `--json` reply uses.
 *
 * Why an envelope rather than a bare payload per command: a caller should find success, data,
 * warnings and errors in the same place whichever verb it ran, so one parser handles all of
 * them.
 *
 *     {
 *       "schema": "houston.info.v1",
 *       "contract": 2,
 *       "houston_version": "0.61.0",
 *       "generated_at": "2026-08-19T09:14:02+00:00",
 *       "ok": true,
 *       "data": {...},
 *       "warnings": [{"code": "...", "message": "..."}],
 *       "error": null
 *     }
 *
 * Two independent version numbers, because they answer different questions. `contract`
 * is the wire generation and bumps only on a breaking change to the envelope, the
 * error-code set or the exit-code map; a caller that does not recognise it should
 * refuse to run rather than guess. `schema` is `houston.<kind>.v<n>`, versioning each
 * payload independently so adding a field to one command does not churn every other
 * command's version.
 *
 * Additive changes are NOT breaking: new optional `data` keys, new `warnings` entries.
 * Callers must ignore unknown keys. Removing or retyping a key, or emitting an error
 * code outside the published set, IS breaking.
 *
 * **stdout carries JSON and nothing else.** Every human-facing line moves to stderr for
 * the life of the process, so `houston info --json > case.json` is a valid document and
 * the person running it still sees what happened.
 *
 * **Exactly one envelope, and it is last.** A streaming command writes NDJSON
 * `houston.event.v1` progress lines first; the final line is the envelope, success or
 * failure. A caller can therefore read to end-of-stream and parse the last line without
 * buffering an incremental parser.
 *
 * TWO THINGS THIS MODULE DOES NOT DO:
 *
 *  1. `capabilities()` is NOT here. It introspects the registered command surface --
 *     flags, which verbs stream, which speak JSON -- and that surface is `cli/`'s, which
 *     this module ranks below; `cli/capabilities.ts` builds it. `PHASES`, the error codes
 *     and the exit codes it publishes all live in this module and in `errors.ts`.
 *
 *  2. `activate()` does not reach into a terminal-output module; the prose sink
 *     registers ITSELF through `onActivate()`. That is the one upward reference the
 *     layering rule permits -- a registry a lower layer owns and an upper layer registers
 *     into -- and it keeps this module free of a dependency it would otherwise carry for
 *     one line.
 */

import { AuthorityGateError, ReproError } from './errors';
import { PHASES as EVENT_PHASES } from './events';
import { JsonFloat, dumps as jsonDumps } from './json-text';

/**
 * Wire contract generation. See the module comment before changing this.
 *
 * 1 -> 2 because two keys were REMOVED: `rc_repro_version` and `schema_legacy`, the
 * pre-rename spellings. ADDING them did not bump this, and correctly so -- nothing was
 * removed or redefined, so a reader of contract 1 stayed right about every field it
 * knew. Deleting them is the other case, and this field exists precisely so that break
 * is announced rather than discovered.
 */
export const CONTRACT = 2;

/**
 * The closed progress vocabulary -- every `phase` a caller may branch on.
 *
 * Taken from the phases this codebase ACTUALLY emits, plus four the lifecycle will grow
 * into. That distinction matters: the obvious move is to adopt a short, tidy list and
 * normalise the rest to "info", and a short list borrowed from elsewhere would have
 * swallowed `tls`, `monitor`, `upgrade`, `create`, `backup`, `config`, `plan` and
 * `ready` -- eight of the sixteen actually emitted, and most of the interesting ones. A
 * vocabulary is closed because it is DOCUMENTED and enforced, not because it is short.
 *
 * A phase not in here normalises to "info", with the original preserved in
 * `detail.phase_raw`, so a caller never has to handle a phase that appeared without a
 * contract bump.
 *
 * THE LIST ITSELF LIVES IN `lib/events.ts`, and this is the same tuple rather than a
 * copy of it. It has to be: `Event.phase` is typed `Phase`, which is that tuple's member
 * type, so an emit site cannot name a phase this document does not publish. Two lists
 * would restore exactly the drift a source-scanning guard exists to catch, with the compiler
 * agreeing with the wrong one.
 */
export const PHASES: readonly string[] = EVENT_PHASES;

const PHASE_SET = new Set(PHASES);

export interface Warning {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface Envelope {
  schema: string;
  contract: number;
  houston_version: string;
  generated_at: string;
  ok: boolean;
  data: unknown;
  warnings: Warning[];
  error: EnvelopeError | null;
}

export interface EnvelopeError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  gate?: ReturnType<AuthorityGateError['asGate']>;
}

/**
 * The version string every envelope carries.
 *
 * Settable, rather than read from installed package metadata that a stale install would
 * report as an old number: the entry sets it from `package.json` at startup, and until
 * then it is the placeholder.
 */
let houstonVersion = '0.0.0';

export function setHoustonVersion(version: string): void {
  houstonVersion = version;
}

export function getHoustonVersion(): string {
  return houstonVersion;
}

/**
 * Whether this process is answering in JSON. Set once, by the command that was given
 * `--json`, and read by every error path so they ALL produce an envelope -- including
 * the ones that predate this module and know nothing about it. Without that, a `--json`
 * caller would get a clean envelope on the paths somebody remembered and an empty stdout
 * with exit 1 on the rest, which is the worst of both: a contract that holds until it
 * matters.
 */
let active_ = false;

/** Warnings collected for THIS command's envelope. */
let warnings_: Warning[] = [];

type ActivateHook = (on: boolean) => void;
const activateHooks: ActivateHook[] = [];

/**
 * Register a callback fired when JSON mode is entered or left.
 *
 * The terminal-output module registers here to move its prose to stderr. See the
 * module comment for why the dependency runs this way round.
 */
export function onActivate(hook: ActivateHook): void {
  activateHooks.push(hook);
}

/** Enter JSON mode for the rest of the process. Idempotent. */
export function activate(): void {
  active_ = true;
  for (const hook of activateHooks) hook(true);
}

export function active(): boolean {
  return active_;
}

/**
 * Leave JSON mode. FOR TESTS ONLY: one real process runs one command, but a test
 * process runs many, and a leaked flag would move the next command's prose to stderr
 * where nothing is looking for it.
 */
export function jsonModeReset(): void {
  warnings_ = [];
  active_ = false;
  for (const hook of activateHooks) hook(false);
}

/**
 * Add a warning to this command's envelope. Deduplicated by code.
 *
 * `code` is the stable half and `message` is prose, exactly as in the error payload, so
 * a caller can branch on the code without matching English.
 */
export function warnOnce(code: string, message: string, detail?: Record<string, unknown>): void {
  if (warnings_.some((w) => w.code === code)) return;
  const entry: Warning = { code, message };
  if (detail !== undefined && Object.keys(detail).length > 0) entry.detail = { ...detail };
  warnings_.push(entry);
}

export function warningsSoFar(): Warning[] {
  return warnings_.map((w) => ({ ...w }));
}

const DIRECT_FAILURES = new WeakMap<object, Warning[]>();

/**
 * A failure reported the way `doctor` reports its own: failed DIRECTLY, with its
 * warnings, not through the CLI's common failure path.
 *
 * Two things follow from that, and both were different here. The envelope carries the
 * warnings passed, where the common path passes none -- every other error envelope's
 * `warnings` is `[]` whatever was collected before the failure, and folding the collected
 * ones in put `ready`'s "Rocket.Chat has restarted 3x" into its NOT_READY envelope. And
 * NO `error` record is written: only the common path logs a failure, so a failing
 * `doctor --json` leaves `start` and `end 3` in the event log, where this wrote an
 * `error PREFLIGHT_FAILED` between them -- a failure the established log never records.
 */
export function failDirectly<E extends object>(failure: E, warnings: Warning[]): E {
  DIRECT_FAILURES.set(failure, warnings);
  return failure;
}

/** The warnings a failure's envelope carries: none unless it was failed directly. */
export function envelopeWarnings(failure: unknown): Warning[] {
  if (typeof failure !== 'object' || failure === null) return [];
  return DIRECT_FAILURES.get(failure) ?? [];
}

/** Whether the common failure path logs a failure -- every one but a direct failure. */
export function loggedFailure(failure: unknown): boolean {
  return typeof failure !== 'object' || failure === null || !DIRECT_FAILURES.has(failure);
}

/**
 * The UTC time to the second, as `YYYY-MM-DDTHH:MM:SS+00:00`.
 *
 * `toISOString()` renders `...T09:14:02.000Z` where the established spelling is
 * `...T09:14:02+00:00`. The envelope is a frozen surface read by machine consumers, so the
 * difference is not cosmetic.
 */
export function now(date: Date = new Date()): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

/** Build a success envelope for `kind` (the command name, e.g. "info"). */
export function envelope(
  kind: string,
  data: unknown = null,
  options: { schemaVersion?: number; warnings?: Warning[] } = {},
): Envelope {
  return {
    schema: `houston.${kind}.v${options.schemaVersion ?? 1}`,
    contract: CONTRACT,
    houston_version: houstonVersion,
    generated_at: now(),
    ok: true,
    data,
    // Always a list, never null, so a caller can iterate without a null check.
    warnings: [...(options.warnings ?? [])],
    error: null,
  };
}

/**
 * Build a failure envelope from an error.
 *
 * `code` comes from the errors taxonomy, so the CLI exit code, the web API status and
 * this payload all derive from one definition. `message` is prose and may be reworded
 * between releases; only `code` is stable.
 *
 * A non-`ReproError` is reported as the base `REPRO_ERROR`/exit 1 rather than being
 * dressed up as something more specific. Saying "unclassified" is honest; picking a
 * plausible code would tell a caller to retry, or not to, on no evidence.
 */
export function errorEnvelope(exc: unknown, options: { warnings?: Warning[] } = {}): Envelope {
  const repro = exc instanceof ReproError ? exc : null;
  const err: EnvelopeError = {
    code: repro?.code ?? ReproError.code,
    message: exc instanceof Error ? exc.message : String(exc),
  };
  if (repro !== null && Object.keys(repro.details).length > 0) {
    err.details = { ...repro.details };
  }
  if (exc instanceof AuthorityGateError) {
    // An authority gate carries what to ask a HUMAN to run -- never something the
    // caller may run itself.
    try {
      err.gate = exc.asGate();
    } catch {
      // the refusal matters more than its detail
    }
  }
  return {
    schema: 'houston.error.v1',
    contract: CONTRACT,
    houston_version: houstonVersion,
    generated_at: now(),
    ok: false,
    data: null,
    warnings: [...(options.warnings ?? [])],
    error: err,
  };
}

/**
 * `JsonFloat` lives with the writer now (`json-text`), and is re-exported so the callers that
 * mark a float -- the backup manifest, the wire -- keep importing it from here.
 */
export { JsonFloat };

/**
 * `value` as JSON with its keys sorted, byte for byte the established spelling.
 *
 * `JSON.stringify` differs from it in three ways that all reach the wire: it does not sort
 * keys at any depth, it writes no space after `:` or `,`, and it emits non-ASCII literally
 * where the established spelling escapes it. The `--json` envelope is a frozen surface
 * that gets pasted into tickets and diffed, so all three are matched here.
 *
 * The renderer is `json-text.dumps`, the one the record and the event log write through, so
 * the three writers cannot drift. A non-finite number is still REFUSED rather than
 * written: the writer would otherwise emit a bare `Infinity`, nothing in the envelope
 * produces one, and writing invalid JSON silently is worse than saying so -- the refusal's
 * own words say it.
 */
export function dumps(value: unknown): string {
  return jsonDumps(value, { sortKeys: true, allowNan: false });
}

/**
 * `value` as indented JSON with its keys sorted -- the backup manifest's spelling.
 *
 * Same renderer as `dumps`, because the two must not drift: the manifest is a file earlier
 * releases read back too, and its bytes are compared against theirs. The only difference is
 * the layout `indent` chooses.
 */
export function dumpsIndented(value: unknown, indent = 2): string {
  return jsonDumps(value, { indent, sortKeys: true, allowNan: false });
}

/**
 * Print one object on stdout as a single line.
 *
 * One object per line so a caller can read a stream of them without an incremental JSON
 * parser. Keys are sorted so two runs of the same command diff cleanly -- this output
 * gets pasted into tickets.
 */
export function emit(payload: unknown): void {
  process.stdout.write(`${dumps(payload)}\n`);
}

/**
 * The success envelope, which must be the last line the command writes.
 *
 * Collected warnings are folded in BY DEFAULT, so a call site cannot forget them --
 * which is how the field came to be inert at all ten of the call sites it once had.
 */
export function reply(
  kind: string,
  data: unknown = null,
  options: { schemaVersion?: number; warnings?: Warning[] } = {},
): void {
  const collected = warningsSoFar();
  for (const w of options.warnings ?? []) {
    if (!collected.some((c) => c.code === w.code)) collected.push(w);
  }
  emit(
    envelope(kind, data, {
      schemaVersion: options.schemaVersion ?? 1,
      warnings: collected,
    }),
  );
}

/**
 * Serialises progress events as NDJSON, one object per line on stdout.
 *
 * Holds the small amount of state the contract's guarantees need: `pct` must be
 * monotonic non-decreasing within a run, because a bar that goes backwards makes a
 * caller think a new attempt started.
 */
export class EventWriter {
  private maxPct: number | null = null;

  /** The wire object for one `events.Event`. */
  event(ev: {
    phase?: string;
    level?: string;
    pct?: number | null;
    message?: string;
    data?: Record<string, unknown>;
  }): Record<string, unknown> {
    const raw = ev.phase ?? 'info';
    const phase = PHASE_SET.has(raw) ? raw : 'info';
    const detail: Record<string, unknown> = { ...(ev.data ?? {}) };
    if (phase !== raw) {
      // Kept rather than discarded: useful for debugging, and it means normalising to
      // "info" loses nothing.
      detail.phase_raw = raw;
    }
    let pct = ev.pct ?? null;
    if (pct !== null) {
      // Clamped rather than dropped: a caller still sees progress, and the monotonic
      // promise holds even if a service reports out of order.
      if (this.maxPct !== null && pct < this.maxPct) pct = this.maxPct;
      this.maxPct = pct;
    }
    return {
      schema: 'houston.event.v1',
      contract: CONTRACT,
      phase,
      level: ev.level ?? 'info',
      pct,
      message: ev.message ?? '', // prose for humans; never branch on it
      detail,
    };
  }

  emit(ev: {
    phase?: string;
    level?: string;
    pct?: number | null;
    message?: string;
    data?: Record<string, unknown>;
    terminal?: boolean;
    code?: string;
  }): void {
    if ((ev.level ?? 'info') === 'warn') {
      warnOnce(ev.code || 'WARNING', ev.message ?? '', ev.data ?? {});
    }
    // Terminal events are dropped here: the command emits the final envelope itself,
    // and the contract promises exactly one envelope, last.
    if (ev.terminal === true) return;
    emit(this.event(ev));
  }
}
