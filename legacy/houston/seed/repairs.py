"""repairs -- see the package docstring."""
from __future__ import annotations

from houston import config, rcapi, runner
from houston.seed_profiles import PROFILES as PROFILES
from houston.seed_profiles import Shape as Shape
from houston.services import journal


def _repair_setting(entry, _emit, login, setting: str) -> bool:
    if login is None:
        return False
    meta = runner.read_meta(entry.workspace)
    auth = login(meta)
    return bool(auth and rcapi.set_setting(meta.root_url, auth, meta.admin_pass,
                                           setting, True))

def _repair_rate_limiter(entry, emit, login) -> bool:
    return _repair_setting(entry, emit, login, config.RC_RATE_LIMITER_SETTING)

def _repair_email_2fa(entry, emit, login) -> bool:
    return _repair_setting(entry, emit, login, journal.EMAIL_2FA_SETTING)

def install_journal_repairs() -> None:
    journal.register_repair(journal.RATE_LIMITER_OFF, _repair_rate_limiter)
    journal.register_repair(journal.EMAIL_2FA_OFF, _repair_email_2fa)
