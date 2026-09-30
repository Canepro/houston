"""`houston.services.events`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

from houston.services import events
import subprocess


def test_event_model_and_emit():
    seen: list[events.Event] = []
    events.info(seen.append, "hello", phase="boot", pct=50, name="x")
    events.warn(seen.append, "careful", phase="wait")
    assert seen[0].phase == "boot" and seen[0].pct == 50 and seen[0].data == {"name": "x"}
    assert seen[1].level == "warn"
    d = seen[0].as_dict()
    assert d["message"] == "hello" and d["terminal"] is False


def test_detaching_monitoring_that_was_never_attached_says_nothing_alarming(monkeypatch):
    """Measured live: `monitor --off` on a workspace whose attach had failed ran the
    uninstall anyway, helm answered "Release not loaded: monitoring: release: not found",
    and the fallback announced that "the monitoring stack needed its finalizers cleared by
    hand" -- a frightening sentence about wreckage that did not exist.

    Nothing installed is nothing to report, which is also what `remove_operator` already
    did; the two are symmetric now.
    """
    import subprocess as sp

    from houston.services import k8s

    calls = []

    def run(argv, timeout=None, own=False, env=None, input=None):
        calls.append(" ".join(argv))
        # `helm list -o json` answers with an empty array: nothing installed here.
        return sp.CompletedProcess(argv, 0, "[]", "")

    monkeypatch.setattr(k8s.kube, "run", run)
    events = []
    assert k8s.remove_monitoring(context="default", emit=events.append) is False
    assert not any("uninstall" in c for c in calls), calls
    assert not any("finalizer" in e.message for e in events), [e.message for e in events]


def test_events_imports_standalone_so_the_log_cannot_cycle():
    """The failure mode that would break every command at startup.

    `services/events.py` deliberately imports nothing from `houston` and is imported by
    thirteen modules. `eventlog` reaches `config` for the path and `lifecycle` for the
    redaction helpers, and `lifecycle` imports `events`. A module-level import in the
    tee is a circular import, and the symptom is not a subtle bug -- it is every command
    failing to start.
    """
    import ast
    import pathlib
    import sys

    from houston.services import events

    tree = ast.parse(pathlib.Path(events.__file__).read_text())
    top = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    for node in top:
        mod = getattr(node, "module", "") or ""
        names = [a.name for a in node.names]
        assert not mod.startswith("houston"), (
            f"events.py imports {mod} at module level — that is the cycle")
        assert not any(n.startswith("houston") for n in names), names

    # And proven by import, in a fresh interpreter, with nothing else loaded first.
    root = str(pathlib.Path(events.__file__).parent.parent.parent)
    proc = subprocess.run(
        [sys.executable, "-c", "import houston.services.events; print('ok')"],
        capture_output=True, text=True, timeout=60,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": root, "HOME": "/tmp"})
    assert proc.returncode == 0 and "ok" in proc.stdout, proc.stderr[-400:]
