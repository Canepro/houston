import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Event } from '../../../src/lib/events';
import type { KubectlResult } from '../../../src/core/kube/exec';

import type * as PruningNS from '../../../src/core/lifecycle/pruning';
import type * as JournalNS from '../../../src/core/journal';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as ErrorsNS from '../../../src/lib/errors';

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
    const errors = require('../../../src/lib/errors') as typeof ErrorsNS;
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
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
    context?: string;
    owners?: Record<string, string | null>;
    deleteCluster?: () => Promise<boolean>;
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
      deleteNamespace: async () => true,
    }));
    jest.doMock('../../../src/core/kube/exec', () => {
      const actual = jest.requireActual('../../../src/core/kube/exec');
      return {
        ...actual,
        kube: {
          run: async (argv: string[]): Promise<KubectlResult> => {
            if (argv.includes('delete') && argv.includes('namespace')) {
              deleted.push(argv[argv.indexOf('namespace') + 1] as string);
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

  it('gives back the cluster it created once nothing is left in it', async () => {
    // Measured live: with every workspace gone, `prune` said "Nothing to prune" and left
    // houston's own kind control plane running -- 514 MiB holding nothing -- while the
    // README and the agent skill both said it reclaims it.
    const world = load({ deleteCluster: async () => true });
    expect((await world.pruning.prune({ confirm: true })).cluster).toBe(true);
    expect(world.reclaimed).toHaveLength(1);
    // And the same offer applies on the other early path.
    world.reclaimed.length = 0;
    expect((await world.pruning.prune({ confirm: true, orphans: false })).cluster).toBe(true);
    expect(world.reclaimed).toHaveLength(1);
  });

  it('audits the namespaces it swept, not only the records', async () => {
    // The subject was the local records alone, so a sweep of namespaces and no records
    // wrote `prune` with an empty subject -- no trace anywhere of what was destroyed.
    const world = load({ namespaces: ['houston-ghost'] });
    await world.pruning.prune({ confirm: true, orphans: true });
    expect(world.audited[0]?.[0]).toBe('prune');
    expect(world.audited[0]?.[1]).toContain('houston-ghost');
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
        extra: { runtime: 'kubernetes', context: 'default' },
      }),
    );
    for (const name of ['cmp', 'kub', 'stuck']) {
      journal.record(journal.CREATE_UNFINISHED, name);
      journal.record(journal.MONGO_PROFILER_ON, name);
    }
    journal.record(journal.CREATE_UNFINISHED, 'bystander');

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
    const world = load({ namespaces: ['houston-known', 'houston-p3', operator] });
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
    const events: Event[] = [];
    const out = await world.pruning.prune({ confirm: true, emit: (event) => events.push(event) });
    expect(out.cluster).toBe(false);
    expect(events.some((event) => event.message.includes('left alone'))).toBe(true);
  });

  it('waits for an orphan on the cluster it was deleted from', async () => {
    // The delete used the resolved context and the wait the hardcoded kind one, so on any
    // other cluster the wait asked a context not in the kubeconfig and read the failure as
    // "gone": exit 0 over a namespace still Terminating. Invisible on kind.
    const world = load({ namespaces: ['houston-p9'], context: 'someone-elses-cluster' });
    await world.pruning.prune({ confirm: true, orphans: true });
    expect(world.deleted).toEqual(['houston-p9']);
    expect(world.waited).toEqual(['someone-elses-cluster']);
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
