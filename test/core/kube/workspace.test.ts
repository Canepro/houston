/**
 * Tier k5: the orchestrator, and the four decisions only it can get wrong.
 *
 * Everything this module does is done by a module below it, so the cases are not about what
 * those do -- their own specs cover that. They are about ORDER, about which branch ran, and
 * about what a failure half-way through is entitled to destroy. Each collaborator that
 * touches a cluster is replaced; every pure function stays real, so a manifest asserted on
 * here is the manifest that would be applied.
 */
import { CreateFailedError } from '../../../src/lib/errors';
import type { Event } from '../../../src/lib/events';
import type { Resolved } from '../../../src/lib/versions';

import * as capabilities from '../../../src/core/kube/capabilities';
import * as certmanager from '../../../src/core/kube/certmanager';
import * as chart from '../../../src/core/kube/chart';
import * as cluster from '../../../src/core/kube/cluster';
import * as context from '../../../src/core/kube/context';
import { kube } from '../../../src/core/kube/exec';
import * as forward from '../../../src/core/kube/forward';
import * as manifests from '../../../src/core/kube/manifests';
import { MONGO_URL, RELEASE } from '../../../src/core/kube/names';
import * as namespace from '../../../src/core/kube/namespace';
import * as operator from '../../../src/core/kube/operator';
import * as probe from '../../../src/core/kube/probe';
import * as release from '../../../src/core/kube/release';
import * as replicaset from '../../../src/core/kube/replicaset';

import type * as tools from '../../../src/core/kube/tools';
import type * as presetTypes from '../../../src/lib/presets/types';

import { createWorkspace, type CreateWorkspaceOptions } from '../../../src/core/kube/workspace';

// Only the calls that reach a cluster are replaced. `mongoRbacManifest`, `mongoManifest`,
// `operatorMongoUrl`, `valuesFor` and `mongoImage` all stay real.
jest.mock('../../../src/core/kube/chart', () => ({
  ...jest.requireActual('../../../src/core/kube/chart'),
  ensureRepo: jest.fn(),
  resolveChartVersion: jest.fn(),
}));
jest.mock('../../../src/core/kube/cluster', () => ({
  ...jest.requireActual('../../../src/core/kube/cluster'),
  ensureKubeconfig: jest.fn(),
  deleteCluster: jest.fn(),
}));
jest.mock('../../../src/core/kube/context', () => ({
  ...jest.requireActual('../../../src/core/kube/context'),
  planCluster: jest.fn(),
}));
jest.mock('../../../src/core/kube/capabilities', () => ({
  ...jest.requireActual('../../../src/core/kube/capabilities'),
  workspaceNamespaces: jest.fn(),
}));
jest.mock('../../../src/core/kube/namespace', () => ({
  ...jest.requireActual('../../../src/core/kube/namespace'),
  namespaceFor: jest.fn(),
  ensureNamespace: jest.fn(),
}));
jest.mock('../../../src/core/kube/probe', () => ({
  ...jest.requireActual('../../../src/core/kube/probe'),
  preflight: jest.fn(),
}));
jest.mock('../../../src/core/kube/operator', () => ({
  ...jest.requireActual('../../../src/core/kube/operator'),
  ensureOperator: jest.fn(),
  waitForMongodb: jest.fn(),
}));
jest.mock('../../../src/core/kube/release', () => ({
  ...jest.requireActual('../../../src/core/kube/release'),
  apply: jest.fn(),
  install: jest.fn(),
}));
jest.mock('../../../src/core/kube/replicaset', () => ({
  ...jest.requireActual('../../../src/core/kube/replicaset'),
  initReplicaSet: jest.fn(),
}));
jest.mock('../../../src/core/kube/manifests', () => ({
  ...jest.requireActual('../../../src/core/kube/manifests'),
  containerSecurityContext: jest.fn(),
  recordRendered: jest.fn(),
}));
jest.mock('../../../src/core/kube/certmanager', () => ({
  ...jest.requireActual('../../../src/core/kube/certmanager'),
  ensureIssuer: jest.fn(),
  waitForCertificate: jest.fn(),
}));
jest.mock('../../../src/core/kube/forward', () => ({
  ...jest.requireActual('../../../src/core/kube/forward'),
  portForward: jest.fn(),
  forwardAlive: jest.fn(),
  scenarioUiForwards: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

const RESOLVED: Resolved = {
  rcVersion: '8.5.1',
  rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
  mongoTag: '8.0',
  mongoFlavor: 'official',
  mongoShell: 'mongosh',
  oplog: false,
  source: 'map (fallback)',
  note: '',
};

const realRun = kube.run;

/** Every argv the orchestrator's own `kube.run` saw -- the rollback is the only one. */
let ran: string[][] = [];

function harness({
  plan = { context: 'prod', distribution: 'k3s', create: false },
  held = [] as string[] | null,
  alive = true,
}: {
  plan?: { context: string; distribution: string; create: boolean };
  held?: string[] | null;
  alive?: boolean;
} = {}): void {
  // The call history goes too, not only `ran`: several cases build a second workspace to
  // contrast with the first, and a `mock.calls[0]` that still belongs to the previous one
  // asserts about the wrong create.
  jest.clearAllMocks();
  ran = [];
  kube.run = (argv) => {
    ran.push([...argv]);
    return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
  };
  mocked(context.planCluster).mockResolvedValue(plan);
  mocked(cluster.ensureKubeconfig).mockResolvedValue(plan.context);
  mocked(cluster.deleteCluster).mockResolvedValue(true);
  mocked(chart.ensureRepo).mockResolvedValue(undefined);
  mocked(chart.resolveChartVersion).mockResolvedValue('7.0.2');
  mocked(probe.preflight).mockResolvedValue({
    ...(jest.requireActual('../../../src/core/kube/tools') as typeof tools).preflight(),
    context: plan.context,
    clusterReachable: true,
    defaultStorageClass: 'local-path',
    architectures: ['amd64'],
    unreadable: [],
  });
  mocked(capabilities.workspaceNamespaces).mockResolvedValue(held);
  mocked(namespace.namespaceFor).mockResolvedValue('houston-tk');
  mocked(namespace.ensureNamespace).mockResolvedValue('houston-tk');
  mocked(operator.ensureOperator).mockResolvedValue(undefined);
  mocked(operator.waitForMongodb).mockResolvedValue(undefined);
  mocked(release.apply).mockResolvedValue(undefined);
  mocked(release.install).mockResolvedValue(undefined);
  mocked(replicaset.initReplicaSet).mockResolvedValue(undefined);
  mocked(manifests.containerSecurityContext).mockResolvedValue({});
  mocked(manifests.recordRendered).mockResolvedValue([]);
  mocked(certmanager.ensureIssuer).mockResolvedValue(undefined);
  mocked(certmanager.waitForCertificate).mockResolvedValue(true);
  mocked(forward.portForward).mockResolvedValue(4242);
  mocked(forward.forwardAlive).mockReturnValue(alive);
  mocked(forward.scenarioUiForwards).mockResolvedValue({ 8081: 5151 });
}

/** The manifests handed to `apply`, in the order they were handed over. */
const applied = () => mocked(release.apply).mock.calls.map((call) => String(call[0]));

const create = (extra: Partial<CreateWorkspaceOptions> = {}) =>
  createWorkspace({
    name: 'tk',
    resolved: RESOLVED,
    hostPort: 3000,
    microservices: false,
    sleep: () => Promise.resolve(),
    ...extra,
  });

afterEach(() => {
  kube.run = realRun;
});

describe('the order a create happens in', () => {
  it('applies the RBAC before the MongoDBCommunity that needs it', async () => {
    // The RoleBinding has to exist before the StatefulSet tries to create a pod, or the pod
    // is rejected -- "forbidden: error looking up service account" -- and the operator backs
    // off. The MongoDBCommunity resource, which is the thing anyone would look at, reports
    // only "Pending ReplicaSet is not yet ready", forever.
    harness();
    await create({ useOperator: true });
    const docs = applied();
    const rbac = docs.findIndex((doc) => doc.includes('kind: ServiceAccount'));
    const community = docs.findIndex((doc) => doc.includes('kind: MongoDBCommunity'));
    expect(rbac).toBeGreaterThanOrEqual(0);
    expect(community).toBeGreaterThanOrEqual(0);
    expect(rbac).toBeLessThan(community);
  });

  it('initiates the replica set BEFORE the chart goes in', async () => {
    // Rocket.Chat needs change streams, so a chart installed against an uninitiated set sits
    // at not-ready with nothing in its logs naming MongoDB.
    harness();
    const order: string[] = [];
    mocked(replicaset.initReplicaSet).mockImplementation(() => {
      order.push('replicaset');
      return Promise.resolve();
    });
    mocked(release.install).mockImplementation(() => {
      order.push('install');
      return Promise.resolve();
    });
    await create();
    expect(order).toEqual(['replicaset', 'install']);
  });

  it('waits for the certificate AFTER the create can no longer be rolled back', async () => {
    // cert-manager issues asynchronously from the Ingress annotation, so a certificate that
    // has not arrived is the difference between "the name works" and "the name will work in
    // a moment". It must not destroy a workspace that installed perfectly well.
    harness({ held: [] });
    mocked(certmanager.waitForCertificate).mockResolvedValue(false);
    const record = await create({ tlsHost: 'rc.example.test', ingressClass: 'traefik' });
    expect(record.certificate_ready).toBe(false);
    expect(ran.some((argv) => argv.includes('delete'))).toBe(false);
  });
});

describe('what a failed create is entitled to destroy', () => {
  it('removes a namespace it introduced', async () => {
    harness({ held: [] });
    mocked(release.install).mockRejectedValue(new CreateFailedError('helm said no'));
    const events: Event[] = [];
    await expect(create({ emit: (event) => events.push(event) })).rejects.toBeInstanceOf(
      CreateFailedError,
    );
    const deleted = ran.find((argv) => argv.includes('delete'));
    expect(deleted).toContain('houston-tk');
    expect(deleted).toContain('--wait=false');
  });

  it('leaves a namespace that was already there, and its volume with it', async () => {
    // A re-create over a namespace kept by `down` must not have its rollback delete that
    // namespace: the PVC goes with it, and `down` had just promised the data would be there.
    harness({ held: ['houston-tk'] });
    mocked(release.install).mockRejectedValue(new CreateFailedError('helm said no'));
    const events: Event[] = [];
    await expect(create({ emit: (event) => events.push(event) })).rejects.toBeInstanceOf(
      CreateFailedError,
    );
    expect(ran.some((argv) => argv.includes('delete'))).toBe(false);
    expect(events.map((event) => event.message).join(' ')).toContain('left as they were');
  });

  it('treats a namespace list it could not read as "it was already there"', async () => {
    // REFUSED READS COUNT AS PRE-EXISTING: never destroy data we could not prove was ours to
    // destroy. `workspaceNamespaces` answers null for a read nobody could perform, and the
    // direction of that mistake is the whole reason it does.
    harness({ held: null });
    mocked(release.install).mockRejectedValue(new CreateFailedError('helm said no'));
    await expect(create()).rejects.toBeInstanceOf(CreateFailedError);
    expect(ran.some((argv) => argv.includes('delete'))).toBe(false);
  });

  it('takes the cluster only when this call created it', async () => {
    harness({ plan: { context: 'kind-houston-local', distribution: 'kind', create: true } });
    mocked(release.install).mockRejectedValue(new CreateFailedError('helm said no'));
    await expect(create()).rejects.toBeInstanceOf(CreateFailedError);
    expect(mocked(cluster.deleteCluster)).toHaveBeenCalled();

    harness({ plan: { context: 'prod', distribution: 'k3s', create: false }, held: [] });
    mocked(release.install).mockRejectedValue(new CreateFailedError('helm said no'));
    await expect(create()).rejects.toBeInstanceOf(CreateFailedError);
    expect(mocked(cluster.deleteCluster)).not.toHaveBeenCalled();
  });

  it('does not let the rollback replace the failure that caused it', async () => {
    // The ORIGINAL failure is what the caller needs. A delete that throws -- an unreachable
    // cluster, most likely, which is also the likeliest reason the create failed -- must not
    // become the error that is reported.
    harness({ held: [] });
    mocked(release.install).mockRejectedValue(new CreateFailedError('helm said no'));
    kube.run = () => Promise.reject(new Error('the cluster is gone'));
    await expect(create()).rejects.toThrow(/helm said no/u);
  });
});

describe('what the record says', () => {
  it('names what built the database, on both paths', async () => {
    // `mongoFlavor` is "official"/"bitnami-legacy", which is a COMPOSE image choice the
    // Kubernetes StatefulSet honours neither of -- so reporting it made `list` print
    // "8.0 (official)" for a workspace running Docker Hub's `mongo:8.0`. A label describing
    // an image the workspace does not run is worse than none, because it is the field
    // somebody checks when a version-specific bug will not reproduce.
    harness();
    const statefulset = await create();
    expect(statefulset.mongo_managed_by).toBe('statefulset');
    expect(statefulset.mongo_image).toBe('mongo:8.0');

    harness();
    const operatorRun = await create({ useOperator: true });
    expect(operatorRun.mongo_managed_by).toBe('operator');
    // THREE PARTS, because given "8.0" the operator accepts the resource and never
    // reconciles it.
    expect(operatorRun.mongo_image).toBe("mongodb-community-server 8.0.0 (operator's choice)");
  });

  it('reports the forward that did not stay up as no forward at all', async () => {
    // A recorded pid for a forward that is gone is worse than a zero: `ready` believes it.
    harness({ alive: false });
    const events: Event[] = [];
    const record = await create({ emit: (event) => events.push(event) });
    expect(record.port_forward_pid).toBe(0);
    const said = events.map((event) => event.message).join(' ');
    expect(said).toContain(`deployment/${RELEASE}-rocketchat 3000:3000`);
    expect(said).toContain('houston ready --name tk');
  });

  it('carries the scenario forwards back with string keys, as repro.json holds them', async () => {
    harness();
    expect((await create()).scenario_forwards).toEqual({ 8081: 5151 });
  });
});

describe('the values the release is installed with', () => {
  const valuesOf = () =>
    (mocked(release.install).mock.calls[0]?.[0] as { values: Record<string, unknown> }).values;

  it('gives the chart a host OR a root_url, never both', async () => {
    // Two entries for ROOT_URL is a server-side-apply conflict, not an override -- so a
    // workspace with a TLS host must not also carry the port-forward URL.
    harness();
    await create({ tlsHost: 'rc.example.test', ingressClass: 'traefik', rootUrl: 'http://x:3000' });
    const values = valuesOf();
    expect(values.host).toBe('rc.example.test');
    expect((values.extraEnv as { name: string }[]).map((entry) => entry.name)).not.toContain(
      'ROOT_URL',
    );

    harness();
    await create({ rootUrl: 'http://localhost:3000' });
    expect(valuesOf().host).toBeUndefined();
    expect((valuesOf().extraEnv as { name: string }[]).map((entry) => entry.name)).toContain(
      'ROOT_URL',
    );
  });

  it('passes the MongoDB URL by Secret reference, never in the values', async () => {
    // `helm get values rocketchat` prints values in full to anyone who can read the
    // namespace, and houston writes them into the workspace directory for a human as well.
    harness();
    await create({ useOperator: true });
    const values = valuesOf();
    expect(values.existingMongodbSecret).toBe('rocketchat-mongodb-url');
    expect(JSON.stringify(values)).not.toContain('mongodb://');
    // The URL itself travels in the Secret manifest, which goes to kubectl on stdin.
    const secret = applied().find((doc) => doc.includes('rocketchat-mongodb-url'));
    expect(secret).toContain('mongodb://rocketchat:');
    expect(secret).toContain('authSource=rocketchat');
  });

  it('falls back to the unauthenticated StatefulSet URL when the operator is not used', async () => {
    harness();
    await create();
    const secret = applied().find((doc) => doc.includes('rocketchat-mongodb-url'));
    expect(secret).toContain(MONGO_URL);
  });

  it('renders a scenario’s manifests with the workspace name in them', async () => {
    harness();
    await create({
      preset: {
        ...(jest.requireActual('../../../src/lib/presets/types') as typeof presetTypes).emptyPreset(
          'keycloak',
        ),
        scenario: 'oidc',
        env: { OAUTH_ISSUER: 'https://keycloak.test' },
        kubernetesManifests: ['kind: Service\nmetadata:\n  name: __HOUSTON_NAME__-keycloak\n'],
      },
    });
    expect(applied().some((doc) => doc.includes('name: tk-keycloak'))).toBe(true);
    // A scenario's Rocket.Chat settings ride extraEnv exactly as they ride the service
    // environment on Compose.
    expect(valuesOf().extraEnv).toContainEqual({
      name: 'OAUTH_ISSUER',
      value: 'https://keycloak.test',
    });
  });
});
