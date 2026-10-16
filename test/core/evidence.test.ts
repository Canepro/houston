import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import type * as PathsNS from '../../src/core/runner/paths';
import type * as PayloadNS from '../../src/core/lifecycle/payload';
import type * as KubeNamespaceNS from '../../src/core/kube/namespace';
import type * as AdminNS from '../../src/core/lifecycle/admin';

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
    await writeBundle(name, dest, rec);
    expect(fs.readdirSync(dest).sort()).toEqual(['README.md', 'manifest.json']);

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
      supplied: boolean;
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
        supplied: false,
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
