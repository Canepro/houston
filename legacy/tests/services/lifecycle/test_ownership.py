"""`houston.services.lifecycle.ownership`: its own spec file.

Co-located out of `tests/test_services.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations


def test_down_reports_the_result_not_the_flag(monkeypatch, tmp_path):
    """`down --volumes` printed "✓ removed" from the FLAG, not from the result.

    So a teardown that refused -- returning `removed: False` and emitting a warning
    saying the local record was deliberately KEPT -- was reported as complete success,
    exit 0. The GUI got it right because it streams the events; the CLI passed no
    `emit` at all, so the warning went nowhere and the success line printed over the
    top of it. `list` then kept showing the workspace, which is how somebody finds out.
    """
    from typer.testing import CliRunner

    from houston import cli
    from houston.services import lifecycle as lc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(lc.naming, "resolve_name", lambda *a, **k: "stuck")
    monkeypatch.setattr(lc.ownership, "owner_of", lambda *a, **k: "", raising=False)
    monkeypatch.setattr(lc.ownership, "may_destroy", lambda *a, **k: (True, ""), raising=False)

    def refuses(name, **kw):
        emit = kw.get("emit")
        if emit:
            from houston.services.events import Event
            emit(Event("'stuck': the namespace is not confirmed gone, so the local "
                       "record is KEPT.", phase="teardown", level="warn"))
        return {"name": "stuck", "removed": False, "found": False,
                "runtime": "kubernetes"}
    monkeypatch.setattr(lc.destroy, "teardown", refuses)

    res = CliRunner().invoke(cli.app, ["down", "--name", "stuck", "--volumes", "--yes"])

    assert res.exit_code != 0, (
        f"exit 0 on a refused teardown\n{res.output}")
    assert "was NOT removed" in res.output, res.output
    # The service's own reason reaches the terminal, which needs the emit to be passed.
    assert "not confirmed gone" in res.output, (
        f"the teardown's warning never reached the user\n{res.output}")
    assert "✓" not in res.output.split("was NOT removed")[0][-40:], res.output

    # And a teardown that SUCCEEDS still reports success.
    monkeypatch.setattr(lc.destroy, "teardown", lambda name, **kw: {
        "name": "ok", "removed": True, "found": True, "runtime": "kubernetes"})
    res = CliRunner().invoke(cli.app, ["down", "--name", "ok", "--volumes", "--yes"])
    assert res.exit_code == 0, res.output
    assert "removed" in res.output and "NOT removed" not in res.output, res.output
