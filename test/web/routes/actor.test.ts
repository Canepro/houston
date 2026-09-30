import type * as Context from '../../../src/lib/context';

jest.mock('../../../src/core/lifecycle/pruning', () => ({
  prune: jest.fn(async () => {
    const { currentContext } = require('../../../src/lib/context') as typeof Context;
    return currentContext();
  }),
}));

import Fastify from 'fastify';

import { installJobs } from '../../../src/web/jobs';
import { routeRequirement } from '../../../src/web/route-table';
import { installSecurity } from '../../../src/web/security';
import { register } from '../../../src/web/routes/repros';

describe('route-launched job context', () => {
  it('preserves the authenticated actor across the deferred job boundary', async () => {
    const app = Fastify();
    installJobs(app);
    installSecurity(
      app,
      {
        allowed: new Set(['localhost']),
        anyHost: false,
        csp: "default-src 'self'",
        accounts: true,
        cookieSecure: '__Host-houston_session',
        cookiePlain: 'houston_session',
        publicHttps: () => false,
        trustedProxies: [],
        routeRequirement,
      },
      {
        verifySession: async () => ({ user: 'alice' }) as never,
        roleOf: () => 'member',
        atLeast: () => true,
        audit: () => undefined,
      },
    );
    register(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/prune',
        headers: { host: 'localhost', cookie: 'houston_session=verified' },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(await app.jobs.drain()).toEqual([]);
      const job = app.jobs.get(response.json().job_id as string);
      expect(job?.actor).toBe('alice');
      expect(job?.result).toEqual(
        expect.objectContaining({ actor: 'alice', origin: 'session', jobId: job?.id }),
      );
    } finally {
      await app.close();
    }
  });
});
