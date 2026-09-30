/**
 * The one way `aws` and `eksctl` are launched.
 *
 * Thin, like `kubectl` and `docker-cli`: this module knows argv, a timeout, an
 * environment and whether the caller wants the output at the end or as it arrives. It
 * knows nothing about regions, accounts, tags, clusters or what any of those mean.
 * `core/eks.ts` is the half that does, and `.dependency-cruiser.js` carries "nothing
 * bypasses the seam" as a rule, because that is a claim a gate has to make rather than
 * a comment.
 *
 * ## Why a seam of its own rather than the Kubernetes one
 *
 * One funnel for two tools would be honest enough. They are separated because the two
 * have DIFFERENT CONTRACTS in the one dimension that matters for this module: an `aws`
 * call is a network round trip to somebody's account, and `eksctl create cluster` is
 * twenty minutes and real money. A seam whose only shape is "capture and return" cannot
 * express the second, and a funnel of that shape ends up bypassed with a raw `popen` for
 * exactly those two commands. `stream` is that case, inside the seam rather than beside it.
 *
 * ## It never throws
 *
 * The same contract `kubectl` has, for the same reason: `doctor` is the command
 * somebody runs precisely because things are already wrong, and a preflight that raised
 * on a missing binary would have to be wrapped at every call site. A launch failure or
 * a timeout becomes a result with `returncode: 127`, carrying the reason on stderr.
 */
import { capture, stream as streamProcess, type ProcessResult } from './exec';

/** What a finished AWS tool reported: its argv, return code, stdout and stderr. */
export interface AwsResult {
  readonly argv: readonly string[];
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AwsOptions {
  /** Unset means no timeout. `core/eks.ts` applies its own per-question defaults. */
  readonly timeoutMs?: number;
  /** A replacement environment. Unset inherits the parent's. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface AwsStreamOptions extends AwsOptions {
  /**
   * Called once per line, as it arrives.
   *
   * LINES, not chunks, and that is the whole reason this option exists rather than the
   * caller reading a stream: `cluster create` printed one line and then went silent for
   * the entire twenty-minute build, which is indistinguishable from a hang. Somebody
   * watching that has no way to tell a cluster being built from a process that has
   * stopped, and the only safe assumption -- kill it -- is the one that leaves a
   * half-built VPC behind.
   */
  readonly onLine: (line: string) => void;
}

/**
 * The synthetic code a launch failure reports.
 *
 * 127 is the shell's "command not found", and the kubectl seam picked it so a caller
 * that only reads return codes still sees a distinctly hopeless one rather than a 1 it
 * might confuse with a real refusal. Same number here, so the two seams cannot disagree.
 */
export const LAUNCH_FAILURE_CODE = 127;

function shaped(argv: readonly string[], result: ProcessResult): AwsResult {
  return {
    argv: result.argv,
    // A signalled tool has no exit code. The only thing any caller does with it is
    // compare against zero, so a signal reports the same hopeless code a failed launch
    // gets rather than success.
    returncode: result.exitCode ?? LAUNCH_FAILURE_CODE,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function failed(argv: readonly string[], error: unknown): AwsResult {
  return {
    argv: [...argv],
    returncode: LAUNCH_FAILURE_CODE,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  };
}

async function run(argv: readonly string[], options: AwsOptions = {}): Promise<AwsResult> {
  try {
    return shaped(
      argv,
      await capture(argv as [string, ...string[]], {
        encoding: 'utf8',
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      }),
    );
  } catch (error) {
    return failed(argv, error);
  }
}

/**
 * Run a long command and hand over what it says WHILE it says it.
 *
 * Both streams are merged, because eksctl writes its progress to STDERR and reading
 * only stdout would produce a silent twenty minutes with the progress on the floor.
 *
 * Lines are delivered as they arrive rather than at the end -- a progress report
 * delivered at the end is not a progress report -- and a partial last line is flushed
 * when the process exits, so the final message is not lost for want of a newline.
 */
async function streamLines(argv: readonly string[], options: AwsStreamOptions): Promise<AwsResult> {
  let pending = '';
  const take = (chunk: string | Buffer): void => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parts = pending.split('\n');
    // The last element is whatever came after the final newline: a partial line, or ''.
    // It stays in the buffer until the rest of it arrives.
    pending = parts.pop() ?? '';
    for (const line of parts) options.onLine(line);
  };

  let result: ProcessResult;
  try {
    result = await streamProcess(argv as [string, ...string[]], {
      encoding: 'utf8',
      mergeStderr: true,
      onStdout: (chunk) => take(chunk as string | Buffer),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  } catch (error) {
    if (pending !== '') options.onLine(pending);
    return failed(argv, error);
  }
  // The last line, which usually has no trailing newline and is usually the reason.
  if (pending !== '') options.onLine(pending);
  return shaped(argv, result);
}

/**
 * The injectable callables, on an exported OBJECT rather than as module bindings.
 *
 * swc compiles an export into a non-configurable getter, so `jest.spyOn` on a module
 * binding fails outright. `seams/kubectl.ts` and `core/kube/exec.ts` hang their
 * callables off an object for the same reason.
 */
export const awsCli = {
  run: (argv: readonly string[], options: AwsOptions = {}): Promise<AwsResult> =>
    run(argv, options),
  stream: (argv: readonly string[], options: AwsStreamOptions): Promise<AwsResult> =>
    streamLines(argv, options),
};
