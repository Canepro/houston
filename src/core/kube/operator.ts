/**
 * The MongoDB Community operator: installing it, owning it, and knowing when it is
 * somebody else's.
 *
 * Shared across every workspace on the cluster, so nothing here removes it without checking
 * who else is using it -- and a list that could not be read is never proof that nobody is.
 */
import * as YAML from 'yaml';

import * as config from '../../lib/config';
import { CreateFailedError, DockerError, PreflightError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';

import { REFUSED, askList, askObject, items, present, refused, why, type Answer } from './ask';
import { helmEnv, kube } from './exec';
import { scalar } from './manifests';
import {
  APPLY_TIMEOUT,
  INSTALL_TIMEOUT,
  MONGO_SERVICE,
  MONGO_VOLUME_GB,
  NAMESPACE_PREFIX,
  isOurs,
  tuning,
} from './names';
import { labelsFor, namespaceFor } from './namespace';
import { clearPendingRelease, helmRollbackOnFailure, releaseState } from './release';
import { MONGO_READY_INTERVAL, type Sleep } from './replicaset';

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * The operator lives ONCE per cluster, in houston's own namespace, watching all
 * namespaces. The official guide installs it into the workspace namespace because it
 * assumes one Rocket.Chat per cluster; its CRDs are cluster-scoped, so a second
 * per-namespace install collides on them rather than giving you a second operator.
 */
export const OPERATOR_NAMESPACE = 'houston-system';

export const OPERATOR_RELEASE = 'mongodb-kubernetes-operator';

export const OPERATOR_REPO = 'mongodb';

export const OPERATOR_REPO_URL = 'https://mongodb.github.io/helm-charts';

export const OPERATOR_CHART = `${OPERATOR_REPO}/mongodb-kubernetes`;

/**
 * The oldest MongoDB the operator will manage. Below this houston falls back to the
 * hand-written StatefulSet, which is why that code stays: houston pairs twelve MongoDB
 * versions because "the customer's exact version" is the product's promise, and the
 * operator's window does not reach the old half.
 *
 * 6.0 was a guess, and this is what came of checking it: the operator's own documentation
 * states NO minimum server version; its image repository publishes tags back to 4.4, so
 * the pullable floor is 4.4; and 6.0 is verified live end to end. So 6.0 stays --
 * deliberately conservative, now evidenced rather than invented.
 */
export const OPERATOR_MIN_MONGO: readonly [number, number] = [6, 0];

/** SCRAM users, matching the guide's names so its commands transfer. */
export const MONGO_ADMIN_USER = 'admin';

export const MONGO_APP_USER = 'rocketchat';

export const MONGO_APP_DB = 'rocketchat';

/**
 * The ServiceAccount the operator puts on the database pod. Not configurable and not
 * namespaced to the operator: the StatefulSet the operator writes into OUR namespace names
 * this account, so it has to exist THERE, not where the operator runs.
 */
export const MONGO_DB_SERVICE_ACCOUNT = 'mongodb-kubernetes-appdb';

/**
 * The operator is OPT-IN until it is proven, and the reason is a regression. The
 * hand-written StatefulSet was verified end to end on a live cluster -- admin login, PVC
 * Bound, data surviving a down/up cycle. Routing MongoDB 6.0+ to the operator by default
 * replaced that with a path whose PVC never binds. A default that breaks the working case
 * is worse than a missing feature.
 */
export const USE_OPERATOR_ENV = 'HOUSTON_MONGO_OPERATOR';

/** Whether to use the operator at all. Off by default -- see `USE_OPERATOR_ENV`. */
export function operatorEnabled(): boolean {
  return ['1', 'true', 'yes'].includes(config.env(USE_OPERATOR_ENV).trim().toLowerCase());
}

/**
 * Whether the operator will manage this MongoDB version.
 *
 * `forced` is `--mongo-operator`: the user asked for it explicitly, so the opt-in switch is
 * satisfied and only the VERSION floor still applies. Asking for the operator on MongoDB
 * 5.0 still falls back, because the operator cannot manage it -- silently ignoring the flag
 * would be worse than the fallback.
 */
export function operatorSupports(mongoTag: string, { forced = false } = {}): boolean {
  if (!forced && !operatorEnabled()) return false;
  const parts = String(mongoTag)
    .split('.')
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return false;
  const [major, minor] = parts as [number, number];
  const [floorMajor, floorMinor] = OPERATOR_MIN_MONGO;
  return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}

/** A label block at the manifest indent the templates below use. */
function labelBlock(name: string, owner: string): string {
  return Object.entries(labelsFor(name, owner))
    .map(([key, value]) => `    ${scalar(key)}: ${scalar(value)}`)
    .join('\n');
}

/** Render the namespaced service account, role and binding. */
function mongoRbacDocument(lab: string): string {
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${MONGO_DB_SERVICE_ACCOUNT}
  labels:
${lab}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${MONGO_DB_SERVICE_ACCOUNT}
  labels:
${lab}
rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["patch", "delete", "get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${MONGO_DB_SERVICE_ACCOUNT}
  labels:
${lab}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${MONGO_DB_SERVICE_ACCOUNT}
subjects:
- kind: ServiceAccount
  name: ${MONGO_DB_SERVICE_ACCOUNT}
`;
}

/**
 * The database pod's ServiceAccount, Role and RoleBinding, in OUR namespace.
 *
 * The guide never mentions these because it installs the operator into the same namespace
 * as MongoDB, where the operator's own chart creates them. houston cannot do that, so the
 * operator lives once in `houston-system` and watches everything -- which works for
 * reconciliation and silently does not work for the database pod.
 *
 * Missing, the failure names none of this: the "forbidden: error looking up service
 * account" is an event on the StatefulSet, while the MongoDBCommunity resource -- the thing
 * anyone would look at -- reports only "Pending ReplicaSet is not yet ready", forever. No
 * pod is ever created, so `WaitForFirstConsumer` keeps both PVCs Pending, which points at
 * storage, which is not the problem.
 */
export function mongoRbacManifest(name: string, { owner = '' }: { owner?: string } = {}): string {
  return mongoRbacDocument(labelBlock(name, owner));
}

/**
 * The guide's Secrets, with generated passwords rather than placeholders.
 *
 * `stringData` so Kubernetes does the base64; writing it ourselves is one more place to get
 * wrong. The passwords never touch disk on this side -- the manifest goes to `kubectl
 * apply` on stdin.
 */
export function mongoSecretManifest(
  name: string,
  {
    adminPassword,
    appPassword,
    owner = '',
  }: { adminPassword: string; appPassword: string; owner?: string },
): string {
  const lab = labelBlock(name, owner);
  const secret = (sname: string, data: Record<string, string>): string => {
    const body = Object.entries(data)
      .map(([key, value]) => `  ${scalar(key)}: ${scalar(value)}`)
      .join('\n');
    return (
      `---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: ${sname}\n` +
      `  labels:\n${lab}\ntype: Opaque\nstringData:\n${body}\n`
    );
  };
  return [
    secret('mongodb-admin-password', { password: adminPassword }),
    secret('mongodb-rocketchat-password', { password: appPassword }),
    secret('admin-scram-credentials', { username: MONGO_ADMIN_USER, password: adminPassword }),
    secret('rocketchat-scram-credentials', { username: MONGO_APP_USER, password: appPassword }),
  ].join('');
}

/**
 * A full MongoDB release version for the operator's `spec.version`.
 *
 * houston carries a Docker TAG -- "8.0" -- because that is what pulls an image. The operator
 * wants a RELEASE version and the guide shows "8.0.0"; given "8.0" it accepts the resource
 * and then never reconciles it, so the workspace sits at no `.status.phase` until the wait
 * gives up. The failure names nothing: the resource exists, the operator is healthy, and
 * MongoDB simply never appears.
 */
export function operatorVersion(tag: string): string {
  const parts = String(tag).split('.');
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

/** The data and logs claims required by the operator-managed pod. */
function mongodbVolumeClaims(storageGb: number): string {
  return `      volumeClaimTemplates:
      - metadata:
          name: data-volume
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: ${String(storageGb)}Gi
      # \`logs-volume\` as well as \`data-volume\`, because overriding
      # volumeClaimTemplates REPLACES the operator's list rather than merging with
      # it -- confirmed by watching a run that declared only data-volume produce
      # exactly one PVC -- while both of the pod's containers mount both volumes:
      #
      #   mongod:         data-volume ... logs-volume ...
      #   mongodb-agent:  data-volume ... logs-volume ...
      #
      # so a template list that drops one leaves the pod referencing a claim nothing
      # creates. The guide shows only data-volume because its example is the whole
      # override, and it is reproduced here in full for the same reason.
      - metadata:
          name: logs-volume
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 2Gi
`;
}

/**
 * The guide's MongoDBCommunity resource.
 *
 * `type: ReplicaSet` with `members: 1` is what makes this worth doing: the operator owns
 * initiation, readiness and the bootstrap DNS -- the three things that produced four
 * separate live failures when this module did them by hand.
 *
 * The text is the established one byte for byte, as it reaches `kubectl apply -f -`:
 * `version:` is always double-quoted there (the tag is validated to letters, digits, `.`,
 * `_` and `-` before it gets here), and two YAML comments keep their established full
 * length.
 */
export function mongodbCommunityManifest(
  name: string,
  tag: string,
  { owner = '', storageGb = MONGO_VOLUME_GB }: { owner?: string; storageGb?: number } = {},
): string {
  return `apiVersion: mongodbcommunity.mongodb.com/v1
kind: MongoDBCommunity
metadata:
  name: ${MONGO_SERVICE}
  labels:
${labelBlock(name, owner)}
spec:
  members: 1
  type: ReplicaSet
  version: "${operatorVersion(tag)}"
  security:
    authentication:
      modes: ["SCRAM"]
    tls:
      enabled: false
  users:
  - name: ${MONGO_ADMIN_USER}
    db: admin
    passwordSecretRef:
      name: mongodb-admin-password
    scramCredentialsSecretName: admin-scram-credentials
    roles:
    - name: root
      db: admin
  - name: ${MONGO_APP_USER}
    db: ${MONGO_APP_DB}
    passwordSecretRef:
      name: mongodb-rocketchat-password
    scramCredentialsSecretName: rocketchat-scram-credentials
    roles:
    - name: readWrite
      db: ${MONGO_APP_DB}
    # clusterMonitor is what makes MONGO_OPLOG_URL work, and it is what Rocket.Chat's
    # OWN chart grants: templates/mongodb-init-configmap.yaml runs
    #   db.getSiblingDB('<db>').grantRolesToUser('<user>',
    #       [{ role: 'clusterMonitor', db: 'admin' }])
    # against its bundled MongoDB, commenting "having clusterMonitor role shouldn't
    # hurt". readWrite on the app database alone cannot read \`local\`, so Rocket.Chat
    # below 8.x -- the only versions that still tail the oplog -- could authenticate
    # and then fail to tail. This is upstream's answer, not an invention.
    - name: clusterMonitor
      db: admin
  statefulSet:
    spec:
${mongodbVolumeClaims(storageGb)}`;
}

/**
 * The Secret the chart reads its MongoDB URL from, instead of the URL sitting in the
 * release's values where `helm get values rocketchat` prints it in full -- password
 * included -- to anyone with read access to the namespace.
 */
export const MONGO_URL_SECRET = 'rocketchat-mongodb-url';

/**
 * The EE registration token travels in its own Opaque Secret, referenced from the container
 * env by `valueFrom`. NEVER in helm values or `extraEnv` as a literal: values are readable
 * with `helm get values`, and houston also writes them to
 * `repros/<n>/kubernetes/values.yaml` for a human to read. The manifest goes to stdin so the
 * token never appears in argv either, where `ps` would show it to every user on the box.
 */
export const REG_TOKEN_SECRET = 'houston-reg-token';

export const REG_TOKEN_KEY = 'token';

/** An Opaque Secret holding the cloud registration token. */
export function regTokenSecretManifest(
  name: string,
  { token, owner = '' }: { token: string; owner?: string },
): string {
  return YAML.stringify(
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: REG_TOKEN_SECRET, labels: labelsFor(name, owner) },
      type: 'Opaque',
      stringData: { [REG_TOKEN_KEY]: token },
    },
    { compat: 'yaml-1.1', indentSeq: false, lineWidth: 0 },
  );
}

/**
 * A Secret holding the connection strings, for `existingMongodbSecret`.
 *
 * BOTH keys, always. Chart 6.26.0 reads `mongo-uri` and `mongo-oplog-uri` from this Secret
 * unconditionally once `existingMongodbSecret` is set -- there is no `if oplog` around the
 * second one -- so omitting it on a chart that wants it leaves the pod unable to start on a
 * missing key.
 */
export function mongoUrlSecretManifest(
  name: string,
  { mongoUrl, oplogUrl, owner = '' }: { mongoUrl: string; oplogUrl: string; owner?: string },
): string {
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${MONGO_URL_SECRET}
  labels:
${labelBlock(name, owner)}
type: Opaque
stringData:
  mongo-uri: ${scalar(mongoUrl)}
  mongo-oplog-uri: ${scalar(oplogUrl)}
`;
}

/**
 * The authenticated URI, built as the guide builds it.
 *
 * The operator names its service `<name>-svc`, not `<name>` -- a detail worth stating,
 * because the hand-written path uses the bare name and the two are not interchangeable.
 *
 * `authSource` is on BOTH forms, and the oplog one is where it was missing. The oplog URL
 * addresses the `local` DATABASE, but the user is defined in the app database -- and
 * without authSource the driver authenticates against the database in the path, so it
 * looked for a user in `local` that has never existed there.
 */
export function operatorMongoUrl(
  namespace: string,
  password: string,
  { oplog = false }: { oplog?: boolean } = {},
): string {
  const db = oplog ? 'local' : MONGO_APP_DB;
  return (
    `mongodb://${MONGO_APP_USER}:${password}@` +
    `${MONGO_SERVICE}-0.${MONGO_SERVICE}-svc.${namespace}.svc.cluster.local:27017/` +
    `${db}?replicaSet=${MONGO_SERVICE}&authSource=${MONGO_APP_DB}`
  );
}

/**
 * `mongodump`/`mongorestore` flags for an operator-managed MongoDB.
 *
 * The operator enables SCRAM, so an unauthenticated `mongodump` fails with "Command
 * listCollections requires authentication" -- which is exactly what it did: backup was
 * broken on the operator path, the path the official guide recommends, while working
 * perfectly on the hand-written StatefulSet that has no auth.
 *
 * The password is read back out of the Secret rather than kept anywhere: it is generated at
 * create time and deliberately never written to disk.
 */
export async function mongoToolAuth(
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
      'secret',
      'mongodb-rocketchat-password',
      '-o',
      'jsonpath={.data.password}',
    ],
    { own: isOurs(context) },
  );
  const encoded = res.stdout.trim();
  if (res.returncode !== 0 || encoded === '') return [];
  let password: string;
  try {
    password = Buffer.from(encoded, 'base64').toString('utf8').trim();
  } catch {
    return [];
  }
  if (password === '') return [];
  // authenticationDatabase is the APP database, not `admin`: the app user is DEFINED in the
  // application database, and authenticating against admin looks for a user that was never
  // created there.
  return [
    '--username',
    MONGO_APP_USER,
    '--password',
    password,
    '--authenticationDatabase',
    MONGO_APP_DB,
  ];
}

/**
 * The CRD that defines "MongoDBCommunity resources exist in this cluster". Presence is keyed
 * on this and NOT on houston's release name: an operator a platform team installed --
 * different namespace, different release, or plain manifests -- is invisible to a question
 * asked about our release.
 */
export const MONGODB_CRD = 'mongodbcommunity.mongodb.com';

/**
 * The env var the community operator reads to decide what it reconciles. Empty means its own
 * namespace only; `*` means the whole cluster.
 */
export const WATCH_ENV = 'WATCH_NAMESPACE';

/**
 * Whether a MongoDB Community operator's CRD is here, whoever installed it.
 *
 * THE ASYMMETRY THIS CLOSES: cert-manager is keyed on its CRD and ingress on any existing
 * IngressClass, and both therefore ADOPT a foreign install. The MongoDB operator was the one
 * place that principle was not applied -- it asked whether houston's own release existed in
 * houston's own namespace, so a platform team's operator was invisible and `helm upgrade
 * --install` ran anyway.
 */
export async function operatorPresence(context: string): Promise<Answer> {
  return await askObject('crd', MONGODB_CRD, { context });
}

/**
 * Whether the CRD in `seen` is managed by houston's own helm release.
 *
 * Helm stamps every resource it manages with `meta.helm.sh/release-name` and
 * `meta.helm.sh/release-namespace`, so the CRD itself says who owns it. A CRD with no such
 * annotations was applied by something other than helm and is nobody's release; it is
 * emphatically not ours.
 */
export function operatorIsOurs(seen: Answer): boolean {
  const doc = present(seen) ? seen.doc : {};
  const meta = doc.metadata;
  const annotations =
    meta !== null && typeof meta === 'object'
      ? ((meta as { annotations?: Record<string, unknown> }).annotations ?? {})
      : {};
  return (
    annotations['meta.helm.sh/release-name'] === OPERATOR_RELEASE &&
    annotations['meta.helm.sh/release-namespace'] === OPERATOR_NAMESPACE
  );
}

/**
 * `[what the operator on this cluster watches, why that could not be read]`.
 *
 * An adopted operator is only useful if it reconciles the namespace the workspace goes in.
 *
 * BEST EFFORT, and the caller must treat a reason as "I could not ask" rather than as "it
 * does not watch us". Adopting is the action that installs nothing, so it is the safe thing
 * to do when the scope is unknown; refusing on ignorance would break every cluster whose
 * operator we simply could not introspect.
 */
export async function operatorWatchScope(context: string): Promise<[string, string]> {
  const found = await askList('deployments', { context, allNamespaces: true });
  if (refused(found)) {
    return ['', found.res !== undefined ? why(found.res, { limit: 120 }) : 'could not be listed'];
  }
  for (const dep of items(found)) {
    const spec = dep.spec as
      { template?: { spec?: { containers?: Record<string, unknown>[] } } } | undefined;
    for (const container of spec?.template?.spec?.containers ?? []) {
      for (const env of (container.env ?? []) as Record<string, unknown>[]) {
        if (env.name !== WATCH_ENV) continue;
        // `valueFrom` (a fieldRef to the pod's own namespace) is the chart's
        // single-namespace default. It is a real answer -- own namespace only -- and not
        // an unreadable one.
        if (!('value' in env)) {
          const meta = dep.metadata as { namespace?: string } | undefined;
          return [meta?.namespace ?? '', ''];
        }
        return [String(env.value ?? ''), ''];
      }
    }
  }
  return ['', 'no operator Deployment was found'];
}

/** Whether `scope` covers `namespace`. `*` or empty-with-no-reason means all. */
export function operatorWatches(scope: string, namespace: string): boolean {
  if (scope === '*' || scope === '') return true;
  return scope
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .includes(namespace);
}

/** Install houston's shared operator release after adoption checks pass. */
async function installOperator(context: string, emit: Emit): Promise<void> {
  await kube.run(['helm', 'repo', 'add', OPERATOR_REPO, OPERATOR_REPO_URL, '--force-update'], {
    timeout: APPLY_TIMEOUT,
    env: helmEnv(context),
  });
  await kube.run(['helm', 'repo', 'update', OPERATOR_REPO], {
    timeout: APPLY_TIMEOUT,
    env: helmEnv(context),
  });
  info(emit, `MongoDB operator in ${OPERATOR_NAMESPACE} (once per cluster)`, {
    phase: 'provision',
    pct: 15,
  });
  // A KILLED INSTALL WEDGES THIS FOR EVERY WORKSPACE ON THE CLUSTER, which is why it matters
  // more here than for a workspace's own release: `houston-system` is shared, so one Ctrl-C
  // inside the five-minute `--wait` leaves every later `--mongo-operator` failing with
  // "another operation is in progress".
  await clearPendingRelease(OPERATOR_RELEASE, OPERATOR_NAMESPACE, context, { emit });
  const res = await kube.run(
    [
      'helm',
      'upgrade',
      '--install',
      OPERATOR_RELEASE,
      OPERATOR_CHART,
      '--kube-context',
      context,
      '-n',
      OPERATOR_NAMESPACE,
      '--create-namespace',
      '--set',
      'operator.watchNamespace=*',
      // TELEMETRY OFF. The chart sends the cluster UID, the Kubernetes version and
      // deployment UIDs to MongoDB on a weekly timer, enabled by default. Nobody using a
      // support reproduction tool opted into third-party analytics about the cluster they
      // are debugging on, and on a customer's adopted cluster houston would be the thing
      // that started it.
      '--set',
      'operator.telemetry.send.enabled=false',
      '--set',
      'operator.telemetry.collection.enabled=false',
      '--wait',
      '--timeout',
      '5m',
      ...(await helmRollbackOnFailure()),
    ],
    { timeout: INSTALL_TIMEOUT, env: helmEnv(context) },
  );
  if (res.returncode !== 0) {
    throw new CreateFailedError(`could not install the MongoDB operator: ${why(res)}`);
  }
}

/**
 * Install the MongoDB operator once for the cluster, watching all namespaces.
 *
 * Cluster-scoped by necessity, not by preference: the chart manages CRDs, and CRDs are not
 * namespaced. Installing it per workspace collides on them at the second workspace.
 *
 * AND IT ADOPTS RATHER THAN INSTALLS when the operator is somebody else's.
 */
export async function ensureOperator({
  context,
  namespace = '',
  emit = nullEmit,
}: {
  context: string;
  namespace?: string;
  emit?: Emit;
}): Promise<void> {
  // ASKED BEFORE ANYTHING IS WRITTEN, including the helm repo add. Nothing below this point
  // should run on a cluster whose operator houston does not own.
  const seen = await operatorPresence(context);
  if (seen.state === REFUSED) {
    // "I could not ask" is not "there is none", and the action on the other side of this
    // question installs CLUSTER-SCOPED CRDs. Getting it wrong on a shared cluster reaches
    // other people's databases, so this is the one place the module's rule has to produce a
    // refusal rather than a best guess.
    throw new PreflightError(
      'cannot tell whether this cluster already has a MongoDB operator: the ' +
        `${MONGODB_CRD} CRD could not be read (` +
        (seen.res !== undefined ? why(seen.res, { limit: 160 }) : 'no reason given') +
        '). Installing one anyway would take ownership of cluster-scoped CRDs that may ' +
        'belong to somebody else. Grant read on customresourcedefinitions, or run without ' +
        "`--mongo-operator` to use the chart's own MongoDB.",
    );
  }
  if (present(seen) && !operatorIsOurs(seen)) {
    const [scope, unreadable] = await operatorWatchScope(context);
    // AGAINST THE NAMESPACE THIS WORKSPACE ACTUALLY GOES IN. houston's namespaces are
    // `houston-<name>`, a prefix and not one fixed name. With no namespace to check the
    // scope is not a question that can be answered, so it is not asked.
    if (namespace !== '' && unreadable === '' && !operatorWatches(scope, namespace)) {
      // A real answer, and it does not cover us. Said as a refusal rather than left to
      // become a five-minute timeout on a workspace whose database nothing was ever going
      // to reconcile.
      throw new PreflightError(
        'this cluster has a MongoDB operator that houston did not install, and it watches ' +
          `'${scope}' — which does not include '${namespace}'. Installing a second ` +
          'cluster-scoped operator beside it would have both reconcile the same resources. ' +
          'Ask whoever owns it to watch `*`, or run without `--mongo-operator`.',
      );
    }
    const adopted =
      unreadable === ''
        ? `watching ${scope !== '' ? scope : 'its own namespace'}`
        : `scope unread: ${unreadable}`;
    info(
      emit,
      `adopting the MongoDB operator already in this cluster (${adopted}) — houston ` +
        'installs nothing and removes nothing',
      { phase: 'provision', pct: 15 },
    );
    return;
  }
  await installOperator(context, emit);
}

/**
 * Namespaces that still hold a `MongoDBCommunity`, i.e. still need the operator.
 *
 * Empty when the CRD is not installed at all, which is the answer, not an error.
 */
export async function mongodbResources(context: string): Promise<string[] | null> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      'get',
      'mongodbcommunity',
      '-A',
      '--ignore-not-found',
      '-o',
      'jsonpath={range .items[*]}{.metadata.namespace}{"\\n"}{end}',
    ],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    // null, not []: this is the SHARED operator's reference count, and an empty one means
    // "uninstall it". A read nobody could perform is not evidence that nothing needs it.
    return null;
  }
  return [...new Set(res.stdout.split(/\s+/u).filter((entry) => entry !== ''))].sort();
}

/**
 * Whether a helm release is in this cluster. Used before uninstalling one, so "there was
 * nothing there" is reported as nothing rather than as a failure.
 */
export async function releaseInstalled(
  release: string,
  namespace: string,
  context: string,
): Promise<boolean> {
  try {
    return (await releaseState(release, namespace, context))[0] !== '';
  } catch (error) {
    // These callers ask before an uninstall. Not knowing is not "absent", and the uninstall
    // itself reports its own failure honestly, so let it try.
    if (error instanceof DockerError) return true;
    throw error;
  }
}

/** Whether the shared MongoDB operator release is in this cluster. */
export async function operatorInstalled(context: string): Promise<boolean> {
  return await releaseInstalled(OPERATOR_RELEASE, OPERATOR_NAMESPACE, context);
}

/** Remove houston's operator release while retaining its shared CRD. */
async function uninstallOperator(context: string, emit: Emit): Promise<boolean> {
  info(
    emit,
    `uninstalling the MongoDB operator from ${OPERATOR_NAMESPACE} — nothing is using it now`,
    { phase: 'teardown' },
  );
  const res = await kube.run(
    [
      'helm',
      'uninstall',
      OPERATOR_RELEASE,
      '--kube-context',
      context,
      '-n',
      OPERATOR_NAMESPACE,
      '--wait',
      '--timeout',
      '5m',
    ],
    { timeout: INSTALL_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    // Not an error worth failing a teardown for: the workspace is already gone and the next
    // `--mongo-operator` runs `upgrade --install`, which repairs it.
    warn(
      emit,
      `the MongoDB operator could not be uninstalled and is still running in ` +
        `${OPERATOR_NAMESPACE}: ${why(res)}`,
      { phase: 'teardown' },
    );
    return false;
  }
  return true;
}

/**
 * Uninstall the shared MongoDB operator once nothing is using it any more.
 *
 * The ORDER is what makes removing it safe rather than destructive. The custom resources go
 * FIRST, and they already have: this is called after the workspace's namespace is deleted,
 * which takes its `MongoDBCommunity` with it while the operator is still alive to clear the
 * finalizer. Removing the operator first deadlocks on a resource nothing is left to
 * finalise, and the namespace then sits in Terminating forever.
 *
 * The reference count is a real check: with a second workspace still holding a
 * `MongoDBCommunity`, removing the operator leaves its finalizer with nothing to clear it.
 *
 * The CRD stays. `helm uninstall` does not remove it anyway, and deleting it would delete
 * every `MongoDBCommunity` in the cluster -- every other workspace's database, instantly.
 */
export async function removeOperator({
  context,
  excluding = '',
  emit = nullEmit,
}: {
  context: string;
  excluding?: string;
  emit?: Emit;
}): Promise<boolean> {
  // OURS, DELIBERATELY, and this is the guard that makes adoption safe: an operator houston
  // adopted was never installed as our release, so this answers false for it and the
  // uninstall below is never reached.
  if (!(await operatorInstalled(context))) return false;
  // `excluding` because the workspace being destroyed must not be counted as still needing
  // the operator. Its MongoDBCommunity is normally gone by the time the namespace finishes,
  // but "normally" is a race.
  const using = await mongodbResources(context);
  if (using === null) {
    warn(
      emit,
      'not removing the shared MongoDB operator: its MongoDBCommunity resources could not ' +
        'be listed, so whether another workspace still needs it is unknown. Removing it ' +
        'would leave their finalizers with nothing to clear.',
      { phase: 'teardown' },
    );
    return false;
  }
  const still = using.filter((ns) => ns !== excluding);
  if (still.length > 0) {
    info(
      emit,
      'leaving the MongoDB operator up — still used by ' +
        still
          .map((ns) => (ns.startsWith(NAMESPACE_PREFIX) ? ns.slice(NAMESPACE_PREFIX.length) : ns))
          .join(', '),
      { phase: 'teardown' },
    );
    return false;
  }
  return await uninstallOperator(context, emit);
}

/**
 * Wait for the operator to report the MongoDBCommunity Running.
 *
 * The operator owns initiation and readiness, so this asks IT rather than poking mongod --
 * which is the whole point of using it. `.status.phase` is the resource's own answer; there
 * is no exec, no rs.initiate and no readiness probe to race.
 */
export async function waitForMongodb({
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
  for (let attempt = 0; attempt < tuning.MONGO_READY_TRIES; attempt += 1) {
    const res = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        namespace,
        'get',
        'mongodbcommunity',
        MONGO_SERVICE,
        '-o',
        'jsonpath={.status.phase}',
      ],
      { own: isOurs(context) },
    );
    if (res.stdout.trim() === 'Running') {
      info(emit, 'MongoDB ready (operator-managed, SCRAM)', { phase: 'boot' });
      return;
    }
    if (attempt % 6 === 0) {
      info(emit, 'waiting for the operator to bring MongoDB up', { phase: 'wait' });
    }
    await sleep(MONGO_READY_INTERVAL);
  }
  // Say what the resource itself reports. An empty phase means the operator never reconciled
  // it at all -- which is what an unusable `spec.version` looks like, and "did not come up"
  // sent the reader to the wrong place for it.
  const detail = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'mongodbcommunity',
      MONGO_SERVICE,
      '-o',
      'jsonpath={.status.phase}{" "}{.status.message}',
    ],
    { own: isOurs(context) },
  );
  const said = detail.stdout.trim();
  throw new CreateFailedError(
    'the operator did not bring MongoDB up' +
      (said !== ''
        ? ` — it reports: ${said}`
        : ' — and reports no status at all, which means it never reconciled the resource ' +
          '(usually an unusable spec.version)') +
      `. kubectl -n ${namespace} describe mongodbcommunity ${MONGO_SERVICE}`,
  );
}
