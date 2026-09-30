import { nullEmit } from '../../../src/lib/events';
import { type Facts } from '../../../src/seed/check';
import { planFrom } from '../../../src/seed/plan';
import { metadata, readMeta, writeRecord } from '../../../src/core/runner/record';

import type * as SeedingNS from '../../../src/core/lifecycle/seeding';

describe('reading a seed back', () => {
  afterEach(() => {
    jest.resetModules();
  });

  async function writeFixture(): Promise<void> {
    await writeRecord('w', metadata({ name: 'w', project: 'houston-w', rcVersion: '8.5.1' }));
  }

  it('reports a readback that could not run, and never breaks the seed', async () => {
    await writeFixture();
    // What earlier releases answered for the same record and a readback that throws, recorded.
    const recorded = {
      verdict: { ok: null, why: 'boom', faults: [], unreadable: [], checked: 0, rooms: [] },
      events: [
        {
          message: 'could not read the seed back: boom',
          level: 'warn',
          phase: 'seed',
          code: 'WARNING',
          data: {},
          pct: null,
          terminal: false,
        },
      ],
      result: { planned: { rooms: 1 } },
    };

    jest.resetModules();
    jest.doMock('../../../src/seed/check', () => ({
      ...jest.requireActual('../../../src/seed/check'),
      readback: async () => {
        throw new Error('boom');
      },
    }));
    const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
    const meta = await readMeta('w');
    const result: Record<string, unknown> = { planned: { rooms: 1 } };
    const events: { message: string; level: string; phase: string }[] = [];
    const verdict = await seeding.checkSeed(
      meta,
      { token: 't', userId: 'u' },
      planFrom('small'),
      result,
      ((event: { message: string; level: string; phase: string }) => events.push(event)) as never,
    );
    expect({ verdict, events, result }).toEqual(recorded);
    // A check must never break the seed: the failure is a verdict, not a rejection.
    expect(verdict.ok).toBeNull();
    expect(verdict.why).toBe('boom');
  });

  it('persists the same seed block earlier releases persist, keys and all', async () => {
    await writeFixture();
    // What earlier releases answered and persisted for the same record and an empty readback,
    // the one clock reading masked, recorded.
    const recorded = {
      verdict: { ok: true, faults: [], extra: [], unreadable: [], checked: 0, rooms: [] },
      events: [
        {
          message: 'readback: 0 rooms match the plan',
          level: 'info',
          phase: 'seed',
          code: '',
          data: {},
          pct: null,
          terminal: false,
        },
      ],
      result: {
        planned: { rooms: 1 },
        verification: { ok: true, faults: [], extra: [], unreadable: [], checked: 0 },
        readback: [],
      },
      seed: {
        profile: 'small',
        planned: { rooms: 1 },
        actual: {
          users: null,
          rooms: null,
          rooms_total: null,
          messages: null,
          threads: null,
          dms: null,
        },
        verification: { ok: true, faults: [], extra: [], unreadable: [], checked: 0 },
        at: '<at>',
      },
    };

    jest.resetModules();
    jest.doMock('../../../src/seed/check', () => ({
      ...jest.requireActual('../../../src/seed/check'),
      readback: async () =>
        ({ rooms: [], users_found: [], users_unreadable: '', planned_users: [] }) as Facts,
    }));
    const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
    const meta = await readMeta('w');
    const result: Record<string, unknown> = { planned: { rooms: 1 } };
    const events: unknown[] = [];
    const verdict = await seeding.checkSeed(
      meta,
      { token: 't', userId: 'u' },
      planFrom('small'),
      result,
      ((event: unknown) => events.push(event)) as never,
    );
    const seed = (await readMeta('w')).extra.seed as Record<string, unknown>;
    seed.at = '<at>';
    expect({ verdict, events, result, seed }).toEqual(recorded);
    // EVERY key is present. Earlier releases write `null` for a value this run did not
    // report; an absent JavaScript property would drop the key from the JSON entirely,
    // and 6.14 compares state files key by key.
    expect(Object.keys(seed.actual as Record<string, unknown>).sort()).toEqual([
      'dms',
      'messages',
      'rooms',
      'rooms_total',
      'threads',
      'users',
    ]);
    void nullEmit;
  });
});
