import { Scenario } from '../../../src/lib/presets/scenario';
import { emptyPreset } from '../../../src/lib/presets/types';

const SPEC = new Scenario<{ n: number }>({
  name: 'demo',
  paramsHelp: { users: 'how many', domain: 'which domain' },
  resolveIntent: (params) => ({ n: Number(params.users ?? 1) }),
  adapters: {
    docker: (intent) => ({ ...emptyPreset('demo'), description: `docker ${String(intent.n)}` }),
    kubernetes: (intent) => ({ ...emptyPreset('demo'), description: `k8s ${String(intent.n)}` }),
  },
});

describe('a scenario', () => {
  it('dispatches to the adapter for the deployment type', () => {
    expect(SPEC.resolve({ users: '3' }, 'docker').description).toBe('docker 3');
    expect(SPEC.resolve({ users: '3' }, 'kubernetes').description).toBe('k8s 3');
  });

  it('names every unknown --set param and lists the valid ones', () => {
    // The message is the whole feature: a typo in `--set` that was silently ignored
    // produced a workspace that looked configured and was not.
    expect(() => SPEC.resolve({ user: '3', nope: '1' }, 'docker')).toThrow(
      "unknown --set param(s) for preset 'demo': nope, user - valid: domain, users",
    );
  });

  it('says what a scenario DOES support when asked for one it does not', () => {
    expect(() => SPEC.resolve({}, 'nomad')).toThrow(
      "scenario 'demo' does not support deployment type 'nomad'; supported: docker, kubernetes",
    );
  });

  it('accepts null params as no params', () => {
    expect(SPEC.resolve(null, 'docker').description).toBe('docker 1');
  });

  it('produces the same two messages earlier releases produce', () => {
    // Recorded from an earlier release's Scenario, built with the same params and adapters.
    const recorded = [
      "unknown --set param(s) for preset 'demo': nope, user - valid: domain, users",
      "scenario 'demo' does not support deployment type 'nomad'; supported: docker, kubernetes",
    ];
    const said: string[] = [];
    for (const [params, target] of [
      [{ user: '3', nope: '1' }, 'docker'],
      [{}, 'nomad'],
    ] as const) {
      try {
        SPEC.resolve(params, target);
      } catch (error) {
        said.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(said).toEqual(recorded);
  });

  it('says so plainly when a scenario has no params at all', () => {
    const bare = new Scenario<null>({
      name: 'bare',
      paramsHelp: {},
      resolveIntent: () => null,
      adapters: {},
    });
    expect(() => bare.resolve({ x: '1' }, 'docker')).toThrow('(this preset takes no --set params)');
    expect(() => bare.resolve({}, 'docker')).toThrow('supported: none');
  });
});
