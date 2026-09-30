/**
 * Removing a workspace: its containers or its namespace, and its record.
 *
 * Tier 4, and named `destroy` rather than `teardown` because the module also exports a
 * function called `teardown`, and a module that shadows a symbol it has to export is
 * unreachable from the façade the moment anything imports it.
 */
import * as fs from 'node:fs/promises';

import * as config from '../../lib/config';
import { ConflictError, DockerError, ValidationError } from '../../lib/errors';
import { quotedText } from '../../lib/format';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { actor as auditActor, record as auditRecord } from '../audit';
import { detach } from '../edge/networks';
import { deregister as deregisterRoute } from '../edge/routes';
import { clearWorkspace } from '../journal';
import { deleteNamespace, namespaceFor } from '../kube/namespace';
import { MONITORING_NAMESPACE, removeMonitoring } from '../kube/monitoring';
import { removeOperator } from '../kube/operator';
import { CONTEXT as KUBE_CONTEXT, RELEASE } from '../kube/names';
import * as engine from '../runner/engine';
import { reproLock } from '../runner/locks';
import * as paths from '../runner/paths';
import { type Metadata, readMeta } from '../runner/record';
import * as topology from '../topology';

import * as naming from './naming';
import * as ownership from './ownership';
import * as preconditions from './preconditions';
import { stopPortForward } from './ready';
import { clearDefaultIf } from './state';
import { INTERACTIVE_LOCK_WAIT } from './types';

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

/**
 * Everything the namespace held that outlives it: the chart release, the operator, and
 * the cluster itself when houston made it.
 */
export async function removeTheClusterSide(
  context: string,
  emit: Emit,
  meta: Metadata,
  target: string,
  volumes: boolean,
): Promise<void> {
  if (!volumes) return;
  // AFTER the namespace, never before: deleting it took this workspace's
  // MongoDBCommunity with it while the operator was still there to clear the finalizer.
  const ns = await namespaceFor(target);
  // The GRAFANA forward, which `monitor --off` stops and this path did not. It targets a
  // deployment in `houston-system`, so unlike the workspace's own forward it survives the
  // workspace -- and it went on holding :5050 after the workspace was destroyed.
  const gpid = bag(meta.extra).grafana_pid;
  if (isTruthy(gpid)) {
    stopPortForward(Number(gpid), { namespace: MONITORING_NAMESPACE });
  }
  // RETURN DELIBERATELY NOT READ, and this is the one place on this path where that is
  // right. `removeOperator` returns false for THREE reasons -- not installed, still wanted
  // by another workspace, and a failed uninstall -- and the first two are the normal
  // outcome of a shared resource being shared.
  await removeOperator({ context, excluding: ns, emit });
  // AND the monitoring stack, which had the same hole and is far more expensive: ten pods
  // and ~840 MB left running after the workspace that asked for them was destroyed.
  await removeMonitoring({ context, excluding: ns, emit });
  // CHECKED, not assumed. Ignoring errors means a record that could not be removed -- a
  // permission problem, a file held open -- is silently left behind, and the success line
  // then says "and the local record".
  //
  // SWALLOWED, because the removal forgives EVERY failure, not just a missing
  // directory: `force: true` forgives ENOENT alone, and a rejection from a container's
  // root-owned file (EACCES) or a held-open one (EBUSY) made the warning below, the
  // default clear and `dropTheEdgeRoute` unreachable -- leaving the edge registered for a
  // namespace that is gone, which is what `dropTheEdgeRoute` exists to prevent.
  try {
    await fs.rm(paths.workspace(target), { recursive: true, force: true });
  } catch {
    // reported by the `exists` check and the warning below
  }
  if (await paths.exists(target)) {
    warn(
      emit,
      `the namespace is gone but ${paths.workspace(target)} ` +
        `could not be removed, so \`list\` will still show ` +
        `'${target}'. Remove that directory by hand.`,
      { phase: 'teardown' },
    );
  }
  // Its repair notes go too, whether or not the directory did: what they repair went with
  // the namespace, and a record removed by hand would strand them.
  clearWorkspace(target);
  await clearDefaultIf(target);
}

/**
 * The port-forwards this workspace was published on. They outlive the namespace because
 * they are processes on THIS box, not cluster objects.
 */
export async function stopTheForwards(meta: Metadata, target: string): Promise<void> {
  const extra = bag(meta.extra);
  const ns = isTruthy(extra.namespace) ? String(extra.namespace) : await namespaceFor(target);
  const pid = extra.port_forward_pid;
  if (isTruthy(pid)) {
    stopPortForward(Number(pid), { namespace: ns });
  }
  // A preset's UI forwards too, or `down` leaves 8082 bound to a namespace that no longer
  // exists -- and the NEXT workspace using that preset finds the port taken by a corpse.
  const forwards = bag(extra.scenario_forwards);
  for (const uiPid of Object.values(forwards)) {
    try {
      stopPortForward(Number(uiPid), { namespace: ns });
    } catch {
      // A malformed recorded pid: nothing to stop.
    }
  }
}

/**
 * A route left behind points at something that is gone, so the hostname 502s instead of
 * 404ing and nobody can reuse the name. After the cluster work, because a teardown that
 * could not confirm the namespace is gone has not torn the workspace down.
 */
export async function dropTheEdgeRoute(
  emit: Emit,
  target: string,
  volumes: boolean,
): Promise<void> {
  // No `detach`: that disconnects a Docker network a Kubernetes workspace does not have.
  // Deregistering is the whole of it.
  deregisterRoute(target);
  const ns = await namespaceFor(target);
  // Docker's nouns are wrong here. "containers, data volume, and record" for a workspace
  // that has a namespace and a PVC says nothing about what actually went away -- and
  // `helm uninstall` does NOT delete a PVC.
  if (volumes) {
    info(
      emit,
      `'${target}' removed — namespace ${ns}, its ` + 'PersistentVolumeClaim and the local record',
      { phase: 'done' },
    );
  } else {
    info(
      emit,
      `'${target}' down — the ${RELEASE} release is ` +
        `uninstalled; namespace ${ns} ` +
        'and its PersistentVolumeClaim are KEPT, so `up` again ' +
        'reuses the data. `down --volumes` deletes it.',
      { phase: 'done' },
    );
  }
}

/** Remove the namespace, or just stop what is in it. */
export async function teardownKubernetes(
  target: string,
  volumes: boolean,
  emit: Emit,
): Promise<Record<string, unknown>> {
  // Deliberately BELOW the confirmation, the ownership gate and the audit record: all
  // three are about whose data is being destroyed, which does not depend on the runtime.
  const meta = await readMeta(target);
  const extra = bag(meta.extra);
  const context = isTruthy(extra[config.EXTRA_CONTEXT])
    ? String(extra[config.EXTRA_CONTEXT])
    : KUBE_CONTEXT;
  await stopTheForwards(meta, target);
  const found = await deleteNamespace(target, { context, volumes, emit });
  // BRANCHED ON, at last. This value was returned to the caller as `{"found": ...}` and
  // read by nobody -- so `--volumes` deleted the local record, the shared operator and
  // the monitoring stack whatever it said.
  if (volumes && !found) {
    warn(
      emit,
      `'${target}': the namespace is not confirmed gone, so the ` +
        'local record is KEPT. Nothing else was removed -- the ' +
        'operator and any monitoring stack are untouched. Re-run ' +
        `\`houston down --name ${target} --volumes\` once ` +
        `\`kubectl get ns ${await namespaceFor(target)}\` says it is ` +
        'absent.',
      { phase: 'teardown' },
    );
    return { name: target, removed: false, found, runtime: topology.KUBERNETES };
  }
  await removeTheClusterSide(context, emit, meta, target, volumes);
  await dropTheEdgeRoute(emit, target, volumes);
  return { name: target, removed: volumes, found, runtime: topology.KUBERNETES };
}

/** Detach from the edge, bring the project down, and forget the name. */
export async function teardownCompose(target: string, volumes: boolean): Promise<void> {
  // BEFORE `down`, not after: compose cannot remove a network that still has an active
  // endpoint, and the edge attached to it is exactly that.
  await detach(target);
  if ((await engine.down(target, { volumes })) !== 0) {
    throw new DockerError(`\`docker compose down\` failed for '${target}'`);
  }
  // A route left behind points the edge at a container that no longer exists, so that
  // hostname would 502 instead of 404 -- and the name could never be reused by anyone else.
  deregisterRoute(target);
  if (volumes) {
    await paths.remove(target);
    // A note about a workspace that is gone advises work nobody can do: `doctor` kept
    // telling people to `houston ready` a workspace this had just deleted.
    clearWorkspace(target);
    await clearDefaultIf(target);
  }
}

export async function teardown(
  name: string,
  { volumes = false, confirm = false, emit = nullEmit } = {},
): Promise<Record<string, unknown>> {
  const target = await naming.resolveName(name);
  await preconditions.requireEngine(target);
  if (volumes && !confirm) {
    throw new ValidationError(
      `deleting ${quotedText(target)}'s data volume and record is irreversible - pass confirm=true`,
    );
  }
  if (volumes) {
    const [allowed, why] = await ownership.mayDestroy(target, auditActor());
    if (!allowed) {
      auditRecord('down-volumes', target, { outcome: 'denied' });
      throw new ConflictError(why);
    }
  }
  // Recorded BEFORE the work, not after: a teardown that dies half way through has still
  // destroyed containers, and that is exactly the event someone will come looking for.
  auditRecord(volumes ? 'down-volumes' : 'down', target);
  // Locked: `down` during a create races `docker compose up` and leaves orphaned
  // containers behind.
  const result = await reproLock(
    target,
    async () => {
      // The two runtimes answer DIFFERENTLY, and always did: the Kubernetes path reports
      // `found` and its own `runtime`, and says its own "done" line.
      if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
        return await teardownKubernetes(target, volumes, emit);
      }
      await teardownCompose(target, volumes);
      return null;
    },
    { timeoutMs: INTERACTIVE_LOCK_WAIT * 1000 },
  );
  if (result !== null) return result;
  info(emit, `'${target}' ${volumes ? 'removed' : 'down (data kept)'}`, { phase: 'done' });
  return { name: target, removed: volumes };
}
