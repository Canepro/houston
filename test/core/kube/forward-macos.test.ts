/**
 * The port-forward's ownership questions on a Mac, where there is no /proc.
 *
 * Every answer `forward.ts` gave came from /proc, so on the owner's Mac a live kind forward
 * read as dead: "the port-forward did not stay up", pid 0 recorded, and a new kubectl per
 * check that died with "address already in use" while the first kept the port. Here /proc
 * is absent, the platform is darwin, and `lsof` and `ps` say what a Mac would.
 */
import type * as FsNS from 'node:fs';

import type * as ForwardNS from '../../../src/core/kube/forward';
import type * as ReadyNS from '../../../src/core/lifecycle/ready';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as ExecNS from '../../../src/seams/exec';

jest.mock('node:fs', () => {
  const real = jest.requireActual<typeof FsNS>('node:fs');
  const absent = (file: unknown): void => {
    if (String(file).startsWith('/proc/')) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, '${String(file)}'`), {
        code: 'ENOENT',
      });
    }
  };
  return {
    ...real,
    readFileSync: (file: never, ...rest: never[]) => {
      absent(file);
      return real.readFileSync(file, ...rest);
    },
    readdirSync: (file: never, ...rest: never[]) => {
      absent(file);
      return real.readdirSync(file, ...rest);
    },
    readlinkSync: (file: never, ...rest: never[]) => {
      absent(file);
      return real.readlinkSync(file, ...rest);
    },
  };
});

const PID = process.pid;
const FORWARD = `kubectl --context kind-houston-local -n houston-k port-forward deployment/rocketchat-rocketchat 3000:3000`;

/** What `ps` and `lsof` print on this Mac, keyed by the argv they were asked with. */
let world: { ps: Record<string, string>; lsof: Record<string, string> };
const asked: string[] = [];

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

beforeEach(() => {
  world = { ps: {}, lsof: {} };
  asked.length = 0;
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  const exec = require('../../../src/seams/exec') as typeof ExecNS;
  jest.spyOn(exec, 'capture').mockImplementation(async (argv) => {
    asked.push(argv.join(' '));
    const [tool, ...args] = argv;
    const key = args[args.length - 1] ?? '';
    const stdout =
      tool === 'ps'
        ? (world.ps[key] ?? '')
        : tool === 'lsof'
          ? (world.lsof[(args[1] ?? '').replace('-iTCP:', '')] ?? '')
          : '';
    return { argv, exitCode: stdout === '' ? 1 : 0, signal: null, stdout, stderr: '' };
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  jest.restoreAllMocks();
});

function forward(): typeof ForwardNS {
  return require('../../../src/core/kube/forward') as typeof ForwardNS;
}

describe('a port-forward on a Mac', () => {
  it('is ours while ps names it and lsof says it alone holds the port', async () => {
    const { forwardAlive, forwardBound, pidOwnsPort, pidOwnsPortExclusively } = forward();
    world.ps[String(PID)] = `${FORWARD}\n`;
    world.lsof['3000'] = `p${String(PID)}\n`;

    expect(await forwardAlive(PID, { namespace: 'houston-k', hostPort: 3000 })).toBe(true);
    expect(await pidOwnsPort(PID, 3000)).toBe(true);
    expect(await pidOwnsPortExclusively(PID, 3000)).toBe(true);
    // The check `portForward` makes before recording the pid: without it, pid 0.
    expect(await forwardBound(PID, 3000, { tries: 1, interval: 0 })).toBe(true);
    expect(asked).toContain(`ps -o args= -p ${String(PID)}`);
    expect(asked).toContain('lsof -nP -iTCP:3000 -sTCP:LISTEN -Fp');
  });

  it('is not ours when it is another workspace’s, another port’s, or gone', async () => {
    const { forwardAlive, pidOwnsPort, pidOwnsPortExclusively } = forward();
    world.ps[String(PID)] = `${FORWARD}\n`;
    expect(await forwardAlive(PID, { namespace: 'houston-other', hostPort: 3000 })).toBe(false);
    // Whole tokens: 3000 is not 13000.
    expect(await forwardAlive(PID, { namespace: 'houston-k', hostPort: 13000 })).toBe(false);
    world.ps[String(PID)] = 'node server.js 3000:3000\n';
    expect(await forwardAlive(PID, { namespace: 'houston-k', hostPort: 3000 })).toBe(false);
    // `ps` prints nothing for a pid that is not running.
    expect(await forwardAlive(424242, { namespace: 'houston-k', hostPort: 3000 })).toBe(false);

    // A second process on the port -- kubectl got [::1] only -- is not exclusive.
    world.lsof['3000'] = `p${String(PID)}\np4242\n`;
    expect(await pidOwnsPort(PID, 3000)).toBe(true);
    expect(await pidOwnsPortExclusively(PID, 3000)).toBe(false);
    world.lsof['3000'] = '';
    expect(await pidOwnsPort(PID, 3000)).toBe(false);
    expect(await pidOwnsPortExclusively(PID, 3000)).toBe(false);
  });

  it('lets a Ctrl-C through rather than reading it as a forward that is gone', async () => {
    // Swallowed, `backup` lost the interrupt mid-quiesce: the forward was not stopped, its
    // pid was dropped anyway, and Rocket.Chat stayed scaled to zero.
    const { forwardAlive } = forward();
    const exec = require('../../../src/seams/exec') as typeof ExecNS;
    jest.spyOn(exec, 'capture').mockRejectedValue(new exec.Interrupted());
    await expect(forwardAlive(PID, { namespace: 'houston-k', hostPort: 3000 })).rejects.toThrow(
      exec.Interrupted,
    );
    // Only the interrupt: a tool that cannot run still answers "not ours".
    jest.spyOn(exec, 'capture').mockRejectedValue(new Error('spawn ps ENOENT'));
    expect(await forwardAlive(PID, { namespace: 'houston-k', hostPort: 3000 })).toBe(false);
  });

  it('names the Mac command for what holds a port, which has no `ss`', () => {
    // "`ss -ltnp | grep 3000` says what" sent a Mac user to a command macOS does not have.
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = record.metadata({ name: 'k', hostPort: 3000, rootUrl: 'http://localhost:3000' });
    expect(() => ready.refuseAForeignHolder(meta, 99)).toThrow(
      '`lsof -nP -iTCP:3000 -sTCP:LISTEN` says what',
    );
    expect(forward().holderCommand(3000)).toBe('lsof -nP -iTCP:3000 -sTCP:LISTEN');
  });

  it('knows a kubectl whose argv is one word by its name and its socket', async () => {
    const { forwardAlive } = forward();
    world.ps[String(PID)] = '/usr/local/bin/kubectl\n';
    world.lsof['3000'] = `p${String(PID)}\n`;
    expect(await forwardAlive(PID, { namespace: 'houston-k', hostPort: 3000 })).toBe(true);
    world.lsof['3000'] = '';
    expect(await forwardAlive(PID, { namespace: 'houston-k', hostPort: 3000 })).toBe(false);
  });
});
