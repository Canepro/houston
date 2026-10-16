/**
 * Bringing houston's OWN cluster into existence, and taking it away.
 *
 * Tier k3. The only cluster this package may create is the local one; everything else is
 * adopted. `deleteCluster` takes NO cluster parameter at all, deliberately -- it can only
 * ever mean ours, and a parameter would be an invitation to pass somebody else's.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConflictError, CreateFailedError, DockerError, PreflightError } from '../../lib/errors';
import { info, nullEmit, type Emit } from '../../lib/events';
import { requireGrant, requireOnboarded } from '../../lib/onboarding';
import { makeTempDir } from '../../lib/tempdir';
import { cleanup, sleep } from '../../seams/exec';
import { reproLock } from '../runner/locks';

import { why } from './ask';
import { workspaceNamespaces } from './capabilities';
import { clusterContext, clusters, type ClusterPlan } from './context';
import { kube, ownedEnv, ownedKubeconfig } from './exec';
import {
  APPLY_TIMEOUT,
  CLUSTER_NAME,
  CLUSTER_OWNER_CONFIGMAP,
  CONTEXT,
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
  OWNER_SELECTOR,
} from './names';
import { reachable } from './reachability';
import { which } from './tools';

/**
 * Lock name for cluster creation. Not a valid repro name (sanitisation strips the
 * underscores), so it can never collide with a workspace's own lock.
 */
export const CLUSTER_LOCK = '__cluster__';

/**
 * Creating a cluster pulls a node image on first use and waits for the control plane.
 * Nothing like the 8 s a probe gets.
 */
export const CREATE_TIMEOUT = 600.0;

export const DELETE_TIMEOUT = 120.0;

/** A cross-home Kind winner has a brief window to publish its ownership receipt. */
const MARKER_PUBLICATION_INTERVAL_MS = 500;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The immutable-in-intent receipt that lets a later process reuse or delete this cluster. */
function ownershipManifest(): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: CLUSTER_OWNER_CONFIGMAP,
      namespace: 'kube-system',
      labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE },
    },
    data: { cluster: CLUSTER_NAME },
  });
}

/** Publish ownership after creation or a granted legacy adoption. */
async function markClusterOwned(context: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const result = await kube.run(
    ['kubectl', '--context', context, '--namespace', 'kube-system', 'apply', '--filename', '-'],
    {
      timeout: APPLY_TIMEOUT,
      own: true,
      input: ownershipManifest(),
      ...(env === undefined ? {} : { env }),
    },
  );
  if (result.returncode !== 0) {
    throw new CreateFailedError(
      `cluster ${CLUSTER_NAME} ownership marker publication could not be confirmed; the cluster was left in place: ` +
        why(result),
    );
  }
}

type MarkerState = 'owned' | 'absent' | 'not-owned';

/** Transport failures can be retried only by the bounded create-collision waiter. */
class OwnershipProbeUnavailable extends DockerError {}
class KubeconfigUnavailable extends CreateFailedError {}
class CollisionProbeDeadlineElapsed extends Error {}

/** Bound each collision probe by the time left when it actually starts. */
function collisionProbeTimeout(deadline?: number): number {
  if (deadline === undefined) return APPLY_TIMEOUT;
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new CollisionProbeDeadlineElapsed();
  return Math.min(APPLY_TIMEOUT, remaining / 1000);
}

/** The exact local-cluster lifecycle outcome a caller may use for later rollback. */
export interface ClusterReceipt {
  createdHere: boolean;
}

interface ReadyCluster {
  readonly context: string;
  readonly createdHere: boolean;
}

/**
 * Read the exact ownership receipt for the selected local Kind context.
 *
 * A failed or malformed read is not evidence of ownership. Workspace labels are not that
 * receipt; the approved legacy migration consults them before it writes the receipt.
 */
async function markerState(
  context: string,
  env?: NodeJS.ProcessEnv,
  deadline?: number,
): Promise<MarkerState> {
  const result = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '--namespace',
      'kube-system',
      'get',
      'configmap',
      CLUSTER_OWNER_CONFIGMAP,
      '--ignore-not-found',
      '--output',
      'json',
    ],
    { timeout: collisionProbeTimeout(deadline), own: true, ...(env === undefined ? {} : { env }) },
  );
  if (result.returncode !== 0) {
    throw new OwnershipProbeUnavailable(
      `cluster ownership marker could not be read: ${why(result)}`,
    );
  }
  // --ignore-not-found makes an absent ConfigMap a successful empty response.
  if (result.stdout.trim() === '') return 'absent';
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new DockerError('cluster ownership marker could not be read: invalid JSON');
  }
  const payload = object(parsed);
  const metadata = object(payload?.metadata);
  const labels = object(metadata?.labels);
  const data = object(payload?.data);
  if (payload === null || metadata === null) {
    throw new DockerError('cluster ownership marker could not be read: invalid object');
  }
  return labels?.[OWNER_LABEL_KEY] === OWNER_LABEL_VALUE && data?.cluster === CLUSTER_NAME
    ? 'owned'
    : 'not-owned';
}

/** Whether an existing fixed-name cluster carries Houston's exact ownership receipt. */
async function clusterIsOurs(context: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  return (await markerState(context, env)) === 'owned';
}

/** Export a Kind kubeconfig and read its context through that exact private file. */
async function exportKubeconfig(
  kubeconfig: string,
  env: NodeJS.ProcessEnv,
  deadline?: number,
): Promise<string> {
  const exported = await kube.run(
    ['kind', 'export', 'kubeconfig', '--name', CLUSTER_NAME, '--kubeconfig', kubeconfig],
    { timeout: collisionProbeTimeout(deadline), own: true, env },
  );
  if (exported.returncode !== 0) {
    throw new KubeconfigUnavailable(
      `cluster ${CLUSTER_NAME} exists but its kubeconfig could not be read: ${why(exported)}`,
    );
  }
  const current = await kube.run(['kubectl', 'config', 'current-context'], {
    timeout: collisionProbeTimeout(deadline),
    own: true,
    env,
  });
  return current.returncode === 0 && current.stdout.trim() !== '' ? current.stdout.trim() : CONTEXT;
}

/**
 * Prove an existing fixed-name cluster before writing it into Houston's durable kubeconfig.
 *
 * The temporary directory is mode 0700 and is removed after the marker read. Its environment
 * points both Kind's explicit output and KUBECONFIG at that file, so neither the user's
 * kubeconfig nor Houston's later trusted client state can be changed by a refused cluster.
 */
function ownershipConflict(): ConflictError {
  return new ConflictError(
    `a Kind cluster named '${CLUSTER_NAME}' exists without Houston's ownership marker; ` +
      'refusing to reuse or delete it. Remove or rename that cluster yourself, then retry.',
  );
}

/** Probe through a disposable kubeconfig before Houston accepts an existing cluster. */
async function privateMarkerState(
  adopt = false,
  emit: Emit = nullEmit,
  deadline?: number,
): Promise<MarkerState> {
  const directory = makeTempDir('houston-kind-probe-');
  const kubeconfig = path.join(directory, 'config');
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  try {
    const context = await exportKubeconfig(kubeconfig, env, deadline);
    const state = await markerState(context, env, deadline);
    if (state !== 'absent' || !adopt) return state;
    const result = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        'get',
        'namespace',
        '--selector',
        OWNER_SELECTOR,
        '--output',
        'json',
      ],
      { timeout: collisionProbeTimeout(deadline), own: true, env },
    );
    if (result.returncode !== 0) {
      throw new DockerError(`legacy cluster workspaces could not be read: ${why(result)}`);
    }
    let payload: Record<string, unknown> | null;
    try {
      payload = object(JSON.parse(result.stdout) as unknown);
    } catch {
      throw new DockerError('legacy cluster workspaces could not be read: invalid JSON');
    }
    if (
      !Array.isArray(payload?.items) ||
      payload.items.some((item: unknown) => {
        const metadata = object(object(item)?.metadata);
        return typeof metadata?.name !== 'string' || metadata.name === '';
      })
    ) {
      throw new DockerError('legacy cluster workspaces could not be read: invalid namespace list');
    }
    if (payload.items.length === 0) return 'absent';
    // The held machine-scoped grant and successful labelled namespace query authorize
    // migration of this fixed-name legacy cluster, before its last workspace is removed.
    requireOnboarded();
    requireGrant('owned-cluster');
    await markClusterOwned(context, env);
    info(emit, `adopted legacy cluster ${CLUSTER_NAME} holding Houston workspaces`, {
      phase: 'provision',
    });
    return 'owned';
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Prove an existing fixed-name cluster before writing it into Houston's durable kubeconfig. */
async function verifyExistingClusterOwnership(emit: Emit): Promise<void> {
  if ((await privateMarkerState(true, emit)) !== 'owned') throw ownershipConflict();
}

/**
 * Wait only after our Kind create lost a cross-home collision. The winner can still be
 * publishing its receipt. Retry unavailable transport reads without treating them as absent;
 * an existing foreign or malformed marker remains a refusal immediately.
 */
async function waitForCollisionMarker(): Promise<void> {
  const deadline = performance.now() + CREATE_TIMEOUT * 1000;
  let unavailable: OwnershipProbeUnavailable | KubeconfigUnavailable | undefined;
  for (;;) {
    if (deadline - performance.now() <= 0) break;
    try {
      // Every external probe recomputes from this deadline, so one late export cannot
      // start a context or marker read after the winning create has had its full window.
      const state = await privateMarkerState(false, nullEmit, deadline);
      if (state === 'owned') return;
      if (state !== 'absent') throw ownershipConflict();
      unavailable = undefined;
    } catch (error) {
      if (error instanceof CollisionProbeDeadlineElapsed) break;
      if (!(error instanceof OwnershipProbeUnavailable || error instanceof KubeconfigUnavailable))
        throw error;
      unavailable = error;
    }
    const pause = Math.min(
      MARKER_PUBLICATION_INTERVAL_MS,
      Math.max(0, deadline - performance.now()),
    );
    if (pause <= 0) break;
    await sleep(pause);
  }
  if (unavailable !== undefined) throw unavailable;
  throw ownershipConflict();
}

/** Remove only a cluster this invocation created before it could leave an ownership receipt. */
async function rollbackUnmarkedCluster(): Promise<string> {
  const result = await kube.run(['kind', 'delete', 'cluster', '--name', CLUSTER_NAME], {
    timeout: DELETE_TIMEOUT,
    own: true,
  });
  return result.returncode === 0
    ? '; the unmarked cluster was rolled back'
    : `; rollback also failed: ${why(result)}`;
}

/**
 * Remove only the cluster this call created if an error reached it before the ownership
 * marker. `cleanup` keeps the rollback runnable while a Ctrl-C is unwinding, then the
 * original interruption remains the caller's result.
 */
async function failBeforeOwnershipMarker(error: unknown): Promise<never> {
  const rollback = await cleanup(async () => await rollbackUnmarkedCluster());
  if (error instanceof CreateFailedError) {
    throw new CreateFailedError(`${error.message}${rollback}`);
  }
  throw error;
}

/**
 * Create the shared kind cluster if it is not there. The caller holds the cluster lock
 * around this AND the marker that follows: a waiter released at this return saw the new
 * cluster, found no marker yet, and refused the cluster its sibling was still marking.
 */
async function createIfAbsent(
  emit: Emit,
  kubeconfig: string,
): Promise<'created' | 'existing' | 'collision'> {
  // Reuse still exports this home's private kubeconfig and is therefore the same scoped
  // local lifecycle action as creation. Check before the existing-cluster return.
  requireOnboarded();
  requireGrant('owned-cluster');
  const [listed, listError] = await clusters();
  if (listError !== '') throw new DockerError(`Kind clusters could not be read: ${listError}`);
  if (listed.includes(CLUSTER_NAME)) {
    info(emit, `checking ownership of existing cluster ${CLUSTER_NAME}`, {
      phase: 'provision',
    });
    return 'existing';
  }
  info(
    emit,
    `creating cluster ${CLUSTER_NAME} — first time on this machine, so this pulls a ` +
      'node image',
    { phase: 'provision', pct: 5 },
  );
  ownedEnv(); // make the directories before kind writes into them
  const result = await kube.run(
    ['kind', 'create', 'cluster', '--name', CLUSTER_NAME, '--kubeconfig', kubeconfig],
    { timeout: CREATE_TIMEOUT, own: true },
  );
  if (result.returncode !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    // A create that lost a race to something not holding this lock (a manual `kind
    // create`) is success, not failure.
    if (!combined.includes('already exist')) {
      // A failed process cannot prove it created a same-named cluster that appears afterwards:
      // a manual Kind invocation may have won the race. Its missing marker therefore remains a
      // refusal, rather than authority for Houston to delete it.
      throw new CreateFailedError(`could not create the cluster ${CLUSTER_NAME}: ${why(result)}`);
    }
    return 'collision';
  }
  return 'created';
}

/**
 * Create houston's cluster if it is not there, and return its context.
 *
 * Serialised with the SAME lock every other mutating operation uses, rather than a second
 * lock of its own. Two simultaneous `up`s would otherwise both see no cluster and both run
 * `kind create`, and the second fails with "node(s) already exist". The re-check inside
 * the lock means the loser of the race reuses rather than retries.
 *
 * Nothing about this touches `~/.kube/config`: `--kubeconfig` is passed explicitly AND the
 * environment is redirected, because kind writes the file it is given and also honours
 * KUBECONFIG for the context switch.
 */
export async function ensureCluster(
  emit: Emit = nullEmit,
  receipt?: ClusterReceipt,
): Promise<string> {
  if (which('kind') === '') {
    throw new PreflightError(
      'kind is not installed, so houston cannot create a cluster. Install kind, or point ' +
        'kubectl at a cluster you already have.',
    );
  }
  const ready = await reproLock(CLUSTER_LOCK, async () => await ensureClusterLocked(emit), {
    timeoutMs: CREATE_TIMEOUT * 1000,
  });
  if (receipt !== undefined) receipt.createdHere = ready.createdHere;
  return ready.context;
}

async function ensureClusterLocked(emit: Emit): Promise<ReadyCluster> {
  const kubeconfig = ownedKubeconfig();
  const create = await createIfAbsent(emit, kubeconfig);
  const createdHere = create === 'created';
  if (create === 'existing') await verifyExistingClusterOwnership(emit);
  if (create === 'collision') await waitForCollisionMarker();

  let context: string;
  try {
    // A marked cluster that outlived this home's kubeconfig needs exporting before Houston
    // can use it. The marker probe above makes this persistent write only after ownership is
    // proved; a newly created cluster is known to this invocation and is rolled back below
    // if it cannot establish that proof.
    context = await exportKubeconfig(kubeconfig, ownedEnv());
    if (!(await reachable(context))) {
      if (createdHere) {
        throw new CreateFailedError(
          `cluster ${CLUSTER_NAME} was created but its API server is not answering at '${context}'.`,
        );
      }
      throw new CreateFailedError(
        `cluster ${CLUSTER_NAME} was not created by this call and its API server is not ` +
          `answering at '${context}'. Houston left it in place.`,
      );
    }
  } catch (error) {
    if (createdHere) {
      await failBeforeOwnershipMarker(error);
    }
    throw error;
  }
  // Publication may commit even when its response fails or is interrupted. Once it
  // starts, another home can accept the receipt, so no raw rollback is safe, including
  // after a later absent or unavailable read that could race the outstanding apply.
  if (createdHere) await markClusterOwned(context);
  // The marker has been recorded. A downstream progress listener may fail, but that
  // must not turn a healthy marked cluster into a rollback candidate.
  info(emit, `cluster ${CLUSTER_NAME} ready at ${context}`, { phase: 'provision' });
  return { context, createdHere };
}

/**
 * The context to use, with houston's OWN kubeconfig guaranteed to know it.
 *
 * `ensureCluster` was called only when a cluster had to be created -- and the export must
 * happen either way. With a kind cluster already up and a fresh home, every command failed
 * with `context was not found for specified context: kind-houston-local` and could not
 * self-heal, because the only thing that writes that context ran later, or never.
 *
 * `CLAUDE.md` tells anyone writing a script to `export HOUSTON_HOME=$(mktemp -d)`, so this
 * was reachable by following our own instructions once a cluster existed.
 *
 * For a context other than the selected local Kind context there is nothing to export: the
 * user's own kubeconfig already names it, and rewriting it is not ours to do.
 */
export async function ensureKubeconfig(
  plan: ClusterPlan,
  emit: Emit = nullEmit,
  receipt?: ClusterReceipt,
): Promise<string> {
  if (plan.create || plan.context === CONTEXT) {
    // Even when this home's kubeconfig already names the context, go through
    // `ensureCluster`: the ConfigMap receipt is the proof that the fixed Kind name is
    // actually ours. Returning early would turn a readable context into ownership.
    return await ensureCluster(emit, receipt);
  }
  if (receipt !== undefined) receipt.createdHere = false;
  return plan.context;
}

/** Preserve legacy ownership before deleting a local workspace's namespace. */
export async function adoptIfUnmarked(emit: Emit = nullEmit): Promise<void> {
  requireOnboarded();
  requireGrant('owned-cluster');
  await reproLock(
    CLUSTER_LOCK,
    async () => {
      if (fs.existsSync(ownedKubeconfig())) {
        try {
          const state = await markerState(CONTEXT);
          if (state === 'owned') return;
          if (state === 'not-owned') throw ownershipConflict();
        } catch (error) {
          // An unavailable owned client can be recovered through Kind's private probe.
          // Malformed or foreign receipts remain a refusal, never a migration signal.
          if (!(error instanceof OwnershipProbeUnavailable)) throw error;
        }
      }
      // A successfully deleted cluster needs no migration; a failed list is unknown.
      const [listed, listError] = await clusters();
      if (listError !== '') throw new DockerError(`Kind clusters could not be read: ${listError}`);
      if (!listed.includes(CLUSTER_NAME)) return;
      await verifyExistingClusterOwnership(emit);
      await exportKubeconfig(ownedKubeconfig(), ownedEnv());
    },
    { timeoutMs: CREATE_TIMEOUT * 1000 },
  );
}

/**
 * Whether houston's own cluster exists and holds nothing of ours.
 *
 * UNREACHABLE IS NOT EMPTY. This used to return true for a cluster that exists and does not
 * answer, reasoning that `kind delete` talks to Docker rather than to the API server so
 * nothing stops it. That is true and it is the wrong conclusion: a control plane that
 * cannot be reached is the case where houston knows LEAST about what it would destroy. A
 * paused container, a Docker restart or a laptop resuming all produce it, and `prune` then
 * stated the cluster was "empty" and deleted it -- measured, with five Running pods and an
 * 8 Gi Bound PVC in it.
 */
export async function clusterReclaimable(): Promise<boolean> {
  if (which('kind') === '' || !(await clusters())[0].includes(CLUSTER_NAME)) return false;
  const ctx = await clusterContext();
  if (!(await reachable(ctx))) return false;
  if (!(await clusterIsOurs(ctx))) return false;
  // null (could not ask) must NOT read as "empty and therefore reclaimable".
  const held = await workspaceNamespaces(ctx);
  return held !== null && held.length === 0;
}

/**
 * Delete houston's own cluster. Returns false if there was nothing to delete.
 *
 * Refuses while any workspace namespace is still in it, unless forced. On a shared box the
 * cluster holds other people's workspaces, and `prune` reclaiming the cluster out from
 * under a colleague mid-ticket is the failure this guards -- the namespaces carry
 * `houston.io/owner`, so the refusal can say whose.
 *
 * Only ever CLUSTER_NAME. There is no parameter for which cluster to delete, because a
 * delete that can be pointed anywhere eventually is.
 */
export async function deleteCluster({
  force = false,
  emit = nullEmit,
}: { force?: boolean; emit?: Emit } = {}): Promise<boolean> {
  if (which('kind') === '') return false;
  return await reproLock(
    CLUSTER_LOCK,
    async () => {
      if (!(await clusters())[0].includes(CLUSTER_NAME)) return false;
      requireOnboarded();
      requireGrant('owned-cluster');
      const context = await clusterContext();
      // `--force` only permits removal while confirmed Houston work remains. It never
      // transforms a same-named cluster into Houston's cluster.
      if (!(await clusterIsOurs(context))) {
        throw new ConflictError(
          `a Kind cluster named '${CLUSTER_NAME}' does not carry Houston's ownership marker, ` +
            'so it will not be deleted.',
        );
      }
      // THE GUARD IS NOT INSIDE `reachable()`. It used to be, so an unreachable cluster
      // skipped the whole ownership check -- including the "could not read" refusal
      // directly below, which exists for exactly this case and could never fire in it.
      // `kind delete` talks to Docker, so unreachability was no obstacle: a paused control
      // plane holding live workspaces was deleted with one `prune --yes`.
      if (!force) {
        if (!(await reachable(context))) {
          throw new ConflictError(
            `cluster ${CLUSTER_NAME} exists but is not answering, so what it holds cannot ` +
              "be read — it may hold workspaces, including somebody else's. Start it " +
              `(\`docker start ${CLUSTER_NAME}-control-plane\`) and try again, or pass ` +
              '--force to delete it and everything in it unread.',
          );
        }
        const live = await workspaceNamespaces(context);
        if (live === null) {
          throw new ConflictError(
            `cannot tell what cluster ${CLUSTER_NAME} still holds: the namespace list ` +
              "could not be read. Refusing to delete a cluster that may hold somebody's " +
              'workspace — check the cluster, or pass --force to take it and everything in it.',
          );
        }
        if (live.length > 0) {
          throw new ConflictError(
            `cluster ${CLUSTER_NAME} still holds ${String(live.length)} workspace ` +
              `namespace(s): ${[...live].sort().slice(0, 5).join(', ')}. Remove those ` +
              'workspaces first, or pass --force to take the cluster and everything in it.',
          );
        }
      }
      info(emit, `deleting cluster ${CLUSTER_NAME}`, { phase: 'teardown' });
      const res = await kube.run(['kind', 'delete', 'cluster', '--name', CLUSTER_NAME], {
        timeout: DELETE_TIMEOUT,
        own: true,
      });
      if (res.returncode !== 0) {
        throw new DockerError(`could not delete the cluster ${CLUSTER_NAME}: ${why(res)}`);
      }
      return true;
    },
    { timeoutMs: DELETE_TIMEOUT * 1000 },
  );
}
