/**
 * INVARIANT: two refusals the web front door owes.
 *
 * MECHANISM: BEHAVIOURAL, over the real application.
 *
 * Earlier releases held both with source reads through the router: that the sessions DELETE
 * handler's source revoked the session id, and that each endpoint's source reached the route
 * requirement. The second one's own comment records why the first form of it was wrong -- the check moved into a helper and reading the handler alone reported the table
 * unenforced, "which is the same sentence this guard prints for a WS route that really is wide
 * open". A handshake either gets refused or it does not.
 */
import type * as AppNS from '../../../src/web/app';
import type * as SessionsNS from '../../../src/core/sessions';
import type * as UsersNS from '../../../src/core/users';

const PASSWORD = 'a-good-enough-password';

afterEach(() => {
  jest.resetModules();
});

describe('ending a session', () => {
  it('reports a revoke that removed nothing as a failure, not as success', async () => {
    const users = require('../../../src/core/users') as typeof UsersNS;
    const sessions = require('../../../src/core/sessions') as typeof SessionsNS;
    const { createApp } = require('../../../src/web/app') as typeof AppNS;
    await users.add('alice', PASSWORD, 'admin');
    const app = await createApp({ accounts: true });
    try {
      await app.ready();
      const signin = await app.inject({
        method: 'POST',
        url: '/api/session',
        payload: { user: 'alice', password: PASSWORD },
        headers: { host: 'localhost' },
      });
      expect(signin.statusCode).toBe(200);
      const cookie = String(signin.headers['set-cookie'] ?? '').split(';')[0] ?? '';
      const mine = sessions.listFor('alice');
      expect(mine.length).toBeGreaterThan(0);
      const sid = (mine[0] as { sid: string }).sid;

      // A SESSION THAT IS STILL LISTED AND WHOSE REVOKE FAILS, which is the race this
      // exists for: a session can expire between the `listFor` lookup and the revoke.
      // Forced here, because nothing else can make the two disagree on demand.
      const listed = sessions.listFor('alice');
      expect(listed.length).toBeGreaterThan(0);
      const prefix = String((listed[0] as { sid: string }).sid).slice(0, 8);
      // THROUGH THE MODULE REGISTRY, because an emitted export is a getter.
      jest.resetModules();
      jest.doMock('../../../src/core/sessions', () => ({
        ...(jest.requireActual('../../../src/core/sessions') as Record<string, unknown>),
        revokeSid: async () => false,
      }));
      let response;
      try {
        const { createApp: freshApp } = require('../../../src/web/app') as typeof AppNS;
        const racing = await freshApp({ accounts: true });
        try {
          await racing.ready();
          response = await racing.inject({
            method: 'DELETE',
            url: `/api/sessions?sid=${prefix}`,
            headers: { host: 'localhost', cookie },
          });
        } finally {
          await racing.close();
        }
      } finally {
        jest.dontMock('../../../src/core/sessions');
        jest.resetModules();
      }
      // The route answered `{"ok": true, "ended": 1}` regardless. A sign-out that revoked
      // nothing must not report that it did.
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ kind: 'NotFoundError' });

      // And a session that IS there still ends, or this would pass by refusing everything.
      const ok = await app.inject({
        method: 'DELETE',
        url: `/api/sessions?sid=${sid.slice(0, 8)}`,
        headers: { host: 'localhost', cookie },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, ended: 1 });
    } finally {
      await app.close();
    }
  });
});

describe('the log-stream WebSocket', () => {
  it('enforces its own table entry rather than leaving it decorative', async () => {
    const users = require('../../../src/core/users') as typeof UsersNS;
    const { createApp } = require('../../../src/web/app') as typeof AppNS;
    // A SIGNED-IN USER WHOSE ROLE IS BELOW THE TABLE'S. Connecting with no cookie at all
    // is refused by the sign-in check above, which says nothing about whether the handler
    // ever consults the table -- and the table is the half a WebSocket handshake can skip,
    // because it never reaches the HTTP guard. That is how a forged `Origin` once streamed
    // a workspace's container log, LDAP bind passwords included.
    await users.add('reader', PASSWORD, 'readonly');
    const app = await createApp({ accounts: true });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      const signin = await app.inject({
        method: 'POST',
        url: '/api/session',
        payload: { user: 'reader', password: PASSWORD },
        headers: { host: 'localhost' },
      });
      expect(signin.statusCode).toBe(200);
      const cookie = String(signin.headers['set-cookie'] ?? '').split(';')[0] ?? '';
      expect(cookie).not.toBe('');

      const { WebSocket } = require('ws') as {
        WebSocket: new (url: string, protocols: undefined, options: unknown) => never;
      };
      const closed = await new Promise<number>((resolve) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${String(port)}/api/repros/w/logs/stream`,
          undefined,
          { headers: { cookie, origin: `http://127.0.0.1:${String(port)}` } },
        ) as unknown as {
          on: (event: string, handler: (code?: number) => void) => void;
        };
        socket.on('close', (code) => resolve(Number(code)));
        socket.on('error', () => resolve(-1));
      });
      // 1008 is "policy violation": the table says `member` and this session is readonly,
      // so the stream is refused before a single line is sent.
      expect(closed).toBe(1008);
    } finally {
      await app.close();
    }
  });
});
