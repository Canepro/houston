"""`services/lifecycle` as a package: the façade, the tier-0 leaves, and the patch rule.

`lifecycle.py` was 2,328 code lines and 127 top-level symbols, reached as `lc.<name>` from
139 places in `web/`, `cli/` and the other services, and patched at 221 sites in the
suite. Splitting it therefore has to preserve two things that were free while it was one
file:

* **Every name still resolves.** `houston.services.lifecycle.detail` is an import in
  production code, not just a test convenience, and a name that quietly stops resolving
  is an `AttributeError` in a route.
* **A patch still reaches the caller.** Patching a module attribute only affects a caller
  that resolves through that same module. While there was one module, the façade and the
  definition were the same object; they are not any more, and the failure is silent — the
  test goes green over the real function.

The second one is why `__getattr__` here does not cache and why nothing may patch the
façade. Both are asserted below, and the cross-test half of it is asserted in
`tests/test_frozen.py`, which walks the whole suite.
"""

from __future__ import annotations

import ast
import json
import pathlib

import pytest

from houston.services import lifecycle as lc
from houston.services.lifecycle import (admin, create_docker, create_k8s, destroy,
                                        inspect, naming, notes, ownership, payload,
                                        ports, preconditions, pruning, ready, request,
                                        seeding, sizing, state, tlsplan, types)

#: The modules extracted so far, and the tier each was assigned. Read from the reviewed
#: map rather than restated here, so a module that moves tier cannot leave this test
#: agreeing with a plan nobody is following any more.
TIERS = {k: v for k, v in json.loads(
    (pathlib.Path(__file__).parent.parent / "tools" / "move-table.json").read_text(
        encoding="utf-8"))["modules"]["houston/services/lifecycle.py"]["tiers"].items()}
EXTRACTED = (types, naming, admin, sizing, request, ports, ownership,
             preconditions, notes, inspect, payload, tlsplan, seeding, ready,
             state, destroy, pruning, create_docker, create_k8s)


#: The 127 top-level names `houston/services/lifecycle.py` exported on the commit before
#: it became a package (`git show af881c1^:houston/services/lifecycle.py`). This is a
#: FROZEN SURFACE, not a count: 139 call sites across `web/`, `cli/` and the other
#: services read them off the façade, and a count passes just as happily if one is
#: dropped and another added. The decomposition adds internal names -- steps, plans --
#: and those are free to come and go; these are not.
EXPORTED_BY_THE_SINGLE_FILE = (
    "CLUSTER_MB", "CREATE_POLICY_KEY", "CreateReq", "DESTROY_POLICY_KEY",
    "ENGINE_FLOOR_CPUS", "ENGINE_FLOOR_MEMORY_GIB", "ESSENTIAL_SERVICES",
    "KUBE_CHART_MB", "MICROSERVICES_MB", "MONITORING_MB", "NAME_MAX", "PRESET_MB",
    "PRIVILEGED_CREATE_FIELDS", "PUBLISH_PROOF_PAUSE", "PUBLISH_PROOF_TRIES",
    "STATE_ACTIONS", "TRANSIENT_STATES", "WORKSPACE_MB", "_BILLABLE_CONTEXT_PREFIXES",
    "_BILLABLE_DISTRIBUTIONS", "_BROWSER_HOST_PARAM", "_INTERACTIVE_LOCK_WAIT",
    "_KUBERNETES_UNSUPPORTED", "_KubeTls", "_LOOPBACK_BINDS", "_NAME_RE", "_PORT_LOCK",
    "_PRESET_LINKS", "_VALID_NAME_RE", "_bind_host_of", "_check_engine_floor",
    "_clear_default_if", "_create_kubernetes", "_create_repro_locked", "_derive_for",
    "_derive_idp_host", "_env_rows", "_forward_gap", "_guard_project_collision",
    "_kube_overhead_mb", "_kubernetes_https_group", "_kubernetes_tls_plan",
    "_missing_monitor_attach", "_name_reaches", "_orphan_context", "_owner_gate",
    "_pick_challenge", "_pick_host_port_locked", "_publish_kubernetes_name",
    "_readiness_failure", "_reclaim_cluster", "_recorded_local_host",
    "_refuse_unsupported_on_kubernetes", "_requested_bind_host", "_require_valid_name",
    "_resolve_tls", "_restore_route", "_reuse", "_route_kubernetes_name",
    "_saved_default_is_billable", "_say_ready", "_say_where_this_is_going",
    "_seed_inline_locked", "_set_state_kubernetes", "_since", "_stop_port_forward",
    "_summary", "_tls_from_record", "_unknown_params", "_up", "_uptime_health",
    "_wait_serving_kubernetes", "_warn_name_coerced", "_will_provision", "capacity",
    "check_capacity", "check_monitor_ports", "check_seed", "check_sidecar_ports",
    "check_state_request", "check_teardown_request", "compose_note_groups",
    "create_repro", "degraded_reason", "derive_name", "describe", "detail", "finalize",
    "flatten_notes", "host_reserve_mb", "infer_runtime", "kubernetes_note_groups",
    "kubernetes_state", "list_repros", "local_url_note", "login", "may_chown",
    "may_destroy", "may_set_privileged_fields", "name_candidates", "note_group",
    "note_groups_of", "orphan_namespaces", "own_ports", "owner_of", "owner_prefix",
    "pick_host_port", "prunable", "prune", "reachable_beyond_loopback", "repro_links",
    "repro_state", "req_context", "require_docker", "require_engine", "resolve_name",
    "run_seed_inline", "runtime_cost", "sanitize", "scenario_group", "set_owner",
    "set_state", "teardown", "tuning", "unsupported_fields", "wait_and_finalize",
    "wait_serving",
)


def test_every_name_the_single_file_exported_still_resolves():
    """127 symbols, and a missing one is an AttributeError in a route rather than here."""
    missing = []
    for name in EXPORTED_BY_THE_SINGLE_FILE:
        try:
            getattr(lc, name)
        except AttributeError as exc:
            missing.append(f"{name}: {exc}")
    assert not missing, missing
    assert len(EXPORTED_BY_THE_SINGLE_FILE) == 127
    # And every one is still OWNED, rather than reaching a module alias by accident.
    unowned = [n for n in EXPORTED_BY_THE_SINGLE_FILE
               if n not in lc._OWNER and n not in lc._ALIAS]
    assert not unowned, unowned


def test_the_facade_resolves_module_aliases_the_single_file_happened_to_expose():
    """`lc.runner` was `houston.runner` because the module imported it. 213 sites in the
    suite reach the aliases that way, and every one of them means the real module."""
    from houston import rcapi, runner
    from houston.services import audit, edge, topology

    assert lc.runner is runner and lc.rcapi is rcapi and lc.topology is topology
    assert lc.auditsvc is audit and lc.edgesvc is edge
    assert lc.REDACTED and callable(lc.redact_env) and callable(lc.null_emit)


def test_the_facade_resolves_its_own_submodules_by_name():
    """So a test can say `lc.naming` without importing it — which is what keeps a
    mechanical re-point from growing four already-over-cap test files."""
    assert lc.naming is naming and lc.sizing is sizing and lc.pruning is pruning


def test_the_facade_never_caches_so_a_patch_on_the_owner_is_seen(monkeypatch):
    """139 production call sites read `lc.<name>`; the suite patches the owning module.

    With a caching `__getattr__` — which is what `houston/cli/__init__.py` does, because
    nothing patches through it — the first read freezes the original function and every
    later patch is invisible. Measured before this was written.
    """
    original = lc.resolve_name
    monkeypatch.setattr(naming, "resolve_name", lambda *a, **k: "patched")
    assert lc.resolve_name("anything") == "patched"
    monkeypatch.undo()
    assert lc.resolve_name is not None and lc.resolve_name.__module__ == original.__module__


def test_an_unknown_name_is_an_attribute_error_not_an_import_error():
    with pytest.raises(AttributeError, match="no attribute 'not_a_symbol'"):
        lc.not_a_symbol


@pytest.mark.parametrize("module", EXTRACTED,
                         ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_an_extracted_module_never_imports_a_higher_tier(module):
    """The tiers are the acyclic order the split is executed in: tier 0 is what every
    other module may reach, and each one after it may only reach downward or sideways.
    An upward import is the cycle phase 1 spent ten cuts removing, re-created.

    `--check` proves this of the PLAN, from the call graph of the file still to be split.
    This proves it of the TREE, from the import statements that actually exist — the two
    disagree exactly when an extraction was done differently from how it was planned.
    """
    own = TIERS[module.__name__.rsplit(".", 1)[-1]]
    tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
    reaches = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        if (node.module or "") == "houston.services.lifecycle":
            targets = [a.name for a in node.names]          # `from . import naming`
        elif (node.module or "").startswith("houston.services.lifecycle."):
            targets = [node.module.rsplit(".", 1)[-1]]      # `from .types import X`
        else:
            continue
        reaches += [f"{t} (tier {TIERS[t]})" for t in targets
                    if t in TIERS and TIERS[t] > own]
    assert not reaches, f"{module.__name__} (tier {own}) imports upward: {reaches}"


def test_every_extracted_module_is_reachable_through_the_facade():
    """A module nothing imports is a module no failure will ever point at. The façade
    resolving it by name is what lets a test patch it without growing an import, so if
    that stops working the re-pointer's output stops landing — silently."""
    for module in EXTRACTED:
        name = module.__name__.rsplit(".", 1)[-1]
        assert getattr(lc, name) is module, f"lc.{name} is not the module"


def test_a_precondition_reaches_the_owner_gate_through_its_module(monkeypatch):
    """2b.2's instance of the package convention. `check_teardown_request` refuses on
    `may_destroy`; the two are in different modules now, so the call has to be a
    module-attribute lookup or a test patching `ownership.may_destroy` goes green over
    the real gate — which is a test that no longer proves anybody is refused."""
    monkeypatch.setattr(ownership, "may_destroy", lambda name, actor: (False, "nope"))
    src = pathlib.Path(preconditions.__file__).read_text(encoding="utf-8")
    assert "ownership.may_destroy(" in src
    assert "\n    may_destroy(" not in src, "called by a bare name, so a patch misses"


def test_check_capacity_reaches_will_provision_through_its_module(monkeypatch):
    """The package's convention, and the reason it exists: a cross-module call is a
    module-attribute lookup at call time, so a patch on the owning module lands.

    It is also what TypeScript emits for the same call (`request_1._willProvision()`),
    which is the property FINDINGS §3 says the whole decomposition is for.
    """
    seen = []
    monkeypatch.setattr(request, "_will_provision",
                        lambda req: seen.append(req) or False)
    src = pathlib.Path(sizing.__file__).read_text(encoding="utf-8")
    assert "request._will_provision(" in src
    assert "\n    _will_provision(" not in src, "called by a bare name, so a patch misses"


def test_the_unsplit_remainder_is_gone_and_stays_gone():
    """Step 2b.5 emptied it and deleted it. `lifecycle` is eighteen modules and a façade.

    The file was named `_unsplit` so nobody could mistake it for a home, and the test
    that used to live here asserted it was shrinking. This is the other end of that: a
    module reappearing under that name means somebody put code back rather than deciding
    where it goes.
    """
    package = pathlib.Path(lc.__file__).parent
    assert not (package / "_unsplit.py").exists(), \
        "the remainder is back; every symbol has a home in the map"
    modules = sorted(p.stem for p in package.glob("*.py") if p.stem != "__init__")
    assert len(modules) == len(EXTRACTED), (modules, len(EXTRACTED))
    assert modules == sorted(m.__name__.rsplit(".", 1)[-1] for m in EXTRACTED)
    # And the façade still holds no code of its own.
    body = pathlib.Path(lc.__file__).read_text(encoding="utf-8")
    assert "def __getattr__" in body and "def __dir__" in body
    assert body.count("\ndef ") == 2, "the façade grew a function of its own"
