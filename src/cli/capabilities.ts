import { seedCatalogue } from '../lib/seed-options';
import { state as skillState } from '../core/skill';
import { DEPLOYMENTS, DOCKER, REGISTERED } from '../core/topology';
import { DEFAULT_BIND_HOST } from '../lib/config';
import { errorCodes, EXIT_CODES } from '../lib/errors';
import { CONTRACT, getHoustonVersion, PHASES } from '../lib/jsonout';
import { state as onboardingState } from '../lib/onboarding';
import { listPresets } from '../lib/presets';
import { compareCodePoints } from '../lib/format';
import { PROFILES } from '../lib/seed-profiles';

import { COMMAND_SPECS } from './spec-data';
import type { CommandSpec } from './spec-types';

export interface CommandDescription {
  name: string;
  flags: string[];
  json: boolean;
  schema?: string;
  schemas?: string[];
  streams?: boolean;
}

/** Read the parser's source objects, never a parallel capabilities catalogue. */
export function describeCommands(
  specs: readonly CommandSpec[] = COMMAND_SPECS,
): CommandDescription[] {
  return specs
    .map((spec) => {
      const speaksJson = spec.json.mode !== 'none';
      const flags = spec.options.map((option) => option.long);
      if (spec.json.mode === 'flag') flags.push('--json');
      const result: CommandDescription = {
        name: spec.path,
        flags: [...new Set(flags)].sort(),
        json: speaksJson,
      };
      if (speaksJson) {
        result.schema = spec.json.schema as string;
        if (spec.json.variants !== undefined) {
          result.schemas = [...Object.values(spec.json.variants.byValue)].sort();
        }
        result.streams = spec.json.streams;
      }
      return result;
    })
    .sort((left, right) => compareCodePoints(left.name, right.name));
}

export function capabilities(): Record<string, unknown> {
  let presets: string[] = [];
  try {
    presets = listPresets()
      .map((preset) => preset.name)
      .sort(compareCodePoints);
  } catch {
    // Capability discovery must remain offline and best-effort.
  }
  let skill: Record<string, unknown> = {};
  try {
    skill = skillState() as unknown as Record<string, unknown>;
  } catch {
    // Optional host state must not hide the command contract.
  }
  // Whether a person has onboarded this machine and which grants they handed over. A
  // caller reads this instead of config.yaml, which keeps the file an implementation
  // detail rather than a second contract. A config that cannot be read answers as a
  // fresh machine: discovery must not fail on it.
  let onboarding: Record<string, unknown>;
  try {
    onboarding = onboardingState() as unknown as Record<string, unknown>;
  } catch {
    onboarding = onboardingState({}) as unknown as Record<string, unknown>;
  }
  return {
    contract_versions: [CONTRACT],
    houston_version: getHoustonVersion(),
    commands: describeCommands(),
    phases: [...PHASES],
    error_codes: errorCodes(),
    exit_codes: Object.fromEntries(
      Object.entries(EXIT_CODES).sort(([left], [right]) => Number(left) - Number(right)),
    ),
    presets,
    seed_profiles: Object.keys(PROFILES).sort(),
    seed_options: seedCatalogue(),
    runtimes: Object.entries(DEPLOYMENTS).map(([name, deployments]) => ({
      name,
      deployments: [...deployments],
      default_deployment: deployments[0],
      creatable: REGISTERED.has(name),
    })),
    default_runtime: DOCKER,
    default_bind_host: DEFAULT_BIND_HOST,
    skill,
    onboarding,
  };
}
