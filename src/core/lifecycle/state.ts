/**
 * Starting, stopping and restarting a workspace that already exists.
 *
 * Tier 4. The state machine is `types.STATE_ACTIONS`; `preconditions.checkStateRequest`
 * decides whether the move is allowed, and this module makes it.
 */
import * as config from '../../lib/config';
import { DockerError, ValidationError } from '../../lib/errors';
import { type Emit, nullEmit, warn } from '../../lib/events';
import { valueKind } from '../../lib/format';
import { namespaceFor } from '../kube/namespace';
import { CONTEXT as KUBE_CONTEXT } from '../kube/names';
import { startWorkspace, stopWorkspace } from '../kube/scale';
import * as engine from '../runner/engine';
import { reproLock, updateConfig } from '../runner/locks';
import { readMeta, updateMeta } from '../runner/record';
import { rcState } from '../runner/queries';
import * as topology from '../topology';

import * as naming from './naming';
import { stopPortForward } from './ready';
import { INTERACTIVE_LOCK_WAIT, STATE_ACTIONS } from './types';

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export async function clearDefaultIf(name: string): Promise<void> {
  // Locked read-modify-write: `prune` calls this in a loop and the GUI runs it on worker
  // threads, so a plain read/write pair can lose an update.
  await updateConfig((cfg) => {
    if (cfg.default_repro === name) delete cfg.default_repro;
  });
}

/**
 * stop/start/restart by scaling, which is the nearest true thing Kubernetes has.
 *
 * Compose's contract is what this has to match, not Kubernetes' vocabulary: `stop` gives
 * the memory back and keeps the data, `start` brings the same workspace back on the same
 * port. Scaling to 0 does exactly that -- the PersistentVolumeClaim is untouched.
 *
 * The port-forward is a real difference and is handled rather than ignored: it dies with
 * the pod, so `stop` kills it deliberately and `start` hands back to `ready`, which
 * re-establishes it.
 */
export async function setStateKubernetes(
  target: string,
  action: string,
  emit: Emit = nullEmit,
): Promise<void> {
  const meta = await readMeta(target);
  const extra = bag(meta.extra);
  const context = isTruthy(extra[config.EXTRA_CONTEXT])
    ? String(extra[config.EXTRA_CONTEXT])
    : KUBE_CONTEXT;
  await reproLock(
    target,
    async () => {
      if (action === 'stop' || action === 'restart') {
        await stopWorkspace(target, { context, emit });
        const pid = extra.port_forward_pid;
        if (isTruthy(pid)) {
          stopPortForward(Number(pid), { namespace: await namespaceFor(target) });
          await updateMeta(target, (current) => {
            delete current.extra.port_forward_pid;
          });
        }
      }
      if (action === 'start' || action === 'restart') {
        await startWorkspace(target, { context, emit });
        // NO PORT-FORWARD HERE, and that is the tested answer rather than the obvious one.
        // Scaling up from zero takes far longer than `portForward`'s brief pod wait, so
        // kubectl attaches to a pod that is not ready, binds the socket for a moment and
        // exits. Only `ready` waits for the pod before forwarding, so only `ready` can
        // honestly restore the URL. What was missing was not the forward: it was SAYING so.
        warn(
          emit,
          `'${target}' is scaling back up. Its URL is a port-forward that ` +
            'died with the old pod, and a new one can only be attached ' +
            'once the pod is ready — `houston ready --name ' +
            `${target}\` waits for it and re-establishes the forward.`,
          { phase: 'boot' },
        );
      }
    },
    { timeoutMs: INTERACTIVE_LOCK_WAIT * 1000 },
  );
}

/**
 * Stop/start/restart a workspace. Returns what happened, for a caller that has to decide
 * what to do next.
 *
 * `needs_ready` is the one fact a front-end cannot work out for itself: on Kubernetes a
 * `start` scales the deployment back up and CANNOT re-establish the port-forward that
 * died with the old pod. The GUI used to infer that from "did this emit anything", which
 * is a proxy for the real question and would answer wrongly the moment any other warning
 * was added.
 */
export async function setState(
  name: string,
  action: unknown,
  emit: Emit = nullEmit,
): Promise<Record<string, unknown>> {
  const target = await naming.resolveName(name);
  // Guarded here rather than in each front-end: the CLI's `stop`/`start`/`restart` and
  // the GUI's always-enabled buttons both arrive through this one function, so one guard
  // covers both and cannot drift between them.
  //
  // Looked up by a string key: `action` arrives from a JSON body, and an object or list
  // reached the lookup and failed as "unhashable type" -- a 500 rather than the "unknown
  // action" this already knows how to say. Validated BEFORE the runtime split so a bad
  // action is rejected the same way on both.
  if (typeof action !== 'string') {
    throw new ValidationError(
      `action must be a string (want start|stop|restart), got ` + valueKind(action),
    );
  }
  if (!STATE_ACTIONS.includes(action)) {
    throw new ValidationError(`unknown action '${action}' (want start|stop|restart)`);
  }
  if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
    await setStateKubernetes(target, action, emit);
    return {
      name: target,
      action,
      runtime: topology.KUBERNETES,
      needs_ready: action === 'start' || action === 'restart',
    };
  }
  const fn = action === 'start' ? engine.start : action === 'stop' ? engine.stop : engine.restart;
  // Locked like every other mutator. Stop/Restart are always-enabled GUI buttons, so they
  // were clickable straight through a create, backup or upgrade running on the same repro
  // -- and the GUI's pending map only blocks within ONE tab.
  const rc = await reproLock(target, async () => await fn(target), {
    timeoutMs: INTERACTIVE_LOCK_WAIT * 1000,
  });
  if (rc !== 0) {
    // A `down`ed repro has no containers, so `compose start` can never revive it. Say
    // what actually works instead of the exit code.
    let hint = '';
    if ((action === 'start' || action === 'restart') && (await rcState(target)) === 'absent') {
      hint =
        ` - '${target}' was \`down\`ed, so it has no containers to ` +
        'start; recreate them from its stored metadata instead';
    }
    throw new DockerError(`\`docker compose ${action}\` failed for '${target}'${hint}`);
  }
  // Compose keeps its published port across a stop/start, so nothing has to be
  // re-attached and there is nothing further for the caller to do.
  return { name: target, action, runtime: topology.DOCKER, needs_ready: false };
}
