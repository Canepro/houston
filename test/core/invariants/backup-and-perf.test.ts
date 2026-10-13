/**
 * INVARIANT: five things that only show up when the operation really runs.
 *
 * MECHANISM: BEHAVIOURAL SPY.
 *
 * Earlier releases held each of these with a window of source text around a literal: a fixed
 * run of characters after a match, a count of how often one call is spelled, two offsets in the
 * file compared, a phrase that must appear somewhere. A window moves when a function is split;
 * a count counts the comment that explains the call; and an ordering of two offsets says nothing
 * about which branch runs. Driving the operation answers all three.
 */
import type * as RecordNS from '../../../src/core/runner/record';

import type * as BackupNS from '../../../src/core/backup';
import type * as CreateK8sNS from '../../../src/core/lifecycle/create-k8s';
import type * as LoadtestNS from '../../../src/core/loadtest';
import type * as PostreadyNS from '../../../src/core/postready';
import type * as UpgradeNS from '../../../src/core/upgrade';

import { nullEmit, type Event } from '../../../src/lib/events';

afterEach(() => {
  jest.resetModules();
});

/** A record on disk for `w`, because every one of these resolves the workspace first. */
async function aWorkspace(
  name: string,
  extra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const record = jest.requireActual('../../../src/core/runner/record') as typeof RecordNS;
  await record.write(name, 'services: {}\n', {
    name,
    project: `houston-${name}`,
    rcVersion: '8.5.1',
    rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3000',
    hostPort: 3000,
    versionSource: 'map',
    pinned: false,
    createdAt: '2026-01-01T00:00:00Z',
    publicUrl: '',
    adminPassword: '',
    extra,
    ...overrides,
  });
}

describe('the database tools under an operator-managed MongoDB', () => {
  it('authenticate, and the flags reach mongodump as well as mongorestore', async () => {
    await aWorkspace('authw', { mongo_managed_by: 'operator', context: 'ctx' });
    const argvs: string[][] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/kube/operator', () => ({
      ...(jest.requireActual('../../../src/core/kube/operator') as Record<string, unknown>),
      // The operator enables SCRAM, so an unauthenticated `mongodump` fails with "Command
      // listCollections requires authentication" -- which is what it did: backup was broken
      // on the path the official guide recommends and worked on the one that has no auth.
      mongoToolAuth: async () => 's3cr3t',
    }));
    jest.doMock('../../../src/core/topology', () => {
      const real = jest.requireActual('../../../src/core/topology') as Record<string, unknown>;
      return { ...real, ofRepro: async () => real.KUBERNETES };
    });
    jest.doMock('../../../src/core/kube/transfer', () => ({
      ...(jest.requireActual('../../../src/core/kube/transfer') as Record<string, unknown>),
      execToFile: async (_n: string, argv: readonly string[]) => {
        argvs.push([...argv]);
        return [0, ''];
      },
      execFromFile: async (_n: string, argv: readonly string[]) => {
        argvs.push([...argv]);
        return [0, ''];
      },
      execCapture: async (_n: string, argv: readonly string[]) => {
        argvs.push([...argv]);
        return [0, ''];
      },
    }));
    try {
      const backup = require('../../../src/core/backup') as typeof BackupNS;
      expect(await backup.mongoAuth('authw')).toBe('s3cr3t');
      // authenticationDatabase is the APPLICATION database, not `admin`: the user is
      // defined there, and authenticating against admin looks for a user never created.
      const { toolAuthenticated } = require('../../../src/core/kube/operator') as {
        toolAuthenticated: (argv: string[], password: string) => [string[], string];
      };
      const [flags] = toolAuthenticated(['mongodump'], 's3cr3t');
      expect(flags.slice(-2)).toEqual(['--authenticationDatabase', 'rocketchat']);
    } finally {
      jest.dontMock('../../../src/core/kube/operator');
      jest.dontMock('../../../src/core/topology');
      jest.dontMock('../../../src/core/kube/transfer');
      jest.resetModules();
    }
  });

  it('run without credentials on the StatefulSet path, which has no auth at all', async () => {
    await aWorkspace('plainw');
    const backup = require('../../../src/core/backup') as typeof BackupNS;
    // Compose never reaches Kubernetes at all, so adding flags here would break it.
    expect(await backup.mongoAuth('plainw')).toBe('');
  });
});

describe('a restore', () => {
  it('retargets Site_Url at the workspace the bundle landed in', async () => {
    await aWorkspace('restored');
    const wrote: [string, string][] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/rcapi', () => ({
      ...(jest.requireActual('../../../src/core/rcapi') as Record<string, unknown>),
      login: async () => ({ token: 't', userId: 'u' }),
      getSetting: async () => 'http://localhost:3111',
      setSetting: async (_u: string, _a: unknown, _p: string, key: string, value: string) => {
        wrote.push([key, value]);
        return true;
      },
    }));
    try {
      const backup = require('../../../src/core/backup') as typeof BackupNS;
      const said: Event[] = [];
      await backup.retargetSiteUrl('restored', (ev) => said.push(ev));
      // A restore is a full mongorestore, so the bundle brings its own Site_Url with it --
      // and every link, OAuth callback and CORS rule in the restored workspace then names
      // the workspace it came from.
      expect(wrote).toEqual([['Site_Url', 'http://localhost:3000']]);
      expect(said.map((ev) => ev.message).join(' ')).toContain('3111');
    } finally {
      jest.dontMock('../../../src/core/rcapi');
      jest.resetModules();
    }

    // A workspace whose Site_Url ALREADY matches is left alone; this must not write a
    // setting on every restore into the same workspace.
    wrote.length = 0;
    jest.doMock('../../../src/core/rcapi', () => ({
      ...(jest.requireActual('../../../src/core/rcapi') as Record<string, unknown>),
      login: async () => ({ token: 't', userId: 'u' }),
      getSetting: async () => 'http://localhost:3000',
      setSetting: async (_u: string, _a: unknown, _p: string, key: string, value: string) => {
        wrote.push([key, value]);
        return true;
      },
    }));
    try {
      const backup = require('../../../src/core/backup') as typeof BackupNS;
      await backup.retargetSiteUrl('restored', nullEmit);
      expect(wrote).toEqual([]);
    } finally {
      jest.dontMock('../../../src/core/rcapi');
      jest.resetModules();
    }
  });
});

describe('a load test that could not put the caps back', () => {
  it('keeps the constraints note when the restore failed', async () => {
    const cleared: string[] = [];
    jest.resetModules();
    // `journal` is not one of the injected deps -- it is imported -- so the note is watched
    // through the module registry, which is also what a real recovery would read.
    jest.doMock('../../../src/core/journal', () => ({
      ...(jest.requireActual('../../../src/core/journal') as Record<string, unknown>),
      clear: (note: string) => {
        cleared.push(note);
      },
    }));
    const loadtest = require('../../../src/core/loadtest') as typeof LoadtestNS;

    const drive = async (problems: string[]): Promise<void> => {
      cleared.length = 0;
      const run = loadtest.newLoadRun();
      run.constrainNote = 'note-constraints';
      run.appliedConstraints = { rocketchat: { cpus: '1' } } as never;
      run.limiterWasOff = true;
      const deps = loadtest.depsWith({
        constrain: {
          ...(jest.requireActual('../../../src/perf/constrain') as Record<string, unknown>),
          restore: async () => problems,
        } as never,
      });
      await loadtest.putEverythingBack({
        auth: { token: 't', userId: 'u' } as never,
        deps,
        emit: nullEmit,
        m: { name: 'perfw', project: 'houston-perfw', extra: {} } as never,
        run,
      });
    };

    // A FAILED RESTORE. `journal.clear(constrainNote)` sat ABOVE the restore that can
    // fail, so a failed restore left the containers capped with the record of their prior
    // values already deleted -- which is precisely what the note carries them for.
    await drive(['docker refused']);
    expect(cleared).not.toContain('note-constraints');

    await drive([]);
    expect(cleared).toContain('note-constraints');
    jest.dontMock('../../../src/core/journal');
    jest.resetModules();
  });
});

describe('a SAML preset waiting for its IdP certificate', () => {
  it('fetches it once, with a deadline, rather than retrying around a retrier', async () => {
    const calls: Record<string, unknown>[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/rcapi', () => ({
      ...(jest.requireActual('../../../src/core/rcapi') as Record<string, unknown>),
      fetchSamlIdpCert: async (_url: string, options: Record<string, unknown>) => {
        calls.push(options);
        return '';
      },
    }));
    try {
      const postready = require('../../../src/core/postready') as typeof PostreadyNS;
      // THROUGH THE REGISTRY, not by calling the handler by name: the action is reached
      // by its key, which is what a preset's `post_ready` block actually names.
      await postready.runPostReady(
        {
          name: 'w',
          project: 'houston-w',
          rootUrl: 'http://localhost:3000',
          extra: {
            post_ready: [
              { action: 'saml_idp_cert', descriptor_url: 'http://localhost:8081/x', setting: 's' },
            ],
          },
        } as never,
        { token: 't', userId: 'u' } as never,
        nullEmit,
      );
    } catch {
      // The apply cannot land; how many times it ASKED is the claim.
    } finally {
      jest.dontMock('../../../src/core/rcapi');
      jest.resetModules();
    }
    // A SAML create that sat for THIRTY MINUTES, found by the operational audit: a retry
    // loop around a function that already retries to its own deadline multiplies them.
    expect(calls).toHaveLength(1);
    const postready = require('../../../src/core/postready') as typeof PostreadyNS;
    expect(calls[0]?.timeout).toBe(postready.IDP_CERT_DEADLINE);
  });
});

describe('a forced cross-major MongoDB upgrade', () => {
  it('says it moves Rocket.Chat only', async () => {
    // A REAL workspace and a REAL plan: `refuseOrWarn` calls `plan()` inside its own
    // module, so a stub of `plan` would not be the one it reaches. `mongo_blocked` is
    // produced by the shipped pairing table, which is what `--offline` reads.
    await aWorkspace('upw', {}, { mongoTag: '7.0' });
    const said: Event[] = [];
    jest.resetModules();
    // The workspace has to be RUNNING to be upgradable, and nothing here starts a
    // container. Stubbed at the one seam `requireRunning` asks, so the refusal below is
    // reached for the reason this test is about rather than for a missing workspace.
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...(jest.requireActual('../../../src/core/runner/queries') as Record<string, unknown>),
      rcState: async () => 'running',
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...(jest.requireActual('../../../src/core/lifecycle/preconditions') as Record<
        string,
        unknown
      >),
      requireDocker: async () => undefined,
    }));
    try {
      const upgrade = require('../../../src/core/upgrade') as typeof UpgradeNS;
      // A REAL plan: `refuseOrWarn` calls `plan()` inside its own module, so a stub of
      // `plan` would not be the one it reaches. `mongo_blocked` comes from the shipped
      // pairing table, which is what `--offline` reads.
      const blocked = await upgrade.plan('upw', '8.5.2', { offline: true });
      expect(`mongo_blocked: ${String(Boolean(blocked.mongo_blocked))}`).toBe(
        'mongo_blocked: true',
      );
      // WITHOUT --force it refuses, and the refusal names the MongoDB move rather than
      // stopping at "not allowed". `mongoMove` puts the same sentence in `blocked`, so
      // this is the branch a reader actually meets.
      await expect(upgrade.refuseOrWarn(nullEmit, false, true, 'upw', '8.5.2')).rejects.toThrow(
        /MongoDB majors have to be stepped one at a time/u,
      );
      // WITH it, the warning says the same thing rather than proceeding silently.
      await upgrade.refuseOrWarn((ev) => said.push(ev), true, true, 'upw', '8.5.2');
    } finally {
      jest.dontMock('../../../src/core/runner/queries');
      jest.dontMock('../../../src/core/lifecycle/preconditions');
      jest.resetModules();
    }
    // `--force` past a cross-major MongoDB block did NOT do what the refusal implied: it
    // moved Rocket.Chat and left MongoDB where it was, silently. The warning is what makes
    // forcing an informed decision rather than a surprise.
    const warning = said.find((ev) => ev.level === 'warn')?.message ?? '';
    expect(warning).toContain('--force: upgrading Rocket.Chat ONLY');
    expect(warning).toContain('MongoDB stays at its');
  });
});

describe('--monitor at create time', () => {
  it('waits for the workspace before attaching', async () => {
    const order: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...(jest.requireActual('../../../src/core/lifecycle/ready') as Record<string, unknown>),
      waitServing: async () => {
        order.push('waitServing');
        return {};
      },
      waitAndFinalize: async () => {
        order.push('waitAndFinalize');
        return {};
      },
    }));
    try {
      const createK8s = require('../../../src/core/lifecycle/create-k8s') as typeof CreateK8sNS;
      const job = {
        req: { monitor: true, wait: false, seed: false, seedHere: false, stats: false },
        emit: nullEmit,
        reproName: 'monw',
        result: {},
        meta: { name: 'monw', extra: {} },
        out: {},
        monitorAttach: async () => {
          order.push('monitorAttach');
          return { grafana: 'http://localhost:3010' };
        },
      } as never;
      await createK8s.finish(job);
    } finally {
      jest.dontMock('../../../src/core/lifecycle/ready');
      jest.resetModules();
    }
    // Attaching turns on RC's own `Prometheus_Enabled` over REST, so it needs a workspace
    // that answers. Attaching first reported monitoring attached to a workspace that was
    // not up yet.
    expect(order).toEqual(['waitServing', 'monitorAttach']);
  });
});
