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
import { AuthorityGateError, ConflictError, PreflightError } from '../../src/lib/errors';
import type { Event } from '../../src/lib/events';
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
  aws.prepareCluster = realPrepare;
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
    expect(doc.addons).toEqual([{ name: 'aws-ebs-csi-driver', version: '1.47.0' }]);
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
    expect(parsed.metadata.version).toBe('1.33');
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
      expect(order).toEqual(['record']);
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
    // Auto Mode, Kubernetes 1.33, t3.large. Node COUNT does not decide fidelity -- a repro
    // carries one workspace -- so that is the one deliberate divergence, and overridable.
    const doc = clusterConfig('rc-support', { region: 'us-east-1' }) as {
      metadata: { version: string };
      managedNodeGroups: { instanceType: string; desiredCapacity: number }[];
    };
    expect(doc.metadata.version).toBe('1.33');
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
      "  version: '1.33'",
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
      '  version: 1.47.0',
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
    expect(text).toContain("  version: '1.33'\n");
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
    await deleteCluster('support', { region: 'eu-west-1', force: true, emit });
    expect(config.defaultKubeContext()).toBe('');
    // Announced in the words earlier releases used, an ASCII apostrophe in each: an earlier
    // version had a typographic one in both.
    expect(said).toContain(
      "set as this box's default cluster — `up` goes here without --context now (change " +
        'with `houston config set kubernetes.context <name>`)',
    );
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
