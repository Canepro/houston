"""Contract tests for dynamic preset ownership and registration."""

from __future__ import annotations

from houston import presets
from houston.presets.registry import REGISTRY, Preset


def test_dynamic_builders_register_with_the_leaf_registry() -> None:
    builders = presets._dynamic_builders()

    assert set(builders) == {
        "email", "ldap", "livechat", "multi-instance", "oidc", "s3_minio", "saml",
    }
    assert builders == REGISTRY
    assert presets.Preset is Preset
