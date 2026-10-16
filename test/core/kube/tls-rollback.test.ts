/** TLS may create Kind before workspace provisioning. Exercise that receipt across callers. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as config from '../../../src/lib/config';
import { grant } from '../../../src/lib/onboarding';
import {
  createKubernetes,
  kubeCreate,
  planTls,
  planKubeTls,
} from '../../../src/core/lifecycle/create-k8s';
import { createReq } from '../../../src/core/lifecycle/types';
import * as sizing from '../../../src/core/lifecycle/sizing';
import * as ports from '../../../src/core/lifecycle/ports';
import * as runnerPorts from '../../../src/core/runner/ports';
import * as paths from '../../../src/core/runner/paths';
import * as context from '../../../src/core/kube/context';
import * as tools from '../../../src/core/kube/tools';
import * as probe from '../../../src/core/kube/probe';
import * as chart from '../../../src/core/kube/chart';
import * as certmanager from '../../../src/core/kube/certmanager';
import * as ingress from '../../../src/core/kube/ingress';
import * as endpoints from '../../../src/core/kube/endpoints';
import * as forward from '../../../src/core/kube/forward';
import { createWorkspace } from '../../../src/core/kube/workspace';
import { ownedRuntimeState } from '../../../src/core/kube/cluster';
import * as release from '../../../src/core/kube/release';
import * as replicaset from '../../../src/core/kube/replicaset';
import * as manifests from '../../../src/core/kube/manifests';
import { kube, ownedKubeconfig } from '../../../src/core/kube/exec';
import {
  CLUSTER_NAME,
  CONTEXT,
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
} from '../../../src/core/kube/names';

jest.mock('../../../src/core/lifecycle/sizing', () => {
  const actual = jest.requireActual('../../../src/core/lifecycle/sizing');
  return { ...actual, checkCapacity: jest.fn(actual.checkCapacity) };
});
jest.mock('../../../src/core/lifecycle/ports', () => {
  const actual = jest.requireActual('../../../src/core/lifecycle/ports');
  return { ...actual, pickHostPort: jest.fn(actual.pickHostPort) };
});
jest.mock('../../../src/core/runner/ports', () => {
  const actual = jest.requireActual('../../../src/core/runner/ports');
  return { ...actual, portFree: jest.fn(actual.portFree) };
});
jest.mock('../../../src/core/runner/paths', () => {
  const actual = jest.requireActual('../../../src/core/runner/paths');
  return { ...actual, atomicWrite: jest.fn(actual.atomicWrite) };
});
jest.mock('../../../src/core/kube/context', () => {
  const actual = jest.requireActual('../../../src/core/kube/context');
  return { ...actual, planCluster: jest.fn(actual.planCluster) };
});
jest.mock('../../../src/core/kube/tools', () => {
  const actual = jest.requireActual('../../../src/core/kube/tools');
  return { ...actual, which: jest.fn(actual.which), missingTools: jest.fn(actual.missingTools) };
});
jest.mock('../../../src/core/kube/probe', () => {
  const actual = jest.requireActual('../../../src/core/kube/probe');
  return { ...actual, preflight: jest.fn(actual.preflight) };
});
jest.mock('../../../src/core/kube/chart', () => {
  const actual = jest.requireActual('../../../src/core/kube/chart');
  return {
    ...actual,
    ensureRepo: jest.fn(actual.ensureRepo),
    resolveChartVersion: jest.fn(actual.resolveChartVersion),
  };
});
jest.mock('../../../src/core/kube/certmanager', () => {
  const actual = jest.requireActual('../../../src/core/kube/certmanager');
  return {
    ...actual,
    ensureCertManager: jest.fn(actual.ensureCertManager),
    ensureIssuer: jest.fn(actual.ensureIssuer),
  };
});
jest.mock('../../../src/core/kube/ingress', () => {
  const actual = jest.requireActual('../../../src/core/kube/ingress');
  return { ...actual, ensureIngress: jest.fn(actual.ensureIngress) };
});
jest.mock('../../../src/core/kube/endpoints', () => {
  const actual = jest.requireActual('../../../src/core/kube/endpoints');
  return {
    ...actual,
    ingressEndpoint: jest.fn(actual.ingressEndpoint),
    hostPortClaim: jest.fn(actual.hostPortClaim),
  };
});
jest.mock('../../../src/core/kube/release', () => {
  const actual = jest.requireActual('../../../src/core/kube/release');
  return { ...actual, apply: jest.fn(actual.apply), install: jest.fn(actual.install) };
});
jest.mock('../../../src/core/kube/replicaset', () => {
  const actual = jest.requireActual('../../../src/core/kube/replicaset');
  return { ...actual, initReplicaSet: jest.fn(actual.initReplicaSet) };
});
jest.mock('../../../src/core/kube/manifests', () => {
  const actual = jest.requireActual('../../../src/core/kube/manifests');
  return {
    ...actual,
    containerSecurityContext: jest.fn(actual.containerSecurityContext),
    recordRendered: jest.fn(actual.recordRendered),
  };
});

jest.mock('../../../src/core/kube/forward', () => ({
  ...jest.requireActual('../../../src/core/kube/forward'),
  portForward: jest.fn(),
  forwardAlive: jest.fn(),
  scenarioUiForwards: jest.fn(),
}));

const realRun = kube.run;
let calls: string[][];
let clusterExists: boolean;
let marker: boolean;
let namespace: Record<string, unknown> | null;
let collision: boolean;
let failure: string;

beforeEach(() => {
  jest
    .mocked(paths.atomicWrite)
    .mockImplementation(
      jest.requireActual<typeof paths>('../../../src/core/runner/paths').atomicWrite,
    );
  calls = [];
  clusterExists = false;
  marker = false;
  namespace = null;
  collision = false;
  failure = 'chart';
  fs.rmSync(ownedKubeconfig(), { force: true });
  config.updateConfig((stored) => grant(stored, 'owned-cluster'));
  jest.mocked(sizing.checkCapacity).mockResolvedValue();
  jest.mocked(ports.pickHostPort).mockResolvedValue(3000);
  jest.mocked(runnerPorts.portFree).mockResolvedValue(true);
  jest
    .mocked(context.planCluster)
    .mockResolvedValue({ context: CONTEXT, distribution: 'kind', create: true });
  jest.mocked(tools.which).mockImplementation((name) => `/synthetic/${name}`);
  jest.mocked(tools.missingTools).mockReturnValue([]);
  jest.mocked(probe.preflight).mockResolvedValue({
    ...tools.preflight(),
    context: CONTEXT,
    distribution: 'kind',
    clusterReachable: true,
    defaultStorageClass: 'standard',
    architectures: ['amd64'],
    unreadable: [],
  });
  jest.mocked(certmanager.ensureCertManager).mockImplementation(async () => {
    if (failure.startsWith('tls')) throw new Error('TLS planning failed');
  });
  jest.mocked(certmanager.ensureIssuer).mockResolvedValue();
  jest.mocked(ingress.ensureIngress).mockResolvedValue('nginx');
  // A remote ingress avoids local edge startup; this test owns no listeners or network.
  jest.mocked(endpoints.ingressEndpoint).mockResolvedValue({
    address: '192.0.2.1',
    port: 443,
    local: false,
    source: 'loadbalancer',
    service: 'ingress-nginx/controller',
  });
  jest.mocked(endpoints.hostPortClaim).mockResolvedValue(null);
  jest.mocked(chart.ensureRepo).mockResolvedValue();
  jest.mocked(chart.resolveChartVersion).mockResolvedValue('7.0.2');
  jest.mocked(release.apply).mockResolvedValue();
  jest.mocked(release.install).mockImplementation(async () => {
    if (failure === 'replacement' && namespace !== null) {
      (namespace.metadata as Record<string, unknown>).uid = 'replacement-namespace-uid';
    }
    throw new Error('chart failed');
  });
  jest.mocked(replicaset.initReplicaSet).mockResolvedValue();
  jest.mocked(manifests.containerSecurityContext).mockResolvedValue({});
  jest.mocked(manifests.recordRendered).mockResolvedValue([]);
  kube.run = async (argv, options) => {
    calls.push([...argv]);
    let stdout = '';
    if (argv.includes('get') && argv.includes('clusters'))
      stdout = clusterExists ? CLUSTER_NAME : '';
    else if (argv[0] === 'kind' && argv.includes('create')) {
      clusterExists = true;
      if (collision) {
        marker = true;
        return { argv, returncode: 1, stdout: '', stderr: 'node(s) already exist' };
      }
    } else if (argv.includes('current-context')) stdout = CONTEXT;
    else if (argv.includes('configmap') && argv.includes('get')) {
      if (marker && failure === 'tls-unknown')
        return { argv, returncode: 1, stdout: '', stderr: 'marker unavailable' };
      stdout = marker
        ? JSON.stringify({
            metadata: { labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE } },
            data: { cluster: CLUSTER_NAME },
          })
        : '';
    } else if (argv.includes('/readyz')) stdout = 'ok';
    else if (argv.includes('apply') && options?.input?.includes('ConfigMap')) marker = true;
    else if (argv.includes('create') && options?.input?.includes('Namespace')) {
      if (failure.startsWith('namespace-') && failure !== 'namespace-uncertain') {
        return { argv, returncode: 1, stdout: '', stderr: 'namespace acquisition failed' };
      }
      namespace = JSON.parse(options.input) as Record<string, unknown>;
      (namespace.metadata as Record<string, unknown>).uid = 'created-namespace-uid';
      (namespace.metadata as Record<string, unknown>).resourceVersion = '1';
      if (failure === 'namespace-uncertain')
        return { argv, returncode: 1, stdout: '', stderr: 'namespace acquisition failed' };
      stdout = JSON.stringify(namespace);
    } else if (argv.includes('get') && argv.includes('namespace')) {
      if (
        failure === 'namespace-unknown' &&
        calls.some((call) => call.includes('create') && call.includes('-f'))
      )
        return { argv, returncode: 1, stdout: '', stderr: 'namespace unavailable' };
      if (failure === 'namespace-foreign')
        namespace = {
          metadata: {
            name: String(argv[argv.indexOf('namespace') + 1]),
            uid: 'foreign-uid',
            labels: {},
          },
        };
      stdout =
        argv.includes('--selector') || argv.includes('-l')
          ? JSON.stringify({
              items:
                failure === 'other-workspace' || failure === 'namespace-other-workspace'
                  ? [{ metadata: { name: 'houston-colleague' } }]
                  : namespace === null
                    ? []
                    : [namespace],
            })
          : namespace === null
            ? ''
            : JSON.stringify(namespace);
    } else if (argv.includes('delete') && argv[0] === 'kind') clusterExists = false;
    else if (argv.includes('delete')) namespace = null;
    else if (argv.includes('export')) {
      fs.mkdirSync(path.dirname(ownedKubeconfig()), { recursive: true });
      fs.writeFileSync(ownedKubeconfig(), 'synthetic owned client');
    }
    return { argv, returncode: 0, stdout, stderr: '' };
  };
});
afterEach(() => {
  kube.run = realRun;
});

it.each(['chart', 'tls', 'record', 'existing-plan-chart'])(
  'rolls back its actual TLS-created cluster after %s failure',
  async (stage) => {
    failure = stage;
    if (stage === 'existing-plan-chart') {
      jest
        .mocked(context.planCluster)
        .mockResolvedValue({ context: CONTEXT, distribution: 'kind', create: false });
    }
    if (stage === 'record')
      jest.mocked(paths.atomicWrite).mockRejectedValue(new Error('record failed'));
    await expect(
      createKubernetes(
        createReq({
          version: '8.5.1',
          name: `receipt-${stage}`,
          runtime: 'kubernetes',
          offline: true,
          domain: `${stage}.example.com`,
          acmeEmail: 'owner@example.com',
        }),
      ),
    ).rejects.toThrow(
      `${stage === 'tls' ? 'TLS planning' : stage === 'existing-plan-chart' ? 'chart' : stage} failed`,
    );
    expect(calls.some((argv) => argv[0] === 'kind' && argv.includes('create'))).toBe(true);
    expect(clusterExists).toBe(false);
    expect(namespace).toBeNull();
    expect(calls.filter((argv) => argv[0] === 'kind' && argv.includes('delete'))).toHaveLength(1);
  },
);

it('preserves the collision winner when the later chart fails', async () => {
  collision = true;
  await expect(
    createKubernetes(
      createReq({
        version: '8.5.1',
        name: 'receipt-loser',
        runtime: 'kubernetes',
        offline: true,
        domain: 'loser.example.com',
        acmeEmail: 'owner@example.com',
      }),
    ),
  ).rejects.toThrow('chart failed');
  expect(namespace).toBeNull();
  expect(clusterExists).toBe(true);
  expect(calls.some((argv) => argv[0] === 'kind' && argv.includes('delete'))).toBe(false);
});

it('creates a workspace using the marked owned client when Kind is absent', async () => {
  clusterExists = true;
  marker = true;
  fs.mkdirSync(path.dirname(ownedKubeconfig()), { recursive: true });
  fs.writeFileSync(ownedKubeconfig(), 'synthetic owned client');
  jest
    .mocked(tools.which)
    .mockImplementation((name) => (name === 'kind' ? '' : `/synthetic/${name}`));
  jest.mocked(release.install).mockResolvedValue();
  jest.mocked(forward.portForward).mockResolvedValue(4242);
  jest.mocked(forward.forwardAlive).mockResolvedValue(true);
  jest.mocked(forward.scenarioUiForwards).mockResolvedValue({});
  const result = await createWorkspace({
    name: 'receipt-reuse',
    hostPort: 3000,
    microservices: false,
    plan: { context: CONTEXT, distribution: 'kind', create: false },
    resolved: {
      rcVersion: '8.5.1',
      rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      mongoShell: 'mongosh',
      oplog: false,
      source: 'map (fallback)',
      note: '',
    },
    sleep: async () => {},
  });
  expect(result.namespace_uid).toBe('created-namespace-uid');
  expect(result.port_forward_pid).toBe(4242);
  expect(calls.some((argv) => argv[0] === 'kind')).toBe(false);
  expect(clusterExists).toBe(true);
});

it('reads unavailable runtime state without creating owned client directories', async () => {
  fs.rmSync(path.dirname(ownedKubeconfig()), { recursive: true, force: true });
  expect(await ownedRuntimeState()).toBe('unavailable');
  expect(fs.existsSync(path.dirname(ownedKubeconfig()))).toBe(false);
  expect(calls).toEqual([]);
});

it.each(['tls-unknown', 'replacement', 'other-workspace'])(
  'preserves protected state after %s failure',
  async (state) => {
    failure = state;
    await expect(
      createKubernetes(
        createReq({
          version: '8.5.1',
          name: `receipt-${state}`,
          runtime: 'kubernetes',
          offline: true,
          domain: `${state}.example.com`,
          acmeEmail: 'owner@example.com',
        }),
      ),
    ).rejects.toThrow(state === 'tls-unknown' ? 'TLS planning failed' : 'chart failed');
    expect(clusterExists).toBe(true);
    expect(calls.some((argv) => argv[0] === 'kind' && argv.includes('delete'))).toBe(false);
    if (state === 'replacement') {
      expect((namespace?.metadata as Record<string, unknown>).uid).toBe(
        'replacement-namespace-uid',
      );
      expect(calls.some((argv) => argv[0] === 'kubectl' && argv.includes('delete'))).toBe(false);
    }
  },
);

it.each([
  'namespace-empty',
  'namespace-uncertain',
  'namespace-unknown',
  'namespace-foreign',
  'namespace-other-workspace',
])('handles %s without losing the TLS creation receipt', async (state) => {
  failure = state;
  await expect(
    createKubernetes(
      createReq({
        version: '8.5.1',
        name: `receipt-${state}`,
        runtime: 'kubernetes',
        offline: true,
        domain: `${state}.example.com`,
        acmeEmail: 'owner@example.com',
      }),
    ),
  ).rejects.toThrow();
  expect(calls.some((argv) => argv[0] === 'kind' && argv.includes('create'))).toBe(true);
  expect(clusterExists).toBe(state !== 'namespace-empty');
  expect(calls.filter((argv) => argv[0] === 'kind' && argv.includes('delete'))).toHaveLength(
    state === 'namespace-empty' ? 1 : 0,
  );
  expect(calls.some((argv) => argv[0] === 'kubectl' && argv.includes('delete'))).toBe(false);
});

it('retains actual creation authority across later TLS and lifecycle reuse calls', async () => {
  const job = kubeCreate({
    req: createReq({
      version: '8.5.1',
      name: 'receipt-repeat',
      runtime: 'kubernetes',
      domain: 'repeat.example.com',
      acmeEmail: 'owner@example.com',
    }),
    emit: () => {},
    monitorAttach: async () => ({}),
    reproName: 'receipt-repeat',
    plan: { context: CONTEXT, distribution: 'kind', create: true },
  });
  await planTls(job);
  await planKubeTls(job);
  expect(job.clusterReceipt.createdHere).toBe(true);
  await planKubeTls(job);
  expect(job.clusterReceipt.createdHere).toBe(true);
  job.plan = { context: CONTEXT, distribution: 'kind', create: false };
  await planTls(job);
  expect(job.clusterReceipt.createdHere).toBe(true);
  expect(calls.filter((argv) => argv[0] === 'kind' && argv.includes('create'))).toHaveLength(1);
});
