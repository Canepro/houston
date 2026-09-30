"""Which module does each test actually test, and where would its spec file live.

`tests/test_services.py` is 16,244 lines and 503 tests. Splitting it by hand is a
thousand small judgements nobody can review, so this makes the judgement explicit first:
every test is attributed to the `houston.*` module it references most, with a confidence,
and the table is reviewed AS A TABLE before anything moves.

**A count is not a check.** One lost test plus one accidental duplicate leaves the total
unchanged, so `--snapshot` records the collected node IDs and `--check-moves` compares
the multiset after the translation is applied. That is the only evidence that a move
moved exactly what it said.
"""
from __future__ import annotations

import argparse
import ast
import json
import pathlib
import subprocess
import sys
from collections import Counter

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTS = REPO_ROOT / "tests"
TABLE = REPO_ROOT / "tools" / "test-attribution.json"
SNAPSHOT = REPO_ROOT / "tools" / "test-nodes.json"

#: The files steps 2b.12-2b.16 take apart: every test module over the 800-line cap.
#: Each is named for a LAYER rather than a unit, which is what makes a failure in it
#: point at "the services" or "the HTTP API" and nothing narrower.
SPLIT_TARGETS = ("tests/test_services.py", "tests/test_core.py", "tests/test_web.py",
                 "tests/test_edge.py", "tests/test_backup.py", "tests/test_browser.py")

#: A test may only be attributed to a module that EXISTS. A typo in the table would
#: otherwise create a spec file for a module nobody wrote.
def houston_modules() -> set[str]:
    out = set()
    for path in (REPO_ROOT / "houston").rglob("*.py"):
        parts = list(path.relative_to(REPO_ROOT / "houston").with_suffix("").parts)
        if parts and parts[-1] == "__init__":
            parts.pop()
        if parts:
            out.add(".".join(parts))
    return out


def _aliases(tree: ast.Module) -> dict[str, str]:
    """local name -> `houston.*` module, from this file's imports.

    The suite reaches the same module under many names -- `k8s`, `k8ssvc`, `lc`, `lcsvc`
    -- and counting the ALIAS rather than the module would attribute the same test
    differently depending on which file it sits in.
    """
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.startswith("houston"):
                    out[a.asname or a.name.split(".")[0]] = a.name[len("houston."):] \
                        if a.name != "houston" else ""
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if not mod.startswith("houston"):
                continue
            base = mod[len("houston."):] if mod != "houston" else ""
            for a in node.names:
                full = f"{base}.{a.name}" if base else a.name
                out[a.asname or a.name] = full
    return out


def facade_owners() -> dict[str, dict[str, str]]:
    """package -> {symbol: owning module}, read from each façade's generated `_OWNER`.

    Without this, every test that patches `k8s.namespace_for` attributes to
    `services.k8s` -- the PACKAGE -- and the table says "put 206 tests in one file",
    which is the file we are trying to get rid of. The façade knows which module owns
    each name; `tools/move_table.py --sync-facade` keeps that map true.
    """
    import re
    out: dict[str, dict[str, str]] = {}
    for init in (REPO_ROOT / "houston").rglob("__init__.py"):
        text = init.read_text(encoding="utf-8")
        found = re.search(r"^_OWNER = \{\n.*?^\}", text, re.MULTILINE | re.DOTALL)
        if not found:
            continue
        package = ".".join(init.parent.relative_to(REPO_ROOT / "houston").parts)
        out[package] = ast.literal_eval(found.group(0).split("=", 1)[1].strip())
    return out


def _resolve(dotted: str, known: set[str], owners: dict[str, dict[str, str]]) -> str | None:
    """The most specific module a dotted reference names."""
    bits = dotted.split(".")
    for cut in range(len(bits), 0, -1):
        cand = ".".join(bits[:cut])
        if cand not in known:
            continue
        # Through the façade: `services.k8s` + `namespace_for` -> `services.k8s.namespace`.
        if cand in owners and cut < len(bits):
            module = owners[cand].get(bits[cut])
            if module and f"{cand}.{module}" in known:
                return f"{cand}.{module}"
            # A name the façade re-exports from somewhere else -- `k8s.subprocess` is
            # `houston.exec` -- says nothing about which module the test is about, and
            # counting it as the PACKAGE is how 142 tests came to be attributed to the
            # file this whole step exists to delete. Not counted at all.
            return None
        return cand
    return None


def references(fn: ast.AST, aliases: dict[str, str], known: set[str],
               owners: dict[str, dict[str, str]] | None = None) -> Counter:
    """How often this test reaches into each houston module."""
    seen: Counter = Counter()
    # `ast.walk` yields an Attribute AND the Name at its root, so counting both scored
    # every `k8s.namespace_for` once for `namespace` and once for the bare PACKAGE --
    # which is how 149 tests were attributed to the file this step exists to delete.
    inner = {id(n.value) for n in ast.walk(fn) if isinstance(n, ast.Attribute)}
    for node in ast.walk(fn):
        if isinstance(node, ast.Attribute):
            root, parts = node, []
            while isinstance(root, ast.Attribute):
                parts.append(root.attr)
                root = root.value
            if not isinstance(root, ast.Name):
                continue
            base = aliases.get(root.id)
            if base is None:
                continue
            dotted = ".".join([base] + list(reversed(parts))) if base else \
                ".".join(reversed(parts))
            found = _resolve(dotted, known, owners or {})
            if found:
                seen[found] += 1
        elif isinstance(node, ast.Name) and id(node) not in inner:
            base = aliases.get(node.id)
            if base in known:
                seen[base] += 1
    return seen


def file_helpers(tree: ast.Module) -> set[str]:
    """Module-level names in a test file that are not themselves tests.

    A test cannot move without them. `tests/test_services.py` has `_completed`,
    `_kube_probe_stubs` and two dozen more, and a move that leaves one behind produces a
    NameError in a file that otherwise looks finished -- which the node-ID check cannot
    see, because a test that fails to import is a test that does not collect.
    """
    out = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if not node.name.startswith("test_"):
                out.add(node.name)
            # A fixture is a def like any other; it is its NAME that a test requests.
        elif isinstance(node, ast.Assign):
            out |= {s.id for tgt in node.targets for s in ast.walk(tgt)
                    if isinstance(s, ast.Name) and isinstance(s.ctx, ast.Store)}
    return out


def attribute(path: pathlib.Path, known: set[str],
              owners: dict[str, dict[str, str]] | None = None) -> list[dict]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    aliases = _aliases(tree)
    helpers = file_helpers(tree)
    rows = []
    for node in tree.body:
        if not (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name.startswith("test_")):
            continue
        counts = references(node, aliases, known, owners)
        total = sum(counts.values())
        top, hits = (counts.most_common(1) or [(None, 0)])[0]
        runner_up = (counts.most_common(2)[1][1] if len(counts) > 1 else 0)
        rows.append({
            "test": node.name,
            "file": str(path.relative_to(REPO_ROOT)),
            "module": top,
            "hits": hits,
            "total": total,
            # Confidence is the MARGIN, not the share: a test that touches two modules
            # nine times each is not 50% confident, it is undecided, and the difference
            # matters because that is exactly the row a person has to look at.
            "margin": hits - runner_up,
            "share": round(hits / total, 2) if total else 0.0,
            "spread": len(counts),
            #: File-local helpers this test needs. It cannot move without them.
            #:
            #: A pytest FIXTURE is requested by PARAMETER NAME and never appears as a
            #: `Name` load in the body, so a scan of the body alone reports the test as
            #: free to move -- and it then fails at collection with "fixture not found",
            #: which the node-ID check reads as a test that simply vanished.
            "needs": sorted({n.id for n in ast.walk(node)
                             if isinstance(n, ast.Name) and n.id in helpers}
                            | {a.arg for a in node.args.args + node.args.kwonlyargs
                               if a.arg in helpers}),
            # BOTH signals, and they have to agree. The margin says "this module wins by
            # more than a rounding error"; the share says "this test is mostly about that
            # module rather than incidentally touching it". Either alone accepts a test
            # that references six modules four times each and one of them five.
            "confident": bool(top) and (hits - runner_up) >= 2 and total
            and hits / total >= 0.6,
        })
    return rows


def spec_path(module: str) -> str:
    """Where the spec file for `houston.<module>` lives, mirroring the source tree."""
    parts = module.split(".")
    return "/".join(["tests"] + parts[:-1] + [f"test_{parts[-1]}.py"])


def node_ids() -> list[str]:
    res = subprocess.run(
        [".venv/bin/python", "-m", "pytest", "-q", "-p", "no:cacheprovider",
         "--collect-only", "--no-header"],
        cwd=REPO_ROOT, capture_output=True, text=True)
    ids = [ln.strip() for ln in res.stdout.splitlines()
           if "::" in ln and ln.strip().startswith("tests/")]
    if not ids:
        raise SystemExit(f"collected nothing; pytest said:\n{res.stdout[-2000:]}")
    return sorted(ids)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", action="store_true", help="write the attribution table")
    ap.add_argument("--snapshot", action="store_true",
                    help="record the collected node IDs as they are now. Re-taken after "
                         "a step that legitimately ADDS tests -- the snapshot answers "
                         "'did this move lose anything', and a new test is not a lost "
                         "one. Take it before a move, check it after, re-take it once "
                         "the check has passed")
    ap.add_argument("--verify-snapshot", action="store_true",
                    help="compare collected node IDs against the snapshot WITHOUT the "
                         "translation; what 2b.12 asserts, before anything moves")
    ap.add_argument("--check-moves", action="store_true",
                    help="compare the collected node IDs against the snapshot, applying "
                         "the recorded translation")
    ap.add_argument("--review", action="store_true",
                    help="print the rows a person has to decide")
    args = ap.parse_args()
    known = houston_modules()
    owners = facade_owners()

    if args.build:
        rows = []
        for path in sorted(TESTS.glob("test_*.py")):
            rows += attribute(path, known, owners)
        for row in rows:
            row["spec"] = spec_path(row["module"]) if row["module"] else None
        # THE TRANSLATION, recorded with the table so `--check-moves` can apply it: a
        # node ID that moved is not a node ID that went away.
        # ONLY the file this step exists to take apart. The table attributes every test
        # in the suite, which is useful to read -- but `tests/test_edge.py` is 2,255
        # lines about one subject and moving it would be churn, not co-location.
        #
        # AND ONLY tests that need no file-local helper. Every one of the 19 helpers the
        # rest depend on is still used by tests that are staying, so moving a helper
        # breaks them and duplicating it makes two copies that drift. Promoting them to
        # `conftest.py` is the obvious third option and the phase file forbids it --
        # conftest stays unchanged, because the three autouse fixtures reaching every
        # subdirectory is the property the whole layout rests on. So a test that shares a
        # helper with twenty tests that are staying is a test whose home is still that
        # file, and that is the hand-placement decision rather than an omission.
        moves = {f"{r['file']}::{r['test']}": f"{r['spec']}::{r['test']}"
                 for r in rows
                 if r["confident"] and r["spec"] and r["file"] in SPLIT_TARGETS
                 and not r["needs"]}
        # A REBUILD MUST NOT CLOBBER THE TRANSLATION. After the move the rows describe
        # where the tests are NOW, so regenerating `moves` from them maps each test to
        # itself -- and `--check-moves` then reports every moved test as both missing
        # from its old home and unexpected in its new one. The translation is written
        # once, before anything moves, and kept.
        if TABLE.exists():
            moves = json.loads(TABLE.read_text(encoding="utf-8")).get("moves") or moves
        TABLE.write_text(json.dumps({"rows": rows, "moves": moves}, indent=1) + "\n",
                         encoding="utf-8")
        low = [r for r in rows if not r["confident"]]
        print(f"attributed {len(rows)} tests across "
              f"{len({r['file'] for r in rows})} files; "
              f"{len(rows) - len(low)} high-confidence, {len(low)} need a decision")
        return 0

    if args.snapshot:
        ids = node_ids()
        SNAPSHOT.write_text(json.dumps({"nodes": ids}, indent=1) + "\n", encoding="utf-8")
        print(f"snapshot: {len(ids)} node IDs")
        return 0

    if args.review:
        rows = json.loads(TABLE.read_text(encoding="utf-8"))["rows"]
        low = [r for r in rows if not r["confident"]]
        print(f"{len(low)} row(s) need a decision (no module, or a margin under 2):\n")
        for r in sorted(low, key=lambda r: (r["file"], r["test"])):
            print(f"  {r['file']}::{r['test']}\n"
                  f"      module={r['module']} hits={r['hits']} "
                  f"margin={r['margin']} share={r['share']} spread={r['spread']}")
        return 0

    if args.verify_snapshot:
        want = Counter(json.loads(SNAPSHOT.read_text(encoding="utf-8"))["nodes"])
        have = Counter(node_ids())
        missing, extra = want - have, have - want
        if missing or extra:
            print(f"{sum(missing.values())} missing, {sum(extra.values())} unexpected",
                  file=sys.stderr)
            for n in sorted(missing)[:10]:
                print(f"  MISSING  {n}", file=sys.stderr)
            for n in sorted(extra)[:10]:
                print(f"  EXTRA    {n}", file=sys.stderr)
            return 1
        print(f"snapshot still describes the suite exactly: {sum(have.values())} tests")
        return 0

    if args.check_moves:
        want = json.loads(SNAPSHOT.read_text(encoding="utf-8"))["nodes"]
        table = json.loads(TABLE.read_text(encoding="utf-8"))
        moves = table.get("moves", {})
        translated = Counter(moves.get(n, n) for n in want)
        have = Counter(node_ids())
        # An ADDITION is not a discrepancy. The snapshot is the suite as it stood
        # before anything moved, and this phase adds tests as well as moving them --
        # a new leaf gains a parametrised case, a new module gains a spec. Declaring
        # each one keeps "nothing was LOST" strict, which is the property that
        # matters: an undeclared extra is still reported.
        added = Counter(table.get("added", []))
        missing = translated - have
        extra = have - translated - added
        vanished = added - (have - translated)
        if vanished:
            print(f"{sum(vanished.values())} declared addition(s) are not in the suite",
                  file=sys.stderr)
            for n in sorted(vanished):
                print(f"  ABSENT   {n}", file=sys.stderr)
            return 1
        if not missing and not extra:
            print(f"node IDs match the snapshot exactly: {sum(have.values())} tests")
            return 0
        # A COUNT IS NOT A CHECK. Report both directions, because one lost test plus one
        # accidental duplicate leaves the total unchanged.
        print(f"{sum(missing.values())} missing, {sum(extra.values())} unexpected "
              f"(totals: snapshot {sum(translated.values())}, now {sum(have.values())})",
              file=sys.stderr)
        for n in sorted(missing)[:20]:
            print(f"  MISSING  {n}", file=sys.stderr)
        for n in sorted(extra)[:20]:
            print(f"  EXTRA    {n}", file=sys.stderr)
        return 1

    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
