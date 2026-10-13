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
  it('Grafana public URL regression: restores the monitored router after start or reuse', async () => {
    jest.resetModules();
    const register = jest.fn(async () => false);
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual<object>('../../../src/core/edge/routes'),
      register,
    }));
    jest.doMock('../../../src/core/edge/engine', () => ({
      ...jest.requireActual<object>('../../../src/core/edge/engine'),
      running: async () => true,
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const record = require('../../../src/core/runner/record') as typeof RecordNS;
      await ready.restoreRoute(
        record.metadata({
          name: 'w',
          publicUrl: 'https://h',
          extra: { tls: 'acme', monitoring: true },
        }),
      );
      expect(register).toHaveBeenCalledWith('w', 'h', expect.objectContaining({ grafana: true }));
    } finally {
      jest.dontMock('../../../src/core/edge/engine');
      jest.dontMock('../../../src/core/edge/routes');
      jest.resetModules();
    }
  });
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

describe("a Kubernetes workspace's preset forwards, after a stop/start", () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/kube/forward');
    jest.resetModules();
  });

  it('are re-established when one died with its pod, and recorded again', async () => {
    // Only the Rocket.Chat forward was ever repaired: the SAML IdP on :8081 answered
    // nothing after a stop/start, post_ready could not re-read its certificate, and every
    // SAML sign-in was refused as an invalid signature.
    jest.resetModules();
    const stopped: number[] = [];
    jest.doMock('../../../src/core/kube/forward', () => ({
      ...jest.requireActual('../../../src/core/kube/forward'),
      forwardAlive: async (pid: number) => pid !== 5151,
      stopForward: async (pid: number) => {
        stopped.push(pid);
        return true;
      },
      scenarioUiForwards: async () => ({ 8081: 6161, 8082: 6262 }),
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const extra = { scenario_forwards: { 8081: 5151, 8082: 5252 } };
    await record.writeRecord('ks', record.metadata({ name: 'ks', project: 'houston-ks', extra }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const meta = await record.readMeta('ks');
    await ready.repairTheScenarioForwards(meta, () => undefined, extra, 'houston-ks', 'c');
    expect(stopped.sort()).toEqual([5151, 5252]);
    expect((await record.readMeta('ks')).extra.scenario_forwards).toEqual({
      8081: 6161,
      8082: 6262,
    });
  });
});

describe('a multi-instance workspace, ready', () => {
  afterEach(() => {
    for (const module of ['../../../src/core/runner/queries', '../../../src/core/rcapi'])
      jest.dontMock(module);
    jest.resetModules();
  });

  it('waits for one-shot setup to finish, and names one that failed', async () => {
    // Rocket.Chat does not wait for minio-init, so on rootless Podman `up --wait` returned
    // while the bucket did not exist yet. A setup that exits non-zero is said, not hidden.
    jest.resetModules();
    const answers: { service: string; status: string; exitCode: number }[][] = [
      [{ service: 'minio-init', status: 'running', exitCode: 0 }],
      [{ service: 'minio-init', status: 'exited', exitCode: 0 }],
      [{ service: 'minio-init', status: 'exited', exitCode: 1 }],
    ];
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      oneShotSetups: async () => answers.shift() ?? [],
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({ name: 's3', project: 'houston-s3' });
    const said: string[] = [];
    const paused: number[] = [];
    await ready.waitForOneShotSetup(
      meta,
      (event) => void said.push(event.message),
      60,
      async (s) => {
        paused.push(s);
      },
    );
    expect(paused).toEqual([2]);
    expect(said).toEqual(['Rocket.Chat answers; waiting for minio-init to finish']);
    await expect(ready.waitForOneShotSetup(meta, () => undefined, 60)).rejects.toThrow(
      "minio-init exited 1 before it finished setting up 's3'",
    );
    jest.dontMock('../../../src/core/runner/queries');
  });

  it('does not hold a serving workspace on a mongo-init re-run that missed a lookup', async () => {
    // `restart` re-runs mongo-init; on rootless Podman its connect missed `mongodb` and it
    // exited 1, and a workspace whose replica set was PRIMARY and serving read as not ready.
    // Rocket.Chat serving is what proves the replica set.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      oneShotSetups: async () => [{ service: 'mongo-init', status: 'exited', exitCode: 1 }],
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    await expect(
      ready.waitForOneShotSetup(metadata({ name: 'm', project: 'houston-m' }), () => undefined, 5),
    ).resolves.toBeUndefined();
    jest.dontMock('../../../src/core/runner/queries');
  });

  it('is not ready while the bucket setup has failed, though Rocket.Chat answers', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      servicesByProject: async () => ({}),
      oneShotSetups: async () => [{ service: 'minio-init', status: 'exited', exitCode: 1 }],
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi'),
      waitReady: async () => ({ version: '8.5.1' }),
      apiInfo: async () => ({ version: '8.5.1' }),
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({
      name: 's3w',
      project: 'houston-s3w',
      rcVersion: '8.5.1',
      rootUrl: 'http://localhost:3601',
      hostPort: 3601,
    });
    await expect(ready.waitServing(meta, () => undefined, 60)).rejects.toThrow(
      'minio-init exited 1',
    );
    jest.dontMock('../../../src/core/runner/queries');
    jest.dontMock('../../../src/core/rcapi');
  });

  it('is ready when every instance answers, not when the front door first does', async () => {
    // The workspace's Traefik starts every server healthy and checks every 10 s, so the
    // first instance to answer made `ready` return while the others booted: 9-10 of 20
    // requests answered 502 right after it, and the admin login failed.
    jest.resetModules();
    const asked: string[] = [];
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      servicesByProject: async () => ({}),
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi'),
      waitReady: async (url: string) => {
        asked.push(url);
        return { version: '8.5.1' };
      },
      // No database to refuse over: the subject is which addresses were waited on.
      apiInfo: async () => ({ version: '8.5.1' }),
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({
      name: 'mi',
      project: 'houston-mi',
      rcVersion: '8.5.1',
      rootUrl: 'http://localhost:3600',
      hostPort: 3600,
      extra: { instances: 2 },
    });
    await ready.waitServing(meta, () => undefined, 60).catch(() => undefined);
    expect(asked).toEqual([
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]);
  });

  it('names the instance that is not serving', async () => {
    // One replica stopped, the front door answering: `ready` exited 5 with only "did not
    // become ready within 59s", and which of the instances was down was left to find.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      servicesByProject: async () => ({}),
    }));
    jest.doMock('../../../src/core/rcapi', () => {
      const actual = jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi');
      return {
        ...actual,
        waitReady: async (url: string, { timeout = 0 }: { timeout?: number } = {}) => {
          if (url === 'http://localhost:3602') {
            throw new actual.NotReady(
              `Rocket.Chat did not become ready within ${String(Math.trunc(timeout))}s`,
            );
          }
          return { version: '8.5.1' };
        },
      };
    });
    jest.doMock('../../../src/core/diagnose', () => ({
      ...jest.requireActual<object>('../../../src/core/diagnose'),
      diagnoseFailure: async () => null,
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
      const meta = metadata({
        name: 'd2',
        project: 'houston-d2',
        rcVersion: '8.5.1',
        rootUrl: 'http://localhost:3600',
        hostPort: 3600,
        extra: { instances: 2 },
      });
      await expect(ready.waitServing(meta, () => undefined, 60)).rejects.toThrow(
        /did not become ready within \d+s: rocketchat-2 at http:\/\/localhost:3602 is not serving/u,
      );
    } finally {
      jest.dontMock('../../../src/core/runner/queries');
      jest.dontMock('../../../src/core/rcapi');
      jest.dontMock('../../../src/core/diagnose');
    }
  });
});

describe('readiness through the owned HTTPS origin', () => {
  afterEach(() => {
    for (const module of [
      '../../../src/core/runner/queries',
      '../../../src/core/rcapi',
      '../../../src/core/tls',
    ])
      jest.dontMock(module);
    jest.resetModules();
  });

  it('refuses internal success when the restored origin does not serve HTTP', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      oneShotSetups: async () => [],
      servicesByProject: async () => ({}),
    }));
    const asked: string[] = [];
    jest.doMock('../../../src/core/rcapi', () => {
      const actual = jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi');
      return {
        ...actual,
        waitReady: async (url: string) => {
          asked.push(url);
          if (url.startsWith('https:')) throw new actual.NotReady('origin HTTP timeout');
          return { version: '8.5.1' };
        },
      };
    });
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    await expect(
      ready.waitServing(
        metadata({
          name: 'restored',
          project: 'houston-restored',
          rootUrl: 'http://localhost:3500',
          publicUrl: 'https://workspace.example.test',
          extra: { edge: true, tls: 'acme' },
        }),
        () => undefined,
        60,
      ),
    ).rejects.toThrow('its HTTPS origin https://workspace.example.test is not serving');
    expect(asked).toEqual(['http://localhost:3500', 'https://workspace.example.test']);
  });

  it('checks a complete page on loopback with the advertised SNI and a per-observation pin', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      oneShotSetups: async () => [],
      servicesByProject: async () => ({}),
    }));
    const observations: unknown[] = [];
    jest.doMock('../../../src/core/tls', () => ({
      ...jest.requireActual<object>('../../../src/core/tls'),
      originCertificate: async (host: string, options: unknown) => {
        observations.push({ host, options });
        return { pem: 'OWNED-DEFAULT-CERTIFICATE', fallback: true, error: '' };
      },
    }));
    const requests: unknown[] = [];
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      waitReady: async (
        url: string,
        options: {
          page?: boolean;
          requestOptions?: (remaining: number) => Promise<unknown>;
        },
      ) => {
        if (options.requestOptions !== undefined)
          requests.push({ url, page: options.page, options: await options.requestOptions(1200) });
        return { version: '8.5.1' };
      },
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    await ready.waitServing(
      metadata({
        name: 'pending',
        project: 'houston-pending',
        rootUrl: 'http://localhost:3500',
        publicUrl: 'https://workspace.example.test:3443',
        extra: { edge: true, tls: 'acme' },
      }),
      () => undefined,
      60,
    );
    expect(observations).toEqual([
      {
        host: 'workspace.example.test',
        options: { port: 3443, timeout: 1.2 },
      },
    ]);
    expect(requests).toEqual([
      {
        url: 'https://workspace.example.test:3443',
        page: true,
        options: {
          followRedirects: false,
          loopbackOrigin: {
            certificate: 'OWNED-DEFAULT-CERTIFICATE',
            allowCertificateNameMismatch: true,
          },
        },
      },
    ]);
  });
});
