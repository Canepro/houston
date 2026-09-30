/**
 * INVARIANT: three facts about the shared Kubernetes stack, asserted by driving it.
 *
 * MECHANISM: BEHAVIOURAL SPY on `kube.run`, the one seam every kubectl and helm call in
 * this package goes through.
 *
 * Earlier releases held all three by searching a function's source for a literal. That is true of
 * a string in a comment, true of a value assembled and then discarded, and false of the same
 * setting passed under a constant -- and two of these ARE passed under constants here.
 */
import type * as PolicyNS from '../../testsetup-policy';
import type * as KubeExecNS from '../../../src/core/kube/exec';
import type * as MonitoringNS from '../../../src/core/kube/monitoring';
import type * as ForwardNS from '../../../src/core/kube/forward';
import type * as ScaleNS from '../../../src/core/kube/scale';

import { nullEmit } from '../../../src/lib/events';

/** Record every argv the package sends, and answer each call harmlessly. */
function recordKubeCalls(
  answer: (argv: readonly string[]) => Partial<KubeExecNS.KubectlResult> = () => ({}),
): {
  argvs: string[][];
  restore: () => void;
} {
  const exec = require('../../../src/core/kube/exec') as typeof KubeExecNS;
  const original = exec.kube.run;
  const argvs: string[][] = [];
  exec.kube.run = async (argv: readonly string[]) => {
    argvs.push([...argv]);
    return { argv, returncode: 0, stdout: '', stderr: '', ...answer(argv) };
  };
  return {
    argvs,
    restore: () => {
      exec.kube.run = original;
    },
  };
}

describe('the shared monitoring stack', () => {
  it('tells Prometheus to look outside its own release', async () => {
    const monitoring = require('../../../src/core/kube/monitoring') as typeof MonitoringNS;
    // NOT ALREADY INSTALLED, or the install never happens and the assertion below reads an
    // argv that was never built. `helm list` is how the module decides.
    const seen = recordKubeCalls((argv) => {
      // NOT ALREADY INSTALLED (`helm list` is how the module decides), and the Grafana
      // readiness probe answers at once so the wait afterwards is not a five-second poll.
      if (argv[1] === 'list') return { stdout: '[]' };
      if (argv.includes('jsonpath={.status.availableReplicas}')) return { stdout: '1' };
      return {};
    });
    try {
      await monitoring.ensureMonitoring({ context: 'ctx', emit: nullEmit });
    } catch {
      // The install cannot land here; what it ASKED for is the claim.
    } finally {
      seen.restore();
    }
    const install = seen.argvs.find((argv) => argv[0] === 'helm' && argv[1] === 'upgrade');
    expect(install).toBeDefined();
    const values = (install ?? []).join(' ');
    // The one setting a SHARED stack cannot work without: without it Prometheus watches
    // only the ServiceMonitors its own release created, so a workspace's PodMonitor -- in
    // another namespace and another release -- is ignored and Grafana shows empty graphs.
    // Nothing errors. Asserted on the argv helm actually received.
    expect(values).toContain('serviceMonitorSelectorNilUsesHelmValues=false');
    expect(values).toContain('podMonitorSelectorNilUsesHelmValues=false');
  });

  it('forwards Grafana from the instance, never from the operator', async () => {
    const monitoring = require('../../../src/core/kube/monitoring') as typeof MonitoringNS;
    const spawned: string[][] = [];
    jest.resetModules();
    // THE SPAWN SEAM, because that is where the target actually goes -- and through the
    // module registry, because an emitted export is a getter and cannot be assigned.
    jest.doMock('../../../src/seams/exec', () => ({
      ...(jest.requireActual('../../../src/seams/exec') as Record<string, unknown>),
      startDetached: async (argv: readonly string[]) => {
        spawned.push([...argv]);
        // A detached `kubectl port-forward` is what this function exists to start;
        // refusing here records the target and leaves nothing running.
        throw new Error('not spawning a port-forward in a unit test');
      },
    }));
    try {
      const forward = require('../../../src/core/kube/forward') as typeof ForwardNS;
      expect(await forward.grafanaForward({ context: 'ctx', hostPort: 3010 })).toBe(0);
    } finally {
      // THE SUITE'S GUARD GOES BACK, rather than `jest.dontMock`. `dontMock` marks the id
      // "never mock" and `resetModules` does not clear that, so every later case in this
      // file would run on the UNGUARDED real process seam -- which is what this cleanup
      // did until `test/testsetup-cloud.ts` existed to be stripped.
      jest.doMock('../../../src/seams/exec', () =>
        (require('../../testsetup-policy') as typeof PolicyNS).guardedExec(),
      );
      jest.resetModules();
    }
    expect(spawned).toHaveLength(1);
    const asked = (spawned[0] ?? []).join(' ');
    // `monitoring-grafana` is the grafana OPERATOR and serves nothing useful. Deployment,
    // not Service, for the same reason the workspace forward is one: a Service with no
    // ready endpoint makes kubectl exit at once.
    expect(monitoring.GRAFANA_DEPLOYMENT).toBe('monitoring-grafana-deployment');
    expect(asked).toContain(`deployment/${monitoring.GRAFANA_DEPLOYMENT}`);
    expect(asked).not.toContain('svc/');
  });
});

describe('quiescing a Kubernetes workspace for a dump', () => {
  it('scales Rocket.Chat down by label and leaves MongoDB running', async () => {
    const scale = require('../../../src/core/kube/scale') as typeof ScaleNS;
    const seen = recordKubeCalls(() => ({ stdout: '' }));
    try {
      await scale.scaleRocketchat('w', { replicas: 0, context: 'ctx' });
    } catch {
      // The scale cannot land here; the selector it used is the claim.
    } finally {
      seen.restore();
    }
    const asked = seen.argvs.flat().join(' ');
    // A dump needs the database UP and only its writers quiesced. Selecting everything
    // would take MongoDB down with Rocket.Chat and there would be nothing to dump.
    expect(asked).toContain('app.kubernetes.io/name=rocketchat');
    expect(asked.toLowerCase()).not.toContain('statefulset');
  });
});
