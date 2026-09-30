/**
 * The web transport's privilege table and the invariant that keeps it complete.
 *
 * Keys stay in the `{name}` path-template spelling so the table is byte-for-byte
 * comparable with the established one. Fastify's `:name` spelling is translated only at the
 * boundary. This table must not move below `web/`: CLI actors are caller assertions,
 * while web actors are identities the server authenticated.
 */

import type { FastifyContextConfig, FastifyInstance, RouteOptions } from 'fastify';

interface HeadRouteModule {
  parseHeadOnSendHandlers(value?: unknown): unknown;
}

const headRouteModule = require('fastify/lib/head-route') as HeadRouteModule;
const FASTIFY_HEAD_ON_SEND = headRouteModule.parseHeadOnSendHandlers();

export type RouteRole = '' | 'readonly' | 'member' | 'admin';
export type RouteKey = readonly [method: string, template: string];

const OPEN = '';
const READ = 'readonly';
const WRITE = 'member';
const ADMIN = 'admin';

export const ROUTE_ROLES: ReadonlyMap<string, RouteRole> = new Map([
  ['GET /signin', OPEN],
  ['POST /signin', OPEN],
  ['POST /signout', OPEN],
  ['GET /api/health', OPEN],
  ['GET /api/session', OPEN],
  ['POST /api/session', OPEN],
  ['DELETE /api/session', OPEN],
  ['GET /api/sessions', READ],
  ['DELETE /api/sessions', READ],
  ['GET /api/repros', READ],
  ['GET /api/repros/{name}', READ],
  ['GET /api/repros/{name}/detail', READ],
  ['GET /api/repros/{name}/stats', READ],
  ['GET /api/repros/{name}/tls', READ],
  ['GET /api/repros/{name}/upgrade', READ],
  ['GET /api/jobs', READ],
  ['GET /api/jobs/{job_id}', READ],
  ['GET /api/jobs/{job_id}/stream', READ],
  ['GET /api/backups', READ],
  ['POST /api/backups/compatibility', READ],
  ['GET /api/doctor', READ],
  ['GET /api/edge', READ],
  ['DELETE /api/edge/hosts/{host}', ADMIN],
  ['GET /api/kubernetes', READ],
  ['GET /api/clusters', READ],
  ['GET /api/clusters/status', READ],
  ['GET /api/clusters/iam-policy', READ],
  ['POST /api/clusters/sweep', READ],
  ['POST /api/clusters/prepare', WRITE],
  ['POST /api/clusters/create', ADMIN],
  ['POST /api/clusters/delete', ADMIN],
  ['POST /api/clusters/forget', WRITE],
  ['GET /api/machine', READ],
  ['GET /api/presets', READ],
  ['GET /api/settings', READ],
  ['GET /api/versions/{version}', READ],
  ['GET /api/repros/{name}/logs', WRITE],
  ['WS /api/repros/{name}/logs/stream', WRITE],
  ['GET /api/repros/{name}/env', WRITE],
  ['POST /api/repros', WRITE],
  ['POST /api/repros/{name}/up', WRITE],
  ['POST /api/repros/{name}/state', WRITE],
  ['POST /api/repros/{name}/ready', WRITE],
  ['POST /api/repros/{name}/seed', WRITE],
  ['POST /api/repros/{name}/scale', WRITE],
  ['DELETE /api/repros/{name}/scale', WRITE],
  ['POST /api/repros/{name}/env', WRITE],
  ['POST /api/repros/{name}/monitor', WRITE],
  ['POST /api/repros/{name}/default', WRITE],
  ['POST /api/repros/{name}/owner', WRITE],
  ['POST /api/repros/{name}/config-import', WRITE],
  ['POST /api/repros/{name}/config-import/plan', WRITE],
  ['POST /api/repros/{name}/backup', WRITE],
  ['POST /api/repros/{name}/upgrade', WRITE],
  ['POST /api/repros/{name}/upgrade/rollback', WRITE],
  ['POST /api/repros/{name}/loadtest', WRITE],
  ['POST /api/repros/{name}/capacity', WRITE],
  ['POST /api/restore', WRITE],
  ['POST /api/repros/{name}/pat', WRITE],
  ['POST /api/repros/{name}/call', WRITE],
  ['DELETE /api/repros/{name}', WRITE],
  ['POST /api/prune', WRITE],
  ['DELETE /api/backups', WRITE],
  ['GET /api/users', ADMIN],
  ['POST /api/users', ADMIN],
  ['DELETE /api/users/{name}', ADMIN],
  ['POST /api/users/{name}/role', ADMIN],
  ['POST /api/users/{name}/password', ADMIN],
  ['POST /api/me/password', READ],
  ['GET /api/audit', READ],
  ['GET /setup', OPEN],
  ['GET /setup.js', OPEN],
  ['POST /api/session/first-run', OPEN],
]);

function key(method: string, template: string): string {
  return `${method.toUpperCase()} ${template}`;
}

/** `{one}`/`{two}` to Fastify `:one`/`:two`, for every path parameter. */
export function toFastifyTemplate(template: string): string {
  return template.replaceAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, ':$1');
}

/** Fastify `:one`/`:two` to `{one}`/`{two}`, for every path parameter. */
export function toBraceTemplate(template: string): string {
  return template.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/gu, '{$1}');
}

export function toFastifyRouteKey([method, template]: RouteKey): RouteKey {
  // Explicitly preserve the unmatched-WebSocket sentinel. It is not a route to infer.
  if (method.toUpperCase() === 'WS' && template === '') return ['WS', ''];
  return [method.toUpperCase(), toFastifyTemplate(template)];
}

export function toBraceRouteKey([method, template]: RouteKey): RouteKey {
  // Same explicit sentinel in the reverse direction.
  if (method.toUpperCase() === 'WS' && template === '') return ['WS', ''];
  return [method.toUpperCase(), toBraceTemplate(template)];
}

export function routeRequirement(method: string, fastifyTemplate: string): RouteRole | null {
  const [translatedMethod, template] = toBraceRouteKey([method, fastifyTemplate]);
  return ROUTE_ROLES.get(key(translatedMethod, template)) ?? null;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    houstonTransport?: 'WS';
    houstonSpa?: true;
  }
}

export interface RegisteredRoute {
  method: string;
  url: string;
  config: FastifyContextConfig;
  generatedHead?: boolean;
}

function methodsOf(method: RouteOptions['method']): string[] {
  return (Array.isArray(method) ? method : [method]).map(String);
}

export function unlistedRoutes(routes: readonly RegisteredRoute[]): string[] {
  const ordinary = routes.filter(
    (route) =>
      !(
        route.config.houstonSpa === true &&
        (route.url === '/' || route.url === '/*') &&
        (route.method === 'GET' || route.method === 'HEAD')
      ),
  );
  const getUrls = new Set(
    ordinary
      .filter((route) => route.method === 'GET' && route.config.houstonTransport !== 'WS')
      .map((route) => route.url),
  );
  const missing: string[] = [];
  for (const route of ordinary) {
    if (route.config.houstonTransport === 'WS') {
      // Fastify registers a WebSocket endpoint as GET+generated HEAD. The marker is
      // supplied at the registration site; never infer WS from a path or handler.
      if (route.method === 'GET' && routeRequirement('WS', route.url) === null) {
        missing.push(`WS ${route.url}`);
      }
      if (route.method === 'HEAD' && route.generatedHead !== true) {
        missing.push(`HEAD ${route.url}`);
      }
      continue;
    }
    if (route.method === 'HEAD') {
      // Fastify 5.12.5 generates exactly this HEAD beside every GET. It is ignored only
      // when that exact GET was observed and declared; a hand-registered HEAD still fails.
      if (
        route.generatedHead !== true ||
        !getUrls.has(route.url) ||
        routeRequirement('GET', route.url) === null
      ) {
        missing.push(`HEAD ${route.url}`);
      }
      continue;
    }
    if (routeRequirement(route.method, route.url) === null) {
      missing.push(`${route.method} ${route.url}`);
    }
  }
  return [...new Set(missing)].sort();
}

/** Capture the real Fastify registry and fail closed after every plugin has registered. */
export function installRouteCompleteness(app: FastifyInstance): RegisteredRoute[] {
  const registered: RegisteredRoute[] = [];
  const lastGetHandler = new Map<string, RouteOptions['handler']>();
  app.addHook('onRoute', (options) => {
    for (const method of methodsOf(options.method)) {
      const onSend = Array.isArray(options.onSend) ? options.onSend : [options.onSend];
      const generatedHead =
        method === 'HEAD' &&
        lastGetHandler.get(options.url) === options.handler &&
        onSend.includes(FASTIFY_HEAD_ON_SEND as never);
      registered.push({
        method,
        url: options.url,
        config: options.config ?? {},
        ...(generatedHead ? { generatedHead: true } : {}),
      });
      if (method === 'GET') lastGetHandler.set(options.url, options.handler);
    }
  });
  app.addHook('onReady', () => {
    const missing = unlistedRoutes(registered);
    if (missing.length > 0) {
      throw new Error(`registered routes missing from ROUTE_ROLES: ${missing.join(', ')}`);
    }
  });
  return registered;
}
