"""`houston.services.perf`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

import textwrap as _textwrap
from conftest import source_of
from houston import errors
from servicehelpers import _kube_workspace
import pytest


def test_perf_run_loadtest_validates(monkeypatch):
    from houston.services import perf
    monkeypatch.setattr(perf.lifecycle.runner.host, "docker_available", lambda **_k: True)
    with pytest.raises(errors.ValidationError):
        perf.run_loadtest(perf.LoadtestReq(name="x", scenario="webhook"))  # not a GUI scenario
    with pytest.raises(errors.ValidationError):
        perf.run_loadtest(perf.LoadtestReq(name="x", scenario="messages", vus=0))


def test_perf_capacity_validate(monkeypatch):
    """Was `test_perf_capacity_benchmark_validate`; `run_benchmark` went with the
    command in step 0.12, and the two capacity refusals stay."""
    from houston.services import perf
    monkeypatch.setattr(perf.lifecycle.runner.host, "docker_available", lambda **_k: True)
    with pytest.raises(errors.ValidationError):
        perf.run_capacity(perf.CapacityReq(name="x", scenario="webhook"))
    with pytest.raises(errors.ValidationError):
        perf.run_capacity(perf.CapacityReq(name="x", scenario="journey", start=0))


def test_a_load_test_refuses_a_kubernetes_workspace_instead_of_crashing(
        monkeypatch, tmp_path):
    """Both perf entry points read the compose file, so on Kubernetes they raised a
    bare FileNotFoundError: outside the ReproError contract, so `serve` answered 500
    and the CLI printed a traceback. And the refusal is not "unimplemented" -- the
    numbers would be measuring the `kubectl port-forward`.
    """
    from houston.services import perf

    _kube_workspace(tmp_path, monkeypatch, preset="default")
    monkeypatch.setattr(perf.lifecycle.runner.host, "docker_available", lambda **_k: True)
    with pytest.raises(errors.ValidationError) as caught:
        perf.run_loadtest(perf.LoadtestReq(name="k", scenario="messages", vus=1))
    assert "port-forward" in str(caught.value)
    with pytest.raises(errors.ValidationError):
        perf.run_capacity(perf.CapacityReq(name="k", scenario="messages"))


def test_a_failed_cap_restore_keeps_its_note(monkeypatch, tmp_path):
    """`journal.clear(constrain_note)` sat ABOVE the restore that may fail.

    `constrain_mod.restore` RETURNS problems rather than raising, and the loop beside
    it exists to report them -- so a failed restore left the containers capped with the
    note already deleted, throwing away the prior values CONSTRAINTS_APPLIED carries
    for exactly that repair. Its three siblings in the same `finally` all clear after a
    successful restore; this one did not, at all four sites.
    """

    from houston import cli
    from houston.services import perf as perfsvc

    for fn in (perfsvc.run_loadtest, perfsvc.run_capacity, cli.loadtest, cli.capacity):
        src = source_of(fn)
        if "constrain_note" not in src:
            continue
        name = getattr(fn, "__name__", str(fn))
        # The clear must be guarded by the problem list, not unconditional.
        assert "if not _cap_problems:" in src, (
            f"{name} clears the constraints note unconditionally")
        # BY POSITION, NOT BY SPELLING. The note is `constrain_note` in two of these
        # four and `run.constrain_note` in the other two, because the state they share
        # became an object -- and a literal match reported the call MISSING, which is
        # the same sentence this guard prints when somebody deletes it.
        import ast as _ast

        tree = _ast.parse(_textwrap.dedent(src))
        def _line(pred):
            found = [n.lineno for n in _ast.walk(tree)
                     if isinstance(n, _ast.Call) and pred(_ast.unparse(n))]
            assert found, f"{name}: no call matching this guard's subject"
            return min(found)

        restored = _line(lambda s: "constrain_mod.restore" in s)
        cleared = _line(lambda s: s.startswith("journal.clear(")
                        and "constrain_note" in s)
        assert restored < cleared, f"{name} still clears the note before restoring"
