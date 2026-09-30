"""Portable object-property contracts for the Docker command seam."""

from types import SimpleNamespace

from houston import runner


def test_the_docker_seam_is_a_live_exported_property(monkeypatch):
    seen = []

    def fake_run(argv, **kwargs):
        seen.append((argv, kwargs))
        return SimpleNamespace(returncode=0, stdout="4 8589934592", stderr="")

    monkeypatch.setattr(runner.docker, "run", fake_run)

    assert runner.docker_capacity() == (4.0, 8589934592)
    assert seen and seen[0][0][:2] == ["docker", "info"]
