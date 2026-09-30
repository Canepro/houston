"""`services/doctor` after the 1,044-line `run_checks` became one module per subject.

The report is a published document -- `doctor --json` names every row by a check id from
`CHECKS`, and an agent watches the id rather than the prose beside it. So the risks in
splitting it are all about the contract rather than the code:

* **An id that stops being reachable.** A block that moved into a module nobody registered
  produces no rows, and the caller watching that id simply never fires again.
* **A row order that changes.** The report is read top to bottom, and `RUN_ORDER` is now
  the only thing that decides it -- where before it was the order statements appeared in
  one function.
* **A subject that goes missing from a row.** `subject` was a rolling variable every block
  reassigned; it is an explicit argument now, and passing the wrong one is a row filed
  under another check.
* **The package importing its own check modules**, which is a cycle: importing
  `houston.services.doctor.checks.docker` runs both initialisers first, and every check
  module imports `doctor.rows`.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

from houston.services import doctor
from houston.services.doctor import checks, probes, rows
from houston.services.doctor.checks import (compose, disk, docker, edge, hub, identity,
                                            install, k8s, kernel, legacy, memory, ports,
                                            presets, versions, work)

MODULES = (docker, compose, kernel, hub, disk, memory, versions, ports, install, legacy,
           edge, identity, k8s, work, presets)


def test_the_published_id_vocabulary_is_unchanged():
    """45 ids, in report order. This is the machine-readable half of `doctor --json`."""
    assert len(doctor.CHECKS) == 45
    assert doctor.CHECKS is rows.CHECKS
    assert doctor.CHECKS[0] == "preflight", "the fallback id must stay first"
    assert len(set(doctor.CHECKS)) == len(doctor.CHECKS)


def test_run_order_names_every_check_module_and_nothing_else():
    on_disk = {p.stem for p in pathlib.Path(checks.__file__).parent.glob("*.py")
               if p.stem != "__init__"}
    assert set(checks.RUN_ORDER) == on_disk, (
        f"RUN_ORDER and the directory disagree: {set(checks.RUN_ORDER) ^ on_disk}")
    assert len(checks.RUN_ORDER) == len(set(checks.RUN_ORDER)) == len(MODULES)


@pytest.mark.parametrize("module", MODULES, ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_each_check_module_declares_one_subject_and_one_entry_point(module):
    assert module.SUBJECT in doctor.CHECKS, module.SUBJECT
    assert callable(module.check)


def test_every_declared_subject_is_a_declared_check_id():
    """`SUBJECT` is what `Report.line` files a row under when `check=` does not override
    it, so an id that is not in `CHECKS` becomes an unwatchable `preflight` row."""
    subjects = [getattr(m, "SUBJECT") for m in MODULES]
    assert len(set(subjects)) == len(subjects), "two modules claim the same subject"
    assert set(subjects) <= set(doctor.CHECKS)


def test_a_row_filed_under_an_undeclared_id_becomes_preflight_not_an_exception():
    report = rows.Report()
    report.line("docker", "ok", "fine")
    report.line("not-declared", "warn", "hmm")
    report.line("docker", "warn", "actually not", check="compose")
    assert [r["check"] for r in report.rows] == ["docker", "preflight", "compose"]


def test_the_checks_package_imports_nothing_of_its_own():
    """It may not. Every check module imports `doctor.rows`, and importing a submodule
    runs both initialisers first -- so a single import here, of a sibling or of the
    parent, is the cycle `tools/scc_check.py` gates on. It found exactly that: three
    lines of `from houston.services.doctor.rows import Report` inside the function that
    used to run the checks. `__future__` is not an import of anything."""
    tree = ast.parse(pathlib.Path(checks.__file__).read_text(encoding="utf-8"))
    reaches = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "") != "__future__":
            reaches.append(node.module)
        elif isinstance(node, ast.Import):
            reaches += [a.name for a in node.names]
    assert not reaches, f"checks/__init__.py imports {reaches}"


@pytest.mark.parametrize("leaf", (rows, probes), ids=lambda m: m.__name__.rsplit(".", 1)[-1])
def test_a_doctor_leaf_never_imports_its_own_package(leaf):
    tree = ast.parse(pathlib.Path(leaf.__file__).read_text(encoding="utf-8"))
    reaches = [n.module for n in ast.walk(tree)
               if isinstance(n, ast.ImportFrom)
               and (n.module or "").startswith("houston.services.doctor")]
    assert not reaches, f"{leaf.__name__} is not a leaf: it imports {reaches}"


def test_the_report_runs_every_module_in_order(monkeypatch):
    """The rows come out grouped by module, in `RUN_ORDER`, and every module is asked."""
    asked: list[str] = []

    def fake(name):
        def check(ctx):
            asked.append(name)
            report = rows.Report()
            report.line("preflight", "ok", name)
            return report.rows
        return check

    for name in checks.RUN_ORDER:
        module = __import__(f"houston.services.doctor.checks.{name}", fromlist=["check"])
        monkeypatch.setattr(module, "check", fake(name))

    out = doctor.run_checks()
    assert asked == list(checks.RUN_ORDER)
    assert [r["message"] for r in out["checks"]] == list(checks.RUN_ORDER)
    assert out["verdict"] == "ok"


def test_a_check_that_raises_still_ends_the_report(monkeypatch):
    """Pinned because the tempting change is the opposite. Each check owns its own
    `try` and degrades to a warn row; a second net in the runner would let the modules
    after a crash go on running and the report would gain rows it has never had. That
    is a behaviour decision, and the decomposition is not the place to take it."""
    from houston.services.doctor.checks import docker as dockermod

    def explode(ctx):
        raise RuntimeError("planted")

    monkeypatch.setattr(dockermod, "check", explode)
    with pytest.raises(RuntimeError, match="planted"):
        doctor.run_checks()
