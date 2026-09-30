/**
 * The Docker networks the edge joins. Tier 2 of `src/core/edge/`.
 */
import { projectName } from '../runner/record';

import { dockerRun } from './engine';
import { CONTAINER } from './paths';

/** The network compose creates for a workspace: `<project>_default`. */
export async function workspaceNetwork(name: string): Promise<string> {
  return `${await projectName(name)}_default`;
}

/**
 * The container compose creates for one of a workspace's services.
 *
 * A CONTAINER name, not a service alias, and that distinction is the whole reason routes
 * work. The edge is attached to many workspace networks, each containing a service called
 * `rocketchat`; asking for `rocketchat` from there resolved 6/6 to one particular
 * workspace. Container names are unique across every network, so they cannot be confused.
 */
export async function backendContainer(name: string, service: string): Promise<string> {
  return `${await projectName(name)}-${service}-1`;
}

/**
 * Every IP the edge container currently holds, one per network it has joined.
 *
 * This is what `serve --domain` trusts for X-Forwarded-*, and it has to be the EXACT set
 * rather than a subnet: the edge reaches the host from an address on a workspace network,
 * and that /16 also contains the customer-image Rocket.Chat containers. A CIDR here would
 * hand X-Forwarded-For to every workspace.
 *
 * Re-read rather than cached: the set changes as the edge joins networks.
 */
export async function containerAddresses(): Promise<string[]> {
  const out = await dockerRun([
    'inspect',
    CONTAINER,
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
  ]);
  if (out.returncode !== 0) return [];
  return out.stdout.split(/\s+/u).filter((address) => address !== '');
}

/** Workspace networks the edge is currently joined to. */
export async function attachedNetworks(): Promise<Set<string>> {
  const out = await dockerRun([
    'inspect',
    CONTAINER,
    '--format',
    '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}\n{{end}}',
  ]);
  if (out.returncode !== 0) return new Set();
  return new Set(
    out.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
}

/**
 * Join the edge to `name`'s own network, live. Idempotent.
 *
 * This is what replaces recreating the workspace. `docker network connect` acts on a
 * RUNNING container -- verified: reachable immediately afterwards, with the target's
 * StartedAt unchanged. Nothing stops, nothing is rebuilt, no volume is touched, so doing
 * this to twenty workspaces costs twenty seconds rather than twenty rebuilds.
 *
 * Joining the EDGE to the workspace's network (rather than the workspace to a shared one)
 * is what preserves isolation: each workspace keeps the private network compose already
 * gave it, and verified that w1 could reach w2 neither by name nor by IP with the edge
 * attached to both.
 */
export async function attach(name: string): Promise<boolean> {
  const net = await workspaceNetwork(name);
  if ((await attachedNetworks()).has(net)) return true;
  // A workspace that has never been `up`ed has no network yet; not an error, the attach
  // simply happens after it is created.
  return (await dockerRun(['network', 'connect', net, CONTAINER])).returncode === 0;
}

/**
 * Join the edge to a Docker network BY NAME. Idempotent.
 *
 * `attach` joins a network derived from a WORKSPACE name, which is every network the edge
 * has ever needed -- until a cluster turned out to be one too. A kind cluster's node is a
 * container on kind's own Docker network, so its NodePort is reachable from the host and
 * NOT from a container on the default bridge, which is where the edge lives. Measured
 * exactly that way: `172.18.0.2:30925` answered from the host and from a container on the
 * `kind` network, and was unreachable from one on `bridge`.
 *
 * Kept separate from `attach` rather than generalising it: that function's whole contract
 * is "the network compose made for this workspace", and its name is what makes the
 * container-name routing rule readable.
 */
export async function attachNetwork(net: string): Promise<boolean> {
  if (net === '' || (await attachedNetworks()).has(net)) return true;
  return (await dockerRun(['network', 'connect', net, CONTAINER])).returncode === 0;
}

/**
 * The first Docker network `container` is on, or ''.
 *
 * Used to find out where a cluster's node lives, so the edge can join it. Read rather than
 * assumed: kind's default network is called `kind`, but a cluster created with a different
 * config need not be on it.
 */
export async function containerNetwork(container: string): Promise<string> {
  const out = await dockerRun([
    'inspect',
    container,
    '--format',
    '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}',
  ]);
  if (out.returncode !== 0) return '';
  const names = out.stdout.split(/\s+/u).filter((entry) => entry !== '');
  return names[0] ?? '';
}

/** Leave `name`'s network. Best-effort -- the network may already be gone. */
export async function detach(name: string): Promise<void> {
  await dockerRun(['network', 'disconnect', '-f', await workspaceNetwork(name), CONTAINER]);
}
