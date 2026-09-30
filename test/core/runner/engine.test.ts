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
}));

const composeMock = seam.compose as jest.MockedFunction<typeof seam.compose>;
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

  it('recreates ONE service without taking its database down', async () => {
    await engine.up('TICKET-1', { pull: false, forceRecreate: 'rocketchat' });
    expect(composeMock.mock.calls[0]?.[0]).toEqual([
      'up',
      '-d',
      '--remove-orphans',
      '--force-recreate',
      '--no-deps',
      'rocketchat',
    ]);
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
    expect(composeMock.mock.calls[1]?.[0]).toEqual(['rm', '-s', '-f', 'prometheus']);
  });
});
