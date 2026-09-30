/**
 * Where a Kubernetes workspace's NAME is served from, and who is told when it cannot be.
 *
 * The three cases that carry an endpoint answer into the code that ACTS on it: the create's HTTPS
 * plan, the edge's route to a kind node, and `edge start`. They live beside `endpoints` because
 * every one is that module's answer put to work; the cluster reads are stated, since what is under
 * test is the decision, not kubectl.
 */
import type * as CertmanagerNS from '../../../src/core/kube/certmanager';
import type * as EndpointsNS from '../../../src/core/kube/endpoints';
import type * as IngressNS from '../../../src/core/kube/ingress';
import type * as ProbeNS from '../../../src/core/kube/probe';
import type * as ToolsNS from '../../../src/core/kube/tools';
import type * as EdgeEngineNS from '../../../src/core/edge/engine';
import type * as EdgeNetworksNS from '../../../src/core/edge/networks';
import type * as EdgeRoutesNS from '../../../src/core/edge/routes';
import type * as EdgeSpecNS from '../../../src/core/edge/spec';

import { portClaimNote } from '../../../src/cli/handlers/https';
import { routeKubernetesName, kubernetesTlsPlan } from '../../../src/core/lifecycle/tlsplan';
import { createReq, kubeTls } from '../../../src/core/lifecycle/types';
import { MODE_ACME, type TlsSpec } from '../../../src/core/tls';

import type { IngressEndpoint, PortClaim } from '../../../src/core/kube/endpoints';

/** What the cluster's ingress Service answers, and what it holds on this host. */
let mockEndpoint: IngressEndpoint | null = null;
let mockClaim: PortClaim | null = null;
/** Which Docker network each container is on, and which ones the edge joined. */
let mockNetworks: Record<string, string> = {};
const mockJoined: string[] = [];

jest.mock('node:dns/promises', () => ({
  ...jest.requireActual<object>('node:dns/promises'),
  // No name resolves, which `nameReaches` reads as "not yet propagated" -- the normal
  // state of a name being set up -- and which keeps this suite off the network.
  lookup: () =>
    Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
}));
jest.mock('../../../src/core/kube/probe', () => ({
  ...jest.requireActual<typeof ProbeNS>('../../../src/core/kube/probe'),
  preflight: () =>
    Promise.resolve(
      jest.requireActual<typeof ToolsNS>('../../../src/core/kube/tools').preflight({
        context: 'ctx',
        distribution: 'eks',
        clusterReachable: true,
      }),
    ),
}));
jest.mock('../../../src/core/kube/ingress', () => ({
  ...jest.requireActual<typeof IngressNS>('../../../src/core/kube/ingress'),
  ensureIngress: () => Promise.resolve('traefik'),
}));
jest.mock('../../../src/core/kube/certmanager', () => ({
  ...jest.requireActual<typeof CertmanagerNS>('../../../src/core/kube/certmanager'),
  ensureCertManager: () => Promise.resolve(),
}));
jest.mock('../../../src/core/kube/endpoints', () => ({
  ...jest.requireActual<typeof EndpointsNS>('../../../src/core/kube/endpoints'),
  ingressEndpoint: () => Promise.resolve(mockEndpoint),
  hostPortClaim: () => Promise.resolve(mockClaim),
  portClaimingCluster: () => Promise.resolve(mockClaim),
}));
jest.mock('../../../src/core/edge/spec', () => ({
  ...jest.requireActual<typeof EdgeSpecNS>('../../../src/core/edge/spec'),
  installed: () => true,
}));
jest.mock('../../../src/core/edge/engine', () => ({
  ...jest.requireActual<typeof EdgeEngineNS>('../../../src/core/edge/engine'),
  running: () => Promise.resolve(true),
  portHolder: () => Promise.resolve(''),
}));
jest.mock('../../../src/core/edge/routes', () => ({
  ...jest.requireActual<typeof EdgeRoutesNS>('../../../src/core/edge/routes'),
  register: () => Promise.resolve(false),
}));
jest.mock('../../../src/core/edge/networks', () => ({
  ...jest.requireActual<typeof EdgeNetworksNS>('../../../src/core/edge/networks'),
  containerNetwork: (container: string) => Promise.resolve(mockNetworks[container] ?? ''),
  attachNetwork: (net: string) => {
    mockJoined.push(net);
    return Promise.resolve(true);
  },
}));

beforeEach(() => {
  mockEndpoint = null;
  mockClaim = null;
  mockNetworks = {};
  mockJoined.length = 0;
});

describe('a name served by a cluster', () => {
  it('joins a kind cluster’s Docker network, and nothing for a k3s one', async () => {
    // kind's node is a CONTAINER on kind's own network, so its ingress NodePort answers from
    // the host and not from a container on the default bridge -- which is exactly where the
    // edge is. Measured: reachable from the host and from the `kind` network, unreachable
    // from `bridge`. `edge.attach` derives a network from a WORKSPACE, and a cluster is not one.
    mockNetworks = { 'houston-local-control-plane': 'kind' };
    await routeKubernetesName(
      'ws',
      kubeTls({
        host: 'a.example.com',
        ingressClass: 'nginx',
        endpoint: {
          address: '172.18.0.2',
          port: 30925,
          source: 'nodeport',
          service: 'ingress-nginx/ingress-nginx-controller',
          local: false,
        },
        context: 'kind-houston-local',
        clusterOwns443: false,
      }),
    );
    expect(mockJoined).toEqual(['kind']);

    // A k3s cluster has nothing to join: its endpoint is on the host itself, and joining a
    // network k3s does not have would only fail.
    mockJoined.length = 0;
    await routeKubernetesName(
      'ws',
      kubeTls({
        host: 'a.example.com',
        ingressClass: 'traefik',
        endpoint: {
          address: '172.16.0.2',
          port: 443,
          source: 'loadbalancer',
          service: 'kube-system/traefik',
          local: true,
        },
        context: 'default',
        clusterOwns443: false,
      }),
    );
    expect(mockJoined).toEqual([]);
  });

  it('does not route a managed cluster’s name through this machine’s edge', async () => {
    // The edge on this laptop cannot front a load balancer in AWS: the name resolves to the
    // cluster's own load balancer, so no packet for it ever arrives here. MEASURED against a
    // real EKS cluster: `up --domain` announced "the http-01 challenge arrives on the edge's
    // :80", went to start an edge it had no use for, and refused the whole create because
    // another HOUSTON_HOME on the box owned one.
    const HOST = 't1.rc.example.com';
    const decide = async ({ local, claimPorts }: { local: boolean; claimPorts: number[] }) => {
      mockEndpoint = {
        address: local ? '172.16.0.2' : 'a1b2.elb.amazonaws.com',
        port: 443,
        source: 'loadbalancer',
        service: 'traefik/traefik',
        local,
      };
      mockClaim =
        claimPorts.length > 0
          ? { context: 'ctx', address: '172.16.0.2', ports: claimPorts, service: 'traefik/traefik' }
          : null;
      const said: string[] = [];
      const out = await kubernetesTlsPlan(
        createReq({
          version: '8.5.1',
          name: 't',
          runtime: 'kubernetes',
          domain: HOST,
          acmeEmail: 'a@b.c',
        }),
        {
          mode: MODE_ACME,
          host: HOST,
          port: 443,
          acmeEmail: 'a@b.c',
          acmeStaging: false,
        } as TlsSpec,
        { context: 'ctx', distribution: 'eks', create: false },
        { emit: (event) => said.push(event.message) },
      );
      return { owns: out.clusterOwns443, said };
    };

    // A MANAGED cluster: its ingress is elsewhere, so the cluster owns the name.
    let { owns, said } = await decide({ local: false, claimPorts: [] });
    expect(owns).toBe(true);
    // And the operator is told where the challenge actually goes.
    expect(said.some((message) => message.includes('not in the path'))).toBe(true);
    expect(said.some((message) => message.includes("edge's :80"))).toBe(false);

    // A LOCAL cluster holding this host's :443 is unchanged -- it always owned it.
    ({ owns } = await decide({ local: true, claimPorts: [80, 443] }));
    expect(owns).toBe(true);

    // A LOCAL cluster that does NOT hold :443 still goes through the edge, which is the
    // whole reason the edge exists.
    ({ owns, said } = await decide({ local: true, claimPorts: [] }));
    expect(owns).toBe(false);
    expect(said.some((message) => message.includes("edge's :80"))).toBe(true);
  });

  it('tells edge start the ports are held, and how to give them back', async () => {
    // `edge start` printed "every registered name is served again" about a box that served
    // none of them: ServiceLB claims host ports by DNAT, so the edge binds :80 and :443 and
    // kube-proxy takes every packet first. This note is what `edge start` prints instead of
    // the success line, and the only thing between it and two days of a dark GUI.
    mockClaim = {
      context: 'default',
      service: 'kube-system/traefik',
      address: '172.31.46.139',
      ports: [80, 443],
    };
    const note = await portClaimNote();
    expect(note).toContain("'default'");
    expect(note).toContain('172.31.46.139');
    // Hand over the command that gives the ports back, and how to stop it recurring.
    expect(note).toContain('NodePort');
    expect(note).toContain('--disable servicelb');

    // With nothing holding the ports there is no note, and the start says its plain success.
    mockClaim = null;
    expect(await portClaimNote()).toBe('');
  });
});
