/**
 * `core/edge/routes.ts`: the route files, and who claims which name.
 *
 * A route file is keyed by WORKSPACE name and the thing it claims is a HOSTNAME, so the cases here
 * are the ones where the two drift: a name claimed twice, a Kubernetes route treated as a Docker
 * one, and a deletion that frees one claimant and leaves the name still broken.
 *
 * Docker is replaced, and each test has its own HOUSTON_HOME.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { docker as dockerSeam } from '../../../src/seams/docker-cli';

import * as paths from '../../../src/core/edge/paths';
import {
  reattachAll,
  register,
  registered,
  routeReachable,
  routesFor,
} from '../../../src/core/edge/routes';
import { deleteHost } from '../../../src/core/edge/runtime';
import { write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

/** Every docker call answers empty; `network connect` answers `connectCode`. */
function scriptDocker(connectCode = 0): void {
  mocked(dockerSeam).mockImplementation((args: string[]) =>
    Promise.resolve({
      argv: args,
      exitCode: args[0] === 'network' && args[1] === 'connect' ? connectCode : 0,
      signal: null,
      stdout: '',
      stderr: '',
    }),
  );
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-routes-'));
  process.env.HOUSTON_HOME = home;
  scriptDocker();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('registering a route', () => {
  it('replaces a workspace’s route rather than adding a second one', async () => {
    await register('alice', 'old.example.com');
    await register('alice', 'new.example.com');
    expect(registered()).toEqual(['alice']);
    const route = fs.readFileSync(paths.routePath('alice'), 'utf8');
    expect(route).toContain('new.example.com');
    expect(route).not.toContain('old.example.com');
  });

  it('asks for no certificate for a passthrough, which the edge never presents one for', async () => {
    // `register` returns "this name needs a certificate of its own", and the caller counts
    // that against Let's Encrypt's weekly limit. Counting a passthrough spends budget on
    // nothing.
    expect(await register('kws', 'kws.example.com', { passthrough: '172.16.0.2:443' })).toBe(false);
    expect(registered()).toEqual(['kws']);
    expect(fs.existsSync(path.join(paths.certsDir(), 'kws.example.com.crt'))).toBe(false);
  });
});

describe('a Kubernetes route beside a Docker one', () => {
  it('is not re-attached on a restart, so a healthy workspace is not reported broken', async () => {
    // `reattachAll` joins each routed workspace's Docker network. A Kubernetes workspace
    // has neither a network nor a compose project, so attaching could only fail -- and
    // reporting that would name a healthy workspace unreachable on every `edge start`.
    await register('compose', 'c.example.com');
    await register('kube', 'k.example.com', { passthrough: '172.16.0.2:443' });
    scriptDocker(1); // as `docker network connect` would answer, for both
    mocked(dockerSeam).mockClear();
    expect(await reattachAll()).toEqual(['compose']);
    const tried = mocked(dockerSeam)
      .mock.calls.map(([args]) => args as string[])
      .filter((args) => args[0] === 'network' && args[1] === 'connect')
      .map((args) => args[2]);
    expect(tried).toEqual(['houston-compose_default']);
  });

  it('is reachable with no network joined, where an HTTP route is not', async () => {
    // `edge status` computed reachability as network membership, so every Kubernetes
    // workspace was listed `NO (502)` -- including one answering HTTP 200 from the internet
    // on a real Let's Encrypt certificate.
    await register('kube', 'k.example.com', { passthrough: '172.16.0.2:443' });
    await register('cmp', 'c.example.com');
    expect(await routeReachable('kube', new Set())).toBe(true);
    expect(await routeReachable('cmp', new Set())).toBe(false);
    expect(await routeReachable('cmp', new Set(['houston-cmp_default']))).toBe(true);
  });
});

describe('freeing a name', () => {
  it('finds and removes EVERY route claiming it', async () => {
    // The collision that cost an hour was THREE files on one host. Removing one would
    // leave the name still claimed and still broken.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    for (const name of ['a', 'b', 'c']) {
      await register(name, 'dupe.example.org', { passthrough: '10.0.0.5:31443' });
    }
    expect(routesFor('dupe.example.org')).toEqual(['a', 'b', 'c']);
    const gone = await deleteHost('dupe.example.org', { confirm: true, restart: false });
    expect(gone.routes).toEqual(['a', 'b', 'c']);
    expect(registered()).toEqual([]);
  });
});
