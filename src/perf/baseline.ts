/**
 * Saved load-test baselines.
 *
 * `--save LABEL` writes a run to `~/.houston/loadtests/<label>.json`; `--compare LABEL` diffs
 * the current run against it -- the "did my fix or setting change actually help?" workflow.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { joinPath } from '../lib/home';

const LABEL_RE = /[^a-z0-9_-]+/gu;

/** How much worse a latency or error metric may get before the delta is flagged. */
export const REGRESS_PCT = 25.0;

/**
 * Minimum ABSOLUTE error-rate move (a fraction) before a delta counts.
 *
 * Keeps a 0.1% -> 0.2% blip from flagging while a 0% -> 5% jump does.
 */
export const ERROR_ABS_FLOOR = 0.005;

/** Filesystem-safe baseline name; throws if nothing survives. */
export function sanitizeLabel(label: string): string {
  const clean = label
    .trim()
    .toLowerCase()
    .replace(LABEL_RE, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '');
  if (!clean) throw new Error(`'${label}' is not a usable baseline name`);
  return clean;
}

export function baselinesDir(): string {
  return joinPath(config.home(), 'loadtests');
}

export function baselinePath(label: string): string {
  return joinPath(baselinesDir(), `${sanitizeLabel(label)}.json`);
}

export function save(label: string, payload: unknown): string {
  const target = baselinePath(label);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  return target;
}

export function load(label: string): Record<string, unknown> {
  const target = baselinePath(label);
  if (!fs.existsSync(target)) {
    throw new Error(
      `no saved baseline '${sanitizeLabel(label)}' (looked in ${path.dirname(target)})`,
    );
  }
  return JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
}

export interface Delta {
  metric: string;
  before: number;
  after: number;
  pct: number;
  worse: boolean;
  flag: boolean;
}

function delta(metric: string, before: number, after: number, higherIsBetter: boolean): Delta {
  // `pct` is undefined against a zero baseline (it stays 0 for display); the worse/flag
  // decision then falls back to the absolute move, so a metric that was 0 in the baseline
  // and regressed is not silently reported as unchanged.
  const pct = before ? (after / before - 1) * 100 : 0.0;
  const worse = higherIsBetter ? after < before : after > before;
  let flag: boolean;
  if (metric.includes('error')) {
    // Errors need a MEANINGFUL absolute move (ignoring 0.1% -> 0.2%) and, when there is a
    // baseline to divide by, a real percentage jump too -- but a 0% baseline going
    // non-zero always counts.
    flag =
      worse &&
      Math.abs(after - before) >= ERROR_ABS_FLOOR &&
      (!before || Math.abs(pct) > REGRESS_PCT);
  } else {
    flag = worse && (!before || Math.abs(pct) > REGRESS_PCT);
  }
  return { metric, before, after, pct, worse, flag };
}

const CANONICAL_STEPS: readonly string[] = Object.freeze([
  'login',
  'rooms',
  'open',
  'post',
  'sync',
  'read',
]);

/** Canonical step order for display (journey flow first, extras appended). */
export function stepOrder(steps: Record<string, unknown>): string[] {
  const known = CANONICAL_STEPS.filter((s) => s in steps);
  const extras = Object.keys(steps)
    .filter((s) => !CANONICAL_STEPS.includes(s))
    .sort();
  return [...known, ...extras];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Delta rows between the current summary and a baseline's, most-important first:
 * throughput, overall latency percentiles, error rate, then per-step p95 for every step
 * both runs measured.
 */
export function compare(current: Record<string, unknown>, base: Record<string, unknown>): Delta[] {
  const curS = asRecord(current.summary);
  const baseS = asRecord(base.summary);
  const rows: Delta[] = [];

  const add = (metric: string, key: string, higherIsBetter = false): void => {
    const b = baseS[key];
    const a = curS[key];
    if (b !== null && b !== undefined && a !== null && a !== undefined) {
      rows.push(delta(metric, Number(b), Number(a), higherIsBetter));
    }
  };

  add('throughput (rps)', 'rps', true);
  add('p50', 'p50');
  add('p95', 'p95');
  add('p99', 'p99');
  add('error rate', 'error_rate');

  const curSteps = asRecord(curS.steps);
  const baseSteps = asRecord(baseS.steps);
  for (const name of stepOrder(curSteps).filter((s) => s in baseSteps)) {
    const b = asRecord(baseSteps[name]).p95;
    const a = asRecord(curSteps[name]).p95;
    if (b !== null && b !== undefined && a !== null && a !== undefined) {
      rows.push(delta(`step ${name} p95`, Number(b), Number(a), false));
    }
  }
  return rows;
}
