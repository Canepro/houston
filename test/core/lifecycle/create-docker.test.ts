import * as config from '../../../src/lib/config';
import { nullEmit } from '../../../src/lib/events';
import * as presets from '../../../src/lib/presets/index';

import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';

import type { Preset } from '../../../src/lib/presets/types';
import type { Resolved } from '../../../src/lib/versions';
import type * as VersionsNS from '../../../src/lib/versions';
import type * as PolicyNS from '../../testsetup-policy';
import type * as ContextNS from '../../../src/lib/context';
import { openEntries } from '../../../src/core/journal';
import { type Metadata, adminPass, metadata, writeRecord } from '../../../src/core/runner/record';
import { record as evidenceRecord } from '../../../src/core/evidence';

import {
  buildDocument,
  buildRecord,
  createPlan,
  writeTheWorkspace,
} from '../../../src/core/lifecycle/create-docker';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as CreateK8sNS from '../../../src/core/lifecycle/create-k8s';
import type * as InspectNS from '../../../src/core/lifecycle/inspect';
import type * as PathsNS from '../../../src/core/runner/paths';
import type * as RecordNS from '../../../src/core/runner/record';
import { MODE_ACME, tlsSpec } from '../../../src/core/tls';
import { createReq } from '../../../src/core/lifecycle/types';
import * as users from '../../../src/core/users';

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
    // A wildcard includes loopback, so houston still calls it there.
    expect(plan.root).toBe('http://localhost:3200');
  });

  it('calls a workspace bound to one address on that address', async () => {
    // `--bind 172.17.0.1` published nothing on loopback, so readiness polled
    // `localhost` and `up --wait` always ended exit 5 while Rocket.Chat served on the
    // bridge -- and the warning said it was published "on every interface".
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      checkSidecarPorts: async () => undefined,
      checkMonitorPorts: async () => undefined,
      pickHostPort: async () => 3611,
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
    const said: string[] = [];
    const plan = createPlan({
      req: createReq({ version: '8.5.1', bind: '172.17.0.1' }),
      emit: (event) => said.push(event.message),
    });
    plan.cfg = config.loadConfig();
    plan.pre = presets.load('default', {});
    await createDocker.claimPorts(plan);
    expect(plan.root).toBe('http://172.17.0.1:3611');
    createDocker.warnAboutTheBind(plan);
    expect(said.join(' ')).toContain('to everyone who can reach 172.17.0.1');
    expect(said.join(' ')).not.toContain('every interface');
  });

  it('keeps a rebuilt workspace on its recorded port, unless something else holds it', async () => {
    // `up --force` allocated afresh, from 3000: a workspace on 3301 came back on 3000 and
    // every link to it went dead. A Kubernetes re-up already kept its port. But a stopped
    // workspace's port taken by something else since is not its to keep: the real
    // `pickHostPort` skips the probe for a workspace's own recorded ports, so compose failed
    // to bind it.
    await writeRecord(
      'moved',
      metadata({ name: 'moved', project: 'houston-moved', hostPort: 3301 }),
    );
    let held = false;
    let state = 'exited';
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual('../../../src/core/runner/ports'),
      portFree: async (port: number) => !(held && port === 3301),
      pickPort: async () => 3000,
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => state,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      checkSidecarPorts: async () => undefined,
      checkMonitorPorts: async () => undefined,
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
    const got: number[] = [];
    const said: string[] = [];
    // Free; held by its own running Rocket.Chat; held by something else while it is stopped.
    for (const [taken, rc] of [
      [false, 'exited'],
      [true, 'running'],
      [true, 'exited'],
    ] as const) {
      held = taken;
      state = rc;
      const plan = createPlan({
        req: createReq({ version: '8.5.1', name: 'moved', force: true }),
        emit: (event) => {
          if (event.level === 'warn') said.push(event.message);
        },
        reproName: 'moved',
      });
      plan.cfg = config.loadConfig();
      plan.pre = presets.load('default', {});
      await createDocker.claimPorts(plan);
      got.push(plan.hostPort);
    }
    expect(got).toEqual([3301, 3301, 3000]);
    // The move is said: every link to the old port stops working.
    expect(said).toEqual(["port 3301 is no longer free, so 'moved' moves to 3000"]);
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
      '../../../src/core/runner/engine',
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

  it('records only the effective registration-token presence', async () => {
    const token = 'EVIDENCE-REGISTRATION-TOKEN-SENTINEL';
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'token-evidence',
          regToken: `  ${token}  `,
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');

    const document = YAML.parse(seen.yaml ?? '') as {
      services: { rocketchat: { environment: Record<string, string> } };
    };
    expect(seen.meta?.extra.reg_token_supplied).toBe(true);
    expect(JSON.stringify(seen.meta)).not.toContain(token);
    expect(document.services.rocketchat.environment.REG_TOKEN).toBe(token);
  });

  it('carries final Rocket.Chat token presence from create into evidence', async () => {
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const planAndEvidence = async ({
      name,
      regToken = '',
      env = {},
      presetEnv = {},
      rocketchat = {},
      files = {},
      presetFiles = [],
      instances = 1,
    }: {
      name: string;
      regToken?: string;
      env?: Record<string, string | null>;
      presetEnv?: Record<string, string>;
      rocketchat?: Record<string, unknown>;
      files?: Record<string, string>;
      presetFiles?: [string, string][];
      instances?: number;
    }) => {
      const runnerPaths = require('../../../src/core/runner/paths') as typeof PathsNS;
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(runnerPaths.workspace(name), { recursive: true });
        fs.writeFileSync(path.join(runnerPaths.workspace(name), file), text);
      }
      const preset =
        instances === 1
          ? presets.load('default', {})
          : presets.load('multi-instance', { instances: String(instances) });
      const plan = createPlan({
        req: createReq({ version: '8.5.1', name, preset: preset.name, regToken, env }),
        emit: nullEmit,
        reproName: name,
        resolved: versions.resolve('8.5.1', { offline: true }),
        pre: {
          ...preset,
          env: { ...preset.env, ...presetEnv },
          rocketchat: { ...preset.rocketchat, ...rocketchat },
          files: [...preset.files, ...presetFiles],
        },
        hostPort: 3000,
        root: 'http://localhost:3000',
        bindHost: '127.0.0.1',
      });
      // This owner-boundary drive begins after `claimPorts` has normalized the request.
      // The regression is that later Compose overrides must decide the recorded presence.
      plan.token = regToken.trim();
      await buildDocument(plan);
      buildRecord(plan);
      await writeTheWorkspace(plan);
      const rocketChat = Object.entries(plan.doc?.services ?? {})
        .filter(
          ([service]) => service === 'rocketchat' || /^rocketchat-[1-9][0-9]*$/u.test(service),
        )
        .map(([, service]) => service);
      const environments = rocketChat.map((service) => service.environment ?? {});
      const envFiles = rocketChat.map((service) => service.env_file);
      return {
        environments,
        envFiles,
        evidence: await evidenceRecord(name),
        extra: plan.meta?.extra,
      };
    };

    const examples: Array<{
      name: string;
      regToken?: string;
      env?: Record<string, string | null>;
      presetEnv?: Record<string, string>;
      rocketchat?: Record<string, unknown>;
      files?: Record<string, string>;
      presetFiles?: [string, string][];
      supplied: boolean | null;
      source?: string;
      instances: number;
    }> = [
      {
        name: 'token-removed',
        regToken: 'request-token',
        env: { REG_TOKEN: null },
        supplied: false,
        instances: 2,
      },
      {
        name: 'token-blank',
        regToken: 'request-token',
        env: { REG_TOKEN: '  ' },
        supplied: false,
        instances: 2,
      },
      {
        name: 'token-preset',
        presetEnv: { REG_TOKEN: 'preset-token' },
        supplied: true,
        instances: 2,
      },
      {
        name: 'token-override',
        instances: 2,
        env: { REG_TOKEN: 'override-token' },
        supplied: true,
      },
      {
        name: 'token-list-whitespace',
        rocketchat: { environment: ['REG_TOKEN=  list-token  '] },
        supplied: true,
        instances: 2,
      },
      {
        name: 'token-list-blank',
        rocketchat: { environment: ['REG_TOKEN=  \t'] },
        supplied: false,
        instances: 2,
      },
      {
        // Only the engine knows an ambient value; the create warning does not count it either.
        name: 'token-list-interpolated',
        rocketchat: { environment: ['REG_TOKEN=${HOST_REG_TOKEN}'] },
        supplied: null,
        instances: 2,
      },
      {
        name: 'token-generated-interpolation',
        rocketchat: { env_file: ['generated.env'] },
        presetFiles: [['generated.env', 'REG_TOKEN=${TOKEN:+alternate}\n']],
        supplied: null,
        instances: 2,
      },
      {
        name: 'token-known-license-unknown',
        env: { REG_TOKEN: 'literal-token', ROCKETCHAT_LICENSE: '${LICENCE}' },
        supplied: true,
        source: 'unknown',
        instances: 2,
      },
      {
        name: 'token-list-escaped',
        rocketchat: { environment: ['REG_TOKEN=$$literal'] },
        supplied: true,
        instances: 2,
      },
      {
        name: 'token-env-file',
        rocketchat: { env_file: ['token.env'] },
        files: { 'token.env': 'REG_TOKEN=file-token\n' },
        supplied: true,
        instances: 2,
      },
      {
        // A first create: the preset generates the file, and nothing is on disk yet.
        name: 'token-preset-env-file',
        rocketchat: { env_file: ['token.env'] },
        presetFiles: [['token.env', 'REG_TOKEN=generated-token\n']],
        supplied: true,
        instances: 2,
      },
      {
        name: 'token-env-file-blank',
        rocketchat: { env_file: ['token.env'] },
        files: { 'token.env': 'REG_TOKEN=\n' },
        supplied: false,
        instances: 2,
      },
    ];

    for (const example of examples) {
      const { environments, envFiles, evidence, extra } = await planAndEvidence(example);
      expect(extra?.reg_token_supplied).toBe(example.supplied);
      expect(environments).toHaveLength(example.instances);
      if (Array.isArray(example.rocketchat?.environment)) {
        // Create trims the winning list token before Compose sees it.
        const normalized = (example.rocketchat.environment as string[]).map((entry) =>
          entry.startsWith('REG_TOKEN=') ? `REG_TOKEN=${entry.slice(10).trim()}` : entry,
        );
        expect(environments).toEqual(Array(example.instances).fill(normalized));
      } else if (example.files !== undefined || example.presetFiles !== undefined) {
        expect(envFiles).toEqual(Array(example.instances).fill(example.rocketchat?.env_file));
      } else {
        expect(
          environments.map(
            (environment) =>
              String((environment as Record<string, unknown>).REG_TOKEN ?? '').trim() !== '',
          ),
        ).toEqual(Array(example.instances).fill(example.supplied));
      }
      expect((evidence.license as Record<string, unknown>).supplied).toBe(example.supplied);
      if (example.source !== undefined) {
        expect((evidence.license as Record<string, unknown>).source).toBe(example.source);
        expect(extra?.effective_license).toBeNull();
      }
    }
  });

  it('renders final registration and licence environment consistently with create warnings', async () => {
    // The flag and the box-wide config are trimmed; a preset's env, `--env`, or either
    // final Compose patch can supply or remove the token. The final winning value is
    // normalised before Compose sees it; an unresolved Compose variable cannot hide a
    // warning because only the engine knows its ambient value. Both licence warnings use the
    // final document rather than an earlier input to it.
    const cases = [
      { label: 'config spaces', config: '   ', expected: '' },
      { label: 'flag spaces', flag: '   ', expected: '' },
      { label: 'flag padded', flag: '  registration-fixture  ', expected: 'registration-fixture' },
      { label: 'preset env', presetEnv: 'preset-token', expected: 'preset-token' },
      { label: 'preset env padded', presetEnv: '  preset-token  ', expected: 'preset-token' },
      { label: 'user env', env: { REG_TOKEN: 'user-token' }, expected: 'user-token' },
      { label: 'user env padded', env: { REG_TOKEN: '  user-token  ' }, expected: 'user-token' },
      {
        label: 'flag removed by env',
        flag: 'flag-token',
        env: { REG_TOKEN: null },
        expected: '',
        preset: 'ldap+token-licensed',
        version: '9.0.0',
      },
      { label: 'service patch removes flag', flag: 'flag-token', servicePatch: '', expected: '' },
      {
        label: 'service patch padded',
        servicePatch: '  service-token  ',
        expected: 'service-token',
      },
      {
        label: 'Rocket.Chat patch supplies token',
        rocketchatPatch: 'patch-token',
        expected: 'patch-token',
      },
      {
        label: 'Rocket.Chat patch padded',
        rocketchatPatch: '  patch-token  ',
        expected: 'patch-token',
      },
      {
        label: 'final environment licence',
        env: { ROCKETCHAT_LICENSE: 'fixture-license' },
        expected: '',
        license: 'fixture-license',
        preset: 'ldap+token-licensed',
        version: '9.0.0',
      },
      {
        label: 'empty final licence overrides file',
        env: { ROCKETCHAT_LICENSE: '' },
        expected: '',
        license: 'fixture-license',
        expectedLicense: '',
        licensed: false,
        warns: true,
        preset: 'ldap+token-licensed',
        version: '9.0.0',
      },
      {
        label: 'unresolved licence interpolation',
        env: { ROCKETCHAT_LICENSE: '${LICENCE:-fallback}' },
        expected: '',
        expectedLicense: '${LICENCE:-fallback}',
        licensed: false,
        warns: true,
        uncertain: true,
      },
      {
        label: 'unresolved token interpolation',
        uncertain: true,
        env: { REG_TOKEN: '${UNSET_REG_TOKEN}' },
        expected: '${UNSET_REG_TOKEN}',
        warns: true,
      },
    ] as const;
    for (const one of cases) {
      config.updateConfig((cfg) => {
        cfg.reg_token = 'config' in one ? one.config : '';
      });
      fs.mkdirSync(config.presetDir(), { recursive: true });
      fs.writeFileSync(
        path.join(config.presetDir(), 'token-licensed.yaml'),
        'name: token-licensed\nrequires_license: true\n' +
          ('presetEnv' in one ? `env:\n  REG_TOKEN: ${JSON.stringify(one.presetEnv)}\n` : '') +
          ('servicePatch' in one
            ? `services:\n  rocketchat:\n    environment:\n      REG_TOKEN: ${JSON.stringify(one.servicePatch)}\n`
            : '') +
          ('rocketchatPatch' in one
            ? `rocketchat:\n  environment:\n    REG_TOKEN: ${JSON.stringify(one.rocketchatPatch)}\n`
            : ''),
      );
      const { seen, createDocker } = capture();
      const codes: string[] = [];
      const messages: string[] = [];
      await expect(
        createDocker.createRepro(
          createReq({
            version: 'version' in one ? one.version : '8.5.1',
            name: `token-${one.label.replace(/ /gu, '-')}`,
            preset: 'preset' in one ? one.preset : 'token-licensed',
            regToken: 'flag' in one ? one.flag : '',
            license: 'license' in one ? one.license : '',
            env: 'env' in one ? one.env : {},
            wait: false,
            offline: true,
          }),
          (event) => {
            codes.push(event.code);
            messages.push(event.message);
          },
        ),
      ).rejects.toThrow('stopped at the write seam');
      const doc = YAML.parse(seen.yaml as string) as {
        services: { rocketchat: { environment: Record<string, string> } };
      };
      expect([one.label, doc.services.rocketchat.environment.REG_TOKEN ?? '']).toEqual([
        one.label,
        one.expected,
      ]);
      expect(doc.services.rocketchat.environment.ROCKETCHAT_LICENSE ?? '').toBe(
        'expectedLicense' in one ? one.expectedLicense : 'license' in one ? one.license : '',
      );
      const licensed = 'licensed' in one ? one.licensed : 'license' in one;
      const warns = 'warns' in one ? one.warns : one.expected === '' && !licensed;
      expect(seen.meta?.extra.licensed === true).toBe(licensed);
      expect([one.label, codes.includes('LICENSE_ABSENT_EE_PRESET')]).toEqual([one.label, warns]);
      if ('uncertain' in one) {
        expect(
          seen.meta?.extra.effective_license === null ||
            seen.meta?.extra.reg_token_supplied === null,
        ).toBe(true);
        expect(
          messages.some((message) => message.includes('unknown until Compose resolves its inputs')),
        ).toBe(true);
      }
      if (warns && ('flag' in one || 'license' in one)) {
        const warnings = messages.filter(
          (message) =>
            message.includes('Enterprise feature') ||
            message.includes('Premium plan for LDAP login'),
        );
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        for (const message of warnings) {
          expect(message).toContain(
            'uncertain' in one
              ? 'unknown until Compose resolves its inputs'
              : 'no effective licence or registration token',
          );
          expect(message).toContain('override');
          expect(message).toMatch(/remove or change/iu);
          expect(message).not.toContain('neither --license nor --reg-token');
        }
        if ('version' in one) expect(warnings).toHaveLength(2);
      }
      if (!warns) {
        expect(messages.some((message) => message.includes('Premium plan for LDAP login'))).toBe(
          false,
        );
      }
    }
  });

  it('checks each replica for either credential while keeping licence metadata separate', async () => {
    const file = path.join(config.presetDir(), 'ldap.yaml');
    const cases = [
      {
        label: 'mixed literals',
        first: { ROCKETCHAT_LICENSE: 'fixture-license' },
        second: { REG_TOKEN: '  fixture-token  ' },
        warns: false,
        licensed: false,
      },
      {
        label: 'blank second token',
        first: { ROCKETCHAT_LICENSE: 'fixture-license' },
        second: { REG_TOKEN: '   ' },
        warns: true,
        licensed: false,
      },
      {
        label: 'unresolved second token',
        first: { ROCKETCHAT_LICENSE: 'fixture-license' },
        second: { REG_TOKEN: '${UNSET_REG_TOKEN}' },
        warns: true,
        licensed: false,
      },
      {
        label: 'file and masked licence rescued by token',
        first: {},
        second: { ROCKETCHAT_LICENSE: '', REG_TOKEN: 'fixture-token' },
        license: 'file-license',
        warns: false,
        licensed: false,
      },
      {
        label: 'blank overrides file',
        first: {},
        second: { ROCKETCHAT_LICENSE: '', REG_TOKEN: '' },
        license: 'file-license',
        warns: true,
        licensed: false,
      },
      {
        label: 'unresolved licence overrides file',
        first: {},
        second: { ROCKETCHAT_LICENSE: '${UNSET_LICENSE}' },
        license: 'file-license',
        warns: true,
        licensed: false,
      },
      {
        label: 'detached file',
        first: {},
        second: {},
        license: 'file-license',
        detached: true,
        warns: true,
        licensed: false,
      },
      {
        label: 'all file licensed',
        first: {},
        second: {},
        license: 'file-license',
        warns: false,
        licensed: true,
      },
    ] as const;
    config.updateConfig((cfg) => {
      delete cfg.reg_token;
    });
    fs.mkdirSync(config.presetDir(), { recursive: true });
    try {
      for (const one of cases) {
        fs.writeFileSync(
          file,
          YAML.stringify({
            name: 'ldap',
            requires_license: true,
            instances: 2,
            services: {
              'rocketchat-1': { environment: one.first },
              'rocketchat-2': {
                environment: one.second,
                ...('detached' in one ? { env_file: [] } : {}),
              },
            },
          }),
        );
        const { seen, createDocker } = capture();
        const codes: string[] = [];
        const messages: string[] = [];
        await expect(
          createDocker.createRepro(
            createReq({
              version: '9.0.0',
              name: 'replica-credentials',
              preset: 'ldap',
              license: 'license' in one ? one.license : '',
              wait: false,
              offline: true,
            }),
            (event) => {
              codes.push(event.code);
              messages.push(event.message);
            },
          ),
        ).rejects.toThrow('stopped at the write seam');
        const doc = YAML.parse(seen.yaml as string) as {
          services: Record<string, { environment: Record<string, string>; env_file?: string[] }>;
        };
        expect(Object.keys(doc.services)).toEqual(
          expect.arrayContaining(['rocketchat-1', 'rocketchat-2']),
        );
        if ('REG_TOKEN' in one.second && !one.warns)
          expect(doc.services['rocketchat-2']?.environment.REG_TOKEN).toBe('fixture-token');
        if ('license' in one)
          expect(doc.services['rocketchat-1']?.env_file).toContain('.license.env');
        expect([one.label, codes.includes('LICENSE_ABSENT_EE_PRESET')]).toEqual([
          one.label,
          one.warns,
        ]);
        expect([
          one.label,
          messages.some((message) => message.includes('Premium plan for LDAP login')),
        ]).toEqual([one.label, one.warns]);
        expect([one.label, seen.meta?.extra.licensed === true]).toEqual([one.label, one.licensed]);
      }
    } finally {
      fs.rmSync(file, { force: true });
      config.updateConfig((cfg) => {
        delete cfg.reg_token;
      });
    }
  });

  it('recognizes equivalent project licence files without trusting other files or masked entries', async () => {
    const file = path.join(config.presetDir(), 'ldap.yaml');
    const cases = [
      { label: 'short string', envFile: './.license.env', licensed: true },
      { label: 'short list', envFile: ['./.license.env'], licensed: true },
      {
        label: 'long path',
        envFile: [{ path: './.license.env', required: false }],
        licensed: true,
      },
      { label: 'normalized relative', envFile: ['sub/../.license.env'], licensed: true },
      { label: 'absolute project file', envFile: [], absolute: true, licensed: true },
      { label: 'later blank', envFile: [], later: 'ROCKETCHAT_LICENSE=\n', licensed: false },
      {
        label: 'generated last',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE=\n',
        reverse: true,
        licensed: true,
      },
      { label: 'later unrelated', envFile: [], later: 'OTHER=value\n', licensed: true },
      {
        label: 'later literal',
        envFile: [],
        later: "ROCKETCHAT_LICENSE='other-synthetic'\n",
        licensed: true,
      },
      {
        label: 'later unresolved',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE=${UNSET_LICENSE}\n',
        licensed: false,
      },
      {
        label: 'later multiline unrelated',
        envFile: [],
        later: "OTHER='first\nROCKETCHAT_LICENSE=\nlast'\n",
        licensed: true,
      },
      {
        label: 'later multiline blank',
        envFile: [],
        later: "ROCKETCHAT_LICENSE=' \n \n'\n",
        licensed: false,
      },
      {
        label: 'later double escaped blank',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE="\\t\\n\\f\\v\\0040"\n',
        licensed: false,
      },
      {
        // compose-go turns \040, \011 and \012 into whitespace. \0040 already did.
        label: 'later double quoted octal space',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE="\\011\\012\\040"\n',
        licensed: false,
      },
      {
        label: 'later single quoted octal space',
        envFile: [],
        later: "ROCKETCHAT_LICENSE='\\040'\n",
        licensed: true,
      },
      {
        label: 'later octal space beside a character',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE="x\\040"\n',
        licensed: true,
      },
      {
        label: 'later single quoted dollars',
        envFile: [],
        later: "ROCKETCHAT_LICENSE='${LITERAL}'\n",
        licensed: true,
      },
      {
        label: 'later escaped dollars',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE="\\$LITERAL"\n',
        licensed: true,
      },
      {
        label: 'literal dollar path',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE=\n',
        dollar: true,
        licensed: false,
      },
      { label: 'later unset', envFile: [], later: 'ROCKETCHAT_LICENSE\n', licensed: false },
      {
        label: 'explicit wins',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE=\n',
        env: { ROCKETCHAT_LICENSE: 'explicit-synthetic' },
        licensed: true,
      },
      {
        label: 'raw literal',
        envFile: [],
        later: 'ROCKETCHAT_LICENSE=${LITERAL}\n',
        raw: true,
        licensed: true,
      },
      { label: 'optional missing', envFile: [], missing: true, licensed: true },
      { label: 'different file', envFile: ['other.env'], licensed: false },
      { label: 'parent file', envFile: ['../.license.env'], licensed: false },
      {
        label: 'unresolved path',
        envFile: ['${UNSET_LICENSE_DIR}/../.license.env'],
        licensed: false,
      },
      {
        label: 'blank env masks file',
        envFile: ['./.license.env'],
        env: { ROCKETCHAT_LICENSE: '' },
        licensed: false,
      },
      {
        label: 'unresolved env masks file',
        envFile: [{ path: './.license.env' }],
        env: { ROCKETCHAT_LICENSE: '${UNSET_LICENSE}' },
        licensed: false,
      },
    ] as const;
    config.updateConfig((cfg) => {
      delete cfg.reg_token;
    });
    fs.mkdirSync(config.presetDir(), { recursive: true });
    const observed: unknown[] = [];
    try {
      for (const [index, one] of cases.entries()) {
        const name = `file-licence-${String(index)}`;
        let envFile: unknown =
          'absolute' in one ? path.join(config.reprosDir(), name, '.license.env') : one.envFile;
        if ('later' in one || 'missing' in one) {
          const later = path.join(
            config.presetDir(),
            `synthetic-${'dollar' in one ? '$literal-' : ''}${String(index)}.env`,
          );
          if ('later' in one) fs.writeFileSync(later, one.later);
          const entry = {
            path: later.replace(/\$/gu, '$$$$'),
            ...('raw' in one ? { format: 'raw' } : {}),
            required: false,
          };
          envFile =
            'reverse' in one ? [entry, './.license.env'] : [{ path: 'sub/../.license.env' }, entry];
        }
        fs.writeFileSync(
          file,
          YAML.stringify({
            name: 'ldap',
            requires_license: true,
            rocketchat: { env_file: envFile, environment: 'env' in one ? one.env : {} },
          }),
        );
        const { seen, createDocker } = capture();
        const events: { code: string; message: string }[] = [];
        await expect(
          createDocker.createRepro(
            createReq({
              version: '9.0.0',
              name,
              preset: 'ldap',
              license: 'synthetic-file-licence',
              wait: false,
              offline: true,
            }),
            (event) => events.push(event),
          ),
        ).rejects.toThrow('stopped at the write seam');
        // Persist the actual lifecycle record, then use the same summary as info/GUI.
        await writeRecord(name, seen.meta as Metadata);
        const record = require('../../../src/core/runner/record') as typeof RecordNS;
        const inspect = require('../../../src/core/lifecycle/inspect') as typeof InspectNS;
        const meta = await record.readMeta(name);
        observed.push([
          one.label,
          events.some((event) => event.code === 'LICENSE_ABSENT_EE_PRESET'),
          events.some((event) => event.message.includes('Premium plan for LDAP login')),
          meta.extra.licensed === true,
          (await inspect.summary(meta)).licensed,
        ]);
        expect(JSON.stringify(meta)).not.toContain('synthetic-file-licence');
      }
      expect(observed).toEqual(
        cases.map((one) => [one.label, !one.licensed, !one.licensed, one.licensed, one.licensed]),
      );
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('warns that Rocket.Chat 9 may refuse an unlicensed LDAP login', async () => {
    // An earlier case leaves a box-wide token, which rightly silences the warning.
    config.updateConfig((cfg) => {
      delete cfg.reg_token;
    });
    const { createDocker } = capture();
    const said: string[] = [];
    await expect(
      createDocker.createRepro(
        createReq({ version: '9.0.0', name: 'nine', preset: 'ldap', wait: false, offline: true }),
        (event) => said.push(event.message),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(said.filter((line) => line.includes('Premium plan for LDAP login'))).toHaveLength(1);
  });

  it('builds several presets as one workspace, recorded under the canonical name', async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'combo',
          preset: 'email+ldap',
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(seen.meta?.preset).toBe('email+ldap');
    expect(seen.yaml).toContain('mailpit:');
    expect(seen.yaml).toContain('openldap:');
    expect(seen.yaml).toMatch(
      /OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: '?true'?\n/u,
    );
  });

  it("records the set: one preset string, the list and each preset's params in extra", async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'combo-rec',
          preset: 'email+ldap',
          params: { 'ldap.users': '7' },
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    const extra = seen.meta?.extra ?? {};
    expect([seen.meta?.preset, extra.presets, extra.preset_params, 'params' in extra]).toEqual([
      'email+ldap',
      ['email', 'ldap'],
      { email: {}, ldap: { users: '7' } },
      false,
    ]);
  });

  it('records one preset exactly as before: flat params, no list', async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'one-rec',
          preset: 'ldap',
          params: { users: '3' },
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    const extra = seen.meta?.extra ?? {};
    expect([seen.meta?.preset, extra.params, 'presets' in extra, 'preset_params' in extra]).toEqual(
      ['ldap', { users: '3' }, false, false],
    );
  });

  it('gives every instance of a multi-instance deployment the scenario', async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'mi-ldap',
          preset: 'ldap',
          deployment: 'multi-instance',
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect([seen.meta?.preset, seen.meta?.extra.presets]).toEqual([
      'ldap+multi-instance',
      ['ldap', 'multi-instance'],
    ]);
    const yaml = seen.yaml ?? '';
    for (const service of ['rocketchat-1:', 'rocketchat-2:', 'openldap:', 'traefik:']) {
      expect(yaml).toContain(service);
    }
    expect(yaml.split('OVERWRITE_SETTING_LDAP_Enable').length - 1).toBe(2);
  });

  it("issues an LDAPS directory houston's certificate and hands Rocket.Chat the CA", async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'ldaps',
          preset: 'ldap',
          params: { tls: 'ldaps' },
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    const yaml = seen.yaml ?? '';
    expect(yaml).toContain(
      './ldap/certs/ldap.crt:/container/service/slapd/assets/certs/ldap.crt:ro',
    );
    // The PEM survives the document: parsed back, it is the CA houston signs with.
    const doc = YAML.parse(yaml) as {
      services: { rocketchat: { environment: Record<string, string> } };
    };
    const ca = doc.services.rocketchat.environment.OVERWRITE_SETTING_LDAP_CA_Cert ?? '';
    expect(ca.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
    expect(ca.trimEnd().endsWith('-----END CERTIFICATE-----')).toBe(true);
    expect(seen.meta?.extra.directory_tls).toBe('ldaps');
  });

  it('refuses saml + oidc before anything is written', async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'sso2',
          preset: 'oidc+saml',
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('one SSO preset per workspace');
    expect(seen.yaml).toBeUndefined();
  });

  it.each([
    ['e2ee', { policy: 'enforced' }],
    ['e2ee+email', { 'e2ee.policy': 'enforced' }],
  ])(
    'refuses %s with policy=enforced on a Rocket.Chat before 8.8.0, before anything is written',
    async (preset, params) => {
      // 8.5.1 has no E2E_Force_Encryption_For_Private_Rooms: it would ignore the setting and
      // the workspace would enforce nothing while its record said it does.
      const { seen, createDocker } = capture();
      const refused = createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'enf', preset, params, wait: false, offline: true }),
      );
      await expect(refused).rejects.toThrow(
        'e2ee policy=enforced needs Rocket.Chat 8.8.0 or later; 8.5.1 would not enforce it.',
      );
      // A usage error: exit 2, before the cluster, the edge or the record is touched.
      await expect(refused).rejects.toHaveProperty('exitCode', 2);
      expect(seen.meta).toBeUndefined();
    },
  );

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

  /** `up --force -n <name>` as `actor` over a workspace that exists: the record it writes. */
  async function forcedAs(actor: string, name: string): Promise<string> {
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      down: async () => 0,
    }));
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name, actor, force: true, wait: false, offline: true }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    return `${String(seen.meta?.name)} by ${String(seen.meta?.extra.created_by)}`;
  }

  it('rebuilds the workspace a member was handed, and gives anyone else their own', async () => {
    // `HOUSTON_USER=mem houston up -n g2 --force` on g2, handed to mem, said "workspace
    // name: mem-g2" and made a second workspace; g2 was untouched. Every other command
    // resolves the exact name first. Somebody else's name still gets the actor's prefix.
    await writeRecord(
      'g2',
      metadata({ name: 'g2', project: 'houston-g2', extra: { created_by: 'root', owner: 'mem' } }),
    );
    expect([await forcedAs('mem', 'g2'), await forcedAs('mem2', 'g2')]).toEqual([
      'g2 by root',
      'mem2-g2 by mem2',
    ]);
  });

  it('rebuilds the workspace an admin names, and keeps who made it', async () => {
    // `HOUSTON_USER=kadmin houston up -n k1` with k1 there made a new `kadmin-k1`. Acting on
    // k1, the rebuilt record must not make the admin its creator, and so its owner.
    await users.add('kadmin', 'a-good-enough-password', 'admin');
    await writeRecord(
      'k1',
      metadata({ name: 'k1', project: 'houston-k1', extra: { created_by: 'kmem' } }),
    );
    expect(await forcedAs('kadmin', 'k1')).toBe('k1 by kmem');
  });

  it('asks again under the lock, so a workspace handed away while the request waited is refused', async () => {
    // `claimTypedName` looks before the workspace lock, and a plain `--force` asks nobody:
    // a member's create queued behind the lock, then handed to alice, rebuilt alice's
    // workspace with the member's request.
    await writeRecord(
      'g3',
      metadata({
        name: 'g3',
        project: 'houston-g3',
        extra: { created_by: 'root', owner: 'alice' },
      }),
    );
    const { seen, createDocker } = capture();
    const context = require('../../../src/lib/context') as typeof ContextNS;
    const req = createReq({
      version: '8.5.1',
      name: 'g3',
      actor: 'mem',
      exactName: true,
      force: true,
      wait: false,
      offline: true,
    });
    await expect(
      context.runWithContext({ actor: 'mem' }, () => createDocker.createReproLocked(req)),
    ).rejects.toThrow('g3 belongs to alice');
    expect(seen.meta).toBeUndefined();
  });

  it('keeps an earlier licence when Compose will skip a missing licence file', async () => {
    // An optional .license.env that is not on disk was treated as a blank assignment, so
    // it cleared the licence an earlier env file had already set. A file that is present
    // still counts only for the assignment it actually contains.
    const preset = path.join(config.presetDir(), 'env-licence.yaml');
    const earlier = path.join(config.presetDir(), 'synthetic-earlier-licence.env');
    const earlierText = 'synthetic-earlier-licence';
    const presentText = 'synthetic-present-licence';
    const cases = [
      {
        label: 'optional missing keeps earlier',
        license: '',
        licensed: true,
        writeEarlier: true,
        writeLicenseFile: false,
        licenseBody: '',
      },
      {
        label: 'present blank clears',
        license: '',
        licensed: false,
        writeEarlier: false,
        writeLicenseFile: true,
        licenseBody: 'ROCKETCHAT_LICENSE=\n',
      },
      {
        label: 'present assignment sets',
        license: '',
        licensed: true,
        writeEarlier: false,
        writeLicenseFile: true,
        licenseBody: `ROCKETCHAT_LICENSE=${presentText}\n`,
      },
    ];
    config.updateConfig((cfg) => {
      delete cfg.reg_token;
    });
    fs.mkdirSync(config.presetDir(), { recursive: true });
    fs.writeFileSync(earlier, `ROCKETCHAT_LICENSE=${earlierText}\n`);
    const observed: unknown[] = [];
    try {
      for (const [index, one] of cases.entries()) {
        const name = `env-licence-${String(index)}`;
        const licenseFile = path.join(config.reprosDir(), name, '.license.env');
        fs.rmSync(path.dirname(licenseFile), { recursive: true, force: true });
        if (one.writeLicenseFile) {
          fs.mkdirSync(path.dirname(licenseFile), { recursive: true });
          fs.writeFileSync(licenseFile, one.licenseBody, { mode: 0o600 });
        }
        const envFile = one.writeEarlier
          ? [earlier, { path: './.license.env', required: false }]
          : [{ path: './.license.env', required: false }];
        fs.writeFileSync(
          preset,
          YAML.stringify({
            name: 'env-licence',
            requires_license: true,
            rocketchat: { env_file: envFile },
          }),
        );
        const { seen, createDocker } = capture();
        const codes: string[] = [];
        await expect(
          createDocker.createRepro(
            createReq({
              version: '8.5.1',
              name,
              preset: 'env-licence',
              license: one.license,
              wait: false,
              offline: true,
            }),
            (event) => codes.push(event.code),
          ),
        ).rejects.toThrow('stopped at the write seam');
        const meta = seen.meta as Metadata;
        observed.push([
          one.label,
          codes.includes('LICENSE_ABSENT_EE_PRESET'),
          meta.extra.licensed === true,
        ]);
        const stored = JSON.stringify(meta);
        expect(stored).not.toContain(earlierText);
        expect(stored).not.toContain(presentText);
      }
      expect(observed).toEqual(cases.map((one) => [one.label, !one.licensed, one.licensed]));
    } finally {
      fs.rmSync(preset, { force: true });
      fs.rmSync(earlier, { force: true });
    }
  });

  it('counts a registration token that arrives only through an env file', async () => {
    // REG_TOKEN was read from the explicit environment and not from the same ordered env
    // files as a licence, so a registered container still warned that no credential existed.
    const preset = path.join(config.presetDir(), 'token-file.yaml');
    const tokenFile = path.join(config.presetDir(), 'synthetic-token.env');
    const blankFile = path.join(config.presetDir(), 'synthetic-token-blank.env');
    const token = 'synthetic-reg-token';
    const cases = [
      {
        label: 'file token',
        envFile: [tokenFile],
        env: {},
        warns: false,
      },
      {
        label: 'blank file',
        envFile: [blankFile],
        env: {},
        warns: true,
      },
      {
        label: 'explicit blank wins',
        envFile: [tokenFile],
        env: { REG_TOKEN: '' },
        warns: true,
      },
      {
        label: 'later blank file',
        envFile: [tokenFile, blankFile],
        env: {},
        warns: true,
      },
    ];
    config.updateConfig((cfg) => {
      delete cfg.reg_token;
    });
    fs.mkdirSync(config.presetDir(), { recursive: true });
    fs.writeFileSync(tokenFile, `REG_TOKEN=${token}\n`);
    fs.writeFileSync(blankFile, 'REG_TOKEN=\n');
    const observed: unknown[] = [];
    try {
      for (const [index, one] of cases.entries()) {
        fs.writeFileSync(
          preset,
          YAML.stringify({
            name: 'token-file',
            requires_license: true,
            rocketchat: { env_file: one.envFile, environment: one.env },
          }),
        );
        const { seen, createDocker } = capture();
        const codes: string[] = [];
        await expect(
          createDocker.createRepro(
            createReq({
              version: '8.5.1',
              name: `token-file-${String(index)}`,
              preset: 'token-file',
              wait: false,
              offline: true,
            }),
            (event) => codes.push(event.code),
          ),
        ).rejects.toThrow('stopped at the write seam');
        observed.push([one.label, codes.includes('LICENSE_ABSENT_EE_PRESET')]);
        const stored = `${JSON.stringify(seen.meta)}\n${String(seen.yaml)}`;
        expect(stored).not.toContain(token);
      }
      expect(observed).toEqual(cases.map((one) => [one.label, one.warns]));
    } finally {
      fs.rmSync(preset, { force: true });
      fs.rmSync(tokenFile, { force: true });
      fs.rmSync(blankFile, { force: true });
    }
  });
});

describe('rebuilding an existing workspace', () => {
  it('keeps a handed-over owner when the record is rebuilt', async () => {
    // `up --force` rebuilt the record from scratch: whoever ran it became the owner of a
    // workspace that had been handed to someone else.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const history = [{ from: 'mem2', to: 'mem', by: 'admin', at: '2026-10-12T13:00:00Z' }];
    await writeRecord(
      'handed',
      metadata({
        name: 'handed',
        project: 'houston-handed',
        extra: { created_by: 'mem2', owner: 'mem', owner_history: history },
      }),
    );
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'handed', force: true }),
      emit: nullEmit,
      reproName: 'handed',
      resolved: versions.resolve('8.5.1', { offline: true }),
      pre: presets.load('default', {}),
      root: 'http://localhost:3331',
      hostPort: 3331,
      bindHost: '127.0.0.1',
    });
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    expect(plan.meta?.extra).toMatchObject({ owner: 'mem', owner_history: history });
  });

  it('keeps it pinned when the record is rebuilt', async () => {
    // `up --force` without --pin wrote `pinned: false`, and the next `prune` would delete it.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await writeRecord(
      'pinned',
      metadata({ name: 'pinned', project: 'houston-pinned', pinned: true }),
    );
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'pinned', force: true }),
      emit: nullEmit,
      reproName: 'pinned',
      resolved: versions.resolve('8.5.1', { offline: true }),
      pre: presets.load('default', {}),
      root: 'http://localhost:3331',
      hostPort: 3331,
      bindHost: '127.0.0.1',
    });
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    expect(plan.meta?.pinned).toBe(true);
  });

  it('keeps its monitoring without --monitor, as a Kubernetes re-up does', async () => {
    // `up --force` dropped Prometheus and Grafana without a word: `info` went from
    // monitoring true to null and the Grafana link with it.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await writeRecord(
      'watched',
      metadata({ name: 'watched', project: 'houston-watched', extra: { monitoring: true } }),
    );
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name: 'watched', force: true }),
      emit: nullEmit,
    });
    await createDocker.resolveAxesStep(plan);
    expect(plan.req.monitor).toBe(true);
  });
  it('Grafana public URL regression: passes the TLS URL into the compose document and notes', async () => {
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'grafana', monitor: true }),
      emit: nullEmit,
    });
    plan.reproName = 'grafana';
    plan.resolved = versions.resolve('8.5.1', { offline: true });
    plan.pre = presets.load('default', {});
    plan.hostPort = 3310;
    plan.root = 'http://localhost:3310';
    plan.public = 'https://h';
    plan.bindHost = '127.0.0.1';
    plan.tlsspec = tlsSpec({ mode: 'local', host: 'h' });
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    createDocker.attachMonitoring(plan);
    expect(plan.doc?.services.grafana?.environment).toHaveProperty(
      'GF_SERVER_ROOT_URL',
      'https://h/grafana/',
    );
    expect(plan.meta?.extra.notes).toEqual(
      expect.arrayContaining([
        'Grafana:    https://h/grafana  (admin/admin; anonymous view enabled)',
      ]),
    );
  });
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

  it('keeps the admin password its database holds, and mints one only for --fresh', async () => {
    // Rocket.Chat reads ADMIN_PASS only when it fills an empty database, so a new password
    // on a rebuild was recorded and accepted by nothing: every houston login after
    // `up --force` on an HTTPS workspace answered 401, seen live.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    await writeRecord(
      'pw',
      metadata({ name: 'pw', project: 'houston-pw', adminPassword: 'Kept-Pass-1' }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const passwordFor = async (fresh: boolean) => {
      const plan = createPlan({
        req: createReq({ version: '8.5.1', name: 'pw', force: true, fresh }),
        emit: nullEmit,
      });
      plan.reproName = 'pw';
      plan.resolved = versions.resolve('8.5.1', { offline: true });
      plan.pre = presets.load('default', {});
      plan.hostPort = 3000;
      plan.root = 'http://localhost:3000';
      plan.bindHost = '0.0.0.0';
      await createDocker.buildDocument(plan);
      return plan.adminPassword;
    };
    expect(await passwordFor(false)).toBe('Kept-Pass-1');
    expect(await passwordFor(true)).not.toBe('Kept-Pass-1');
  });

  it('says so when a workspace made on loopback comes back public with the shared password', async () => {
    // Its database holds admin123 and keeps it; a generated one would be printed and
    // refused, so the shared one is kept, and said, now that it is reachable.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    await writeRecord('lo', metadata({ name: 'lo', project: 'houston-lo', adminPassword: '' }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name: 'lo', force: true }),
      emit: (event) => said.push(event.message),
    });
    plan.reproName = 'lo';
    plan.resolved = versions.resolve('8.5.1', { offline: true });
    plan.pre = presets.load('default', {});
    plan.hostPort = 3000;
    plan.root = 'http://localhost:3000';
    plan.bindHost = '0.0.0.0';
    await createDocker.buildDocument(plan);
    expect(plan.adminPassword).toBe('');
    expect(said.join('\n')).toContain('reachable from other machines and keeps the admin password');
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

  it('names the presets asked for, not the deployment Compose builds with them', async () => {
    // `up --deployment multi-instance -p saml` said "preset multi-instance+saml", while the
    // panel's Preset row said `saml`: multi-instance is the deployment, not a preset.
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
    const said: string[] = [];
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'd2', noPull: true }),
      emit: (event) => said.push(event.message),
    });
    plan.reproName = 'd2';
    plan.doc = { name: 'houston-d2', services: {}, volumes: {} };
    plan.resolved = { rcVersion: '8.8.0', mongoTag: '8.0', mongoFlavor: 'official' } as Resolved;
    plan.pre = { name: 'multi-instance+saml' } as Preset;
    await expect(createDocker.startTheWorkspace(plan)).rejects.toThrow('stopped at compose');
    expect(said).toContain("creating 'd2' - RC 8.8.0, Mongo 8.0 (official), preset saml");
  });
});

describe('a rebuild that names no preset', () => {
  async function axesFor(name: string, recorded: Partial<Metadata>, runtime = '') {
    await writeRecord(name, metadata({ name, project: `houston-${name}`, ...recorded }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name, preset: '', force: true, runtime }),
      emit: (event) => said.push(event.message),
    });
    await createDocker.resolveAxesStep(plan);
    return { req: plan.req, said };
  }

  it("keeps a composed workspace's presets and their params, and says so", async () => {
    const { req, said } = await axesFor('keep-combo', {
      preset: 'email+ldap',
      extra: {
        runtime: 'docker',
        presets: ['email', 'ldap'],
        preset_params: { ldap: { users: '7' } },
      },
    });
    expect([req.preset, req.params]).toEqual(['email+ldap', { 'ldap.users': '7' }]);
    expect(said).toContain("'keep-combo' is a email+ldap workspace — keeping those presets");
  });

  it('rebuilds a one-preset workspace vanilla, as it always has', async () => {
    const { req } = await axesFor('keep-one', { preset: 'ldap', extra: { runtime: 'docker' } });
    expect(req.preset).toBe('default');
  });

  it('brings a Kubernetes monolith back as a monolith, on its own cluster', async () => {
    // An empty --deployment resolved to Kubernetes' default, so `up --name X` after `down`
    // rebuilt a monolith as microservices, seen live on a k3s lane.
    const { req } = await axesFor('keep-shape', {
      preset: 'email',
      extra: { runtime: 'kubernetes', deployment: 'monolith', context: 'lab-cluster' },
    });
    expect([req.runtime, req.deployment, req.context]).toEqual([
      'kubernetes',
      'monolith',
      'lab-cluster',
    ]);
  });

  it('keeps a MongoDB the operator runs, rather than applying its own over it', async () => {
    // `up --name X` after `down` on an --mongo-operator workspace applied houston's own
    // MongoDB over the operator's and failed ("kubectl apply failed"), seen live on k3s.
    const { req } = await axesFor('keep-operator', {
      preset: 'default',
      extra: { runtime: 'kubernetes', deployment: 'monolith', mongo_managed_by: 'operator' },
    });
    expect(req.mongoOperator).toBe(true);
  });

  it('keeps the instance count with the shape, as the GUI’s Start does', async () => {
    // The count is read from the record with the deployment; without it a three-instance
    // workspace came back with the shape's default.
    const { req } = await axesFor('keep-count', {
      preset: 'multi-instance',
      extra: { runtime: 'docker', deployment: 'multi-instance', instances: 3 },
    });
    expect([req.deployment, req.replicas]).toEqual(['multi-instance', 3]);
  });

  it('carries nothing onto a runtime the workspace was not recorded on', async () => {
    // A microservices shape and a cluster mean nothing to Compose: carried, they turned
    // `--runtime docker` into a refusal naming a --deployment nobody typed.
    const { req } = await axesFor(
      'other-runtime',
      {
        preset: 'email',
        extra: { runtime: 'kubernetes', deployment: 'microservices', context: 'c1' },
      },
      'docker',
    );
    expect([req.deployment, req.context]).toEqual(['monolith', '']);
  });

  it('says it goes to the recorded cluster, not the box default, when it brings one back', async () => {
    // The destination was announced before the recorded cluster was carried, so a box whose
    // saved default is an EKS cluster warned of an hourly bill for a kind workspace.
    config.updateConfig((cfg) => {
      cfg[config.KUBE_CONTEXT_KEY] = 'arn:aws:eks:us-east-1:123456789012:cluster/demo';
    });
    try {
      await writeRecord(
        'back',
        metadata({
          name: 'back',
          project: 'houston-back',
          extra: { runtime: 'kubernetes', deployment: 'monolith', context: 'kind-houston-local' },
        }),
      );
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const said: string[] = [];
      await createDocker
        .createRepro(
          createReq({ version: '8.5.1', name: 'back', runtime: 'kubernetes', offline: true }),
          (event) => said.push(event.message),
        )
        .catch(() => undefined);
      expect(said.join('\n')).not.toContain('costs money by the hour');
    } finally {
      config.updateConfig((cfg) => {
        delete cfg[config.KUBE_CONTEXT_KEY];
      });
    }
  });
});

describe('a rebuild across MongoDB image families', () => {
  afterEach(() => {
    for (const id of [
      '../../../src/core/runner/engine',
      '../../../src/core/lifecycle/ports',
      '../../../src/core/lifecycle/preconditions',
      '../../../src/core/lifecycle/tlsplan',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  /** `fam` at RC 7.6.1 on Bitnami MongoDB 7.0, and what `up` would tear down or start. */
  async function existing(): Promise<{ torn: unknown[]; createDocker: typeof CreateDockerNS }> {
    await writeRecord(
      'fam',
      metadata({
        name: 'fam',
        project: 'houston-fam',
        rcVersion: '7.6.1',
        mongoTag: '7.0',
        mongoFlavor: 'bitnami-legacy',
        extra: { runtime: 'docker' },
      }),
    );
    fs.writeFileSync(
      path.join(config.home(), 'repros', 'fam', 'docker-compose.yml'),
      'services: {}\n',
    );
    const torn: unknown[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/engine'),
      down: async (...args: unknown[]) => {
        torn.push(args);
        return 0;
      },
      up: async () => 0,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      checkSidecarPorts: async () => undefined,
      pickHostPort: async () => 3300,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    return {
      torn,
      createDocker: require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS,
    };
  }

  it('refuses up --force onto the other family before anything is torn down', async () => {
    // Bitnami keeps its data in /bitnami/mongodb and the official image in /data/db, on the
    // same `mongodb_data` volume: the rebuild booted Rocket.Chat 8 on an empty database.
    const { torn, createDocker } = await existing();
    const refused = createDocker.createRepro(
      createReq({ version: '8.5.1', name: 'fam', force: true, offline: true }),
    );
    await expect(refused).rejects.toThrow(/empty database/u);
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'fam', force: true, offline: true }),
      ),
    ).rejects.toThrow(/houston backup --name fam/u);
    expect(torn).toEqual([]);
  });

  it('lets --fresh and a same-family rebuild through', async () => {
    const { createDocker } = await existing();
    const plan = (version: string, fresh: boolean) => {
      const made = createPlan({
        req: createReq({ version, name: 'fam', force: true, fresh, offline: true }),
        emit: nullEmit,
      });
      made.reproName = 'fam';
      made.resolved = (require('../../../src/lib/versions') as typeof VersionsNS).resolve(version, {
        offline: true,
      });
      return made;
    };
    await expect(
      createDocker.refuseMongoFamilyChange(plan('8.5.1', true)),
    ).resolves.toBeUndefined();
    await expect(
      createDocker.refuseMongoFamilyChange(plan('7.6.2', false)),
    ).resolves.toBeUndefined();
  });
});

describe('an Enterprise licence', () => {
  const LICENSE = 'RCV3_c2VjcmV0LWxpY2VuY2UtdGV4dA==';

  function planFor(name: string, license: string) {
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const made = createPlan({
      req: createReq({ version: '8.5.1', name, license }),
      emit: nullEmit,
    });
    made.reproName = name;
    made.resolved = versions.resolve('8.5.1', { offline: true });
    made.pre = presets.load('default', {});
    made.hostPort = 3320;
    made.root = 'http://localhost:3320';
    made.bindHost = '127.0.0.1';
    return made;
  }

  it('reaches Rocket.Chat through its own 0600 file, and nowhere a reader looks', async () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = planFor('lic', LICENSE);
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    const doc = plan.doc as NonNullable<typeof plan.doc>;
    expect(doc.services.rocketchat?.env_file).toEqual(['.license.env']);
    expect(JSON.stringify(doc)).not.toContain(LICENSE);
    expect(JSON.stringify(plan.meta)).not.toContain(LICENSE);
    expect(plan.meta?.extra.licensed).toBe(true);
    await createDocker.writeTheWorkspace(plan);
    const file = path.join(config.home(), 'repros', 'lic', '.license.env');
    expect(fs.readFileSync(file, 'utf8')).toBe(`ROCKETCHAT_LICENSE=${LICENSE}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = await record.readMeta('lic');
    expect(meta.extra.incomplete).toBeUndefined();
    expect((await evidenceRecord('lic')).license).toMatchObject({ supplied: true });
    // A later ordinary metadata/Compose edit must not relax the licence file's mode.
    await record.write(
      'lic',
      fs.readFileSync(path.join(path.dirname(file), 'docker-compose.yml'), 'utf8'),
      meta,
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps a failed licence write provisional until the matching replacement succeeds', async () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const plan = planFor('license-failed', LICENSE);
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    const ws = path.join(config.reprosDir(), plan.reproName);
    const file = path.join(ws, '.license.env');
    fs.mkdirSync(file, { recursive: true });
    await expect(createDocker.writeTheWorkspace(plan)).rejects.toThrow();
    let meta = await record.readMeta(plan.reproName);
    expect(meta.extra.incomplete).toBe(true);
    expect(meta.extra.incomplete_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect((await evidenceRecord(plan.reproName)).license).toMatchObject({ supplied: null });
    expect(fs.readdirSync(ws).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    const compose = fs.readFileSync(path.join(ws, 'docker-compose.yml'), 'utf8');
    // Writing only the surviving Compose file does not complete the missing licence.
    await record.write(plan.reproName, compose, meta, plan.files);
    meta = await record.readMeta(plan.reproName);
    expect(meta.extra.incomplete).toBe(true);
    fs.rmdirSync(file);
    plan.meta = meta;
    await createDocker.writeTheWorkspace(plan);
    expect((await record.readMeta(plan.reproName)).extra.incomplete).toBeUndefined();
    expect((await evidenceRecord(plan.reproName)).license).toMatchObject({ supplied: true });
    expect(fs.readFileSync(file, 'utf8')).toBe(`ROCKETCHAT_LICENSE=${LICENSE}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps a readable provisional record when killed during the licence write', async () => {
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const name = 'license-killed';
    const ws = path.join(config.reprosDir(), name);
    fs.mkdirSync(ws, { recursive: true });
    const proc = spawn(
      process.execPath,
      [
        path.resolve(__dirname, '../../../tools/license-write-child.js'),
        name,
        String(24 * 1024 * 1024),
      ],
      {
        env: { ...process.env, HOUSTON_HOME: config.home() },
        stdio: 'pipe',
      },
    );
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        proc.once('error', reject);
        proc.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    const temp = new RegExp(`^\\.license\\.env\\.${String(proc.pid)}\\.[0-9a-f]{8}\\.tmp$`, 'u');
    let observed = '';
    let observedMode = -1;
    const observe = (): void => {
      if (observed !== '') return;
      const file = fs.readdirSync(ws).find((entry) => entry === '.license.env' || temp.test(entry));
      if (file === undefined) return;
      try {
        observedMode = fs.statSync(path.join(ws, file)).mode & 0o777;
      } catch {
        return;
      }
      observed = file;
      proc.kill('SIGKILL');
    };
    const watcher = fs.watch(ws, observe);
    const poll = setInterval(observe, 1);
    const deadline = setTimeout(() => proc.kill('SIGKILL'), 20_000);
    try {
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
      expect(observed).not.toBe('');
      expect(observedMode).toBe(0o600);
      expect(fs.statSync(ws).mode & 0o777).toBe(0o700);
      expect((await record.readMeta(name)).extra.incomplete).toBe(true);
      expect((await evidenceRecord(name)).license).toMatchObject({ supplied: null });
      expect(fs.existsSync(path.join(ws, '.license.env'))).toBe(false);
      for (const entry of fs.readdirSync(ws)) {
        if (['repro.json', 'docker-compose.yml'].includes(entry)) continue;
        expect(entry).toMatch(temp);
        const stat = fs.lstatSync(path.join(ws, entry));
        expect(stat.isFile()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(poll);
      watcher.close();
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
        await exited;
      }
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('is kept by a rebuild that does not name it again', async () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    fs.mkdirSync(path.join(config.home(), 'repros', 'kept'), { recursive: true });
    fs.writeFileSync(path.join(config.home(), 'repros', 'kept', '.license.env'), 'x', {
      mode: 0o600,
    });
    const plan = planFor('kept', '');
    await createDocker.buildDocument(plan);
    expect(plan.doc?.services.rocketchat?.env_file).toEqual(['.license.env']);
    const bare = planFor('bare', '');
    await createDocker.buildDocument(bare);
    expect('env_file' in (bare.doc?.services.rocketchat ?? {})).toBe(false);
  });

  it('refuses text that is not a licence, without repeating it', async () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const bad = 'line-one\nEVIL=1';
    const refused = createDocker.createRepro(
      createReq({ version: '8.5.1', name: 'badlic', license: bad, offline: true }),
    );
    await expect(refused).rejects.toThrow('does not hold a Rocket.Chat licence');
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'badlic', license: bad, offline: true }),
      ),
    ).rejects.not.toThrow(/EVIL/u);
  });
});

describe('a name the HTTPS edge could not reach', () => {
  // The TLS the create DECIDED, as `resolveTls` leaves it: `--https`, `--email` alone and
  // a record of an HTTPS workspace all come out as a spec, and none of them as a flag here.
  const planOf = (name: string, preset: string, https = true, actor = '') => {
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name, preset, actor }),
      emit: nullEmit,
    });
    plan.reproName = name;
    plan.pre = presets.load(preset, {});
    plan.tlsspec = https ? tlsSpec({ host: `${name}.houston.localhost` }) : null;
    return plan;
  };

  it('is refused before anything is made, naming the container and the room left', async () => {
    // `houston-<name>-phpldapadmin-1` must be a 63-character DNS label: at 41 characters it
    // is 64, does not resolve, and /phpldapadmin/ answered Bad Gateway.
    const createDocker = jest.requireActual<typeof CreateDockerNS>(
      '../../../src/core/lifecycle/create-docker',
    );
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(41), 'ldap')),
    ).rejects.toThrow(
      /reaches phpldapadmin as houston-a{41}-phpldapadmin-1, 64 characters.*at most 40/u,
    );
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(40), 'ldap')),
    ).resolves.toBeUndefined();
    // Rocket.Chat itself is the limit without a preset UI, and plain http routes nothing.
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(43), 'default')),
    ).rejects.toThrow(/rocketchat/u);
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(60), 'ldap', false)),
    ).resolves.toBeUndefined();
  });

  it('is refused however the create came to HTTPS: --email alone, or the record', async () => {
    // Keyed on the TLS `resolveTls` decided, not on --https/--domain: `--email` alone means
    // a local certificate, and an existing HTTPS workspace gets its TLS back from its record.
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      checkSidecarPorts: async () => undefined,
      checkMonitorPorts: async () => undefined,
      pickHostPort: async () => 3300,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => tlsSpec({ host: `${'a'.repeat(41)}.houston.localhost` }),
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createPlan({
      req: createReq({
        version: '8.5.1',
        name: 'a'.repeat(41),
        preset: 'ldap',
        acmeEmail: 'a@b.c',
      }),
      emit: nullEmit,
    });
    plan.cfg = config.loadConfig();
    plan.reproName = 'a'.repeat(41);
    plan.pre = presets.load('ldap', {});
    await expect(createDocker.claimPorts(plan)).rejects.toThrow(/phpldapadmin-1, 64 characters/u);
    jest.resetModules();
  });

  it('says how long a name the person may type when houston adds their prefix', async () => {
    const createDocker = jest.requireActual<typeof CreateDockerNS>(
      '../../../src/core/lifecycle/create-docker',
    );
    // alice typed 36 characters; the workspace is `alice-<36>`, 42, one container 65.
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(
        planOf(`alice-${'a'.repeat(36)}`, 'ldap', true, 'alice'),
      ),
    ).rejects.toThrow(/at most 34 characters, as houston puts 'alice-' in front of it/u);
  });
});

describe('a combination given a bad input', () => {
  it('is a usage error, as the same input to one preset is', () => {
    // A member's own refusal escaped as "unhandled": exit 1 and a stack trace for a typo,
    // where the single preset says exit 2, VALIDATION_FAILED. Nothing is created either way.
    const { loadPreset } =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const { ValidationError } = require('../../../src/lib/errors') as {
      ValidationError: new (...args: unknown[]) => Error;
    };
    const refused = (preset: string, params: Record<string, unknown>): unknown => {
      try {
        loadPreset(
          createPlan({ req: createReq({ version: '8.5.1', preset, params }), emit: nullEmit }),
        );
      } catch (error) {
        return error instanceof ValidationError ? 'usage' : String(error);
      }
      return 'accepted';
    };
    expect([
      refused('email+ldap', { 'ldap.users': 'abc' }),
      refused('email+ldap', { 'ldap.tls': 'bogus' }),
      refused('email+ldap', { 'ldap.mfa': 'on' }),
      refused('ldap+nosuch', {}),
    ]).toEqual(['usage', 'usage', 'usage', 'usage']);
  });
});

describe('up --pin on a workspace that exists', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/runner/queries');
    jest.dontMock('../../../src/core/lifecycle/ready');
    jest.dontMock('../../../src/core/lifecycle/inspect');
    jest.resetModules();
  });

  it('pins it, so the next prune keeps it, and makes it the default', async () => {
    // It was not even among the flags said to be ignored: `pinned: false`, no warning, and
    // `prune --yes` then deleted the one workspace its owner had just asked to keep.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'running',
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      restoreRoute: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      summary: async () => ({}),
    }));
    const record = require('../../../src/core/runner/record') as {
      writeRecord: typeof writeRecord;
      metadata: typeof metadata;
      readMeta: (name: string) => Promise<Metadata>;
    };
    await record.writeRecord('kept', record.metadata({ name: 'kept', project: 'houston-kept' }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await createDocker.reuse(
      'kept',
      false,
      createReq({ version: '8.5.1', name: 'kept', pin: true }),
      nullEmit,
    );
    expect((await record.readMeta('kept')).pinned).toBe(true);
    const cfg = require('../../../src/lib/config') as typeof config;
    expect(cfg.loadConfig().default_repro).toBe('kept');
  });
});

describe('up of a workspace an env credential change was deferred on', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/runner/queries');
    jest.dontMock('../../../src/core/runner/engine');
    jest.dontMock('../../../src/core/lifecycle/ready');
    jest.dontMock('../../../src/core/lifecycle/inspect');
    jest.resetModules();
  });

  it('deploys it when it starts the stopped workspace, recreating every replica', async () => {
    // `up` of a stopped workspace only starts its containers, which keep the environment
    // they were created with. A running one is left as it is, and so is the deferred change.
    const cases: Array<[string, string, boolean, number]> = [
      ['stopped, recreated', 'exited', true, 0],
      ['stopped, the recreate fails', 'exited', true, 1],
      ['running', 'running', true, 0],
      ['stopped, nothing deferred', 'exited', false, 0],
    ];
    const observed: unknown[] = [];
    for (const [label, rc, pending, exitCode] of cases) {
      jest.resetModules();
      const forced: unknown[] = [];
      jest.doMock('../../../src/core/runner/queries', () => ({
        ...jest.requireActual('../../../src/core/runner/queries'),
        rcState: async () => rc,
      }));
      jest.doMock('../../../src/core/runner/engine', () => ({
        ...jest.requireActual('../../../src/core/runner/engine'),
        up: async (_name: string, options: { forceRecreate?: unknown } = {}) => {
          forced.push(options.forceRecreate);
          return exitCode;
        },
      }));
      jest.doMock('../../../src/core/lifecycle/ready', () => ({
        ...jest.requireActual('../../../src/core/lifecycle/ready'),
        upCompose: async () => 0,
        restoreRoute: async () => undefined,
      }));
      jest.doMock('../../../src/core/lifecycle/inspect', () => ({
        ...jest.requireActual('../../../src/core/lifecycle/inspect'),
        summary: async () => ({}),
      }));
      const record = require('../../../src/core/runner/record') as typeof RecordNS;
      const name = `deferred-${String(observed.length)}`;
      await record.write(
        name,
        YAML.stringify({
          services: {
            'rocketchat-1': { environment: { REG_TOKEN: 'token' } },
            'rocketchat-2': { environment: { REG_TOKEN: 'token' } },
            mongodb: { image: 'mongo:8.0' },
          },
        }),
        record.metadata({
          name,
          project: `houston-${name}`,
          extra: pending ? { credentials_pending: true } : {},
        }),
      );
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const outcome = await createDocker
        .reuse(name, false, createReq({ version: '', name }), nullEmit)
        .then(
          () => 'reused',
          (error: Error) => error.message,
        );
      observed.push([
        label,
        outcome,
        forced,
        (await record.readMeta(name)).extra.credentials_pending === true,
      ]);
    }
    const both = ['rocketchat-1', 'rocketchat-2'];
    expect(observed).toEqual([
      ['stopped, recreated', 'reused', [both], false],
      [
        'stopped, the recreate fails',
        '`docker compose up` failed applying the changed environment',
        [both],
        true,
      ],
      ['running', 'reused', [], true],
      ['stopped, nothing deferred', 'reused', [], false],
    ]);
  });
});

describe('a hosts line on Podman', () => {
  afterEach(() => {
    // The guard put back, never taken away: `runner/host` is the suite's stated engine.
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.resetModules();
  });

  it('is warned about where the notes ask for one, and only on Podman', async () => {
    // Podman copies /etc/hosts into every container, so `127.0.0.1 minio` made minio-init and
    // Rocket.Chat resolve minio to themselves: no bucket, every upload ECONNREFUSED.
    for (const [kind, expected] of [
      ['podman', true],
      ['docker', false],
    ] as const) {
      jest.resetModules();
      jest.doMock('../../../src/core/runner/host', () => ({
        ...jest.requireActual('../../../src/core/runner/host'),
        engine: async () => ({ kind, version: '4.9.3', rootless: true }),
      }));
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const said: string[] = [];
      const plan = createDocker.createPlan({
        req: createReq({ version: '8.5.1', preset: 's3_minio' }),
        emit: (event) => said.push(event.message),
      });
      plan.pre = presets.load('s3_minio', { presigned: 'true' });
      await createDocker.warnAboutHostsOnPodman(plan);
      expect({ kind, warned: said.some((line) => line.includes('Podman copies')) }).toEqual({
        kind,
        warned: expected,
      });
    }
  });
});

describe('a seed profile that does not exist', () => {
  it('is refused before anything is resolved or made', async () => {
    // The planner refused `--seed-profile huge` only after the workspace was pulled, built
    // and started: exit 1 over a running workspace, for a typo.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const { ValidationError } = require('../../../src/lib/errors') as {
      ValidationError: new (...args: unknown[]) => Error;
    };
    const refusal = createDocker.createRepro(
      createReq({ version: '8.5.1', seed: true, seedProfile: 'huge', offline: true }),
    );
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', seed: true, seedProfile: 'huge', offline: true }),
      ),
    ).rejects.toThrow("unknown seed profile 'huge' (want small | standard | large)");
  });
});

describe('Kubernetes-only flags on Docker', () => {
  it('are said to be ignored, rather than silently dropped', async () => {
    // `up --mongo-operator` or `--ingress-class nginx` on Docker built a full workspace
    // with no word that either was ignored.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const warned: string[] = [];
    await createDocker
      .createRepro(
        createReq({
          version: '8.5.1',
          offline: true,
          runtime: 'docker',
          mongoOperator: true,
          ingressClass: 'nginx',
        }),
        (event) => {
          if (event.level === 'warn') warned.push(event.message);
        },
      )
      .catch(() => undefined);
    expect(warned).toContain(
      '--mongo-operator and --ingress-class: Kubernetes only, ignored on Docker',
    );
  });
});

describe('a qualified --set on a single preset', () => {
  it.each(['docker', 'kubernetes'])(
    "is that preset's parameter on %s, and its value is checked as one",
    async (runtime) => {
      // `-p ldap --set ldap.users=abc` was refused as an unknown param on both runtimes,
      // while `-p ldap -p email` took the same key and checked its value.
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const refused = createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'kbad',
          preset: 'ldap',
          params: { 'ldap.users': 'abc' },
          runtime,
          offline: true,
        }),
      );
      await expect(refused).rejects.toThrow("--set users='abc' expects a whole number");
      await expect(refused).rejects.toHaveProperty('exitCode', 2);
    },
  );
});

describe("a combination's IdP on a non-loopback bind", () => {
  it('is warned about as the single preset is', () => {
    // Looked up by the combined name (`email+saml`), the warning never fired for a set:
    // the SAML button bounced off the visitor's own machine with nothing said.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', preset: 'email+saml', bind: '0.0.0.0' }),
      emit: (event) => said.push(event.message),
    });
    plan.bindHost = '0.0.0.0';
    plan.hostPort = 3611;
    createDocker.warnAboutTheBrowserHost(plan);
    expect(said.join(' ')).toContain("this 'saml' workspace is bound to 0.0.0.0");
    expect(said.join(' ')).toContain('--set saml.idp_host=<host>');
  });

  it('is said for a URL given over plain http, and not for an HTTPS name or proxied MinIO', () => {
    // A `--domain` workspace with oidc and s3_minio was told OIDC "opens a blank window" and
    // previews fail, and to re-create on 0.0.0.0: over HTTPS the browser signs in through
    // <name>/keycloak/ and Rocket.Chat proxies the downloads, and both worked.
    const warned = (https: boolean): string => {
      const said: string[] = [];
      const plan = createPlan({
        req: createReq({
          version: '8.5.1',
          preset: 'oidc+s3_minio',
          ...(https ? { domain: 'd1.example.com' } : { rootUrl: 'http://d1.example.com:3301' }),
        }),
        emit: (event) => said.push(event.message),
      });
      plan.pre = presets.loadMany(['oidc', 's3_minio'], {}, 'docker');
      plan.bindHost = '127.0.0.1';
      plan.hostPort = 3301;
      if (https) {
        plan.tlsspec = tlsSpec({ mode: MODE_ACME, host: 'd1.example.com', acmeEmail: 'o@e.com' });
      }
      createDocker.warnAboutTheBrowserHost(plan);
      return said.join(' ');
    };
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    expect(warned(true)).not.toContain('names that browser');
    // The case it was written for: an http URL with the ports on loopback.
    expect(warned(false)).toContain("this 'oidc' workspace advertises http://d1.example.com:3301");
    // MinIO in its default proxy mode is never the browser's to reach.
    expect(warned(false)).not.toContain("'s3_minio'");
  });
});

describe('presigned uploads on an HTTPS workspace', () => {
  it('are warned about when the workspace is created, not only in its notes', async () => {
    // The browser fetches presigned URLs from MinIO over http, which an https page blocks as
    // mixed content. The notes said so; the create-time warning had no test of its own, so
    // dropping the emit left every test green.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name: 'p3', preset: 's3_minio' }),
      emit: (event) => said.push(event.message),
    });
    plan.reproName = 'p3';
    plan.resolved = versions.resolve('8.5.1', { offline: true });
    plan.pre = presets.load('s3_minio', { presigned: 'true' });
    plan.hostPort = 3000;
    plan.root = 'http://localhost:3000';
    plan.bindHost = '127.0.0.1';
    plan.tlsspec = tlsSpec({ mode: MODE_ACME, host: 'p3.example.com', acmeEmail: 'o@e.com' });
    await createDocker.buildDocument(plan);
    expect(said.some((line) => line.includes('mixed content'))).toBe(true);
  });
});

describe('the name a create settles on', () => {
  it('is announced by both runtimes, for the GUI to title its progress by', async () => {
    // Only `announceName` itself was tested; the jobs and repros tests inject the event by
    // mock, so a create that stopped calling it left every test green.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const createK8s = require('../../../src/core/lifecycle/create-k8s') as typeof CreateK8sNS;
    const { missingMonitorAttach } = require('../../../src/core/lifecycle/request') as {
      missingMonitorAttach: never;
    };
    const codes: string[] = [];
    const emit = (event: { code?: string; data?: unknown }): void => {
      if (event.code === 'workspace-name') codes.push(JSON.stringify(event.data));
    };
    const plan = createPlan({ req: createReq({ version: '8.5.1', preset: 'email' }), emit });
    plan.reproName = 'rc8-5-1-email';
    await createDocker.settleName(plan).catch(() => undefined);
    const job = createK8s.kubeCreate({
      req: createReq({ version: '8.5.1', preset: 'email', runtime: 'kubernetes' }),
      emit,
      monitorAttach: missingMonitorAttach,
    });
    await createK8s.settleName(job).catch(() => undefined);
    expect(codes).toHaveLength(2);
  });
});
