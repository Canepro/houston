/**
 * `web/routes/people`: accounts, roles, passwords and the audit view over HTTP.
 *
 * `POST /api/me/password` is among them, and it is a login endpoint in all but name.
 *
 * FRESH MODULES AND A FRESH HOME PER TEST. The sign-in throttle is module state in
 * `web/security.ts`, keyed by client address, and earlier releases' suite cleared it per test;
 * re-requiring the app per test is the same reset, and the throttle
 * case below spends ten failures that would otherwise lock the next case out.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import type * as AppNS from '../../../src/web/app';
import type * as SecurityNS from '../../../src/web/security';
import type * as SessionsNS from '../../../src/core/sessions';
import type * as UsersNS from '../../../src/core/users';

const PASSWORD = 'a-good-enough-password';

let home = '';
let app: FastifyInstance;
let users: typeof UsersNS;
let sessions: typeof SessionsNS;
let security: typeof SecurityNS;
let admin = '';

async function signIn(user: string, password = PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { user, password },
    headers: { host: 'localhost' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}

const as = (cookie: string) => ({ host: 'localhost', cookie });

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-people-'));
  process.env.HOUSTON_HOME = home;
  jest.resetModules();
  users = require('../../../src/core/users') as typeof UsersNS;
  sessions = require('../../../src/core/sessions') as typeof SessionsNS;
  security = require('../../../src/web/security') as typeof SecurityNS;
  const { createApp } = require('../../../src/web/app') as typeof AppNS;
  await users.add('alice', PASSWORD, 'admin');
  app = await createApp({ accounts: true });
  await app.ready();
  admin = await signIn('alice');
});
afterEach(async () => {
  await app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('managing people', () => {
  it('is refused to a member, who may still change their OWN password', async () => {
    await users.add('bob', 'bobs-good-password', 'member');
    const bob = await signIn('bob', 'bobs-good-password');
    expect((await app.inject({ url: '/api/users', headers: as(bob) })).statusCode).toBe(403);
    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { name: 'eve' },
      headers: as(bob),
    });
    expect(create.statusCode).toBe(403);
    const own = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { old: 'bobs-good-password', new: 'another-good-one' },
      headers: as(bob),
    });
    expect(own.statusCode).toBe(200);
  });

  it('mints the password on the server when an admin creates an account', async () => {
    // An admin who TYPES a colleague's password also knows it, which makes every audit
    // line signed with that name deniable.
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { name: 'carol', role: 'member' },
      headers: as(admin),
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { role: string; password: string };
    expect(body.role).toBe('member');
    expect(body.password.length).toBeGreaterThanOrEqual(12);
    // ...and it works.
    const carol = await signIn('carol', body.password);
    expect((await app.inject({ url: '/api/session', headers: as(carol) })).json().user).toBe(
      'carol',
    );
  });

  it('protects the last admin through the API', async () => {
    const demote = await app.inject({
      method: 'POST',
      url: '/api/users/alice/role',
      payload: { role: 'member' },
      headers: as(admin),
    });
    expect(demote.statusCode).toBe(409);
    expect(String(demote.json().error)).toContain('only admin');
    const remove = await app.inject({
      method: 'DELETE',
      url: '/api/users/alice',
      headers: as(admin),
    });
    expect(remove.statusCode).toBe(409);
  });

  it('reads a blank role as admin, the way every pre-roles account was written', async () => {
    // If blank did not mean admin, an install whose only account predates roles would have
    // zero admins and no way to make one.
    const stored = users.readAll();
    stored.set('legacy', [await users.hashPassword('legacy-password-here'), '2026-01-01', '']);
    users.writeAll(stored);
    const rows = (await app.inject({ url: '/api/users', headers: as(admin) })).json() as {
      users: { name: string; role: string; implicit: boolean }[];
      implicit_admins: string[];
    };
    expect(rows.users.find((row) => row.name === 'legacy')).toMatchObject({
      role: 'admin',
      implicit: true,
    });
    expect(rows.implicit_admins).toEqual(['legacy']);
  });

  it('names the Okta email an account is linked to, and only an active link', async () => {
    await users.add('bob', 'bobs-good-password', 'member');
    await users.add('carol', 'carols-good-password', 'member');
    const binding = (name: string, status: string) => ({
      issuer: 'https://login.example.com',
      sub: `00u-${name}`,
      name,
      email: `${name}@example.com`,
      display: name,
      status,
      at: '2026-10-13T00:00:00.000Z',
    });
    fs.writeFileSync(
      path.join(home, 'sso-identities.json'),
      JSON.stringify({
        version: 1,
        bindings: [binding('bob', 'active'), binding('carol', 'disabled')],
        approvals: [],
      }),
    );
    const rows = (await app.inject({ url: '/api/users', headers: as(admin) })).json() as {
      users: { name: string; sso_email?: string }[];
    };
    expect(rows.users.find((row) => row.name === 'bob')?.sso_email).toBe('bob@example.com');
    expect(rows.users.find((row) => row.name === 'carol')).not.toHaveProperty('sso_email');
    expect(rows.users.find((row) => row.name === 'alice')).not.toHaveProperty('sso_email');
  });

  it('ends a user’s live sessions when their role changes', async () => {
    await users.add('bob', 'bobs-good-password', 'member');
    const token = await sessions.create('bob');
    expect(await sessions.verify(token)).not.toBeNull();
    await app.inject({
      method: 'POST',
      url: '/api/users/bob/role',
      payload: { role: 'readonly' },
      headers: as(admin),
    });
    // A demotion must reach a session that is already open.
    expect(await sessions.verify(token)).toBeNull();
  });
});

describe('the audit view', () => {
  it('shows a non-admin only their own lines, whatever actor they ask for', async () => {
    // Self-audit rather than admin-only: "wait, did I do that?" is a legitimate question,
    // and a 403 there teaches people the log is not for them.
    await users.add('bob', 'bobs-good-password', 'member');
    await app.inject({
      method: 'POST',
      url: '/api/users/bob/role',
      payload: { role: 'member' },
      headers: as(admin),
    });
    const bob = await signIn('bob', 'bobs-good-password');
    const out = (await app.inject({ url: '/api/audit?actor=alice', headers: as(bob) })).json() as {
      scope: string;
      lines: { actor: string }[];
    };
    // The actor filter is FORCED, not honoured.
    expect(out.scope).toBe('bob');
    expect(out.lines.every((line) => line.actor === 'bob')).toBe(true);
  });
});

describe('changing your own password', () => {
  it('is throttled like a sign-in, because it derives scrypt on what it is sent', async () => {
    // "scrypt runs HERE and nowhere else, which is what makes a guessing bound possible at
    // all" -- this endpoint quietly made that false, and any signed-in account, readonly
    // included, could spend the threadpool on it without limit.
    const guess = () =>
      app.inject({
        method: 'POST',
        url: '/api/me/password',
        payload: { old: 'not-my-password', new: 'a-brand-new-password' },
        headers: as(admin),
      });
    for (let attempt = 0; attempt < security.SIGNIN_MAX_FAILURES; attempt += 1) {
      // A ValidationError, and still counted.
      expect((await guess()).statusCode).toBe(400);
    }
    const throttled = await guess();
    expect(throttled.statusCode).toBe(429);
    // A 429 that does not say when is not useful.
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  });
});
