import * as ask from '../../../src/core/kube/ask';
import * as context from '../../../src/core/kube/context';
import { PRESENT, REFUSED, answer } from '../../../src/core/kube/ask';
import { CLUSTER_NAME, CONTEXT } from '../../../src/core/kube/names';
import { Interrupted } from '../../../src/seams/exec';
import { inventory, nodeRecord, serviceRecord } from '../../../src/core/kube/inventory';

jest.mock('../../../src/core/kube/ask', () => ({
  ...jest.requireActual<object>('../../../src/core/kube/ask'),
  askList: jest.fn(),
}));

jest.mock('../../../src/core/kube/context', () => ({
  clusters: jest.fn(),
}));

const askList = ask.askList as jest.MockedFunction<typeof ask.askList>;
const clusters = context.clusters as jest.MockedFunction<typeof context.clusters>;

afterEach(() => {
  jest.clearAllMocks();
});

describe('the Kubernetes inspection rows', () => {
  it('keeps the node facts the Python inspection exposed, without labels outside roles', () => {
    expect(
      nodeRecord({
        metadata: {
          name: 'worker-a',
          creationTimestamp: '2026-10-01T12:00:00Z',
          labels: {
            'node-role.kubernetes.io/worker': '',
            'node-role.kubernetes.io/control-plane': null,
            'unrelated.example/role': 'x',
          },
        },
        status: {
          nodeInfo: {
            kubeletVersion: 'v1.37.0',
            osImage: 'Ubuntu',
            kernelVersion: '6.8.0',
            containerRuntimeVersion: 'containerd://2.0.0',
          },
          conditions: [{ type: 'Ready', status: 'True' }],
          addresses: [
            { type: 'InternalIP', address: '10.0.0.7' },
            { type: 'ExternalIP', address: '198.51.100.7' },
          ],
          allocatable: { cpu: '7910m', memory: '16298896Ki' },
        },
      }),
    ).toEqual({
      name: 'worker-a',
      status: 'Ready',
      roles: ['worker'],
      version: 'v1.37.0',
      ready: true,
      internal_ip: '10.0.0.7',
      external_ip: '198.51.100.7',
      os_image: 'Ubuntu',
      kernel_version: '6.8.0',
      container_runtime: 'containerd://2.0.0',
      created_at: '2026-10-01T12:00:00Z',
      allocatable_cpu: '7910m',
      allocatable_memory: '16298896Ki',
    });
  });

  it('keeps named target ports, NodePorts and load-balancer hostnames', () => {
    expect(
      serviceRecord({
        metadata: { name: 'rocketchat' },
        spec: {
          type: 'LoadBalancer',
          clusterIP: '10.96.0.12',
          externalIPs: ['203.0.113.12'],
          ports: [
            { name: 'web', protocol: 'TCP', port: 3000, targetPort: 'http', nodePort: 32000 },
            { name: 'metrics', port: 9090, targetPort: 9090 },
          ],
        },
        status: { loadBalancer: { ingress: [{ hostname: 'lb.example.test' }] } },
      }),
    ).toEqual({
      name: 'rocketchat',
      type: 'LoadBalancer',
      cluster_ip: '10.96.0.12',
      external_ips: ['203.0.113.12', 'lb.example.test'],
      ports: [
        { name: 'web', protocol: 'TCP', port: 3000, target_port: 'http', node_port: 32000 },
        { name: 'metrics', protocol: 'TCP', port: 9090, target_port: '9090', node_port: null },
      ],
    });
  });

  it('keeps partial inventory and marks refused or malformed reads as unknown', async () => {
    clusters.mockResolvedValue([[CLUSTER_NAME], '']);
    askList.mockImplementation(async (kind) => {
      if (kind === 'nodes') {
        return answer(PRESENT, {
          items: [
            { metadata: { name: 'z' }, status: {} },
            { metadata: { name: 'a' }, status: {} },
          ],
        });
      }
      if (kind === 'services') return answer(REFUSED);
      return answer(PRESENT, { items: { malformed: true } });
    });

    await expect(inventory({ context: CONTEXT, namespace: 'houston-ticket' })).resolves.toEqual(
      expect.objectContaining({
        context: CONTEXT,
        namespace: 'houston-ticket',
        cluster_exists: true,
        nodes: [expect.objectContaining({ name: 'a' }), expect.objectContaining({ name: 'z' })],
        services: [],
        pods: [],
        warnings: ['could not inspect repro services', 'Kubernetes returned invalid pod JSON'],
      }),
    );
    expect(askList).toHaveBeenNthCalledWith(1, 'nodes', { context: CONTEXT });
    expect(askList).toHaveBeenNthCalledWith(2, 'services', {
      context: CONTEXT,
      namespace: 'houston-ticket',
    });
    expect(askList).toHaveBeenNthCalledWith(3, 'pods', {
      context: CONTEXT,
      namespace: 'houston-ticket',
    });
  });

  it('does not use the local Kind cluster as an answer about another recorded context', async () => {
    clusters.mockResolvedValue([[CLUSTER_NAME], '']);
    askList.mockResolvedValue(answer(PRESENT, { items: [] }));

    await expect(
      inventory({ context: 'shared-cluster', namespace: 'houston-ticket' }),
    ).resolves.toEqual({
      context: 'shared-cluster',
      namespace: 'houston-ticket',
      cluster_exists: null,
      nodes: [],
      services: [],
      pods: [],
      warnings: [],
    });
    expect(clusters).not.toHaveBeenCalled();
  });

  it('keeps valid resource rows and warns when an item loses its identity or port structure', async () => {
    clusters.mockResolvedValue([[CLUSTER_NAME], '']);
    askList.mockImplementation(async (kind) => {
      if (kind === 'nodes') {
        return answer(PRESENT, {
          items: [{ metadata: { name: 'worker-a' }, status: {} }, {}],
        });
      }
      if (kind === 'services') {
        return answer(PRESENT, {
          items: [
            {
              metadata: { name: 'rocketchat' },
              spec: { ports: [{ port: 3000, targetPort: 'http' }] },
            },
            { metadata: { name: 'broken' }, spec: { ports: { malformed: true } } },
            {
              metadata: { name: 'nested-target' },
              spec: { ports: [{ port: 80, targetPort: { malformed: true } }] },
            },
            {
              metadata: { name: 'nested-node' },
              spec: { ports: [{ port: 80, nodePort: { malformed: true } }] },
            },
            {
              metadata: { name: 'unknown-protocol' },
              spec: { ports: [{ port: 80, protocol: 'ICMP' }] },
            },
            { metadata: { name: 'out-of-range' }, spec: { ports: [{ port: 65536 }] } },
          ],
        });
      }
      return answer(PRESENT, {
        items: [{ metadata: { name: 'rocketchat-0' }, status: {} }, {}],
      });
    });

    await expect(inventory({ context: CONTEXT, namespace: 'houston-ticket' })).resolves.toEqual(
      expect.objectContaining({
        cluster_exists: true,
        nodes: [expect.objectContaining({ name: 'worker-a' })],
        services: [
          expect.objectContaining({
            name: 'rocketchat',
            ports: [expect.objectContaining({ port: 3000, target_port: 'http', node_port: null })],
          }),
        ],
        pods: [expect.objectContaining({ service: 'rocketchat-0' })],
        warnings: [
          'Kubernetes returned invalid node JSON',
          'Kubernetes returned invalid service JSON',
          'Kubernetes returned invalid pod JSON',
        ],
      }),
    );
  });

  it('does not select a default context or namespace when the workspace lacks one', async () => {
    await expect(inventory({ context: '', namespace: 'houston-ticket' })).resolves.toEqual({
      context: '',
      namespace: 'houston-ticket',
      cluster_exists: null,
      nodes: [],
      services: [],
      pods: [],
      warnings: ['the repro has no recorded Kubernetes context or namespace'],
    });
    expect(askList).not.toHaveBeenCalled();
    expect(clusters).not.toHaveBeenCalled();
  });

  it('does not turn Ctrl-C into an empty inventory warning', async () => {
    clusters.mockResolvedValue([[], '']);
    askList.mockRejectedValue(new Interrupted());

    await expect(
      inventory({ context: CONTEXT, namespace: 'houston-ticket' }),
    ).rejects.toBeInstanceOf(Interrupted);
  });
});
