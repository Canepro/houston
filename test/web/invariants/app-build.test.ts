/**
 * INVARIANT: the application context exists before the first handler is registered.
 *
 * MECHANISM: BEHAVIOURAL SPY.
 *
 * A handler registered before the context exists captures a stale value -- in earlier
 * releases a closure over nothing, here a `decorate` that has not happened yet. Earlier
 * releases asserted that the build call came before the register-all call in the factory's
 * source, which is a claim about the order two NAMES appear in a call graph derived from
 * source. A registration
 * that moved into a helper, or one added by a plugin, is invisible to it.
 *
 * Here the real application is built with the route registrar replaced by a recorder, so
 * what is asserted is the order things actually happened in -- and the recorder reads the
 * context off the instance at the moment it is called, which is the property itself
 * rather than a proxy for it.
 */
import type { FastifyInstance } from 'fastify';

import type * as AppNS from '../../../src/web/app';
import type * as RoutesNS from '../../../src/web/routes/index';
import type * as SecurityNS from '../../../src/web/security';

afterEach(() => {
  jest.resetModules();
});

describe('the application context', () => {
  it('builds the context before the first route is registered', async () => {
    const order: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/web/routes/index', () => {
      const real = jest.requireActual('../../../src/web/routes/index') as typeof RoutesNS;
      return {
        ...real,
        registerAll: (app: FastifyInstance) => {
          // WHAT THE HANDLER WOULD SEE. Reading it here is the invariant: a registrar
          // that runs first would find the decoration absent, which is exactly the stale
          // capture earlier releases' guard was written against.
          order.push(`registerAll:jobs=${String(Object.hasOwn(app, 'jobs'))}`);
          real.registerAll(app);
        },
      };
    });
    jest.doMock('../../../src/web/security', () => {
      const real = jest.requireActual('../../../src/web/security') as typeof SecurityNS;
      return {
        ...real,
        installSecurity: (app: FastifyInstance, context: SecurityNS.SecurityContext) => {
          order.push('installSecurity');
          real.installSecurity(app, context);
        },
      };
    });
    const { createApp } = require('../../../src/web/app') as typeof AppNS;
    const app = await createApp({ accounts: false });
    try {
      await app.ready();
      expect(order).toContain('registerAll:jobs=true');
      // The guard chain is installed BEFORE the handlers it guards. A route registered
      // first would be served by a request that never met `installSecurity`'s hooks.
      // Spelled as a labelled comparison so a failure SAYS which order broke.
      expect(
        `installSecurity before registerAll: ${String(
          order.indexOf('installSecurity') < order.indexOf('registerAll:jobs=true'),
        )}`,
      ).toBe('installSecurity before registerAll: true');
    } finally {
      await app.close();
      jest.dontMock('../../../src/web/routes/index');
      jest.dontMock('../../../src/web/security');
    }
  });

  it('gives two applications two contexts, never one shared by reference', async () => {
    const { createApp } = require('../../../src/web/app') as typeof AppNS;
    const first = await createApp({ accounts: false, allowHosts: ['a.example'] });
    const second = await createApp({ accounts: false, allowHosts: ['b.example'] });
    try {
      // `create_app` building the object by hand rather than through one constructor is
      // how two applications came to share a context. The suite builds dozens of
      // applications in one process, so a shared one answers for the wrong server.
      expect(first.jobs).not.toBe(second.jobs);
      const refusedByFirst = await first.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: 'b.example' },
      });
      expect(refusedByFirst.statusCode).toBe(403);
      const allowedBySecond = await second.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: 'b.example' },
      });
      expect(allowedBySecond.statusCode).toBe(200);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
