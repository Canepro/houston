/**
 * Internal contract for built-in reproduction scenarios.
 *
 * The public aggregate remains `Preset`. A scenario owns only the deployment-neutral intent
 * and its parameter contract; each adapter turns that intent into the native fields one
 * supported deployment type needs. There is deliberately no plugin loading and no public CLI
 * surface here.
 */
import type { Params } from './registry';
import type { Preset } from './types';

export interface ScenarioSpec<Intent> {
  readonly name: string;
  readonly paramsHelp: Readonly<Record<string, string>>;
  readonly resolveIntent: (params: Params) => Intent;
  readonly adapters: Readonly<Record<string, (intent: Intent) => Preset>>;
}

/** One built-in scenario and its small deployment-specific adapters. */
export class Scenario<Intent = unknown> {
  readonly name: string;
  readonly paramsHelp: Readonly<Record<string, string>>;
  readonly resolveIntent: (params: Params) => Intent;
  readonly adapters: Readonly<Record<string, (intent: Intent) => Preset>>;

  constructor(spec: ScenarioSpec<Intent>) {
    this.name = spec.name;
    this.paramsHelp = spec.paramsHelp;
    this.resolveIntent = spec.resolveIntent;
    this.adapters = spec.adapters;
  }

  resolve(params: Params | null | undefined, deploymentType: string): Preset {
    const given = { ...(params ?? {}) };
    const known = new Set(Object.keys(this.paramsHelp));
    const unknown = Object.keys(given)
      .filter((key) => !known.has(key))
      .sort();
    if (unknown.length > 0) {
      const valid =
        Object.keys(this.paramsHelp).sort().join(', ') || '(this preset takes no --set params)';
      throw new Error(
        `unknown --set param(s) for preset '${this.name}': ${unknown.join(', ')} - valid: ${valid}`,
      );
    }
    const adapter = this.adapters[deploymentType];
    if (adapter === undefined) {
      const supported = Object.keys(this.adapters).sort().join(', ') || 'none';
      throw new Error(
        `scenario '${this.name}' does not support deployment type ` +
          `'${deploymentType}'; supported: ${supported}`,
      );
    }
    return adapter(this.resolveIntent(given));
  }
}
