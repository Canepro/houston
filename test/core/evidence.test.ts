import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import type * as PathsNS from '../../src/core/runner/paths';
import type * as PayloadNS from '../../src/core/lifecycle/payload';
import type * as KubeNamespaceNS from '../../src/core/kube/namespace';
import type * as AdminNS from '../../src/core/lifecycle/admin';
import type * as DockerCliNS from '../../src/seams/docker-cli';
import type * as EngineNS from '../../src/core/runner/engine';

jest.mock('../../src/core/runner/paths', () => {
  const actual = jest.requireActual<typeof PathsNS>('../../src/core/runner/paths');
  return { ...actual, atomicWrite: jest.fn(actual.atomicWrite) };
});

jest.mock('../../src/core/lifecycle/payload', () => {
  const actual = jest.requireActual<typeof PayloadNS>('../../src/core/lifecycle/payload');
  return { ...actual, detail: jest.fn(actual.detail) };
});

jest.mock('../../src/core/kube/namespace', () => {
  const actual = jest.requireActual<typeof KubeNamespaceNS>('../../src/core/kube/namespace');
  return { ...actual, namespaceLabels: jest.fn() };
});

// `env` asks a serving workspace which keys are settings; these workspaces never serve.
jest.mock('../../src/core/lifecycle/admin', () => {
  const actual = jest.requireActual<typeof AdminNS>('../../src/core/lifecycle/admin');
  return {
    ...actual,
    login: jest.fn(async () => {
      throw new Error('not serving');
    }),
  };
});

// The Compose process, for a test that drives the real `engine.up` to see what it is asked for.
jest.mock('../../src/seams/docker-cli', () => {
  const actual = jest.requireActual<typeof DockerCliNS>('../../src/seams/docker-cli');
  return { ...actual, compose: jest.fn(actual.compose) };
});

// `env` recreates Rocket.Chat and waits for it; no engine runs here.
jest.mock('../../src/core/runner/engine', () => ({
  ...jest.requireActual<object>('../../src/core/runner/engine'),
  up: jest.fn(async () => 0),
}));
jest.mock('../../src/core/lifecycle/ready', () => ({
  ...jest.requireActual<object>('../../src/core/lifecycle/ready'),
  waitServing: jest.fn(async () => undefined),
}));

import { setEnvLocked } from '../../src/core/envvars';
import * as engine from '../../src/core/runner/engine';
import * as lifecyclePayload from '../../src/core/lifecycle/payload';
import * as kubeNamespace from '../../src/core/kube/namespace';
import * as config from '../../src/lib/config';
import { ValidationError } from '../../src/lib/errors';
import * as dockerCli from '../../src/seams/docker-cli';
import { Interrupted } from '../../src/seams/exec';
import {
  cleanupCommand,
  collect,
  record,
  renderMarkdown,
  resolveRetention,
  safeOrigin,
  writeBundle,
} from '../../src/core/evidence';
import { atomicWrite, workspace } from '../../src/core/runner/paths';
import { metadata, readMeta, updateMeta, write } from '../../src/core/runner/record';

const namespaceLabels = kubeNamespace.namespaceLabels as jest.MockedFunction<
  typeof kubeNamespace.namespaceLabels
>;

beforeEach(() => {
  namespaceLabels.mockReset();
  namespaceLabels.mockImplementation(async (namespace) => ({
    'app.kubernetes.io/managed-by': 'houston',
    'houston.io/workspace': namespace.replace(/^houston-/u, ''),
  }));
});

const COMPOSE = [
  'services:',
  '  rocketchat:',
  '    image: rocketchat/rocket.chat:8.5.1',
  '    environment:',
  '      ADMIN_PASS: S3cretPass',
  '      REG_TOKEN: SUPERSECRETTOKEN',
  '      MONGO_URL: mongodb://rocket:MongoUrlSecret@mongodb:27017/rocketchat',
  '    command:',
  '      - /bin/sh',
  '      - -c',
  '      - echo S3cretPass',
  '    labels:',
  '      com.example.evidence-note: S3cretPass',
  '    S3cretPass: a-secret-used-as-a-key',
  '    ports:',
  "      - '127.0.0.1:3000:3000'",
  '  mongodb:',
  '    image: mongo:7.0',
  '',
].join('\n');

const KUBERNETES_DETAIL = {
  deployment: 'monolith',
  context: 'test-context',
  cluster: 'test-cluster',
  namespace: 'test-namespace',
  bind_host: '',
  state: 'down',
  containers: [],
};

async function recordKubernetes(
  name: string,
  result = KUBERNETES_DETAIL,
): Promise<Record<string, unknown>> {
  const detail = lifecyclePayload.detail as jest.MockedFunction<typeof lifecyclePayload.detail>;
  detail.mockResolvedValueOnce(result);
  return await record(name);
}

async function workspaceNamed(
  name: string,
  extra: Record<string, unknown> = {},
  fields: Partial<ReturnType<typeof metadata>> = {},
  compose = COMPOSE,
): Promise<void> {
  await write(
    name,
    compose,
    metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      rcImage: 'rocketchat/rocket.chat',
      mongoTag: '7.0',
      mongoFlavor: 'mongo',
      preset: '',
      // Userinfo, a path and a query: everything the origin must drop.
      rootUrl: 'http://admin:pw@localhost:3000/channel/x?t=1',
      hostPort: 3000,
      versionSource: 'live',
      createdAt: '2026-10-15T10:00:00Z',
      adminPassword: 'S3cretPass',
      extra,
      ...fields,
    }),
  );
}

describe('the origin an attachable record keeps', () => {
  it('drops userinfo, the path and the query', () => {
    expect(safeOrigin('http://admin:pw@localhost:3000/channel/x?t=1')).toBe(
      'http://localhost:3000',
    );
    expect(safeOrigin('https://[::1]:8443/p')).toBe('https://[::1]:8443');
    expect(safeOrigin('https://rc.example.com/')).toBe('https://rc.example.com');
  });

  it('redacts anything that is not an http(s) URL with a host, rather than guessing', () => {
    for (const bad of [
      'ftp://x',
      '',
      'not a url',
      'file:///etc/passwd',
      'http://localhost:not-a-port',
      'http://localhost:99999',
    ]) {
      expect(safeOrigin(bad)).toBe('REDACTED');
    }
  });
});

describe('the record', () => {
  it('is one shape on every runtime, with the URL reduced to its origin', async () => {
    await workspaceNamed('e1');
    const rec = await record('e1');
    expect(Object.keys(rec).sort()).toEqual([
      'artifact',
      'generated_at',
      'license',
      'ownership',
      'repro',
      'retention',
      'runtime',
    ]);
    const repro = rec.repro as Record<string, unknown>;
    expect(Object.keys(repro).sort()).toEqual([
      'bind_host',
      'created_at',
      'deployment',
      'host_port',
      'mongo_flavor',
      'mongo_tag',
      'name',
      'preset',
      'public_url',
      'rc_image',
      'rc_version',
      'root_url',
      'runtime',
      'version_source',
    ]);
    expect(repro.root_url).toBe('http://localhost:3000');
    expect(repro.rc_image).toBe('rocketchat/rocket.chat:8.5.1');
    expect(repro.runtime).toBe('docker');
    expect(Object.keys(rec.runtime as object).sort()).toEqual(['engine', 'services', 'state']);
    // The rendered artifact is hashed, whichever one the runtime produced.
    expect(rec.artifact).toEqual({
      name: 'docker-compose.yml',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    // Ownership is stated so a teardown decision is auditable.
    expect(rec.ownership).toEqual({
      proof: 'record',
      managed_by: 'houston',
      project: 'houston-e1',
    });
    expect((rec.retention as Record<string, unknown>).created_at).toBe(repro.created_at);
  });

  it('keeps a Docker record attachable when a killed create wrote only metadata', async () => {
    const name = 'e1-metadata-only';
    await workspaceNamed(name, { bind_host: '0.0.0.0' });
    fs.unlinkSync(path.join(workspace(name), 'docker-compose.yml'));
    const detail = lifecyclePayload.detail as jest.MockedFunction<typeof lifecyclePayload.detail>;
    detail.mockClear();

    const rec = await record(name);

    expect(rec.repro).toMatchObject({
      runtime: 'docker',
      deployment: 'monolith',
      bind_host: '0.0.0.0',
    });
    expect(rec.runtime).toEqual({
      state: '?',
      services: [],
      engine: {
        kind: 'compose',
        docker_version: expect.any(String),
        compose_version: expect.any(String),
      },
    });
    expect(rec.artifact).toEqual({ name: '', sha256: '' });
    expect(detail).not.toHaveBeenCalled();
  });

  it('withholds the old Docker artifact after a failed replacement and restores it after retry', async () => {
    const name = 'e1-interrupted-replacement';
    await workspaceNamed(name);
    const original = jest.requireActual<typeof PathsNS>('../../src/core/runner/paths').atomicWrite;
    const writer = jest.mocked(atomicWrite);
    writer.mockImplementation(async (target, content, options) => {
      if (path.basename(target) === 'docker-compose.yml')
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return await original(target, content, options);
    });
    try {
      await expect(
        workspaceNamed(name, {}, { rcVersion: '8.6.0' }, COMPOSE.replaceAll('8.5.1', '8.6.0')),
      ).rejects.toMatchObject({ code: 'ENOSPC' });
    } finally {
      writer.mockImplementation(original);
    }
    expect(fs.readFileSync(path.join(workspace(name), 'docker-compose.yml'), 'utf8')).toBe(COMPOSE);
    const rec = await record(name);
    expect(rec.artifact).toEqual({ name: '', sha256: '' });
    // The Compose file on disk may still be the previous one, so it cannot say what was supplied.
    expect(rec.license).toEqual({ required: false, supplied: null, source: 'unknown' });
    const dest = path.join(workspace(name), 'out', 'interrupted');
    const collected = await collect(name, { bundle: dest });
    expect(collected.artifact).toEqual({ name: '', sha256: '' });
    expect(collected.runtime).toMatchObject({ state: '?' });
    expect(fs.readdirSync(dest).sort()).toEqual(['README.md', 'manifest.json']);
    const readme = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
    expect(readme).toContain(
      'This bundle records workspace metadata and any available configuration.',
    );
    expect(readme).toContain('Runtime deployment was not verified.');
    expect(readme).toContain('No scripted capture was run, so user actions were not recorded.');
    expect(readme).not.toContain('proves what was deployed');

    // An edit of the file that survived is not the replacement. It writes the 8.5.1 image beside
    // the 8.6.0 record, so the record must stay unfinished and the artifact withheld.
    await setEnvLocked(name, { SOME_FLAG: '1' }, [], { restart: false });
    const edited = await record(name);
    expect((edited.repro as Record<string, unknown>).rc_version).toBe('8.6.0');
    expect(fs.readFileSync(path.join(workspace(name), 'docker-compose.yml'), 'utf8')).toContain(
      'rocketchat/rocket.chat:8.5.1',
    );
    expect(edited.artifact).toEqual({ name: '', sha256: '' });
    expect(edited.license).toEqual({ required: false, supplied: null, source: 'unknown' });

    // `env`, `monitor` and `upgrade` retry with the record they load, the provisional one. The
    // retry that writes the replacement it was interrupted in finishes the record.
    await write(name, COMPOSE.replaceAll('8.5.1', '8.6.0'), await readMeta(name));
    const complete = await record(name);
    expect(complete.artifact).toEqual({
      name: 'docker-compose.yml',
      sha256: createHash('sha256').update(COMPOSE.replaceAll('8.5.1', '8.6.0')).digest('hex'),
    });
    expect(complete.license).toEqual({ required: false, supplied: true, source: 'reg_token' });
  });

  it('does not relabel an invalid Docker artifact as absent metadata', async () => {
    const name = 'e1-invalid-artifact';
    await workspaceNamed(name);
    const artifact = path.join(workspace(name), 'docker-compose.yml');
    fs.unlinkSync(artifact);
    fs.mkdirSync(artifact);
    const detail = lifecyclePayload.detail as jest.MockedFunction<typeof lifecyclePayload.detail>;
    detail.mockResolvedValueOnce({
      deployment: 'monolith',
      bind_host: '127.0.0.1',
      state: 'down',
      containers: [],
    });

    await expect(record(name)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('never contains a password, a token, or the URL userinfo', async () => {
    await workspaceNamed('e2');
    const blob = JSON.stringify(await record('e2'));
    expect(blob).not.toContain('S3cretPass');
    expect(blob).not.toContain('SUPERSECRETTOKEN');
    expect(blob).not.toContain('MongoUrlSecret');
    expect(blob).not.toContain('admin123'); // the shared default admin password
    expect(blob).not.toContain('admin:pw');
    expect(blob).not.toContain('"login"');
  });

  it('records a licence or registration-token state without the value', async () => {
    // No marker: a record from before `reg_token_supplied` existed. The Docker compose
    // file says whether a token reached the deployment (the fixture hands one over).
    await workspaceNamed('e3');
    expect((await record('e3')).license).toEqual({
      required: false,
      supplied: true,
      source: 'reg_token',
    });
    await workspaceNamed('e3-none', { reg_token_supplied: false });
    expect((await record('e3-none')).license).toEqual({
      required: false,
      supplied: false,
      source: null,
    });
    // The record says what the create knew; a catalog edited since does not rewrite it.
    await workspaceNamed('e3-recorded', { license_required: true, reg_token_supplied: false });
    expect((await record('e3-recorded')).license).toEqual({
      required: true,
      supplied: false,
      source: null,
    });
    await workspaceNamed('e3l', { licensed: true });
    expect((await record('e3l')).license).toEqual({
      required: false,
      supplied: true,
      source: 'license',
    });
    await workspaceNamed('e3t', {
      reg_token_supplied: true,
      reg_token: 'EVIDENCE-REGISTRATION-TOKEN-SENTINEL',
    });
    const tokenEvidence = await record('e3t');
    expect(tokenEvidence.license).toEqual({
      required: false,
      supplied: true,
      source: 'reg_token',
    });
    expect(JSON.stringify(tokenEvidence)).not.toContain('EVIDENCE-REGISTRATION-TOKEN-SENTINEL');
    // A malformed marker is no marker; the compose file answers, as for no marker.
    await workspaceNamed('e3t-malformed', { reg_token_supplied: 'true' });
    expect((await record('e3t-malformed')).license).toEqual({
      required: false,
      supplied: true,
      source: 'reg_token',
    });
    await workspaceNamed('e3t-license-wins', { licensed: true, reg_token_supplied: true });
    expect((await record('e3t-license-wins')).license).toEqual({
      required: false,
      supplied: true,
      source: 'license',
    });
  });

  it('reports the licence Rocket.Chat ran with, not one a killed create had not installed', async () => {
    const examples = [
      { name: 'e3e-not-installed', extra: { licensed: true, effective_license: false } },
      {
        name: 'e3e-token-only',
        extra: { licensed: true, effective_license: false, reg_token_supplied: true },
      },
      { name: 'e3e-installed', extra: { licensed: true, effective_license: true } },
      { name: 'e3e-retained', extra: { effective_license: true, reg_token_supplied: false } },
      {
        name: 'e3e-unknown',
        extra: { licensed: true, effective_license: null, reg_token_supplied: false },
      },
      {
        name: 'e3e-known-token-unknown-license',
        extra: { licensed: true, effective_license: null, reg_token_supplied: true },
      },
    ];
    const observed: unknown[] = [];
    for (const example of examples) {
      await workspaceNamed(example.name, { reg_token_supplied: false, ...example.extra });
      observed.push([example.name, (await record(example.name)).license]);
    }
    expect(observed).toEqual([
      ['e3e-not-installed', { required: false, supplied: false, source: null }],
      ['e3e-token-only', { required: false, supplied: true, source: 'reg_token' }],
      ['e3e-installed', { required: false, supplied: true, source: 'license' }],
      ['e3e-retained', { required: false, supplied: true, source: 'license' }],
      ['e3e-unknown', { required: false, supplied: null, source: 'unknown' }],
      ['e3e-known-token-unknown-license', { required: false, supplied: true, source: 'unknown' }],
    ]);
  });

  it('follows an env change to the registration token and licence', async () => {
    // `env --set` and `--unset` rewrite the Compose environment after create stamped what it
    // supplied. Real files; the change is written without recreating a container, so the
    // record's markers describe the Compose file, and evidence does not claim a changed
    // credential reached Rocket.Chat before a recreate.
    const examples: Array<{
      name: string;
      extra: Record<string, unknown>;
      services: Record<
        string,
        { environment?: Record<string, unknown> | string[]; env_file?: string[] }
      >;
      files?: Record<string, string>;
      sets?: Record<string, string>;
      unset?: string[];
    }> = [
      {
        name: 'e3-env-blank-token',
        extra: { reg_token_supplied: true },
        services: { rocketchat: { environment: { REG_TOKEN: 'token' } } },
        sets: { REG_TOKEN: '' },
      },
      {
        name: 'e3-env-set-token',
        extra: { reg_token_supplied: false },
        services: { rocketchat: { environment: { PORT: '3000' } } },
        sets: { REG_TOKEN: 'token' },
      },
      {
        name: 'e3-env-unset-list-token',
        extra: { reg_token_supplied: true },
        services: { rocketchat: { environment: ['PORT=3000', 'REG_TOKEN=token'] } },
        unset: ['REG_TOKEN'],
      },
      {
        // The env file still hands Rocket.Chat a token once the environment key is gone.
        name: 'e3-env-unset-file-token',
        extra: { reg_token_supplied: true },
        services: { rocketchat: { environment: { REG_TOKEN: 'token' }, env_file: ['token.env'] } },
        files: { 'token.env': 'REG_TOKEN=file-token\n' },
        unset: ['REG_TOKEN'],
      },
      {
        name: 'e3-env-blank-licence',
        extra: { licensed: true, reg_token_supplied: true },
        services: {
          rocketchat: { environment: { ROCKETCHAT_LICENSE: 'licence', REG_TOKEN: 'token' } },
        },
        sets: { ROCKETCHAT_LICENSE: '' },
      },
      {
        name: 'e3-env-set-licence',
        extra: { reg_token_supplied: true },
        services: { rocketchat: { environment: { REG_TOKEN: 'token' } } },
        sets: { ROCKETCHAT_LICENSE: 'licence' },
      },
      {
        name: 'e3-env-sidecar-token',
        extra: { reg_token_supplied: false },
        services: {
          rocketchat: { environment: { PORT: '3000' } },
          'registration-helper': { environment: { REG_TOKEN: 'sidecar-only-token' } },
        },
        sets: { PORT: '3001' },
      },
    ];
    const observed: unknown[] = [];
    for (const example of examples) {
      for (const [file, text] of Object.entries(example.files ?? {})) {
        fs.mkdirSync(workspace(example.name), { recursive: true });
        fs.writeFileSync(path.join(workspace(example.name), file), text);
      }
      await workspaceNamed(
        example.name,
        example.extra,
        {},
        YAML.stringify({ services: example.services }),
      );
      await setEnvLocked(example.name, example.sets ?? {}, example.unset ?? [], {
        restart: false,
      });
      const rec = await record(example.name);
      const extra = (await readMeta(example.name)).extra;
      const markers = { licensed: extra.licensed, reg_token_supplied: extra.reg_token_supplied };
      observed.push([example.name, markers, rec.license, (rec.artifact as { name: string }).name]);
    }
    const artifact = 'docker-compose.yml';
    const pending = { required: false, supplied: null, source: 'unknown' };
    expect(observed).toEqual([
      ['e3-env-blank-token', { licensed: undefined, reg_token_supplied: false }, pending, artifact],
      ['e3-env-set-token', { licensed: undefined, reg_token_supplied: true }, pending, artifact],
      [
        'e3-env-unset-list-token',
        { licensed: undefined, reg_token_supplied: false },
        pending,
        artifact,
      ],
      // The env file still hands Rocket.Chat the token, so nothing it was given changed.
      [
        'e3-env-unset-file-token',
        { licensed: undefined, reg_token_supplied: true },
        { required: false, supplied: true, source: 'reg_token' },
        artifact,
      ],
      [
        'e3-env-blank-licence',
        { licensed: undefined, reg_token_supplied: true },
        pending,
        artifact,
      ],
      ['e3-env-set-licence', { licensed: true, reg_token_supplied: true }, pending, artifact],
      [
        'e3-env-sidecar-token',
        { licensed: undefined, reg_token_supplied: false },
        { required: false, supplied: false, source: null },
        artifact,
      ],
    ]);
  });

  it('reports a changed credential once Rocket.Chat is recreated with it, and not before', async () => {
    const up = jest.mocked(engine.up);
    const services = (environment: Record<string, string>) =>
      YAML.stringify({ services: { rocketchat: { environment } } });
    const unknown = { required: false, supplied: null, source: 'unknown' };
    const token = { required: false, supplied: true, source: 'reg_token' };
    const none = { required: false, supplied: false, source: null };

    // A recreate that succeeds deploys the change.
    await workspaceNamed('e3-env-restarted', { reg_token_supplied: false }, {}, services({}));
    await setEnvLocked('e3-env-restarted', { REG_TOKEN: 'token' }, []);
    expect((await record('e3-env-restarted')).license).toEqual(token);

    // A recreate that fails leaves the running container as it was, and the next one that
    // succeeds, for any change, deploys the Compose file with it.
    await workspaceNamed(
      'e3-env-failed',
      { reg_token_supplied: true },
      {},
      services({ REG_TOKEN: 'token' }),
    );
    up.mockResolvedValueOnce(1);
    await expect(setEnvLocked('e3-env-failed', {}, ['REG_TOKEN'])).rejects.toThrow(
      'failed applying the env change',
    );
    expect((await record('e3-env-failed')).license).toEqual(unknown);
    await setEnvLocked('e3-env-failed', { PORT: '3001' }, [], { restart: false });
    expect((await record('e3-env-failed')).license).toEqual(unknown);
    await setEnvLocked('e3-env-failed', { PORT: '3002' }, []);
    expect((await record('e3-env-failed')).license).toEqual(none);

    // A record from before the markers is asked through its Compose file, which describes the
    // change before Rocket.Chat has it.
    await workspaceNamed('e3-env-legacy', {}, {}, services({ PORT: '3000' }));
    await setEnvLocked('e3-env-legacy', { REG_TOKEN: 'token' }, [], { restart: false });
    expect((await record('e3-env-legacy')).license).toEqual(unknown);
    await setEnvLocked('e3-env-legacy', { PORT: '3001' }, []);
    expect((await record('e3-env-legacy')).license).toEqual(token);

    // Every replica of a multi-instance workspace has the change only once each one is
    // recreated. The real engine is asked for all of them in one Compose call, MongoDB left
    // out, and only that call's success deploys the change.
    const seam = jest.mocked(dockerCli.compose);
    const actualUp = jest.requireActual<typeof EngineNS>('../../src/core/runner/engine').up;
    const calls: string[][] = [];
    let exitCode = 0;
    up.mockImplementation(actualUp);
    seam.mockImplementation(async (args) => {
      calls.push([...args]);
      return {
        argv: ['docker', 'compose', ...args],
        exitCode,
        signal: null,
        stdout: '',
        stderr: '',
      };
    });
    try {
      await workspaceNamed(
        'e3-env-replicas',
        { reg_token_supplied: true, instances: 2 },
        {},
        YAML.stringify({
          services: {
            'rocketchat-1': { environment: { REG_TOKEN: 'token' } },
            'rocketchat-2': { environment: { REG_TOKEN: 'token' } },
            mongodb: { image: 'mongo:7.0' },
          },
        }),
      );
      exitCode = 1;
      await expect(setEnvLocked('e3-env-replicas', {}, ['REG_TOKEN'])).rejects.toThrow(
        'failed applying the env change',
      );
      expect((await record('e3-env-replicas')).license).toEqual(unknown);
      exitCode = 0;
      await setEnvLocked('e3-env-replicas', {}, ['REG_TOKEN']);
      expect(calls.at(-1)).toEqual([
        'up',
        '-d',
        '--remove-orphans',
        '--force-recreate',
        '--no-deps',
        'rocketchat-1',
        'rocketchat-2',
      ]);
      expect((await record('e3-env-replicas')).license).toEqual(none);
    } finally {
      up.mockImplementation(async () => 0);
      seam.mockImplementation(
        jest.requireActual<typeof DockerCliNS>('../../src/seams/docker-cli').compose,
      );
    }
  });

  it('reads a legacy Compose token only from supported Rocket.Chat environments', async () => {
    const examples: Array<{
      name: string;
      extra?: Record<string, unknown>;
      services: Record<
        string,
        { environment?: Record<string, unknown> | string[]; env_file?: string[] }
      >;
      files?: Record<string, string>;
      supplied: boolean | null;
      source?: string;
    }> = [
      {
        name: 'e3-legacy-sidecar-only',
        services: {
          rocketchat: { environment: { PORT: '3000' } },
          'registration-helper': { environment: { REG_TOKEN: 'sidecar-only-token' } },
        },
        supplied: false,
      },
      {
        name: 'e3-legacy-multi-list',
        extra: { deployment: 'multi-instance', instances: 2 },
        services: {
          'rocketchat-1': { environment: ['PORT=3000', 'REG_TOKEN=  multi-list-token'] },
          'rocketchat-2': { environment: ['PORT=3000'] },
        },
        supplied: true,
      },
      {
        name: 'e3-legacy-list-blank',
        services: { rocketchat: { environment: ['REG_TOKEN=  \t'] } },
        supplied: false,
      },
      {
        name: 'e3-legacy-interpolated',
        services: { rocketchat: { environment: ['REG_TOKEN=${HOST_REG_TOKEN}'] } },
        supplied: null,
        source: 'unknown',
      },
      {
        name: 'e3-legacy-env-file',
        services: { rocketchat: { env_file: ['token.env'] } },
        files: { 'token.env': 'REG_TOKEN=file-token\n' },
        supplied: true,
      },
      {
        // A legacy record set `licensed` only for --license; a preset or --env licence lives
        // in the compose file alone, and wins over a token as the markers do.
        name: 'e3-legacy-env-licence',
        services: {
          rocketchat: { environment: { ROCKETCHAT_LICENSE: 'licence', REG_TOKEN: 'token' } },
        },
        supplied: true,
        source: 'license',
      },
      {
        name: 'e3-legacy-file-licence',
        services: { rocketchat: { env_file: ['licence.env'] } },
        files: { 'licence.env': 'ROCKETCHAT_LICENSE=licence\n' },
        supplied: true,
        source: 'license',
      },
      {
        name: 'e3-legacy-sidecar-licence',
        services: {
          rocketchat: { environment: { PORT: '3000' } },
          'licence-helper': { environment: { ROCKETCHAT_LICENSE: 'licence' } },
        },
        supplied: false,
      },
    ];

    for (const example of examples) {
      for (const [file, text] of Object.entries(example.files ?? {})) {
        fs.mkdirSync(workspace(example.name), { recursive: true });
        fs.writeFileSync(path.join(workspace(example.name), file), text);
      }
      await workspaceNamed(
        example.name,
        example.extra,
        {},
        YAML.stringify({ services: example.services }),
      );
      expect((await record(example.name)).license).toEqual({
        required: false,
        supplied: example.supplied,
        source: example.source ?? (example.supplied ? 'reg_token' : null),
      });
    }
  });

  it('reports an unknown requirement when a legacy preset is no longer available', async () => {
    await workspaceNamed(
      'e3-removed-preset',
      { reg_token_supplied: false },
      { preset: 'removed-evidence-preset' },
    );

    const rec = await record('e3-removed-preset');

    expect(rec.license).toEqual({ required: null, supplied: false, source: null });
    expect(renderMarkdown(rec)).toContain('none supplied (requirement unknown)');
  });

  it('keeps an unknown legacy requirement visible with a supplied licence', async () => {
    await workspaceNamed(
      'e3-removed-licensed-preset',
      { licensed: true },
      { preset: 'removed-licensed-evidence-preset' },
    );

    const rec = await record('e3-removed-licensed-preset');

    expect(rec.license).toEqual({ required: null, supplied: true, source: 'license' });
    expect(renderMarkdown(rec)).toContain(
      'credential supplied (licence file); acceptance not verified; requirement unknown',
    );
  });

  it('evaluates every member of a composite preset from the catalog', async () => {
    fs.mkdirSync(config.presetDir(), { recursive: true });
    fs.writeFileSync(
      path.join(config.presetDir(), 'evidence-licensed.yaml'),
      'name: evidence-licensed\nrequires_license: true\n',
    );
    await workspaceNamed(
      'e3-composite',
      { runtime: 'kubernetes' },
      { preset: 'email+evidence-licensed' },
    );
    expect((await recordKubernetes('e3-composite')).license).toEqual({
      required: true,
      // No marker on a Kubernetes record: the token went into a Secret this does not open.
      supplied: null,
      source: 'unknown',
    });
  });

  it('keeps a multi-instance deployment out of the recorded scenario preset', async () => {
    await workspaceNamed(
      'e3-normalized-preset',
      { runtime: 'docker', deployment: 'multi-instance' },
      { preset: 'email+multi-instance' },
    );

    expect((await record('e3-normalized-preset')).repro).toMatchObject({
      preset: 'email',
      deployment: 'multi-instance',
    });
  });

  it('does not mistake the Kubernetes LDAP topology marker for a preset licence', async () => {
    await workspaceNamed('e3-ldap', { runtime: 'kubernetes' }, { preset: 'ldap' });
    expect((await recordKubernetes('e3-ldap')).license).toEqual({
      required: false,
      supplied: null,
      source: 'unknown',
    });
  });

  it('records the microservices deployment requirement independently of its preset', async () => {
    await workspaceNamed('e3-microservices', { runtime: 'kubernetes' }, { preset: 'ldap' });
    expect(
      (
        await recordKubernetes('e3-microservices', {
          ...KUBERNETES_DETAIL,
          deployment: 'microservices',
        })
      ).license,
    ).toEqual({
      required: true,
      supplied: null,
      source: 'unknown',
    });
  });

  it('keeps a persisted pin and the derived Compose project in the evidence', async () => {
    await workspaceNamed('e3-pinned', {}, { pinned: true, project: '' });
    const rec = await record('e3-pinned', { retained: false });
    expect(rec.retention).toMatchObject({
      retained: true,
      reason: 'persisted preference',
    });
    expect(rec.ownership).toEqual({
      proof: 'record',
      managed_by: 'houston',
      project: 'houston-e3-pinned',
    });
  });

  it('records a literal retained-run preference without claiming prune enforces it', async () => {
    // The preference selects the retention evidence. `prune` still enforces only the pin,
    // so an explicit false wins for an unpinned workspace and the pin test above stays separate.
    await workspaceNamed('e3-preference');
    try {
      config.updateConfig((cfg) => {
        cfg.preferences = { retain_runs: true };
      });
      expect((await record('e3-preference')).retention).toMatchObject({
        retained: true,
        reason: 'persisted preference',
      });
      expect((await record('e3-preference', { retained: false })).retention).toMatchObject({
        retained: false,
        reason: null,
      });
      config.updateConfig((cfg) => {
        cfg.preferences = { retain_runs: 'true' };
      });
      expect((await record('e3-preference')).retention).toMatchObject({
        retained: false,
        reason: null,
      });
    } finally {
      config.updateConfig((cfg) => {
        delete cfg.preferences;
      });
    }
  });

  it('uses the schema path for a Kubernetes artifact on every platform', async () => {
    await workspaceNamed('e3-kubernetes', { runtime: 'kubernetes' });
    fs.unlinkSync(path.join(workspace('e3-kubernetes'), 'docker-compose.yml'));
    fs.mkdirSync(path.join(workspace('e3-kubernetes'), 'kubernetes'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace('e3-kubernetes'), 'kubernetes', 'values.yaml'),
      'rocketchat:\n  env:\n    ADMIN_PASS: S3cretPass\n',
    );
    expect((await recordKubernetes('e3-kubernetes')).artifact).toEqual({
      name: 'kubernetes/values.yaml',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    // An interrupted re-up leaves the previous release's values beside its new request. The
    // Kubernetes path writes its provisional record alone.
    await updateMeta('e3-kubernetes', (meta) => {
      meta.extra.incomplete = true;
    });
    expect((await recordKubernetes('e3-kubernetes')).artifact).toEqual({ name: '', sha256: '' });
  });

  it('uses a live namespace label read before claiming Kubernetes ownership', async () => {
    await workspaceNamed('e3-ownership', {
      runtime: 'kubernetes',
      namespace: 'test-namespace',
      context: 'recorded-context',
    });
    namespaceLabels.mockResolvedValueOnce(null).mockResolvedValueOnce({
      'app.kubernetes.io/managed-by': 'houston',
      'houston.io/workspace': 'e3-ownership',
    });

    expect((await recordKubernetes('e3-ownership')).ownership).toEqual({
      proof: 'unknown',
      managed_by: 'unknown',
      namespace: 'test-namespace',
    });
    expect((await recordKubernetes('e3-ownership')).ownership).toEqual({
      proof: 'label',
      managed_by: 'houston',
      namespace: 'test-namespace',
    });
    expect(namespaceLabels).toHaveBeenNthCalledWith(1, 'test-namespace', {
      context: 'recorded-context',
    });
    expect(namespaceLabels).toHaveBeenNthCalledWith(2, 'test-namespace', {
      context: 'recorded-context',
    });
  });

  it('leaves Kubernetes ownership unknown without the recorded namespace or context', async () => {
    await workspaceNamed('e3-no-context', {
      runtime: 'kubernetes',
      namespace: 'test-namespace',
    });
    await workspaceNamed('e3-no-namespace', {
      runtime: 'kubernetes',
      context: 'test-context',
    });

    expect((await recordKubernetes('e3-no-context')).ownership).toEqual({
      proof: 'unknown',
      managed_by: 'unknown',
      namespace: 'test-namespace',
    });
    expect((await recordKubernetes('e3-no-namespace')).ownership).toEqual({
      proof: 'unknown',
      managed_by: 'unknown',
      namespace: '',
    });
    expect(namespaceLabels).not.toHaveBeenCalled();
  });

  it('unwinds an interrupted Kubernetes ownership read', async () => {
    await workspaceNamed('e3-interrupted', {
      runtime: 'kubernetes',
      namespace: 'test-namespace',
      context: 'test-context',
    });
    namespaceLabels.mockRejectedValueOnce(new Interrupted());

    await expect(recordKubernetes('e3-interrupted')).rejects.toBeInstanceOf(Interrupted);
  });

  it('selects the Kubernetes artifact after a Docker workspace changes runtime', async () => {
    await workspaceNamed('e3-runtime-switch', {
      runtime: 'kubernetes',
      namespace: 'test-namespace',
    });
    fs.mkdirSync(path.join(workspace('e3-runtime-switch'), 'kubernetes'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace('e3-runtime-switch'), 'kubernetes', 'values.yaml'),
      'rocketchat:\n  env:\n    ADMIN_PASS: KubeAdminSecret\n',
    );
    const rec = await recordKubernetes('e3-runtime-switch');
    const dest = path.join(workspace('e3-runtime-switch'), 'out', 'bundle');
    const out = await writeBundle('e3-runtime-switch', dest, rec);

    expect(rec.artifact).toEqual({
      name: 'kubernetes/values.yaml',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(out.files).toEqual(
      expect.arrayContaining(['manifest.json', 'README.md', 'values.yaml']),
    );
    expect(fs.existsSync(path.join(dest, 'docker-compose.yml'))).toBe(false);
  });

  it('carries the seed record when there is one, and nothing when there is not', async () => {
    await workspaceNamed('e4', { seed: { profile: 'small', actual: { users: 5 } } });
    expect((await record('e4')).seed).toEqual({ profile: 'small', actual: { users: 5 } });
    await workspaceNamed('e5');
    expect('seed' in (await record('e5'))).toBe(false);
  });

  it('projects only the seed facts that are safe to attach', async () => {
    const sentinel = 'EVIDENCE-SEED-SENTINEL';
    await workspaceNamed('e4-allowlist', {
      seed: {
        profile: 'small',
        planned: {
          users: 5,
          messages: 12,
          rooms: { channel: 2, dm: 1, [sentinel]: 99 },
          details: sentinel,
        },
        actual: {
          users: 5,
          messages: 12,
          rooms: { channel: 2, dm: 1, [sentinel]: 99 },
          locations: [sentinel],
        },
        verification: {
          ok: true,
          checked: 3,
          checks_completed: 11,
          features: { messages: 12, files: 2, [sentinel]: 99 },
          faults: [{ detail: sentinel }],
          extra: [{ token: sentinel }],
          unreadable: [{ why: sentinel }],
          why: sentinel,
        },
        scenarios: ['permissions', sentinel],
        features: { files: 2, total_content: 12, custom_emoji: [sentinel] },
        history: { token: sentinel },
        locations: [{ rid: sentinel }],
        run_id: sentinel,
        at: '2026-10-15T10:00:00+00:00',
        unknown: sentinel,
      },
    });

    const rec = await record('e4-allowlist');

    expect(rec.seed).toEqual({
      profile: 'small',
      planned: { users: 5, messages: 12, rooms: { channel: 2, dm: 1 } },
      actual: { users: 5, messages: 12, rooms: { channel: 2, dm: 1 } },
      verification: {
        ok: true,
        checked: 3,
        checks_completed: 11,
        features: { messages: 12, files: 2 },
      },
      scenarios: ['permissions'],
      features: { files: 2, total_content: 12 },
      at: '2026-10-15T10:00:00+00:00',
    });
    expect(JSON.stringify(rec)).not.toContain(sentinel);
  });

  it('names the cleanup as a command a person can paste, whatever the runtime', async () => {
    await workspaceNamed('e6');
    expect((await record('e6')).retention).toMatchObject({
      retained: false,
      reason: null,
      cleanup: 'houston down --name e6 --volumes --yes',
      owner: 'houston',
    });
    expect(cleanupCommand('TICKET-1234')).toBe('houston down --name TICKET-1234 --volumes --yes');
    expect(cleanupCommand('legacy\n')).toBe("houston down --name 'legacy\n' --volumes --yes");
  });
});

describe('retention', () => {
  it('defaults to teardown, and a retained run names one of the two reasons', () => {
    expect(resolveRetention()).toEqual({ retained: false, reason: null });
    expect(resolveRetention({ retained: true })).toEqual({
      retained: true,
      reason: 'explicit task',
    });
    expect(resolveRetention({ retained: true, reason: 'persisted preference' })).toEqual({
      retained: true,
      reason: 'persisted preference',
    });
  });

  it('refuses a reason an agent made up', () => {
    expect(() => resolveRetention({ retained: true, reason: 'felt like it' })).toThrow(
      ValidationError,
    );
  });
});

describe('the bundle', () => {
  it('writes the record, a README, and a redacted deployment artifact', async () => {
    await workspaceNamed('e7');
    const rec = await record('e7');
    const dest = path.join(workspace('e7'), 'out', 'bundle');
    const out = await writeBundle('e7', dest, rec);
    expect(out.path).toBe(dest);
    expect(out.files).toEqual(
      expect.arrayContaining(['manifest.json', 'README.md', 'docker-compose.yml']),
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'),
    ) as Record<string, Record<string, unknown>>;
    expect(manifest.repro?.name).toBe('e7');
    const readme = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('# Workspace `e7` — Rocket.Chat 8.5.1');
    expect(readme).toContain('| URL | http://localhost:3000 |');
    expect(readme).toContain('houston down --name e7 --volumes --yes');
    // Rendered from the record, so it cannot say what the record withheld.
    expect(readme).not.toContain('S3cretPass');
    expect(readme).not.toContain('admin:pw');
    const artifact = fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8');
    expect(artifact).toContain('********');
    expect(artifact).not.toContain('S3cretPass');
    expect(artifact).not.toContain('SUPERSECRETTOKEN');
    expect(artifact).not.toContain('MongoUrlSecret');
    const rawArtifact = rec.artifact as Record<string, unknown>;
    expect(rawArtifact).toEqual({
      name: 'docker-compose.yml',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(manifest.artifact).toEqual({
      name: 'docker-compose.yml',
      sha256: rawArtifact.sha256,
      sanitized: {
        name: 'docker-compose.yml',
        sha256: createHash('sha256').update(artifact).digest('hex'),
      },
    });
    expect((manifest.artifact?.sanitized as Record<string, unknown>).sha256).not.toBe(
      rawArtifact.sha256,
    );
    const rendered = YAML.parse(artifact) as {
      services: {
        rocketchat: {
          command: string[];
          labels: Record<string, string>;
        };
      };
    };
    // The workspace's actual admin password can appear under arbitrary deployment keys.
    // Rendering still masks it while retaining a bundle a support reader can inspect.
    expect(rendered.services.rocketchat.command).toEqual(['/bin/sh', '-c', 'echo ********']);
    expect(rendered.services.rocketchat.labels['com.example.evidence-note']).toBe('********');
    expect(out.files).not.toContain('logs/compose.log');
  });

  it('collects artifact credentials before masking aliases and earlier copies', async () => {
    const name = 'e7-credential-copies';
    await workspaceNamed(name);
    const embedded =
      '{"copy":"EmbeddedCopySentinel","password":"EmbeddedCopySentinel","keep":1.50}';
    const doc = [
      'x-before: &copy AliasCopySentinel',
      'x-json-copy: EmbeddedCopySentinel',
      'x-list-copy: ListCopySentinel',
      'x-named-copy: NamedCopySentinel',
      'x-url-copy: UrlCopySentinel',
      'x-control: readable',
      'services:',
      '  rocketchat:',
      '    environment:',
      '      DB_PASSWORD: *copy',
      `      CONFIG: '${embedded}'`,
      '      URL: https://UrlCopySentinel@example.test',
      'x-list: [DB_PASSWORD=ListCopySentinel]',
      'x-named: {value: NamedCopySentinel, name: DB_PASSWORD}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(workspace(name), 'docker-compose.yml'), doc);
    const dest = path.join(workspace(name), 'out', 'bundle');
    await writeBundle(name, dest, await record(name));
    const text = fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8');
    for (const secret of [
      'AliasCopySentinel',
      'EmbeddedCopySentinel',
      'ListCopySentinel',
      'NamedCopySentinel',
      'UrlCopySentinel',
    ])
      expect(text).not.toContain(secret);
    const parsed = YAML.parse(text) as {
      'x-control': string;
      services: { rocketchat: { environment: { CONFIG: string } } };
    };
    expect(parsed['x-control']).toBe('readable');
    expect(parsed.services.rocketchat.environment.CONFIG).toBe(
      '{"copy":"********","password":"********","keep":1.50}',
    );
  });

  it('collects authorization headers and their earlier copies without hiding policy fields', async () => {
    const name = 'e7-authorization';
    await workspaceNamed(name);
    const headers = [
      'Authorization',
      'authorization',
      'AUTHORIZATION',
      'authHeader',
      'auth-header',
      'AUTH_HEADER',
      'proxyAuthorization',
      'authorizationHeader',
    ];
    const secrets = headers.map((_, index) => `HeaderSentinel${String(index)}END`);
    const doc = {
      'x-copies': secrets.map((secret, index) => ({
        text: `${index % 2 === 0 ? 'Bearer' : 'Basic'} ${secret}`,
        copyBare: secret,
      })),
      'x-controls': {
        authorizationEnabled: true,
        authorizationPolicy: 'readable',
        authorizerUrl: 'https://example.test',
        authHeaderCount: 2,
        author: 'support',
      },
      services: { rocketchat: { image: 'rocketchat/rocket.chat:8.5.1' } },
      'x-headers': Object.fromEntries(
        headers.map((key, index) => [
          key,
          `${index % 2 === 0 ? 'Bearer' : 'Basic'} ${secrets[index] ?? ''}`,
        ]),
      ),
      'x-named': { value: 'Bearer NamedHeaderSentinelEND', name: 'AUTH_HEADER' },
      'x-named-copy': 'NamedHeaderSentinelEND',
      'x-json': JSON.stringify({
        before: 'EmbeddedHeaderSentinelEND',
        authorization: 'Basic EmbeddedHeaderSentinelEND',
        keep: 'readable',
      }),
    };
    fs.writeFileSync(path.join(workspace(name), 'docker-compose.yml'), YAML.stringify(doc));
    const dest = path.join(workspace(name), 'out', 'bundle');
    await collect(name, { bundle: dest });
    const files = fs.readdirSync(dest);
    expect(files).toContain('docker-compose.yml');
    for (const file of files) {
      const text = fs.readFileSync(path.join(dest, file), 'utf8');
      for (const secret of [...secrets, 'NamedHeaderSentinelEND', 'EmbeddedHeaderSentinelEND'])
        expect(text).not.toContain(secret);
    }
    const rendered = YAML.parse(
      fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8'),
    ) as typeof doc;
    expect(rendered['x-controls']).toEqual(doc['x-controls']);
    expect(JSON.parse(rendered['x-json']) as unknown).toEqual({
      before: '********',
      authorization: '********',
      keep: 'readable',
    });
  });

  it('collects nested JSON, scalar and cross-document credentials without erasing controls', async () => {
    const name = 'e7-deep-credential-copies';
    const cfg =
      '{"copy":"NestedCopySentinel","password":"NestedCopySentinel","numberCopy":4.500,"numberText":"4.50","apiKey":4.50,"named":[{"value":"ValueFirstSentinel","name":"DB_PASSWORD"},{"name":"client_secret","value":"NameFirstSentinel"}],"assignments":["DB_PASSWORD=AssignedCopySentinel"],"escapedCopy":"Escaped\\u0043opySentinel","secret":"EscapedCopySentinel","password":"DuplicateMemberSentinel","keep":1.50}';
    const nested = JSON.stringify({ payload: cfg, copy: 'NestedCopySentinel' });
    const doc = [
      'x-cross-doc: CrossDocSentinel',
      'x-before: [NestedCopySentinel, ValueFirstSentinel, NameFirstSentinel, AssignedCopySentinel, DuplicateMemberSentinel]',
      `x-json: '${nested}'`,
      'x-raw-scalar: "-0"',
      'x-original-scalar: -0',
      'x-url-name: rocket',
      'x-url-copy: UrlPasswordSentinel',
      'x-control: rocketchat',
      'x-port: 27017',
      'x-password-number: 7',
      'x-auth-url: https://rocket:UrlPasswordSentinel@example.test',
      'x-scalar-password: -0',
      '---',
      'x-password: CrossDocSentinel',
      'x-last-control: readable',
      '',
    ].join('\n');
    await workspaceNamed(name, { runtime: 'kubernetes' });
    fs.mkdirSync(path.join(workspace(name), 'kubernetes'), { recursive: true });
    fs.writeFileSync(path.join(workspace(name), 'kubernetes', 'values.yaml'), doc);
    const dest = path.join(workspace(name), 'out', 'bundle');
    await writeBundle(name, dest, await recordKubernetes(name));
    const text = fs.readFileSync(path.join(dest, 'values.yaml'), 'utf8');
    for (const value of [
      'CrossDocSentinel',
      'NestedCopySentinel',
      'ValueFirstSentinel',
      'NameFirstSentinel',
      'AssignedCopySentinel',
      'DuplicateMemberSentinel',
      'EscapedCopySentinel',
      'UrlPasswordSentinel',
    ])
      expect(text).not.toContain(value);
    const parsed = YAML.parseAllDocuments(text).map(
      (document) => document.toJS() as Record<string, unknown>,
    );
    expect(parsed[0]?.['x-control']).toBe('rocketchat');
    expect(parsed[0]?.['x-url-name']).toBe('********');
    expect(parsed[0]?.['x-port']).toBe(27017);
    expect(parsed[0]?.['x-raw-scalar']).toBe('********');
    expect(parsed[0]?.['x-original-scalar']).toBe('********');
    const json = JSON.parse(String(parsed[0]?.['x-json'])) as { payload: string; copy: string };
    expect(json.copy).toBe('********');
    expect(json.payload).toContain('"keep":1.50');
    const inner = JSON.parse(json.payload) as Record<string, unknown>;
    expect(inner.escapedCopy).toBe('********');
    expect(inner.numberCopy).toBe('********');
    expect(inner.numberText).toBe('********');
    expect(parsed[1]?.['x-last-control']).toBe('readable');
  });

  it('discovers every duplicate YAML credential name before rendering earlier copies', async () => {
    const name = 'e7-duplicate-names';
    const doc = [
      'x-copy: DuplicateYamlSentinel',
      'x-alias-copy: AliasNameSentinel',
      'x-label-copy: AliasKeySentinel',
      'x-value-copy: DuplicateValueSentinel',
      'x-name: &credentialName DB_PASSWORD',
      'x-label: &nameKey name',
      'x-pair: {name: benign, name: DB_PASSWORD, value: DuplicateYamlSentinel}',
      'x-alias-pair: {name: benign, name: *credentialName, value: AliasNameSentinel}',
      'x-label-pair: {name: benign, *nameKey : DB_PASSWORD, value: AliasKeySentinel}',
      'x-values: {name: benign, name: DB_PASSWORD, value: DuplicateValueSentinel, value: last}',
      'x-control: readable',
      '',
    ].join('\n');
    await workspaceNamed(name, {}, {}, doc);
    const dest = path.join(workspace(name), 'out', 'bundle');
    await collect(name, { bundle: dest });
    const text = fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8');
    for (const secret of [
      'DuplicateYamlSentinel',
      'AliasNameSentinel',
      'AliasKeySentinel',
      'DuplicateValueSentinel',
    ])
      expect(text).not.toContain(secret);
    const parsed = YAML.parse(text) as Record<string, unknown>;
    expect(parsed['x-control']).toBe('readable');
    expect(parsed['x-pair']).toEqual({ name: 'DB_PASSWORD', value: '********' });
  });

  /** Write `doc` as the workspace's Compose file and collect a bundle from it. */
  async function bundledCompose(
    name: string,
    doc: string,
  ): Promise<{ compose: string; everything: string }> {
    await workspaceNamed(name, {}, {}, doc);
    const dest = path.join(workspace(name), 'out', 'bundle');
    await collect(name, { bundle: dest });
    return {
      compose: fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8'),
      everything: fs
        .readdirSync(dest)
        .map((file) => fs.readFileSync(path.join(dest, file), 'utf8'))
        .join('\n'),
    };
  }

  function pick(value: unknown, ...keys: string[]): unknown {
    return keys.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], value);
  }

  it.each([
    {
      id: 'first',
      origin: 'a credential name first, an ordinary name last',
      json: '{"name":"Authorization","value":"Bearer DupJsonFirstSentinel","name":"ordinary","keep":1.50}',
      masked: '{"name":"Authorization","value":"********","name":"ordinary","keep":1.50}',
      sentinel: 'DupJsonFirstSentinel',
      copy: 'DupJsonFirstSentinel',
    },
    {
      id: 'last',
      origin: 'an ordinary name first, a credential name last',
      json: '{"name":"ordinary","value":"Bearer DupJsonLastSentinel","name":"Authorization","keep":1.50}',
      masked: '{"name":"ordinary","value":"********","name":"Authorization","keep":1.50}',
      sentinel: 'DupJsonLastSentinel',
      copy: 'DupJsonLastSentinel',
    },
    {
      id: 'single',
      origin: 'a single credential name',
      json: '{"name":"Authorization","value":"Bearer DupJsonSingleSentinel","keep":1.50}',
      masked: '{"name":"Authorization","value":"********","keep":1.50}',
      sentinel: 'DupJsonSingleSentinel',
      copy: 'DupJsonSingleSentinel',
    },
    {
      id: 'direct',
      origin: 'duplicate direct Authorization members',
      json: '{"Authorization":"Bearer DupJsonDirectSentinel","Authorization":"ordinary","keep":1.50}',
      masked: '{"Authorization":"********","Authorization":"********","keep":1.50}',
      sentinel: 'DupJsonDirectSentinel',
      copy: 'DupJsonDirectSentinel',
    },
    {
      id: 'middle',
      origin: 'a credential name between ordinary names, with a value on each side',
      json: '{"value":"DupJsonEarlySentinel","name":"ordinary","name":"DB_PASSWORD","name":"other","value":"DupJsonLateSentinel","keep":1.50}',
      masked:
        '{"value":"********","name":"ordinary","name":"DB_PASSWORD","name":"other","value":"********","keep":1.50}',
      sentinel: 'DupJsonLateSentinel',
      copy: 'DupJsonEarlySentinel',
    },
    {
      id: 'numeric',
      origin: 'a numeric credential value beside duplicate names',
      json: '{"name":"DB_PASSWORD","value":4.50,"name":"ordinary","keep":27017}',
      masked: '{"name":"DB_PASSWORD","value":"********","name":"ordinary","keep":27017}',
      sentinel: null,
      copy: '4.5',
    },
  ])(
    'discovers duplicate embedded JSON names before rendering copies: $origin',
    async ({ id, json, masked, sentinel, copy }) => {
      const name = `e7-dup-json-${id}`;
      const { compose, everything } = await bundledCompose(
        name,
        [
          `x-before: ${copy}`,
          `x-json: '${json}'`,
          `x-after: ${copy}`,
          'x-port: 27017',
          'x-control: readable',
          '',
        ].join('\n'),
      );
      if (sentinel !== null) expect(everything).not.toContain(sentinel);
      if (sentinel !== null && copy !== sentinel) expect(everything).not.toContain(copy);
      const parsed = YAML.parse(compose) as Record<string, unknown>;
      expect(parsed['x-json']).toBe(masked);
      expect(parsed['x-before']).toBe('********');
      expect(parsed['x-after']).toBe('********');
      expect(parsed['x-port']).toBe(27017);
      expect(parsed['x-control']).toBe('readable');
    },
  );

  it('keeps duplicate JSON names that name no credential readable', async () => {
    const ordinary =
      '{"name":"service","value":"KeepOrdinaryJsonSentinel","name":"label","keep":1.50}';
    const { compose } = await bundledCompose(
      'e7-dup-json-ordinary',
      [`x-json: '${ordinary}'`, 'x-port: 27017', 'x-control: readable', ''].join('\n'),
    );
    const parsed = YAML.parse(compose) as Record<string, unknown>;
    expect(parsed['x-json']).toBe(ordinary);
    expect(parsed['x-port']).toBe(27017);
  });

  it.each(
    ['command', 'entrypoint', 'args', 'test'].flatMap((field) =>
      ['--password', '--reg-token'].map((flag) => ({ field, flag })),
    ),
  )(
    'discovers the $flag value in a $field list before rendering copies',
    async ({ field, flag }) => {
      const secret = `Argv_${field}_${flag.slice(2).replace('-', '_')}_Sentinel`;
      const list = `[client, ${flag}, ${secret}, --port, "27017"]`;
      const { compose, everything } = await bundledCompose(
        `e7-argv-${field}-${flag.slice(2)}`,
        [
          `x-before: ${secret}`,
          'services:',
          '  rocketchat:',
          '    image: example',
          ...(field === 'test'
            ? ['    healthcheck:', `      test: ${list}`]
            : [`    ${field}: ${list}`]),
          `x-after: ${secret}`,
          'x-port: 27017',
          'x-replica: rocketchat-1',
          'x-controls:',
          '  authorizationEnabled: true',
          '  authHeaderCount: 2',
          'x-control: readable',
          '',
        ].join('\n'),
      );
      expect(everything).not.toContain(secret);
      const parsed = YAML.parse(compose) as Record<string, unknown>;
      const rocketchat = pick(parsed, 'services', 'rocketchat');
      expect(
        field === 'test' ? pick(rocketchat, 'healthcheck', 'test') : pick(rocketchat, field),
      ).toBe('********');
      expect(parsed['x-before']).toBe('********');
      expect(parsed['x-after']).toBe('********');
      expect(parsed['x-port']).toBe(27017);
      expect(parsed['x-replica']).toBe('rocketchat-1');
      expect(parsed['x-controls']).toEqual({ authorizationEnabled: true, authHeaderCount: 2 });
      expect(parsed['x-control']).toBe('readable');
    },
  );

  it('does not let a credential flag mask an argument it does not precede', async () => {
    const { compose } = await bundledCompose(
      'e7-argv-equals',
      [
        'x-before: EqualsArgumentSentinel',
        'services:',
        '  rocketchat:',
        '    image: example',
        '    command: [client, --password=EqualsArgumentSentinel, EqualsNeighborSentinel, --port, "27017", --name, rocketchat-1, --verbose, --password]',
        '    args: [--password, ArgsSentinelOne, --port, "27017"]',
        'x-notes:',
        '  - --password',
        '  - NotListSentinel',
        'x-port: 27017',
        'x-control: readable',
        '',
      ].join('\n'),
    );
    expect(compose).not.toContain('EqualsArgumentSentinel');
    expect(compose).not.toContain('ArgsSentinelOne');
    const parsed = YAML.parse(compose) as Record<string, unknown>;
    // A command naming a credential flag is withheld whole.
    expect(pick(parsed, 'services', 'rocketchat', 'command')).toBe('********');
    expect(pick(parsed, 'services', 'rocketchat', 'args')).toBe('********');
    // A list under any other key is data, not an argument sequence.
    expect(parsed['x-notes']).toEqual(['--password', 'NotListSentinel']);
    expect(parsed['x-before']).toBe('********');
    expect(parsed['x-port']).toBe(27017);
    expect(parsed['x-control']).toBe('readable');
  });

  it('discovers credential flags in shell command strings by shell quoting rules', async () => {
    const { compose } = await bundledCompose(
      'e7-argv-strings',
      [
        'services:',
        '  rocketchat:',
        '    image: example',
        '    command: client --reg-token "Two WordsSentinel" --port 27017',
        `    entrypoint: [sh, -c, "client --password 'QuotedSentinel'; echo done"]`,
        '    healthcheck:',
        `      test: sh -c 'mongosh -p HealthSentinel --username=root --eval ping'`,
        '  nested:',
        '    image: example',
        `    command: su -c "client --password NestedSentinel" app`,
        '  joined:',
        '    image: example',
        String.raw`    command: client --password Pre"Mid JoinedSentinel" --reg-token Bs\ EscapedSentinel`,
        '  mysql:',
        '    image: example',
        '    command: [mysql, -p, ListShortSentinel, -uroot]',
        '  digits:',
        '    image: example',
        '    command: [mongosh, -u, root, -p, "12345678"]',
        '  cluster:',
        '    image: example',
        '    command: [python, -u, app.py, -pv]',
        '  exec:',
        '    image: example',
        '    command: docker exec -u root:root app',
        '  continued:',
        '    image: example',
        '    command: "client --password \\\\\\nContinuedSentinel --verbose"',
        '  escaped:',
        '    image: example',
        String.raw`    command: sh -c "client --password Esc\\\"apedSentinel"`,
        '  numeric:',
        '    image: example',
        '    command: mongosh -u root -p 12345 --eval ping',
        '  equals:',
        '    image: example',
        '    command: curl https://host --password=TopEqualsSentinel',
        '  backtick:',
        '    image: example',
        '    command: echo `client --password BacktickSentinel`',
        '  embedded:',
        '    image: example',
        `    environment: { SPEC: '{"command":"client --password EmbeddedSentinel"}' }`,
        '  curl:',
        '    image: example',
        '    command: curl -u admin:CurlUserSentinel https://x',
        '  curllist:',
        '    image: example',
        '    command: [curl, -u, "admin:CurlListSentinel", https://x]',
        '  embeddedlist:',
        '    image: example',
        `    environment: { SPEC: '{"command":["sh","-c","client --password EmbeddedListSentinel"]}' }`,
        '  embeddedquoted:',
        '    image: example',
        `    environment: { SPEC: '{"command":["sh","-c","client --password \\"open QuotedPhraseSentinel\\""]}' }`,
        '  embeddedsubst:',
        '    image: example',
        `    environment: { SPEC: '{"command":["sh","-c","client --password \\"$(cat /run/secrets/x)\\""]}' }`,
        '  dash:',
        '    image: example',
        '    command: client --password -DashSentinel',
        '  pwfile:',
        '    image: example',
        '    command: client --password-file=/run/secrets/db',
        '  login:',
        '    image: example',
        '    command: docker login --password-stdin registry.example.test',
        '  python:',
        '    image: example',
        '    command: python -u app.py -p production',
        '  escapedword:',
        '    image: example',
        String.raw`    command: sh -c client\ --password\ EscapedWordSentinel`,
        '  docker:',
        '    image: example',
        '    command: docker run -u 1000 -p 8080:80 -p --eval image',
        '  proxy:',
        '    image: example',
        `    command: sh -c "useradd -u 1000 app; mkdir -p /data/db && proxy -p 8080:80 --password;"`,
        '  split:',
        '    image: example',
        '    entrypoint: [mysql]',
        '    command: [-u, root, -p, SplitSentinel]',
        '  windows:',
        '    image: example',
        String.raw`    command: ['C:\bin\mysql.exe', -u, root, -p, ExeSentinel]`,
        '  pysplit:',
        '    image: example',
        '    entrypoint: [python]',
        '    command: [-u, app.py, -p, production]',
        '  mysqlattached:',
        '    image: example',
        '    command: mysql -uroot -pAttachedSentinel',
        '  redis:',
        '    image: example',
        '    command: [redis-cli, -a, RedisSentinel, PING]',
        '  openssl:',
        '    image: example',
        '    command: openssl rsa -in key.pem -passin pass:PassinSentinel',
        '  curlsplit:',
        '    image: example',
        '    entrypoint: [curl]',
        '    command: [-u, "admin:CurlPairSentinel", https://x]',
        '  jsonsplit:',
        '    image: example',
        `    environment: { SPEC: '{"command":["mongosh"],"args":["-u","root","-p","JsonPairSentinel"]}' }`,
        '  copyarchive:',
        '    image: example',
        '    command: cp -a production /dst',
        '  dockerlogin:',
        '    image: example',
        '    command: docker login -u admin -p DockerLoginSentinel registry.example.test',
        '  oauth:',
        '    image: example',
        '    command: curl --oauth2-bearer OauthSentinel https://x',
        '  ansi:',
        '    image: example',
        `    command: bash -c "client --password $'AnsiSentinel'"`,
        '  heredoc:',
        '    image: example',
        '    command: ["sh", "-c", "cat <<EOF\\nclient --password HeredocData\\nEOF"]',
        '  shellheredoc:',
        '    image: example',
        '    command: ["sh", "-c", "sh <<EOF\\nclient --password ShellHeredocSentinel\\nEOF"]',
        '  jq:',
        '    image: example',
        '    command: jq --sort-keys input.json',
        '  jsondup:',
        '    image: example',
        `    environment: { SPEC: '{"command":["mongosh"],"args":["-u","root","-p","DupJsonSentinel"],"args":[]}' }`,
        '  wrappedheredoc:',
        '    image: example',
        '    command: ["sh", "-c", "env sh <<EOF\\nclient --password WrappedHeredocSentinel\\nEOF"]',
        '  literalbearer:',
        '    image: example',
        '    command: [curl, -H, "Authorization: Bearer $LiteralBearerSentinel", https://x]',
        '  shortpw:',
        '    image: example',
        '    command: [mysql, -u, root, -p, ab]',
        '  wincurl:',
        '    image: example',
        String.raw`    command: ['C:\Windows\System32\curl.exe', -u, 'admin:WinCurlSentinel', https://x]`,
        '  jsonshell:',
        '    image: example',
        `    environment: { SPEC: '{"command":["sh","-c","client --password JsonShellSentinel"]}' }`,
        '  upperclient:',
        '    image: example',
        String.raw`    command: ['C:\BIN\MYSQL.EXE', -uroot, -pUpperSentinel]`,
        '  jsonnumber:',
        '    image: example',
        `    environment: { SPEC: '{"command":["mongosh"],"args":["-u","root","-p",987654321]}' }`,
        '  printfheredoc:',
        '    image: example',
        `    command: ["sh", "-c", "printf '%s' sh <<EOF\\nclient --password PrintfHeredocData\\nEOF"]`,
        '  sudoheredoc:',
        '    image: example',
        '    command: ["sh", "-c", "sudo -n sh <<EOF\\nclient --password SudoHeredocSentinel\\nEOF"]',
        '  timeheredoc:',
        '    image: example',
        '    command: ["sh", "-c", "timeout 5 bash <<EOF\\nclient --password TimeoutHeredocSentinel\\nEOF"]',
        '  ansiunicode:',
        '    image: example',
        `    command: bash -c "client --password $'Ansi\\u0055nicodeSentinel'"`,
        '  quoteddollar:',
        '    image: example',
        `    command: ["sh", "-c", "curl -H 'Authorization: Bearer $QuotedDollarSentinel' https://x"]`,
        '  envprintf:',
        '    image: example',
        `    command: ["sh", "-c", "env printf '%s' sh <<EOF\\nclient --password EnvPrintfData\\nEOF"]`,
        '  kubeliteral:',
        '    image: example',
        '    command: kubectl create secret generic example --from-literal=key1=KubeLiteralSentinel',
        '  sshlogin:',
        '    image: example',
        '    command: sshpass -p SshpassSentinel ssh user@host',
        'x-copy: QuotedSentinel',
        'x-split-copy: SplitSentinel',
        'x-dup-ansi-unicode: AnsiUnicodeSentinel',
        'x-dup-quoted-dollar: $QuotedDollarSentinel',
        'x-env-printf: EnvPrintfData',
        'x-dup-kube-literal: KubeLiteralSentinel',
        'x-dup-ssh-login: SshpassSentinel',
        'x-dup-sudo-heredoc: SudoHeredocSentinel',
        'x-dup-timeout-heredoc: TimeoutHeredocSentinel',
        'x-dup-json-shell: JsonShellSentinel',
        'x-dup-upper: UpperSentinel',
        'x-dup-number: 987654321',
        'x-printf-heredoc: PrintfHeredocData',
        'x-dup-json-dup: DupJsonSentinel',
        'x-dup-wrapped: WrappedHeredocSentinel',
        'x-dup-literal: $LiteralBearerSentinel',
        'x-dup-wincurl: WinCurlSentinel',
        'x-short-copy: ab',
        'x-short-word: cabbage',
        'x-dup-docker: DockerLoginSentinel',
        'x-dup-oauth: OauthSentinel',
        'x-dup-ansi: AnsiSentinel',
        'x-dup-shell-heredoc: ShellHeredocSentinel',
        'x-heredoc: HeredocData',
        'x-input: input.json',
        'x-dup-attached: AttachedSentinel',
        'x-dup-redis: RedisSentinel',
        'x-dup-ssl: PassinSentinel',
        'x-dup-curl: CurlPairSentinel',
        'x-dup-json: JsonPairSentinel',
        'x-env: production',
        'x-escaped-copy: EscapedWordSentinel',
        'x-backtick-copy: BacktickSentinel',
        'x-registry: registry.example.test',
        'x-dash-copy: -DashSentinel',
        'x-mount-path: /run/secrets/db',
        "x-dollar: 'cost $5 each'",
        "x-open: 'open the door'",
        'x-port: 8080:80',
        'x-control: readable',
        '',
      ].join('\n'),
    );
    for (const sentinel of [
      'WordsSentinel',
      'QuotedSentinel',
      'HealthSentinel',
      'NestedSentinel',
      'JoinedSentinel',
      'EscapedSentinel',
      'ListShortSentinel',
      'ContinuedSentinel',
      'apedSentinel',
      'TopEqualsSentinel',
      'BacktickSentinel',
      'EmbeddedSentinel',
      'CurlUserSentinel',
      'CurlListSentinel',
      'DashSentinel',
      'EmbeddedListSentinel',
      'QuotedPhraseSentinel',
      'EscapedWordSentinel',
      'SplitSentinel',
      'ExeSentinel',
      'AttachedSentinel',
      'RedisSentinel',
      'PassinSentinel',
      'CurlPairSentinel',
      'JsonPairSentinel',
      'DockerLoginSentinel',
      'OauthSentinel',
      'AnsiSentinel',
      'ShellHeredocSentinel',
      'DupJsonSentinel',
      'WrappedHeredocSentinel',
      'LiteralBearerSentinel',
      'WinCurlSentinel',
      'JsonShellSentinel',
      'UpperSentinel',
      '987654321',
      'SudoHeredocSentinel',
      'TimeoutHeredocSentinel',
      'AnsiUnicodeSentinel',
      'QuotedDollarSentinel',
      'KubeLiteralSentinel',
      'SshpassSentinel',
    ]) {
      expect(compose).not.toContain(sentinel);
    }
    const parsed = YAML.parse(compose) as Record<string, unknown>;
    expect(pick(parsed, 'services', 'rocketchat', 'command')).toBe('********');
    expect(parsed['x-copy']).toBe('********');
    expect(pick(parsed, 'services', 'numeric', 'command')).toBe('********');
    // A mode switch takes no value: the registry stays readable outside the withheld command.
    expect(pick(parsed, 'services', 'login', 'command')).toBe('********');
    expect(parsed['x-registry']).toBe('registry.example.test');
    // A mode switch in `--flag=value` form names a path, not a secret.
    expect(parsed['x-mount-path']).toBe('/run/secrets/db');
    // A naive split of `"$(cat ...)"` must not make `$` a secret across the bundle.
    expect(parsed['x-dollar']).toBe('cost $5 each');
    expect(parsed['x-open']).toBe('open the door');
    // A port or an option after -p is the next argument; newlines are never masked.
    // `-u` beside `-p` counts only for a MySQL, MariaDB or MongoDB client; Docker's are a user and
    // a port, and stay readable.
    expect(pick(parsed, 'services', 'docker', 'command')).toBe(
      'docker run -u 1000 -p 8080:80 -p --eval image',
    );
    expect(pick(parsed, 'services', 'python', 'command')).toBe('python -u app.py -p production');
    expect(parsed['x-env']).toBe('production');
    // One command split over `entrypoint` and `command` is judged whole: mysql's -p is withheld
    // in both keys, while python's split command stays readable.
    expect(pick(parsed, 'services', 'split', 'entrypoint')).toBe('********');
    expect(pick(parsed, 'services', 'split', 'command')).toBe('********');
    // A short credential masks whole values only, not every place its letters appear.
    expect(parsed['x-short-copy']).toBe('********');
    expect(parsed['x-short-word']).toBe('cabbage');
    // `env` runs `printf` here, and `sh` is only its argument.
    expect(parsed['x-env-printf']).toBe('EnvPrintfData');
    // `printf` names `sh` as data, so its heredoc is data too.
    expect(parsed['x-printf-heredoc']).toBe('PrintfHeredocData');
    // A heredoc fed to `cat` is data, and `--sort-keys` sorts: their values stay readable.
    expect(parsed['x-heredoc']).toBe('HeredocData');
    expect(parsed['x-input']).toBe('input.json');
    expect(pick(parsed, 'services', 'jq', 'command')).toBe('jq --sort-keys input.json');
    // `-a` is a password only for redis-cli; `cp -a` keeps its argument readable.
    expect(pick(parsed, 'services', 'copyarchive', 'command')).toBe('cp -a production /dst');
    expect(pick(parsed, 'services', 'pysplit', 'command')).toEqual([
      '-u',
      'app.py',
      '-p',
      'production',
    ]);
    expect(compose).toContain('\n');
    expect(pick(parsed, 'services', 'digits', 'command')).toBe('********');
    // Short flag clusters and `user:group` are not credentials.
    expect(pick(parsed, 'services', 'cluster', 'command')).toEqual([
      'python',
      '-u',
      'app.py',
      '-pv',
    ]);
    expect(pick(parsed, 'services', 'exec', 'command')).toBe('docker exec -u root:root app');
    // `;` ends a command: the user flag before it does not make the later -p a password, and a
    // flag with nothing after it masks nothing.
    // It names --password, so the line is withheld; the values around it are not secrets and
    // stay readable everywhere else.
    expect(pick(parsed, 'services', 'proxy', 'command')).toBe('********');
    expect(parsed['x-port']).toBe('8080:80');
    expect(parsed['x-control']).toBe('readable');
  });

  interface CommandCase {
    finding: string;
    yaml: string[];
    absent: string[];
    expected: [string[], unknown][];
  }

  // One case per Codex finding on PR 64 rounds two and three, so each fails and passes on its own.
  it.each<CommandCase>([
    {
      finding: 'curl and wget user:password values',
      yaml: [
        'services:',
        '  curl:',
        '    image: example',
        '    command: curl -u admin:CurlShellSentinel https://host:8080/x',
        '  curlquoted:',
        '    image: example',
        '    command: curl --user "admin:Two CurlQuotedSentinel" https://x',
        '  wget:',
        '    image: example',
        '    command: [wget, "--user=admin:WgetEqualsSentinel", https://x]',
        '  curllist:',
        '    image: example',
        '    command: [curl, -u, "admin:CurlListSentinel", https://x]',
        '  curlplain:',
        '    image: example',
        '    command: curl -u admin https://host:8080/x',
        '  image-user:',
        '    image: example',
        '    command: docker run -u root:rootgroup curlimage/curl https://x',
        `x-json: '{"command":["curl","-u","admin:JsonCurlSentinel","https://x"]}'`,
        'x-copy-shell: CurlShellSentinel',
        'x-copy-quoted: Two CurlQuotedSentinel',
        'x-copy-wget: WgetEqualsSentinel',
        'x-copy-list: CurlListSentinel',
        'x-copy-json: JsonCurlSentinel',
        'x-user: admin',
        'x-group: rootgroup',
      ],
      absent: [
        'CurlShellSentinel',
        'CurlQuotedSentinel',
        'WgetEqualsSentinel',
        'CurlListSentinel',
        'JsonCurlSentinel',
      ],
      expected: [
        [['services', 'curlplain', 'command'], 'curl -u admin https://host:8080/x'],
        [['x-json'], '{"command":["curl","-u","********","https://x"]}'],
        [['x-copy-list'], '********'],
        [['x-user'], 'admin'],
        // A user and group beside an image named like curl are not a password.
        [['x-group'], 'rootgroup'],
      ],
    },
    {
      finding: 'host-qualified port mappings beside a user flag',
      yaml: [
        'services:',
        '  run:',
        '    image: example',
        '    command: docker run -u 1000 -p 127.0.0.1:8080:80 -p "[::1]:8081:80" -p 8082:80/tcp image',
        '  runlist:',
        '    image: example',
        '    command: [docker, run, -u, "1000", -p, "0.0.0.0::8083"]',
        '  login:',
        '    image: example',
        '    command: [mongosh, -u, root, -p, "Pass:WordSentinel"]',
        'x-bind: 127.0.0.1:8080:80',
        "x-bind6: '[::1]:8081:80'",
        'x-proto: 8082:80/tcp',
        'x-any: 0.0.0.0::8083',
        'x-copy-password: Pass:WordSentinel',
      ],
      absent: ['WordSentinel'],
      expected: [
        [['x-bind'], '127.0.0.1:8080:80'],
        [['x-bind6'], '[::1]:8081:80'],
        [['x-proto'], '8082:80/tcp'],
        [['x-any'], '0.0.0.0::8083'],
        [['x-copy-password'], '********'],
      ],
    },
    {
      finding: 'a test key outside a healthcheck',
      yaml: [
        'services:',
        '  rocketchat:',
        '    image: example',
        '    healthcheck:',
        '      test: [CMD, client, --password, HealthTestSentinel]',
        'x-healthcheck: &default',
        '  test: [CMD, client, --password, AnchoredTestSentinel]',
        'x-chart:',
        '  checks:',
        '    test: [--password, ExpectedOutputSentinel]',
        'x-copy-health: HealthTestSentinel',
        'x-copy-anchored: AnchoredTestSentinel',
        'x-copy-chart: ExpectedOutputSentinel',
      ],
      absent: ['HealthTestSentinel', 'AnchoredTestSentinel'],
      expected: [
        [['services', 'rocketchat', 'healthcheck', 'test'], '********'],
        [['x-healthcheck', 'test'], '********'],
        [['x-chart'], { checks: { test: ['--password', 'ExpectedOutputSentinel'] } }],
        [['x-copy-chart'], 'ExpectedOutputSentinel'],
      ],
    },
    {
      finding: 'a double-quoted line continuation',
      yaml: [
        'services:',
        '  continued:',
        '    image: example',
        String.raw`    command: "client --password \"Dq\\\nContinuedSentinel\" --verbose"`,
        'x-copy: DqContinuedSentinel',
        'x-control: readable',
      ],
      absent: ['DqContinuedSentinel'],
      expected: [
        [['services', 'continued', 'command'], '********'],
        [['x-copy'], '********'],
        [['x-control'], 'readable'],
      ],
    },
    {
      finding: 'a short -p beside a user flag in an embedded JSON array',
      yaml: [
        `x-json: '{"command":["mongosh","-u","root","-p","TopSecretJsonSentinel"]}'`,
        `x-port-json: '{"command":["python","-u","app.py","-p","8080"]}'`,
        `x-mkdir-json: '{"command":["mkdir","-p","/data/db"]}'`,
        'x-copy: TopSecretJsonSentinel',
        'x-port: 8080',
      ],
      absent: ['TopSecretJsonSentinel'],
      expected: [
        [['x-json'], '{"command":["mongosh","-u","root","-p","********"]}'],
        [['x-port-json'], '{"command":["python","-u","app.py","-p","8080"]}'],
        [['x-mkdir-json'], '{"command":["mkdir","-p","/data/db"]}'],
        [['x-copy'], '********'],
        [['x-port'], 8080],
      ],
    },
    {
      finding: 'an option whose name only contains a credential word',
      yaml: [
        'services:',
        '  browser:',
        '    image: example',
        '    command: chromium --proxy-bypass-list=localhost --headless',
        '  browserlist:',
        '    image: example',
        '    command: [chromium, --proxy-bypass-list, internal.example.test, --compass, --headless]',
        '  joined:',
        '    image: example',
        '    command: [client, --rootpassword, JoinedPasswordSentinel]',
        '  keyed:',
        '    image: example',
        '    command: [client, --ssh-key, SshKeySentinel]',
        'x-host: localhost',
        'x-internal: internal.example.test',
        'x-copy-joined: JoinedPasswordSentinel',
        'x-copy-keyed: SshKeySentinel',
      ],
      absent: ['JoinedPasswordSentinel', 'SshKeySentinel'],
      expected: [
        [['services', 'browser', 'command'], 'chromium --proxy-bypass-list=localhost --headless'],
        [
          ['services', 'browserlist', 'command'],
          ['chromium', '--proxy-bypass-list', 'internal.example.test', '--compass', '--headless'],
        ],
        [['services', 'joined', 'command'], '********'],
        [['x-host'], 'localhost'],
        [['x-internal'], 'internal.example.test'],
      ],
    },
    {
      finding: 'compound credential options such as -passin and --secretkey',
      yaml: [
        'services:',
        '  openssl:',
        '    image: example',
        '    command: openssl rsa -in k.pem -passin pass:PassinSentinel',
        '  out:',
        '    image: example',
        '    command: [openssl, pkcs12, -passout, "pass:PassoutSentinel"]',
        '  skey:',
        '    image: example',
        '    command: [client, --secretkey, SecretkeySentinel]',
        '  akey:',
        '    image: example',
        '    command: [client, --secretaccesskey, SecretAccessKeySentinel]',
        '  db:',
        '    image: example',
        '    command: [client, --dbpass, DbpassSentinel, --adminpass=AdminpassSentinel]',
        '  root:',
        '    image: example',
        '    command: client --rootpass RootpassSentinel --userpass=UserpassSentinel',
        '  code:',
        '    image: example',
        '    command: [client, --passcode, PasscodeSentinel]',
        '  proxy:',
        '    image: example',
        '    command: [chromium, --proxy-bypass-list, internal.example.test, --bypass, --compass]',
        `x-json: '{"command":["client","--secretkey","JsonSecretkeySentinel"]}'`,
        'x-copy-secretkey: SecretkeySentinel',
        'x-copy-dbpass: DbpassSentinel',
        'x-copy-passcode: PasscodeSentinel',
        'x-internal: internal.example.test',
      ],
      absent: [
        'PassinSentinel',
        'PassoutSentinel',
        'SecretkeySentinel',
        'SecretAccessKeySentinel',
        'DbpassSentinel',
        'AdminpassSentinel',
        'RootpassSentinel',
        'UserpassSentinel',
        'PasscodeSentinel',
        'JsonSecretkeySentinel',
      ],
      expected: [
        [['services', 'openssl', 'command'], '********'],
        [['services', 'skey', 'command'], '********'],
        [['services', 'root', 'command'], '********'],
        [['x-json'], '{"command":["client","--secretkey","********"]}'],
        [['x-copy-secretkey'], '********'],
        [
          ['services', 'proxy', 'command'],
          ['chromium', '--proxy-bypass-list', 'internal.example.test', '--bypass', '--compass'],
        ],
        [['x-internal'], 'internal.example.test'],
      ],
    },
    {
      finding: 'an alias revisited under its healthcheck key',
      yaml: [
        'x-hc: &hc',
        '  test: [CMD, client, --password, AliasHealthSentinel]',
        'services:',
        '  web:',
        '    image: example',
        '    healthcheck: *hc',
        'x-copy: AliasHealthSentinel',
        'x-control: readable',
      ],
      absent: ['AliasHealthSentinel'],
      expected: [
        [['x-hc'], { test: ['CMD', 'client', '--password', '********'] }],
        [['x-copy'], '********'],
        [['x-control'], 'readable'],
      ],
    },
    {
      finding: 'curl long options that begin with -u',
      yaml: [
        'services:',
        '  url:',
        '    image: example',
        '    command: curl --url=https://host/path --silent',
        '  urllist:',
        '    image: example',
        '    command: [curl, "--url=https://host/path", --upload-file, "a:b"]',
        '  attached:',
        '    image: example',
        '    command: curl -uadmin:AttachedUserSentinel https://host/path',
        'x-url: https://host/path',
        'x-path: //host/path',
        'x-copy: AttachedUserSentinel',
      ],
      absent: ['AttachedUserSentinel'],
      expected: [
        [['services', 'url', 'command'], 'curl --url=https://host/path --silent'],
        [
          ['services', 'urllist', 'command'],
          ['curl', '--url=https://host/path', '--upload-file', 'a:b'],
        ],
        [['services', 'attached', 'command'], '********'],
        [['x-url'], 'https://host/path'],
        [['x-path'], '//host/path'],
        [['x-copy'], '********'],
      ],
    },
    {
      finding: 'curl proxy-user credentials',
      yaml: [
        'services:',
        '  shell:',
        '    image: example',
        '    command: curl --proxy-user admin:ProxyShellSentinel https://host',
        '  short:',
        '    image: example',
        '    command: [curl, -U, "admin:ProxyListSentinel", https://host]',
        '  equals:',
        '    image: example',
        '    command: curl --proxy-user=admin:ProxyEqualsSentinel https://host',
        '  attached:',
        '    image: example',
        '    command: curl -Uadmin:ProxyAttachedSentinel https://host',
        '  nocolon:',
        '    image: example',
        '    command: curl --proxy-user admin https://host',
        '  agent:',
        '    image: example',
        '    command: wget -U "Mozilla/5.0 (X11; a:b)" https://host',
        `x-json: '{"command":["curl","--proxy-user","admin:ProxyJsonSentinel","https://x"]}'`,
        'x-copy-shell: ProxyShellSentinel',
        'x-copy-list: ProxyListSentinel',
        'x-copy-json: ProxyJsonSentinel',
        'x-user: admin',
      ],
      absent: [
        'ProxyShellSentinel',
        'ProxyListSentinel',
        'ProxyEqualsSentinel',
        'ProxyAttachedSentinel',
        'ProxyJsonSentinel',
      ],
      expected: [
        [['services', 'shell', 'command'], '********'],
        [['services', 'short', 'command'], '********'],
        [['services', 'nocolon', 'command'], 'curl --proxy-user admin https://host'],
        [['services', 'agent', 'command'], 'wget -U "Mozilla/5.0 (X11; a:b)" https://host'],
        [['x-json'], '{"command":["curl","--proxy-user","********","https://x"]}'],
        [['x-copy-list'], '********'],
        [['x-user'], 'admin'],
      ],
    },
    {
      finding: 'a credential flag named only in a shell comment',
      yaml: [
        'services:',
        '  quoted:',
        '    image: example',
        `    command: 'sh -c "echo ok # client --password CommentQuotedSentinel"'`,
        '  block:',
        '    image: example',
        '    command: |',
        '      echo start',
        '      # client --password CommentBlockSentinel',
        '      client --password RealBlockSentinel',
        '  word:',
        '    image: example',
        '    command: sh -c "client --password Real#HashSentinel"',
        'x-copy-quoted: CommentQuotedSentinel',
        'x-copy-block: CommentBlockSentinel',
        'x-copy-real: RealBlockSentinel',
        'x-copy-hash: Real#HashSentinel',
      ],
      absent: ['RealBlockSentinel', 'Real#HashSentinel'],
      expected: [
        [['x-copy-quoted'], 'CommentQuotedSentinel'],
        [['x-copy-block'], 'CommentBlockSentinel'],
        [['x-copy-real'], '********'],
        [['x-copy-hash'], '********'],
      ],
    },
    {
      finding: 'an Authorization header in command arguments',
      yaml: [
        'services:',
        '  shell:',
        '    image: example',
        `    command: "curl -H 'Authorization: Bearer HeaderShellSecret' https://host"`,
        '  wget:',
        '    image: example',
        `    command: 'wget --header "Authorization: Basic HeaderWgetSecret" https://host'`,
        '  list:',
        '    image: example',
        '    command: [curl, -H, "Authorization: Bearer HeaderListSecret", https://host]',
        '  proxy:',
        '    image: example',
        '    command: [curl, "--header=Proxy-Authorization: Bearer HeaderProxySecret", https://host]',
        '  plain:',
        '    image: example',
        `    command: 'curl -H "Content-Type: application/json" -H "Accept: text/plain" https://host'`,
        '  plainlist:',
        '    image: example',
        '    command: [curl, -H, "X-Request-Id: abc123", https://host]',
        `x-json: '{"command":["curl","-H","Authorization: Bearer HeaderJsonSecret","https://x"]}'`,
        'x-copy-shell: HeaderShellSecret',
        'x-copy-bearer: Bearer HeaderListSecret',
        'x-copy-wget: HeaderWgetSecret',
        'x-copy-json: HeaderJsonSecret',
        'x-content: application/json',
        'x-id: abc123',
      ],
      absent: [
        'HeaderShellSecret',
        'HeaderWgetSecret',
        'HeaderListSecret',
        'HeaderProxySecret',
        'HeaderJsonSecret',
      ],
      expected: [
        [['services', 'shell', 'command'], '********'],
        [['services', 'wget', 'command'], '********'],
        [['services', 'list', 'command'], '********'],
        [['services', 'proxy', 'command'], '********'],
        [
          ['services', 'plain', 'command'],
          'curl -H "Content-Type: application/json" -H "Accept: text/plain" https://host',
        ],
        [
          ['services', 'plainlist', 'command'],
          ['curl', '-H', 'X-Request-Id: abc123', 'https://host'],
        ],
        [['x-copy-shell'], '********'],
        [['x-copy-bearer'], '********'],
        [['x-copy-json'], '********'],
        [['x-content'], 'application/json'],
        [['x-id'], 'abc123'],
      ],
    },
  ])(
    'masks command credentials without masking neighbours: $finding',
    async ({ finding, yaml, absent, expected }) => {
      const { compose } = await bundledCompose(
        `e7-${finding.replace(/[^a-z]+/gu, '-').slice(0, 24)}`,
        [...yaml, ''].join('\n'),
      );
      for (const sentinel of absent) expect(compose).not.toContain(sentinel);
      const parsed = YAML.parse(compose) as Record<string, unknown>;
      for (const [keys, value] of expected) expect(pick(parsed, ...keys)).toEqual(value);
    },
  );

  it('discovers credential arguments in embedded JSON argument arrays', async () => {
    const embedded =
      '{"command":["client","--password","JsonArgumentSentinel","--port","27017"],"entrypoint":["client","--reg-token","JsonRegArgumentSentinel"],"args":["client","--password","JsonArgsSentinel"],"healthcheck":{"test":["CMD","client","--password","JsonTestSentinel"]},"keep":1.50,"notes":["--password","NotCommandSentinel"]}';
    const masked =
      '{"command":["client","--password","********","--port","27017"],"entrypoint":["client","--reg-token","********"],"args":["client","--password","********"],"healthcheck":{"test":["CMD","client","--password","********"]},"keep":1.50,"notes":["--password","NotCommandSentinel"]}';
    const { compose } = await bundledCompose(
      'e7-argv-json',
      [
        'x-before-json: JsonArgumentSentinel',
        'x-before-reg: JsonRegArgumentSentinel',
        'x-before-args: JsonArgsSentinel',
        'x-before-test: JsonTestSentinel',
        `x-json: '${embedded}'`,
        'x-port: 27017',
        'x-replica: rocketchat-1',
        'x-control: readable',
        '',
      ].join('\n'),
    );
    for (const secret of [
      'JsonArgumentSentinel',
      'JsonRegArgumentSentinel',
      'JsonArgsSentinel',
      'JsonTestSentinel',
    ])
      expect(compose).not.toContain(secret);
    const parsed = YAML.parse(compose) as Record<string, unknown>;
    expect(parsed['x-json']).toBe(masked);
    expect(parsed['x-port']).toBe(27017);
    expect(parsed['x-replica']).toBe('rocketchat-1');
    expect(compose).toContain('NotCommandSentinel');
  });

  it('discovers a credential argument reached through a YAML alias', async () => {
    const { compose } = await bundledCompose(
      'e7-argv-alias',
      [
        'x-before: AliasArgumentSentinel',
        'x-argv: &argv [client, --password, AliasArgumentSentinel]',
        'services:',
        '  rocketchat:',
        '    image: example',
        '    command: *argv',
        'x-after: AliasArgumentSentinel',
        'x-port: 27017',
        'x-control: readable',
        '',
      ].join('\n'),
    );
    expect(compose).not.toContain('AliasArgumentSentinel');
    const parsed = YAML.parse(compose) as Record<string, unknown>;
    // The anchor renders as a list; its second appearance is masked whole as a repeated object.
    expect(parsed['x-argv']).toEqual(['client', '--password', '********']);
    expect(parsed['x-port']).toBe(27017);
    expect(parsed['x-control']).toBe('readable');
  });

  it('keeps a numeric credential argument whole, never erasing ports or replica suffixes', async () => {
    const { compose } = await bundledCompose(
      'e7-argv-numeric',
      [
        'x-before: 7',
        'x-lexical-before: "4.50"',
        'x-lexical-canonical: 4.5',
        'services:',
        '  rocketchat:',
        '    image: example',
        '    command:',
        '      - client',
        '      - --password',
        '      - 7',
        '      - --port',
        '      - 27017',
        '    entrypoint: [client, --reg-token, "4.50", --port, "27017"]',
        'x-port: 27017',
        'x-replica: rocketchat-7',
        'x-lexical-replica: rocketchat-4.50',
        'x-embedded: \'{ "keep":27017, "decimal":1.50, "copy":"7", "lexical":"4.50" }\'',
        'x-control: readable',
        '',
      ].join('\n'),
    );
    const parsed = YAML.parse(compose) as Record<string, unknown>;
    expect(pick(parsed, 'services', 'rocketchat', 'command')).toBe('********');
    expect(pick(parsed, 'services', 'rocketchat', 'entrypoint')).toBe('********');
    expect(parsed['x-before']).toBe('********');
    expect(parsed['x-lexical-before']).toBe('********');
    expect(parsed['x-lexical-canonical']).toBe('********');
    expect(parsed['x-port']).toBe(27017);
    expect(parsed['x-replica']).toBe('rocketchat-7');
    expect(parsed['x-lexical-replica']).toBe('rocketchat-4.50');
    expect(parsed['x-embedded']).toBe(
      '{ "keep":27017, "decimal":1.50, "copy":"********", "lexical":"********" }',
    );
    expect(parsed['x-control']).toBe('readable');
  });

  it.each(['yaml', 'assignment', 'json', 'named', 'alias', 'nested-json'])(
    'keeps numeric text credentials whole through %s discovery in actual bundles',
    async (origin) => {
      // Each route is isolated: another credential representation must not supply its match class.
      for (const spelling of ['7', '+7', '-0', '4.50', '2E3', '0x7', '0o7', '.inf', '.nan']) {
        const name = `e7-numeric-${origin}`;
        const json = JSON.stringify({ password: spelling });
        const sources: Record<string, string> = {
          yaml: `x-password: ${JSON.stringify(spelling)}`,
          assignment: `x-list: [${JSON.stringify(`DB_PASSWORD=${spelling}`)}]`,
          json: `x-source: ${JSON.stringify(json)}`,
          named: `x-pair: {value: ${JSON.stringify(spelling)}, name: DB_PASSWORD}`,
          alias: `x-alias: &numeric ${JSON.stringify(spelling)}\nx-password: *numeric`,
          'nested-json': `x-source: ${JSON.stringify(JSON.stringify({ payload: JSON.stringify({ value: spelling, name: 'DB_PASSWORD' }) }))}`,
        };
        const canonical: Record<string, string> = {
          '+7': '7',
          '-0': '0',
          '4.50': '4.5',
          '2E3': '2000',
          '0x7': '7',
          '0o7': '7',
        };
        const copied = `{ "keep":27017, "decimal":1.50, "exponent":2E4, "copy":${JSON.stringify(spelling)} }`;
        const doc = [
          `x-copy: ${JSON.stringify(spelling)}`,
          `x-canonical-copy: ${canonical[spelling] ?? spelling}`,
          `x-embedded-copy: ${JSON.stringify(copied)}`,
          'x-port: 27017',
          `x-service: ${JSON.stringify(`rocketchat-${spelling}`)}`,
          sources[origin],
          'x-long-password: LongCredentialSentinel',
          'x-long-copy: prefix-LongCredentialSentinel-suffix',
          'x-control: readable',
          '',
        ].join('\n');
        await workspaceNamed(name, {}, {}, doc);
        const dest = path.join(workspace(name), 'out', `bundle-${spelling}`);
        await collect(name, { bundle: dest });
        const text = fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8');
        const parsed = YAML.parse(text) as Record<string, unknown>;
        expect(parsed['x-port']).toBe(27017);
        expect(parsed['x-service']).toBe(`rocketchat-${spelling}`);
        expect(parsed['x-copy']).toBe('********');
        expect(parsed['x-canonical-copy']).toBe('********');
        expect(parsed['x-embedded-copy']).toBe(
          '{ "keep":27017, "decimal":1.50, "exponent":2E4, "copy":"********" }',
        );
        expect(parsed['x-long-copy']).toBe('prefix-********-suffix');
        expect(parsed['x-control']).toBe('readable');
        expect(text).not.toContain('LongCredentialSentinel');
      }
    },
  );

  it('bounds cyclic YAML aliases while still masking credentials discovered through aliases', async () => {
    const name = 'e7-cycle-credentials';
    await workspaceNamed(
      name,
      {},
      {},
      [
        'x-first: &secret {value: CycleCopySentinel}',
        'x-cycle: &cycle [*cycle]',
        'x-password: *secret',
        'x-before-copy: CycleCopySentinel',
        'x-control: readable',
        '',
      ].join('\n'),
    );
    const dest = path.join(workspace(name), 'out', 'bundle');
    await writeBundle(name, dest, await record(name));
    const text = fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8');
    expect(text).not.toContain('CycleCopySentinel');
    const parsed = YAML.parse(text) as Record<string, unknown>;
    expect(parsed['x-control']).toBe('readable');
    expect(parsed['x-cycle']).toEqual(['********']);
  });

  it('resolves credential uncertainty at real env-file and replica boundaries', async () => {
    const cases: {
      env?: Record<string, unknown> | string[];
      files?: [string, string][];
      refs?: unknown[];
      services?: Record<string, unknown>;
      supplied: boolean | null;
      source: string | null;
    }[] = [
      { env: ['REG_TOKEN'], supplied: null, source: 'unknown' },
      { env: { REG_TOKEN: null }, supplied: false, source: null },
      { env: { REG_TOKEN: '' }, supplied: false, source: null },
      { env: { REG_TOKEN: '$$literal' }, supplied: true, source: 'reg_token' },
      {
        env: { ROCKETCHAT_LICENSE: '${LICENCE}', REG_TOKEN: 'literal' },
        supplied: true,
        source: 'unknown',
      },
      {
        env: { ROCKETCHAT_LICENSE: 'literal', REG_TOKEN: '${TOKEN}' },
        supplied: true,
        source: 'license',
      },
      {
        refs: ['creds.env'],
        files: [['creds.env', 'REG_TOKEN=${TOKEN:-fallback}\n']],
        supplied: null,
        source: 'unknown',
      },
      {
        refs: ['creds.env'],
        files: [['creds.env', "REG_TOKEN='${TOKEN}'\n"]],
        supplied: true,
        source: 'reg_token',
      },
      {
        refs: [{ path: 'creds.env', format: 'raw' }],
        files: [['creds.env', 'REG_TOKEN=${TOKEN}\n']],
        supplied: true,
        source: 'reg_token',
      },
      {
        refs: ['earlier.env', 'later.env'],
        files: [
          ['earlier.env', 'REG_TOKEN=literal\n'],
          ['later.env', 'REG_TOKEN=${TOKEN:+alt}\n'],
        ],
        supplied: null,
        source: 'unknown',
      },
      {
        refs: ['earlier.env', 'later.env'],
        files: [
          ['earlier.env', 'REG_TOKEN=${TOKEN}\n'],
          ['later.env', 'REG_TOKEN\n'],
        ],
        supplied: false,
        source: null,
      },
      { refs: ['${ENV_FILE}'], supplied: null, source: 'unknown' },
      { refs: [{ path: 'missing.env', required: false }], supplied: false, source: null },
      {
        services: {
          'rocketchat-1': { environment: { REG_TOKEN: 'literal' } },
          'rocketchat-2': { environment: { REG_TOKEN: '${TOKEN}' } },
        },
        supplied: true,
        source: 'reg_token',
      },
      {
        services: {
          'rocketchat-1': { environment: { ROCKETCHAT_LICENSE: 'literal' } },
          'rocketchat-2': { environment: { ROCKETCHAT_LICENSE: '${LICENCE}' } },
        },
        supplied: null,
        source: 'unknown',
      },
    ];
    for (const [index, example] of cases.entries()) {
      const name = `e3-uncertain-files-${index}`;
      await workspaceNamed(
        name,
        {},
        {},
        YAML.stringify({
          services: example.services ?? {
            rocketchat: { environment: example.env ?? {}, env_file: example.refs ?? [] },
          },
        }),
      );
      for (const [file, text] of example.files ?? [])
        fs.writeFileSync(path.join(workspace(name), file), text);
      const evidence = await record(name);
      if (example.supplied === null)
        expect(renderMarkdown(evidence)).toContain(
          'unknown (credential presence could not be determined)',
        );
      else if (example.source === 'unknown')
        expect(renderMarkdown(evidence)).toContain('credential supplied (type unknown)');
      expect([index, evidence.license]).toEqual([
        index,
        { required: false, supplied: example.supplied, source: example.source },
      ]);
    }
  });

  it('retains unknown credential presence through evidence and environment mutation', async () => {
    const values = [
      '${TOKEN}',
      '$TOKEN',
      '${TOKEN:-fallback}',
      '${TOKEN-fallback}',
      '${TOKEN:+alternate}',
      '${TOKEN?required}',
    ];
    for (const [index, value] of values.entries()) {
      const name = `e3-interpolation-${index}`;
      await workspaceNamed(
        name,
        {},
        {},
        YAML.stringify({ services: { rocketchat: { environment: { REG_TOKEN: value } } } }),
      );
      expect((await record(name)).license).toMatchObject({ supplied: null, source: 'unknown' });
    }
    const name = 'e3-marker-interpolation';
    await workspaceNamed(
      name,
      { reg_token_supplied: false },
      {},
      YAML.stringify({ services: { rocketchat: { environment: {} } } }),
    );
    await setEnvLocked(name, { REG_TOKEN: '${TOKEN}' }, []);
    expect((await readMeta(name)).extra.reg_token_supplied).toBeNull();
    expect((await record(name)).license).toMatchObject({ supplied: null, source: 'unknown' });
    await setEnvLocked(name, { PORT: '3001' }, []);
    expect((await record(name)).license).toMatchObject({ supplied: null, source: 'unknown' });
    await setEnvLocked(name, { REG_TOKEN: '$$literal' }, []);
    expect((await record(name)).license).toMatchObject({ supplied: true, source: 'reg_token' });
    await setEnvLocked(name, {}, ['REG_TOKEN']);
    expect((await record(name)).license).toMatchObject({ supplied: false, source: null });
  });

  it('redacts URL userinfo before treating a Compose value as KEY=VALUE', async () => {
    const name = 'e7-compose-url-userinfo';
    await workspaceNamed(name);
    fs.writeFileSync(
      path.join(workspace(name), 'docker-compose.yml'),
      [
        'x-reference:',
        '  "https://reader:ComposeKeySentinel@example.test?mode=read": diagnostic',
        '  "https://:EmptyUserKeySentinel@example.test?mode=read": diagnostic',
        '  "https://reader:Raw@AtKeySentinel@example.test?mode=read": diagnostic',
        'list-environment:',
        '  - APP_URL=https://reader:ListRaw@AtValueSentinel@example.test/?q=a=b',
        '  - PORT=3000',
        '  - MONGO_URL=https://reader:ListMongoUrlSentinel@example.test/?q=a=b',
        '  - HOOK_URL=https://ListBearerSentinel@example.test/hook',
        '  - PUNCT_LIST=https://u:List[Punct]SecretSentinel@example.test/x',
        `  - 'OIDC_PAIR={"url":"https://idp.example","admin":"ops@example.com"}'`,
        `  - 'INITIAL_USER_PAIR={"password":"JsonPairSentinel","username":"ops"}'`,
        `  - 'NESTED_CFG={"inner":"{\\"secret\\":\\"JsonNestedSentinel\\"}"}'`,
        '  - JWTKey=JwtListSentinel',
        `  - 'EXTRA_PAIR=[{"name":"SMTP_PASSWORD","value":"JsonPairNamedSentinel"},"ADMIN_EMAIL=ops@x.example"]'`,
        COMPOSE.replace(
          'MONGO_URL: mongodb://rocket:MongoUrlSecret@mongodb:27017/rocketchat',
          [
            'MONGO_URL: mongodb://rocket:ComposeQuerySentinel@mongodb:27017/rocketchat?replicaSet=rs0',
            '      SERVICE_URL: postgresql://reader:Compose=PasswordSentinel@db:5432/rocketchat',
            '      EMPTY_USER_URL: https://:EmptyUserValueSentinel@example.test/?q=a=b',
            '      RAW_AT_URL: https://reader:Raw@AtValueSentinel@example.test/?q=a=b',
            '      BEARER_URL: https://BearerOnlySentinel@example.test/x',
            '      GIT_URL: https://GitTokenSentinel:x-oauth-basic@github.com/org/repo.git',
            `      OIDC_CONFIG: '{"url":"https://idp.example","admin":"ops@example.com"}'`,
            `      OIDC_LIST: '["https://a.example","ops@example.com"]'`,
            '      BLANK_SECOND_URL: https://EmptyPasswordSentinel:@example.test',
            '      PUNCT_URL: "mongodb://rc:Punct{a}^|SecretSentinel@mongo/rc"',
            '      BRACE_USER_URL: "https://Brace{TokenSentinel@example.test/x"',
            `      QUOTE_URL: 'https://u:Quote"SecretSentinel@example.test'`,
            `      OIDC_IDP_CONFIG: '{"url":"https://u:Json{SecretSentinel@idp","admin":"ops@example.com"}'`,
            `      INITIAL_USER: '{"_id":"u1","username":"ops","email":"ops@x.example","password":"JsonPasswordSentinel"}'`,
            `      OAUTH_CFG: '{"client_secret":"JsonClientSecretSentinel", "nested":{"apiKey":1234567,"token":["JsonListSentinel",{"a":true}],"keycloakUrl":"https://kc.example"},"hosts":[1.0,"ops@x.example"]}'`,
            `      EXTRA_ENV: '["PORT=3000","DB_PASSWORD=JsonKvSentinel"]'`,
            `      EXTRA_LIST: '[{"name":"DB_PASSWORD","value":"JsonNameValueSentinel"},{"value":"JsonValueFirstSentinel","name":"client_secret"}, {"name":"LOG_LEVEL", "value": 1.50},{"name":"api_token","value":{"id":7,"key":"JsonNamedObjectSentinel"}}]'`,
            `      NESTED_LIST: '{"cfg":"[\\"DB_PASSWORD=JsonNestedKvSentinel\\"]"}'`,
          ].join('\n'),
        ),
        '',
      ].join('\n'),
    );
    const rec = await record(name);
    const dest = path.join(workspace(name), 'out', 'bundle');

    await writeBundle(name, dest, rec);

    const artifact = fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8');
    expect(artifact).not.toContain('ComposeQuerySentinel');
    expect(artifact).not.toContain('Compose=PasswordSentinel');
    expect(artifact).not.toContain('ComposeKeySentinel');
    expect(artifact).not.toContain('EmptyUserKeySentinel');
    expect(artifact).not.toContain('Raw@AtKeySentinel');
    expect(artifact).not.toContain('EmptyUserValueSentinel');
    expect(artifact).not.toContain('Raw@AtValueSentinel');
    expect(artifact).not.toContain('ListRaw@AtValueSentinel');
    expect(artifact).not.toContain('ListMongoUrlSentinel');
    expect(artifact).not.toContain('BearerOnlySentinel');
    expect(artifact).not.toContain('GitTokenSentinel');
    expect(artifact).not.toContain('EmptyPasswordSentinel');
    expect(artifact).not.toContain('ListBearerSentinel');
    expect(artifact).not.toContain('SecretSentinel');
    expect(artifact).not.toContain('TokenSentinel');
    expect(artifact).not.toContain('JsonPasswordSentinel');
    expect(artifact).not.toContain('JsonListSentinel');
    expect(artifact).not.toContain('1234567');
    expect(artifact).not.toContain('JsonPairSentinel');
    expect(artifact).not.toContain('JsonNestedSentinel');
    expect(artifact).not.toContain('JwtListSentinel');
    expect(artifact).not.toContain('JsonPairNamedSentinel');
    expect(artifact).not.toContain('JsonKvSentinel');
    expect(artifact).not.toContain('JsonNameValueSentinel');
    expect(artifact).not.toContain('JsonValueFirstSentinel');
    expect(artifact).not.toContain('JsonNamedObjectSentinel');
    expect(artifact).not.toContain('JsonNestedKvSentinel');
    const rendered = YAML.parse(artifact) as {
      services: { rocketchat: { environment: Record<string, string> } };
      'x-reference': Record<string, string>;
      'list-environment': string[];
    };
    expect(rendered.services.rocketchat.environment.OIDC_CONFIG).toBe(
      '{"url":"https://idp.example","admin":"ops@example.com"}',
    );
    expect(rendered.services.rocketchat.environment.OIDC_LIST).toBe(
      '["https://a.example","ops@example.com"]',
    );
    expect(rendered.services.rocketchat.environment.MONGO_URL).toBe(
      'mongodb://********@mongodb:27017/rocketchat?replicaSet=rs0',
    );
    expect(rendered.services.rocketchat.environment.SERVICE_URL).toBe(
      'postgresql://********@db:5432/rocketchat',
    );
    expect(rendered.services.rocketchat.environment.EMPTY_USER_URL).toBe(
      'https://********@example.test/?q=a=b',
    );
    expect(rendered.services.rocketchat.environment.RAW_AT_URL).toBe(
      'https://********@example.test/?q=a=b',
    );
    expect(rendered.services.rocketchat.environment.BEARER_URL).toBe(
      'https://********@example.test/x',
    );
    expect(rendered.services.rocketchat.environment.BLANK_SECOND_URL).toBe(
      'https://********@example.test',
    );
    expect(rendered.services.rocketchat.environment.PUNCT_URL).toBe('mongodb://********@mongo/rc');
    expect(rendered.services.rocketchat.environment.BRACE_USER_URL).toBe(
      'https://********@example.test/x',
    );
    expect(rendered.services.rocketchat.environment.QUOTE_URL).toBe(
      'https://********@example.test',
    );
    expect(rendered.services.rocketchat.environment.OIDC_IDP_CONFIG).toBe(
      '{"url":"https://********@idp","admin":"ops@example.com"}',
    );
    // A credential member of a JSON value is masked as the same key in YAML would be, every
    // scalar below it included; the other members keep their bytes.
    expect(rendered.services.rocketchat.environment.INITIAL_USER).toBe(
      '{"_id":"u1","username":"ops","email":"ops@x.example","password":"********"}',
    );
    expect(rendered.services.rocketchat.environment.OAUTH_CFG).toBe(
      '{"client_secret":"********", "nested":{"apiKey":"********","token":["********",{"a":"********"}],' +
        '"keycloakUrl":"https://kc.example"},"hosts":[1.0,"ops@x.example"]}',
    );
    // A JSON `KEY=VALUE` string, and the `value` beside a credential `name` in either order,
    // are masked as the same YAML list entry and mapping are; a benign one keeps its bytes.
    expect(rendered.services.rocketchat.environment.EXTRA_ENV).toBe(
      '["PORT=3000","DB_PASSWORD=********"]',
    );
    expect(rendered.services.rocketchat.environment.EXTRA_LIST).toBe(
      '[{"name":"DB_PASSWORD","value":"********"},{"value":"********","name":"client_secret"}, ' +
        '{"name":"LOG_LEVEL", "value": 1.50},{"name":"api_token","value":{"id":"********","key":"********"}}]',
    );
    expect(rendered.services.rocketchat.environment.NESTED_LIST).toBe(
      '{"cfg":"[\\"DB_PASSWORD=********\\"]"}',
    );
    expect(Object.keys(rendered['x-reference']).sort()).toEqual([
      'https://********@example.test?mode=read',
    ]);
    expect(rendered['list-environment']).toEqual([
      'APP_URL=https://********@example.test/?q=a=b',
      'PORT=3000',
      'MONGO_URL=https://********@example.test/?q=a=b',
      'HOOK_URL=https://********@example.test/hook',
      'PUNCT_LIST=https://********@example.test/x',
      'OIDC_PAIR={"url":"https://idp.example","admin":"ops@example.com"}',
      'INITIAL_USER_PAIR={"password":"********","username":"ops"}',
      'NESTED_CFG={"inner":"{\\"secret\\":\\"********\\"}"}',
      'JWTKey=********',
      'EXTRA_PAIR=[{"name":"SMTP_PASSWORD","value":"********"},"ADMIN_EMAIL=ops@x.example"]',
    ]);
  });

  it('uses the public URL and retains the quoted cleanup command in the README', async () => {
    const name = 'e7-public\n';
    await workspaceNamed(name, {}, { publicUrl: 'https://support.example.test/case?ticket=1234' });
    const rec = await record(name);
    const dest = path.join(workspace(name), 'out', 'bundle');

    await writeBundle(name, dest, rec);

    const readme = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('| URL | https://support.example.test |');
    expect(readme).not.toContain('| URL | http://localhost:3000 |');
    expect(readme).not.toContain('houston capture');
    expect(readme).toContain(`\`\`\`bash\n${cleanupCommand(name)}\n\`\`\``);
  });

  it('redacts credentials in a Kubernetes values artifact', async () => {
    await workspaceNamed('e7-kubernetes', { runtime: 'kubernetes' });
    fs.unlinkSync(path.join(workspace('e7-kubernetes'), 'docker-compose.yml'));
    fs.mkdirSync(path.join(workspace('e7-kubernetes'), 'kubernetes'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace('e7-kubernetes'), 'kubernetes', 'values.yaml'),
      [
        'extraEnv:',
        '  - name: ADMIN_PASS',
        '    value: KubeAdminSecret',
        '  - name: MONGO_URL',
        '    value: mongodb://rocket:KubeMongoUrlSecret@mongodb:27017/rocketchat?replicaSet=rs0',
        '  - name: privateKey',
        '    value: KubeNamedPrivateKeySentinel',
        'tls:',
        '  privateKey: KubeCamelPrivateKeySentinel',
        '  private-key: KubeDashedPrivateKeySentinel',
        '  keycloakUrl: https://kc.example',
        '  monkeyPatch: enabled',
        '  SSHKey: KubeSshKeySentinel',
        '  TLSKey: KubeTlsKeySentinel',
        '  JWTKey: KubeJwtKeySentinel',
        '  HMACKey: KubeHmacKeySentinel',
        '  privatekey: KubeLowerPrivateKeySentinel',
        '  sshkey: KubeLowerSshKeySentinel',
        '  APIKeyId: KubeApiKeyIdSentinel',
        '  KEYCLOAKUrl: https://kc.example',
        '  MONKEYPatch: enabled',
        'listEnvironment:',
        '  - privateKey=KubeListPrivateKeySentinel',
        '  - keycloakUrl=https://kc.example',
        'x-reference:',
        '  "https://reader:KubeKeySentinel@example.test?mode=read": diagnostic',
        'scriptedCommand:',
        '  - /bin/sh',
        '  - -c',
        '  - echo S3cretPass',
        'supportNote: S3cretPass',
        'extraSecret:',
        '  stringData:',
        '    ordinary: S3cretPass',
        '',
      ].join('\n'),
    );
    const rec = await recordKubernetes('e7-kubernetes');
    const dest = path.join(workspace('e7-kubernetes'), 'out', 'bundle');

    const out = await writeBundle('e7-kubernetes', dest, rec);
    const artifact = fs.readFileSync(path.join(dest, 'values.yaml'), 'utf8');

    expect(out.files).toContain('values.yaml');
    expect(artifact).toContain('********');
    expect(artifact).not.toContain('KubeAdminSecret');
    expect(artifact).not.toContain('KubeMongoUrlSecret');
    expect(artifact).not.toContain('KubeKeySentinel');
    expect(artifact).not.toContain('PrivateKeySentinel');
    expect(artifact).not.toContain('KeySentinel');
    expect(artifact).not.toContain('KeyIdSentinel');
    expect(artifact).not.toContain('S3cretPass');
    const rendered = YAML.parse(artifact) as {
      scriptedCommand: string[];
      supportNote: string;
      extraSecret: { stringData: Record<string, string> };
      'x-reference': Record<string, string>;
      tls: Record<string, string>;
      listEnvironment: string[];
    };
    // A key names a credential however it is cased or separated; a key that only contains
    // the letters `key` does not.
    expect(rendered.tls).toEqual({
      privateKey: '********',
      'private-key': '********',
      keycloakUrl: 'https://kc.example',
      monkeyPatch: 'enabled',
      SSHKey: '********',
      TLSKey: '********',
      JWTKey: '********',
      HMACKey: '********',
      privatekey: '********',
      sshkey: '********',
      APIKeyId: '********',
      KEYCLOAKUrl: 'https://kc.example',
      MONKEYPatch: 'enabled',
    });
    expect(rendered.listEnvironment).toEqual([
      'privateKey=********',
      'keycloakUrl=https://kc.example',
    ]);
    expect(rendered.scriptedCommand).toEqual(['/bin/sh', '-c', 'echo ********']);
    expect(rendered.supportNote).toBe('********');
    expect(rendered.extraSecret.stringData.ordinary).toBe('********');
    expect(Object.keys(rendered['x-reference'])).toEqual([
      'https://********@example.test?mode=read',
    ]);
  });

  it.each([
    ['numeric', '246813579', 'supportNote', '246813579'],
    ['boolean', 'true', 'featureEnabled', 'true'],
    ['negative-zero numeric', '-0', 'negativeZero', '-0'],
    ['infinite numeric', '.inf', 'infiniteValue', '.inf'],
    ['not-a-number numeric', '.nan', 'notANumberValue', '.nan'],
    ['null', 'null', 'emptyScalarValue', 'null'],
  ] as const)(
    'redacts a known %s YAML scalar and mapping key',
    async (_kind, adminPassword, field, scalar) => {
      const name = `e7-known-${field.toLowerCase()}`;
      await workspaceNamed(name, {}, { adminPassword });
      fs.writeFileSync(
        path.join(workspace(name), 'docker-compose.yml'),
        [`${scalar}: named-value`, `${field}: ${scalar}`, ''].join('\n'),
      );
      const rec = await record(name);
      const dest = path.join(workspace(name), 'out', 'bundle');

      await writeBundle(name, dest, rec);

      const rendered = YAML.parse(
        fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8'),
      ) as Record<string, unknown>;
      expect(rendered[field]).toBe('********');
      expect(rendered['********']).toBe('********');
    },
  );

  it('refuses to replace an existing bundle root', async () => {
    await workspaceNamed('e8');
    const rec = await record('e8');
    const dest = path.join(workspace('e8'), 'out', 'bundle');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'keep.txt'), 'keep this');

    await expect(writeBundle('e8', dest, rec)).rejects.toThrow(ValidationError);
    expect(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8')).toBe('keep this');
  });

  it('omits an artifact that changed after the evidence record was made', async () => {
    await workspaceNamed('e9-stale');
    const rec = await record('e9-stale');
    fs.writeFileSync(
      path.join(workspace('e9-stale'), 'docker-compose.yml'),
      COMPOSE.replace('S3cretPass', 'ChangedSecret'),
    );
    const dest = path.join(workspace('e9-stale'), 'out', 'bundle');

    const out = await writeBundle('e9-stale', dest, rec);

    expect(out.files).toEqual(['README.md', 'manifest.json']);
    expect(fs.existsSync(path.join(dest, 'docker-compose.yml'))).toBe(false);
  });

  it('collects the manifest and bundle from one snapshot', async () => {
    await workspaceNamed('e9');
    const dest = path.join(workspace('e9'), 'out', 'bundle');
    const payload = await collect('e9', { bundle: dest });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;

    const readme = fs.readFileSync(path.join(dest, 'README.md'), 'utf8');
    expect(readme).toContain(
      'This bundle records workspace metadata and any available configuration.',
    );
    expect(readme).toContain('Runtime deployment was not verified.');
    expect(readme).not.toContain('proves what was deployed');
    expect(manifest.artifact).toMatchObject(payload.artifact as Record<string, unknown>);
    expect(payload.bundle).toEqual({
      path: dest,
      files: expect.arrayContaining(['manifest.json', 'README.md', 'docker-compose.yml']),
    });
    expect(fs.readFileSync(path.join(dest, 'docker-compose.yml'), 'utf8')).not.toContain(
      'S3cretPass',
    );
  });
});
