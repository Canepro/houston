import type * as LoadtestNS from '../../src/core/loadtest';
import * as runnerRecord from '../../src/core/runner/record';

it('Grafana public URL regression: gives the load-test iframe the public sub-path URL', async () => {
  const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
  const run = loadtest.newLoadRun();
  run.summary = { p95: 1, rps: 1, error_rate: 0 };
  const result = await loadtest.loadtestVerdict({
    deps: loadtest.DEFAULT_DEPS,
    emit: () => undefined,
    m: runnerRecord.metadata({ name: 'w', publicUrl: 'https://h', extra: { tls: 'local' } }),
    req: loadtest.loadtestReq({ name: 'w', live: true, diag: false }),
    rules: [],
    run,
  });
  expect(result.grafana).toBe('https://h/grafana');
});

describe('what a load test refuses before it runs', () => {
  afterEach(() => {
    jest.resetModules();
  });

  interface Refusal {
    result: unknown;
    error: { kind: string; message: string } | null;
    events: string[];
  }

  const CASES = [
    { name: 'bad scenario', scenario: 'webhook', vus: 10, live: false, slo: '', constrain: '' },
    { name: 'vus below one', scenario: 'messages', vus: 0, live: false, slo: '', constrain: '' },
    {
      name: 'live without monitoring',
      scenario: 'messages',
      vus: 10,
      live: true,
      slo: '',
      constrain: '',
    },
    {
      name: 'live without remote-write',
      scenario: 'messages',
      vus: 10,
      live: true,
      slo: '',
      constrain: '',
      withMonitoring: true,
    },
    {
      name: 'bad slo',
      scenario: 'messages',
      vus: 10,
      live: false,
      slo: 'p95>fast',
      constrain: '',
    },
    {
      name: 'bad constrain',
      scenario: 'messages',
      vus: 10,
      live: false,
      slo: '',
      constrain: 'rc=banana',
    },
  ];

  /** What earlier releases answered for each case, in order, recorded. */
  const RECORDED: Refusal[] = [
    {
      result: null,
      error: {
        kind: 'ValidationError',
        message: 'scenario must be one of messages, login, read, mixed, journey, badbot',
      },
      events: [],
    },
    { result: null, error: { kind: 'ValidationError', message: 'vus must be >= 1' }, events: [] },
    {
      result: null,
      error: { kind: 'ValidationError', message: 'live streaming needs monitoring attached first' },
      events: [],
    },
    {
      result: null,
      error: {
        kind: 'ValidationError',
        message: 'live needs Prometheus with remote-write - re-attach monitoring',
      },
      events: [],
    },
    {
      result: null,
      error: {
        kind: 'ValidationError',
        message: "bad slo: bad rule 'p95>fast' (expected key=value)",
      },
      events: [],
    },
    {
      result: null,
      error: {
        kind: 'ValidationError',
        message:
          "bad constrain: bad constraint part 'banana' in 'rc=banana' (want e.g. 2cpu, 2g, 512m)",
      },
      events: [],
    },
  ];

  async function typescriptRun(testCase: (typeof CASES)[number]): Promise<Refusal> {
    jest.resetModules();
    const events: string[] = [];
    const withMonitoring = testCase.withMonitoring === true;
    const doc = {
      services: {
        rocketchat: { environment: {}, ports: ['0.0.0.0:3000:3000'] },
        prometheus: {
          command: withMonitoring
            ? ['--storage.tsdb.retention.time=15d']
            : ['--web.enable-remote-write-receiver'],
        },
      },
    } as Record<string, unknown>;
    const meta = {
      name: 'x',
      project: 'houston-x',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://127.0.0.1:1',
      hostPort: 3000,
      versionSource: 'map',
      extra: withMonitoring ? { monitoring: true } : {},
    };
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      readCompose: async () => doc,
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        throw new Error('never reached');
      },
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    let result: unknown = null;
    let error: { kind: string; message: string } | null = null;
    try {
      result = await loadtest.runLoadtest(
        loadtest.loadtestReq({
          name: 'x',
          scenario: testCase.scenario,
          vus: testCase.vus,
          live: testCase.live,
          slo: testCase.slo,
          constrain: testCase.constrain,
        }),
        ((event: { message: string }) => events.push(event.message)) as never,
      );
    } catch (exc) {
      error = {
        kind: (exc as Error).constructor.name,
        message: (exc as Error).message,
      };
    }
    return { result, error, events };
  }

  it('refuses every bad request with the type and message earlier releases used', async () => {
    expect(RECORDED).toHaveLength(CASES.length);
    for (let index = 0; index < CASES.length; index += 1) {
      const mine = await typescriptRun(CASES[index] as (typeof CASES)[number]);
      expect(mine).toEqual(RECORDED[index]);
    }
  });

  it('names the port-forward when a Kubernetes workspace is asked to run', async () => {
    // The refusal is not "unimplemented": a number measured through a userspace relay is
    // a plausible wrong number, which is the one failure this tool cannot afford.
    jest.resetModules();
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'kubernetes',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => ({ rcVersion: '8.5.1' }),
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    await expect(
      loadtest.runLoadtest(loadtest.loadtestReq({ name: 'k', scenario: 'messages', vus: 1 })),
    ).rejects.toThrow(/port-forward/u);
  });
});

describe('the capacity verdict', () => {});

describe('a run that never reaches its finally', () => {
  /**
   * Putting everything back is the code a SIGKILL skips, which is why every side effect is
   * journaled BEFORE it is armed and why the constrain note is cleared only when the
   * restore reports no problems. The cases below drive it with fakes and check which notes
   * it clears afterwards.
   */
  afterEach(() => {
    jest.resetModules();
  });

  interface FakeCalls {
    constrainApply: string[];
    constrainRestore: string[];
    journalClear: string[];
    mongoStop: unknown[];
  }

  function fakeDeps(calls: FakeCalls): Partial<LoadtestNS.LoadtestDeps> {
    const applied = [
      {
        container: 'c1',
        service: 'rocketchat',
        prior_nano: 0,
        prior_mem: 0,
        prior_swap: 0,
        set_cpus: true,
        set_mem: false,
      },
    ];
    return {
      constrain: {
        ...jest.requireActual<object>('../../src/perf/constrain'),
        apply: async () => {
          calls.constrainApply.push('apply');
          return applied;
        },
        restore: async () => {
          calls.constrainRestore.push('restore');
          return ['rocketchat: cpu'];
        },
      } as never,
      k6: {
        ...jest.requireActual<object>('../../src/perf/k6'),
        run: async () => ({ p95: 1, rps: 2, error_rate: 0, count: 3 }),
      } as never,
      mongoprof: {
        ...jest.requireActual<object>('../../src/perf/mongoprof'),
        start: async () => ({ was: 0, slowms: 100 }),
        stop: async (name: string, prior: unknown) => {
          calls.mongoStop.push([name, prior]);
        },
        collect: async () => null,
      } as never,
      rcmetrics: {
        ...jest.requireActual<object>('../../src/perf/rcmetrics'),
        RCMetricsSampler: class {
          start(): this {
            return this;
          }
          async stop(): Promise<Record<string, never>> {
            return {};
          }
        },
      } as never,
    };
  }

  it('keeps the constraints note when the restore reports a problem', async () => {
    jest.resetModules();
    const calls: FakeCalls = {
      constrainApply: [],
      constrainRestore: [],
      journalClear: [],
      mongoStop: [],
    };
    const cleared: string[] = [];
    // REGISTERED BEFORE ANY `require('../../src/core/journal')`: a factory added after the module is
    // already in this test's registry is too late, and the require would hand back the
    // real (or a previous test's) instance while the spy sat unread.
    jest.doMock('../../src/core/journal', () => ({
      ...jest.requireActual('../../src/core/journal'),
      clear: (id: string) => {
        if (id !== '') cleared.push(id);
      },
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    const deps = loadtest.depsWith(fakeDeps(calls));
    const run = loadtest.newLoadRun();
    const meta = {
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rootUrl: 'http://127.0.0.1:1',
      extra: {},
    };
    const events: { message: string; phase: string }[] = [];
    await loadtest.armAndRun({
      auth: { token: 't', userId: 'u' },
      deps,
      emit: ((event: { message: string; phase: string }) => events.push(event)) as never,
      m: meta as never,
      perService: { rocketchat: { cpus: 2, mem: '2g' } },
      rcServices: ['rocketchat'],
      req: loadtest.loadtestReq({ name: 'w' }),
      run,
      target: 'http://rocketchat:3000',
      token: 'pat',
      users: [],
    });
    expect(run.constrainNote).not.toBe('');
    expect(run.limiterNote).not.toBe('');
    expect(run.metricsNote).not.toBe('');

    await loadtest.putEverythingBack({
      auth: { token: 't', userId: 'u' },
      deps,
      emit: ((event: { message: string; phase: string }) => events.push(event)) as never,
      m: meta as never,
      run,
    });

    // The restore reported a problem, so the note that carries the PRIOR limit values
    // must survive for a repair to use.
    expect(cleared).not.toContain(run.constrainNote);
    expect(cleared).toContain(run.limiterNote);
    expect(cleared).toContain(run.mongoNote);
    expect(
      events.some((event) => event.message.includes('could not restore resource limits')),
    ).toBe(true);
    expect(calls.constrainRestore).toEqual(['restore']);
  });

  it('reports the constraints repair by the PROBLEM LIST, not by array truthiness', async () => {
    // `not restore(...)` where restore returns a list of problems: an ARRAY IS ALWAYS
    // TRUTHY in JavaScript, so `!restore(...)` reported every failed restore as repaired
    // -- the note deleted and the containers left capped. An empty applied list is enough
    // to see the difference and needs no docker.
    jest.resetModules();
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    const repaired = await loadtest.repairConstraints(
      { detail: { applied: [] } } as never,
      (() => undefined) as never,
      null,
    );
    expect(repaired).toBe(true);
  });

  it('clears the constraints note when the restore is clean', async () => {
    jest.resetModules();
    const calls: FakeCalls = {
      constrainApply: [],
      constrainRestore: [],
      journalClear: [],
      mongoStop: [],
    };
    const cleared: string[] = [];
    jest.doMock('../../src/core/journal', () => ({
      ...jest.requireActual('../../src/core/journal'),
      clear: (id: string) => {
        if (id !== '') cleared.push(id);
      },
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    // BUILT FROM THE MODULE JUST REQUIRED, not `jest.requireActual`, which would load a
    // second copy of `loadtest` outside the mock registry and send `journal.clear` to the
    // real journal while the spy watched the mock.
    const deps: LoadtestNS.LoadtestDeps = {
      ...loadtest.DEFAULT_DEPS,
      ...fakeDeps(calls),
      constrain: {
        ...jest.requireActual<object>('../../src/perf/constrain'),
        restore: async () => [],
      } as never,
    };
    const run = loadtest.newLoadRun();
    run.constrainNote = 'note';
    run.appliedConstraints = [];
    const meta = { name: 'w', rootUrl: 'http://127.0.0.1:1', extra: {} };
    await loadtest.putEverythingBack({
      auth: { token: 't', userId: 'u' },
      deps,
      emit: (() => undefined) as never,
      m: meta as never,
      run,
    });
    expect(cleared).toContain('note');
  });
});

describe('the capacity search', () => {
  afterEach(() => {
    jest.resetModules();
  });

  interface SearchScript {
    [vus: number]: boolean;
  }

  async function typescriptSearch(script: SearchScript): Promise<Record<string, unknown>> {
    jest.resetModules();
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      getSetting: async () => false,
      setSetting: async () => true,
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    const calls: [number, string][] = [];
    const search = loadtest.newCapacitySearch();
    const req = loadtest.capacityReq({ name: 'x', usersN: 0, start: 10, maxVus: 40 });
    await loadtest.searchForCapacity({
      auth: { token: 't', userId: 'u' } as never,
      deps: loadtest.depsWith({}),
      emit: (() => undefined) as never,
      m: { name: 'x', rootUrl: 'http://127.0.0.1:1', extra: {} } as never,
      perService: {},
      req,
      runStep: async (vus: number, tag = '') => {
        calls.push([vus, tag]);
        return { vus, ok: script[vus] === true };
      },
      search,
    });
    return {
      calls,
      last_pass: search.lastPass,
      first_fail: search.firstFail,
      limiter_was_off: search.limiterWasOff,
      metrics_changed: search.metricsChanged,
    };
  }

  it('doubles then bisects exactly as earlier releases do', async () => {
    const script: SearchScript = { 10: true, 20: true, 40: false, 30: true, 35: false };
    // What earlier releases did with this script, recorded.
    const recorded = {
      calls: [
        [10, ''],
        [20, ''],
        [40, ''],
        [30, ' (bisect)'],
        [35, ' (bisect)'],
      ],
      last_pass: 30,
      first_fail: 35,
      limiter_was_off: true,
      metrics_changed: true,
    };
    expect(await typescriptSearch(script)).toEqual(recorded);
  });

  it('stops at max when nothing ever breaches', async () => {
    const script: SearchScript = { 10: true, 20: true, 40: true };
    // What earlier releases did with this script, recorded.
    const recorded = {
      calls: [
        [10, ''],
        [20, ''],
        [40, ''],
      ],
      last_pass: 40,
      first_fail: null,
      limiter_was_off: true,
      metrics_changed: true,
    };
    expect(await typescriptSearch(script)).toEqual(recorded);
  });
});

describe("a load test's verdict", () => {
  afterEach(() => {
    jest.resetModules();
  });

  async function typescriptVerdict(
    resources: Record<string, unknown> | null,
    onEvent: (event: { phase: string; data: unknown }) => void = () => undefined,
  ): Promise<Record<string, unknown>> {
    jest.resetModules();
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    const perf = require('../../src/perf/mongoprof') as object;
    const deps = loadtest.depsWith({
      mongoprof: { ...perf, collect: async () => null } as never,
      timeline: {
        ...jest.requireActual<object>('../../src/perf/timeline'),
        parse: () => null,
      } as never,
      verdict: {
        ...jest.requireActual<object>('../../src/perf/verdict'),
        analyze: () => [],
      } as never,
    });
    const run = loadtest.newLoadRun();
    run.summary = { p95: 123.45, rps: 42.25, error_rate: 0.0125 };
    run.resources = resources as never;
    const events: string[] = [];
    const out = await loadtest.loadtestVerdict({
      deps,
      emit: ((event: { message: string; phase: string; data: unknown }) => {
        events.push(String(event.message));
        onEvent(event);
      }) as never,
      m: { name: 'x' } as never,
      req: loadtest.loadtestReq({ name: 'x', diag: true }),
      rules: [],
      run,
    });
    return {
      grafana: out.grafana,
      mongo_slow: out.mongoSlow,
      passed: out.passed,
      short_stats: out.shortStats,
      slo_results: out.sloResults,
      tl: out.tl,
      verdict_lines: out.verdictLines,
      events,
    };
  }

  it('reports the same summary line and side fields as earlier releases', async () => {
    // What earlier releases reported for this run, recorded.
    const recorded = {
      grafana: null,
      mongo_slow: null,
      passed: true,
      short_stats: null,
      slo_results: [],
      tl: null,
      verdict_lines: [],
      events: ['done: p95 123ms at 42.2 req/s, 1.25% errors'],
    };
    expect(await typescriptVerdict(null)).toEqual(recorded);
  });

  it('reports an empty sampler as null, not an empty object', async () => {
    // An empty sampler result counts as none, and that is a real case: the sampler ran
    // but collected nothing. An earlier version reported `{}` until this was fixed.
    // Earlier releases reported null here, recorded.
    const recorded = null;
    const mine = await typescriptVerdict({});
    expect((mine as { short_stats: unknown }).short_stats).toBeNull();
    expect((mine as { short_stats: unknown }).short_stats).toEqual(recorded);
  });

  it('nests the summary line’s data one level, as earlier releases do', async () => {
    // Earlier releases passed the summary's data as ONE field named `data`, so its done
    // event carries {"data": {"passed": ...}}. Their events for this run, recorded.
    const recorded = [{ phase: 'done', data: { data: { passed: true } } }];
    const mine: unknown[] = [];
    await typescriptVerdict(null, (event) => mine.push({ phase: event.phase, data: event.data }));
    expect(mine.at(-1)).toEqual({ phase: 'done', data: { data: { passed: true } } });
    expect(mine).toEqual(recorded);
  });
});

describe('putting a capacity search back', () => {
  it('restores caps and removes users.json LAST, in the order earlier releases did', async () => {
    jest.resetModules();
    const calls: string[] = [];
    let usersPresentDuringRestore = false;
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      setSetting: async (_u: string, _a: unknown, _p: string, id: string, value: boolean) => {
        calls.push(`${id}=${String(value)}`);
        return true;
      },
    }));
    jest.doMock('../../src/core/journal', () => ({
      ...jest.requireActual('../../src/core/journal'),
      clear: () => undefined,
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    const paths = require('../../src/core/runner/paths') as { workspace: (n: string) => string };
    const fs = require('node:fs') as {
      mkdirSync: (p: string, o: { recursive: boolean }) => void;
      writeFileSync: (p: string, body: string, enc: string) => void;
      existsSync: (p: string) => boolean;
    };
    const path = require('node:path') as {
      join: (...parts: string[]) => string;
      dirname: (p: string) => string;
    };
    const usersFile = path.join(paths.workspace('w'), 'loadtest', 'users.json');
    fs.mkdirSync(path.dirname(usersFile), { recursive: true });
    fs.writeFileSync(usersFile, 'tokens', 'utf8');

    const deps = loadtest.depsWith({
      constrain: {
        ...jest.requireActual<object>('../../src/perf/constrain'),
        restore: async () => {
          calls.push('restore');
          usersPresentDuringRestore = fs.existsSync(usersFile);
          return ['rocketchat: cpu'];
        },
      } as never,
    });
    const search = loadtest.newCapacitySearch();
    search.limiterWasOff = false;
    search.limiterNote = 'lim';
    search.metricsChanged = true;
    search.metricsNote = 'met';
    search.applied = [];
    search.constrainNote = 'cap';
    await loadtest.putTheWorkspaceBack({
      auth: { token: 't', userId: 'u' } as never,
      deps,
      emit: (() => undefined) as never,
      m: { name: 'w', rootUrl: 'http://127.0.0.1:1', extra: {} } as never,
      search,
    });
    // The limiter and metrics are restored, then caps, then the credentials file goes.
    expect(calls).toEqual(['API_Enable_Rate_Limiter=true', 'Prometheus_Enabled=false', 'restore']);
    expect(usersPresentDuringRestore).toBe(true);
    expect(fs.existsSync(usersFile)).toBe(false);
  });
});

describe('logging the seeded users in', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('keeps only the 200s with a token, and stops on a transport failure', async () => {
    // What earlier releases logged in, and how many calls they made, for this script,
    // recorded.
    const recorded = {
      users: [
        { username: 'houston-user-0', password: 'houston-user-0', token: 'a0', uid: 'u0' },
        { username: 'houston-user-3', password: 'houston-user-3', token: 'a3', uid: 'u3' },
      ],
      calls: 5,
    };

    jest.resetModules();
    const script = [
      { raise: false, status: 200, payload: { data: { authToken: 'a0', userId: 'u0' } } },
      { raise: false, status: 200, payload: { data: null } },
      { raise: false, status: 500, payload: {} },
      { raise: false, status: 200, payload: { data: { authToken: 'a3', userId: 'u3' } } },
      { raise: true, status: 0, payload: {} },
    ];
    let calls = 0;
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      loginUser: async (_url: string, _user: string) => {
        const call = script[calls];
        calls += 1;
        if (call?.raise === true) throw new Error('boom');
        if (call?.status !== 200) return null;
        const data = (call.payload as { data: { authToken: string; userId: string } | null }).data;
        if (data === null) return null;
        return { authToken: data.authToken, userId: data.userId };
      },
    }));
    jest.doMock('../../src/seed/wording', () => ({
      ...jest.requireActual('../../src/seed/wording'),
      username: (i: number) => `houston-user-${String(i)}`,
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    const users = await loadtest.loginSeedUsers('http://x/', 5);
    expect({ users, calls }).toEqual({ users: recorded.users, calls: recorded.calls });
  });
});

describe('the CLI load-shape controls on the shared transaction', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('keeps GUI defaults inert and forwards ramp/spike, custom env, quiet, and timeline together', async () => {
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      getSetting: async () => false,
      setSetting: async () => true,
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    expect(loadtest.loadtestReq({ name: 'w' })).toMatchObject({
      ramp: null,
      spike: null,
      extraEnv: null,
      quiet: true,
      setupWarnings: false,
    });

    const k6Run = jest.fn(async (..._args: unknown[]) => ({ p95: 1, rps: 2, error_rate: 0 }));
    const deps = loadtest.depsWith({
      k6: { ...jest.requireActual<object>('../../src/perf/k6'), run: k6Run } as never,
    });
    const run = loadtest.newLoadRun();
    await loadtest.armAndRun({
      auth: { token: 'admin', userId: 'admin-id' },
      deps,
      emit: (() => undefined) as never,
      m: runnerRecord.metadata({
        name: 'w',
        rootUrl: 'http://127.0.0.1:19001',
        adminPassword: 'secret',
      }),
      perService: {},
      rcServices: ['rocketchat'],
      req: loadtest.loadtestReq({
        name: 'w',
        diag: false,
        ramp: null,
        spike: '3:30',
        extraEnv: { RC_METHOD: 'POST', RC_PATH: '/api/v1/x', RC_BODY: '{}' },
        quiet: false,
        live: true,
      }),
      run,
      target: 'http://rocketchat:3000',
      token: 'pat',
      users: [],
    });

    expect(k6Run).toHaveBeenCalledWith(
      'w',
      'messages',
      expect.objectContaining({
        ramp: null,
        spike: '3:30',
        timeline: true,
        extraEnv: { RC_METHOD: 'POST', RC_PATH: '/api/v1/x', RC_BODY: '{}' },
        quiet: false,
        live: true,
      }),
    );

    await loadtest.armAndRun({
      auth: { token: 'admin', userId: 'admin-id' },
      deps,
      emit: (() => undefined) as never,
      m: runnerRecord.metadata({
        name: 'w',
        rootUrl: 'http://127.0.0.1:19001',
        adminPassword: 'secret',
      }),
      perService: {},
      rcServices: ['rocketchat'],
      req: loadtest.loadtestReq({
        name: 'w',
        diag: false,
        ramp: '5:50',
        spike: null,
      }),
      run: loadtest.newLoadRun(),
      target: 'http://rocketchat:3000',
      token: 'pat',
      users: [],
    });
    expect(k6Run).toHaveBeenLastCalledWith(
      'w',
      'messages',
      expect.objectContaining({ ramp: '5:50', spike: null, timeline: false }),
    );
    expect(k6Run.mock.calls.at(-1)?.[2]).not.toHaveProperty('extraEnv');
  });

  it('retains the CLI setup warnings without changing the GUI default', async () => {
    const cleared: string[] = [];
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      getSetting: async () => true,
      setSetting: async () => false,
    }));
    jest.doMock('../../src/core/journal', () => ({
      ...jest.requireActual('../../src/core/journal'),
      record: () => 'rate-note',
      clear: (note: string) => cleared.push(note),
    }));
    const loadtest = require('../../src/core/loadtest') as typeof LoadtestNS;
    const deps = loadtest.depsWith({
      k6: {
        ...jest.requireActual<object>('../../src/perf/k6'),
        run: async () => ({ p95: 1, rps: 2, error_rate: 0 }),
      } as never,
      mongoprof: {
        ...jest.requireActual<object>('../../src/perf/mongoprof'),
        start: async () => null,
      } as never,
      rcmetrics: {
        ...jest.requireActual<object>('../../src/perf/rcmetrics'),
        RCMetricsSampler: class {
          start(): this {
            return this;
          }
          async stop(): Promise<Record<string, never>> {
            return {};
          }
        },
      } as never,
    });
    const events: string[] = [];
    const run = loadtest.newLoadRun();
    await loadtest.armAndRun({
      auth: { token: 'admin', userId: 'admin-id' },
      deps,
      emit: ((event: { message: string }) => events.push(event.message)) as never,
      m: runnerRecord.metadata({
        name: 'w',
        rootUrl: 'http://127.0.0.1:19001',
        adminPassword: 'secret',
      }),
      perService: {},
      rcServices: ['rocketchat'],
      req: loadtest.loadtestReq({ name: 'w', diag: true, setupWarnings: true }),
      run,
      target: 'http://rocketchat:3000',
      token: 'pat',
      users: [],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        'could not disable the API rate limiter — results may be throttled (429s)',
        'Mongo slow-query capture unavailable (profiler could not be enabled)',
      ]),
    );
    expect(run.limiterNote).toBe('');
    expect(cleared).toContain('rate-note');
  });
});

describe('what a capacity search refuses before it runs', () => {
  afterEach(() => {
    jest.resetModules();
  });

  function load(runtime: string): typeof LoadtestNS {
    jest.resetModules();
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => runtime,
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => ({ rcVersion: '8.5.1' }),
    }));
    return require('../../src/core/loadtest') as typeof LoadtestNS;
  }

  it('refuses a scenario the GUI does not offer and a start below one, as a ValidationError', async () => {
    const loadtest = load('docker');
    for (const values of [{ scenario: 'webhook' }, { scenario: 'journey', start: 0 }]) {
      const refused = await loadtest
        .runCapacity(loadtest.capacityReq({ name: 'x', ...values }))
        .then(
          () => null,
          (error: unknown) => error as Error,
        );
      expect(refused?.constructor.name).toBe('ValidationError');
    }
  });

  it('refuses a Kubernetes workspace by naming the port-forward, rather than crashing', async () => {
    // Both perf entry points read the compose file, so on Kubernetes they raised a bare
    // file-not-found: outside the ReproError contract, a 500 in `serve`.
    const loadtest = load('kubernetes');
    const refused = await loadtest
      .runCapacity(loadtest.capacityReq({ name: 'k', scenario: 'messages' }))
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(refused?.constructor.name).toBe('ValidationError');
    expect(refused?.message).toContain('port-forward');
  });
});
