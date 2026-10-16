import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';
import { setImmediate as yieldIo } from 'node:timers/promises';

import * as config from '../../../src/lib/config';
import {
  AuthorityGateError,
  ConflictError,
  CreateFailedError,
  DockerError,
} from '../../../src/lib/errors';
import type { Event } from '../../../src/lib/events';
import { grant, revoke } from '../../../src/lib/onboarding';
import { Interrupted } from '../../../src/seams/exec';
import type { KubectlResult } from '../../../src/seams/kubectl';

import { reproLock } from '../../../src/core/runner/locks';

import { workspaceNamespaces } from '../../../src/core/kube/capabilities';
import {
  CREATE_TIMEOUT,
  CLUSTER_LOCK,
  adoptIfUnmarked,
  deleteCluster,
  ensureCluster,
  ensureKubeconfig,
  ownedRuntimeState,
} from '../../../src/core/kube/cluster';
import { kube, ownedKubeconfig, type RunOptions } from '../../../src/core/kube/exec';
import { mongoManifest } from '../../../src/core/kube/manifests';
import {
  CHART,
  APPLY_TIMEOUT,
  CLUSTER_NAME,
  CLUSTER_OWNER_CONFIGMAP,
  CONTEXT,
  CORE_TOOLS,
  LOCAL_PROVISION_TOOLS,
  MONGO_SERVICE,
  MONGO_URL,
  NAMESPACE_PREFIX,
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
  OWNER_SELECTOR,
  PROVIDER_EXTERNAL,
  PROVIDER_ID_PREFIX,
  PROVIDER_KIND,
  RELEASE,
  WORKSPACE_LABEL,
  isOurs,
  mintNamespace,
  mongoImage,
  provisionTools,
  tools,
  tuning,
} from '../../../src/core/kube/names';
import { deleteNamespace } from '../../../src/core/kube/namespace';
import { preflight } from '../../../src/core/kube/probe';
import { RS_INITIATE, initReplicaSet } from '../../../src/core/kube/replicaset';

const realRun = kube.run;
const realPath = process.env.PATH;
const realTries = tuning.MONGO_READY_TRIES;

/** Every call the scripted funnel saw, with the options it was given. */
let calls: { argv: string[]; options: RunOptions }[] = [];

/** Script `kube.run`: a reply per call, or undefined for the fallback. */
function route(
  answer: (joined: string, argv: readonly string[]) => Partial<KubectlResult> | undefined,
  fallback: Partial<KubectlResult> = {},
): void {
  calls = [];
  kube.run = (argv, options = {}) => {
    calls.push({ argv: [...argv], options });
    return Promise.resolve({
      argv,
      returncode: 0,
      stdout: '',
      stderr: '',
      ...(answer(argv.join(' '), argv) ?? fallback),
    });
  };
}

/**
 * A scripted funnel: a substring of the joined argv per reply, in order; `helm list` reaches the
 * cluster unless a rule says otherwise; and anything unstubbed fails, so a probe nobody described
 * cannot quietly succeed.
 */
function fakeRun(mapping: [string, number, string][]): void {
  route((joined) => {
    if (
      joined.startsWith('helm list') &&
      !mapping.some(([needle]) => needle.includes('helm list'))
    ) {
      return { returncode: 0 };
    }
    for (const [needle, returncode, stdout] of mapping) {
      if (joined.includes(needle)) return { returncode, stdout };
    }
    return { returncode: 1, stderr: 'no stub' };
  });
}

/** Stand-ins for the named tools, first on PATH, in a directory this test owns. */
let toolDir = '';
function installTools(...names: string[]): void {
  if (toolDir !== '') fs.rmSync(toolDir, { recursive: true, force: true });
  toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-tools-'));
  for (const name of names) {
    fs.writeFileSync(path.join(toolDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  process.env.PATH = `${toolDir}${path.delimiter}${realPath ?? ''}`;
}

const sleep = () => Promise.resolve();

/** Drive collision polling on a monotonic clock without making the suite wait ten minutes. */
async function withCollisionClock<T>(
  operation: () => Promise<T>,
): Promise<{ value: T; elapsed: number }> {
  // Acquire and probe the real OS lock before virtual time can outrun Linux flock I/O.
  // ensureCluster reenters this same owner lock; its release occurs after real time returns.
  return await reproLock(CLUSTER_LOCK, async () => {
    jest.useFakeTimers();
    const started = performance.now();
    const outcome: { current: { value: T } | { error: unknown } | null } = { current: null };
    void operation().then(
      (value) => {
        outcome.current = { value };
      },
      (error: unknown) => {
        outcome.current = { error };
      },
    );
    try {
      for (
        let tick = 0;
        tick <= Math.ceil((CREATE_TIMEOUT * 1000) / 1000) + 1 && outcome.current === null;
        tick += 1
      ) {
        await jest.advanceTimersByTimeAsync(1000);
      }
      const settled = outcome.current;
      if (settled === null)
        throw new Error('the collision waiter did not settle before its deadline');
      if ('error' in settled) throw settled.error;
      return { value: settled.value, elapsed: performance.now() - started };
    } finally {
      jest.useRealTimers();
    }
  });
}

afterEach(() => {
  kube.run = realRun;
  tuning.MONGO_READY_TRIES = realTries;
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  if (toolDir !== '') fs.rmSync(toolDir, { recursive: true, force: true });
  toolDir = '';
});

/** The constants earlier releases published under the same names, recorded. */
const RECORDED: Record<string, unknown> = {
  CLUSTER_NAME: 'houston-local',
  CONTEXT: 'kind-houston-local',
  RELEASE: 'rocketchat',
  NAMESPACE_PREFIX: 'houston-',
  OWNER_LABEL_KEY: 'app.kubernetes.io/managed-by',
  OWNER_LABEL_VALUE: 'houston',
  OWNER_SELECTOR: 'app.kubernetes.io/managed-by=houston',
  CHART: 'rocketchat/rocketchat',
  MONGO_URL: 'mongodb://mongodb-0.mongodb:27017/rocketchat?replicaSet=rs0',
  CORE_TOOLS: { kubectl: [1, 21], helm: [3, 0] },
  LOCAL_PROVISION_TOOLS: { kind: [0, 20] },
};

function ownedClusterMarker(): string {
  return JSON.stringify({
    metadata: { labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE } },
    data: { cluster: CLUSTER_NAME },
  });
}

describe('the vocabulary', () => {
  it('matches earlier releases constant for constant', () => {
    // The names ARE the contract: a workspace created by one release and torn down by
    // another has to agree about the namespace prefix, the owner label and the release
    // name, or the teardown selects nothing and leaves a cluster full of orphans.
    const recorded = RECORDED;
    const mine: Record<string, unknown> = {
      CLUSTER_NAME,
      CONTEXT,
      // `rocketchat`, as the official guide names it -- PR #3 called it `rc` -- so every
      // command copied from docs.rocket.chat works by substituting the namespace alone.
      RELEASE,
      NAMESPACE_PREFIX,
      OWNER_LABEL_KEY,
      OWNER_LABEL_VALUE,
      OWNER_SELECTOR,
      CHART,
      MONGO_URL,
    };
    for (const [name, value] of Object.entries(mine))
      expect([name, value]).toEqual([name, recorded[name]]);

    // And the tool floors, which decide what `doctor` refuses.
    expect(CORE_TOOLS).toEqual(recorded.CORE_TOOLS);
    expect(LOCAL_PROVISION_TOOLS).toEqual(recorded.LOCAL_PROVISION_TOOLS);
  });

  it('selects by LABEL, never by name prefix', () => {
    // Anyone can create a namespace called `houston-anything`, and a teardown that
    // matched on the prefix would eventually delete one houston never made.
    expect(OWNER_SELECTOR).toBe(`${OWNER_LABEL_KEY}=${OWNER_LABEL_VALUE}`);
    expect(mintNamespace('TICKET-1')).toBe('houston-TICKET-1');
    expect(isOurs(CONTEXT)).toBe(true);
    expect(isOurs('kind-somebody-elses')).toBe(false);
  });

  it('keeps the cloud provisioning registry separate from the local one', () => {
    // `canProvision` is an every() over LOCAL_PROVISION_TOOLS, so a second entry there
    // would make it false on every box that has kind and not the other tool. Adding one
    // to the cloud registry is not a breaking change; adding one here is.
    expect(Object.keys(LOCAL_PROVISION_TOOLS)).toEqual(['kind']);
    expect(Object.keys(tuning.CLOUD_PROVISION_TOOLS)).toEqual(['eksctl']);
    // No floor is enforced for eksctl, and that is the honest answer rather than a
    // missing one: which release first accepts the ClusterConfig houston writes has not
    // been measured, and a guessed floor is unsafe in both directions.
    expect(tuning.CLOUD_PROVISION_TOOLS.eksctl).toEqual([0, 0]);
    expect(Object.keys(provisionTools()).sort()).toEqual(['eksctl', 'kind']);
    expect(Object.keys(tools()).sort()).toEqual(['eksctl', 'helm', 'kind', 'kubectl']);
  });

  it('names the MongoDB image this runtime runs, and why it is that one', () => {
    // `mongo` over mongodb/mongodb-community-server for COVERAGE: this StatefulSet
    // exists to serve the versions the operator cannot reach, and community-server has
    // no tag below 4.4 while houston's map goes down to 3.6.
    expect(mongoImage('3.6')).toBe('mongo:3.6');
    expect(mongoImage('8.0')).toBe('mongo:8.0');
    // And the manifest runs it: "make it consistent with the compose writer" looks like a tidy-up
    // and would break precisely the versions this StatefulSet was written for.
    const statefulset = YAML.parseAllDocuments(mongoManifest('t', '3.6'))
      .map((doc) => doc.toJS() as { kind?: string; spec?: Record<string, unknown> })
      .find((doc) => doc.kind === 'StatefulSet');
    const containers = (
      statefulset?.spec?.template as { spec: { containers: { image: string }[] } }
    ).spec.containers;
    expect(containers[0]?.image).toBe('mongo:3.6');
  });

  it('orders the distribution signals by reliability', () => {
    // providerID first, because a managed cluster's providerID names its cloud, which is
    // the most reliable "this is not a disposable cluster" signal there is.
    expect(PROVIDER_ID_PREFIX.map(([prefix]) => prefix)).toEqual([
      'kind://',
      'k3s://',
      'aws://',
      'gce://',
      'azure://',
    ]);
  });
});

describe('the namespaces houston owns', () => {
  it('selects them by LABEL in the argv that reaches the cluster, never by name', async () => {
    // Anyone can create a namespace called `houston-anything`, and a teardown matching on
    // the prefix would eventually delete one houston never made. Asserted on the argv,
    // because that is what reaches the cluster -- the constant above says nothing about
    // whether a caller uses it.
    route(() => ({ stdout: JSON.stringify({ items: [{ metadata: { name: 'houston-t1' } }] }) }));
    expect(await workspaceNamespaces()).toEqual(['houston-t1']);
    const argv = calls[0]?.argv ?? [];
    expect(argv[argv.indexOf('-l') + 1]).toBe(OWNER_SELECTOR);
    // The context legitimately contains the prefix (kind-houston-local). What must not
    // appear is a SELECTOR built from the name.
    const selectors = argv.filter((arg, at) => at > 0 && argv[at - 1] !== '--context');
    expect(selectors.some((arg) => arg.startsWith('--field-selector'))).toBe(false);
    expect(selectors.some((arg) => arg.replace(/['"]/gu, '') === NAMESPACE_PREFIX)).toBe(false);
  });

  it('waits for a deleted namespace to go, and says so, rather than claiming it is gone', async () => {
    // `kubectl delete namespace --wait=false` returns instantly, so `down` printed
    // "removed" while the namespace was Terminating and its PVC was still there -- and an
    // `up` with the same name could race a half-deleted namespace. ONE document answers
    // both questions, the labels and the phase, because that is what a cluster returns.
    const phases = ['Terminating', 'Terminating', ''];
    route((joined, argv) => {
      if (argv.includes('get') && argv.includes('namespace')) {
        const phase = phases.shift() ?? '';
        // `--ignore-not-found`: gone is exit 0 with nothing on stdout.
        if (phase === '') return { stdout: '' };
        return {
          stdout: JSON.stringify({
            metadata: {
              name: 'houston-k',
              uid: 'namespace-k-uid',
              resourceVersion: '1',
              labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE, [WORKSPACE_LABEL]: 'k' },
            },
            status: { phase },
          }),
        };
      }
      if (joined.includes('get pvc')) return { stdout: 'persistentvolumeclaim/data-mongodb-0\n' };
      return undefined;
    });
    const said: string[] = [];
    expect(
      await deleteNamespace('k', {
        context: CONTEXT,
        volumes: true,
        emit: (event: Event) => said.push(event.message),
        sleep,
      }),
    ).toBe(true);
    expect(said.some((message) => message.includes('1 volume(s)'))).toBe(true);
    expect(said.some((message) => message.includes('Terminating'))).toBe(true); // it waited
    expect(said.some((message) => message.includes('are gone'))).toBe(true); // and confirmed
  });

  it('lets a record go when its cluster is PROVABLY deleted, and in no other case', async () => {
    // A DELETED cluster is not an UNREACHABLE one. Its kubeconfig entry survives, so the
    // namespace query fails with "connection refused" and must refuse -- a merely stopped
    // cluster genuinely cannot be asked. But a namespace cannot outlive its cluster, so
    // without this there was NO WAY to delete the record of a workspace whose cluster had
    // gone. Reported from a live box in exactly that state.
    const world = (kind: Partial<KubectlResult>) =>
      route((joined, argv) => {
        if (argv.includes('namespace')) {
          return {
            returncode: 1,
            stderr: 'The connection to the server 127.0.0.1:39911 was refused',
          };
        }
        if (joined.includes('get clusters')) return kind;
        return undefined;
      });

    // The kind probe SUCCEEDED and the cluster is not in it: provably gone.
    world({ stdout: '' });
    expect(await deleteNamespace('x', { context: CONTEXT, volumes: true, sleep })).toBe(true);

    // The cluster IS there and merely unreachable: still a refusal. This is the case the
    // guard was written for and it must not be weakened.
    world({ stdout: `${CLUSTER_NAME}\n` });
    await expect(
      deleteNamespace('x', { context: CONTEXT, volumes: true, sleep }),
    ).rejects.toBeInstanceOf(DockerError);

    // The probe itself failed -- "I could not ask" a second time, not evidence of absence.
    world({ returncode: 1, stderr: 'Cannot connect to the Docker daemon' });
    await expect(
      deleteNamespace('x', { context: CONTEXT, volumes: true, sleep }),
    ).rejects.toBeInstanceOf(DockerError);

    // And a cluster houston does not own is never assumed gone on kind's word.
    world({ stdout: '' });
    await expect(
      deleteNamespace('x', { context: 'some-remote', volumes: true, sleep }),
    ).rejects.toBeInstanceOf(DockerError);
  });
});

describe('the cluster houston makes for itself', () => {
  beforeEach(() => installTools('kind'));

  const healthy = (clusters: string) => (joined: string) => {
    if (joined.includes('get clusters')) return { stdout: clusters };
    if (joined.includes('current-context')) return { stdout: CONTEXT };
    if (joined.includes('/readyz')) return { stdout: 'ok' };
    if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) {
      return { stdout: ownedClusterMarker() };
    }
    return undefined;
  };

  it('requires onboarding and a held grant before it creates or reuses a cluster and never writes the user’s kubeconfig', async () => {
    // kind writes the file it is GIVEN and also honours KUBECONFIG for the context switch,
    // so both are set. Verified live -- a real `kind create` left ~/.kube/config
    // byte-identical -- and pinned here because the live check is not in CI.
    route(healthy(''));
    const refused = await ensureCluster().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AuthorityGateError);
    expect(refused).toMatchObject({ code: 'GATE_NOT_ONBOARDED' });
    expect((refused as AuthorityGateError).asGate()).toMatchObject({
      approve_with: 'houston onboard',
    });
    expect(calls.some(({ argv }) => argv.includes('create'))).toBe(false);

    // A Kind cluster that already exists still needs its private kubeconfig exported into
    // this home's state. Reuse is part of the same local lifecycle grant, not a bypass.
    calls.length = 0;
    route(healthy(`${CLUSTER_NAME}\n`));
    const reuseRefused = await ensureCluster().catch((error: unknown) => error);
    expect(reuseRefused).toMatchObject({ code: 'GATE_NOT_ONBOARDED' });
    expect(calls.some(({ argv }) => argv.includes('export'))).toBe(false);

    config.updateConfig((stored) => {
      revoke(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    const denied = await ensureCluster().catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(AuthorityGateError);
    expect(denied).toMatchObject({ code: 'GATE_OWNED_CLUSTER' });
    expect((denied as AuthorityGateError).asGate()).toMatchObject({
      approve_with: 'houston onboard grant owned-cluster',
    });
    expect(calls.some(({ argv }) => argv.includes('create'))).toBe(false);

    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route(healthy(''));
    expect(await ensureCluster()).toBe(CONTEXT);
    const create = calls.find(({ argv }) => argv.includes('create'));
    expect(create).toBeDefined();
    const argv = create?.argv ?? [];
    expect(argv).toContain('--kubeconfig');
    expect(String(argv[argv.indexOf('--kubeconfig') + 1]).startsWith(config.home())).toBe(true);
    // And the create itself runs with the redirected environment.
    expect(create?.options.own).toBe(true);
    const marker = calls.find(({ argv }) => argv.includes('apply') && argv.includes('--filename'));
    expect(JSON.parse(String(marker?.options.input))).toMatchObject({
      metadata: {
        name: CLUSTER_OWNER_CONFIGMAP,
        namespace: 'kube-system',
        labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE },
      },
      data: { cluster: CLUSTER_NAME },
    });
  });

  it('reuses the cluster a concurrent up already made, instead of racing to create it', async () => {
    // Two simultaneous `up`s would both see no cluster and both run `kind create`; the
    // re-check inside the lock is what makes the loser reuse rather than retry.
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route(healthy(`${CLUSTER_NAME}\n`));
    await ensureCluster();
    expect(calls.some(({ argv }) => argv.includes('create'))).toBe(false);
  });

  it.each(['absent', 'export failure', 'marker failure'])(
    'waits for a marker after a collision and %s',
    async (failure) => {
      // Each HOUSTON_HOME has its own lock. A loser that sees Kind's `already exists` response
      // cannot write a marker, but the winner may still be exporting and publishing its own one.
      // The only safe wait is private probing for that exact receipt.
      config.updateConfig((stored) => {
        grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
      });
      let reads = 0;
      let exportsSeen = 0;
      route((joined) => {
        if (joined.includes('get clusters')) return { stdout: '' };
        if (joined.includes('create cluster')) {
          return { returncode: 1, stderr: 'ERROR: node(s) already exist' };
        }
        if (joined.includes('export kubeconfig')) {
          exportsSeen += 1;
          if (failure === 'export failure' && exportsSeen === 1)
            return { returncode: 1, stderr: 'node starting' };
        }
        if (joined.includes('current-context')) return { stdout: CONTEXT };
        if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) {
          reads += 1;
          if (failure === 'marker failure' && reads === 1)
            return { returncode: 1, stderr: 'connection refused' };
          return {
            stdout: failure !== 'export failure' && reads === 1 ? '' : ownedClusterMarker(),
          };
        }
        if (joined.includes('/readyz')) return { stdout: 'ok' };
        return undefined;
      });

      const receipt = { createdHere: true };
      await expect(ensureCluster(undefined, receipt)).resolves.toBe(CONTEXT);
      expect(receipt.createdHere).toBe(false);

      const exports = calls.filter(
        ({ argv }) => argv.includes('export') && argv.includes('kubeconfig'),
      );
      expect(exports).toHaveLength(3);
      for (const call of exports.slice(0, -1)) {
        expect(String(call.argv[call.argv.indexOf('--kubeconfig') + 1])).not.toBe(
          ownedKubeconfig(),
        );
      }
      const durableExport = exports.at(-1);
      expect(durableExport).toBeDefined();
      if (durableExport === undefined)
        throw new Error('durable kubeconfig export was not recorded');
      expect(String(durableExport.argv[durableExport.argv.indexOf('--kubeconfig') + 1])).toBe(
        ownedKubeconfig(),
      );
      const markerReads = calls.filter(
        ({ argv }) => argv.includes('get') && argv.includes('configmap'),
      );
      expect(markerReads).toHaveLength(failure === 'export failure' ? 1 : 2);
      expect(markerReads.every((call) => call.options.env?.KUBECONFIG !== ownedKubeconfig())).toBe(
        true,
      );
      expect(calls.some(({ argv }) => argv.includes('apply') && argv.includes('--filename'))).toBe(
        false,
      );
      expect(calls.some(({ argv }) => argv.includes('get') && argv.includes('namespace'))).toBe(
        false,
      );
    },
  );

  it('waits through a collision winner startup that exceeds ten seconds', async () => {
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    let reads = 0;
    route((joined) => {
      if (joined.includes('get clusters')) return { stdout: '' };
      if (joined.includes('create cluster')) {
        return { returncode: 1, stderr: 'ERROR: node(s) already exist' };
      }
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) {
        reads += 1;
        return { stdout: reads <= 21 ? '' : ownedClusterMarker() };
      }
      if (joined.includes('/readyz')) return { stdout: 'ok' };
      return undefined;
    });

    const { value, elapsed } = await withCollisionClock(async () => await ensureCluster());
    expect(value).toBe(CONTEXT);
    expect(reads).toBe(22);
    expect(elapsed).toBeGreaterThan(10_000);
    expect(elapsed).toBeLessThan(CREATE_TIMEOUT * 1000);
  });

  it.each(['absent', 'unavailable'])(
    'bounds a cross-home collision wait with marker %s',
    async (state) => {
      config.updateConfig((stored) => {
        grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
      });
      route((joined) => {
        if (joined.includes('get clusters')) return { stdout: '' };
        if (joined.includes('create cluster')) {
          return { returncode: 1, stderr: 'ERROR: node(s) already exist' };
        }
        if (joined.includes('current-context')) return { stdout: CONTEXT };
        if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`))
          return state === 'absent'
            ? { stdout: '' }
            : { returncode: 1, stderr: 'connection refused' };
        return undefined;
      });

      const { elapsed } = await withCollisionClock(async () => {
        await expect(ensureCluster()).rejects.toBeInstanceOf(
          state === 'absent' ? ConflictError : DockerError,
        );
      });
      expect(elapsed).toBeGreaterThanOrEqual(CREATE_TIMEOUT * 1000);

      const exports = calls.filter(
        ({ argv }) => argv.includes('export') && argv.includes('kubeconfig'),
      );
      expect(exports.length).toBeGreaterThan(20);
      expect(
        exports.every(
          (call) => String(call.argv[call.argv.indexOf('--kubeconfig') + 1]) !== ownedKubeconfig(),
        ),
      ).toBe(true);
      expect(
        exports.every((call) => {
          const timeout = call.options.timeout;
          return timeout !== undefined && timeout > 0 && timeout <= APPLY_TIMEOUT;
        }),
      ).toBe(true);
      expect(calls.some(({ argv }) => argv.includes('apply') && argv.includes('--filename'))).toBe(
        false,
      );
      expect(calls.some(({ argv }) => argv.includes('get') && argv.includes('namespace'))).toBe(
        false,
      );
    },
  );

  it('does not begin another collision probe call after its deadline', async () => {
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    calls = [];
    kube.run = async (argv, options = {}) => {
      calls.push({ argv: [...argv], options });
      const joined = argv.join(' ');
      if (joined.includes('get clusters')) return { argv, returncode: 0, stdout: '', stderr: '' };
      if (joined.includes('create cluster')) {
        return { argv, returncode: 1, stdout: '', stderr: 'ERROR: node(s) already exist' };
      }
      if (joined.includes('export kubeconfig')) {
        const timeout = options.timeout;
        if (timeout === undefined) throw new Error('collision export received no timeout');
        await new Promise<void>((resolve) => setTimeout(resolve, timeout * 1000));
        return { argv, returncode: 0, stdout: '', stderr: '' };
      }
      if (joined.includes('current-context')) {
        return { argv, returncode: 0, stdout: CONTEXT, stderr: '' };
      }
      if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) {
        return { argv, returncode: 0, stdout: '', stderr: '' };
      }
      return { argv, returncode: 1, stdout: '', stderr: 'unexpected collision probe' };
    };

    const { elapsed } = await withCollisionClock(async () => {
      await expect(ensureCluster()).rejects.toBeInstanceOf(ConflictError);
    });

    const exports = calls.filter(
      ({ argv }) => argv.includes('export') && argv.includes('kubeconfig'),
    );
    const contexts = calls.filter(({ argv }) => argv.includes('current-context'));
    expect(exports.length).toBeGreaterThan(1);
    expect(contexts).toHaveLength(exports.length - 1);
    const lastExport = exports[exports.length - 1];
    if (lastExport?.options.timeout === undefined)
      throw new Error('last collision export received no timeout');
    expect(lastExport.options.timeout).toBeLessThan(APPLY_TIMEOUT);
    expect(elapsed).toBeGreaterThanOrEqual(CREATE_TIMEOUT * 1000);
  });

  it('adopts an unmarked legacy cluster with a Houston-labelled workspace through a private probe', async () => {
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route((joined) => {
      if (joined.includes('get clusters')) return { stdout: `${CLUSTER_NAME}\n` };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes('/readyz')) return { stdout: 'ok' };
      if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) return { stdout: '' };
      if (joined.includes('get namespace')) {
        return { stdout: JSON.stringify({ items: [{ metadata: { name: 'houston-ticket-1' } }] }) };
      }
      return undefined;
    });
    await expect(ensureCluster()).resolves.toBe(CONTEXT);
    expect(calls.some(({ argv }) => argv.includes('create'))).toBe(false);
    expect(
      calls.some(({ argv }) => argv.includes('--selector') && argv.includes(OWNER_SELECTOR)),
    ).toBe(true);
    const publication = calls.find(
      ({ argv }) => argv.includes('apply') && argv.includes('--filename'),
    );
    expect(publication).toBeDefined();
    const probe = calls.find(({ argv }) => argv.includes('export') && argv.includes('kubeconfig'));
    const probeConfig = String(probe?.argv[probe.argv.indexOf('--kubeconfig') + 1]);
    expect(probeConfig).not.toBe(ownedKubeconfig());
    expect(probe?.options.env?.KUBECONFIG).toBe(probeConfig);
    const markerRead = calls.find(({ argv }) => argv.includes('get') && argv.includes('configmap'));
    expect(markerRead?.options.env?.KUBECONFIG).toBe(probeConfig);
    expect(publication?.options.env?.KUBECONFIG).toBe(probeConfig);
    const durable = calls.findIndex(
      ({ argv }) => argv.includes('export') && argv.includes(ownedKubeconfig()),
    );
    expect(durable).toBeGreaterThan(calls.indexOf(publication!));
    expect(fs.existsSync(path.dirname(probeConfig))).toBe(false);
  });

  it('still refuses an unmarked same-named cluster that holds no houston workspace', async () => {
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route((joined) => {
      if (joined.includes('get clusters')) return { stdout: `${CLUSTER_NAME}\n` };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) return { stdout: '' };
      if (joined.includes('get namespace')) return { stdout: '{"items": []}' };
      return undefined;
    });
    await expect(ensureCluster()).rejects.toBeInstanceOf(ConflictError);
    expect(calls.some(({ argv }) => argv.includes('apply') && argv.includes('--filename'))).toBe(
      false,
    );
    expect(fs.existsSync(ownedKubeconfig())).toBe(false);
  });

  it.each([
    { returncode: 1, stderr: 'forbidden' },
    { stdout: '{broken' },
    { stdout: '{}' },
    { stdout: '{"items":[{}]}' },
  ])('keeps unknown legacy namespace reads unadopted: %j', async (reply) => {
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster');
    });
    route((joined) => {
      if (joined.includes('get clusters')) return { stdout: CLUSTER_NAME };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes('get namespace')) return reply;
      return undefined;
    });
    await expect(ensureCluster()).rejects.toBeInstanceOf(DockerError);
    expect(calls.some(({ argv }) => argv.includes('apply') || argv.includes('delete'))).toBe(false);
    expect(
      calls.some(({ argv }) => argv.includes('export') && argv.includes(ownedKubeconfig())),
    ).toBe(false);
  });

  it('refuses an unknown Kind list before creation or legacy adoption', async () => {
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster');
    });
    route((joined) =>
      joined.includes('get clusters') ? { returncode: 1, stderr: 'Docker unavailable' } : undefined,
    );
    await expect(ensureCluster()).rejects.toBeInstanceOf(DockerError);
    await expect(adoptIfUnmarked()).rejects.toBeInstanceOf(DockerError);
    expect(calls.every(({ argv }) => argv.join(' ') === 'kind get clusters')).toBe(true);
  });

  it.each(['foreign', 'malformed'])(
    'refuses a %s collision marker immediately without adopting or deleting',
    async (kind) => {
      config.updateConfig((stored) => {
        grant(stored, 'owned-cluster');
      });
      route((joined) => {
        if (joined.includes('create cluster')) return { returncode: 1, stderr: 'already exists' };
        if (joined.includes('get configmap'))
          return { stdout: kind === 'foreign' ? '{"metadata":{},"data":{}}' : '{broken' };
        return undefined;
      });
      await expect(ensureCluster()).rejects.toThrow();
      expect(calls.filter(({ argv }) => argv.includes('export'))).toHaveLength(1);
      expect(
        calls.some(
          ({ argv }) =>
            argv.includes('apply') || argv.includes('delete') || argv.includes('namespace'),
        ),
      ).toBe(false);
    },
  );

  it.each(['kubeconfig export', 'readiness'])(
    'rolls back a newly created unmarked cluster when %s fails',
    async (failure) => {
      config.updateConfig((stored) => {
        grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
      });
      route((joined) => {
        if (joined.includes('get clusters')) return { stdout: '' };
        if (joined.includes('create cluster')) return undefined;
        if (joined.includes('export kubeconfig') && failure === 'kubeconfig export') {
          return { returncode: 1, stderr: 'export failed' };
        }
        if (joined.includes('current-context')) return { stdout: CONTEXT };
        if (joined.includes('/readyz') && failure === 'readiness') {
          return { returncode: 1, stderr: 'not ready' };
        }
        return undefined;
      });

      await expect(ensureCluster()).rejects.toBeInstanceOf(CreateFailedError);
      const deletes = calls.filter(
        ({ argv }) => argv[0] === 'kind' && argv.includes('delete') && argv.includes('cluster'),
      );
      expect(deletes).toHaveLength(1);
      expect(calls.some(({ argv }) => argv.includes('apply') && argv.includes('--filename'))).toBe(
        false,
      );
    },
  );

  it('reports an unready cluster according to whether this call created it', async () => {
    // Reuse and a collision winner have already proved or published their receipt. A later
    // reachability miss must leave them in place, while a newly created unmarked cluster rolls
    // back through the catch below. The message must tell the operator which happened.
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    for (const scenario of [
      { name: 'existing', listed: `${CLUSTER_NAME}\n`, collision: false, created: false },
      { name: 'collision winner', listed: '', collision: true, created: false },
      { name: 'new cluster', listed: '', collision: false, created: true },
    ]) {
      route((joined) => {
        if (joined.includes('get clusters')) return { stdout: scenario.listed };
        if (joined.includes('create cluster') && scenario.collision)
          return { returncode: 1, stderr: 'already exists' };
        if (joined.includes('current-context')) return { stdout: CONTEXT };
        if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) {
          return { stdout: ownedClusterMarker() };
        }
        if (joined.includes('/readyz')) return { returncode: 1, stderr: 'not ready' };
        return undefined;
      });

      const failure = await ensureCluster().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CreateFailedError);
      const message = (failure as Error).message;
      const deletes = calls.filter(
        ({ argv }) => argv[0] === 'kind' && argv.includes('delete') && argv.includes('cluster'),
      );
      expect(message).not.toContain('kind delete cluster');
      if (scenario.created) {
        expect(message).toContain('was created but its API server is not answering');
        expect(message).toContain('the unmarked cluster was rolled back');
        expect(deletes).toHaveLength(1);
      } else {
        expect(message).toContain('was not created by this call');
        expect(message).toContain('Houston left it in place');
        expect(deletes).toHaveLength(0);
      }
    }
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('control plane creation threw');
      },
    ],
    [
      'returns a nonzero result',
      () => ({ returncode: 1, stderr: 'control plane creation failed' }),
    ],
  ])('does not delete a cluster that appears after Kind create %s', async (_outcome, fail) => {
    // A failed Kind process does not identify which process created the cluster that now has
    // the fixed name. Another home or a manual invocation may have won the race, so cleanup
    // must preserve it for an operator to inspect.
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    let createAttempted = false;
    route((joined) => {
      if (joined.includes('get clusters'))
        return { stdout: createAttempted ? `${CLUSTER_NAME}\n` : '' };
      if (joined.includes('create cluster')) {
        createAttempted = true;
        return fail();
      }
      return undefined;
    });

    await expect(ensureCluster()).rejects.toThrow(/control plane creation/u);
    expect(
      calls.filter(
        ({ argv }) => argv[0] === 'kind' && argv.includes('delete') && argv.includes('cluster'),
      ),
    ).toHaveLength(0);
    expect(calls.some(({ argv }) => argv.includes('export') && argv.includes('kubeconfig'))).toBe(
      false,
    );
    expect(calls.some(({ argv }) => argv.includes('apply') && argv.includes('--filename'))).toBe(
      false,
    );
  });

  it('preserves another home after marker commit with a failed publication response', async () => {
    config.updateConfig((stored) => grant(stored, 'owned-cluster'));
    const firstHome = process.env.HOUSTON_HOME;
    const secondHome = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-second-home-'));
    let published = false;
    const resources = new Set<string>();
    route((joined) => {
      if (joined.includes('get clusters')) return { stdout: published ? CLUSTER_NAME : '' };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes('/readyz')) return { stdout: 'ok' };
      if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`))
        return { stdout: published ? ownedClusterMarker() : '' };
      if (joined.includes('kind delete cluster')) resources.clear();
      return undefined;
    });
    const scripted = kube.run;
    kube.run = async (argv, options) => {
      const result = await scripted(argv, options);
      if (argv.includes('apply')) {
        published = true;
        process.env.HOUSTON_HOME = secondHome;
        try {
          config.updateConfig((stored) => grant(stored, 'owned-cluster'));
          await ensureCluster();
          resources.add('second-home-namespace');
        } finally {
          process.env.HOUSTON_HOME = firstHome;
        }
        return { ...result, returncode: 1, stderr: 'response lost after commit' };
      }
      return result;
    };
    try {
      await expect(ensureCluster()).rejects.toThrow('response lost after commit');
      expect(resources.has('second-home-namespace')).toBe(true);
      expect(calls.some(({ argv }) => argv.includes('delete'))).toBe(false);
    } finally {
      process.env.HOUSTON_HOME = firstHome;
      fs.rmSync(secondHome, { recursive: true, force: true });
    }
  });

  it('does not roll back interrupted marker publication', async () => {
    config.updateConfig((stored) => grant(stored, 'owned-cluster'));
    route((joined) => {
      if (joined.includes('get clusters')) return { stdout: '' };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes('/readyz')) return { stdout: 'ok' };
      if (joined.includes('apply')) throw new Interrupted();
      return undefined;
    });
    await expect(ensureCluster()).rejects.toBeInstanceOf(Interrupted);
    expect(calls.some(({ argv }) => argv.includes('delete'))).toBe(false);
  });

  it('verifies an existing owned marker without Kind for teardown', async () => {
    config.updateConfig((stored) => grant(stored, 'owned-cluster'));
    fs.mkdirSync(path.dirname(ownedKubeconfig()), { recursive: true });
    fs.writeFileSync(ownedKubeconfig(), 'synthetic owned client state');
    route((joined) =>
      joined.includes('get configmap')
        ? { stdout: ownedClusterMarker() }
        : { returncode: 1, stderr: 'kind missing' },
    );
    await expect(adoptIfUnmarked()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.own).toBe(true);
    expect(calls[0]?.argv).toContain(CONTEXT);
  });

  it.each(['absent', 'foreign', 'malformed', 'unavailable'])(
    'refuses teardown when the durable marker is %s and Kind is unavailable',
    async (state) => {
      config.updateConfig((stored) => grant(stored, 'owned-cluster'));
      fs.mkdirSync(path.dirname(ownedKubeconfig()), { recursive: true });
      fs.writeFileSync(ownedKubeconfig(), 'synthetic owned client state');
      route((joined) => {
        if (joined.includes('get configmap'))
          return state === 'unavailable'
            ? { returncode: 1, stderr: 'API unavailable' }
            : { stdout: state === 'absent' ? '' : state === 'foreign' ? '{}' : '{broken' };
        return { returncode: 1, stderr: 'kind missing' };
      });
      await expect(adoptIfUnmarked()).rejects.toThrow();
      expect(calls.some(({ argv }) => argv.includes('apply') || argv.includes('delete'))).toBe(
        false,
      );
    },
  );

  it('keeps a newly marked cluster when a later progress listener fails', async () => {
    fs.rmSync(ownedKubeconfig(), { force: true });
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route(healthy(''));

    await expect(
      ensureCluster((event: Event) => {
        if (event.message.includes(' ready at ')) throw new Error('progress listener failed');
      }),
    ).rejects.toThrow('progress listener failed');

    expect(calls.some(({ argv }) => argv.includes('apply') && argv.includes('--filename'))).toBe(
      true,
    );
    expect(
      calls.some(
        ({ argv }) => argv[0] === 'kind' && argv.includes('delete') && argv.includes('cluster'),
      ),
    ).toBe(false);
  });

  it('rolls back a newly created unmarked cluster before rethrowing an interrupt', async () => {
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route((joined) => (joined.includes('get clusters') ? { stdout: '' } : undefined));
    const routed = kube.run;
    kube.run = (argv, options = {}) => {
      if (argv.includes('export')) return Promise.reject(new Interrupted());
      return routed(argv, options);
    };

    await expect(ensureCluster()).rejects.toBeInstanceOf(Interrupted);
    const deletes = calls.filter(
      ({ argv }) => argv[0] === 'kind' && argv.includes('delete') && argv.includes('cluster'),
    );
    expect(deletes).toHaveLength(1);
  });

  it('refuses a same-named cluster without Houston’s ConfigMap, even when force is requested', async () => {
    // `kind-houston-local` says only that someone used the same name. The marker is the
    // proof that lets Houston export its kubeconfig, use the cluster, or delete it. With
    // no houston workspace in it, nothing says an earlier houston made it either.
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route((joined) => {
      if (joined.includes('get clusters')) return { stdout: `${CLUSTER_NAME}\n` };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes('/readyz')) return { stdout: 'ok' };
      if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) {
        return { stdout: '' };
      }
      if (joined.includes('get namespace')) return { stdout: '{"items": []}' };
      return undefined;
    });
    await expect(ensureCluster()).rejects.toThrow(/ownership marker/u);
    expect(calls.some(({ argv }) => argv.includes('create'))).toBe(false);

    calls.length = 0;
    await expect(deleteCluster({ force: true })).rejects.toThrow(/ownership marker/u);
    expect(calls.some(({ argv }) => argv.includes('delete'))).toBe(false);

    // A denied or malformed read is unknown, rather than a confirmed absent marker.
    for (const reply of [{ returncode: 1, stderr: 'forbidden' }, { stdout: '{broken' }]) {
      route((joined) => {
        if (joined.includes('get clusters')) return { stdout: `${CLUSTER_NAME}\n` };
        if (joined.includes('current-context')) return { stdout: CONTEXT };
        if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) return reply;
        return undefined;
      });
      calls.length = 0;
      await expect(deleteCluster({ force: true })).rejects.toBeInstanceOf(DockerError);
      expect(calls.some(({ argv }) => argv.includes('delete'))).toBe(false);
    }
  });

  it('reconnects a cluster that outlived its kubeconfig, and says so when it cannot', async () => {
    fs.rmSync(ownedKubeconfig(), { force: true });
    // `kind get clusters` reads Docker, so it sees a cluster houston's OWN kubeconfig knows
    // nothing about -- a fresh HOUSTON_HOME, a deleted config. Without the export, "reusing
    // cluster" was followed by every kubectl call going to localhost:8080.
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route(healthy(`${CLUSTER_NAME}\n`));
    expect(await ensureCluster()).toBe(CONTEXT);
    const joined = calls.map(({ argv }) => argv.join(' '));
    expect(joined.some((call) => call.includes('export kubeconfig'))).toBe(true);
    expect(joined.some((call) => call.includes('create cluster'))).toBe(false);

    // A failed export is terminal and says so, rather than leaving every later call to
    // fail against localhost:8080.
    route((call) => {
      if (call.includes('get clusters')) return { stdout: `${CLUSTER_NAME}\n` };
      if (call.includes('export kubeconfig')) {
        return { returncode: 1, stderr: 'permission denied' };
      }
      return undefined;
    });
    await expect(ensureCluster()).rejects.toThrow(CreateFailedError);
    await expect(ensureCluster()).rejects.toThrow(/kubeconfig could not be read/u);
  });

  it('deletes only its own cluster, by name, whatever else the machine has', async () => {
    // There is no parameter for which cluster to delete, because a delete that can be
    // pointed anywhere eventually is. Asserted on the argv, which is what reaches the box.
    config.updateConfig((stored) => {
      grant(stored, 'owned-cluster', new Date('2026-10-15T00:00:00Z'));
    });
    route((joined, argv) => {
      if (joined.includes('get clusters')) return { stdout: `kind\n${CLUSTER_NAME}\nother\n` };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes('/readyz')) return { stdout: 'ok' };
      if (joined.includes(`get configmap ${CLUSTER_OWNER_CONFIGMAP}`)) {
        return { stdout: ownedClusterMarker() };
      }
      if (argv.includes('namespace')) return { stdout: JSON.stringify({ items: [] }) };
      return undefined;
    });
    expect(await deleteCluster()).toBe(true);
    const deletes = calls.filter(({ argv }) => argv.includes('delete'));
    expect(deletes).toHaveLength(1);
    const argv = deletes[0]?.argv ?? [];
    // The property is about the --name VALUE: `kind` is legitimately argv[0], the binary.
    expect(argv.slice(argv.indexOf('--name') + 1)).toEqual([CLUSTER_NAME]);
  });
});

describe('whose cluster it is', () => {
  it('marks a cluster houston did not create as external, and its own as its own', async () => {
    // houston may delete a cluster it created; in one you supplied it owns only the
    // namespaces it labelled. No kind is the bring-your-own path -- with kind INSTALLED
    // houston creates its own instead of adopting anyone's.
    installTools('kubectl', 'helm');
    fakeRun([
      ['get clusters', 0, 'somebody-elses\n'],
      ['config current-context', 0, 'kind-somebody-elses\n'],
      ['/readyz', 0, 'ok'],
      ['get storageclass', 0, '{"items": []}'],
      ['get namespace', 0, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const theirs = await preflight();
    expect(theirs.clusterExists).toBe(false); // ours is not among them
    expect(theirs.provider).toBe(PROVIDER_EXTERNAL);
    expect(theirs.context).toBe('kind-somebody-elses');
    // A cluster houston cannot make is never one it creates.
    expect(theirs.willCreate).toBe(false);

    // And ours, when it IS there, is the one houston may manage fully.
    installTools('kind', 'kubectl', 'helm');
    fakeRun([
      ['get clusters', 0, `${CLUSTER_NAME}\n`],
      ['/readyz', 0, 'ok'],
      ['get storageclass', 0, '{"items": []}'],
      ['get namespace', 0, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const ours = await preflight();
    expect(ours.clusterExists).toBe(true);
    expect(ours.provider).toBe(PROVIDER_KIND);
    expect(ours.context).toBe(CONTEXT);
  });
});

describe('the replica set a StatefulSet cannot initiate for itself', () => {
  it('reports an uninitiated set as dead, and a pod that never started as never started', async () => {
    // Exit 7, known dead. Every second waited after this is spent waiting for something
    // that cannot happen, and the readiness timeout would blame Rocket.Chat.
    route((joined, argv) => {
      if (joined.includes('jsonpath')) return { stdout: 'true' }; // the container is up...
      if (argv.includes('--eval')) return { stdout: '0' }; // ...but rs.status().ok == 0
      return undefined;
    });
    const dead = await initReplicaSet({ namespace: 'houston-t', context: CONTEXT, sleep }).catch(
      (error: unknown) => error,
    );
    expect(dead).toBeInstanceOf(CreateFailedError);
    // Say WHY Rocket.Chat needs it.
    expect((dead as CreateFailedError).message).toContain('change streams');
    expect((dead as CreateFailedError).exitCode).toBe(7);

    // And MongoDB never starting is equally terminal, naming the command that shows why.
    route(() => ({ stdout: 'false' }));
    tuning.MONGO_READY_TRIES = 2;
    const never = await initReplicaSet({ namespace: 'houston-t', context: CONTEXT, sleep }).catch(
      (error: unknown) => error,
    );
    expect(never).toBeInstanceOf(CreateFailedError);
    expect((never as CreateFailedError).message).toContain('describe pod');
    // A pod stuck Pending has not started; it is not "not ready".
    expect((never as CreateFailedError).message).toContain('never started');
  });

  it('initiates a member the headless Service publishes BEFORE the pod is ready', () => {
    // The circular dependency one layer below the readiness probe. A headless Service does
    // not publish DNS for a not-ready pod, and this pod cannot be ready until the set is
    // initiated -- so `rs.initiate` could not resolve its own member and mongod refused
    // with "no host described in new configuration ... maps to this node".
    const service = YAML.parseAllDocuments(mongoManifest('t', '8.0'))
      .map(
        (doc) =>
          doc.toJS() as {
            kind?: string;
            metadata: { name: string };
            spec: Record<string, unknown>;
          },
      )
      .find((doc) => doc.kind === 'Service');
    // The literal STRING "None" -- that is how Kubernetes documents a headless Service.
    expect(service?.spec.clusterIP).toBe('None');
    expect(service?.spec.publishNotReadyAddresses).toBe(true);
    // And the member the initiate script names is one this Service serves.
    expect(service?.metadata.name).toBe(MONGO_SERVICE);
    expect(RS_INITIATE).toContain(`${MONGO_SERVICE}-0.${MONGO_SERVICE}`);
  });
});

describe('secure local reuse and full lock acquisition budget', () => {
  it.each(['create/reuse', 'adopt', 'delete'])(
    '%s waits beyond Kind create while the real owner still holds the cluster lock',
    async (operation) => {
      installTools('kind', 'kubectl');
      config.updateConfig((stored) => {
        grant(stored, 'owned-cluster');
      });
      route((joined) => {
        if (joined === 'kind get clusters') return { stdout: CLUSTER_NAME };
        if (joined.includes('current-context')) return { stdout: CONTEXT };
        if (joined.includes('get configmap')) return { stdout: ownedClusterMarker() };
        if (joined.includes('/readyz')) return { stdout: 'ok' };
        if (joined.includes('get namespace')) return { stdout: JSON.stringify({ items: [] }) };
        return undefined;
      });
      let unlock!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const holder = reproLock(CLUSTER_LOCK, async () => {
        acquired();
        await release;
      });
      await held;
      // Linux flock has already acquired before the clock changes. The second call is
      // outside the holder's async context, so it really queues at the production owner.
      jest.useFakeTimers();
      let failure: unknown;
      let finished = false;
      const pending =
        operation === 'adopt'
          ? adoptIfUnmarked()
          : operation === 'delete'
            ? deleteCluster()
            : ensureCluster();
      const waiter = pending.then(
        () => {
          finished = true;
        },
        (error: unknown) => {
          failure = error;
        },
      );
      try {
        const admissionDeadline = jest.getRealSystemTime() + 2000;
        while (jest.getTimerCount() === 0 && jest.getRealSystemTime() < admissionDeadline) {
          await yieldIo();
        }
        expect(failure).toBeUndefined();
        expect(jest.getTimerCount()).toBeGreaterThan(0);
        await jest.advanceTimersByTimeAsync((CREATE_TIMEOUT + 1) * 1000);
        expect(failure).toBeUndefined();
        expect(finished).toBe(false);
      } finally {
        // Restore real time before the waiter can acquire its own OS flock.
        jest.useRealTimers();
        unlock();
        await holder;
        await waiter;
      }
      expect(failure).toBeUndefined();
      expect(finished).toBe(true);
    },
  );

  it.each(['owned', 'absent', 'foreign', 'malformed', 'unavailable', 'down', 'missing'])(
    'uses only a reachable exact owned receipt without Kind: %s',
    async (state) => {
      installTools('kubectl');
      config.updateConfig((stored) => {
        grant(stored, 'owned-cluster');
      });
      if (state !== 'missing') {
        fs.mkdirSync(path.dirname(ownedKubeconfig()), { recursive: true });
        fs.writeFileSync(ownedKubeconfig(), 'synthetic owned client');
      } else fs.rmSync(ownedKubeconfig(), { force: true });
      const bytes = state === 'missing' ? null : fs.readFileSync(ownedKubeconfig(), 'utf8');
      route((joined) => {
        if (joined.includes('get configmap'))
          return {
            returncode: state === 'unavailable' ? 1 : 0,
            stdout:
              state === 'absent'
                ? ''
                : state === 'foreign'
                  ? '{}'
                  : state === 'malformed'
                    ? '{'
                    : ownedClusterMarker(),
          };
        if (joined.includes('/readyz'))
          return { returncode: state === 'down' ? 1 : 0, stdout: 'ok' };
        return { returncode: 1, stderr: 'unexpected external action' };
      });
      await expect(ownedRuntimeState()).resolves.toBe(
        state === 'owned'
          ? 'ready'
          : state === 'absent' || state === 'missing'
            ? 'unavailable'
            : 'unknown',
      );
      const operation = ensureKubeconfig({ context: CONTEXT, distribution: 'kind', create: false });
      if (state === 'owned') await expect(operation).resolves.toBe(CONTEXT);
      else await expect(operation).rejects.toThrow();
      expect(
        calls.every(
          ({ argv, options }) =>
            argv[0] === 'kubectl' &&
            argv.includes('--context') &&
            argv.includes(CONTEXT) &&
            options.own === true &&
            !argv.includes('apply') &&
            !argv.includes('delete'),
        ),
      ).toBe(true);
      expect(
        state === 'missing'
          ? fs.existsSync(ownedKubeconfig())
          : fs.readFileSync(ownedKubeconfig(), 'utf8'),
      ).toBe(state === 'missing' ? false : bytes);
    },
  );
});
