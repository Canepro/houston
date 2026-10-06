/**
 * Waiting for a workspace to actually serve, and the last steps once it does.
 *
 * Tier 3. `waitServing` polls the HTTP surface; the Kubernetes branch also has to keep a
 * port-forward alive while it waits, which is why `waitServingKubernetes` is separate rather
 * than a flag.
 */
import * as config from '../../lib/config';
import { ConflictError, CreateFailedError, NotReadyError, ReproError } from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { toInt, toText } from '../../lib/format';
import { sleep, unwindsOnInterrupt } from '../../seams/exec';
import { diagnoseFailure } from '../diagnose';
import * as edge from '../edge/acme';
import { running as edgeRunning } from '../edge/engine';
import { ensureRunning } from '../edge/runtime';
import { register as registerRoute } from '../edge/routes';
import { forwardAlive, ensurePortForward, forwardReachable } from '../kube/forward';
import { namespaceFor } from '../kube/namespace';
import { workspaceReady, terminalPodFailure, servicesWithoutEndpoints } from '../kube/status';
import { CONTEXT as KUBE_CONTEXT } from '../kube/names';
import { completeSetupWizard, NotReady, apiInfo, waitReady } from '../rcapi';
import * as engine from '../runner/engine';
import { type Metadata, adminPass, updateMeta } from '../runner/record';
import { rcRestartCount, rcState, servicesByProject } from '../runner/queries';
import * as postready from '../postready';
import * as topology from '../topology';
import { MODE_LOCAL } from '../tls';

import { login } from './admin';
import * as inspect from './inspect';
import * as seeding from './seeding';
import { CREATE_UNFINISHED, clearKind, pendingSeed } from '../journal';
import { ESSENTIAL_SERVICES, tuning } from './types';

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The workspace is serving. Whether that is the END is the caller's to say. */
export function sayReady(emit: Emit, final: boolean): void {
  if (final) {
    info(emit, 'ready', { phase: 'done', pct: 100.0 });
  } else {
    // NO PERCENTAGE, deliberately. `waitServing` has already emitted 100 by the time this
    // runs, so naming any number here sends the bar BACKWARDS.
    info(emit, 'the workspace is up', { phase: 'wait' });
  }
}

/**
 * The one place a readiness failure is worded.
 *
 * `known` is a diagnosis from `diagnose`, which is preferred over anything guessed: it
 * comes from a matched log signature rather than from a restart count. The
 * resource-pressure sentence survives only as a POSSIBILITY, and only when nothing was
 * matched -- stated as fact it sent a reader hunting for memory they had.
 */
export function readinessFailure(
  meta: Metadata,
  seen: { restarts: number; cause: string | null },
  { prefix = '', known = '' } = {},
): NotReadyError {
  const cause = known || seen.cause || '';
  const head = prefix || `Rocket.Chat is not becoming ready in '${meta.name}'`;
  if (cause) return new NotReadyError(`${head} - ${cause}`);
  const restarts = seen.restarts || 0;
  if (restarts >= 2) {
    return new NotReadyError(
      `${head} - Rocket.Chat restarted ${String(restarts)}x and nothing in its logs ` +
        "matches a known cause. Free memory or raise Docker's CPU+RAM if the " +
        `box is loaded, then \`houston ready --name ${meta.name}\`; otherwise ` +
        `\`houston logs --name ${meta.name}\` has what happened.`,
    );
  }
  return new NotReadyError(head);
}

/**
 * `docker compose pull` and `up -d`, the containers phase of a create.
 *
 * UNWOUND by a Ctrl-C: out through the create's catch-all, which clears the note, so an
 * `up` interrupted in its pull leaves no `create_unfinished` note, where `process.exit(130)`
 * left one for `doctor` to warn about a workspace that was never made.
 * Nothing between here and that `catch` catches the interrupt, and the note is cleared
 * synchronously. Only this phase: the readiness wait after it goes through catches that
 * handle any error -- `rcRestartCount`'s among them -- which would swallow the interrupt
 * and print one more `still booting` line before the next wait ended the run.
 */
export async function upCompose(
  name: string,
  options: { pull: boolean; emit: Emit; streamOutput: boolean },
): Promise<number> {
  return await unwindsOnInterrupt(async () => await composeUp(name, options));
}

async function composeUp(
  name: string,
  { pull, emit, streamOutput }: { pull: boolean; emit: Emit; streamOutput: boolean },
): Promise<number> {
  if (!streamOutput) {
    // docker draws its own progress on the terminal
    return (await engine.up(name, { pull })) ?? 1;
  }
  // `data.echo="docker"` marks this as ECHO rather than narrative: every line of
  // `docker compose pull` comes through here, so a create emits several hundred
  // "Downloading 45.09MB" events. The GUI wants them; the durable log does not.
  const onLine = (line: string): void =>
    info(emit, line, { phase: 'boot', data: { echo: 'docker' } });
  if (pull) {
    // non-fatal, like runner.up
    await engine.stream(name, ['pull'], onLine);
  }
  return (await engine.stream(name, ['up', '-d', '--remove-orphans'], onLine)) ?? 1;
}

/**
 * Re-register a workspace's https name with the edge. Best-effort.
 *
 * Never fatal: the workspace is up and usable either way, and failing a reuse over the
 * ingress would be the wrong trade.
 */
export async function restoreRoute(meta: Metadata, emit: Emit = nullEmit): Promise<void> {
  const extra = bag(meta.extra);
  if (!(isTruthy(extra.tls) && meta.publicUrl)) return;
  const host = meta.publicUrl.split('://').slice(-1)[0]?.split('/')[0] ?? '';
  const local = extra.tls === MODE_LOCAL;
  try {
    if (!(await edgeRunning())) {
      await ensureRunning({
        acmeEmail: local ? '' : String(extra.tls_email ?? ''),
        acmeStaging: Boolean(extra.tls_staging),
      });
    }
    if (local) await edge.issueLocalCert(host);
    const instances =
      typeof extra.instances === 'number' && Number.isInteger(extra.instances)
        ? extra.instances
        : 1;
    await registerRoute(meta.name, host, { instances, local, grafana: isTruthy(extra.monitoring) });
    info(emit, `${host} is served by the edge again`, { phase: 'tls' });
  } catch (error) {
    warn(
      emit,
      `could not restore the https name ${host}: ${errorText(error)}. ` +
        '`houston edge status` reports it.',
      { phase: 'tls' },
    );
  }
}

/**
 * Kill a workspace's port-forward, if it is still ours to kill.
 *
 * Best-effort and deliberately narrow: the check is "is this process this NAMESPACE's
 * port-forward", delegated to `forwardAlive` so there is one definition of "ours". A
 * recycled pid belonging to ANOTHER workspace's forward is precisely the failure this
 * avoids.
 */
export function stopPortForward(pid: number, { namespace = '' } = {}): void {
  if (!forwardAlive(pid, { namespace })) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

export async function finalize(
  meta: Metadata,
  emit: Emit,
): Promise<{ token: string; userId: string } | null> {
  try {
    const auth = await login(meta);
    if (await completeSetupWizard(meta.rootUrl, auth, adminPass(meta))) {
      info(emit, 'setup wizard skipped — no registration needed', { phase: 'post_ready' });
    }
    return auth;
  } catch {
    // finalize is best-effort
    return null;
  }
}

/**
 * One poll of a boot in progress: is it slow, or is it failing?
 *
 * Module-level rather than a closure over `waitServing`, so a test can patch it. `seen`
 * carries the two facts that have to survive between ticks.
 */
export async function crashLoopTick(
  meta: Metadata,
  emit: Emit,
  timeout: number,
  seen: { restarts: number; cause: string | null },
  elapsed: number,
): Promise<void> {
  // Surface a crash-loop: if RC keeps restarting, boot is slow for a reason.
  const rc = await rcRestartCount(meta.name);
  if (rc >= 2 && rc > seen.restarts) {
    warn(emit, `Rocket.Chat has restarted ${String(rc)}x - checking why`, { phase: 'wait' });
    // ASK, rather than assert. The old wording named resource pressure as the cause, and
    // `diagnose` -- which exists for exactly this -- was never consulted anywhere on the
    // readiness path.
    //
    // Giving up EARLY only when the cause is known. A boot that restarts twice and then
    // settles is ordinary; a matched signature is evidence.
    if (seen.cause === null) {
      seen.cause = (await diagnoseFailure(meta.name)) ?? '';
    }
    if (seen.cause) {
      throw readinessFailure(meta, seen, { known: seen.cause });
    }
  }
  seen.restarts = Math.max(seen.restarts, rc);
  const pct = timeout ? Math.max(0.0, Math.min(99.0, (elapsed / timeout) * 100)) : null;
  // `toInt(elapsed)`, which REFUSES a NaN: under `--timeout inf` or `nan` the deadline is
  // never reached and the elapsed time is NaN, so the first tick throws `InvalidValue` and the
  // command ends (exit 1). Math.floor printed "still booting (NaNs)" every three seconds, for
  // ever -- a run that never wrote its `end` record.
  info(emit, `still booting (${String(toInt(elapsed))}s)`, { phase: 'wait', pct });
}

/**
 * SERVING IS NOT USABLE, and this is the gap between them.
 *
 * Rocket.Chat answers /api/info with no database behind it, so a workspace whose mongodb
 * had exited passed this and was reported ready, running and healthy -- while `api` and
 * `seed` refused it and pointed the reader back at `ready`, the command that had just
 * said yes.
 */
export async function refuseIfServingWithoutADatabase(meta: Metadata): Promise<void> {
  const why = inspect.degradedReason((await servicesByProject())[meta.project] ?? {});
  if (why) {
    throw new NotReadyError(
      `'${meta.name}' is serving, but ${why} - Rocket.Chat answers /api/info ` +
        'without a database, so this looks ready and no login will work. ' +
        `\`docker start ${meta.project}-${ESSENTIAL_SERVICES[0] ?? ''}-1\`, or ` +
        `\`houston up --version ${meta.rcVersion} --name ${meta.name}\` to ` +
        'rebuild the stack.',
    );
  }
}

export async function waitServing(
  meta: Metadata,
  emit: Emit,
  timeout: number,
): Promise<Record<string, unknown>> {
  if (topology.ofMeta(meta) === topology.KUBERNETES) {
    // `rcState` asks docker whether a CONTAINER is running, so `ready` on a Kubernetes
    // workspace answered "Rocket.Chat container is not running" about a workspace whose
    // pods were fine. It also re-establishes the port-forward, which is the whole reason
    // `ready` is the right place to ask.
    return await waitServingKubernetes(meta, emit, timeout);
  }
  const seen: { restarts: number; cause: string | null } = { restarts: 0, cause: null };

  const isAlive = async (): Promise<boolean> =>
    ['running', 'restarting', 'created'].includes(await rcState(meta.name));

  const tick = async (elapsed: number): Promise<void> => {
    await crashLoopTick(meta, emit, timeout, seen, elapsed);
  };

  let served: Record<string, unknown>;
  try {
    served = await waitReady(meta.rootUrl, { timeout, isAlive, onTick: tick });
  } catch (error) {
    if (!(error instanceof NotReady)) throw error;
    if (seen.cause === null) {
      seen.cause = (await diagnoseFailure(meta.name)) ?? '';
    }
    throw readinessFailure(meta, seen, { prefix: errorText(error) });
  }
  await refuseIfServingWithoutADatabase(meta);
  return served;
}

/**
 * Re-establish the forward and record its pid. A forward dies with its pod, and `ready`
 * is exactly when someone asks why the URL stopped answering.
 */
export async function repairThePortForward(
  meta: Metadata,
  emit: Emit,
  extra: Record<string, unknown>,
  namespace: string,
  context: string,
): Promise<number> {
  const pid = await ensurePortForward(meta.name, {
    namespace,
    context,
    hostPort: meta.hostPort,
    pid: typeof extra.port_forward_pid === 'number' ? extra.port_forward_pid : 0,
    bindHost: toText(extra.bind_host),
    emit,
  });
  if (pid && pid !== extra.port_forward_pid) {
    await updateMeta(meta.name, (current) => {
      current.extra.port_forward_pid = pid;
    });
    // AND IN MEMORY, or whoever renders from this `meta` afterwards is reading the pid we
    // just replaced. `ready` repaired a dead forward and then printed "The URL is not
    // published right now" underneath "is serving at <url>".
    meta.extra.port_forward_pid = pid;
  }
  return pid;
}

/**
 * Reachable through the forward, and dead to every pod in the cluster.
 *
 * The Service is never traversed by anything on this path, and on this runtime that
 * matters: readiness reads pod status, the port-forward targets the Deployment, and the
 * default deployment is microservices.
 *
 * WARNED, not gated: endpoints churn during a rollout and a false negative here would
 * block a boot, which is worse than the defect.
 */
export async function warnAboutServicesWithNoEndpoints(
  meta: Metadata,
  emit: Emit,
  namespace: string,
  context: string,
): Promise<void> {
  const empty = await servicesWithoutEndpoints(meta.name, { context });
  if (empty.length > 0) {
    warn(
      emit,
      'no ready pod is behind ' +
        empty.join(', ') +
        ' — the URL works because the port-forward goes ' +
        'straight to the Deployment, but nothing inside ' +
        `the cluster can reach ${empty.length > 1 ? 'these' : 'it'}` +
        `. \`kubectl -n ${namespace} get endpointslices\` ` +
        'shows what is behind each Service.',
      { phase: 'ready' },
    );
  }
}

/**
 * The port answers, the workspace is ready, and what answered is not Rocket.Chat.
 *
 * This was the only runtime that confused occupancy with identity. The Docker path has
 * always gone through `rcapi.waitReady`, which polls /api/info; here readiness was
 * concluded from a Ready pod plus "the port answers" and nothing ever asked Rocket.Chat
 * anything. The port is only validated at create time and 3000+ is the most contested
 * range on a dev box, so this is an ordinary event.
 *
 * Returns the new strike count.
 */
export function refuseAForeignHolder(meta: Metadata, foreign: number): number {
  // WHOSE forward is irrelevant once the workspace itself is ready. The first version
  // raised only when our forward was dead, and the live run found the case that misses:
  // on a dual-stack box kubectl binds `[::1]` quite happily while a squatter holds
  // `127.0.0.1`.
  //
  // So the test is the workspace's own state: if Kubernetes says it is ready and the
  // port answers with something that is not Rocket.Chat, then whatever is on that port
  // is not this workspace. Counted rather than acted on at once, because a pod that has
  // just passed its probe may not be serving for another moment.
  const strikes = foreign + 1;
  if (strikes >= tuning.FOREIGN_PORT_STRIKES) {
    throw new ConflictError(
      `port ${String(meta.hostPort)} is answering, but not with ` +
        `Rocket.Chat, and '${meta.name}' is otherwise ready — so ` +
        `nothing served on ${meta.rootUrl} can be trusted to be this ` +
        'workspace. Something else holds that port. `ss -ltnp | grep ' +
        `${String(meta.hostPort)}\` says what; note it may hold only IPv4 ` +
        'while the port-forward has IPv6, which looks healthy from ' +
        'houston and wrong from a browser. Free the port, or ' +
        `\`houston down --name ${meta.name}\` then \`houston up\` for ` +
        'one that is free.',
    );
  }
  return strikes;
}

/** Stop waiting for something Kubernetes has already decided cannot happen. */
export async function refuseADoomedPod(
  meta: Metadata,
  namespace: string,
  context: string,
): Promise<void> {
  // A mistyped version or an unreachable registry used to cost the full timeout and then
  // report the timeout rather than the cause.
  const doomed = await terminalPodFailure(meta.name, { context });
  if (doomed !== null) {
    const [pod, reason, message] = doomed;
    throw new CreateFailedError(
      `'${meta.name}' cannot start: pod ${pod} is ${reason}` +
        (message ? ` — ${message}` : '') +
        `. Nothing will change by waiting. \`kubectl -n ${namespace} ` +
        `describe pod ${pod}\` has the detail.`,
    );
  }
}

/**
 * Wait for a Kubernetes workspace to serve, and make sure it is reachable.
 *
 * Two jobs, because on this runtime they are different questions. The pod being Ready is
 * Kubernetes' answer; the URL answering also needs a live port-forward, and a forward
 * dies with its pod.
 */
export async function waitServingKubernetes(
  meta: Metadata,
  emit: Emit,
  timeout: number,
): Promise<Record<string, unknown>> {
  const extra = bag(meta.extra);
  const context = isTruthy(extra[config.EXTRA_CONTEXT])
    ? String(extra[config.EXTRA_CONTEXT])
    : KUBE_CONTEXT;
  const namespace = isTruthy(extra.namespace)
    ? String(extra.namespace)
    : await namespaceFor(meta.name);
  const deadline = Date.now() + timeout * 1000;
  let last = 0;
  // Consecutive rounds where the workspace is ready and the port answers with something
  // that is not Rocket.Chat. Grace, not tolerance: it ends in a refusal.
  let foreign = 0;
  // Pod churn can leave a forward serving once before it dies. Require the same pid to
  // carry two observations before handing its URL over.
  let stablePid = 0;
  let current = extra;
  while (Date.now() < deadline) {
    if (await workspaceReady(meta.name, { context })) {
      const pid = await repairThePortForward(meta, emit, current, namespace, context);
      // A Ready pod is not proof that its forwarding socket answers. Confirm it instead
      // of handing over a URL on the strength of a pid alone.
      if (await forwardReachable(meta.hostPort)) {
        // OCCUPANCY IS NOT IDENTITY: ask Rocket.Chat rather than inferring it from a
        // Ready pod and an answering port.
        const served = await apiInfo(meta.rootUrl);
        if (served !== null) {
          foreign = 0;
          if (pid && pid === stablePid) {
            await warnAboutServicesWithNoEndpoints(meta, emit, namespace, context);
            info(emit, `'${meta.name}' is serving at ${meta.rootUrl}`, {
              phase: 'ready',
              pct: 100,
            });
            return { ready: true, url: meta.rootUrl };
          }
          stablePid = pid;
        } else {
          stablePid = 0;
          foreign = refuseAForeignHolder(meta, foreign);
        }
        current = { ...current, port_forward_pid: pid };
      } else {
        foreign = 0;
        stablePid = 0;
        current = { ...current, port_forward_pid: pid };
      }
    } else {
      stablePid = 0;
    }
    await refuseADoomedPod(meta, namespace, context);
    const now = Date.now();
    if (now - last > 15_000) {
      last = now;
      info(emit, `waiting for Rocket.Chat in ${namespace}`, { phase: 'wait' });
    }
    // `sleep(3000)`, which an Interrupted interrupts: a bare timer here was a
    // wait no Ctrl-C could reach, so `backup`'s unwind sat in it until the bound.
    await sleep(3000);
  }
  throw new NotReadyError(
    `Rocket.Chat did not become ready within ${String(Math.trunc(timeout))}s. ` +
      `kubectl -n ${namespace} get pods`,
  );
}

/**
 * Wait for the workspace to serve, then finish it off.
 *
 * `final` is whether this call is the END of what the user asked for. It is for `houston
 * ready`, which is exactly this and nothing else; `up` seeds afterwards, restore restores
 * afterwards, and an upgrade has a rollback still to consider. All three used to announce
 * phase `done` at 100% here and then carry on working.
 */
export async function waitAndFinalize(
  meta: Metadata,
  emit: Emit = nullEmit,
  timeout = 300.0,
  final = true,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const served = await waitServing(meta, emit, timeout);
  const elapsed = Math.floor((Date.now() - started) / 1000);
  const auth = await finalize(meta, emit);
  await postready.runPostReady(meta, auth, emit);
  // AND THE SEED THE INTERRUPTED CREATE ASKED FOR. The note says the workspace "may be
  // running without its preset configuration or seed data" and names this command as the
  // thing that completes it -- and this used to run post_ready, seed nothing, print
  // "ready" and clear the note anyway.
  //
  // From the NOTE, not from meta: the request died with the process, and
  // meta.extra["seed"] is written only after a seed has already succeeded.
  let pending = pendingSeed(meta.name);
  if (isTruthy(pending.seed_here)) {
    // The process that wrote this note is still running and will seed itself.
    pending = {};
  }
  if (Object.keys(pending).length > 0 && !isTruthy(bag(meta.extra).seed)) {
    info(
      emit,
      'finishing the seed the interrupted create asked for ' +
        `(profile: ${isTruthy(pending.seed_profile) ? String(pending.seed_profile) : 'small'})`,
      { phase: 'seed' },
    );
    try {
      await seeding.runSeedInline(
        meta,
        isTruthy(pending.seed_profile) ? String(pending.seed_profile) : 'small',
        Boolean(pending.seed_stats),
        emit,
      );
    } catch (error) {
      if (!(error instanceof ReproError)) throw error;
      // The note STAYS: a seed that could not be finished is exactly what it is for, and
      // clearing it here would delete the only record again.
      warn(
        emit,
        `the interrupted create's seed could not be finished (${errorText(error)}) - ` +
          `the note stays; \`houston seed --name ${meta.name}\` retries it`,
        { phase: 'seed' },
      );
      const running = String(served.version ?? '?');
      sayReady(emit, final);
      return { booted_s: elapsed, running_version: running };
    }
  }
  clearKind(CREATE_UNFINISHED, meta.name);
  const running = String(served.version ?? '?');
  if (running !== '?' && !meta.rcVersion.startsWith(running)) {
    warn(emit, `running version ${running} != requested ${meta.rcVersion}`, { phase: 'wait' });
  }
  sayReady(emit, final);
  return { booted_s: elapsed, running_version: running };
}
