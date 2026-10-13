/// <reference lib="dom" />

/**
 * Okta sign-in in a real browser: the real app, its real redirects and cookies, from the
 * button and from the tile's URL to the dashboard.
 *
 * Two things are stand-ins. The provider's back channel is the HTTP seam answered by
 * `test/fixtures/core/fake-idp.ts`. And its authorize page -- the one place a browser visits
 * the provider -- is skipped the way Okta skips it for a person already signed in to it: the
 * real `/signin` answer is fetched, and its redirect to the provider becomes one straight to
 * the callback with a code. Playwright intercepts only a navigation's first request, so the
 * rewrite is made there, and every later hop -- the callback, the dashboard -- is real.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type * as AppNS from '../../../src/web/app';
import type * as ConfigNS from '../../../src/lib/config';
import type * as InspectNS from '../../../src/core/lifecycle/inspect';
import type * as RcHttpNS from '../../../src/seams/rc-http';
import type * as UsersNS from '../../../src/core/users';
import { CLIENT, FakeIdp, ISSUER, SECRET } from '../../fixtures/core/fake-idp';

describe('Okta sign-in in a browser', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let app: FastifyInstance;
  let idp: FakeIdp;
  let origin = '';
  const pageErrors: string[] = [];

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  beforeEach(async () => {
    const home = process.env.HOUSTON_HOME ?? '';
    for (const file of ['users', 'sessions', 'sso-identities.json', 'config.yaml', 'sso.env']) {
      fs.rmSync(path.join(home, file), { force: true });
    }
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual<typeof InspectNS>('../../../src/core/lifecycle/inspect'),
      listRepros: async () => [],
    }));
    const users = require('../../../src/core/users') as typeof UsersNS;
    await users.add('root', 'correct-horse-battery', 'admin');
    const { createApp } = require('../../../src/web/app') as typeof AppNS;
    app = await createApp({ accounts: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    (require('../../../src/lib/config') as typeof ConfigNS).saveConfig({
      'sso.issuer': ISSUER,
      'sso.client_id': CLIENT,
      'sso.public_url': origin,
      'sso.email_domains': 'rocket.chat',
      'sso.provision': 'member',
    });
    fs.writeFileSync(path.join(home, 'sso.env'), `HOUSTON_SSO_CLIENT_SECRET=${SECRET}\n`, {
      mode: 0o600,
    });
    idp = new FakeIdp(`${origin}/signin`);
    const { rcHttp } = require('../../../src/seams/rc-http') as typeof RcHttpNS;
    jest.spyOn(rcHttp, 'request').mockImplementation(async (url, o) => idp.answer(url, o));
    context = await browser.newContext();
    await context.route(`${origin}/signin?**`, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers().location ?? '';
      if (!location.startsWith(ISSUER)) {
        await route.fulfill({ response });
        return;
      }
      const asked = new URL(location);
      const state = asked.searchParams.get('state') ?? '';
      idp.started.set(`code-${state}`, {
        nonce: asked.searchParams.get('nonce') ?? '',
        challenge: asked.searchParams.get('code_challenge') ?? '',
      });
      const back = `${asked.searchParams.get('redirect_uri') ?? ''}?code=code-${state}&state=${state}`;
      await route.fulfill({ response, headers: { ...response.headers(), location: back } });
    });
    page = await context.newPage();
    pageErrors.length = 0;
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
  });

  afterEach(async () => {
    await context.close();
    await app.close();
    jest.restoreAllMocks();
    jest.dontMock('../../../src/core/lifecycle/inspect');
    expect(pageErrors).toEqual([]);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('signs a new person in from the button and shows their Okta name on the dashboard', async () => {
    await page.goto(`${origin}/signin`);
    await page.getByRole('link', { name: 'Sign in with Okta' }).click();
    await page.waitForURL(`${origin}/`);
    await page.locator('#whoami').waitFor({ state: 'visible' });
    expect(await page.locator('#whoami').textContent()).toBe(
      'ana-lopez · ana.lopez@rocket.chat · member',
    );
  });

  it('signs in from the Okta tile, which opens /signin?iss=<issuer>', async () => {
    await page.goto(`${origin}/signin?iss=${encodeURIComponent(ISSUER)}`);
    await page.waitForURL(`${origin}/`);
    const me = await page.evaluate(async () => (await fetch('/api/session')).json());
    expect(me).toMatchObject({ user: 'ana-lopez', origin: 'sso' });
  });

  it('lands a refused person on the sign-in page with a fixed reason and no code', async () => {
    idp.userinfo = { email: 'ana@gmail.com' };
    await page.goto(`${origin}/signin`);
    await page.getByRole('link', { name: 'Sign in with Okta' }).click();
    await page.waitForURL(`${origin}/signin?e=sso-domain`);
    expect(await page.locator('.signin-banner').textContent()).toBe(
      'Your Okta email address is not one this server accepts.',
    );
    expect(await page.locator('form[action="/signin"]').count()).toBe(1);
  });
});
