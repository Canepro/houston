/**
 * Latency accumulator: collect per-call durations, report the distribution.
 *
 * Dependency-free -- percentiles via nearest-rank on a sorted copy, which is fine for the
 * thousands of samples a seed or load run produces.
 *
 * THE NUMBERS ARE RENDERED, so they go through `lib/format`. `formatFixed(ms, 0)` rounds
 * half to EVEN and `toFixed(0)` rounds half away from zero, and a mean that lands on a half
 * is exactly the kind of value this module produces -- `sum(s) / n` over a round number of
 * samples. A report read beside one an earlier release wrote must not disagree by a digit.
 */
import { formatFixed, roundHalfEven } from '../lib/format';

/**
 * ASCII density ramp for the inline histogram -- width-1 in every terminal.
 *
 * No ambiguous-width Unicode block glyphs, which misalign on some terminals.
 */
const RAMP = ' .:-=+*#';

export interface TimingSummary {
  count: number;
  mean?: number;
  min?: number;
  max?: number;
  p50?: number;
  p90?: number;
  p95?: number;
  p99?: number;
}

export class Timings {
  readonly samplesMs: number[];

  constructor(samplesMs: number[] = []) {
    this.samplesMs = samplesMs;
  }

  add(ms: number): void {
    this.samplesMs.push(ms);
  }

  get length(): number {
    return this.samplesMs.length;
  }

  /** Nearest-rank percentile in ms (0 if empty). */
  pct(p: number): number {
    if (this.samplesMs.length === 0) return 0.0;
    const s = [...this.samplesMs].sort((a, b) => a - b);
    const k = Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1));
    return s[k] as number;
  }

  summary(): TimingSummary {
    const n = this.samplesMs.length;
    if (n === 0) return { count: 0 };
    const s = [...this.samplesMs].sort((a, b) => a - b);
    return {
      count: n,
      mean: s.reduce((a, b) => a + b, 0) / n,
      min: s[0] as number,
      max: s[s.length - 1] as number,
      p50: this.pct(50),
      p90: this.pct(90),
      p95: this.pct(95),
      p99: this.pct(99),
    };
  }

  ratePerS(wallS: number): number {
    return wallS > 0 ? this.samplesMs.length / wallS : 0.0;
  }

  /** A single-line ASCII density strip over `buckets` linear latency bins. */
  histogram(buckets = 12): string {
    if (this.samplesMs.length < 2) return '';
    const lo = Math.min(...this.samplesMs);
    const hi = Math.max(...this.samplesMs);
    if (hi <= lo) return '';
    const counts = new Array<number>(buckets).fill(0);
    const span = hi - lo;
    for (const v of this.samplesMs) {
      // Truncated toward zero; the ratio is never negative here.
      const i = Math.min(buckets - 1, Math.trunc(((v - lo) / span) * buckets));
      counts[i] = (counts[i] as number) + 1;
    }
    const cmax = Math.max(...counts) || 1;
    return counts
      .map((c) =>
        RAMP.charAt(Math.min(RAMP.length - 1, roundHalfEven((c / cmax) * (RAMP.length - 1)))),
      )
      .join('');
  }
}

/** Human latency: 42ms, 1.20s. */
export function fmtMs(ms: number): string {
  return ms < 1000 ? `${formatFixed(ms, 0)}ms` : `${formatFixed(ms / 1000, 2)}s`;
}
