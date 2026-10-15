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
import { imageRef } from '../lib/compose';
import { ValidationError } from '../lib/errors';
import { isTruthy, quotedText, toText } from '../lib/format';
import { pathExpandUser } from '../lib/home';
import { REDACTED, redactEnv, SECRET_KEY_HINTS } from '../lib/redact';
import { namesOf } from '../lib/presets/composite';
import * as presets from '../lib/presets/index';
import { PROFILES } from '../lib/seed-profiles';
import { SCENARIOS } from '../lib/seed-options';
import * as naming from './lifecycle/naming';
import { detail } from './lifecycle/payload';
import { composeVersion, dockerServerVersion } from './runner/host';
import { reproLock } from './runner/locks';
import * as paths from './runner/paths';
import { adminPass, type Metadata, projectName, readMeta } from './runner/record';
import * as topology from './topology';

export { renderMarkdown } from '../lib/capture-render';

/** The portable record name and native filesystem path of every deployable artifact. */
const ARTIFACTS = [
  { name: 'docker-compose.yml', path: ['docker-compose.yml'] },
  { name: 'kubernetes/values.yaml', path: ['kubernetes', 'values.yaml'] },
] as const;

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

async function artifactOf(name: string): Promise<CapturedArtifact> {
  const ws = paths.workspace(name);
  for (const candidate of ARTIFACTS) {
    try {
      const bytes = await fs.readFile(path.join(ws, ...candidate.path));
      return {
        name: candidate.name,
        sha256: sha256(bytes),
        bytes,
      };
    } catch {
      continue;
    }
  }
  return { name: '', sha256: '', bytes: null };
}

/**
 * How houston knows the workspace is its own, stated so a teardown decision is auditable
 * after the fact. A name prefix is not ownership: Kubernetes proves it by label, Compose by
 * the record that names the project.
 */
async function ownershipOf(meta: Metadata, runtime: string): Promise<Record<string, unknown>> {
  if (runtime === topology.KUBERNETES) {
    return { proof: 'label', managed_by: 'houston', namespace: toText(bag(meta.extra).namespace) };
  }
  return { proof: 'record', managed_by: 'houston', project: await projectName(meta.name) };
}

/**
 * Whether a licence was needed and whether one was supplied. Never the value, only
 * whether and from where. `extra.licensed` is set by `--license` on either runtime; a
 * registration token is not recorded in the metadata at all, so it cannot be reported
 * here and `source` names only what the record can prove.
 */
function licenseOf(meta: Metadata, deployment: string, runtime: string): Record<string, unknown> {
  let required = deployment === topology.MICROSERVICES;
  for (const name of namesOf(meta.preset).filter((item) => item !== 'default')) {
    try {
      required ||= presets.resolve(name, runtime).requiresLicense;
    } catch {
      // A preset this install no longer has must not break the evidence for a workspace
      // that was built from it. Other components of the recorded composite still count.
    }
  }
  const supplied = bag(meta.extra).licensed === true;
  return { required, supplied, source: supplied ? 'license' : null };
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
  const explicit = resolveRetention(requested);
  if (explicit.retained || !meta.pinned) return explicit;
  return { retained: true, reason: 'persisted preference' };
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
  const d = await detail(target);
  const runtime = topology.ofMeta(meta);
  const deployment = toText(d.deployment);
  const extra = bag(meta.extra);

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

  const artifact = await artifactOf(target);
  const keep = retentionOf(meta, retention);
  const payload: Record<string, unknown> = {
    // Identical shape on both runtimes, so a consumer never branches here.
    repro: {
      name: meta.name,
      preset: meta.preset,
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
    license: licenseOf(meta, deployment, runtime),
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

function secretKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_KEY_HINTS.some((hint) => lowered.includes(hint));
}

/**
 * Mask exact credentials the workspace record names, even below a benign YAML key. Key-name
 * redaction still protects standard deployment fields, but cannot discover an unknown secret in
 * arbitrary YAML.
 */
function redactKnownSecrets(value: string, knownSecrets: readonly string[]): string {
  return [...new Set(knownSecrets.filter((secret) => secret !== ''))]
    .sort((left, right) => right.length - left.length)
    .reduce((masked, secret) => masked.replaceAll(secret, REDACTED), value);
}

function redactArtifactText(
  value: string,
  secret: boolean,
  knownSecrets: readonly string[],
): string {
  if (secret) return REDACTED;
  const equals = value.indexOf('=');
  if (equals > 0) {
    const key = value.slice(0, equals);
    return redactKnownSecrets(`${key}=${redactEnv(key, value.slice(equals + 1))}`, knownSecrets);
  }
  return redactKnownSecrets(redactEnv('', value), knownSecrets);
}

/** Redact standard credential fields and the workspace's known secret values in parsed YAML. */
function redactArtifactValue(
  value: unknown,
  knownSecrets: readonly string[],
  secret = false,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return redactArtifactText(value, secret, knownSecrets);
  if (Array.isArray(value))
    return value.map((item) => redactArtifactValue(item, knownSecrets, secret, seen));
  if (typeof value !== 'object' || value === null) return secret ? REDACTED : value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  const fields = value as Record<string, unknown>;
  const name = toText(fields.name);
  const namedSecret = secretKey(name) || redactKnownSecrets(name, knownSecrets) !== name;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(fields)) {
    const safeKey = redactKnownSecrets(key, knownSecrets);
    out[safeKey] = redactArtifactValue(
      item,
      knownSecrets,
      secret || safeKey !== key || secretKey(key) || (key === 'value' && namedSecret),
      seen,
    );
  }
  return out;
}

/** Render an artifact for attachment, or omit it rather than copying unparseable bytes. */
function redactedArtifact(
  artifact: CapturedArtifact,
  knownSecrets: readonly string[],
): string | null {
  if (artifact.bytes === null) return null;
  try {
    const docs = YAML.parseAllDocuments(artifact.bytes.toString('utf8'), { uniqueKeys: false });
    if (docs.length === 0 || docs.some((doc) => doc.errors.length > 0)) return null;
    return docs
      .map((doc) => YAML.stringify(redactArtifactValue(doc.toJS() as unknown, knownSecrets)))
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
  knownSecrets: readonly string[],
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
      await artifactOf(target),
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
