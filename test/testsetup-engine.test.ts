/**
 * The engine fixture, proven: the preflight passes with no daemon reached, and a test that
 * wants the engine DOWN -- or wants the real functions -- still gets its way.
 *
 * "Without the fixture, the same test reaches Docker" is proven outside this run, by
 * `yarn test:fixtures:prove`, which drives the same preflight with and without
 * `test/testsetup-engine.ts` and a recording stand-in for `docker` on PATH.
 */
import * as host from '../src/core/runner/host';
import * as policy from './testsetup-policy';

import type * as HostNS from '../src/core/runner/host';
import type * as PreconditionsNS from '../src/core/lifecycle/preconditions';

describe('the engine answers healthy, whatever this machine has', () => {
  it('says the daemon is up and the compose plugin is 2.29.0', async () => {
    expect(await host.dockerAvailable()).toBe(true);
    expect(await host.dockerAvailable({ maxAgeMs: 0 })).toBe(true);
    expect(await host.composeVersion()).toBe('2.29.0');
  });

  it('answers WITHOUT asking: the real probe would have said no', async () => {
    // `docker` is absent at the process seam (test/testsetup-cloud.ts), so the real
    // `dockerAvailable` -- which runs `docker info` -- can only answer false here. `true`
    // above therefore came from the fixture, not from a daemon.
    const real = jest.requireActual<typeof HostNS>('../src/core/runner/host');
    expect(await real.dockerAvailable({ maxAgeMs: 0 })).toBe(false);
    expect(await real.composeVersion()).toBeNull();
    expect(policy.record()).toEqual([]);
  });

  it('lets the real preflight pass, which is what twenty-two tests of earlier releases needed', async () => {
    const preconditions = require('../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
    await expect(preconditions.requireDocker()).resolves.toBeUndefined();
  });

  it('leaves the rest of runner/host real', async () => {
    // Only the two probes earlier releases' fixture replaced are replaced. Anything else answering
    // from a fixture would be a fixture hiding what a test asserts.
    const real = jest.requireActual<typeof HostNS>('../src/core/runner/host');
    expect(host.hostMemory).toBe(real.hostMemory);
    expect(host.dockerCapacity).toBe(real.dockerCapacity);
    expect(await host.dockerCapacity()).toBeNull();
  });
});

describe('a test that owns a stub still wins', () => {
  afterEach(() => {
    // Put the suite's engine back rather than `dontMock` it -- see testsetup-cloud.test.ts.
    jest.doMock('../src/core/runner/host', () => policy.healthyHost());
    jest.resetModules();
  });

  it('can say the engine is DOWN, and the preflight then refuses', async () => {
    jest.resetModules();
    jest.doMock('../src/core/runner/host', () => ({
      ...jest.requireActual<typeof HostNS>('../src/core/runner/host'),
      dockerAvailable: async () => false,
    }));
    const preconditions = require('../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
    await expect(preconditions.requireDocker()).rejects.toThrow("Docker isn't running");
  });

  it('can say the compose plugin is too old, and the preflight then refuses', async () => {
    jest.resetModules();
    // BOTH answers, because a test that registers its own `runner/host` owns the whole
    // module: spreading the actual one puts the REAL `dockerAvailable` back, which finds no
    // docker and refuses for the wrong reason.
    jest.doMock('../src/core/runner/host', () => ({
      ...jest.requireActual<typeof HostNS>('../src/core/runner/host'),
      dockerAvailable: async () => true,
      composeVersion: async () => '1.29.2',
    }));
    const preconditions = require('../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
    await expect(preconditions.requireDocker()).rejects.toThrow('1.29.2');
  });
});
