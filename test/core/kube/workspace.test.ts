/**
 * Tier k5: the orchestrator, and the four decisions only it can get wrong.
 *
 * Everything this module does is done by a module below it, so the cases are not about what
 * those do -- their own specs cover that. They are about ORDER, about which branch ran, and
 * about what a failure half-way through is entitled to destroy. Each collaborator that
 * touches a cluster is replaced; every pure function stays real, so a manifest asserted on
 * here is the manifest that would be applied.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as YAML from 'yaml';
import * as config from '../../../src/lib/config';

import { CreateFailedError, PreflightError } from '../../../src/lib/errors';
import { Interrupted, sleep, stoppable } from '../../../src/seams/exec';
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
import { metadata, readMeta, writeRecord } from '../../../src/core/runner/record';
import * as paths from '../../../src/core/runner/paths';
import { createKubernetes } from '../../../src/core/lifecycle/create-k8s';
import { createReq } from '../../../src/core/lifecycle/types';
import * as lifecyclePorts from '../../../src/core/lifecycle/ports';
import * as sizing from '../../../src/core/lifecycle/sizing';
import * as tlsplan from '../../../src/core/lifecycle/tlsplan';
import * as reachability from '../../../src/core/kube/reachability';

jest.mock('../../../src/core/lifecycle/sizing', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/sizing'),
  checkCapacity: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/ports', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/ports'),
  pickHostPort: jest.fn(),
  checkSidecarPorts: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/tlsplan', () => {
  const actual = jest.requireActual('../../../src/core/lifecycle/tlsplan') as typeof tlsplan;
  return {
    ...actual,
    resolveTls: jest.fn(),
    kubernetesTlsPlan: jest.fn((...args: unknown[]) =>
      actual.kubernetesTlsPlan(...(args as Parameters<typeof actual.kubernetesTlsPlan>)),
    ),
    routeKubernetesName: jest.fn((...args: unknown[]) =>
      actual.routeKubernetesName(...(args as Parameters<typeof actual.routeKubernetesName>)),
    ),
  };
});
jest.mock('../../../src/core/kube/reachability', () => ({
  ...jest.requireActual('../../../src/core/kube/reachability'),
  helmReachable: jest.fn(),
}));

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
  assertNamespaceAvailable: jest.fn(),
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
jest.mock('../../../src/core/runner/paths', () => {
  const actual = jest.requireActual<typeof paths>('../../../src/core/runner/paths');
  return { ...actual, atomicWrite: jest.fn(actual.atomicWrite) };
});

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
let namespaceUid = 'namespace-tk-original';
let namespacePresent = true;

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
  namespaceUid = 'namespace-tk-original';
  namespacePresent = true;
  let namespaceOwner = '';
  kube.run = (argv, options) => {
    ran.push([...argv]);
    if (argv.includes('get') && argv.includes('namespace')) {
      return Promise.resolve({
        argv,
        returncode: 0,
        stdout: namespacePresent
          ? JSON.stringify({
              metadata: {
                name: 'houston-tk',
                uid: namespaceUid,
                resourceVersion: '1',
                labels: namespace.labelsFor('tk', namespaceOwner),
              },
            })
          : '',
        stderr: '',
      });
    }
    if (argv.includes('delete')) {
      const preconditions =
        options?.input === undefined
          ? null
          : (JSON.parse(options.input).preconditions as { uid?: string });
      if (preconditions !== null && preconditions.uid !== namespaceUid) {
        return Promise.resolve({
          argv,
          returncode: 1,
          stdout: '',
          stderr: 'UID precondition failed',
        });
      }
      namespacePresent = false;
    }
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
  mocked(namespace.ensureNamespace).mockImplementation(async (_name, options) => {
    namespaceOwner = options.owner ?? '';
    if (options.receipt !== undefined) {
      Object.assign(options.receipt, {
        uid: namespaceUid,
        owner: namespaceOwner,
        createdUid: held === null || held.includes('houston-tk') ? '' : namespaceUid,
      });
    }
    return 'houston-tk';
  });
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
  mocked(forward.forwardAlive).mockResolvedValue(alive);
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

  it('keeps scenario-create progress monotonic after initiating the replica set', async () => {
    harness();
    mocked(replicaset.initReplicaSet).mockImplementation(
      (jest.requireActual('../../../src/core/kube/replicaset') as typeof replicaset).initReplicaSet,
    );
    kube.run = async (argv) => ({
      argv,
      returncode: 0,
      stdout:
        argv.some((arg) => arg.includes('containerStatuses[0].started')) ||
        argv.includes('db.hello().isWritablePrimary')
          ? 'true'
          : '',
      stderr: '',
    });
    const { resolve } = require('../../../src/lib/presets/index') as {
      resolve: (name: string, runtime: string, params: Record<string, unknown>) => unknown;
    };
    const percentages: number[] = [];
    await create({
      preset: resolve('email', 'kubernetes', {}) as never,
      emit: (event) => {
        if (typeof event.pct === 'number') percentages.push(event.pct);
      },
    });
    expect(percentages).toContain(25);
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
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
    expect(deleted).toContain('/api/v1/namespaces/houston-tk');
    expect(namespacePresent).toBe(false);
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

  it('does not remove a namespace without proof this create introduced it', async () => {
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

  it('rolls a stopped create back to the end, so no namespace is left without a record', async () => {
    // A Stop pressed during the install refuses every wait after it -- and the rollback is
    // waits. Refused, it left a namespace that no repro.json pointed at: invisible to `list`
    // and to `down`, and on EKS a volume billing on.
    harness({ held: [] });
    const stop = new AbortController();
    mocked(release.install).mockImplementation(async () => {
      stop.abort();
      await sleep(10);
      return undefined as never;
    });
    const recorded = kube.run;
    kube.run = async (...args: Parameters<typeof kube.run>) => {
      await sleep(0.01); // a wait, as the real seam's kubectl is
      return await recorded(...args);
    };
    await expect(stoppable(stop.signal, async () => await create())).rejects.toBeInstanceOf(
      Interrupted,
    );
    const deleted = ran.find((argv) => argv.includes('delete'));
    expect(deleted).toContain('/api/v1/namespaces/houston-tk');
    expect(namespacePresent).toBe(false);
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

  it('F1 leaves an adopted namespace missed by the separate discovery list', async () => {
    harness({ held: [] });
    mocked(namespace.ensureNamespace).mockImplementation(async (_name, options) => {
      if (options.receipt !== undefined) {
        Object.assign(options.receipt, { uid: namespaceUid, owner: '', createdUid: '' });
      }
      return 'houston-tk';
    });
    mocked(release.install).mockRejectedValue(new CreateFailedError('helm said no'));
    await expect(create()).rejects.toThrow(/helm said no/u);
    expect(namespacePresent).toBe(true);
    expect(ran.some((argv) => argv.includes('delete'))).toBe(false);
  });

  it('F1 leaves a replacement namespace when an introduced namespace disappears before rollback', async () => {
    harness({ held: [] });
    mocked(release.install).mockImplementation(async () => {
      namespaceUid = 'namespace-tk-replacement';
      throw new CreateFailedError('helm said no');
    });
    await expect(create()).rejects.toThrow(/helm said no/u);
    expect(namespacePresent).toBe(true);
    expect(ran.some((argv) => argv.includes('delete'))).toBe(false);
    expect(mocked(cluster.deleteCluster)).not.toHaveBeenCalled();
  });

  it('F1 refuses installation when the namespace identity cannot be saved in its existing record', async () => {
    harness();
    await writeRecord('tk', metadata({ name: 'tk', extra: { incomplete: true } }));
    const write = mocked(paths.atomicWrite).mockRejectedValueOnce(
      new PreflightError('namespace identity write refused'),
    );
    try {
      await expect(create()).rejects.toThrow(/namespace identity write refused/u);
      expect(mocked(release.install)).not.toHaveBeenCalled();
      expect(namespacePresent).toBe(false);
      expect((await readMeta('tk')).extra.namespace_uid).toBeUndefined();
    } finally {
      write.mockReset();
      write.mockImplementation(
        jest.requireActual<typeof paths>('../../../src/core/runner/paths').atomicWrite,
      );
    }
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

  it('writes each forward into the write-ahead record the moment it exists', async () => {
    // They reached the record only when the whole create finished, so a create killed after
    // "port-forward established" left a kubectl holding the port that no record named:
    // `down --volumes` said everything was removed, and the listener outlived the namespace.
    harness();
    await writeRecord(
      'tk',
      metadata({ name: 'tk', project: 'houston-tk', extra: { incomplete: true } }),
    );
    let atTheScenarioStep: unknown = null;
    mocked(forward.scenarioUiForwards).mockImplementation(async () => {
      atTheScenarioStep = (await readMeta('tk')).extra.port_forward_pid;
      return { 8081: 5151 };
    });
    await create();
    expect(atTheScenarioStep).toBe(4242);
    expect((await readMeta('tk')).extra.scenario_forwards).toEqual({ 8081: 5151 });
  });

  it('carries the scenario forwards back with string keys, as repro.json holds them', async () => {
    harness();
    expect((await create()).scenario_forwards).toEqual({ 8081: 5151 });
  });
});

describe('the values the release is installed with', () => {
  const valuesOf = () =>
    (mocked(release.install).mock.calls[0]?.[0] as { values: Record<string, unknown> }).values;

  it('promotes effective preset credentials through Secrets before installing and recording values', async () => {
    const cases = [
      { label: 'preset', overrides: {}, token: 'preset-token', license: 'preset-license' },
      {
        label: 'override',
        overrides: { REG_TOKEN: '  override-token  ', ROCKETCHAT_LICENSE: '  override-license  ' },
        token: 'override-token',
        license: 'override-license',
      },
      {
        label: 'blank',
        overrides: { REG_TOKEN: '  ', ROCKETCHAT_LICENSE: ' \t ' },
        token: '',
        license: '',
      },
      {
        label: 'remove',
        overrides: { REG_TOKEN: null, ROCKETCHAT_LICENSE: null },
        token: '',
        license: '',
      },
      {
        label: 'dedicated',
        overrides: { REG_TOKEN: null, ROCKETCHAT_LICENSE: null },
        directToken: '  direct-token  ',
        directLicense: '  direct-license  ',
        token: 'direct-token',
        license: 'direct-license',
      },
      {
        label: 'retained Secret',
        overrides: {},
        retained: true,
        token: 'preset-token',
        license: '',
      },
    ];
    const observed: unknown[] = [];
    for (const one of cases) {
      await paths.remove('tk');
      harness();
      mocked(manifests.recordRendered).mockImplementation(
        (jest.requireActual('../../../src/core/kube/manifests') as typeof manifests).recordRendered,
      );
      const events: Event[] = [];
      const record = await create({
        preset: {
          ...(
            jest.requireActual('../../../src/lib/presets/types') as typeof presetTypes
          ).emptyPreset('credentials'),
          env: {
            REG_TOKEN: '  preset-token  ',
            ROCKETCHAT_LICENSE: '  preset-license  ',
            UNRELATED: 'kept',
          },
        },
        envOverrides: one.overrides,
        regToken: one.directToken ?? '',
        license: one.directLicense ?? '',
        licensed: one.retained ?? false,
        emit: (event) => events.push(event),
      });
      const docs = applied();
      const token = docs.find((doc) => doc.includes('name: houston-reg-token'));
      const license = docs.find((doc) => doc.includes('name: houston-license'));
      observed.push([
        one.label,
        token === undefined
          ? ''
          : (YAML.parse(token) as { stringData: { token: string } }).stringData.token,
        license === undefined
          ? ''
          : (YAML.parse(license) as { stringData: { license: string } }).stringData.license,
      ]);
      await expect(readMeta('tk')).rejects.toThrow('no repro.json');
      const env = valuesOf().extraEnv as chart.ChartEnvEntry[];
      for (const [key, secret, present] of [
        ['REG_TOKEN', 'houston-reg-token', one.token !== ''],
        ['ROCKETCHAT_LICENSE', 'houston-license', one.license !== '' || one.retained === true],
      ] as const) {
        expect(env.filter((entry) => entry.name === key)).toEqual(
          present
            ? [
                {
                  name: key,
                  valueFrom: {
                    secretKeyRef: { name: secret, key: key === 'REG_TOKEN' ? 'token' : 'license' },
                  },
                },
              ]
            : [],
        );
      }
      expect(env).toContainEqual({ name: 'UNRELATED', value: 'kept' });
      const writtenValues = await fs.readFile(
        path.join(config.reprosDir(), 'tk', 'kubernetes', 'values.yaml'),
        'utf8',
      );
      const persisted = JSON.stringify([
        writtenValues,
        valuesOf(),
        mocked(manifests.recordRendered).mock.calls,
        record,
        events,
        ran,
      ]);
      for (const raw of [
        'preset-token',
        'preset-license',
        'override-token',
        'override-license',
        'direct-token',
        'direct-license',
      ]) {
        expect(persisted).not.toContain(raw);
      }
    }
    expect(observed).toEqual(cases.map((one) => [one.label, one.token, one.license]));
  });

  it.each([
    'unknown namespace',
    'failed namespace cleanup',
    'post-install connection',
    'failed licence apply',
  ])(
    'retries real provisional preset credentials after %s and retains only completed Secrets',
    async (failure) => {
      const presetPath = path.join(config.presetDir(), 'retry-credentials.yaml');
      const license = 'synthetic-retry-preset-license';
      const token = 'synthetic-retry-preset-token';
      const changedLicense = 'synthetic-new-preset-license';
      const events: Event[] = [];
      const inputs: { argv: string[]; input: string }[] = [];
      let initial = true;
      const postInstall = failure === 'post-install connection';
      const req = () =>
        createReq({
          license: initial && postInstall ? license : '',
          version: '8.5.1',
          name: 'tk',
          preset: 'retry-credentials',
          runtime: 'kubernetes',
          offline: true,
          wait: false,
        });
      const prepare = (held: string[]) => {
        harness({ held });
        mocked(sizing.checkCapacity).mockResolvedValue(undefined);
        mocked(lifecyclePorts.pickHostPort).mockResolvedValue(3000);
        mocked(lifecyclePorts.checkSidecarPorts).mockResolvedValue(undefined);
        mocked(tlsplan.resolveTls).mockResolvedValue(null);
        mocked(reachability.helmReachable).mockResolvedValue('');
        mocked(namespace.assertNamespaceAvailable).mockResolvedValue(undefined);
        const actualTools = jest.requireActual<typeof tools>('../../../src/core/kube/tools');
        mocked(probe.preflight).mockResolvedValue({
          ...actualTools.preflight({
            tools: {
              kubectl: actualTools.makeTool({
                name: 'kubectl',
                path: '/stated/kubectl',
                version: [1, 36],
              }),
              helm: actualTools.makeTool({ name: 'helm', path: '/stated/helm', version: [3, 15] }),
            },
          }),
          context: 'prod',
          clusterReachable: true,
          defaultStorageClass: 'local-path',
          architectures: ['amd64'],
          unreadable: [],
        });
        mocked(manifests.recordRendered).mockImplementation(
          (jest.requireActual('../../../src/core/kube/manifests') as typeof manifests)
            .recordRendered,
        );
        // Keep Secret application real through its stdin boundary; only transport is stated.
        mocked(release.apply).mockImplementation(
          (jest.requireActual('../../../src/core/kube/release') as typeof release).apply,
        );
        mocked(release.install).mockImplementation(
          (jest.requireActual('../../../src/core/kube/release') as typeof release).install,
        );
        const run = kube.run;
        kube.run = (argv, options) => {
          if (options?.input !== undefined) inputs.push({ argv: [...argv], input: options.input });
          return run(argv, options);
        };
      };
      const writePreset = async (value: string) => {
        await fs.writeFile(
          presetPath,
          YAML.stringify({
            name: 'retry-credentials',
            requires_license: true,
            env: postInstall
              ? {}
              : { ROCKETCHAT_LICENSE: `  ${value}  `, REG_TOKEN: `  ${token}  ` },
          }),
        );
      };
      const appliedLicense = () =>
        inputs.filter((call) => {
          return YAML.parseAllDocuments(call.input).some((document) => {
            const doc = document.toJSON() as { kind?: string; metadata?: { name?: string } };
            return doc.kind === 'Secret' && doc.metadata?.name === 'houston-license';
          });
        });
      const assertPrivate = async (result: unknown) => {
        const written = await fs.readFile(path.join(paths.workspace('tk'), 'repro.json'), 'utf8');
        const values = await fs
          .readFile(path.join(paths.workspace('tk'), 'kubernetes', 'values.yaml'), 'utf8')
          .catch(() => '');
        const visible = JSON.stringify([
          written,
          values,
          result,
          events,
          ran,
          mocked(manifests.recordRendered).mock.calls,
        ]);
        for (const raw of [license, token, changedLicense]) expect(visible).not.toContain(raw);
        for (const call of inputs) {
          if (call.argv[0] === 'helm')
            for (const raw of [license, token, changedLicense])
              expect(call.input).not.toContain(raw);
          expect(call.argv).not.toEqual(expect.arrayContaining([expect.stringContaining(license)]));
          expect(call.argv).not.toEqual(expect.arrayContaining([expect.stringContaining(token)]));
        }
      };
      config.updateConfig((cfg) => {
        delete cfg.reg_token;
      });
      await paths.remove('tk');
      await fs.mkdir(config.presetDir(), { recursive: true });
      try {
        await writePreset(license);
        prepare(
          failure === 'unknown namespace' || failure === 'failed licence apply'
            ? ['houston-tk']
            : [],
        );
        const run = kube.run;
        kube.run = (argv, options) => {
          if (
            (failure === 'unknown namespace' &&
              argv.includes('get') &&
              argv.includes('namespace')) ||
            (failure === 'failed namespace cleanup' && argv.includes('delete')) ||
            (failure === 'failed licence apply' &&
              options?.input?.includes('name: houston-license'))
          ) {
            ran.push([...argv]);
            if (options?.input !== undefined)
              inputs.push({ argv: [...argv], input: options.input });
            return Promise.resolve({
              argv,
              returncode: 1,
              stdout: '',
              stderr: 'stated transport failure',
            });
          }
          return run(argv, options);
        };
        if (postInstall) mocked(forward.portForward).mockRejectedValueOnce(new Interrupted());
        else if (failure !== 'failed licence apply')
          mocked(replicaset.initReplicaSet).mockRejectedValueOnce(new Interrupted());
        const attempt = createKubernetes(req(), (event) => events.push(event));
        if (failure === 'failed licence apply')
          await expect(attempt).rejects.toThrow('kubectl apply failed: stated transport failure');
        else await expect(attempt).rejects.toBeInstanceOf(Interrupted);
        initial = false;
        const provisional = await readMeta('tk');
        expect(provisional.extra.incomplete).toBe(true);
        expect(provisional.extra.licensed).toBe(true);
        expect(appliedLicense()).toHaveLength(
          postInstall || failure === 'failed licence apply' ? 1 : 0,
        );
        expect(mocked(release.install).mock.calls.length).toBe(postInstall ? 1 : 0);
        if (postInstall) {
          expect(
            (YAML.parse(appliedLicense()[0]?.input ?? '') as { stringData: { license: string } })
              .stringData.license,
          ).toBe(license);
          const helm = inputs.filter(
            (call) => call.argv[0] === 'helm' && call.argv.includes('upgrade'),
          );
          expect(helm).toHaveLength(1);
          expect(
            (JSON.parse(helm[0]?.input ?? '') as { extraEnv: unknown[] }).extraEnv,
          ).toContainEqual({
            name: 'ROCKETCHAT_LICENSE',
            valueFrom: { secretKeyRef: { name: 'houston-license', key: 'license' } },
          });
        }
        if (failure === 'failed namespace cleanup')
          expect(ran.some((argv) => argv.includes('delete'))).toBe(true);
        await assertPrivate(null);

        inputs.length = 0;
        prepare(['houston-tk']);
        const result = await createKubernetes(req(), (event) => events.push(event));
        expect(
          appliedLicense().map(
            (call) =>
              (YAML.parse(call.input) as { stringData: { license: string } }).stringData.license,
          ),
        ).toEqual(postInstall ? [] : [license]);
        const tokenDoc = inputs
          .flatMap((call) =>
            YAML.parseAllDocuments(call.input).map(
              (document) =>
                document.toJSON() as {
                  metadata?: { name?: string };
                  stringData?: { token?: string };
                },
            ),
          )
          .find((doc) => doc.metadata?.name === 'houston-reg-token');
        expect(tokenDoc?.stringData?.token).toBe(postInstall ? undefined : token);
        const values = mocked(release.install).mock.calls[0]?.[0].values as Record<string, unknown>;
        expect(values.license).toBeUndefined();
        expect(values.extraEnv).toEqual(
          expect.arrayContaining([
            {
              name: 'ROCKETCHAT_LICENSE',
              valueFrom: { secretKeyRef: { name: 'houston-license', key: 'license' } },
            },
            ...(postInstall
              ? []
              : [
                  {
                    name: 'REG_TOKEN',
                    valueFrom: { secretKeyRef: { name: 'houston-reg-token', key: 'token' } },
                  },
                ]),
          ]),
        );
        expect(provisional.extra.retained_license).toBe(postInstall);
        for (const call of appliedLicense())
          expect(call.argv.slice(-3)).toEqual(['apply', '-f', '-']);
        expect((await readMeta('tk')).extra.incomplete).toBeUndefined();
        expect((await readMeta('tk')).extra.effective_license).toBe(true);
        await assertPrivate(result);

        // A completed Secret wins over a changed preset, including a later interrupted re-up.
        await writePreset(changedLicense);
        inputs.length = 0;
        prepare(['houston-tk']);
        await createKubernetes(req(), (event) => events.push(event));
        expect(appliedLicense()).toHaveLength(0);
        expect((await readMeta('tk')).extra.licensed).toBe(true);
        await assertPrivate(null);
        mocked(replicaset.initReplicaSet).mockRejectedValueOnce(new Interrupted());
        await expect(createKubernetes(req(), (event) => events.push(event))).rejects.toBeInstanceOf(
          Interrupted,
        );
        expect((await readMeta('tk')).extra.incomplete).toBe(true);
        inputs.length = 0;
        prepare(['houston-tk']);
        await createKubernetes(req(), (event) => events.push(event));
        expect(appliedLicense()).toHaveLength(0);
        expect((await readMeta('tk')).extra.effective_license).toBe(true);
        await assertPrivate(null);
        // An explicit new payload still replaces the retained Secret on either API path.
        inputs.length = 0;
        prepare(['houston-tk']);
        await createKubernetes({ ...req(), license: `  ${changedLicense}  ` }, (event) =>
          events.push(event),
        );
        expect(
          appliedLicense().map(
            (call) =>
              (YAML.parse(call.input) as { stringData: { license: string } }).stringData.license,
          ),
        ).toEqual([changedLicense]);
        await assertPrivate(null);
      } finally {
        await fs.rm(presetPath, { force: true });
        await paths.remove('tk');
      }
    },
  );

  it('does not retain a licence against a different workspace identity', async () => {
    harness({ held: ['houston-tk'] });
    const meta = metadata({ name: 'tk', project: 'houston-tk' });
    Object.assign(meta.extra, {
      runtime: 'kubernetes',
      namespace: 'houston-tk',
      context: 'another-cluster',
      incomplete: true,
      licensed: true,
      retained_license: false,
    });
    await writeRecord('tk', meta);
    try {
      await expect(create({ license: 'synthetic-foreign-record' })).rejects.toThrow(
        'workspace identity changed',
      );
      expect(mocked(release.install)).toHaveBeenCalledTimes(1);
      expect((await readMeta('tk')).extra.retained_license).toBe(false);
    } finally {
      await paths.remove('tk');
    }
  });

  it('records the token Helm accepted when the tools Ingress fails on a re-up', async () => {
    // The write-ahead record states the release still running. Once Helm accepts this run's
    // release, the marker has to follow it even if the create stops before its final record.
    const TOKEN = 'synthetic-reup-token';
    let failHelm = false;
    let failTools = false;
    let useTls = false;
    const req = (regToken: string) =>
      createReq({
        version: '8.5.1',
        name: 'tk',
        preset: 'email',
        runtime: 'kubernetes',
        offline: true,
        wait: false,
        regToken,
      });
    harness({ held: ['houston-tk'] });
    mocked(sizing.checkCapacity).mockResolvedValue(undefined);
    mocked(lifecyclePorts.pickHostPort).mockResolvedValue(3000);
    mocked(lifecyclePorts.checkSidecarPorts).mockResolvedValue(undefined);
    mocked(tlsplan.resolveTls).mockImplementation(() =>
      Promise.resolve(useTls ? ({ mode: 'local', host: 'rc.example.test' } as never) : null),
    );
    mocked(tlsplan.kubernetesTlsPlan).mockResolvedValue({
      host: 'rc.example.test',
      ingressClass: 'traefik',
      endpoint: { address: '127.0.0.1', port: 443, source: 'stated' },
      context: 'prod',
      issuer: { mode: 'local' },
      clusterOwns443: true,
    } as never);
    mocked(tlsplan.routeKubernetesName).mockResolvedValue(undefined);
    mocked(release.apply).mockImplementation((body: unknown) =>
      failTools && String(body).includes('houston-tools')
        ? Promise.reject(new CreateFailedError('kubectl apply failed: tools ingress refused'))
        : Promise.resolve(),
    );
    mocked(release.install).mockImplementation(() =>
      failHelm
        ? Promise.reject(new CreateFailedError('helm install failed: refused'))
        : Promise.resolve(),
    );
    const observed: unknown[] = [];
    const marker = async (label: string) => {
      const meta = await readMeta('tk');
      expect(JSON.stringify(meta)).not.toContain(TOKEN);
      observed.push([label, meta.extra.incomplete === true, meta.extra.reg_token_supplied]);
    };
    try {
      await paths.remove('tk');
      await createKubernetes(req(''));
      await marker('tokenless create');

      failHelm = true;
      await expect(createKubernetes(req(TOKEN))).rejects.toThrow('helm install failed: refused');
      await marker('Helm refused the token');

      failHelm = false;
      failTools = true;
      useTls = true;
      await expect(createKubernetes(req(TOKEN))).rejects.toThrow(
        'kubectl apply failed: tools ingress refused',
      );
      await marker('Helm accepted the token, tools Ingress failed');

      await expect(createKubernetes(req(''))).rejects.toThrow(
        'kubectl apply failed: tools ingress refused',
      );
      await marker('Helm accepted no token, tools Ingress failed');
    } finally {
      await paths.remove('tk');
    }
    expect(observed).toEqual([
      ['tokenless create', false, false],
      ['Helm refused the token', true, false],
      ['Helm accepted the token, tools Ingress failed', true, true],
      ['Helm accepted no token, tools Ingress failed', true, false],
    ]);
  });

  it('keeps the licence Helm accepted when the tools Ingress fails on a re-up', async () => {
    // Helm had accepted values that reference houston-license, then the tools Ingress apply
    // threw before noteInstalledLicense. Rollback left the adopted namespace and its Secret,
    // and the record stayed retained_license false, so the next empty payload installed a
    // release with no Secret reference.
    const LICENSE = 'synthetic-reup-license';
    const licenseRef = {
      name: 'ROCKETCHAT_LICENSE',
      valueFrom: { secretKeyRef: { name: 'houston-license', key: 'license' } },
    };
    const events: string[] = [];
    const helmValues: Record<string, unknown>[] = [];
    let failHelm = false;
    let failTools = false;
    let useTls = false;
    const req = (license: string) =>
      createReq({
        version: '8.5.1',
        name: 'tk',
        preset: 'email',
        runtime: 'kubernetes',
        offline: true,
        wait: false,
        license,
      });
    const since = (at: number) => events.slice(at);
    const refOf = (values: Record<string, unknown> | undefined) =>
      (values?.extraEnv as unknown[] | undefined) ?? [];
    harness({ held: ['houston-tk'] });
    mocked(sizing.checkCapacity).mockResolvedValue(undefined);
    mocked(lifecyclePorts.pickHostPort).mockResolvedValue(3000);
    mocked(lifecyclePorts.checkSidecarPorts).mockResolvedValue(undefined);
    mocked(tlsplan.resolveTls).mockImplementation(() =>
      Promise.resolve(useTls ? ({ mode: 'local', host: 'rc.example.test' } as never) : null),
    );
    mocked(tlsplan.kubernetesTlsPlan).mockResolvedValue({
      host: 'rc.example.test',
      ingressClass: 'traefik',
      endpoint: { address: '127.0.0.1', port: 443, source: 'stated' },
      context: 'prod',
      issuer: { mode: 'local' },
      clusterOwns443: true,
    } as never);
    mocked(tlsplan.routeKubernetesName).mockResolvedValue(undefined);
    mocked(release.apply).mockImplementation((body: unknown) => {
      const text = String(body);
      if (text.includes('name: houston-license')) events.push('secret');
      if (text.includes('houston-tools')) {
        events.push('tools');
        if (failTools) {
          return Promise.reject(
            new CreateFailedError('kubectl apply failed: tools ingress refused'),
          );
        }
      }
      return Promise.resolve();
    });
    mocked(release.install).mockImplementation((options: { values: Record<string, unknown> }) => {
      events.push('helm');
      helmValues.push(options.values);
      if (failHelm) return Promise.reject(new CreateFailedError('helm install failed: refused'));
      return Promise.resolve();
    });
    try {
      await paths.remove('tk');
      await createKubernetes(req(''));

      failHelm = true;
      const helmAt = events.length;
      await expect(createKubernetes(req(LICENSE))).rejects.toThrow('helm install failed: refused');
      expect(since(helmAt)).toContain('secret');
      expect(since(helmAt)).toContain('helm');
      expect(since(helmAt)).not.toContain('tools');
      const refused = await readMeta('tk');
      expect(refused.extra.retained_license).toBe(false);
      expect(refused.extra.effective_license).toBe(false);
      expect(JSON.stringify(refused)).not.toContain(LICENSE);
      expect(ran.some((argv) => argv.includes('delete'))).toBe(false);

      failHelm = false;
      failTools = true;
      useTls = true;
      const toolsAt = events.length;
      await expect(createKubernetes(req(LICENSE))).rejects.toThrow(
        'kubectl apply failed: tools ingress refused',
      );
      const toolsPhase = since(toolsAt);
      expect(toolsPhase.indexOf('secret')).toBeGreaterThanOrEqual(0);
      expect(toolsPhase.indexOf('secret')).toBeLessThan(toolsPhase.indexOf('helm'));
      expect(toolsPhase.indexOf('helm')).toBeLessThan(toolsPhase.indexOf('tools'));
      const accepted = helmValues.at(-1);
      expect(refOf(accepted)).toContainEqual(licenseRef);
      expect(JSON.stringify(accepted)).not.toContain(LICENSE);
      expect(ran.some((argv) => argv.includes('delete'))).toBe(false);
      const stuck = await readMeta('tk');
      expect(stuck.extra.incomplete).toBe(true);
      expect(stuck.extra.retained_license).toBe(true);
      expect(stuck.extra.effective_license).toBe(true);
      expect(JSON.stringify(stuck)).not.toContain(LICENSE);

      // The Secret and release from the accepted install are still the ones Rocket.Chat
      // uses. A later Helm refusal must not make that workspace look unlicensed.
      failHelm = true;
      failTools = false;
      useTls = false;
      await expect(createKubernetes(req(''))).rejects.toThrow('helm install failed: refused');
      const retained = await readMeta('tk');
      expect(retained.extra.retained_license).toBe(true);
      expect(retained.extra.effective_license).toBe(true);
      expect(JSON.stringify(retained)).not.toContain(LICENSE);
      expect(ran.some((argv) => argv.includes('delete'))).toBe(false);

      failHelm = false;
      await createKubernetes(req(''));
      const retry = helmValues.at(-1);
      expect(refOf(retry)).toContainEqual(licenseRef);
      expect(JSON.stringify(retry)).not.toContain(LICENSE);
      const kept = await readMeta('tk');
      expect(kept.extra.incomplete).toBeUndefined();
      expect(kept.extra.effective_license).toBe(true);
      expect(JSON.stringify(kept)).not.toContain(LICENSE);
    } finally {
      await paths.remove('tk');
    }
  });

  it('does not keep a licence when rollback deletes the namespace this run created', async () => {
    // Helm accepted the release, then the tools Ingress failed. The namespace was one
    // this run created, so rollback deleted it and the Secret. The markers had already
    // been written, the record survived, and the next empty payload referenced a Secret
    // that was gone.
    const LICENSE = 'synthetic-created-namespace-license';
    const licenseRef = {
      name: 'ROCKETCHAT_LICENSE',
      valueFrom: { secretKeyRef: { name: 'houston-license', key: 'license' } },
    };
    const events: string[] = [];
    const helmValues: Record<string, unknown>[] = [];
    let failTools = false;
    let useTls = false;
    const req = (license: string) =>
      createReq({
        version: '8.5.1',
        name: 'tk',
        preset: 'email',
        runtime: 'kubernetes',
        offline: true,
        wait: false,
        license,
      });
    const refOf = (values: Record<string, unknown> | undefined) =>
      (values?.extraEnv as unknown[] | undefined) ?? [];
    harness();
    mocked(sizing.checkCapacity).mockResolvedValue(undefined);
    mocked(lifecyclePorts.pickHostPort).mockResolvedValue(3000);
    mocked(lifecyclePorts.checkSidecarPorts).mockResolvedValue(undefined);
    mocked(tlsplan.resolveTls).mockImplementation(() =>
      Promise.resolve(useTls ? ({ mode: 'local', host: 'rc.example.test' } as never) : null),
    );
    mocked(tlsplan.kubernetesTlsPlan).mockResolvedValue({
      host: 'rc.example.test',
      ingressClass: 'traefik',
      endpoint: { address: '127.0.0.1', port: 443, source: 'stated' },
      context: 'prod',
      issuer: { mode: 'local' },
      clusterOwns443: true,
    } as never);
    mocked(tlsplan.routeKubernetesName).mockResolvedValue(undefined);
    mocked(release.apply).mockImplementation((body: unknown) => {
      const text = String(body);
      if (text.includes('name: houston-license')) events.push('secret');
      if (text.includes('houston-tools')) {
        events.push('tools');
        if (failTools) {
          return Promise.reject(
            new CreateFailedError('kubectl apply failed: tools ingress refused'),
          );
        }
      }
      return Promise.resolve();
    });
    mocked(release.install).mockImplementation((options: { values: Record<string, unknown> }) => {
      events.push('helm');
      helmValues.push(options.values);
      return Promise.resolve();
    });
    try {
      await paths.remove('tk');
      await createKubernetes(req(''));

      failTools = true;
      useTls = true;
      const toolsAt = events.length;
      await expect(createKubernetes(req(LICENSE))).rejects.toThrow(
        'kubectl apply failed: tools ingress refused',
      );
      const toolsPhase = events.slice(toolsAt);
      expect(toolsPhase.indexOf('secret')).toBeGreaterThanOrEqual(0);
      expect(toolsPhase.indexOf('secret')).toBeLessThan(toolsPhase.indexOf('helm'));
      expect(toolsPhase.indexOf('helm')).toBeLessThan(toolsPhase.indexOf('tools'));
      const removed = await readMeta('tk');
      expect(removed.extra.retained_license).toBe(false);
      expect(removed.extra.effective_license).toBe(false);
      expect(removed.extra.incomplete).toBe(true);
      expect(JSON.stringify(removed)).not.toContain(LICENSE);
      expect(ran.some((argv) => argv.includes('delete'))).toBe(true);

      failTools = false;
      useTls = false;
      await createKubernetes(req(''));
      expect(refOf(helmValues.at(-1))).not.toContainEqual(licenseRef);
      expect(JSON.stringify(helmValues.at(-1))).not.toContain(LICENSE);
    } finally {
      await paths.remove('tk');
    }
  });

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

  it('hands --env and --setting to the chart once each, from the create to the release', async () => {
    // `chartEnv` and the create's carry were each tested, and the hop between them was not:
    // dropping `envOverrides` anywhere from createWorkspace to the chart's values left the
    // suite green and the workspace without the variable.
    harness();
    await create({ envOverrides: { OVERWRITE_SETTING_Site_Name: 'Hop', GONE: null } });
    const env = valuesOf().extraEnv as { name: string; value?: string }[];
    expect(env.filter((entry) => entry.name === 'OVERWRITE_SETTING_Site_Name')).toEqual([
      { name: 'OVERWRITE_SETTING_Site_Name', value: 'Hop' },
    ]);
  });

  it("gives the livechat demo page the workspace's address, not the placeholder", async () => {
    // Only `renderScenarioManifest` was tested; that createWorkspace hands it the advertised
    // URL had no test, and the demo page's widget then pointed at `{{ROOT_URL}}`.
    harness();
    const { resolve } = require('../../../src/lib/presets/index') as {
      resolve: (name: string, runtime: string, params: Record<string, unknown>) => unknown;
    };
    await create({
      rootUrl: 'http://localhost:3412',
      preset: resolve('livechat', 'kubernetes', {}) as never,
    });
    const scenario = applied().join('\n');
    expect(scenario).toContain('http://localhost:3412');
    expect(scenario).not.toContain('{{ROOT_URL}}');
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

  it('names every preset of a set when it applies their resources', async () => {
    // A set's `scenario` joins only the presets that ARE scenarios, so five presets were
    // announced as "applying the e2ee+ldap scenario — 6 resources".
    harness();
    const said: string[] = [];
    await create({
      preset: {
        ...(jest.requireActual('../../../src/lib/presets/types') as typeof presetTypes).emptyPreset(
          'e2ee+ldap+livechat',
        ),
        scenario: 'e2ee+ldap',
        kubernetesManifests: ['kind: Service\nmetadata:\n  name: __HOUSTON_NAME__-ldap\n'],
      },
      emit: (event) => said.push(event.message),
    });
    expect(said).toContain('applying the e2ee+ldap+livechat scenario — 1 resource');
  });
});
