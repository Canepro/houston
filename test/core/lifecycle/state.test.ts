import * as config from '../../../src/lib/config';
import { metadata, writeRecord } from '../../../src/core/runner/record';

import { DockerError } from '../../../src/lib/errors';

import { clearDefaultIf, setState } from '../../../src/core/lifecycle/state';
import type * as StateNS from '../../../src/core/lifecycle/state';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as TopologyNS from '../../../src/core/topology';

describe('starting, stopping and restarting', () => {
  it('refuses an action that is not a state transition, before dispatching', async () => {
    await writeRecord('w', metadata({ name: 'w', project: 'houston-w' }));
    await expect(setState('w', 'jump')).rejects.toThrow(
      "unknown action 'jump' (want start|stop|restart)",
    );
    // A JSON body can carry an object, and `.get()` on one was an unhashable-type 500
    // rather than the refusal this already knows how to say.
    await expect(setState('w', { start: true })).rejects.toThrow(/action must be a string/);
  });

  it('clears the default only when it names the workspace being removed', async () => {
    config.updateConfig((cfg) => {
      cfg.default_repro = 'keep';
    });
    await clearDefaultIf('other');
    expect(config.loadConfig().default_repro).toBe('keep');
    await clearDefaultIf('keep');
    expect(config.loadConfig().default_repro).toBeUndefined();
  });
});

describe('starting a workspace that was brought down', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('says what revives it instead of reporting an exit code', async () => {
    // `compose start` cannot revive a repro with no containers -- say what does.
    await writeRecord('x', metadata({ name: 'x', project: 'houston-x' }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      start: async () => 1,
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'absent',
    }));
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;
    const refused = await fresh.setState('x', 'start').then(
      () => null,
      (error: unknown) => error,
    );
    expect((refused as Error).constructor.name).toBe(DockerError.name);
    expect(String((refused as Error).message)).toContain('no containers to start');
  });
});

describe('stopping and starting a Kubernetes workspace', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/kube/scale');
    jest.dontMock('../../../src/core/runner/engine');
    jest.resetModules();
  });

  it('scales it rather than calling compose, and restart is stop then start', async () => {
    // Kubernetes has no pause, so stop/start is scale-to-zero and back -- Compose's
    // contract, not Kubernetes' vocabulary. Dispatched in `setState`, so the CLI and the
    // GUI's buttons both arrive through this one branch.
    jest.resetModules();
    const calls: [string, string][] = [];
    const composeCalled = jest.fn();
    jest.doMock('../../../src/core/kube/scale', () => ({
      ...jest.requireActual('../../../src/core/kube/scale'),
      stopWorkspace: async (name: string) => {
        calls.push(['stop', name]);
      },
      startWorkspace: async (name: string) => {
        calls.push(['start', name]);
      },
    }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      stop: composeCalled,
      start: composeCalled,
      restart: composeCalled,
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const topology = require('../../../src/core/topology') as typeof TopologyNS;
    const meta = record.metadata({ name: 'k', project: 'houston-k', hostPort: 3010 });
    topology.stamp(meta.extra, topology.KUBERNETES);
    await record.writeRecord('k', meta);
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;

    await fresh.setState('k', 'stop');
    expect(calls).toEqual([['stop', 'k']]);
    calls.length = 0;
    await fresh.setState('k', 'start');
    expect(calls).toEqual([['start', 'k']]);
    calls.length = 0;
    await fresh.setState('k', 'restart');
    expect(calls).toEqual([
      ['stop', 'k'],
      ['start', 'k'],
    ]);
    expect(composeCalled).not.toHaveBeenCalled();
    // A bad action is rejected the same way on both runtimes.
    await expect(fresh.setState('k', 'pause')).rejects.toThrow("unknown action 'pause'");
  });
});
