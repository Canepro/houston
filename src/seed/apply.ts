/** Seed through the common executor, restoring workspace settings on every exit. */
import { CreateFailedError } from '../lib/errors';
import * as config from '../lib/config';
import type { Timings } from '../perf/timings';
import { cleanup, unwindsOnInterrupt } from '../seams/exec';
import * as journal from '../core/journal';
import { type Auth, getSetting, setSetting } from '../core/rcapi';
import { DM } from './kinds';
import {
  type Made,
  type Plan,
  byKind,
  isPrivate,
  planTotalMessages,
  planTotalReplies,
} from './plan';
import { type Bag, type ParticipantLogin, map, id } from './client';
import { Receipt } from './receipt';
import { execute } from './executor';

type Log = (message: string) => void;
export interface Answer {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}
export function json(resp: Answer | null): Bag {
  if (resp === null) return {};
  try {
    const value: unknown = JSON.parse(resp.text);
    return Array.isArray(value) ? (value.length > 0 ? (value as unknown as Bag) : {}) : map(value);
  } catch {
    return {};
  }
}
export function messageId(resp: Answer | null): string | null {
  return id(map(json(resp).message)._id) || null;
}
const EMAIL_2FA = 'Accounts_TwoFactorAuthentication_By_Email_Enabled';
const RATE_LIMITER = 'API_Enable_Rate_Limiter';

export interface SeedOptions {
  readonly log?: Log;
  readonly workspace?: string;
  readonly tokensOut?: Record<string, Auth>;
  readonly adminPassword?: string;
  readonly login?: ParticipantLogin;
  readonly receipt?: Receipt;
  readonly receiptOut?: { receipt?: Receipt };
  readonly legacy?: Bag;
}

export async function seed(
  rootUrl: string,
  admin: Auth,
  plan: Plan,
  options: SeedOptions = {},
): Promise<Bag> {
  const log = options.log ?? (() => undefined);
  const receipt = options.receipt ?? new Receipt(plan);
  if (options.receiptOut !== undefined) options.receiptOut.receipt = receipt;
  const changed = new Map<string, unknown>();
  const notes = new Map<string, string>();
  const password = options.adminPassword ?? config.ADMIN_PASSWORD;
  try {
    for (const setting of [EMAIL_2FA, RATE_LIMITER, ...config.E2EE_ROOM_DEFAULT_SETTINGS]) {
      const e2ee = config.E2EE_ROOM_DEFAULT_SETTINGS.includes(setting);
      const original = receipt.done(`setting:${setting}`);
      const previous =
        original === null ? await getSetting(rootUrl, admin, password, setting) : original.value;
      if (original === null)
        receipt.record(`setting:${setting}`, 'done', { value: previous ?? null });
      if (previous !== true) {
        // An E2E setting can be absent: the force setting arrived in 8.8.0.
        if ((previous === null || previous === undefined) && !e2ee)
          log(`  ⚠ could not read ${setting}; leaving it alone`);
        continue;
      }
      changed.set(setting, previous);
      if ((options.workspace ?? '') !== '')
        notes.set(
          setting,
          e2ee
            ? journal.record(journal.E2EE_DEFAULT_OFF, options.workspace as string, { setting })
            : journal.record(
                setting === EMAIL_2FA ? journal.EMAIL_2FA_OFF : journal.RATE_LIMITER_OFF,
                options.workspace as string,
                { purpose: 'a seed' },
              ),
        );
      receipt.record(`quiesce:${setting}`, 'intent', { value: false });
      if (!(await setSetting(rootUrl, admin, password, setting, false))) {
        log(`  ⚠ could not confirm disabling ${setting}; its prior value will still be restored`);
        continue;
      }
      receipt.record(`quiesce:${setting}`, 'done', { value: false });
    }
    const execution = await unwindsOnInterrupt(
      async () => await execute(rootUrl, admin, receipt, plan, options, log),
    );
    const summary = result(
      plan,
      execution.made,
      execution.names,
      execution.durations,
      execution.timings,
      log,
    );
    summary.run_id = receipt.manifest.run;
    summary.users_failed = execution.usersFailed;
    summary.scenarios = plan.scenarios;
    summary.custom_emoji = plan.customEmoji;
    summary.files = [...receipt.entries.values()].filter(
      (e) => e.state === 'done' && e.key.startsWith('message:') && e.data.kind === 'file',
    ).length;
    summary.total_content = [...receipt.entries.values()].filter(
      (e) => e.state === 'done' && /^(message|opening):/u.test(e.key),
    ).length;
    return summary;
  } finally {
    await cleanup(async () => {
      const failures: unknown[] = [];
      for (const [setting, previous] of changed) {
        try {
          receipt.record(`restore:${setting}`, 'intent', { value: previous });
        } catch (error) {
          failures.push(error);
        }
        try {
          if (!(await setSetting(rootUrl, admin, password, setting, previous)))
            throw new CreateFailedError(
              `seed could not restore ${setting}; its recovery receipt remains active`,
            );
          if (receipt.intent(`quiesce:${setting}`) !== null)
            receipt.record(`quiesce:${setting}`, 'rejected', { restored: true });
          receipt.record(`restore:${setting}`, 'done', { value: previous });
          journal.clear(notes.get(setting) ?? '');
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    });
  }
}

export function result(
  plan: Plan,
  made: Map<string, Made>,
  names: readonly string[],
  durations: Record<string, number>,
  latency: Timings,
  log: Log,
): Bag {
  const rooms = [...made.values()];
  const created = rooms.filter((r) => r.rid !== '' && r.failed === '');
  const messages = rooms.reduce((n, r) => n + r.messages + r.replies, 0);
  const threads = rooms.reduce((n, r) => n + r.replies, 0);
  const kinds: Record<string, number> = {};
  for (const r of created) kinds[r.spec.kind] = (kinds[r.spec.kind] ?? 0) + 1;
  log(`messages: ${messages} (${threads} in threads)`);
  return {
    users: names.length,
    channels: created.filter((r) => r.spec.kind === 'channel').length,
    messages,
    dms: created.filter((r) => r.spec.kind === DM).length,
    durations,
    latency: latency.summary(),
    latency_hist: latency.histogram(),
    profile: plan.profile,
    rooms: kinds,
    rooms_total: created.length,
    threads,
    reactions: rooms.reduce((n, r) => n + r.reactions, 0),
    reused: created.filter((r) => r.reused).length,
    failed: rooms.filter((r) => r.failed !== '').map((r) => ({ name: r.spec.name, why: r.failed })),
    planned: {
      rooms: byKind(plan),
      rooms_total: plan.rooms.length,
      messages: planTotalMessages(plan),
      threads: planTotalReplies(plan),
      users: plan.users,
      thread_parents: plan.rooms.reduce((n, r) => n + r.threads.length, 0),
      files: plan.rooms.reduce((n, r) => n + r.files.length, 0),
      reaction_actions: plan.rooms.reduce(
        (n, r) => n + r.content.reduce((m, c) => m + c.reactions.length, 0),
        0,
      ),
      pins: plan.rooms.reduce((n, r) => n + r.content.filter((c) => c.pin).length, 0),
      stars: plan.rooms.reduce((n, r) => n + r.content.filter((c) => c.star !== '').length, 0),
      mentions: plan.rooms.reduce(
        (n, r) => n + r.content.filter((c) => c.mention !== '').length,
        0,
      ),
      edits: plan.rooms.reduce(
        (n, r) => n + r.content.filter((c) => c.editedText !== '').length,
        0,
      ),
    },
    created: created.map((r) => ({
      kind: r.spec.kind,
      name: r.spec.name,
      rid: r.rid,
      parent: r.spec.parent,
      private: isPrivate(r.spec),
      messages: r.messages,
      replies: r.replies,
      reused: r.reused,
      participants: r.spec.members,
      team_id: r.teamId,
      starred_by: [...new Set(r.spec.content.map((c) => c.star).filter((name) => name !== ''))],
      files: r.spec.files,
    })),
  };
}
