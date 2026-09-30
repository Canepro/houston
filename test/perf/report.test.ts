import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from '../../src/lib/config';

import type * as ReportNS from '../../src/perf/report';
import {
  cell,
  loadtestMarkdown,
  statusBreakdown,
  writeCapacity,
  writeLoadtest,
} from '../../src/perf/report';

/**
 * The reports earlier releases rendered for the cases below, recorded with the one line that
 * names an instant masked: each load-test markdown's `Generated` line reads
 * `- **Generated:** <when>`, and the capacity report's is the bare `<when>`.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'perf', 'report.json'), 'utf8'),
) as {
  markdown: Record<'full' | 'minimal' | 'empty' | 'spike' | 'ramp', string>;
  capacity: string;
};

const CTX = {
  name: 'TICKET-1234',
  version: '8.5.1',
  scenario: 'messages',
  vus: 25,
  duration: '60s',
  ramp: null,
  spike: null,
  target: 'http://rocketchat:3000',
  users: 10,
};

const SUMMARY = {
  count: 1260,
  rps: 20.95,
  p50: 120.4,
  p90: 240.5,
  p95: 310.5,
  p99: 900,
  avg: 150.5,
  min: 12,
  max: 1800,
  error_rate: 0.0125,
  checks_rate: 0.995,
  status: { '2xx': 1158, '429': 61, '5xx': 41, '4xx': 0 },
  steps: {
    login: { count: 100, p50: 50, p95: 80, p99: 90 },
    post: { count: 200, p50: 20, p95: 30, p99: 40 },
  },
};

const HOST = { os: 'Linux', cpu: 8, docker: '27.0', compose: 'v2.29' };

/**
 * Earlier releases read `resources` as attributes of objects, not as keys, so the recorded
 * reports were rendered from these values as objects -- the same trap the verdict
 * comparison hit.
 */
const RESOURCES = {
  rocketchat: { idle_cpu: 5.5, peak_cpu: 92.5, peak_mem: 900e6, limit_mem: 2e9 },
  mongodb: { idle_cpu: 1.5, peak_cpu: 40.5, peak_mem: 300e6, limit_mem: 2e9 },
};

const SLO_RESULTS = [
  { key: 'p95', op: '<=', threshold: 300, raw: '300ms', actual: 310.5, ok: false, measured: true },
  { key: 'rps', op: '>=', threshold: 10, raw: '10', actual: 20.95, ok: true, measured: true },
  { key: 'p99', op: '<=', threshold: 1000, raw: '1s', actual: 0, ok: false, measured: false },
];

const DIAG = {
  verdict: ['RC event loop saturated: lag peaked at 900ms on rocketchat-1'],
  rcmetrics: {
    'rocketchat-1': {
      eventloop_lag_max_s: { max: 0.9, mean: 0.2, last: 0.3, n: 10 },
      eventloop_lag_p99_s: { max: 0.7, mean: 0.1, last: 0.2, n: 10 },
      heap_used_bytes: { max: 512e6, mean: 400e6, last: 500e6, n: 10 },
      ddp_users: { max: 25, mean: 20, last: 22, n: 10 },
    },
  },
  mongo: {
    total: 12,
    collscan: 2,
    slow: [
      { ns: 'rc.messages', op: 'query', millis: 1500, plan: 'COLLSCAN', docs: 90000, ret: 50 },
    ],
  },
  timeline: {
    width_s: 2,
    span_s: 10,
    buckets: [100, 200, 900, 300, 100].map((p95, i) => ({
      t0: i * 2,
      reqs: 5,
      p50: p95 / 2,
      p95,
      max: p95 * 2,
      errors: i === 2 ? 3 : 0,
    })),
    first_error_s: 4,
  },
  spike: { baseline_p95: 120, spike_p95: 900, recovered_after_s: 8 },
};

const COMPARE = {
  label: 'before-fix',
  saved_at: '2026-09-01T10:00:00+00:00',
  rows: [
    {
      metric: 'throughput (rps)',
      before: 30.0,
      after: 20.95,
      pct: -30.17,
      worse: true,
      flag: true,
    },
    { metric: 'p95', before: 200.0, after: 310.5, pct: 55.25, worse: true, flag: true },
    { metric: 'error rate', before: 0.001, after: 0.0125, pct: 1150.0, worse: true, flag: true },
    { metric: 'p50', before: 200.0, after: 120.4, pct: -39.8, worse: false, flag: false },
  ],
};

const SNAPSHOT = {
  rc_version: '8.5.1',
  preset: 'default',
  instances: 2,
  users: 500,
  rooms: 50,
  messages: null,
  constraints: 'rc=2cpu/2g',
};

describe('statusBreakdown', () => {
  it('lists non-zero buckets only, in a fixed order', () => {
    expect(statusBreakdown(SUMMARY)).toBe('2xx 1158 · 429 61 · 5xx 41');
    expect(statusBreakdown({})).toBe('');
    expect(statusBreakdown({ status: { '4xx': 0 } })).toBe('');
  });

  it('breaks down exactly as earlier releases did', () => {
    const cases = [SUMMARY, {}, { status: { '4xx': 0 } }, { status: { other: 3, '2xx': 1 } }];
    expect(cases.map(statusBreakdown)).toEqual([
      '2xx 1158 · 429 61 · 5xx 41',
      '',
      '',
      '2xx 1 · other 3',
    ]);
  });
});

describe('cell', () => {
  it('renders an ABSENT metric as a dash, not a confident zero', () => {
    // A run that issued no requests emits no latency keys at all; `?? 0` would report
    // "not measured" as 0ms.
    expect(cell({}, 'p95')).toBe('-');
    expect(cell({ p95: null }, 'p95')).toBe('-');
    expect(cell({ p95: 0 }, 'p95')).toBe('0ms');
  });

  it('bolds when asked, and applies the tie rule', () => {
    expect(cell({ p95: 310.5 }, 'p95', undefined, true)).toBe('**310ms**');
    // 310.5 -> 310, to the EVEN neighbour, which `toFixed` would render as 311.
    expect(cell({ p95: 310.5 }, 'p95')).toBe('310ms');
  });
});

describe('loadtestMarkdown', () => {
  /** The generated line is an instant; everything else is the contract. */
  function normalise(md: string): string {
    return md.replace(/^- \*\*Generated:\*\* .*$/mu, '- **Generated:** <when>');
  }

  it('renders the full report byte for byte, as earlier releases rendered it', () => {
    const mine = loadtestMarkdown(CTX, SUMMARY, SLO_RESULTS, RESOURCES, HOST, {
      snapshot: SNAPSHOT,
      compare: COMPARE,
      diag: DIAG,
    });
    expect(normalise(mine)).toBe(normalise(RECORDED.markdown.full));
  });

  it('renders the minimal report -- no diag, no compare, no resources -- identically', () => {
    const mine = loadtestMarkdown(CTX, SUMMARY, null, null, HOST, {});
    expect(normalise(mine)).toBe(normalise(RECORDED.markdown.minimal));
  });

  it('renders a run that measured NOTHING identically', () => {
    // Every latency cell must be a dash rather than 0ms.
    const empty = { count: 0, rps: 0 };
    const mine = loadtestMarkdown(CTX, empty, null, null, HOST, {});
    expect(normalise(mine)).toBe(normalise(RECORDED.markdown.empty));
    expect(mine).toContain('| latency p95 | - |');
  });

  it('labels a spike run by its spike, not by the vus the CLI ignored', () => {
    // Reporting `vus` there labelled the run as a load shape that never happened.
    const spikeCtx = { ...CTX, spike: '10:100:10' };
    const mine = loadtestMarkdown(spikeCtx, SUMMARY, null, null, HOST, {});
    expect(mine).toContain('spike 10:100:10 VUs for 60s');
    expect(mine).not.toContain('25 VUs');
    expect(normalise(mine)).toBe(normalise(RECORDED.markdown.spike));
  });

  it('renders a ramp run identically too', () => {
    const rampCtx = { ...CTX, ramp: '0:50' };
    const mine = loadtestMarkdown(rampCtx, SUMMARY, null, null, HOST, {});
    expect(normalise(mine)).toBe(normalise(RECORDED.markdown.ramp));
  });

  it('marks a not-measured SLO rule as such rather than as a passing zero', () => {
    const mine = loadtestMarkdown(CTX, SUMMARY, SLO_RESULTS, null, HOST, {});
    expect(mine).toContain('| p99 | <= 1s | not measured | FAIL |');
    expect(mine).toContain('## SLO gate — FAIL');
  });
});

describe('writeLoadtest and writeCapacity', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-report-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes into the reports directory by default', () => {
    const written = writeLoadtest(CTX, SUMMARY, null, null, HOST, '20260101-000000');
    expect(written).toBe(path.join(config.reportsDir(), 'loadtest-messages-20260101-000000.md'));
    expect(fs.readFileSync(written, 'utf8')).toContain('# houston load-test report');
  });

  it('treats an existing directory as a directory and anything else as a file', () => {
    const intoDir = writeLoadtest(CTX, SUMMARY, null, null, HOST, 'stamp', dir);
    expect(intoDir).toBe(path.join(dir, 'loadtest-messages-stamp.md'));
    const intoFile = writeLoadtest(CTX, SUMMARY, null, null, HOST, 'stamp', path.join(dir, 'r.md'));
    expect(intoFile).toBe(path.join(dir, 'r.md'));
  });

  it('renders a capacity report identically to earlier releases', () => {
    const ctx = {
      name: 'TICKET-1',
      version: '8.5.1',
      scenario: 'mixed',
      users: 10,
      step_duration: '30s',
      target: 'http://rocketchat:3000',
      slo: 'p95=300ms,error=1%',
      constrained: 'rc=2cpu/2g',
    };
    const steps = [
      {
        vus: 50,
        rps: 40.5,
        p95: 250.5,
        error_rate: 0.001,
        lag_max_s: 0.05,
        ok: true,
        breached: [],
      },
      { vus: 25, rps: 20.95, p95: 120.4, error_rate: 0.0, lag_max_s: 0.01, ok: true, breached: [] },
      {
        vus: 100,
        rps: 45.0,
        p95: 900.5,
        error_rate: 0.0125,
        lag_max_s: 0.9,
        ok: false,
        breached: ['p95', 'error'],
      },
    ];
    const mine = writeCapacity(ctx, steps, 'capacity 50 VUs', 'p95 broke first', HOST, 's', dir);
    const normalise = (md: string) => md.replace(/^- \*\*Generated:\*\* .*$/mu, '<when>');
    expect(normalise(fs.readFileSync(mine, 'utf8'))).toBe(normalise(RECORDED.capacity));
    // The steps are sorted by VUs, not left in call order.
    expect(fs.readFileSync(mine, 'utf8')).toMatch(/\| 25 \|[\s\S]*\| 50 \|[\s\S]*\| 100 \|/u);
  });

  it('expands a leading ~ in the destination as earlier releases did, whatever HOME is spelled as', () => {
    // With HOME set but EMPTY `os.homedir()` is '', so `--report ~/tmp/x` meant
    // `tmp/x` in the WORKING directory, where earlier releases write `/tmp/x`. A `~`-relative
    // spelling of this test's own directory makes that checkable without writing under
    // `/`: with HOME empty or the root it IS the directory, and the old reading lands in
    // the decoy working directory instead. The rows are `lib/home.ts`'s; under Jest the
    // mock answers `os.homedir()` with HOME verbatim, as the native call does
    // (`lib/home.test.ts` checks that premise against real processes).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-report-home-'));
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-report-cwd-'));
    fs.mkdirSync(path.join(home, 'sub'));
    const rows: [string, string][] = [
      ['', `~${dir}`],
      ['/', `~${dir}`],
      ['//', `~${dir}`],
      [`${home}/`, '~/sub'],
      [`${home}//`, '~/sub/'],
    ];
    const ctx = {
      name: 'T',
      version: '8.5.1',
      scenario: 'mixed',
      users: 1,
      step_duration: '30s',
      target: 'http://rocketchat:3000',
      slo: 'p95=300ms',
    };
    const cwd = process.cwd();
    let current = '';
    jest.resetModules();
    jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => current }));
    try {
      const fresh = require('../../src/perf/report') as typeof ReportNS;
      process.chdir(decoy);
      const ours = rows.map(([row, dest]) => {
        current = row;
        return fresh.writeCapacity(ctx, [], 'r', '', HOST, 'home', dest);
      });
      // What earlier releases answered for these rows, from the same decoy working
      // directory, with this test's two temporary directories kept as `<dir>` and `<home>`.
      const recorded = [
        '<dir>/capacity-home.md',
        '<dir>/capacity-home.md',
        '<dir>/capacity-home.md',
        '<home>/sub/capacity-home.md',
        '<home>/sub/capacity-home.md',
      ].map((p) => p.replace('<dir>', dir).replace('<home>', home));
      expect(ours).toEqual(recorded);
      expect(ours).toEqual([
        ...[0, 1, 2].map(() => path.join(dir, 'capacity-home.md')),
        path.join(home, 'sub', 'capacity-home.md'),
        path.join(home, 'sub', 'capacity-home.md'),
      ]);
      // Nothing landed in the working directory.
      expect(fs.readdirSync(decoy)).toEqual([]);
    } finally {
      process.chdir(cwd);
      jest.dontMock('node:os');
      jest.resetModules();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('writes under a HOME that walks back out of a symlink where the kernel takes it', () => {
    // Expanding `~` keeps a HOME's `..` for the kernel, which follows `link` first: with
    // `link -> other/sub` and HOME `<box>/link/../home` the report goes into
    // `<box>/other/home`. An earlier version `path.join`ed the HOME, folding `link/..` to nothing,
    // and wrote into a `<box>/home` it made itself; it also printed a doubled or trailing `/` that
    // earlier releases drop from the path they name.
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-report-link-')));
    fs.mkdirSync(path.join(box, 'other', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(box, 'other', 'home', 'sub'), { recursive: true });
    fs.symlinkSync('other/sub', path.join(box, 'link'));
    const rows: [string, string][] = [
      [`${box}/link/../home`, '~/sub'],
      [`${box}/link/../home/`, '~//sub/'],
      [`${box}/link/../home`, '~/sub/./named.md'],
    ];
    const ctx = {
      name: 'T',
      version: '8.5.1',
      scenario: 'mixed',
      users: 1,
      step_duration: '30s',
      target: 'http://rocketchat:3000',
      slo: 'p95=300ms',
    };
    let current = '';
    jest.resetModules();
    jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => current }));
    try {
      const fresh = require('../../src/perf/report') as typeof ReportNS;
      const ours = rows.map(([row, dest]) => {
        current = row;
        return fresh.writeCapacity(ctx, [], 'r', '', HOST, 'link', dest);
      });
      // What earlier releases answered for these rows, with this test's box kept as `<box>`.
      const recorded = [
        '<box>/link/../home/sub/capacity-link.md',
        '<box>/link/../home/sub/capacity-link.md',
        '<box>/link/../home/sub/named.md',
      ].map((p) => p.replace('<box>', box));
      expect(ours).toEqual(recorded);
      expect(ours).toEqual([
        `${box}/link/../home/sub/capacity-link.md`,
        `${box}/link/../home/sub/capacity-link.md`,
        `${box}/link/../home/sub/named.md`,
      ]);
      expect(fs.readdirSync(path.join(box, 'other', 'home', 'sub')).sort()).toEqual([
        'capacity-link.md',
        'named.md',
      ]);
      expect(fs.existsSync(path.join(box, 'home'))).toBe(false);
    } finally {
      jest.dontMock('node:os');
      jest.resetModules();
      fs.rmSync(box, { recursive: true, force: true });
    }
  });
});
