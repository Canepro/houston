"""`houston.services.lifecycle.destroy`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from houston.services import lifecycle as lc


def _a_workspace_with_the_monitoring_stack_attached(monkeypatch, tmp_path):
    """A workspace and the Prometheus/Grafana add-on that was attached to it."""
    import json as _json

    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    (tmp_path / "repros" / "mon").mkdir(parents=True)
    (tmp_path / "repros" / "mon" / "repro.json").write_text(_json.dumps({
        "name": "mon", "project": "p", "rc_version": "8.5.1", "rc_image": "i",
        "mongo_tag": "8.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001, "version_source": "x",
        "extra": {"runtime": "kubernetes", "namespace": "houston-mon",
                  "context": "default", "monitoring": True,
                  "grafana_pid": 4242}}))
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(k8s.namespace, "delete_namespace", lambda *a, **k: True)
    called = {}
    monkeypatch.setattr(k8s.operator, "remove_operator",
                        lambda **kw: called.setdefault("operator", kw) is None)
    monkeypatch.setattr(k8s.monitoring, "remove_monitoring",
                        lambda **kw: called.setdefault("monitoring", kw) is None)

    stopped = []
    monkeypatch.setattr(lc.ready, "_stop_port_forward",
                        lambda pid, **kw: stopped.append(pid))
    lc.teardown("mon", volumes=True, confirm=True)
    return _json, called, stopped, topology


def test_down_volumes_takes_the_monitoring_stack_with_it(monkeypatch, tmp_path):
    """Reported from a live k3s box: after `down --volumes` the monitoring stack was
    still running -- ten pods and ~840 MB, wanted by nobody, because the workspace that
    asked for it had been destroyed.

    `remove_monitoring` could always do this. It was only ever called by `monitor --off`,
    so the teardown walked past the most expensive thing houston installs. On Compose
    there was nothing to fix: the stack is part of the workspace's own compose project
    and goes down with it.
    """
    _json, called, stopped, topology = _a_workspace_with_the_monitoring_stack_attached(monkeypatch, tmp_path)
    assert "monitoring" in called, "the monitoring stack was left running"
    # And the Grafana forward, which targets a deployment in `houston-system` and so
    # SURVIVES the workspace: it went on holding :5050 after the workspace was destroyed,
    # and the next `up --monitor` was refused for a port held by a corpse.
    assert 4242 in stopped, "the Grafana port-forward was left holding its host port"
    # The namespace being destroyed must not be counted as still wanting it: the count
    # reads a label on the namespace, and a namespace still Terminating is still listed
    # and still labelled.
    assert called["monitoring"]["excluding"] == "houston-mon"
    assert called["operator"]["excluding"] == "houston-mon"

    # A plain `down` keeps the namespace and the data, so the workspace can come back and
    # the stack it wants must stay with it.
    called.clear()
    (tmp_path / "repros" / "mon").mkdir(parents=True, exist_ok=True)
    (tmp_path / "repros" / "mon" / "repro.json").write_text(_json.dumps({
        "name": "mon", "project": "p", "rc_version": "8.5.1", "rc_image": "i",
        "mongo_tag": "8.0", "mongo_flavor": "official", "preset": "default",
        "root_url": "http://localhost:3001", "host_port": 3001, "version_source": "x",
        "extra": {"runtime": "kubernetes", "namespace": "houston-mon",
                  "context": "default", "monitoring": True}}))
    stopped.clear()
    lc.teardown("mon", volumes=False, confirm=True)
    assert called == {}, "a plain `down` must leave both alone — the workspace comes back"
    assert 4242 not in stopped, \
        "and Grafana stays reachable for a workspace that is coming back"
    assert topology.KUBERNETES  # the branch under test is the Kubernetes one


def _a_record(tmp_path, name, extra):
    """A workspace record as `up` leaves it, on the runtime `extra` names."""
    import json as _json

    (tmp_path / "repros" / name).mkdir(parents=True, exist_ok=True)
    (tmp_path / "repros" / name / "repro.json").write_text(_json.dumps({
        "name": name, "project": f"houston-{name}", "rc_version": "8.5.1",
        "rc_image": "i", "mongo_tag": "8.0", "mongo_flavor": "official",
        "preset": "default", "root_url": "http://localhost:3001", "host_port": 3001,
        "version_source": "x", "extra": extra}))


def test_down_volumes_takes_the_workspace_s_repair_notes_and_a_plain_down_keeps_them(
        monkeypatch, tmp_path):
    """Seen on the owner's box: 28 `create_unfinished` notes for `alice-rc8-5-1`, one per
    `up` that did not finish, all still there after `down --volumes` had removed its
    containers, its volume and its record. Only a create that finishes and `ready` ever
    cleared one, and both need the workspace to exist, so `doctor` went on advising
    `houston ready --name alice-rc8-5-1` -- advice that cannot work on a workspace that
    is gone.

    Both runtimes, because they delete the record in different places. A plain `down`
    keeps the record and the data, so it keeps the notes: `ready` still completes that
    workspace. A cluster note under the same name is about a CLOUD CLUSTER, which this
    workspace's deletion says nothing about, and another workspace's notes are not this
    one's business.
    """
    from houston.services import journal, k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.preconditions, "require_docker", lambda: None)
    monkeypatch.setattr(lc.ownership, "may_destroy", lambda *a, **k: (True, ""))
    monkeypatch.setattr(lc.auditsvc, "record", lambda *a, **k: None)
    monkeypatch.setattr(lc.edgesvc.networks, "detach", lambda n: None)
    monkeypatch.setattr(lc.edgesvc.routes, "deregister", lambda n: None)
    monkeypatch.setattr(lc.runner.engine, "down", lambda n, volumes=False: 0)
    monkeypatch.setattr(k8s.namespace, "delete_namespace", lambda *a, **k: True)
    monkeypatch.setattr(k8s.operator, "remove_operator", lambda **kw: False)
    monkeypatch.setattr(k8s.monitoring, "remove_monitoring", lambda **kw: True)

    def notes(name=None):
        return sorted((e.kind, e.workspace) for e in journal.open_entries()
                      if name is None or e.workspace == name)

    journal.record(journal.CREATE_UNFINISHED, "bystander")
    runtimes = {"notes-cmp": {"runtime": "docker"},
                "notes-kub": {"runtime": "kubernetes", "namespace": "houston-notes-kub",
                              "context": "default"}}
    for name, extra in runtimes.items():
        _a_record(tmp_path, name, extra)
        for kind in (journal.CREATE_UNFINISHED, journal.CREATE_UNFINISHED,
                     journal.RATE_LIMITER_OFF, journal.CLUSTER_UNFINISHED):
            journal.record(kind, name)

        lc.teardown(name, volumes=False)
        assert (tmp_path / "repros" / name / "repro.json").exists()
        assert len(notes(name)) == 4, f"a plain `down` of {name} dropped its notes"

        lc.teardown(name, volumes=True, confirm=True)
        assert not (tmp_path / "repros" / name).exists()
        assert notes(name) == [("cluster_unfinished", name)], \
            f"`down --volumes` of {name} left its repair notes behind: {notes(name)}"

    assert notes() == [("cluster_unfinished", "notes-cmp"),
                       ("cluster_unfinished", "notes-kub"),
                       ("create_unfinished", "bystander")], notes()
