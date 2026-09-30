import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as OsNS from 'node:os';

import * as config from '../../../src/lib/config';
import { CreateFailedError, DockerError } from '../../../src/lib/errors';
import type { Event } from '../../../src/lib/events';
import { LAUNCH_FAILURE_CODE, kubectl, type KubectlResult } from '../../../src/seams/kubectl';

import { ensureCluster } from '../../../src/core/kube/cluster';
import { activeContext } from '../../../src/core/kube/context';
import { portClaimingCluster } from '../../../src/core/kube/endpoints';
import {
  envFor,
  helmEnv,
  kube,
  ownedEnv,
  ownedKubeconfig,
  userEnv,
  type RunOptions,
} from '../../../src/core/kube/exec';
import { scenarioUiForwards } from '../../../src/core/kube/forward';
import { CONTEXT } from '../../../src/core/kube/names';
import { namespaceLabels } from '../../../src/core/kube/namespace';
import { helmReachable } from '../../../src/core/kube/reachability';
import { releaseValues } from '../../../src/core/kube/release';
import { initReplicaSet } from '../../../src/core/kube/replicaset';
import { podRows, terminalPodFailure, workspaceReady } from '../../../src/core/kube/status';

// `os.homedir()` IS NATIVE, and under Jest `process.env` is the test file's own copy, so
// setting HOME here never reaches it -- measured, it went on answering this machine's home.
// The one thing `userEnv` asks of `os` is therefore answered by the file, the way a
// changed HOME answers it in a real process.
let mockHomedir: string | null = null;
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof OsNS>('node:os');
  return { ...actual, homedir: () => mockHomedir ?? actual.homedir() };
});

const realRun = kubectl.run;
const realKubeRun = kube.run;
const realPath = process.env.PATH;

/** Every call the scripted funnel saw, with the options it was given. */
let calls: { argv: string[]; options: RunOptions }[] = [];

/**
 * Script `kube.run`, the one property every sibling reaches the cluster through. `answer`
 * sees the joined argv, the argv and the options, and returns a reply or undefined for the
 * fallback.
 */
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

/**
 * Stand-ins for the named tools, first on PATH, in a directory this test owns.
 *
 * `kube/tools.which` is a PATH lookup and the suite answers every cloud tool ABSENT unless a test
 * built one -- so this is the saying. The funnel is scripted wherever these are used, so none of
 * them is ever executed.
 */
let toolDir = '';
function installTools(...names: string[]): void {
  toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-tools-'));
  for (const name of names) {
    fs.writeFileSync(path.join(toolDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  process.env.PATH = `${toolDir}${path.delimiter}${realPath ?? ''}`;
}

const sleep = () => Promise.resolve();

afterEach(() => {
  kubectl.run = realRun;
  kube.run = realKubeRun;
  delete process.env.KUBECONFIG;
  mockHomedir = null;
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  if (toolDir !== '') fs.rmSync(toolDir, { recursive: true, force: true });
  toolDir = '';
});

describe('houston’s own client state', () => {
  it('keeps its kubeconfig and every Helm home under HOUSTON_HOME', () => {
    // `kind create cluster` writes ~/.kube/config AND switches current-context to the
    // cluster it just made. Without this, creating a workspace silently redirects the
    // user's own kubectl.
    const env = ownedEnv();
    expect(env.KUBECONFIG).toBe(ownedKubeconfig());
    expect(ownedKubeconfig().startsWith(config.home())).toBe(true);
    for (const name of [
      'HELM_CACHE_HOME',
      'HELM_CONFIG_HOME',
      'HELM_DATA_HOME',
      'HELM_REPOSITORY_CONFIG',
      'HELM_REPOSITORY_CACHE',
    ]) {
      expect(String(env[name]).startsWith(config.home())).toBe(true);
    }
    // The directories exist, and privately: a kubeconfig carries cluster credentials.
    expect(fs.statSync(path.dirname(ownedKubeconfig())).mode & 0o777).toBe(0o700);
  });

  it('gives Helm houston’s homes even on a cluster houston does not own', () => {
    // Conflating the two was a real defect: on an adopted cluster the chart repo went
    // into houston's Helm home while the install that needed it read the user's, and the
    // create failed at 60% with "repo rocketchat not found" after the namespace, the
    // operator and MongoDB had all been built.
    process.env.KUBECONFIG = '/somewhere/else/config';
    const foreign = helmEnv('arn:aws:eks:eu-west-1:1234:cluster/prod');
    expect(foreign.KUBECONFIG).toBe('/somewhere/else/config');
    expect(String(foreign.HELM_CONFIG_HOME).startsWith(config.home())).toBe(true);
    // The repo (`ensureRepo`, which runs owned) and the install must read ONE
    // repositories.yaml, whoever owns the cluster -- every Helm home, not only the config.
    const owned = ownedEnv();
    for (const name of [
      'HELM_CACHE_HOME',
      'HELM_CONFIG_HOME',
      'HELM_DATA_HOME',
      'HELM_REPOSITORY_CONFIG',
      'HELM_REPOSITORY_CACHE',
    ]) {
      expect([name, foreign[name]]).toEqual([name, owned[name]]);
    }

    const ours = helmEnv(CONTEXT);
    expect(ours.KUBECONFIG).toBe(ownedKubeconfig());
  });

  it('leaves helm with no KUBECONFIG at all when the caller had none', () => {
    delete process.env.KUBECONFIG;
    expect('KUBECONFIG' in helmEnv('some-other-cluster')).toBe(false);
  });
});

describe('the user’s own client state', () => {
  it('obeys an explicitly set KUBECONFIG untouched', () => {
    // An operator who has SET it has said which files they mean.
    process.env.KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
    expect(userEnv()).toBeUndefined();
  });

  it('names the standard path when nothing else has been said', () => {
    // MEASURED on a box where this diverges: `kubectl` was a symlink to k3s, whose
    // embedded client reads /etc/rancher/k3s/k3s.yaml when KUBECONFIG is unset, while
    // `aws eks update-kubeconfig` had just written the cluster into ~/.kube/config. The
    // context existed, was correct, and was invisible.
    //
    // A HOME OF THE TEST'S OWN, so both halves run on every box rather than whichever
    // one this machine's ~/.kube happens to select.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-home-'));
    try {
      fs.mkdirSync(path.join(home, '.kube'));
      mockHomedir = home;
      delete process.env.KUBECONFIG;
      // A missing ~/.kube/config is left alone rather than forced, because pointing
      // kubectl at a file that does not exist would take away whatever default it has.
      expect(userEnv()).toBeUndefined();

      const standard = path.join(home, '.kube', 'config');
      fs.writeFileSync(standard, 'apiVersion: v1\n');
      expect(userEnv()?.KUBECONFIG).toBe(standard);

      // And it is only for clusters houston does NOT own: its own kubeconfig still wins.
      expect(ownedEnv().KUBECONFIG).not.toBe(standard);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('names the file earlier releases name, whatever HOME is spelled as', () => {
    // With HOME set but EMPTY `os.homedir()` is '', and this handed kubectl
    // `KUBECONFIG=.kube/config` -- a RELATIVE path, so whichever kubeconfig sat in the
    // working directory, where earlier releases look at `/.kube/config`. The working directory
    // holds a decoy, and the rows are `lib/home.ts`'s. The file's mock answers
    // `os.homedir()` with HOME verbatim, as the native call does (`lib/home.test.ts`
    // checks that premise against real processes).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-home-'));
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-kube-cwd-'));
    const cwd = process.cwd();
    try {
      for (const dir of [home, decoy]) {
        fs.mkdirSync(path.join(dir, '.kube'));
        fs.writeFileSync(path.join(dir, '.kube', 'config'), 'apiVersion: v1\n');
      }
      delete process.env.KUBECONFIG;
      const rows = ['', '/', '//', `${home}/`, `${home}//`];
      process.chdir(decoy);
      const ours = rows.map((row) => {
        mockHomedir = row;
        return userEnv()?.KUBECONFIG ?? null;
      });
      // What earlier releases named for each row, from the same decoy, recorded with this
      // run's home in place of the one it was recorded in.
      const recorded = [null, null, null, `${home}/.kube/config`, `${home}/.kube/config`];
      expect(ours).toEqual(recorded);
      // And the rows that CAN hold one named it: the comparison is not all nulls.
      const standard = path.join(home, '.kube', 'config');
      expect(ours.slice(3)).toEqual([standard, standard]);
    } finally {
      process.chdir(cwd);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('names the file the kernel names when HOME walks back out of a symlink', () => {
    // Earlier releases join `.kube/config` onto HOME and keep a `..` for the kernel, which
    // follows `link` first: with `link -> other/sub`, HOME `<box>/link/../u` is
    // `<box>/other/u`. `path.join` folded it to `<box>/u`, found no file, and handed kubectl
    // nothing where earlier releases hand it `<box>/link/../u/.kube/config`.
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-kube-link-')));
    try {
      fs.mkdirSync(path.join(box, 'other', 'sub'), { recursive: true });
      fs.symlinkSync('other/sub', path.join(box, 'link'));
      fs.mkdirSync(path.join(box, 'other', 'u', '.kube'), { recursive: true });
      fs.writeFileSync(path.join(box, 'other', 'u', '.kube', 'config'), 'apiVersion: v1\n');
      delete process.env.KUBECONFIG;
      const rows = [`${box}/link/../u`, `${box}/link/../u/`];
      const ours = rows.map((row) => {
        mockHomedir = row;
        return userEnv()?.KUBECONFIG ?? null;
      });
      // What earlier releases named for each row, over the same link, recorded with this
      // run's box in place of the one it was recorded in.
      const recorded = [`${box}/link/../u/.kube/config`, `${box}/link/../u/.kube/config`];
      expect(ours).toEqual(recorded);
      expect(ours).toEqual([`${box}/link/../u/.kube/config`, `${box}/link/../u/.kube/config`]);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });

  it('picks the environment from the context, at ONE site', () => {
    // The rule was written out at eight call sites and a fix to it reached exactly one.
    expect(envFor(CONTEXT)?.KUBECONFIG).toBe(ownedKubeconfig());
    process.env.KUBECONFIG = '/somewhere/else/config';
    expect(envFor('not-ours')).toBeUndefined();
  });
});

describe('the funnel', () => {
  it('never throws, and reports a launch failure as a return code', async () => {
    // A preflight that raised on a missing binary would have to be wrapped at every call
    // site, and one forgotten wrapper takes down `doctor` -- the command someone runs
    // precisely because things are already wrong.
    const result = await kube.run(['houston-kubectl-that-is-not-installed', 'version']);
    expect(result.returncode).toBe(LAUNCH_FAILURE_CODE);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });

  it('applies the probe timeout in seconds and the ownership-derived environment', async () => {
    const seen: { argv: readonly string[]; options: Record<string, unknown> }[] = [];
    kubectl.run = (argv, options = {}) => {
      seen.push({ argv, options: options as Record<string, unknown> });
      return Promise.resolve({ argv, returncode: 0, stdout: '', stderr: '' });
    };

    await kube.run(['kubectl', 'get', 'ns'], { own: true, timeout: 3 });
    expect(seen[0]?.options.timeoutMs).toBe(3_000);
    expect((seen[0]?.options.env as NodeJS.ProcessEnv).KUBECONFIG).toBe(ownedKubeconfig());

    await kube.run(['kubectl', 'get', 'ns']);
    expect(seen[1]?.options.timeoutMs).toBe(8_000);
  });

  it('is the one injectable dependency, on an exported object', async () => {
    // Emitted TypeScript cannot replace a module-local binding, so the callable lives on
    // an object. Earlier releases did the same thing for the same reason.
    kubectl.run = () =>
      Promise.resolve({ argv: [], returncode: 42, stdout: 'injected', stderr: '' });
    expect((await kube.run(['kubectl'])).stdout).toBe('injected');
  });

  it('is replaced for a SIBLING too, which is what makes it the seam', async () => {
    // The seam's contract: a patched property intercepts another module's function
    // without reaching kubectl. A sibling that captured the function at import time would
    // go on running the real one while every test that patched the property passed.
    route((joined) =>
      joined.includes('current-context') ? { stdout: 'portable-context\n' } : undefined,
    );
    expect(await activeContext()).toBe('portable-context');
    expect(calls[0]?.argv).toEqual(['kubectl', 'config', 'current-context']);
  });
});

describe('creating houston’s own cluster', () => {
  beforeEach(() => installTools('kind'));

  it('takes a create that lost a race as success, and any other failure as terminal', async () => {
    // Somebody ran `kind create cluster --name houston-local` by hand while we held the
    // lock. "already exist" means the thing we wanted is true.
    route((joined, argv) => {
      if (joined.includes('get clusters')) return { stdout: '' };
      if (joined.includes('current-context')) return { stdout: CONTEXT };
      if (joined.includes('/readyz')) return { stdout: 'ok' };
      if (argv.includes('create')) {
        return { returncode: 1, stderr: 'node(s) already exist for a cluster with the name' };
      }
      return undefined;
    });
    expect(await ensureCluster()).toBe(CONTEXT);

    // A create that fails for any OTHER reason is terminal, and says why.
    route((joined, argv) => {
      if (joined.includes('get clusters')) return { stdout: '' };
      if (argv.includes('create')) return { returncode: 1, stderr: 'ERROR: failed to pull image' };
      return undefined;
    });
    const refusal = await ensureCluster().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CreateFailedError);
    // The reason must reach the user, and it is known dead rather than "poll again".
    expect((refusal as CreateFailedError).message).toContain('failed to pull image');
    expect((refusal as CreateFailedError).exitCode).toBe(7);
  });
});

describe('the MongoDB replica set, from the outside', () => {
  it('initiates the set and VERIFIES it, rather than trusting an exit code', async () => {
    // `--replSet rs0` only puts mongod IN replica-set mode. Without rs.initiate() there is
    // no primary, nothing can write, and Rocket.Chat waits forever -- a real workspace did
    // for 540 seconds, at 5 pods, with nothing in Rocket.Chat's logs naming MongoDB.
    const scripts: string[] = [];
    route((joined, argv) => {
      if (joined.includes('jsonpath')) return { stdout: 'true' };
      const at = argv.indexOf('--eval');
      if (at < 0) return undefined;
      const script = String(argv[at + 1]);
      scripts.push(script);
      return { stdout: script === 'rs.status().ok' ? '1' : '' };
    });
    await initReplicaSet({ namespace: 'houston-t', context: CONTEXT, sleep });
    expect(scripts.some((script) => script.includes('rs.initiate'))).toBe(true);
    expect(scripts).toContain('rs.status().ok');
    // And every mongosh call carries the direct URI: the probe cannot complete a handshake
    // against an uninitiated set any other way.
    for (const call of calls.filter(({ argv }) => argv.includes('mongosh'))) {
      expect(call.argv.join(' ')).toContain('directConnection=true');
    }

    // A set that is already initiated is success, not failure.
    route((joined, argv) => {
      if (joined.includes('jsonpath')) return { stdout: 'true' };
      const at = argv.indexOf('--eval');
      if (at < 0) return undefined;
      if (argv[at + 1] === 'rs.status().ok') return { stdout: '1' };
      return { returncode: 1, stderr: 'already initialized' };
    });
    await expect(
      initReplicaSet({ namespace: 'houston-t', context: CONTEXT, sleep }),
    ).resolves.toBeUndefined();
  });

  it('survives a terminating pod by retrying, and does not retry a real error', async () => {
    // `containerStatuses[0].started` is still true for a TERMINATING pod, so a re-create
    // can pass the wait and exec into a pod on its way out: "unable to upgrade connection:
    // container not found (mongod)". A one-shot exec turns that race into a failed create.
    let initiations = 0;
    route((joined, argv) => {
      if (joined.includes('jsonpath')) return { stdout: 'true' };
      const at = argv.indexOf('--eval');
      if (at < 0) return undefined;
      const script = String(argv[at + 1]);
      if (script.includes('rs.initiate')) {
        initiations += 1;
        if (initiations < 3) {
          return {
            returncode: 1,
            stderr: 'unable to upgrade connection: container not found ("mongod")',
          };
        }
        return { stdout: '' };
      }
      return { stdout: script.includes('isWritablePrimary') ? 'true' : '1' };
    });
    await initReplicaSet({ namespace: 'houston-k', context: CONTEXT, sleep });
    expect(initiations).toBe(3);

    // A different failure is NOT retried -- that would just delay a real error.
    initiations = 0;
    route((joined, argv) => {
      if (joined.includes('jsonpath')) return { stdout: 'true' };
      if (!argv.includes('--eval')) return undefined;
      initiations += 1;
      return { returncode: 1, stderr: 'authentication failed' };
    });
    await expect(
      initReplicaSet({ namespace: 'houston-k', context: CONTEXT, sleep }),
    ).rejects.toBeInstanceOf(CreateFailedError);
    expect(initiations).toBe(1);
  });
});

describe('a scenario’s published UI', () => {
  it('waits for a ready endpoint, and never forwards to a backend that is not answering', async () => {
    // `kubectl port-forward` binds a local socket at once and only then dials a pod, so a
    // forward started while Keycloak was still importing its realm passed a local TCP
    // check and failed upstream: "published at http://localhost:8081", then connection
    // refused a minute later.
    route((joined) => {
      if (joined.includes('get svc')) return { stdout: 'kc 8081 8080\n' };
      // Never ready.
      if (joined.includes('endpointslices')) return { stdout: JSON.stringify({ items: [] }) };
      return undefined;
    });
    const events: Event[] = [];
    const out = await scenarioUiForwards('w', {
      namespace: 'houston-w',
      context: CONTEXT,
      emit: (event) => events.push(event),
      sleep,
    });
    expect(out).toEqual({});
    // It must actually retry rather than check once.
    expect(
      calls.filter(({ argv }) => argv.includes('endpointslices')).length,
    ).toBeGreaterThanOrEqual(10);
    // And it says how to publish it once it is up, instead of starting a forward.
    expect(events.map((event) => event.message).join('\n')).toContain('has no ready endpoint yet');
    expect(calls.some(({ argv }) => argv.includes('port-forward'))).toBe(false);
  });
});

describe('reads that must not raise', () => {
  it('lists no pods rather than raising when the cluster is asleep', async () => {
    // `detail()` is on the path of every panel open, so this may never raise: a workspace
    // whose cluster is unreachable still has to render.
    route(() => ({ returncode: 1, stderr: 'connection refused' }));
    expect(await podRows('k', { context: 'c' })).toEqual([]);
  });

  it('reads a release with no values of its own as an empty values file', async () => {
    // `helm get values` answers the literal string `null` for a release installed with no
    // values. Reading that as a failure would refuse every upgrade of such a release.
    route(() => ({ stdout: 'null' }));
    expect(await releaseValues('rocketchat', 'ns', 'c')).toEqual({});

    // A refused read is still refused: not knowing the values is not there being none,
    // and upgrading on {} would erase the release's whole configuration.
    route(() => ({ returncode: 1, stderr: 'Error: release: not found' }));
    await expect(releaseValues('rocketchat', 'ns', 'c')).rejects.toBeInstanceOf(DockerError);
  });
});

describe('helm is a second client', () => {
  it('reports what helm SAID, not a boolean', async () => {
    // "helm cannot reach the cluster" sends a reader to the cluster; `x509: certificate
    // signed by unknown authority` sends them to the kubeconfig, which is where the
    // problem actually was.
    installTools('helm');
    route((joined) =>
      joined.startsWith('helm list')
        ? {
            returncode: 1,
            stderr:
              'Error: kubernetes cluster unreachable: x509: certificate signed by unknown authority\n',
          }
        : undefined,
    );
    expect(await helmReachable('default')).toBe(
      'Error: kubernetes cluster unreachable: x509: certificate signed by unknown authority',
    );
    route((joined) => (joined.startsWith('helm list') ? { returncode: 1 } : undefined));
    expect(await helmReachable('default')).not.toBe(''); // non-empty == a problem

    route(() => ({ returncode: 0 }));
    expect(await helmReachable('default')).toBe(''); // a working helm says nothing
  });
});

describe('the port-claim probe on the way to starting the edge', () => {
  it('costs nothing on a box with no kubectl, and carries its short timeout otherwise', async () => {
    // This runs on the way to starting a proxy. Four probes at the 8s default is half a
    // minute added to `edge start` on an ordinary laptop whose kubeconfig points at an
    // unreachable remote cluster, and a Docker-only box must not pay for it at all.
    route(() => {
      throw new Error('no kubectl on this box — nothing should have been run');
    });
    expect(await portClaimingCluster()).toBeNull();
    expect(calls).toEqual([]);

    installTools('kubectl');
    route((joined) => {
      if (joined.includes('/readyz')) return { stdout: 'ok' };
      if (joined.includes('get svc')) return { stdout: JSON.stringify({ items: [] }) };
      return { returncode: 1 };
    });
    expect(await portClaimingCluster({ timeout: 3 })).toBeNull();
    // Discovery of the active context is the one call the caller does not time: earlier
    // releases' version of this left it out of the count for the same reason.
    const probes = calls.filter(({ argv }) => !argv.includes('current-context'));
    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(probes.map(({ options }) => options.timeout)).toEqual(probes.map(() => 3));
  });
});

describe('the workload, read through the funnel', () => {
  /** A `get pod -o json` answer: per pod, its container ready flags -- none means Pending. */
  const pods = (...specs: [string, boolean[] | null][]) => ({
    stdout: JSON.stringify({
      items: specs.map(([name, flags]) => ({
        metadata: { name },
        status:
          flags === null
            ? { phase: 'Pending' }
            : { phase: 'Running', containerStatuses: flags.map((ready) => ({ ready })) },
      })),
    }),
  });

  it('speaks for every probed pod, not just the first', async () => {
    // `ready` read items[0].containerStatuses[0] and over-claimed twice: with --replicas N
    // it inspected ONE pod, and it only ever looked at the monolith -- while `ddp-streamer`,
    // which carries the WebSocket, was seen Running-but-not-Ready on a workspace already
    // called serving. account/authorization/presence ship with no readinessProbe, so their
    // Ready flag attests nothing and waiting on it would buy no confidence.
    route(() => pods(['rc-0', [true]]));
    expect(await workspaceReady('w', { context: 'c' })).toBe(true);
    const argv = calls.at(-1)?.argv ?? [];
    const selector = String(argv[argv.indexOf('-l') + 1]);
    expect(selector).toContain('rocketchat');
    expect(selector).toContain('rocketchat-ddp-streamer');
    for (const unprobed of ['account', 'authorization', 'presence']) {
      expect([unprobed, selector.includes(`rocketchat-${unprobed}`)]).toEqual([unprobed, false]);
    }

    // THE items[0] BUG: three replicas, the third not ready.
    route(() => pods(['rc-0', [true]], ['rc-1', [true]], ['rc-2', [false]]));
    expect(await workspaceReady('w', { context: 'c' })).toBe(false);
    // THE MICROSERVICES BUG: Rocket.Chat ready, ddp-streamer not.
    route(() => pods(['rc-0', [true]], ['rc-ddp-streamer-0', [false]]));
    expect(await workspaceReady('w', { context: 'c' })).toBe(false);
    // A Pending pod has NO containerStatuses; "nothing failed" is not "ready".
    route(() => pods(['rc-0', [true]], ['rc-ddp-0', null]));
    expect(await workspaceReady('w', { context: 'c' })).toBe(false);
    // No pods at all is a torn-down workspace, not a ready one.
    route(() => pods());
    expect(await workspaceReady('w', { context: 'c' })).toBe(false);
    // A sidecar that is not ready counts, even when the app container is.
    route(() => pods(['rc-0', [true, false]]));
    expect(await workspaceReady('w', { context: 'c' })).toBe(false);
    // And kubectl failing is not readiness.
    route(() => ({ returncode: 1 }));
    expect(await workspaceReady('w', { context: 'c' })).toBe(false);
  });

  it('stops waiting for a pod that cannot start, and never on a read it could not make', async () => {
    // A mistyped version cost the full 600s, then blamed the timeout. `ImagePullBackOff` is
    // a REASON, not a phase, and a pod pulling slowly looks identical at the phase level --
    // so the reason decides, and anything unrecognised keeps waiting.
    const waiting = (...states: [string, string, string][]) => ({
      stdout: JSON.stringify({
        items: states.map(([name, reason, message]) => ({
          metadata: { name },
          status: { containerStatuses: [{ state: { waiting: { reason, message } } }] },
        })),
      }),
    });
    route(() =>
      waiting(['rocketchat-abc', 'ErrImagePull', 'manifest for rocket.chat:9.9.9 not found']),
    );
    const found = await terminalPodFailure('w', { context: 'c' });
    expect(found?.slice(0, 2)).toEqual(['rocketchat-abc', 'ErrImagePull']);
    // The registry's own words, not a paraphrase.
    expect(found?.[2]).toContain('9.9.9');

    // Still starting is NOT terminal -- the false positive that fails every slow pull.
    route(() =>
      waiting(['rocketchat-abc', 'ContainerCreating', ''], ['mongodb-0', 'PodInitializing', '']),
    );
    expect(await terminalPodFailure('w', { context: 'c' })).toBeNull();
    // Neither is a healthy pod with no waiting state at all.
    route(() => ({
      stdout: JSON.stringify({
        items: [
          { metadata: { name: 'rc' }, status: { containerStatuses: [{ state: { running: {} } }] } },
        ],
      }),
    }));
    expect(await terminalPodFailure('w', { context: 'c' })).toBeNull();
    // An unreadable cluster is not evidence of failure, and neither is a garbled answer.
    route(() => ({ returncode: 1 }));
    expect(await terminalPodFailure('w', { context: 'c' })).toBeNull();
    route(() => ({ stdout: 'not json' }));
    expect(await terminalPodFailure('w', { context: 'c' })).toBeNull();

    // An init container counts: MongoDB's fix-permission container runs there.
    route(() => ({
      stdout: JSON.stringify({
        items: [
          {
            metadata: { name: 'mongodb-0' },
            status: {
              initContainerStatuses: [
                {
                  state: {
                    waiting: { reason: 'CreateContainerConfigError', message: 'secret missing' },
                  },
                },
              ],
            },
          },
        ],
      }),
    }));
    expect((await terminalPodFailure('w', { context: 'c' }))?.[1]).toBe(
      'CreateContainerConfigError',
    );
  });

  it('does not read a kubeconfig error as an absent namespace', async () => {
    // kubectl says "Error in configuration: context was not found for specified context"
    // for a bad --context, and the first cut's `"not found" in text` read that as absence
    // -- the "I could not ask" case this exists to separate, reintroduced by a sloppy
    // match. Measured: `deleteNamespace` answered "nothing there" for a cluster it never
    // reached. Only the API server says `Error from server (NotFound)`.
    route(() => ({
      returncode: 1,
      stderr:
        'Error in configuration: context was not found for specified context: no-such-context',
    }));
    await expect(
      namespaceLabels('houston-x', { context: 'no-such-context' }),
    ).rejects.toBeInstanceOf(DockerError);
    route(() => ({
      returncode: 1,
      stderr: 'Error from server (NotFound): namespaces "houston-x" not found',
    }));
    expect(await namespaceLabels('houston-x', { context: 'c' })).toBeNull();
  });
});
