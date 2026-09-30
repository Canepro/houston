/**
 * The Kubernetes create path, from `createRepro` down to the cluster module that builds it.
 *
 * Each case asserts something `lifecycle` does with what this package answers, which is why they
 * sit beside the package. The cluster itself is the double: the plan, the kubeconfig export, helm's
 * answer, the namespace preflight and `createWorkspace` are stated, exactly the functions that
 * reach outside, and the orchestration between them is the real one. Nothing reaches a cluster,
 * the network or Docker.
 */
import type * as ClusterNS from '../../../src/core/kube/cluster';
import type * as ContextNS from '../../../src/core/kube/context';
import type * as NamespaceNS from '../../../src/core/kube/namespace';
import type * as ProbeNS from '../../../src/core/kube/probe';
import type * as ReachabilityNS from '../../../src/core/kube/reachability';
import type * as ToolsNS from '../../../src/core/kube/tools';
import type * as WorkspaceNS from '../../../src/core/kube/workspace';
import type * as PortsNS from '../../../src/core/lifecycle/ports';
import type * as ReadyNS from '../../../src/core/lifecycle/ready';
import type * as SeedingNS from '../../../src/core/lifecycle/seeding';
import type * as SizingNS from '../../../src/core/lifecycle/sizing';

import { PreflightError, ValidationError } from '../../../src/lib/errors';
import { nullEmit } from '../../../src/lib/events';
import type { KubectlResult } from '../../../src/seams/kubectl';
import { createRepro } from '../../../src/core/lifecycle/create-docker';
import { createKubernetes } from '../../../src/core/lifecycle/create-k8s';
import { createReq } from '../../../src/core/lifecycle/types';
import { exists } from '../../../src/core/runner/paths';
import { usedPorts } from '../../../src/core/runner/ports';
import { readMeta } from '../../../src/core/runner/record';
import * as topology from '../../../src/core/topology';

import { kube } from '../../../src/core/kube/exec';
import { CONTEXT } from '../../../src/core/kube/names';
import { namespaceFor } from '../../../src/core/kube/namespace';

/** What each stated function answers; `null` hands the call to the real one. */
let mockPort = 3000;
let mockPlan: ((context?: string) => Promise<ContextNS.ClusterPlan>) | null = null;
let mockHelm = '';
let mockCreate: ((options: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
  null;
const mockCalls: string[] = [];
const mockCreated: Record<string, unknown>[] = [];

jest.mock('../../../src/core/lifecycle/sizing', () => ({
  ...jest.requireActual<typeof SizingNS>('../../../src/core/lifecycle/sizing'),
  // The host's free memory is not what any of these is about.
  checkCapacity: () => Promise.resolve(),
}));
jest.mock('../../../src/core/lifecycle/ports', () => ({
  ...jest.requireActual<typeof PortsNS>('../../../src/core/lifecycle/ports'),
  pickHostPort: () => Promise.resolve(mockPort),
}));
jest.mock('../../../src/core/kube/probe', () => {
  const tools = jest.requireActual<typeof ToolsNS>('../../../src/core/kube/tools');
  return {
    ...jest.requireActual<typeof ProbeNS>('../../../src/core/kube/probe'),
    // kubectl and helm are here; which cluster is planCluster's business, below.
    preflight: () =>
      Promise.resolve(
        tools.preflight({
          tools: {
            kubectl: tools.makeTool({
              name: 'kubectl',
              path: '/usr/bin/kubectl',
              version: [1, 36],
            }),
            helm: tools.makeTool({ name: 'helm', path: '/usr/bin/helm', version: [3, 15] }),
          },
        }),
      ),
  };
});
jest.mock('../../../src/core/kube/context', () => {
  const actual = jest.requireActual<typeof ContextNS>('../../../src/core/kube/context');
  return {
    ...actual,
    planCluster: (context = '') => (mockPlan ?? actual.planCluster)(context),
  };
});
jest.mock('../../../src/core/kube/cluster', () => ({
  ...jest.requireActual<typeof ClusterNS>('../../../src/core/kube/cluster'),
  // The export it would do for the plan reaches for kind, which none of these are about.
  ensureKubeconfig: (plan: { context: string }) => Promise.resolve(plan.context),
}));
jest.mock('../../../src/core/kube/reachability', () => ({
  ...jest.requireActual<typeof ReachabilityNS>('../../../src/core/kube/reachability'),
  helmReachable: () => Promise.resolve(mockHelm),
}));
jest.mock('../../../src/core/kube/namespace', () => ({
  ...jest.requireActual<typeof NamespaceNS>('../../../src/core/kube/namespace'),
  assertNamespaceAvailable: (name: string) => {
    mockCalls.push(`assertNamespaceAvailable:${name}`);
    return Promise.resolve();
  },
}));
jest.mock('../../../src/core/kube/workspace', () => ({
  ...jest.requireActual<typeof WorkspaceNS>('../../../src/core/kube/workspace'),
  createWorkspace: (options: Record<string, unknown>) => {
    mockCreated.push(options);
    if (mockCreate !== null) return mockCreate(options);
    return Promise.resolve({
      context: CONTEXT,
      namespace: `houston-${String(options.name)}`,
      chart_version: '7.0.0',
      release: 'rocketchat',
      port_forward_pid: 0,
      bind_host: '',
      microservices: false,
    });
  },
}));
jest.mock('../../../src/core/lifecycle/ready', () => ({
  ...jest.requireActual<typeof ReadyNS>('../../../src/core/lifecycle/ready'),
  waitAndFinalize: () => {
    mockCalls.push('wait');
    return Promise.resolve({ ready: true });
  },
}));
jest.mock('../../../src/core/lifecycle/seeding', () => ({
  ...jest.requireActual<typeof SeedingNS>('../../../src/core/lifecycle/seeding'),
  runSeedInline: () => {
    mockCalls.push('seed');
    return Promise.resolve({ users: 5 });
  },
}));

const realRun = kube.run;

/** A cluster that exists, is not ours to build, and answers. */
const adopted = (context: string, distribution: string) => () =>
  Promise.resolve({ context, distribution, create: false });

beforeEach(() => {
  mockPort = 3000;
  mockPlan = adopted(CONTEXT, 'kind');
  mockHelm = '';
  mockCreate = null;
  mockCalls.length = 0;
  mockCreated.length = 0;
});

afterEach(() => {
  kube.run = realRun;
});

describe('a Kubernetes create', () => {
  it('waits for the workspace to SERVE before it seeds it', async () => {
    // `up --seed` ran the seeder the instant helm returned -- "can't seed — repro not
    // ready". The CLI forces wait when seeding, and this path never read it. Helm returning
    // is not Rocket.Chat serving.
    await createKubernetes(
      createReq({
        version: '8.5.1',
        name: 'kseed',
        seed: true,
        wait: true,
        runtime: 'kubernetes',
        offline: true,
      }),
    );
    expect(mockCalls.filter((call) => call === 'wait' || call === 'seed')).toEqual([
      'wait',
      'seed',
    ]);

    // And without --seed or --wait it still returns promptly.
    mockCalls.length = 0;
    await createKubernetes(
      createReq({ version: '8.5.1', name: 'kseed', runtime: 'kubernetes', offline: true }),
    );
    expect(mockCalls.filter((call) => call === 'wait' || call === 'seed')).toEqual([]);
  });

  it('passes the workspace the URL it just computed', async () => {
    // `createWorkspace` has taken `rootUrl` since it was written, and nothing gave it one --
    // so `valuesFor` had a branch for it that was dead on every real create, and a whole
    // runtime shipped with no ROOT_URL.
    mockPort = 3456;
    await createKubernetes(
      createReq({ version: '8.5.1', name: 'kurl', runtime: 'kubernetes', offline: true }),
    );
    expect(mockCreated[0]?.rootUrl).toBe('http://localhost:3456');
  });

  it('leaves a record behind when it is killed part-way', async () => {
    // Stopping `serve` with a create running left a full microservices workspace, twelve
    // pods, running and INVISIBLE: `list`, `info` and `down` all begin at the state
    // directory and there was nothing in it. Compose writes its record first; so does this.
    mockCreate = () => Promise.reject(new Error('serve shut down mid-create'));
    await expect(
      createRepro(
        createReq({
          version: '8.5.1',
          name: 'interrupted',
          runtime: 'kubernetes',
          deployment: 'microservices',
          offline: true,
        }),
      ),
    ).rejects.toThrow('serve shut down mid-create');
    expect(await exists('interrupted')).toBe(true);
    const meta = await readMeta('interrupted');
    expect(topology.ofMeta(meta)).toBe(topology.KUBERNETES);
    // Teardown selects on the namespace, so it has to be recorded...
    expect(meta.extra.namespace).toBe(await namespaceFor('interrupted'));
    // ...and it must be distinguishable from a create that finished.
    expect(meta.extra.incomplete).toBe(true);
  });

  it('leaves NO record when it is refused for want of a cluster', async () => {
    // Measured on a box with k3s and no kind: the refusal left an `incomplete` repro.json,
    // `list` showed it, and `usedPorts()` went on reserving its port. The write-ahead record
    // is not the problem -- the ORDER was: choosing the cluster only probes, so it belongs
    // above the write. The real resolver runs here, on a box with no kind and nothing for
    // kubectl to point at.
    mockPlan = null;
    // The file's home already holds the workspaces above, so the claim is on THIS create:
    // the port it would have taken is not reserved afterwards.
    mockPort = 3142;
    const before = [...(await usedPorts())].sort();
    kube.run = (argv) =>
      Promise.resolve({ argv, returncode: 1, stdout: '', stderr: 'no cluster' } as KubectlResult);
    await expect(
      createKubernetes(
        createReq({ version: '8.5.1', name: 'ghost', runtime: 'kubernetes', offline: true }),
      ),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(await exists('ghost')).toBe(false);
    expect([...(await usedPorts())].sort()).toEqual(before);
    expect(before).not.toContain(3142);
    expect(mockCreated).toEqual([]);
  });

  it('refuses before building anything when helm cannot reach a cluster kubectl can', async () => {
    // THE DEFECT, and it cost four minutes each time: kubectl entirely happy, helm refusing
    // every call, so the create built a namespace, a StatefulSet, a volume and an initiated
    // replica set, then died at the chart and rolled all of it back with an error naming
    // neither the cause nor the cure. A refusal here leaves nothing.
    mockPlan = adopted('default', 'k3s');
    mockHelm =
      'Error: kubernetes cluster unreachable: x509: certificate signed by unknown authority';
    const refusal = await createRepro(
      createReq({
        version: '8.5.1',
        name: 'hg',
        runtime: 'kubernetes',
        wait: false,
        offline: true,
      }),
      nullEmit,
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ValidationError);
    const said = (refusal as Error).message;
    expect(said).toContain('helm cannot reach cluster');
    expect(said).toContain('although kubectl can');
    // The CURE, named -- the whole difference from the error it replaces.
    expect(said).toContain('previous install of the same cluster');
    expect(said).toContain('/etc/rancher/k3s/k3s.yaml > ~/.kube/config');
    expect(said).toContain('kind export kubeconfig');
    expect(said).toContain('doctor');
    // Anything that would BUILD is a failure of the gate, not of the stub.
    expect(mockCalls.filter((call) => call.startsWith('assertNamespaceAvailable'))).toEqual([]);
    expect(mockCreated).toEqual([]);
  });
});
