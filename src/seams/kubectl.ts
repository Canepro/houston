/**
 * The one way a Kubernetes tool is launched: `kubectl`, `helm`, `kind`, `eksctl`.
 *
 * Thin, like `docker-cli`: this module knows argv, a timeout and an environment. It
 * knows nothing about contexts, ownership, namespaces or what any of those tools mean.
 * `core/kube/exec.ts` is the half that does, and it is the only module allowed to reach
 * this one -- `.dependency-cruiser.js` carries that as a rule, because "nothing bypasses
 * the seam" is a claim a gate has to make rather than a comment.
 *
 * ## It never throws, and that is this adapter's contract rather than a universal one
 *
 * A preflight that raised on a missing binary or an unreachable API server would have to
 * be wrapped at every call site, and one forgotten wrapper takes down `doctor` -- which is
 * the command someone runs precisely because things are already wrong. So a spawn failure
 * or a timeout becomes a result with `returncode: 127` carrying the reason on stderr, and
 * every caller reads a return code instead of choosing between an exception and a result.
 *
 * `runner.compose` raises for the same class of failure and the TLS adapters translate
 * it into a `ReproError`. Three contracts, deliberately, on one primitive -- see
 * `seams/exec.ts`.
 *
 * ## The result shape is the established one, on purpose
 *
 * `returncode`, `stdout` and `stderr` are the field names every reader was written
 * against. `why()` and every `classify` call read them, and code that renamed them would
 * make every comparison with an earlier release a translation.
 */
import { Interrupted, capture, type ProcessResult } from './exec';

/** What a finished Kubernetes tool reported: its argv, return code, stdout and stderr. */
export interface KubectlResult {
  readonly argv: readonly string[];
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface KubectlOptions {
  /** Unset means no timeout. `core/kube/exec.ts` applies the probe default. */
  readonly timeoutMs?: number;
  /** A replacement environment. Unset inherits the parent's. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /**
   * Written to the tool's stdin.
   *
   * `kubectl apply -f -` and `helm --values -` both read their document from stdin so
   * nothing is written to disk -- a values file carries a generated SCRAM password, and
   * a temp file is a copy of it somebody has to remember to delete.
   */
  readonly input?: string;
}

/**
 * The synthetic code a launch failure reports.
 *
 * 127 is the shell's "command not found", picked so a caller that only reads return codes
 * still sees a distinctly hopeless one rather than a 1 it might confuse with "the object is
 * not there".
 */
export const LAUNCH_FAILURE_CODE = 127;

async function invoke(argv: readonly string[], options: KubectlOptions): Promise<KubectlResult> {
  let result: ProcessResult;
  try {
    result = await capture(argv as [string, ...string[]], {
      encoding: 'utf8',
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
  } catch (error) {
    // Not a failure to report: Ctrl-C or a stopped job, which must unwind (see exec).
    if (error instanceof Interrupted) throw error;
    // A launch failure and a timeout both land here. The reason goes on stderr because
    // that is where `why()` looks for it.
    return {
      argv: [...argv],
      returncode: LAUNCH_FAILURE_CODE,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    argv: result.argv,
    // A signalled tool has no exit code. The established result held a negative number
    // there; the only thing any caller does with it is compare against zero, so a signal is
    // reported as the same hopeless code a failed launch gets rather than as success.
    returncode: result.exitCode ?? LAUNCH_FAILURE_CODE,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/**
 * The injectable callable, on an exported OBJECT rather than as a module binding.
 *
 * A test cannot replace a module-local binding in emitted TypeScript to intercept sibling
 * functions -- swc compiles an export into a non-configurable getter, so `jest.spyOn` on
 * it fails outright. Keeping the callable on one object makes the dependency injectable.
 */
export const kubectl = {
  run: (argv: readonly string[], options: KubectlOptions = {}): Promise<KubectlResult> =>
    invoke(argv, options),
};
