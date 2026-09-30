"""`houston.services.lifecycle.state`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from houston import errors
from houston.services import lifecycle as lc
import pytest


def test_stop_and_start_scale_a_kubernetes_workspace_rather_than_calling_compose(
        monkeypatch, tmp_path):
    """Kubernetes has no pause, so stop/start is scale-to-zero and back.

    What has to match is COMPOSE'S CONTRACT, not Kubernetes' vocabulary: `stop`
    gives the memory back and keeps the data, `start` brings the same workspace back
    on the same port. Scaling leaves the PersistentVolumeClaim untouched, which is
    what puts this as far from `down --volumes` as `docker compose stop` is.

    Dispatched in `set_state` rather than in each front-end: the CLI's
    stop/start/restart and the GUI's always-enabled buttons both arrive through this
    one function, so one branch covers both and cannot drift.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.6.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3010,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    lc.runner.write("k", "", m)

    # `runner.engine`, not the façade: `stop`/`start`/`restart` live there now, and a
    # patch on the façade writes a real attribute into the package dict that shadows
    # `__getattr__` for every later test in the process.
    for name in ("stop", "start", "restart"):
        monkeypatch.setattr(lc.runner.engine, name,
                            lambda *a, **kw: pytest.fail("it called docker compose"))
    calls = []
    monkeypatch.setattr(k8s.scale, "stop_workspace",
                        lambda n, **kw: calls.append(("stop", n)))
    monkeypatch.setattr(k8s.scale, "start_workspace",
                        lambda n, **kw: calls.append(("start", n)))

    lc.set_state("k", "stop")
    assert calls == [("stop", "k")], calls

    calls.clear()
    lc.set_state("k", "start")
    assert calls == [("start", "k")], calls

    # restart is both, in that order -- not a no-op and not a start-then-stop.
    calls.clear()
    lc.set_state("k", "restart")
    assert calls == [("stop", "k"), ("start", "k")], calls

    # A bad action is still rejected the same way on both runtimes.
    with pytest.raises(errors.ValidationError):
        lc.set_state("k", "pause")
