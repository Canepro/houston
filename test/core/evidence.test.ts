import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import type * as PayloadNS from '../../src/core/lifecycle/payload';
import type * as KubeNamespaceNS from '../../src/core/kube/namespace';

jest.mock('../../src/core/lifecycle/payload', () => {
  const actual = jest.requireActual<typeof PayloadNS>('../../src/core/lifecycle/payload');
  return { ...actual, detail: jest.fn(actual.detail) };
});

jest.mock('../../src/core/kube/namespace', () => {
  const actual = jest.requireActual<typeof KubeNamespaceNS>('../../src/core/kube/namespace');
  return { ...actual, namespaceLabels: jest.fn() };
});

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
import { workspace } from '../../src/core/runner/paths';
import { metadata, write } from '../../src/core/runner/record';

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
        source: example.supplied ? 'reg_token' : null,
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
        COMPOSE.replace(
          'MONGO_URL: mongodb://rocket:MongoUrlSecret@mongodb:27017/rocketchat',
          [
            'MONGO_URL: mongodb://rocket:ComposeQuerySentinel@mongodb:27017/rocketchat?replicaSet=rs0',
            '      SERVICE_URL: postgresql://reader:Compose=PasswordSentinel@db:5432/rocketchat',
            '      EMPTY_USER_URL: https://:EmptyUserValueSentinel@example.test/?q=a=b',
            '      RAW_AT_URL: https://reader:Raw@AtValueSentinel@example.test/?q=a=b',
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
    const rendered = YAML.parse(artifact) as {
      services: { rocketchat: { environment: Record<string, string> } };
      'x-reference': Record<string, string>;
      'list-environment': string[];
    };
    expect(rendered.services.rocketchat.environment.MONGO_URL).toBe(
      'mongodb://rocket:********@mongodb:27017/rocketchat?replicaSet=rs0',
    );
    expect(rendered.services.rocketchat.environment.SERVICE_URL).toBe(
      'postgresql://reader:********@db:5432/rocketchat',
    );
    expect(rendered.services.rocketchat.environment.EMPTY_USER_URL).toBe(
      'https://:********@example.test/?q=a=b',
    );
    expect(rendered.services.rocketchat.environment.RAW_AT_URL).toBe(
      'https://reader:********@example.test/?q=a=b',
    );
    expect(Object.keys(rendered['x-reference']).sort()).toEqual([
      'https://:********@example.test?mode=read',
      'https://reader:********@example.test?mode=read',
    ]);
    expect(rendered['list-environment']).toEqual([
      'APP_URL=https://reader:********@example.test/?q=a=b',
      'PORT=3000',
      'MONGO_URL=https://reader:********@example.test/?q=a=b',
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
    expect(artifact).not.toContain('S3cretPass');
    const rendered = YAML.parse(artifact) as {
      scriptedCommand: string[];
      supportNote: string;
      extraSecret: { stringData: Record<string, string> };
      'x-reference': Record<string, string>;
    };
    expect(rendered.scriptedCommand).toEqual(['/bin/sh', '-c', 'echo ********']);
    expect(rendered.supportNote).toBe('********');
    expect(rendered.extraSecret.stringData.ordinary).toBe('********');
    expect(Object.keys(rendered['x-reference'])).toEqual([
      'https://reader:********@example.test?mode=read',
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
