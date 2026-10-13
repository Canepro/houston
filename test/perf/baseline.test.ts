import * as fs from 'node:fs';
import * as path from 'node:path';

import { NotFoundError, ValidationError } from '../../src/lib/errors';

import {
  ERROR_ABS_FLOOR,
  REGRESS_PCT,
  baselinePath,
  baselinesDir,
  compare,
  load,
  sanitizeLabel,
  save,
  stepOrder,
} from '../../src/perf/baseline';

/** The rows earlier releases compared for each case of the shape table below, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'perf', 'baseline.json'), 'utf8'),
) as { compare: unknown[] };

/**
 * The exact bytes earlier releases write for a saved baseline: two-space indented JSON with
 * no trailing newline.
 */
const WRITTEN_BEFORE_FIX =
  '{\n  "summary": {\n    "rps": 120,\n    "p95": 250\n  },\n  "note": "before the fix"\n}';
const WRITTEN_EARLIER_RUN = '{\n  "summary": {\n    "rps": 99,\n    "p95": 300\n  }\n}';

beforeEach(() => {
  fs.rmSync(baselinesDir(), { recursive: true, force: true });
});

describe('labels', () => {
  it.each([
    ['My Run', 'my-run'],
    ['  Before FIX  ', 'before-fix'],
    ['a/b\\c', 'a-b-c'],
    ['keep_this-1', 'keep_this-1'],
    ['--edges--', 'edges'],
  ])('sanitises %p to %p', (given, expected) => {
    expect(sanitizeLabel(given)).toBe(expected);
  });

  it('refuses a label with nothing usable left', () => {
    expect(() => sanitizeLabel('///')).toThrow(/is not a usable baseline name/u);
    // A bad `--save`/`--compare` value: a usage error, exit 2 (L7-07), not a plain exit 1.
    expect(() => sanitizeLabel('  ')).toThrow(ValidationError);
  });

  it('sanitises exactly as earlier releases did', () => {
    const labels = ['My Run', '  Before FIX  ', 'a/b\\c', 'keep_this-1', '--edges--', 'ÉTÉ', '1'];
    const recorded = ['my-run', 'before-fix', 'a-b-c', 'keep_this-1', 'edges', 't', '1'];
    const mine = labels.map((l) => {
      try {
        return sanitizeLabel(l);
      } catch {
        return 'RAISES';
      }
    });
    expect(mine).toEqual(recorded);
  });
});

describe('save and load', () => {
  it('round-trips a payload through the same path, and bytes, earlier releases use', () => {
    const payload = { summary: { rps: 120, p95: 250 }, note: 'before the fix' };
    const written = save('Before FIX', payload);
    expect(written).toBe(baselinePath('before-fix'));
    expect(load('before-fix')).toEqual(payload);

    // Earlier releases read back exactly what they wrote, so writing their bytes is what
    // keeps a baseline this build saved comparable from an older install.
    expect(fs.readFileSync(written, 'utf8')).toBe(WRITTEN_BEFORE_FIX);
    expect(JSON.parse(WRITTEN_BEFORE_FIX)).toEqual(payload);
  });

  it('reads a baseline an earlier release saved', () => {
    fs.mkdirSync(baselinesDir(), { recursive: true });
    fs.writeFileSync(baselinePath('py-run'), WRITTEN_EARLIER_RUN);
    expect(load('py-run')).toEqual({ summary: { rps: 99, p95: 300 } });
  });

  it('names the directory it looked in when there is no such baseline', () => {
    expect(() => load('missing')).toThrow(/no saved baseline 'missing' \(looked in /u);
    // A named thing that is not there: exit 4, as a missing workspace (L7-07), not exit 1.
    expect(() => load('missing')).toThrow(NotFoundError);
  });
});

describe('compare', () => {
  const base = {
    summary: {
      rps: 100,
      p50: 100,
      p95: 200,
      p99: 300,
      error_rate: 0.001,
      steps: { login: { p95: 50 }, post: { p95: 80 }, extra: { p95: 10 } },
    },
  };

  it('orders throughput, latency, errors, then per-step p95', () => {
    const rows = compare(base, base);
    expect(rows.map((r) => r.metric)).toEqual([
      'throughput (rps)',
      'p50',
      'p95',
      'p99',
      'error rate',
      'step login p95',
      'step post p95',
      'step extra p95',
    ]);
  });

  it('treats a DROP in throughput as worse, and a rise in latency as worse', () => {
    const slower = { summary: { ...base.summary, rps: 50, p95: 400 } };
    const rows = compare(slower, base);
    expect(rows.find((r) => r.metric === 'throughput (rps)')).toMatchObject({
      worse: true,
      flag: true,
    });
    expect(rows.find((r) => r.metric === 'p95')).toMatchObject({ worse: true, flag: true });
  });

  it('does not flag an error blip below the absolute floor', () => {
    // 0.1% -> 0.2% is a doubling in percentage terms and still noise.
    const blip = { summary: { ...base.summary, error_rate: 0.002 } };
    const row = compare(blip, base).find((r) => r.metric === 'error rate');
    expect(row?.worse).toBe(true);
    expect(row?.flag).toBe(false);
  });

  it('DOES flag a zero baseline going non-zero', () => {
    const from0 = { summary: { ...base.summary, error_rate: 0 } };
    const to5 = { summary: { ...base.summary, error_rate: 0.05 } };
    const row = compare(to5, from0).find((r) => r.metric === 'error rate');
    expect(row?.flag).toBe(true);
    // pct is 0 against a zero baseline, so the decision came from the absolute move.
    expect(row?.pct).toBe(0);
  });

  it('skips a metric either side is missing rather than inventing one', () => {
    expect(compare({ summary: { rps: 1 } }, { summary: {} })).toEqual([]);
    expect(compare({}, {})).toEqual([]);
  });

  it('compares only the steps BOTH runs measured', () => {
    const cur = { summary: { ...base.summary, steps: { login: { p95: 50 }, novel: { p95: 1 } } } };
    expect(
      compare(cur, base)
        .filter((r) => r.metric.startsWith('step'))
        .map((r) => r.metric),
    ).toEqual(['step login p95']);
  });

  it('produces the rows earlier releases produced, for every shape', () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [base, base],
      [{ summary: { ...base.summary, rps: 50, p95: 400 } }, base],
      [{ summary: { ...base.summary, error_rate: 0.002 } }, base],
      [
        { summary: { ...base.summary, error_rate: 0.05 } },
        { summary: { ...base.summary, error_rate: 0 } },
      ],
      [{ summary: { rps: 1 } }, { summary: {} }],
      [{}, {}],
      [{ summary: { ...base.summary, steps: { login: { p95: 50 }, novel: { p95: 1 } } } }, base],
      // Exactly at the 25% threshold, which is `>` and not `>=`.
      [{ summary: { ...base.summary, p95: 250 } }, base],
      [{ summary: { ...base.summary, p95: 251 } }, base],
    ];
    expect(cases.map(([c, b]) => compare(c, b))).toEqual(RECORDED.compare);
  });

  it('keeps the thresholds and the step order earlier releases used', () => {
    const steps = ['login', 'rooms', 'open', 'post', 'sync', 'read'];
    expect(REGRESS_PCT).toBe(25);
    expect(ERROR_ABS_FLOOR).toBe(0.005);
    expect(stepOrder(Object.fromEntries(steps.map((s) => [s, {}])))).toEqual(steps);
  });
});
