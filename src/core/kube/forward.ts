/**
 * `kubectl port-forward`, and the question of whether the socket is actually ours.
 *
 * A forward dies with its pod, so this is the module `ready` leans on when somebody asks why
 * the URL stopped answering. `forwardBound` confirms the socket rather than trusting the pid:
 * kubectl returns one before it binds.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { CreateFailedError, DockerError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';
import { startDetached } from '../../seams/exec';

import { answerWhy, askList, items, refused } from './ask';
import { envFor, kube } from './exec';
import { GRAFANA_DEPLOYMENT, GRAFANA_PORT, MONITORING_NAMESPACE } from './monitoring';
import { POD_WAIT_INTERVAL, POD_WAIT_REFUSALS, POD_WAIT_TRIES, RELEASE, isOurs } from './names';
import type { Sleep } from './replicaset';
import { serviceReadyAddresses, terminalPodFailure } from './status';

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * A scenario Service wearing this label is published on the host port it names. The label
 * rather than a table here, because the adapter that creates the Service is the thing that
 * knows it has a UI -- and a table would be a second place to declare a port.
 */
export const UI_PORT_LABEL = 'houston.io/ui-port';

/**
 * Up to two minutes for a scenario's workload to have a ready endpoint. Keycloak imports a
 * realm on first boot and takes about forty seconds of it.
 */
export const ENDPOINT_WAIT_TRIES = 60;

export const ENDPOINT_WAIT_INTERVAL = 2.0;

/** Socket inodes LISTENING on `port`, from /proc/net/tcp{,6}. */
export function listeningInodes(port: number): Set<string> {
  const out = new Set<string>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let lines: string[];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const fields = line.split(/\s+/u).filter((entry) => entry !== '');
      // 0A is TCP_LISTEN; anything else is a connection, not a bind.
      if (fields.length < 10 || fields[3] !== '0A') continue;
      const local = (fields[1] ?? '').split(':')[1];
      if (local === undefined) continue;
      if (Number.parseInt(local, 16) === port) out.add(fields[9] as string);
    }
  }
  return out;
}

/** The socket inodes this pid holds open. Empty for a process we cannot read. */
export function socketInodesOf(pid: number): Set<string> {
  let entries: string[];
  try {
    entries = fs.readdirSync(`/proc/${String(pid)}/fd`);
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const entry of entries) {
    let target: string;
    try {
      target = fs.readlinkSync(path.join(`/proc/${String(pid)}/fd`, entry));
    } catch {
      continue;
    }
    if (target.startsWith('socket:[')) out.add(target.slice(8, -1));
  }
  return out;
}

/**
 * Whether THIS pid holds a listening socket on `port`.
 *
 * Ownership, and it is answered rather than timed. Every other way of asking -- "is the port
 * up?", "is the child still alive?" -- is a race against a kubectl that has not failed yet,
 * and it lost that race 3 times out of 3 against a squatter.
 *
 * An unreadable /proc entry (a process that is not ours) yields no inodes and so answers
 * false, which is the safe direction.
 */
export function pidOwnsPort(pid: number, port: number): boolean {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return false;
  const mine = socketInodesOf(pid);
  if (mine.size === 0) return false;
  for (const inode of inodes) if (mine.has(inode)) return true;
  return false;
}

/**
 * Whether EVERY listener on `port` belongs to `pid` -- no other family, no other process.
 *
 * `pidOwnsPort` answers "is one of these sockets mine", and that is not the same question
 * when two processes can hold the same port on different families. `kubectl port-forward`
 * binds "localhost", which is BOTH 127.0.0.1 and [::1] -- and if an IPv4-only process
 * already holds the port, kubectl does not fail: it binds [::1] alone and runs happily.
 * Measured exactly that: kubectl on `[::1]:3250` only, `127.0.0.1:3250` answering a
 * different program, and houston reporting the workspace as reachable.
 *
 * Deliberately not solved by forcing `--address 127.0.0.1`: houston publishes
 * `http://localhost:P`, and on a box whose `localhost` resolves to `::1` first, binding IPv4
 * only would break the URL for everybody.
 */
export function pidOwnsPortExclusively(pid: number, port: number): boolean {
  const inodes = listeningInodes(port);
  if (inodes.size === 0) return false;
  const mine = socketInodesOf(pid);
  for (const inode of inodes) if (!mine.has(inode)) return false;
  return true;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether THIS child actually got the socket. Waits for one answer or the other.
 *
 * `kubectl port-forward` cannot share a port: if something already holds it, kubectl prints
 * "Unable to listen on port N: bind: address already in use" and exits within milliseconds.
 * Returning the pid regardless recorded a pid that was already dead -- and because a port
 * check only asks whether the port ANSWERS, and the squatter answers, `ready` then certified
 * the workspace's URL while a different program served it.
 *
 * The child exiting is a definite no; the socket answering while the child lives is a yes;
 * neither yet means keep waiting.
 */
export async function forwardBound(
  pid: number,
  hostPort: number,
  { tries = 20, interval = 0.5, sleep = realSleep } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (!alive(pid)) return false;
    // OUR CHILD'S SOCKET, not "a socket". Asking whether the PORT answers made this return
    // true against a squatter every time, in a tenth of a millisecond.
    if (pidOwnsPortExclusively(pid, hostPort)) return true;
    await sleep(interval);
  }
  return alive(pid) && pidOwnsPortExclusively(pid, hostPort);
}

/**
 * Whether SOMETHING is listening on the host port yet. Occupancy, not identity.
 *
 * `kubectl port-forward` returns a pid long before it has bound the socket, so a URL printed
 * straight after spawning it is a guess.
 *
 * It cannot tell you WHOSE socket it is. A foreign process holding the port answers this
 * exactly as our own forward does, so nothing may conclude "the workspace is serving" from
 * this alone.
 */
export async function forwardReachable(
  hostPort: number,
  { tries = 20, interval = 0.5, sleep = realSleep } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const answered = await new Promise<boolean>((resolve) => {
      const probe = new net.Socket();
      const done = (value: boolean): void => {
        probe.destroy();
        resolve(value);
      };
      probe.setTimeout(1000, () => done(false));
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
      probe.connect(hostPort, '127.0.0.1');
    });
    if (answered) return true;
    await sleep(interval);
  }
  return false;
}

/**
 * Fallback identity when the process hid its own arguments.
 *
 * Three facts together, and none of them alone would do: the pid came from OUR record, the
 * process is still a `kubectl`, and the port it was started for is actually held. Pid
 * recycling is what the argv check exists to defeat, and a recycled pid that is also a
 * kubectl that is also listening on exactly the port we recorded is a coincidence worth
 * accepting -- the alternative is calling every healthy forward on every k3s host dead.
 */
function forwardAliveWithoutArgv(pid: number, hostPort: number | null): boolean {
  let comm: string;
  try {
    comm = fs.readFileSync(`/proc/${String(pid)}/comm`, 'utf8').trim();
  } catch {
    return false;
  }
  if (comm !== 'kubectl' && comm !== 'k3s') return false;
  if (hostPort === null) return true;
  // `pidOwnsPort`, not `forwardReachable`: "the port answers" is satisfied by whoever holds
  // it, which is exactly the confusion this fallback exists inside.
  return pidOwnsPort(pid, hostPort);
}

/**
 * Whether `pid` is OUR port-forward -- not merely someone's.
 *
 * A pid alone is not enough: the OS recycles them. This used to accept any process whose
 * command line mentioned `port-forward`, which is a liveness check dressed as an identity
 * check. A recycled pid belonging to a different workspace's forward -- or another user's,
 * on a shared box -- passed it.
 *
 * The argv already carries the proof. Matched as whole NUL-separated tokens, because a
 * substring test lets `3000` match `13000`.
 */
export function forwardAlive(
  pid: number | null | undefined,
  { namespace = '', hostPort = null }: { namespace?: string; hostPort?: number | null } = {},
): boolean {
  if (pid === null || pid === undefined || pid === 0) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8');
  } catch {
    return false;
  }
  const argv = raw.split('\0').filter((token) => token !== '');
  // AN ARGV OF ONE IS NOT AN ARGV THAT DISAGREES. On a host where `kubectl` is a symlink to
  // `k3s` -- which is every k3s host -- the multi-call binary rewrites its own command line
  // when it dispatches, so /proc/<pid>/cmdline reads `kubectl` and then nothing. Reading that
  // as "the forward is gone" made this respawn onto a port its own live forward already
  // held, on every call.
  if (argv.length <= 1) return forwardAliveWithoutArgv(pid, hostPort);
  if (!argv.includes('port-forward')) return false;
  if (namespace !== '' && !argv.includes(namespace)) return false;
  if (hostPort !== null && !argv.some((token) => token.startsWith(`${String(hostPort)}:`))) {
    return false;
  }
  return true;
}

/**
 * Retire a recorded port-forward. True if one was signalled.
 *
 * `hostPort` is the port the forward was PUBLISHED ON, not the one being asked for now, and
 * that difference is the whole bug: `up --port 3261` on a workspace already forwarded on
 * 3260 asked about 3261, got false, recorded pid 0 and walked away -- leaving the old
 * kubectl alive on 3260 with nothing able to find it again.
 */
export function stopForward(
  pid: number | null | undefined,
  {
    namespace,
    hostPort,
    emit = nullEmit,
  }: { namespace: string; hostPort: number | null; emit?: Emit },
): boolean {
  if (pid === null || pid === undefined || pid === 0) return false;
  if (!forwardAlive(pid, { namespace, hostPort })) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  info(emit, `stopped the previous port-forward on :${String(hostPort)} (pid ${String(pid)})`, {
    phase: 'boot',
  });
  return true;
}

function forwardArgv(
  context: string,
  namespace: string,
  bindHost: string,
  target: string,
  ports: string,
): [string, ...string[]] {
  const argv: [string, ...string[]] = [
    'kubectl',
    '--context',
    context,
    '-n',
    namespace,
    'port-forward',
  ];
  // `--bind` was accepted and then dropped on this path, which is worse than refusing it: a
  // workspace created with `--bind 0.0.0.0` on a shared box was reachable only from
  // localhost, and nothing said so. kubectl binds 127.0.0.1 by default and takes --address.
  if (bindHost !== '' && bindHost !== '127.0.0.1' && bindHost !== 'localhost') {
    argv.push('--address', bindHost);
  }
  argv.push(target, ports);
  return argv;
}

async function spawnForward(argv: [string, ...string[]], context: string): Promise<number> {
  const env = envFor(context);
  try {
    // Detached, so it outlives the `up` that started it -- the workspace has to stay
    // reachable after the command returns, exactly as a published Compose port does.
    const child = await startDetached(argv, { ...(env !== undefined ? { env } : {}) });
    return child.pid;
  } catch {
    return 0;
  }
}

/** Wait for a Rocket.Chat pod, and say why if none arrives. */
async function waitForAPodToForwardTo(
  context: string,
  emit: Emit,
  name: string,
  namespace: string,
  sleep: Sleep,
): Promise<void> {
  // RUNNING, not merely existing. `kubectl port-forward` refuses a pod that is still
  // ContainerCreating and exits, which is precisely what happened when this waited only for a
  // pod NAME. Existence is not reachability.
  //
  // THE EXIT CODE WAS NEVER READ HERE, and empty stdout from a refused call is identical to
  // "the pod is not Running yet". So this waited the full budget against a cluster that had
  // been destroyed: measured at 94 seconds and nine "waiting" messages after the control
  // plane was killed.
  let refusals = 0;
  for (let attempt = 0; attempt < POD_WAIT_TRIES; attempt += 1) {
    const seen = await askList('pod', {
      context,
      namespace,
      selector: 'app.kubernetes.io/name=rocketchat',
    });
    if (refused(seen)) {
      refusals += 1;
      if (refusals >= POD_WAIT_REFUSALS) {
        throw new DockerError(
          `could not ask cluster '${context}' about the Rocket.Chat pod in ${namespace} ` +
            `(${String(refusals)} attempts): ${answerWhy(seen)}. Waiting longer will not ` +
            'help while the cluster cannot be reached.',
        );
      }
      await sleep(POD_WAIT_INTERVAL);
      continue;
    }
    refusals = 0;
    const phases = items(seen).map((item) => {
      const status = item.status;
      return status !== null && typeof status === 'object'
        ? String((status as { phase?: unknown }).phase ?? '')
        : '';
    });
    if (phases.includes('Running')) return;
    // Stop waiting for something Kubernetes has already decided cannot happen.
    const doomed = await terminalPodFailure(name, { context });
    if (doomed !== null) {
      const [pod, reason, message] = doomed;
      throw new CreateFailedError(
        `'${name}' cannot start: pod ${pod} is ${reason}` +
          (message !== '' ? ` — ${message}` : '') +
          `. Nothing will change by waiting. \`kubectl -n ${namespace} describe pod ${pod}\` ` +
          'has the detail.',
      );
    }
    if (attempt % 4 === 0) info(emit, 'waiting for the Rocket.Chat pod', { phase: 'wait' });
    await sleep(POD_WAIT_INTERVAL);
  }
}

/**
 * Publish a workspace on a host port. Returns the pid, or 0.
 *
 * Forwards to the DEPLOYMENT, not the Service. `port-forward svc/...` needs a ready
 * ENDPOINT, and a Service has none until its pod passes readiness -- so the first version
 * started the forward immediately after `helm install`, kubectl found nothing to attach to
 * and exited, and the URL `up` printed never answered.
 */
export async function portForward(
  name: string,
  {
    namespace,
    context,
    hostPort,
    bindHost = '',
    previousPid = 0,
    previousPort = null,
    emit = nullEmit,
    sleep = realSleep,
  }: {
    namespace: string;
    context: string;
    hostPort: number;
    bindHost?: string;
    previousPid?: number;
    previousPort?: number | null;
    emit?: Emit;
    sleep?: Sleep;
  },
): Promise<number> {
  await waitForAPodToForwardTo(context, emit, name, namespace, sleep);
  // THE OLD ONE GOES FIRST. A `--port` change leaves the previous kubectl alive holding the
  // previous port, with nothing able to find it again because every later lookup asks about
  // the NEW port.
  stopForward(previousPid, {
    namespace,
    hostPort: previousPort !== null && previousPort !== 0 ? previousPort : hostPort,
    emit,
  });
  const pid = await spawnForward(
    forwardArgv(
      context,
      namespace,
      bindHost,
      `deployment/${RELEASE}-rocketchat`,
      `${String(hostPort)}:3000`,
    ),
    context,
  );
  if (pid === 0) return 0;
  // CONFIRMED, not assumed: returning the pid recorded one for a kubectl that had already
  // exited because the port was taken.
  if (!(await forwardBound(pid, hostPort, { sleep }))) {
    // WHY IT DID NOT COME UP, rather than one guess applied to every cause. This asserted
    // "Something else probably holds that port" unconditionally, and the commonest cause is
    // the exact opposite: during a rolling update the pod the forward attached to goes away,
    // kubectl exits, and NOTHING holds the port. A false alarm that prescribes destroying
    // the workspace is worse than no alarm.
    if (listeningInodes(hostPort).size > 0) {
      warn(
        emit,
        `the port-forward for '${name}' did not come up on port ${String(hostPort)}: ` +
          `something else already holds it — \`ss -ltnp | grep ${String(hostPort)}\` says ` +
          `what, and \`houston down --name ${name}\` then \`houston up\` picks a free one.`,
        { phase: 'wait' },
      );
    } else {
      warn(
        emit,
        `the port-forward for '${name}' dropped while the pod was moving — nothing holds ` +
          `port ${String(hostPort)}, so this is not a collision. \`houston ready --name ` +
          `${name}\` re-establishes it; a create or upgrade does that for you on the next ` +
          'check.',
        { phase: 'wait' },
      );
    }
    return 0;
  }
  return pid;
}

/**
 * Return a live port-forward pid, starting one if the recorded one is gone.
 *
 * A forward dies with its pod, so `ready` and `start` call this rather than assuming the one
 * written at create time is still there. Idempotent: an already-live forward is left alone
 * rather than duplicated onto a busy port.
 */
export async function ensurePortForward(
  name: string,
  {
    namespace,
    context,
    hostPort,
    pid = 0,
    bindHost = '',
    emit = nullEmit,
  }: {
    namespace: string;
    context: string;
    hostPort: number;
    pid?: number;
    bindHost?: string;
    emit?: Emit;
  },
): Promise<number> {
  if (forwardAlive(pid, { namespace, hostPort })) return pid;
  // The recorded pid is handed on as the one to retire: it is not alive ON THIS PORT, which
  // is a different statement from "it is not alive".
  return await portForward(name, {
    namespace,
    context,
    hostPort,
    bindHost,
    previousPid: pid,
    previousPort: hostPort,
    emit,
  });
}

/** Parse one service publication row, or return null for malformed output. */
export function listedService(line: string): [string, number, number, string] | null {
  const parts = line.split(/\s+/u).filter((entry) => entry !== '');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [svc, host, target] = parts as [string, string, string];
  const deploy = parts.length === 4 ? (parts[3] as string) : svc;
  const hostPort = Number.parseInt(host, 10);
  const targetPort = Number.parseInt(target, 10);
  if (!Number.isFinite(hostPort) || !Number.isFinite(targetPort)) return null;
  return [svc, hostPort, targetPort, deploy];
}

/**
 * Publish every scenario Service that asks to be published. Returns `{port: pid}`.
 *
 * Compose gives a preset's UI a host port for free; here it is a port-forward, for the
 * reasons NodePort cannot serve: its range is 30000-32767 so the port would not MATCH the
 * Compose one, kind's nodes are unreachable from the host on macOS and Windows, and
 * `extraPortMappings` is fixed when the cluster is created.
 */
export async function scenarioUiForwards(
  _name: string,
  {
    namespace,
    context,
    bindHost = '',
    emit = nullEmit,
    sleep = realSleep,
  }: { namespace: string; context: string; bindHost?: string; emit?: Emit; sleep?: Sleep },
): Promise<Record<number, number>> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'svc',
      '-l',
      UI_PORT_LABEL,
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{" "}' +
        '{.metadata.labels.houston\\.io/ui-port}{" "}' +
        '{.spec.ports[0].targetPort}{" "}' +
        '{.metadata.labels.houston\\.io/ui-deployment}{"\\n"}{end}',
    ],
    { own: isOurs(context) },
  );

  const forwards: Record<number, number> = {};
  for (const line of res.stdout.split('\n')) {
    const listed = listedService(line);
    if (listed === null) continue;
    const [svc, hostPort, targetPort, deploy] = listed;
    // WAIT FOR A READY ENDPOINT FIRST. `kubectl port-forward svc/...` binds the local socket
    // immediately and only then dials a pod -- so a forward started while the workload is
    // still booting passes a TCP check on the local side, fails upstream, and exits. Keycloak
    // takes ~40 s to import its realm, and that is exactly what happened.
    let ready = false;
    for (let attempt = 0; attempt < ENDPOINT_WAIT_TRIES; attempt += 1) {
      const counts = await serviceReadyAddresses(namespace, { context });
      if (counts !== null && (counts[svc] ?? 0) > 0) {
        ready = true;
        break;
      }
      await sleep(ENDPOINT_WAIT_INTERVAL);
    }
    if (!ready) {
      warn(
        emit,
        `${svc} has no ready endpoint yet; publish it when it is up: kubectl -n ${namespace} ` +
          `port-forward svc/${svc} ${String(hostPort)}:${String(targetPort)}`,
        { phase: 'boot' },
      );
      continue;
    }
    // deployment/, NOT svc/. A Service forward dies when its endpoint churns -- which is
    // exactly what happened to a live OIDC workspace: Keycloak was 1/1 Running, the recorded
    // pid was gone, and nothing answered.
    const pid = await spawnForward(
      forwardArgv(
        context,
        namespace,
        bindHost,
        `deployment/${deploy}`,
        `${String(hostPort)}:${String(targetPort)}`,
      ),
      context,
    );
    // Confirmed, not assumed -- the same rule the workspace URL and Grafana both had to
    // learn. And `forwardBound` rather than `forwardReachable`, because the port answering is
    // not evidence that OUR kubectl is the thing answering.
    if (pid !== 0 && (await forwardBound(pid, hostPort, { sleep }))) {
      forwards[hostPort] = pid;
      info(emit, `${svc} published at http://localhost:${String(hostPort)}`, { phase: 'boot' });
    } else {
      warn(
        emit,
        `${svc} is running but http://localhost:${String(hostPort)} is not answering yet; ` +
          `\`kubectl -n ${namespace} port-forward svc/${svc} ${String(hostPort)}:` +
          `${String(targetPort)}\` re-establishes it`,
        { phase: 'boot' },
      );
    }
  }
  return forwards;
}

/**
 * Publish Grafana on a host port. Returns the pid, or 0.
 *
 * Same deployment-not-Service rule as the workspace forward, for the same reason: a Service
 * with no ready endpoint makes kubectl exit immediately.
 */
export async function grafanaForward({
  context,
  hostPort,
  bindHost = '',
}: {
  context: string;
  hostPort: number;
  bindHost?: string;
}): Promise<number> {
  const pid = await spawnForward(
    forwardArgv(
      context,
      MONITORING_NAMESPACE,
      bindHost,
      `deployment/${GRAFANA_DEPLOYMENT}`,
      `${String(hostPort)}:${String(GRAFANA_PORT)}`,
    ),
    context,
  );
  if (pid === 0) return 0;
  // Same rule as the workspace forward. This path has form: it is where "reported attached
  // and exit 0, and a curl a moment later got nothing" was measured.
  if (!(await forwardBound(pid, hostPort))) return 0;
  return pid;
}
