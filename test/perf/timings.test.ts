import { Timings, fmtMs } from '../../src/perf/timings';

/** Samples chosen so the percentile ranks land on boundaries, not in the middle. */
const SAMPLES = [
  [],
  [42],
  [1, 2],
  [5, 1, 4, 2, 3],
  [10, 10, 10, 10],
  Array.from({ length: 100 }, (_x, i) => i + 1),
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 100],
];

describe('percentiles', () => {
  it('is 0 for an empty accumulator rather than throwing', () => {
    expect(new Timings().pct(95)).toBe(0);
    expect(new Timings().summary()).toEqual({ count: 0 });
    expect(new Timings().ratePerS(10)).toBe(0);
  });

  it('is nearest-rank on a sorted copy, leaving the input order alone', () => {
    const t = new Timings([5, 1, 4, 2, 3]);
    expect(t.pct(50)).toBe(3);
    expect(t.pct(100)).toBe(5);
    expect(t.pct(0)).toBe(1);
    expect(t.samplesMs).toEqual([5, 1, 4, 2, 3]);
  });

  it('answers what earlier releases answered for every percentile on every sample set', () => {
    const percentiles = [0, 1, 50, 90, 95, 99, 100];
    expect(SAMPLES.map((s) => percentiles.map((p) => new Timings([...s]).pct(p)))).toEqual([
      [0, 0, 0, 0, 0, 0, 0],
      [42, 42, 42, 42, 42, 42, 42],
      [1, 1, 1, 2, 2, 2, 2],
      [1, 1, 3, 5, 5, 5, 5],
      [10, 10, 10, 10, 10, 10, 10],
      [1, 1, 50, 90, 95, 99, 100],
      [1, 1, 1, 1, 100, 100, 100],
    ]);
  });

  it('summarises identically, key for key', () => {
    expect(SAMPLES.map((s) => new Timings([...s]).summary())).toEqual([
      { count: 0 },
      { count: 1, mean: 42, min: 42, max: 42, p50: 42, p90: 42, p95: 42, p99: 42 },
      { count: 2, mean: 1.5, min: 1, max: 2, p50: 1, p90: 2, p95: 2, p99: 2 },
      { count: 5, mean: 3, min: 1, max: 5, p50: 3, p90: 5, p95: 5, p99: 5 },
      { count: 4, mean: 10, min: 10, max: 10, p50: 10, p90: 10, p95: 10, p99: 10 },
      { count: 100, mean: 50.5, min: 1, max: 100, p50: 50, p90: 90, p95: 95, p99: 99 },
      { count: 10, mean: 10.9, min: 1, max: 100, p50: 1, p90: 1, p95: 100, p99: 100 },
    ]);
  });

  it('reports a rate only for a positive wall time', () => {
    const t = new Timings([1, 2, 3, 4]);
    expect(t.ratePerS(2)).toBe(2);
    expect(t.ratePerS(0)).toBe(0);
    expect(t.ratePerS(-1)).toBe(0);
  });
});

describe('the histogram', () => {
  it('is empty when there is nothing to show a shape of', () => {
    expect(new Timings([]).histogram()).toBe('');
    expect(new Timings([5]).histogram()).toBe('');
    expect(new Timings([5, 5, 5]).histogram()).toBe('');
  });

  it('is one width-1 character per bucket, from an ASCII ramp', () => {
    const strip = new Timings([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).histogram(8);
    expect(strip).toHaveLength(8);
    expect(strip).toMatch(/^[ .:\-=+*#]+$/u);
  });

  it('draws the strip earlier releases drew, including the tie-rounded cells', () => {
    // The ramp index is `c / cmax * 7` rounded, and earlier releases round half-to-EVEN --
    // so a bucket whose count is exactly half the maximum picks a different glyph under
    // `Math.round`. These sample sets are built to hit that.
    const buckets = [4, 8, 12];
    const mine = [
      ...SAMPLES,
      [1, 1, 2, 2, 2, 2, 3, 3],
      [1, 1, 1, 1, 2, 2, 3, 4],
      Array.from({ length: 64 }, (_x, i) => (i % 8) + 1),
    ].map((s) => buckets.map((b) => new Timings([...s]).histogram(b)));
    expect(mine).toEqual([
      ['', '', ''],
      ['', '', ''],
      ['#  #', '#      #', '#          #'],
      ['===#', '# # # ##', '#  #  #  # #'],
      ['', '', ''],
      ['####', '#*#**#*#', '#***#***#**#'],
      ['#  .', '#      .', '#          .'],
      ['= #=', '=   #  =', '=     #    ='],
      ['#=::', '# =  : :', '#   =   :  :'],
      ['####', '########', '## # ## # ##'],
    ]);
  });
});

describe('fmtMs', () => {
  it('switches to seconds at a thousand milliseconds', () => {
    expect(fmtMs(42)).toBe('42ms');
    expect(fmtMs(999)).toBe('999ms');
    expect(fmtMs(1000)).toBe('1.00s');
    expect(fmtMs(1234)).toBe('1.23s');
  });

  it('rounds the way earlier releases rounded at a tie', () => {
    expect(fmtMs(42.5)).toBe('42ms');
    expect(fmtMs(43.5)).toBe('44ms');
    expect((42.5).toFixed(0)).toBe('43');
  });

  it('formats exactly as earlier releases did, across the boundary', () => {
    const values = [0, 0.5, 1.5, 42, 42.5, 43.5, 999, 999.5, 1000, 1234, 1235, 1500.5, 60000];
    expect(values.map(fmtMs)).toEqual([
      '0ms',
      '0ms',
      '2ms',
      '42ms',
      '42ms',
      '44ms',
      '999ms',
      '1000ms',
      '1.00s',
      '1.23s',
      '1.24s',
      '1.50s',
      '60.00s',
    ]);
  });
});
