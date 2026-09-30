/**
 * Dynamic `email` preset: a Mailpit mailcatcher wired to Rocket.Chat's SMTP.
 *
 * Mailpit is a sink, not a relay: it accepts all outgoing mail on SMTP :1025 and shows it in
 * a web UI -- nothing leaves the machine, so you can read a password reset link, invite,
 * verification mail or 2FA code seconds after RC sends it, for ANY user, without owning a
 * real mailbox.
 *
 * Email-2FA is enabled globally, but RC only applies it to users with a VERIFIED email --
 * seeded users (alice/alice, ...) are verified, so they get the full OTP flow (code lands
 * in Mailpit); the admin is not verified, so it logs in plain until you verify it.
 * houston's own admin logins keep working either way: the preset records Mailpit's URL in
 * the repro metadata (`Preset.extra`) and `rcapi.login` fetches a required code from
 * Mailpit automatically.
 *
 * Parameters (via `--set`):
 *   verification   require email verification on new accounts (default false).
 */
import * as config from '../config';

import { k8sManifests, presetPort, presetPorts, truthyParam } from './common';
import { type Params, register } from './registry';
import { emptyPreset, type Preset } from './types';

/** Web UI + API; SMTP :1025 stays compose-internal. */
const MAILPIT_WEB_PORT = presetPort('email');
const SMTP_PORT = 1025;
const FROM = 'rocketchat@example.com';
const IMAGE = 'docker.io/axllent/mailpit:v1.20';

/** Compose service for the SMTP sink and its browser inbox. */
function mailpitService(): Record<string, Record<string, unknown>> {
  return {
    mailpit: {
      // Multi-arch (amd64/arm64) -- native on Apple Silicon.
      image: IMAGE,
      restart: 'unless-stopped',
      environment: {
        // Accept any/plain SMTP so RC connects without credentials.
        MP_SMTP_AUTH_ACCEPT_ANY: '1',
        MP_SMTP_AUTH_ALLOW_INSECURE: '1',
      },
      ports: [`${String(MAILPIT_WEB_PORT)}:8025`],
    },
  };
}

/** Rocket.Chat settings that deliver all mail to Mailpit. */
function smtpSettings(verification: boolean): Record<string, string> {
  const env: Record<string, string> = {
    // Wire RC's SMTP at Mailpit -- plain SMTP, no TLS, no auth.
    OVERWRITE_SETTING_SMTP_Host: 'mailpit',
    OVERWRITE_SETTING_SMTP_Port: String(SMTP_PORT),
    OVERWRITE_SETTING_SMTP_Protocol: 'smtp',
    OVERWRITE_SETTING_SMTP_IgnoreTLS: 'true',
    OVERWRITE_SETTING_SMTP_Username: '',
    OVERWRITE_SETTING_SMTP_Password: '',
    OVERWRITE_SETTING_From_Email: FROM,
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'true',
  };
  if (verification) env.OVERWRITE_SETTING_Accounts_EmailVerification = 'true';
  return env;
}

/** The Mailpit workload and both of its in-cluster ports. */
function mailpitManifests(): string {
  return k8sManifests({
    name: 'mailpit',
    image: IMAGE,
    ports: [
      [MAILPIT_WEB_PORT, 8025],
      [1025, 1025],
    ],
    env: { MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1' },
    // Only the web UI is published to the host; SMTP is reached in-cluster by
    // Rocket.Chat, exactly as it is over the compose network.
    readiness: {
      httpGet: { path: '/', port: 8025 },
      initialDelaySeconds: 3,
      periodSeconds: 3,
      failureThreshold: 40,
    },
    ui: { mailpit: [MAILPIT_WEB_PORT, 8025] },
  });
}

export function build(params: Params): Preset {
  const verification = truthyParam(params, 'verification');
  const mailpitUrl = `http://localhost:${String(MAILPIT_WEB_PORT)}`;
  return {
    ...emptyPreset('email'),
    description:
      "Mailpit mailcatcher wired to RC's SMTP. Every email RC sends — " +
      'password resets, invites, verification, notification and 2FA mail — ' +
      `is captured at ${mailpitUrl} instead of leaving the machine. ` +
      'Pair with --seed for users with verified emails.',
    env: smtpSettings(verification),
    services: mailpitService(),
    dependsOn: ['mailpit'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    paramsHelp: {
      verification: 'require email verification on new accounts (default false)',
    },
    extra: { [config.EXTRA_MAILPIT_URL]: mailpitUrl },
    ports: [...presetPorts('email')],
    kubernetesManifests: [mailpitManifests()],
    notes: [
      `Mailpit (EVERY email RC sends, for ALL users, lands here): ${mailpitUrl}`,
      '  — one shared inbox; tell users apart by the To: column.',
      "Quick SMTP check: Admin → Email → 'Send test email', then open Mailpit.",
      'Email-2FA is ON globally, but RC only enforces it on VERIFIED emails:',
      '  seeded users (alice/…) get the OTP flow (code in Mailpit); admin is',
      "  unverified so it logs in plain. houston's own token/api/seed calls",
      '  fetch any required code from Mailpit automatically.',
      'Seeded users (--seed) are created with verified emails, ready for 2FA.',
    ],
  };
}

register('email', build);
