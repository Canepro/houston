/** Load tests, capacity searches, and the monitoring add-on. */

import type { FastifyInstance } from 'fastify';

import { resolveName } from '../../core/lifecycle/naming';
import * as monitor from '../../core/monitor';
import { type Bag, queryBool, requestBody, submit } from '../route-deps';
import type * as LoadtestNS from '../../core/loadtest';

function loadtestModule(): typeof LoadtestNS {
  return require('../../core/loadtest') as typeof LoadtestNS;
}

function loadRequest(name: string, body: Bag): LoadtestNS.LoadtestReq {
  return loadtestModule().loadtestReq({
    name,
    ...(Object.hasOwn(body, 'scenario') ? { scenario: body.scenario as string } : {}),
    ...(Object.hasOwn(body, 'vus') ? { vus: body.vus as number } : {}),
    ...(Object.hasOwn(body, 'duration') ? { duration: body.duration as string } : {}),
    ...(Object.hasOwn(body, 'users_n') ? { usersN: body.users_n as number } : {}),
    ...(Object.hasOwn(body, 'slo') ? { slo: body.slo as string } : {}),
    ...(Object.hasOwn(body, 'constrain') ? { constrain: body.constrain as string } : {}),
    ...(Object.hasOwn(body, 'diag') ? { diag: body.diag as boolean } : {}),
    ...(Object.hasOwn(body, 'stats') ? { stats: body.stats as boolean } : {}),
    ...(Object.hasOwn(body, 'live') ? { live: body.live as boolean } : {}),
    ...(Object.hasOwn(body, 'slowms') ? { slowms: body.slowms as number } : {}),
  });
}

function capacityRequest(name: string, body: Bag): LoadtestNS.CapacityReq {
  return loadtestModule().capacityReq({
    name,
    ...(Object.hasOwn(body, 'scenario') ? { scenario: body.scenario as string } : {}),
    ...(Object.hasOwn(body, 'users_n') ? { usersN: body.users_n as number } : {}),
    ...(Object.hasOwn(body, 'slo') ? { slo: body.slo as string } : {}),
    ...(Object.hasOwn(body, 'start') ? { start: body.start as number } : {}),
    ...(Object.hasOwn(body, 'max_vus') ? { maxVus: body.max_vus as number } : {}),
    ...(Object.hasOwn(body, 'step_duration') ? { stepDuration: body.step_duration as string } : {}),
    ...(Object.hasOwn(body, 'constrain') ? { constrain: body.constrain as string } : {}),
  });
}

export function register(app: FastifyInstance): void {
  app.post<{ Params: { name: string } }>('/api/repros/:name/loadtest', async (request) => {
    const body = requestBody(request.body, false);
    const loadtest = loadtestModule();
    const target = await resolveName(request.params.name);
    const req = loadRequest(target, body);
    return submit(app, 'loadtest', (emit) => loadtest.runLoadtest(req, emit), { label: target });
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/capacity', async (request) => {
    const body = requestBody(request.body, false);
    const loadtest = loadtestModule();
    const target = await resolveName(request.params.name);
    const req = capacityRequest(target, body);
    return submit(app, 'capacity', (emit) => loadtest.runCapacity(req, emit), { label: target });
  });

  app.post<{ Params: { name: string }; Querystring: { off?: unknown } }>(
    '/api/repros/:name/monitor',
    async (request) => {
      const target = await resolveName(request.params.name);
      const off = queryBool(request.query.off, false, 'off');
      return submit(
        app,
        off ? 'monitor-off' : 'monitor',
        (emit) => (off ? monitor.detach(target, emit) : monitor.attach(target, emit)),
        { label: target },
      );
    },
  );
}
