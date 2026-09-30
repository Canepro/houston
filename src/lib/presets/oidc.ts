/**
 * Dynamic `oidc` preset: a Keycloak OpenID Connect IdP that Rocket.Chat logs in against
 * via its Custom OAuth provider.
 *
 * Reuses the shared Keycloak scaffolding, but ships an OIDC client instead of a SAML one.
 * OIDC authenticates with a client id + a fixed client secret (no signing certs), so there is
 * no runtime cert fetch.
 *
 * THE ONE GOTCHA: OIDC's `url` is used by BOTH the browser (authorize) and RC's backend
 * (token/userinfo). We use a single shared hostname `keycloak:8085` -- RC's backend
 * resolves it over the compose network; the browser resolves it via a one-line hosts
 * entry `127.0.0.1  keycloak` (houston prints it). Keycloak is published on host port
 * 8085 (SAML uses 8081, so the two presets do not collide).
 */
import { intParam, presetPort, presetPorts, strParam } from './common';
import * as keycloak from './keycloak';
import { type Params, register } from './registry';
import { emptyPreset, type Preset } from './types';

/**
 * Distinct from SAML's, so both presets can run at once (8080 is too commonly occupied --
 * e.g. other local Keycloaks).
 */
const KC_PORT = presetPort('oidc');
const KC_REALM = keycloak.REALM;
/** Resolvable from RC (compose DNS) AND the browser (/etc/hosts). */
const KC_HOST = 'keycloak';
const CLIENT_ID = 'rc-oidc';
const CLIENT_SECRET = 'rc-oidc-secret';
/** RC Custom OAuth name -> settings key + /_oauth/keycloak callback. */
const PROVIDER = 'keycloak';

type Bag = Record<string, unknown>;

/** Capitalised: first character upper, the rest lower. */
function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function oidcClient(idpHost: string): Bag {
  return {
    clientId: CLIENT_ID,
    protocol: 'openid-connect',
    enabled: true,
    publicClient: false, // confidential -> uses the client secret
    secret: CLIENT_SECRET, // pinned so RC's config matches on import
    standardFlowEnabled: true, // authorization-code flow
    directAccessGrantsEnabled: true,
    // WHERE KEYCLOAK IS ALLOWED TO SEND THE BROWSER BACK -- which is Rocket.Chat's own
    // callback, `<Site_Url>/_oauth/keycloak`, and therefore has nothing to do with the
    // IdP's hostname. `http://localhost*` covers the ordinary case; the https entry
    // covers a workspace created with `--domain`, whose Site_Url is
    // `https://<name>.<domain>` and which Keycloak refused outright with "Invalid
    // parameter: redirect_uri" because no pattern here matched it.
    redirectUris: [
      'http://localhost*',
      `http://${idpHost}:${String(KC_PORT)}/*`,
      'http://*',
      'https://*',
    ],
    webOrigins: ['*'],
    // Keycloak's built-in openid/profile/email scopes already emit preferred_username /
    // email / name / sub -- no custom mappers needed.
  };
}

/** The Accounts_OAuth_Custom block that points Rocket.Chat at this Keycloak realm. */
function oauthSettings(
  realmBase: string,
  setting: string,
): [Record<string, string>, Record<string, unknown>] {
  // A custom OAuth provider's settings do not exist until it is created via the API, so
  // these cannot be OVERWRITE_SETTING env -- houston creates the provider and sets these
  // on `ready` (post_ready). Values are full setting ids.
  const settings: Record<string, unknown> = {
    [setting]: true,
    [`${setting}-url`]: realmBase,
    [`${setting}-authorize_path`]: '/protocol/openid-connect/auth',
    [`${setting}-token_path`]: '/protocol/openid-connect/token',
    [`${setting}-identity_path`]: '/protocol/openid-connect/userinfo',
    [`${setting}-token_sent_via`]: 'header',
    [`${setting}-scope`]: 'openid profile email',
    [`${setting}-id`]: CLIENT_ID,
    [`${setting}-secret`]: CLIENT_SECRET,
    [`${setting}-login_style`]: 'popup',
    [`${setting}-username_field`]: 'preferred_username',
    [`${setting}-email_field`]: 'email',
    [`${setting}-name_field`]: 'name',
    [`${setting}-merge_users`]: true,
    [`${setting}-show_button`]: true,
    [`${setting}-button_label_text`]: 'Keycloak (OIDC)',
    [`${setting}-button_color`]: '#1d74f5',
    [`${setting}-button_label_color`]: '#FFFFFF',
  };

  const env: Record<string, string> = {
    // This one IS a real existing setting, so OVERWRITE works at boot. No SMTP in the
    // repro -> don't block first login on email-2FA.
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'false',
  };
  return [env, settings];
}

/** The preset itself: what it is called, what it needs, and what `up` must do after. */
function oidcPreset(
  env: Record<string, string>,
  idpHost: string,
  settings: Record<string, unknown>,
  services: Record<string, Record<string, unknown>>,
  users: number,
): Preset {
  return {
    ...emptyPreset('oidc'),
    description:
      `Keycloak OIDC IdP (OpenID Connect) with ${String(users)} users user1..user` +
      `${String(users)} (password=username). RC logs in via Custom OAuth (popup). ` +
      "Click 'Keycloak (OIDC)', sign in as user1/user1. " +
      'See the note printed on `up` for how the browser reaches the IdP.',
    env,
    services,
    dependsOn: ['keycloak'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    files: [['oidc/keycloak-realm.json', keycloak.realmJson([oidcClient(idpHost)], users)]],
    // The same Keycloak as native resources. One Preset carries both renderings because
    // the intent is identical either way -- see `keycloak.manifests`.
    kubernetesManifests: [
      keycloak.manifests(keycloak.realmJson([oidcClient(idpHost)], users), KC_PORT, KC_PORT),
    ],
    paramsHelp: {
      users: 'number of Keycloak test users (default 5)',
      idp_host:
        'hostname BOTH your browser and Rocket.Chat reach ' +
        "Keycloak on (default 'keycloak', which needs a " +
        'hosts entry and only works on this machine)',
    },
    ports: [...presetPorts('oidc')],
    postReady: [
      { action: 'keycloak_master_ssl_off', service: 'keycloak', port: KC_PORT },
      // Create the Custom OAuth provider and configure it (cannot be done via env, since
      // the provider's settings do not exist until it is created).
      { action: 'create_oauth_provider', name: capitalize(PROVIDER), settings },
    ],
    notes: [
      ...(idpHost === KC_HOST
        ? [
            'OIDC needs one host entry so your browser can reach Keycloak at the',
            "same URL RC's backend uses. Add this line to /etc/hosts (needs sudo):",
            '    127.0.0.1  keycloak',
            '  That entry points at THIS machine, so the browser has to be on it. From',
            '  another machine, re-create with:  --bind 0.0.0.0 --set idp_host=<this host>',
            '  which needs no hosts entry at all.',
            "Then log in via 'Keycloak (OIDC)' as user1 / user1.",
          ]
        : [
            `Your browser AND Rocket.Chat both reach Keycloak at http://${idpHost}:${String(KC_PORT)}.`,
            '  No hosts entry is needed, but the workspace must be bound wide enough',
            '  for both to get there (`--bind 0.0.0.0`).',
            "Log in via 'Keycloak (OIDC)' as user1 / user1.",
          ]),
      `Keycloak admin console: http://${idpHost}:${String(KC_PORT)}  (admin/admin, realm '${KC_REALM}').`,
    ],
  };
}

export function build(params: Params): Preset {
  const users = intParam(params, 'users', 5);
  // ONE hostname for two consumers -- the browser (authorize) and RC's backend
  // (token/userinfo) -- which is the gotcha this preset's doc comment opens with. The
  // default `keycloak` satisfies the backend over compose DNS and needs a hosts entry for
  // the browser, and that entry (`127.0.0.1 keycloak`) is only correct when the browser
  // is on THIS machine. It is not, on the shared-box deployment this tool now supports,
  // so the popup opened a name that did not resolve and showed the user a blank window --
  // reported as "the OIDC page shows nothing".
  //
  // Setting this to the host's own address satisfies BOTH and removes the hosts entry
  // entirely: the browser reaches the published port, and RC's container reaches the same
  // address over the bridge. It needs `--bind 0.0.0.0`, because a loopback-bound port is
  // not reachable from either.
  const idpHost = strParam(params, 'idp_host', KC_HOST);
  const realmBase = `http://${idpHost}:${String(KC_PORT)}/realms/${KC_REALM}`;
  // Accounts_OAuth_Custom-Keycloak
  const setting = `Accounts_OAuth_Custom-${capitalize(PROVIDER)}`;

  const services = {
    // http_port: listen on the same port we publish, so the single `keycloak:8085` URL
    // works from the browser (via /etc/hosts) and RC's backend (via the compose network)
    // identically.
    keycloak: keycloak.service('./oidc/keycloak-realm.json', KC_PORT, KC_PORT),
  };

  const [env, settings] = oauthSettings(realmBase, setting);

  return oidcPreset(env, idpHost, settings, services, users);
}

register('oidc', build);
