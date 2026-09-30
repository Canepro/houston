import * as fs from 'node:fs';
import * as path from 'node:path';

import { LATENCY_KEYS, evaluate, fmtActual, parse } from '../../src/perf/slo';

/** What earlier releases evaluated for each summary of the table below, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'perf', 'slo.json'), 'utf8'),
) as { evaluate: unknown[] };

const SPECS = [
  'p95=300ms',
  'p95=1.5s',
  'p95=300',
  'error=1%',
  'error=1',
  'rps=100',
  'p50=100ms, p99=2s , error=0.5% ,rps=50',
  '  ',
  'p95=300ms,,error=1%',
];

describe('parse', () => {
  it('reads each unit into milliseconds', () => {
    expect(parse('p95=300ms')[0]).toEqual({ key: 'p95', op: '<=', threshold: 300, raw: '300ms' });
    expect(parse('p95=1.5s')[0]?.threshold).toBe(1500);
    expect(parse('p95=300')[0]?.threshold).toBe(300);
  });

  it('makes rps the one "at least" metric', () => {
    expect(parse('rps=100')[0]?.op).toBe('>=');
    expect(parse('p95=100')[0]?.op).toBe('<=');
    expect(parse('error=1%')[0]?.op).toBe('<=');
  });

  it('skips empty pieces rather than failing on a trailing comma', () => {
    expect(parse('p95=300ms,,error=1%')).toHaveLength(2);
    expect(parse('   ')).toEqual([]);
  });

  it('refuses a rule with no value and an unknown metric, naming the ones it knows', () => {
    expect(() => parse('p95')).toThrow(/bad rule 'p95' \(expected key=value\)/u);
    expect(() => parse('latency=1')).toThrow(/unknown metric 'latency'/u);
  });

  it('refuses an EMPTY threshold rather than gating at zero', () => {
    // `Number('')` is 0, which would make `p95=` a gate every run passes. Earlier releases
    // refuse an empty number, and so must this.
    expect(() => parse('p95=')).toThrow();
    expect(() => parse('rps=')).toThrow();
  });

  it('parses exactly as earlier releases did, for every spec', () => {
    const recorded: [string, string, number, string][][] = [
      [['p95', '<=', 300, '300ms']],
      [['p95', '<=', 1500, '1.5s']],
      [['p95', '<=', 300, '300']],
      [['error', '<=', 1, '1%']],
      [['error', '<=', 1, '1']],
      [['rps', '>=', 100, '100']],
      [
        ['p50', '<=', 100, '100ms'],
        ['p99', '<=', 2000, '2s'],
        ['error', '<=', 0.5, '0.5%'],
        ['rps', '>=', 50, '50'],
      ],
      [],
      [
        ['p95', '<=', 300, '300ms'],
        ['error', '<=', 1, '1%'],
      ],
    ];
    const mine = SPECS.map((s) => parse(s).map((r) => [r.key, r.op, r.threshold, r.raw]));
    expect(mine).toEqual(recorded);
  });
});

describe('evaluate', () => {
  const summary = { p95: 250, error_rate: 0.004, rps: 120 };

  it('passes a rule that is met and fails one that is not', () => {
    expect(evaluate(parse('p95=300ms'), summary)[0]?.ok).toBe(true);
    expect(evaluate(parse('p95=200ms'), summary)[0]?.ok).toBe(false);
    expect(evaluate(parse('rps=100'), summary)[0]?.ok).toBe(true);
    expect(evaluate(parse('rps=200'), summary)[0]?.ok).toBe(false);
  });

  it('reads the error rate as a fraction and reports it as a percent', () => {
    const [row] = evaluate(parse('error=1%'), summary);
    expect(row?.actual).toBeCloseTo(0.4, 10);
    expect(row?.ok).toBe(true);
  });

  it('FAILS an absent metric rather than passing it at zero', () => {
    // A metric that was not captured must never silently pass, which is exactly what an
    // upper-bound rule would do at 0.0.
    const [row] = evaluate(parse('p99=300ms'), summary);
    expect(row?.measured).toBe(false);
    expect(row?.ok).toBe(false);
    expect(row?.actual).toBe(0);
  });

  it('treats a present-but-null value as not measured, and does not crash on it', () => {
    const [row] = evaluate(parse('p95=300ms'), { p95: null });
    expect(row?.measured).toBe(false);
    expect(row?.ok).toBe(false);
  });

  it('evaluates exactly as earlier releases did, over several summaries', () => {
    const summaries = [
      summary,
      { p95: null, error_rate: null, rps: null },
      {},
      { p95: 300, error_rate: 0.01, rps: 100 },
      { p95: 300.5, error_rate: 0.0125, rps: 99.5 },
    ];
    const spec = 'p95=300ms,error=1%,rps=100,p99=1s';
    const rules = parse(spec);
    expect(summaries.map((s) => evaluate(rules, s))).toEqual(RECORDED.evaluate);
  });
});

describe('fmtActual', () => {
  it('matches the metric unit', () => {
    expect(fmtActual('p95', 249.6)).toBe('250ms');
    expect(fmtActual('error', 0.4)).toBe('0.40%');
    expect(fmtActual('rps', 119.94)).toBe('119.9');
    expect([...LATENCY_KEYS].sort()).toEqual(['avg', 'max', 'min', 'p50', 'p90', 'p95', 'p99']);
  });

  it('rounds the way earlier releases rounded, including at a tie', () => {
    // Earlier releases round half-to-EVEN; `toFixed` is half away from zero. A latency mean that
    // lands on a half is exactly what this renders.
    expect(fmtActual('p95', 250.5)).toBe('250ms');
    expect(fmtActual('p95', 251.5)).toBe('252ms');
    expect((250.5).toFixed(0)).toBe('251');
  });

  it('formats exactly as earlier releases did, for every metric and value', () => {
    const values = [0, 0.5, 1.5, 2.5, 249.6, 250.5, 251.5, 0.4, 0.125, 119.94, 1234.5];
    const keys = ['p95', 'avg', 'error', 'rps'];
    const ms = ['0ms', '0ms', '2ms', '2ms', '250ms', '250ms', '252ms', '0ms', '0ms', '120ms'];
    expect(keys.map((k) => values.map((v) => fmtActual(k, v)))).toEqual([
      [...ms, '1234ms'],
      [...ms, '1234ms'],
      [
        '0.00%',
        '0.50%',
        '1.50%',
        '2.50%',
        '249.60%',
        '250.50%',
        '251.50%',
        '0.40%',
        '0.12%',
        '119.94%',
        '1234.50%',
      ],
      ['0.0', '0.5', '1.5', '2.5', '249.6', '250.5', '251.5', '0.4', '0.1', '119.9', '1234.5'],
    ]);
  });
});
