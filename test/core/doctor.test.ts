import * as path from 'node:path';

import * as fs from 'node:fs';
import * as os from 'node:os';

import type * as DoctorNS from '../../src/core/doctor';
import type * as KubeToolsNS from '../../src/core/kube/tools';
import type * as NamesNS from '../../src/core/kube/names';
import type * as RecordNS from '../../src/core/runner/record';
import type * as VersionsNS from '../../src/lib/versions';
import type * as PolicyNS from '../testsetup-policy';
import type * as ConfigMod from '../../src/lib/config';
import type * as ErrorsMod from '../../src/lib/errors';
import type * as JsonoutMod from '../../src/lib/jsonout';
import type * as JournalMod from '../../src/core/journal';
import type * as CreateDockerMod from '../../src/core/lifecycle/create-docker';
import type * as TypesMod from '../../src/core/lifecycle/types';

const ROOT = path.resolve(__dirname, '..', '..');

const CTX = { context: '', dockerUp: false, cloud: null, owned: null };

describe('the published check vocabulary', () => {
  it('is this tuple, in this order', () => {
    const { CHECKS } = require('../../src/core/doctor') as typeof DoctorNS;
    expect([...CHECKS]).toEqual([
      'preflight',
      'docker',
      'compose',
      'engine-kernel',
      'hub-auth',
      'disk',
      'memory',
      'swap',
      'version-lookup',
      'ports',
      'edge',
      'edge-routes-stale',
      'edge-routes-unreachable',
      'gui-accounts',
      'gui-admin',
      'gui-roles',
      'gui-create-policy',
      'state-file-perms',
      'home-perms',
      'home-writable',
      'sessions-file',
      'identity',
      'kubernetes',
      'kubernetes-tools',
      'kubernetes-cluster',
      'kubernetes-storage',
      'kubernetes-ingress',
      'kubernetes-loadbalancer',
      'kubernetes-metrics',
      'kubernetes-other-clusters',
      'inotify',
      'kubernetes-cert-manager',
      'kubernetes-edge-port',
      'kubernetes-chart-repo',
      'kubernetes-https',
      'kubernetes-helm-reach',
      'kubernetes-cloud',
      'kubernetes-skew',
      'kubernetes-cloud-owned',
      'install-fresh',
      'edge-config-drift',
      'preset-browser-host',
      'interrupted-work',
      'event-log',
      'legacy-artifacts',
    ]);
  });

  it('runs the subjects in this order', () => {
    const { RUN_ORDER } = require('../../src/core/doctor') as typeof DoctorNS;
    expect(RUN_ORDER.map(([name]) => name)).toEqual([
      'docker',
      'compose',
      'kernel',
      'hub',
      'disk',
      'memory',
      'versions',
      'ports',
      'install',
      'legacy',
      'edge',
      'identity',
      'k8s',
      'work',
      'presets',
    ]);
  });

  it('marks an undeclared id as preflight rather than throwing', () => {
    // `assert` would be stripped under -O and would raise AssertionError out of
    // GET /api/doctor otherwise -- a 500 contradicting the report's own rule.
    const { Report } = require('../../src/core/doctor') as typeof DoctorNS;
    const report = new Report();
    // CAST, and it is the point rather than a way around the type. `CheckId` closes the
    // set at every production call site, so this row is unreachable from the module that
    // owns it; the branch still has to behave, because a caller that casts -- or a future
    // dynamic id -- reaches it, and `doctor --json`'s promise is a watchable id on every
    // row rather than a 500.
    report.line('no-such-check' as DoctorNS.CheckId, 'warn', 'the message');
    expect(report.rows).toEqual([
      {
        check: 'preflight',
        status: 'warn',
        message:
          "internal: check id 'no-such-check' is not in doctor.CHECKS, so this row is unwatchable — the message",
      },
    ]);
  });

  it.each<[string, number | null]>([
    ['v2.29.1', 2],
    ['5.3.1', 5],
    ['', null],
    ['v10', 10],
    ['2.30.0-beta', 2],
    ['anything', null],
  ])('reads the major version of %j as %j', (version, major) => {
    const { majorVersion } = require('../../src/core/doctor') as typeof DoctorNS;
    expect(majorVersion(version)).toBe(major);
  });
});

describe('the inotify limit file', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-inotify-file-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** `inotifyHeadroom` against a limit file holding `text`. */
  function headroom(text: string, clusters: number, inUse: number): unknown {
    const file = path.join(dir, 'max_user_instances');
    fs.writeFileSync(file, text, 'utf8');
    const { inotifyHeadroom } = require('../../src/core/doctor') as typeof DoctorNS;
    return inotifyHeadroom(clusters, file, inUse);
  }

  it.each<[number, number, string, string]>([
    [
      1,
      10,
      'warn',
      'inotify instances: 128, 10 already in use by this user — about 118 left against the ~60 wanted, which is tight. A watcher that cannot start makes Traefik serve its own default certificate. `sudo sysctl -w fs.inotify.max_user_instances=1024`',
    ],
    [
      1,
      100,
      'fail',
      'inotify instances: 128, 100 already in use by this user — about 28 left for the ~60 that 1 cluster(s) want. Traefik will start, load NO dynamic configuration and serve its own default certificate, which looks like a broken route rather than a kernel limit. `sudo sysctl -w fs.inotify.max_user_instances=1024`',
    ],
    [
      3,
      0,
      'fail',
      'inotify instances: 128, 0 already in use by this user — about 128 left for the ~180 that 3 cluster(s) want. Traefik will start, load NO dynamic configuration and serve its own default certificate, which looks like a broken route rather than a kernel limit. `sudo sysctl -w fs.inotify.max_user_instances=1024`',
    ],
    [
      1,
      127,
      'fail',
      'inotify instances: 128, 127 already in use by this user — about 1 left for the ~60 that 1 cluster(s) want. Traefik will start, load NO dynamic configuration and serve its own default certificate, which looks like a broken route rather than a kernel limit. `sudo sysctl -w fs.inotify.max_user_instances=1024`',
    ],
    [
      2,
      10,
      'fail',
      'inotify instances: 128, 10 already in use by this user — about 118 left for the ~120 that 2 cluster(s) want. Traefik will start, load NO dynamic configuration and serve its own default certificate, which looks like a broken route rather than a kernel limit. `sudo sysctl -w fs.inotify.max_user_instances=1024`',
    ],
    [
      1,
      128,
      'fail',
      'inotify instances: 128, 128 already in use by this user — about 0 left for the ~60 that 1 cluster(s) want. Traefik will start, load NO dynamic configuration and serve its own default certificate, which looks like a broken route rather than a kernel limit. `sudo sysctl -w fs.inotify.max_user_instances=1024`',
    ],
  ])('against 128, %d cluster(s) with %d in use, is a %s', (clusters, inUse, status, message) => {
    expect(headroom('128\n', clusters, inUse)).toEqual([[status, message]]);
  });

  it('stays silent for a limit it cannot parse, or a file that is not there', () => {
    expect(headroom('1024abc\n', 1, 10)).toEqual([]);
    const { inotifyHeadroom } = require('../../src/core/doctor') as typeof DoctorNS;
    expect(inotifyHeadroom(1, path.join(dir, 'missing'), 10)).toEqual([]);
  });
});

describe('the identity check', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/users');
    jest.resetModules();
  });

  function accounts(
    anyUsers: boolean,
    admins: string[],
    users: string[],
    implicit: string[],
  ): void {
    jest.resetModules();
    jest.doMock('../../src/core/users', () => ({
      ...jest.requireActual('../../src/core/users'),
      anyUsers: () => anyUsers,
      admins: () => admins,
      listUsers: () => users.map((name) => ({ name })),
      implicitAdmins: () => implicit,
    }));
  }

  const EVENT_LOG = (home: string) => ({
    check: 'event-log',
    status: 'ok',
    message: `Event log: ${home}/logs/houston.log — written from the first command that reports progress`,
  });

  it('warns that there are no accounts', async () => {
    accounts(false, [], [], []);
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const home = (require('../../src/lib/config') as typeof ConfigMod).home();
    expect(await doctor.checkIdentity(CTX)).toEqual([
      {
        check: 'gui-accounts',
        status: 'warn',
        message:
          'No GUI accounts — `houston serve` will refuse to start on anything but loopback (`houston users add <name>`)',
      },
      EVENT_LOG(home),
    ]);
  });

  it('names the admin of one admin and one member', async () => {
    accounts(true, ['alice'], ['alice', 'bob'], []);
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const home = (require('../../src/lib/config') as typeof ConfigMod).home();
    expect(await doctor.checkIdentity(CTX)).toEqual([
      {
        check: 'gui-accounts',
        status: 'ok',
        message: '2 GUI account(s), admin: alice',
        elsewhere: 'the People page',
      },
      {
        check: 'gui-create-policy',
        status: 'ok',
        message:
          'members may set --rc-image/--reg-token/--bind — narrow it with `houston config set gui.create_policy admin`',
        elsewhere: 'which fields the New workspace form offers',
      },
      EVENT_LOG(home),
    ]);
  });

  it('fails a box whose only admin is implicit, and names who to demote', async () => {
    accounts(true, [], ['bob'], ['bob']);
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const home = (require('../../src/lib/config') as typeof ConfigMod).home();
    expect(await doctor.checkIdentity(CTX)).toEqual([
      {
        check: 'gui-admin',
        status: 'fail',
        message:
          'No admin account — nobody can manage people from the GUI. `houston users role <name> admin`',
      },
      {
        check: 'gui-roles',
        status: 'warn',
        message:
          'admin by default (blank role column): bob — that is the migration for accounts made before roles existed, not a choice. `houston users role bob member`',
      },
      {
        check: 'gui-create-policy',
        status: 'ok',
        message:
          'members may set --rc-image/--reg-token/--bind — narrow it with `houston config set gui.create_policy admin`',
        elsewhere: 'which fields the New workspace form offers',
      },
      EVENT_LOG(home),
    ]);
  });
});

describe('the create-policy row', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/users');
    jest.resetModules();
  });

  // Only the key `houston config set gui.create_policy` writes narrows it; the underscore
  // spelling is not that key.
  it.each<[Record<string, unknown>, string]>([
    [
      { 'gui.create_policy': 'admin' },
      'members may not set --rc-image/--reg-token/--bind (gui.create_policy admin)',
    ],
    [
      { gui_create_policy: 'admin' },
      'members may set --rc-image/--reg-token/--bind — narrow it with `houston config set gui.create_policy admin`',
    ],
    [
      {},
      'members may set --rc-image/--reg-token/--bind — narrow it with `houston config set gui.create_policy admin`',
    ],
  ])('reads a config of %j', async (stored, message) => {
    jest.resetModules();
    (require('../../src/lib/config') as typeof ConfigMod).saveConfig(stored);
    jest.doMock('../../src/core/users', () => ({
      ...jest.requireActual('../../src/core/users'),
      anyUsers: () => true,
      admins: () => ['alice'],
      listUsers: () => [{ name: 'alice' }],
      implicitAdmins: () => [],
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const rows = await doctor.checkIdentity(CTX);
    expect(rows.filter((row) => row.check === 'gui-create-policy')).toEqual([
      {
        check: 'gui-create-policy',
        status: 'ok',
        message,
        elsewhere: 'which fields the New workspace form offers',
      },
    ]);
  });
});

describe('the memory check', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/lifecycle/sizing');
    jest.resetModules();
  });

  it.each<[Record<string, unknown>, unknown[]]>([
    [{ known: false }, []],
    [
      { known: true, total_mb: 10000, available_mb: 8000, swap_mb: 2048, room: 5 },
      [{ check: 'memory', status: 'ok', message: 'Memory: 8000 MB available of 10000 MB' }],
    ],
    [
      { known: true, total_mb: 10000, available_mb: 2200, swap_mb: 2048, room: 1 },
      [
        {
          check: 'memory',
          status: 'warn',
          message: 'Memory: 2200 MB available of 10000 MB — room for about 1 more workspace',
        },
      ],
    ],
    [
      { known: true, total_mb: 10000, available_mb: 100, swap_mb: 0, room: 0 },
      [
        {
          check: 'memory',
          status: 'warn',
          message:
            'Memory: 100 MB available of 10000 MB — NOT enough for another workspace. `houston stop --name <it>` frees memory and keeps the data',
        },
        {
          check: 'swap',
          status: 'warn',
          message:
            'No swap: memory pressure becomes an OOM kill rather than slowdown, and the kernel picks its own victim',
        },
      ],
    ],
  ])('reads the headroom and swap of %j', async (cap, expected) => {
    jest.resetModules();
    jest.doMock('../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../src/core/lifecycle/sizing'),
      capacity: async () => cap,
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    expect(await doctor.checkMemory({ ...CTX, dockerUp: true })).toEqual(expected);
  });
});

describe('the simple engine rows', () => {
  afterEach(() => {
    jest.doMock('../../src/core/runner/host', () =>
      (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.resetModules();
  });

  it.each<[string, string, boolean, unknown[]]>([
    [
      '6.8.0-45-generic',
      '27.3.1',
      true,
      [
        { check: 'compose', status: 'ok', message: 'docker compose v2 (v2.29.1)' },
        { check: 'docker', status: 'ok', message: 'Docker daemon running (27.3.1)' },
        { check: 'engine-kernel', status: 'ok', message: 'engine kernel 6.8.0-45-generic' },
        {
          check: 'hub-auth',
          status: 'ok',
          message: 'logged in to Docker Hub (avoids anonymous pull-rate limits)',
        },
      ],
    ],
    [
      '6.19.0-arch1',
      '',
      false,
      [
        { check: 'compose', status: 'ok', message: 'docker compose v2 (v2.29.1)' },
        { check: 'docker', status: 'ok', message: 'Docker daemon running (?)' },
        {
          check: 'engine-kernel',
          status: 'warn',
          message:
            'engine kernel 6.19.0-arch1 — MongoDB 8.0 will not start (SERVER-121912); use an engine on kernel < 6.19 for RC versions that require Mongo 8',
        },
        {
          check: 'hub-auth',
          status: 'warn',
          message:
            'not logged in to Docker Hub — anonymous pulls can hit the rate limit; run `docker login`. registry.rocket.chat counts against Hub too',
        },
      ],
    ],
  ])(
    'read kernel %j, server %j and hub login %j in their grammar',
    async (kernel, server, hub, expected) => {
      // The second row is SERVER-121912, and the empty-version case.
      jest.resetModules();
      jest.doMock('../../src/core/runner/host', () => ({
        ...jest.requireActual('../../src/core/runner/host'),
        composeVersion: async () => 'v2.29.1',
        dockerAvailable: async () => true,
        dockerServerVersion: async () => server,
        dockerKernelVersion: async () => kernel,
        hubLoggedIn: async () => hub,
      }));
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      expect([
        ...(await doctor.checkCompose(CTX)),
        ...(await doctor.checkDocker(CTX)),
        ...(await doctor.checkKernel(CTX)),
        ...(await doctor.checkHub(CTX)),
      ]).toEqual(expected);
    },
  );
});
describe('a state directory that is not writable', () => {
  afterEach(() => {
    const repros = path.join(process.env.HOUSTON_HOME as string, 'repros');
    if (fs.existsSync(repros)) fs.chmodSync(repros, 0o700);
    jest.resetModules();
  });

  it('is reported with the error text and class, as earlier releases report it', async () => {
    // The system's text for the error, "Permission denied", where Node's message and a bare
    // `Error` were printed.
    const repros = path.join(process.env.HOUSTON_HOME as string, 'repros');
    fs.mkdirSync(repros, { recursive: true });
    fs.chmodSync(repros, 0o555);
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const rows = await doctor.checkIdentity({
      context: '',
      dockerUp: false,
      cloud: null,
      owned: null,
    });
    const ours = rows.filter((row) => row.check === 'home-writable').map((row) => row.message);
    expect(ours[0]).toContain('(Permission denied)');
    const home = process.env.HOUSTON_HOME as string;
    expect(rows.filter((row) => row.check === 'home-writable')).toEqual([
      {
        check: 'home-writable',
        status: 'fail',
        message: `${home}/repros is not writable (Permission denied) — every command that creates or records anything will fail the same way. houston's workspaces.`,
      },
    ]);
  });
});

describe('the preset-browser-host check', () => {
  afterEach(() => {
    jest.resetModules();
  });

  async function writeWorkspace(
    name: string,
    preset: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord(
      name,
      record.metadata({ name, project: `houston-${name}`, preset, extra }),
    );
  }

  it('warns only when a remote-bound preset workspace has no browser host', async () => {
    jest.resetModules();
    await writeWorkspace('remote-saml', 'saml', { bind_host: '0.0.0.0' });
    await writeWorkspace('local-oidc', 'oidc', { bind_host: '127.0.0.1' });
    await writeWorkspace('told-s3', 's3_minio', { bind_host: '0.0.0.0', params: { s3_host: 'h' } });
    await writeWorkspace('other', 'default', { bind_host: '0.0.0.0' });
    // A falsy recorded bind is the empty bind, as earlier releases read it -- it must not
    // read as the string "false" and draw a warning.
    await writeWorkspace('falsy-saml', 'saml', { bind_host: false });

    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const rows = await doctor.checkPresets({
      context: '',
      dockerUp: false,
      cloud: null,
      owned: null,
    });
    expect(rows).toHaveLength(1);
    expect(String((rows[0] as Record<string, unknown>).message)).toContain('remote-saml');
    expect(rows).toEqual([
      {
        check: 'preset-browser-host',
        status: 'warn',
        message:
          "'remote-saml' is bound to 0.0.0.0 but its 'saml' preset still points the browser at this machine. From anywhere else that address is the visitor's own laptop and login fails silently. Re-create with `--set idp_host=<the host people type>`",
      },
    ]);
  });
});

describe('the Kubernetes report', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('keeps the Compose box silent about a Kubernetes it does not use', async () => {
    // One line, not five: someone running only Compose repros must not have their
    // report padded with an unconfigured feature. The scenario is stubbed because the
    // live box's tool inventory and AWS credentials are ambient.
    jest.resetModules();
    const tools = require('../../src/core/kube/tools') as typeof KubeToolsNS;
    const names = require('../../src/core/kube/names') as typeof NamesNS;
    const absent: Record<string, KubeToolsNS.Tool> = {};
    for (const name of Object.keys(names.tools())) {
      absent[name] = tools.makeTool({ name });
    }
    jest.doMock('../../src/core/kube/probe', () => ({
      ...jest.requireActual('../../src/core/kube/probe'),
      preflight: async (context = '') =>
        tools.preflight({
          tools: absent,
          clusterExists: false,
          clusterReachable: false,
          context,
          willCreate: false,
          probeFailed: '',
        }),
      skew: async () => null,
    }));
    jest.doMock('../../src/core/kube/endpoints', () => ({
      ...jest.requireActual('../../src/core/kube/endpoints'),
      portClaimingCluster: async () => null,
    }));
    jest.doMock('../../src/core/kube/context', () => ({
      ...jest.requireActual('../../src/core/kube/context'),
      activeContext: async () => '',
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const rows = (
      await doctor.checkKubernetes({
        context: '',
        dockerUp: false,
        cloud: null,
        owned: null,
      })
    ).filter((row) => row.check !== 'inotify');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ check: 'kubernetes-tools', status: 'ok' });
    expect(String((rows[0] as Record<string, unknown>).message)).toContain('Kubernetes not set up');
  });
});

describe('the whole report', () => {
  it('obeys its own contract on a live run', async () => {
    // EVERY CHECK REAL, EXCEPT THE ONE THAT CROSSES THE WIRE. This test is about the
    // report's contract -- published ids, valid statuses, counts that add up, a verdict
    // that follows from them -- and it used to ask `releases.rocket.chat` over the
    // network to get there: measured, it was the suite's only non-loopback request, and
    // offline it quietly took the other branch. `test/testsetup-network.ts` now fails a
    // test that reaches the network, so the answer is stated here instead: unreachable,
    // the branch a box with no network takes.
    jest.resetModules();
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      releasesReachable: async () => null,
    }));
    let result: Record<string, unknown>;
    let CHECKS: readonly string[];
    try {
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      result = await doctor.runChecks();
      CHECKS = doctor.CHECKS;
    } finally {
      // A registered factory survives `resetModules`, so it is taken back out here.
      jest.dontMock('../../src/core/rcapi');
      jest.resetModules();
    }
    const rows = result['checks'] as Record<string, unknown>[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // The stated answer really was the one used: this is the row it produces.
    expect(rows).toContainEqual(
      expect.objectContaining({ check: 'version-lookup', status: 'warn' }),
    );
    for (const row of rows) {
      const id = String(row.check);
      // Every id is one the contract publishes, and the unknown-id fallback never fired.
      expect(CHECKS).toContain(id);
      expect(['ok', 'warn', 'fail']).toContain(String(row.status));
      expect(typeof row.message).toBe('string');
      expect(String(row.message)).not.toContain('internal: check id');
    }
    const counts = result['counts'] as Record<string, number>;
    let total = 0;
    for (const status of ['ok', 'warn', 'fail']) total += counts[status] ?? 0;
    expect(total).toBe(rows.length);
    const expectedVerdict =
      (counts.fail ?? 0) > 0 ? 'fail' : (counts.warn ?? 0) > 0 ? 'warn' : 'ok';
    expect(result['verdict']).toBe(expectedVerdict);
  });
});

describe('the Kubernetes rows', () => {
  const MOCKED = [
    '../../src/core/kube/probe',
    '../../src/core/kube/endpoints',
    '../../src/core/kube/certmanager',
    '../../src/core/kube/exec',
    '../../src/core/kube/context',
    '../../src/core/eks',
  ];
  afterEach(() => {
    for (const id of MOCKED) jest.dontMock(id);
    jest.resetModules();
  });

  it('prints these messages and fields for a live-shaped cluster', async () => {
    jest.resetModules();
    const tools = require('../../src/core/kube/tools') as typeof KubeToolsNS;
    const names = require('../../src/core/kube/names') as typeof NamesNS;
    const present: Record<string, KubeToolsNS.Tool> = {};
    for (const [name, version, raw] of [
      ['kubectl', [1, 36, 3], 'Client Version: v1.36.3'],
      ['helm', [4, 2, 4], 'v4.2.4+g8f3f4c2'],
      ['kind', [0, 32, 0], 'kind v0.32.0 go1.26.3 linux/amd64'],
      ['eksctl', [0, 200, 0], '0.200.0'],
    ] as [string, number[], string][]) {
      present[name] = tools.makeTool({ name, path: `/usr/local/bin/${name}`, version, raw });
    }
    jest.doMock('../../src/core/kube/probe', () => ({
      ...jest.requireActual('../../src/core/kube/probe'),
      preflight: async (context = '') =>
        tools.preflight({
          tools: present,
          clusterExists: true,
          clusterReachable: true,
          helmReachable: '',
          storageClasses: ['local-path'],
          defaultStorageClass: 'local-path',
          ingressClasses: ['traefik'],
          otherClusters: [],
          namespaces: ['houston-a'],
          distribution: 'k3s',
          nodeCount: 1,
          architectures: ['amd64'],
          metrics: true,
          loadbalancer: 'svclb-traefik',
          context,
          provider: names.PROVIDER_EXTERNAL,
          willCreate: false,
          probeFailed: '',
          unreadable: [],
        }),
      skew: async () => ({ ok: true, client: [1, 36], server: [1, 36] }),
    }));
    jest.doMock('../../src/core/kube/endpoints', () => ({
      ...jest.requireActual('../../src/core/kube/endpoints'),
      ingressEndpoint: async () => ({
        address: '172.16.0.2',
        port: 443,
        source: 'nodeport',
        service: 'kube-system/traefik',
        local: true,
      }),
      portClaimingCluster: async () => null,
    }));
    jest.doMock('../../src/core/kube/certmanager', () => ({
      ...jest.requireActual('../../src/core/kube/certmanager'),
      certManagerInstalled: async () => true,
    }));
    jest.doMock('../../src/core/kube/exec', () => {
      const actual = jest.requireActual('../../src/core/kube/exec') as {
        kube: Record<string, unknown>;
      };
      return {
        ...actual,
        kube: {
          ...actual.kube,
          run: async () => ({ returncode: 0, stdout: '[{"name": "rocketchat"}]', stderr: '' }),
        },
      };
    });
    jest.doMock('../../src/core/kube/context', () => ({
      ...jest.requireActual('../../src/core/kube/context'),
      activeContext: async () => '',
    }));
    jest.doMock('../../src/core/eks', () => ({
      ...jest.requireActual('../../src/core/eks'),
      aws: { preflight: async () => ({ tools: {}, identity: null, region: '' }) },
      remembered: () => [],
      cloudReady: () => false,
      daysUntil: () => null,
      identityPretty: () => 'nobody',
      blockers: () => [],
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const rows = await doctor.checkKubernetes({
      context: '',
      dockerUp: true,
      cloud: Promise.resolve({ tools: {}, identity: null, region: '', ready: false, blockers: [] }),
      owned: Promise.resolve([]),
    });
    // The inotify row is read from the real /proc; every other row is deterministic.
    expect(rows.filter((row) => row.check !== 'inotify')).toEqual([
      {
        check: 'kubernetes-tools',
        status: 'ok',
        message:
          'Kubernetes tools present (kubectl 1.36.3, helm 4.2.4, kind 0.32.0, eksctl 0.200.0)',
      },
      {
        check: 'kubernetes-cluster',
        status: 'ok',
        message:
          "Using your cluster '' (k3s, 1 node, amd64), 1 workspace namespace(s) — houston creates namespaces in it and never removes the cluster itself",
      },
      { check: 'kubernetes-skew', status: 'ok', message: 'kubectl matches the API server (1.36)' },
      { check: 'kubernetes-storage', status: 'ok', message: 'Storage: local-path (default)' },
      {
        check: 'kubernetes-ingress',
        status: 'ok',
        message: 'Ingress: traefik — a hostname can be served from this cluster',
      },
      {
        check: 'kubernetes-loadbalancer',
        status: 'ok',
        message: 'Load balancer: working — svclb-traefik',
      },
      {
        check: 'kubernetes-metrics',
        status: 'ok',
        message: 'Metrics: metrics-server answering — `houston stats` works here',
      },
      {
        check: 'kubernetes-chart-repo',
        status: 'ok',
        message: "chart rocketchat/rocketchat resolves in houston's Helm home",
      },
      {
        check: 'kubernetes-cert-manager',
        status: 'ok',
        message: 'cert-manager: installed — a Certificate can be issued in this cluster',
      },
      {
        check: 'kubernetes-https',
        status: 'ok',
        message:
          "https: the CLUSTER's own ingress answers this host's :443, and a workspace name is served directly — TLS terminates in the cluster, from a cert-manager Secret (nodeport 172.16.0.2:443, kube-system/traefik)",
      },
    ]);
  });
});

describe('the version-lookup row', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('says unreachable when there was no response at all', async () => {
    // `releasesReachable` swallows the transport failure and answers `null`; the row
    // must not call that "returned non-200", which names a different fault.
    jest.resetModules();
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      releasesReachable: async () => null,
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    expect(await doctor.checkVersions({} as never)).toEqual([
      {
        check: 'version-lookup',
        status: 'warn',
        message: 'releases.rocket.chat unreachable — use `--offline` (falls back to shipped map)',
      },
    ]);
  });
});

describe('the install row', () => {
  it('compares against the checkout beside the build, not the current directory', () => {
    // Running houston from another project must not read THAT project's
    // `package.json` and report its version as the checkout.
    const ROOT = path.resolve(__dirname, '..', '..');
    const before = process.cwd();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-elsewhere-'));
    try {
      fs.writeFileSync(path.join(elsewhere, 'package.json'), '{ "version": "9.9.9" }\n', 'utf8');
      fs.mkdirSync(path.join(elsewhere, 'src'));
      process.chdir(elsewhere);
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      return doctor.checkInstall({} as never).then((rows) => {
        const message = String((rows[0] as { message: string }).message);
        expect(message).toContain(ROOT);
        expect(message).not.toContain(elsewhere);
      });
    } finally {
      process.chdir(before);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('a sessions file this build cannot parse', () => {
  it('degrades the whole identity check, as earlier releases do', async () => {
    // A read that fails is tolerated, but a marker that is not a number is not: that
    // error escapes to the identity check's own handler -- which reports it once.
    // Swallowing it would silently ignore a header this build does not understand.
    // A factory registered with `jest.doMock` is NOT cleared by `resetModules`, so any
    // `./users` mock is taken out first -- the check must read the real accounts.
    jest.unmock('../../src/core/users');
    jest.resetModules();
    const sessionsMod = require('../../src/core/sessions') as { sessionsFile: () => string };
    const file = sessionsMod.sessionsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# houston-state: not-a-number\nsome\tsession\tline\n', 'utf8');
    // The mode the permissions row names, whatever the umask made it.
    fs.chmodSync(file, 0o664);

    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const mine = await doctor.checkIdentity({
      context: '',
      dockerUp: false,
      cloud: null,
      owned: null,
    });
    expect(mine.some((row) => row.message === 'Identity status could not be determined')).toBe(
      true,
    );
    const home = (require('../../src/lib/config') as typeof ConfigMod).home();
    expect(mine).toEqual([
      {
        check: 'gui-accounts',
        status: 'warn',
        message:
          'No GUI accounts — `houston serve` will refuse to start on anything but loopback (`houston users add <name>`)',
      },
      {
        check: 'state-file-perms',
        status: 'warn',
        message: `${home}/sessions is readable by other local users (mode 664); it should be 0600`,
      },
      {
        check: 'event-log',
        status: 'ok',
        message: `Event log: ${home}/logs/houston.log — written from the first command that reports progress`,
      },
      { check: 'identity', status: 'warn', message: 'Identity status could not be determined' },
    ]);
  });
});

describe('the remaining single-subject rows', () => {
  afterEach(() => {
    // Registered factories survive `resetModules`, so the home/fs mocks in this block
    // must be withdrawn explicitly or they leak into the tests that follow.
    jest.unmock('node:os');
    jest.unmock('node:fs');
    jest.resetModules();
  });

  it('ports: says whether 3000 is free, and names the next free port', async () => {
    const mine: unknown[] = [];
    for (const free of [true, false]) {
      jest.resetModules();
      jest.doMock('../../src/core/runner/ports', () => ({
        ...jest.requireActual('../../src/core/runner/ports'),
        pickPort: async () => 4321,
        portFree: async () => free,
      }));
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      mine.push(await doctor.checkPorts({} as never));
    }
    jest.dontMock('../../src/core/runner/ports');
    expect(mine).toEqual([
      [
        {
          check: 'ports',
          status: 'ok',
          message: 'Port 3000 free (repros auto-pick from 3000; next free: 4321)',
        },
      ],
      [
        {
          check: 'ports',
          status: 'warn',
          message: 'Port 3000 in use — `up` will auto-pick the next free port (4321)',
        },
      ],
    ]);
  });

  it.each<
    [{ installed: boolean; dockerUp: boolean; running: boolean; routes: string[] }, unknown[]]
  >([
    [{ installed: false, dockerUp: true, running: false, routes: [] }, []],
    [
      { installed: true, dockerUp: false, running: false, routes: [] },
      [
        {
          check: 'edge',
          status: 'warn',
          message: 'Edge installed — cannot check it, Docker is down',
        },
      ],
    ],
    [
      { installed: true, dockerUp: true, running: true, routes: ['a', 'b'] },
      [
        {
          check: 'edge',
          status: 'ok',
          message: 'Edge running — holds :80/:443, 2 workspace route(s)',
          elsewhere: 'the edge chip in the header',
        },
        {
          check: 'edge',
          status: 'warn',
          message:
            '2 edge route(s) with no workspace: a, b — `down` cannot remove these, the workspace is what is gone. `houston edge delete a` forgets a name, its certificate and its key',
        },
      ],
    ],
    [
      { installed: true, dockerUp: true, running: false, routes: [] },
      [
        {
          check: 'edge',
          status: 'fail',
          message:
            'Edge is NOT running — traefik is holding it is holding :443. Every https name on this box (0 route(s)) is unreachable. `houston edge start`',
        },
      ],
    ],
  ])('edge: reads %j', async (testCase, expected) => {
    jest.resetModules();
    jest.doMock('../../src/core/edge/spec', () => ({
      installed: () => testCase.installed,
      servedDomain: () => '',
      current: () => null,
      configDrift: async () => [[], []],
    }));
    jest.doMock('../../src/core/edge/routes', () => ({
      registered: () => testCase.routes,
      routeHost: () => '',
    }));
    jest.doMock('../../src/core/edge/engine', () => ({
      running: async () => testCase.running,
      portHolder: async () => 'traefik is holding it',
    }));
    jest.doMock('../../src/core/edge/networks', () => ({
      attachedNetworks: async () => new Set<string>(),
      workspaceNetwork: async () => 'net',
    }));
    try {
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      expect(await doctor.checkEdge({ ...CTX, dockerUp: testCase.dockerUp })).toEqual(expected);
    } finally {
      for (const id of [
        '../../src/core/edge/spec',
        '../../src/core/edge/routes',
        '../../src/core/edge/engine',
        '../../src/core/edge/networks',
      ]) {
        jest.dontMock(id);
      }
    }
  });

  it.each<[string, unknown[]]>([
    [
      'rate_limiter_off',
      [
        {
          check: 'interrupted-work',
          status: 'warn',
          message:
            "'w': the API rate limiter was turned off for a performance run at 2026-01-01T00:00:00+00:00 and never turned back on — `houston serve` repairs this at startup, or fix it by hand",
        },
      ],
    ],
    [
      'database_dropped',
      [
        {
          check: 'interrupted-work',
          status: 'warn',
          message:
            "'w': a restore from /tmp/b.rcbak dropped the database at 2026-01-01T00:00:00+00:00 and never finished loading it — the workspace is running against an EMPTY or partial database. `houston restore /tmp/b.rcbak --name w` again is what completes it",
        },
      ],
    ],
  ])('work: says what an abandoned %s entry left and how to finish it', async (kind, expected) => {
    jest.resetModules();
    jest.doMock('../../src/core/journal', () => ({
      ...jest.requireActual('../../src/core/journal'),
      abandoned: () => [
        {
          id: 'x',
          kind,
          workspace: 'w',
          pid: 1,
          started: '1',
          at: '2026-01-01T00:00:00+00:00',
          detail: { bundle: '/tmp/b.rcbak' },
        },
      ],
      openEntries: () => [],
    }));
    try {
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      expect(await doctor.checkWork({} as never)).toEqual(expected);
    } finally {
      jest.dontMock('../../src/core/journal');
    }
  });

  it.each<[number, unknown[]]>([
    [20000000000, [{ check: 'disk', status: 'ok', message: 'Disk: 20 GB free' }]],
    [
      3000000000,
      [
        {
          check: 'disk',
          status: 'warn',
          message: 'Disk: only 3 GB free — images are ~1.5 GB each',
        },
      ],
    ],
  ])('disk: formats %d bytes free as the headroom', async (free, expected) => {
    jest.resetModules();
    jest.doMock('node:fs', () => ({
      ...jest.requireActual('node:fs'),
      statfsSync: () => ({ bavail: BigInt(free), bsize: 1n }),
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    expect(await doctor.checkDisk({} as never)).toEqual(expected);
  });

  it('legacy: warns about a home holding the old names', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-legacy-home-'));
    const before = process.env['HOME'];
    try {
      fs.mkdirSync(path.join(home, '.rc-repro'), { recursive: true });
      fs.mkdirSync(path.join(home, '.claude', 'skills', 'rc-repro'), { recursive: true });
      // This process's `os.homedir()` does not pick a HOME mutation up under jest, so the
      // home is also handed over through a mock of the one call that reads it.
      process.env['HOME'] = home;
      jest.resetModules();
      jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => home }));
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      const rows = await doctor.checkLegacy({} as never);
      // What the rows say is stated: each leftover is INVISIBLE rather than broken -- a
      // stale skill teaches an agent commands that no longer exist -- so the value is that
      // something says so, and a row that does not say how to fix it is noise.
      const found = rows.map((row) => String(row.message)).join(' ');
      expect(found).toContain('.rc-repro');
      expect(found).toContain('skills/rc-repro');
      expect(found).toContain('rm -rf');
      expect(rows.map((row) => row.status)).toEqual(rows.map(() => 'warn'));
      expect(rows).toEqual([
        {
          check: 'legacy-artifacts',
          status: 'warn',
          message: `${home}/.rc-repro is still here. It is adopted automatically unless HOUSTON_HOME is set, which it is — unset it and run any houston command, or move it by hand`,
        },
        {
          check: 'legacy-artifacts',
          status: 'warn',
          message: `${home}/.claude/skills/rc-repro still teaches agents to run \`rc-repro\`, a command that no longer exists — \`rm -rf ${home}/.claude/skills/rc-repro\` and \`houston skill install\``,
        },
      ]);
    } finally {
      if (before === undefined) delete process.env['HOME'];
      else process.env['HOME'] = before;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('legacy: looks where earlier releases look, whatever HOME is spelled as', async () => {
    // With HOME set but EMPTY, `os.homedir()` is '' and this reported the WORKING
    // directory's `.rc-repro` and old skills, with relative paths, where earlier releases look
    // under `/`. So the working directory holds a decoy of each, and the rows are
    // `lib/home.ts`'s: empty, the root spelled twice, trailing slashes. Under Jest the
    // mock answers `os.homedir()` with HOME verbatim, as the native call does
    // (`lib/home.test.ts` checks that premise against real processes).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-legacy-home-'));
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-legacy-cwd-'));
    const cwd = process.cwd();
    const rows = ['', '/', '//', `${home}/`, `${home}//`];
    let current = '';
    try {
      for (const dir of [home, decoy]) {
        fs.mkdirSync(path.join(dir, '.rc-repro'), { recursive: true });
        fs.mkdirSync(path.join(dir, '.claude', 'skills', 'rc-repro'), { recursive: true });
      }
      fs.mkdirSync(path.join(decoy, '.agents', 'skills', 'rc-repro'), { recursive: true });
      jest.resetModules();
      jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => current }));
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      process.chdir(decoy);
      const ours: unknown[] = [];
      for (const row of rows) {
        current = row;
        ours.push(await doctor.checkLegacy({} as never));
      }
      // The root spelled any way holds none, and never the working directory's decoys;
      // the two home spellings name the home's leftovers as the bare home does.
      const namedRows = [
        {
          check: 'legacy-artifacts',
          status: 'warn',
          message: `${home}/.rc-repro is still here. It is adopted automatically unless HOUSTON_HOME is set, which it is — unset it and run any houston command, or move it by hand`,
        },
        {
          check: 'legacy-artifacts',
          status: 'warn',
          message: `${home}/.claude/skills/rc-repro still teaches agents to run \`rc-repro\`, a command that no longer exists — \`rm -rf ${home}/.claude/skills/rc-repro\` and \`houston skill install\``,
        },
      ];
      expect(ours).toEqual([[], [], [], namedRows, namedRows]);
      // The rows that CAN hold leftovers name them.
      const named = JSON.stringify(ours.slice(3));
      expect(named).toContain(`${home}/.rc-repro is still here`);
      expect(named).toContain(`${home}/.claude/skills/rc-repro still teaches`);
    } finally {
      process.chdir(cwd);
      jest.dontMock('node:os');
      jest.resetModules();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('legacy: looks where the kernel looks when HOME walks back out of a symlink', async () => {
    // The home's `.rc-repro` and `<host dir>/rc-repro` keep a `..` for the kernel, which
    // follows `link` first: with `link -> other/sub`, HOME `<box>/link/../u` is
    // `<box>/other/u`. `path.join` folded it to `<box>/u` and warned about nothing earlier
    // releases warn about, for the old state directory and for the old skills alike.
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-legacy-link-')));
    fs.mkdirSync(path.join(box, 'other', 'sub'), { recursive: true });
    fs.symlinkSync('other/sub', path.join(box, 'link'));
    fs.mkdirSync(path.join(box, 'other', 'u', '.rc-repro'), { recursive: true });
    fs.mkdirSync(path.join(box, 'other', 'u', '.agents', 'skills', 'rc-repro'), {
      recursive: true,
    });
    const rows = [`${box}/link/../u`];
    const cwd = process.cwd();
    let current = '';
    try {
      jest.resetModules();
      jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => current }));
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      process.chdir(box);
      const ours: unknown[] = [];
      for (const row of rows) {
        current = row;
        ours.push(await doctor.checkLegacy({} as never));
      }
      expect(ours).toEqual([
        [
          {
            check: 'legacy-artifacts',
            status: 'warn',
            message: `${box}/link/../u/.rc-repro is still here. It is adopted automatically unless HOUSTON_HOME is set, which it is — unset it and run any houston command, or move it by hand`,
          },
          {
            check: 'legacy-artifacts',
            status: 'warn',
            message: `${box}/link/../u/.agents/skills/rc-repro still teaches agents to run \`rc-repro\`, a command that no longer exists — \`rm -rf ${box}/link/../u/.agents/skills/rc-repro\` and \`houston skill install\``,
          },
        ],
      ]);
      const named = JSON.stringify(ours);
      expect(named).toContain(`${box}/link/../u/.rc-repro is still here`);
      expect(named).toContain(`${box}/link/../u/.agents/skills/rc-repro still teaches`);
    } finally {
      process.chdir(cwd);
      jest.dontMock('node:os');
      jest.resetModules();
      fs.rmSync(box, { recursive: true, force: true });
    }
  });
});

describe('a Kubernetes record whose cluster is gone', () => {
  afterEach(() => {
    for (const id of [
      '../../src/core/runner/record',
      '../../src/core/kube/probe',
      '../../src/core/kube/context',
      '../../src/core/kube/endpoints',
      '../../src/core/kube/reachability',
      '../../src/core/eks',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  it('is a warning naming the record and the command that clears it, not a failure', async () => {
    // A missing cluster FAILED the preflight when any record referenced it, so the verdict
    // read "Not ready" about a box that was completely usable: the next `up` builds a fresh
    // cluster, and the stale record is a cleanup task. A verdict that fails on tidiness is
    // one people stop reading. The cluster reads are the ones the cluster-to-create case
    // below states; the difference is the one record pointing at it.
    jest.resetModules();
    const names = require('../../src/core/kube/names') as typeof NamesNS;
    const tools = require('../../src/core/kube/tools') as typeof KubeToolsNS;
    const record = jest.requireActual<typeof RecordNS>('../../src/core/runner/record');
    const ghost = record.metadata({
      name: 'ghost',
      project: 'houston-ghost',
      extra: { runtime: 'kubernetes', namespace: 'houston-ghost', context: names.CONTEXT },
    });
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      listMeta: async () => [ghost],
    }));
    jest.doMock('../../src/core/kube/probe', () => ({
      ...jest.requireActual('../../src/core/kube/probe'),
      preflight: async () =>
        tools.preflight({
          clusterExists: false,
          clusterReachable: false,
          distribution: 'kind',
          context: names.CONTEXT,
          provider: 'kind',
          willCreate: true,
        }),
      skew: async () => null,
    }));
    jest.doMock('../../src/core/kube/context', () => ({
      ...jest.requireActual('../../src/core/kube/context'),
      activeContext: async () => '',
      distribution: async () => '',
    }));
    jest.doMock('../../src/core/kube/endpoints', () => ({
      ...jest.requireActual('../../src/core/kube/endpoints'),
      portClaimingCluster: async () => null,
      ingressEndpoint: async () => null,
      endpointString: () => '',
    }));
    jest.doMock('../../src/core/kube/reachability', () => ({
      ...jest.requireActual('../../src/core/kube/reachability'),
      reachable: async () => false,
    }));
    jest.doMock('../../src/core/eks', () => ({
      ...jest.requireActual('../../src/core/eks'),
      cloudReady: () => false,
      identityPretty: () => 'nobody',
      blockers: () => [],
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const rows = await doctor.checkKubernetes({
      context: '',
      dockerUp: false,
      cloud: Promise.resolve({
        tools: {},
        identity: null,
        region: '',
        ready: false,
        blockers: [],
      }),
      owned: Promise.resolve([]),
    } as never);
    const row = rows.find((one) => one.check === 'kubernetes-cluster');
    expect(row?.status).toBe('warn');
    expect(row?.message).toContain('is gone');
    // Actionable: it names the record and the command that clears it.
    expect(row?.message).toContain('ghost');
    expect(row?.message).toContain('houston down');
  });
});

describe('a box that never ran the old name', () => {
  it('gets no rows about leftovers it does not have', async () => {
    // Otherwise the check becomes a permanent paragraph everybody learns to scroll past.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-clean-home-'));
    try {
      jest.resetModules();
      jest.doMock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: () => home }));
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      expect(await doctor.checkLegacy({} as never)).toEqual([]);
    } finally {
      jest.dontMock('node:os');
      jest.resetModules();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the cluster-to-create row', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('names kind the way earlier releases do, from a parsed version', async () => {
    jest.resetModules();
    const tools = require('../../src/core/kube/tools') as typeof KubeToolsNS;
    const present: Record<string, KubeToolsNS.Tool> = {};
    for (const [name, version, raw] of [
      ['kubectl', [1, 36, 3], 'Client Version: v1.36.3'],
      ['helm', [4, 2, 4], 'v4.2.4+g8f3f4c2'],
      ['kind', [0, 32, 0], 'kind v0.32.0 go1.26.3 linux/amd64'],
    ] as [string, number[], string][]) {
      present[name] = tools.makeTool({ name, path: `/usr/local/bin/${name}`, version, raw });
    }
    jest.doMock('../../src/core/kube/probe', () => ({
      ...jest.requireActual('../../src/core/kube/probe'),
      preflight: async (context = '') =>
        tools.preflight({
          tools: present,
          clusterExists: false,
          clusterReachable: false,
          willCreate: true,
          context,
          provider: '',
        }),
      skew: async () => null,
    }));
    jest.doMock('../../src/core/kube/context', () => ({
      ...jest.requireActual('../../src/core/kube/context'),
      activeContext: async () => '',
      distribution: async () => '',
    }));
    jest.doMock('../../src/core/kube/endpoints', () => ({
      ...jest.requireActual('../../src/core/kube/endpoints'),
      portClaimingCluster: async () => null,
      ingressEndpoint: async () => null,
      endpointString: () => '',
    }));
    jest.doMock('../../src/core/kube/reachability', () => ({
      ...jest.requireActual('../../src/core/kube/reachability'),
      reachable: async () => false,
    }));
    jest.doMock('../../src/core/eks', () => ({
      ...jest.requireActual('../../src/core/eks'),
      cloudReady: () => false,
      identityPretty: () => 'nobody',
      blockers: () => [],
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const mine = (
      await doctor.checkKubernetes({
        context: '',
        dockerUp: false,
        cloud: Promise.resolve({
          tools: {},
          identity: null,
          region: '',
          ready: false,
          blockers: [],
        }),
        owned: Promise.resolve([]),
      })
    ).filter((row) => row.check !== 'inotify');
    expect(mine).toEqual([
      {
        check: 'kubernetes-tools',
        status: 'ok',
        message: 'Kubernetes tools present (kubectl 1.36.3, helm 4.2.4, kind 0.32.0)',
      },
      {
        check: 'kubernetes-cluster',
        status: 'ok',
        message: "No cluster yet — 'houston-local' is created on first use by kind 0.32.0",
      },
    ]);
    // The row itself: `by kind 0.32.0`, never `by kind kind v0.32.0 ...`.
    const clusterRow = mine.find((row) => row.check === 'kubernetes-cluster');
    expect(String((clusterRow as { message: string }).message)).toContain('by kind 0.32.0');
  });
});

describe('a MongoDB the engine kernel cannot run', () => {
  afterEach(() => {
    jest.doMock('../../src/core/runner/host', () =>
      (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.dontMock('../../src/lib/versions');
    jest.dontMock('../../src/core/runner/record');
    jest.resetModules();
  });

  it('is refused by the create path before any docker work, as a preflight failure', async () => {
    // SERVER-121912: mongod 8.0 EXITS on kernel >= 6.19 with a message that reads like a
    // volume or permission fault. `doctor` knew the rule but cannot know which release is
    // about to boot, so `up` pulled ~1.5 GB, created the containers and let mongod die.
    jest.resetModules();
    const wrote: string[] = [];
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerKernelVersion: async () => '6.19.7-200.fc43',
    }));
    jest.doMock('../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsNS>('../../src/lib/versions');
      return {
        ...actual,
        resolve: (version: string) => ({
          ...actual.resolve(version, { offline: true }),
          mongoTag: '8.0',
        }),
      };
    });
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      write: async () => {
        wrote.push('wrote');
      },
    }));
    const { createRepro } =
      require('../../src/core/lifecycle/create-docker') as typeof CreateDockerMod;
    const { createReq } = require('../../src/core/lifecycle/types') as typeof TypesMod;
    const { PreflightError } = require('../../src/lib/errors') as typeof ErrorsMod;
    let caught: unknown;
    try {
      await createRepro(
        createReq({ version: '8.6.1', name: 'kernel-trap', wait: false, offline: true }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PreflightError);
    expect(String((caught as Error).message)).toContain('mongod 8.0 exits');
    // A wrong environment is a preflight failure, exit 3.
    expect((caught as { constructor: { exitCode: number } }).constructor.exitCode).toBe(3);
    expect(wrote).toEqual([]);
  });
});

describe('the inotify headroom, against a stated limit', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-inotify-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** `inUse` pinned: the verdict is about what is LEFT, so this box's live use must not leak in. */
  function at(limit: number, clusters: number, inUse = 0): [string, string][] {
    const file = path.join(dir, `lim${String(limit)}`);
    fs.writeFileSync(file, String(limit), 'utf8');
    const { inotifyHeadroom } = require('../../src/core/doctor') as typeof DoctorNS;
    return inotifyHeadroom(clusters, file, inUse);
  }

  it('fails before Traefik starts serving its own certificate, and names the fix', () => {
    // With the limit exhausted Traefik STARTS, loads no dynamic configuration and serves its
    // default certificate -- which looks like a broken route and is neither.
    expect(at(4096, 1)[0]?.[0]).toBe('ok');
    const [status, message] = at(128, 5)[0] ?? ['', ''];
    expect(status).toBe('fail');
    expect(message).toContain('default certificate');
    expect(message).toContain('sysctl');
    expect(message).toContain('max_user_instances');
    expect(at(128, 2)[0]?.[0]).toBe('warn');
    // A limit high enough on paper, already spent, is a failure -- and says what spent it.
    const [spent, said] = at(128, 1, 120)[0] ?? ['', ''];
    expect(spent).toBe('fail');
    expect(said).toContain('in use');
    expect(at(4096, 1, 30)[0]?.[1]).toContain('in use');
    // Not Linux, or a garbage value: silence, never a crash in a diagnostic.
    const { inotifyHeadroom } = require('../../src/core/doctor') as typeof DoctorNS;
    expect(inotifyHeadroom(1, path.join(dir, 'absent'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'garbage'), 'not-a-number', 'utf8');
    expect(inotifyHeadroom(1, path.join(dir, 'garbage'))).toEqual([]);
  });
});

describe('the cluster doctor reports on', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/kube/probe');
    jest.dontMock('../../src/core/rcapi');
    jest.resetModules();
  });

  it('is the one `up` would use: explicit first, then the box default', async () => {
    // `doctor` must not be a second opinion about the boot: it once said "Using your cluster
    // 'default'" while `up` built a kind cluster.
    jest.resetModules();
    const seen: string[] = [];
    jest.doMock('../../src/core/kube/probe', () => ({
      ...jest.requireActual('../../src/core/kube/probe'),
      preflight: async (context = '') => {
        seen.push(context);
        throw new Error('stop after the context is known');
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      releasesReachable: async () => null,
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const cfg = require('../../src/lib/config') as typeof ConfigMod;
    await doctor.runChecks('eks-support');
    expect(seen.at(-1)).toBe('eks-support');
    cfg.updateConfig((c) => {
      c[cfg.KUBE_CONTEXT_KEY] = 'eks-default';
    });
    try {
      await doctor.runChecks();
      expect(seen.at(-1)).toBe('eks-default');
      await doctor.runChecks('explicit');
      expect(seen.at(-1)).toBe('explicit');
    } finally {
      cfg.updateConfig((c) => {
        delete c[cfg.KUBE_CONTEXT_KEY];
      });
    }
  });
});

describe('the build that is answering', () => {
  it('is named, and matches this checkout once the front door has set the version', async () => {
    // An installed package's own metadata is its version, so a stale install reports an old number
    // while the checkout beside it holds the fix; three shipped fixes looked ineffective for
    // that reason. The TypeScript front door sets the version from package.json.
    const jsonout = require('../../src/lib/jsonout') as typeof JsonoutMod;
    const before = jsonout.getHoustonVersion();
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    jsonout.setHoustonVersion(pkg.version);
    try {
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      const rows = await doctor.checkInstall({} as never);
      expect(rows[0]).toMatchObject({ check: 'install-fresh', status: 'ok' });
      expect(String(rows[0]?.message)).toContain('houston');
    } finally {
      jsonout.setHoustonVersion(before);
    }
  });
});

describe('a check that throws', () => {
  afterEach(() => {
    jest.doMock('../../src/core/runner/host', () =>
      (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.dontMock('../../src/core/rcapi');
    jest.resetModules();
  });

  it('still ends the report, rather than a second net letting later checks run', async () => {
    // Each check owns its own `try`; a net in the runner would give the report rows it has
    // never had. That is a behaviour decision, and pinned so it is taken on purpose.
    jest.resetModules();
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerAvailable: async () => {
        throw new Error('planted');
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      releasesReachable: async () => null,
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    await expect(doctor.runChecks()).rejects.toThrow('planted');
  });
});

describe('interrupted work on a box that never runs serve', () => {
  it('is reported as progress while its owner lives, and as a warning once it is gone', async () => {
    // `serve` repairs from the journal at startup; a CLI-only box never starts one, so
    // `doctor` is the only place that would ever mention it.
    // The REAL journal: an earlier case registered a factory for it, which outlives a reset.
    jest.dontMock('../../src/core/journal');
    jest.resetModules();
    const journal = require('../../src/core/journal') as typeof JournalMod;
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    fs.rmSync(journal.journalDir(), { recursive: true, force: true });
    const id = journal.record(journal.RATE_LIMITER_OFF, 'mine');
    try {
      const live = (await doctor.checkWork({} as never)).filter(
        (row) => row.check === 'interrupted-work',
      );
      expect(live[0]).toMatchObject({ status: 'ok' });
      expect(String(live[0]?.message)).toContain('in progress');
      const file = path.join(journal.journalDir(), `${id}.json`);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...data, pid: 2 ** 22, started: '1' }), 'utf8');
      const dead = (await doctor.checkWork({} as never)).filter(
        (row) => row.check === 'interrupted-work',
      );
      expect(dead[0]).toMatchObject({ status: 'warn' });
      expect(String(dead[0]?.message)).toContain('rate limiter');
    } finally {
      fs.rmSync(journal.journalDir(), { recursive: true, force: true });
    }
  });
});
