/**
 * INVARIANT: the orderings earlier releases asserted about their own source text.
 *
 * MECHANISM: BEHAVIOURAL SPY.
 *
 * Earlier releases' ordering guards each compared two offsets in a string. That is a claim
 * about TEXT, and it breaks in both directions: a refactor that moves one call into a helper
 * reports the property GONE while the sequence is unchanged -- which happened six times and is
 * why those guards grew helpers that followed calls into other functions at all -- and a call
 * written twice, or inside a branch that never runs, reads as present when it is not.
 *
 * Each test drives the real orchestrator, with the real seam replaced by a recorder, and
 * asserts the sequence that actually happened together with the arguments that identify
 * it. `at()` throws rather than returning -1 when a call it is ordering never happened, so
 * a spy the production path bypassed fails loudly instead of ordering an empty list.
 *
 * THE MOCK REGISTRY IS RESTORED PER TEST, and that is not housekeeping. A `jest.doMock`
 * survives `jest.resetModules()`: an earlier test's stub of `create-k8s` stayed installed
 * for a later one here and made it assert against an empty recorder while passing its own
 * setup. `withSeams` pairs every `doMock` with a `dontMock`, so a scenario cannot inherit
 * another's stub.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as fsPromisesNS from 'node:fs/promises';
import type * as nodeFsNS from 'node:fs';
import type * as nodeOsNS from 'node:os';
import type * as nodePathNS from 'node:path';

import type * as BackupNS from '../../../src/core/backup';
import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as CreateK8sNS from '../../../src/core/lifecycle/create-k8s';
import type * as KubeExecNS from '../../../src/core/kube/exec';
import type * as KubeReleaseNS from '../../../src/core/kube/release';
import type * as RunnerPathsNS from '../../../src/core/runner/paths';

import { nullEmit } from '../../../src/lib/events';
import { createReq } from '../../../src/core/lifecycle/types';

/** One ordered log of everything the production path reached. */
function recorder(): { calls: string[]; at: (name: string) => number } {
  const calls: string[] = [];
  return {
    calls,
    at(name: string): number {
      const index = calls.indexOf(name);
      if (index < 0) {
        throw new Error(
          `${name} was never called, so there is no order to assert. ` +
            `What ran was: ${calls.join(' -> ') || '(nothing)'}`,
        );
      }
      return index;
    },
  };
}

/** Install module stubs for one scenario and take them back out again. */
async function withSeams(
  seams: Record<string, () => unknown>,
  body: () => Promise<void>,
): Promise<void> {
  jest.resetModules();
  for (const [module, factory] of Object.entries(seams)) jest.doMock(module, factory);
  try {
    await body();
  } finally {
    for (const module of Object.keys(seams)) jest.dontMock(module);
    jest.resetModules();
  }
}

function actual(module: string): Record<string, unknown> {
  return jest.requireActual(module) as Record<string, unknown>;
}

/** The program an exec runs, past an `env VAR=value` prefix. */
function commandOf(argv: readonly string[]): string {
  return String(argv.find((word) => word !== 'env' && !word.includes('=')));
}

describe('a Compose create attaches the edge after the workspace is up', () => {
  it('writes the record, starts the workspace, and only then joins its network', async () => {
    const log = recorder();
    await withSeams(
      {
        '../../../src/core/runner/record': () => ({
          ...actual('../../../src/core/runner/record'),
          write: async () => {
            log.calls.push('record.write');
          },
        }),
        '../../../src/lib/compose': () => ({
          ...actual('../../../src/lib/compose'),
          toYaml: () => 'services: {}\n',
        }),
        '../../../src/core/lifecycle/ready': () => ({
          ...actual('../../../src/core/lifecycle/ready'),
          upCompose: async () => {
            log.calls.push('upCompose');
            return 0;
          },
        }),
        '../../../src/core/edge/networks': () => ({
          ...actual('../../../src/core/edge/networks'),
          attach: async (name: string) => {
            log.calls.push(`attach:${name}`);
          },
        }),
      },
      async () => {
        const createDocker =
          require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
        const plan = createDocker.createPlan({
          req: createReq({ version: '8.5.1', name: 'orderw' }),
          emit: nullEmit,
        });
        plan.reproName = 'orderw';
        plan.doc = { services: {} } as never;
        plan.meta = { name: 'orderw' } as never;
        plan.resolved = { rcVersion: '8.5.1', mongoTag: '8.0', mongoFlavor: 'official' } as never;
        plan.pre = { name: 'default' } as never;
        // A TLS spec is what makes the attach happen at all; without it the step returns
        // before the call this test is about and the assertion would be vacuous.
        plan.tlsspec = { mode: 'local', host: 'orderw.houston.localhost' } as never;

        await createDocker.startTheWorkspace(plan);

        expect(log.calls).toEqual(['record.write', 'upCompose', 'attach:orderw']);
        expect(log.at('upCompose')).toBeLessThan(log.at('attach:orderw'));
      },
    );
  });

  it('joins no network at all when the workspace terminates no name', async () => {
    const log = recorder();
    await withSeams(
      {
        '../../../src/core/runner/record': () => ({
          ...actual('../../../src/core/runner/record'),
          write: async () => {
            log.calls.push('record.write');
          },
        }),
        '../../../src/lib/compose': () => ({
          ...actual('../../../src/lib/compose'),
          toYaml: () => 'services: {}\n',
        }),
        '../../../src/core/lifecycle/ready': () => ({
          ...actual('../../../src/core/lifecycle/ready'),
          upCompose: async () => {
            log.calls.push('upCompose');
            return 0;
          },
        }),
        '../../../src/core/edge/networks': () => ({
          ...actual('../../../src/core/edge/networks'),
          attach: async () => {
            log.calls.push('attach');
          },
        }),
      },
      async () => {
        const createDocker =
          require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
        const plan = createDocker.createPlan({
          req: createReq({ version: '8.5.1', name: 'plainw' }),
          emit: nullEmit,
        });
        plan.reproName = 'plainw';
        plan.doc = { services: {} } as never;
        plan.meta = { name: 'plainw' } as never;
        plan.resolved = { rcVersion: '8.5.1', mongoTag: '8.0', mongoFlavor: 'official' } as never;
        plan.pre = { name: 'default' } as never;
        plan.tlsspec = null;

        await createDocker.startTheWorkspace(plan);
        expect(log.calls).toEqual(['record.write', 'upCompose']);
      },
    );
  });
});

describe('a Kubernetes create is refused before it builds anything', () => {
  it('reaches the refusal from the create path, and nothing downstream runs', async () => {
    const log = recorder();
    await withSeams(
      {
        '../../../src/core/lifecycle/preconditions': () => ({
          ...actual('../../../src/core/lifecycle/preconditions'),
          refuseUnsupportedOnKubernetes: () => {
            log.calls.push('refuseUnsupportedOnKubernetes');
            throw new Error('refused for this test');
          },
        }),
        '../../../src/core/kube/context': () => ({
          ...actual('../../../src/core/kube/context'),
          planCluster: async () => {
            log.calls.push('planCluster');
            return { context: 'ctx', distribution: 'k3s', create: false };
          },
        }),
        '../../../src/core/runner/record': () => ({
          ...actual('../../../src/core/runner/record'),
          write: async () => {
            log.calls.push('record.write');
          },
        }),
      },
      async () => {
        const createDocker =
          require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
        await expect(
          createDocker.createReproLocked(
            createReq({ version: '8.5.1', name: 'kubew', runtime: 'kubernetes' }),
            nullEmit,
          ),
        ).rejects.toThrow('refused for this test');
        // THE REFUSAL IS ON THE PATH, and nothing the Kubernetes create would have done
        // ran. Asserting the refusal happened is not enough on its own: a guard called
        // AFTER the cluster was planned would still be "reached from the create path".
        expect(log.calls).toEqual(['refuseUnsupportedOnKubernetes']);
      },
    );
  });
});

describe('a Kubernetes create records, routes, builds, then proves', () => {
  // KUBECTL AND HELM ARE INSTALLED, AND THE CONTEXT ANSWERS NOTHING -- said by the test.
  //
  // This case used to borrow both facts from the machine: the tool preflight passed because
  // this box has real `kubectl` and `helm`, and `kubectl --context ctx get --raw /readyz`
  // then failed for real because no `ctx` context exists here. Measured on a PATH without
  // the tools, the create was refused as "kubectl, helm is not installed" and the case
  // failed. `test/testsetup-cloud.ts` now answers every tool absent unless the test built a
  // stand-in under the temp root, so these stand-ins state what the real ones used to: a
  // version when asked, and a failure for every question about the cluster.
  let toolDir = '';
  const realPath = process.env.PATH;

  beforeEach(() => {
    toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-k8s-tools-'));
    const fake = (name: string, version: string) =>
      fs.writeFileSync(
        path.join(toolDir, name),
        `#!/bin/sh\ncase "$1" in version) echo '${version}'; exit 0;; esac\n` +
          `echo 'error: context "ctx" does not exist' >&2\nexit 1\n`,
        { mode: 0o755 },
      );
    fake('kubectl', 'Client Version: v1.36.3');
    fake('helm', 'v4.2.3+g43e8b7f');
    process.env.PATH = `${toolDir}${path.delimiter}${realPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = realPath;
    fs.rmSync(toolDir, { recursive: true, force: true });
  });

  it('drives the whole sequence and records what actually ran, in order', async () => {
    const log = recorder();
    await withSeams(
      {
        // THE HOST'S FREE MEMORY, STATED. `settleName` runs the capacity preflight, which
        // reads what this box has free -- so under a loaded suite the create was refused
        // and this ordering test failed for a reason that has nothing to do with ordering.
        // Observed as a 1-in-4 failure across full runs before it was pinned.
        '../../../src/core/lifecycle/sizing': () => ({
          ...actual('../../../src/core/lifecycle/sizing'),
          checkCapacity: async () => undefined,
        }),
        '../../../src/core/kube/context': () => ({
          ...actual('../../../src/core/kube/context'),
          planCluster: async () => ({ context: 'ctx', distribution: 'k3s', create: false }),
          ensureKubeconfig: async () => undefined,
        }),
        '../../../src/core/kube/reachability': () => ({
          ...actual('../../../src/core/kube/reachability'),
          helmReachable: async () => '',
        }),
        '../../../src/core/kube/namespace': () => ({
          ...actual('../../../src/core/kube/namespace'),
          assertNamespaceAvailable: async (name: string) => {
            log.calls.push(`assertNamespaceAvailable:${name}`);
          },
        }),
        '../../../src/core/runner/record': () => ({
          ...actual('../../../src/core/runner/record'),
          writeRecord: async (name: string) => {
            log.calls.push(`writeRecord:${name}`);
          },
          readMeta: async () => {
            throw new Error('no record');
          },
        }),
        '../../../src/core/lifecycle/tlsplan': () => ({
          ...actual('../../../src/core/lifecycle/tlsplan'),
          kubernetesTlsPlan: async () => ({
            host: 'kw.houston.localhost',
            ingressClass: 'traefik',
            endpoint: {
              address: '172.16.0.2',
              port: 443,
              kind: 'loadbalancer',
              service: 'kube-system/traefik',
              ready: true,
            },
            clusterOwns443: false,
          }),
          routeKubernetesName: async (name: string) => {
            log.calls.push(`routeKubernetesName:${name}`);
          },
          publishKubernetesName: async (name: string) => {
            log.calls.push(`publishKubernetesName:${name}`);
          },
        }),
        '../../../src/core/kube/workspace': () => ({
          ...actual('../../../src/core/kube/workspace'),
          createWorkspace: async (options: { name: string }) => {
            log.calls.push(`createWorkspace:${options.name}`);
            return {
              context: 'ctx',
              namespace: 'houston-kw',
              chart_version: '7.0.0',
              release: 'rocketchat',
              port_forward_pid: 0,
              bind_host: '127.0.0.1',
              certificate_ready: true,
            };
          },
        }),
      },
      async () => {
        const createK8s = require('../../../src/core/lifecycle/create-k8s') as typeof CreateK8sNS;
        await createK8s.createKubernetes(
          createReq({
            version: '8.5.1',
            name: 'kw',
            runtime: 'kubernetes',
            https: true,
            offline: true,
          }),
          nullEmit,
        );

        // THE SEQUENCE, not two offsets in a file. Each of these was its own guard in earlier
        // releases, comparing text positions inside a function the steps have since moved out of.
        expect(log.calls).toEqual([
          'assertNamespaceAvailable:kw',
          'writeRecord:kw',
          'routeKubernetesName:kw',
          'createWorkspace:kw',
          'publishKubernetesName:kw',
        ]);
        // Spelled out, so a reordering names the promise that broke.
        expect(log.at('assertNamespaceAvailable:kw')).toBeLessThan(log.at('writeRecord:kw'));
        expect(log.at('routeKubernetesName:kw')).toBeLessThan(log.at('createWorkspace:kw'));
        expect(log.at('createWorkspace:kw')).toBeLessThan(log.at('publishKubernetesName:kw'));
      },
    );
  });
});

describe('a private key is never written at the umask', () => {
  it('chmods the temporary file before the rename, never the target afterwards', async () => {
    const log = recorder();
    const fsPromises = jest.requireActual('node:fs/promises') as typeof fsPromisesNS;
    await withSeams(
      {
        'node:fs/promises': () => ({
          ...fsPromises,
          chmod: async (target: string, mode: number) => {
            log.calls.push(`chmod:${String(mode)}`);
            return await fsPromises.chmod(target, mode);
          },
          rename: async (from: string, to: string) => {
            log.calls.push('rename');
            return await fsPromises.rename(from, to);
          },
          writeFile: async (target: string, data: string) => {
            log.calls.push('writeFile');
            return await fsPromises.writeFile(target, data);
          },
        }),
      },
      async () => {
        const paths = require('../../../src/core/runner/paths') as typeof RunnerPathsNS;
        const os = require('node:os') as typeof nodeOsNS;
        const nodePath = require('node:path') as typeof nodePathNS;
        const fs = require('node:fs') as typeof nodeFsNS;
        const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'houston-invariant-'));
        try {
          const target = nodePath.join(dir, 'k.key');
          await paths.atomicWrite(target, 'secret', { mode: 0o600 });
          // The mode is applied to the TEMP file, so the target never exists at the umask
          // even for an instant -- the property a source read could only ever claim about
          // the order two lines appear in.
          // Spelled as a labelled comparison so a failure SAYS which order broke rather
          // than printing two integers.
          expect(`chmod before rename: ${String(log.at('chmod:384') < log.at('rename'))}`).toBe(
            'chmod before rename: true',
          );
          expect(`written before chmod: ${String(log.at('writeFile') < log.at('chmod:384'))}`).toBe(
            'written before chmod: true',
          );
          expect(fs.statSync(target).mode & 0o777).toBe(0o600);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });
});

describe('a restore records the window where the database is empty', () => {
  it('journals the drop BEFORE dropping, and clears the note only on a clean load', async () => {
    const log = recorder();
    let cleared: string[] = [];
    const seams = (loadRc: number) => ({
      '../../../src/core/journal': () => ({
        ...actual('../../../src/core/journal'),
        record: (kind: string, workspace: string, detail: Record<string, unknown>) => {
          log.calls.push(`journal.record:${kind}:${String(detail.bundle)}`);
          return `note-${kind}`;
        },
        clear: (note: string) => {
          log.calls.push(`journal.clear:${note}`);
          cleared.push(note);
        },
      }),
      // THE REAL DOCKER SEAM, not a helper beside it. `dropDatabase` and the restore both
      // reach the workspace through `runner/engine`, so recording here cannot be bypassed
      // by moving either call into another function.
      '../../../src/core/runner/engine': () => ({
        ...actual('../../../src/core/runner/engine'),
        composeExecCapture: async (_name: string, _service: string, argv: readonly string[]) => {
          log.calls.push(`exec:${commandOf(argv)}`);
          return [0, ''];
        },
        composeExecFromFile: async (_name: string, _service: string, argv: readonly string[]) => {
          log.calls.push(`exec:${commandOf(argv)}`);
          return [loadRc, loadRc === 0 ? '' : 'mongorestore blew up'];
        },
        stopServices: async () => 0,
        startServices: async () => 0,
      }),
      '../../../src/core/runner/record': () => ({
        ...actual('../../../src/core/runner/record'),
        readMeta: async (name: string) => ({
          name,
          project: `houston-${name}`,
          rcVersion: '8.5.1',
          mongoTag: '8.0',
          mongoFlavor: 'official',
          extra: {},
        }),
      }),
    });

    // A CLEAN LOAD: the note is written first and taken away afterwards.
    await withSeams(seams(0), async () => {
      const backup = require('../../../src/core/backup') as typeof BackupNS;
      const enter = jest
        .spyOn(backup.Quiesced.prototype, 'enter')
        .mockImplementation(async function (this: BackupNS.Quiesced) {
          return this;
        });
      const exit = jest
        .spyOn(backup.Quiesced.prototype, 'exit')
        .mockImplementation(async () => undefined);
      try {
        await backup.restoreArchive({
          database: 'rocketchat',
          emit: nullEmit,
          manifest: { database: 'rocketchat' },
          bundle: '/b/x.rcbak',
          services: ['rocketchat'],
          target: 'w',
          archive: '/tmp/x.archive',
        });
      } finally {
        enter.mockRestore();
        exit.mockRestore();
      }
      expect(log.calls).toEqual([
        'journal.record:database_dropped:/b/x.rcbak',
        'exec:mongosh',
        'exec:mongorestore',
        'journal.clear:note-database_dropped',
      ]);
      expect(log.at('journal.record:database_dropped:/b/x.rcbak')).toBeLessThan(
        log.at('exec:mongosh'),
      );
    });

    // A FAILED LOAD: the note SURVIVES, because the workspace really is empty and
    // somebody has to be told which bundle to put back.
    log.calls.length = 0;
    cleared = [];
    await withSeams(seams(1), async () => {
      const backup = require('../../../src/core/backup') as typeof BackupNS;
      const enter = jest
        .spyOn(backup.Quiesced.prototype, 'enter')
        .mockImplementation(async function (this: BackupNS.Quiesced) {
          return this;
        });
      const exit = jest
        .spyOn(backup.Quiesced.prototype, 'exit')
        .mockImplementation(async () => undefined);
      try {
        await expect(
          backup.restoreArchive({
            database: 'rocketchat',
            emit: nullEmit,
            manifest: { database: 'rocketchat' },
            bundle: '/b/x.rcbak',
            services: ['rocketchat'],
            target: 'w',
            archive: '/tmp/x.archive',
          }),
        ).rejects.toThrow('mongorestore failed');
      } finally {
        enter.mockRestore();
        exit.mockRestore();
      }
      expect(cleared).toEqual([]);
      expect(log.calls).toEqual([
        'journal.record:database_dropped:/b/x.rcbak',
        'exec:mongosh',
        'exec:mongorestore',
      ]);
    });
  });
});

describe('a shared helm release is freed before it is installed into', () => {
  /**
   * The verbs that decide what a release IS. `helm version --short` runs beside these to
   * pick the rollback flag and says nothing about the order being asserted, so recording
   * it would make this test fail on an unrelated and legitimate probe.
   */
  const MUTATING = new Set(['list', 'rollback', 'uninstall', 'upgrade']);

  /**
   * The helm conversation one call had with the cluster, in order.
   *
   * `kube.run` is swapped on the seam OBJECT rather than through a module factory, which
   * is the idiom the rest of this suite uses, and the object earlier releases' tests replaced
   * the call on too. `const kube = { run }` exists for exactly that: replacing the
   * module's `run` export would leave this object holding the original.
   */
  async function helmConversation(status: string, revision: number): Promise<string[]> {
    const seen: string[] = [];
    const exec = require('../../../src/core/kube/exec') as typeof KubeExecNS;
    const release = require('../../../src/core/kube/release') as typeof KubeReleaseNS;
    const original = exec.kube.run;
    exec.kube.run = async (argv: readonly string[]) => {
      if (MUTATING.has(String(argv[1]))) seen.push(argv.slice(0, 3).join(' '));
      if (argv[0] === 'helm' && argv[1] === 'list') {
        // A release a killed helm left half-applied. This is the state the whole recovery
        // exists for, so the test has to actually be in it.
        return {
          argv,
          returncode: 0,
          stdout: JSON.stringify([{ name: 'rocketchat', status, revision }]),
          stderr: '',
        };
      }
      return { argv, returncode: 0, stdout: '', stderr: '' };
    };
    try {
      await release.install({
        namespace: 'houston-w',
        context: 'ctx',
        values: { a: 1 },
        emit: nullEmit,
      });
    } finally {
      exec.kube.run = original;
    }
    return seen;
  }

  it('lists, rolls back, and only then upgrades', async () => {
    const seen = await helmConversation('pending-upgrade', 3);
    // THE CONVERSATION, in the order it happened, through the seam every helm call in this
    // package goes through. Earlier releases asserted the name of the rollback step appears
    // in the function's own text -- which says nothing about whether it runs first, or at
    // all, on the branch that installs.
    expect(seen).toEqual([
      'helm list --kube-context',
      'helm rollback rocketchat',
      'helm upgrade --install',
    ]);
    expect(seen.indexOf('helm rollback rocketchat')).toBeLessThan(
      seen.indexOf('helm upgrade --install'),
    );
  });

  it('removes a release that never completed once, rather than rolling it back to nothing', async () => {
    const seen = await helmConversation('pending-install', 1);
    expect(seen).toEqual([
      'helm list --kube-context',
      'helm uninstall rocketchat',
      'helm upgrade --install',
    ]);
  });

  it('installs anyway when the release list cannot be read, rather than refusing', async () => {
    const seen: string[] = [];
    const exec = require('../../../src/core/kube/exec') as typeof KubeExecNS;
    const release = require('../../../src/core/kube/release') as typeof KubeReleaseNS;
    const original = exec.kube.run;
    exec.kube.run = async (argv: readonly string[]) => {
      if (MUTATING.has(String(argv[1]))) seen.push(argv.slice(0, 3).join(' '));
      if (argv[0] === 'helm' && argv[1] === 'list') {
        return { argv, returncode: 1, stdout: '', stderr: 'forbidden' };
      }
      return { argv, returncode: 0, stdout: '', stderr: '' };
    };
    try {
      await release.install({ namespace: 'houston-w', context: 'ctx', values: {}, emit: nullEmit });
    } finally {
      exec.kube.run = original;
    }
    // The install still happens, and fails on its own terms if it is going to -- the
    // recovery is not allowed to turn an unreadable list into a refusal.
    expect(seen).toEqual(['helm list --kube-context', 'helm upgrade --install']);
  });
});
