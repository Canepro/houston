/**
 * The guard chain: what a request must prove before a handler ever sees it.
 *
 * Fastify's named lifecycle is the security boundary. `onRequest` rejects an invalid
 * Host or cross-site request before credentials are read; `preHandler` verifies the
 * session, applies the injected default-deny role resolver and establishes request
 * attribution; `onSend` puts the security headers on every answer, including early
 * refusals. The order is explicit rather than dependent on middleware registration
 * conventions.
 *
 * The role table deliberately remains in the web layer, but its rows are not in this
 * module. The routes inject the resolver that translates Fastify's `:name` templates to
 * the table's `{name}` keys.
 */

import { performance } from 'node:perf_hooks';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import * as auditService from '../core/audit';
import * as sessions from '../core/sessions';
import { runWithContext } from '../lib/context';
import { errorText } from '../lib/errors';
import { urlQuote, quotedText, stripText, urlUnquote } from '../lib/format';
import type * as UsersNS from '../core/users';

export const COOKIE_SECURE = '__Host-houston_session';
export const COOKIE_PLAIN = 'houston_session';

export const SIGNIN_MAX_FAILURES = 10;
export const SIGNIN_WINDOW = 60;
export const SIGNIN_MAX_KEYS = 4096;
export const PREAUTH_AUDIT_WINDOW = 60;

const signinFailures = new Map<string, number[]>();
const preauthSeen = new Map<string, number>();

export interface TrustedNetwork {
  contains(address: string): boolean;
}

export interface SecurityContext {
  readonly allowed: ReadonlySet<string>;
  readonly anyHost: boolean;
  readonly csp: string;
  readonly accounts: boolean;
  readonly cookieSecure: string;
  readonly cookiePlain: string;
  /** Live: a test or TLS transition may change it after the app is built. */
  readonly publicHttps: () => boolean;
  readonly trustedProxies: readonly TrustedNetwork[];
  /** null means undeclared and therefore refused; the empty string means open. */
  readonly routeRequirement: (method: string, template: string) => string | null;
}

export interface SecurityDependencies {
  readonly verifySession: typeof sessions.verify;
  readonly roleOf: typeof UsersNS.roleOf;
  readonly atLeast: typeof UsersNS.atLeast;
  readonly audit: typeof auditService.audit;
}

const DEFAULT_DEPENDENCIES: SecurityDependencies = {
  verifySession: sessions.verify,
  roleOf: (name) => usersModule().roleOf(name),
  atLeast: (role, needed) => usersModule().atLeast(role, needed),
  audit: auditService.audit,
};

function usersModule(): typeof UsersNS {
  // Resolved at call time, not at load, so that seam stays available.
  return require('../core/users') as typeof UsersNS;
}

declare module 'fastify' {
  interface FastifyInstance {
    houstonSecurity: SecurityContext;
  }
  interface FastifyRequest {
    houstonActor: string;
  }
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export function hostname(header: string | null | undefined): string {
  const value = stripText(header ?? '');
  if (value.startsWith('[')) return (value.slice(1).split(']', 1)[0] ?? '').toLowerCase();
  return (value.split(':', 1)[0] ?? '').toLowerCase();
}

export function hostOk(context: SecurityContext, header: string | null | undefined): boolean {
  return context.anyHost || context.allowed.has(hostname(header));
}

/** The names every local port answers to, which an allow-list entry cannot vouch for. */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Whether an Origin authority (`host[:port]`, scheme removed) is this server's own.
 *
 * Its own host is compared WITH its port: `localhost:9999` is another server on this
 * machine -- a workspace's Rocket.Chat, say -- and a hostname-only comparison let it through
 * whenever a browser sent no `Sec-Fetch-Site`. A host the operator named with `--allow-host`
 * still matches by name, because a proxy that rewrote Host left no port to compare; the
 * loopback names are not trusted that way. The scheme is not compared: one port answers one
 * scheme, and behind a proxy this server cannot know which the browser used.
 */
export function originOk(
  context: SecurityContext,
  header: string | null | undefined,
  hostHeader: string | null | undefined = '',
): boolean {
  const originHost = hostname(header);
  if (!originHost) return false;
  if (originHost === hostname(hostHeader)) {
    return stripText(header ?? '').toLowerCase() === stripText(hostHeader ?? '').toLowerCase();
  }
  return context.allowed.has(originHost) && !LOOPBACK_NAMES.has(originHost);
}

export function crossSite(
  context: SecurityContext,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  { requireOrigin = false }: { requireOrigin?: boolean } = {},
): boolean {
  const site = headerText(headers['sec-fetch-site']);
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = headerText(headers.origin);
  if (origin) {
    if (origin === 'null') return true;
    const marker = origin.indexOf('://');
    const originAuthority = marker === -1 ? origin : origin.slice(marker + 3);
    return !originOk(context, originAuthority, headerText(headers.host));
  }
  return requireOrigin;
}

function isTrusted(context: SecurityContext, address: string): boolean {
  return context.trustedProxies.some((network) => network.contains(address));
}

export function rightmostUntrusted(forwarded: string, trusted: readonly TrustedNetwork[]): string {
  const hops = forwarded.split(',').map(stripText).filter(Boolean);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index] ?? '';
    if (!trusted.some((network) => network.contains(hop))) return hop;
  }
  return '';
}

export function resolvePeer(
  context: SecurityContext,
  request: FastifyRequest,
): { address: string; https: boolean } {
  let address = request.raw.socket.remoteAddress ?? request.ip;
  let https = Boolean(context.publicHttps());
  if (context.trustedProxies.length > 0 && address && isTrusted(context, address)) {
    const forwarded = headerText(request.headers['x-forwarded-for']);
    if (forwarded) address = rightmostUntrusted(forwarded, context.trustedProxies) || address;
    const protocol = headerText(request.headers['x-forwarded-proto']);
    if (protocol) https = stripText(protocol.split(',', 1)[0] ?? '').toLowerCase() === 'https';
  }
  return { address, https };
}

export function cookieName(context: SecurityContext, https: boolean): string {
  return https ? context.cookieSecure : context.cookiePlain;
}

/**
 * The Set-Cookie line in its established spelling: attributes in sorted key order
 * (expires, httponly, max-age, path, samesite, secure), the
 * flags by their reserved names, and `SameSite=lax` as the value was given.
 */
function sessionCookie(name: string, token: string, maxAge: number, secure: boolean): string {
  return (
    `${name}=${token}; HttpOnly; Max-Age=${maxAge}; Path=/; SameSite=lax` +
    (secure ? '; Secure' : '')
  );
}

/** Mint the one browser credential with the prefix and Secure flag for its real hop. */
export function setSessionCookie(
  context: SecurityContext,
  reply: FastifyReply,
  token: string,
  https = context.publicHttps(),
): void {
  reply.header(
    'Set-Cookie',
    sessionCookie(cookieName(context, https), token, sessions.ABSOLUTE_SECONDS, https),
  );
}

/** Expire both names so switching between HTTP and HTTPS cannot strand a credential. */
export function clearSessionCookie(context: SecurityContext, reply: FastifyReply): void {
  // Deleted as the established server deletes a cookie: an empty value, quoted as `""`, and
  // an expiry of NOW, not the epoch.
  const now = new Date().toUTCString();
  const expired = (name: string) => `${name}=""; expires=${now}; Max-Age=0; Path=/; SameSite=lax`;
  reply.header('Set-Cookie', [expired(context.cookieSecure), expired(context.cookiePlain)]);
}

function cookieValue(header: string, name: string): string {
  for (const item of header.split(';')) {
    const part = stripText(item);
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator) === name) return part.slice(separator + 1);
  }
  return '';
}

export function sessionToken(context: SecurityContext, request: FastifyRequest): string {
  const peer = resolvePeer(context, request);
  return cookieValue(headerText(request.headers.cookie), cookieName(context, peer.https));
}

function monotonicSeconds(): number {
  return performance.now() / 1000;
}

export function preauthShouldAudit(source: string, why: string): boolean {
  const now = monotonicSeconds();
  const key = `${source}\0${why}`;
  const last = preauthSeen.get(key) ?? 0;
  if (last && now - last < PREAUTH_AUDIT_WINDOW) return false;
  if (preauthSeen.size > SIGNIN_MAX_KEYS) {
    for (const [candidate, seen] of preauthSeen) {
      if (now - seen > PREAUTH_AUDIT_WINDOW) preauthSeen.delete(candidate);
    }
  }
  preauthSeen.set(key, now);
  return true;
}

export function signinRetryAfter(source: string): number {
  const now = monotonicSeconds();
  const hits = (signinFailures.get(source) ?? []).filter((stamp) => now - stamp < SIGNIN_WINDOW);
  signinFailures.set(source, hits);
  if (hits.length < SIGNIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.trunc(SIGNIN_WINDOW - (now - (hits[0] ?? now))) + 1);
}

export function signinFailed(source: string): void {
  const now = monotonicSeconds();
  if (signinFailures.size > SIGNIN_MAX_KEYS) {
    for (const [address, hits] of signinFailures) {
      const newest = hits.at(-1);
      if (newest === undefined || now - newest > SIGNIN_WINDOW) signinFailures.delete(address);
    }
    if (signinFailures.size > SIGNIN_MAX_KEYS) {
      const oldest = [...signinFailures.entries()].sort(
        ([, left], [, right]) => (left.at(-1) ?? 0) - (right.at(-1) ?? 0),
      );
      const remove = signinFailures.size - Math.floor(SIGNIN_MAX_KEYS / 2);
      for (const [address] of oldest.slice(0, remove)) signinFailures.delete(address);
    }
  }
  const hits = signinFailures.get(source) ?? [];
  hits.push(now);
  signinFailures.set(source, hits);
}

export function signinOk(source: string): void {
  const seen = signinFailures.get(source);
  if (seen === undefined || seen.length === 0) return;
  if (seen.length <= 1) signinFailures.delete(source);
  else signinFailures.set(source, seen.slice(Math.floor(seen.length / 2)));
}

/** Okta sign-ins one address may start per `SIGNIN_WINDOW`, counted apart from passwords. */
export const SSO_MAX_STARTS = 20;
const ssoStarts = new Map<string, number[]>();

/** Count an Okta sign-in start from `source`, or refuse it: false once over the limit. */
export function ssoStartAllowed(source: string): boolean {
  const now = monotonicSeconds();
  if (ssoStarts.size > SIGNIN_MAX_KEYS) {
    for (const [address, hits] of ssoStarts) {
      if (now - (hits.at(-1) ?? 0) > SIGNIN_WINDOW) ssoStarts.delete(address);
    }
    // Still full: every key is live. Forgetting them costs at most more starts, which the
    // pending cap in `core/sso` bounds anyway; growing without limit costs the server.
    if (ssoStarts.size > SIGNIN_MAX_KEYS) ssoStarts.clear();
  }
  const hits = (ssoStarts.get(source) ?? []).filter((stamp) => now - stamp < SIGNIN_WINDOW);
  if (hits.length >= SSO_MAX_STARTS) return false;
  hits.push(now);
  ssoStarts.set(source, hits);
  return true;
}

export async function doSignin(
  user: string,
  password: string,
  source: string,
  agent: string,
): Promise<readonly [token: string, error: string]> {
  const users = usersModule();
  if (!users.anyUsers()) return ['', 'nouser'];
  if (signinRetryAfter(source)) return ['', 'rate'];
  if (!(await users.verify(user, password, source))) {
    signinFailed(source);
    return ['', 'bad'];
  }
  signinOk(source);
  return [
    await sessions.create(users.normalizeName(user), { label: sessions.describeAgent(agent) }),
    '',
  ];
}

function requestPath(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? '/';
}

function forbidden(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(403).send({ error, kind: 'Forbidden' });
}

function onRequestHook(context: SecurityContext) {
  return function onRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    done: (error?: Error) => void,
  ): void {
    // WebSocket refusals are protocol close frames (1008), not HTTP JSON replies.
    // Its handler re-runs this same Host/cross-site/session/role chain after upgrade.
    if (request.routeOptions.config.houstonTransport === 'WS') {
      done();
      return;
    }
    const host = headerText(request.headers.host);
    if (!hostOk(context, host)) {
      const refused = host.slice(0, 120);
      forbidden(
        reply,
        `host not allowed: ${quotedText(refused)} is not in the allow-list. ` +
          `Restart with \`--allow-host ${refused.split(':', 1)[0] ?? ''}\` ` +
          "(or '*' for any host).",
      );
      return;
    }
    const path = requestPath(request);
    if (
      (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') ||
      path.startsWith('/api/')
    ) {
      if (crossSite(context, request.headers)) {
        forbidden(reply, 'cross-site request refused');
        return;
      }
    }
    done();
  };
}

function roleRefusal(
  dependencies: SecurityDependencies,
  actor: string,
  need: string | null,
  request: FastifyRequest,
  template: string,
  reply: FastifyReply,
): boolean {
  const role = dependencies.roleOf(actor);
  if (need === null) {
    const where = template || requestPath(request) || '?';
    dependencies.audit(actor, 'denied', `${request.method} ${where} (no role declared)`, {
      origin: 'session',
      outcome: 'denied',
    });
    forbidden(
      reply,
      `${request.method} ${template} declares no minimum role, so it is refused (see ROUTE_ROLES)`,
    );
    return true;
  }
  if (!dependencies.atLeast(role, need)) {
    dependencies.audit(actor, 'denied', `${request.method} ${template} needs ${need}`, {
      origin: 'session',
      outcome: 'denied',
    });
    forbidden(reply, `this needs the '${need}' role; you are '${role}'`);
    return true;
  }
  return false;
}

function preHandlerHook(context: SecurityContext, dependencies: SecurityDependencies) {
  return function preHandler(
    request: FastifyRequest,
    reply: FastifyReply,
    done: (error?: Error) => void,
  ): void {
    if (request.routeOptions.config.houstonTransport === 'WS') {
      done();
      return;
    }
    const path = requestPath(request);
    const template = request.routeOptions.url ?? '';
    const need = context.routeRequirement(request.method, template);
    const openPath = need === '' || path === '/app.css';
    if (!context.accounts) {
      request.houstonActor = '';
      runWithContext({ actor: '', origin: '' }, done);
      return;
    }
    const peer = resolvePeer(context, request);
    const token = cookieValue(headerText(request.headers.cookie), cookieName(context, peer.https));
    void dependencies.verifySession(token).then(
      (session) => {
        const actor = session?.user ?? '';
        if (actor && path.startsWith('/api/') && !openPath) {
          if (roleRefusal(dependencies, actor, need, request, template, reply)) return;
        }
        if (!openPath && !actor) {
          if (path.startsWith('/api/')) {
            reply.code(401).send({ error: 'sign in to use houston', kind: 'Unauthorized' });
          } else {
            reply.redirect(`/signin?e=required&next=${signinNext(request.url)}`, 303);
          }
          return;
        }
        request.houstonActor = actor;
        runWithContext({ actor, origin: actor ? 'session' : '' }, done);
      },
      (error: unknown) => done(error instanceof Error ? error : new Error(errorText(error))),
    );
  };
}

/**
 * Where the sign-in page sends a browser back to: the request's decoded path, plus `?` and
 * its query when there is one, percent-encoded with `/?=&` kept.
 *
 * Not the raw target. The path is decoded and the raw query set beside it, the two are
 * glued into a URL, and that URL is split again. So the path is DECODED and quoted again
 * (`/%2F` is `//`), tab, CR and LF are dropped, a decoded `#` ends it and a decoded `?`
 * starts the query, and the query keeps its escapes, which are quoted once more (`?q=%2F`
 * is `?q=%252F`). encodeURIComponent over the raw target sent `/` as `%2F` where the
 * established redirect has `/`.
 */
export function signinNext(target: string): string {
  const mark = target.indexOf('?');
  const query = mark === -1 ? '' : target.slice(mark + 1);
  let url = urlUnquote(mark === -1 ? target : target.slice(0, mark));
  if (query !== '') url += `?${query}`;
  url = url.replace(/[\t\r\n]/gu, '');
  const hash = url.indexOf('#');
  if (hash !== -1) url = url.slice(0, hash);
  const split = url.indexOf('?');
  // An empty query is no query: `path + ('?' + query if query else '')`.
  const nxt = split !== -1 && split === url.length - 1 ? url.slice(0, split) : url;
  return urlQuote(nxt, '/?=&');
}

function onSendHook(context: SecurityContext) {
  return function onSend(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: (error: Error | null, value?: unknown) => void,
  ): void {
    if (!reply.hasHeader('content-security-policy'))
      reply.header('Content-Security-Policy', context.csp);
    if (!reply.hasHeader('x-content-type-options'))
      reply.header('X-Content-Type-Options', 'nosniff');
    if (!requestPath(request).startsWith('/api/') && !reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'no-cache');
    }
    if (!reply.hasHeader('referrer-policy')) reply.header('Referrer-Policy', 'same-origin');
    done(null, payload);
  };
}

/** Install the named guard chain before registering any routes. */
export function installSecurity(
  app: FastifyInstance,
  context: SecurityContext,
  dependencies: Partial<SecurityDependencies> = {},
): void {
  const resolved: SecurityDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  app.decorate('houstonSecurity', context);
  app.decorateRequest('houstonActor', '');
  app.addHook('onRequest', onRequestHook(context));
  // Authentication belongs before content parsing: an unauthenticated protected request
  // is refused before its body is validated. Fastify's
  // preParsing stage keeps the established onRequest -> role guard ordering and is still
  // early enough that an unauthorised body is never parsed.
  const roleGuard = preHandlerHook(context, resolved);
  app.addHook('preParsing', (request, reply, _payload, done) => {
    roleGuard(request, reply, done);
  });
  app.addHook('onSend', onSendHook(context));
}
