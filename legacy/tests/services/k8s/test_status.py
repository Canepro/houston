"""`houston.services.k8s.status`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from conftest import source_of
from houston import errors
from houston.services import lifecycle as lc
from servicehelpers import _completed
import json
import pytest


def _a_pod_logging_the_way_rocketchat_does(monkeypatch):
    """Log lines with Rocket.Chat's own prefixes, which a second prefix would mangle."""
    from houston.services import k8s

    seen = {}

    def fake_popen(argv, **kw):
        seen["argv"] = argv
        class _P:
            stdout = None
            def terminate(self): pass
            def wait(self, timeout=None): return 0
        return _P()
    monkeypatch.setattr(k8s.subprocess, "popen", fake_popen)

    def with_pods(n):
        import subprocess as sp
        monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: sp.CompletedProcess(
            argv, 0, "\n".join(f"pod/rc-{i}" for i in range(n)), ""))
        k8s.log_process("w", context="c", tail=25, follow=True)
        return seen["argv"]

    single = with_pods(1)
    return k8s, seen, single, with_pods


def test_kubernetes_logs_do_not_mangle_rocketchats_own_formatting(monkeypatch):
    """Rocket.Chat pretty-prints its logs; the reader came for THAT.

    `--prefix` was passed unconditionally, so every line arrived stamped with
    "[pod/rocketchat-rocketchat-<hash>/rocketchat] " and the columns Rocket.Chat
    lays out were pushed off the left of the screen -- destroying exactly the
    formatting somebody opened the logs to read. Reported from real use.

    With one pod the prefix names the only thing it could be, so it is pure noise.
    With several it is the only way to tell replicas apart, so it comes back.
    """
    k8s, seen, single, with_pods = _a_pod_logging_the_way_rocketchat_does(monkeypatch)
    assert "--prefix" not in single, \
        "one pod: the prefix identifies the only candidate and costs the formatting"
    assert "-c" not in single, (
        "the selected pods have DIFFERENT container names -- rocketchat, "
        "ddp-streamer, presence -- so naming one would fail on the others")
    assert "-f" in single and "--tail" in single

    # THE SELECTOR IS THE POINT ON MICROSERVICES. It was the monolith deployment
    # alone, so ddp-streamer -- which carries the WebSocket -- produced no output at
    # all, and a realtime problem gave logs with nothing about realtime in them.
    sel = single[single.index("-l") + 1]
    assert f"app.kubernetes.io/instance={k8s.RELEASE}" in sel, \
        "the whole release, so a microservice the chart adds later is included too"
    assert "app.kubernetes.io/name!=nats" in sel, \
        "but not the message bus, which would drown Rocket.Chat's own lines"
    # And the narrow questions still ask the narrow one.
    assert k8s.APP_SELECTOR == "app.kubernetes.io/name=rocketchat", \
        "env means Rocket.Chat itself, not whichever pod sorted first"
    import inspect
    assert "LOG_SELECTOR" in inspect.signature(k8s.pod_metrics).parameters["selector"].default \
        or k8s.LOG_SELECTOR == inspect.signature(k8s.pod_metrics).parameters["selector"].default, \
        "stats sums every application pod, as Compose sums every rocketchat service"

    many = with_pods(3)
    assert "--prefix" in many, "several replicas are indistinguishable without it"

    # A failed pod count must not decide the shape either way -- it falls back to
    # the quiet form rather than guessing there are many.
    import subprocess as sp
    monkeypatch.setattr(k8s.kube, "run",
                        lambda argv, **kw: sp.CompletedProcess(argv, 1, "", "boom"))
    k8s.log_process("w", context="c", tail=5, follow=False)
    assert "--prefix" not in seen["argv"] and "-f" not in seen["argv"]


def _a_running_kubernetes_workspace(monkeypatch, tmp_path):
    """A workspace whose pod is up and answering, on the runtime that used to refuse."""
    import json as _json
    from dataclasses import asdict

    from houston import errors as errs
    from houston.services import envvars, k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="p", rc_version="8.5.1", rc_image="i",
                           mongo_tag="8.0", mongo_flavor="official", preset="default",
                           root_url="u", host_port=3000, version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT
    m.extra["env"] = {"MY_OVERRIDE": "set-by-me"}
    ws = lc.runner.workspace("k")
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "repro.json").write_text(_json.dumps(asdict(m)), encoding="utf-8")

    # --- env: read from the container, credentials masked -------------------
    monkeypatch.setattr(k8s.status, "container_env", lambda name, *, context: {
        "ADMIN_PASS": "admin123", "MONGO_URL": "mongodb://mongodb:27017/rocketchat",
        "MY_OVERRIDE": "set-by-me", "ROOT_URL": "http://localhost:3000"})
    out = envvars.current("k")
    keys = {row["key"]: row for row in out["env"]}
    return errs, k8s, keys


def test_env_and_stats_answer_on_kubernetes_instead_of_refusing(
        monkeypatch, tmp_path):
    """The last two commands that had no Kubernetes path now have one.

    `env` is answered from the RUNNING CONTAINER rather than a document. That is not
    a translation of the Compose behaviour, it is better than it: the chart
    contributes variables houston never set, so the generated values would not show
    them and the compose file has no equivalent here at all.

    `stats` needs metrics-server, which kind does not ship. When it is missing the
    refusal says so and how to install it -- a resource figure that is quietly zero
    is worse than one that is missing, which is the same reasoning `stats` already
    applies to a container it cannot find.
    """
    errs, k8s, keys = _a_running_kubernetes_workspace(monkeypatch, tmp_path)
    assert set(keys) == {"ADMIN_PASS", "MONGO_URL", "MY_OVERRIDE", "ROOT_URL"}
    assert keys["MY_OVERRIDE"]["override"] is True, "a user override is marked as one"
    assert keys["ROOT_URL"]["override"] is False
    assert keys["ADMIN_PASS"]["value"] != "admin123", \
        "credentials are masked here exactly as they are on Compose"

    # --- stats: real numbers, parsed from `kubectl top` output --------------
    import subprocess as sp

    def top(argv, **kw):
        if "top" in argv:
            return sp.CompletedProcess(
                argv, 0, "rocketchat-a   120m   500Mi\nrocketchat-b   80m   300Mi\n", "")
        return sp.CompletedProcess(argv, 0, "", "")
    monkeypatch.setattr(k8s.kube, "run", top)
    rows = k8s.pod_metrics("k", context="c")
    assert sum(r["cpu_millicores"] for r in rows) == 200.0, "replicas are summed"
    assert rows[0]["mem_bytes"] == 500 * 1024 ** 2, "Mi is binary, not 1e6"

    # --- and a refusal that names the fix when metrics-server is absent ------
    def no_metrics(argv, **kw):
        return sp.CompletedProcess(argv, 1, "", "error: Metrics API not available")
    monkeypatch.setattr(k8s.kube, "run", no_metrics)
    with pytest.raises(errs.NotReadyError) as caught:
        k8s.pod_metrics("k", context="c")
    assert "metrics-server" in str(caught.value)
    assert "kubectl apply" in str(caught.value), "say how to install it"


def test_a_downed_workspace_is_down_not_perpetually_starting(monkeypatch, tmp_path):
    """A plain `down` keeps the namespace and its PVC on purpose and uninstalls the
    release. Asking only whether the namespace exists reported such a workspace as
    "starting" -- and it would have said so forever, because nothing was coming.

    Seen on a real box: `houston list` showed `starting` for a workspace the user
    had just torn down.
    """
    from houston.services import k8s, topology

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    m = lc.runner.Metadata(name="k", project="houston-k", rc_version="8.5.1",
                           rc_image="i", mongo_tag="8.0", mongo_flavor="official",
                           preset="default", root_url="u", host_port=3000,
                           version_source="t")
    topology.stamp(m.extra, topology.KUBERNETES)
    m.extra["context"] = k8s.CONTEXT

    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda *a, **kw: ["houston-k"])
    # Namespace kept, release gone -- exactly what `down` leaves behind.
    monkeypatch.setattr(k8s.status, "workload_exists", lambda *a, **kw: False)
    assert lc.kubernetes_state("k", m) == "down"

    # Workload back but not serving yet.
    monkeypatch.setattr(k8s.status, "workload_exists", lambda *a, **kw: True)
    monkeypatch.setattr(k8s.status, "workspace_ready", lambda *a, **kw: False)
    assert lc.kubernetes_state("k", m) == "starting"
    monkeypatch.setattr(k8s.status, "workspace_ready", lambda *a, **kw: True)
    assert lc.kubernetes_state("k", m) == "running"

    # And no namespace at all is still down.
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda *a, **kw: [])
    assert lc.kubernetes_state("k", m) == "down"


def _a_service_with_no_ready_pod_behind_it(monkeypatch):
    """A Service that exists and routes to nothing, which reads as healthy from outside."""
    from houston.services import k8s

    slices = {"items": [
        {"metadata": {"labels": {"kubernetes.io/service-name": "rocketchat-rocketchat"}},
         "endpoints": [{"conditions": {"ready": False}}]},
        {"metadata": {"labels": {"kubernetes.io/service-name": "rocketchat-ddp-streamer"}},
         "endpoints": [{"conditions": {"ready": True}}]},
    ]}
    # THE SHAPES ARE COPIED FROM A LIVE MICROSERVICES WORKSPACE, and that matters:
    # the first version of this test put `app.kubernetes.io/instance` in each
    # Service's LABELS, matching the first version of the code -- and the chart does
    # not do that. `rocketchat-ddp-streamer` carries only
    # `app.kubernetes.io/managed-by: Helm` as a label and names the instance in its
    # SELECTOR. So code and test agreed with each other and neither agreed with
    # Kubernetes, and the check was a silent no-op that this test passed. Verified by
    # dumping every Service on a real workspace.
    inst = "app.kubernetes.io/instance"
    svcs = {"items": [
        # Rocket.Chat's own, selector-backed: judged.
        {"metadata": {"name": "rocketchat-rocketchat",
                      "labels": {"app.kubernetes.io/managed-by": "Helm"}},
         "spec": {"selector": {inst: k8s.RELEASE, "app.kubernetes.io/name": "rocketchat"},
                  "type": "ClusterIP"}},
        {"metadata": {"name": "rocketchat-ddp-streamer",
                      "labels": {"app.kubernetes.io/managed-by": "Helm"}},
         "spec": {"selector": {inst: k8s.RELEASE,
                               "app.kubernetes.io/name": "rocketchat-ddp-streamer"},
                  "type": "ClusterIP"}},
        # Our own hand-rolled MongoDB: its selector names no instance, so it is
        # excluded without being named -- it has its own lifecycle and its own
        # reasons to be briefly empty.
        {"metadata": {"name": "mongodb",
                      "labels": {"houston.io/workspace": "w"}},
         "spec": {"selector": {"app": "mongodb"}, "type": "ClusterIP"}},
        # No selector: wired by hand, so there are no pods to be missing.
        {"metadata": {"name": "rocketchat-manual", "labels": {}},
         "spec": {"type": "ClusterIP"}},
        # ExternalName has no endpoints by definition.
        {"metadata": {"name": "rocketchat-alias", "labels": {}},
         "spec": {"selector": {inst: k8s.RELEASE}, "type": "ExternalName"}},
    ]}

    def answer(argv, **kw):
        if "endpointslices" in argv:
            return _completed(0, out=json.dumps(slices))
        if "svc" in argv:
            return _completed(0, out=json.dumps(svcs))
        return _completed(0, out="{}")

    monkeypatch.setattr(k8s.kube, "run", answer)
    return k8s


def test_a_service_with_no_ready_pod_behind_it_is_reported(monkeypatch):
    """A Service whose selector matches nothing looked exactly like a healthy
    workspace.

    Readiness reads POD status and the port-forward targets the DEPLOYMENT, so nothing
    on either path ever traverses the Service -- the URL answers 200 from the host
    while every pod in the cluster gets nothing. That matters more than it sounds
    because the Kubernetes default deployment is microservices, where in-cluster
    Service traffic is what carries the product, so a working port-forward is weaker
    evidence than it looks.

    Reported and not gated: endpoints churn during a rollout, so a transient empty set
    is normal, and a false negative here would block a boot -- a worse failure than
    the one being found. Every doubt therefore returns "nothing to say".
    """
    k8s = _a_service_with_no_ready_pod_behind_it(monkeypatch)
    assert k8s.services_without_endpoints("w", context="c") == \
        ["rocketchat-rocketchat"], k8s.services_without_endpoints("w", context="c")

    # A refused read says nothing rather than accusing every Service in the namespace
    # -- the same rule as everywhere else in this module.
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: _completed(
        1, err="Error from server (Forbidden): cannot list endpointslices"))
    assert k8s.services_without_endpoints("w", context="c") == []
    assert k8s.service_ready_addresses("ns", context="c") is None

    # And it reads EndpointSlice, not the API kubectl warns about on every call.
    src = source_of(k8s.service_ready_addresses)
    assert "endpointslices" in src
    assert '"endpoints", ' not in src, "the deprecated v1 Endpoints API is back"

    # The filter reads the SELECTOR. Asserted directly because getting this wrong is
    # invisible: it makes the function return [] for everything, which looks exactly
    # like a healthy workspace and is what shipped in the first attempt.
    pick = source_of(k8s.services_without_endpoints)
    assert 'spec.get("selector") or {}).get(' in pick, \
        "the instance is matched on the selector, not on the Service's labels"


def test_a_wedged_workspace_is_not_reported_as_starting_for_ever(monkeypatch):
    """K-09. Everything not ready read as `starting`, which promises that something
    is coming. For a pod in ImagePullBackOff or a `pending-install` release nothing
    is, and both facts were already available -- `terminal_pod_failure` named the pod,
    the reason and the message while `list` printed "starting" beside it.
    """
    import types

    from houston.services import k8s

    meta = types.SimpleNamespace(extra={"context": "c"})
    monkeypatch.setattr(k8s.capabilities, "workspace_namespaces", lambda ctx=None: ["houston-k"])
    monkeypatch.setattr(k8s.status, "workload_exists", lambda n, **kw: True)
    monkeypatch.setattr(k8s.scale, "desired_replicas", lambda n, **kw: 1)
    monkeypatch.setattr(k8s.status, "workspace_ready", lambda n, **kw: False)
    monkeypatch.setattr(k8s.release, "release_state", lambda *a, **kw: ("deployed", 1))

    monkeypatch.setattr(k8s.status, "terminal_pod_failure", lambda n, **kw: None)
    assert lc.kubernetes_state("k", meta) == "starting"

    monkeypatch.setattr(k8s.status, "terminal_pod_failure",
                        lambda n, **kw: ("mongodb-0", "ImagePullBackOff", "no such host"))
    assert lc.kubernetes_state("k", meta) == "failed"

    monkeypatch.setattr(k8s.status, "terminal_pod_failure", lambda n, **kw: None)
    monkeypatch.setattr(k8s.release, "release_state", lambda *a, **kw: ("pending-install", 1))
    assert lc.kubernetes_state("k", meta) == "failed"

    # A REFUSED probe must not manufacture a failure: still `starting`.
    def boom(*a, **kw):
        raise errors.DockerError("could not ask")
    monkeypatch.setattr(k8s.status, "terminal_pod_failure", boom)
    monkeypatch.setattr(k8s.release, "release_state", boom)
    assert lc.kubernetes_state("k", meta) == "starting"
