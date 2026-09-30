/**
 * `core/edge/routeyml.ts`: the routing files Traefik watches.
 *
 * The claims `edge.test.ts` does not already make. Pure -- nothing here reads Docker.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';

import { backendContainer } from '../../../src/core/edge/networks';
import {
  guiRouteYml,
  passthroughRouteYml,
  workspaceRouteYml,
} from '../../../src/core/edge/routeyml';
import { composeDoc } from '../../../src/core/edge/spec';
import { edge } from '../../../src/core/edge/types';

interface Router {
  entryPoints: string[];
}

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-routeyml-'));
  process.env.HOUSTON_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the two kinds of route', () => {
  it('share ONE entrypoint, which is what lets Compose and Kubernetes coexist', async () => {
    // Traefik matches TCP routers by SNI first and falls through to HTTP routers for
    // anything unmatched. Measured with one Traefik and two names: the terminating name
    // got the edge's own leaf and the passthrough name the cluster's Secret. If these ever
    // named different entrypoints that would be gone and nothing would fail loudly.
    const terminating = YAML.parse(await workspaceRouteYml('compose', 'c.example.com')) as {
      http: { routers: Record<string, Router> };
    };
    const passing = YAML.parse(passthroughRouteYml('kube', 'k.example.com', '172.16.0.2:443')) as {
      tcp: { routers: Record<string, Router> };
    };
    expect(terminating.http.routers.compose?.entryPoints).toEqual(['websecure']);
    expect(passing.tcp.routers.kube?.entryPoints).toEqual(['websecure']);
  });
});

describe('a workspace backend', () => {
  it('differs between two workspaces, so one name cannot serve the other', async () => {
    // Both workspaces call their service `rocketchat`; only the container name tells them
    // apart from an edge attached to both networks.
    expect(await backendContainer('alice-rc8-5-1', 'rocketchat')).not.toBe(
      await backendContainer('bob-rc8-5-1', 'rocketchat'),
    );
    const alice = await workspaceRouteYml('alice-rc8-5-1', 'a.example.com');
    const bob = await workspaceRouteYml('bob-rc8-5-1', 'b.example.com');
    expect(alice).not.toBe(bob);
    expect(alice).toContain('http://houston-alice-rc8-5-1-rocketchat-1:3000');
    expect(bob).toContain('http://houston-bob-rc8-5-1-rocketchat-1:3000');
  });
});

describe('a workspace route', () => {
  it('parses as YAML whose router serves the workspace’s own service', async () => {
    // Traefik skips a file it cannot parse and says so only in its own log, so the name
    // simply never answers.
    const doc = YAML.parse(await workspaceRouteYml('w', 'h.example.com')) as {
      http: { routers: Record<string, { service: string }> };
    };
    expect(doc.http.routers.w?.service).toBe('w');
  });
});

describe('the GUI route', () => {
  it('reaches the GUI, a host process, through host.docker.internal', () => {
    // The GUI is the Node server on the host, not a container, so it is on no network the
    // edge joins and has no name there: the edge needs the host-gateway alias AND the
    // route has to address it.
    const doc = composeDoc(edge()) as unknown as {
      services: { edge: { extra_hosts: string[] } };
    };
    expect(doc.services.edge.extra_hosts).toContain('host.docker.internal:host-gateway');
    expect(guiRouteYml(edge({ domain: 'd', guiPort: 7070 }))).toContain('host.docker.internal');
  });
});
