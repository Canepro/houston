/** Setup draft and transient assessments that the CLI and GET API share. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as setup from '../../src/core/setup';
import * as config from '../../src/lib/config';
import { ValidationError } from '../../src/lib/errors';
import { savedSelectors } from '../../src/lib/setup-selectors';
import * as host from '../../src/core/runner/host';
import { humanLines } from '../../src/cli/handlers/setup';
import { kube, ownedKubeconfig } from '../../src/core/kube/exec';
import {
  CLUSTER_NAME,
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
  CONTEXT,
} from '../../src/core/kube/names';
import type * as KubeToolsNS from '../../src/core/kube/tools';
import type * as PolicyNS from '../testsetup-policy';
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof fs>('node:fs');
  return { ...actual, statfsSync: jest.fn(actual.statfsSync) };
});
let mockKubernetesToolsAvailable = false;
let mockMissingTools: string[] = [];
jest.mock('../../src/core/runner/host', () => {
  const healthy = (require('../testsetup-policy') as typeof PolicyNS).healthyHost();
  return { ...healthy, engine: jest.fn(healthy.engine) };
});
jest.mock('../../src/core/kube/tools', () => {
  const actual = jest.requireActual<typeof KubeToolsNS>('../../src/core/kube/tools');
  return {
    ...actual,
    which: (name: string) =>
      mockKubernetesToolsAvailable && !mockMissingTools.includes(name) ? `/test/${name}` : '',
  };
});

it('previews a draft without changing durable answers, and rejects invalid patch types before writing', async () => {
  config.saveConfig({
    default_deployment: 'monolith',
    preferences: { seed_profile: 'large', retain_runs: true },
    future: { keep: true },
  });
  const file = path.join(config.home(), 'config.yaml');
  const before = fs.readFileSync(file);
  const preview = await setup.snapshot({
    draft: { deployment: 'microservices', seed_profile: 'none', retain_runs: false },
  });
  expect(preview.persisted.preferences).toMatchObject({ seed_profile: 'large', retain_runs: true });
  expect(preview.selection).toMatchObject({
    deployment: 'microservices',
    seed_profile: 'none',
    retain_runs: false,
  });
  expect(preview.first_run_command).toBe('');
  config.saveConfig({ default_deployment: 'broken', default_scenarios: ['email'] });
  const invalidBefore = fs.readFileSync(file);
  await expect(setup.snapshot()).rejects.toThrow(/deployment/u);
  const repairedDraft = await setup.snapshot({ draft: { deployment: 'monolith' } });
  expect(repairedDraft.selection).toMatchObject({ deployment: 'monolith', scenarios: ['email'] });
  expect(repairedDraft.persisted).toMatchObject({
    deployment: null,
    invalid_deployment: true,
    answered_deployment: true,
    scenarios: ['email'],
  });
  expect(repairedDraft.first_run_command).toBe('');
  const replacedBoth = await setup.snapshot({
    draft: { deployment: 'monolith', scenarios: [] },
  });
  expect(replacedBoth.selection.scenarios).toEqual([]);
  expect(replacedBoth.persisted.scenarios).toEqual(['email']);
  expect(fs.readFileSync(file)).toEqual(invalidBefore);
  fs.writeFileSync(file, before);
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

it('refuses non-plain targeted mappings without rewriting their source bytes', async () => {
  const file = path.join(config.home(), 'config.yaml');
  const cases: [string, string, setup.SetupPatch][] = [
    ['timestamp preferences', 'preferences: 2026-10-15\n', { seed_profile: 'none' }],
    [
      'ordered-map grants',
      'grants: !!omap\n  - owned_cluster: false\n',
      { grants: { 'owned-cluster': true } },
    ],
    ['set onboarding', 'onboarding: !!set\n  legacy: null\n', { retain_runs: true }],
  ];
  for (const [label, raw, patch] of cases) {
    fs.writeFileSync(file, raw);
    const before = fs.readFileSync(file);
    await expect(setup.applyPatch(patch)).rejects.toThrow(/must be a mapping/u);
    expect({ label, after: fs.readFileSync(file) }).toEqual({ label, after: before });
  }
});

it('keeps frozen saved selector aliases, falsy fallback, and a present null scenarios value', () => {
  for (const [stored, expected] of [
    [' Default ', 'monolith'],
    ['compose', 'monolith'],
    ['DOCKER', 'monolith'],
    [' k8s ', 'microservices'],
    ['KUBERNETES', 'microservices'],
  ]) {
    expect(savedSelectors({ default_deployment: stored } as never).deployment).toBe(expected);
  }
  for (const ignored of [false, 0, [], {}]) {
    expect(
      savedSelectors({ default_deployment: ignored, deployment: 'microservices' } as never),
    ).toMatchObject({ deployment: 'microservices', answered_deployment: true });
  }
  expect(savedSelectors({ default_scenarios: null, scenarios: ['email'] } as never)).toMatchObject({
    scenarios: [],
    answered_scenarios: true,
  });
});

it('describes the scenario prompt as retaining Enter and clearing with none', async () => {
  const view = await setup.snapshot();
  const question = view.questions.find((item) => item.id === 'scenarios');
  expect(question?.prompt).toContain('Enter retains the current choice; type none to clear it.');
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
  mockKubernetesToolsAvailable = true;
  try {
    const blocked = await setup.snapshot({ draft: { deployment: 'microservices' } });
    expect(blocked.capacity).toMatchObject({
      provider: 'podman',
      ready: false,
      status: 'below_floor',
      supported_action: null,
    });
    expect(blocked.environment.engine_resize_supported).toBe(false);
    expect(blocked.environment.microservices_ready).toBe(false);
    expect(blocked.compatibility.ready).toBe(false);
    expect(blocked.first_run_command).toBe('');
    engine.mockResolvedValue({ ...observed, kernel: '7.0.14' });
    const fixed = await setup.snapshot();
    expect(fixed.compatibility.ready).toBe(true);
    expect(fixed.environment.microservices_ready).toBe(false);
    expect(fixed.environment.kubernetes_provisioning_available).toBe(true);
    expect(fixed.first_run_command).toContain('houston up');
  } finally {
    engine.mockResolvedValue(observed);
    mockKubernetesToolsAvailable = false;
  }
});

it('distinguishes owned runtime readiness from provisioning and refuses an unusable first run', async () => {
  mockKubernetesToolsAvailable = true;
  mockMissingTools = ['kind'];
  const cfg = {
    default_deployment: 'microservices',
    onboarding: { completed_at: '2026-10-15T00:00:00Z' },
    grants: { owned_cluster: true },
  };
  try {
    const client = ownedKubeconfig();
    const cases = [
      { name: 'missing client', state: 'unavailable', client: false, marker: '', ready: 'ok' },
      { name: 'absent marker', state: 'unavailable', client: true, marker: '', ready: 'ok' },
      {
        name: 'foreign marker',
        state: 'unknown',
        client: true,
        marker: '{"metadata":{}}',
        ready: 'ok',
      },
      { name: 'malformed marker', state: 'unknown', client: true, marker: '{', ready: 'ok' },
      { name: 'unreachable API', state: 'unknown', client: true, marker: 'owned', ready: '' },
      { name: 'marked healthy', state: 'ready', client: true, marker: 'owned', ready: 'ok' },
    ];
    for (const evidence of cases) {
      fs.rmSync(path.join(config.home(), 'clients'), { recursive: true, force: true });
      if (evidence.client) {
        fs.mkdirSync(path.dirname(client), { recursive: true });
        fs.writeFileSync(client, 'test owned client');
      }
      const before = fs.readdirSync(config.home(), { recursive: true });
      const run = jest.spyOn(kube, 'run').mockImplementation(async (argv) => {
        const marker = argv.includes('--ignore-not-found');
        if (!marker && !argv.includes('/readyz')) throw new Error('unexpected non-read probe');
        return {
          argv: [...argv],
          returncode: marker || evidence.ready === 'ok' ? 0 : 1,
          stdout: marker
            ? evidence.marker === 'owned'
              ? JSON.stringify({
                  metadata: { labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE } },
                  data: { cluster: CLUSTER_NAME },
                })
              : evidence.marker
            : evidence.ready,
          stderr: '',
        };
      });
      const state = evidence.state;
      let view: Awaited<ReturnType<typeof setup.snapshot>>;
      try {
        view = await setup.snapshot({ cfg });
        if (!evidence.client) expect(run).not.toHaveBeenCalled();
        if (state === 'ready') {
          const ungranted = await setup.snapshot({ cfg: { ...cfg, grants: {} } });
          expect(ungranted.gates.map((gate) => gate.code)).toContain('GATE_OWNED_CLUSTER');
          const observed = await host.engine();
          if (observed === null) throw new Error('the test engine fixture is required');
          jest.mocked(host.engine).mockResolvedValueOnce({ ...observed, cpus: 1 });
          const insufficient = await setup.snapshot({ cfg });
          expect(insufficient.environment.owned_kubernetes_runtime).toBe('ready');
          expect(insufficient.environment.microservices_ready).toBe(false);
          expect(insufficient.first_run_command).toBe('');
          expect(insufficient.gates.some((gate) => gate.kind === 'capacity')).toBe(true);
          expect(insufficient.gates.some((gate) => gate.kind === 'runtime')).toBe(false);
        }
        for (const [argv, options] of run.mock.calls) {
          expect(options?.env?.KUBECONFIG).toBe(client);
          expect(argv.slice(0, 3)).toEqual(['kubectl', '--context', CONTEXT]);
          expect(argv).toContain('get');
          expect(argv.includes('--ignore-not-found') || argv.includes('/readyz')).toBe(true);
          expect(argv.some((part) => ['apply', 'create', 'delete', 'export'].includes(part))).toBe(
            false,
          );
        }
        expect(fs.readdirSync(config.home(), { recursive: true })).toEqual(before);
        if (evidence.client) expect(fs.readFileSync(client, 'utf8')).toBe('test owned client');
      } finally {
        run.mockRestore();
      }
      expect(view.environment.missing_kubernetes_tools).toEqual([]);
      expect(view.environment.microservices_ready).toBe(state === 'ready');
      expect(view.environment).toMatchObject({
        owned_kubernetes_runtime: state,
        microservices_ready: state === 'ready',
        kubernetes_provisioning_available: false,
      });
      expect(view.gates.map((gate) => gate.code)).not.toContain('KUBERNETES_TOOLS_MISSING');
      const lines = humanLines(view).join('\n');
      expect(lines).toContain(`owned runtime ${state}`);
      expect(lines).toContain('Kind provisioning unavailable');
      if (state === 'ready') {
        expect(view.first_run_command).toContain('houston up');
        expect(view.gates).toEqual([]);
      } else {
        expect(view.first_run_command).toBe('');
        expect(view.gates.map((gate) => gate.code)).toContain(
          `OWNED_KUBERNETES_${state.toUpperCase()}`,
        );
        expect(lines).toContain('first run   (blocked)');
      }
    }
    fs.rmSync(path.join(config.home(), 'clients'), { recursive: true, force: true });
    mockMissingTools = [];
    const provision = await setup.snapshot({ cfg });
    expect(provision.environment.kubernetes_provisioning_available).toBe(true);
    expect(provision.environment.microservices_ready).toBe(false);
    expect(provision.first_run_command).toContain('houston up');
    expect(humanLines(provision).join('\n')).toContain('requires provisioning');
    mockMissingTools = ['helm', 'kubectl', 'kind'];
    const blocked = await setup.snapshot({ cfg });
    expect(blocked.environment.missing_kubernetes_tools).toEqual(['kubectl', 'helm']);
    expect(blocked.environment.microservices_ready).toBe(false);
    expect(blocked.gates.map((gate) => gate.code)).toContain('KUBERNETES_TOOLS_MISSING');
    expect(blocked.first_run_command).toBe('');
  } finally {
    mockKubernetesToolsAvailable = false;
    mockMissingTools = [];
    fs.rmSync(path.join(config.home(), 'clients'), { recursive: true, force: true });
  }
});

it('measures a fresh home through its existing parent and reports failed capacity probes as unknown', async () => {
  const original = process.env.HOUSTON_HOME;
  const parent = config.home();
  const expected = fs.statfsSync(parent);
  process.env.HOUSTON_HOME = path.join(parent, 'not-created', 'nested');
  try {
    const view = await setup.detectEnvironment();
    expect(view.disk_free_gib).toBeGreaterThan(0);
    expect(view.disk_free_gib).toBeCloseTo((expected.bavail * expected.bsize) / 1024 ** 3, 0);
    expect(fs.existsSync(config.home())).toBe(false);
    jest.mocked(fs.statfsSync).mockImplementationOnce(() => {
      throw new Error('probe denied');
    });
    expect((await setup.detectEnvironment()).disk_free_gib).toBeNull();
  } finally {
    process.env.HOUSTON_HOME = original;
  }
});

it('repairs an invalid saved deployment only when explicitly replaced and preserves unrelated config', async () => {
  config.saveConfig({
    default_deployment: 'broken',
    default_scenarios: ['email'],
    future: { keep: true },
  });
  const file = path.join(config.home(), 'config.yaml');
  const before = fs.readFileSync(file);
  await expect(setup.applyPatch({ seed_profile: 'none' })).rejects.toThrow(/deployment/u);
  expect(fs.readFileSync(file)).toEqual(before);
  const fixed = await setup.applyPatch({ deployment: 'monolith' });
  expect(fixed.selection).toMatchObject({ deployment: 'monolith', scenarios: ['email'] });
  expect(config.loadConfig(false)).toMatchObject({
    default_deployment: 'monolith',
    future: { keep: true },
  });
});
