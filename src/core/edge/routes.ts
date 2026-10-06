/**
 * The route files, and who claims which name. Tier 5 of `src/core/edge/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import { foldCase } from '../../lib/format';
import { atomicWrite } from '../runner/paths';

import { attach, workspaceNetwork } from './networks';
import * as paths from './paths';
import { RULE_HOST } from './paths';
import { passthroughRouteYml, workspaceRouteYml } from './routeyml';
import { current } from './spec';
import { covers, type Edge } from './types';

/**
 * Whether the edge can actually deliver `name`'s route, given what it is attached to.
 *
 * TWO DIFFERENT QUESTIONS behind one column. An HTTP route is delivered over a Docker
 * network the edge has joined, so membership is the test. A PASSTHROUGH route forwards raw
 * TCP to an address -- a cluster NodePort -- and joins no workspace network at all, so
 * membership is always false for it and the honest answer is not "unreachable".
 *
 * `/api/edge` learned this and `edge status` did not, so the CLI reported `NO (502)` for
 * every Kubernetes workspace. Measured in production conditions: a workspace answering
 * HTTP 200 from the internet on a real Let's Encrypt certificate, listed as unreachable by
 * the command whose job is to say so. One implementation here because that is the second
 * time these two front ends disagreed about the same route file.
 */
export async function routeReachable(name: string, attached: Iterable<string>): Promise<boolean> {
  if (isPassthrough(name)) return true;
  return new Set(attached).has(await workspaceNetwork(name));
}

/**
 * Whether `name`'s route passes TLS through rather than terminating it.
 *
 * Read from the route FILE, and parsed rather than sniffed for a substring: the caller
 * that needs it is `reattachAll` on the `edge start` path, which is looking at routes and
 * may have no workspace record to consult -- a route outlives its workspace, which is the
 * whole reason `deregister` exists.
 *
 * False for anything unreadable. The only consequence of being wrong here is an attach
 * that was not needed, which is a no-op, so the safe answer is the one that behaves as
 * this function's absence did.
 */
export function isPassthrough(name: string): boolean {
  try {
    const doc: unknown = YAML.parse(fs.readFileSync(paths.routePath(name), 'utf8'), {
      uniqueKeys: false,
    });
    return doc !== null && typeof doc === 'object' && 'tcp' in doc;
  } catch {
    return false;
  }
}

/**
 * Add (or replace) a workspace's route. Picked up without a restart.
 *
 * Returns whether `host` needs a certificate OF ITS OWN -- false when the edge's wildcard
 * already covers it, which is what the caller counts against the weekly limit. Decided
 * here because this is where the edge's own configuration is readable.
 *
 * Attaching is part of registering, not a separate step a caller can forget: a route
 * pointing at a container the edge cannot resolve is a 502 rather than an error, which is
 * the hardest kind of failure to diagnose.
 *
 * `passthrough` is an `<address>:<port>` the edge forwards raw TCP to instead of
 * terminating -- a Kubernetes workspace's ingress. It takes a plain address on purpose:
 * the edge has no business knowing what a cluster is, and keeping this module
 * runtime-agnostic is what stops "does this workspace terminate TLS" from becoming a
 * build-time property again.
 *
 * Two things do NOT happen for a passthrough, and both would be wrong rather than merely
 * wasteful. There is no `attach`: that joins a Docker network named after a compose
 * project, and a Kubernetes workspace has neither. And the return is always false, because
 * no certificate is requested for a name the edge does not present one for -- counting it
 * against the weekly limit would spend budget on nothing.
 */
export async function register(
  name: string,
  host: string,
  {
    instances = 1,
    local = false,
    passthrough = '',
    grafana = false,
  }: { instances?: number; local?: boolean; passthrough?: string; grafana?: boolean } = {},
): Promise<boolean> {
  fs.mkdirSync(paths.dynamicDir(), { recursive: true });
  if (passthrough !== '') {
    await atomicWrite(paths.routePath(name), passthroughRouteYml(name, host, passthrough));
    return false;
  }
  const door = current();
  const covered = door !== null && covers(door, host);
  await atomicWrite(
    paths.routePath(name),
    await workspaceRouteYml(name, host, {
      instances,
      local,
      grafana,
      wildcardBase: covered ? (door as Edge).domain : '',
    }),
  );
  await attach(name);
  return !covered;
}

/**
 * Remove a workspace's route. Removing the file 404s that host and leaves every other
 * route untouched -- verified.
 */
export function deregister(name: string): void {
  fs.rmSync(paths.routePath(name), { force: true });
}

/**
 * The hostname `name`'s route claims, or ''.
 *
 * Read from the file rather than from the workspace record, for the same reason
 * `isPassthrough` is: a route outlives its workspace, and the caller that needs to know
 * about a collision is looking at routes.
 */
export function routeHost(name: string): string {
  try {
    const found = RULE_HOST.exec(fs.readFileSync(paths.routePath(name), 'utf8'));
    return found === null ? '' : (found[1] as string);
  } catch {
    return '';
  }
}

/**
 * Which OTHER workspace's route already claims `host`, or ''.
 *
 * NOTHING CHECKED THIS, and ports have been guarded since long before names were. A route
 * file is keyed by WORKSPACE NAME, so two workspaces given the same `--domain` each write
 * their own file claiming the same `Host()` -- and Traefik picks one. That is the failure
 * the design warns about in the same words: it "looks stable under testing and would
 * silently serve the wrong workspace forever".
 *
 * Found by running it: three route files on one box all claiming
 * `HostSNI(rc-rpro-test.kestron.org)` after a matrix of scenarios, two of them pointing at
 * NodePorts that no longer existed. Traefik chose a dead one, so the name returned EOF,
 * cert-manager's self check failed, and the certificate never issued -- for a chain that
 * was otherwise completely correct.
 *
 * `excluding` is the workspace being created or brought back, which is allowed to re-claim
 * its own name.
 */
export function hostOwner(host: string, { excluding = '' }: { excluding?: string } = {}): string {
  if (host === '') return '';
  for (const other of registered()) {
    if (other === excluding) continue;
    if (foldCase(routeHost(other)) === foldCase(host)) return other;
  }
  return '';
}

/**
 * EVERY route file claiming `host`, not just the first.
 *
 * `hostOwner` answers "is this name taken", which needs one name and stops. This answers
 * "what would I have to remove to free it", and the difference is not theoretical: the
 * collision that cost an hour of debugging was THREE route files on one host, two of them
 * pointing at NodePorts that no longer existed. A cleanup that removed one would have left
 * the name still broken and still claimed.
 */
export function routesFor(host: string): string[] {
  if (host === '') return [];
  return registered().filter((name) => foldCase(routeHost(name)) === foldCase(host));
}

/** Workspace names with a route right now (the GUI's own route excluded). */
export function registered(): string[] {
  let entries: string[];
  try {
    if (!fs.statSync(paths.dynamicDir()).isDirectory()) return [];
    entries = fs.readdirSync(paths.dynamicDir());
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.yml'))
    .map((entry) => path.basename(entry, '.yml'))
    .filter((stem) => !stem.startsWith('_'))
    .sort();
}

/**
 * Join every routed workspace's network. Returns the ones that failed.
 *
 * Attachments are RUNTIME state on the container, so recreating the edge -- an upgrade, a
 * `restart`, a reboot that pulls a new image -- loses every one of them while the route
 * files survive untouched. The result is a set of names that answer 502 rather than
 * erroring, so this runs after every start rather than waiting for someone to notice.
 */
export async function reattachAll(): Promise<string[]> {
  const failed: string[] = [];
  for (const name of registered()) {
    // A passthrough route has no network to join -- it names an address, not a container.
    // Attaching would run `docker network connect` for a compose project that does not
    // exist, fail, and report a perfectly healthy Kubernetes workspace as one the edge
    // could not reach, on every restart.
    if (isPassthrough(name)) continue;
    if (!(await attach(name))) failed.push(name);
  }
  return failed;
}
