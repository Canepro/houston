/**
 * Seeding a workspace through REST, and checking that what was asked for arrived.
 *
 * Tier 3. `runSeedInline` takes the repro lock -- it was the ONLY mutating operation that did
 * not, and a seed running into a backup's quiesce fails mid-manifest and reports faults
 * nobody caused. Reentrant, so `up --seed` is unaffected.
 */
import { NotReadyError, ValidationError } from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { ResourceMonitor } from '../../perf/resources';
import { seed as runSeed } from '../../seed/apply';
import { type Plan, planFrom } from '../../seed/plan';
import { type Facts, readback, verify } from '../../seed/check';
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
): Promise<Bag> {
  let verdict: ReturnType<typeof verify>;
  try {
    const facts: Facts = await readback(meta.rootUrl, auth, plan, { tokens });
    verdict = verify(plan, facts);
  } catch (error) {
    // A check must never break the seed.
    warn(emit, `could not read the seed back: ${errorText(error)}`, { phase: 'seed' });
    // `why` travels with the verdict, so a caller rendering from the RETURN VALUE can say
    // what went wrong without also subscribing to the events.
    return { ok: null, why: errorText(error), faults: [], unreadable: [], checked: 0, rooms: [] };
  }
  result.verification = {
    ok: verdict.ok,
    faults: verdict.faults,
    extra: verdict.extra,
    unreadable: verdict.unreadable,
    checked: verdict.checked,
  };
  result.readback = verdict.rooms;
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
        at: new Date().toISOString().slice(0, 19) + '+00:00',
      };
    });
  } catch {
    // A record is not worth failing a good seed.
  }
  return verdict as unknown as Bag;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function seedInlineLocked(
  meta: Metadata,
  profile: string,
  stats: boolean,
  emit: Emit,
): Promise<Bag> {
  let auth;
  try {
    auth = await login(meta);
  } catch (error) {
    throw new NotReadyError(`can't seed - repro not ready: ${errorText(error)}`);
  }
  let plan: Plan;
  try {
    plan = planFrom(profile);
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
    summary = await runSeed(meta.rootUrl, auth, plan, {
      tokensOut: tokens,
      adminPassword: adminPass(meta),
      workspace: meta.name,
      log: (message) => info(emit, message.trim(), { phase: 'seed' }),
    });
  } finally {
    if (mon !== null) paused.resources = await mon.stop();
  }
  summary.total_s = (Date.now() - t0) / 1000;
  if (paused.resources !== null) summary.resources_keys = Object.keys(paused.resources).sort();
  await checkSeed(meta, auth, plan, summary, emit, tokens);
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
): Promise<Bag> {
  return await reproLock(
    meta.name,
    async () => await seedInlineLocked(meta, profile, stats, emit),
    {
      timeoutMs: INTERACTIVE_LOCK_WAIT * 1000,
    },
  );
}
