"""The two published surfaces nothing else in the suite reads.

`capabilities` is the machine-readable CLI contract and `--help` is the human one, and
before this file existed neither had a single test. That was survivable while all 40
commands lived in one `cli.py`. It stops being survivable in Phase 2a, which moves them
into thirteen modules: `--help` is **registration-ordered**, so the import order of
those modules becomes the order a user sees, and a reordering is invisible to every
other test in the suite. `capabilities` derives from the same registry.

So both are frozen as fixtures here, captured before the move, and diffed on every run.
The tooling that captures them lives in `tools/` and is loaded by path below rather than
duplicated, because a fixture whose writer and whose checker disagree is worse than no
fixture: it fails for a reason that is not about the product.

Re-capture deliberately, never reflexively:

    .venv/bin/python tools/capture_help.py --check    # what changed
    .venv/bin/python tools/capture_help.py            # accept it
    HOUSTON_HOME=$(mktemp -d) .venv/bin/houston capabilities \\
        | .venv/bin/python tools/normalise_caps.py > tests/fixtures/capabilities.baseline.json

A diff here is a change to something a caller depends on. It may well be intended --
step 0.12 deleted `benchmark`, and this is where that showed up: one fewer command in
`capabilities`, one fewer help fixture, two fewer lines in the root listing. Read the
diff and say so in the commit; do not re-capture to get green.
"""
from __future__ import annotations

import difflib
import importlib.util
import json
import pathlib
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
CAPS_FIXTURE = FIXTURES / "capabilities.baseline.json"
HELP_DIR = FIXTURES / "help"
ROOT_HELP = FIXTURES / "help-root.txt"


def _tool(name: str):
    """Load `tools/<name>.py` by path.

    `tools/` is not a package and is deliberately not importable as one: it holds gate
    scripts run as files, and adding an `__init__.py` to satisfy an import here would
    make them importable from anywhere and invite one to grow a dependency on the
    package it is meant to audit from outside.
    """
    path = ROOT / "tools" / f"{name}.py"
    assert path.is_file(), f"{path} is missing -- it is the writer for these fixtures"
    spec = importlib.util.spec_from_file_location(f"_houston_tools_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _script(relative: str):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(
        "_houston_" + relative.replace("/", "_").replace(".", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_suite_floor_parser_refuses_output_without_a_collection_count():
    gate = _tool("test_gate")

    assert gate.collected_count("1419 tests collected in 1.2s") == 1419
    with pytest.raises(ValueError, match="collected-test count"):
        gate.collected_count("all checks passed")
    counts = gate.junit_counts(
        '<testsuites tests="3" failures="0" errors="0" skipped="1" />')
    assert counts == {"tests": 3, "failures": 0, "errors": 0, "skipped": 1}


@pytest.mark.parametrize(("collected", "counts", "reason"), [
    (9, {"tests": 9, "failures": 0, "errors": 0, "skipped": 0}, "collected 9"),
    (10, {"tests": 9, "failures": 0, "errors": 0, "skipped": 0}, "executed 9"),
    (10, {"tests": 10, "failures": 1, "errors": 0, "skipped": 0}, "failures=1"),
    (10, {"tests": 10, "failures": 0, "errors": 0, "skipped": 1}, "skipped=1"),
])
def test_the_suite_gate_rejects_deleted_failed_and_skipped_tests(collected, counts,
                                                                  reason):
    gate = _tool("test_gate")
    assert any(reason in problem for problem in gate.result_problems(collected, 10, counts))


def test_the_strict_structure_gate_rejects_absolute_debt(tmp_path, monkeypatch):
    gate = _tool("structure_check")
    package = tmp_path / "houston" / "small"
    package.mkdir(parents=True)
    (tmp_path / "tests").mkdir()
    (package / "large.py").write_text(
        "def too_long():\n" + "    value = 1\n" * 7, encoding="utf-8")
    monkeypatch.setattr(gate, "REPO_ROOT", tmp_path)

    problems = gate.strict_problems(
        "houston/small", max_module_lines=5, max_test_lines=None,
        max_function_lines=5)

    assert any("code lines" in problem for problem in problems)
    assert any("raw lines" in problem for problem in problems)


def test_the_rename_carries_a_subject_across_but_cannot_raise_its_number():
    """`--rename` is how a file MOVE stops reading as a new violation.

    The ratchet keys a subject on `path::function`, so relocating an unchanged function
    would otherwise report it as newly in violation while its old subject vanished --
    which is what phase 2a does eighty times over. The rename must therefore be
    possible, and it must be impossible to smuggle a real regression through it: a
    function that moved AND grew has to fail exactly as it would have failed in place.
    """
    gate = _tool("structure_check")
    baseline = {"worst": {"function_raw_span": {"old/mod.py::big": 90,
                                                "other/keep.py::untouched": 70},
                          "module_code_lines": {"old/mod.py": 900}}}

    moved = gate.rename_subjects(baseline, [("old/mod.py", "new/mod.py")])

    assert baseline["worst"]["function_raw_span"] == {"new/mod.py::big": 90,
                                                      "other/keep.py::untouched": 70}
    assert baseline["worst"]["module_code_lines"] == {"new/mod.py": 900}
    assert len(moved) == 2 and all("90" in m or "900" in m for m in moved)

    # The value travelled unchanged, so the comparison that runs next still sees the
    # real measurement. A grown function fails there, under its NEW name.
    found = {rule: [] for rule in gate.WHY}
    found["function_raw_span"] = [{"subject": "new/mod.py::big", "value": 120,
                                   "limit": 60, "overage": 60, "detail": "", "line": 0}]
    problems = gate.compare(found, baseline)
    assert any("new/mod.py::big is now 120" in p for p in problems), problems


def test_the_seam_gate_resolves_process_aliases_and_imported_callables(tmp_path):
    gate = _tool("seam_check")
    source = tmp_path / "aliases.py"
    source.write_text(
        "import asyncio as aio\n"
        "import os as operating_system\n"
        "import subprocess as sp\n"
        "from subprocess import run as execute\n"
        "sp.Popen([])\nexecute([])\noperating_system.system('x')\n"
        "operating_system.popen('x')\naio.create_subprocess_exec('x')\n"
        "aio.create_subprocess_shell('x')\n",
        encoding="utf-8")

    hits = gate.scan(source)["spawns_a_process"]

    assert [name for _, name in hits if name != "subprocess import"] == [
        "subprocess.Popen", "subprocess.run", "os.system", "os.popen",
        "asyncio.create_subprocess_exec", "asyncio.create_subprocess_shell"]
    assert [name for _, name in hits].count("subprocess import") == 2


@pytest.mark.parametrize("source", [
    "import subprocess\nsubprocess.run([])\n",
    "import subprocess as sp\nsp.Popen([])\n",
    "from subprocess import run as execute\nexecute([])\n",
    "import os\nos.system('x')\n",
    "import os as operating_system\noperating_system.popen('x')\n",
    "import asyncio\nasyncio.create_subprocess_exec('x')\n",
    "import asyncio as aio\naio.create_subprocess_shell('x')\n",
], ids=("run", "popen", "imported-run", "system", "os-popen", "async-exec",
        "async-shell"))
def test_each_process_bypass_makes_the_seam_gate_fail(source, tmp_path, monkeypatch):
    gate = _tool("seam_check")
    package = tmp_path / "houston"
    package.mkdir()
    (package / "direct.py").write_text(source, encoding="utf-8")
    monkeypatch.setattr(gate, "REPO_ROOT", tmp_path)

    violations, _ = gate.check()

    assert any(v["rule"] == "spawns_a_process" for v in violations)


def test_the_scc_gate_detects_a_new_cycle_in_a_fixture_repository(tmp_path,
                                                                  monkeypatch):
    gate = _tool("scc_check")
    package = tmp_path / "houston"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "a.py").write_text("from houston import b\n", encoding="utf-8")
    (package / "b.py").write_text("from houston import a\n", encoding="utf-8")
    monkeypatch.setattr(gate, "REPO_ROOT", tmp_path)

    result = gate.analyse(package_init_edges=True)
    regressions, _ = gate.compare(result, {"sccs": []})

    assert result["counts"]["combined"] == 1
    assert regressions


def _diff(want: str, got: str, label: str) -> str:
    return "\n".join(difflib.unified_diff(
        want.splitlines(), got.splitlines(),
        fromfile=f"{label} (fixture)", tofile=f"{label} (now)", lineterm=""))


@pytest.fixture(scope="module")
def rendered_help():
    """Every help text, rendered once for the whole module.

    Forty-two subprocesses at ~0.23s each is three seconds in parallel and twelve in
    series, and two tests need the same answer.

    No `tmp_path` here, deliberately, and this is the subtle part. Three commands
    interpolate `$HOUSTON_HOME/reports` into their `--report` help, so Click wraps that
    line according to the length of the path -- and an arbitrary pytest tmp path can
    wrap differently. `capture()` allocates a unique path of fixed length and removes
    it afterwards.
    """
    return _tool("capture_help").capture()


def test_the_capabilities_contract_matches_its_frozen_fixture(tmp_path, monkeypatch):
    """`capabilities` is the published contract, normalised so it can diff empty anywhere.

    The normaliser is the load-bearing half. `capabilities` embeds a timestamp, the
    version in four places, and absolute `$HOME` paths under `skill.hosts[*].path`, so a
    raw capture is a fixture of one machine at one moment and can never pass on another.
    That is not a hypothetical: Phase 0's exit gate is "diffs empty **on a second
    machine**".
    """
    # Keep the advertised skill paths and their $HOME normalisation local to
    # this fixture; a gate's inherited skill root need not be the user's HOME.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("HOUSTON_SKILL_HOME", str(tmp_path))
    normalise_caps = _tool("normalise_caps")
    houston = pathlib.Path(_tool("capture_help").houston_bin())
    proc = subprocess.run([str(houston), "capabilities"], capture_output=True, text=True,
                          env=_tool("capture_help").child_env(str(tmp_path)), timeout=120)
    assert proc.returncode == 0, f"`houston capabilities` exited {proc.returncode}: {proc.stderr}"

    got = normalise_caps.render(proc.stdout)
    assert CAPS_FIXTURE.is_file(), (
        f"{CAPS_FIXTURE.relative_to(ROOT)} is missing. Re-capture it with the command in "
        f"this module's docstring, and read what it contains before committing.")
    want = CAPS_FIXTURE.read_text(encoding="utf-8")
    assert got == want, (
        "the capabilities contract changed:\n"
        + _diff(want, got, "capabilities")
        + "\n\nThis is a published surface. If the change is intended, re-capture the "
          "fixture and name the change in the commit message. If it is not, something "
          "moved that callers can see.")


def test_no_machine_specific_value_survives_the_normaliser():
    """The fixture must not contain anything true only of the box that wrote it.

    Checked against the fixture ON DISK rather than against a fresh normalisation,
    because the failure this guards is a fixture captured with an incomplete normaliser
    and committed -- which passes on that machine forever and fails on every other one.
    """
    text = CAPS_FIXTURE.read_text(encoding="utf-8")
    leaks = []
    for needle, why in (("/home/", "an absolute Linux home path"),
                        ("/Users/", "an absolute macOS home path"),
                        ("/root/", "an absolute root home path")):
        if needle in text:
            leaks.append(f"{needle!r} ({why})")
    doc = json.loads(text)
    if doc.get("generated_at") != "<generated_at>":
        leaks.append(f"generated_at is {doc.get('generated_at')!r}, not the placeholder")
    if doc.get("houston_version") != "<version>":
        leaks.append(f"houston_version is {doc.get('houston_version')!r}, not the placeholder")
    assert not leaks, (
        "these would pin the fixture to one machine or one release, so the gate could "
        "never pass elsewhere: " + ", ".join(leaks)
        + ". Extend tools/normalise_caps.py and re-capture.")


def test_the_fixture_home_does_not_outlive_the_helpers_that_create_it(monkeypatch):
    """Nothing in `tools/` may leave a HOUSTON_HOME behind, and one thing did.

    `--help` and `capabilities` both CREATE `HOUSTON_HOME` as a side effect of resolving
    the default for `--report`, and houston writes its event log into it. The capture
    tool uses a uniquely owned path of deterministic length because Click wraps the
    `--report` line around the path's length.

    The first version put the cleanup inside `capture()` only. The set-equality test
    below called `command_names()` directly, so every single test run left
    a shared `/tmp` event log behind. Found by the standing rule
    that a change ends by checking nothing was left running, not by any assertion.
    """
    import contextlib

    capture_help = _tool("capture_help")
    real_fixture_home = capture_help.fixture_home
    seen = []

    @contextlib.contextmanager
    def recording_home(home=None):
        with real_fixture_home(home) as where:
            seen.append(pathlib.Path(where))
            yield where

    monkeypatch.setattr(capture_help, "fixture_home", recording_home)

    for label, call in (("registered_commands()", capture_help.registered_commands),
                        ("capture()", capture_help.capture)):
        call()
        assert seen and not seen[-1].exists(), (
            f"{seen[-1] if seen else 'no allocated home'} survived {label}. "
            f"Both entry points must go through "
            f"capture_help.fixture_home(), which removes its owned home in a finally. "
            f"A stray home in /tmp accumulates houston's own event log on every run.")


def test_every_help_text_matches_its_frozen_fixture(rendered_help):
    """`--help` is registration-ordered, and nothing else in the suite reads it.

    Phase 2a moves 40 commands from one module into thirteen. The order a user sees
    becomes the import order of those modules, and it changes silently -- no assertion
    anywhere covers the text of a help screen. Width, colour and box rules are pinned by
    `tools/capture_help.py`; see its docstring for why all three had to be.
    """
    missing, differing = [], []
    for path, got in sorted(rendered_help.items()):
        rel = path.relative_to(ROOT)
        if not path.is_file():
            missing.append(str(rel))
            continue
        want = path.read_text(encoding="utf-8")
        if want != got:
            differing.append(_diff(want, got, str(rel)))

    assert not missing, (
        "these commands are registered but have no help fixture: " + ", ".join(missing)
        + ". Run `.venv/bin/python tools/capture_help.py` to add them.")
    assert not differing, (
        "help text changed for "
        f"{len(differing)} command(s):\n\n" + "\n\n".join(differing)
        + "\n\nIf a command was renamed, reordered or had an option added, that is a "
          "change to a published surface -- re-capture and say so. If nothing was "
          "meant to change, the registration order moved.")


def test_the_help_fixtures_and_the_registered_commands_are_the_same_set():
    """A fixture for a command that no longer exists proves nothing, and quietly.

    The two failure directions are different bugs. A registered command with no fixture
    is an unfrozen surface. A fixture with no command is a file that will keep passing
    after the command it describes is deleted -- which step 0.12 is about to do to
    `benchmark`.
    """
    capture_help = _tool("capture_help")
    names = capture_help.registered_commands()
    registered = {capture_help.slug(n) for n in names}
    on_disk = {p.stem for p in HELP_DIR.glob("*.txt")}

    assert ROOT_HELP.is_file(), (
        f"{ROOT_HELP.relative_to(ROOT)} is missing. The ROOT help is where the command "
        f"ORDER is visible, which is the whole thing Phase 2a can break.")
    assert registered == on_disk, (
        "the frozen help fixtures and the registered commands have diverged.\n"
        f"  registered but not frozen: {sorted(registered - on_disk) or 'none'}\n"
        f"  frozen but not registered: {sorted(on_disk - registered) or 'none'}\n"
        "Run `.venv/bin/python tools/capture_help.py`, which adds the first and deletes "
        "the second.")


def test_the_wheel_smoke_check_walks_the_tree_rather_than_a_list():
    """`tools/wheel_smoke.py` decides what the wheel must contain by walking `houston/`.

    The thing it replaces was a five-name list in `pyproject.toml`, and the list was
    wrong the moment phase 2a added a package — which is the failure mode a second
    hand-kept list here would reproduce exactly. So this asserts the walk finds the
    packages that exist, not that it finds particular ones.
    """
    smoke = _tool("wheel_smoke")

    packages = smoke.expected_packages()
    modules = smoke.expected_modules()

    assert "houston" in packages and "houston.cli" in packages
    assert "houston.services.doctor.checks" in packages
    assert all(p.startswith("houston") for p in packages)
    # Every package directory on disk, none missing and none invented.
    on_disk = {".".join(init.parent.relative_to(ROOT).parts)
               for init in (ROOT / "houston").rglob("__init__.py")}
    assert set(packages) == on_disk
    assert len(modules) > 100 and not set(modules) & set(packages)


def test_the_wheel_is_built_from_a_clean_copy_and_not_from_build_lib():
    """`build/lib/` is INCREMENTAL and never pruned.

    The checkout's held `houston/cli.py` long after the CLI became `houston/cli/`, and
    the wheel is zipped from that directory rather than from the source — so a wheel
    could ship a module the tree deleted, and narrowing package discovery changed
    nothing at all about the artifact. Found while trying to make this gate's own gate
    bite, which it would not.
    """
    import inspect

    smoke = _tool("wheel_smoke")
    src = inspect.getsource(smoke.build_and_check)
    assert "_clean_copy(" in src, "the wheel is built from the checkout, build/ included"
    assert "--no-cache-dir" in src, "pip may hand back a previously built wheel"
    assert "git ls-files" in inspect.getsource(smoke._clean_copy)


def test_the_strict_gate_applies_production_and_test_limits_separately(tmp_path,
                                                                      monkeypatch):
    """Whole-tree mode, with no prefix: a production module is held to 600 code lines and
    a test module to 800, and the two thresholds are not the same number by accident.

    Phase 2b's exit gate is `--strict`, not `--ratchet`, and this is why the distinction
    has to hold: a test file at 700 lines is fine and a service at 700 is not.
    """
    gate = _tool("structure_check")
    (tmp_path / "houston").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "houston" / "big.py").write_text("x = 1\n" * 7, encoding="utf-8")
    (tmp_path / "tests" / "test_big.py").write_text("x = 1\n" * 7, encoding="utf-8")
    monkeypatch.setattr(gate, "REPO_ROOT", tmp_path)

    problems = gate.strict_problems(None, max_module_lines=5, max_test_lines=9,
                                    max_function_lines=None)

    assert any(p.startswith("houston/big.py") for p in problems)
    assert not any(p.startswith("tests/") for p in problems), (
        "the test file was held to the production limit")


def test_the_ratchet_can_pass_while_every_baseline_violation_remains(tmp_path,
                                                                    monkeypatch):
    """The reason phase 2b's exit gate is `--strict` and not `--ratchet`.

    A ratchet compares against recorded debt, so a tree that has changed nothing at all
    passes it — including a tree where every violation this phase exists to remove is
    still sitting there. Said out loud here because the previous plan declared whole-tree
    zero while gating on `--ratchet`, which would have reported success over the lot.
    """
    gate = _tool("structure_check")
    (tmp_path / "houston").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "houston" / "huge.py").write_text("x = 1\n" * 900, encoding="utf-8")
    monkeypatch.setattr(gate, "REPO_ROOT", tmp_path)

    found = gate.check()
    baseline = {"counts": gate.counts(found), "worst": gate.worst(found)}

    assert not gate.compare(found, baseline), "the ratchet should accept its own baseline"
    assert gate.strict_problems(None, max_module_lines=600, max_test_lines=800,
                                max_function_lines=60), \
        "strict mode agreed with the ratchet that 900 lines is fine"


def test_the_move_table_assigns_every_symbol_and_imports_only_downward():
    """Phase 2b may not start moving code while a symbol is unassigned.

    `lifecycle.py` and `k8s.py` are 418 top-level symbols between them. The failure mode
    is not a module that ends up too big — it is a symbol nobody decided about, found
    halfway through a split when something imports it from a file that no longer has it,
    or a module that quietly imports upward and re-creates the cycle phase 1 removed.
    """
    table = _tool("move_table")
    assert not table.problems(table.load_table())


def test_the_move_table_gate_catches_an_unassigned_symbol(tmp_path, monkeypatch):
    table = _tool("move_table")
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "m.py").write_text("def a():\n    pass\n\n\ndef b():\n    pass\n",
                                           encoding="utf-8")
    monkeypatch.setattr(table, "REPO_ROOT", tmp_path)

    found = table.problems({"modules": {"pkg/m.py": {
        "tiers": {"x": 0}, "symbols": {"a": "x"}}}})

    assert any("b has no destination" in p for p in found), found


def test_the_move_table_gate_catches_an_upward_import(tmp_path, monkeypatch):
    """`low` calling `high` becomes `low` importing `high` the moment they are two
    files. Rejected here, before anything moves, rather than by the cycle gate after."""
    table = _tool("move_table")
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "m.py").write_text(
        "def high():\n    pass\n\n\ndef low():\n    return high()\n", encoding="utf-8")
    monkeypatch.setattr(table, "REPO_ROOT", tmp_path)

    found = table.problems({"modules": {"pkg/m.py": {
        "tiers": {"bottom": 0, "top": 3},
        "symbols": {"low": "bottom", "high": "top"}}}})

    assert any("upward import" in p for p in found), found


def test_a_file_rename_does_not_swallow_a_function_rename():
    """`a/b.py=c/d.py` also matches `a/b.py::fn`, so a run that renames a file AND
    relocates one of its functions somewhere else would have the file-level pair capture
    the function-level one — silently, and depending on dict order.

    Splitting a module does exactly that in every commit: `lifecycle.py` becomes
    `lifecycle/_unsplit.py` while `check_capacity` goes to `lifecycle/sizing.py`. Caught
    when the rename reported success and the ratchet still called `sizing.py::check_capacity`
    newly in violation.
    """
    gate = _tool("structure_check")
    baseline = {"worst": {"function_raw_span": {"a/b.py::fn": 90, "a/b.py::other": 70},
                          "module_code_lines": {"a/b.py": 900}}}

    gate.rename_subjects(baseline, [("a/b.py", "c/rest.py"),
                                    ("a/b.py::fn", "c/moved.py::fn")])

    assert baseline["worst"]["function_raw_span"] == {"c/moved.py::fn": 90,
                                                      "c/rest.py::other": 70}
    assert baseline["worst"]["module_code_lines"] == {"c/rest.py": 900}


def test_the_move_table_gate_rejects_a_bare_sibling_function_import(tmp_path, monkeypatch):
    """`from .naming import resolve_name` binds the function into the importer's globals,
    so `monkeypatch.setattr(naming, "resolve_name", fake)` never reaches that caller — and
    nothing says so. It is the one hazard the mechanical re-pointer cannot see, because
    the patch target is right and the caller is looking somewhere else.

    Constants and classes are exempt: nothing patches a value by rebinding a name.
    """
    table = _tool("move_table")
    package = tmp_path / "houston" / "svc" / "pkg"
    package.mkdir(parents=True)
    (package / "naming.py").write_text(
        "VALUE = 1\n\n\ndef resolve_name():\n    pass\n", encoding="utf-8")
    (package / "user.py").write_text(
        "from houston.svc.pkg.naming import resolve_name\n"
        "from houston.svc.pkg.naming import VALUE\n", encoding="utf-8")
    monkeypatch.setattr(table, "REPO_ROOT", tmp_path)

    found = table.bare_sibling_functions(package)

    assert len(found) == 1, found
    assert "resolve_name" in found[0] and "from . import naming" in found[0]
    assert "VALUE" not in found[0], "a constant import was reported as a hazard"


def _split_in_progress(tmp_path, monkeypatch, table, *, owner: str):
    """A package mid-split: `require_docker` has moved out of `_unsplit` into
    `preconditions`, and the façade still says `owner`."""
    package = tmp_path / "houston" / "svc" / "pkg"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(
        f'_OWNER = {{\n    "create_repro": "_unsplit",\n'
        f'    "require_docker": "{owner}",\n}}\n', encoding="utf-8")
    (package / "preconditions.py").write_text("def require_docker():\n    pass\n",
                                              encoding="utf-8")
    (package / "_unsplit.py").write_text("def create_repro():\n    pass\n",
                                         encoding="utf-8")
    monkeypatch.setattr(table, "REPO_ROOT", tmp_path)
    return {"modules": {"houston/svc/mod.py": {
        "package": "houston/svc/pkg",
        "tiers": {"preconditions": 0, "_unsplit": 9},
        "symbols": {"require_docker": "preconditions", "create_repro": "_unsplit"}}}}


def test_the_re_pointer_follows_a_symbol_out_of_the_module_it_used_to_be_in(
        tmp_path, monkeypatch):
    """A patch is re-pointed once when the package is created and again every time the
    symbol moves on — and only the first of those was happening.

    Group 1 rewrites `lc.require_docker` to `lc._unsplit.require_docker`, which is right
    until group 2 creates `preconditions` and wrong the moment it does. The re-pointer
    only recognised the façade itself, so a target that already named a submodule was
    skipped: `monkeypatch.setattr(bk.lifecycle.preconditions, "require_docker", ...)` lands on
    a real attribute of a real module that no caller resolves through any more. 38 tests
    failed at once; a subtler move would have gone green over the real function instead.
    """
    table = _tool("move_table")
    plan = _split_in_progress(tmp_path, monkeypatch, table, owner="preconditions")
    (tmp_path / "tests").mkdir()
    spec = tmp_path / "tests" / "test_x.py"
    spec.write_text('monkeypatch.setattr(pkg._unsplit, "require_docker", None)\n'
                    'monkeypatch.setattr(pkg._unsplit, "create_repro", None)\n',
                    encoding="utf-8")

    moved = table.repoint_tests(plan, apply=True)

    assert spec.read_text(encoding="utf-8") == (
        'monkeypatch.setattr(pkg.preconditions, "require_docker", None)\n'
        'monkeypatch.setattr(pkg._unsplit, "create_repro", None)\n')
    assert len(moved) == 1, f"a symbol that has not moved was re-pointed too: {moved}"


def test_the_gate_catches_a_facade_still_pointing_at_the_module_a_symbol_left(
        tmp_path, monkeypatch):
    """`_OWNER` is the decomposition as the running program sees it, and it changes with
    every group that moves. Left stale it resolves a name through a module that no longer
    defines it — an AttributeError raised in whichever unrelated test touches that name
    first, which is how 14 backup tests came to error during a lifecycle split.
    """
    table = _tool("move_table")
    plan = _split_in_progress(tmp_path, monkeypatch, table, owner="_unsplit")

    found = table.problems(plan)

    assert any("_OWNER is stale" in p and "_unsplit -> preconditions" in p
               for p in found), found
    assert not table.problems(
        _split_in_progress(tmp_path / "fresh", monkeypatch, table,
                           owner="preconditions")), "an accurate façade was called stale"


def test_the_move_table_gate_catches_two_destinations_that_would_import_each_other(
        tmp_path, monkeypatch):
    """The tier check cannot see this one, and the reviewed map shipped five of them.

    A tier rejects an edge to a HIGHER tier. Two destinations at the SAME tier calling
    each other have no such edge, so `ready`/`seeding` (both tier 3) and
    `create_docker`/`create_k8s` (both tier 5) passed the gate with a call in each
    direction — and three more pairs were waiting in the `k8s` plan. Nothing would have
    said so until the code had moved and the cycle gate failed with the work already
    done, which is the failure this map exists to prevent.
    """
    table = _tool("move_table")
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "m.py").write_text(
        "def here():\n    return there()\n\n\ndef there():\n    return here()\n",
        encoding="utf-8")
    monkeypatch.setattr(table, "REPO_ROOT", tmp_path)

    found = table.problems({"modules": {"pkg/m.py": {
        "tiers": {"a": 3, "b": 3},
        "symbols": {"here": "a", "there": "b"}}}})

    assert any("would import each other: a <-> b" in p for p in found), found
    # The same two symbols in ONE destination are not a cycle — they are a module.
    assert not table.problems({"modules": {"pkg/m.py": {
        "tiers": {"a": 3}, "symbols": {"here": "a", "there": "a"}}}})


def test_the_workspace_record_carries_the_keys_every_reader_expects(tmp_path, monkeypatch):
    """The on-disk record's KEYS are a contract, and a rename of one is silent.

    A mechanical refactor of the create path rewrote `meta.extra["bind_host"]` to
    `meta.extra["plan.bind_host"]` — a regex re-pointing variable references matched the
    same letters inside the string — and the full suite stayed green, because `detail()`
    reads that key with a default and the browser fixture only compares which keys come
    back, not where they came from. The workspace simply stopped recording the bind, and
    the panel would have said loopback for a workspace published on every interface.

    So the keys are asserted against the writer, not against a reader that can paper over
    a missing one.
    """
    import ast

    import conftest

    from houston.services import lifecycle as lc

    written = set()
    # THE WHOLE PACKAGE. Naming the modules would need editing every time one appears,
    # and a key written from a module nobody listed is exactly the case that gets missed.
    for node in ast.walk(ast.parse(conftest.source_of(lc))):
        # `meta.extra[<literal>] = ...` and `provisional.extra[<literal>] = ...`
        if not (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Attribute)
                and node.value.attr == "extra"
                and isinstance(node.slice, ast.Constant)
                and isinstance(node.slice.value, str)):
            continue
        written.add(node.slice.value)

    # Every key a reader reaches for by name. A key written under a DIFFERENT name than
    # the one read is the whole defect, so this is the pair that has to agree.
    for key in ("bind_host", "namespace", "notes", "monitoring", "params", "created_by",
                "advertised_url", "post_ready", "instances", "sidecar_ports", "env",
                "tls", "edge", "distribution", "incomplete"):
        assert key in written, (
            f"nothing writes {key!r} into a workspace record any more, but readers "
            f"still ask for it by that name")
    assert not any("." in k for k in written), (
        f"a record key contains a dot, which no reader asks for: "
        f"{sorted(k for k in written if '.' in k)}")


def test_the_re_pointer_still_sees_a_patch_naming_a_module_that_has_been_deleted(
        tmp_path, monkeypatch):
    """The last group of a split deletes the remainder, and that is when its patches
    stop landing on anything at all.

    `--repoint-tests` matched `<façade>.<submodule>` against the modules currently on
    disk, so the moment `_unsplit.py` was deleted every
    `monkeypatch.setattr(lc._unsplit, "prunable", ...)` became invisible to it — 36 of
    them, all pointing at a module that no longer exists. The matchable set is the map's
    destinations plus the remainder, which stays true after the file is gone.
    """
    table = _tool("move_table")
    package = tmp_path / "houston" / "svc" / "pkg"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text('_OWNER = {\n    "prunable": "pruning",\n}\n',
                                         encoding="utf-8")
    (package / "pruning.py").write_text("def prunable():\n    pass\n", encoding="utf-8")
    # No `_unsplit.py`: the last group has just deleted it.
    (tmp_path / "tests").mkdir()
    spec = tmp_path / "tests" / "test_x.py"
    spec.write_text('monkeypatch.setattr(pkg._unsplit, "prunable", None)\n', encoding="utf-8")
    monkeypatch.setattr(table, "REPO_ROOT", tmp_path)

    moved = table.repoint_tests({"modules": {"houston/svc/mod.py": {
        "package": "houston/svc/pkg",
        "tiers": {"pruning": 4},
        "symbols": {"prunable": "pruning"}}}}, apply=True)

    assert len(moved) == 1, moved
    assert spec.read_text(encoding="utf-8") == \
        'monkeypatch.setattr(pkg.pruning, "prunable", None)\n'


def test_the_re_pointer_sees_mock_patch_object_as_well_as_monkeypatch(tmp_path,
                                                                     monkeypatch):
    """The same hazard, a different spelling, and the suite uses both.

    `mock.patch.object(k8s, "tool", ...)` writes a real attribute into the package dict
    exactly as `monkeypatch.setattr` does, and the context manager's exit restores it the
    same way — blinding `__getattr__` for every later test in the process. Matching only
    the `monkeypatch` spelling left those sites pointed at the façade, and the helm-flag
    test then read the real `tool()` instead of its stub.
    """
    table = _tool("move_table")
    package = tmp_path / "houston" / "svc" / "pkg"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text('_OWNER = {\n    "tool": "tools",\n}\n',
                                         encoding="utf-8")
    (package / "tools.py").write_text("def tool(n):\n    pass\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    spec = tmp_path / "tests" / "test_x.py"
    spec.write_text('with m.patch.object(pkg, "tool", None):\n    pass\n',
                    encoding="utf-8")
    monkeypatch.setattr(table, "REPO_ROOT", tmp_path)

    moved = table.repoint_tests({"modules": {"houston/svc/mod.py": {
        "package": "houston/svc/pkg", "tiers": {"tools": 1},
        "symbols": {"tool": "tools"}}}}, apply=True)

    assert len(moved) == 1, moved
    assert 'm.patch.object(pkg.tools, "tool", None)' in spec.read_text(encoding="utf-8")


def test_a_patch_that_rebinds_an_imported_name_goes_to_the_module_that_imports_it(
        tmp_path, monkeypatch):
    """`setattr(k8s, "Path", fake)` REPLACES a name rather than reaching through it.

    Landed on the façade, that write goes into the package dict where it shadows
    `__getattr__` and is invisible to the module whose global `Path` actually is — so
    `forward_alive` went on reading the real `pathlib.Path` and the test asserting a
    recycled pid is refused passed on nothing. An imported name belongs to the module
    that imports it, and only when exactly one does; anything else is ambiguous and left
    alone.
    """
    table = _tool("move_table")
    package = tmp_path / "houston" / "svc" / "pkg"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("_OWNER = {}\n", encoding="utf-8")
    (package / "forward.py").write_text(
        "from pathlib import Path\n\n\ndef alive():\n    return Path\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    spec = tmp_path / "tests" / "test_x.py"
    spec.write_text('monkeypatch.setattr(pkg, "Path", None)\n', encoding="utf-8")
    monkeypatch.setattr(table, "REPO_ROOT", tmp_path)

    table.repoint_tests({"modules": {"houston/svc/mod.py": {
        "package": "houston/svc/pkg", "tiers": {"forward": 3}, "symbols": {}}}},
        apply=True)

    assert spec.read_text(encoding="utf-8") == \
        'monkeypatch.setattr(pkg.forward, "Path", None)\n'


def test_a_lost_test_plus_a_duplicate_is_not_the_same_suite(tmp_path, monkeypatch):
    """The check phase 02b's test move rests on, and the reason it is a MULTISET.

    `tools/attribute_tests.py --check-moves` compares collected node IDs against a
    snapshot. A count cannot do that job: dropping one test and duplicating another
    leaves the total unchanged, and 16,000 lines of tests are about to be moved between
    seventy files. The phase file says so outright — "a missing, duplicate, or
    unexpectedly renamed node ID, even when the total count happens to remain equal".
    """
    from collections import Counter

    table = _tool("attribute_tests")
    want = ["tests/test_a.py::test_one", "tests/test_a.py::test_two",
            "tests/test_b.py::test_three"]
    # Lost one, duplicated another. Same length.
    have = ["tests/test_a.py::test_one", "tests/test_a.py::test_one",
            "tests/test_b.py::test_three"]
    assert len(want) == len(have), "precondition: a count would see nothing"

    missing = Counter(want) - Counter(have)
    extra = Counter(have) - Counter(want)
    assert list(missing) == ["tests/test_a.py::test_two"]
    assert list(extra) == ["tests/test_a.py::test_one"]

    # And the tool reports BOTH directions rather than only the shortfall.
    source = (ROOT / "tools" / "attribute_tests.py").read_text(encoding="utf-8")
    assert "MISSING" in source and "EXTRA" in source, (
        "--check-moves must name both what went away and what appeared")
    assert "translated - have" in source and "have - translated" in source
    assert callable(table.node_ids)


def test_nothing_patches_a_facade_by_its_dotted_string_name():
    """`monkeypatch.setattr("houston.runner.down", ...)` names its target as a STRING.

    No attribute-access scan can see it, so the re-pointer walked straight past two of
    them — and a patch on a façade is restored by `monkeypatch.undo()` writing a REAL
    attribute into the package dict, which shadows `__getattr__` permanently. Those two
    blinded fourteen later tests in the same process, and the failures appeared in files
    that had nothing to do with them.

    A façade may still be READ by that spelling; only a write is the hazard.
    """
    import importlib

    table = _tool("move_table")
    facades = {}
    for source, plan in json.loads(
            (ROOT / "tools" / "move-table.json").read_text(encoding="utf-8")
    )["modules"].items():
        if (ROOT / source).is_file() or not plan.get("package"):
            continue
        dotted = plan["package"].replace("/", ".")
        facades[dotted] = set(importlib.import_module(dotted)._OWNER)

    offenders = []
    for path in sorted((ROOT / "tests").rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        # Code only. This test's own docstring quotes the hazard, and a scan that reads
        # prose reports it -- the same trap that made the re-pointer rewrite a sentence
        # explaining the re-pointer.
        for match in table._sub_outside_strings_finditer(table.STRING_PATCH, text):
            dotted = match.group("dotted")
            package, _, attr = dotted.rpartition(".")
            if package in facades and attr in facades[package]:
                line = text[:match.start()].count("\n") + 1
                offenders.append(f"{path.name}:{line}: {dotted}")
    assert not offenders, (
        "these patch a façade by its dotted string name; point them at the module that "
        f"OWNS the symbol instead: {offenders}")


def _capture_help_through_a_mixed_table(tmp_path, monkeypatch, routing: str):
    """capture_help pointed at the dispatcher, a routing table and a scratch fixture dir."""
    capture_help = _tool("capture_help")
    table = tmp_path / "routing.conf"
    table.write_text(routing, encoding="utf-8")
    help_dir = tmp_path / "help"
    help_dir.mkdir()
    monkeypatch.setattr(capture_help, "ROUTING", table)
    monkeypatch.setattr(capture_help, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(capture_help, "HELP_DIR", help_dir)
    monkeypatch.setattr(capture_help, "ROOT_HELP", tmp_path / "help-root.txt")
    monkeypatch.setattr(capture_help, "houston_bin", lambda: capture_help.DISPATCHER)
    return capture_help, help_dir


def test_capture_help_names_the_fixtures_a_dispatcher_answers_in_typescript(tmp_path, monkeypatch):
    """Only through this checkout's `bin/houston`, and only the paths routed `ts`."""
    capture_help, help_dir = _capture_help_through_a_mixed_table(
        tmp_path, monkeypatch, "# a comment\n__root__=py\nlist=ts\nskill status=ts\nup=py\n")
    assert capture_help.routed_to_typescript(capture_help.DISPATCHER) == {
        help_dir / "list.txt", help_dir / "skill-status.txt"}
    (tmp_path / "routing.conf").write_text("__root__=ts\n", encoding="utf-8")
    assert capture_help.routed_to_typescript(capture_help.DISPATCHER) == {tmp_path / "help-root.txt"}
    # The Python's own console script is never routed, whatever the table says.
    assert capture_help.routed_to_typescript(ROOT.parent / ".venv" / "bin" / "houston") == set()


def test_capture_help_check_holds_only_the_python_routed_texts_to_their_bytes(
        tmp_path, monkeypatch, capsys):
    """Through a mixed table, `--check` byte-compares what the Python answers and leaves the
    TypeScript's text to `parity:help` (STATE 8.9.0, 3.1). Against the frozen tool it failed on
    the first flip: eleven TypeScript help texts compared byte for byte against the Python's."""
    capture_help, help_dir = _capture_help_through_a_mixed_table(
        tmp_path, monkeypatch, "__root__=py\nlist=ts\nup=py\n")
    for name in ("list", "up"):
        (help_dir / f"{name}.txt").write_text(f"{name} as frozen\n", encoding="utf-8")
    (tmp_path / "help-root.txt").write_text("root as frozen\n", encoding="utf-8")
    rendered = {help_dir / "list.txt": "list as the TypeScript draws it\n",
                help_dir / "up.txt": "up as frozen\n",
                tmp_path / "help-root.txt": "root as frozen\n"}
    monkeypatch.setattr(capture_help, "capture", lambda: dict(rendered))
    monkeypatch.setattr("sys.argv", ["capture_help.py", "--check"])
    assert capture_help.main() == 0
    assert "held content-equal" in capsys.readouterr().out
    # A Python-routed text that moved is still a failure.
    rendered[help_dir / "up.txt"] = "up, changed\n"
    assert capture_help.main() == 1
    assert "DIFFERS" in capsys.readouterr().out


def test_capture_help_refuses_to_capture_through_a_dispatcher_that_routes_to_typescript(
        tmp_path, monkeypatch):
    """The fixtures are the Python's: a capture through a mixed table would write the
    TypeScript's help over them."""
    capture_help, help_dir = _capture_help_through_a_mixed_table(
        tmp_path, monkeypatch, "__root__=py\nlist=ts\n")
    monkeypatch.setattr(capture_help, "capture",
                        lambda: {help_dir / "list.txt": "the TypeScript's help\n"})
    monkeypatch.setattr("sys.argv", ["capture_help.py"])
    with pytest.raises(SystemExit, match="refusing to capture"):
        capture_help.main()
    assert not (help_dir / "list.txt").exists()
