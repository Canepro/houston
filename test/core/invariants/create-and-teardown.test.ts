/**
 * INVARIANT: five things a create and a prune must do in the right order, or not at all.
 *
 * MECHANISM: BEHAVIOURAL SPY.
 *
 * The owner gate and the capacity check are the interesting pair. Earlier releases asserted that
 * the gate is called through its module and never by its bare name -- a claim about how a call
 * is SPELLED, because a bare-name call is one a replacement of the module's function misses. The
 * property is that a replacement of the module's function is SEEN, and that is a thing to drive:
 * replace it, call the caller, and look.
 */
import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as PreconditionsNS from '../../../src/core/lifecycle/preconditions';
import type * as PruningNS from '../../../src/core/lifecycle/pruning';
import type * as SizingNS from '../../../src/core/lifecycle/sizing';
import type * as TlsPlanNS from '../../../src/core/lifecycle/tlsplan';

import { updateConfig } from '../../../src/lib/config';
import { grant } from '../../../src/lib/onboarding';
import { nullEmit, type Event } from '../../../src/lib/events';
import { createReq } from '../../../src/core/lifecycle/types';

afterEach(() => {
  jest.resetModules();
});

describe('a bind that reaches past loopback', () => {
  it('is warned about when it was asked for, not only when houston widened it', () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: Event[] = [];
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'widew', bind: '0.0.0.0', seed: true }),
      emit: (ev) => said.push(ev),
    });
    plan.bindHost = '0.0.0.0';
    createDocker.warnAboutTheBind(plan);

    const warning = said.find((ev) => ev.level === 'warn');
    expect(warning).toBeDefined();
    const text = warning?.message ?? '';
    // `--bind 0.0.0.0` typed by hand got the normal panel and nothing else. What the
    // warning says is what the panel does NOT already say.
    expect(text).toContain('--bind');
    expect(text).toContain('every interface');
    expect(text).toContain('trusted network');
    expect(text).toContain('seeded users, whose password is their username');
    // The Rocket.Chat admin is generated for a bind this wide and printed on the panel two
    // lines below, so repeating a wrong one here is worse than silence.
    expect(text).not.toContain('admin123');
  });

  it('says nothing at all when the workspace stays on loopback', () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: Event[] = [];
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'loopw' }),
      emit: (ev) => said.push(ev),
    });
    plan.bindHost = '127.0.0.1';
    createDocker.warnAboutTheBind(plan);
    expect(said.filter((ev) => ev.level === 'warn')).toEqual([]);
  });
});

describe('a prune', () => {
  it('waits for the namespaces it swept before reclaiming the cluster', async () => {
    updateConfig((stored) => grant(stored, 'owned-cluster'));
    const order: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...(jest.requireActual('../../../src/core/kube/namespace') as Record<string, unknown>),
      // A stray namespace that IS houston's, so the sweep actually sweeps it rather than
      // leaving it alone unread -- without which the wait never happens and the assertion
      // would pass over an empty list.
      namespaceOwner: async () => '',
      waitNamespaceGone: async () => {
        order.push('waitNamespaceGone');
        return true;
      },
    }));
    jest.doMock('../../../src/core/kube/exec', () => {
      const real = jest.requireActual('../../../src/core/kube/exec') as Record<string, unknown>;
      return {
        ...real,
        // The delete goes straight through the seam rather than through
        // `deleteNamespace`, so this is where it has to be observed.
        kube: {
          run: async (argv: readonly string[]) => {
            if (argv.includes('delete')) order.push('delete namespace');
            return { argv, returncode: 0, stdout: '', stderr: '' };
          },
        },
      };
    });
    try {
      const pruning = require('../../../src/core/lifecycle/pruning') as typeof PruningNS;
      await pruning.sweepOrphanNamespaces(nullEmit, true, ['houston-gone']);
    } finally {
      jest.dontMock('../../../src/core/kube/namespace');
      jest.dontMock('../../../src/core/kube/exec');
      jest.resetModules();
    }
    // The sweep used `--wait=false` and the reclaim ran immediately after, so
    // `deleteCluster` refused -- correctly -- because the namespaces prune had just deleted
    // were still Terminating, and reclaiming the cluster took a SECOND prune twenty seconds
    // later. Waiting for its own sweep is what makes one pass enough.
    expect(order).toEqual(['delete namespace', 'waitNamespaceGone']);
  });
});

describe('the Kubernetes HTTPS plan', () => {
  it('refuses a cluster that is not on this machine before installing anything', async () => {
    const installed: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/kube/certmanager', () => ({
      ...(jest.requireActual('../../../src/core/kube/certmanager') as Record<string, unknown>),
      ensureCertManager: async () => {
        installed.push('ensureCertManager');
      },
    }));
    jest.doMock('../../../src/core/kube/ingress', () => ({
      ...(jest.requireActual('../../../src/core/kube/ingress') as Record<string, unknown>),
      ensureIngress: async () => {
        installed.push('ensureIngress');
        return 'traefik';
      },
    }));
    try {
      const tlsplan = require('../../../src/core/lifecycle/tlsplan') as typeof TlsPlanNS;
      await expect(
        tlsplan.kubernetesTlsPlan(
          createReq({ version: '8.5.1', name: 'remotew', runtime: 'kubernetes' }),
          {
            mode: 'local',
            host: 'w.houston.localhost',
            acmeEmail: '',
            acmeStaging: false,
          } as never,
          { context: 'arn:aws:eks:x', distribution: 'eks', create: false } as never,
          { emit: nullEmit },
        ),
      ).rejects.toThrow(/not on this machine/u);
    } finally {
      jest.dontMock('../../../src/core/kube/certmanager');
      jest.dontMock('../../../src/core/kube/ingress');
      jest.resetModules();
    }
    // `--https` on a cluster that is not on this machine would copy houston's CA private
    // key into a Secret there. A refusal must leave NOTHING behind, and this one left an
    // ingress controller.
    expect(installed).toEqual([]);
  });
});

describe('a cross-module call is made through the module', () => {
  it('asks the ownership module, so a replacement is seen', async () => {
    const asked: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/naming', () => ({
      ...(jest.requireActual('../../../src/core/lifecycle/naming') as Record<string, unknown>),
      resolveName: async (name: string) => name,
    }));
    jest.doMock('../../../src/core/lifecycle/ownership', () => ({
      ...(jest.requireActual('../../../src/core/lifecycle/ownership') as Record<string, unknown>),
      mayDestroy: async (name: string) => {
        asked.push(name);
        return [false, 'nope'];
      },
    }));
    try {
      const preconditions =
        require('../../../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
      // `volumes` is what reaches the owner gate: a teardown that keeps the data asks
      // nobody, and the gate exists for the irreversible half. The ASK is asserted before
      // the refusal, because a gate that is never consulted refuses nothing and the
      // failure should say so rather than printing `rejects.toThrow()`.
      let refusal = '';
      try {
        await preconditions.checkTeardownRequest('w', { volumes: true, confirm: true });
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      expect(`the owner gate was asked about ${JSON.stringify(asked)}`).toBe(
        'the owner gate was asked about ["w"]',
      );
      expect(refusal).toContain('nope');
    } finally {
      jest.dontMock('../../../src/core/lifecycle/ownership');
      jest.dontMock('../../../src/core/lifecycle/naming');
      jest.resetModules();
    }
    // A teardown that keeps the data asks nobody; the irreversible one must.
  });

  it('asks the request module whether this create provisions', async () => {
    const asked: string[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/request', () => ({
      ...(jest.requireActual('../../../src/core/lifecycle/request') as Record<string, unknown>),
      willProvision: async () => {
        asked.push('willProvision');
        return false;
      },
    }));
    try {
      const sizing = require('../../../src/core/lifecycle/sizing') as typeof SizingNS;
      await sizing.checkCapacity(
        createReq({ version: '8.5.1', name: 'capw' }),
        'default',
        nullEmit,
      );
    } catch {
      // Capacity may refuse on this box; whether it ASKED is the claim.
    } finally {
      jest.dontMock('../../../src/core/lifecycle/request');
      jest.resetModules();
    }
    expect(asked).toEqual(['willProvision']);
  });
});
