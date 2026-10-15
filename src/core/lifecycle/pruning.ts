/**
 * What is safe to remove in bulk, and removing it.
 *
 * Tier 4. `prunable` decides and `prune` acts, kept apart so the GUI can show what WOULD go
 * before anything does.
 */
import * as config from '../../lib/config';
import {
  AuthorityGateError,
  ConflictError,
  DockerError,
  ReproError,
  ValidationError,
} from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { requireGrant, requireOnboarded } from '../../lib/onboarding';
import { actor as auditActor, record as auditRecord } from '../audit';
import { deregister as deregisterRoute } from '../edge/routes';
import { detach } from '../edge/networks';
import { clearWorkspace } from '../journal';
import { workspaceNamespaces } from '../kube/capabilities';
import { clusterReclaimable, deleteCluster } from '../kube/cluster';
import { planCluster } from '../kube/context';
import { kube } from '../kube/exec';
import { CONTEXT as KUBE_CONTEXT, APPLY_TIMEOUT, isOurs } from '../kube/names';
import {
  deleteNamespace,
  namespaceFor,
  namespaceOwner,
  waitNamespaceGone,
} from '../kube/namespace';
import { OPERATOR_NAMESPACE } from '../kube/operator';
import { MONITORING_NAMESPACE, removeGrafanaIngress, removeMonitoring } from '../kube/monitoring';
import { workloadExists } from '../kube/status';
import * as engine from '../runner/engine';
import { reproLock } from '../runner/locks';
import * as paths from '../runner/paths';
import { listMeta, readMeta } from '../runner/record';
import { projectStates } from '../runner/queries';
import * as topology from '../topology';

import * as ownership from './ownership';
import * as preconditions from './preconditions';
import { stopPortForward } from './ready';
import { clearDefaultIf } from './state';

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Stop before a local Kind lifecycle operation, leaving adopted clusters alone. */
function requireOwnedClusterAuthority(context: string): void {
  if (!isOurs(context)) return;
  requireOnboarded();
  requireGrant('owned-cluster');
}

/** Whether any selected workspace will mutate the local Kind cluster. */
async function targetsUseOwnedCluster(targets: readonly string[]): Promise<boolean> {
  for (const name of targets) {
    const meta = await readMeta(name);
    if (topology.ofMeta(meta) !== topology.KUBERNETES) continue;
    const extra = bag(meta.extra);
    const context = isTruthy(extra[config.EXTRA_CONTEXT])
      ? String(extra[config.EXTRA_CONTEXT])
      : KUBE_CONTEXT;
    if (isOurs(context)) return true;
  }
  return false;
}

/**
 * Names of repros that are safe to prune: not pinned and with no containers (a plain
 * `down`). Raises DockerError if docker can't be queried -- deleting on that ambiguity
 * would be destructive.
 *
 * DOCKER ONLY IF THERE IS A COMPOSE WORKSPACE TO ASK ABOUT. `requireDocker()` ran
 * unconditionally at the top, so `prune` was refused outright on a host that uses only
 * an adopted cluster and has no Docker at all -- while the loop below has asked
 * Kubernetes about Kubernetes workspaces for a while. The gate contradicted the runtime
 * it was gating.
 */
export async function prunable(): Promise<string[]> {
  const me = auditActor();
  const candidates: Awaited<ReturnType<typeof listMeta>> = [];
  for (const meta of await listMeta()) {
    // `pinned` by `isTruthy`: a hand-edited `"pinned": []` or `{}` is not a pin, and NaN is.
    // JavaScript's truthiness kept the list and the mapping and pruned the NaN.
    if (isTruthy(meta.pinned)) continue;
    const [allowed] = await ownership.mayDestroy(meta.name, me);
    if (!allowed) continue;
    candidates.push(meta);
  }
  let states: Record<string, string> | null = null;
  if (candidates.some((meta) => topology.ofMeta(meta) !== topology.KUBERNETES)) {
    await preconditions.requireDocker();
    states = await projectStates();
    if (states === null) {
      throw new DockerError(
        "couldn't query docker compose projects - not pruning (is Docker healthy?)",
      );
    }
  }
  const out: string[] = [];
  for (const meta of candidates) {
    if (topology.ofMeta(meta) === topology.KUBERNETES) {
      // ASK KUBERNETES, not Docker. "Is it down" was decided by whether a compose PROJECT
      // was running, and a Kubernetes workspace never has one -- so every Kubernetes
      // workspace looked down, including a healthy one serving traffic.
      const context = isTruthy(bag(meta.extra)[config.EXTRA_CONTEXT])
        ? String(bag(meta.extra)[config.EXTRA_CONTEXT])
        : KUBE_CONTEXT;
      let running: boolean;
      try {
        running = await workloadExists(meta.name, { context });
      } catch (error) {
        if (!(error instanceof DockerError)) throw error;
        // NOT PRUNABLE, rather than "down". `workloadExists` refuses to guess when the
        // cluster cannot be asked, and the safe reading of "I could not tell" is to leave
        // the workspace alone -- this list is a delete list. Skipped rather than raised so
        // one unreadable workspace does not stop the others being pruned.
        continue;
      }
      if (running) continue;
      out.push(meta.name);
      continue;
    }
    if (states !== null && !Object.hasOwn(states, meta.project)) out.push(meta.name);
  }
  return out;
}

/**
 * Which cluster to look for orphaned namespaces in.
 *
 * `CONTEXT` was hardcoded here, which meant that on a box using a cluster houston did not
 * create -- the whole point of the k3s path -- `prune --orphans` looked for strays in a
 * kind cluster that may not even exist, and reported none.
 */
export async function orphanContext(): Promise<string> {
  try {
    return (await planCluster()).context;
  } catch {
    // no cluster at all: nothing to sweep
    return KUBE_CONTEXT;
  }
}

/**
 * Give back houston's own cluster once nothing of ours is left in it.
 *
 * Only ever OUR cluster: `deleteCluster` takes no parameter, needs the `kind` binary, and
 * refuses while any workspace namespace remains -- so a cluster somebody else supplied
 * cannot be reached from here at all.
 *
 * Best-effort: a cluster that will not go is not a failed prune.
 */
export async function reclaimCluster(emit: Emit = nullEmit): Promise<boolean> {
  try {
    // A cluster that cannot be reclaimed (it still holds a workspace, or it is not
    // answering) is never handed to `deleteCluster`: that call gates on the grant, and a
    // gate raised here would come AFTER the selected workspaces were already removed.
    // When it can be reclaimed, check authority before entering the best-effort path so
    // a gate remains a gate instead of becoming a warning.
    if (!(await clusterReclaimable())) return false;
    requireOwnedClusterAuthority(KUBE_CONTEXT);
    return await deleteCluster({ emit });
  } catch (error) {
    if (error instanceof AuthorityGateError) throw error;
    if (error instanceof ReproError) {
      warn(emit, `the cluster was left alone: ${error.message}`, { phase: 'done' });
      return false;
    }
    // never let cleanup fail a successful prune
    return false;
  }
}

/**
 * Whether the owned cluster can be reclaimed, for the authority precheck before a prune.
 * A probe that fails (the marker could not be read, the daemon is asleep) is not a reason
 * to abort removing workspaces that do not use that cluster; `reclaimCluster` reports the
 * same failure as a warning in its own best-effort step.
 */
async function reclaimableForPrecheck(): Promise<boolean> {
  try {
    return await clusterReclaimable();
  } catch (error) {
    if (error instanceof ReproError) return false;
    throw error;
  }
}

/**
 * Namespaces labelled ours that NO local record can explain.
 *
 * A workspace whose `repro.json` is gone leaves its namespace, its pods and its
 * PersistentVolumeClaim running with nothing able to remove them. One was found holding
 * 8Gi and five CrashLoopBackOff pods with no way to reach it short of `kubectl delete
 * namespace` by hand.
 *
 * Reported, never swept automatically. On a shared cluster an unrecorded namespace may be
 * a COLLEAGUE's workspace created from their own home.
 */
export async function orphanNamespaces(context = ''): Promise<string[]> {
  const ctx = context || (await orphanContext());
  let found: string[] | null;
  try {
    found = await workspaceNamespaces(ctx);
  } catch {
    // no cluster is not an error here
    return [];
  }
  if (found === null) {
    // Could not ask. Sweeping nothing is the safe answer.
    return [];
  }
  const known = new Set<string>();
  for (const meta of await listMeta()) known.add(await namespaceFor(meta.name));
  return found.filter((ns) => !known.has(ns) && ns !== OPERATOR_NAMESPACE).sort();
}

/**
 * Namespaces whose workspace record is gone. Separate from the workspaces themselves
 * because one is removing what houston knows about and the other is removing what it has
 * lost track of.
 */
export async function sweepOrphanNamespaces(
  emit: Emit,
  force: boolean,
  stray: readonly string[],
  context = '',
): Promise<string[]> {
  const swept: string[] = [];
  // HOISTED, and that is the fix. The sweep below resolved the context properly and the
  // wait further down used the hardcoded `CONTEXT` -- so on any cluster houston did not
  // create the two disagreed and the wait read the failure as "gone".
  const ctx = context || (await orphanContext());
  if (stray.length > 0) requireOwnedClusterAuthority(ctx);
  if (stray.length > 0) {
    const me = auditActor();
    for (const ns of stray) {
      // THE LABEL IS READ, and it is the only evidence there is. A stray is by definition
      // a namespace no LOCAL record explains -- which on a shared cluster is exactly what
      // a colleague's workspace looks like.
      const owner = await namespaceOwner(ns, { context: ctx });
      if (owner === null && !force) {
        warn(
          emit,
          `cannot read who namespace ${ns} belongs to, so it is ` +
            'left alone — `--force` sweeps it unread',
          { phase: 'done' },
        );
        continue;
      }
      // NO OWNER IS NOBODY'S, NOT YOURS. A namespace made with no accounts and no
      // HOUSTON_USER carries an empty owner, and so does the caller in the same setup -- so
      // '' matched '' and another home's LIVE workspace was swept, PVC and all, without
      // --force. It cannot be attributed, which is what --force is for.
      if (owner === '' && !force) {
        warn(
          emit,
          `namespace ${ns} records no owner, so it may be another home's workspace — ` +
            'left alone. `--force` sweeps it',
          { phase: 'done' },
        );
        continue;
      }
      if (owner !== null && owner !== '' && owner !== me && !force) {
        warn(
          emit,
          `namespace ${ns} belongs to '${owner}', not to you — left ` +
            `alone. Ask ${owner}, or \`--force\` to sweep it anyway`,
          { phase: 'done' },
        );
        continue;
      }
      const res = await kube.run(
        ['kubectl', '--context', ctx, 'delete', 'namespace', ns, '--wait=false'],
        { timeout: APPLY_TIMEOUT, own: isOurs(ctx) },
      );
      if (res.returncode === 0) {
        swept.push(ns);
        info(emit, `removed orphaned namespace ${ns}`, { phase: 'done' });
      } else {
        warn(
          emit,
          `could not remove orphaned namespace ${ns}: ` +
            `${(res.stderr || '').trim().slice(0, 120)}`,
          { phase: 'done' },
        );
      }
    }
  }
  // THE SWEEP USED `--wait=false`, AND THE RECLAIM RAN IMMEDIATELY AFTER. So
  // `deleteCluster` refused -- correctly -- because the namespaces prune had just deleted
  // were still Terminating, and reclaiming the cluster took a SECOND prune twenty seconds
  // later.
  if (swept.length > 0) {
    for (const ns of swept) {
      // SAID, when it does not go. The cluster reclaim below refuses while any workspace
      // namespace remains, so dropping this answer turned the single-pass prune back into
      // the two-run behaviour it was fixed for -- silently.
      if (!(await waitNamespaceGone(ns, { context: ctx, emit }))) {
        warn(
          emit,
          `namespace ${ns} is still terminating, so the cluster is ` +
            'left alone this pass — `houston prune` again once ' +
            '`kubectl get ns` is clear.',
          { phase: 'done' },
        );
      }
    }
  }
  return swept;
}

/**
 * The same dispatch `teardown` makes, for the same reason.
 *
 * `prune` called `docker compose down` on a workspace that has no compose project, which
 * always failed -- so a Kubernetes workspace could be listed for pruning and never
 * actually pruned, and its namespace and PersistentVolumeClaim stayed on the cluster.
 */
export async function pruneKubernetes(name: string, emit: Emit, removed: string[]): Promise<void> {
  const meta = await readMeta(name);
  const extra = bag(meta.extra);
  const context = isTruthy(extra[config.EXTRA_CONTEXT])
    ? String(extra[config.EXTRA_CONTEXT])
    : KUBE_CONTEXT;
  const ns = await namespaceFor(name);
  const forwards = bag(extra.scenario_forwards);
  for (const uiPid of Object.values(forwards)) {
    try {
      await stopPortForward(Number(uiPid), { namespace: ns });
    } catch {
      // malformed recorded pid
    }
  }
  const pid = extra.port_forward_pid;
  if (isTruthy(pid)) await stopPortForward(Number(pid), { namespace: ns });
  // THE ANSWER IS READ, exactly as `teardown` reads it. This discarded it and then
  // removed the local record and reported the workspace pruned regardless.
  if (!(await deleteNamespace(name, { context, volumes: true, emit }))) {
    warn(
      emit,
      `'${name}' was NOT pruned: its namespace is not ` +
        'confirmed gone, so the record is kept. ' +
        `\`kubectl get ns ${ns}\`, then prune again.`,
      { phase: 'done' },
    );
    return;
  }
  // Same route the Kubernetes branch of `teardown` now drops, for the same reason: `prune`
  // bypasses `teardown()` entirely, so it has to do this itself or the edge is left
  // pointing at a namespace that no longer exists.
  if (isTruthy(extra.tls)) await removeGrafanaIngress(name, { context, emit });
  const grafanaPid = extra.grafana_pid;
  if (isTruthy(grafanaPid))
    await stopPortForward(Number(grafanaPid), { namespace: MONITORING_NAMESPACE });
  if (isTruthy(extra.monitoring)) await removeMonitoring({ context, excluding: ns, emit });
  deregisterRoute(name);
  await paths.remove(name);
  // Its repair notes with it, as `teardown` does: see `journal.WORKSPACE_KINDS`.
  clearWorkspace(name);
  await clearDefaultIf(name);
  removed.push(name);
  info(emit, `pruned '${name}'`, { phase: 'done' });
}

/**
 * One workspace, and the reason a failure on it must not stop the rest.
 *
 * `prune` is a bulk operation somebody runs to reclaim a box, so a single workspace that
 * will not come down has to be reported and stepped over -- stopping there would leave
 * the rest of the list untouched.
 */
export async function removeOneWorkspace(
  name: string,
  emit: Emit,
  removed: string[],
): Promise<void> {
  // THE CALLBACK'S `return` IS NOT THE FUNCTION'S. The removal returns from the FUNCTION
  // on its Kubernetes branch, on a failed `down`, and on both caught errors; only the
  // Compose success path falls through to clearing the default, `removed.push` and
  // `pruned`. Written first as bare returns inside the `reproLock` callback, every path
  // that did not throw still reported a prune -- one line after warning that the namespace
  // is not confirmed gone and the record is being KEPT.
  // `finished` says the locked block ran to its end, made explicit.
  let finished: boolean;
  try {
    finished = await reproLock(
      name,
      async () => {
        if ((await topology.ofRepro(name)) === topology.KUBERNETES) {
          // `pruneKubernetes` does its own reporting: it knows whether the namespace is
          // confirmed gone and says so on the path that keeps the record.
          await pruneKubernetes(name, emit, removed);
          return false;
        }
        // Close the backend's pooled edge connections before removing its endpoint,
        // just as teardownCompose does. A failed stop must leave this project attached.
        if ((await engine.stop(name)) !== 0) {
          warn(emit, `could not stop '${name}' - skipping`, { phase: 'done' });
          return false;
        }
        // Detach BEFORE `down`: compose cannot remove a network that still has an active
        // endpoint, and the attached edge is one.
        await detach(name);
        if ((await engine.down(name, { volumes: true })) !== 0) {
          warn(emit, `could not clean up '${name}' - skipping`, { phase: 'done' });
          return false;
        }
        // prune bypasses teardown(), so it drops the route itself or the edge is left
        // pointing at nothing.
        deregisterRoute(name);
        await paths.remove(name);
        // Under the lock, like the removal: see `journal.clearWorkspace`.
        clearWorkspace(name);
        return true;
      },
      { timeoutMs: 5000 },
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      warn(emit, `'${name}' is in use by another operation - skipping`, { phase: 'done' });
      return;
    }
    if (error instanceof DockerError) {
      // ONE UNREADABLE WORKSPACE MUST NOT END THE SWEEP. `deleteNamespace` raises
      // DockerError when the cluster cannot be asked, and only ConflictError was caught --
      // so the first unreadable workspace aborted prune entirely.
      warn(emit, `'${name}' could not be removed (${error.message}) - skipping`, {
        phase: 'done',
      });
      return;
    }
    throw error;
  }
  if (!finished) return;
  await clearDefaultIf(name);
  removed.push(name);
  info(emit, `pruned '${name}'`, { phase: 'done' });
}

export async function removeEachWorkspace(
  emit: Emit,
  removed: string[],
  targets: readonly string[],
): Promise<void> {
  for (const name of targets) {
    await removeOneWorkspace(name, emit, removed);
  }
}

/**
 * Delete every `down` workspace. `only` narrows it to a list already shown.
 *
 * THE CONFIRMATION AND THE ACTION HAD DIFFERENT TARGET LISTS. `cli.prune` computed
 * `prunable()` to print the prompt and this recomputed it after the answer, so on a
 * shared box a workspace that went `down` while somebody read the prompt was deleted
 * without ever appearing on screen.
 */
export async function prune({
  confirm = false,
  orphans = false,
  force = false,
  only = null,
  emit = nullEmit,
}: {
  confirm?: boolean;
  orphans?: boolean;
  force?: boolean;
  only?: readonly string[] | null;
  emit?: Emit;
} = {}): Promise<Record<string, unknown>> {
  let targets = await prunable();
  if (only !== null) {
    const shown = new Set(only);
    const appeared = targets.filter((target) => !shown.has(target));
    targets = targets.filter((target) => shown.has(target));
    for (const target of appeared) {
      warn(
        emit,
        `'${target}' became prunable after the list was shown and is left ` +
          'alone — run prune again to include it',
        { phase: 'done' },
      );
    }
  }
  const orphanCtx = orphans ? await orphanContext() : '';
  const stray = orphans ? await orphanNamespaces(orphanCtx) : [];
  if (targets.length === 0 && stray.length === 0) {
    // Still worth asking about the CLUSTER. With every workspace gone, houston's own kind
    // cluster is a 514 MiB control plane holding nothing -- and both the README and the
    // agent skill said `prune` reclaims it, which nothing did.
    const willReclaimOwnedCluster = await reclaimableForPrecheck();
    if (willReclaimOwnedCluster) requireOwnedClusterAuthority(KUBE_CONTEXT);
    return { targets: [], removed: [], orphans: [], cluster: await reclaimCluster(emit) };
  }
  if (!confirm) {
    throw new ValidationError(
      `prune deletes ${String(targets.length)} down repro(s) incl. data - pass confirm=true`,
    );
  }
  // Consult this before a mixed prune starts. Otherwise a denied local-cluster cleanup
  // could arrive after Compose workspaces had already been removed.
  const willReclaimOwnedCluster = await reclaimableForPrecheck();
  if (
    willReclaimOwnedCluster ||
    (await targetsUseOwnedCluster(targets)) ||
    (stray.length > 0 && isOurs(orphanCtx))
  ) {
    requireOwnedClusterAuthority(KUBE_CONTEXT);
  }
  // The NAMESPACES go in the subject too. Recording only `targets` meant a sweep that
  // deleted three namespaces and no local records wrote `- prune - system ok`, with no
  // trace anywhere of what it destroyed.
  const subject = [...targets, ...stray.map((ns) => `ns:${ns}`)].join(',');
  auditRecord('prune', subject);
  const removed: string[] = [];
  await removeEachWorkspace(emit, removed, targets);
  const swept = await sweepOrphanNamespaces(emit, force, stray, orphanCtx);
  return { targets, removed, orphans: swept, cluster: await reclaimCluster(emit) };
}
