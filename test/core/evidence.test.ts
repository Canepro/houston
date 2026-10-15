import * as fs from 'node:fs';
import * as path from 'node:path';

import { ValidationError } from '../../src/lib/errors';
import {
  cleanupCommand,
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
  '    ports:',
  "      - '127.0.0.1:3000:3000'",
  '  mongodb:',
  '    image: mongo:7.0',
  '',
].join('\n');

async function workspaceNamed(name: string, extra: Record<string, unknown> = {}): Promise<void> {
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

  it('carries the seed record when there is one, and nothing when there is not', async () => {
    await workspaceNamed('e4', { seed: { profile: 'small', actual: { users: 5 } } });
    expect((await record('e4')).seed).toEqual({ profile: 'small', actual: { users: 5 } });
    await workspaceNamed('e5');
    expect('seed' in (await record('e5'))).toBe(false);
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
  it('writes the record, a README rendered from it, and the deployment artifact', async () => {
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
  });
});
