/**
 * What the edge does TO a workspace: adopting one, and refusing to delete a name one
 * still serves.
 *
 * The behaviour lives in `core/edge/runtime.ts`, so the spec sits here rather than beside the
 * runner modules it touches. Docker is replaced throughout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConflictError } from '../../../src/lib/errors';
import { compose as composeSeam, docker as dockerSeam } from '../../../src/seams/docker-cli';
import { metadata, write as writeRecord } from '../../../src/core/runner/record';
import * as runnerPaths from '../../../src/core/runner/paths';

import * as paths from '../../../src/core/edge/paths';
import { register } from '../../../src/core/edge/routes';
import { adopt, deleteHost } from '../../../src/core/edge/runtime';
import { write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

beforeEach(() => {
  const ok = (args: string[]) =>
    Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' });
  mocked(dockerSeam).mockReset().mockImplementation(ok);
  mocked(composeSeam).mockReset().mockImplementation(ok);
});

describe('adopting a workspace onto the edge', () => {
  it('keeps the data volume: nothing is brought down or recreated, only its Traefik goes', async () => {
    // The whole point of transforming the compose file rather than recreating from
    // scratch: `down -v` is never involved.
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
    await adopt('w');
    const composed = mocked(composeSeam).mock.calls.map(([args]) => (args as string[]).join(' '));
    expect(composed.filter((argv) => /\b(up|down)\b/u.test(argv))).toEqual([]);
    const dockered = mocked(dockerSeam).mock.calls.map(([args]) => args as string[]);
    expect(dockered.filter((args) => args[0] === 'rm')).toEqual([
      ['rm', '-f', 'houston-w-traefik-1'],
    ]);
  });
});

describe('deleting a name a live workspace still claims', () => {
  it('refuses, names the workspace and the command, and touches nothing', async () => {
    // Deleting the certificate under a running workspace would leave one that cannot
    // serve its own name.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('live', 'live.example.org', { local: true });
    fs.mkdirSync(runnerPaths.workspace('live'), { recursive: true });
    fs.writeFileSync(path.join(runnerPaths.workspace('live'), 'repro.json'), '{}');

    const refused = deleteHost('live.example.org', { confirm: true, restart: false });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow("workspace 'live'");
    await expect(refused).rejects.toThrow('down --name live --volumes');
    expect(fs.existsSync(paths.routePath('live'))).toBe(true);
  });
});
