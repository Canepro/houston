/**
 * Render performance results -- a console summary table and a detailed shareable markdown
 * report.
 *
 * EVERY NUMBER HERE IS A FORMAT STRING, so all of them go through `lib/format`: `{:.0f}`
 * and `{:.1f}` are round-half-to-even, `{:.2%}` multiplies by a hundred first and then
 * applies the same tie rule, and `{:+.0f}` always shows a sign -- a bare `0` in a delta
 * column would read as "not measured" rather than "no meaningful change".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { pathExpandUser, joinPath } from '../lib/home';
import { formatFixed, formatPercent, formatSigned } from '../lib/format';

import { stepOrder } from './baseline';
import { fmtActual } from './slo';
import { fmtMs } from './timings';

type Bag = Record<string, unknown>;

const SCENARIO_DESC: Readonly<Record<string, string>> = Object.freeze({
  messages: 'POST `chat.postMessage` to `#general` — the write path.',
  login: 'POST `/api/v1/login` repeatedly — auth throughput.',
  read: 'GET `channels.history` — the read path.',
  mixed: '60% reads, 30% posts, 10% logins — a realistic blend.',
  journey:
    'a full user session per iteration — login → rooms → open → post → sync, each step timed.',
  webhook: 'POST through a real incoming-webhook integration — an alert-storm write path.',
  badbot: 'a badly-written client: tight unpaginated polling of history/users.list/channels.list.',
  custom: 'a caller-supplied endpoint.',
});

function asBag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

/**
 * The established truthiness of a value read out of an untyped bag.
 *
 * False for null, false, 0, '', [] and {} alike -- which is what every presence test on a
 * summary key means, and what a bare JavaScript truthiness test gets wrong for an empty
 * array or object.
 */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** `'2xx 1158 · 429 61 · 5xx 41'` from the summary's status buckets (non-zero only). */
export function statusBreakdown(summary: Bag): string {
  const st = asBag(summary.status);
  const order = ['2xx', '429', '4xx', '5xx', 'other'];
  return order
    .filter((k) => num(st[k]) !== 0)
    .map((k) => `${k} ${String(Math.trunc(num(st[k])))}`)
    .join(' · ');
}

/**
 * One metric cell, or `'-'` when the metric is ABSENT.
 *
 * A run that issued no requests emits no latency or checks keys at all, so a `?? 0` would
 * render "not measured" as a confident 0ms / 0%.
 */
export function cell(
  summary: Bag,
  key: string,
  render: (v: number) => string = (v) => `${formatFixed(v, 0)}ms`,
  bold = false,
): string {
  const v = summary[key];
  if (v === null || v === undefined) return '-';
  const s = render(Number(v));
  return bold ? `**${s}**` : s;
}

/** Whether the SLO held, and what the containers cost while it did. */
function reportGates(lines: string[], resources: Bag | null, sloResults: Bag[] | null): string[] {
  if (sloResults !== null && sloResults.length > 0) {
    const passed = sloResults.every((r) => truthy(r.ok));
    lines.push(
      `## SLO gate — ${passed ? 'PASS' : 'FAIL'}`,
      '',
      '| rule | threshold | actual | result |',
      '|---|---|---|---|',
    );
    for (const r of sloResults) {
      const mark = truthy(r.ok) ? 'PASS' : 'FAIL';
      const actual =
        r.measured === false ? 'not measured' : fmtActual(String(r.key), num(r.actual));
      lines.push(`| ${String(r.key)} | ${String(r.op)} ${String(r.raw)} | ${actual} | ${mark} |`);
    }
    lines.push('');
  }
  const res = asBag(resources);
  if (Object.keys(res).length > 0) {
    lines.push(
      '## Resource cost during the test',
      '',
      '| container | idle CPU | peak CPU | peak RAM | mem limit |',
      '|---|---|---|---|---|',
    );
    for (const cname of Object.keys(res).sort()) {
      const rr = asBag(res[cname]);
      lines.push(
        `| ${cname} | ${formatFixed(num(rr.idle_cpu), 0)}% | ` +
          `${formatFixed(num(rr.peak_cpu), 0)}% | ` +
          `${formatFixed(num(rr.peak_mem) / 1e6, 0)}MB | ` +
          `${formatFixed(num(rr.limit_mem) / 1e6, 0)}MB |`,
      );
    }
    lines.push('');
  }
  return lines;
}

/** Rocket.Chat's own metrics, Mongo's slow queries, and the comparison with a baseline. */
function reportDiagnosis(compare: Bag | null, diag: Bag | null, lines: string[]): string[] {
  const d = asBag(diag);
  const rcm = asBag(d.rcmetrics);
  if (Object.keys(rcm).length > 0) {
    lines.push(
      '## RC internals during the test',
      '',
      '| instance | event-loop lag peak | lag p99 | heap peak | ddp users |',
      '|---|---|---|---|---|',
    );
    for (const svc of Object.keys(rcm).sort()) {
      const m = asBag(rcm[svc]);
      const peak = asBag(m.eventloop_lag_max_s ?? m.eventloop_lag_s);
      const p99 = asBag(m.eventloop_lag_p99_s);
      const heap = asBag(m.heap_used_bytes);
      const ddp = asBag(m.ddp_users);
      const peakS = Object.keys(peak).length > 0 ? fmtMs(num(peak.max) * 1000) : '-';
      const p99S = Object.keys(p99).length > 0 ? fmtMs(num(p99.max) * 1000) : '-';
      const heapS = Object.keys(heap).length > 0 ? `${formatFixed(num(heap.max) / 1e6, 0)}MB` : '-';
      const ddpS = Object.keys(ddp).length > 0 ? formatFixed(num(ddp.max), 0) : '-';
      lines.push(`| ${svc} | ${peakS} | ${p99S} | ${heapS} | ${ddpS} |`);
    }
    lines.push(
      '',
      '> Event-loop lag is the Node saturation signal: once the loop lags, every request ' +
        'queues behind it.',
      '',
    );
  }
  const mg = asBag(d.mongo);
  const slow = Array.isArray(mg.slow) ? (mg.slow as Bag[]) : [];
  if (Object.keys(mg).length > 0 && (slow.length > 0 || num(mg.total) !== 0)) {
    lines.push(
      `## Slow MongoDB queries (${String(mg.total ?? 0)} profiled, ` +
        `${String(mg.collscan ?? 0)} COLLSCAN)`,
      '',
    );
    if (slow.length > 0) {
      lines.push(
        '| time | namespace | op | plan | docs examined | returned |',
        '|---|---|---|---|---|---|',
      );
      for (const s of slow) {
        lines.push(
          `| ${fmtMs(num(s.millis))} | ${String(s.ns)} | ${String(s.op)} | ` +
            `${String(s.plan) || '?'} | ${String(s.docs)} | ${String(s.ret)} |`,
        );
      }
    }
    lines.push('');
  }
  const cmp = asBag(compare);
  const rows = Array.isArray(cmp.rows) ? (cmp.rows as Bag[]) : [];
  if (rows.length > 0) {
    lines.push(
      `## vs baseline \`${String(cmp.label ?? '?')}\` ` +
        `(saved ${String(cmp.saved_at ?? '').slice(0, 19)})`,
      '',
      '| metric | baseline | this run | delta | |',
      '|---|---|---|---|---|',
    );
    for (const r of rows) {
      const metric = String(r.metric);
      const render = metric.includes('rps')
        ? (v: number) => formatFixed(v, 1)
        : metric.includes('error')
          ? (v: number) => formatPercent(v, 2)
          : (v: number) => fmtMs(v);
      const flag = truthy(r.flag)
        ? '**regression**'
        : !truthy(r.worse) && Math.abs(num(r.pct)) > 25
          ? 'improved'
          : '';
      lines.push(
        `| ${metric} | ${render(num(r.before))} | ${render(num(r.after))} | ` +
          `${formatSigned(num(r.pct), 0)}% | ${flag} |`,
      );
    }
    lines.push('');
  }
  return lines;
}

/** The responses, the verdict, the steps and the shape of the run over time. */
function reportWhatHappened(diag: Bag | null, lines: string[], summary: Bag): string[] {
  const responses = statusBreakdown(summary);
  if (responses) lines.push(`| responses | ${responses} |`);
  lines.push('');
  const d = asBag(diag);
  const verdict = Array.isArray(d.verdict) ? (d.verdict as string[]) : [];
  if (verdict.length > 0) {
    lines.push('## Verdict', '');
    for (const v of verdict) lines.push(`- ${v}`);
    lines.push('');
  }
  const steps = asBag(summary.steps);
  if (Object.keys(steps).length > 0) {
    lines.push(
      '## Per-step latency',
      '',
      '| step | count | p50 | p95 | p99 |',
      '|---|---|---|---|---|',
    );
    for (const s of stepOrder(steps)) {
      const v = asBag(steps[s]);
      lines.push(
        `| ${s} | ${formatFixed(num(v.count), 0)} | ${fmtMs(num(v.p50))} | ` +
          `${fmtMs(num(v.p95))} | ${fmtMs(num(v.p99))} |`,
      );
    }
    lines.push('');
  }
  const tl = asBag(d.timeline);
  if (Object.keys(tl).length > 0) {
    lines.push(
      `## Latency over time (${String(tl.width_s)}s buckets)`,
      '',
      '| t | reqs | p50 | p95 | max | errors |',
      '|---|---|---|---|---|---|',
    );
    for (const raw of (Array.isArray(tl.buckets) ? tl.buckets : []) as Bag[]) {
      const b = asBag(raw);
      lines.push(
        `| ${String(b.t0)}s | ${String(b.reqs)} | ${fmtMs(num(b.p50))} | ` +
          `${fmtMs(num(b.p95))} | ${fmtMs(num(b.max))} | ${truthy(b.errors) ? String(b.errors) : ''} |`,
      );
    }
    if (tl.first_error_s !== null && tl.first_error_s !== undefined) {
      lines.push('');
      lines.push(`> Errors began ~${String(tl.first_error_s)}s into the run.`);
    }
    lines.push('');
  }
  const sp = asBag(d.spike);
  if (Object.keys(sp).length > 0) {
    const rec = sp.recovered_after_s;
    lines.push(
      '## Spike recovery',
      '',
      `- baseline p95 ${fmtMs(num(sp.baseline_p95))} → spike p95 ` +
        `${fmtMs(num(sp.spike_p95))} → ` +
        (rec !== null && rec !== undefined
          ? `**recovered ~${String(rec)}s** after load dropped`
          : '**did not recover** within the run'),
      '',
    );
  }
  return lines;
}

/** What was run, against what, on what machine. */
function reportHeader(
  ctx: Bag,
  host: Bag,
  snapshot: Bag | null,
  summary: Bag,
  when: string,
): string[] {
  // A spike run's `vus` is the value the CLI told the user it was IGNORING, so reporting it
  // labelled the run as a load shape that never happened.
  const load =
    (truthy(ctx.spike)
      ? `spike ${String(ctx.spike)} VUs`
      : truthy(ctx.ramp)
        ? `ramp ${String(ctx.ramp)} VUs`
        : `${String(ctx.vus)} VUs`) + ` for ${String(ctx.duration)}`;
  const identity = truthy(ctx.users)
    ? `${String(ctx.users)} seeded users (round-robin per VU)`
    : 'the admin token';
  const lines = [
    '# houston load-test report',
    '',
    `- **Generated:** ${when}`,
    `- **Repro:** \`${String(ctx.name)}\` — Rocket.Chat ${String(ctx.version)}`,
    `- **Host:** ${String(host.os ?? '?')} · ${String(host.cpu ?? '?')} CPUs · ` +
      `Docker ${String(host.docker ?? '?')} · Compose ${String(host.compose ?? '?')}`,
    `- **Scenario:** \`${String(ctx.label ?? ctx.scenario)}\` — ` +
      `${SCENARIO_DESC[String(ctx.scenario)] ?? ''}`,
    `- **Load:** ${load}, as **${identity}**, generated by k6 on the repro's ` +
      `docker network (target \`${String(ctx.target)}\`)`,
    '',
    '> k6 drives load against the **internal** service address (no host-port round trip). ' +
      'The REST rate limiter is disabled for the run and restored after. Absolute numbers ' +
      'are host-specific; use them to compare runs on the same machine.',
    '',
  ];
  const snap = asBag(snapshot);
  if (Object.keys(snap).length > 0) {
    lines.push(
      '## Workspace',
      '',
      '| | |',
      '|---|---|',
      `| Rocket.Chat | ${String(snap.rc_version ?? '?')} |`,
      `| preset | ${String(snap.preset ?? '?')} |`,
      `| RC instances | ${String(snap.instances ?? 1)} |`,
    );
    for (const [k, lbl] of [
      ['users', 'users'],
      ['rooms', 'rooms'],
      ['messages', 'messages'],
    ] as const) {
      if (snap[k] !== null && snap[k] !== undefined) {
        lines.push(`| ${lbl} in workspace | ${String(snap[k])} |`);
      }
    }
    if (truthy(snap.constraints)) {
      lines.push(
        `| **resource caps** | ${String(snap.constraints)} (via docker update, ` +
          'restored after the test) |',
      );
    }
    lines.push('');
  }
  lines.push(
    '## Results',
    '',
    '| metric | value |',
    '|---|---|',
    `| requests | ${cell(summary, 'count', (v) => formatFixed(v, 0))} |`,
    `| throughput | ${cell(summary, 'rps', (v) => `${formatFixed(v, 1)} req/s`, true)} |`,
    `| latency p50 | ${cell(summary, 'p50')} |`,
    `| latency p90 | ${cell(summary, 'p90')} |`,
    `| latency p95 | ${cell(summary, 'p95', undefined, true)} |`,
    `| latency p99 | ${cell(summary, 'p99')} |`,
    `| latency avg / min / max | ${cell(summary, 'avg', (v) => formatFixed(v, 0))} / ` +
      `${cell(summary, 'min', (v) => formatFixed(v, 0))} / ` +
      `${cell(summary, 'max', (v) => formatFixed(v, 0))} ms |`,
    `| error rate | ${cell(summary, 'error_rate', (v) => formatPercent(v, 2))} |`,
    `| checks passed | ${cell(summary, 'checks_rate', (v) => formatPercent(v, 1))} |`,
  );
  return lines;
}

/** The UTC time to the second, as `YYYY-MM-DDTHH:MM:SS+00:00`. */
function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

export interface LoadtestExtras {
  snapshot?: Bag | null;
  compare?: Bag | null;
  diag?: Bag | null;
}

/**
 * Render a shareable load-test report.
 *
 * `ctx` carries the run parameters (repro, version, scenario, vus, duration, ramp, target,
 * users); `snapshot` the workspace context; `compare` an optional baseline diff
 * ({label, saved_at, rows}).
 */
export function loadtestMarkdown(
  ctx: Bag,
  summary: Bag,
  sloResults: Bag[] | null,
  resources: Bag | null,
  host: Bag,
  { snapshot = null, compare = null, diag = null }: LoadtestExtras = {},
): string {
  const when = nowIso();
  let lines = reportHeader(ctx, host, snapshot, summary, when);
  lines = reportWhatHappened(diag, lines, summary);
  lines = reportDiagnosis(compare, diag, lines);
  lines = reportGates(lines, resources, sloResults);
  return lines.join('\n') + '\n';
}

export function writeLoadtest(
  ctx: Bag,
  summary: Bag,
  sloResults: Bag[] | null,
  resources: Bag | null,
  host: Bag,
  stamp: string,
  dest: string | null = null,
  extras: LoadtestExtras = {},
): string {
  const filename = `loadtest-${String(ctx.scenario)}-${stamp}.md`;
  const md = loadtestMarkdown(ctx, summary, sloResults, resources, host, extras);
  return write(md, filename, dest);
}

/** Shareable markdown for a capacity search. */
export function writeCapacity(
  ctx: Bag,
  steps: Bag[],
  result: string,
  why: string,
  host: Bag,
  stamp: string,
  dest: string | null = null,
): string {
  const when = nowIso();
  const lines = [
    '# houston capacity report',
    '',
    `- **Generated:** ${when}`,
    `- **Repro:** \`${String(ctx.name)}\` — Rocket.Chat ${String(ctx.version)}`,
    `- **Host:** ${String(host.os ?? '?')} · ${String(host.cpu ?? '?')} CPUs · ` +
      `Docker ${String(host.docker ?? '?')} · Compose ${String(host.compose ?? '?')}`,
    `- **Workload:** \`${String(ctx.scenario)}\` as ` +
      `${truthy(ctx.users) ? String(ctx.users) : 'the admin token — no'} seeded users, ` +
      `steps of ${String(ctx.step_duration)} (target \`${String(ctx.target)}\`)`,
    `- **SLO:** \`${String(ctx.slo)}\``,
  ];
  if (truthy(ctx.constrained)) {
    lines.push(`- **Resource caps:** ${String(ctx.constrained)} (docker update, restored after)`);
  }
  lines.push('', `## Result — ${result}`, '');
  if (why !== '') lines.push(`> ${why}`, '');
  lines.push(
    '| VUs | req/s | p95 | error rate | event-loop lag peak | SLO |',
    '|---|---|---|---|---|---|',
  );
  for (const s of [...steps].sort((a, b) => num(a.vus) - num(b.vus))) {
    const breached = Array.isArray(s.breached) ? (s.breached as string[]) : [];
    lines.push(
      `| ${String(s.vus)} | ${formatFixed(num(s.rps), 1)} | ${fmtMs(num(s.p95))} | ` +
        `${formatFixed(num(s.error_rate) * 100, 2)}% | ` +
        `${fmtMs(num(s.lag_max_s) * 1000)} | ` +
        (truthy(s.ok) ? 'PASS' : `**FAIL** — ${breached.join('; ')}`) +
        ' |',
    );
  }
  lines.push(
    '',
    '> Steps double until the SLO breaks, then bisect between the last pass and first ' +
      'fail. Absolute numbers are host-specific; the shape (where it breaks, and why) is ' +
      'the signal.',
    '',
  );
  return write(lines.join('\n') + '\n', `capacity-${stamp}.md`, dest);
}

/** Write `content`; `dest` may be a file or a directory, default `reportsDir()`. */
function write(content: string, filename: string, dest: string | null): string {
  let target: string;
  if (dest !== null && dest !== '') {
    // `dest` with its `~` expanded and joined component by component (`pathExpandUser`):
    // an earlier version replaced a leading `~` alone, by `path.join`, so `~bob/r.md` went
    // into the current user's `bob/`, and a trailing or doubled `/` was printed in the path
    // the report was written to.
    const expanded = pathExpandUser(dest);
    let isDir: boolean;
    try {
      isDir = fs.statSync(expanded).isDirectory();
    } catch {
      isDir = false;
    }
    target = isDir || /[/\\]$/u.test(dest) ? joinPath(expanded, filename) : expanded;
  } else {
    target = joinPath(config.reportsDir(), filename);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}
