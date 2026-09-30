import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ConflictError } from '../../../src/lib/errors';

import {
  DUAL_IMPLEMENTATION,
  LOCK_PLATFORM_MATRIX,
  LockUnavailable,
  OPEN_FOR_WRITE,
  THIS_IMPLEMENTATION,
  acquireFileLock,
  conflictFrom,
  flockTool,
  holdsFileLock,
  lockStatus,
  markerPath,
  platformKey,
  readImplementation,
  requireThisImplementation,
  resetLockProbe,
  withFileLock,
} from '../../../src/seams/fs/lock';

const ROOT = path.resolve(__dirname, '..', '..', '..');
/** The marker earlier releases write into a home they own: state on disk, kept as they wrote it. */
const EARLIER_MARKER = 'python';
const CHILD = path.join(ROOT, 'tools', 'locksite-child.js');

let scratch = '';
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-lock-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  resetLockProbe();
  fs.rmSync(scratch, { recursive: true, force: true });
});

interface Site {
  readonly child: ChildProcessWithoutNullStreams;
  /** Every `OK <id>` this child has printed, i.e. every write it says is durable. */
  readonly committed: string[];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor(count: number, timeoutMs?: number): Promise<void>;
}

function site(...argv: string[]): Site {
  const child = spawn(process.execPath, [CHILD, ...argv], { stdio: 'pipe' });
  children.push(child);
  const committed: string[] = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.startsWith('OK ')) committed.push(line.slice(3));
      newline = buffered.indexOf('\n');
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  return {
    child,
    committed,
    exited,
    async waitFor(count: number, timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (committed.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `lock site ${argv[0] ?? ''} committed ${String(committed.length)} of ` +
              `${String(count)} before the deadline. stderr: ${stderr}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

function lines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('the IMPLEMENTATION marker', () => {
  it('refuses a home an earlier release owns and names the way out', () => {
    fs.writeFileSync(markerPath(scratch), `${EARLIER_MARKER}\n`, 'utf8');

    let refusal: unknown;
    try {
      requireThisImplementation(scratch);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(Error);
    const message = (refusal as Error).message;
    expect(message).toContain(`'${EARLIER_MARKER}'`);
    expect(message).toContain(THIS_IMPLEMENTATION);
    expect(message).toContain('HOUSTON_HOME');
    // Refusing must not rewrite the evidence it refused on.
    expect(fs.readFileSync(markerPath(scratch), 'utf8')).toBe(`${EARLIER_MARKER}\n`);
  });

  it('accepts a dual-v1 home without rewriting its marker, and never writes one', () => {
    fs.writeFileSync(markerPath(scratch), `${DUAL_IMPLEMENTATION}\n`, 'utf8');
    requireThisImplementation(scratch);
    expect(fs.readFileSync(markerPath(scratch), 'utf8')).toBe(`${DUAL_IMPLEMENTATION}\n`);

    // An unclaimed EMPTY home is claimed for both: there is no format in it to disagree
    // about. One with anything in it and no marker is still this build's alone;
    // promotion, not a claim, is what makes such a home dual-v1.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-lock-fresh-'));
    try {
      requireThisImplementation(fresh);
      expect(readImplementation(fresh)).toBe(DUAL_IMPLEMENTATION);
      const used = path.join(fresh, 'used');
      fs.mkdirSync(used);
      fs.writeFileSync(path.join(used, 'config.yaml'), 'bind_host: 127.0.0.1\n');
      requireThisImplementation(used);
      expect(readImplementation(used)).toBe(THIS_IMPLEMENTATION);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('the platform matrix', () => {
  it('names a tier, a cross-implementation answer and a support level per platform', () => {
    expect(LOCK_PLATFORM_MATRIX.map((row) => row.platform)).toEqual([
      'linux-glibc',
      'linux-musl',
      'darwin-arm64',
      'darwin-x64',
      'win32',
    ]);
    for (const row of LOCK_PLATFORM_MATRIX) {
      expect(['flock-cli', 'none']).toContain(row.tier);
      expect(['excluded', 'marker-only']).toContain(row.crossImplementation);
      expect(['supported', 'degraded']).toContain(row.support);
      expect(row.note.length).toBeGreaterThan(20);
      // A tier of `none` cannot honestly claim to exclude the other implementation.
      if (row.tier === 'none') expect(row.crossImplementation).toBe('marker-only');
    }
    // Exactly one row is claimed as measured, and it is the platform measured here.
    expect(LOCK_PLATFORM_MATRIX.filter((row) => row.measured).map((row) => row.platform)).toEqual([
      'linux-glibc',
    ]);
  });

  it('reports this machine as excluding the other implementation', async () => {
    const status = await lockStatus();
    expect(status.platform).toBe(platformKey());
    expect(status.tier).toBe('flock-cli');
    expect(status.crossImplementation).toBe('excluded');
    expect(status.support).toBe('supported');
    expect(status.matrix).toBe(LOCK_PLATFORM_MATRIX);
  });

  it('degrades to marker-only when no flock(1) can be found', async () => {
    const realPath = process.env.PATH;
    process.env.PATH = path.join(scratch, 'empty');
    resetLockProbe();
    try {
      expect((await flockTool()).tier).toBe('none');
      const status = await lockStatus();
      expect(status.tier).toBe('none');
      expect(status.crossImplementation).toBe('marker-only');
      expect(status.support).toBe('degraded');

      // Degraded still serialises THIS process rather than failing closed.
      const order: string[] = [];
      const target = path.join(scratch, 'degraded.lock');
      await Promise.all([
        withFileLock(target, async () => {
          order.push('a-in');
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push('a-out');
        }),
        withFileLock(target, () => {
          order.push('b');
        }),
      ]);
      expect(order).toEqual(['a-in', 'a-out', 'b']);
    } finally {
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
      resetLockProbe();
    }
  });
});

describe('exclusion', () => {
  it('blocks another process while held and lets it in after release', async () => {
    const target = path.join(scratch, 'held.lock');
    const handle = await acquireFileLock(target, { timeoutMs: 10_000 });

    const blocked = site('hold', target);
    // A holder that cannot get the lock never prints its sentinel; it exits when its
    // own 1s timeout expires, which is the observable difference from acquiring.
    const outcome = await Promise.race([
      blocked.exited.then(() => 'exited' as const),
      new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 2_000)),
    ]);
    expect(blocked.committed).toEqual([]);
    expect(outcome).toBe('held');

    await handle.release();
    await blocked.waitFor(1, 10_000);
    expect(blocked.committed).toEqual(['held']);
  }, 30_000);

  it('refuses with the process layer named, and the adapter owns the sentence', async () => {
    const target = path.join(scratch, 'contended.lock');
    const holder = site('hold', target);
    await holder.waitFor(1);

    let refusal: unknown;
    try {
      await acquireFileLock(target, { timeoutMs: 200 });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(LockUnavailable);
    expect((refusal as LockUnavailable).layer).toBe('process');
    expect(refusal).not.toBeInstanceOf(ConflictError);

    const raised = conflictFrom(refusal as LockUnavailable, 'TICKET-1234', 900);
    expect(raised).toBeInstanceOf(ConflictError);
    expect(raised.message).toBe(
      "another houston process is still working on 'TICKET-1234' (waited 900s). " +
        'Check `houston list` and the Activity list, then retry.',
    );
  }, 30_000);

  it('is reentrant within one async execution and not across two', async () => {
    const target = path.join(scratch, 'reentrant.lock');
    expect(holdsFileLock(target)).toBe(false);

    const seen = await withFileLock(target, async () => {
      expect(holdsFileLock(target)).toBe(true);
      // The nested take must not try for the file lock again: flock self-blocks on a
      // second descriptor, so a non-reentrant nesting would wait out its own timeout.
      return await withFileLock(target, () => 'nested', { timeoutMs: 250 });
    });
    expect(seen).toBe('nested');
    expect(holdsFileLock(target)).toBe(false);

    // A sibling execution is a different holder and waits its turn.
    const order: string[] = [];
    await Promise.all([
      withFileLock(target, async () => {
        order.push('first-in');
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push('first-out');
      }),
      withFileLock(target, () => {
        order.push('second');
      }),
    ]);
    expect(order).toEqual(['first-in', 'first-out', 'second']);
  }, 30_000);

  it('releases on the way out of a throwing critical section', async () => {
    const target = path.join(scratch, 'throwing.lock');
    await expect(
      withFileLock(target, () => {
        throw new Error('the critical section failed');
      }),
    ).rejects.toThrow('the critical section failed');

    const after = await acquireFileLock(target, { timeoutMs: 2_000 });
    await after.release();
  }, 30_000);
});

/*
 * `flock(1)` opens the path itself, read-only and at 0666: it made `.config.lock` 0664 where
 * earlier releases open it for writing at 0600, locked a directory or a read-only file
 * earlier releases cannot open for writing, and turned a lock it could not open at all into
 * a refusal. The adapters are held to earlier releases in `core/runner/locks.test.ts`; these
 * hold the seam's half.
 */
describe('a lock file opened as earlier releases open it', () => {
  it('is created at the mode asked for, and truncated only when asked', async () => {
    const created = path.join(scratch, 'config.lock');
    await (await acquireFileLock(created, { open: { truncate: false, mode: 0o600 } })).release();
    expect(fs.statSync(created).mode & 0o777).toBe(0o600);

    // Opened for writing, it takes the umask's mode, exactly as a plain created file does.
    const sibling = path.join(scratch, 'sibling');
    fs.writeFileSync(sibling, '');
    const plain = path.join(scratch, 'plain.lock');
    await (await acquireFileLock(plain, { open: OPEN_FOR_WRITE })).release();
    expect(fs.statSync(plain).mode & 0o777).toBe(fs.statSync(sibling).mode & 0o777);

    fs.writeFileSync(plain, 'stale');
    await (await acquireFileLock(plain, { open: { truncate: false, mode: 0o600 } })).release();
    expect(fs.readFileSync(plain, 'utf8')).toBe('stale');
    await (await acquireFileLock(plain, { open: OPEN_FOR_WRITE })).release();
    expect(fs.readFileSync(plain, 'utf8')).toBe('');
  }, 30_000);

  it("raises the open's own error, not a refusal, and gives back this process's turn", async () => {
    const target = path.join(scratch, 'a-directory.lock');
    fs.mkdirSync(target);
    let raised: unknown;
    try {
      await acquireFileLock(target, { open: OPEN_FOR_WRITE, timeoutMs: 500 });
    } catch (error) {
      raised = error;
    }
    expect(raised).not.toBeInstanceOf(LockUnavailable);
    expect(`${(raised as Error).name}: ${(raised as Error).message}`).toBe(
      `FileError: ${target}: Is a directory`,
    );

    // The in-process turn was given back: a second take would otherwise wait out its own
    // timeout behind a caller that already left.
    fs.rmdirSync(target);
    await (await acquireFileLock(target, { open: OPEN_FOR_WRITE, timeoutMs: 500 })).release();
  }, 30_000);
});

/*
 * THE FIVE SIGKILL TESTS.
 *
 * One per hardened `flock` site. Each kills a holder without warning, which
 * is the only case that distinguishes a lock the kernel owns from bookkeeping this
 * process owns -- SIGKILL runs no handler and unwinds nothing.
 *
 * Every assertion is about what SURVIVED, not about whether anything crashed: each
 * child prints `OK <id>` only after the write it made is durable, so the question a
 * test can ask is whether every acknowledged record is still readable.
 */
describe('a holder killed with SIGKILL', () => {
  it('releases the repro lock it never unwound', async () => {
    const target = path.join(scratch, 'repro.lock');
    const holder = site('hold', target);
    await holder.waitFor(1);

    await expect(acquireFileLock(target, { timeoutMs: 200 })).rejects.toBeInstanceOf(
      LockUnavailable,
    );

    holder.child.kill('SIGKILL');
    expect((await holder.exited).signal).toBe('SIGKILL');

    const reclaimed = await acquireFileLock(target, { timeoutMs: 10_000 });
    expect(reclaimed.tier).toBe('flock-cli');
    await reclaimed.release();
  }, 30_000);

  it('loses no committed config update when one writer dies mid-cycle', async () => {
    const target = path.join(scratch, 'config.lock');
    const file = path.join(scratch, 'config.json');
    const dying = site('config', target, file, '400', 'a', '1', '12');
    const survivor = site('config', target, file, '25', 'b', '1', '12');

    await dying.waitFor(6);
    dying.child.kill('SIGKILL');
    expect((await dying.exited).signal).toBe('SIGKILL');
    expect((await survivor.exited).code).toBe(0);

    const document = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      writers: Record<string, number>;
      total: number;
    };
    expect(document.writers.b).toBe(25);
    expect(document.writers.a).toBeGreaterThanOrEqual(dying.committed.length);
    expect(document.total).toBe((document.writers.a ?? 0) + (document.writers.b ?? 0));
  }, 60_000);

  it('leaves the users file whole, with every acknowledged account present', async () => {
    const target = path.join(scratch, 'users.lock');
    const file = path.join(scratch, 'users');
    const dying = site('users', target, file, '400', 'a', '1', '12');
    const survivor = site('users', target, file, '25', 'b', '1', '12');

    await dying.waitFor(6);
    dying.child.kill('SIGKILL');
    await dying.exited;
    expect((await survivor.exited).code).toBe(0);

    const present = new Set(lines(file).map((row) => row.split(':')[0]));
    for (const id of [...dying.committed, ...survivor.committed])
      expect(present.has(id)).toBe(true);
    // Temp files are in the same directory; none may survive as a readable half.
    expect(fs.readdirSync(scratch).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  }, 60_000);

  it('loses no session across the compaction a killed writer was inside', async () => {
    const target = path.join(scratch, 'sessions.lock');
    const file = path.join(scratch, 'sessions');
    const dying = site('sessions', target, file, '400', 'a', '1', '12');
    const survivor = site('sessions', target, file, '25', 'b', '1', '12');

    await dying.waitFor(6);
    dying.child.kill('SIGKILL');
    await dying.exited;
    expect((await survivor.exited).code).toBe(0);

    const present = new Set(lines(file).map((row) => row.split('\t')[0]));
    for (const id of [...dying.committed, ...survivor.committed])
      expect(present.has(id)).toBe(true);
  }, 60_000);

  it('loses no event-log record across the rotation boundary', async () => {
    // The rotation is the one non-atomic moment, and it is SILENT by contract: a lost
    // record produces no error anywhere, so without this assertion its failure is
    // invisible.
    //
    // The cap and the round counts are chosen so exactly ONE rotation is reached.
    // That is deliberate rather than convenient: a second rotation renames over the
    // first `.1` and carries its records away BY DESIGN -- the log keeps two files --
    // so a test that crossed the boundary twice would report the documented cap as a
    // lost record and hide the defect it is looking for. Two writers contending at one
    // boundary is the whole failure mode: without the lock and its re-check, both see
    // the file over the cap, both rename, and the second rename destroys the first
    // writer's `.1`.
    const target = path.join(scratch, 'eventlog.lock');
    const file = path.join(scratch, 'audit.log');
    const dying = site('eventlog', target, file, '14', 'a', '250', '25', '60');
    const survivor = site('eventlog', target, file, '60', 'b', '250', '5', '60');

    await dying.waitFor(10);
    dying.child.kill('SIGKILL');
    await dying.exited;
    expect((await survivor.exited).code).toBe(0);

    // The boundary must actually have been crossed, or this test proves nothing.
    expect(fs.existsSync(`${file}.1`)).toBe(true);

    const survived = new Set([...lines(file), ...lines(`${file}.1`)]);
    const lost = [...dying.committed, ...survivor.committed].filter((id) => !survived.has(id));
    expect(lost).toEqual([]);
  }, 60_000);
});

/**
 * An owner in a process group of its own, as a command is in its terminal's foreground
 * group: it takes `target` with flock(1)'s `--timeout` set to `seconds` (which names its
 * flock(1) for `flocks`), says `OK held` once it holds it, and answers SIGINT as runMain
 * does, by staying alive. It releases when its stdin ends.
 */
function owner(target: string, seconds: number): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(path.join(ROOT, 'tools', 'ts-require'))}).install();` +
        `const lock = require(${JSON.stringify(path.join(ROOT, 'src', 'seams', 'fs', 'lock.ts'))});` +
        "process.on('SIGINT', () => undefined);" +
        `lock.acquireFileLock(${JSON.stringify(target)}, { timeoutMs: ${String(seconds * 1000)} })` +
        '.then(() => {' +
        "  process.stdout.write('OK held\\n');" +
        "  process.stdin.on('end', () => process.exit(0)).resume();" +
        '});',
    ],
    { detached: true, stdio: 'pipe' },
  );
  children.push(child);
  return child;
}

/** The pids of the flock(1) an `owner(target, seconds)` started, and of its holder. */
function flocks(target: string, seconds: number): number[] {
  const found = (args: string[]): number[] =>
    (spawnSync('pgrep', args, { encoding: 'utf8' }).stdout.match(/\d+/gu) ?? []).map(Number);
  const waiting = found(['-f', '--', `--timeout ${String(seconds)} .*${path.basename(target)}`]);
  return [...waiting, ...waiting.flatMap((pid) => found(['-P', String(pid)]))];
}

function held(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve) =>
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (chunk.includes('OK held')) resolve();
    }),
  );
}

describe("a terminal's signals to the owner's process group", () => {
  it('leave the lock held through a Ctrl-C, while its owner unwinds', async () => {
    // The terminal signals its whole foreground process group. Earlier releases' lock is a
    // descriptor in their own process, held while their Interrupted unwinds. Here flock(1)
    // and the holder were in the owner's group and died of the keypress, so the lock was
    // free under `backup`'s unwind. The test signals the owner's group as a
    // terminal would; the owner answers SIGINT as runMain does.
    const target = path.join(scratch, 'held.lock');
    const holding = owner(target, 10);
    await held(holding);
    process.kill(-(holding.pid as number), 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const other = site('hold', target);
    const outcome = await Promise.race([
      other.exited.then(() => 'exited' as const),
      new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 2_000)),
    ]);
    expect(other.committed).toEqual([]);
    expect(outcome).toBe('held');

    holding.stdin.end();
    await other.waitFor(1, 10_000);
    expect(other.committed).toEqual(['held']);
  }, 30_000);

  it('leave nothing behind when a hangup ends the owner waiting for the lock', async () => {
    // A terminal hanging up sends the group SIGHUP (SIGQUIT and timeout(1)'s group kill are
    // the same case), and the owner dies of it. Its flock(1) waiter must die with it: in a
    // session of its own -- the first answer to the Ctrl-C above -- it waited out its
    // `--timeout`, up to fifteen minutes for a workspace lock, and then took the lock.
    const target = path.join(scratch, 'contended.lock');
    const holder = site('hold', target);
    await holder.waitFor(1);
    const waiting = owner(target, 27);
    const deadline = Date.now() + 10_000;
    while (flocks(target, 27).length === 0) {
      if (Date.now() > deadline) throw new Error('the owner never started waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(-(waiting.pid as number), 'SIGHUP');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(flocks(target, 27)).toEqual([]);
  }, 30_000);

  it('leave nothing behind when a hangup ends the owner holding the lock', async () => {
    const target = path.join(scratch, 'hungup.lock');
    const holding = owner(target, 26);
    await held(holding);
    const before = flocks(target, 26);
    expect(before.length).toBeGreaterThanOrEqual(2);
    process.kill(-(holding.pid as number), 'SIGHUP');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const alive = before.filter((pid) => fs.existsSync(`/proc/${String(pid)}`));
    expect(alive).toEqual([]);
    await (await acquireFileLock(target, { timeoutMs: 2_000 })).release();
  }, 30_000);
});
