import * as config from '../../../src/lib/config';
import { nullEmit } from '../../../src/lib/events';
import * as presets from '../../../src/lib/presets/index';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Preset } from '../../../src/lib/presets/types';
import type { Resolved } from '../../../src/lib/versions';
import type * as VersionsNS from '../../../src/lib/versions';
import type * as PolicyNS from '../../testsetup-policy';
import { openEntries } from '../../../src/core/journal';
import { type Metadata, adminPass, metadata, writeRecord } from '../../../src/core/runner/record';

import { createPlan } from '../../../src/core/lifecycle/create-docker';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import { MODE_ACME, tlsSpec } from '../../../src/core/tls';
import { createReq } from '../../../src/core/lifecycle/types';

describe('claiming the Compose ports', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('does not turn a falsy recorded token into the string "false"', async () => {
    // The third of the three sites the review named: a `reg_token: false` in config must
    // mean "no token", because `String(false)` is truthy and would travel into the
    // generated compose document as a licence the user never supplied.
    config.updateConfig((cfg) => {
      cfg.reg_token = false;
    });
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      checkSidecarPorts: async () => undefined,
      checkMonitorPorts: async () => undefined,
      pickHostPort: async () => 3100,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createPlan({ req: createReq({ version: '8.5.1' }), emit: nullEmit });
    // The config `resolvePairing` would have loaded. Without it `plan.cfg` is `{}`, and
    // the test passes whether the token mapping is right or wrong -- the defect class the
    // review itself calls "a case that compares [] to []".
    plan.cfg = config.loadConfig();
    plan.pre = presets.load('default', {});
    await createDocker.claimPorts(plan);
    expect(plan.token).toBe('');
    expect(plan.hostPort).toBe(3100);
    expect(plan.root).toBe('http://localhost:3100');
  });

  it('keeps an explicit token and an explicit bind', async () => {
    config.updateConfig((cfg) => {
      cfg.reg_token = 'from-config';
    });
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      checkSidecarPorts: async () => undefined,
      checkMonitorPorts: async () => undefined,
      pickHostPort: async () => 3200,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createPlan({
      req: createReq({ version: '8.5.1', regToken: 'explicit', bind: '0.0.0.0' }),
      emit: nullEmit,
    });
    plan.cfg = config.loadConfig();
    plan.pre = presets.load('default', {});
    await createDocker.claimPorts(plan);
    expect(plan.token).toBe('explicit');
    expect(plan.bindHost).toBe('0.0.0.0');
  });
});

describe('the create path end to end, stopped at the write seam', () => {
  let bin = '';
  let previousPath: string | undefined;
  beforeEach(() => {
    // A PATH holding one empty directory: no launch this file did not state can happen.
    previousPath = process.env.PATH;
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-nobin-'));
    process.env.PATH = bin;
  });
  afterEach(() => {
    process.env.PATH = previousPath;
    fs.rmSync(bin, { recursive: true, force: true });
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    for (const id of [
      '../../../src/core/lifecycle/sizing',
      '../../../src/core/lifecycle/ports',
      '../../../src/core/lifecycle/tlsplan',
      '../../../src/core/lifecycle/preconditions',
      '../../../src/lib/versions',
      '../../../src/core/runner/record',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  /** The Compose create with the engine stated, capturing the record and the document. */
  function capture(): {
    seen: { meta?: Metadata; yaml?: string };
    createDocker: typeof CreateDockerNS;
  } {
    jest.resetModules();
    const seen: { meta?: Metadata; yaml?: string } = {};
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerKernelVersion: async () => '6.1.0',
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3001,
      checkSidecarPorts: async () => undefined,
      checkMonitorPorts: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    jest.doMock('../../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsNS>('../../../src/lib/versions');
      return {
        ...actual,
        resolve: (version: string): Resolved => actual.resolve(version, { offline: true }),
      };
    });
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual('../../../src/core/runner/record'),
      write: async (_name: string, yaml: string, meta: Metadata) => {
        seen.meta = meta;
        seen.yaml = yaml;
        throw new Error('stopped at the write seam');
      },
    }));
    return {
      seen,
      createDocker: require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS,
    };
  }

  it('leaves no write-ahead note behind for a create that was refused', async () => {
    // The note is for a create that died HALF WAY, not one that never started. With no
    // cleanup on the refusal path every refusal stranded one -- seven accumulated during
    // one audit -- and `doctor` then told the reader to run `houston ready` on a workspace
    // that does not exist, which exits 4. A real refusal: --fresh on Kubernetes.
    const before = openEntries().length;
    const { createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'refu', runtime: 'kubernetes', fresh: true }),
      ),
    ).rejects.toThrow(/--fresh is not supported on Kubernetes/u);
    expect(openEntries()).toHaveLength(before);
  });

  it('keeps the shared password for a workspace nothing off this box can reach', async () => {
    // Loopback is the entire reason `admin123` is acceptable; rotating it here would cost
    // every runbook and buy nothing.
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'loop', wait: false, offline: true }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(seen.meta?.adminPassword).toBe('');
    expect(adminPass(seen.meta as Metadata)).toBe(config.ADMIN_PASSWORD);
    expect(seen.yaml).toContain('admin123');
  });

  it('generates a password for a workspace bound wide', async () => {
    // `--bind 0.0.0.0` removes the same premise by the other mechanism, and it must not
    // be the path left handing `admin123` to the LAN.
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'wide', wait: false, bind: '0.0.0.0', offline: true }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(seen.meta?.adminPassword).not.toBe('');
    expect(seen.yaml).not.toContain('admin123');
  });
});

describe('rebuilding an existing workspace', () => {
  it('carries its env overrides forward, and this run’s win', async () => {
    // `up --force` rebuilds compose from the spec, so overrides must live in the record.
    // Verified live: editing only the generated compose file worked until the next
    // `up --force`, which silently dropped the change.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    await writeRecord(
      'e',
      metadata({ name: 'e', project: 'houston-e', extra: { env: { KEEP_ME: 'yes', GONE: null } } }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name: 'e', env: { NEW: '1', KEEP_ME: 'this run' } }),
      emit: nullEmit,
    });
    plan.reproName = 'e';
    plan.resolved = versions.resolve('8.5.1', { offline: true });
    plan.pre = presets.load('default', {});
    plan.hostPort = 3000;
    plan.root = 'http://localhost:3000';
    plan.bindHost = '127.0.0.1';
    await createDocker.buildDocument(plan);
    expect(plan.envOverrides).toEqual({ KEEP_ME: 'this run', GONE: null, NEW: '1' });
    createDocker.buildRecord(plan);
    expect(plan.meta?.extra.env).toEqual({ KEEP_ME: 'this run', GONE: null, NEW: '1' });
  });
});

describe('what a create says and generates before the build', () => {
  const STATED = [
    '../../../src/core/lifecycle/sizing',
    '../../../src/core/lifecycle/ports',
    '../../../src/core/lifecycle/tlsplan',
    '../../../src/core/lifecycle/preconditions',
    '../../../src/lib/versions',
    '../../../src/core/runner/record',
  ];
  afterEach(() => {
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    for (const id of STATED) jest.dontMock(id);
    jest.resetModules();
  });

  /** The Compose create with the engine, the pairing and the HTTPS plan stated. */
  function stated({
    source = 'releases.rocket.chat',
    domain = '',
  }: { source?: string; domain?: string } = {}): {
    seen: { meta?: Metadata };
    createDocker: typeof CreateDockerNS;
  } {
    jest.resetModules();
    const seen: { meta?: Metadata } = {};
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerKernelVersion: async () => '6.1.0',
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3001,
      checkSidecarPorts: async () => undefined,
      checkMonitorPorts: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () =>
        domain
          ? tlsSpec({ mode: MODE_ACME, host: domain, port: 443, acmeEmail: 'ops@example.com' })
          : null,
    }));
    jest.doMock('../../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsNS>('../../../src/lib/versions');
      return {
        ...actual,
        resolve: (version: string): Resolved => ({
          ...actual.resolve('8.5.1', { offline: true }),
          rcVersion: version,
          source,
        }),
      };
    });
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual('../../../src/core/runner/record'),
      write: async (_name: string, _yaml: string, meta: Metadata) => {
        seen.meta = meta;
        throw new Error('stopped at the write seam');
      },
    }));
    return {
      seen,
      createDocker: require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS,
    };
  }

  it('names a version the index has never heard of before building anything', async () => {
    // `up --version 99.99.99` built the whole compose document and failed ~90s later at
    // docker's own "not found". A warning rather than a refusal: the shipped map can
    // legitimately pair a version the live index has not indexed yet.
    const said: string[] = [];
    let { createDocker } = stated({ source: 'map (no such release)' });
    await createDocker
      .createRepro(
        createReq({ version: '99.99.99', name: 'bogus', wait: false, offline: true }),
        (event) => said.push(event.message),
      )
      .catch(() => undefined);
    expect(said.some((message) => message.includes('has no 99.99.99'))).toBe(true);
    expect(said.some((message) => message.includes('shipped map'))).toBe(true);

    // A version the index DOES know is not warned about.
    said.length = 0;
    ({ createDocker } = stated({ source: 'releases.rocket.chat' }));
    await createDocker
      .createRepro(
        createReq({ version: '8.5.1', name: 'fine', wait: false, offline: true }),
        (event) => said.push(event.message),
      )
      .catch(() => undefined);
    expect(said.filter((message) => message.includes('has no'))).toEqual([]);
  });

  it('gives two public workspaces two different passwords', async () => {
    // Per WORKSPACE: one password for every public workspace on the box would make a
    // single leak the whole box.
    const made: string[] = [];
    for (const [index, host] of ['c1.example.com', 'c2.example.com'].entries()) {
      const { seen, createDocker } = stated({ domain: host });
      await expect(
        createDocker.createRepro(
          createReq({
            version: '8.5.1',
            name: `multi${String(index)}`,
            wait: false,
            domain: host,
            acmeEmail: 'ops@example.com',
            offline: true,
          }),
        ),
      ).rejects.toThrow('stopped at the write seam');
      made.push(seen.meta?.adminPassword ?? '');
    }
    expect(made[0]).not.toBe('');
    expect(made[1]).not.toBe('');
    expect(made[0]).not.toBe(made[1]);
  });
});

describe('the event a create announces itself with', () => {
  afterEach(() => {
    for (const id of ['../../../src/core/runner/record', '../../../src/core/lifecycle/ready'])
      jest.dontMock(id);
    jest.resetModules();
  });

  it('carries its name nested one level, as earlier releases did', async () => {
    // Earlier releases handed the event's data ONE keyword named `data`, so their detail is
    // {"data": {"name": ...}} on the NDJSON stream and in houston.log; this build's was flat.
    // What earlier releases emitted for the same plan, stopped at the same compose call, recorded.
    const recorded = [
      {
        message: "creating 'alpha' - RC 8.5.1, Mongo 8.0 (official), preset default",
        phase: 'create',
        data: { data: { name: 'alpha' } },
      },
    ];

    jest.resetModules();
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/record'),
      write: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ready'),
      upCompose: async () => Promise.reject(new Error('stopped at compose')),
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const events: unknown[] = [];
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'alpha', noPull: true }),
      emit: (event) =>
        events.push({ message: event.message, phase: event.phase, data: event.data }),
    });
    plan.reproName = 'alpha';
    plan.doc = { name: 'houston-alpha', services: {}, volumes: {} };
    plan.resolved = { rcVersion: '8.5.1', mongoTag: '8.0', mongoFlavor: 'official' } as Resolved;
    plan.pre = { name: 'default' } as Preset;
    await expect(createDocker.startTheWorkspace(plan)).rejects.toThrow('stopped at compose');
    expect(events).toEqual([
      {
        message: "creating 'alpha' - RC 8.5.1, Mongo 8.0 (official), preset default",
        phase: 'create',
        data: { data: { name: 'alpha' } },
      },
    ]);
    expect(events).toEqual(recorded);
  });
});
