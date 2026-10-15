/** Saved setup selectors, shared with new-workspace creation. No environment probes. */
import * as config from './config';
import { ValidationError } from './errors';

export const DEPLOYMENTS = ['monolith', 'multi-instance', 'microservices'];
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

/** The legacy precedence is shared with setup and CLI creation defaults. */
export function savedSelectors(cfg: config.Config = config.loadConfig()): {
  deployment: string;
  scenarios: string[];
  answered_deployment: boolean;
  answered_scenarios: boolean;
} {
  const defaults = map(cfg.defaults);
  const dep = [cfg.default_deployment, cfg.deployment, defaults.deployment].find(
    (value: unknown) => value !== undefined && value !== null && value !== '',
  );
  const scen = cfg.default_scenarios ?? cfg.scenarios ?? defaults.scenarios;
  return {
    deployment: deployment(dep ?? 'monolith'),
    scenarios: scenarios(scen ?? []),
    answered_deployment: dep !== undefined,
    answered_scenarios:
      own(cfg, 'default_scenarios') || own(cfg, 'scenarios') || own(defaults, 'scenarios'),
  };
}
