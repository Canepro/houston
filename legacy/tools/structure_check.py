#!/usr/bin/env python
"""The file-size and shape caps, as a script rather than a paragraph.

    .venv/bin/python tools/structure_check.py
    .venv/bin/python tools/structure_check.py --json
    .venv/bin/python tools/structure_check.py --ratchet
    .venv/bin/python tools/structure_check.py --update

The owner's stated goal for this port is "migrate to complete to maintain easily", and
these are the caps that make that mechanical instead of aspirational. Nothing here is a
style preference; each rule has a specific failure behind it.

**Why the measurement ships as code.** Three independent measurements of this tree
returned 22,318 / 21,127 / 23,317 code lines, and a fourth 21,941. All four are
defensible and all four differ, by up to 2,190 lines. That spread is the finding: a rule
stated in prose and measured by whoever is asking cannot ratchet, because every
re-measurement moves the goalposts. So the definition IS this file, and the number it
prints is the only number that counts.

**Code lines = physical - blank - standalone-comment - docstring**, computed as a SET of
line numbers rather than three subtractions, because a blank line inside a docstring
would otherwise be removed twice and the count would drift below the truth.

**Counting code and not raw lines is load-bearing.** This package is 53% code and 47%
prose. Under a raw-line cap, the cheapest way to a green build is deleting the invariant
docstrings -- and in this repository those docstrings are the spec: `services/edge.py`
records six mechanisms a wrong design needed to compensate for, `web/signin.py` gives
three reasons it is server-rendered. A cap that makes deleting the reasoning the shortest
path to passing is worse than no cap.

**Cyclomatic complexity is also defined here**, McCabe-style: one, plus every `if`,
`for`, `while`, `except`, `assert`, conditional expression, comprehension condition,
`match` case, and each extra operand of an `and`/`or`. Another number nobody can agree on
by discussion, so it is likewise settled by the code that measures it -- and it needed to
be. `FINDINGS.md` §4 records 383 for `create_app`, 220 for `run_checks` and 124 for
`_create_repro_locked`; this file measures 283, 195 and 99. The ratios are not even
constant, so it is a difference of definition rather than of scale, and it is the same
variance §4 already documented for line counts, recurring for complexity. This measure is
the LOWER of the two, so a function between the two definitions' thresholds would pass
here and fail there. That is the known cost of settling on one definition, and settling
is still better than four.

The raw-span figures, by contrast, agree exactly -- 2,091, 1,044 and 503 -- which is what
says the AST walk itself is right and only the scoring differs.

**The ratchet only ever goes down.** `--ratchet` fails when any count exceeds the
baseline; `--update` refuses to write a baseline that raises one. A gate that can be
re-baselined upward is a log, not a gate.

Every violation is reported, grouped by rule and sorted by overage. Reporting the first
one turns a structural audit into a queue of 200 one-line fixes discovered one run at a
time.
"""
from __future__ import annotations

import argparse
import ast
import json
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = "houston"
TESTS = "tests"
DEFAULT_BASELINE = REPO_ROOT / "tools" / "structure-baseline.json"

MODULE_CODE_LINES = 600
TEST_CODE_LINES = 800
FUNCTION_RAW_SPAN = 60
CYCLOMATIC = 25
PUBLIC_SYMBOLS = 20

FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)

# Why each rule exists, printed with its violations so a gate firing in six months
# teaches rather than merely refuses. This repo's tests are written the same way.
WHY = {
    "module_code_lines":
        f"a module over {MODULE_CODE_LINES} code lines cannot be read in one sitting, and "
        f"every one of them here is also a module the port has to split before its tests "
        f"can move (FINDINGS.md §3)",
    "test_code_lines":
        f"a test file over {TEST_CODE_LINES} code lines hides which layer a failure is in; "
        f"tests/test_services.py holds 505 test functions",
    "function_raw_span":
        f"a function over {FUNCTION_RAW_SPAN} raw lines has no name for most of what it "
        f"does; `_create_repro_locked` is 503 lines and `create_app` 2,091",
    "cyclomatic":
        f"over {CYCLOMATIC} branches, the paths outnumber any test suite anybody will "
        f"write for it",
    "public_symbols":
        f"over {PUBLIC_SYMBOLS} public top-level functions and classes is a module with no "
        f"interface, only a surface -- services/k8s.py exports 154",
    "untested_module":
        "no test names this module in an import, so no failure will ever point at it. It "
        "may still run -- seven of the nine here are preset builders reached through "
        "`_dynamic_builders()`, and web/signin.py is rendered over HTTP by the browser "
        "suite -- but nothing imports it, which is the checkable form of \"a co-located "
        "test exists\" until phase 02b makes adjacency literal",
    "reexport_only_barrel":
        "a module that only re-exports gives every importer a second name for the same "
        "thing and hides the real dependency from the layer gate",
}


def non_code_lines(tree: ast.Module, text: str) -> set[int]:
    """Line numbers that are blank, a standalone comment, or inside a docstring.

    A set, not three counters: a blank line inside a docstring belongs to both
    categories and must be removed once.
    """
    dead: set[int] = set()
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            dead.add(number)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef) + FUNCTIONS):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            dead.update(range(first.lineno, (first.end_lineno or first.lineno) + 1))
    return dead


def cyclomatic(node: ast.AST) -> int:
    """McCabe complexity of one function. The definition is this function."""
    score = 1
    for child in ast.walk(node):
        if isinstance(child, (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While,
                              ast.ExceptHandler, ast.Assert)):
            score += 1
        elif isinstance(child, ast.BoolOp):
            score += len(child.values) - 1
        elif isinstance(child, ast.comprehension):
            score += len(child.ifs)
        elif isinstance(child, ast.match_case):
            score += 1
    return score


def public_top_level(tree: ast.Module) -> list[str]:
    """Public functions and classes this module DEFINES at top level.

    Two exclusions, both deliberate.

    *Imported names.* A re-export is caught by the barrel rule, and counting it here
    would charge a module for its dependencies' surface as well as its own.

    *Module-level constants.* `services/k8s.py` defines 146 public functions and 8
    public classes -- which is 154, the number this rule is calibrated against -- plus
    112 public names like `MONGO_URL`, `REACH_OK` and `POD_WAIT_TRIES`. Counting those
    would put it at 273 and, worse, would make the cheapest way to pass moving a
    registry of named constants into an anonymous dict. That is the same perverse
    incentive as counting comment lines toward a size cap: it buys a green build by
    deleting the thing that made the code legible. A module with twenty entry points is
    hard to use; a module with a hundred named constants is not.
    """
    return [node.name for node in tree.body
            if isinstance(node, FUNCTIONS + (ast.ClassDef,))
            and not node.name.startswith("_")]


def is_reexport_only(tree: ast.Module) -> bool:
    """True when nothing happens in this module except handing names onward.

    A docstring, `from __future__`, imports and `__all__` only. It must actually import
    something from inside the package, or every trivially empty file would qualify.
    """
    reexports = False
    for index, node in enumerate(tree.body):
        if index == 0 and isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            continue
        if isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] == PACKAGE or node.level:
                reexports = True
            continue
        if isinstance(node, ast.Import):
            continue
        if isinstance(node, ast.Assign) and all(
                isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
            continue
        return False
    return reexports


def module_name(path: pathlib.Path) -> str:
    parts = list(path.relative_to(REPO_ROOT).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts) or PACKAGE


def imported_by_tests() -> set[str]:
    """Every package module named by an import anywhere under `tests/`.

    Both module-level and function-body imports count -- the suite patches through
    function-body imports constantly, and an import inside a test body is still the
    suite reaching that module.
    """
    seen: set[str] = set()
    for path in sorted((REPO_ROOT / TESTS).rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] == PACKAGE:
                        seen.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if base.split(".")[0] != PACKAGE:
                    continue
                seen.add(base)
                for alias in node.names:
                    seen.add(f"{base}.{alias.name}")
    return seen


def check() -> dict[str, list[dict]]:
    found: dict[str, list[dict]] = {rule: [] for rule in WHY}
    tested = imported_by_tests()

    def measure(path: pathlib.Path) -> tuple[ast.Module, int]:
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(path))
        total = len(text.splitlines())
        return tree, total - len(non_code_lines(tree, text) & set(range(1, total + 1)))

    def add(rule: str, subject: str, value: int, limit: int, detail: str = "",
            line: int = 0) -> None:
        """`subject` is the ratchet's IDENTITY and must not contain a line number.

        The first version keyed functions as `path:LINE name`, which made every
        subject unstable under any edit above it: deleting the `benchmark` command in
        step 0.12 moved thirteen unrelated functions down the file, and the ratchet
        reported all thirteen as GONE and thirteen new ones as newly in violation --
        on a change that only ever removed code. A ratchet that fires on every
        insertion above a violation is one people switch off. The line is still
        reported, as data rather than as identity.
        """
        found[rule].append({"subject": subject, "value": value, "limit": limit,
                            "overage": value - limit, "detail": detail, "line": line})

    for path in sorted((REPO_ROOT / PACKAGE).rglob("*.py")):
        rel = str(path.relative_to(REPO_ROOT))
        tree, code = measure(path)
        name = module_name(path)

        if code > MODULE_CODE_LINES:
            add("module_code_lines", rel, code, MODULE_CODE_LINES)
        public = public_top_level(tree)
        if len(public) > PUBLIC_SYMBOLS:
            add("public_symbols", rel, len(public), PUBLIC_SYMBOLS,
                f"first few: {', '.join(sorted(public)[:5])}")
        if name not in tested:
            add("untested_module", rel, 1, 0, f"no test imports {name}")
        if is_reexport_only(tree):
            add("reexport_only_barrel", rel, 1, 0, "imports and __all__ only")

        for node in ast.walk(tree):
            if not isinstance(node, FUNCTIONS):
                continue
            span = (node.end_lineno or node.lineno) - node.lineno + 1
            if span > FUNCTION_RAW_SPAN:
                add("function_raw_span", f"{rel}::{node.name}", span, FUNCTION_RAW_SPAN,
                    line=node.lineno)
            score = cyclomatic(node)
            if score > CYCLOMATIC:
                add("cyclomatic", f"{rel}::{node.name}", score, CYCLOMATIC,
                    line=node.lineno)

    for path in sorted((REPO_ROOT / TESTS).rglob("*.py")):
        _, code = measure(path)
        if code > TEST_CODE_LINES:
            add("test_code_lines", str(path.relative_to(REPO_ROOT)), code, TEST_CODE_LINES)

    for rule in found:
        found[rule].sort(key=lambda v: (-v["overage"], v["subject"]))
    return found


def strict_problems(prefix: str | None, *, max_module_lines: int | None,
                    max_test_lines: int | None,
                    max_function_lines: int | None) -> list[str]:
    """Measure absolute caps for a subtree; unlike the baseline ratchet, allow no debt."""
    selected_prefix = (prefix or "").strip("/")
    paths = sorted((REPO_ROOT / PACKAGE).rglob("*.py"))
    paths += sorted((REPO_ROOT / TESTS).rglob("*.py"))
    problems: list[str] = []
    for path in paths:
        rel = str(path.relative_to(REPO_ROOT))
        stem = rel.removesuffix(".py")
        if selected_prefix and not (stem == selected_prefix
                                    or rel.startswith(selected_prefix + "/")):
            continue
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(path))
        total = len(text.splitlines())
        code = total - len(non_code_lines(tree, text) & set(range(1, total + 1)))
        is_test = rel == TESTS or rel.startswith(TESTS + "/")
        module_limit = max_module_lines if (selected_prefix or not is_test) else max_test_lines
        if module_limit is not None and code > module_limit:
            problems.append(f"{rel}: {code} code lines, maximum {module_limit}")
        if max_function_lines is not None:
            for node in ast.walk(tree):
                if isinstance(node, FUNCTIONS):
                    span = (node.end_lineno or node.lineno) - node.lineno + 1
                    if span > max_function_lines:
                        problems.append(
                            f"{rel}:{node.lineno} {node.name}: {span} raw lines, "
                            f"maximum {max_function_lines}")
    if selected_prefix and not any(
            str(path.relative_to(REPO_ROOT)).removesuffix(".py") == selected_prefix
            or str(path.relative_to(REPO_ROOT)).startswith(selected_prefix + "/")
            for path in paths):
        problems.append(f"{selected_prefix}: no Python files selected")
    return problems


def render(found: dict[str, list[dict]]) -> str:
    out: list[str] = []
    total = sum(len(v) for v in found.values())
    out.append(f"{total} violations across {len(found)} rules "
               f"(code lines = physical - blank - standalone-comment - docstring)")
    for rule, violations in found.items():
        out.append("")
        if not violations:
            out.append(f"  {rule}: none")
            continue
        out.append(f"  {rule}: {len(violations)}  -- {WHY[rule]}")
        for v in violations:
            where = v["subject"] + (f"  (line {v['line']})" if v.get("line") else "")
            if v["limit"]:
                line = (f"      {v['value']:>6} (limit {v['limit']}, over by "
                        f"{v['overage']:>5})  {where}")
            else:
                line = f"      {where}"
            if v["detail"]:
                line += f"  [{v['detail']}]"
            out.append(line)
    return "\n".join(out)


def counts(found: dict[str, list[dict]]) -> dict[str, int]:
    return {rule: len(violations) for rule, violations in found.items()}


def worst(found: dict[str, list[dict]]) -> dict[str, dict[str, int]]:
    """The largest value per SUBJECT, so the ratchet catches one file getting worse
    while the violation COUNT stays level.

    Per subject rather than one number per rule, and that distinction was paid for. The
    first version recorded `{rule: max}`, so the only way to let one file legitimately
    grow was to raise the cap for EVERY file under that rule -- which came up
    immediately: step 0.11 added four lines to `cli.py`, already the worst module at
    3,144, and accepting that would have silently licensed `k8s.py` and `lifecycle.py`
    to grow to 3,148 as well. A ratchet that loosens seven files to permit one is not a
    ratchet.
    """
    out: dict[str, dict[str, int]] = {}
    for rule, violations in found.items():
        per: dict[str, int] = {}
        for v in violations:
            per[v["subject"]] = max(per.get(v["subject"], 0), v["value"])
        out[rule] = per
    return out


def rename_subjects(baseline: dict, pairs: list[tuple[str, str]]) -> list[str]:
    """Rewrite baseline subjects for files that MOVED, keeping every recorded value.

    A subject is `path` or `path::function`, and the ratchet's whole meaning rests on
    that identity being stable under edits -- which is why the line number was dropped
    from it in step 0.12, after deleting one command made thirteen untouched functions
    look newly broken. A file MOVE is the same event one level up: phase 2a relocates
    `create_app`'s handlers and `cli.py`'s commands without changing a line of them, and
    every one would otherwise read as a new violation while its old subject vanished.

    This renames and NOTHING else. The value recorded against each subject is carried
    across unchanged, so the comparison that follows still has to pass on its own: a
    function that moved AND grew fails exactly as it would have in place. There is no
    way to raise a number here, which is the property that keeps `--rename` from being
    a re-baseline with a nicer name.
    """
    moved: list[str] = []
    # MOST SPECIFIC FIRST. A bare `a/b.py=c/d.py` pair also matches `a/b.py::fn`, so a
    # run that renames a file AND relocates one of its functions elsewhere would have the
    # file-level pair swallow the function-level one -- silently, and depending on dict
    # order. Splitting a module does exactly that in every commit.
    pairs = sorted(pairs, key=lambda pair: -len(pair[0]))
    for rule, recorded in baseline.get("worst", {}).items():
        if not isinstance(recorded, dict):
            continue
        for old, new in pairs:
            for subject in [s for s in recorded
                            if s == old or s.startswith(old + "::")]:
                target = new + subject[len(old):]
                if target in recorded:
                    raise SystemExit(f"--rename: {rule}: {target} already exists")
                recorded[target] = recorded.pop(subject)
                moved.append(f"{rule}: {subject} -> {target} at {recorded[target]}")
        baseline["worst"][rule] = dict(
            sorted(recorded.items(), key=lambda kv: (-kv[1], kv[0])))
    return moved


def compare(found: dict[str, list[dict]], baseline: dict) -> list[str]:
    problems: list[str] = []
    base_counts = baseline.get("counts", {})
    base_worst = baseline.get("worst", {})
    for rule, count in counts(found).items():
        allowed = base_counts.get(rule)
        if allowed is not None and count > allowed:
            problems.append(f"{rule}: {count} violations, baseline allows {allowed}")
    for rule, per_subject in worst(found).items():
        recorded = base_worst.get(rule)
        if not isinstance(recorded, dict):
            # A pre-per-subject baseline. Refuse rather than guess: comparing a
            # per-rule maximum against per-subject values would wave through any file
            # that grew but stayed below the old maximum.
            problems.append(f"{rule}: the baseline records one number per rule, not one "
                            f"per subject. Regenerate it with --update.")
            continue
        for subject, value in sorted(per_subject.items()):
            allowed = recorded.get(subject)
            if allowed is None:
                problems.append(f"{rule}: {subject} is newly in violation at {value}")
            elif value > allowed:
                problems.append(f"{rule}: {subject} is now {value}, baseline "
                                f"recorded {allowed}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true",
                    help="rule -> list of violations, and nothing else at the top level")
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE), metavar="PATH")
    ap.add_argument("--ratchet", action="store_true",
                    help="fail if any count or worst value exceeds the baseline")
    ap.add_argument("--update", action="store_true",
                    help="rewrite the baseline; refuses to raise any number")
    ap.add_argument("--rename", action="append", default=[], metavar="OLD=NEW",
                    help="a file MOVED: carry its baseline subjects across at their "
                         "recorded values, then ratchet as usual. Repeatable.")
    ap.add_argument("--strict", action="store_true",
                    help="fail on every absolute cap breach rather than comparing debt")
    ap.add_argument("--assert-prefix", metavar="PATH",
                    help="apply absolute caps only to this repository-relative file/tree")
    ap.add_argument("--max-module-lines", type=int, metavar="N")
    ap.add_argument("--max-test-lines", type=int, metavar="N")
    ap.add_argument("--max-function-lines", type=int, metavar="N")
    args = ap.parse_args()

    absolute = args.strict or args.assert_prefix is not None
    if absolute and all(limit is None for limit in (
            args.max_module_lines, args.max_test_lines, args.max_function_lines)):
        ap.error("--strict/--assert-prefix requires at least one maximum")

    try:
        found = check()
    except SyntaxError as exc:
        print(f"tools/structure_check.py: {exc.filename}:{exc.lineno} will not parse: "
              f"{exc.msg}", file=sys.stderr)
        return 2

    if args.json:
        json.dump(found, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(render(found))

    if absolute:
        try:
            problems = strict_problems(
                args.assert_prefix, max_module_lines=args.max_module_lines,
                max_test_lines=args.max_test_lines,
                max_function_lines=args.max_function_lines)
        except SyntaxError as exc:
            print(f"tools/structure_check.py: {exc.filename}:{exc.lineno} will not parse: "
                  f"{exc.msg}", file=sys.stderr)
            return 2
        if problems:
            print("\n".join(["", *[f"  STRICT  {problem}" for problem in problems]]),
                  file=sys.stderr)
            return 1

    if not (args.ratchet or args.update or args.rename):
        return 0

    path = pathlib.Path(args.baseline)
    document = {
        "note": ("Structural violations in houston/ and tests/ that the port removes. The "
                 "ratchet only goes DOWN: --update refuses to raise any number. Regenerate "
                 "with `.venv/bin/python tools/structure_check.py --update`. `counts` is how "
                 "many violations per rule; `worst` is the largest value PER SUBJECT, so one "
                 "file cannot get worse while the count stays level AND letting one file "
                 "grow does not loosen the cap for every other file."),
        "limits": {"module_code_lines": MODULE_CODE_LINES,
                   "test_code_lines": TEST_CODE_LINES,
                   "function_raw_span": FUNCTION_RAW_SPAN,
                   "cyclomatic": CYCLOMATIC,
                   "public_symbols": PUBLIC_SYMBOLS},
        "counts": counts(found),
        "worst": worst(found),
    }

    if not path.is_file():
        if not args.update:
            print(f"\n{args.baseline} does not exist. Create it with --update.",
                  file=sys.stderr)
            return 2
        path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        if not args.json:
            print(f"\ncreated {path.name} with {sum(counts(found).values())} violations")
        return 0

    baseline = json.loads(path.read_text(encoding="utf-8"))
    renamed: list[str] = []
    if args.rename:
        pairs = []
        for entry in args.rename:
            if "=" not in entry:
                ap.error(f"--rename wants OLD=NEW, got {entry!r}")
            old, new = entry.split("=", 1)
            pairs.append((old.strip("/"), new.strip("/")))
        renamed = rename_subjects(baseline, pairs)
        if not renamed:
            print("\n--rename matched no baseline subject", file=sys.stderr)
            return 2

    problems = compare(found, baseline)
    if problems:
        print("\n".join([""] + [f"  WORSE  {p}" for p in problems]),
              file=sys.stderr)
        print(f"\n{len(problems)} number(s) went up. This ratchet only goes down: fix the "
              f"regression, or split the file. --update will not record it.", file=sys.stderr)
        return 1

    if renamed:
        # The renames are written with the REST of the baseline untouched: `document`
        # is a fresh measurement and would quietly accept any other movement alongside
        # the move being recorded.
        path.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
        print("\n" + "\n".join(f"  MOVED  {line}" for line in renamed))
        print(f"\nrewrote {path.name}: {len(renamed)} subject(s) renamed, no value changed")
    if args.update:
        path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {path.name}")
    elif not args.json:
        print("\nno number exceeds the baseline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
