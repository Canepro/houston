/**
 * Rule-based diagnosis of a load-test run.
 *
 * Combines the client-side result (latency and errors) with the server-side signals a
 * `--diag` run collects -- RC's event-loop lag, Mongo's slow-query profile, container CPU --
 * into a few plain-language findings: not "p95 was 900ms" but "RC's event loop saturated;
 * Mongo was idle — the Node process is the bottleneck".
 *
 * Deliberately hedged wording ("likely") and simple thresholds; this is triage evidence
 * for a ticket, not an oracle.
 *
 * EVERY NUMBER HERE IS RENDERED INTO A SENTENCE somebody pastes into a ticket, so the
 * format strings go through `lib/format`. `formatFixed(x, 0)` rounds half to even and
 * `toFixed` does not, and a CPU peak of exactly 85.5% is not an unusual reading.
 */
import { formatFixed } from '../lib/format';

import { fmtMs } from './timings';

/** Node event-loop lag: >100ms mean is degraded, >500ms peak is saturated. */
export const LAG_MEAN_WARN_S = 0.1;
export const LAG_MAX_SAT_S = 0.5;

type Bag = Record<string, unknown>;

function asBag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Rocket.Chat's own event-loop lag, which is the first thing to break under load.
 *
 * Judged by the per-interval lag HISTOGRAM peak (`eventloop_lag_max_s`); the instantaneous
 * gauge samples BETWEEN stalls and stays near zero even while requests queue.
 */
function eventLoopFinding(findings: string[], rcmetrics: Bag | null | undefined): boolean {
  let worstSvc: string | null = null;
  let worst: { max: number; mean: number } | null = null;
  for (const [svc, raw] of Object.entries(asBag(rcmetrics))) {
    const m = asBag(raw);
    const lagRaw = m.eventloop_lag_max_s ?? m.eventloop_lag_s;
    const lag = asBag(lagRaw);
    // An empty mapping counts as absent, and so does a missing key.
    if (Object.keys(lag).length === 0) continue;
    const candidate = { max: num(lag.max), mean: num(lag.mean) };
    if (worst === null || candidate.max > worst.max) {
      worstSvc = svc;
      worst = candidate;
    }
  }
  if (worst === null) return false;
  if (worst.max >= LAG_MAX_SAT_S) {
    findings.push(
      `RC event loop saturated: lag peaked at ${fmtMs(worst.max * 1000)} on ${String(worstSvc)} — ` +
        'the Node process is the bottleneck; more CPU or more instances (multi-instance ' +
        'preset) will help.',
    );
    return true;
  }
  if (worst.mean >= LAG_MEAN_WARN_S) {
    // Degraded is judged on the SUSTAINED lag (mean), not a lone peak -- a single ~100ms
    // peak is routine and should not read as "degraded".
    findings.push(
      `RC event loop degraded: lag averaged ${fmtMs(worst.mean * 1000)} (peaks to ` +
        `${fmtMs(worst.max * 1000)}) on ${String(worstSvc)} — approaching CPU saturation ` +
        'at this load.',
    );
    return true;
  }
  return false;
}

/** Slow queries and the container that ran out of what it was given. */
function mongoAndResourceFindings(
  findings: string[],
  lagFound: boolean,
  mongo: Bag | null | undefined,
  resources: Bag | null | undefined,
): void {
  const m = asBag(mongo);
  // Absent for null and for an empty mapping alike.
  if (Object.keys(m).length > 0) {
    const slow = Array.isArray(m.slow) ? (m.slow as Bag[]) : [];
    if (num(m.collscan) > 0) {
      // Name the slowest COLLSCAN only if one made the top list -- citing a non-COLLSCAN
      // row here would point at the wrong query.
      const top = slow.find((s) => String(s.plan ?? '').includes('COLLSCAN'));
      const where =
        top !== undefined ? ` — slowest: ${String(top.ns)} ${fmtMs(num(top.millis))}` : '';
      findings.push(
        `MongoDB ran ${String(m.collscan)} collection scan(s) (COLLSCAN) among the ` +
          `profiled slow queries — likely a missing index${where}.`,
      );
    } else if (slow.length > 0) {
      const top = slow[0] as Bag;
      const total = m.total ?? slow.length;
      findings.push(
        `${String(total)} MongoDB quer(ies) exceeded the slow threshold — slowest: ` +
          `${String(top.ns)} ${String(top.op)} ${fmtMs(num(top.millis))} ` +
          `(${String(top.plan) || 'no plan'}).`,
      );
    }
  }

  // Where the CPU actually went (needs --stats).
  const r = asBag(resources);
  // The same shape: absent for null and for an empty mapping.
  if (Object.keys(r).length > 0) {
    const peaks: Record<string, number> = {};
    for (const [svc, st] of Object.entries(r)) peaks[svc] = num(asBag(st).peak_cpu);
    const rcPeaks = Object.entries(peaks)
      .filter(([k]) => k.startsWith('rocketchat'))
      .map(([, v]) => v);
    const rcPeak = rcPeaks.length > 0 ? Math.max(...rcPeaks) : 0.0;
    const mongoPeak = peaks.mongodb ?? 0.0;
    if (mongoPeak > 85 && mongoPeak > rcPeak * 1.5) {
      findings.push(
        `MongoDB was the hot container (${formatFixed(mongoPeak, 0)}% CPU vs RC ` +
          `${formatFixed(rcPeak, 0)}%) — likely Mongo-bound at this load.`,
      );
    } else if (rcPeak > 85 && rcPeak > mongoPeak * 1.5 && !lagFound) {
      findings.push(
        `Rocket.Chat was the hot container (${formatFixed(rcPeak, 0)}% CPU vs Mongo ` +
          `${formatFixed(mongoPeak, 0)}%) — likely CPU-bound in RC.`,
      );
    }
  }
}

/** What an error rate means depends on which errors they were. */
function errorRateFinding(
  findings: string[],
  summary: Bag,
  timeline: Bag | null | undefined,
): void {
  const err = num(summary.error_rate);
  if (err <= 0.01) return;
  const st = asBag(summary.status);
  const kinds: string[] = [];
  if (num(st['429']) > 0) kinds.push(`${Math.trunc(num(st['429']))}x 429 (throttled)`);
  if (num(st['5xx']) > 0) kinds.push(`${Math.trunc(num(st['5xx']))}x 5xx (server errors)`);
  if (num(st['4xx']) > 0) kinds.push(`${Math.trunc(num(st['4xx']))}x 4xx`);
  // Only a timeline that is present and holds a `first_error_s`.
  const t = asBag(timeline);
  const firstError = t.first_error_s;
  const when =
    Object.keys(t).length > 0 && firstError !== null && firstError !== undefined
      ? `, starting ~${String(firstError)}s into the run`
      : '';
  findings.push(
    `${formatFixed(err * 100, 1)}% of requests failed` +
      (kinds.length > 0 ? `: ${kinds.join(', ')}` : '') +
      when +
      '.',
  );
}

export interface AnalyzeOptions {
  rcmetrics?: Bag | null;
  mongo?: Bag | null;
  resources?: Bag | null;
  timeline?: Bag | null;
  /** `{container: bytes_per_hour}` RAM slopes from a long run. */
  soak?: Bag | null;
  /** `timeline.spikeRecovery()`'s result for a `--spike` run. */
  spike?: Bag | null;
}

/** 1-5 plain-language findings, most important first. */
export function analyze(summary: Bag, options: AnalyzeOptions = {}): string[] {
  const {
    rcmetrics = null,
    mongo = null,
    resources = null,
    timeline = null,
    soak = null,
    spike = null,
  } = options;
  const findings: string[] = [];

  // NOTHING WAS MEASURED. A run that issued no requests emits no latency keys at all
  // (handleSummary drops undefined values), and every `num(...)` below would read that
  // absence as a measured 0ms -- ending in "the workspace has headroom at this load" for a
  // test that never ran.
  if (summary.p95 === null || summary.p95 === undefined || summary.count === 0) {
    return [
      'No requests were recorded, so this run says nothing about the workspace - the ' +
        'load generator produced no measurements. Check that k6 could reach the target ' +
        'and that the scenario ran.',
    ];
  }

  // Spike recovery -- only worth a finding when it did NOT bounce back.
  const sp = asBag(spike);
  // A spike is absent for null AND for an empty mapping, so the emptiness check is the
  // whole guard.
  if (Object.keys(sp).length > 0) {
    const recovered = sp.recovered_after_s;
    if (recovered === null || recovered === undefined) {
      findings.push(
        'Did not recover from the spike within the run: p95 stayed above 1.5x the ' +
          `pre-spike baseline (${fmtMs(num(sp.baseline_p95))}) after load dropped — ` +
          'connections/queues are not draining.',
      );
    } else if (num(recovered) > 30) {
      findings.push(
        `Slow spike recovery: p95 took ~${String(recovered)}s to return to normal after ` +
          `load dropped (baseline ${fmtMs(num(sp.baseline_p95))}).`,
      );
    }
  }

  const lagFound = eventLoopFinding(findings, rcmetrics);
  mongoAndResourceFindings(findings, lagFound, mongo, resources);
  errorRateFinding(findings, summary, timeline);

  // Sustained-run RAM growth (soak signal) -- only reported for long runs.
  for (const [svc, raw] of Object.entries(asBag(soak))) {
    const perHour = num(raw);
    // > ~30MB/h upward is worth an eyebrow.
    if (perHour > 30e6) {
      findings.push(
        `${svc} RAM grew ~${formatFixed(perHour / 1e6, 0)}MB/h over this sustained run — ` +
          'if a longer soak repeats this slope, treat it as a leak candidate.',
      );
    }
  }

  // High client latency with NO server-side signal: time is being spent queueing outside
  // the event loop (CPU throttling/CFS, Mongo waits, connection backlog) -- say so instead
  // of a false "healthy".
  if (findings.length === 0 && num(summary.p95) >= 1000) {
    findings.push(
      `High client latency (p95 ${formatFixed(num(summary.p95), 0)}ms) without RC ` +
        'event-loop saturation — requests are queueing outside the Node loop (CPU ' +
        "throttling, Mongo waits, or connection backlog). If this run was --constrain'ed, " +
        "that's the cap at work.",
    );
  }

  if (findings.length === 0) {
    findings.push(
      `No saturation signals: p95 ${formatFixed(num(summary.p95), 0)}ms at ` +
        `${formatFixed(num(summary.rps), 1)} req/s, ` +
        `${formatFixed(num(summary.error_rate) * 100, 2)}% errors — the workspace has ` +
        'headroom at this load.',
    );
  }
  return findings;
}
