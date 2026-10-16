import * as seam from '../../../src/seams/docker-cli';
import { SpawnFailure } from '../../../src/seams/exec';

import * as engine from '../../../src/core/runner/engine';
import { workspace } from '../../../src/core/runner/paths';

jest.mock('../../../src/seams/docker-cli', () => ({
  compose: jest.fn(),
  composeStream: jest.fn(),
  composeToFile: jest.fn(),
  composeFromFile: jest.fn(),
  invalidateQueries: jest.fn(),
  docker: jest.fn(),
}));

const composeMock = seam.compose as jest.MockedFunction<typeof seam.compose>;
const dockerMock = seam.docker as jest.MockedFunction<typeof seam.docker>;
const invalidateMock = seam.invalidateQueries as jest.MockedFunction<typeof seam.invalidateQueries>;

function answer(overrides: Partial<Awaited<ReturnType<typeof seam.compose>>> = {}) {
  return {
    argv: ['docker', 'compose'],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

beforeEach(() => {
  composeMock.mockResolvedValue(answer());
});

describe('a compose command for one workspace', () => {
  it('runs in that workspace, and nowhere else', async () => {
    await engine.compose('TICKET-1', ['ps'], { capture: true });
    expect(composeMock).toHaveBeenCalledWith(['ps'], {
      capture: true,
      cwd: workspace('TICKET-1'),
    });
  });

  it('pulls before up, and a failed pull does not stop the up', async () => {
    composeMock.mockResolvedValueOnce(answer({ exitCode: 1 })); // the pull
    expect(await engine.up('TICKET-1')).toBe(0);
    expect(composeMock.mock.calls.map((call) => call[0])).toEqual([
      ['pull'],
      ['up', '-d', '--remove-orphans'],
    ]);
  });

  it.each([
    ['one service', 'rocketchat', ['rocketchat']],
    ['every replica named', ['rocketchat-1', 'rocketchat-2'], ['rocketchat-1', 'rocketchat-2']],
  ])('recreates %s without taking its database down', async (_label, named, services) => {
    await engine.up('TICKET-1', { pull: false, forceRecreate: named });
    expect(composeMock.mock.calls[0]?.[0]).toEqual([
      'up',
      '-d',
      '--remove-orphans',
      '--force-recreate',
      '--no-deps',
      ...services,
    ]);
  });

  it('recreates nothing by force when no service is named', async () => {
    await engine.up('TICKET-1', { pull: false, forceRecreate: [] });
    expect(composeMock.mock.calls[0]?.[0]).toEqual(['up', '-d', '--remove-orphans']);
  });
});

describe('the memo and the mutations', () => {
  it.each([
    ['up', () => engine.up('x', { pull: false })],
    ['down', () => engine.down('x')],
    ['start', () => engine.start('x')],
    ['stop', () => engine.stop('x')],
    ['restart', () => engine.restart('x')],
  ])('drops the memoised docker state after %s', async (_name, run) => {
    await run();
    expect(invalidateMock).toHaveBeenCalled();
  });

  it('drops it even when the command fails, so the UI is not left stale', async () => {
    composeMock.mockRejectedValueOnce(new SpawnFailure(['docker'], new Error('boom')));
    await expect(engine.stop('x')).rejects.toBeInstanceOf(SpawnFailure);
    expect(invalidateMock).toHaveBeenCalled();
  });

  it('does not drop it for a read', async () => {
    await engine.ps('x');
    await engine.containerIds('x');
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});

describe('the error contracts, which differ on purpose', () => {
  it('propagates a launch failure from a mutating command', async () => {
    composeMock.mockRejectedValue(new SpawnFailure(['docker'], new Error('no docker')));
    await expect(engine.up('x', { pull: false })).rejects.toBeInstanceOf(SpawnFailure);
  });

  it('degrades a best-effort sampler to "no sample" instead', async () => {
    // `compose_exec_capture` returns (1, "") so a sampler thread is not stranded by a
    // wedged daemon. Turning that into a raise, or the raise above into a (1, ""),
    // would each hide a different thing.
    composeMock.mockRejectedValue(new SpawnFailure(['docker'], new Error('no docker')));
    expect(await engine.composeExecCapture('x', 'mongodb', ['mongosh'])).toEqual([1, '']);
  });

  it('reports an exec failure with its output when the command itself fails', async () => {
    composeMock.mockResolvedValue(answer({ exitCode: 3, stdout: 'partial' }));
    expect(await engine.composeExecCapture('x', 'mongodb', ['mongosh'])).toEqual([3, 'partial']);
  });
});

describe('reading a repro back', () => {
  it('returns no container ids rather than an empty string when the query fails', async () => {
    composeMock.mockResolvedValue(answer({ exitCode: 1, stdout: 'ignored' }));
    expect(await engine.serviceContainerIds('x', 'rocketchat')).toEqual([]);
  });

  it('splits ids on whitespace and drops the blanks', async () => {
    composeMock.mockResolvedValue(answer({ stdout: 'abc\ndef\n\n' }));
    expect(await engine.containerIds('x')).toEqual(['abc', 'def']);
    expect(await engine.serviceContainerIds('x', 'rocketchat')).toEqual(['abc', 'def']);
  });

  it('joins both streams for a post-mortem, because the reason may be on either', async () => {
    composeMock.mockResolvedValue(answer({ stdout: 'out', stderr: 'err' }));
    expect(await engine.composeLogsCapture('x')).toBe('outerr');
    expect(await engine.composePullCapture('x')).toBe('outerr');
    expect(composeMock.mock.calls[0]?.[0]).toEqual(['logs', '--no-color', '--tail', '200']);
  });

  it('stops only the services it was given, leaving Mongo up for a dump', async () => {
    await engine.stopServices('x', ['rocketchat-1', 'rocketchat-2']);
    expect(composeMock.mock.calls[0]?.[0]).toEqual(['stop', 'rocketchat-1', 'rocketchat-2']);
    await engine.rmServices('x', ['prometheus']);
    // Its containers' volumes are read first (`anonymousVolumes`), then it is removed.
    expect(composeMock.mock.calls[1]?.[0]).toEqual(['ps', '--all', '-q', 'prometheus']);
    expect(composeMock.mock.calls[2]?.[0]).toEqual(['rm', '-s', '-f', '-v', 'prometheus']);
  });

  it("takes the containers' anonymous volumes with them, and keeps the named ones unless asked", async () => {
    // An image's own VOLUMEs (MongoDB's /data/configdb, osixia's, Samba's) become anonymous
    // volumes. A container removed without -v leaves them behind, and the next one gets
    // fresh ones, so every `up --force` and plain `down` left a few more (measured: 5 and 6
    // empty volumes after two live runs). `rm -v` removes only anonymous volumes; the data
    // volume is named, so a plain `down` still keeps the data.
    await engine.down('x');
    expect(composeMock.mock.calls.map((call) => call[0])).toEqual([
      ['ps', '--all', '-q'],
      ['rm', '-s', '-f', '-v'],
      ['down', '--remove-orphans'],
    ]);
    composeMock.mockClear();
    await engine.down('x', { volumes: true });
    expect(composeMock.mock.calls.map((call) => call[0])).toEqual([
      ['ps', '--all', '-q'],
      ['down', '--remove-orphans', '-v'],
    ]);
  });

  it('removes an anonymous volume a recreated container mounted by name, never a named one', async () => {
    // After a recreate (`env --set`, an upgrade, `up --force`) compose mounts the old
    // container's anonymous volume into the new one BY NAME, and `rm -v` keeps any volume
    // mounted by name: Rocket.Chat's /app/uploads volume outlived `up --force`, a plain
    // `down` and even `down --volumes`.
    const hex = 'a'.repeat(64);
    composeMock.mockImplementation(async (argv) =>
      answer({ stdout: argv[0] === 'ps' ? 'c1\nc2\n' : '' }),
    );
    dockerMock.mockImplementation(async (argv) =>
      answer({ stdout: argv[0] === 'inspect' ? `houston-x_mongodb_data ${hex} \n${hex} \n` : '' }),
    );
    for (const volumes of [false, true]) {
      dockerMock.mockClear();
      await engine.down('x', { volumes });
      expect(dockerMock.mock.calls.map((call) => call[0])).toEqual([
        ['inspect', '--format', '{{range .Mounts}}{{.Name}} {{end}}', 'c1', 'c2'],
        ['volume', 'rm', hex],
      ]);
    }
  });
});
