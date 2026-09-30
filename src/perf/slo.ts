/**
 * Parse and evaluate an SLO gate against a k6 load-test summary.
 *
 * Rule syntax (comma-separated): `p95=300ms,error=1%,rps=100`
 *
 * - latency metrics (`avg` `min` `max` `p50` `p90` `p95` `p99`) — the value is an UPPER
 *   BOUND in ms (`300ms`, `1.5s` or a bare number).
 * - `error` — max allowed error rate, a percent (`1%` or `1`).
 * - `rps` — a LOWER BOUND on requests/second (the one "at least" metric).
 *
 * `evaluate` returns one result per rule; the load-test command fails (non-zero exit) if
 * any rule is not met — the CI-gate use case.
 *
 * THE THRESHOLD IS PARSED WITH `lib/format.parseFloat_`, not `Number`. `Number('')` is
 * 0, so an empty threshold would become a gate of zero that every run passes;
 * `parseFloat_('')` throws, and a gate that cannot be read must refuse rather than pass.
 */
import { formatFixed, parseFloat_ } from '../lib/format';

export const LATENCY_KEYS: ReadonlySet<string> = new Set([
  'avg',
  'min',
  'max',
  'p50',
  'p90',
  'p95',
  'p99',
]);

/** One parsed rule: its key, operator, threshold and raw text. */
export interface Rule {
  key: string;
  op: string;
  threshold: number;
  raw: string;
}

function parseMs(v: string): number {
  const text = v.trim().toLowerCase();
  if (text.endsWith('ms')) return parseFloat_(text.slice(0, -2));
  if (text.endsWith('s')) return parseFloat_(text.slice(0, -1)) * 1000;
  return parseFloat_(text);
}

/** Parse `"p95=300ms,error=1%"` into rules. */
export function parse(spec: string): Rule[] {
  const rules: Rule[] = [];
  for (const piece of spec.split(',')) {
    const part = piece.trim();
    if (!part) continue;
    if (!part.includes('=')) throw new Error(`bad rule '${part}' (expected key=value)`);
    const at = part.indexOf('=');
    const key = part.slice(0, at).trim().toLowerCase();
    const val = part.slice(at + 1).trim();
    if (LATENCY_KEYS.has(key)) {
      rules.push({ key, op: '<=', threshold: parseMs(val), raw: val });
    } else if (key === 'error') {
      rules.push({ key, op: '<=', threshold: parseFloat_(val.replace(/%+$/u, '')), raw: val });
    } else if (key === 'rps') {
      rules.push({ key, op: '>=', threshold: parseFloat_(val), raw: val });
    } else {
      throw new Error(`unknown metric '${key}' (use p50/p90/p95/p99/avg/min/max/error/rps)`);
    }
  }
  return rules;
}

/** The summary key each rule metric reads from (latency keys map to themselves). */
const SUMMARY_KEY: Readonly<Record<string, string>> = Object.freeze({
  error: 'error_rate',
  rps: 'rps',
});

function summaryKey(key: string): string {
  return SUMMARY_KEY[key] ?? key;
}

function actualOf(key: string, summary: Record<string, unknown>): number {
  const raw = summary[summaryKey(key)];
  // A null value becomes 0 rather than crashing; `measured` is what records that it was
  // not a real reading.
  const value = raw === null || raw === undefined ? 0.0 : Number(raw);
  return key === 'error' ? value * 100 : value;
}

export interface RuleResult extends Rule {
  actual: number;
  ok: boolean;
  measured: boolean;
}

/**
 * One result per rule.
 *
 * A rule whose metric is ABSENT from the summary is reported as not `measured` and FAILS
 * -- a metric that was not captured must never silently PASS at 0.0, which is what an
 * upper-bound rule would do.
 */
export function evaluate(rules: readonly Rule[], summary: Record<string, unknown>): RuleResult[] {
  const out: RuleResult[] = [];
  for (const { key, op, threshold, raw } of rules) {
    // A present-but-null value is not a real measurement -- it must fail as "not
    // measured", never pass at 0.0.
    const present = summary[summaryKey(key)];
    const measured = present !== null && present !== undefined;
    const actual = actualOf(key, summary);
    const ok = measured && (op === '<=' ? actual <= threshold : actual >= threshold);
    out.push({ key, op, threshold, raw, actual, ok, measured });
  }
  return out;
}

/** Human string for an observed value, matching the metric's unit. */
export function fmtActual(key: string, actual: number): string {
  if (LATENCY_KEYS.has(key)) return `${formatFixed(actual, 0)}ms`;
  if (key === 'error') return `${formatFixed(actual, 2)}%`;
  return formatFixed(actual, 1);
}
