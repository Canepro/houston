import type * as AppNS from '../../src/cli/app';
import type * as HandlersNS from '../../src/cli/handlers';
import type * as RecordNS from '../../src/core/runner/record';
import { parseJsonTranscript } from '../../src/cli/wire';

async function command(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const app = require('../../src/cli/app') as typeof AppNS;
  const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
  let stdout = '';
  let stderr = '';
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  try {
    const code = await app.runCli(argv, {
      execute: handlers.createExecutor({
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      }),
      io: {
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      },
    });
    return { code, stdout, stderr };
  } finally {
    write.mockRestore();
  }
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.resetModules();
});

describe("earlier releases' exit codes and stable errors, through actual argv", () => {
  test('an unusable cluster is a PREFLIGHT_FAILED JSON envelope at exit 3', async () => {
    jest.doMock('../../src/core/cluster', () => ({
      status: jest.fn(async () => ({
        context: '',
        reachable: false,
        unreadable: ['nodes'],
      })),
    }));
    const result = await command(['cluster', 'status', '--json']);
    expect(result.code).toBe(3);
    // `warnings: []`, as in earlier releases: they collect the unreadable-nodes warning and
    // then fail with a PreflightError whose envelope carries no warnings. This expected the
    // warning in the envelope: a CLUSTER_UNREADABLE_* warning earlier releases do not add.
    expect(parseJsonTranscript(result.stdout, false).envelope).toMatchObject({
      ok: false,
      error: { code: 'PREFLIGHT_FAILED' },
      warnings: [],
    });
  });

  test('a cluster AWS says is gone is one message, not empty-and-not-empty', async () => {
    jest.doMock('../../src/core/cluster', () => ({
      status: jest.fn(async () => ({
        context: 'arn:aws:eks:eu-west-1:111122223333:cluster/old',
        reachable: false,
        gone: true,
        unreadable: [],
        reach_status: 'down',
        reach_why: 'nothing answered',
        reach_advice:
          'AWS says this cluster no longer exists, so it is not costing anything. ' +
          'The kubeconfig entry naming it is left over -- `houston cluster forget old` removes it.',
      })),
    }));
    const result = await command(['cluster', 'status']);
    expect(result.code).toBe(3);
    // stderr said "NOT a report that the cluster is empty" while stdout said it no longer
    // exists and costs nothing: two verdicts on one cluster. Gone is one verdict.
    expect(result.stderr).not.toContain('NOT a report that the cluster is empty');
    expect(result.stderr).toContain('no longer exists in AWS');
    expect(result.stderr).toContain('houston cluster forget old');
  });

  test('a refused destructive down is exit 5 in human mode', async () => {
    // A workspace that EXISTS: `down` resolves the name first, as earlier releases do, so a
    // name with no record is exit 4 before the teardown is ever reached.
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord(
      'sample',
      record.metadata({ name: 'sample', project: 'houston-sample' }),
    );
    jest.doMock('../../src/core/lifecycle/destroy', () => ({
      teardown: jest.fn(async () => ({ name: 'sample', removed: false })),
    }));
    const result = await command(['down', '--name', 'sample', '--volumes', '--yes']);
    expect(result.code).toBe(5);
  });

  test('a blocked upgrade plan is exit 1 even for dry-run', async () => {
    jest.doMock('../../src/core/upgrade', () => ({
      plan: jest.fn(async () => ({
        name: 'sample',
        allowed: false,
        blocked_reason: 'downgrades are refused',
        warnings: [],
      })),
    }));
    const result = await command(['upgrade', '--name', 'sample', '--to', '1.0.0', '--dry-run']);
    expect(result.code).toBe(1);
  });

  test('a requested seed verification mismatch is CREATE_FAILED at exit 7', async () => {
    jest.doMock('../../src/core/lifecycle/naming', () => ({
      resolveName: jest.fn(async (name: string) => name),
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      readMeta: jest.fn(async () => ({ name: 'sample', rootUrl: 'http://127.0.0.1:3000' })),
      adminPass: jest.fn(() => 'admin123'),
    }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: jest.fn(async () => ({ token: 'token', userId: 'admin' })),
    }));
    jest.doMock('../../src/core/runner/locks', () => ({
      reproLock: jest.fn(async (_name: string, fn: () => Promise<unknown>) => await fn()),
    }));
    jest.doMock('../../src/seed/plan', () => ({ planFrom: jest.fn(() => ({})) }));
    jest.doMock('../../src/seed/apply', () => ({ seed: jest.fn(async () => ({ users: 1 })) }));
    jest.doMock('../../src/core/lifecycle/seeding', () => ({
      seedPrepared: jest.fn(async () => ({
        users: 1,
        verification: { ok: false, faults: ['missing alice'] },
      })),
    }));
    const result = await command(['seed', '--name', 'sample', '--verify-seed']);
    expect(result.code).toBe(7);
    expect(result.stderr).toContain('seed verification failed: 1 mismatch(es)');
  });

  test('an unproven seed prints the unreadable rooms and their actual API reasons', async () => {
    jest.doMock('../../src/core/lifecycle/naming', () => ({
      resolveName: jest.fn(async (name: string) => name),
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      readMeta: jest.fn(async () => ({ name: 'sample', rootUrl: 'http://127.0.0.1:3000' })),
      adminPass: jest.fn(() => 'admin123'),
    }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: jest.fn(async () => ({ token: 'token', userId: 'admin' })),
    }));
    jest.doMock('../../src/core/runner/locks', () => ({
      reproLock: jest.fn(async (_name: string, fn: () => Promise<unknown>) => await fn()),
    }));
    jest.doMock('../../src/seed/plan', () => ({ planFrom: jest.fn(() => ({})) }));
    jest.doMock('../../src/core/lifecycle/seeding', () => ({
      seedPrepared: jest.fn(async () => ({
        users: 1,
        verification: {
          ok: null,
          faults: [],
          unreadable: [
            {
              what: 'dm-alice-bob',
              why: 'seed request /api/v1/chat.getMessage was refused (HTTP 429, error-too-many-requests)',
            },
            { what: 'private-room', why: 'seed readback ended before its total' },
          ],
        },
      })),
    }));
    const result = await command(['seed', '--name', 'sample', '--verify-seed']);
    expect(result.code).toBe(7);
    expect(result.stdout).toContain('dm-alice-bob: seed request /api/v1/chat.getMessage');
    expect(result.stdout).toContain('HTTP 429, error-too-many-requests');
    expect(result.stdout).toContain('private-room: seed readback ended before its total');
    expect(result.stdout).not.toContain('no reason recorded');
    expect(result.stderr).toContain('seed verification could not run');
  });

  // `api ... --data '{'` is not here any more. With no workspace named it is earlier
  // releases' exit 2 ("no name given"), because `api` reads the body only after the name,
  // the engine and the login; this row held this build's earlier order, which refused the
  // body first.
  // These three exited 1, earlier releases' generic code, and were pinned at it. Moved on
  // purpose (L7-07): 1.x parity no longer binds the exit codes, and the contract
  // (automation.md) says 2 for a call that is wrong and 4 for a named thing that is not
  // there -- what `up --set users=abc` and `restore <missing bundle>` already answered.
  test.each([
    [['config', 'get', 'not.a.key'], 2, 'unknown key'],
    [['upgrade'], 2, 'no target version given'],
    [['config-import', '/definitely/missing/settings.json'], 4, 'no such file'],
  ])('%j exits %i', async (argv, code, message) => {
    const result = await command(argv);
    expect(result.code).toBe(code);
    expect(result.stderr).toContain(message);
  });
});
