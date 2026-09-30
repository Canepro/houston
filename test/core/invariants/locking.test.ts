/**
 * INVARIANT: every operation that mutates a workspace takes that workspace's lock.
 *
 * MECHANISM: BEHAVIOURAL SPY on the lock seam itself.
 *
 * Each of these does read-compose -> write-compose -> `docker compose up`, and two of them
 * running at once on one workspace interleave: the second reads the document the first has
 * not finished writing. Earlier releases' guard walked the calls each function makes within
 * its own module looking for the name of the lock -- a claim about which functions are
 * reachable from which, in the source. It cannot tell a lock that is TAKEN from one that is merely
 * mentioned, and it cannot see a lock taken on a name other than the workspace's.
 *
 * Here `reproLock` is replaced with a recorder that refuses to run its body, so each
 * operation is driven until it reaches the lock and then stops. What is asserted is that
 * the lock was taken, AND the name it was taken on -- which is the half a source walk has
 * never been able to state.
 */
import type * as BackupNS from '../../../src/core/backup';
import type * as DataNS from '../../../src/core/data';
import type * as EnvvarsNS from '../../../src/core/envvars';
import type * as LifecycleNS from '../../../src/core/lifecycle/create-docker';
import type * as MonitorNS from '../../../src/core/monitor';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as SeedingNS from '../../../src/core/lifecycle/seeding';

import { nullEmit } from '../../../src/lib/events';
import * as request from '../../../src/core/lifecycle/request';
import { createReq } from '../../../src/core/lifecycle/types';

/** What `reproLock` was asked to serialise, without letting the body run. */
class LockTaken extends Error {
  constructor(readonly workspace: string) {
    super(`lock taken on ${workspace}`);
  }
}

/**
 * Drive `operation` far enough to reach the lock, and report the name it was taken on.
 *
 * The recorder THROWS instead of running the body. That is deliberate: it proves the lock
 * is taken before the work rather than beside it, and it stops each operation from going
 * on to touch Docker.
 *
 * THROUGH THE MODULE REGISTRY, not by assigning to the export. swc emits an export as a
 * getter, so `locks.reproLock = ...` raises `Cannot set property ... which has only a
 * getter` -- which is the emitted CommonJS doing its job, and the reason every seam in
 * this suite is replaced with `jest.doMock` and a fresh `require`.
 */
async function lockedOn(load: () => { run: () => Promise<unknown> }): Promise<string> {
  const taken: string[] = [];
  jest.resetModules();
  jest.doMock('../../../src/core/runner/locks', () => ({
    ...(jest.requireActual('../../../src/core/runner/locks') as Record<string, unknown>),
    reproLock: (name: string) => {
      taken.push(name);
      throw new LockTaken(name);
    },
  }));
  try {
    const { run } = load();
    await run();
  } catch (error) {
    if (!(error instanceof LockTaken)) {
      throw new Error(
        `expected the operation to reach reproLock; it raised ${String(error)} instead. ` +
          `Locks taken so far: ${JSON.stringify(taken)}`,
        { cause: error },
      );
    }
  } finally {
    jest.dontMock('../../../src/core/runner/locks');
    jest.resetModules();
  }
  if (taken.length === 0) {
    throw new Error('the operation completed without taking a workspace lock at all');
  }
  return taken[0] as string;
}

describe('a mutation is serialised against every other mutation', () => {
  const workspace = 'lockw';

  beforeAll(async () => {
    // A REAL RECORD, because every one of these resolves the workspace before it locks.
    // Without it each operation fails on "no repro named …" and the walk would report the
    // lock missing when the workspace is what is missing -- the difference between a
    // guard that is gone and a test that never reached it.
    const record = jest.requireActual('../../../src/core/runner/record') as typeof RecordNS;
    for (const name of [workspace, 'creaw']) {
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
        extra: {},
      });
    }
  });

  it('takes the workspace lock on the way', async () => {
    // EVERY ONE OF THEM, and the name each locked on. Each module is required INSIDE the
    // mocked registry, so the binding it holds is the recorder rather than the real lock.
    const cases: [string, () => { run: () => Promise<unknown> }][] = [
      [
        'envvars.setEnv',
        () => {
          const envvars = require('../../../src/core/envvars') as typeof EnvvarsNS;
          return {
            run: async () => await envvars.setEnv(workspace, { A: '1' }, [], { emit: nullEmit }),
          };
        },
      ],
      [
        'monitor.attach',
        () => {
          const monitor = require('../../../src/core/monitor') as typeof MonitorNS;
          return { run: async () => await monitor.attach(workspace, nullEmit) };
        },
      ],
      [
        'monitor.detach',
        () => {
          const monitor = require('../../../src/core/monitor') as typeof MonitorNS;
          return { run: async () => await monitor.detach(workspace, nullEmit) };
        },
      ],
      [
        'data.runScale',
        () => {
          const data = require('../../../src/core/data') as typeof DataNS;
          return { run: async () => await data.runScale(workspace, 'small', nullEmit) };
        },
      ],
      [
        'backup.create',
        () => {
          const backup = require('../../../src/core/backup') as typeof BackupNS;
          return { run: async () => await backup.create(workspace, { emit: nullEmit }) };
        },
      ],
      [
        'seeding.runSeedInline',
        () => {
          const seeding = require('../../../src/core/lifecycle/seeding') as typeof SeedingNS;
          return {
            run: async () =>
              await seeding.runSeedInline(
                { name: workspace, project: `houston-${workspace}` } as never,
                'small',
                false,
                nullEmit,
              ),
          };
        },
      ],
    ];
    for (const [what, load] of cases) {
      expect(`${what} locked on ${await lockedOn(load)}`).toBe(`${what} locked on ${workspace}`);
    }

    // `createUnderTheLock` is the create’s own locked step; it locks on the name it has
    // settled rather than on one the caller passed.
    const created = await lockedOn(() => {
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof LifecycleNS;
      return {
        run: async () =>
          await createDocker.createUnderTheLock(
            createReq({ version: '8.5.1', name: 'creaw' }),
            'creaw',
            nullEmit,
            { streamOutput: false, monitorAttach: request.missingMonitorAttach },
          ),
      };
    });
    expect(created).toBe('creaw');
  });
});
