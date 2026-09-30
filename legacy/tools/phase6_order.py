#!/usr/bin/env python
"""Step 06.0: is the phase-6 port order still topological against the real tree?

    .venv/bin/python tools/phase6_order.py
    .venv/bin/python tools/phase6_order.py --json
    .venv/bin/python tools/phase6_order.py --explain

`phases/06-core-services.md` fixes a port order in a table written before phases 1-3
moved code around. Its own Context paragraph says why this script exists: *"Step 06.0
must regenerate the dependency graph from the post-Phase-2 tree and stop if the order
below is no longer topological."* A port order copied from a plan and never re-measured
is how a module gets ported before the thing it imports, and the failure is not a
compile error -- it is a TypeScript module reaching back into Python in-process, which
every phase-6 step forbids.

**The rule being checked.** Every step may import only modules ported at its own step or
an EARLIER one. Same-step edges are legal: `6.1` is `audit -> sessions -> users` and the
step file says "order within the step is part of the contract", so the three are one
unit and the ordering inside it is prose, not a graph property. A LATER-step edge is the
violation: it means the module cannot be written without the one that has not arrived.

**Why the graph is the combined one.** `tools/scc_check.py`'s docstring records the
finding that this package resolves 259 imports inside function bodies, invisible to a
module-scope walk. A function-body import is still a dependency for a PORT -- the
TypeScript module needs the thing it calls to exist -- so both kinds count here, and
`--explain` prints which kind each violating edge is, because a function-body edge is
the one a reader will not find by skimming the top of the file.

**But the two kinds of later-step edge are not the same defect, and collapsing them
would fail this gate on the one property the port was designed around.** RULES.md's
port-specific section states the reason CommonJS was chosen over ESM: *"An in-function
`require()` resolves at call time exactly like Python's 259 function-body imports."*

  * A MODULE-LEVEL later-step edge is unportable. The TypeScript module cannot be
    written: its `require` runs at load, the target does not exist, and the only ways
    out are a dangling import or reaching back into Python in-process -- which every
    phase-6 step forbids. This FAILS.

  * A FUNCTION-BODY later-step edge sitting inside a failure-tolerant guard is the
    mechanism working as designed. `require()` resolves when the function runs; before
    the target lands it throws `MODULE_NOT_FOUND`, the existing `except` catches it, and
    the module falls back to exactly what the Python falls back to when its own lookup
    fails. Nothing reaches Python at any point. This is DEFERRED, not failed -- and the
    later step owes it a parity test, because until then the fallback is all that runs.

The guard is CHECKED, not assumed: a function-body later-step edge outside a `try` is
reported as a hard violation like any module-level one. Both of today's deferrals are
`from houston.services.backup import database_of` under `except Exception: return DB`,
in `perf/mongoprof.py` and `scaleseed.py`, and both are the same `_db_of` helper.

**Package `__init__` edges are excluded**, unlike the SCC gate. That gate judges Python's
import-time semantics, where `from houston.services import eventlog` executes
`services/__init__.py` first. This one judges what the PORT must have in place, and the
CommonJS target has no such rule: `require('./services/eventlog')` runs no initialiser.
Including them would report `services.events` as a phase-6 prerequisite of everything,
which is true of Python and false of the thing being built.

**Out-of-scope edges are reported, not failed.** A phase-6 module importing `config`,
`errors`, `compose`, `versions`, `rcapi` or a phase-5 seam is the port working as
designed -- those landed in phases 4 and 5. What this script asserts is that every such
target is ALREADY PORTED, by checking the TypeScript tree for it, so "it is a lower
layer" cannot quietly mean "it does not exist yet either".
"""

from __future__ import annotations

import argparse
import ast
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import scc_check  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "houston"

#: The port order from `phases/06-core-services.md`, as {step: [module prefix, ...]}.
#: A prefix matches a module and everything under it, so `houston.services.lifecycle`
#: covers all twenty files of the package without listing them.
#:
#: 6.2 is the scrypt gate, which is a property of `users` rather than a module of its
#: own, so it owns nothing here and `users` stays at 6.1 where the table puts it.
PORT_ORDER: dict[str, tuple[str, ...]] = {
    "6.1": (
        "houston.services.audit",
        "houston.services.sessions",
        "houston.services.users",
    ),
    "6.3": (
        "houston.services.firstrun",
        "houston.services.skill",
    ),
    "6.4": (
        "houston.services.diagnose",
        "houston.services.topology",
        "houston.monitoring",
    ),
    "6.5": (
        "houston.services.journal",
        "houston.services.eventlog",
        # NOT IN THE PHASE-6 TABLE, and a prerequisite of `eventlog`, which imports
        # REDACTED, the key hints and the URL pattern from it at module level. It is a
        # dependency-free leaf whose whole job is that the redaction rule exists once;
        # porting it anywhere other than beside its only phase-6 importer would mean two
        # copies of that rule, which is the thing it exists to prevent. Its other importer
        # is `lifecycle/payload`, at 6.11.
        "houston.services.redact",
    ),
    # `houston/perf/` ONLY. The phase file's 6.6 row is headed `perf/*` and then names
    # its eleven members -- `timings resources k6 slo baseline constrain rcmetrics
    # mongoprof timeline verdict report` -- every one of which is in `houston/perf/`.
    # `services/perf.py` is a different module with a different job (the GUI loadtest
    # service) and the table never places it. This script's first run found out why it
    # could not go here: it imports `seed` and `services.lifecycle` AT MODULE LEVEL, so
    # it is a lifecycle CONSUMER and belongs at 6.12 with the other three. Recorded as
    # a deviation, the same way step 6.10 records `migrate` as the module every earlier
    # plan forgot to budget.
    "6.6": (
        "houston.perf",
    ),
    "6.7": (
        "houston.services.postready",
    ),
    "6.8": (
        "houston.presets",
    ),
    "6.9": (
        "houston.seed",
        "houston.seed_profiles",
        "houston.scaleseed",
        "houston.configimport",
    ),
    "6.10": (
        "houston.services.cluster",
        "houston.services.migrate",
    ),
    "6.11": (
        "houston.services.lifecycle",
    ),
    "6.12": (
        "houston.services.envvars",
        "houston.services.monitor",
        "houston.services.data",
        # Unlisted by the phase file; placed here by measurement rather than by the
        # table. See the note on 6.6.
        "houston.services.perf",
    ),
    "6.13": (
        "houston.services.backup",
        "houston.services.backup_compat",
        "houston.services.upgrade",
        "houston.services.doctor",
    ),
}

STEP_SEQUENCE = list(PORT_ORDER)

#: Modules a phase-6 step may import because an EARLIER PHASE ported them, each with the
#: TypeScript file that has to exist for that claim to be true. A target resolving here
#: is checked against the tree rather than taken on trust: "a lower layer owns it" and
#: "nobody has written it yet" look identical from inside a phase-6 module.
ALREADY_PORTED: dict[str, str] = {
    "houston.config": "src/lib/config.ts",
    "houston.errors": "src/lib/errors.ts",
    "houston.compose": "src/lib/compose.ts",
    "houston.versions": "src/lib/versions.ts",
    "houston.jsonout": "src/lib/jsonout.ts",
    "houston.lock": "src/lib/lock.ts",
    "houston.exec": "src/seams/exec.ts",
    "houston.rcapi": "src/core/rcapi.ts",
    "houston.tls": "src/core/tls.ts",
    "houston.tls_local": "src/core/tls-local.ts",
    "houston.services.events": "src/lib/events.ts",
    "houston.services.edge": "src/core/edge",
    "houston.services.eks": "src/core/eks.ts",
    "houston.services.eks_docs": "src/core/eks-docs.ts",
    "houston.services.k8s": "src/core/kube",
    # NOT IN THE STEP TABLE, and `create_docker` imports it at function-body scope: the
    # pure SERVER-121912 MongoDB/kernel rule. Step 6.11 absorbed it -- a port of
    # `lifecycle` that could not reach the rule it refuses with would be incomplete while
    # every gate stayed green, which is exactly why it is recorded here.
    "houston.services.mongo_kernel": "src/lib/mongo-kernel.ts",
    "houston.services.topology": "src/lib/teammode.ts",
}

#: Modules that are neither phase-6 scope nor already ported, and why that is not a gap.
#: `ui` is CLI-only and `services/__init__` is an empty package marker restored in step
#: 2a.12; `recovery` is phase-6 scope in substance but the phase file's table does not
#: list it, so it is named here rather than silently passing as "out of scope". `redact`
#: was absorbed by 6.5 and `mongo_kernel` by 6.11, both recorded in ALREADY_PORTED.
UNLISTED_BY_THE_PLAN: dict[str, str] = {
    "houston.ui": "CLI-only terminal rendering; phase 7 owns the front door",
    "houston.services": "empty package marker restored in step 2a.12 for find_packages",
    "houston": "package root",
    "houston.__main__": "console entry point; phase 7",
    "houston.cli": "phase 7",
    "houston.web": "phase 7",
    "houston.services.recovery": "NOT IN THE PHASE-6 TABLE -- see the report",
}


def step_of(module: str) -> str | None:
    """The phase-6 step that ports `module`, or None if no step claims it."""
    best: tuple[int, str] | None = None
    for step, prefixes in PORT_ORDER.items():
        for prefix in prefixes:
            if module == prefix or module.startswith(f"{prefix}."):
                # Longest prefix wins, so a nested package cannot be captured by a
                # shorter sibling entry.
                if best is None or len(prefix) > best[0]:
                    best = (len(prefix), step)
    return best[1] if best else None


def classify(module: str) -> str:
    """`scope`, `ported`, `unlisted` or `unknown`, for a target of an edge."""
    if step_of(module) is not None:
        return "scope"
    if module in ALREADY_PORTED:
        return "ported"
    for prefix in ALREADY_PORTED:
        if module.startswith(f"{prefix}."):
            return "ported"
    if module in UNLISTED_BY_THE_PLAN:
        return "unlisted"
    for prefix in UNLISTED_BY_THE_PLAN:
        if module.startswith(f"{prefix}."):
            return "unlisted"
    return "unknown"


def guarded_lines(path: pathlib.Path) -> set[int]:
    """Line numbers of import statements inside a `try` with an `except` that catches.

    This is what separates a DEFERRED edge from a broken one. A call-time `require()`
    for a module that has not been ported yet throws; whether that is survivable is
    decided entirely by whether the Python it is ported from already survives its own
    import failing. A bare `try/finally` is not a guard -- nothing catches -- so only
    handlers are counted.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try) or not node.handlers:
            continue
        for child in ast.walk(node):
            if isinstance(child, (ast.Import, ast.ImportFrom)):
                guarded.add(child.lineno)
    return guarded


def analyse() -> dict:
    modules = scc_check.discover(PACKAGE)
    known = set(modules)
    all_edges = {
        name: scc_check.edges_of(name, path, known, package_init_edges=False)
        for name, path in modules.items()
    }
    guards = {name: guarded_lines(path) for name, path in modules.items()
              if step_of(name) is not None}

    violations: list[dict] = []
    deferred: list[dict] = []
    out_of_scope: list[dict] = []
    missing_prereq: list[dict] = []
    unknown_targets: list[dict] = []

    for source, edges in sorted(all_edges.items()):
        source_step = step_of(source)
        if source_step is None:
            continue
        source_rank = STEP_SEQUENCE.index(source_step)
        seen: set[tuple[str, str]] = set()
        for target, kind, lineno in edges:
            key = (target, kind)
            target_step = step_of(target)
            if target_step is not None:
                if STEP_SEQUENCE.index(target_step) > source_rank:
                    entry = {
                        "from": source, "fromStep": source_step,
                        "to": target, "toStep": target_step,
                        "kind": kind, "line": lineno,
                    }
                    if (kind == scc_check.FUNCTION_BODY
                            and lineno in guards.get(source, set())):
                        # Call-time and already failure-tolerant: portable as a
                        # `require()` inside the same catch. The later step owes it a
                        # parity test, which is what `owedBy` records.
                        entry["owedBy"] = target_step
                        deferred.append(entry)
                    else:
                        violations.append(entry)
                continue
            kindness = classify(target)
            if key in seen:
                continue
            seen.add(key)
            if kindness == "ported":
                artefact = ALREADY_PORTED.get(target) or next(
                    path for prefix, path in ALREADY_PORTED.items()
                    if target.startswith(f"{prefix}.")
                )
                if not (ROOT.parent / artefact).exists():   # src/ is beside legacy/
                    missing_prereq.append({
                        "from": source, "to": target, "expects": artefact,
                        "kind": kind, "line": lineno,
                    })
                else:
                    out_of_scope.append({
                        "from": source, "to": target, "satisfiedBy": artefact,
                    })
            elif kindness == "unknown":
                unknown_targets.append({
                    "from": source, "to": target, "kind": kind, "line": lineno,
                })

    in_scope = sorted(m for m in modules if step_of(m) is not None)
    return {
        "modules": len(modules),
        "inScope": len(in_scope),
        "steps": {step: sorted(m for m in in_scope if step_of(m) == step)
                  for step in STEP_SEQUENCE},
        "violations": violations,
        "deferred": deferred,
        "missingPrerequisite": missing_prereq,
        "unknownTargets": unknown_targets,
        "outOfScopeEdges": len(out_of_scope),
        "ok": not violations and not missing_prereq and not unknown_targets,
    }


def render(result: dict, *, explain: bool) -> str:
    lines: list[str] = []
    lines.append(
        f"{result['inScope']} phase-6 modules across {len(STEP_SEQUENCE)} steps, "
        f"out of {result['modules']} in the package."
    )
    if explain:
        for step in STEP_SEQUENCE:
            members = result["steps"][step]
            lines.append(f"  {step:>5}  {len(members):>2} module(s): "
                         + ", ".join(scc_check.short(m) for m in members))
    lines.append("")
    if result["violations"]:
        lines.append(f"{len(result['violations'])} EDGE(S) THE ORDER CANNOT SATISFY "
                     "-- a module needs one ported after it:")
        for v in result["violations"]:
            lines.append(
                f"  {scc_check.short(v['from'])} ({v['fromStep']}) -> "
                f"{scc_check.short(v['to'])} ({v['toStep']})  "
                f"{v['kind']} at line {v['line']}"
            )
    if result["deferred"]:
        lines.append(f"{len(result['deferred'])} DEFERRED EDGE(S) -- call-time and "
                     "already failure-tolerant, so portable as a guarded `require()`. "
                     "The step named last owes each one a parity test:")
        for d in result["deferred"]:
            lines.append(
                f"  {scc_check.short(d['from'])} ({d['fromStep']}) -> "
                f"{scc_check.short(d['to'])} ({d['toStep']})  "
                f"guarded {d['kind']} at line {d['line']}  owed by {d['owedBy']}"
            )
        lines.append("")
    if result["missingPrerequisite"]:
        lines.append(f"{len(result['missingPrerequisite'])} PREREQUISITE(S) AN EARLIER "
                     "PHASE WAS MEANT TO HAVE PORTED, and has not:")
        for m in result["missingPrerequisite"]:
            lines.append(f"  {scc_check.short(m['from'])} -> {m['to']}  "
                         f"expects {m['expects']}")
    if result["unknownTargets"]:
        lines.append(f"{len(result['unknownTargets'])} TARGET(S) THIS SCRIPT CANNOT "
                     "PLACE -- neither phase-6 scope, nor ported, nor named unlisted:")
        for u in result["unknownTargets"]:
            lines.append(f"  {scc_check.short(u['from'])} -> {u['to']}  "
                         f"{u['kind']} at line {u['line']}")
    if result["ok"]:
        lines.append("the port order is topological against this tree; "
                     f"{result['outOfScopeEdges']} edge(s) reach an already-ported "
                     "module and every one of those exists.")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="machine-readable report")
    parser.add_argument("--explain", action="store_true",
                        help="list the modules each step ports")
    args = parser.parse_args()
    result = analyse()
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(render(result, explain=args.explain))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
