"""`houston.services.monitor`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations


def test_detaching_monitoring_reports_progress_rather_than_going_quiet(monkeypatch, tmp_path):
    """A GUI job showed "running" with an empty log for nine minutes, which is
    indistinguishable from a hang -- and that is how the finalizer wait above was
    reported. Both detach paths emitted almost nothing until they had finished."""
    from houston import runner
    from houston.services import monitor as monsvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="w", project="houston-w", rc_version="8.5.1",
        rc_image="img", mongo_tag="8.0", mongo_flavor="community",
        preset="default", root_url="http://localhost:3000", host_port=3000,
        version_source="shipped")
    meta.extra.update({"runtime": "kubernetes", "namespace": "houston-w",
                       "context": "kind-houston-local", "monitoring": True})
    ws = runner.workspace("w"); ws.mkdir(parents=True, exist_ok=True)
    import json
    from dataclasses import asdict
    runner.atomic_write(ws / "repro.json", json.dumps(asdict(meta), indent=2))

    from houston.services import k8s
    monkeypatch.setattr(k8s.monitoring, "set_monitoring_label", lambda *a, **k: None)
    monkeypatch.setattr(k8s.monitoring, "remove_monitoring", lambda **k: True)
    monkeypatch.setattr(monsvc.lifecycle.admin, "login",
                        lambda m: (_ for _ in ()).throw(RuntimeError("down")))

    seen = []
    monsvc._detach_kubernetes("w", emit=lambda e: seen.append(e))
    # Something BEFORE the terminal event, or the log is empty while it works.
    assert len(seen) >= 3, [e.message for e in seen]
    assert any(e.phase == "monitor" for e in seen), [e.phase for e in seen]
    assert seen[-1].phase == "done", seen[-1].phase


def _workspace_with_compose(monkeypatch, tmp_path, compose_text: str):
    """A docker workspace "w" on disk, reachable, with this compose file; the calls that
    would change anything recorded rather than made."""
    import json
    from dataclasses import asdict

    from houston import runner
    from houston.runner import engine, queries, record
    from houston.services import monitor as monsvc
    from houston.services.lifecycle import admin, ports

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    meta = runner.Metadata(
        name="w", project="houston-w", rc_version="8.5.1",
        rc_image="img", mongo_tag="8.0", mongo_flavor="community",
        preset="default", root_url="http://localhost:3000", host_port=3000,
        version_source="shipped")
    ws = runner.workspace("w"); ws.mkdir(parents=True, exist_ok=True)
    runner.atomic_write(ws / "repro.json", json.dumps(asdict(meta), indent=2))
    (ws / "docker-compose.yml").write_text(compose_text, encoding="utf-8")
    calls = []
    monkeypatch.setattr(ports, "check_monitor_ports", lambda exclude="": None)
    monkeypatch.setattr(admin, "login", lambda m: {"token": "t"})
    monkeypatch.setattr(monsvc.rcapi, "set_setting", lambda *a, **k: True)
    monkeypatch.setattr(record, "write", lambda *a, **k: calls.append("write"))
    monkeypatch.setattr(engine, "up", lambda *a, **k: calls.append("up") or 0)
    monkeypatch.setattr(engine, "rm_services", lambda *a, **k: calls.append("rm") or 0)
    monkeypatch.setattr(queries, "remove_volumes", lambda *a, **k: calls.append("rmv") or [])
    return monsvc, ws, calls


def test_attach_refuses_a_compose_service_that_is_not_a_mapping(monkeypatch, tmp_path):
    """A hand-edited compose file with a service of no body (`mongodb:` alone is None)
    and no three-part port before it: `svc.get` on None was an AttributeError, a
    traceback and exit 1. Refused in one line instead, before anything is written or
    brought up (P21, g3-35) -- and a `services:` or `volumes:` that is not a mapping the
    same way, where `.update` on it was the AttributeError."""
    import pytest

    from houston.errors import ValidationError

    cases = [
        ("services:\n  rocketchat:\n    ports:\n    - 3100:3000\n  mongodb:\n",
         "service 'mongodb' is a NoneType"),
        ("services:\n  rocketchat: x\n", "service 'rocketchat' is a str"),
        ("services:\n- rocketchat\n", "'services' is a list"),
        ("services:\n  rocketchat: {}\nvolumes:\n", "'volumes' is a NoneType"),
    ]
    for text, what in cases:
        monsvc, ws, calls = _workspace_with_compose(monkeypatch, tmp_path, text)
        with pytest.raises(ValidationError) as caught:
            monsvc._attach_locked("w")
        assert str(caught.value) == (
            f"cannot edit the compose file of 'w': {what}, not a mapping"), text
        assert calls == [], (text, calls)
        assert (ws / "docker-compose.yml").read_text(encoding="utf-8") == text


def test_detach_refuses_a_compose_section_that_is_not_a_mapping(monkeypatch, tmp_path):
    """`doc.get("services", {}).pop(...)` on a `services:` of None was an AttributeError
    after the monitoring containers were removed; refused at the same point, and the file
    is not rewritten (P21, g3-35)."""
    import pytest

    from houston.errors import ValidationError

    for text, what in [("services:\nvolumes: {}\n", "'services' is a NoneType"),
                       ("services: {}\nvolumes: [a]\n", "'volumes' is a list")]:
        monsvc, ws, calls = _workspace_with_compose(monkeypatch, tmp_path, text)
        with pytest.raises(ValidationError) as caught:
            monsvc._detach_locked("w")
        assert str(caught.value) == (
            f"cannot edit the compose file of 'w': {what}, not a mapping"), text
        assert "write" not in calls, (text, calls)
