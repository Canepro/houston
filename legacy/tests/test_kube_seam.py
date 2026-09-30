"""Portable object-property contracts for the Kubernetes command seam."""

import subprocess

from houston.services import k8s


def test_the_kubernetes_command_seam_is_a_live_exported_property(monkeypatch):
    """A patched property intercepts a sibling function without reaching kubectl."""
    seen = []

    def fake_run(argv, **kwargs):
        seen.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, "portable-context\n", "")

    monkeypatch.setattr(k8s.kube, "run", fake_run)

    assert k8s.active_context() == "portable-context"
    assert seen and seen[0][0] == ["kubectl", "config", "current-context"]
