import * as fs from 'node:fs/promises';

import * as config from '../../../src/lib/config';
import { type Emit } from '../../../src/lib/events';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import * as paths from '../../../src/core/runner/paths';

import type * as DestroyNS from '../../../src/core/lifecycle/destroy';
import type * as JournalNS from '../../../src/core/journal';

interface Seen {
  message: string;
  level: string;
  phase: string;
}

/**
 * A teardown must finish even when the record cannot be deleted.
 *
 * Earlier releases remove the record ignoring EVERY failure -- a root-owned file a
 * container left behind (EACCES), a file held open (EBUSY), anything. `fs.rm`'s
 * `force: true` forgives only ENOENT, so a rejection made the warning, the default clear
 * and the edge-route drop unreachable: the workspace's namespace is gone, its record
 * cannot be listed as removable, and its route points at nothing -- the exact condition
 * `dropTheEdgeRoute` exists to prevent.
 *
 * The unremovable directory is REAL: a workspace with a file in it, chmod 0555. Unlinking
 * the file then needs write permission on the directory, which is the shape a
 * container-written root-owned file has. Committed as `e5ab0a7`, where both functions
 * reject with EACCES and the warning never runs.
 */
describe('tearing a workspace down when its record will not go', () => {
  afterEach(async () => {
    // A test that fails mid-way leaves the 0555 directory behind, and then the test
    // runner cannot delete its own isolated home. Restore before the runner cleans up.
    for (const name of ['kub', 'cmp']) {
      await fs.chmod(paths.workspace(name), 0o700).catch(() => undefined);
    }
    jest.resetModules();
  });

  async function makeUnremovable(name: string, extra: Record<string, unknown>): Promise<string> {
    await writeRecord(name, metadata({ name, project: `houston-${name}`, extra }));
    const ws = paths.workspace(name);
    // A file inside, so removing the DIRECTORY is not enough: its entries have to be
    // unlinked, which needs write permission on the directory itself.
    await fs.chmod(ws, 0o555);
    return ws;
  }

  async function restore(ws: string): Promise<void> {
    await fs.chmod(ws, 0o700);
    await fs.rm(ws, { recursive: true, force: true });
  }

  async function load(): Promise<typeof DestroyNS> {
    jest.resetModules();
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...jest.requireActual('../../../src/core/kube/operator'),
      removeOperator: async () => false,
    }));
    jest.doMock('../../../src/core/kube/monitoring', () => ({
      ...jest.requireActual('../../../src/core/kube/monitoring'),
      removeMonitoring: async () => false,
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      namespaceFor: async (name: string) => `houston-${name}`,
      deleteNamespace: async () => true,
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach: async () => undefined,
    }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      down: async () => 0,
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister: jest.fn(),
    }));
    return require('../../../src/core/lifecycle/destroy') as typeof DestroyNS;
  }

  function collected(): { emit: Emit; seen: Seen[] } {
    const seen: Seen[] = [];
    return { seen, emit: ((event: Seen) => seen.push(event)) as never };
  }

  it('warns, keeps the record and still drops the edge route', async () => {
    const destroy = await load();
    const ws = await makeUnremovable('kub', { runtime: 'kubernetes', namespace: 'houston-kub' });
    config.updateConfig((cfg) => {
      cfg.default_repro = 'kub';
    });
    const { emit, seen } = collected();

    // The whole Kubernetes teardown, not the helper alone: the route drop is the step
    // that must stay reachable after the record refuses to go.
    await expect(destroy.teardownKubernetes('kub', true, emit)).resolves.toEqual({
      name: 'kub',
      removed: true,
      found: true,
      runtime: 'kubernetes',
    });

    expect(await paths.exists('kub')).toBe(true);
    expect(seen.some((event) => event.message.includes('could not be removed'))).toBe(true);
    expect(config.loadConfig().default_repro).toBeUndefined();
    const routes = require('../../../src/core/edge/routes') as unknown as { deregister: jest.Mock };
    expect(routes.deregister).toHaveBeenCalledWith('kub');
    await restore(ws);
  });

  it('brings a Compose teardown to a close too', async () => {
    // `teardownCompose` deletes the record through `runner.remove`, which earlier releases
    // made a removal that ignores errors. A rejection there left the default set and the
    // command failed after the containers were already down.
    const destroy = await load();
    const ws = await makeUnremovable('cmp', { runtime: 'docker', deployment: 'monolith' });
    config.updateConfig((cfg) => {
      cfg.default_repro = 'cmp';
    });
    const { emit } = collected();

    await expect(destroy.teardownCompose('cmp', true)).resolves.toBeUndefined();
    expect(config.loadConfig().default_repro).toBeUndefined();
    await restore(ws);
    void emit;
  });
});

describe('tearing down a Kubernetes workspace that has the monitoring stack', () => {
  afterEach(() => {
    for (const id of [
      '../../../src/core/kube/operator',
      '../../../src/core/kube/monitoring',
      '../../../src/core/kube/namespace',
      '../../../src/core/lifecycle/ready',
    ]) {
      jest.dontMock(id);
    }
    jest.dontMock('../../../src/core/edge/routes');
    jest.resetModules();
  });

  function load() {
    jest.resetModules();
    const called: Record<string, { excluding?: string }> = {};
    const stopped: number[] = [];
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...jest.requireActual('../../../src/core/kube/operator'),
      removeOperator: async (opts: { excluding?: string }) => {
        called.operator = opts;
        return true;
      },
    }));
    jest.doMock('../../../src/core/kube/monitoring', () => ({
      ...jest.requireActual('../../../src/core/kube/monitoring'),
      removeMonitoring: async (opts: { excluding?: string }) => {
        called.monitoring = opts;
        return true;
      },
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      namespaceFor: async () => 'houston-mon',
      deleteNamespace: async () => true,
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      stopPortForward: (pid: number) => {
        stopped.push(pid);
      },
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister: jest.fn(),
    }));
    return {
      called,
      stopped,
      destroy: require('../../../src/core/lifecycle/destroy') as typeof DestroyNS,
    };
  }

  const extra = {
    runtime: 'kubernetes',
    namespace: 'houston-mon',
    context: 'default',
    monitoring: true,
    grafana_pid: 4242,
  };

  it('takes the stack and the Grafana forward with it on --volumes, and neither on a plain down', async () => {
    // Reported from a live k3s box: after `down --volumes` the monitoring stack was still
    // running -- ten pods and ~840 MB wanted by nobody -- and the Grafana forward went on
    // holding :5050, so the next `up --monitor` was refused for a port held by a corpse.
    const { called, stopped, destroy } = load();
    await writeRecord('mon', metadata({ name: 'mon', project: 'p', extra }));
    await destroy.teardownKubernetes('mon', true, () => undefined);
    expect(stopped).toContain(4242);
    // The namespace being destroyed must not count as still wanting it: a namespace still
    // Terminating is still listed and still labelled.
    expect(called.monitoring?.excluding).toBe('houston-mon');
    expect(called.operator?.excluding).toBe('houston-mon');

    // A plain `down` keeps the namespace and the data, so the workspace can come back and
    // the stack it wants must stay with it.
    for (const key of Object.keys(called)) delete called[key];
    stopped.length = 0;
    await writeRecord('mon', metadata({ name: 'mon', project: 'p', extra }));
    await destroy.teardownKubernetes('mon', false, () => undefined);
    expect(called).toEqual({});
    expect(stopped).not.toContain(4242);
  });
});

describe('the repair notes of a workspace that is torn down', () => {
  afterEach(() => {
    for (const id of [
      '../../../src/core/lifecycle/ownership',
      '../../../src/core/lifecycle/preconditions',
      '../../../src/core/audit',
      '../../../src/core/edge/networks',
      '../../../src/core/edge/routes',
      '../../../src/core/runner/engine',
      '../../../src/core/kube/namespace',
      '../../../src/core/kube/operator',
      '../../../src/core/kube/monitoring',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  function load() {
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ownership', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ownership'),
      mayDestroy: async () => [true, ''],
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      requireEngine: async () => undefined,
    }));
    jest.doMock('../../../src/core/audit', () => ({
      ...jest.requireActual('../../../src/core/audit'),
      record: () => undefined,
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach: async () => undefined,
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister: () => undefined,
    }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      down: async () => 0,
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      deleteNamespace: async () => true,
    }));
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...jest.requireActual('../../../src/core/kube/operator'),
      removeOperator: async () => false,
    }));
    jest.doMock('../../../src/core/kube/monitoring', () => ({
      ...jest.requireActual('../../../src/core/kube/monitoring'),
      removeMonitoring: async () => true,
    }));
    return {
      destroy: require('../../../src/core/lifecycle/destroy') as typeof DestroyNS,
      journal: require('../../../src/core/journal') as typeof JournalNS,
    };
  }

  it('takes them on --volumes, keeps them on a plain down, and leaves every other subject alone', async () => {
    // Seen on the owner's box: 28 `create_unfinished` notes for `alice-rc8-5-1`, all still
    // there after `down --volumes` had removed its containers, its volume and its record, so
    // `doctor` went on advising `houston ready` on a workspace that was gone. Both runtimes,
    // because they delete the record in different places. A cluster note under the same
    // name is about a CLOUD CLUSTER, and another workspace's notes are not this one's.
    const { destroy, journal } = load();
    await fs.rm(journal.journalDir(), { recursive: true, force: true });
    const notes = (name?: string): string[] =>
      journal
        .openEntries()
        .filter((e) => name === undefined || e.workspace === name)
        .map((e) => `${e.kind}:${e.workspace}`)
        .sort();

    journal.record(journal.CREATE_UNFINISHED, 'bystander');
    const runtimes: Record<string, Record<string, unknown>> = {
      'notes-cmp': { runtime: 'docker' },
      'notes-kub': { runtime: 'kubernetes', namespace: 'houston-notes-kub', context: 'default' },
    };
    for (const [name, extra] of Object.entries(runtimes)) {
      await writeRecord(name, metadata({ name, project: `houston-${name}`, extra }));
      for (const kind of [
        journal.CREATE_UNFINISHED,
        journal.CREATE_UNFINISHED,
        journal.RATE_LIMITER_OFF,
        journal.CLUSTER_UNFINISHED,
      ]) {
        journal.record(kind, name);
      }

      await destroy.teardown(name, { volumes: false });
      expect(await paths.exists(name)).toBe(true);
      expect(notes(name)).toHaveLength(4);

      await destroy.teardown(name, { volumes: true, confirm: true });
      expect(await paths.exists(name)).toBe(false);
      expect(notes(name)).toEqual([`cluster_unfinished:${name}`]);
    }

    expect(notes()).toEqual([
      'cluster_unfinished:notes-cmp',
      'cluster_unfinished:notes-kub',
      'create_unfinished:bystander',
    ]);
  });
});
