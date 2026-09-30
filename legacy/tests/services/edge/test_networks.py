"""`houston.services.edge.networks`: its own spec file.

Co-located out of `tests/test_edge.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""
from __future__ import annotations
from edgehelpers import _acme_workspace
from houston.services import edge as fd


def test_adopting_drops_the_workspaces_own_traefik(tmp_path, monkeypatch):
    from houston import runner, tls

    _acme_workspace("w", "t1.kestron.org", tmp_path)
    monkeypatch.setattr(fd.networks, "attach", lambda name: True)
    monkeypatch.setattr(fd.engine, "_docker", lambda *a, **k: type("P", (), {"returncode": 0, "stdout": ""})())

    res = fd.adopt("w")
    assert res == {"name": "w", "host": "t1.kestron.org"}
    doc = runner.read_compose("w")
    assert tls.SERVICE not in doc["services"], "its Traefik must go, or 443 stays held"
    # No network edits: the workspace keeps its own, and the EDGE joined it live.
    assert "networks" not in doc
