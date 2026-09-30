/** The shared Traefik front door and its host cleanup operation. */

import type { FastifyInstance } from 'fastify';

import * as audit from '../../core/audit';
import { queryBool } from '../route-deps';
import type * as AcmeNS from '../../core/edge/acme';
import type * as RoutesNS from '../../core/edge/routes';
import type * as RuntimeNS from '../../core/edge/runtime';
import type * as SpecNS from '../../core/edge/spec';

function edgeModules(): {
  acme: typeof AcmeNS;
  routes: typeof RoutesNS;
  runtime: typeof RuntimeNS;
  spec: typeof SpecNS;
} {
  return {
    acme: require('../../core/edge/acme') as typeof AcmeNS,
    routes: require('../../core/edge/routes') as typeof RoutesNS,
    runtime: require('../../core/edge/runtime') as typeof RuntimeNS,
    spec: require('../../core/edge/spec') as typeof SpecNS,
  };
}

export function register(app: FastifyInstance): void {
  app.get('/api/edge', async () => {
    const edge = edgeModules();
    const state = await edge.runtime.status();
    const attached = new Set(state.attached);
    const domain = edge.spec.servedDomain();
    const routes = [];
    for (const name of state.routes) {
      routes.push({
        name,
        host: edge.routes.routeHost(name),
        passthrough: edge.routes.isPassthrough(name),
        reachable: await edge.routes.routeReachable(name, attached),
      });
    }
    const claimed = new Set(
      [...routes.map((route) => route.host), domain]
        .filter((host) => host !== '')
        .map((host) => host.toLowerCase()),
    );
    return {
      installed: state.installed,
      running: state.running,
      routes,
      domain,
      stale_certs: edge.acme.acmeHosts().filter((host) => !claimed.has(host.toLowerCase())),
    };
  });

  app.delete<{ Params: { host: string }; Querystring: { confirm?: unknown } }>(
    '/api/edge/hosts/:host',
    async (request) => {
      const edge = edgeModules();
      const confirm = queryBool(request.query.confirm, false, 'confirm');
      audit.record('edge-delete-host', request.params.host, {
        outcome: confirm ? 'ok' : 'denied',
      });
      return await edge.runtime.deleteHost(request.params.host, { confirm });
    },
  );
}
