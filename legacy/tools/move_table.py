#!/usr/bin/env python
"""The symbol-level decomposition map, as a checkable artifact rather than a paragraph.

    .venv/bin/python tools/move_table.py --check     # every symbol assigned, no upward tier
    .venv/bin/python tools/move_table.py --inventory houston/services/lifecycle.py
    .venv/bin/python tools/move_table.py --render    # rewrite the reviewed markdown table

Phase 2b splits `lifecycle.py` (2,328 code lines, 101 symbols) and `k8s.py` (3,092 code
lines, 187 symbols) into eighteen and twenty-four modules. The failure mode is not a
module that is too big; it is a SYMBOL nobody assigned, discovered halfway through a
split when something imports it from a file that no longer has it — or, worse, a module
that quietly imports upward and re-creates the cycle Phase 1 spent ten cuts removing.

So the map is data (`tools/move-table.json`) and this file is the gate on it:

* **Every top-level symbol of every module being split has a destination.** Unassigned is
  a failure, not a default. `--check` names them.
* **A destination has a TIER, and a module may only import from a lower one.** The tiers
  are the phase plan's own: k0 names, k1 exec/ask/tools, k2 read-only probes, k3 writes,
  k4 the orchestrator nothing imports. An edge from a symbol to one in a higher tier is
  rejected here, before any code moves.
* **Every symbol records which tests reference it**, so a move that loses coverage is
  visible in the table rather than in a green run over fewer assertions.

It reads the CURRENT tree every time. A map derived once and then trusted is the thing
this phase is trying to stop being possible.
"""
from __future__ import annotations

import argparse
import ast
import io
import json
import pathlib
import re
import sys
import tokenize
from collections import defaultdict

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLE = REPO_ROOT / "tools" / "move-table.json"
RENDERED = REPO_ROOT.parent / ".docs" / "migration" / "02b-move-table.md"   # above legacy/


def _assigned(node: ast.Assign) -> set[str]:
    """Every name an assignment binds, TUPLE TARGETS INCLUDED.

    `REFUSED, ABSENT, PRESENT = "refused", "absent", "present"` binds three names in one
    statement, and reading only `ast.Name` targets saw none of them -- so three symbols
    of the Answer vocabulary were invisible to the map, to `--check` and to the façade's
    generated `_OWNER`. They surfaced as `AttributeError` from the suite, which is the
    good case; the bad one is a symbol that silently never moves.
    """
    found: set[str] = set()
    for target in node.targets:
        for sub in ast.walk(target):
            if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
                found.add(sub.id)
    return found


def top_level(path: pathlib.Path) -> dict[str, dict]:
    """Every top-level symbol a module defines, with its span and what it references.

    `references` is intra-module only: the names this symbol uses that the same module
    also defines. That is the edge set the tier rule is checked against, because those
    are exactly the edges a split turns into imports.
    """
    text = path.read_text(encoding="utf-8")
    tree = ast.parse(text, filename=str(path))
    defined = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)
        elif isinstance(node, ast.Assign):
            defined |= _assigned(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            defined.add(node.target.id)

    out: dict[str, dict] = {}
    for node in tree.body:
        names = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names = [node.name]
        elif isinstance(node, ast.Assign):
            names = sorted(_assigned(node))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names = [node.target.id]
        if not names:
            continue
        used = {n.id for n in ast.walk(node)
                if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
        span = (node.end_lineno or node.lineno) - node.lineno + 1
        for name in names:
            out[name] = {
                "kind": type(node).__name__.replace("Def", "").lower(),
                "line": node.lineno,
                "span": span,
                "public": not name.startswith("_"),
                "references": sorted((used & defined) - set(names)),
            }
    return out


def tests_referencing(module_alias: str) -> dict[str, list[str]]:
    """symbol -> the test files that mention `<alias>.<symbol>` or import it by name.

    Deliberately textual and deliberately generous: the question here is "would a reader
    looking for this symbol's coverage find something", not "prove this test exercises
    it". A symbol with no row at all is the one worth arguing about.
    """
    hits: dict[str, set[str]] = defaultdict(set)
    for path in sorted((REPO_ROOT / "tests").rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for alias in module_alias.split(","):
            alias = alias.strip()
            if not alias:
                continue
            for line in text.splitlines():
                if f"{alias}." not in line:
                    continue
                for chunk in line.split(f"{alias}."):
                    name = ""
                    for ch in chunk:
                        if ch.isalnum() or ch == "_":
                            name += ch
                        else:
                            break
                    if name:
                        hits[name].add(path.name)
    return {k: sorted(v) for k, v in hits.items()}


def _sources(source: str, plan: dict) -> list[pathlib.Path]:
    """Where this module's symbols live NOW: the original file, or the package it became.

    `__init__.py` is excluded on purpose: it is the compatibility façade and defines no
    symbol of its own, so counting it would let a name that is only re-exported look
    assigned.
    """
    path = REPO_ROOT / source
    if path.is_file():
        return [path]
    package = REPO_ROOT / plan.get("package", "")
    if not plan.get("package") or not package.is_dir():
        return []
    return [p for p in sorted(package.rglob("*.py")) if p.name != "__init__.py"]


def bare_sibling_functions(package: pathlib.Path) -> list[str]:
    """Sibling FUNCTIONS imported by name, which is how a patch silently stops landing.

    `from .naming import resolve_name` binds the function object into the importing
    module's globals, so `monkeypatch.setattr(naming, "resolve_name", fake)` never reaches
    it -- the test goes green over the real function and nothing says so. `from . import
    naming` plus `naming.resolve_name(...)` is a module-attribute lookup at call time,
    which the patch does reach, and which is what TypeScript emits for the same call
    (`naming_1.resolveName()`). FINDINGS §3 is about exactly this property.

    CONSTANTS and CLASSES are exempt: nothing patches a value by rebinding the name, and
    `CreateReq` read through a module object every time would be noise.
    """
    defined: dict[str, str] = {}
    for path in sorted(package.rglob("*.py")):
        if path.name == "__init__.py":
            continue
        for node in ast.parse(path.read_text(encoding="utf-8")).body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defined[node.name] = path.stem

    found: list[str] = []
    for path in sorted(package.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            module = node.module or ""
            if not module.startswith(f"houston.{package.parent.name}.{package.name}."):
                continue
            sibling = module.rsplit(".", 1)[-1]
            for alias in node.names:
                if defined.get(alias.name) == sibling:
                    found.append(
                        f"{path.relative_to(REPO_ROOT)}:{node.lineno} "
                        f"`from .{sibling} import {alias.name}` binds a function, so a "
                        f"patch on `{sibling}` will not reach this caller; use "
                        f"`from . import {sibling}`")
    return found


def load_table() -> dict:
    if not TABLE.is_file():
        raise SystemExit(f"{TABLE} does not exist; write the map before checking it")
    return json.loads(TABLE.read_text(encoding="utf-8"))


def destination_cycles(symbols: dict, plan: dict) -> list[str]:
    """Destinations that would import each other once the symbols are two files.

    The tier check cannot see these. It rejects an edge to a HIGHER tier, and a cycle
    between two destinations at the SAME tier has no such edge -- `ready` and `seeding`
    are both tier 3, `create_docker` and `create_k8s` both tier 5, and the reviewed map
    put a call in each direction of both pairs. Nothing would have complained until the
    code moved and `scc_check.py` failed with the work already done.

    Tiers are the order the split is EXECUTED in; this is the acyclicity the tiers were
    supposed to imply and did not. Measured on the map as written: two cycles.
    """
    edges: dict[str, set[str]] = {}
    for name, meta in symbols.items():
        source = plan["symbols"].get(name)
        for used in meta["references"]:
            dest = plan["symbols"].get(used)
            if dest is not None and source is not None and dest != source:
                edges.setdefault(source, set()).add(dest)

    # Tarjan, iterative: a package this size has call chains deeper than the recursion
    # limit is worth betting on.
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    counter = 0
    cycles: list[str] = []
    for root in sorted(set(plan["symbols"].values())):
        if root in index:
            continue
        work = [(root, iter(sorted(edges.get(root, ()))))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            node, children = work[-1]
            advanced = False
            for child in children:
                if child not in index:
                    index[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, iter(sorted(edges.get(child, ())))))
                    advanced = True
                    break
                if child in on_stack:
                    low[node] = min(low[node], index[child])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[node])
            if low[node] == index[node]:
                component = []
                while True:
                    popped = stack.pop()
                    on_stack.discard(popped)
                    component.append(popped)
                    if popped == node:
                        break
                if len(component) > 1:
                    cycles.append(
                        "these destinations would import each other: "
                        + " <-> ".join(sorted(component)))
    return cycles


def problems(table: dict) -> list[str]:
    """Every reason this map is not yet safe to execute."""
    found: list[str] = []
    for source, plan in table["modules"].items():
        # A module being split has ONE source file at the start and a package full of
        # them by the end, with a shrinking `_unsplit.py` in between. The map is checked
        # against the union, so it stays a live gate for the whole split rather than only
        # before it -- which is exactly the stretch where a symbol goes missing.
        paths = _sources(source, plan)
        if not paths:
            found.append(f"{source}: named in the map and not in the tree")
            continue
        symbols = {}
        for path in paths:
            symbols.update(top_level(path))
        assigned = plan["symbols"]
        for name in sorted(symbols):
            if name not in assigned:
                found.append(f"{source}: {name} has no destination")
        for name in sorted(assigned):
            if name not in symbols:
                found.append(f"{source}: {name} is assigned and no longer exists")

        # A SUBMODULE MAY NOT BE NAMED AFTER A SYMBOL THE PACKAGE EXPORTS.
        #
        # Python binds a submodule onto its parent package as an attribute the moment it
        # is imported, so `lifecycle/capacity.py` shadows the `capacity()` function on
        # `houston.services.lifecycle` -- permanently, and only once something has
        # imported the module, which makes it order-dependent as well as wrong. Measured:
        # `lc.capacity()` raised `TypeError: 'module' object is not callable` from
        # `doctor/checks/memory.py` the first time this was tried.
        #
        # The lazy `__getattr__` cannot help: it is consulted only when the attribute is
        # NOT in the module dict, and the submodule put it there.
        for dest in sorted(set(assigned.values())):
            if dest in symbols:
                found.append(
                    f"{source}: the module `{dest}` shadows the symbol `{dest}` it would "
                    f"have to export; rename the module")

        # `package` is absent while a module is still one file, and in the small
        # fixtures the gate's own self-tests build.
        package = REPO_ROOT / plan.get("package", "")
        if plan.get("package") and package.is_dir():
            found += bare_sibling_functions(package)

        # THE FAÇADE MUST AGREE WITH THE TREE. `_OWNER` is the map the running program
        # resolves through; a stale entry points a name at a module that no longer
        # defines it, and the failure surfaces as an AttributeError in whichever
        # unrelated test happens to touch that name first.
        if plan.get("package") and package.is_dir():
            found += [f"{source}: facade _OWNER is stale -- {line}"
                      for line in sync_facade({"modules": {source: plan}}, apply=False)]

        found += destination_cycles(symbols, plan)

        tiers = plan["tiers"]
        for name, meta in sorted(symbols.items()):
            dest = assigned.get(name)
            if dest is None:
                continue
            if dest not in tiers:
                found.append(f"{source}: {name} -> {dest}, which has no tier")
                continue
            for used in meta["references"]:
                other = assigned.get(used)
                if other is None or other == dest:
                    continue
                if tiers[other] > tiers[dest]:
                    found.append(
                        f"{source}: {dest} (tier {tiers[dest]}) would import {other} "
                        f"(tier {tiers[other]}) for {name} -> {used}: upward import")
    return found


def render(table: dict) -> str:
    lines = ["# Phase 2b — the reviewed symbol-level move table", "",
             "Generated by `.venv/bin/python tools/move_table.py --render` from",
             "`tools/move-table.json` and the CURRENT tree. `--check` is the gate:",
             "every symbol assigned, every destination tiered, no upward import.", ""]
    for source, plan in table["modules"].items():
        symbols = {}
        for path in _sources(source, plan):
            symbols.update(top_level(path))
        alias = plan.get("test_alias", "")
        coverage = tests_referencing(alias) if alias else {}
        by_dest: dict[str, list[str]] = defaultdict(list)
        for name, dest in plan["symbols"].items():
            by_dest[dest].append(name)
        lines += [f"## `{source}`", "",
                  f"{len(symbols)} top-level symbols → {len(by_dest)} modules. "
                  f"Rollback unit: {plan['rollback']}.", "",
                  "| Destination | Tier | Symbol | Kind | Lines | Export | Tests |",
                  "|---|---|---|---|---|---|---|"]
        for dest in sorted(by_dest, key=lambda d: (plan["tiers"][d], d)):
            for name in sorted(by_dest[dest]):
                meta = symbols[name]
                seen = coverage.get(name, [])
                lines.append(
                    f"| `{dest}` | {plan['tiers'][dest]} | `{name}` | {meta['kind']} | "
                    f"{meta['span']} | {'yes' if meta['public'] else 'no'} | "
                    f"{', '.join(seen) if seen else '—'} |")
        lines.append("")
    return "\n".join(lines) + "\n"


#: What a split module's shrinking leftover is called while the split is in flight. It is
#: deleted by the last group, and a patch target naming it has to stay recognisable after
#: that -- otherwise the last group is the one whose patches silently stop landing.
REMAINDER = "_unsplit"

#: Any `monkeypatch.setattr(<target>, "<name>", ...)`. Which targets are a façade is
#: decided per file by `facade_aliases`, not by this pattern: `rcapi` has a `login` of
#: its own, and re-pointing that one would break a test that is entirely correct.
#: `mock.patch.object` is the SAME hazard in a different spelling, and the suite uses
#: both. Matching only `monkeypatch.setattr` left `m.patch.object(k8s, "tool", ...)`
#: pointed at the façade -- which `monkeypatch.undo()`'s equivalent, the context
#: manager's exit, restores by writing a real attribute into the package dict, blinding
#: `__getattr__` for every later test in the process.
#: `monkeypatch.setattr("houston.runner.down", ...)` -- the STRING form, which names its
#: target in a way no attribute-access scan can see. It found two façade patches that
#: survived every other check and blinded fourteen later tests.
STRING_PATCH = re.compile(
    r"(?:monkeypatch\.setattr|(?:\w+\.)?patch(?:\.object)?)\(\s*"
    r"[\"'](?P<dotted>houston[\w.]+)[\"']")

#: The same call with a NON-literal attribute name.
COMPUTED = re.compile(
    r"(?:monkeypatch\.setattr|(?:\w+\.)?patch\.object)\("
    r"\s*(?P<target>[A-Za-z_][\w.]*)\s*,\s*(?![\"'])[A-Za-z_]")

PATCH = re.compile(
    r"(?:monkeypatch\.setattr|(?:\w+\.)?patch\.object)\("
    r"\s*(?P<target>[A-Za-z_][\w.]*)\s*,\s*"
    r"(?P<quote>[\"'])(?P<name>[A-Za-z_][A-Za-z_0-9]*)(?P=quote)")


def facade_aliases(text: str, package: str, submodules: frozenset[str] = frozenset(),
                   parent: str = "houston.services") -> set[str]:
    """Every name in this file that IS the package being split.

    Found by reading the file's imports rather than by guessing at conventions: the
    suite calls it `lc`, `lcsvc`, `lcmod` and `lifecycle` in different places, and also
    reaches it as `envvars.lifecycle` -- another service module's own alias for the same
    package. That last form is the one that cost an afternoon: it is a write to the
    façade wearing a different name, and `monkeypatch.undo()` leaves a real attribute
    behind that blinds every later test in the process.

    `perf.lifecycle.runner` is deliberately NOT matched: the pattern requires the comma
    straight after the target, so a deeper attribute is a patch on something else.
    """
    found = {package}
    # PARENT-RELATIVE, not `houston.services`-relative. `runner`, `seed` and `compose`
    # are top-level modules, so the suite spells them `from houston import runner as
    # runnersvc` -- and a hardcoded `houston.services` matched none of those aliases,
    # leaving four façade patches in place after a split. A façade patch is the one that
    # blinds `__getattr__` for every later test in the process.
    escaped = re.escape(parent)
    dotted = rf"(?:from|import)\s+{escaped}(?:\s+import\s+|\.){package}"
    for match in re.finditer(dotted + r"\s+as\s+(\w+)", text):
        found.add(match.group(1))
    for match in re.finditer(rf"from\s+{escaped}\s+import\s+[^\n]*?"
                             rf"{package}\s+as\s+(\w+)", text):
        found.add(match.group(1))
    # `<module>.<package>` -- another module's alias for the same package.
    found |= {m.group(0) for m in re.finditer(rf"\b\w+\.{package}\b", text)}
    # AND `<alias>.<submodule>`, for every module the package has or ever had. A patch
    # is re-pointed once when the package is created and again every time its symbol
    # moves on: `_unsplit.require_docker` is right until `preconditions` exists and
    # wrong the moment it does, and the wrongness is silent -- the patch lands on a real
    # attribute of a real module that no longer has a caller.
    #
    # `_unsplit` in particular is DELETED at the end of the split, and a target naming it
    # then points at nothing at all. So the set is the map's destinations plus the
    # remainder, not the modules currently on disk -- a name has to stay matchable after
    # the file it names is gone, which is exactly when re-pointing matters most.
    #
    # It is a fixed set rather than "any segment" so that `perf.lifecycle.runner` cannot
    # be mistaken for one: `runner` is another module reached through the façade, and
    # patching it is correct.
    found |= {f"{alias}.{sub}" for alias in set(found) for sub in submodules}
    return found


def defining_module(source: str, plan: dict) -> dict[str, str]:
    """symbol -> the module that DEFINES it right now, mid-split."""
    out = {}
    for path in _sources(source, plan):
        stem = path.stem
        for name in top_level(path):
            out[name] = stem
    return out


#: The `_OWNER = {...}` literal in a package's `__init__.py`, which is the third place a
#: move has to be recorded and the only one nothing was checking.
OWNER_BLOCK = re.compile(r"^_OWNER = \{\n.*?^\}\n", re.MULTILINE | re.DOTALL)


def facade_owner_map(package: pathlib.Path) -> dict[str, str] | None:
    """The `_OWNER` map a package's `__init__.py` declares, or None if it has none."""
    init = package / "__init__.py"
    if not init.is_file():
        return None
    found = OWNER_BLOCK.search(init.read_text(encoding="utf-8"))
    if found is None:
        return None
    return ast.literal_eval(found.group(0).split("=", 1)[1].strip())


def sync_facade(table: dict, *, apply: bool) -> list[str]:
    """Rewrite each package's `_OWNER` from the tree, and report what changed.

    `_OWNER` is what the façade resolves through, so it is the decomposition as the
    running program sees it -- and while a split is in flight it changes with every
    group that moves. Maintaining it by hand alongside the move table and the test
    patches meant three places to update and two of them silently tolerated being
    stale: a symbol still mapped to `_unsplit` resolves to a module that no longer
    defines it (AttributeError, loud) or, worse, to one that still holds a copy.

    Generated from `defining_module()` -- the CURRENT tree, not the finished plan --
    so it is correct at every intermediate commit rather than only at the last one.
    """
    changes: list[str] = []
    for source, plan in table["modules"].items():
        if (REPO_ROOT / source).is_file() or not plan.get("package"):
            continue
        package = REPO_ROOT / plan["package"]
        declared = facade_owner_map(package)
        if declared is None:
            continue
        actual = defining_module(source, plan)
        # Only the names the façade is responsible for: `_ALIAS` entries are imports the
        # single-file module happened to expose and are owned by another package.
        actual = {name: module for name, module in actual.items() if not _is_dunder(name)}
        if declared == actual:
            continue
        for name in sorted(set(declared) | set(actual)):
            was, now = declared.get(name), actual.get(name)
            if was != now:
                changes.append(f"{plan['package']}: {name}: {was} -> {now}")
        if not apply:
            continue
        init = package / "__init__.py"
        body = "".join(f'    "{n}": "{m}",\n' for n, m in sorted(actual.items()))
        init.write_text(
            OWNER_BLOCK.sub(lambda _m: "_OWNER = {\n" + body + "}\n",
                            init.read_text(encoding="utf-8"), count=1),
            encoding="utf-8")
    return changes


def _is_dunder(name: str) -> bool:
    return name.startswith("__") and name.endswith("__")


def _protected_spans(text: str) -> list[tuple[int, int]]:
    """Flat offsets of every string and comment, so a scan can skip prose."""
    spans = [(tok.start, tok.end) for tok in tokenize.generate_tokens(
        io.StringIO(text).readline)
        if tok.type in (tokenize.STRING, tokenize.COMMENT)]
    offsets, pos = [], 0
    for line in text.splitlines(keepends=True):
        offsets.append(pos)
        pos += len(line)

    def flat(rowcol):
        row, col = rowcol
        return offsets[row - 1] + col

    return [(flat(a), flat(b)) for a, b in spans]


def _sub_outside_strings_finditer(pattern, text: str):
    """`pattern.finditer` over CODE only."""
    protected = _protected_spans(text)
    for match in pattern.finditer(text):
        if not any(a <= match.start() < b for a, b in protected):
            yield match


def _sub_outside_strings(pattern, repl, text: str) -> str:
    """`pattern.sub` applied to code only -- never inside a string or a comment."""
    spans = [(tok.start, tok.end) for tok in tokenize.generate_tokens(
        io.StringIO(text).readline)
        if tok.type in (tokenize.STRING, tokenize.COMMENT)]
    lines = text.splitlines(keepends=True)
    offsets, pos = [], 0
    for line in lines:
        offsets.append(pos)
        pos += len(line)
    def flat(rowcol):
        row, col = rowcol
        return offsets[row - 1] + col
    protected = [(flat(a), flat(b)) for a, b in spans]

    def guarded(match):
        start = match.start()
        if any(a <= start < b for a, b in protected):
            return match.group(0)
        return repl(match)

    return pattern.sub(guarded, text)


#: Imported names more than one module of a package binds, so the re-pointer cannot tell
#: which one a rebind means. Reported when a test actually patches one -- never guessed.
AMBIGUOUS: dict[str, list[str]] = {}


def imported_names(source: str, plan: dict) -> dict[str, str]:
    """module-level IMPORTS of a package, name -> the one module that imports it.

    A patch can REBIND a name rather than reach an attribute of it:
    `monkeypatch.setattr(k8s, "Path", fake)` replaces the name outright. Through a
    façade that write lands in the package dict, where it shadows `__getattr__` and is
    invisible to the module whose global `Path` actually is. `k8s.forward_alive` went on
    reading the real `pathlib.Path` and the test asserting a recycled pid is refused
    passed on nothing.

    Only names imported by EXACTLY ONE module are returned; anything else is ambiguous
    and left alone rather than guessed at.
    """
    seen: dict[str, set[str]] = {}
    for path in _sources(source, plan):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in tree.body:
            if isinstance(node, ast.Import):
                for a in node.names:
                    seen.setdefault((a.asname or a.name).split(".")[0],
                                    set()).add(path.stem)
            elif isinstance(node, ast.ImportFrom):
                # A sibling import is the package's own business, not an alias.
                if (node.module or "").startswith(source.rsplit("/", 1)[-1][:-3]):
                    continue
                for a in node.names:
                    seen.setdefault(a.asname or a.name, set()).add(path.stem)
    AMBIGUOUS.update({n: sorted(m) for n, m in seen.items() if len(m) > 1})
    return {n: next(iter(m)) for n, m in seen.items() if len(m) == 1}


def repoint_tests(table: dict, *, apply: bool) -> list[str]:
    """Re-point `monkeypatch.setattr(<facade>, "name", ...)` at the DEFINING module.

    Patching a module attribute only reaches a caller that resolves through that same
    module. While the package was one file the façade and the definition were the same
    module, so `monkeypatch.setattr(lc, "prunable", ...)` reached `prune()`'s own global.
    They are different modules now, and the patch lands on nothing: the test goes green
    over the real function. That is the one failure this phase cannot see, so it is
    mechanised here rather than done by hand, and re-run after every group moves.

    The façade itself must never be patched. `monkeypatch.undo()` restores by writing a
    REAL attribute into the package dict, which permanently shadows the lazy
    `__getattr__` -- so one test patching the façade blinds every later test in the
    process to patches on the owning module.
    """
    moves: list[str] = []
    unresolved: set[str] = set()
    owners: dict[str, str] = {}
    #: package -> {symbol: (package, module)}. The target names the package; the symbol
    #: is only unambiguous inside it.
    by_package: dict[str, dict] = {}
    for source, plan in table["modules"].items():
        # ONLY a module that has already become a package. While the source is still one
        # file the façade IS the defining module, so `monkeypatch.setattr(k8s, ...)` is
        # correct and re-pointing it would be churn at best -- and at worst an import of
        # a module that does not exist yet.
        if (REPO_ROOT / source).is_file():
            continue
        package_name = plan["package"].rsplit("/", 1)[-1]
        # PER PACKAGE, not one flat map. `write` is owned by `record` in `runner` and by
        # `spec` in `edge`; a single map lets the last package read win, and the
        # re-pointer then rewrote `lc.runner.record.write` to
        # `lc.runner.record.spec.write` -- a module that does not exist, in a package
        # that was never the target. Twenty-one tests failed at once.
        by_package.setdefault(package_name, {}).update(
            {n: (package_name, m) for n, m in defining_module(source, plan).items()})
        owners.update({n: (package_name, m)
                       for n, m in defining_module(source, plan).items()})
        # A rebind of an imported name belongs to the module that imports it. Added
        # AFTER the defined symbols so a real symbol always wins the name.
        for name, module in imported_names(source, plan).items():
            owners.setdefault(name, (package_name, module))
            by_package.setdefault(package_name, {}).setdefault(name,
                                                               (package_name, module))
    #: package -> every module it holds, has held, or is planned to hold, so a target
    #: naming one has it REPLACED rather than appended -- including after that module has
    #: been deleted.
    submodules: dict[str, frozenset[str]] = {}
    #: package -> the dotted parent it is imported from, so an alias is recognised
    #: whatever depth the module sits at.
    parents: dict[str, str] = {}
    for source, plan in table["modules"].items():
        if (REPO_ROOT / source).is_file() or not plan.get("package"):
            continue
        name = plan["package"].rsplit("/", 1)[-1]
        parents[name] = plan["package"].rsplit("/", 1)[0].replace("/", ".")
        submodules[name] = (submodules.get(name, frozenset())
                            | set(plan["tiers"]) | {REMAINDER})
    for package, module in owners.values():
        submodules[package] = submodules.get(package, frozenset()) | {module}
    #: package -> its `_ALIAS` map, so an alias one façade gives another is recognised.
    cross: dict[str, dict[str, str]] = {}
    for source, plan in table["modules"].items():
        if (REPO_ROOT / source).is_file() or not plan.get("package"):
            continue
        init = REPO_ROOT / plan["package"] / "__init__.py"
        if not init.is_file():
            continue
        found_alias = re.search(r"^_ALIAS(?::[^=]+)? = \{\n.*?^\}",
                                init.read_text(encoding="utf-8"),
                                re.MULTILINE | re.DOTALL)
        if found_alias:
            cross[plan["package"].rsplit("/", 1)[-1]] = ast.literal_eval(
                found_alias.group(0).split("=", 1)[1].strip())

    for path in sorted((REPO_ROOT / "tests").rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        aliases = set()
        #: alias spelling -> the package it names, so `swap` resolves in the right one.
        by_alias: dict[str, str] = {}
        for package, held in submodules.items():
            found = facade_aliases(text, package, held, parents.get(package, ""))
            # A FAÇADE REACHED THROUGH ANOTHER FAÇADE'S ALIAS. `lifecycle._ALIAS` maps
            # `edgesvc` to `houston.services.edge`, so `lc.edgesvc.detach` is a patch on
            # the EDGE façade wearing a name the edge package never chose -- and no
            # pattern built from the edge's own spelling can see it. Two of these blinded
            # every later test that touched pruning, readiness or sizing.
            for other, entries in cross.items():
                for key, target in entries.items():
                    if target.rsplit(".", 1)[-1] != package:
                        continue
                    for spelling in facade_aliases(text, other, frozenset(),
                                                   parents.get(other, "")):
                        found.add(f"{spelling}.{key}")
            aliases |= found
            for spelling in found:
                by_alias[spelling] = package
        needed: set[tuple[str, str]] = set()

        def swap(match, aliases=aliases, by_alias=by_alias):
            name = match.group("name")
            target = match.group("target")
            if target not in aliases:
                return match.group(0)
            # Which package does this target name? Resolve the symbol inside THAT one.
            found = by_package.get(by_alias.get(target, ""), {}).get(name)
            if found is None:
                return match.group(0)
            package, module = found
            current = match.group("target")
            # Strip a submodule the target already names, so `bk.lifecycle._unsplit`
            # becomes `bk.lifecycle.preconditions` rather than
            # `bk.lifecycle._unsplit.preconditions`.
            head = current.rsplit(".", 1)[0] \
                if current.rsplit(".", 1)[-1] in submodules.get(package, ()) else current
            target = f"{head}.{module}"
            if target == current:
                return match.group(0)  # already pointed at the defining module
            needed.add(target)
            moves.append(f"{path.name}: {current}.{name} -> {target}.{name}")
            # The package's `__getattr__` resolves its own submodules, so the file needs
            # no new import -- which matters: four of these test files are already over
            # the size cap the ratchet holds them to, and a mechanical re-point must not
            # be the thing that pushes them further over.
            head_call = match.group(0).split("(", 1)[0]
            return f'{head_call}({target}, "{name}"'

        # ONLY REAL CODE. `PATCH` is a regex, and a regex matches the same letters in a
        # docstring that explains the hazard as happily as in the patch that has it --
        # which it did, rewriting the sentence in `test_frozen.py` that documents this
        # very re-pointer. Tokenising first means a string or a comment is never edited.
        # A patch whose ATTRIBUTE NAME IS COMPUTED cannot be re-pointed mechanically --
        # `monkeypatch.setattr(lc.runner, name, ...)` in a loop names nothing the tool
        # can resolve. Reported so a person decides, rather than left on the façade
        # where it blinds `__getattr__` for the rest of the process.
        for match in COMPUTED.finditer(text):
            if match.group("target") in aliases:
                unresolved.add(f"{path.name}:{text[:match.start()].count(chr(10)) + 1}: "
                               f"{match.group('target')} patched with a computed name")
        for match in PATCH.finditer(text):
            name = match.group("name")
            if name in AMBIGUOUS and match.group("target") in aliases \
                    and name not in owners:
                unresolved.add(
                    f"{path.name}: {match.group('target')}.{name} -- "
                    f"{', '.join(AMBIGUOUS[name])} all import it")
        new = _sub_outside_strings(PATCH, swap, text)
        if not needed or not apply:
            continue
        path.write_text(new, encoding="utf-8")
    for line in sorted(unresolved):
        # A rebind the tree cannot resolve is a question about the TEST -- which module
        # holds the function under test -- and a silent skip is how such a patch ends up
        # on a module that no longer does. Named, so it is answered rather than missed.
        print(f"  ambiguous rebind, re-point by hand: {line}", file=sys.stderr)
    return moves


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="gate the map against the tree")
    ap.add_argument("--render", action="store_true", help="rewrite the markdown table")
    ap.add_argument("--repoint-tests", action="store_true",
                    help="rewrite every facade monkeypatch to the module that defines "
                         "the symbol right now")
    ap.add_argument("--sync-facade", action="store_true",
                    help="rewrite each package's _OWNER map from the current tree")
    ap.add_argument("--inventory", metavar="PATH",
                    help="print one module's top-level symbols as JSON and exit")
    args = ap.parse_args()

    if args.inventory:
        json.dump(top_level(REPO_ROOT / args.inventory), sys.stdout, indent=1)
        sys.stdout.write("\n")
        return 0

    table = load_table()
    if args.sync_facade:
        changes = sync_facade(table, apply=True)
        print(f"re-owned {len(changes)} name(s)")
        for line in changes[:10]:
            print(f"  {line}")
        return 0
    if args.repoint_tests:
        moves = repoint_tests(table, apply=True)
        print(f"re-pointed {len(moves)} patch site(s)")
        for line in moves[:10]:
            print(f"  {line}")
        return 0
    found = problems(table)
    if args.render and not found:
        RENDERED.parent.mkdir(parents=True, exist_ok=True)
        RENDERED.write_text(render(table), encoding="utf-8")
        print(f"wrote {RENDERED.relative_to(REPO_ROOT)}")
    if found:
        print(f"{len(found)} problem(s) with the move table:", file=sys.stderr)
        for line in found:
            print(f"  {line}", file=sys.stderr)
        return 1
    total = sum(len(p["symbols"]) for p in table["modules"].values())
    print(f"move table: {total} symbols assigned across "
          f"{len(table['modules'])} module(s); no unassigned symbol, no upward import")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
