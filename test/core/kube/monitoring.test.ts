import { kube } from '../../../src/core/kube/exec';
import { DockerError } from '../../../src/lib/errors';
import {
  ensureMonitoring,
  removeGrafanaIngress,
  removeMonitoring,
} from '../../../src/core/kube/monitoring';
import { grafanaIngressName } from '../../../src/core/kube/grafana-ingress';

let installed = false;
let values: Record<string, unknown> = {};
let env: Record<string, unknown>[] = [];
let refused = false;
let resources = false;
let logsDashboard: Record<string, unknown> | null = null;
const calls: { argv: readonly string[]; input: string | undefined }[] = [];

beforeEach(() => {
  installed = false;
  values = {};
  env = [];
  refused = false;
  resources = false;
  logsDashboard = null;
  calls.length = 0;
  jest.spyOn(kube, 'run').mockImplementation(async (argv, options = {}) => {
    calls.push({ argv, input: options.input });
    const result = (doc: unknown = '', returncode = 0) => ({
      argv,
      returncode,
      stdout: typeof doc === 'string' ? doc : JSON.stringify(doc),
      stderr: returncode ? 'forbidden' : '',
    });
    if (argv[0] === 'helm') {
      if (argv.includes('version')) return result('v3.17.0');
      if (argv.includes('list'))
        return result(installed ? [{ name: 'monitoring', status: 'deployed', revision: 1 }] : []);
      if (argv.includes('get')) return result(values);
      if (argv.includes('upgrade')) {
        const host =
          argv.find((arg) => arg.startsWith('ingress.grafana.host='))?.split('=')[1] ??
          'localhost:5050';
        const tls = argv.includes('ingress.tls=true');
        values = {
          ...values,
          ingress: { enabled: false, tls, grafana: { host, path: '/grafana' } },
        };
        env = [
          { name: 'GF_SERVER_ROOT_URL', value: `${tls ? 'https' : 'http'}://${host}/grafana/` },
        ];
      }
      return result();
    }
    if (argv.includes('patch') && argv.includes('grafana')) {
      const patch = JSON.parse(argv[argv.indexOf('-p') + 1] as string) as {
        spec: {
          deployment: { spec: { template: { spec: { containers: { env: typeof env }[] } } } };
        };
      };
      env = patch.spec.deployment.spec.template.spec.containers[0]?.env ?? [];
      return result();
    }
    if (argv.includes('get')) {
      if (
        argv.includes('grafanadashboard') &&
        !argv.includes('-l') &&
        !argv.some((arg) => arg.startsWith('jsonpath='))
      )
        return result(logsDashboard ?? '');
      if (argv.some((arg) => arg.startsWith('jsonpath=')))
        return result(argv.includes('deployment') ? '1' : '');
      if (argv.includes('customresourcedefinition'))
        return result({ metadata: { name: 'certificates.cert-manager.io' } });
      if (argv.includes('-l'))
        return refused
          ? result('', 1)
          : result({
              items:
                resources && !argv.includes('namespace')
                  ? [{ metadata: { name: 'grafana-w' } }]
                  : [],
            });
      if (argv.includes('grafana'))
        return result({
          spec: {
            deployment: {
              spec: { template: { spec: { containers: [{ name: 'grafana', env }] } } },
            },
          },
        });
      if (argv.includes('deployment'))
        return result({
          metadata: { generation: 1 },
          spec: { replicas: 1, template: { spec: { containers: [{ name: 'grafana', env }] } } },
          status: { observedGeneration: 1, updatedReplicas: 1, availableReplicas: 1 },
        });
      if (argv.includes('namespace')) return result({ items: [] });
    }
    return result();
  });
});

describe('Grafana public URL regression: the shared stack', () => {
  it('provisions the Logs dashboard for both new and already-installed stacks', async () => {
    for (const alreadyInstalled of [false, true]) {
      installed = alreadyInstalled;
      calls.length = 0;
      await ensureMonitoring({ context: 'prod' });
      const applied = calls.find((call) => call.argv.includes('apply'));
      expect(applied).toBeDefined();
      const manifest = JSON.parse(applied?.input ?? '{}') as {
        metadata: { name: string; labels: Record<string, string> };
        spec: { instanceSelector: unknown; datasources: unknown; json: string };
      };
      expect(manifest.metadata.name).toBe('monitoring-houston-logs');
      expect(manifest.metadata.labels['app.kubernetes.io/managed-by']).toBe('houston');
      expect(manifest.spec.instanceSelector).toEqual({ matchLabels: { grafana: 'dashboards' } });
      expect(manifest.spec.datasources).toEqual([{ inputName: 'DS_LOKI', datasourceName: 'loki' }]);
      expect(JSON.parse(manifest.spec.json)).toEqual(
        expect.objectContaining({ uid: 'houston-logs' }),
      );
      expect(manifest.spec.json).toContain('k8s_container_name');
      const json = JSON.parse(manifest.spec.json) as {
        panels: { datasource: { uid: string }; targets: { datasource: { uid: string } }[] }[];
        templating: { list: { datasource?: { uid: string } }[] };
      };
      expect(json.panels[0]?.datasource.uid).toBe('${DS_LOKI}');
      expect(json.panels[0]?.targets[0]?.datasource.uid).toBe('${DS_LOKI}');
      expect(json.templating.list[0]?.datasource?.uid).toBe('${DS_LOKI}');
    }
  });
  it('refuses to overwrite a Logs dashboard owned by someone else', async () => {
    logsDashboard = { metadata: { labels: { 'app.kubernetes.io/managed-by': 'other' } } };
    await expect(ensureMonitoring({ context: 'prod' })).rejects.toThrow('not owned by houston');
    expect(calls.some((call) => call.argv.includes('apply'))).toBe(false);
  });
  it('installs with the sub-path, an explicit host, and anonymous Viewer embedding', async () => {
    await ensureMonitoring({ context: 'prod', publicUrl: 'https://first.example.test' });
    const upgrade = calls.find((call) => call.argv.includes('upgrade'))?.argv;
    expect(upgrade).toEqual(
      expect.arrayContaining([
        '--install',
        'ingress.enabled=false',
        'ingress.grafana.path=/grafana',
        'ingress.grafana.host=first.example.test',
        'ingress.tls=true',
      ]),
    );
    expect(env).toEqual(
      expect.arrayContaining([
        { name: 'GF_AUTH_ANONYMOUS_ENABLED', value: 'true' },
        { name: 'GF_AUTH_ANONYMOUS_ORG_ROLE', value: 'Viewer' },
        { name: 'GF_SECURITY_ALLOW_EMBEDDING', value: 'true' },
      ]),
    );
  });
  it('upgrades an installed stack without losing its existing values', async () => {
    installed = true;
    values = { unrelated: 'retained' };
    await ensureMonitoring({ context: 'prod' });
    expect(calls.find((call) => call.argv.includes('upgrade'))?.argv).toEqual(
      expect.arrayContaining([
        '--reuse-values',
        'ingress.grafana.path=/grafana',
        'ingress.grafana.host=localhost:5050',
      ]),
    );
    expect(values.unrelated).toBe('retained');
  });
  it('keeps the first public host canonical when another workspace attaches', async () => {
    await ensureMonitoring({ context: 'prod', publicUrl: 'https://first.example.test' });
    installed = true;
    calls.length = 0;
    await ensureMonitoring({ context: 'prod', publicUrl: 'https://second.example.test' });
    expect(calls.some((call) => call.argv.includes('upgrade'))).toBe(false);
    expect(env).toContainEqual({
      name: 'GF_SERVER_ROOT_URL',
      value: 'https://first.example.test/grafana/',
    });
  });
  it('reclaims labelled Ingress, Certificate and Secret resources before uninstalling', async () => {
    installed = true;
    resources = true;
    await removeMonitoring({ context: 'prod' });
    for (const kind of ['ingress', 'certificate', 'secret']) {
      expect(
        calls.some(
          (call) =>
            call.argv.includes('delete') &&
            call.argv.includes(kind) &&
            call.argv.includes(
              'app.kubernetes.io/managed-by=houston,houston.io/grafana-ingress=true',
            ),
        ),
      ).toBe(true);
    }
    expect(calls.some((call) => call.argv.includes('uninstall'))).toBe(true);
  });
});

it('waits for a slow cluster to answer before removing Grafana resources', async () => {
  // A teardown on EKS over a slow link: the workspace's namespace and volume were already
  // gone when the certificate question hit the 8 s probe limit, and the whole `down` failed.
  // Here every question given less than 10 s times out, the way the seam reports it.
  resources = true;
  const reply = (kube.run as jest.Mock).getMockImplementation();
  jest.spyOn(kube, 'run').mockImplementation(async (argv, options = {}) => {
    const limit = options.timeout ?? 0;
    if (argv.includes('get') && limit < 10) {
      return {
        argv,
        returncode: 127,
        stdout: '',
        stderr: `"kubectl" timed out after ${String(limit * 1000)} ms`,
      };
    }
    return await reply!(argv, options);
  });
  await expect(removeGrafanaIngress('w', { context: 'prod' })).resolves.toBeUndefined();
  expect(calls.some((call) => call.argv.includes('delete'))).toBe(true);
});

it('waits for a slow cluster to answer while attaching monitoring', async () => {
  // The attach path's must-answer questions -- the Logs dashboard, the Grafana settings and
  // its deployment -- carried the 8 s probe limit, so over a slow link to EKS attaching
  // monitoring failed the same way the teardown did. Every kubectl question given less than
  // 10 s times out here.
  const reply = (kube.run as jest.Mock).getMockImplementation();
  jest.spyOn(kube, 'run').mockImplementation(async (argv, options = {}) => {
    const limit = options.timeout ?? 0;
    if (argv[0] === 'kubectl' && argv.includes('get') && limit < 10) {
      return {
        argv,
        returncode: 127,
        stdout: '',
        stderr: `"kubectl" timed out after ${String(limit * 1000)} ms`,
      };
    }
    return await reply!(argv, options);
  });
  await expect(
    ensureMonitoring({ context: 'prod', publicUrl: 'https://first.example.test' }),
  ).resolves.toBeUndefined();
});

it('refuses Grafana cleanup when the resource query is forbidden', async () => {
  refused = true;
  await expect(removeGrafanaIngress('w', { context: 'prod' })).rejects.toThrow(DockerError);
  expect(calls.some((call) => call.argv.includes('delete'))).toBe(false);
});

it('keeps long Grafana resource names within 63 characters, including the TLS suffix', () => {
  const a = grafanaIngressName('a'.repeat(64));
  const b = grafanaIngressName(`${'a'.repeat(63)}b`);
  expect(`${a}-tls`.length).toBeLessThanOrEqual(63);
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[a-z0-9-]+$/u);
});
