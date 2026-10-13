/**
 * Tier k2: what a cluster can do, whether it can be reached, and which one to use.
 *
 * One spec for the tier rather than one per module, because every case here is the same
 * assertion in a different place: a read that could not be answered must not come back
 * looking like a read that was answered with nothing. Seven callers act on that
 * distinction and three of them delete.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CreateFailedError, PreflightError, ValidationError } from '../../../src/lib/errors';
import type { Event } from '../../../src/lib/events';
import type { KubectlResult } from '../../../src/seams/kubectl';
import { prepareCluster } from '../../../src/core/eks';

import {
  architectureBlocker,
  ingressClasses,
  metricsAvailable,
  nodesSummary,
  storageBlocker,
  storageClasses,
  workspaceNamespaces,
} from '../../../src/core/kube/capabilities';
import { deleteCluster, ensureCluster } from '../../../src/core/kube/cluster';
import {
  activeContext,
  assertContextKnown,
  clusters,
  contextServers,
  contexts,
  distribution,
  distributionOf,
  forgetContext,
  isLocalCluster,
  planCluster,
  shortName,
} from '../../../src/core/kube/context';
import { kube, type RunOptions } from '../../../src/core/kube/exec';
import { ensureIngress } from '../../../src/core/kube/ingress';
import { CLUSTER_NAME, CONTEXT, PROVIDER_EXTERNAL, tuning } from '../../../src/core/kube/names';
import { preflight as probePreflight } from '../../../src/core/kube/probe';
import {
  REACH_DENIED,
  REACH_DOWN,
  REACH_NO_CONTEXT,
  REACH_OK,
  reach,
  reachAdvice,
  reachWhy,
  reachable,
  helmReachable,
} from '../../../src/core/kube/reachability';
import { initReplicaSet } from '../../../src/core/kube/replicaset';
import {
  newEnough,
  makeTool,
  missingTools,
  parseVersion,
  preflight,
  tool,
  toolsReady,
  canProvision,
  canProvisionCloud,
  usable,
  versionKey,
} from '../../../src/core/kube/tools';

const realRun = kube.run;

/** Script the funnel: a predicate per reply, first match wins. */
type Rule = [(argv: readonly string[]) => boolean, Partial<KubectlResult>];

let seen: string[][] = [];

function script(rules: Rule[], fallback: Partial<KubectlResult> = {}): void {
  seen = [];
  kube.run = (argv) => {
    seen.push([...argv]);
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

/** Every call a `route`d funnel saw, with the options it was given. */
let calls: { argv: string[]; options: RunOptions }[] = [];

/** Script `kube.run` with access to the options too: `own` is part of some answers. */
function route(
  answer: (
    joined: string,
    argv: readonly string[],
    options: RunOptions,
  ) => Partial<KubectlResult> | undefined,
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
      ...(answer(argv.join(' '), argv, options) ?? fallback),
    });
  };
}

/** A scripted funnel: substrings in order, `helm list` answering, the rest failing. */
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

/**
 * Stand-ins for the named tools, first on PATH, in a directory this test owns, so a tool
 * lookup finds exactly these. With none installed, the suite answers every one of them
 * absent.
 */
const realPath = process.env.PATH;
let toolDir = '';
function installTools(...names: string[]): void {
  uninstallTools();
  toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-tools-'));
  for (const name of names) {
    fs.writeFileSync(path.join(toolDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  process.env.PATH = `${toolDir}${path.delimiter}${realPath ?? ''}`;
}
function uninstallTools(): void {
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  if (toolDir !== '') fs.rmSync(toolDir, { recursive: true, force: true });
  toolDir = '';
}

/**
 * The facts `planCluster` reads, stated instead of probed -- whether kind is installed, whether
 * houston's own cluster exists, what kubectl points at, whether it answers and how it refuses, and
 * which contexts the kubeconfigs name.
 *
 * Stated through the funnel rather than by replacing the functions, which emitted
 * TypeScript cannot do across a module boundary, so every read here is the real one. One
 * difference is the world's, not the stub's: `clusterContext` reads a missing entry as
 * houston's own context name, so that cluster answers only when it exists.
 */
function probeWorld({
  kind,
  ourCluster,
  active,
  answers = true,
  refusal = 'dial tcp 127.0.0.1:6443: connect: connection refused',
  known = [],
  unreadable = '',
  tools = [],
}: {
  kind: boolean;
  ourCluster: boolean;
  active: string;
  answers?: boolean;
  refusal?: string;
  known?: string[];
  unreadable?: string;
  tools?: string[];
}): void {
  const wanted = [...(kind ? ['kind'] : []), ...tools];
  if (wanted.length > 0) installTools(...wanted);
  else uninstallTools();
  route((joined, argv, options) => {
    if (joined === 'kind get clusters') return { stdout: ourCluster ? `${CLUSTER_NAME}\n` : '' };
    if (joined === 'kubectl config current-context') {
      return { stdout: options.own === true ? (ourCluster ? CONTEXT : '') : active };
    }
    if (joined.startsWith('kubectl config get-contexts')) {
      return unreadable !== ''
        ? { returncode: 1, stderr: unreadable }
        : { stdout: known.map((name) => `${name}\n`).join('') };
    }
    const context = String(argv[argv.indexOf('--context') + 1]);
    if (argv.includes('/readyz')) {
      const up = context === CONTEXT ? ourCluster && answers : answers;
      return up ? { stdout: 'ok' } : { returncode: 1, stderr: refusal };
    }
    if (argv.includes('nodes')) {
      return {
        stdout:
          context === CONTEXT
            ? 'kind://docker/houston-local/houston-local-control-plane v1.30.0 - node'
            : 'k3s://docker-01 v1.30.0+k3s1 - docker-01',
      };
    }
    return { returncode: 1, stderr: 'no stub' };
  });
}

afterEach(() => {
  kube.run = realRun;
  uninstallTools();
});

describe('capabilities: a refused read is never an empty one', () => {
  it('returns null for storage, nodes, ingress and namespaces when refused', async () => {
    script([], { returncode: 1, stderr: 'error: You must be logged in to the server' });
    expect(await storageClasses('prod')).toBeNull();
    expect(await nodesSummary('prod')).toBeNull();
    expect(await ingressClasses('prod')).toBeNull();
    // This one is the sharpest: [] is what "this cluster holds no houston workspaces"
    // looks like, and three callers DELETE on that answer.
    expect(await workspaceNamespaces('prod')).toBeNull();

    // THE WIRE SHAPE, measured rather than imagined: a denied `get storageclass -o json`
    // prints an EMPTY items document on stdout AND exits 1. A classifier that looked at the
    // payload before the exit code would rebuild the bug inside the fix -- `doctor` told
    // somebody with a working default class, Traefik and a Ready node that they had none.
    script([], {
      returncode: 1,
      stdout: '{"apiVersion":"v1","items":[],"kind":"List"}',
      stderr:
        'Error from server (Forbidden): storageclasses.storage.k8s.io is forbidden: ' +
        'User "sa" cannot list resource',
    });
    expect(await storageClasses('limited')).toBeNull();
    expect(await ingressClasses('limited')).toBeNull();
    expect(await nodesSummary('limited')).toBeNull();
  });

  it('reads an answered-but-empty cluster as empty, which is a different fact', async () => {
    script([], { stdout: '{"items":[]}' });
    expect(await storageClasses('prod')).toEqual([[], '']);
    expect(await nodesSummary('prod')).toEqual([0, []]);
    expect(await ingressClasses('prod')).toEqual([]);
    expect(await workspaceNamespaces('prod')).toEqual([]);
  });

  it('finds the default storage class by annotation, not by position', async () => {
    script([], {
      stdout: JSON.stringify({
        items: [
          { metadata: { name: 'slow' } },
          {
            metadata: {
              name: 'standard',
              annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
            },
          },
        ],
      }),
    });
    expect(await storageClasses('prod')).toEqual([['slow', 'standard'], 'standard']);
  });

  it('puts the cluster’s own default ingress class first, then sorts', async () => {
    // An EKS cluster carrying both alb and nginx would otherwise have the choice made by
    // whichever the API server listed first, and the two behave differently for ACME
    // http-01 solving.
    script([], {
      stdout: JSON.stringify({
        items: [
          { metadata: { name: 'nginx' } },
          {
            metadata: {
              name: 'alb',
              annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' },
            },
          },
          { metadata: { name: 'traefik' } },
        ],
      }),
    });
    expect(await ingressClasses('prod')).toEqual(['alb', 'nginx', 'traefik']);
  });

  it('collects node architectures, which decide whether an image can be pulled', async () => {
    script([], {
      stdout: JSON.stringify({
        items: [
          { status: { nodeInfo: { architecture: 'arm64' } } },
          { status: { nodeInfo: { architecture: 'arm64' } } },
        ],
      }),
    });
    expect(await nodesSummary('prod')).toEqual([2, ['arm64']]);
  });

  it('asks whether metrics-server answers rather than assuming per distribution', async () => {
    script([[has('top', 'nodes'), { returncode: 0 }]]);
    expect(await metricsAvailable('prod')).toBe(true);
    script([[has('top', 'nodes'), { returncode: 1 }]]);
    expect(await metricsAvailable('prod')).toBe(false);
  });
});

describe('the two blockers that refuse rather than warn', () => {
  it('refuses an amd64-only Rocket.Chat on an arm64-only cluster', () => {
    const pre = preflight({
      clusterReachable: true,
      architectures: ['arm64'],
      context: 'prod',
    });
    expect(architectureBlocker(pre, '7.10.0')).toContain('published for amd64 only');
    // The refusal names the version, the architecture it met, and the answer.
    expect(architectureBlocker(pre, '6.5.0')).toContain('6.5.0');
    expect(architectureBlocker(pre, '6.5.0')).toContain('arm64');
    expect(architectureBlocker(pre, '6.5.0')).toContain('Docker runtime');
    // One amd64 node is enough: Kubernetes will schedule it there, and a nodeSelector
    // would trade a fast ErrImagePull for a silent Pending.
    expect(architectureBlocker({ ...pre, architectures: ['arm64', 'amd64'] }, '7.10.0')).toBe('');
    // 8.0.0 is the first multi-arch release, measured with docker manifest inspect.
    expect(architectureBlocker(pre, '8.0.0')).toBe('');
    // A FIPS CI build is amd64 only whatever its version (measured on ghcr).
    const fips = 'ghcr.io/rocketchat/rocket.chat:develop-fips';
    expect(architectureBlocker(pre, '8.10.0.dev0', fips)).toContain('FIPS build');
    expect(
      architectureBlocker({ ...pre, architectures: ['arm64', 'amd64'] }, '8.10.0.dev0', fips),
    ).toBe('');
    expect(architectureBlocker(pre, '8.10.0.dev0', 'ghcr.io/rocketchat/rocket.chat:develop')).toBe(
      '',
    );
    expect(architectureBlocker(pre, '8.5.1')).toBe('');
    // A version this cannot read must not become a refusal.
    expect(architectureBlocker(pre, 'latest')).toBe('');
    // And an unread cluster is not our question.
    expect(architectureBlocker({ ...pre, clusterReachable: false }, '7.10.0')).toBe('');
    expect(architectureBlocker({ ...pre, architectures: [] }, '7.10.0')).toBe('');
  });

  it('names a permissions problem as one, not as a missing provisioner', () => {
    // Blaming the customer's cluster made houston unusable on a namespace-scoped RBAC
    // identity AND sent the engineer to ask for a provisioner that was already there.
    const refusedRead = storageBlocker(
      preflight({ clusterReachable: true, context: 'prod', unreadable: ['storage'] }),
    );
    expect(refusedRead).toContain('would not let houston read its StorageClasses');
    expect(refusedRead).toContain('permissions problem');
    expect(refusedRead).not.toContain('has no StorageClass');

    const noDefault = storageBlocker(
      preflight({ clusterReachable: true, context: 'prod', storageClasses: ['fast', 'slow'] }),
    );
    expect(noDefault).toContain('none is marked default');
    // The subtler half fails the same way, so it gets the command that fixes it.
    expect(noDefault).toContain('kubectl patch storageclass');
    const none = storageBlocker(preflight({ clusterReachable: true, context: 'prod' }));
    expect(none).toContain('has no StorageClass');
    // A REFUSAL, because nothing would ever log it: with no provisioner the PVC stays
    // Pending, the pod stays Pending and Rocket.Chat NEVER STARTS -- so there are no logs to
    // find it in, and the readiness timeout would blame the one component that is innocent.
    expect(none).toContain('never start');
    expect(none).toContain('logs');
    expect(
      storageBlocker(preflight({ clusterReachable: true, defaultStorageClass: 'standard' })),
    ).toBe('');
    // Unreachable is reported first, by the caller.
    expect(storageBlocker(preflight({ clusterReachable: false }))).toBe('');
  });
});

describe('reachability has four answers, not two', () => {
  it.each([
    ['ok', { returncode: 0, stdout: 'ok' }, REACH_OK],
    [
      'denied',
      { returncode: 1, stderr: 'error: You must be logged in to the server (Unauthorized)' },
      REACH_DENIED,
    ],
    [
      'no context',
      { returncode: 1, stderr: 'error: context "prod" does not exist' },
      REACH_NO_CONTEXT,
    ],
    [
      'no context, the other phrasing',
      {
        returncode: 1,
        stderr: 'Error in configuration: context was not found for specified context: prod',
      },
      REACH_NO_CONTEXT,
    ],
    [
      'down',
      { returncode: 1, stderr: 'dial tcp 127.0.0.1:6443: connect: connection refused' },
      REACH_DOWN,
    ],
    // Every string below was produced by a real kubectl on a real cluster during live EKS
    // testing, which is why they are exact rather than representative. The two DENIED
    // phrasings came from the SAME cluster the same afternoon -- `get --raw` produces the
    // one above, the discovery client this one -- so matching one of them is matching none
    // of them half the time.
    [
      'denied, as the discovery client says it',
      {
        returncode: 1,
        stderr:
          "couldn't get current server API group list: the server has asked for the client " +
          'to provide credentials',
      },
      REACH_DENIED,
    ],
    [
      'denied, as RBAC says it',
      { returncode: 1, stderr: 'Error from server (Forbidden): nodes is forbidden' },
      REACH_DENIED,
    ],
    [
      'down, at the TLS handshake',
      {
        returncode: 1,
        stderr: 'Unable to connect to the server: net/http: TLS handshake timeout',
      },
      REACH_DOWN,
    ],
  ])('classifies %s', async (_name, reply, expected) => {
    script([], reply);
    const got = await reach('prod');
    expect(got.status).toBe(expected);
    // Every non-ok answer can say what it was, and the bool the resolution order uses
    // agrees with the four-way answer on every row.
    expect(reachWhy(got) === '').toBe(expected === REACH_OK);
    expect(await reachable('prod')).toBe(expected === REACH_OK);
  });

  it('reads BOTH streams, because which one carries the reason varies', async () => {
    script([], { returncode: 1, stdout: 'error: context "prod" does not exist', stderr: '' });
    expect((await reach('prod')).status).toBe(REACH_NO_CONTEXT);
  });

  it('says something different, and useful, for each of the four', async () => {
    expect(reachWhy({ status: REACH_OK, detail: '' })).toBe('');
    expect(reachWhy({ status: REACH_DENIED, detail: '' })).toContain('the cluster is up');
    expect(reachWhy({ status: REACH_NO_CONTEXT, detail: '' })).toContain(
      'not a statement about the cluster',
    );
    expect(reachWhy({ status: REACH_DOWN, detail: '' })).toContain('nothing answered');

    expect(reachAdvice({ status: REACH_DENIED, detail: '' })).toContain('create-access-entry');
    expect(
      reachAdvice({ status: REACH_NO_CONTEXT, detail: '' }, 'arn:aws:eks:us-east-1:1:cluster/x'),
    ).toContain('aws eks update-kubeconfig');
    expect(reachAdvice({ status: REACH_NO_CONTEXT, detail: '' }, 'kind-x')).toContain(
      'kubectl config get-contexts',
    );
    expect(reachAdvice({ status: REACH_DOWN, detail: '' })).toBe('');
  });
});

describe('choosing a context', () => {
  it('keeps "Docker is down" apart from "there are no clusters"', async () => {
    script([[has('get', 'clusters'), { returncode: 1, stderr: 'ERROR: failed to list clusters' }]]);
    expect(await clusters()).toEqual([[], expect.stringContaining('failed to list clusters')]);

    script([[has('get', 'clusters'), { stdout: 'houston-local\nother\n' }]]);
    expect(await clusters()).toEqual([['houston-local', 'other'], '']);

    script([[has('get', 'clusters'), { stdout: 'No kind clusters found.\n' }]]);
    expect(await clusters()).toEqual([[], '']);
  });

  it('keeps an unreadable kubeconfig apart from one with no contexts', async () => {
    script([], { returncode: 1, stderr: 'error: unable to read kubeconfig' });
    expect(await contexts()).toEqual([[], expect.stringContaining('unable to read kubeconfig')]);

    // THE WHOLE REASON, which names the file twice: cut at 120 characters, a `chmod 000`
    // kubeconfig's read "permission denie" in the API, on the Clusters page and in create.
    const denied =
      'error: error loading config file "/home/laborant/kube-run/config": open ' +
      '/home/laborant/kube-run/config: permission denied';
    script([], { returncode: 1, stderr: denied });
    expect(await contexts()).toEqual([[], denied]);

    script([], { stdout: 'default\nkind-houston-local\n' });
    // Both kubeconfigs are read, and the union is deduped and sorted.
    expect(await contexts()).toEqual([['default', 'kind-houston-local'], '']);
  });

  it('reads the cluster name out of either shape AWS writes', () => {
    expect(shortName('arn:aws:eks:us-east-1:533674205877:cluster/support')).toBe('support');
    expect(shortName('alice@support.us-east-1.eksctl.io')).toBe('support');
    expect(shortName('kind-houston-local')).toBe('kind-houston-local');
  });

  it('accepts a cluster’s own name, and treats two names for one cluster as one', async () => {
    const eksctl = 'alice@support.us-east-1.eksctl.io';
    const arn = 'arn:aws:eks:us-east-1:1:cluster/support';
    script([
      [has('get-contexts'), { stdout: `${eksctl}\n${arn}\n` }],
      [
        has('view'),
        {
          stdout: JSON.stringify({
            clusters: [{ name: 'c', cluster: { server: 'https://api.example' } }],
            contexts: [
              { name: eksctl, context: { cluster: 'c' } },
              { name: arn, context: { cluster: 'c' } },
            ],
          }),
        },
      ],
    ]);
    // The ARN is preferred, because it says which account and region.
    expect(await assertContextKnown('support')).toEqual([arn, '']);
  });

  it('refuses two genuinely different clusters of the same name, naming both', async () => {
    const east = 'arn:aws:eks:us-east-1:1:cluster/support';
    const west = 'arn:aws:eks:eu-west-1:1:cluster/support';
    script([
      [has('get-contexts'), { stdout: `${east}\n${west}\n` }],
      [
        has('view'),
        {
          stdout: JSON.stringify({
            clusters: [
              { name: 'e', cluster: { server: 'https://east' } },
              { name: 'w', cluster: { server: 'https://west' } },
            ],
            contexts: [
              { name: east, context: { cluster: 'e' } },
              { name: west, context: { cluster: 'w' } },
            ],
          }),
        },
      ],
    ]);
    // Silently taking the first is how somebody deletes the wrong one: it refuses, and
    // names both, or the refusal cannot be acted on.
    const refusal = await assertContextKnown('support').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ValidationError);
    expect((refusal as Error).message).toContain('more than one');
    expect((refusal as Error).message).toContain(east);
    expect((refusal as Error).message).toContain(west);
    // And each full name still reaches exactly the one it names.
    expect(await assertContextKnown(east)).toEqual([east, '']);
    expect(await assertContextKnown(west)).toEqual([west, '']);
  });

  it('refuses an unknown context and points at the right remedy', async () => {
    script([[has('get-contexts'), { stdout: 'default\n' }]]);
    await expect(assertContextKnown('typo')).rejects.toThrow(/no kubeconfig context named 'typo'/u);
    // houston's OWN cluster gets the opposite advice, and which of its two forms
    // depends on whether `kind` is installed on the box running the test. Both say the
    // same thing about --context; neither may send the reader to an AWS command about a
    // local kind cluster, which is the defect this split was made for.
    let ownRefusal = '';
    try {
      await assertContextKnown(CONTEXT);
    } catch (error) {
      ownRefusal = (error as Error).message;
    }
    expect(ownRefusal).toContain('the cluster houston builds for itself');
    expect(ownRefusal).not.toContain('aws eks update-kubeconfig');
    expect(
      ownRefusal.includes('run `up` WITHOUT `--context`') ||
        ownRefusal.includes('`kind` is not installed'),
    ).toBe(true);
  });

  it('never plans to CREATE a cluster the caller named', async () => {
    // `up` may bring exactly one kind of cluster into existence, and everything else is
    // somebody else's. This function is reached transitively by the capacity check, so a
    // provider branch here would be a code path on which a capacity check spends money.
    script([
      [has('get-contexts'), { stdout: 'prod\n' }],
      [has('--raw'), { stdout: 'ok' }],
      [has('nodes'), { stdout: 'aws://eu-west-1/i-1 v1.30.0 m5.large ip-10-0-0-1' }],
    ]);
    expect(await planCluster('prod')).toEqual({
      context: 'prod',
      distribution: 'eks',
      create: false,
    });
  });

  it('names which of the four reachability answers refused the plan', async () => {
    script([
      [has('get-contexts'), { stdout: 'prod\n' }],
      [
        has('--raw'),
        { returncode: 1, stderr: 'error: You must be logged in to the server (Unauthorized)' },
      ],
    ]);
    let refusal: unknown;
    try {
      await planCluster('prod');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PreflightError);
    expect((refusal as Error).message).toContain('the cluster is up');
    expect((refusal as Error).message).toContain('create-access-entry');
  });

  it('does not read "kind could not be asked" as "kind has no clusters"', async () => {
    // With kind installed, Docker down and a healthy cluster beside it, planning to
    // CREATE charged for a control plane already running and told a failed create's
    // rollback that the cluster was its to delete.
    script([
      [
        has('get', 'clusters'),
        { returncode: 1, stderr: 'ERROR: Cannot connect to the Docker daemon' },
      ],
      [has('current-context'), { stdout: 'default\n' }],
      [has('--raw'), { stdout: 'ok' }],
      [has('nodes'), { stdout: 'k3s://docker-01 v1.30.0+k3s1 - node' }],
    ]);
    const plan = await planCluster();
    expect(plan.create).toBe(false);
    expect(plan.distribution).toBe('k3s');
  });

  it('identifies a distribution by providerID first, then the kubelet suffix', async () => {
    script([], { stdout: 'kind://docker/houston-local/control v1.30.0 - node' });
    expect(await distribution('x')).toBe('kind');
    script([], { stdout: ' v1.30.0+k3s1 - node' });
    expect(await distribution('x')).toBe('k3s');
    script([], { stdout: ' v1.30.0 - minikube' });
    expect(await distribution('x')).toBe('minikube');
    // A cloud providerID is the most reliable "not a disposable cluster" signal there is.
    script([], { stdout: 'aws:///eu-west-1a/i-0abc v1.31.0-eks-1234 m5' });
    expect(await distribution('arn:aws:eks:x')).toBe('eks');
    // Nothing recognisable is "unknown", and that is a fine answer: a label, never a branch.
    script([], { stdout: ' v1.29.0  somenode' });
    expect(await distribution('x')).toBe('unknown');
    script([], { returncode: 1 });
    expect(await distribution('x')).toBe('unknown');
    expect(await distributionOf('x')).toBe('unknown');
  });

  it('answers false for a distribution it does not recognise', async () => {
    // The question this gates is "may the CA private key leave this box".
    script([[has('config', 'view'), { stdout: 'https://127.0.0.1:6443' }]]);
    expect(await isLocalCluster('kind')).toBe(true);
    expect(await isLocalCluster('K3S', 'default')).toBe(true);
    expect(await isLocalCluster('eks')).toBe(false);
    expect(await isLocalCluster('')).toBe(false);
    expect(await isLocalCluster('unknown')).toBe(false);
  });

  it('asks where a k3s or rke2 server is, since the name does not say', async () => {
    // A `--context` whose server was another machine passed as local on the name alone, and
    // `--https` wrote houston's CA private key into that cluster.
    for (const [server, local] of [
      ['https://127.0.0.1:6443', true],
      ['https://localhost:6443', true],
      ['https://192.0.2.10:6443', false],
    ] as const) {
      script([[has('config', 'view'), { stdout: server }]]);
      expect({ server, local: await isLocalCluster('k3s', 'other') }).toEqual({ server, local });
    }
    // Unreadable is not local: the key stays here.
    script([[has('config', 'view'), { returncode: 1, stderr: 'no context' }]]);
    expect(await isLocalCluster('rke2', 'gone')).toBe(false);
  });

  it('unsets a current-context left pointing at a context it just deleted', async () => {
    script([
      [has('current-context'), { stdout: 'dead\n' }],
      [has('get-contexts'), { stdout: 'default\n' }],
    ]);
    expect(await forgetContext('dead')).toBe(true);
    expect(
      seen.filter((argv) => argv.includes('unset') && argv.includes('current-context')).length,
    ).toBe(2);
  });

  it('reports the active context, or nothing at all', async () => {
    script([], { stdout: ' default \n' });
    expect(await activeContext()).toBe('default');
    script([], { returncode: 1 });
    expect(await activeContext()).toBe('');
  });

  it('maps a context to its API server so two names for one cluster can be seen', async () => {
    script([
      [
        has('view'),
        {
          stdout: JSON.stringify({
            clusters: [{ name: 'c', cluster: { server: 'https://api' } }],
            contexts: [{ name: 'ctx', context: { cluster: 'c' } }],
          }),
        },
      ],
    ]);
    expect(await contextServers()).toEqual([{ ctx: 'https://api' }, '']);
  });
});

describe('tool detection', () => {
  it('reads a version out of each tool’s own spelling', () => {
    expect(parseVersion('kind v0.32.0 go1.26.3 linux/amd64')).toEqual([0, 32, 0]);
    expect(parseVersion('Client Version: v1.36.3')).toEqual([1, 36, 3]);
    expect(parseVersion('v4.2.3+g43e8b7f')).toEqual([4, 2, 3]);
    expect(parseVersion('v4.2')).toEqual([4, 2]);
    expect(parseVersion('no version here')).toEqual([]);
  });

  it('lets an unparseable version pass rather than blocking a working tool', () => {
    expect(newEnough(makeTool({ name: 'kubectl', path: '/usr/bin/kubectl' }))).toBe(true);
    expect(newEnough(makeTool({ name: 'kubectl', path: '/x', version: [1, 20, 0] }))).toBe(false);
    expect(newEnough(makeTool({ name: 'kubectl', path: '/x', version: [1, 21, 0] }))).toBe(true);
    expect(newEnough(makeTool({ name: 'kubectl', path: '/x', version: [1, 36, 3] }))).toBe(true);
    expect(newEnough(makeTool({ name: 'unknown-tool', path: '/x', version: [0, 1] }))).toBe(true);
  });

  it('treats no information as "I have no idea", never as yes', () => {
    // every() over nothing is true, so a Preflight carrying no tool information at all
    // claimed every tool was ready.
    expect(toolsReady(preflight())).toBe(false);
    expect(canProvision(preflight())).toBe(false);
    expect(canProvisionCloud(preflight())).toBe(false);
    expect(usable(preflight({ clusterReachable: true }))).toBe(false);

    const ready = preflight({
      clusterReachable: true,
      tools: {
        kubectl: makeTool({ name: 'kubectl', path: '/x', version: [1, 36] }),
        helm: makeTool({ name: 'helm', path: '/x', version: [3, 15] }),
      },
    });
    expect(toolsReady(ready)).toBe(true);
    expect(usable(ready)).toBe(true);
    expect(canProvision(ready)).toBe(false); // no kind
  });

  it('sorts a semver-ish string with non-numeric parts low', () => {
    expect(versionKey('8.5.1')).toEqual([8, 5, 1]);
    expect(versionKey('latest')).toEqual([-1]);
    expect(versionKey('8.0rc1')).toEqual([8, 0]);
  });
});

describe('the MongoDB replica set', () => {
  const sleep = () => Promise.resolve();

  it('waits for the container to have STARTED, not to be ready', async () => {
    // Readiness needs the replica set initiated, and this IS the initiation. Waiting on
    // readiness made the whole create a coin flip.
    let started = 0;
    script(
      [
        [
          has('jsonpath={.status.containerStatuses[0].started}'),
          // answered by the handler below
          {},
        ],
      ],
      {},
    );
    kube.run = (argv) => {
      if (argv.includes('jsonpath={.status.containerStatuses[0].started}')) {
        started += 1;
        return Promise.resolve({
          argv,
          returncode: 0,
          stdout: started >= 3 ? 'true' : 'false',
          stderr: '',
        });
      }
      if (argv.includes('db.hello().isWritablePrimary')) {
        return Promise.resolve({ argv, returncode: 0, stdout: 'true', stderr: '' });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };

    const events: Event[] = [];
    await initReplicaSet({
      namespace: 'houston-x',
      context: 'prod',
      emit: (ev) => events.push(ev),
      sleep,
    });
    expect(started).toBe(3);
    expect(events.map((ev) => ev.message)).toContain('replica set ready');
  });

  it('retries a connection refused, which is what a cold cluster answers', async () => {
    // The retry predicate was an allow-list of ONE error, so ECONNREFUSED returned on the
    // first attempt and failed the whole create -- reproduced twice out of two on a
    // freshly installed k3s.
    let execs = 0;
    kube.run = (argv) => {
      if (argv.includes('jsonpath={.status.containerStatuses[0].started}')) {
        return Promise.resolve({ argv, returncode: 0, stdout: 'true', stderr: '' });
      }
      if (argv.includes('mongosh')) {
        execs += 1;
        if (execs === 1) {
          return Promise.resolve({
            argv,
            returncode: 1,
            stdout: '',
            stderr: 'MongoNetworkError: connect ECONNREFUSED 127.0.0.1:27017',
          });
        }
        return Promise.resolve({ argv, returncode: 0, stdout: 'true', stderr: '' });
      }
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };
    await initReplicaSet({ namespace: 'houston-x', context: 'prod', sleep });
    expect(execs).toBeGreaterThan(1);
  });

  it('is a known-dead failure when the pod never starts', async () => {
    script([], { returncode: 0, stdout: 'false' });
    await expect(
      initReplicaSet({ namespace: 'houston-x', context: 'prod', sleep }),
    ).rejects.toBeInstanceOf(CreateFailedError);
  });
});

describe('naming a cluster the way people name it', () => {
  it('resolves a cluster’s short name, its full name and a short context alike', async () => {
    // `--context support`, not the forty-eight character ARN every single time. Nobody
    // types that; they paste it, and pasting the wrong one is the failure this guards
    // against everywhere else.
    const east = 'arn:aws:eks:us-east-1:1:cluster/support';
    const west = 'arn:aws:eks:eu-west-1:1:cluster/perf';
    route((joined) =>
      joined.startsWith('kubectl config get-contexts')
        ? { stdout: `${east}\n${west}\ndefault\n` }
        : undefined,
    );
    expect((await assertContextKnown('support'))[0]).toBe(east);
    expect((await assertContextKnown(east))[0]).toBe(east);
    expect((await assertContextKnown('default'))[0]).toBe('default');
    expect((await assertContextKnown('perf'))[0]).toBe(west);
    // An unknown name is still a typo, not a resolution.
    await expect(assertContextKnown('nope')).rejects.toThrow(/no kubeconfig context named/u);
  });

  it('passes a name through untouched when the kubeconfig cannot be read', async () => {
    // "I could not ask" is not "absent": a transient kubectl failure must not be reported
    // to the user as a typo in their cluster name.
    route((joined) =>
      joined.startsWith('kubectl config get-contexts')
        ? { returncode: 1, stderr: 'permission denied' }
        : undefined,
    );
    expect(await assertContextKnown('support')).toEqual(['support', 'permission denied']);
  });
});

describe('planning which cluster a create uses', () => {
  it('differs between kind and k3s only in whether a cluster is built', async () => {
    // `up --runtime kubernetes` could only ever use a cluster houston built itself, so on a
    // box running k3s `doctor` said "Using your cluster 'default'" and `up` refused to use
    // it. Provisioning is the ONE step that differs.
    probeWorld({ kind: true, ourCluster: true, active: 'default' });
    expect(await planCluster()).toEqual({ context: CONTEXT, distribution: 'kind', create: false });

    // kind, no cluster yet: build ours, and the k3s box is IGNORED -- an existing cluster
    // elsewhere never takes the choice away from a box that can make its own.
    probeWorld({ kind: true, ourCluster: false, active: 'default' });
    expect(await planCluster()).toEqual({ context: CONTEXT, distribution: 'kind', create: true });

    // No kind: skip provisioning and use what kubectl points at.
    probeWorld({ kind: false, ourCluster: false, active: 'default' });
    expect(await planCluster()).toEqual({ context: 'default', distribution: 'k3s', create: false });

    // No kind and nothing reachable: refuse, and the message is true.
    probeWorld({ kind: false, ourCluster: false, active: '' });
    await expect(planCluster()).rejects.toThrow(/not pointed at one either/u);
  });

  it('adopts a named context and never provisions it, even with kind installed', async () => {
    // `--context` cannot build anything. `planCluster` is reached by `checkCapacity`, so a
    // `create: true` an explicit context could produce would be a code path on which a
    // CAPACITY CHECK spends money. The box is the one that made this necessary: kind
    // installed and no cluster of ours yet, so the un-named call plans a BUILD.
    probeWorld({
      kind: true,
      ourCluster: false,
      active: 'default',
      known: ['default', 'eks-support'],
    });
    expect((await planCluster()).create).toBe(true);
    const plan = await planCluster('eks-support');
    expect([plan.context, plan.create]).toEqual(['eks-support', false]);
  });

  it('refuses an unknown context by naming the ones that exist', async () => {
    // A typo is argument validation, so it refuses with the list rather than probing.
    probeWorld({
      kind: true,
      ourCluster: false,
      active: 'default',
      known: ['default', 'eks-support'],
    });
    const refusal = await planCluster('eks-suport').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ValidationError);
    expect((refusal as Error).message).toContain('eks-suport');
    expect((refusal as Error).message).toContain('eks-support');
  });

  it('does not read an unreadable kubeconfig as a context that is not there', async () => {
    // The reachability probe is the real test and answers for itself.
    probeWorld({
      kind: true,
      ourCluster: false,
      active: 'default',
      unreadable: 'permission denied',
    });
    const plan = await planCluster('eks-support');
    expect([plan.context, plan.create]).toEqual(['eks-support', false]);
  });

  it('refuses a named context that does not answer, and keeps why the list failed', async () => {
    probeWorld({
      kind: true,
      ourCluster: false,
      active: 'default',
      answers: false,
      unreadable: 'kubeconfig unreadable',
    });
    const refusal = await planCluster('eks-support').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PreflightError);
    // WHICH kind of unreachable, and the cause the kubeconfig gave, not thrown away.
    expect((refusal as Error).message).toContain('nothing answered');
    expect((refusal as Error).message).toContain('kubeconfig unreadable');
  });

  it('tells a refused context what to do about THAT context', async () => {
    // Both refusals used to end in `aws eks update-kubeconfig`, which is right for the case
    // `--context` was built for and actively wrong for houston's OWN kind cluster, where
    // the answer is to stop passing `--context`. Measured on a fresh HOUSTON_HOME.
    const message = async (context: string) =>
      ((await planCluster(context).catch((error: unknown) => error)) as Error).message;

    // Ours, absent, and kind is here to build it.
    probeWorld({ kind: true, ourCluster: false, active: 'default', known: ['default'] });
    await expect(planCluster(CONTEXT)).rejects.toBeInstanceOf(ValidationError);
    expect(await message(CONTEXT)).toContain('WITHOUT');
    expect(await message(CONTEXT)).toContain('--context');
    expect(await message(CONTEXT)).not.toContain('aws eks update-kubeconfig');

    // Ours, absent, and no kind to build it with -- a different remedy.
    probeWorld({ kind: false, ourCluster: false, active: 'default', known: ['default'] });
    await expect(planCluster(CONTEXT)).rejects.toBeInstanceOf(ValidationError);
    expect(await message(CONTEXT)).toContain('Install kind');

    // Somebody else's cluster, absent: the AWS hint is right here and stays.
    probeWorld({ kind: true, ourCluster: false, active: 'default', known: ['default'] });
    expect(await message('my-eks')).toContain('aws eks update-kubeconfig');

    // Ours, PRESENT in the kubeconfig but not answering -- same remedy, other error, and
    // no advice to debug kubectl against a cluster houston would build.
    probeWorld({
      kind: true,
      ourCluster: false,
      active: 'default',
      answers: false,
      known: [CONTEXT, 'default'],
    });
    await expect(planCluster(CONTEXT)).rejects.toBeInstanceOf(PreflightError);
    expect(await message(CONTEXT)).toContain('WITHOUT');
    expect(await message(CONTEXT)).not.toContain('get nodes');

    // Somebody else's, present but not answering: debug it, and `aws` is named because an
    // EKS kubeconfig cannot authenticate without it.
    await expect(planCluster('default')).rejects.toBeInstanceOf(PreflightError);
    expect(await message('default')).toContain('get nodes');
    expect(await message('default')).toContain('`aws` on PATH');
  });

  it('finds the cluster houston made by asking IT, not by asking kind', async () => {
    // `clusterExists` needed the kind BINARY, so uninstalling kind while its cluster still
    // ran made the cluster invisible -- node containers holding memory nothing in houston
    // could see or remove.
    probeWorld({ kind: false, ourCluster: true, active: 'default' });
    const plan = await planCluster();
    expect([plan.context, plan.create]).toEqual([CONTEXT, false]);
  });

  it('never plans an existing cluster as one to create, whatever this home knows', async () => {
    // A fresh HOUSTON_HOME facing a cluster that already exists planned to create one: the
    // capacity check charged for a control plane already running, and a failed create's
    // rollback was told the cluster was its to delete. `create` follows the CLUSTER.
    probeWorld({ kind: true, ourCluster: true, active: '', answers: false });
    const plan = await planCluster();
    expect([plan.context, plan.create]).toEqual([CONTEXT, false]);
    probeWorld({ kind: true, ourCluster: false, active: '', answers: false });
    expect((await planCluster()).create).toBe(true); // and a missing one still is
  });

  it('tells doctor WHICH cluster is not answering', async () => {
    // `planCluster` refuses both for "no kind and no kubeconfig" and for "kubectl is
    // pointed at 'X', which is not answering", and dropping the reason left `context` empty
    // for both -- so doctor sent somebody whose cluster IS configured to configure another.
    probeWorld({
      kind: false,
      ourCluster: false,
      active: 'my-prod',
      answers: false,
      tools: ['kubectl'],
    });
    const pre = await probePreflight();
    expect(pre.context).toBe('my-prod');
    expect(pre.clusterReachable).toBe(false);
    expect(pre.willCreate).toBe(false);

    // Where there genuinely is no cluster, it is still empty -- the right message there.
    probeWorld({ kind: false, ourCluster: false, active: '', answers: false, tools: ['kubectl'] });
    expect((await probePreflight()).context).toBe('');
  });

  it('forgets a context without taking away a pointer at a different one', async () => {
    // The unset is conditional on `current-context` naming the context being forgotten; an
    // unconditional one would answer "no cluster" on a box pointed at a good one.
    route((joined) => {
      if (joined === 'kubectl config current-context') return { stdout: 'default' };
      if (joined.startsWith('kubectl config get-contexts')) return { stdout: 'default\n' };
      return undefined;
    });
    await forgetContext('arn:aws:eks:us-east-1:1:cluster/support');
    expect(
      calls.some(({ argv }) => argv.join(' ') === 'kubectl config unset current-context'),
    ).toBe(false);
  });

  it('derives isolation from the TARGET, and reads discovery from the user’s own config', async () => {
    // `own` is never passed by hand, so forgetting it is not a thing that can happen. The
    // discovery path stays ambient, because reading the cluster you already configured is
    // the entire point of it.
    route(() => ({ stdout: 'ok' }));
    await reachable(CONTEXT); // ours -> isolated
    await reachable('k3s-default'); // theirs -> ambient
    expect(calls[0]?.options.own).toBe(true);
    expect(calls[1]?.options.own).toBe(false);

    route(() => ({ stdout: 'default' }));
    await activeContext();
    expect(Boolean(calls[0]?.options.own)).toBe(false);
  });
});

describe('what this box can do with Kubernetes', () => {
  const realCloud = tuning.CLOUD_PROVISION_TOOLS;
  afterEach(() => {
    tuning.CLOUD_PROVISION_TOOLS = realCloud;
  });

  it('never lets a cloud tool switch off local provisioning, or stand in for itself', () => {
    // `canProvision` is an every() over its registry, so the registry decides who it
    // breaks: a cloud tool beside kind would make it false on every box that has kind and
    // no AWS tooling -- and the GUI reads it to say "Kubernetes (kind)".
    const kindOnly = {
      kind: makeTool({ name: 'kind', path: '/usr/bin/kind', version: [0, 32] }),
      kubectl: makeTool({ name: 'kubectl', path: '/usr/bin/kubectl', version: [1, 36] }),
      helm: makeTool({ name: 'helm', path: '/usr/bin/helm', version: [4, 2] }),
    };
    tuning.CLOUD_PROVISION_TOOLS = { eksctl: [0, 195] };
    expect(canProvision(preflight({ tools: { ...kindOnly } }))).toBe(true);
    // And the cloud answer is its own question.
    expect(canProvisionCloud(preflight({ tools: { ...kindOnly } }))).toBe(false);

    const withCloud = {
      ...kindOnly,
      eksctl: makeTool({ name: 'eksctl', path: '/usr/bin/eksctl', version: [0, 200] }),
    };
    expect(canProvisionCloud(preflight({ tools: withCloud }))).toBe(true);

    // An EMPTY cloud registry is false: "no cloud tooling compiled in" must never read as
    // "yes, this box builds EKS".
    tuning.CLOUD_PROVISION_TOOLS = {};
    expect(canProvisionCloud(preflight({ tools: { ...kindOnly } }))).toBe(false);
  });

  it('asks eksctl for its version the way eksctl spells it', async () => {
    // Two correct behaviours combine into a floor that never fires: `--version` fails on a
    // cobra tool, the parse of the error is empty, and an empty version is new enough by
    // design. So a tool probed with the wrong flag passes its floor silently.
    installTools('eksctl');
    route((_joined, argv) =>
      argv.length === 2 && argv[1] === '--version'
        ? { returncode: 1, stderr: 'unknown flag: --version' }
        : { stdout: '0.195.0' },
    );
    const found = await tool('eksctl');
    expect(calls.at(-1)?.argv).toEqual(['eksctl', 'version']);
    expect(found.version).toEqual([0, 195, 0]);
    // The hazard itself, stated so the reason for the mapping is not lost: an unparsed
    // version is not a failed floor, it is a PASSED one.
    expect(newEnough(makeTool({ name: 'x', path: '/x', version: [] }))).toBe(true);
  });

  it('stops before asking a cluster that is not there', async () => {
    // Asking an absent API server for storage classes would time out, and the timeout
    // would be reported as "no storage" -- a wrong answer that sends someone to fix the
    // wrong thing.
    installTools('kind', 'kubectl', 'helm');
    route((joined) =>
      joined.includes('get clusters') ? { stdout: 'kind\n' } : { stdout: 'v1.0.0' },
    );
    const pre = await probePreflight();
    expect(pre.clusterExists).toBe(false);
    expect(pre.otherClusters).toEqual(['kind']);
    expect(calls.some(({ argv }) => argv.includes('storageclass'))).toBe(false);
  });

  it('asks each tool for its version one at a time, in the order earlier releases list the tools', async () => {
    // Earlier releases ask each tool after the last has answered, in the order of their tool
    // table. `Promise.all` started all four at once, so `helm version --short` reached the log
    // before `kubectl version --client` on some runs and not on others.
    // The order of earlier releases' tool table, recorded.
    const order = ['kubectl', 'helm', 'kind', 'eksctl'];
    installTools(...order);
    const seen: string[] = [];
    kube.run = async (argv) => {
      const [name = ''] = argv;
      if (argv[1] !== 'version' || !order.includes(name)) {
        return { argv, returncode: 1, stdout: '', stderr: 'no stub' };
      }
      seen.push(`asked ${name}`);
      // An answer that takes a moment, so a probe started beside it is seen to start.
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(`answered ${name}`);
      return { argv, returncode: 0, stdout: 'v1.30.0', stderr: '' };
    };
    await probePreflight();
    expect(seen.slice(0, 2 * order.length)).toEqual(
      order.flatMap((name) => [`asked ${name}`, `answered ${name}`]),
    );
    expect(order.slice(0, 2)).toEqual(['kubectl', 'helm']);
  });

  it('uses a cluster without kind, because kind only CREATES clusters', async () => {
    // Namespaces, releases, PVCs, port-forwards and exec are plain Kubernetes, so a box with
    // kubectl and helm and no kind is fully usable -- it just has to be pointed at a
    // cluster. The first cut returned early without kind, and a good k3s box looked empty.
    installTools('kubectl', 'helm');
    fakeRun([
      ['config current-context', 0, 'k3s-default\n'],
      ['/readyz', 0, 'ok'],
      [
        'get storageclass',
        0,
        JSON.stringify({
          items: [
            {
              metadata: {
                name: 'local-path',
                annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
              },
            },
          ],
        }),
      ],
      ['get namespace', 0, ''],
      ['version', 0, 'v9.9.9'],
    ]);
    const pre = await probePreflight();
    expect(toolsReady(pre)).toBe(true); // kubectl + helm is all that USING it needs
    expect(canProvision(pre)).toBe(false); // without kind it cannot create one
    expect(missingTools(pre)).toEqual([]); // and a missing kind is not a missing requirement
    expect(pre.context).toBe('k3s-default');
    expect(pre.provider).toBe(PROVIDER_EXTERNAL);
    expect(pre.clusterReachable).toBe(true);
    expect(usable(pre)).toBe(true);
    expect(pre.defaultStorageClass).toBe('local-path');
  });

  it('refuses to create a cluster without kind, and names the alternative', async () => {
    const refusal = await ensureCluster().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PreflightError);
    expect((refusal as PreflightError).message).toContain(
      'point kubectl at a cluster you already have',
    );
    expect((refusal as PreflightError).exitCode).toBe(3);
  });

  it('is not an error to delete a cluster that is not there', async () => {
    // `prune` calls this unconditionally; a missing cluster is the state it wanted.
    installTools('kind');
    route((joined) =>
      joined.includes('get clusters') ? { stdout: 'somebody-else\n' } : undefined,
    );
    expect(await deleteCluster()).toBe(false);
  });

  it('does not report a missing helm as an unreachable cluster', async () => {
    // There is a tools check for that already, and two rows about one binary is how a
    // reader learns to distrust both.
    route(() => ({ returncode: 1 }));
    expect(await helmReachable('default')).toBe('');
    expect(calls).toEqual([]); // it must not run a missing helm
  });
});

describe('the replica set after a restart', () => {
  it('forces the persisted config back when a restarted member is left REMOVED', async () => {
    // A down/up cycle can leave MongoDB in REMOVED after its self-DNS raced startup. The PVC
    // still holds an initialized set, so calling `rs.initiate()` again is not enough: force
    // the one-member config and require a writable primary before Rocket.Chat scales up.
    let hello = 0;
    const scripts: string[] = [];
    route((joined, argv) => {
      if (joined.includes('jsonpath')) return { stdout: 'true' };
      const at = argv.indexOf('--eval');
      if (at < 0) return undefined;
      const script = String(argv[at + 1]);
      scripts.push(script);
      if (script.includes('isWritablePrimary')) {
        hello += 1;
        return { stdout: hello > 6 ? 'true' : 'false' };
      }
      if (script.includes('reconfig')) return { stdout: '1' };
      return { stderr: 'already initialized' };
    });
    const said: string[] = [];
    await initReplicaSet({
      namespace: 'ns',
      context: 'c',
      emit: (event) => said.push(event.message),
      sleep: () => Promise.resolve(),
    });
    expect(scripts).toContain('rs.reconfig(rs.conf(), {force:true})');
    expect(said.some((message) => message.includes('recovered after restart'))).toBe(true);
  });
});

describe('the pieces a cluster is missing', () => {
  it('installs the guide’s own ingress chart, and waits for it without --wait', async () => {
    // `helm install traefik traefik/traefik -n traefik --create-namespace` is the official
    // guide's own example, so a cluster houston filled in looks like one somebody followed
    // the guide on. The chart's Service type is LEFT ALONE: on a cluster with a provider it
    // gets an address, on one without it stays `<pending>` while NodePorts are allocated.
    let looks = 0;
    route((joined) => {
      if (joined.includes('get ingressclass')) {
        looks += 1;
        return {
          stdout: JSON.stringify({ items: looks === 1 ? [] : [{ metadata: { name: 'traefik' } }] }),
        };
      }
      if (joined.startsWith('helm list')) return { stdout: '[]' };
      // A local k3s: its API server on loopback (`isLocalCluster`).
      if (joined.includes('config view')) return { stdout: 'https://127.0.0.1:6443' };
      return undefined;
    });
    expect(
      await ensureIngress({ context: 'c', distribution: 'k3s', sleep: () => Promise.resolve() }),
    ).toBe('traefik');
    const helm = calls.find(({ argv }) => argv.includes('upgrade'))?.argv ?? [];
    expect(helm.slice(0, 4)).toEqual(['helm', 'upgrade', '--install', 'traefik']);
    expect(helm).toContain('traefik/traefik');
    expect(helm).toContain('--create-namespace');
    expect(helm.some((arg) => arg.startsWith('service.type'))).toBe(false);
    // AND NO `--wait`, NOR THE ROLLBACK FLAG THAT IMPLIES IT. Helm's readiness check for a
    // LoadBalancer Service waits for an address, so on a cluster with no provider `--wait`
    // cannot succeed on exactly the cluster being installed into -- measured on k3s with
    // `--disable servicelb`, five minutes and then a rollback over three healthy pods.
    expect(helm).not.toContain('--wait');
    expect(helm).not.toContain('--atomic');
    expect(helm).not.toContain('--rollback-on-failure');
    // The controller still has to be waited for, just not through helm.
    expect(
      calls.some(
        ({ argv }) => argv[0] === 'kubectl' && argv[1] === '--context' && argv.includes('rollout'),
      ),
    ).toBe(true);
  });

  it('installs a storage class only when none is default, and never on a read it could not make', async () => {
    // EKS ships `gp2` on the in-tree provisioner and marks nothing default, so every PVC
    // would stay Pending. But a cluster that already HAS a default has been set up by
    // somebody, and replacing their choice is not this command's business.
    const context = 'arn:aws:eks:us-east-1:1:cluster/x';
    const cluster = (classes: unknown) =>
      route((joined) => {
        if (joined.startsWith('kubectl config get-contexts')) return { stdout: `${context}\n` };
        if (joined.includes('get storageclass')) return classes as Partial<KubectlResult>;
        if (joined.includes('get ingressclass')) {
          return { stdout: JSON.stringify({ items: [{ metadata: { name: 'traefik' } }] }) };
        }
        if (joined.includes('get crd')) return { stdout: 'certificates.cert-manager.io\n' };
        if (joined.includes('get svc')) {
          return {
            stdout: JSON.stringify({
              items: [
                {
                  metadata: { namespace: 'traefik', name: 'traefik' },
                  spec: { type: 'LoadBalancer', ports: [{ port: 443 }] },
                  status: { loadBalancer: { ingress: [{ hostname: 'elb.aws' }] } },
                },
              ],
            }),
          };
        }
        return undefined;
      });
    const applied = () =>
      calls
        .filter(({ argv }) => argv.includes('apply'))
        .map(({ options }) => String(options.input ?? ''));

    // Nothing default: install, on the CSI provisioner rather than the in-tree one.
    cluster({ stdout: JSON.stringify({ items: [{ metadata: { name: 'gp2' } }] }) });
    const out = await prepareCluster(context);
    expect(out.storage_class).toBe('gp3');
    expect(applied()[0]).toContain('ebs.csi.aws.com');
    expect(applied()[0]).toContain('is-default-class');
    // Binding before the pod lands puts the volume in the wrong availability zone.
    expect(applied()[0]).toContain('WaitForFirstConsumer');
    expect(out.cname_target).toBe('elb.aws');

    // One already default: adopt it and touch nothing.
    cluster({
      stdout: JSON.stringify({
        items: [
          { metadata: { name: 'gp2' } },
          {
            metadata: {
              name: 'mine',
              annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
            },
          },
        ],
      }),
    });
    const adopted = await prepareCluster(context);
    expect(adopted.storage_class).toBe('mine');
    expect(applied()).toEqual([]);
    expect(adopted.already).toContain("storage class 'mine'");

    // A refused read is not "none default" -- that would install a second default into a
    // cluster whose classes houston could not see.
    cluster({
      returncode: 1,
      stderr: 'Error from server (Forbidden): storageclasses is forbidden',
    });
    await expect(prepareCluster(context)).rejects.toBeInstanceOf(PreflightError);
  });

  it('prepares a cluster named by its short name, and reports the context it used', async () => {
    // `--context support` is the form `cluster create` prints and the guide teaches; the
    // context is really the ARN, which nobody types. MEASURED on a fresh cluster: `cluster
    // prepare --context support` failed in 0.27s -- too fast to have asked AWS anything --
    // calling it "a permissions problem on the credential in your kubeconfig". It had passed
    // the raw argument to kubectl while `cluster status` resolved short names all along.
    const arn = 'arn:aws:eks:us-east-1:1:cluster/support';
    route((joined, argv) => {
      if (joined.startsWith('kubectl config get-contexts')) return { stdout: `${arn}\ndefault\n` };
      // Everything below answers only for the RESOLVED name, exactly as a kubeconfig does:
      // the short name is not a context, and kubectl refuses it.
      if (!argv.includes(arn)) return { returncode: 1, stderr: 'context "support" does not exist' };
      if (joined.includes('get storageclass')) {
        return {
          stdout: JSON.stringify({
            items: [
              { metadata: { name: 'gp2' } },
              {
                metadata: {
                  name: 'gp3',
                  annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
                },
              },
            ],
          }),
        };
      }
      if (joined.includes('get ingressclass')) {
        return { stdout: JSON.stringify({ items: [{ metadata: { name: 'traefik' } }] }) };
      }
      if (joined.includes('get crd')) return { stdout: 'certificates.cert-manager.io\n' };
      if (joined.includes('get svc')) {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: { namespace: 'traefik', name: 't' },
                spec: { type: 'LoadBalancer', ports: [{ port: 443 }] },
                status: { loadBalancer: { ingress: [{ hostname: 'elb.aws' }] } },
              },
            ],
          }),
        };
      }
      return undefined;
    });
    const out = await prepareCluster('support');
    // And the result reports the context it used.
    expect(out.context).toBe(arn);
    expect(out.storage_class).toBe('gp3');
    // The CNAME target is the one line an operator needs to finish the job.
    expect(out.cname_target).toBe('elb.aws');
  });
});
