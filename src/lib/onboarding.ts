/**
 * One-time onboarding and the scoped decisions it persists.
 *
 * A gate (exit 6) is a question only a person may answer. Onboarding keeps that answer in
 * the existing flat config without replacing unrelated state:
 *
 *     onboarding:
 *       completed_at: "2026-10-15T09:14:02+00:00"
 *     grants:
 *       owned_cluster: true | false
 *
 * Each named grant has three states. An absent key is unanswered, `false` is a settled
 * denial, and only boolean `true` grants authority. Writers change only the named key and
 * retain other entries in both mappings. This matters when a newer build records a decision
 * this one does not know, or when a person has deliberately denied a capability.
 *
 * The only standing grant is narrow: it permits Houston's own local Kind-cluster lifecycle.
 * It never permits selecting an ambient cluster or copying the local CA private key elsewhere.
 */
import { type Config, loadConfig } from './config';
import { AuthorityGateError, ValidationError } from './errors';

export const GRANTS_KEY = 'grants';
export const ONBOARDING_KEY = 'onboarding';
export const COMPLETED_AT_KEY = 'completed_at';
export const RC_REPRO_VERSION_KEY = 'rc_repro_version';
export const CLUSTERS_KEY = 'clusters';
export const OWNED_CLUSTER_SCOPE = 'houston-local';

/** What a gate tells a person to run. The human path; never something a caller runs itself. */
export const ONBOARD_COMMAND = 'houston onboard';

// The CLI sets this beside its envelope version before dispatching a command. Keeping the
// value here lets this lower-layer config writer stamp the same build without importing the
// higher-layer JSON envelope module.
let onboardingVersion = '0.0.0';

export function setOnboardingVersion(version: string): void {
  onboardingVersion = version;
}

export interface GrantSpec {
  /** The id a person types: `houston onboard grant <id>`. */
  readonly id: string;
  /** The one gate code this grant settles. Must be a key of `GATE_CODES`. */
  readonly gate: string;
  /** What houston may do once the grant is held, as a person reads it before deciding. */
  readonly unlocks: string;
}

/**
 * The decisions this build may persist. Other gates deliberately stay per-request: a standing
 * yes to copying a CA key into an arbitrary remote cluster would turn a local trust boundary
 * into blanket private-key export permission.
 */
export const GRANTS: readonly GrantSpec[] = Object.freeze([
  Object.freeze({
    id: 'owned-cluster',
    gate: 'GATE_OWNED_CLUSTER',
    unlocks:
      'create the houston-owned local Kind cluster (houston-local), or tear down and prune ' +
      'its recorded local workspaces; about 600 MB of the container engine',
  }),
]);

const OWNED_CLUSTER_GRANT = 'owned-cluster';

export function grantIds(): string[] {
  return GRANTS.map((spec) => spec.id);
}

/** The grant that settles `gate`, or null for a gate no grant settles. */
export function grantFor(gate: string): GrantSpec | null {
  return GRANTS.find((spec) => spec.gate === gate) ?? null;
}

/** The exact command a person runs to settle a gate. */
export function grantCommand(id: string): string {
  return `${ONBOARD_COMMAND} grant ${id}`;
}

/** Refuse an id nobody declared, naming the ones that exist. */
export function checkGrantId(id: string): GrantSpec {
  const spec = GRANTS.find((candidate) => candidate.id === id);
  if (spec === undefined) {
    throw new ValidationError(`unknown grant '${id}' (want: ${grantIds().join(' | ')})`);
  }
  return spec;
}

/** The one canonical persisted spelling for a CLI grant name. */
export function grantKey(id: string): string {
  return id.replaceAll('-', '_');
}

function mapping(value: unknown): Config | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Config) : null;
}

/** Read invalid legacy shapes as no answer. A write refuses rather than replacing them. */
function readMapping(cfg: Config, key: string): Config {
  return mapping(cfg[key]) ?? {};
}

function writeMapping(cfg: Config, key: string): Config {
  const existing = cfg[key];
  if (existing === undefined) {
    const created: Config = {};
    cfg[key] = created;
    return created;
  }
  const stored = mapping(existing);
  if (stored === null) {
    throw new ValidationError(`${key} must be a mapping before onboarding can change it`);
  }
  return stored;
}

function requireWritableMapping(cfg: Config, key: string): void {
  if (cfg[key] !== undefined && mapping(cfg[key]) === null) {
    throw new ValidationError(`${key} must be a mapping before onboarding can change it`);
  }
}

/** The stored scope list, retaining unknown future entries exactly as they were. */
function clusterScopes(cfg: Config): unknown[] {
  const stored = readMapping(cfg, GRANTS_KEY)[CLUSTERS_KEY];
  return Array.isArray(stored) ? [...stored] : [];
}

/** Add or remove only the one local cluster the grant is allowed to cover. */
function recordOwnedClusterScope(cfg: Config, held: boolean): void {
  const grants = writeMapping(cfg, GRANTS_KEY);
  const stored = grants[CLUSTERS_KEY];
  if (stored !== undefined && !Array.isArray(stored)) {
    throw new ValidationError(
      `${GRANTS_KEY}.${CLUSTERS_KEY} must be a list before onboarding can change it`,
    );
  }
  const scopes = stored === undefined ? [] : [...stored];
  if (held) {
    if (!scopes.includes(OWNED_CLUSTER_SCOPE)) scopes.push(OWNED_CLUSTER_SCOPE);
  } else {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (scopes[index] === OWNED_CLUSTER_SCOPE) scopes.splice(index, 1);
    }
  }
  grants[CLUSTERS_KEY] = scopes;
}

interface StoredGrant {
  readonly held: boolean;
  readonly answered: boolean;
}

function storedGrant(cfg: Config, id: string): StoredGrant {
  const grants = readMapping(cfg, GRANTS_KEY);
  const key = grantKey(id);
  // Only a boolean is an answer. A hand-edited `"yes"` or `null` is neither held nor
  // settled: reporting it as "denied" would tell automation a person decided.
  return {
    held: grants[key] === true,
    answered: typeof grants[key] === 'boolean',
  };
}

/** The grant ids `cfg` holds, in declaration order. Only boolean true grants authority. */
export function heldGrants(cfg: Config): string[] {
  return grantIds().filter((id) => storedGrant(cfg, id).held);
}

/** Which declared grants have an explicit persisted answer, including `false`. */
export function answeredGrants(cfg: Config): string[] {
  return grantIds().filter((id) => storedGrant(cfg, id).answered);
}

export function holdsGrant(id: string, cfg: Config = loadConfig()): boolean {
  checkGrantId(id);
  return storedGrant(cfg, id).held;
}

/** Refuse an action until a person has recorded onboarding on this machine. */
export function requireOnboarded(cfg: Config = loadConfig()): void {
  if (completedAt(cfg) !== '') return;
  throw new AuthorityGateError('houston has not been onboarded on this machine', {
    kind: 'onboarding',
    subject: 'machine',
    approveWith: ONBOARD_COMMAND,
    code: 'GATE_NOT_ONBOARDED',
  });
}

/** Refuse an action until a person has granted this specific, declared capability. */
export function requireGrant(id: string, cfg: Config = loadConfig()): void {
  const spec = checkGrantId(id);
  if (storedGrant(cfg, id).held) return;
  throw new AuthorityGateError(`houston is not authorised to ${spec.unlocks}`, {
    kind: 'grant',
    subject: id,
    approveWith: grantCommand(id),
    code: spec.gate,
  });
}

/** `onboarding.completed_at` as text, whatever the YAML reader made of it. */
function completedAt(cfg: Config): string {
  const raw = readMapping(cfg, ONBOARDING_KEY)[COMPLETED_AT_KEY];
  if (raw instanceof Date) return stamp(raw);
  return typeof raw === 'string' ? raw : '';
}

/** The UTC time to the second, in the form `config.yaml` already uses for timestamps. */
function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}+00:00`;
}

export interface GrantState extends GrantSpec {
  readonly held: boolean;
  readonly answered: boolean;
}

/** What `houston onboard` and `capabilities.onboarding` report. */
export interface OnboardingState {
  completed: boolean;
  completed_at: string;
  rc_repro_version: string;
  grants: Record<string, boolean>;
  answered_grants: Record<string, boolean>;
  clusters: string[];
  grants_available: GrantState[];
  onboard_with: string;
}

export function state(cfg: Config = loadConfig()): OnboardingState {
  const states = GRANTS.map((spec) => ({ ...spec, ...storedGrant(cfg, spec.id) }));
  return {
    completed: completedAt(cfg) !== '',
    completed_at: completedAt(cfg),
    rc_repro_version: versionAt(cfg),
    grants: Object.fromEntries(states.map((spec) => [grantKey(spec.id), spec.held])),
    answered_grants: Object.fromEntries(states.map((spec) => [grantKey(spec.id), spec.answered])),
    clusters: clusterScopes(cfg).filter((scope): scope is string => typeof scope === 'string'),
    grants_available: states,
    onboard_with: ONBOARD_COMMAND,
  };
}

/** Record a positive answer without disturbing other grants or unknown mapping entries. */
export function grant(cfg: Config, id: string, at = new Date()): void {
  checkGrantId(id);
  requireWritableMapping(cfg, GRANTS_KEY);
  requireWritableMapping(cfg, ONBOARDING_KEY);
  if (id === OWNED_CLUSTER_GRANT) recordOwnedClusterScope(cfg, true);
  writeMapping(cfg, GRANTS_KEY)[grantKey(id)] = true;
  complete(cfg, at);
}

/** Record an explicit denial. A later `grant` may change it, but absence is never fabricated. */
export function revoke(cfg: Config, id: string, at = new Date()): void {
  checkGrantId(id);
  requireWritableMapping(cfg, GRANTS_KEY);
  requireWritableMapping(cfg, ONBOARDING_KEY);
  if (id === OWNED_CLUSTER_GRANT) recordOwnedClusterScope(cfg, false);
  writeMapping(cfg, GRANTS_KEY)[grantKey(id)] = false;
  complete(cfg, at);
}

/** Mark this machine onboarded while preserving a prior completion record and unknown fields. */
export function complete(cfg: Config, at = new Date()): void {
  const onboarding = writeMapping(cfg, ONBOARDING_KEY);
  if (completedAt(cfg) === '') onboarding[COMPLETED_AT_KEY] = stamp(at);
  onboarding[RC_REPRO_VERSION_KEY] = onboardingVersion;
}

/** `onboarding.rc_repro_version` as text, whatever the YAML reader made of it. */
function versionAt(cfg: Config): string {
  const raw = readMapping(cfg, ONBOARDING_KEY)[RC_REPRO_VERSION_KEY];
  return typeof raw === 'string' ? raw : '';
}
