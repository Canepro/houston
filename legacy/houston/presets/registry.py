"""Leaf registry shared by the preset catalog and dynamic builders."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from importlib import import_module


@dataclass
class Preset:
    """Resolved scenario shared by the loader, Compose, and Kubernetes adapters.

    ``topology`` is empty for portable presets. ``scenario`` and
    ``scenario_params`` retain built-in adapter provenance; they are not persisted.
    ``kubernetes_manifests`` contains concrete backing resources, while ``env`` is
    shared by both runtimes. ``error`` is populated only by unreadable catalog rows.
    """

    name: str
    description: str = ""
    env: dict[str, str] = field(default_factory=dict)
    services: dict[str, dict] = field(default_factory=dict)
    rocketchat: dict = field(default_factory=dict)
    depends_on: list[str] = field(default_factory=list)
    requires_license: bool = False
    source: str = "built-in"
    files: list[tuple[str, str]] = field(default_factory=list)
    params_help: dict[str, str] = field(default_factory=dict)
    post_ready: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    instances: int = 1
    entry_service: str = ""
    extra: dict = field(default_factory=dict)
    volumes: dict = field(default_factory=dict)
    ports: list[int] = field(default_factory=list)
    topology: str = ""
    scenario: str = ""
    scenario_params: dict = field(default_factory=dict)
    kubernetes_manifests: list[str] = field(default_factory=list)
    error: str = ""


Builder = Callable[[dict], Preset]
REGISTRY: dict[str, Builder] = {}
SCENARIOS: dict[str, object] = {}
_MODULES = {
    "email": "email", "ldap": "ldap", "livechat": "livechat",
    "multi_instance": "multi-instance", "oidc": "oidc",
    "s3_minio": "s3_minio", "saml": "saml",
}


def register(name: str, builder: Builder) -> None:
    """Register the builder owned by a dynamic preset module."""
    if name in REGISTRY:
        raise ValueError(f"preset builder {name!r} is already registered")
    REGISTRY[name] = builder


def register_scenario(name: str, scenario: object) -> None:
    """Register the scenario adapter owned by a dynamic preset module."""
    if name in SCENARIOS:
        raise ValueError(f"preset scenario {name!r} is already registered")
    SCENARIOS[name] = scenario


def builders() -> dict[str, Builder]:
    """Import each owner once, allowing it to register its own builder."""
    for module in _MODULES:
        import_module(f"houston.presets.{module}")
    missing = set(_MODULES.values()) - REGISTRY.keys()
    if missing:
        raise RuntimeError(f"preset modules did not register builders: {sorted(missing)}")
    return dict(REGISTRY)


def scenarios() -> dict[str, object]:
    """Return scenario adapters after their owner modules have registered."""
    builders()
    return dict(SCENARIOS)
