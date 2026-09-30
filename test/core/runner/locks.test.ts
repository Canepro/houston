import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { ConflictError } from '../../../src/lib/errors';

import {
  DEFAULT_TIMEOUT_MS,
  heldBy,
  lockPath,
  reproLock,
  updateConfig,
} from '../../../src/core/runner/locks';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CHILD = path.join(ROOT, 'tools', 'locksite-child.js');
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

function holder(target: string): Promise<void> {
  const child = spawn(process.execPath, [CHILD, 'hold', target], { stdio: 'pipe' });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (chunk.includes('OK held')) resolve();
    });
    child.once('close', () => reject(new Error('the holder exited without taking the lock')));
  });
}

describe('the workspace lock', () => {
  it('lives beside the other lock files, under HOUSTON_HOME', () => {
    expect(lockPath('TICKET-1')).toBe(path.join(config.home(), 'locks', 'TICKET-1.lock'));
    expect(DEFAULT_TIMEOUT_MS).toBe(900_000);
  });

  it('is reentrant, because restore --new takes it and then calls create', async () => {
    const order: string[] = [];
    const result = await reproLock('reentrant', async () => {
      expect(heldBy('reentrant')).toBe(true);
      order.push('outer');
      return await reproLock(
        'reentrant',
        () => {
          order.push('inner');
          return 'created';
        },
        // A short timeout: if the nested take went for the file lock again it would
        // self-block on a second descriptor and spend exactly this long finding out.
        { timeoutMs: 300 },
      );
    });
    expect(result).toBe('created');
    expect(order).toEqual(['outer', 'inner']);
    expect(heldBy('reentrant')).toBe(false);
  }, 30_000);

  it('serialises two operations on one workspace', async () => {
    // WHICH ONE GOES FIRST IS NOT THE CLAIM, and asserting it made this flake: acquisition
    // spawns `flock`, so under load the second caller's child can win the race and produce a
    // perfectly serialised run in the other order. What must hold is that the two bodies
    // never OVERLAP -- one leaves before the other enters.
    const events: string[] = [];
    const body = (tag: string) => async () => {
      events.push(`in-${tag}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push(`out-${tag}`);
    };
    await Promise.all([reproLock('serial', body('a')), reproLock('serial', body('b'))]);
    expect(events).toHaveLength(4);
    // Every `in` is immediately followed by its own `out`: an interleave reads as
    // `in-a, in-b, ...` and fails here.
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index + 1]).toBe(String(events[index]).replace('in-', 'out-'));
    }
  }, 30_000);

  it('turns another process holding it into the documented ConflictError', async () => {
    const target = lockPath('contended');
    await reproLock('contended', () => undefined); // creates the locks directory
    await holder(target);

    let refusal: unknown;
    try {
      await reproLock('contended', () => 'never runs', { timeoutMs: 400 });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as ConflictError).message).toBe(
      "another houston process is still working on 'contended' (waited 0s). " +
        'Check `houston list` and the Activity list, then retry.',
    );
  }, 30_000);

  it('releases on the way out of a failing operation', async () => {
    await expect(
      reproLock('failing', () => {
        throw new ConflictError('the operation itself failed');
      }),
    ).rejects.toThrow('the operation itself failed');
    expect(await reproLock('failing', () => 'free again')).toBe('free again');
  }, 30_000);
});

describe('two different workspaces', () => {
  it('does not make one workspace wait for another', async () => {
    // The lock is per NAME. A lock that covered the whole home would serialise every job
    // `serve` runs, so one slow create would park every other workspace's button.
    const events: string[] = [];
    let releaseA: () => void = () => undefined;
    const aHeld = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      aEntered = resolve;
    });
    const a = reproLock('a', async () => {
      events.push('in-a');
      aEntered();
      await aHeld;
      events.push('out-a');
    });
    await entered;
    // `b` runs to completion while `a` is still inside its body.
    await reproLock('b', () => events.push('b'), { timeoutMs: 300 });
    releaseA();
    await a;
    expect(events).toEqual(['in-a', 'b', 'out-a']);
  }, 30_000);
});

describe('config.yaml, updated by two processes at once', () => {
  // Each process holds the read-modify-write open for half a second, so without a
  // cross-process lock both read the same file and the later rename throws the other's key
  // away.
  const TS_WRITER = [
    "require('./tools/ts-require').install();",
    "const locks = require('./src/core/runner/locks');",
    'const key = process.argv[1];',
    'locks.updateConfig((cfg) => {',
    '  process.stdout.write("inside\\n");',
    '  const until = Date.now() + 500;',
    '  while (Date.now() < until) {}',
    '  cfg[key] = 1;',
    '}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });',
  ].join('\n');
  // What an earlier release does to config.yaml, in the same order: take flock(2) on
  // `.config.lock` -- a flock(1) child takes the same lock -- then read the file, set one
  // key and rename a new file over it, all while the lock is held.
  const EARLIER_WRITER = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const YAML = require('yaml');",
    'const [key, home] = process.argv.slice(1);',
    "const file = path.join(home, 'config.yaml');",
    "const cfg = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) : {};",
    'process.stdout.write("inside\\n");',
    'const until = Date.now() + 500;',
    'while (Date.now() < until) {}',
    'cfg[key] = 1;',
    'fs.writeFileSync(`${file}.tmp`, YAML.stringify(cfg));',
    'fs.renameSync(`${file}.tmp`, file);',
  ].join('\n');

  function writer(argv: string[]): { entered: Promise<void>; done: Promise<number> } {
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: ROOT,
      env: { ...process.env },
      stdio: 'pipe',
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const entered = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('inside')) resolve();
      });
    });
    const done = new Promise<number>((resolve, reject) => {
      child.once('close', (code) => {
        if (code === 0) resolve(0);
        else reject(new Error(`a writer exited ${String(code)}: ${stderr}`));
      });
    });
    return { entered, done };
  }

  const ts = (key: string) => [process.execPath, '-e', TS_WRITER, key];
  const earlier = (key: string) => [
    'flock',
    '-x',
    path.join(config.home(), '.config.lock'),
    process.execPath,
    '-e',
    EARLIER_WRITER,
    key,
    config.home(),
  ];

  it.each([
    ['two processes of this build', ts('key_from_a'), ts('key_from_b')],
    ['an earlier release and then this build', earlier('key_from_a'), ts('key_from_b')],
    ['this build and then an earlier release', ts('key_from_a'), earlier('key_from_b')],
  ])(
    'keeps both keys: %s',
    async (_label, first, second) => {
      const a = writer(first);
      // The second starts only once the first is inside its critical section, so the two
      // windows overlap by construction rather than by luck.
      await a.entered;
      const b = writer(second);
      await Promise.all([a.done, b.done]);
      const stored = config.loadConfig(false);
      expect({ a: stored.key_from_a, b: stored.key_from_b }).toEqual({ a: 1, b: 1 });
    },
    60_000,
  );

  it('creates .config.lock 0600, as earlier releases do', async () => {
    // flock(1) created it at 0666 & ~umask -- 0664 on a stock box -- where earlier releases
    // create it write-only at 0600.
    const recordedMode = 0o600;
    const lock = path.join(config.home(), '.config.lock');
    fs.rmSync(lock, { force: true });
    await updateConfig((cfg) => {
      cfg.mode_probe = 1;
    });
    expect(fs.statSync(lock).mode & 0o777).toBe(recordedMode);
  }, 30_000);

  it('is the only way production code writes config.yaml', () => {
    // A writer that calls the unlocked `config.updateConfig` directly is the lost update
    // again, one call site at a time.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name)) {
          const source = fs.readFileSync(full, 'utf8');
          if (/\bconfig\.updateConfig\(/u.test(source)) offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual(['src/core/runner/locks.ts']);
  });
});

/*
 * A lock file that cannot be opened for WRITING. `flock(1)` opens the path read-only, so it
 * took a read-only lock file and a directory and ran the body -- writing the workspace,
 * running compose -- and reported a lock it could not open at all as "another houston
 * process is still working ... (waited 900s)", exit 8, at once. Earlier releases raise the
 * open's error, unhandled, before anything is written. Each shape carries the answer earlier
 * releases' own lock site gave on the same home, recorded with that home as `<home>`.
 */
describe('a lock that cannot be opened for writing', () => {
  type Site = 'repro' | 'config';
  const SHAPES: readonly [Site, string, (home: string) => void, string][] = [
    [
      'repro',
      'a directory',
      (home) => fs.mkdirSync(path.join(home, 'locks', 'alpha.lock')),
      'FileError: <home>/locks/alpha.lock: Is a directory',
    ],
    [
      'repro',
      'read-only',
      (home) => readOnly(path.join(home, 'locks', 'alpha.lock')),
      'FileError: <home>/locks/alpha.lock: Permission denied',
    ],
    [
      'repro',
      'a dangling link',
      (home) => dangling(path.join(home, 'locks', 'alpha.lock')),
      'FileError: <home>/locks/alpha.lock: No such file or directory',
    ],
    [
      'repro',
      'in a locks directory it may not write',
      (home) => fs.chmodSync(locks(home), 0o500),
      'FileError: <home>/locks/alpha.lock: Permission denied',
    ],
    [
      'repro',
      'in a home it may not write, with no locks directory',
      (home) => {
        fs.rmdirSync(locks(home));
        fs.chmodSync(home, 0o555);
      },
      'FileError: <home>/locks: Permission denied',
    ],
    [
      'config',
      'a directory',
      (home) => fs.mkdirSync(path.join(home, '.config.lock')),
      'FileError: <home>/.config.lock: Is a directory',
    ],
    [
      'config',
      'read-only',
      (home) => readOnly(path.join(home, '.config.lock')),
      'FileError: <home>/.config.lock: Permission denied',
    ],
    [
      'config',
      'a dangling link',
      (home) => dangling(path.join(home, '.config.lock')),
      'FileError: <home>/.config.lock: No such file or directory',
    ],
    [
      'config',
      'in a home it may not write',
      (home) => fs.chmodSync(home, 0o555),
      'FileError: <home>/.config.lock: Permission denied',
    ],
  ];

  function locks(home: string): string {
    return path.join(home, 'locks');
  }
  function readOnly(target: string): void {
    fs.writeFileSync(target, '');
    fs.chmodSync(target, 0o444);
  }
  function dangling(target: string): void {
    fs.symlinkSync(path.join(path.dirname(target), 'gone', 'x.lock'), target);
  }

  let home = '';
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(config.home(), 'shape-'));
    fs.mkdirSync(locks(home));
    process.env.HOUSTON_HOME = home;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.HOUSTON_HOME;
    else process.env.HOUSTON_HOME = before;
    fs.chmodSync(home, 0o700);
    if (fs.existsSync(locks(home))) fs.chmodSync(locks(home), 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function ours(site: Site): Promise<string> {
    const ran: string[] = [];
    try {
      if (site === 'repro') {
        await reproLock('alpha', () => ran.push('ran'), { timeoutMs: 1_000 });
      } else {
        await updateConfig(() => ran.push('ran'));
      }
    } catch (error) {
      expect(error).not.toBeInstanceOf(ConflictError);
      ran.push(`${(error as Error).name}: ${(error as Error).message}`);
    }
    return ran.join('\n');
  }

  it.each(SHAPES)(
    '%s lock %s raises what earlier releases raise',
    async (site, _label, shape, recorded) => {
      shape(home);
      expect(await ours(site)).toBe(recorded.replaceAll('<home>', home));
    },
    30_000,
  );
});
