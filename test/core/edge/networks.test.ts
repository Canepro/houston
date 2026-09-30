/**
 * `core/edge/networks.ts`, through the one caller that changes a workspace's own compose
 * document: `adopt`.
 *
 * Docker is replaced, and the test has its own HOUSTON_HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { docker as dockerSeam } from '../../../src/seams/docker-cli';
import { metadata, readCompose, write as writeRecord } from '../../../src/core/runner/record';
import { SERVICE } from '../../../src/core/tls';

import { holdersOf443 } from '../../../src/core/edge/engine';
import { adopt } from '../../../src/core/edge/runtime';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-networks-'));
  process.env.HOUSTON_HOME = home;
  mocked(dockerSeam).mockImplementation((args: string[]) =>
    Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' }),
  );
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('adopting a workspace onto the edge', () => {
  it('drops its own Traefik and edits no network: the EDGE joins the workspace’s', async () => {
    await writeRecord(
      'w',
      'services:\n' +
        "  rocketchat:\n    image: rc\n    ports: ['0.0.0.0:3000:3000']\n" +
        '  mongodb:\n    image: mongo\n' +
        "  traefik:\n    image: traefik\n    ports: ['443:443', '80:80']\n",
      metadata({
        name: 'w',
        project: 'houston-w',
        rcVersion: '8.5.1',
        publicUrl: 'https://t1.kestron.org',
        extra: { tls: 'acme', tls_ports: [443], tls_email: 'o@e.com' },
      }),
    );
    expect(await adopt('w')).toEqual({ name: 'w', host: 't1.kestron.org' });
    const doc = await readCompose('w');
    // Its Traefik must go, or 443 stays held.
    expect(Object.keys(doc.services as Record<string, unknown>)).not.toContain(SERVICE);
    expect(Object.keys(doc.services as Record<string, unknown>)).toEqual(['rocketchat', 'mongodb']);
    // No network edits: the workspace keeps its own, and the edge joined it live.
    expect('networks' in doc).toBe(false);
  });
});

describe('a workspace that is not a --domain one', () => {
  it('holds no 443 and is refused adoption, because it has no public name to register', async () => {
    // `--https` alone uses a local certificate: nothing to move onto the edge.
    await writeRecord(
      'l',
      'services: {}\n',
      metadata({
        name: 'l',
        project: 'houston-l',
        rcVersion: '8.5.1',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        extra: { tls: 'local', tls_ports: [8443] },
      }),
    );
    expect(await holdersOf443()).toEqual([]);
    await expect(adopt('l')).rejects.toThrow(/not a --domain workspace/u);
    expect(mocked(dockerSeam)).not.toHaveBeenCalled();
  });
});

describe('the record an adoption rewrites', () => {
  it('keeps a hand-edited extra in its order and spelling, as earlier releases do', async () => {
    // Earlier releases copy the extra and write the record back in the order and the
    // spelling they read it in. A spread here was JavaScript's order, `10` first, and no
    // spelling for 12345678901234567890 or `1e16`.
    const ws = path.join(home, 'repros', 'w');
    const setUp = () => {
      fs.rmSync(path.join(home, 'edge'), { recursive: true, force: true });
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'repro.json'),
        '{"name": "w", "project": "houston-w", "rc_version": "8.5.1", "rc_image": "rc", ' +
          '"mongo_tag": "8.0", "mongo_flavor": "official", "preset": "", ' +
          '"root_url": "http://localhost:3000", "host_port": 3000, "version_source": "live", ' +
          '"public_url": "https://t1.kestron.org", "extra": {"tls": "acme", "10": "x", ' +
          '"b": 1, "n": 12345678901234567890, "f": 1e16, "tls_ports": [443]}}',
      );
      fs.writeFileSync(
        path.join(ws, 'docker-compose.yml'),
        'services:\n  rocketchat:\n    image: rc\n  traefik:\n    image: traefik\n',
      );
    };
    // The record earlier releases wrote back after adopting the same workspace, recorded.
    const recorded = [
      '{',
      '  "name": "w",',
      '  "project": "houston-w",',
      '  "rc_version": "8.5.1",',
      '  "rc_image": "rc",',
      '  "mongo_tag": "8.0",',
      '  "mongo_flavor": "official",',
      '  "preset": "",',
      '  "root_url": "http://localhost:3000",',
      '  "host_port": 3000,',
      '  "version_source": "live",',
      '  "pinned": false,',
      '  "created_at": "",',
      '  "public_url": "https://t1.kestron.org",',
      '  "admin_password": "",',
      '  "extra": {',
      '    "tls": "acme",',
      '    "10": "x",',
      '    "b": 1,',
      '    "n": 12345678901234567890,',
      '    "f": 1e+16,',
      '    "tls_ports": [],',
      '    "edge": true',
      '  }',
      '}',
    ].join('\n');
    setUp();
    await adopt('w');
    const ours = fs.readFileSync(path.join(ws, 'repro.json'), 'utf8');
    expect(ours).toBe(recorded);
    expect(ours).toContain('"n": 12345678901234567890');
  });
});
