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
  NotFoundError,
  ValidationError,
} from '../lib/errors';
import { info, nullEmit, warn, type Emit, type EmittedPhase } from '../lib/events';
import { mapLimit } from '../lib/map-limit';
import { joinPath, pathHome } from '../lib/home';
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
import { storageClasses, workspaceNamespaces, metricsAvailable } from './kube/capabilities';
import { ensureCertManager } from './kube/certmanager';
import { assertContextKnown, contexts, forgetContext, distribution } from './kube/context';
import {
  LOADBALANCER_INTERVAL,
  LOADBALANCER_TRIES,
  loadbalancerRead,
  waitForLoadbalancer,
} from './kube/endpoints';
import { kube, userEnv } from './kube/exec';
import { ensureIngress } from './kube/ingress';
import { tools as allTools, tuning, CORE_TOOLS } from './kube/names';
import { namespaceOwner } from './kube/namespace';
import { reach, reachAdvice, reachOk, reachWhy } from './kube/reachability';
import { apply } from './kube/release';
import { newEnough, pretty, tool, toolPresent, which, type Tool } from './kube/tools';
import { atomicWrite } from './runner/paths';
import { reproLock, updateConfig as updateLockedConfig } from './runner/locks';

export { GUIDE_FILE, IAM_DOCUMENTS, guide, guidePath, iamDocument } from './eks-docs';
import { iamDocument as readIamDocument } from './eks-docs';

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
 * The named profiles in this box's AWS config, or [] when the tool cannot say. What the
 * setup page offers when the server was started without AWS_PROFILE: `aws sts` working in
 * a shell that had it says nothing about the server that did not. Not `default`, which an
 * unset AWS_PROFILE already uses.
 */
export async function profiles(): Promise<string[]> {
  if (which(IDENTITY_TOOL) === '') return [];
  const res = await awsCli.run([IDENTITY_TOOL, 'configure', 'list-profiles'], {
    timeoutMs: asMs(IDENTITY_TIMEOUT),
  });
  if (res.returncode !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== 'default');
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
  /** Why eksctl would not sign in as `identity` (see `shadowedProfile`), or ''/absent. */
  readonly shadowed?: string;
}

/** The `key = value` pairs of one `[section]` of an AWS ini file; {} when absent. */
function iniSection(file: string, section: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  let inside = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const header = /^\[\s*(.+?)\s*\]$/u.exec(line);
    if (header !== null) {
      // `[profile  name]` is `[profile name]`, as the AWS tools read it.
      inside = (header[1] ?? '').replace(/\s+/gu, ' ') === section;
    } else if (inside && line !== '' && !line.startsWith('#') && !line.startsWith(';')) {
      const at = line.indexOf('=');
      if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return out;
}

/**
 * Keys in the credentials file that eksctl signs in with INSTEAD of the profile's SSO.
 *
 * For one profile with both, the aws CLI reads the SSO settings first and the Go SDK in
 * eksctl reads the credentials file first. So houston's identity check (the aws CLI)
 * passed, and a second later eksctl was refused -- `ExpiredToken`, on keys pasted into
 * ~/.aws/credentials long before -- and with keys that still worked it would build as a
 * different identity from the one houston checked and the spending gate approved.
 * Returns the sentence that says which section to remove, or ''.
 */
export function shadowedProfile(env: NodeJS.ProcessEnv = process.env): string {
  const named = (key: string): string => (env[key] ?? '').trim();
  const profile = [named('AWS_PROFILE'), named('AWS_DEFAULT_PROFILE')].find((v) => v !== '');
  const name = profile ?? 'default';
  const configFile = named('AWS_CONFIG_FILE') || joinPath(pathHome(), '.aws', 'config');
  const keysFile =
    named('AWS_SHARED_CREDENTIALS_FILE') || joinPath(pathHome(), '.aws', 'credentials');
  // `[profile default]` is the default profile too.
  const settings = {
    ...(name === 'default' ? iniSection(configFile, 'default') : {}),
    ...iniSection(configFile, `profile ${name}`),
  };
  const sso = ['sso_session', 'sso_start_url', 'sso_account_id'].some((key) => key in settings);
  // Keys beside the SSO settings in the config file shadow it the same way.
  const keysHere = 'aws_access_key_id' in settings;
  if (!sso || (!keysHere && !('aws_access_key_id' in iniSection(keysFile, name)))) return '';
  const where = keysHere ? configFile : keysFile;
  const section = keysHere && name !== 'default' ? `profile ${name}` : name;
  return (
    `${where} holds keys under [${section}], and eksctl signs in with those instead of ` +
    `the profile's SSO sign-in that the aws CLI uses -- so eksctl would act as a different, ` +
    `or an expired, identity from the one houston checked. Remove ` +
    (keysHere
      ? `the aws_access_key_id, aws_secret_access_key and aws_session_token lines from [${section}] in ${where}`
      : `the [${section}] section from ${where}`) +
    ` (keep a copy), then \`aws sso login --profile ${name}\` if it asks`
  );
}

/**
 * Everything that would stop a create, each phrased as its own remedy.
 *
 * Ordered by what to do first: a missing tool cannot be diagnosed further, and asking
 * about credentials before `aws` exists produces a confusing second complaint about the
 * same absence.
 */
export function blockers(
  pre: CloudPreflight,
  { toBuild = false }: { toBuild?: boolean } = {},
): string[] {
  const out: string[] = [];
  // kubectl and helm are for BUILDING (prepare runs them after the money is spent), so a
  // create refuses without them. Nothing else here needs helm, and a delete that refused
  // for a tool it never runs would be the one command that cannot stop a bill.
  const coreTools = new Set(Object.keys(CORE_TOOLS));
  for (const name of Object.keys(pre.tools).sort()) {
    if (!toBuild && coreTools.has(name)) continue;
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
  if ((pre.shadowed ?? '') !== '') out.push(pre.shadowed as string);
  if (pre.region === '') {
    out.push(
      'no AWS region resolved. Set one with `aws configure set region <region>` or ' +
        '`AWS_REGION`, so houston and eksctl cannot disagree about where a cluster is ' +
        'being built.',
    );
  }
  return out;
}

/** Whether this box could BUILD a cluster: the four tools, an identity, a region. */
export function cloudReady(pre: CloudPreflight): boolean {
  return blockers(pre, { toBuild: true }).length === 0;
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
  // ALL FOUR TOOLS, not only the two that start the build. kubectl and helm are needed
  // twenty minutes later, to prepare the cluster, and a create that checked only aws and
  // eksctl left a cluster that billed and could not run a workspace yet.
  const names = [
    ...new Set([
      ...Object.keys(tuning.CLOUD_PROVISION_TOOLS),
      IDENTITY_TOOL,
      ...Object.keys(CORE_TOOLS),
    ]),
  ];
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
  return { tools: probed, identity: ident, region: resolvedRegion, shadowed: shadowedProfile() };
}

/** Add an existing EKS cluster to this server's kubeconfig without provisioning it. */
export async function connectExisting(arn: string): Promise<{
  context: string;
  account: string;
  principal: string;
  region: string;
  reachable: boolean;
  access_reason: string;
}> {
  const match = arn.match(/^arn:[^:]+:eks:([^:]+):(\d{12}):cluster\/([^/]+)$/u);
  if (match === null) throw new ValidationError('select a full EKS cluster ARN');
  const [, region, account, name] = match;
  if (region === undefined || account === undefined || name === undefined) {
    throw new ValidationError('select a full EKS cluster ARN');
  }
  // Using an existing cluster needs an AWS identity, not the four provisioning tools
  // or spending approval. Check the resolved account before writing kubeconfig.
  const caller = await aws.whoami();
  if (!identityKnown(caller)) {
    throw new PreflightError(`AWS sign-in is required on the Houston server: ${caller.error}`);
  }
  if (caller.account !== account) {
    throw new AuthorityGateError(
      `cluster ${arn} belongs to account ${account}; this server is signed in to ${caller.account}`,
      {
        kind: 'cluster',
        subject: arn,
        approveWith: 'sign in to the selected AWS account',
        code: 'GATE_WRONG_ACCOUNT',
      },
    );
  }
  const seen = await aws.describeCluster(name, region);
  if (seen.state === ABSENT) throw new NotFoundError(`EKS cluster ${arn} was not found`);
  if (seen.state !== PRESENT) {
    throw new PreflightError(`EKS cluster ${arn} could not be read with this AWS identity`);
  }
  if (String(seen.doc.arn ?? '') !== arn) {
    throw new PreflightError(`AWS returned a different cluster ARN for ${name} in ${region}`);
  }
  // update-kubeconfig selects its new entry as the process-wide current context. Hold
  // one lock across read, write and restore so two GUI/CLI connections cannot leave
  // each other's cluster selected. An initially unset context must stay unset too.
  await reproLock('kubeconfig-connect', async () => {
    const current = await kube.run(['kubectl', 'config', 'current-context']);
    const previous = current.returncode === 0 ? current.stdout.trim() : '';
    const env = userEnv();
    let wrote: AwsResult | undefined;
    let updateError: unknown;
    try {
      wrote = await awsCli.run(
        ['aws', 'eks', 'update-kubeconfig', '--name', name, '--region', region, '--alias', arn],
        { timeoutMs: asMs(IDENTITY_TIMEOUT), ...(env !== undefined ? { env } : {}) },
      );
    } catch (error) {
      updateError = error;
    }
    const restore =
      previous === ''
        ? ['kubectl', 'config', 'unset', 'current-context']
        : ['kubectl', 'config', 'use-context', previous];
    const restored = await kube.run(restore);
    if (restored.returncode !== 0) {
      throw new PreflightError(
        `connected ${arn}, but could not restore the previous kubectl context`,
      );
    }
    if (updateError !== undefined) throw updateError;
    if (wrote === undefined || wrote.returncode !== 0) {
      throw new PreflightError(
        `could not connect ${arn}: ${wrote === undefined ? 'AWS CLI did not answer' : oneLine(wrote)}`,
      );
    }
  });
  const reached = await reach(arn);
  return {
    context: arn,
    account,
    principal: caller.arn,
    region,
    reachable: reachOk(reached),
    access_reason: reachOk(reached) ? '' : reachWhy(reached),
  };
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
 * The DNS zone workspaces get their public names under, e.g. `rc.example.com` for
 * `ticket-1234.rc.example.com`. Known once, at build time, and previously typed again as
 * --domain on every ticket. On the cluster (true on every machine) and in the note.
 */
export const ZONE_TAG_KEY = 'houston.io/zone';

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
//
// The NEWEST version on EKS standard support, not Launchpad's 1.33: 1.33 left standard
// support on 2026-07-29, and from then its control plane bills $0.60 an hour instead of
// $0.10 -- about $12 a day for nothing a support ticket needs. `aws eks
// describe-cluster-versions` listed 1.37 as the newest standard-support version on
// 2026-10-06 (standard support to 2027-12-01). Move it when the next one is offered.
export const K8S_VERSION = '1.37';
export const NODE_INSTANCE_TYPE = 't3.large'; // Launchpad's stated minimum
// Moves with K8S_VERSION. Launchpad pins 1.47.0, which EKS offers only up to 1.36; for 1.37
// `aws eks describe-addon-versions` offered 1.55.0 and newer, with 1.66.0 the default.
export const EBS_CSI_ADDON_VERSION = '1.66.0';
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
    zone = '',
    vpcCidr = DEFAULT_VPC_CIDR,
  }: {
    region: string;
    nodes?: number;
    subnets?: Record<string, string>;
    expires?: string;
    zone?: string;
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
        ...(zone !== '' ? { [ZONE_TAG_KEY]: zone } : {}),
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
/**
 * How much of one eksctl line is shown. It was 200, and a refused build's only line,
 * "checking AWS STS access – … StatusCode: 403, RequestID: …, api error ExpiredToken: …",
 * lost exactly the part that said why. Bounded still, because a job keeps its events.
 */
const LINE_LIMIT = 1000;

export async function streamTool(
  argv: readonly string[],
  {
    phase,
    emit,
    timeout,
    progress,
  }: {
    phase: EmittedPhase;
    emit: Emit;
    timeout: number;
    /** A percentage read from a line, or null; the event carries the best seen so far. */
    progress?: (line: string) => number | null;
  },
): Promise<number> {
  const seen: string[] = [];
  const env = userEnv();
  let best: number | null = null;
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
      if (progress !== undefined) {
        // NEVER BACKWARDS: eksctl waits on the cluster stack again after the node group,
        // and a bar that jumped from 70 back to 35 would read as a failure.
        const read = progress(shown);
        if (read !== null && (best === null || read > best)) best = read;
      }
      info(emit, shown.slice(0, LINE_LIMIT), best === null ? { phase } : { phase, pct: best });
    },
  });
  if (res.returncode !== 0) {
    // A launch failure has no output of its own, so the reason on stderr is the report.
    if (seen.length === 0 && res.stderr !== '') {
      warn(emit, `${String(argv[0])} could not be started: ${res.stderr}`, { phase });
    }
    for (const line of seen.slice(-6)) warn(emit, line.slice(0, LINE_LIMIT), { phase });
  }
  return res.returncode;
}

/**
 * Where an eksctl create is, as a percentage, from the steps it reports doing.
 *
 * eksctl's messages are the only progress a twenty-five-minute build offers. In the order a
 * real build printed them (us-east-1, 2026-10-05): the cluster stack, the long wait for the
 * control plane, the first add-ons, the node group stack, the node ready, the storage and
 * metrics add-ons, and the cluster ready. The control plane wait is most of the time, so the
 * bar sits at 10% through it. The last 10% is houston's own prepare.
 *
 * PLANS ARE NOT PROGRESS. eksctl opens with what it WILL do -- "will create a CloudFormation
 * stack for cluster itself and 1 managed nodegroup stack(s)", "will install them as EKS
 * addons" -- and a task tree naming every step ("create managed nodegroup", "wait for
 * control plane to become ready", "1 task: { create addons }"). Matched as progress, those
 * put the bar at 85% in the first minute, and it never moves backwards, so it stood there
 * for the whole build.
 */
export function eksctlProgress(line: string): number | null {
  const text = line.toLowerCase().trim();
  if (/\bwill\b|sequential|\btasks?:|[{}]/u.test(text)) return null;
  if (/region is ready/u.test(text)) return 90;
  if (/aws-ebs-csi-driver|metrics-server/u.test(text) && /addon/u.test(text)) return 85;
  if (/created \d+ managed nodegroup|node "[^"]*" is ready/u.test(text)) return 80;
  if (/nodegroup stack|stack "eksctl-[^"]*-nodegroup-/u.test(text)) return 65;
  if (/creating addon|addon "[^"]*" active/u.test(text)) return 55;
  if (/waiting for cloudformation stack "eksctl-[^"]*-cluster"/u.test(text)) return 10;
  if (/building cluster stack|deploying stack "eksctl-[^"]*-cluster"/u.test(text)) return 5;
  return null;
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
/** Regions asked at once. `ponytail:` six stays well under the AWS API's per-account rate; raise it if a sweep of 17 still drags. */
export const SWEEP_WORKERS = 6;

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
/** One region's answer: what it holds, and what in it could not be read. */
async function sweepOneRegion(
  where: string,
  ownedOnly: boolean,
): Promise<{ clusters: SweptCluster[]; unreadable: { region: string; why: string }[] }> {
  const clusters: SweptCluster[] = [];
  const unreadable: { region: string; why: string }[] = [];
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
    unreadable.push({ region: where, why: oneLine(res) });
    return { clusters, unreadable };
  }
  let names: string[];
  try {
    const parsed: unknown = JSON.parse(res.stdout || '[]');
    if (!Array.isArray(parsed)) throw new TypeError('not a list');
    names = parsed.map((entry) => String(entry));
  } catch {
    unreadable.push({ region: where, why: 'the cluster list could not be parsed' });
    return { clusters, unreadable };
  }
  for (const name of names) {
    const seen = await aws.describeCluster(name, where);
    if (seen.state !== PRESENT) {
      // The cluster is THERE -- list-clusters just named it -- and could not be
      // described. Reported as unreadable rather than dropped, because a cluster
      // silently missing from this list is the exact failure the function exists to
      // prevent.
      unreadable.push({ region: where, why: `${name} is there and could not be described` });
      continue;
    }
    const doc = seen.doc;
    const rawTags = doc.tags;
    const tags =
      rawTags !== null && typeof rawTags === 'object' ? (rawTags as Record<string, unknown>) : {};
    const ours = tags[OWNED_TAG_KEY] === OWNED_TAG_VALUE;
    if (ownedOnly && !ours) continue;
    clusters.push({
      name,
      region: where,
      ours,
      status: String(doc.status ?? ''),
      arn: String(doc.arn ?? ''),
      created: String(doc.createdAt ?? ''),
      expires: String(tags[EXPIRY_TAG_KEY] ?? ''),
    });
  }
  return { clusters, unreadable };
}

/**
 * Every region asked, six at a time, answers assembled in the order the regions were named.
 *
 * Seventeen regions one after another at up to twenty seconds each is why `cluster list`
 * took minutes; the calls are independent reads. The ORDER of `clusters` and `unreadable`
 * follows the argument order whatever finished first, because the CLI and the GUI print
 * this document and a report must not vary from run to run.
 */
async function sweepTheRegions(
  asked: readonly string[],
  emit: Emit,
  out: Sweep,
  ownedOnly: boolean,
): Promise<void> {
  let done = 0;
  const answers = await mapLimit(asked, SWEEP_WORKERS, async (where) => {
    const answer = await sweepOneRegion(where, ownedOnly);
    done += 1;
    // `preflight` rather than a phase of its own: PHASES is a closed wire contract and a
    // sweep of regions is a connectivity check, which is what that phase already names.
    info(emit, `[${String(done)}/${String(asked.length)}] ${where}`, {
      phase: 'preflight',
      pct: Math.trunc((done * 100) / Math.max(asked.length, 1)),
    });
    return answer;
  });
  for (const answer of answers) {
    out.clusters.push(...answer.clusters);
    out.unreadable.push(...answer.unreadable);
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
  await sweepTheRegions(asked, emit, out, ownedOnly);
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
  {
    region: where,
    account,
    expires = '',
    zone = '',
  }: { region: string; account: string; expires?: string; zone?: string },
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
          zone,
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

/** The region an EKS ARN names, or '' for any other context. */
function regionOfContext(context: string): string {
  return context.startsWith('arn:aws:eks:') ? (context.split(':')[3] ?? '') : '';
}

/** The DNS zone the build note holds for a cluster, or '' when this box has none. */
export function zoneOf(name: string): string {
  const record = remembered().find((entry) => entry.name === name);
  const zone = record?.zone;
  return typeof zone === 'string' ? zone : '';
}

/**
 * Set or change a cluster's zone after the build: in the note here, and as a tag on the
 * cluster so every other machine reads the same answer. Best effort on the tag -- the
 * note is written first, so a refused tag still leaves this box able to default a name.
 */
export async function rememberZone(name: string, region: string, zone: string): Promise<void> {
  const record = remembered().find((entry) => entry.name === name);
  await remember(name, {
    region: typeof record?.region === 'string' && record.region !== '' ? record.region : region,
    account: typeof record?.account === 'string' ? record.account : '',
    expires: typeof record?.expires === 'string' ? record.expires : '',
    zone,
  });
  const seen = await aws.describeCluster(name, region);
  if (seen.state !== PRESENT) return;
  const arn = String(seen.doc.arn ?? '');
  if (arn === '') return;
  await awsCli.run(
    [
      IDENTITY_TOOL,
      'eks',
      'tag-resource',
      '--resource-arn',
      arn,
      '--tags',
      `${ZONE_TAG_KEY}=${zone}`,
    ],
    { timeoutMs: asMs(IDENTITY_TIMEOUT) },
  );
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
/**
 * The region a cluster was built in, from its local note, or '' when this box has none.
 *
 * `cluster delete` without `--region` looked in the AWS CLI's default region, found nothing,
 * printed "nothing to delete" and left the cluster billing where `cluster create` had put
 * it. The note written at build time already held the answer.
 */
export function rememberedRegion(name: string): string {
  const record = remembered().find((entry) => entry.name === name);
  const region = record?.region;
  return typeof region === 'string' ? region : '';
}

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
  const stopping = blockers(pre, { toBuild: true });
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

/**
 * Where the user's bare `kubectl` pointed before a build, put back: a context, or none.
 *
 * houston never moves it. eksctl writes its own context and makes it current, and `aws eks
 * update-kubeconfig` does the same, so a person whose `kubectl` pointed at production
 * found it pointing at the new, billing cluster. Read AFTER eksctl, "the previous context"
 * was eksctl's own, and that is what got restored (measured on a real build, 2026-10-05).
 */
async function currentKubectlContext(): Promise<string> {
  const pointed = await kube.run(['kubectl', 'config', 'current-context']);
  return pointed.returncode === 0 ? pointed.stdout.trim() : '';
}

async function pointKubectlBack(previous: string): Promise<void> {
  if ((await currentKubectlContext()) === previous) return;
  await kube.run(
    previous === ''
      ? ['kubectl', 'config', 'unset', 'current-context']
      : ['kubectl', 'config', 'use-context', previous],
  );
}

/** Point kubectl at what was just built, and make it able to serve a workspace. */
async function adoptTheNewCluster(
  emit: Emit,
  name: string,
  where: string,
  previous: string,
): Promise<[string, Prepared | Record<string, never>]> {
  const described = await aws.describeCluster(name, where);
  const context = String(described.doc?.arn ?? '');
  // PREPARE IS PART OF CREATE, because a cluster that cannot run a workspace is not a
  // finished answer to "create me a cluster". MEASURED: EKS ships no default
  // StorageClass, so without this the very next command refuses and the operator is left
  // patching a class by hand on a cluster they just paid twenty minutes for.
  let prepared: Prepared | Record<string, never> = {};
  if (context === '') return [context, prepared];

  // `aws eks update-kubeconfig` switches the merged kubeconfig's current context to the new
  // cluster; `previous` was read before eksctl ran, and is put back below.
  await awsCli.run(['aws', 'eks', 'update-kubeconfig', '--name', name, '--region', where], {
    timeoutMs: asMs(IDENTITY_TIMEOUT),
  });
  await pointKubectlBack(previous);
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
  // Announced rather than done quietly, because it changes where `up --runtime kubernetes`
  // lands, and a default that moved without saying so is worse than one you have to set.
  // It does NOT move a plain `up` off Docker (lifecycle/request.ts inferRuntime), and the
  // earlier wording said it did; people then ran `up` and got a Compose workspace.
  await updateLockedConfig((cfg) => {
    cfg[config.KUBE_CONTEXT_KEY] = context;
  });
  info(
    emit,
    "set as this box's default cluster — `houston up --runtime kubernetes` lands here " +
      'without --context; a plain `up` still makes a Docker workspace (change with ' +
      '`houston config set kubernetes.context <name>`)',
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
  zone: string,
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
      progress: eksctlProgress,
      emit,
      timeout: CLUSTER_CREATE_TIMEOUT,
    });
  } finally {
    if (temporary !== '') fs.rmSync(temporary, { recursive: true, force: true });
  }

  if (code !== 0) {
    // ASKED, NOT ASSUMED. A build refused at eksctl's first step -- checking who it is --
    // makes nothing, and "a partial create can still be billing" sent its owner looking
    // for a bill that did not exist. Only AWS answering "none" to every question says so.
    if (await nothingWasMade(name, where)) {
      clearJournal(entry);
      throw new CreateFailedError(
        `eksctl could not build '${name}' in ${where} (exit ${String(code)}); its last lines ` +
          'are above. AWS holds nothing of it -- no cluster, stack, volume, load balancer, ' +
          'NAT gateway or address -- so nothing is billing and there is nothing to delete.',
      );
    }
    // The note STAYS. eksctl may have built a VPC, a NAT gateway and a control plane
    // before failing, and houston is not going to decide on its own to destroy them.
    throw new CreateFailedError(
      `eksctl could not build '${name}' in ${where} (exit ${String(code)}); its last lines ` +
        'are above. A note has been kept: `houston doctor` and `houston cluster overview` ' +
        'report it, because a partial create can still be billing. Stop the bill with ' +
        `\`houston cluster delete ${name} --region ${where}\`; if that says there is no ` +
        `cluster, \`eksctl delete cluster --name ${name} --region ${where} --wait\` removes ` +
        'the stack it left.',
    );
  }

  clearJournal(entry);
  await remember(name, { region: where, account: pre.identity.account, expires, zone });
}

/** Whether AWS confirms a failed build left nothing. A read that failed is not "nothing". */
async function nothingWasMade(name: string, where: string): Promise<boolean> {
  const [cluster, left] = await Promise.all([
    clusterExists(name, where),
    sweepLeftovers(name, where),
  ]);
  return cluster.state === ABSENT && left.found.length === 0 && left.unreadable.length === 0;
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
    zone = '',
    emit = nullEmit,
  }: {
    region?: string;
    nodes?: number;
    subnets?: Record<string, string>;
    expiresDays?: number | null;
    /** The DNS zone workspace names live under; '' for none. Tagged and noted. */
    zone?: string;
    emit?: Emit;
  } = {},
): Promise<Record<string, unknown>> {
  const [pre, resolved] = await refuseACreateWeShouldNotMake(name, where);

  const expires = expiryDate(expiresDays);
  const doc = clusterConfig(name, {
    region: resolved,
    nodes,
    zone,
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

  // Read BEFORE eksctl runs, which moves it; put back on a failed build too.
  const previous = await currentKubectlContext();
  try {
    await buildTheCluster(doc, emit, expires, name, pre, resolved, zone);
  } catch (error) {
    await pointKubectlBack(previous);
    throw error;
  }
  info(emit, `cluster '${name}' is up in ${resolved}`, { phase: 'provision', pct: 100 });

  const [context, prepared] = await adoptTheNewCluster(emit, name, resolved, previous);
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
  // An ARN with the same final name may belong to another account or region. The
  // eksctl spelling omits the account entirely, so leave it if another account's
  // ARN for this name and region is present rather than guessing its owner.
  const ambiguousAlias = known.some(
    (entry) =>
      entry !== context &&
      entry.startsWith('arn:aws:eks:') &&
      entry.split(':')[3] === where &&
      entry.endsWith(`:cluster/${name}`),
  );
  const remove = new Set(
    known.filter((entry) => entry === context || (!ambiguousAlias && entry.endsWith(suffix))),
  );
  for (const alias of remove) {
    await forgetContext(alias);
  }
  // AND THE DEFAULT GOES WITH IT. A `kubernetes.context` pointing at a cluster that no
  // longer exists makes the next `up` fail on a context that cannot be found, which reads
  // as a bug in `up` rather than as the consequence of a delete.
  if (config.defaultKubeContext() === context || remove.has(config.defaultKubeContext())) {
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
    expectedArn = '',
    emit = nullEmit,
  }: { region?: string; force?: boolean; expectedArn?: string; emit?: Emit } = {},
): Promise<boolean> {
  const pre = await aws.preflight();
  // Typed region, else the region the build note remembers, else the AWS CLI's default.
  const resolved = where !== '' ? where : rememberedRegion(name) || pre.region;
  const stopping = blockers(pre);
  if (stopping.length > 0) {
    throw new PreflightError(`cannot delete an EKS cluster from here: ${stopping.join('; ')}`);
  }

  // A browser selection contains the full ARN. Refuse if the AWS identity changed
  // after review; a same-name cluster in another account can carry our ownership tag.
  const expected =
    expectedArn !== ''
      ? expectedArn.match(/^arn:[^:]+:eks:([^:]+):(\d{12}):cluster\/([^/]+)$/u)
      : null;
  if (
    expectedArn !== '' &&
    (expected === null || expected[1] !== resolved || expected[3] !== name)
  ) {
    throw new ValidationError('the selected EKS cluster ARN does not match its name and region');
  }
  const saved = remembered().filter((entry) => entry.name === name && entry.region === resolved);
  const expectedAccount =
    expected?.[2] ??
    (saved.length === 1 && typeof saved[0]?.account === 'string'
      ? (saved[0].account as string)
      : '');
  if (expectedAccount !== '' && expectedAccount !== pre.identity.account) {
    throw new AuthorityGateError(
      `cannot delete '${name}' in ${resolved}: selected account ${expectedAccount} differs from ` +
        `the current AWS account ${pre.identity.account}. Reconnect to the selected account and re-check.`,
      {
        kind: 'cluster',
        subject: name,
        approveWith: 'use the selected AWS account',
        code: 'GATE_WRONG_ACCOUNT',
      },
    );
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

  if (expectedArn !== '' && String(mine.doc.arn ?? '') !== expectedArn) {
    throw new AuthorityGateError(
      `cannot delete '${name}': AWS returned ${String(mine.doc.arn ?? 'no ARN')} instead of ${expectedArn}`,
      {
        kind: 'cluster',
        subject: name,
        approveWith: 're-check the selected cluster',
        code: 'GATE_WRONG_CLUSTER',
      },
    );
  }

  const context = await confirmDeletion(emit, force, mine, place);

  await releaseLoadBalancers(context, emit);
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
 * Every LoadBalancer Service gone before eksctl is asked to delete the VPC.
 *
 * A LoadBalancer Service holds network interfaces inside the cluster's VPC, and while it
 * exists the VPC delete hangs. The guide had the reader run a raw `kubectl delete svc -A`
 * against the pinned kubeconfig first -- step 4 of the teardown, the step most likely to
 * be skipped. houston installed that Service (Traefik's), so houston removes it, and waits
 * for AWS to let go of the load balancer before it goes on. A context that cannot be
 * reached skips this: the guards above have already decided a forced delete may proceed.
 */
async function releaseLoadBalancers(context: string, emit: Emit): Promise<void> {
  if (context === '') return;
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      'delete',
      'svc',
      '-A',
      '--field-selector',
      'spec.type=LoadBalancer',
      '--ignore-not-found',
    ],
    { timeout: APPLY_TIMEOUT_S },
  );
  // A FAILED DELETE IS NOT YET A FAILURE. `kubectl delete` waits on each Service's
  // load-balancer finalizer, which AWS clears only once the load balancer is gone, so a
  // timeout is usually a delete that went through and is still letting go. It warned
  // "could not be removed" about Services that were gone, and skipped the wait that would
  // have said so. The read below decides, either way.
  if (res.returncode !== 0) {
    info(
      emit,
      `the load balancer Services were asked to go (${oneLine(res)}); checking whether they did`,
      { phase: 'teardown' },
    );
  } else {
    info(emit, 'load balancer released — waiting for AWS to let go of it', { phase: 'teardown' });
  }
  let refused = false;
  for (let attempt = 0; attempt < LOADBALANCER_TRIES; attempt += 1) {
    const read = await loadbalancerRead(context);
    refused = read.refused;
    // "Could not ask" is not "gone": read as nothing left, a refused read sent the VPC to
    // eksctl with the load balancer still in it.
    if (!read.refused && read.name === '' && read.address === '' && read.pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, LOADBALANCER_INTERVAL * 1000));
  }
  warn(
    emit,
    refused
      ? 'the cluster could not be read to confirm its load balancer is gone; eksctl may hang on the VPC'
      : 'a load balancer is still there after waiting; eksctl may hang on the VPC',
    { phase: 'teardown' },
  );
}

/**
 * Approve an AWS account for spending on this box, and optionally record the Let's
 * Encrypt contact: the same two keys `houston config set` writes, for the GUI's build
 * flow. Through the locked writer, like every config write, so a `serve` and a CLI run
 * at the same moment cannot lose each other's change. The caller decides who may.
 */
export async function approveAccount(
  account: string,
  { acmeEmail = '' }: { acmeEmail?: string } = {},
): Promise<{ account: string; approved: string[]; acme_email: string }> {
  if (!/^[0-9]{12}$/u.test(account)) {
    throw new ValidationError('`account` wants the 12-digit AWS account id');
  }
  if (acmeEmail !== '' && !acmeEmail.includes('@')) {
    throw new ValidationError('`acme_email` wants an email address, or nothing');
  }
  let approved: string[] = [];
  const cfg = await updateLockedConfig((current) => {
    const known = new Set(
      String(current[config.CLOUD_ACCOUNTS_KEY] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    );
    known.add(account);
    approved = [...known].sort();
    current[config.CLOUD_ACCOUNTS_KEY] = approved.join(',');
    if (acmeEmail !== '') current.acme_email = acmeEmail;
  });
  return { account, approved, acme_email: String(cfg.acme_email ?? '') };
}

/**
 * Move a cluster's reminder date, `days` from today: the tag on the cluster and the note.
 *
 * The date is a reminder and nothing deletes on it, but extending it took `aws eks
 * tag-resource` by hand, and until then doctor and the overview nagged about a cluster
 * still in use. Only a cluster houston built: the same tag that authorises a delete.
 */
export async function keepCluster(
  name: string,
  { days, region: where = '' }: { days: number; region?: string },
): Promise<{ name: string; region: string; expires: string; days: number }> {
  const pre = await aws.preflight();
  const region = where !== '' ? where : rememberedRegion(name) || pre.region;
  const seen = await aws.describeCluster(name, region);
  if (seen.state === ABSENT) {
    throw new NotFoundError(
      `no EKS cluster named '${name}' in ${region} — \`houston cluster list\` finds it in whichever region it is`,
    );
  }
  if (seen.state !== PRESENT) {
    throw new PreflightError(
      `'${name}' in ${region} could not be read, so its tags cannot be changed`,
    );
  }
  const tags = (seen.doc.tags ?? {}) as Record<string, unknown>;
  if (tags[OWNED_TAG_KEY] !== OWNED_TAG_VALUE) {
    throw new AuthorityGateError(
      `'${name}' in ${region} was not created by houston — it carries no ${OWNED_TAG_KEY}=` +
        `${OWNED_TAG_VALUE} tag, and houston changes only the clusters it built.`,
      {
        kind: 'cluster',
        subject: `${name} (${region})`,
        approveWith: `aws eks tag-resource --resource-arn <arn> --tags ${EXPIRY_TAG_KEY}=<date>`,
        code: 'GATE_KEEP_UNOWNED',
      },
    );
  }
  const expires = expiryDate(days);
  const arn = String(seen.doc.arn ?? '');
  const res = await awsCli.run(
    [
      IDENTITY_TOOL,
      'eks',
      'tag-resource',
      '--resource-arn',
      arn,
      '--tags',
      `${EXPIRY_TAG_KEY}=${expires}`,
    ],
    { timeoutMs: asMs(IDENTITY_TIMEOUT) },
  );
  if (res.returncode !== 0)
    throw new PreflightError(`the expiry tag could not be written: ${oneLine(res)}`);
  const record = remembered().find((entry) => entry.name === name);
  await remember(name, {
    region,
    account: typeof record?.account === 'string' ? record.account : pre.identity.account,
    expires,
    zone: typeof record?.zone === 'string' ? record.zone : '',
  });
  return { name, region, expires, days };
}

/** The cluster-scoped policy an access entry needs for Helm and namespaces. */
const EKS_ADMIN_POLICY_ARN = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy';
/** The Kubernetes group the shipped RBAC document binds. */
const ENGINEERS_GROUP = 'houston-engineers';

/**
 * Let a colleague run workspaces on a cluster: the EKS access entry, the cluster-scoped
 * AWS policy, and the in-cluster RBAC the shipped document grants, in that order.
 *
 * The guide's colleague-access section: three aws commands and a kubectl apply, by hand,
 * and "the first alone is not enough" -- with only the IAM half every kubectl says
 * Unauthorized. An entry that already exists is not a failure: the policy and the RBAC
 * are applied again, which is what makes a second run a repair rather than an error.
 */
export async function shareCluster(
  name: string,
  { user, region: where = '' }: { user: string; region?: string },
): Promise<{
  name: string;
  region: string;
  user: string;
  principal: string;
  already: boolean;
  lines: string[];
}> {
  const pre = await aws.preflight();
  const region = where !== '' ? where : rememberedRegion(name) || pre.region;
  const seen = await aws.describeCluster(name, region);
  if (seen.state === ABSENT) {
    throw new NotFoundError(
      `no EKS cluster named '${name}' in ${region} — \`houston cluster list\` finds it in whichever region it is`,
    );
  }
  if (seen.state !== PRESENT) {
    throw new PreflightError(
      `'${name}' in ${region} could not be read, so nothing can be granted on it`,
    );
  }
  // THE TAG IS THE GATE, as it is for keep and delete: this grants cluster admin, and the
  // operator policy may create access entries on any cluster in the account.
  const tags = (seen.doc.tags ?? {}) as Record<string, unknown>;
  if (tags[OWNED_TAG_KEY] !== OWNED_TAG_VALUE) {
    throw new AuthorityGateError(
      `'${name}' in ${region} was not created by houston — it carries no ${OWNED_TAG_KEY}=` +
        `${OWNED_TAG_VALUE} tag, and houston grants access only to the clusters it built.`,
      {
        kind: 'cluster',
        subject: `${name} (${region})`,
        approveWith: `aws eks create-access-entry --cluster-name ${name} --region ${region} --principal-arn <arn>`,
        code: 'GATE_SHARE_UNOWNED',
      },
    );
  }
  const arn = String(seen.doc.arn ?? '');
  const principal = user.includes(':') ? user : `arn:aws:iam::${pre.identity.account}:user/${user}`;
  const entry = await awsCli.run(
    [
      IDENTITY_TOOL,
      'eks',
      'create-access-entry',
      '--cluster-name',
      name,
      '--region',
      region,
      '--principal-arn',
      principal,
      '--type',
      'STANDARD',
      '--kubernetes-groups',
      ENGINEERS_GROUP,
    ],
    { timeoutMs: asMs(IDENTITY_TIMEOUT) },
  );
  const already = entry.returncode !== 0 && entry.stderr.includes('ResourceInUseException');
  if (entry.returncode !== 0 && !already) {
    throw new PreflightError(
      `the access entry for ${principal} could not be created: ${oneLine(entry)}`,
    );
  }
  const policy = await awsCli.run(
    [
      IDENTITY_TOOL,
      'eks',
      'associate-access-policy',
      '--cluster-name',
      name,
      '--region',
      region,
      '--principal-arn',
      principal,
      '--policy-arn',
      EKS_ADMIN_POLICY_ARN,
      '--access-scope',
      'type=cluster',
    ],
    { timeoutMs: asMs(IDENTITY_TIMEOUT) },
  );
  if (policy.returncode !== 0 && !policy.stderr.includes('ResourceInUseException')) {
    throw new PreflightError(`the cluster policy could not be associated: ${oneLine(policy)}`);
  }
  const rbac = await kube.run(['kubectl', '--context', arn, 'apply', '-f', '-'], {
    input: readIamDocument('rbac'),
    timeout: APPLY_TIMEOUT_S,
  });
  if (rbac.returncode !== 0) {
    // HALF A GRANT is still a grant: the access entry and its AmazonEKSAdminPolicy are in
    // place. Say so, and how to take them back, rather than leave a silent admin behind.
    throw new PreflightError(
      `the in-cluster RBAC could not be applied (${oneLine(rbac)}). ${principal} already has ` +
        `an access entry on '${name}' with AmazonEKSAdminPolicy; run this again once kubectl ` +
        `reaches the cluster, or take it back with \`aws eks delete-access-entry --cluster-name ` +
        `${name} --region ${region} --principal-arn ${principal}\`.`,
    );
  }
  return {
    name,
    region,
    user,
    principal,
    already,
    lines: [
      `aws eks update-kubeconfig --name ${name} --region ${region}`,
      `houston up --version <version> --name <ticket> --context ${name}`,
    ],
  };
}

/** One thing AWS still holds after a delete, and the command that removes it. */
export interface Leftover {
  kind: string;
  id: string;
  detail: string;
  /** The command that removes it; '' when nothing ties it to this cluster. */
  fix: string;
  /** Tied to the deleted cluster by a tag eksctl or Kubernetes put on it. */
  certain: boolean;
}

export interface Leftovers {
  found: Leftover[];
  unreadable: { kind: string; why: string }[];
}

/**
 * What outlives a deleted cluster and keeps billing, read from AWS with the operator
 * policy's own rights. "The command returned" is not "nothing is billing": a volume left
 * by a workspace deleted with the cluster, a load balancer, a NAT gateway, an Elastic IP,
 * a CloudFormation stack that rolled back half way.
 *
 * ONLY THIS CLUSTER'S. A region holds colleagues' clusters too, and a region-wide list of
 * load balancers and NAT gateways, each with its delete command, hands out commands that
 * break someone else's running cluster. So each resource is tied to `name` by a tag:
 * CloudFormation's `aws:cloudformation:stack-name` on the network eksctl built (the NAT
 * gateway, the Elastic IP), `kubernetes.io/cluster/<name>` on what Kubernetes created
 * (the load balancer, and a volume when the EBS driver tags it). A Rocket.Chat volume
 * that carries no cluster tag at all is shown as a candidate WITHOUT a command, and one
 * tagged for another cluster is not shown.
 */
export async function sweepLeftovers(name: string, region: string): Promise<Leftovers> {
  const out: Leftovers = { found: [], unreadable: [] };
  const ownTag = `kubernetes.io/cluster/${name}`;
  const stackFilter = `Name=tag:aws:cloudformation:stack-name,Values=eksctl-${name}-cluster`;
  const ask = async (kind: string, args: string[]): Promise<unknown> => {
    const res = await awsCli.run([IDENTITY_TOOL, ...args, '--region', region, '--output', 'json'], {
      timeoutMs: asMs(SWEEP_TIMEOUT),
    });
    if (res.returncode !== 0) {
      out.unreadable.push({ kind, why: oneLine(res) });
      return null;
    }
    try {
      return JSON.parse(res.stdout || 'null');
    } catch {
      out.unreadable.push({ kind, why: 'the answer could not be parsed' });
      return null;
    }
  };
  const rows = (value: unknown): string[][] =>
    Array.isArray(value)
      ? value
          .filter(Array.isArray)
          .map((row: unknown[]) =>
            row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
          )
      : [];
  const taggedOwn = (value: unknown, idKey: string): Set<string> => {
    const owned = new Set<string>();
    const doc = (value ?? {}) as {
      TagDescriptions?: { Tags?: { Key?: string; Value?: string }[] }[];
    };
    for (const entry of doc.TagDescriptions ?? []) {
      const tags = entry.Tags ?? [];
      const mine = tags.some(
        (tag) => tag.Key === ownTag || (tag.Key === 'elbv2.k8s.aws/cluster' && tag.Value === name),
      );
      const id = (entry as Record<string, unknown>)[idKey];
      if (mine && typeof id === 'string') owned.add(id);
    }
    return owned;
  };

  // Volumes: the Rocket.Chat ones (the EBS driver's created-for tag), then by cluster tag.
  for (const [id, size, created, keys] of rows(
    await ask('volume', [
      'ec2',
      'describe-volumes',
      '--filters',
      'Name=status,Values=available',
      'Name=tag-key,Values=kubernetes.io/created-for/pvc/name',
      '--query',
      "Volumes[].[VolumeId,Size,CreateTime,join(',',Tags[].Key)]",
    ]),
  )) {
    const tagKeys = (keys ?? '').split(',');
    const detail = `${size ?? '?'} GB, created ${created ?? '?'}`;
    if (tagKeys.includes(ownTag)) {
      out.found.push({
        kind: 'volume',
        id: id ?? '',
        detail: `${detail} — an IAM administrator deletes it`,
        fix: `aws ec2 delete-volume --region ${region} --volume-id ${id ?? ''}`,
        certain: true,
      });
    } else if (!tagKeys.some((key) => key.startsWith('kubernetes.io/cluster/'))) {
      out.found.push({
        kind: 'volume',
        id: id ?? '',
        certain: false,
        fix: '',
        detail: `${detail} — a Rocket.Chat volume not tagged with any cluster; check it is not another cluster's before deleting`,
      });
    }
  }

  // Load balancers: listed, then kept only when their tags name this cluster.
  const classic = rows(
    await ask('load balancer', [
      'elb',
      'describe-load-balancers',
      '--query',
      'LoadBalancerDescriptions[].[LoadBalancerName,DNSName]',
    ]),
  );
  if (classic.length > 0) {
    const owned = taggedOwn(
      await ask('load balancer', [
        'elb',
        'describe-tags',
        '--load-balancer-names',
        ...classic.slice(0, 20).map((row) => row[0] ?? ''),
      ]),
      'LoadBalancerName',
    );
    for (const [id, dns] of classic) {
      if (!owned.has(id ?? '')) continue;
      out.found.push({
        kind: 'load balancer',
        id: id ?? '',
        detail: dns ?? '',
        certain: true,
        fix: `aws elb delete-load-balancer --region ${region} --load-balancer-name ${id ?? ''}`,
      });
    }
  }
  const modern = rows(
    await ask('load balancer', [
      'elbv2',
      'describe-load-balancers',
      '--query',
      'LoadBalancers[].[LoadBalancerName,DNSName,LoadBalancerArn]',
    ]),
  );
  if (modern.length > 0) {
    const owned = taggedOwn(
      await ask('load balancer', [
        'elbv2',
        'describe-tags',
        '--resource-arns',
        ...modern.slice(0, 20).map((row) => row[2] ?? ''),
      ]),
      'ResourceArn',
    );
    for (const [id, dns, arn] of modern) {
      if (!owned.has(arn ?? '')) continue;
      out.found.push({
        kind: 'load balancer',
        id: id ?? '',
        detail: dns ?? '',
        certain: true,
        fix: `aws elbv2 delete-load-balancer --region ${region} --load-balancer-arn ${arn ?? ''}`,
      });
    }
  }

  // The network eksctl built: tagged with its stack by CloudFormation.
  for (const [id, vpc] of rows(
    await ask('nat gateway', [
      'ec2',
      'describe-nat-gateways',
      '--filter',
      'Name=state,Values=available',
      stackFilter,
      '--query',
      'NatGateways[].[NatGatewayId,VpcId]',
    ]),
  )) {
    out.found.push({
      kind: 'nat gateway',
      id: id ?? '',
      detail: `in ${vpc ?? '?'}`,
      certain: true,
      fix: `aws ec2 delete-nat-gateway --region ${region} --nat-gateway-id ${id ?? ''}`,
    });
  }
  for (const [id, ip] of rows(
    await ask('elastic ip', [
      'ec2',
      'describe-addresses',
      '--filters',
      stackFilter,
      '--query',
      'Addresses[?AssociationId==null].[AllocationId,PublicIp]',
    ]),
  )) {
    out.found.push({
      kind: 'elastic ip',
      id: id ?? '',
      detail: ip ?? '',
      certain: true,
      fix: `aws ec2 release-address --region ${region} --allocation-id ${id ?? ''}`,
    });
  }
  for (const [id, status] of rows(
    await ask('stack', [
      'cloudformation',
      'list-stacks',
      '--query',
      `StackSummaries[?starts_with(StackName, 'eksctl-${name}-') && StackStatus!='DELETE_COMPLETE'].[StackName,StackStatus]`,
    ]),
  )) {
    out.found.push({
      kind: 'stack',
      id: id ?? '',
      detail: status ?? '',
      certain: true,
      fix:
        `eksctl delete cluster --name ${name} --region ${region} --wait, or if it says the cluster ` +
        `does not exist: aws cloudformation delete-stack --region ${region} --stack-name ${id ?? ''}`,
    });
  }
  return out;
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
/**
 * The upstream metrics-server manifest, pinned. `stats` and the GUI's Containers tab read
 * `kubectl top`, which needs it, and `cluster create` did not install it: the guide had
 * the reader apply this by hand. kubectl fetches it, which is the kubectl seam's business.
 */
/** Seconds a `kubectl apply` of a small manifest may take over the network. */
const APPLY_TIMEOUT_S = 120;

export const METRICS_SERVER_VERSION = 'v0.7.2';
export const METRICS_SERVER_MANIFEST =
  'https://github.com/kubernetes-sigs/metrics-server/releases/download/' +
  `${METRICS_SERVER_VERSION}/components.yaml`;

/**
 * metrics-server on a managed cluster that lacks it; adopted where it answers already.
 *
 * ONLY on a managed cluster. kind needs an insecure-TLS patch this manifest does not carry
 * (and `stats` says so there), and k3s ships its own. A refused install is reported, not
 * fatal: the cluster runs workspaces without it, only `stats` goes quiet.
 */
export async function installMetricsServer(
  context: string,
  distribution: string,
  emit: Emit,
  out: { already: string[]; metrics_server: boolean },
): Promise<void> {
  if (distribution !== 'eks') return;
  if (await metricsAvailable(context)) {
    out.already.push('metrics-server');
    out.metrics_server = true;
    return;
  }
  const res = await kube.run(
    ['kubectl', '--context', context, 'apply', '-f', METRICS_SERVER_MANIFEST],
    {
      timeout: APPLY_TIMEOUT_S,
    },
  );
  if (res.returncode !== 0) {
    warn(
      emit,
      `metrics-server could not be installed: ${oneLine(res)} — \`houston stats\` will say how`,
      {
        phase: 'provision',
      },
    );
    return;
  }
  info(emit, 'installing metrics-server — `houston stats` and the Containers tab read it', {
    phase: 'provision',
  });
  out.metrics_server = true;
}

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
  /** The DNS zone workspace names live under, from --zone or the note; '' for none. */
  zone: string;
  /** metrics-server answering, installed here or already there; false where it is not ours to install. */
  metrics_server: boolean;
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
  out.cname_pending = address === '' && (await loadbalancerRead(context)).pending > 0;
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
  { emit = nullEmit, zone = '' }: { emit?: Emit; zone?: string } = {},
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
    zone: '',
    metrics_server: false,
    already: [],
    kept: '',
  };

  await storageAndIngress(resolved, emit, out);
  await loadbalancerAddress(resolved, emit, out);
  await installMetricsServer(resolved, await distribution(resolved), emit, out);
  // The zone, set or changed after the build: noted here and tagged on the cluster.
  const short = resolved.split('/').pop() ?? resolved;
  if (zone !== '') {
    await rememberZone(short, regionOfContext(resolved), zone);
    info(emit, `zone ${zone} noted — workspaces here are named <name>.${zone} by default`, {
      phase: 'provision',
    });
  }
  out.zone = zone !== '' ? zone : zoneOf(short);
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
