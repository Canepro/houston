/**
 * Docker, for the edge. Tier 1 of `src/core/edge/`.
 *
 * Everything here goes through `seams/docker-cli.ts`, and this module is the adapter that
 * gives invocation failures the edge's contract: invocation adapters NEVER RAISE, the caller
 * reads the return code. The lifecycle lock and checked ingress repair can still refuse
 * an operation.
 *
 * That contract is not decoration. `houston edge stop` on a fresh home answered with a
 * stack trace naming a path under HOUSTON_HOME, because `cwd` is `edgeDir()` and a home
 * that has never had an edge has no such directory. 127 is what a shell reports for
 * "could not run it", and the reason travels on stderr where `why()` already looks.
 */
import { isIPv4, isIPv6 } from 'node:net';

import { DockerError } from '../../lib/errors';
import { quotedText, isTruthy } from '../../lib/format';
import { compose as composeSeam, docker as dockerSeam } from '../../seams/docker-cli';
import { engine as hostEngine } from '../runner/host';
import { listMeta } from '../runner/record';
import { portFree } from '../runner/ports';

import * as paths from './paths';
import { CONTAINER, PROJECT } from './paths';

/** What a finished docker command reported: its argv, return code and output. */
export interface DockerResult {
  readonly argv: readonly string[];
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The synthetic code a launch failure reports; the same 127 every other seam uses. */
export const LAUNCH_FAILURE_CODE = 127;

/**
 * Workspaces running their OWN Traefik on 443.
 *
 * They predate the edge, and they are why it cannot start: a machine has one port 443,
 * and theirs already has it. Read from the record rather than from docker, so this answers
 * the same whether they are running or merely `down`.
 */
export async function holdersOf443(): Promise<string[]> {
  const out: string[] = [];
  for (const meta of await listMeta()) {
    const extra = meta.extra as Record<string, unknown>;
    if (extra.edge === true) continue;
    const ports = Array.isArray(extra.tls_ports) ? extra.tls_ports : [];
    if (ports.some((port) => Number.parseInt(String(port), 10) === 443)) out.push(meta.name);
  }
  return out;
}

/** Run one docker command. NEVER RAISES; the caller reads the return code. */
export async function dockerRun(
  args: readonly string[],
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<DockerResult> {
  const argv = ['docker', ...args];
  try {
    const res = await dockerSeam(args, { capture: true, text: true, timeoutMs });
    return {
      argv,
      returncode: res.exitCode ?? LAUNCH_FAILURE_CODE,
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
    };
  } catch (error) {
    return {
      argv,
      returncode: LAUNCH_FAILURE_CODE,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * `docker compose` in the edge's own project. NEVER RAISES; read the return code.
 *
 * An explicit `-p`: the project must NOT be derived from the directory name, or it would
 * depend on where `<home>` happens to be.
 */
export async function composeRun(
  args: readonly string[],
  { timeoutMs }: { timeoutMs?: number } = {},
): Promise<DockerResult> {
  const argv = ['docker', 'compose', '-p', PROJECT, ...args];
  try {
    const res = await composeSeam(['-p', PROJECT, ...args], {
      cwd: paths.edgeDir(),
      capture: true,
      text: true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return {
      argv,
      returncode: res.exitCode ?? LAUNCH_FAILURE_CODE,
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
    };
  } catch (error) {
    return {
      argv,
      returncode: LAUNCH_FAILURE_CODE,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** `docker compose` in the edge project, captured. '' if it could not run. */
export async function composeCapture(args: readonly string[]): Promise<string> {
  const res = await composeRun(args, { timeoutMs: 30_000 });
  if (res.returncode === LAUNCH_FAILURE_CODE && res.stdout === '' && res.stderr !== '') {
    // Could not run it at all: '' for this, as it has always been, which is what makes
    // `acmeFailure` report nothing rather than report the launch error as a Traefik log.
    return '';
  }
  return res.stdout + res.stderr;
}

/**
 * The Docker bridge gateway, or '' if it cannot be determined.
 *
 * What the GUI binds when an edge is in front of it: the edge reaches it here (via
 * host.docker.internal, which resolves to this), and nothing off the box can -- verified
 * reachable from a container and refused from 127.0.0.1. That is strictly better than
 * 0.0.0.0, which would publish the control plane to the whole network just so one
 * container could reach it.
 *
 * Read rather than hardcoded to 172.17.0.1: that is only the DEFAULT bridge subnet, and a
 * box with a custom `bip` or an occupied 172.17/16 gets a different one.
 */
export async function bridgeAddress(): Promise<string> {
  const out = await dockerRun([
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ]);
  const gateway = out.returncode === 0 ? out.stdout.trim() : '';
  // ONLY IF THIS MACHINE CAN LISTEN THERE. A VM engine (Docker Desktop, a Podman machine)
  // keeps its bridge inside the VM, so the gateway is no address of this host and the GUI
  // could not bind it; such an engine forwards host.docker.internal to the host's loopback
  // instead. Asked by binding, not by listing interfaces: a Docker host's docker0 is DOWN
  // until a container uses it, and listing would wrongly call its gateway absent.
  if (gateway !== '' && !(await portFree(0, gateway))) return '127.0.0.1';
  return gateway;
}

/** Stop the edge. Routes are files and survive this, so starting it again restores
 * every name with no re-registration. */
export async function down(): Promise<number> {
  return await paths.edgeLock(
    async () => (await composeRun(['down', '--remove-orphans'])).returncode,
  );
}

/**
 * The id of a RUNNING edge container belonging to THIS home, or ''.
 *
 * Split out from `running()` so the two questions stay separate: whether a container of
 * ours is up, and whether it is actually serving. Conflating them is what let a Traefik
 * holding no ports be reported as a working edge.
 */
export async function ourContainer(): Promise<string> {
  const out = await dockerRun([
    'ps',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--filter',
    'status=running',
    '--format',
    '{{.ID}}',
  ]);
  if (out.returncode !== 0) return '';
  for (const cid of out.stdout.split(/\s+/u).filter((entry) => entry !== '')) {
    const where = await dockerRun([
      'inspect',
      cid,
      '--format',
      '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
    ]);
    if (where.returncode === 0 && where.stdout.trim() === paths.edgeDir()) return cid;
  }
  return '';
}

/** A checked observation preserves its reason without authorising a mutation on unknown. */
interface IngressProbe<T> {
  readonly value: T | null;
  readonly reason: string;
}

/** The inspected IPv4 of the edge's own ingress network, or unknown. */
async function ingressAddress(cid: string): Promise<IngressProbe<string>> {
  const seen = await dockerRun(['inspect', cid, '--format', '{{json .NetworkSettings.Networks}}']);
  if (seen.returncode !== 0) {
    return { value: null, reason: `could not inspect ingress: ${why(seen)}` };
  }
  try {
    const parsed: unknown = JSON.parse(seen.stdout);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const ingress = (parsed as Record<string, unknown>)[`${PROJECT}_default`];
      if (ingress !== null && typeof ingress === 'object' && !Array.isArray(ingress)) {
        const address = (ingress as Record<string, unknown>).IPAddress;
        if (typeof address === 'string' && isIPv4(address)) {
          return { value: address, reason: '' };
        }
      }
    }
    return { value: null, reason: `inspect has no valid IPv4 for ${PROJECT}_default` };
  } catch {
    return { value: null, reason: 'ingress inspect was not valid JSON' };
  }
}

/** Actual IPv4 interface addresses from the command proven in the edge image. */
async function namespaceAddresses(cid: string): Promise<IngressProbe<Set<string>>> {
  const seen = await dockerRun(['exec', cid, 'ip', 'addr', 'show'], {
    timeoutMs: 5_000,
  });
  if (seen.returncode !== 0) {
    return { value: null, reason: `could not read actual ingress addresses: ${why(seen)}` };
  }
  const lines = seen.stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return { value: null, reason: 'actual address output was empty' };
  const addresses = new Set<string>();
  let hasInterface = false;
  const malformed = { value: null, reason: 'actual address output was malformed' };
  for (const line of lines) {
    if (/^[1-9]\d*:\s+\S+:\s+<[^>]+>\s+mtu\s+\d+(?:\s.*)?$/u.test(line)) {
      hasInterface = true;
      continue;
    }
    if (!hasInterface || !/^\s/u.test(line)) return malformed;
    const text = line.trim();
    if (/^inet\s/u.test(text)) {
      const match =
        /^inet\s+([0-9.]+)\/(\d+)(?:\s+brd\s+([0-9.]+))?\s+scope\s+(?:host|global|link)(?:\s+\S+)*$/u.exec(
          text,
        );
      if (
        match === null ||
        match[1] === undefined ||
        match[2] === undefined ||
        !isIPv4(match[1]) ||
        Number(match[2]) > 32 ||
        (match[3] !== undefined && !isIPv4(match[3]))
      ) {
        return malformed;
      }
      addresses.add(match[1]);
      continue;
    }
    if (/^inet6\s/u.test(text)) {
      const match =
        /^inet6\s+([0-9a-f:.]+)\/(\d+)\s+scope\s+(?:host|global|link|site)(?:\s+\S+)*$/iu.exec(
          text,
        );
      if (
        match === null ||
        match[1] === undefined ||
        match[2] === undefined ||
        !isIPv6(match[1]) ||
        Number(match[2]) > 128
      ) {
        return malformed;
      }
      continue;
    }
    if (
      /^link\/(?:loopback|ether)\s+(?:[0-9a-f]{2}:){5}[0-9a-f]{2}(?:\s+brd\s+(?:[0-9a-f]{2}:){5}[0-9a-f]{2})?$/iu.test(
        text,
      ) ||
      /^valid_lft\s+(?:forever|\d+sec)\s+preferred_lft\s+(?:forever|\d+sec)$/u.test(text)
    ) {
      continue;
    }
    return malformed;
  }
  return addresses.size > 0
    ? { value: addresses, reason: '' }
    : { value: null, reason: 'actual address output contained no IPv4 addresses' };
}

/**
 * Repair only a proven missing rootless-Podman ingress address after a network change.
 *
 * Podman can retain the edge's own network in inspect after losing its actual interface.
 * The published rootless forwarder then accepts TCP but cannot reach Traefik. A restart
 * rebuilds this container's namespace and forwarder without changing routes or certs.
 *
 * Call with edgeLock held. Docker, rootful Podman, unknown probes and workspace-only
 * address loss leave the existing behavior alone. A known broken ingress briefly stops
 * THIS home's shared edge exactly once; a failed or unverified repair raises its reason.
 */
export async function repairRootlessIngress(): Promise<void> {
  const host = await hostEngine();
  if (host === null || host.kind !== 'podman' || !host.rootless) return;
  const cid = await ourContainer();
  if (cid === '') return;
  const address = await ingressAddress(cid);
  if (address.value === null) return;
  const actual = await namespaceAddresses(cid);
  if (actual.value === null || actual.value.has(address.value)) return;

  // Re-read both ownership and ingress after the first observation. A replaced edge,
  // unreadable probe, or legitimate address change cannot authorise restarting stale ID.
  if ((await ourContainer()) !== cid) return;
  const currentAddress = await ingressAddress(cid);
  if (currentAddress.value === null) return;
  const currentActual = await namespaceAddresses(cid);
  if (currentActual.value === null || currentActual.value.has(currentAddress.value)) return;
  const restarted = await dockerRun(['restart', cid]);
  if (restarted.returncode !== 0) {
    throw new DockerError(`Podman edge ingress repair failed for ${cid}: ${why(restarted)}`);
  }
  if ((await ourContainer()) !== cid) {
    throw new DockerError(`Podman edge ingress repair lost ownership of ${cid}`);
  }
  const repairedAddress = await ingressAddress(cid);
  const repairedActual = await namespaceAddresses(cid);
  if (
    repairedAddress.value === null ||
    repairedActual.value === null ||
    !repairedActual.value.has(repairedAddress.value)
  ) {
    const reason =
      repairedAddress.value === null
        ? repairedAddress.reason
        : repairedActual.value === null
          ? repairedActual.reason
          : `inspected address ${repairedAddress.value} is still absent from the container`;
    throw new DockerError(
      `Podman edge ingress repair did not restore ${PROJECT}_default on ${cid}: ${reason}`,
    );
  }
}

/**
 * Whether container `cid` actually HOLDS :80 and :443.
 *
 * Up is not the same as serving, and the gap is not theoretical: a container can start
 * while another process owns its ports, and Docker then runs it with the bindings simply
 * absent. That is a Traefik answering on nothing -- it cannot serve a single name -- and
 * `running()` used to call it running. `edge status` then said "State running" over an
 * edge that was serving nothing, which is the one shape of wrong answer this file exists
 * to avoid: every workspace with a name depends on this component, and nothing else in
 * the tool would have contradicted it.
 */
export async function publishesPorts(cid: string): Promise<boolean> {
  const seen = await dockerRun(['inspect', cid, '--format', '{{json .NetworkSettings.Ports}}']);
  if (seen.returncode !== 0) return true; // cannot tell: do not invent a failure
  let ports: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(seen.stdout.trim() || '{}');
    ports =
      parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return true;
  }
  // A truth test on each of `80/tcp` and `443/tcp`, so a port EXPOSED with no binding --
  // `"443/tcp": []` -- holds nothing, as `null` does. Only null, undefined and false
  // counted as unbound here, so doctor called that edge running and exited 0 where the
  // established answer is NOT running, exit 1.
  return [80, 443].every((port) => isTruthy(ports[`${String(port)}/tcp`]));
}

/**
 * Whether THIS home's edge is running.
 *
 * The project label alone is not enough. Every HOUSTON_HOME uses the same compose project
 * name, so a container started from a different home matched and this returned true --
 * while `installed()`, which reads the current home, returned false. `ensureRunning()`
 * then skipped writing any configuration, the routes went into a directory nothing was
 * watching, and every name 404'd with `edge status` reporting "no edge yet" beside a
 * running edge.
 */
export async function running(): Promise<boolean> {
  const cid = await ourContainer();
  return cid !== '' && (await publishesPorts(cid));
}

/**
 * What is holding `port`, named, or '' if nothing is.
 *
 * The edge failing to bind is the one startup error that is genuinely somebody else's
 * fault, and "the edge did not start" is useless on its own -- hit twice while building
 * this, once from a stale front door left by an older houston and once from an unrelated
 * Traefik. Docker can name a container; anything else is at least identified as not-us.
 */
export async function portHolder(port = 443): Promise<string> {
  const out = await dockerRun(['ps', '--format', '{{.Names}}\t{{.Ports}}']);
  if (out.returncode === 0) {
    const mine = await running();
    for (const line of out.stdout.split('\n')) {
      const [name, ports] = [line.split('\t')[0] ?? '', line.split('\t').slice(1).join('\t')];
      if (!ports.includes(`:${String(port)}->`)) continue;
      // Skipping by NAME alone hid the most confusing case of all: an edge from a
      // different HOUSTON_HOME has exactly our container name, so it was excluded as
      // "us" and reported as "something outside Docker".
      if (name === CONTAINER && mine) continue;
      if (name === CONTAINER) return `an edge from another HOUSTON_HOME (${quotedText(name)})`;
      const proj = await dockerRun([
        'inspect',
        name,
        '--format',
        '{{index .Config.Labels "com.docker.compose.project"}}',
      ]);
      const label = proj.returncode === 0 ? proj.stdout.trim() : '';
      // The project MATTERS, because it is what `docker compose -p ... down` takes.
      // Naming only the container sent somebody at our own project, which is the one
      // command that cannot free the port.
      if (label !== '' && label !== PROJECT) {
        // `quotedText`'s quotes, so a project named `it's-proj` is double-quoted, as it has
        // always been printed.
        return `the container ${quotedText(name)} (compose project ${quotedText(label)})`;
      }
      return `the container ${quotedText(name)}`;
    }
  }
  return (await portFree(port)) ? '' : 'something outside Docker';
}

/**
 * The working directory of an edge belonging to a DIFFERENT HOUSTON_HOME.
 *
 * Compose keys a project by NAME, and every home uses the same one, so `docker compose -p
 * houston_edge up -d` REPLACES another home's container rather than failing -- silently
 * taking down every https name that edge was serving. Observed doing exactly that while
 * testing.
 *
 * It matters more than the "one shared home" assumption suggests, because the default home
 * is `~/.houston`: on a box where two people each run houston as themselves, the second
 * `up --https` quietly steals the first one's ingress.
 */
export async function foreignEdge(): Promise<string> {
  const out = await dockerRun([
    'ps',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--filter',
    'status=running',
    '--format',
    '{{.ID}}',
  ]);
  for (const cid of out.stdout.split(/\s+/u).filter((entry) => entry !== '')) {
    const where = await dockerRun([
      'inspect',
      cid,
      '--format',
      '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
    ]);
    const found = where.stdout.trim();
    if (found !== '' && found !== paths.edgeDir()) return found;
  }
  return '';
}

/**
 * The line that explains a docker failure, not the first 500 characters of noise.
 *
 * Same rule as the kube seam's `why`, and for the same reason: compose puts its
 * diagnostics FIRST and its error LAST, so taking a prefix reliably shows the least
 * useful part.
 */
export function why(res: DockerResult, limit = 500): string {
  const text = [res.stderr, res.stdout].filter((part) => part !== '').join('\n');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const line of [...lines].reverse()) {
    const low = line.toLowerCase();
    if (low.startsWith('error') || low.includes('error:') || low.includes('cannot')) {
      return line.slice(0, limit);
    }
  }
  return lines.length > 0
    ? (lines[lines.length - 1] as string).slice(0, limit)
    : 'docker said nothing';
}

/** The injectable callables, for the same swc reason every other seam adapter has one. */
export const edgeDocker = { run: dockerRun, compose: composeRun, capture: composeCapture };
