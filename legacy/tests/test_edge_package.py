"""`services/edge/` as a package: the façade, the tiers, and the three judgement calls.

TLS is a runtime property here, not a build-time one — one Traefik holds :80 and :443 for
the whole box, and a workspace gains or loses HTTPS by a route file appearing. So the
layering matters more than usual: `routeyml` builds what a route IS, `routes` decides
which exist, and `runtime` is the only tier allowed to start or stop anything.
"""
from __future__ import annotations

import ast
import json
import pathlib

from houston.services import edge
from houston.services.edge import (acme, engine, networks, paths, routes, routeyml,
                                   runtime, spec, types)

TIERS = json.loads(
    (pathlib.Path(__file__).parent.parent / "tools" / "move-table.json").read_text(
        encoding="utf-8"))["modules"]["houston/services/edge.py"]["tiers"]
EXTRACTED = (paths, types, engine, acme, networks, routeyml, spec, routes, runtime)


def test_every_module_is_reachable_through_the_facade():
    for module in EXTRACTED:
        name = module.__name__.rsplit(".", 1)[-1]
        assert getattr(edge, name) is module, f"edge.{name} is not the module"
    assert sorted(TIERS) == sorted(m.__name__.rsplit(".", 1)[-1] for m in EXTRACTED)


def test_no_module_imports_a_higher_tier():
    """Read from the TREE, not the plan. The first grouping of this module had SIX
    cycles, and every one was a misfiled symbol rather than a real knot."""
    aliases = {"edge_routes": "routes", "edge_spec": "spec"}
    for module in EXTRACTED:
        own = TIERS[module.__name__.rsplit(".", 1)[-1]]
        tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            if (node.module or "") == "houston.services.edge":
                targets = [aliases.get(a.asname or a.name, a.name) for a in node.names]
            elif (node.module or "").startswith("houston.services.edge."):
                targets = [node.module.rsplit(".", 1)[-1]]
            else:
                continue
            for t in targets:
                assert t not in TIERS or TIERS[t] <= own, (
                    f"{module.__name__} (tier {own}) imports {t} (tier {TIERS[t]})")


def test_only_the_top_tier_starts_or_stops_the_edge():
    """`up`, `down` and `ensure_running` decide whether a container runs, and a module
    below them doing that is how a resolve function came to start a real Traefik during
    the test suite — which held :443 and broke a live run. Measured, in phase 1."""
    # CALLS, walked as a tree. `types`' docstring mentions `ensure_running(...)` while
    # explaining its own `__bool__`, and a text search reported the sentence -- the same
    # prose-versus-code trap that made the re-pointer once rewrite a docstring about the
    # re-pointer.
    for module in (paths, types, acme, networks, routeyml, spec, routes):
        tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
        called = {getattr(n.func, "attr", None) or getattr(n.func, "id", None)
                  for n in ast.walk(tree) if isinstance(n, ast.Call)}
        for verb in ("_compose", "ensure_running"):
            assert verb not in called, (
                f"{module.__name__} is tier {TIERS[module.__name__.rsplit('.', 1)[-1]]} "
                f"and calls {verb!r}; only `runtime` and `engine` may")


def test_a_route_addresses_the_container_and_never_the_service_alias():
    """Every workspace calls its service `rocketchat`, and from an edge attached to many
    such networks the bare name resolves deterministically to ONE of them — which looks
    stable under testing and would serve the wrong workspace forever."""
    source = pathlib.Path(routeyml.__file__).read_text(encoding="utf-8")
    assert "backend_container" in source, (
        "the route builder no longer resolves a container name; a service alias would "
        "resolve to whichever workspace the edge happened to attach to first")
