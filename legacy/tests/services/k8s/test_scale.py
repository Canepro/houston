"""`houston.services.k8s.scale`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations


def test_start_restores_the_replica_count_stop_recorded(monkeypatch):
    """`--replicas 2` came back as 1 after stop/start, silently.

    `stop` records the counts in a namespace annotation for exactly this, and `start`
    read it back through jsonpath -- escaping the SLASH in
    `houston.io/replicas-before-stop` while leaving the DOT in `houston.io`
    unescaped. jsonpath then read `houston` and `io/...` as separate path segments,
    matched nothing and returned empty, so every restore fell through to the default
    of 1. Measured on a live cluster: the slash-escaped form returns "" where the
    dot-escaped form returns the annotation.

    The annotation written to prevent this was therefore never once read back, and
    nothing said so -- the workspace simply had half the Rocket.Chat it was asked for.
    Found by running microservices with two replicas, which is the only shape where
    the default and the truth differ.

    Read as JSON and picked in Python now: a rule with no escaping in it cannot be
    got subtly wrong.
    """
    import json as _json

    from houston.services import k8s

    recorded = {"deployment/rocketchat-rocketchat": "2",
                "deployment/rocketchat-presence": "1"}
    scaled: list[str] = []

    def fake_run(argv, **kw):
        import subprocess as sp
        joined = " ".join(argv)
        if "get" in argv and "namespace" in argv and "json" in joined:
            return sp.CompletedProcess(argv, 0, _json.dumps(
                {"metadata": {"annotations": {k8s.SCALE_ANNOTATION:
                                              _json.dumps(recorded)}}}), "")
        if "scale" in argv:
            scaled.append(next(a for a in argv if a.startswith("--replicas="))
                          + " " + argv[-1])
        return sp.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(k8s.kube, "run", fake_run)
    monkeypatch.setattr(k8s.replicaset, "init_replica_set", lambda **_kw: None)
    monkeypatch.setattr(k8s.scale, "_scalables",
                        lambda ns, ctx: ["deployment/rocketchat-rocketchat",
                                         "deployment/rocketchat-presence"])
    k8s.start_workspace("w", context="c")
    assert "--replicas=2 deployment/rocketchat-rocketchat" in scaled, scaled
    assert "--replicas=1 deployment/rocketchat-presence" in scaled, scaled

    # A workspace stopped by hand carries no annotation; 1 is what `up` would give.
    def no_annotation(argv, **kw):
        import subprocess as sp
        if "get" in argv and "namespace" in argv:
            return sp.CompletedProcess(argv, 0, '{"metadata":{}}', "")
        if "scale" in argv:
            scaled.append(next(a for a in argv if a.startswith("--replicas="))
                          + " " + argv[-1])
        return sp.CompletedProcess(argv, 0, "", "")
    scaled.clear()
    monkeypatch.setattr(k8s.kube, "run", no_annotation)
    k8s.start_workspace("w", context="c")
    assert all(x.startswith("--replicas=1") for x in scaled), scaled


def test_start_repairs_plain_mongo_before_scaling_rocketchat(monkeypatch):
    """Starting all workloads together lets MongoDB lose its self-DNS race.

    The database must become a writable primary before Rocket.Chat deployments are
    scaled up; otherwise they crash-loop against a persisted REMOVED member.
    """
    import subprocess
    import json

    from houston.services import k8s

    events: list[str] = []

    def fake_run(argv, **_kw):
        if "namespace" in argv and "json" in argv:
            return subprocess.CompletedProcess(argv, 0, json.dumps({"metadata": {}}), "")
        if "deployment,statefulset" in argv:
            return subprocess.CompletedProcess(
                argv, 0, "statefulset.apps/mongodb\ndeployment.apps/rocketchat-rocketchat\n", "")
        if "mongodbcommunity" in argv:
            return subprocess.CompletedProcess(argv, 1, "", "NotFound")
        if "scale" in argv:
            events.append("scale:" + argv[-1])
        return subprocess.CompletedProcess(argv, 0, "1", "")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    monkeypatch.setattr(k8s.replicaset, "init_replica_set",
                        lambda **_kw: events.append("replica-ready"))

    k8s.start_workspace("w", context="c")

    assert events == ["scale:statefulset.apps/mongodb", "replica-ready",
                      "scale:deployment.apps/rocketchat-rocketchat"], events


def _a_workspace_whose_mongodb_the_operator_owns(monkeypatch):
    """A workspace whose database is the shared operator's, not this workspace's to stop."""
    from houston.services import k8s
    from houston.services.events import Event

    def cluster(*, operator: bool, pods: list[str]):
        """Stub kubectl for the handful of calls stop_workspace makes."""
        def run(argv, timeout=None, own=False, env=None, input=None):
            import subprocess as sp
            joined = " ".join(argv)
            if "mongodbcommunity" in joined:
                out = "mongodbcommunity.mongodbcommunity.mongodb.com/mongodb" \
                    if operator else ""
                return sp.CompletedProcess(argv, 0 if operator else 1, out, "")
            if "get pods" in joined or ("pods" in argv and "get" in argv):
                if "-l" in argv:                       # the mongo-only selector
                    keep = [p for p in pods if "mongodb" in p]
                    return sp.CompletedProcess(argv, 0, " ".join(keep), "")
                return sp.CompletedProcess(argv, 0, " ".join(pods), "")
            if "jsonpath={.spec.replicas}" in joined:
                return sp.CompletedProcess(argv, 0, "1", "")
            return sp.CompletedProcess(argv, 0, "", "")
        return run

    # --- the operator path: mongo is expected to survive ------------------
    monkeypatch.setattr(k8s.kube, "run", cluster(operator=True, pods=["pod/mongodb-0"]))
    monkeypatch.setattr(k8s.scale, "scale_workspace", lambda *a, **kw: 1)
    return Event, cluster, k8s


def test_stop_says_so_when_the_operator_keeps_mongodb_running(monkeypatch):
    """An operator-managed MongoDB cannot be scaled to zero.

    The operator reconciles its StatefulSet straight back, and the Community operator
    has no way to pause reconciliation (checked upstream, not assumed). Two faults
    followed from not knowing that, and an audit of the operator path found both:

      * `stop` documents itself as giving the memory back. It gave back Rocket.Chat's
        and not MongoDB's, and said nothing -- so someone who ran `stop` to free the
        box was told it had worked.
      * The wait-for-pods-gone loop required EVERY pod to disappear, so every stop and
        every restart on this path burned the full POD_GONE_TRIES budget waiting for a
        pod that was never going to leave, then carried on regardless.

    The hand-written StatefulSet path is untouched: it scales to zero like anything
    else, and must not start paying for this.
    """
    Event, cluster, k8s = _a_workspace_whose_mongodb_the_operator_owns(monkeypatch)
    assert k8s.mongo_pods_the_operator_keeps("w", context="c") == {"pod/mongodb-0"}

    slept: list[float] = []
    seen: list[Event] = []
    k8s.stop_workspace("w", context="c", emit=seen.append, sleep=slept.append)
    assert not slept, (
        "it waited for a pod the operator will never remove; on the operator path "
        "every stop and restart paid the full timeout for nothing")
    text = " ".join(e.message for e in seen if e.level == "warn")
    assert "MongoDB stays up" in text, "stop must not claim memory it did not free"
    assert "--volumes" in text, "and must name what actually reclaims it"

    # --- the StatefulSet path: nothing survives, nothing is claimed --------
    monkeypatch.setattr(k8s.kube, "run", cluster(operator=False, pods=[]))
    assert k8s.mongo_pods_the_operator_keeps("w", context="c") == set()
    seen.clear()
    k8s.stop_workspace("w", context="c", emit=seen.append, sleep=slept.append)
    assert not [e for e in seen if e.level == "warn"], \
        "the hand-written StatefulSet does scale to zero; do not warn about it"


def test_a_stopped_kubernetes_workspace_remembers_what_to_scale_back_to(monkeypatch):
    """Kubernetes has no "stopped" state -- 0 replicas IS the mechanism -- so the
    number that was there has to be written down or `start` cannot restore it.

    Recorded BEFORE scaling, or the value read back is the zero just written. Stored
    on the namespace rather than in repro.json because scaling by hand is a
    legitimate thing to do and the cluster should carry its own truth -- and a
    workspace stopped by hand carries no annotation at all, which is why the
    fallback is 1 rather than a refusal.
    """
    from houston.services import k8s

    scaled, annotated = [], []

    def fake_run(argv, **kw):
        import subprocess
        if "get" in argv and "deployment,statefulset" in argv:
            out = "deployment.apps/rocketchat-rocketchat\nstatefulset.apps/mongodb\n"
        elif "annotate" in argv:
            annotated.append(argv)
            out = ""
        elif "get" in argv and any(a.startswith("jsonpath={.spec.replicas}")
                                   for a in argv):
            out = "2"
        elif "scale" in argv:
            scaled.append(argv)
            out = ""
        else:
            out = ""
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    k8s.stop_workspace("w", context=k8s.CONTEXT)

    payload = [a for a in annotated[0] if a.startswith(k8s.SCALE_ANNOTATION)][0]
    assert '"deployment.apps/rocketchat-rocketchat": "2"' in payload, payload
    assert "statefulset.apps/mongodb" in payload, \
        "MongoDB scales too -- a workspace holding its database resident is not stopped"
    assert any("--replicas=0" in a for argv in scaled for a in argv), scaled
