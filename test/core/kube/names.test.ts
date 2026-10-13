import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';

import * as config from '../../../src/lib/config';
import { CreateFailedError, DockerError } from '../../../src/lib/errors';
import type { Event } from '../../../src/lib/events';
import type { KubectlResult } from '../../../src/seams/kubectl';

import { workspaceNamespaces } from '../../../src/core/kube/capabilities';
import { deleteCluster, ensureCluster } from '../../../src/core/kube/cluster';
import { kube, type RunOptions } from '../../../src/core/kube/exec';
import { mongoManifest } from '../../../src/core/kube/manifests';
import {
  CHART,
  CLUSTER_NAME,
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
    return undefined;
  };

  it('never writes the user’s kubeconfig when it creates one', async () => {
    // kind writes the file it is GIVEN and also honours KUBECONFIG for the context switch,
    // so both are set. Verified live -- a real `kind create` left ~/.kube/config
    // byte-identical -- and pinned here because the live check is not in CI.
    route(healthy(''));
    expect(await ensureCluster()).toBe(CONTEXT);
    const create = calls.find(({ argv }) => argv.includes('create'));
    expect(create).toBeDefined();
    const argv = create?.argv ?? [];
    expect(argv).toContain('--kubeconfig');
    expect(String(argv[argv.indexOf('--kubeconfig') + 1]).startsWith(config.home())).toBe(true);
    // And the create itself runs with the redirected environment.
    expect(create?.options.own).toBe(true);
  });

  it('reuses the cluster a concurrent up already made, instead of racing to create it', async () => {
    // Two simultaneous `up`s would both see no cluster and both run `kind create`; the
    // re-check inside the lock is what makes the loser reuse rather than retry.
    route(healthy(`${CLUSTER_NAME}\n`));
    await ensureCluster();
    expect(calls.some(({ argv }) => argv.includes('create'))).toBe(false);
  });

  it('reconnects a cluster that outlived its kubeconfig, and says so when it cannot', async () => {
    // `kind get clusters` reads Docker, so it sees a cluster houston's OWN kubeconfig knows
    // nothing about -- a fresh HOUSTON_HOME, a deleted config. Without the export, "reusing
    // cluster" was followed by every kubectl call going to localhost:8080.
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
    route((joined, argv) => {
      if (joined.includes('get clusters')) return { stdout: `kind\n${CLUSTER_NAME}\nother\n` };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes('/readyz')) return { stdout: 'ok' };
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
