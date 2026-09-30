/** Sign in, sign out, first run, and the caller's own sessions. */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import * as audit from '../../core/audit';
import * as sessions from '../../core/sessions';
import { runWithContext } from '../../lib/context';
import { bag, orText, queryBool, queryText, requestBody, text } from '../route-deps';
import type * as FirstrunNS from '../../core/firstrun';
import type * as UsersNS from '../../core/users';
import {
  clearSessionCookie,
  doSignin,
  resolvePeer,
  sessionToken,
  setSessionCookie,
  signinFailed,
  signinOk,
  signinRetryAfter,
} from '../security';
import { page, safeNext, SETUP_JS, setupPage } from '../signin';

const THEME_COOKIE = 'houston_theme';

function firstrunModule(): typeof FirstrunNS {
  return require('../../core/firstrun') as typeof FirstrunNS;
}

function usersModule(): typeof UsersNS {
  return require('../../core/users') as typeof UsersNS;
}

declare module 'fastify' {
  interface FastifyInstance {
    houstonFirstRun: boolean;
  }
}

function cookie(header: string | undefined, name: string): string {
  for (const raw of (header ?? '').split(';')) {
    const part = raw.trim();
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at) === name) return part.slice(at + 1);
  }
  return '';
}

function firstRunOpen(app: FastifyInstance): boolean {
  return app.houstonFirstRun && !usersModule().anyUsers();
}

function quotedNext(value: string): string {
  return encodeURIComponent(value)
    .replaceAll('%2F', '/')
    .replaceAll('%3F', '?')
    .replaceAll('%3D', '=')
    .replaceAll('%26', '&');
}

async function currentSession(request: FastifyRequest): Promise<sessions.Session | null> {
  return await sessions.verify(sessionToken(request.server.houstonSecurity, request));
}

export function register(app: FastifyInstance): void {
  app.get('/setup', async (request, reply) => {
    if (!firstRunOpen(app)) {
      return reply.code(404).send({ error: 'not found', kind: 'NotFoundError' });
    }
    return reply
      .type('text/html; charset=utf-8')
      .send(setupPage(cookie(request.headers.cookie, THEME_COOKIE)));
  });

  app.get('/setup.js', async (_request, reply) => {
    if (!firstRunOpen(app)) {
      return reply.code(404).send({ error: 'not found', kind: 'NotFoundError' });
    }
    return reply.type('application/javascript').send(SETUP_JS);
  });

  app.post('/api/session/first-run', async (request, reply) => {
    const body = requestBody(request.body, true);
    if (!firstRunOpen(app)) {
      return reply
        .code(409)
        .send({ error: 'this server already has accounts', kind: 'ConflictError' });
    }
    const firstrun = firstrunModule();
    const users = usersModule();
    const peer = resolvePeer(app.houstonSecurity, request);
    if (signinRetryAfter(peer.address)) {
      return reply
        .code(429)
        .send({ error: 'too many attempts from this address', kind: 'Unauthorized' });
    }
    if (!firstrun.valid(orText(body.key))) {
      signinFailed(peer.address);
      return reply.code(401).send({
        error: 'that setup link is wrong or has expired. Restart `houston serve` for a fresh one.',
        kind: 'Unauthorized',
      });
    }
    const name = users.normalizeName(orText(body.user));
    const password = orText(body.password);
    users.requireValidName(name);
    users.requireValidPassword(password);
    const token = await runWithContext({ actor: name, origin: 'setup' }, async () => {
      await users.add(name, password, 'admin');
      firstrun.consume();
      signinOk(peer.address);
      const created = await sessions.create(name, {
        origin: 'setup',
        label: sessions.describeAgent(text(request.headers['user-agent'])),
      });
      audit.audit(name, 'first-run', 'first account created', {
        origin: 'setup',
        outcome: 'ok',
      });
      return created;
    });
    setSessionCookie(app.houstonSecurity, reply, token, peer.https);
    return { user: name, role: 'admin' };
  });

  app.get('/signin', async (request, reply) => {
    const query = bag(request.query);
    const next = queryText(query.next, '/', 'next');
    if ((await currentSession(request)) !== null) {
      return reply.redirect(safeNext(next), 303);
    }
    const peer = resolvePeer(app.houstonSecurity, request);
    const local = ['127.0.0.1', '::1', 'localhost'].includes(peer.address);
    const host = text(request.headers.host).split(':', 1)[0] ?? '';
    const document = page({
      error: queryText(query.e, '', 'e'),
      nextUrl: next,
      server: host,
      secure: peer.https || local,
      retryAfter: signinRetryAfter(peer.address),
      theme: cookie(request.headers.cookie, THEME_COOKIE),
    });
    return reply
      .code(
        queryText(query.e, '', 'e') === 'bad' || queryText(query.e, '', 'e') === 'rate' ? 401 : 200,
      )
      .type('text/html; charset=utf-8')
      .send(document);
  });

  app.post('/signin', async (request, reply) => {
    const body = bag(request.body);
    const peer = resolvePeer(app.houstonSecurity, request);
    const [token, error] = await doSignin(
      queryText(body.user, '', 'user'),
      queryText(body.password, '', 'password'),
      peer.address,
      text(request.headers['user-agent']),
    );
    const target = safeNext(queryText(body.next, '/', 'next'));
    if (error) return reply.redirect(`/signin?e=${error}&next=${quotedNext(target)}`, 303);
    setSessionCookie(app.houstonSecurity, reply, token, peer.https);
    return reply.redirect(target, 303);
  });

  app.post('/api/session', async (request, reply) => {
    const body = requestBody(request.body, false);
    const peer = resolvePeer(app.houstonSecurity, request);
    const [token, error] = await doSignin(
      orText(body.user),
      orText(body.password),
      peer.address,
      text(request.headers['user-agent']),
    );
    if (error) {
      const detail: Record<string, string> = {
        bad: 'that name or password is not right',
        rate: 'too many attempts from this address',
        nouser: 'there are no accounts on this server yet',
      };
      return reply
        .code(error === 'rate' ? 429 : 401)
        .send({ error: detail[error] ?? '', kind: 'Unauthorized' });
    }
    const found = await sessions.verify(token);
    setSessionCookie(app.houstonSecurity, reply, token, peer.https);
    return { user: found?.user ?? '', expires_at: found === null ? 0 : sessions.expiresAt(found) };
  });

  app.get('/api/session', async (request) => {
    const users = usersModule();
    const found = await currentSession(request);
    if (found === null) return { user: '', role: '', accounts: app.houstonSecurity.accounts };
    return {
      user: found.user,
      role: users.roleOf(found.user),
      accounts: true,
      origin: found.origin,
      expires_at: sessions.expiresAt(found),
      label: found.label,
    };
  });

  app.delete('/api/session', async (request, reply) => {
    const raw = sessionToken(app.houstonSecurity, request);
    const ended = raw ? await sessions.revoke(raw) : false;
    clearSessionCookie(app.houstonSecurity, reply);
    return { ok: true, ended };
  });

  app.post('/signout', async (request, reply) => {
    const raw = sessionToken(app.houstonSecurity, request);
    if (raw) await sessions.revoke(raw);
    clearSessionCookie(app.houstonSecurity, reply);
    return reply.redirect('/signin?e=signedout', 303);
  });

  app.get('/api/sessions', async (request) => {
    const found = await currentSession(request);
    if (found === null) return { sessions: [] };
    const here = found.sid.slice(0, 8);
    return {
      sessions: sessions.listFor(found.user).map((item) => ({
        ...sessions.publicView(item),
        current: item.sid.slice(0, 8) === here,
      })),
    };
  });

  app.delete('/api/sessions', async (request, reply) => {
    const found = await currentSession(request);
    if (found === null) {
      return reply.code(401).send({ error: 'not signed in', kind: 'Unauthorized' });
    }
    const query = bag(request.query);
    if (queryBool(query.all, false, 'all')) {
      const ended = await sessions.revokeUser(found.user);
      clearSessionCookie(app.houstonSecurity, reply);
      return { ok: true, ended };
    }
    const prefix = queryText(query.sid, '', 'sid');
    const target = sessions.listFor(found.user).find((item) => item.sid.slice(0, 8) === prefix);
    if (target === undefined) {
      return reply.code(404).send({ error: 'no such session', kind: 'NotFoundError' });
    }
    if (!(await sessions.revokeSid(target.sid))) {
      return reply
        .code(404)
        .send({ error: 'that session had already ended', kind: 'NotFoundError' });
    }
    return { ok: true, ended: 1 };
  });
}
