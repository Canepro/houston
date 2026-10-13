import { kube } from '../../../src/core/kube/exec';
import { DockerError } from '../../../src/lib/errors';
import {
  ensureMonitoring,
  ensurePodMonitor,
  releaseSystemNamespace,
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

describe('houston-system, once nothing uses it', () => {
  function cluster(left: unknown[]): string[][] {
    const seen: string[][] = [];
    jest.spyOn(kube, 'run').mockImplementation(async (argv) => {
      seen.push([...argv]);
      const json = argv.includes('get') ? JSON.stringify({ items: left }) : '[]';
      return { argv, returncode: 0, stdout: json, stderr: '' };
    });
    return seen;
  }

  it('is removed when neither release is there and nothing is left in it', async () => {
    // helm made it for the operator and the monitoring stack, and neither removal took it:
    // after the last workspace it stayed, holding the chart's leftover webhook Secret.
    const seen = cluster([]);
    await releaseSystemNamespace('c', () => undefined);
    expect(seen.some((argv) => argv.join(' ').includes('delete namespace houston-system'))).toBe(
      true,
    );
  });

  it('does not report removal until the shared namespace deletion has completed', async () => {
    let namespaceGone = false;
    jest.spyOn(kube, 'run').mockImplementation(async (argv) => {
      if (argv.includes('delete')) {
        // The cluster accepts deletion immediately, but --wait is what keeps the
        // caller from racing the following restore's Helm Secret creation.
        namespaceGone = argv.includes('--wait=true');
      }
      return {
        argv,
        returncode: 0,
        stdout: argv.includes('get') ? '{"items":[]}' : '[]',
        stderr: '',
      };
    });
    const said: string[] = [];
    await releaseSystemNamespace('c', (event) => said.push(event.message));
    expect(namespaceGone).toBe(true);
    expect(said.join(' ')).toContain('removed the houston-system namespace');
  });

  it('reports an unfinished shared namespace deletion instead of claiming it is gone', async () => {
    jest.spyOn(kube, 'run').mockImplementation(async (argv) => ({
      argv,
      returncode: argv.includes('delete') ? 1 : 0,
      stdout: argv.includes('get') ? '{"items":[]}' : '[]',
      stderr: argv.includes('delete') ? 'error: timed out waiting for the condition' : '',
    }));
    const said: string[] = [];
    await releaseSystemNamespace('c', (event) => said.push(event.message));
    expect(said.join(' ')).toContain('could not confirm houston-system is gone');
    expect(said.join(' ')).toContain('timed out');
    expect(said.join(' ')).not.toContain('removed the houston-system namespace');
  });

  it('says nothing when it is already gone, because NotFound is the answer it wanted', async () => {
    // `down` of a workspace that never had monitoring warned "could not confirm
    // houston-system is gone: Error from server (NotFound)" about a namespace not there.
    jest.spyOn(kube, 'run').mockImplementation(async (argv) => ({
      argv,
      returncode: argv.includes('delete') ? 1 : 0,
      stdout: argv.includes('get') ? '{"items":[]}' : '[]',
      stderr: argv.includes('delete')
        ? 'Error from server (NotFound): namespaces "houston-system" not found'
        : '',
    }));
    const said: string[] = [];
    await releaseSystemNamespace('c', (event) => said.push(event.message));
    expect(said).toEqual([]);
  });

  it('is kept while a workload is left in it, such as an adopted operator', async () => {
    const seen = cluster([{ kind: 'Deployment', metadata: { name: 'their-operator' } }]);
    await releaseSystemNamespace('c', () => undefined);
    expect(seen.some((argv) => argv.includes('delete'))).toBe(false);
  });
});

describe("a workspace's PodMonitor, once the stack brings its CRD", () => {
  /** A cluster whose CRD wait answers `crdRc` and whose namespace holds `monitors`. */
  function cluster(monitors: unknown[], crdRc = 0, podMonitor = true): string[][] {
    const seen: string[][] = [];
    jest.spyOn(kube, 'run').mockImplementation(async (argv) => {
      seen.push([...argv]);
      const answer = (stdout: unknown, returncode = 0) => ({
        argv,
        returncode,
        stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
        stderr: returncode === 0 ? '' : 'Error from server (NotFound): no such CRD',
      });
      if (argv.includes('wait')) return answer('', crdRc);
      if (argv.includes('list'))
        return answer([{ name: 'rocketchat', status: 'deployed', chart: 'rocketchat-7.0.2' }]);
      if (argv.includes('values'))
        return answer(
          argv.includes('--all')
            ? { podMonitor: { enabled: podMonitor }, image: { tag: '8.5.1' } }
            : { image: { tag: '8.5.1' } },
        );
      if (argv.includes('podmonitors')) return answer({ items: monitors });
      return answer('');
    });
    return seen;
  }

  const upgrades = (seen: string[][]) =>
    seen.filter((argv) => argv[0] === 'helm' && argv.includes('upgrade'));

  it('renders the release again when it was installed before the CRD existed', async () => {
    // The first `up --monitor` installs the release, THEN the shared stack: helm rendered no
    // PodMonitor while `podMonitor.enabled=true`, Prometheus had no target, and Grafana showed
    // no Rocket.Chat data until a re-up rendered it.
    const seen = cluster([]);
    const said: string[] = [];
    await ensurePodMonitor({
      namespace: 'houston-k1',
      context: 'c',
      emit: (event) => said.push(event.message),
    });
    const wait = seen.find((argv) => argv.includes('wait')) ?? [];
    expect(wait).toEqual(
      expect.arrayContaining([
        '--for=condition=Established',
        'crd/podmonitors.monitoring.coreos.com',
        '--timeout=60s',
      ]),
    );
    // The same chart and values the release has: only what the cluster allows changes.
    expect(upgrades(seen)).toEqual([
      [
        'helm',
        'upgrade',
        'rocketchat',
        'rocketchat/rocketchat',
        '--kube-context',
        'c',
        '-n',
        'houston-k1',
        '--version',
        '7.0.2',
        '--values',
        '-',
      ],
    ]);
    expect(seen.indexOf(wait)).toBeLessThan(seen.indexOf(upgrades(seen)[0] ?? []));
    expect(said.join(' ')).toContain('rendering the Rocket.Chat release again');
  });

  it('leaves a release alone that already has one, or whose chart publishes none', async () => {
    for (const make of [
      () => cluster([{ metadata: { name: 'rocketchat' } }]),
      () => cluster([], 0, false),
    ]) {
      const seen = make();
      await ensurePodMonitor({ namespace: 'houston-k1', context: 'c' });
      expect(seen.some((argv) => argv.includes('values'))).toBe(true);
      expect(upgrades(seen)).toEqual([]);
    }
  });

  it('says so, and renders nothing, when the cluster never serves the CRD', async () => {
    const seen = cluster([], 1);
    const said: string[] = [];
    await ensurePodMonitor({
      namespace: 'houston-k1',
      context: 'c',
      emit: (event) => said.push(event.message),
    });
    expect(upgrades(seen)).toEqual([]);
    expect(said.join(' ')).toContain('Prometheus cannot find Rocket.Chat');
  });
});
