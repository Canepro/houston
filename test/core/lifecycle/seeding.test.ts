import { nullEmit } from '../../../src/lib/events';
import { type Facts } from '../../../src/seed/check';
import { READ_ONLY } from '../../../src/seed/kinds';
import { planFrom, reacted, replies, roomFacts, totalMessages } from '../../../src/seed/plan';
import { username } from '../../../src/seed/wording';
import { metadata, readMeta, writeRecord } from '../../../src/core/runner/record';

import type * as SeedingNS from '../../../src/core/lifecycle/seeding';
import type * as ReceiptNS from '../../../src/seed/receipt';
import type * as LocksNS from '../../../src/core/runner/locks';
import type * as ApplyNS from '../../../src/seed/apply';
import type { SeedDatabase } from '../../../src/core/seed-db';
import type { DateChange } from '../../../src/seed/history';

describe('reading a seed back', () => {
  afterEach(() => jest.resetModules());

  async function writeFixture(name = 'w'): Promise<void> {
    await writeRecord(name, metadata({ name, project: `houston-${name}`, rcVersion: '8.5.1' }));
  }

  it('persists incomplete verification when every required readback is unavailable', async () => {
    await writeFixture();
    const plan = planFrom('small');
    const facts: Facts = {
      rooms: plan.rooms.map((spec) => ({ ...roomFacts(spec), unreadable: 'HTTP 500' })),
      users_found: [],
      users_unreadable: 'HTTP 500',
      planned_users: Array.from({ length: plan.users }, (_, i) => username(i)),
    };
    jest.resetModules();
    jest.doMock('../../../src/seed/check', () => ({
      ...jest.requireActual('../../../src/seed/check'),
      readback: async () => facts,
    }));
    const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
    const result: Record<string, unknown> = {};
    const verdict = await seeding.checkSeed(
      await readMeta('w'),
      { token: 't', userId: 'u' },
      plan,
      result,
      nullEmit,
    );
    expect(verdict.ok).toBeNull();
    expect(verdict.checked).toBe(0);
    expect(result.verification).toEqual(expect.objectContaining({ ok: null, checked: 0 }));
    const saved = (await readMeta('w')).extra.seed as Record<string, unknown>;
    expect(saved.verification).toEqual(expect.objectContaining({ ok: null, checked: 0 }));
  });

  it('reports and persists a readback that could not run without breaking the seed', async () => {
    await writeFixture();
    jest.resetModules();
    jest.doMock('../../../src/seed/check', () => ({
      ...jest.requireActual('../../../src/seed/check'),
      readback: async () => {
        throw new Error('boom');
      },
    }));
    const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
    const result: Record<string, unknown> = { planned: { rooms: 1 } };
    const events: { message: string; level: string }[] = [];
    const verdict = await seeding.checkSeed(
      await readMeta('w'),
      { token: 't', userId: 'u' },
      planFrom('small'),
      result,
      (event) => events.push(event),
    );
    expect(verdict).toEqual(expect.objectContaining({ ok: null, why: 'boom', checked: 0 }));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'warn', message: 'could not read the seed back: boom' }),
      ]),
    );
    expect(result.verification).toEqual(
      expect.objectContaining({ ok: null, why: 'boom', checked: 0 }),
    );
    const saved = (await readMeta('w')).extra.seed as Record<string, unknown>;
    expect(saved.verification).toEqual(
      expect.objectContaining({ ok: null, why: 'boom', checked: 0 }),
    );
  });

  it('preserves legacy actual-summary keys with nulls when the seeder omitted their values', async () => {
    await writeFixture();
    const plan = planFrom('small');
    const users = Array.from({ length: plan.users }, (_, i) => username(i));
    const facts: Facts = {
      rooms: plan.rooms.map((spec) => ({
        ...roomFacts(spec),
        found: true,
        rid: `rid-${spec.name}`,
        messages: totalMessages(spec),
        replies: replies(spec),
        reacted: reacted(spec),
        threads: spec.threads.length,
      })),
      users_found: users,
      users_unreadable: '',
      planned_users: users,
    };
    jest.resetModules();
    jest.doMock('../../../src/seed/check', () => ({
      ...jest.requireActual('../../../src/seed/check'),
      readback: async () => facts,
    }));
    const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
    const result: Record<string, unknown> = { planned: { rooms: 1 } };
    const verdict = await seeding.checkSeed(
      await readMeta('w'),
      { token: 't', userId: 'u' },
      plan,
      result,
      nullEmit,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBe(plan.rooms.length);
    const saved = (await readMeta('w')).extra.seed as Record<string, unknown>;
    expect(saved.profile).toBe('small');
    expect(saved.actual).toEqual(
      expect.objectContaining({
        dms: null,
        messages: null,
        rooms: null,
        rooms_total: null,
        threads: null,
        users: null,
      }),
    );
    expect(saved.verification).toEqual(
      expect.objectContaining({ ok: true, checked: plan.rooms.length }),
    );
    expect(saved.at).toEqual(expect.any(String));
  });

  it('does not append a new batch when a pending recovery completed before acquiring its lock', async () => {
    await writeFixture();
    const plan = planFrom('small');
    jest.resetModules();
    const Receipt = (require('../../../src/seed/receipt') as typeof ReceiptNS).Receipt;
    const prior = new Receipt(plan, 'database-identity', 'w');
    const expectedRun = prior.manifest.run;
    prior.finish();
    const login = jest.fn(async () => ({ token: 't', userId: 'u' }));
    const seed = jest.fn(async () => ({}));
    jest.doMock('../../../src/core/lifecycle/admin', () => ({ login }));
    jest.doMock('../../../src/seed/apply', () => ({ seed }));
    jest.doMock('../../../src/seed/check', () => ({
      ...jest.requireActual('../../../src/seed/check'),
      readback: async () => ({
        rooms: [],
        users_found: [],
        users_unreadable: 'unneeded for completed recovery',
        planned_users: [],
      }),
    }));
    const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
    await expect(
      seeding.runSeedInline(await readMeta('w'), 'small', false, nullEmit, {}, expectedRun),
    ).resolves.toEqual({ resumed: false });
    expect(login).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it('checks abandoned create recovery again inside the workspace lock before starting a batch', async () => {
    await writeRecord(
      'w',
      metadata({
        name: 'w',
        project: 'houston-w',
        rcVersion: '8.5.1',
        extra: { seed: { profile: 'small' } },
      }),
    );
    jest.resetModules();
    const login = jest.fn(async () => ({ token: 't', userId: 'u' }));
    const seed = jest.fn(async () => ({}));
    jest.doMock('../../../src/core/lifecycle/admin', () => ({ login }));
    jest.doMock('../../../src/seed/apply', () => ({ seed }));
    jest.doMock('../../../src/seed/check', () => ({
      ...jest.requireActual('../../../src/seed/check'),
      readback: async () => ({
        rooms: [],
        users_found: [],
        users_unreadable: 'unneeded for completed recovery',
        planned_users: [],
      }),
    }));
    const locks = require('../../../src/core/runner/locks') as typeof LocksNS;
    const resumeIf = jest.fn(async () => {
      expect(locks.heldBy('w')).toBe(true);
      return (await readMeta('w')).extra.seed === undefined;
    });
    const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
    await expect(
      seeding.runSeedInline(await readMeta('w'), 'small', false, nullEmit, {}, undefined, resumeIf),
    ).resolves.toEqual({ resumed: false });
    expect(resumeIf).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it.each(['failed rooms', 'failed users', 'unresolved intent'])(
    'defers history for %s and dates the complete captured batch after a same-run API resume',
    async (failure) => {
      const name = `history-partial-${failure.replaceAll(' ', '-')}`;
      await writeFixture(name);
      jest.resetModules();
      const base = planFrom('small', { users: 2, messages: 2, historyDays: 180 });
      const original = base.rooms.find((r) => r.name === 'team-chat')!;
      const spec = {
        ...original,
        threads: [],
        replyCount: 0,
        reactions: [],
        files: [],
        content: original.content
          .filter((item) => item.kind === 'main')
          .map((item) => ({
            ...item,
            reactions: [],
            pin: false,
            star: '',
            mention: '',
            editedText: '',
          })),
      };
      const plan = { ...base, customEmoji: [], rooms: [spec] };
      const receipts: ReceiptNS.Receipt[] = [];
      const packets: DateChange[][] = [];
      let complete = false;
      const database: SeedDatabase = {
        target: 'history-database',
        assertTarget: jest.fn(async () => undefined),
        run: jest.fn(async (script) => {
          const receipt = receipts.at(-1)!;
          if (script.startsWith('var ids='))
            return {
              messages: [...receipt.entries.values()]
                .filter((entry) => entry.state === 'done' && entry.key.startsWith('message:'))
                .map((entry) => ({
                  id: entry.data.id,
                  rid: entry.data.rid,
                  userId: entry.data.userId,
                  ts: entry.data.ts,
                })),
              anchors: {},
            };
          const match = /^var changes=(.*?);var now=/su.exec(script);
          if (match !== null) {
            const packet = JSON.parse(match[1] as string) as DateChange[];
            packets.push(packet);
            return { ok: true, count: packet.length };
          }
          return script.startsWith('var faults=')
            ? { ok: true, faults: [], checked: packets.flat().length }
            : { ok: true };
        }),
      };
      jest.doMock('../../../src/core/seed-db', () => ({ seedDatabase: async () => database }));
      jest.doMock('../../../src/seed/verification', () => ({
        verifyBatch: async () => ({
          ok: true,
          faults: [],
          extra: [],
          unreadable: [],
          checked: 1,
          rooms: [],
        }),
      }));
      const seed = jest.fn(
        async (_root: string, _auth: unknown, _plan: unknown, options: ApplyNS.SeedOptions) => {
          const receipt = options.receipt!;
          receipts.push(receipt);
          for (const member of ['alice', 'bob'])
            if (receipt.done(`user:${member}`) === null)
              receipt.record(`user:${member}`, 'done', {
                id: `uid-${member}`,
                username: member,
                new: false,
              });
          if (receipt.done(`room:${spec.name}`) === null)
            receipt.record(`room:${spec.name}`, 'done', {
              rid: 'captured-room',
              type: 'c',
              reused: false,
            });
          const items = complete ? spec.content : spec.content.slice(0, 1);
          for (const item of items) {
            const key = `message:${spec.name}:${item.key}`;
            if (receipt.done(key) === null)
              receipt.record(key, 'done', {
                id: receipt.identifier(key),
                rid: 'captured-room',
                room: spec.name,
                key: item.key,
                kind: 'main',
                userId: `uid-${item.author}`,
                author: item.author,
                ts: '2026-10-09T12:00:00.000Z',
                fileIds: [],
                tmid: '',
              });
          }
          if (!complete && failure === 'unresolved intent')
            receipt.record(`message:${spec.name}:${spec.content[1]!.key}`, 'intent', {
              rid: 'captured-room',
            });
          return {
            run_id: receipt.manifest.run,
            messages: items.length,
            users: 2,
            failed:
              !complete && failure === 'failed rooms'
                ? [{ name: spec.name, why: 'second message refused' }]
                : [],
            users_failed:
              !complete && failure === 'failed users'
                ? [{ username: 'bob', why: 'login refused' }]
                : [],
          };
        },
      );
      jest.doMock('../../../src/seed/apply', () => ({ seed }));
      const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
      const Receipt = require('../../../src/seed/receipt') as typeof ReceiptNS;
      const auth = { token: 'admin-token', userId: 'admin-id' };
      const meta = await readMeta(name);
      const attempted = seeding.seedPrepared(meta, auth, plan, nullEmit, {});
      await attempted.catch(() => undefined);
      expect(database.run).not.toHaveBeenCalled();
      expect(receipts[0]!.done('history:timeline')).toBeNull();
      await expect(attempted).rejects.toThrow(/API creation is incomplete/u);
      const run = receipts[0]!.manifest.run;
      expect(Receipt.pendingReceipt(name)?.run).toBe(run);
      complete = true;
      const result = await seeding.seedPrepared(meta, auth, plan, nullEmit, {});
      expect(receipts[1]!.manifest.run).toBe(run);
      expect(result.run_id).toBe(run);
      expect(result.history).toEqual(expect.objectContaining({ messages: 2 }));
      const captured = [...receipts[1]!.entries.values()]
        .filter((entry) => entry.state === 'done' && entry.key.startsWith('message:'))
        .map((entry) => entry.data.id);
      expect(
        packets
          .flat()
          .map((message) => message.id)
          .sort(),
      ).toEqual([...captured].sort());
      expect(captured).toHaveLength(2);
      expect(Receipt.pendingReceipt(name)).toBeNull();
      expect(receipts[1]!.done('phase:complete')).not.toBeNull();
    },
  );

  it.each(['history date write', 'history metadata write', 'scenario verification probe'])(
    'resumes a pending %s after a complete API phase without rebuilding saved dates',
    async (phase) => {
      const name = `history-resume-${phase.replaceAll(' ', '-')}`;
      await writeFixture(name);
      jest.resetModules();
      const base = planFrom('small', { users: 2, historyDays: 180, scenarios: ['room-states'] });
      const original = base.rooms.find((room) => room.kind === READ_ONLY)!;
      const spec = {
        ...original,
        messages: 2,
        threads: [],
        replyCount: 0,
        reactions: [],
        files: [],
        content: original.content
          .filter((item) => item.kind === 'main')
          .slice(0, 2)
          .map((item) => ({
            ...item,
            reactions: [],
            pin: false,
            star: '',
            mention: '',
            editedText: '',
          })),
      };
      const plan = { ...base, customEmoji: [], rooms: [spec] };
      const receipts: ReceiptNS.Receipt[] = [];
      const packets: DateChange[][] = [];
      const probeKey = `probe:${spec.name}:readonly`;
      let interrupted = true;
      let preimageReads = 0;
      const database: SeedDatabase = {
        target: 'history-database',
        assertTarget: jest.fn(async () => undefined),
        run: jest.fn(async (script) => {
          if (script.startsWith('var ids=')) {
            preimageReads += 1;
            return {
              messages: [...receipts.at(-1)!.entries.values()]
                .filter((entry) => entry.state === 'done' && entry.key.startsWith('message:'))
                .map((entry) => ({
                  id: entry.data.id,
                  rid: entry.data.rid,
                  userId: entry.data.userId,
                  ts: entry.data.ts,
                })),
              anchors: {},
            };
          }
          const match = /^var changes=(.*?);var now=/su.exec(script);
          if (match !== null) {
            const packet = JSON.parse(match[1] as string) as DateChange[];
            packets.push(packet);
            if (interrupted && phase === 'history date write')
              throw new Error('lost date write acknowledgment');
            return { ok: true, count: packet.length };
          }
          if (script.startsWith('var faults=')) return { ok: true, faults: [], checked: 2 };
          if (interrupted && phase === 'history metadata write')
            throw new Error('lost metadata write acknowledgment');
          return { ok: true };
        }),
      };
      jest.doMock('../../../src/core/seed-db', () => ({ seedDatabase: async () => database }));
      jest.doMock('../../../src/seed/apply', () => ({
        seed: async (
          _root: string,
          _auth: unknown,
          _plan: unknown,
          options: ApplyNS.SeedOptions,
        ) => {
          const receipt = options.receipt!;
          receipts.push(receipt);
          for (const member of ['alice', 'bob'])
            if (receipt.done(`user:${member}`) === null)
              receipt.record(`user:${member}`, 'done', {
                id: `uid-${member}`,
                username: member,
                new: false,
              });
          if (receipt.done(`room:${spec.name}`) === null)
            receipt.record(`room:${spec.name}`, 'done', {
              rid: 'captured-room',
              type: 'c',
              reused: false,
            });
          for (const item of spec.content) {
            const key = `message:${spec.name}:${item.key}`;
            if (receipt.done(key) === null)
              receipt.record(key, 'done', {
                id: receipt.identifier(key),
                rid: 'captured-room',
                room: spec.name,
                key: item.key,
                kind: 'main',
                userId: `uid-${item.author}`,
                author: item.author,
                ts: '2026-10-09T12:00:00.000Z',
                fileIds: [],
                tmid: '',
              });
          }
          return {
            run_id: receipt.manifest.run,
            messages: 2,
            users: 2,
            failed: [],
            users_failed: [],
          };
        },
      }));
      jest.doMock('../../../src/seed/verification', () => ({
        verifyBatch: async (
          _root: string,
          _auth: unknown,
          _plan: unknown,
          receipt: ReceiptNS.Receipt,
        ) => {
          if (phase === 'scenario verification probe') {
            if (interrupted) {
              receipt.record(probeKey, 'intent', {
                id: receipt.identifier(probeKey),
                rid: 'captured-room',
                userId: 'uid-alice',
              });
              throw new Error('lost permission probe acknowledgment');
            }
            expect(receipt.intent(probeKey)).not.toBeNull();
            receipt.record(probeKey, 'done', { denied: true });
          }
          return { ok: true, faults: [], extra: [], unreadable: [], checked: 1, rooms: [] };
        },
      }));
      const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
      const Receipt = require('../../../src/seed/receipt') as typeof ReceiptNS;
      const meta = await readMeta(name);
      const auth = { token: 'admin-token', userId: 'admin-id' };
      await expect(seeding.seedPrepared(meta, auth, plan, nullEmit, {})).rejects.toThrow(
        phase === 'scenario verification probe'
          ? /unresolved operations/u
          : /lost .* acknowledgment/u,
      );
      const pendingKey =
        phase === 'history date write'
          ? 'history:dates:0'
          : phase === 'history metadata write'
            ? 'history:metadata'
            : probeKey;
      expect(receipts[0]!.intent(pendingKey)).not.toBeNull();
      const saved = JSON.stringify(receipts[0]!.done('history:timeline'));
      const run = receipts[0]!.manifest.run;
      interrupted = false;
      await expect(seeding.seedPrepared(meta, auth, plan, nullEmit, {})).resolves.toEqual(
        expect.objectContaining({ run_id: run, history: expect.objectContaining({ messages: 2 }) }),
      );
      expect(receipts[1]!.manifest.run).toBe(run);
      expect(JSON.stringify(receipts[1]!.done('history:timeline'))).toBe(saved);
      expect(preimageReads).toBe(1);
      expect(packets).toHaveLength(phase === 'history date write' ? 2 : 1);
      if (phase === 'history date write') expect(packets[1]).toEqual(packets[0]);
      expect(receipts[1]!.intent(pendingKey)).toBeNull();
      expect(receipts[1]!.done(pendingKey)).not.toBeNull();
      expect(receipts[1]!.done('phase:complete')).not.toBeNull();
      expect(Receipt.pendingReceipt(name)).toBeNull();
    },
  );
});
