/** Goal-first setup shared by the CLI and read-only GUI API. */
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { currentContext } from '../lib/context';
import * as onboarding from '../lib/onboarding';
import { ValidationError } from '../lib/errors';
import { mongoKernelConflict } from '../lib/mongo-kernel';
import * as presets from '../lib/presets';
import {
  deployment,
  scenarios,
  savedRetainRuns,
  savedSeedProfile,
  savedSelectors,
  DEPLOYMENTS,
  SEED_PROFILES,
} from '../lib/setup-selectors';
import * as versions from '../lib/versions';
import * as host from './runner/host';
import { updateConfigIf } from './runner/locks';
import {
  canProvision,
  makeTool,
  newEnough,
  preflight,
  pretty,
  toolAt,
  toolPresent,
  toolsReady,
  which,
} from './kube/tools';
import type { Tool } from './kube/tools';
import { tools as toolFloors } from './kube/names';
import * as paths from './runner/paths';
import { ownedRuntimeState } from './kube/cluster';
import { ownerPrefix, sanitize } from './lifecycle/naming';
import { ENGINE_FLOOR_CPUS, ENGINE_FLOOR_MEMORY_GIB, engineFloorApplies } from './lifecycle/sizing';

export const SECTIONS = [
  'deployment',
  'scenarios',
  'seed',
  'cleanup',
  'authority',
  'capacity',
] as const;
const PROFILES = SEED_PROFILES;

const PREFERENCES = { retain_runs: false, kubernetes_target: 'owned-local', seed_profile: 'small' };
const FIRST_VERSION = '8.6.1';
const FIRST_NAME = 'first-repro';
const FIRST_NAME_TRIES = 50;
const REPAIR_COMMAND = 'houston onboard --deployment monolith --scenario none';

/**
 * `first-repro`, else `first-repro-2`, `-3` ... the first that `up --name` would not revive;
 * '' if none is free. With accounts, `up` stores `<actor>-<name>`, and it takes an existing
 * bare `<name>` as its own when the actor may act on it, so a name counts as used when either
 * form exists.
 */
async function firstRunName(): Promise<string> {
  const { actor } = currentContext();
  try {
    for (let n = 1; n <= FIRST_NAME_TRIES; n += 1) {
      const name = n === 1 ? FIRST_NAME : `${FIRST_NAME}-${String(n)}`;
      // As `deriveFor` stores it: `bob.smith` becomes `bob-smith-first-repro`.
      const forms = new Set([name, sanitize(ownerPrefix(sanitize(name), actor))]);
      const used = await Promise.all([...forms].map((form) => paths.exists(form)));
      if (!used.includes(true)) return name;
    }
  } catch {
    /* An unreadable workspace directory is not a free name. */
  }
  return '';
}

/** Config mappings are plain objects; YAML timestamps and tagged collections are not writable maps. */
function mapping(value: unknown): config.Config | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as config.Config) : null;
}
function map(value: unknown): config.Config {
  return mapping(value) ?? {};
}
function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function writable(cfg: config.Config, key: string): config.Config {
  if (cfg[key] !== undefined && mapping(cfg[key]) === null)
    throw new ValidationError(`${key} must be a mapping before setup can change it`);
  return map(cfg[key]);
}

function choices(dep: string): string[] {
  return presets
    .listPresets()
    .filter((preset) => {
      if (['default', 'multi-instance', 'microservices'].includes(preset.name)) return false;
      try {
        const found = presets.resolve(
          preset.name,
          dep === 'microservices' ? 'kubernetes' : 'docker',
          {},
        );
        if (dep !== 'microservices') return true;
        return Object.keys(found.services).length === 0 || found.kubernetesManifests.length > 0;
      } catch {
        return false;
      }
    })
    .map((preset) => preset.name);
}
function validatePair(dep: string, selected: string[]): void {
  const allowed = choices(dep);
  for (const name of selected)
    if (!allowed.includes(name))
      throw new ValidationError(`deployment ${dep} does not support scenario ${name}`);
  // Resolve the aggregate, including conflicts between individually supported presets.
  presets.asValidation(() =>
    presets.loadMany(
      selected.length === 0 ? ['default'] : selected,
      {},
      dep === 'microservices' ? 'kubernetes' : 'docker',
    ),
  );
}

export interface SetupPatch {
  deployment?: string;
  scenarios?: string[] | string;
  seed_profile?: string;
  retain_runs?: boolean;
  kubernetes_target?: string;
  grants?: Record<string, boolean>;
}
function validatedPatch(input: unknown): SetupPatch {
  const raw = mapping(input);
  if (raw === null) throw new ValidationError('setup patch must be a mapping');
  const allowed = [
    'deployment',
    'scenarios',
    'seed_profile',
    'retain_runs',
    'kubernetes_target',
    'grants',
  ];
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) throw new ValidationError(`unknown setup field ${key}`);
  const out: SetupPatch = {};
  if (own(raw, 'deployment')) out.deployment = deployment(raw.deployment);
  if (own(raw, 'scenarios')) out.scenarios = scenarios(raw.scenarios);
  if (own(raw, 'seed_profile')) {
    if (typeof raw.seed_profile !== 'string' || !PROFILES.includes(raw.seed_profile))
      throw new ValidationError('seed_profile must be none, small, standard, or large');
    out.seed_profile = raw.seed_profile;
  }
  if (own(raw, 'retain_runs')) {
    if (typeof raw.retain_runs !== 'boolean')
      throw new ValidationError('retain_runs must be boolean');
    out.retain_runs = raw.retain_runs;
  }
  if (own(raw, 'kubernetes_target')) {
    if (raw.kubernetes_target !== 'owned-local')
      throw new ValidationError(
        'kubernetes_target must be owned-local; remote contexts require an explicit per-request choice',
      );
    out.kubernetes_target = raw.kubernetes_target;
  }
  if (own(raw, 'grants')) {
    const grants = mapping(raw.grants);
    if (grants === null) throw new ValidationError('grants must be a mapping');
    out.grants = {};
    for (const [key, value] of Object.entries(grants)) {
      const id = key.replaceAll('_', '-');
      onboarding.checkGrantId(id);
      if (typeof value !== 'boolean') throw new ValidationError(`grant ${key} must be boolean`);
      out.grants[id] = value;
    }
  }
  return out;
}
/** Explicit replacements need not parse the malformed saved value they repair. */
function unreplacedSelectors(cfg: config.Config, patch: SetupPatch) {
  return savedSelectors({
    ...cfg,
    ...(patch.deployment === undefined ? {} : { default_deployment: patch.deployment }),
    ...(patch.scenarios === undefined ? {} : { default_scenarios: patch.scenarios }),
  });
}
function selection(cfg: config.Config, patch: SetupPatch) {
  const saved = unreplacedSelectors(cfg, patch);
  const prefs = map(cfg.preferences);
  const dep = patch.deployment ?? saved.deployment;
  let selected = patch.scenarios === undefined ? saved.scenarios : scenarios(patch.scenarios);
  if (patch.deployment !== undefined && patch.scenarios === undefined) {
    try {
      validatePair(dep, selected);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      selected = [];
    }
  }
  validatePair(dep, selected);
  return {
    deployment: dep,
    scenarios: selected,
    topology: dep === 'microservices' ? 'kubernetes' : 'compose',
    seed_profile:
      patch.seed_profile ??
      (typeof prefs.seed_profile === 'string' && PROFILES.includes(prefs.seed_profile)
        ? prefs.seed_profile
        : PREFERENCES.seed_profile),
    retain_runs: patch.retain_runs ?? prefs.retain_runs === true,
    kubernetes_target:
      patch.kubernetes_target ??
      (typeof prefs.kubernetes_target === 'string' && prefs.kubernetes_target !== ''
        ? prefs.kubernetes_target
        : PREFERENCES.kubernetes_target),
  };
}

/**
 * The selection a read-only snapshot can describe. A saved scenario no preset provides, or
 * a saved deployment that is not one, fails validation; the snapshot reports that as a
 * repair gate and shows the usable part (a valid saved deployment, no scenarios) instead
 * of throwing. A draft that replaces either value is validated strictly, as before.
 */
function describedSelection(cfg: config.Config, patch: SetupPatch) {
  try {
    return { view: selection(cfg, patch), problem: '' };
  } catch (error) {
    if (
      !(error instanceof ValidationError) ||
      patch.deployment !== undefined ||
      patch.scenarios !== undefined
    )
      throw error;
    let usable = 'monolith';
    try {
      usable = savedSelectors({ ...cfg, default_scenarios: [] }).deployment;
    } catch {
      /* The saved deployment is the invalid part. */
    }
    const clean = { ...cfg, default_deployment: usable, default_scenarios: [] };
    return { view: selection(clean, patch), problem: error.message };
  }
}

/** Read-only probes; no provisioning, context adoption, or engine resize. */
export async function detectEnvironment() {
  const engine = await host.engine();
  // Presence alone is not readiness: an outdated kubectl, Helm or Kind fails the same floors
  // `doctor` and the create path enforce. An unreadable version passes, as it does there.
  const located = Object.fromEntries(
    ['docker', 'kubectl', 'helm', 'kind'].map((name) => [name, which(name)]),
  );
  const tools = Object.fromEntries(
    Object.entries(located).map(([name, where]) => [name, where !== '']),
  );
  const versioned: Record<string, Tool> = {};
  await Promise.all(
    ['kubectl', 'helm', 'kind'].map(async (name) => {
      const where = located[name] ?? '';
      try {
        versioned[name] = await toolAt(name, where);
      } catch {
        versioned[name] = makeTool({ name, path: where });
      }
    }),
  );
  const found = preflight({ tools: versioned });
  let free: number | null = null;
  try {
    let directory = config.home();
    while (!fs.existsSync(directory) && path.dirname(directory) !== directory)
      directory = path.dirname(directory);
    const disk = fs.statfsSync(directory);
    free = (disk.bavail * disk.bsize) / 1024 ** 3;
  } catch {
    /* A failed probe is unknown, not a measured zero. */
  }
  const missing = ['kubectl', 'helm'].filter((name) => tools[name] !== true);
  const outdated = Object.entries(versioned)
    .filter(([, tool]) => toolPresent(tool) && !newEnough(tool))
    .map(([name]) => name);
  const kubernetesReady = toolsReady(found);
  // The owned-runtime probe runs kubectl only, so Helm missing or outdated does not hide it.
  const kubectl = versioned.kubectl;
  const ownedRuntime =
    kubectl !== undefined && toolPresent(kubectl) && newEnough(kubectl)
      ? await ownedRuntimeState()
      : 'unknown';
  const enoughCapacity =
    engine !== null &&
    engine.cpus >= ENGINE_FLOOR_CPUS &&
    engine.memBytes / 1024 ** 3 >= ENGINE_FLOOR_MEMORY_GIB;
  return {
    os: os.platform(),
    os_version: os.release(),
    architecture: os.arch(),
    cpus: os.cpus().length,
    memory_gib: os.totalmem() / 1024 ** 3,
    disk_free_gib: free,
    tools,
    docker_ready: engine !== null,
    engine_provider: engine?.kind ?? 'unavailable',
    engine_cpus: engine?.cpus ?? 0,
    engine_memory_gib: (engine?.memBytes ?? 0) / 1024 ** 3,
    engine_kernel_version: engine?.kernel ?? '',
    missing_kubernetes_tools: missing,
    outdated_kubernetes_tools: outdated,
    kubernetes_tool_versions: Object.fromEntries(
      Object.entries(versioned).map(([name, tool]) => [
        name,
        toolPresent(tool) ? pretty(tool) : '',
      ]),
    ),
    kubernetes_tools_ready: kubernetesReady,
    kubernetes_provisioning_available: canProvision(found) && kubernetesReady && enoughCapacity,
    owned_kubernetes_runtime: ownedRuntime,
    // A ready owned runtime is used, not built, so the provisioning floor does not apply.
    microservices_ready: ownedRuntime === 'ready' && kubernetesReady,
    engine_resize_supported: false,
  };
}
export interface SetupQuestion {
  id: string;
  section: string;
  prompt: string;
  kind: string;
  value: unknown;
  choices: { id: string; label: string }[];
  answered: boolean;
  applicable: boolean;
  grant?: string;
}
export async function snapshot(
  options: { cfg?: config.Config; draft?: SetupPatch; section?: string } = {},
) {
  const cfg = options.cfg ?? config.loadConfig();
  const patch = validatedPatch(options.draft ?? {});
  const { view, problem } = describedSelection(cfg, patch);
  let stored: Omit<ReturnType<typeof savedSelectors>, 'deployment'> & {
    deployment: string | null;
    invalid_deployment: boolean;
  };
  try {
    stored = { ...savedSelectors(cfg), invalid_deployment: false };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    // Selection already validated the replacement, or described the problem. Keep the
    // invalid durable answer distinct from both the draft and an unanswered default,
    // without writing it.
    stored = {
      ...savedSelectors({ ...cfg, default_deployment: patch.deployment ?? 'monolith' }),
      deployment: null,
      invalid_deployment: true,
      answered_deployment: true,
    };
  }
  const state = onboarding.state(cfg);
  const prefs = map(cfg.preferences);
  const section = options.section ?? '';
  if (section !== '' && !SECTIONS.some((name) => name === section))
    throw new ValidationError(`unknown setup section ${section}`);
  const environment = await detectEnvironment();
  const kube = view.topology === 'kubernetes';
  // The engine floor sizes a control plane houston would build; a ready owned runtime has one.
  const floor =
    kube && engineFloorApplies('kubernetes', environment.owned_kubernetes_runtime !== 'ready');
  const knownCapacity = environment.engine_cpus > 0 && environment.engine_memory_gib > 0;
  const enough =
    knownCapacity &&
    environment.engine_cpus >= ENGINE_FLOOR_CPUS &&
    environment.engine_memory_gib >= ENGINE_FLOOR_MEMORY_GIB;
  const capacity = {
    applicable: floor,
    provider: environment.engine_provider,
    observed_cpu: environment.engine_cpus,
    observed_memory_gib: environment.engine_memory_gib,
    required_cpu: ENGINE_FLOOR_CPUS,
    required_memory_gib: ENGINE_FLOOR_MEMORY_GIB,
    ready: !floor || enough,
    status: !floor
      ? 'not_applicable'
      : enough
        ? 'ready'
        : knownCapacity
          ? 'below_floor'
          : 'unknown',
    code: !floor || enough ? '' : knownCapacity ? 'CAPACITY_BELOW_FLOOR' : 'CAPACITY_UNKNOWN',
    supported_action: null,
    side_effects: [],
    remediation:
      floor && !enough
        ? 'Configure the engine manually, then run houston doctor --json. Automatic engine resizing is not supported.'
        : '',
    verification: 'houston doctor --json',
  };
  const resolved = versions.resolve(FIRST_VERSION, { offline: true });
  const conflict = mongoKernelConflict(resolved.mongoTag, environment.engine_kernel_version);
  const compatibility = {
    applicable: environment.engine_kernel_version !== '',
    version: FIRST_VERSION,
    mongo_version: resolved.mongoTag,
    engine_kernel_version: environment.engine_kernel_version,
    ready: conflict === '',
    status:
      conflict !== '' ? 'blocked' : environment.engine_kernel_version === '' ? 'unknown' : 'ok',
    code: conflict === '' ? '' : 'COMPATIBILITY_MONGODB_KERNEL_UNSUPPORTED',
    remediation: conflict,
  };
  const aggregate = presets.asValidation(() =>
    presets.loadMany(
      view.scenarios.length === 0 ? ['default'] : view.scenarios,
      {},
      kube ? 'kubernetes' : 'docker',
    ),
  );
  const required = kube || aggregate.requiresLicense;
  const supplied = typeof cfg.reg_token === 'string' && cfg.reg_token.trim() !== '';
  const deferred = required && !supplied && view.seed_profile !== 'none';
  const license = {
    required,
    supplied,
    status: required ? (supplied ? 'supplied' : 'required') : 'not_required',
    code: required && !supplied ? 'LICENSE_ABSENT_EE_PRESET' : '',
    seed_deferred: deferred,
    remediation: deferred
      ? 'Supply an Enterprise registration token through the existing reg_token consumer before requesting seed data.'
      : '',
  };
  const grants = { ...state.grants };
  const answeredGrants = { ...state.answered_grants };
  for (const [id, held] of Object.entries(patch.grants ?? {})) {
    grants[onboarding.grantKey(id)] = held;
    answeredGrants[onboarding.grantKey(id)] = true;
  }
  const answeredPrefs = Object.fromEntries(
    Object.keys(PREFERENCES).map((key) => [key, own(prefs, key)]),
  );
  const questions: SetupQuestion[] = [];
  function question(
    id: string,
    sec: string,
    prompt: string,
    kind: string,
    value: unknown,
    names: string[],
    answered: boolean,
    applicable = true,
    grant?: string,
  ) {
    if (section !== '' && section !== sec) return;
    questions.push({
      id,
      section: sec,
      prompt,
      kind,
      value,
      choices: names.map((name) => ({ id: name, label: name })),
      answered,
      applicable,
      ...(grant === undefined ? {} : { grant }),
    });
  }
  question(
    'deployment',
    'deployment',
    'Which deployment should new workspaces use?',
    'choice',
    view.deployment,
    DEPLOYMENTS,
    patch.deployment !== undefined || stored.answered_deployment,
  );
  question(
    'scenarios',
    'scenarios',
    'Optional scenarios, separated by commas. Enter retains the current choice; type none to clear it.',
    'multi_choice',
    view.scenarios,
    choices(view.deployment),
    patch.scenarios !== undefined || stored.answered_scenarios,
  );
  question(
    'seed_profile',
    'seed',
    'Seed dataset for the first run?',
    'choice',
    view.seed_profile,
    PROFILES,
    patch.seed_profile !== undefined || answeredPrefs.seed_profile === true,
  );
  question(
    'retain_runs',
    'cleanup',
    'Retain runs after evidence capture?',
    'boolean',
    view.retain_runs,
    [],
    patch.retain_runs !== undefined || answeredPrefs.retain_runs === true,
  );
  question(
    'owned_cluster',
    'authority',
    'May Houston create and delete its owned local Kind resources?',
    'boolean',
    grants.owned_cluster === true,
    [],
    answeredGrants.owned_cluster === true,
    kube,
    'owned-cluster',
  );
  // Legacy answers remain visible, but no unsupported resize permission is offered.
  // Leave topology selectors absent so this command resolves through the saved setup choice.
  // In particular, a saved microservices default reaches the owned-local guard instead of
  // turning the generated command into an explicit remote-adoption request.
  // A flagless `up --name X` revives a workspace already called X, so the command names one
  // that does not exist yet. With no free name the command is withheld rather than guessed.
  const firstName = await firstRunName();
  const commands = ['houston', 'up', '--version', FIRST_VERSION, '--name', firstName, '--wait'];
  if (view.seed_profile !== 'none' && !deferred)
    commands.push('--seed', '--seed-profile', view.seed_profile);
  const shell = (value: string) =>
    /^[a-zA-Z0-9_./:-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
  // A flagless command resolves its topology from persisted setup. A draft has not
  // changed those selectors yet, so it must not be presented as an executable first run.
  const runtimeUsable =
    environment.microservices_ready || environment.kubernetes_provisioning_available;
  // The command reaches `requireOnboarded()` and `requireGrant('owned-cluster')` on a local
  // Kubernetes create, so the gates below that a person must clear also block it here.
  // Completion by defaults is not a person's, exactly as `requireOnboarded()` reads it.
  const personOnboarded = state.completed_by === 'person';
  const authorized = personOnboarded && grants.owned_cluster === true;
  // A Docker create needs the engine to answer, as a Kubernetes one needs its runtime.
  const dockerDown = !kube && !environment.docker_ready;
  const firstRun =
    firstName !== '' &&
    problem === '' &&
    conflict === '' &&
    Object.keys(patch).length === 0 &&
    !dockerDown &&
    (!kube || (runtimeUsable && authorized))
      ? commands.map(shell).join(' ')
      : '';
  const gates: { kind: string; code: string; message: string; approve_with: string }[] = [];
  if (conflict !== '')
    gates.push({
      kind: 'compatibility',
      code: compatibility.code,
      message: conflict,
      approve_with: '',
    });
  if (problem !== '')
    gates.push({
      kind: 'setup',
      code: 'SETUP_SELECTION_INVALID',
      message: `Saved setup choices no longer validate: ${problem}. Repair them with: ${REPAIR_COMMAND}`,
      approve_with: '',
    });
  if (dockerDown)
    gates.push({
      kind: 'engine',
      code: 'ENGINE_UNAVAILABLE',
      message:
        'No container engine is answering. Start Docker Desktop or your container engine, ' +
        'then run houston doctor --json.',
      approve_with: '',
    });
  if (!capacity.ready)
    gates.push({
      kind: 'capacity',
      code: capacity.code,
      message: capacity.remediation,
      approve_with: '',
    });
  if (kube && !personOnboarded)
    gates.push({
      kind: 'onboarding',
      code: 'GATE_NOT_ONBOARDED',
      message: state.completed
        ? 'Onboarding was completed by defaults, not by a person. A person must complete it before local Kind lifecycle operations.'
        : 'A person must complete onboarding before local Kind lifecycle operations.',
      approve_with: onboarding.ONBOARD_COMMAND,
    });
  if (kube && environment.missing_kubernetes_tools.length > 0)
    gates.push({
      kind: 'tools',
      code: 'KUBERNETES_TOOLS_MISSING',
      message: `Missing local cluster tools: ${environment.missing_kubernetes_tools.join(', ')}`,
      approve_with: '',
    });
  // Kind only matters while the owned runtime cannot already be used.
  const outdated = environment.outdated_kubernetes_tools.filter(
    (name) => name !== 'kind' || !environment.microservices_ready,
  );
  if (kube && outdated.length > 0)
    gates.push({
      kind: 'tools',
      code: 'KUBERNETES_TOOLS_OUTDATED',
      message: `Outdated local cluster tools: ${outdated
        .map(
          (name) =>
            `${name} ${environment.kubernetes_tool_versions[name] ?? '?'} (needs ${(toolFloors()[name] ?? []).join('.')}+)`,
        )
        .join(', ')}`,
      approve_with: '',
    });
  if (
    kube &&
    !runtimeUsable &&
    environment.owned_kubernetes_runtime !== 'ready' &&
    environment.kubernetes_tools_ready
  )
    gates.push({
      kind: 'runtime',
      code:
        environment.owned_kubernetes_runtime === 'unavailable'
          ? 'OWNED_KUBERNETES_UNAVAILABLE'
          : 'OWNED_KUBERNETES_UNKNOWN',
      message:
        `Owned local runtime is ${environment.owned_kubernetes_runtime}; ` +
        'Kind provisioning is unavailable. Restore the owned client/cluster or install a current Kind and satisfy the engine capacity prerequisites.',
      approve_with: '',
    });
  if (kube && grants.owned_cluster !== true)
    gates.push({
      kind: 'grant',
      code: 'GATE_OWNED_CLUSTER',
      message: 'Local Kind lifecycle requires a person to grant owned-cluster.',
      approve_with: onboarding.grantCommand('owned-cluster'),
    });
  return {
    schema: 'houston.setup.v1',
    completed: state.completed,
    persisted: {
      ...state,
      deployment: stored.deployment,
      invalid_deployment: stored.invalid_deployment,
      selection_problem: problem,
      scenarios: stored.scenarios,
      answered_deployment: stored.answered_deployment,
      answered_scenarios: stored.answered_scenarios,
      preferences: Object.fromEntries(
        Object.entries(PREFERENCES).map(([key]) => [
          key,
          key === 'seed_profile'
            ? savedSeedProfile(cfg)
            : key === 'retain_runs'
              ? savedRetainRuns(cfg)
              : typeof prefs.kubernetes_target === 'string' && prefs.kubernetes_target !== ''
                ? prefs.kubernetes_target
                : PREFERENCES.kubernetes_target,
        ]),
      ),
      answered_preferences: answeredPrefs,
      legacy_engine_resize: {
        held: map(cfg.grants).engine_resize === true,
        answered: own(map(cfg.grants), 'engine_resize'),
      },
      omitted_secret_keys: ['reg_token'],
    },
    selection: view,
    environment,
    capacity,
    compatibility,
    license,
    questions: questions.filter((q) => q.applicable),
    hidden_questions: questions.filter((q) => !q.applicable),
    gates,
    actions: [],
    conflicts:
      kube && answeredGrants.owned_cluster === true && grants.owned_cluster !== true
        ? [
            {
              code: 'CONFLICT_OWNED_CLUSTER_DENIED',
              message: 'Kubernetes create will gate until reconfigured.',
            },
          ]
        : [],
    review: { ...view, grants },
    first_run_command: firstRun,
    sections: [...SECTIONS],
    legacy_preset_alias: true,
  };
}

function defaultPatch(
  cfg: config.Config,
  explicit: SetupPatch,
  defaults: boolean,
  section: string,
): SetupPatch {
  const patch = { ...explicit };
  if (!defaults) return patch;
  const saved = unreplacedSelectors(cfg, explicit);
  const storedPrefs = map(cfg.preferences);
  const want = (name: string) => section === '' || section === name;
  if (want('deployment') && !saved.answered_deployment && patch.deployment === undefined)
    patch.deployment = saved.deployment;
  if (want('scenarios') && !saved.answered_scenarios && patch.scenarios === undefined)
    patch.scenarios = saved.scenarios;
  if (want('seed') && !own(storedPrefs, 'seed_profile') && patch.seed_profile === undefined)
    patch.seed_profile = PREFERENCES.seed_profile;
  if (want('cleanup') && !own(storedPrefs, 'retain_runs') && patch.retain_runs === undefined)
    patch.retain_runs = false;
  return patch;
}

/** Validate under the config lock, then apply only supplied answers in one atomic write. */
export async function applyPatch(
  raw: SetupPatch,
  options: { defaults?: boolean; section?: string; by?: onboarding.OnboardedBy } = {},
) {
  // A library caller that does not say who answered never claims it was a person.
  const by = options.by ?? 'defaults';
  const explicit = validatedPatch(raw);
  const section = options.section ?? '';
  if (section !== '' && !SECTIONS.some((name) => name === section))
    throw new ValidationError(`unknown setup section ${section}`);
  const changed = await updateConfigIf((cfg) => {
    const patch = defaultPatch(cfg, explicit, options.defaults === true, section);
    if (Object.keys(patch).length === 0) return false;
    const saved = unreplacedSelectors(cfg, patch);
    const view = selection(cfg, patch);
    // Check all writable maps before mutating any of them.
    writable(cfg, 'onboarding');
    if (patch.grants !== undefined) writable(cfg, 'grants');
    for (const [id, held] of Object.entries(patch.grants ?? {})) {
      if (held) onboarding.grant(cfg, id, new Date(), by);
      else onboarding.revoke(cfg, id, new Date(), by);
    }
    const preferenceKeys = ['seed_profile', 'retain_runs', 'kubernetes_target'] as const;
    if (preferenceKeys.some((key) => own(patch, key))) {
      const prefs = writable(cfg, 'preferences');
      for (const key of preferenceKeys) {
        if (patch[key] !== undefined) prefs[key] = patch[key];
      }
      cfg.preferences = prefs;
    }
    if (patch.deployment !== undefined) cfg.default_deployment = view.deployment;
    if (
      patch.scenarios !== undefined ||
      (patch.deployment !== undefined &&
        JSON.stringify(saved.scenarios) !== JSON.stringify(view.scenarios))
    )
      cfg.default_scenarios = view.scenarios;
    onboarding.complete(cfg, new Date(), by);
    return true;
  });
  return { ...(await snapshot({ section })), changed };
}
