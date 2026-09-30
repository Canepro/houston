/**
 * `web/routes/edge`: the shared front door over HTTP.
 *
 * The edge modules run for real against a per-test home; only three things are stubbed -- the
 * docker command line, whether the edge container is running, and which workspace networks it has
 * joined.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { issueLocalCert } from '../../../src/core/edge/acme';
import * as networks from '../../../src/core/edge/networks';
import { certsDir } from '../../../src/core/edge/paths';
import { register } from '../../../src/core/edge/routes';
import { write } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';
import { ACME_FILE, acmeDir } from '../../../src/core/tls';
import * as users from '../../../src/core/users';
import { createApp } from '../../../src/web/app';

jest.mock('../../../src/seams/docker-cli', () => {
  const answer = (args: readonly string[]) =>
    Promise.resolve({
      argv: ['docker', ...args],
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
    });
  return {
    ...jest.requireActual('../../../src/seams/docker-cli'),
    docker: jest.fn(answer),
    compose: jest.fn((args: readonly string[]) => answer(['compose', ...args])),
  };
});
jest.mock('../../../src/core/edge/engine', () => ({
  ...jest.requireActual('../../../src/core/edge/engine'),
  running: jest.fn(async () => true),
}));
jest.mock('../../../src/core/edge/networks', () => ({
  ...jest.requireActual('../../../src/core/edge/networks'),
  attachedNetworks: jest.fn(async () => new Set<string>()),
}));

const PASSWORD = 'a-good-enough-password';

async function signIn(app: FastifyInstance, user: string, role: string): Promise<string> {
  await users.add(user, PASSWORD, role);
  const response = await app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { user, password: PASSWORD },
    headers: { host: 'localhost' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}

const as = (cookie: string) => ({ host: 'localhost', cookie });

/** The edge is joined to exactly these workspaces' networks. */
async function attachedTo(...names: string[]): Promise<void> {
  const joined = new Set(await Promise.all(names.map((name) => networks.workspaceNetwork(name))));
  jest.mocked(networks.attachedNetworks).mockResolvedValue(joined);
}

// A FRESH HOME PER TEST, as earlier releases' suite gave each one.
let home = '';
let app: FastifyInstance;
let admin = '';
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-route-'));
  process.env.HOUSTON_HOME = home;
  app = await createApp({ accounts: true });
  await app.ready();
  admin = await signIn(app, 'alice', 'admin');
});
afterEach(async () => {
  await app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function edgePayload(): Promise<Record<string, unknown>> {
  const response = await app.inject({ url: '/api/edge', headers: as(admin) });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

type Route = { name: string; host: string; reachable: boolean; passthrough: boolean };
const byName = (body: Record<string, unknown>) =>
  Object.fromEntries((body.routes as Route[]).map((route) => [route.name, route]));

describe('GET /api/edge', () => {
  it('reports each route and whether the edge can reach it', async () => {
    // A route the edge cannot reach answers 502 rather than erroring -- the one failure
    // nothing else in the UI would surface.
    await write(edge({ domain: 'gui.example.com', acmeEmail: 'o@e.com' }));
    await register('alice-rc8-5-1', 't1.example.com');
    await register('bob-rc8-5-1', 't2.example.com');
    await attachedTo('alice-rc8-5-1');

    const body = await edgePayload();
    expect(body).toMatchObject({ installed: true, running: true, domain: 'gui.example.com' });
    const routes = byName(body);
    expect(routes['alice-rc8-5-1']).toMatchObject({ host: 't1.example.com', reachable: true });
    // Attached to neither network: reported, not errored.
    expect(routes['bob-rc8-5-1']?.reachable).toBe(false);
  });

  it('does not report a passthrough route unreachable', async () => {
    // SEEN IN A BROWSER, against a name answering 200 from the public internet. A passthrough
    // names an ADDRESS and there is no network to join, so "is its network attached" could
    // never be true and every Kubernetes workspace read as broken in three places at once.
    await write(edge({ domain: 'gui.example.com', acmeEmail: 'o@e.com' }));
    await register('composews', 't1.example.com');
    await register('k8sws', 'k1.example.com', { passthrough: '10.0.0.9:31855' });
    // On the COMPOSE workspace's network and nothing else: every Kubernetes workspace's
    // normal, permanent state.
    await attachedTo('composews');

    let routes = byName(await edgePayload());
    expect(routes.composews).toMatchObject({ reachable: true, passthrough: false });
    expect(routes.k8sws).toMatchObject({ reachable: true, passthrough: true });

    // And a container-backed route the edge really cannot reach is still reported.
    await register('orphan', 't2.example.com');
    routes = byName(await edgePayload());
    expect(routes.orphan?.reachable).toBe(false);
  });

  it('says so when there is no edge', async () => {
    expect(await edgePayload()).toMatchObject({ installed: false, routes: [] });
  });

  it('names certificates no route claims, so the GUI can offer to remove them', async () => {
    // The GUI cannot offer to delete what the payload does not mention, and an operator
    // handed `serve` and no shell has no other way to see it.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('live', 'live.example.org', { local: true });
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(
      path.join(acmeDir(), ACME_FILE),
      JSON.stringify({
        le: {
          Certificates: [
            { domain: { main: 'live.example.org', sans: [] } },
            { domain: { main: 'orphan.example.org', sans: [] } },
          ],
        },
      }),
    );
    expect((await edgePayload()).stale_certs).toEqual(['orphan.example.org']);
  });
});

describe('DELETE /api/edge/hosts/:host', () => {
  it('is refused to a member: the shared front door is not theirs to edit', async () => {
    // A member creates and destroys their OWN workspaces; this one deletes a private key.
    const member = await signIn(app, 'bob', 'member');
    const refused = await app.inject({
      method: 'DELETE',
      url: '/api/edge/hosts/x.example.org?confirm=true',
      headers: as(member),
    });
    expect(refused.statusCode).toBe(403);
  });

  it('is a 400 that names what it would destroy until confirm is given', async () => {
    // `confirm` is a parameter, not an assumption.
    await write(edge({ acmeEmail: 'ops@xyz.com' }));
    await register('x', 'x.example.org', { local: true });
    await issueLocalCert('x.example.org');
    const certificate = path.join(certsDir(), 'x.example.org.crt');
    expect(fs.existsSync(certificate)).toBe(true);

    const unconfirmed = await app.inject({
      method: 'DELETE',
      url: '/api/edge/hosts/x.example.org',
      headers: as(admin),
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(String(unconfirmed.json().error)).toContain('PRIVATE KEY');
    expect(fs.existsSync(certificate)).toBe(true);

    const confirmed = await app.inject({
      method: 'DELETE',
      url: '/api/edge/hosts/x.example.org?confirm=true',
      headers: as(admin),
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().certificate).toBe(true);
    expect(fs.existsSync(certificate)).toBe(false);
  });

  it('turns a refusal into its status: ConflictError is 409', async () => {
    // The ReproError -> http_status contract, on the newest route.
    await write(edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }));
    const refused = await app.inject({
      method: 'DELETE',
      url: '/api/edge/hosts/support.xyz.com?confirm=true',
      headers: as(admin),
    });
    expect(refused.statusCode).toBe(409);
    expect(String(refused.json().error)).toContain("GUI's own name");
  });
});
