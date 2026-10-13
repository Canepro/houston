/**
 * Scaling a workspace down and back up, and remembering what it was.
 */
import { DockerError, NotFoundError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';
import { dumps } from '../../lib/json-text';

import { why } from './ask';
import { kube } from './exec';
import { APPLICATION_SELECTOR, APPLY_TIMEOUT, MONGO_SERVICE, RELEASE, isOurs } from './names';
import { namespaceFor } from './namespace';
import { initReplicaSet, type Sleep } from './replicaset';

/**
 * Where the replica count lives while a workspace is stopped. Kubernetes has no "stopped"
 * state -- scaling to 0 is the whole mechanism -- so the number that was there has to be
 * written down or `start` cannot put it back. An annotation on the namespace rather than
 * repro.json, because `kubectl scale` by hand is a legitimate thing for someone to do and
 * the cluster should carry its own truth.
 */
export const SCALE_ANNOTATION = 'houston.io/replicas-before-stop';

/** Up to a minute for pods to terminate. MongoDB gets a grace period and uses it. */
export const POD_GONE_TRIES = 30;

export const POD_GONE_INTERVAL = 2.0;

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Every workload in the namespace that has a replica count, as `kind/name`.
 *
 * The MongoDB StatefulSet is included deliberately. `docker compose stop` stops the
 * database too, and a workspace that keeps 8Gi of MongoDB resident while claiming to be
 * stopped is not stopped in the sense anyone means -- the whole reason to stop one on a
 * laptop is to get the memory back.
 */
async function scalables(namespace: string, context: string): Promise<string[]> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'deployment,statefulset',
      '-o',
      'name',
    ],
    { own: isOurs(context) },
  );
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Scale every workload in a workspace to `replicas`. Returns how many it moved.
 *
 * `--all` is not used: it would also catch anything a preset or a person added, and
 * scaling something back up to a number it never had is worse than leaving it.
 */
export async function scaleWorkspace(
  name: string,
  { replicas, context, emit: _emit = nullEmit }: { replicas: number; context: string; emit?: Emit },
): Promise<number> {
  const namespace = await namespaceFor(name);
  const targets = await scalables(namespace, context);
  if (targets.length === 0) {
    throw new NotFoundError(
      `'${name}' has no workloads to scale -- it was \`down\`ed, so there is nothing to ` +
        `stop or start. Recreate it with \`houston up --name ${name}\``,
    );
  }
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'scale',
      `--replicas=${String(replicas)}`,
      ...targets,
    ],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) throw new DockerError(`could not scale '${name}': ${why(res)}`);
  return targets.length;
}

/**
 * The Rocket.Chat Deployment's DESIRED replica count, or -1 if unknown.
 *
 * `.spec.replicas`, not `.status`: the question is what was asked for, so that a workspace
 * scaled to zero reads as stopped the instant `stop` returns rather than once the pods
 * have finished terminating.
 */
export async function desiredReplicas(
  name: string,
  { context }: { context: string },
): Promise<number> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      await namespaceFor(name),
      'get',
      'deployment',
      `${RELEASE}-rocketchat`,
      '-o',
      'jsonpath={.spec.replicas}',
    ],
    { own: isOurs(context) },
  );
  const count = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(count) ? count : -1;
}

/**
 * Pod names (as `pod/<n>`) that an operator-managed MongoDB will not give up.
 *
 * Empty for the hand-written StatefulSet, which scales to zero like anything else.
 */
export async function mongoPodsTheOperatorKeeps(
  name: string,
  { context }: { context: string },
): Promise<Set<string>> {
  const namespace = await namespaceFor(name);
  const res = await kube.run(
    ['kubectl', '--context', context, '-n', namespace, 'get', 'mongodbcommunity', '-o', 'name'],
    { own: isOurs(context) },
  );
  if (res.returncode !== 0 || res.stdout.trim() === '') return new Set();
  const pods = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'pods',
      '-l',
      `app=${MONGO_SERVICE}-svc`,
      '-o',
      'name',
    ],
    { own: isOurs(context) },
  );
  return new Set(pods.stdout.split(/\s+/u).filter((entry) => entry.trim() !== ''));
}

/** Scale to zero, remembering what to come back to, and wait for it. */
export async function stopWorkspace(
  name: string,
  { context, emit = nullEmit, sleep = realSleep }: { context: string; emit?: Emit; sleep?: Sleep },
): Promise<number> {
  const namespace = await namespaceFor(name);
  // Recorded BEFORE scaling, or the number read back is the zero we just wrote.
  const before: Record<string, string> = {};
  for (const target of await scalables(namespace, context)) {
    const res = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        namespace,
        'get',
        target,
        '-o',
        'jsonpath={.spec.replicas}',
      ],
      { own: isOurs(context) },
    );
    const count = res.stdout.trim();
    if (count !== '' && count !== '0') before[target] = count;
  }
  if (Object.keys(before).length > 0) {
    await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        namespace,
        'annotate',
        '--overwrite',
        'namespace',
        namespace,
        // `dumps(before)`: the established spacing, so the annotation -- cluster state the
        // other build reads back on `start` -- is the same bytes whichever build stopped
        // the workspace. `JSON.stringify` wrote it compact.
        `${SCALE_ANNOTATION}=${dumps(before)}`,
      ],
      { own: isOurs(context) },
    );
  }
  const moved = await scaleWorkspace(name, { replicas: 0, context, emit });

  // An operator-managed MongoDB CANNOT be scaled to zero: the operator reconciles its
  // StatefulSet straight back, and the Community operator has no way to pause
  // reconciliation. So its pods are expected to survive `stop`, and two things follow.
  // First, the wait below must not require them to go, or every stop and restart on the
  // operator path burns the whole budget waiting for something that will never happen.
  // Second and worse, `stop` documents itself as giving the memory back -- on this path it
  // gives back Rocket.Chat's and not MongoDB's, and said nothing.
  const survivors = await mongoPodsTheOperatorKeeps(name, { context });
  if (survivors.size > 0) {
    warn(
      emit,
      'MongoDB stays up: it is operator-managed, and the operator recreates it as fast as ' +
        "it is scaled down (there is no way to pause its reconciliation). Rocket.Chat's " +
        `memory is freed, MongoDB's is not — \`houston down --name ${name} --volumes\` is ` +
        'what reclaims it.',
      { phase: 'done' },
    );
  }

  // WAIT for the pods to actually go, rather than returning on the API call. `restart` is
  // stop-then-start, so returning early scales back up while the old pods are still
  // Terminating -- and the readiness check then finds one of THOSE, reports ready, and the
  // port-forward attaches to a pod on its way out. This is the fourth time on this runtime
  // that trusting a readiness signal over the actual state produced a workspace that looks
  // up and is not.
  for (let attempt = 0; attempt < POD_GONE_TRIES; attempt += 1) {
    const res = await kube.run(
      ['kubectl', '--context', context, '-n', namespace, 'get', 'pods', '-o', 'name'],
      { own: isOurs(context) },
    );
    const left = res.stdout.split(/\s+/u).filter((entry) => entry.trim() !== '');
    if (left.filter((pod) => !survivors.has(pod)).length === 0) break;
    await sleep(POD_GONE_INTERVAL);
  }
  info(emit, `scaled ${String(moved)} workload(s) to zero`, { phase: 'done' });
  return moved;
}

/**
 * Scale back to whatever was recorded, or to 1 if nothing was.
 *
 * A workspace stopped by hand carries no annotation, and refusing to start it would be
 * pedantry -- 1 is what `up` would have given it.
 */
export async function startWorkspace(
  name: string,
  { context, emit = nullEmit }: { context: string; emit?: Emit },
): Promise<number> {
  const namespace = await namespaceFor(name);
  // Read as JSON and pick the key here, rather than through jsonpath.
  //
  // jsonpath was how this went wrong: the key is `houston.io/replicas-before-stop` and the
  // code escaped the SLASH while leaving the DOT in `houston.io` unescaped -- so jsonpath
  // read `houston` and `io/...` as separate path segments, matched nothing, and returned
  // empty. Every stop/start therefore restored the DEFAULT of 1, silently turning a
  // `--replicas 2` workspace into a one-replica one, and the annotation written to prevent
  // exactly that was never once read back. No escaping at all is a rule that cannot be got
  // subtly wrong.
  const res = await kube.run(
    ['kubectl', '--context', context, '-n', namespace, 'get', 'namespace', namespace, '-o', 'json'],
    { own: isOurs(context) },
  );
  let before: Record<string, string> = {};
  try {
    const doc = JSON.parse(res.stdout || '{}') as {
      metadata?: { annotations?: Record<string, string> };
    };
    const parsed: unknown = JSON.parse(doc.metadata?.annotations?.[SCALE_ANNOTATION] ?? '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      before = parsed as Record<string, string>;
    }
  } catch {
    before = {};
  }

  const targets = await scalables(namespace, context);
  if (targets.length === 0) {
    throw new NotFoundError(
      `'${name}' has no workloads to start -- it was \`down\`ed. Recreate it with ` +
        `\`houston up --name ${name}\``,
    );
  }
  const mongo = targets.filter((target) => target.split('/').pop() === MONGO_SERVICE);
  const rest = targets.filter((target) => !mongo.includes(target));
  for (const target of [...mongo, ...rest]) {
    const count = String(before[target] ?? '1');
    const scaled = await kube.run(
      ['kubectl', '--context', context, '-n', namespace, 'scale', `--replicas=${count}`, target],
      { timeout: APPLY_TIMEOUT, own: isOurs(context) },
    );
    if (scaled.returncode !== 0) throw new DockerError(`could not scale ${target}: ${why(scaled)}`);
    if (mongo.includes(target) && (await mongoPodsTheOperatorKeeps(name, { context })).size === 0) {
      await initReplicaSet({ namespace, context, emit });
    }
  }
  info(emit, `scaled ${String(targets.length)} workload(s) back up`, { phase: 'done' });
  return targets.length;
}

/**
 * Scale ONLY Rocket.Chat, leaving MongoDB up.
 *
 * What `stopWorkspace` does is wrong for a backup: a dump needs the database running and
 * only its writers quiesced. This is the Kubernetes counterpart of `stopServices`.
 */
export async function scaleRocketchat(
  name: string,
  {
    replicas,
    context,
    sleep = realSleep,
    selector = APPLICATION_SELECTOR,
  }: { replicas: number; context: string; sleep?: Sleep; selector?: string },
): Promise<number> {
  const namespace = await namespaceFor(name);
  const listed = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'deployment',
      '-l',
      selector,
      '-o',
      'name',
    ],
    { own: isOurs(context) },
  );
  if (listed.returncode !== 0) {
    throw new DockerError(`could not list Rocket.Chat deployments for '${name}': ${why(listed)}`);
  }
  const targets = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (targets.length === 0) throw new NotFoundError(`'${name}' has no Rocket.Chat deployments`);
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'scale',
      `--replicas=${String(replicas)}`,
      ...targets,
    ],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0 || replicas !== 0) return res.returncode;
  await waitForRocketchatPodsGone(namespace, context, name, sleep, selector);
  return 0;
}

/** Desired counts before quiescence, including already stopped deployments. */
export async function rocketchatReplicas(
  name: string,
  { context }: { context: string },
): Promise<Record<string, number>> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      await namespaceFor(name),
      'get',
      'deployment',
      '-l',
      APPLICATION_SELECTOR,
      '-o',
      'json',
    ],
    { own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    throw new DockerError(`could not read Rocket.Chat replicas for '${name}': ${why(res)}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(res.stdout);
  } catch {
    throw new DockerError(
      `could not read Rocket.Chat replicas for '${name}': invalid deployment list`,
    );
  }
  const rows =
    typeof doc === 'object' && doc !== null && !Array.isArray(doc)
      ? (doc as Record<string, unknown>).items
      : undefined;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DockerError(`could not read Rocket.Chat replicas for '${name}': no deployment list`);
  }
  const counts: Record<string, number> = {};
  for (const row of rows as unknown[]) {
    const item = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
    const metadata = item.metadata as { name?: unknown } | undefined;
    const spec = item.spec as { replicas?: unknown } | undefined;
    const deployment = metadata?.name;
    const count = spec?.replicas;
    if (
      typeof deployment !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]*$/u.test(deployment) ||
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 0
    ) {
      throw new DockerError(
        `could not read Rocket.Chat replicas for '${name}': invalid deployment count`,
      );
    }
    const target = `deployment.apps/${deployment}`;
    if (Object.hasOwn(counts, target)) {
      throw new DockerError(
        `could not read Rocket.Chat replicas for '${name}': duplicate deployment`,
      );
    }
    counts[target] = count;
  }
  return counts;
}

/** Restore the same deployment set; an uncertain or changed set is not safe to guess. */
export async function restoreRocketchatReplicas(
  name: string,
  counts: Readonly<Record<string, number>>,
  { context }: { context: string },
): Promise<number> {
  const current = await rocketchatReplicas(name, { context });
  if (
    Object.keys(current).sort().join('\n') !== Object.keys(counts).sort().join('\n') ||
    Object.values(counts).some((count) => !Number.isInteger(count) || count < 0)
  ) {
    throw new DockerError(
      `cannot restore Rocket.Chat replicas for '${name}': deployment shape changed`,
    );
  }
  const namespace = await namespaceFor(name);
  for (const [target, count] of Object.entries(counts)) {
    const res = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        namespace,
        'scale',
        `--replicas=${String(count)}`,
        target,
      ],
      { timeout: APPLY_TIMEOUT, own: isOurs(context) },
    );
    if (res.returncode !== 0) return res.returncode;
  }
  return 0;
}

async function waitForRocketchatPodsGone(
  namespace: string,
  context: string,
  name: string,
  sleep: Sleep,
  selector: string,
): Promise<void> {
  for (let attempt = 0; attempt < POD_GONE_TRIES; attempt += 1) {
    const res = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        namespace,
        'get',
        'pods',
        '-l',
        selector,
        '-o',
        'name',
      ],
      { own: isOurs(context) },
    );
    if (res.returncode !== 0) {
      throw new DockerError(`could not verify Rocket.Chat termination for '${name}': ${why(res)}`);
    }
    if (res.stdout.trim() === '') return;
    if (attempt + 1 < POD_GONE_TRIES) await sleep(POD_GONE_INTERVAL);
  }
  throw new DockerError(
    `Rocket.Chat pods did not terminate for '${name}'; refusing to access the database`,
  );
}
