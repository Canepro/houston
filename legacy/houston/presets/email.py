"""Dynamic `email` preset: a Mailpit mailcatcher wired to Rocket.Chat's SMTP.

Mailpit is a sink, not a relay: it accepts all outgoing mail on SMTP :1025 and
shows it in a web UI — nothing leaves the machine, so you can read a password
reset link, invite, verification mail or 2FA code seconds after RC sends it,
for ANY user, without owning a real mailbox.

Email-2FA is enabled globally, but RC only applies it to users with a *verified*
email — seeded users (alice/alice, …) are verified, so they get the full OTP flow
(code lands in Mailpit); the admin isn't verified, so it logs in plain until you
verify it. houston's own admin logins keep working either way: the preset records
Mailpit's URL in the repro metadata (Preset.extra) and rcapi.login fetches a
required code from Mailpit automatically.

Pairs well with --seed: seeded users (alice/alice, …) have verified emails —
ready for 2FA opt-in and for receiving notification mail.

Parameters (via `--set`):
  verification   require email verification on new accounts (default false).
"""

from __future__ import annotations

import houston.presets._common as _common
from houston import config
from houston.presets.registry import Preset, register

_MAILPIT_WEB_PORT = config.PRESET_PORTS["email"][0]   # web UI + API; SMTP :1025 stays compose-internal
_SMTP_PORT = 1025
_FROM = "rocketchat@example.com"


def _mailpit_service():
    """Compose service for the SMTP sink and its browser inbox."""
    return {
        "mailpit": {
            # Multi-arch (amd64/arm64) — native on Apple Silicon.
            "image": "docker.io/axllent/mailpit:v1.20",
            "restart": "unless-stopped",
            "environment": {
                # Accept any/plain SMTP so RC connects without credentials.
                "MP_SMTP_AUTH_ACCEPT_ANY": "1",
                "MP_SMTP_AUTH_ALLOW_INSECURE": "1",
            },
            "ports": [f"{_MAILPIT_WEB_PORT}:8025"],
        }
    }


def _smtp_settings(verification):
    """Rocket.Chat settings that deliver all mail to Mailpit."""
    env = {
        # Wire RC's SMTP at Mailpit — plain SMTP, no TLS, no auth.
        "OVERWRITE_SETTING_SMTP_Host": "mailpit",
        "OVERWRITE_SETTING_SMTP_Port": str(_SMTP_PORT),
        "OVERWRITE_SETTING_SMTP_Protocol": "smtp",
        "OVERWRITE_SETTING_SMTP_IgnoreTLS": "true",
        "OVERWRITE_SETTING_SMTP_Username": "",
        "OVERWRITE_SETTING_SMTP_Password": "",
        "OVERWRITE_SETTING_From_Email": _FROM,
        "OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled": "true"
    }
    if verification:
        env["OVERWRITE_SETTING_Accounts_EmailVerification"] = "true"
    return env


def _mailpit_manifests():
    """The Mailpit workload and both of its in-cluster ports."""
    return _common._k8s_manifests(
        name="mailpit", image="docker.io/axllent/mailpit:v1.20",
        ports=[(_MAILPIT_WEB_PORT, 8025), (1025, 1025)],
        env={"MP_SMTP_AUTH_ACCEPT_ANY": "1", "MP_SMTP_AUTH_ALLOW_INSECURE": "1"},
        # Only the web UI is published to the host; SMTP is reached in-cluster by
        # Rocket.Chat, exactly as it is over the compose network.
        readiness={"httpGet": {"path": "/", "port": 8025},
                   "initialDelaySeconds": 3, "periodSeconds": 3,
                   "failureThreshold": 40},
        ui={"mailpit": (_MAILPIT_WEB_PORT, 8025)})


def build(params: dict) -> Preset:
    verification = _common.truthy_param(params, "verification")
    mailpit_url = f"http://localhost:{_MAILPIT_WEB_PORT}"
    return Preset(
        name="email",
        description=(
            "Mailpit mailcatcher wired to RC's SMTP. Every email RC sends — "
            "password resets, invites, verification, notification and 2FA mail — "
            f"is captured at {mailpit_url} instead of leaving the machine. "
            "Pair with --seed for users with verified emails."
        ),
        env=_smtp_settings(verification),
        services=_mailpit_service(),
        depends_on=["mailpit"],
        requires_license=False,
        source="built-in (dynamic)",
        params_help={
            "verification": "require email verification on new accounts (default false)",
        },
        extra={config.EXTRA_MAILPIT_URL: mailpit_url},
        ports=list(config.PRESET_PORTS["email"]),
        kubernetes_manifests=[_mailpit_manifests()],
        notes=[
            f"Mailpit (EVERY email RC sends, for ALL users, lands here): {mailpit_url}",
            "  — one shared inbox; tell users apart by the To: column.",
            "Quick SMTP check: Admin → Email → 'Send test email', then open Mailpit.",
            "Email-2FA is ON globally, but RC only enforces it on VERIFIED emails:",
            "  seeded users (alice/…) get the OTP flow (code in Mailpit); admin is",
            "  unverified so it logs in plain. houston's own token/api/seed calls",
            "  fetch any required code from Mailpit automatically.",
            "Seeded users (--seed) are created with verified emails, ready for 2FA.",
        ],
    )


register("email", build)
