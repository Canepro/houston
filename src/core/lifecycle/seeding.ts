/**
 * Seeding a workspace through REST, and checking that what was asked for arrived.
 *
 * Tier 3. `runSeedInline` takes the repro lock -- it was the ONLY mutating operation that did
 * not, and a seed running into a backup's quiesce fails mid-manifest and reports faults
 * nobody caused. Reentrant, so `up --seed` is unaffected.
 */
import { ConflictError, NotReadyError, ValidationError } from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { ResourceMonitor } from '../../perf/resources';
import { seed as runSeed } from '../../seed/apply';
import { type Plan, planFrom } from '../../seed/plan';
import { type Facts, readback, verify } from '../../seed/check';
import { Receipt, pendingReceipt } from '../../seed/receipt';
import { applyHistory, verifyHistory } from '../../seed/history';
import { verifyBatch } from '../../seed/verification';
import type { PlanOverrides } from '../../seed/plan';
import { seedDatabase, type SeedDatabase } from '../seed-db';
import { CREATE_UNFINISHED, clearKind } from '../journal';
import { adminPass, type Metadata, updateMeta } from '../runner/record';
import { reproLock } from '../runner/locks';

import { login } from './admin';
import { INTERACTIVE_LOCK_WAIT } from './types';

type Bag = Record<string, unknown>;

/**
 * Read the seeded workspace back, compare it with the manifest, and record it.
 *
 * Both front-ends call this, because both had the same hole: the seed summary was what
 * the seeder ASKED for, and nothing anywhere checked it. `messages: ~62` -- the tilde was
 * the tool admitting it did not know.
 *
 * REPORTS, it does not refuse. A mismatch is written into the result and warned about;
 * whether that ends the command is the caller's decision and the default is that it does
 * not. The version of this idea that shipped elsewhere gated on exact equality over a
 * seeder that was losing every thread reply, so `up --seed` failed on a healthy
 * workspace -- and a check that fails when nothing is wrong is one people learn to
 * bypass.
 *
 * The verification is persisted into `repro.json` either way.
 */
export async function checkSeed(
  meta: Metadata,
  auth: { token: string; userId: string },
  plan: Plan,
  result: Bag,
  emit: Emit = nullEmit,
  tokens: Record<string, { token: string; userId: string }> = {},
  receipt?: Receipt,
  database?: SeedDatabase,
): Promise<Bag> {
  let verdict: ReturnType<typeof verify>;
  try {
    if (receipt !== undefined) {
      verdict = await verifyBatch(meta.rootUrl, auth, plan, receipt, tokens, result);
      if (database !== undefined) {
        try {
          const history = await verifyHistory(receipt, database);
          const faults = Array.isArray(history.faults)
            ? (history.faults as typeof verdict.faults)
            : [];
          verdict = {
            ...verdict,
            faults: [...verdict.faults, ...faults],
            ok: faults.length > 0 ? false : verdict.ok,
          };
        } catch (error) {
          verdict = {
            ...verdict,
            unreadable: [
              ...verdict.unreadable,
              { what: 'historical metadata', why: errorText(error) },
            ],
            ok: verdict.ok === false ? false : null,
          };
        }
      }
    } else {
      const facts: Facts = await readback(meta.rootUrl, auth, plan, { tokens });
      verdict = verify(plan, facts);
    }
  } catch (error) {
    // A check must never break the seed.
    warn(emit, `could not read the seed back: ${errorText(error)}`, { phase: 'seed' });
    // `why` travels with the verdict, so a caller rendering from the RETURN VALUE can say
    // what went wrong without also subscribing to the events.
    verdict = {
      ok: null,
      faults: [],
      extra: [],
      unreadable: [{ what: 'seed', why: errorText(error) }],
      checked: 0,
      rooms: [],
    };
    result.verification_why = errorText(error);
  }
  result.verification = {
    ok: verdict.ok,
    faults: verdict.faults,
    extra: verdict.extra,
    unreadable: verdict.unreadable,
    checked: verdict.checked,
    ...(result.verification_why === undefined ? {} : { why: result.verification_why }),
    ...('checks_completed' in verdict
      ? {
          checks_completed: verdict.checks_completed,
          features: 'features' in verdict ? verdict.features : {},
        }
      : {}),
  };
  result.readback = verdict.rooms;
  if (receipt !== undefined)
    receipt.record('verification:latest', 'done', result.verification as Bag);
  if (verdict.faults.length > 0) {
    warn(
      emit,
      `seed readback found ${String(verdict.faults.length)} mismatch(es): ` +
        verdict.faults
          .slice(0, 3)
          .map(
            (fault) =>
              `${fault.room || 'users'} wanted ${String(fault.want)}, found ${String(fault.got)}`,
          )
          .join('; '),
      { phase: 'seed' },
    );
  } else if (verdict.extra.length > 0) {
    info(
      emit,
      `readback: ${String(verdict.extra.length)} room(s) hold more than this run ` +
        'planned — they had content already (a re-seed, a preset, a restore)',
      { phase: 'seed' },
    );
  } else if (verdict.unreadable.length > 0) {
    warn(
      emit,
      `${String(verdict.unreadable.length)} room(s) could not be read back — ` +
        'not counted as a fault',
      { phase: 'seed' },
    );
  } else {
    info(emit, `readback: ${String(verdict.checked)} rooms match the plan`, { phase: 'seed' });
  }
  try {
    await updateMeta(meta.name, (current) => {
      current.extra.seed = {
        profile: plan.profile,
        planned: result.planned ?? {},
        // EVERY KEY IS WRITTEN, with `null` for a value this run did not report, as the
        // record has always carried them, and `JSON.stringify` drops a property whose value
        // is `undefined` -- so a partial result produced a record with fewer keys than the
        // established one, which a key-presence comparison of the two records reads as a
        // different document.
        actual: {
          users: result.users ?? null,
          rooms: result.rooms ?? null,
          rooms_total: result.rooms_total ?? null,
          messages: result.messages ?? null,
          threads: result.threads ?? null,
          dms: result.dms ?? null,
        },
        verification: result.verification,
        scenarios: plan.scenarios,
        history: result.history ?? null,
        run_id: result.run_id ?? null,
        features: {
          files: result.files ?? 0,
          total_content: result.total_content ?? null,
          custom_emoji: result.custom_emoji ?? [],
        },
        locations: result.created ?? [],
        at: new Date().toISOString().slice(0, 19) + '+00:00',
      };
    });
  } catch {
    warn(
      emit,
      'seed verification could not be projected into workspace metadata; consult the durable seed receipt',
      { phase: 'seed' },
    );
  }
  return {
    ...verdict,
    ...(result.verification_why === undefined ? {} : { why: result.verification_why }),
  } as unknown as Bag;
}

/** One prepared driver, used by CLI, GUI, creation and readiness recovery. */
export async function seedPrepared(
  meta: Metadata,
  auth: { token: string; userId: string },
  plan: Plan,
  emit: Emit,
  tokens: Record<string, { token: string; userId: string }>,
  log?: (message: string) => void,
): Promise<Bag> {
  const target = JSON.stringify({
    runtime: meta.extra.runtime ?? 'docker',
    project: meta.project,
    namespace: meta.extra.namespace ?? null,
    context: meta.extra.context ?? null,
    admin: auth.userId,
  });
  // Database resolution and write privilege checks precede all historical API mutations.
  const database = plan.historyDays === null ? null : await seedDatabase(meta, auth.userId);
  const receipt = new Receipt(plan, target, meta.name);
  if (database !== null) {
    const prior = receipt.done('database:target');
    if (prior !== null && prior.target !== database.target)
      throw new ValidationError('unfinished historical seed has a different database target');
    receipt.record('database:target', 'done', { target: database.target });
  }
  const report = log ?? ((message: string) => info(emit, message.trim(), { phase: 'seed' }));
  const summary = await runSeed(meta.rootUrl, auth, plan, {
    tokensOut: tokens,
    adminPassword: adminPass(meta),
    workspace: meta.name,
    receipt,
    log: report,
    ...(typeof meta.extra.seed === 'object' && meta.extra.seed !== null
      ? { legacy: meta.extra.seed as Bag }
      : {}),
  });
  if (
    database !== null &&
    ((Array.isArray(summary.failed) && summary.failed.length > 0) ||
      (Array.isArray(summary.users_failed) && summary.users_failed.length > 0) ||
      [...receipt.entries.values()].some(
        (entry) =>
          entry.state === 'intent' &&
          !entry.key.startsWith('history:') &&
          !entry.key.startsWith('probe:'),
      ))
  )
    throw new ValidationError(
      'historical seed API creation is incomplete; resume the same run before assigning dates',
    );
  if (database !== null) summary.history = await applyHistory(plan, receipt, database, report);
  await checkSeed(
    meta,
    auth,
    plan,
    summary,
    emit,
    tokens,
    typeof summary.run_id === 'string' ? receipt : undefined,
    database ?? undefined,
  );
  if ([...receipt.entries.values()].some((entry) => entry.state === 'intent'))
    throw new ValidationError(
      'seed has unresolved operations; its recovery receipt remains active',
    );
  receipt.finish();
  return summary;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function seedInlineLocked(
  meta: Metadata,
  profile: string,
  stats: boolean,
  emit: Emit,
  overrides: PlanOverrides = {},
): Promise<Bag> {
  let auth;
  try {
    auth = await login(meta);
  } catch (error) {
    throw new NotReadyError(`can't seed - repro not ready: ${errorText(error)}`);
  }
  let plan: Plan;
  try {
    plan = planFrom(profile, overrides);
  } catch (error) {
    throw new ValidationError(errorText(error));
  }
  info(emit, `seeding (profile ${profile})`, { phase: 'seed' });
  const mon = stats ? new ResourceMonitor(meta.name).start() : null;
  const t0 = Date.now();
  const tokens: Record<string, { token: string; userId: string }> = {};
  let summary: Bag;
  const paused = {
    resources: null as Awaited<ReturnType<ResourceMonitor['stop']>> | null,
  };
  try {
    summary = await seedPrepared(meta, auth, plan, emit, tokens);
  } finally {
    if (mon !== null) paused.resources = await mon.stop();
  }
  summary.total_s = (Date.now() - t0) / 1000;
  if (paused.resources !== null) summary.resources_keys = Object.keys(paused.resources).sort();
  return summary;
}

/**
 * Seed a workspace through REST, serialised like every other mutating operation.
 *
 * IT WAS THE ONLY ONE THAT WAS NOT. `createRepro`, `setState`, `teardown`, `setEnv`,
 * `monitor.attach`, `backup.create`, `upgrade.run`, `runScale` and `clearScale` all take
 * the lock; a seed writes the same collections through a different door and took nothing.
 *
 * Reentrant, so the `up --seed` path is unaffected: `createRepro` already holds this lock
 * and re-entering it is free.
 */
export async function runSeedInline(
  meta: Metadata,
  profile: string,
  stats: boolean,
  emit: Emit,
  overrides: PlanOverrides = {},
  expectedRun?: string,
  resumeIf?: () => Promise<boolean>,
): Promise<Bag> {
  return await reproLock(
    meta.name,
    async () => {
      if (expectedRun !== undefined) {
        const pending = pendingReceipt(meta.name);
        if (pending === null) return { resumed: false };
        if (pending.run !== expectedRun)
          throw new ConflictError('the pending seed changed while waiting for its workspace lock');
      }
      if (resumeIf !== undefined && !(await resumeIf())) return { resumed: false };
      const result = await seedInlineLocked(meta, profile, stats, emit, overrides);
      // A second ready waiter must not see the same abandoned request after a
      // completed recovery, even if its optional metadata projection was unwritable.
      if (resumeIf !== undefined) clearKind(CREATE_UNFINISHED, meta.name);
      return result;
    },
    {
      timeoutMs: INTERACTIVE_LOCK_WAIT * 1000,
    },
  );
}
