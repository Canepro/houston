/**
 * A secret-safe, backend-neutral record of what was deployed and how it behaved: the
 * thing a person attaches to a support case.
 *
 * `info --json` is the wrong thing to attach. Its `login` block carries the admin password
 * and its `root_url` is whatever was recorded, path and userinfo included. Two properties
 * follow from "attachable", and neither is optional:
 *
 * - DELIBERATE REDACTION. The root URL is reduced to its origin, bundle artifacts mask the
 *   workspace's known admin password and credential-shaped fields, and raw logs stay in the
 *   workspace rather than entering an attachment. Unknown values under arbitrary custom YAML
 *   keys cannot be classified as credentials safely.
 * - BACKEND-NEUTRAL. The `repro` block is the same shape for Docker and Kubernetes, and
 *   `runtime` keeps one shape with different contents, so a consumer reads it without
 *   branching on where the workspace ran.
 *
 * `license` and `retention` are recorded because a conclusion drawn from a run depends on
 * them. An unlicensed microservices workspace can look healthy while not behaving as
 * licensed, and citing it as proof without that caveat is the harm the field prevents. The
 * cleanup handle is a literal command rather than a description, so a person can paste it
 * months later without knowing the runtime.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as YAML from 'yaml';

import { renderMarkdown as renderBundleMarkdown } from '../lib/capture-render';
import {
  CREDENTIALS_PENDING,
  type ComposeDoc,
  imageRef,
  suppliedCredentials,
} from '../lib/compose';
import * as config from '../lib/config';
import { ValidationError } from '../lib/errors';
import { isTruthy, quotedText, toText } from '../lib/format';
import { pathExpandUser } from '../lib/home';
import {
  argumentCredentials,
  argumentListKey,
  argumentWords,
  authorizationCredentials,
  authorizationHeaders,
  commandCarriesCredential,
  credentialArgument,
  credentialFlagWord,
  httpUserPassword,
  healthcheckKey,
  HTTP_USER_PREFIX,
  httpUsers,
  shortOptionPasswords,
  userArgument,
  userPasswordClient,
  valueTakingCredentialFlag,
  credentialKey,
  discoverTextSecrets,
  type KnownSecret,
  REDACTED,
  redactAssignedText,
  redactKnownValues,
} from '../lib/redact';
import { namesOf } from '../lib/presets/composite';
import * as presets from '../lib/presets/index';
import { PROFILES } from '../lib/seed-profiles';
import { SCENARIOS } from '../lib/seed-options';
import { Interrupted } from '../seams/exec';
import { OWNER_LABEL_KEY, OWNER_LABEL_VALUE, WORKSPACE_LABEL } from './kube/names';
import { namespaceLabels } from './kube/namespace';
import * as naming from './lifecycle/naming';
import { detail } from './lifecycle/payload';
import { composeVersion, dockerServerVersion } from './runner/host';
import { reproLock } from './runner/locks';
import * as paths from './runner/paths';
import { adminPass, type Metadata, projectName, readCompose, readMeta } from './runner/record';
import * as topology from './topology';

export { renderMarkdown } from '../lib/capture-render';

/** The portable record name and native filesystem path of each runtime's deployment artifact. */
const DOCKER_ARTIFACT = { name: 'docker-compose.yml', path: ['docker-compose.yml'] } as const;
const KUBERNETES_ARTIFACT = {
  name: 'kubernetes/values.yaml',
  path: ['kubernetes', 'values.yaml'],
} as const;

/** Only these reasons may appear on a retained run, so nobody invents a softer one. */
const RETAIN_REASONS: readonly string[] = ['persisted preference', 'explicit task'];

const SEED_ROOM_KINDS: readonly string[] = [
  'channel',
  'private',
  'team',
  'team-private',
  'team-channel',
  'team-channel-private',
  'discussion',
  'dm',
  'group-dm',
  'scenario-read-only',
  'scenario-broadcast',
  'scenario-archived',
  'scenario-permissions',
];

const PLANNED_SEED_COUNTS: readonly string[] = [
  'rooms_total',
  'messages',
  'threads',
  'users',
  'thread_parents',
  'files',
  'reaction_actions',
  'pins',
  'stars',
  'mentions',
  'edits',
];

const ACTUAL_SEED_COUNTS: readonly string[] = [
  'users',
  'rooms_total',
  'messages',
  'threads',
  'dms',
];

const VERIFIED_SEED_COUNTS: readonly string[] = ['checked', 'checks_completed'];
const VERIFIED_FEATURE_COUNTS: readonly string[] = [
  'messages',
  'replies',
  'reactions',
  'pins',
  'stars',
  'mentions',
  'edits',
  'files',
  'thread_parents',
];
const SEED_FEATURE_COUNTS: readonly string[] = ['files', 'total_content'];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

interface CapturedArtifact {
  name: string;
  sha256: string;
  bytes: Buffer | null;
}

interface Snapshot {
  payload: Record<string, unknown>;
  artifact: CapturedArtifact;
  knownSecrets: string[];
}

/** What `writeBundle` returns: where it wrote, and every file, relative to it. */
export interface Bundle {
  path: string;
  files: string[];
}

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A URL reduced to `scheme://host[:port]`, dropping path, query and userinfo, or
 * `REDACTED` for anything that is not an http(s) URL with a host. Credentials in a URL are
 * the classic accidental leak, and a path can carry a ticket id or a customer name. The
 * origin is all evidence needs.
 */
export function safeOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'REDACTED';
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
    return 'REDACTED';
  }
  // `URL` keeps a bracketed IPv6 hostname bracketed, and drops a port that is the
  // scheme's default, which is the origin as a browser would print it.
  return parsed.port === ''
    ? `${parsed.protocol}//${parsed.hostname}`
    : `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

/** Quote legacy names that cannot safely appear as a bare shell argument. */
function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The exact command that removes this workspace, valid on any machine holding it. */
export function cleanupCommand(name: string): string {
  return `houston down --name ${shellArgument(name)} --volumes --yes`;
}

async function artifactOf(meta: Metadata): Promise<CapturedArtifact> {
  // A runtime switch deliberately leaves the old runtime's files behind for inspection. The
  // metadata names the deployment that exists now, so evidence must not discover an artifact
  // by filesystem order and attach the stale one.
  const candidate =
    topology.ofMeta(meta) === topology.KUBERNETES ? KUBERNETES_ARTIFACT : DOCKER_ARTIFACT;
  // Both runtimes mark the record incomplete before replacing deployment files.
  // Until the write finishes, the file on disk can be the previous release's, and attaching it
  // beside the new request would describe a deployment that may not exist. Unavailable is
  // what evidence can truthfully say.
  if (bag(meta.extra).incomplete === true) return { name: '', sha256: '', bytes: null };
  try {
    const bytes = await fs.readFile(path.join(paths.workspace(meta.name), ...candidate.path));
    return {
      name: candidate.name,
      sha256: sha256(bytes),
      bytes,
    };
  } catch (error) {
    // A record-first Docker create can be interrupted before its optional Compose artifact.
    // Other filesystem failures still make the snapshot unsafe to claim as complete evidence.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { name: '', sha256: '', bytes: null };
    }
    throw error;
  }
}

/**
 * How houston knows the workspace is its own, stated so a teardown decision is auditable
 * after the fact. A name prefix is not ownership: Kubernetes proves it by label, Compose by
 * the record that names the project.
 */
async function ownershipOf(meta: Metadata, runtime: string): Promise<Record<string, unknown>> {
  if (runtime === topology.KUBERNETES) {
    const extra = bag(meta.extra);
    // A record without both fields cannot identify one namespace on one cluster. Never turn a
    // current detail response, default Kind context, or derived namespace into ownership proof.
    const namespace = toText(extra.namespace);
    const context = toText(extra[config.EXTRA_CONTEXT]);
    if (namespace === '' || context === '') {
      return { proof: 'unknown', managed_by: 'unknown', namespace };
    }
    try {
      const labels = await namespaceLabels(namespace, { context });
      if (
        labels?.[OWNER_LABEL_KEY] === OWNER_LABEL_VALUE &&
        labels[WORKSPACE_LABEL] === meta.name
      ) {
        return { proof: 'label', managed_by: 'houston', namespace };
      }
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      // A context, namespace name, or local record is not ownership proof. Evidence remains
      // useful when Kubernetes cannot answer, but it must say that this claim is unknown.
    }
    return { proof: 'unknown', managed_by: 'unknown', namespace };
  }
  return { proof: 'record', managed_by: 'houston', project: await projectName(meta.name) };
}

/**
 * Whether a licence was needed and whether one was supplied. Never the value, only
 * whether and from where. A licence takes precedence when both it and a registration token
 * were supplied. Both markers are booleans only; no credential value reaches the record.
 *
 * `required` is read from the record when the create wrote it (`license_required`), so an
 * edited or removed preset does not rewrite history. For a legacy record, a known
 * microservices deployment remains true; an unavailable preset makes the requirement unknown
 * unless another recorded component establishes that it was required. `supplied` is `null`
 * when the record cannot say: a Kubernetes record from before `reg_token_supplied` existed put
 * the token in a Secret this reader does not open, a Docker write that did not finish may
 * have left the previous compose file, and an `env` credential change waits for a recreate. A
 * Docker record from before the markers is asked through its compose file, which is where the
 * token went.
 */
async function licenseOf(meta: Metadata, deployment: string): Promise<Record<string, unknown>> {
  const extra = bag(meta.extra);
  let required: boolean | null;
  if (typeof extra.license_required === 'boolean') {
    required = extra.license_required;
  } else if (deployment === topology.MICROSERVICES) {
    // A microservices deployment needs a licence independently of any scenario preset.
    required = true;
  } else {
    let unavailable = false;
    required = false;
    for (const name of namesOf(meta.preset).filter((item) => item !== 'default')) {
      try {
        // A runtime adapter may carry a topology marker: Kubernetes LDAP's `requiresLicense`
        // does. The catalog is the semantic source for a preset's own requirement, whether it
        // is user YAML, a scenario, or built in.
        if (presets.load(name).requiresLicense) {
          required = true;
          break;
        }
      } catch {
        // A removed or unreadable legacy preset must not be relabelled as unlicensed. Keep
        // checking because another component can still prove the OR'd requirement was true.
        unavailable = true;
      }
    }
    if (!required && unavailable) required = null;
  }
  // An unfinished Docker write recorded the request, and its Compose file can still be the
  // previous one, so neither says what Rocket.Chat was handed. Nor does a credential `env`
  // configured before a recreate succeeded: the markers and the Compose file describe the
  // configuration, and the running container can still have the previous one. A Kubernetes
  // provisional record states what is deployed, and keeps its markers.
  if (
    topology.ofMeta(meta) !== topology.KUBERNETES &&
    (extra.incomplete === true || extra[CREDENTIALS_PENDING] === true)
  ) {
    return { required, supplied: null, source: 'unknown' };
  }
  // Kubernetes `licensed` is the Secret lifecycle flag: a killed create can set it before Helm
  // installs the licence. `effective_license`, when recorded, is what Rocket.Chat ran with,
  // and inspect and the notes read it the same way.
  const licensed =
    extra.effective_license === null
      ? false
      : typeof extra.effective_license === 'boolean'
        ? extra.effective_license
        : extra.licensed === true;
  if (licensed) return { required, supplied: true, source: 'license' };
  const licenseUnknown = extra.effective_license === null;
  if (extra.reg_token_supplied === true)
    return { required, supplied: true, source: licenseUnknown ? 'unknown' : 'reg_token' };
  if (licenseUnknown || extra.reg_token_supplied === null)
    return { required, supplied: null, source: 'unknown' };
  if (extra.reg_token_supplied === false) return { required, supplied: false, source: null };
  const inferred = await credentialsInCompose(meta);
  if (inferred === null) return { required, supplied: null, source: 'unknown' };
  if (inferred.license === true) return { required, supplied: true, source: 'license' };
  if (inferred.token === true)
    return {
      required,
      supplied: true,
      source: inferred.license === 'unknown' ? 'unknown' : 'reg_token',
    };
  if (inferred.license === 'unknown' || inferred.token === 'unknown')
    return { required, supplied: null, source: 'unknown' };
  return { required, supplied: false, source: null };
}

/**
 * What the generated compose file hands Rocket.Chat, for a record from before the markers
 * existed; `null` when it cannot be read.
 */
async function credentialsInCompose(
  meta: Metadata,
): Promise<Awaited<ReturnType<typeof suppliedCredentials>> | null> {
  if (topology.ofMeta(meta) === topology.KUBERNETES) return null;
  let doc: Record<string, unknown>;
  try {
    doc = await readCompose(meta.name);
  } catch {
    return null;
  }
  return await suppliedCredentials(doc as ComposeDoc, paths.workspace(meta.name));
}

/**
 * Retain or tear down, from what was asked. A retained run must name why, and the reason
 * is one of two so an agent cannot invent a soft justification for leaving state behind.
 */
export function resolveRetention({
  retained = null,
  reason = '',
}: { retained?: boolean | null; reason?: string } = {}): {
  retained: boolean;
  reason: string | null;
} {
  if (retained === true) {
    const why = reason.trim() === '' ? 'explicit task' : reason.trim();
    if (!RETAIN_REASONS.includes(why)) {
      throw new ValidationError(
        `retained evidence reason must be ${RETAIN_REASONS.map((r) => `'${r}'`).join(' or ')}`,
      );
    }
    return { retained: true, reason: why };
  }
  return { retained: false, reason: null };
}

function retentionOf(
  meta: Metadata,
  requested: { retained?: boolean | null; reason?: string },
): { retained: boolean; reason: string | null } {
  const selected = resolveRetention(requested);
  // This records selection, not enforcement: prune preserves a pin, while an unpinned
  // preference remains a request for the current evidence task. An explicit false wins
  // unless that existing pin keeps the workspace.
  if (selected.retained) return selected;
  if (isTruthy(meta.pinned)) return { retained: true, reason: 'persisted preference' };
  if (requested.retained === false) return selected;
  if (bag(config.loadConfig(false).preferences).retain_runs === true) {
    return { retained: true, reason: 'persisted preference' };
  }
  return selected;
}

function servicesOf(containers: unknown): { service: string; state: string; status: string }[] {
  return (Array.isArray(containers) ? containers : []).map((row) => {
    const item = bag(row);
    return {
      service: toText(item.service),
      state: toText(item.state),
      status: toText(item.status),
    };
  });
}

/** The persisted workspace credential is safe to use only as an in-memory redaction value. */
function knownWorkspaceSecrets(meta: Metadata): string[] {
  const password = adminPass(meta);
  return typeof password === 'string' && password !== '' ? [password] : [];
}

function safeCount(value: unknown, allowNull = false): number | null | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return allowNull && value === null ? null : undefined;
}

function countFields(
  value: unknown,
  fields: readonly string[],
  allowNull = false,
): Record<string, number | null> {
  const source = bag(value);
  const out: Record<string, number | null> = {};
  for (const field of fields) {
    const count = safeCount(source[field], allowNull);
    if (count !== undefined) out[field] = count;
  }
  return out;
}

function roomCounts(
  value: unknown,
  allowNull = false,
): Record<string, number | null> | null | undefined {
  if (allowNull && value === null) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const source = bag(value);
  const out: Record<string, number | null> = {};
  for (const kind of SEED_ROOM_KINDS) {
    const count = safeCount(source[kind]);
    if (count !== undefined) out[kind] = count;
  }
  return out;
}

function seedFacts(value: unknown): Record<string, unknown> | null {
  const source = bag(value);
  const profile = source.profile;
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) return null;

  const out: Record<string, unknown> = { profile };
  const planned: Record<string, unknown> = countFields(source.planned, PLANNED_SEED_COUNTS);
  const plannedRooms = roomCounts(bag(source.planned).rooms);
  if (plannedRooms !== undefined) planned.rooms = plannedRooms;
  if (Object.keys(planned).length > 0) out.planned = planned;

  const actual: Record<string, unknown> = countFields(source.actual, ACTUAL_SEED_COUNTS, true);
  const actualRooms = roomCounts(bag(source.actual).rooms, true);
  if (actualRooms !== undefined) actual.rooms = actualRooms;
  if (Object.keys(actual).length > 0) out.actual = actual;

  const verification: Record<string, unknown> = countFields(
    source.verification,
    VERIFIED_SEED_COUNTS,
    true,
  );
  const rawVerification = bag(source.verification);
  if (rawVerification.ok === true || rawVerification.ok === false || rawVerification.ok === null)
    verification.ok = rawVerification.ok;
  const verifiedFeatures = countFields(rawVerification.features, VERIFIED_FEATURE_COUNTS, true);
  if (Object.keys(verifiedFeatures).length > 0) verification.features = verifiedFeatures;
  if (Object.keys(verification).length > 0) out.verification = verification;

  if (Array.isArray(source.scenarios)) {
    out.scenarios = [
      ...new Set(
        source.scenarios.filter(
          (scenario): scenario is string =>
            typeof scenario === 'string' && Object.hasOwn(SCENARIOS, scenario),
        ),
      ),
    ].sort();
  }

  const features = countFields(source.features, SEED_FEATURE_COUNTS, true);
  if (Object.keys(features).length > 0) out.features = features;
  if (
    typeof source.at === 'string' &&
    ISO_TIMESTAMP.test(source.at) &&
    !Number.isNaN(Date.parse(source.at))
  )
    out.at = source.at;
  return out;
}

/** Capture the record and raw artifact bytes while the workspace lock is held. */
async function snapshotOf(
  target: string,
  retention: { retained?: boolean | null; reason?: string },
): Promise<Snapshot> {
  const meta = await readMeta(target);
  const runtime = topology.ofMeta(meta);
  const axes = topology.axesOfMeta(meta);
  const artifact = await artifactOf(meta);
  const extra = bag(meta.extra);
  // `write()` makes repro.json visible before docker-compose.yml. That incomplete but valid
  // workspace still has attachable metadata; do not call detail(), whose Docker path reads the
  // absent file. The record already holds the create-time bind, while runtime and artifact stay
  // unknown. A present artifact still takes the normal detail path, including every error.
  const d =
    runtime === topology.DOCKER && artifact.bytes === null
      ? {
          deployment: toText(axes.deployment),
          bind_host: toText(extra.bind_host),
          state: '?',
          containers: [],
        }
      : await detail(target);
  const deployment = toText(d.deployment) || toText(axes.deployment);

  let engine: Record<string, unknown>;
  if (runtime === topology.KUBERNETES) {
    engine = {
      kind: 'kubernetes',
      context: toText(d.context),
      cluster: toText(d.cluster),
      namespace: toText(d.namespace),
    };
  } else {
    engine = {
      kind: 'compose',
      docker_version: (await dockerServerVersion()) ?? '',
      compose_version: (await composeVersion()) ?? '',
    };
  }

  const keep = retentionOf(meta, retention);
  const payload: Record<string, unknown> = {
    // Identical shape on both runtimes, so a consumer never branches here.
    repro: {
      name: meta.name,
      // `multi-instance` is a deployment representation in old Compose records, not a
      // scenario preset. The normalized axes retain actual scenarios while removing it.
      preset: toText(axes.preset),
      runtime,
      deployment,
      rc_version: meta.rcVersion,
      rc_image: imageRef(meta.rcImage, meta.rcVersion),
      mongo_tag: meta.mongoTag,
      mongo_flavor: meta.mongoFlavor,
      // Origin only: never a path, query or userinfo.
      root_url: safeOrigin(meta.rootUrl),
      public_url: meta.publicUrl === '' ? '' : safeOrigin(meta.publicUrl),
      host_port: meta.hostPort,
      bind_host: toText(d.bind_host),
      version_source: meta.versionSource,
      created_at: meta.createdAt,
    },
    runtime: { state: toText(d.state), services: servicesOf(d.containers), engine },
    artifact: { name: artifact.name, sha256: artifact.sha256 },
    ownership: await ownershipOf(meta, runtime),
    license: await licenseOf(meta, deployment),
    retention: {
      retained: keep.retained,
      reason: keep.reason,
      cleanup: cleanupCommand(meta.name),
      owner: 'houston',
      created_at: meta.createdAt,
    },
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
  };
  // Seed metadata belongs to the workspace record, not the attachment. Keep only the fixed
  // count and status fields a reader needs; ids, locations, errors and unknown additions can
  // carry customer data or credentials.
  const seed = isTruthy(extra.seed) ? seedFacts(extra.seed) : null;
  if (seed !== null) payload.seed = seed;
  return { payload, artifact, knownSecrets: knownWorkspaceSecrets(meta) };
}

/**
 * The evidence record for a workspace. Reads the same detail `info` reads, then keeps
 * only what is safe to attach: the `login` block and the recorded URLs never reach the
 * output, and the `env` rows (masked for a panel, not for a stranger) are dropped whole.
 */
export async function record(
  name: string,
  retention: { retained?: boolean | null; reason?: string } = {},
): Promise<Record<string, unknown>> {
  const target = await naming.resolveName(name);
  return await reproLock(target, async () => (await snapshotOf(target, retention)).payload);
}

/**
 * Mask exact credentials the workspace record names, even below a benign YAML key. Key-name
 * redaction still protects standard deployment fields, but cannot discover an unknown secret in
 * arbitrary YAML.
 */
function redactKnownSecrets(value: string, knownSecrets: readonly KnownSecret[]): string {
  return redactKnownValues(value, knownSecrets);
}

function matchesKnownSecret(value: string, knownSecrets: readonly KnownSecret[]): boolean {
  return redactKnownSecrets(value, knownSecrets) !== value;
}

/** YAML's canonical scalar spelling can differ from JavaScript's `String`, such as `-0`. */
function matchesKnownScalar(
  value: number | boolean | null,
  knownSecrets: readonly KnownSecret[],
): boolean {
  return (
    matchesKnownSecret(String(value), knownSecrets) ||
    matchesKnownSecret(YAML.stringify(value).replace(/\n$/u, ''), knownSecrets)
  );
}

/**
 * `toJS()` erases the original spelling of mapping keys such as `-0`, `.inf` and `null`.
 * Mask known scalar source before that conversion so the later object walk cannot lose a
 * credential that YAML would otherwise render again.
 */
function redactKnownScalarNodes(
  node: unknown,
  knownSecrets: readonly KnownSecret[],
  forceValue = false,
  mapKey = false,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof node !== 'object' || node === null || seen.has(node)) return false;
  seen.add(node);
  if (YAML.isScalar(node)) {
    const source = (node as { source?: unknown }).source;
    const knownScalar =
      typeof node.value !== 'string' &&
      typeof source === 'string' &&
      matchesKnownSecret(source, knownSecrets);
    if ((!mapKey && forceValue) || knownScalar) {
      node.value = REDACTED;
      return true;
    }
    return false;
  }
  if (YAML.isMap(node)) {
    for (const pair of node.items) {
      const maskedKey = redactKnownScalarNodes(pair.key, knownSecrets, false, true, seen);
      redactKnownScalarNodes(pair.value, knownSecrets, forceValue || maskedKey, false, seen);
    }
    return false;
  }
  if (YAML.isSeq(node)) {
    for (const item of node.items)
      redactKnownScalarNodes(item, knownSecrets, forceValue, false, seen);
  }
  return false;
}

function redactArtifactText(
  value: string,
  secret: boolean,
  knownSecrets: readonly KnownSecret[],
): string {
  if (secret) return REDACTED;
  // A bundle also masks the URL user name, which log redaction leaves readable and which can
  // be the credential itself. The same rule masks a JSON string inside the value.
  return redactAssignedText(value, knownSecrets);
}

/** Redact standard credential fields and the workspace's known secret values in parsed YAML. */
function redactArtifactValue(
  value: unknown,
  knownSecrets: readonly KnownSecret[],
  secret = false,
  seen = new WeakSet<object>(),
  parentKey = '',
): unknown {
  if (typeof value === 'string') return redactArtifactText(value, secret, knownSecrets);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return secret || matchesKnownScalar(value, knownSecrets) ? REDACTED : value;
  }
  if (typeof value !== 'object') return secret ? REDACTED : value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => redactArtifactValue(item, knownSecrets, secret, seen));

  const fields = value as Record<string, unknown>;
  const name = toText(fields.name);
  const namedSecret = credentialKey(name) || matchesKnownSecret(name, knownSecrets);
  const out: Record<string, unknown> = {};
  // `command: [mysql]` with `args: [-u, root, -p, x]` splits one command over two keys, so the
  // keys are judged together as well as one by one.
  const argumentLists = Object.entries(fields).filter(([key]) => argumentListKey(key, parentKey));
  const joinedCredential = argumentsCarryCredential(
    argumentLists.flatMap(([, item]) => argumentWords(item)),
  );
  for (const [key, item] of Object.entries(fields)) {
    const safeKey = redactArtifactText(key, false, knownSecrets);
    // A command that names a credential flag is withheld whole: the flag's value can be
    // spelled in more ways than this reader can follow, and a partial mask would show it.
    if (argumentListKey(key, parentKey) && (joinedCredential || argumentsCarryCredential(item))) {
      out[safeKey] = REDACTED;
      continue;
    }
    out[safeKey] = redactArtifactValue(
      item,
      knownSecrets,
      secret || safeKey !== key || credentialKey(key) || (key === 'value' && namedSecret),
      seen,
      key,
    );
  }
  return out;
}

/** Whether a command, entrypoint, args or healthcheck value names a credential flag. */
function argumentsCarryCredential(value: unknown): boolean {
  if (typeof value === 'string') return commandCarriesCredential(value);
  if (!Array.isArray(value)) return false;
  const words = value.filter((item): item is string => typeof item === 'string');
  return (
    words.some((word) => credentialFlagWord(word) || commandCarriesCredential(word)) ||
    (words.includes('-p') && userPasswordClient(words) && words.some(userArgument)) ||
    shortOptionPasswords(words).length > 0 ||
    httpUserPassword(words) ||
    authorizationHeaders(words).length > 0
  );
}

/** One shell word and whether any part of it was quoted, so it may hold a nested command. */
interface ShellWord {
  readonly text: string;
  /** The word as written, quotes and escapes included: the artifact holds this spelling. */
  readonly raw: string;
  readonly quoted: boolean;
}

/** Bash's single-character ANSI-C escapes; any other escaped character stands for itself. */
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

/**
 * The simple commands in one shell string, as words. Adjacent quoted and unquoted parts join
 * into one word, backslash escapes one character (inside double quotes only before `"`, `\`,
 * `$` or a backtick), `$'...'` decodes its escapes, and `;`, `&`, `|`, parentheses and newlines
 * end a command. Redirections end a word, and a heredoc's body is skipped unless a shell reads
 * it. This is enough to find a flag's value; it does not expand anything.
 */
function shellCommands(text: string): ShellWord[][] {
  const commands: ShellWord[][] = [];
  let command: ShellWord[] = [];
  let word = '';
  let quoted = false;
  let started = false;
  let start = 0;
  const begin = (index: number): void => {
    if (!started) start = index;
    started = true;
  };
  const endWord = (end: number): void => {
    if (started) command.push({ text: word, raw: text.slice(start, end), quoted });
    word = '';
    quoted = false;
    started = false;
  };
  const endCommand = (end: number): void => {
    endWord(end);
    if (command.length > 0) commands.push(command);
    command = [];
  };
  // Heredoc delimiters on the current line; their bodies start at the next newline.
  let heredocs: { delimiter: string; tabs: boolean }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (char === '$' && text[index + 1] === "'") {
      // Bash's ANSI-C quoting, `$'pa\x73s'`, passes the decoded text.
      begin(index);
      quoted = true;
      for (index += 2; index < text.length && text[index] !== "'"; index += 1) {
        const inner = text[index] ?? '';
        if (inner !== '\\') {
          word += inner;
          continue;
        }
        const escape = /^(?:x([0-9A-Fa-f]{1,2})|([0-7]{1,3})|(.))/su.exec(text.slice(index + 1));
        const [match, hex, octal, single] = escape ?? ['', undefined, undefined, undefined];
        if (hex !== undefined) word += String.fromCharCode(parseInt(hex, 16));
        else if (octal !== undefined) word += String.fromCharCode(parseInt(octal, 8));
        else if (single !== undefined) word += ANSI_C_ESCAPES[single] ?? single;
        index += match.length;
      }
    } else if (char === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      // `cat <<EOF` feeds the following lines as data; only a shell runs them.
      endWord(index);
      const tabs = text[index + 2] === '-';
      const spec = /^[ \t]*(['"]?)([^\s'"<>;&|()]+)\1/u.exec(text.slice(index + (tabs ? 3 : 2)));
      // `$((1<<2))` shifts a number; a delimiter is a word.
      if (spec !== null && !/^\d+$/u.test(spec[2] ?? '')) {
        heredocs.push({ delimiter: spec[2] ?? '', tabs });
        index += (tabs ? 3 : 2) + spec[0].length - 1;
      } else index += 1;
    } else if (char === '\n' && heredocs.length > 0) {
      // A shell reading the heredoc runs it, so its lines stay commands then.
      const program = (command[0]?.text ?? '').split('/').pop() ?? '';
      const shell = /^(?:sh|bash|zsh|dash|ash|ksh)$/u.test(program);
      endCommand(index);
      let line = index + 1;
      for (const heredoc of heredocs) {
        for (;;) {
          const newline = text.indexOf('\n', line);
          const end = newline < 0 ? text.length : newline;
          const body = text.slice(line, end);
          line = end + 1;
          if ((heredoc.tabs ? body.replace(/^\t+/u, '') : body) === heredoc.delimiter) break;
          if (newline < 0) break;
        }
      }
      heredocs = [];
      if (!shell) index = line - 1;
    } else if (char === "'") {
      begin(index);
      const close = text.indexOf("'", index + 1);
      const end = close < 0 ? text.length : close;
      word += text.slice(index + 1, end);
      quoted = true;
      index = end;
    } else if (char === '"') {
      begin(index);
      quoted = true;
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        const inner = text[index] ?? '';
        const next = text[index + 1] ?? '';
        if (inner === '\\' && next === '\n') {
          // A line continuation inside double quotes joins the lines as well.
          index += 1;
        } else if (inner === '\\' && '"\\$`'.includes(next) && next !== '') {
          word += next;
          index += 1;
        } else word += inner;
      }
    } else if (char === '\\' && text[index + 1] === '\n') {
      // A line continuation joins lines; it is not part of any word.
      index += 1;
    } else if (char === '\\') {
      begin(index);
      word += text[index + 1] ?? '';
      // `sh -c client\ --password\ X` passes one escaped word as the program: read it again.
      quoted = true;
      index += 1;
    } else if (char === '#' && word === '' && !quoted) {
      // A `#` that starts a word begins a comment: the shell never runs the rest of the line.
      const newline = text.indexOf('\n', index);
      index = newline < 0 ? text.length : newline - 1;
    } else if (/[;&|()`\n]/u.test(char)) {
      endCommand(index);
    } else if (/[\s<>]/u.test(char)) {
      endWord(index);
    } else {
      begin(index);
      word += char;
    }
  }
  endCommand(text.length);
  return commands;
}

/** The values after credential flags in one command string, nested `sh -c` strings included. */
function discoverCommandText(text: string, add: (value: string) => void, depth = 0): void {
  if (depth > 8) return;
  for (const command of shellCommands(text)) {
    const texts = command.map((word) => word.text);
    const userGiven = userPasswordClient(texts) && texts.some(userArgument);
    // The artifact spells a quoted or escaped value as written; mask that spelling too, without
    // its outer quotes, which stay to show where the value was. Inside an outer double-quoted
    // string the artifact also escapes `"`, `\`, `$` and backticks.
    const spellings = (value: string, raw?: string): void => {
      add(value);
      if (raw !== undefined) add(raw.replace(/^(['"])(.*)\1$/su, '$2'));
      if (depth > 0) {
        add(value.replace(/["\\$`]/gu, '\\$&'));
        if (raw !== undefined) add(raw.replace(/["\\$`]/gu, '\\$&'));
      }
    };
    // `curl -u user:password`: the user value as a whole and its password are both credentials.
    for (const user of httpUsers(command.map((word) => word.text))) {
      const word = command[user.index] as ShellWord;
      spellings(user.value, user.attached ? word.raw.replace(HTTP_USER_PREFIX, '') : word.raw);
      spellings(user.password);
    }
    for (const password of shortOptionPasswords(texts)) spellings(password);
    // `-H 'Authorization: Bearer token'`: the header's credential, not the whole header line.
    for (const header of authorizationHeaders(command.map((word) => word.text))) {
      for (const credential of authorizationCredentials(header)) spellings(credential);
    }
    for (let index = 0; index < command.length; index += 1) {
      const word = command[index] as ShellWord;
      // `--password=value` carries its own value.
      const equals = word.text.indexOf('=');
      if (equals > 0 && valueTakingCredentialFlag(word.text.slice(0, equals))) {
        add(word.text.slice(equals + 1));
      }
      const next = command[index + 1];
      if (next !== undefined && credentialArgument(word.text, next.text, userGiven)) {
        spellings(next.text, next.raw);
      }
      if (word.quoted) discoverCommandText(word.text, add, depth + 1);
    }
  }
}

/** Discover before `toJS` loses duplicate members and original numeric spellings. */
function discoverArtifactSecrets(
  node: unknown,
  doc: YAML.Document,
  secrets: Set<string>,
  wholeSecrets: Set<string>,
  secret = false,
  seen = new WeakMap<object, number>(),
  depth = 0,
  parentKey = '',
): void {
  if (typeof node !== 'object' || node === null) return;
  // A benign alias visited first must still be revisited under a credential key, and under a
  // healthcheck key: `test` is an argument list there and nowhere else. A visit as a credential
  // covers a plain one in the same context. Bits: 1 plain, 2 plain in a healthcheck, 4 as a
  // credential, 8 as a credential in a healthcheck.
  const health = healthcheckKey(parentKey);
  const visited = seen.get(node) ?? 0;
  const covering = (health ? 8 : 4) | (secret ? 0 : health ? 2 : 1);
  if ((visited & covering) !== 0) return;
  if (depth > 100) throw new RangeError('artifact credential nesting exceeds limit');
  seen.set(node, visited | (secret ? (health ? 8 : 4) : health ? 2 : 1));
  const visit = (child: unknown, credential = secret, key = ''): void =>
    discoverArtifactSecrets(child, doc, secrets, wholeSecrets, credential, seen, depth + 1, key);
  const add = (text: string, whole = false): void => {
    if (text === '') return;
    // Once a header value is known to be a credential, its bare token is a credential
    // too. Copies may omit the scheme, including copies encountered before the header.
    const authorization = /^(?:Bearer|Basic)[ \t]+(\S+)$/iu.exec(text);
    if (authorization?.[1] !== undefined) add(authorization[1]);
    // OpenSSL's `pass:secret` holds the passphrase after its prefix; a copy may omit it.
    const passphrase = /^pass:(.+)$/su.exec(text);
    if (passphrase?.[1] !== undefined) add(passphrase[1]);
    // Numeric text is still a credential, but its digits must not erase ports or replica
    // suffixes. Use the same core scalar parser as the artifact, including hex and .inf.
    const numeric = /^[-+.0-9]/u.test(text)
      ? YAML.parseDocument(text, { uniqueKeys: false })
      : null;
    if (
      numeric !== null &&
      numeric.errors.length === 0 &&
      YAML.isScalar(numeric.contents) &&
      typeof numeric.contents.value === 'number' &&
      numeric.contents.source === text
    ) {
      wholeSecrets.add(text);
      wholeSecrets.add(String(numeric.contents.value));
      wholeSecrets.add(YAML.stringify(numeric.contents.value).replace(/\n$/u, ''));
    } else (whole ? wholeSecrets : secrets).add(text);
  };
  // The item after a credential flag is its value, as in `--flag=value`; neither item names
  // a credential on its own, so classify it here, before any scalar renders.
  // `siblings` holds the words of the map's other argument lists: `command: [mysql]` names the
  // client for `args: [-u, root, -p, x]`.
  const discoverArguments = (list: YAML.YAMLSeq, siblings: readonly string[] = []): void => {
    const items = list.items.map((item) => (YAML.isAlias(item) ? item.resolve(doc) : item));
    const words = items.map((item) => (YAML.isScalar(item) ? String(item.value) : ''));
    const strings = items.flatMap((item) =>
      YAML.isScalar(item) && typeof item.value === 'string' ? [item.value] : [],
    );
    const command = [...siblings, ...strings];
    const userGiven = userPasswordClient(command) && command.some(userArgument);
    // Joined with its siblings, so `command: [curl]` and `args: [-u, user:pw]` read as one.
    for (const credential of argumentCredentials([...siblings, ...words])) add(credential);
    for (let index = 0; index < items.length; index += 1) {
      const flag = items[index];
      if (!YAML.isScalar(flag) || typeof flag.value !== 'string') continue;
      // A shell string (`sh -c "client --password X"`, `CMD-SHELL`) holds its own arguments.
      discoverCommandText(flag.value, add);
      const next = items[index + 1];
      const value = YAML.isScalar(next) ? String(next.value) : '';
      if (credentialArgument(flag.value, value, userGiven)) visit(list.items[index + 1], true);
    }
  };
  if (YAML.isAlias(node)) {
    visit(node.resolve(doc), secret, parentKey);
  } else if (YAML.isScalar(node)) {
    const value: unknown = node.value;
    if (typeof value === 'string') {
      if (secret) add(value);
      discoverTextSecrets(value, add);
    } else if (secret) {
      add(String(value), true);
      add(YAML.stringify(value).replace(/\n$/u, ''), true);
      if (typeof node.source === 'string') add(node.source, true);
    }
  } else if (YAML.isSeq(node)) {
    for (const item of node.items) visit(item);
  } else if (YAML.isMap(node)) {
    // `get` selects the first duplicate, while `toJS` selects the last. Conservatively
    // discover all values when any name identifies a credential, including aliased keys.
    const named = node.items.some((pair) => {
      const key = YAML.isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
      const name = YAML.isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
      return (
        YAML.isScalar(key) &&
        key.value === 'name' &&
        YAML.isScalar(name) &&
        credentialKey(String(name.value))
      );
    });
    const argumentText = (pair: (typeof node.items)[number]): string[] => {
      const key = YAML.isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
      if (!YAML.isScalar(key) || !argumentListKey(String(key.value), parentKey)) return [];
      const list = YAML.isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
      if (YAML.isScalar(list)) return argumentWords(list.value);
      if (!YAML.isSeq(list)) return [];
      return argumentWords(
        list.items.map((item) => {
          const scalar = YAML.isAlias(item) ? item.resolve(doc) : item;
          return YAML.isScalar(scalar) ? scalar.value : null;
        }),
      );
    };
    for (const pair of node.items) {
      visit(pair.key, false);
      const key = YAML.isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
      const text = YAML.isScalar(key) ? String(key.value) : '';
      visit(pair.value, secret || credentialKey(text) || (text === 'value' && named), text);
      const list = YAML.isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
      if (argumentListKey(text, parentKey) && YAML.isSeq(list)) {
        discoverArguments(list, node.items.filter((other) => other !== pair).flatMap(argumentText));
      }
      if (argumentListKey(text, parentKey) && YAML.isScalar(list)) {
        if (typeof list.value === 'string') discoverCommandText(list.value, add);
      }
    }
  }
}

/** Render an artifact for attachment, or omit it rather than copying unparseable bytes. */
function redactedArtifact(
  artifact: CapturedArtifact,
  knownSecrets: readonly KnownSecret[],
): string | null {
  if (artifact.bytes === null) return null;
  try {
    const docs = YAML.parseAllDocuments(artifact.bytes.toString('utf8'), { uniqueKeys: false });
    if (docs.length === 0 || docs.some((doc) => doc.errors.length > 0)) return null;
    const secrets = new Set(
      knownSecrets.filter((item): item is string => typeof item === 'string'),
    );
    const wholeSecrets = new Set<string>();
    // Keep aliases under the parser's existing expansion limit and visit every document first.
    for (const doc of docs) discoverArtifactSecrets(doc.contents, doc, secrets, wholeSecrets);
    const discovered: KnownSecret[] = [
      ...secrets,
      ...[...wholeSecrets].map((value) => ({ value, whole: true as const })),
    ];
    return docs
      .map((doc) => {
        redactKnownScalarNodes(doc.contents, discovered);
        return YAML.stringify(redactArtifactValue(doc.toJS() as unknown, discovered));
      })
      .join('---\n');
  } catch {
    return null;
  }
}

function matchesPayloadArtifact(
  payload: Record<string, unknown>,
  artifact: CapturedArtifact,
): boolean {
  const claimed = bag(payload.artifact);
  return (
    artifact.name !== '' &&
    artifact.bytes !== null &&
    toText(claimed.name) === artifact.name &&
    toText(claimed.sha256) === artifact.sha256
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** Keep the raw source digest and identify the exact redacted bytes a bundle attaches. */
function bundleManifest(
  payload: Record<string, unknown>,
  artifact: CapturedArtifact,
  renderedArtifact: Buffer | null,
): Record<string, unknown> {
  const manifest = structuredClone(payload);
  const claimed = bag(manifest.artifact);
  delete claimed.sanitized;
  if (renderedArtifact !== null) {
    claimed.sanitized = {
      name: path.basename(artifact.name),
      sha256: sha256(renderedArtifact),
    };
  }
  return manifest;
}

function existingBundle(out: string): never {
  throw new ValidationError(
    `evidence bundle destination ${quotedText(out)} already exists; choose a new directory`,
  );
}

/** Make the attachment root once. Existing directories are never reused or overwritten. */
async function createBundleDirectory(out: string): Promise<void> {
  try {
    await fs.mkdir(out);
    return;
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) return existingBundle(out);
    if (!isErrorCode(error, 'ENOENT')) throw error;
  }

  await fs.mkdir(path.dirname(out), { recursive: true });
  try {
    await fs.mkdir(out);
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) return existingBundle(out);
    throw error;
  }
}

async function writeBundleAt(
  dest: string,
  payload: Record<string, unknown>,
  artifact: CapturedArtifact,
  knownSecrets: readonly KnownSecret[],
  capture?: unknown,
): Promise<Bundle> {
  // The manifest records the digest of the raw deployment file. Only attach the rendered
  // version when it came from that exact same snapshot; otherwise provenance is preserved
  // in the manifest and a possibly mismatched file is left out.
  const renderedArtifact = matchesPayloadArtifact(payload, artifact)
    ? redactedArtifact(artifact, knownSecrets)
    : null;
  const renderedBytes = renderedArtifact === null ? null : Buffer.from(renderedArtifact, 'utf8');
  const manifest = bundleManifest(payload, artifact, renderedBytes);
  const out = pathExpandUser(dest);
  await createBundleDirectory(out);

  const written = ['manifest.json', 'README.md'];
  await fs.writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await fs.writeFile(path.join(out, 'README.md'), renderBundleMarkdown(payload, capture), {
    encoding: 'utf8',
    flag: 'wx',
  });
  if (renderedBytes !== null) {
    const filename = path.basename(artifact.name);
    await fs.writeFile(path.join(out, filename), renderedBytes, {
      encoding: 'utf8',
      flag: 'wx',
    });
    written.push(filename);
  }
  return { path: out, files: written.sort() };
}

/**
 * A bundle: the record, its readable rendering, and a redacted deployment artifact. Raw logs
 * are intentionally excluded because workspace logs can contain credentials. The supplied
 * payload and artifact must describe the same locked snapshot before an artifact is attached.
 */
export async function writeBundle(
  name: string,
  dest: string,
  payload: Record<string, unknown>,
  capture?: unknown,
): Promise<Bundle> {
  const target = await naming.resolveName(name);
  return await reproLock(target, async () => {
    const meta = await readMeta(target);
    return await writeBundleAt(
      dest,
      payload,
      await artifactOf(meta),
      knownWorkspaceSecrets(meta),
      capture,
    );
  });
}

/** Capture the record and optional bundle under one workspace lock. */
export async function collect(
  name: string,
  {
    retention = {},
    bundle = '',
    capture,
  }: {
    retention?: { retained?: boolean | null; reason?: string };
    bundle?: string;
    capture?: unknown;
  } = {},
): Promise<Record<string, unknown>> {
  const target = await naming.resolveName(name);
  return await reproLock(target, async () => {
    const snapshot = await snapshotOf(target, retention);
    if (bundle !== '')
      snapshot.payload.bundle = await writeBundleAt(
        bundle,
        snapshot.payload,
        snapshot.artifact,
        snapshot.knownSecrets,
        capture,
      );
    return snapshot.payload;
  });
}
