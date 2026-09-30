/**
 * The AWS seam, against real processes.
 *
 * NOT against `aws` or `eksctl` -- this file must never launch either, and the module it
 * tests is the one that would. A scripted binary on a scripted PATH is the honest
 * substitute: the seam's contract is about argv, exit codes, merged streams and lines
 * arriving as they are written, none of which is specific to the tool on the other end.
 *
 * The same shape `docker-cli.test.ts` uses, and for the same reason.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LAUNCH_FAILURE_CODE, awsCli } from '../../src/seams/aws-cli';

let bin = '';

/** A scripted stand-in on PATH, so the seam resolves a name exactly as it would a tool. */
function scripted(name: string, body: string): string {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path.join(bin, name);
}

const onPath = () => ({ ...process.env, PATH: bin });

beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-aws-seam-'));
});

afterEach(() => {
  fs.rmSync(bin, { recursive: true, force: true });
});

describe('a finished call', () => {
  it('is shaped as the completed call earlier releases returned, because every caller reads it', async () => {
    // `returncode`, `stdout` and `stderr` are earlier releases' field names. `oneLine` and
    // `why` read them, and code that renamed them would make every comparison with earlier
    // releases a translation.
    scripted('aws', 'printf "out"; printf "err" >&2; exit 3');
    const res = await awsCli.run([path.join(bin, 'aws'), 'sts', 'get-caller-identity']);
    expect(res.returncode).toBe(3);
    expect(res.stdout).toBe('out');
    expect(res.stderr).toBe('err');
    expect(res.argv).toEqual([path.join(bin, 'aws'), 'sts', 'get-caller-identity']);
  });

  it('passes argv through literally, with no shell in the way', async () => {
    // A region or a cluster name is caller-supplied, and a shell between here and the
    // tool is where a name with a space or a `$` becomes two arguments or somebody's
    // environment.
    scripted('aws', 'for a in "$@"; do printf "[%s]" "$a"; done');
    const res = await awsCli.run([
      path.join(bin, 'aws'),
      'eks',
      'describe-cluster',
      '--name',
      'a b$c',
    ]);
    expect(res.stdout).toBe('[eks][describe-cluster][--name][a b$c]');
  });

  it('reports a missing binary as 127 rather than throwing', async () => {
    // `doctor` is the command somebody runs precisely because things are already wrong,
    // and a preflight that raised on a missing binary would have to be wrapped at every
    // call site -- one forgotten wrapper takes the report down.
    const res = await awsCli.run([path.join(bin, 'not-a-tool'), 'version']);
    expect(res.returncode).toBe(LAUNCH_FAILURE_CODE);
    expect(res.stderr).not.toBe('');
  });

  it('reports a signalled tool as hopeless rather than as success', async () => {
    // A signalled process has no exit code. The only thing any caller does with it is
    // compare against zero.
    scripted('aws', 'kill -TERM $$; exec sleep 5');
    const res = await awsCli.run([path.join(bin, 'aws')], { timeoutMs: 10_000 });
    expect(res.returncode).toBe(LAUNCH_FAILURE_CODE);
  }, 30_000);

  it('gives up at a deadline, and says so as a code', async () => {
    // `exec` so the sleeping process IS the direct child: a timeout kills what it
    // launched, exactly as earlier releases' timed child call does, and a grandchild holding
    // the pipe open would keep the call waiting on output nobody is going to read. Found
    // by writing it the other way first, where this took the full five seconds.
    scripted('aws', 'exec sleep 5');
    const started = Date.now();
    const res = await awsCli.run([path.join(bin, 'aws')], { timeoutMs: 300 });
    expect(res.returncode).toBe(LAUNCH_FAILURE_CODE);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 30_000);

  it('replaces the environment when given one, rather than extending it', async () => {
    // No env means inherit, as in earlier releases; an env that was merged instead of replaced is
    // how houston's own kubeconfig leaks into a call meant to use the user's.
    scripted('aws', 'printf "%s|%s" "${MARKER:-unset}" "${HOME:-unset}"');
    const inherited = await awsCli.run([path.join(bin, 'aws')]);
    expect(inherited.stdout).toContain('unset|');
    const replaced = await awsCli.run([path.join(bin, 'aws')], { env: { MARKER: 'yes' } });
    expect(replaced.stdout).toBe('yes|unset');
  });
});

describe('the twenty-minute call', () => {
  it('hands over each line AS IT ARRIVES, not at the end', async () => {
    // `cluster create` printed one line and then went silent for the entire build, which
    // is indistinguishable from a hang -- and the only safe assumption, kill it, is the
    // one that leaves a half-built VPC behind.
    scripted('eksctl', 'printf "first\\n"; printf "second\\n"; printf "third\\n"');
    const lines: string[] = [];
    const res = await awsCli.stream([path.join(bin, 'eksctl'), 'create'], {
      env: onPath(),
      onLine: (line) => lines.push(line),
    });
    expect(res.returncode).toBe(0);
    expect(lines).toEqual(['first', 'second', 'third']);
  }, 30_000);

  it('merges stderr, because eksctl writes its progress there', async () => {
    // Reading only stdout would produce a silent twenty minutes with the progress on the
    // floor.
    scripted('eksctl', 'printf "to stdout\\n"; printf "to stderr\\n" >&2');
    const lines: string[] = [];
    await awsCli.stream([path.join(bin, 'eksctl')], { onLine: (line) => lines.push(line) });
    expect(lines.sort()).toEqual(['to stderr', 'to stdout']);
  }, 30_000);

  it('flushes a last line that never got its newline', async () => {
    // Which is usually the failure reason, so losing it for want of a byte loses the one
    // thing worth reading.
    scripted('eksctl', 'printf "done\\nError: no route to host"');
    const lines: string[] = [];
    await awsCli.stream([path.join(bin, 'eksctl')], { onLine: (line) => lines.push(line) });
    expect(lines).toEqual(['done', 'Error: no route to host']);
  }, 30_000);

  it('reassembles a line split across two writes', async () => {
    // A chunk boundary is not a line boundary, and a reader that treated it as one would
    // report half a message twice.
    // `%s` rather than a literal, because `-and-half` is an OPTION to dash's printf.
    scripted('eksctl', 'printf "half"; sleep 0.2; printf "%s\\n" "-and-half"');
    const lines: string[] = [];
    await awsCli.stream([path.join(bin, 'eksctl')], { onLine: (line) => lines.push(line) });
    expect(lines).toEqual(['half-and-half']);
  }, 30_000);

  it('reports a launch failure as 127 here too, and says nothing it did not see', async () => {
    const lines: string[] = [];
    const res = await awsCli.stream([path.join(bin, 'not-a-tool')], {
      onLine: (line) => lines.push(line),
    });
    expect(res.returncode).toBe(LAUNCH_FAILURE_CODE);
    expect(lines).toEqual([]);
    expect(res.stderr).not.toBe('');
  }, 30_000);

  it('carries a non-zero exit through, because the caller decides what it means', async () => {
    scripted('eksctl', 'printf "building\\n"; exit 1');
    const lines: string[] = [];
    const res = await awsCli.stream([path.join(bin, 'eksctl')], {
      onLine: (line) => lines.push(line),
    });
    expect([res.returncode, lines]).toEqual([1, ['building']]);
  }, 30_000);
});

describe('the seam itself', () => {
  it('is a pair of replaceable properties, because module bindings are not', async () => {
    // swc emits exports as non-configurable getters, so `jest.spyOn` on a bare exported
    // function fails outright. Every test of `core/eks.ts` depends on this working -- it
    // is what stands between that suite and a real `eksctl create cluster`.
    const realRun = awsCli.run;
    const realStream = awsCli.stream;
    try {
      awsCli.run = () =>
        Promise.resolve({ argv: [], returncode: 0, stdout: 'stubbed', stderr: '' });
      awsCli.stream = () =>
        Promise.resolve({ argv: [], returncode: 0, stdout: 'also stubbed', stderr: '' });
      expect((await awsCli.run(['aws'])).stdout).toBe('stubbed');
      expect((await awsCli.stream(['eksctl'], { onLine: () => undefined })).stdout).toBe(
        'also stubbed',
      );
    } finally {
      awsCli.run = realRun;
      awsCli.stream = realStream;
    }
  });
});
