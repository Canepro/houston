"""One Traefik edge for the whole box: TLS, routes, and the networks it joins.

Split by phase 02b step 2b.15 under `tools/move-table.json`'s reviewed map, into
tiers that cannot import upward:

    * `paths` (tier 0)
    * `types` (tier 0)
    * `engine` (tier 1)
    * `acme` (tier 2)
    * `networks` (tier 2)
    * `routeyml` (tier 3)
    * `spec` (tier 4)
    * `routes` (tier 5)
    * `runtime` (tier 6)

This file is the COMPATIBILITY SURFACE and holds no code of its own. Its
`__getattr__` deliberately does NOT cache: the suite patches the OWNING module
while production reads the façade, so a cached value is a value that stops seeing
the patch. Nothing in the suite may patch this module -- `monkeypatch.undo()`
restores by writing a REAL attribute here, which permanently shadows
`__getattr__` for every later test in the process.
"""
from __future__ import annotations

#: name -> the module that defines it, generated from the CURRENT tree by
#: `tools/move_table.py --sync-facade` and gated by `--check`.
_OWNER = {
    "CONTAINER": "paths",
    "DYNAMIC_DIR": "paths",
    "EDGE_DIR": "paths",
    "Edge": "types",
    "PROJECT": "paths",
    "SPEC_FILE": "paths",
    "StartResult": "types",
    "UNIT_PATH": "paths",
    "_ADDR_RE": "paths",
    "_RULE_HOST": "paths",
    "_acme_names": "acme",
    "_acme_read": "acme",
    "_adopt_legacy_port_holders": "runtime",
    "_compose": "engine",
    "_compose_capture": "engine",
    "_delete_host_files": "runtime",
    "_docker": "engine",
    "_prepare_edge": "runtime",
    "_restart_after_acme_delete": "runtime",
    "_route_yml": "routeyml",
    "_traefik_command": "spec",
    "_validate_host_deletion": "runtime",
    "_why": "runtime",
    "acme_failure": "acme",
    "acme_hosts": "acme",
    "acme_stores": "acme",
    "adopt": "runtime",
    "attach": "networks",
    "attach_network": "networks",
    "attached_networks": "networks",
    "backend_container": "networks",
    "bridge_address": "engine",
    "certs_dir": "paths",
    "compose_doc": "spec",
    "compose_path": "paths",
    "config_drift": "spec",
    "container_addresses": "networks",
    "container_network": "networks",
    "current": "spec",
    "delete_host": "runtime",
    "deregister": "routes",
    "detach": "networks",
    "down": "engine",
    "dynamic_dir": "paths",
    "edge_dir": "paths",
    "ensure_running": "runtime",
    "foreign_edge": "engine",
    "forget_acme": "acme",
    "gui_route_yml": "routeyml",
    "has_acme": "acme",
    "holders_of_443": "engine",
    "host_owner": "routes",
    "installed": "spec",
    "is_passthrough": "routes",
    "issue_local_cert": "acme",
    "logs": "runtime",
    "orphan_certs": "acme",
    "our_container": "engine",
    "passthrough_route_yml": "routeyml",
    "port_holder": "engine",
    "publishes_ports": "engine",
    "reattach_all": "routes",
    "register": "routes",
    "registered": "routes",
    "route_host": "routes",
    "route_path": "paths",
    "route_reachable": "routes",
    "routes_for": "routes",
    "running": "engine",
    "served_domain": "spec",
    "status": "runtime",
    "systemd_unit": "runtime",
    "up": "runtime",
    "workspace_network": "networks",
    "workspace_route_yml": "routeyml",
    "write": "spec",
}

_ALIAS: dict[str, str] = {}


def __getattr__(name: str):
    """Resolve a name from the module that owns it, on EVERY access."""
    from importlib import import_module

    owner = _OWNER.get(name)
    if owner is not None:
        return getattr(import_module(f"{__name__}.{owner}"), name)
    if name in set(_OWNER.values()):
        return import_module(f"{__name__}.{name}")
    target = _ALIAS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module, _, attribute = target.partition(":")
    resolved = import_module(module)
    return getattr(resolved, attribute) if attribute else resolved


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_OWNER) | set(_ALIAS) | set(_OWNER.values()))
