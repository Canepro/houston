"""Ownership and concurrency contract for the dependency-inverted Event sinks."""

from __future__ import annotations

import threading

import pytest

from houston.services import eventlog, events


def test_event_sinks_are_keyed_lease_counted_and_owned():
    """Two live front ends share one sink without duplicating or removing each other."""
    seen = []
    sink = seen.append
    release_one = events.install_sink("test-leases", sink)
    release_two = events.install_sink("test-leases", sink)
    try:
        with pytest.raises(ValueError):
            events.install_sink("test-leases", lambda ev: None)

        events.info(events.null_emit, "both leases")
        assert [ev.message for ev in seen] == ["both leases"], \
            "two leases invoked one sink twice"

        release_one()
        release_one()  # releasing one ownership token twice is harmless
        events.info(events.null_emit, "second owner remains")
        assert [ev.message for ev in seen] == ["both leases", "second owner remains"]

        release_two()
        events.info(events.null_emit, "nobody owns it")
        assert [ev.message for ev in seen] == ["both leases", "second owner remains"], \
            "the sink survived its final lease"
    finally:
        release_one()
        release_two()


def test_one_broken_event_sink_does_not_block_the_next_sink():
    seen = []

    def broken(_ev):
        raise RuntimeError("logging failed")

    release_bad = events.install_sink("test-broken", broken)
    release_good = events.install_sink("test-good", seen.append)
    try:
        events.warn(events.null_emit, "still delivered")
        assert [ev.message for ev in seen] == ["still delivered"]
    finally:
        release_bad()
        release_good()


def test_event_sink_snapshot_is_safe_while_leases_churn():
    """Install/uninstall may race an emit; the permanent sink must lose no events."""
    seen = []
    seen_lock = threading.Lock()

    def permanent(ev):
        with seen_lock:
            seen.append(ev.message)

    release = events.install_sink("test-permanent", permanent)
    failures = []

    def churn():
        try:
            for _ in range(500):
                undo = events.install_sink("test-churn", lambda ev: None)
                undo()
        except Exception as exc:  # noqa: BLE001 - asserted from the parent thread
            failures.append(exc)

    thread = threading.Thread(target=churn)
    thread.start()
    try:
        for i in range(500):
            events.info(events.null_emit, f"event-{i}")
    finally:
        thread.join(timeout=10)
        release()

    assert not thread.is_alive(), "sink churn deadlocked with emit"
    assert not failures, failures
    assert len(seen) == 500, "the permanent sink lost events while the registry changed"


def test_cli_bootstrap_owns_one_durable_event_sink(monkeypatch, tmp_path):
    from houston import cli

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(cli, "_adopt_pre_rename_state", lambda: None)
    monkeypatch.setattr(cli.lock, "require_this_implementation", lambda home: None)
    monkeypatch.setattr(
        cli, "app", lambda: events.info(events.null_emit, "cli-bootstrap-event"))
    eventlog._DISABLED = False
    eventlog._SIZE = None

    cli.main()
    path = eventlog.log_path()
    assert path.read_text().count("cli-bootstrap-event") == 1

    before = path.read_text()
    events.info(events.null_emit, "after-cli-lifecycle")
    assert path.read_text() == before, "CLI left its event-log lease installed"


def test_two_app_lifecycles_share_one_eventlog_sink_without_stealing_it(
        monkeypatch, tmp_path):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from houston.web.app import create_app

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    eventlog._DISABLED = False
    eventlog._SIZE = None
    first = create_app()
    second = create_app()

    with TestClient(first, base_url="http://localhost"):
        events.info(events.null_emit, "first-only")
        with TestClient(second, base_url="http://localhost"):
            events.info(events.null_emit, "both-apps")
        events.info(events.null_emit, "first-remains")

    path = eventlog.log_path()
    text = path.read_text()
    for message in ("first-only", "both-apps", "first-remains"):
        assert text.count(message) == 1, f"{message!r} was missing or duplicated"

    before = text
    events.info(events.null_emit, "after-app-lifecycles")
    assert path.read_text() == before, "the final app did not release its sink lease"
