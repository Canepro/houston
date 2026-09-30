/**
 * The resolved preset shape, shared by the loader, Compose and the Kubernetes adapters.
 *
 * THIS MODULE IS DATA ONLY. The catalogue loader, the seven dynamic builders and the scenario
 * adapters rank above `compose.ts`, which needs only the SHAPE; keeping the shape down here
 * is what lets `compose.ts` take a resolved `Preset` without importing any of them.
 *
 * `topology` is empty for portable presets. `scenario` and `scenarioParams` retain
 * built-in adapter provenance and are not persisted. `kubernetesManifests` holds
 * concrete backing resources, while `env` is shared by both runtimes. `error` is
 * populated only by unreadable catalogue rows.
 *
 * FIELD NAMES STAY snake_case ON THE WIRE. A `Preset` read as JSON -- the established
 * serialisation, which the compose spec compares against -- keeps `entry_service` rather
 * than `entryService`, because renaming in transit would make every mismatch a translation
 * bug rather than a behavioural one. `presetFromJSON` is the one place the two spellings meet.
 */

export interface Preset {
  name: string;
  description: string;
  env: Record<string, string>;
  services: Record<string, Record<string, unknown>>;
  rocketchat: Record<string, unknown>;
  dependsOn: string[];
  requiresLicense: boolean;
  source: string;
  files: [string, string][];
  paramsHelp: Record<string, string>;
  postReady: Record<string, unknown>[];
  notes: string[];
  instances: number;
  entryService: string;
  extra: Record<string, unknown>;
  volumes: Record<string, unknown>;
  ports: number[];
  topology: string;
  scenario: string;
  scenarioParams: Record<string, unknown>;
  kubernetesManifests: string[];
  error: string;
}

/** The established defaults, in the established order. */
export function emptyPreset(name: string): Preset {
  return {
    name,
    description: '',
    env: {},
    services: {},
    rocketchat: {},
    dependsOn: [],
    requiresLicense: false,
    source: 'built-in',
    files: [],
    paramsHelp: {},
    postReady: [],
    notes: [],
    instances: 1,
    entryService: '',
    extra: {},
    volumes: {},
    ports: [],
    topology: '',
    scenario: '',
    scenarioParams: {},
    kubernetesManifests: [],
    error: '',
  };
}

/** A record whose keys are the snake_case field names. */
type Raw = Record<string, unknown>;

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(obj(value))) out[key] = String(item);
  return out;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A `Preset` from the snake_case document of the established serialisation.
 *
 * Every field is defaulted rather than trusted, exactly as the preset parser does, so a
 * catalogue row missing a key produces the documented default instead of `undefined`
 * reaching the compose document.
 */
export function presetFromJSON(raw: Raw): Preset {
  const base = emptyPreset(String(raw.name ?? ''));
  return {
    ...base,
    description: String(raw.description ?? ''),
    env: strMap(raw.env),
    services: obj(raw.services) as Record<string, Record<string, unknown>>,
    rocketchat: obj(raw.rocketchat),
    dependsOn: list(raw.depends_on).map(String),
    requiresLicense: Boolean(raw.requires_license),
    source: String(raw.source ?? 'built-in'),
    files: list(raw.files).map((row) => {
      const pair = list(row);
      return [String(pair[0] ?? ''), String(pair[1] ?? '')] as [string, string];
    }),
    paramsHelp: strMap(raw.params_help),
    postReady: list(raw.post_ready).map(obj),
    notes: list(raw.notes).map(String),
    instances: Number(raw.instances ?? 1) || 1,
    entryService: String(raw.entry_service ?? ''),
    extra: obj(raw.extra),
    volumes: obj(raw.volumes),
    ports: list(raw.ports).map(Number),
    topology: String(raw.topology ?? ''),
    scenario: String(raw.scenario ?? ''),
    scenarioParams: obj(raw.scenario_params),
    kubernetesManifests: list(raw.kubernetes_manifests).map(String),
    error: String(raw.error ?? ''),
  };
}
