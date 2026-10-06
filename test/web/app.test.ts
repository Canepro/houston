/**
 * `web/app`: the application factory, the context it builds, and what that context decides.
 *
 * It holds the sign-in throttle's own arithmetic, the context's shape, and the destroy gate as
 * the web layer asserts it.
 *
 * TWO OF EARLIER RELEASES' TESTS WERE HOLLOW, measured by running them against the defect each
 * one names:
 *
 *   - "the sign-in throttle is not reset wholesale by a flood" PASSES against the wholesale
 *     clear it was written for. The victim's second failure is the one that trips the clear,
 *     and `before` is measured after it -- so the victim's count survives the rest of the
 *     flood at 1, equal to `before`.
 *   - "a job submitted through a route lands in that app's registry" answers 404 for its
 *     `nope` workspace, and asserts the registry only when the status is 200. It has never
 *     reached its own assertion.
 *
 * Both cases below are unconditional, and each fails against the defect its name describes.
 *
 * FRESH MODULES AND A FRESH HOME PER TEST. The throttle is module state in
 * `web/security.ts`, which earlier releases' suite cleared per test, and accounts persist in
 * `HOUSTON_HOME`; re-requiring per test is both resets at once.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import type * as AppNS from '../../src/web/app';
import type * as CliNS from '../../src/cli/app';
import type * as ConfigNS from '../../src/lib/config';
import type * as HandlersNS from '../../src/cli/handlers';
import type * as JobsNS from '../../src/web/jobs';
import type * as MonitorNS from '../../src/core/monitor';
import type * as OwnershipNS from '../../src/core/lifecycle/ownership';
import type * as RecordNS from '../../src/core/runner/record';
import type * as RouteTableNS from '../../src/web/route-table';
import type * as SecurityNS from '../../src/web/security';
import type * as SessionRoutesNS from '../../src/web/routes/session';
import type * as TypesNS from '../../src/core/lifecycle/types';
import type * as UsersNS from '../../src/core/users';

jest.mock('../../src/core/lifecycle/naming', () => ({
  ...jest.requireActual('../../src/core/lifecycle/naming'),
  resolveName: jest.fn(async (name: string) => name),
}));
jest.mock('../../src/core/monitor', () => ({
  ...jest.requireActual('../../src/core/monitor'),
  attach: jest.fn(async () => ({})),
  detach: jest.fn(async () => ({})),
}));

const PASSWORD = 'correct-horse-battery';
const CROSS = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };

let home = '';
let previousHome: string | undefined;
const opened: FastifyInstance[] = [];

beforeEach(() => {
  previousHome = process.env.HOUSTON_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-web-app-'));
  process.env.HOUSTON_HOME = home;
  jest.resetModules();
});
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
  process.env.HOUSTON_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const security = () => require('../../src/web/security') as typeof SecurityNS;
const users = () => require('../../src/core/users') as typeof UsersNS;

async function app(options: AppNS.AppOptions = {}): Promise<FastifyInstance> {
  const built = await (require('../../src/web/app') as typeof AppNS).createApp(options);
  opened.push(built);
  await built.ready();
  return built;
}

async function signIn(target: FastifyInstance, user: string, password = PASSWORD): Promise<string> {
  const response = await target.inject({
    method: 'POST',
    url: '/api/session',
    payload: { user, password },
    headers: { host: 'localhost' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}

/** A `--trust-proxy` network, built the way `cli/serve.ts` builds one. */
function network(address: string, prefix: number): SecurityNS.TrustedNetwork {
  const block = new net.BlockList();
  block.addSubnet(address, prefix, 'ipv4');
  return { contains: (candidate) => block.check(candidate, 'ipv4') };
}

/** A workspace record on disk, created by `owner`, as earlier releases' web helpers made one. */
async function workspace(name: string, owner: string): Promise<void> {
  const record = require('../../src/core/runner/record') as typeof RecordNS;
  await record.write(
    name,
    'services: {}\n',
    record.metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: { created_by: owner },
    }),
  );
}

describe('the sign-in throttle', () => {
  it('keeps half the window after a success, so a working account buys no fresh round', () => {
    // One valid low-privilege credential used to reset the per-address window, so an
    // attacker holding any working account signed in between rounds and started each batch
    // of guesses against an admin name from zero. The bound is per address by design --
    // `core/users.ts` cannot refuse on a counter without refusing correct passwords too --
    // so the reset is per address as well; it just must not be total.
    const s = security();
    for (let n = 0; n < s.SIGNIN_MAX_FAILURES; n += 1) s.signinFailed('1.2.3.4');
    expect(s.signinRetryAfter('1.2.3.4')).toBeGreaterThan(0);

    s.signinOk('1.2.3.4');
    expect(s.signinRetryAfter('1.2.3.4')).toBe(0); // a success changed something...
    for (let n = 0; n < s.SIGNIN_MAX_FAILURES / 2; n += 1) s.signinFailed('1.2.3.4');
    // ...but not everything: half as many failures trip it again.
    expect(s.signinRetryAfter('1.2.3.4')).toBeGreaterThan(0);

    // A legitimate user who mistyped once and then succeeded is unaffected.
    s.signinFailed('5.6.7.8');
    s.signinOk('5.6.7.8');
    for (let n = 0; n < s.SIGNIN_MAX_FAILURES - 1; n += 1) s.signinFailed('5.6.7.8');
    expect(s.signinRetryAfter('5.6.7.8')).toBe(0);
  });

  it('keys on the rightmost hop no trusted proxy vouched for', async () => {
    // An appending proxy adds the peer it saw to the END of X-Forwarded-For, so the LEFT
    // of the list is attacker-written. Taking the first entry gave every request its own
    // key, and the throttle -- the only bound on password guessing, because scrypt is spent
    // at the endpoint -- never tripped.
    const s = security();
    const trusted = [network('10.0.0.0', 8)];
    expect(s.rightmostUntrusted('1.2.3.4, 10.0.0.5', trusted)).toBe('1.2.3.4');
    // A rotated forgery on the left cannot displace the real hop.
    expect(s.rightmostUntrusted('9.9.9.9, 1.2.3.4, 10.0.0.5', trusted)).toBe('1.2.3.4');
    // Two trusted hops: still the first address neither of them vouched for.
    expect(s.rightmostUntrusted('1.2.3.4, 10.0.0.5, 10.0.0.6', trusted)).toBe('1.2.3.4');
    // Everything trusted, or nothing there: the caller keeps the socket peer.
    expect(s.rightmostUntrusted('10.0.0.5', trusted)).toBe('');
    expect(s.rightmostUntrusted('', trusted)).toBe('');

    // And the consequence the rule exists for, end to end: a client rotating its forged
    // left-hand entry on every attempt is still one client, and is still stopped.
    await users().add('alice', PASSWORD, 'admin');
    const front = await app({ trustedProxies: trusted });
    const attempt = (forged: string) =>
      front.inject({
        method: 'POST',
        url: '/api/session',
        remoteAddress: '10.0.0.5',
        payload: { user: 'alice', password: 'wrong-wrong-wrong' },
        headers: { host: 'localhost', 'x-forwarded-for': `${forged}, 1.2.3.4` },
      });
    for (let n = 0; n < s.SIGNIN_MAX_FAILURES; n += 1) {
      expect((await attempt(`198.51.100.${String(n)}`)).statusCode).toBe(401);
    }
    expect((await attempt('198.51.100.200')).statusCode).toBe(429);
  });

  it('evicts the least recently active entry under a flood, never the whole map', () => {
    // It `.clear()`ed the map past 4096 keys, so a flood from throwaway addresses erased the
    // counter it was tripping -- including the failures bounding a real attempt against a
    // real account. THE VICTIM STOPS ONE SHORT OF THE LIMIT, so the only way the eleventh
    // attempt below is throttled is if every one of its nine survived the flood.
    const s = security();
    for (let n = 0; n < s.SIGNIN_MAX_FAILURES - 1; n += 1) s.signinFailed('first');
    for (let n = 1; n < s.SIGNIN_MAX_KEYS; n += 1) s.signinFailed(`flood-${String(n)}`);
    for (let n = 0; n < s.SIGNIN_MAX_FAILURES - 1; n += 1) s.signinFailed('victim');
    for (let n = s.SIGNIN_MAX_KEYS; n < s.SIGNIN_MAX_KEYS + 500; n += 1) {
      s.signinFailed(`flood-${String(n)}`);
    }

    s.signinFailed('victim');
    expect(`victim throttled: ${String(s.signinRetryAfter('victim') > 0)}`).toBe(
      'victim throttled: true',
    );
    // Still bounded: the least recently active entry is the one that went. Had nothing been
    // evicted, `first` would hold ten failures now and be throttled.
    s.signinFailed('first');
    expect(`first evicted: ${String(s.signinRetryAfter('first') === 0)}`).toBe(
      'first evicted: true',
    );
  });
});

describe('the front door', () => {
  it('serves no framework schema or documentation pages', async () => {
    // Earlier releases' schema path did not start with /api/, so the guard never covered it; it
    // must not be served at all. Signed in, so a 404 is the server's answer rather than a
    // redirect to sign in.
    await users().add('alice', PASSWORD, 'admin');
    const front = await app();
    const cookie = await signIn(front, 'alice');
    for (const url of ['/openapi.json', '/docs', '/redoc']) {
      const response = await front.inject({ url, headers: { host: 'localhost', cookie } });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 404 });
    }
  });

  it('still serves the application shell to a cross-site link', async () => {
    // Only /api/ is guarded. A link to the GUI from a wiki or a chat message has to keep
    // working -- refusing the document would break every bookmark.
    await users().add('alice', PASSWORD, 'admin');
    const front = await app();
    const cookie = await signIn(front, 'alice');
    const page = await front.inject({ url: '/', headers: { host: 'localhost', cookie, ...CROSS } });
    expect(page.statusCode).toBe(200);
    // ...while the same headers ARE refused on an API read, so they were not ignored.
    const read = await front.inject({
      url: '/api/jobs',
      headers: { host: 'localhost', cookie, ...CROSS },
    });
    expect(read.statusCode).toBe(403);
  });

  it('opens the sign-in page from a company dashboard tile', async () => {
    // The company's Okta tile has both of its URIs set to https://<host>/signin. A click
    // arrives at the Initiate login URI as a cross-site top-level GET carrying
    // `?iss=<issuer>`; the Sign-in redirect URI is where Okta would return `?code=&state=`,
    // which only happens after an app starts an OIDC login, and houston never does. houston
    // does not speak OIDC: both must simply render the page, and a signed-in user goes
    // straight in. A cross-site refusal here would break the tile for everyone on it.
    await users().add('alice', PASSWORD, 'admin');
    const front = await app();
    const cookie = await signIn(front, 'alice');
    for (const url of [
      '/signin?iss=https%3A%2F%2Flogin.rocket.chat',
      '/signin?code=okta-code&state=okta-state',
    ]) {
      const anonymous = await front.inject({ url, headers: { host: 'localhost', ...CROSS } });
      expect({
        url,
        status: anonymous.statusCode,
        form: anonymous.body.includes('action="/signin"'),
      }).toEqual({ url, status: 200, form: true });
      const signedIn = await front.inject({
        url,
        headers: { host: 'localhost', cookie, ...CROSS },
      });
      expect({ url, status: signedIn.statusCode, location: signedIn.headers.location }).toEqual({
        url,
        status: 303,
        location: '/',
      });
    }
  });

  it('treats a named allow-host as a trusted origin even when a proxy rewrote Host', async () => {
    // Splitting "may this Host reach us" from "is this Origin ours" must not break the proxy
    // case it exists for: a named host really is ours when the proxy rewrote Host.
    const s = security();
    await users().add('alice', PASSWORD, 'admin');
    const front = await app({ allowHosts: ['rc.example.com'] });
    const context = front.houstonSecurity;
    expect(s.originOk(context, 'rc.example.com', 'localhost')).toBe(true);
    expect(s.crossSite(context, { origin: 'https://rc.example.com', host: 'localhost' })).toBe(
      false,
    );
    expect(s.crossSite(context, { origin: 'https://evil.example', host: 'localhost' })).toBe(true);
    // Through the installed guard: the named origin reaches the handler, a stranger does not.
    const from = (origin: string) =>
      front.inject({
        method: 'POST',
        url: '/api/session',
        payload: { user: 'alice', password: 'not-it-at-all' },
        headers: { host: 'localhost', origin },
      });
    expect((await from('https://rc.example.com')).statusCode).toBe(401);
    expect((await from('https://evil.example')).statusCode).toBe(403);
  });

  it('prints every doctor row in the terminal report, including the ok ones', async () => {
    // The GUI-accounts row is an `ok`, and the terminal report is the only place a terminal
    // user learns how many accounts exist and who the admin is.
    jest.doMock('../../src/core/doctor', () => ({
      ...jest.requireActual<object>('../../src/core/doctor'),
      runChecks: jest.fn(async () => ({
        checks: [
          {
            status: 'ok',
            message: '3 GUI account(s), admin: alice',
            elsewhere: 'the People page',
          },
        ],
        counts: { ok: 1, warn: 0, fail: 0 },
        verdict: 'ok',
        repros: null,
      })),
    }));
    try {
      const cli = require('../../src/cli/app') as typeof CliNS;
      const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
      let out = '';
      const io = {
        writeOut: (value: string) => {
          out += value;
        },
        writeErr: () => undefined,
      };
      expect(await cli.runCli(['doctor'], { execute: handlers.createExecutor(io), io })).toBe(0);
      expect(out).toContain('3 GUI account(s), admin: alice');
    } finally {
      jest.dontMock('../../src/core/doctor');
    }
  });
});

describe('the destroy gate', () => {
  it('lets an admin force a destroy of somebody else’s workspace', async () => {
    const ownership = require('../../src/core/lifecycle/ownership') as typeof OwnershipNS;
    await users().add('alice', PASSWORD, 'admin');
    await users().add('carol', 'carols-good-password', 'member');
    await workspace('bobs-box', 'bob');
    expect(await ownership.mayDestroy('bobs-box', 'alice')).toEqual([true, '']);
    // The same record refuses a member who does not own it, so the admin's answer is the
    // role's and not a record the gate failed to read.
    expect((await ownership.mayDestroy('bobs-box', 'carol'))[0]).toBe(false);
  });

  it('is one config line away from confirm-and-proceed', async () => {
    // A team that preferred the old behaviour should not have to fork.
    const ownership = require('../../src/core/lifecycle/ownership') as typeof OwnershipNS;
    const config = require('../../src/lib/config') as typeof ConfigNS;
    const { DESTROY_POLICY_KEY } = require('../../src/core/lifecycle/types') as typeof TypesNS;
    await users().add('alice', PASSWORD, 'admin');
    await users().add('bob', 'bobs-good-password', 'member');
    await workspace('alices-box', 'alice');
    expect((await ownership.mayDestroy('alices-box', 'bob'))[0]).toBe(false);
    config.updateConfig((cfg) => {
      cfg[DESTROY_POLICY_KEY] = 'anyone';
    });
    expect((await ownership.mayDestroy('alices-box', 'bob'))[0]).toBe(true);
  });
});

/**
 * `true` exactly when `X` and `Y` are the same type, `readonly` modifiers included.
 *
 * Used with CONCRETE arguments only. Measured: nested inside a generic per-key helper the
 * same comparison answered "writable" for a field declared `readonly`, which would have
 * made the claim below unsatisfiable and taught the reader nothing.
 */
type Same<X, Y> =
  (<U>() => U extends X ? 1 : 2) extends <U>() => U extends Y ? 1 : 2 ? true : false;

describe('the application context', () => {
  it('holds exactly the nine declared fields', async () => {
    // The route modules are written against this shape, and a field added, renamed or
    // dropped silently is a route module reading `undefined`. Earlier releases' nine carry the job
    // registry where these carry the role resolver: here the registry is the application's
    // own `app.jobs` decoration, and the route split below proves a route reaches it.
    const front = await app();
    expect(Object.keys(front.houstonSecurity).sort()).toEqual([
      'accounts',
      'allowed',
      'anyHost',
      'cookiePlain',
      'cookieSecure',
      'csp',
      'publicHttps',
      'routeRequirement',
      'trustedProxies',
    ]);
  });

  it('is carried by the application, and not one field of it is writable', async () => {
    // Earlier releases asserted a frozen record at runtime. The TypeScript equivalent is the
    // type: `yarn typecheck` fails this assignment the moment any field loses `readonly`,
    // because the comparison is then `false`. Jest does not typecheck, so the runtime half
    // is what this test asserts when it runs: the context is the one the factory built.
    const frozen: Same<SecurityNS.SecurityContext, Readonly<SecurityNS.SecurityContext>> = true;
    expect(frozen).toBe(true);
    const front = await app({ allowHosts: ['rc.example.com'] });
    expect(front.houstonSecurity.allowed.has('rc.example.com')).toBe(true);
  });

  it('agrees with what the application actually does', async () => {
    // The context is not a second, parallel copy of the configuration: each field is
    // checked against the behaviour it drives, not only against the option it came from.
    const proxies = [network('10.0.0.0', 8)];
    const front = await app({
      allowHosts: ['rc.example.com'],
      accounts: false,
      publicHttps: true,
      trustedProxies: proxies,
    });
    const context = front.houstonSecurity;
    expect([...context.allowed].sort()).toEqual([
      '127.0.0.1',
      '::1',
      'localhost',
      'rc.example.com',
    ]);
    expect(context.anyHost).toBe(false);
    expect(context.csp.startsWith("default-src 'self'")).toBe(true);
    expect(context.csp).toContain("form-action 'self'");
    expect(context.cookieSecure).toBe('__Host-houston_session');
    expect(context.cookiePlain).toBe('houston_session');
    expect(context.accounts).toBe(false);
    expect(context.publicHttps()).toBe(true);
    expect(context.trustedProxies).toBe(proxies);

    const named = await front.inject({ url: '/api/jobs', headers: { host: 'rc.example.com' } });
    expect(named.statusCode).toBe(200); // allowed, and no session asked for: accounts off
    expect(named.headers['content-security-policy']).toBe(context.csp);
    const stranger = await front.inject({ url: '/api/jobs', headers: { host: 'evil.example' } });
    expect(stranger.statusCode).toBe(403);
  });

  it('records any host when the allow-list is a star', async () => {
    const front = await app({ allowHosts: ['*'], accounts: false });
    expect(front.houstonSecurity.anyHost).toBe(true);
    const response = await front.inject({ url: '/api/health', headers: { host: 'any.example' } });
    expect(response.statusCode).toBe(200);
  });

  it('decides the cookie from the live https answer on every request', async () => {
    // Earlier releases' frozen record kept the build-time public-https answer, and a route that read it
    // would keep answering "plain" after the hop turned https -- handing the plain-named
    // cookie back over https, which is the whole of what the `__Host-` prefix buys. Here
    // `createApp` fixes the answer at build and nothing reassigns it, so the hazard is the
    // same one one level down: a route that captured `publicHttps()` when it registered.
    // The guard and the session routes are installed exactly as `createApp` installs them,
    // over a source that changes between two sign-ins.
    const { contentSecurityPolicy } = require('../../src/web/app') as typeof AppNS;
    const { installJobs } = require('../../src/web/jobs') as typeof JobsNS;
    const { routeRequirement } = require('../../src/web/route-table') as typeof RouteTableNS;
    const sessionRoutes = require('../../src/web/routes/session') as typeof SessionRoutesNS;
    const s = security();
    let https = false;
    const bare = Fastify();
    opened.push(bare);
    installJobs(bare);
    bare.decorate('houstonFirstRun', false);
    s.installSecurity(bare, {
      allowed: new Set(['localhost']),
      anyHost: false,
      csp: contentSecurityPolicy(),
      accounts: true,
      cookieSecure: s.COOKIE_SECURE,
      cookiePlain: s.COOKIE_PLAIN,
      publicHttps: () => https,
      trustedProxies: [],
      routeRequirement,
    });
    sessionRoutes.register(bare);
    await bare.ready();
    await users().add('alice', PASSWORD, 'admin');

    const setCookie = async () => {
      const response = await bare.inject({
        method: 'POST',
        url: '/api/session',
        payload: { user: 'alice', password: PASSWORD },
        headers: { host: 'localhost' },
      });
      expect(response.statusCode).toBe(200);
      return String(response.headers['set-cookie']);
    };
    const plain = await setCookie();
    expect(plain.startsWith('houston_session=')).toBe(true);
    expect(plain).not.toContain('Secure');
    https = true;
    const secure = await setCookie();
    expect(secure.startsWith('__Host-houston_session=')).toBe(true);
    expect(secure).toContain('Secure');
  });

  it('keeps the trusted-proxy list it was handed, not a second parse of it', async () => {
    // Parsed ONCE, by `cli/serve.ts`. Two parses of one flag are two answers waiting to
    // disagree, and the context is the only holder the guard reads.
    const proxies = [network('10.0.0.0', 8)];
    const front = await app({ trustedProxies: proxies });
    expect(front.houstonSecurity.trustedProxies).toBe(proxies);
    expect(front.houstonSecurity.trustedProxies).toHaveLength(1);
  });

  it('builds the content security policy once, and it names the Grafana port', async () => {
    const { contentSecurityPolicy } = require('../../src/web/app') as typeof AppNS;
    const { MONITOR_PORTS } = require('../../src/lib/config') as typeof ConfigNS;
    const csp = contentSecurityPolicy();
    expect(csp).toContain(`frame-src 'self' http://localhost:${String(MONITOR_PORTS[1])}`);
    expect((await app()).houstonSecurity.csp).toBe(csp);
  });
});

describe('the route split', () => {
  it('lands a job submitted through a route in that application’s registry', async () => {
    // Handlers reach the registry through the application they were registered on. Getting
    // that wrong gives every application in the process one shared registry, and the suite
    // builds dozens of them -- a job would appear in some other server's /api/jobs.
    const other = await app({ accounts: false });
    const front = await app({ accounts: false });
    const response = await front.inject({ method: 'POST', url: '/api/repros/x/monitor' });
    expect(response.statusCode).toBe(200);
    const id = String(response.json().job_id);
    expect(front.jobs.listJobs().map((job) => job.id)).toEqual([id]);
    expect(other.jobs.listJobs()).toEqual([]);
    expect(await front.jobs.drain()).toEqual([]);
    const monitor = require('../../src/core/monitor') as typeof MonitorNS;
    expect(jest.mocked(monitor.attach)).toHaveBeenCalledTimes(1);
  });
});
