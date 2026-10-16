/**
 * Tier k3: the namespace, the workload, the cluster, and where traffic arrives.
 *
 * The tier that DELETES. Every case here is about the same distinction one layer up from
 * `ask`: what a caller is entitled to do on each of the three answers. `[]` from a refused
 * read is how a colleague's namespace looks unowned; `true` from an unreachable cluster is
 * how a control plane holding five Running pods got reclaimed by a prune that called it
 * empty.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ConflictError,
  CreateFailedError,
  DockerError,
  NotFoundError,
} from '../../../src/lib/errors';
import type { Event } from '../../../src/lib/events';
import { updateConfig } from '../../../src/lib/config';
import { grant } from '../../../src/lib/onboarding';
import { installTeamModeProbe } from '../../../src/lib/teammode';
import type { KubectlResult } from '../../../src/seams/kubectl';

import { clusterReclaimable, deleteCluster } from '../../../src/core/kube/cluster';
import {
  endpointString,
  hostPortClaim,
  ingressEndpoint,
  kindNodeContainer,
  loadbalancerService,
  loadbalancerState,
  nodeAddress,
  portClaimingCluster,
  waitForLoadbalancer,
} from '../../../src/core/kube/endpoints';
import { kube } from '../../../src/core/kube/exec';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import {
  CLUSTER_NAME,
  CONTEXT,
  OWNER_LABEL_KEY,
  OWNER_OF_LABEL,
  OWNER_SELECTOR,
  WORKSPACE_LABEL,
} from '../../../src/core/kube/names';
import {
  assertNamespaceAvailable,
  deleteNamespace,
  ensureNamespace,
  labelsFor,
  namespaceLabels,
  namespaceOwner,
  waitNamespaceGone,
  workspacePvcs,
} from '../../../src/core/kube/namespace';
import { preflight as probePreflight, skew } from '../../../src/core/kube/probe';
import {
  SCALE_ANNOTATION,
  desiredReplicas,
  mongoPodsTheOperatorKeeps,
  startWorkspace,
  stopWorkspace,
} from '../../../src/core/kube/scale';
import {
  podRow,
  terminalPodFailure,
  workloadExists,
  workspaceReady,
} from '../../../src/core/kube/status';
import { makeTool, newEnough } from '../../../src/core/kube/tools';

const realRun = kube.run;

type Rule = [(argv: readonly string[]) => boolean, Partial<KubectlResult>];

let seen: string[][] = [];
let inputs: (string | undefined)[] = [];

function script(rules: Rule[], fallback: Partial<KubectlResult> = {}): void {
  seen = [];
  inputs = [];
  kube.run = (argv, options) => {
    seen.push([...argv]);
    inputs.push(options?.input);
    const hit = rules.find(([matches]) => matches(argv));
    return Promise.resolve({
      argv,
      returncode: 0,
      stdout: '',
      stderr: '',
      ...(hit === undefined ? fallback : hit[1]),
    });
  };
}

const has =
  (...needles: string[]) =>
  (argv: readonly string[]) =>
    needles.every((needle) => argv.includes(needle));

const json = (value: unknown) => ({ stdout: JSON.stringify(value) });

const REFUSED = {
  returncode: 1,
  stderr: 'error: You must be logged in to the server (Unauthorized)',
};

const sleep = () => Promise.resolve();

function namespaceDoc(
  name: string,
  labels = labelsFor(name),
  uid = 'original-namespace-uid',
  resourceVersion = '1',
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: `houston-${name}`, uid, resourceVersion, labels },
  };
}

afterEach(() => {
  kube.run = realRun;
});

describe('the namespace', () => {
  it('raises rather than answering "not there" when the cluster would not say', async () => {
    // A wrong kube-context, an expired credential or an RBAC denial all produce the second
    // while looking like the first, and only one of them is safe to act on.
    script([], REFUSED);
    await expect(namespaceLabels('houston-x', { context: 'prod' })).rejects.toBeInstanceOf(
      DockerError,
    );
    // Absent is a fact the cluster asserted.
    script([], { stdout: '' });
    expect(await namespaceLabels('houston-x', { context: 'prod' })).toBeNull();
    script([], json({ metadata: { labels: { [OWNER_LABEL_KEY]: 'houston' } } }));
    expect(await namespaceLabels('houston-x', { context: 'prod' })).toEqual({
      [OWNER_LABEL_KEY]: 'houston',
    });
  });

  it('separates "names nobody" from "could not be read", because prune deletes', async () => {
    script([], json({ metadata: { labels: { [OWNER_LABEL_KEY]: 'houston' } } }));
    expect(await namespaceOwner('houston-x', { context: 'prod' })).toBe('');
    script([], REFUSED);
    expect(await namespaceOwner('houston-x', { context: 'prod' })).toBeNull();
    // A namespace that is GONE answers '' rather than null: nobody owns one that does not
    // exist, and deleting it is a no-op, so it must not block a sweep.
    script([], { stdout: '' });
    expect(await namespaceOwner('houston-x', { context: 'prod' })).toBe('');
  });

  it('refuses a namespace houston did not label, and one another workspace holds', async () => {
    const unlabelled = () => assertNamespaceAvailable('x', { context: 'prod' });
    script([], json({ metadata: { labels: {} } }));
    await expect(unlabelled()).rejects.toThrow(/not managed by houston/u);

    script(
      [],
      json({ metadata: { labels: { [OWNER_LABEL_KEY]: 'houston', [WORKSPACE_LABEL]: 'other' } } }),
    );
    await expect(unlabelled()).rejects.toThrow(/belongs to houston workspace 'other'/u);
  });

  it('refuses a Terminating namespace at the PREFLIGHT, not eight steps later', async () => {
    // A Terminating namespace still carries its labels, so an ownership-only check passed
    // and the create died later on "unable to create new content in namespace X because it
    // is being terminated" -- at exit 7, holding a host port.
    script(
      [],
      json({
        metadata: { labels: { [OWNER_LABEL_KEY]: 'houston', [WORKSPACE_LABEL]: 'x' } },
        status: { phase: 'Terminating' },
      }),
    );
    await expect(assertNamespaceAvailable('x', { context: 'prod' })).rejects.toThrow(
      /still Terminating/u,
    );
  });

  it('says the right thing about a namespace another person owns', async () => {
    const held = json({
      metadata: {
        labels: { [OWNER_LABEL_KEY]: 'houston', [WORKSPACE_LABEL]: 'x', [OWNER_OF_LABEL]: 'bob' },
      },
    });
    // Not knowing who you are is not evidence that you are the owner.
    script([], held);
    const restore = installTeamModeProbe(() => true);
    try {
      await expect(assertNamespaceAvailable('x', { context: 'prod' })).rejects.toThrow(
        /HOUSTON_USER is not set/u,
      );
      // With a name, the remedy is to claim it.
      await expect(
        assertNamespaceAvailable('x', { context: 'prod', owner: 'alice' }),
      ).rejects.toThrow(/HOUSTON_USER=bob/u);
    } finally {
      restore();
    }

    // TEAM MODE OFF IS NOT THE SAME AS THE VARIABLE BEING UNSET: saying the wrong one made
    // the namespace permanently un-adoptable, because the remedy it named produced the
    // identical refusal.
    const offRestore = installTeamModeProbe(() => false);
    try {
      await expect(assertNamespaceAvailable('x', { context: 'prod' })).rejects.toThrow(
        /no houston accounts/u,
      );
    } finally {
      offRestore();
    }
  });

  it('creates with ownership labels atomically, and fails loudly if creation is refused', async () => {
    script([[has('create'), { returncode: 1, stderr: 'error: forbidden' }]], { stdout: '' });
    await expect(ensureNamespace('x', { context: 'prod' })).rejects.toBeInstanceOf(
      CreateFailedError,
    );
    script([[has('create'), json(namespaceDoc('x'))]], { stdout: '' });
    const events: Event[] = [];
    expect(await ensureNamespace('x', { context: 'prod', emit: (ev) => events.push(ev) })).toBe(
      'houston-x',
    );
    expect(seen.at(-1)).toEqual([
      'kubectl',
      '--context',
      'prod',
      'create',
      '-f',
      '-',
      '-o',
      'json',
    ]);
    expect(JSON.parse(inputs.at(-1) ?? '{}').metadata.labels).toEqual(labelsFor('x'));
    expect(seen.some((argv) => argv.includes('label'))).toBe(false);
  });

  it('treats a namespace that is already gone as removed, not as unconfirmed', async () => {
    // ABSENT IS THE MOST CONFIRMED-GONE STATE THERE IS, and returning false for it made a
    // Kubernetes record whose namespace had been removed immortal: `down --volumes`
    // refused it every time, for ever.
    script([], { stdout: '' });
    expect(await deleteNamespace('x', { context: 'prod', sleep })).toBe(true);
  });

  it('takes down MongoDB by name and leaves the presets’ Services where they are', async () => {
    // The owner label is on every preset object too, so deleting Services by it took the
    // presets' Services while their Deployments ran on. `up` made them anew at new
    // addresses, and the minio-ui nginx went on proxying to the old one: /minio/ timed out
    // after `down` and `up`, seen live on a k3s lane.
    script([[has('get', 'namespace'), json(namespaceDoc('x'))]]);
    expect(await deleteNamespace('x', { context: 'prod', sleep })).toBe(true);
    const removed = seen.find((argv) => argv.includes('delete')) ?? [];
    // Houston's own MongoDB only: the owner label, narrowed to its name.
    expect(removed).toEqual(
      expect.arrayContaining(['-l', OWNER_SELECTOR, '--field-selector', 'metadata.name=mongodb']),
    );
  });

  it('refuses to delete a namespace that is not labelled as houston’s', async () => {
    script([], json(namespaceDoc('x', { team: 'platform' })));
    await expect(deleteNamespace('x', { context: 'prod', sleep })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('keeps the local record when it cannot confirm the namespace is gone', async () => {
    // `--wait=false` returned instantly and `down` said "removed" while the namespace was
    // still Terminating, so a later `up` could race a half-deleted namespace.
    let asked = 0;
    kube.run = (argv) => {
      if (argv.includes('delete'))
        return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
      if (argv.includes('get') && argv.includes('namespace')) {
        asked += 1;
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: JSON.stringify(namespaceDoc('x')),
          ...{ stderr: '' },
        });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    const events: Event[] = [];
    expect(
      await deleteNamespace('x', {
        context: 'prod',
        volumes: true,
        sleep,
        emit: (ev) => events.push(ev),
      }),
    ).toBe(false);
    expect(asked).toBeGreaterThan(1);
    expect(events.some((ev) => ev.level === 'warn')).toBe(true);
  }, 30_000);

  it('does not report a namespace still terminating as gone', async () => {
    script([], json({ metadata: {}, status: { phase: 'Terminating' } }));
    expect(await waitNamespaceGone('houston-x', { context: 'prod', sleep })).toBe(false);
    script([], { stdout: '' });
    expect(await waitNamespaceGone('houston-x', { context: 'prod', sleep })).toBe(true);
  }, 30_000);

  it('refuses a namespace it did not make at create time, and reuses its own without re-creating it', async () => {
    // `ensureNamespace` ran `create` and then `label --overwrite` whatever was there, which
    // stamped houston's ownership onto a namespace it did not make -- after which
    // `down --volumes` deletes it and its volumes. The realistic trigger is two houston
    // users on one adopted cluster; the namespace's labels are the only evidence there is.
    const labelled = { [OWNER_LABEL_KEY]: 'houston', [WORKSPACE_LABEL]: 'mine' };
    const labelsAre = (labels: Record<string, string>) =>
      script([[has('get', 'namespace'), json(namespaceDoc('mine', labels))]]);

    labelsAre({});
    await expect(ensureNamespace('mine', { context: 'c' })).rejects.toThrow(
      /not managed by houston[\s\S]*kubectl delete namespace/u,
    );
    labelsAre({ ...labelled, [WORKSPACE_LABEL]: 'theirs' });
    await expect(ensureNamespace('mine', { context: 'c' })).rejects.toThrow(/'theirs'/u);
    labelsAre({ ...labelled, [OWNER_OF_LABEL]: 'bob' });
    await expect(ensureNamespace('mine', { context: 'c', owner: 'alice' })).rejects.toThrow(/bob/u);

    // Ours, this workspace: reused, and never re-created.
    labelsAre(labelled);
    expect(await ensureNamespace('mine', { context: 'c' })).toBe('houston-mine');
    expect(seen.some((argv) => argv.includes('create'))).toBe(false);
    expect(seen.some((argv) => argv.includes('label'))).toBe(false);
  });

  it('refuses to guess about a namespace it could not ask for, and deletes nothing on that answer', async () => {
    // `workspaceNamespaces()` returned [] both for nothing-there and for could-not-ask,
    // and `deleteNamespace` read the second as the first -- so an RBAC denial reported
    // "nothing to remove" and the caller deleted the local record over a live namespace.
    script([], {
      returncode: 1,
      stderr: 'Error from server (NotFound): namespaces "houston-x" not found',
    });
    expect(await namespaceLabels('houston-x', { context: 'c' })).toBeNull();

    script([], { returncode: 1, stderr: 'Unable to connect to the server: dial tcp: i/o timeout' });
    await expect(namespaceLabels('houston-x', { context: 'c' })).rejects.toThrow(
      /refusing to guess/u,
    );
    await expect(
      deleteNamespace('x', { context: 'c', volumes: true, sleep }),
    ).rejects.toBeInstanceOf(DockerError);
    expect(seen.some((argv) => argv.includes('delete'))).toBe(false);
  });

  /** A houston namespace that is found, deleted, and then answered for by `after`. */
  function deletedNamespace(after: Partial<KubectlResult>): void {
    let asked = 0;
    seen = [];
    kube.run = (argv) => {
      seen.push([...argv]);
      const reply = (value: Partial<KubectlResult>) =>
        Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '', ...value });
      if (argv.includes('delete')) return reply({});
      if (argv.includes('pvc')) return reply({ stdout: 'persistentvolumeclaim/data-x-0\n' });
      if (argv.includes('get') && argv.includes('namespace')) {
        asked += 1;
        // The first read is the ownership check, before anything is deleted.
        return reply(asked === 1 ? json(namespaceDoc('x')) : after);
      }
      return reply({});
    };
  }

  it('does not read a cluster that stopped answering as a deleted namespace', async () => {
    // The wait loop read `returncode != 0` as "gone", so ONE transient API error made
    // `down --volumes` announce a deletion that had not happened and drop the record.
    // kubectl exits 1 for an absent namespace AND for a context that does not exist, so
    // absence has to come from the payload.
    deletedNamespace({
      returncode: 1,
      stderr: 'Unable to connect to the server: dial tcp: i/o timeout',
    });
    const said: string[] = [];
    expect(
      await deleteNamespace('x', {
        context: 'c',
        volumes: true,
        sleep,
        emit: (ev) => said.push(ev.message),
      }),
    ).toBe(false);
    const joined = said.join(' ');
    expect(joined).toContain('could not confirm');
    expect(joined).toContain('record is KEPT');
    // A DIFFERENT SENTENCE from the Terminating case, because the remedy differs: one says
    // wait, this one says go and look at your cluster.
    expect(joined).not.toContain('still terminating');
  }, 30_000);

  it('keeps the record of a namespace still terminating, and says to wait', async () => {
    // True is read as "confirmed absent", so returning it for a Terminating namespace made
    // the caller delete the record and tear down the shared operator and monitoring stack
    // over a namespace whose finalizers could wedge indefinitely.
    deletedNamespace(json({ metadata: { name: 'houston-x' }, status: { phase: 'Terminating' } }));
    const said: string[] = [];
    expect(
      await deleteNamespace('x', {
        context: 'c',
        volumes: true,
        sleep,
        emit: (ev) => said.push(ev.message),
      }),
    ).toBe(false);
    const joined = said.join(' ');
    expect(joined).toContain('still terminating');
    expect(joined).toContain('record is KEPT');
  }, 30_000);

  it('lets the owner in, and names a remedy that works on a box with no accounts', async () => {
    // The owner comparison skipped an EMPTY owner, and the CLI actor is '' until accounts
    // exist -- so on a plain CLI box the check could not fire, and a namespace labelled
    // `owner=bob` was adopted. The remedy it names must be one that actually works there.
    const labels = {
      [OWNER_LABEL_KEY]: 'houston',
      [WORKSPACE_LABEL]: 'w',
      [OWNER_OF_LABEL]: 'bob',
    };
    const nsDoc = (phase: string) =>
      json({ metadata: { name: 'houston-w', labels }, status: { phase } });
    const noAccounts = installTeamModeProbe(() => false);
    try {
      script([], nsDoc('Active'));
      await expect(assertNamespaceAvailable('w', { context: 'c' })).rejects.toThrow(
        /no houston accounts[\s\S]*houston users add bob[\s\S]*HOUSTON_USER=bob/u,
      );
      await expect(
        assertNamespaceAvailable('w', { context: 'c', owner: 'alice' }),
      ).rejects.toBeInstanceOf(ConflictError);
      // bob himself is fine.
      await expect(assertNamespaceAvailable('w', { context: 'c', owner: 'bob' })).resolves.toBe(
        undefined,
      );
      // And bob's namespace still going away is refused for a DIFFERENT reason, with a
      // different remedy: waiting, not identifying yourself.
      script([], nsDoc('Terminating'));
      await expect(assertNamespaceAvailable('w', { context: 'c', owner: 'bob' })).rejects.toThrow(
        /Terminating/u,
      );
    } finally {
      noAccounts();
    }
  });

  it('counts volumes for a message and says nothing on a refused read', async () => {
    script([], { stdout: 'persistentvolumeclaim/data-mongodb-0\n' });
    expect(await workspacePvcs('x', { context: 'prod' })).toEqual(['data-mongodb-0']);
    // EVERY claim in the workspace's own namespace: the MongoDB operator's carry its labels,
    // not houston's, and an operator workspace's teardown said "0 volume(s)" deleting two.
    expect(seen.at(-1)).not.toContain('-l');
    script([], { returncode: 1 });
    expect(await workspacePvcs('x', { context: 'prod' })).toEqual([]);
  });
});

describe('F1 namespace isolation regressions', () => {
  it.each<{ why: string; labels: Record<string, string> }>([
    { why: 'another workspace', labels: { ...labelsFor('x'), [WORKSPACE_LABEL]: 'foreign' } },
    { why: 'another owner', labels: { ...labelsFor('x'), [OWNER_OF_LABEL]: 'foreign' } },
    { why: 'unattributed workspace', labels: { [OWNER_LABEL_KEY]: 'houston' } },
  ])('F1 keeps a managed namespace attributed to $why', async ({ labels }) => {
    script([[has('get', 'namespace'), json(namespaceDoc('x', labels))]]);
    await expect(
      deleteNamespace('x', { context: 'prod', volumes: true, sleep }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(seen.some((argv) => argv.includes('delete'))).toBe(false);
  });

  it('F1 keeps a same-owner same-workspace replacement with a different recorded UID', async () => {
    await writeRecord('x', metadata({ name: 'x', extra: { namespace_uid: 'recorded-uid' } }));
    script([[has('get', 'namespace'), json(namespaceDoc('x', labelsFor('x'), 'replacement-uid'))]]);
    await expect(deleteNamespace('x', { context: 'prod', volumes: true, sleep })).rejects.toThrow(
      /different UID/u,
    );
    expect(seen.some((argv) => argv.includes('delete'))).toBe(false);
  });

  it.each([
    ['UID', 'replacement-uid', '1'],
    ['resource version', 'original-namespace-uid', '2'],
  ])(
    'F1 API preconditions preserve a namespace whose %s changed after the read',
    async (_why, currentUid, currentVersion) => {
      await writeRecord(
        'x',
        metadata({
          name: 'x',
          extra: { namespace_owner: '', namespace_uid: 'original-namespace-uid' },
        }),
      );
      let sentinelPresent = true;
      kube.run = async (argv, options) => {
        const res = { argv, returncode: 0, stdout: '', stderr: '' };
        if (argv.includes('get') && argv.includes('namespace')) {
          return { ...res, stdout: JSON.stringify(namespaceDoc('x')) };
        }
        if (argv.includes('delete')) {
          const body = options?.input === undefined ? null : JSON.parse(options.input);
          if (
            argv.includes('--raw') &&
            (body?.preconditions?.uid !== currentUid ||
              body?.preconditions?.resourceVersion !== currentVersion)
          ) {
            return {
              ...res,
              returncode: 1,
              stderr: 'Error from server (Conflict): precondition failed',
            };
          }
          sentinelPresent = false;
        }
        return res;
      };
      await expect(deleteNamespace('x', { context: 'prod', volumes: true, sleep })).rejects.toThrow(
        /precondition failed/u,
      );
      expect(sentinelPresent).toBe(true);
    },
  );

  it('F1 refuses a failed create without taking over the concurrently created namespace', async () => {
    let foreignOwner = 'foreign';
    kube.run = async (argv) => {
      const res = { argv, returncode: 0, stdout: '', stderr: '' };
      if (argv.includes('create')) {
        return {
          ...res,
          returncode: 1,
          stderr: 'Error from server (AlreadyExists): namespace exists',
        };
      }
      if (argv.includes('label')) foreignOwner = '';
      return res;
    };
    await expect(ensureNamespace('x', { context: 'prod' })).rejects.toThrow(/AlreadyExists/u);
    expect(foreignOwner).toBe('foreign');
  });

  it('F1 preserves namespace identity across a local handover and re-up', async () => {
    await writeRecord(
      'x',
      metadata({
        name: 'x',
        extra: {
          created_by: 'alice',
          owner: 'bob',
          namespace_owner: 'alice',
          namespace_uid: 'original-namespace-uid',
        },
      }),
    );
    let namespacePresent = true;
    kube.run = async (argv) => {
      let stdout = '';
      if (argv.includes('get') && argv.includes('namespace') && namespacePresent) {
        stdout = JSON.stringify(namespaceDoc('x', labelsFor('x', 'alice')));
      }
      if (argv.includes('delete')) namespacePresent = false;
      return { argv, returncode: 0, stderr: '', stdout };
    };
    await expect(assertNamespaceAvailable('x', { context: 'prod', owner: 'bob' })).resolves.toBe(
      undefined,
    );
    const receipt = { uid: '', owner: '', createdUid: '' };
    await expect(ensureNamespace('x', { context: 'prod', owner: 'bob', receipt })).resolves.toBe(
      'houston-x',
    );
    expect(receipt).toEqual({ uid: 'original-namespace-uid', owner: 'alice', createdUid: '' });
    await expect(deleteNamespace('x', { context: 'prod', volumes: true, sleep })).resolves.toBe(
      true,
    );
  });

  it('F1 refuses a malformed namespace identity before deleting anything', async () => {
    script([
      [has('get', 'namespace'), json({ metadata: { name: 'houston-x', labels: labelsFor('x') } })],
    ]);
    await expect(deleteNamespace('x', { context: 'prod', volumes: true, sleep })).rejects.toThrow(
      /refusing to guess/u,
    );
    expect(seen.some((argv) => argv.includes('delete'))).toBe(false);
  });
});

describe('the workload', () => {
  it('asks every pod, not items[0], and not just the monolith container', async () => {
    // items[0] is ONE pod: with --replicas 3 the workspace was called ready on the
    // strength of the first. And ddp-streamer carries the WebSocket, so a workspace
    // reported as serving had messages not arriving.
    script(
      [],
      json({
        items: [
          { status: { containerStatuses: [{ ready: true }] } },
          { status: { containerStatuses: [{ ready: false }] } },
        ],
      }),
    );
    expect(await workspaceReady('x', { context: 'prod' })).toBe(false);

    script(
      [],
      json({
        items: [
          { status: { containerStatuses: [{ ready: true }] } },
          { status: { containerStatuses: [{ ready: true }] } },
        ],
      }),
    );
    expect(await workspaceReady('x', { context: 'prod' })).toBe(true);

    // A Pending pod has no containerStatuses at all, so counting is what keeps "no
    // statuses yet" from passing as "nothing failed".
    script([], json({ items: [{ status: {} }] }));
    expect(await workspaceReady('x', { context: 'prod' })).toBe(false);
    script([], json({ items: [] }));
    expect(await workspaceReady('x', { context: 'prod' })).toBe(false);
  });

  it('reports a waiting reason over the phase, and reads init containers too', () => {
    // A pod whose INIT container is in CrashLoopBackOff reports phase Pending and an EMPTY
    // containerStatuses, so reading only the main list showed "0/0 ready" and named nothing.
    const row = podRow({
      metadata: { name: 'mongodb-0', labels: {} },
      status: {
        phase: 'Pending',
        initContainerStatuses: [
          { state: { waiting: { reason: 'CreateContainerConfigError' } }, restartCount: 2 },
        ],
        containerStatuses: [],
      },
    });
    expect(row.status).toBe('CreateContainerConfigError · 2 restarts');
    expect(row.blocked).toBe(true);
    expect(row.state).toBe('pending');
    expect(row.health).toBe('');

    // A terminated init container that SUCCEEDED is not a reason -- reporting "Completed"
    // as the pod's status hid a Rocket.Chat container that was crash-looping behind it.
    const healthy = podRow({
      metadata: { name: 'rc-1', labels: { 'app.kubernetes.io/name': 'rocketchat' } },
      status: {
        phase: 'Running',
        initContainerStatuses: [{ state: { terminated: { reason: 'Completed' } } }],
        containerStatuses: [{ ready: true, restartCount: 0 }],
      },
    });
    expect(healthy.status).toBe('1/1 ready');
    expect(healthy.health).toBe('healthy');
    expect(healthy.app).toBe(true);
    expect(healthy.blocked).toBe(false);
  });

  it('names the first condition that cannot succeed, and waits otherwise', async () => {
    script(
      [],
      json({
        items: [
          {
            metadata: { name: 'rc-1' },
            status: {
              containerStatuses: [
                { state: { waiting: { reason: 'ImagePullBackOff', message: 'manifest unknown' } } },
              ],
            },
          },
        ],
      }),
    );
    expect(await terminalPodFailure('x', { context: 'prod' })).toEqual([
      'rc-1',
      'ImagePullBackOff',
      'manifest unknown',
    ]);

    // The default has to be patience, or a slow pull becomes a failed create.
    script(
      [],
      json({
        items: [
          {
            metadata: { name: 'rc-1' },
            status: {
              containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }],
            },
          },
        ],
      }),
    );
    expect(await terminalPodFailure('x', { context: 'prod' })).toBeNull();
  });

  it('raises rather than reporting a live workspace as prunable', async () => {
    // This returned `rc == 0 and stdout`, so a wrong context or an RBAC denial read as
    // "the workload is not there" -- and prunable() listed a workspace that was serving
    // 200 at the time under "will be deleted, containers, data volumes and records".
    script([], REFUSED);
    await expect(workloadExists('x', { context: 'prod' })).rejects.toBeInstanceOf(DockerError);
    script([], { stdout: '' });
    expect(await workloadExists('x', { context: 'prod' })).toBe(false);
    script([], json({ kind: 'Deployment' }));
    expect(await workloadExists('x', { context: 'prod' })).toBe(true);
  });
});

describe('scaling', () => {
  it('records the replica counts BEFORE scaling, or it records the zero it just wrote', async () => {
    let annotated = '';
    kube.run = (argv) => {
      if (argv.includes('annotate')) {
        annotated = argv.find((arg) => arg.startsWith(SCALE_ANNOTATION)) ?? '';
        return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
      }
      if (argv.includes('get') && argv.includes('deployment,statefulset')) {
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: 'deployment.apps/rc\nstatefulset.apps/mongodb\n',
          stderr: '',
        });
      }
      if (argv.includes('jsonpath={.spec.replicas}')) {
        return Promise.resolve({ argv, returncode: 0, stdout: '2', stderr: '' });
      }
      if (argv.includes('mongodbcommunity')) {
        return Promise.resolve({ argv, returncode: 1, stdout: '', stderr: '' });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    expect(await stopWorkspace('x', { context: 'prod', sleep })).toBe(2);
    // Spaced as earlier releases write JSON: the annotation is cluster state earlier releases
    // read back, and an earlier version of this build wrote it compact.
    expect(annotated).toBe(
      `${SCALE_ANNOTATION}={"deployment.apps/rc": "2", "statefulset.apps/mongodb": "2"}`,
    );
  }, 30_000);

  it('reads the annotation back as JSON, because jsonpath silently matched nothing', async () => {
    // The key is `houston.io/replicas-before-stop` and the code escaped the SLASH while
    // leaving the DOT unescaped, so jsonpath read two path segments and returned empty.
    // Every stop/start restored the DEFAULT of 1, turning a --replicas 2 workspace into a
    // one-replica one, and the annotation written to prevent that was never read back.
    const scaled: string[] = [];
    kube.run = (argv) => {
      if (argv.includes('get') && argv.includes('deployment,statefulset')) {
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: 'deployment.apps/rc\nstatefulset.apps/mongodb\n',
          stderr: '',
        });
      }
      if (argv.includes('get') && argv.includes('namespace')) {
        return Promise.resolve({
          argv,
          returncode: 0,
          stderr: '',
          stdout: JSON.stringify({
            metadata: {
              annotations: {
                [SCALE_ANNOTATION]: '{"deployment.apps/rc":"3","statefulset.apps/mongodb":"1"}',
              },
            },
          }),
        });
      }
      if (argv.includes('scale')) {
        scaled.push(`${argv[argv.indexOf('scale') + 1] ?? ''} ${argv.at(-1) ?? ''}`);
        return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
      }
      if (argv.includes('mongodbcommunity')) {
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: 'mongodbcommunity/mongodb\n',
          stderr: '',
        });
      }
      // An operator-managed MongoDB, so the replica set is the operator's to initiate and
      // `startWorkspace` must not run its own initiation -- which is also what keeps this
      // test off the real-clock wait that function would otherwise enter.
      if (argv.includes('pods')) {
        return Promise.resolve({ argv, returncode: 0, stdout: 'pod/mongodb-0\n', stderr: '' });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    expect(await startWorkspace('x', { context: 'prod' })).toBe(2);
    // MongoDB first, and each workload back to the number it had.
    expect(scaled).toEqual([
      '--replicas=1 statefulset.apps/mongodb',
      '--replicas=3 deployment.apps/rc',
    ]);
  }, 30_000);

  it('refuses to scale a workspace that was downed', async () => {
    script([], { stdout: '' });
    await expect(stopWorkspace('x', { context: 'prod', sleep })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('says MongoDB stays up when the operator keeps it, and does not wait for it to go', async () => {
    // An operator-managed MongoDB cannot be scaled to zero: the operator reconciles it
    // straight back and cannot be paused. So `stop` gave back Rocket.Chat's memory and not
    // MongoDB's while saying nothing, and its wait for EVERY pod to go burned the whole
    // budget on a pod that was never going to leave.
    const cluster = ({ operator, pods }: { operator: boolean; pods: string[] }) =>
      script([
        [
          has('mongodbcommunity'),
          operator
            ? { stdout: 'mongodbcommunity.mongodbcommunity.mongodb.com/mongodb\n' }
            : { returncode: 1 },
        ],
        [
          has('get', 'deployment,statefulset'),
          { stdout: 'deployment.apps/rc\nstatefulset.apps/mongodb\n' },
        ],
        [has('jsonpath={.spec.replicas}'), { stdout: '1' }],
        [
          (argv) => argv.includes('pods') && argv.includes('-l'),
          { stdout: pods.filter((pod) => pod.includes('mongodb')).join(' ') },
        ],
        [has('get', 'pods'), { stdout: pods.join(' ') }],
      ]);

    cluster({ operator: true, pods: ['pod/mongodb-0'] });
    expect([...(await mongoPodsTheOperatorKeeps('w', { context: 'c' }))]).toEqual([
      'pod/mongodb-0',
    ]);
    const slept: number[] = [];
    const events: Event[] = [];
    await stopWorkspace('w', {
      context: 'c',
      emit: (ev) => events.push(ev),
      sleep: (seconds) => {
        slept.push(seconds);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([]);
    const warned = events
      .filter((ev) => ev.level === 'warn')
      .map((ev) => ev.message)
      .join(' ');
    expect(warned).toContain('MongoDB stays up');
    expect(warned).toContain('--volumes');

    // The hand-written StatefulSet does scale to zero; nothing is claimed about it.
    cluster({ operator: false, pods: [] });
    expect((await mongoPodsTheOperatorKeeps('w', { context: 'c' })).size).toBe(0);
    events.length = 0;
    await stopWorkspace('w', { context: 'c', emit: (ev) => events.push(ev), sleep });
    expect(events.filter((ev) => ev.level === 'warn')).toEqual([]);
  }, 30_000);

  it('reads the DESIRED replica count, so a stop reads as stopped immediately', async () => {
    script([], { stdout: '0' });
    expect(await desiredReplicas('x', { context: 'prod' })).toBe(0);
    script([], { stdout: '' });
    expect(await desiredReplicas('x', { context: 'prod' })).toBe(-1);
  });
});

describe('the cluster houston owns', () => {
  // `which` is pure fs over `process.env.PATH`, so a fake `kind` on PATH is enough to
  // reach the guards below. Without it every one of them short-circuits on "kind is not
  // installed" and the test passes while asserting nothing -- this box has no kind.
  let kindDir = '';
  const realPath = process.env.PATH;

  beforeEach(() => {
    updateConfig((stored) => grant(stored, 'owned-cluster'));
    kindDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-kind-'));
    fs.writeFileSync(path.join(kindDir, 'kind'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${kindDir}${path.delimiter}${realPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = realPath;
    fs.rmSync(kindDir, { recursive: true, force: true });
  });

  it('will not call an unreachable cluster empty', async () => {
    // `prune` stated the cluster was "empty" and deleted it -- measured, with five Running
    // pods and an 8 Gi Bound PVC in it.
    script([
      [has('get', 'clusters'), { stdout: `${CLUSTER_NAME}\n` }],
      [
        has('get', 'configmap'),
        json({
          metadata: { labels: { [OWNER_LABEL_KEY]: 'houston' } },
          data: { cluster: CLUSTER_NAME },
        }),
      ],
      [has('current-context'), { stdout: `${CONTEXT}\n` }],
      [has('--raw'), { returncode: 1, stderr: 'connection refused' }],
    ]);
    expect(await clusterReclaimable()).toBe(false);
  });

  it('refuses to delete a cluster whose contents cannot be read', async () => {
    script([
      [has('get', 'clusters'), { stdout: `${CLUSTER_NAME}\n` }],
      [
        has('get', 'configmap'),
        json({
          metadata: { labels: { [OWNER_LABEL_KEY]: 'houston' } },
          data: { cluster: CLUSTER_NAME },
        }),
      ],
      [has('current-context'), { stdout: `${CONTEXT}\n` }],
      [has('--raw'), { returncode: 1, stderr: 'connection refused' }],
    ]);
    await expect(deleteCluster()).rejects.toThrow(/not answering/u);

    script([
      [has('get', 'clusters'), { stdout: `${CLUSTER_NAME}\n` }],
      [
        has('get', 'configmap'),
        json({
          metadata: { labels: { [OWNER_LABEL_KEY]: 'houston' } },
          data: { cluster: CLUSTER_NAME },
        }),
      ],
      [has('current-context'), { stdout: `${CONTEXT}\n` }],
      [has('--raw'), { stdout: 'ok' }],
      [has('namespace'), REFUSED],
    ]);
    await expect(deleteCluster()).rejects.toThrow(/could not be read/u);

    script([
      [has('get', 'clusters'), { stdout: `${CLUSTER_NAME}\n` }],
      [
        has('get', 'configmap'),
        json({
          metadata: { labels: { [OWNER_LABEL_KEY]: 'houston' } },
          data: { cluster: CLUSTER_NAME },
        }),
      ],
      [has('current-context'), { stdout: `${CONTEXT}\n` }],
      [has('--raw'), { stdout: 'ok' }],
      [has('namespace'), json({ items: [{ metadata: { name: 'houston-a' } }] })],
    ]);
    await expect(deleteCluster()).rejects.toThrow(/still holds 1 workspace/u);
  }, 60_000);

  /** houston's own cluster, answering or not, holding the namespaces named. */
  function ownCluster({ reachable, held }: { reachable: boolean; held: string[] }): void {
    script([
      [has('get', 'clusters'), { stdout: `${CLUSTER_NAME}\n` }],
      [
        has('get', 'configmap'),
        json({
          metadata: { labels: { [OWNER_LABEL_KEY]: 'houston' } },
          data: { cluster: CLUSTER_NAME },
        }),
      ],
      [has('current-context'), { stdout: `${CONTEXT}\n` }],
      [
        has('--raw'),
        reachable ? { stdout: 'ok' } : { returncode: 1, stderr: 'connection refused' },
      ],
      [has('namespace'), json({ items: held.map((name) => ({ metadata: { name } })) })],
    ]);
  }

  const deletedTheCluster = () =>
    seen.some((argv) => argv[0] === 'kind' && argv.includes('delete') && argv.includes('cluster'));

  it('names the workspaces a cluster still holds, and takes it anyway only when forced', async () => {
    // On a shared box the cluster holds other people's workspaces, and `prune` reclaiming it
    // mid-ticket is the failure this guards. Naming them is what makes the refusal
    // actionable.
    ownCluster({ reachable: true, held: ['houston-t1', 'houston-t2'] });
    await expect(deleteCluster()).rejects.toThrow(ConflictError);
    await expect(deleteCluster()).rejects.toThrow(/2 workspace namespace\(s\): houston-t1/u);
    expect(deletedTheCluster()).toBe(false);

    // --force takes it, because sometimes that is what you want.
    ownCluster({ reachable: true, held: ['houston-t1', 'houston-t2'] });
    expect(await deleteCluster({ force: true })).toBe(true);
    expect(deletedTheCluster()).toBe(true);
  }, 60_000);

  it('reclaims only a cluster it could read and found empty, and forces through a wedged one', async () => {
    // The ownership guard lived inside `reachable()`, so an unreachable cluster
    // skipped it and a paused control plane holding live workspaces was deleted by one
    // `prune --yes`. A cluster nobody can reach is the case houston knows LEAST about.
    ownCluster({ reachable: false, held: ['houston-victim'] });
    expect(await clusterReclaimable()).toBe(false);
    await expect(deleteCluster()).rejects.toThrow(/not answering/u);
    expect(deletedTheCluster()).toBe(false);

    // Empty but unreachable: still refused -- "empty" is not something we know.
    ownCluster({ reachable: false, held: [] });
    expect(await clusterReclaimable()).toBe(false);
    await expect(deleteCluster()).rejects.toBeInstanceOf(ConflictError);

    // Reachable and genuinely empty: the legitimate reclaim still works.
    ownCluster({ reachable: true, held: [] });
    expect(await clusterReclaimable()).toBe(true);
    expect(await deleteCluster()).toBe(true);
    expect(deletedTheCluster()).toBe(true);

    // Reachable and occupied: refused, naming what it holds.
    ownCluster({ reachable: true, held: ['houston-victim'] });
    await expect(deleteCluster()).rejects.toThrow(/still holds/u);

    // --force is still the way through a wedged one.
    ownCluster({ reachable: false, held: ['houston-victim'] });
    expect(await deleteCluster({ force: true })).toBe(true);
    expect(deletedTheCluster()).toBe(true);
  }, 60_000);
});

describe('where traffic arrives', () => {
  it('tells "no load balancer" apart from "no address yet"', async () => {
    // On EKS the second is the normal state for the first minute or two after a create, and
    // a caller that wanted to wait could not tell whether waiting had any point.
    script([], json({ items: [{ spec: { type: 'ClusterIP' } }] }));
    expect(await loadbalancerState('prod')).toEqual(['', '', 0]);

    script(
      [],
      json({
        items: [{ metadata: { name: 'traefik' }, spec: { type: 'LoadBalancer' }, status: {} }],
      }),
    );
    expect(await loadbalancerState('prod')).toEqual(['', '', 1]);

    // hostname is preferred explicitly: a CNAME target has to be a name, and where a
    // provider gives both the name is the stable one.
    script(
      [],
      json({
        items: [
          {
            metadata: { name: 'traefik' },
            spec: { type: 'LoadBalancer' },
            status: { loadBalancer: { ingress: [{ ip: '1.2.3.4', hostname: 'elb.example' }] } },
          },
        ],
      }),
    );
    expect(await loadbalancerState('prod')).toEqual(['traefik', 'elb.example', 0]);
  });

  it('names the hostname where a Service has both, and looks past an address-less entry', async () => {
    // The jsonpath this replaced interpolated ip and hostname adjacently, so a Service
    // carrying both -- dual-stack, some controllers -- yielded one nonsense string that went
    // out as a printed CNAME target somebody would paste into DNS.
    const lb = (name: string, ingress: Record<string, string>[], type = 'LoadBalancer') => ({
      metadata: { name },
      spec: { type },
      status: { loadBalancer: { ingress } },
    });
    script([], json({ items: [lb('both', [{ ip: '10.0.0.9', hostname: 'a.elb.aws' }])] }));
    expect(await loadbalancerService('c')).toEqual(['both', 'a.elb.aws']);
    script([], json({ items: [lb('k3s-ish', [{ ip: '172.16.0.2' }])] }));
    expect(await loadbalancerService('c')).toEqual(['k3s-ish', '172.16.0.2']);
    // An address-less entry first is not "a load balancer with no address" -- the old code
    // looked at `ingress[0]` and nothing else.
    script([], json({ items: [lb('late', [{}, { hostname: 'b.aws' }])] }));
    expect(await loadbalancerService('c')).toEqual(['late', 'b.aws']);
    // A ClusterIP is not a load balancer, whatever its status says.
    script([], json({ items: [lb('cip', [{ ip: '1.2.3.4' }], 'ClusterIP')] }));
    expect(await loadbalancerService('c')).toEqual(['', '']);
  });

  it('returns at once on a refused Service read, rather than waiting on it', async () => {
    // A refused read counts no pending Services, so the caller must not spend three
    // minutes on a cluster it could not read; the blank is the honest "no address".
    script([], REFUSED);
    expect(await loadbalancerState('c')).toEqual(['', '', 0]);
    const slept: number[] = [];
    expect(
      await waitForLoadbalancer('c', {
        sleep: (seconds) => {
          slept.push(seconds);
          return Promise.resolve();
        },
      }),
    ).toEqual(['', '']);
    expect(slept).toEqual([]);
  });

  it('waits for an address that is coming, and says so once', async () => {
    // `cluster prepare` runs straight after a twenty-minute create, and an ELB commonly
    // takes one to three minutes to publish a hostname -- so asking once made a blank CNAME
    // target the NORMAL outcome, on the one line an operator needs to finish the job.
    const pending = json({
      items: [{ metadata: { name: 'traefik' }, spec: { type: 'LoadBalancer' }, status: {} }],
    });
    const published = json({
      items: [
        {
          metadata: { name: 'traefik' },
          spec: { type: 'LoadBalancer' },
          status: { loadBalancer: { ingress: [{ hostname: 'a.elb.aws' }] } },
        },
      ],
    });
    const answers = [pending, pending, published];
    seen = [];
    kube.run = (argv) => {
      seen.push([...argv]);
      return Promise.resolve({ argv, returncode: 0, stderr: '', stdout: '', ...answers.shift() });
    };
    const slept: number[] = [];
    const said: string[] = [];
    expect(
      await waitForLoadbalancer('c', {
        emit: (ev) => said.push(ev.message),
        sleep: (seconds) => {
          slept.push(seconds);
          return Promise.resolve();
        },
      }),
    ).toEqual(['traefik', 'a.elb.aws']);
    // It must actually wait rather than spin -- and say so in one line, not one per tick.
    expect(slept).toHaveLength(2);
    expect(said.filter((message) => message.includes('waiting for'))).toHaveLength(1);
  });

  it('answers a NodePort as a real endpoint, on the node’s address', async () => {
    // Every LoadBalancer Service carries a nodePort anyway, so this is an answer rather
    // than a consolation -- and it is THE answer on a k3s cluster whose ingress was moved
    // off the host ports, which is what doctor tells a user to do when it takes :443.
    script([
      [
        has('svc'),
        json({
          items: [
            {
              metadata: { namespace: 'kube-system', name: 'traefik' },
              spec: { type: 'NodePort', ports: [{ port: 443, nodePort: 31123 }] },
            },
          ],
        }),
      ],
      [
        has('nodes'),
        json({
          items: [{ status: { addresses: [{ type: 'InternalIP', address: '127.0.0.1' }] } }],
        }),
      ],
    ]);
    expect(await ingressEndpoint('default')).toMatchObject({
      address: '127.0.0.1',
      port: 31123,
      source: 'nodeport',
      service: 'kube-system/traefik',
      local: true,
    });
  });

  it('asks for Services across every namespace, with -A after the subcommand', async () => {
    // Without `-A` kubectl reads the CURRENT namespace, so an ingress in kube-system is
    // invisible and the cluster reads as having none: exit 0, entirely believable. And
    // before `get` kubectl refuses it outright. Both were live bugs, in that order.
    script([], json({ items: [] }));
    await ingressEndpoint('default');
    const argv = seen[0] ?? [];
    expect(argv).toContain('-A');
    expect(argv.indexOf('-A')).toBeGreaterThan(argv.indexOf('get'));
  });

  it('stops waiting the moment nothing is pending', async () => {
    script([], json({ items: [] }));
    expect(await waitForLoadbalancer('prod', { sleep })).toEqual(['', '']);
    // One call, not sixty: spending three minutes proving there is no ingress would be the
    // slowest possible way to say it.
    expect(seen.length).toBe(1);
  }, 30_000);

  it('refuses to guess which of two Services fronts the ingress', async () => {
    // Picking the first would work on every cluster anybody has tested and silently serve
    // the wrong ingress on the one that matters.
    script(
      [],
      json({
        items: [
          {
            metadata: { namespace: 'a', name: 'one' },
            spec: { type: 'LoadBalancer', ports: [{ port: 443 }] },
          },
          {
            metadata: { namespace: 'b', name: 'two' },
            spec: { type: 'NodePort', ports: [{ port: 443, nodePort: 30443 }] },
          },
        ],
      }),
    );
    await expect(ingressEndpoint('prod')).rejects.toBeInstanceOf(ConflictError);
  });

  it('ignores a ClusterIP on 443, which cannot be a front door', async () => {
    // k3s answers with THREE Services on 443 and only traefik is the ingress; the other two
    // are ClusterIP, which is not merely unrouted from a container but unroutable.
    script(
      [],
      json({
        items: [
          {
            metadata: { namespace: 'default', name: 'kubernetes' },
            spec: { type: 'ClusterIP', ports: [{ port: 443 }] },
          },
          {
            metadata: { namespace: 'kube-system', name: 'metrics-server' },
            spec: { type: 'ClusterIP', ports: [{ port: 443 }] },
          },
          {
            metadata: { namespace: 'kube-system', name: 'traefik' },
            spec: { type: 'LoadBalancer', ports: [{ port: 443 }] },
            status: { loadBalancer: { ingress: [{ ip: '203.0.113.9' }] } },
          },
        ],
      }),
    );
    const endpoint = await ingressEndpoint('prod');
    expect(endpoint).toMatchObject({
      address: '203.0.113.9',
      port: 443,
      source: 'loadbalancer',
      service: 'kube-system/traefik',
      local: false,
    });
    expect(endpointString(endpoint!)).toBe('203.0.113.9:443');
  });

  it('answers null when the cluster HAS no ingress, and raises when it would not say', async () => {
    script([], json({ items: [] }));
    expect(await ingressEndpoint('prod')).toBeNull();
    script([], REFUSED);
    await expect(ingressEndpoint('prod')).rejects.toBeInstanceOf(DockerError);
  });

  it('reads an InternalIP for the NodePort case, and derives kind’s node container', async () => {
    script(
      [],
      json({
        items: [
          {
            status: {
              addresses: [
                { type: 'Hostname', address: 'node' },
                { type: 'InternalIP', address: '172.19.0.2' },
              ],
            },
          },
        ],
      }),
    );
    expect(await nodeAddress('prod')).toBe('172.19.0.2');
    expect(kindNodeContainer('kind-houston-local')).toBe('houston-local-control-plane');
    expect(kindNodeContainer('default')).toBe('');
  });
});

describe('the preflight doctor runs', () => {
  // A FAKE `kubectl` ON PATH, the way the cluster block above states `kind`.
  // `probe.preflight()` returns early when kubectl has no path, and this case used to get
  // past that line only because this machine has a real `/usr/local/bin/kubectl`: measured
  // on a PATH without it, the case failed. `test/testsetup-cloud.ts` now answers every tool
  // absent unless the test built a stand-in under the temp root -- so this one builds it.
  let kubectlDir = '';
  const realPath = process.env.PATH;

  beforeEach(() => {
    kubectlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-kubectl-'));
    fs.writeFileSync(path.join(kubectlDir, 'kubectl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${kubectlDir}${path.delimiter}${realPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = realPath;
    fs.rmSync(kubectlDir, { recursive: true, force: true });
  });

  it('records which facts were UNREADABLE rather than reporting them as empty', async () => {
    // A restricted kubeconfig can pass /readyz and then be refused every actual read, and
    // reporting those as "no StorageClass, no ingress, 0 nodes" made doctor state three
    // false facts under a green verdict.
    script(
      [
        [has('--raw'), { stdout: 'ok' }],
        [has('config', 'current-context'), { stdout: 'prod\n' }],
        [has('get', 'nodes'), REFUSED],
        [has('storageclass'), REFUSED],
        [has('ingressclass'), REFUSED],
        [has('namespace'), REFUSED],
      ],
      { returncode: 1, stderr: 'nope' },
    );
    const out = await probePreflight('prod');
    expect(out.context).toBe('prod');
    expect(out.clusterReachable).toBe(true);
    // FIXED order, so the report does not vary with which call returned first.
    expect(out.unreadable).toEqual(['storage', 'ingress', 'namespaces', 'nodes']);
    expect(out.storageClasses).toEqual([]);
    expect(out.nodeCount).toBe(0);
  }, 30_000);

  it('reads the host ports a local LoadBalancer actually takes', async () => {
    // (In this block because `portClaimingCluster` returns early on a box with no kubectl.)
    // The ports are the diagnosis: :443 taken breaks serving and TLS-ALPN, :80 taken
    // breaks HTTP-01. The detection reported ":443" whatever it found -- including on a box
    // configured for the http challenge, where :80 was the port that mattered.
    // 127.0.0.1 is an address this host holds; 203.0.113.9 (TEST-NET-3) is not.
    const svc = (
      name: string,
      namespace: string,
      addr: string,
      ports: number[],
      type = 'LoadBalancer',
    ) => ({
      metadata: { name, namespace },
      spec: { type, ports: ports.map((port) => ({ port })) },
      status: { loadBalancer: { ingress: addr === '' ? [] : [{ ip: addr }] } },
    });
    script(
      [],
      json({
        items: [
          // Skipped: a ClusterIP takes no host port however it is addressed.
          svc('kubernetes', 'default', '10.43.0.1', [443], 'ClusterIP'),
          // Skipped: a LoadBalancer nobody answered for holds nothing.
          svc('pending', 'apps', '', [80]),
          // Skipped: an address this host does not hold is somebody else's problem.
          svc('elsewhere', 'apps', '203.0.113.9', [80, 443]),
          svc('traefik', 'kube-system', '127.0.0.1', [443, 80]),
        ],
      }),
    );
    expect(await hostPortClaim('default')).toEqual({
      context: 'default',
      service: 'kube-system/traefik',
      address: '127.0.0.1',
      ports: [80, 443],
    });
    // Only :80 -- the case the old check called ":443".
    script([], json({ items: [svc('traefik', 'kube-system', '127.0.0.1', [80])] }));
    expect((await hostPortClaim('default'))?.ports).toEqual([80]);

    // A port set that does not overlap the edge's is not a conflict at all -- while :80
    // alone still is one.
    const holding = (ports: number[]) =>
      script([
        [has('--raw'), { stdout: 'ok' }],
        [
          has('svc'),
          json({
            items: [
              {
                metadata: { namespace: 'a', name: 'b' },
                spec: { type: 'LoadBalancer', ports: ports.map((port) => ({ port })) },
                status: { loadBalancer: { ingress: [{ ip: '127.0.0.1' }] } },
              },
            ],
          }),
        ],
      ]);
    holding([8080]);
    expect(await portClaimingCluster({ contexts: ['default'] })).toBeNull();
    holding([80]);
    expect((await portClaimingCluster({ contexts: ['default'] }))?.ports).toEqual([80]);
  });

  it('measures skew against the cluster, which a version floor cannot express', async () => {
    // A floor is a fact about houston (kubectl >= 1.21); skew is a fact about the cluster in
    // front of you. Launchpad builds clusters at 1.33, so a kubectl eleven minors PAST the
    // floor is still outside the supported ±1 window -- and passing the floor is exactly
    // what it would report doing.
    script([], json({ serverVersion: { gitVersion: 'v1.33.1' } }));
    expect(newEnough(makeTool({ name: 'kubectl', path: '/k', version: [1, 22] }))).toBe(true);
    expect(await skew('ctx', [1, 22])).toMatchObject({ ok: false, gap: 11 });
    // Inside the window, either side of it.
    expect((await skew('ctx', [1, 32]))?.ok).toBe(true);
    expect((await skew('ctx', [1, 34]))?.ok).toBe(true);
    expect((await skew('ctx', [1, 35]))?.ok).toBe(false);
    // A different MAJOR is not a near miss.
    expect((await skew('ctx', [2, 33]))?.ok).toBe(false);
    // Unreadable is null, not "fine": a skew nobody could measure is not a match.
    script([], { returncode: 1, stderr: 'forbidden' });
    expect(await skew('ctx', [1, 33])).toBeNull();
  });

  it('reports the client/server gap with both numbers, or nothing at all', async () => {
    script([], json({ serverVersion: { gitVersion: 'v1.33.4' } }));
    expect(await skew('prod', [1, 36, 3])).toEqual({
      client: [1, 36, 3],
      server: [1, 33, 4],
      gap: 3,
      ok: false,
    });
    expect(await skew('prod', [1, 34, 0])).toMatchObject({ gap: 1, ok: true });
    script([], { returncode: 1 });
    expect(await skew('prod', [1, 36, 3])).toBeNull();
  });
});
