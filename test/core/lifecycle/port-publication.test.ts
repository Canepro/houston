import * as fs from 'node:fs/promises';

import * as config from '../../../src/lib/config';
import { currentContext, runWithContext } from '../../../src/lib/context';
import { ConflictError } from '../../../src/lib/errors';
import { nullEmit } from '../../../src/lib/events';
import { openEntries } from '../../../src/core/journal';
import { createRepro } from '../../../src/core/lifecycle/create-docker';
import { PORT_LOCK } from '../../../src/core/lifecycle/ports';
import * as ready from '../../../src/core/lifecycle/ready';
import { createReq, type CreateReq } from '../../../src/core/lifecycle/types';
import * as host from '../../../src/core/runner/host';
import { heldBy } from '../../../src/core/runner/locks';
import * as paths from '../../../src/core/runner/paths';
import * as portProbe from '../../../src/core/runner/ports';
import * as record from '../../../src/core/runner/record';
import type * as PolicyNS from '../../testsetup-policy';

jest.mock('../../../src/core/runner/host', () => {
  const healthy = (require('../../testsetup-policy') as typeof PolicyNS).healthyHost();
  return {
    ...healthy,
    engine: jest.fn(healthy.engine),
    dockerKernelVersion: jest.fn(async () => '6.1.0'),
  };
});
jest.mock('../../../src/core/runner/queries', () => ({
  ...jest.requireActual('../../../src/core/runner/queries'),
  projectConfigFiles: jest.fn(async () => ({})),
}));
jest.mock('../../../src/core/lifecycle/sizing', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/sizing'),
  checkCapacity: jest.fn(async () => undefined),
}));
jest.mock('../../../src/core/lifecycle/ready', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/ready'),
  upCompose: jest.fn(async () => 0),
  waitAndFinalize: jest.fn(async () => ({})),
}));

// Locks, port selection, records and generated documents are real. Docker's
// deployment and host queries are the external boundary; they publish no sockets.
describe('a create publishes its complete port allocation before releasing the lock', () => {
  const deployed: string[] = [];
  const deploymentLocks: boolean[] = [];
  const deploymentRecords: record.Metadata[] = [];
  const healthy = (require('../../testsetup-policy') as typeof PolicyNS).healthyHost();

  beforeEach(async () => {
    await fs.rm(config.reprosDir(), { recursive: true, force: true });
    deployed.length = 0;
    deploymentLocks.length = 0;
    deploymentRecords.length = 0;
    jest.mocked(host.engine).mockReset().mockImplementation(healthy.engine);
    jest
      .mocked(ready.upCompose)
      .mockReset()
      .mockImplementation(async (name) => {
        deployed.push(name);
        deploymentLocks.push(heldBy(PORT_LOCK));
        deploymentRecords.push(await record.readMeta(name));
        return 0;
      });
  });

  afterEach(async () => {
    await fs.rm(config.reprosDir(), { recursive: true, force: true });
  });

  async function create(
    name: string,
    values: Partial<CreateReq> = {},
  ): Promise<Record<string, unknown>> {
    return await runWithContext(
      { workspace: name },
      async () =>
        await createRepro(
          createReq({ version: '8.5.1', runtime: 'docker', name, offline: true, ...values }),
          nullEmit,
        ),
    );
  }

  async function availableBlock(count = 1): Promise<number> {
    for (let base = 3300; base + count - 1 < 3990; base += 1) {
      let free = true;
      for (let offset = 0; offset < count; offset += 1) {
        if (!(await portProbe.portFree(base + offset))) {
          free = false;
          break;
        }
      }
      if (free) return base;
    }
    throw new Error('the test needs a free host-port block in 3300-3989');
  }

  function rendezvousAfterSelection(): Set<string> {
    const selected = new Set<string>();
    let release!: () => void;
    const secondQuery = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.mocked(host.engine).mockImplementation(async () => {
      const name = currentContext().workspace;
      if (!selected.has(name)) {
        selected.add(name);
        if (selected.size === 2) release();
        else {
          // A real host query can be slow after a port has been selected. The
          // baseline releases _ports before this query, so both creates reach
          // this rendezvous with the same unrecorded allocation. The fix keeps
          // the second outside it until the first record is visible. The bound
          // releases that first query without requiring the forbidden overlap.
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              secondQuery,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1000);
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
      }
      return await healthy.engine();
    });
    return selected;
  }

  function onlyOneCreated(outcomes: PromiseSettledResult<Record<string, unknown>>[]): void {
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(refused?.status).toBe('rejected');
    if (refused?.status === 'rejected') {
      expect(refused.reason).toBeInstanceOf(ConflictError);
      expect((refused.reason as ConflictError).exitCode).toBe(8);
    }
    expect(deployed).toHaveLength(1);
    expect(deploymentRecords).toHaveLength(1);
    expect(deploymentLocks).toEqual([false]);
  }

  async function holder(
    name: string,
    hostPort: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await record.writeRecord(
      name,
      record.metadata({ name, project: `houston-${name}`, hostPort, extra }),
    );
  }

  it('refuses a concurrent explicit RC collision before deploying or publishing the second workspace', async () => {
    const port = await availableBlock();
    const selected = rendezvousAfterSelection();
    const outcomes = await Promise.allSettled([
      create('rc-first', { port }),
      create('rc-second', { port }),
    ]);
    onlyOneCreated(outcomes);
    expect(selected.size).toBe(1);
    const metas = await record.listMeta();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.hostPort).toBe(port);
  });

  it('allocates disjoint complete automatic multi-instance blocks to concurrent creates', async () => {
    rendezvousAfterSelection();
    const outcomes = await Promise.allSettled([
      create('auto-first', { deployment: 'multi-instance', replicas: 2 }),
      create('auto-second', { deployment: 'multi-instance', replicas: 2 }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const first = await record.readMeta('auto-first');
    const second = await record.readMeta('auto-second');
    expect(first.extra.instances).toBe(2);
    expect(second.extra.instances).toBe(2);
    const firstBlock = new Set([first.hostPort, first.hostPort + 1, first.hostPort + 2]);
    expect(
      [second.hostPort, second.hostPort + 1, second.hostPort + 2].some((port) =>
        firstBlock.has(port),
      ),
    ).toBe(false);
    expect(deploymentRecords).toHaveLength(2);
    expect(deploymentLocks).toEqual([false, false]);
  });

  it('refuses concurrent presets sharing a fixed side port before the second deployment', async () => {
    const port = await availableBlock(2);
    rendezvousAfterSelection();
    const outcomes = await Promise.allSettled([
      create('mail-first', { preset: 'email', port }),
      create('mail-second', { preset: 'email', port: port + 1 }),
    ]);
    onlyOneCreated(outcomes);
    expect(await record.listMeta()).toHaveLength(1);
    expect(deploymentRecords[0]?.extra.sidecar_ports).toContain(8025);
  });

  it('refuses an overlapping explicit instance block before the second deployment', async () => {
    const port = await availableBlock(4);
    rendezvousAfterSelection();
    const outcomes = await Promise.allSettled([
      create('block-first', { port, deployment: 'multi-instance', replicas: 2 }),
      create('block-second', { port: port + 1, deployment: 'multi-instance', replicas: 2 }),
    ]);
    onlyOneCreated(outcomes);
    expect(await record.listMeta()).toHaveLength(1);
    expect(deploymentRecords[0]?.extra.instances).toBe(2);
  });

  it('releases an unpublished allocation after a planning failure without leaving a record or claim', async () => {
    const port = await availableBlock();
    jest
      .mocked(host.engine)
      .mockRejectedValueOnce(new Error('host query failed before publication'));
    await expect(create('unpublished', { port })).rejects.toThrow(
      'host query failed before publication',
    );
    expect(await paths.exists('unpublished')).toBe(false);
    expect(await record.listMeta()).toEqual([]);
    expect(await portProbe.usedPorts()).toEqual(new Set());
    expect(openEntries()).toEqual([]);
    expect(deployed).toEqual([]);
    await expect(create('after-failure', { port })).resolves.toMatchObject({ host_port: port });
    expect(deployed).toEqual(['after-failure']);
  });

  it('lets independent runtime deployments proceed together after both records have been published', async () => {
    const port = await availableBlock(2);
    let release!: () => void;
    const bothDeploying = new Promise<void>((resolve) => {
      release = resolve;
    });
    let timer: NodeJS.Timeout | undefined;
    let overlapped = false;
    jest.mocked(ready.upCompose).mockImplementation(async (name) => {
      deployed.push(name);
      deploymentLocks.push(heldBy(PORT_LOCK));
      deploymentRecords.push(await record.readMeta(name));
      if (deployed.length === 2) {
        overlapped = true;
        release();
      } else
        await Promise.race([
          bothDeploying,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
      return 0;
    });
    try {
      await expect(
        Promise.all([
          create('deploy-first', { port }),
          create('deploy-second', { port: port + 1 }),
        ]),
      ).resolves.toHaveLength(2);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    expect(overlapped).toBe(true);
    expect(deploymentRecords).toHaveLength(2);
    expect(deploymentLocks).toEqual([false, false]);
  });

  it('recognizes RC, instance, monitoring and TLS claims when a preset needs a fixed side port', async () => {
    const port = await availableBlock(2);
    for (const [kind, main, extra] of [
      ['rc', 8025, {}],
      ['instance', 8024, { instances: 2 }],
      ['monitor', port, { monitoring_ports: [8025] }],
      ['tls', port, { tls_ports: [8025] }],
    ] as const) {
      await fs.rm(config.reprosDir(), { recursive: true, force: true });
      await holder(`side-holder-${kind}`, main, extra);
      await expect(
        create(`side-conflict-${kind}`, { port: port + 1, preset: 'email' }),
      ).rejects.toThrow(/8025.*already claimed.*side-holder/u);
      expect(await paths.exists(`side-conflict-${kind}`)).toBe(false);
      expect(deployed).toEqual([]);
    }
  });

  it('recognizes every recorded allocation category when monitoring needs its fixed ports', async () => {
    const port = await availableBlock(2);
    for (const [kind, main, extra] of [
      ['rc', 9090, {}],
      ['instance', 9089, { instances: 2 }],
      ['side', port, { sidecar_ports: [9090] }],
      ['tls', port, { tls_ports: [9090] }],
      ['monitor', port, { monitoring_ports: [9090] }],
    ] as const) {
      await fs.rm(config.reprosDir(), { recursive: true, force: true });
      await holder(`monitor-holder-${kind}`, main, extra);
      const remedy =
        kind === 'monitor'
          ? `(its monitoring) - stop it first: houston monitor --name monitor-holder-${kind} --off`
          : `- delete it first: houston down --name monitor-holder-${kind} --volumes`;
      await expect(
        create(`monitor-conflict-${kind}`, { port: port + 1, monitor: true }),
      ).rejects.toThrow(
        `monitoring needs port(s) [9090], already used by repro 'monitor-holder-${kind}' ${remedy}`,
      );
      expect(await paths.exists(`monitor-conflict-${kind}`)).toBe(false);
      expect(deployed).toEqual([]);
    }
  });

  it('refuses the main RC port on its own preset side port before any record or deployment', async () => {
    await expect(create('self-mail', { preset: 'email', port: 8025 })).rejects.toThrow(
      "--port 8025 is also a port this workspace's presets or monitoring publish",
    );
    expect(await record.listMeta()).toEqual([]);
    expect(deployed).toEqual([]);
  });

  it('refuses the main RC port on its own monitoring port before any record or deployment', async () => {
    await expect(create('self-monitor', { monitor: true, port: 9090 })).rejects.toThrow(
      "--port 9090 is also a port this workspace's presets or monitoring publish",
    );
    expect(await record.listMeta()).toEqual([]);
    expect(deployed).toEqual([]);
  });

  it("automatic allocation avoids the same workspace's fixed side port", async () => {
    // One real record covers [3000, 8024]; no real sockets or containers are
    // reserved. Mailpit's 8025 is the next numerical gap, but RC must skip it.
    await holder('recorded-range', 3000, { instances: 5024 });
    await expect(create('auto-mail', { preset: 'email' })).resolves.toHaveProperty('host_port');
    const created = await record.readMeta('auto-mail');
    expect(created.hostPort).toBeGreaterThan(8025);
    expect(created.extra.sidecar_ports).toContain(8025);
    expect(deployed).toEqual(['auto-mail']);
  });
});
