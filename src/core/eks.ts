/**
 * The AWS seam's domain half. Everything that speaks to AWS rather than to a cluster.
 *
 * `core/kube` stays the only Kubernetes seam: this module asks AWS who you are and, later,
 * asks `eksctl` to build a cluster, and everything that talks to a cluster once it exists
 * goes through `core/kube` unchanged. The same relationship `runner` has with Docker and
 * `rcapi` has with Rocket.Chat.
 *
 * **Credentials are never houston's to hold.** Being logged in to AWS is a PREREQUISITE,
 * exactly as having Docker running is: the operator arranges it with `aws configure`,
 * SSO, an instance profile or environment variables, and houston reads the ambient result
 * and names what it found. Nothing here stores, prompts for, refreshes or writes a
 * credential. That is also what makes an adopted EKS cluster work at all -- `aws eks
 * update-kubeconfig` writes a kubeconfig whose user runs `aws eks get-token`, so kubectl
 * itself needs those same ambient credentials, and the kube seam passes the environment
 * through untouched for any cluster houston does not own.
 *
 * **The identity is reported, not just checked.** A refusal that says "not logged in" is
 * half an answer; a confirmation that says "ready" is worse. `cluster support` exists in
 * more than one AWS account, and the whole failure mode of this feature is acting on the
 * wrong one -- so the account id and the caller ARN are carried on every answer and
 * belong in every message that follows.
 *
 * ## NOTHING CAN CHECK THIS MODULE AT ANY REASONABLE PRICE
 *
 * That is the reason for how the module is shaped rather than a warning attached to it.
 * No test can validate `eksctl create cluster` without spending twenty minutes and real
 * money, so this module draws the line where it was always drawn: every DECISION is
 * pure and testable -- the config document, the ownership rule, the blocker list, the
 * expiry arithmetic, the sweep's bookkeeping -- and what is left unverifiable is the
 * invocation itself. The ownership rule is asserted directly, because a delete authorised
 * by a read that failed is the one thing that must never happen here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import {
  AuthorityGateError,
  ConflictError,
  CreateFailedError,
  DockerError,
  PreflightError,
} from '../lib/errors';
import { info, nullEmit, warn, type Emit, type EmittedPhase } from '../lib/events';
import { joinPath } from '../lib/home';
import {
  CLUSTER_UNFINISHED,
  clearJournal,
  recordJournal,
  registerSubjectPredicate,
  type JournalEntry,
} from '../lib/journal';
import { mkdirParents } from '../lib/mkdir-parents';
import { makeTempDir } from '../lib/tempdir';
import { safeDump } from '../lib/yaml-dump';
import { awsCli, type AwsResult } from '../seams/aws-cli';

import { ABSENT, PRESENT, REFUSED, answer, why, type Answer } from './kube/ask';
import { storageClasses, workspaceNamespaces } from './kube/capabilities';
import { ensureCertManager } from './kube/certmanager';
import { assertContextKnown, contexts, forgetContext } from './kube/context';
import { loadbalancerState, waitForLoadbalancer } from './kube/endpoints';
import { userEnv } from './kube/exec';
import { ensureIngress } from './kube/ingress';
import { tools as allTools, tuning } from './kube/names';
import { namespaceOwner } from './kube/namespace';
import { reach, reachAdvice, reachOk, reachWhy } from './kube/reachability';
import { apply } from './kube/release';
import { newEnough, pretty, tool, toolPresent, which, type Tool } from './kube/tools';
import { atomicWrite } from './runner/paths';
import { updateConfig as updateLockedConfig } from './runner/locks';

export { GUIDE_FILE, IAM_DOCUMENTS, guide, guidePath, iamDocument } from './eks-docs';

/**
 * What talking to AWS needs, and it is not the same question as what BUILDING a cluster
 * needs. `aws` alone is enough to authenticate against an EKS cluster somebody else made
 * -- that is the exec credential plugin in the kubeconfig -- while `eksctl` is only ever
 * needed to create or destroy one. Kept apart so a box set up to USE an EKS cluster is
 * never told it is missing a provisioning tool it will never run.
 */
export const IDENTITY_TOOL = 'aws';

/**
 * Seconds. An `sts` call is one round trip to a public endpoint; a box with no route to
 * it should answer "I could not ask" quickly rather than hang a `doctor`.
 */
export const IDENTITY_TIMEOUT = 15;

const asMs = (seconds: number) => Math.round(seconds * 1000);

/** A refused AWS read keeps the only record of a possibly billable cluster. */
async function clusterStillThere(entry: JournalEntry): Promise<boolean> {
  const seen = await clusterExists(entry.workspace, String(entry.detail.region ?? ''));
  return seen.state !== ABSENT;
}

/**
 * Teach recovery how to ask whether an unfinished cluster is still there.
 *
 * At module scope, so it is registered as soon as the module loads, and queued by the
 * registry until the real journal is installed.
 */
registerSubjectPredicate(CLUSTER_UNFINISHED, clusterStillThere);

/**
 * Who AWS says you are, or why it could not say.
 *
 * Three states, not two, for the reason `Answer` gives: "there are no credentials" and "I
 * could not find out whether there are credentials" are different facts, and only one of
 * them is the operator's to fix by logging in. `error` distinguishes them -- empty with
 * no account means a clean "not logged in", non-empty means the question failed.
 */
export interface Identity {
  readonly account: string;
  readonly arn: string;
  readonly error: string;
}

export function identity(values: Partial<Identity> = {}): Identity {
  return { account: '', arn: '', error: '', ...values };
}

export function identityKnown(value: Identity): boolean {
  return value.account !== '';
}

/** How the identity is named in every message that mentions it. */
export function identityPretty(value: Identity): string {
  if (!identityKnown(value)) return 'not signed in';
  const who = value.arn.includes('/') ? value.arn.split('/').pop() : value.arn;
  return `${String(who)} in account ${value.account}`;
}

/**
 * Ask AWS who this box is acting as. Never throws.
 *
 * `sts get-caller-identity` is the right question because it is the only one that needs
 * no permissions beyond having credentials at all -- anything else would conflate "not
 * signed in" with "signed in and not allowed to do that", which are different problems
 * with different fixes.
 */
export async function whoami({ timeout = IDENTITY_TIMEOUT } = {}): Promise<Identity> {
  if (which(IDENTITY_TOOL) === '') {
    return identity({ error: `${IDENTITY_TOOL} is not installed` });
  }
  const res = await awsCli.run([IDENTITY_TOOL, 'sts', 'get-caller-identity', '--output', 'json'], {
    timeoutMs: asMs(timeout),
  });
  if (res.returncode !== 0) {
    // Expired SSO, no profile, no route to STS -- all land here, and the text AWS prints
    // is far more useful than any sentence houston could substitute.
    return identity({ error: why(res, { limit: 200 }) });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(res.stdout || '{}');
  } catch {
    return identity({ error: 'sts returned something that is not JSON' });
  }
  const parsed = doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  return identity({
    account: String(parsed.Account ?? ''),
    arn: String(parsed.Arn ?? ''),
  });
}

/**
 * The region this box would use, or ''.
 *
 * Read the way the AWS tooling itself resolves it -- environment first, then the
 * configured profile -- so houston and `eksctl` cannot disagree about where a cluster is
 * about to be built. A cluster in the wrong region is not a small mistake: it is
 * invisible to every command afterwards, which all default to the same resolution.
 */
export async function region(): Promise<string> {
  for (const name of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
    const found = (process.env[name] ?? '').trim();
    if (found !== '') return found;
  }
  if (which(IDENTITY_TOOL) === '') return '';
  const res = await awsCli.run([IDENTITY_TOOL, 'configure', 'get', 'region'], {
    timeoutMs: asMs(IDENTITY_TIMEOUT),
  });
  return res.returncode === 0 ? res.stdout.trim() : '';
}

/**
 * Whether this box could build an EKS cluster, and what is stopping it.
 *
 * Reports; never throws and never refuses. `doctor` renders it and the create path turns
 * `blockers` into one refusal -- the same division `kube`'s Preflight already has, and
 * for the same reason: the command someone runs when things are wrong must not be the
 * command that falls over.
 */
export interface CloudPreflight {
  readonly tools: Readonly<Record<string, Tool>>;
  readonly identity: Identity;
  readonly region: string;
}

/**
 * Everything that would stop a create, each phrased as its own remedy.
 *
 * Ordered by what to do first: a missing tool cannot be diagnosed further, and asking
 * about credentials before `aws` exists produces a confusing second complaint about the
 * same absence.
 */
export function blockers(pre: CloudPreflight): string[] {
  const out: string[] = [];
  for (const name of Object.keys(pre.tools).sort()) {
    const found = pre.tools[name] as Tool;
    if (!toolPresent(found)) {
      out.push(`${name} is not installed`);
    } else if (!newEnough(found)) {
      const floor = allTools()[name] ?? [];
      const want = floor.length > 0 ? floor.join('.') : 'a newer release';
      out.push(`${name} ${pretty(found)} is older than ${want}`);
    }
  }
  if (out.some((line) => line.includes('not installed'))) return out;
  if (!identityKnown(pre.identity)) {
    out.push(
      'not signed in to AWS' +
        (pre.identity.error !== '' ? ` (${pre.identity.error})` : '') +
        '. houston never holds AWS credentials — arrange them with `aws configure`, ' +
        '`aws sso login`, an instance profile or the standard environment variables, ' +
        'and it will use what it finds.',
    );
  }
  if (pre.region === '') {
    out.push(
      'no AWS region resolved. Set one with `aws configure set region <region>` or ' +
        '`AWS_REGION`, so houston and eksctl cannot disagree about where a cluster is ' +
        'being built.',
    );
  }
  return out;
}

export function cloudReady(pre: CloudPreflight): boolean {
  return blockers(pre).length === 0;
}

/**
 * Everything the cloud path needs, in one pass, changing nothing.
 *
 * CONCURRENTLY, because this is the slowest thing `doctor` does and almost all of it is
 * waiting. MEASURED: `aws sts get-caller-identity` 1191ms, `aws
 * configure get region` 301ms, `aws --version` 291ms -- 1783ms of a 2485ms report, and
 * every one of them a separate process start or network round trip that has nothing to
 * say to the others.
 *
 * Two waves, because `whoami` needs to know whether `aws` is installed before it is worth
 * asking who you are. Within each wave nothing depends on anything else. The calls are
 * already asynchronous, so `Promise.all` states it with nothing to join.
 */
export async function preflight(): Promise<CloudPreflight> {
  const names = [...new Set([...Object.keys(tuning.CLOUD_PROVISION_TOOLS), IDENTITY_TOOL])];
  const probed = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await tool(name)] as const)),
  );
  // `region` does not depend on the identity, so it runs beside it rather than after it
  // -- 301ms that used to be added to the 1191ms instead of hidden by it.
  const [resolvedRegion, ident] = await Promise.all([
    region(),
    toolPresent(probed[IDENTITY_TOOL] as Tool)
      ? whoami()
      : Promise.resolve(identity({ error: `${IDENTITY_TOOL} is not installed` })),
  ]);
  return { tools: probed, identity: ident, region: resolvedRegion };
}

/**
 * Cluster ownership, by the same rule as namespace ownership and for the same reason.
 * `OWNER_LABEL_KEY` says it first -- anyone can create a namespace called
 * `houston-anything`, and a teardown that matched on the prefix would eventually delete
 * one houston never made. A cluster NAME is likewise the operator's choice, and the
 * stakes here are a VPC and a NAT gateway rather than a container.
 *
 * The tag lives ON THE CLUSTER, in AWS, and not in HOUSTON_HOME. CLAUDE.md tells anyone
 * writing a script to `export HOUSTON_HOME=$(mktemp -d)`, so a local ownership record is
 * one followed instruction away from leaving a billable cluster houston can no longer
 * prove is its own. A tag survives a lost home, a different machine and a colleague.
 */
export const OWNED_TAG_KEY = 'houston.io/managed-by';
export const OWNED_TAG_VALUE = 'houston';

/**
 * When somebody said they would be finished with this cluster. A REMINDER, never a
 * policy: nothing acts on it, and in particular nothing deletes on it. Removing a cloud
 * cluster is minutes of destructive work on somebody's AWS account, and a timer is the
 * worst possible thing to have decided it -- on a shared cluster the namespaces may
 * belong to colleagues on machines this box has never seen, which is the same argument
 * the delete guards are built on.
 */
export const EXPIRY_TAG_KEY = 'houston.io/expires';

/**
 * Days, and short on purpose. The safe case is the default: a reproduction cluster is
 * wanted for a ticket, not a quarter, and the failure this guards against is the one
 * nobody notices -- a cluster at roughly $0.24/hr is about $175 a month, which is a sum
 * that turns up on a bill long after the person who made it has moved on.
 */
export const DEFAULT_EXPIRY_DAYS = 7;

/**
 * Seconds, and its own tier because nothing else in the product waits this long.
 * `eksctl create cluster` is 15-25 minutes; the kube CREATE_TIMEOUT is 600 and would kill
 * a create most of the way through building a VPC, which is the worst possible moment.
 */
export const CLUSTER_CREATE_TIMEOUT = 3000;

/** `--wait` is not optional on delete, so this has to outlast a full teardown. */
export const CLUSTER_DELETE_TIMEOUT = 2400;

/**
 * Copied from Rocket.Chat's own Launchpad, which is the reference for what an EKS cluster
 * running Rocket.Chat must PROVIDE.
 *
 * Managed node group, NOT EKS Auto Mode, and the reason is what houston is for. houston
 * already runs Kubernetes on a local kind cluster -- free, about a minute. If a bug were
 * application-level, that reproduces it. Spending twenty minutes and real money only
 * makes sense when something ABOUT EKS matters to the ticket: an EBS volume that will not
 * bind, an ALB behaving unlike an ingress, scheduling under node pressure. Auto Mode
 * abstracts exactly those differently, so it would hide the class of difference this
 * feature exists to expose.
 */
export const K8S_VERSION = '1.33';
export const NODE_INSTANCE_TYPE = 't3.large'; // Launchpad's stated minimum
export const EBS_CSI_ADDON_VERSION = '1.47.0'; // Launchpad pins this exact version
export const DEFAULT_VPC_CIDR = '10.0.0.0/16';

/**
 * Launchpad sizes for a PRODUCTION workspace: 5 nodes with its built-in MongoDB, 3 with
 * an external one. A reproduction carries ONE workspace, and fidelity comes from the
 * addons, the Kubernetes version and the storage driver rather than from how many nodes
 * there are -- so this is the one place houston deliberately departs from the reference,
 * and `--nodes` raises it when a ticket is about scheduling or capacity. Written down
 * because an undocumented divergence is indistinguishable from a mistake.
 */
export const DEFAULT_NODES = 3;

/**
 * The date this cluster says it is wanted until, or '' for no expiry.
 *
 * `null` days means never, and that is a real answer rather than a missing one: a cluster
 * somebody intends to keep should be able to say so, and a reminder nobody can turn off
 * is a reminder everybody learns to ignore.
 */
export function expiryDate(days: number | null, { today }: { today?: Date } = {}): string {
  if (days === null) return '';
  return new Date(localDay(today ?? new Date()) + Math.max(0, days) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Midnight UTC of the LOCAL calendar date of `base`: today's date on the machine's clock in
 * its own timezone. An earlier version took the UTC date, so for the hours when the two
 * differ -- 00:00-05:30 every day on an IST box -- `doctor` said a day more left than the
 * established answer and `cluster create` recorded an expiry a day later.
 */
function localDay(base: Date): number {
  return Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());
}

/** Days left, negative once past, or null when there is no expiry to compare. */
export function daysUntil(expires: string, { today }: { today?: Date } = {}): number | null {
  if (expires === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(expires)) return null;
  const when = Date.parse(`${expires}T00:00:00Z`);
  if (Number.isNaN(when)) return null;
  return Math.round((when - localDay(today ?? new Date())) / 86_400_000);
}

/**
 * The eksctl ClusterConfig for a cluster houston would build.
 *
 * Pure: builds a document and touches nothing. That is deliberate and is what makes the
 * expensive path testable -- every decision about the shape of a cluster can be asserted
 * without an AWS account, leaving only the `eksctl` invocation itself unverifiable
 * without one.
 *
 * **A NEW VPC BY DEFAULT, an existing one only when asked for by name.** Defaulting the
 * other way is not available: there is no safe guess at which of an account's subnets a
 * support workspace belongs in, and picking wrong puts a cluster somewhere it can be
 * reached from, or cannot reach out from, in ways nobody asked for. New is the answer
 * that is wrong in the recoverable direction -- `cluster delete` takes a VPC houston made
 * back with it, and will not touch one it did not.
 */
export function clusterConfig(
  name: string,
  {
    region: where,
    nodes = DEFAULT_NODES,
    subnets,
    expires = '',
    vpcCidr = DEFAULT_VPC_CIDR,
  }: {
    region: string;
    nodes?: number;
    subnets?: Record<string, string>;
    expires?: string;
    vpcCidr?: string;
  },
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    apiVersion: 'eksctl.io/v1alpha5',
    kind: 'ClusterConfig',
    // THE TAG IS SET AT CREATION, not afterwards. A separate tagging step has a window
    // in which the cluster exists and is not yet provably houston's, and a crash inside
    // that window leaves something billable that `cluster delete` will then correctly
    // refuse to remove. eksctl applies `metadata.tags` to the cluster itself, so there
    // is no window.
    metadata: {
      name,
      region: where,
      version: K8S_VERSION,
      tags: {
        [OWNED_TAG_KEY]: OWNED_TAG_VALUE,
        ...(expires !== '' ? { [EXPIRY_TAG_KEY]: expires } : {}),
      },
    },
    managedNodeGroups: [
      {
        name: `${name}-ng`,
        instanceType: NODE_INSTANCE_TYPE,
        desiredCapacity: nodes,
        privateNetworking: true,
        iam: { withAddonPolicies: { ebs: true } },
      },
    ],
    addons: [{ name: 'aws-ebs-csi-driver', version: EBS_CSI_ADDON_VERSION }],
    // Every workspace PVC lands on EBS, so the driver needs to assume a role; without
    // OIDC the addon installs and the volumes stay Pending, which is the single most
    // confusing way for this to fail.
    iam: { withOIDC: true },
  };
  if (subnets !== undefined && Object.keys(subnets).length > 0) {
    // NAMED subnets, never discovered. houston is not going to guess which of an
    // account's subnets it is welcome in, and a wrong guess is a cluster in the wrong
    // place rather than an error.
    doc.vpc = {
      subnets: {
        private: Object.fromEntries(
          Object.keys(subnets)
            .sort()
            .map((zone) => [zone, { id: subnets[zone] }]),
        ),
      },
    };
  } else {
    doc.vpc = { cidr: vpcCidr };
  }
  return doc;
}

/**
 * Run a long command and report what it says WHILE it says it.
 *
 * `awsCli.run` captures output and returns it at the end, which is right for a probe that
 * answers in a second and wrong for one that takes twenty minutes: `cluster create`
 * printed one line and then went silent for the entire build, which is indistinguishable
 * from a hang.
 *
 * eksctl prefixes its own progress with a level and a timestamp; the message is the part
 * worth showing, and the rest is noise on a terminal that already has its own clock.
 */
export async function streamTool(
  argv: readonly string[],
  { phase, emit, timeout }: { phase: EmittedPhase; emit: Emit; timeout: number },
): Promise<number> {
  const seen: string[] = [];
  const env = userEnv();
  const res = await awsCli.stream(argv, {
    timeoutMs: asMs(timeout),
    ...(env === undefined ? {} : { env }),
    onLine: (raw) => {
      const line = raw.replace(/\s+$/u, '');
      if (line === '') return;
      seen.push(line);
      const shown =
        line.startsWith('[') || line.startsWith('2')
          ? line.split(']').slice(1).join(']').trim() || line
          : line;
      info(emit, shown.slice(0, 200), { phase });
    },
  });
  if (res.returncode !== 0) {
    // A launch failure has no output of its own, so the reason on stderr is the report.
    if (seen.length === 0 && res.stderr !== '') {
      warn(emit, `${String(argv[0])} could not be started: ${res.stderr}`, { phase });
    }
    for (const line of seen.slice(-6)) warn(emit, line.slice(0, 200), { phase });
  }
  return res.returncode;
}

/**
 * What AWS knows about one cluster: PRESENT with `.doc`, ABSENT, or REFUSED.
 *
 * THREE answers, and this is the highest-stakes use of that contract in the product.
 * Everything destructive below reads it, and the two negatives must not be collapsed:
 * `ResourceNotFoundException` is AWS asserting the cluster is not there, which is safe to
 * act on; anything else -- expired credentials, no route, a throttle, a permission
 * boundary -- is "I could not ask", which is not.
 */
export async function describeCluster(name: string, where: string): Promise<Answer> {
  if (which(IDENTITY_TOOL) === '' || where === '') return answer(REFUSED);
  const res = await awsCli.run(
    [
      IDENTITY_TOOL,
      'eks',
      'describe-cluster',
      '--name',
      name,
      '--region',
      where,
      '--output',
      'json',
    ],
    { timeoutMs: asMs(IDENTITY_TIMEOUT) },
  );
  const shaped = {
    argv: res.argv,
    returncode: res.returncode,
    stdout: res.stdout,
    stderr: res.stderr,
  };
  if (res.returncode === 0) {
    try {
      const parsed = JSON.parse(res.stdout || '{}') as Record<string, unknown>;
      const cluster = parsed.cluster;
      return answer(
        PRESENT,
        cluster !== null && typeof cluster === 'object' ? (cluster as Record<string, unknown>) : {},
      );
    } catch {
      return answer(REFUSED, null, shaped);
    }
  }
  if (res.stderr.includes('ResourceNotFoundException')) return answer(ABSENT, null, shaped);
  return answer(REFUSED, null, shaped);
}

/**
 * Whether a cluster by this name is there at all, tag or no tag.
 *
 * Separate from `ownsCluster` because they are different questions with different
 * consequences. "Is it there" decides whether an interruption note is still worth
 * keeping; "is it ours" decides whether it may be destroyed. Answering the second where
 * the first was asked would clear the note about a half-built cluster that never got its
 * tag on -- which is exactly the cluster the note exists for.
 */
export async function clusterExists(name: string, where: string): Promise<Answer> {
  return await aws.describeCluster(name, where);
}

/**
 * Whether houston may DESTROY this cluster. Never a name comparison.
 *
 * ABSENT means "not ours, refuse". REFUSED means "could not read, ALSO refuse" -- the two
 * behave the same way here and that is deliberate: the one thing that must never happen
 * is a delete authorised by a read that failed. They are still distinguished in the
 * return value, because the refusal has to say which it was.
 */
export async function ownsCluster(name: string, where: string): Promise<Answer> {
  const seen = await aws.describeCluster(name, where);
  if (seen.state !== PRESENT) return seen;
  const tags = seen.doc.tags;
  const table = tags !== null && typeof tags === 'object' ? (tags as Record<string, unknown>) : {};
  if (String(table[OWNED_TAG_KEY] ?? '') === OWNED_TAG_VALUE) return seen;
  return answer(ABSENT, seen.doc);
}

/**
 * Where to look when the account cannot be asked what it has enabled. A SHIPPED LIST
 * rather than a probe, because the probe needs `ec2:DescribeRegions` and the whole point
 * of this sweep is that it must work for the person who has least reason to have it --
 * somebody checking what they are being charged for. Commercial regions only: China and
 * GovCloud are separate partitions with their own credentials, and a sweep that pretended
 * to cover them would report "nothing found" for an account it could never have reached.
 */
export const DEFAULT_REGION_SWEEP: readonly string[] = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'eu-south-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-east-1',
  'me-south-1',
  'af-south-1',
];

/**
 * Seconds for one region's `list-clusters`. Short: a sweep is many of these in a row and
 * one unreachable region must not hold the whole report.
 */
export const SWEEP_TIMEOUT = 20;

/** The first useful line of a failed AWS call, for a report to carry. */
export function oneLine(res: AwsResult): string {
  const text = (res.stderr || res.stdout).trim();
  return text !== '' ? (text.split('\n')[0] as string).trim() : `exit ${String(res.returncode)}`;
}

/**
 * `[regions to sweep, why the account could not be asked]`.
 *
 * Asks the account which regions it has enabled, because sweeping twenty-one when four
 * are on is twenty-one round trips to answer a question about four. Falls back to the
 * shipped list rather than refusing -- `ec2:DescribeRegions` is not in the minimal
 * engineer policy, and the person most likely to be missing it is exactly the person who
 * needs to know what is running.
 *
 * The second value is not decoration. A sweep that fell back covers the shipped list and
 * NOT necessarily the account's actual regions, so a caller reporting "nothing found" has
 * to be able to say which of the two questions it answered.
 */
export async function enabledRegions(): Promise<[string[], string]> {
  if (which(IDENTITY_TOOL) === '') {
    return [[...DEFAULT_REGION_SWEEP], `${IDENTITY_TOOL} is not installed`];
  }
  const res = await awsCli.run(
    [
      IDENTITY_TOOL,
      'ec2',
      'describe-regions',
      '--query',
      'Regions[].RegionName',
      '--output',
      'json',
    ],
    { timeoutMs: asMs(IDENTITY_TIMEOUT) },
  );
  if (res.returncode !== 0) return [[...DEFAULT_REGION_SWEEP], oneLine(res)];
  let names: string[];
  try {
    const parsed: unknown = JSON.parse(res.stdout || '[]');
    if (!Array.isArray(parsed)) throw new TypeError('not a list');
    names = parsed.map((entry) => String(entry));
  } catch {
    return [[...DEFAULT_REGION_SWEEP], 'the region list could not be parsed'];
  }
  return names.length > 0
    ? [[...names].sort(), '']
    : [[...DEFAULT_REGION_SWEEP], 'the account reported no regions'];
}

export interface SweptCluster {
  name: string;
  region: string;
  ours: boolean;
  status: string;
  arn: string;
  created: string;
  expires: string;
}

export interface Sweep {
  clusters: SweptCluster[];
  unreadable: { region: string; why: string }[];
  regions: string[];
  fallback: string;
  /** `owned_only`, the established key: the --json envelope and the GUI's job carry it. */
  owned_only: boolean;
}

/** One region's clusters, and what could not be reached in it. */
async function sweepOneRegion(
  asked: readonly string[],
  emit: Emit,
  out: Sweep,
  ownedOnly: boolean,
): Promise<void> {
  for (const [index, where] of asked.entries()) {
    // `preflight` rather than a phase of its own: PHASES is a closed wire contract and a
    // sweep of regions is a connectivity check, which is what that phase already names.
    info(emit, `[${String(index + 1)}/${String(asked.length)}] ${where}`, {
      phase: 'preflight',
      pct: Math.trunc(((index + 1) * 100) / Math.max(asked.length, 1)),
    });
    const res = await awsCli.run(
      [
        IDENTITY_TOOL,
        'eks',
        'list-clusters',
        '--region',
        where,
        '--query',
        'clusters',
        '--output',
        'json',
      ],
      { timeoutMs: asMs(SWEEP_TIMEOUT) },
    );
    if (res.returncode !== 0) {
      out.unreadable.push({ region: where, why: oneLine(res) });
      continue;
    }
    let names: string[];
    try {
      const parsed: unknown = JSON.parse(res.stdout || '[]');
      if (!Array.isArray(parsed)) throw new TypeError('not a list');
      names = parsed.map((entry) => String(entry));
    } catch {
      out.unreadable.push({ region: where, why: 'the cluster list could not be parsed' });
      continue;
    }
    for (const name of names) {
      const seen = await aws.describeCluster(name, where);
      if (seen.state !== PRESENT) {
        // The cluster is THERE -- list-clusters just named it -- and could not be
        // described. Reported as unreadable rather than dropped, because a cluster
        // silently missing from this list is the exact failure the function exists to
        // prevent.
        out.unreadable.push({ region: where, why: `${name} is there and could not be described` });
        continue;
      }
      const doc = seen.doc;
      const rawTags = doc.tags;
      const tags =
        rawTags !== null && typeof rawTags === 'object' ? (rawTags as Record<string, unknown>) : {};
      const ours = tags[OWNED_TAG_KEY] === OWNED_TAG_VALUE;
      if (ownedOnly && !ours) continue;
      out.clusters.push({
        name,
        region: where,
        ours,
        status: String(doc.status ?? ''),
        arn: String(doc.arn ?? ''),
        created: String(doc.createdAt ?? ''),
        expires: String(tags[EXPIRY_TAG_KEY] ?? ''),
      });
    }
  }
}

/**
 * Every cluster in the account, region by region, and what could not be read.
 *
 * THE COMMAND THAT ANSWERS "what am I paying for". Nothing else in houston can: `cluster
 * status` needs a context you already have, and `doctor` reads a local pointer that a
 * fresh HOUSTON_HOME has not got -- so a cluster in a region you have stopped thinking
 * about is invisible to the whole tool. That is not hypothetical. A cluster built by
 * houston sat in eu-west-1 for 16.8 hours and $2.47 while every check run that day looked
 * only at us-east-1, and it was found by an unrelated `aws` call rather than by anything
 * here.
 *
 * UNREADABLE IS NOT EMPTY, region by region. A region whose `list-clusters` failed is
 * named in `unreadable` and contributes no clusters and no reassurance -- the one thing a
 * report like this must never do is let "I could not ask fourteen regions" read as "you
 * are not paying for anything".
 */
export async function sweepClusters({
  regions,
  ownedOnly = true,
  emit = nullEmit,
}: { regions?: string[]; ownedOnly?: boolean; emit?: Emit } = {}): Promise<Sweep> {
  // ONE reason, not twenty-one copies of it. Without `aws` every region fails the same
  // way, and a report whose "could not be read" list is the region list with a single
  // cause repeated buries the one sentence that matters.
  if (which(IDENTITY_TOOL) === '') {
    return {
      clusters: [],
      regions: [],
      owned_only: ownedOnly,
      fallback: '',
      unreadable: [
        { region: '(all)', why: `${IDENTITY_TOOL} is not installed, so no region could be asked` },
      ],
    };
  }
  const [asked, fallbackWhy] =
    regions !== undefined && regions.length > 0 ? [regions, ''] : await enabledRegions();
  const out: Sweep = {
    clusters: [],
    unreadable: [],
    regions: [...asked],
    fallback: fallbackWhy,
    owned_only: ownedOnly,
  };
  await sweepOneRegion(asked, emit, out, ownedOnly);
  return out;
}

/**
 * Where everything houston knows about one cluster lives, on this box.
 *
 * A DIRECTORY rather than a single file, because the pointer is not the only thing worth
 * keeping: the document eksctl was actually handed and the manifests applied afterwards
 * are what answer "what is this cluster, and why is it shaped like that" six weeks later,
 * when the cluster is the only evidence and nobody remembers which flags produced it.
 */
export function clusterDir(name: string): string {
  // `clusters/<name>` under the home, and every ledger path joined component by component,
  // a `..` kept (`joinPath`): `path.join` folded a `..` in the home that the kernel
  // resolves through a symlink.
  return joinPath(config.home(), 'clusters', name);
}

function pointerPath(name: string): string {
  return joinPath(clusterDir(name), 'cluster.json');
}

/**
 * Write down something houston applied to a cluster. Best effort, never fatal.
 *
 * Kept on this box rather than in the cluster, and kept even when the thing it describes
 * failed -- a create that died half way is exactly when somebody needs to read what was
 * submitted, and a manifest that only survives success is a manifest that is never there
 * when it is wanted.
 */
export async function keepManifest(
  name: string,
  filename: string,
  body: string,
): Promise<string | null> {
  try {
    const directory = clusterDir(name);
    // Made with its parents: 0700 on the cluster's directory alone, and the umask's mode
    // on `clusters/` when it is made here.
    mkdirParents(directory, 0o700);
    await atomicWrite(joinPath(directory, filename), body);
    return joinPath(directory, filename);
  } catch {
    return null;
  }
}

/**
 * Note locally that this box built a cluster. Best effort, never load-bearing.
 *
 * The TAG authorises deletion; this only lets `doctor` say "you own a cluster that is
 * costing money" without an AWS round trip. Losing it costs a reminder, not control --
 * which is what makes a `mktemp -d` home survivable.
 */
export async function remember(
  name: string,
  { region: where, account, expires = '' }: { region: string; account: string; expires?: string },
): Promise<void> {
  try {
    const target = pointerPath(name);
    mkdirParents(path.dirname(target), 0o700); // the leaf only
    await atomicWrite(
      target,
      `${JSON.stringify(
        {
          name,
          region: where,
          account,
          provider: 'eks',
          expires,
          created_at: `${new Date().toISOString().slice(0, 19)}Z`,
        },
        null,
        2,
      )}`,
    );
  } catch {
    // A pointer is a convenience; the tag is the authority.
  }
}

/**
 * Drop the local POINTER after a delete AWS confirmed, and keep the manifests.
 *
 * The pointer is what `doctor` warns from, so it has to go or the warning outlives the
 * cluster. The documents do not: what was built, and how, is worth more after the fact
 * than during. They are small, they are text, and nothing acts on them.
 */
export function forget(name: string): void {
  for (const target of [
    pointerPath(name),
    // The older flat layout, for a cluster created before manifests were kept.
    joinPath(config.home(), 'clusters', `${name}.json`),
    // AND THE KUBECONFIG, which is not part of the record. The manifests stay because
    // what was built is worth reading afterwards; a kubeconfig is the opposite -- it is
    // the only file here that stops being TRUE the moment the cluster goes, and the only
    // one somebody might try to USE.
    joinPath(clusterDir(name), 'kubeconfig'),
  ]) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // Best effort: a missing file, or one that cannot be removed, is not a failure.
    }
  }
}

/**
 * Every cluster this box thinks it built. May be stale; never authoritative.
 *
 * Both layouts are read: `clusters/<name>/cluster.json` is where a pointer goes now, and
 * `clusters/<name>.json` is where the first version put it. A box that created a cluster
 * before that change must not have it vanish from `doctor`'s warning -- the whole point
 * of that warning is a cluster nobody is thinking about any more.
 */
export function remembered(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const root = joinPath(config.home(), 'clusters');
  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(root).isDirectory()) return out;
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(joinPath(root, entry.name, 'cluster.json'));
    else if (entry.isFile() && entry.name.endsWith('.json')) found.push(joinPath(root, entry.name));
  }
  for (const target of found.sort()) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (parsed !== null && typeof parsed === 'object')
        out.push(parsed as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return out;
}

/** Every reason not to spend twenty minutes and real money on this one. */
async function refuseACreateWeShouldNotMake(
  name: string,
  where: string,
): Promise<[CloudPreflight, string]> {
  const pre = await aws.preflight();
  const resolved = where !== '' ? where : pre.region;
  const stopping = blockers(pre);
  if (stopping.length > 0) {
    throw new PreflightError(`cannot build an EKS cluster from here: ${stopping.join('; ')}`);
  }

  const approved = config.approvedAwsAccounts();
  if (!approved.has(pre.identity.account)) {
    // A GATE, not a confirmation. `--force` cannot reach this and must not: force is a
    // reflex people develop, and this is a decision about somebody's bill.
    throw new AuthorityGateError(
      `building an EKS cluster in account ${pre.identity.account} would cost money, and ` +
        'this box has not been told it may spend in that account. You are ' +
        `${identityPretty(pre.identity)}.`,
      {
        kind: 'cluster',
        subject: `${name} (${resolved})`,
        approveWith:
          'houston config set cluster.approved_accounts ' +
          [...new Set([...approved, pre.identity.account])].sort().join(','),
        code: 'GATE_CLOUD_SPEND',
      },
    );
  }

  const already = await aws.describeCluster(name, resolved);
  if (already.state === PRESENT) {
    throw new ConflictError(
      `a cluster named '${name}' already exists in ${resolved} (account ` +
        `${pre.identity.account}). Use it with \`--context\`, or pick another name.`,
    );
  }
  if (already.state === REFUSED) {
    throw new PreflightError(
      `could not check whether '${name}' already exists in ${resolved}: ` +
        `${already.res !== undefined ? why(already.res, { limit: 200 }) : 'no answer'}. ` +
        'Refusing rather than risking a second cluster.',
    );
  }
  return [pre, resolved];
}

/** Point kubectl at what was just built, and make it able to serve a workspace. */
async function adoptTheNewCluster(
  emit: Emit,
  name: string,
  where: string,
): Promise<[string, Prepared | Record<string, never>]> {
  const described = await aws.describeCluster(name, where);
  const context = String(described.doc?.arn ?? '');
  // PREPARE IS PART OF CREATE, because a cluster that cannot run a workspace is not a
  // finished answer to "create me a cluster". MEASURED: EKS ships no default
  // StorageClass, so without this the very next command refuses and the operator is left
  // patching a class by hand on a cluster they just paid twenty minutes for.
  let prepared: Prepared | Record<string, never> = {};
  if (context === '') return [context, prepared];

  await awsCli.run(['aws', 'eks', 'update-kubeconfig', '--name', name, '--region', where], {
    timeoutMs: asMs(IDENTITY_TIMEOUT),
  });
  // AND A COPY BESIDE THE MANIFESTS. The merged kubeconfig above is the one kubectl uses
  // by default, and it is also the one that gets tidied, moved between machines, or
  // simply not there on somebody else's laptop -- at which point the only way back to
  // this cluster is knowing to run `aws eks update-kubeconfig`, which is exactly the
  // knowledge a person new to EKS does not have.
  //
  // It holds NO credential. The file's user runs `aws eks get-token`, so it is useless
  // without the ambient AWS credentials -- which is what makes writing it down safe.
  const kubePath = joinPath(clusterDir(name), 'kubeconfig');
  try {
    mkdirParents(clusterDir(name), 0o700); // the leaf only
    const wrote = await awsCli.run(
      [
        'aws',
        'eks',
        'update-kubeconfig',
        '--name',
        name,
        '--region',
        where,
        '--kubeconfig',
        kubePath,
      ],
      { timeoutMs: asMs(IDENTITY_TIMEOUT) },
    );
    if (wrote.returncode === 0) {
      fs.chmodSync(kubePath, 0o600);
      info(emit, `kubeconfig kept at ${kubePath} — \`KUBECONFIG=${kubePath} kubectl get nodes\``, {
        phase: 'provision',
      });
    }
  } catch {
    // A kept copy is a convenience; never fail a create for it.
  }
  // AND IT BECOMES THIS BOX'S DEFAULT. houston has just built this cluster and knows its
  // ARN; making the operator read it back out of `aws` and paste it into every later
  // command is ceremony houston is imposing on itself. An ARN is also the worst possible
  // thing to ask somebody to retype.
  //
  // Announced rather than done quietly, because it changes where an un-flagged `up`
  // lands, and a default that moved without saying so is worse than one you have to set.
  await updateLockedConfig((cfg) => {
    cfg[config.KUBE_CONTEXT_KEY] = context;
  });
  info(
    emit,
    "set as this box's default cluster — `up` goes here without --context now (change " +
      'with `houston config set kubernetes.context <name>`)',
    { phase: 'provision' },
  );
  try {
    prepared = await aws.prepareCluster(context, { emit });
  } catch (error) {
    // The CLUSTER exists; say so and stop.
    warn(
      emit,
      `the cluster is up but could not be prepared: ${String((error as Error).message)}. Run ` +
        `\`houston cluster prepare --context ${context}\` once it is reachable — until ` +
        'then `up` will refuse on storage.',
      { phase: 'provision' },
    );
  }
  return [context, prepared];
}

/** The twenty minutes of eksctl, journalled so a kill does not leave it unowned. */
async function buildTheCluster(
  doc: Record<string, unknown>,
  emit: Emit,
  expires: string,
  name: string,
  pre: CloudPreflight,
  where: string,
): Promise<void> {
  // THE NOTE GOES DOWN BEFORE THE CALL, and is only cleared once eksctl has returned. A
  // note written afterwards describes nothing: the whole case it exists for is the
  // process not getting there.
  const entry = recordJournal(CLUSTER_UNFINISHED, name, {
    region: where,
    account: pre.identity.account,
  });
  // WRITTEN BEFORE THE CALL, and eksctl is handed the kept file rather than a copy in a
  // temporary directory: the document on disk is then provably the one that was
  // submitted, and it survives a create that fails -- which is when somebody most wants
  // to read it.
  // `safeDump(doc)`, keys in document order: the kept file is one the user is told to
  // read, and the `yaml` package double-quoted what the YAML 1.1 emitter single-quotes
  // (`version: "1.33"` against `'1.33'`, the expiry tag) -- the same value in different
  // bytes.
  const body = safeDump(doc);
  let kept = await keepManifest(name, 'cluster.yaml', body);
  let temporary = '';
  if (kept === null) {
    // A fresh temporary directory, under the one `tempRoot()` settles on.
    temporary = makeTempDir();
    kept = path.join(temporary, 'cluster.yaml');
    fs.writeFileSync(kept, body, 'utf8');
  } else {
    info(emit, `config kept at ${kept}`, { phase: 'provision' });
  }
  let code: number;
  try {
    code = await aws.streamTool(['eksctl', 'create', 'cluster', '-f', kept], {
      phase: 'provision',
      emit,
      timeout: CLUSTER_CREATE_TIMEOUT,
    });
  } finally {
    if (temporary !== '') fs.rmSync(temporary, { recursive: true, force: true });
  }

  if (code !== 0) {
    // The note STAYS. eksctl may have built a VPC, a NAT gateway and a control plane
    // before failing, and houston is not going to decide on its own to destroy them.
    throw new CreateFailedError(
      `eksctl could not build '${name}' in ${where} (exit ${String(code)}); its last lines ` +
        'are above. A note has been kept: `houston doctor` reports it, because a partial ' +
        'create can still be billing.',
    );
  }

  clearJournal(entry);
  await remember(name, { region: where, account: pre.identity.account, expires });
}

/**
 * Build an EKS cluster. Twenty minutes and real money, both on purpose.
 *
 * Never reachable from `up`. This is its own verb at its own lifecycle precisely so that
 * a routine per-ticket command cannot arrive here -- `planCluster` adopts an explicitly
 * named context and never provisions, which is what makes that structural rather than a
 * matter of care.
 */
export async function createCluster(
  name: string,
  {
    region: where = '',
    nodes = DEFAULT_NODES,
    subnets,
    expiresDays = DEFAULT_EXPIRY_DAYS,
    emit = nullEmit,
  }: {
    region?: string;
    nodes?: number;
    subnets?: Record<string, string>;
    expiresDays?: number | null;
    emit?: Emit;
  } = {},
): Promise<Record<string, unknown>> {
  const [pre, resolved] = await refuseACreateWeShouldNotMake(name, where);

  const expires = expiryDate(expiresDays);
  const doc = clusterConfig(name, {
    region: resolved,
    nodes,
    ...(subnets === undefined ? {} : { subnets }),
    expires,
  });
  info(
    emit,
    `building EKS cluster '${name}' in ${resolved} — this takes 15–25 minutes and is ` +
      'billable' +
      (expires !== '' ? `, and is tagged as wanted until ${expires}` : ', with NO expiry set'),
    { phase: 'provision' },
  );

  await buildTheCluster(doc, emit, expires, name, pre, resolved);
  info(emit, `cluster '${name}' is up in ${resolved}`, { phase: 'provision' });

  const [context, prepared] = await adoptTheNewCluster(emit, name, resolved);
  return {
    name,
    region: resolved,
    account: pre.identity.account,
    nodes,
    context,
    expires,
    prepared,
  };
}

/** What the cluster still holds, said out loud before it is destroyed. */
async function confirmDeletion(
  emit: Emit,
  force: boolean,
  mine: Answer,
  where: string,
): Promise<string> {
  // GUARDS 1-3: what is INSIDE it. The context an EKS kubeconfig uses is the cluster ARN,
  // which is what `aws eks update-kubeconfig` writes.
  const context = String(mine.doc?.arn ?? '');
  if (force) {
    warn(emit, `--force: deleting ${where} without reading what it holds`, { phase: 'teardown' });
    return context;
  }
  const got = context !== '' ? await reach(context) : null;
  if (got === null || !reachOk(got)) {
    // GUARD 1. A cluster that does not answer is where houston knows LEAST about what it
    // is about to destroy -- so the refusal stands whatever the cause. What it now says
    // is WHICH cause: this refusal fired on an ACTIVE cluster whose only problem was
    // that a fresh HOUSTON_HOME had no kubeconfig entry for it, and "is not answering"
    // sent the reader to look at a cluster that was in perfect health.
    const reason =
      got !== null
        ? reachWhy(got)
        : 'houston has no API endpoint for it, so there is nothing to ask';
    throw new PreflightError(
      `what ${where} is holding cannot be read: ${reason} — and a cluster that cannot be ` +
        'read is not an empty one. Check it, or pass --force to delete it without ' +
        'looking.' +
        (got !== null ? reachAdvice(got, context) : ''),
    );
  }
  const holding = await workspaceNamespaces(context);
  if (holding === null) {
    // GUARD 2. An unreadable list is not an empty one.
    throw new PreflightError(
      `the workspace list in ${where} could not be read, which is not the same as it ` +
        'being empty. Refusing.',
    );
  }
  if (holding.length > 0) {
    // GUARD 3, and on a shared cloud cluster it changes character: the owners may be
    // colleagues on OTHER boxes whose HOUSTON_HOME this machine has never seen, so this
    // refusal is the only record that they exist.
    const owners = new Set<string>();
    for (const ns of holding) {
      owners.add((await namespaceOwner(ns, { context })) || 'unknown');
    }
    throw new ConflictError(
      `${where} still holds ${String(holding.length)} workspace(s), owned by ` +
        `${[...owners].sort().join(', ')}. Deleting the cluster takes them with it, and ` +
        'on a shared cluster their owners are not necessarily on this machine. Remove ' +
        'them first, or pass --force.',
    );
  }
  return context;
}

/** Drop every kubeconfig entry that pointed at the cluster that is now gone. */
async function forgetTheContexts(
  context: string,
  emit: Emit,
  name: string,
  where: string,
): Promise<void> {
  // AND THE KUBECONFIG ENTRY GOES WITH IT. Two tools wrote one -- `eksctl` and `aws eks
  // update-kubeconfig` -- and neither removes it, so a deleted cluster kept appearing on
  // the ledger for ever. Filtering it out of every report afterwards works and costs a
  // probe and an AWS call on every single list, which is how a "cheap" list became two
  // seconds. Removing it once, here, is where it belongs: houston wrote the entry and is
  // deleting the cluster.
  //
  // Only houston's OWN kubeconfig. The user's is theirs. Both spellings, whatever they
  // are called: the ARN this cluster answered to, and eksctl's
  // `<iam-user>@<cluster>.<region>.eksctl.io`, whose user part varies.
  const suffix = `@${name}.${where}.eksctl.io`;
  const [known] = await contexts();
  for (const alias of new Set(
    known.filter((entry) => entry.endsWith(suffix) || entry.endsWith(`:cluster/${name}`)),
  )) {
    await forgetContext(alias);
  }
  // AND THE DEFAULT GOES WITH IT. A `kubernetes.context` pointing at a cluster that no
  // longer exists makes the next `up` fail on a context that cannot be found, which reads
  // as a bug in `up` rather than as the consequence of a delete.
  if (config.defaultKubeContext() === context) {
    await updateLockedConfig((cfg) => {
      cfg[config.KUBE_CONTEXT_KEY] = '';
    });
    info(emit, "cleared this box's default cluster — it was the one just deleted", {
      phase: 'teardown',
    });
  }
}

/**
 * Destroy an EKS cluster houston built. Returns false if there was nothing to do.
 *
 * Every guard the local `deleteCluster` earned through a measured incident is reproduced
 * here, plus two the cloud needs. They are not defensive padding: each one is a way this
 * has already gone wrong once on a local cluster, where the cost was a container rather
 * than somebody else's afternoon and a VPC.
 */
export async function deleteCluster(
  name: string,
  {
    region: where = '',
    force = false,
    emit = nullEmit,
  }: { region?: string; force?: boolean; emit?: Emit } = {},
): Promise<boolean> {
  const pre = await aws.preflight();
  const resolved = where !== '' ? where : pre.region;
  const stopping = blockers(pre);
  if (stopping.length > 0) {
    throw new PreflightError(`cannot delete an EKS cluster from here: ${stopping.join('; ')}`);
  }

  const place = `'${name}' in ${resolved} (account ${pre.identity.account})`;

  // GUARD 5 and 6: the tag says ours, a refused read is NOT a yes, and the refusal names
  // the account and region -- a cluster called `support` exists in more than one account
  // and acting on the wrong one is the whole failure mode.
  const mine = await aws.ownsCluster(name, resolved);
  if (mine.state === REFUSED) {
    throw new PreflightError(
      `could not read the tags on ${place}, so houston cannot prove it built it — and a ` +
        'delete authorised by a read that failed is the one thing that must not happen ' +
        `here. ${mine.res !== undefined ? why(mine.res, { limit: 200 }) : ''}`.trim(),
    );
  }
  if (mine.state === ABSENT) {
    const exists = await clusterExists(name, resolved);
    if (exists.state === ABSENT) return false;
    throw new AuthorityGateError(
      `${place} was not created by houston — it carries no ${OWNED_TAG_KEY}=` +
        `${OWNED_TAG_VALUE} tag. houston deletes only clusters it built; this one ` +
        'belongs to whoever made it.',
      {
        kind: 'cluster',
        subject: place,
        approveWith: `eksctl delete cluster --name ${name} --region ${resolved} --wait`,
        code: 'GATE_DELETE_UNOWNED',
      },
    );
  }

  const context = await confirmDeletion(emit, force, mine, place);

  info(emit, `deleting ${place} — this takes 10–20 minutes`, { phase: 'teardown' });
  // `--wait` is NOT optional. Without it eksctl returns as soon as the stack delete is
  // accepted, and the caller gets a success for a teardown that may still fail halfway
  // and leave the expensive parts behind.
  const code = await aws.streamTool(
    ['eksctl', 'delete', 'cluster', '--name', name, '--region', resolved, '--wait'],
    { phase: 'teardown', emit, timeout: CLUSTER_DELETE_TIMEOUT },
  );
  if (code !== 0) {
    throw new DockerError(
      `eksctl could not delete ${place} (exit ${String(code)}); its last lines are above. ` +
        'If it says the cluster does not exist, its CloudFormation stack may have ' +
        'survived a rollback — check `aws cloudformation describe-stacks --stack-name ' +
        `eksctl-${name}-cluster --region ${resolved}\`.`,
    );
  }
  forget(name);
  await forgetTheContexts(context, emit, name, resolved);
  return true;
}

/**
 * The StorageClass a fresh EKS cluster does NOT have, and the reason `cluster create` on
 * its own hands back something that cannot run a workspace.
 *
 * MEASURED on EKS 1.33: the cluster ships exactly one class, `gp2`, on the IN-TREE
 * provisioner `kubernetes.io/aws-ebs` -- deprecated, and not the driver the
 * `aws-ebs-csi-driver` addon installs. Nothing references `ebs.csi.aws.com`, so the addon
 * pinned at Launchpad's version sits there doing nothing, and no class is marked default,
 * so every PVC would stay Pending and Rocket.Chat would never start.
 *
 * `WaitForFirstConsumer` because the volume must be created in the availability zone the
 * pod lands in. Binding immediately puts an EBS volume in one zone and then lets the
 * scheduler put the pod in another, which fails in a way that reads as a scheduling
 * problem rather than a storage one.
 */
export const STORAGE_CLASS_NAME = 'gp3';

export const STORAGE_CLASS = `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${STORAGE_CLASS_NAME}
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
`;

export interface Prepared {
  context: string;
  storage_class: string;
  ingress_class: string;
  cert_manager: boolean;
  cname_target: string;
  cname_pending: boolean;
  already: string[];
  kept: string;
}

/** The address a DNS CNAME has to point at, once one exists. */
async function loadbalancerAddress(context: string, emit: Emit, out: Prepared): Promise<void> {
  // Read rather than assumed, and empty is a real answer -- reporting a blank as though
  // it were a hostname would send somebody to make a broken record.
  //
  // WAITED FOR, because this runs immediately after a twenty-minute `cluster create` and
  // an ELB commonly takes one to three minutes to publish a hostname. Asking once made a
  // blank CNAME target the NORMAL outcome of a successful create -- on the one line an
  // operator needs in order to finish the job. The wait returns the moment nothing is
  // pending, so a cluster with no LoadBalancer Service at all costs one read rather than
  // three minutes.
  const [, address] = await waitForLoadbalancer(context, { emit });
  out.cname_target = address;
  // WHICH KIND OF BLANK, so the CLI can say. "No ingress controller published one" and
  // "it was still coming when we stopped waiting" need different next actions.
  out.cname_pending = address === '' && (await loadbalancerState(context))[2] > 0;
  // EMITTED, not merely returned. This is the one line an operator has to act on -- the
  // whole point of running `prepare` -- and it lived only in the returned document, so
  // the CLI printed it and the GUI did not. A fact that reaches only the return value is
  // invisible in the GUI, the mirror of this project's rule about printing instead of
  // emitting.
  if (address !== '') {
    info(emit, `point your name at: ${address}`, { phase: 'tls' });
  } else if (out.cname_pending) {
    warn(
      emit,
      'the load balancer still has no address — it can take a few minutes. Run prepare ' +
        'again to read it, then make the DNS record.',
      { phase: 'tls' },
    );
  } else {
    warn(
      emit,
      'no LoadBalancer Service is waiting for an address, so nothing is going to publish ' +
        'one. This cluster has no load-balancing ingress — workspaces here reach you by ' +
        'port-forward, and `--domain` needs one.',
      { phase: 'tls' },
    );
  }
}

/** The storage class, the ingress controller and cert-manager this cluster needs. */
async function storageAndIngress(context: string, emit: Emit, out: Prepared): Promise<void> {
  const seen = await storageClasses(context);
  if (seen === null) {
    throw new PreflightError(
      `could not read the StorageClasses in '${context}', so houston cannot tell whether ` +
        'a volume would bind. This is a permissions problem on the credential in your ' +
        'kubeconfig, not a missing provisioner.',
    );
  }
  const [names, byDefault] = seen;
  if (byDefault !== '') {
    // ADOPT. A cluster that already has a default has been set up by somebody, and
    // replacing their choice is not this command's business -- `up` only needs ONE to
    // exist, and a second default is an error state in Kubernetes anyway.
    out.storage_class = byDefault;
    out.already.push(`storage class '${byDefault}'`);
  } else {
    info(
      emit,
      `installing the '${STORAGE_CLASS_NAME}' storage class — EKS ships only ` +
        `${names.join(', ') || 'none'}, and none of them default`,
      { phase: 'provision' },
    );
    await apply(STORAGE_CLASS, { namespace: 'default', context });
    out.storage_class = STORAGE_CLASS_NAME;
    // Kept beside the ClusterConfig. `prepare` runs against a context, which may name a
    // cluster houston did not build and therefore has no directory for -- the ARN's last
    // segment is that cluster's name, and is what a person would look under.
    out.kept =
      (await keepManifest(
        context.split('/').pop() ?? context,
        'storageclass.yaml',
        STORAGE_CLASS,
      )) ?? '';
  }

  out.ingress_class = await ensureIngress({
    context,
    distribution: 'eks',
    invited: true,
    emit,
  });
  await ensureCertManager({ context, distribution: 'eks', invited: true, emit });
  out.cert_manager = true;
}

/**
 * Make a cluster able to serve a workspace over HTTPS. Idempotent.
 *
 * Separate from `createCluster` as a VERB but run by it, because the two answer different
 * questions and only one of them costs money. `create` builds infrastructure; `prepare`
 * configures it, is free, and is safe to run again on a cluster somebody else built or on
 * one whose ingress was removed.
 *
 * Returns what a human still has to do. The DNS record is the honest boundary of this
 * tool: the ingress gets a load balancer hostname, and something has to point the
 * workspace's name at it before Let's Encrypt will validate.
 */
export async function prepareCluster(
  context: string,
  { emit = nullEmit }: { emit?: Emit } = {},
): Promise<Prepared> {
  // THE SHORT NAME, RESOLVED. `--context support` is the form `cluster create` prints in
  // its own closing line and the form the guide teaches, and an EKS context is really
  // `arn:aws:eks:<region>:<account>:cluster/support`, which nobody types. Passing the
  // short name straight to kubectl made every read refuse, and the refusal it produced
  // was "could not read the StorageClasses ... This is a permissions problem on the
  // credential in your kubeconfig" -- a confident, wrong diagnosis that sends somebody to
  // fix IAM when the context simply had not been expanded. MEASURED on a freshly created
  // cluster: `cluster prepare --context support` failed in 0.27s, which is far too fast
  // to have asked AWS anything.
  const [resolved] = await assertContextKnown(context);
  const out: Prepared = {
    context: resolved,
    storage_class: '',
    ingress_class: '',
    cert_manager: false,
    cname_target: '',
    cname_pending: false,
    already: [],
    kept: '',
  };

  await storageAndIngress(resolved, emit, out);
  await loadbalancerAddress(resolved, emit, out);
  return out;
}

/**
 * One exported property bag keeps every replaceable AWS operation injectable.
 *
 * A module-local function binding cannot be replaced in the emitted TypeScript, because swc
 * turns an export into a non-configurable getter. Intra-module calls go THROUGH this object
 * wherever a test needs to replace one -- `describeCluster` above all, since every
 * destructive decision in this file reads it.
 */
export const aws = {
  whoami,
  region,
  preflight,
  clusterConfig,
  streamTool,
  describeCluster,
  clusterExists,
  ownsCluster,
  enabledRegions,
  sweepClusters,
  createCluster,
  deleteCluster,
  prepareCluster,
};
