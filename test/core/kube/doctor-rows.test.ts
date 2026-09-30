/**
 * What `doctor` says about Kubernetes, row by row.
 *
 * These cases live beside the tool probe because every row here is the probe's answer put
 * into words. Two ways of stating the box:
 *
 *   * the REAL preflight over a scripted funnel, with stand-in tools on PATH, for the claims
 *     about how a probe's answer reaches a row;
 *   * a STATED preflight, for the claims about how a row reads a given answer.
 *
 * `checkKubernetes` is the subject `doctor` reaches for these rows; the other
 * subjects neither read nor write anything these assert on.
 */
import type * as EndpointsNS from '../../../src/core/kube/endpoints';
import type * as ProbeNS from '../../../src/core/kube/probe';
import type * as EdgeRoutesNS from '../../../src/core/edge/routes';
import type * as EdgeSpecNS from '../../../src/core/edge/spec';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { KubectlResult } from '../../../src/seams/kubectl';
import { checkKubernetes } from '../../../src/core/doctor';
import { expiryDate, forget, identity, remember } from '../../../src/core/eks';

import { planCluster } from '../../../src/core/kube/context';
import { kube } from '../../../src/core/kube/exec';
import {
  CLUSTER_NAME,
  CONTEXT,
  PROVIDER_EXTERNAL,
  PROVIDER_KIND,
} from '../../../src/core/kube/names';
import { preflight as probePreflight } from '../../../src/core/kube/probe';
import { makeTool, preflight as preflightOf, type Preflight } from '../../../src/core/kube/tools';

/** A stated preflight, or null for the real one. */
let mockPreflight: Preflight | null = null;
/** A stated port claim, or null for the real probe. */
let mockClaim: EndpointsNS.PortClaim | null = null;
/** Whether the shared edge is installed, the names it serves, and the GUI's own name. */
let mockEdge: { installed: boolean; registered: string[]; domain?: string } = {
  installed: false,
  registered: [],
};

jest.mock('../../../src/core/kube/probe', () => {
  const actual = jest.requireActual<typeof ProbeNS>('../../../src/core/kube/probe');
  return {
    ...actual,
    preflight: (context = '') =>
      mockPreflight !== null ? Promise.resolve(mockPreflight) : actual.preflight(context),
  };
});
jest.mock('../../../src/core/kube/endpoints', () => {
  const actual = jest.requireActual<typeof EndpointsNS>('../../../src/core/kube/endpoints');
  return {
    ...actual,
    portClaimingCluster: (options?: Parameters<typeof actual.portClaimingCluster>[0]) =>
      mockClaim !== null ? Promise.resolve(mockClaim) : actual.portClaimingCluster(options),
  };
});
jest.mock('../../../src/core/edge/spec', () => ({
  ...jest.requireActual<typeof EdgeSpecNS>('../../../src/core/edge/spec'),
  installed: () => mockEdge.installed,
  current: () => (mockEdge.domain === undefined ? null : { domain: mockEdge.domain }),
}));
jest.mock('../../../src/core/edge/routes', () => ({
  ...jest.requireActual<typeof EdgeRoutesNS>('../../../src/core/edge/routes'),
  registered: () => mockEdge.registered,
}));

const realRun = kube.run;
const realPath = process.env.PATH;

type Row = Record<string, unknown> & { check: string; status: string; message: string };

/** The cloud side, stated: nothing installed and nobody signed in, unless a case says so. */
const NO_CLOUD = {
  tools: {
    aws: makeTool({ name: 'aws', path: '' }),
    eksctl: makeTool({ name: 'eksctl', path: '' }),
  },
  identity: identity(),
  region: '',
};

async function rows(cloud: unknown = NO_CLOUD, owned: unknown[] | null = []): Promise<Row[]> {
  return (await checkKubernetes({
    context: '',
    dockerUp: false,
    cloud: Promise.resolve(cloud as Record<string, unknown>),
    owned: owned === null ? null : Promise.resolve(owned as Record<string, unknown>[]),
  })) as Row[];
}

const messages = (list: Row[]) => list.map((row) => row.message);

/** A scripted funnel: substrings in order, `helm list` answering, the rest failing. */
function fakeRun(mapping: [string, number, string][]): void {
  kube.run = (argv) => {
    const joined = argv.join(' ');
    const reply = (value: Partial<KubectlResult>) =>
      Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '', ...value });
    if (
      joined.startsWith('helm list') &&
      !mapping.some(([needle]) => needle.includes('helm list'))
    ) {
      return reply({});
    }
    for (const [needle, returncode, stdout] of mapping) {
      if (joined.includes(needle)) return reply({ returncode, stdout });
    }
    return reply({ returncode: 1, stderr: 'no stub' });
  };
}

let toolDir = '';
function installTools(...names: string[]): void {
  toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-tools-'));
  for (const name of names) {
    fs.writeFileSync(path.join(toolDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  process.env.PATH = `${toolDir}${path.delimiter}${realPath ?? ''}`;
}

const tool = (name: string, version: number[], raw = '') =>
  makeTool({ name, path: `/usr/bin/${name}`, version, raw });

/** A storage class list with one default, as `get storageclass -o json` returns it. */
const DEFAULT_STORAGE = JSON.stringify({
  items: [
    {
      metadata: {
        name: 'standard',
        annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
      },
    },
  ],
});

beforeEach(() => {
  mockPreflight = null;
  mockClaim = null;
  mockEdge = { installed: false, registered: [] };
  // Unstated reads refuse, so a row nobody described cannot quietly pass.
  kube.run = (argv) => Promise.resolve({ argv, returncode: 1, stdout: '', stderr: 'no stub' });
});

afterEach(() => {
  kube.run = realRun;
  forget('rc-support');
  forget('c');
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  if (toolDir !== '') fs.rmSync(toolDir, { recursive: true, force: true });
  toolDir = '';
});

describe('the rows a probe’s answer becomes', () => {
  it('does not count the cluster in use again as another one', async () => {
    // It described one cluster twice -- "Using your cluster 'kind-kind'" and then "1 other
    // kind cluster(s) (kind)" -- and the second mention reads as a different cluster.
    installTools('kind', 'kubectl', 'helm');
    fakeRun([
      ['get clusters', 0, `${CLUSTER_NAME}\nsomebody-elses\n`],
      ['config current-context', 0, `${CONTEXT}\n`],
      ['/readyz', 0, 'ok'],
      ['get storageclass', 0, DEFAULT_STORAGE],
      ['get namespace', 0, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const said = messages(await rows());
    expect(said.some((message) => message.includes(`Cluster '${CLUSTER_NAME}' reachable`))).toBe(
      true,
    );
    const others = said.filter((message) => message.includes('other kind cluster'));
    expect(others).toHaveLength(1);
    expect(others[0]).toContain('somebody-elses');
    expect(others[0]).not.toContain(CLUSTER_NAME);
  });

  it('reports a cluster with no default StorageClass, naming the symptom', async () => {
    // Local distributions "often ship without a storage provisioner", and the failure is
    // silent: a PVC Pending forever and nothing in the output naming storage.
    installTools('kind', 'kubectl', 'helm');
    fakeRun([
      ['get clusters', 0, `${CLUSTER_NAME}\n`],
      ['/readyz', 0, 'ok'],
      ['get storageclass', 0, '{"items": []}'],
      ['get namespace', 0, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const storage = (await rows()).filter((row) => row.message.includes('StorageClass'));
    expect(storage).toHaveLength(1);
    expect(storage[0]?.status).toBe('warn');
    expect(storage[0]?.message).toContain('Pending');
  });

  it('does not report a stopped Docker as a missing cluster', async () => {
    // `kind` talks to Docker, and a non-zero `kind get clusters` read as an empty list sends
    // someone to create a cluster that is already there. Answered-no and could-not-ask.
    installTools('kind', 'kubectl', 'helm');
    fakeRun([
      ['get clusters', 1, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const said = messages(await rows());
    expect(said.some((message) => message.includes('Could not tell whether cluster'))).toBe(true);
    expect(said.some((message) => message.includes('does not exist'))).toBe(false);
  });

  it('names both ways to get a cluster when there is none', async () => {
    // kubectl and helm and nothing to point them at. Naming only kind would be wrong:
    // pointing at an existing k3s or Docker Desktop cluster is equally valid.
    installTools('kubectl', 'helm');
    fakeRun([
      ['config current-context', 1, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const hit = messages(await rows()).filter((message) =>
      message.includes('No Kubernetes cluster configured'),
    );
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('kind');
    expect(hit[0]).toContain('k3s');
  });

  it('names the cluster `up` would actually use, and the one it would set aside', async () => {
    // A box with BOTH kind and k3s: the report said "Using your cluster 'default' (k3s)"
    // and `up` went and built a kind cluster. A preflight whose job is predicting a boot
    // cannot be a second opinion about it.
    installTools('kind', 'kubectl', 'helm');
    fakeRun([
      ['get clusters', 0, '\n'], // kind installed, no cluster yet
      ['config current-context', 0, 'default\n'], // ...but k3s is up and active
      ['/readyz', 0, 'ok'],
      ['get storageclass', 0, '{"items": []}'],
      ['get namespace', 0, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const plan = await planCluster();
    const pre = await probePreflight();
    expect([pre.context, pre.willCreate]).toEqual([plan.context, plan.create]);

    const said = messages(await rows());
    expect(said.some((message) => message.includes("Using your cluster 'default'"))).toBe(false);
    expect(
      said.some((message) =>
        message.includes(`No cluster yet — '${CLUSTER_NAME}' is created on first use`),
      ),
    ).toBe(true);
    // ...and the one being set aside is still named, or the next question is why houston
    // is building a second cluster next to a working one.
    expect(
      said.some((message) => message.includes('will NOT be used') && message.includes("'default'")),
    ).toBe(true);
  });

  it('reports ingress as a FACT, never as a warning', async () => {
    // Silence was the wrong way to avoid nagging: on a cluster that has a controller (k3s
    // ships Traefik) the report hid the one thing that tells it apart from a kind one. An
    // absent controller is not a fault -- `ensureIngress` is what acts on it at create time.
    installTools('kind', 'kubectl', 'helm');
    fakeRun([
      ['get clusters', 0, `${CLUSTER_NAME}\n`],
      ['/readyz', 0, 'ok'],
      ['get storageclass', 0, DEFAULT_STORAGE],
      ['get ingressclass', 0, '{"items": []}'],
      ['get namespace', 0, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const all = await rows();
    const ingress = all.filter((row) => row.message.toLowerCase().includes('ingress'));
    expect(ingress.length).toBeGreaterThan(0);
    expect(new Set(ingress.map((row) => row.status))).toEqual(new Set(['ok']));
    expect(ingress.map((row) => row.check)).toContain('kubernetes-ingress');
    // And it says why its absence does not matter.
    expect(ingress[0]?.message).toContain('port-forward');
    expect(
      all.some(
        (row) =>
          ['warn', 'fail'].includes(row.status) && row.message.toLowerCase().includes('ingress'),
      ),
    ).toBe(false);
  });

  it('FAILS when helm cannot reach a cluster kubectl can', async () => {
    // FAIL, not warn: every Kubernetes create on this box is broken until it is fixed, and
    // the tick doctor used to print beside it sent a reader to the chart, not the kubeconfig.
    installTools('kind', 'kubectl', 'helm');
    fakeRun([
      ['get clusters', 0, `${CLUSTER_NAME}\n`],
      ['/readyz', 0, 'ok'],
      ['get storageclass', 0, DEFAULT_STORAGE],
      ['get ingressclass', 0, ''],
      ['get namespace', 0, ''],
      ['version', 0, 'v9.9.9'],
      // THE ONE THAT DISAGREES.
      [
        'helm list',
        1,
        'Error: kubernetes cluster unreachable: x509: certificate signed by unknown authority',
      ],
    ]);
    const hit = (await rows()).filter((row) => row.message.includes('helm cannot reach'));
    expect(hit).toHaveLength(1);
    expect(hit[0]?.status).toBe('fail');
    expect(hit[0]?.message).toContain('kubectl can');
    expect(hit[0]?.message).toContain('roll back');
  });
});

describe('the rows a stated preflight becomes', () => {
  it('says something TRUE about where a version floor came from', async () => {
    // It cited the official Rocket.Chat guide for every floor, and the guide names none --
    // and never mentions kind -- so a reader was sent to a document that does not contain
    // the requirement.
    mockPreflight = preflightOf({
      tools: {
        kubectl: tool('kubectl', [1, 36]),
        helm: tool('helm', [4, 2]),
        kind: tool('kind', [0, 1]), // below its floor
      },
    });
    const hit = messages(await rows()).filter(
      (message) => message.includes('kind') && message.includes('older than'),
    );
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]).not.toContain('official Rocket.Chat guide');
    // The floor says what actually decided it.
    expect(hit[0]).toContain('extraPortMappings');
  });

  it('reports what a cluster provides the same way on every distribution', async () => {
    // The difference between kind and k3s is three capabilities -- ingress, a load
    // balancer, metrics -- and nothing said so. All three are `ok` rows: a capability is a
    // FACT, and severity belongs to whatever needs it.
    const tools = {
      kubectl: tool('kubectl', [9, 9]),
      helm: tool('helm', [9, 9]),
      kind: tool('kind', [9, 9]),
    };
    const byCheck = (list: Row[]) => Object.fromEntries(list.map((row) => [row.check, row]));

    mockPreflight = preflightOf({
      tools,
      clusterReachable: true,
      context: 'default',
      provider: PROVIDER_EXTERNAL,
      distribution: 'k3s',
      nodeCount: 1,
      architectures: ['amd64'],
      defaultStorageClass: 'local-path',
      ingressClasses: ['traefik'],
      metrics: true,
      loadbalancer: 'traefik has 172.16.0.2',
    });
    const k3s = byCheck(await rows());
    expect(k3s['kubernetes-cluster']?.message).toContain('k3s, 1 node, amd64');
    expect(k3s['kubernetes-ingress']?.message).toContain('traefik');
    expect(k3s['kubernetes-loadbalancer']?.message).toContain('172.16.0.2');
    expect(k3s['kubernetes-metrics']?.message).toContain('`houston stats` works here');
    for (const check of ['kubernetes-ingress', 'kubernetes-loadbalancer', 'kubernetes-metrics']) {
      expect([check, k3s[check]?.status]).toEqual([check, 'ok']);
    }

    mockPreflight = preflightOf({
      tools,
      clusterReachable: true,
      clusterExists: true,
      context: CONTEXT,
      provider: PROVIDER_KIND,
      distribution: 'kind',
      nodeCount: 1,
      architectures: ['amd64'],
      defaultStorageClass: 'standard',
    });
    const kind = byCheck(await rows());
    expect(kind['kubernetes-cluster']?.message).toContain('kind, 1 node, amd64');
    // The same three subjects, answered the other way and still not a warning.
    expect(kind['kubernetes-ingress']?.message).toContain('none installed');
    expect(kind['kubernetes-loadbalancer']?.message).toContain('not confirmed');
    expect(kind['kubernetes-metrics']?.message).toContain('refuses');
    for (const check of ['kubernetes-ingress', 'kubernetes-loadbalancer', 'kubernetes-metrics']) {
      expect([check, kind[check]?.status]).toEqual([check, 'ok']);
    }
    // Storage is reported when it is THERE too, not only when it is missing.
    expect(kind['kubernetes-storage']?.message).toContain('standard (default)');
  });

  it('names the port a cluster holds, not always 443', async () => {
    // A cluster holding only :80 was reported as holding :443 -- on a box whose challenge
    // was `http`, so :80 was the whole problem and the report pointed at the other port.
    mockPreflight = preflightOf({
      tools: {
        kubectl: tool('kubectl', [9, 9, 9], 'v9.9.9'),
        helm: tool('helm', [9, 9, 9], 'v9.9.9'),
      },
      context: 'default',
      clusterReachable: false,
    });
    mockClaim = {
      context: 'default',
      service: 'kube-system/traefik',
      address: '172.16.0.2',
      ports: [80],
    };
    mockEdge = { installed: true, registered: ['w1'] };
    const hit = (await rows()).filter((row) => row.check === 'kubernetes-edge-port');
    // A cluster holding :80 is still a cluster holding the edge's port.
    expect(hit).toHaveLength(1);
    const said = hit[0]?.message ?? '';
    expect(said).toContain(':80');
    expect(said).not.toContain(':443');
    expect(said).toContain('http-01'); // the challenge that cannot complete
    expect(said).toContain('patch svc traefik'); // the service that was FOUND
    // The recurrence is the point: the patch is undone by the next k3s install.
    expect(said).toContain('--disable servicelb');
  });
});

describe('the rows about serving a name', () => {
  it('names the cluster that took the edge’s port and the GUI name it breaks, only when there is an edge', async () => {
    // Silent until now, and it breaks a working setup: k3s's ServiceLB claims host :80/:443
    // by DNAT, not by a bind, so nothing errors and kube-proxy gets the packet first. The
    // cluster that does it need not be the one houston USES, and it must not need to be
    // reachable -- houston's own cluster did not exist yet on the box where this fired.
    mockPreflight = preflightOf({
      tools: {
        kubectl: tool('kubectl', [9, 9, 9], 'v9.9.9'),
        helm: tool('helm', [9, 9, 9], 'v9.9.9'),
      },
      context: CONTEXT,
      distribution: 'kind',
      clusterReachable: false,
      willCreate: true,
    });
    mockClaim = {
      context: 'default',
      service: 'kube-system/traefik',
      address: '172.16.0.2',
      ports: [80, 443],
    };
    mockEdge = { installed: true, registered: [], domain: 'gui.example.test' };
    const all = await rows();
    const hit = all.filter((row) => row.check === 'kubernetes-edge-port');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.status).toBe('warn');
    const said = hit[0]?.message ?? '';
    expect(said).toContain("'default'"); // the cluster that took it
    expect(said).toContain('172.16.0.2'); // and the address
    // The GUI's own name is what breaks: counting workspace routes alone said "0 names"
    // about a real outage.
    expect(said).toContain('gui.example.test');
    // The capability facts belong to a cluster that ANSWERS, and there is none here.
    expect(all.filter((row) => row.check === 'kubernetes-cert-manager')).toEqual([]);

    // No edge, no conflict: the cluster holding the port is then simply how it works.
    mockEdge = { installed: false, registered: [] };
    expect((await rows()).filter((row) => row.check === 'kubernetes-edge-port')).toEqual([]);
  });

  it('says which HTTPS shape the box is in, and promises no cert-manager Secret without one', async () => {
    // One row for "can this box serve a name, and how". Every fact in it is reported above,
    // and composing four rows is what nobody does at the moment they need the answer.
    // 127.0.0.1 stands in for an address this host holds, which is what `local` asks.
    mockPreflight = preflightOf({
      context: 'default',
      clusterReachable: true,
      clusterExists: true,
      ingressClasses: ['traefik'],
      distribution: 'k3s',
      provider: PROVIDER_EXTERNAL,
      defaultStorageClass: 'local-path',
      tools: { kubectl: tool('kubectl', [1, 36]), helm: tool('helm', [4, 2]) },
    });
    const lb = { type: 'LoadBalancer', ports: [{ port: 443, nodePort: 32492 }] };
    const shape = async (svc: Record<string, unknown> | null, certManager = true) => {
      fakeRun([
        ['get crd', certManager ? 0 : 1, certManager ? 'certificates.cert-manager.io' : ''],
        [
          'get svc',
          0,
          JSON.stringify({
            items:
              svc === null
                ? []
                : [{ metadata: { namespace: 'kube-system', name: 'traefik' }, ...svc }],
          }),
        ],
        [
          'get nodes',
          0,
          JSON.stringify({
            items: [{ status: { addresses: [{ type: 'InternalIP', address: '127.0.0.1' }] } }],
          }),
        ],
      ]);
      const found = (await rows()).filter((row) => row.check === 'kubernetes-https');
      // The row is always emitted for a reachable cluster.
      expect(found).toHaveLength(1);
      return found[0]?.message ?? '';
    };
    const answered = { spec: lb, status: { loadBalancer: { ingress: [{ ip: '127.0.0.1' }] } } };

    // The cluster owns :443 -- answered directly, no edge in the path.
    let said = await shape(answered);
    expect(said).toContain("CLUSTER's own ingress");
    expect(said).toContain('directly');
    // The edge owns it -- the name is passed through to a NodePort, named so it can be
    // dialled by hand.
    said = await shape({ spec: { ...lb, type: 'NodePort' } });
    expect(said).toContain('edge');
    expect(said).toContain('passed through by SNI');
    expect(said).toContain('32492');
    // Nothing reachable: say what it would take, not that something is broken.
    expect(await shape(null)).toContain('not servable yet');
    // AND NO CERT-MANAGER SECRET PROMISED WITHOUT A CERT-MANAGER: this row sat under one
    // saying it was not installed, describing what WOULD happen as though it already did.
    said = await shape(answered, false);
    expect(said).toContain('once cert-manager is installed');
    expect(said).not.toContain('from a cert-manager Secret');
  });
});

describe('the cloud rows', () => {
  const kubeOnly = () =>
    preflightOf({ tools: { kubectl: tool('kubectl', [1, 36]), helm: tool('helm', [4, 2]) } });

  it('is silent about AWS until AWS is somebody’s business', async () => {
    // A Compose-and-kind box must not be padded with cloud complaints. But on a cluster
    // that IS EKS, `aws` is not optional -- the kubeconfig authenticates by shelling out
    // to it -- so there it fails rather than warns.
    mockPreflight = { ...kubeOnly(), distribution: 'k3s' };
    expect((await rows()).filter((row) => row.check === 'kubernetes-cloud')).toEqual([]);

    mockPreflight = { ...kubeOnly(), distribution: 'eks' };
    const onEks = (await rows()).filter((row) => row.check === 'kubernetes-cloud');
    expect(onEks.length).toBeGreaterThan(0);
    expect(new Set(onEks.map((row) => row.status))).toEqual(new Set(['fail']));
  });

  it('reports a cloud cluster this box built even with no AWS tooling, until it goes', async () => {
    // A cluster does not stop billing because `aws` was uninstalled afterwards, and the box
    // with no cloud tooling is exactly the one most likely to have forgotten it. It reads
    // the local pointer, so it needs no credential and no round trip.
    mockPreflight = kubeOnly();
    const owned = async () =>
      (await rows(NO_CLOUD, null)).filter((row) => row.check === 'kubernetes-cloud-owned');
    expect(await owned()).toEqual([]); // nothing built, nothing said

    await remember('rc-support', { region: 'eu-west-1', account: '123456789012' });
    const hit = await owned();
    expect(hit).toHaveLength(1);
    // Which cluster, where and whose -- or it is unactionable -- and how to stop it.
    for (const part of ['rc-support', 'eu-west-1', '123456789012', 'cluster delete rc-support']) {
      expect(hit[0]?.message).toContain(part);
    }

    forget('rc-support');
    expect(await owned()).toEqual([]);
  });

  it('says how far past its date a cluster is, and never makes spending a failure', async () => {
    mockPreflight = kubeOnly();
    const rowFor = async (expires: string) => {
      forget('c');
      await remember('c', { region: 'us-east-1', account: '1', expires });
      const hits = (await rows(NO_CLOUD, null)).filter(
        (row) => row.check === 'kubernetes-cloud-owned',
      );
      expect(hits).toHaveLength(1);
      return hits[0] as Row;
    };

    const past = await rowFor('2020-01-01');
    expect(past.message).toContain('PAST the expiry');
    expect(past.status).toBe('warn'); // the operator's decision, not a gate

    const ahead = await rowFor(expiryDate(30));
    expect(ahead.message).toContain('day(s) left');
    expect(ahead.message).not.toContain('PAST');

    // No expiry: still costing money, with nothing said about a date it never had.
    const none = await rowFor('');
    expect(none.message).toContain('billing');
    expect(none.message).not.toContain('expiry');
    expect(none.message).not.toContain('PAST');
  });

  it('says an empty local record beside working credentials is not the same as none', async () => {
    // OBSERVED: an EKS cluster tagged `houston`, ACTIVE, expiring the next day, while the
    // owner's local record did not exist -- so `doctor` said nothing. `doctor` is what people
    // run out of habit; `cluster list` is what asks AWS, and nothing routed one to the other.
    mockPreflight = kubeOnly();
    const ready = {
      tools: { aws: tool('aws', [2, 0]), eksctl: tool('eksctl', [0, 200]) },
      identity: identity({
        account: '123456789012',
        arn: 'arn:aws:iam::123456789012:user/support',
      }),
      region: 'eu-west-1',
    };
    const owned = async () =>
      (await rows(ready, null)).filter((row) => row.check === 'kubernetes-cloud-owned');

    const said = await owned();
    expect(said).toHaveLength(1);
    expect(said[0]?.status).toBe('warn'); // a spending decision, never a failure
    expect(said[0]?.message).toContain('cluster list'); // the command that closes the gap
    expect(said[0]?.message).toContain('not the same as there being none');

    // AND IT GOES QUIET THE MOMENT THERE IS A RECORD: repeating "I might not know" beside
    // a named cluster would teach the reader to skip both lines.
    await remember('rc-support', { region: 'eu-west-1', account: '123456789012' });
    const after = await owned();
    expect(after).toHaveLength(1);
    expect(after[0]?.message).toContain('rc-support');
    expect(after[0]?.message).not.toContain('not the same as there being none');
  });
});
