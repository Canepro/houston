/**
 * The cluster ledger, and the refusals that read the same four-way answer.
 *
 * The `cluster.status` / `known_contexts` cases sit beside the reachability and context modules,
 * because every one of them is about what a person is TOLD when a read could not be made. The
 * cluster is the funnel, scripted per case; the ledger, the context resolver and the delete guard
 * above it are the real ones. The one module stated outright is the kubeconfig export, which is
 * what one of these cases is about and which would otherwise reach for kind.
 */
import type * as ClusterNS from '../../../src/core/kube/cluster';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PreflightError } from '../../../src/lib/errors';
import type { KubectlResult } from '../../../src/seams/kubectl';
import { knownContexts, status } from '../../../src/core/cluster';
import { aws, deleteCluster, identity } from '../../../src/core/eks';

import { planCluster } from '../../../src/core/kube/context';
import { kube } from '../../../src/core/kube/exec';
import { CONTEXT } from '../../../src/core/kube/names';
import { makeTool } from '../../../src/core/kube/tools';

/** Every kubeconfig export the ledger asked for, by context. */
const mockExported: string[] = [];
jest.mock('../../../src/core/kube/cluster', () => ({
  ...jest.requireActual<typeof ClusterNS>('../../../src/core/kube/cluster'),
  ensureKubeconfig: (plan: { context: string }) => {
    mockExported.push(plan.context);
    return Promise.resolve('');
  },
}));

const realRun = kube.run;
const realPath = process.env.PATH;
const realAws = { ...aws };

const ARN = 'arn:aws:eks:us-east-1:1:cluster/support';
const FORBIDDEN = 'Error from server (Forbidden): User "limited" cannot list resource';
const DENIED = 'error: You must be logged in to the server (Unauthorized)';
const DOWN = 'dial tcp 127.0.0.1:6443: connect: connection refused';

/**
 * A cluster that answers `/readyz` as told and refuses every read, with a kubeconfig naming
 * `contexts`. `nodes` answers the distribution question with a providerID when asked.
 */
function cluster({
  contexts,
  readyz,
  provider = 'aws:///eu-west-1a/i-0abc v1.31.0-eks-1234 m5',
  lists = { returncode: 1, stderr: FORBIDDEN },
}: {
  contexts: string[] | { unreadable: string };
  readyz: Partial<KubectlResult>;
  provider?: string;
  lists?: Partial<KubectlResult>;
}): void {
  kube.run = (argv) => {
    const joined = argv.join(' ');
    const reply = (value: Partial<KubectlResult>) =>
      Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '', ...value });
    if (joined.startsWith('kubectl config get-contexts')) {
      return reply(
        Array.isArray(contexts)
          ? { stdout: contexts.map((name) => `${name}\n`).join('') }
          : { returncode: 1, stderr: contexts.unreadable },
      );
    }
    if (joined.startsWith('kubectl config')) return reply({ returncode: 1, stderr: 'no entry' });
    if (argv.includes('/readyz')) return reply(readyz);
    if (argv.includes('nodes') && joined.includes('jsonpath')) return reply({ stdout: provider });
    return reply(lists);
  };
}

let toolDir = '';
function installTools(...names: string[]): void {
  toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-tools-'));
  for (const name of names) {
    fs.writeFileSync(path.join(toolDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  process.env.PATH = `${toolDir}${path.delimiter}${realPath ?? ''}`;
}

beforeEach(() => {
  mockExported.length = 0;
  // AWS is never asked from here: a cluster it would call gone is not these cases.
  aws.describeCluster = () => Promise.resolve({ state: 'refused' as const, doc: null });
});

afterEach(() => {
  kube.run = realRun;
  Object.assign(aws, realAws);
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  if (toolDir !== '') fs.rmSync(toolDir, { recursive: true, force: true });
  toolDir = '';
});

describe('the ledger', () => {
  it('never reports a zero it did not read', async () => {
    // A ledger exists to stop a cluster being forgotten, and the way it fails at that is by
    // reporting an unreadable cluster as an empty one -- "0 workspaces, nothing costing you
    // money" is precisely the sentence that lets a bill run. Here the cluster ANSWERS and
    // refuses every read, which `/readyz` passing is no evidence against.
    cluster({ contexts: ['eks-support'], readyz: { stdout: 'ok' } });
    const out = await status('eks-support');
    for (const key of ['nodes', 'workspaces', 'pvcs', 'loadbalancers'] as const) {
      // null, never 0, for a read that was refused.
      expect([key, out[key]]).toEqual([key, null]);
    }
    expect(out.unreadable).toEqual(
      expect.arrayContaining(['nodes', 'workspaces', 'loadbalancers']),
    );

    // And an UNREACHABLE cluster reports nothing at all rather than an empty one.
    cluster({ contexts: ['eks-support'], readyz: { returncode: 1, stderr: DOWN } });
    const gone = await status('eks-support');
    expect(gone.reachable).toBe(false);
    expect(gone.unreadable).toContain('cluster');
    expect([gone.workspaces, gone.loadbalancers]).toEqual([null, null]);
  });

  it('says a cluster REFUSED it, not that it is down, wherever a person reads it', async () => {
    // Measured three times in one day against a real EKS cluster: `cluster status` told an
    // engineer to check an ACTIVE cluster that was refusing their credential; `cluster
    // delete` called an ACTIVE cluster "not answering" when a fresh HOUSTON_HOME simply had
    // no kubeconfig entry for it; and `planCluster` offered three guesses at a cause it had
    // not read.

    // 1. the ledger -- and the counts below it stay unknown, not zero.
    cluster({ contexts: [ARN], readyz: { returncode: 1, stderr: DENIED } });
    const report = await status(ARN);
    expect(report.reachable).toBe(false);
    expect(report.reach_status).toBe('denied');
    expect(report.reach_why).toContain('refused these credentials');
    // The advice points at the access entry, not at the cluster's health.
    expect(report.reach_advice).toContain('create-access-entry');
    expect([report.nodes, report.workspaces]).toEqual([null, null]);

    // 2. planCluster's refusal, for a context this box has never heard of.
    cluster({
      contexts: [ARN],
      readyz: {
        returncode: 1,
        stderr: `Error in configuration: context was not found for specified context: ${ARN}`,
      },
    });
    const refusal = await planCluster(ARN).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PreflightError);
    expect((refusal as Error).message).toContain('no kubeconfig entry'); // not about the cluster
    expect((refusal as Error).message).toContain('update-kubeconfig'); // the command that writes one

    // 3. the delete guard still REFUSES -- it just says which kind of unreadable.
    aws.preflight = () =>
      Promise.resolve({
        tools: {
          aws: makeTool({ name: 'aws', path: '/usr/local/bin/aws', version: [9, 9, 9] }),
          eksctl: makeTool({ name: 'eksctl', path: '/usr/local/bin/eksctl', version: [9, 9, 9] }),
        },
        identity: identity({ account: '123456789012', arn: 'arn:aws:iam::123456789012:user/bot' }),
        region: 'us-east-1',
      });
    aws.ownsCluster = () => Promise.resolve({ state: 'present' as const, doc: { arn: ARN } });
    cluster({ contexts: [ARN], readyz: { returncode: 1, stderr: DENIED } });
    const guarded = await deleteCluster('support', { region: 'us-east-1' }).catch(
      (error: unknown) => error,
    );
    expect(guarded).toBeInstanceOf(PreflightError);
    expect((guarded as Error).message).toContain('not an empty one'); // the refusal did not weaken
    expect((guarded as Error).message).toContain('refused these credentials');
  });

  it('says when houston can no longer remove a cluster it built, and only then', async () => {
    // Uninstalling the kind BINARY does not remove its cluster: the containers keep running,
    // the API server answers, and 675 MiB stays held -- while every control that would take
    // it away answers "there was nothing to delete" rather than "I cannot delete it".
    const ours = {
      contexts: [CONTEXT],
      readyz: { stdout: 'ok' },
      provider: 'kind://docker/x/y v1.30.0 - n',
    };
    cluster(ours);
    const stuck = await status(CONTEXT);
    expect(stuck.reachable).toBe(true); // the cluster is still up -- that is the point
    expect(stuck.manageable).toBe(false);
    expect(stuck.unmanageable_why).toContain('no longer remove it');
    // ...and the way out that does not need the missing binary.
    expect(stuck.unmanageable_why).toContain('docker rm -f');

    installTools('kind');
    const fine = await status(CONTEXT);
    expect([fine.manageable, fine.unmanageable_why]).toEqual([true, '']);

    // A cluster that is not houston's was never houston's to remove, so kind being absent
    // says nothing about it.
    fs.rmSync(toolDir, { recursive: true, force: true });
    toolDir = '';
    process.env.PATH = realPath;
    cluster({ ...ours, contexts: ['k3s-default'] });
    expect((await status('k3s-default')).manageable).toBe(true);
  });

  it('reaches houston’s own cluster from a fresh home, and leaves others’ kubeconfigs alone', async () => {
    // `isOurs` is a NAME compare, so houston reaches its own cluster through its OWN
    // kubeconfig -- which a fresh HOUSTON_HOME has not got. `ensureKubeconfig` exists for
    // exactly this, was fixed for `up`, and `cluster status` reintroduced the defect by
    // probing without calling it. CLAUDE.md tells script writers to use a fresh home.
    cluster({ contexts: [CONTEXT, 'someone-elses'], readyz: { returncode: 1, stderr: DOWN } });
    await status(CONTEXT);
    expect(mockExported).toEqual([CONTEXT]);

    // And NOT for a cluster somebody else made: rewriting their kubeconfig is not ours.
    mockExported.length = 0;
    await status('someone-elses');
    expect(mockExported).toEqual([]);
  });
});

describe('the list of clusters this box can name', () => {
  it('says the kubeconfig could not be read, rather than showing nothing', async () => {
    // "I could not read the kubeconfig" is not "there are no clusters", and the caller has
    // to be able to say the page may be missing some.
    cluster({ contexts: { unreadable: 'permission denied' }, readyz: { stdout: 'ok' } });
    const out = await knownContexts();
    expect(out.contexts).toEqual([]);
    expect(out.unreadable).toBe('permission denied');
  });

  it('never drops a cluster that is not houston’s, however dead it looks', async () => {
    // An adopted k3s or EKS context that is down is somebody else's business -- and an EKS
    // cluster that is not answering is exactly the one they most need to see, because it
    // is still billing. The phantom rule is about houston's OWN stale entry only.
    cluster({ contexts: [ARN, 'default'], readyz: { returncode: 1, stderr: DOWN } });
    expect((await knownContexts()).contexts.map((row) => row.context)).toEqual([ARN, 'default']);
  });
});
