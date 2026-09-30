"""`houston.runner.engine`: its own spec file.

Co-located out of `tests/test_edge.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from edgehelpers import _acme_workspace
from houston.services import edge as fd


def test_adopting_keeps_the_data_volume(tmp_path, monkeypatch):
    """The whole point of transforming the compose file rather than recreating
    from scratch: `down -v` is never involved."""
    from houston import runner

    _acme_workspace("w", "t1.kestron.org", tmp_path)
    monkeypatch.setattr(fd.networks, "attach", lambda name: True)
    calls = []
    monkeypatch.setattr(fd.engine, "_docker", lambda *a, **k: calls.append(a) or
                        type("P", (), {"returncode": 0, "stdout": ""})())
    monkeypatch.setattr(runner.engine, "up", lambda *a, **k: calls.append(("up",)) or 0)
    monkeypatch.setattr(runner.engine, "down", lambda *a, **k: calls.append(("down",)) or 0)
    fd.adopt("w")
    assert ("up",) not in calls, "adopting must not recreate the workspace"
    assert ("down",) not in calls, "nor tear it down"
    assert any("rm" in c for c in calls), "only its traefik container is removed"


def test_under_json_compose_draws_its_stdout_on_stderr(tmp_path, monkeypatch, capfd):
    """`capture_output=False` inherits the terminal, and under --json stdout is not the
    terminal's: `jsonout` promises it carries JSON and nothing else, and compose's stdout
    landed raw among the NDJSON lines of `up --json` (P21, g1-03, g2-03). So in JSON mode
    docker's stdout goes to stderr, where the person running the command still sees it.

    A real child, so the streams are the ones the kernel hands it: the suite's guard
    reports `docker` absent, and this stubs the runner's own process wrapper over it, as
    the guard says to."""
    import subprocess as stdlib

    from houston import jsonout, runner

    fake = tmp_path / "docker"
    fake.write_text("#!/bin/sh\nprintf 'out-line\\n'\nprintf 'err-line\\n' >&2\nexit 3\n")
    fake.chmod(0o755)
    monkeypatch.setattr(runner.engine.docker, "run",
                        lambda cmd, **kw: stdlib.run([str(fake), *cmd[1:]], **kw))
    runner.paths.workspace("w").mkdir(parents=True)

    assert runner.engine._compose("w", "up", "-d").returncode == 3
    assert capfd.readouterr() == ("out-line\n", "err-line\n")

    jsonout.activate()
    try:
        assert runner.engine._compose("w", "up", "-d").returncode == 3
        assert capfd.readouterr() == ("", "out-line\nerr-line\n")
        captured = runner.engine._compose("w", "up", "-d", capture=True)
    finally:
        jsonout.json_mode_reset()
    assert (captured.stdout, captured.stderr) == ("out-line\n", "err-line\n")
