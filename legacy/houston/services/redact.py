"""Credential redaction shared by services, with no Houston dependencies."""

from __future__ import annotations

import re


_SECRET_KEY_HINTS = ("password", "pass", "secret", "token", "_key", "apikey",
                     "credential")
REDACTED = "********"

# A credential embedded in a URL: `scheme://user:password@host`. This must inspect
# values because names such as MONGO_URL reveal nothing about the embedded secret.
_URL_USERINFO = re.compile(r"([a-zA-Z][a-zA-Z0-9+.\-]*://[^/\s:@]+):([^/\s@]+)@")


def redact_env(key: str, value: str) -> str:
    """Mask credentials named by their key or embedded in URL userinfo."""
    low = key.lower()
    if value and any(h in low for h in _SECRET_KEY_HINTS):
        return REDACTED
    return _URL_USERINFO.sub(rf"\1:{REDACTED}@", value or "")
