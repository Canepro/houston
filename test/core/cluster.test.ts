import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BILLABLE,
  EBS_GP3_USD_GB_MONTH,
  EKS_CONTROL_PLANE_USD_HR,
  HOURS_PER_MONTH,
  INSTANCE_USD_HR,
  LOADBALANCER_USD_HR,
  NAT_GATEWAY_USD_HR,
  NODE_VOLUME_GB,
  STATUS_WORKERS,
  claimedGb,
  estimateUsdHr,
  nodeInventory,
  oldestNodeAgeHours,
  providerOf,
  regionOf,
  round4,
} from '../../src/core/cluster';

import type * as ModNS from '../../src/core/cluster';

/**
 * What earlier releases answered for the inputs below, recorded: the provider and region
 * of each context, every estimate combination, the builtin-named labels, the four-place
 * rounding of each value, and the price table itself. A JSON file rather than literals
 * because one label is `__proto__`, which an object literal would make a prototype.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'cluster.json'), 'utf8'),
) as Record<'contexts' | 'estimates' | 'builtins' | 'rounding' | 'constants', unknown>;

const ARN = 'arn:aws:eks:us-east-1:123456789012:cluster/chatrepo';
const CONTEXTS = [
  ARN,
  'me@chatrepo.eu-west-2.eksctl.io',
  'kind-houston-local',
  'k3s',
  'arn:aws:eks:bad',
  'x.eksctl.io',
  '',
];

describe('what a context name says about its cluster', () => {
  it('reads the distribution off the name when no node can be asked', () => {
    // A managed cluster with zero nodes is not an edge case: it is every cluster
    // mid-create, mid-delete, or scaled to nothing. MEASURED against a real EKS cluster
    // whose node group was being deleted -- `distribution` answered "unknown", so it did
    // not match BILLABLE, so the ledger priced a running control plane at nothing.
    expect(providerOf(ARN, '')).toBe('eks');
    expect(providerOf(ARN, 'unknown')).toBe('eks');
    // A node that DID answer wins: the providerID is the more reliable signal.
    expect(providerOf(ARN, 'kind')).toBe('kind');
    expect(providerOf('kind-houston-local', '')).toBe('');
  });

  it('answers what earlier releases answered on every context shape', () => {
    expect(
      CONTEXTS.map((c) => [
        providerOf(c, ''),
        providerOf(c, 'kind'),
        providerOf(c, 'unknown'),
        regionOf(c),
      ]),
    ).toEqual(RECORDED.contexts);
  });

  it('pulls the region out of both shapes AWS writes', () => {
    // Which region a cluster is in is the half of an ARN a person actually needs; the
    // account id is the half they do not.
    expect(regionOf(ARN)).toBe('us-east-1');
    expect(regionOf('me@chatrepo.eu-west-2.eksctl.io')).toBe('eu-west-2');
    expect(regionOf('kind-houston-local')).toBe('');
  });
});

describe('the cost estimate', () => {
  it('is null for a cluster nobody is billed for', () => {
    // Quoting dollars for a kind cluster on a laptop would be noise, and quoting zero
    // would be a claim about somebody else's infrastructure bill.
    expect(estimateUsdHr('kind', { 't3.large': 2 })).toBeNull();
    expect(estimateUsdHr('', {})).toBeNull();
    expect(BILLABLE).toEqual(['eks', 'gke', 'aks']);
  });

  it('prices everything it can SEE, including the node disks', () => {
    // Counting a thing and not pricing it is the most convincing way to be wrong, since
    // the reader can see you noticed. Disks were UNCOUNTED, not underpriced, so the
    // "unpriced types are reported" safeguard could not see them either.
    const one = estimateUsdHr('eks', { 't3.large': 1 }, { loadbalancers: 0, volumeGb: 0 });
    const expected =
      EKS_CONTROL_PLANE_USD_HR +
      NAT_GATEWAY_USD_HR +
      (INSTANCE_USD_HR['t3.large'] as number) +
      (NODE_VOLUME_GB * EBS_GP3_USD_GB_MONTH) / HOURS_PER_MONTH;
    expect(one?.usd_hr).toBeCloseTo(expected, 4);
    const withLb = estimateUsdHr('eks', { 't3.large': 1 }, { loadbalancers: 2, volumeGb: 0 });
    expect((withLb?.usd_hr ?? 0) - (one?.usd_hr ?? 0)).toBeCloseTo(2 * LOADBALANCER_USD_HR, 4);
  });

  it('separates a type it does not know from a count it could not read', () => {
    // Only one of them gets better by adding a row to a table.
    const unknownType = estimateUsdHr('eks', { 'c9.huge': 3 });
    expect(unknownType?.unpriced).toEqual({ 'c9.huge': 3 });
    expect(unknownType?.incomplete).toEqual([]);
    // ...and its disks are still counted, because an unrecognised instance type still has
    // a volume attached to it.
    expect(unknownType?.usd_hr).toBeGreaterThan(EKS_CONTROL_PLANE_USD_HR + NAT_GATEWAY_USD_HR);

    const blind = estimateUsdHr('eks', {}, { loadbalancers: null, volumeGb: null });
    expect(blind?.unpriced).toEqual({});
    expect(blind?.incomplete).toEqual(['load balancers', 'workspace volumes']);
  });

  it('is identical to what earlier releases estimated across every combination', () => {
    const inventories = [
      { 't3.large': 2 },
      { 't3.large': 2, 'c9.huge': 1 },
      { '': 3 },
      {},
      { 'm5.xlarge': 1, 't3.medium': 4 },
    ];
    const ours = inventories.flatMap((inv) => [
      estimateUsdHr('eks', inv),
      estimateUsdHr('eks', inv, { loadbalancers: 2, volumeGb: 16 }),
      estimateUsdHr('eks', inv, { loadbalancers: null, volumeGb: null }),
      estimateUsdHr('kind', inv),
    ]);
    expect(ours).toEqual(RECORDED.estimates);
  });

  it('prices an instance type that happens to name a JavaScript builtin', () => {
    // The key is a LABEL the cluster chose. `INSTANCE_USD_HR['toString']` is a function,
    // not undefined, so the type was never reported as unpriced and the total became NaN --
    // and `JSON.stringify(NaN)` is `null`, so the card showed a blank cost for a cluster
    // that is very much billing. Earlier releases priced these as the plain labels they are.
    const names = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];
    expect(
      names.map((n) => [
        estimateUsdHr('eks', { [n]: 2 }),
        nodeInventory([
          { metadata: { labels: { 'node.kubernetes.io/instance-type': n } } },
          { metadata: { labels: { 'node.kubernetes.io/instance-type': n } } },
        ]),
      ]),
    ).toEqual(RECORDED.builtins);
  });

  it('rounds as earlier releases do, on the value and not on the value times ten thousand', () => {
    // Four places, half-to-even ON THE DOUBLE'S EXACT VALUE. Multiplying by 10,000
    // first rounds once before the rounding, so a value slightly ABOVE a half lands exactly
    // on it and then gets the tie-break -- which goes the other way. Measured against
    // earlier releases over 200,000 inputs of this shape, 86,162 disagreed.
    //
    // DEFENSIVE, not a live defect: no total the estimator can build reaches one of these
    // -- the `/ 730` terms see to that, and 3,250 realistic totals plus 200,000 uniform
    // samples all agreed even before the fix. That is exactly why it is tested HERE, on the
    // helper, rather than through `estimateUsdHr`, where it would pass either way and so
    // prove nothing.
    const values: number[] = [];
    for (let k = 0; k < 500; k += 1) values.push((k + 0.5) / 10_000);
    for (let k = 0; k < 500; k += 1) values.push(-(k + 0.5) / 10_000);
    // The genuinely representable tie, which must round DOWN to an even last digit.
    values.push(0.03125, 0.0, 1.0, 123.456789);
    expect(values.map(round4)).toEqual(RECORDED.rounding);
    expect(round4(0.03125)).toBe(0.0312);
  });

  it('quotes the same numbers the rest of the tool spends', () => {
    // ONE table. An hourly rate quoted at create and a different one in the ledger is the
    // `runtime_cost` bug in dollars.
    expect({
      cp: EKS_CONTROL_PLANE_USD_HR,
      nat: NAT_GATEWAY_USD_HR,
      disk: NODE_VOLUME_GB,
      gb: EBS_GP3_USD_GB_MONTH,
      hrs: HOURS_PER_MONTH,
      lb: LOADBALANCER_USD_HR,
      types: { ...INSTANCE_USD_HR },
      billable: [...BILLABLE],
      workers: STATUS_WORKERS,
    }).toEqual(RECORDED.constants);
  });
});

describe('reading what a cluster holds', () => {
  const answer = (list: Record<string, unknown>[]) => ({
    state: 'present' as const,
    doc: { items: list },
  });

  it('answers null, never zero, for a volume list it could not read', () => {
    // An unreadable volume list priced at nothing is a bill that looks free. That is the
    // sentence this whole module is written against.
    expect(claimedGb({ state: 'refused' } as never)).toBeNull();
    expect(claimedGb(answer([]) as never)).toBe(0);
  });

  it('adds up Gi, Mi and Ti, and skips what it cannot read', () => {
    expect(
      claimedGb(
        answer([
          { spec: { resources: { requests: { storage: '8Gi' } } } },
          { spec: { resources: { requests: { storage: '512Mi' } } } },
          { spec: { resources: { requests: { storage: '1Ti' } } } },
          { spec: { resources: { requests: { storage: 'nope' } } } },
          { spec: {} },
          {},
        ]) as never,
      ),
    ).toBeCloseTo(8 + 0.5 + 1024, 6);
  });

  it('counts a node that does not say its type, under ""', () => {
    expect(
      nodeInventory([
        { metadata: { labels: { 'node.kubernetes.io/instance-type': 't3.large' } } },
        { metadata: { labels: {} } },
        { metadata: {} },
      ]),
    ).toEqual({ 't3.large': 1, '': 2 });
  });

  it('ages the cluster from its OLDEST node, and answers null with none', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    expect(
      oldestNodeAgeHours(
        [
          { metadata: { creationTimestamp: '2026-09-15T00:00:00Z' } },
          { metadata: { creationTimestamp: '2026-09-14T00:00:00Z' } },
        ],
        now,
      ),
    ).toBe(48);
    expect(oldestNodeAgeHours([{ metadata: {} }], now)).toBeNull();
    expect(oldestNodeAgeHours([], now)).toBeNull();
    // A clock that has gone backwards reports 0, not a negative age.
    expect(
      oldestNodeAgeHours([{ metadata: { creationTimestamp: '2030-01-01T00:00:00Z' } }], now),
    ).toBe(0);
  });

  it('reads an ISO instant and refuses everything else, where Date.parse would not', () => {
    // `Date.parse` accepts a pile of things a strict ISO reader rejects: `"2026"` is a
    // year to one and a refusal to the other. A node carrying one would then be counted
    // as the oldest and set the cluster's whole reported age.
    const now = Date.parse('2026-09-16T12:00:00Z');
    const age = (raw: string) =>
      oldestNodeAgeHours([{ metadata: { creationTimestamp: raw } }], now);
    for (const good of [
      '2026-09-16T10:00:00Z',
      '2026-09-16T10:00:00+00:00',
      '2026-09-16 10:00:00+00:00',
      '2026-09-16T10:00:00+0000',
    ]) {
      expect(age(good)).toBe(2);
    }
    // Fractional seconds are read, not rejected -- 123 ms shy of two hours.
    expect(age('2026-09-16T10:00:00.123456Z')).toBeCloseTo(2, 4);
    for (const bad of ['2026', 'Mar 5 2020', 'garbage', '2026-13-45T99:99:99Z', '']) {
      expect(age(bad)).toBeNull();
    }
    // An offset is required: `fromisoformat` returns a NAIVE datetime for these and the
    // subtraction against an aware `now` then raises TypeError out of the whole report.
    // A ledger that cannot read a stamp says so; it does not take the command down.
    for (const naive of ['2026-09-16T10:00:00', '2026-09-16']) {
      expect(age(naive)).toBeNull();
    }
  });
});

describe('the ledger', () => {
  afterEach(() => {
    jest.resetModules();
  });

  /** Load `cluster` with every kube read answering whatever this test says. */
  function load(answers: Record<string, unknown> = {}): typeof ModNS {
    jest.resetModules();
    const A = (list: unknown[]) => ({ state: 'present', doc: { items: list } });
    jest.doMock('../../src/core/kube/ask', () => ({
      ABSENT: 'absent',
      askList: (kind: string) => Promise.resolve((answers[`ask:${kind}`] ?? A([])) as unknown),
      items: (v: { doc?: { items?: unknown[] } }) => v.doc?.items ?? [],
      present: (v: { state: string }) => v.state === 'present',
      refused: (v: { state: string }) => v.state === 'refused',
    }));
    jest.doMock('../../src/core/kube/context', () => ({
      activeContext: () => Promise.resolve(''),
      assertContextKnown: (c: string) => Promise.resolve([c, '']),
      clusterContext: () => Promise.resolve('kind-houston-local'),
      contextServers: () => Promise.resolve([answers.servers ?? {}, '']),
      contexts: () => Promise.resolve([answers.contexts ?? [], answers.ctxUnreadable ?? '']),
      distribution: () => Promise.resolve(answers.distribution ?? 'eks'),
      planCluster: () => Promise.resolve({ context: 'kind-houston-local' }),
      shortName: (c: string) => (c.includes('/') ? (c.split('/').pop() as string) : c),
    }));
    jest.doMock('../../src/core/kube/reachability', () => ({
      REACH_DOWN: 'down',
      reach: () => Promise.resolve({ status: answers.reachStatus ?? 'ok', detail: null }),
      reachAdvice: () => 'advice',
      reachOk: (v: { status: string }) => v.status === 'ok',
      reachWhy: () => 'why',
    }));
    jest.doMock('../../src/core/kube/tools', () => ({
      which: () => (answers.kind === false ? '' : '/usr/bin/kind'),
    }));
    jest.doMock('../../src/core/kube/capabilities', () => ({
      workspaceNamespaces: () => Promise.resolve(answers.namespaces ?? []),
    }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      namespaceOwner: () => Promise.resolve(answers.owner ?? 'support'),
      workspacePvcs: () => Promise.resolve(answers.pvcs ?? []),
    }));
    jest.doMock('../../src/core/kube/operator', () => ({
      operatorPresence: () => Promise.resolve({ state: 'present' }),
    }));
    jest.doMock('../../src/core/kube/monitoring', () => ({
      monitoringInstalled: () => Promise.resolve(false),
    }));
    jest.doMock('../../src/core/kube/cluster', () => ({
      ensureKubeconfig: () => Promise.resolve(''),
    }));
    jest.doMock('../../src/core/eks', () => ({
      aws: { describeCluster: () => Promise.resolve({ state: answers.awsState ?? 'refused' }) },
    }));
    return require('../../src/core/cluster') as typeof ModNS;
  }

  it('reports null for everything it could not read, and says which', async () => {
    // "0 workspaces, nothing costing you money" is exactly the sentence that lets a bill
    // run, so a cluster that did not answer reports nulls and names them.
    const cluster = load({ reachStatus: 'down' });
    const out = await cluster.status('arn:aws:eks:us-east-1:1:cluster/x');
    expect(out.reachable).toBe(false);
    expect(out.nodes).toBeNull();
    expect(out.workspaces).toBeNull();
    expect(out.pvcs).toBeNull();
    expect(out.loadbalancers).toBeNull();
    expect(out.cost).toBeNull();
    expect(out.unreadable).toContain('cluster');
  });

  it('marks a cluster gone only when AWS definitely says so', async () => {
    // REFUSED is "I could not ask" -- expired credentials, no route, a permission boundary
    // -- and calling that gone would report a BILLING cluster as deleted.
    for (const [state, gone] of [
      ['absent', true],
      ['refused', false],
      ['present', false],
    ] as const) {
      const cluster = load({ reachStatus: 'down', awsState: state });
      const out = await cluster.status('arn:aws:eks:us-east-1:1:cluster/x');
      expect(out.gone).toBe(gone);
      if (gone) expect(out.reach_advice).toContain('houston cluster forget x');
    }
    // A context that is not an ARN is never marked gone, whatever AWS would have said.
    const kind = load({ reachStatus: 'down', awsState: 'absent' });
    expect((await kind.status('kind-houston-local')).gone).toBe(false);
  });

  it('counts only Services that are actually LoadBalancers', async () => {
    const cluster = load({
      'ask:svc': {
        state: 'present',
        doc: {
          items: [
            { spec: { type: 'LoadBalancer' } },
            { spec: { type: 'ClusterIP' } },
            { spec: {} },
            {},
          ],
        },
      },
    });
    const out = await cluster.status('kind-houston-local');
    expect(out.loadbalancers).toBe(1);
  });

  it('says it cannot remove a cluster it built once kind is gone', async () => {
    // `deleteCluster` and `prune` answer "there was nothing to delete" rather than "I
    // cannot delete it", so the cluster keeps running and holding memory, silently
    // unreclaimable.
    const cluster = load({ kind: false });
    const out = await cluster.status('kind-houston-local');
    expect(out.ours).toBe(true);
    expect(out.manageable).toBe(false);
    expect(out.unmanageable_why).toContain('can no longer remove it');
    expect(out.unmanageable_why).toContain('docker rm -f');
  });

  it('reports one row per CLUSTER, not one per context name', async () => {
    // `eksctl` and `aws eks update-kubeconfig` each write a context for the same cluster,
    // so a list of contexts showed it twice and priced it twice: "Costing money 2 ·
    // ~$16.87/day" for a single cluster costing $8.44.
    const arn = 'arn:aws:eks:us-east-1:1:cluster/chatrepo';
    const alias = 'me@chatrepo.us-east-1.eksctl.io';
    const cluster = load({
      contexts: [alias, arn, 'kind-houston-local'],
      servers: { [alias]: 'https://api', [arn]: 'https://api' },
    });
    const known = await cluster.knownContexts();
    expect(known.contexts.map((c) => c.context)).toEqual([arn, 'kind-houston-local']);
    // The ARN is kept as the name to show, because it says which account and which region.
    expect(known.contexts[0]?.aliases).toEqual([alias]);
    expect(known.contexts[0]?.billable).toBe(true);
    expect(known.contexts[0]?.short).toBe('chatrepo');
  });

  it('drops our own context only when kind is gone AND the cluster is not there', async () => {
    const both = load({ contexts: ['kind-houston-local'], kind: false, reachStatus: 'down' });
    expect((await both.knownContexts()).contexts).toEqual([]);
    // A running cluster stays listed however little houston can do with it.
    const running = load({ contexts: ['kind-houston-local'], kind: false, reachStatus: 'ok' });
    expect((await running.knownContexts()).contexts).toHaveLength(1);
    // And with kind installed it is never probed at all.
    const installed = load({ contexts: ['kind-houston-local'], reachStatus: 'down' });
    expect((await installed.knownContexts()).contexts).toHaveLength(1);
  });

  it('prices a reachable cluster from what it just read', async () => {
    const cluster = load({
      distribution: 'eks',
      'ask:nodes': {
        state: 'present',
        doc: {
          items: [
            { metadata: { labels: { 'node.kubernetes.io/instance-type': 't3.large' } } },
            { metadata: { labels: { 'node.kubernetes.io/instance-type': 't3.large' } } },
          ],
        },
      },
      'ask:svc': { state: 'present', doc: { items: [{ spec: { type: 'LoadBalancer' } }] } },
    });
    const out = await cluster.status('arn:aws:eks:us-east-1:1:cluster/x');
    expect(out.nodes).toBe(2);
    expect(out.instance_types).toEqual({ 't3.large': 2 });
    // The load balancer read above is INSIDE the total -- computing the cost beside the
    // node inventory silently excluded it.
    expect(out.cost?.usd_hr).toBeCloseTo(
      estimateUsdHr('eks', { 't3.large': 2 }, { loadbalancers: 1, volumeGb: 0 })?.usd_hr ?? 0,
      6,
    );
  });

  it('reports a workspace whose volumes could not be read as unreadable, not empty', async () => {
    const cluster = load({
      namespaces: ['houston-t1'],
      'ask:pvc': { state: 'refused' },
    });
    const out = await cluster.status('kind-houston-local');
    expect(out.workspaces).toHaveLength(1);
    expect(out.pvcs).toBeNull();
    expect(out.unreadable).toContain('pvcs');
  });
});
