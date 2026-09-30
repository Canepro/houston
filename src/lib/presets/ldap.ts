/**
 * Dynamic `ldap` preset: an OpenLDAP directory seeded with N users + a group, with
 * Rocket.Chat wired to authenticate against it.
 *
 * The only preset that is a SCENARIO -- one deployment-neutral intent with a Compose adapter
 * and a Kubernetes adapter, rather than one Preset carrying both renderings the way `saml`
 * and `oidc` do.
 *
 * Parameters (via `--set`):
 *   users   number of LDAP users to generate (default 5). Set high (e.g. 130000) to
 *           reproduce LDAP-sync scale/performance issues.
 *   domain  LDAP domain (default example.com) -> base DN dc=example,dc=com.
 *
 * Every user `userN` has password `userN`, so you can log in immediately as `user1` /
 * `user1`. The local admin (admin/admin123) still works via LDAP_Login_Fallback, so
 * houston's own API/token calls keep functioning.
 */
import { intParam, presetPort, presetPorts, safeDump, strParam } from './common';
import { type Params, register, registerScenario } from './registry';
import { Scenario } from './scenario';
import { emptyPreset, type Preset } from './types';

/**
 * phpLDAPadmin's host port, from the ONE registry both runtimes read. Compose publishes it
 * directly; Kubernetes declares it on the Service (see `UI_PORT_LABEL`) and the lifecycle
 * forwards it. Same number either way, so a ticket's instructions do not depend on where
 * the workspace happens to run.
 */
const UI_PORT = presetPort('ldap');

/** Multi-arch (amd64/arm/arm64), and the standard pairing with osixia/openldap. */
const UI_IMAGE = 'osixia/phpldapadmin:0.9.0';

/**
 * A Service wearing this label is published on the host port it names. One convention for
 * every scenario, so the four presets still to be adapted need no new mechanism -- and no
 * second place to declare a port that could disagree with `config.PRESET_PORTS`.
 */
export const UI_PORT_LABEL = 'houston.io/ui-port';

/** osixia imports custom LDIF from here on first boot (with `--copy-service`). */
const BOOTSTRAP_PATH =
  '/container/service/slapd/assets/config/bootstrap/ldif/custom/50-rc-users.ldif';
const GROUP_CN = 'rc-users';
const GID = '5000';
const PARAMS_HELP: Readonly<Record<string, string>> = Object.freeze({
  users: 'number of LDAP users to generate (default 5; try 130000 for scale)',
  domain: 'LDAP domain (default example.com)',
});

type Bag = Record<string, unknown>;

/** Deployment-neutral LDAP intent shared by each native adapter. */
export interface LDAPIntent {
  readonly users: number;
  readonly domain: string;
  readonly baseDn: string;
  readonly adminPassword: string;
}

function asParams(intent: LDAPIntent): Bag {
  return { users: intent.users, domain: intent.domain, base_dn: intent.baseDn };
}

function ldif(baseDn: string, domain: string, users: number): string {
  const blocks = [
    `dn: ou=Users,${baseDn}\nobjectClass: organizationalUnit\nou: Users\n`,
    `dn: ou=groups,${baseDn}\nobjectClass: organizationalUnit\nou: groups\n`,
  ];
  for (let i = 1; i <= users; i += 1) {
    const uid = `user${String(i)}`;
    blocks.push(
      `dn: uid=${uid},ou=Users,${baseDn}\n` +
        'objectClass: inetOrgPerson\n' +
        'objectClass: posixAccount\n' +
        `cn: User ${String(i)}\n` +
        `sn: ${String(i)}\n` +
        `uid: ${uid}\n` +
        `uidNumber: ${String(1000 + i)}\n` +
        `gidNumber: ${GID}\n` +
        `homeDirectory: /home/${uid}\n` +
        `mail: ${uid}@${domain}\n` +
        `userPassword: ${uid}\n`,
    );
  }
  let members = '';
  for (let i = 1; i <= users; i += 1) members += `memberUid: user${String(i)}\n`;
  blocks.push(
    `dn: cn=${GROUP_CN},ou=groups,${baseDn}\n` +
      'objectClass: top\n' +
      'objectClass: posixGroup\n' +
      `cn: ${GROUP_CN}\n` +
      `gidNumber: ${GID}\n` +
      `${members}`,
  );
  return `${blocks.join('\n')}\n`;
}

function intent(params: Params): LDAPIntent {
  const users = intParam(params, 'users', 5);
  const domain = strParam(params, 'domain', 'example.com');
  const baseDn = domain
    .split('.')
    .map((part) => `dc=${part}`)
    .join(',');
  return { users, domain, baseDn, adminPassword: 'admin' };
}

/** Rocket.Chat LDAP settings shared by Compose and Kubernetes. */
function envFor(it: LDAPIntent, host = 'openldap'): Record<string, string> {
  return {
    OVERWRITE_SETTING_LDAP_Enable: 'true',
    // Generic OpenLDAP, NOT Active Directory. Without this, RC defaults to server type
    // "ad" and searches sAMAccountName instead of our uid field, so every LDAP login
    // fails with "User not found".
    OVERWRITE_SETTING_LDAP_Server_Type: '',
    OVERWRITE_SETTING_LDAP_Host: host,
    OVERWRITE_SETTING_LDAP_Port: '389',
    OVERWRITE_SETTING_LDAP_BaseDN: it.baseDn,
    OVERWRITE_SETTING_LDAP_Authentication: 'true',
    OVERWRITE_SETTING_LDAP_Authentication_UserDN: `cn=admin,${it.baseDn}`,
    OVERWRITE_SETTING_LDAP_Authentication_Password: it.adminPassword,
    OVERWRITE_SETTING_LDAP_User_Search_Filter: '(objectclass=inetOrgPerson)',
    OVERWRITE_SETTING_LDAP_User_Search_Field: 'uid',
    OVERWRITE_SETTING_LDAP_User_Search_Scope: 'sub',
    OVERWRITE_SETTING_LDAP_Unique_Identifier_Field: 'uid',
    // Keep local login working so admin/admin123 (and houston's API) still work.
    OVERWRITE_SETTING_LDAP_Login_Fallback: 'true',
    // No SMTP in the repro, so email-2FA on a new LDAP user's first login would block it
    // with an OTP that goes nowhere. Turn it off so you can actually log in as
    // user1/user1.
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'false',
  };
}

function describe(it: LDAPIntent): string {
  return (
    `OpenLDAP (osixia) seeded with ${String(it.users)} user(s) + group ` +
    `'${GROUP_CN}'; RC wired for LDAP login. Log in as user1 / user1.`
  );
}

function notesFor(it: LDAPIntent): string[] {
  return [
    `phpLDAPadmin: http://localhost:${String(UI_PORT)}`,
    `    log in with DN  cn=admin,${it.baseDn}  /  ${it.adminPassword}`,
    `    Rocket.Chat users are user1..user${String(it.users)}, password same as name`,
  ];
}

function composeAdapter(it: LDAPIntent): Preset {
  const services: Record<string, Record<string, unknown>> = {
    openldap: {
      image: 'osixia/openldap:1.5.0', // multi-arch (amd64/arm64) — no platform pin
      command: ['--copy-service'], // required to import custom bootstrap LDIF
      environment: {
        LDAP_ORGANISATION: 'Houston',
        LDAP_DOMAIN: it.domain,
        LDAP_BASE_DN: it.baseDn,
        LDAP_ADMIN_PASSWORD: it.adminPassword,
      },
      volumes: [`./ldap/50-rc-users.ldif:${BOOTSTRAP_PATH}:ro`],
      restart: 'unless-stopped',
    },
    // A directory you cannot look at is hard to reproduce against: "is the user there,
    // and what attributes does it have" is the first question of nearly every LDAP
    // ticket, and answering it meant `docker exec ... ldapsearch`.
    phpldapadmin: {
      image: UI_IMAGE,
      environment: {
        PHPLDAPADMIN_LDAP_HOSTS: 'openldap',
        // The directory is on a private network with a fixed throwaway password; HTTPS
        // here would only add a certificate warning.
        PHPLDAPADMIN_HTTPS: 'false',
      },
      ports: [`${String(UI_PORT)}:80`],
      depends_on: ['openldap'],
      restart: 'unless-stopped',
    },
  };
  return {
    ...emptyPreset('ldap'),
    description: describe(it),
    env: envFor(it),
    services,
    dependsOn: ['openldap'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    files: [['ldap/50-rc-users.ldif', ldif(it.baseDn, it.domain, it.users)]],
    // Declared so port allocation and the capacity preflight can SEE it --
    // the invariant that holds each preset's ports to the registry caught this being
    // missing the moment phpLDAPadmin gained a port.
    ports: [...presetPorts('ldap')],
    notes: notesFor(it),
    paramsHelp: { ...PARAMS_HELP },
    scenario: 'ldap',
    scenarioParams: asParams(it),
  };
}

/** The phpLDAPadmin browser UI, which is the only way to see what LDAP holds. */
function phpldapadminWorkload(labels: Record<string, string>): [Bag, Bag] {
  // phpLDAPadmin, and the label that gets it published. A Service carrying
  // `houston.io/ui-port` is forwarded to that host port by the Kubernetes lifecycle -- the
  // declaration lives on the Service that defines the thing, rather than in a second
  // registry the adapter would have to be kept in step with. The NUMBER still comes from
  // `config.PRESET_PORTS`, so both runtimes publish the same one.
  const uiLabels: Record<string, string> = { ...labels };
  uiLabels.app = 'houston-phpldapadmin';
  uiLabels[UI_PORT_LABEL] = String(UI_PORT);
  const uiDeployment: Bag = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'phpldapadmin', labels: uiLabels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: uiLabels.app } },
      template: {
        metadata: { labels: uiLabels },
        spec: {
          containers: [
            {
              name: 'phpldapadmin',
              image: UI_IMAGE,
              env: [
                { name: 'PHPLDAPADMIN_LDAP_HOSTS', value: 'openldap' },
                { name: 'PHPLDAPADMIN_HTTPS', value: 'false' },
              ],
              ports: [{ containerPort: 80 }],
              readinessProbe: {
                httpGet: { path: '/', port: 80 },
                initialDelaySeconds: 3,
                periodSeconds: 3,
                failureThreshold: 30,
              },
            },
          ],
        },
      },
    },
  };
  const uiService: Bag = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'phpldapadmin', labels: uiLabels },
    spec: {
      selector: { app: uiLabels.app },
      ports: [{ name: 'http', port: 80, targetPort: 80 }],
    },
  };
  return [uiDeployment, uiService];
}

/** The OpenLDAP Deployment and the Service in front of it. */
function openldapWorkload(it: LDAPIntent, labels: Record<string, string>): [Bag, Bag] {
  const deployment: Bag = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'openldap', labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: labels.app } },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'openldap',
              image: 'osixia/openldap:1.5.0',
              args: ['--copy-service'],
              env: [
                { name: 'LDAP_ORGANISATION', value: 'Houston' },
                { name: 'LDAP_DOMAIN', value: it.domain },
                { name: 'LDAP_BASE_DN', value: it.baseDn },
                { name: 'LDAP_ADMIN_PASSWORD', value: it.adminPassword },
              ],
              ports: [{ name: 'ldap', containerPort: 389 }],
              // slapd binds 389 only after the bootstrap LDIF is imported, and without
              // this the pod is Ready the instant the container starts -- so the Service
              // publishes an endpoint that is not serving, and Rocket.Chat starts against
              // an LDAP that is not answering. That is a first-login failure nobody would
              // connect back to here. tcpSocket rather than httpGet: LDAP is not HTTP,
              // and slapd binding the port IS the milestone.
              readinessProbe: {
                tcpSocket: { port: 389 },
                initialDelaySeconds: 5,
                periodSeconds: 3,
                failureThreshold: 40,
              },
              volumeMounts: [
                {
                  name: 'bootstrap',
                  mountPath: BOOTSTRAP_PATH,
                  subPath: '50-rc-users.ldif',
                },
              ],
            },
          ],
          volumes: [{ name: 'bootstrap', configMap: { name: 'openldap-bootstrap' } }],
        },
      },
    },
  };
  const service: Bag = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'openldap', labels },
    spec: {
      selector: { app: labels.app },
      ports: [{ name: 'ldap', port: 389, targetPort: 389 }],
    },
  };
  return [deployment, service];
}

/** Render the small OpenLDAP workload used by the Kubernetes adapter. */
function kubernetesManifest(it: LDAPIntent): string {
  const labels: Record<string, string> = {
    app: 'houston-openldap',
    'app.kubernetes.io/managed-by': 'houston',
    'houston.io/component': 'ldap',
    // The Kubernetes lifecycle substitutes the namespace-local repro name.
    'houston.io/repro': '__HOUSTON_NAME__',
  };
  const configMap: Bag = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'openldap-bootstrap', labels },
    data: { '50-rc-users.ldif': ldif(it.baseDn, it.domain, it.users) },
  };
  const [deployment, service] = openldapWorkload(it, labels);
  const [uiDeployment, uiService] = phpldapadminWorkload(labels);
  return [configMap, deployment, service, uiDeployment, uiService]
    .map((doc) => safeDump(doc))
    .join('---\n');
}

function kubernetesAdapter(it: LDAPIntent): Preset {
  return {
    ...emptyPreset('ldap'),
    description: describe(it),
    notes: notesFor(it),
    topology: 'kubernetes',
    // Declared here for the same reason the Compose adapter declares it, and it was
    // missing: phpLDAPadmin is published on the FIXED host port 8082 on this runtime too
    // (as a port-forward rather than a compose mapping), but with an empty `ports` list
    // `checkSidecarPorts` returns immediately and `sidecar_ports` is never recorded. So
    // a second Kubernetes LDAP workspace got no pre-flight refusal and its forward simply
    // failed to bind 8082 -- where Compose refuses up front and names the workspace
    // holding the port.
    //
    // The ports invariant did not catch it because it resolves presets through
    // `presets.load`, which is the DOCKER adapter.
    ports: [...presetPorts('ldap')],
    // The scenario changes the backing service and Rocket.Chat settings; it does not make
    // the microservices deployment cease to be an Enterprise topology. Preserve that
    // deployment-level requirement so lifecycle warnings and onboarding next-command
    // guidance remain truthful.
    requiresLicense: true,
    source: 'built-in (scenario)',
    env: envFor(it),
    paramsHelp: { ...PARAMS_HELP },
    scenario: 'ldap',
    scenarioParams: asParams(it),
    kubernetesManifests: [kubernetesManifest(it)],
  };
}

const SCENARIO = new Scenario<LDAPIntent>({
  name: 'ldap',
  paramsHelp: PARAMS_HELP,
  resolveIntent: intent,
  // Keyed by RUNTIME, in `core/topology.ts`'s words. See the note on `Preset.topology`
  // for why there is only one set of words for this.
  adapters: { docker: composeAdapter, kubernetes: kubernetesAdapter },
});

export function scenario(): Scenario<LDAPIntent> {
  return SCENARIO;
}

/** Legacy `ldap` loader entry point; resolve through the Compose adapter. */
export function build(params: Params): Preset {
  return SCENARIO.resolve(params, 'docker');
}

register('ldap', build);
registerScenario('ldap', SCENARIO);
