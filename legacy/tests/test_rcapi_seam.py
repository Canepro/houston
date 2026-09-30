"""Portable object-property contracts for the Rocket.Chat REST seam."""

from houston import rcapi


def test_the_rest_seam_is_a_live_exported_property(monkeypatch):
    seen = []

    def fake_call(*args, **kwargs):
        seen.append((args, kwargs))
        return 202, "accepted"

    monkeypatch.setattr(rcapi.rcapi, "call", fake_call)

    assert rcapi.rcapi.call("http://rc", "GET", "/api/info") == (202, "accepted")
    assert seen == [(('http://rc', 'GET', '/api/info'), {})]
