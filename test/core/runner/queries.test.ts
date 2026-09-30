import * as fs from 'node:fs';
import * as path from 'node:path';

import * as seam from '../../../src/seams/docker-cli';
import { Interrupted, SpawnFailure } from '../../../src/seams/exec';

import * as engine from '../../../src/core/runner/engine';
import * as queries from '../../../src/core/runner/queries';
import { metadata, writeRecord } from '../../../src/core/runner/record';

/**
 * `engine` is mocked as a MODULE rather than spied on.
 *
 * swc emits an ES module's exports as non-configurable getters, so `jest.spyOn` on one of
 * these modules fails with "Cannot redefine property". That is the same constraint the
 * Kubernetes seam lives under -- emitted TypeScript cannot replace a module-local
 * binding, which is why `kube/exec.ts` puts its one injectable callable on an exported
 * OBJECT. Where there is no such object, the module is the seam.
 */
jest.mock('../../../src/core/runner/engine', () => ({
  ps: jest.fn(),
  compose: jest.fn(),
  serviceContainerIds: jest.fn(),
}));

jest.mock('../../../src/seams/docker-cli', () => {
  const store = new Map<string, unknown>();
  return {
    docker: jest.fn(),
    compose: jest.fn(),
    invalidateQueries: jest.fn(() => store.clear()),
    // The real memo, because "is it cached" is one of the questions here.
    cachedQuery: jest.fn(async (key: string, produce: () => Promise<unknown>) => {
      if (store.has(key)) return store.get(key);
      const value = await produce();
      store.set(key, value);
      return value;
    }),
  };
});

const dockerMock = seam.docker as jest.MockedFunction<typeof seam.docker>;
const psMock = engine.ps as jest.MockedFunction<typeof engine.ps>;
const idsMock = engine.serviceContainerIds as jest.MockedFunction<
  typeof engine.serviceContainerIds
>;

function answer(overrides: Partial<Awaited<ReturnType<typeof seam.docker>>> = {}) {
  return { argv: ['docker'], exitCode: 0, signal: null, stdout: '', stderr: '', ...overrides };
}

beforeEach(() => {
  seam.invalidateQueries();
  dockerMock.mockResolvedValue(answer());
  psMock.mockResolvedValue('');
  idsMock.mockResolvedValue([]);
});

describe('"could not ask" is not "the answer is none"', () => {
  it('returns null from projectStates when the query itself failed', async () => {
    // `prune` DELETES based on absence. Reading a failed query as "no projects" is how a
    // workspace that was merely unreachable gets reclaimed.
    dockerMock.mockResolvedValue(answer({ exitCode: 1 }));
    expect(await queries.projectStates()).toBeNull();

    seam.invalidateQueries();
    dockerMock.mockRejectedValue(new SpawnFailure(['docker'], new Error('gone')));
    expect(await queries.projectStates()).toBeNull();
  });

  it('returns an empty map when docker answered and there is nothing running', async () => {
    dockerMock.mockResolvedValue(answer({ stdout: '[]' }));
    expect(await queries.projectStates()).toEqual({});
  });

  it('returns null from rcContainerEnv when the container could not be inspected', async () => {
    // NULL, not {}: the caller reports drift by comparing two sets, so an empty one from
    // a failed read would report every recorded variable as missing.
    idsMock.mockResolvedValue([]);
    expect(await queries.rcContainerEnv('x')).toBeNull();

    idsMock.mockResolvedValue(['abc']);
    dockerMock.mockResolvedValue(answer({ exitCode: 1 }));
    expect(await queries.rcContainerEnv('x')).toBeNull();
  });

  it('reads the container environment into a map when it can', async () => {
    idsMock.mockResolvedValue(['abc']);
    dockerMock.mockResolvedValue(
      answer({ stdout: '["ROOT_URL=http://x","MONGO_URL=mongodb://y"]' }),
    );
    expect(await queries.rcContainerEnv('x')).toEqual({
      ROOT_URL: 'http://x',
      MONGO_URL: 'mongodb://y',
    });
  });

  it('reads a variable named __proto__ as one of its own, as a dict does', async () => {
    // `out[key] = value` on a dict. Assigned on a plain object, `__proto__` hit
    // `Object.prototype`'s accessor and was dropped, so `houston env` reported an override
    // `env --set __proto__=x` had just applied as NOT RUNNING.
    idsMock.mockResolvedValue(['abc']);
    dockerMock.mockResolvedValue(answer({ stdout: '["A=1","__proto__=x","constructor=c"]' }));
    const live = await queries.rcContainerEnv('x');
    expect(Object.entries(live ?? {})).toEqual([
      ['A', '1'],
      ['__proto__', 'x'],
      ['constructor', 'c'],
    ]);
    expect(Object.getPrototypeOf(live)).toBe(Object.prototype);
  });
});

describe('compose ls, in both of the shapes compose emits', () => {
  it('reads a JSON array', async () => {
    dockerMock.mockResolvedValue(
      answer({
        stdout:
          '[{"Name":"houston-a","Status":"running(3)"},{"Name":"houston-b","Status":"exited(2)"}]',
      }),
    );
    expect(await queries.projectStates()).toEqual({
      'houston-a': 'running(3)',
      'houston-b': 'exited(2)',
    });
  });

  it('reads NDJSON, which is what an older compose writes', async () => {
    dockerMock.mockResolvedValue(
      answer({
        stdout:
          '{"Name":"houston-a","ConfigFiles":"/a/docker-compose.yml"}\n{"Name":"houston-b","ConfigFiles":"/b/docker-compose.yml"}\n',
      }),
    );
    expect(await queries.projectConfigFiles()).toEqual({
      'houston-a': '/a/docker-compose.yml',
      'houston-b': '/b/docker-compose.yml',
    });
  });

  it('reads an answer of `null` as a query that failed, as earlier releases do', async () => {
    // Earlier releases parse `null` as no value, hand it back as-is and read it as "could
    // not ask" in the project states. Wrapped as `[null]` it reached `item.Name`
    // and `houston list` crashed with a stack; Go writes a nil slice as `null`.
    dockerMock.mockResolvedValue(answer({ stdout: 'null\n' }));
    expect(await queries.projectStates()).toBeNull();
    seam.invalidateQueries();
    expect(await queries.projectConfigFiles()).toBeNull();
    seam.invalidateQueries();
    dockerMock.mockResolvedValue(answer({ stdout: '{"Name":"houston-a","Status":"running(1)"}' }));
    expect(await queries.projectStates()).toEqual({ 'houston-a': 'running(1)' });
  });

  it('memoises the poll, so ten open tabs are one call', async () => {
    dockerMock.mockResolvedValue(
      answer({ stdout: '[{"Name":"houston-a","Status":"running(1)"}]' }),
    );
    await queries.projectStates();
    await queries.projectStates();
    expect(dockerMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every row `compose ls` answers is asked as an object, as earlier releases ask it when they
 * read the project states and the project config files: what they answered for the same
 * docker output is what this is held to, recorded. This dropped the rows that were not
 * objects, so a WARN line on stdout before the array -- which the NDJSON reading takes as one
 * row that is a list -- read as no projects: every workspace looked down and `prune --yes`
 * deleted a running one, where earlier releases raise before anything is pruned.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'core', 'runner', 'queries.json'),
    'utf8',
  ),
) as { composeLsRows: unknown[] };

const LS_ANSWERS = [
  '[{"Name":"houston-a","Status":"running(3)","ConfigFiles":"/a/c.yml"}]',
  'WARN[0000] /x: the attribute version is obsolete\n[{"Name":"houston-alpha","Status":"running(2)"}]\n',
  '[1, "x", null]',
  '[{"Name":"houston-a","Status":"running(1)"}, 5]',
  '{"Name":"houston-a","Status":"running(1)"}',
  '{"Name":"houston-a"}\nnull\n',
  '[{"Name":"houston-a"}]\n[{"Name":"houston-b"}]\n',
  '[{"Name":["houston-a"]}]',
  '[{"Status":"running(2)"},{"Name":"houston-alpha"}]',
  'null',
  '',
  '5',
  'true',
  'NaN',
  '"ab"',
  '""',
  'garbage\n',
  '\u001c[{"Name":"houston-a","Status":"exited(1)"}]',
];

describe('compose ls rows, against the project states and config files earlier releases read', () => {
  it('asks every row as an object, and raises where earlier releases raise', async () => {
    const recorded = RECORDED.composeLsRows;
    const ask = async (fn: () => Promise<unknown>) => {
      try {
        return { value: await fn() };
      } catch (error) {
        return { error: `${(error as Error).name}: ${(error as Error).message}` };
      }
    };
    const ours: unknown[] = [];
    for (const stdout of LS_ANSWERS) {
      dockerMock.mockResolvedValue(answer({ stdout }));
      seam.invalidateQueries();
      const states = await ask(queries.projectStates);
      seam.invalidateQueries();
      ours.push({
        project_states: states,
        project_config_files: await ask(queries.projectConfigFiles),
      });
    }
    expect(ours).toEqual(recorded);
    expect(recorded[1]).toEqual({
      project_states: { error: 'TypeError: expected an object, got a list' },
      project_config_files: { error: 'TypeError: expected an object, got a list' },
    });
  });
});

/**
 * Which containers the restart count and the environment ask about, against what earlier
 * releases asked: the first answer that is not empty, so ONE `compose ps -q` when the
 * `rocketchat` service answers, the `rocketchat-1` one only when it does not. The first
 * port asked `rocketchat` twice whenever it answered -- an extra docker process on every
 * readiness tick.
 */
describe('the Rocket.Chat container, against the restart count and environment earlier releases read', () => {
  it('asks for the rocketchat service once when it answers, as earlier releases do', async () => {
    const worlds: [string[], string[]][] = [
      [['abc'], ['def']],
      [[], ['def']],
      [[], []],
    ];
    // What earlier releases asked docker and answered in each world, recorded.
    const recorded = [
      { fn: 'rc_restart_count', calls: [['w', 'rocketchat']], value: 7 },
      { fn: 'rc_container_env', calls: [['w', 'rocketchat']], value: { A: '1' } },
      {
        fn: 'rc_restart_count',
        calls: [
          ['w', 'rocketchat'],
          ['w', 'rocketchat-1'],
        ],
        value: 7,
      },
      {
        fn: 'rc_container_env',
        calls: [
          ['w', 'rocketchat'],
          ['w', 'rocketchat-1'],
        ],
        value: { A: '1' },
      },
      {
        fn: 'rc_restart_count',
        calls: [
          ['w', 'rocketchat'],
          ['w', 'rocketchat-1'],
        ],
        value: 0,
      },
      {
        fn: 'rc_container_env',
        calls: [
          ['w', 'rocketchat'],
          ['w', 'rocketchat-1'],
        ],
        value: null,
      },
    ];
    const ours: unknown[] = [];
    for (const [first, second] of worlds) {
      for (const fn of ['rc_restart_count', 'rc_container_env'] as const) {
        const calls: string[][] = [];
        idsMock.mockImplementation(async (name: string, service: string) => {
          calls.push([name, service]);
          return [...(service === 'rocketchat' ? first : second)];
        });
        dockerMock.mockResolvedValue(
          answer({ stdout: fn === 'rc_container_env' ? '["A=1"]' : '7\n' }),
        );
        const value =
          fn === 'rc_restart_count'
            ? await queries.rcRestartCount('w')
            : await queries.rcContainerEnv('w');
        ours.push({ fn, calls, value });
      }
    }
    expect(ours).toEqual(recorded);
    expect(recorded[0]).toEqual({ fn: 'rc_restart_count', calls: [['w', 'rocketchat']], value: 7 });
  });
});

describe('what the dashboard reads', () => {
  it('keeps every service, not just Rocket.Chat', async () => {
    // Keeping only the rocketchat line is why a repro whose MONGODB had exited reported
    // running and healthy: both were derived from a container that serves /api/info
    // perfectly well with no database behind it.
    dockerMock.mockResolvedValue(
      answer({
        stdout:
          'houston-a\trocketchat\tUp 2 hours (healthy)\nhouston-a\tmongodb\tExited (1)\nhouston-b\trocketchat-1\tUp 5 minutes\n',
      }),
    );
    expect(await queries.servicesByProject()).toEqual({
      'houston-a': { rocketchat: 'Up 2 hours (healthy)', mongodb: 'Exited (1)' },
      'houston-b': { 'rocketchat-1': 'Up 5 minutes' },
    });
    expect(await queries.rcStatusByProject()).toEqual({
      'houston-a': 'Up 2 hours (healthy)',
      'houston-b': 'Up 5 minutes',
    });
  });

  it('answers with an empty map when docker could not be asked', async () => {
    dockerMock.mockRejectedValue(new SpawnFailure(['docker'], new Error('gone')));
    expect(await queries.servicesByProjectUncached()).toEqual({});
  });

  it('reads the first Rocket.Chat instance for a coarse state', async () => {
    psMock.mockResolvedValue('mongodb\trunning\tUp\nrocketchat-1\texited\tExited\n');
    expect(await queries.rcState('x')).toBe('exited');
    psMock.mockResolvedValue('mongodb\trunning\tUp\n');
    expect(await queries.rcState('x')).toBe('absent');
  });

  it('lets a Ctrl-C through, which the launch-failure handler does not catch', async () => {
    // Caught, a Ctrl-C in `docker inspect` during `backup`'s wait for Rocket.Chat was a count
    // of 0 and one more `still booting` line.
    idsMock.mockResolvedValue(['abc']);
    dockerMock.mockRejectedValue(new Interrupted());
    await expect(queries.rcRestartCount('x')).rejects.toBeInstanceOf(Interrupted);
  });

  it('counts restarts, and calls an unreadable count zero', async () => {
    idsMock.mockResolvedValue(['abc']);
    dockerMock.mockResolvedValue(answer({ stdout: '7\n' }));
    expect(await queries.rcRestartCount('x')).toBe(7);
    dockerMock.mockResolvedValue(answer({ stdout: 'not a number' }));
    expect(await queries.rcRestartCount('x')).toBe(0);
  });
});

describe('volumes', () => {
  it('removes them under the RECORDED project name, and treats gone as removed', async () => {
    await writeRecord('vols', metadata({ name: 'vols', project: 'rc-repro-vols' }));
    dockerMock
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce(answer({ exitCode: 1, stderr: 'Error: no such volume: x' }))
      .mockResolvedValueOnce(answer({ exitCode: 1, stderr: 'Error: volume is in use' }));

    expect(await queries.removeVolumes('vols', ['mongo', 'gone', 'busy'])).toEqual([
      'rc-repro-vols_busy',
    ]);
    expect(dockerMock.mock.calls.map((call) => call[0][2])).toEqual([
      'rc-repro-vols_mongo',
      'rc-repro-vols_gone',
      'rc-repro-vols_busy',
    ]);
  });
});

describe('stats', () => {
  it('asks for nothing when there is nothing to ask about', async () => {
    expect(await queries.dockerStats([])).toBe('');
    expect(dockerMock).not.toHaveBeenCalled();
  });

  it('returns an empty sample rather than stranding the sampler', async () => {
    dockerMock.mockRejectedValue(new SpawnFailure(['docker'], new Error('wedged')));
    expect(await queries.dockerStats(['abc'])).toBe('');
  });
});

describe('the queries behind the GUI poll', () => {
  it('calls a workspace with no Rocket.Chat container zero restarts, and does not ask', async () => {
    idsMock.mockResolvedValue([]);
    expect(await queries.rcRestartCount('x')).toBe(0);
    expect(dockerMock).not.toHaveBeenCalled();
  });

  it('degrades on a wedged daemon instead of raising, and bounds every call', async () => {
    // A wedged daemon must degrade, not park a worker forever: `dockerAvailable` can pass
    // and the NEXT call still hang, and these run on the dashboard's 4 s poll. Each has a
    // documented "could not ask docker" value -- they just have to reach it.
    idsMock.mockResolvedValue(['abc']);
    for (const failure of [
      new SpawnFailure(['docker'], new Error('timed out')),
      new SpawnFailure(['docker'], new Error('spawn docker ENOENT')),
      new Error('no fork'),
    ]) {
      seam.invalidateQueries();
      dockerMock.mockReset();
      dockerMock.mockRejectedValue(failure);
      expect(await queries.composeLs()).toBeNull(); // null = "could not ask"
      expect(await queries.projectStates()).toBeNull(); // prune refuses on null
      expect(await queries.rcStatusByProject()).toEqual({});
      expect(await queries.rcRestartCount('x')).toBe(0);
    }

    // And every one of them passes a timeout, so the hang cannot happen at all.
    seam.invalidateQueries();
    dockerMock.mockReset();
    dockerMock.mockResolvedValue(answer({ exitCode: 1 }));
    await queries.composeLs();
    await queries.rcStatusByProject();
    await queries.rcRestartCount('x');
    const timeouts = dockerMock.mock.calls.map((call) => call[1]?.timeoutMs);
    expect(timeouts.length).toBeGreaterThanOrEqual(3);
    for (const timeout of timeouts) expect(timeout).toEqual(expect.any(Number));
  });
});
