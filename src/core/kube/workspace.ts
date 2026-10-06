/**
 * Creating a workspace in a cluster: the one function everything below this line serves.
 *
 * Tier k5. Nothing in the package imports it -- which is what being the top of the tiers
 * means. It is the orchestrator: the namespace, MongoDB, the chart release, the scenario's
 * manifests and the port-forward, in the order that each one's failure can still be acted on.
 */
import * as crypto from 'node:crypto';

import { PreflightError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';
import type { Preset } from '../../lib/presets/types';
import type { Resolved } from '../../lib/versions';

import { architectureBlocker, storageBlocker, workspaceNamespaces } from './capabilities';
import {
  ensureIssuer,
  issuerName,
  tlsSecretFor,
  waitForCertificate,
  type IssuerSpec,
} from './certmanager';
import { deleteCluster, ensureKubeconfig } from './cluster';
import { planCluster, type ClusterPlan } from './context';
import { ensureRepo, resolveChartVersion, valuesFor } from './chart';
import { kube } from './exec';
import { forwardAlive, portForward, scenarioUiForwards } from './forward';
import { ingressValues } from './ingress';
import {
  containerSecurityContext,
  mongoManifest,
  recordRendered,
  renderScenarioManifest,
} from './manifests';
import {
  APPLY_TIMEOUT,
  CHART,
  MONGO_OPLOG_URL,
  MONGO_URL,
  MONGO_VOLUME_GB,
  RELEASE,
  isOurs,
  mongoImage,
} from './names';
import { ensureNamespace, namespaceFor } from './namespace';
import {
  MONGO_URL_SECRET,
  OPERATOR_MIN_MONGO,
  REG_TOKEN_SECRET,
  ensureOperator,
  mongoRbacManifest,
  mongoSecretManifest,
  mongoUrlSecretManifest,
  mongodbCommunityManifest,
  operatorEnabled,
  operatorMongoUrl,
  operatorSupports,
  operatorVersion,
  regTokenSecretManifest,
  waitForMongodb,
} from './operator';
import { preflight } from './probe';
import { apply, install } from './release';
import { initReplicaSet, type Sleep } from './replicaset';

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * A generated password: base64url of 24 random bytes, unpadded.
 *
 * The established 32 characters, from a cryptographic source. These never reach disk on
 * this side -- they go to `kubectl apply` on
 * stdin and come back out of the Secret when a tool needs them.
 */
function generatedPassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** What a database provisioning path hands back to the rest of the create. */
interface Database {
  readonly mongoUrl: string;
  readonly oplogUrl: string;
  readonly rendered: Record<string, string>;
  readonly managedBy: string;
  readonly image: string;
}

/** Provision or adopt the cluster, resolve its chart, and enforce the capability gates. */
async function prepareCluster(
  given: ClusterPlan | null,
  resolved: Resolved,
  emit: Emit,
): Promise<{
  plan: ClusterPlan;
  context: string;
  hadCluster: boolean;
  chartVersion: string;
}> {
  const plan = given ?? (await planCluster());
  const context = await ensureKubeconfig(plan, emit);
  if (!plan.create && !isOurs(context)) {
    info(
      emit,
      `using ${plan.distribution} cluster '${context}' — houston creates a namespace in ` +
        'it; the cluster itself stays until `houston cluster delete`',
      { phase: 'provision', pct: 5 },
    );
  }
  const hadCluster = !plan.create;
  if (!hadCluster || plan.distribution !== 'kind') {
    info(
      emit,
      `the ${plan.distribution} cluster has its own image store, separate from Docker's — ` +
        'a version already pulled for Compose is fetched again here (about 1.6 GB the ' +
        'first time)',
      { phase: 'provision', pct: 6 },
    );
  }
  await ensureRepo(emit);
  const chartVersion = await resolveChartVersion(resolved.rcVersion, emit);
  info(emit, `chart ${chartVersion} for Rocket.Chat ${resolved.rcVersion}`, { phase: 'plan' });
  const pre = await preflight(context);
  const blocked = storageBlocker(pre) || architectureBlocker(pre, resolved.rcVersion);
  if (blocked !== '') throw new PreflightError(blocked);
  return { plan, context, hadCluster, chartVersion };
}

/** Create or adopt the namespace, and remember whether rollback may remove it. */
async function ensureWorkspaceNamespace(
  name: string,
  context: string,
  owner: string,
  emit: Emit,
): Promise<{ namespace: string; hadNamespace: boolean }> {
  // Whether the namespace was already here decides what a failure may undo. A re-create
  // over a namespace kept by `down` must NOT have its rollback delete that namespace: the
  // PVC goes with it, and `down` had just promised the data would be there. REFUSED READS
  // COUNT AS "IT WAS ALREADY THERE": never destroy data we could not prove was ours to
  // destroy.
  const held = await workspaceNamespaces(context);
  const hadNamespace = held === null || held.includes(await namespaceFor(name));
  const namespace = await ensureNamespace(name, { context, owner, emit });
  return { namespace, hadNamespace };
}

/** Install an operator-managed MongoDB and return its connection metadata. */
async function operatorDatabase(
  name: string,
  resolved: Resolved,
  owner: string,
  namespace: string,
  context: string,
  emit: Emit,
): Promise<Database> {
  await ensureOperator({ context, namespace, emit });
  const appPassword = generatedPassword();
  info(
    emit,
    `MongoDB ${resolved.mongoTag} via the operator, SCRAM auth, ${String(MONGO_VOLUME_GB)}Gi ` +
      'volume',
    { phase: 'provision', pct: 20 },
  );
  await apply(mongoRbacManifest(name, { owner }), { namespace, context });
  await apply(
    mongoSecretManifest(name, {
      adminPassword: generatedPassword(),
      appPassword,
      owner,
    }),
    { namespace, context },
  );
  const operatorDoc = mongodbCommunityManifest(name, resolved.mongoTag, { owner });
  await apply(operatorDoc, { namespace, context });
  await waitForMongodb({ namespace, context, emit });
  return {
    mongoUrl: operatorMongoUrl(namespace, appPassword),
    oplogUrl: operatorMongoUrl(namespace, appPassword, { oplog: true }),
    rendered: { mongodb: operatorDoc },
    managedBy: 'operator',
    image:
      `mongodb-community-server ${operatorVersion(resolved.mongoTag)} ` + "(operator's choice)",
  };
}

/** Install the unauthenticated StatefulSet fallback and initiate its replica set. */
async function statefulSetDatabase(
  name: string,
  resolved: Resolved,
  owner: string,
  namespace: string,
  context: string,
  emit: Emit,
  operatorRequested: boolean,
): Promise<Database> {
  const floor = OPERATOR_MIN_MONGO.join('.');
  const whyNoAuth = operatorRequested
    ? `the operator cannot manage MongoDB below ${floor}, so this falls back to a plain ` +
      'StatefulSet'
    : 'the MongoDB operator is opt-in — add `--mongo-operator` for a database with SCRAM ' +
      'authentication';
  info(
    emit,
    `MongoDB ${resolved.mongoTag}, ${String(MONGO_VOLUME_GB)}Gi volume (no authentication: ` +
      `${whyNoAuth})`,
    { phase: 'provision', pct: 20 },
  );
  await apply(mongoManifest(name, resolved.mongoTag, { owner }), { namespace, context });
  await initReplicaSet({ namespace, context, emit });
  return {
    mongoUrl: MONGO_URL,
    oplogUrl: MONGO_OPLOG_URL,
    rendered: {},
    managedBy: 'statefulset',
    image: mongoImage(resolved.mongoTag),
  };
}

/** Choose the operator or StatefulSet path without changing their ordering. */
async function provisionDatabase(
  name: string,
  resolved: Resolved,
  useOperator: boolean,
  owner: string,
  namespace: string,
  context: string,
  emit: Emit,
): Promise<Database> {
  const requested = useOperator || operatorEnabled();
  if (requested && operatorSupports(resolved.mongoTag, { forced: useOperator })) {
    return await operatorDatabase(name, resolved, owner, namespace, context, emit);
  }
  return await statefulSetDatabase(name, resolved, owner, namespace, context, emit, requested);
}

/** Apply scenario resources and the Secrets the Rocket.Chat chart consumes. */
async function applyScenarioAndSecrets(
  name: string,
  preset: Preset | null,
  regToken: string,
  owner: string,
  namespace: string,
  context: string,
  database: Database,
  emit: Emit,
): Promise<void> {
  const rendered = database.rendered;
  const manifests = preset?.kubernetesManifests ?? [];
  if (manifests.length > 0) {
    const count = manifests.length;
    info(
      emit,
      `applying the ${preset?.scenario || (preset?.name ?? '')} scenario — ` +
        `${String(count)} resource${count === 1 ? '' : 's'}`,
      { phase: 'provision', pct: 25 },
    );
    for (const [index, manifest] of manifests.entries()) {
      const body = renderScenarioManifest(manifest, name);
      rendered[index === 0 ? 'scenario' : `scenario-${String(index)}`] = body;
      await apply(body, { namespace, context });
    }
  }
  await apply(
    mongoUrlSecretManifest(name, {
      mongoUrl: database.mongoUrl,
      oplogUrl: database.oplogUrl,
      owner,
    }),
    { namespace, context },
  );
  if (regToken !== '') {
    info(emit, 'installing the registration token Secret', { phase: 'boot' });
    await apply(regTokenSecretManifest(name, { token: regToken, owner }), { namespace, context });
  }
}

interface ChartInstall {
  readonly name: string;
  readonly resolved: Resolved;
  readonly microservices: boolean;
  readonly replicas: number;
  readonly rootUrl: string;
  readonly tlsHost: string;
  readonly regToken: string;
  readonly adminPassword: string;
  readonly preset: Preset | null;
  readonly issuer: IssuerSpec | null;
  readonly ingressClass: string;
  readonly namespace: string;
  readonly context: string;
  readonly chartVersion: string;
  readonly emit: Emit;
}

/** Build values, prepare TLS, and install the Rocket.Chat release. */
async function installChart(options: ChartInstall): Promise<Record<string, unknown>> {
  const { name, resolved, tlsHost, regToken, namespace, context, chartVersion, emit } = options;
  const values = valuesFor({
    rcVersion: resolved.rcVersion,
    rcImage: resolved.rcImage,
    microservices: options.microservices,
    replicas: options.replicas,
    // `host` and `root_url` are the same field to the chart and must never both be set --
    // two entries for ROOT_URL is a server-side-apply conflict, not an override.
    rootUrl: tlsHost !== '' ? '' : options.rootUrl,
    host: tlsHost,
    oplog: resolved.oplog,
    mongoSecret: MONGO_URL_SECRET,
    regTokenSecret: regToken !== '' ? REG_TOKEN_SECRET : '',
    adminPassword: options.adminPassword,
    ...(options.preset !== null ? { presetEnv: options.preset.env } : {}),
  });
  if (tlsHost !== '') {
    const spec: IssuerSpec = options.issuer ?? { mode: 'local' };
    await ensureIssuer(spec, { context, ingressClass: options.ingressClass, emit });
    Object.assign(
      values,
      ingressValues(tlsHost, {
        ingressClass: options.ingressClass,
        secretName: tlsSecretFor(name),
        issuer: issuerName(spec),
      }),
    );
  }
  Object.assign(values, await containerSecurityContext(chartVersion));
  info(
    emit,
    `installing ${CHART} as ${RELEASE} — the pods pull the image now, which is the longest ` +
      'step of a create',
    { phase: 'boot', pct: 60 },
  );
  await install({ namespace, context, values, chartVersion, emit });
  return values;
}

/** Undo only the resources this create proved it introduced. */
async function rollbackCreate(
  namespace: string,
  context: string,
  hadNamespace: boolean,
  hadCluster: boolean,
  emit: Emit,
): Promise<void> {
  if (hadNamespace) {
    warn(emit, `create failed — namespace ${namespace} and its volume are left as they were`, {
      phase: 'teardown',
    });
    return;
  }
  warn(emit, `create failed — removing namespace ${namespace}`, { phase: 'teardown' });
  try {
    await kube.run(
      ['kubectl', '--context', context, 'delete', 'namespace', namespace, '--wait=false'],
      { timeout: APPLY_TIMEOUT, own: isOurs(context) },
    );
    if (!hadCluster) await deleteCluster({ emit });
  } catch {
    // The ORIGINAL failure is what matters; a rollback that fails must not replace it.
  }
}

interface ConnectOptions {
  readonly name: string;
  readonly namespace: string;
  readonly context: string;
  readonly hostPort: number;
  readonly bindHost: string;
  readonly previousPid: number;
  readonly previousPort: number | null;
  readonly tlsHost: string;
  readonly values: Record<string, unknown>;
  readonly rendered: Record<string, string>;
  readonly chartVersion: string;
  readonly microservices: boolean;
  readonly database: Database;
  readonly emit: Emit;
  readonly sleep: Sleep;
}

/** Wait for TLS, establish the forwards, persist the manifests, and return the metadata. */
async function connectWorkspace(options: ConnectOptions): Promise<Record<string, unknown>> {
  const { name, namespace, context, hostPort, bindHost, tlsHost, emit } = options;
  let certReady = false;
  if (tlsHost !== '') {
    certReady = await waitForCertificate(tlsSecretFor(name), { namespace, context, emit });
  }
  let pid = await portForward(name, {
    namespace,
    context,
    hostPort,
    bindHost,
    previousPid: options.previousPid,
    previousPort: options.previousPort,
    emit,
  });
  await options.sleep(1.0);
  if (forwardAlive(pid, { namespace, hostPort })) {
    info(emit, `port-forward established — http://localhost:${String(hostPort)}`, {
      phase: 'boot',
      pct: 90,
    });
  } else {
    pid = 0;
    warn(
      emit,
      `the port-forward did not stay up, so http://localhost:${String(hostPort)} is not ` +
        `reachable yet. Once the pod is running: kubectl -n ${namespace} port-forward ` +
        `deployment/${RELEASE}-rocketchat ${String(hostPort)}:3000 — or \`houston ready ` +
        `--name ${name}\` to re-establish it.`,
      { phase: 'boot' },
    );
  }
  await recordRendered(name, { values: options.values, manifests: options.rendered });
  const ui = await scenarioUiForwards(name, { namespace, context, bindHost, emit });
  return {
    scenario_forwards: Object.fromEntries(
      Object.entries(ui).map(([port, forwardPid]) => [String(port), forwardPid]),
    ),
    context,
    namespace,
    bind_host: bindHost,
    chart_version: options.chartVersion,
    release: RELEASE,
    port_forward_pid: pid,
    microservices: options.microservices,
    mongo_managed_by: options.database.managedBy,
    mongo_image: options.database.image,
    tls_host: tlsHost,
    certificate_ready: certReady,
  };
}

export interface CreateWorkspaceOptions {
  readonly name: string;
  readonly resolved: Resolved;
  readonly hostPort: number;
  readonly microservices: boolean;
  readonly replicas?: number;
  readonly owner?: string;
  readonly rootUrl?: string;
  readonly bindHost?: string;
  readonly useOperator?: boolean;
  readonly regToken?: string;
  readonly preset?: Preset | null;
  readonly plan?: ClusterPlan | null;
  readonly tlsHost?: string;
  readonly ingressClass?: string;
  readonly issuer?: IssuerSpec | null;
  readonly adminPassword?: string;
  readonly previousPid?: number;
  readonly previousPort?: number | null;
  readonly emit?: Emit;
  readonly sleep?: Sleep;
}

/**
 * Build a Kubernetes workspace, and return what repro.json needs.
 *
 * A PARALLEL path to lifecycle's compose one rather than a refactor of it, which is PR #3's
 * call and the right one: lifecycle is compose-shaped throughout and two front-ends depend
 * on it, so the Docker default stays byte-identical and this owns the Kubernetes sequence
 * instead. Naming, version resolution and metadata are shared, not reimplemented.
 *
 * Ordered so nothing waits on something that cannot happen: the replica set is initiated
 * BEFORE the chart goes in, because Rocket.Chat needs change streams and would otherwise sit
 * at not-ready with nothing in its logs naming MongoDB.
 */
export async function createWorkspace({
  name,
  resolved,
  hostPort,
  microservices,
  replicas = 1,
  owner = '',
  rootUrl = '',
  bindHost = '',
  useOperator = false,
  regToken = '',
  preset = null,
  plan = null,
  tlsHost = '',
  ingressClass = '',
  issuer = null,
  adminPassword = '',
  previousPid = 0,
  previousPort = null,
  emit = nullEmit,
  sleep = realSleep,
}: CreateWorkspaceOptions): Promise<Record<string, unknown>> {
  const prepared = await prepareCluster(plan, resolved, emit);
  const { context, hadCluster, chartVersion } = prepared;

  const { namespace, hadNamespace } = await ensureWorkspaceNamespace(name, context, owner, emit);
  let database: Database;
  let values: Record<string, unknown>;
  try {
    database = await provisionDatabase(
      name,
      resolved,
      useOperator,
      owner,
      namespace,
      context,
      emit,
    );
    await applyScenarioAndSecrets(
      name,
      preset,
      regToken,
      owner,
      namespace,
      context,
      database,
      emit,
    );
    values = await installChart({
      name,
      resolved,
      microservices,
      replicas,
      rootUrl,
      tlsHost,
      regToken,
      adminPassword,
      preset,
      issuer,
      ingressClass,
      namespace,
      context,
      chartVersion,
      emit,
    });
  } catch (error) {
    // A failed create must not leave anything a user cannot see. No repro.json is written
    // until this returns, so a surviving namespace would be invisible to `list` and to
    // `down` -- and on Compose a failed `up` at least leaves a workspace directory you can
    // find. The cluster goes too if this call created it and nothing else is using it:
    // `deleteCluster` refuses while any other workspace namespace is there, so a
    // colleague's concurrent `up` is safe from this.
    await rollbackCreate(namespace, context, hadNamespace, hadCluster, emit);
    throw error;
  }

  // AFTER the try/catch, so a certificate that has not arrived cannot roll back a workspace
  // that installed perfectly well. cert-manager issues asynchronously from the Ingress
  // annotation, so this is the difference between "the name works" and "the name will work
  // in a moment, probably".
  return await connectWorkspace({
    name,
    namespace,
    context,
    hostPort,
    bindHost,
    previousPid,
    previousPort,
    tlsHost,
    values,
    rendered: database.rendered,
    chartVersion,
    microservices,
    database,
    emit,
    sleep,
  });
}
