/**
 * Dynamic `e2ee` preset: Rocket.Chat's own end-to-end encryption, switched on, and test users.
 *
 * Encryption happens in the browser. Each user's keys are made, and their encryption password
 * shown, the first time they sign in with E2EE on, so this preset sets only the server settings
 * (Workspace > Settings > End-to-end encryption) and creates users to sign in as. Houston never
 * holds a key or an encryption password; a backup, restore or upgrade carries the keys as the
 * ordinary database data they are.
 *
 * Parameters (via `--set`):
 *   policy             optional|default|enforced (default optional).
 *   files              on|off (default on).
 *   allow_unencrypted  on|off (default off).
 *   users              on|off (default on).
 */
import { ValidationError } from '../errors';
import { parseVersion } from '../version-spec';

import { EMAIL_2FA, choiceParam } from './common';
import { type Params, register, registerScenario } from './registry';
import { Scenario } from './scenario';
import { emptyPreset, type Preset } from './types';

/** Created by the `e2ee_users` post-ready action, each with its username as its password. */
export const E2EE_TEST_USERS: readonly string[] = Object.freeze([
  'e2e-alice',
  'e2e-bob',
  'e2e-carol',
]);

const FORCE = 'OVERWRITE_SETTING_E2E_Force_Encryption_For_Private_Rooms';

interface Intent {
  policy: string;
  files: boolean;
  allow_unencrypted: boolean;
  users: boolean;
}

const PARAMS_HELP: Readonly<Record<string, string>> = Object.freeze({
  policy:
    'optional|default|enforced (default optional); default encrypts new DMs and private rooms, enforced also refuses unencrypted new private rooms (Rocket.Chat 8.8.0 or later)',
  files: 'on|off (default on); encrypt files sent in encrypted rooms',
  allow_unencrypted: 'on|off (default off); accept plaintext messages in encrypted rooms',
  users: `on|off (default on); create ${E2EE_TEST_USERS.join(', ')}, each with its username as its password`,
});

function resolveIntent(params: Params): Intent {
  // choiceParam's first choice is the default.
  const on = (key: string, fallback: 'on' | 'off'): boolean =>
    choiceParam(params, key, fallback === 'on' ? ['on', 'off'] : ['off', 'on']) === 'on';
  return {
    policy: choiceParam(params, 'policy', ['optional', 'default', 'enforced']),
    files: on('files', 'on'),
    allow_unencrypted: on('allow_unencrypted', 'off'),
    users: on('users', 'on'),
  };
}

function adapter(intent: Intent): Preset {
  const encryptNew = String(intent.policy !== 'optional');
  return {
    ...emptyPreset('e2ee'),
    description:
      "Rocket.Chat's end-to-end encryption switched on, with test users; each user's keys are made in their own browser.",
    source: 'built-in (scenario)',
    scenario: 'e2ee',
    scenarioParams: { ...intent },
    paramsHelp: { ...PARAMS_HELP },
    env: {
      OVERWRITE_SETTING_E2E_Enable: 'true',
      OVERWRITE_SETTING_E2E_Enabled_Default_DirectRooms: encryptNew,
      OVERWRITE_SETTING_E2E_Enabled_Default_PrivateRooms: encryptNew,
      ...(intent.policy === 'enforced' ? { [FORCE]: 'true' } : {}),
      OVERWRITE_SETTING_E2E_Enable_Encrypt_Files: String(intent.files),
      OVERWRITE_SETTING_E2E_Allow_Unencrypted_Messages: String(intent.allow_unencrypted),
      // The test users' emails are verified, and a repro has no mail server to send them a
      // code; composed with `email`, Mailpit catches it and email's value wins.
      ...(intent.users ? { [EMAIL_2FA]: 'false' } : {}),
    },
    softEnv: intent.users ? [EMAIL_2FA] : [],
    postReady: intent.users ? [{ action: 'e2ee_users' }] : [],
    notes: [
      `End-to-end encryption is on (policy=${intent.policy}). A user's keys are made in their browser the first time they sign in, and Rocket.Chat shows their encryption password once; save it.`,
      ...(intent.users
        ? [
            `Test users: ${E2EE_TEST_USERS.join(', ')}, each with its username as its password. Sign in as two of them in separate browser profiles.`,
          ]
        : []),
      'Open Rocket.Chat on localhost or over HTTPS: a browser encrypts only on a secure origin.',
      ...(intent.policy === 'enforced'
        ? ['Enforced applies to private rooms created from now on; federated rooms are exempt.']
        : []),
    ],
  };
}

/**
 * `policy=enforced` sets a setting Rocket.Chat added in 8.8.0. An older server ignores it and
 * enforces nothing, so the workspace would not be what was asked for: refused before anything
 * is created. A version that is not a number (a build tag) is let through, unknowable here.
 */
export function refuseEnforcedBefore880(pre: Preset, rcVersion: string): void {
  if (pre.env[FORCE] !== 'true') return;
  let release: number[];
  try {
    release = parseVersion(rcVersion).release;
  } catch {
    return;
  }
  const [major = 0, minor = 0] = release;
  if (major > 8 || (major === 8 && minor >= 8)) return;
  throw new ValidationError(
    `e2ee policy=enforced needs Rocket.Chat 8.8.0 or later; ${rcVersion} would not enforce it. ` +
      'Choose a newer version, or policy=default.',
  );
}

const SCENARIO = new Scenario<Intent>({
  name: 'e2ee',
  paramsHelp: PARAMS_HELP,
  resolveIntent,
  // Settings and REST-created users: the same on both runtimes, monolith or microservices.
  adapters: { docker: adapter, kubernetes: adapter },
});

export function scenario(): Scenario<Intent> {
  return SCENARIO;
}

export function build(params: Params): Preset {
  return SCENARIO.resolve(params, 'docker');
}

register('e2ee', build);
registerScenario('e2ee', SCENARIO);
