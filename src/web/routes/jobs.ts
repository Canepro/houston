/** The background-job registry over HTTP and SSE. */

import { setTimeout as delay } from 'node:timers/promises';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SSEMessage } from '@fastify/sse';

import type * as UsersNS from '../../core/users';
import type { Job } from '../jobs';
import { queryInt } from '../route-deps';

function usersModule(): typeof UsersNS {
  return require('../../core/users') as typeof UsersNS;
}

function mayReadJob(request: FastifyRequest, owner: string): boolean {
  const me = request.houstonActor || '';
  if (!me || !owner) return true;
  const users = usersModule();
  return owner === me || users.atLeast(users.roleOf(me), 'admin');
}

function startIndex(request: FastifyRequest): number {
  const query = request.query as { since?: unknown };
  const header = request.headers['last-event-id'];
  if (typeof header === 'string' && header !== '') {
    const last = Number(header);
    if (Number.isFinite(last)) return Math.max(0, Math.trunc(last) + 1);
  }
  return Math.max(0, queryInt(query.since, 0, 'since'));
}

export async function* sseEvents(
  job: Job,
  start: number,
  closed: () => boolean,
  pause: () => Promise<void> = async () => await delay(20),
): AsyncGenerator<SSEMessage> {
  let index = start;
  while (!closed()) {
    const [items, done, next] = job.snapshot(index);
    const first = next - items.length;
    for (let offset = 0; offset < items.length; offset += 1) {
      yield { id: String(first + offset), data: items[offset] ?? {} };
    }
    index = next;
    if (done && items.length === 0) return;
    await pause();
  }
}

export function register(app: FastifyInstance): void {
  app.get('/api/jobs', async (request) => ({
    jobs: app.jobs.listJobs().filter((job) => mayReadJob(request, job.actor)),
  }));

  app.get<{ Params: { job_id: string } }>('/api/jobs/:job_id', async (request, reply) => {
    const job = app.jobs.get(request.params.job_id);
    if (job === undefined || !mayReadJob(request, job.actor)) {
      return reply.code(404).send({ error: 'no such job' });
    }
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      result: job.result,
      error: job.error,
      error_kind: job.errorKind,
      result_dropped: job.resultDropped,
      n_events: job.nEvents,
    };
  });

  app.get<{ Params: { job_id: string } }>(
    '/api/jobs/:job_id/stream',
    { sse: { kind: 'only', heartbeat: false } },
    async (request, reply) => {
      const job = app.jobs.get(request.params.job_id);
      if (job === undefined || !mayReadJob(request, job.actor)) {
        return reply.code(404).send({ error: 'no such job' });
      }
      const liveJob = job;
      reply.header('Cache-Control', 'no-cache, no-transform');
      reply.header('X-Accel-Buffering', 'no');
      let closed = false;
      reply.sse.onClose(() => {
        closed = true;
      });
      await reply.sse.send(sseEvents(liveJob, startIndex(request), () => closed));
    },
  );
}
