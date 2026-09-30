import type * as ModNS from '../../src/perf/mongoprof';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DB, asInt, lastJson } from '../../src/perf/mongoprof';

/**
 * The profiler JS earlier releases sent for one start (slowms 250), one stop (back to level
 * 1 at 50ms) and one collect (since 1735689600000, top 3), in that order, recorded.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'perf', 'mongoprof.json'), 'utf8'),
) as { profilerJs: string[] };

const BANNERS = [
  'Current Mongosh Log ID: abc\nConnecting to: mongodb://...\n{"was":0,"slowms":100}',
  '{"was":1,"slowms":50}',
  'no json at all',
  '',
  'MongoDB shell version v4.4\n{"total":2,"collscan":1,"slow":[]}',
  '{"broken": ',
  '[1,2,3]',
  '{"a":1}\nnot json',
];

const INT_VALUES: unknown[] = [0, 1, 100, '42', ' 7 ', null, undefined, 'abc', 3.7, true, {}, []];

describe('lastJson', () => {
  it('finds the answer behind a shell banner', () => {
    // mongosh prints a log id and a connection line before anything useful.
    expect(lastJson(BANNERS[0] as string)).toEqual({ was: 0, slowms: 100 });
  });

  it('answers null when nothing parses', () => {
    expect(lastJson('no json at all')).toBeNull();
    expect(lastJson('')).toBeNull();
    expect(lastJson('{"broken": ')).toBeNull();
  });

  it('skips a trailing non-JSON line and takes the last one that parses', () => {
    expect(lastJson('{"a":1}\nnot json')).toEqual({ a: 1 });
  });

  it('reads exactly what earlier releases read, for every shape', () => {
    expect(BANNERS.map(lastJson)).toEqual([
      { was: 0, slowms: 100 },
      { was: 1, slowms: 50 },
      null,
      null,
      { total: 2, collscan: 1, slow: [] },
      null,
      [1, 2, 3],
      { a: 1 },
    ]);
  });
});

describe('asInt', () => {
  it('falls back rather than throwing, because this runs inside a finally', () => {
    // A shell that serialised a NumberLong as an object must not take down the restore.
    expect(asInt(null, 0)).toBe(0);
    expect(asInt({}, 0)).toBe(0);
    expect(asInt('abc', 100)).toBe(100);
    expect(asInt('42', 0)).toBe(42);
    expect(asInt(3.7, 0)).toBe(3);
  });

  it('coerces exactly as earlier releases did, for every value', () => {
    // `undefined` has no JSON spelling, so earlier releases were never asked about it;
    // `null` takes the same branch and is here.
    expect(INT_VALUES.filter((v) => v !== undefined).map((v) => asInt(v, 99))).toEqual([
      0, 1, 100, 42, 7, 99, 99, 3, 1, 99, 99,
    ]);
    // And the TypeScript-only absence takes the same branch as null.
    expect(asInt(undefined, 99)).toBe(99);
  });
});

describe('the default database', () => {
  it('is the same fallback earlier releases kept', () => {
    expect(DB).toBe('rocketchat');
  });

  it('falls back to it when the workspace cannot be read', async () => {
    // The lookup lives in `core/database-of.ts`, so this answers from the real
    // implementation and only falls to the default when the workspace's compose file cannot
    // be read.
    // `test/core/database-of.test.ts` holds the recorded answer for a real custom
    // MONGO_URL.
    const { dbOf } = require('../../src/perf/mongoprof') as typeof ModNS;
    expect(await dbOf('any-workspace')).toBe(DB);
  });
});

describe('start and stop', () => {
  function mockShell(replies: Record<string, [number, string]>) {
    jest.resetModules();
    const seen: string[][] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExecCapture: (_n: string, _s: string, args: string[]) => {
        seen.push(args);
        const shell = args[0] as string;
        return Promise.resolve(replies[shell] ?? [1, '']);
      },
    }));
    return seen;
  }

  it('returns a marker even when the prior state is unparseable', async () => {
    // `setProfilingLevel` has ALREADY run by the time the output is read. Returning null
    // there would leave the profiler running for the life of the repro.
    const seen = mockShell({ mongosh: [0, 'banner only, no json'] });
    const { start } = require('../../src/perf/mongoprof') as typeof ModNS;
    expect(await start('ws')).toEqual({ was: 0, slowms: 100, prior_unknown: true });
    expect(seen[0]?.[0]).toBe('mongosh');
  });

  it('returns null only when NO shell worked, so there is nothing to undo', async () => {
    mockShell({});
    const { start } = require('../../src/perf/mongoprof') as typeof ModNS;
    expect(await start('ws')).toBeNull();
  });

  it('falls back to the legacy mongo shell for an old pairing', async () => {
    const seen = mockShell({ mongo: [0, '{"was":1,"slowms":50}'] });
    const { start } = require('../../src/perf/mongoprof') as typeof ModNS;
    expect(await start('ws')).toEqual({ was: 1, slowms: 50 });
    expect(seen.map((a) => a[0])).toEqual(['mongosh', 'mongo']);
  });

  it('restores the recorded level, and does nothing without a prior', async () => {
    const seen = mockShell({ mongosh: [0, 'ok'] });
    const { stop } = require('../../src/perf/mongoprof') as typeof ModNS;
    await stop('ws', { was: 1, slowms: 50 });
    expect(seen[0]?.[4]).toBe('db.setProfilingLevel(1, 50);');

    const none = mockShell({ mongosh: [0, 'ok'] });
    const fresh = require('../../src/perf/mongoprof') as typeof ModNS;
    await fresh.stop('ws', null);
    await fresh.stop('ws', {});
    expect(none).toEqual([]);
  });

  it('builds the profiler JS earlier releases built, for start, stop and collect', async () => {
    // Held to what earlier releases actually sent with their shell stubbed, recorded,
    // rather than to a re-typed copy of the snippet -- a transcription compared against
    // itself proves only that it was copied twice.
    const seen = mockShell({ mongosh: [0, '{"was":0,"slowms":100}'] });
    const mine = require('../../src/perf/mongoprof') as typeof ModNS;
    await mine.start('ws', 250);
    await mine.stop('ws', { was: 1, slowms: 50 });
    await mine.collect('ws', 1735689600000, 3);

    expect(seen.map((a) => a[4])).toEqual(RECORDED.profilerJs);
  });
});
