/**
 * `web/routes/jobs`: the activity list, one job's document, and its live stream.
 *
 * Besides the two SSE cases: the listing's shape, the session it needs, who may read whose output,
 * what a released result says, and that a refused destructive request is answered on the request
 * instead of becoming a job.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { FastifyInstance } from 'fastify';

import { event } from '../../../src/lib/events';
import { createApp } from '../../../src/web/app';
import { Job, MAX_EVENTS_PER_JOB } from '../../../src/web/jobs';
import { sseEvents } from '../../../src/web/routes/jobs';

import type * as AppNS from '../../../src/web/app';
import type * as DataNS from '../../../src/core/data';
import type * as ExecNS from '../../../src/seams/exec';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as UsersNS from '../../../src/core/users';

jest.mock('../../../src/core/lifecycle/naming', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/naming'),
  resolveName: jest.fn(async (name: string) => name),
}));
jest.mock('../../../src/core/data', () => ({
  ...jest.requireActual('../../../src/core/data'),
  runScale: jest.fn(async () => ({ users: 5 })),
}));

function ids(body: string): number[] {
  return [...body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));
}

describe('job SSE', () => {
  it('sse resume reconnects after a forced trim without duplicating or skipping a line', async () => {
    const app = await createApp({ accounts: false });
    try {
      await app.ready();
      // `state` rather than a synthetic kind: `JobKind` is closed, and this one is unpooled,
      // so the submit runs immediately exactly as the old 'test' did.
      const job = app.jobs.submit('state', (emit) => {
        for (let index = 0; index < MAX_EVENTS_PER_JOB + 50; index += 1) {
          emit(event(`line-${String(index)}`));
        }
        return 'finished';
      });
      expect(await app.jobs.drain()).toEqual([]);
      expect(job.nEvents).toBeGreaterThan(MAX_EVENTS_PER_JOB);
      expect(job.events[0]?.message).toBe('line-51');

      const response = await app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/stream`,
        headers: { accept: 'text/event-stream', 'last-event-id': '2048' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(ids(response.body)).toEqual([2049, 2050]);
      expect(response.body).toContain('line-2049');
      expect(response.body).toContain('"message":"done"');
    } finally {
      await app.close();
    }
  });

  it('does not lose an event appended while a replay batch is being yielded', async () => {
    const job = new Job('job_concurrent', 'state');
    job.emit(event('zero'));
    job.emit(event('one'));
    job.emit(event('two'));
    let closed = false;
    const stream = sseEvents(
      job,
      1,
      () => closed,
      async () => await new Promise<void>((resolve) => setImmediate(resolve)),
    );

    expect((await stream.next()).value?.id).toBe('1');
    job.emit(event('concurrent'));
    expect((await stream.next()).value?.id).toBe('2');
    let timer: NodeJS.Timeout | undefined;
    try {
      const concurrent = await Promise.race([
        stream.next(),
        new Promise<{ value: { id: string } }>((resolve) => {
          timer = setTimeout(() => resolve({ value: { id: 'timed-out' } }), 100);
        }),
      ]);
      expect(concurrent.value?.id).toBe('3');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      closed = true;
      await stream.return(undefined);
    }
  });
});

const PASSWORD = 'correct-horse-battery';

describe('the job registry over HTTP', () => {
  let home = '';
  let previousHome: string | undefined;
  let app: FastifyInstance;
  let users: typeof UsersNS;

  beforeEach(async () => {
    // A HOME PER TEST, because accounts persist in it and these cases sign in as
    // different people; fresh modules, because the sign-in throttle is module state.
    previousHome = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-jobs-route-'));
    process.env.HOUSTON_HOME = home;
    jest.resetModules();
    users = require('../../../src/core/users') as typeof UsersNS;
    await users.add('alice', PASSWORD, 'admin');
    app = await (require('../../../src/web/app') as typeof AppNS).createApp({ accounts: true });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    process.env.HOUSTON_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function signIn(user: string, password = PASSWORD): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { user, password },
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  }
  const as = (cookie: string) => ({ host: 'localhost', cookie });

  /** Until the job leaves queued/running; drain() would end the registry for the test. */
  async function settled(job: { status: string }): Promise<void> {
    for (let turn = 0; turn < 1000 && ['queued', 'running'].includes(job.status); turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(job.status).toBe('done');
  }

  it('lists a job with its label, compactly, so a closed dialog is not a lost job', async () => {
    // The activity list is the only way back to a job whose dialog was closed.
    const alice = await signIn('alice');
    const started = await app.inject({
      method: 'POST',
      url: '/api/repros/rc8-5-1/scale',
      payload: { scale: 'users=5' },
      headers: as(alice),
    });
    expect(started.statusCode).toBe(200);
    const id = String(started.json().job_id);

    const listed = await app.inject({ url: '/api/jobs', headers: as(alice) });
    expect(listed.statusCode).toBe(200);
    const row = (listed.json().jobs as Record<string, unknown>[]).find((one) => one.id === id);
    // `kind` alone cannot tell two concurrent seeds apart -- the label names the target.
    expect(row).toMatchObject({ kind: 'scale', label: 'rc8-5-1' });
    expect(Number(row?.started_at)).toBeGreaterThan(0);
    // Compact: a capacity search's `result` is a large nested document.
    expect(row).not.toHaveProperty('result');
    expect(row).not.toHaveProperty('events');
    await settled(app.jobs.get(id) as Job);
    const data = require('../../../src/core/data') as typeof DataNS;
    expect(jest.mocked(data.runScale).mock.calls[0]?.slice(0, 2)).toEqual(['rc8-5-1', 'users=5']);
  });

  it('needs a session to list jobs', async () => {
    expect(
      (await app.inject({ url: '/api/jobs', headers: { host: 'localhost' } })).statusCode,
    ).toBe(401);
  });

  it('keeps one member’s job output from another member', async () => {
    // Results and error text were not scoped to the submitter and sit at readonly+, so any
    // signed-in account could read another user's output -- which for `env`, `logs`, `pat`
    // and `api` is credentials. (`logs` is not a job kind here; `env` is, and is one.)
    await users.add('bob', 'bobs-good-password', 'member');
    await users.add('carol', 'carols-good-password', 'member');
    const job = app.jobs.submit('env', () => ({ secret: 'LDAP_BIND_PASSWORD' }), {
      label: 'x',
      actor: 'bob',
    });
    await settled(job);

    const bob = await signIn('bob', 'bobs-good-password');
    const alice = await signIn('alice');
    const carol = await signIn('carol', 'carols-good-password');
    // The submitter sees it; an admin sees it; another member does not.
    expect((await app.inject({ url: `/api/jobs/${job.id}`, headers: as(bob) })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: `/api/jobs/${job.id}`, headers: as(alice) })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: `/api/jobs/${job.id}`, headers: as(carol) })).statusCode).toBe(
      404,
    );
    // The live half of the same document is scoped too, or the above is decorative.
    const stream = (cookie: string) =>
      app.inject({
        url: `/api/jobs/${job.id}/stream`,
        headers: { ...as(cookie), accept: 'text/event-stream' },
      });
    expect((await stream(carol)).statusCode).toBe(404);
    expect((await stream(bob)).statusCode).toBe(200);
    // And it is not merely hidden from the detail route: the listing drops it too.
    const listed = async (cookie: string) =>
      (
        (await app.inject({ url: '/api/jobs', headers: as(cookie) })).json().jobs as {
          id: string;
        }[]
      ).map((one) => one.id);
    expect(await listed(carol)).not.toContain(job.id);
    expect(await listed(bob)).toContain(job.id);
  });

  /** A job stuck the way a create on a Mac was: waiting, at the seam, forever. */
  function stuck(label: string, actor: string) {
    const { sleep } = require('../../../src/seams/exec') as typeof ExecNS;
    return app.jobs.submit(
      'up',
      async () => {
        for (;;) await sleep(50);
      },
      { label, actor },
    );
  }

  async function ended(job: { status: string }): Promise<void> {
    for (let turn = 0; turn < 200 && ['queued', 'running'].includes(job.status); turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  it('lets its owner or an admin stop a stuck job, and nobody else', async () => {
    // Nothing in the GUI could end a job: a create that waited ten minutes on a forward it
    // could not see held its workspace until the server itself was killed.
    await users.add('bob', 'bobs-good-password', 'member');
    await users.add('carol', 'carols-good-password', 'member');
    await users.add('dave', 'daves-good-password', 'readonly');
    const job = stuck('bobs-box', 'bob');
    const stop = async (cookie: string) =>
      await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/stop`, headers: as(cookie) });
    expect((await stop(await signIn('carol', 'carols-good-password'))).statusCode).toBe(404);
    expect((await stop(await signIn('dave', 'daves-good-password'))).statusCode).toBe(403);
    expect(job.status).toBe('running');
    const bob = await signIn('bob', 'bobs-good-password');
    const stopped = await stop(bob);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ id: job.id, stopping: true });
    await ended(job);
    expect(job.status).toBe('error');
    expect(job.error).toBe('stopped by bob before it finished; what it had done stays');
    expect((await stop(bob)).statusCode).toBe(409);
    // An admin may stop anyone's.
    const other = stuck('bobs-box', 'bob');
    const byAdmin = await app.inject({
      method: 'POST',
      url: `/api/jobs/${other.id}/stop`,
      headers: as(await signIn('alice')),
    });
    expect(byAdmin.statusCode).toBe(200);
    await ended(other);
    expect(other.error).toContain('stopped by alice');
  });

  it('refuses to stop a kind whose half-done state was never read, and says so', async () => {
    const alice = await signIn('alice');
    const { sleep } = require('../../../src/seams/exec') as typeof ExecNS;
    const job = app.jobs.submit(
      'cluster-create',
      async () => {
        for (;;) await sleep(50);
      },
      { label: 'support', actor: 'alice' },
    );
    const read = await app.inject({ url: `/api/jobs/${job.id}`, headers: as(alice) });
    expect(read.json().stoppable).toBe(false);
    const refused = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/stop`,
      headers: as(alice),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('a cluster-create job cannot be stopped from here');
    expect(job.status).toBe('running');
    job.stopper.abort();
    await ended(job);
  });

  it('does not refuse a delete over a cluster job that merely shares the name', async () => {
    // A cluster job's label is the CLUSTER: building EKS "demo" is not working on workspace
    // "demo", and pointing the reader at its Stop would kill eksctl mid-build.
    const alice = await signIn('alice');
    const { sleep } = require('../../../src/seams/exec') as typeof ExecNS;
    const build = app.jobs.submit(
      'cluster-create',
      async () => {
        for (;;) await sleep(50);
      },
      { label: 'nothere', actor: 'alice' },
    );
    const answer = await app.inject({
      method: 'DELETE',
      url: '/api/repros/nothere?volumes=true&confirm=true',
      headers: as(alice),
    });
    expect(answer.body).not.toContain('is busy');
    build.stopper.abort();
    await ended(build);
  });

  it('refuses a delete at once while a job works on the workspace, and says which', async () => {
    // It waited a silent minute for the job's lock and then failed with "another houston
    // operation is still working on it" -- no name, no way forward.
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    await record.write(
      'alices-box',
      'services: {}\n',
      record.metadata({
        name: 'alices-box',
        project: 'houston-alices-box',
        rcVersion: '8.5.1',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        extra: { created_by: 'alice' },
      }),
    );
    const alice = await signIn('alice');
    const job = stuck('alices-box', 'alice');
    const before = app.jobs.listJobs().length;
    const asked = performance.now();
    const refused = await app.inject({
      method: 'DELETE',
      url: '/api/repros/alices-box?volumes=true&confirm=true',
      headers: as(alice),
    });
    expect(performance.now() - asked).toBeLessThan(5000);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(
      /^'alices-box' is busy: its up job, started at \d\d:\d\d UTC by alice, is still running\. Open it in Activity and press Stop job/u,
    );
    expect(app.jobs.listJobs()).toHaveLength(before);
    app.jobs.stop(job.id, 'alice');
    await ended(job);
  });

  it('says when a result was released rather than showing an empty one', async () => {
    const alice = await signIn('alice');
    const job = app.jobs.submit('state', () => ({ ok: true }), { label: 'x' });
    await settled(job);
    const read = async () =>
      (await app.inject({ url: `/api/jobs/${job.id}`, headers: as(alice) })).json() as Record<
        string,
        unknown
      >;
    expect((await read()).result).toEqual({ ok: true });

    job.forgetResult();
    const body = await read();
    expect(body.result).toBeNull();
    // An empty panel and a discarded one are indistinguishable without this.
    expect(body.result_dropped).toBe(true);
  });

  it('answers a refused destructive request on the request, and queues nothing', async () => {
    // Stop/start/restart, down and prune are jobs, and a job answers 200 with an id.
    // Validating inside one would turn "that workspace belongs to alice" into a 200
    // followed by a job the caller has to go and read -- so the cheap checks run on the
    // request, and only the work is queued. A refusal leaves no record.
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    await record.write(
      'alices-box',
      'services: {}\n',
      record.metadata({
        name: 'alices-box',
        project: 'houston-alices-box',
        rcVersion: '8.5.1',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        extra: { created_by: 'alice' },
      }),
    );
    await users.add('bob', 'bobs-good-password', 'member');
    const bob = await signIn('bob', 'bobs-good-password');
    // Through the API, because this is the list a person would open to look for the job
    // that should not be there.
    const count = async () =>
      ((await app.inject({ url: '/api/jobs', headers: as(bob) })).json().jobs as unknown[]).length;
    const before = await count();
    const refused = await app.inject({
      method: 'DELETE',
      url: '/api/repros/alices-box?volumes=true&confirm=true',
      headers: as(bob),
    });
    expect(refused.statusCode).toBe(409);
    expect(String(refused.json().error)).toContain('belongs to alice');
    expect(refused.json()).not.toHaveProperty('job_id');
    expect(await count()).toBe(before);
    expect(app.jobs.listJobs()).toEqual([]);
  });
});
