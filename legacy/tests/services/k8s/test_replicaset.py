"""`houston.services.k8s.replicaset`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations

def test_a_cold_mongod_is_retried_rather_than_failing_the_create(monkeypatch):
    """Reproduced twice out of two on freshly installed k3s clusters.

        error: could not initiate the MongoDB replica set:
               mongonetworkerror: connect econnrefused 127.0.0.1:27017

    `init_replica_set` waits for `containerStatuses[0].started` and its own comment
    says exactly why it cannot wait for READINESS -- readiness needs the replica set,
    and this is the initiation. That reasoning is right, and it leaves a window: the
    container is up and mongod has not bound :27017 yet.

    The retry existed and did not cover it. Its predicate was an allow-list of ONE
    error string ("container not found"), written for a different race -- a pod that
    reports `started` while terminating -- so a connection refusal returned on the
    first attempt and failed the whole create. On a warm cluster mongod binds before
    the exec arrives and nobody sees it; on an empty containerd store with a cold PVC
    it loses the race every time. Which means it fired on somebody's FIRST create.
    """
    import subprocess as sp

    from houston.services import k8s

    calls: list[int] = []

    def flaky(context, namespace, script):
        calls.append(1)
        if len(calls) < 3:
            return sp.CompletedProcess([], 1, "", "MongoNetworkError: connect "
                                       "ECONNREFUSED 127.0.0.1:27017")
        return sp.CompletedProcess([], 0, "1", "")

    monkeypatch.setattr(k8s.replicaset, "_mongo_exec_once", flaky)
    res = k8s._mongo_exec("c", "ns", "rs.status().ok", sleep=lambda s: None)
    assert res.returncode == 0, "a cold mongod is a wait, not a dead create"
    assert len(calls) == 3, calls

    # A REAL error must still come straight back -- retrying an authentication
    # failure five times just makes the report slower and no more accurate.
    calls.clear()
    monkeypatch.setattr(k8s.replicaset, "_mongo_exec_once", lambda *a: sp.CompletedProcess(
        [], 1, "", "MongoServerError: Authentication failed"))
    res = k8s._mongo_exec("c", "ns", "rs.status().ok", sleep=lambda s: None)
    assert res.returncode == 1
    assert k8s._mongo_exec_once("c", "ns", "x").returncode == 1  # sanity

    # And the other transient it was originally written for still retries.
    calls.clear()
    seen: list[int] = []

    def terminating(context, namespace, script):
        seen.append(1)
        if len(seen) < 2:
            return sp.CompletedProcess([], 1, "", 'container not found ("mongod")')
        return sp.CompletedProcess([], 0, "1", "")

    monkeypatch.setattr(k8s.replicaset, "_mongo_exec_once", terminating)
    assert k8s._mongo_exec("c", "ns", "x", sleep=lambda s: None).returncode == 0
    assert len(seen) == 2


def test_a_persisted_removed_member_is_reconfigured_after_restart(monkeypatch):
    """A down/up cycle can leave MongoDB in REMOVED after its self-DNS raced startup.

    The PVC still contains an initialized set, so calling `rs.initiate()` again is
    not enough. Once the pod is running, force the existing one-member config and
    require a writable primary before Rocket.Chat is scaled up.
    """
    import subprocess as sp

    from houston.services import k8s

    hello_calls = 0
    scripts: list[str] = []

    def fake_exec(_context, _namespace, script):
        nonlocal hello_calls
        scripts.append(script)
        if "isWritablePrimary" in script:
            hello_calls += 1
            return sp.CompletedProcess([], 0, "true" if hello_calls > 6 else "false", "")
        if "reconfig" in script:
            return sp.CompletedProcess([], 0, "1", "")
        return sp.CompletedProcess([], 0, "", "already initialized")

    monkeypatch.setattr(k8s.replicaset, "_mongo_exec", fake_exec)
    seen: list[str] = []
    k8s.replicaset._finish_replica_set(
        "c", "ns", "already initialized",
        lambda event: seen.append(event.message), lambda _seconds: None)

    assert "rs.reconfig(rs.conf(), {force:true})" in scripts
    assert any("recovered after restart" in message for message in seen)
