/**
 * Domain errors shared by the CLI and the web API.
 *
 * The CLI historically failed by calling a `die()` that exited the process, at ~75 sites.
 * That is fine for a one-shot process but fatal for a long-lived server: a single bad request
 * would exit the whole thing. The service layer instead raises these, and each front-end
 * translates them:
 *
 *     CLI  ->  catch (e) { if (e instanceof ReproError) fail(e); }   // red line + exitCode
 *     API  ->  catch (e) { if (e instanceof ReproError) reply(e.httpStatus); }
 *
 * One taxonomy, three consumers. `httpStatus` lets the web layer map each cause to the
 * right status code without the service layer importing anything web-specific;
 * `exitCode` does the same for the CLI so a script or agent can tell "not ready yet"
 * from "known dead" without parsing text; `code` is the stable identifier a
 * machine-readable payload reports, so callers branch on it rather than on prose.
 *
 * `code` values are stable API. Renaming one is a breaking change; the MESSAGE attached
 * to an exception is not stable and may be reworded freely. Errors are compared on
 * `{code, exitCode, httpStatus, kind}` and never on the message, for exactly that reason.
 *
 * TWO SHAPES THE LANGUAGE FORCES, both narrow:
 *
 *  1. `code`/`exitCode`/`httpStatus` belong to the CLASS, and an instance must answer
 *     them. JavaScript has no instance lookup of a static that survives subclassing
 *     cleanly, so each constructor copies its class defaults onto the instance. The
 *     observable contract is the same and `errors.test.ts` pins it.
 *
 *  2. `MissingRecordError` is both a not-found error and a missing file -- deliberately
 *     BOTH, so a dozen callers that already treat it as a missing file keep working
 *     while `serve` still answers 404. TypeScript has no multiple
 *     inheritance, so it extends `NotFoundError` and carries `isFileNotFound` plus the
 *     `ENOENT` `errno` code. A caller that means "this workspace has no record" tests
 *     that flag; nothing tests the class name.
 */

export class ReproError extends Error {
  /** The web API status for this cause. */
  static httpStatus = 400;
  /** The stable identifier a machine-readable payload reports. */
  static code = 'REPRO_ERROR';
  /** The CLI process exit code. */
  static exitCode = 1;
  /**
   * Whether this build can actually RAISE this class. `false` marks one the hierarchy
   * knows about and nothing produces; `capabilities` must not advertise those, because
   * a published code nothing can emit teaches a caller to write a branch that never
   * runs.
   */
  static advertised = true;

  readonly httpStatus: number;
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;

  /**
   * `exitCode` is for the one shape a class cannot carry: a plain ReproError (REPRO_ERROR
   * in the event log) that exits N. The class, and so what
   * `capabilities` advertises, is unchanged.
   */
  constructor(
    message = '',
    options: { code?: string; details?: Record<string, unknown>; exitCode?: number } = {},
  ) {
    super(message);
    const cls = new.target as unknown as typeof ReproError;
    this.name = new.target.name;
    this.httpStatus = cls.httpStatus;
    this.exitCode = options.exitCode ?? cls.exitCode;
    this.code = options.code || cls.code;
    this.details = { ...(options.details ?? {}) };
    // Without this an `instanceof` check fails for anything extending a built-in when
    // the emit target is below ES2015. `target: es2020` makes it unnecessary, and it is
    // kept because a future target change must not silently break every `catch`.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Bad input (port range, name, unknown --set param, bad version/preset). */
export class ValidationError extends ReproError {
  static override httpStatus = 400;
  static override code = 'VALIDATION_FAILED';
  // usage error: fix the call, retrying unchanged will not help
  static override exitCode = 2;
}

/** A resource is already taken (host port / repro name / monitoring slot). */
export class ConflictError extends ReproError {
  static override httpStatus = 409;
  static override code = 'CONFLICT';
  // pick another name/port and retry
  static override exitCode = 8;
}

/** No such repro / default repro missing. */
export class NotFoundError extends ReproError {
  static override httpStatus = 404;
  static override code = 'NOT_FOUND';
  static override exitCode = 4;
}

/**
 * A workspace directory with no readable `repro.json`.
 *
 * As a `NotFoundError` it carries `httpStatus = 404`, so `serve` answers a half-written
 * workspace with the documented status instead of a 500 and a stack trace. As a
 * file-not-found it is still what a dozen callers already mean to skip -- "this
 * workspace has no record" genuinely is the thing they skip -- which is why the flag is
 * here rather than each of those handlers being rewritten with one silent miss enough
 * to turn a skip into a crash.
 */
export class MissingRecordError extends NotFoundError {
  readonly isFileNotFound = true;
  readonly errno = 'ENOENT';
}

/** Docker is down, or Rocket.Chat is not serving / cannot be logged into. */
export class NotReadyError extends ReproError {
  static override httpStatus = 409;
  static override code = 'NOT_READY';
  // still unknown: the caller may poll again
  static override exitCode = 5;
}

/** A `docker`/`docker compose` invocation failed. */
export class DockerError extends ReproError {
  static override httpStatus = 502;
  static override code = 'ENGINE_UNAVAILABLE';
  // preflight/engine problem: run `houston doctor`
  static override exitCode = 3;
}

/**
 * Environment or capacity preflight refused the request.
 *
 * Distinct from `ValidationError` (bad caller input) and `DockerError` (engine
 * unreachable for compose). Capacity shortfalls and unsupported resize paths use this
 * so they never masquerade as a successful preflight.
 */
export class PreflightError extends ReproError {
  static override httpStatus = 409;
  static override code = 'PREFLIGHT_FAILED';
  static override exitCode = 3;
}

/**
 * A create hit a condition that cannot self-heal, so waiting is pointless.
 *
 * Distinct from `NotReadyError` on purpose: 5 means "still unknown, the clock ran out",
 * 7 means "known dead, stop now". Collapsing them is what makes callers wait out a run
 * that had already failed.
 */
export class CreateFailedError extends ReproError {
  static override httpStatus = 500;
  static override code = 'CREATE_FAILED';
  static override exitCode = 7;
}

/** The gate as a plain object, for a machine-readable error payload. */
export interface Gate {
  kind: string;
  subject: string;
  approve_with: string;
  details?: Record<string, unknown>;
}

/**
 * An action needs a human decision houston is not authorised to make.
 *
 * Public exposure, an unapproved cluster, new credentials, deleting something houston
 * does not own, retaining a run. Never retryable and never auto-approvable:
 * `approveWith` is what to ask a HUMAN to run, not something the caller may run itself.
 */
export class AuthorityGateError extends ReproError {
  static override httpStatus = 403;
  static override code = 'GATE';
  static override exitCode = 6;
  static override advertised = true;

  readonly kind: string;
  readonly subject: string;
  readonly approveWith: string;

  constructor(
    message: string,
    options: {
      kind?: string;
      subject?: string;
      approveWith?: string;
      code?: string;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, {
      ...(options.code ? { code: options.code } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    });
    this.kind = options.kind ?? '';
    this.subject = options.subject ?? '';
    this.approveWith = options.approveWith ?? '';
  }

  asGate(): Gate {
    const out: Gate = { kind: this.kind, subject: this.subject, approve_with: this.approveWith };
    if (Object.keys(this.details).length > 0) out.details = { ...this.details };
    return out;
  }
}

/**
 * Every authority gate houston can raise, declared rather than invented at the call
 * site. `AuthorityGateError` takes its code as an argument, so without this registry
 * the published error-code set could only advertise the base "GATE" and a caller could
 * not know what to expect. Adding a gate means adding it here, which is the point: a
 * gate a caller cannot anticipate is one it cannot handle.
 */
export const GATE_CODES: Readonly<Record<string, string>> = Object.freeze({
  GATE_NOT_ONBOARDED: 'houston has not been onboarded on this machine',
  GATE_OWNED_CLUSTER: 'the houston-owned local cluster was not authorised',
  GATE_ENGINE_RESIZE: 'resizing the container engine was not authorised',
  GATE_UNAPPROVED_CLUSTER: 'the target Kubernetes cluster is not an approved one',
  GATE_DELETE_UNOWNED: 'the resource was not created by houston',
  GATE_PUBLIC_EXPOSURE: 'the request would expose a repro beyond loopback',
  GATE_RETENTION: 'retaining this run was not authorised',
  // DISTINCT from GATE_UNAPPROVED_CLUSTER, which already means "the CA private key may
  // not go there". Giving one code two meanings breaks the premise jsonout rests on --
  // that a caller branches on `code` -- and these two want opposite responses: one is
  // about a secret leaving this box, the other about money leaving an account.
  GATE_CLOUD_SPEND: 'creating a cluster that costs money was not authorised',
});

/**
 * The gate codes this build can actually PRODUCE, as opposed to the ones it knows
 * about. Publishing all of `GATE_CODES` is the exact failure the published code set
 * exists to prevent -- a caller writing a branch that never runs. Advertising only the
 * base "GATE" is the opposite failure, because the base is not what arrives: a gate
 * carries its specific code.
 */
export const RAISED_GATE_CODES: readonly string[] = Object.freeze([
  'GATE_UNAPPROVED_CLUSTER',
  'GATE_CLOUD_SPEND',
  'GATE_DELETE_UNOWNED',
]);

/**
 * The hierarchy, as a list.
 *
 * The published error-code set is derived from every subclass, so a new subclass cannot
 * be forgotten. JavaScript keeps no subclass registry, so the walk has to become a list
 * -- and a list is exactly the thing that drifts. `errors.test.ts` therefore reads this
 * module's own source and fails if a class exported here is missing from it, which is the
 * same guarantee by the same mechanism that holds `RAISED_GATE_CODES`
 * (`invariants/error-codes.test.ts`).
 */
export const ERROR_CLASSES: readonly (typeof ReproError)[] = Object.freeze([
  ReproError,
  ValidationError,
  ConflictError,
  NotFoundError,
  MissingRecordError,
  NotReadyError,
  DockerError,
  PreflightError,
  CreateFailedError,
  AuthorityGateError,
]);

/**
 * The message alone, not `String(error)`'s `"Error: …"`.
 *
 * `String(new Error('bad rule'))` is `Error: bad rule`, where the established wording
 * interpolates `bad rule`. Every message that interpolates a caught exception
 * (`bad slo: <error>`, `can't import - repro not ready: <error>`) keeps that wording, so the
 * prefix is a difference a user would see.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every stable error code this build can actually emit, sorted. */
export function errorCodes(): string[] {
  const seen = new Set<string>();
  for (const cls of ERROR_CLASSES) {
    if (cls.code && cls.advertised) seen.add(cls.code);
  }
  for (const code of RAISED_GATE_CODES) seen.add(code);
  return [...seen].sort();
}

/** The payload shape `asPayload` produces. */
export interface ErrorPayload {
  error: string;
  code: string;
  kind: string;
  gate?: Gate;
  details?: Record<string, unknown>;
}

/**
 * A failure as a machine-readable object, for any front-end that speaks JSON.
 *
 * `code` is the stable half. `kind` is still emitted because it costs nothing and
 * something may already read it, but a class name is a refactor away from changing
 * while renaming a `code` is a breaking change -- new callers use `code`.
 */
export function asPayload(exc: ReproError): ErrorPayload {
  const body: ErrorPayload = { error: exc.message, code: exc.code, kind: exc.name };
  if (exc instanceof AuthorityGateError) {
    body.gate = exc.asGate();
  } else if (Object.keys(exc.details).length > 0) {
    body.details = { ...exc.details };
  }
  return body;
}

/**
 * Every exit code this taxonomy can produce, with a short machine-readable label.
 * Front-ends publish this rather than hardcoding the numbers, so the map has exactly
 * one definition.
 */
export const EXIT_CODES: Readonly<Record<number, string>> = Object.freeze({
  0: 'ok',
  1: 'internal',
  2: 'usage',
  3: 'preflight',
  4: 'not_found',
  5: 'not_ready',
  6: 'gate',
  7: 'create_failed',
  8: 'conflict',
});
