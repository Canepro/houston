import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import type * as PayloadNS from '../../src/core/lifecycle/payload';

jest.mock('../../src/core/lifecycle/payload', () => {
  const actual = jest.requireActual<typeof PayloadNS>('../../src/core/lifecycle/payload');
  return { ...actual, detail: jest.fn(actual.detail) };
});

import * as lifecyclePayload from '../../src/core/lifecycle/payload';
import { ValidationError } from '../../src/lib/errors';
import {
  cleanupCommand,
  collect,
  record,
  resolveRetention,
  safeOrigin,
  writeBundle,
} from '../../src/core/evidence';
import { workspace } from '../../src/core/runner/paths';
import { metadata, write } from '../../src/core/runner/record';

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

async function recordKubernetes(name: string): Promise<Record<string, unknown>> {
  const detail = lifecyclePayload.detail as jest.MockedFunction<typeof lifecyclePayload.detail>;
  detail.mockResolvedValueOnce(KUBERNETES_DETAIL);
  return await record(name);
}

async function workspaceNamed(
  name: string,
  extra: Record<string, unknown> = {},
  fields: Partial<ReturnType<typeof metadata>> = {},
): Promise<void> {
  await write(
    name,
    COMPOSE,
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

  it('records the licence state without the value, and that nothing needed one', async () => {
    await workspaceNamed('e3');
    expect((await record('e3')).license).toEqual({
      required: false,
      supplied: false,
      source: null,
    });
    await workspaceNamed('e3l', { licensed: true });
    expect((await record('e3l')).license).toEqual({
      required: false,
      supplied: true,
      source: 'license',
    });
  });

  it('evaluates every member of a composite preset', async () => {
    await workspaceNamed('e3-composite', { runtime: 'kubernetes' }, { preset: 'email+ldap' });
    expect((await recordKubernetes('e3-composite')).license).toEqual({
      required: true,
      supplied: false,
      source: null,
    });
  });

  it('keeps a persisted pin and the derived Compose project in the evidence', async () => {
    await workspaceNamed('e3-pinned', {}, { pinned: true, project: '' });
    const rec = await record('e3-pinned');
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
        '    value: mongodb://rocket:KubeMongoUrlSecret@mongodb:27017/rocketchat',
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
    expect(artifact).not.toContain('S3cretPass');
    const rendered = YAML.parse(artifact) as {
      scriptedCommand: string[];
      supportNote: string;
      extraSecret: { stringData: Record<string, string> };
    };
    expect(rendered.scriptedCommand).toEqual(['/bin/sh', '-c', 'echo ********']);
    expect(rendered.supportNote).toBe('********');
    expect(rendered.extraSecret.stringData.ordinary).toBe('********');
  });

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
