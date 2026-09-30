import Fastify from 'fastify';
import * as fs from 'node:fs';

import * as eventlog from '../../src/core/eventlog';
import { currentContext } from '../../src/lib/context';
import { createApp } from '../../src/web/app';
import { installJobs } from '../../src/web/jobs';
import {
  COOKIE_PLAIN,
  COOKIE_SECURE,
  clearSessionCookie,
  crossSite,
  hostname,
  hostOk,
  installSecurity,
  originOk,
  setSessionCookie,
} from '../../src/web/security';
import type { SecurityContext, SecurityDependencies } from '../../src/web/security';

function context(
  requirements: Readonly<Record<string, string | null>> = {},
  overrides: Partial<SecurityContext> = {},
): SecurityContext {
  return {
    allowed: new Set(['localhost', '127.0.0.1', '::1']),
    anyHost: false,
    csp: "default-src 'self'; form-action 'self'",
    accounts: true,
    cookieSecure: COOKIE_SECURE,
    cookiePlain: COOKIE_PLAIN,
    publicHttps: () => false,
    trustedProxies: [],
    routeRequirement: (method, template) => requirements[`${method} ${template}`] ?? null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<SecurityDependencies> = {},
): Partial<SecurityDependencies> {
  return {
    verifySession: async (token) =>
      token === 'good'
        ? {
            sid: 'digest',
            user: 'alice',
            created: 1,
            lastSeen: 1,
            label: 'test',
            origin: 'session',
          }
        : null,
    roleOf: () => 'admin',
    atLeast: () => true,
    audit: () => undefined,
    ...overrides,
  };
}

describe('security primitives', () => {
  it('normalises ordinary and bracketed IPv6 Host headers', () => {
    expect(hostname('LOCALHOST:7099')).toBe('localhost');
    expect(hostname('[::1]:7099')).toBe('::1');
    expect(hostname('')).toBe('');
    expect(hostOk(context(), '')).toBe(false);
  });

  it('keeps the wildcard Host decision separate from the Origin decision', () => {
    const guard = context({}, { anyHost: true });
    expect(hostOk(guard, 'anything.example')).toBe(true);
    expect(originOk(guard, 'evil.example', 'localhost')).toBe(false);
    expect(originOk(guard, 'proxy.example', 'proxy.example')).toBe(true);
  });

  it('treats Sec-Fetch-Site as authoritative when a browser supplies it', () => {
    const guard = context();
    expect(
      crossSite(guard, {
        host: 'localhost',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
      }),
    ).toBe(false);
    expect(crossSite(guard, { host: 'localhost', origin: 'null' })).toBe(true);
    expect(crossSite(guard, { host: 'localhost' })).toBe(false);
  });

  it('sets the hop-appropriate session cookie and clears both possible names', async () => {
    const app = Fastify();
    const guard = context();
    app.get('/secure', async (_request, reply) => {
      setSessionCookie(guard, reply, 'token-value', true);
      return 'ok';
    });
    app.get('/clear', async (_request, reply) => {
      clearSessionCookie(guard, reply);
      return 'ok';
    });

    const secure = await app.inject({ method: 'GET', url: '/secure' });
    expect(secure.headers['set-cookie']).toBe(
      `${COOKIE_SECURE}=token-value; HttpOnly; Max-Age=604800; Path=/; SameSite=lax; Secure`,
    );
    const cleared = await app.inject({ method: 'GET', url: '/clear' });
    const now = /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
    const lines = cleared.headers['set-cookie'] as string[];
    expect(lines.map((line) => line.replace(/expires=[^;]*/u, 'expires=NOW'))).toEqual([
      `${COOKIE_SECURE}=""; expires=NOW; Max-Age=0; Path=/; SameSite=lax`,
      `${COOKIE_PLAIN}=""; expires=NOW; Max-Age=0; Path=/; SameSite=lax`,
    ]);
    expect(/expires=([^;]*)/u.exec(lines[0] ?? '')?.[1]).toMatch(now);
    await app.close();
  });
});

describe('the named Fastify guard chain', () => {
  it('runs onRequest, then preHandler, then the handler, then onSend', async () => {
    const app = Fastify();
    const order: string[] = [];
    const guard = context(
      { 'GET /api/open': '' },
      {
        routeRequirement: (method, template) => {
          order.push('preHandler');
          return method === 'GET' && template === '/api/open' ? '' : null;
        },
      },
    );
    installSecurity(app, guard, dependencies());
    app.addHook('onRequest', (_request, _reply, done) => {
      order.push('onRequest');
      done();
    });
    app.addHook('onSend', (_request, reply, payload, done) => {
      expect(reply.getHeader('content-security-policy')).toBe(guard.csp);
      order.push('onSend');
      done(null, payload);
    });
    app.get('/api/open', async () => {
      order.push('handler');
      return { ok: true };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/open',
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['onRequest', 'preHandler', 'handler', 'onSend']);
    await app.close();
  });

  it('sends an early Host refusal and never reaches credentials or the handler', async () => {
    const app = Fastify();
    let verified = 0;
    let handled = 0;
    installSecurity(
      app,
      context({ 'GET /api/closed': '' }),
      dependencies({
        verifySession: async () => {
          verified += 1;
          return null;
        },
      }),
    );
    app.get('/api/closed', async () => {
      handled += 1;
      return { wrong: true };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/closed',
      headers: { host: 'evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe(
      "host not allowed: 'evil.example' is not in the allow-list. " +
        "Restart with `--allow-host evil.example` (or '*' for any host).",
    );
    expect(verified).toBe(0);
    expect(handled).toBe(0);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('sends an early cross-site refusal for API reads', async () => {
    const app = Fastify();
    let verified = 0;
    let handled = 0;
    installSecurity(
      app,
      context({ 'GET /api/read': '' }),
      dependencies({
        verifySession: async () => {
          verified += 1;
          return null;
        },
      }),
    );
    app.get('/api/read', async () => {
      handled += 1;
      return { wrong: true };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/read',
      headers: { host: 'localhost', origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(verified).toBe(0);
    expect(handled).toBe(0);
    await app.close();
  });

  it('refuses an authenticated actor below the declared role and audits the denial', async () => {
    const app = Fastify();
    const audited: unknown[][] = [];
    let handled = 0;
    installSecurity(
      app,
      context({ 'POST /api/admin': 'admin' }),
      dependencies({
        roleOf: () => 'member',
        atLeast: () => false,
        audit: (...args) => {
          audited.push(args);
        },
      }),
    );
    app.post('/api/admin', async () => {
      handled += 1;
      return { wrong: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin',
      headers: {
        host: 'localhost',
        cookie: `${COOKIE_PLAIN}=good`,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain("needs the 'admin' role");
    expect(handled).toBe(0);
    expect(audited).toEqual([
      ['alice', 'denied', 'POST /api/admin needs admin', { origin: 'session', outcome: 'denied' }],
    ]);
    await app.close();
  });

  it('defaults an undeclared route to refusal rather than an implicit admin role', async () => {
    const app = Fastify();
    let handled = 0;
    installSecurity(app, context(), dependencies());
    app.get('/api/unlisted', async () => {
      handled += 1;
      return { wrong: true };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/unlisted',
      headers: { host: 'localhost', cookie: `${COOKIE_PLAIN}=good` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain('declares no minimum role');
    expect(handled).toBe(0);
    await app.close();
  });

  it('preserves stronger route headers while supplying the defaults', async () => {
    const app = Fastify();
    installSecurity(app, context({ 'GET /page': '' }), dependencies());
    app.get('/page', async (_request, reply) => {
      reply.header('Content-Security-Policy', "default-src 'none'");
      return 'ok';
    });

    const response = await app.inject({
      method: 'GET',
      url: '/page',
      headers: { host: 'localhost' },
    });
    expect(response.headers['content-security-policy']).toBe("default-src 'none'");
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['referrer-policy']).toBe('same-origin');
    await app.close();
  });

  it('carries actor propagation through a real route into its background job', async () => {
    const app = Fastify();
    const manager = installJobs(app);
    installSecurity(app, context({ 'POST /api/work/:name': 'member' }), dependencies());
    let observed = currentContext();
    app.post<{ Params: { name: string } }>('/api/work/:name', async (request) => {
      const job = app.jobs.submit(
        'ready',
        async () => {
          await Promise.resolve();
          observed = currentContext();
          return 'ok';
        },
        { label: request.params.name },
      );
      return { job_id: job.id };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/work/ticket-1',
      headers: {
        host: 'localhost',
        cookie: `${COOKIE_PLAIN}=good`,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(response.statusCode).toBe(200);
    const jobId = response.json<{ job_id: string }>().job_id;
    expect(await manager.drain()).toEqual([]);
    expect(manager.get(jobId)?.actor).toBe('alice');
    expect(observed).toEqual({
      actor: 'alice',
      origin: 'session',
      jobId,
      workspace: 'ticket-1',
    });
    const durable = fs
      .readFileSync(eventlog.logPath(), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.job === jobId);
    expect(durable).toEqual([
      expect.objectContaining({
        kind: 'job-start',
        actor: 'alice',
        job: jobId,
        ws: 'ticket-1',
      }),
      expect.objectContaining({
        kind: 'job-end',
        actor: 'alice',
        job: jobId,
        ws: 'ticket-1',
        status: 'done',
      }),
    ]);
    await app.close();
  });
});

describe('the installed guard', () => {
  it('is on the application exactly once: never missing, and a second install is refused', async () => {
    // Registered by a named call rather than as a side effect of building the app, so
    // "twice" and "never" both became possible. A second install fails because the
    // first one is already there; an application built without it would accept it.
    const app = await createApp({ accounts: false });
    try {
      expect(app.houstonSecurity).toBeDefined();
      expect(() => installSecurity(app, app.houstonSecurity, dependencies())).toThrow(
        /'houstonSecurity' has already been added/u,
      );
      const refused = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: 'evil.example' },
      });
      expect(refused.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
