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
      containerDetails: async () => [],
    }));
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;
    const refused = await fresh.setState('x', 'start').then(
      () => null,
      (error: unknown) => error,
    );
    expect((refused as Error).constructor.name).toBe(DockerError.name);
    expect(String((refused as Error).message)).toContain('no containers to start');
  });

  it('does not tell a merely stopped workspace it was brought down', async () => {
    // `compose ps` without --all lists running containers only, so a stopped repro reads
    // as "absent" there. Its start failing for any other reason was told it had been
    // `down`ed, which sent the user to recreate it instead of reading compose's error.
    await writeRecord('s', metadata({ name: 's', project: 'houston-s' }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      start: async () => 1,
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'absent',
      containerDetails: async () => [
        { service: 'rocketchat', state: 'exited', status: 'Exited (0) 1 hour ago', health: '' },
      ],
    }));
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;
    const refused = await fresh.setState('s', 'start').then(
      () => null,
      (error: unknown) => error,
    );
    expect((refused as Error).constructor.name).toBe(DockerError.name);
    expect(String((refused as Error).message)).toBe("`docker compose start` failed for 's'");
  });
});

describe('restarting a workspace that is not there to restart', () => {
  // Before as well as after: run alone (`-t`), nothing earlier has reset the registry, the
  // state module imported at the top keeps the real engine, and these mocks never apply.
  beforeEach(() => {
    jest.resetModules();
  });
  afterEach(() => {
    jest.resetModules();
  });

  it('refuses one that was brought down, as start does, without restarting anything', async () => {
    // `compose restart` restarts the containers there are: after `down`, none -- exit 0,
    // and the CLI said "restarted".
    await writeRecord('d', metadata({ name: 'd', project: 'houston-d' }));
    const restarted: string[] = [];
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      restart: async (name: string) => {
        restarted.push(name);
        return 0;
      },
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      containerDetails: async () => [],
    }));
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;
    const refused = await fresh.setState('d', 'restart').then(
      () => null,
      (error: unknown) => error,
    );
    expect((refused as Error).constructor.name).toBe(DockerError.name);
    expect(String((refused as Error).message)).toContain('no containers to start');
    expect(restarted).toEqual([]);
  });

  it('says why a stopped workspace would not start, from what Docker recorded', async () => {
    // Compose printed the reason on a stream only the CLI's terminal saw: in the GUI a held
    // port and a broken image both read "`docker compose start` failed".
    await writeRecord('p', metadata({ name: 'p', project: 'houston-p' }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      start: async () => 1,
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      containerDetails: async () => [
        { service: 'rocketchat', state: 'created', status: 'Created', health: '' },
      ],
      startErrors: async () => [
        'rocketchat: failed to bind host port 127.0.0.1:3611/tcp: address already in use',
      ],
    }));
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;
    await expect(fresh.setState('p', 'start')).rejects.toThrow(
      "`docker compose start` failed for 'p' — rocketchat: failed to bind host port " +
        '127.0.0.1:3611/tcp: address already in use',
    );
  });

  it('recreates a container an earlier failed start left with no network', async () => {
    // A start that failed on a held port detaches the container; the next `start`
    // "succeeded" over a Rocket.Chat with no published port that could not resolve
    // `mongodb`, and `ready` then blamed the replica set.
    await writeRecord('n', metadata({ name: 'n', project: 'houston-n' }));
    const upped: string[] = [];
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      start: async () => 0,
      up: async (name: string) => {
        upped.push(name);
        return 0;
      },
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      networklessContainers: async () => ['houston-n-rocketchat-1'],
    }));
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;
    await fresh.setState('n', 'start');
    expect(upped).toEqual(['n']);
  });

  it('fails a restart that left Rocket.Chat stopped', async () => {
    // After a start that could not bind its port the containers sit created-not-running,
    // and `compose restart` answers 0 having started nothing.
    await writeRecord('h', metadata({ name: 'h', project: 'houston-h' }));
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      restart: async () => 0,
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'created',
      containerDetails: async () => [
        { service: 'rocketchat', state: 'created', status: 'Created', health: '' },
      ],
    }));
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;
    await expect(fresh.setState('h', 'restart')).rejects.toThrow(
      "left Rocket.Chat not running in 'h'",
    );
  });
});

describe('stopping and starting a Kubernetes workspace', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/kube/scale');
    jest.dontMock('../../../src/core/runner/engine');
    jest.dontMock('../../../src/core/lifecycle/ready');
    jest.resetModules();
  });

  it('has stopped the port-forward by the time stop returns, inside the lock', async () => {
    // Off Linux, proving the forward is ours waits for `ps`. Not awaited, the record lost
    // its pid and the lock was released first: a `ready` in that gap saw no forward and
    // started a second kubectl onto the port the first still held.
    jest.resetModules();
    const events: string[] = [];
    jest.doMock('../../../src/core/kube/scale', () => ({
      ...jest.requireActual('../../../src/core/kube/scale'),
      stopWorkspace: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      stopPortForward: async (pid: number, { namespace }: { namespace: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push(`stopped ${String(pid)} in ${namespace}`);
      },
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const topology = require('../../../src/core/topology') as typeof TopologyNS;
    const meta = record.metadata({ name: 'k', project: 'houston-k', hostPort: 3010 });
    topology.stamp(meta.extra, topology.KUBERNETES);
    meta.extra.namespace = 'houston-k';
    meta.extra.port_forward_pid = 4242;
    await record.writeRecord('k', meta);
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;

    await fresh.setState('k', 'stop');
    expect(events).toEqual(['stopped 4242 in houston-k']);
    expect((await record.readMeta('k')).extra.port_forward_pid).toBeUndefined();
  });

  it("stops a preset's UI forwards too, and leaves them recorded for ready to repair", async () => {
    // Only the RC forward was stopped. The Keycloak forward's process outlived its pod, so
    // after `start` the repair in `ready` judged it alive and SAML sign-in failed.
    jest.resetModules();
    const events: string[] = [];
    jest.doMock('../../../src/core/kube/scale', () => ({
      ...jest.requireActual('../../../src/core/kube/scale'),
      stopWorkspace: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      stopPortForward: async (pid: number) => {
        events.push(`stopped ${String(pid)}`);
      },
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const topology = require('../../../src/core/topology') as typeof TopologyNS;
    const meta = record.metadata({ name: 'k', project: 'houston-k', hostPort: 3010 });
    topology.stamp(meta.extra, topology.KUBERNETES);
    meta.extra.namespace = 'houston-k';
    meta.extra.scenario_forwards = { '8081': 5151 };
    await record.writeRecord('k', meta);
    const fresh = require('../../../src/core/lifecycle/state') as typeof StateNS;

    await fresh.setState('k', 'stop');
    expect(events).toEqual(['stopped 5151']);
    expect((await record.readMeta('k')).extra.scenario_forwards).toEqual({ '8081': 5151 });
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
