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
  ARGUMENT_LIST_KEYS,
  credentialFlag,
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
  for (const [key, item] of Object.entries(fields)) {
    const safeKey = redactArtifactText(key, false, knownSecrets);
    out[safeKey] = redactArtifactValue(
      item,
      knownSecrets,
      secret || safeKey !== key || credentialKey(key) || (key === 'value' && namedSecret),
      seen,
    );
  }
  return out;
}

/**
 * Whether `flag` takes `value` as a credential: a long credential flag (`--password`), or `-p`
 * once a user flag came earlier in the same command, as `mongosh -u x -p` and `mysql -u x -p`
 * write it. Elsewhere `-p` is a port or `mkdir -p`, and masking those would erase evidence.
 */
function credentialArgument(flag: string, value: string, userGiven: boolean): boolean {
  if (credentialFlag(flag)) return true;
  return flag === '-p' && userGiven && value !== '';
}

const USER_FLAGS: readonly string[] = ['-u', '--user', '--username'];

/**
 * Shell words of one command string: a quoted run is one word without its quotes, and `;`,
 * `&`, `|`, parentheses and redirections end a word rather than joining the value before them.
 */
function commandWords(text: string): string[] {
  const words: string[] = [];
  const word = /'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s'";&|()<>]+)/gu;
  for (const match of text.matchAll(word)) words.push(match[1] ?? match[2] ?? match[3] ?? '');
  return words;
}

/** The values after credential flags in one command string. */
function discoverCommandText(text: string, add: (value: string) => void): void {
  const words = commandWords(text);
  let userGiven = false;
  for (let index = 0; index + 1 < words.length; index += 1) {
    const flag = words[index] ?? '';
    if (USER_FLAGS.includes(flag)) userGiven = true;
    const value = words[index + 1] ?? '';
    if (credentialArgument(flag, value, userGiven)) add(value);
  }
}

/** Discover before `toJS` loses duplicate members and original numeric spellings. */
function discoverArtifactSecrets(
  node: unknown,
  doc: YAML.Document,
  secrets: Set<string>,
  wholeSecrets: Set<string>,
  secret = false,
  seen = new WeakMap<object, boolean>(),
  depth = 0,
): void {
  if (typeof node !== 'object' || node === null) return;
  // A benign alias visited first must still be revisited under a credential key.
  if (seen.has(node) && (seen.get(node) === true || !secret)) return;
  if (depth > 100) throw new RangeError('artifact credential nesting exceeds limit');
  seen.set(node, secret);
  const visit = (child: unknown, credential = secret): void =>
    discoverArtifactSecrets(child, doc, secrets, wholeSecrets, credential, seen, depth + 1);
  const add = (text: string, whole = false): void => {
    if (text === '') return;
    // Once a header value is known to be a credential, its bare token is a credential
    // too. Copies may omit the scheme, including copies encountered before the header.
    const authorization = /^(?:Bearer|Basic)[ \t]+(\S+)$/iu.exec(text);
    if (authorization?.[1] !== undefined) add(authorization[1]);
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
  const discoverArguments = (list: YAML.YAMLSeq): void => {
    const items = list.items.map((item) => (YAML.isAlias(item) ? item.resolve(doc) : item));
    let userGiven = false;
    for (let index = 0; index < items.length; index += 1) {
      const flag = items[index];
      if (!YAML.isScalar(flag) || typeof flag.value !== 'string') continue;
      // A shell string (`sh -c "client --password X"`, `CMD-SHELL`) holds its own arguments.
      discoverCommandText(flag.value, add);
      if (USER_FLAGS.includes(flag.value)) userGiven = true;
      const next = items[index + 1];
      const value = YAML.isScalar(next) ? String(next.value) : '';
      if (credentialArgument(flag.value, value, userGiven)) visit(list.items[index + 1], true);
    }
  };
  if (YAML.isAlias(node)) {
    visit(node.resolve(doc));
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
    for (const pair of node.items) {
      visit(pair.key, false);
      const key = YAML.isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
      const text = YAML.isScalar(key) ? String(key.value) : '';
      visit(pair.value, secret || credentialKey(text) || (text === 'value' && named));
      const list = YAML.isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
      if (ARGUMENT_LIST_KEYS.includes(text) && YAML.isSeq(list)) discoverArguments(list);
      if (ARGUMENT_LIST_KEYS.includes(text) && YAML.isScalar(list)) {
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
