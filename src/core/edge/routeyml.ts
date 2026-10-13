/**
 * The routing files Traefik watches. Tier 3 of `src/core/edge/`.
 */
import { RC_CONTAINER_PORT } from '../../lib/config';
import { rcServiceNames } from '../../lib/compose';
import { ValidationError } from '../../lib/errors';
import { storedText } from '../../lib/format';
import { type PublicPath } from '../../lib/presets/public';

import { backendContainer } from './networks';
import { ADDR_RE } from './paths';
import { type Edge } from './types';

/**
 * The routing file for the GUI itself.
 *
 * When a wildcard is available this router is what asks for it -- one request covering the
 * apex and every `*.domain` workspace, so no workspace ever costs a certificate again.
 */
export function guiRouteYml(value: Edge): string {
  const wildcard = value.wildcard ? `*.${value.domain}` : '';
  // The port as the spec holds it: a spec that holds 7071.0 routes to `:7071.0`, as it
  // always has.
  return routeYml(
    'gui',
    value.domain,
    [`http://host.docker.internal:${storedText(value.guiPort)}`],
    {
      sticky: false,
      wildcard,
    },
  );
}

/**
 * The routing file a workspace registers: `host` -> its Rocket.Chat.
 *
 * `wildcardBase` is the edge's domain when its wildcard already covers `host`. The route
 * then names that wildcard instead of the host, so Traefik serves the existing certificate
 * rather than requesting a per-name one.
 */
export async function workspaceRouteYml(
  name: string,
  host: string,
  {
    instances = 1,
    wildcardBase = '',
    local = false,
    grafana = false,
    paths = [],
  }: {
    instances?: number;
    wildcardBase?: string;
    local?: boolean;
    grafana?: boolean;
    paths?: readonly PublicPath[];
  } = {},
): Promise<string> {
  const backends: string[] = [];
  for (const service of rcServiceNames(instances)) {
    backends.push(`http://${await backendContainer(name, service)}:${String(RC_CONTAINER_PORT)}`);
  }
  // A preset's own UIs at their paths (`lib/presets/public.ts`), each to its container.
  const extra: [string, string, string][] = [];
  for (const p of paths) {
    extra.push([
      p.service,
      p.path,
      `http://${await backendContainer(name, p.service)}:${String(p.container_port)}`,
    ]);
  }
  return routeYml(name, host, backends, {
    local,
    wildcard: wildcardBase !== '' ? `*.${wildcardBase}` : '',
    grafanaBackend: grafana ? `http://${await backendContainer(name, 'grafana')}:3000` : '',
    paths: extra,
  });
}

/**
 * A route that does NOT decrypt: match `host` by SNI, forward raw TCP.
 *
 * The second kind of backend, and the reason it exists is fidelity rather than
 * convenience. A Kubernetes workspace's certificate lives in a cluster Secret and its
 * Ingress is what terminates TLS -- so if the edge terminated instead, the `tls:` block,
 * the Secret and cert-manager would never run, and those are exactly where a customer's
 * certificate bugs live. Passing through means the bytes the browser exchanges with the
 * ingress are the bytes it would exchange in production.
 *
 * `tcp` and `http` routers share the entrypoint deliberately: Traefik matches TCP routers
 * by SNI FIRST and falls through to HTTP routers for anything unmatched, which is what
 * lets one :443 terminate for a Compose name and pass through for a Kubernetes one.
 * Measured on this box, one entrypoint, two names: the Compose name received the edge's
 * own leaf and the Kubernetes name received the cluster's Secret, byte-identical to it.
 *
 * No `certResolver` and no certificate of any kind: naming one would make the edge request
 * a certificate for a name it is not serving, and the wildcard question (`covers`) does not
 * arise either, because nothing here presents a certificate. That is why `register`
 * returns false for this shape.
 */
export function passthroughRouteYml(
  key: string,
  host: string,
  address: string,
  httpAddress = '',
): string {
  for (const addr of httpAddress === '' ? [address] : [address, httpAddress]) {
    if (!ADDR_RE.test(addr || '')) {
      throw new ValidationError(
        `a passthrough backend needs \`<address>:<port>\`, not '${addr}' — Traefik would ` +
          `load the router with no reachable server and ${host} would answer nothing, with ` +
          "the reason only in the edge's own log.",
      );
    }
  }
  // THE HTTP-01 CHALLENGE, to the cluster's own :80. cert-manager answers it from a solver
  // Ingress on the cluster's plain-HTTP side; the edge redirected it to HTTPS instead, where
  // there is no solver, so the certificate never issued. Only the challenge path: every
  // other http:// request keeps the edge's redirect.
  const challenge =
    httpAddress === ''
      ? ''
      : 'http:\n' +
        '  routers:\n' +
        `    ${key}-acme-http:\n` +
        `      rule: "Host(\`${host}\`) && PathPrefix(\`/.well-known/acme-challenge/\`)"\n` +
        '      entryPoints: [web]\n' +
        // Above Traefik's bypassed internal HTTP solver and the redirect. Scoped by
        // hostname, so a Docker name still reaches the edge's own challenge handler.
        '      priority: 100\n' +
        `      service: ${key}-acme-http\n` +
        '  services:\n' +
        `    ${key}-acme-http:\n` +
        '      loadBalancer:\n' +
        '        servers:\n' +
        `          - url: "http://${httpAddress}"\n`;
  return (
    '# Generated by houston. Do not edit by hand.\n' +
    '# A TCP passthrough: the edge does NOT decrypt this name.\n' +
    'tcp:\n' +
    '  routers:\n' +
    `    ${key}:\n` +
    `      rule: "HostSNI(\`${host}\`)"\n` +
    '      entryPoints: [websecure]\n' +
    `      service: ${key}\n` +
    '      tls:\n' +
    '        passthrough: true\n' +
    '  services:\n' +
    `    ${key}:\n` +
    '      loadBalancer:\n' +
    '        servers:\n' +
    `          - address: "${address}"\n` +
    challenge
  );
}

function routeYml(
  key: string,
  host: string,
  backends: readonly string[],
  {
    sticky = true,
    wildcard = '',
    local = false,
    grafanaBackend = '',
    paths = [],
  }: {
    sticky?: boolean;
    wildcard?: string;
    local?: boolean;
    grafanaBackend?: string;
    paths?: readonly (readonly [service: string, path: string, backend: string])[];
  } = {},
): string {
  const servers = backends.map((backend) => `          - url: "${backend}"`).join('\n');
  // certResolver rather than a static certificate: the edge requests per name, and Traefik
  // derives WHAT to request from the Host() rule -- which is why the rule must name the
  // host and not be a bare PathPrefix.
  //
  // `domains` overrides that derivation. Naming the wildcard makes every router under it
  // resolve to ONE certificate: Traefik obtains it once and reuses it, which is the
  // difference between 1 and N against the weekly limit.
  //
  // A local certificate is LOADED from disk (`issueLocalCert` wrote it into the watched
  // directory), so naming a resolver would make Traefik go and request one from Let's
  // Encrypt for a .localhost name that can never be validated.
  let tlsBlock = local ? '      tls: {}\n' : '      tls:\n        certResolver: le\n';
  if (wildcard !== '' && !local) {
    tlsBlock += `        domains:\n          - main: "${wildcard}"\n`;
    if (wildcard.replace(/^\*\./u, '') === host) {
      // The apex is not matched by its own wildcard, so the router that requests it has to
      // ask for both or the GUI's own name is uncovered.
      tlsBlock =
        '      tls:\n        certResolver: le\n        domains:\n' +
        `          - main: "${host}"\n            sans: ["${wildcard}"]\n`;
    }
  }
  let body =
    '# Generated by houston. Do not edit by hand.\n' +
    'http:\n' +
    '  routers:\n' +
    `    ${key}:\n` +
    `      rule: "Host(\`${host}\`)"\n` +
    '      entryPoints: [websecure]\n' +
    `      service: ${key}\n` +
    tlsBlock +
    (grafanaBackend
      ? `    ${key}-grafana:\n` +
        `      rule: "Host(\`${host}\`) && PathPrefix(\`/grafana\`)"\n` +
        '      entryPoints: [websecure]\n' +
        `      service: ${key}-grafana\n` +
        tlsBlock
      : '') +
    paths
      .map(
        ([service, path]) =>
          `    ${key}-${service}:\n` +
          `      rule: "Host(\`${host}\`) && PathPrefix(\`${path}\`)"\n` +
          '      entryPoints: [websecure]\n' +
          `      service: ${key}-${service}\n` +
          tlsBlock,
      )
      .join('') +
    '  services:\n' +
    `    ${key}:\n` +
    '      loadBalancer:\n' +
    '        servers:\n' +
    `${servers}\n`;
  if (sticky) {
    // DDP websockets must not be bounced between instances mid-session.
    body +=
      '        sticky:\n          cookie:\n            name: rc_lb\n            secure: true\n';
  }
  if (grafanaBackend) {
    body +=
      `    ${key}-grafana:\n` +
      '      loadBalancer:\n' +
      '        servers:\n' +
      `          - url: "${grafanaBackend}"\n`;
  }
  for (const [service, , backend] of paths) {
    body +=
      `    ${key}-${service}:\n` +
      '      loadBalancer:\n' +
      '        servers:\n' +
      `          - url: "${backend}"\n`;
  }
  return body;
}
