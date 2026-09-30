/**
 * Can this cluster be reached, and if not, WHY.
 *
 * Tier k2, read-only. `Reach` classifies what came back into four states, and the distinction
 * between them is the whole point: refused credentials mean the cluster is up and this is a
 * permissions problem; no kubeconfig entry is not a statement about the cluster at all; and
 * nothing answering is the only one that might mean it is gone.
 */
import { helmEnv, kube } from './exec';
import { CONTEXT, PROBE_TIMEOUT, isOurs } from './names';
import { which } from './tools';

/**
 * `reach()` answers. Four, because the probe can fail in four ways that need four
 * different things done about them, and collapsing them to a bool sent people to check a
 * healthy cluster three separate times in one day of live testing.
 */
export const REACH_OK = 'ok';
export const REACH_DENIED = 'denied';
export const REACH_NO_CONTEXT = 'no-context';
export const REACH_DOWN = 'down';

export type ReachStatus =
  typeof REACH_OK | typeof REACH_DENIED | typeof REACH_NO_CONTEXT | typeof REACH_DOWN;

/**
 * What the API server says when it is answering and refusing. EKS phrases it two ways
 * depending on which client asks -- `kubectl get --raw` gets the first, the discovery
 * client the second -- and both were observed on one cluster on the same afternoon, so
 * matching only one of them is matching none of them half the time.
 */
const DENIED_MARKS: readonly string[] = [
  'unauthorized',
  'must be logged in',
  'asked for the client to provide credentials',
  'forbidden',
  'error from server (forbidden)',
];

/**
 * What kubectl says when the kubeconfig has never heard of the context. NOT a statement
 * about the cluster: this is the answer for a perfectly healthy cluster that nobody has
 * run `aws eks update-kubeconfig` for on this box, and reading it as "the cluster is
 * down" is how `cluster delete` came to report an ACTIVE cluster as not answering.
 *
 * TWO PHRASINGS, both observed on this box on the same day: `kubectl get --raw` answers
 * `error: context "x" does not exist`, while the client-config path answers `Error in
 * configuration: context was not found for specified context: x`.
 */
const NO_CONTEXT_PATTERNS: readonly RegExp[] = [
  /context .*(?:does not exist|was not found)/u,
  /no context exists with the name/u,
];

/**
 * Whether the API server answers, and when it does not, WHY it did not.
 *
 *   REACH_OK          the cluster answered
 *   REACH_DENIED      it answered and refused us -- an RBAC or access-entry problem,
 *                     and the cluster is perfectly healthy
 *   REACH_NO_CONTEXT  this box has no kubeconfig entry for it -- also not a statement
 *                     about the cluster
 *   REACH_DOWN        nothing answered: stopped, deleted, or unroutable from here
 *
 * Only the last one means "check the cluster", and it was the only advice given for all
 * four. MEASURED, three times in one day: `cluster status` told an engineer to check an
 * ACTIVE cluster that was merely refusing them; `cluster delete` said an ACTIVE cluster
 * "is not answering" when the real cause was a fresh HOUSTON_HOME with no kubeconfig
 * entry; and the original kubeconfig-resolution defect produced an error telling the
 * reader to run the command they had just run.
 */
export interface Reach {
  readonly status: ReachStatus;
  readonly detail: string;
}

export function reachOk(value: Reach): boolean {
  return value.status === REACH_OK;
}

/** Answered, and said no. The cluster is up; the credential is the problem. */
export function reachDenied(value: Reach): boolean {
  return value.status === REACH_DENIED;
}

/** One sentence naming the actual cause, for a refusal message to carry. */
export function reachWhy(value: Reach): string {
  if (value.status === REACH_OK) return '';
  if (value.status === REACH_DENIED) {
    return (
      'it answered and refused these credentials, so the cluster is up and this is a ' +
      'permissions problem'
    );
  }
  if (value.status === REACH_NO_CONTEXT) {
    return (
      'this machine has no kubeconfig entry for it, which is not a statement about the ' + 'cluster'
    );
  }
  return 'nothing answered: it may be stopped, deleted, or unreachable from here';
}

/** What to actually do about it. Empty when there is nothing to say. */
export function reachAdvice(value: Reach, context = ''): string {
  if (value.status === REACH_DENIED) {
    return (
      ' An EKS cluster grants Kubernetes access separately from IAM: ask whoever ' +
      'created it to run `aws eks create-access-entry`, or check `kubectl auth whoami`.'
    );
  }
  if (value.status === REACH_NO_CONTEXT) {
    if (context.startsWith('arn:aws:eks:')) {
      return (
        ' For an EKS cluster, `aws eks update-kubeconfig --name <cluster> --region ' +
        '<region>` writes it.'
      );
    }
    return ' `kubectl config get-contexts` lists the ones this box knows.';
  }
  return '';
}

/** Probe the API server and classify what came back. Never raises. */
export async function reach(context = CONTEXT, timeout = PROBE_TIMEOUT): Promise<Reach> {
  const res = await kube.run(['kubectl', '--context', context, 'get', '--raw', '/readyz'], {
    own: isOurs(context),
    timeout,
  });
  if (res.returncode === 0 && res.stdout.toLowerCase().includes('ok')) {
    return { status: REACH_OK, detail: '' };
  }
  // BOTH STREAMS. kubectl writes its configuration errors to stderr and some server
  // errors to stdout, and which one carries the reason varies by subcommand -- so a
  // classifier that reads one of them misfiles the other as REACH_DOWN, which is the
  // exact conflation this type exists to end.
  const said = `${res.stderr}\n${res.stdout}`.toLowerCase();
  const lines = (res.stderr || res.stdout).trim().split('\n');
  const first = lines.length > 0 ? (lines[0] as string).trim() : '';
  for (const pattern of NO_CONTEXT_PATTERNS) {
    if (pattern.test(said)) return { status: REACH_NO_CONTEXT, detail: first };
  }
  for (const mark of DENIED_MARKS) {
    if (said.includes(mark)) return { status: REACH_DENIED, detail: first };
  }
  return { status: REACH_DOWN, detail: first };
}

/**
 * Whether the API server answers. A cluster can exist and not respond -- a stopped
 * Docker, a half-deleted cluster, a machine that just woke up.
 *
 * KEPT AS A BOOL on purpose. Most callers are resolution order, where the four-way
 * answer would be noise and the only question is whether this candidate can be used.
 * Callers that put the result in front of a person use `reach()` instead.
 */
export async function reachable(context = CONTEXT, timeout = PROBE_TIMEOUT): Promise<boolean> {
  return reachOk(await reach(context, timeout));
}

/**
 * Whether HELM can reach the cluster, and if not, what it said.
 *
 * Asked SEPARATELY from `reachable` because houston drives two clients and they do not
 * share a code path: kubectl gets `--context` and, for an adopted cluster, whatever
 * kubeconfig the user has; helm gets the same context through `helmEnv`. They can
 * disagree, and when they do the create is already four minutes in.
 *
 * Measured on this box. `~/.kube/config` held the server CA and client certificate of a
 * PREVIOUS k3s installation. kubectl was completely happy: `get ns`, `auth whoami` as
 * system:admin, the whole MongoDB phase of a create. Helm refused every call with
 * "kubernetes cluster unreachable: ... x509: certificate signed by unknown authority",
 * so `up --runtime kubernetes` built a namespace, a StatefulSet, a PersistentVolume and
 * an initiated replica set, then died at the chart and rolled all of it back. The error
 * named neither the cause nor the cure, and `doctor` said the cluster was fine --
 * because doctor only ever asked kubectl.
 *
 * Returns '' when helm is happy, else the line worth showing. `helm list` and not
 * `version`: it needs a real authenticated round trip, which is the thing in doubt.
 */
export async function helmReachable(context = CONTEXT, timeout = PROBE_TIMEOUT): Promise<string> {
  if (which('helm') === '') return ''; // a missing helm is already its own check
  // `helmEnv`, not `own`: helm's own state is always houston's while the kubeconfig
  // belongs to whoever owns the cluster -- the distinction that module exists for, and
  // the one this probe has to reproduce exactly or it would be testing a different
  // client than the create uses.
  const res = await kube.run(
    ['helm', 'list', '--kube-context', context, '-n', 'default', '--max', '1'],
    { env: helmEnv(context), timeout },
  );
  if (res.returncode === 0) return '';
  const lines = (res.stderr || res.stdout).trim().split('\n');
  const first = lines.length > 0 ? (lines[0] as string) : '';
  return first !== '' ? first.slice(0, 300) : `helm exited ${String(res.returncode)}`;
}
