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
  it('prices EKS 1.33 at its extended-support rate after July 29, 2026', () => {
    // The public estimate existed before this fix. Run that same call on both sides
    // of the support deadline, so the test fails on the old constant-rate behavior.
    const estimate = () =>
      estimateUsdHr('eks', { 't3.large': 3 }, { version: '1.33', loadbalancers: 1 });
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-28T23:59:59Z'));
      const standard = estimate();
      jest.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      const extended = estimate();
      expect((extended?.usd_hr ?? 0) - (standard?.usd_hr ?? 0)).toBeCloseTo(0.5, 4);
      expect(standard?.basis).toMatch(/1\.33 standard support/u);
      expect(extended?.basis).toMatch(/1\.33 extended support/u);
    } finally {
      jest.useRealTimers();
    }
  });

  it('marks an explicitly unknown EKS support tier as an incomplete lower-bound estimate', () => {
    const unknown = estimateUsdHr('eks', { 't3.large': 3 }, { version: '', loadbalancers: 1 });
    const legacy = estimateUsdHr('eks', { 't3.large': 3 }, { loadbalancers: 1 });
    expect(unknown?.incomplete).toContain('EKS support tier (Kubernetes version unavailable)');
    expect(unknown?.basis).toMatch(
      /version unavailable; standard support assumed as a lower bound/u,
    );
    expect(unknown?.usd_hr).toBe(legacy?.usd_hr);
    expect(legacy?.incomplete).not.toContain('EKS support tier (Kubernetes version unavailable)');
  });
  it('is null for a cluster nobody is billed for', () => {
    // Quoting dollars for a kind cluster on a laptop would be noise, and quoting zero
    // would be a claim about somebody else's infrastructure bill.
    expect(estimateUsdHr('kind', { 't3.large': 2 })).toBeNull();
    expect(estimateUsdHr('', {})).toBeNull();
    expect(estimateUsdHr('gke', { 't3.large': 2 })).toBeNull();
    expect(estimateUsdHr('aks', { 't3.large': 2 })).toBeNull();
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

describe('the next step', () => {
  const cluster = require('../../src/core/cluster') as typeof ModNS;
  const READY: ModNS.Readiness = {
    storage_class: 'gp3',
    ingress_class: 'traefik',
    cert_manager: true,
    cname_target: 'a1b2c3-123.us-east-1.elb.amazonaws.com',
    dns_answers: null,
  };
  function L(over: Partial<ModNS.Ledger> = {}): ModNS.Ledger {
    return {
      context: 'arn:aws:eks:us-east-1:1:cluster/support',
      distribution: 'eks',
      provider: 'external',
      ours: false,
      reachable: true,
      unreadable: [],
      reach_status: 'ok',
      reach_why: '',
      reach_advice: '',
      manageable: true,
      unmanageable_why: '',
      gone: false,
      nodes: 3,
      age_hours: 53,
      instance_types: { 't3.large': 3 },
      workspaces: [
        { namespace: 'houston-t1', name: 't1', owner: 'alice', owner_readable: true, pvcs: 1 },
      ],
      pvcs: 1,
      loadbalancers: 1,
      operator: false,
      monitoring: false,
      cost: {
        usd_hr: 0.4443,
        unpriced: {},
        incomplete: [],
        basis: 'us-east-1 on-demand',
        estimate: true,
      },
      name: 'support',
      region: 'us-east-1',
      made_by_houston: true,
      created_at: '2026-09-28T09:00:00Z',
      expires: '2026-10-05',
      expires_in_days: 5,
      spend_usd: 23.41,
      ready: READY,
      zone: '',
      where: 'aws',
      ...over,
    };
  }
  const base: ModNS.NextStepInput = {
    tools_ok: true,
    approved: true,
    account: '111122223333',
    clusters: [L()],
    building: [],
    failed: [],
    default_context: 'arn:aws:eks:us-east-1:1:cluster/support',
  };

  // ONE TABLE, first match wins, in the order a person meets these. Both front-ends print
  // the title, the why and the command verbatim, so the words are decided once, here.
  const cases: [string, Partial<ModNS.NextStepInput>, number, RegExp, RegExp][] = [
    ['tools missing', { tools_ok: false, clusters: [] }, 1, /install|sign in/iu, /houston doctor/u],
    [
      'account not approved',
      { approved: false, clusters: [] },
      2,
      /approve .*111122223333/iu,
      /cluster\.approved_accounts 111122223333/u,
    ],
    // A box that already has a working cluster is not told to install eksctl or approve an
    // account it will never build in: that nagged every kind-only box, for ever.
    [
      'tools missing beside a ready cluster',
      { tools_ok: false, approved: false },
      5,
      /run a workspace on support/iu,
      /--context support/u,
    ],
    ['nothing built', { clusters: [] }, 3, /build a cluster/iu, /houston cluster create/u],
    ['a build in progress', { clusters: [], building: ['perf2'] }, 3, /building perf2/iu, /^$/u],
    [
      'a build that failed part-way',
      { failed: [{ name: 'perf2', region: 'us-west-2', present: true }] },
      6,
      /perf2.*failed.*billing/iu,
      /houston cluster delete perf2 --region us-west-2/u,
    ],
    [
      'a failed build AWS no longer has',
      { failed: [{ name: 'perf2', region: 'us-west-2', present: false }] },
      5,
      /run a workspace on support/iu,
      /--context support$/u,
    ],
    [
      'DNS not answering',
      { clusters: [L({ zone: 'rc.example.com', ready: { ...READY, dns_answers: false } })] },
      4,
      /rc\.example\.com.*a1b2c3-123/u,
      /CNAME/u,
    ],
    [
      'its reminder date today',
      { clusters: [L({ expires_in_days: 0 })] },
      6,
      /reaches its expiry date today/u,
      /houston cluster keep support/u,
    ],
    [
      'a reminder date still a day away is not a step yet',
      { clusters: [L({ expires_in_days: 1 })] },
      5,
      /run a workspace on support/iu,
      /--context support$/u,
    ],
    [
      'billing and idle',
      { clusters: [L({ workspaces: [] })] },
      6,
      /holds nothing.*bills/iu,
      /houston cluster delete support/u,
    ],
    [
      'ready',
      {},
      5,
      /run a workspace on support/iu,
      /houston up --version <version> --name <ticket> --context support/u,
    ],
    [
      'ready with a zone that answers',
      { clusters: [L({ zone: 'rc.example.com', ready: { ...READY, dns_answers: true } })] },
      5,
      /run a workspace on support/iu,
      /--context support$/u,
    ],
    [
      'not answering',
      {
        clusters: [
          L({ reachable: false, reach_why: 'nothing answered', ready: null, workspaces: null }),
        ],
      },
      5,
      /support is not answering/iu,
      /houston cluster status support/u,
    ],
  ];
  for (const [label, over, stage, title, command] of cases) {
    it(`says ${label} → stage ${String(stage)}`, () => {
      const next = cluster.nextStep({ ...base, ...over });
      expect(next.stage).toBe(stage);
      expect(next.title).toMatch(title);
      expect(next.command).toMatch(command);
      expect(next.why.length).toBeGreaterThan(10);
    });
  }

  // An expired SSO token on a box with every tool installed was told to "Install the four
  // tools", which sent somebody looking for software that was already there.
  it('says sign in, not install, when only the AWS sign-in is missing', () => {
    const next = cluster.nextStep({
      ...base,
      tools_ok: false,
      clusters: [],
      blockers: [
        'not signed in to AWS (Error when retrieving token from sso: Token has expired and refresh failed). houston never holds AWS credentials.',
      ],
    });
    expect(next.stage).toBe(1);
    expect(next.title).toMatch(/sign in to AWS/iu);
    expect(next.title).not.toMatch(/install/iu);
    expect(next.why).toContain('Token has expired');
  });

  it('still says install when a tool is missing', () => {
    const next = cluster.nextStep({
      ...base,
      tools_ok: false,
      clusters: [],
      blockers: ['eksctl is not installed'],
    });
    expect(next.title).toMatch(/install/iu);
  });

  it('tells a GUI user where to click when a cluster is ready', () => {
    const next = cluster.nextStep(base);
    expect(next.why).toContain('New workspace');
    expect(next.why).toContain('Where it runs');
  });

  it('prefers the default cluster when several are known', () => {
    const perf = L({
      context: 'arn:aws:eks:eu-west-1:1:cluster/perf',
      name: 'perf',
      region: 'eu-west-1',
    });
    const next = cluster.nextStep({ ...base, clusters: [perf, L()] });
    expect(next.command).toContain('--context support');
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
    // What the read asked, so a test can say which reads a light look skips.
    const asked = (answers.asked ?? []) as string[];
    jest.doMock('../../src/core/kube/ask', () => ({
      ABSENT: 'absent',
      askList: (kind: string) => {
        asked.push(`list:${kind}`);
        return Promise.resolve((answers[`ask:${kind}`] ?? A([])) as unknown);
      },
      askObject: (kind: string, name: string) => {
        asked.push(`object:${kind}`);
        return Promise.resolve(
          (answers[`object:${kind}/${name}`] ?? { state: 'absent', doc: null }) as unknown,
        );
      },
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
      reach: (context: string) =>
        Promise.resolve({
          status:
            ((answers.reachFor ?? {}) as Record<string, string>)[context] ??
            answers.reachStatus ??
            'ok',
          detail: null,
        }),
      reachAdvice: () => 'advice',
      reachOk: (v: { status: string }) => v.status === 'ok',
      reachWhy: () => 'why',
    }));
    jest.doMock('../../src/core/kube/tools', () => ({
      which: () => (answers.kind === false ? '' : '/usr/bin/kind'),
    }));
    jest.doMock('../../src/core/kube/capabilities', () => ({
      workspaceNamespaces: () => Promise.resolve(answers.namespaces ?? []),
      // `in`, not `??`: a test passes null to mean "refused", and `??` would swallow it.
      storageClasses: () => {
        asked.push('storage');
        return Promise.resolve('storageClasses' in answers ? answers.storageClasses : [[], '']);
      },
      ingressClasses: () => {
        asked.push('ingress');
        return Promise.resolve('ingressClasses' in answers ? answers.ingressClasses : []);
      },
    }));
    jest.doMock('../../src/core/kube/endpoints', () => ({
      loadbalancerService: () => {
        asked.push('loadbalancer');
        return Promise.resolve([answers.lbName ?? '', answers.lbAddr ?? '']);
      },
    }));
    jest.doMock('../../src/core/journal', () => ({
      ...jest.requireActual('../../src/core/journal'),
      openEntries: () => (answers.unfinished ?? []) as unknown[],
      // The subset whose owning process is gone: `dead`, or every open entry by default.
      abandoned: () => (answers.dead ?? answers.unfinished ?? []) as unknown[],
    }));
    jest.doMock('node:dns/promises', () => ({
      resolveCname: (host: string) => {
        const answer = answers.cname as ((h: string) => string[]) | undefined;
        if (answer === undefined) return Promise.reject(new Error('ENOTFOUND'));
        return Promise.resolve(answer(host));
      },
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
    jest.doMock('../../src/lib/config', () => ({
      ...jest.requireActual('../../src/lib/config'),
      approvedAwsAccounts: () => new Set((answers.approved ?? []) as string[]),
    }));
    jest.doMock('../../src/core/eks', () => ({
      ...jest.requireActual('../../src/core/eks'),
      blockers: () => (answers.blockers ?? []) as string[],
      aws: {
        whoami: () =>
          Promise.resolve({ account: (answers.caller ?? '1') as string, arn: '', error: '' }),
        preflight: () => {
          (answers.preflights as number[] | undefined)?.push(1);
          return Promise.resolve({
            tools: {},
            identity: {
              account: '111122223333',
              arn: 'arn:aws:iam::111122223333:user/alice',
              error: '',
            },
            region: 'us-east-1',
          });
        },
        // A PRESENT answer always carries a document (the Answer type says so); ABSENT and
        // REFUSED carry null. The double keeps to that, as the seam does.
        describeCluster: () => {
          const state = answers.awsState ?? 'refused';
          return Promise.resolve({
            state,
            doc: answers.awsDoc ?? (state === 'present' ? {} : null),
          });
        },
      },
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

  it('never calls a cluster in another AWS account gone, reachable or not', async () => {
    // describe-cluster answers from the CALLER's account. Asked about a cluster in another
    // account (a colleague's, another profile) it says "not found", and the ledger called
    // that gone: 0 billing, costing nothing, Forget offered -- for a live cluster.
    for (const reachStatus of ['down', 'ok']) {
      const cluster = load({ reachStatus, awsState: 'absent', caller: '999999999999' });
      const out = await cluster.status('arn:aws:eks:us-east-1:111122223333:cluster/x');
      expect(out.gone).toBe(false);
      expect(out.made_by_houston).toBeNull();
    }
    // The same account, and AWS says it is not there: that is gone.
    const own = load({ reachStatus: 'down', awsState: 'absent', caller: '111122223333' });
    expect((await own.status('arn:aws:eks:us-east-1:111122223333:cluster/x')).gone).toBe(true);
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

  // HOUSTON_HOME is one per file, so a build note written by one test would be read by the
  // next; the note is the fallback these tests reason about, so each starts without one.
  afterEach(() => {
    fs.rmSync(path.join(process.env.HOUSTON_HOME as string, 'clusters'), {
      recursive: true,
      force: true,
    });
  });
  const ARN = 'arn:aws:eks:us-east-1:1:cluster/support';
  const TAGS = { 'houston.io/managed-by': 'houston', 'houston.io/expires': '2026-10-05' };
  function rememberSupport(expires = '2026-10-07'): void {
    const dir = path.join(process.env.HOUSTON_HOME as string, 'clusters', 'support');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cluster.json'),
      JSON.stringify({
        name: 'support',
        region: 'us-east-1',
        account: '1',
        provider: 'eks',
        expires,
        created_at: '2026-09-28T09:00:00Z',
      }),
    );
  }

  it('says who built a cluster and when it expires, from the document AWS already returned', async () => {
    // `status` already asks AWS to describe the cluster, for `gone`; the same document
    // carries the managed-by and expiry tags and the creation time, so these cost nothing
    // and are true on every machine, not only the one that ran `cluster create`.
    const cluster = load({
      awsState: 'present',
      awsDoc: { createdAt: '2026-09-28T09:00:00+00:00', tags: TAGS },
    });
    const out = await cluster.status(ARN);
    expect(out.name).toBe('support');
    expect(out.region).toBe('us-east-1');
    expect(out.made_by_houston).toBe(true);
    expect(out.expires).toBe('2026-10-05');
    expect(typeof out.expires_in_days).toBe('number');
    expect(out.created_at).toBe('2026-09-28T09:00:00+00:00');
  });

  it('falls back to the local build note when AWS refuses the read', async () => {
    rememberSupport();
    const cluster = load({ awsState: 'refused' });
    const out = await cluster.status(ARN);
    expect(out.made_by_houston).toBe(true);
    expect(out.expires).toBe('2026-10-07');
    expect(out.created_at).toBe('2026-09-28T09:00:00Z');
  });

  it('knows the difference between not built by houston and not knowable', async () => {
    const theirs = load({ awsState: 'present', awsDoc: { tags: {} } });
    const t = await theirs.status(ARN);
    expect(t.made_by_houston).toBe(false);
    expect(t.expires).toBe('');
    expect(t.expires_in_days).toBeNull();
    const unknown = load({ awsState: 'refused' });
    const u = await unknown.status(ARN);
    expect(u.made_by_houston).toBeNull();
    expect(u.created_at).toBe('');
    expect(u.spend_usd).toBeNull();
  });

  it('prices what a cluster has cost so far from its rate and its age', async () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
    const cluster = load({
      awsState: 'present',
      awsDoc: { createdAt: tenHoursAgo, tags: TAGS },
      'ask:nodes': {
        state: 'present',
        doc: {
          items: [{ metadata: { labels: { 'node.kubernetes.io/instance-type': 't3.large' } } }],
        },
      },
    });
    const out = await cluster.status(ARN);
    expect(out.cost).not.toBeNull();
    const rate = out.cost?.usd_hr ?? 0;
    expect(out.spend_usd).toBeGreaterThan(rate * 9.9);
    expect(out.spend_usd).toBeLessThan(rate * 10.1);
    // With no creation time there is no age, and a spend nobody can compute is null.
    const ageless = load({
      awsState: 'present',
      awsDoc: { tags: TAGS },
      'ask:nodes': {
        state: 'present',
        doc: {
          items: [{ metadata: { labels: { 'node.kubernetes.io/instance-type': 't3.large' } } }],
        },
      },
    });
    expect((await ageless.status(ARN)).spend_usd).toBeNull();
  });

  it('lists a context as built by houston from the local note, without probing', async () => {
    rememberSupport();
    const cluster = load({ contexts: [ARN, 'arn:aws:eks:eu-west-1:1:cluster/perf'] });
    const known = await cluster.knownContexts();
    expect(known.contexts.map((c) => [c.short, c.made_by_houston])).toEqual([
      ['support', true],
      ['perf', false],
    ]);
  });

  it('reports whether a cluster is prepared: storage, ingress, certificates, an address', async () => {
    // What `cluster prepare` sets up, read back so the page can say which stage a cluster is
    // at without anybody re-running prepare to find out.
    const cluster = load({
      awsState: 'present',
      storageClasses: [['gp2', 'gp3'], 'gp3'],
      ingressClasses: ['traefik'],
      'object:customresourcedefinition/certificates.cert-manager.io': { state: 'present', doc: {} },
      lbName: 'traefik/traefik',
      lbAddr: 'a1b2c3-123.us-east-1.elb.amazonaws.com',
    });
    const out = await cluster.status(ARN);
    expect(out.ready).toEqual({
      storage_class: 'gp3',
      ingress_class: 'traefik',
      cert_manager: true,
      cname_target: 'a1b2c3-123.us-east-1.elb.amazonaws.com',
      // No DNS zone is known yet, so nothing can be resolved: null, not false.
      dns_answers: null,
    });
  });

  it('reports each readiness fact as null when it could not be read, and none when the cluster cannot', async () => {
    const bare = load({ awsState: 'present', storageClasses: null, ingressClasses: null });
    const out = await bare.status(ARN);
    expect(out.ready).toEqual({
      storage_class: null,
      ingress_class: null,
      cert_manager: false,
      cname_target: '',
      dns_answers: null,
    });
    const down = load({ reachStatus: 'down' });
    expect((await down.status(ARN)).ready).toBeNull();
  });

  const NODES = {
    state: 'present',
    doc: { items: [{ metadata: { labels: { 'node.kubernetes.io/instance-type': 't3.large' } } }] },
  };

  it('overview reads every known cluster, adds them up and says what is next', async () => {
    const perf = 'arn:aws:eks:eu-west-1:1:cluster/perf';
    // An expiry a month from TODAY: a fixed date turned this test from "idle" into
    // "expiring" the day the calendar reached it.
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const cluster = load({
      contexts: [ARN, perf],
      servers: { [ARN]: 'https://a', [perf]: 'https://b' },
      approved: ['111122223333'],
      awsState: 'present',
      awsDoc: {
        createdAt: '2026-09-28T09:00:00+00:00',
        tags: { ...TAGS, 'houston.io/expires': later },
      },
      'ask:nodes': NODES,
    });
    const said: string[] = [];
    const out = await cluster.overview((event) => void said.push(event.message));
    expect(out.clusters.map((c) => c.name)).toEqual(['support', 'perf']);
    expect(out.totals.clusters).toBe(2);
    expect(out.totals.billable).toBe(2);
    expect(out.totals.usd_day).toBeGreaterThan(0);
    expect(out.totals.workspaces).toBe(0);
    expect(out.preflight.approved).toBe(true);
    expect(out.preflight.tools_ok).toBe(true);
    expect(out.preflight.account).toBe('111122223333');
    // Stage 5 for a ready cluster: the tools are there, the account is approved, and
    // nothing is expiring or idle -- wait: both hold nothing. Idle wins over ready.
    expect(out.next.stage).toBe(6);
    expect(out.next.command).toBe('houston cluster delete support');
    // Progress, one line per cluster, so a slow probe is seen to be working.
    expect(said).toEqual(expect.arrayContaining(['reading support…', 'reading perf…']));
  });

  it('overview with nothing known says build one, and passes a running build through', async () => {
    const cluster = load({ contexts: [], approved: ['111122223333'] });
    const none = await cluster.overview();
    expect(none.clusters).toEqual([]);
    expect(none.totals).toEqual({
      clusters: 0,
      billable: 0,
      usd_day: null,
      spend_usd: null,
      workspaces: 0,
      unpriced: 0,
      unread: 0,
    });
    expect(none.next.stage).toBe(3);
    expect(none.next.command).toContain('houston cluster create');
    const building = await cluster.overview(undefined, { building: ['perf2'] });
    expect(building.next.title).toContain('Building perf2');
  });

  it('overview lists a build that failed part-way, and asks AWS whether it is still there', async () => {
    const cluster = load({
      contexts: [],
      approved: ['111122223333'],
      awsState: 'present',
      awsDoc: { arn: 'arn:aws:eks:us-west-2:1:cluster/perf2', tags: {} },
      unfinished: [
        {
          kind: 'cluster_unfinished',
          workspace: 'perf2',
          detail: { region: 'us-west-2', account: '1' },
          at: '',
          owner: '',
        },
      ],
    });
    const out = await cluster.overview();
    expect(out.failed).toEqual([{ name: 'perf2', region: 'us-west-2', present: true }]);
    expect(out.next.stage).toBe(6);
    expect(out.next.command).toBe('houston cluster delete perf2 --region us-west-2');
  });

  it('overview calls a build whose process is alive building, and only a dead one failed', async () => {
    const entry = {
      kind: 'cluster_unfinished',
      workspace: 'perf2',
      detail: { region: 'us-west-2', account: '1' },
      at: '',
      pid: 1,
      started: '',
      id: 'e1',
    };
    const cluster = load({
      contexts: [],
      approved: ['111122223333'],
      awsState: 'present',
      awsDoc: { tags: {} },
      unfinished: [entry],
      dead: [],
    });
    const out = await cluster.overview();
    // A CLI create in another terminal: "failed part-way, delete what it left" would have
    // pointed at a live build.
    expect(out.failed).toEqual([]);
    expect(out.next.title).toContain('Building perf2');
    expect(out.totals.billable).toBe(1);
  });

  it('overview totals say what they could not read instead of adding it as zero', async () => {
    const perf = 'arn:aws:eks:eu-west-1:1:cluster/perf';
    const cluster = load({
      contexts: [ARN, perf],
      servers: { [ARN]: 'https://a', [perf]: 'https://b' },
      approved: ['111122223333'],
      awsState: 'present',
      awsDoc: { tags: TAGS },
      'ask:nodes': NODES,
      reachFor: { [perf]: 'denied' },
    });
    const out = await cluster.overview();
    expect(out.totals.billable).toBe(2);
    // One cluster is unreadable; the other is missing its EKS version, so its
    // control-plane support tier is only a lower-bound estimate.
    expect(out.totals.unpriced).toBe(2);
    expect(out.totals.unread).toBe(1);
  });

  it('overview stops at the first stage that stops everything, when there is nothing to use yet', async () => {
    const cluster = load({ contexts: [], blockers: ['helm is not installed'] });
    const out = await cluster.overview();
    expect(out.preflight.tools_ok).toBe(false);
    expect(out.preflight.blockers).toEqual(['helm is not installed']);
    expect(out.next.stage).toBe(1);
  });

  it('says where a cluster lives from its name and its API server, without asking it', () => {
    const { whereOf } = load();
    expect(whereOf('arn:aws:eks:us-east-1:1:cluster/support')).toBe('aws');
    expect(whereOf('alice@support.us-east-1.eksctl.io')).toBe('aws');
    expect(whereOf('support', 'https://ABC123.gr7.us-east-1.eks.amazonaws.com')).toBe('aws');
    expect(whereOf('kind-houston-local')).toBe('local');
    expect(whereOf('default', 'https://127.0.0.1:6443')).toBe('local');
    expect(whereOf('dev', 'https://localhost:6443')).toBe('local');
    expect(whereOf('docker-desktop', 'https://kubernetes.docker.internal:6443')).toBe('local');
    expect(whereOf('minikube', 'https://192.168.49.2:8443')).toBe('local');
    // A k3s on another machine is not this machine, whatever its distribution.
    expect(whereOf('default', 'https://10.0.0.5:6443')).toBe('elsewhere');
    expect(whereOf('gke_proj_zone_c1', 'https://34.1.2.3')).toBe('elsewhere');
    expect(whereOf('default')).toBe('elsewhere');
  });

  it('lists where each context lives', async () => {
    const cluster = load({
      contexts: [ARN, 'default', 'lab'],
      servers: {
        [ARN]: 'https://a.eks.amazonaws.com',
        default: 'https://127.0.0.1:6443',
        lab: 'https://10.0.0.5:6443',
      },
    });
    const known = await cluster.knownContexts();
    expect(known.contexts.map((c) => [c.short, c.where])).toEqual([
      ['support', 'aws'],
      ['default', 'local'],
      ['lab', 'elsewhere'],
    ]);
  });

  it('overview asks a cluster that does not bill only whether it answers and what it holds', async () => {
    // A working local install does not change its storage class or ingress between two
    // looks, and `up` checks both before it creates anything. Eleven reads were made of a
    // k3s on every look; three answer what the page shows.
    const asked: string[] = [];
    const cluster = load({
      contexts: ['default'],
      servers: { default: 'https://127.0.0.1:6443' },
      distribution: 'k3s',
      asked,
      'ask:namespace': {
        state: 'present',
        doc: {
          items: [{ metadata: { name: 'houston-t1', labels: { 'houston.io/owner': 'alice' } } }],
        },
      },
      'ask:pvc': { state: 'present', doc: { items: [{ metadata: { namespace: 'houston-t1' } }] } },
    });
    const out = await cluster.overview();
    const k3s = out.clusters[0] as ModNS.Ledger;
    expect(k3s.where).toBe('local');
    expect(k3s.reachable).toBe(true);
    expect(k3s.distribution).toBe('k3s');
    expect(k3s.workspaces).toEqual([
      { namespace: 'houston-t1', name: 't1', owner: 'alice', owner_readable: true, pvcs: 1 },
    ]);
    expect(k3s.pvcs).toBe(1);
    // Not read, so not claimed: null, never a zero or a tick.
    expect(k3s.ready).toBeNull();
    expect(k3s.nodes).toBeNull();
    expect(k3s.loadbalancers).toBeNull();
    expect(k3s.cost).toBeNull();
    expect([...asked].sort()).toEqual(['list:namespace', 'list:pvc']);
  });

  it('overview reads a cluster in full when it turns out to be EKS under another name', async () => {
    const asked: string[] = [];
    const cluster = load({
      contexts: ['support-alias'],
      servers: { 'support-alias': 'https://10.0.0.9' },
      distribution: 'eks',
      asked,
      'ask:nodes': NODES,
    });
    const out = await cluster.overview();
    const it = out.clusters[0] as ModNS.Ledger;
    expect(it.where).toBe('aws');
    expect(it.cost).not.toBeNull();
    expect(asked).toEqual(expect.arrayContaining(['storage', 'ingress', 'loadbalancer']));
  });

  it('overview keeps the aws stages and totals to aws, and a local cluster out of both', async () => {
    const cluster = load({
      contexts: ['default'],
      servers: { default: 'https://127.0.0.1:6443' },
      distribution: 'k3s',
      'ask:namespace': {
        state: 'present',
        doc: { items: [{ metadata: { name: 'houston-t1', labels: {} } }] },
      },
    });
    const out = await cluster.overview();
    // No AWS cluster and the account not approved: the AWS section's next step, not
    // "run a workspace on default" with Tools, Approve and Build ticked.
    expect(out.next.stage).toBe(2);
    expect(out.totals).toEqual({
      clusters: 0,
      billable: 0,
      usd_day: null,
      spend_usd: null,
      workspaces: 0,
      unpriced: 0,
      unread: 0,
    });
    expect(out.clusters).toHaveLength(1);
  });

  it('overview asks AWS who you are once in a while, not on every read, unless told to', async () => {
    const preflights: number[] = [];
    const cluster = load({ contexts: [], preflights });
    await cluster.overview(undefined, { reuse: true });
    await cluster.overview(undefined, { reuse: true });
    expect(preflights).toHaveLength(1);
    // A fresh read (Re-check, the CLI) always asks.
    await cluster.overview();
    expect(preflights).toHaveLength(2);
  });

  it('status says a context on this machine is local', async () => {
    const cluster = load({ servers: { default: 'https://127.0.0.1:6443' }, distribution: 'k3s' });
    expect((await cluster.status('default')).where).toBe('local');
  });

  it('knows the zone from the tag or the note, and whether a name under it reaches the cluster', async () => {
    const target = 'a1b2c3-123.us-east-1.elb.amazonaws.com';
    const probe = (host: string): string[] =>
      host.endsWith('.rc.example.com') ? [`${target}.`] : [];
    const tagged = load({
      awsState: 'present',
      awsDoc: { tags: { ...TAGS, 'houston.io/zone': 'rc.example.com' } },
      lbName: 'traefik/traefik',
      lbAddr: target,
      cname: probe,
    });
    const out = await tagged.status(ARN);
    expect(out.zone).toBe('rc.example.com');
    expect(out.ready?.dns_answers).toBe(true);
    // The record's zone when the tag has none.
    rememberSupport();
    const dir = path.join(process.env.HOUSTON_HOME as string, 'clusters', 'support');
    const note = JSON.parse(fs.readFileSync(path.join(dir, 'cluster.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      path.join(dir, 'cluster.json'),
      JSON.stringify({ ...note, zone: 'rc.example.com' }),
    );
    const noted = load({
      awsState: 'present',
      awsDoc: { tags: TAGS },
      lbAddr: target,
      cname: probe,
    });
    expect((await noted.status(ARN)).zone).toBe('rc.example.com');
  });

  it('says DNS does not answer when the name is missing or points elsewhere, and nothing without a zone', async () => {
    const target = 'a1b2c3-123.us-east-1.elb.amazonaws.com';
    const zoned = { 'houston.io/zone': 'rc.example.com' };
    const missing = load({ awsState: 'present', awsDoc: { tags: zoned }, lbAddr: target });
    expect((await missing.status(ARN)).ready?.dns_answers).toBe(false);
    const elsewhere = load({
      awsState: 'present',
      awsDoc: { tags: zoned },
      lbAddr: target,
      cname: () => ['other.elb.amazonaws.com.'],
    });
    expect((await elsewhere.status(ARN)).ready?.dns_answers).toBe(false);
    const nozone = load({
      awsState: 'present',
      awsDoc: { tags: {} },
      lbAddr: target,
      cname: () => [target],
    });
    expect((await nozone.status(ARN)).ready?.dns_answers).toBeNull();
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
