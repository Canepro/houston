"""The only Docker seam: on-disk state, compose invocation, host ports and the lock.

Split by phase 02b step 2b.15 under `tools/move-table.json`'s reviewed map, into
tiers that cannot import upward:

    * `cache` (tier 0)
    * `locks` (tier 0)
    * `paths` (tier 0)
    * `engine` (tier 1)
    * `record` (tier 1)
    * `host` (tier 2)
    * `ports` (tier 2)
    * `queries` (tier 2)

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
    "Metadata": "record",
    "PORT_MAX": "ports",
    "_DOCKER_TTL": "host",
    "_HELD": "locks",
    "_META_FIELDS": "record",
    "_QUERY_TTL": "cache",
    "_THREAD_LOCKS": "locks",
    "_THREAD_LOCKS_GUARD": "locks",
    "_acquire_process_locks": "locks",
    "_acquire_thread_lock": "locks",
    "_cached_query": "cache",
    "_compose": "engine",
    "_compose_ls": "queries",
    "_docker_lock": "host",
    "_docker_seen": "host",
    "_first_line": "engine",
    "_held_names": "locks",
    "_mutating": "engine",
    "_query_cache": "cache",
    "_query_lock": "cache",
    "_restrict": "paths",
    "_services_by_project_uncached": "queries",
    "_thread_lock_for": "locks",
    "atomic_write": "paths",
    "compose_exec": "engine",
    "compose_exec_capture": "engine",
    "compose_exec_from_file": "engine",
    "compose_exec_to_file": "engine",
    "compose_logs_capture": "engine",
    "compose_pull_capture": "engine",
    "compose_standalone_version": "host",
    "compose_stream": "engine",
    "compose_version": "host",
    "container_details": "queries",
    "container_ids": "engine",
    "docker": "engine",
    "docker_available": "host",
    "docker_capacity": "host",
    "docker_kernel_version": "host",
    "docker_server_version": "host",
    "docker_stats": "queries",
    "down": "engine",
    "exists": "paths",
    "host_memory": "host",
    "hub_logged_in": "host",
    "invalidate_docker_queries": "cache",
    "list_meta": "record",
    "logs": "engine",
    "mint_project_name": "paths",
    "pick_port": "ports",
    "pick_port_range": "ports",
    "port_free": "ports",
    "project_config_files": "queries",
    "project_name": "record",
    "project_states": "queries",
    "ps": "engine",
    "rc_container_env": "queries",
    "rc_restart_count": "queries",
    "rc_services": "record",
    "rc_state": "queries",
    "rc_status_by_project": "queries",
    "read_compose": "record",
    "read_meta": "record",
    "recorded": "record",
    "remove": "paths",
    "remove_volumes": "queries",
    "repro_lock": "locks",
    "restart": "engine",
    "rm_services": "engine",
    "service_container_ids": "engine",
    "services_by_project": "queries",
    "start": "engine",
    "start_services": "engine",
    "stop": "engine",
    "stop_services": "engine",
    "up": "engine",
    "update_meta": "record",
    "used_ports": "ports",
    "workspace": "paths",
    "write": "record",
    "write_record": "record",
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
