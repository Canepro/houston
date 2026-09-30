/**
 * Data-population services shared by the CLI and web API: bulk `--scale` prefill,
 * clear-scale, and config-import (dry-run plan + apply).
 *
 * Functions raise `lib/errors` types and report progress via `emit`.
 */
import { type Plan, apply, buildPlan } from './configimport';
import { DockerError, NotReadyError, ValidationError, errorText } from '../lib/errors';
import { type Emit, info, nullEmit, warn } from '../lib/events';
import { quotedText, splitTextLines, toTextAny, stripText, isTruthy } from '../lib/format';
import { shownLoaded } from '../lib/json-text';

import { login } from './lifecycle/admin';
import { resolveName } from './lifecycle/naming';
import { INTERACTIVE_LOCK_WAIT } from './lifecycle/types';
import { bulkMessages, bulkUsers, clear, parseScale } from './scaleseed';
import { adminPass, readMeta } from './runner/record';
import { reproLock } from './runner/locks';
import * as topology from './topology';

type Bag = Record<string, unknown>;

// --- scale --------------------------------------------------------------------

/** `n` with a comma between each group of three digits: `1,234,567`. */
function withCommas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** Last JSON line from a scaleseed mongosh run (banners may precede it). */
export function scaleResult(out: string | null | undefined): Bag | null {
  // `stripText`, not `String.trim()`: it also strips the C0 information separators and NEL,
  // and this parser's own corpus carries a U+2028 line separator.
  const lines = splitTextLines(stripText(String(out ?? '')));
  for (const raw of [...lines].reverse()) {
    const line = stripText(raw);
    if (line.startsWith('{')) {
      try {
        return JSON.parse(line) as Bag;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Validate a scaleseed result: non-zero exit / no JSON => hard fail (Docker); a JS-level
 * `{error}` payload (e.g. room-not-found) => a user error.
 */
export function scaleOk(
  rc: number,
  out: string | null | undefined,
  what: string,
  { hint = '' }: { hint?: string } = {},
): Bag {
  const res = scaleResult(out);
  // An EMPTY result object means the same "there was no result" as no JSON at all.
  // `res === null` alone accepted `{}` and reported "inserted 0" for a run that failed;
  // measured against the previous implementation.
  if (rc !== 0 || res === null || Object.keys(res).length === 0) {
    throw new DockerError(
      `${what} failed (is mongodb up?): ${stripText(String(out ?? '')).slice(0, 200)}`,
    );
  }
  if (isTruthy(res.error)) {
    throw new ValidationError(
      `${what} failed: ${toTextAny(res.error)}` + (hint ? ` - ${hint}` : ''),
    );
  }
  return res;
}

/** Bulk-insert users/messages per a `--scale` spec (users=N,messages=N@room). */
export async function runScale(name: string, specStr: string, emit: Emit = nullEmit): Promise<Bag> {
  const target = await resolveName(name);
  // COMPOSE ONLY, said here rather than discovered two layers down. `scaleseed`
  // bulk-inserts through `composeExecCapture`, so on a Kubernetes workspace this
  // reached for a compose project that is not there and answered "no configuration
  // file provided: not found" -- docker's words for something the reader cannot act on.
  // The REST seed above it is runtime-agnostic; only the bulk path is not.
  await topology.requireCompose(target, '--scale prefill', {
    instead:
      `Seed over REST instead (\`houston seed --name ${target}\`), which works on ` +
      'both runtimes.',
  });
  // Bulk prefill writes straight into Mongo; running it while a backup is dumping would
  // put half of it in the archive.
  return await reproLock(target, async () => await runScaleLocked(target, specStr, emit));
}

export async function runScaleLocked(
  target: string,
  specStr: string,
  emit: Emit = nullEmit,
): Promise<Bag> {
  let spec: { users?: number; messages?: [number, string] };
  try {
    spec = parseScale(specStr);
  } catch (exc) {
    throw new ValidationError(errorText(exc));
  }
  if (spec.users === undefined && spec.messages === undefined) {
    throw new ValidationError('scale had nothing to do (want users=N and/or messages=N@room)');
  }
  warn(
    emit,
    'bulk Mongo prefill: users are credential-less and messages fire no ' +
      'app hooks - for scale/perf repros, not feature testing.',
    { phase: 'seed' },
  );
  const result: Bag = {};
  if (spec.users !== undefined) {
    info(emit, `inserting ${withCommas(spec.users)} users`, { phase: 'seed' });
    const [rc, out] = await bulkUsers(target, spec.users);
    const res = scaleOk(rc, out, 'user prefill');
    result.users = res.inserted ?? 0;
    info(emit, `inserted ${withCommas(Number(result.users))} users`, { phase: 'seed' });
  }
  if (spec.messages !== undefined) {
    const [n, room] = spec.messages;
    info(emit, `inserting ${withCommas(n)} messages into ${quotedText(room)}`, {
      phase: 'seed',
    });
    const [rc, out] = await bulkMessages(target, n, room);
    const res = scaleOk(rc, out, 'message prefill', {
      hint: 'create the room first (REST seed, or use `general`)',
    });
    result.messages = res.inserted ?? 0;
    result.room = room;
    info(
      emit,
      `inserted ${withCommas(Number(result.messages))} messages into ${quotedText(room)}`,
      {
        phase: 'seed',
      },
    );
  }
  return result;
}

/** Remove everything a prior `--scale` added and restore affected rooms. */
export async function clearScale(name: string, emit: Emit = nullEmit): Promise<Bag> {
  const target = await resolveName(name);
  // COMPOSE ONLY, said here rather than discovered two layers down -- see `runScale`.
  await topology.requireCompose(target, '--scale prefill', {
    instead:
      `Seed over REST instead (\`houston seed --name ${target}\`), which works on ` +
      'both runtimes.',
  });
  // Locked like `runScale`, which it undoes. Without it the two could interleave on one
  // workspace -- a clear deleting the users a concurrent prefill is still inserting,
  // leaving a count that matches neither.
  return await reproLock(
    target,
    async () => {
      const res = scaleOk(...(await clear(target)), 'clear');
      const out = {
        users: res.users ?? 0,
        messages: res.messages ?? 0,
        rooms: res.rooms ?? 0,
      };
      info(
        emit,
        `removed ${withCommas(Number(out.users))} scale users and ` +
          `${withCommas(Number(out.messages))} scale messages`,
        { phase: 'done' },
      );
      return out;
    },
    { timeoutMs: INTERACTIVE_LOCK_WAIT * 1000 },
  );
}

// --- config-import ------------------------------------------------------------

/**
 * `configimport.buildPlan`, with the file-reading failures it refuses.
 *
 * A bad value or bad JSON is refused, and an OS error — a missing or unreadable path —
 * propagates untouched; a caller asking for a file that is
 * not there gets the filesystem's own answer, not "couldn't read settings file". The
 * check on `code` reproduces that split: only a JSON/semantic fault becomes a
 * ValidationError.
 */
export function buildThePlan(settingsPath: string, only: ReadonlySet<string> | null): Plan {
  try {
    return buildPlan(settingsPath, { only });
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
    throw new ValidationError(`couldn't read settings file: ${String((error as Error).message)}`);
  }
}

/**
 * `shownLoaded(value)`, truncated to the width the plan summary shows.
 *
 * Of what `loads` built, so a float keeps its `.0` and an object its document order:
 * a bare JSON read printed a dump's `5.0` as `5`, `-0.0` as `0` and `[1.0, null]` as
 * `[1, null]`.
 */
export function shownPlanValue(value: unknown): string {
  const s = shownLoaded(value);
  // Counted in CODE POINTS: a value holding an emoji is one character and two UTF-16
  // units, and the cut would land one place later.
  const points = [...s];
  return points.length <= 80 ? s : `${points.slice(0, 80).join('')}...`;
}

/** Dry-run: parse a support-dump *-settings.json into an import plan summary. */
export async function importPlan(
  name: string,
  settingsPath: string,
  only: ReadonlySet<string> | null = null,
): Promise<Bag> {
  await resolveName(name);
  const plan = buildThePlan(settingsPath, only);
  return {
    apply: plan.apply.map(([sid, value]) => ({ id: sid, value: shownPlanValue(value) })),
    redacted: plan.redacted,
    denied: plan.denied,
    oauth_services: plan.oauthServices,
    counts: {
      apply: plan.apply.length,
      redacted: plan.redacted.length,
      denied: plan.denied.length,
    },
  };
}

/** Apply the plan built from `settingsPath` to the repro's live settings. */
export async function importApply(
  name: string,
  settingsPath: string,
  only: ReadonlySet<string> | null = null,
  emit: Emit = nullEmit,
): Promise<Bag> {
  const target = await resolveName(name);
  // LOCKED, like `runScale` and the REST seed. This is the other data-mutating
  // operation and it had neither a lock nor a job pool: two imports on one workspace
  // could interleave setting by setting, and one running into a backup's `Quiesced` --
  // which STOPS Rocket.Chat for the dump -- fails half-applied, leaving settings that
  // match neither the dump nor the workspace.
  return await reproLock(
    target,
    async () => await importApplyLocked(target, settingsPath, only, emit),
    { timeoutMs: INTERACTIVE_LOCK_WAIT * 1000 },
  );
}

export async function importApplyLocked(
  name: string,
  settingsPath: string,
  only: ReadonlySet<string> | null = null,
  emit: Emit = nullEmit,
): Promise<Bag> {
  const m = await readMeta(await resolveName(name));
  const plan = buildThePlan(settingsPath, only);
  let auth;
  try {
    auth = await login(m);
  } catch (exc) {
    throw new NotReadyError(`can't import - repro not ready: ${errorText(exc)}`);
  }
  const res = await apply(m.rootUrl, auth, plan, {
    workspace: m.name,
    adminPassword: adminPass(m),
    log: (line) => {
      // `stripText` on every line the applier reports.
      info(emit, stripText(line), { phase: 'config' });
    },
  });
  info(
    emit,
    `imported ${String(res.applied)} setting(s), skipped ${String(res.skipped)}` +
      (res.failed ? `; ${String(res.failed)} rejected` : ''),
    { phase: 'done' },
  );
  return { ...res };
}
