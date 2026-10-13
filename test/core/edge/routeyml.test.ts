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

describe('a Kubernetes name on the edge', () => {
  it("hands cert-manager's http-01 challenge to the cluster's :80, ahead of the redirect", () => {
    // The edge redirected every :80 request to HTTPS, where the cluster has no solver, so a
    // `--domain` workspace on a local cluster never got its certificate. The challenge path
    // goes to the cluster's plain-HTTP side, and the redirect yields to it.
    const route = YAML.parse(
      passthroughRouteYml('kube', 'k.example.com', '172.16.0.2:32023', '172.16.0.2:31080'),
    ) as {
      http: {
        routers: Record<string, Router & { rule: string; service: string }>;
        services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
      };
    };
    const router = route.http.routers['kube-acme-http'];
    expect(router?.entryPoints).toEqual(['web']);
    expect(router?.rule).toBe(
      'Host(`k.example.com`) && PathPrefix(`/.well-known/acme-challenge/`)',
    );
    expect(route.http.services[router?.service ?? '']?.loadBalancer.servers).toEqual([
      { url: 'http://172.16.0.2:31080' },
    ]);
    const command = composeDoc(edge()).services.edge?.command as string[];
    expect(command).toContain('--entryPoints.web.http.redirections.entryPoint.priority=1');
  });
});

describe('Docker HTTP-01 beside a Kubernetes name', () => {
  it('passes the cluster challenge without stealing the edge resolver or Docker routes', async () => {
    const command = composeDoc(edge({ acmeEmail: 'ops@example.test', acmeChallenge: 'http' }))
      .services.edge?.command as string[];
    const cluster = YAML.parse(
      passthroughRouteYml('kube', 'k.example.com', '172.16.0.2:31443', '172.16.0.2:31080'),
    ) as {
      http: { routers: Record<string, Router & { rule: string; priority: number }> };
    };
    const docker = YAML.parse(await workspaceRouteYml('docker', 'd.example.com')) as {
      http: { routers: Record<string, Router & { tls: { certResolver: string } }> };
    };
    // Traefik v3.7's bypass keeps its HTTP solver, at ordinary rule priority. Our
    // cluster router is host-specific and higher; a Docker name cannot match it.
    expect(command).toContain('--entryPoints.web.allowACMEByPass=true');
    expect(command).toContain('--certificatesresolvers.le.acme.httpchallenge.entrypoint=web');
    expect(command).not.toContain('--entryPoints.websecure.allowACMEByPass=true');
    const challenge = cluster.http.routers['kube-acme-http'];
    expect(challenge?.rule).toBe(
      'Host(`k.example.com`) && PathPrefix(`/.well-known/acme-challenge/`)',
    );
    expect(challenge?.priority).toBeGreaterThan(
      'PathPrefix(`/.well-known/acme-challenge/`)'.length,
    );
    expect(docker.http.routers.docker?.entryPoints).toEqual(['websecure']);
    expect(docker.http.routers.docker?.tls.certResolver).toBe('le');
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
  it.each([false, true])(
    'Grafana public URL regression: adds the path router with shared TLS (local=%s)',
    async (local) => {
      const body = await workspaceRouteYml('w', 'h.example.com', {
        local,
        grafana: true,
        instances: 2,
      });
      const doc = YAML.parse(body) as {
        http: {
          routers: Record<string, { rule: string; tls: unknown; service: string }>;
          services: Record<
            string,
            { loadBalancer: { servers: { url: string }[]; sticky?: unknown } }
          >;
        };
      };
      expect(Object.keys(doc.http.routers)).toEqual(['w', 'w-grafana']);
      expect(doc.http.routers['w-grafana']).toMatchObject({
        rule: 'Host(`h.example.com`) && PathPrefix(`/grafana`)',
        service: 'w-grafana',
        tls: doc.http.routers.w?.tls,
      });
      expect(doc.http.services['w-grafana']?.loadBalancer.servers).toEqual([
        { url: 'http://houston-w-grafana-1:3000' },
      ]);
      expect(doc.http.services['w-grafana']?.loadBalancer).not.toHaveProperty('sticky');
      expect(doc.http.services.w?.loadBalancer).toHaveProperty('sticky');
      expect(
        Object.keys(
          (YAML.parse(await workspaceRouteYml('w', 'h.example.com')) as typeof doc).http.routers,
        ),
      ).toEqual(['w']);
    },
  );
  it('parses as YAML whose router serves the workspace’s own service', async () => {
    // Traefik skips a file it cannot parse and says so only in its own log, so the name
    // simply never answers.
    const doc = YAML.parse(await workspaceRouteYml('w', 'h.example.com')) as {
      http: { routers: Record<string, { service: string }> };
    };
    expect(doc.http.routers.w?.service).toBe('w');
  });
});

describe("a workspace's preset UIs", () => {
  it('get a path router each on the same name and certificate, to their own container', async () => {
    const body = await workspaceRouteYml('w', 'h.example.com', {
      paths: [
        {
          preset: 'email',
          path: '/mailpit',
          service: 'mailpit',
          container_port: 8025,
          service_port: 8025,
        },
        {
          preset: 'keycloak',
          path: '/keycloak',
          service: 'keycloak',
          container_port: 8080,
          service_port: 8081,
        },
      ],
    });
    const doc = YAML.parse(body) as {
      http: {
        routers: Record<string, { rule: string; tls: unknown; service: string }>;
        services: Record<
          string,
          { loadBalancer: { servers: { url: string }[]; sticky?: unknown } }
        >;
      };
    };
    expect(Object.keys(doc.http.routers)).toEqual(['w', 'w-mailpit', 'w-keycloak']);
    expect(doc.http.routers['w-keycloak']).toMatchObject({
      rule: 'Host(`h.example.com`) && PathPrefix(`/keycloak`)',
      service: 'w-keycloak',
      tls: doc.http.routers.w?.tls,
    });
    expect(doc.http.services['w-mailpit']?.loadBalancer).toEqual({
      servers: [{ url: 'http://houston-w-mailpit-1:8025' }],
    });
    expect(doc.http.services['w-keycloak']?.loadBalancer.servers).toEqual([
      { url: 'http://houston-w-keycloak-1:8080' },
    ]);
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
