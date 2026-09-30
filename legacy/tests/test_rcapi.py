"""`houston.rcapi`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

from houston import rcapi


def test_email_otp_extraction():
    assert rcapi._extract_otp("Your login code is 428913, valid 5 min.") == "428913"
    assert rcapi._extract_otp("<b>042891</b>") == "042891"
    assert rcapi._extract_otp("order #12345678 shipped") is None   # not 6 digits
    assert rcapi._extract_otp("") is None


def test_email_otp_recipient_filter():
    # Mailpit is a catch-all inbox — the fetcher must only match the right user.
    msg = {"To": [{"Address": "Alice@Example.com"}]}
    assert rcapi._addressed_to(msg, "alice@example.com")       # case-insensitive
    assert not rcapi._addressed_to(msg, "admin@example.com")   # other user's mail
    assert rcapi._addressed_to(msg, None)                      # no filter -> any


def test_login_refuses_an_unfiltered_otp_poll(monkeypatch):
    from houston import rcapi

    class _R:
        status_code, ok = 401, False
        text = '{"error":"totp-required"}'

        def json(self):
            return {}

    monkeypatch.setattr(rcapi.requests, "post", lambda *_a, **_k: _R())
    # Mailpit is a catch-all inbox; with no resolvable recipient the old code
    # polled unfiltered and could hand back a DIFFERENT user's code.
    try:
        rcapi.login("http://x", "alice", "alice", mailpit_url="http://mailpit")
    except RuntimeError as exc:
        assert "another user's code" in str(exc)
    else:
        raise AssertionError("expected a refusal rather than an unfiltered poll")


def test_login_rejects_a_non_200_success_status(monkeypatch):
    from houston import rcapi

    class _R:
        status_code, ok = 302, True             # proxy redirect to HTTPS
        text = "<html>Found</html>"

        def json(self):
            return {}

        def raise_for_status(self):
            return None                          # no-op for 3xx, as requests does

    monkeypatch.setattr(rcapi.requests, "post", lambda *_a, **_k: _R())
    try:
        rcapi.login("http://x")
    except RuntimeError as exc:
        assert "302" in str(exc) and "2FA" in str(exc)
    else:
        raise AssertionError("expected a clear error, not the misleading 2FA path")
