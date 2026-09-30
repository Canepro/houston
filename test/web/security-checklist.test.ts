import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as audit from '../../src/core/audit';
import * as envvars from '../../src/core/envvars';
import * as naming from '../../src/core/lifecycle/naming';
import * as sessions from '../../src/core/sessions';
import * as users from '../../src/core/users';
import { PreflightError } from '../../src/lib/errors';
import { createApp, requireSafeServePosture } from '../../src/web/app';
import { COOKIE_PLAIN, SIGNIN_MAX_FAILURES } from '../../src/web/security';

jest.mock('../../src/core/envvars', () => {
  const actual = jest.requireActual('../../src/core/envvars');
  return { ...actual, current: jest.fn(actual.current) };
});
jest.mock('../../src/core/lifecycle/naming', () => {
  const actual = jest.requireActual('../../src/core/lifecycle/naming');
  return { ...actual, resolveName: jest.fn(actual.resolveName) };
});
jest.mock('../../src/core/users', () => {
  const actual = jest.requireActual('../../src/core/users');
  return { ...actual, verify: jest.fn(actual.verify) };
});
jest.mock('../../src/seams/fs/lock', () => {
  const actual = jest.requireActual('../../src/seams/fs/lock');
  return {
    ...actual,
    withFileLock: async (_path: string, body: () => unknown) => await body(),
  };
});

const ATTACKER = '198.51.100.10';
const COLLEAGUE = '203.0.113.77';
const FORM_ATTACKER = '198.51.100.11';
const FORM_COLLEAGUE = '203.0.113.78';
const TRUSTED_PROXY = '192.0.2.40';

afterEach(() => {
  jest.restoreAllMocks();
});

async function readonlySession(): Promise<string> {
  await users.add('reader', 'reader-password-long-enough', 'readonly');
  return await sessions.create('reader', { label: 'security checklist' });
}

function sessionRow(token: string, created: number, lastSeen: number): void {
  const digest = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  fs.writeFileSync(
    sessions.sessionsFile(),
    '# houston GUI sessions. Managed by the server; delete a line to revoke it.\n' +
      '# houston-state: 1\n' +
      '# sha256(token)\tuser\tcreated\tlast_seen\tlabel\torigin\n' +
      `${digest}\treader\t${String(created)}\t${String(lastSeen)}\ttest\tsession\n`,
  );
  sessions.resetCache();
}

describe('security checklist: Fetch Metadata is authoritative', () => {
  it('accepts Origin null from a same-origin browser through the installed guard', async () => {
    const app = await createApp({ accounts: false });
    const response = await app.inject({
      method: 'POST',
      url: '/signin',
      headers: {
        host: 'localhost',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'user=reader&password=wrong&next=%2F',
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/signin?e=nouser&next=/');
    await app.close();
  });

  it('uses Sec-Fetch-Site in both directions when Origin disagrees', async () => {
    const app = await createApp({ accounts: false });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'sec-fetch-site': 'cross-site',
      },
      payload: { user: 'reader', password: 'wrong' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'cross-site request refused', kind: 'Forbidden' });
    await app.close();
  });
});

describe('security checklist: wildcard Host permission does not relax Origin', () => {
  it('allows an arbitrary Host but refuses its state change from a hostile Origin', async () => {
    const app = await createApp({ allowHosts: ['*'], accounts: false });
    const hostile = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host: 'proxy.example', origin: 'https://evil.example' },
      payload: { user: 'reader', password: 'wrong' },
    });
    expect(hostile.statusCode).toBe(403);
    expect(hostile.json().error).toBe('cross-site request refused');
    expect(hostile.headers['referrer-policy']).toBe('same-origin');

    const sameOrigin = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { host: 'proxy.example', origin: 'https://proxy.example' },
      payload: { user: 'reader', password: 'wrong' },
    });
    expect(sameOrigin.statusCode).toBe(401);
    expect(sameOrigin.json().error).toBe('there are no accounts on this server yet');
    await app.close();
  });
});

describe('security checklist: Referrer-Policy remains same-origin', () => {
  it('keeps the policy on both halves of the real sign-in flow', async () => {
    const app = await createApp({ accounts: false });
    const page = await app.inject({
      method: 'GET',
      url: '/signin',
      headers: { host: 'localhost' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(page.headers['referrer-policy']).not.toBe('no-referrer');

    const submitted = await app.inject({
      method: 'POST',
      url: '/signin',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'user=reader&password=wrong&next=%2F',
    });
    expect(submitted.statusCode).toBe(303);
    expect(submitted.headers['referrer-policy']).toBe('same-origin');
    await app.close();
  });
});

describe('security checklist: credential-bearing reads are member-plus', () => {
  it('returns 403 before lookup on logs, env, minted PAT, and arbitrary REST calls', async () => {
    const token = await readonlySession();
    const resolve = jest.mocked(naming.resolveName);
    const environment = jest.mocked(envvars.current);
    const app = await createApp();
    const common = {
      host: 'localhost',
      cookie: `${COOKIE_PLAIN}=${token}`,
      'sec-fetch-site': 'same-origin',
    };
    const requests = [
      app.inject({
        method: 'GET',
        url: '/api/repros/missing-security-target/logs',
        headers: common,
      }),
      app.inject({
        method: 'GET',
        url: '/api/repros/missing-security-target/env',
        headers: common,
      }),
      app.inject({
        method: 'POST',
        url: '/api/repros/missing-security-target/pat',
        headers: common,
        payload: {},
      }),
      app.inject({
        method: 'POST',
        url: '/api/repros/missing-security-target/call',
        headers: common,
        payload: { method: 'GET', path: '/api/v1/me' },
      }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
    expect(resolve).not.toHaveBeenCalled();
    expect(environment).not.toHaveBeenCalled();

    const denied = audit
      .read({ limit: 20 })
      .lines.filter((line) => line.actor === 'reader' && line.outcome === 'denied');
    expect(denied.map((line) => line.label).sort()).toEqual(
      [
        'GET /api/repros/:name/env needs member',
        'GET /api/repros/:name/logs needs member',
        'POST /api/repros/:name/call needs member',
        'POST /api/repros/:name/pat needs member',
      ].sort(),
    );
    await app.close();
  });
});

describe('security checklist: unsafe public bind is refused', () => {
  it.each([
    ['no accounts', { bind: '0.0.0.0', accounts: false, transportProtected: false }],
    ['accounts over plain HTTP', { bind: '0.0.0.0', accounts: true, transportProtected: false }],
  ] as const)('refuses %s with preflight status 3 before listening', (_name, posture) => {
    expect.assertions(3);
    try {
      requireSafeServePosture(posture);
    } catch (error) {
      expect(error).toBeInstanceOf(PreflightError);
      expect((error as PreflightError).exitCode).toBe(3);
      expect((error as Error).message).toContain('0.0.0.0');
    }
  });
});

describe('security checklist: sessions and sign-in throttling', () => {
  it('persists only sha256 of a full 256-bit token', async () => {
    fs.rmSync(sessions.sessionsFile(), { force: true });
    sessions.resetCache();
    const token = await sessions.create('reader');
    const secondToken = await sessions.create('reader');
    const persisted = fs.readFileSync(sessions.sessionsFile(), 'utf8');
    const rawBytes = Buffer.from(token, 'base64url');
    const secondRawBytes = Buffer.from(secondToken, 'base64url');
    const digests = [token, secondToken].map((value) =>
      crypto.createHash('sha256').update(value, 'utf8').digest('hex'),
    );
    const rows = persisted
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('\t'));
    expect(rawBytes).toHaveLength(32);
    expect(secondRawBytes).toHaveLength(32);
    expect(secondToken).not.toBe(token);
    expect(rawBytes.equals(Buffer.alloc(32))).toBe(false);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(secondToken);
    for (const bytes of [rawBytes, secondRawBytes]) {
      expect(persisted).not.toContain(bytes.toString('hex'));
      expect(persisted).not.toContain(bytes.toString('base64'));
    }
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.length === 6)).toBe(true);
    expect(rows.map((row) => row[0]).sort()).toEqual(digests.sort());
  });

  it('requests exactly 32 cryptographic random bytes on the real mint path', async () => {
    const realCrypto = jest.requireActual('node:crypto') as typeof crypto;
    const randomBytes = jest.fn((size: number) => Buffer.alloc(size, 0x5a));
    jest.doMock('node:crypto', () => ({ ...realCrypto, randomBytes }));
    try {
      await jest.isolateModulesAsync(async () => {
        const isolated = await import('../../src/core/sessions');
        fs.rmSync(isolated.sessionsFile(), { force: true });
        isolated.resetCache();
        const token = await isolated.create('reader');
        expect(Buffer.from(token, 'base64url')).toEqual(Buffer.alloc(32, 0x5a));
      });
    } finally {
      jest.dontMock('node:crypto');
    }
    expect(randomBytes).toHaveBeenCalledWith(32);
  });

  it('enforces literal 12-hour idle and 7-day absolute boundaries independently', async () => {
    const idleToken = 'idle-boundary-token';
    const idleCreated = 2_000_000_000;
    const idleSeen = idleCreated + 60;
    sessionRow(idleToken, idleCreated, idleSeen);
    jest.spyOn(Date, 'now').mockReturnValue((idleSeen + 12 * 60 * 60 - 1) * 1000);
    expect(await sessions.verify(idleToken)).not.toBeNull();
    jest.restoreAllMocks();
    sessionRow(idleToken, idleCreated, idleSeen);
    jest.spyOn(Date, 'now').mockReturnValue((idleSeen + 12 * 60 * 60) * 1000);
    expect(await sessions.verify(idleToken)).toBeNull();
    jest.restoreAllMocks();

    const absoluteToken = 'absolute-boundary-token';
    const absoluteCreated = 2_000_000_000;
    const recentSeen = absoluteCreated + 7 * 24 * 60 * 60 - 60;
    sessionRow(absoluteToken, absoluteCreated, recentSeen);
    jest.spyOn(Date, 'now').mockReturnValue((absoluteCreated + 7 * 24 * 60 * 60 - 1) * 1000);
    expect(await sessions.verify(absoluteToken)).not.toBeNull();
    jest.restoreAllMocks();
    sessionRow(absoluteToken, absoluteCreated, recentSeen);
    jest.spyOn(Date, 'now').mockReturnValue((absoluteCreated + 7 * 24 * 60 * 60) * 1000);
    expect(await sessions.verify(absoluteToken)).toBeNull();
  });

  it('flushes last_seen to disk at most once per literal minute', async () => {
    const realFs = jest.requireActual('node:fs') as typeof fs;
    const writeSync = jest.fn(realFs.writeSync);
    jest.doMock('node:fs', () => ({ ...realFs, writeSync }));
    const now = 2_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now * 1000);
    try {
      await jest.isolateModulesAsync(async () => {
        const isolated = await import('../../src/core/sessions');
        fs.rmSync(isolated.sessionsFile(), { force: true });
        isolated.resetCache();
        const token = await isolated.create('reader');
        expect(writeSync).toHaveBeenCalledTimes(1);
        await isolated.verify(token);
        expect(writeSync).toHaveBeenCalledTimes(2);
        jest.spyOn(Date, 'now').mockReturnValue((now + 59) * 1000);
        await isolated.verify(token);
        expect(writeSync).toHaveBeenCalledTimes(2);
        jest.spyOn(Date, 'now').mockReturnValue((now + 60) * 1000);
        await isolated.verify(token);
        expect(writeSync).toHaveBeenCalledTimes(3);
      });
    } finally {
      jest.dontMock('node:fs');
    }
  });

  it('keys both sign-in endpoints by resolved address and stops before another scrypt', async () => {
    if (!users.anyUsers()) {
      await users.add('reader', 'reader-password-long-enough', 'readonly');
    }
    const verify = jest.mocked(users.verify);
    const cases = [
      { path: '/api/session', attacker: ATTACKER, colleague: COLLEAGUE, rateStatus: 429 },
      { path: '/signin', attacker: FORM_ATTACKER, colleague: FORM_COLLEAGUE, rateStatus: 303 },
    ] as const;
    for (const item of cases) {
      verify.mockClear();
      const app = await createApp({
        trustedProxies: [{ contains: (address) => address === TRUSTED_PROXY }],
      });
      const attempt = (address: string, password: string) =>
        app.inject({
          method: 'POST',
          url: item.path,
          remoteAddress: TRUSTED_PROXY,
          headers: {
            host: 'localhost',
            'sec-fetch-site': 'same-origin',
            'x-forwarded-for': address,
            ...(item.path === '/signin'
              ? { 'content-type': 'application/x-www-form-urlencoded' }
              : {}),
          },
          payload:
            item.path === '/signin'
              ? `user=reader&password=${password}&next=%2F`
              : { user: 'reader', password },
        });
      for (let count = 0; count < SIGNIN_MAX_FAILURES; count += 1) {
        const response = await attempt(item.attacker, 'wrong-password');
        expect(response.statusCode).toBe(item.path === '/signin' ? 303 : 401);
        if (item.path === '/signin') expect(response.headers.location).toContain('e=bad');
      }
      expect(verify).toHaveBeenCalledTimes(10);
      const throttled = await attempt(item.attacker, 'wrong-password');
      expect(throttled.statusCode).toBe(item.rateStatus);
      if (item.path === '/signin') expect(throttled.headers.location).toContain('e=rate');
      expect(verify).toHaveBeenCalledTimes(10);
      const other = await attempt(item.colleague, 'reader-password-long-enough');
      expect(other.statusCode).toBe(item.path === '/signin' ? 303 : 200);
      expect(verify).toHaveBeenCalledTimes(11);
      await app.close();
    }
  });
});

/**
 * What earlier releases' web front door answered to the same requests, recorded: the
 * sign-in redirect's Location per target, and every header of every answer (a session
 * cookie's value written as TOKEN).
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'web', 'security-checklist.json'), 'utf8'),
) as { signin_locations: string[]; headers: [string, string][][] };

describe('security checklist: the sign-in redirect carries next as earlier releases quote it', () => {
  // It is held to earlier releases' guard itself, as their server scoped a request: the path
  // percent-decoded, the raw query beside it. Not '/bad%zz' or '/%FF': Fastify refuses a path
  // it cannot decode (400 FST_ERR_BAD_URL) before any hook runs, where earlier releases
  // redirect -- a routing difference of its own.
  const TARGETS = [
    '/',
    '/?a=1&b=2',
    '/repro/x%20y',
    '/%2F',
    '/a%3Fb?c=d',
    '/caf%C3%A9',
    '/x?q=%2F',
    '/a%23b',
    '/%E2%82%AC?x=~',
    '/x?',
    '/q?x=a+b&y=%20',
    '/~u/._-',
    "/s;p,@!$'()*",
    '/%09tab',
  ];

  it("sends a browser without a session to /signin with next quoted, '/?=&' kept, as earlier releases do", async () => {
    const recorded = RECORDED.signin_locations;
    expect(recorded).toHaveLength(TARGETS.length);
    const app = await createApp({ accounts: true, allowHosts: ['localhost'] });
    const ours: string[] = [];
    for (const target of TARGETS) {
      const response = await app.inject({
        method: 'GET',
        url: target,
        headers: { host: 'localhost' },
      });
      expect(response.statusCode).toBe(303);
      ours.push(String(response.headers.location));
    }
    await app.close();
    expect(ours).toEqual(recorded);
    expect(ours[0]).toBe('/signin?e=required&next=/');
  });
});

describe('security checklist: every answer carries the headers earlier releases send', () => {
  // Method, path, headers, body -- sent with no cookie, one at a time, to both servers.
  const PASSWORD = 'correct-horse-battery-9';
  const REQUESTS: [string, string, Record<string, string>, string][] = [
    ['GET', '/api/settings', {}, ''],
    ['GET', '/api/health', { host: 'evil.example' }, ''],
    ['GET', '/', { host: 'evil.example' }, ''],
    ['GET', '/', {}, ''],
    ['POST', '/api/repros', { origin: 'http://evil.example' }, ''],
    ['GET', '/signin', {}, ''],
    ['GET', '/setup.js', {}, ''],
    [
      'POST',
      '/signin',
      { 'content-type': 'application/x-www-form-urlencoded' },
      `user=alice&password=${PASSWORD}&next=/`,
    ],
    ['POST', '/signout', {}, ''],
    [
      'POST',
      '/api/session',
      { 'content-type': 'application/json' },
      JSON.stringify({ user: 'alice', password: PASSWORD }),
    ],
    ['DELETE', '/api/session', {}, ''],
  ];
  // What the transports add of their own (a `server` header, Node's keep-alive pair) and
  // what differs by the clock or the byte count.
  const TRANSPORT = new Set(['date', 'content-length', 'server', 'connection', 'keep-alive']);

  function normalised(headers: [string, string][]): string[] {
    return headers
      .filter(([name]) => !TRANSPORT.has(name.toLowerCase()))
      .map(([name, value]) => {
        let shown = value;
        if (name.toLowerCase() === 'set-cookie') {
          shown = shown
            .replace(/^([^=]+)=(?!"")[^;]*/u, '$1=TOKEN')
            .replace(/expires=[^;]*/u, 'expires=NOW');
        }
        return `${name.toLowerCase()}: ${shown}`;
      })
      .sort();
  }

  it('puts the security headers on the guard refusals, sends application/json, and writes Set-Cookie as earlier releases do', async () => {
    await users.add('alice', PASSWORD, 'admin');
    const recorded = RECORDED.headers.map(normalised);
    expect(recorded).toHaveLength(REQUESTS.length);
    const app = await createApp({ accounts: true, allowHosts: ['localhost'] });
    const ours: string[][] = [];
    for (const [method, url, headers, body] of REQUESTS) {
      const response = await app.inject({
        method: method as 'GET',
        url,
        headers: { host: 'localhost', ...headers },
        ...(body === '' ? {} : { payload: body }),
      });
      const pairs: [string, string][] = [];
      for (const [name, value] of Object.entries(response.headers)) {
        for (const one of Array.isArray(value) ? value : [value]) pairs.push([name, String(one)]);
      }
      ours.push(normalised(pairs));
    }
    await app.close();
    expect(ours).toEqual(recorded);
  });
});
