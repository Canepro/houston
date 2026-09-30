#!/usr/bin/env python
"""Find import cycles in `houston/`, including the ones hidden in function bodies.

    .venv/bin/python tools/scc_check.py
    .venv/bin/python tools/scc_check.py --json
    .venv/bin/python tools/scc_check.py --baseline tools/scc-baseline.json
    .venv/bin/python tools/scc_check.py --baseline tools/scc-baseline.json --update

Phase 1's exit gate is "zero strongly-connected components". This is the script that
decides it, so it exists before the cuts land rather than after -- a gate written to
agree with the change it is meant to judge judges nothing.

**Why the module-level graph is not the answer.** Counting only imports at module scope
reports this package as acyclic, and it is not. `houston` resolves 259 imports inside
function bodies, and Python resolves those at CALL time, which is exactly why they are
legal in a cycle and exactly why they are invisible to the obvious version of this
script. `services/events.py` is the clean example: its `_tee` does
`from houston.services import eventlog` on line 54, inside a function, and its docstring
explains the trick. Nothing at module scope in that file imports anything from this
package. So the gate runs on the COMBINED graph, and the report prints all three
figures, because the contrast is the finding: **if this script ever reports zero cycles,
suspect the function-body walk before believing it.**

**Two modelling choices, both stated rather than assumed.**

*Package `__init__` edges ARE included, and they are the gate.* `from houston.services
import eventlog` is recorded as an edge to `houston.services.eventlog` AND to
`houston.services`, because Python executes `services/__init__.py` before it can hand
back the submodule. That is not a technicality here: `services/__init__.py` imports
`services.events` at module scope, so the parent edge is what closes the smallest cycle
in this package. A gate that judges the Python tree has to use Python's semantics, and
under-reporting is the dangerous direction for a gate -- excluding these edges hides
two modules that really are in a cycle today.

Pass `--explicit-edges-only` for the other view, which records just what the statement
names. That is the CommonJS model -- `require('./services/eventlog')` does not execute
`services/index.js` -- so it answers a different and later question: which of these
cycles will still exist after the port. Today it reports 15 modules / 18,740 lines
rather than 17 / 19,944, the difference being `rcapi` and `services.users` at 599 and
605 lines. A baseline recorded under one model is refused against the other, because
comparing them silently would report progress that is only a change of definition.

*Lines are RAW physical lines*, summed per component -- the same metric `FINDINGS.md`
§4 uses for file sizes. `tools/structure_check.py` defines *code* lines for the size
caps, deliberately differently, and for a different job: here the number is a rough
weight for "how much is tangled", not a budget anything has to fit inside.

**`--baseline` fails only on regression**, so it can go into CI today with two known
components rather than waiting for Phase 1 to finish. A component is a regression when
it is not a subset of some component in the baseline -- which catches both a module
newly drawn into a cycle and two known components merging into one. Shrinking, splitting
and disappearing are the point of Phase 1 and are reported as progress, not failure.
"""
from __future__ import annotations

import argparse
import ast
import itertools
import json
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = "houston"

MODULE_LEVEL = "module-level"
FUNCTION_BODY = "function-body"
FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


def discover(package_dir: pathlib.Path) -> dict[str, pathlib.Path]:
    """Every module in the package, keyed by its full dotted name.

    `services/__init__.py` is `houston.services` -- a package initialiser is a module
    with a body, it can hold imports, and here it does, so leaving it out would drop a
    real node from the graph.
    """
    modules: dict[str, pathlib.Path] = {}
    for path in sorted(package_dir.rglob("*.py")):
        rel = path.relative_to(package_dir.parent)
        parts = list(rel.with_suffix("").parts)
        if parts[-1] == "__init__":
            parts.pop()
        modules[".".join(parts) or PACKAGE] = path
    return modules


def _resolve(target: str, known: set[str]) -> str | None:
    """Longest known-module prefix of a dotted name, or None if it leaves the package.

    `import houston.services.k8s` names a module directly. `from houston.services import
    run_something` names an ATTRIBUTE of the package, so the longest known prefix is
    `houston.services` and that is the edge. Anything not under `houston.` is stdlib or
    a third-party dependency and is not a node here.
    """
    if not target or target.split(".")[0] != PACKAGE:
        return None
    parts = target.split(".")
    while parts:
        candidate = ".".join(parts)
        if candidate in known:
            return candidate
        parts.pop()
    return None


def _package_of(module: str, path: pathlib.Path) -> str:
    """The package a relative import inside `module` resolves against.

    For `houston/services/k8s.py` that is `houston.services`. For the initialiser
    `houston/services/__init__.py` it is `houston.services` itself -- inside an
    `__init__`, `from . import x` means a sibling of the initialiser, not of the package.
    """
    if path.name == "__init__.py":
        return module
    return module.rpartition(".")[0]


def edges_of(module: str, path: pathlib.Path, known: set[str],
             *, package_init_edges: bool) -> list[tuple[str, str, int]]:
    """Every intra-package import in one module, as (target, kind, lineno).

    `kind` is MODULE_LEVEL or FUNCTION_BODY, decided by whether the statement sits
    inside a function. A class body is module-level: it executes at import time. An
    `if TYPE_CHECKING:` block is also reported as module-level -- it never executes, so
    it cannot cause an import-time cycle, but it IS a real dependency once ported, and
    there is exactly one in this package (`compose.py`, for an annotation).
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    inside_function: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, FUNCTION_NODES):
            for child in ast.walk(node):
                inside_function.add(id(child))

    found: list[tuple[str, str, int]] = []

    def record(target: str | None, node: ast.stmt) -> None:
        if target is None or target == module:
            return
        kind = FUNCTION_BODY if id(node) in inside_function else MODULE_LEVEL
        found.append((target, kind, node.lineno))
        if package_init_edges:
            # Importing a submodule executes every parent initialiser first.
            parent = target.rpartition(".")[0]
            while parent and parent != PACKAGE.rpartition(".")[0]:
                if parent in known and parent != module:
                    found.append((parent, kind, node.lineno))
                parent = parent.rpartition(".")[0]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                record(_resolve(alias.name, known), node)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = _package_of(module, path)
                for _ in range(node.level - 1):
                    base = base.rpartition(".")[0]
                base = f"{base}.{node.module}" if node.module else base
            else:
                base = node.module or ""
            if not base or base.split(".")[0] != PACKAGE:
                continue
            for alias in node.names:
                # `from houston.services import k8s` is an edge to the MODULE k8s;
                # `from houston.services import null_emit` is one to the package.
                record(_resolve(f"{base}.{alias.name}", known) or _resolve(base, known), node)

    return found


def graph_for(all_edges: dict[str, list[tuple[str, str, int]]],
              kinds: tuple[str, ...]) -> dict[str, set[str]]:
    return {module: {t for t, kind, _ in edges if kind in kinds}
            for module, edges in all_edges.items()}


def tarjan(graph: dict[str, set[str]]) -> list[list[str]]:
    """Strongly-connected components, largest first, each sorted.

    Recursive: the recursion depth is bounded by the module count, which is 69 here and
    is not going to approach the interpreter limit -- the port ADDS modules to `src/`,
    which this script does not walk.
    """
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: dict[str, bool] = {}
    stack: list[str] = []
    components: list[list[str]] = []
    counter = itertools.count()

    def visit(v: str) -> None:
        index[v] = low[v] = next(counter)
        stack.append(v)
        on_stack[v] = True
        for w in sorted(graph.get(v, ())):
            if w not in index:
                visit(w)
                low[v] = min(low[v], low[w])
            elif on_stack.get(w):
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            component = []
            while True:
                w = stack.pop()
                on_stack[w] = False
                component.append(w)
                if w == v:
                    break
            components.append(sorted(component))

    for node in sorted(graph):
        if node not in index:
            visit(node)
    # Singletons are not cycles. A module importing itself is not one either -- it
    # cannot, and no such edge is recorded.
    return sorted((c for c in components if len(c) > 1),
                  key=lambda c: (-len(c), c))


def short(module: str) -> str:
    return module[len(PACKAGE) + 1:] if module.startswith(PACKAGE + ".") else module


def describe(components: list[list[str]], lines: dict[str, int]) -> list[dict]:
    return [{"size": len(c),
             "lines": sum(lines[m] for m in c),
             "modules": [short(m) for m in c]}
            for c in components]


def analyse(*, package_init_edges: bool) -> dict:
    modules = discover(REPO_ROOT / PACKAGE)
    known = set(modules)
    lines = {m: len(p.read_text(encoding="utf-8").splitlines()) for m, p in modules.items()}
    all_edges = {m: edges_of(m, p, known, package_init_edges=package_init_edges)
                 for m, p in modules.items()}

    combined = tarjan(graph_for(all_edges, (MODULE_LEVEL, FUNCTION_BODY)))
    return {
        "modules": len(modules),
        "metric": "raw physical lines",
        "package_init_edges": package_init_edges,
        "counts": {
            "module_level_only": len(tarjan(graph_for(all_edges, (MODULE_LEVEL,)))),
            "function_body_only": len(tarjan(graph_for(all_edges, (FUNCTION_BODY,)))),
            "combined": len(combined),
        },
        "sccs": describe(combined, lines),
    }


def render(result: dict) -> str:
    out = [f"{result['modules']} modules under {PACKAGE}/, "
           f"lines are {result['metric']}"]
    if not result["package_init_edges"]:
        out.append("EXPLICIT EDGES ONLY -- the post-port CommonJS model, NOT the gate")
    counts = result["counts"]
    out += [
        "",
        f"  MODULE-LEVEL imports only .................. {counts['module_level_only']} SCCs",
        f"  FUNCTION-BODY imports only ................. {counts['function_body_only']} SCCs",
        f"  ALL imports (the gate) ..................... {counts['combined']} SCCs",
        "",
    ]
    if not result["sccs"]:
        out.append("No cycles. If this is unexpected, the function-body walk is broken "
                   "before it is good news.")
        return "\n".join(out)
    for scc in result["sccs"]:
        out.append(f"  size={scc['size']:<4} lines={scc['lines']:<8} "
                   f"{' '.join(scc['modules'])}")
    return "\n".join(out)


def compare(result: dict, baseline: dict) -> tuple[list[str], list[str]]:
    """Regressions and improvements against a baseline, by module set."""
    base_sets = [set(s["modules"]) for s in baseline.get("sccs", [])]
    regressions, improvements = [], []
    for scc in result["sccs"]:
        current = set(scc["modules"])
        if any(current <= known for known in base_sets):
            continue
        newly = sorted(current - set().union(*base_sets)) if base_sets else sorted(current)
        merged = [sorted(k & current) for k in base_sets if k & current]
        detail = f"size={scc['size']} lines={scc['lines']}"
        if newly:
            detail += f"; modules newly in a cycle: {', '.join(newly)}"
        if len(merged) > 1:
            detail += f"; {len(merged)} baseline components merged into one"
        regressions.append(f"{detail}\n      {' '.join(scc['modules'])}")
    now_sets = [set(s["modules"]) for s in result["sccs"]]
    for base in baseline.get("sccs", []):
        known = set(base["modules"])
        still = set().union(*now_sets) & known if now_sets else set()
        if not still:
            improvements.append(f"gone: {base['size']} modules ({' '.join(base['modules'])})")
        elif still < known:
            improvements.append(f"shrank: {len(known)} -> {len(still)} modules; freed "
                                f"{', '.join(sorted(known - still))}")
    return regressions, improvements


def _display(path: pathlib.Path) -> str:
    """Repo-relative if it is inside the repo, else as given. `relative_to` RAISES on a
    path that is merely relative, which crashed the first run of --update."""
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def write_baseline(path: pathlib.Path, result: dict) -> None:
    path.write_text(json.dumps({
        "note": ("Import cycles in houston/ that Phase 1 must remove. Regenerate with "
                 "`.venv/bin/python tools/scc_check.py --baseline tools/scc-baseline.json "
                 "--update`, which refuses to record a regression. Lines are RAW physical "
                 "lines; `tools/structure_check.py` counts code lines, for a different job."),
        "metric": result["metric"],
        "package_init_edges": result["package_init_edges"],
        "counts": result["counts"],
        "sccs": result["sccs"],
    }, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--baseline", metavar="PATH",
                    help="compare against this baseline and fail only on regression")
    ap.add_argument("--update", action="store_true",
                    help="rewrite the --baseline file; refuses to record a regression")
    ap.add_argument("--explicit-edges-only", action="store_true",
                    help="record only what each import statement names, ignoring the "
                         "parent __init__ Python executes first (the post-port CommonJS "
                         "model; NOT the gate)")
    args = ap.parse_args()

    try:
        result = analyse(package_init_edges=not args.explicit_edges_only)
    except SyntaxError as exc:
        print(f"tools/scc_check.py: {exc.filename}:{exc.lineno} will not parse: {exc.msg}",
              file=sys.stderr)
        return 2

    if args.json:
        json.dump(result, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(render(result))

    if not args.baseline:
        return 0

    path = pathlib.Path(args.baseline)
    if not path.is_file():
        if not args.update:
            print(f"\n{args.baseline} does not exist. Create it with --update.",
                  file=sys.stderr)
            return 2
        # CREATION, not comparison. Treating an absent baseline as an empty one makes
        # every cycle that already exists a regression, and --update then refuses to
        # write the very file it was asked to create.
        write_baseline(path, result)
        if not args.json:
            print(f"\ncreated {_display(path)} with "
                  f"{len(result['sccs'])} component(s)")
        return 0
    baseline = json.loads(path.read_text(encoding="utf-8"))

    recorded = baseline.get("package_init_edges")
    if recorded is not None and recorded != result["package_init_edges"]:
        print(f"\n{args.baseline} was recorded with package_init_edges={recorded} and this "
              f"run used {result['package_init_edges']}. The two models disagree by whole "
              f"modules, so comparing them would report a change of definition as progress.",
              file=sys.stderr)
        return 2

    regressions, improvements = compare(result, baseline)
    if not args.json:
        for line in improvements:
            print(f"\n  PROGRESS  {line}")
        for line in regressions:
            print(f"\n  REGRESSION  {line}")

    if regressions:
        print(f"\n{len(regressions)} component(s) are worse than the baseline. A cycle is "
              f"allowed to shrink, split or vanish; it may not grow or absorb another.",
              file=sys.stderr)
        if args.update:
            print("--update refuses to record a regression. Fix the cycle, or say "
                  "explicitly in a commit why the baseline should get worse and edit "
                  "the file by hand.", file=sys.stderr)
        return 1

    if args.update:
        write_baseline(path, result)
        print(f"\nwrote {_display(path)}")
    elif not args.json:
        print("\nno regression against the baseline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
