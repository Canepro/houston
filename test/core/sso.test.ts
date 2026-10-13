/**
 * `core/sso`: Okta sign-in against a fake identity provider.
 *
 * The provider is the HTTP seam replaced, which is what the seam is for
 * (`test/fixtures/core/fake-idp.ts`). Each test gets a fresh home.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from '../../src/lib/config';
import * as sessions from '../../src/core/sessions';
import * as sso from '../../src/core/sso';
import * as identities from '../../src/core/sso-identities';
import * as users from '../../src/core/users';
import { rcHttp } from '../../src/seams/rc-http';
import { CLIENT, FakeIdp, ISSUER, KEY_A, KEY_B, SECRET } from '../fixtures/core/fake-idp';

const PUBLIC = 'https://houston.example.test';
const BROWSER = 'b'.repeat(43);
const PASSWORD = 'correct-horse-battery';

const SETTINGS: sso.Settings = {
  issuer: ISSUER,
  clientId: CLIENT,
  publicUrl: PUBLIC,
  emailDomains: ['rocket.chat'],
  provision: 'member',
  secret: SECRET,
};

let idp: FakeIdp;
let home = '';

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-sso-'));
  process.env.HOUSTON_HOME = home;
  sso.resetForTests();
  idp = new FakeIdp(`${PUBLIC}/signin`);
  jest
    .spyOn(rcHttp, 'request')
    .mockImplementation(async (url, options) => idp.answer(url, options));
  await users.add('root', PASSWORD, 'admin');
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env[sso.SECRET_ENV];
  fs.rmSync(home, { recursive: true, force: true });
});

/** Start a sign-in as the browser would, and remember what the provider was asked. */
async function begin(browser = BROWSER, next = '/'): Promise<string> {
  const url = new URL(await sso.start(SETTINGS, browser, next));
  const state = url.searchParams.get('state') ?? '';
  idp.started.set(`code-${state}`, {
    nonce: url.searchParams.get('nonce') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
  });
  return state;
}

async function signIn(settings = SETTINGS): Promise<sso.SignedIn> {
  const state = await begin();
  return await sso.finish(settings, { state, code: `code-${state}`, error: '' }, BROWSER);
}

async function refused(code: string, settings = SETTINGS): Promise<void> {
  await expect(signIn(settings)).rejects.toMatchObject({ name: 'Refusal', code });
}

function bindings(): identities.Binding[] {
  return identities.read().bindings;
}

describe('the settings', () => {
  it('stores what config set accepts, normalised, and refuses the rest', () => {
    expect(sso.checkSetting('sso.issuer', 'https://login.rocket.chat')).toBe(
      'https://login.rocket.chat',
    );
    expect(sso.checkSetting('sso.public_url', 'https://houston.support.rocket.chat/')).toBe(
      'https://houston.support.rocket.chat',
    );
    expect(sso.checkSetting('sso.public_url', 'http://localhost:9955')).toBe(
      'http://localhost:9955',
    );
    expect(sso.checkSetting('sso.email_domains', 'Rocket.Chat,example.com')).toBe(
      'rocket.chat,example.com',
    );
    for (const [key, value] of [
      ['sso.issuer', 'http://login.rocket.chat'],
      ['sso.issuer', 'https://login.rocket.chat?x=1'],
      ['sso.public_url', 'http://houston.example.com'],
      ['sso.public_url', 'https://houston.example.com/app'],
      ['sso.email_domains', 'rocket.chat, example.com'],
      ['sso.email_domains', '@rocket.chat'],
      ['sso.provision', 'admin'],
      ['sso.client_id', ''],
    ] as const) {
      expect(() => sso.checkSetting(key, value)).toThrow(/sso\./u);
    }
  });

  it('turns on with the issuer, last, and reads the secret strictly', () => {
    expect(sso.readiness()).toEqual({ state: 'off' });
    expect(() => sso.requireReadyForIssuer({})).toThrow(
      'set sso.client_id, sso.public_url, sso.email_domains first',
    );
    config.saveConfig({
      'sso.issuer': ISSUER,
      'sso.client_id': CLIENT,
      'sso.public_url': PUBLIC,
      'sso.email_domains': 'rocket.chat',
    });
    expect(sso.readiness()).toMatchObject({ state: 'broken', why: /no client secret/u });
    const file = path.join(home, sso.SECRET_FILE);
    for (const [content, mode, why] of [
      [`${sso.SECRET_ENV}=${SECRET}\n`, 0o644, /mode 0600/u],
      [`${sso.SECRET_ENV}="${SECRET}"\n`, 0o600, /unquoted/u],
      [`${sso.SECRET_ENV}=${SECRET}\n${sso.SECRET_ENV}=again\n`, 0o600, /exactly one line/u],
      [`OTHER=${SECRET}\n`, 0o600, /exactly one line/u],
    ] as const) {
      fs.writeFileSync(file, content);
      fs.chmodSync(file, mode);
      expect(sso.readiness()).toMatchObject({ state: 'broken', why });
    }
    fs.writeFileSync(file, `# the Okta app's secret\n${sso.SECRET_ENV}=${SECRET}\r\n`);
    fs.chmodSync(file, 0o600);
    expect(sso.readiness()).toEqual({
      state: 'ready',
      settings: { ...SETTINGS, provision: 'off' },
    });
    process.env[sso.SECRET_ENV] = 'from-the-environment';
    expect(sso.readiness()).toMatchObject({ settings: { secret: 'from-the-environment' } });
  });
});

describe('the protocol', () => {
  it('sends the browser to the provider with PKCE, state and nonce', async () => {
    const url = new URL(await sso.start(SETTINGS, BROWSER, '/x'));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth2/v1/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: `${PUBLIC}/signin`,
      scope: 'openid profile email',
      code_challenge_method: 'S256',
    });
    for (const name of ['state', 'nonce', 'code_challenge']) {
      expect(url.searchParams.get(name)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }
  });

  it('signs a new Okta person in as a new member named after their username', async () => {
    expect(await signIn()).toEqual({ name: 'ana-lopez', next: '/' });
    expect(users.roleOf('ana-lopez')).toBe('member');
    expect(bindings()).toEqual([
      expect.objectContaining({
        issuer: ISSUER,
        sub: '00u-ana',
        name: 'ana-lopez',
        email: 'ana.lopez@rocket.chat',
        display: 'ana.lopez@rocket.chat',
        status: 'active',
      }),
    ]);
    expect(fs.statSync(identities.identitiesFile()).mode & 0o777).toBe(0o600);
    const audit = fs.readFileSync(path.join(home, 'audit.log'), 'utf8');
    expect(audit).toMatch(/\tana-lopez\tuser-add\tana-lopez role=member\tsso\t/u);
    expect(audit).toMatch(/\tana-lopez\tsso-provision\t/u);
    // Every provider call: no redirect followed, a deadline, and the size cap.
    for (const { options } of idp.calls) {
      expect(options).toMatchObject({ followRedirects: false, maxBytes: 256 * 1024 });
      expect(options.timeoutMs).toBeLessThanOrEqual(10_000);
    }
  });

  it.each([
    // Key B's signature under key A's kid: a published kid, a signature it does not verify.
    ['another key signed it', () => ((idp.signWith = KEY_B), (idp.header = { kid: KEY_A.kid }))],
    ['its kid is published nowhere', () => (idp.signWith = KEY_B)],
    ['alg is not RS256', () => (idp.header = { alg: 'HS256' })],
    ['another issuer', () => (idp.claims = { iss: 'https://evil.example.test' })],
    ['another audience', () => (idp.claims = { aud: 'someone-else' })],
    ['a shared audience', () => (idp.claims = { aud: [CLIENT, 'someone-else'] })],
    ['another azp', () => (idp.claims = { azp: 'someone-else' })],
    ['expired', () => (idp.claims = { exp: Math.floor(Date.now() / 1000) - 120 })],
    ['issued in the future', () => (idp.claims = { iat: Math.floor(Date.now() / 1000) + 600 })],
    ['another nonce', () => (idp.claims = { nonce: 'n'.repeat(43) })],
    ['a crit header', () => (idp.header = { crit: ['exp'] })],
    ['userinfo for another sub', () => (idp.userinfo = { sub: '00u-someone-else' })],
  ])('refuses an ID token when %s', async (_why, arrange) => {
    arrange();
    await refused('token');
    expect(users.roleOf('ana-lopez')).toBe('');
  });

  it('refuses an email that is not verified, or not in an allowed domain', async () => {
    idp.userinfo = { email_verified: 'true' };
    await refused('email');
    idp.userinfo = { email: 'ana@gmail.com' };
    await refused('domain');
    expect(users.roleOf('ana-lopez')).toBe('');
  });

  it('follows a key rotation once, and not again within the minute', async () => {
    await signIn();
    const keyReads = (): number => idp.calls.filter((c) => c.url.endsWith('/keys')).length;
    expect(keyReads()).toBe(1);
    idp.keys = [KEY_A, KEY_B];
    idp.signWith = KEY_B;
    // Fetched a moment ago: an unknown kid now is refused without asking again.
    await refused('token');
    expect(keyReads()).toBe(1);
    const later = Date.now() + 61_000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    expect((await signIn()).name).toBe('ana-lopez');
    expect(keyReads()).toBe(2);
  });

  it('refuses a provider that names another issuer or an endpoint off its origin', async () => {
    idp.discovery = { issuer: `${ISSUER}/` };
    await expect(sso.start(SETTINGS, BROWSER, '/')).rejects.toMatchObject({ code: 'provider' });
    sso.resetForTests();
    idp.discovery = { token_endpoint: 'https://elsewhere.example.test/token' };
    await expect(sso.start(SETTINGS, BROWSER, '/')).rejects.toMatchObject({ code: 'provider' });
    sso.resetForTests();
    idp.discovery = { userinfo_endpoint: `http://idp.example.test/oauth2/v1/userinfo` };
    await expect(sso.start(SETTINGS, BROWSER, '/')).rejects.toMatchObject({ code: 'provider' });
  });

  it('says the provider is down, and never retries the code', async () => {
    const state = await begin();
    idp.down = true;
    await expect(
      sso.finish(SETTINGS, { state, code: `code-${state}`, error: '' }, BROWSER),
    ).rejects.toMatchObject({ code: 'down' });
    expect(idp.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  it('spends a pending sign-in once, for the browser that started it, for ten minutes', async () => {
    const state = await begin();
    const callback = { state, code: `code-${state}`, error: '' };
    await expect(sso.finish(SETTINGS, callback, 'c'.repeat(43))).rejects.toMatchObject({
      code: 'expired',
    });
    // Spent by the attempt above, so even the right browser is too late now.
    await expect(sso.finish(SETTINGS, callback, BROWSER)).rejects.toMatchObject({
      code: 'expired',
    });
    const late = await begin();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + sso.PENDING_MS + 1);
    await expect(
      sso.finish(SETTINGS, { state: late, code: `code-${late}`, error: '' }, BROWSER),
    ).rejects.toMatchObject({ code: 'expired' });
    jest.restoreAllMocks();
    jest.spyOn(rcHttp, 'request').mockImplementation(async (url, o) => idp.answer(url, o));
    const denied = await begin();
    await expect(
      sso.finish(SETTINGS, { state: denied, code: '', error: 'access_denied' }, BROWSER),
    ).rejects.toMatchObject({ code: 'denied' });
  });

  it('keeps at most 512 pending sign-ins, letting the oldest go', async () => {
    const first = await begin();
    for (let index = 0; index < sso.PENDING_MAX; index += 1) await begin();
    await expect(
      sso.finish(SETTINGS, { state: first, code: `code-${first}`, error: '' }, BROWSER),
    ).rejects.toMatchObject({ code: 'expired' });
  });

  it('forgets a browser’s pending sign-ins at sign-out', async () => {
    const state = await begin();
    sso.forgetBrowser(BROWSER);
    await expect(
      sso.finish(SETTINGS, { state, code: `code-${state}`, error: '' }, BROWSER),
    ).rejects.toMatchObject({ code: 'expired' });
  });
});

describe('who an Okta person is here', () => {
  it('links an existing member of exactly that name, then follows the sub', async () => {
    await users.add('ana-lopez', PASSWORD, 'member');
    expect((await signIn()).name).toBe('ana-lopez');
    // A renamed Okta login is still the same person.
    idp.person = { ...idp.person, preferred_username: 'ana.garcia@rocket.chat' };
    expect((await signIn()).name).toBe('ana-lopez');
    expect(users.roleOf('ana-garcia')).toBe('');
    expect(bindings()).toHaveLength(1);
    expect(bindings()[0]?.display).toBe('ana.garcia@rocket.chat');
  });

  it('never links a different name: lovekesh and lovekesh.kumar are two accounts', async () => {
    await users.add('lovekesh', PASSWORD, 'admin');
    idp.person = {
      sub: '00u-lk',
      preferred_username: 'lovekesh.kumar@rocket.chat',
      email: 'lovekesh.kumar@rocket.chat',
      email_verified: true,
    };
    expect((await signIn()).name).toBe('lovekesh-kumar');
    expect(users.roleOf('lovekesh-kumar')).toBe('member');
    expect(identities.linked().has('lovekesh')).toBe(false);
  });

  it('links an admin account only after users link-sso, and only once', async () => {
    await users.add('ana-lopez', PASSWORD, 'admin');
    await refused('admin');
    await sso.approveLink('ana-lopez');
    expect((await signIn()).name).toBe('ana-lopez');
    expect(identities.read().approvals).toEqual([]);
    expect(users.roleOf('ana-lopez')).toBe('admin');
    await expect(sso.approveLink('ana-lopez')).rejects.toThrow(
      "'ana-lopez' is already linked to the Okta user ana.lopez@rocket.chat",
    );
    await expect(sso.approveLink('nobody')).rejects.toThrow("no user 'nobody'");
  });

  it('refuses a name already linked to another Okta person', async () => {
    await signIn();
    idp.person = { ...idp.person, sub: '00u-another-ana' };
    await refused('taken');
  });

  it('creates nobody when provisioning is off, there is no admin, or the name is invalid', async () => {
    await refused('noaccount', { ...SETTINGS, provision: 'off' });
    idp.person = { ...idp.person, preferred_username: `${'a'.repeat(32)}@rocket.chat` };
    await refused('name');
    fs.rmSync(users.usersFile());
    await users.add('member-only', PASSWORD, 'member');
    idp.person = { ...idp.person, preferred_username: 'ana.lopez@rocket.chat' };
    await refused('noadmin');
    expect(users.roleOf('ana-lopez')).toBe('');
  });

  it('keeps a removed account removed, for that person and that name', async () => {
    await signIn();
    const token = await sessions.create('ana-lopez', { origin: 'sso' });
    expect(await users.remove('ana-lopez')).toBe(1);
    expect(await sessions.verify(token)).toBeNull();
    expect(bindings()[0]?.status).toBe('disabled');
    await refused('disabled');
    idp.person = { ...idp.person, sub: '00u-new-ana' };
    await refused('disabled');
    expect(users.roleOf('ana-lopez')).toBe('');
    // An admin re-adds the account and approves the name: the new person links.
    await users.add('ana-lopez', PASSWORD, 'member');
    await sso.approveLink('ana-lopez');
    expect((await signIn()).name).toBe('ana-lopez');
  });

  it('gives a re-created account no link left behind for its name', async () => {
    // An active link whose account is gone: 1.x's `users remove`, or a removal while the links
    // file could not be read. The account made next under that name is somebody else's.
    const stale = {
      issuer: ISSUER,
      sub: '00u-ana',
      name: 'ana-lopez',
      email: 'ana.lopez@rocket.chat',
      display: 'ana.lopez@rocket.chat',
      status: 'active' as const,
      at: '2026-10-01T00:00:00.000Z',
    };
    identities.write({ version: 1, bindings: [{ ...stale }], approvals: [] });
    await users.add('ana-lopez', PASSWORD, 'admin');
    await refused('disabled');
    expect(bindings()[0]?.status).toBe('disabled');
    // Gone at sign-in, the link is tombstoned there too, so a later account is not its.
    identities.write({ version: 1, bindings: [{ ...stale, name: 'ana-old' }], approvals: [] });
    await refused('gone');
    expect(bindings()[0]?.status).toBe('disabled');
  });

  it('unlinks: the link is a tombstone, the sessions end, the password stays', async () => {
    await signIn();
    await users.setPassword('ana-lopez', PASSWORD);
    await sessions.create('ana-lopez', { origin: 'sso' });
    expect(await sso.unlink('ana-lopez')).toBe(1);
    await refused('disabled');
    expect(await users.verify('ana-lopez', PASSWORD)).toBe(true);
    await expect(sso.unlink('ana-lopez')).rejects.toThrow("'ana-lopez' is not linked");
    // The undo is the approval, and it re-links the same person.
    await sso.approveLink('ana-lopez');
    expect((await signIn()).name).toBe('ana-lopez');
    expect(bindings()).toHaveLength(1);
  });

  it('refuses everything while the links file is unreadable, and never rewrites it', async () => {
    fs.writeFileSync(
      identities.identitiesFile(),
      '{"version": 2, "bindings": [], "approvals": []}',
    );
    await refused('store');
    expect(fs.readFileSync(identities.identitiesFile(), 'utf8')).toContain('"version": 2');
    await expect(sso.approveLink('root')).rejects.toThrow(/cannot read .*sso-identities\.json/u);
  });

  it('creates one account when the same person’s first two sign-ins race', async () => {
    const first = await begin();
    const second = await begin();
    const results = await Promise.all(
      [first, second].map((state) =>
        sso.finish(SETTINGS, { state, code: `code-${state}`, error: '' }, BROWSER),
      ),
    );
    expect(results.map((r) => r.name)).toEqual(['ana-lopez', 'ana-lopez']);
    expect(bindings()).toHaveLength(1);
    expect(users.listUsers().map((u) => u.name)).toEqual(['ana-lopez', 'root']);
  });
});
