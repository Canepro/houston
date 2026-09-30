"""One service warning reaches both human and machine front ends."""

from __future__ import annotations


def test_warning_event_feeds_json_envelope_and_terminal_stderr(capsys):
    from houston import cli, jsonout
    from houston.services import events

    seen = []
    events.warn(seen.append, "requested version ignored", phase="create",
                code="VERSION_IGNORED", requested="9", running="8")
    warning = seen[0]
    assert warning.code == "VERSION_IGNORED"

    jsonout.EventWriter().emit(warning)
    assert jsonout.warnings_so_far() == [{
        "code": "VERSION_IGNORED", "message": "requested version ignored",
        "detail": {"requested": "9", "running": "8"}}]

    cli._cli_emit(warning)
    assert "requested version ignored" in capsys.readouterr().err
    jsonout.json_mode_reset()
