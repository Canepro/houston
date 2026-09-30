"""`houston.services.edge`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

def test_a_stale_edge_route_is_not_told_to_run_down(tmp_path, monkeypatch):
    """`down --name <it>` CANNOT remove a route whose workspace is gone -- the
    workspace is the missing half, so `down` answers "no such workspace" and the
    route stays exactly where it was.

    Found by running `houston doctor` against a home in that state and following
    its own advice. The route survives, the hostname goes on 502ing, and the name
    cannot be reused. `edge delete` takes the HOSTNAME, which is the part that still
    exists, and takes the certificate and private key with it.
    """
    from houston.services import doctor as doctorsvc
    from houston.services import edge as edgesvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    edgesvc.write(edgesvc.Edge(domain="support.example.com",
                               acme_email="ops@example.com"))
    edgesvc.register("ghost", "ghost.example.com", local=True)
    monkeypatch.setattr(edgesvc.engine, "running", lambda: True)
    monkeypatch.setattr(edgesvc.spec, "config_drift", lambda: ([], []))
    monkeypatch.setattr(edgesvc.networks, "attached_networks", lambda: set())
    monkeypatch.setattr(edgesvc.engine, "port_holder", lambda p=443: "")

    rows = doctorsvc.run_checks()["checks"]
    said = " ".join(r["message"] for r in rows if "no workspace" in r["message"])
    assert said, "the stale route must still be reported"
    assert "edge delete ghost.example.com" in said, said
    assert "down --name" not in said, f"advice that cannot work: {said}"
