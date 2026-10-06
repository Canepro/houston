import { setImmediate as defer } from 'node:timers/promises';
import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import type { FastifyInstance } from 'fastify';

import * as auditService from '../core/audit';
import { currentContext, runWithContext } from '../lib/context';
import { ReproError, ConflictError, errorText } from '../lib/errors';
import { asDict, event } from '../lib/events';
import type { Emit, Event } from '../lib/events';
import type * as EventlogNS from '../core/eventlog';

export const MAX_JOBS = 100;
export const MAX_EVENTS_PER_JOB = 2000;
export const KEEP_RESULTS = 10;
export const MAX_QUEUED_PER_POOL = 32;
export const MAX_QUEUED_PER_KIND = MAX_QUEUED_PER_POOL;

export type JobStatus = 'queued' | 'running' | 'done' | 'error';
export const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set(['queued', 'running']);

/**
 * EVERY JOB KIND THE ROUTE LAYER MAY SUBMIT.
 *
 * A closed tuple, so `POOL_OF` below is a TOTAL map and a kind with no pool decision is
 * a compile error rather than a silent `undefined` -- which is what "unpooled" looks
 * like at runtime and is indistinguishable from "somebody decided it need not be".
 *
 * A test guarding this would have to PARSE the route modules to find the submit sites,
 * count them (`>= 14`, or "the parser drifted"), and match each kind to the callable beside
 * it. Nothing about that walk could see a kind whose literal was built rather than written,
 * and its own failure mode was a silent narrowing. Here the kind is a type: a submit site
 * cannot name a kind that is not in this list, and this list cannot grow a member without a
 * pool.
 */
export const JOB_KINDS = Object.freeze([
  'backup',
  'capacity',
  'clear-scale',
  'cluster-create',
  'cluster-delete',
  'cluster-prepare',
  'cluster-sweep',
  'config-import',
  'create',
  'env',
  'loadtest',
  'monitor',
  'monitor-off',
  'prune',
  'ready',
  'restore',
  'rollback',
  'scale',
  'seed',
  'state',
  'teardown',
  'up',
  'upgrade',
] as const);

/** One of the kinds a route may submit. */
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Which ceiling a kind runs under. `none` is a DECISION, spelled out.
 *
 * `measure` is a pool of one, because two load tests on one box measure each other.
 * `heavy` is the container-engine ceiling. `none` is for reads the dashboard polls --
 * pooling those queues the GUI's own refresh behind whatever else is running.
 */
export type PoolName = 'heavy' | 'measure' | 'none';

/**
 * Kind -> ceiling, TOTAL.
 *
 * `Record<JobKind, PoolName>` is the invariant: adding a kind to `JOB_KINDS` without a
 * row here does not compile (TS2741, "Property '<kind>' is missing"), and a row for a
 * kind nothing submits does not compile either (TS2353). Without the type this would be two
 * hand-kept sets and a source walk that had to be told to expect at least fourteen
 * submit sites.
 */
export const POOL_OF: Record<JobKind, PoolName> = {
  // Engine-heavy: each costs a container engine a whole workspace.
  create: 'heavy',
  up: 'heavy',
  restore: 'heavy',
  rollback: 'heavy',
  upgrade: 'heavy',
  backup: 'heavy',
  scale: 'heavy',
  'clear-scale': 'heavy',
  teardown: 'heavy',
  prune: 'heavy',
  monitor: 'heavy',
  'monitor-off': 'heavy',
  seed: 'heavy',
  'config-import': 'heavy',
  // Measurement: a pool of one, or the two runs measure each other.
  loadtest: 'measure',
  capacity: 'measure',
  // Deliberately unpooled. `ready`, `state` and `env` are what the dashboard polls
  // every few seconds; the four cluster verbs are cloud round trips that hold no local
  // engine and take ten to twenty minutes, so a local ceiling would only queue them
  // behind each other for no resource they contend for.
  ready: 'none',
  state: 'none',
  env: 'none',
  'cluster-create': 'none',
  'cluster-delete': 'none',
  'cluster-prepare': 'none',
  'cluster-sweep': 'none',
};

class Pool {
  private used = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly size: number) {}

  tryAcquire(): boolean {
    if (this.used >= this.size) return false;
    this.used += 1;
    return true;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.used -= 1;
  }
}

const MEASURE_POOL = new Pool(1);
const HEAVY_POOL = new Pool(
  Math.max(2, Math.floor((Number(process.env.HOUSTON_CPU_COUNT) || 4) / 2)),
);

function slotsFor(kind: JobKind): Pool | undefined {
  const pool = POOL_OF[kind];
  if (pool === 'measure') return MEASURE_POOL;
  if (pool === 'heavy') return HEAVY_POOL;
  return undefined;
}

function logJobStarted(jobId: string, kind: JobKind, label: string): void {
  try {
    const eventlog = require('../core/eventlog') as typeof EventlogNS;
    eventlog.jobStarted(jobId, kind, label);
  } catch {
    // A durable log is best-effort and must never break the operation it describes.
  }
}

function logJobEnded(job: Job, kind: JobKind): void {
  try {
    const eventlog = require('../core/eventlog') as typeof EventlogNS;
    eventlog.jobEnded(job.id, kind, job.label, job.status, job.error ?? '');
  } catch {
    // The same boundary: a call-time import and a best-effort write.
  }
}

export interface JobSummary {
  id: string;
  kind: string;
  label: string;
  actor: string;
  status: JobStatus;
  started_at: number;
  finished_at: number | null;
  n_events: number;
  error: string | null;
  /** Where a cluster job acts, its AWS region; '' for every other job. */
  region: string;
}

export class Job<Result = unknown> {
  readonly events: Event[] = [];
  status: JobStatus;
  readonly startedAt = Date.now() / 1000;
  finishedAt: number | null = null;
  result: Result | null = null;
  error: string | null = null;
  errorKind: string | null = null;
  resultDropped = false;
  /**
   * A cluster build's region. Its label is only the cluster's NAME, and a name is unique per
   * region, not per account: matching on the name alone hid a different, billing cluster of
   * the same name in another region while this one was built.
   */
  region = '';
  private emitted = 0;

  constructor(
    readonly id: string,
    readonly kind: JobKind,
    readonly label = '',
    readonly actor = '',
    queued = false,
  ) {
    this.status = queued ? 'queued' : 'running';
  }

  readonly emit: Emit = (item) => {
    this.events.push(item);
    this.emitted += 1;
    const overflow = this.events.length - MAX_EVENTS_PER_JOB;
    if (overflow > 0) this.events.splice(0, overflow);
  };

  get nEvents(): number {
    return this.emitted;
  }

  forgetResult(): void {
    if (this.result === null && !this.resultDropped) return;
    this.result = null;
    this.resultDropped = true;
    for (const item of this.events) {
      if (item.terminal) {
        delete item.data.result;
      }
    }
  }

  summary(): JobSummary {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      actor: this.actor,
      status: this.status,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      n_events: this.nEvents,
      error: this.error,
      region: this.region,
    };
  }

  snapshot(since: number): [Array<Record<string, unknown>>, boolean, number] {
    const first = this.emitted - this.events.length;
    const start = Math.max(0, since - first);
    return [this.events.slice(start).map(asDict), !ACTIVE_STATUSES.has(this.status), this.emitted];
  }
}

export type JobTarget<Result> = (emit: Emit) => Result | Promise<Result>;

export interface SubmitOptions {
  label?: string;
  actor?: string;
  region?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    jobs: JobManager;
  }
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Map<string, Promise<void>>();
  private draining = false;
  private nextId = 0;
  /** A queue is its own async resource, as a worker pool would be. */
  private readonly scheduler = new AsyncResource('houston-job-scheduler');

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  listJobs(): JobSummary[] {
    return [...this.jobs.values()].reverse().map((job) => job.summary());
  }

  submit<Result>(
    kind: JobKind,
    target: JobTarget<Result>,
    options: SubmitOptions = {},
  ): Job<Result> {
    if (this.draining) {
      throw new ConflictError('houston is shutting down and is not accepting new work');
    }
    const request = currentContext();
    const actor = options.actor || request.actor;
    const label = options.label ?? '';
    const pool = slotsFor(kind);
    if (pool !== undefined) {
      const waiting = [...this.jobs.values()].filter(
        (candidate) => candidate.status === 'queued' && slotsFor(candidate.kind) === pool,
      ).length;
      if (waiting >= MAX_QUEUED_PER_POOL) {
        throw new ConflictError(
          `${waiting} job(s) are already waiting for a free slot. Let those finish first`,
        );
      }
    }

    this.nextId += 1;
    const id = `job_${this.nextId.toString(16).padStart(10, '0')}`;
    const job = new Job<Result>(id, kind, label, actor, pool !== undefined);
    job.region = options.region ?? '';
    auditService.audit(actor, kind, label, { origin: request.origin });
    this.jobs.set(id, job);
    this.evict();
    this.trimResults();

    const captured = { actor, origin: request.origin, jobId: id, workspace: label };
    const task = defer()
      .then(async () =>
        this.scheduler.runInAsyncScope(() =>
          runWithContext(captured, () => this.run(job, kind, target, pool)),
        ),
      )
      .finally(() => this.running.delete(id));
    this.running.set(id, task);
    return job;
  }

  async drain(timeoutMs = 25_000): Promise<string[]> {
    this.draining = true;
    const deadline = performance.now() + timeoutMs;
    const pending = [...this.running.entries()];
    for (const [, task] of pending) {
      const remaining = Math.max(0, deadline - performance.now());
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          task,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return pending.filter(([id]) => this.running.has(id)).map(([id]) => id);
  }

  private async run<Result>(
    job: Job<Result>,
    kind: JobKind,
    target: JobTarget<Result>,
    pool: Pool | undefined,
  ): Promise<void> {
    try {
      logJobStarted(job.id, kind, job.label);
      if (pool !== undefined) {
        if (!pool.tryAcquire()) {
          job.emit(
            event(`waiting for a free ${kind} slot — something else is using the machine`, {
              phase: 'queued',
            }),
          );
          await pool.acquire();
        }
        job.status = 'running';
      }
      const result = await target(job.emit);
      job.result = result;
      job.finishedAt = Date.now() / 1000;
      job.status = 'done';
      job.emit(event('done', { phase: 'done', terminal: true, data: { result } }));
    } catch (caught: unknown) {
      const error = caught instanceof Error ? caught : new Error(errorText(caught));
      job.error = error.message || errorText(caught);
      job.errorKind = caught instanceof ReproError ? caught.constructor.name : 'InternalError';
      job.finishedAt = Date.now() / 1000;
      job.status = 'error';
      job.emit(
        event(caught instanceof ReproError ? error.message : `internal error: ${error.message}`, {
          phase: 'done',
          level: 'error',
          terminal: true,
          data:
            caught instanceof ReproError
              ? { error: error.message, kind: caught.constructor.name }
              : { error: error.message },
        }),
      );
    } finally {
      logJobEnded(job, kind);
      if (pool !== undefined) pool.release();
    }
  }

  private trimResults(): void {
    const finished = [...this.jobs.values()].filter((job) => !ACTIVE_STATUSES.has(job.status));
    const drop = finished.slice(0, Math.max(0, finished.length - KEEP_RESULTS));
    for (const job of drop) job.forgetResult();
  }

  private evict(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) return;
      if (!ACTIVE_STATUSES.has(job.status)) this.jobs.delete(id);
    }
  }
}

export interface InstallJobsOptions {
  manager?: JobManager;
  drainTimeoutMs?: number;
  onAbandoned?: (jobIds: readonly string[]) => void;
}

/**
 * Attach one registry to one Fastify application and drain it during shutdown.
 *
 * Routes reach the registry through the decorated application, never a module global,
 * so two in-process servers cannot read or stop each other's jobs.
 */
export function installJobs(
  app: FastifyInstance,
  { manager = new JobManager(), drainTimeoutMs = 25_000, onAbandoned }: InstallJobsOptions = {},
): JobManager {
  app.decorate('jobs', manager);
  app.addHook('onClose', async () => {
    const abandoned = await manager.drain(drainTimeoutMs);
    if (abandoned.length > 0) onAbandoned?.(abandoned);
  });
  return manager;
}
