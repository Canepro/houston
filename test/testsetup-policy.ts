/**
 * What the suite may launch and what it may be told is installed: the rules, alone.
 *
 * `test/testsetup-cloud.ts` and `test/testsetup-engine.ts` install these; this file holds
 * only the decisions, for three reasons. A module factory may not close over anything in
 * the file that declares it, so a factory loads its rules from here. A test that took a
 * guarded module out of the registry for a scenario of its own must PUT THE GUARD BACK
 * rather than `jest.dontMock` it, and it does that with the same factory from here. And
 * `testsetup-cloud.test.ts` reads the table the guard enforces rather than a copy of it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as HostNS from '../src/core/runner/host';
import type * as ToolsNS from '../src/core/kube/tools';
import type * as ExecNS from '../src/seams/exec';

/** Every external tool the suite must treat as unreachable unless a test owns a stub. */
export const CLOUD_TOOLS: readonly string[] = Object.freeze([
  'eksctl',
  'aws',
  'kubectl',
  'helm',
  'kind',
  'docker',
]);

/**
 * The VERBS that build or destroy, which is the distinction that matters.
 *
 * `eksctl version` is a version probe and `aws sts get-caller-identity` is a question; an
 * ordinary `doctor` asks both and neither costs anything. Refusing the BINARY rather than
 * the verb broke `doctor` outright in earlier releases, because the tool probe it runs at
 * startup was caught in the same net as `eksctl create cluster`.
 */
export const SPEND_VERBS: readonly string[] = Object.freeze(['create', 'delete']);

/** Where a test that means to exercise one of these paths should stub instead. */
export const STUB_POINT: Readonly<Record<string, string>> = Object.freeze({
  eksctl: 'src/seams/aws-cli.ts (awsCli.run / awsCli.stream) or the core/eks.ts caller',
  aws: 'src/seams/aws-cli.ts (awsCli.run / awsCli.stream) or the core/eks.ts caller',
  kubectl: 'src/core/kube/exec.ts (kube.run) or src/seams/kubectl.ts',
  helm: 'src/core/kube/exec.ts (kube.run) or src/seams/kubectl.ts',
  kind: 'src/core/kube/exec.ts (kube.run) or src/seams/kubectl.ts',
  docker: 'src/seams/docker-cli.ts or the core/runner function that calls it',
});

/**
 * The modules the setup files replace, by absolute path. `testsetup-cloud.test.ts` refuses
 * any test that `jest.dontMock`s or `jest.unmock`s one of these outside `REGISTRY_EXCEPTIONS`,
 * because `dontMock` marks the id "never mock" and `jest.resetModules()` does not clear
 * that -- so the guard would stay off for the rest of the file, silently.
 */
export const GUARDED_MODULES: Readonly<Record<string, string>> = Object.freeze({
  exec: path.join(__dirname, '..', 'src', 'seams', 'exec.ts'),
  tools: path.join(__dirname, '..', 'src', 'core', 'kube', 'tools.ts'),
  host: path.join(__dirname, '..', 'src', 'core', 'runner', 'host.ts'),
});

export type LaunchVerdict = 'launch' | 'absent' | 'refuse';

export function isCloudTool(name: string): boolean {
  return CLOUD_TOOLS.includes(name);
}

/** The tool an argv names, by basename, or '' for anything that is not one of the six. */
export function toolOf(argv: readonly string[]): string {
  const name = path.basename(String(argv[0] ?? ''));
  return isCloudTool(name) ? name : '';
}

function realOrResolved(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

const TEMP_ROOT = realOrResolved(os.tmpdir());

/**
 * The PATH directories this file started with, captured ONCE per test file.
 *
 * On the sandbox global rather than in module state, because a test that calls
 * `jest.resetModules()` re-evaluates this module -- often after it has prepended a
 * directory of its own fakes to PATH, which would then be mistaken for the environment's.
 */
const AMBIENT = Symbol.for('houston.test.ambient-path');

function ambientDirectories(): ReadonlySet<string> {
  const holder = globalThis as unknown as Record<symbol, ReadonlySet<string> | undefined>;
  holder[AMBIENT] ??= new Set(
    (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((one) => one !== '')
      .map(realOrResolved),
  );
  return holder[AMBIENT];
}

/**
 * Whether a path is something a TEST built: under the temp root, and not in a directory the
 * environment already had on PATH.
 *
 * Resolved through symlinks first, so a temp directory holding a link to `/usr/bin/docker`
 * is the real docker and not a fake. Houston itself never installs a binary anywhere, so a
 * runnable `kubectl` under the temp root is either a test's scripted stand-in or a real
 * tool the ENVIRONMENT put there -- a CI runner that unpacks tools into `/tmp/bin` and adds
 * it to PATH. Only the first is a test owning its world, and the difference is exactly
 * which one was on PATH before the test ran: a test prepends its own fakes. MEASURED: with
 * the temp root alone as the rule, a logging shim placed on PATH under `/tmp` was taken for
 * a fake and let eleven real launches through.
 */
export function testOwned(candidate: string): boolean {
  const real = realOrResolved(candidate);
  const underTemp = real === TEMP_ROOT || real.startsWith(`${TEMP_ROOT}${path.sep}`);
  if (!underTemp) return false;
  const ambient = ambientDirectories();
  return !ambient.has(real) && !ambient.has(path.dirname(real));
}

/** Captures the ambient PATH now, before any test in the file can prepend to it. */
export function rememberAmbientPath(): void {
  ambientDirectories();
}

function firstOnPath(name: string, searchPath: string): string {
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return '';
}

/**
 * What happens when the suite asks to launch `argv` under `env`.
 *
 * `launch` for anything that is not one of the six, and for a scripted stand-in the test
 * built itself -- named by an absolute path under the temp root, or found first on a PATH
 * the test handed the launch explicitly. `test/seams/aws-cli.test.ts` and
 * `test/seams/docker-cli.test.ts` prove the seam spawns processes correctly by running such
 * stand-ins, and `yarn test:process-contracts` exists to keep them doing it.
 *
 * Everything else that names one of the six is the REAL tool, and the answer does not
 * depend on whether this machine has it installed: a launch with no environment of its own
 * inherits the ambient PATH, which is this box's, so it is guarded without looking. That is
 * the property the fixture exists for -- the same answer here, on a box without Docker, and
 * on a CI runner.
 */
export function launchVerdict(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): LaunchVerdict {
  const name = toolOf(argv);
  if (name === '') return 'launch';
  const file = String(argv[0]);
  if (file.includes('/')) {
    if (testOwned(file)) return 'launch';
  } else if (env !== undefined && typeof env.PATH === 'string') {
    const directories = env.PATH.split(path.delimiter).filter((one) => one !== '');
    // A PATH made ENTIRELY of directories the test created is a world the test built,
    // including the one where the tool is simply not there: `seams/docker-cli.test.ts`
    // asks what happens when no docker exists at all, and the honest answer is ENOENT.
    if (directories.length > 0 && directories.every(testOwned)) return 'launch';
    const found = firstOnPath(name, env.PATH);
    if (found !== '' && testOwned(found)) return 'launch';
  }
  return argv.slice(1).some((word) => SPEND_VERBS.includes(String(word))) ? 'refuse' : 'absent';
}

/**
 * What `which(name)` may answer: a stand-in the test built, or nothing.
 *
 * `core/kube/tools.which` is a PATH lookup that never goes near the process seam, and it
 * decides presence for twenty call sites -- `eks`, `cluster`, `context`, `endpoints`,
 * `reachability`, `preconditions`. Guarding only the launch left presence answering from
 * this machine, so eight `core/eks.test.ts` cases passed only where `aws` is installed.
 */
export function presenceVerdict(name: string, found: string): string {
  if (!isCloudTool(name)) return found;
  return found !== '' && testOwned(found) ? found : '';
}

export function unavailable(name: string): string {
  return `${name} is unavailable in the test suite`;
}

export function refusalText(name: string, argv: readonly string[], action: string): string {
  return (
    `the test suite tried to ${action} \`${name} ${argv.slice(1, 4).join(' ')}\`, which ` +
    `creates or destroys real infrastructure and bills for it. Stub ` +
    `${STUB_POINT[name] ?? 'the adapter above the process seam'} rather than the process ` +
    `seam underneath.`
  );
}

// --- the per-file record --------------------------------------------------------------

/**
 * Every refusal and every launch that got below the seam, since the last verdict.
 *
 * A RECORD, and not only an exception, because both process seams above this one catch
 * everything: `seams/kubectl.ts` turns ANY error from `capture` into `returncode: 127`
 * (earlier releases' kubectl call caught only launch failures, which is why their guard
 * could raise) and `seams/aws-cli.ts` does the same for `awsCli.run` and `awsCli.stream`. A
 * refused `eksctl create cluster` would therefore arrive at the code under test as an
 * ordinary failed build, and a test that tolerates a failed build would pass. So the
 * refusal is thrown -- nothing proceeds -- AND recorded, and the setup file fails the test
 * that made it in `afterEach`, where no catch in production can reach.
 */
const RECORD = Symbol.for('houston.test.cloud-record');

export function record(): string[] {
  const holder = globalThis as unknown as Record<symbol, string[] | undefined>;
  holder[RECORD] ??= [];
  return holder[RECORD];
}

export function verdict(when: string): void {
  const seen = record();
  if (seen.length === 0) return;
  const named = seen.splice(0);
  throw new Error(`${when} reached cloud tooling:\n  - ${named.join('\n  - ')}`);
}

// --- the module factories -----------------------------------------------------------

type Argv = ExecNS.Argv;

/** `null` keeps bytes, exactly as `runMode` reads the option. */
function encodingOf(options: { encoding?: ExecNS.TextEncoding | null }): string | null {
  return 'encoding' in options ? (options.encoding ?? null) : null;
}

function absentResult(argv: Argv): ExecNS.ProcessResult {
  return {
    argv: Object.freeze([...argv]),
    exitCode: 127,
    signal: null,
    stdout: null,
    stderr: null,
  };
}

/**
 * `launch`, `absent`, or the refusal as a REJECTED promise.
 *
 * Rejected rather than thrown: the real launchers never throw synchronously -- a bad argv or
 * timeout comes back as a rejection -- and a caller written against that contract must not
 * see a different shape from the guard than from the seam it replaces.
 */
function decide(
  argv: Argv,
  env: NodeJS.ProcessEnv | undefined,
  action: string,
): 'launch' | 'absent' | Promise<never> {
  const answer = launchVerdict(argv, env);
  if (answer !== 'refuse') return answer;
  const text = refusalText(toolOf(argv), argv, action);
  record().push(text);
  return Promise.reject(new Error(text));
}

/** `seams/exec` with the six tools ABSENT. The factory `testsetup-cloud.ts` registers. */
export function guardedExec(): typeof ExecNS {
  const actual = jest.requireActual<typeof ExecNS>('../src/seams/exec');
  return {
    ...actual,

    capture(argv: Argv, options: ExecNS.CaptureOptions = {}): Promise<ExecNS.ProcessResult> {
      const decision = decide(argv, options.env, 'run');
      if (decision === 'launch') return actual.capture(argv, options);
      if (decision !== 'absent') return decision;
      const text = unavailable(toolOf(argv));
      const as = (value: string): string | Buffer =>
        encodingOf(options) === null ? Buffer.from(value, 'utf8') : value;
      // Merged output lands on stdout and stderr becomes null, which is what `runMode`
      // does with `mergeStderr` -- a docker caller reading one stream must still see why.
      const merged = options.mergeStderr === true;
      return Promise.resolve({
        ...absentResult(argv),
        stdout: merged ? as(text) : as(''),
        stderr: merged ? null : as(text),
      });
    },

    stream(argv: Argv, options: ExecNS.StreamOptions = {}): Promise<ExecNS.ProcessResult> {
      const decision = decide(argv, options.env, 'stream');
      if (decision === 'launch') return actual.stream(argv, options);
      if (decision !== 'absent') return decision;
      const text = unavailable(toolOf(argv));
      const chunk = encodingOf(options) === null ? Buffer.from(text, 'utf8') : text;
      // The reason reaches a streaming caller the way the tool's own stderr would.
      const merged = options.mergeStderr === true;
      (merged ? options.onStdout : options.onStderr)?.(chunk);
      (merged ? options.stdoutSink : options.stderrSink)?.write(chunk);
      return Promise.resolve(absentResult(argv));
    },

    inherit(argv: Argv, options: ExecNS.InheritOptions = {}): Promise<ExecNS.ProcessResult> {
      const decision = decide(argv, options.env, 'run');
      if (decision === 'launch') return actual.inherit(argv, options);
      if (decision !== 'absent') return decision;
      return Promise.resolve(absentResult(argv));
    },

    /**
     * A detached launch has no return code to carry 127, so absence is spelled the way
     * the operating system spells it: the `SpawnFailure`/`ENOENT` a missing binary
     * produces, which `startDetached`'s contract already documents.
     */
    startDetached(
      argv: Argv,
      options: ExecNS.DetachedOptions = {},
    ): Promise<ExecNS.DetachedProcess> {
      const decision = decide(argv, options.env, 'start');
      if (decision === 'launch') return actual.startDetached(argv, options);
      if (decision !== 'absent') return decision;
      const cause = Object.assign(new Error(unavailable(toolOf(argv))), {
        code: 'ENOENT',
        errno: -2,
        syscall: 'spawn',
        path: argv[0],
      });
      return Promise.reject(new actual.SpawnFailure(argv, cause));
    },
  };
}

/** `core/kube/tools` with the six tools NOT INSTALLED, unless a test built a stand-in. */
export function guardedTools(): typeof ToolsNS {
  const actual = jest.requireActual<typeof ToolsNS>('../src/core/kube/tools');
  return {
    ...actual,
    which(name: string): string {
      return presenceVerdict(name, actual.which(name));
    },
    // `tool()` calls `which()` from inside its own module, so replacing the export of one
    // without the other would leave `tool()` answering from this machine.
    async tool(name: string): Promise<ToolsNS.Tool> {
      if (isCloudTool(name) && presenceVerdict(name, actual.which(name)) === '') {
        return actual.makeTool({ name });
      }
      return await actual.tool(name);
    },
  };
}

/** `core/runner/host` with an engine that answers healthy. */
export function healthyHost(): typeof HostNS {
  const actual = jest.requireActual<typeof HostNS>('../src/core/runner/host');
  return {
    ...actual,
    /** The daemon answers, as earlier releases' fixture had it answer. */
    dockerAvailable: (): Promise<boolean> => Promise.resolve(true),
    /** The compose plugin is v2 and recent enough for every preflight floor. */
    composeVersion: (): Promise<string | null> => Promise.resolve('2.29.0'),
    /** Docker itself, which runs healthchecks. */
    engine: () =>
      Promise.resolve({
        kind: 'docker' as const,
        version: '27.5.1',
        rootless: false,
        cgroupDriver: 'systemd',
        healthchecks: true,
        shim: false,
        kernel: '6.1.0',
        cpus: 4,
        memBytes: 8_589_934_592,
        rootDir: '/var/lib/docker',
        socket: '/var/run/docker.sock',
      }),
  };
}
