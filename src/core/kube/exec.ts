/**
 * The environments houston invokes Kubernetes tools under, and the one funnel that does.
 *
 * Tier k1. The launch itself lives in `seams/kubectl.ts`; what lives here is the policy that
 * decides WHICH client state a call may see -- which needs `names.isOurs` and
 * `config.home()`, and is therefore domain knowledge the seam must not carry.
 *
 * `kube.run` is the only thing in this package that reaches the seam, and
 * `.dependency-cruiser.js` enforces that. It never throws: see the seam's docstring.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../lib/config';
import { pathHome, joinPath } from '../../lib/home';
import { mkdirParents } from '../../lib/mkdir-parents';
import { kubectl, type KubectlResult } from '../../seams/kubectl';

import { PROBE_TIMEOUT, isOurs } from './names';

export type { KubectlResult };

/**
 * houston's OWN kubeconfig, under HOUSTON_HOME.
 *
 * `kind create cluster` writes `~/.kube/config` AND switches current-context to the
 * cluster it just made. Without this, creating a workspace would silently redirect the
 * user's own `kubectl` -- somebody working in their k3s cluster runs `houston up` and
 * their next `kubectl get pods` answers from somewhere else. That is the one way cluster
 * creation genuinely disturbs existing work, and it is not acceptable for a tool that is
 * supposed to be disposable.
 */
export function ownedKubeconfig(): string {
  // Joined component by component, a `..` kept, as every path under the home is.
  return joinPath(config.home(), 'clients', 'kubernetes', 'config');
}

/**
 * An environment whose client state cannot reach the user's home.
 *
 * Used for anything touching houston's OWN cluster. Discovery -- finding the cluster you
 * already have -- deliberately does NOT use this, because the whole point there is to
 * read the config you already set up.
 */
export function ownedEnv(): NodeJS.ProcessEnv {
  const root = joinPath(config.home(), 'clients');
  const helm = joinPath(root, 'helm');
  const kubeconfig = ownedKubeconfig();
  for (const directory of [
    path.dirname(kubeconfig),
    joinPath(helm, 'cache'),
    joinPath(helm, 'config'),
    joinPath(helm, 'data'),
    joinPath(helm, 'cache', 'repository'),
  ]) {
    // Made with their parents: 0700 on each of these, and the umask's mode on `clients/`
    // and `clients/helm`, which only ever get made as parents.
    mkdirParents(directory, 0o700);
  }
  return {
    ...process.env,
    KUBECONFIG: kubeconfig,
    HELM_CACHE_HOME: joinPath(helm, 'cache'),
    HELM_CONFIG_HOME: joinPath(helm, 'config'),
    HELM_DATA_HOME: joinPath(helm, 'data'),
    HELM_REPOSITORY_CONFIG: joinPath(helm, 'config', 'repositories.yaml'),
    HELM_REPOSITORY_CACHE: joinPath(helm, 'cache', 'repository'),
  };
}

/**
 * Helm's own state is ALWAYS houston's; the kubeconfig belongs to whoever owns the
 * cluster.
 *
 * `ownedEnv` sets both at once, and that conflation was a real defect. Every helm call
 * was either fully owned or not at all, so on a cluster houston ADOPTED the chart repo
 * went into houston's Helm home while the install that needed it read the USER's. Two
 * different repositories.yaml, and the create failed at 60% -- after the namespace, the
 * operator and MongoDB had all been built -- with `helm install failed: Error: repo
 * rocketchat not found`, then rolled the namespace back.
 *
 * So HELM_* always points at houston's directories and KUBECONFIG is left as the user
 * has it unless the cluster is ours. kubectl needs no equivalent: it has no client state
 * worth redirecting, and `own` already picks its kubeconfig.
 */
export function helmEnv(context: string): NodeJS.ProcessEnv {
  const env = ownedEnv();
  if (!isOurs(context)) {
    const outside = process.env.KUBECONFIG;
    if (outside === undefined) delete env.KUBECONFIG;
    else env.KUBECONFIG = outside;
  }
  return env;
}

/**
 * The environment for talking to a cluster houston does NOT own, or undefined.
 *
 * Undefined means "inherit unchanged", which is what every non-owned call used to do --
 * and it made houston's idea of "your kubeconfig" depend on which `kubectl` BINARY is
 * installed rather than on the kubeconfig itself.
 *
 * MEASURED, on a box where that diverges: `kubectl` was a symlink to k3s, whose embedded
 * client reads `/etc/rancher/k3s/k3s.yaml` when KUBECONFIG is unset. `aws eks
 * update-kubeconfig` had just written the cluster into `~/.kube/config`, the standard
 * path, and the two files never met -- so `--context <the arn>` was refused with a
 * message telling the operator to run the exact command they had just run. The context
 * existed, was correct, and was invisible.
 *
 * Two deliberate non-actions. An operator who has SET `KUBECONFIG` has said which files
 * they mean, and that is obeyed untouched. And a missing `~/.kube/config` is left alone
 * rather than forced, because pointing kubectl at a file that does not exist would take
 * away whatever default it does have.
 */
export function userEnv(): NodeJS.ProcessEnv | undefined {
  if (process.env.KUBECONFIG !== undefined && process.env.KUBECONFIG !== '') return undefined;
  // `.kube/config` under the user's home, handed to kubectl as `joinPath` spells it:
  // `path.join` folded a `..` in HOME, so the file checked and named was one earlier
  // releases do not use.
  const standard = joinPath(pathHome(), '.kube', 'config');
  try {
    if (!fs.statSync(standard).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return { ...process.env, KUBECONFIG: standard };
}

/**
 * The environment for talking to `context`, whoever owns it.
 *
 * ONE function, because the rule was written out at EIGHT call sites -- the owned
 * environment when the context is ours, else none -- and a fix to it reached exactly one.
 * When `userEnv` was added, `kube.run` got it and the seven places that build their own
 * subprocess -- apply, helm install and upgrade, port-forward, logs, exec in and exec out
 * -- did not. The
 * preflight would pass on an EKS context and the first `kubectl apply` would fail on the
 * same missing context the preflight had just found.
 *
 * A rule repeated at eight sites is a rule that will be fixed at one of them.
 */
export function envFor(context: string): NodeJS.ProcessEnv | undefined {
  return isOurs(context) ? ownedEnv() : userEnv();
}

export interface RunOptions {
  /** Seconds, not milliseconds. */
  readonly timeout?: number;
  /**
   * Run against houston's own client state, so nothing it does can reach or rewrite the
   * user's `~/.kube/config` or Helm homes. Never guessed at a call site: each function
   * derives it from the context it is targeting, so forgetting it is not a thing that
   * can happen.
   */
  readonly own?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** A document on stdin: `kubectl apply -f -`, `helm --values -`. */
  readonly input?: string;
}

async function run(argv: readonly string[], options: RunOptions = {}): Promise<KubectlResult> {
  const env =
    options.env !== undefined ? options.env : options.own === true ? ownedEnv() : userEnv();
  return await kubectl.run(argv, {
    timeoutMs: (options.timeout ?? PROBE_TIMEOUT) * 1000,
    ...(env !== undefined ? { env } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
}

/**
 * The injectable funnel. A property lookup is deliberately part of this boundary:
 * emitted TypeScript cannot replace a module-local binding, so every sibling calls
 * `kube.run(...)` and a test replaces the one property.
 */
export const kube = { run };
