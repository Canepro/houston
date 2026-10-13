import type { SeedDatabase } from '../../src/core/seed-db';
import { applyHistory, timeline, verifyHistory, type DateChange } from '../../src/seed/history';
import { DISCUSSION } from '../../src/seed/kinds';
import { type Plan, planFrom } from '../../src/seed/plan';
import { Receipt } from '../../src/seed/receipt';

type Bag = Record<string, unknown>;
const REFERENCE = '2026-10-09T12:00:00.000Z';
const DAY = 86_400_000;

function populate(plan: Plan, reused = false) {
  const receipt = new Receipt(plan);
  receipt.manifest.reference = REFERENCE;
  const preimages: Bag[] = [];
  for (const room of plan.rooms) {
    const parent = room.kind === DISCUSSION ? receipt.done(`message:${room.parent}:main-0`) : null;
    receipt.record(`room:${room.name}`, 'done', {
      rid: `rid-${room.name}`,
      reused: room.kind === DISCUSSION && reused,
      anchor: room.kind === DISCUSSION && !reused ? (parent?.id ?? '') : '',
    });
    const record = (key: string, data: Bag) => {
      receipt.record(key, 'done', data);
      preimages.push({ id: data.id, rid: data.rid, userId: data.userId ?? '', ts: REFERENCE });
    };
    if (room.kind === DISCUSSION && room.fromMessage >= 0 && !reused) {
      for (let i = 0; i < 2; i += 1)
        record(`opening:${room.name}:${i}`, {
          id: `opening-${i}`,
          rid: `rid-${room.name}`,
          room: room.name,
          kind: 'opening',
          ts: REFERENCE,
          attachments:
            i === 0
              ? [
                  {
                    message_link: `http://x/channel/${room.parent}?msg=${encodeURIComponent(String(parent?.id))}`,
                  },
                ]
              : [],
        });
    }
    for (const item of room.content)
      record(`message:${room.name}:${item.key}`, {
        id: receipt.identifier(`message:${room.name}:${item.key}`),
        rid: `rid-${room.name}`,
        room: room.name,
        key: item.key,
        kind: item.kind,
        author: item.author,
        userId: `uid-${item.author}`,
        ts: REFERENCE,
        fileIds: item.kind === 'file' ? [`file-${item.file}`] : [],
        tmid: item.parent === '' ? '' : receipt.identifier(`message:${room.name}:${item.parent}`),
      });
  }
  return { receipt, preimages };
}

function discussionPlan(): Plan {
  const base = planFrom('small', { historyDays: 180 });
  const discussion = base.rooms.find((r) => r.kind === DISCUSSION && r.fromMessage >= 0)!;
  return {
    ...base,
    rooms: base.rooms.filter((r) => r.name === discussion.parent || r === discussion),
  };
}

function changes(script: string): DateChange[] | null {
  const match = /^var changes=(.*?);var now=/su.exec(script);
  return match === null ? null : (JSON.parse(match[1] as string) as DateChange[]);
}

describe('historical seed batches', () => {
  it('assigns deterministic genuine dates with replies and discussion openings after their parents', () => {
    const plan = discussionPlan();
    const { receipt, preimages } = populate(plan);
    preimages.push({
      id: 'unrelated-existing-message',
      rid: 'rid-team-chat',
      ts: '2026-10-08T09:00:00.000Z',
    });
    const original = JSON.stringify(preimages);
    const result = timeline(plan, receipt, preimages);
    expect(timeline(plan, receipt, preimages)).toEqual(result);
    expect(result.messages.some((m) => m.id === 'unrelated-existing-message')).toBe(false);
    expect(JSON.stringify(preimages)).toBe(original);
    const dates = new Map(result.messages.map((m) => [m.id, m.ts]));
    for (const message of result.messages) {
      expect(Date.parse(message.ts)).toBeGreaterThanOrEqual(Date.parse(REFERENCE) - 180 * DAY);
      expect(Date.parse(message.ts)).toBeLessThan(Date.parse(REFERENCE));
      expect(message.old).toBe(REFERENCE);
    }
    for (const room of plan.rooms) {
      for (const item of room.content) {
        const message = receipt.done(`message:${room.name}:${item.key}`)!;
        if (item.parent !== '') {
          const parent = receipt.done(`message:${room.name}:${item.parent}`)!;
          expect(Date.parse(dates.get(String(message.id))!)).toBeGreaterThan(
            Date.parse(dates.get(String(parent.id))!),
          );
        }
      }
    }
    const discussion = plan.rooms.find((r) => r.kind === DISCUSSION)!;
    const parentId = String(receipt.done(`message:${discussion.parent}:main-0`)!.id);
    const opening = result.messages.find((m) => m.id === 'opening-0')!;
    expect(Date.parse(opening.ts)).toBeGreaterThan(Date.parse(dates.get(parentId)!));
    expect(opening.attachments).toEqual([{ index: 0, ts: dates.get(parentId) }]);
    for (const file of result.messages.filter((m) => m.fileIds.length > 0))
      expect(file.fileIds).toHaveLength(1);
  });

  it('preserves existing discussion anchors and reports the smaller available historical range', () => {
    const plan = discussionPlan();
    const { receipt, preimages } = populate(plan, true);
    const discussion = plan.rooms.find((r) => r.kind === DISCUSSION)!;
    const anchor = new Date(Date.parse(REFERENCE) - 30 * DAY).toISOString();
    const result = timeline(plan, receipt, preimages, { [discussion.name]: anchor });
    const newDiscussionIds = new Set(
      discussion.content.map((m) => receipt.done(`message:${discussion.name}:${m.key}`)!.id),
    );
    const dates = result.messages.filter((m) => newDiscussionIds.has(m.id));
    expect(dates).toHaveLength(discussion.content.length);
    for (const message of dates) expect(Date.parse(message.ts)).toBeGreaterThan(Date.parse(anchor));
    expect(result.constrained).toEqual([
      { room: discussion.name, anchor, start: new Date(Date.parse(anchor) + 1000).toISOString() },
    ]);
    expect(result.messages.some((m) => m.id.startsWith('opening-'))).toBe(false);
  });

  it('refuses a historical discussion with no chronological space after its preserved anchor', () => {
    const plan = discussionPlan();
    const { receipt, preimages } = populate(plan, true);
    const discussion = plan.rooms.find((r) => r.kind === DISCUSSION)!;
    expect(() => timeline(plan, receipt, preimages, { [discussion.name]: REFERENCE })).toThrow(
      /no historical space/u,
    );
  });

  it('aligns a related pin quote to its historical source while preserving the action timestamp', async () => {
    const base = planFrom('small', { historyDays: 180 });
    const plan = { ...base, rooms: base.rooms.filter((r) => r.name === 'team-chat') };
    const { receipt, preimages } = populate(plan);
    const room = plan.rooms[0]!;
    const key = `message:${room.name}:main-0`;
    const source = receipt.done(key)!;
    receipt.record(key, 'done', { ...source, pinnedAt: REFERENCE });
    receipt.record(`pin:${room.name}:main-0`, 'done', { userId: 'admin-id' });
    const quote = {
      id: 'pin-system-notice',
      rid: source.rid,
      userId: 'admin-id',
      ts: REFERENCE,
      attachments: [{ index: 2, source: source.id }],
    };
    const original = JSON.stringify({ quote, preimages });
    const packets: DateChange[][] = [];
    const database: SeedDatabase = {
      target: 'db',
      assertTarget: jest.fn(async () => undefined),
      run: jest.fn(async (script) => {
        if (script.startsWith('var ids='))
          return { messages: [...preimages], quotes: [quote], anchors: {} };
        const packet = changes(script);
        if (packet !== null) {
          packets.push(packet);
          return { ok: true, count: packet.length };
        }
        return { ok: true };
      }),
    };
    const summary = await applyHistory(plan, receipt, database, () => undefined);
    const dates = receipt.done('history:timeline')!.messages as DateChange[];
    const historical = dates.find((m) => m.id === source.id)!;
    const related = dates.find((m) => m.id === quote.id);
    expect(related).toEqual({
      id: quote.id,
      rid: source.rid,
      old: REFERENCE,
      ts: REFERENCE,
      fileIds: [],
      attachments: [{ index: 2, ts: historical.ts }],
      related: true,
    });
    expect(Date.parse(historical.ts)).toBeLessThan(Date.parse(REFERENCE));
    expect(packets.flat().find((m) => m.id === quote.id)).toEqual(related);
    expect(summary).toEqual(
      expect.objectContaining({ messages: preimages.length, related_quotes: 1 }),
    );
    expect(Date.parse(String(summary.latest))).toBeLessThan(Date.parse(REFERENCE));
    expect(receipt.done(key)!.pinnedAt).toBe(REFERENCE);
    expect(JSON.stringify({ quote, preimages })).toBe(original);
  });

  it('leaves ordinary seeding untouched and makes no database calls without history', async () => {
    const plan = planFrom('small');
    const database = {
      target: 'db',
      run: jest.fn(async () => ({})),
      assertTarget: jest.fn(async () => undefined),
    };
    expect(await applyHistory(plan, new Receipt(plan), database, () => undefined)).toEqual({});
    expect(database.run).not.toHaveBeenCalled();
    expect(database.assertTarget).not.toHaveBeenCalled();
  });

  it('retries an interrupted date write using its original stored timeline and preimages', async () => {
    const plan = discussionPlan();
    const { receipt, preimages } = populate(plan);
    const packets: DateChange[][] = [];
    let readbacks = 0;
    let firstWrite = true;
    const database: SeedDatabase = {
      target: 'db',
      assertTarget: jest.fn(async () => undefined),
      run: jest.fn(async (script) => {
        if (script.startsWith('var ids=')) {
          readbacks += 1;
          return { messages: preimages, anchors: {} };
        }
        const packet = changes(script);
        if (packet !== null) {
          packets.push(packet);
          if (firstWrite) {
            firstWrite = false;
            throw new Error('interrupted after a partial date update');
          }
          return { ok: true, count: packet.length };
        }
        return { ok: true };
      }),
    };
    await expect(applyHistory(plan, receipt, database, () => undefined)).rejects.toThrow(
      /partial date/u,
    );
    expect(receipt.intent('history:dates:0')).not.toBeNull();
    const recorded = receipt.done('history:timeline');
    expect(await applyHistory(plan, receipt, database, () => undefined)).toEqual(
      expect.objectContaining({ days: 180, reference: REFERENCE, messages: preimages.length }),
    );
    expect(readbacks).toBe(1);
    expect(packets[1]).toEqual(packets[0]);
    expect(receipt.done('history:timeline')).toEqual(recorded);
    expect(receipt.done('history:dates:0')).toEqual({ ok: true, count: preimages.length });
    expect(receipt.done('history:metadata')).not.toBeNull();
  });

  it('retries rejected date and metadata acknowledgments without repeating completed date chunks', async () => {
    const plan = discussionPlan();
    const { receipt, preimages } = populate(plan);
    let dateWrites = 0;
    let metadataWrites = 0;
    let preimageReads = 0;
    const database: SeedDatabase = {
      target: 'db',
      assertTarget: jest.fn(async () => undefined),
      run: jest.fn(async (script) => {
        if (script.startsWith('var ids=')) {
          preimageReads += 1;
          return { messages: preimages, anchors: {} };
        }
        const packet = changes(script);
        if (packet !== null) {
          dateWrites += 1;
          return dateWrites === 1 ? { ok: false, count: 0 } : { ok: true, count: packet.length };
        }
        metadataWrites += 1;
        return { ok: metadataWrites > 1 };
      }),
    };
    await expect(applyHistory(plan, receipt, database, () => undefined)).rejects.toThrow(
      /date update was incomplete/u,
    );
    expect(metadataWrites).toBe(0);
    await expect(applyHistory(plan, receipt, database, () => undefined)).rejects.toThrow(
      /metadata update was incomplete/u,
    );
    await expect(applyHistory(plan, receipt, database, () => undefined)).resolves.toEqual(
      expect.objectContaining({ days: 180, messages: preimages.length }),
    );
    expect(preimageReads).toBe(1);
    expect(dateWrites).toBe(2);
    expect(metadataWrites).toBe(2);
    expect(receipt.done('history:dates:0')).toEqual({ ok: true, count: preimages.length });
    expect(receipt.done('history:metadata')).toEqual({ ok: true });
  });

  it('refuses to expand an immutable saved timeline that omits captured messages', async () => {
    const base = planFrom('small', { historyDays: 180 });
    const plan = { ...base, rooms: base.rooms.filter((r) => r.name === 'team-chat') };
    const { receipt, preimages } = populate(plan);
    const stored = {
      messages: timeline(plan, receipt, preimages).messages.slice(1),
      reference: REFERENCE,
      days: 180,
      target: 'db',
      constrained: [],
    };
    receipt.record('history:timeline', 'done', stored);
    const before = JSON.stringify(receipt.done('history:timeline'));
    const database: SeedDatabase = {
      target: 'db',
      assertTarget: jest.fn(async () => undefined),
      run: jest.fn(async (script) => {
        const packet = changes(script);
        return packet === null ? { ok: true } : { ok: true, count: packet.length };
      }),
    };
    await expect(applyHistory(plan, receipt, database, () => undefined)).rejects.toThrow(
      /timeline does not cover the complete captured batch/u,
    );
    expect(database.run).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt.done('history:timeline'))).toBe(before);
    expect(receipt.done('history:dates:0')).toBeNull();
  });

  it.each(['message', 'opening', 'notice', 'quote'])(
    'refuses verification when a captured %s is missing from the saved timeline',
    async (prefix) => {
      const plan = planFrom('small', { historyDays: 180 });
      const receipt = new Receipt(plan);
      const date: DateChange = {
        id: 'covered-main',
        rid: 'existing-room',
        old: REFERENCE,
        ts: '2026-04-12T12:00:00.000Z',
        fileIds: [],
        attachments: [],
      };
      receipt.record('message:existing-room:main-0', 'done', { id: date.id, rid: date.rid });
      receipt.record('history:timeline', 'done', { messages: [date] });
      receipt.record(`${prefix}:existing-room:late`, 'done', {
        id: `late-${prefix}`,
        rid: date.rid,
      });
      const database: SeedDatabase = {
        target: 'db',
        assertTarget: jest.fn(async () => undefined),
        run: jest.fn(async () => ({ ok: true, faults: [], checked: 1 })),
      };
      await expect(verifyHistory(receipt, database)).resolves.toEqual({
        ok: false,
        faults: [expect.objectContaining({ kind: 'history-coverage', want: 2, got: 1 })],
        checked: 0,
      });
      expect(database.run).not.toHaveBeenCalled();
    },
  );

  it.each(['duplicate', 'unowned'])(
    'refuses verification of a saved timeline containing a %s identity',
    async (caseName) => {
      const receipt = new Receipt(planFrom('small', { historyDays: 180 }));
      const date: DateChange = {
        id: 'owned-message',
        rid: 'existing-room',
        old: REFERENCE,
        ts: '2026-04-12T12:00:00.000Z',
        fileIds: [],
        attachments: [],
      };
      receipt.record('message:existing-room:main-0', 'done', { id: date.id, rid: date.rid });
      receipt.record('history:timeline', 'done', {
        messages: [date, { ...date, id: caseName === 'duplicate' ? date.id : 'unowned-message' }],
      });
      const database: SeedDatabase = {
        target: 'db',
        assertTarget: jest.fn(async () => undefined),
        run: jest.fn(async () => ({ ok: true, faults: [], checked: 2 })),
      };
      await expect(verifyHistory(receipt, database)).resolves.toEqual({
        ok: false,
        faults: [expect.objectContaining({ kind: 'history-coverage' })],
        checked: 0,
      });
      expect(database.run).not.toHaveBeenCalled();
    },
  );

  it('bounds date batches and refuses incomplete preimages or changed target identities', async () => {
    const base = planFrom('large', { historyDays: 180 });
    const plan = { ...base, rooms: base.rooms.filter((r) => r.name === 'team-chat') };
    const { receipt, preimages } = populate(plan);
    const packets: DateChange[][] = [];
    const database: SeedDatabase = {
      target: 'db',
      assertTarget: jest.fn(async () => undefined),
      run: jest.fn(async (script) => {
        const packet = changes(script);
        if (script.startsWith('var ids=')) return { messages: preimages, anchors: {} };
        if (packet !== null) {
          packets.push(packet);
          return { ok: true, count: packet.length };
        }
        return { ok: true };
      }),
    };
    await applyHistory(plan, receipt, database, () => undefined);
    expect(packets.map((p) => p.length)).toEqual([200, 4]);
    const incomplete = populate(plan);
    const badDatabase = {
      ...database,
      run: jest.fn(async () => ({ messages: incomplete.preimages.slice(1), anchors: {} })),
    };
    await expect(
      applyHistory(plan, incomplete.receipt, badDatabase, () => undefined),
    ).rejects.toThrow(/preimages are incomplete/u);
    expect(incomplete.receipt.done('history:timeline')).toBeNull();
    await expect(
      applyHistory(plan, receipt, { ...database, target: 'different-db' }, () => undefined),
    ).rejects.toThrow(/differs/u);
  });
});
