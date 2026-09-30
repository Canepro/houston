/**
 * Infrastructure tooling is ABSENT unless a test owns a stub above the seam.
 *
 * It covers all six tools. Its reasoning is kept here rather than summarised, because both
 * halves of it are counter-intuitive and both were paid for:
 *
 * **A guard rail, not a convenience.** `eksctl create cluster` builds real infrastructure
 * and bills for it. A test that stubs the seam that USED to be right is indistinguishable
 * from one that stubs the right seam until something has been created: `create_cluster`
 * moved to a streaming runner, a test still stubbing the old seam stopped intercepting,
 * and it shelled out to REAL `eksctl` against REAL credentials. It failed for want of a
 * config, which is not a safety property.
 *
 * **ABSENT, not merely blocked, and the verb is what is refused.** `k8s.exec.run` never
 * throws -- a launch failure becomes `returncode: 127` -- so a guard that raised on a
 * read-only call escaped that catch and broke fifteen tests that were only asking a
 * question, then a sixteenth. A question therefore gets the answer every caller already
 * handles: the tool is not installed. Only `create` and `delete` are refused.
 *
 * ## Measured on this tree before it existed
 *
 * One ordinary `yarn test` executed the real tools FORTY-FIVE times: `aws sts
 * get-caller-identity` against this box's credentials, `aws configure get region`, `kubectl
 * config get-contexts` reading the real `~/.kube/config`, `kubectl --context ... get --raw
 * /readyz`, `eksctl version`, and a dozen `docker` queries against the running daemon. None
 * was a spend -- but ten tests failed on a PATH without the tools, so the suite's answer
 * depended on what this machine has installed, exactly as earlier releases' suite once did.
 *
 * ## Three layers, because each one alone has a hole that was measured
 *
 * 1. **`seams/exec`** -- where a process is launched. A question gets `127`; a spend is
 *    refused.
 * 2. **`core/kube/tools`** -- where PRESENCE is decided. `which()` is a PATH lookup that
 *    never reaches the process seam, and it decides presence for twenty call sites.
 * 3. **`node:child_process`, underneath both** -- a backstop the module registry cannot
 *    remove. `jest.dontMock` marks a module id "never mock" and `jest.resetModules()` does
 *    not clear that, so a test that swaps the exec seam for a scenario and then `dontMock`s
 *    it runs the rest of its file on the UNGUARDED real seam; `kube-behaviour.test.ts` did
 *    exactly that. Here, a real tool that reaches `child_process` runs a stand-in that
 *    prints the same "unavailable" line and exits 127 -- and the test FAILS, by name.
 *
 * A refusal is also RECORDED, and the test that made it fails in `afterEach`, because both
 * process seams above this one catch everything (see `testsetup-policy.ts`): a thrown
 * refusal would otherwise arrive as an ordinary failed build and be tolerated.
 *
 * ## A test that owns a stub still wins, structurally
 *
 * A test that means to exercise a cloud path stubs `seams/kubectl`, `core/kube/exec`,
 * `seams/aws-cli`, `seams/docker-cli` or the function above them; all of those sit ABOVE the
 * process seam, so the test never reaches the guard at all. A test that needs a tool PRESENT
 * registers its own `jest.mock` of `core/kube/tools`, which is registered after this file runs and
 * replaces this one. A test proving the seam itself runs a scripted stand-in it built under the
 * temp root, which the policy lets through by construction.
 *
 * NOT COVERED, and recorded rather than implied: a GRANDCHILD. Another program a test runs
 * -- a shell script, a second node -- is a separate process, and whatever it launches never
 * passes through this one. `child_process.exec`/`execSync` take a shell string and are not
 * wrapped; no test or production module uses them for any of the six.
 */
import type * as ChildProcessNS from 'node:child_process';

import type * as PolicyNS from './testsetup-policy';

jest.mock('../src/seams/exec', () =>
  (require('./testsetup-policy') as typeof PolicyNS).guardedExec(),
);
jest.mock('../src/core/kube/tools', () =>
  (require('./testsetup-policy') as typeof PolicyNS).guardedTools(),
);

const policy = require('./testsetup-policy') as typeof PolicyNS;
// Before any test can prepend a directory of its own fakes -- see `testOwned`.
policy.rememberAmbientPath();

// --- the backstop -------------------------------------------------------------------

interface Backstop {
  /** Re-pointed by every test file, because the module object outlives each of them. */
  note: (text: string) => void;
}
type Launcher = (...args: unknown[]) => unknown;
type PatchedModule = Record<string, Launcher> & Record<symbol, Backstop | undefined>;

const BACKSTOP = Symbol.for('houston.test.cloud-backstop');
// THE REAL MODULE OBJECT, not an import-interop copy of it: `seams/exec` reads
// `spawn` from this object at every call, and a patch on a copy would reach nothing.
const childProcess = require('node:child_process') as typeof ChildProcessNS & PatchedModule;

if (childProcess[BACKSTOP] === undefined) {
  const state: Backstop = { note: () => undefined };
  childProcess[BACKSTOP] = state;

  /** `node -e RELAY -- <file> <args...>` is how `seams/exec` merges stderr; see through it. */
  const unwrap = (file: string, args: readonly string[]): readonly string[] =>
    file === process.execPath && args[0] === '-e' && args[2] === '--'
      ? args.slice(3)
      : [file, ...args];

  const optionsOf = (rest: readonly unknown[]): { env?: NodeJS.ProcessEnv } | undefined =>
    rest.find(
      (one): one is { env?: NodeJS.ProcessEnv } =>
        typeof one === 'object' && one !== null && !Array.isArray(one),
    );

  const intercept = (name: string, real: Launcher): Launcher =>
    function backstop(this: unknown, ...call: unknown[]): unknown {
      const file = String(call[0]);
      const hasArgs = Array.isArray(call[1]);
      const args = hasArgs ? (call[1] as unknown[]).map(String) : [];
      const rest = call.slice(hasArgs ? 2 : 1);
      const argv = unwrap(file, args);
      const verdict = policy.launchVerdict(argv, optionsOf(rest)?.env);
      if (verdict === 'launch') return real.apply(this, call);
      const tool = policy.toolOf(argv);
      state.note(
        verdict === 'refuse'
          ? policy.refusalText(tool, argv, 'run')
          : `\`${argv.slice(0, 4).join(' ')}\` reached child_process.${name}, BELOW the ` +
              'process seam -- the module guard that should have answered it was removed ' +
              '(jest.dontMock/unmock) or bypassed. A stand-in ran instead of the real tool.',
      );
      const standIn = [
        '-e',
        `process.stderr.write(${JSON.stringify(policy.unavailable(tool))});process.exit(127)`,
      ];
      return real.apply(this, [process.execPath, standIn, ...rest]);
    };

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const real = childProcess[name];
    if (real !== undefined) childProcess[name] = intercept(name, real);
  }
}

(childProcess[BACKSTOP] as Backstop).note = (text: string) => {
  policy.record().push(text);
};

afterEach(() => {
  policy.verdict('this test');
});
afterAll(() => {
  policy.verdict('a hook in this file');
});
