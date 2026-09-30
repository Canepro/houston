"""`houston.presets._keycloak`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

import json


def test_keycloak_shared_scaffolding():
    from houston.presets import _keycloak
    us = _keycloak.users(2)
    assert [u["username"] for u in us] == ["user1", "user2"]
    # saml shape: publish host port -> Keycloak's default 8080
    svc = _keycloak.service("./x/realm.json", 8081)
    assert svc["ports"] == ["8081:8080"]
    assert "KC_HTTP_PORT" not in svc["environment"]
    # oidc shape: same port inside and out (single keycloak:<port> URL)
    svc2 = _keycloak.service("./x/realm.json", 8085, http_port=8085)
    assert svc2["ports"] == ["8085:8085"]
    assert svc2["environment"]["KC_HTTP_PORT"] == "8085"
    realm = json.loads(_keycloak.realm_json([{"clientId": "c"}], 2))
    assert realm["realm"] == "houston" and len(realm["users"]) == 2


def test_keycloak_believes_a_proxys_forwarded_scheme():
    """Keycloak builds ABSOLUTE urls for its assets, its issuer and every OIDC
    endpoint, derived from the connection it can see -- plain http on a published
    port. Reached through anything that terminates TLS in front (an iximiuz lab
    forward, Codespaces, ngrok), that serves an https PAGE asking for http
    RESOURCES and the browser blocks all of them:

        Mixed Content: the page at 'https://<host>/admin/master/console/' was
        loaded over HTTPS, but requested an insecure resource
        'http://<host>/resources/master/admin/en'.

    The console renders blank and the container log says nothing, because the
    failure is entirely in the browser. Measured against keycloak:26.0 with one
    request carrying X-Forwarded-Proto/-Host:

        without : issuer http://127.0.0.1:18085/realms/master
        with    : issuer https://lab.example.com/realms/master

    Both IdP presets share this scaffolding, so both get it.
    """
    from houston.presets import _keycloak
    for kwargs in ({}, {"http_port": 8085}):
        env = _keycloak.service("./x/realm.json", 8081, **kwargs)["environment"]
        # KC_PROXY_HEADERS, not KC_PROXY: `proxy` was deprecated in Keycloak 24 and
        # REMOVED in 26, which is the version this preset pins.
        assert env["KC_PROXY_HEADERS"] == "xforwarded"
        assert "KC_PROXY" not in env
    assert _keycloak.KC_IMAGE.startswith("quay.io/keycloak/keycloak:26"), \
        "KC_PROXY_HEADERS is the Keycloak 26 spelling — recheck it on a major bump"
