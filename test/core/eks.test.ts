/**
 * The module no test can verify end to end at any price.
 *
 * No test here can validate `eksctl create cluster` -- that is twenty minutes and real
 * money -- so the module draws the line where earlier releases already drew it: every
 * DECISION is pure and asserted, and what is left unverifiable is the invocation itself.
 * The cases that matter most are the ones about NOT doing something: a delete authorised
 * by a read that failed, a create in an account nobody approved, a sweep whose silence
 * reads as "you are not paying for anything".
 *
 * The AWS seam is replaced throughout. Nothing in this file reaches AWS, and a case that
 * needed to would be a case that cannot exist.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import * as config from '../../src/lib/config';
import {
  AuthorityGateError,
  ConflictError,
  NotFoundError,
  PreflightError,
} from '../../src/lib/errors';
import { type Event, nullEmit } from '../../src/lib/events';
import { CLUSTER_UNFINISHED, installJournalSink, type JournalSink } from '../../src/lib/journal';
import { awsCli, type AwsResult } from '../../src/seams/aws-cli';

import {
  CLUSTER_CREATE_TIMEOUT,
  DEFAULT_NODES,
  DEFAULT_REGION_SWEEP,
  DEFAULT_VPC_CIDR,
  EXPIRY_TAG_KEY,
  OWNED_TAG_KEY,
  OWNED_TAG_VALUE,
  STORAGE_CLASS,
  aws,
  blockers,
  clusterConfig,
  connectExisting,
  clusterExists,
  cloudReady,
  daysUntil,
  deleteCluster,
  describeCluster,
  enabledRegions,
  expiryDate,
  forget,
  identity,
  identityPretty,
  keepManifest,
  oneLine,
  ownsCluster,
  region,
  remember,
  remembered,
  streamTool,
  eksctlProgress,
  ZONE_TAG_KEY,
  zoneOf,
  rememberZone,
  installMetricsServer,
  METRICS_SERVER_MANIFEST,
  sweepLeftovers,
  keepCluster,
  shareCluster,
  approveAccount,
  sweepClusters,
  whoami,
} from '../../src/core/eks';
import { IAM_DOCUMENTS, guide, iamDocument } from '../../src/core/eks-docs';
import { kube } from '../../src/core/kube/exec';
import { makeTool } from '../../src/core/kube/tools';

import type * as ToolsNS from '../../src/core/kube/tools';

// `approvedAwsAccounts` is the spend gate's own input, and swc emits exports as
// non-configurable getters -- so it is mocked rather than assigned. Everything else in
// config stays REAL, `home()` above all: the suite's HOUSTON_HOME isolation runs through
// it, and a stubbed one would put these files in somebody's actual home.
jest.mock('../../src/lib/config', () => ({
  ...jest.requireActual('../../src/lib/config'),
  approvedAwsAccounts: jest.fn(() => new Set<string>()),
}));

// `aws` AND `eksctl` ARE INSTALLED HERE, said by the file rather than borrowed from the box.
//
// Presence is `kube/tools.which`, a PATH lookup, and this file used to get its answer from whatever
// this machine had installed: measured on a PATH without the six tools, eight of these cases failed
// with "aws is not installed". `test/testsetup-cloud.ts` now reports every tool ABSENT unless a
// test says otherwise, so this is the saying. An empty PATH still means "no aws at all", which is
// how the one case that needs it says so.
// `tool()` is replaced with `which()` because it calls `which()` from inside its own module.
jest.mock('../../src/core/kube/tools', () => {
  const actual = jest.requireActual<typeof ToolsNS>('../../src/core/kube/tools');
  const installed = new Set(['aws', 'eksctl']);
  const where = (name: string): string =>
    installed.has(name) && (process.env.PATH ?? '') !== '' ? `/usr/local/bin/${name}` : '';
  return {
    ...actual,
    which: where,
    tool: async (name: string) =>
      where(name) === ''
        ? actual.makeTool({ name })
        : actual.makeTool({ name, path: where(name), version: [9, 9, 9], raw: '9.9.9' }),
  };
});

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

const realKubeRun = kube.run;
const realDescribe = aws.describeCluster;
const realPreflight = aws.preflight;
const realWhoami = aws.whoami;
const realPrepare = aws.prepareCluster;

type Rule = [(argv: readonly string[]) => boolean, Partial<AwsResult>];

/** Every argv the scripted AWS seam saw. */
let seen: string[][] = [];

function script(rules: Rule[], fallback: Partial<AwsResult> = {}): void {
  seen = [];
  awsCli.run = (argv) => {
    seen.push([...argv]);
    const hit = rules.find(([matches]) => matches(argv));
    return Promise.resolve({
      argv,
      returncode: 0,
      stdout: '',
      stderr: '',
      ...(hit === undefined ? fallback : hit[1]),
    });
  };
}

const has =
  (...needles: string[]) =>
  (argv: readonly string[]) =>
    needles.every((needle) => argv.includes(needle));

const json = (value: unknown) => ({ stdout: JSON.stringify(value) });

/** A tool that is installed and new enough, as `preflight` reports one. */
const installed = (name: string) =>
  makeTool({ name, path: `/usr/local/bin/${name}`, version: [9, 9, 9], raw: '9.9.9' });

const READY = {
  tools: { aws: installed('aws'), eksctl: installed('eksctl') },
  identity: identity({ account: '111122223333', arn: 'arn:aws:iam::111122223333:user/alice' }),
  region: 'eu-west-1',
};

/**
 * THE REAL SEAM IS NEVER PUT BACK, and this file learned that the hard way.
 *
 * An earlier version restored `awsCli.stream` in `afterEach` and re-scripted it per test.
 * `jest.config.js` sets `clearMocks: true`, which calls `mockClear` -- and `mockClear`
 * KEEPS a `mockReturnValue`. So the approved-account value one case set leaked into the
 * spend-gate case, the gate passed on it, and `createCluster` reached a seam that was real
 * again: `eksctl create cluster` ran against this machine's ambient AWS credentials and
 * built a live EKS cluster in eu-west-1 before the 5 s test timeout even fired. It was
 * deleted, and it cost real money for the ten minutes it existed.
 *
 * So the seam is replaced ONCE, in `beforeEach`, with something that FAILS rather than
 * runs, and nothing here ever restores it. A case that wants a particular answer overrides
 * it for itself; a case that forgets gets a loud failure instead of an AWS bill. The
 * module's own docstring says no test can verify it at any price -- this is the other half
 * of that sentence: a test file for it must be unable to reach the thing it cannot verify.
 */
const refuse = (what: string) => () => {
  throw new Error(
    `this test reached the REAL ${what}. Nothing in eks.test.ts may: the seam spends ` +
      'money. Script it in the test that needs it.',
  );
};

beforeEach(() => {
  seen = [];
  awsCli.run = refuse('aws seam') as unknown as typeof awsCli.run;
  awsCli.stream = refuse('eksctl seam') as unknown as typeof awsCli.stream;
  // And the approved-account gate starts CLOSED every time, because `clearMocks` does not
  // clear a return value and an account approved in one case is approved in the next.
  mocked(config.approvedAwsAccounts).mockReturnValue(new Set());
});

afterEach(() => {
  kube.run = realKubeRun;
  aws.describeCluster = realDescribe;
  aws.preflight = realPreflight;
  aws.whoami = realWhoami;
  aws.prepareCluster = realPrepare;
});

describe('connect to an existing EKS cluster', () => {
  const arn = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';

  it('checks the account before writing kubeconfig', async () => {
    aws.whoami = () =>
      Promise.resolve(
        identity({ account: '444455556666', arn: 'arn:aws:iam::444455556666:user/bob' }),
      );
    aws.describeCluster = () => Promise.resolve({ state: 'present' as const, doc: { arn } });
    const kubeCalls: string[][] = [];
    kube.run = (argv) => {
      kubeCalls.push([...argv]);
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    script([]);
    await expect(connectExisting(arn)).rejects.toThrow(/belongs to account 111122223333/u);
    expect(seen).toEqual([]);
    expect(kubeCalls).toEqual([]);
  });

  it('uses the full ARN as context, restores the prior context and reports Kubernetes denial', async () => {
    aws.whoami = () =>
      Promise.resolve(
        identity({ account: '111122223333', arn: 'arn:aws:iam::111122223333:user/alice' }),
      );
    aws.describeCluster = () => Promise.resolve({ state: 'present' as const, doc: { arn } });
    const commands: string[][] = [];
    kube.run = (argv) => {
      commands.push([...argv]);
      if (argv.includes('current-context'))
        return Promise.resolve({ argv, returncode: 0, stdout: 'kind-local\n', stderr: '' });
      if (argv.includes('/readyz'))
        return Promise.resolve({ argv, returncode: 1, stdout: '', stderr: 'Unauthorized' });
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    script([[(argv) => argv.includes('update-kubeconfig'), {}]]);
    const connected = await connectExisting(arn);
    expect(seen).toEqual([
      [
        'aws',
        'eks',
        'update-kubeconfig',
        '--name',
        'support',
        '--region',
        'eu-west-1',
        '--alias',
        arn,
      ],
    ]);
    expect(commands).toContainEqual(['kubectl', 'config', 'use-context', 'kind-local']);
    expect(connected).toMatchObject({ context: arn, account: '111122223333', reachable: false });
    expect(connected.access_reason).toMatch(/permissions problem/u);
  });

  it('leaves kubectl without a selected context when none was selected before connecting', async () => {
    aws.whoami = () =>
      Promise.resolve(
        identity({ account: '111122223333', arn: 'arn:aws:iam::111122223333:user/alice' }),
      );
    aws.describeCluster = () => Promise.resolve({ state: 'present' as const, doc: { arn } });
    let currentContext = '';
    const commands: string[][] = [];
    kube.run = (argv) => {
      commands.push([...argv]);
      if (argv[2] === 'current-context') {
        return Promise.resolve({
          argv,
          returncode: currentContext === '' ? 1 : 0,
          stdout: currentContext,
          stderr: '',
        });
      }
      if (argv.includes('unset') && argv.includes('current-context')) currentContext = '';
      if (argv.includes('use-context')) currentContext = argv[argv.length - 1] ?? '';
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    awsCli.run = (argv) => {
      currentContext = arn; // update-kubeconfig changes kubectl's process-wide selection.
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };

    expect((await connectExisting(arn)).context).toBe(arn);
    expect(commands).toContainEqual(['kubectl', 'config', 'unset', 'current-context']);
    expect(currentContext).toBe('');
  });
});

describe('who AWS says you are', () => {
  it('separates "not signed in" from "I could not ask"', async () => {
    // Only one of those is the operator's to fix by logging in, and a refusal that names
    // the wrong one sends them to do the wrong thing.
    script([], json({ Account: '111122223333', Arn: 'arn:aws:iam::111122223333:user/alice' }));
    const known = await whoami();
    expect([known.account, known.error]).toEqual(['111122223333', '']);

    script([], { returncode: 255, stderr: 'Error loading SSO Token: expired' });
    const refused = await whoami();
    expect(refused.account).toBe('');
    // The text AWS prints is far more useful than any sentence houston could substitute.
    expect(refused.error).toContain('SSO Token');
  });

  it('never throws, because doctor is the command you run when things are wrong', async () => {
    script([], { returncode: 0, stdout: '<html>not json</html>' });
    expect((await whoami()).error).toContain('not JSON');
  });

  it('names the identity the way every later message has to', () => {
    expect(identityPretty(identity({ account: '1234', arn: 'arn:aws:iam::1234:user/alice' }))).toBe(
      'alice in account 1234',
    );
    // An ARN with no slash is used whole rather than producing an empty name.
    expect(identityPretty(identity({ account: '1234', arn: 'root' }))).toBe('root in account 1234');
    expect(identityPretty(identity())).toBe('not signed in');
  });

  it('resolves the region the way the AWS tooling does, environment first', async () => {
    const saved = { ...process.env };
    try {
      process.env.AWS_REGION = 'ap-south-1';
      script([], json({}));
      expect(await region()).toBe('ap-south-1');
      // A cluster in the wrong region is invisible to every command afterwards, which all
      // default to this same resolution -- so houston and eksctl must not disagree.
      delete process.env.AWS_REGION;
      process.env.AWS_DEFAULT_REGION = 'us-east-2';
      expect(await region()).toBe('us-east-2');
      delete process.env.AWS_DEFAULT_REGION;
      script([], { stdout: 'eu-central-1\n' });
      expect(await region()).toBe('eu-central-1');
      script([], { returncode: 1, stderr: 'no profile' });
      expect(await region()).toBe('');
    } finally {
      process.env = saved;
    }
  });
});

describe('whether this box could build one at all', () => {
  it('names a missing tool first, and stops there', async () => {
    // Asking about credentials before `aws` exists produces a confusing second complaint
    // about the same absence.
    const pre = {
      tools: { aws: makeTool({ name: 'aws' }), eksctl: installed('eksctl') },
      identity: identity(),
      region: '',
    };
    expect(blockers(pre)).toEqual(['aws is not installed']);
    expect(cloudReady(pre)).toBe(false);
  });

  it('probes kubectl and helm too, because prepare needs them after the money is spent', async () => {
    // The create checked aws and eksctl up front and needed kubectl and helm twenty minutes
    // later, to prepare the cluster; the guide said in so many words that without them
    // "you are left with a cluster that bills and cannot run a workspace yet".
    script([]);
    const pre = await aws.preflight();
    expect(Object.keys(pre.tools).sort()).toEqual(['aws', 'eksctl', 'helm', 'kubectl']);
    expect(blockers(pre, { toBuild: true })).toEqual(
      expect.arrayContaining(['helm is not installed', 'kubectl is not installed']),
    );
    // A DELETE needs neither: it must never be the thing that cannot stop a bill because
    // helm, which it does not use, is missing.
    expect(blockers(pre).filter((line) => /helm|kubectl/u.test(line))).toEqual([]);
  });

  it('carries a DNS zone on the cluster, as a tag and in the build note', async () => {
    // The zone is known once, at build time, and was typed again as --domain on every
    // ticket. On the cluster itself (a tag, true on every machine) and in the note (for
    // the box that built it), so `up` can default the name and the ledger can check DNS.
    const doc = clusterConfig('support', { region: 'eu-west-1', zone: 'rc.example.com' });
    expect((doc.metadata as { tags: Record<string, string> }).tags[ZONE_TAG_KEY]).toBe(
      'rc.example.com',
    );
    const bare = clusterConfig('support', { region: 'eu-west-1' });
    expect((bare.metadata as { tags: Record<string, string> }).tags).not.toHaveProperty(
      ZONE_TAG_KEY,
    );
    expect(zoneOf('support')).toBe('');
    await remember('support', { region: 'eu-west-1', account: '1', zone: 'rc.example.com' });
    expect(zoneOf('support')).toBe('rc.example.com');
    forget('support');
  });

  it('installs metrics-server on a managed cluster that lacks it, and adopts one that has it', async () => {
    // `stats` and the Containers tab read `kubectl top`, which needs metrics-server, and
    // `cluster create` did not install it: the guide had the reader apply the upstream
    // manifest by hand. kind needs an insecure-TLS patch the manifest lacks; EKS does not.
    const calls: string[][] = [];
    let present = false;
    kube.run = (argv) => {
      calls.push([...argv]);
      if (argv.includes('top')) {
        return Promise.resolve({ argv, returncode: present ? 0 : 1, stdout: '', stderr: '' });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    const ctx = 'arn:aws:eks:eu-west-1:1:cluster/support';
    const out = { already: [] as string[], metrics_server: false };
    await installMetricsServer(ctx, 'eks', nullEmit, out);
    expect(calls).toContainEqual([
      'kubectl',
      '--context',
      ctx,
      'apply',
      '-f',
      METRICS_SERVER_MANIFEST,
    ]);
    expect(out.metrics_server).toBe(true);
    expect(METRICS_SERVER_MANIFEST).toMatch(
      /^https:\/\/github\.com\/kubernetes-sigs\/metrics-server\/releases\/download\/v\d/u,
    );

    calls.length = 0;
    present = true;
    const had = { already: [] as string[], metrics_server: false };
    await installMetricsServer(ctx, 'eks', nullEmit, had);
    expect(calls.some((call) => call.includes('apply'))).toBe(false);
    expect(had.already).toContain('metrics-server');
    expect(had.metrics_server).toBe(true);

    // Not on kind or k3s: kind needs a patch this manifest lacks, k3s ships its own.
    calls.length = 0;
    present = false;
    const local = { already: [] as string[], metrics_server: false };
    await installMetricsServer('kind-houston-local', 'kind', nullEmit, local);
    expect(calls).toEqual([]);
    expect(local.metrics_server).toBe(false);
  });

  it('says how to arrange credentials, and never offers to hold them', () => {
    const said = blockers({ ...READY, identity: identity({ error: 'expired' }) }).join(' ');
    expect(said).toContain('not signed in to AWS (expired)');
    expect(said).toContain('houston never holds AWS credentials');
  });

  it('refuses without a region, because the two tools must not disagree', () => {
    expect(blockers({ ...READY, region: '' }).join(' ')).toContain('no AWS region resolved');
    expect(blockers(READY)).toEqual([]);
    expect(cloudReady(READY)).toBe(true);
  });
});

describe('the cluster document', () => {
  it('carries the ownership tag AT CREATION, never afterwards', () => {
    // A separate tagging step has a window in which the cluster exists and is not yet
    // provably houston's, and a crash inside that window leaves something billable that
    // `cluster delete` will then correctly refuse to remove.
    const doc = clusterConfig('support', { region: 'eu-west-1' }) as {
      metadata: { tags: Record<string, string>; region: string; version: string };
    };
    expect(doc.metadata.tags[OWNED_TAG_KEY]).toBe(OWNED_TAG_VALUE);
    expect(doc.metadata.region).toBe('eu-west-1');
  });

  it('tags the expiry only when there is one, because a blank is not a date', () => {
    const withExpiry = clusterConfig('s', { region: 'r', expires: '2026-10-01' }) as {
      metadata: { tags: Record<string, string> };
    };
    expect(withExpiry.metadata.tags[EXPIRY_TAG_KEY]).toBe('2026-10-01');
    const without = clusterConfig('s', { region: 'r' }) as {
      metadata: { tags: Record<string, string> };
    };
    expect(EXPIRY_TAG_KEY in without.metadata.tags).toBe(false);
  });

  it('builds a NEW VPC by default and an existing one only when named', () => {
    // There is no safe guess at which of an account's subnets a support workspace belongs
    // in, and picking wrong puts a cluster somewhere it can be reached from, or cannot
    // reach out from, in ways nobody asked for.
    expect((clusterConfig('s', { region: 'r' }) as { vpc: unknown }).vpc).toEqual({
      cidr: '10.0.0.0/16',
    });
    const named = clusterConfig('s', {
      region: 'r',
      subnets: { 'eu-west-1b': 'subnet-b', 'eu-west-1a': 'subnet-a' },
    }) as { vpc: { subnets: { private: Record<string, unknown> } } };
    // Sorted, so two runs of the same request produce the same document.
    expect(Object.keys(named.vpc.subnets.private)).toEqual(['eu-west-1a', 'eu-west-1b']);
    expect(named.vpc.subnets.private['eu-west-1a']).toEqual({ id: 'subnet-a' });
  });

  it('turns OIDC on, or the EBS addon installs and every volume stays Pending', () => {
    const doc = clusterConfig('s', { region: 'r' }) as {
      iam: { withOIDC: boolean };
      addons: { name: string; version: string }[];
      managedNodeGroups: { desiredCapacity: number; privateNetworking: boolean }[];
    };
    expect(doc.iam.withOIDC).toBe(true);
    expect(doc.addons).toEqual([{ name: 'aws-ebs-csi-driver', version: '1.66.0' }]);
    expect(doc.managedNodeGroups[0]?.desiredCapacity).toBe(DEFAULT_NODES);
    expect(doc.managedNodeGroups[0]?.privateNetworking).toBe(true);
  });

  it('is a document eksctl can read back, quoting included', () => {
    // It goes to disk as YAML and eksctl reads it, so a version that YAML 1.1 turns into
    // a float would be a cluster on a different Kubernetes release than the one asked for.
    const text = YAML.stringify(clusterConfig('s', { region: 'r' }), {
      compat: 'yaml-1.1',
      indentSeq: false,
      lineWidth: 0,
    });
    const parsed = YAML.parse(text) as { metadata: { version: unknown } };
    expect(parsed.metadata.version).toBe('1.37');
  });
});

describe('the expiry, which is a reminder and never a policy', () => {
  it('counts from the LOCAL date, as earlier releases do, where it and the UTC date differ', () => {
    // 2026-09-24 12:00 UTC is 2026-09-25 in UTC+14 and still 2026-09-24 in UTC-12. The
    // answers earlier releases gave for those two dates, `today` given, are 22 and 23 days
    // until 2026-10-17, and 2026-10-02 and 2026-10-01 for seven days on. A child process
    // per zone, since the zone a process reads is fixed when it starts.
    const root = path.resolve(__dirname, '..', '..');
    const at = (zone: string): unknown => {
      const script =
        `require(${JSON.stringify(path.join(root, 'tools', 'ts-require'))}).install();` +
        `const eks = require(${JSON.stringify(path.join(root, 'src', 'core', 'eks.ts'))});` +
        'const today = new Date(Date.UTC(2026, 8, 24, 12, 0));' +
        "process.stdout.write(JSON.stringify([eks.daysUntil('2026-10-17', { today }), eks.expiryDate(7, { today })]));";
      const ran = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, TZ: zone },
      });
      return JSON.parse(ran.stdout) as unknown;
    };
    expect(at('Etc/GMT-14')).toEqual([22, '2026-10-02']);
    expect(at('Etc/GMT+12')).toEqual([23, '2026-10-01']);
  });

  it('counts forward from today, and never says a date for "never"', () => {
    const today = new Date(2026, 8, 15, 12, 0);
    expect(expiryDate(7, { today })).toBe('2026-09-22');
    expect(expiryDate(0, { today })).toBe('2026-09-15');
    // A negative request is not a date in the past: the floor is today.
    expect(expiryDate(-5, { today })).toBe('2026-09-15');
    // A cluster somebody intends to keep should be able to say so, and a reminder nobody
    // can turn off is a reminder everybody learns to ignore.
    expect(expiryDate(null, { today })).toBe('');
  });

  it('reads days left, including past ones, and refuses to guess at nonsense', () => {
    const today = new Date(2026, 8, 15, 23, 59);
    expect(daysUntil('2026-09-22', { today })).toBe(7);
    expect(daysUntil('2026-09-15', { today })).toBe(0);
    expect(daysUntil('2026-09-10', { today })).toBe(-5);
    expect(daysUntil('', { today })).toBeNull();
    expect(daysUntil('not-a-date', { today })).toBeNull();
    expect(daysUntil('2026-13-45', { today })).toBeNull();
  });
});

describe('what AWS says about a cluster', () => {
  it('is three answers, and the two negatives must not be collapsed', async () => {
    // `ResourceNotFoundException` is AWS asserting the cluster is not there, which is safe
    // to act on. Anything else -- expired credentials, no route, a throttle, a permission
    // boundary -- is "I could not ask", which is not.
    script([], json({ cluster: { arn: 'arn:x', status: 'ACTIVE' } }));
    expect((await describeCluster('s', 'eu-west-1')).state).toBe('present');

    script([], {
      returncode: 254,
      stderr: 'An error occurred (ResourceNotFoundException) when calling DescribeCluster',
    });
    expect((await describeCluster('s', 'eu-west-1')).state).toBe('absent');

    script([], { returncode: 254, stderr: 'AccessDeniedException' });
    expect((await describeCluster('s', 'eu-west-1')).state).toBe('refused');

    // A zero exit with a body nobody can parse is not a present cluster either.
    script([], { stdout: '<html>' });
    expect((await describeCluster('s', 'eu-west-1')).state).toBe('refused');
  });

  it('refuses rather than asking without a region', async () => {
    // Every command afterwards defaults to the same resolution, so an unregioned question
    // is not a question at all.
    script([], json({ cluster: {} }));
    expect((await describeCluster('s', '')).state).toBe('refused');
    expect(seen).toEqual([]);
  });
});

describe('whether houston may DESTROY it', () => {
  it('reads the tag, and never the name', async () => {
    // Anyone can call a cluster `houston-something`. The stakes here are a VPC and a NAT
    // gateway rather than a container.
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: { arn: 'arn:x', tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE } },
      });
    expect((await ownsCluster('support', 'eu-west-1')).state).toBe('present');

    aws.describeCluster = () =>
      Promise.resolve({ state: 'present' as const, doc: { arn: 'arn:x', tags: {} } });
    expect((await ownsCluster('houston-support', 'eu-west-1')).state).toBe('absent');

    // A cluster with a DIFFERENT owner's tag value is somebody else's.
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: { tags: { [OWNED_TAG_KEY]: 'someone-else' } },
      });
    expect((await ownsCluster('support', 'eu-west-1')).state).toBe('absent');
  });

  it('passes a refused read THROUGH as refused, never as "not ours"', async () => {
    // Both refuse the delete, and that is deliberate -- but the refusal has to be able to
    // say which it was, because they send the reader to different places.
    aws.describeCluster = () => Promise.resolve({ state: 'refused' as const, doc: null });
    expect((await ownsCluster('support', 'eu-west-1')).state).toBe('refused');
  });

  it('asks a different question from "is it there at all"', async () => {
    // "Is it there" decides whether an interruption note is still worth keeping; "is it
    // ours" decides whether it may be destroyed. Answering the second where the first was
    // asked would clear the note about a half-built cluster that never got its tag on --
    // which is exactly the cluster the note exists for.
    aws.describeCluster = () => Promise.resolve({ state: 'present' as const, doc: { tags: {} } });
    expect((await clusterExists('half-built', 'eu-west-1')).state).toBe('present');
    expect((await ownsCluster('half-built', 'eu-west-1')).state).toBe('absent');
  });
});

describe('deleting, which is worse than creating', () => {
  const owned = {
    state: 'present' as const,
    doc: { arn: '', tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE } },
  };

  beforeEach(() => {
    aws.preflight = () => Promise.resolve(READY);
    script([]);
  });

  it('REFUSES on a read it could not make, and says so in those words', async () => {
    aws.describeCluster = () => Promise.resolve({ state: 'refused' as const, doc: null });
    await expect(deleteCluster('support', { region: 'eu-west-1' })).rejects.toBeInstanceOf(
      PreflightError,
    );
    await expect(deleteCluster('support', { region: 'eu-west-1' })).rejects.toThrow(
      /a read that failed/u,
    );
  });

  it('looks in the region the cluster was built in when none is typed', async () => {
    // remember() wrote clusters/support/cluster.json with the build region. A delete typed
    // without --region looked in the AWS CLI's default region instead, found nothing, and
    // the cluster went on billing where it was built.
    const dir = path.join(config.home(), 'clusters', 'support');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cluster.json'),
      JSON.stringify({
        name: 'support',
        region: 'us-west-2',
        account: '111122223333',
        provider: 'eks',
        expires: '',
        created_at: '2026-09-28T09:00:00Z',
      }),
    );
    const asked: string[] = [];
    aws.describeCluster = (_name: string, region: string) => {
      asked.push(region);
      return Promise.resolve({ state: 'refused' as const, doc: null });
    };
    await expect(deleteCluster('support')).rejects.toBeInstanceOf(PreflightError);
    expect(asked).toEqual(['us-west-2']);
  });

  it('refuses to delete a same-name cluster in a different AWS account', async () => {
    // The saved selection belongs to account A. A Houston-managed cluster with the same
    // name and region in account B must not become the delete target when credentials
    // change between the user's review and the actual job.
    await remember('support', { region: 'eu-west-1', account: '111122223333' });
    aws.preflight = () =>
      Promise.resolve({
        ...READY,
        identity: identity({
          account: '444455556666',
          arn: 'arn:aws:iam::444455556666:user/bob',
        }),
      });
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: {
          arn: 'arn:aws:eks:eu-west-1:444455556666:cluster/support',
          tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE },
        },
      });
    kube.run = (argv) => Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    const deletes: string[][] = [];
    awsCli.stream = (argv) => {
      deletes.push([...argv]);
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };

    await expect(deleteCluster('support', { region: 'eu-west-1', force: true })).rejects.toThrow(
      /account.*111122223333.*444455556666|account.*444455556666.*111122223333/u,
    );
    expect(deletes).toEqual([]);
  });

  it('cleans up only the deleted cluster ARN when other accounts or regions reuse its name', async () => {
    const target = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';
    const otherAccount = 'arn:aws:eks:eu-west-1:444455556666:cluster/support';
    const otherRegion = 'arn:aws:eks:us-east-1:111122223333:cluster/support';
    // This alias omits the account; with two matching ARNs it is ambiguous and must stay.
    const ambiguousAlias = 'bob@support.eu-west-1.eksctl.io';
    const known = new Set([target, otherAccount, otherRegion, ambiguousAlias]);
    const removed: string[] = [];
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: { arn: target, tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE } },
      });
    kube.run = (argv) => {
      if (argv.includes('get-contexts')) {
        return Promise.resolve({ argv, returncode: 0, stdout: [...known].join('\n'), stderr: '' });
      }
      if (argv.includes('delete-context')) {
        const context = argv[argv.length - 1] ?? '';
        removed.push(context);
        known.delete(context);
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    awsCli.stream = (argv) => Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });

    expect(await deleteCluster('support', { region: 'eu-west-1', force: true })).toBe(true);
    expect(new Set(removed)).toEqual(new Set([target]));
    expect(known).toEqual(new Set([otherAccount, otherRegion, ambiguousAlias]));
  });

  it('gates a cluster it did not build, and hands over the command that would', async () => {
    aws.describeCluster = () => Promise.resolve({ state: 'present' as const, doc: { tags: {} } });
    let gate: unknown;
    try {
      await deleteCluster('support', { region: 'eu-west-1' });
    } catch (error) {
      gate = error;
    }
    expect(gate).toBeInstanceOf(AuthorityGateError);
    expect((gate as AuthorityGateError).message).toContain('was not created by houston');
    // The remedy is the command THEY can run, not a flag on ours.
    expect((gate as { approveWith?: string }).approveWith).toBe(
      'eksctl delete cluster --name support --region eu-west-1 --wait',
    );
  });

  it('answers false for a cluster that is simply not there', async () => {
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    expect(await deleteCluster('support', { region: 'eu-west-1' })).toBe(false);
  });

  it('will not delete on an endpoint it cannot reach, whatever the cause', async () => {
    // A cluster that does not answer is where houston knows LEAST about what it is about
    // to destroy. The refusal stands, and now names WHICH cause: it once fired on an
    // ACTIVE cluster whose only problem was a fresh HOUSTON_HOME with no kubeconfig entry.
    aws.describeCluster = () => Promise.resolve(owned);
    await expect(deleteCluster('support', { region: 'eu-west-1' })).rejects.toThrow(
      /nothing to ask/u,
    );
    expect(seen.some((argv) => argv.includes('eksctl'))).toBe(false);
  });

  it('refuses on an unreadable workspace list, because it is not an empty one', async () => {
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: {
          arn: 'arn:aws:eks:eu-west-1:1:cluster/support',
          tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE },
        },
      });
    kube.run = (argv) =>
      Promise.resolve({
        argv,
        // /readyz answers, so the cluster is reachable; the namespace list then refuses.
        ...(argv.includes('/readyz')
          ? { returncode: 0, stdout: 'ok', stderr: '' }
          : { returncode: 1, stdout: '', stderr: 'error: forbidden' }),
      });
    await expect(deleteCluster('support', { region: 'eu-west-1' })).rejects.toThrow(
      /not the same as it being empty/u,
    );
  });

  it('names whose workspaces would go with it, because they may not be on this box', async () => {
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: {
          arn: 'arn:aws:eks:eu-west-1:1:cluster/support',
          tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE },
        },
      });
    kube.run = (argv) => {
      if (argv.includes('/readyz')) {
        return Promise.resolve({ argv, returncode: 0, stdout: 'ok', stderr: '' });
      }
      if (argv.includes('namespace') && argv.includes('-l')) {
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: JSON.stringify({ items: [{ metadata: { name: 'houston-a' } }] }),
          stderr: '',
        });
      }
      return Promise.resolve({
        argv,
        returncode: 0,
        stdout: JSON.stringify({ metadata: { labels: { 'houston.io/owner': 'bob' } } }),
        stderr: '',
      });
    };
    let refusal: unknown;
    try {
      await deleteCluster('support', { region: 'eu-west-1' });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as Error).message).toContain('owned by bob');
  });

  it('skips the reading, and says it is doing so, under --force', async () => {
    aws.describeCluster = () => Promise.resolve(owned);
    awsCli.stream = () => Promise.resolve({ argv: [], returncode: 0, stdout: '', stderr: '' });
    const events: Event[] = [];
    expect(
      await deleteCluster('support', {
        region: 'eu-west-1',
        force: true,
        emit: (event) => events.push(event),
      }),
    ).toBe(true);
    expect(events.map((event) => event.message).join(' ')).toContain(
      'without reading what it holds',
    );
  });

  it('releases the load balancers itself, and only then hands the cluster to eksctl', async () => {
    // A LoadBalancer Service holds network interfaces in the VPC, and while it exists the
    // VPC delete hangs. The guide had the reader run a raw kubectl against the pinned
    // kubeconfig first, step 4 of the teardown, and the step most likely to be skipped.
    const arn = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: { arn, tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE } },
      });
    const order: string[] = [];
    kube.run = (argv) => {
      if (argv.includes('delete') && argv.includes('svc')) order.push('release');
      // The reach probe and the Service list: nothing left, nothing pending.
      return Promise.resolve({ argv, returncode: 0, stdout: '{"items":[]}', stderr: '' });
    };
    awsCli.stream = (argv) => {
      order.push('eksctl');
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    await deleteCluster('support', { region: 'eu-west-1', force: true });
    expect(order).toEqual(['release', 'eksctl']);
  });

  it('does not take a refused read of the Services for a released load balancer', async () => {
    // Read as "nothing left", one refused read handed the VPC to eksctl with the load
    // balancer still holding interfaces in it, and the VPC delete hung.
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: {
          arn: 'arn:aws:eks:eu-west-1:111122223333:cluster/support',
          tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE },
        },
      });
    const order: string[] = [];
    let reads = 0;
    kube.run = (argv) => {
      if (argv.includes('delete') && argv.includes('svc')) order.push('release');
      if (argv.includes('get') && argv.includes('svc')) {
        reads += 1;
        order.push(reads === 1 ? 'read: refused' : 'read: none');
        if (reads === 1)
          return Promise.resolve({ argv, returncode: 1, stdout: '', stderr: 'i/o timeout' });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '{"items":[]}', stderr: '' });
    };
    awsCli.stream = (argv) => {
      order.push('eksctl');
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    await deleteCluster('support', { region: 'eu-west-1', force: true });
    expect(order).toEqual(['release', 'read: refused', 'read: none', 'eksctl']);
  }, 20_000);

  it('does not warn about load balancers a timed-out delete did release', async () => {
    // `kubectl delete` waits on the load-balancer finalizer, so it times out on a delete
    // that went through. It warned "could not be removed" and skipped the wait.
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: {
          arn: 'arn:aws:eks:eu-west-1:111122223333:cluster/support',
          tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE },
        },
      });
    kube.run = (argv) =>
      Promise.resolve(
        argv.includes('delete') && argv.includes('svc')
          ? { argv, returncode: 1, stdout: '', stderr: 'timed out waiting for the condition' }
          : { argv, returncode: 0, stdout: '{"items":[]}', stderr: '' },
      );
    awsCli.stream = (argv) => Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    const warned: string[] = [];
    await deleteCluster('support', {
      region: 'eu-west-1',
      force: true,
      emit: (event) => {
        if (event.level === 'warn') warned.push(event.message);
      },
    });
    expect(warned.filter((message) => message.includes('load balancer'))).toEqual([]);
  });

  it('passes --wait, because without it a half-finished teardown reports success', async () => {
    aws.describeCluster = () => Promise.resolve(owned);
    let ran: readonly string[] = [];
    awsCli.stream = (argv) => {
      ran = argv;
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    await deleteCluster('support', { region: 'eu-west-1', force: true });
    expect(ran).toEqual([
      'eksctl',
      'delete',
      'cluster',
      '--name',
      'support',
      '--region',
      'eu-west-1',
      '--wait',
    ]);
  });

  it('refuses before any of that when the box cannot talk to AWS at all', async () => {
    aws.preflight = () => Promise.resolve({ ...READY, identity: identity() });
    await expect(deleteCluster('support', { region: 'eu-west-1' })).rejects.toThrow(
      /cannot delete an EKS cluster from here/u,
    );
  });
});

describe('approving an account for spending', () => {
  it("adds the account to the list, keeps the others, and records the Let's Encrypt contact", async () => {
    // The GUI's build flow approves from the browser. It writes the same two keys
    // `houston config set` writes, through the locked writer every config write uses.
    config.updateConfig((cfg) => {
      cfg[config.CLOUD_ACCOUNTS_KEY] = '444455556666';
    });
    const out = await approveAccount('111122223333', { acmeEmail: 'alice@example.com' });
    expect(out.approved).toEqual(['111122223333', '444455556666']);
    const cfg = config.loadConfig();
    expect(String(cfg[config.CLOUD_ACCOUNTS_KEY])).toBe('111122223333,444455556666');
    expect(String(cfg.acme_email)).toBe('alice@example.com');
    await expect(approveAccount('abc')).rejects.toThrow(/12-digit/u);
    config.updateConfig((c) => {
      delete c[config.CLOUD_ACCOUNTS_KEY];
      delete c.acme_email;
    });
  });
});

describe('keeping a cluster past its reminder date', () => {
  const arn = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';
  const built = (tags: Record<string, string>) => () =>
    Promise.resolve({ state: 'present' as const, doc: { arn, tags } });

  it('moves the expiry tag and the note, and says the new date', async () => {
    // The date is a reminder tag and nothing deletes on it, but extending it took
    // `aws eks tag-resource` by hand; doctor then nagged about a cluster still in use.
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = built({
      [OWNED_TAG_KEY]: OWNED_TAG_VALUE,
      [EXPIRY_TAG_KEY]: '2026-10-01',
    });
    script([]);
    await remember('support', {
      region: 'eu-west-1',
      account: '111122223333',
      expires: '2026-10-01',
    });
    const out = await keepCluster('support', { days: 7, region: 'eu-west-1' });
    const expected = expiryDate(7);
    expect(out).toEqual({ name: 'support', region: 'eu-west-1', expires: expected, days: 7 });
    expect(seen).toContainEqual([
      'aws',
      'eks',
      'tag-resource',
      '--resource-arn',
      arn,
      '--tags',
      `${EXPIRY_TAG_KEY}=${expected}`,
    ]);
    expect(remembered().find((entry) => entry.name === 'support')?.expires).toBe(expected);
    forget('support');
  });

  it('refuses a cluster houston did not build, and says so when there is none', async () => {
    aws.preflight = () => Promise.resolve(READY);
    script([]);
    aws.describeCluster = built({});
    await expect(keepCluster('support', { days: 7, region: 'eu-west-1' })).rejects.toBeInstanceOf(
      AuthorityGateError,
    );
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    await expect(keepCluster('support', { days: 7, region: 'eu-west-1' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('sharing a cluster with a colleague', () => {
  const arn = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';
  beforeEach(() => {
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: { arn, tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE } },
      });
  });

  it('grants the AWS access entry, the cluster policy and the in-cluster RBAC, in that order', async () => {
    // Appendix A of the guide: three aws commands and a kubectl apply, by hand, and "the
    // first alone is not enough" -- with only the IAM half every kubectl says Unauthorized.
    script([]);
    let applied = '';
    const order: string[] = [];
    kube.run = (argv, options) => {
      if (argv.includes('apply')) {
        order.push('rbac');
        applied = String((options as { input?: string }).input ?? '');
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    const out = await shareCluster('support', { user: 'bob', region: 'eu-west-1' });
    const principal = 'arn:aws:iam::111122223333:user/bob';
    const calls = seen.filter(
      (call) => call.includes('create-access-entry') || call.includes('associate-access-policy'),
    );
    expect(calls.map((call) => call[2])).toEqual([
      'create-access-entry',
      'associate-access-policy',
    ]);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        '--principal-arn',
        principal,
        '--kubernetes-groups',
        'houston-engineers',
      ]),
    );
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        '--policy-arn',
        'arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy',
      ]),
    );
    expect(order).toEqual(['rbac']);
    expect(applied).toContain('houston-engineers');
    expect(out.principal).toBe(principal);
    expect(out.lines[0]).toBe('aws eks update-kubeconfig --name support --region eu-west-1');
    expect(out.lines[1]).toContain('houston up');
    expect(out.lines[1]).toContain('--context support');
  });

  it('refuses a cluster houston did not build, before granting anything', async () => {
    // The operator policy may create access entries on any cluster in the account, so the
    // tag is the gate, as it is for keep and delete: this grants cluster admin.
    aws.describeCluster = () =>
      Promise.resolve({ state: 'present' as const, doc: { arn, tags: {} } });
    script([]);
    await expect(
      shareCluster('support', { user: 'bob', region: 'eu-west-1' }),
    ).rejects.toBeInstanceOf(AuthorityGateError);
    expect(seen.some((call) => call.includes('create-access-entry'))).toBe(false);
  });

  it('says what it already granted, and how to take it back, when the in-cluster step fails', async () => {
    script([]);
    kube.run = (argv) =>
      Promise.resolve({
        argv,
        returncode: 1,
        stdout: '',
        stderr: 'error: You must be logged in to the server',
      });
    let failure: unknown;
    try {
      await shareCluster('support', { user: 'bob', region: 'eu-west-1' });
    } catch (error) {
      failure = error;
    }
    const message = (failure as Error).message;
    expect(message).toContain('access entry');
    expect(message).toContain('AmazonEKSAdminPolicy');
    expect(message).toContain(
      'aws eks delete-access-entry --cluster-name support --region eu-west-1 --principal-arn arn:aws:iam::111122223333:user/bob',
    );
  });

  it('takes a full principal ARN as given, and an entry that already exists as done', async () => {
    script([
      [
        has('create-access-entry'),
        { returncode: 254, stderr: 'An error occurred (ResourceInUseException): already exists' },
      ],
    ]);
    kube.run = (argv) => Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    const role = 'arn:aws:iam::111122223333:role/support-engineers';
    const out = await shareCluster('support', { user: role, region: 'eu-west-1' });
    expect(out.principal).toBe(role);
    expect(out.already).toBe(true);
  });
});

describe('what a delete leaves behind', () => {
  // ONLY THIS CLUSTER'S. A region holds colleagues' clusters too; a region-wide list of
  // load balancers and NAT gateways, each with its delete command, handed out commands
  // that break someone else's running cluster. Every row is tied to `support` by a tag
  // eksctl or Kubernetes put on it, or it is shown as a candidate with no command.
  const SUPPORT = 'kubernetes.io/cluster/support';
  it("lists what carries this cluster's tag, with the fix for each", async () => {
    script([
      [
        has('describe-volumes'),
        json([
          ['vol-mine', 8, '2026-09-28', `kubernetes.io/created-for/pvc/name,${SUPPORT}`],
          [
            'vol-theirs',
            8,
            '2026-09-28',
            'kubernetes.io/created-for/pvc/name,kubernetes.io/cluster/perf',
          ],
          [
            'vol-untagged',
            8,
            '2026-09-28',
            'kubernetes.io/created-for/pvc/name,kubernetes.io/created-for/pvc/namespace',
          ],
        ]),
      ],
      [
        has('elb', 'describe-load-balancers'),
        json([
          ['a1', 'a1.elb.amazonaws.com'],
          ['b2', 'b2.elb.amazonaws.com'],
        ]),
      ],
      [
        has('elb', 'describe-tags'),
        json({
          TagDescriptions: [
            { LoadBalancerName: 'a1', Tags: [{ Key: SUPPORT, Value: 'owned' }] },
            {
              LoadBalancerName: 'b2',
              Tags: [{ Key: 'kubernetes.io/cluster/perf', Value: 'owned' }],
            },
          ],
        }),
      ],
      [has('elbv2', 'describe-load-balancers'), json([])],
      [
        has(
          'describe-nat-gateways',
          'Name=tag:aws:cloudformation:stack-name,Values=eksctl-support-cluster',
        ),
        json([['nat-1', 'vpc-1']]),
      ],
      [has('describe-nat-gateways'), json([['nat-theirs', 'vpc-9']])],
      [
        has(
          'describe-addresses',
          'Name=tag:aws:cloudformation:stack-name,Values=eksctl-support-cluster',
        ),
        json([['eipalloc-1', '3.4.5.6']]),
      ],
      [has('describe-addresses'), json([['eipalloc-theirs', '9.9.9.9']])],
      [has('list-stacks'), json([['eksctl-support-cluster', 'DELETE_FAILED']])],
    ]);
    const out = await sweepLeftovers('support', 'eu-west-1');
    expect(out.unreadable).toEqual([]);
    expect(out.found.map((row) => [row.kind, row.id, row.certain])).toEqual([
      ['volume', 'vol-mine', true],
      ['volume', 'vol-untagged', false],
      ['load balancer', 'a1', true],
      ['nat gateway', 'nat-1', true],
      ['elastic ip', 'eipalloc-1', true],
      ['stack', 'eksctl-support-cluster', true],
    ]);
    expect(out.found[0]?.fix).toContain(
      'aws ec2 delete-volume --region eu-west-1 --volume-id vol-mine',
    );
    // A candidate carries no command: nothing ties it to this cluster.
    expect(out.found[1]?.fix).toBe('');
    expect(out.found[1]?.detail).toContain('not tagged');
    expect(out.found[2]?.fix).toContain('--load-balancer-name a1');
  });

  it('reports a read it could not make instead of counting it as clean', async () => {
    script([[has('describe-volumes'), { returncode: 254, stderr: 'AccessDenied' }]], json([]));
    const out = await sweepLeftovers('support', 'eu-west-1');
    expect(out.found).toEqual([]);
    expect(out.unreadable.map((entry) => entry.kind)).toEqual(['volume']);
    expect(out.unreadable[0]?.why).toBe('AccessDenied');
  });
});

describe('the sweep that answers "what am I paying for"', () => {
  it('reports a region it could not read INSTEAD of counting it as empty', async () => {
    // The one thing a report like this must never do is let "I could not ask fourteen
    // regions" read as "you are not paying for anything".
    script([[has('list-clusters'), { returncode: 254, stderr: 'AccessDenied\nmore' }]]);
    const out = await sweepClusters({ regions: ['eu-west-1', 'us-east-1'] });
    expect(out.clusters).toEqual([]);
    expect(out.unreadable.map((entry) => entry.region)).toEqual(['eu-west-1', 'us-east-1']);
    expect(out.unreadable[0]?.why).toBe('AccessDenied');
  });

  it('reports a cluster it could see but not describe, rather than dropping it', async () => {
    // `list-clusters` just named it, so it IS there -- and a cluster silently missing from
    // this list is the exact failure the function exists to prevent.
    script([[has('list-clusters'), json(['ghost'])]]);
    aws.describeCluster = () => Promise.resolve({ state: 'refused' as const, doc: null });
    const out = await sweepClusters({ regions: ['eu-west-1'] });
    expect(out.clusters).toEqual([]);
    expect(out.unreadable[0]?.why).toContain('ghost is there and could not be described');
  });

  it('carries the tag, the status and the expiry for each one it found', async () => {
    script([[has('list-clusters'), json(['support', 'theirs'])]]);
    aws.describeCluster = (name) =>
      Promise.resolve({
        state: 'present' as const,
        doc: {
          status: 'ACTIVE',
          arn: `arn:aws:eks:eu-west-1:1:cluster/${name}`,
          createdAt: '2026-09-01',
          tags:
            name === 'support'
              ? { [OWNED_TAG_KEY]: OWNED_TAG_VALUE, [EXPIRY_TAG_KEY]: '2026-09-22' }
              : {},
        },
      });
    const mine = await sweepClusters({ regions: ['eu-west-1'] });
    expect(mine.clusters.map((entry) => entry.name)).toEqual(['support']);
    expect(mine.clusters[0]?.expires).toBe('2026-09-22');
    // `ownedOnly: false` is what answers the billing question, which is not the same as
    // the ownership one.
    const everything = await sweepClusters({ regions: ['eu-west-1'], ownedOnly: false });
    expect(everything.clusters.map((entry) => [entry.name, entry.ours])).toEqual([
      ['support', true],
      ['theirs', false],
    ]);
    // Named `owned_only`, as earlier releases name it, in the --json envelope and the GUI's job
    // result alike; it was `ownedOnly`.
    expect(
      [mine, everything].map((sweep) => (sweep as unknown as Record<string, unknown>).owned_only),
    ).toEqual([true, false]);
    expect(Object.keys(everything)).not.toContain('ownedOnly');
  });

  it('asks the regions side by side, and still answers in the order they were named', async () => {
    // Seventeen regions, one after another, at up to twenty seconds each, is why `cluster
    // list` took minutes. The calls are independent reads; only the ORDER of the answer
    // must not depend on which region answered first.
    let firstResolved = false;
    let secondAskedBeforeFirstResolved = false;
    seen = [];
    awsCli.run = (argv) => {
      seen.push([...argv]);
      const region = argv[argv.indexOf('--region') + 1];
      const reply = (stdout: string): AwsResult => ({ argv, returncode: 0, stdout, stderr: '' });
      if (argv.includes('list-clusters') && region === 'eu-west-1') {
        return new Promise((resolve) => {
          setTimeout(() => {
            firstResolved = true;
            resolve(reply(JSON.stringify(['slow'])));
          }, 150);
        });
      }
      if (argv.includes('list-clusters') && region === 'us-east-1') {
        if (!firstResolved) secondAskedBeforeFirstResolved = true;
        return Promise.resolve(reply(JSON.stringify(['fast'])));
      }
      return Promise.resolve(reply(''));
    };
    aws.describeCluster = (name, region) =>
      Promise.resolve({
        state: 'present' as const,
        doc: {
          status: 'ACTIVE',
          arn: `arn:aws:eks:${region}:1:cluster/${name}`,
          createdAt: '2026-09-01',
          tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE },
        },
      });
    const out = await sweepClusters({ regions: ['eu-west-1', 'us-east-1'] });
    expect(secondAskedBeforeFirstResolved).toBe(true);
    expect(out.clusters.map((entry) => [entry.name, entry.region])).toEqual([
      ['slow', 'eu-west-1'],
      ['fast', 'us-east-1'],
    ]);
    expect(out.regions).toEqual(['eu-west-1', 'us-east-1']);
  });

  it('says ONE reason when there is no `aws` at all, not twenty-one copies of it', async () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = '';
      const out = await sweepClusters();
      expect(out.unreadable).toHaveLength(1);
      expect(out.unreadable[0]?.region).toBe('(all)');
      expect(out.regions).toEqual([]);
      expect(Object.keys(out)).toEqual([
        'clusters',
        'regions',
        'owned_only',
        'fallback',
        'unreadable',
      ]);
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
  });

  it('falls back to the shipped region list, and says that it did', async () => {
    // `ec2:DescribeRegions` is not in the minimal engineer policy, and the person most
    // likely to be missing it is exactly the person who needs to know what is running. A
    // caller reporting "nothing found" has to be able to say which question it answered.
    script([[has('describe-regions'), { returncode: 254, stderr: 'AccessDenied' }]]);
    const [regions, fallback] = await enabledRegions();
    expect(regions).toEqual([...DEFAULT_REGION_SWEEP]);
    expect(fallback).toBe('AccessDenied');

    script([[has('describe-regions'), json(['us-east-1', 'eu-west-1'])]]);
    expect(await enabledRegions()).toEqual([['eu-west-1', 'us-east-1'], '']);

    // An account that reports NO regions is not an account with no regions.
    script([[has('describe-regions'), json([])]]);
    expect((await enabledRegions())[1]).toBe('the account reported no regions');
  });

  it('reduces a failure to its first useful line', () => {
    expect(oneLine({ argv: [], returncode: 1, stdout: '', stderr: 'first\nsecond' })).toBe('first');
    expect(oneLine({ argv: [], returncode: 1, stdout: 'out', stderr: '' })).toBe('out');
    expect(oneLine({ argv: [], returncode: 3, stdout: '', stderr: '' })).toBe('exit 3');
  });
});

describe('the local pointer, which is not the authority', () => {
  it('survives a lost home without taking ownership with it', async () => {
    // CLAUDE.md tells anyone writing a script to `export HOUSTON_HOME=$(mktemp -d)`, so a
    // local ownership record is one followed instruction away from leaving a billable
    // cluster houston can no longer prove is its own. Losing this costs a reminder.
    await remember('remembered-one', {
      region: 'eu-west-1',
      account: '1234',
      expires: '2026-09-22',
    });
    const pointer = remembered().find((entry) => entry.name === 'remembered-one');
    expect(pointer).toMatchObject({
      name: 'remembered-one',
      region: 'eu-west-1',
      account: '1234',
      provider: 'eks',
      expires: '2026-09-22',
    });
    expect(String(pointer?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  it('reads the older flat layout too, or a cluster vanishes from the warning', async () => {
    // A box that created a cluster before the directory layout arrived must not have it
    // disappear from `doctor`'s warning -- the whole point of that warning is a cluster
    // nobody is thinking about any more.
    const root = path.join(config.home(), 'clusters');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'flat-old.json'),
      JSON.stringify({ name: 'flat-old' }),
      'utf8',
    );
    await remember('nested-new', { region: 'eu-west-1', account: '1234' });
    const names = remembered().map((entry) => entry.name);
    expect(names).toContain('flat-old');
    expect(names).toContain('nested-new');
    // And a file that is not a pointer at all is skipped rather than crashing the read.
    fs.writeFileSync(path.join(root, 'junk.json'), 'not json', 'utf8');
    expect(remembered().map((entry) => entry.name)).toContain('flat-old');
  });

  it('keeps the manifests after a delete, and takes the kubeconfig', async () => {
    // What was built, and how, is worth more after the fact than during. A kubeconfig is
    // the opposite: it is the only file here that stops being TRUE the moment the cluster
    // goes, and the only one somebody might try to USE -- against an endpoint that no
    // longer exists.
    await remember('gone', { region: 'eu-west-1', account: '1234' });
    await keepManifest('gone', 'cluster.yaml', 'kind: ClusterConfig\n');
    fs.writeFileSync(path.join(config.home(), 'clusters', 'gone', 'kubeconfig'), 'x', 'utf8');
    expect(remembered().map((entry) => entry.name)).toContain('gone');

    forget('gone');
    const directory = path.join(config.home(), 'clusters', 'gone');
    expect(fs.existsSync(path.join(directory, 'cluster.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'kubeconfig'))).toBe(false);
    // The POINTER is what `doctor` warns from, so it has to go or the warning outlives
    // the cluster.
    expect(remembered().map((entry) => entry.name)).not.toContain('gone');
  });

  it('writes a manifest even for something that failed, and never raises', async () => {
    // A create that died half way is exactly when somebody needs to read what was
    // submitted.
    const kept = await keepManifest('support', 'cluster.yaml', 'kind: ClusterConfig\n');
    expect(kept).not.toBeNull();
    expect(fs.readFileSync(String(kept), 'utf8')).toBe('kind: ClusterConfig\n');
    // An unwritable location answers null rather than throwing.
    expect(await keepManifest('a\0b', 'x.yaml', 'y')).toBeNull();
  });
});

describe('the twenty minutes nothing can verify', () => {
  it('reports each line as it arrives, stripped of eksctl’s own timestamp', async () => {
    // `cluster create` printed one line and then went silent for the entire build, which
    // is indistinguishable from a hang -- and the only safe assumption, kill it, is the
    // one that leaves a half-built VPC behind.
    awsCli.stream = (argv, options) => {
      options.onLine('2026-09-15 10:00:00 [ℹ]  building cluster stack');
      options.onLine('');
      options.onLine('plain line with no prefix');
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    const events: Event[] = [];
    expect(
      await streamTool(['eksctl', 'create'], {
        phase: 'provision',
        emit: (event) => events.push(event),
        timeout: 10,
      }),
    ).toBe(0);
    expect(events.map((event) => event.message)).toEqual([
      'building cluster stack',
      'plain line with no prefix',
    ]);
  });

  it('reads a percentage out of the phases eksctl announces, and never goes backwards', async () => {
    // Twenty minutes of raw lines with no sense of how far along they are: the GUI drew a
    // modal of text and the CLI a scroll. eksctl's own phase announcements are stable
    // enough to place on a bar.
    expect(eksctlProgress('building cluster stack "eksctl-support-cluster"')).toBe(5);
    expect(eksctlProgress('waiting for CloudFormation stack "eksctl-support-cluster"')).toBe(10);
    // Printed AFTER the node group on a real build, so it moves nothing.
    expect(eksctlProgress('waiting for the control plane to become ready')).toBeNull();
    expect(eksctlProgress('building managed nodegroup stack "eksctl-support-nodegroup-ng"')).toBe(
      65,
    );
    expect(eksctlProgress('creating addon: vpc-cni')).toBe(55);
    expect(eksctlProgress('creating addon: aws-ebs-csi-driver')).toBe(85);
    expect(eksctlProgress('EKS cluster "support" in "us-east-1" region is ready')).toBe(90);
    expect(eksctlProgress('checking security group configuration for all nodegroups')).toBeNull();
    awsCli.stream = (argv, options) => {
      options.onLine('[ℹ]  building cluster stack "eksctl-support-cluster"');
      options.onLine('[ℹ]  waiting for CloudFormation stack "eksctl-support-cluster"');
      options.onLine('[ℹ]  building managed nodegroup stack "eksctl-support-nodegroup-ng"');
      options.onLine('[ℹ]  waiting for CloudFormation stack "eksctl-support-cluster"');
      options.onLine('[ℹ]  checking security group configuration for all nodegroups');
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    const events: Event[] = [];
    await streamTool(['eksctl', 'create'], {
      phase: 'provision',
      emit: (event) => events.push(event),
      timeout: 10,
      progress: eksctlProgress,
    });
    expect(events.map((event) => event.pct)).toEqual([5, 10, 65, 65, 65]);
  });

  it('reads nothing from the plan eksctl opens with, only from what it does', () => {
    // A real build (us-east-1, 2026-10-05), its lines in the order eksctl printed them. The
    // plan and the task tree matched the patterns, so the bar stood at 85% from the first
    // minute of twenty-five; it may not pass 10% until the control plane is up.
    const real = [
      'nodegroup "n-ng" will use "" [AmazonLinux2023/1.33]',
      'creating EKS cluster "n" in "us-east-1" region with managed nodes',
      'will create a CloudFormation stack for cluster itself and 1 managed nodegroup stack(s)',
      'Kubernetes API endpoint access will use default of {publicAccess=true, privateAccess=false} for cluster "n" in "us-east-1"',
      'default addons vpc-cni, kube-proxy, coredns, metrics-server were not specified, will install them as EKS addons',
      '2 sequential tasks: { create cluster control plane "n",',
      '1 task: { create addons },',
      'wait for control plane to become ready,',
      'create managed nodegroup "n-ng",',
      'building cluster stack "eksctl-n-cluster"',
      'deploying stack "eksctl-n-cluster"',
      'waiting for CloudFormation stack "eksctl-n-cluster"',
      'creating addon: vpc-cni',
      'addon "vpc-cni" active',
      'building managed nodegroup stack "eksctl-n-nodegroup-n-ng"',
      'waiting for CloudFormation stack "eksctl-n-nodegroup-n-ng"',
      'waiting for the control plane to become ready',
      'node "ip-10-0-65-80.ec2.internal" is ready',
      'created 1 managed nodegroup(s) in cluster "n"',
      'creating addon: aws-ebs-csi-driver',
      'creating addon: metrics-server',
      'EKS cluster "n" in "us-east-1" region is ready',
    ];
    let best = 0;
    const bar = real.map((line) => {
      const read = eksctlProgress(line);
      if (read !== null && read > best) best = read;
      return best;
    });
    const upTo = (line: string): number => bar[real.indexOf(line)] ?? -1;
    expect(upTo('create managed nodegroup "n-ng",')).toBe(0);
    expect(upTo('waiting for CloudFormation stack "eksctl-n-cluster"')).toBe(10);
    expect(upTo('waiting for CloudFormation stack "eksctl-n-nodegroup-n-ng"')).toBe(65);
    expect(bar.at(-1)).toBe(90);
  });

  it('repeats the last few lines on a failure, because they are the reason', async () => {
    awsCli.stream = (argv, options) => {
      for (let index = 0; index < 10; index += 1) options.onLine(`line ${String(index)}`);
      return Promise.resolve({ argv, returncode: 1, stdout: '', stderr: '' });
    };
    const events: Event[] = [];
    expect(
      await streamTool(['eksctl', 'create'], {
        phase: 'provision',
        emit: (event) => events.push(event),
        timeout: 10,
      }),
    ).toBe(1);
    const warned = events.filter((event) => event.level === 'warn').map((event) => event.message);
    expect(warned).toEqual(['line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
  });

  it('says a tool could not be started, rather than reporting an empty failure', async () => {
    awsCli.stream = (argv) =>
      Promise.resolve({ argv, returncode: 127, stdout: '', stderr: 'spawn eksctl ENOENT' });
    const events: Event[] = [];
    expect(
      await streamTool(['eksctl', 'create'], {
        phase: 'provision',
        emit: (event) => events.push(event),
        timeout: 10,
      }),
    ).toBe(127);
    expect(events.map((event) => event.message).join(' ')).toContain('could not be started');
  });
});

describe('the journal note that outlives the process', () => {
  it('is written BEFORE eksctl runs, and cleared only once it returns', async () => {
    // A note written afterwards describes nothing: the whole case it exists for is the
    // process not getting there.
    const order: string[] = [];
    const sink: JournalSink = {
      record: (kind, workspace) => {
        order.push(`record:${kind}:${workspace}`);
        return 'entry-1';
      },
      clear: (id) => order.push(`clear:${id}`),
      registerSubjectPredicate: () => undefined,
    };
    const remove = installJournalSink(sink);
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    aws.prepareCluster = () => Promise.resolve({} as never);
    awsCli.stream = (argv) => {
      order.push('eksctl');
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    try {
      await aws.createCluster('support', { region: 'eu-west-1' });
      expect(order).toEqual([`record:${CLUSTER_UNFINISHED}:support`, 'eksctl', 'clear:entry-1']);
    } finally {
      remove();
    }
  });

  it('LEAVES the note when eksctl fails, because a partial create can still bill', async () => {
    const order: string[] = [];
    const remove = installJournalSink({
      record: () => {
        order.push('record');
        return 'entry-1';
      },
      clear: () => order.push('clear'),
      registerSubjectPredicate: () => undefined,
    });
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    awsCli.stream = (argv) => Promise.resolve({ argv, returncode: 1, stdout: '', stderr: '' });
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    try {
      await expect(aws.createCluster('support', { region: 'eu-west-1' })).rejects.toThrow(
        /can still be billing/u,
      );
      // AND HOW TO STOP THE BILL, in the message itself: the guide sent the reader to a
      // raw eksctl; the managed-by tag is in the config eksctl was handed, so houston's own
      // delete proves ownership and works on a half-built cluster.
      await expect(aws.createCluster('support', { region: 'eu-west-1' })).rejects.toThrow(
        /houston cluster delete support --region eu-west-1/u,
      );
      expect(order).toEqual(['record', 'record']);
    } finally {
      remove();
    }
  });
});

describe('creating, which spends money', () => {
  beforeEach(() => {
    aws.preflight = () => Promise.resolve(READY);
    script([]);
  });

  it('GATES an account nobody approved, and --force cannot reach it', async () => {
    // Force is a reflex people develop, and this is a decision about somebody's bill.
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    let gate: unknown;
    try {
      await aws.createCluster('support', { region: 'eu-west-1' });
    } catch (error) {
      gate = error;
    }
    expect(gate).toBeInstanceOf(AuthorityGateError);
    expect((gate as { code?: string }).code).toBe('GATE_CLOUD_SPEND');
    // The remedy names the account, so approving is a deliberate act about a known one.
    expect((gate as { approveWith?: string }).approveWith).toContain('111122223333');
  });

  it('refuses a second cluster over one it could not check for', async () => {
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    aws.describeCluster = () => Promise.resolve({ state: 'refused' as const, doc: null });
    await expect(aws.createCluster('support', { region: 'eu-west-1' })).rejects.toThrow(
      /Refusing rather than risking a second cluster/u,
    );
    aws.describeCluster = () =>
      Promise.resolve({ state: 'present' as const, doc: { arn: 'arn:x' } });
    await expect(aws.createCluster('support', { region: 'eu-west-1' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('what a fresh EKS cluster does not have', () => {
  it('declares a default gp3 class on the CSI driver, waiting for its consumer', () => {
    // MEASURED on EKS 1.33: the cluster ships exactly one class, `gp2`, on the deprecated
    // in-tree provisioner -- so nothing references `ebs.csi.aws.com`, no class is default,
    // and every PVC stays Pending while Rocket.Chat never starts.
    const doc = YAML.parse(STORAGE_CLASS) as {
      metadata: { name: string; annotations: Record<string, string> };
      provisioner: string;
      volumeBindingMode: string;
    };
    expect(doc.metadata.name).toBe('gp3');
    expect(doc.metadata.annotations['storageclass.kubernetes.io/is-default-class']).toBe('true');
    expect(doc.provisioner).toBe('ebs.csi.aws.com');
    // Binding immediately puts an EBS volume in one zone and then lets the scheduler put
    // the pod in another, which fails in a way that reads as a scheduling problem.
    expect(doc.volumeBindingMode).toBe('WaitForFirstConsumer');
  });
});

describe('the documents somebody has to approve', () => {
  it('ships them rather than describing them, verbatim', () => {
    // A policy that lives in a design note is a policy somebody retypes, and a retyped
    // policy is one of these two actions short.
    const operator = iamDocument('operator');
    expect(JSON.parse(operator)).toHaveProperty('Statement');
    expect(operator).toContain('ec2:RunInstances');
    expect(operator).toContain('cloudformation:UpdateTerminationProtection');
    expect(iamDocument('rbac')).toContain('kind:');
    expect(Object.keys(IAM_DOCUMENTS).sort()).toEqual(['engineer', 'operator', 'rbac']);
  });

  it('names what it wants instead of guessing', () => {
    expect(() => iamDocument('nonsense')).toThrow(/unknown permissions document/u);
    expect(() => iamDocument('nonsense')).toThrow(/engineer \| operator \| rbac/u);
  });

  it('reads the SAME shipped files earlier releases read', () => {
    // One copy on disk, so what this build hands out cannot drift from the shipped text
    // that is pasted into `aws iam create-policy` and `kubectl apply`.
    const shipped = fs.readFileSync(
      path.join(__dirname, '..', '..', 'data', 'iam', 'operator-policy.json'),
      'utf8',
    );
    expect(iamDocument('operator')).toBe(shipped);
    expect(guide()).toBe(
      fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'docs', 'eks.md'), 'utf8'),
    );
  });
});

describe('the shape it claims to share with the reference', () => {
  it('copies what carries fidelity, and diverges only on the node count', () => {
    // Launchpad decides what an EKS cluster must PROVIDE: a managed node group rather than
    // Auto Mode, Kubernetes 1.37, t3.large. Node COUNT does not decide fidelity -- a repro
    // carries one workspace -- so that is the one deliberate divergence, and overridable.
    const doc = clusterConfig('rc-support', { region: 'us-east-1' }) as {
      metadata: { version: string };
      managedNodeGroups: { instanceType: string; desiredCapacity: number }[];
    };
    expect(doc.metadata.version).toBe('1.37');
    expect(doc.managedNodeGroups[0]?.instanceType).toBe('t3.large');
    expect('autoModeConfig' in doc).toBe(false);
    expect(DEFAULT_NODES).toBe(3);
    expect(doc.managedNodeGroups[0]?.desiredCapacity).toBe(3);
    const five = clusterConfig('x', { region: 'us-east-1', nodes: 5 }) as {
      managedNodeGroups: { desiredCapacity: number }[];
    };
    expect(five.managedNodeGroups[0]?.desiredCapacity).toBe(5);
    // Naming subnets means NOT making a VPC.
    const named = clusterConfig('s', { region: 'r', subnets: { a: 'subnet-a' } }) as {
      vpc: Record<string, unknown>;
    };
    expect('cidr' in named.vpc).toBe(false);
  });
});

describe('more than one cloud cluster', () => {
  it('is two pointers under two names, and forgetting one leaves the other', async () => {
    // "One owned cloud cluster per home" was written down as a non-goal, and nothing
    // enforces it: a second name is simply a second pointer, and doctor warns about both.
    await remember('support-a', { region: 'us-east-1', account: '1' });
    await remember('support-b', { region: 'eu-west-1', account: '1' });
    const mine = () =>
      remembered()
        .map((entry) => String(entry.name))
        .filter((name) => name.startsWith('support-'))
        .sort();
    expect(mine()).toEqual(['support-a', 'support-b']);
    expect(
      new Set(
        remembered()
          .filter((entry) => String(entry.name).startsWith('support-'))
          .map((entry) => entry.region),
      ),
    ).toEqual(new Set(['us-east-1', 'eu-west-1']));
    forget('support-a');
    expect(mine()).toEqual(['support-b']);
    forget('support-b');
  });

  it('forgets a pointer written in the older flat layout too', () => {
    const root = path.join(config.home(), 'clusters');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'legacy-flat.json'),
      JSON.stringify({ name: 'legacy-flat', region: 'eu-west-1', account: '1', provider: 'eks' }),
      'utf8',
    );
    expect(remembered().map((entry) => entry.name)).toContain('legacy-flat');
    forget('legacy-flat');
    expect(remembered().map((entry) => entry.name)).not.toContain('legacy-flat');
  });
});

describe('who AWS says you are, with no aws at all', () => {
  it('is a tool problem, not a credentials one', async () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = '';
      const who = await whoami();
      expect(who.account).toBe('');
      expect(who.error).toContain('not installed');
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
  });
});

describe('an approved account', () => {
  const realStreamTool = aws.streamTool;
  afterEach(() => {
    aws.streamTool = realStreamTool;
    config.updateConfig((cfg) => {
      delete cfg[config.KUBE_CONTEXT_KEY];
    });
    forget('support');
  });

  it('leaves the current kubectl context where it found it', async () => {
    // `aws eks update-kubeconfig` switches the merged kubeconfig's current context to the
    // new cluster. A person whose bare kubectl pointed at production then found it pointing
    // at ours, or the reverse, and the guide told everyone to pin KUBECONFIG by hand.
    aws.preflight = () => Promise.resolve(READY);
    let made = false;
    aws.describeCluster = () =>
      Promise.resolve(
        made
          ? {
              state: 'present' as const,
              doc: { arn: 'arn:aws:eks:eu-west-1:111122223333:cluster/support', tags: {} },
            }
          : { state: 'absent' as const, doc: null },
      );
    aws.prepareCluster = () => Promise.resolve({} as never);
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    // eksctl writes its OWN context and makes it current, as a real build does
    // (`saved kubeconfig as ...`). Read after it, "the previous context" was eksctl's.
    let current = 'prod-cluster';
    aws.streamTool = () => {
      made = true;
      current = 'iam-root-account@support.eu-west-1.eksctl.io';
      return Promise.resolve(0);
    };
    kube.run = (argv) => {
      if (argv.includes('use-context')) current = argv.at(-1) ?? '';
      if (argv.includes('unset')) current = '';
      if (argv.includes('current-context') && !argv.includes('unset'))
        return Promise.resolve(
          current === ''
            ? { argv, returncode: 1, stdout: '', stderr: 'error: current-context is not set' }
            : { argv, returncode: 0, stdout: `${current}\n`, stderr: '' },
        );
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    await aws.createCluster('support', { region: 'eu-west-1' });
    expect(current).toBe('prod-cluster');
  });

  it('leaves no current context when there was none before the build', async () => {
    aws.preflight = () => Promise.resolve(READY);
    let made = false;
    aws.describeCluster = () =>
      Promise.resolve(
        made
          ? {
              state: 'present' as const,
              doc: { arn: 'arn:aws:eks:eu-west-1:111122223333:cluster/support', tags: {} },
            }
          : { state: 'absent' as const, doc: null },
      );
    aws.prepareCluster = () => Promise.resolve({} as never);
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    // None before, and eksctl makes its own current: a bare kubectl that pointed nowhere
    // pointed at the billing cluster afterwards (measured on a real build, 2026-10-05).
    let current = '';
    aws.streamTool = () => {
      made = true;
      current = 'iam-root-account@support.eu-west-1.eksctl.io';
      return Promise.resolve(0);
    };
    kube.run = (argv) => {
      if (argv.includes('use-context')) current = argv.at(-1) ?? '';
      if (argv.includes('unset')) current = '';
      if (argv.includes('current-context') && !argv.includes('unset'))
        return Promise.resolve(
          current === ''
            ? { argv, returncode: 1, stdout: '', stderr: 'error: current-context is not set' }
            : { argv, returncode: 0, stdout: `${current}\n`, stderr: '' },
        );
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    await aws.createCluster('support', { region: 'eu-west-1' });
    expect(current).toBe('');
  });

  it('builds with the zone in the tags and keeps it in the note', async () => {
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    aws.prepareCluster = () => Promise.resolve({} as never);
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    let handed = '';
    aws.streamTool = (argv) => {
      handed = fs.readFileSync(argv[argv.indexOf('-f') + 1] as string, 'utf8');
      return Promise.resolve(0);
    };
    await aws.createCluster('support', { region: 'eu-west-1', zone: 'rc.example.com' });
    expect(
      (YAML.parse(handed) as { metadata: { tags: Record<string, string> } }).metadata.tags[
        ZONE_TAG_KEY
      ],
    ).toBe('rc.example.com');
    expect(zoneOf('support')).toBe('rc.example.com');
  });

  it('rememberZone writes the note and tags the cluster', async () => {
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: { arn: 'arn:aws:eks:eu-west-1:111122223333:cluster/support', tags: {} },
      });
    script([]);
    await rememberZone('support', 'eu-west-1', 'rc.example.com');
    expect(zoneOf('support')).toBe('rc.example.com');
    expect(seen).toContainEqual([
      'aws',
      'eks',
      'tag-resource',
      '--resource-arn',
      'arn:aws:eks:eu-west-1:111122223333:cluster/support',
      '--tags',
      'houston.io/zone=rc.example.com',
    ]);
  });

  it('hands eksctl the progress reader when it builds a cluster', async () => {
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    aws.prepareCluster = () => Promise.resolve({} as never);
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    let reader: ((line: string) => number | null) | undefined;
    aws.streamTool = (_argv, options) => {
      reader = (options as { progress?: (line: string) => number | null }).progress;
      return Promise.resolve(0);
    };
    await aws.createCluster('support', { region: 'eu-west-1' });
    expect(reader).toBeDefined();
    expect(reader?.('building cluster stack')).toBe(5);
  });

  it('reaches eksctl with the document and a timeout built for twenty minutes', async () => {
    // The expensive path's only unverifiable step, so everything up to the child process is
    // pinned here: what is run, under what deadline, and with what document.
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    aws.prepareCluster = () => Promise.resolve({} as never);
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    const seen: { argv: string[]; timeout: number; doc: Record<string, unknown> }[] = [];
    aws.streamTool = (argv, options) => {
      const file = argv[argv.indexOf('-f') + 1] as string;
      seen.push({
        argv: [...argv],
        timeout: options.timeout,
        doc: YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>,
      });
      return Promise.resolve(0);
    };
    await aws.createCluster('support', { region: 'eu-west-1', nodes: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv.slice(0, 4)).toEqual(['eksctl', 'create', 'cluster', '-f']);
    expect(seen[0]?.timeout).toBe(CLUSTER_CREATE_TIMEOUT);
    expect(CLUSTER_CREATE_TIMEOUT).toBeGreaterThan(900);
    const doc = seen[0]?.doc as { metadata: { tags: Record<string, string> }; vpc: unknown };
    // Tagged AT creation; a later tagging step has a window that crashes inside.
    expect(doc.metadata.tags[OWNED_TAG_KEY]).toBe(OWNED_TAG_VALUE);
    expect(EXPIRY_TAG_KEY in doc.metadata.tags).toBe(true);
    expect(doc.vpc).toEqual({ cidr: DEFAULT_VPC_CIDR });
    expect(remembered().find((entry) => entry.name === 'support')?.account).toBe('111122223333');
  });

  it('keeps the document it hands eksctl as earlier releases wrote it', async () => {
    // A kept file the user is told to read: the `yaml` package double-quoted what earlier
    // releases single-quote, so the same document was different bytes. Held to the bytes
    // earlier releases wrote for the same document, recorded, key order and all; only the
    // expiry date is today's.
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
    aws.prepareCluster = () => Promise.resolve({} as never);
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    let text = '';
    aws.streamTool = (argv) => {
      text = fs.readFileSync(argv[argv.indexOf('-f') + 1] as string, 'utf8');
      return Promise.resolve(0);
    };
    await aws.createCluster('support', {
      region: 'eu-west-1',
      subnets: { 'eu-west-1b': 'subnet-0b', 'eu-west-1a': 'subnet-0a' },
      expiresDays: 7,
    });
    const recorded = [
      'apiVersion: eksctl.io/v1alpha5',
      'kind: ClusterConfig',
      'metadata:',
      '  name: support',
      '  region: eu-west-1',
      "  version: '1.37'",
      '  tags:',
      '    houston.io/managed-by: houston',
      `    houston.io/expires: '${expiryDate(7)}'`,
      'managedNodeGroups:',
      '- name: support-ng',
      '  instanceType: t3.large',
      '  desiredCapacity: 3',
      '  privateNetworking: true',
      '  iam:',
      '    withAddonPolicies:',
      '      ebs: true',
      'addons:',
      '- name: aws-ebs-csi-driver',
      '  version: 1.66.0',
      'iam:',
      '  withOIDC: true',
      'vpc:',
      '  subnets:',
      '    private:',
      '      eu-west-1a:',
      '        id: subnet-0a',
      '      eu-west-1b:',
      '        id: subnet-0b',
      '',
    ].join('\n');
    expect(text).toBe(recorded);
    expect(text).toContain("  version: '1.37'\n");
  });

  it('makes the cluster it built the default, and its delete takes that back', async () => {
    // houston has just built it and knows its ARN; making somebody paste an ARN into every
    // later command is ceremony. And a default left pointing at a deleted cluster makes
    // the next `up` fail on a context that cannot be found.
    const arn = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';
    expect(config.defaultKubeContext()).toBe('');
    let made = false;
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () =>
      Promise.resolve(
        made
          ? {
              state: 'present' as const,
              doc: { arn, tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE } },
            }
          : { state: 'absent' as const, doc: null },
      );
    aws.prepareCluster = () => Promise.resolve({} as never);
    script([]);
    mocked(config.approvedAwsAccounts).mockReturnValue(new Set(['111122223333']));
    aws.streamTool = () => {
      made = true;
      return Promise.resolve(0);
    };
    const said: string[] = [];
    const emit = (event: Event): void => void said.push(event.message);
    await aws.createCluster('support', { region: 'eu-west-1', emit });
    expect(config.defaultKubeContext()).toBe(arn);
    // The delete now releases the load balancer Services through kubectl first.
    kube.run = (argv) =>
      Promise.resolve({ argv, returncode: 0, stdout: '{"items":[]}', stderr: '' });
    await deleteCluster('support', { region: 'eu-west-1', force: true, emit });
    expect(config.defaultKubeContext()).toBe('');
    // Announced in the words earlier releases used, an ASCII apostrophe in each: an earlier
    // version had a typographic one in both.
    // A plain `up` never leaves Docker (lifecycle/request.ts inferRuntime); the earlier
    // wording said it would, and people ran `up` expecting the cluster.
    expect(said).toContain(
      "set as this box's default cluster — `houston up --runtime kubernetes` lands here " +
        'without --context; a plain `up` still makes a Docker workspace (change with ' +
        '`houston config set kubernetes.context <name>`)',
    );
    expect(said.join('\n')).not.toContain('`up` goes here without --context');
    expect(said).toContain("cleared this box's default cluster — it was the one just deleted");
  });
});

describe('the sweep, with no region named', () => {
  it('asks the account for its regions and finds a cluster in one nobody named', async () => {
    // MEASURED: a cluster sat in eu-west-1 for 16.8 hours and $2.47 while that day's checks
    // swept only us-east-1. And a region that could not be asked is not an empty one.
    script([
      [has('describe-regions'), json(['us-east-1', 'eu-west-1', 'ap-south-1'])],
      [has('list-clusters', 'eu-west-1'), json(['support'])],
      [
        has('list-clusters', 'ap-south-1'),
        { returncode: 255, stderr: 'AccessDeniedException: no' },
      ],
      [has('list-clusters'), json([])],
    ]);
    aws.describeCluster = (name, where) =>
      Promise.resolve({
        state: 'present' as const,
        doc: {
          status: 'ACTIVE',
          arn: `arn:aws:eks:${where}:1:cluster/${name}`,
          createdAt: '2026-09-01T11:03:00Z',
          tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE, [EXPIRY_TAG_KEY]: '2026-09-08' },
        },
      });
    const found = await sweepClusters();
    expect(found.clusters.map((entry) => [entry.region, entry.name])).toEqual([
      ['eu-west-1', 'support'],
    ]);
    expect(found.clusters[0]?.expires).toBe('2026-09-08');
    expect(found.unreadable.map((entry) => entry.region)).toEqual(['ap-south-1']);
    expect(found.unreadable[0]?.why).toContain('AccessDenied');
  });
});

describe('the engineer RBAC', () => {
  it('grants the cluster-scoped things AWS’s own policy omits, and reads everything else', () => {
    // `AmazonEKSAdminPolicy` stops at the namespace, and a namespace per workspace is the
    // model: MEASURED, `up` failed on StorageClasses and then on creating the namespace.
    const docs = YAML.parseAllDocuments(iamDocument('rbac'))
      .map((doc) => doc.toJSON() as Record<string, unknown> | null)
      .filter((doc): doc is Record<string, unknown> => doc !== null);
    const role = docs.find((doc) => doc.kind === 'ClusterRole') as {
      rules: { resources: string[]; verbs: string[] }[];
    };
    const binding = docs.find((doc) => doc.kind === 'ClusterRoleBinding') as {
      subjects: { name: string }[];
    };
    const verbs = (resource: string): Set<string> =>
      new Set(
        role.rules.filter((rule) => rule.resources.includes(resource)).flatMap((r) => r.verbs),
      );
    expect(verbs('namespaces').has('create')).toBe(true);
    expect(verbs('namespaces').has('delete')).toBe(true);
    expect(verbs('storageclasses').has('list')).toBe(true);
    for (const rule of role.rules) {
      if (rule.resources.includes('namespaces')) continue;
      for (const verb of rule.verbs) expect(['get', 'list', 'watch']).toContain(verb);
    }
    expect(binding.subjects[0]?.name).toBe('houston-engineers');
  });
});

describe('the README', () => {
  it('points at the EKS guide that actually exists, and at the command that prints it', () => {
    const root = path.join(__dirname, '..', '..');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('data/docs/eks.md');
    expect(fs.statSync(path.join(root, 'data', 'docs', 'eks.md')).isFile()).toBe(true);
    expect(readme).toContain('houston cluster guide');
  });
});

describe('after a delete that went through', () => {
  it('clears the kubeconfig entries naming the cluster, after it is gone and never before', async () => {
    // `aws eks update-kubeconfig` and `eksctl` each wrote a context naming it and neither
    // removes one, so a deleted cluster went on being listed for ever. After, never
    // before: a delete that fails leaves the operator able to reach what they were deleting.
    const arn = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';
    aws.preflight = () => Promise.resolve(READY);
    aws.describeCluster = () =>
      Promise.resolve({
        state: 'present' as const,
        doc: { arn, tags: { [OWNED_TAG_KEY]: OWNED_TAG_VALUE } },
      });
    script([]);
    const order: string[] = [];
    let listed = [arn, 'alice@support.eu-west-1.eksctl.io', 'kind-houston-local'];
    kube.run = (argv) => {
      order.push(argv.slice(0, 3).join(' '));
      if (argv.includes('get-contexts')) {
        return Promise.resolve({ argv, returncode: 0, stdout: listed.join('\n'), stderr: '' });
      }
      if (argv.includes('delete-context')) {
        listed = listed.filter((one) => one !== argv[3]);
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    awsCli.stream = (argv) => {
      order.push(argv.slice(0, 3).join(' '));
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    expect(await deleteCluster('support', { region: 'eu-west-1', force: true })).toBe(true);
    const gone = order.indexOf('eksctl delete cluster');
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(order.slice(0, gone).some((one) => one.startsWith('kubectl config'))).toBe(false);
    expect(order.slice(gone + 1)).toContain('kubectl config delete-context');
    expect(listed).toEqual(['kind-houston-local']);
  });
});
