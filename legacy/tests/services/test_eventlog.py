"""`houston.services.eventlog`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

import json
from houston.services import lifecycle as lc
from conftest import source_of


def test_the_event_log_never_writes_a_credential(monkeypatch, tmp_path):
    """The one way this feature can make things WORSE rather than better.

    Before it, credentials lived in memory and on stdout. After it there is a FILE, so a
    hole in the redaction creates an exposure that did not exist. Terminal events carry
    the whole result document, the token/pat/env paths hold live credentials, and
    `MONGO_URL` carries a password in its VALUE -- which is why `_URL_USERINFO` exists
    and why matching on key names alone is not enough.
    """

    from houston.services import eventlog
    from houston.services.events import Event

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    eventlog._DISABLED = False
    eventlog._SIZE = None

    eventlog.event(Event(
        "connecting to mongodb://admin:s3cr3t-pw@mongodb:27017/rocketchat",
        phase="boot",
        data={
            "MONGO_URL": "mongodb://rcuser:another-secret@mongodb:27017/rc",
            "LDAP_BIND_PASSWORD": "bind-me",
            "OAUTH_CLIENT_SECRET": "shh",
            "api_key": "AKIAEXAMPLE",
            "result": {"authToken": "live-token", "nested": {"password": "deep"}},
            "token": "another-live-token",
            "harmless": "rocketchat",
        }))
    text = eventlog.log_path().read_text()

    for leaked in ("s3cr3t-pw", "another-secret", "bind-me", "shh", "AKIAEXAMPLE",
                   "live-token", "another-live-token", "deep"):
        assert leaked not in text, f"{leaked!r} was written to the log"
    # Redacted, not simply dropped: the shape of the event is still readable.
    doc = json.loads(text.strip().splitlines()[-1])
    assert doc["data"]["harmless"] == "rocketchat"
    assert doc["data"]["LDAP_BIND_PASSWORD"] == "********"
    assert "result" not in doc["data"] and "token" not in doc["data"]
    # The URL's userinfo is redacted in the MESSAGE too, where no key name exists.
    assert "mongodb://admin:********@" in doc["msg"], doc["msg"]


def test_the_event_log_is_bounded_private_and_silent(monkeypatch, tmp_path):
    """Three properties that stop a log becoming its own problem."""
    import os

    from houston.services import eventlog
    from houston.services.events import Event

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setenv("HOUSTON_LOG_MAX_MB", "0.002")     # ~2 KB, to rotate quickly
    eventlog._DISABLED = False
    eventlog._SIZE = None

    for i in range(400):
        eventlog.event(Event(f"line {i} " + "x" * 60, phase="boot"))

    cur = eventlog.log_path()
    old = cur.with_suffix(cur.suffix + ".1")
    assert cur.exists() and old.exists(), "did not rotate"
    # TWO files, not a growing family.
    assert len(list(cur.parent.glob("houston.log*"))) == 2, sorted(cur.parent.iterdir())
    assert oct(cur.stat().st_mode)[-3:] == "600", oct(cur.stat().st_mode)
    assert oct(cur.parent.stat().st_mode)[-3:] == "700", oct(cur.parent.stat().st_mode)

    # An unwritable home DISABLES it and never raises -- the operation being described
    # matters more than describing it.
    ro = tmp_path / "ro"
    ro.mkdir()
    os.chmod(ro, 0o500)
    monkeypatch.setenv("HOUSTON_HOME", str(ro))
    monkeypatch.delenv("HOUSTON_LOG_MAX_MB", raising=False)
    eventlog._DISABLED = False
    eventlog._SIZE = None
    try:
        eventlog.event(Event("into a read-only home", phase="boot"))
        assert eventlog._DISABLED is True, "a failed write did not disable the log"
    finally:
        os.chmod(ro, 0o700)
        eventlog._DISABLED = False
        eventlog._SIZE = None


def test_dockers_echo_stays_out_but_warnings_never_do(monkeypatch, tmp_path):
    """`_up` turns every line of `docker compose pull` into an event.

    A GUI create emits several hundred "Downloading 45.09MB" records -- echo, not
    narrative. Logging it buries the four lines that matter and spends the whole size
    cap on one create. A warning or an error is never skipped, echo or not.
    """

    from houston.services import eventlog
    from houston.services.events import Event

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    eventlog._DISABLED = False
    eventlog._SIZE = None

    eventlog.event(Event("Downloading 45.09MB", phase="boot", data={"echo": "docker"}))
    eventlog.event(Event("resolved 8.5.1", phase="create"))
    eventlog.event(Event("pull failed: rate limit", phase="boot", level="warn",
                         data={"echo": "docker"}))
    text = eventlog.log_path().read_text()

    assert "Downloading 45.09MB" not in text, "docker echo reached the log"
    assert "resolved 8.5.1" in text
    assert "rate limit" in text, "a WARNING was skipped because it carried echo"

    # Opt back in when somebody is debugging a pull.
    monkeypatch.setenv("HOUSTON_LOG_ECHO", "1")
    eventlog.event(Event("Downloading 99MB", phase="boot", data={"echo": "docker"}))
    assert "Downloading 99MB" in eventlog.log_path().read_text()

    # And the tag really is applied at the one place that produces the echo.
    assert 'echo="docker"' in source_of(lc._up)


def test_every_record_names_the_build_that_wrote_it_and_how_it_was_started(
        monkeypatch, tmp_path):
    """STATE 8.9.0 (3.3): the soak is read from this file, and both builds append to it
    once a home is dual-v1. Without the writer and the route on every line, a failure
    could not be attributed and a soak could not count what the flipped build answered."""
    from houston import lock
    from houston.services import eventlog

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setitem(eventlog._CONTEXT, "via", "direct")
    eventlog._DISABLED = False
    eventlog._SIZE = None

    assert eventlog.IMPL == lock.THIS_IMPLEMENTATION
    eventlog.started("list --json")
    eventlog.configure(via="dispatcher")
    eventlog.ended(0, 0.5)
    eventlog.configure(via="neither")          # not a way to be started: ignored
    eventlog.failed("internal", "boom")
    rows = [json.loads(line) for line in eventlog.log_path().read_text().splitlines()]
    assert [(r["impl"], r["via"]) for r in rows] == [
        ("python", "direct"), ("python", "dispatcher"), ("python", "dispatcher")]
    # The order both builds write, which the state referee compares line for line.
    assert list(rows[0])[:6] == ["ts", "run", "pid", "kind", "impl", "via"]


def test_an_unhandled_error_is_logged_as_having_printed_a_traceback(monkeypatch, tmp_path,
                                                                    capsys):
    """The soak's rule counts tracebacks (STATE 8.9.0 soakRule (2)), and `main` is the one
    path that prints one: its `error` record must say so, and a handled failure's must not."""
    import pytest

    import houston.cli as cli
    from houston.services import eventlog

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(cli.sys, "argv", ["houston", "list"])
    eventlog._DISABLED = False
    eventlog._SIZE = None

    def boom():
        raise RuntimeError("a state no command anticipated")

    monkeypatch.setattr(cli, "app", boom)
    with pytest.raises(SystemExit) as exited:
        cli.main()
    assert exited.value.code == 1
    assert "Traceback (most recent call last)" in capsys.readouterr().err
    errors = [json.loads(line) for line in eventlog.log_path().read_text().splitlines()
              if json.loads(line)["kind"] == "error"]
    assert [(e["code"], e["trace"]) for e in errors] == [("REPRO_ERROR", True)]
