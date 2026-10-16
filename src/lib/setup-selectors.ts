/** Saved setup selectors, shared with new-workspace creation. No environment probes. */
import * as config from './config';
import { ValidationError } from './errors';
import { isTruthy } from './format';

export const DEPLOYMENTS = ['monolith', 'multi-instance', 'microservices'];
export const SEED_PROFILES = ['none', 'small', 'standard', 'large'];
function map(value: unknown): config.Config {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as config.Config)
    : {};
}
function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
export function deployment(value: unknown): string {
  const name = value === 'default' ? 'monolith' : value;
  if (typeof name !== 'string' || !DEPLOYMENTS.includes(name))
    throw new ValidationError('deployment must be monolith, multi-instance, or microservices');
  return name;
}
export function scenarios(value: unknown): string[] {
  const items = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(items) || !items.every((item: unknown) => typeof item === 'string'))
    throw new ValidationError('scenarios must be a list of preset names');
  return [
    ...new Set(
      (items as string[])
        .map((item) => item.trim())
        .filter((item) => item !== '' && item !== 'default'),
    ),
  ];
}

/**
 * Saved config predates the TypeScript names. Keep accepting its established aliases at the
 * persistence boundary, while explicit setup input stays on the current public vocabulary.
 */
function savedDeployment(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    default: 'monolith',
    compose: 'monolith',
    docker: 'monolith',
    k8s: 'microservices',
    kubernetes: 'microservices',
  };
  return deployment((aliases[raw] ?? raw) || 'monolith');
}

/** Frozen config accepted comma-separated, mixed-case scenario defaults. */
function savedScenarios(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const values =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value
        : value instanceof Set
          ? [...value]
          : [value];
  return scenarios(
    values.flatMap((item) =>
      String(item)
        .split(',')
        .map((name) => name.trim().toLowerCase()),
    ),
  );
}

/** The legacy precedence is shared with setup and CLI creation defaults. */
export function savedSelectors(cfg: config.Config = config.loadConfig()): {
  deployment: string;
  scenarios: string[];
  answered_deployment: boolean;
  answered_scenarios: boolean;
} {
  const defaults = map(cfg.defaults);
  const dep = [cfg.default_deployment, cfg.deployment, defaults.deployment].find(isTruthy);
  // Presence is meaningful: a deliberate `default_scenarios: null` clears legacy scenarios.
  const scen = own(cfg, 'default_scenarios')
    ? cfg.default_scenarios
    : own(cfg, 'scenarios')
      ? cfg.scenarios
      : own(defaults, 'scenarios')
        ? defaults.scenarios
        : [];
  return {
    deployment: savedDeployment(dep),
    scenarios: savedScenarios(scen),
    answered_deployment: dep !== undefined,
    answered_scenarios:
      own(cfg, 'default_scenarios') || own(cfg, 'scenarios') || own(defaults, 'scenarios'),
  };
}

/** The saved first-run seed dataset; the answer setup records, else its default. */
export function savedSeedProfile(cfg: config.Config = config.loadConfig()): string {
  const profile = map(cfg.preferences).seed_profile;
  return typeof profile === 'string' && SEED_PROFILES.includes(profile) ? profile : 'small';
}

/** Whether setup saved "retain runs after evidence capture". */
export function savedRetainRuns(cfg: config.Config = config.loadConfig()): boolean {
  return map(cfg.preferences).retain_runs === true;
}
