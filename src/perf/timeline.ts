/**
 * Latency-over-time from a k6 run.
 *
 * k6's `--out json` streams every measurement as a JSON line; this downsamples
 * `http_req_duration` (plus `http_req_failed`) into at most thirty time buckets, which is
 * what turns "p95 was 900ms" into "p95 was fine for 40s, then degraded as RAM filled" -- and
 * pins WHEN errors started.
 */
import * as fs from 'node:fs';

import { roundHalfEven } from '../lib/format';

import { fmtMs } from './timings';

/** A soak test can produce a huge stream -- bail politely rather than reading it all. */
export const MAX_BYTES = 200 * 1024 * 1024;
export const TARGET_BUCKETS = 30;

/** k6 emits nanosecond precision; the ISO reader takes at most six digits. */
const FRAC_RE = /\.(\d{6})\d+/u;

/**
 * One k6 timestamp as epoch seconds.
 *
 * Only DIFFERENCES of these are ever used -- `t - t0`, `span`, `first_error_s` -- so a
 * constant offset cancels, which is what makes the naive/aware question ISO parsing raises
 * here harmless.
 */
export function ts(iso: string): number {
  return Date.parse(iso.replace(FRAC_RE, '.$1')) / 1000;
}

function pct(sortedVals: readonly number[], p: number): number {
  if (sortedVals.length === 0) return 0.0;
  return sortedVals[
    Math.min(sortedVals.length - 1, Math.ceil((p / 100) * sortedVals.length) - 1)
  ] as number;
}

export interface Bucket {
  t0: number;
  reqs: number;
  p50: number;
  p95: number;
  max: number;
  errors: number;
}

export interface Timeline {
  width_s: number;
  span_s: number;
  buckets: Bucket[];
  first_error_s: number | null;
}

/**
 * The timeline, or null (no file, too big, or nothing usable).
 *
 * The `"Point"` prefilter runs BEFORE the JSON parse, because the stream can be millions
 * of lines and metric-definition lines never contain it.
 */
export function parse(path: string): Timeline | null {
  const durations: [number, number][] = [];
  const failures: number[] = [];
  try {
    if (!fs.existsSync(path) || fs.statSync(path).size > MAX_BYTES) return null;
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes('"Point"')) continue;
      if (line.includes('"http_req_duration"')) {
        const d = (JSON.parse(line) as { data: { time: string; value: number } }).data;
        durations.push([ts(d.time), Number(d.value)]);
      } else if (line.includes('"http_req_failed"')) {
        const d = (JSON.parse(line) as { data: { time: string; value: number } }).data;
        if (d.value) failures.push(ts(d.time));
      }
    }
  } catch {
    return null;
  }
  if (durations.length < 2) return null;

  const t0 = Math.min(...durations.map(([t]) => t));
  const span = Math.max(...durations.map(([t]) => t)) - t0;
  const width = Math.max(1, Math.ceil(span / TARGET_BUCKETS));
  const n = Math.floor(span / width) + 1;

  const per: number[][] = Array.from({ length: n }, () => []);
  const errs = new Array<number>(n).fill(0);
  for (const [t, ms] of durations) {
    (per[Math.min(n - 1, Math.trunc((t - t0) / width))] as number[]).push(ms);
  }
  for (const t of failures) {
    const i = Math.trunc((t - t0) / width);
    if (i >= 0 && i < n) errs[i] = (errs[i] as number) + 1;
  }

  const buckets: Bucket[] = per.map((vals, i) => {
    vals.sort((a, b) => a - b);
    return {
      t0: i * width,
      reqs: vals.length,
      p50: pct(vals, 50),
      p95: pct(vals, 95),
      max: vals.length > 0 ? (vals[vals.length - 1] as number) : 0.0,
      errors: errs[i] as number,
    };
  });
  const firstErr = buckets.find((b) => b.errors > 0)?.t0 ?? null;
  return { width_s: width, span_s: span, buckets, first_error_s: firstErr };
}

export interface SpikeRecovery {
  baseline_p95: number;
  spike_p95: number;
  /** null means it did not recover within the run. */
  recovered_after_s: number | null;
}

/**
 * For a `--spike` run (base third / peak third / recovery third): how long after the spike
 * ended did p95 return to at most 1.5x the pre-spike baseline?
 */
export function spikeRecovery(tl: Timeline): SpikeRecovery | null {
  const buckets = tl.buckets;
  if (buckets.length < 6) return null;
  const span = (buckets[buckets.length - 1] as Bucket).t0 + (tl.width_s || 1);
  const third = span / 3;
  const pre = buckets
    .filter((b) => b.t0 < third && b.reqs > 0)
    .map((b) => b.p95)
    .sort((a, b) => a - b);
  const mid = buckets
    .filter((b) => b.t0 >= third && b.t0 < 2 * third && b.reqs > 0)
    .map((b) => b.p95);
  const post = buckets.filter((b) => b.t0 >= 2 * third && b.reqs > 0);
  if (pre.length === 0 || post.length === 0) return null;
  // Median of the pre-spike third.
  const baseline = pre[Math.floor(pre.length / 2)] as number;
  const threshold = baseline * 1.5;
  const found = post.find((b) => b.p95 <= threshold);
  const recovered = found === undefined ? null : found.t0 - 2 * third;
  return {
    baseline_p95: baseline,
    spike_p95: mid.length > 0 ? Math.max(...mid) : 0.0,
    recovered_after_s: recovered === null ? null : roundHalfEven(recovered),
  };
}

/** ASCII only -- the same ramp as `timings.histogram`. */
const RAMP = ' .:-=+*#';

/** Two compact lines: p95 trend over the run, plus error positions if any. */
export function renderAscii(tl: Timeline): string[] {
  const buckets = tl.buckets;
  const p95s = buckets.map((b) => b.p95);
  const lo = Math.min(...p95s);
  const hi = Math.max(...p95s);
  const rng = hi - lo || 1.0;
  const chart = p95s
    .map((v) =>
      RAMP.charAt(Math.min(RAMP.length - 1, Math.trunc(((v - lo) / rng) * (RAMP.length - 1)))),
    )
    .join('');
  const lines = [
    `p95 over time   ${fmtMs(lo)} |${chart}| ${fmtMs(hi)}   ` +
      // `width_s` is a whole number of seconds (a ceiling), so it is written with `String`
      // and not a format spec -- `formatFixed` here would drop a fractional width that
      // a hand-built timeline could carry.
      `(${buckets.length} buckets of ${String(tl.width_s)}s)`,
  ];
  if (buckets.some((b) => b.errors > 0)) {
    const marks = buckets.map((b) => (b.errors > 0 ? 'x' : '.')).join('');
    lines.push(
      `errors          ${' '.repeat(fmtMs(lo).length)} |${marks}|   ` +
        `(first at ~${String(tl.first_error_s)}s)`,
    );
  }
  return lines;
}
