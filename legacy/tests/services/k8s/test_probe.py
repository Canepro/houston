"""`houston.services.k8s.probe`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

import subprocess


def test_a_version_floor_cannot_express_skew(monkeypatch):
    """Two different questions, and only the second can be true about a cluster.

    A floor is a fact about houston: kubectl >= 1.21. Skew is a fact about the cluster
    in front of you, and Rocket.Chat's own Launchpad builds them at 1.33 — so a kubectl
    eleven minors PAST the floor is still outside the supported ±1 window, and passing
    a floor is exactly what it would report doing. Calls do not fail cleanly across
    that gap; they fail on a field one side does not know, which reads as a bug in
    whatever was being deployed.
    """

    from houston.services import k8s

    def server(ver: str):
        monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw:
                            subprocess.CompletedProcess(
                                argv, 0,
                                '{"serverVersion": {"gitVersion": "%s"}}' % ver, ""))

    server("v1.33.1")
    # The floor says this kubectl is fine. It is eleven minors from the server.
    assert k8s.Tool(name="kubectl", path="/k",
                    version=(1, 22)).new_enough is True, "the floor passes it"
    out = k8s.skew("ctx", client=(1, 22))
    assert out["ok"] is False and out["gap"] == 11, out

    # Inside the window, either side of it.
    assert k8s.skew("ctx", client=(1, 32))["ok"] is True
    assert k8s.skew("ctx", client=(1, 34))["ok"] is True
    assert k8s.skew("ctx", client=(1, 35))["ok"] is False

    # A different MAJOR is not a near miss.
    assert k8s.skew("ctx", client=(2, 33))["ok"] is False

    # Unreadable is None, not "fine" -- a skew nobody could measure must not be
    # reported as a match.
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw:
                        subprocess.CompletedProcess(argv, 1, "", "forbidden"))
    assert k8s.skew("ctx", client=(1, 33)) is None
