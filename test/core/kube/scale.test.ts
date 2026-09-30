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
import { startWorkspace } from '../../../src/core/kube/scale';

const order: string[] = [];

jest.mock('../../../src/core/kube/replicaset', () => ({
  ...jest.requireActual<typeof ReplicasetNS>('../../../src/core/kube/replicaset'),
  initReplicaSet: () => {
    order.push('replica-ready');
    return Promise.resolve();
  },
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
