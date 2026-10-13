/**
 * Several presets in one workspace: `--preset ldap --preset email`.
 *
 * PURE AND SYNCHRONOUS. It takes presets already resolved for one runtime, each with its own
 * params, and returns one Preset that Compose and the Kubernetes adapters build exactly as they
 * build a single one. Nothing downstream has to know there were several.
 *
 * ORDER NEVER DECIDES. The inputs are sorted by name before anything is merged, and every
 * collision is either resolvable by a rule that does not look at order, or refused naming both
 * presets and the colliding item. The rules:
 *
 *  - env: a preset may mark a value SOFT (`softEnv`): a default it sets only because of what
 *    the workspace lacks, such as email 2FA off because there is no mail server. A hard value
 *    beats a soft one; two hard (or two soft) values that differ are refused unless the user
 *    names the key with `--env` or `--setting`, which then decides. User YAML presets are hard.
 *  - services, files, ports, post-ready actions and Kubernetes objects are unions, refused on
 *    a name both presets claim. The Rocket.Chat patch is deep-merged, refused on a leaf both
 *    set differently. `extra` likewise.
 *  - notes are concatenated; `requiresLicense` is OR'd; `default` is the identity.
 *
 * One preset in (after dropping `default`) is that preset UNCHANGED, so every single-preset
 * workspace builds byte-identically to before.
 */
import * as YAML from 'yaml';

import { ValidationError } from '../errors';
import { redactEnv } from '../redact';

import { emptyPreset, type Preset } from './types';

/** Joins a composite's names, sorted, into its one `preset` string. Never a valid name char. */
export const SEPARATOR = '+';

/** Presets that each bring a Keycloak of their own: one per workspace until it is shared. */
const ONE_SSO = ['oidc', 'saml'];

/** The canonical `preset` string for a set of names: sorted, deduplicated, `default` dropped. */
export function compositeName(names: readonly string[]): string {
  // Each name split on `+` first: `--preset ldap+email` is one token, and it was kept as
  // typed -- a second workspace for the same set, and a Kubernetes re-up spelled
  // `--preset email --preset ldap` refused as "a different set".
  const parts = [...new Set(names.flatMap((name) => name.split(SEPARATOR)))]
    .filter((name) => name !== '' && name !== 'default')
    .sort();
  return parts.length === 0 ? 'default' : parts.join(SEPARATOR);
}

/**
 * The presets a `preset` string asks for, as a person reads them: every one of the set, and
 * not `multi-instance`, which is how Compose builds that deployment (`--deployment
 * multi-instance`), not a preset. A workspace that is the deployment alone keeps its name.
 */
export function presetsLabel(preset: string): string {
  const asked = namesOf(preset).filter((name) => name !== 'multi-instance');
  return compositeName(asked.length > 0 ? asked : namesOf(preset));
}

/** `{ldap: {users: 5}}` as the `--set` keys that say it: `{'ldap.users': 5}`. */
export function qualifiedParams(byPreset: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, params] of Object.entries(byPreset)) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) continue;
    for (const [key, value] of Object.entries(params)) out[`${name}.${key}`] = value;
  }
  return out;
}

/** The names a canonical `preset` string stands for. */
export function namesOf(preset: string): string[] {
  return preset === '' ? ['default'] : preset.split(SEPARATOR);
}

function refuse(message: string): never {
  throw new ValidationError(`these presets cannot be combined: ${message}`);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Record `key` for `owner`, refusing it when another preset already claimed it. */
function claim(
  owners: Map<string, string>,
  key: string,
  owner: string,
  what: string,
  equal = false,
): boolean {
  const first = owners.get(key);
  if (first === undefined) {
    owners.set(key, owner);
    return true;
  }
  if (equal) return false;
  return refuse(`'${first}' and '${owner}' both define ${what} ${JSON.stringify(key)}`);
}

function isBag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Merge `from` into `into`, refusing a leaf two presets set differently. */
function mergeStrict(
  into: Record<string, unknown>,
  from: Record<string, unknown>,
  owners: Map<string, string>,
  owner: string,
  path: string,
): void {
  for (const [key, value] of Object.entries(from)) {
    const at = path === '' ? key : `${path}.${key}`;
    const there = into[key];
    if (isBag(there) && isBag(value)) {
      mergeStrict(there, value, owners, owner, at);
    } else if (there === undefined) {
      into[key] = structuredClone(value);
      owners.set(at, owner);
    } else if (!same(there, value)) {
      refuse(
        `'${owners.get(at) ?? '?'}' and '${owner}' set Rocket.Chat's ${JSON.stringify(at)} ` +
          'differently',
      );
    }
  }
}

/** `Kind/name` of every object a Kubernetes manifest holds. */
function objectsOf(manifest: string): string[] {
  return YAML.parseAllDocuments(manifest, { uniqueKeys: false })
    .map((doc) => doc.toJS() as unknown)
    .filter(isBag)
    .map((object) => {
      const meta = isBag(object.metadata) ? object.metadata : {};
      return `${String(object.kind ?? '')}/${String(meta.name ?? '')}`;
    });
}

interface EnvEntry {
  preset: string;
  value: string;
  soft: boolean;
}

/** The env map, by the soft/hard rule; `overridden` keys are left to the user's own value. */
function mergeEnv(
  parts: readonly Preset[],
  overridden: ReadonlySet<string>,
): [Record<string, string>, string[]] {
  const byKey = new Map<string, EnvEntry[]>();
  for (const preset of parts) {
    for (const [key, value] of Object.entries(preset.env)) {
      const entries = byKey.get(key) ?? [];
      entries.push({ preset: preset.name, value, soft: preset.softEnv?.includes(key) === true });
      byKey.set(key, entries);
    }
  }
  const env: Record<string, string> = {};
  const soft: string[] = [];
  for (const [key, entries] of byKey) {
    const hard = entries.filter((entry) => !entry.soft);
    const pool = hard.length > 0 ? hard : entries;
    if (new Set(pool.map((entry) => entry.value)).size === 1) {
      env[key] = (pool[0] as EnvEntry).value;
      if (hard.length === 0) soft.push(key);
      continue;
    }
    if (overridden.has(key)) continue;
    const setting = key.startsWith('OVERWRITE_SETTING_')
      ? `--setting ${key.slice('OVERWRITE_SETTING_'.length)}=<value>`
      : `--env ${key}=<value>`;
    refuse(
      `${pool.map((entry) => `'${entry.preset}' sets ${key}=${redactEnv(key, entry.value)}`).join(', ')}. ` +
        `Say which with ${setting}.`,
    );
  }
  return [env, soft];
}

/** Notes only a combination needs, keyed by the presets that make it. */
const COMBINED_NOTES: readonly (readonly [readonly string[], readonly string[]])[] = [
  [
    ['email', 'ldap'],
    [
      "LDAP + email: email two-factor is ON, and Rocket.Chat marks LDAP users' emails as",
      '  verified, so an LDAP login asks for a code: read it in Mailpit.',
    ],
  ],
  [
    ['ldap', 'saml'],
    [
      'LDAP + SAML: two separate user stores. Directory users are user1..N; Keycloak users',
      '  are sso-user1..N (sso-userN@example.com), so SAML never merges into an LDAP account.',
    ],
  ],
  [
    ['ldap', 'oidc'],
    [
      'LDAP + OIDC: two separate user stores. Directory users are user1..N; Keycloak users',
      '  are sso-user1..N (sso-userN@example.com), so OIDC never collides with an LDAP account.',
    ],
  ],
];

/**
 * One Preset from several, or a refusal naming both presets and what they both claim.
 *
 * `overridden` names the env keys the user sets with `--env`/`--setting`: a conflict on one of
 * those is theirs to decide, so it is left out here and their value is applied over the top.
 */
export function composePresets(
  presets: readonly Preset[],
  overridden: ReadonlySet<string> = new Set(),
): Preset {
  const byName = new Map(presets.map((preset) => [preset.name, preset]));
  const parts = [...byName.values()]
    .filter((preset) => preset.name !== 'default')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (parts.length === 0) return presets[0] ?? emptyPreset('default');
  if (parts.length === 1) return parts[0] as Preset;
  const names = parts.map((preset) => preset.name);
  if (ONE_SSO.every((name) => names.includes(name))) {
    refuse(
      "'oidc' and 'saml' each run their own Keycloak; use one SSO preset per workspace " +
        '(a shared Keycloak is not built yet)',
    );
  }

  const out = emptyPreset(names.join(SEPARATOR));
  out.source = 'composite';
  out.description = parts.map((preset) => preset.description).join(' + ');
  [out.env, out.softEnv] = mergeEnv(parts, overridden);

  const services = new Map<string, string>();
  const files = new Map<string, string>();
  const volumes = new Map<string, string>();
  const ports = new Map<string, string>();
  const actions = new Map<string, string>();
  const objects = new Map<string, string>();
  const patch = new Map<string, string>();
  const extra = new Map<string, string>();
  for (const preset of parts) {
    const owner = preset.name;
    for (const [name, service] of Object.entries(preset.services)) {
      claim(services, name, owner, 'the service');
      out.services[name] = structuredClone(service);
    }
    for (const [file, body] of preset.files) {
      claim(files, file, owner, 'the file');
      out.files.push([file, body]);
    }
    for (const [name, volume] of Object.entries(preset.volumes)) {
      const owned = volumes.get(name);
      if (owned !== undefined && !same(out.volumes[name], volume)) {
        refuse(`'${owned}' and '${owner}' both define the volume ${JSON.stringify(name)}`);
      }
      volumes.set(name, owner);
      out.volumes[name] = structuredClone(volume);
    }
    for (const port of preset.ports) {
      if (claim(ports, String(port), owner, 'the host port')) out.ports.push(port);
    }
    for (const action of preset.postReady) {
      claim(
        actions,
        `${String(action.action)} ${String(action.service ?? '')}`.trim(),
        owner,
        'the post-ready action',
      );
      out.postReady.push(structuredClone(action));
    }
    for (const manifest of preset.kubernetesManifests) {
      for (const object of objectsOf(manifest))
        claim(objects, object, owner, 'the Kubernetes object');
      out.kubernetesManifests.push(manifest);
    }
    mergeStrict(out.rocketchat, preset.rocketchat, patch, owner, '');
    for (const [key, value] of Object.entries(preset.extra)) {
      const owned = extra.get(key);
      if (owned !== undefined && !same(out.extra[key], value)) {
        refuse(`'${owned}' and '${owner}' both record ${JSON.stringify(key)}`);
      }
      extra.set(key, owner);
      out.extra[key] = structuredClone(value);
    }
    for (const dependency of preset.dependsOn) {
      if (!out.dependsOn.includes(dependency)) out.dependsOn.push(dependency);
    }
    for (const [key, help] of Object.entries(preset.paramsHelp)) {
      out.paramsHelp[`${owner}.${key}`] = help;
    }
    out.notes.push(...preset.notes);
    out.requiresLicense ||= preset.requiresLicense;
  }

  const one = (field: string, values: string[]): string => {
    const set = [...new Set(values.filter((value) => value !== ''))];
    if (set.length > 1) refuse(`they disagree on ${field}: ${set.join(' vs ')}`);
    return set[0] ?? '';
  };
  out.entryService = one(
    'the entry service',
    parts.map((preset) => preset.entryService),
  );
  out.topology = one(
    'the deployment type',
    parts.map((preset) => preset.topology),
  );
  out.instances = Number(
    one(
      'the instance count',
      parts.map((preset) => (preset.instances > 1 ? String(preset.instances) : '')),
    ) || 1,
  );
  out.scenario = parts
    .map((preset) => preset.scenario)
    .filter((scenario) => scenario !== '')
    .join(SEPARATOR);
  out.scenarioParams = Object.fromEntries(
    parts.map((preset) => [preset.name, preset.scenarioParams]),
  );
  for (const [needs, note] of COMBINED_NOTES) {
    if (needs.every((name) => names.includes(name))) out.notes.push(...note);
  }
  return out;
}
