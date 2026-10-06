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
import { AUDIT_FILE } from '../../../src/core/audit';
import * as eks from '../../../src/core/eks';
import * as config from '../../../src/lib/config';
import * as users from '../../../src/core/users';
import { createApp } from '../../../src/web/app';

jest.mock('../../../src/core/cluster', () => ({
  ...jest.requireActual('../../../src/core/cluster'),
  knownContexts: jest.fn(async () => ({ contexts: [], unreadable: '', default: '' })),
  status: jest.fn(),
  overview: jest.fn(async () => ({
    clusters: [],
    failed: [],
    preflight: {
      tools_ok: true,
      blockers: [],
      account: '111122223333',
      identity: '',
      region: 'us-east-1',
      approved: false,
    },
    totals: { clusters: 0, billable: 0, usd_day: null, spend_usd: null, workspaces: 0 },
    next: {
      stage: 2,
      cluster: '',
      title: 'Approve AWS account 111122223333 for spending on this box',
      why: 'w',
      command: 'houston config set cluster.approved_accounts 111122223333',
    },
    default: '',
    unreadable: '',
  })),
  resolveName: jest.fn(async (host: string) =>
    host.endsWith('.rc.example.com') ? ['a1b2.elb.amazonaws.com.'] : [],
  ),
  resolveAddresses: jest.fn(async (host: string) =>
    host.endsWith('.proxied.example.org') ? ['104.21.71.43'] : [],
  ),
}));
jest.mock('../../../src/core/eks', () => ({
  ...jest.requireActual('../../../src/core/eks'),
  createCluster: jest.fn(async () => ({ region: 'us-east-1' })),
  whoami: jest.fn(async () => ({
    account: '111122223333',
    arn: 'arn:aws:iam::111122223333:user/alice',
    error: '',
  })),
  region: jest.fn(async () => 'eu-west-1'),
  connectExisting: jest.fn(async (arn: string) => ({
    context: arn,
    account: '111122223333',
    principal: 'arn:aws:iam::111122223333:user/alice',
    region: 'eu-west-1',
    reachable: true,
    access_reason: '',
  })),
  deleteCluster: jest.fn(async () => true),
  sweepLeftovers: jest.fn(async () => ({
    found: [
      {
        kind: 'volume',
        id: 'vol-1',
        detail: '8 GB',
        fix: 'aws ec2 delete-volume --volume-id vol-1',
      },
    ],
    unreadable: [],
  })),
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

describe('the zone a cluster is built with', () => {
  it('reaches the create from the request body', async () => {
    const boss = await signIn(app, 'boss', 'admin');
    const response = await app.inject({
      method: 'POST',
      url: '/api/clusters/create',
      payload: { name: 'support', zone: 'rc.example.com' },
      headers: as(boss),
    });
    expect(response.statusCode).toBe(200);
    for (let n = 0; n < 40 && (eks.createCluster as jest.Mock).mock.calls.length === 0; n += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(eks.createCluster).toHaveBeenCalledWith(
      'support',
      expect.objectContaining({ zone: 'rc.example.com' }),
    );
  });
});

describe('a cluster build job', () => {
  it('names its region, so the GUI hides only that cluster while it builds', async () => {
    // Its label is only the cluster's name, and a name is unique per region: a billing
    // cluster of the same name in another region vanished from the page for twenty minutes.
    const boss = await signIn(app, 'boss-region', 'admin');
    const response = await app.inject({
      method: 'POST',
      url: '/api/clusters/create',
      payload: { name: 'support', region: 'eu-west-2' },
      headers: as(boss),
    });
    expect(response.statusCode).toBe(200);
    const job = app.jobs.listJobs().find((summary) => summary.kind === 'cluster-create');
    expect(job?.label).toBe('support');
    expect(job?.region).toBe('eu-west-2');
  });
});

describe('the existing-cluster connection', () => {
  it('shows the server identity without secrets and restricts kubeconfig changes to admins', async () => {
    const reader = await signIn(app, 'reader-connect', 'readonly');
    const boss = await signIn(app, 'boss-connect', 'admin');
    const prior = process.env.AWS_PROFILE;
    const priorKey = process.env.AWS_ACCESS_KEY_ID;
    const priorWeb = process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
    const priorContainer = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const priorContainerFull = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    process.env.AWS_PROFILE = 'support-sso';
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    try {
      const read = await app.inject({ url: '/api/clusters/connection', headers: as(reader) });
      expect(read.statusCode).toBe(200);
      expect(JSON.parse(read.body)).toMatchObject({
        source: 'named profile',
        profile: 'support-sso',
        account: '111122223333',
        region: 'eu-west-1',
      });
      expect(read.body).not.toMatch(/SECRET_ACCESS_KEY|SESSION_TOKEN/u);
      const arn = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';
      const denied = await app.inject({
        method: 'POST',
        url: '/api/clusters/connect',
        payload: { context: arn },
        headers: as(reader),
      });
      expect(denied.statusCode).toBe(403);
      const connected = await app.inject({
        method: 'POST',
        url: '/api/clusters/connect',
        payload: { context: arn },
        headers: as(boss),
      });
      expect(connected.statusCode).toBe(200);
      expect(eks.connectExisting).toHaveBeenCalledWith(arn);
    } finally {
      if (prior === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = prior;
      if (priorKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = priorKey;
      if (priorWeb === undefined) delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
      else process.env.AWS_WEB_IDENTITY_TOKEN_FILE = priorWeb;
      if (priorContainer === undefined) delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
      else process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = priorContainer;
      if (priorContainerFull === undefined) delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
      else process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = priorContainerFull;
    }
  });
});

describe('what a delete leaves behind', () => {
  it('ends the delete job with the leftovers AWS still holds', async () => {
    const boss = await signIn(app, 'boss', 'admin');
    const started = await app.inject({
      method: 'POST',
      url: '/api/clusters/delete',
      payload: { name: 'support', region: 'eu-west-1' },
      headers: as(boss),
    });
    expect(started.statusCode).toBe(200);
    const { job_id } = JSON.parse(started.body) as { job_id: string };
    let state: { status: string; result?: unknown } = { status: 'running' };
    for (let n = 0; n < 80 && state.status === 'running'; n += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = JSON.parse(
        (await app.inject({ url: `/api/jobs/${job_id}`, headers: as(boss) })).body,
      ) as typeof state;
    }
    expect(state.status).toBe('done');
    expect(state.result).toMatchObject({
      deleted: true,
      region: 'eu-west-1',
      leftovers: { found: [{ kind: 'volume', id: 'vol-1' }] },
    });
    expect(eks.sweepLeftovers).toHaveBeenCalledWith('support', 'eu-west-1');
  });
});

describe('what the Clusters page and the build flow read', () => {
  it('lets a page reuse the AWS checks and a Re-check ask again', async () => {
    const reader = await signIn(app, 'ronly2', 'readonly');
    const read = cluster.overview as jest.Mock;
    read.mockClear();
    await app.inject({ url: '/api/clusters/overview', headers: as(reader) });
    await app.inject({ url: '/api/clusters/overview?fresh=1', headers: as(reader) });
    expect(read.mock.calls.map((call) => (call[1] as { reuse: boolean }).reuse)).toEqual([
      true,
      false,
    ]);
  });

  it('serves the overview, the price of a build, a DNS check and the guide to anyone signed in', async () => {
    const reader = await signIn(app, 'ronly', 'readonly');
    const overview = await app.inject({ url: '/api/clusters/overview', headers: as(reader) });
    expect(overview.statusCode).toBe(200);
    expect(JSON.parse(overview.body)).toMatchObject({
      next: { stage: 2 },
      totals: { clusters: 0 },
    });

    // The build dialog's price came from a hardcoded string that did not follow Nodes;
    // it comes from the same table the ledger prices with, per node count.
    const three = JSON.parse(
      (await app.inject({ url: '/api/clusters/estimate?nodes=3', headers: as(reader) })).body,
    ) as {
      usd_hr: number;
      usd_day: number;
      nodes: number;
      instance_type: string;
      basis: string;
      kubernetes_version: string;
    };
    const five = JSON.parse(
      (await app.inject({ url: '/api/clusters/estimate?nodes=5', headers: as(reader) })).body,
    ) as { usd_hr: number };
    expect(three.nodes).toBe(3);
    expect(three.instance_type).toBe('t3.large');
    expect(three.kubernetes_version).toBe('1.37');
    // The newest standard-support version: the $0.10 control plane, not 1.33's $0.60.
    expect(three.basis).toContain('standard support');
    expect(three.usd_hr).toBeLessThan(0.9);
    expect(three.usd_hr).toBeGreaterThan(0.4);
    expect(three.usd_day).toBeCloseTo(three.usd_hr * 24, 2);
    expect(five.usd_hr).toBeGreaterThan(three.usd_hr);
    const bad = await app.inject({ url: '/api/clusters/estimate?nodes=zero', headers: as(reader) });
    expect(bad.statusCode).toBe(400);

    const dns = JSON.parse(
      (
        await app.inject({
          url: '/api/clusters/dns-check?host=t1.rc.example.com&target=a1b2.elb.amazonaws.com',
          headers: as(reader),
        })
      ).body,
    ) as { answers: string[]; matches: boolean };
    expect(dns).toEqual({
      host: 't1.rc.example.com',
      target: 'a1b2.elb.amazonaws.com',
      answers: ['a1b2.elb.amazonaws.com.'],
      matches: true,
      addresses: [],
    });
    const nope = JSON.parse(
      (
        await app.inject({
          url: '/api/clusters/dns-check?host=t1.example.org',
          headers: as(reader),
        })
      ).body,
    ) as { answers: string[]; matches: boolean | null };
    expect(nope.answers).toEqual([]);
    expect(nope.matches).toBeNull();
    expect(nope).toHaveProperty('addresses', []);
    // A proxied record: no CNAME, but addresses -- Cloudflare's orange cloud, not a gap.
    const proxied = JSON.parse(
      (
        await app.inject({
          url: '/api/clusters/dns-check?host=houston-probe.proxied.example.org&target=a1b2.elb.amazonaws.com',
          headers: as(reader),
        })
      ).body,
    ) as { answers: string[]; matches: boolean; addresses: string[] };
    expect(proxied.answers).toEqual([]);
    expect(proxied.matches).toBe(false);
    expect(proxied.addresses).toEqual(['104.21.71.43']);

    const guide = await app.inject({ url: '/api/docs/eks', headers: as(reader) });
    expect(guide.statusCode).toBe(200);
    expect(JSON.parse(guide.body).body).toContain('# Rocket.Chat on Amazon EKS');
  });

  it('lets only an admin approve the account, writes both settings and audits it', async () => {
    const member = await signIn(app, 'mem', 'member');
    const refused = await app.inject({
      method: 'POST',
      url: '/api/clusters/approve',
      payload: { account: '111122223333', acme_email: 'alice@example.com' },
      headers: as(member),
    });
    expect(refused.statusCode).toBe(403);
    const boss = await signIn(app, 'boss', 'admin');
    const ok = await app.inject({
      method: 'POST',
      url: '/api/clusters/approve',
      payload: { account: '111122223333', acme_email: 'alice@example.com' },
      headers: as(boss),
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({
      account: '111122223333',
      approved: ['111122223333'],
      acme_email: 'alice@example.com',
    });
    expect(config.approvedAwsAccounts().has('111122223333')).toBe(true);
    expect(String(config.loadConfig().acme_email)).toBe('alice@example.com');
    const lines = fs
      .readFileSync(path.join(home, AUDIT_FILE), 'utf8')
      .split('\n')
      .filter((line) => line.includes('\tcluster-approve\t'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('boss');
    // Not a number: refused before anything is written.
    const junk = await app.inject({
      method: 'POST',
      url: '/api/clusters/approve',
      payload: { account: 'abc' },
      headers: as(boss),
    });
    expect(junk.statusCode).toBe(400);
  });
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
