/**
 * `start`, in the order a hand-written MongoDB needs.
 *
 * Its own spec because the replica-set repair is a separate module `start` imports by name,
 * and asserting the ORDER needs that call replaced -- the rest of scaling is in
 * `tier3.test.ts`, stated through the kubectl seam alone.
 */
import type * as ReplicasetNS from '../../../src/core/kube/replicaset';

import type { KubectlResult } from '../../../src/seams/kubectl';

import { kube } from '../../../src/core/kube/exec';
import { POD_GONE_TRIES, scaleRocketchat, startWorkspace } from '../../../src/core/kube/scale';
import { Quiesced, repairStopped } from '../../../src/core/backup';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import { clear, openEntries, ROCKETCHAT_STOPPED, type Entry } from '../../../src/core/journal';
import { nullEmit } from '../../../src/lib/events';
import { waitServing } from '../../../src/core/lifecycle/ready';
import { APPLICATION_SELECTOR } from '../../../src/core/kube/names';

const order: string[] = [];

jest.mock('../../../src/core/kube/replicaset', () => ({
  ...jest.requireActual<typeof ReplicasetNS>('../../../src/core/kube/replicaset'),
  initReplicaSet: () => {
    order.push('replica-ready');
    return Promise.resolve();
  },
}));

jest.mock('../../../src/core/lifecycle/ready', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/ready'),
  waitServing: jest.fn(async () => ({})),
}));

const realRun = kube.run;

afterEach(() => {
  kube.run = realRun;
  order.length = 0;
});

describe('starting a stopped workspace', () => {
  it('makes a hand-written MongoDB a primary before Rocket.Chat is scaled back up', async () => {
    // Starting every workload together lets MongoDB lose its self-DNS race, and Rocket.Chat
    // then crash-loops against a persisted REMOVED member. So the database is scaled first
    // and repaired into a writable primary before any Rocket.Chat deployment comes back.
    kube.run = (argv) => {
      const reply = (value: Partial<KubectlResult>) =>
        Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '', ...value });
      if (argv.includes('namespace') && argv.includes('json')) {
        return reply({ stdout: JSON.stringify({ metadata: {} }) });
      }
      if (argv.includes('deployment,statefulset')) {
        return reply({
          stdout: 'statefulset.apps/mongodb\ndeployment.apps/rocketchat-rocketchat\n',
        });
      }
      // No MongoDBCommunity: this is the hand-written StatefulSet, which houston repairs.
      if (argv.includes('mongodbcommunity')) return reply({ returncode: 1, stderr: 'NotFound' });
      if (argv.includes('scale')) order.push(`scale:${argv.at(-1) ?? ''}`);
      return reply({ stdout: '1' });
    };
    await startWorkspace('w', { context: 'c' });
    expect(order).toEqual([
      'scale:statefulset.apps/mongodb',
      'replica-ready',
      'scale:deployment.apps/rocketchat-rocketchat',
    ]);
  });
});

describe('verified Rocket.Chat quiescence', () => {
  let counts: Record<string, number>;
  let fault: '' | 'list' | 'scale' | 'pods' | 'restore';
  let pods: string[];
  let queries: string[][];
  let labels: Record<string, { name: string; instance?: string }>;

  beforeEach(async () => {
    jest.mocked(waitServing).mockClear();
    counts = { 'deployment.apps/rc': 3, 'deployment.apps/account': 2 };
    fault = '';
    pods = [''];
    queries = [];
    labels = {
      'deployment.apps/rc': { name: 'rocketchat', instance: 'rocketchat' },
      'deployment.apps/account': { name: 'rocketchat-account', instance: 'rocketchat' },
    };
    await writeRecord(
      'w',
      metadata({
        name: 'w',
        project: 'houston-w',
        hostPort: 3400,
        rootUrl: 'http://localhost:3400',
        extra: { runtime: 'kubernetes', context: 'c', namespace: 'houston-w' },
      }),
    );
    kube.run = async (argv) => {
      queries.push([...argv]);
      const reply = (value: Partial<KubectlResult> = {}): KubectlResult => ({
        argv,
        returncode: 0,
        stdout: '',
        stderr: '',
        ...value,
      });
      if (argv.includes('get') && argv.includes('deployment')) {
        const selector = argv[argv.indexOf('-l') + 1];
        const selected = Object.keys(counts).filter((target) => {
          const label = labels[target];
          if (selector === 'app.kubernetes.io/name=rocketchat') return label?.name === 'rocketchat';
          if (selector === APPLICATION_SELECTOR)
            return label?.instance === 'rocketchat' && label.name !== 'nats';
          throw new Error(`unexpected deployment selector: ${String(selector)}`);
        });
        if (argv.at(-1) === 'json') {
          return reply({
            stdout: JSON.stringify({
              items: selected.map((target) => ({
                metadata: { name: target.split('/')[1] },
                spec: { replicas: counts[target] },
              })),
            }),
          });
        }
        if (fault === 'list') {
          fault = '';
          return reply({ returncode: 46, stderr: 'controlled deployment list refusal' });
        }
        return reply({ stdout: selected.join('\n') });
      }
      if (argv.includes('scale')) {
        const replicas = Number(
          (argv.find((arg) => arg.startsWith('--replicas=')) ?? '').split('=')[1],
        );
        const targets = argv.filter((arg) => arg.startsWith('deployment.apps/'));
        if (fault === 'scale' && replicas === 0) {
          fault = '';
          // One deployment stopped before the returned failure; entry must unwind it.
          const first = targets[0];
          if (first !== undefined) counts[first] = 0;
          return reply({ returncode: 47, stderr: 'controlled partial scale refusal' });
        }
        if (fault === 'restore' && replicas > 0) return reply({ returncode: 48 });
        for (const target of targets) counts[target] = replicas;
        return reply();
      }
      if (argv.includes('pods')) {
        if (fault === 'pods') {
          fault = '';
          return reply({ returncode: 49, stderr: 'controlled pod discovery refusal' });
        }
        return reply({ stdout: pods.length > 1 ? (pods.shift() ?? '') : (pods[0] ?? '') });
      }
      throw new Error(`unexpected quiescence query: ${argv.join(' ')}`);
    };
  });

  afterEach(() => {
    for (const note of openEntries()) clear(note.id);
  });

  it('restores exact per-deployment counts and records the original shape before stopping', async () => {
    const original = { ...counts };
    const paused = new Quiesced('w', [], nullEmit);
    await paused.enter();
    expect(counts).toEqual({ 'deployment.apps/rc': 0, 'deployment.apps/account': 0 });
    expect(openEntries().find((note) => note.kind === ROCKETCHAT_STOPPED)?.detail).toMatchObject({
      deployment_replicas: original,
    });
    await paused.exit();
    expect(counts).toEqual(original);
    expect(openEntries()).toEqual([]);
  });

  it('quiesces every microservice writer and restores mixed counts while keeping backing workloads up', async () => {
    counts = {
      'deployment.apps/rc': 3,
      'deployment.apps/account': 2,
      'deployment.apps/presence': 0,
      'deployment.apps/nats': 3,
      'deployment.apps/keycloak': 1,
      'deployment.apps/mongodb': 1,
      'deployment.apps/minio': 1,
    };
    labels = {
      ...labels,
      'deployment.apps/presence': { name: 'rocketchat-presence', instance: 'rocketchat' },
      'deployment.apps/nats': { name: 'nats', instance: 'rocketchat' },
      'deployment.apps/keycloak': { name: 'keycloak' },
      'deployment.apps/mongodb': { name: 'mongodb' },
      'deployment.apps/minio': { name: 'minio' },
    };
    const original = { ...counts };
    const run = kube.run;
    let podReads = 0;
    kube.run = async (argv, options) => {
      if (argv.includes('get') && argv.includes('pods')) {
        queries.push([...argv]);
        const selector = argv[argv.indexOf('-l') + 1];
        return {
          argv,
          returncode: 0,
          stderr: '',
          // Only the account writer is still terminating; monolith-only discovery
          // would falsely conclude that it is safe to access the database immediately.
          stdout:
            selector === APPLICATION_SELECTOR && podReads++ === 0 ? 'pod/account-terminating' : '',
        };
      }
      return await run(argv, options);
    };
    const paused = new Quiesced('w', [], nullEmit);
    await paused.enter();
    expect(counts).toEqual({
      ...original,
      'deployment.apps/rc': 0,
      'deployment.apps/account': 0,
    });
    expect(queries.filter((argv) => argv.includes('pods'))).toHaveLength(2);
    expect(
      openEntries().find((note) => note.kind === ROCKETCHAT_STOPPED)?.detail.deployment_replicas,
    ).toEqual({
      'deployment.apps/rc': 3,
      'deployment.apps/account': 2,
      'deployment.apps/presence': 0,
    });
    await paused.exit();
    expect(counts).toEqual(original);
    expect(
      queries
        .filter(
          (argv) => argv.includes('get') && (argv.includes('deployment') || argv.includes('pods')),
        )
        .every((argv) => argv[argv.indexOf('-l') + 1] === APPLICATION_SELECTOR),
    ).toBe(true);
  });

  it('keeps zero replicas stopped and does not wait for a previously stopped workspace', async () => {
    counts = { 'deployment.apps/rc': 0 };
    const paused = new Quiesced('w', [], nullEmit);
    await paused.enter();
    await paused.exit();
    expect(counts).toEqual({ 'deployment.apps/rc': 0 });
    expect(waitServing).not.toHaveBeenCalled();
  });

  it.each(['list', 'scale', 'pods'] as const)(
    'refuses a returned %s failure and unwinds the prior shape',
    async (failure) => {
      const original = { ...counts };
      fault = failure;
      await expect(new Quiesced('w', [], nullEmit).enter()).rejects.toThrow(/could not/u);
      expect(counts).toEqual(original);
      expect(openEntries()).toEqual([]);
    },
  );

  it('waits for terminating writers to disappear before completing scale-to-zero', async () => {
    pods = ['pod/terminating-writer', ''];
    const sleeps: number[] = [];
    await scaleRocketchat('w', {
      replicas: 0,
      context: 'c',
      sleep: async (seconds) => {
        sleeps.push(seconds);
      },
    });
    expect(queries.filter((argv) => argv.includes('pods'))).toHaveLength(2);
    expect(sleeps).toEqual([2]);
  });

  it('refuses writer termination timeout rather than continuing to the database', async () => {
    pods = ['pod/still-terminating'];
    await expect(
      scaleRocketchat('w', { replicas: 0, context: 'c', sleep: async () => undefined }),
    ).rejects.toThrow(/did not terminate/u);
    expect(queries.filter((argv) => argv.includes('pods'))).toHaveLength(POD_GONE_TRIES);
  });

  it('retains original replica recovery data when restarting a deployment fails', async () => {
    const paused = new Quiesced('w', [], nullEmit);
    await paused.enter();
    fault = 'restore';
    await expect(paused.exit()).rejects.toThrow(/prior state could not be restored/u);
    expect(
      openEntries().find((note) => note.kind === ROCKETCHAT_STOPPED)?.detail.deployment_replicas,
    ).toEqual({
      'deployment.apps/rc': 3,
      'deployment.apps/account': 2,
    });
  });

  function stoppedEntry(detail: Record<string, unknown>): Entry {
    return {
      id: 'old',
      kind: ROCKETCHAT_STOPPED,
      workspace: 'w',
      pid: 1,
      started: '',
      at: '',
      detail: { context: 'c', ...detail },
    };
  }

  it('recovers distinct replica counts from the journal, including a stopped deployment', async () => {
    counts = { 'deployment.apps/rc': 0, 'deployment.apps/account': 0 };
    expect(
      await repairStopped(
        stoppedEntry({
          deployment_replicas: { 'deployment.apps/rc': 3, 'deployment.apps/account': 0 },
        }),
        nullEmit,
        null,
      ),
    ).toBe(true);
    expect(counts).toEqual({ 'deployment.apps/rc': 3, 'deployment.apps/account': 0 });
  });

  it('repairs an old scalar journal only on the monolith and preserves untouched microservice counts', async () => {
    counts = {
      'deployment.apps/rc': 0,
      'deployment.apps/account': 3,
      'deployment.apps/presence': 0,
    };
    labels['deployment.apps/presence'] = { name: 'rocketchat-presence', instance: 'rocketchat' };
    expect(await repairStopped(stoppedEntry({ replicas: 2 }), nullEmit, null)).toBe(true);
    expect(counts).toEqual({
      'deployment.apps/rc': 2,
      'deployment.apps/account': 3,
      'deployment.apps/presence': 0,
    });
    expect(
      queries
        .filter((argv) => argv.includes('get') && argv.includes('deployment'))
        .every((argv) => argv[argv.indexOf('-l') + 1] === 'app.kubernetes.io/name=rocketchat'),
    ).toBe(true);
  });

  it.each([
    [0, 0],
    ['0', 0],
    [undefined, 1],
    [3, 3],
  ])(
    'keeps legacy journal count %s compatible with replica count %s',
    async (recorded, expected) => {
      expect(await repairStopped(stoppedEntry({ replicas: recorded }), nullEmit, null)).toBe(true);
      expect(counts).toEqual({ 'deployment.apps/rc': expected, 'deployment.apps/account': 2 });
    },
  );
});
