"""`houston.web.routes.clusters`: its own spec file.

Co-located out of `tests/test_web.py`. Each of these touches several modules and is
filed under the one it touches most; `tools/test-attribution.json` records
the margin.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from webhelpers import _as, client

# --- the cluster ledger over HTTP ----------------------------------------------------

def test_the_cluster_ledger_is_readable_by_everyone_and_spendable_by_nobody_but_admins(
        monkeypatch, tmp_path):
    """Reads at readonly+, money and destruction at admin.

    The split is not the usual read/write one. `prepare` changes a cluster and costs
    nothing, so it is a write like any other; `create` spends real money for as long
    as nobody remembers to remove it and `delete` destroys something that may hold
    colleagues' work on machines this box has never seen. The rule this repo already
    applies to the shared edge -- a member may create and destroy their OWN
    workspaces, but the box's shared front door is not theirs to edit -- is the same
    rule, and a cluster is a good deal more shared than the edge.
    """
    from houston.services import cluster as clustersvc
    from houston.services import users as usersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(clustersvc, "known_contexts",
                        lambda: {"contexts": [], "unreadable": "", "default": ""})
    c = client(role="readonly")
    usersvc.add("boss", "the-boss-password", role="admin")

    # A readonly session can SEE what the box is costing. A ledger whose job is to
    # stop a cluster being forgotten works better the more people can see it.
    assert c.get("/api/clusters").status_code == 200
    assert c.get("/api/clusters/iam-policy").status_code == 200

    for path, body in (("/api/clusters/create", {"name": "x"}),
                       ("/api/clusters/delete", {"name": "x"}),
                       ("/api/clusters/prepare", {"context": "x"})):
        assert c.post(path, json=body).status_code == 403, f"{path} must refuse readonly"

    _as(c, "boss", "the-boss-password")
    # An admin gets past the ROLE gate; what stops them now is the service layer's own
    # refusals, which is where that decision belongs.
    assert c.post("/api/clusters/create", json={}).status_code == 400, \
        "a create with no name is a bad request, not a permissions problem"
    assert c.post("/api/clusters/delete", json={}).status_code == 400


def test_a_create_over_http_gets_the_same_expiry_grammar_as_the_flag(monkeypatch, tmp_path):
    """`expires` arrives as a number of days or the word `never`, and is PARSED.

    Trusting it would let an unparseable value become "no expiry", and the expiry tag
    is the only thing that will later say this cluster was meant to be temporary.
    """
    from houston.services import cluster as clustersvc
    from houston.services import eks as ekssvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(clustersvc, "known_contexts",
                        lambda: {"contexts": [], "unreadable": "", "default": ""})
    import time
    seen: list = []
    monkeypatch.setattr(ekssvc.aws, "create_cluster",
                        lambda name, **kw: seen.append((name, kw)) or {"region": "us-east-1"})
    c = client()

    assert c.post("/api/clusters/create",
                  json={"name": "s", "expires": "banana"}).status_code == 400
    assert not seen, "an unparseable expiry must not reach the service"

    assert c.post("/api/clusters/create", json={"name": "s", "expires": "never"}).status_code == 200
    assert c.post("/api/clusters/create", json={"name": "s", "expires": "3"}).status_code == 200
    assert c.post("/api/clusters/create", json={"name": "s"}).status_code == 200
    for _ in range(40):                       # the job runs on a worker thread
        if len(seen) == 3:
            break
        time.sleep(0.05)
    assert [kw["expires_days"] for _, kw in seen] == [None, 3, ekssvc.DEFAULT_EXPIRY_DAYS], \
        "never -> no tag, a number -> that many days, nothing -> the default"


def test_one_cluster_that_cannot_be_read_does_not_take_the_page_with_it(monkeypatch, tmp_path):
    """The list and the per-cluster probe are separate endpoints on purpose.

    `status()` is six or more round trips and a refusing cluster spends the whole
    timeout on each, so one endpoint returning everything would make the page as slow
    as its worst cluster -- and a browser cannot draw anything until it answers.
    """
    from houston.services import cluster as clustersvc

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    ARN = "arn:aws:eks:us-east-1:1:cluster/support"
    monkeypatch.setattr(clustersvc, "known_contexts", lambda: {
        "contexts": [{"context": ARN, "ours": False, "provider": "eks",
                      "billable": True, "is_default": False}],
        "unreadable": "", "default": ""})
    monkeypatch.setattr(clustersvc, "status", lambda ctx="", emit=None: {
        "context": ctx, "reachable": False, "reach_status": "denied",
        "reach_why": "it answered and refused these credentials", "reach_advice": "",
        "unreadable": ["cluster"], "nodes": None, "workspaces": None, "pvcs": None,
        "loadbalancers": None, "cost": None})
    c = client()

    listed = c.get("/api/clusters").json()
    assert listed["contexts"][0]["context"] == ARN, "the list answers without probing"

    probed = c.get("/api/clusters/status", params={"context": ARN}).json()
    assert probed["reachable"] is False
    assert probed["reach_status"] == "denied"
    for empty in ("nodes", "workspaces", "pvcs", "loadbalancers", "cost"):
        assert probed[empty] is None, f"{empty} came back as a value for a cluster that refused"
