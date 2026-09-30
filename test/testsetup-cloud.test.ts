/**
 * The cloud guard, proven: it answers ABSENT, refuses a spend loudly, cannot be removed
 * through the module registry, and still loses to a test that owns its stub.
 *
 * The first three cases, per tool, are the guard's own three claims. The rest cover what
 * measurement showed also mattered: presence answered from the box, a refusal swallowed by the
 * seam above, and a guard stripped by `jest.dontMock`.
 *
 * "Without the fixture, the same test reaches them" is a claim about a run WITHOUT this
 * file's setup, which no test inside that run can make. `yarn test:fixtures:prove` makes it:
 * it runs planted specs with and without each setup file, with a recording stand-in on
 * PATH, and requires the reach to appear in one and not the other.
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { kube } from '../src/core/kube/exec';
import * as tools from '../src/core/kube/tools';
import { capture, inherit, startDetached, stream } from '../src/seams/exec';
import * as policy from './testsetup-policy';

import type * as ToolsNS from '../src/core/kube/tools';

const TOOLS = ['eksctl', 'aws', 'kubectl', 'helm', 'kind', 'docker'] as const;

/** What this test itself caused, taken out so the setup file's verdict does not fire. */
function drained(): string[] {
  return policy.record().splice(0);
}

afterEach(() => {
  drained();
});

describe('the six tools are absent, not merely blocked', () => {
  it.each(TOOLS)('reports %s unavailable, with the reason on stderr', async (tool) => {
    const result = await capture([tool, 'version', 'fixture'], { encoding: 'utf8' });
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${tool} is unavailable in the test suite`);
  });

  it.each(TOOLS)('refuses a %s spend before anything is launched', async (tool) => {
    await expect(capture([tool, 'create', 'fixture'])).rejects.toThrow(
      `the test suite tried to run \`${tool} create fixture\``,
    );
    await expect(stream([tool, 'delete', 'fixture'])).rejects.toThrow(
      `the test suite tried to stream \`${tool} delete fixture\``,
    );
    expect(drained()).toHaveLength(2);
  });

  it.each(TOOLS)('never starts a streaming, inherited or detached %s', async (tool) => {
    const chunks: string[] = [];
    const streamed = await stream([tool, 'version'], {
      encoding: 'utf8',
      onStderr: (chunk) => chunks.push(String(chunk)),
    });
    expect(streamed.exitCode).toBe(127);
    expect(chunks.join('')).toBe(`${tool} is unavailable in the test suite`);
    expect((await inherit([tool, 'version'])).exitCode).toBe(127);
    await expect(startDetached([tool, 'version'])).rejects.toMatchObject({
      name: 'SpawnFailure',
      cause: { code: 'ENOENT' },
    });
  });

  it('carries the reason on stdout when the caller merged the two streams', async () => {
    const merged = await capture(['docker', 'info'], { encoding: 'utf8', mergeStderr: true });
    expect(merged).toMatchObject({
      exitCode: 127,
      stdout: 'docker is unavailable in the test suite',
      stderr: null,
    });
    const bytes = await capture(['docker', 'info']);
    expect(Buffer.isBuffer(bytes.stderr)).toBe(true);
  });

  it('refuses a real tool named by its absolute path, whether or not it exists here', async () => {
    // A de-pointed stub does not always reach for the bare name. The answer must not
    // depend on whether this machine has the binary at that path.
    const result = await capture(['/usr/local/bin/kubectl', 'version'], { encoding: 'utf8' });
    expect(result.exitCode).toBe(127);
    await expect(capture(['/usr/local/bin/eksctl', 'create', 'cluster'])).rejects.toThrow(
      'creates or destroys real infrastructure',
    );
    // Taken out HERE: an undrained refusal fails the test in the setup file's `afterEach`,
    // which runs before this file's -- observed, the first time this case was written.
    expect(drained()).toEqual([expect.stringContaining('eksctl create cluster')]);
  });

  it('lets everything that is not one of the six straight through', async () => {
    const result = await capture([process.execPath, '-e', 'process.stdout.write("real")'], {
      encoding: 'utf8',
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'real' });
  });
});

describe('presence is absent too, because it is not decided at the process seam', () => {
  it.each(TOOLS)('reports %s as not installed through which() and tool()', async (tool) => {
    expect(tools.which(tool)).toBe('');
    const found = await tools.tool(tool);
    expect(found.path).toBe('');
    expect(tools.toolPresent(found)).toBe(false);
  });

  it('answers the same for a tool that is not one of the six', () => {
    // `sh` is on every PATH this suite runs on; the guard is about the six and only them.
    expect(tools.which('sh')).not.toBe('');
  });
});

describe('a refusal the seam above swallows is still a failure', () => {
  it('is recorded when seams/kubectl turns it into an ordinary 127', async () => {
    // `seams/kubectl.ts` catches EVERY error from `capture` and returns returncode 127, so
    // a thrown refusal arrives at the caller as a failed command. Earlier releases' kubectl
    // call caught only launch failures, which is why their guard could simply raise.
    const result = await kube.run(['kubectl', 'delete', 'namespace', 'houston-fixture']);
    expect(result.returncode).toBe(127);
    expect(result.stderr).toContain('creates or destroys real infrastructure');
    // ...and the record is what fails the test in `afterEach`, where no catch can reach.
    expect(drained()).toEqual([expect.stringContaining('kubectl delete namespace')]);
  });
});

describe('the backstop below the module registry', () => {
  it('runs a stand-in instead of a real tool that reached child_process directly', () => {
    const result = childProcess.spawnSync('docker', ['info'], { encoding: 'utf8' });
    expect(result.status).toBe(127);
    expect(result.stderr).toBe('docker is unavailable in the test suite');
    expect(drained()).toEqual([expect.stringContaining('BELOW the process seam')]);
  });

  it('sees through the relay seams/exec uses to merge stderr', () => {
    const result = childProcess.spawnSync(
      process.execPath,
      ['-e', 'relay', '--', 'kubectl', 'version'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(127);
    expect(drained()).toEqual([expect.stringContaining('`kubectl version`')]);
  });
});

describe('what the test built is the test’s own', () => {
  let scratch = '';
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-cloud-guard-'));
    fs.writeFileSync(path.join(scratch, 'docker'), '#!/bin/sh\nprintf fake\n', { mode: 0o755 });
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('runs a scripted stand-in named by its absolute path', async () => {
    const result = await capture([path.join(scratch, 'docker'), 'info'], { encoding: 'utf8' });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'fake' });
  });

  it('runs a scripted stand-in found first on a PATH the test handed the launch', async () => {
    const env = { ...process.env, PATH: `${scratch}${path.delimiter}${process.env.PATH ?? ''}` };
    const result = await capture(['docker', 'info'], { encoding: 'utf8', env });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'fake' });
  });

  it('owns what it built under the temp root, and nothing outside it', () => {
    expect(policy.testOwned(path.join(scratch, 'docker'))).toBe(true);
    expect(policy.testOwned('/usr/bin/docker')).toBe(false);
    // A temp directory the ENVIRONMENT had on PATH is not a fake either. MEASURED: with
    // "under the temp root" as the whole rule, a logging shim on PATH under /tmp was taken
    // for a stand-in and let eleven real launches through -- what a CI runner unpacking
    // tools into /tmp/bin would get. That case needs a run whose ambient PATH holds such a
    // directory, so `yarn test:fixtures:prove` makes it: its recording shim lives there.
  });

  it('treats a link to the real binary as the real binary', () => {
    const link = path.join(scratch, 'kubectl');
    fs.symlinkSync('/usr/bin/env', link);
    expect(policy.testOwned(link)).toBe(false);
  });
});

describe('a test that owns a stub still wins', () => {
  afterEach(() => {
    // Put the suite's guard back rather than `dontMock` -- the trap the next block refuses.
    jest.doMock('../src/core/kube/tools', () => policy.guardedTools());
    jest.resetModules();
  });

  it('wins for presence, with its own registration of kube/tools', () => {
    jest.resetModules();
    jest.doMock('../src/core/kube/tools', () => ({
      ...jest.requireActual<typeof ToolsNS>('../src/core/kube/tools'),
      which: (name: string) => `/opt/fixture/${name}`,
    }));
    const owned = require('../src/core/kube/tools') as typeof ToolsNS;
    expect(owned.which('kubectl')).toBe('/opt/fixture/kubectl');
  });

  it('wins for a launch, by stubbing the seam above the process seam', async () => {
    const real = kube.run;
    kube.run = async (argv) => ({ argv: [...argv], returncode: 0, stdout: 'v1.36.3', stderr: '' });
    try {
      expect((await kube.run(['kubectl', 'version', '--client'])).stdout).toBe('v1.36.3');
      expect(drained()).toEqual([]);
    } finally {
      kube.run = real;
    }
  });
});

/**
 * NO TEST MAY STRIP A GUARD THROUGH THE REGISTRY, except by a reviewed, reasoned exception.
 *
 * `jest.dontMock(id)` and `jest.unmock(id)` mark the id "never mock", and
 * `jest.resetModules()` does not clear that -- so a cleanup that `dontMock`s a guarded
 * module leaves every later test in its file on the unguarded real module.
 * `test/core/invariants/kube-behaviour.test.ts` did exactly that to `seams/exec` until this
 * existed. The runtime backstop makes a real LAUNCH loud; this makes the strip itself
 * impossible to land, for presence and the engine as well as for launches.
 */
const REGISTRY_EXCEPTIONS: readonly { file: string; target: string; reason: string }[] = [
  {
    file: 'test/core/runner/host.test.ts',
    target: 'host',
    reason:
      'its subject is composeVersion, which the engine fixture replaces; its docker seam ' +
      'stays its own mock, so nothing reaches a real engine',
  },
];

describe('the module registry cannot take a guard away', () => {
  it('finds no dontMock or unmock of a guarded module outside the reviewed exceptions', () => {
    const root = path.resolve(__dirname, '..');
    const specs: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.name.endsWith('.test.ts')) specs.push(absolute);
      }
    };
    walk(__dirname);
    const guarded = new Map(
      Object.entries(policy.GUARDED_MODULES).map(([name, file]) => [file, name]),
    );
    const found: string[] = [];
    for (const spec of specs) {
      const text = fs.readFileSync(spec, 'utf8');
      for (const match of text.matchAll(/jest\.(?:dontMock|unmock)\(\s*['"]([^'"]+)['"]/gu)) {
        const target = guarded.get(`${path.resolve(path.dirname(spec), match[1] ?? '')}.ts`);
        if (target === undefined) continue;
        const relative = path.relative(root, spec).split(path.sep).join('/');
        const allowed = REGISTRY_EXCEPTIONS.some(
          (row) => row.file === relative && row.target === target,
        );
        if (!allowed) found.push(`${relative} strips the ${target} guard with ${match[0]})`);
      }
    }
    expect(found).toEqual([]);
    // The exceptions must still describe the tree, or the list stops meaning anything.
    for (const row of REGISTRY_EXCEPTIONS) {
      expect(fs.existsSync(path.join(root, row.file))).toBe(true);
    }
  });
});
