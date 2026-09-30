import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_BYTES,
  TARGET_BUCKETS,
  parse,
  renderAscii,
  spikeRecovery,
  type Timeline,
} from '../../src/perf/timeline';

/** The timeline earlier releases parsed out of the comparison stream below, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'perf', 'timeline.json'), 'utf8'),
) as { parse: Timeline };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-timeline-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A k6 `--out json` stream.
 *
 * Includes the two line shapes that must be SKIPPED: a Metric definition (no `"Point"`)
 * and a Point for a metric this does not track.
 */
function stream(points: [number, number, boolean][]): string {
  const lines = ['{"type":"Metric","metric":"http_req_duration","data":{"name":"x"}}'];
  for (const [offsetMs, value, failed] of points) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMs).toISOString();
    const stamped = at.replace(/\.(\d{3})Z$/u, '.$1000000Z');
    lines.push(
      `{"type":"Point","metric":"http_req_duration","data":{"time":"${stamped}","value":${value}}}`,
    );
    lines.push(
      `{"type":"Point","metric":"http_req_failed","data":{"time":"${stamped}","value":${failed ? 1 : 0}}}`,
    );
    lines.push(`{"type":"Point","metric":"vus","data":{"time":"${stamped}","value":5}}`);
  }
  return lines.join('\n') + '\n';
}

function write(name: string, body: string): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, body);
  return target;
}

describe('parse', () => {
  it('answers null for a missing file, an empty one, and one with a single point', () => {
    expect(parse(path.join(dir, 'nope.json'))).toBeNull();
    expect(parse(write('empty.json', ''))).toBeNull();
    expect(parse(write('one.json', stream([[0, 100, false]])))).toBeNull();
  });

  it('answers null rather than reading a stream over the cap', () => {
    // A soak test can produce a huge stream; bailing politely is the contract.
    const target = write('big.json', 'x');
    fs.truncateSync(target, MAX_BYTES + 1);
    expect(parse(target)).toBeNull();
    expect(TARGET_BUCKETS).toBe(30);
  });

  it('answers null for malformed JSON rather than throwing', () => {
    expect(
      parse(write('bad.json', '{"type":"Point","metric":"http_req_duration" BROKEN\n')),
    ).toBeNull();
  });

  it('buckets the run and pins when errors started', () => {
    const points: [number, number, boolean][] = [];
    for (let i = 0; i < 60; i += 1) points.push([i * 1000, 100 + i, i >= 40]);
    const tl = parse(write('run.json', stream(points)));
    expect(tl).not.toBeNull();
    expect(tl?.buckets.length).toBeLessThanOrEqual(TARGET_BUCKETS + 1);
    expect(tl?.first_error_s).not.toBeNull();
    expect(tl?.buckets.reduce((a, b) => a + b.reqs, 0)).toBe(60);
  });

  it('parses a stream identically to earlier releases', () => {
    const points: [number, number, boolean][] = [];
    for (let i = 0; i < 60; i += 1) points.push([i * 1000, 100 + i * 3, i >= 40]);
    const target = write('cmp.json', stream(points));
    expect(parse(target)).toEqual(RECORDED.parse);
  });
});

describe('spikeRecovery', () => {
  function timeline(p95s: number[]): Timeline {
    return {
      width_s: 1,
      span_s: p95s.length,
      buckets: p95s.map((p95, i) => ({ t0: i, reqs: 10, p50: p95 / 2, p95, max: p95, errors: 0 })),
      first_error_s: null,
    };
  }

  it('needs at least six buckets to say anything', () => {
    expect(spikeRecovery(timeline([1, 2, 3]))).toBeNull();
  });

  it('reports how long after the spike p95 came back', () => {
    const out = spikeRecovery(timeline([100, 100, 100, 900, 900, 900, 800, 120, 110]));
    expect(out?.baseline_p95).toBe(100);
    expect(out?.spike_p95).toBe(900);
    expect(out?.recovered_after_s).toBeGreaterThan(0);
  });

  it('says null when it never came back within the run', () => {
    const out = spikeRecovery(timeline([100, 100, 100, 900, 900, 900, 900, 900, 900]));
    expect(out?.recovered_after_s).toBeNull();
  });

  it('answers what earlier releases answered for every shape', () => {
    const shapes = [
      [1, 2, 3],
      [100, 100, 100, 900, 900, 900, 800, 120, 110],
      [100, 100, 100, 900, 900, 900, 900, 900, 900],
      [100, 100, 100, 900, 900, 900, 100, 100, 100],
      [50, 60, 70, 80, 90, 100],
    ];
    expect(shapes.map((s) => spikeRecovery(timeline(s)))).toEqual([
      null,
      { baseline_p95: 100, spike_p95: 900, recovered_after_s: 1 },
      { baseline_p95: 100, spike_p95: 900, recovered_after_s: null },
      { baseline_p95: 100, spike_p95: 900, recovered_after_s: 0 },
      { baseline_p95: 60, spike_p95: 80, recovered_after_s: 0 },
    ]);
  });
});

describe('renderAscii', () => {
  it('draws one strip, and an error row only when there were errors', () => {
    const tl: Timeline = {
      width_s: 2,
      span_s: 10,
      buckets: [100, 200, 900, 300, 100].map((p95, i) => ({
        t0: i * 2,
        reqs: 5,
        p50: p95 / 2,
        p95,
        max: p95,
        errors: i === 2 ? 3 : 0,
      })),
      first_error_s: 4,
    };
    const lines = renderAscii(tl);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('p95 over time');
    expect(lines[0]).toContain('(5 buckets of 2s)');
    expect(lines[1]).toContain('..x..');
    expect(lines[1]).toContain('first at ~4s');
  });

  it('renders exactly the lines earlier releases rendered', () => {
    const tls: Timeline[] = [
      {
        width_s: 2,
        span_s: 10,
        buckets: [100, 200, 900, 300, 100].map((p95, i) => ({
          t0: i * 2,
          reqs: 5,
          p50: p95 / 2,
          p95,
          max: p95,
          errors: i === 2 ? 3 : 0,
        })),
        first_error_s: 4,
      },
      {
        width_s: 1,
        span_s: 3,
        buckets: [100, 100, 100].map((p95, i) => ({
          t0: i,
          reqs: 1,
          p50: p95,
          p95,
          max: p95,
          errors: 0,
        })),
        first_error_s: null,
      },
    ];
    expect(tls.map(renderAscii)).toEqual([
      [
        'p95 over time   100ms |  #. | 900ms   (5 buckets of 2s)',
        'errors                |..x..|   (first at ~4s)',
      ],
      ['p95 over time   100ms |   | 100ms   (3 buckets of 1s)'],
    ]);
  });
});
