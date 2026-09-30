/**
 * `core/edge/runtime.ts`: starting the edge lazily, moving legacy workspaces across, and
 * deleting a name without starting anything.
 *
 * "Resolving TLS never starts a container" drives `core/lifecycle`, so it lives in
 * `lifecycle.test.ts`. Docker is replaced, and each test has its own HOUSTON_HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { compose as composeSeam, docker as dockerSeam } from '../../../src/seams/docker-cli';
import { metadata, write as writeRecord } from '../../../src/core/runner/record';
import { ACME_FILE, acmeDir } from '../../../src/core/tls';

import * as paths from '../../../src/core/edge/paths';
import { registered } from '../../../src/core/edge/routes';
import { deleteHost, ensureRunning } from '../../../src/core/edge/runtime';
import { installed, write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

function answerEmpty(args: string[]) {
  return Promise.resolve({ argv: args, exitCode: 0, signal: null, stdout: '', stderr: '' });
}

/** What compose was asked, without the `-p houston_edge` every call carries. */
function composeVerbs(): string[] {
  return mocked(composeSeam).mock.calls.map(([args]) => (args as string[]).slice(2).join(' '));
}

/** A workspace holding 443 through its own Traefik. `tls` is what `adopt` checks. */
async function portHolding(name: string, host: string, tls: string): Promise<void> {
  await writeRecord(
    name,
    "services:\n  rocketchat:\n    image: rc\n  traefik:\n    image: traefik\n    ports: ['443:443']\n",
    metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      publicUrl: `https://${host}`,
      extra: { tls, tls_ports: [443], tls_email: 'o@e.com' },
    }),
  );
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-runtime-'));
  process.env.HOUSTON_HOME = home;
  // No edge is running (`ps` answers nothing) and every compose call succeeds.
  mocked(dockerSeam).mockImplementation(answerEmpty);
  mocked(composeSeam).mockImplementation(answerEmpty);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the lazy start', () => {
  it('writes a bare configuration on a box that has none, and no broken GUI route', async () => {
    // `up --https` on a box with no configuration at all has to produce a working edge.
    expect(installed()).toBe(false);
    expect((await ensureRunning()).ok).toBe(true);
    expect(installed()).toBe(true);
    expect(fs.existsSync(paths.routePath('_gui'))).toBe(false);
    expect(composeVerbs().some((verb) => verb.startsWith('up'))).toBe(true);
  });

  it('moves the others when one workspace will not move, and still starts', async () => {
    // Whatever still holds the port is named by `portHolder()`; one refusal must not stop
    // the rest, or the edge. `bad` sorts FIRST, so a refusal that escaped the loop would
    // leave `good` unmoved.
    await portHolding('bad', 't2.example.com', 'local'); // not a --domain workspace: refused
    await portHolding('good', 't1.example.com', 'acme');
    expect((await ensureRunning()).ok).toBe(true);
    expect(registered()).toEqual(['good']);
  });
});

describe('deleting with the edge stopped', () => {
  it('does not start it: nothing can write the entry back while it is stopped', async () => {
    // Starting it would claim :443 as a side effect of a deletion.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(
      path.join(acmeDir(), ACME_FILE),
      JSON.stringify({ le: { Certificates: [{ domain: { main: 'gone.example.org' } }] } }),
      'utf8',
    );
    const gone = await deleteHost('gone.example.org', { confirm: true });
    expect(gone.acme).toEqual(['acme.json']); // so the restart question really was asked
    expect(gone.foreign).toBe('');
    expect(gone.restarted).toBeNull();
    expect(composeVerbs()).toEqual([]);
  });
});
