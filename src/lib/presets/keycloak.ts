/**
 * Shared Keycloak scaffolding for the IdP presets (`saml`, `oidc`).
 *
 * Both presets run the same Keycloak image with a generated realm import; only the realm's
 * client (SAML vs OIDC) and the published port differ. Bump the Keycloak version here, once.
 */
import { safeDump } from './common';

export const UI_PORT_LABEL = 'houston.io/ui-port';

export const KC_IMAGE = 'quay.io/keycloak/keycloak:26.0';
export const REALM = 'houston';
const DOMAIN = 'example.com';

type Bag = Record<string, unknown>;

/** The Keycloak Deployment: one replica, dev mode, with its realm import mounted. */
function keycloakDeployment(
  containerPort: number,
  env: Bag[],
  labels: Record<string, string>,
): Bag {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'keycloak', labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: labels.app } },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'keycloak',
              image: KC_IMAGE,
              args: ['start-dev', '--import-realm'],
              env,
              ports: [{ containerPort }],
              // WITHOUT THIS the pod is Ready the instant the container starts -- about
              // forty seconds before Keycloak serves HTTP. Everything downstream then
              // waits on a signal that means nothing: the Service gets a "ready"
              // endpoint, the port-forward attaches to a backend that is not listening,
              // and post_ready fetches the IdP descriptor from a port with nothing behind
              // it. The operational audit caught precisely that -- SAML came up with an
              // empty cert and both post_ready actions failed.
              readinessProbe: {
                httpGet: { path: '/realms/master', port: containerPort },
                initialDelaySeconds: 10,
                periodSeconds: 5,
                // Realm import plus an image pull on a cold node; generous because the
                // cost of being wrong is a workspace that looks healthy and is not
                // configured.
                failureThreshold: 60,
              },
              // subPath, so the ConfigMap lands as a FILE next to Keycloak's own import
              // directory rather than replacing the directory.
              volumeMounts: [
                {
                  name: 'realm',
                  mountPath: '/opt/keycloak/data/import/houston-realm.json',
                  subPath: 'houston-realm.json',
                },
              ],
            },
          ],
          volumes: [{ name: 'realm', configMap: { name: 'keycloak-realm' } }],
        },
      },
    },
  };
}

/**
 * The same Keycloak, as native Kubernetes resources.
 *
 * Deliberately NOT a Scenario with two adapters like `ldap`. Keycloak's intent survives
 * the crossing untouched: the realm JSON is byte-identical, the settings Rocket.Chat
 * needs are identical, and the post_ready actions are REST calls that do not care. Only
 * the container's packaging differs, so `saml` and `oidc` carry BOTH renderings on one
 * Preset and each runtime reads the half it understands.
 *
 * THE HOSTNAME TRANSFERS, which is the part worth stating. `keycloak:<port>` has to
 * resolve identically from Rocket.Chat's backend and from the browser, because OIDC uses
 * one URL for the authorize redirect AND the token exchange. On Compose that is the
 * project network plus a `127.0.0.1 keycloak` hosts entry. Here it is a Service literally
 * named `keycloak` plus the same hosts entry, with the port forwarded to the same number.
 */
export function manifests(
  realm: string,
  hostPort: number,
  httpPort?: number,
  { workspace = '__HOUSTON_NAME__' }: { workspace?: string } = {},
): string {
  const containerPort = httpPort !== undefined && httpPort !== 0 ? httpPort : 8080;
  const labels: Record<string, string> = {
    app: 'houston-keycloak',
    'app.kubernetes.io/managed-by': 'houston',
    'houston.io/component': 'keycloak',
    'houston.io/repro': workspace,
    [UI_PORT_LABEL]: String(hostPort),
  };
  const env: Bag[] = [
    { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' },
    { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', value: 'admin' },
    // See `service()` for why: without it, anything terminating TLS in front serves an
    // https console that requests http assets, and the browser blocks every one.
    { name: 'KC_PROXY_HEADERS', value: 'xforwarded' },
  ];
  if (httpPort !== undefined && httpPort !== 0) {
    env.push({ name: 'KC_HTTP_PORT', value: String(httpPort) });
  }
  const configMap: Bag = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'keycloak-realm', labels },
    data: { 'houston-realm.json': realm },
  };
  const deployment = keycloakDeployment(containerPort, env, labels);
  const service: Bag = {
    apiVersion: 'v1',
    kind: 'Service',
    // `keycloak`, so RC's pod resolves exactly the hostname the realm and the settings
    // already name.
    metadata: { name: 'keycloak', labels },
    spec: {
      selector: { app: labels.app },
      ports: [{ name: 'http', port: hostPort, targetPort: containerPort }],
    },
  };
  return [configMap, deployment, service].map((doc) => safeDump(doc)).join('---\n');
}

/**
 * The Keycloak compose service.
 *
 * `httpPort` makes Keycloak listen on that port INSIDE the container too (KC_HTTP_PORT)
 * -- the oidc preset needs the same port inside and out so one `keycloak:<port>` URL works
 * from both the browser and RC's backend. Without it, Keycloak listens on its default
 * 8080.
 */
export function service(realmMount: string, hostPort: number, httpPort?: number): Bag {
  const env: Record<string, string> = {
    // Believe X-Forwarded-Proto/-Host, so the URLs Keycloak GENERATES match the scheme
    // and host the browser actually used.
    //
    // Keycloak builds absolute URLs for its own assets, its issuer and every OIDC
    // endpoint. Without this it derives them from the connection it can see -- plain http
    // on a published port -- so reaching the admin console through anything that
    // terminates TLS in front (an iximiuz lab forward, Codespaces, ngrok, a corporate
    // proxy) serves an https PAGE that asks for http RESOURCES, and the browser blocks
    // every one of them:
    //
    //   Mixed Content: The page at 'https://<host>/admin/master/console/' was loaded over
    //   HTTPS, but requested an insecure resource
    //   'http://<host>/resources/master/admin/en'. This request has been blocked.
    //
    // The console renders blank or half-dead, and nothing in the container log says why
    // -- the failure is entirely in the browser.
    //
    // Measured against quay.io/keycloak/keycloak:26.0, one request carrying
    // `X-Forwarded-Proto: https, X-Forwarded-Host: lab.example.com`:
    //
    //   without : issuer http://127.0.0.1:18085/realms/master
    //   with    : issuer https://lab.example.com/realms/master
    //
    // With no proxy in front there are no such headers and nothing changes -- also
    // measured, because a fix that alters the ordinary laptop case would be trading one
    // bug for another.
    //
    // KC_PROXY_HEADERS, not the old KC_PROXY: `proxy` was deprecated in 24 and REMOVED in
    // 26, which is the version above.
    KC_PROXY_HEADERS: 'xforwarded',
  };
  let containerPort = 8080;
  if (httpPort !== undefined && httpPort !== 0) {
    env.KC_HTTP_PORT = String(httpPort);
    containerPort = httpPort;
  }
  return {
    image: KC_IMAGE,
    command: ['start-dev', '--import-realm'],
    environment: {
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      ...env,
    },
    volumes: [`${realmMount}:/opt/keycloak/data/import/houston-realm.json:ro`],
    ports: [`${String(hostPort)}:${String(containerPort)}`],
    restart: 'unless-stopped',
  };
}

/** Test users user1..userN, password = username, verified emails. */
export function users(count: number): Bag[] {
  const out: Bag[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({
      username: `user${String(i)}`,
      enabled: true,
      emailVerified: true,
      email: `user${String(i)}@${DOMAIN}`,
      firstName: 'User',
      lastName: String(i),
      credentials: [{ type: 'password', value: `user${String(i)}`, temporary: false }],
    });
  }
  return out;
}

/**
 * A minimal realm export: just our client(s) + test users.
 *
 * Keycloak regenerates all default clients, flows and scopes on import anyway. This is the
 * realm as JSON indented by two, in the established spelling, which
 * `JSON.stringify(value, null, 2)` matches byte for byte on ASCII -- and everything in here
 * is ASCII by construction.
 */
export function realmJson(clients: Bag[], userCount: number): string {
  return JSON.stringify(
    {
      realm: REALM,
      enabled: true,
      sslRequired: 'none', // allow HTTP (reached via docker port-forward)
      clients,
      users: users(userCount),
    },
    null,
    2,
  );
}
