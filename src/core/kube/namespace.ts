/**
 * One namespace per workspace, and the rules for taking one away.
 *
 * Tier k3. Selection is BY LABEL: `namespaceLabels` reads what the cluster says rather than
 * matching a name prefix, because a prefix match once made a namespace somebody else created
 * eligible for teardown. A namespace that cannot be CONFIRMED gone is not gone.
 */
import { ConflictError, CreateFailedError, DockerError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';
import { teamMode } from '../../lib/teammode';
import { recorded } from '../runner/record';

import { absent, answerWhy, askObject, present, require_, why } from './ask';
import { clusters } from './context';
import { kube } from './exec';
import {
  APPLY_TIMEOUT,
  CLUSTER_NAME,
  NS_GONE_INTERVAL,
  NS_GONE_TRIES,
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
  OWNER_OF_LABEL,
  OWNER_SELECTOR,
  RELEASE,
  WORKSPACE_LABEL,
  isOurs,
  mintNamespace,
} from './names';
import type { Sleep } from './replicaset';

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * The namespace this workspace's objects ACTUALLY live in.
 *
 * RECORDED, not derived, for the same reason as `projectName`: a namespace cannot be
 * renamed in place, so once objects exist the prefix that minted them is history rather
 * than a description. Deriving it everywhere meant a changed prefix would leave `down`
 * deleting a namespace that was never created while the real one kept its pods, its PVCs
 * and its port-forward.
 */
export async function namespaceFor(name: string): Promise<string> {
  return (await recorded(name, 'namespace')) || mintNamespace(name);
}

/**
 * The labels every resource houston creates carries.
 *
 * `managed-by` is what teardown selects on. `workspace` and `owner` are what make a
 * refusal specific -- "the cluster still holds 2 namespaces" is actionable only if it can
 * say whose.
 */
export function labelsFor(name: string, owner = ''): Record<string, string> {
  const out: Record<string, string> = {
    [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE,
    [WORKSPACE_LABEL]: name,
  };
  if (owner !== '') out[OWNER_OF_LABEL] = owner;
  return out;
}

/**
 * Explain why a namespace owned by another user cannot be adopted.
 *
 * `owner` EMPTY IS NOT A MATCH. This was `heldBy && owner && ...`, so a box with no
 * accounts -- where the CLI actor is '' because team mode is opt-in -- skipped the
 * comparison entirely and adopted a namespace stamped with somebody else's name. Found by
 * doing it on a live cluster: the label survived and Rocket.Chat was installed into their
 * namespace anyway.
 *
 * Not knowing who you are is not evidence that you are the owner. And TEAM MODE OFF IS
 * NOT THE SAME AS THE VARIABLE BEING UNSET: on a box with accounts the message said
 * "HOUSTON_USER is not set" while it WAS, and the remedy it named produced the identical
 * refusal.
 */
function refuseForeignOwner(ns: string, heldBy: string, owner: string): never {
  let mine: string;
  let remedy: string;
  if (owner !== '') {
    mine = `you are '${owner}'`;
    remedy =
      `Use a different --name, or identify yourself with \`HOUSTON_USER=${heldBy} ` +
      'houston ...` if it is yours';
  } else if (teamMode()) {
    mine = 'houston cannot tell who you are, because HOUSTON_USER is not set';
    remedy =
      `Use a different --name, or identify yourself with \`HOUSTON_USER=${heldBy} ` +
      'houston ...` if it is yours';
  } else {
    mine =
      'this box has no houston accounts, so it has no way to say who you are — ' +
      'HOUSTON_USER alone is not enough, because names are only honoured once accounts exist';
    remedy =
      `Use a different --name, or make the account and claim it: \`houston users add ` +
      `${heldBy}\` then \`HOUSTON_USER=${heldBy} houston ...\``;
  }
  throw new ConflictError(
    `namespace ${ns} belongs to '${heldBy}' on this cluster and ${mine}. Adopting it ` +
      `would make \`down --volumes\` delete their data. ${remedy}`,
  );
}

/** Raise unless `labels` prove this namespace is this workspace's. */
export function refuseForeignNamespace(
  ns: string,
  name: string,
  labels: Record<string, string>,
  owner: string,
): void {
  if (labels[OWNER_LABEL_KEY] !== OWNER_LABEL_VALUE) {
    throw new ConflictError(
      `namespace ${ns} already exists and is not managed by houston, so it will not be ` +
        'adopted -- `down --volumes` deletes a namespace and its volumes, and houston ' +
        'cannot tell a namespace an older houston made from one somebody else made. Use ' +
        `a different --name, or delete it yourself first: kubectl delete namespace ${ns}`,
    );
  }
  const theirs = labels[WORKSPACE_LABEL] ?? '';
  if (theirs !== '' && theirs !== name) {
    throw new ConflictError(
      `namespace ${ns} belongs to houston workspace '${theirs}', not '${name}'. Two ` +
        'workspaces cannot share a namespace; use a different --name',
    );
  }
  const heldBy = labels[OWNER_OF_LABEL] ?? '';
  if (heldBy !== '' && heldBy !== owner) refuseForeignOwner(ns, heldBy, owner);
}

function metadataOf(doc: Record<string, unknown> | null): Record<string, unknown> {
  const meta = doc?.metadata;
  return meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}

function phaseOf(doc: Record<string, unknown> | null): string {
  const status = doc?.status;
  const phase =
    status !== null && typeof status === 'object'
      ? (status as { phase?: unknown }).phase
      : undefined;
  return String(phase ?? '');
}

/**
 * A namespace's labels, null if it does not exist -- and RAISES if the cluster could not
 * be asked.
 *
 * The three answers are different and were being collapsed into two. "I asked and it is
 * not there" is safe to act on; "I could not ask" is not, and a wrong kube-context, an
 * expired credential or an RBAC denial all produce the second while looking like the
 * first.
 *
 * NO LONGER MATCHED ON THE SERVER'S PROSE: `--ignore-not-found` makes the API server
 * state absence in the PAYLOAD, so there is no wording to get wrong.
 */
export async function namespaceLabels(
  ns: string,
  { context }: { context: string },
): Promise<Record<string, string> | null> {
  const seen = require_(await askObject('namespace', ns, { context }), `namespace ${ns}`, {
    context,
  });
  if (absent(seen)) return null;
  const labels = metadataOf(present(seen) ? seen.doc : null).labels;
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) out[String(key)] = String(value);
  return out;
}

/**
 * Who a namespace says it belongs to. `''` = it names nobody. null = unreadable.
 *
 * THREE ANSWERS, because the caller is `prune --orphans`, which deletes. Collapsing "it
 * names nobody" and "I could not read it" into one empty string is what makes a
 * colleague's namespace look unowned, and the label is the only evidence there is that
 * somebody else made it -- their `repro.json` is on their machine, not here.
 *
 * A namespace that is GONE answers `''` rather than null, and the distinction is the
 * point: nobody owns a namespace that does not exist, and deleting it is a no-op -- so
 * that case must not be treated as the unreadable one, or a namespace that vanished
 * between the listing and the sweep would block the sweep.
 */
export async function namespaceOwner(
  ns: string,
  { context }: { context: string },
): Promise<string | null> {
  let labels: Record<string, string> | null;
  try {
    labels = await namespaceLabels(ns, { context });
  } catch {
    return null; // could not ask: the only null answer
  }
  if (labels === null) return ''; // asked, and it is not there
  return labels[OWNER_OF_LABEL] ?? '';
}

/**
 * Refuse now if this workspace's namespace belongs to somebody else.
 *
 * A PREFLIGHT, so it runs before the write-ahead `repro.json`. A refusal that created
 * nothing should leave nothing behind, and a refused create once left an `incomplete`
 * record that `prune` then offered to delete.
 *
 * IT ALSO READS THE PHASE. A namespace that is `Terminating` still carries its labels, so
 * an ownership-only check passed and the create died several steps later on "unable to
 * create new content in namespace X because it is being terminated" -- at exit 7, after
 * emitting "namespace X" as a completed step for a namespace it had not created. The
 * everyday trigger is `down --volumes` followed by re-creating under the same ticket name.
 *
 * Refused rather than waited out: a finalizer can wedge indefinitely, and a preflight that
 * sometimes blocks for a minute is a worse contract than one that says retry.
 */
export async function assertNamespaceAvailable(
  name: string,
  { context, owner = '' }: { context: string; owner?: string },
): Promise<void> {
  const ns = await namespaceFor(name);
  const seen = require_(await askObject('namespace', ns, { context }), `namespace ${ns}`, {
    context,
  });
  if (absent(seen)) return;
  const doc = present(seen) ? seen.doc : null;
  if (phaseOf(doc) === 'Terminating') {
    throw new ConflictError(
      `namespace ${ns} is still Terminating, so nothing can be created in it yet. ` +
        `Kubernetes will finish on its own -- \`kubectl get ns ${ns}\` shows when -- then ` +
        'run this again. A workspace just torn down with `--volumes` takes a few seconds to go.',
    );
  }
  const labels = metadataOf(doc).labels;
  const flat: Record<string, string> = {};
  if (labels !== null && typeof labels === 'object' && !Array.isArray(labels)) {
    for (const [key, value] of Object.entries(labels)) flat[String(key)] = String(value);
  }
  refuseForeignNamespace(ns, name, flat, owner);
}

/**
 * Create the workspace's namespace with its ownership labels.
 *
 * REFUSES A NAMESPACE THAT IS NOT OURS. This used to create (ignoring the result, so an
 * existing one was fine) and then label `--overwrite` whatever was there -- which stamped
 * houston's ownership onto a namespace it did not make, after which `down --volumes` would
 * delete it and its PVCs. The realistic trigger is not a stranger: it is two houston users
 * on one adopted cluster.
 *
 * An UNLABELLED namespace is refused too, and that is a deliberate change of intent:
 * houston cannot tell one an older houston made from somebody else's, and being wrong
 * deletes data.
 */
export async function ensureNamespace(
  name: string,
  { context, owner = '', emit = nullEmit }: { context: string; owner?: string; emit?: Emit },
): Promise<string> {
  const ns = await namespaceFor(name);
  const existing = await namespaceLabels(ns, { context });
  if (existing !== null) {
    refuseForeignNamespace(ns, name, existing, owner);
  } else {
    await kube.run(['kubectl', '--context', context, 'create', 'namespace', ns], {
      timeout: APPLY_TIMEOUT,
      own: isOurs(context),
    });
  }
  const labels = Object.entries(labelsFor(name, owner)).map(([key, value]) => `${key}=${value}`);
  const res = await kube.run(
    ['kubectl', '--context', context, 'label', 'namespace', ns, ...labels, '--overwrite'],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    throw new CreateFailedError(
      `could not label namespace ${ns}: ${why(res)} — without the label it would be ` +
        'invisible to teardown',
    );
  }
  info(emit, `created namespace ${ns}`, { phase: 'provision' });
  return ns;
}

/**
 * PVCs belonging to a workspace, so `prune` can prove what it reclaimed.
 *
 * Still `[]` on a refused read, and deliberately: the one caller uses this to say how many
 * volumes are about to go, so being wrong understates a count in a message. Nothing
 * branches on it. Named here so the next reader knows it was considered rather than missed.
 */
export async function workspacePvcs(
  name: string,
  { context }: { context: string },
): Promise<string[]> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      await namespaceFor(name),
      'get',
      'pvc',
      '-l',
      OWNER_SELECTOR,
      '-o',
      'name',
    ],
    { own: isOurs(context) },
  );
  if (res.returncode !== 0) return [];
  return res.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parts = line.split('/');
      return (parts[parts.length - 1] ?? '').trim();
    });
}

/** Whether an unreachable namespace belonged to a provably deleted cluster. */
async function clusterLossProvesNamespaceAbsent(
  ns: string,
  context: string,
  emit: Emit,
): Promise<boolean> {
  if (isOurs(context)) {
    const [names, probeFailed] = await clusters();
    if (probeFailed === '' && !names.includes(CLUSTER_NAME)) {
      info(
        emit,
        `cluster '${CLUSTER_NAME}' no longer exists, so namespace ${ns} went with it — ` +
          'removing the local record',
        { phase: 'teardown' },
      );
      return true;
    }
  }
  return false;
}

/** Delete a namespace and confirm that its pods and volumes are gone. */
async function deleteNamespaceAndVolumes(
  name: string,
  ns: string,
  context: string,
  own: boolean,
  emit: Emit,
  sleep: Sleep,
): Promise<boolean> {
  const pvcs = await workspacePvcs(name, { context });
  info(emit, `deleting namespace ${ns}: ${String(pvcs.length)} volume(s), pods and the release`, {
    phase: 'teardown',
    pct: 10,
  });
  const res = await kube.run(
    ['kubectl', '--context', context, 'delete', 'namespace', ns, '--wait=false'],
    { timeout: APPLY_TIMEOUT, own },
  );
  if (res.returncode !== 0) throw new DockerError(`could not delete namespace ${ns}: ${why(res)}`);

  let seen = null as Awaited<ReturnType<typeof askObject>> | null;
  for (let attempt = 0; attempt < NS_GONE_TRIES; attempt += 1) {
    seen = await askObject('namespace', ns, { context });
    if (absent(seen)) {
      info(emit, `namespace ${ns} and its volume(s) are gone`, { phase: 'teardown', pct: 100 });
      return true;
    }
    if (present(seen)) {
      const phase = phaseOf(seen.doc) || 'Terminating';
      if (attempt % 4 === 0) {
        info(emit, `namespace ${ns} is ${phase} — waiting for the pods and volume(s) to go`, {
          phase: 'teardown',
          pct: Math.min(90, 20 + attempt * 5),
        });
      }
    } else if (attempt % 4 === 0) {
      info(emit, `cannot reach cluster '${context}' to confirm ${ns} is gone — still trying`, {
        phase: 'teardown',
        pct: Math.min(90, 20 + attempt * 5),
      });
    }
    await sleep(NS_GONE_INTERVAL);
  }
  if (seen !== null && seen.state === 'refused') {
    warn(
      emit,
      `could not confirm that namespace ${ns} is gone: ${answerWhy(seen)} — the local ` +
        `record is KEPT. Check the cluster ('${context}'), then \`houston down --name ` +
        `${name} --volumes\` again.`,
      { phase: 'teardown' },
    );
    return false;
  }
  warn(
    emit,
    `namespace ${ns} is still terminating after ` +
      `${String(Math.trunc(NS_GONE_TRIES * NS_GONE_INTERVAL))}s — Kubernetes will finish on ` +
      `its own. The local record is KEPT so you can retry: \`kubectl get ns ${ns}\`, then ` +
      `\`houston down --name ${name} --volumes\` again once it is gone.`,
    { phase: 'teardown' },
  );
  return false;
}

/** Remove the release and hand-written MongoDB while retaining its PVC. */
async function uninstallWorkspaceWorkloads(
  ns: string,
  context: string,
  own: boolean,
  emit: Emit,
): Promise<boolean> {
  info(emit, `uninstalling ${RELEASE} from ${ns} — the volume is kept`, { phase: 'teardown' });
  const rel = await kube.run(['helm', 'uninstall', RELEASE, '--kube-context', context, '-n', ns], {
    timeout: APPLY_TIMEOUT,
    own,
  });
  if (rel.returncode !== 0 && !why(rel).toLowerCase().includes('not found')) {
    throw new DockerError(`could not uninstall ${RELEASE} from ${ns}: ${why(rel)}`);
  }
  const gone = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      ns,
      'delete',
      'statefulset,service',
      '-l',
      OWNER_SELECTOR,
    ],
    { timeout: APPLY_TIMEOUT, own },
  );
  if (gone.returncode !== 0) {
    throw new DockerError(`could not remove MongoDB from ${ns}: ${why(gone)}`);
  }
  return true;
}

/**
 * Remove a workspace. Returns false if there was nothing there.
 *
 * `helm uninstall` does not delete the PVCs a StatefulSet created; Kubernetes retains them
 * deliberately. Deleting the NAMESPACE does remove them -- which is why `down` without
 * `--volumes` cannot just delete the namespace, or it would silently destroy data that
 * Compose's `down` keeps.
 *
 *   down            uninstall the release, keep the namespace and its PVCs
 *   down --volumes  delete the namespace, taking the PVCs with it
 */
export async function deleteNamespace(
  name: string,
  {
    context,
    volumes = false,
    emit = nullEmit,
    sleep = realSleep,
  }: { context: string; volumes?: boolean; emit?: Emit; sleep?: Sleep },
): Promise<boolean> {
  const ns = await namespaceFor(name);
  const own = isOurs(context);
  // `namespaceLabels`, not `workspaceNamespaces`: that one returns [] both when there is
  // nothing there and when the cluster could not be asked, and this used the second as
  // proof of the first. A wrong kube-context, an expired credential or an RBAC denial
  // therefore reported "nothing to remove" -- after which the caller deleted the local
  // record and told the reader the namespace and its PersistentVolumeClaim were gone,
  // while all of it went on running with the only record that knew about it destroyed.
  let labels: Record<string, string> | null;
  try {
    labels = await namespaceLabels(ns, { context });
  } catch (error) {
    // A DELETED CLUSTER IS NOT AN UNREACHABLE ONE. Its kubeconfig entry survives, but a
    // namespace cannot outlive a cluster that is provably absent. A failed kind probe
    // remains "I could not ask" and is re-raised.
    if (
      error instanceof DockerError &&
      (await clusterLossProvesNamespaceAbsent(ns, context, emit))
    ) {
      return true;
    }
    throw error;
  }
  // ABSENT IS THE MOST CONFIRMED-GONE STATE THERE IS, and this returned false for it -- so
  // teardown read "not confirmed gone", kept the local record, and said so. A Kubernetes
  // record whose namespace has already been removed could then NEVER be deleted.
  if (labels === null) return true;
  if (labels[OWNER_LABEL_KEY] !== OWNER_LABEL_VALUE) {
    // Refused rather than deleted. Reaching a namespace houston does not own is either a
    // half-labelled adoption or the wrong cluster -- and neither is a reason to delete
    // somebody's namespace.
    throw new ConflictError(
      `namespace ${ns} exists but is not labelled as houston's, so it will not be ` +
        `deleted. Check you are on the right cluster ('${context}'), then remove it ` +
        'yourself if you meant to',
    );
  }
  if (volumes) {
    // Reported as it happens, and WAITED for. `--wait=false` returned instantly and `down`
    // said "removed" while the namespace was still Terminating.
    return await deleteNamespaceAndVolumes(name, ns, context, own, emit, sleep);
  }
  // CHECKED. Both of these had their return codes dropped, so an RBAC denial or an
  // unreachable API server left the release installed and the pods running while `down`
  // reported success. "already uninstalled" is not a failure -- a repeated `down` is
  // normal -- so that one case is allowed through by name.
  return await uninstallWorkspaceWorkloads(ns, context, own, emit);
}

/**
 * Block until namespace `ns` is actually gone. False if it is still terminating.
 *
 * Extracted for `prune --orphans`, which swept namespaces with `--wait=false` and then
 * asked for the control plane in the same call -- so `deleteCluster` refused, correctly,
 * because the namespaces prune had just deleted were still Terminating. Reclaiming the
 * cluster took a SECOND prune twenty seconds later.
 *
 * SAME CORRECTION AS `deleteNamespace`, and it mattered more here: on a cluster houston
 * did not create, the caller passed a context that does not exist in the kubeconfig,
 * kubectl exited non-zero, and this returned true -- so `prune --orphans` printed
 * "removed 1 orphaned namespace(s)" with exit 0 over a namespace still Terminating.
 */
export async function waitNamespaceGone(
  ns: string,
  { context, emit = nullEmit, sleep = realSleep }: { context: string; emit?: Emit; sleep?: Sleep },
): Promise<boolean> {
  let seen = null as Awaited<ReturnType<typeof askObject>> | null;
  for (let attempt = 0; attempt < NS_GONE_TRIES; attempt += 1) {
    seen = await askObject('namespace', ns, { context });
    if (absent(seen)) return true;
    if (present(seen)) {
      const phase = phaseOf(seen.doc) || 'Terminating';
      if (attempt % 4 === 0) {
        info(
          emit,
          `namespace ${ns} is ${phase} — waiting for it to go before the cluster can be reclaimed`,
          { phase: 'done' },
        );
      }
    } else if (attempt % 4 === 0) {
      info(emit, `cannot reach cluster '${context}' to confirm ${ns} is gone — still trying`, {
        phase: 'done',
      });
    }
    await sleep(NS_GONE_INTERVAL);
  }
  if (seen !== null && seen.state === 'refused') {
    warn(
      emit,
      `could not confirm that namespace ${ns} is gone: ${answerWhy(seen)} — the cluster is ` +
        'left alone.',
      { phase: 'done' },
    );
    return false;
  }
  warn(
    emit,
    `namespace ${ns} is still terminating; the cluster is left alone. \`houston prune\` ` +
      'again once `kubectl get ns` is clear.',
    { phase: 'done' },
  );
  return false;
}
