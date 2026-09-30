import * as fs from 'node:fs';
import * as path from 'node:path';

import { LAG_MAX_SAT_S, LAG_MEAN_WARN_S, analyze } from '../../src/perf/verdict';

/** The findings earlier releases produced for each scenario of the table below, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'perf', 'verdict.json'), 'utf8'),
) as { findings: string[][] };

const HEALTHY = { p95: 120, count: 1000, rps: 95.44, error_rate: 0.0001 };

describe('the nothing-was-measured guard', () => {
  it('refuses to say anything about a run that issued no requests', () => {
    // Every later default-to-zero read would take the absence as a measured 0ms, ending in "the
    // workspace has headroom at this load" for a test that never ran.
    expect(analyze({ count: 0, rps: 0 })[0]).toMatch(/No requests were recorded/u);
    expect(analyze({ p95: null, count: 5 })[0]).toMatch(/No requests were recorded/u);
    expect(analyze({})[0]).toMatch(/No requests were recorded/u);
    expect(analyze({ count: 0, rps: 0 })).toHaveLength(1);
  });
});

describe('the event loop', () => {
  it('calls a peak over half a second SATURATED', () => {
    const out = analyze(HEALTHY, {
      rcmetrics: { 'rocketchat-1': { eventloop_lag_max_s: { max: 0.9, mean: 0.05 } } },
    });
    expect(out[0]).toMatch(/RC event loop saturated: lag peaked at 900ms on rocketchat-1/u);
  });

  it('calls a sustained mean DEGRADED, and a lone peak neither', () => {
    // Degraded is judged on the mean, not a single peak -- one ~100ms peak is routine.
    const degraded = analyze(HEALTHY, {
      rcmetrics: { rc: { eventloop_lag_max_s: { max: 0.4, mean: 0.2 } } },
    });
    expect(degraded[0]).toMatch(/RC event loop degraded: lag averaged 200ms/u);

    const quiet = analyze(HEALTHY, {
      rcmetrics: { rc: { eventloop_lag_max_s: { max: 0.12, mean: 0.01 } } },
    });
    expect(quiet[0]).toMatch(/No saturation signals/u);
  });

  it('picks the WORST instance, by peak', () => {
    const out = analyze(HEALTHY, {
      rcmetrics: {
        'rocketchat-1': { eventloop_lag_max_s: { max: 0.6, mean: 0.1 } },
        'rocketchat-2': { eventloop_lag_max_s: { max: 0.9, mean: 0.1 } },
      },
    });
    expect(out[0]).toContain('on rocketchat-2');
  });

  it('falls back to the instantaneous gauge only when the histogram is absent', () => {
    const out = analyze(HEALTHY, {
      rcmetrics: { rc: { eventloop_lag_s: { max: 0.9, mean: 0.05 } } },
    });
    expect(out[0]).toMatch(/saturated/u);
  });
});

describe('mongo, resources and errors', () => {
  it('names the slowest COLLSCAN, not merely the slowest query', () => {
    // Citing a non-COLLSCAN row would point at the wrong query.
    const out = analyze(HEALTHY, {
      mongo: {
        collscan: 2,
        total: 5,
        slow: [
          { ns: 'rc.users', op: 'query', millis: 900, plan: 'IXSCAN' },
          { ns: 'rc.messages', op: 'query', millis: 400, plan: 'COLLSCAN' },
        ],
      },
    });
    expect(out[0]).toContain('slowest: rc.messages 400ms');
    expect(out[0]).toContain('likely a missing index');
  });

  it('reports the slowest query when there was no collection scan', () => {
    const out = analyze(HEALTHY, {
      mongo: {
        collscan: 0,
        total: 3,
        slow: [{ ns: 'rc.a', op: 'update', millis: 1500, plan: '' }],
      },
    });
    expect(out[0]).toContain('3 MongoDB quer(ies) exceeded');
    expect(out[0]).toContain('rc.a update 1.50s (no plan)');
  });

  it('does not blame RC for CPU when the event loop already explained it', () => {
    const withLag = analyze(HEALTHY, {
      rcmetrics: { rc: { eventloop_lag_max_s: { max: 0.9, mean: 0.5 } } },
      resources: { rocketchat: { peak_cpu: 99 }, mongodb: { peak_cpu: 10 } },
    });
    expect(withLag.join(' ')).not.toContain('likely CPU-bound in RC');

    const withoutLag = analyze(HEALTHY, {
      resources: { rocketchat: { peak_cpu: 99 }, mongodb: { peak_cpu: 10 } },
    });
    expect(withoutLag.join(' ')).toContain('likely CPU-bound in RC');
  });

  it('breaks the error rate down by status class and says when it started', () => {
    const out = analyze(
      { ...HEALTHY, error_rate: 0.15, status: { '429': 30, '5xx': 5, '4xx': 2 } },
      { timeline: { first_error_s: 12 } },
    );
    expect(out.join(' ')).toContain('15.0% of requests failed');
    expect(out.join(' ')).toContain('30x 429 (throttled), 5x 5xx (server errors), 2x 4xx');
    expect(out.join(' ')).toContain('starting ~12s into the run');
  });

  it('flags RAM growth only above the soak floor', () => {
    expect(analyze(HEALTHY, { soak: { mongodb: 40e6 } }).join(' ')).toContain(
      'mongodb RAM grew ~40MB/h',
    );
    expect(analyze(HEALTHY, { soak: { mongodb: 10e6 } }).join(' ')).not.toContain('RAM grew');
  });
});

describe('the fallbacks', () => {
  it('says so when latency is high and nothing server-side explains it', () => {
    const out = analyze({ ...HEALTHY, p95: 1500 });
    expect(out[0]).toMatch(/High client latency \(p95 1500ms\) without RC event-loop/u);
  });

  it('says there is headroom only when nothing at all fired', () => {
    expect(analyze(HEALTHY)[0]).toMatch(
      /No saturation signals: p95 120ms at 95\.4 req\/s, 0\.01% errors/u,
    );
  });
});

describe('held to earlier releases', () => {
  it('produces identical findings for every scenario', () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [HEALTHY, {}],
      [{ count: 0, rps: 0 }, {}],
      [{ p95: null, count: 5 }, {}],
      [
        HEALTHY,
        { rcmetrics: { 'rocketchat-1': { eventloop_lag_max_s: { max: 0.9, mean: 0.05 } } } },
      ],
      [HEALTHY, { rcmetrics: { rc: { eventloop_lag_max_s: { max: 0.4, mean: 0.2 } } } }],
      [
        HEALTHY,
        {
          rcmetrics: {
            'rocketchat-1': { eventloop_lag_max_s: { max: 0.6, mean: 0.1 } },
            'rocketchat-2': { eventloop_lag_max_s: { max: 0.9, mean: 0.1 } },
          },
        },
      ],
      [
        HEALTHY,
        {
          mongo: {
            collscan: 2,
            total: 5,
            slow: [
              { ns: 'rc.users', op: 'query', millis: 900, plan: 'IXSCAN' },
              { ns: 'rc.messages', op: 'query', millis: 400, plan: 'COLLSCAN' },
            ],
          },
        },
      ],
      [
        HEALTHY,
        {
          mongo: {
            collscan: 0,
            total: 3,
            slow: [{ ns: 'rc.a', op: 'update', millis: 1500, plan: '' }],
          },
        },
      ],
      [HEALTHY, { resources: { rocketchat: { peak_cpu: 99 }, mongodb: { peak_cpu: 10 } } }],
      [HEALTHY, { resources: { rocketchat: { peak_cpu: 10 }, mongodb: { peak_cpu: 99 } } }],
      [
        { ...HEALTHY, error_rate: 0.15, status: { '429': 30, '5xx': 5, '4xx': 2 } },
        { timeline: { first_error_s: 12 } },
      ],
      [HEALTHY, { soak: { mongodb: 40e6 } }],
      [HEALTHY, { spike: { recovered_after_s: null, baseline_p95: 120 } }],
      [HEALTHY, { spike: { recovered_after_s: 45, baseline_p95: 120 } }],
      [HEALTHY, { spike: { recovered_after_s: 5, baseline_p95: 120 } }],
      [{ ...HEALTHY, p95: 1500 }, {}],
      // Boundary values, where a half-rounding difference would show.
      [{ ...HEALTHY, rps: 95.45, error_rate: 0.000125 }, {}],
    ];
    // Earlier releases read `resources` values as per-service stats OBJECTS, by attribute,
    // with 0.0 for a missing one -- which finds nothing on a plain mapping and silently
    // answers 0.0. The recorded findings were therefore produced from these values as
    // objects; recording them from mappings would have held this build's real behaviour to
    // an answer computed from the wrong shape. Found by this test disagreeing.
    const mine = cases.map(([summary, kw]) => analyze(summary, kw));
    expect(mine).toEqual(RECORDED.findings);
  });

  it('uses the same thresholds', () => {
    expect([0.1, 0.5]).toEqual([LAG_MEAN_WARN_S, LAG_MAX_SAT_S]);
  });
});
