/**
 * `web/routes/clusters`: the cluster ledger over HTTP.
 *
 * The stakes are high: `create` spends real money for as long as nobody remembers to remove it, and
 * `delete` destroys something that may hold colleagues' work on machines this box has never seen.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import * as cluster from '../../../src/core/cluster';
import * as eks from '../../../src/core/eks';
import * as users from '../../../src/core/users';
import { createApp } from '../../../src/web/app';

jest.mock('../../../src/core/cluster', () => ({
  ...jest.requireActual('../../../src/core/cluster'),
  knownContexts: jest.fn(async () => ({ contexts: [], unreadable: '', default: '' })),
  status: jest.fn(),
}));
jest.mock('../../../src/core/eks', () => ({
  ...jest.requireActual('../../../src/core/eks'),
  createCluster: jest.fn(async () => ({ region: 'us-east-1' })),
}));

const PASSWORD = 'a-good-enough-password';

/** Sign `user` in, creating the account with `role` first; the session cookie. */
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

function as(cookie: string) {
  return { host: 'localhost', cookie };
}

// A FRESH HOME PER TEST, as earlier releases' suite gave each one. `test/testsetup.ts` isolates
// per FILE, so an account one case creates would otherwise exist in the next.
let home = '';
let app: FastifyInstance;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-clusters-'));
  process.env.HOUSTON_HOME = home;
  app = await createApp({ accounts: true });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the cluster ledger', () => {
  it('is readable by everyone and spendable by nobody but admins', async () => {
    // Reads at readonly+, money and destruction at admin. `prepare` changes a cluster and
    // costs nothing, so it is a write like any other; the rule this repo applies to the shared
    // edge -- the box's front door is not a member's to edit -- applies to a cluster more.
    const reader = await signIn(app, 'alice', 'readonly');

    // A ledger whose job is to stop a cluster being forgotten works better the more people
    // can see it.
    expect((await app.inject({ url: '/api/clusters', headers: as(reader) })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/clusters/iam-policy', headers: as(reader) })).statusCode,
    ).toBe(200);
    for (const [url, payload] of [
      ['/api/clusters/create', { name: 'x' }],
      ['/api/clusters/delete', { name: 'x' }],
      ['/api/clusters/prepare', { context: 'x' }],
    ] as const) {
      const refused = await app.inject({ method: 'POST', url, payload, headers: as(reader) });
      expect({ url, status: refused.statusCode }).toEqual({ url, status: 403 });
    }

    // Past the ROLE gate, what stops an admin is the service layer's own refusal -- which
    // is where that decision belongs: a create with no name is a bad request.
    const boss = await signIn(app, 'boss', 'admin');
    for (const url of ['/api/clusters/create', '/api/clusters/delete']) {
      const bad = await app.inject({ method: 'POST', url, payload: {}, headers: as(boss) });
      expect({ url, status: bad.statusCode }).toEqual({ url, status: 400 });
    }
    expect(eks.createCluster).not.toHaveBeenCalled();
  });

  it('parses the expiry of a create exactly as the flag does', async () => {
    // Trusting it would let an unparseable value become "no expiry", and the expiry tag is
    // the only thing that will later say this cluster was meant to be temporary.
    const boss = await signIn(app, 'boss', 'admin');
    const create = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/clusters/create', payload, headers: as(boss) });

    const banana = await create({ name: 's', expires: 'banana' });
    expect(banana.statusCode).toBe(400);
    expect(banana.body).toContain(
      '`expires` wants a number of days or \\"never\\", got \'banana\'',
    );
    // Refused BEFORE a job exists, so there is nothing to wait for: the service was never asked.
    expect(eks.createCluster).not.toHaveBeenCalled();

    for (const payload of [
      { name: 's', expires: 'never' },
      { name: 's', expires: '3' },
      { name: 's' },
    ]) {
      expect((await create(payload)).statusCode).toBe(200);
    }
    // `drain` is the SHUTDOWN drain -- a manager that has drained refuses new work, which is
    // why this waits once, after the last submission, and not between them.
    await app.jobs.drain();
    const asked = jest
      .mocked(eks.createCluster)
      .mock.calls.map(([, options]) => options?.expiresDays);
    // never -> no tag, a number -> that many days, nothing -> the default.
    expect(asked).toEqual([null, 3, eks.DEFAULT_EXPIRY_DAYS]);
  });

  it('answers the list without probing, so one unreadable cluster cannot take the page', async () => {
    // `status()` is six or more round trips and a refusing cluster spends the whole timeout
    // on each; one endpoint returning everything would be as slow as its worst cluster.
    const ARN = 'arn:aws:eks:us-east-1:1:cluster/support';
    jest.mocked(cluster.knownContexts).mockResolvedValue({
      contexts: [{ context: ARN, ours: false, provider: 'eks', billable: true, is_default: false }],
      unreadable: '',
      default: '',
    } as never);
    jest.mocked(cluster.status).mockResolvedValue({
      context: ARN,
      reachable: false,
      reach_status: 'denied',
      reach_why: 'it answered and refused these credentials',
      reach_advice: '',
      unreadable: ['cluster'],
      nodes: null,
      workspaces: null,
      pvcs: null,
      loadbalancers: null,
      cost: null,
    } as never);
    const reader = await signIn(app, 'alice', 'readonly');

    const listed = (await app.inject({ url: '/api/clusters', headers: as(reader) })).json();
    expect(listed.contexts[0].context).toBe(ARN);
    expect(cluster.status).not.toHaveBeenCalled();

    const probed = (
      await app.inject({
        url: `/api/clusters/status?context=${encodeURIComponent(ARN)}`,
        headers: as(reader),
      })
    ).json();
    expect(cluster.status).toHaveBeenCalledWith(ARN);
    expect(probed).toMatchObject({ reachable: false, reach_status: 'denied' });
    for (const empty of ['nodes', 'workspaces', 'pvcs', 'loadbalancers', 'cost']) {
      // null, never 0 or []: a refused read is not an empty answer.
      expect({ [empty]: probed[empty] }).toEqual({ [empty]: null });
    }
  });
});
