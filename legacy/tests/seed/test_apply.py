"""`houston.seed.apply`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

from houston import seed


def test_seed_restores_only_the_2fa_value_it_changed(monkeypatch):
    # "Unreadable" is not "was on". Restoring ON for both turned email-2FA on for
    # the ldap/saml/oidc/livechat presets, which switch it OFF on purpose.
    prior = [None]
    calls = []

    def fake_get(_url, _auth, _pw, sid, **_kw):
        return {"Accounts_TwoFactorAuthentication_By_Email_Enabled": prior[0],
                "API_Enable_Rate_Limiter": False}.get(sid)

    def fake_set(_url, _auth, _pw, sid, value, **_kw):
        calls.append((sid, value))
        return True

    monkeypatch.setattr(seed.rcapi, "get_setting", fake_get)
    monkeypatch.setattr(seed.rcapi, "set_setting", fake_set)
    monkeypatch.setattr(seed.apply, "_seed_body", lambda *_a, **_k: {"ok": True})
    twofa = "Accounts_TwoFactorAuthentication_By_Email_Enabled"
    auth = seed.rcapi.Auth(token="t", user_id="u")

    cases = [
        (None, []),                                 # unreadable -> don't touch it
        (False, []),                                # already off -> leave it
        (True, [(twofa, False), (twofa, True)]),     # on -> disable, then restore
    ]
    for prior_value, expected in cases:
        prior[0] = prior_value
        calls.clear()
        seed.seed("http://x", auth, seed.PROFILES["small"])
        assert [c for c in calls if c[0] == twofa] == expected, prior_value
