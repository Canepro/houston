/**
 * What a Kubernetes workspace reports about itself: its logs, its numbers, its state.
 *
 * Every case is stated through the kubectl seam and nothing else, so the state column is decided by
 * the same reads a live `list` makes -- `kubernetesState` lives in the lifecycle package and is
 * driven here because its whole answer is these probes put in order.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { NotReadyError } from '../../../src/lib/errors';
import type { KubectlResult } from '../../../src/seams/kubectl';
import type * as PolicyNS from '../../testsetup-policy';
import { kubernetesState } from '../../../src/core/lifecycle/inspect';
import type { Metadata } from '../../../src/core/runner/record';

import { kube } from '../../../src/core/kube/exec';
import { RELEASE } from '../../../src/core/kube/names';
import type * as StatusNS from '../../../src/core/kube/status';
import {
  APP_SELECTOR,
  LOG_SELECTOR,
  containerEnv,
  logArgv,
  podMetrics,
  workloadExists,
} from '../../../src/core/kube/status';

const realRun = kube.run;

afterEach(() => {
  kube.run = realRun;
});

type Reply = Partial<KubectlResult>;

function answer(pick: (argv: readonly string[]) => Reply | undefined): void {
  kube.run = (argv) =>
    Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '', ...(pick(argv) ?? {}) });
}

describe('the logs', () => {
  it('prefixes log lines only when there are replicas to tell apart, over the whole release', async () => {
    // Rocket.Chat pretty-prints its logs, and the reader came for THAT. `--prefix` was
    // unconditional, so every line arrived stamped "[pod/rocketchat-rocketchat-<hash>/...]"
    // and the columns were pushed off the screen. With one pod the prefix names the only
    // candidate; with several it is the only way to tell replicas apart.
    const withPods = (count: number) => {
      answer(() => ({
        stdout: Array.from({ length: count }, (_, index) => `pod/rc-${String(index)}`).join('\n'),
      }));
      return logArgv('w', { context: 'c', tail: 25, follow: true });
    };
    const single = await withPods(1);
    expect(single).not.toContain('--prefix');
    // The selected pods have DIFFERENT container names -- rocketchat, ddp-streamer,
    // presence -- so naming one would fail on the others.
    expect(single).not.toContain('-c');
    expect(single).toContain('-f');
    expect(single).toContain('--tail');
    // THE SELECTOR IS THE POINT ON MICROSERVICES: the monolith deployment alone left
    // ddp-streamer, which carries the WebSocket, with no output at all.
    const selector = single[single.indexOf('-l') + 1] ?? '';
    expect(selector).toContain(`app.kubernetes.io/instance=${RELEASE}`);
    // But not the message bus, which would drown Rocket.Chat's own lines.
    expect(selector).toContain('app.kubernetes.io/name!=nats');
    // The narrow questions still ask the narrow one: env means Rocket.Chat itself.
    expect(APP_SELECTOR).toBe('app.kubernetes.io/name=rocketchat');
    expect(selector).toBe(LOG_SELECTOR);

    expect(await withPods(3)).toContain('--prefix');

    // A failed pod count must not decide the shape either way: the quiet form, not a guess
    // that there are many.
    answer(() => ({ returncode: 1, stderr: 'boom' }));
    const quiet = await logArgv('w', { context: 'c', tail: 5, follow: false });
    expect(quiet).not.toContain('--prefix');
    expect(quiet).not.toContain('-f');
  });
});

describe('the lines a log read delivers', () => {
  afterEach(() => {
    // THE SUITE'S GUARD GOES BACK, rather than `jest.dontMock`, which would leave every later
    // case in this file on the unguarded process seam (see `test/testsetup-cloud.ts`).
    jest.doMock('../../../src/seams/exec', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).guardedExec(),
    );
    jest.resetModules();
  });

  // Earlier releases read the log child's output a line at a time in text mode, line-buffered,
  // each line's newline stripped, for a child that writes each case's chunks.
  // Each case is the chunks the pipe delivers, in order.
  const CASES: string[][] = [
    // The last line has no newline, and is still a line.
    ['one\ntwo\nno newline at end'],
    // A line redrawn with bare carriage returns is three lines in text mode.
    ['progress 10\rprogress 20\rdone\r\n'],
    // A `\r\n` split across two reads is one line ending, not two.
    ['a\r', '\nb\r', 'c'],
    // Empty lines are lines; a `\r` the pipe closes on ends its line.
    ['x\n\n\r'],
    ['crlf\r\n', 'tail\r'],
    ['é\n', 'ü'],
    [],
  ];

  it('are the lines text mode reads, the unterminated last one included', async () => {
    // What earlier releases read from each case, recorded.
    const recorded: string[][] = [
      ['one', 'two', 'no newline at end'],
      ['progress 10', 'progress 20', 'done'],
      ['a', 'b', 'c'],
      ['x', '', ''],
      ['crlf', 'tail'],
      ['é', 'ü'],
      [],
    ];

    const ours: string[][] = [];
    for (const chunks of CASES) {
      jest.resetModules();
      jest.doMock('../../../src/seams/exec', () => ({
        ...jest.requireActual('../../../src/seams/exec'),
        stream: async (argv: string[], options: { onStdout: (chunk: string) => void }) => {
          for (const chunk of chunks) options.onStdout(chunk);
          return { argv, exitCode: 0, signal: null, stdout: null, stderr: null };
        },
      }));
      const exec = require('../../../src/core/kube/exec') as { kube: { run: typeof kube.run } };
      exec.kube.run = (argv) =>
        Promise.resolve({ argv, returncode: 0, stdout: 'pod/rc-0\n', stderr: '' });
      const status = require('../../../src/core/kube/status') as typeof StatusNS;
      const seen: string[] = [];
      await status.logProcess('w', { context: 'c', onLine: (line) => seen.push(line) });
      ours.push(seen);
    }
    // All at once, so a failure shows every case that differs rather than the first.
    expect(ours).toEqual(recorded);
    expect(recorded[0]).toEqual(['one', 'two', 'no newline at end']);
    expect(recorded[1]).toEqual(['progress 10', 'progress 20', 'done']);
  });
});

describe('the numbers', () => {
  it('sums real pod metrics, and names metrics-server when it is missing', async () => {
    // `stats` on Kubernetes reads `kubectl top`, which needs metrics-server -- and kind does
    // not ship it. A resource figure that is quietly zero is worse than a missing one, so
    // the refusal says so and how to install it. (`env`, the other half of the case earlier
    // releases held, is answered from the running container in `test/core/topology.test.ts`.)
    answer((argv) =>
      argv.includes('top')
        ? { stdout: 'rocketchat-a   120m   500Mi\nrocketchat-b   80m   300Mi\n' }
        : undefined,
    );
    const rows = await podMetrics('k', { context: 'c' });
    // Replicas are summed.
    expect(rows.reduce((sum, row) => sum + row.cpu_millicores, 0)).toBe(200);
    // Mi is binary, not 1e6.
    expect(rows[0]?.mem_bytes).toBe(500 * 1024 ** 2);

    answer(() => ({ returncode: 1, stderr: 'error: Metrics API not available' }));
    const refused = await podMetrics('k', { context: 'c' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotReadyError);
    expect((refused as Error).message).toContain('metrics-server');
    // Say how to install it.
    expect((refused as Error).message).toContain('kubectl apply');
  });
});

describe('the state column', () => {
  const meta = { extra: { context: 'c' } } as unknown as Metadata;

  /** A cluster answering each probe `kubernetesState` makes, in the shape kubectl prints. */
  function cluster({
    namespaces = ['houston-k'],
    workload = true,
    replicas = '1',
    ready = false,
    pods = [] as Record<string, unknown>[],
    release = 'deployed',
    podsRefused = false,
    helmRefused = false,
  }: {
    namespaces?: string[];
    workload?: boolean;
    replicas?: string;
    ready?: boolean;
    pods?: Record<string, unknown>[];
    release?: string;
    podsRefused?: boolean;
    helmRefused?: boolean;
  }): void {
    const json = (value: unknown) => ({ stdout: JSON.stringify(value) });
    answer((argv) => {
      if (argv[0] === 'helm') {
        return helmRefused
          ? { returncode: 1, stderr: 'could not ask' }
          : json([{ name: RELEASE, status: release, revision: 1 }]);
      }
      if (argv.includes('namespace') && argv.includes('-l')) {
        return json({ items: namespaces.map((name) => ({ metadata: { name } })) });
      }
      if (argv.includes('jsonpath={.spec.replicas}')) return { stdout: replicas };
      if (argv.includes('deployment')) return workload ? json({ kind: 'Deployment' }) : {};
      if (argv.includes('pod') && argv.includes('-l')) {
        return json({ items: [{ status: { containerStatuses: [{ ready }] } }] });
      }
      if (argv.includes('pods')) {
        return podsRefused ? { returncode: 1, stderr: 'could not ask' } : json({ items: pods });
      }
      return undefined;
    });
  }

  it('calls a workspace whose release is gone down, not starting', async () => {
    // A plain `down` keeps the namespace and its PVC on purpose and uninstalls the release.
    // Asking only whether the namespace exists reported such a workspace as "starting" --
    // for ever, because nothing was coming. Seen on a real box, just after a `down`.
    cluster({ workload: false });
    expect(await kubernetesState('k', meta)).toBe('down');
    // Workload back but not serving yet.
    cluster({ ready: false });
    expect(await kubernetesState('k', meta)).toBe('starting');
    cluster({ ready: true });
    expect(await kubernetesState('k', meta)).toBe('running');
    // And no namespace at all is still down.
    cluster({ namespaces: [] });
    expect(await kubernetesState('k', meta)).toBe('down');
  });

  it('calls a wedged workspace failed, and a refused probe still starting', async () => {
    // Everything not ready read as `starting`, which promises something is coming.
    // For a pod in ImagePullBackOff or a `pending-install` release nothing is, and both
    // facts were already available while `list` printed "starting" beside them.
    cluster({});
    expect(await kubernetesState('k', meta)).toBe('starting');

    cluster({
      pods: [
        {
          metadata: { name: 'mongodb-0' },
          status: {
            containerStatuses: [
              { state: { waiting: { reason: 'ImagePullBackOff', message: 'no such host' } } },
            ],
          },
        },
      ],
    });
    expect(await kubernetesState('k', meta)).toBe('failed');

    cluster({ release: 'pending-install' });
    expect(await kubernetesState('k', meta)).toBe('failed');

    // A REFUSED probe must not manufacture a failure: still `starting`.
    cluster({ podsRefused: true, helmRefused: true });
    expect(await kubernetesState('k', meta)).toBe('starting');
  });
});

/**
 * The context and the workspace name quoted as earlier releases quote them, in the words the
 * environment read and the workload check use for a refused read, with `kube.run` answering
 * the same way and the answers recorded in `test/fixtures/core/kube/status.json`.
 * An earlier version hard-coded single quotes: `'beta's` where earlier releases say
 * `'beta''s`, and `'o'brien'` for a context they write `"o'brien"`.
 */
describe('the refusals, as earlier releases word them', () => {
  const CASES: [string, string][] = [
    ['beta', 'kind-houston-local'],
    ['beta', "o'brien"],
    ['it-s', 'a\\b'],
  ];
  const RECORDED = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', 'fixtures', 'core', 'kube', 'status.json'),
      'utf8',
    ),
  ) as { refusals: unknown[] };

  async function outcome(fn: () => Promise<unknown>): Promise<[string, string] | null> {
    try {
      await fn();
      return null;
    } catch (error) {
      return [(error as Error).name, (error as Error).message];
    }
  }

  it('names the cluster and the workspace quoted, refused and absent alike', async () => {
    // Exit 1 is the refused read (RBAC, a wrong context, no kubectl); exit 0 with nothing on
    // stdout is the pod that is not there.
    const runs = CASES.flatMap(([name, context]) => [
      [1, name, context] as const,
      [0, name, context] as const,
    ]);
    // What earlier releases raised for each run, recorded.
    const recorded = RECORDED.refusals;
    const ours: unknown[] = [];
    for (const [code, name, context] of runs) {
      answer(() => ({ returncode: code, stderr: 'Error: forbidden' }));
      ours.push([
        await outcome(() => containerEnv(name, { context })),
        await outcome(() => workloadExists(name, { context })),
      ]);
    }
    expect(ours).toEqual(recorded);
    expect(JSON.stringify(recorded)).toContain(`\\"o'brien\\" for 'beta''s Rocket.Chat pod`);
  });
});
