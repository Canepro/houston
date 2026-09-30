"""The phase-6 port order, checked against the tree rather than against the plan.

`.docs/migration/phases/06-core-services.md` fixes a port order in a table, and its own
Context paragraph says why that table cannot be trusted on its own: *"Step 06.0 must
regenerate the dependency graph from the post-Phase-2 tree and stop if the order below is
no longer topological."* `tools/phase6_order.py` is the script that decides it.

A gate that only ever passes is indistinguishable from no gate, and this repository has
paid for that distinction twice (step 5.5's lint rule and step 4.1's depcruise flag were
both proven by planting the violation they exist to catch). So the tests below assert
both directions: the real tree is topological, AND a deliberately wrong order is
reported. The second is the one that matters — the first passes if `analyse()` returns
an empty list for any reason at all, including a bug that finds no edges.
"""

from __future__ import annotations

import importlib.util
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _tool(name: str):
    """Load `tools/<name>.py` by path, the way tests/test_frozen.py does.

    `tools/` is deliberately not a package: these are gate scripts run as files, and an
    `__init__.py` added to make this import tidier would make them importable from
    anywhere and invite one to grow a dependency on the package it audits from outside.
    """
    path = ROOT / "tools" / f"{name}.py"
    assert path.is_file(), f"{path} is missing -- it is the phase-6 order gate"
    spec = importlib.util.spec_from_file_location(f"_houston_tools_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def order():
    return _tool("phase6_order")


def test_the_port_order_is_topological_against_this_tree(order):
    """Step 06.0's actual gate. A module may import only its own step or an earlier one."""
    result = order.analyse()
    assert result["violations"] == [], (
        "the phase-6 port order no longer matches the tree; step 06.0 says stop and "
        "amend the affected step rather than porting in an order the imports refuse")
    assert result["missingPrerequisite"] == [], (
        "a phase-6 module imports something an earlier phase was meant to have ported")
    assert result["unknownTargets"] == [], (
        "a target this script cannot place -- neither phase-6 scope, nor already "
        "ported, nor named in UNLISTED_BY_THE_PLAN. Place it rather than widening a "
        "prefix, or the gate stops seeing a whole subtree")
    assert result["ok"] is True


def test_a_later_step_edge_at_module_level_is_reported(order, monkeypatch):
    """The gate has to FAIL for the reason it claims, or it is decoration.

    `services/perf.py` is the real case: it imports `seed` and `services.lifecycle` at
    MODULE level, so the phase file's `perf/*` row cannot hold it. Putting it back where
    the plan's grouping implies must be reported — that is how the deviation was found.
    """
    planted = dict(order.PORT_ORDER)
    planted["6.6"] = ("houston.perf", "houston.services.perf")
    planted["6.12"] = tuple(m for m in planted["6.12"] if m != "houston.services.perf")
    monkeypatch.setattr(order, "PORT_ORDER", planted)
    monkeypatch.setattr(order, "STEP_SEQUENCE", list(planted))

    result = order.analyse()
    assert result["ok"] is False
    offenders = {(v["from"], v["to"]) for v in result["violations"]}
    assert ("houston.services.perf", "houston.seed") in offenders
    assert ("houston.services.perf", "houston.services.lifecycle") in offenders
    assert all(v["kind"] == order.scc_check.MODULE_LEVEL
               for v in result["violations"]), (
        "these two are module-level imports; reporting them as anything else would "
        "mean the kind is not being read")


def test_a_guarded_call_time_edge_is_deferred_not_failed(order):
    """The distinction the CommonJS choice was made for, asserted rather than assumed.

    RULES.md: "An in-function `require()` resolves at call time exactly like Python's 259
    function-body imports." So a later-step edge inside a failure-tolerant `try` is
    portable — it throws MODULE_NOT_FOUND before the target lands and the existing
    handler catches it, exactly as the Python already survives its own lookup failing.
    Both of today's are the same `_db_of` helper reaching `backup.database_of`.
    """
    result = order.analyse()
    deferred = {(d["from"], d["to"]) for d in result["deferred"]}
    assert ("houston.perf.mongoprof", "houston.services.backup") in deferred
    assert ("houston.scaleseed", "houston.services.backup") in deferred
    for entry in result["deferred"]:
        assert entry["kind"] == order.scc_check.FUNCTION_BODY
        assert entry["owedBy"] == entry["toStep"], (
            "a deferred edge is owed a parity test by the step that lands its target; "
            "without that the fallback is the only path ever exercised")


def test_an_unguarded_call_time_edge_is_not_deferred(order, monkeypatch, tmp_path):
    """The guard is CHECKED, not assumed.

    A function-body import with nothing catching it is unportable for the same reason a
    module-level one is: the `require()` throws and the call fails. This plants exactly
    that shape and requires it to be reported as a violation rather than deferred.
    """
    planted = tmp_path / "houston"
    (planted / "services").mkdir(parents=True)
    (planted / "__init__.py").write_text("", encoding="utf-8")
    (planted / "services" / "__init__.py").write_text("", encoding="utf-8")
    (planted / "services" / "audit.py").write_text(
        "def who():\n"
        "    from houston.services.backup import database_of\n"
        "    return database_of\n",
        encoding="utf-8")
    (planted / "services" / "backup.py").write_text(
        "def database_of(name):\n    return name\n", encoding="utf-8")
    monkeypatch.setattr(order, "PACKAGE", planted)

    result = order.analyse()
    assert result["deferred"] == [], (
        "nothing catches this import, so it cannot be deferred")
    assert [(v["from"], v["to"], v["kind"]) for v in result["violations"]] == [
        ("houston.services.audit", "houston.services.backup",
         order.scc_check.FUNCTION_BODY)]


def test_every_phase_six_module_is_claimed_by_exactly_one_step(order):
    """No module ports twice, and none is left for nobody.

    A prefix that captures a sibling subtree is the silent version of this: the gate
    keeps passing while a whole package is judged against the wrong step.
    """
    modules = order.scc_check.discover(order.PACKAGE)
    for module in modules:
        claims = [step for step, prefixes in order.PORT_ORDER.items()
                  if any(module == p or module.startswith(f"{p}.") for p in prefixes)]
        assert len(claims) <= 1, f"{module} is claimed by {claims}"

    unplaced = sorted(
        m for m in modules
        if order.step_of(m) is None and order.classify(m) == "unknown")
    assert unplaced == [], (
        f"{unplaced} belong to no step, no earlier phase and no written exemption")
