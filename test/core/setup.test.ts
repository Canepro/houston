/** Setup draft and transient assessments that the CLI and GET API share. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as setup from '../../src/core/setup';
import * as config from '../../src/lib/config';
import { ValidationError } from '../../src/lib/errors';
import * as host from '../../src/core/runner/host';
import type * as PolicyNS from '../testsetup-policy';
jest.mock('../../src/core/runner/host', () => {
  const healthy = (require('../testsetup-policy') as typeof PolicyNS).healthyHost();
  return { ...healthy, engine: jest.fn(healthy.engine) };
});

it('previews a draft without changing durable answers, and rejects invalid patch types before writing', async () => {
  config.saveConfig({
    default_deployment: 'monolith',
    preferences: { seed_profile: 'large', retain_runs: true },
    future: { keep: true },
  });
  const file = path.join(config.home(), 'config.yaml');
  const before = fs.readFileSync(file);
  const preview = await setup.snapshot({ draft: { seed_profile: 'none', retain_runs: false } });
  expect(preview.persisted.preferences).toMatchObject({ seed_profile: 'large', retain_runs: true });
  expect(preview.selection).toMatchObject({ seed_profile: 'none', retain_runs: false });
  expect(preview.first_run_command).not.toContain('--seed');
  for (const patch of [
    { retain_runs: 'false' },
    { grants: { owned_cluster: 'true' } },
    { reg_token: 'private' },
  ]) {
    await expect(setup.applyPatch(patch as setup.SetupPatch)).rejects.toBeInstanceOf(
      ValidationError,
    );
  }
  expect(fs.readFileSync(file)).toEqual(before);
});

it('retains a stored Kubernetes target and leaves unrelated malformed preferences alone', async () => {
  config.saveConfig({
    preferences: { kubernetes_target: 'named-context', future: 'keep' },
    grants: { future_grant: true },
  });
  const preview = await setup.snapshot();
  expect(preview.persisted.preferences).toMatchObject({ kubernetes_target: 'named-context' });
  expect(preview.selection.kubernetes_target).toBe('named-context');
  expect(preview.first_run_command).not.toContain('named-context');
  await setup.applyPatch({ grants: { 'owned-cluster': true } });
  expect(config.loadConfig(false).preferences).toEqual({
    kubernetes_target: 'named-context',
    future: 'keep',
  });

  config.saveConfig({ preferences: ['legacy'], grants: { future_grant: true } });
  await expect(setup.applyPatch({ grants: { 'owned-cluster': true } })).resolves.toMatchObject({
    completed: true,
  });
  expect(config.loadConfig(false).preferences).toEqual(['legacy']);
});

it('clears a dependent scenario only for a deployment-only change and preserves unrelated state', async () => {
  const directory = path.join(config.home(), 'presets');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'compose-only.yaml'),
    'name: compose-only\ntopology: docker\nservices:\n  helper:\n    image: busybox\n',
  );
  config.saveConfig({
    default_deployment: 'monolith',
    default_scenarios: ['compose-only'],
    preferences: { future: 'keep' },
    grants: { engine_resize: false },
  });
  const before = fs.readFileSync(path.join(config.home(), 'config.yaml'));
  await expect(
    setup.applyPatch({ deployment: 'microservices', scenarios: ['compose-only'] }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(fs.readFileSync(path.join(config.home(), 'config.yaml'))).toEqual(before);
  const changed = await setup.applyPatch({ deployment: 'microservices' });
  expect(changed.selection.scenarios).toEqual([]);
  expect(config.loadConfig(false)).toMatchObject({
    default_scenarios: [],
    preferences: { future: 'keep' },
    grants: { engine_resize: false },
  });
});

it('reports measured Podman capacity and the current MongoDB kernel boundary without offering automatic resize', async () => {
  const observed = await host.engine();
  if (observed === null) throw new Error('the test engine fixture is required');
  const engine = jest.mocked(host.engine).mockResolvedValue({
    ...observed,
    kind: 'podman',
    cpus: 2,
    memBytes: 3 * 1024 ** 3,
    kernel: '7.0.13',
  });
  try {
    const blocked = await setup.snapshot({ draft: { deployment: 'microservices' } });
    expect(blocked.capacity).toMatchObject({
      provider: 'podman',
      ready: false,
      status: 'below_floor',
      supported_action: null,
    });
    expect(blocked.environment.engine_resize_supported).toBe(false);
    expect(blocked.compatibility.ready).toBe(false);
    expect(blocked.first_run_command).toBe('');
    engine.mockResolvedValue({ ...observed, kernel: '7.0.14' });
    const fixed = await setup.snapshot();
    expect(fixed.compatibility.ready).toBe(true);
    expect(fixed.first_run_command).toContain('houston up');
  } finally {
    engine.mockResolvedValue(observed);
  }
});
