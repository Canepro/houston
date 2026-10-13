import Fastify from 'fastify';
import sse from '@fastify/sse';
import * as fs from 'node:fs';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';

import { setTimeout as delay } from 'node:timers/promises';

import { currentContext, runWithContext } from '../../src/lib/context';
import { reproLock } from '../../src/core/runner/locks';
import { cleanup, sleep } from '../../src/seams/exec';
import { NOTHING_LEFT, event } from '../../src/lib/events';
import { ConflictError, DockerError, ValidationError } from '../../src/lib/errors';
import * as eventlog from '../../src/core/eventlog';
import type * as AuditNS from '../../src/core/audit';
import { register as registerJobRoutes } from '../../src/web/routes/jobs';
import {
  installJobs,
  Job,
  JobManager,
  KEEP_RESULTS,
  MAX_EVENTS_PER_JOB,
  MAX_JOBS,
  MAX_QUEUED_PER_POOL,
} from '../../src/web/jobs';

async function finish(job: Job): Promise<void> {
  for (
    let tries = 0;
    tries < 100 && (job.status === 'queued' || job.status === 'running');
    tries += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(['done', 'error']).toContain(job.status);
}

describe('Job', () => {
  it('keeps the registry limits fixed at the values earlier releases contract to', () => {
    expect(MAX_JOBS).toBe(100);
    expect(MAX_EVENTS_PER_JOB).toBe(2000);
    expect(KEEP_RESULTS).toBe(10);
    expect(MAX_QUEUED_PER_POOL).toBe(32);
  });

  it('caps event bodies while keeping absolute stream indices', () => {
    // A REAL kind rather than a synthetic one: `JobKind` is closed now, and `state` is
    // unpooled, which is what this test needs -- it must not queue behind anything.
    const job = new Job('job_x', 'state');
    for (let index = 0; index < MAX_EVENTS_PER_JOB + 50; index += 1) {
      job.emit(event(`e${index}`));
    }
    expect(job.events).toHaveLength(MAX_EVENTS_PER_JOB);
    expect(job.events[0]?.message).toBe('e50');
    expect(job.nEvents).toBe(MAX_EVENTS_PER_JOB + 50);
    const [retained, done, next] = job.snapshot(0);
    expect(retained).toHaveLength(MAX_EVENTS_PER_JOB);
    expect(job.snapshot(next)).toEqual([[], done, next]);
  });

  it('drops both references when a completed result ages out', () => {
    const job = new Job<{ payload: string }>('job_x', 'capacity');
    const result = { payload: 'large' };
    job.result = result;
    job.status = 'done';
    job.emit(event('done', { terminal: true, data: { result } }));

    job.forgetResult();

    expect(job.result).toBeNull();
    expect(job.events.at(-1)?.data).not.toHaveProperty('result');
    expect(job.resultDropped).toBe(true);
  });

  it('is labelled with the workspace a create settled on, not the version asked for', () => {
    // Activity listed a create without a typed name as "8.5.1", which nothing answers to.
    const job = new Job('job_x', 'create', '8.5.1');
    job.emit(event('pulling', { phase: 'pull' }));
    expect(job.summary().label).toBe('8.5.1');
    job.emit(
      event('workspace name: alice-rc8-5-1-email--ldap', {
        phase: 'create',
        code: 'workspace-name',
        data: { workspace: 'alice-rc8-5-1-email--ldap' },
      }),
    );
    expect(job.summary().label).toBe('alice-rc8-5-1-email--ldap');
  });
});

describe("a create's audit line", () => {
  /** The accepted creates' labels, oldest first; completion has its own audit line. */
  const audited = (): string[] =>
    (require('../../src/core/audit') as typeof AuditNS)
      .read({ limit: 1000 })
      .lines.filter((line) => line.kind === 'create' && line.outcome === 'accepted')
      .map((line) => line.label);

  it('names the workspace a derived-name create settled on, once', async () => {
    // History read the audit, written at submit, so every create without a typed name was
    // listed as "8.5.1". It now waits for the name.
    const manager = new JobManager();
    const job = manager.submit(
      'create',
      (emit) => {
        emit(
          event('workspace name: alice-rc8-5-1-ldap', {
            phase: 'create',
            code: 'workspace-name',
            data: { workspace: 'alice-rc8-5-1-ldap' },
          }),
        );
        return {};
      },
      { label: '8.5.1', actor: 'alice', auditWhenNamed: true },
    );
    await finish(job);
    expect(
      audited().filter((label) => label.includes('rc8-5-1-ldap') || label === '8.5.1'),
    ).toEqual(['alice-rc8-5-1-ldap']);
  });

  it('still records a create that ended before it was named, by the version asked for', async () => {
    const manager = new JobManager();
    const job = manager.submit(
      'create',
      () => {
        throw new ValidationError('no such version 9.9.9');
      },
      { label: '9.9.9', actor: 'alice', auditWhenNamed: true },
    );
    await finish(job);
    expect(audited().filter((label) => label === '9.9.9')).toEqual(['9.9.9']);
  });
});

describe('job acceptance and final outcomes', () => {
  it('records acceptance separately from success, failure and an owner-requested stop', async () => {
    const audit = require('../../src/core/audit') as typeof AuditNS;
    const manager = new JobManager();
    const [done, failed, stopped] = runWithContext(
      { actor: 'alice', origin: 'session' },
      () =>
        [
          manager.submit('state', () => ({ value: 'retained' }), { label: 'f5-done' }),
          manager.submit(
            'state',
            () => {
              throw new ValidationError('deliberate f5 refusal');
            },
            { label: 'f5-failed' },
          ),
          // Cancellation enters at a real interruptible wait; an arbitrary
          // Promise does not observe the job's AbortSignal by itself.
          manager.submit('state', async () => await sleep(100), { label: 'f5-stopped' }),
        ] as const,
    );
    expect(
      audit
        .read({ limit: 1000 })
        .lines.filter((row) => row.label.startsWith('f5-'))
        .map((row) => [row.label, row.outcome]),
    ).toEqual([
      ['f5-stopped', 'accepted'],
      ['f5-failed', 'accepted'],
      ['f5-done', 'accepted'],
    ]);
    expect(manager.stop(stopped.id, 'alice')).toBe(true);
    expect(await manager.drain()).toEqual([]);
    expect(done.status).toBe('done');
    expect(failed.status).toBe('error');
    expect(stopped.errorKind).toBe('Stopped');
    const records = audit
      .read({ limit: 1000 })
      .lines.filter((row) => row.kind === 'state' && row.label.startsWith('f5-'));
    for (const [label, outcome] of [
      ['f5-done', 'done'],
      ['f5-failed', 'error'],
      ['f5-stopped', 'stopped'],
    ]) {
      expect(
        records
          .filter((row) => row.label === label)
          .map((row) => row.outcome)
          .sort(),
      ).toEqual(['accepted', outcome].sort());
      expect(
        records
          .filter((row) => row.label === label)
          .every((row) => row.actor === 'alice' && row.origin === 'session'),
      ).toBe(true);
    }
  });

  it('makes released output and stopped outcomes visible without copying results into summaries', () => {
    const job = new Job('f5-summary', 'state', 'f5-workspace', 'alice');
    job.status = 'error';
    job.errorKind = 'Stopped';
    job.result = { private: 'not in a summary' };
    job.forgetResult();
    expect(job.summary()).toMatchObject({ error_kind: 'Stopped', result_dropped: true });
    expect(job.summary()).not.toHaveProperty('result');
  });
});

describe('stopping a job', () => {
  it('ends a stuck job at its wait, frees its workspace lock, and leaves other jobs running', async () => {
    // A create waited on a forward it could not see while holding the workspace's lock, so a
    // delete behind it could never start, and only killing the server ended it.
    const manager = new JobManager();
    let turns = 0;
    const stuck = manager.submit(
      'up',
      async () =>
        await reproLock('ws', async () => {
          for (;;) {
            turns += 1;
            await sleep(200);
          }
        }),
      { label: 'ws', actor: 'alice' },
    );
    const other = manager.submit(
      'ready',
      async () => {
        for (;;) await sleep(200);
      },
      { label: 'elsewhere' },
    );
    for (let wait = 0; wait < 200 && turns === 0; wait += 1) await delay(10);
    expect(manager.stop(stuck.id, 'alice')).toBe(true);
    for (let wait = 0; wait < 300 && stuck.status === 'running'; wait += 1) await delay(10);
    expect(stuck.status).toBe('error');
    expect(stuck.error).toBe('stopped by alice before it finished; what it had done stays');
    expect(stuck.errorKind).toBe('Stopped');
    expect(stuck.events.map((one) => one.message)).toContain('stopping — asked by alice');
    // The lock went with it: the delete that was waiting can take the workspace now.
    expect(await reproLock('ws', async () => 'free', { timeoutMs: 5000 })).toBe('free');
    // One job's Stop is that job's alone.
    expect(other.status).toBe('running');
    expect(manager.stop(stuck.id, 'alice')).toBe(false);
    manager.stop(other.id, 'test');
    for (let wait = 0; wait < 300 && other.status === 'running'; wait += 1) await delay(10);
    expect(other.status).toBe('error');
  });

  it('does not say what it had done stays when its cleanup took all of it back', async () => {
    // A stopped Kubernetes create rolled back, said "nothing of 'w' was left in the cluster,
    // so its record goes too", and the job's own last line went on: "what it had done stays".
    const manager = new JobManager();
    const create = manager.submit(
      'create',
      async (emit) => {
        try {
          for (;;) await sleep(100);
        } finally {
          await cleanup(async () => {
            emit(event("nothing of 'w' was left in the cluster", { code: NOTHING_LEFT }));
          });
        }
      },
      { label: 'w' },
    );
    await delay(50);
    manager.stop(create.id, 'alice');
    for (let wait = 0; wait < 300 && create.status === 'running'; wait += 1) await delay(10);
    expect(create.error).toBe('stopped by alice before it finished; nothing of it was left');
  });

  it('ends a queued job without running it, and frees no slot it never held', async () => {
    // Stop on a job still waiting for a slot answered 200, and the job ran later anyway.
    const manager = new JobManager();
    const forever = async () => {
      for (;;) await sleep(100);
    };
    const holders = [manager.submit('create', forever), manager.submit('create', forever)];
    let ran = false;
    const queued = manager.submit('create', async () => {
      ran = true;
    });
    for (let wait = 0; wait < 100 && queued.status !== 'queued'; wait += 1) await delay(10);
    await delay(50);
    expect(queued.status).toBe('queued');
    expect(manager.stop(queued.id, 'alice')).toBe(true);
    for (let wait = 0; wait < 100 && queued.status === 'queued'; wait += 1) await delay(10);
    expect([queued.status, queued.errorKind, ran]).toEqual(['error', 'Stopped', false]);
    // The slots are as they were: the two holders still have theirs, and once one ends the
    // next job runs at once -- neither leaked nor handed out twice.
    for (const holder of holders) expect(holder.status).toBe('running');
    manager.stop(holders[0]?.id ?? '', 'alice');
    let next = false;
    const after = manager.submit('create', async () => {
      next = true;
    });
    for (let wait = 0; wait < 300 && after.status !== 'done'; wait += 1) await delay(10);
    expect(next).toBe(true);
    manager.stop(holders[1]?.id ?? '', 'alice');
    for (let wait = 0; wait < 300 && holders[1]?.status === 'running'; wait += 1) await delay(10);
  });

  it('keeps a houston error’s own words, which may be the only recovery instruction', async () => {
    const manager = new JobManager();
    const job = manager.submit('up', async () => {
      try {
        for (;;) await sleep(100);
      } catch {
        throw new DockerError('left half done: restore it with `houston restore b.tgz --force`');
      }
    });
    await delay(50);
    manager.stop(job.id, 'alice');
    for (let wait = 0; wait < 300 && job.status === 'running'; wait += 1) await delay(10);
    expect(job.error).toBe(
      'left half done: restore it with `houston restore b.tgz --force` ' +
        '(stopped by alice before it finished; what it had done stays)',
    );
  });

  it('stops a job queued for a busy workspace, not after the holder lets go', async () => {
    // Waiting on another job's lock was a bare timer: Stop said "stopping" until the holder
    // finished, however long that was.
    const manager = new JobManager();
    const seen = { holding: false };
    const holder = manager.submit('create', async () =>
      reproLock('busy', async () => {
        seen.holding = true;
        for (;;) await sleep(100);
      }),
    );
    for (let wait = 0; wait < 200 && !seen.holding; wait += 1) await delay(10);
    const waiter = manager.submit('ready', async () => await reproLock('busy', async () => 'in'));
    await delay(100);
    manager.stop(waiter.id, 'alice');
    for (let wait = 0; wait < 200 && waiter.status === 'running'; wait += 1) await delay(10);
    expect([waiter.status, waiter.errorKind, holder.status]).toEqual([
      'error',
      'Stopped',
      'running',
    ]);
    manager.stop(holder.id, 'alice');
    for (let wait = 0; wait < 300 && holder.status === 'running'; wait += 1) await delay(10);
  });

  it('will not stop a kind whose half-done state nobody has read', async () => {
    // An upgrade stopped mid-migration half rolled itself back; a load test left the API rate
    // limiter off; a cluster build left CloudFormation building unwatched.
    const manager = new JobManager();
    const job = manager.submit('upgrade', async () => {
      for (;;) await sleep(100);
    });
    await delay(20);
    expect(job.summary().stoppable).toBe(false);
    expect(manager.stop(job.id, 'alice')).toBe(false);
    await delay(150);
    expect(job.status).toBe('running');
    expect(manager.submit('up', async () => undefined).summary().stoppable).toBe(true);
    // Ended here only so the test does not leave it running.
    job.stopper.abort();
    for (let wait = 0; wait < 300 && job.status === 'running'; wait += 1) await delay(10);
  });

  it('runs a cleanup to its end even when the job is stopped inside it', async () => {
    const manager = new JobManager();
    const done: string[] = [];
    let inside = false;
    const job = manager.submit('up', async () => {
      try {
        for (;;) await sleep(100);
      } finally {
        await cleanup(async () => {
          inside = true;
          await sleep(150);
          done.push('cleaned up');
        });
      }
    });
    await delay(50);
    manager.stop(job.id, 'alice');
    for (let wait = 0; wait < 300 && job.status === 'running'; wait += 1) await delay(10);
    expect(inside).toBe(true);
    expect(done).toEqual(['cleaned up']);
    expect(job.errorKind).toBe('Stopped');
  });
});

describe('JobManager', () => {
  it('propagates the submitting actor and origin across the deferred job boundary', async () => {
    const manager = new JobManager();
    let observed = currentContext();

    const job = runWithContext({ actor: 'alice', origin: 'web' }, () =>
      manager.submit(
        'ready',
        async () => {
          await Promise.resolve();
          observed = currentContext();
          return 'ok';
        },
        { label: 'ticket-1' },
      ),
    );

    expect(await manager.drain()).toEqual([]);
    expect(job.status).toBe('done');
    expect(observed).toEqual({
      actor: 'alice',
      origin: 'web',
      jobId: job.id,
      workspace: 'ticket-1',
    });
  });

  it('serialises measurement jobs and releases the slot after a typed failure', async () => {
    const manager = new JobManager();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = manager.submit('loadtest', async () => blocked);
    const second = manager.submit('capacity', async () => {
      throw new ValidationError('bad');
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(first.status).toBe('running');
    expect(second.status).toBe('queued');
    expect(second.snapshot(0)[1]).toBe(false);
    release();
    expect(await manager.drain()).toEqual([]);
    expect(first.status).toBe('done');
    expect(second.status).toBe('error');
    expect(second.errorKind).toBe('ValidationError');
  });

  it('records a pooled job start before the job waits for its slot', async () => {
    const manager = new JobManager();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const first = manager.submit('loadtest', async () => blocked);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(first.status).toBe('running');
      const second = manager.submit('capacity', async () => blocked, { label: 'waiting-start' });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(second.status).toBe('queued');
      const records = fs
        .readFileSync(eventlog.logPath(), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: 'job-start',
          job_kind: 'capacity',
          label: 'waiting-start',
        }),
      );
    } finally {
      release();
      expect(await manager.drain()).toEqual([]);
    }
  });

  it('hands the measurement slot on when a job fails, so the next load test runs', async () => {
    // One leaked slot on a pool of one wedges every future load test for the life of
    // the process.
    const manager = new JobManager();
    const failed = manager.submit('loadtest', () => {
      throw new ValidationError('nope');
    });
    await finish(failed);
    expect(failed.status).toBe('error');
    const after = manager.submit('loadtest', () => ({ ok: true }));
    await finish(after);
    expect(after.status).toBe('done');
    expect(await manager.drain()).toEqual([]);
  });

  it('runs an ordinary job straight through, with nothing to wait behind', async () => {
    const manager = new JobManager();
    const job = manager.submit('seed', () => ({ ok: true }), { label: 'x' });
    await finish(job);
    expect(job.status).toBe('done');
    expect(await manager.drain()).toEqual([]);
  });

  it('refuses at submit once a pool is full, and never refuses an unpooled kind', async () => {
    // The pool bounds what RUNS; without a bound at submit, forty capacity submissions
    // against a pool of one held forty queued jobs that eviction may not drop.
    const manager = new JobManager();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // The first one takes the single slot, the rest queue behind it.
      manager.submit('capacity', async () => held, { label: 'runs' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (let index = 0; index < MAX_QUEUED_PER_POOL; index += 1) {
        manager.submit('capacity', async () => held, { label: 'q' });
      }
      const before = manager.listJobs().length;
      expect(() => manager.submit('capacity', async () => held, { label: 'one-too-many' })).toThrow(
        /waiting for a free slot/u,
      );
      expect(manager.listJobs()).toHaveLength(before);
      // Reads and state changes were never the problem and must not start refusing.
      for (let index = 0; index < MAX_QUEUED_PER_POOL + 5; index += 1) {
        manager.submit('state', () => undefined, { label: 's' });
      }
    } finally {
      release();
      expect(await manager.drain()).toEqual([]);
    }
  });

  it('finishes a job that dies of something that is not an Error, rather than leaving it running', async () => {
    // A still-active job can never be evicted, never releases its result, and its SSE
    // stream never terminates.
    const manager = new JobManager();
    const job = manager.submit('ready', () => {
      // A thrown value that is not an Error, as a library can throw.
      throw Object.assign(Object.create(null) as object, {
        toString: () => 'Interrupted: delivered to the worker',
      });
    });
    expect(await manager.drain()).toEqual([]);
    expect(job.status).toBe('error');
    expect(job.error ?? '').toContain('Interrupted');
  });

  it('reports an internal error by kind and never rides a stack trace into the stream', async () => {
    // The browser renders whatever it is handed; the trace belongs on the server.
    const manager = new JobManager();
    const job = manager.submit('state', () => {
      throw new TypeError('boom');
    });
    await finish(job);
    expect(job.status).toBe('error');
    expect(job.errorKind).toBe('InternalError');
    const [events] = job.snapshot(0);
    expect(events.length).toBeGreaterThan(0);
    for (const one of events) {
      const serialised = JSON.stringify(one);
      expect(serialised).not.toMatch(/trace|stack|at .*\.ts:\d+/u);
    }
  });

  it('refuses submissions after draining starts', async () => {
    const manager = new JobManager();
    await manager.drain(0);
    expect(() => manager.submit('ready', () => undefined)).toThrow(ConflictError);
  });

  it('evicts the oldest finished jobs but never an active one', async () => {
    const manager = new JobManager();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = manager.submit('ready', async () => held, { label: 'active' });
    const finished: Job[] = [];
    for (let index = 0; index < MAX_JOBS + 10; index += 1) {
      const job = manager.submit('state', () => index, { label: `done-${index}` });
      finished.push(job);
      await finish(job);
    }
    manager.submit('state', () => 'trigger');

    expect(manager.listJobs()).toHaveLength(MAX_JOBS);
    expect(manager.get(active.id)).toBe(active);
    expect(manager.get(finished[0]?.id ?? '')).toBeUndefined();
    release();
    expect(await manager.drain()).toEqual([]);
  });

  it(`keeps only the newest ${KEEP_RESULTS} completed result documents`, async () => {
    const manager = new JobManager();
    const completed: Job[] = [];
    for (let index = 0; index < KEEP_RESULTS + 5; index += 1) {
      const job = manager.submit('state', () => ({ payload: 'x'.repeat(1000), index }));
      completed.push(job);
      await finish(job);
    }
    manager.submit('state', () => undefined);

    expect(completed.slice(0, 5).every((job) => job.resultDropped && job.result === null)).toBe(
      true,
    );
    expect(completed.slice(5).every((job) => !job.resultDropped && job.result !== null)).toBe(true);
    expect(await manager.drain()).toEqual([]);
  });

  it('counts queued work across every kind sharing one pool', async () => {
    const manager = new JobManager();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = manager.submit('loadtest', async () => held);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.status).toBe('running');
    for (let index = 0; index < MAX_QUEUED_PER_POOL; index += 1) {
      manager.submit(index % 2 === 0 ? 'loadtest' : 'capacity', async () => held);
    }

    expect(() => manager.submit('capacity', async () => held)).toThrow(
      /job\(s\) are already waiting for a free slot/,
    );
    release();
    expect(await manager.drain()).toEqual([]);
  });

  it('sets status, result and timestamp before emitting the terminal event', async () => {
    const manager = new JobManager();
    const job = manager.submit('state', () => 'result');
    const original = job.emit;
    const observed: Array<[string, unknown, number | null]> = [];
    Object.defineProperty(job, 'emit', {
      value: (item: Parameters<typeof original>[0]) => {
        if (item.terminal) observed.push([job.status, job.result, job.finishedAt]);
        original(item);
      },
    });

    await finish(job);
    expect(observed).toEqual([['done', 'result', expect.any(Number)]]);
    expect(await manager.drain()).toEqual([]);
  });

  it('sets typed error details and timestamp before emitting the terminal event', async () => {
    const manager = new JobManager();
    const job = manager.submit('state', () => {
      throw new ValidationError('invalid input');
    });
    const original = job.emit;
    const observed: Array<[string, unknown, unknown, number | null]> = [];
    Object.defineProperty(job, 'emit', {
      value: (item: Parameters<typeof original>[0]) => {
        if (item.terminal) {
          observed.push([job.status, job.error, job.errorKind, job.finishedAt]);
        }
        original(item);
      },
    });

    await finish(job);
    expect(observed).toEqual([['error', 'invalid input', 'ValidationError', expect.any(Number)]]);
    expect(await manager.drain()).toEqual([]);
  });

  it('bounds shutdown with a monotonic deadline even if wall time moves backwards', async () => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    const manager = new JobManager();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = manager.submit('ready', async () => held);
    await jest.advanceTimersByTimeAsync(0);
    const wallClock = jest.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValue(0);
    const draining = manager.drain(20);
    let settled = false;
    void draining.then(() => {
      settled = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(21);
      expect(settled).toBe(true);
      expect(await draining).toEqual([job.id]);
    } finally {
      wallClock.mockRestore();
      release();
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    }
  });

  it('shares one drain deadline across every running job', async () => {
    jest.useFakeTimers();
    const manager = new JobManager();
    let releaseSecond!: () => void;
    const secondHeld = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const first = manager.submit(
      'ready',
      async () => new Promise<void>((resolve) => setTimeout(resolve, 15)),
    );
    const second = manager.submit('state', async () => secondHeld);
    await jest.advanceTimersByTimeAsync(0);
    const clock = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(15);
    const draining = manager.drain(20);
    let settled = false;
    const observed = draining.then((abandoned) => {
      settled = true;
      return abandoned;
    });
    try {
      await jest.advanceTimersByTimeAsync(15);
      expect(first.status).toBe('done');
      await jest.advanceTimersByTimeAsync(6);
      expect(settled).toBe(true);
      expect(await observed).toEqual([second.id]);
      expect(manager.get(first.id)?.status).toBe('done');
    } finally {
      clock.mockRestore();
      releaseSecond();
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    }
  });

  it('stops a job still running when the drain ends, rather than living on with it', async () => {
    // The drain returned the abandoned job and nothing stopped it: serve went on running a
    // seed with its listener closed -- neither serving nor gone -- after the event log said
    // it had ended.
    const app = Fastify();
    const abandoned: string[][] = [];
    const manager = installJobs(app, {
      drainTimeoutMs: 50,
      onAbandoned: (ids) => abandoned.push([...ids]),
    });
    const stuck = manager.submit('up', async () => {
      for (;;) await sleep(200);
    });
    for (let wait = 0; wait < 100 && stuck.status !== 'running'; wait += 1) await delay(10);
    await app.close();
    expect(stuck.errorKind).toBe('Stopped');
    expect(manager.active()).toBe(0);
    expect(abandoned).toEqual([]);
  });

  it('drains the application registry before Fastify closes', async () => {
    const app = Fastify();
    const manager = installJobs(app);
    let cleaned = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.post('/work', async () => {
      const job = manager.submit('ready', async () => {
        await held;
        cleaned = true;
      });
      return { job_id: job.id };
    });

    expect((await app.inject({ method: 'POST', url: '/work' })).statusCode).toBe(200);
    const closing = app.close();
    let closed = false;
    const observed = closing.then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(cleaned).toBe(false);
    release();
    await observed;
    expect(cleaned).toBe(true);
  });

  it('stops a running job and closes a listening server while its HTTP SSE stream is open', async () => {
    const app = Fastify();
    const manager = installJobs(app, { drainTimeoutMs: 50 });
    await app.register(sse);
    registerJobRoutes(app);
    const job = manager.submit('up', async (emit) => {
      emit(event('stream verification started'));
      for (;;) await sleep(200);
    });
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let closing: Promise<void> | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let body = '';
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        request = get(
          `${origin}/api/jobs/${job.id}/stream`,
          {
            headers: { accept: 'text/event-stream' },
            agent: false,
          },
          resolve,
        );
        request.once('error', reject);
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(job.status).toBe('running');
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      const streamEnded = new Promise<void>((resolve, reject) => {
        response!.once('end', resolve);
        response!.once('error', reject);
      });
      closing = app.close();
      const closedWhileSubscribed = await Promise.race([
        Promise.all([closing, streamEnded]).then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      expect(closedWhileSubscribed).toBe(true);
      expect(job.errorKind).toBe('Stopped');
      expect(manager.active()).toBe(0);
      expect(body).toContain('"kind":"Stopped"');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      response?.destroy();
      request?.destroy();
      manager.stop(job.id, 'test cleanup');
      await (closing ?? app.close());
    }
  });

  it('keeps registries isolated between Fastify applications', async () => {
    const firstApp = Fastify();
    const secondApp = Fastify();
    const firstManager = installJobs(firstApp);
    const secondManager = installJobs(secondApp);
    const first = firstManager.submit('ready', () => 'first');
    const second = secondManager.submit('ready', () => 'second');

    expect(firstManager).not.toBe(secondManager);
    expect(first).not.toBe(second);
    expect(firstManager.get(first.id)).toBe(first);
    expect(secondManager.get(second.id)).toBe(second);
    await Promise.all([firstApp.close(), secondApp.close()]);
  });
});
