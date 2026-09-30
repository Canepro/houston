/**
 * `core/lifecycle/ready`: who may say the work is done.
 */
import type { Event } from '../../../src/lib/events';

import { sayReady } from '../../../src/core/lifecycle/ready';

import type * as ReadyNS from '../../../src/core/lifecycle/ready';
import type * as RcapiNS from '../../../src/core/rcapi';
import type * as RecordNS from '../../../src/core/runner/record';

describe('announcing readiness', () => {
  it('claims the end only when this step IS the end, and never names a percentage otherwise', () => {
    // MEASURED on a real EKS create: `done: ready` at 100% at 414s, then 46 more seconds of
    // seeding, then a second `done` -- a progress bar that fills up and keeps going.
    const said: [string, number | null | undefined][] = [];
    const emit = (event: Event) => said.push([String(event.phase), event.pct]);
    sayReady(emit, false);
    // NO PERCENTAGE: `wait_serving` already emitted 100, so any number sends the bar back.
    expect(said).toEqual([['wait', null]]);
    said.length = 0;
    sayReady(emit, true);
    expect(said).toEqual([['done', 100]]);
  });

  it('treats a caller that does not say as the end, because that caller is `houston ready`', async () => {
    // The default is observed, not read off the signature: `waitAndFinalize` is
    // CALLED without `final` and must announce the end -- the property the default exists
    // for -- while a caller that passes `final = false` must not. A default is read by
    // calling the function without the argument and looking.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      rcRestartCount: async () => 0,
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      waitReady: async () => ({ version: '8.5.1' }),
      completeSetupWizard: async () => false,
    }));
    jest.doMock('../../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../../src/core/postready', () => ({ runPostReady: async () => undefined }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
      const meta = metadata({ name: 'w', rcVersion: '8.5.1', rootUrl: 'http://localhost:3000' });
      const phases = async (final?: boolean): Promise<string[]> => {
        const seen: string[] = [];
        const emit = (event: Event) => seen.push(String(event.phase));
        // Two arguments when `final` is not given: that is the caller being described.
        if (final === undefined) await ready.waitAndFinalize(meta, emit);
        else await ready.waitAndFinalize(meta, emit, 300, final);
        return seen;
      };
      expect((await phases()).at(-1)).toBe('done');
      expect(await phases(false)).not.toContain('done');
    } finally {
      for (const module of [
        '../../../src/core/runner/queries',
        '../../../src/core/rcapi',
        '../../../src/core/lifecycle/admin',
        '../../../src/core/postready',
      ])
        jest.dontMock(module);
      jest.resetModules();
    }
  });
});

describe('bringing a route back', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/edge/routes');
    jest.resetModules();
  });

  it('restores nothing for a workspace that has no https name', async () => {
    jest.resetModules();
    const registered: string[] = [];
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      register: async (name: string) => {
        registered.push(name);
        return false;
      },
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = record.metadata({
      name: 'w',
      project: 'houston-w',
      publicUrl: '',
      extra: { tls: 'acme', tls_ports: [443], tls_email: 'o@e.com' },
    });
    await ready.restoreRoute(meta);
    expect(registered).toEqual([]);
  });
});

describe('a workspace that does not become ready', () => {
  afterEach(() => {
    for (const module of [
      '../../../src/core/runner/queries',
      '../../../src/core/rcapi',
      '../../../src/core/diagnose',
    ])
      jest.dontMock(module);
    jest.resetModules();
  });

  /**
   * `waitServing` over a Rocket.Chat in `state` that restarted `restarts` times, whose
   * readiness wait ticks `ticks` times and then gives up, and whose logs diagnose as
   * `cause`. Returns the module and a live tick counter.
   */
  function load(state: string, restarts: number, ticks: number) {
    jest.resetModules();
    const seen = { ticks: 0, cause: null as string | null };
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => state,
      rcRestartCount: async () => restarts,
      servicesByProject: async () => ({}),
    }));
    jest.doMock('../../../src/core/rcapi', () => {
      const actual = jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi');
      return {
        ...actual,
        waitReady: async (
          _root: string,
          { onTick }: { onTick?: (elapsed: number) => void | Promise<void> } = {},
        ) => {
          for (let i = 0; i < ticks; i += 1) {
            seen.ticks += 1;
            await onTick?.(i);
          }
          throw new actual.NotReady('Rocket.Chat did not become ready within 300s');
        },
      };
    });
    jest.doMock('../../../src/core/diagnose', () => ({
      ...jest.requireActual<object>('../../../src/core/diagnose'),
      diagnoseFailure: async () => seen.cause,
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({ name: 'slow', project: 'houston-slow', rcVersion: '8.5.1' });
    const failure = async (timeout: number): Promise<Error> =>
      (await ready
        .waitServing(meta, () => undefined, timeout)
        .then(
          () => null,
          (error: unknown) => error,
        )) as Error;
    return { seen, failure };
  }

  it('asks diagnose for the cause instead of asserting memory pressure', async () => {
    // MEASURED: `env --set MONGO_URL=mongodb://nope...` then `ready` said "likely resource
    // pressure" on a box with 5.7 GB free, while RC's logs said "Topology is closed" and
    // diagnose, never consulted on this path, knew the answer.
    const { seen, failure } = load('running', 0, 0);
    seen.cause = 'MongoDB is up but its replica set never initialised';
    const known = await failure(1);
    expect(known.constructor.name).toBe('NotReadyError');
    expect(known.message).toContain('replica set never initialised');
    expect(known.message.toLowerCase()).not.toContain('resource pressure');
    expect(known.message).not.toContain('raise Docker');

    // Nothing matched and no restarts: no invented cause at all.
    seen.cause = null;
    const unknown = await failure(1);
    expect(unknown.message).toContain('did not become ready');
    expect(unknown.message.toLowerCase()).not.toContain('resource pressure');
    expect(unknown.message).not.toContain('CPU+RAM');
  });

  it('stops waiting on a crash loop once the cause is known, and not on a count alone', async () => {
    // A boot that restarts twice and settles is ordinary; a matched signature is evidence.
    const { seen, failure } = load('restarting', 3, 2);
    seen.cause = 'MongoDB refused the connection';
    expect((await failure(300)).message).toContain('MongoDB refused the connection');
    expect(seen.ticks).toBe(1);

    // Without a known cause it keeps waiting rather than aborting on the count.
    seen.ticks = 0;
    seen.cause = null;
    await failure(300);
    expect(seen.ticks).toBe(2);
  });
});

/**
 * The crash-loop tick's whole-seconds conversion of the elapsed time. Under `--timeout inf` or
 * `nan` the deadline is never reached and the elapsed time is NaN, so in earlier releases the
 * first tick raises `InvalidValue` and the command ends with exit 1; `Math.floor` printed "still
 * booting (NaNs)" every three seconds for ever, a run that never wrote its `end` record.
 */
describe('a tick whose elapsed time is not a number', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/runner/queries');
    jest.resetModules();
  });

  it('refuses a NaN as earlier releases refused it, and a finite one says what they said', async () => {
    // What earlier releases answered for each (timeout, elapsed) pair, recorded.
    const recorded: [string, string][] = [
      ['InvalidValue', 'NaN is not an integer'],
      ['InvalidValue', 'NaN is not an integer'],
      ['said', 'still booting (3s)'],
    ];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcRestartCount: async () => 0,
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({ name: 'w', rcVersion: '8.5.1', rootUrl: 'http://localhost:3000' });
    const ours: [string, string][] = [];
    for (const [timeout, elapsed] of [
      [Infinity, NaN],
      [NaN, NaN],
      [300, 3.7],
    ] as const) {
      const said: string[] = [];
      try {
        await ready.crashLoopTick(
          meta,
          (event: Event) => said.push(String(event.message)),
          timeout,
          { restarts: 0, cause: null },
          elapsed,
        );
        ours.push(['said', said.at(-1) ?? '']);
      } catch (error) {
        ours.push([(error as Error).name, (error as Error).message]);
      }
    }
    expect(recorded[0]).toEqual(['InvalidValue', 'NaN is not an integer']);
    expect(ours).toEqual(recorded);
  });
});
