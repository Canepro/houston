"""Creating, inspecting, changing and destroying a workspace.

The biggest module in the package, split into one module per subject under
`tools/move-table.json`'s reviewed map. This file is the COMPATIBILITY SURFACE and holds
no code of its own: `houston.services.lifecycle.detail` and the other 126 names still
resolve, because 139 call sites across `web/`, `cli/` and the other services reach them
that way and a decomposition is not the place to rewrite those.

**`__getattr__` deliberately does NOT cache, and that is load-bearing.**
`houston/cli/__init__.py` does the same lazy resolution and caches the result, because
nothing patches through it. Here the suite patches the OWNING module -- `monkeypatch`
on `lifecycle.naming.resolve_name` -- while production calls `lc.resolve_name(...)`, so
the façade has to re-resolve on every access or the patch is invisible to every caller
that came through here. Measured: with caching, a patch on the owner is not seen.

**Nothing in the suite may patch this module.** `monkeypatch.undo()` restores by writing
a REAL attribute into this module's dict, which permanently shadows `__getattr__` -- and
from then on a patch on the owning module is invisible to every later test in the
process. A guard test walks the suite and fails on any `setattr` against this façade.

**Two import shapes inside the package, and the difference is deliberate.** VALUES --
the dataclasses, the constants, and the `tuning` object -- are imported by name. Nothing
patches a name; the suite patches ATTRIBUTES on `tuning`, and that object is shared
however it is reached. FUNCTIONS are reached through their MODULE
(`naming.resolve_name(...)`), never imported by name: Python binds an imported function
into the importing module's globals, so a patch on `lifecycle.naming.resolve_name` would
be invisible to that caller -- and `resolve_name` alone is patched at 49 sites. A module
attribute is resolved at call time, which is also what TypeScript emits for a
cross-module call (`naming_1.resolveName()`), so it is the form the port needs anyway.
`tools/move_table.py --check` gates it.

**Lazy, not imported.** Importing `houston.services.lifecycle.naming` runs this file
first, and the submodules import each other -- so a static import here would close a
cycle. `tools/scc_check.py` gates it; `houston/cli/__init__.py` and
`houston/web/routes/__init__.py` are the same shape for the same reason.
"""
from __future__ import annotations

#: name -> the module that defines it. The map IS the decomposition; it is generated from
#: and checked against `tools/move-table.json` by `tools/move_table.py --check`.
_OWNER = {
    "CLUSTER_MB": "sizing",
    "CREATE_POLICY_KEY": "types",
    "CreatePlan": "create_docker",
    "CreateReq": "types",
    "DESTROY_POLICY_KEY": "types",
    "ENGINE_FLOOR_CPUS": "sizing",
    "ENGINE_FLOOR_MEMORY_GIB": "sizing",
    "ESSENTIAL_SERVICES": "types",
    "KUBE_CHART_MB": "sizing",
    "KubeCreate": "create_k8s",
    "MICROSERVICES_MB": "sizing",
    "MONITORING_MB": "sizing",
    "NAME_MAX": "naming",
    "PRESET_MB": "sizing",
    "PRIVILEGED_CREATE_FIELDS": "types",
    "PUBLISH_PROOF_PAUSE": "types",
    "PUBLISH_PROOF_TRIES": "types",
    "STATE_ACTIONS": "types",
    "TRANSIENT_STATES": "types",
    "WORKSPACE_MB": "sizing",
    "_BILLABLE_CONTEXT_PREFIXES": "types",
    "_BILLABLE_DISTRIBUTIONS": "types",
    "_BROWSER_HOST_PARAM": "types",
    "_INTERACTIVE_LOCK_WAIT": "types",
    "_KUBERNETES_UNSUPPORTED": "types",
    "_KubeTls": "types",
    "_LOOPBACK_BINDS": "types",
    "_NAME_RE": "naming",
    "_PORT_LOCK": "ports",
    "_PRESET_LINKS": "types",
    "_VALID_NAME_RE": "naming",
    "_attach_monitoring": "create_docker",
    "_bind_host_of": "payload",
    "_build_document": "create_docker",
    "_build_record": "create_docker",
    "_challenge_mode": "tlsplan",
    "_check_engine_floor": "sizing",
    "_claim_ports": "create_docker",
    "_clear_default_if": "state",
    "_clear_the_unfinished_note": "create_docker",
    "_compose_detail": "payload",
    "_crash_loop_tick": "ready",
    "_create_kubernetes": "create_k8s",
    "_create_repro_locked": "create_docker",
    "_create_under_the_lock": "create_docker",
    "_derive_for": "naming",
    "_derive_idp_host": "request",
    "_drop_the_edge_route": "destroy",
    "_env_rows": "payload",
    "_finish": "create_docker",
    "_forward_and_reach_notes": "notes",
    "_forward_gap": "inspect",
    "_guard_project_collision": "preconditions",
    "_how_to_work_with_it": "notes",
    "_install_the_ingress_machinery": "tlsplan",
    "_issue_certificate": "create_docker",
    "_k8s_build_record": "create_k8s",
    "_k8s_create_the_workspace": "create_k8s",
    "_k8s_finish": "create_k8s",
    "_k8s_plan_cluster": "create_k8s",
    "_k8s_plan_kube_tls": "create_k8s",
    "_k8s_plan_tls": "create_k8s",
    "_k8s_record_the_request": "create_k8s",
    "_k8s_resolve_pairing": "create_k8s",
    "_k8s_settle_addressing": "create_k8s",
    "_k8s_settle_name": "create_k8s",
    "_k8s_write_provisional_record": "create_k8s",
    "_k8s_write_record": "create_k8s",
    "_kube_overhead_mb": "sizing",
    "_kubernetes_detail": "payload",
    "_kubernetes_https_group": "notes",
    "_kubernetes_mongo_group": "notes",
    "_kubernetes_tls_plan": "tlsplan",
    "_load_preset": "create_docker",
    "_look_at_what_is_inside": "notes",
    "_missing_monitor_attach": "request",
    "_mongo_group_and_shared_notes": "notes",
    "_name_reaches": "tlsplan",
    "_needed_mb": "sizing",
    "_open_the_way_in": "notes",
    "_orphan_context": "pruning",
    "_owner_gate": "ownership",
    "_pick_challenge": "tlsplan",
    "_pick_host_port_locked": "ports",
    "_prepare_edge": "create_docker",
    "_probe_the_cluster": "tlsplan",
    "_prune_kubernetes": "pruning",
    "_publish_kubernetes_name": "tlsplan",
    "_readiness_failure": "ready",
    "_reclaim_cluster": "pruning",
    "_record_tls": "create_docker",
    "_recorded_local_host": "tlsplan",
    "_refuse_a_doomed_pod": "ready",
    "_refuse_a_foreign_edge": "create_docker",
    "_refuse_a_foreign_holder": "ready",
    "_refuse_a_name_that_will_not_reach": "tlsplan",
    "_refuse_for_capacity": "sizing",
    "_refuse_if_serving_without_a_database": "ready",
    "_refuse_unsupported_on_kubernetes": "preconditions",
    "_register_the_name": "create_docker",
    "_remove_each_workspace": "pruning",
    "_remove_one_workspace": "pruning",
    "_remove_the_cluster_side": "destroy",
    "_repair_the_port_forward": "ready",
    "_replace_existing": "create_docker",
    "_report_what_the_name_serves": "tlsplan",
    "_requested_bind_host": "request",
    "_require_the_compose_plugin": "preconditions",
    "_require_valid_name": "naming",
    "_resolve_axes": "create_docker",
    "_resolve_pairing": "create_docker",
    "_resolve_tls": "tlsplan",
    "_restore_route": "ready",
    "_reuse": "create_docker",
    "_route_kubernetes_name": "tlsplan",
    "_row_for": "inspect",
    "_saved_default_is_billable": "request",
    "_say_ready": "ready",
    "_say_what_is_left": "sizing",
    "_say_where_this_is_going": "request",
    "_seed_inline_locked": "seeding",
    "_set_state_kubernetes": "state",
    "_settle_name": "create_docker",
    "_shared_mongo_notes": "notes",
    "_since": "payload",
    "_start_the_edge": "create_docker",
    "_start_the_workspace": "create_docker",
    "_stop_port_forward": "ready",
    "_stop_the_forwards": "destroy",
    "_summary": "inspect",
    "_sweep_orphan_namespaces": "pruning",
    "_teardown_compose": "destroy",
    "_teardown_kubernetes": "destroy",
    "_tls_from_record": "tlsplan",
    "_unknown_params": "request",
    "_up": "ready",
    "_uptime_health": "inspect",
    "_wait_serving_kubernetes": "ready",
    "_warn_about_services_with_no_endpoints": "ready",
    "_warn_about_the_bind": "create_docker",
    "_warn_about_the_browser_host": "create_docker",
    "_warn_name_coerced": "naming",
    "_will_provision": "request",
    "capacity": "sizing",
    "check_capacity": "sizing",
    "check_monitor_ports": "ports",
    "check_seed": "seeding",
    "check_sidecar_ports": "ports",
    "check_state_request": "preconditions",
    "check_teardown_request": "preconditions",
    "compose_note_groups": "notes",
    "create_repro": "create_docker",
    "degraded_reason": "inspect",
    "derive_name": "naming",
    "describe": "inspect",
    "detail": "payload",
    "finalize": "ready",
    "flatten_notes": "notes",
    "host_reserve_mb": "sizing",
    "infer_runtime": "request",
    "kubernetes_note_groups": "notes",
    "kubernetes_state": "inspect",
    "list_repros": "inspect",
    "local_url_note": "notes",
    "login": "admin",
    "may_chown": "ownership",
    "may_destroy": "ownership",
    "may_set_privileged_fields": "ownership",
    "name_candidates": "naming",
    "note_group": "notes",
    "note_groups_of": "notes",
    "orphan_namespaces": "pruning",
    "own_ports": "ports",
    "owner_of": "ownership",
    "owner_prefix": "naming",
    "pick_host_port": "ports",
    "prunable": "pruning",
    "prune": "pruning",
    "reachable_beyond_loopback": "preconditions",
    "repro_links": "inspect",
    "repro_state": "inspect",
    "req_context": "request",
    "require_docker": "preconditions",
    "require_engine": "preconditions",
    "resolve_name": "naming",
    "run_seed_inline": "seeding",
    "runtime_cost": "sizing",
    "sanitize": "naming",
    "scenario_group": "notes",
    "set_owner": "ownership",
    "set_state": "state",
    "teardown": "destroy",
    "tuning": "types",
    "unsupported_fields": "preconditions",
    "wait_and_finalize": "ready",
    "wait_serving": "ready",
}


#: Names the single-file module happened to expose because it imported them, and that
#: the suite reaches through this façade: `lc.runner.exists`, `lc.null_emit`, and so on.
#: 213 sites, and every one of them is an alias for something that lives elsewhere --
#: patching `lc.runner` was always patching `houston.runner` itself, from wherever.
#:
#: Kept rather than re-pointed, deliberately. Re-pointing 213 sites buys nothing: the
#: object reached is identical either way, and a patch applied to it is seen by every
#: caller. What re-pointing WOULD buy is 213 opportunities for a patch to land somewhere
#: that no longer matters, which is the one failure mode this phase cannot see.
#:
#: `module:attribute` resolves the attribute; a bare dotted path resolves the module.
_ALIAS = {
    "auditsvc": "houston.services.audit",
    "config": "houston.config",
    "edgesvc": "houston.services.edge",
    "rcapi": "houston.rcapi",
    "runner": "houston.runner",
    "topology": "houston.services.topology",
    "versions": "houston.versions",
    "null_emit": "houston.services.events:null_emit",
    "redact_env": "houston.services.redact:redact_env",
    "REDACTED": "houston.services.redact:REDACTED",
}


def __getattr__(name: str):
    """Resolve a name from the module that owns it, on EVERY access.

    Never cached. See the module docstring: a cached value is a value that stops seeing
    the patches the suite applies to the owning module.
    """
    from importlib import import_module

    owner = _OWNER.get(name)
    if owner is not None:
        return getattr(import_module(f"{__name__}.{owner}"), name)
    # A SUBMODULE BY NAME. `lc.naming` is how the suite reaches the module that defines
    # a symbol in order to patch it -- `monkeypatch.setattr(lc.naming, "resolve_name",
    # ...)` -- and resolving it here means no test file has to grow an import to say so.
    # Python would bind the submodule as an attribute anyway once something imported it;
    # this only makes it true from the first access rather than from an accident of
    # ordering.
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
