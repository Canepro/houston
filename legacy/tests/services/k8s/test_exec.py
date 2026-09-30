"""`houston.services.k8s.exec`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
from houston import errors
from servicehelpers import _completed, _fake_run, _helm_list
import pytest


def test_houston_never_rewrites_the_users_kubeconfig(monkeypatch, tmp_path):
    """The one way creating a cluster genuinely disturbs existing work.

    `kind create cluster` writes ~/.kube/config AND switches current-context to the
    cluster it just made. Without isolation, somebody working in their own cluster
    runs `houston up` and their next `kubectl get pods` answers from somewhere
    else -- with no indication anything moved.

    So anything touching houston's OWN cluster runs with KUBECONFIG and all five
    Helm homes pointed inside HOUSTON_HOME. Adopted from PR #3.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    env = k8s.owned_env()
    assert env["KUBECONFIG"].startswith(str(tmp_path)), env["KUBECONFIG"]
    for var in ("HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME",
                "HELM_REPOSITORY_CONFIG", "HELM_REPOSITORY_CACHE"):
        assert env[var].startswith(str(tmp_path)), f"{var} escapes to the user's home"
    # Pinning only repositories.yaml would still leave cache and data writes in
    # ~/.config/helm, which is why all of them move.
    assert k8s.owned_kubeconfig().parent.is_dir()


def test_the_chart_repo_and_the_install_share_one_helm_home(monkeypatch, tmp_path):
    """`owned_env` set the kubeconfig AND every HELM_* variable together, and that
    conflation broke `up --runtime kubernetes` on a cluster houston ADOPTED. The chart
    repo went into houston's Helm home (`ensure_repo`, `own=True`) while the install that
    needed it read the user's (`is_ours(context)` is False on an adopted cluster). Two
    different repositories.yaml, so the create failed at 60% -- after the namespace, the
    operator and MongoDB had all been built -- with

        helm install failed: Error: repo rocketchat not found

    and then rolled the namespace back. Reproduced against a live k3s cluster with the
    user's Helm home moved aside: the pre-fix environment gives exactly that error and
    `helm_env` gives rc 0.

    The MongoDB operator path worked only because BOTH its halves used the user's home --
    consistent, and also wrong, because it wrote repositories into the home `owned_env`
    exists to keep houston out of."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.delenv("KUBECONFIG", raising=False)

    owned = k8s.owned_env()                       # what ensure_repo uses
    adopted = k8s.helm_env("default")             # a cluster we did not create
    ours = k8s.helm_env(k8s.CONTEXT)              # our own kind cluster

    key = "HELM_REPOSITORY_CONFIG"
    assert owned[key] == adopted[key] == ours[key], (
        "the repo and the install must read one repositories.yaml, whoever owns the "
        "cluster")
    for var in ("HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME",
                "HELM_REPOSITORY_CACHE"):
        assert adopted[var] == owned[var], f"{var} escaped to the user's home"
        assert str(tmp_path) in adopted[var], f"{var} is not under HOUSTON_HOME"

    # The kubeconfig is the half that MUST differ: ours for our cluster, the user's for
    # one we adopted -- which is what `owned_env` got right and could not express alone.
    assert "KUBECONFIG" not in adopted, "an adopted cluster must use the user's kubeconfig"
    assert ours["KUBECONFIG"] == str(k8s.owned_kubeconfig())

    # And an explicitly-set KUBECONFIG is preserved rather than deleted.
    monkeypatch.setenv("KUBECONFIG", "/tmp/theirs.yaml")
    assert k8s.helm_env("default")["KUBECONFIG"] == "/tmp/theirs.yaml"
    assert k8s.helm_env(k8s.CONTEXT)["KUBECONFIG"] == str(k8s.owned_kubeconfig())


def test_which_kubeconfig_houston_reads_does_not_depend_on_which_kubectl_is_installed(
        monkeypatch, tmp_path):
    """Found live, and it was the worst possible failure text.

    `kubectl` on the box was a symlink to k3s, whose embedded client reads
    `/etc/rancher/k3s/k3s.yaml` when KUBECONFIG is unset. `aws eks update-kubeconfig`
    had just written the cluster into `~/.kube/config` — the standard path — so the two
    files never met, and `--context <the arn>` was refused with a message telling the
    operator to run the exact command they had just run. The context existed, was
    correct, and was invisible.
    """
    from houston.services import k8s

    home = tmp_path / "home"
    (home / ".kube").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("KUBECONFIG", raising=False)

    # No ~/.kube/config yet: leave kubectl's own default alone rather than pointing it
    # at a file that does not exist, which would take away whatever default it has.
    assert k8s.user_env() is None

    (home / ".kube" / "config").write_text("apiVersion: v1\n")
    env = k8s.user_env()
    assert env is not None and env["KUBECONFIG"] == str(home / ".kube" / "config"), \
        "the standard path must be named explicitly, not left to the binary"

    # An operator who SET it has said which files they mean. Obeyed untouched.
    monkeypatch.setenv("KUBECONFIG", "/somewhere/else.yaml")
    assert k8s.user_env() is None

    # And it is only for clusters houston does NOT own: its own kubeconfig still wins.
    monkeypatch.delenv("KUBECONFIG", raising=False)
    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path / "rc"))
    assert k8s.owned_env()["KUBECONFIG"] != str(home / ".kube" / "config")


def _a_workspace_whose_pods_answer_differently(monkeypatch):
    """Several pods, only some of them ready, which is the case the first-pod read hid."""
    import json as _json

    from houston.services import k8s

    def pods(*specs):
        """specs: (name, [ready flags]) -- no flags means Pending, no statuses."""
        items = []
        for pod_name, flags in specs:
            status = {"phase": "Pending" if flags is None else "Running"}
            if flags is not None:
                status["containerStatuses"] = [{"ready": f} for f in flags]
            items.append({"metadata": {"name": pod_name}, "status": status})
        return (0, _json.dumps({"items": items}))

    seen: list[list[str]] = []

    def stub(result):
        """Answer whichever output form the caller asked for.

        Deliberately format-aware, so this test is a real differential: the version
        being replaced asked for `-o jsonpath={.items[0]...ready}` and the new one
        asks for `-o json`. A stub that only spoke JSON would fail against the old
        code for the wrong reason -- output it could not parse -- and would prove
        nothing about the over-claiming this test is here to pin.
        """
        def run(argv, timeout=None, own=False, env=None, input=None):
            import subprocess as sp
            seen.append(argv)
            rc, payload = result
            if rc != 0:
                return sp.CompletedProcess(argv, rc, "", "")
            joined = " ".join(argv)
            if "jsonpath" in joined:
                items = _json.loads(payload).get("items") or []
                first = ((items[0].get("status", {}).get("containerStatuses") or [{}])[0]
                         if items else {})
                got = first.get("ready")
                return sp.CompletedProcess(
                    argv, 0, "" if got is None else str(got).lower(), "")
            return sp.CompletedProcess(argv, 0, payload, "")
        return run

    # One ready pod -- the monolith case, still true.
    monkeypatch.setattr(k8s.kube, "run", stub(pods(("rc-0", [True]))))
    return k8s, pods, seen, stub


def test_ready_speaks_for_every_probed_pod_not_just_the_first(monkeypatch):
    """`ready` used to read items[0].containerStatuses[0], which over-claimed twice.

    Found by an operational audit of a live microservices workspace:

      * With --replicas N it inspected ONE pod, so the workspace was declared ready
        on the strength of the first.
      * It only ever looked at the monolith container. `ddp-streamer` carries the
        WebSocket -- the realtime half of Rocket.Chat -- and was seen
        Running-but-not-Ready on a workspace `ready` had already called serving. A
        caller told "ready" could open the URL and find messages not arriving, which
        is the failure this tool exists to REPRODUCE, not to cause.

    account/authorization/presence are excluded on purpose: the chart ships them with
    no readinessProbe, so their pod-Ready flips as soon as the container starts and
    attests nothing. Waiting on it would cost time and buy no confidence.
    """
    k8s, pods, seen, stub = _a_workspace_whose_pods_answer_differently(monkeypatch)
    assert k8s.workspace_ready("w", context="c") is True

    # The selector must name both probed workloads and NEITHER unprobed one.
    argv = seen[-1]
    sel = argv[argv.index("-l") + 1]
    assert "rocketchat" in sel and "rocketchat-ddp-streamer" in sel, sel
    for unprobed in ("account", "authorization", "presence"):
        assert f"rocketchat-{unprobed}" not in sel, \
            f"{unprobed} has no readinessProbe, so waiting on it proves nothing"

    # THE items[0] BUG: three replicas, the third not ready.
    monkeypatch.setattr(k8s.kube, "run", stub(
        pods(("rc-0", [True]), ("rc-1", [True]), ("rc-2", [False]))))
    assert k8s.workspace_ready("w", context="c") is False, \
        "a not-ready replica must not be hidden behind a ready first pod"

    # THE MICROSERVICES BUG: Rocket.Chat ready, ddp-streamer not.
    monkeypatch.setattr(k8s.kube, "run", stub(
        pods(("rc-0", [True]), ("rc-ddp-streamer-0", [False]))))
    assert k8s.workspace_ready("w", context="c") is False, \
        "realtime is not serving, so the workspace is not ready"

    # A Pending pod has NO containerStatuses; "nothing failed" is not "ready".
    monkeypatch.setattr(k8s.kube, "run", stub(pods(("rc-0", [True]), ("rc-ddp-0", None))))
    assert k8s.workspace_ready("w", context="c") is False

    # No pods at all is not ready either -- that is a torn-down workspace.
    monkeypatch.setattr(k8s.kube, "run", stub(pods()))
    assert k8s.workspace_ready("w", context="c") is False

    # A sidecar that is not ready counts, even when the app container is.
    monkeypatch.setattr(k8s.kube, "run", stub(pods(("rc-0", [True, False]))))
    assert k8s.workspace_ready("w", context="c") is False

    # kubectl failing is not readiness.
    monkeypatch.setattr(k8s.kube, "run", stub((1, "")))
    assert k8s.workspace_ready("w", context="c") is False


def test_a_missing_binary_never_raises_out_of_the_seam():
    """`doctor` is the command someone runs BECAUSE things are wrong. If the seam
    raised on a missing binary, every call site would need a wrapper and one
    forgotten wrapper takes down the whole report."""
    from houston.services import k8s

    res = k8s.run(["definitely-not-a-real-binary-xyz", "version"])
    assert res.returncode != 0
    assert res.stdout == ""


def test_a_create_that_lost_a_race_is_success_not_failure(monkeypatch, tmp_path):
    """Somebody ran `kind create cluster --name houston-local` by hand while we
    held the lock. "already exist" means the thing we wanted is true."""
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        if "current-context" in j:
            return sp.CompletedProcess(argv, 0, k8s.CONTEXT, "")
        if "/readyz" in j:
            return sp.CompletedProcess(argv, 0, "ok", "")
        if "create" in argv:
            return sp.CompletedProcess(argv, 1, "", "node(s) already exist for a "
                                                     "cluster with the name")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    assert k8s.ensure_cluster() == k8s.CONTEXT

    # A create that fails for any OTHER reason is terminal, and says why.
    def broken(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        j = " ".join(argv)
        if "get clusters" in j:
            return sp.CompletedProcess(argv, 0, "", "")
        if "create" in argv:
            return sp.CompletedProcess(argv, 1, "", "ERROR: failed to pull image")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", broken)
    with pytest.raises(errors.CreateFailedError) as caught:
        k8s.ensure_cluster()
    assert "failed to pull image" in str(caught.value), "the reason must reach the user"
    assert caught.value.exit_code == 7, "known dead, not 'poll again'"


def test_the_replica_set_is_initiated_and_verified_not_assumed(monkeypatch, tmp_path):
    """`--replSet rs0` only puts mongod IN replica-set mode. Without rs.initiate()
    there is no primary, nothing can write, and Rocket.Chat waits forever -- which
    is what a real workspace did for 540 seconds, at 5 pods, with nothing in
    Rocket.Chat's logs naming MongoDB.

    The verification matters as much as the call: this is the step whose silent
    failure produces a workspace that looks created and can never become ready.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    scripts = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        j = " ".join(argv)
        if "jsonpath" in j:
            return sp.CompletedProcess(argv, 0, "true", "")
        if "--eval" in argv:
            script = argv[argv.index("--eval") + 1]
            scripts.append(script)
            out = "1" if script == "rs.status().ok" else ""
            return sp.CompletedProcess(argv, 0, out, "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                         sleep=lambda _s: None)
    assert any("rs.initiate" in s for s in scripts), scripts
    assert "rs.status().ok" in scripts, "it must verify, not trust the exit code"

    # A set that is already initiated is success, not failure.
    def already(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        j = " ".join(argv)
        if "jsonpath" in j:
            return sp.CompletedProcess(argv, 0, "true", "")
        if "--eval" in argv:
            script = argv[argv.index("--eval") + 1]
            if script == "rs.status().ok":
                return sp.CompletedProcess(argv, 0, "1", "")
            return sp.CompletedProcess(argv, 1, "", "already initialized")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", already)
    k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                         sleep=lambda _s: None)


def test_initiation_waits_for_a_running_pod_not_a_ready_one(monkeypatch, tmp_path):
    """A circular wait, and it made the whole create a coin flip.

    The readiness probe runs mongosh, which cannot complete its handshake against
    an UNINITIATED replica set -- mongod logs
    "ReadConcernMajorityNotAvailableYet". So readiness depends on initiation, and
    waiting for readiness before initiating means each waits for the other. The
    probe occasionally scraped through and the workspace built; otherwise it timed
    out at 300s reporting that MongoDB never became ready, while mongod had been
    up the whole time.

    So this polls `.status.phase`, and the probe itself connects with
    `directConnection=true` -- which `compose.py` already knew it had to.
    """
    from houston.services import k8s

    monkeypatch.setenv("HOUSTON_HOME", str(tmp_path))
    asked = []

    def spy(argv, timeout=None, own=False, env=None, input=None):
        import subprocess as sp
        joined = " ".join(argv)
        asked.append(joined)
        if "jsonpath" in joined:
            # `ready` is FALSE and stays false, exactly as an uninitiated set
            # behaves; `started` is what says the container is exec-able.
            if "].ready" in joined:
                return sp.CompletedProcess(argv, 0, "false", "")
            return sp.CompletedProcess(argv, 0, "true", "")
        if "--eval" in argv:
            script = argv[argv.index("--eval") + 1]
            return sp.CompletedProcess(argv, 0,
                                       "1" if script == "rs.status().ok" else "", "")
        return sp.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(k8s.kube, "run", spy)
    # Must succeed despite readiness never being true.
    k8s.init_replica_set(namespace="houston-t", context=k8s.CONTEXT,
                         sleep=lambda _s: None)
    assert not any("].ready" in a for a in asked), \
        "it waited on readiness, which cannot happen before initiation"
    assert any(".started" in a for a in asked), asked[:3]
    # And every mongosh call carries the direct URI.
    for call in [a for a in asked if "mongosh" in a]:
        assert "directConnection=true" in call, call


def test_exec_survives_a_terminating_pod_rather_than_failing_the_create(monkeypatch):
    """`containerStatuses[0].started` is still true for a TERMINATING pod, so a
    re-create can pass the wait and then exec into a pod on its way out:
    "unable to upgrade connection: container not found (mongod)". A one-shot exec
    turns that race into a failed create; retrying turns it into a delay."""
    from houston.services import k8s

    calls = []

    def flaky(argv, **kw):
        import subprocess as sp
        calls.append(1)
        if len(calls) < 3:
            return sp.CompletedProcess(argv, 1, "",
                                       'unable to upgrade connection: container '
                                       'not found ("mongod")')
        return sp.CompletedProcess(argv, 0, "1", "")

    monkeypatch.setattr(k8s.kube, "run", flaky)
    res = k8s._mongo_exec(k8s.CONTEXT, "houston-k", "rs.status().ok",
                          sleep=lambda _s: None)
    assert res.returncode == 0 and len(calls) == 3, calls

    # A different failure is NOT retried -- that would just delay a real error.
    calls.clear()
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: __import__("subprocess")
                        .CompletedProcess(argv, 1, "", "authentication failed"))
    out = k8s._mongo_exec(k8s.CONTEXT, "houston-k", "x", sleep=lambda _s: None)
    assert out.returncode == 1


def _a_pod_that_will_never_start(monkeypatch):
    """A pod whose container keeps failing, so waiting for it is waiting for nothing."""
    import json as _json

    from houston.services import k8s

    def pods(*states):
        return _json.dumps({"items": [
            {"metadata": {"name": p},
             "status": {"containerStatuses": [{"state": {"waiting": {
                 "reason": r, "message": m}}}]}}
            for p, r, m in states]})

    def cluster(payload, rc=0):
        def run(argv, **kw):
            import subprocess as sp
            return sp.CompletedProcess(argv, rc, payload, "")
        return run

    # An image that does not exist is decided; say so.
    monkeypatch.setattr(k8s.kube, "run", cluster(pods(
        ("rocketchat-abc", "ErrImagePull", 'manifest for rocket.chat:9.9.9 not found'))))
    found = k8s.terminal_pod_failure("w", context="c")
    return _json, cluster, found, k8s, pods


def test_a_create_stops_waiting_for_a_pod_that_cannot_start(monkeypatch):
    """A mistyped version cost the full timeout, then blamed the timeout.

    Kubernetes knows within seconds that an image does not exist; the readiness loop
    waited its whole 600s anyway and then reported "did not become ready", which names
    the symptom and not the cause. Taken from PR #3.

    The discrimination is the subtle part, and PR #3's note has it: `ImagePullBackOff`
    is a REASON, not a phase, and a pod that is merely pulling slowly from a
    rate-limited registry looks identical at the phase level. So the reason decides,
    and anything unrecognised keeps waiting -- the default has to be patience, or a
    slow pull becomes a failed create.
    """
    _json, cluster, found, k8s, pods = _a_pod_that_will_never_start(monkeypatch)
    assert found is not None
    pod, reason, message = found
    assert pod == "rocketchat-abc" and reason == "ErrImagePull"
    assert "9.9.9" in message, "carry the registry's own words, not a paraphrase"

    # A pod still starting is NOT terminal -- this is the false positive that would
    # turn every slow pull into a failed create.
    monkeypatch.setattr(k8s.kube, "run", cluster(pods(
        ("rocketchat-abc", "ContainerCreating", ""),
        ("mongodb-0", "PodInitializing", ""))))
    assert k8s.terminal_pod_failure("w", context="c") is None

    # Neither is a healthy pod with no waiting state at all.
    monkeypatch.setattr(k8s.kube, "run", cluster(
        _json.dumps({"items": [{"metadata": {"name": "rc"},
                                "status": {"containerStatuses": [
                                    {"state": {"running": {}}}]}}]})))
    assert k8s.terminal_pod_failure("w", context="c") is None

    # An unreadable cluster is not evidence of failure either.
    monkeypatch.setattr(k8s.kube, "run", cluster("", rc=1))
    assert k8s.terminal_pod_failure("w", context="c") is None
    monkeypatch.setattr(k8s.kube, "run", cluster("not json"))
    assert k8s.terminal_pod_failure("w", context="c") is None

    # An init container counts: MongoDB's fix-permission container runs there.
    monkeypatch.setattr(k8s.kube, "run", cluster(_json.dumps({"items": [
        {"metadata": {"name": "mongodb-0"},
         "status": {"initContainerStatuses": [{"state": {"waiting": {
             "reason": "CreateContainerConfigError", "message": "secret missing"}}}]}}]})))
    got = k8s.terminal_pod_failure("w", context="c")
    assert got and got[1] == "CreateContainerConfigError"


def test_ensure_ingress_adopts_before_it_installs(monkeypatch):
    """A cluster already running nginx must keep running nginx.

    The ingress controller is the component a support case is usually ABOUT, so
    installing Traefik over the top of somebody's nginx would reproduce the wrong
    thing in exactly the dimension that matters.
    """
    from houston.services import k8s

    ran: list[list[str]] = []
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: ran.append(argv))
    monkeypatch.setattr(k8s.capabilities, "ingress_classes", lambda ctx: ["nginx"])
    assert k8s.ensure_ingress(context="c", distribution="k3s") == "nginx"
    assert ran == [], "nothing may be installed over a controller that is already there"


def test_a_scenario_forward_waits_for_a_ready_endpoint(monkeypatch):
    """Binding a local socket is not the same as the backend answering.

    `kubectl port-forward svc/...` binds immediately and only then dials a pod, so a
    forward started while the workload is still booting passes a TCP check on the
    local side, fails upstream and exits. Keycloak takes about forty seconds to
    import its realm, and the live run showed exactly that: "keycloak published at
    http://localhost:8081", then connection refused a minute later.

    So the endpoint is waited for first. Third kind of forward, third time this
    lesson: the workspace URL needed the pod Running, Grafana needed the socket
    confirmed, and this needs a ready endpoint before either check means anything.
    """
    import subprocess

    from houston.services import k8s

    calls = []

    def fake_run(argv, **kw):
        calls.append(argv)
        if "svc" in argv and "get" in argv:
            return subprocess.CompletedProcess(argv, 0, stdout="kc 8081 8080\n", stderr="")
        if "endpoints" in argv:
            # Never ready -- the forward must NOT be started at all.
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(k8s.kube, "run", fake_run)
    monkeypatch.setattr(k8s.subprocess, "popen",
                        lambda *a, **kw: pytest.fail("forwarded before it was ready"))
    out = k8s.scenario_ui_forwards("w", namespace="houston-w", context=k8s.CONTEXT,
                                   sleep=lambda _s: None)
    assert out == {}, out
    assert sum("endpoints" in a for argv in calls for a in argv) >= 10, \
        "it must actually retry rather than check once"


def test_pod_rows_names_the_reason_a_pod_cannot_start(monkeypatch):
    """The status column's job. A pod stuck on a bad image reports phase `Pending`,
    which says only that something has not happened; the waiting REASON says what.

    An init container is where a Kubernetes workspace most often wedges -- MongoDB
    ships two -- and a pod whose init container is failing has an EMPTY
    containerStatuses, so reading only that list showed "0/0 ready" and named nothing.
    """
    import json as _json

    from houston.services import k8s

    pods = {"items": [
        {"metadata": {"name": "rocketchat-mongodb-0"},
         "status": {"phase": "Pending",
                    "initContainerStatuses": [
                        {"ready": False, "restartCount": 3,
                         "state": {"waiting": {"reason": "CrashLoopBackOff"}}}],
                    "containerStatuses": []}},
        {"metadata": {"name": "rocketchat-rocketchat-x"},
         "status": {"phase": "Running", "startTime": "2026-08-18T10:00:00Z",
                    "initContainerStatuses": [
                        {"ready": True, "restartCount": 0,
                         "state": {"terminated": {"reason": "Completed"}}}],
                    "containerStatuses": [{"ready": True, "restartCount": 0,
                                           "state": {"running": {}}}]}}]}
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **kw: type(
        "R", (), {"returncode": 0, "stdout": _json.dumps(pods), "stderr": ""})())
    rows = {r["service"]: r for r in k8s.pod_rows("k", context="c")}
    assert rows["rocketchat-mongodb-0"]["status"].startswith("CrashLoopBackOff")
    assert "3 restarts" in rows["rocketchat-mongodb-0"]["status"]
    # A SUCCESSFUL init container is not a reason: reporting "Completed" as the pod's
    # status would hide a Rocket.Chat container that was crash-looping behind it.
    assert rows["rocketchat-rocketchat-x"]["status"] == "1/1 ready"
    assert rows["rocketchat-rocketchat-x"]["health"] == "healthy"


def test_pod_rows_answers_empty_rather_than_raising_when_the_cluster_is_asleep():
    """detail() is on the path of every panel open, so this may never raise: a
    workspace whose cluster is unreachable still has to render."""
    from houston.services import k8s

    import unittest.mock as mock
    with mock.patch.object(k8s.exec, "run", return_value=type(
            "R", (), {"returncode": 1, "stdout": "", "stderr": "connection refused"})()):
        assert k8s.pod_rows("k", context="c") == []


def test_a_release_has_a_state_and_a_wedged_one_is_freed(monkeypatch):
    """`helm list -q` lists a `pending-install` release exactly as it lists a healthy
    one -- from helm's own --help: "By default, it lists all releases in any status."

    So `release_installed` said True for a release a killed `helm install` had left
    locked, `up` went on to `helm upgrade --install`, and helm refused with "another
    operation (install/upgrade/rollback) is in progress" -- whose central claim is
    false: nothing is in progress, the process that was doing it is gone. Every later
    attempt failed identically and houston offered no way out.

    The remedy depends on whether there is anything to go back TO, which is why "just
    run helm rollback" is not the whole answer: a pending-install at revision 1 never
    completed once, so a rollback has no target.
    """
    from houston.services import k8s

    # A state, not a presence.
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: _completed(
        0, out=_helm_list("rocketchat", status="pending-install", revision=1)))
    assert k8s.release_state("rocketchat", "ns", "c") == ("pending-install", 1)

    calls: list = []

    def spy(argv, **kw):
        calls.append(" ".join(argv))
        if "helm list" in " ".join(argv):
            return _completed(0, out=_helm_list("rocketchat",
                                                status="pending-install", revision=1))
        return _completed(0)

    monkeypatch.setattr(k8s.kube, "run", spy)
    said: list = []
    assert k8s.clear_pending_release("rocketchat", "ns", "c",
                                     emit=said.append) == "uninstalled"
    assert any("helm uninstall rocketchat" in c for c in calls), calls
    assert not any("helm rollback" in c for c in calls), \
        "revision 1 never completed, so there is nothing to roll back to"

    # With a good revision behind it, rolling back is the right move.
    calls.clear()

    def spy2(argv, **kw):
        calls.append(" ".join(argv))
        if "helm list" in " ".join(argv):
            return _completed(0, out=_helm_list("rocketchat",
                                                status="pending-upgrade", revision=4))
        return _completed(0)

    monkeypatch.setattr(k8s.kube, "run", spy2)
    assert "rolled back" in k8s.clear_pending_release("rocketchat", "ns", "c")
    assert any("helm rollback rocketchat 3" in c for c in calls), calls

    # A healthy release is left entirely alone.
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: _completed(
        0, out=_helm_list("rocketchat", status="deployed", revision=2)))
    assert k8s.clear_pending_release("rocketchat", "ns", "c") == ""


def test_a_release_with_no_values_of_its_own_is_not_a_failure(monkeypatch):
    """`helm get values` answers the literal string `null` for a release installed
    with no values. That is an empty values file, not an error, and reading it as one
    would refuse every upgrade of such a release."""
    from houston.services import k8s

    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: _completed(0, out="null"))
    assert k8s.release_values("rocketchat", "ns", "c") == {}

    # A refused read is still refused: not knowing the values is not the same as
    # there being none, and upgrading on {} would erase the release's whole config.
    from houston.errors import DockerError
    monkeypatch.setattr(k8s.kube, "run", lambda argv, **kw: _completed(
        1, err="Error: release: not found"))
    with pytest.raises(DockerError):
        k8s.release_values("rocketchat", "ns", "c")


def test_the_distribution_is_read_from_the_node_not_guessed_from_a_name(monkeypatch):
    """A label for messages, never a branch: `k3s --disable traefik` is a real setup, so
    what a cluster CAN do is probed and what it IS is only named. Signals are the ones
    verified against live clusters.
    """
    import subprocess as sp

    from houston.services import k8s

    def answer(text):
        return lambda argv, timeout=None, own=False: sp.CompletedProcess(argv, 0, text, "")

    monkeypatch.setattr(k8s.kube, "run", answer("k3s://docker-01 v1.36.3+k3s1 k3s docker-01"))
    assert k8s.distribution("default") == "k3s"
    monkeypatch.setattr(k8s.kube, "run", answer(
        "kind://docker/houston-local/houston-local-control-plane v1.36.1  x"))
    assert k8s.distribution("kind-houston-local") == "kind"
    monkeypatch.setattr(k8s.kube, "run", answer("aws:///eu-west-1a/i-0abc v1.31.0-eks-1234 m5"))
    assert k8s.distribution("arn:aws:eks:x") == "eks", \
        "a cloud providerID is the most reliable 'not a disposable cluster' signal"
    monkeypatch.setattr(k8s.kube, "run", answer(" v1.29.0  somenode"))
    assert k8s.distribution("x") == "unknown", "unknown is a fine answer"
    monkeypatch.setattr(k8s.kube, "run",
                        lambda argv, timeout=None, own=False: sp.CompletedProcess(argv, 1, "", "no"))
    assert k8s.distribution("x") == "unknown", "an unreachable cluster is not a failure here"


def test_a_kubeconfig_error_is_not_read_as_an_absent_namespace(monkeypatch):
    """The first cut tested `"not found" in text`, and kubectl says

        Error in configuration: context was not found for specified context: nope

    for a bad --context. That contains "not found", so a kubeconfig problem was
    classified as an absent namespace -- which is precisely the "I could not ask"
    case this function exists to separate out, reintroduced by a sloppy match.
    Measured against a live cluster with a bogus context: `delete_namespace` returned
    False, meaning "nothing there", for a cluster it had never reached.

    Only the API says `Error from server (NotFound)`.
    """
    from houston.errors import DockerError
    from houston.services import k8s

    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: _completed(
        1, err="Error in configuration: context was not found for specified "
               "context: no-such-context"))
    with pytest.raises(DockerError):
        k8s.namespace_labels("houston-x", context="no-such-context")

    # The server's own reason still reads as absence.
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: _completed(
        1, err='Error from server (NotFound): namespaces "houston-x" not found'))
    assert k8s.namespace_labels("houston-x", context="c") is None


# --- helm and kubectl are two clients ------------------------------------------

def test_helm_reachable_reports_what_helm_said(monkeypatch):
    """It returns the LINE, not a boolean. "helm cannot reach the cluster" sends a
    reader to the cluster; `x509: certificate signed by unknown authority` sends them
    to the kubeconfig, which is where the problem actually was."""
    from houston.services import k8s

    monkeypatch.setattr(k8s.tools, "which", lambda t: f"/usr/bin/{t}")
    monkeypatch.setattr(k8s.kube, "run", _fake_run({"helm list": (
        1, "")}))
    assert k8s.helm_reachable("default")           # non-empty == a problem

    monkeypatch.setattr(k8s.kube, "run", _fake_run({"helm list": (0, "")}))
    assert k8s.helm_reachable("default") == "", "a working helm says nothing"


def test_every_k8s_run_stub_accepts_what_the_real_one_takes():
    """A test double whose SIGNATURE drifts from the real function fails as a
    TypeError from inside the code under test -- and this codebase has two places
    that swallow exactly that.

    `k8s.run` grew an `env=` parameter for the helm probes. Twenty-odd stubs declared
    `(argv, timeout=None, own=False)`, so the moment `preflight` passed `env=` they
    raised TypeError out of `k8s.preflight`, `doctor`'s outer `except` swallowed it,
    and the WHOLE Kubernetes section silently vanished from a report those tests then
    asserted over. One of them -- `test_doctor_never_warns_about_ingress` -- failed
    with `assert []` and pointed nowhere near the cause. The chart-repo probe had
    been passing `env=` for longer and was never exercised here at all, because it
    carries its own bare `except`.

    So the doubles are checked against the real parameter list rather than trusted,
    the same way `ROUTE_ROLES`, `PHASES`, `doctor.CHECKS` and the job pools are.
    """
    import ast
    import inspect
    import pathlib

    from houston.services import k8s

    # Everything the real `run` accepts by keyword, minus the positional argv.
    real = {n for n, p in inspect.signature(k8s.run).parameters.items()
            if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)} - {"argv"}

    # The whole suite, not this one directory. `Path(__file__).parent` was `tests/`
    # when this lived there; co-location moved it three levels down, where the same
    # expression quietly narrowed the guard to its 24 neighbours. A guard that stops
    # looking is worse than no guard, so the tests root is found by name.
    root = next(p for p in pathlib.Path(__file__).resolve().parents if p.name == "tests")
    files = sorted(root.rglob("test_*.py"))
    assert len(files) > 100, f"only {len(files)} test files found under {root}"

    bad = []
    for path in files:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            args = node.args
            names = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
            # A stub for `run` is any nested def whose FIRST parameter is `argv`.
            if not names or names[0] != "argv":
                continue
            if args.kwarg is not None:          # **kw absorbs anything
                continue
            missing = real - set(names)
            if missing:
                # Relative to the tests root: `test_paths.py` alone is ambiguous now
                # that specs are co-located and several directories hold that name.
                bad.append(f"{path.relative_to(root)}:{node.lineno} {node.name}() is "
                           f"missing "
                           f"{sorted(missing)}")
    assert not bad, (
        "these doubles cannot be called the way k8s.run is, so they raise TypeError "
        "from inside the code under test:\n  " + "\n  ".join(bad))


def test_the_port_claim_probe_costs_nothing_on_a_box_with_no_kubectl(monkeypatch):
    """This runs on the way to starting a proxy, so it must be nearly free.

    Four probes at the 8s default is half a minute added to `edge start` — on a box
    whose kubeconfig points at an unreachable remote cluster, which is an ordinary
    laptop. A Docker-only box must not pay for a Kubernetes check at all.
    """
    from houston.services import k8s

    monkeypatch.setattr(k8s.shutil, "which", lambda name: None)
    called = []
    monkeypatch.setattr(k8s.kube, "run", lambda *a, **k: called.append(a) or (_ for _ in ()).throw(
        AssertionError("no kubectl on this box — nothing should have been run")))
    assert k8s.port_claiming_cluster() is None
    assert not called, "a Docker-only box must not shell out at all"

    # With kubectl present, every probe carries the shortened timeout it was given.
    monkeypatch.setattr(k8s.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(k8s.context, "active_context", lambda: "default")
    seen = []

    def _run(argv, **kw):
        seen.append(kw.get("timeout"))
        import subprocess
        return subprocess.CompletedProcess(argv, 1, "", "")

    monkeypatch.setattr(k8s.kube, "run", _run)
    k8s.port_claiming_cluster(timeout=3.0)
    assert seen and all(t == 3.0 for t in seen), seen
