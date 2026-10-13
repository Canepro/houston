/**
 * Where the edge's files live, and the two shapes read back out of them.
 *
 * Tier 0 of `src/core/edge/`. The package keeps its established tiering, which cannot
 * import upward:
 *
 *     paths, types -> engine -> acme, networks -> routeyml -> spec -> routes -> runtime
 */

import * as config from '../../lib/config';
import { joinPath } from '../../lib/home';
import { reproLock } from '../runner/locks';

/** `<home>/edge` -- deliberately a sibling of `repros/`, never inside it. */
export const EDGE_DIR = 'edge';

/** Traefik watches this for one routing file per registered name. */
export const DYNAMIC_DIR = 'dynamic';

/** The Edge spec as written, so a later process can rebuild it exactly. */
export const SPEC_FILE = 'spec.json';

/**
 * The compose project name. The underscore is load-bearing: `sanitize()` maps every
 * non `[a-z0-9-]` character to "-", so no repro can ever be named `houston_edge`, and the
 * edge's project therefore cannot collide with a repro literally named "edge" -- which
 * WOULD collide under `PROJECT_PREFIX + name`, and would let `down` on that repro tear
 * down the box's only ingress.
 */
export const PROJECT = 'houston_edge';

/** The edge's own container, as compose names it: `<project>-<service>-<index>`. */
export const CONTAINER = `${PROJECT}-edge-1`;

/**
 * Serialise shared edge mutations across workspace jobs and CLI processes.
 *
 * The reserved project name cannot be a sanitised workspace name. Take this after a
 * workspace lock; nested prepare/write/up/down calls reuse the seam's reentrant lock.
 */
export async function edgeLock<T>(body: () => T | Promise<T>): Promise<T> {
  return await reproLock(PROJECT, body);
}

export function edgeDir(): string {
  return joinPath(config.home(), EDGE_DIR);
}

export function dynamicDir(): string {
  return joinPath(edgeDir(), DYNAMIC_DIR);
}

export function composePath(): string {
  return joinPath(edgeDir(), 'compose.yml');
}

export function routePath(name: string): string {
  return joinPath(dynamicDir(), `${name}.yml`);
}

export function certsDir(): string {
  return joinPath(edgeDir(), 'certs');
}

/**
 * `<address>:<port>`, the only shape a Traefik TCP server takes.
 *
 * Checked rather than trusted: a bare address here loads as a router with no reachable
 * server, so the name answers nothing and Traefik says so only in its own log.
 */
export const ADDR_RE = /^[A-Za-z0-9._[\]:-]+:\d{1,5}$/u;

/**
 * The host a generated route matches, whichever kind it is. `Host()` for an HTTP router,
 * `HostSNI()` for a TCP passthrough.
 */
export const RULE_HOST = /Host(?:SNI)?\(`([^`]+)`\)/u;

/** Where a unit file goes. Printed, never written -- see `systemdUnit`. */
export const UNIT_PATH = '/etc/systemd/system/houston.service';
