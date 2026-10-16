import type * as KubeExecNS from '../../../src/core/kube/exec';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import type { Event } from '../../../src/lib/events';
import { grant, revoke } from '../../../src/lib/onboarding';
import type { KubectlResult } from '../../../src/core/kube/exec';

import type * as PruningNS from '../../../src/core/lifecycle/pruning';
import type * as JournalNS from '../../../src/core/journal';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as ErrorsNS from '../../../src/lib/errors';

it('Grafana public URL regression: pruning a TLS workspace removes its shared-namespace resources', async () => {
  jest.resetModules();
  const removedIngress = jest.fn(async () => undefined);
  jest.doMock('../../../src/core/kube/monitoring', () => ({
    ...jest.requireActual<object>('../../../src/core/kube/monitoring'),
    removeGrafanaIngress: removedIngress,
    removeMonitoring: async () => false,
  }));
  jest.doMock('../../../src/core/kube/namespace', () => ({
    ...jest.requireActual<object>('../../../src/core/kube/namespace'),
    deleteNamespace: async () => true,
  }));
  const record = require('../../../src/core/runner/record') as typeof RecordNS;
  await record.writeRecord(
    'w',
    record.metadata({ name: 'w', extra: { runtime: 'kubernetes', context: 'prod', tls: 'local' } }),
  );
  const pruning = require('../../../src/core/lifecycle/pruning') as typeof PruningNS;
  try {
    const removed: string[] = [];
    await pruning.pruneKubernetes('w', () => undefined, removed);
    expect(removed).toEqual(['w']);
    expect(removedIngress).toHaveBeenCalledWith('w', expect.objectContaining({ context: 'prod' }));
  } finally {
    jest.dontMock('../../../src/core/kube/monitoring');
    jest.dontMock('../../../src/core/kube/namespace');
    jest.resetModules();
  }
});

interface Seen {
  message: string;
  level: string;
  phase: string;
}

/**
 * The one thing that separates "this workspace was pruned" from "this workspace was left
 * alone": whether the caller reports it.
 *
 * Earlier releases leave the FUNCTION on four paths and report a prune on one. An earlier version returned from the `reproLock` CALLBACK, so every
 * path that did not throw fell through to `clearDefaultIf` / `removed.push` / `pruned` --
 * one line after warning the operator that the namespace is not confirmed gone and the
 * record is being KEPT. The CLI and the GUI both render `removed`, so a workspace still
 * holding a PersistentVolumeClaim was reported gone while the warning said otherwise.
 *
 * It is held to what earlier releases reported, stubbed to the same five behaviours and
 * recorded, so the exact `{removed, events}` pair is compared rather than a paraphrase of it.
 */
const MODES = ['ns-none', 'ns-ok', 'down-fail', 'down-ok', 'unreachable'] as const;
type Mode = (typeof MODES)[number];

describe('removing one workspace', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/kube/cluster');
    jest.resetModules();
  });

  async function writeFixture(name: string, runtime: string): Promise<void> {
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord(
      name,
      record.metadata({
        name,
        project: `houston-${name}`,
        extra:
          runtime === 'kubernetes'
            ? { runtime, context: 'kind-houston-local' }
            : { runtime, deployment: 'monolith' },
      }),
    );
  }

  async function load(mode: Mode): Promise<typeof PruningNS> {
    jest.resetModules();
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster');
    });
    jest.doMock('../../../src/core/kube/cluster', () => ({
      ...jest.requireActual('../../../src/core/kube/cluster'),
      adoptIfUnmarked: async () => undefined,
    }));
    const errors = require('../../../src/lib/errors') as typeof ErrorsNS;
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      stop: async () => 0,
      down: async () => (mode === 'down-fail' ? 1 : 0),
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach: async () => undefined,
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      namespaceFor: async (name: string) => `houston-${name}`,
      deleteNamespace: async () => {
        if (mode === 'unreachable') {
          throw new errors.DockerError('could not ask cluster');
        }
        return mode === 'ns-ok';
      },
    }));
    return require('../../../src/core/lifecycle/pruning') as typeof PruningNS;
  }

  async function typescriptRun(mode: Mode): Promise<{ removed: string[]; events: Seen[] }> {
    const name = mode === 'down-fail' || mode === 'down-ok' ? 'cmp' : 'kub';
    const runtime = name === 'cmp' ? 'docker' : 'kubernetes';
    await writeFixture(name, runtime);
    const pruning = await load(mode);
    const removed: string[] = [];
    const events: Seen[] = [];
    await pruning.removeOneWorkspace(name, ((event: Seen) => events.push(event)) as never, removed);
    return { removed, events };
  }

  /** What earlier releases reported for each of the same five behaviours, recorded. */
  const RECORDED: Record<Mode, { removed: string[]; events: unknown[] }> = {
    'ns-none': {
      removed: [],
      events: [
        {
          message:
            "'kub' was NOT pruned: its namespace is not confirmed gone, so the record is kept. `kubectl get ns houston-kub`, then prune again.",
          level: 'warn',
          phase: 'done',
          code: 'WARNING',
          data: {},
          pct: null,
          terminal: false,
        },
      ],
    },
    'ns-ok': {
      removed: ['kub'],
      events: [
        {
          message: "pruned 'kub'",
          level: 'info',
          phase: 'done',
          code: '',
          data: {},
          pct: null,
          terminal: false,
        },
      ],
    },
    'down-fail': {
      removed: [],
      events: [
        {
          message: "could not clean up 'cmp' - skipping",
          level: 'warn',
          phase: 'done',
          code: 'WARNING',
          data: {},
          pct: null,
          terminal: false,
        },
      ],
    },
    'down-ok': {
      removed: ['cmp'],
      events: [
        {
          message: "pruned 'cmp'",
          level: 'info',
          phase: 'done',
          code: '',
          data: {},
          pct: null,
          terminal: false,
        },
      ],
    },
    unreachable: {
      removed: [],
      events: [
        {
          message: "'kub' could not be removed (could not ask cluster) - skipping",
          level: 'warn',
          phase: 'done',
          code: 'WARNING',
          data: {},
          pct: null,
          terminal: false,
        },
      ],
    },
  };

  it.each(MODES)('reports exactly what earlier releases report for %s', async (mode) => {
    const ours = await typescriptRun(mode);
    const recorded = RECORDED[mode];
    expect({ removed: ours.removed, events: ours.events }).toEqual(recorded);
  });

  it('leaves the record and the default alone when the prune did not happen', async () => {
    // The contract in one assertion for each of the three early returns: nothing is
    // pushed and nothing says "pruned". `removed` is what the CLI and the GUI render.
    for (const mode of ['ns-none', 'down-fail', 'unreachable'] as const) {
      const { removed, events } = await typescriptRun(mode);
      expect(removed).toEqual([]);
      // `startsWith`, not `includes`: the "was NOT pruned" warning is the line that must
      // be there, and it also contains the word.
      expect(events.some((event) => event.message.startsWith('pruned'))).toBe(false);
    }
  });
});

describe('a whole prune', () => {
  // A HOME PER CASE: the cases above leave records behind, and every case here starts from
  // `listMeta`, so one file-wide home would make each depend on the order they ran in.
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-prune-'));
    process.env.HOUSTON_HOME = home;
  });
  afterEach(() => {
    for (const id of [
      '../../../src/core/audit',
      '../../../src/core/kube/capabilities',
      '../../../src/core/kube/cluster',
      '../../../src/core/kube/context',
      '../../../src/core/kube/exec',
      '../../../src/core/kube/namespace',
      '../../../src/core/kube/status',
      '../../../src/core/runner/engine',
      '../../../src/core/runner/queries',
      '../../../src/core/edge/networks',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
    process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  interface World {
    namespaces?: string[];
    realAdoption?: boolean;
    namespaceDeleted?: () => void;
    context?: string;
    owners?: Record<string, string | null>;
    deleteCluster?: () => Promise<boolean>;
    reclaimError?: () => Error;
    reclaimable?: boolean | (() => boolean);
    down?: (name: string) => Promise<number>;
    running?: Record<string, string>;
    /** Whether a Kubernetes workspace's workload answers: true is "not down". */
    workload?: boolean;
  }

  /** The seams `prune` reaches, stated; everything else is the real module. */
  function load(world: World = {}) {
    jest.resetModules();
    const audited: [string, string][] = [];
    const deleted: string[] = [];
    const waited: string[] = [];
    const reclaimed: unknown[] = [];
    jest.doMock('../../../src/core/audit', () => ({
      ...jest.requireActual('../../../src/core/audit'),
      actor: () => 'me',
      record: (action: string, subject = '') => {
        audited.push([action, subject]);
      },
    }));
    jest.doMock('../../../src/core/kube/context', () => ({
      ...jest.requireActual('../../../src/core/kube/context'),
      planCluster: async () => ({
        context: world.context ?? 'kind-houston-local',
        distribution: 'kind',
        create: false,
      }),
    }));
    jest.doMock('../../../src/core/kube/capabilities', () => ({
      ...jest.requireActual('../../../src/core/kube/capabilities'),
      workspaceNamespaces: async () => world.namespaces ?? [],
    }));
    jest.doMock('../../../src/core/kube/cluster', () => ({
      ...jest.requireActual('../../../src/core/kube/cluster'),
      ...(world.realAdoption ? {} : { adoptIfUnmarked: async () => undefined }),
      clusterReclaimable: async () => {
        if (world.reclaimError !== undefined) throw world.reclaimError();
        return typeof world.reclaimable === 'function'
          ? world.reclaimable()
          : (world.reclaimable ?? false);
      },
      deleteCluster: async (options: unknown) => {
        reclaimed.push(options);
        return world.deleteCluster === undefined ? false : await world.deleteCluster();
      },
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../../src/core/kube/namespace'),
      // `null` is "could not read the label" and must survive the stub as itself.
      namespaceOwner: async (ns: string) =>
        world.owners !== undefined && Object.hasOwn(world.owners, ns) ? world.owners[ns] : '',
      waitNamespaceGone: async (_ns: string, { context }: { context: string }) => {
        waited.push(context);
        return true;
      },
      // Reached only by a Kubernetes workspace that is prunable, which `workload` decides.
      deleteNamespace: async () => {
        world.namespaceDeleted?.();
        return true;
      },
    }));
    jest.doMock('../../../src/core/kube/exec', () => {
      const actual = jest.requireActual('../../../src/core/kube/exec');
      return {
        ...actual,
        kube: {
          run: async (argv: string[]): Promise<KubectlResult> => {
            if (argv.includes('delete') && argv.includes('namespace')) {
              deleted.push(argv[argv.indexOf('namespace') + 1] as string);
              world.namespaceDeleted?.();
            }
            return { returncode: 0, stdout: '', stderr: '' } as KubectlResult;
          },
        },
      };
    });
    jest.doMock('../../../src/core/kube/status', () => ({
      ...jest.requireActual('../../../src/core/kube/status'),
      workloadExists: async () => world.workload ?? true,
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      projectStates: async () => world.running ?? {},
    }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      stop: async () => 0,
      down: async (name: string) => (world.down === undefined ? 0 : await world.down(name)),
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach: async () => undefined,
    }));
    const pruning = require('../../../src/core/lifecycle/pruning') as typeof PruningNS;
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const errors = require('../../../src/lib/errors') as typeof ErrorsNS;
    return { pruning, record, errors, audited, deleted, waited, reclaimed };
  }

  async function composeRecords(record: typeof RecordNS, ...names: string[]): Promise<void> {
    for (const name of names) {
      await record.writeRecord(
        name,
        record.metadata({ name, project: `houston-${name}`, extra: { runtime: 'docker' } }),
      );
    }
  }

  it('prunes a marked local workspace through the real adoption helper without Kind', async () => {
    const world = load({ realAdoption: true, workload: false });
    const { kube, ownedKubeconfig } = require('../../../src/core/kube/exec') as typeof KubeExecNS;
    fs.mkdirSync(path.dirname(ownedKubeconfig()), { recursive: true });
    fs.writeFileSync(ownedKubeconfig(), 'synthetic client');
    const run = jest.spyOn(kube, 'run').mockImplementation(async (argv) => ({
      argv,
      returncode: argv[0] === 'kind' ? 1 : 0,
      stdout: argv.includes('configmap')
        ? JSON.stringify({
            metadata: { labels: { 'app.kubernetes.io/managed-by': 'houston' } },
            data: { cluster: 'houston-local' },
          })
        : '',
      stderr: argv[0] === 'kind' ? 'kind missing' : '',
    }));
    config.updateConfig((stored) => grant(stored, 'owned-cluster'));
    await world.record.writeRecord(
      'marked',
      world.record.metadata({
        name: 'marked',
        extra: { runtime: 'kubernetes', context: 'kind-houston-local' },
      }),
    );
    const out = await world.pruning.prune({ confirm: true, orphans: false, only: ['marked'] });
    expect(out.removed).toEqual(['marked']);
    expect(run.mock.calls.some(([argv]) => argv[0] === 'kind')).toBe(false);
  });

  it('gives back the cluster it created once nothing is left in it', async () => {
    // Measured live: with every workspace gone, `prune` said "Nothing to prune" and left
    // houston's own kind control plane running -- 514 MiB holding nothing -- while the
    // README and the agent skill both said it reclaims it.
    const world = load({ reclaimable: true, deleteCluster: async () => true });
    await expect(world.pruning.prune({ confirm: true })).rejects.toMatchObject({
      code: 'GATE_NOT_ONBOARDED',
    });
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    expect((await world.pruning.prune({ confirm: true })).cluster).toBe(true);
    expect(world.reclaimed).toHaveLength(1);
    // And the same offer applies on the other early path.
    world.reclaimed.length = 0;
    expect((await world.pruning.prune({ confirm: true, orphans: false })).cluster).toBe(true);
    expect(world.reclaimed).toHaveLength(1);
  });

  it('does not gate a compose prune for an existing local cluster that is not reclaimable', async () => {
    // `deleteCluster` requires the grant whenever the fixed local cluster exists, even when
    // it is occupied or otherwise not reclaimable. Plan that fact before deleting unrelated
    // Compose work, so a later best-effort cleanup cannot turn a successful prune into a gate.
    let gate: Error | null = null;
    const world = load({
      reclaimable: false,
      deleteCluster: async () => {
        throw gate ?? new Error('missing test gate');
      },
    });
    gate = new world.errors.AuthorityGateError('the local cluster is not authorised', {
      code: 'GATE_OWNED_CLUSTER',
    });
    await composeRecords(world.record, 'compose');

    const out = await world.pruning.prune({ confirm: true, only: ['compose'] });

    expect(out.removed).toEqual(['compose']);
    expect(out.cluster).toBe(false);
    expect(world.audited).toEqual([['prune', 'compose']]);
    expect(world.reclaimed).toEqual([]);
  });

  it('leaves an unreadable cluster alone while pruning a compose target', async () => {
    // A failed marker read is not a reason to abandon a separate selected workspace. It is
    // still not authority to call `deleteCluster`, so it is reported as the existing
    // best-effort cleanup warning after the unrelated removal completes.
    let errors: typeof ErrorsNS | null = null;
    const world = load({
      reclaimError: () =>
        new (errors as typeof ErrorsNS).DockerError('cluster ownership marker could not be read'),
    });
    errors = world.errors;
    await composeRecords(world.record, 'compose');
    const events: Event[] = [];

    const out = await world.pruning.prune({
      confirm: true,
      only: ['compose'],
      emit: (event) => events.push(event),
    });

    expect(out.removed).toEqual(['compose']);
    expect(out.cluster).toBe(false);
    expect(world.reclaimed).toEqual([]);
    expect(events.some((event) => event.message.includes('the cluster was left alone'))).toBe(true);
  });

  it('stops a confirmed reclaim before auditing or removing a compose target without the grant', async () => {
    const world = load({ reclaimable: true, deleteCluster: async () => true });
    await composeRecords(world.record, 'compose');

    await expect(world.pruning.prune({ confirm: true, only: ['compose'] })).rejects.toMatchObject({
      code: 'GATE_NOT_ONBOARDED',
    });

    expect(world.audited).toEqual([]);
    expect(world.reclaimed).toEqual([]);
  });

  it('reclaims a confirmed empty cluster after a selected compose cleanup with the grant', async () => {
    const world = load({ reclaimable: true, deleteCluster: async () => true });
    await composeRecords(world.record, 'compose');
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });

    const out = await world.pruning.prune({ confirm: true, only: ['compose'] });

    expect(out.removed).toEqual(['compose']);
    expect(out.cluster).toBe(true);
    expect(world.reclaimed).toHaveLength(1);
  });

  it.each(['workspace', 'orphan'])(
    'rechecks reclamation after the last local %s is removed',
    async (kind) => {
      const state = { empty: false };
      const world = load({
        namespaces: kind === 'orphan' ? ['houston-last'] : [],
        owners: { 'houston-last': 'me' },
        workload: false,
        reclaimable: () => state.empty,
        deleteCluster: async () => true,
        namespaceDeleted: () => {
          state.empty = true;
        },
      });
      config.updateConfig((stored) => {
        grant(stored, 'owned-cluster');
      });
      if (kind === 'workspace') {
        await world.record.writeRecord(
          'last',
          world.record.metadata({
            name: 'last',
            extra: { runtime: 'kubernetes', context: 'kind-houston-local' },
          }),
        );
      }
      const out = await world.pruning.prune({
        confirm: true,
        orphans: kind === 'orphan',
        only: kind === 'workspace' ? ['last'] : [],
      });
      expect(out.cluster).toBe(true);
      expect(world.reclaimed).toHaveLength(1);
      expect(kind === 'workspace' ? out.removed : out.orphans).toEqual(
        kind === 'workspace' ? ['last'] : ['houston-last'],
      );
    },
  );

  it('audits the namespaces it swept, not only the records', async () => {
    // The subject was the local records alone, so a sweep of namespaces and no records
    // wrote `prune` with an empty subject -- no trace anywhere of what was destroyed.
    const world = load({ namespaces: ['houston-ghost'] });
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    await world.pruning.prune({ confirm: true, orphans: true });
    expect(world.audited[0]?.[0]).toBe('prune');
    expect(world.audited[0]?.[1]).toContain('houston-ghost');
  });

  it('gates a local orphan sweep before it records or deletes anything', async () => {
    // With no record target, the former precheck saw neither a local workspace nor a
    // reclaimable cluster and deleted the namespace under an unanswered grant.
    const world = load({ namespaces: ['houston-ghost'], owners: { 'houston-ghost': 'me' } });
    await expect(world.pruning.prune({ confirm: true, orphans: true })).rejects.toMatchObject({
      code: 'GATE_NOT_ONBOARDED',
    });
    expect(world.audited).toEqual([]);
    expect(world.deleted).toEqual([]);

    config.updateConfig((stored) => {
      revoke(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    await expect(world.pruning.prune({ confirm: true, orphans: true })).rejects.toMatchObject({
      code: 'GATE_OWNED_CLUSTER',
    });
    expect(world.audited).toEqual([]);
    expect(world.deleted).toEqual([]);
  });

  it('skips one unreadable workspace rather than abandoning the rest', async () => {
    // Only ConflictError was caught, so the DockerError of the first unreadable
    // workspace ended the run and every later one was silently left.
    const world = load({
      down: async (name) => {
        if (name === 'bad') {
          throw new (require('../../../src/lib/errors') as typeof ErrorsNS).DockerError(
            'could not ask the cluster',
          );
        }
        return 0;
      },
    });
    await composeRecords(world.record, 'bad', 'good');
    const out = await world.pruning.prune({ confirm: true, only: ['bad', 'good'] });
    expect(out.targets).toEqual(['bad', 'good']);
    expect(out.removed).toEqual(['good']);
  });

  it('acts only on what the prompt showed', async () => {
    // The prompt and the action computed their lists separately, so a workspace that went
    // `down` while somebody read the prompt was deleted without ever appearing on screen.
    const world = load();
    await composeRecords(world.record, 'a', 'b');
    const said: string[] = [];
    const out = await world.pruning.prune({
      confirm: true,
      only: ['a'],
      emit: (event: Event) => said.push(event.message),
    });
    expect(out.targets).toEqual(['a']);
    expect(out.removed).toEqual(['a']);
    expect(said.some((line) => line.includes('became prunable after the list was shown'))).toBe(
      true,
    );
  });

  it('takes the repair notes of what it removed, and only those', async () => {
    // `prune` deletes a down workspace's record the way `down --volumes` does, and left its
    // notes the same way -- so `doctor` advised `houston ready` on a workspace `prune` had
    // just removed. A workspace whose `down` failed keeps its record, so it keeps its
    // notes, and one that was never a target is not this prune's business.
    const world = load({
      workload: false,
      down: async (name) => (name === 'stuck' ? 1 : 0),
    });
    const journal = require('../../../src/core/journal') as typeof JournalNS;
    await composeRecords(world.record, 'cmp', 'stuck');
    await world.record.writeRecord(
      'kub',
      world.record.metadata({
        name: 'kub',
        project: 'houston-kub',
        extra: { runtime: 'kubernetes', context: 'kind-houston-local' },
      }),
    );
    for (const name of ['cmp', 'kub', 'stuck']) {
      journal.record(journal.CREATE_UNFINISHED, name);
      journal.record(journal.MONGO_PROFILER_ON, name);
    }
    journal.record(journal.CREATE_UNFINISHED, 'bystander');

    await expect(
      world.pruning.prune({ confirm: true, only: ['cmp', 'kub', 'stuck'] }),
    ).rejects.toMatchObject({
      code: 'GATE_NOT_ONBOARDED',
    });
    config.updateConfig((stored) => {
      revoke(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    await expect(
      world.pruning.prune({ confirm: true, only: ['cmp', 'kub', 'stuck'] }),
    ).rejects.toMatchObject({
      code: 'GATE_OWNED_CLUSTER',
    });
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    const out = await world.pruning.prune({ confirm: true, only: ['cmp', 'kub', 'stuck'] });

    expect(out.removed).toEqual(['cmp', 'kub']);
    expect(
      journal
        .openEntries()
        .map((e) => `${e.kind}:${e.workspace}`)
        .sort(),
    ).toEqual([
      'create_unfinished:bystander',
      'create_unfinished:stuck',
      'mongo_profiler_on:stuck',
    ]);
  });

  it('finds orphaned namespaces but sweeps them only when asked', async () => {
    // A namespace no local record explains is unreachable by every other command -- one
    // held 8Gi and five CrashLoopBackOff pods. It is OPT-IN because on a shared cluster an
    // unrecorded namespace may be a colleague's workspace from their own home.
    const operator = (require('../../../src/core/kube/operator') as { OPERATOR_NAMESPACE: string })
      .OPERATOR_NAMESPACE;
    const world = load({
      namespaces: ['houston-known', 'houston-p3', operator],
      owners: { 'houston-p3': 'me' },
    });
    await world.record.writeRecord(
      'known',
      world.record.metadata({ name: 'known', project: 'p', extra: { runtime: 'kubernetes' } }),
    );
    // The shared operator/monitoring namespace is not a workspace.
    expect(await world.pruning.orphanNamespaces()).toEqual(['houston-p3']);
    // A sweep nobody asked for could delete a colleague's work.
    expect((await world.pruning.prune({ confirm: true })).orphans).toEqual([]);
    expect(world.deleted).toEqual([]);
    // Asked for explicitly, it removes exactly the unexplained one.
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    expect((await world.pruning.prune({ confirm: true, orphans: true })).orphans).toEqual([
      'houston-p3',
    ]);
    expect(world.deleted).toEqual(['houston-p3']);
  });

  it('can only ever reclaim its own cluster, and a refusal is not a failed prune', async () => {
    // What houston created it may destroy; what you supplied it only borrows a namespace
    // in. No kind binary here, so nothing of ours to give back; and a cluster that still
    // holds a workspace refuses while the prune itself succeeds.
    const world = load({
      reclaimable: true,
      deleteCluster: async () => {
        throw new (require('../../../src/lib/errors') as typeof ErrorsNS).ConflictError(
          'cluster houston-local still holds 1 workspace namespace(s)',
        );
      },
    });
    const cluster = jest.requireActual('../../../src/core/kube/cluster') as {
      clusterReclaimable: () => Promise<boolean>;
    };
    expect(await cluster.clusterReclaimable()).toBe(false);
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    const events: Event[] = [];
    const out = await world.pruning.prune({ confirm: true, emit: (event) => events.push(event) });
    expect(out.cluster).toBe(false);
    expect(events.some((event) => event.message.includes('left alone'))).toBe(true);
  });

  it('waits for an orphan on the cluster it was deleted from', async () => {
    // The delete used the resolved context and the wait the hardcoded kind one, so on any
    // other cluster the wait asked a context not in the kubeconfig and read the failure as
    // "gone": exit 0 over a namespace still Terminating. Invisible on kind.
    const world = load({
      namespaces: ['houston-p9'],
      context: 'someone-elses-cluster',
      owners: { 'houston-p9': 'me' },
    });
    await world.pruning.prune({ confirm: true, orphans: true });
    expect(world.deleted).toEqual(['houston-p9']);
    expect(world.waited).toEqual(['someone-elses-cluster']);
  });

  it('leaves an orphaned namespace that names no owner alone, unless forced', async () => {
    // Made with no accounts and no HOUSTON_USER, a namespace's owner label is empty -- and
    // so is the caller's, in the same setup. '' matched '', and `prune --orphans --yes`
    // from a second home swept a colleague's LIVE workspace and its PVC without --force.
    const world = load({ namespaces: ['houston-nobody'], context: 'c' });
    expect((await world.pruning.prune({ confirm: true, orphans: true })).orphans).toEqual([]);
    expect(world.deleted).toEqual([]);
    await world.pruning.prune({ confirm: true, orphans: true, force: true });
    expect(world.deleted).toEqual(['houston-nobody']);
  });

  it('leaves an orphaned namespace somebody else owns alone, unless forced', async () => {
    // The sweep deleted a stray and its PVC without reading `houston.io/owner` --
    // and a stray is by definition what a colleague's workspace looks like from here.
    const world = load({
      namespaces: ['houston-hers', 'houston-mine', 'houston-unreadable'],
      context: 'c',
      owners: { 'houston-hers': 'alice', 'houston-mine': 'me', 'houston-unreadable': null },
    });
    expect((await world.pruning.prune({ confirm: true, orphans: true })).orphans).toEqual([
      'houston-mine',
    ]);
    expect(world.deleted).toEqual(['houston-mine']);
    // --force is the documented way to take them anyway.
    world.deleted.length = 0;
    await world.pruning.prune({ confirm: true, orphans: true, force: true });
    expect([...world.deleted].sort()).toEqual([
      'houston-hers',
      'houston-mine',
      'houston-unreadable',
    ]);
  });
});

describe('closing pooled edge connections while pruning Compose workspaces', () => {
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-prune-edge-'));
    process.env.HOUSTON_HOME = home;
  });
  afterEach(() => {
    for (const id of [
      '../../../src/core/runner/engine',
      '../../../src/core/runner/locks',
      '../../../src/core/topology',
      '../../../src/core/edge/networks',
      '../../../src/core/edge/routes',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
    process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function load(failedName = '') {
    jest.resetModules();
    const states = new Map<string, { attached: boolean; pooledSocketOpen: boolean }>();
    const stop = jest.fn(async (name: string) => {
      if (name === failedName) return 1;
      const state = states.get(name);
      if (state?.attached) state.pooledSocketOpen = false;
      return 0;
    });
    const down = jest.fn(async (name: string) => {
      const state = states.get(name);
      if (state?.attached) state.pooledSocketOpen = false;
      return 0;
    });
    const detach = jest.fn(async (name: string) => {
      const state = states.get(name);
      if (state !== undefined) state.attached = false;
    });
    const deregister = jest.fn();
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      stop,
      down,
    }));
    jest.doMock('../../../src/core/runner/locks', () => ({
      ...jest.requireActual('../../../src/core/runner/locks'),
      reproLock: (_name: string, body: () => Promise<unknown>) => body(),
    }));
    jest.doMock('../../../src/core/topology', () => ({
      ...jest.requireActual('../../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../../src/core/edge/networks'),
      detach,
    }));
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      deregister,
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    async function fixture(name: string): Promise<void> {
      states.set(name, { attached: true, pooledSocketOpen: true });
      await record.writeRecord(name, record.metadata({ name, project: `houston-${name}` }));
    }
    return {
      states,
      stop,
      down,
      detach,
      deregister,
      fixture,
      pruning: require('../../../src/core/lifecycle/pruning') as typeof PruningNS,
    };
  }

  it('keeps the endpoint attached until the graceful prune stop has completed', async () => {
    const { states, stop, down, detach, fixture, pruning } = load();
    await fixture('warmed');
    let releaseStop = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    stop.mockImplementationOnce(async (name) => {
      await held;
      const state = states.get(name);
      if (state?.attached) state.pooledSocketOpen = false;
      return 0;
    });
    const removed: string[] = [];
    const pruningOne = pruning.removeOneWorkspace('warmed', () => undefined, removed);
    try {
      await Promise.resolve();
      expect(states.get('warmed')?.attached).toBe(true);
      expect(detach).not.toHaveBeenCalled();
      expect(down).not.toHaveBeenCalled();
    } finally {
      releaseStop();
      await pruningOne;
    }
    expect(states.get('warmed')?.pooledSocketOpen).toBe(false);
    expect(removed).toEqual(['warmed']);
  });

  it('keeps a failed-stop project intact and continues the bulk sweep', async () => {
    const { states, stop, down, detach, deregister, fixture, pruning } = load('bad');
    await fixture('bad');
    await fixture('good');
    const removed: string[] = [];
    const events: string[] = [];

    await pruning.removeEachWorkspace((event) => void events.push(event.message), removed, [
      'bad',
      'good',
    ]);

    expect(states.get('bad')).toEqual({ attached: true, pooledSocketOpen: true });
    expect(fs.existsSync(path.join(home, 'repros/bad/repro.json'))).toBe(true);
    expect(events).toContain("could not stop 'bad' - skipping");
    expect(removed).toEqual(['good']);
    expect(stop.mock.calls.map(([name]) => name)).toEqual(['bad', 'good']);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledWith('good');
    expect(down).toHaveBeenCalledTimes(1);
    expect(down).toHaveBeenCalledWith('good', { volumes: true });
    expect(deregister).toHaveBeenCalledTimes(1);
    expect(deregister).toHaveBeenCalledWith('good');
  });
});

/**
 * `prunable()` against earlier releases' answer over hand-edited `pinned` values. Earlier
 * releases read `pinned` by their own truthiness, so `[]`, `{}`, `""`, `0.0` and `-0.0` are
 * no pin and NaN, `"0"` and `[0]` are one. `if (meta.pinned)` kept the list and the mapping
 * and pruned the NaN. The recorded answer is over the same records, Docker's gate passed and
 * no compose project running.
 */
describe('which workspaces prunable offers, against earlier releases', () => {
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-prunable-'));
    process.env.HOUSTON_HOME = home;
  });
  afterEach(() => {
    jest.dontMock('../../../src/core/lifecycle/preconditions');
    jest.dontMock('../../../src/core/runner/queries');
    jest.resetModules();
    process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const PINS: [string, string][] = [
    ['pinlist', '[]'],
    ['pindict', '{}'],
    ['pinnull', 'null'],
    ['pinzf', '0.0'],
    ['pinnegzero', '-0.0'],
    ['pinnan', 'NaN'],
    ['pinstr0', '"0"'],
    ['pinempty', '""'],
    ['pinlist0', '[0]'],
    ['pinone', '1'],
    ['pintrue', 'true'],
    ['pinfalse', 'false'],
  ];

  it('reads pinned by the truthiness earlier releases applied', async () => {
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    for (const [name, pinned] of PINS) {
      await record.writeRecord(name, record.metadata({ name, project: `houston-${name}` }));
      const file = path.join(home, 'repros', name, 'repro.json');
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain('"pinned": false');
      fs.writeFileSync(file, text.replace('"pinned": false', `"pinned": ${pinned}`));
    }
    // What earlier releases offered over those records, recorded.
    const recorded = [
      'pindict',
      'pinempty',
      'pinfalse',
      'pinlist',
      'pinnegzero',
      'pinnull',
      'pinzf',
    ];

    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      projectStates: async () => ({}),
    }));
    const pruning = require('../../../src/core/lifecycle/pruning') as typeof PruningNS;
    expect(await pruning.prunable()).toEqual(recorded);
    expect([...recorded].sort()).toEqual(
      ['pindict', 'pinempty', 'pinfalse', 'pinlist', 'pinnegzero', 'pinnull', 'pinzf'].sort(),
    );
  });
});
