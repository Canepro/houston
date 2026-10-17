/**
 * Drive a scripted reproduction through a browser and record what it did.
 *
 * `evidence` answers "what was deployed"; this answers "what happened when you did the
 * thing". A support escalation is almost always shaped like *do X, then Y goes wrong*, and
 * a record of the deployment proves Y exists at best. The artifacts here -- a frame per
 * step, a screenshot per checkpoint, a video, and a log of every action -- are what a
 * reader who was not in the session can actually look at.
 *
 * Three properties are load-bearing, and none of them is incidental:
 *
 * - FAILURE IS LOUD. houston runs version-matched workspaces, and Rocket.Chat's selectors
 *   move between versions. A workload authored against 8.5.1 and pointed at 7.10.11 finds
 *   nothing, and a blank frame is worse than no frame because it still looks like evidence.
 *   A step that cannot run ends the capture, names itself in the manifest, and exits 9; and
 *   an artifact the manifest lists but the disk does not hold fails the run the same way.
 *
 * - KNOWN SECRETS HAVE A NARROW, CHECKED PATH. The manifest records the workload as
 *   authored, so a step filling `{{admin_pass}}` keeps the placeholder; a literal
 *   credential is `REDACTED`; and only an allowlisted action summary is traced. Raw
 *   Playwright network data is never collected because transient session credentials cannot
 *   be certified safe. Before a browser receives a known secret or a
 *   literal in a credential-shaped field, its target gets a persistent visual mask which
 *   covers it in screenshots and video.
 *   If that mask cannot be installed, the fill refuses before the value reaches the page.
 *   The trace records no browser content, screenshots or DOM snapshots. A page can echo a credential
 *   elsewhere, so the README requires a human visual review before attachment rather than
 *   claiming an automated pixel scan that does not exist.
 *
 * - THE BROWSER IS INJECTED. The runner holds the ordering, redaction and failure logic
 *   worth testing; a real browser in that path would only make it slow and flaky.
 *   `browserDriver` builds the Playwright one, and the tests pass a fake.
 *
 * Playwright is not a dependency of houston: most people using this tool want a
 * Rocket.Chat container, not a browser download. It is located at call time, from the
 * current directory or beside houston, and its absence is a preflight refusal that names
 * the install command.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as config from '../lib/config';
import {
  CaptureFailedError,
  ConflictError,
  PreflightError,
  ReproError,
  ValidationError,
} from '../lib/errors';
import { toText, valueKind } from '../lib/format';
import { credentialKey } from '../lib/redact';
import { joinPath, pathExpandUser } from '../lib/home';
import { type Bundle, record as evidenceRecord, writeBundle } from './evidence';
import * as naming from './lifecycle/naming';
import { adminPass, externalUrl, readMeta } from './runner/record';
import { reproLock } from './runner/locks';

/**
 * What a workload step may do. Deliberately small: each maps to a single browser call, so
 * the DSL cannot drift into being a worse programming language. A target is a raw
 * Playwright selector on purpose; it is the escape hatch that keeps an unusual
 * reproduction from being blocked on this file growing a verb.
 */
export const ACTIONS = ['goto', 'click', 'fill', 'press', 'wait_for', 'shot'] as const;
export type Action = (typeof ACTIONS)[number];

/** Keys a step may carry beside its action. */
const MODIFIERS: readonly string[] = ['value', 'timeout_ms', 'settle_ms'];

/**
 * A selector or placeholder name that carries a credential. Keyed off the NAME rather than
 * the value's shape: `{{admin_pass}}` is a secret because of what it is, not because it
 * looks like one.
 */
const PASSWORDISH = /pass|pwd|secret|token|otp/iu;

/** `{{key}}`, resolved for the browser and never for the record. */
const PLACEHOLDER = /\{\{[^}]*\}\}/gu;

const DEFAULT_TIMEOUT_MS = 15000;

/** Where Playwright writes its raw recording under the capture directory. Never publishable. */
const RAW_VIDEO_DIR = '_video';

/**
 * Pacing that makes the video reviewable by a person. `slowMo` spaces the actions out;
 * settle holds the frame after an action long enough for its RESULT to be on screen
 * before the next step. A recording that failed review did exactly this: the click
 * happened, but the video never showed what it changed.
 */
export const SLOW_MO_MS = 350;
export const SETTLE_MS = 400;

/**
 * Pinned so two runs of the same workload produce comparable frames, and so a screenshot
 * filed against a case is not sized by whoever ran it.
 */
export const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/**
 * Validation floors. Below these an artifact is almost certainly a blank frame or an empty
 * recording; the bundle is marked suspect rather than presented as proof. Floors, not
 * exact sizes: a legitimate artifact varies with page content.
 */
const MIN_FRAME_BYTES = 4096;
const MIN_VIDEO_BYTES = 16384;

export const REDACTED = 'REDACTED';

/** Bright enough to make a masked credential control obvious during the required visual review. */
export const SECRET_MASK_COLOR = '#ff00ff';

/** Files that identify a Houston evidence bundle which `--force` may deliberately replace. */
const BUNDLE_MARKERS = ['README.md', 'manifest.json'] as const;

/**
 * A workload name, and nothing that can be read as a path: `../x` or `/tmp/x` joined onto
 * the workloads directory would read a file outside it.
 */
const WORKLOAD_NAME = /^[a-z0-9][a-z0-9._-]*$/iu;

export interface Step {
  action: Action;
  target: string;
  value: string;
  /** Absent means the default, so an authored `settle_ms: 0` stays a real zero. */
  timeoutMs: number | null;
  settleMs: number | null;
}

export interface Workload {
  name: string;
  description: string;
  steps: Step[];
  /** `built-in`, or the path of the user file. */
  source: string;
}

/** One row of `houston workloads`. */
export interface WorkloadRow {
  name: string;
  description: string;
  source: string;
}

/**
 * What the runner asks of a browser. Thin on purpose: every method is one browser call,
 * so the part with branching stays testable without a browser. `settle` and `banner` are
 * optional because only a real recording benefits from pacing and narration, and neither
 * may ever be the reason a step fails.
 */
export interface Driver {
  goto(url: string, timeoutMs: number): Promise<void>;
  click(selector: string, timeoutMs: number): Promise<void>;
  fill(selector: string, value: string, timeoutMs: number): Promise<void>;
  press(key: string): Promise<void>;
  waitFor(selector: string, timeoutMs: number): Promise<void>;
  screenshot(file: string): Promise<void>;
  settle?(ms: number): Promise<void>;
  banner?(text: string): Promise<void>;
  /** Close the browser, flushing the video; must be safe to call after a failed step. */
  finish(): Promise<Artifacts>;
}

/**
 * What a driver leaves behind. `video` is its file name under the capture directory, or
 * null when nothing was recorded. `secrets` are the credentials the browser minted during
 * the run, such as session cookies and login tokens, which the runner removes from its
 * textual manifest after the browser closes.
 * This is best-effort discovery, not a proof that transient session values are known.
 */
export interface Artifacts {
  video: string | null;
  secrets: string[];
  /** Input selectors masked in every retained PNG after a known secret was entered. */
  maskedSelectors: string[];
}

export type Outcome = 'ok' | 'failed' | 'skipped';

export interface StepRecord {
  index: number;
  action: Action;
  target: string;
  /** Present on `fill` only: the authored value, placeholders intact, or `REDACTED`. */
  value?: string;
  outcome: Outcome;
  /** The frame left behind, relative to the capture directory; null when none was. */
  frame: string | null;
  ms: number;
  error?: string;
}

export interface Validation {
  check: string;
  artifact: string;
  status: 'ok' | 'suspect' | 'fail';
  detail: string;
}

/** `capture/manifest.json`: what was done, what it left behind, and whether that holds up. */
export interface Manifest {
  workload: string;
  description: string;
  status: 'ok' | 'failed';
  failure_kind: 'step' | 'artifact' | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  steps: StepRecord[];
  /** The curated checkpoint screenshots, in order, relative to the capture directory. */
  shots: string[];
  video: string | null;
  trace: string | null;
  failed_step: StepRecord | null;
  failure_frame: string | null;
  /** Counts only, never values: what redaction did to this run. */
  redaction: { placeholders: number; fields: number; secrets: number; trace_hits: number };
  /** The exact automatic privacy boundaries a reviewer needs to know before attaching this. */
  privacy: {
    trace_policy: 'action-summary-only';
    known_secret_values: number;
    masked_input_selectors: string[];
    trace_screenshots: false;
    trace_snapshots: false;
    visual_review_required: boolean;
  };
  validation: Validation[];
}

/** The `{{placeholders}}` a workload may use and the values they take, for the browser. */
export type Context = Record<string, string>;

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isAction(key: string): key is Action {
  return (ACTIONS as readonly string[]).includes(key);
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/**
 * A timing modifier exactly as authored: a nonnegative whole number of milliseconds, as a
 * YAML integer or an unsigned digit string. Truncating `1.9` or clamping `-5` would run the
 * step with timing the workload never declared, and a timing-sensitive reproduction would
 * quietly stop reproducing. `positive` also refuses 0, for a timeout: Playwright reads 0 as
 * "wait forever", which a capture must not do on a typo.
 */
function integerModifier(
  item: Record<string, unknown>,
  key: string,
  where: string,
  positive = false,
): number | null {
  const raw = item[key];
  if (raw === undefined || raw === null) return null;
  const whole =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/u.test(raw)
        ? Number(raw)
        : NaN;
  if (!Number.isSafeInteger(whole) || whole < 0 || (positive && whole === 0)) {
    throw new ValidationError(
      `${where}: ${key} must be a whole number of milliseconds${positive ? ' greater than zero' : ''}`,
    );
  }
  return whole;
}

/** A workload document, refused loudly for every shape that would silently do nothing. */
export function parseWorkload(text: string, source: string): Workload {
  let raw: unknown;
  try {
    raw = config.safeLoadYaml(text);
  } catch (error) {
    throw new ValidationError(
      `workload ${source} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`workload ${source} is ${valueKind(raw)}, not a mapping`);
  }
  const doc = raw as Record<string, unknown>;
  const rows = doc.steps === undefined || doc.steps === null ? [] : doc.steps;
  if (!Array.isArray(rows)) {
    throw new ValidationError(`workload ${source}: steps must be a list`);
  }
  const steps: Step[] = [];
  rows.forEach((row, i) => {
    const where = `workload ${source} step ${String(i)}`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new ValidationError(`${where} must be a mapping`);
    }
    const item = row as Record<string, unknown>;
    const keys = Object.keys(item);
    const actions = keys.filter(isAction);
    // Named rather than ignored: a typo'd action would otherwise skip the one interaction
    // the reproduction depends on while still producing frames, which reads as proof.
    const unknown = keys.find((key) => !isAction(key) && !MODIFIERS.includes(key));
    if (unknown !== undefined) {
      throw new ValidationError(
        `${where}: unknown key '${unknown}' (actions: ${ACTIONS.join(', ')})`,
      );
    }
    const action = actions[0];
    if (action === undefined || actions.length !== 1) {
      throw new ValidationError(`${where} must name exactly one action (${ACTIONS.join(', ')})`);
    }
    const target = toText(item[action]).trim();
    if (target === '') throw new ValidationError(`${where}: ${action} needs a target`);
    const value = item.value;
    if (action === 'fill' && (value === undefined || value === null)) {
      throw new ValidationError(`${where}: fill needs a value`);
    }
    // Typed exactly as written or not at all: `false`, `0` or a list coerced to text would
    // enter different data than the workload declares and still report a finished capture.
    if (action === 'fill' && typeof value !== 'string') {
      throw new ValidationError(
        `${where}: fill value must be a string, got ${valueKind(value)} (quote it in YAML)`,
      );
    }
    steps.push({
      action,
      target,
      value: typeof value === 'string' ? value : '',
      timeoutMs: integerModifier(item, 'timeout_ms', where, true),
      settleMs: integerModifier(item, 'settle_ms', where),
    });
  });
  if (steps.length === 0) throw new ValidationError(`workload ${source}: steps must not be empty`);
  const name = toText(doc.name).trim();
  return {
    name: name === '' ? 'unnamed' : name,
    description: toText(doc.description).trim(),
    steps,
    source,
  };
}

async function readIfFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ValidationError(
      `cannot read workload ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A workload by name. A user file (`<home>/workloads/<name>.yaml`) wins over the built-in
 * one, the precedence presets use: when a shipped workload drifts against a new
 * Rocket.Chat release it can be fixed locally without waiting for a release.
 */
export async function loadWorkload(name: string): Promise<Workload> {
  if (!WORKLOAD_NAME.test(name)) {
    throw new ValidationError(
      `workload name '${name}' is not a plain name (letters, digits, '.', '_' and '-')`,
    );
  }
  const user = joinPath(config.workloadDir(), `${name}.yaml`);
  const own = await readIfFile(user);
  if (own !== null) return parseWorkload(own, user);
  const builtin = await readIfFile(config.dataPath('workloads', `${name}.yaml`));
  if (builtin === null) {
    throw new ValidationError(`unknown workload '${name}' (run \`houston workloads\` to list)`);
  }
  return parseWorkload(builtin, 'built-in');
}

async function yamlStems(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ValidationError(
      `cannot list workloads ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return (
    entries
      .filter((entry) => entry.endsWith('.yaml') && entry !== '.yaml')
      .map((entry) => entry.slice(0, -'.yaml'.length))
      // `loadWorkload` is deliberately strict about names. The list must never advertise a
      // spelling the capture command will refuse before it even reads the file.
      .filter((stem) => WORKLOAD_NAME.test(stem))
      .sort()
  );
}

/** Every workload available here, built-in and user, a user file winning on name. */
export async function listWorkloads(): Promise<WorkloadRow[]> {
  const found = new Map<string, WorkloadRow>();
  for (const stem of await yamlStems(config.dataPath('workloads'))) {
    const file = config.dataPath('workloads', `${stem}.yaml`);
    try {
      const text = await readIfFile(file);
      if (text === null) continue;
      found.set(stem, {
        name: stem,
        description: parseWorkload(text, 'built-in').description,
        source: 'built-in',
      });
    } catch (error) {
      found.set(stem, {
        name: stem,
        description: `UNREADABLE — ${error instanceof Error ? error.message : 'workload could not be read'}`,
        source: 'built-in',
      });
    }
  }
  const userDir = config.workloadDir();
  for (const stem of await yamlStems(userDir)) {
    const file = joinPath(userDir, `${stem}.yaml`);
    // Per file, as the preset catalogue is: one half-written workload must not take out
    // the list, and a broken one is named rather than hidden.
    try {
      const text = await readIfFile(file);
      if (text === null) continue;
      found.set(stem, {
        name: stem,
        description: parseWorkload(text, file).description,
        source: file,
      });
    } catch (error) {
      found.set(stem, {
        name: stem,
        description: `UNREADABLE — ${error instanceof Error ? error.message : 'workload could not be read'}`,
        source: file,
      });
    }
  }
  return [...found.keys()].sort().map((key) => found.get(key) as WorkloadRow);
}

/**
 * Substitute `{{key}}` placeholders in one pass. Used for the browser, never for the record.
 * A placeholder nothing defines is an authoring error: typing or navigating the literal
 * `{{...}}` text could finish "successfully" while entering the wrong thing. A substituted
 * value is data and is never scanned again, so a password containing `{{x}}` stays intact.
 */
function resolve(text: string, context: Context): string {
  return text.replace(/\{\{([^}]*)\}\}/gu, (token: string, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      throw new ValidationError(`unresolved placeholder ${token}`);
    }
    return context[key] as string;
  });
}

/** Every goto target and fill value must resolve before a browser opens or a step runs. */
function assertResolvable(workload: Workload, context: Context): void {
  for (const [index, step] of workload.steps.entries()) {
    if (step.action !== 'goto' && step.action !== 'fill') continue;
    try {
      resolve(step.action === 'goto' ? step.target : step.value, context);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      throw new ValidationError(
        `workload step ${String(index)} (${step.action}): ${error.message}`,
      );
    }
  }
}

/**
 * The workspace's base URL for navigation: scheme, host and path, so a path-prefixed
 * deployment (`https://example.test/rocketchat`) keeps its prefix. Userinfo, query and
 * fragment are dropped, and evidence never shows more than the origin.
 */
function navigationBase(rootUrl: string): string {
  if (rootUrl === '') return '';
  try {
    const parsed = new URL(rootUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not HTTP(S)');
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
  } catch {
    throw new PreflightError('capture requires a valid HTTP(S) workspace origin');
  }
}

/**
 * Preserve a workload's valid URL shape instead of treating every target as a root path. A
 * root-relative target (`/`, `/rooms/general`) is relative to the workspace, so it goes under
 * the base path; `//host` and `/\host` are other authorities and are left to the URL parser.
 */
function navigationTarget(root: string, target: string, context: Context): string {
  const resolved = resolve(target, context);
  if (root === '') return resolved;
  // The URL parser ignores leading control characters and spaces and strips tab and newline.
  let first = 0;
  while (first < resolved.length && resolved.charCodeAt(first) <= 0x20) first += 1;
  const seen = resolved.slice(first).replace(/[\t\n\r]/gu, '');
  // Joined as text, not resolved: `/https://x` is a path under the workspace, where resolving
  // `https://x` against the base would make it an absolute URL.
  if (seen.startsWith('/') && !/^\/[/\\]/u.test(seen)) return new URL(`${root}${seen}`).toString();
  return new URL(resolved, `${root}/`).toString();
}

/**
 * Query and fragment parameters whose value is a credential. The shared key rule covers
 * `token`, `access_token`, `password`, `api_key` and the like. OAuth adds names it does not:
 * an authorization `code` is a credential, `state` is not, and the others are bearer values
 * of the same kind. Matching is on the whole name so `error_code` and `barcode` stay readable.
 */
const CREDENTIAL_PARAM =
  /^(?:code|(?:auth|authorization|oauth|verification|reset|login|magic|invite|otp)[_-]?code|auth|otp|totp|pwd|jwt|assertion|saml[_-]?(?:response|request)|sig|signature|sid|session[_-]?id)$/iu;

function credentialParam(name: string): boolean {
  // The URL parser strips tab and newlines, so `to\tken` is sent as `token`.
  let key = name.replace(/[\t\n\r]/gu, '');
  // The key can be percent-encoded as deeply as the target: `%74oken`, `%2574oken`.
  for (let depth = 0; depth < 4; depth += 1) {
    if (CREDENTIAL_PARAM.test(key) || credentialKey(key)) return true;
    const next = decoded(key);
    if (next === key) return false;
    key = next;
  }
  return true;
}

/** A parameter name after a `?`, `&`, `#` or `;`, up to its `=`. */
const PARAMETER_NAME = /[?&#;]([^=&#;?\s/]*(?:[\t\n\r]+[^=&#;?\s/]*)*)=/gu;

/**
 * `text` with the value of every credential-shaped parameter replaced, running to the next
 * `&` or `#`, and whether any was. A value made only of placeholders is left as authored: it
 * carries no secret by construction, as in `recordedValue`. An empty or already masked value
 * has nothing to hide and is not counted.
 */
function maskedParameters(text: string): { text: string; found: boolean } {
  let masked = '';
  let copied = 0;
  for (const match of text.matchAll(PARAMETER_NAME)) {
    // A parameter inside a value already masked is part of that value.
    if (match.index < copied || !credentialParam(match[1] ?? '')) continue;
    const start = match.index + match[0].length;
    let end = start;
    while (end < text.length && text[end] !== '&' && text[end] !== '#') end += 1;
    const value = text.slice(start, end);
    if (value === '' || value === REDACTED || value.replace(PLACEHOLDER, '') === '') continue;
    masked += `${text.slice(copied, start)}${REDACTED}`;
    copied = end;
  }
  PLACEHOLDER.lastIndex = 0;
  return { text: masked + text.slice(copied), found: copied > 0 };
}

/** Display authored navigation only. Context expansion belongs exclusively to the browser. */
function recordedTarget(step: Step, root: string): string {
  if (step.action !== 'goto') return step.target;
  try {
    // Use the navigation origin, including its scheme: special URLs without // can be
    // relative paths under one scheme and credential-bearing authorities under another.
    // A synthetic base only preserves relative display when the injected driver has no root.
    const base = root === '' ? undefined : root;
    const url =
      root === '' && !/^[a-z][a-z0-9+.-]*:/iu.test(step.target)
        ? new URL(step.target, 'http://capture.invalid')
        : new URL(step.target, base);
    let display = step.target;
    if (url.username !== '' || url.password !== '') {
      url.username = '';
      url.password = '';
      display = url.toString();
    }
    // A nested URL in a query, fragment or path is still authored credential text. Keep
    // the whole target private when it contains an authority with userinfo, including
    // percent-encoded nested URLs. This does not inspect selectors or expand placeholders.
    let decoded = display;
    for (let depth = 0; depth < 4; depth += 1) {
      // Check before decoding: an encoded slash, space, ?, # or backslash can be part of
      // userinfo and must not become an authority terminator before this test. Recognize
      // encoded URL punctuation too, since it can be escaped independently.
      // Only a raw `/` ends the run before the `@`. Whitespace, `\`, `?` and `#` do not:
      // WHATWG parsing keeps whitespace in userinfo, a non-special scheme keeps `\`, and a
      // lenient consumer may treat the others the same way. Over-masking a query value is
      // acceptable, leaking a password is not.
      const normalized = decoded.replaceAll('\t', '').replaceAll('\r', '').replaceAll('\n', '');
      if (
        /(?:[a-z][a-z0-9+.-]*(?::|%3a)(?:[/\\]|%2f|%5c)*|(?:[/\\]|%2f|%5c){2})[^/]*(?:@|%40)/iu.test(
          normalized,
        )
      )
        return REDACTED;
      if (depth === 0) {
        // A credential parameter at the top level keeps its key and loses its value, so the
        // record still says which link was followed. The rest is read as authored.
        display = maskedParameters(display).text;
        decoded = display;
      } else if (maskedParameters(decoded).found) {
        // One inside another parameter's encoded value cannot be masked in place: it would
        // have to be re-encoded at the depth it was found. The whole target stays private.
        return REDACTED;
      }
      const next = decodeURIComponent(decoded);
      if (next === decoded) return display;
      decoded = next;
    }
    return REDACTED;
  } catch {
    // Invalid or ambiguously encoded URLs can still contain userinfo. Generic navigation
    // errors and retained partial records never need their raw authored bytes.
    return REDACTED;
  }
}

/** Resolved context values that must not survive into an artifact, keyed off their names. */
export function secretValues(context: Context): string[] {
  return [
    ...new Set(
      Object.entries(context)
        .filter(([key, value]) => value !== '' && PASSWORDISH.test(key))
        .map(([, value]) => value),
    ),
  ];
}

/** `text` with every secret replaced, and how many were. */
export function redactText(
  text: string,
  secrets: readonly string[],
): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  // A session token can begin with a password or another token. Replace the longest values
  // first, otherwise replacing the prefix would leave the rest of the longer secret behind.
  const ordered = [...new Set(secrets.filter((secret) => secret !== ''))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of ordered) {
    const count = out.split(secret).length - 1;
    if (count === 0) continue;
    hits += count;
    out = out.replaceAll(secret, REDACTED);
  }
  return { text: out, hits };
}

/**
 * What the record says a `fill` typed. A value made only of placeholders carries no secret
 * by construction, so it is recorded as authored even into a password field: "it typed
 * {{admin_pass}}" tells a reader what happened, where `REDACTED` only tells them something
 * did. A literal value into a credential field is redacted whatever it is: a workload
 * author who inlines a password instead of using a placeholder must not be able to put it
 * in a bundle that goes to a case.
 */
function recordedValue(step: Step, secrets: readonly string[]): string {
  // A workload author can put a resolved password into an ordinary field by mistake. It has
  // to be redacted before the manifest is assembled: detecting it only while validating the
  // finished manifest would still leave the staged artifact holding the credential.
  if (secrets.some((secret) => secret !== '' && step.value.includes(secret))) return REDACTED;
  if (step.value.replace(PLACEHOLDER, '').trim() === '') return step.value;
  return PASSWORDISH.test(step.target) ? REDACTED : step.value;
}

async function apply(
  step: Step,
  driver: Driver,
  root: string,
  context: Context,
  dest: string,
  shots: string[],
): Promise<string | null> {
  // `timeout_ms` is honoured by every action that waits on the page, not just `wait_for`: a
  // click during a slow Rocket.Chat boot needs the same allowance, and a modifier that
  // parses but is ignored fails as "your selectors moved" when the real cause was the clock.
  const timeout = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  switch (step.action) {
    case 'goto':
      await driver.goto(navigationTarget(root, step.target, context), timeout);
      return null;
    case 'click':
      await driver.click(step.target, timeout);
      return null;
    case 'fill':
      await driver.fill(step.target, resolve(step.value, context), timeout);
      return null;
    case 'press':
      await driver.press(step.target);
      return null;
    case 'wait_for':
      await driver.waitFor(step.target, timeout);
      return null;
    case 'shot': {
      // A selector is not a file name. In particular, a valid selector may contain `/` or
      // `..`; derive the checkpoint name from its position so a workload cannot escape the
      // capture directory while still preserving the selector in the manifest.
      const file = `shots/shot-${String(shots.length + 1).padStart(2, '0')}.png`;
      await driver.screenshot(path.join(dest, file));
      shots.push(file);
      return file;
    }
  }
}

/** Playwright call logs repeat navigation URLs, which cannot become attachable evidence. */
function failureMessage(action: Action, error: unknown): string {
  if (action !== 'goto') return error instanceof Error ? error.message : String(error);
  const message = error instanceof Error ? error.message : String(error);
  return /timeout/iu.test(message) ? 'navigation timed out' : 'navigation failed';
}

/** The banner narrates the video and the settle paces it; neither may fail a step. */
async function quietly(action: (() => Promise<void>) | undefined): Promise<void> {
  if (action === undefined) return;
  try {
    await action();
  } catch {
    // Narration and pacing are for the reader of the video, never a reason to stop.
  }
}

async function finishQuietly(driver: Driver): Promise<Artifacts> {
  try {
    const out = await driver.finish();
    return {
      video: out.video,
      secrets: out.secrets.filter((s) => s !== ''),
      maskedSelectors: out.maskedSelectors,
    };
  } catch {
    // A close failure must not mask the step failure, and must not lose the manifest.
    return { video: null, secrets: [], maskedSelectors: [] };
  }
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    const st = await fs.stat(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** True for anything at `file`, a dangling symlink included. */
async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

export async function validateArtifacts(
  dest: string,
  manifest: Omit<Manifest, 'validation'>,
  secrets: readonly string[],
): Promise<Validation[]> {
  const rows: Validation[] = [];
  const check = async (rel: string, kind: string, floor: number): Promise<void> => {
    const size = await sizeOf(path.join(dest, rel));
    if (size === null) {
      rows.push({
        check: kind,
        artifact: rel,
        status: 'fail',
        detail: `${rel} is listed in the manifest but missing`,
      });
    } else if (size === 0) {
      rows.push({ check: kind, artifact: rel, status: 'fail', detail: `${rel} is empty` });
    } else if (size < floor) {
      rows.push({
        check: kind,
        artifact: rel,
        status: 'suspect',
        detail: `${rel} is only ${String(size)} bytes - likely blank; review before attaching`,
      });
    } else {
      rows.push({ check: kind, artifact: rel, status: 'ok', detail: rel });
    }
  };
  const clean = async (rel: string, text: string): Promise<void> => {
    const { hits } = redactText(text, secrets);
    rows.push(
      hits === 0
        ? { check: 'secrets', artifact: rel, status: 'ok', detail: rel }
        : {
            check: 'secrets',
            artifact: rel,
            status: 'fail',
            detail: `${rel} still holds ${String(hits)} secret value(s)`,
          },
    );
  };

  for (const step of manifest.steps) {
    if (step.outcome !== 'ok') continue;
    if (step.frame === null) {
      rows.push({
        check: 'frame',
        artifact: `step ${String(step.index)}`,
        status: 'fail',
        detail: `step ${String(step.index)} (${step.action}) left no frame`,
      });
    } else {
      await check(step.frame, step.action === 'shot' ? 'shot' : 'frame', MIN_FRAME_BYTES);
    }
  }
  if (manifest.failure_frame !== null) {
    await check(manifest.failure_frame, 'failure-frame', MIN_FRAME_BYTES);
  }
  if (manifest.video === null) {
    // Stated rather than omitted: a silently missing recording reads as a workload that
    // did not ask for one.
    rows.push({
      check: 'video',
      artifact: '',
      status: 'suspect',
      detail: 'no video was recorded; the frames are the only visual record',
    });
  } else {
    await check(manifest.video, 'video', MIN_VIDEO_BYTES);
  }
  if (manifest.trace !== null) await check(manifest.trace, 'trace', 1);
  // Playwright's raw recording is unmasked by design. If the driver could not remove it, the
  // capture is not attachable, whatever else it holds.
  if (await pathExists(path.join(dest, RAW_VIDEO_DIR))) {
    rows.push({
      check: 'raw-recording',
      artifact: RAW_VIDEO_DIR,
      status: 'fail',
      detail:
        `${RAW_VIDEO_DIR} still holds Playwright's raw browser recording, which was not ` +
        'removed; it is withheld from the bundle',
    });
  }
  await clean('manifest.json', JSON.stringify(manifest));
  return rows;
}

/**
 * Execute a workload against `driver`, writing its artifacts and manifest into `dest`.
 *
 * Throws `CaptureFailedError` when a step could not run or an artifact does not hold up.
 * The manifest is written either way, because a failed capture's partial artifacts are
 * exactly what tells you WHERE a workload drifted; what must not happen is a run that
 * failed halfway reporting success.
 */
export async function run(
  workload: Workload,
  driver: Driver,
  dest: string,
  context: Context = {},
): Promise<Manifest> {
  const out = pathExpandUser(dest);
  const stepsDir = path.join(out, 'steps');
  let root: string;
  const startedAt = stamp();
  const startedMs = Date.now();

  const steps: StepRecord[] = [];
  const shots: string[] = [];
  let failed: StepRecord | null = null;
  let failureFrame: string | null = null;
  let placeholders = 0;
  let fields = 0;
  const runSecrets = new Set(secretValues(context));
  let artifacts!: Artifacts;

  try {
    // The driver is already live here, so a refusal still closes it in the `finally` below.
    assertResolvable(workload, context);
    await fs.mkdir(stepsDir, { recursive: true });
    root = navigationBase(context.root_url ?? '');
    // Evidence shows an authored target against the origin alone, never the base path.
    const origin = root === '' ? '' : new URL(root).origin;
    try {
      for (const [i, step] of workload.steps.entries()) {
        const rec: StepRecord = {
          index: i,
          action: step.action,
          target: recordedTarget(step, origin),
          outcome: 'ok',
          frame: null,
          ms: 0,
        };
        if (failed !== null) {
          rec.outcome = 'skipped';
          steps.push(rec);
          continue;
        }
        if (step.action === 'fill') {
          const resolvedValue = resolve(step.value, context);
          if (PASSWORDISH.test(step.target) && resolvedValue !== '') runSecrets.add(resolvedValue);
          const value = recordedValue(step, [...runSecrets]);
          if (value === REDACTED) fields += 1;
          else if (value !== step.value || PLACEHOLDER.test(value)) placeholders += 1;
          PLACEHOLDER.lastIndex = 0;
          rec.value = value;
        }
        // Curated `shot` frames stay clean; every acting step is announced so the video says
        // what it is doing while it does it.
        const banner = driver.banner?.bind(driver);
        const narration =
          step.action === 'shot' ? '' : `step ${String(i)}: ${step.action} ${rec.target}`;
        await quietly(
          banner === undefined
            ? undefined
            : () => banner(redactText(narration, [...runSecrets]).text),
        );
        const begun = Date.now();
        try {
          const shot = await apply(step, driver, root, context, out, shots);
          if (shot !== null) {
            rec.frame = shot;
          } else {
            // Hold the result on screen, then keep its frame. The pair is what makes an
            // omitted or invisible action detectable at review instead of at escalation.
            const settle = driver.settle?.bind(driver);
            await quietly(
              settle === undefined ? undefined : () => settle(step.settleMs ?? SETTLE_MS),
            );
            const frame = `steps/step-${String(i).padStart(2, '0')}-${step.action}.png`;
            rec.frame = frame;
            try {
              await driver.screenshot(path.join(out, frame));
            } catch {
              // A lost frame is reported by validation, not a reason to stop the run.
            }
          }
        } catch (error) {
          rec.outcome = 'failed';
          rec.error = failureMessage(step.action, error);
          failed = rec;
          // The page as it looked at the moment of failure is the single most useful
          // artifact a drifted workload can leave behind.
          const frame = `steps/failed-step-${String(i).padStart(2, '0')}.png`;
          try {
            await driver.screenshot(path.join(out, frame));
            failureFrame = frame;
          } catch {
            failureFrame = null;
          }
        } finally {
          rec.ms = Date.now() - begun;
          steps.push(rec);
        }
      }
    } finally {
      const banner = driver.banner?.bind(driver);
      await quietly(banner === undefined ? undefined : () => banner(''));
    }
  } finally {
    // A driver is already a live browser when this function is called. Close it even if
    // initial artifact setup or narration fails, and let the original error keep its cause.
    artifacts = await finishQuietly(driver);
  }
  const finishedAt = stamp();

  // The browser's own session credentials join the set before anything is written as text.
  const secrets = [...new Set([...runSecrets, ...artifacts.secrets])];
  for (const rec of steps) {
    rec.target = redactText(rec.target, secrets).text;
    if (rec.value !== undefined) rec.value = redactText(rec.value, secrets).text;
    if (rec.error !== undefined) rec.error = redactText(rec.error, secrets).text;
  }

  // Never start Playwright tracing: it records transient credentials in network bodies,
  // headers and WebSockets, including sessions gone before shutdown. This allowlist records
  // execution only, with no browser strings, URLs, selectors, values, DOM or network data.
  const trace = 'trace.json';
  await fs.writeFile(
    path.join(out, trace),
    `${JSON.stringify(
      {
        schema: 'houston.capture-actions.v1',
        steps: steps.map(({ index, action, outcome, ms }) => ({ index, action, outcome, ms })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const partial: Omit<Manifest, 'validation'> = {
    workload: redactText(workload.name, secrets).text,
    description: redactText(workload.description, secrets).text,
    status: failed === null ? 'ok' : 'failed',
    failure_kind: failed === null ? null : 'step',
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - startedMs,
    steps,
    shots,
    video: artifacts.video,
    trace,
    failed_step: failed,
    failure_frame: failureFrame,
    redaction: { placeholders, fields, secrets: secrets.length, trace_hits: 0 },
    privacy: {
      trace_policy: 'action-summary-only',
      known_secret_values: secrets.length,
      masked_input_selectors: artifacts.maskedSelectors.map(
        (selector) => redactText(selector, secrets).text,
      ),
      trace_screenshots: false,
      trace_snapshots: false,
      // A mask proves only that one input was covered. A page can already show a credential,
      // or render one elsewhere after an action, and Houston has no pixel scanner that could
      // certify the retained frames or video. Every visual capture therefore needs review.
      visual_review_required: true,
    },
  };
  const validation = await validateArtifacts(out, partial, secrets);
  const missing = validation.filter((row) => row.status === 'fail');
  const manifest: Manifest = {
    ...partial,
    status: failed === null && missing.length === 0 ? 'ok' : 'failed',
    failure_kind: failed !== null ? 'step' : missing.length > 0 ? 'artifact' : null,
    validation,
  };
  const manifestFile = path.join(out, 'manifest.json');
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (failed !== null) {
    throw new CaptureFailedError(
      `capture stopped at step ${String(failed.index)} (${failed.action} '${failed.target}'): ` +
        `${failed.error ?? ''}. If the workload was written for another Rocket.Chat ` +
        'version, its selectors may have moved.',
      { details: { manifest: manifestFile } },
    );
  }
  if (missing.length > 0) {
    throw new CaptureFailedError(
      `capture ran but its artifacts do not hold up: ${missing.map((row) => row.detail).join('; ')}. ` +
        'Do not attach this bundle as proof.',
      { details: { manifest: manifestFile } },
    );
  }
  return manifest;
}

/**
 * Stop before overwriting a bundle that already exists.
 *
 * A bundle is evidence, and its README is where a person writes the observed behaviour by
 * hand. A rerun cannot restore that, so replacing it has to be something the operator asks
 * for rather than something a repeated command does quietly. Checked before the browser
 * starts, so a refusal costs nothing and leaves no partial artifacts behind.
 */
type BundleRoot = 'missing' | 'empty' | 'nonempty' | 'unsafe';

async function bundleRoot(dest: string): Promise<BundleRoot> {
  let info: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    info = await fs.lstat(dest);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ENOENT'
    )
      return 'missing';
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return 'unsafe';
  return (await fs.readdir(dest)).length === 0 ? 'empty' : 'nonempty';
}

/** A directory is replaceable only when both normal Houston bundle files identify it. */
async function identifiesHoustonBundle(dest: string): Promise<boolean> {
  try {
    const manifestPath = path.join(dest, BUNDLE_MARKERS[1]);
    const [readme, manifestInfo, manifest] = await Promise.all([
      fs.lstat(path.join(dest, BUNDLE_MARKERS[0])),
      fs.lstat(manifestPath),
      fs.readFile(manifestPath, 'utf8'),
    ]);
    if (
      !readme.isFile() ||
      readme.isSymbolicLink() ||
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink()
    )
      return false;
    const payload = bag(JSON.parse(manifest));
    return toText(bag(payload.repro).name) !== '';
  } catch {
    return false;
  }
}

/**
 * Refuse to reuse an evidence root without explicit force. A nonempty unrecognised
 * directory stays untouched even with force, and an empty directory is removed so the
 * evidence writer can claim a fresh root with exclusive creation.
 */
export async function prepareBundleRoot(dest: string, force: boolean): Promise<void> {
  const state = await checkedBundleRoot(dest, force);
  if (state === 'missing') return;
  if (state === 'empty') {
    await fs.rmdir(dest);
    return;
  }
  await fs.rm(dest, { recursive: true, force: false });
}

/** Check whether an output may be replaced without changing it. */
async function checkedBundleRoot(dest: string, force: boolean): Promise<BundleRoot> {
  const state = await bundleRoot(dest);
  if (state === 'missing') return state;
  if (state === 'unsafe') {
    throw new ConflictError(
      `${dest} is not a plain directory; capture will not replace it, even with --force.`,
    );
  }
  if (state === 'empty') return state;
  if (!force) {
    throw new ConflictError(
      `${dest} already contains files. Pass a different --bundle, or --force to replace an ` +
        'identifiable earlier Houston bundle.',
    );
  }
  if (!(await identifiesHoustonBundle(dest))) {
    throw new ConflictError(
      `${dest} is not an identifiable Houston evidence bundle; --force never removes arbitrary files.`,
    );
  }
  return state;
}

/** Create a sibling so a failed evidence write cannot leave a partial bundle root behind. */
async function captureStage(dest: string): Promise<string> {
  const parent = path.dirname(dest);
  await fs.mkdir(parent, { recursive: true });
  return await fs.mkdtemp(path.join(parent, `.${path.basename(dest) || 'capture'}.stage-`));
}

/** The manifest is written even for a failed run, so the evidence README can name the stop. */
async function manifestFrom(dir: string): Promise<Manifest | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    return Object.keys(bag(value)).length === 0 ? null : (value as Manifest);
  } catch {
    return null;
  }
}

/** The bundle receipt names every file, including the staged browser artifacts moved into it. */
async function filesBelow(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(absolute, relative)));
    else if (entry.isFile()) found.push(relative);
  }
  return found.sort();
}

/** Keep staged files readable after a later writer fails, and name their exact location. */
function reportStage(error: unknown, stage: string): never {
  const note = `Capture artifacts remain at ${stage}.`;
  if (error instanceof ReproError) {
    error.details.capture_stage = stage;
    error.message = `${error.message} ${note}`;
    throw error;
  }
  throw new ReproError(
    `could not finish the capture bundle: ${error instanceof Error ? error.message : String(error)}. ${note}`,
    { details: { capture_stage: stage } },
  );
}

/** What the browser needs beyond the origin. Never written to any artifact. */
export interface DriverOptions {
  /** HTTP basic-auth credentials taken from the workspace URL's userinfo, decoded. */
  httpCredentials?: { username: string; password: string };
}

/** Builds the browser for a run: the real one by default, a fake in tests. */
export type DriverFactory = (
  rootUrl: string,
  dest: string,
  secrets: readonly string[],
  options?: DriverOptions,
) => Promise<Driver>;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Userinfo in the workspace URL is HTTP basic auth for the browser, not evidence. `URL.origin`
 * drops it, so it is taken here, decoded for Playwright, and both spellings of the password
 * go to the redaction set in case a log line or error repeats the URL.
 */
function workspaceCredentials(rootUrl: string): { options: DriverOptions; secrets: string[] } {
  if (rootUrl === '') return { options: {}, secrets: [] };
  const { username, password } = new URL(rootUrl);
  if (username === '' && password === '') return { options: {}, secrets: [] };
  return {
    options: { httpCredentials: { username: decoded(username), password: decoded(password) } },
    secrets: [...new Set([decoded(password), password].filter((value) => value !== ''))],
  };
}

/**
 * Raw browser output must never travel with a capture. Remove it; if that fails, move it
 * out of the capture directory so the rename that publishes the capture cannot carry it.
 */
async function withholdRawRecording(captureDir: string, stage: string): Promise<void> {
  const raw = path.join(captureDir, RAW_VIDEO_DIR);
  if (!(await pathExists(raw))) return;
  try {
    await fs.rm(raw, { recursive: true, force: true });
  } catch {
    await fs.rename(raw, path.join(stage, 'withheld-raw-recording'));
  }
}

/**
 * Run a workload against a workspace and write the complete attachable bundle: the
 * capture under `capture/`, then the evidence record and its README around it.
 *
 * The ordering is load-bearing: the evidence bundle is written BEFORE a capture failure
 * propagates, so a run that drifted still produces the README whose banner explains where
 * it stopped, and the failure names that bundle. Losing it on failure would throw away the
 * artifacts that show what went wrong.
 *
 * The admin login comes from the workspace record and goes to the browser only; the
 * evidence record never carried it and the capture manifest records placeholders.
 */
export async function captureBundle(
  name: string,
  workloadName: string,
  dest = '',
  {
    force = false,
    driverFactory = browserDriver,
  }: { force?: boolean; driverFactory?: DriverFactory } = {},
): Promise<Record<string, unknown>> {
  const workload = await loadWorkload(workloadName);
  const target = await naming.resolveName(name);
  // The evidence owner takes this same async-reentrant lock. Keep it across browser
  // activity and publication so a waiting upgrade cannot relabel an older recording.
  return await reproLock(target, async () => {
    const meta = await readMeta(target);
    const out =
      dest === '' ? joinPath(config.reportsDir(), target, workloadName) : pathExpandUser(dest);
    // Validate `--force` before opening a browser, but leave a prior bundle intact until that
    // browser has completed its optional-dependency and Chromium preflight.
    await checkedBundleRoot(out, force);
    const workspaceUrl = externalUrl(meta);
    const context: Context = {
      root_url: navigationBase(workspaceUrl),
      admin_user: config.ADMIN_USERNAME,
      admin_pass: adminPass(meta),
    };
    // An unresolved placeholder is an authoring error: refuse before any browser or output.
    assertResolvable(workload, context);
    const credentials = workspaceCredentials(workspaceUrl);
    const stage = await captureStage(out);
    const captureDir = path.join(stage, 'capture');
    let driver: Driver;
    try {
      driver = await driverFactory(
        // The browser is told the origin: it scopes HTTP credentials, which must not follow a
        // navigation to another site. Navigation itself carries the base path.
        context.root_url === undefined || context.root_url === ''
          ? ''
          : new URL(context.root_url).origin,
        captureDir,
        [...secretValues(context), ...credentials.secrets],
        credentials.options,
      );
    } catch (error) {
      // A driver that never started has no useful evidence. Delete its private staging directory
      // so a failed optional-dependency preflight cannot leave raw browser output behind.
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    try {
      await prepareBundleRoot(out, force);
    } catch (error) {
      await finishQuietly(driver);
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    let failure: CaptureFailedError | null = null;
    let manifest: Manifest | null;
    try {
      manifest = await run(workload, driver, captureDir, context);
    } catch (error) {
      if (!(error instanceof CaptureFailedError)) reportStage(error, stage);
      failure = error;
      manifest = await manifestFrom(captureDir);
    }
    const capture = manifest ?? (await manifestFrom(captureDir));
    let payload: Record<string, unknown>;
    try {
      payload = await evidenceRecord(target);
    } catch (error) {
      reportStage(error, stage);
    }
    let bundle: Bundle;
    try {
      bundle = await writeBundle(target, out, payload, capture ?? undefined);
    } catch (error) {
      reportStage(error, stage);
    }
    try {
      await withholdRawRecording(captureDir, stage);
      const captured = await filesBelow(captureDir, 'capture');
      await fs.rename(captureDir, path.join(out, 'capture'));
      bundle.files = [...new Set([...bundle.files, ...captured])].sort();
      await fs.rm(stage, { recursive: true, force: true });
    } catch (error) {
      reportStage(error, stage);
    }
    payload.bundle = bundle;
    if (failure !== null) {
      failure.details.bundle = bundle.path;
      if (capture !== null)
        failure.details.manifest = path.join(bundle.path, 'capture', 'manifest.json');
      failure.message = `${failure.message} Partial capture bundle retained at ${bundle.path}.`;
      throw failure;
    }
    payload.capture = manifest;
    return payload;
  });
}

/*
 * The Playwright surface this module uses, declared here rather than imported: a type
 * import would be a production edge to a devDependency, and the dependency gate would
 * rightly refuse it. Each member is the documented shape of the call it names.
 */
interface PwVideo {
  saveAs(file: string): Promise<void>;
  delete(): Promise<void>;
}
interface PwPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  click(selector: string, options: { timeout: number }): Promise<void>;
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
  locator(selector: string): PwLocator;
  keyboard: { press(key: string): Promise<void> };
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  addInitScript(script: { content: string }): Promise<void>;
  video(): PwVideo | null;
  close(): Promise<void>;
}
interface PwLocator {
  elementHandle(options: { timeout: number }): Promise<PwElement>;
}
interface PwElement {
  evaluate(
    callback: (target: MaskTarget | null, options: MaskOptions) => string[] | null,
    options: MaskOptions,
  ): Promise<string[] | null>;
  waitForElementState(state: 'visible', options: { timeout: number }): Promise<void>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  dispose(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  cookies(): Promise<{ name: string; value: string }[]>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: { launch(options: { slowMo: number }): Promise<PwBrowser> };
}

/** The packages that provide a browser, in the order tried; either launches Chromium. */
export const PLAYWRIGHT_MODULES: readonly string[] = Object.freeze([
  'playwright',
  'playwright-core',
]);

const INSTALL_HINT = 'then `npx playwright install chromium`, and retry';

/**
 * Playwright, located at call time: from the current directory first, so a project that
 * has it serves it to houston, then beside houston itself, which is where a checkout's
 * devDependencies put it. The name is held in a variable on purpose: houston does not
 * depend on Playwright, and the dependency gate must not read a production edge to a
 * devDependency where there is none.
 */
export function loadPlaywright(candidates: readonly string[] = PLAYWRIGHT_MODULES): PwModule {
  const paths = [process.cwd(), config.dataPath('..')];
  for (const name of candidates) {
    let resolved: string;
    try {
      resolved = require.resolve(name, { paths });
    } catch {
      continue;
    }
    return require(resolved) as PwModule;
  }
  throw new PreflightError(
    'browser capture needs Playwright, which houston does not install: run ' +
      '`npm install playwright` in this directory (or next to houston), ' +
      INSTALL_HINT,
  );
}

/** Playwright's own wording for a browser it has not downloaded. */
const NO_BROWSER = /Executable doesn't exist|playwright install/iu;

/** The banner, as a page expression: a small high-contrast step label the video narrates itself with. */
function bannerScript(text: string): string {
  return `(() => {
    const text = ${JSON.stringify(text)};
    let el = document.getElementById('__houston_step__');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = '__houston_step__';
      el.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;'
        + 'background:#111;color:#fff;font:600 14px/1.4 system-ui,sans-serif;'
        + 'padding:6px 10px;border-radius:6px;opacity:.92;pointer-events:none;max-width:60vw;';
      document.body.appendChild(el);
    }
    el.textContent = text;
  })()`;
}

/**
 * Hide the resolved control itself and install a visible cover before Playwright fills it.
 * The intrinsic hiding survives later top-layer moves and cover removal. Its style observer
 * restores page edits in the mutation microtask, before paint, rather than detecting a leak
 * after a screenshot or after video frames have already been recorded. The selector stays
 * tracked for the rest of the capture, so a control the page replaces is hidden and covered
 * the moment it appears, not only the node that was filled.
 * Returning false refuses the fill before the secret reaches a control we cannot protect.
 */
interface MaskRoot {
  querySelectorAll(selector: string): ArrayLike<MaskTarget>;
}
interface MaskTarget extends MaskRoot {
  style: {
    setProperty(name: string, value: string, priority: string): void;
    getPropertyValue(name: string): string;
    getPropertyPriority(name: string): string;
  };
  nodeType: number;
  isConnected: boolean;
  tagName: string;
  assignedSlot: MaskTarget | null;
  parentElement: MaskTarget | null;
  shadowRoot: MaskRoot | null;
  getAttribute(name: string): string | null;
  getRootNode(): { host?: MaskTarget };
  matches(selector: string): boolean;
  scrollIntoView(options: { block: string; inline: string }): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}
interface MaskCover {
  setAttribute(name: string, value: string): void;
  style: {
    cssText: string;
    display: string;
    left: string;
    top: string;
    width: string;
    height: string;
    pointerEvents: string;
  };
}
interface MaskOptions {
  color: string;
  /** CSS selectors to protect for the rest of the document, whatever node they resolve to. */
  selectors: string[];
}
interface MaskRecord {
  type: string;
  target: MaskTarget;
  addedNodes: ArrayLike<MaskTarget>;
  attributeName: string | null;
}
interface MaskObserver {
  observe(
    target: MaskTarget | MaskRoot,
    options: {
      attributes?: boolean;
      attributeFilter?: string[];
      childList?: boolean;
      subtree?: boolean;
    },
  ): void;
}
interface MaskEntry {
  target: MaskTarget;
  cover: MaskCover;
  watched: boolean;
  /** The geometry last written to the cover, so an unmoved control costs no style write. */
  placed: string;
}
interface MaskState {
  entries: MaskEntry[];
  selectors: string[];
  /** The document and every shadow root seen, each observed for the rest of the page. */
  roots: MaskRoot[];
  covers: WeakSet<object>;
  observer: MaskObserver | null;
  adopt: ((root: MaskRoot) => void) | null;
  patched: boolean;
  running: boolean;
}

/**
 * Executed in the browser realm, with no module closures. It is also injected as an init
 * script with a null target, so a later navigation keeps protecting the same selectors.
 *
 * With a target it returns the CSS selector now tracked, or null to refuse the fill. The
 * authored selector is tracked when native CSS resolves it to the target. A Playwright-only
 * selector (`xpath=`, `>>`, `text=`) cannot be re-resolved here, so the control's own
 * attributes become the tracked selector. A control with none to go on is refused, because
 * tracking its handle alone would leave a replacement uncovered.
 *
 * New matches are found by observing mutations, and only the nodes a mutation names are
 * examined: the document is walked once, when a selector is first tracked. The animation
 * frame loop only moves existing covers, so an idle page costs it no selector query.
 */
function installSecretMask(target: MaskTarget | null, options: MaskOptions): string[] | null {
  const browser = globalThis as unknown as {
    __houstonSecretMasks__?: MaskState;
    innerHeight: number;
    innerWidth: number;
    document: MaskRoot & {
      createElement(tag: string): MaskCover;
      documentElement: { appendChild(cover: MaskCover): void } | null;
      elementFromPoint(left: number, top: number): MaskCover | null;
      fullscreenElement: MaskTarget | null;
    };
    Element: { prototype: { attachShadow(init: unknown): MaskRoot } };
    requestAnimationFrame(callback: () => void): void;
    getComputedStyle(target: MaskTarget): {
      opacity: string;
      transitionProperty: string;
      animationName: string;
    };
    MutationObserver: new (callback: (records: MaskRecord[]) => void) => MaskObserver;
  };
  const state = (browser.__houstonSecretMasks__ ??= {
    entries: [],
    selectors: [],
    roots: [],
    covers: new WeakSet(),
    observer: null,
    adopt: null,
    patched: false,
    running: false,
  });
  const WATCH = { childList: true, subtree: true, attributes: true };
  // A selector whose match can change without the matching node itself changing: a
  // combinator or a pseudo-class. Its mutations also re-examine the parent.
  const structural = (selector: string): boolean => /[\s>+~:]/u.test(selector);
  const maskingUnproved = (node: MaskTarget): boolean => {
    if (!node.isConnected) return true;
    let current: MaskTarget | null = node;
    while (current !== null) {
      try {
        if (
          current === browser.document.fullscreenElement ||
          current.matches(':fullscreen') ||
          current.matches(':modal') ||
          current.matches(':popover-open')
        )
          return true;
      } catch {
        // If the browser cannot answer whether this ancestry is top-layer, it cannot prove a
        // document-local cover will be visible over the control.
        return true;
      }
      current = current.assignedSlot ?? current.parentElement ?? current.getRootNode().host ?? null;
    }
    return false;
  };
  const cover = (node: MaskTarget): MaskEntry => {
    let entry = state.entries.find((item) => item.target === node);
    if (entry === undefined) {
      const element = browser.document.createElement('div');
      element.setAttribute('aria-hidden', 'true');
      element.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;' +
        `background:${options.color};opacity:1;display:none;`;
      state.covers.add(element);
      browser.document.documentElement?.appendChild(element);
      entry = { target: node, cover: element, watched: false, placed: '' };
      state.entries.push(entry);
    }
    return entry;
  };
  // The only work the frame loop does. A scroll or a layout change moves a control without
  // any mutation, so geometry is read every frame, and written only when it changed.
  const position = (): void => {
    for (const item of state.entries) {
      const rect = item.target.isConnected ? item.target.getBoundingClientRect() : null;
      const placed =
        rect === null || rect.width <= 0 || rect.height <= 0
          ? 'hidden'
          : `${String(rect.left)} ${String(rect.top)} ${String(rect.width)} ${String(rect.height)}`;
      if (placed === item.placed) continue;
      item.placed = placed;
      if (rect === null || placed === 'hidden') {
        item.cover.style.display = 'none';
        continue;
      }
      item.cover.style.display = 'block';
      item.cover.style.left = `${String(rect.left)}px`;
      item.cover.style.top = `${String(rect.top)}px`;
      item.cover.style.width = `${String(rect.width)}px`;
      item.cover.style.height = `${String(rect.height)}px`;
    }
  };
  // Opacity hides the whole native control, including its text, caret and internal shadow
  // content, without changing its value, focusability or Playwright's visibility predicate.
  // Inline !important defeats author CSS and animation; disabling transitions prevents a
  // page style reset from animating a previously visible value back towards zero opacity.
  const properties = [
    ['transition', 'none'],
    ['animation', 'none'],
    ['opacity', '0'],
  ] as const;
  const hide = (node: MaskTarget): void => {
    for (const [name, value] of properties) {
      if (
        node.style.getPropertyValue(name) !== value ||
        node.style.getPropertyPriority(name) !== 'important'
      )
        node.style.setProperty(name, value, 'important');
    }
  };
  // Hide the control itself and keep it hidden: the style observer restores page edits in
  // the mutation microtask, before paint, rather than after frames have been recorded.
  const protect = (entry: MaskEntry): void => {
    if (entry.watched) return;
    entry.watched = true;
    hide(entry.target);
    new browser.MutationObserver(() => {
      hide(entry.target);
    }).observe(entry.target, { attributes: true, attributeFilter: ['style'] });
    position();
  };
  // A structural selector (`.reveal + input`, `:has()`) can start matching a node outside the
  // changed subtree, so it is resolved in every known root: one query per selector, never a
  // walk of every element.
  const protectMatches = (scope: MaskRoot, deep: boolean, node: MaskTarget | null): void => {
    for (const selector of state.selectors) {
      try {
        if (node !== null && node.matches(selector)) protect(cover(node));
        const scopes = deep ? [scope] : structural(selector) ? state.roots : [];
        for (const root of scopes)
          for (const match of Array.from(root.querySelectorAll(selector))) protect(cover(match));
      } catch {
        // The selector was valid when it was accepted; never let a page break the observer.
      }
    }
  };
  // Shadow hosts at or below `scope`. Walks only that subtree, and only for a root or an
  // added node, never for the whole document on a frame.
  const discover = (scope: MaskTarget | MaskRoot): void => {
    const hosts = Array.from(scope.querySelectorAll('*'));
    if ('shadowRoot' in scope) hosts.unshift(scope);
    for (const host of hosts) {
      if (host.shadowRoot !== null) state.adopt?.(host.shadowRoot);
    }
  };
  const adopt = (root: MaskRoot): void => {
    if (state.roots.includes(root)) return;
    state.roots.push(root);
    state.observer?.observe(root, WATCH);
    discover(root);
    protectMatches(root, true, null);
  };
  state.adopt = adopt;
  // Mutation records name what changed. Each added node is examined with its subtree, and a
  // changed attribute only for the node it is on: the page's own churn, and this mask's style
  // writes and covers, must not become a scan of the document.
  state.observer ??= new browser.MutationObserver((records) => {
    const added = new Set<MaskTarget>();
    const touched = new Set<MaskTarget>();
    for (const record of records) {
      if (state.covers.has(record.target)) continue;
      if (record.type === 'attributes') {
        if (record.attributeName !== 'style') touched.add(record.target);
        continue;
      }
      touched.add(record.target);
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType === 1 && !state.covers.has(node)) added.add(node);
      }
    }
    for (const node of added) {
      discover(node);
      protectMatches(node, true, node);
    }
    for (const node of touched) {
      if (!added.has(node) && node.nodeType === 1) protectMatches(node, false, node);
    }
    position();
  });
  if (!state.patched) {
    // Attaching a shadow root changes nothing the document observer can see, and the content
    // that follows lands inside a root it does not watch. Hear about the root itself, closed
    // roots included, which no later walk could find.
    state.patched = true;
    const attach = browser.Element.prototype.attachShadow;
    browser.Element.prototype.attachShadow = function (this: MaskTarget, init: unknown) {
      const root = attach.call(this, init);
      try {
        state.adopt?.(root);
      } catch {
        // Never let the mask break the page's own component.
      }
      return root;
    };
  }
  adopt(browser.document);

  // Every match for a selector in every root known. Used when a selector is first tracked.
  const query = (selector: string): MaskTarget[] =>
    state.roots.flatMap((root) => Array.from(root.querySelectorAll(selector)));
  const resolves = (selector: string, node: MaskTarget): boolean => {
    try {
      return selector !== '' && query(selector).includes(node);
    } catch {
      return false;
    }
  };
  let tracked = options.selectors;
  if (target !== null) {
    if (maskingUnproved(target)) return null;
    const authored = options.selectors[0] ?? '';
    let selector = resolves(authored, target) ? authored : '';
    if (selector === '') {
      const identity = ['name', 'type', 'id', 'autocomplete', 'formcontrolname', 'data-testid']
        .filter((attribute) => target.getAttribute(attribute) !== null)
        .map((attribute) => `[${attribute}=${JSON.stringify(target.getAttribute(attribute))}]`);
      selector = identity.length === 0 ? '' : `${target.tagName.toLowerCase()}${identity.join('')}`;
    }
    if (!resolves(selector, target)) return null;
    tracked = [selector];
    target.scrollIntoView({ block: 'center', inline: 'center' });
    if (maskingUnproved(target)) return null;
    const entry = cover(target);
    position();
    if (entry.cover.style.display !== 'block') return null;
    const rect = target.getBoundingClientRect();
    const left = rect.left + rect.width / 2;
    const top = rect.top + rect.height / 2;
    if (left < 0 || top < 0 || left >= browser.innerWidth || top >= browser.innerHeight)
      return null;
    const previousPointerEvents = entry.cover.style.pointerEvents;
    entry.cover.style.pointerEvents = 'auto';
    try {
      if (browser.document.elementFromPoint(left, top) !== entry.cover) return null;
    } finally {
      entry.cover.style.pointerEvents = previousPointerEvents;
    }
    hide(target);
    const computed = browser.getComputedStyle(target);
    if (
      computed.opacity !== '0' ||
      computed.transitionProperty !== 'none' ||
      computed.animationName !== 'none'
    )
      return null;
    protect(entry);
  }
  for (const selector of tracked) {
    if (!state.selectors.includes(selector)) state.selectors.push(selector);
  }
  // One walk per newly tracked selector set: a control already present beyond the filled one.
  for (const root of state.roots) protectMatches(root, true, null);
  if (!state.running) {
    state.running = true;
    // A pseudo-class such as `:checked` changes with no mutation to hear, so those selectors,
    // and only those, are resolved again each frame.
    const tick = (): void => {
      for (const selector of state.selectors) {
        if (!selector.includes(':')) continue;
        try {
          for (const root of state.roots)
            for (const match of Array.from(root.querySelectorAll(selector))) protect(cover(match));
        } catch {
          // The selector was valid when it was accepted; never let a page break the frame loop.
        }
      }
      position();
      browser.requestAnimationFrame(tick);
    };
    browser.requestAnimationFrame(tick);
  }
  return tracked;
}

/**
 * The real browser. Thin on purpose: every method is one Playwright call, so the part
 * with branching stays testable without a browser. Reduced motion and the pinned
 * viewport make repeated runs of one workload comparable frames rather than diffs made
 * of animation.
 */
class PlaywrightDriver implements Driver {
  private readonly secretTargets = new Set<string>();
  private readonly initScripts = new Set<string>();
  private readonly runtimeSecrets: Set<string>;

  private constructor(
    private readonly dest: string,
    private readonly browser: PwBrowser,
    private readonly context: PwContext,
    private readonly page: PwPage,
    baseSecrets: readonly string[],
  ) {
    this.runtimeSecrets = new Set(baseSecrets.filter((secret) => secret !== ''));
  }

  static async open(
    pw: PwModule,
    rootUrl: string,
    dest: string,
    secrets: readonly string[] = [],
    credentials?: { username: string; password: string },
  ): Promise<PlaywrightDriver> {
    await fs.mkdir(dest, { recursive: true });
    let browser: PwBrowser;
    try {
      // `slowMo` spaces the actions so a person can follow the video. Without it a scripted
      // run clicks faster than the page can visibly respond, which is how a recording ends
      // up not demonstrating the very action it performed.
      browser = await pw.chromium.launch({ slowMo: SLOW_MO_MS });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!NO_BROWSER.test(message)) throw error;
      throw new PreflightError(
        `Chromium for Playwright is not installed: run \`npx playwright install chromium\`, and retry`,
      );
    }
    let context: PwContext | null = null;
    try {
      context = await browser.newContext({
        viewport: { ...VIEWPORT },
        recordVideo: { dir: path.join(dest, RAW_VIDEO_DIR), size: { ...VIEWPORT } },
        reducedMotion: 'reduce',
        ...(rootUrl === '' ? {} : { baseURL: rootUrl }),
        // Limited to the workspace origin so an identity provider or any other site a
        // workload visits never receives the workspace's basic-auth login.
        ...(credentials === undefined
          ? {}
          : {
              httpCredentials: {
                ...credentials,
                ...(rootUrl === '' ? {} : { origin: rootUrl }),
              },
            }),
      });
      const page = await context.newPage();
      return new PlaywrightDriver(
        dest,
        browser,
        context,
        page,
        [...secrets, credentials?.password ?? ''].filter((value) => value !== ''),
      );
    } catch (error) {
      try {
        await context?.close();
      } catch {
        // The browser close below is still necessary when creating a context failed halfway.
      }
      try {
        await browser.close();
      } catch {
        // Preserve the original Playwright error.
      }
      throw error;
    }
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  async click(selector: string, timeoutMs: number): Promise<void> {
    await this.page.click(selector, { timeout: timeoutMs });
  }

  async fill(selector: string, value: string, timeoutMs: number): Promise<void> {
    const knownValue = [...this.runtimeSecrets].some(
      (secret) => secret !== '' && value.includes(secret),
    );
    const credentialValue = PASSWORDISH.test(selector) && value !== '';
    if (credentialValue || knownValue) {
      // A workload can carry a credential literal which is not in the workspace record. It
      // deserves the same treatment as the recorded admin password: mask it before filling
      // and retain it only in the in-memory set that redacts the final manifest.
      if (credentialValue) this.runtimeSecrets.add(value);
      // Keep the resolved element through the fill. Re-resolving a changing selector
      // could put the value in a replacement input that has never received a cover.
      let element: PwElement | undefined;
      try {
        const deadline = Date.now() + timeoutMs;
        const remaining = (): number => {
          const milliseconds = deadline - Date.now();
          if (milliseconds <= 0) throw new Error('masked fill deadline elapsed');
          return milliseconds;
        };
        element = await this.page.locator(selector).elementHandle({ timeout: remaining() });
        await element.waitForElementState('visible', { timeout: remaining() });
        const tracked = await element.evaluate(installSecretMask, {
          color: SECRET_MASK_COLOR,
          selectors: [selector],
        });
        if (tracked === null) throw new Error('visual mask unavailable');
        // A later navigation starts a new document with no mask state. Track the selector
        // there from the first moment too, not only in the document that was filled.
        const options = { color: SECRET_MASK_COLOR, selectors: tracked };
        const script = `(${installSecretMask.toString()})(null, ${JSON.stringify(options)});`;
        if (!this.initScripts.has(script)) {
          await this.page.addInitScript({ content: script });
          this.initScripts.add(script);
        }
        this.secretTargets.add(selector);
        await element.fill(value, { timeout: remaining() });
      } catch {
        throw new PreflightError(
          `capture will not fill a known secret into '${selector}' because its visual mask or masked fill could not be completed`,
        );
      } finally {
        await element?.dispose().catch(() => undefined);
      }
      return;
    }
    await this.page.fill(selector, value, { timeout: timeoutMs });
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async waitFor(selector: string, timeoutMs: number): Promise<void> {
    await this.page.waitForSelector(selector, { timeout: timeoutMs });
  }

  async screenshot(file: string): Promise<void> {
    await this.page.screenshot({ path: file, fullPage: false });
  }

  async settle(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async banner(text: string): Promise<void> {
    await this.page.evaluate(bannerScript(text));
  }

  /**
   * The credentials the browser holds now that the run is over: every cookie value and
   * the Meteor login token. Short values are left out, because a cookie such as a locale
   * is not a secret and replacing every `en` in the log would mangle it.
   */
  private async sessionSecrets(): Promise<string[]> {
    const found: string[] = [];
    try {
      for (const cookie of await this.context.cookies()) found.push(cookie.value);
      const token = await this.page.evaluate("localStorage.getItem('Meteor.loginToken')");
      if (typeof token === 'string') found.push(token);
    } catch {
      // A page that crashed has no session to redact.
    }
    return found.filter((value) => value.length >= 8);
  }

  async finish(): Promise<Artifacts> {
    const secrets = [...new Set([...this.runtimeSecrets, ...(await this.sessionSecrets())])];
    const out: Artifacts = {
      video: null,
      secrets,
      maskedSelectors: [...this.secretTargets].sort(),
    };
    const video = this.page.video();
    try {
      await this.page.close();
    } catch {
      // Context close below still finalises a video when the page itself has already crashed.
    }
    try {
      await this.context.close(); // finalises the video file
    } catch {
      // A lost recording is reported by validation; the frames and the manifest remain.
    }
    if (video !== null) {
      try {
        await video.saveAs(path.join(this.dest, 'video.webm'));
        await video.delete();
        out.video = 'video.webm';
      } catch {
        // The validated frames remain when Playwright did not finalise the recording.
      }
    }
    try {
      await this.browser.close();
    } catch {
      // Nothing left to flush.
    }
    // This directory belongs to the driver. If saveAs failed it holds an unlisted raw video.
    // A removal failure is not swallowed into success: validation fails the capture while the
    // directory exists, and publication moves it out of the bundle.
    await fs
      .rm(path.join(this.dest, RAW_VIDEO_DIR), { recursive: true, force: true })
      .catch(() => undefined);
    return out;
  }
}

/** A Playwright-backed driver recording a video into `dest`, or a preflight refusal. */
export async function browserDriver(
  rootUrl: string,
  dest: string,
  secrets: readonly string[] = [],
  options: DriverOptions & { playwright?: PwModule } = {},
): Promise<Driver> {
  return await PlaywrightDriver.open(
    options.playwright ?? loadPlaywright(),
    rootUrl,
    dest,
    secrets,
    options.httpCredentials,
  );
}
