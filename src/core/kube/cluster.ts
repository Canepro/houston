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
import { cleanup } from '../../seams/exec';
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

/** Write the receipt: after this invocation created the cluster, or adopted one. */
/** This home's own record that it owns the cluster, for the one case the cluster cannot say. */
function ownershipReceiptPath(): string {
  return path.join(path.dirname(ownedKubeconfig()), 'owned-cluster.json');
}

/** Whether this home recorded owning the cluster when it created or adopted it. */
function ownershipReceiptHeld(): boolean {
  try {
    const receipt = JSON.parse(fs.readFileSync(ownershipReceiptPath(), 'utf8')) as {
      cluster?: unknown;
    };
    return receipt.cluster === CLUSTER_NAME;
  } catch {
    return false;
  }
}

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
      `cluster ${CLUSTER_NAME} was created but its ownership marker could not be recorded: ` +
        why(result),
    );
  }
  // The in-cluster marker is the proof; this file is the same proof kept where a paused
  // control plane cannot hide it, so `--force` can still take down a wedged owned cluster.
  fs.mkdirSync(path.dirname(ownershipReceiptPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    ownershipReceiptPath(),
    `${JSON.stringify({ cluster: CLUSTER_NAME, marked_at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
}

/**
 * Whether an existing fixed-name cluster carries Houston's exact ownership receipt.
 *
 * A failed or malformed read is not evidence of ownership. This check intentionally does
 * not use namespace labels: those prove individual workspace ownership, not the cluster.
 */
async function clusterIsOurs(context: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
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
    { timeout: APPLY_TIMEOUT, own: true, ...(env === undefined ? {} : { env }) },
  );
  if (result.returncode !== 0) {
    throw new DockerError(`cluster ownership marker could not be read: ${why(result)}`);
  }
  // --ignore-not-found makes an absent ConfigMap a successful empty response.
  if (result.stdout.trim() === '') return false;
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
  return labels?.[OWNER_LABEL_KEY] === OWNER_LABEL_VALUE && data?.cluster === CLUSTER_NAME;
}

/** Export a Kind kubeconfig and read its context through that exact private file. */
async function exportKubeconfig(kubeconfig: string, env: NodeJS.ProcessEnv): Promise<string> {
  const exported = await kube.run(
    ['kind', 'export', 'kubeconfig', '--name', CLUSTER_NAME, '--kubeconfig', kubeconfig],
    { timeout: APPLY_TIMEOUT, own: true, env },
  );
  if (exported.returncode !== 0) {
    throw new CreateFailedError(
      `cluster ${CLUSTER_NAME} exists but its kubeconfig could not be read: ${why(exported)}`,
    );
  }
  const current = await kube.run(['kubectl', 'config', 'current-context'], {
    timeout: APPLY_TIMEOUT,
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
async function verifyExistingClusterOwnership(emit: Emit, lostRace: boolean): Promise<void> {
  const directory = makeTempDir('houston-kind-probe-');
  const kubeconfig = path.join(directory, 'config');
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  try {
    const context = await exportKubeconfig(kubeconfig, env);
    let ours = await clusterIsOurs(context, env);
    // Two homes have two locks and one machine-global cluster. The loser of that race got
    // "already exists" from kind while the winner was still exporting and marking; its
    // marker arrives within seconds, so wait for it rather than call the cluster foreign.
    for (let attempt = 0; !ours && lostRace && attempt < MARKER_WAIT_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, MARKER_WAIT_MS));
      ours = await clusterIsOurs(context, env);
    }
    if (!ours) {
      const holds = await holdsHoustonWorkspaces(context, env);
      if (holds === null) {
        throw new DockerError(
          `a Kind cluster named '${CLUSTER_NAME}' exists without Houston's ownership marker, ` +
            'and whether it holds houston workspaces could not be read; nothing was adopted.',
        );
      }
      if (!holds) {
        throw new ConflictError(
          `a Kind cluster named '${CLUSTER_NAME}' exists without Houston's ownership marker; ` +
            'refusing to reuse or delete it. Remove or rename that cluster yourself, then retry.',
        );
      }
      // Adopted, not refused: the grant just checked is the authority to own this cluster,
      // and its houston workspaces are the proof an earlier release made it. The marker is
      // written through the same private probe file, before anything durable knows it.
      info(
        emit,
        `adopting cluster ${CLUSTER_NAME}: an earlier houston made it, and it holds houston workspaces`,
        { phase: 'provision' },
      );
      await markClusterOwned(context, env);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** How long the loser of a cross-home create race waits for the winner's marker. */
const MARKER_WAIT_MS = 1000;
const MARKER_WAIT_ATTEMPTS = 30;

/**
 * Write the marker into a cluster an earlier houston made, if it has none, while the
 * workspace that proves its provenance still exists. `down --volumes` on the last legacy
 * workspace would otherwise delete the one namespace that proves it, and the next `up`
 * would refuse the now-empty cluster as foreign. Best effort: a cluster that is not
 * answering is reported and the teardown goes on.
 */
export async function adoptIfUnmarked(emit: Emit = nullEmit): Promise<void> {
  if (which('kind') === '' || !(await clusters())[0].includes(CLUSTER_NAME)) return;
  try {
    await verifyExistingClusterOwnership(emit, false);
  } catch (error) {
    if (error instanceof DockerError || error instanceof CreateFailedError) {
      info(emit, `the cluster's ownership could not be settled before teardown: ${error.message}`, {
        phase: 'teardown',
      });
      return;
    }
    throw error;
  }
}

/**
 * Whether a same-named cluster with no marker is one an earlier houston made. Releases
 * before the marker left none, and a person upgrading must not have to delete a cluster
 * holding their workspaces and volumes. The proof is the workspaces themselves: a
 * namespace carrying houston's owner label is written by nothing else. A refused read is
 * not a proof either way, so it adopts nothing. Read through the probe file, like the marker.
 */
async function holdsHoustonWorkspaces(
  context: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean | null> {
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
    { timeout: APPLY_TIMEOUT, own: true, env },
  );
  // A refused read is the third answer, not "none": it adopts nothing and says why.
  if (result.returncode !== 0) return null;
  try {
    const items = (JSON.parse(result.stdout) as { items?: unknown }).items;
    return Array.isArray(items) && items.length > 0;
  } catch {
    return null;
  }
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
): Promise<'created' | 'existed' | 'lost-race'> {
  // Reuse still exports this home's private kubeconfig and is therefore the same scoped
  // local lifecycle action as creation. Check before the existing-cluster return.
  requireOnboarded();
  requireGrant('owned-cluster');
  if ((await clusters())[0].includes(CLUSTER_NAME)) {
    info(emit, `checking ownership of existing cluster ${CLUSTER_NAME}`, {
      phase: 'provision',
    });
    return 'existed';
  }
  info(
    emit,
    `creating cluster ${CLUSTER_NAME} — first time on this machine, so this pulls a ` +
      'node image',
    { phase: 'provision', pct: 5 },
  );
  ownedEnv(); // make the directories before kind writes into them
  // A create that fails is left exactly as kind left it. kind removes its own nodes when a
  // create fails, and a cluster of this name that is listed afterwards is one some OTHER
  // process made meanwhile (another home, a hand-run kind); deleting it on the strength
  // of this process's failure would destroy a winner's cluster and whatever it holds.
  const result = await kube.run(
    ['kind', 'create', 'cluster', '--name', CLUSTER_NAME, '--kubeconfig', kubeconfig],
    { timeout: CREATE_TIMEOUT, own: true },
  );
  if (result.returncode !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    // A create that lost a race to something not holding this lock (another home, a
    // manual `kind create`) is not a failure; the winner's marker is waited for.
    if (!combined.includes('already exist')) {
      throw new CreateFailedError(`could not create the cluster ${CLUSTER_NAME}: ${why(result)}`);
    }
    return 'lost-race';
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
export async function ensureCluster(emit: Emit = nullEmit): Promise<string> {
  if (which('kind') === '') {
    throw new PreflightError(
      'kind is not installed, so houston cannot create a cluster. Install kind, or point ' +
        'kubectl at a cluster you already have.',
    );
  }
  return await reproLock(CLUSTER_LOCK, async () => await ensureClusterLocked(emit), {
    timeoutMs: CREATE_TIMEOUT * 1000,
  });
}

async function ensureClusterLocked(emit: Emit): Promise<string> {
  const kubeconfig = ownedKubeconfig();
  const outcome = await createIfAbsent(emit, kubeconfig);
  const createdHere = outcome === 'created';
  if (!createdHere) await verifyExistingClusterOwnership(emit, outcome === 'lost-race');

  let context: string;
  try {
    // A marked cluster that outlived this home's kubeconfig needs exporting before Houston
    // can use it. The marker probe above makes this persistent write only after ownership is
    // proved; a newly created cluster is known to this invocation and is rolled back below
    // if it cannot establish that proof.
    context = await exportKubeconfig(kubeconfig, ownedEnv());
    if (!(await reachable(context))) {
      throw new CreateFailedError(
        `cluster ${CLUSTER_NAME} was created but its API server is not answering at ` +
          `'${context}'. \`kind delete cluster --name ${CLUSTER_NAME}\` and try again.`,
      );
    }
    if (createdHere) {
      await markClusterOwned(context);
    }
  } catch (error) {
    if (createdHere) {
      await failBeforeOwnershipMarker(error);
    }
    throw error;
  }
  // The marker has been recorded. A downstream progress listener may fail, but that
  // must not turn a healthy marked cluster into a rollback candidate.
  info(emit, `cluster ${CLUSTER_NAME} ready at ${context}`, { phase: 'provision' });
  return context;
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
 * For a cluster houston did not create there is nothing to export: the user's own
 * kubeconfig already names it, and rewriting it is not ours to do.
 */
export async function ensureKubeconfig(plan: ClusterPlan, emit: Emit = nullEmit): Promise<string> {
  if (plan.create || plan.context === CONTEXT) {
    // Even when this home's kubeconfig already names the context, go through
    // `ensureCluster`: the ConfigMap receipt is the proof that the fixed Kind name is
    // actually ours. Returning early would turn a readable context into ownership.
    return await ensureCluster(emit);
  }
  return plan.context;
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
      let ours: boolean;
      try {
        ours = await clusterIsOurs(context);
      } catch (error) {
        // The marker lives in the cluster, so a control plane that is not answering cannot
        // show it. `--force` exists for exactly that cluster; this home's receipt from when
        // it created or adopted the cluster is the proof that needs no API server.
        if (!(error instanceof DockerError) || !force || !ownershipReceiptHeld()) throw error;
        info(
          emit,
          `cluster ${CLUSTER_NAME} is not answering; ownership taken from this home's receipt`,
          { phase: 'teardown' },
        );
        ours = true;
      }
      if (!ours) {
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
