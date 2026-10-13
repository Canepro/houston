/**
 * Which cluster, named the way kubectl names it.
 *
 * Tier k2, read-only. Contexts, distributions, and the rules for choosing between them --
 * including `planCluster`'s five-step precedence, whose step 0 never sets `create: true` on a
 * named context, because houston may only create the cluster it owns.
 */
import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import * as os from 'node:os';

import { PreflightError, ValidationError } from '../../lib/errors';

import { why } from './ask';
import { kube } from './exec';
import { CLUSTER_NAME, CONTEXT, KUBELET_SUFFIX, PROVIDER_ID_PREFIX, isOurs } from './names';
import { reach, reachAdvice, reachOk, reachWhy, reachable } from './reachability';
import { which } from './tools';

/**
 * `[every kind cluster on this machine, why the question could not be answered]`.
 *
 * kind talks to Docker, so this fails when Docker is down -- and it fails by printing to
 * stderr and exiting non-zero, which is indistinguishable from "no clusters" if only the
 * stdout is read. Returning the reason separately is what stops a stopped Docker being
 * reported as an absent cluster.
 */
export async function clusters(): Promise<[string[], string]> {
  const res = await kube.run(['kind', 'get', 'clusters'], { own: true });
  if (res.returncode !== 0) return [[], why(res)];
  return [
    res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.includes('No kind clusters')),
    '',
  ];
}

/**
 * `[context name -> the API server it points at, why the question failed]`.
 *
 * TWO CONTEXTS CAN BE ONE CLUSTER, and on EKS that is the normal case rather than an
 * oddity: `eksctl create cluster` writes `<iam-user>@<cluster>.<region>.eksctl.io` and
 * `aws eks update-kubeconfig` writes the cluster ARN, and a cluster built with one and
 * adopted with the other has both. Anything that lists CONTEXTS then lists that cluster
 * twice.
 *
 * The server URL is what settles it. Two contexts naming the same API server are the
 * same cluster whatever they are called, and it needs no probe -- the kubeconfig already
 * knows.
 */
export async function contextServers(): Promise<[Record<string, string>, string]> {
  const servers: Record<string, string> = {};
  const reasons: string[] = [];
  for (const own of [false, true]) {
    const res = await kube.run(['kubectl', 'config', 'view', '-o', 'json'], { own });
    if (res.returncode !== 0) {
      reasons.push(why(res));
      continue;
    }
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(res.stdout || '{}') as Record<string, unknown>;
    } catch {
      reasons.push('kubeconfig is not readable as JSON');
      continue;
    }
    const byName: Record<string, string> = {};
    for (const entry of (doc.clusters ?? []) as Record<string, unknown>[]) {
      const cluster = entry.cluster;
      byName[String(entry.name ?? '')] = String(
        (cluster !== null && typeof cluster === 'object'
          ? (cluster as { server?: unknown }).server
          : '') ?? '',
      );
    }
    for (const entry of (doc.contexts ?? []) as Record<string, unknown>[]) {
      const name = String(entry.name ?? '');
      const inner = entry.context;
      const target = String(
        (inner !== null && typeof inner === 'object'
          ? (inner as { cluster?: unknown }).cluster
          : '') ?? '',
      );
      const server = byName[target];
      if (name !== '' && server !== undefined && server !== '' && !(name in servers)) {
        servers[name] = server;
      }
    }
  }
  return [
    servers,
    reasons.length > 0 && Object.keys(servers).length === 0 ? reasons.join('; ') : '',
  ];
}

/**
 * `[every context this machine can name, why the question could not be answered]`.
 *
 * BOTH kubeconfigs, because `--context` may legitimately name either: the ones the user
 * set up and the one houston keeps for a cluster it created. Reading only the user's
 * would refuse `--context kind-houston-local`, which is a reasonable thing to type.
 *
 * Two answers rather than one: a kubeconfig that cannot be READ is not a kubeconfig with
 * no contexts IN it, and only one of those is safe to act on.
 */
export async function contexts(): Promise<[string[], string]> {
  const found: string[] = [];
  const reasons: string[] = [];
  for (const own of [false, true]) {
    const res = await kube.run(['kubectl', 'config', 'get-contexts', '-o', 'name'], { own });
    if (res.returncode !== 0) {
      reasons.push(why(res));
      continue;
    }
    for (const line of res.stdout.split('\n')) {
      if (line.trim() !== '') found.push(line.trim());
    }
  }
  if (found.length === 0 && reasons.length > 0) return [[], [...new Set(reasons)].join('; ')];
  return [[...new Set(found)].sort(), ''];
}

/**
 * Remove one context from whichever kubeconfig holds it. True if it is now gone.
 *
 * BOTH FILES, because houston wrote into both. `cluster create` runs `aws eks
 * update-kubeconfig`, which writes to the USER's kubeconfig -- so an entry for a cluster
 * houston built and then deleted is houston's own litter, and removing it is symmetry
 * rather than editing somebody's configuration behind their back.
 *
 * VERIFIED, not assumed. The first version returned the exit status, and `kubectl config
 * unset users.<name>` succeeds whether or not there was anything to unset -- so it
 * reported true for a context it had not touched.
 */
export async function forgetContext(context: string): Promise<boolean> {
  for (const own of [true, false]) {
    for (const [verb, target] of [
      ['delete-context', context],
      ['delete-cluster', context],
      ['unset', `users.${context}`],
    ] as const) {
      await kube.run(['kubectl', 'config', verb, target], { own });
    }
    // AND THE POINTER AT IT. `kubectl config delete-context` removes the entry and
    // leaves `current-context` naming it, so the file is left pointing at something that
    // is no longer in it. houston then reported "pointed at <arn>, which is not
    // answering" -- about a cluster that had been deleted, whose entry had been removed,
    // and which `contexts()` correctly no longer listed.
    const now = await kube.run(['kubectl', 'config', 'current-context'], { own });
    if (now.returncode === 0 && now.stdout.trim() === context) {
      await kube.run(['kubectl', 'config', 'unset', 'current-context'], { own });
    }
  }
  return !(await contexts())[0].includes(context);
}

/**
 * The context `kubectl` would use right now, or ''.
 *
 * This is the bring-your-own-cluster entry point: on a box with k3s, minikube, Docker
 * Desktop or a kubeconfig pointing at a remote cluster, this is the cluster houston
 * would work in.
 */
export async function activeContext(): Promise<string> {
  const res = await kube.run(['kubectl', 'config', 'current-context']);
  return res.returncode === 0 ? res.stdout.trim() : '';
}

/**
 * Distributions that run ON THIS MACHINE.
 *
 * It decides one thing here and it is not cosmetic: whether houston may copy its CA
 * PRIVATE KEY into a cluster Secret. That key "can mint a certificate for any name the
 * browser will trust". On a local cluster the trust boundary is this box, which already
 * holds the key at 0600. On a remote or shared one it is not, and `--domain` (which
 * needs no CA at all) is the answer there.
 */
export const LOCAL_DISTRIBUTIONS: readonly string[] = [
  'kind',
  'k3s',
  'minikube',
  'docker-desktop',
  'rke2',
];

/**
 * The distributions whose name says nothing about WHERE they run: a k3s or rke2 server is
 * as often another machine as this one.
 */
const SERVER_CHECKED: readonly string[] = ['k3s', 'rke2'];

/**
 * Whether a cluster of this distribution runs on this machine.
 *
 * Unknown answers false, deliberately. The question this gates is "may the CA key leave
 * this box", and "I do not know where this cluster is" must not come out as yes.
 *
 * FOR K3S AND RKE2 THE NAME WAS THE WHOLE ANSWER, and it is no answer at all: a `--context`
 * whose server was `https://k3s.example.net:6443` passed as local, and `--https` wrote
 * houston's CA private key into that cluster's `cert-manager/houston-ca` (measured: the
 * in-cluster key matched `ca/ca.key`). For those two the context's API server has to be
 * this machine too -- loopback, or an address one of its interfaces holds.
 */
export async function isLocalCluster(distribution: string, context = ''): Promise<boolean> {
  const name = distribution.trim().toLowerCase();
  if (!LOCAL_DISTRIBUTIONS.includes(name)) return false;
  if (!SERVER_CHECKED.includes(name)) return true;
  return await serverIsThisMachine(context);
}

/** Whether `context`'s API server is this machine. False whenever that cannot be read. */
async function serverIsThisMachine(context: string): Promise<boolean> {
  const res = await kube.run(
    [
      'kubectl',
      'config',
      'view',
      '--minify',
      ...(context === '' ? [] : ['--context', context]),
      '-o',
      'jsonpath={.clusters[0].cluster.server}',
    ],
    { own: isOurs(context) },
  );
  if (res.returncode !== 0) return false;
  let host: string;
  try {
    host = new URL(res.stdout.trim()).hostname.replace(/^\[(.*)\]$/u, '$1');
  } catch {
    return false;
  }
  if (host === 'localhost') return true;
  let addresses: string[];
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      return false;
    }
  }
  const mine = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .map((entry) => entry?.address ?? ''),
  );
  return (
    addresses.length > 0 &&
    addresses.every(
      (address) => address.startsWith('127.') || address === '::1' || mine.has(address),
    )
  );
}

/**
 * The context houston's own cluster is reachable at.
 *
 * Read back from the owned kubeconfig rather than assumed from kind's naming convention,
 * so a future kind that names contexts differently does not silently point every command
 * at nothing.
 */
export async function clusterContext(): Promise<string> {
  const res = await kube.run(['kubectl', 'config', 'current-context'], { own: true });
  const found = res.returncode === 0 ? res.stdout.trim() : '';
  return found || CONTEXT;
}

/**
 * What kind of Kubernetes this is, as a label. "unknown" is a fine answer.
 *
 * Asks the first node, because every signal lives there and one node is enough to
 * identify a distribution. Never raises: an unreachable cluster is "unknown", and a label
 * nobody branches on is not worth a failure.
 */
export async function distribution(context: string): Promise<string> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      'get',
      'nodes',
      '-o',
      'jsonpath={.items[0].spec.providerID} {.items[0].status.nodeInfo.kubeletVersion} ' +
        '{.items[0].metadata.labels.node\\.kubernetes\\.io/instance-type} ' +
        '{.items[0].metadata.name}',
    ],
    { own: isOurs(context) },
  );
  if (res.returncode !== 0) return 'unknown';
  const blob = res.stdout.split(/\s+/u).filter(Boolean).join(' ');
  for (const [prefix, name] of PROVIDER_ID_PREFIX) if (blob.includes(prefix)) return name;
  for (const [suffix, name] of KUBELET_SUFFIX) if (blob.includes(suffix)) return name;
  if (blob.includes('minikube')) return 'minikube';
  if (blob.includes('docker-desktop')) return 'docker-desktop';
  return 'unknown';
}

/**
 * Which cluster this create will use, decided before anything is written.
 *
 * The whole Kubernetes/k3s difference is ONE STEP: provisioning. With `kind` here,
 * houston creates its own cluster exactly as it always has; without it, that step is
 * skipped and the cluster `kubectl` already points at is used instead.
 *
 * `create` is the only thing any caller needs to know beyond the context: it decides what
 * a failed create may roll back (never a cluster we did not make), and whether the
 * capacity check should charge for a control plane that does not exist yet.
 */
export interface ClusterPlan {
  readonly context: string;
  readonly distribution: string;
  /** This call will bring the cluster into existence. */
  readonly create: boolean;
}

/**
 * The cluster's own name inside a context name.
 *
 * `aws eks update-kubeconfig` writes the cluster ARN as the context, so the name somebody
 * actually calls the cluster is the last path segment of it.
 *
 * AND THE OTHER SHAPE AWS WRITES. `eksctl` names its context
 * `<user>@<cluster>.<region>.eksctl.io`, which has no `/` at all -- so this returned the
 * whole forty-four-character string as the cluster's "short" name.
 */
export function shortName(context: string): string {
  if (context.endsWith('.eksctl.io') && context.includes('@')) {
    return context.split('@').slice(1).join('@').split('.')[0] ?? '';
  }
  const parts = context.split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * The remedy line for a context houston was asked for and cannot use.
 *
 * Split out because BOTH refusals need one and both used to end in advice about `aws eks
 * update-kubeconfig` -- the right hint for the case `--context` was built for, and
 * exactly the WRONG one for houston's own cluster, where the answer is to stop passing
 * `--context` at all.
 */
export function contextAdvice(context: string, { absent }: { absent: boolean }): string {
  if (context === CONTEXT) {
    if (which('kind') === '') {
      return (
        ` '${context}' is the cluster houston builds for itself, and \`kind\` is not ` +
        'installed, so it cannot be built. Install kind, or name a cluster you already have.'
      );
    }
    return (
      ` '${context}' is the cluster houston builds for itself, and a named context is ` +
      'always adopted rather than created — run `up` WITHOUT `--context` and it will be built.'
    );
  }
  if (absent) {
    return (
      ' For an EKS cluster, `aws eks update-kubeconfig --name <cluster> --region ' +
      '<region>` writes one.'
    );
  }
  return (
    ` Check that \`kubectl --context ${context} get nodes\` works; for EKS that also ` +
    'needs `aws` on PATH to mint a token.'
  );
}

/**
 * Resolve a context to its full name, or refuse. Returns `[resolved, unreadable]`.
 *
 * A CLUSTER'S OWN NAME IS ACCEPTED, not only its full context name. On EKS the context is
 * the cluster ARN, which has to be pasted on every `up`. `--context support` means the
 * same thing and is the form people actually hold in their heads. Resolved rather than
 * guessed: an exact context name always wins, a short name has to match exactly one
 * cluster, and two clusters of the same name in different regions or accounts REFUSE and
 * name both.
 *
 * The second return value is the reason `contexts()` could not answer, and it is a reason
 * rather than a refusal ON PURPOSE: "I could not read the kubeconfig" is not "that
 * context is not in it".
 */
export async function assertContextKnown(context: string): Promise<[string, string]> {
  const [known, unreadable] = await contexts();
  if (known.length === 0 || known.includes(context)) return [context, unreadable];
  const hits = known.filter((candidate) => shortName(candidate) === context);

  // TWO NAMES FOR ONE CLUSTER IS NOT AMBIGUITY. A cluster houston built has both the
  // eksctl context and the ARN, so once `shortName` learned the eksctl shape both
  // started matching and this refused the normal case with "they are different
  // clusters", which they are not. The API server settles it with no probe.
  if (hits.length > 1) {
    const [servers] = await contextServers();
    const distinct = new Set(
      hits.map((candidate) => servers[candidate]).filter((server) => server !== undefined),
    );
    if (distinct.size === 1 && Object.keys(servers).length >= hits.length) {
      const sorted = [...hits].sort();
      const best = sorted.find((candidate) => candidate.startsWith('arn:aws:eks:')) ?? sorted[0];
      return [best as string, unreadable];
    }
  }
  if (hits.length === 1) return [hits[0] as string, unreadable];
  if (hits.length > 1) {
    throw new ValidationError(
      `'${context}' names more than one cluster this machine can see: ` +
        [...hits]
          .sort()
          .map((candidate) => `'${candidate}'`)
          .join(', ') +
        '. Give the full context name — they are different clusters, and acting on the ' +
        'wrong one is not recoverable.',
    );
  }
  throw new ValidationError(
    `no kubeconfig context named '${context}'. This machine can see: ` +
      known.map((candidate) => `'${candidate}'`).join(', ') +
      '.' +
      contextAdvice(context, { absent: true }),
  );
}

/** What to use when no context was named: kind's cluster, ours, or the active one. */
async function planFromKindOrCurrent(): Promise<ClusterPlan> {
  if (which('kind') !== '') {
    // `create` is decided by whether the CLUSTER exists, never by whether this home's
    // kubeconfig happens to know about it. An earlier version required the kubeconfig to
    // name a reachable context, so a fresh HOUSTON_HOME facing an existing cluster
    // planned to CREATE one -- which charged 600 MB of capacity for a control plane
    // already running and, far worse, told a failed create's rollback that the cluster
    // was its to delete.
    //
    // AND THE PROBE'S SECOND RETURN VALUE IS NOT DISCARDED. With kind installed, Docker
    // down and a healthy k3s beside it, `clusters()` answers ([], "...") -- read as an
    // absent cluster, `create` became true, `ensureCluster` failed on `kind create
    // cluster`, and the steps that would have USED the cluster that works were never
    // reached.
    const [names, unasked] = await clusters();
    if (unasked !== '') {
      const oursNow = await clusterContext();
      if (oursNow !== '' && (await reachable(oursNow))) {
        return { context: oursNow, distribution: await distribution(oursNow), create: false };
      }
      const activeNow = await activeContext();
      if (activeNow !== '' && (await reachable(activeNow))) {
        return { context: activeNow, distribution: await distribution(activeNow), create: false };
      }
      throw new PreflightError(
        `kind is installed but could not be asked what exists (${unasked}), so houston ` +
          'cannot tell whether its cluster is there. `kubectl` is ' +
          (activeNow === ''
            ? 'not pointed at a working cluster either'
            : `pointed at '${activeNow}', which is not answering`) +
          '. Usually this is Docker not running: start it, or point kubectl at a ' +
          'cluster you already have.',
      );
    }
    return {
      context: CONTEXT,
      distribution: 'kind',
      create: !names.includes(CLUSTER_NAME),
    };
  }
  // No kind binary. Our own kubeconfig may still name a cluster that is up -- one houston
  // made before kind was uninstalled -- and that is ours to use even though we could no
  // longer create or delete it.
  const ours = await clusterContext();
  if (ours !== '' && (await reachable(ours))) {
    return { context: ours, distribution: await distribution(ours), create: false };
  }
  const active = await activeContext();
  if (active !== '' && (await reachable(active))) {
    return { context: active, distribution: await distribution(active), create: false };
  }
  throw new PreflightError(
    'kind is not installed, so houston cannot create a cluster, and `kubectl` is ' +
      (active === ''
        ? 'not pointed at one either'
        : `pointed at '${active}', which is not answering`) +
      '. Install kind, or point kubectl at a cluster you already have.',
  );
}

/**
 * Choose the cluster, probing only -- nothing here writes to the machine.
 *
 * Separate from `ensureCluster` on purpose: the write-ahead `repro.json` is written
 * before the workspace is created, so a create that refuses for want of a cluster left an
 * `incomplete` record that `list` showed as a workspace and whose port `usedPorts`
 * reserved. A pure probe can run BEFORE that write, so the refusal costs nothing.
 *
 *   0. the context asked for                           -- ADOPTS. never creates.
 *   1. a cluster houston created, if it still answers  -- ask the cluster, not `kind`
 *   2. `kind` present                                  -- create ours, as today
 *   3. whatever `kubectl` points at, if it answers     -- k3s, minikube, anything
 *   4. refuse
 *
 * Step 0 exists because steps 1-4 have no way to say "that one". With the `kind` BINARY
 * present, step 2 wins over step 3 -- MEASURED, a healthy k3s answering in 0.083 s passed
 * over for a cluster that did not exist yet.
 */
export async function planCluster(context = ''): Promise<ClusterPlan> {
  if (context !== '') {
    // NEVER `create: true` on an explicitly named context, and this is the whole safety
    // property of the cloud work rather than a nicety. `up` may bring exactly one kind of
    // cluster into existence -- the local one -- and everything else is a cluster
    // somebody else made, or one `cluster create` made on purpose, at a different
    // lifecycle, with a human watching it spend money.
    //
    // A provider BRANCH HERE would be the bug: this function is reached transitively by
    // the capacity check, so such a branch is a code path on which a CAPACITY CHECK can
    // spend twenty minutes and real money.
    const [resolved, unreadable] = await assertContextKnown(context);
    // `unreadable` deliberately does NOT refuse. The reachability probe below is the real
    // test and it answers for itself.
    const got = await reach(resolved);
    if (!reachOk(got)) {
      // NAME WHICH OF THE FOUR IT WAS. "does not answer" plus a guess at three causes was
      // the message for a cluster that was answering perfectly and refusing the
      // credential, and for one this box simply had no kubeconfig entry for.
      throw new PreflightError(
        `context '${resolved}' cannot be used: ${reachWhy(got)}` +
          (got.detail !== '' ? ` (${got.detail})` : '') +
          (unreadable !== '' ? ` (and the kubeconfig could not be listed: ${unreadable})` : '') +
          '.' +
          (reachAdvice(got, resolved) || contextAdvice(resolved, { absent: false })),
      );
    }
    return { context: resolved, distribution: await distribution(resolved), create: false };
  }
  return await planFromKindOrCurrent();
}

/**
 * `distribution(context)`, tolerating a cluster that cannot be asked.
 *
 * A thin wrapper so the ingress path can key its refusal on locality without a second
 * failure mode: an unreadable distribution answers '' and `isLocalCluster('')` is false,
 * which is the safe direction for a question about whether to create something billable.
 */
export async function distributionOf(context: string): Promise<string> {
  try {
    return await distribution(context);
  } catch {
    return '';
  }
}
