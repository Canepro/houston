/**
 * `web/routes/session`: signing in and out, the first account, and what a proxy may claim.
 *
 * `test/web/signin.test.ts` proves the sign-in PAGE renders safely; this proves what the
 * session ROUTES do -- that signing out ends the session on the server, that a second sign-in
 * is a fresh id, that the throttle keys on the real client, that the first-run key is spent
 * once, and that a forwarded scheme is believed only from a trusted peer. That every API route
 * declares a minimum role is an invariant, and lives in
 * `test/web/invariants/route-registry.test.ts`.
 *
 * FRESH MODULES PER TEST: the sign-in throttle is module state in `web/security.ts`, which
 * earlier releases' suite cleared per test.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';

import type * as AppNS from '../../../src/web/app';
import type * as FirstrunNS from '../../../src/core/firstrun';
import type * as InspectNS from '../../../src/core/lifecycle/inspect';
import type * as SecurityNS from '../../../src/web/security';
import type * as SessionsNS from '../../../src/core/sessions';
import type * as UsersNS from '../../../src/core/users';

const PASSWORD = 'correct-horse-battery';
/** What a TLS-terminating proxy adds, and the same-origin marker a browser sends. */
const FWD = {
  host: 'localhost',
  'x-forwarded-proto': 'https',
  'x-forwarded-for': '203.0.113.9',
  'sec-fetch-site': 'same-origin',
};

let home = '';
let createApp: typeof AppNS.createApp;
let users: typeof UsersNS;
let sessions: typeof SessionsNS;
let security: typeof SecurityNS;
let firstrun: typeof FirstrunNS;
const apps: FastifyInstance[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-session-route-'));
  process.env.HOUSTON_HOME = home;
  jest.resetModules();
  jest.doMock('../../../src/core/lifecycle/inspect', () => ({
    ...jest.requireActual<typeof InspectNS>('../../../src/core/lifecycle/inspect'),
    listRepros: async () => [],
  }));
  ({ createApp } = require('../../../src/web/app') as typeof AppNS);
  users = require('../../../src/core/users') as typeof UsersNS;
  sessions = require('../../../src/core/sessions') as typeof SessionsNS;
  security = require('../../../src/web/security') as typeof SecurityNS;
  firstrun = require('../../../src/core/firstrun') as typeof FirstrunNS;
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  jest.dontMock('../../../src/core/lifecycle/inspect');
  fs.rmSync(home, { recursive: true, force: true });
});

async function appWith(
  options: Parameters<typeof AppNS.createApp>[0] = {},
): Promise<FastifyInstance> {
  const app = await createApp({ accounts: true, ...options });
  await app.ready();
  apps.push(app);
  return app;
}

/** An accounts-mode app with alice as an admin and nobody signed in: `anon_client`. */
async function anonymous(
  options: Parameters<typeof AppNS.createApp>[0] = {},
): Promise<FastifyInstance> {
  await users.add('alice', PASSWORD, 'admin');
  return await appWith(options);
}

const cookieOf = (response: { headers: Record<string, unknown> }): string =>
  String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';

function formSignIn(
  app: FastifyInstance,
  user: string,
  password: string,
  extra: InjectOptions['headers'] = {},
) {
  return app.inject({
    method: 'POST',
    url: '/signin',
    payload: `user=${encodeURIComponent(user)}&password=${encodeURIComponent(password)}`,
    headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded', ...extra },
  });
}

/** A proxy at `127.0.0.1`, or any block, as `serve --trust-proxy` builds one. */
function trusted(address: string, prefix = 32): SecurityNS.TrustedNetwork {
  const block = new net.BlockList();
  block.addSubnet(address, prefix, 'ipv4');
  return { contains: (candidate) => block.check(candidate, 'ipv4') };
}

describe('the sign-in page', () => {
  it('keeps this page’s own Origin, which no-referrer would have nulled', async () => {
    // `no-referrer` makes a same-origin form POST arrive as `Origin: null`, which the guard
    // cannot match -- fatal on `serve --insecure`, where browsers omit Sec-Fetch-*.
    const response = await (
      await anonymous()
    ).inject({ url: '/signin', headers: { host: 'localhost' } });
    expect(response.headers['referrer-policy']).toBe('same-origin');
  });

  it('is where an anonymous page navigation is sent, carrying why', async () => {
    const response = await (await anonymous()).inject({ url: '/', headers: { host: 'localhost' } });
    expect(response.statusCode).toBe(303);
    expect(String(response.headers.location)).toMatch(/^\/signin\?e=required/u);
  });

  it('and its stylesheet are reachable signed out', async () => {
    const app = await anonymous();
    const page = await app.inject({ url: '/signin', headers: { host: 'localhost' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form method="post" action="/signin"');
    expect((await app.inject({ url: '/app.css', headers: { host: 'localhost' } })).statusCode).toBe(
      200,
    );
  });

  it('is rendered in the theme the browser is using, and only one of the two literals', async () => {
    // The page has no script, so the server stamps the theme from app.js's cookie.
    const app = await anonymous();
    const page = (theme?: string) =>
      app.inject({
        url: '/signin',
        headers: {
          host: 'localhost',
          ...(theme === undefined ? {} : { cookie: `houston_theme=${theme}` }),
        },
      });
    expect((await page()).body).not.toContain('data-theme');
    expect((await page('dark')).body).toContain('<html lang="en" data-theme="dark">');
    expect((await page('light')).body).toContain('<html lang="en" data-theme="light">');
    // A cookie is attacker-settable, and the value lands in the document.
    for (const junk of ['dark"><script>alert(1)</script>', 'DARK', '', '; --bg: red']) {
      const body = (await page(encodeURIComponent(junk))).body;
      expect({
        junk,
        theme: body.includes('data-theme'),
        script: body.includes('<script>alert'),
      }).toEqual({ junk, theme: false, script: false });
    }
  });

  it('warns about an unencrypted hop only when the SAME decision says it is one', async () => {
    // Deriving the banner and the cookie independently is how a misconfigured proxy mints a
    // cookie the browser then sends in clear. Non-loopback peers: on loopback the password
    // crosses no network and the warning is suppressed regardless.
    const warned = await (
      await anonymous()
    ).inject({ url: '/signin', headers: FWD, remoteAddress: '10.0.0.9' });
    expect(warned.body).toContain('not encrypted');
    const quiet = await (
      await appWith({ trustedProxies: [trusted('10.0.0.0', 8)] })
    ).inject({
      url: '/signin',
      headers: FWD,
      remoteAddress: '10.0.0.9',
    });
    expect(quiet.body).not.toContain('not encrypted');
  });
});

describe('signing in', () => {
  it('sets an HttpOnly, SameSite=Lax session cookie and admits', async () => {
    const app = await anonymous();
    const response = await formSignIn(app, 'alice', PASSWORD);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/');
    const set = String(response.headers['set-cookie']);
    expect(set).toContain('houston_session=');
    expect(set).toMatch(/HttpOnly/iu);
    expect(set).toMatch(/SameSite=Lax/iu);
    expect(
      (
        await app.inject({
          url: '/api/repros',
          headers: { host: 'localhost', cookie: cookieOf(response) },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('host-prefixes the cookie and marks it Secure only when the browser’s hop is https', async () => {
    // __Host- requires Secure, which http://localhost cannot have, so the transport decides.
    const response = await formSignIn(await anonymous({ publicHttps: true }), 'alice', PASSWORD);
    expect(response.statusCode).toBe(303);
    expect(String(response.headers['set-cookie'])).toContain('__Host-houston_session=');
    expect(String(response.headers['set-cookie'])).toContain('Secure');
  });

  it('refuses a wrong password and an unknown user, and mints nothing for either', async () => {
    const app = await anonymous();
    for (const [user, password] of [
      ['alice', 'wrong-x-x-x-x'],
      ['ghost', PASSWORD],
    ] as const) {
      const response = await formSignIn(app, user, password);
      expect(response.statusCode).toBe(303);
      expect(String(response.headers.location)).toMatch(/^\/signin\?e=bad/u);
      expect(response.headers).not.toHaveProperty('set-cookie');
    }
  });

  it('mints a fresh id every time, so a session cannot be fixed', async () => {
    const app = await anonymous();
    const first = await formSignIn(app, 'alice', PASSWORD);
    const second = await formSignIn(app, 'alice', PASSWORD);
    expect(first.headers['set-cookie']).not.toEqual(second.headers['set-cookie']);
  });

  it('accepts a same-origin form POST whose Origin a browser nulled', async () => {
    // The regression only a real browser found: every HTTP test passed because the test
    // client sends neither header.
    const response = await formSignIn(await anonymous(), 'alice', PASSWORD, {
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/');
  });

  it('files a dotted name’s session under the STORED name, so a reset still ends it', async () => {
    // verify() accepts `lucy.felix` for the `lucy-felix` account; filing the session as typed
    // meant a password reset ended none of that account's sessions.
    const app = await anonymous();
    await users.add('lucy.felix', PASSWORD);
    const response = await formSignIn(app, 'lucy.felix', PASSWORD, {
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    });
    expect(response.statusCode).toBe(303);
    const token = cookieOf(response).split('=').slice(1).join('=');
    expect((await sessions.verify(token))?.user).toBe('lucy-felix');
    expect(await users.setPassword('lucy.felix', 'a-brand-new-password')).toBe(1);
    expect(await sessions.verify(token)).toBeNull();
  });

  it('is throttled per ADDRESS, so nobody can lock a colleague out by guessing at their name', async () => {
    // scrypt runs on exactly one endpoint, which is what makes a guessing bound possible.
    const app = await anonymous();
    for (let attempt = 0; attempt < security.SIGNIN_MAX_FAILURES; attempt += 1) {
      await formSignIn(app, 'alice', 'nope-nope-nope');
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { user: 'alice', password: 'nope-nope-nope' },
      headers: { host: 'localhost' },
    });
    expect(blocked.statusCode).toBe(429);
    // A DIFFERENT client signs alice in normally while the guesser is still blocked.
    const other = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { user: 'alice', password: PASSWORD },
      headers: { host: 'localhost' },
      remoteAddress: '127.0.0.2',
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().user).toBe('alice');
  });
});

describe('a session', () => {
  it('is ended on the SERVER by signing out: the same cookie replayed is refused', async () => {
    const app = await anonymous();
    const cookie = cookieOf(await formSignIn(app, 'alice', PASSWORD));
    const as = { host: 'localhost', cookie };
    expect((await app.inject({ url: '/api/repros', headers: as })).statusCode).toBe(200);
    const out = await app.inject({ method: 'POST', url: '/signout', headers: as });
    expect(out.statusCode).toBe(303);
    expect(out.headers.location).toBe('/signin?e=signedout');
    expect((await app.inject({ url: '/api/repros', headers: as })).statusCode).toBe(401);
  });

  it('is who-am-i now, which /api/health no longer answers', async () => {
    const app = await anonymous();
    const as = { host: 'localhost', cookie: cookieOf(await formSignIn(app, 'alice', PASSWORD)) };
    expect((await app.inject({ url: '/api/health', headers: as })).json()).not.toHaveProperty(
      'actor',
    );
    expect((await app.inject({ url: '/api/session', headers: as })).json()).toMatchObject({
      user: 'alice',
      accounts: true,
    });
  });

  it('is answerable without being signed in, so the page can tell signed-out from no-accounts', async () => {
    const me = await (
      await anonymous()
    ).inject({ url: '/api/session', headers: { host: 'localhost' } });
    expect(me.json()).toEqual({ user: '', role: '', accounts: true });
  });

  it('can be listed, and revoked by its short id alone', async () => {
    // "I signed in on the customer's laptop" -- which only has an answer because the session
    // lives on the server.
    const app = await anonymous();
    const as = { host: 'localhost', cookie: cookieOf(await formSignIn(app, 'alice', PASSWORD)) };
    const rows = (await app.inject({ url: '/api/sessions', headers: as })).json().sessions as {
      sid: string;
      current: boolean;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.current).toBe(true);
    // The full verifier must never be handed out.
    expect(rows[0]?.sid).toHaveLength(8);
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/sessions?sid=${rows[0]?.sid ?? ''}`,
      headers: as,
    });
    expect(revoked.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/sessions', headers: as })).statusCode).toBe(401);
  });
});

describe('the first account', () => {
  async function firstRun(): Promise<[FastifyInstance, string]> {
    const key = firstrun.mint();
    return [await appWith({ firstRun: true }), key];
  }
  const create = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/session/first-run',
      payload,
      headers: { host: 'localhost' },
    });

  it('is created by spending the key, in one step with no anonymous admin in between', async () => {
    const [app, key] = await firstRun();
    expect((await app.inject({ url: '/setup', headers: { host: 'localhost' } })).statusCode).toBe(
      200,
    );
    const made = await create(app, { key, user: 'alice', password: 'alice-good-password' });
    expect(made.statusCode).toBe(200);
    expect(made.json()).toEqual({ user: 'alice', role: 'admin' });
    expect(String(made.headers['set-cookie'])).toContain('houston_session=');
    const me = await app.inject({
      url: '/api/session',
      headers: { host: 'localhost', cookie: cookieOf(made) },
    });
    expect(me.json().role).toBe('admin');
  });

  it('spends the key once, and the setup door disappears with it', async () => {
    const [app, key] = await firstRun();
    await create(app, { key, user: 'alice', password: 'alice-good-password' });
    expect(
      (await create(app, { key, user: 'eve', password: 'eves-good-password' })).statusCode,
    ).toBe(409);
    // A stale bookmark is not a second way in.
    expect((await app.inject({ url: '/setup', headers: { host: 'localhost' } })).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ url: '/setup.js', headers: { host: 'localhost' } })).statusCode,
    ).toBe(404);
  });

  it('is not created by a wrong key', async () => {
    const [app] = await firstRun();
    expect(
      (await create(app, { key: 'not-the-key', user: 'eve', password: 'eves-good-password' }))
        .statusCode,
    ).toBe(401);
    expect(users.anyUsers()).toBe(false);
  });

  it('has no door at all when the flow was never opened', async () => {
    // `serve` opens it only on a loopback bind with no accounts.
    const app = await appWith({ firstRun: false });
    expect((await app.inject({ url: '/setup', headers: { host: 'localhost' } })).statusCode).toBe(
      404,
    );
    expect((await create(app, { key: 'x', user: 'a', password: 'b' })).statusCode).toBe(409);
  });
});

describe('proxies', () => {
  it('are not believed when untrusted: a client cannot claim https for itself', async () => {
    // Earlier releases' server believed X-Forwarded-* from 127.0.0.1 by default, so any local user could
    // rewrite the scheme and the client address, both of which decide security here.
    const response = await formSignIn(await anonymous(), 'alice', PASSWORD, FWD);
    expect(response.statusCode).toBe(303);
    expect(String(response.headers['set-cookie'])).not.toContain('Secure');
    expect(String(response.headers['set-cookie'])).not.toContain('__Host-');
  });

  it('when trusted, make the cookie Secure and host-prefixed', async () => {
    // Behind a TLS-terminating proxy the cookie went out without either, on a public https URL.
    const response = await formSignIn(
      await anonymous({ trustedProxies: [trusted('127.0.0.1')] }),
      'alice',
      PASSWORD,
      FWD,
    );
    expect(response.statusCode).toBe(303);
    expect(String(response.headers['set-cookie'])).toContain('__Host-houston_session=');
    expect(String(response.headers['set-cookie'])).toContain('Secure');
  });

  it('when trusted, let the throttle key on the real client, not on the proxy', async () => {
    // Otherwise one person mistyping ten times locks out the whole team behind it.
    const app = await anonymous({ trustedProxies: [trusted('127.0.0.1')] });
    const signIn = (password: string, forwardedFor = FWD['x-forwarded-for']) =>
      app.inject({
        method: 'POST',
        url: '/api/session',
        payload: { user: 'alice', password },
        headers: { ...FWD, 'x-forwarded-for': forwardedFor },
      });
    for (let attempt = 0; attempt < security.SIGNIN_MAX_FAILURES; attempt += 1)
      await signIn('wrong-wrong-x');
    expect((await signIn('wrong-wrong-x')).statusCode).toBe(429);
    expect((await signIn(PASSWORD, '203.0.113.77')).statusCode).toBe(200);
  });

  it('keep you signed in when you change your own password behind one', async () => {
    // me_password was the one call site of four that did not pass the resolved scheme: it
    // wrote the plain cookie name, which nothing reads, and signed you out having answered ok.
    const app = await anonymous({ trustedProxies: [trusted('127.0.0.1')] });
    const signin = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { user: 'alice', password: PASSWORD },
      headers: FWD,
    });
    expect(signin.statusCode).toBe(200);
    expect(String(signin.headers['set-cookie'])).toMatch(/^__Host-houston_session=/u);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { old: PASSWORD, new: 'a-brand-new-password' },
      headers: { ...FWD, cookie: cookieOf(signin) },
    });
    expect(changed.statusCode).toBe(200);
    const replacement = String(changed.headers['set-cookie']);
    expect(replacement).toMatch(/^__Host-houston_session=/u);
    expect(replacement).toContain('Secure');
    const who = await app.inject({
      url: '/api/session',
      headers: { ...FWD, cookie: cookieOf(changed) },
    });
    expect(who.json().user).toBe('alice');
  });
});

describe('--allow-host *', () => {
  it('widens the Host list and does NOT also trust every Origin', async () => {
    // `_cross_site` resolved Origin through the same closure, so `*` silently disabled the
    // cross-site guard too -- the guard that exists because a forged Origin streamed a
    // workspace's log, LDAP bind passwords included.
    const app = await anonymous({ allowHosts: ['*'] });
    const same = await formSignIn(app, 'alice', PASSWORD, {
      host: 'anything.example',
      origin: 'http://anything.example',
    });
    expect(same.statusCode).toBe(303);
    const cookie = cookieOf(same);
    // The Host half works: that is what `*` is for.
    expect(
      (await app.inject({ url: '/api/health', headers: { host: 'whatever.example' } })).statusCode,
    ).toBe(200);
    // The Origin half does not follow it.
    const forged = await app.inject({
      url: '/api/repros',
      headers: { host: 'anything.example', origin: 'https://evil.example', cookie },
    });
    expect(forged.statusCode).toBe(403);
    const own = await app.inject({
      url: '/api/repros',
      headers: { host: 'anything.example', origin: 'https://anything.example', cookie },
    });
    expect(own.statusCode).not.toBe(403);
  });
});
