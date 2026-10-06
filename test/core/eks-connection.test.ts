/** The connection lock is tested with an in-memory mutex; no process or cloud tool runs. */
import { awsCli } from '../../src/seams/aws-cli';
import { aws, connectExisting, identity } from '../../src/core/eks';
import { kube } from '../../src/core/kube/exec';
import type * as LocksNS from '../../src/core/runner/locks';

jest.mock('../../src/core/runner/locks', () => {
  const actual = jest.requireActual<typeof LocksNS>('../../src/core/runner/locks');
  let queue = Promise.resolve();
  return {
    ...actual,
    reproLock: async <T>(name: string, body: () => T | Promise<T>): Promise<T> => {
      if (name !== 'kubeconfig-connect') return await body();
      const before = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        return await body();
      } finally {
        release();
      }
    },
  };
});

it('serializes simultaneous EKS connects and keeps the original kubectl context selected', async () => {
  const account = '111122223333';
  const firstArn = `arn:aws:eks:eu-west-1:${account}:cluster/support-a`;
  const secondArn = `arn:aws:eks:eu-west-1:${account}:cluster/support-b`;
  let current = 'kind-local';
  const reads: string[] = [];
  const updates: string[] = [];
  let signalFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirst = resolve;
  });
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  aws.whoami = () =>
    Promise.resolve(identity({ account, arn: `arn:aws:iam::${account}:user/alice` }));
  aws.describeCluster = (name) =>
    Promise.resolve({
      state: 'present' as const,
      doc: { arn: name === 'support-a' ? firstArn : secondArn },
    });
  kube.run = (argv) => {
    if (argv[2] === 'current-context') {
      reads.push(current);
      return Promise.resolve({ argv, returncode: 0, stdout: current, stderr: '' });
    }
    if (argv[2] === 'use-context') current = argv[3] ?? '';
    if (argv[2] === 'unset') current = '';
    return Promise.resolve({ argv, returncode: 0, stdout: 'ok', stderr: '' });
  };
  awsCli.run = async (argv) => {
    const alias = argv[argv.indexOf('--alias') + 1] ?? '';
    updates.push(alias);
    current = alias; // aws eks update-kubeconfig selects its new context.
    if (alias === firstArn) {
      signalFirst();
      await holdFirst;
    }
    return { argv, returncode: 0, stdout: '', stderr: '' };
  };

  const first = connectExisting(firstArn);
  await firstStarted;
  const second = connectExisting(secondArn);
  // Let the second request reach the lock while the first update is still open.
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst();
  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.context)).toEqual([firstArn, secondArn]);
  expect(updates).toEqual([firstArn, secondArn]);
  expect(reads).toEqual(['kind-local', 'kind-local']);
  expect(current).toBe('kind-local');
});
