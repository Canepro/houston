/**
 * One Traefik edge for the whole box: TLS, routes, and the networks it joins.
 *
 * The cases that matter here are the ones where being wrong is silent. A route addresses
 * the CONTAINER name and never the service alias, because every workspace calls its service
 * `rocketchat` and from an edge attached to many networks the bare name resolves
 * deterministically to one of them -- which looks stable under testing and would serve the
 * wrong workspace forever. A second route claiming the same host is the same failure one
 * level up. And `running` is not `up`: a Traefik holding no ports was reported as a working
 * edge.
 *
 * Docker is replaced throughout. Nothing here starts a container.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';

import * as config from '../../../src/lib/config';
import { ConflictError, ValidationError } from '../../../src/lib/errors';
import { compose as composeSeam, docker as dockerSeam } from '../../../src/seams/docker-cli';
import { checkEdge } from '../../../src/core/doctor';
import { sanitize } from '../../../src/core/lifecycle/naming';
import { atomicWrite } from '../../../src/core/runner/paths';
import { write as writeRecord, metadata } from '../../../src/core/runner/record';
import { ACME_FILE, acmeDir } from '../../../src/core/tls';

import {
  acmeHosts,
  acmeNames,
  forgetAcme,
  hasAcme,
  orphanCerts,
} from '../../../src/core/edge/acme';
import {
  holdersOf443,
  ourContainer,
  portHolder,
  publishesPorts,
  running,
  why,
} from '../../../src/core/edge/engine';
import * as paths from '../../../src/core/edge/paths';
import { CONTAINER, PROJECT } from '../../../src/core/edge/paths';
import {
  guiRouteYml,
  passthroughRouteYml,
  workspaceRouteYml,
} from '../../../src/core/edge/routeyml';
import {
  deregister,
  hostOwner,
  isPassthrough,
  register,
  registered,
  routeHost,
  routesFor,
} from '../../../src/core/edge/routes';
import {
  composeDoc,
  current,
  installed,
  servedDomain,
  traefikCommand,
  write,
} from '../../../src/core/edge/spec';
import {
  asTlsSpec,
  covers,
  edge,
  resolveEdge,
  startResult,
  type Edge,
} from '../../../src/core/edge/types';
import { systemdUnit } from '../../../src/core/edge/runtime';

jest.mock('../../../src/seams/docker-cli', () => ({
  ...jest.requireActual('../../../src/seams/docker-cli'),
  docker: jest.fn(),
  compose: jest.fn(),
}));

const mocked = <T extends (...args: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

/**
 * What earlier releases wrote when they rebuilt the edge from each spec.json below, file by
 * file, with the home as `<home>`, recorded.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'core', 'edge', 'edge.json'),
    'utf8',
  ),
) as { rebuiltFromSpec: Record<string, Record<string, string>> };

/**
 * A scripted docker: argv fragments -> what it says.
 *
 * Matched against the JOINED argv rather than element by element, because half of these
 * calls identify themselves by a Go template -- `{{index .Config.Labels "..."}}` -- and an
 * exact-element test silently matches nothing, which reads as a docker that answered
 * emptily rather than as a rule that never fired. Found that way: two cases passed for the
 * wrong reason before this did substring matching.
 */
function scriptDocker(rules: [string[], string][], fallback = ''): void {
  const answer = (args: string[]) => {
    const joined = args.join(' ');
    const hit = rules.find(([needles]) => needles.every((needle) => joined.includes(needle)));
    return {
      argv: ['docker', ...args],
      exitCode: 0,
      signal: null,
      stdout: hit === undefined ? fallback : hit[1],
      stderr: '',
    };
  };
  mocked(dockerSeam).mockImplementation((args: string[]) => Promise.resolve(answer(args)));
  // `compose` is mocked too, so a case that reaches one never runs a real container.
  mocked(composeSeam).mockImplementation((args: string[]) =>
    Promise.resolve(answer(['compose', ...args])),
  );
}

describe('a route addresses the container, never the service alias', () => {
  it('names `<project>-<service>-1`, which is unique across every network', async () => {
    // The edge is attached to many workspace networks, each containing a service called
    // `rocketchat`; asking for `rocketchat` from there resolved 6/6 to one particular
    // workspace. Container names cannot be confused that way.
    const yml = await workspaceRouteYml('t1', 'rc.example.test');
    const doc = YAML.parse(yml) as {
      http: { services: Record<string, { loadBalancer: { servers: { url: string }[] } }> };
    };
    const servers = doc.http.services.t1?.loadBalancer.servers ?? [];
    expect(servers.map((server) => server.url)).toEqual(['http://houston-t1-rocketchat-1:3000']);
    // NOT the alias every workspace shares.
    expect(yml).not.toContain('http://rocketchat:');
  });

  it('lists one backend per instance, and makes the session sticky', async () => {
    // DDP websockets must not be bounced between instances mid-session.
    const yml = await workspaceRouteYml('t1', 'rc.example.test', { instances: 3 });
    const doc = YAML.parse(yml) as {
      http: {
        services: Record<
          string,
          { loadBalancer: { servers: { url: string }[]; sticky?: { cookie: { name: string } } } }
        >;
      };
    };
    const service = doc.http.services.t1;
    expect(service?.loadBalancer.servers).toHaveLength(3);
    expect(service?.loadBalancer.sticky?.cookie.name).toBe('rc_lb');
  });

  it('matches the host, because Traefik derives WHAT to request from the rule', async () => {
    const yml = await workspaceRouteYml('t1', 'rc.example.test');
    expect(yml).toContain('rule: "Host(`rc.example.test`)"');
    expect(yml).toContain('certResolver: le');
  });

  it('names NO resolver for a local certificate, which is loaded from disk', async () => {
    // Naming one would make Traefik request a certificate from Let's Encrypt for a
    // .localhost name that can never be validated.
    const yml = await workspaceRouteYml('t1', 't1.houston.localhost', { local: true });
    expect(yml).toContain('tls: {}');
    expect(yml).not.toContain('certResolver');
  });

  it('asks for the WILDCARD when one covers the host, so it costs no certificate', async () => {
    const yml = await workspaceRouteYml('t1', 't1.support.test', {
      wildcardBase: 'support.test',
    });
    expect(yml).toContain('- main: "*.support.test"');
  });

  it('asks for the apex AND the wildcard on the GUI’s own router', () => {
    // The apex is not matched by its own wildcard, so the router that requests it has to
    // ask for both or the GUI's own name is uncovered.
    const yml = guiRouteYml(edge({ domain: 'support.test', wildcard: true }));
    expect(yml).toContain('- main: "support.test"');
    expect(yml).toContain('sans: ["*.support.test"]');
    // And the GUI is a HOST process, reached through host.docker.internal.
    expect(yml).toContain('http://host.docker.internal:7070');
  });
});

describe('a passthrough route', () => {
  it('matches by SNI and forwards raw TCP, presenting no certificate at all', () => {
    // A Kubernetes workspace's certificate lives in a cluster Secret and its Ingress is
    // what terminates TLS -- so if the edge terminated instead, the `tls:` block, the
    // Secret and cert-manager would never run, and those are exactly where a customer's
    // certificate bugs live.
    const yml = passthroughRouteYml('t1', 'rc.example.test', '172.18.0.2:30925');
    const doc = YAML.parse(yml) as {
      tcp: {
        routers: Record<string, { rule: string; tls: { passthrough: boolean } }>;
        services: Record<string, { loadBalancer: { servers: { address: string }[] } }>;
      };
    };
    expect(doc.tcp.routers.t1?.rule).toBe('HostSNI(`rc.example.test`)');
    expect(doc.tcp.routers.t1?.tls.passthrough).toBe(true);
    expect(doc.tcp.services.t1?.loadBalancer.servers[0]?.address).toBe('172.18.0.2:30925');
    // No HTTP router at the edge for this name, and no certificate declaration either.
    expect('http' in doc).toBe(false);
    expect('tls' in doc).toBe(false);
    // Naming a resolver would make the edge request a certificate for a name it is not
    // serving.
    expect(yml).not.toContain('certResolver');
  });

  it('REFUSES a bare address, which would load a router with no reachable server', () => {
    // Traefik would then answer nothing for the name, with the reason only in its own log.
    expect(() => passthroughRouteYml('t1', 'rc.example.test', '172.18.0.2')).toThrow(
      ValidationError,
    );
    expect(() => passthroughRouteYml('t1', 'rc.example.test', '')).toThrow(/address>:<port/u);
    // A bracketed IPv6 with a port is a legal address and must pass.
    expect(() => passthroughRouteYml('t1', 'h', '[::1]:30925')).not.toThrow();
  });
});

describe('which workspace owns a name', () => {
  beforeEach(async () => {
    fs.mkdirSync(paths.dynamicDir(), { recursive: true });
    for (const entry of fs.readdirSync(paths.dynamicDir())) {
      fs.rmSync(path.join(paths.dynamicDir(), entry), { force: true });
    }
  });

  it('finds a collision, because nothing checked this and Traefik just picks one', async () => {
    // Found by running it: three route files on one box all claiming the same HostSNI,
    // two of them pointing at NodePorts that no longer existed. Traefik chose a dead one,
    // so the name returned EOF and the certificate never issued.
    await atomicWrite(paths.routePath('a'), passthroughRouteYml('a', 'rc.test', '10.0.0.1:1'));
    await atomicWrite(paths.routePath('b'), passthroughRouteYml('b', 'rc.test', '10.0.0.2:2'));
    await atomicWrite(paths.routePath('c'), passthroughRouteYml('c', 'other.test', '10.0.0.3:3'));
    expect(routeHost('a')).toBe('rc.test');
    expect(hostOwner('rc.test')).toBe('a');
    // The workspace re-claiming its own name is allowed.
    expect(hostOwner('rc.test', { excluding: 'a' })).toBe('b');
    expect(hostOwner('free.test')).toBe('');
    // EVERY claimant, because removing one would leave the name still broken and claimed.
    expect(routesFor('rc.test')).toEqual(['a', 'b']);
    // An HTTP route's `Host()` is a claim too: both kinds share one entrypoint.
    await atomicWrite(paths.routePath('h'), await workspaceRouteYml('h', 'web.test'));
    expect(routeHost('h')).toBe('web.test');
    expect(hostOwner('WEB.test')).toBe('h');
    expect(hostOwner('web.test', { excluding: 'h' })).toBe('');
  });

  it('matches a host case-insensitively, as DNS does', async () => {
    await atomicWrite(paths.routePath('a'), passthroughRouteYml('a', 'RC.Test', '10.0.0.1:1'));
    expect(hostOwner('rc.test')).toBe('a');
  });

  it('excludes the GUI’s own route from the workspace list', async () => {
    await atomicWrite(paths.routePath('_gui'), guiRouteYml(edge({ domain: 'x.test' })));
    await atomicWrite(paths.routePath('t1'), await workspaceRouteYml('t1', 'rc.test'));
    expect(registered()).toEqual(['t1']);
  });

  it('reads passthrough off the FILE, because a route outlives its workspace', async () => {
    await atomicWrite(paths.routePath('k'), passthroughRouteYml('k', 'rc.test', '10.0.0.1:1'));
    await atomicWrite(paths.routePath('d'), await workspaceRouteYml('d', 'rc2.test'));
    expect(isPassthrough('k')).toBe(true);
    expect(isPassthrough('d')).toBe(false);
    // False for anything unreadable: the only consequence is an attach that was not
    // needed, which is a no-op.
    expect(isPassthrough('never-existed')).toBe(false);
  });

  it('404s one name and leaves every other route untouched', async () => {
    await atomicWrite(paths.routePath('a'), await workspaceRouteYml('a', 'a.test'));
    await atomicWrite(paths.routePath('b'), await workspaceRouteYml('b', 'b.test'));
    deregister('a');
    expect(registered()).toEqual(['b']);
    // Removing one that is not there is a no-op, not a failure.
    expect(() => deregister('never-existed')).not.toThrow();
  });
});

describe('the wildcard', () => {
  it('covers exactly one label below the domain, and no more', () => {
    // A TLS wildcard matches ONE label, so `a.b.support.test` is not covered even though a
    // DNS wildcard would resolve it -- the two match differently and conflating them means
    // serving the wrong certificate.
    const door = edge({ domain: 'support.test', wildcard: true });
    expect(covers(door, 't1.support.test')).toBe(true);
    expect(covers(door, 'a.b.support.test')).toBe(false);
    expect(covers(door, 'support.test')).toBe(false);
    expect(covers(door, 'elsewhere.test')).toBe(false);
    // And nothing is covered when there is no wildcard at all.
    expect(covers(edge({ domain: 'support.test' }), 't1.support.test')).toBe(false);
  });
});

describe('the edge’s own compose document', () => {
  it('mounts no Docker socket, which is the whole point of a file provider', () => {
    const doc = composeDoc(edge()) as unknown as {
      services: { edge: { volumes: string[]; networks?: unknown } };
    };
    expect(doc.services.edge.volumes.join(' ')).not.toContain('docker.sock');
  });

  it('declares NO network of its own, or compose refuses the project', () => {
    // It joins each workspace's own network at runtime; declaring a shared one is exactly
    // what would have put every workspace on the same network and let them reach each
    // other.
    const doc = composeDoc(edge()) as unknown as {
      services: { edge: Record<string, unknown> };
    };
    // On the SERVICE as well as the document: removing only the top-level block left the
    // service still naming it, and compose refused the whole project.
    expect('networks' in doc).toBe(false);
    expect('networks' in doc.services.edge).toBe(false);
    expect(doc.services.edge.extra_hosts).toEqual(['host.docker.internal:host-gateway']);
  });

  it('mounts the local certificate directory, or Traefik serves its own default', () => {
    // Without this mount the declaration `issueLocalCert` writes points at a path that does
    // not exist inside the container, and Traefik quietly serves its own certificate
    // instead -- which looks exactly like a working setup until you read the issuer.
    const doc = composeDoc(edge()) as unknown as { services: { edge: { volumes: string[] } } };
    expect(doc.services.edge.volumes).toContain('./certs:/etc/traefik/certs:ro');
    expect(doc.services.edge.volumes).toContain('./dynamic:/etc/traefik/dynamic:ro');
  });

  it('mounts the dns credentials ONLY for the dns challenge', () => {
    const withDns = composeDoc(edge({ acmeChallenge: 'dns' })) as unknown as {
      services: { edge: Record<string, unknown> };
    };
    expect(withDns.services.edge.env_file).toEqual([path.join(acmeDir(), 'dns.env')]);
    const without = composeDoc(edge()) as unknown as {
      services: { edge: Record<string, unknown> };
    };
    expect('env_file' in without.services.edge).toBe(false);
  });

  it('maps host ports onto container ports that never move', () => {
    const doc = composeDoc(edge({ httpPort: 8080, httpsPort: 8443 })) as unknown as {
      services: { edge: { ports: string[] } };
    };
    expect(doc.services.edge.ports).toEqual(['8080:80', '8443:443']);
    // The entrypoints inside the container are always 80/443.
    expect(traefikCommand(edge({ httpPort: 8080 }))).toContain(
      '--entryPoints.websecure.address=:443',
    );
  });

  it('declares a resolver only with an email, or Traefik fails at startup', () => {
    // Without one the edge still serves every LOCAL-CA name perfectly well -- which is
    // what lets `up --https` start it with no configuration at all, on a box that has no
    // public domain and never will.
    expect(traefikCommand(edge()).join(' ')).not.toContain('certificatesresolvers');
    expect(traefikCommand(edge({ acmeEmail: 'a@b' })).join(' ')).toContain(
      'certificatesresolvers.le.acme.email=a@b',
    );
  });

  it('drops the :80 redirect under http-01, or the challenge is redirected away', () => {
    // An entryPoint redirection is a middleware applied to every router on it -- measured:
    // an explicit router for `/.well-known/acme-challenge/` on `web` still answered 301.
    const normal = traefikCommand(edge({ acmeEmail: 'a@b' })).join(' ');
    expect(normal).toContain('redirections.entryPoint.to=websecure');
    const httpChallenge = traefikCommand(edge({ acmeEmail: 'a@b', acmeChallenge: 'http' })).join(
      ' ',
    );
    expect(httpChallenge).not.toContain('redirections.entryPoint');
  });

  it('logs at INFO, because an empty log reads as "no problem"', () => {
    // At ERROR a Traefik that is healthy but has not yet obtained a certificate logs
    // NOTHING, and that is exactly the state people get stuck in. Measured on two boxes on
    // the same day: the one with a real DNS failure had nine ERR lines and the one
    // mid-issuance had none at all.
    expect(traefikCommand(edge())).toContain('--log.level=INFO');
    // Before the file provider, so a provider that cannot start says so -- and on an edge
    // resolved from config, which is the one `serve --domain` builds.
    const resolved = traefikCommand(resolveEdge('g.example.test', 'a@b.test'));
    expect(resolved.indexOf('--log.level=INFO')).toBeGreaterThanOrEqual(0);
    expect(resolved.indexOf('--log.level=INFO')).toBeLessThan(
      resolved.findIndex((flag) => flag.includes('providers.file')),
    );
  });

  it('refers only to networks it declares, or compose refuses the project', () => {
    // The project-level defect the old live-Docker test caught, checked without making the
    // result depend on whether Docker happens to be installed.
    const doc = composeDoc(
      edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }),
    ) as unknown as {
      networks?: Record<string, unknown>;
      services: Record<string, { networks?: Record<string, unknown> | string[] }>;
    };
    const declared = new Set(Object.keys(doc.networks ?? {}));
    for (const service of Object.values(doc.services)) {
      const refs = service.networks ?? [];
      for (const ref of Array.isArray(refs) ? refs : Object.keys(refs)) {
        expect(declared.has(ref)).toBe(true);
      }
    }
    expect(Object.keys(doc.services)).toEqual(['edge']);
  });

  it('is a document the compose writer accepts', () => {
    const doc = composeDoc(edge({ domain: 'x.test', acmeEmail: 'a@b' }));
    expect(() => YAML.parse(YAML.stringify(doc))).not.toThrow();
  });
});

describe('what the edge remembers about itself', () => {
  it('writes the WHOLE spec, so a later start can rebuild it faithfully', async () => {
    // `current()` could only reconstruct the domain and the wildcard flag -- it silently
    // dropped the email, the GUI host and the GUI port, so nothing but `serve --domain`
    // could rebuild this edge. That is why `houston edge start` could not apply a changed
    // `acme.challenge`.
    const door = edge({
      domain: 'support.test',
      acmeEmail: 'ops@example.com',
      guiPort: 9944,
      acmeChallenge: 'dns',
      wildcard: true,
    });
    await write(door);
    expect(installed()).toBe(true);
    expect(servedDomain()).toBe('support.test');
    const back = current();
    expect(back).toEqual(door);
  });

  it('writes spec.json under the key names earlier releases read', async () => {
    // EARLIER RELEASES READ THIS FILE TOO. They spell these `acme_email`/`gui_host`;
    // serialising the camelCase interface straight out produced a file earlier releases
    // cannot read -- and `migrate`, whose entire job is adopting a home an earlier release
    // wrote, then rejected every spec it was ever handed and left the edge pointing at an
    // ACME directory the move had just deleted.
    const door = edge({
      domain: 'support.test',
      acmeEmail: 'ops@example.com',
      acmeStaging: true,
      acmeChallenge: 'dns',
      acmeDnsProvider: 'route53',
      guiHost: '0.0.0.0',
      guiPort: 9944,
      httpPort: 8080,
      httpsPort: 8443,
      wildcard: true,
    });
    await write(door);
    const raw = fs.readFileSync(path.join(paths.edgeDir(), 'spec.json'), 'utf8');
    // Key ORDER too: earlier releases write the fields in their declaration order, and a
    // file whose keys are shuffled is a needless diff in every home either release touches.
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>)).toEqual([
      'domain',
      'acme_email',
      'acme_staging',
      'acme_challenge',
      'acme_dns_provider',
      'gui_host',
      'gui_port',
      'http_port',
      'https_port',
      'wildcard',
    ]);
    // And what earlier releases read back out of that file, recorded, agrees field for field
    // with what we think we wrote.
    const recorded = {
      domain: 'support.test',
      acme_email: 'ops@example.com',
      acme_staging: true,
      acme_challenge: 'dns',
      acme_dns_provider: 'route53',
      gui_host: '0.0.0.0',
      gui_port: 9944,
      http_port: 8080,
      https_port: 8443,
      wildcard: true,
    };
    expect(recorded).toEqual(JSON.parse(raw));
    // ...and it still round-trips back into the same object on this side.
    expect(current()).toEqual(door);
  });

  it('writes a GUI route ONLY with a domain, because Host(``) is rejected at load', async () => {
    // Traefik rejects it with "empty args for matcher Host", and then names a certResolver
    // a bare edge does not declare either. Two errors on every start, for a route that
    // cannot work.
    await write(edge({ domain: 'support.test' }));
    expect(fs.existsSync(paths.routePath('_gui'))).toBe(true);
    await write(edge());
    expect(fs.existsSync(paths.routePath('_gui'))).toBe(false);
  });

  it('answers null before anything is installed', async () => {
    fs.rmSync(paths.composePath(), { force: true });
    expect(installed()).toBe(false);
    expect(current()).toBeNull();
  });

  it('falls back to the domain file for an edge written before specs existed', async () => {
    await write(edge({ domain: 'legacy.test' }));
    fs.rmSync(path.join(paths.edgeDir(), 'spec.json'), { force: true });
    expect(current()?.domain).toBe('legacy.test');
  });

  it('reports whether the running configuration declares a resolver', async () => {
    await write(edge());
    expect(hasAcme()).toBe(false);
    await write(edge({ acmeEmail: 'a@b' }));
    expect(hasAcme()).toBe(true);
  });
});

describe('an edge rebuilt from a spec.json holding values earlier releases wrote', () => {
  // `edge start` rebuilds the edge from the recorded spec: `current()`, then `write()` of the
  // edge resolved from its domain, email, GUI host and ports. Earlier releases read the spec
  // and use each value as read, so a port written 8080.0 is `8080.0:80` in the compose ports
  // and `:7071.0` in the GUI route, an email of false or null declares no resolver, and the
  // rewrite spells the file as they spell JSON: `caf\u00e9.example`, floats kept. This
  // coerced the ports to integers, declared a resolver for the email `false`, and wrote the
  // domain raw.
  const BASE = {
    domain: 'gui.example.test',
    acme_email: 'ops@example.test',
    acme_staging: false,
    acme_challenge: 'tlsalpn',
    acme_dns_provider: '',
    gui_host: '172.17.0.1',
    gui_port: 7070,
    http_port: 80,
    https_port: 443,
    wildcard: false,
  };
  const CASES: [string, string][] = [
    [
      'float ports, a false email and a non-ASCII domain',
      JSON.stringify({ ...BASE, acme_email: false, domain: 'café.example' })
        .replace('"gui_port":7070', '"gui_port":7071.0')
        .replace('"http_port":80', '"http_port":8080.0')
        .replace('"https_port":443', '"https_port":8443.0'),
    ],
    [
      'a null email and a string port',
      JSON.stringify({ ...BASE, acme_email: null, http_port: '8080', extra_key: 1 }),
    ],
    [
      'an exponent port and an empty email',
      JSON.stringify({ ...BASE, acme_email: '' }).replace(
        '"https_port":443',
        '"https_port":8.443e3',
      ),
    ],
    ['an IDN typed raw, with an email', JSON.stringify({ ...BASE, domain: 'bücher.example' })],
  ];
  const FILES = ['compose.yml', 'spec.json', 'domain', path.join('dynamic', '_gui.yml')];

  /** What the rebuild leaves in `<home>/edge/`, file by file. */
  function edgeFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of FILES) {
      const file = path.join(paths.edgeDir(), name);
      out[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<absent>';
    }
    return out;
  }

  function lay(spec: string): void {
    fs.rmSync(paths.edgeDir(), { recursive: true, force: true });
    fs.mkdirSync(paths.edgeDir(), { recursive: true });
    fs.writeFileSync(paths.composePath(), 'services: {}\n');
    fs.writeFileSync(path.join(paths.edgeDir(), 'spec.json'), spec);
  }

  it.each(CASES)('%s: the files earlier releases write', async (label, spec) => {
    const recorded = Object.fromEntries(
      Object.entries(RECORDED.rebuiltFromSpec[label] ?? {}).map(([name, text]) => [
        name,
        text.replaceAll('<home>', config.home()),
      ]),
    );
    expect(Object.keys(recorded)).toEqual(FILES);

    lay(spec);
    const door = current() as Edge;
    await write(
      resolveEdge(door.domain, door.acmeEmail, {
        guiHost: door.guiHost,
        guiPort: door.guiPort,
        httpPort: door.httpPort,
        httpsPort: door.httpsPort,
      }),
    );
    const generated = edgeFiles();
    // Keep the earlier-release fixture immutable: only the deliberate shared HTTP-01
    // coexistence flag differs. Every recorded value, port spelling and other byte stays.
    generated['compose.yml'] = (generated['compose.yml'] ?? '').replace(
      '    - --entryPoints.web.allowACMEByPass=true\n',
      '',
    );
    expect(generated).toEqual(recorded);
  });
});

describe('up is not the same as serving', () => {
  it('calls a container that holds no ports NOT running', async () => {
    // A container can start while another process owns its ports, and Docker then runs it
    // with the bindings simply absent. That is a Traefik answering on nothing -- and
    // `edge status` said "State running" over an edge serving not one name.
    scriptDocker([
      [['ps'], 'abc123\n'],
      [['inspect', 'com.docker.compose.project.working_dir'], `${paths.edgeDir()}\n`],
      [['inspect', '{{json .NetworkSettings.Ports}}'], '{"80/tcp":null,"443/tcp":null}'],
    ]);
    expect(await publishesPorts('abc123')).toBe(false);
    expect(await running()).toBe(false);
    // ...though the container really is up: the two questions are kept apart.
    expect(await ourContainer()).toBe('abc123');
  });

  it('reads the bindings as earlier releases read them: an EMPTY list holds nothing either', async () => {
    // Earlier releases require both 80/tcp and 443/tcp to hold a binding that is not empty:
    // `[]` is a port exposed with no binding. Only null counted as unbound here, so doctor
    // called this edge running where earlier releases call it NOT running.
    const answers: [string, boolean][] = [
      ['{"80/tcp":[],"443/tcp":[]}', false],
      ['{"80/tcp":[{"HostPort":"80"}],"443/tcp":[]}', false],
      ['{"80/tcp":[{"HostPort":"80"}],"443/tcp":{}}', false],
      ['{"80/tcp":[{"HostPort":"80"}],"443/tcp":""}', false],
      ['{"80/tcp":[{"HostPort":"80"}],"443/tcp":[{"HostPort":"443"}]}', true],
      ['null', false],
      ['', false],
    ];
    for (const [output, holds] of answers) {
      scriptDocker([[['inspect', '{{json .NetworkSettings.Ports}}'], output]]);
      expect([output, await publishesPorts('abc123')]).toEqual([output, holds]);
    }
  });

  it('names what holds :443 quoted as earlier releases quote it', async () => {
    // Earlier releases quote the container and the project the way they quote any string: a
    // project with an apostrophe is double-quoted there, where this always used single quotes.
    for (const [name, label, said] of [
      ['web', "it's-proj", "the container 'web' (compose project \"it's-proj\")"],
      ["o'brien", '', 'the container "o\'brien"'],
      ['web', 'plain', "the container 'web' (compose project 'plain')"],
    ] as const) {
      scriptDocker([
        [['ps', '{{.Names}}'], `${name}\t0.0.0.0:443->443/tcp\n`],
        [['inspect', 'com.docker.compose.project"'], `${label}\n`],
      ]);
      expect(await portHolder(443)).toBe(said);
    }
  });

  it('calls it running when it holds both ports', async () => {
    scriptDocker([
      [['ps'], 'abc123\n'],
      [['inspect', 'com.docker.compose.project.working_dir'], `${paths.edgeDir()}\n`],
      [
        ['inspect', '{{json .NetworkSettings.Ports}}'],
        '{"80/tcp":[{"HostPort":"80"}],"443/tcp":[{"HostPort":"443"}]}',
      ],
    ]);
    expect(await running()).toBe(true);
  });

  it('does not invent a failure from an inspect it could not make', async () => {
    mocked(dockerSeam).mockImplementation((args: string[]) =>
      Promise.resolve({
        argv: ['docker', ...args],
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'no such container',
      }),
    );
    expect(await publishesPorts('abc123')).toBe(true);
  });

  it('is HOME-AWARE, so another home’s container is not mistaken for ours', async () => {
    // Every HOUSTON_HOME uses the same compose project name, so a container started from a
    // different home matched and this returned true -- while `installed()` returned false,
    // the routes went into a directory nothing was watching, and every name 404'd.
    scriptDocker([
      [['ps'], 'abc123\n'],
      [['inspect', 'com.docker.compose.project.working_dir'], '/somebody/else/.houston/edge\n'],
    ]);
    expect(await running()).toBe(false);
  });
});

describe('which workspaces are in the way', () => {
  it('reads the RECORD, so it answers the same whether they are running or down', async () => {
    // They predate the edge, and they are why it cannot start: a machine has one port 443.
    await writeRecord(
      'legacy',
      'services: {}\n',
      metadata({ name: 'legacy', extra: { tls_ports: [443] } }),
    );
    await writeRecord(
      'moved',
      'services: {}\n',
      metadata({ name: 'moved', extra: { edge: true, tls_ports: [443] } }),
    );
    await writeRecord(
      'plain',
      'services: {}\n',
      metadata({ name: 'plain', extra: { tls_ports: [] } }),
    );
    expect(await holdersOf443()).toEqual(['legacy']);
  });
});

describe('the ACME store', () => {
  function storeWith(certs: unknown[]): void {
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(
      path.join(acmeDir(), ACME_FILE),
      JSON.stringify({ le: { Account: { Email: 'a@b' }, Certificates: certs } }),
      'utf8',
    );
  }

  it('reads every name a certificate is for, main and SANs', () => {
    storeWith([{ domain: { main: 'A.Test', sans: ['x.a.test'] } }]);
    expect(acmeHosts()).toEqual(['a.test', 'x.a.test']);
    expect(acmeNames({ domain: { main: 'Z' } })).toEqual(['z']);
    expect(acmeNames({})).toEqual([]);
  });

  it('drops a host’s certificate and KEEPS the account', async () => {
    // The account is a registration with Let's Encrypt, not a certificate -- dropping it
    // makes the next issuance register a new key pair for no benefit, and account
    // registrations have their own rate limit.
    storeWith([
      { domain: { main: 'a.test' }, key: 'PRIVATE' },
      { domain: { main: 'b.test' }, key: 'OTHER' },
    ]);
    expect(await forgetAcme('a.test')).toEqual([ACME_FILE]);
    const doc = JSON.parse(fs.readFileSync(path.join(acmeDir(), ACME_FILE), 'utf8')) as {
      le: { Account: unknown; Certificates: { domain: { main: string } }[] };
    };
    expect(doc.le.Certificates.map((cert) => cert.domain.main)).toEqual(['b.test']);
    expect(doc.le.Account).toEqual({ Email: 'a@b' });
  });

  it('reports the stores it actually touched, not the ones it looked at', async () => {
    storeWith([{ domain: { main: 'a.test' } }]);
    expect(await forgetAcme('never-issued.test')).toEqual([]);
    expect(await forgetAcme('')).toEqual([]);
  });

  it('treats an unwritten or corrupt store as "no certificate in here"', () => {
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.writeFileSync(path.join(acmeDir(), ACME_FILE), 'not json', 'utf8');
    expect(acmeHosts()).toEqual([]);
  });
});

describe('a declaration whose certificate never arrived', () => {
  it('is reported, because Traefik repeats that error for ever', async () => {
    // Each one is a name that will never serve, so it belongs in `status` rather than only
    // in a log nobody was told about.
    fs.mkdirSync(paths.dynamicDir(), { recursive: true });
    fs.mkdirSync(paths.certsDir(), { recursive: true });
    for (const entry of fs.readdirSync(paths.dynamicDir())) {
      fs.rmSync(path.join(paths.dynamicDir(), entry), { force: true });
    }
    await atomicWrite(path.join(paths.dynamicDir(), '_cert-good.test.yml'), 'tls: {}\n');
    await atomicWrite(path.join(paths.certsDir(), 'good.test.crt'), 'PEM\n');
    await atomicWrite(path.join(paths.dynamicDir(), '_cert-missing.test.yml'), 'tls: {}\n');
    await atomicWrite(path.join(paths.dynamicDir(), '_cert-empty.test.yml'), 'tls: {}\n');
    await atomicWrite(path.join(paths.certsDir(), 'empty.test.crt'), '');
    expect(orphanCerts()).toEqual(['empty.test', 'missing.test']);
  });
});

describe('the sentences a failure produces', () => {
  it('takes the LAST error line, because compose puts its diagnostics first', () => {
    const said = why({
      argv: [],
      returncode: 1,
      stdout: '',
      stderr:
        'time="..." level=warning msg="a warning"\n' +
        'Error response from daemon: Ports are not available: :443 is bound\n',
    });
    expect(said).toContain('Ports are not available');
  });

  it('says docker said nothing rather than returning an empty string', () => {
    expect(why({ argv: [], returncode: 1, stdout: '', stderr: '' })).toBe('docker said nothing');
  });

  it('falls back to the last line when nothing looks like an error', () => {
    expect(why({ argv: [], returncode: 1, stdout: 'first\nlast', stderr: '' })).toBe('last');
  });
});

describe('the rest of the surface', () => {
  it('prints a systemd unit rather than writing one', () => {
    // Writing it needs root, and a tool that edits /etc/systemd on your behalf is a bigger
    // thing to trust than one that shows you the file.
    const unit = systemdUnit('/usr/local/bin/houston serve', 'support');
    expect(unit).toContain('User=support');
    expect(unit).toContain('ExecStart=/usr/local/bin/houston serve');
    // `Restart=always` is only safe BECAUSE named accounts exist: with the old session
    // token every restart minted a new one and killed every bookmark.
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('carries the printing shell’s PATH and AWS profile into the unit', () => {
    // systemd's own PATH has no nvm node: the unit died with "node: not found" (127).
    const unit = systemdUnit('/opt/houston/bin/houston serve', 'support', {
      PATH: '/home/support/.nvm/versions/node/v24.10.0/bin:/usr/bin',
      AWS_PROFILE: 'support-eks-houston',
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-2',
      AWS_SECRET_ACCESS_KEY: 'never-copied',
    });
    expect(unit).toContain(
      '[Service]\nUser=support\n' +
        'Environment="PATH=/home/support/.nvm/versions/node/v24.10.0/bin:/usr/bin"\n' +
        'Environment="AWS_PROFILE=support-eks-houston"\n' +
        'Environment="AWS_REGION=us-east-1"\n' +
        'Environment="AWS_DEFAULT_REGION=us-east-2"\n' +
        'ExecStart=/opt/houston/bin/houston serve\n',
    );
    expect(unit).not.toContain('never-copied');
    // Unset or empty writes no line; quotes, backslashes and specifiers are escaped.
    expect(
      systemdUnit('/x serve', 'support', { PATH: '/a "b"\\c:100%', AWS_REGION: '' }),
    ).toContain('User=support\nEnvironment="PATH=/a \\"b\\"\\\\c:100%%"\nExecStart=/x serve\n');
    // Called as `--print-service` calls it, it reads this process's PATH.
    expect(systemdUnit('/x serve', 'support')).toContain(
      `Environment="PATH=${process.env.PATH ?? ''}"`,
    );
  });

  it('carries the home it was printed from, absolute', () => {
    // Printed from `HOUSTON_HOME=/srv/houston`, the unit served `User=`'s ~/.houston -- other
    // accounts, other workspaces -- because the variable was not carried; and systemd starts
    // it from `/`, so a relative home would name a different directory.
    const unit = systemdUnit('/x serve', 'support', { PATH: '/usr/bin', HOUSTON_HOME: 'homes/t1' });
    expect(unit).toContain(`Environment="HOUSTON_HOME=${path.resolve('homes/t1')}"\n`);
    expect(systemdUnit('/x serve', 'support', { PATH: '/usr/bin' })).not.toContain('HOUSTON_HOME');
  });

  it('carries the ACME flags into the edge’s own spec, from one place', () => {
    const spec = asTlsSpec(
      edge({ domain: 'x.test', acmeEmail: 'a@b', acmeStaging: true, httpsPort: 8443 }),
    );
    expect(spec.host).toBe('x.test');
    expect(spec.port).toBe(8443);
    expect(spec.acmeStaging).toBe(true);
  });

  it('is a compose project no repro can collide with', () => {
    // `sanitize()` maps every non `[a-z0-9-]` character to "-", so no repro can ever be
    // named `houston_edge` -- which WOULD collide under `PROJECT_PREFIX + name` and would
    // let `down` on that repro tear down the box's only ingress.
    expect(PROJECT).toBe('houston_edge');
    expect(CONTAINER).toBe('houston_edge-edge-1');
    expect(PROJECT).toContain('_');
    expect(PROJECT).not.toBe(`${config.PROJECT_PREFIX}edge`);
    expect(sanitize('edge_x')).not.toBe('edge_x'); // sanitize strips underscores
  });

  it('reads acme.staging with truthy, because "false" is a truthy string', () => {
    // The field existed, `tls` built the staging CA URL from it, and NOTHING wired it to
    // the edge -- so the switch was unreachable for the one component that requests
    // certificates.
    config.updateConfig((cfg) => {
      cfg.acme_staging = 'false';
    });
    expect(resolveEdge('x.test', 'a@b').acmeStaging).toBe(false);
    config.updateConfig((cfg) => {
      cfg.acme_staging = 'true';
    });
    expect(resolveEdge('x.test', 'a@b').acmeStaging).toBe(true);
    config.updateConfig((cfg) => {
      delete cfg.acme_staging;
    });
  });

  it('lets `config set acme.challenge` override the derivation', () => {
    // The derivation assumes one of the two automatic paths is available, and a real box
    // existed where neither was.
    config.updateConfig((cfg) => {
      cfg.acme_challenge = 'http';
    });
    expect(resolveEdge('x.test', 'a@b').acmeChallenge).toBe('http');
    config.updateConfig((cfg) => {
      cfg.acme_challenge = 'nonsense';
    });
    expect(resolveEdge('x.test', 'a@b').acmeChallenge).toBe('tlsalpn');
    config.updateConfig((cfg) => {
      delete cfg.acme_challenge;
    });
  });

  it('carries a reason on a failed start rather than only a flag', () => {
    // On a fresh EC2 box a bare false produced "error: the edge did not start." with
    // `docker ps -a` empty -- no container, no clue, and the actual compose error
    // discarded one frame below.
    expect(startResult(false, 'Ports are not available')).toEqual({
      ok: false,
      why: 'Ports are not available',
    });
    expect(startResult(true)).toEqual({ ok: true, why: '' });
  });

  it('refuses to start over another home’s edge rather than replacing it', async () => {
    // `compose up` would happily take the other home's container, and the first anyone
    // would know is every one of its names going dark.
    scriptDocker([
      [['ps'], 'abc123\n'],
      [['inspect', 'com.docker.compose.project.working_dir'], '/somebody/else/.houston/edge\n'],
    ]);
    const { up } = await import('../../../src/core/edge/runtime');
    await expect(up({ pull: false })).rejects.toBeInstanceOf(ConflictError);
    await expect(up({ pull: false })).rejects.toThrow(/would REPLACE it/u);
    await expect(up({ pull: false })).rejects.toThrow('/somebody/else/.houston/edge');
    // It must not have run compose at all.
    expect(composeSeam).not.toHaveBeenCalled();
  });
});

describe('doctor, about the edge', () => {
  // A home of its own per test: an edge written by any case above would be read here as
  // an installed one, and "never set up" is the first thing these assert.
  let own = '';
  let shared = '';
  beforeEach(() => {
    shared = process.env.HOUSTON_HOME ?? '';
    own = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-edge-doctor-'));
    process.env.HOUSTON_HOME = own;
  });
  afterEach(() => {
    process.env.HOUSTON_HOME = shared;
    fs.rmSync(own, { recursive: true, force: true });
  });
  const ctx = { context: '', dockerUp: true, cloud: null, owned: null };

  it('says nothing at all about an edge that was never set up', async () => {
    // Most installs have none; rows about it would be noise.
    scriptDocker([]);
    expect(await checkEdge(ctx)).toEqual([]);
  });

  it('tells a stale route to `edge delete` its host, never to `down` a workspace that is gone', async () => {
    // `down --name <it>` CANNOT remove a route whose workspace is gone -- the workspace is
    // the missing half, so `down` answers "no such workspace" and the route stays. Found
    // by running `houston doctor` in that state and following its own advice.
    await write(edge({ domain: 'support.example.com', acmeEmail: 'ops@example.com' }));
    await register('ghost', 'ghost.example.com', { local: true });
    scriptDocker([
      [['ps'], 'abc123\n'],
      [['inspect', 'com.docker.compose.project.working_dir'], `${paths.edgeDir()}\n`],
      [
        ['inspect', '{{json .NetworkSettings.Ports}}'],
        '{"80/tcp":[{"HostPort":"80"}],"443/tcp":[{"HostPort":"443"}]}',
      ],
    ]);
    const said = (await checkEdge(ctx))
      .map((row) => String(row.message))
      .filter((message) => message.includes('no workspace'))
      .join(' ');
    expect(said).not.toBe(''); // the stale route must still be reported
    expect(said).toContain('edge delete ghost.example.com');
    expect(said).not.toContain('down --name');
  });
});

describe('the ACME store the edge mounts', () => {
  it('is the one shared with workspaces, so an issued certificate is reused', () => {
    // Only NEW names then cost against the 50-per-domain-per-week limit; a private store
    // would re-request every name.
    const doc = composeDoc(
      edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }),
    ) as unknown as {
      services: { edge: { volumes: string[] } };
    };
    expect(doc.services.edge.volumes.some((volume) => volume.startsWith(`${acmeDir()}:`))).toBe(
      true,
    );
  });
});
