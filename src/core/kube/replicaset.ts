/**
 * Initialising the MongoDB replica set, which a StatefulSet cannot do for itself.
 */
import { CreateFailedError } from '../../lib/errors';
import { info, nullEmit, type Emit } from '../../lib/events';

import { why } from './ask';
import { kube, type KubectlResult } from './exec';
import { APPLY_TIMEOUT, MONGO_DIRECT_URI, MONGO_SERVICE, isOurs, tuning } from './names';

/**
 * Rocket.Chat needs change streams, which need a replica set. `--replSet rs0` only puts
 * mongod IN replica-set mode; without `rs.initiate()` there is no primary, so nothing
 * can write and Rocket.Chat waits forever. Compose has a `mongo-init` service for
 * exactly this; the first cut of this module had no equivalent, and a real workspace sat
 * at 5 pods for 540 s with Rocket.Chat never becoming ready and nothing in its logs
 * naming MongoDB.
 */
export const RS_INITIATE = `rs.initiate({_id:"rs0",members:[{_id:0,host:"${MONGO_SERVICE}-0.${MONGO_SERVICE}:27017"}]})`;

export const MONGO_READY_INTERVAL = 5.0;

/**
 * The transient shapes of "the pod is not ready for this yet", which are worth retrying
 * because they resolve on their own within seconds.
 *
 * The second one is a defect found by running this on cold clusters. `initReplicaSet`
 * waits for `containerStatuses[0].started` and says exactly why it cannot wait for
 * READINESS -- readiness needs the replica set, and this is the initiation. That
 * reasoning is right, and it leaves a window: the container is up and mongod has not yet
 * bound :27017. The exec then fails with `MongoNetworkError: connect ECONNREFUSED
 * 127.0.0.1:27017`, and the retry predicate was an allow-list of ONE error, so a
 * connection refusal returned on the first attempt and failed the whole create.
 * Reproduced twice out of two on a freshly installed k3s -- an empty containerd store
 * and a cold PVC make mongod slow enough to lose the race every time. So it fired
 * precisely on somebody's first create, which is the worst place for it.
 */
const MONGO_TRANSIENT: readonly string[] = [
  // `kubectl exec` into a container that exists but is not exec-able yet, or is on its
  // way out: a pod reports `started` while TERMINATING.
  'container not found',
  // mongod has not bound its socket yet. Both spellings appear, and the driver
  // lower-cases neither for us.
  'econnrefused',
  'connection refused',
];

export type Sleep = (seconds: number) => Promise<void>;

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function mongoExecOnce(
  context: string,
  namespace: string,
  script: string,
): Promise<KubectlResult> {
  return await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'exec',
      `${MONGO_SERVICE}-0`,
      '--',
      'mongosh',
      MONGO_DIRECT_URI,
      '--quiet',
      '--eval',
      script,
    ],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
}

/**
 * mongosh inside the MongoDB pod, retried while the failure is a transient one.
 *
 * Retrying is safe for everything this is asked to run: `rs.initiate` is guarded by its
 * caller's "already initialized" check, and `rs.status().ok` is a read.
 */
async function mongoExec(
  context: string,
  namespace: string,
  script: string,
  { tries = 5, sleep = realSleep }: { tries?: number; sleep?: Sleep } = {},
): Promise<KubectlResult> {
  let res = await mongoExecOnce(context, namespace, script);
  for (let attempt = 1; attempt < tries; attempt += 1) {
    const combined = `${res.stdout}${res.stderr}`.toLowerCase();
    if (res.returncode === 0 || !MONGO_TRANSIENT.some((mark) => combined.includes(mark))) {
      return res;
    }
    await sleep(2.0);
    res = await mongoExecOnce(context, namespace, script);
  }
  return res;
}

/** Wait until a restarted single-node set can accept writes again. */
async function waitForPrimary(
  context: string,
  namespace: string,
  { tries = 6, sleep = realSleep }: { tries?: number; sleep?: Sleep } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const res = await mongoExec(context, namespace, 'db.hello().isWritablePrimary', { sleep });
    if (res.stdout.trim().toLowerCase() === 'true') return true;
    await sleep(2.0);
  }
  return false;
}

/** Verify a primary, repairing a persisted REMOVED member after restart. */
async function finishReplicaSet(
  context: string,
  namespace: string,
  combined: string,
  emit: Emit,
  sleep: Sleep,
): Promise<void> {
  if (await waitForPrimary(context, namespace, { sleep })) {
    info(emit, 'replica set ready', { phase: 'boot' });
    return;
  }
  if (combined.includes('already initialized')) {
    const repaired = await mongoExec(context, namespace, 'rs.reconfig(rs.conf(), {force:true})', {
      sleep,
    });
    if (repaired.returncode === 0 && (await waitForPrimary(context, namespace, { sleep }))) {
      info(emit, 'replica set recovered after restart', { phase: 'boot' });
      return;
    }
  }
  const ok = await mongoExec(context, namespace, 'rs.status().ok', { sleep });
  if (ok.stdout.trim() !== '1') {
    throw new CreateFailedError(
      "the MongoDB replica set is not initiated, so Rocket.Chat's change streams cannot " +
        `work: ${why(ok)}`,
    );
  }
  info(emit, 'replica set ready', { phase: 'boot' });
}

/**
 * Wait for MongoDB, initiate the single-node replica set, and VERIFY it.
 *
 * The shape exists to avoid a measured failure: `kubectl wait` called the instant after
 * `apply`, before the pod existed, so it failed immediately and `rs.initiate` then ran
 * against nothing -- with both errors discarded and the repro reported as created.
 *
 * So: poll for the pod, initiate, tolerate an already-initiated set, and check
 * `rs.status().ok` rather than trusting an exit code. A failure here is
 * `CreateFailedError` -- exit 7, known dead -- because every second spent waiting
 * afterwards is spent waiting for something that cannot happen.
 */
export async function initReplicaSet({
  namespace,
  context,
  emit = nullEmit,
  sleep = realSleep,
}: {
  namespace: string;
  context: string;
  emit?: Emit;
  sleep?: Sleep;
}): Promise<void> {
  // RUNNING, not READY -- and the difference is a circular wait. The readiness probe
  // cannot pass until the replica set is initiated, and initiation cannot run until
  // something answers. Waiting on readiness here made the whole create a coin flip: the
  // probe occasionally scraped through and the workspace built, otherwise it timed out
  // at 300 s reporting that MongoDB never became ready -- while mongod had in fact been
  // up the whole time, logging "ReadConcernMajorityNotAvailableYet".
  let started = false;
  for (let attempt = 0; attempt < tuning.MONGO_READY_TRIES; attempt += 1) {
    // `started`, not `phase`. A pod reports Running before its container is exec-able,
    // and `kubectl exec` then fails with `container not found ("mongod")` -- which is
    // what `up` after a plain `down` hit: the PVC was still there, the StatefulSet came
    // back, the pod said Running, and the exec raced the container.
    //
    // Not `ready` either: readiness needs the replica set initiated, and this IS the
    // initiation. `started` is the field that means "the container is up", independent
    // of whether it is serving.
    const res = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        namespace,
        'get',
        'pod',
        `${MONGO_SERVICE}-0`,
        '-o',
        'jsonpath={.status.containerStatuses[0].started}',
      ],
      { own: isOurs(context) },
    );
    if (res.stdout.trim() === 'true') {
      started = true;
      break;
    }
    if (attempt % 6 === 0) info(emit, 'waiting for MongoDB', { phase: 'wait' });
    await sleep(MONGO_READY_INTERVAL);
  }
  if (!started) {
    throw new CreateFailedError(
      'the MongoDB pod never started, and Rocket.Chat cannot work without it ' +
        `(kubectl -n ${namespace} describe pod ${MONGO_SERVICE}-0)`,
    );
  }

  info(emit, 'initiating the replica set', { phase: 'boot', pct: 45 });
  const res = await mongoExec(context, namespace, RS_INITIATE, { sleep });
  const combined = `${res.stdout}${res.stderr}`.toLowerCase();
  if (res.returncode !== 0 && !combined.includes('already initialized')) {
    throw new CreateFailedError(
      `could not initiate the MongoDB replica set: ${combined.trim().slice(0, 300)}`,
    );
  }
  // A cold restart can resolve the member hostname too late. MongoDB then keeps the
  // persisted member in REMOVED and never elects it again, even after DNS is healthy.
  // `finishReplicaSet` reapplies that one-member config with force.
  await finishReplicaSet(context, namespace, combined, emit, sleep);
}
