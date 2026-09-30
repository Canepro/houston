/**
 * `edge` and `tls-status` against earlier releases, stream for stream and exit code for exit
 * code.
 *
 * Both commands are `json: none`, so their prose and their exit code ARE the contract, and
 * an earlier version had neither: `edge status` dumped four raw fields, `edge stop` said "✓ edge
 * stopped" over a compose that failed, `edge delete` said "removed" whatever went, and
 * `tls-status` printed every field of the probe and exited 0 with nothing serving TLS.
 *
 * What it is held to is what the earlier releases' commands printed, recorded scenario by
 * scenario. Each scenario states a world -- which edge is installed and running, what it
 * routes, what each dialled TLS endpoint answers, which records exist -- and the recorded run
 * was driven through that world with the services the command reads stated, as this build is
 * driven with module mocks on the same functions. Records are written into a HOUSTON_HOME of
 * the scenario's own, whose path the recorded output names as `<home>`. Nothing reaches
 * docker, a cluster or the network.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as AppNS from '../../../src/cli/app';
import type * as HandlersNS from '../../../src/cli/handlers';
import type * as ExecNS from '../../../src/seams/exec';

/** The recorded runs, by scenario label: every `edge`/`tls-status` one, and every `trust-ca`. */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'cli', 'handlers', 'https.json'),
    'utf8',
  ),
) as { edge: Record<string, Run>; trust: Record<string, TrustRun> };

/** A recorded value with its `<home>` put back as this scenario's home. */
function inHome<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('no recorded run for this scenario');
  return JSON.parse(JSON.stringify(value).replaceAll('<home>', home)) as T;
}

interface Report {
  serving: boolean;
  fallback?: boolean;
  issuer?: string;
  subject?: string;
  dates?: string;
  names?: string[];
  trusted?: boolean;
  trusted_via_ca?: boolean;
  self_signed?: boolean;
  staging?: boolean;
  error?: string;
}

interface Deletion {
  host: string;
  routes: string[];
  passthrough: string[];
  certificate: boolean;
  declaration: boolean;
  acme: string[];
  restarted: boolean | null;
  foreign: string;
  kept: string[];
}

interface World {
  edge?: {
    installed?: boolean;
    running?: boolean;
    routes?: string[];
    attached?: string[];
    served_domain?: string;
    orphans?: string[];
    acme_hosts?: string[];
    route_hosts?: Record<string, string>;
    reachable?: Record<string, boolean>;
    down?: number;
    up?: number;
    logs?: number;
    deletion?: Deletion;
  };
  /** What each dialled host answers; `*` for any other. */
  verify?: Record<string, Report>;
  records?: Record<string, Record<string, unknown>>;
  config?: Record<string, unknown>;
  /** Answer "no" to the confirmation prompt. */
  decline?: boolean;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  dialled: string[];
  question?: string;
}

function report(values: Report): Required<Report> {
  return {
    fallback: false,
    issuer: '',
    subject: '',
    dates: '',
    names: [],
    trusted: false,
    trusted_via_ca: false,
    self_signed: false,
    staging: false,
    error: '',
    ...values,
  };
}

function record(name: string, extra: Record<string, unknown>, publicUrl: string) {
  return {
    name,
    project: `houston-${name}`,
    rc_version: '8.5.1',
    rc_image: '',
    mongo_tag: '8.0',
    mongo_flavor: 'official',
    preset: 'email',
    root_url: 'http://localhost:3000',
    host_port: 3000,
    version_source: '',
    pinned: false,
    created_at: '',
    public_url: publicUrl,
    admin_password: '',
    extra,
  };
}

const ACME = { tls: 'acme', tls_ports: [443], tls_email: 'o@e.com' };
const GOOD = report({
  serving: true,
  issuer: 'CN = houston local CA',
  dates: 'notAfter=Nov 23 2026',
  names: ['t1.example.com'],
  trusted: true,
  trusted_via_ca: true,
});
const PLACEHOLDER = report({
  serving: true,
  fallback: true,
  issuer: 'CN = TRAEFIK DEFAULT CERT',
  subject: 'CN = TRAEFIK DEFAULT CERT',
});
const NOTHING = report({ serving: false, error: 'connection refused' });
const acmeW = { w: record('w', ACME, 'https://t1.example.com') };
const nothingGone: Deletion = {
  host: 'h.example.com',
  routes: [],
  passthrough: [],
  certificate: false,
  declaration: false,
  acme: [],
  restarted: null,
  foreign: '',
  kept: [],
};

const SCENARIOS: [string, string[], World][] = [
  // --- edge -------------------------------------------------------------------------
  ['edge status, none installed', ['edge'], {}],
  [
    'edge status, running, no names, a GUI name',
    ['edge', 'status'],
    { edge: { installed: true, running: true, served_domain: 'gui.example.com' } },
  ],
  [
    'edge status, stopped, routes, strays',
    ['edge', 'status'],
    {
      edge: {
        installed: true,
        running: false,
        routes: ['a', 'b'],
        attached: ['houston-a_default'],
        route_hosts: { a: 'a.example.com' },
        reachable: { a: true, b: false },
        orphans: ['x.example.com', 'y.example.com', 'z.example.com', 'q.example.com'],
        acme_hosts: ['a.example.com', 'stale.example.com'],
      },
    },
  ],
  ['edge stop, compose fails', ['edge', 'stop'], { edge: { installed: true, down: 1 } }],
  ['edge stop, nothing installed', ['edge', 'stop'], {}],
  ['edge start, installed', ['edge', 'start'], { edge: { installed: true } }],
  ['edge start, first ever', ['edge', 'start'], {}],
  ['edge restart, start fails', ['edge', 'restart'], { edge: { installed: true, down: 0, up: 1 } }],
  [
    'edge delete, nothing there',
    ['edge', 'delete', 'h.example.com', '--yes'],
    { edge: { installed: true, deletion: nothingGone } },
  ],
  [
    'edge delete, everything went and the edge restarted',
    ['edge', 'delete', 'h.example.com', '--yes'],
    {
      edge: {
        installed: true,
        deletion: {
          ...nothingGone,
          routes: ['w', 'k'],
          passthrough: ['k'],
          certificate: true,
          declaration: true,
          acme: ['acme.json'],
          restarted: true,
          kept: ['acme/issued.json'],
        },
      },
    },
  ],
  [
    'edge delete, a foreign edge serves the name',
    ['edge', 'delete', 'h.example.com', '--yes'],
    {
      edge: {
        installed: true,
        deletion: { ...nothingGone, acme: ['acme.json'], foreign: '/elsewhere/.houston/edge' },
      },
    },
  ],
  [
    'edge delete, the edge did not come back',
    ['edge', 'delete', 'h.example.com', '--yes'],
    {
      edge: {
        installed: true,
        deletion: { ...nothingGone, acme: ['acme.json'], restarted: false },
      },
    },
  ],
  ['edge delete, no host', ['edge', 'delete', '--yes'], { edge: { installed: true } }],
  ['edge delete, nothing installed', ['edge', 'delete', 'h.example.com', '--yes'], {}],
  [
    'edge delete, declined',
    ['edge', 'delete', 'h.example.com'],
    { edge: { installed: true, deletion: nothingGone }, decline: true },
  ],
  ['edge logs, nothing installed', ['edge', 'logs'], {}],
  ['edge logs, stopped', ['edge', 'logs'], { edge: { installed: true, running: false, logs: 3 } }],
  ['edge, an unknown action', ['edge', 'bogus'], {}],
  ['cluster, an unknown action', ['cluster', 'bogus'], {}],
  ['cluster, an unknown action with a quote in it', ['cluster', "it's"], {}],
  // --- tls-status ---------------------------------------------------------------------
  ['tls-status, trusted', ['tls-status', '--name', 'w'], { records: acmeW, verify: { '*': GOOD } }],
  [
    'tls-status, nothing serving',
    ['tls-status', '--name', 'w'],
    { records: acmeW, verify: { '*': NOTHING } },
  ],
  [
    'tls-status, a squatter on IPv4 and the real one on ::1',
    ['tls-status', '--name', 'w'],
    { records: acmeW, verify: { '127.0.0.1': PLACEHOLDER, '*': GOOD } },
  ],
  [
    'tls-status, every family serves a placeholder',
    ['tls-status', '--name', 'w'],
    { records: acmeW, verify: { '*': PLACEHOLDER } },
  ],
  [
    'tls-status, a workspace with no port of its own',
    ['tls-status', '--name', 'w'],
    {
      records: { w: record('w', { ...ACME, tls_ports: [] }, 'https://t1.example.com') },
      verify: { '*': GOOD },
    },
  ],
  [
    'tls-status, local CA, not ours',
    ['tls-status', '--name', 'l'],
    {
      records: {
        l: record('l', { tls: 'local', tls_ports: [443] }, 'https://l.houston.localhost'),
      },
      verify: { '*': { ...GOOD, trusted_via_ca: false, trusted: false } },
    },
  ],
  [
    'tls-status, local CA, not trusted yet',
    ['tls-status', '--name', 'l'],
    {
      records: {
        l: record('l', { tls: 'local', tls_ports: [443] }, 'https://l.houston.localhost'),
      },
      verify: { '*': { ...GOOD, trusted: false } },
    },
  ],
  [
    'tls-status, staging',
    ['tls-status', '--name', 'w'],
    { records: acmeW, verify: { '*': { ...GOOD, trusted: false, staging: true } } },
  ],
  [
    'tls-status, self-signed',
    ['tls-status', '--name', 'w'],
    { records: acmeW, verify: { '*': { ...GOOD, trusted: false, self_signed: true } } },
  ],
  [
    'tls-status, fronted by a proxy',
    ['tls-status', '--name', 'w'],
    {
      records: acmeW,
      verify: { 't1.example.com': { ...GOOD, issuer: "CN = Cloudflare's edge" }, '*': GOOD },
    },
  ],
  [
    'tls-status, Kubernetes, nothing serving',
    ['tls-status', '--name', 'kws'],
    {
      records: {
        kws: record(
          'kws',
          { ...ACME, runtime: 'kubernetes', namespace: 'houston-kws' },
          'https://k1.example.com',
        ),
      },
      verify: { '*': NOTHING },
    },
  ],
  [
    'tls-status, not an https workspace',
    ['tls-status', '--name', 'p'],
    { records: { p: record('p', {}, '') } },
  ],
  ['tls-status, no such workspace', ['tls-status', '--name', 'nope'], {}],
  [
    "tls-status, no name: the GUI's own",
    ['tls-status'],
    { edge: { served_domain: 'gui.example.com' }, verify: { '*': GOOD } },
  ],
];

function mocked(world: World): { dialled: string[] } {
  const e = world.edge ?? {};
  const dialled: string[] = [];
  jest.doMock('../../../src/core/edge/spec', () => ({
    ...jest.requireActual('../../../src/core/edge/spec'),
    installed: () => e.installed ?? false,
    servedDomain: () => e.served_domain ?? '',
    current: () => null,
    write: async () => undefined,
  }));
  jest.doMock('../../../src/core/edge/engine', () => ({
    ...jest.requireActual('../../../src/core/edge/engine'),
    running: async () => e.running ?? false,
    down: async () => e.down ?? 0,
  }));
  jest.doMock('../../../src/core/edge/runtime', () => ({
    ...jest.requireActual('../../../src/core/edge/runtime'),
    status: async () => ({
      installed: e.installed ?? false,
      running: e.running ?? false,
      routes: e.routes ?? [],
      attached: e.attached ?? [],
    }),
    up: async () => ({ returncode: e.up ?? 0, stdout: '', stderr: '' }),
    logs: async () => e.logs ?? 0,
    deleteHost: async () => ({ ...(e.deletion as Deletion) }),
  }));
  jest.doMock('../../../src/core/edge/acme', () => ({
    ...jest.requireActual('../../../src/core/edge/acme'),
    orphanCerts: () => e.orphans ?? [],
    acmeHosts: () => e.acme_hosts ?? [],
    acmeFailure: async () => '',
  }));
  jest.doMock('../../../src/core/edge/routes', () => ({
    ...jest.requireActual('../../../src/core/edge/routes'),
    routeHost: (name: string) => e.route_hosts?.[name] ?? '',
    routeReachable: async (name: string) => e.reachable?.[name] ?? false,
  }));
  jest.doMock('../../../src/core/kube/endpoints', () => ({
    ...jest.requireActual('../../../src/core/kube/endpoints'),
    portClaimingCluster: async () => null,
  }));
  jest.doMock('../../../src/core/tls', () => ({
    ...jest.requireActual('../../../src/core/tls'),
    verify: async (host: string) => {
      dialled.push(host);
      const answers = world.verify ?? {};
      return { host, port: 443, ...(answers[host] ?? answers['*']) };
    },
  }));
  return { dialled };
}

const MOCKED = [
  '../../../src/core/edge/spec',
  '../../../src/core/edge/engine',
  '../../../src/core/edge/runtime',
  '../../../src/core/edge/acme',
  '../../../src/core/edge/routes',
  '../../../src/core/kube/endpoints',
  '../../../src/core/tls',
];

let home = '';
let previous: string | undefined;
beforeEach(() => {
  // A HOME PER SCENARIO: the records each one reads are written into it.
  previous = process.env.HOUSTON_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-https-'));
  process.env.HOUSTON_HOME = home;
});
afterEach(() => {
  for (const id of MOCKED) jest.dontMock(id);
  jest.resetModules();
  process.env.HOUSTON_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

async function typescript(world: World, argv: string[]): Promise<Run> {
  jest.resetModules();
  const { dialled } = mocked(world);
  const app = require('../../../src/cli/app') as typeof AppNS;
  const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
  let stdout = '';
  let stderr = '';
  let question: string | undefined;
  const io = {
    writeOut: (value: string) => {
      stdout += value;
    },
    writeErr: (value: string) => {
      stderr += value;
    },
  };
  const code = await app.runCli(argv, {
    execute: handlers.createExecutor(io, {
      confirm: async (asked: string) => {
        question = asked;
        return world.decline !== true;
      },
    }),
    io,
  });
  return { code, stdout, stderr, dialled, ...(question === undefined ? {} : { question }) };
}

function writeRecords(world: World): void {
  for (const [name, doc] of Object.entries(world.records ?? {})) {
    const dir = path.join(home, 'repros', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repro.json'), JSON.stringify(doc));
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  }
}

describe('edge and tls-status, against earlier releases', () => {
  it.each(SCENARIOS)('%s', async (label, argv, world) => {
    writeRecords(world);
    const recorded = inHome(RECORDED.edge[label]);
    const ours = await typescript(world, argv);
    if (world.decline === true) {
      // The prompt is the one place the two front ends differ by construction: earlier
      // releases print it on stdout themselves (and the recorded run echoes the typed
      // answer), this build hands it to the confirm function. What is compared is the
      // question, then everything after it.
      expect(`${ours.question ?? '<never asked>'} [y/N]: n\n`).toBe(recorded.stdout);
      expect({ code: ours.code, stderr: ours.stderr }).toEqual({
        code: recorded.code,
        stderr: recorded.stderr,
      });
      return;
    }
    expect({
      code: ours.code,
      stdout: ours.stdout,
      stderr: ours.stderr,
      dialled: ours.dialled,
    }).toEqual(recorded);
  });
});

// --- trust-ca -------------------------------------------------------------------------

/**
 * `trust-ca` against what earlier releases printed. `trust()` is stated (nothing touches a
 * trust store) and `openssl` is a stand-in on PATH, so `--show` runs a real child, as it did
 * for the recorded run: what it is handed, and what of its output reaches the terminal, are
 * compared.
 *
 * An earlier version printed one line from `trust()`'s answer and never read its first half:
 * "✓ local CA uninstalled" for every --uninstall -- a `sudo -n rm` that failed left the CA in
 * the system store while the operator was told trust was withdrawn -- "already
 * trusted" for an install that failed, no restart hint on success, and
 * `--show` printed the manual instructions and never ran `openssl x509`.
 */
interface TrustWorld {
  /** What `trust()` answers: `[changed, how]`. */
  trust?: [boolean, string];
  /** The stand-in `openssl`'s body, or absent from PATH altogether. */
  openssl?: string;
}

const NEED_SUDO = '/usr/local/share/ca-certificates (need sudo: sudo: a password is required)';
const STORE = 'the system trust store (/usr/local/share/ca-certificates)';
const OPENSSL =
  'printf "subject=CN = houston local CA\\nsha256 Fingerprint=AB:CD\\r\\nnotBefore=Jan  1\\n"\n' +
  'echo "a warning of its own" >&2\nexit 1\n';

const TRUST_SCENARIOS: [string, string[], TrustWorld][] = [
  ['trust-ca, the install fails', ['trust-ca'], { trust: [false, NEED_SUDO] }],
  [
    'trust-ca --uninstall, the removal fails',
    ['trust-ca', '--uninstall'],
    { trust: [false, NEED_SUDO] },
  ],
  ['trust-ca, installed', ['trust-ca'], { trust: [true, STORE] }],
  ['trust-ca --uninstall, removed', ['trust-ca', '--uninstall'], { trust: [true, STORE] }],
  ['trust-ca --show', ['trust-ca', '--show'], { openssl: OPENSSL }],
  ['trust-ca --show --uninstall', ['trust-ca', '--show', '--uninstall'], { openssl: OPENSSL }],
  ['trust-ca --show, no openssl on PATH', ['trust-ca', '--show'], {}],
];

interface TrustRun {
  code: number;
  stdout: string;
  stderr: string;
  calls: [string, boolean][];
  openssl?: string;
}

describe('trust-ca, against earlier releases', () => {
  let bin = '';
  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-trust-bin-'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../../../src/core/tls-local');
    jest.resetModules();
    fs.rmSync(bin, { recursive: true, force: true });
  });

  /** What the stand-in was handed since the last read, one argv per line. */
  function handed(): string {
    const log = path.join(bin, 'argv.log');
    if (!fs.existsSync(log)) return '<never ran>';
    const text = fs.readFileSync(log, 'utf8');
    fs.rmSync(log);
    return text;
  }

  it.each(TRUST_SCENARIOS)('%s', async (label, argv, world) => {
    if (world.openssl !== undefined) {
      const script = path.join(bin, 'openssl');
      fs.writeFileSync(
        script,
        `#!/bin/sh\necho "$*" >> ${JSON.stringify(path.join(bin, 'argv.log'))}\n${world.openssl}`,
      );
      fs.chmodSync(script, 0o755);
    }
    // PATH holds the stand-in and nothing else, so a missing one is missing, as it was for
    // the recorded run.
    const recorded = inHome(RECORDED.trust[label]);

    jest.resetModules();
    const calls: [string, boolean][] = [];
    jest.doMock('../../../src/core/tls-local', () => ({
      ...jest.requireActual('../../../src/core/tls-local'),
      ensureCa: async () => [path.join(home, 'ca', 'ca.key'), path.join(home, 'ca', 'ca.crt')],
      trust: async (crt: string, uninstall = false) => {
        calls.push([crt, uninstall]);
        return world.trust;
      },
    }));
    // A child spawned from here inherits the RUNNER's environment, not this sandbox's
    // `process.env`, so the stand-in PATH is handed to the seam the handler launches through.
    const exec = require('../../../src/seams/exec') as typeof ExecNS;
    const real = exec.capture;
    jest
      .spyOn(exec, 'capture')
      .mockImplementation(async (command, options = {}) =>
        real(command, { ...options, env: { ...process.env, PATH: bin } }),
      );
    const app = require('../../../src/cli/app') as typeof AppNS;
    const handlers = require('../../../src/cli/handlers') as typeof HandlersNS;
    let stdout = '';
    let stderr = '';
    const io = {
      writeOut: (value: string) => {
        stdout += value;
      },
      writeErr: (value: string) => {
        stderr += value;
      },
    };
    const code = await app.runCli(argv, { execute: handlers.createExecutor(io, {}), io });
    expect({ code, stdout, stderr, calls, openssl: handed() }).toEqual(recorded);
  });
});
