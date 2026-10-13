import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import * as v8 from 'node:v8';
import * as vm from 'node:vm';

import {
  capture,
  cleanup,
  interrupt,
  Interrupted,
  POPEN_SIGINT_WAIT_MS,
  ProcessTimeout,
  resetInterruptForTest,
  sleep,
  SpawnFailure,
  startDetached,
  stoppable,
  stream,
  type ProcessChunk,
  unwindsOnInterrupt,
} from '../../src/seams/exec';
import { ReproError } from '../../src/lib/errors';
import type * as AwsCliNS from '../../src/seams/aws-cli';
import type * as DockerCliNS from '../../src/seams/docker-cli';
import type * as KubectlNS from '../../src/seams/kubectl';

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;

function script(source: string, ...args: string[]): readonly [string, ...string[]] {
  return [NODE, '-e', source, ...args];
}

function asText(chunk: ProcessChunk): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

async function waitForGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('capture', () => {
  it('passes argv literally without a shell and preserves non-zero exits', async () => {
    const metacharacters = '$(printf injected); * "$HOME"';
    const result = await capture(
      script(
        'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exitCode = 23',
        metacharacters,
        'two words',
      ),
      { encoding: 'utf8' },
    );

    expect(JSON.parse(result.stdout as string)).toEqual([metacharacters, 'two words']);
    expect(result.exitCode).toBe(23);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
  });

  it('preserves cwd, replacement env, stdin, and byte-versus-text decoding', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-exec-cwd-'));
    try {
      const source = [
        "const chunks = []; process.stdin.on('data', c => chunks.push(c));",
        "process.stdin.on('end', () => process.stdout.write(JSON.stringify({",
        '  cwd: process.cwd(), only: process.env.HOUSTON_EXEC_ONLY,',
        "  inherited: process.env.HOUSTON_HOME ?? null, input: Buffer.concat(chunks).toString('utf8')",
        '})));',
      ].join('\n');
      const bytes = await capture(script(source), {
        cwd,
        env: { HOUSTON_EXEC_ONLY: 'present' },
        input: Buffer.from('from stdin'),
      });
      expect(Buffer.isBuffer(bytes.stdout)).toBe(true);
      expect(JSON.parse((bytes.stdout as Buffer).toString('utf8'))).toEqual({
        cwd,
        only: 'present',
        inherited: null,
        input: 'from stdin',
      });

      const text = await capture(script("process.stdout.write('snowman: ☃')"), {
        encoding: 'utf8',
      });
      expect(text.stdout).toBe('snowman: ☃');

      const inherited = await capture(script("process.stdout.write(process.env.PATH ?? '')"), {
        encoding: 'utf8',
      });
      expect(inherited.stdout).toBe(process.env.PATH);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves invalid bytes and does not truncate large captures', async () => {
    const size = 1024 * 1024 + 17;
    const result = await capture(script(`process.stdout.write(Buffer.alloc(${size}, 0xff))`));
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect((result.stdout as Buffer).length).toBe(size);
    expect((result.stdout as Buffer).every((byte) => byte === 0xff)).toBe(true);
  });

  it('rejects malformed UTF-8 in text mode without losing the bytes option', async () => {
    const argv = script('process.stdout.write(Buffer.from([0xff]))');
    await expect(capture(argv, { encoding: 'utf8' })).rejects.toThrow(/encoded data/i);
    const bytes = await capture(argv);
    expect(bytes.stdout).toEqual(Buffer.from([0xff]));
  });

  it('does not leak captured output onto the parent streams used by --json', async () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await capture(
      script("process.stdout.write('machine data'); process.stderr.write('diagnostic')"),
      { encoding: 'utf8' },
    );
    expect(result.stdout).toBe('machine data');
    expect(result.stderr).toBe('diagnostic');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('keeps stderr separate or merges it into stdout in observed order', async () => {
    const source = [
      "const fs = require('node:fs');",
      "fs.writeSync(1, 'out-1\\n');",
      "fs.writeSync(2, 'err\\n');",
      "fs.writeSync(1, 'out-2\\n');",
    ].join('\n');
    const separate = await capture(script(source), { encoding: 'utf8' });
    expect(separate.stdout).toBe('out-1\nout-2\n');
    expect(separate.stderr).toBe('err\n');

    const merged = await capture(script(source), { encoding: 'utf8', mergeStderr: true });
    expect(merged.stdout).toBe('out-1\nerr\nout-2\n');
    expect(merged.stderr).toBeNull();
  });

  it('reports a missing executable without losing the operating-system cause', async () => {
    expect.assertions(6);
    try {
      await capture(['houston-executable-that-does-not-exist-5-1']);
    } catch (error) {
      expect(error).toBeInstanceOf(SpawnFailure);
      const failure = error as SpawnFailure;
      expect(failure.cause).toBeDefined();
      expect(failure.cause.code).toBe('ENOENT');
      expect(failure.argv).toEqual(['houston-executable-that-does-not-exist-5-1']);
      expect(failure.message).toContain('could not spawn');
      expect(failure).not.toBeInstanceOf(ReproError);
    }
  });

  it('preserves an inner spawn cause when stderr is truly merged', async () => {
    await expect(
      capture(['houston-merged-missing-5-1'], { mergeStderr: true }),
    ).rejects.toMatchObject({
      name: 'SpawnFailure',
      cause: { code: 'ENOENT', path: 'houston-merged-missing-5-1' },
    });
  });

  it('kills on timeout and retains output produced before expiry', async () => {
    expect.assertions(5);
    try {
      await capture(script("process.stdout.write('started\\n'); setTimeout(() => {}, 10_000)"), {
        encoding: 'utf8',
        timeoutMs: 80,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessTimeout);
      const timeout = error as ProcessTimeout;
      expect(timeout.timeoutMs).toBe(80);
      expect(timeout.result.stdout).toBe('started\n');
      expect(timeout.result.exitCode).toBeNull();
      expect(timeout.result.signal).toBe('SIGKILL');
    }
  });

  it('cancels the real command behind a merged-output relay', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-exec-merge-timeout-'));
    const marker = path.join(scratch, 'survived');
    const source = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 300)`;
    try {
      await expect(
        capture(script(source), { mergeStderr: true, timeoutMs: 80 }),
      ).rejects.toBeInstanceOf(ProcessTimeout);
      await new Promise((resolve) => setTimeout(resolve, 380));
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('settles cleanly when merged cancellation races a fast exit', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const controller = new AbortController();
      const running = capture(script('setTimeout(() => {}, 1)'), {
        mergeStderr: true,
        abortSignal: controller.signal,
      });
      setTimeout(() => controller.abort(), 1);
      const result = await running;
      expect(result.exitCode === 0 || result.signal !== null).toBe(true);
    }
  });

  it('returns signal termination as a process fact', async () => {
    const result = await capture(script("process.kill(process.pid, 'SIGTERM')"));
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });

  it('inherits stdin while capturing stdout and stderr', () => {
    const hook = path.join(ROOT, 'tools', 'ts-require.js');
    const seam = path.join(ROOT, 'src', 'seams', 'exec.ts');
    const outerSource = [
      `require(${JSON.stringify(hook)}).install();`,
      `const { capture } = require(${JSON.stringify(seam)});`,
      "capture([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],",
      "  { encoding: 'utf8' }).then(result => process.stdout.write(result.stdout));",
    ].join('\n');
    const outer = spawnSync(NODE, ['-e', outerSource], {
      input: 'mixed descriptors',
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(outer.error).toBeUndefined();
    expect(outer.status).toBe(0);
    expect(outer.stdout).toBe('mixed descriptors');
    expect(outer.stderr).toBe('');
  });
});

describe('stream', () => {
  it('streams binary stdin to a backpressure-aware output sink', async () => {
    const input = Buffer.from([0x00, 0xff, 0x41, 0x00]);
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    const result = await stream(script('process.stdin.pipe(process.stdout)'), {
      stdin: Readable.from([input]),
      stdoutSink: sink,
    });

    expect(Buffer.concat(chunks)).toEqual(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeNull();
  });

  it('waits for slow sink writes and turns a sink failure into rejection', async () => {
    let slowWriteFinished = false;
    const slow = new Writable({
      write(_chunk, _encoding, done) {
        setTimeout(() => {
          slowWriteFinished = true;
          done();
        }, 50);
      },
    });
    await stream(script("process.stdout.write('slow')"), { stdoutSink: slow });
    expect(slowWriteFinished).toBe(true);

    const broken = new Writable({
      write(_chunk, _encoding, done) {
        setTimeout(() => done(new Error('sink refused the write')), 10);
      },
    });
    await expect(
      stream(script("process.stdout.write('broken')"), { stdoutSink: broken }),
    ).rejects.toThrow('sink refused the write');

    const destroyed = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    destroyed.destroy();
    await new Promise<void>((resolve) => destroyed.once('close', resolve));
    await expect(
      stream(script("process.stdout.write('discarded')"), { stdoutSink: destroyed }),
    ).rejects.toMatchObject({ code: 'ERR_STREAM_DESTROYED' });
  });

  it('streams split UTF-8 characters without retaining unbounded output', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const source = [
      'const snowman = Buffer.from([0xe2, 0x98, 0x83]);',
      'const euro = Buffer.from([0xe2, 0x82, 0xac]);',
      'process.stdout.write(snowman.subarray(0, 1));',
      'process.stderr.write(euro.subarray(0, 1));',
      'setTimeout(() => process.stdout.write(snowman.subarray(1)), 15);',
      'setTimeout(() => process.stderr.write(euro.subarray(1)), 30);',
    ].join('\n');
    const result = await stream(script(source), {
      encoding: 'utf8',
      onStdout: (chunk) => stdout.push(asText(chunk)),
      onStderr: (chunk) => stderr.push(asText(chunk)),
    });

    expect(stdout.join('')).toBe('☃');
    expect(stderr.join('')).toBe('€');
    expect(result.stdout).toBeNull();
    expect(result.stderr).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it('delivers output before process completion', async () => {
    let completed = false;
    let sawChunk: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => {
      sawChunk = resolve;
    });
    const running = stream(
      script("process.stdout.write('early'); setTimeout(() => process.exit(0), 150)"),
      { onStdout: () => sawChunk?.() },
    ).then((result) => {
      completed = true;
      return result;
    });

    await firstChunk;
    expect(completed).toBe(false);
    expect((await running).exitCode).toBe(0);
  });

  it('keeps no copy of what it delivered when stderr is merged into stdout', async () => {
    // `stream` delivers without retaining, and with `mergeStderr` it retained every chunk
    // anyway: Kubernetes `logs -f` held all it had printed, 346 MB for 500,000 lines where
    // earlier releases hold 37 MB, growing for as long as the follow ran. Asked while the
    // child still runs, since whatever the seam holds is released with the call.
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    for (const mergeStderr of [true, false]) {
      const delivered: WeakRef<object>[] = [];
      let sawChunk: (() => void) | undefined;
      const firstChunk = new Promise<void>((resolve) => {
        sawChunk = resolve;
      });
      const running = stream(
        script("process.stdout.write('x'.repeat(65536)); setTimeout(() => process.exit(0), 800)"),
        {
          mergeStderr,
          onStdout: (chunk) => {
            delivered.push(new WeakRef(chunk as Buffer));
            sawChunk?.();
          },
        },
      );
      await firstChunk;
      await tick();
      gc();
      await tick();
      const held = delivered.filter((ref) => ref.deref() !== undefined).length;
      const result = await running;
      expect({ mergeStderr, held, stdout: result.stdout }).toEqual({
        mergeStderr,
        held: 0,
        stdout: null,
      });
    }
  });

  it('routes merged stderr through the stdout callback only', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await stream(
      script("process.stdout.write('one'); setTimeout(() => process.stderr.write('two'), 15)"),
      {
        encoding: 'utf8',
        mergeStderr: true,
        onStdout: (chunk) => stdout.push(asText(chunk)),
        onStderr: (chunk) => stderr.push(asText(chunk)),
      },
    );
    expect(stdout.join('')).toBe('onetwo');
    expect(stderr).toEqual([]);
  });
});

describe('inherited and detached variants', () => {
  it('inherits all three parent streams', () => {
    const hook = path.join(ROOT, 'tools', 'ts-require.js');
    const seam = path.join(ROOT, 'src', 'seams', 'exec.ts');
    const inner = [
      `require(${JSON.stringify(hook)}).install();`,
      `const { inherit } = require(${JSON.stringify(seam)});`,
      "inherit([process.execPath, '-e',",
      '  "process.stdin.pipe(process.stdout); process.stderr.write(\'inherited stderr\')"',
      ']).then(result => { if (result.exitCode !== 0) process.exitCode = 91; });',
    ].join('\n');
    const outer = spawnSync(NODE, ['-e', inner], {
      input: 'inherited stdin',
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(outer.error).toBeUndefined();
    expect(outer.status).toBe(0);
    expect(outer.stdout).toBe('inherited stdin');
    expect(outer.stderr).toBe('inherited stderr');
  });

  it('unrefs only an intentional detached child and cleans it up', () => {
    const hook = path.join(ROOT, 'tools', 'ts-require.js');
    const seam = path.join(ROOT, 'src', 'seams', 'exec.ts');
    const outerSource = [
      `require(${JSON.stringify(hook)}).install();`,
      `const { startDetached } = require(${JSON.stringify(seam)});`,
      "startDetached([process.execPath, '-e', 'setTimeout(() => {}, 10000)'])",
      '  .then(child => process.stdout.write(String(child.pid)));',
    ].join('\n');
    const outer = spawnSync(NODE, ['-e', outerSource], { encoding: 'utf8', timeout: 2_000 });
    expect(outer.error).toBeUndefined();
    expect(outer.status).toBe(0);
    const pid = Number(outer.stdout);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();

    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  });

  it('reports detached spawn failure with its cause', async () => {
    await expect(startDetached(['houston-detached-missing-5-1'])).rejects.toMatchObject({
      name: 'SpawnFailure',
      cause: { code: 'ENOENT' },
    });
  });
});

(process.platform === 'win32' ? describe.skip : describe)('process-group cancellation', () => {
  it('kills grandchildren rather than leaving timeout work behind', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-exec-group-'));
    const marker = path.join(scratch, 'survived');
    const parent = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e',",
      `  ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 350)`)},`,
      "], { stdio: 'ignore' });",
      'setTimeout(() => {}, 10_000);',
    ].join('\n');

    try {
      await expect(
        capture(script(parent), { processGroup: true, timeoutMs: 80 }),
      ).rejects.toBeInstanceOf(ProcessTimeout);
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('test cleanup helper', () => {
  it('observes killed detached processes disappear', async () => {
    const child = await startDetached(script('setTimeout(() => {}, 10000)'));
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
    } finally {
      expect(await waitForGone(child.pid)).toBe(true);
    }
  });
});

/**
 * Ctrl-C reaching a wait, as earlier releases' Interrupted reaches one. These
 * raise the interrupt in this process, with `end` standing for runMain's exit; the same
 * answers through the real entry point are test/cli/startup.test.ts's.
 */
describe('Ctrl-C, as an Interrupted reaches what Houston waits on', () => {
  afterEach(() => resetInterruptForTest());

  /** A child that prints its pid and then waits for 30 s, and that pid once it is up. */
  function waitingChild(): { wait: Promise<unknown>; pid: Promise<number> } {
    let started!: (pid: number) => void;
    const pid = new Promise<number>((resolve) => (started = resolve));
    const wait = stream(
      script('process.stdout.write(String(process.pid)); setTimeout(() => {}, 30_000)'),
      { encoding: 'utf8', onStdout: (chunk) => started(Number(asText(chunk))) },
    );
    return { wait, pid };
  }

  it("outside an unwind: stops the child after earlier releases' grace, then ends, the wait unsettled", async () => {
    // An earlier release's child call under an Interrupted: 0.25 s for the child, then
    // SIGKILL.
    const { wait, pid } = waitingChild();
    let settled = false;
    wait.then(
      () => (settled = true),
      () => (settled = true),
    );
    const child = await pid;
    const began = Date.now();
    await new Promise<void>((resolve) => interrupt(resolve));
    expect(Date.now() - began).toBeGreaterThanOrEqual(POPEN_SIGINT_WAIT_MS - 10);
    expect(await waitForGone(child)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
  });

  it('inside an unwind: raises where it waited, and the finally and its cleanup run', async () => {
    const order: string[] = [];
    let ended = 0;
    let child = 0;
    const running = unwindsOnInterrupt(async () => {
      const { wait, pid } = waitingChild();
      child = await pid;
      try {
        await wait;
        order.push('returned');
      } finally {
        order.push('finally');
        // A wait that STARTS after the interrupt, in a cleanup: it runs, as earlier releases'
        // cleanup runs `compose start rocketchat`.
        await cleanup(async () => {
          const again = await capture(script('process.stdout.write("again")'), {
            encoding: 'utf8',
          });
          order.push(`cleanup ${String(again.stdout)}`);
        });
      }
    });
    while (child === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    interrupt(() => (ended += 1));
    await expect(running).rejects.toBeInstanceOf(Interrupted);
    expect(order).toEqual(['finally', 'cleanup again']);
    expect(await waitForGone(child)).toBe(true);
    expect(ended).toBe(0);
  });

  it("cuts earlier releases' grace short at a second Ctrl-C, and the unwind goes on", async () => {
    // In earlier releases the second Interrupted lands inside the 0.25 s grace wait:
    // the call kills the child and the unwind continues through the `finally`. Here the second
    // found nothing pending -- the first had taken the child -- and ended the process with
    // nothing unwound, the child still running out its grace.
    const order: string[] = [];
    let ended = 0;
    let child = 0;
    let raisedAt = 0;
    const running = unwindsOnInterrupt(async () => {
      const { wait, pid } = waitingChild();
      child = await pid;
      try {
        await wait;
      } finally {
        raisedAt = Date.now();
        order.push('finally');
      }
    });
    while (child === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const began = Date.now();
    interrupt(() => (ended += 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    interrupt(() => (ended += 1));
    await expect(running).rejects.toBeInstanceOf(Interrupted);
    expect(ended).toBe(0);
    expect(order).toEqual(['finally']);
    expect(raisedAt - began).toBeLessThan(POPEN_SIGINT_WAIT_MS - 50);
    expect(await waitForGone(child)).toBe(true);
  });

  it('raises at the next wait when nothing it could reach was pending at the Ctrl-C', async () => {
    // Earlier releases raise at the instruction they are on; this build raises at the next wait.
    let ended = 0;
    const running = unwindsOnInterrupt(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await sleep(30_000);
      return 'slept';
    });
    interrupt(() => (ended += 1));
    await expect(running).rejects.toBeInstanceOf(Interrupted);
    expect(ended).toBe(0);
  });

  it('ends an unwind that cannot finish -- a wait nobody registered -- after its bound', async () => {
    let ended = 0;
    void unwindsOnInterrupt(async () => {
      try {
        await sleep(30_000);
      } finally {
        // Not a `cleanup`, and waiting on something a Ctrl-C cannot reach.
        await new Promise(() => undefined);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    interrupt(() => (ended += 1));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(ended).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(ended).toBe(1);
  });

  it('ends at a second Ctrl-C with nothing left to raise in', async () => {
    let ended = 0;
    void unwindsOnInterrupt(async () => {
      try {
        await sleep(30_000);
      } finally {
        await new Promise(() => undefined);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    interrupt(() => (ended += 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toBe(0);
    interrupt(() => (ended += 1));
    expect(ended).toBe(1);
  });

  it('ends the process at the next wait when a catch swallowed the interrupt', async () => {
    // A catch-all `catch` catches what earlier releases' catch-all did not; what it does next
    // -- here, start another child -- is code earlier releases never run.
    let ended = 0;
    let carriedOn = false;
    void unwindsOnInterrupt(async () => {
      try {
        await sleep(30_000);
      } catch {
        /* a catch-all */
      }
      await capture(script(''));
      carriedOn = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    interrupt(() => (ended += 1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ended).toBe(1);
    expect(carriedOn).toBe(false);
  });
});

describe('stopping one job, as the GUI Stop button does', () => {
  it('kills the child a stopped job waits on, and leaves another job’s child alone', async () => {
    // A stuck job is as often inside `kubectl` as inside a sleep; Stop has to reach both,
    // and only the job it was pressed for.
    const stop = new AbortController();
    const keep = new AbortController();
    const long = [process.execPath, '-e', 'setTimeout(() => {}, 30000)'] as const;
    const started = performance.now();
    const stopped = stoppable(stop.signal, async () => await capture(long));
    const other = stoppable(keep.signal, async () => await capture(long, { timeoutMs: 1500 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort();
    await expect(stopped).rejects.toBeInstanceOf(Interrupted);
    expect(performance.now() - started).toBeLessThan(5000);
    // The other job's child was not stopped: it ran on until its own timeout.
    await expect(other).rejects.toBeInstanceOf(ProcessTimeout);
    // And a wait the stopped job starts afterwards does not start at all.
    await expect(stoppable(stop.signal, async () => await sleep(10_000))).rejects.toBeInstanceOf(
      Interrupted,
    );
  });

  it('reaches the job through the kubectl, aws and docker seams, which used to swallow it', async () => {
    // A stopped `ready` on a real k3s workspace took eleven seconds to end: the kubectl seam
    // turned the Interrupted into "exit 127", the pod wait read that as a refused question,
    // and retried three times before giving up. A Ctrl-C was swallowed the same way.
    const { kubectl } = require('../../src/seams/kubectl') as typeof KubectlNS;
    const { awsCli } = require('../../src/seams/aws-cli') as typeof AwsCliNS;
    const docker = require('../../src/seams/docker-cli') as typeof DockerCliNS;
    const long = [process.execPath, '-e', 'setTimeout(() => {}, 30000)'];
    for (const [tool, call] of [
      ['kubectl', async () => await kubectl.run(long)],
      ['aws', async () => await awsCli.run(long)],
      ['aws stream', async () => await awsCli.stream(long, { onLine: () => undefined })],
      ['docker', async () => await docker.firstLine(long)],
    ] as const) {
      const stop = new AbortController();
      const running = stoppable<unknown>(stop.signal, call);
      await new Promise((resolve) => setTimeout(resolve, 200));
      stop.abort();
      await expect([
        tool,
        await running.then(
          () => 'answered',
          (e: unknown) => e,
        ),
      ]).toEqual([tool, expect.any(Interrupted)]);
    }
  });
});
