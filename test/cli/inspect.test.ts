import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as AppNS from '../../src/cli/app';
import type { CliIo } from '../../src/cli/app';
import type * as HandlersNS from '../../src/cli/handlers';
import type { KubernetesInventory } from '../../src/core/kube/inventory';
import { metadata, writeRecord } from '../../src/core/runner/record';

const knownInventory: KubernetesInventory = {
  context: 'kind-houston',
  namespace: 'houston-ticket',
  cluster_exists: true,
  nodes: [
    {
      name: 'worker-a',
      status: 'Ready',
      roles: ['worker'],
      version: 'v1.37.0',
      ready: true,
      internal_ip: '10.0.0.7',
      external_ip: '198.51.100.7',
      os_image: 'Ubuntu',
      kernel_version: '6.8.0',
      container_runtime: 'containerd://2.0.0',
      created_at: '2026-10-01T12:00:00Z',
      allocatable_cpu: '4',
      allocatable_memory: '8Gi',
    },
  ],
  services: [
    {
      name: 'rocketchat',
      type: 'NodePort',
      cluster_ip: '10.96.0.12',
      external_ips: [],
      ports: [{ name: 'web', protocol: 'TCP', port: 3000, target_port: 'http', node_port: 32000 }],
    },
  ],
  pods: [
    {
      service: 'rocketchat-0',
      state: 'running',
      status: '1/1 ready',
      health: 'healthy',
      app: true,
      blocked: false,
      restarts: 0,
      started: '2026-10-01T12:00:00Z',
    },
  ],
  warnings: [],
};

function loadKubernetesCli(inventory = knownInventory): {
  app: typeof AppNS;
  handlers: typeof HandlersNS;
} {
  jest.resetModules();
  jest.doMock('../../src/core/kube/inventory', () => ({
    ...jest.requireActual<object>('../../src/core/kube/inventory'),
    inventory: jest.fn(async () => inventory),
  }));
  return {
    app: require('../../src/cli/app') as typeof AppNS,
    handlers: require('../../src/cli/handlers') as typeof HandlersNS,
  };
}

async function runInspect(
  args: string[],
  inventory = knownInventory,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { app, handlers } = loadKubernetesCli(inventory);
  let stdout = '';
  let stderr = '';
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const io: CliIo = {
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  };
  try {
    return {
      code: await app.runCli(['inspect', '--name', 'ticket', ...args], {
        execute: handlers.createExecutor(io),
        io,
      }),
      stdout,
      stderr,
    };
  } finally {
    write.mockRestore();
  }
}

async function writeKubernetesWorkspace(): Promise<void> {
  await writeRecord(
    'ticket',
    metadata({
      name: 'ticket',
      project: 'houston-ticket',
      rcVersion: '8.6.1',
      mongoTag: '8.0',
      preset: 'default',
      rootUrl: 'http://username:root-url-secret@localhost:3000',
      publicUrl: 'https://username:public-url-secret@tickets.example.test',
      hostPort: 3000,
      versionSource: 'map',
      adminPassword: 'admin-password-secret',
      extra: {
        runtime: 'kubernetes',
        context: 'kind-houston',
        namespace: 'houston-ticket',
        env: { REG_TOKEN: 'registration-secret' },
      },
    }),
  );
}

function resourceSections(stdout: string): string[] {
  return [
    stdout.slice(stdout.indexOf('nodes'), stdout.indexOf('services')),
    stdout.slice(stdout.indexOf('services'), stdout.indexOf('pods')),
    stdout.slice(stdout.indexOf('pods'), stdout.indexOf('warnings')),
  ];
}

afterEach(() => {
  jest.dontMock('../../src/core/kube/inventory');
  jest.resetModules();
});

describe('inspect through the CLI', () => {
  it('uses the isolated test home and emits the secret-safe Kubernetes inventory envelope', async () => {
    const home = process.env.HOUSTON_HOME;
    expect(home).toBeTruthy();
    await writeKubernetesWorkspace();

    const ran = await runInspect(['--json']);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toBe('');
    const line = ran.stdout
      .split('\n')
      .filter((candidate) => candidate.trim().startsWith('{'))
      .at(-1);
    const envelope = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({
      schema: 'houston.inspect.v1',
      ok: true,
      data: {
        name: 'ticket',
        runtime: 'kubernetes',
        url: 'https://tickets.example.test',
        kubernetes: {
          context: 'kind-houston',
          namespace: 'houston-ticket',
          nodes: [{ name: 'worker-a', status: 'Ready' }],
          services: [{ name: 'rocketchat', ports: [{ target_port: 'http' }] }],
          pods: [{ service: 'rocketchat-0' }],
          warnings: [],
        },
        docker: { containers: [], networks: [], volumes: [], warnings: [] },
      },
    });
    for (const secret of [
      'admin-password-secret',
      'registration-secret',
      'root-url-secret',
      'public-url-secret',
    ]) {
      expect(ran.stdout).not.toContain(secret);
    }
    expect(fs.existsSync(path.join(String(home), 'repros', 'ticket', 'repro.json'))).toBe(true);
  });

  it('renders observed node addresses and a NodePort in the known Kubernetes inventory', async () => {
    await writeKubernetesWorkspace();

    const known = await runInspect([]);
    expect(known.code).toBe(0);
    expect(known.stdout).toContain('INTERNAL-IP=10.0.0.7');
    expect(known.stdout).toContain('EXTERNAL-IP=198.51.100.7');
    expect(known.stdout).toContain('nodePort=32000');

    const withoutInternalAddress: KubernetesInventory = {
      ...knownInventory,
      nodes: knownInventory.nodes.map((node) => ({ ...node, internal_ip: '', external_ip: '' })),
    };
    const unknown = await runInspect([], withoutInternalAddress);
    expect(unknown.code).toBe(0);
    expect(unknown.stdout).toContain('INTERNAL-IP=unknown');
    expect(unknown.stdout).not.toContain('EXTERNAL-IP=');
  });

  it('renders refused resource reads as unknown instead of none', async () => {
    await writeKubernetesWorkspace();
    const unavailable = {
      ...knownInventory,
      cluster_exists: null,
      nodes: [],
      services: [],
      pods: [],
      warnings: [
        'could not inspect Kind cluster names',
        'could not inspect cluster nodes',
        'could not inspect repro services',
        'could not inspect repro pods',
      ],
    };

    const ran = await runInspect([], unavailable);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('unknown');
    expect(ran.stdout).toContain('could not inspect cluster nodes');
    expect(ran.stdout).toContain('could not inspect repro services');
    expect(ran.stdout).toContain('could not inspect repro pods');
    for (const section of resourceSections(ran.stdout)) {
      expect(section).toContain('unknown');
      expect(section).not.toContain('none');
    }
  });

  it('renders an unrecorded bind as unknown instead of assuming loopback', async () => {
    await writeKubernetesWorkspace();

    const ran = await runInspect([]);
    expect(ran.code).toBe(0);
    const summary = ran.stdout.slice(0, ran.stdout.indexOf('cluster'));
    expect(summary).toContain('Bind');
    expect(summary).toContain('unknown');
    expect(summary).not.toContain('127.0.0.1');
  });

  it('renders a missing Kubernetes location as unknown for every unreadable resource section', async () => {
    await writeKubernetesWorkspace();
    const noLocation: KubernetesInventory = {
      ...knownInventory,
      context: '',
      namespace: '',
      cluster_exists: null,
      nodes: [],
      services: [],
      pods: [],
      warnings: ['the repro has no recorded Kubernetes context or namespace'],
    };

    const ran = await runInspect([], noLocation);
    expect(ran.code).toBe(0);
    for (const section of resourceSections(ran.stdout)) {
      expect(section).toContain('unknown');
      expect(section).not.toContain('none');
    }
  });
});
