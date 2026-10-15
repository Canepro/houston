import type * as NamingNS from '../../src/core/lifecycle/naming';

jest.mock('../../src/core/capture', () => ({ listWorkloads: jest.fn(), captureBundle: jest.fn() }));
jest.mock('../../src/core/lifecycle/naming', () => {
  const actual = jest.requireActual<typeof NamingNS>('../../src/core/lifecycle/naming');
  return { ...actual, resolveName: jest.fn() };
});

import * as capture from '../../src/core/capture';
import * as naming from '../../src/core/lifecycle/naming';
import { runCli } from '../../src/cli/app';
import { createExecutor } from '../../src/cli/handlers';
import { CaptureFailedError } from '../../src/lib/errors';

const mockListWorkloads = jest.mocked(capture.listWorkloads);
const mockCaptureBundle = jest.mocked(capture.captureBundle);
const mockResolveName = jest.mocked(naming.resolveName);

async function invoke(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io = {
    writeOut: (text: string) => {
      out += text;
    },
    writeErr: (text: string) => {
      err += text;
    },
  };
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    const code = await runCli(argv, { execute: createExecutor(io), io });
    return { code, out, err };
  } finally {
    stdout.mockRestore();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveName.mockResolvedValue('ticket-1234');
  mockListWorkloads.mockResolvedValue([
    { name: 'smoke', description: 'sign in and record the landing page', source: 'built-in' },
  ]);
  mockCaptureBundle.mockResolvedValue({
    bundle: { path: '/tmp/ticket-capture', files: ['README.md', 'capture/manifest.json'] },
    capture: { workload: 'smoke' },
  });
});

describe('capture commands', () => {
  test('lists each available workload through the real parser and human renderer', async () => {
    const result = await invoke(['workloads']);

    expect(result).toEqual({
      code: 0,
      err: '',
      out: expect.stringContaining('WORKLOAD'),
    });
    expect(result.out).toContain('smoke');
    expect(result.out).toContain('sign in and record the landing page');
    expect(mockListWorkloads).toHaveBeenCalledTimes(1);
  });

  test('passes capture options through the real parser and emits the documented JSON envelope', async () => {
    const result = await invoke([
      'capture',
      '--name',
      'ticket-1234',
      '--workload',
      'smoke',
      '--bundle',
      '/tmp/ticket-capture',
      '--force',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(mockCaptureBundle).toHaveBeenCalledWith('ticket-1234', 'smoke', '/tmp/ticket-capture', {
      force: true,
    });
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      schema: 'houston.capture.v1',
      data: { bundle: { path: '/tmp/ticket-capture' } },
    });
  });

  test('reports a retained failed capture through the CLI error envelope', async () => {
    mockCaptureBundle.mockRejectedValue(
      new CaptureFailedError('capture stopped', { details: { bundle: '/tmp/ticket-capture' } }),
    );

    const result = await invoke(['capture', '--name', 'ticket-1234', '--json']);

    expect(result.code).toBe(9);
    expect(JSON.parse(result.out)).toMatchObject({
      schema: 'houston.error.v1',
      ok: false,
      error: { code: 'CAPTURE_FAILED', details: { bundle: '/tmp/ticket-capture' } },
    });
  });

  test('gives a person the bundle path to open after a capture', async () => {
    const result = await invoke(['capture', '--name', 'ticket-1234']);

    expect(result).toEqual({
      code: 0,
      err: '',
      out: 'bundle  /tmp/ticket-capture\n  open  /tmp/ticket-capture/README.md\n',
    });
  });
});
