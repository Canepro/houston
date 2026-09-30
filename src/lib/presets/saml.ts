/**
 * Dynamic `saml` preset: a real Keycloak IdP that Rocket.Chat authenticates against over
 * SAML.
 *
 * The Keycloak realm is generated in code (a minimal realm with just our SAML client + N test
 * users) rather than shipping a bloated full export -- Keycloak regenerates all the default
 * clients/flows/scopes on import anyway.
 *
 * Parameters (via `--set`):
 *   users   number of test users to generate (default 5). Each userN has password userN
 *           and email userN@example.com -- log in as user1 / user1.
 *
 * Cert handling: Keycloak generates its signing key on realm import, so houston fetches
 * the cert at runtime (post_ready) and applies it to RC -- no manual exchange. The IdP is
 * published on host port 8081 (browser-reachable).
 */
import { intParam, presetPort, presetPorts, strParam } from './common';
import * as keycloak from './keycloak';
import { type Params, register } from './registry';
import { emptyPreset, type Preset } from './types';

const KC_PORT = presetPort('saml');
const KC_REALM = keycloak.REALM;
const KC_CLIENT = 'houston-saml-sp'; // must equal RC's SAML issuer

type Bag = Record<string, unknown>;

function samlMapper(name: string, userProperty: string): Bag {
  return {
    name,
    protocol: 'saml',
    protocolMapper: 'saml-user-property-mapper',
    consentRequired: false,
    config: {
      'user.attribute': userProperty,
      'attribute.nameformat': 'Basic',
      'attribute.name': name,
    },
  };
}

function client(): Bag {
  return {
    clientId: KC_CLIENT,
    protocol: 'saml',
    enabled: true,
    // Trailing wildcard: matches whatever host port houston assigns to RC.
    redirectUris: ['http://localhost*'],
    frontchannelLogout: true,
    attributes: {
      'saml.assertion.signature': 'true', // sign the assertion
      'saml.server.signature': 'true', // sign the response
      'saml.client.signature': 'false', // RC doesn't sign its requests
      'saml.force.post.binding': 'true',
      'saml.authnstatement': 'true',
      saml_name_id_format: 'email',
      'saml.signature.algorithm': 'RSA_SHA256',
    },
    protocolMappers: [
      samlMapper('email', 'email'),
      samlMapper('username', 'username'),
      samlMapper('firstName', 'firstName'),
      samlMapper('lastName', 'lastName'),
    ],
  };
}

/** Rocket.Chat's SAML provider settings for the generated Keycloak realm. */
function samlSettings(samlEp: string): Record<string, string> {
  return {
    OVERWRITE_SETTING_SAML_Custom_Default: 'true',
    OVERWRITE_SETTING_SAML_Custom_Default_provider: 'keycloak',
    OVERWRITE_SETTING_SAML_Custom_Default_entry_point: samlEp,
    // Keycloak serves SSO and SLO from the same endpoint. We logout locally by default,
    // but set this correctly so the config is coherent and real SLO works if
    // logout_behaviour is switched to "SAML".
    OVERWRITE_SETTING_SAML_Custom_Default_idp_slo_redirect_url: samlEp,
    OVERWRITE_SETTING_SAML_Custom_Default_logout_behaviour: 'Local',
    OVERWRITE_SETTING_SAML_Custom_Default_issuer: KC_CLIENT,
    OVERWRITE_SETTING_SAML_Custom_Default_button_label_text: 'Keycloak SSO',
    OVERWRITE_SETTING_SAML_Custom_Default_default_user_role: 'user',
    OVERWRITE_SETTING_SAML_Custom_Default_name_overwrite: 'false',
    OVERWRITE_SETTING_SAML_Custom_Default_mail_overwrite: 'false',
    OVERWRITE_SETTING_SAML_Custom_Default_user_data_fieldmap:
      '{"username":"username","email":"email","name":"firstName"}',
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'false',
  };
}

/** Package the shared IdP rendering with SAML-specific setup and guidance. */
function samlPreset(
  users: number,
  idpHost: string,
  descriptor: string,
  services: Record<string, Record<string, unknown>>,
  env: Record<string, string>,
): Preset {
  return {
    ...emptyPreset('saml'),
    description:
      `Keycloak IdP with a generated SAML realm (${String(users)} users user1..user` +
      `${String(users)}, password=username). Click 'Keycloak SSO', log in as ` +
      `user1/user1. Keycloak admin at http://${idpHost}:${String(KC_PORT)} ` +
      "(admin/admin, realm 'houston').",
    env,
    services,
    dependsOn: ['keycloak'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    files: [['saml/keycloak-realm.json', keycloak.realmJson([client()], users)]],
    kubernetesManifests: [keycloak.manifests(keycloak.realmJson([client()], users), KC_PORT)],
    paramsHelp: {
      users: 'number of Keycloak test users (default 5)',
      idp_host:
        'hostname YOUR BROWSER reaches Keycloak on ' +
        '(default localhost; set it when the browser is ' +
        'not on this machine)',
    },
    ports: [...presetPorts('saml')],
    notes: [
      `SAML sends your BROWSER to http://${idpHost}:${String(KC_PORT)} — that address has`,
      '  to resolve and be reachable from wherever the browser is running.',
      ...(idpHost !== 'localhost'
        ? []
        : [
            "  It is 'localhost', so the browser must be on THIS machine. From another",
            '  machine, re-create with:  --bind 0.0.0.0 --set idp_host=<this host>',
            '  (Keycloak refuses a request that arrives on any other name.)',
          ]),
      `Keycloak admin console: http://${idpHost}:${String(KC_PORT)}  (admin / admin)`,
      `  Your SAML users live in the '${KC_REALM}' realm, NOT 'master' (the`,
      '  default view). Switch the realm dropdown (top-left) to ' +
        `'${KC_REALM}', or open Users directly:`,
      `    http://${idpHost}:${String(KC_PORT)}/admin/master/console/#/${KC_REALM}/users`,
      "  ('temporary admin' banner on master is normal Keycloak dev mode — ignore it)",
    ],
    postReady: [
      {
        action: 'saml_idp_cert',
        descriptor_url: descriptor,
        setting: 'SAML_Custom_Default_cert',
        enable_setting: 'SAML_Custom_Default',
      },
      { action: 'keycloak_master_ssl_off', service: 'keycloak' },
    ],
  };
}

export function build(params: Params): Preset {
  const users = intParam(params, 'users', 5);
  // THE BROWSER'S ADDRESS FOR THE IdP, not houston's. `entry_point` is the URL the user's
  // browser is redirected to, and it was hardcoded to `localhost` -- which names the
  // browser's OWN machine. On a shared box (the deployment this tool now supports: one
  // `serve` on an EC2 instance, several engineers using the GUI) the SAML button
  // therefore sent every one of them to port 8081 on their own laptop, and the browser
  // bounced straight back to the login page having reached nothing.
  //
  // Keycloak makes the mismatch unforgiving in the other direction too: it checks the
  // AuthnRequest's `Destination` against the URL the request actually arrived on, so
  // reaching the IdP as anything other than what `entry_point` says is refused with
  // `error="invalid_authn_request" reason="invalid_destination"` -- measured on this box
  // by changing nothing but the hostname. The two must agree, which is why this is one
  // knob and not a guess.
  const idpHost = strParam(params, 'idp_host', 'localhost');
  const samlEp = `http://${idpHost}:${String(KC_PORT)}/realms/${KC_REALM}/protocol/saml`;
  // FETCHED BY houston, so it stays on loopback whatever the browser uses. Same split as
  // root_url/public_url elsewhere in this codebase: an internal caller and a browser do
  // not need the same address, and giving the internal one the public address is how
  // `--set idp_host=<public name>` would break its own cert fetch on a workspace bound to
  // 127.0.0.1.
  const descriptor = `http://localhost:${String(KC_PORT)}/realms/${KC_REALM}/protocol/saml/descriptor`;
  const services = {
    keycloak: keycloak.service('./saml/keycloak-realm.json', KC_PORT),
  };
  return samlPreset(users, idpHost, descriptor, services, samlSettings(samlEp));
}

register('saml', build);
