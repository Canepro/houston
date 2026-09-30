/**
 * `ready` on Kubernetes: a Ready pod, a forward that answers, and Rocket.Chat on the end.
 *
 * The three cases of waiting for a Kubernetes workspace to serve. They sit with the forward
 * because every one of them is about what the forward's socket does or does not prove. The pod,
 * the forward and Rocket.Chat's answer are stated here -- each is a module of its own -- and the
 * loop between them is the real one, run on a clock this file moves, because it sleeps three
 * seconds a round.
 */
import type * as ForwardNS from '../../../src/core/kube/forward';
import type * as RcapiNS from '../../../src/core/rcapi';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as StatusNS from '../../../src/core/kube/status';

import { ConflictError, NotReadyError } from '../../../src/lib/errors';
import {
  Interrupted,
  interrupt,
  resetInterruptForTest,
  unwindsOnInterrupt,
} from '../../../src/seams/exec';
import { nullEmit } from '../../../src/lib/events';
import { waitServingKubernetes } from '../../../src/core/lifecycle/ready';
import { tuning } from '../../../src/core/lifecycle/types';
import { metadata } from '../../../src/core/runner/record';
import * as topology from '../../../src/core/topology';

/** What the pod says, what each forward repair returns, what the port and Rocket.Chat say. */
let mockReady = true;
let mockPids: number[] = [4242];
const mockRepaired: number[] = [];
let mockReachable = true;
let mockInfo: Record<string, unknown> | null = { version: '8.5.1' };

jest.mock('../../../src/core/kube/status', () => ({
  ...jest.requireActual<typeof StatusNS>('../../../src/core/kube/status'),
  workspaceReady: () => Promise.resolve(mockReady),
  terminalPodFailure: () => Promise.resolve(null),
  servicesWithoutEndpoints: () => Promise.resolve([]),
}));
jest.mock('../../../src/core/kube/forward', () => ({
  ...jest.requireActual<typeof ForwardNS>('../../../src/core/kube/forward'),
  ensurePortForward: () => {
    const pid = (mockPids.length > 1 ? mockPids.shift() : mockPids[0]) ?? 0;
    mockRepaired.push(pid);
    return Promise.resolve(pid);
  },
  forwardReachable: () => Promise.resolve(mockReachable),
}));
jest.mock('../../../src/core/rcapi', () => ({
  ...jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi'),
  apiInfo: () => Promise.resolve(mockInfo),
}));
jest.mock('../../../src/core/runner/record', () => ({
  ...jest.requireActual<typeof RecordNS>('../../../src/core/runner/record'),
  updateMeta: () => Promise.resolve(),
}));

const realStrikes = tuning.FOREIGN_PORT_STRIKES;

function workspace(port: number) {
  const meta = metadata({
    name: 'k',
    project: 'houston-k',
    rcVersion: '8.5.1',
    rootUrl: `http://localhost:${String(port)}`,
    hostPort: port,
  });
  topology.stamp(meta.extra, topology.KUBERNETES);
  // Recorded, so the namespace is read from the record rather than from disk: nothing
  // here should wait on anything but the clock this file moves.
  meta.extra.namespace = 'houston-k';
  return meta;
}

/** How a wait settled. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Move the clock until the wait settles, and report how it settled. */
async function drive<T>(promise: Promise<T>): Promise<Outcome<T>> {
  const state: { outcome: Outcome<T> | null } = { outcome: null };
  void promise.then(
    (value) => {
      state.outcome = { ok: true, value };
    },
    (error: unknown) => {
      state.outcome = { ok: false, error };
    },
  );
  for (let tick = 0; tick < 200 && state.outcome === null; tick += 1) {
    await jest.advanceTimersByTimeAsync(1000);
  }
  if (state.outcome === null) throw new Error('the wait never settled');
  return state.outcome;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockReady = true;
  mockPids = [4242];
  mockRepaired.length = 0;
  mockReachable = true;
  mockInfo = { version: '8.5.1' };
});

afterEach(() => {
  resetInterruptForTest();
  jest.useRealTimers();
  tuning.FOREIGN_PORT_STRIKES = realStrikes;
});

describe('ready, on a Kubernetes workspace', () => {
  it('confirms the socket answers, and then that it is Rocket.Chat answering', async () => {
    // `ready` exited 0 on a workspace whose URL answered nothing, after `restart`:
    // `kubectl port-forward` returns a pid before it binds, and the live run caught the
    // very next request to the confirmed URL getting nothing.
    mockReachable = false;
    const never = await drive(waitServingKubernetes(workspace(3999), nullEmit, 0.2));
    expect(never.ok).toBe(false);
    expect((never as { error: unknown }).error).toBeInstanceOf(NotReadyError);

    // Reachable AND Rocket.Chat answering: ready. The port answering says only that the
    // port answers, so /api/info is what says the thing on the other end is this workspace.
    mockReachable = true;
    const served = await drive(waitServingKubernetes(workspace(3999), nullEmit, 30));
    expect(served).toEqual({ ok: true, value: { ready: true, url: 'http://localhost:3999' } });
  });

  it('is reached by a Ctrl-C in its three-second sleep, as time.sleep is', async () => {
    // `_time.sleep(3.0)` raises Interrupted. The bare timer here was a wait no Ctrl-C
    // could reach, so `backup`'s unwind sat in the loop until its bound.
    mockReady = false;
    let ended = 0;
    const waiting = unwindsOnInterrupt(
      async () => await waitServingKubernetes(workspace(3999), nullEmit, 30),
    );
    await jest.advanceTimersByTimeAsync(100);
    interrupt(() => (ended += 1));
    const outcome = await drive(waiting);
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: unknown }).error).toBeInstanceOf(Interrupted);
    expect(ended).toBe(0);
  });

  it('requires the SAME forward to survive two serving checks', async () => {
    // A freshly repaired forward can serve once and then die with its pod -- a failure
    // seen live: `ready` saw Rocket.Chat and exited zero, and the immediately following
    // /api/info request got connection-refused. A second forward replacing the first
    // proves the first observation was transient.
    mockPids = [101, 202, 202];
    const served = await drive(waitServingKubernetes(workspace(3999), nullEmit, 30));
    expect(served.ok).toBe(true);
    expect(mockRepaired).toEqual([101, 202, 202]);
  });

  it('refuses a URL something other than Rocket.Chat is serving, after a grace', async () => {
    // `ready` printed "is serving at <url>" for a URL a FOREIGN process was serving: a Ready
    // pod plus an answering port, and nothing ever asked Rocket.Chat. WHOSE forward holds
    // the port is not the question -- on a dual-stack box kubectl binds [::1] happily while
    // a squatter holds 127.0.0.1 -- so the refusal comes whether ours is up or not.
    mockInfo = null;
    tuning.FOREIGN_PORT_STRIKES = 2;
    for (const pid of [0, 4242]) {
      mockPids = [pid];
      const refused = await drive(waitServingKubernetes(workspace(3998), nullEmit, 60));
      expect(refused.ok).toBe(false);
      const error = (refused as { error: unknown }).error;
      expect(error).toBeInstanceOf(ConflictError);
      const said = (error as Error).message;
      expect(said).toContain('3998');
      expect(said).toContain('not with Rocket.Chat');
      // Say that the URL itself is not evidence, and name the case a reader cannot guess.
      expect(said).toContain('trusted to be this workspace');
      expect(said).toContain('IPv4');
    }

    // But NOT on the first look: a pod that has only just passed its probe may take a
    // moment more to serve. Without room for the strikes this is an honest timeout.
    tuning.FOREIGN_PORT_STRIKES = 10 ** 6;
    const waited = await drive(waitServingKubernetes(workspace(3998), nullEmit, 0.5));
    expect((waited as { error: unknown }).error).toBeInstanceOf(NotReadyError);
  });
});
