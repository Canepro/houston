/** Accounts, roles, passwords, and the audit trail. */

import type { FastifyInstance } from 'fastify';

import * as audit from '../../core/audit';
import * as sessions from '../../core/sessions';
import { ValidationError } from '../../lib/errors';
import { orText, queryInt, queryText, requestBody } from '../route-deps';
import type * as UsersNS from '../../core/users';
import {
  resolvePeer,
  sessionToken,
  setSessionCookie,
  signinFailed,
  signinOk,
  signinRetryAfter,
} from '../security';

function usersModule(): typeof UsersNS {
  return require('../../core/users') as typeof UsersNS;
}

export function register(app: FastifyInstance): void {
  app.get('/api/users', async () => {
    const users = usersModule();
    return {
      users: users.listUsers().map((user) => {
        const live = sessions.listFor(user.name);
        return {
          name: user.name,
          role: users.roleOf(user.name),
          implicit: !user.role,
          created_at: user.createdAt,
          sessions: live.length,
          last_seen: Math.max(0, ...live.map((item) => item.lastSeen)),
        };
      }),
      roles: [...users.ROLES],
      implicit_admins: users.implicitAdmins(),
    };
  });

  app.post('/api/users', async (request) => {
    const users = usersModule();
    const body = requestBody(request.body, true);
    const name = users.normalizeName(orText(body.name));
    const role = orText(body.role, 'member');
    users.requireValidName(name);
    users.requireValidRole(role);
    const password = users.mintPassword();
    await users.add(name, password, users.normaliseRole(role));
    return {
      name,
      role: users.normaliseRole(role),
      password,
      note: 'shown once; houston does not store it in readable form',
    };
  });

  app.post<{ Params: { name: string } }>('/api/users/:name/role', async (request) => {
    const users = usersModule();
    const changed = await users.setRole(
      request.params.name,
      orText(requestBody(request.body, true).role),
    );
    const ended = await sessions.revokeUser(changed.name);
    return { name: changed.name, role: changed.role, sessions_ended: ended };
  });

  app.post<{ Params: { name: string } }>('/api/users/:name/password', async (request) => {
    const users = usersModule();
    const password = users.mintPassword();
    const ended = await users.setPassword(request.params.name, password);
    return { name: request.params.name, password, sessions_ended: ended };
  });

  app.delete<{ Params: { name: string } }>('/api/users/:name', async (request) => {
    const users = usersModule();
    const ended = await users.remove(request.params.name);
    return { name: request.params.name, removed: true, sessions_ended: ended };
  });

  app.post('/api/me/password', async (request, reply) => {
    const users = usersModule();
    const body = requestBody(request.body, true);
    const me = request.houstonActor || '';
    const peer = resolvePeer(app.houstonSecurity, request);
    const wait = signinRetryAfter(peer.address);
    if (wait) {
      reply.header('Retry-After', String(wait));
      return reply
        .code(429)
        .send({ error: 'too many attempts from this address', kind: 'Unauthorized' });
    }
    if (!(await users.verify(me, orText(body.old), peer.address))) {
      signinFailed(peer.address);
      throw new ValidationError('that is not your current password');
    }
    signinOk(peer.address);
    const password = orText(body.new);
    users.requireValidPassword(password);
    const raw = sessionToken(app.houstonSecurity, request);
    const current = await sessions.verify(raw);
    const ended = await users.setPassword(me, password);
    const token =
      current === null
        ? ''
        : await sessions.create(me, { label: current.label, origin: 'session' });
    audit.record('me-passwd', me);
    if (token) setSessionCookie(app.houstonSecurity, reply, token, peer.https);
    return { ok: true, sessions_ended: Math.max(0, ended - 1) };
  });

  app.get('/api/audit', async (request) => {
    const users = usersModule();
    const query = request.query as Record<string, unknown>;
    const me = request.houstonActor || '';
    let actorName = queryText(query.actor, '', 'actor');
    if (me && !users.atLeast(users.roleOf(me), 'admin')) actorName = me;
    const limit = Math.max(1, Math.min(queryInt(query.limit, 200, 'limit'), 1000));
    return {
      ...audit.read({
        limit,
        actorName,
        kind: queryText(query.kind, '', 'kind'),
        q: queryText(query.q, '', 'q'),
        since: queryText(query.since, '', 'since'),
      }),
      scope: actorName === '' ? 'all' : actorName,
    };
  });
}
